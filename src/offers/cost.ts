import type { ErrandBrief } from "../errands/brief.ts";
import { type Money, money } from "../shared/money.ts";
import type { Offer } from "./offer.ts";

export interface GroupCostResult {
  readonly total: Money;
  readonly perParticipant: Readonly<Record<string, Money>>;
  readonly estimated: boolean;
  readonly missing: readonly string[];
  readonly unconfirmedDiscounts: readonly string[];
  readonly issues: readonly string[];
}

/**
 * Splits an integer amount into `parts` integer shares that sum exactly to
 * `amount`, using the largest-remainder method. Every share is equal (an
 * even split has no fractional differences to rank), so leftover cents go to
 * the first participants in order — deterministic and reproducible.
 */
function splitEvenly(amountCents: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.trunc(amountCents / parts);
  const remainder = amountCents - base * parts;
  const shares = new Array<number>(parts).fill(base);
  const step = remainder >= 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(remainder); i++) {
    const index = i % parts;
    shares[index] = (shares[index] ?? 0) + step;
  }
  return shares;
}

/**
 * Computes the group cost of an offer for a brief. Charges count when known
 * or estimated; discounts count only when known. `each-participant` and
 * `{ participantIds }` items are charged individually to those participants;
 * `group` items are shared and split with the largest-remainder method so
 * `perParticipant` sums exactly to `total`. An amount in the wrong currency
 * is never converted: it is excluded and reported in `issues`.
 */
export function groupCost(brief: ErrandBrief, offer: Offer): GroupCostResult {
  const currency = brief.spendLimits.currency;
  const participantIds = brief.participants.map((participant) => participant.id);
  const participantIdSet = new Set(participantIds);

  let estimatedFlag = false;
  const missing: string[] = [];
  const unconfirmedDiscounts: string[] = [];
  const issues: string[] = [];
  const individualCents = new Map<string, number>(participantIds.map((id) => [id, 0]));
  let sharedCents = 0;

  for (const item of offer.costItems) {
    if (item.amount.status === "unknown") {
      if (item.kind === "charge") missing.push(item.id);
      else unconfirmedDiscounts.push(item.id);
      continue;
    }

    if (item.amount.value.currency !== currency) {
      issues.push(
        `costItems.${item.id}: amount currency "${item.amount.value.currency}" does not match spendLimits.currency "${currency}"`,
      );
      continue;
    }

    if (item.kind === "discount" && item.amount.status === "estimated") {
      unconfirmedDiscounts.push(item.id);
      continue;
    }

    if (item.amount.status === "estimated") estimatedFlag = true;

    const sign = item.kind === "charge" ? 1 : -1;
    const cents = item.amount.value.amountCents * sign;

    if (item.appliesTo === "group") {
      sharedCents += cents;
      continue;
    }

    const listedIds =
      item.appliesTo === "each-participant" ? participantIds : item.appliesTo.participantIds;
    const targetIds = [...new Set(listedIds)];
    if (targetIds.length !== listedIds.length) {
      issues.push(`costItems.${item.id}: a participant is listed more than once; charged once`);
    }
    for (const participantId of targetIds) {
      if (!participantIdSet.has(participantId)) {
        issues.push(`costItems.${item.id}: participant "${participantId}" is not in the brief`);
        continue;
      }
      individualCents.set(participantId, (individualCents.get(participantId) ?? 0) + cents);
    }
  }

  const sharedSplit = splitEvenly(sharedCents, participantIds.length);
  participantIds.forEach((id, index) => {
    const share = sharedSplit[index] ?? 0;
    individualCents.set(id, (individualCents.get(id) ?? 0) + share);
  });

  const perParticipant: Record<string, Money> = {};
  let totalCents = 0;
  for (const id of participantIds) {
    const cents = individualCents.get(id) ?? 0;
    perParticipant[id] = money(cents, currency);
    totalCents += cents;
  }
  // Without participants nothing can absorb the shared costs, but they still belong in the total.
  if (participantIds.length === 0) {
    totalCents += sharedCents;
    if (sharedCents !== 0) issues.push("no participants: shared costs are not split per person");
  }

  return {
    total: money(totalCents, currency),
    perParticipant,
    estimated: estimatedFlag,
    missing,
    unconfirmedDiscounts,
    issues,
  };
}
