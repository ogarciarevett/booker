import { describe, expect, it } from "vitest";
import { parseStandingRules, standingRulesSchema } from "./standing-rules.ts";

function validRules(): unknown {
  return {
    allowedWindows: [{ start: "2026-11-01", end: "2026-11-30" }],
    maxTotal: { amountCents: 150_000, currency: "EUR" },
    maxDeposit: { amountCents: 20_000, currency: "EUR" },
    maxCancellationPenalty: { amountCents: 10_000, currency: "EUR" },
    autoBookWithinRules: true,
  };
}

describe("parseStandingRules", () => {
  it("accepts a fully populated rule set with matching currencies", () => {
    const result = parseStandingRules(validRules());
    expect(result.ok).toBe(true);
  });

  it("accepts a rule set with only autoBookWithinRules set", () => {
    const result = parseStandingRules({ autoBookWithinRules: false });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing autoBookWithinRules", () => {
    const result = parseStandingRules({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("autoBookWithinRules"))).toBe(true);
    }
  });

  it("rejects maxDeposit in a currency different from maxTotal", () => {
    const rules = validRules() as { maxDeposit: Record<string, unknown> };
    rules.maxDeposit["currency"] = "USD";
    const result = parseStandingRules(rules);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("maxDeposit"))).toBe(true);
    }
  });

  it("rejects maxCancellationPenalty in a currency different from the other rule amounts", () => {
    const rules = validRules() as { maxCancellationPenalty: Record<string, unknown> };
    rules.maxCancellationPenalty["currency"] = "GBP";
    const result = parseStandingRules(rules);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("maxCancellationPenalty"))).toBe(true);
    }
  });

  it("rejects an allowedWindows entry with start after end", () => {
    const rules = validRules() as { allowedWindows: Array<Record<string, unknown>> };
    rules.allowedWindows[0] = { start: "2026-11-30", end: "2026-11-01" };
    const result = parseStandingRules(rules);
    expect(result.ok).toBe(false);
  });

  it("exposes standingRulesSchema directly for schema composition", () => {
    expect(standingRulesSchema.safeParse(validRules()).success).toBe(true);
  });
});
