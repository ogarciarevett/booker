import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import type { ChoiceQuestion } from "../decision.ts";
import { JevDecisionAdapter, JevError } from "./jev.ts";

type Vote = "yes" | "no" | "maybe";

function question(): ChoiceQuestion<Vote> {
  return {
    key: "shouldProceed",
    instructions: "Should the errand proceed with this offer?",
    criteria: {
      yes: "The offer clears every standing rule",
      no: "The offer fails a hard constraint",
      maybe: "More information is needed",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validBody() {
  return {
    model: "jev-2026-09-01",
    answers: {
      shouldProceed: {
        type: "choice",
        choice: "yes",
        confidence: 0.93,
        probabilities: { yes: 0.93, no: 0.05, maybe: 0.02 },
      },
    },
    usage: { input_tokens: 42, output_tokens: 7 },
  };
}

describe("JevDecisionAdapter", () => {
  it("rejects an empty apiKey", () => {
    expect(() => new JevDecisionAdapter({ apiKey: "" })).toThrow(RangeError);
  });

  it("sends the exact request body and headers, and maps a happy-path response", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(validBody()),
    );
    const adapter = new JevDecisionAdapter({ apiKey: "secret-key", fetch });

    const decision = await adapter.choose({
      state: "the offer meets budget",
      question: question(),
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "Bearer secret-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      state: "the offer meets budget",
      model: "jev-latest",
      questions: {
        shouldProceed: {
          type: "choice",
          instructions: question().instructions,
          criteria: question().criteria,
        },
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    expect(decision).toEqual({
      choice: "yes",
      confidence: 0.93,
      probabilities: { yes: 0.93, no: 0.05, maybe: 0.02 },
      modelVersion: "jev-2026-09-01",
      source: "jev",
    });
  });

  it("uses a custom model and baseUrl when given", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(validBody()),
    );
    const adapter = new JevDecisionAdapter({
      apiKey: "secret-key",
      model: "jev-2026-10",
      baseUrl: "https://jev.internal.test",
      fetch,
    });

    await adapter.choose({ state: "state", question: question() });

    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(url).toBe("https://jev.internal.test/v1/systemone");
    expect(JSON.parse(init?.body as string).model).toBe("jev-2026-10");
  });

  it('throws a JevError("http") for a non-2xx status, without leaking the API key', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "nope" }, 500));
    const adapter = new JevDecisionAdapter({ apiKey: "top-secret", fetch });

    const failure = adapter.choose({ state: "state", question: question() });
    await expect(failure).rejects.toThrow(JevError);
    await expect(failure).rejects.toMatchObject({ kind: "http" });
    await expect(failure).rejects.not.toThrow(/top-secret/);
  });

  it('throws a JevError("timeout") when the request times out', async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const adapter = new JevDecisionAdapter({ apiKey: "secret-key", fetch, timeoutMs: 5 });

    const failure = adapter.choose({ state: "state", question: question() });
    await expect(failure).rejects.toThrow(JevError);
    await expect(failure).rejects.toMatchObject({ kind: "timeout" });
  });

  it('throws a JevError("invalid_response") when the body does not match the expected shape', async () => {
    const fetch = vi.fn(async () => jsonResponse({ model: "jev-2026-09-01", answers: {} }));
    const adapter = new JevDecisionAdapter({ apiKey: "secret-key", fetch });

    const failure = adapter.choose({ state: "state", question: question() });
    await expect(failure).rejects.toThrow(JevError);
    await expect(failure).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it('throws a JevError("unknown_choice") when the choice is not one of the offered criteria', async () => {
    const body = validBody();
    body.answers.shouldProceed.choice = "definitely";
    const fetch = vi.fn(async () => jsonResponse(body));
    const adapter = new JevDecisionAdapter({ apiKey: "secret-key", fetch });

    const failure = adapter.choose({ state: "state", question: question() });
    await expect(failure).rejects.toThrow(JevError);
    await expect(failure).rejects.toMatchObject({ kind: "unknown_choice" });
  });
});

