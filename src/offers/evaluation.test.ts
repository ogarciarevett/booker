import { describe, expect, it } from "vitest";
import type { ErrandBrief } from "../errands/brief.ts";
import { parseErrandBrief } from "../errands/brief.ts";
import { evaluateOffer } from "./evaluation.ts";
import { estimated, known, unknown } from "./field.ts";
import type { Offer } from "./offer.ts";
import { parseOffer } from "./offer.ts";

function evidence() {
  return {
    source: "call" as const,
    reference: "call-2026-09-29-10:00",
    quote: "We have two seats left that week.",
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
    location: { area: "Northside district", acceptableAlternatives: ["Northside Annex"] },
    dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
    hardRequirements: [
      {
        id: "req-licence-category",
        description: "Must cover licence category B",
        field: "licenceCategory",
        rule: { op: "equals", value: "B" },
      },
    ],
    preferences: [],
    spendLimits: {
      currency: "EUR",
      totalMax: { amountCents: 130_000, currency: "EUR" },
      perParticipantMax: { amountCents: 65_000, currency: "EUR" },
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
    customFields: {
      licenceCategory: known("B", evidence()),
    },
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture offer: ${result.issues.join(", ")}`);
  return result.offer;
}

describe("evaluateOffer", () => {
  it("is eligible when every check passes on known values", () => {
    const result = evaluateOffer(brief(), offer());
    expect(result).toEqual({ status: "eligible", failures: [], unknowns: [] });
  });

  it("is ineligible when seats are fewer than the participant count", () => {
    const result = evaluateOffer(brief(), offer({ seatsAvailable: known(1, evidence()) }));
    expect(result.status).toBe("ineligible");
    expect(result.failures.some((failure) => failure.includes("seatsAvailable"))).toBe(true);
  });

  it("accepts 1 seat when allowPartialBooking is true", () => {
    const partialBrief = brief({ groupPolicy: { sameProvider: true, allowPartialBooking: true } });
    const result = evaluateOffer(partialBrief, offer({ seatsAvailable: known(1, evidence()) }));
    expect(result.status).toBe("eligible");
  });

  it("is incomplete when seats are estimated", () => {
    const result = evaluateOffer(brief(), offer({ seatsAvailable: estimated(2, evidence()) }));
    expect(result.status).toBe("incomplete");
    expect(result.unknowns.some((entry) => entry.includes("seatsAvailable"))).toBe(true);
  });

  it("is incomplete when seats are unknown", () => {
    const result = evaluateOffer(brief(), offer({ seatsAvailable: unknown() }));
    expect(result.status).toBe("incomplete");
  });

  it("is ineligible when dates fall outside the window expanded by flexibility", () => {
    const result = evaluateOffer(
      brief(),
      offer({ dates: known({ start: "2026-12-01", end: "2026-12-05" }, evidence()) }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.failures.some((failure) => failure.includes("dates"))).toBe(true);
  });

  it("accepts dates within the window expanded by flexibilityDays", () => {
    const result = evaluateOffer(
      brief(),
      offer({ dates: known({ start: "2026-10-30", end: "2026-11-16" }, evidence()) }),
    );
    expect(result.status).toBe("eligible");
  });

  it("accepts the location when it matches an acceptable alternative", () => {
    const result = evaluateOffer(
      brief(),
      offer({ location: known("northside annex", evidence()) }),
    );
    expect(result.status).toBe("eligible");
  });

  it("is ineligible when the location is neither the area nor an alternative", () => {
    const result = evaluateOffer(brief(), offer({ location: known("Downtown", evidence()) }));
    expect(result.status).toBe("ineligible");
    expect(result.failures.some((failure) => failure.includes("location"))).toBe(true);
  });

  it("is ineligible when a hard requirement equals rule fails", () => {
    const result = evaluateOffer(
      brief(),
      offer({ customFields: { licenceCategory: known("A", evidence()) } }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.failures.some((failure) => failure.includes("req-licence-category"))).toBe(true);
  });

  it("is ineligible when a hard requirement type mismatches", () => {
    const atLeastBrief = brief({
      hardRequirements: [
        {
          id: "req-seats",
          description: "Needs at least 2 seats",
          field: "seatCount",
          rule: { op: "atLeast", value: 2 },
        },
      ],
    });
    const result = evaluateOffer(
      atLeastBrief,
      offer({ customFields: { seatCount: known("many", evidence()) } }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.failures.some((failure) => failure.includes("req-seats"))).toBe(true);
  });

  it("is incomplete when a hard requirement field is unknown", () => {
    const result = evaluateOffer(brief(), offer({ customFields: { licenceCategory: unknown() } }));
    expect(result.status).toBe("incomplete");
    expect(result.unknowns.some((entry) => entry.includes("req-licence-category"))).toBe(true);
  });

  it("is incomplete, not ineligible, when only an estimate pushes the total over totalMax", () => {
    const result = evaluateOffer(
      brief(),
      offer({
        costItems: [
          {
            id: "cost-tuition",
            label: "Tuition",
            appliesTo: "each-participant",
            kind: "charge",
            amount: known({ amountCents: 60_000, currency: "EUR" }, evidence()),
          },
          {
            id: "cost-extra-fee",
            label: "Extra fee",
            appliesTo: "group",
            kind: "charge",
            amount: estimated({ amountCents: 20_000, currency: "EUR" }, evidence()),
          },
        ],
      }),
    );
    expect(result.status).toBe("incomplete");
    expect(result.failures).toEqual([]);
    expect(result.unknowns.some((entry) => entry.startsWith("total"))).toBe(true);
  });

  it("is ineligible when confirmed charges alone exceed totalMax and no discount is pending", () => {
    const result = evaluateOffer(
      brief(),
      offer({
        costItems: [
          {
            id: "cost-tuition",
            label: "Tuition",
            appliesTo: "each-participant",
            kind: "charge",
            amount: known({ amountCents: 70_000, currency: "EUR" }, evidence()),
          },
        ],
      }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.failures.some((failure) => failure.startsWith("total"))).toBe(true);
  });

  it("is incomplete when confirmed charges exceed totalMax but a discount is still unconfirmed", () => {
    const result = evaluateOffer(
      brief(),
      offer({
        costItems: [
          {
            id: "cost-tuition",
            label: "Tuition",
            appliesTo: "each-participant",
            kind: "charge",
            amount: known({ amountCents: 70_000, currency: "EUR" }, evidence()),
          },
          {
            id: "discount-pair",
            label: "Pair discount",
            appliesTo: "group",
            kind: "discount",
            amount: estimated({ amountCents: 20_000, currency: "EUR" }, evidence()),
          },
        ],
      }),
    );
    expect(result.status).toBe("incomplete");
    expect(result.failures).toEqual([]);
  });

  it("is ineligible when one participant's confirmed cost exceeds perParticipantMax", () => {
    const result = evaluateOffer(
      brief(),
      offer({
        costItems: [
          {
            id: "cost-tuition",
            label: "Tuition",
            appliesTo: "each-participant",
            kind: "charge",
            amount: known({ amountCents: 55_000, currency: "EUR" }, evidence()),
          },
          {
            id: "cost-theory-exam",
            label: "Theory exam",
            appliesTo: { participantIds: ["participant-b"] },
            kind: "charge",
            amount: known({ amountCents: 15_000, currency: "EUR" }, evidence()),
          },
        ],
      }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.failures).toEqual([
      "perParticipant.participant-b 70000 EUR exceeds limit 65000 EUR",
    ]);
  });

  it("is incomplete when an estimated deposit is above depositMax", () => {
    const result = evaluateOffer(
      brief(),
      offer({ deposit: estimated({ amountCents: 20_000, currency: "EUR" }, evidence()) }),
    );
    expect(result.status).toBe("incomplete");
    expect(result.failures).toEqual([]);
    expect(result.unknowns.some((entry) => entry.startsWith("deposit"))).toBe(true);
  });

  it("is incomplete when the total is under budget but not fully confirmed", () => {
    const result = evaluateOffer(
      brief(),
      offer({
        costItems: [
          {
            id: "cost-tuition",
            label: "Tuition",
            appliesTo: "each-participant",
            kind: "charge",
            amount: estimated({ amountCents: 60_000, currency: "EUR" }, evidence()),
          },
        ],
      }),
    );
    expect(result.status).toBe("incomplete");
    expect(result.unknowns.some((entry) => entry.startsWith("total"))).toBe(true);
  });

  it("is ineligible when the deposit exceeds depositMax", () => {
    const result = evaluateOffer(
      brief(),
      offer({ deposit: known({ amountCents: 20_000, currency: "EUR" }, evidence()) }),
    );
    expect(result.status).toBe("ineligible");
    expect(result.failures.some((failure) => failure.startsWith("deposit"))).toBe(true);
  });

  it("is incomplete when the cancellation penalty is unknown", () => {
    const result = evaluateOffer(brief(), offer({ cancellationPenalty: unknown() }));
    expect(result.status).toBe("incomplete");
    expect(result.unknowns.some((entry) => entry.startsWith("cancellationPenalty"))).toBe(true);
  });
});

describe("evaluateOffer budget edge cases", () => {
  it("is incomplete when confirmed charges exceed totalMax but an amount in another currency was excluded", () => {
    const result = evaluateOffer(
      brief(),
      offer({
        costItems: [
          {
            id: "cost-tuition",
            label: "Tuition",
            appliesTo: "each-participant",
            kind: "charge",
            amount: known({ amountCents: 70_000, currency: "EUR" }, evidence()),
          },
          {
            id: "discount-foreign",
            label: "Discount quoted in another currency",
            appliesTo: "group",
            kind: "discount",
            amount: known({ amountCents: 20_000, currency: "USD" }, evidence()),
          },
        ],
      }),
    );
    expect(result.status).toBe("incomplete");
    expect(result.failures).toEqual([]);
  });
});
