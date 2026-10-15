import { describe, expect, it } from "vitest";
import type { ErrandBrief } from "../errands/brief.ts";
import { parseErrandBrief } from "../errands/brief.ts";
import { groupCost } from "./cost.ts";
import { estimated, known, unknown } from "./field.ts";
import type { CostItem, Offer } from "./offer.ts";
import { parseOffer } from "./offer.ts";

function evidence() {
  return {
    source: "call" as const,
    reference: "call-2026-09-29-10:00",
    quote: "Tuition is 600 euros per participant.",
    capturedAt: "2026-09-29T10:00:00.000Z",
  };
}

function twoParticipantBrief(): ErrandBrief {
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
    spendLimits: { currency: "EUR" },
    authorizedActions: ["quote"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: { description: "Both enrolled.", requiresWrittenConfirmation: false },
    questions: [],
    providers: [{ id: "provider-northside", name: "Northside", phoneE164: "+15555550100" }],
    shareableAttributes: [],
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

function baseOffer(costItems: CostItem[]): Offer {
  const result = parseOffer({
    id: "offer-001",
    errandId: "errand-001",
    providerId: "provider-northside",
    queriedAt: "2026-09-29T10:05:00.000Z",
    seatsAvailable: known(2, evidence()),
    dates: known({ start: "2026-11-03", end: "2026-11-12" }, evidence()),
    location: known("Northside district", evidence()),
    costItems,
    deposit: unknown(),
    cancellationPenalty: unknown(),
    extras: [],
    customFields: {},
  });
  if (!result.ok) throw new Error(`invalid fixture offer: ${result.issues.join(", ")}`);
  return result.offer;
}

describe("groupCost", () => {
  it("charges an each-participant item once per participant", () => {
    const brief = twoParticipantBrief();
    const offer = baseOffer([
      {
        id: "cost-tuition",
        label: "Tuition",
        appliesTo: "each-participant",
        kind: "charge",
        amount: known({ amountCents: 60_000, currency: "EUR" }, evidence()),
      },
    ]);
    const cost = groupCost(brief, offer);
    expect(cost.total).toEqual({ amountCents: 120_000, currency: "EUR" });
    expect(cost.perParticipant["participant-a"]).toEqual({ amountCents: 60_000, currency: "EUR" });
    expect(cost.perParticipant["participant-b"]).toEqual({ amountCents: 60_000, currency: "EUR" });
    expect(cost.estimated).toBe(false);
    expect(cost.missing).toEqual([]);
    expect(cost.unconfirmedDiscounts).toEqual([]);
    expect(cost.issues).toEqual([]);
  });

  it("flags estimated as true when a known charge is estimated", () => {
    const brief = twoParticipantBrief();
    const offer = baseOffer([
      {
        id: "cost-tuition",
        label: "Tuition",
        appliesTo: "each-participant",
        kind: "charge",
        amount: estimated({ amountCents: 60_000, currency: "EUR" }, evidence()),
      },
    ]);
    const cost = groupCost(brief, offer);
    expect(cost.total).toEqual({ amountCents: 120_000, currency: "EUR" });
    expect(cost.estimated).toBe(true);
  });

  it("sends an unknown charge to missing and counts it as nothing", () => {
    const brief = twoParticipantBrief();
    const offer = baseOffer([
      {
        id: "cost-tuition",
        label: "Tuition",
        appliesTo: "group",
        kind: "charge",
        amount: unknown(),
      },
    ]);
    const cost = groupCost(brief, offer);
    expect(cost.total).toEqual({ amountCents: 0, currency: "EUR" });
    expect(cost.missing).toEqual(["cost-tuition"]);
  });

  it("subtracts a known discount", () => {
    const brief = twoParticipantBrief();
    const offer = baseOffer([
      {
        id: "cost-tuition",
        label: "Tuition",
        appliesTo: "each-participant",
        kind: "charge",
        amount: known({ amountCents: 60_000, currency: "EUR" }, evidence()),
      },
      {
        id: "cost-discount",
        label: "Loyalty discount",
        appliesTo: "group",
        kind: "discount",
        amount: known({ amountCents: 10_000, currency: "EUR" }, evidence()),
      },
    ]);
    const cost = groupCost(brief, offer);
    expect(cost.total).toEqual({ amountCents: 110_000, currency: "EUR" });
    expect(cost.unconfirmedDiscounts).toEqual([]);
  });

  it("does not subtract an estimated or unknown discount and reports it as unconfirmed", () => {
    const brief = twoParticipantBrief();
    const offer = baseOffer([
      {
        id: "cost-tuition",
        label: "Tuition",
        appliesTo: "each-participant",
        kind: "charge",
        amount: known({ amountCents: 60_000, currency: "EUR" }, evidence()),
      },
      {
        id: "cost-discount-estimated",
        label: "Maybe discount",
        appliesTo: "group",
        kind: "discount",
        amount: estimated({ amountCents: 10_000, currency: "EUR" }, evidence()),
      },
      {
        id: "cost-discount-unknown",
        label: "Unconfirmed discount",
        appliesTo: "group",
        kind: "discount",
        amount: unknown(),
      },
    ]);
    const cost = groupCost(brief, offer);
    expect(cost.total).toEqual({ amountCents: 120_000, currency: "EUR" });
    expect(cost.unconfirmedDiscounts).toEqual(["cost-discount-estimated", "cost-discount-unknown"]);
    expect(cost.estimated).toBe(false);
  });

  it("applies a participantIds cost item only to the named participants", () => {
    const brief = twoParticipantBrief();
    const offer = baseOffer([
      {
        id: "cost-single-room",
        label: "Single room supplement",
        appliesTo: { participantIds: ["participant-a"] },
        kind: "charge",
        amount: known({ amountCents: 2_000, currency: "EUR" }, evidence()),
      },
    ]);
    const cost = groupCost(brief, offer);
    expect(cost.perParticipant["participant-a"]).toEqual({ amountCents: 2_000, currency: "EUR" });
    expect(cost.perParticipant["participant-b"]).toEqual({ amountCents: 0, currency: "EUR" });
    expect(cost.total).toEqual({ amountCents: 2_000, currency: "EUR" });
  });

  it("reports a participantIds entry that is not in the brief as an issue", () => {
    const brief = twoParticipantBrief();
    const offer = baseOffer([
      {
        id: "cost-ghost",
        label: "Ghost participant charge",
        appliesTo: { participantIds: ["participant-z"] },
        kind: "charge",
        amount: known({ amountCents: 2_000, currency: "EUR" }, evidence()),
      },
    ]);
    const cost = groupCost(brief, offer);
    expect(cost.issues.some((issue) => issue.includes("participant-z"))).toBe(true);
    expect(cost.total).toEqual({ amountCents: 0, currency: "EUR" });
  });

  it("splits a shared group charge with the largest-remainder method, extra cents to brief order", () => {
    const brief = twoParticipantBrief();
    const offer = baseOffer([
      {
        id: "cost-registration",
        label: "Registration",
        appliesTo: "group",
        kind: "charge",
        amount: known({ amountCents: 101, currency: "EUR" }, evidence()),
      },
    ]);
    const cost = groupCost(brief, offer);
    expect(cost.perParticipant["participant-a"]).toEqual({ amountCents: 51, currency: "EUR" });
    expect(cost.perParticipant["participant-b"]).toEqual({ amountCents: 50, currency: "EUR" });
    expect(cost.total).toEqual({ amountCents: 101, currency: "EUR" });
  });

  it("excludes an amount whose currency differs from spendLimits.currency and reports it in issues", () => {
    const brief = twoParticipantBrief();
    const offer = baseOffer([
      {
        id: "cost-foreign",
        label: "Foreign currency charge",
        appliesTo: "group",
        kind: "charge",
        amount: known({ amountCents: 1_000, currency: "USD" }, evidence()),
      },
    ]);
    const cost = groupCost(brief, offer);
    expect(cost.total).toEqual({ amountCents: 0, currency: "EUR" });
    expect(cost.missing).toEqual([]);
    expect(cost.issues.some((issue) => issue.includes("cost-foreign"))).toBe(true);
  });
});

describe("groupCost edge cases", () => {
  const eur = (amountCents: number) => ({ amountCents, currency: "EUR" });

  it("charges a participant listed twice in one item only once and reports it", () => {
    const cost = groupCost(
      twoParticipantBrief(),
      baseOffer([
        {
          id: "cost-exam",
          label: "Exam fee",
          appliesTo: { participantIds: ["participant-a", "participant-a"] },
          kind: "charge",
          amount: known(eur(9_000), evidence()),
        },
      ]),
    );

    expect(cost.perParticipant["participant-a"]).toEqual(eur(9_000));
    expect(cost.total).toEqual(eur(9_000));
    expect(cost.issues.some((issue) => issue.includes("cost-exam"))).toBe(true);
  });

  it("splits a negative shared amount so the parts still add up to the total", () => {
    const cost = groupCost(
      twoParticipantBrief(),
      baseOffer([
        {
          id: "cost-room",
          label: "Shared room",
          appliesTo: "group",
          kind: "charge",
          amount: known(eur(1_000), evidence()),
        },
        {
          id: "discount-group",
          label: "Group discount",
          appliesTo: "group",
          kind: "discount",
          amount: known(eur(1_501), evidence()),
        },
      ]),
    );

    const a = cost.perParticipant["participant-a"]?.amountCents ?? Number.NaN;
    const b = cost.perParticipant["participant-b"]?.amountCents ?? Number.NaN;
    expect(cost.total).toEqual(eur(-501));
    expect(a + b).toBe(-501);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });

  it("keeps shared costs in the total and reports an issue when there are no participants", () => {
    const brief = { ...twoParticipantBrief(), participants: [] };
    const cost = groupCost(
      brief,
      baseOffer([
        {
          id: "cost-room",
          label: "Shared room",
          appliesTo: "group",
          kind: "charge",
          amount: known(eur(20_000), evidence()),
        },
      ]),
    );

    expect(cost.total).toEqual(eur(20_000));
    expect(cost.issues.some((issue) => issue.includes("no participants"))).toBe(true);
  });
});
