import { and, eq, ne } from "drizzle-orm";
import type {
  AdvanceBookingStoreResult,
  Booking,
  BookingStatus,
  BookingStore,
  CreateBookingStoreResult,
} from "../bookings/ledger.ts";
import { advanceBooking, newestBookingsFirst } from "../bookings/ledger.ts";
import { toCanonicalInstant } from "../shared/instants.ts";
import { requireListLimit } from "../shared/listing.ts";
import type { Database } from "./database.ts";
import { serialized } from "./database.ts";
import { bookings } from "./schema.ts";
import { isUniqueConstraintViolationOn, withBusyRetry } from "./sqlite-errors.ts";

function rowToBooking(row: typeof bookings.$inferSelect): Booking {
  return {
    id: row.id,
    errandId: row.errandId,
    offerId: row.offerId,
    providerId: row.providerId,
    participantIds: row.participantIds,
    status: row.status,
    history: row.history,
  };
}

/**
 * Drizzle + libsql `BookingStore`. `create` relies on the table's primary key
 * and the partial "one open booking per errand" unique index: a primary-key
 * violation is reported as `duplicate_booking_id`, and a violation of the
 * open-booking index as `open_booking_exists`, both caught rather than
 * thrown. `advance` canonicalizes `now` before reading any state, then
 * re-reads the current row and re-applies the pure `advanceBooking` rule
 * inside a transaction.
 */
export class SqliteBookingStore implements BookingStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(booking: Booking): Promise<CreateBookingStoreResult> {
    return await serialized(this.db, async () => {
      try {
        await withBusyRetry(() =>
          this.db.insert(bookings).values({
            id: booking.id,
            errandId: booking.errandId,
            offerId: booking.offerId,
            providerId: booking.providerId,
            participantIds: booking.participantIds,
            status: booking.status,
            history: booking.history,
          }),
        );
        return { ok: true };
      } catch (error) {
        if (isUniqueConstraintViolationOn(error, "bookings.id")) {
          return { ok: false, reason: "duplicate_booking_id" };
        }
        // Only the open-booking index is a business outcome; any other constraint is a fault.
        if (isUniqueConstraintViolationOn(error, "bookings.errand_id")) {
          return { ok: false, reason: "open_booking_exists" };
        }
        throw error;
      }
    });
  }

  async advance(
    bookingId: string,
    status: BookingStatus,
    now: string,
  ): Promise<AdvanceBookingStoreResult> {
    return await serialized(this.db, async () => {
      const canonicalNow = toCanonicalInstant(now);
      return await withBusyRetry(() =>
        this.db.transaction(async (tx) => {
          const [row] = await tx.select().from(bookings).where(eq(bookings.id, bookingId));
          if (row === undefined) return { ok: false, reason: "not_found" };

          const result = advanceBooking(rowToBooking(row), status, canonicalNow);
          if (!result.ok) return { ok: false, reason: "invalid_transition" };

          await tx
            .update(bookings)
            .set({ status: result.booking.status, history: result.booking.history })
            .where(eq(bookings.id, bookingId));
          return { ok: true, booking: result.booking };
        }),
      );
    });
  }

  async findOpen(errandId: string): Promise<Booking | undefined> {
    return await serialized(this.db, async () => {
      const [row] = await this.db
        .select()
        .from(bookings)
        .where(and(eq(bookings.errandId, errandId), ne(bookings.status, "cancelled")));
      return row === undefined ? undefined : rowToBooking(row);
    });
  }

  /** Reads every booking and sorts in code: one owner makes few, and the order needs `history`. */
  async listRecent(limit: number): Promise<Booking[]> {
    requireListLimit(limit, "listRecent");
    return await serialized(this.db, async () => {
      const rows = await withBusyRetry(() => this.db.select().from(bookings));
      return newestBookingsFirst(rows.map(rowToBooking), limit);
    });
  }
}
