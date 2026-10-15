import type { ErrandBrief } from "../errands/brief.ts";
import { expandRange, rangeContains } from "../shared/dates.ts";
import { compareMoney, type Money } from "../shared/money.ts";
import { groupCost } from "./cost.ts";
import { type Field, unknown } from "./field.ts";
import type { Offer } from "./offer.ts";

export type EvaluationStatus = "eligible" | "ineligible" | "incomplete";

export interface EvaluationResult {
  readonly status: EvaluationStatus;
  readonly failures: readonly string[];
  readonly unknowns: readonly string[];
}

type HardRequirement = ErrandBrief["hardRequirements"][number];
type HardRequirementRule = HardRequirement["rule"];
type AttributeValue = string | number | boolean;

function formatMoney(amount: Money): string {
  return `${amount.amountCents} ${amount.currency}`;
}

function requirementSatisfied(rule: HardRequirementRule, value: AttributeValue): boolean {
  switch (rule.op) {
    case "equals":
      return value === rule.value;
    case "oneOf":
      return rule.values.includes(value);
    case "atLeast":
      return typeof value === "number" && value >= rule.value;
    case "atMost":
      return typeof value === "number" && value <= rule.value;
  }
}

/**
 * Only a `known` field may pass a check; `estimated` and `unknown` fields
 * always go to `unknowns` instead, never to a pass or a failure.
 */
function checkKnownOnly<T>(
  field: Field<T>,
  label: string,
  passes: (value: T) => boolean,
  failureMessage: (value: T) => string,
  failures: string[],
  unknowns: string[],
): void {
  if (field.status === "unknown") {
    unknowns.push(`${label}: unknown`);
    return;
  }
  if (field.status === "estimated") {
    unknowns.push(`${label}: estimated`);
    return;
  }
  if (!passes(field.value)) {
    failures.push(failureMessage(field.value));
  }
}

/**
 * A single monetary limit check. Only a known value above the limit is a
 * failure; an estimate above the limit still needs confirmation, because the
 * confirmed amount may turn out lower.
 */
function checkMoneyLimit(
  field: Field<Money>,
  limit: Money | undefined,
  label: string,
  failures: string[],
  unknowns: string[],
): void {
  if (!limit) return;
  if (field.status === "unknown") {
    unknowns.push(`${label}: unknown`);
    return;
  }
  if (field.value.currency !== limit.currency) {
    unknowns.push(
      `${label}: currency "${field.value.currency}" does not match limit currency "${limit.currency}"`,
    );
    return;
  }
  const overLimit = compareMoney(field.value, limit) === 1;
  if (field.status === "estimated") {
    unknowns.push(
      overLimit
        ? `${label}: estimated ${formatMoney(field.value)} exceeds limit ${formatMoney(limit)}; needs confirmation`
        : `${label}: estimated`,
    );
    return;
  }
  if (overLimit) {
    failures.push(`${label} ${formatMoney(field.value)} exceeds limit ${formatMoney(limit)}`);
  }
}

/** The same offer with every estimated cost amount treated as unknown. */
function confirmedCostsOnly(offer: Offer): Offer {
  return {
    ...offer,
    costItems: offer.costItems.map((item) =>
      item.amount.status === "estimated" ? { ...item, amount: unknown() } : item,
    ),
  };
}

interface BudgetContext {
  /** True when no unconfirmed discount or excluded amount could still lower the cost. */
  readonly canOnlyGrow: boolean;
  /** True when the expected cost relies on estimates or misses items. */
  readonly incomplete: boolean;
}

/**
 * Checks one budget figure. It fails only when confirmed charges already
 * exceed the limit and nothing pending could lower them; an estimate above
 * the limit, or a pending discount, leaves the check open.
 */
function checkBudget(
  label: string,
  confirmedAmount: Money,
  expectedAmount: Money,
  limit: Money,
  context: BudgetContext,
  failures: string[],
  unknowns: string[],
): void {
  if (compareMoney(confirmedAmount, limit) === 1) {
    if (context.canOnlyGrow) {
      failures.push(`${label} ${formatMoney(confirmedAmount)} exceeds limit ${formatMoney(limit)}`);
    } else {
      unknowns.push(
        `${label}: confirmed ${formatMoney(confirmedAmount)} exceeds limit ${formatMoney(limit)} unless an unconfirmed discount applies`,
      );
    }
    return;
  }
  if (compareMoney(expectedAmount, limit) === 1) {
    unknowns.push(
      `${label}: estimated ${formatMoney(expectedAmount)} exceeds limit ${formatMoney(limit)}; needs confirmation`,
    );
    return;
  }
  if (context.incomplete) unknowns.push(`${label}: cost is not fully confirmed`);
}

