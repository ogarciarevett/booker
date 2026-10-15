import { describe, expect, it } from "vitest";
import type { z } from "zod";
import drivingSchoolBrief from "../../../../examples/errands/driving-school.example.json" with {
  type: "json",
};
import { parseErrandBrief } from "../../../errands/brief.ts";
import { emptyOfferDraft } from "../../offer-drafts.ts";
import { applyQuoteField } from "../../quote-fields.ts";
import {
  getErrandContextRequestSchema,
  recordQuoteFieldRequestSchema,
  reportCommitOutcomeRequestSchema,
  requestCommitPermissionRequestSchema,
  type VoiceToolName,
} from "../../tools.ts";
import {
  BOOKER_TOOLS_KEY_HEADER,
  type BookerTool,
  bookerTools,
  type JsonSchemaProperty,
  toolNamesFor,
} from "./tools.ts";

const PUBLIC_BASE_URL = "https://public.booker.example";
const SECRET_ID = "secret-001";
const DYNAMIC_VARIABLES: Readonly<Record<string, string>> = {
  call_id: "call-001",
  call_token: "token-001",
};

const BACKEND_SCHEMAS: Readonly<Record<VoiceToolName, z.ZodType>> = {
  get_errand_context: getErrandContextRequestSchema,
  record_quote_field: recordQuoteFieldRequestSchema,
  request_commit_permission: requestCommitPermissionRequestSchema,
  report_commit_outcome: reportCommitOutcomeRequestSchema,
};

/** What the in-call model could plausibly fill for each tool, for the driving-school brief. */
const SAMPLE_FILLS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  get_errand_context: {},
  record_quote_text: {
    field: "location",
    value: "Northside district",
    quote: "We are in the Northside district.",
    confirmed: true,
  },
  record_quote_number: {
    field: "seatsAvailable",
    value: 2,
    quote: "We have two seats that week.",
    confirmed: true,
  },
  record_quote_flag: {
    field: "backToBackPhases",
    value: true,
    quote: "Theory and practice run back to back.",
    confirmed: true,
  },
  record_quote_amount: {
    field: "deposit",
    value: { amountCents: 15_000, currency: "EUR" },
    quote: "The deposit is 150 euros.",
    confirmed: false,
  },
  record_quote_dates: {
    field: "dates",
    value: { start: "2026-11-03", end: "2026-11-12" },
    quote: "It runs from the 3rd to the 12th.",
    confirmed: true,
  },
  record_cost_item: {
    field: "costItem:registration-fee",
    value: { amountCents: 4_000, currency: "EUR", appliesTo: "each-participant", kind: "charge" },
    quote: "Registration is 40 euros each.",
    confirmed: true,
  },
  request_commit_permission: {
    total: { amountCents: 110_000, currency: "EUR" },
    deposit: { amountCents: 15_000, currency: "EUR" },
    dates: { start: "2026-11-03", end: "2026-11-12" },
  },
  report_commit_outcome: { outcome: "accepted", quote: "Yes, you are both booked." },
};

