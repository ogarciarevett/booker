import { describe, expect, it } from "vitest";
import {
  getErrandContextRequestSchema,
  isToolAllowed,
  recordQuoteFieldRequestSchema,
  reportCommitOutcomeRequestSchema,
  requestCommitPermissionRequestSchema,
  toolsFor,
} from "./tools.ts";

describe("toolsFor", () => {
  it("exposes only the read-only tools to a quote call", () => {
    expect(toolsFor("quote")).toEqual(["get_errand_context", "record_quote_field"]);
  });

  it("exposes every tool to a commit call", () => {
    expect(toolsFor("commit")).toEqual([
      "get_errand_context",
      "record_quote_field",
      "request_commit_permission",
      "report_commit_outcome",
    ]);
  });
});

describe("isToolAllowed", () => {
  it("allows record_quote_field on a quote call", () => {
    expect(isToolAllowed("quote", "record_quote_field")).toBe(true);
  });

  it("rejects request_commit_permission on a quote call", () => {
    expect(isToolAllowed("quote", "request_commit_permission")).toBe(false);
  });

  it("rejects report_commit_outcome on a quote call", () => {
    expect(isToolAllowed("quote", "report_commit_outcome")).toBe(false);
  });

  it("allows every tool on a commit call", () => {
    expect(isToolAllowed("commit", "request_commit_permission")).toBe(true);
    expect(isToolAllowed("commit", "report_commit_outcome")).toBe(true);
    expect(isToolAllowed("commit", "get_errand_context")).toBe(true);
    expect(isToolAllowed("commit", "record_quote_field")).toBe(true);
  });
});

