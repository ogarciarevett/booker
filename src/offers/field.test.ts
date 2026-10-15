import { describe, expect, it } from "vitest";
import { moneySchema } from "../shared/money.ts";
import { estimated, evidenceSchema, fieldSchema, isConfirmed, known, unknown } from "./field.ts";

function evidence() {
  return {
    source: "call" as const,
    reference: "call-2026-09-29-10:00",
    quote: "We have 12 seats left for that week.",
    capturedAt: "2026-09-29T10:00:00.000Z",
  };
}

describe("evidenceSchema", () => {
  it("accepts a fully formed evidence record", () => {
    expect(evidenceSchema.safeParse(evidence()).success).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(evidenceSchema.safeParse({ ...evidence(), source: "carrier-pigeon" }).success).toBe(
      false,
    );
  });

  it("rejects a capturedAt that is not an ISO datetime", () => {
    expect(evidenceSchema.safeParse({ ...evidence(), capturedAt: "2026-09-29" }).success).toBe(
      false,
    );
  });

  it("rejects an empty quote", () => {
    expect(evidenceSchema.safeParse({ ...evidence(), quote: "" }).success).toBe(false);
  });
});

describe("fieldSchema", () => {
  const amountFieldSchema = fieldSchema(moneySchema);

  it("accepts a known value with evidence", () => {
    const result = amountFieldSchema.safeParse({
      status: "known",
      value: { amountCents: 5_000, currency: "EUR" },
      evidence: evidence(),
    });
    expect(result.success).toBe(true);
  });

  it("accepts an estimated value with evidence", () => {
    const result = amountFieldSchema.safeParse({
      status: "estimated",
      value: { amountCents: 5_000, currency: "EUR" },
      evidence: evidence(),
    });
    expect(result.success).toBe(true);
  });

  it("accepts an unknown status with no value or evidence", () => {
    const result = amountFieldSchema.safeParse({ status: "unknown" });
    expect(result.success).toBe(true);
  });

  it("rejects a known status missing evidence", () => {
    const result = amountFieldSchema.safeParse({
      status: "known",
      value: { amountCents: 5_000, currency: "EUR" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a value that fails the inner schema", () => {
    const result = amountFieldSchema.safeParse({
      status: "known",
      value: { amountCents: 1.5, currency: "EUR" },
      evidence: evidence(),
    });
    expect(result.success).toBe(false);
  });
});

describe("known / estimated / unknown helpers", () => {
  it("known builds a known field carrying the value and evidence", () => {
    expect(known(42, evidence())).toEqual({ status: "known", value: 42, evidence: evidence() });
  });

  it("estimated builds an estimated field carrying the value and evidence", () => {
    expect(estimated(42, evidence())).toEqual({
      status: "estimated",
      value: 42,
      evidence: evidence(),
    });
  });

  it("unknown builds a field with no value", () => {
    expect(unknown()).toEqual({ status: "unknown" });
  });
});

describe("isConfirmed", () => {
  it("is true only for a known field", () => {
    expect(isConfirmed(known(1, evidence()))).toBe(true);
    expect(isConfirmed(estimated(1, evidence()))).toBe(false);
    expect(isConfirmed(unknown())).toBe(false);
  });
});
