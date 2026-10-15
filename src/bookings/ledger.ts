import type { ErrandBrief } from "../errands/brief.ts";
import type { Offer } from "../offers/offer.ts";
import { toCanonicalInstant } from "../shared/instants.ts";

export type BookingStatus = "verbal" | "written" | "enrolled" | "cancelled";

/** Statuses that move strictly forward; "cancelled" is reachable from any of them. */
const FORWARD_STATUSES: readonly BookingStatus[] = ["verbal", "written", "enrolled"];

export interface BookingHistoryEntry {
  readonly status: BookingStatus;
  readonly at: string;
}

export interface Booking {
  readonly id: string;
  readonly errandId: string;
  readonly offerId: string;
  readonly providerId: string;
  readonly participantIds: readonly string[];
  readonly status: BookingStatus;
  readonly history: readonly BookingHistoryEntry[];
}

export interface CreateBookingInput {
  readonly brief: ErrandBrief;
  readonly offer: Offer;
  readonly participantIds: readonly string[];
  readonly id: string;
  readonly now: string;
}

export type CreateBookingReason =
  | "offer_errand_mismatch"
  | "duplicate_participant"
  | "unknown_participant"
  | "empty_group"
  | "partial_group_not_allowed";

export type CreateBookingResult =
  | { readonly ok: true; readonly booking: Booking }
  | { readonly ok: false; readonly reason: CreateBookingReason };

/**
 * Creates a verbal booking for `participantIds` against `offer`. Rejects an
 * offer that belongs to a different errand, a duplicate or unknown
 * participant id, an empty group, and a partial group unless
 * `brief.groupPolicy.allowPartialBooking`. History times are canonical UTC instants.
 */
export function createBooking(input: CreateBookingInput): CreateBookingResult {
  const { brief, offer, participantIds, id } = input;
  const now = toCanonicalInstant(input.now);

  if (offer.errandId !== brief.id) {
    return { ok: false, reason: "offer_errand_mismatch" };
  }

  const seen = new Set<string>();
  for (const participantId of participantIds) {
    if (seen.has(participantId)) {
      return { ok: false, reason: "duplicate_participant" };
    }
    seen.add(participantId);
  }

  const briefParticipantIds = new Set(brief.participants.map((participant) => participant.id));
  for (const participantId of participantIds) {
    if (!briefParticipantIds.has(participantId)) {
      return { ok: false, reason: "unknown_participant" };
    }
  }

  if (seen.size === 0) {
    return { ok: false, reason: "empty_group" };
  }

  if (!brief.groupPolicy.allowPartialBooking && seen.size !== briefParticipantIds.size) {
    return { ok: false, reason: "partial_group_not_allowed" };
  }

  return {
    ok: true,
    booking: {
      id,
      errandId: brief.id,
      offerId: offer.id,
      providerId: offer.providerId,
      participantIds: [...participantIds],
      status: "verbal",
      history: [{ status: "verbal", at: now }],
    },
  };
}

export type AdvanceBookingResult =
  | { readonly ok: true; readonly booking: Booking }
  | { readonly ok: false };

/**
 * True when `next` is a legal move from `current`: strictly forward through
 * verbal → written → enrolled (skipping allowed), or "cancelled" from any
 * non-cancelled status. Never true from "cancelled", never a no-op move.
 */
function canAdvance(current: BookingStatus, next: BookingStatus): boolean {
  if (current === "cancelled") return false;
  if (next === "cancelled") return true;
  const currentRank = FORWARD_STATUSES.indexOf(current);
  const nextRank = FORWARD_STATUSES.indexOf(next);
  return nextRank > currentRank;
}

/**
 * Advances `booking` to `status`, appending a history entry. Forward-only;
 * see `canAdvance`. `now` is canonicalized before the transition is checked,
 * so a malformed or offset-less `now` always throws a `RangeError`, even for
 * an invalid transition that would otherwise return `{ ok: false }`.
 */
export function advanceBooking(
  booking: Booking,
  status: BookingStatus,
  now: string,
): AdvanceBookingResult {
  const canonicalNow = toCanonicalInstant(now);
  if (!canAdvance(booking.status, status)) {
    return { ok: false };
  }
  return {
    ok: true,
    booking: {
      ...booking,
      status,
      history: [...booking.history, { status, at: canonicalNow }],
    },
  };
}

export type CreateBookingStoreResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "open_booking_exists" | "duplicate_booking_id" };

export type AdvanceBookingStoreResult =
  | { readonly ok: true; readonly booking: Booking }
  | { readonly ok: false; readonly reason: "not_found" | "invalid_transition" };

/**
 * Port for persisting the booking ledger. `create` rejects a second
 * non-cancelled booking for the same errand, and a booking id that already
 * exists for any errand; `advance` applies the same forward-only rule as
 * `advanceBooking` and reports which reason it failed for ("not_found" when
 * `bookingId` does not exist). Every stored or returned `Booking` is an
 * independent copy: mutating one never changes another caller's copy or the
 * stored state.
 */
export interface BookingStore {
  create(booking: Booking): Promise<CreateBookingStoreResult>;
  advance(
    bookingId: string,
    status: BookingStatus,
    now: string,
  ): Promise<AdvanceBookingStoreResult>;
  findOpen(errandId: string): Promise<Booking | undefined>;
  /**
   * The `limit` most recent bookings, cancelled ones included: newest first by when each was made
   * (its first history entry), ties by id. Throws a RangeError unless `limit` is a positive whole
   * number.
   */
  listRecent(limit: number): Promise<Booking[]>;
}

/** When a booking was made: the time of its first history entry. */
function madeAt(booking: Booking): string {
  return booking.history[0]?.at ?? "";
}

/** Newest first by when each booking was made, ties by id; for `BookingStore.listRecent`. */
export function newestBookingsFirst(bookings: readonly Booking[], limit: number): Booking[] {
  return [...bookings]
    .sort((a, b) =>
      madeAt(a) === madeAt(b) ? a.id.localeCompare(b.id) : madeAt(b).localeCompare(madeAt(a)),
    )
    .slice(0, limit);
}
