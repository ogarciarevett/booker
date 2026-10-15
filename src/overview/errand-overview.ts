import type { Booking, BookingStatus } from "../bookings/ledger.ts";
import { type Call, isCallOpen } from "../calls/call.ts";
import {
  DEFAULT_MAX_ATTEMPTS_PER_PROVIDER,
  DEFAULT_MAX_CONCURRENT,
  planCallRound,
} from "../calls/planning.ts";
import type { ErrandBrief } from "../errands/brief.ts";
import type { EvaluationStatus } from "../offers/evaluation.ts";
import type { Field } from "../offers/field.ts";
import type { Offer } from "../offers/offer.ts";
import { type RankedOffer, rankOffers } from "../offers/ranking.ts";
import type { Money } from "../shared/money.ts";

/**
 * Where an errand stands, read in this order: a booking that holds (`booked`, or `closed` once
 * enrolled); any call still open (`calling`); a quote to decide on (`waiting_for_you`); providers
 * still to call (`preparing`); otherwise nothing is left to do (`closed`).
 */
export type ErrandStage = "preparing" | "calling" | "waiting_for_you" | "booked" | "closed";

/**
 * Where one provider stands. `declined_by_provider` is the provider saying it cannot take the
 * errand, which today Booker only records as no seats available (`seatsAvailable` known 0);
 * `no_quote` is a call that ended with nothing recorded, which is also how a refusal the agent
 * did not record shows up. `ruled_out_by_rules` is a quote the errand's limits exclude.
 */
export type ProviderStatus =
  | "not_called"
  | "calling"
  | "quoted"
  | "declined_by_provider"
  | "ruled_out_by_rules"
  | "no_answer"
  | "no_quote"
  | "failed";

export interface OfferOverview {
  readonly evaluation: EvaluationStatus;
  readonly total: Money;
  /** The share of each participant when all pay the same, else `null`. */
  readonly perPerson: Money | null;
  /** Some amount in the total is only an estimate. */
  readonly estimated: boolean;
  readonly unknowns: readonly string[];
  readonly failures: readonly string[];
}

export interface ProviderOverview {
  readonly providerId: string;
  readonly name: string;
  readonly phoneE164: string;
  readonly status: ProviderStatus;
  /** Why it stands there, for anything but `not_called`, `calling`, and `quoted`. */
  readonly reasons: readonly string[];
  /** The provider's own words behind a decline, when recorded. */
  readonly quote?: string;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** No call open and attempts left under the cap. */
  readonly canRetry: boolean;
  readonly lastCallId: string | null;
  readonly offer: OfferOverview | null;
}

export interface RankedOfferOverview {
  readonly providerId: string;
  readonly name: string;
  readonly evaluation: EvaluationStatus;
  readonly total: Money;
  readonly estimated: boolean;
  readonly unknownCount: number;
}

export type CommitState =
  | { readonly state: "none" }
  | {
      readonly state: "grant_active";
      /** `null` when the grant's offer is not among the errand's offers. */
      readonly providerId: string | null;
      readonly grantExpiresAt: string;
    }
  | {
      readonly state: "booked";
      readonly providerId: string;
      readonly bookingStatus: BookingStatus;
    }
  | { readonly state: "enrolled"; readonly providerId: string };

export interface MissingToClose {
  /** Who `planCallRound` would call now, among providers without an outcome yet. */
  readonly providersToCall: readonly { readonly providerId: string; readonly name: string }[];
  /** The best quote that is not ruled out, and what it still lacks. */
  readonly leadingProviderId: string | null;
  readonly unknownFields: readonly string[];
  readonly writtenConfirmation: "not_required" | "pending" | "received";
  readonly commit: CommitState;
}

export interface ProviderCounts {
  readonly notCalled: number;
  readonly calling: number;
  readonly quoted: number;
  readonly declined: number;
  readonly ruledOut: number;
  readonly noAnswer: number;
  readonly noQuote: number;
  readonly failed: number;
  /** Providers that can still be called: not called yet, or retryable without an outcome. */
  readonly pending: number;
}

export interface ErrandOverview {
  readonly errandId: string;
  readonly kind: string;
  readonly objective: string;
  readonly stage: ErrandStage;
  readonly providers: readonly ProviderOverview[];
  readonly counts: ProviderCounts;
  /** Providers with a final outcome, out of all of them. */
  readonly progress: { readonly done: number; readonly total: number };
  readonly ranking: readonly RankedOfferOverview[];
  readonly missing: MissingToClose;
  readonly lastActivityAt: string | null;
}

