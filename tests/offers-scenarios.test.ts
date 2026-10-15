import { describe, expect, it } from "vitest";
import drivingSchoolBrief from "../examples/errands/driving-school.example.json" with {
  type: "json",
};
import restaurantBrief from "../examples/errands/restaurant.example.json" with { type: "json" };
import { parseErrandBrief } from "../src/errands/brief.ts";
import { groupCost } from "../src/offers/cost.ts";
import { evaluateOffer } from "../src/offers/evaluation.ts";
import { estimated, known, unknown } from "../src/offers/field.ts";
import { parseOffer } from "../src/offers/offer.ts";
import { rankOffers } from "../src/offers/ranking.ts";

// Same offers/* functions run unchanged against both example errand kinds;
// only the brief and the offer content differ per kind.

function evidence(quote: string) {
  return {
    source: "call" as const,
    reference: "call-2026-09-29-10:00",
    quote,
    capturedAt: "2026-09-29T10:00:00.000Z",
  };
}

function drivingSchool() {
  const result = parseErrandBrief(drivingSchoolBrief);
  if (!result.ok) throw new Error(`invalid driving-school fixture: ${result.issues.join(", ")}`);
  return result.brief;
}

function restaurant() {
  const result = parseErrandBrief(restaurantBrief);
  if (!result.ok) throw new Error(`invalid restaurant fixture: ${result.issues.join(", ")}`);
  return result.brief;
}

function parseOfferOrThrow(input: unknown) {
  const result = parseOffer(input);
  if (!result.ok) throw new Error(`invalid fixture offer: ${result.issues.join(", ")}`);
  return result.offer;
}

describe("offers domain against the driving-school example brief", () => {
  const brief = drivingSchool();

  function completeEligibleOffer() {
    return parseOfferOrThrow({
      id: "offer-northside-complete",
      errandId: brief.id,
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
    });
  }

  function cheaperIncompleteOffer() {
    return parseOfferOrThrow({
      id: "offer-harbor-cheap-incomplete",
      errandId: brief.id,
      providerId: "provider-harbor",
      queriedAt: "2026-09-29T10:10:00.000Z",
      seatsAvailable: known(2, evidence("Two seats available.")),
      dates: known({ start: "2026-11-04", end: "2026-11-13" }, evidence("4th to 13th.")),
      location: known("Northside district", evidence("Also Northside district.")),
      costItems: [
        {
          id: "cost-tuition",
          label: "Tuition per participant",
          appliesTo: "each-participant",
          kind: "charge",
          amount: known({ amountCents: 40_000, currency: "EUR" }, evidence("400 euros each.")),
        },
      ],
      deposit: known({ amountCents: 10_000, currency: "EUR" }, evidence("100 euro deposit.")),
      cancellationPenalty: known(
        { amountCents: 5_000, currency: "EUR" },
        evidence("50 euro cancellation fee."),
      ),
      extras: [],
      customFields: {
        licenceCategory: known("B", evidence("Category B here too.")),
        // Never asked whether the phases run back-to-back: the hard requirement stays unresolved.
        backToBackPhases: unknown(),
      },
    });
  }

  it("ranks the complete eligible offer above the cheaper-looking incomplete one", () => {
    const ranked = rankOffers(brief, [cheaperIncompleteOffer(), completeEligibleOffer()]);
    expect(ranked[0]?.offer.id).toBe("offer-northside-complete");
    expect(ranked[0]?.evaluation.status).toBe("eligible");
    expect(ranked[1]?.offer.id).toBe("offer-harbor-cheap-incomplete");
    expect(ranked[1]?.evaluation.status).toBe("incomplete");
    // Cheaper on paper: the ranking is not driven by price once one offer is incomplete.
    const [eligible, incomplete] = ranked;
    if (!eligible || !incomplete) throw new Error("expected two ranked offers");
    expect(incomplete.cost.total.amountCents).toBeLessThan(eligible.cost.total.amountCents);
  });

  it("rejects an offer with only 1 seat for the two-participant errand", () => {
    const offer = parseOfferOrThrow({
      ...completeEligibleOffer(),
      id: "offer-northside-one-seat",
      seatsAvailable: known(1, evidence("Only one seat left, sorry.")),
    });
    const result = evaluateOffer(brief, offer);
    expect(result.status).toBe("ineligible");
    expect(result.failures.some((failure) => failure.includes("seatsAvailable"))).toBe(true);
  });

  it("does not subtract an estimated discount from the group cost", () => {
    const offer = parseOfferOrThrow({
      ...completeEligibleOffer(),
      id: "offer-northside-estimated-discount",
      costItems: [
        {
          id: "cost-tuition",
          label: "Tuition per participant",
          appliesTo: "each-participant",
          kind: "charge",
          amount: known({ amountCents: 55_000, currency: "EUR" }, evidence("550 euros each.")),
        },
        {
          id: "cost-loyalty-discount",
          label: "Possible loyalty discount",
          appliesTo: "group",
          kind: "discount",
          amount: estimated(
            { amountCents: 10_000, currency: "EUR" },
            evidence("Might be around 100 euros off, not confirmed."),
          ),
        },
      ],
    });
    const cost = groupCost(brief, offer);
    expect(cost.total).toEqual({ amountCents: 110_000, currency: "EUR" });
    expect(cost.unconfirmedDiscounts).toEqual(["cost-loyalty-discount"]);
  });
});

describe("offers domain against the restaurant example brief (same functions, no code change)", () => {
  const brief = restaurant();

  it("evaluates and ranks a restaurant offer with the same evaluateOffer/groupCost/rankOffers", () => {
    const offer = parseOfferOrThrow({
      id: "offer-harborview-table",
      errandId: brief.id,
      providerId: "provider-harborview",
      queriedAt: "2026-09-29T11:00:00.000Z",
      seatsAvailable: known(4, evidence("We can seat a table of four.")),
      dates: known({ start: "2026-10-10", end: "2026-10-10" }, evidence("Saturday works.")),
      location: known("Downtown", evidence("We're downtown.")),
      costItems: [
        {
          id: "cost-per-cover",
          label: "Per-cover charge",
          appliesTo: "each-participant",
          kind: "charge",
          amount: known({ amountCents: 4_000, currency: "EUR" }, evidence("40 euros a head.")),
        },
      ],
      deposit: unknown(),
      cancellationPenalty: unknown(),
      extras: [],
      customFields: {
        tableCapacity: known(4, evidence("Table seats four comfortably.")),
      },
    });

    const evaluation = evaluateOffer(brief, offer);
    expect(evaluation).toEqual({ status: "eligible", failures: [], unknowns: [] });

    const cost = groupCost(brief, offer);
    expect(cost.total).toEqual({ amountCents: 16_000, currency: "EUR" });

    const ranked = rankOffers(brief, [offer]);
    expect(ranked[0]?.evaluation.status).toBe("eligible");
  });
});