describe("getErrandContextRequestSchema", () => {
  it("accepts a non-empty call_token", () => {
    expect(getErrandContextRequestSchema.safeParse({ call_token: "tok" }).success).toBe(true);
  });

  it("rejects an empty call_token", () => {
    expect(getErrandContextRequestSchema.safeParse({ call_token: "" }).success).toBe(false);
  });

  it("rejects a missing call_token", () => {
    expect(getErrandContextRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("recordQuoteFieldRequestSchema", () => {
  function base(overrides: Record<string, unknown> = {}) {
    return {
      call_token: "tok",
      field: "seatsAvailable",
      value: 4,
      quote: "We have four seats left.",
      confirmed: true,
      ...overrides,
    };
  }

  it("accepts a numeric value", () => {
    expect(recordQuoteFieldRequestSchema.safeParse(base()).success).toBe(true);
  });

  it("accepts a string value", () => {
    expect(
      recordQuoteFieldRequestSchema.safeParse(base({ field: "location", value: "Northside" }))
        .success,
    ).toBe(true);
  });

  it("accepts a boolean value", () => {
    expect(
      recordQuoteFieldRequestSchema.safeParse(base({ field: "hasParking", value: true })).success,
    ).toBe(true);
  });

  it("accepts a Money value", () => {
    expect(
      recordQuoteFieldRequestSchema.safeParse(
        base({ field: "deposit", value: { amountCents: 10_000, currency: "EUR" } }),
      ).success,
    ).toBe(true);
  });

  it("accepts a DateRange value", () => {
    expect(
      recordQuoteFieldRequestSchema.safeParse(
        base({ field: "dates", value: { start: "2026-11-03", end: "2026-11-12" } }),
      ).success,
    ).toBe(true);
  });

  it("accepts a full cost-item value (amount, currency, appliesTo, kind)", () => {
    expect(
      recordQuoteFieldRequestSchema.safeParse(
        base({
          field: "costItem:tuition",
          value: {
            amountCents: 60_000,
            currency: "EUR",
            appliesTo: "each-participant",
            kind: "charge",
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a cost-item value with a participantIds appliesTo", () => {
    expect(
      recordQuoteFieldRequestSchema.safeParse(
        base({
          field: "costItem:single-room",
          value: {
            amountCents: 2_000,
            currency: "EUR",
            appliesTo: { participantIds: ["participant-a"] },
            kind: "charge",
          },
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a cost-item value with appliesTo and kind omitted (amount-only update)", () => {
    expect(
      recordQuoteFieldRequestSchema.safeParse(
        base({ field: "costItem:tuition", value: { amountCents: 60_000, currency: "EUR" } }),
      ).success,
    ).toBe(true);
  });

  it("rejects a cost-item value with an empty participantIds list", () => {
    expect(
      recordQuoteFieldRequestSchema.safeParse(
        base({
          field: "costItem:single-room",
          value: {
            amountCents: 2_000,
            currency: "EUR",
            appliesTo: { participantIds: [] },
            kind: "charge",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects a cost-item value with an unrecognized kind", () => {
    expect(
      recordQuoteFieldRequestSchema.safeParse(
        base({
          field: "costItem:tuition",
          value: { amountCents: 60_000, currency: "EUR", appliesTo: "group", kind: "refund" },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects an empty quote", () => {
    expect(recordQuoteFieldRequestSchema.safeParse(base({ quote: "" })).success).toBe(false);
  });

  it("rejects a quote longer than 500 characters", () => {
    expect(recordQuoteFieldRequestSchema.safeParse(base({ quote: "a".repeat(501) })).success).toBe(
      false,
    );
  });

  it("accepts a quote of exactly 500 characters", () => {
    expect(recordQuoteFieldRequestSchema.safeParse(base({ quote: "a".repeat(500) })).success).toBe(
      true,
    );
  });

  it("rejects a missing confirmed flag", () => {
    const { confirmed, ...rest } = base();
    expect(recordQuoteFieldRequestSchema.safeParse(rest).success).toBe(false);
  });
});

describe("requestCommitPermissionRequestSchema", () => {
  it("accepts a full commit permission request", () => {
    expect(
      requestCommitPermissionRequestSchema.safeParse({
        call_token: "tok",
        total: { amountCents: 60_000, currency: "EUR" },
        deposit: { amountCents: 10_000, currency: "EUR" },
        dates: { start: "2026-11-03", end: "2026-11-12" },
      }).success,
    ).toBe(true);
  });

  it("rejects a missing total", () => {
    expect(
      requestCommitPermissionRequestSchema.safeParse({
        call_token: "tok",
        deposit: { amountCents: 10_000, currency: "EUR" },
        dates: { start: "2026-11-03", end: "2026-11-12" },
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid date range (end before start)", () => {
    expect(
      requestCommitPermissionRequestSchema.safeParse({
        call_token: "tok",
        total: { amountCents: 60_000, currency: "EUR" },
        deposit: { amountCents: 10_000, currency: "EUR" },
        dates: { start: "2026-11-12", end: "2026-11-03" },
      }).success,
    ).toBe(false);
  });
});

describe("reportCommitOutcomeRequestSchema", () => {
  it.each(["accepted", "rejected", "unclear"] as const)("accepts outcome %s", (outcome) => {
    expect(
      reportCommitOutcomeRequestSchema.safeParse({
        call_token: "tok",
        outcome,
        quote: "The provider confirmed the booking.",
      }).success,
    ).toBe(true);
  });

  it("rejects an unrecognized outcome", () => {
    expect(
      reportCommitOutcomeRequestSchema.safeParse({
        call_token: "tok",
        outcome: "maybe",
        quote: "unclear",
      }).success,
    ).toBe(false);
  });

  it("rejects a missing quote", () => {
    expect(
      reportCommitOutcomeRequestSchema.safeParse({ call_token: "tok", outcome: "accepted" })
        .success,
    ).toBe(false);
  });
});

describe("reportCommitOutcomeRequestSchema quote bound", () => {
  it("rejects a quote longer than 500 characters, like record_quote_field", () => {
    const token = ["call", "token", "for", "tests"].join("-");
    const result = reportCommitOutcomeRequestSchema.safeParse({
      call_token: token,
      outcome: "accepted",
      quote: "a".repeat(501),
    });
    expect(result.success).toBe(false);
  });
});
