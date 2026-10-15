import type { CallPurpose } from "../../call.ts";
import { toolsFor, type VoiceToolName } from "../../tools.ts";

/** The header every voice-tool request carries; ElevenLabs fills it from a workspace secret. */
export const BOOKER_TOOLS_KEY_HEADER = "X-Booker-Tools-Key";
/** The workspace secret that holds the voice-tools key (`pnpm booker agent sync` pushes it). */
export const BOOKER_TOOLS_SECRET_NAME = "booker_tools_key";

/**
 * The subset of ElevenLabs' JSON schema for webhook tool parameters that Booker uses. ElevenLabs
 * accepts literal types (with an `enum` on strings), objects, and arrays, but no `anyOf` or
 * `oneOf`: that is why one backend tool with a union `value` becomes several ElevenLabs tools.
 * A property is filled either by the model (it needs a `description`) or from a dynamic variable
 * of the call (`call_id`, `call_token`), which the model never sees or invents.
 */
export type JsonSchemaProperty =
  | {
      readonly type: "string" | "integer" | "number" | "boolean";
      readonly description?: string;
      readonly enum?: readonly string[];
      readonly dynamic_variable?: string;
    }
  | {
      readonly type: "object";
      readonly description?: string;
      readonly dynamic_variable?: undefined;
      readonly required: readonly string[];
      readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
    };

export type ObjectSchema = Extract<JsonSchemaProperty, { type: "object" }>;

/** A webhook tool's `tool_config`, as `POST /v1/convai/tools` and `PATCH` take it. */
export interface WebhookToolConfig {
  readonly type: "webhook";
  readonly name: string;
  readonly description: string;
  readonly response_timeout_secs: number;
  readonly execution_mode: "immediate";
  readonly tool_error_handling_mode: "passthrough";
  readonly api_schema: {
    readonly url: string;
    readonly method: "POST";
    readonly content_type: "application/json";
    readonly request_headers: Readonly<Record<string, { readonly secret_id: string }>>;
    readonly path_params_schema: Readonly<Record<string, JsonSchemaProperty>>;
    readonly request_body_schema: ObjectSchema;
  };
}

/** One ElevenLabs tool, the backend tool it calls, and that tool's route. */
export interface BookerTool {
  readonly name: string;
  readonly backendTool: VoiceToolName;
  readonly route: string;
  readonly toolConfig: WebhookToolConfig;
}

export interface BookerToolsOptions {
  /** The public HTTPS base URL (the Tailscale Funnel), without a trailing slash. */
  readonly publicBaseUrl: string;
  /** The workspace secret holding the voice-tools key. */
  readonly toolsKeySecretId: string;
}

const RESPONSE_TIMEOUT_SECONDS = 20;

const ROUTES: Readonly<Record<VoiceToolName, string>> = {
  get_errand_context: "get-errand-context",
  record_quote_field: "record-quote-field",
  request_commit_permission: "request-commit-permission",
  report_commit_outcome: "report-commit-outcome",
};

function text(description: string): JsonSchemaProperty {
  return { type: "string", description };
}

function object(
  description: string,
  properties: Readonly<Record<string, JsonSchemaProperty>>,
  required: readonly string[] = Object.keys(properties),
): ObjectSchema {
  return { type: "object", description, required, properties };
}

const MONEY_PROPERTIES = {
  amountCents: {
    type: "integer",
    description: "The amount in cents, as a whole number: 150 euros is 15000.",
  },
  currency: text("The ISO 4217 currency code, for example EUR."),
} as const satisfies Record<string, JsonSchemaProperty>;

function money(description: string): ObjectSchema {
  return object(description, MONEY_PROPERTIES);
}

function dateRange(description: string): ObjectSchema {
  return object(description, {
    start: text("The first day, as YYYY-MM-DD."),
    end: text("The last day, as YYYY-MM-DD, on or after the first day."),
  });
}

const QUOTE = text(
  "The provider's own words that state this value, quoted exactly, under 500 characters.",
);
const CONFIRMED: JsonSchemaProperty = {
  type: "boolean",
  description:
    "true only when the provider stated the value firmly; false for an estimate, a range, or 'about'.",
};

/** A `record_quote_field` variant whose `value` has one fixed shape. */
function recordTool(
  name: string,
  description: string,
  field: JsonSchemaProperty,
  value: JsonSchemaProperty,
): Omit<BookerTool, "toolConfig"> & { readonly description: string; readonly body: ObjectSchema } {
  return {
    name,
    backendTool: "record_quote_field",
    route: ROUTES.record_quote_field,
    description,
    body: object("What the provider said about one field of the quote.", {
      field,
      value,
      quote: QUOTE,
      confirmed: CONFIRMED,
    }),
  };
}