/**
 * Evaluates an offer against a brief. Every check requires a `known` value
 * to pass; `estimated` or `unknown` inputs move the offer to `incomplete`.
 * A budget check fails only on confirmed amounts that nothing pending could
 * lower (see `checkBudget`). Any failure makes the offer `ineligible`;
 * otherwise any unknown makes it `incomplete`.
 */
export function evaluateOffer(brief: ErrandBrief, offer: Offer): EvaluationResult {
  const failures: string[] = [];
  const unknowns: string[] = [];

  const participantCount = brief.participants.length;
  const minSeats = brief.groupPolicy.allowPartialBooking ? 1 : participantCount;
  checkKnownOnly(
    offer.seatsAvailable,
    "seatsAvailable",
    (seats) => seats >= minSeats,
    (seats) => `seatsAvailable ${seats} is fewer than required ${minSeats}`,
    failures,
    unknowns,
  );

  const expandedWindow = expandRange(brief.dates.window, brief.dates.flexibilityDays);
  checkKnownOnly(
    offer.dates,
    "dates",
    (range) => rangeContains(expandedWindow, range),
    (range) =>
      `dates ${range.start}..${range.end} is outside the brief window ${expandedWindow.start}..${expandedWindow.end}`,
    failures,
    unknowns,
  );

  const acceptableLocations = [brief.location.area, ...brief.location.acceptableAlternatives].map(
    (location) => location.trim().toLowerCase(),
  );
  checkKnownOnly(
    offer.location,
    "location",
    (location) => acceptableLocations.includes(location.trim().toLowerCase()),
    (location) => `location "${location}" is not the brief area or an acceptable alternative`,
    failures,
    unknowns,
  );

  for (const requirement of brief.hardRequirements) {
    const field = offer.customFields[requirement.field];
    if (field === undefined) {
      unknowns.push(`hardRequirements.${requirement.id}: unknown`);
      continue;
    }
    checkKnownOnly(
      field,
      `hardRequirements.${requirement.id}`,
      (value) => requirementSatisfied(requirement.rule, value),
      () => `hardRequirements.${requirement.id}: ${requirement.description}`,
      failures,
      unknowns,
    );
  }

  const expected = groupCost(brief, offer);
  const confirmed = groupCost(brief, confirmedCostsOnly(offer));
  const context: BudgetContext = {
    canOnlyGrow: confirmed.unconfirmedDiscounts.length === 0 && confirmed.issues.length === 0,
    incomplete:
      expected.estimated ||
      expected.missing.length > 0 ||
      expected.unconfirmedDiscounts.length > 0 ||
      expected.issues.length > 0,
  };

  const { totalMax, perParticipantMax, depositMax, cancellationPenaltyMax } = brief.spendLimits;

  if (totalMax) {
    checkBudget("total", confirmed.total, expected.total, totalMax, context, failures, unknowns);
  }

  if (perParticipantMax) {
    for (const participant of brief.participants) {
      const confirmedAmount = confirmed.perParticipant[participant.id];
      const expectedAmount = expected.perParticipant[participant.id];
      if (!confirmedAmount || !expectedAmount) continue;
      checkBudget(
        `perParticipant.${participant.id}`,
        confirmedAmount,
        expectedAmount,
        perParticipantMax,
        context,
        failures,
        unknowns,
      );
    }
  }

  checkMoneyLimit(offer.deposit, depositMax, "deposit", failures, unknowns);
  checkMoneyLimit(
    offer.cancellationPenalty,
    cancellationPenaltyMax,
    "cancellationPenalty",
    failures,
    unknowns,
  );

  const status: EvaluationStatus =
    failures.length > 0 ? "ineligible" : unknowns.length > 0 ? "incomplete" : "eligible";
  return { status, failures, unknowns };
}