export interface ErrandOverviewInput {
  readonly brief: ErrandBrief;
  readonly calls: readonly Call[];
  /** The latest offer per provider (the draft its calls wrote). */
  readonly offers: readonly Offer[];
  /** The errand's open (not cancelled) booking. */
  readonly booking: Booking | undefined;
  /** The errand's active commit grant and the provider it is for, when that can be told. */
  readonly activeGrant:
    | { readonly providerId: string | null; readonly expiresAt: string }
    | undefined;
  readonly now: string;
  readonly maxConcurrent?: number;
  readonly maxAttemptsPerProvider?: number;
}

/** Statuses that are an outcome: the provider needs no further call. */
const SETTLED: ReadonlySet<ProviderStatus> = new Set([
  "quoted",
  "declined_by_provider",
  "ruled_out_by_rules",
]);

function hasRecordedData(offer: Offer): boolean {
  const recorded = (field: Field<unknown>) => field.status !== "unknown";
  return (
    recorded(offer.seatsAvailable) ||
    recorded(offer.dates) ||
    recorded(offer.location) ||
    recorded(offer.deposit) ||
    recorded(offer.cancellationPenalty) ||
    offer.costItems.length > 0 ||
    offer.extras.length > 0 ||
    Object.values(offer.customFields).some(recorded)
  );
}

function perPerson(ranked: RankedOffer): Money | null {
  const shares = Object.values(ranked.cost.perParticipant);
  const [first] = shares;
  if (first === undefined) return null;
  return shares.every((share) => share.amountCents === first.amountCents) ? first : null;
}

function offerOverview(ranked: RankedOffer): OfferOverview {
  return {
    evaluation: ranked.evaluation.status,
    total: ranked.cost.total,
    perPerson: perPerson(ranked),
    estimated: ranked.cost.estimated,
    unknowns: ranked.evaluation.unknowns,
    failures: ranked.evaluation.failures,
  };
}

function latest(calls: readonly Call[]): Call | undefined {
  return calls.reduce<Call | undefined>(
    (newest, call) =>
      newest === undefined ||
      call.attempt > newest.attempt ||
      (call.attempt === newest.attempt && call.createdAt > newest.createdAt)
        ? call
        : newest,
    undefined,
  );
}

interface ProviderState {
  readonly status: ProviderStatus;
  readonly reasons: readonly string[];
  readonly quote?: string;
}

function providerState(
  calls: readonly Call[],
  ranked: RankedOffer | undefined,
  maxAttempts: number,
): ProviderState {
  if (calls.some(isCallOpen)) return { status: "calling", reasons: [] };
  if (ranked !== undefined && hasRecordedData(ranked.offer)) {
    const seats = ranked.offer.seatsAvailable;
    if (seats.status === "known" && seats.value === 0) {
      return {
        status: "declined_by_provider",
        reasons: ["No seats available"],
        quote: seats.evidence.quote,
      };
    }
    if (ranked.evaluation.status === "ineligible") {
      return { status: "ruled_out_by_rules", reasons: ranked.evaluation.failures };
    }
    return { status: "quoted", reasons: [] };
  }
  const last = latest(calls);
  if (last === undefined) return { status: "not_called", reasons: [] };
  switch (last.status) {
    case "no_answer":
      return {
        status: "no_answer",
        reasons: [
          calls.length < maxAttempts
            ? `No answer (attempt ${calls.length} of ${maxAttempts})`
            : `No answer after ${calls.length} attempts`,
        ],
      };
    case "completed":
      return { status: "no_quote", reasons: ["The call ended without a quote"] };
    case "cancelled":
      return { status: "failed", reasons: ["The call was cancelled"] };
    default:
      return { status: "failed", reasons: ["The call failed"] };
  }
}

function commitState(input: ErrandOverviewInput): CommitState {
  const { booking, activeGrant } = input;
  if (booking !== undefined) {
    return booking.status === "enrolled"
      ? { state: "enrolled", providerId: booking.providerId }
      : { state: "booked", providerId: booking.providerId, bookingStatus: booking.status };
  }
  if (activeGrant !== undefined) {
    return {
      state: "grant_active",
      providerId: activeGrant.providerId,
      grantExpiresAt: activeGrant.expiresAt,
    };
  }
  return { state: "none" };
}

function writtenConfirmation(input: ErrandOverviewInput): MissingToClose["writtenConfirmation"] {
  if (!input.brief.completion.requiresWrittenConfirmation) return "not_required";
  const status = input.booking?.status;
  return status === "written" || status === "enrolled" ? "received" : "pending";
}

function lastActivity(input: ErrandOverviewInput): string | null {
  const instants = [
    ...input.calls.flatMap((call) => [
      call.createdAt,
      ...(call.endedAt === null ? [] : [call.endedAt]),
    ]),
    ...(input.booking?.history.map((entry) => entry.at) ?? []),
  ];
  return instants.reduce<string | null>(
    (newest, at) => (newest === null || at > newest ? at : newest),
    null,
  );
}