const DEFINITIONS: readonly (Omit<BookerTool, "toolConfig"> & {
  readonly description: string;
  readonly body: ObjectSchema;
})[] = [
  {
    name: "get_errand_context",
    backendTool: "get_errand_context",
    route: ROUTES.get_errand_context,
    description:
      "Gets what this call is about: the objective, the provider's name, the dates, the questions to ask, and the participants. Call it once, before asking anything.",
    body: object("No arguments.", {}),
  },
  recordTool(
    "record_quote_text",
    "Records an answer that is text: the location, or a text requirement from the errand context.",
    text("Which field: 'location', or the name of a text requirement from the errand context."),
    text("The answer as text, for example 'Northside district' or 'B'."),
  ),
  recordTool(
    "record_quote_number",
    "Records an answer that is a number: how many seats are available, or a numeric requirement from the errand context.",
    text(
      "Which field: 'seatsAvailable', or the name of a numeric requirement from the errand context.",
    ),
    { type: "number", description: "The number, for example 2." },
  ),
  recordTool(
    "record_quote_flag",
    "Records a yes-or-no answer to a requirement from the errand context.",
    text("The name of a yes-or-no requirement from the errand context."),
    { type: "boolean", description: "true for yes, false for no." },
  ),
  recordTool(
    "record_quote_amount",
    "Records a single amount of money: the deposit, or the cancellation penalty.",
    {
      type: "string",
      enum: ["deposit", "cancellationPenalty"],
      description: "Which amount: 'deposit' or 'cancellationPenalty'.",
    },
    money("The amount of money."),
  ),
  recordTool(
    "record_quote_dates",
    "Records the dates the provider offers.",
    { type: "string", enum: ["dates"], description: "Always 'dates'." },
    dateRange("The first and last day the provider offers."),
  ),
  recordTool(
    "record_cost_item",
    "Records one price or discount the provider mentions, such as tuition, a registration fee, or a group discount. Record each item separately.",
    text(
      "'costItem:' followed by a short id in lowercase letters and dashes, for example 'costItem:registration-fee'. Use the same id again to correct an item.",
    ),
    object("The item's amount, whom it applies to, and whether it is a charge or a discount.", {
      ...MONEY_PROPERTIES,
      appliesTo: {
        type: "string",
        enum: ["each-participant", "group"],
        description:
          "'each-participant' when every participant pays it, 'group' when it is paid once for the whole group.",
      },
      kind: {
        type: "string",
        enum: ["charge", "discount"],
        description: "'charge' for a price or fee, 'discount' for money taken off.",
      },
    }),
  ),
  {
    name: "request_commit_permission",
    backendTool: "request_commit_permission",
    route: ROUTES.request_commit_permission,
    description:
      "Asks whether the booking may be confirmed now, exactly as quoted. Call it before agreeing to anything, and follow its instruction.",
    body: object("The terms exactly as quoted.", {
      total: money("The total price for everyone."),
      deposit: money("The deposit due now; zero when there is none."),
      dates: dateRange("The booked dates."),
    }),
  },
  {
    name: "report_commit_outcome",
    backendTool: "report_commit_outcome",
    route: ROUTES.report_commit_outcome,
    description:
      "Reports how the provider answered the confirmation: accepted, rejected, or unclear.",
    body: object("The provider's answer.", {
      outcome: {
        type: "string",
        enum: ["accepted", "rejected", "unclear"],
        description: "accepted, rejected, or unclear when you are not sure.",
      },
      quote: QUOTE,
    }),
  },
];

/**
 * Booker's voice tools as ElevenLabs webhook tools. The backend's `record_quote_field` takes a
 * union `value`, which ElevenLabs cannot express, so it is offered as one tool per value shape;
 * they all post to the same route. The route itself is unchanged, and the backend still validates
 * every field and value. `call_id` (in the path) and `call_token` (in the body) come from the
 * call's dynamic variables, and the voice-tools key from the workspace secret.
 */
export function bookerTools(options: BookerToolsOptions): readonly BookerTool[] {
  const base = new URL(options.publicBaseUrl);
  if (base.protocol !== "https:") {
    throw new RangeError("bookerTools publicBaseUrl must be an https URL");
  }
  const baseUrl = options.publicBaseUrl.replace(/\/+$/, "");
  return DEFINITIONS.map(({ description, body, ...tool }) => ({
    ...tool,
    toolConfig: {
      type: "webhook",
      name: tool.name,
      description,
      response_timeout_secs: RESPONSE_TIMEOUT_SECONDS,
      execution_mode: "immediate",
      tool_error_handling_mode: "passthrough",
      api_schema: {
        url: `${baseUrl}/voice-tools/{call_id}/${tool.route}`,
        method: "POST",
        content_type: "application/json",
        request_headers: { [BOOKER_TOOLS_KEY_HEADER]: { secret_id: options.toolsKeySecretId } },
        path_params_schema: { call_id: { type: "string", dynamic_variable: "call_id" } },
        request_body_schema: {
          ...body,
          required: ["call_token", ...body.required],
          properties: {
            call_token: { type: "string", dynamic_variable: "call_token" },
            ...body.properties,
          },
        },
      },
    },
  }));
}

/** The ElevenLabs tools an agent for this call purpose gets, in a fixed order. */
export function toolNamesFor(purpose: CallPurpose): readonly string[] {
  const backendTools = new Set(toolsFor(purpose));
  return DEFINITIONS.filter((tool) => backendTools.has(tool.backendTool)).map((tool) => tool.name);
}
