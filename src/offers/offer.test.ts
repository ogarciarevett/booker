import { describe, expect, it } from "vitest";
import { known, unknown } from "./field.ts";
import { offerSchema, parseOffer } from "./offer.ts";

function evidence() {
  return {
    source: "call" as const,
    reference: "call-2026-09-29-10:00",
    quote: "Tuition is 600 euros per participant.",
    capturedAt: "2026-09-29T10:00:00.000Z",
  };
}

function validOffer(): unknown {
  return {
    id: "offer-northside-001",
    errandId: "errand-driving-school-001",
    providerId: "provider-northside",
    queriedAt: "2026-09-29T10:05:00.000Z",
    seatsAvailable: known(4, evidence()),
    dates: known({ start: "2026-11-03", end: "2026-11-12" }, evidence()),
    location: known("Northside district", evidence()),
    costItems: [
      {
        id: "cost-tuition",
        label: "Tuition per participant",
        appliesTo: "each-participant",
        kind: "charge",
        amount: known({ amountCents: 60_000, currency: "EUR" }, evidence()),
      },
      {
        id: "cost-registration",
        label: "One-time registration fee",
        appliesTo: "group",
        kind: "charge",
        amount: known({ amountCents: 5_000, currency: "EUR" }, evidence()),
      },
    ],
    deposit: known({ amountCents: 10_000, currency: "EUR" }, evidence()),
    cancellationPenalty: known({ amountCents: 5_000, currency: "EUR" }, evidence()),
    extras: [
      {
        id: "extra-mock-exam",
        label: "Extra mock exam",
        unitPrice: known({ amountCents: 3_000, currency: "EUR" }, evidence()),
      },
    ],
    customFields: {
      licenceCategory: known("B", evidence()),
      backToBackPhases: unknown(),
    },
  };
}

describe("parseOffer", () => {
  it("accepts a fully valid offer", () => {
    const result = parseOffer(validOffer());
    expect(result.ok).toBe(true);
  });

  it("accepts a costItem applying to a specific set of participants", () => {
    const offer = validOffer() as { costItems: Array<Record<string, unknown>> };
    offer.costItems.push({
      id: "cost-single-room",
      label: "Single room supplement",
      appliesTo: { participantIds: ["participant-a"] },
      kind: "charge",
      amount: known({ amountCents: 2_000, currency: "EUR" }, evidence()),
    });
    const result = parseOffer(offer);
    expect(result.ok).toBe(true);
  });

  it("rejects a missing required field", () => {
    const result = parseOffer({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("rejects duplicate cost item ids", () => {
    const offer = validOffer() as { costItems: Array<Record<string, unknown>> };
    offer.costItems.push({ ...offer.costItems[0] });
    const result = parseOffer(offer);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("costItems"))).toBe(true);
    }
  });

  it("rejects duplicate extra ids", () => {
    const offer = validOffer() as { extras: Array<Record<string, unknown>> };
    offer.extras.push({ ...offer.extras[0] });
    const result = parseOffer(offer);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("extras"))).toBe(true);
    }
  });

  it("rejects an unrecognized costItem kind", () => {
    const offer = validOffer() as { costItems: Array<Record<string, unknown>> };
    const first = offer.costItems[0];
    if (first) first["kind"] = "refund";
    const result = parseOffer(offer);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty participantIds list on a costItem", () => {
    const offer = validOffer() as { costItems: Array<Record<string, unknown>> };
    offer.costItems.push({
      id: "cost-empty",
      label: "Broken",
      appliesTo: { participantIds: [] },
      kind: "charge",
      amount: known({ amountCents: 100, currency: "EUR" }, evidence()),
    });
    const result = parseOffer(offer);
    expect(result.ok).toBe(false);
  });

  it("exposes offerSchema directly for schema composition", () => {
    expect(offerSchema.safeParse(validOffer()).success).toBe(true);
  });
});
