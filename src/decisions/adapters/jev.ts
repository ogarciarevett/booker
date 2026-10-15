import type { Tracer } from "@opentelemetry/api";
import { z } from "zod";
import {
  bookerTracer,
  inSpan,
  LLM_COMPLETION_TOKENS,
  LLM_MODEL_NAME,
  LLM_PROMPT_TOKENS,
  SPAN_KIND,
} from "../../observability/spans.ts";
import type { ChoiceQuestion, ChooseInput, Decision, DecisionPort } from "../decision.ts";

const DEFAULT_MODEL = "jev-latest";
const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 10_000;

export type JevErrorKind = "http" | "timeout" | "invalid_response" | "unknown_choice";

/** Thrown by `JevDecisionAdapter` for any request that did not yield a usable decision. */
export class JevError extends Error {
  readonly kind: JevErrorKind;

  constructor(kind: JevErrorKind, message: string) {
    super(message);
    this.name = "JevError";
    this.kind = kind;
  }
}

const unitInterval = z.number().min(0).max(1);

const jevAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string().min(1),
  confidence: unitInterval,
  probabilities: z.record(z.string(), unitInterval),
});

// `usage` is informational; a usable answer is accepted without it.
const jevResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export interface JevDecisionAdapterOptions {
  /** Never logged and never included in an error message. */
  readonly apiKey: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Records each decision as a span; Booker's tracer (a no-op while tracing is off) by default. */
  readonly tracer?: Tracer;
}

type JevUsage = z.infer<typeof jevResponseSchema>["usage"];

function requestBody<Option extends string>(
  state: string,
  model: string,
  question: ChoiceQuestion<Option>,
) {
  return {
    state,
    model,
    questions: {
      [question.key]: {
        type: "choice" as const,
        instructions: question.instructions,
        criteria: question.criteria,
      },
    },
  };
}

/**
 * `DecisionPort` adapter over the Jev (TypeSafe) `/v1/systemone` endpoint.
 * Every failure — a non-2xx status, a timeout, a response that does not
 * match the expected shape, or a returned choice outside the offered
 * criteria — throws a `JevError` naming which one, never the API key.
 */
export class JevDecisionAdapter implements DecisionPort {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly tracer: Tracer;

  constructor(options: JevDecisionAdapterOptions) {
    if (options.apiKey.length === 0) {
      throw new RangeError("JevDecisionAdapter apiKey must not be empty");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tracer = options.tracer ?? bookerTracer();
  }

  /**
   * One span per decision: the question's key, the choice, its confidence, the model that
   * answered, and the token counts; on failure, the `JevError` kind. Never the state, the
   * instructions, the criteria text, or the API key.
   */
  async choose<Option extends string>(input: ChooseInput<Option>): Promise<Decision<Option>> {
    const attributes = { [SPAN_KIND]: "LLM", "jev.question": input.question.key };
    return await inSpan(
      "jev decision",
      attributes,
      async (span) => {
        try {
          const { decision, usage } = await this.decide(input);
          span.setAttributes({
            [LLM_MODEL_NAME]: decision.modelVersion ?? this.model,
            ...(usage === undefined
              ? {}
              : {
                  [LLM_PROMPT_TOKENS]: usage.input_tokens,
                  [LLM_COMPLETION_TOKENS]: usage.output_tokens,
                }),
            "jev.choice": decision.choice,
            "jev.confidence": decision.confidence,
          });
          return decision;
        } catch (error) {
          if (error instanceof JevError) span.setAttribute("jev.error_kind", error.kind);
          throw error;
        }
      },
      this.tracer,
    );
  }

  private async decide<Option extends string>(
    input: ChooseInput<Option>,
  ): Promise<{ readonly decision: Decision<Option>; readonly usage: JevUsage }> {
    const { state, question } = input;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody(state, this.model, question)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // `AbortSignal.timeout` aborts with a `TimeoutError`; any other thrown
      // error means the request never reached a response either way.
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new JevError("timeout", `Jev request timed out after ${this.timeoutMs}ms`);
      }
      throw new JevError(
        "http",
        `Jev request failed before receiving a response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new JevError("http", `Jev API responded with status ${response.status}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new JevError(
        "invalid_response",
        `Jev response body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const parsed = jevResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new JevError(
        "invalid_response",
        `Jev response did not match the expected shape: ${parsed.error.message}`,
      );
    }

    const answer = parsed.data.answers[question.key];
    if (answer === undefined) {
      throw new JevError(
        "invalid_response",
        `Jev response is missing an answer for question "${question.key}"`,
      );
    }

    // An unoffered choice is the more specific fault, so it is reported first.
    if (!Object.hasOwn(question.criteria, answer.choice)) {
      throw new JevError(
        "unknown_choice",
        `Jev returned choice "${answer.choice}", which is not one of the offered criteria for "${question.key}"`,
      );
    }

    const unofferedOption = Object.keys(answer.probabilities).find(
      (option) => !Object.hasOwn(question.criteria, option),
    );
    if (unofferedOption !== undefined) {
      throw new JevError(
        "invalid_response",
        `Jev returned a probability for "${unofferedOption}", which was not offered for "${question.key}"`,
      );
    }

    const decision: Decision<Option> = {
      choice: answer.choice as Option,
      confidence: answer.confidence,
      probabilities: answer.probabilities as Partial<Record<Option, number>>,
      modelVersion: parsed.data.model,
      source: "jev",
    };
    return { decision, usage: parsed.data.usage };
  }
}