function literalMatches(property: JsonSchemaProperty, value: unknown): boolean {
  switch (property.type) {
    case "string":
      return typeof value === "string" && (property.enum?.includes(value) ?? true);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

/**
 * Builds the JSON body ElevenLabs would send: dynamic variables from the call, everything else
 * from the model's fill, each value checked against the property's declared type, and every
 * required property present. Throws on any mismatch.
 */
function fill(property: JsonSchemaProperty, modelValue: unknown, path: string): unknown {
  if (property.dynamic_variable !== undefined) {
    const value = DYNAMIC_VARIABLES[property.dynamic_variable];
    if (value === undefined) throw new Error(`${path}: unknown dynamic variable`);
    return value;
  }
  if (property.type === "object") {
    if (typeof modelValue !== "object" || modelValue === null) {
      throw new Error(`${path}: expected an object`);
    }
    const body: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(property.properties)) {
      const childValue = (modelValue as Record<string, unknown>)[name];
      if (childValue === undefined && child.dynamic_variable === undefined) {
        if (property.required.includes(name)) throw new Error(`${path}.${name}: required`);
        continue;
      }
      body[name] = fill(child, childValue, `${path}.${name}`);
    }
    for (const name of Object.keys(modelValue)) {
      if (!(name in property.properties)) throw new Error(`${path}.${name}: not in the schema`);
    }
    return body;
  }
  if (!literalMatches(property, modelValue)) throw new Error(`${path}: wrong type`);
  return modelValue;
}

function collectProperties(property: JsonSchemaProperty): JsonSchemaProperty[] {
  return property.type === "object"
    ? [property, ...Object.values(property.properties).flatMap(collectProperties)]
    : [property];
}

describe("bookerTools", () => {
  const tools = bookerTools({ publicBaseUrl: PUBLIC_BASE_URL, toolsKeySecretId: SECRET_ID });

  it("defines one ElevenLabs webhook tool per sample, with unique valid names", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(SAMPLE_FILLS).sort());
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(tool.toolConfig.name).toBe(tool.name);
      expect(tool.toolConfig.type).toBe("webhook");
      expect(tool.toolConfig.description.length).toBeGreaterThan(20);
    }
  });

  it("points every tool at its backend route on the public URL, keyed by the workspace secret", () => {
    for (const tool of tools) {
      const api = tool.toolConfig.api_schema;
      expect(api.url).toBe(`${PUBLIC_BASE_URL}/voice-tools/{call_id}/${tool.route}`);
      expect(api.method).toBe("POST");
      expect(api.content_type).toBe("application/json");
      expect(api.request_headers).toEqual({ [BOOKER_TOOLS_KEY_HEADER]: { secret_id: SECRET_ID } });
      expect(api.path_params_schema).toEqual({
        call_id: { type: "string", dynamic_variable: "call_id" },
      });
    }
  });

  it("never uses anyOf or oneOf, and describes every value the model fills", () => {
    for (const tool of tools) {
      const json = JSON.stringify(tool.toolConfig);
      expect(json).not.toMatch(/anyOf|oneOf/);
      for (const property of collectProperties(tool.toolConfig.api_schema.request_body_schema)) {
        if (property.dynamic_variable === undefined) {
          expect(property.description?.length ?? 0).toBeGreaterThan(0);
        }
      }
    }
  });

  it.each(Object.keys(SAMPLE_FILLS))("sends a body the backend accepts for %s", (name) => {
    const tool = tools.find((candidate) => candidate.name === name) as BookerTool;
    const body = fill(tool.toolConfig.api_schema.request_body_schema, SAMPLE_FILLS[name], name);

    const parsed = BACKEND_SCHEMAS[tool.backendTool].safeParse(body);

    expect(parsed.success).toBe(true);
    expect(body).toMatchObject({ call_token: "token-001" });
  });

  it.each(Object.keys(SAMPLE_FILLS).filter((name) => name.startsWith("record_")))(
    "records a value the driving-school brief accepts for %s",
    (name) => {
      const parsedBrief = parseErrandBrief(drivingSchoolBrief);
      if (!parsedBrief.ok) throw new Error("invalid example brief");
      const tool = tools.find((candidate) => candidate.name === name) as BookerTool;
      const body = recordQuoteFieldRequestSchema.parse(
        fill(tool.toolConfig.api_schema.request_body_schema, SAMPLE_FILLS[name], name),
      );
      const now = "2026-10-06T10:00:00.000Z";

      const applied = applyQuoteField(
        emptyOfferDraft(parsedBrief.brief.id, "provider-northside", now),
        parsedBrief.brief,
        body,
        now,
        "call-001",
      );

      expect(applied.ok).toBe(true);
    },
  );

  it("gives a quote call only the context and recording tools", () => {
    expect(toolNamesFor("quote")).toEqual([
      "get_errand_context",
      "record_quote_text",
      "record_quote_number",
      "record_quote_flag",
      "record_quote_amount",
      "record_quote_dates",
      "record_cost_item",
    ]);
    expect(toolNamesFor("commit")).toEqual([
      ...toolNamesFor("quote"),
      "request_commit_permission",
      "report_commit_outcome",
    ]);
  });

  it("refuses a public URL that is not https", () => {
    expect(() =>
      bookerTools({ publicBaseUrl: "http://public.booker.example", toolsKeySecretId: SECRET_ID }),
    ).toThrow(RangeError);
  });
});
