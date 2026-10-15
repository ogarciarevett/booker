import { describe, expect, it } from "vitest";
import drivingSchoolBrief from "../examples/errands/driving-school.example.json" with {
  type: "json",
};
import { parseErrandBrief } from "../src/errands/brief.ts";
import { groupCost } from "../src/offers/cost.ts";
import { known, unknown } from "../src/offers/field.ts";
import type { Offer } from "../src/offers/offer.ts";
import { parseOffer } from "../src/offers/offer.ts";
import { authorizeCommit } from "../src/policies/authorization.ts";
import { parseStandingRules } from "../src/policies/standing-rules.ts";

// Exercises authorizeCommit against the driving-school example brief, the
// same fixture the offers scenarios use (see tests/offers-scenarios.test.ts).

function evidence(quote: string) {
  return {
    source: "call" as const,
    reference: "call-2026-09-29-10:00",
    quote,
    capturedAt: "2026-09-29T10:00:00.000Z",
  };
}

function brief() {
  const result = parseErrandBrief(drivingSchoolBrief);
  if (!result.ok) throw new Error(`invalid driving-school fixture: ${result.issues.join(", ")}`);
  return result.brief;
}

function eligibleOffer(overrides: Record<string, unknown> = {}): Offer {
  const result = parseOffer({
    id: "offer-northside-confirmed",
    errandId: "errand-driving-school-001",
    providerId: "provider-northside",
    queriedAt: "2026-09-29T10:05:00.000Z",
    seatsAvailable: known(2, evidence("We have two seats for that week.")),
    dates: known({ start: "2026-11-03", end: "2026-11-12" }, evidence("Runs 3rd to 12th.")),
    location: known("Northside district", evidence("We're on Northside district.")),
    costItems: [
      {
        id: "cost-tuition",
        label: "Tuition per participant",
        appliesTo: "each-participant",
        kind: "charge",
        amount: known({ amountCents: 55_000, currency: "EUR" }, evidence("550 euros each.")),
      },
    ],
    deposit: known({ amountCents: 15_000, currency: "EUR" }, evidence("150 euro deposit.")),
    cancellationPenalty: known(
      { amountCents: 8_000, currency: "EUR" },
      evidence("80 euro cancellation fee."),
    ),
    extras: [],
    customFields: {
      licenceCategory: known("B", evidence("Category B, yes.")),
      backToBackPhases: known(true, evidence("Theory and practical run back-to-back.")),
    },
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture offer: ${result.issues.join(", ")}`);
  return result.offer;
}

function permissiveStandingRules() {
  const result = parseStandingRules({
    allowedWindows: [{ start: "2026-10-15", end: "2026-11-30" }],
    maxTotal: { amountCents: 240_000, currency: "EUR" },
    maxDeposit: { amountCents: 20_000, currency: "EUR" },
    maxCancellationPenalty: { amountCents: 10_000, currency: "EUR" },
    autoBookWithinRules: true,
  });
  if (!result.ok) throw new Error(`invalid fixture standing rules: ${result.issues.join(", ")}`);
  return result.rules;
}

function quotedFor(offer: Offer, theBrief: ReturnType<typeof brief>) {
  const cost = groupCost(theBrief, offer);
  if (offer.deposit.status !== "known") throw new Error("fixture offer must have a known deposit");
  if (offer.dates.status !== "known") throw new Error("fixture offer must have known dates");
  return { total: cost.total, deposit: offer.deposit.value, dates: offer.dates.value };
}

describe("authorizeCommit against the driving-school example brief", () => {
  it("auto-books a fully confirmed eligible offer that fits the standing rules", () => {
    const theBrief = brief();
    const offer = eligibleOffer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveStandingRules(),
      offer,
      quoted: quotedFor(offer, theBrief),
    });
    expect(result).toEqual({ decision: "auto", reasons: [] });
  });

  it("denies the same offer when the agent quotes a total 1 cent different (misheard price)", () => {
    const theBrief = brief();
    const offer = eligibleOffer();
    const quoted = quotedFor(offer, theBrief);
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveStandingRules(),
      offer,
      quoted: { ...quoted, total: { ...quoted.total, amountCents: quoted.total.amountCents + 1 } },
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.some((reason) => reason.includes("total"))).toBe(true);
  });

  it("needs the user when standing rules have autoBookWithinRules set to false", () => {
    const theBrief = brief();
    const offer = eligibleOffer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: (() => {
        const result = parseStandingRules({
          ...permissiveStandingRules(),
          autoBookWithinRules: false,
        });
        if (!result.ok)
          throw new Error(`invalid fixture standing rules: ${result.issues.join(", ")}`);
        return result.rules;
      })(),
      offer,
      quoted: quotedFor(offer, theBrief),
    });
    expect(result.decision).toBe("needs_user");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("denies an offer that is only incomplete (the licence-category requirement is unresolved)", () => {
    const theBrief = brief();
    const offer = eligibleOffer({
      customFields: { licenceCategory: unknown(), backToBackPhases: unknown() },
    });
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveStandingRules(),
      offer,
      quoted: quotedFor(offer, theBrief),
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
