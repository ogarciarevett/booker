import { describe, expect, it } from "vitest";
import type { ErrandBrief } from "../errands/brief.ts";
import { parseErrandBrief } from "../errands/brief.ts";
import { groupCost } from "../offers/cost.ts";
import { estimated, known, unknown } from "../offers/field.ts";
import type { Offer } from "../offers/offer.ts";
import { parseOffer } from "../offers/offer.ts";
import type { DateRange } from "../shared/dates.ts";
import { parseLocalDate } from "../shared/dates.ts";
import { authorizeCommit } from "./authorization.ts";
import type { StandingRules } from "./standing-rules.ts";

/** Builds a branded DateRange from plain YYYY-MM-DD strings for direct object construction. */
function dateRange(start: string, end: string): DateRange {
  return { start: parseLocalDate(start), end: parseLocalDate(end) };
}

function evidence() {
  return {
    source: "call" as const,
    reference: "call-2026-09-29-10:00",
    quote: "We can confirm those terms.",
    capturedAt: "2026-09-29T10:00:00.000Z",
  };
}

function brief(overrides: Record<string, unknown> = {}): ErrandBrief {
  const result = parseErrandBrief({
    id: "errand-001",
    kind: "driving-school",
    objective: "Enroll two participants.",
    timeZone: "Europe/Madrid",
    participants: [
      { id: "participant-a", attributes: {} },
      { id: "participant-b", attributes: {} },
    ],
    location: { area: "Northside district", acceptableAlternatives: [] },
    dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
    hardRequirements: [],
    preferences: [],
    spendLimits: {
      currency: "EUR",
      totalMax: { amountCents: 130_000, currency: "EUR" },
      depositMax: { amountCents: 15_000, currency: "EUR" },
      cancellationPenaltyMax: { amountCents: 10_000, currency: "EUR" },
    },
    authorizedActions: ["quote", "book"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: { description: "Both enrolled.", requiresWrittenConfirmation: false },
    questions: [],
    providers: [{ id: "provider-northside", name: "Northside", phoneE164: "+15555550100" }],
    shareableAttributes: [],
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

function offer(overrides: Record<string, unknown> = {}): Offer {
  const result = parseOffer({
    id: "offer-001",
    errandId: "errand-001",
    providerId: "provider-northside",
    queriedAt: "2026-09-29T10:05:00.000Z",
    seatsAvailable: known(2, evidence()),
    dates: known({ start: "2026-11-03", end: "2026-11-12" }, evidence()),
    location: known("Northside district", evidence()),
    costItems: [
      {
        id: "cost-tuition",
        label: "Tuition",
        appliesTo: "each-participant",
        kind: "charge",
        amount: known({ amountCents: 60_000, currency: "EUR" }, evidence()),
      },
    ],
    deposit: known({ amountCents: 10_000, currency: "EUR" }, evidence()),
    cancellationPenalty: known({ amountCents: 5_000, currency: "EUR" }, evidence()),
    extras: [],
    customFields: {},
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture offer: ${result.issues.join(", ")}`);
  return result.offer;
}

function permissiveRules(overrides: Partial<StandingRules> = {}): StandingRules {
  return {
    allowedWindows: [dateRange("2026-11-01", "2026-11-30")],
    maxTotal: { amountCents: 130_000, currency: "EUR" },
    maxDeposit: { amountCents: 15_000, currency: "EUR" },
    maxCancellationPenalty: { amountCents: 10_000, currency: "EUR" },
    autoBookWithinRules: true,
    ...overrides,
  };
}

function quotedFor(theOffer: Offer, theBrief: ErrandBrief) {
  const cost = groupCost(theBrief, theOffer);
  if (theOffer.deposit.status !== "known")
    throw new Error("fixture offer must have a known deposit");
  if (theOffer.dates.status !== "known") throw new Error("fixture offer must have known dates");
  return { total: cost.total, deposit: theOffer.deposit.value, dates: theOffer.dates.value };
}

describe("authorizeCommit", () => {
  it("auto-books an eligible offer that matches quote and fits every standing rule", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules(),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result).toEqual({ decision: "auto", reasons: [] });
  });

  it("denies when the quoted total is 1 cent off the known total (misheard price)", () => {
    const theBrief = brief();
    const theOffer = offer();
    const quoted = quotedFor(theOffer, theBrief);
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules(),
      offer: theOffer,
      quoted: { ...quoted, total: { ...quoted.total, amountCents: quoted.total.amountCents + 1 } },
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.some((reason) => reason.includes("total"))).toBe(true);
  });

  it("needs the user when standing rules do not allow auto-booking", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules({ autoBookWithinRules: false }),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result.decision).toBe("needs_user");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("denies when the offer is only incomplete (unresolved unknowns)", () => {
    const theBrief = brief();
    const theOffer = offer({ cancellationPenalty: unknown() });
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules(),
      offer: theOffer,
      quoted: {
        total: groupCost(theBrief, theOffer).total,
        deposit: { amountCents: 10_000, currency: "EUR" },
        dates: dateRange("2026-11-03", "2026-11-12"),
      },
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("denies when book is not among the authorized actions", () => {
    const theBrief = brief({ authorizedActions: ["quote"] });
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules(),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.some((reason) => reason.includes('"book"'))).toBe(true);
  });

  it("denies when a quoted amount is in a currency other than the brief currency", () => {
    const theBrief = brief();
    const theOffer = offer();
    const quoted = quotedFor(theOffer, theBrief);
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules(),
      offer: theOffer,
      quoted: { ...quoted, deposit: { amountCents: quoted.deposit.amountCents, currency: "USD" } },
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.some((reason) => reason.includes("USD"))).toBe(true);
  });

  it("needs the user when the quote fits the brief but exceeds a standing rule maxTotal", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules({ maxTotal: { amountCents: 100_000, currency: "EUR" } }),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result.decision).toBe("needs_user");
    expect(result.reasons.some((reason) => reason.includes("maxTotal"))).toBe(true);
  });

  it("needs the user when a standing rule is in a different currency than the brief", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules({ maxTotal: { amountCents: 130_000, currency: "USD" } }),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result.decision).toBe("needs_user");
    expect(result.reasons.some((reason) => reason.includes("USD"))).toBe(true);
  });

  it("needs the user when the quoted dates fall outside every allowed standing-rule window", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules({
        allowedWindows: [dateRange("2026-12-01", "2026-12-31")],
      }),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result.decision).toBe("needs_user");
    expect(result.reasons.some((reason) => reason.includes("window"))).toBe(true);
  });

  it("never returns auto when any reason is present", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules({ autoBookWithinRules: false }),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.decision).toBe("needs_user");
  });
});

describe("authorizeCommit reconfirmation and standing-rule limits", () => {
  const eur = (amountCents: number) => ({ amountCents, currency: "EUR" });

  it("denies when the quoted deposit differs from the confirmed deposit (misheard deposit)", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules(),
      offer: theOffer,
      quoted: { ...quotedFor(theOffer, theBrief), deposit: eur(1_000) },
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.some((reason) => reason.startsWith("quoted deposit"))).toBe(true);
  });

  it("denies when the quoted dates differ from the confirmed dates (misheard dates)", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules(),
      offer: theOffer,
      quoted: { ...quotedFor(theOffer, theBrief), dates: dateRange("2026-11-04", "2026-11-13") },
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.some((reason) => reason.startsWith("quoted dates"))).toBe(true);
  });

  it("denies when the offer's deposit was never confirmed, even without a deposit limit", () => {
    const theBrief = brief({ spendLimits: { currency: "EUR" } });
    const theOffer = offer({ deposit: estimated(eur(10_000), evidence()) });
    const cost = groupCost(theBrief, theOffer);
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules(),
      offer: theOffer,
      quoted: {
        total: cost.total,
        deposit: eur(10_000),
        dates: dateRange("2026-11-03", "2026-11-12"),
      },
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.some((reason) => reason.includes("deposit is not confirmed"))).toBe(true);
  });

  it("denies when the offer's deposit is unknown, even without a deposit limit", () => {
    const theBrief = brief({ spendLimits: { currency: "EUR" } });
    const theOffer = offer({ deposit: unknown() });
    const cost = groupCost(theBrief, theOffer);
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules(),
      offer: theOffer,
      quoted: {
        total: cost.total,
        deposit: eur(0),
        dates: dateRange("2026-11-03", "2026-11-12"),
      },
    });
    expect(result.decision).toBe("denied");
    expect(result.reasons.some((reason) => reason.includes("deposit is not confirmed"))).toBe(true);
  });

  it("needs the user when the deposit exceeds the standing rule maxDeposit", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules({ maxDeposit: eur(5_000) }),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result.decision).toBe("needs_user");
    expect(result.reasons.some((reason) => reason.includes("maxDeposit"))).toBe(true);
  });

  it("needs the user when the cancellation penalty exceeds the standing rule maxCancellationPenalty", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules({ maxCancellationPenalty: eur(1_000) }),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result.decision).toBe("needs_user");
    expect(result.reasons.some((reason) => reason.includes("maxCancellationPenalty"))).toBe(true);
  });

  it("auto-books when the deposit and penalty sit exactly at the standing-rule limits", () => {
    const theBrief = brief();
    const theOffer = offer();
    const result = authorizeCommit({
      brief: theBrief,
      rules: permissiveRules({ maxDeposit: eur(10_000), maxCancellationPenalty: eur(5_000) }),
      offer: theOffer,
      quoted: quotedFor(theOffer, theBrief),
    });
    expect(result).toEqual({ decision: "auto", reasons: [] });
  });
});