describe("JevDecisionAdapter boundary validation", () => {
  const adapterReturning = (body: unknown) =>
    new JevDecisionAdapter({
      apiKey: "test-key",
      fetch: async () => jsonResponse(body),
    });

  const kindOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
    promise.then(
      () => undefined,
      (error: unknown) => (error instanceof JevError ? error.kind : "not-a-jev-error"),
    );

  it.each([
    ["a confidence above 1", { confidence: 1.2 }],
    ["a negative confidence", { confidence: -0.1 }],
    ["a non-choice answer type", { type: "score" }],
    [
      "a probability for an option that was not offered",
      { probabilities: { yes: 0.9, later: 0.1 } },
    ],
  ])("rejects %s as invalid_response", async (_label, override) => {
    const body = validBody();
    const answer = { ...body.answers.shouldProceed, ...override };
    const input = { state: "offer summary", question: question() };
    const adapter = adapterReturning({ ...body, answers: { shouldProceed: answer } });
    expect(await kindOf(adapter.choose(input))).toBe("invalid_response");
  });

  it("rejects a response without an answer for the asked question", async () => {
    const body = {
      model: "jev-2026-09-01",
      answers: {},
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const input = { state: "offer summary", question: question() };
    expect(await kindOf(adapterReturning(body).choose(input))).toBe("invalid_response");
  });

  it("rejects a body that is not JSON", async () => {
    const adapter = new JevDecisionAdapter({
      apiKey: "test-key",
      fetch: async () => new Response("not json", { status: 200 }),
    });
    const input = { state: "offer summary", question: question() };
    expect(await kindOf(adapter.choose(input))).toBe("invalid_response");
  });

  it("maps a network failure to http without leaking the key", async () => {
    const adapter = new JevDecisionAdapter({
      apiKey: "secret-key-value",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const input = { state: "offer summary", question: question() };
    const error = await adapter.choose(input).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).kind).toBe("http");
    expect((error as JevError).message).not.toContain("secret-key-value");
  });

  it("accepts a valid answer when usage is missing", async () => {
    const { usage: _usage, ...body } = validBody();
    const input = { state: "offer summary", question: question() };
    const decision = await adapterReturning(body).choose(input);
    expect(decision.choice).toBe("yes");
  });
});

describe("JevDecisionAdapter error precedence", () => {
  it("reports an unoffered choice as unknown_choice even when its probability is listed", async () => {
    const body = validBody();
    const answer = {
      ...body.answers.shouldProceed,
      choice: "later",
      probabilities: { yes: 0.05, later: 0.95 },
    };
    const adapter = new JevDecisionAdapter({
      apiKey: "test-key",
      fetch: async () => jsonResponse({ ...body, answers: { shouldProceed: answer } }),
    });
    const kind = await adapter.choose({ state: "offer summary", question: question() }).then(
      () => undefined,
      (error: unknown) => (error instanceof JevError ? error.kind : "not-a-jev-error"),
    );
    expect(kind).toBe("unknown_choice");
  });
});

describe("JevDecisionAdapter tracing", () => {
  function tracedAdapter(fetch: typeof globalThis.fetch) {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const adapter = new JevDecisionAdapter({
      apiKey: "jev-api-key-for-tracing",
      fetch,
      tracer: provider.getTracer("test"),
    });
    return { adapter, exporter };
  }

  it("records the question, choice, confidence, model, and tokens, never the state or the key", async () => {
    const { adapter, exporter } = tracedAdapter(async () => jsonResponse(validBody()));

    await adapter.choose({
      state: "Example Owner 2 at 100 Fictional Example Street",
      question: question(),
    });

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("jev decision");
    expect(span?.attributes).toEqual({
      "openinference.span.kind": "LLM",
      "llm.model_name": "jev-2026-09-01",
      "llm.token_count.prompt": 42,
      "llm.token_count.completion": 7,
      "jev.question": "shouldProceed",
      "jev.choice": "yes",
      "jev.confidence": 0.93,
    });
  });

  it("marks a failed decision with its kind only, never the key or the error message", async () => {
    const { adapter, exporter } = tracedAdapter(async () => jsonResponse({}, 500));

    await expect(
      adapter.choose({ state: "offer summary", question: question() }),
    ).rejects.toBeInstanceOf(JevError);

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes).toEqual({
      "openinference.span.kind": "LLM",
      "jev.question": "shouldProceed",
      "jev.error_kind": "http",
      "error.type": "JevError",
    });
    expect(JSON.stringify([span?.attributes, span?.events, span?.status])).not.toContain(
      "jev-api-key-for-tracing",
    );
  });
});
