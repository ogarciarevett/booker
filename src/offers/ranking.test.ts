import { describe, expect, it } from "vitest";
import type { ErrandBrief } from "../errands/brief.ts";
import { parseErrandBrief } from "../errands/brief.ts";
import { known, unknown } from "./field.ts";
import type { Offer } from "./offer.ts";
import { parseOffer } from "./offer.ts";
import { extrasScenario, rankOffers } from "./ranking.ts";

function evidence() {
  return {
    source: "call" as const,
    reference: "call-2026-09-29-10:00",
    quote: "We have two seats left that week.",
    capturedAt: "2026-09-29T10:00:00.000Z",
  };
}

function brief(): ErrandBrief {
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
    spendLimits: { currency: "EUR", totalMax: { amountCents: 200_000, currency: "EUR" } },
    authorizedActions: ["quote", "book"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: { description: "Both enrolled.", requiresWrittenConfirmation: false },
    questions: [],
    providers: [
      { id: "provider-northside", name: "Northside", phoneE164: "+15555550100" },
      { id: "provider-harbor", name: "Harbor", phoneE164: "+15555550101" },
    ],
    shareableAttributes: [],
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

function offer(id: string, providerId: string, overrides: Record<string, unknown> = {}): Offer {
  const result = parseOffer({
    id,
    errandId: "errand-001",
    providerId,
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
    deposit: known({ amountCents: 5_000, currency: "EUR" }, evidence()),
    cancellationPenalty: known({ amountCents: 2_000, currency: "EUR" }, evidence()),
    extras: [
      {
        id: "extra-mock-exam",
        label: "Mock exam",
        unitPrice: known({ amountCents: 3_000, currency: "EUR" }, evidence()),
      },
    ],
    customFields: {},
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture offer: ${result.issues.join(", ")}`);
  return result.offer;
}

describe("rankOffers", () => {
  it("ranks a complete eligible offer above a cheaper-looking incomplete one", () => {
    const cheapIncomplete = offer("offer-cheap", "provider-harbor", {
      costItems: [
        {
          id: "cost-tuition",
          label: "Tuition",
          appliesTo: "each-participant",
          kind: "charge",
          amount: unknown(),
        },
      ],
    });
    const completeEligible = offer("offer-complete", "provider-northside");
    const ranked = rankOffers(brief(), [cheapIncomplete, completeEligible]);
    expect(ranked[0]?.offer.id).toBe("offer-complete");
    expect(ranked[0]?.evaluation.status).toBe("eligible");
    expect(ranked[1]?.offer.id).toBe("offer-cheap");
    expect(ranked[1]?.evaluation.status).toBe("incomplete");
  });

  it("orders eligible offers by ascending total", () => {
    const expensive = offer("offer-expensive", "provider-harbor", {
      costItems: [
        {
          id: "cost-tuition",
          label: "Tuition",
          appliesTo: "each-participant",
          kind: "charge",
          amount: known({ amountCents: 90_000, currency: "EUR" }, evidence()),
        },
      ],
    });
    const cheap = offer("offer-cheap-eligible", "provider-northside");
    const ranked = rankOffers(brief(), [expensive, cheap]);
    expect(ranked.map((entry) => entry.offer.id)).toEqual([
      "offer-cheap-eligible",
      "offer-expensive",
    ]);
  });

  it("puts ineligible offers last", () => {
    const ineligible = offer("offer-ineligible", "provider-harbor", {
      seatsAvailable: known(1, evidence()),
    });
    const eligible = offer("offer-eligible", "provider-northside");
    const ranked = rankOffers(brief(), [ineligible, eligible]);
    expect(ranked.map((entry) => entry.evaluation.status)).toEqual(["eligible", "ineligible"]);
  });

  it("breaks ties by providerId then id for determinism", () => {
    const a = offer("offer-b", "provider-harbor");
    const b = offer("offer-a", "provider-harbor");
    const ranked = rankOffers(brief(), [a, b]);
    expect(ranked.map((entry) => entry.offer.id)).toEqual(["offer-a", "offer-b"]);
  });
});

describe("extrasScenario", () => {
  it("prices a known extra at the requested quantity", () => {
    const offers = [offer("offer-a", "provider-northside")];
    const scenario = extrasScenario(offers, "extra-mock-exam", 2);
    expect(scenario).toEqual([
      {
        offerId: "offer-a",
        providerId: "provider-northside",
        unitPrice: known({ amountCents: 3_000, currency: "EUR" }, evidence()),
        cost: { amountCents: 6_000, currency: "EUR" },
      },
    ]);
  });

  it("returns a null cost when the extra is absent from the offer", () => {
    const offers = [offer("offer-a", "provider-northside", { extras: [] })];
    const scenario = extrasScenario(offers, "extra-mock-exam", 1);
    expect(scenario[0]).toEqual({
      offerId: "offer-a",
      providerId: "provider-northside",
      unitPrice: undefined,
      cost: null,
    });
  });

  it("returns a null cost when the extra's unit price is unknown", () => {
    const offers = [
      offer("offer-a", "provider-northside", {
        extras: [{ id: "extra-mock-exam", label: "Mock exam", unitPrice: unknown() }],
      }),
    ];
    const scenario = extrasScenario(offers, "extra-mock-exam", 1);
    expect(scenario[0]?.unitPrice).toEqual({ status: "unknown" });
    expect(scenario[0]?.cost).toBeNull();
  });
});

describe("ranking determinism and extras validation", () => {
  it("breaks ties by code-unit order, independent of the runtime locale", () => {
    const ranked = rankOffers(brief(), [
      offer("offer-1", "provider-a"),
      offer("offer-2", "provider-B"),
    ]);
    expect(ranked.map((entry) => entry.offer.providerId)).toEqual(["provider-B", "provider-a"]);
  });

  it.each([-1, 1.5, Number.NaN])("rejects an invalid extras quantity: %s", (quantity) => {
    expect(() =>
      extrasScenario([offer("offer-1", "provider-a")], "extra-mock-exam", quantity),
    ).toThrow(RangeError);
  });
});
