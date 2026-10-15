import { randomBytes, randomUUID } from "node:crypto";
import { toCanonicalInstant } from "../../shared/instants.ts";
import { requireListLimit } from "../../shared/listing.ts";
import type {
  AcquireGrantInput,
  AcquireGrantResult,
  CommitGrant,
  CommitGrantStore,
  ConsumeGrantResult,
  IdGenerator,
} from "../commit-grant.ts";
import { isGrantActive, newGrant } from "../commit-grant.ts";
import type {
  AdvanceBookingStoreResult,
  Booking,
  BookingStatus,
  BookingStore,
  CreateBookingStoreResult,
} from "../ledger.ts";
import { advanceBooking, newestBookingsFirst } from "../ledger.ts";

export interface InMemoryCommitGrantStoreOptions {
  readonly generateId?: IdGenerator;
  readonly generateToken?: IdGenerator;
}

/**
 * In-memory `CommitGrantStore`, useful for tests and the shared contract
 * suite. Not safe across processes; the SQLite adapter is the durable one.
 * Every stored or returned `CommitGrant` is an independent `structuredClone`,
 * so mutating one never changes another caller's copy or the stored state.
 */
export class InMemoryCommitGrantStore implements CommitGrantStore {
  private readonly grants: CommitGrant[] = [];
  private readonly generateId: IdGenerator;
  private readonly generateToken: IdGenerator;

  constructor(options: InMemoryCommitGrantStoreOptions = {}) {
    this.generateId = options.generateId ?? (() => randomUUID());
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
  }

  /** Marks every stored grant past its expiry as "expired", in place. */
  private expireStale(now: string): void {
    for (const [index, grant] of this.grants.entries()) {
      if (grant.status === "active" && !isGrantActive(grant, now)) {
        this.grants[index] = { ...grant, status: "expired" };
      }
    }
  }

  async acquire(input: AcquireGrantInput): Promise<AcquireGrantResult> {
    const now = toCanonicalInstant(input.now);
    this.expireStale(now);
    const hasActive = this.grants.some(
      (grant) => grant.errandId === input.errandId && grant.status === "active",
    );
    if (hasActive) {
      return { granted: false, reason: "another_active_grant" };
    }
    const grant = newGrant({
      id: this.generateId(),
      errandId: input.errandId,
      offerId: input.offerId,
      token: this.generateToken(),
      now,
      ttlSeconds: input.ttlSeconds,
    });
    this.grants.push(structuredClone(grant));
    return { granted: true, grant: structuredClone(grant) };
  }

  async consume(token: string, now: string): Promise<ConsumeGrantResult> {
    const canonicalNow = toCanonicalInstant(now);
    this.expireStale(canonicalNow);
    const index = this.grants.findIndex((grant) => grant.token === token);
    const grant = this.grants[index];
    if (grant === undefined) return { ok: false, reason: "unknown_token" };
    if (grant.status === "expired") return { ok: false, reason: "expired" };
    if (grant.status !== "active") return { ok: false, reason: "not_active" };
    const consumed: CommitGrant = { ...grant, status: "consumed" };
    this.grants[index] = structuredClone(consumed);
    return { ok: true, grant: structuredClone(consumed) };
  }

  async revokeAll(errandId: string, now: string): Promise<number> {
    const canonicalNow = toCanonicalInstant(now);
    this.expireStale(canonicalNow);
    let revokedCount = 0;
    for (const [index, grant] of this.grants.entries()) {
      if (grant.errandId === errandId && grant.status === "active") {
        this.grants[index] = { ...grant, status: "revoked" };
        revokedCount += 1;
      }
    }
    return revokedCount;
  }

  async findActive(errandId: string, now: string): Promise<CommitGrant | undefined> {
    const canonicalNow = toCanonicalInstant(now);
    this.expireStale(canonicalNow);
    const found = this.grants.find(
      (grant) => grant.errandId === errandId && grant.status === "active",
    );
    return found === undefined ? undefined : structuredClone(found);
  }
}

/**
 * In-memory `BookingStore`, useful for tests and the shared contract suite.
 * Not safe across processes; the SQLite adapter is the durable one. Every
 * stored or returned `Booking` is an independent `structuredClone`, so
 * mutating one never changes another caller's copy or the stored state.
 */
export class InMemoryBookingStore implements BookingStore {
  private readonly bookings: Booking[] = [];

  async create(booking: Booking): Promise<CreateBookingStoreResult> {
    const isDuplicateId = this.bookings.some((existing) => existing.id === booking.id);
    if (isDuplicateId) return { ok: false, reason: "duplicate_booking_id" };
    const hasOpen = this.bookings.some(
      (existing) => existing.errandId === booking.errandId && existing.status !== "cancelled",
    );
    if (hasOpen) return { ok: false, reason: "open_booking_exists" };
    this.bookings.push(structuredClone(booking));
    return { ok: true };
  }

  async advance(
    bookingId: string,
    status: BookingStatus,
    now: string,
  ): Promise<AdvanceBookingStoreResult> {
    const canonicalNow = toCanonicalInstant(now);
    const index = this.bookings.findIndex((booking) => booking.id === bookingId);
    const current = this.bookings[index];
    if (current === undefined) return { ok: false, reason: "not_found" };
    const result = advanceBooking(current, status, canonicalNow);
    if (!result.ok) return { ok: false, reason: "invalid_transition" };
    this.bookings[index] = structuredClone(result.booking);
    return { ok: true, booking: structuredClone(result.booking) };
  }

  async findOpen(errandId: string): Promise<Booking | undefined> {
    const found = this.bookings.find(
      (booking) => booking.errandId === errandId && booking.status !== "cancelled",
    );
    return found === undefined ? undefined : structuredClone(found);
  }

  async listRecent(limit: number): Promise<Booking[]> {
    requireListLimit(limit, "listRecent");
    return newestBookingsFirst(this.bookings, limit).map((booking) => structuredClone(booking));
  }
}