/**
 * One errand at a glance, derived only from what Booker stores and the domain's own functions:
 * `planCallRound` for who is left to call under the caps, `rankOffers` (which runs
 * `evaluateOffer` and `groupCost`) for each quote and the ranking, and the booking ledger and
 * commit grant for what remains to close. Nothing here decides or changes anything.
 */
export function errandOverview(input: ErrandOverviewInput): ErrandOverview {
  const { brief } = input;
  const maxAttempts = input.maxAttemptsPerProvider ?? DEFAULT_MAX_ATTEMPTS_PER_PROVIDER;
  const providerNames = new Map(brief.providers.map((provider) => [provider.id, provider.name]));
  const ranked = rankOffers(
    brief,
    input.offers.filter((offer) => providerNames.has(offer.providerId)),
  );
  const rankedByProvider = new Map(ranked.map((entry) => [entry.offer.providerId, entry]));

  const providers: ProviderOverview[] = brief.providers.map((provider) => {
    const calls = input.calls.filter((call) => call.providerId === provider.id);
    const rankedOffer = rankedByProvider.get(provider.id);
    const state = providerState(calls, rankedOffer, maxAttempts);
    return {
      providerId: provider.id,
      name: provider.name,
      phoneE164: provider.phoneE164,
      status: state.status,
      reasons: state.reasons,
      ...(state.quote === undefined ? {} : { quote: state.quote }),
      attempts: calls.length,
      maxAttempts,
      canRetry: !calls.some(isCallOpen) && calls.length < maxAttempts,
      lastCallId: latest(calls)?.id ?? null,
      offer:
        rankedOffer === undefined || !hasRecordedData(rankedOffer.offer)
          ? null
          : offerOverview(rankedOffer),
    };
  });

  const count = (status: ProviderStatus) =>
    providers.filter((provider) => provider.status === status).length;
  const unresolved = (provider: ProviderOverview) =>
    !SETTLED.has(provider.status) && provider.status !== "calling";
  const pending = providers.filter((provider) => unresolved(provider) && provider.canRetry);
  // No outcome, and no attempts left: nothing more will come from this provider.
  const exhausted = (provider: ProviderOverview) => unresolved(provider) && !provider.canRetry;
  const counts: ProviderCounts = {
    notCalled: count("not_called"),
    calling: count("calling"),
    quoted: count("quoted"),
    declined: count("declined_by_provider"),
    ruledOut: count("ruled_out_by_rules"),
    noAnswer: count("no_answer"),
    noQuote: count("no_quote"),
    failed: count("failed"),
    pending: pending.length,
  };

  const callable = new Set(
    planCallRound({
      brief,
      calls: input.calls,
      maxConcurrent: input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      maxAttemptsPerProvider: maxAttempts,
    }),
  );
  const providersToCall = providers
    .filter((provider) => callable.has(provider.providerId) && unresolved(provider))
    .map((provider) => ({ providerId: provider.providerId, name: provider.name }));

  const rankedRows = ranked.filter((entry) => hasRecordedData(entry.offer));
  const statusOf = new Map(providers.map((provider) => [provider.providerId, provider.status]));
  // The best quote still in the running: ranked first among those not ruled out or declined.
  const leading = rankedRows.find((entry) => statusOf.get(entry.offer.providerId) === "quoted");

  const commit = commitState(input);
  let stage: ErrandStage;
  if (commit.state === "enrolled") stage = "closed";
  else if (commit.state === "booked") stage = "booked";
  else if (counts.calling > 0) stage = "calling";
  else if (counts.quoted > 0) stage = "waiting_for_you";
  else if (pending.length > 0) stage = "preparing";
  else stage = "closed";

  return {
    errandId: brief.id,
    kind: brief.kind,
    objective: brief.objective,
    stage,
    providers,
    counts,
    progress: {
      done: providers.filter((provider) => SETTLED.has(provider.status) || exhausted(provider))
        .length,
      total: providers.length,
    },
    ranking: rankedRows.map((entry) => ({
      providerId: entry.offer.providerId,
      name: providerNames.get(entry.offer.providerId) ?? entry.offer.providerId,
      evaluation: entry.evaluation.status,
      total: entry.cost.total,
      estimated: entry.cost.estimated,
      unknownCount: entry.evaluation.unknowns.length,
    })),
    missing: {
      providersToCall,
      leadingProviderId: leading?.offer.providerId ?? null,
      unknownFields: leading?.evaluation.unknowns ?? [],
      writtenConfirmation: writtenConfirmation(input),
      commit,
    },
    lastActivityAt: lastActivity(input),
  };
}
