import type { ErrandBrief } from "../errands/brief.ts";
import { groupCost } from "../offers/cost.ts";
import { evaluateOffer } from "../offers/evaluation.ts";
import type { Offer } from "../offers/offer.ts";
import { type DateRange, rangeContains } from "../shared/dates.ts";
import { compareMoney, type Money } from "../shared/money.ts";
import type { StandingRules } from "./standing-rules.ts";

export interface QuotedCommit {
  readonly total: Money;
  readonly deposit: Money;
  readonly dates: DateRange;
}

export interface AuthorizeCommitInput {
  readonly brief: ErrandBrief;
  readonly rules: StandingRules;
  readonly offer: Offer;
  readonly quoted: QuotedCommit;
}

export type CommitDecision = "auto" | "needs_user" | "denied";

export interface AuthorizeCommitResult {
  readonly decision: CommitDecision;
  readonly reasons: readonly string[];
}

function formatMoney(amount: Money): string {
  return `${amount.amountCents} ${amount.currency}`;
}

function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountCents === b.amountCents;
}

function dateRangeEquals(a: DateRange, b: DateRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Denial reasons: unauthorized action, an ineligible offer, a quote that no longer
 * matches the offer or the group total, or a quoted amount outside the brief currency. */
function denialReasons(brief: ErrandBrief, offer: Offer, quoted: QuotedCommit): string[] {
  const reasons: string[] = [];

  if (!brief.authorizedActions.includes("book")) {
    reasons.push('brief.authorizedActions does not include "book"');
  }

  const evaluation = evaluateOffer(brief, offer);
  if (evaluation.status !== "eligible") {
    reasons.push(
      `offer is ${evaluation.status}, not eligible`,
      ...evaluation.failures,
      ...evaluation.unknowns,
    );
  }

  const knownTotal = groupCost(brief, offer).total;
  if (!moneyEquals(quoted.total, knownTotal)) {
    reasons.push(
      `quoted total ${formatMoney(quoted.total)} differs from the known total ${formatMoney(knownTotal)}; reconfirm the price`,
    );
  }

  if (offer.deposit.status !== "known") {
    reasons.push("offer deposit is not confirmed; reconfirm it before committing");
  } else if (!moneyEquals(quoted.deposit, offer.deposit.value)) {
    reasons.push(
      `quoted deposit ${formatMoney(quoted.deposit)} differs from the offer's known deposit ${formatMoney(offer.deposit.value)}`,
    );
  }

  if (offer.dates.status === "known" && !dateRangeEquals(quoted.dates, offer.dates.value)) {
    reasons.push(
      `quoted dates ${quoted.dates.start}..${quoted.dates.end} differ from the offer's known dates ${offer.dates.value.start}..${offer.dates.value.end}`,
    );
  }

  for (const [label, amount] of [
    ["total", quoted.total],
    ["deposit", quoted.deposit],
  ] as const) {
    if (amount.currency !== brief.spendLimits.currency) {
      reasons.push(
        `quoted ${label} currency "${amount.currency}" is not the brief currency "${brief.spendLimits.currency}"; never converted`,
      );
    }
  }

  return reasons;
}

/** A rule amount whose currency differs from the brief currency can never be compared. */
function currencyMismatchReason(
  field: string,
  ruleAmount: Money,
  briefCurrency: string,
): string | null {
  if (ruleAmount.currency === briefCurrency) return null;
  return `standing rule ${field} is in currency "${ruleAmount.currency}", different from the brief currency "${briefCurrency}"; cannot be compared`;
}

/** Reasons the quote does not (yet) qualify for auto-booking: an opt-out, or any standing
 * rule the quote does not fit, including one set in an incomparable currency. */
function needsUserReasons(
  brief: ErrandBrief,
  rules: StandingRules,
  offer: Offer,
  quoted: QuotedCommit,
): string[] {
  const reasons: string[] = [];

  if (!rules.autoBookWithinRules) {
    reasons.push("standing rules do not allow auto-booking");
  }

  if (rules.allowedWindows !== undefined) {
    const withinAWindow = rules.allowedWindows.some((window) =>
      rangeContains(window, quoted.dates),
    );
    if (!withinAWindow) {
      reasons.push(
        `quoted dates ${quoted.dates.start}..${quoted.dates.end} are outside every allowed standing-rule window`,
      );
    }
  }

  const briefCurrency = brief.spendLimits.currency;

  if (rules.maxTotal !== undefined) {
    const mismatch = currencyMismatchReason("maxTotal", rules.maxTotal, briefCurrency);
    if (mismatch) {
      reasons.push(mismatch);
    } else if (compareMoney(quoted.total, rules.maxTotal) === 1) {
      reasons.push(
        `quoted total ${formatMoney(quoted.total)} exceeds standing rule maxTotal ${formatMoney(rules.maxTotal)}`,
      );
    }
  }

  if (rules.maxDeposit !== undefined) {
    const mismatch = currencyMismatchReason("maxDeposit", rules.maxDeposit, briefCurrency);
    if (mismatch) {
      reasons.push(mismatch);
    } else if (compareMoney(quoted.deposit, rules.maxDeposit) === 1) {
      reasons.push(
        `quoted deposit ${formatMoney(quoted.deposit)} exceeds standing rule maxDeposit ${formatMoney(rules.maxDeposit)}`,
      );
    }
  }

  if (rules.maxCancellationPenalty !== undefined) {
    const mismatch = currencyMismatchReason(
      "maxCancellationPenalty",
      rules.maxCancellationPenalty,
      briefCurrency,
    );
    if (mismatch) {
      reasons.push(mismatch);
    } else if (offer.cancellationPenalty.status !== "known") {
      reasons.push(
        "offer cancellationPenalty is not known; cannot confirm it fits standing rule maxCancellationPenalty",
      );
    } else if (offer.cancellationPenalty.value.currency !== rules.maxCancellationPenalty.currency) {
      reasons.push(
        `offer cancellationPenalty currency "${offer.cancellationPenalty.value.currency}" does not match standing rule maxCancellationPenalty currency; cannot be compared`,
      );
    } else if (compareMoney(offer.cancellationPenalty.value, rules.maxCancellationPenalty) === 1) {
      reasons.push(
        `offer cancellationPenalty ${formatMoney(offer.cancellationPenalty.value)} exceeds standing rule maxCancellationPenalty ${formatMoney(rules.maxCancellationPenalty)}`,
      );
    }
  }

  return reasons;
}

/**
 * Decides whether a quoted commit may be booked automatically, needs the
 * user, or must be denied outright. Pure: no I/O, no clock, no side effects.
 * Denial reasons always win over needs-user reasons, and `auto` is only ever
 * returned with an empty `reasons` list.
 */
export function authorizeCommit(input: AuthorizeCommitInput): AuthorizeCommitResult {
  const { brief, rules, offer, quoted } = input;

  const denied = denialReasons(brief, offer, quoted);
  if (denied.length > 0) {
    return { decision: "denied", reasons: denied };
  }

  const needsUser = needsUserReasons(brief, rules, offer, quoted);
  return { decision: needsUser.length === 0 ? "auto" : "needs_user", reasons: needsUser };
}
