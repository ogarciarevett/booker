import type { ErrandBrief } from "../errands/brief.ts";
import { compareMoney, type Money, multiplyMoney } from "../shared/money.ts";
import type { GroupCostResult } from "./cost.ts";
import { groupCost } from "./cost.ts";
import { type EvaluationResult, type EvaluationStatus, evaluateOffer } from "./evaluation.ts";
import type { Field } from "./field.ts";
import type { Offer } from "./offer.ts";

export interface RankedOffer {
  readonly offer: Offer;
  readonly evaluation: EvaluationResult;
  readonly cost: GroupCostResult;
}

const STATUS_RANK: Readonly<Record<EvaluationStatus, number>> = {
  eligible: 0,
  incomplete: 1,
  ineligible: 2,
};

/**
 * Ranks offers eligible first (ascending total), then incomplete (ascending
 * partial total), then ineligible; ties break by providerId then offer id
 * so the order is fully deterministic.
 */
/** Locale-independent string order, so rankings are identical on every machine. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function rankOffers(brief: ErrandBrief, offers: readonly Offer[]): RankedOffer[] {
  const ranked: RankedOffer[] = offers.map((offer) => ({
    offer,
    evaluation: evaluateOffer(brief, offer),
    cost: groupCost(brief, offer),
  }));

  return ranked.sort((a, b) => {
    const statusDiff = STATUS_RANK[a.evaluation.status] - STATUS_RANK[b.evaluation.status];
    if (statusDiff !== 0) return statusDiff;
    const totalDiff = compareMoney(a.cost.total, b.cost.total);
    if (totalDiff !== 0) return totalDiff;
    const providerDiff = compareCodeUnits(a.offer.providerId, b.offer.providerId);
    if (providerDiff !== 0) return providerDiff;
    return compareCodeUnits(a.offer.id, b.offer.id);
  });
}

export interface ExtrasScenarioResult {
  readonly offerId: string;
  readonly providerId: string;
  readonly unitPrice: Field<Money> | undefined;
  readonly cost: Money | null;
}

/**
 * Prices `quantity` units of an extra (by id) on each offer. The cost is
 * `null` when the offer has no such extra, or its unit price is not known
 * or estimated.
 */
export function extrasScenario(
  offers: readonly Offer[],
  extraId: string,
  quantity: number,
): ExtrasScenarioResult[] {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new RangeError(`extras quantity must be a non-negative integer, got ${quantity}`);
  }
  return offers.map((offer) => {
    const extra = offer.extras.find((candidate) => candidate.id === extraId);
    const unitPrice = extra?.unitPrice;
    const cost =
      unitPrice !== undefined && unitPrice.status !== "unknown"
        ? multiplyMoney(unitPrice.value, quantity)
        : null;
    return { offerId: offer.id, providerId: offer.providerId, unitPrice, cost };
  });
}
