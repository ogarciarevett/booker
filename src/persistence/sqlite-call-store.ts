import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Call } from "../calls/call.ts";
import type {
  ActiveGrantBinding,
  CreateCallResult,
  LiveCallStore,
  UpdateCallResult,
} from "../calls/call-store.ts";
import { requireListLimit } from "../shared/listing.ts";
import type { Database } from "./database.ts";
import { serialized } from "./database.ts";
import { calls } from "./schema.ts";
import { isUniqueConstraintViolationOn, withBusyRetry } from "./sqlite-errors.ts";

function rowToCall(row: typeof calls.$inferSelect): Call {
  return {
    id: row.id,
    errandId: row.errandId,
    providerId: row.providerId,
    purpose: row.purpose,
    status: row.status,
    attempt: row.attempt,
    tokenHash: row.tokenHash,
    externalId: row.externalId,
    createdAt: row.createdAt,
    endedAt: row.endedAt,
  };
}

/**
 * Drizzle + libsql `CallStore`. A primary-key violation on `create` is reported as
 * `duplicate_call_id` rather than thrown, and a collision on the partial unique index over a
 * non-null `external_id` (on either `create` or `update`) as `duplicate_external_id`. `update`
 * writes only the lifecycle columns, and never `active_grant_token` or
 * `active_grant_terms_digest`, which only `setActiveGrant` changes, always together, nor
 * `call_sid`, which only `setCallSid` changes.
 */
export class SqliteCallStore implements LiveCallStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(call: Call): Promise<CreateCallResult> {
    return await serialized(this.db, async () => {
      try {
        await withBusyRetry(() =>
          this.db.insert(calls).values({
            id: call.id,
            errandId: call.errandId,
            providerId: call.providerId,
            purpose: call.purpose,
            status: call.status,
            attempt: call.attempt,
            tokenHash: call.tokenHash,
            externalId: call.externalId,
            createdAt: call.createdAt,
            endedAt: call.endedAt,
          }),
        );
        return { ok: true };
      } catch (error) {
        if (isUniqueConstraintViolationOn(error, "calls.id")) {
          return { ok: false, reason: "duplicate_call_id" };
        }
        if (isUniqueConstraintViolationOn(error, "calls.external_id")) {
          return { ok: false, reason: "duplicate_external_id" };
        }
        throw error;
      }
    });
  }

  async findById(id: string): Promise<Call | undefined> {
    return await serialized(this.db, async () => {
      const [row] = await withBusyRetry(() => this.db.select().from(calls).where(eq(calls.id, id)));
      return row === undefined ? undefined : rowToCall(row);
    });
  }

  async findByExternalId(externalId: string): Promise<Call | undefined> {
    return await serialized(this.db, async () => {
      const [row] = await withBusyRetry(() =>
        this.db.select().from(calls).where(eq(calls.externalId, externalId)),
      );
      return row === undefined ? undefined : rowToCall(row);
    });
  }

  async update(call: Call): Promise<UpdateCallResult> {
    return await serialized(this.db, async () => {
      try {
        const updated = await withBusyRetry(() =>
          this.db
            .update(calls)
            .set({ status: call.status, externalId: call.externalId, endedAt: call.endedAt })
            .where(eq(calls.id, call.id))
            .returning({ id: calls.id }),
        );
        return updated.length === 0 ? { ok: false, reason: "not_found" } : { ok: true };
      } catch (error) {
        if (isUniqueConstraintViolationOn(error, "calls.external_id")) {
          return { ok: false, reason: "duplicate_external_id" };
        }
        throw error;
      }
    });
  }

  async setActiveGrant(
    callId: string,
    binding: ActiveGrantBinding | null,
  ): Promise<UpdateCallResult> {
    return await serialized(this.db, async () => {
      const updated = await withBusyRetry(() =>
        this.db
          .update(calls)
          .set({
            activeGrantToken: binding?.token ?? null,
            activeGrantTermsDigest: binding?.termsDigest ?? null,
          })
          .where(eq(calls.id, callId))
          .returning({ id: calls.id }),
      );
      return updated.length === 0 ? { ok: false, reason: "not_found" } : { ok: true };
    });
  }

  async activeGrant(callId: string): Promise<ActiveGrantBinding | undefined> {
    return await serialized(this.db, async () => {
      const [row] = await withBusyRetry(() =>
        this.db
          .select({
            token: calls.activeGrantToken,
            termsDigest: calls.activeGrantTermsDigest,
          })
          .from(calls)
          .where(eq(calls.id, callId)),
      );
      // A token bound without its authorized terms (from before they were stored) is no binding.
      if (row === undefined || row.token === null || row.termsDigest === null) return undefined;
      return { token: row.token, termsDigest: row.termsDigest };
    });
  }

  async setCallSid(callId: string, callSid: string): Promise<UpdateCallResult> {
    return await serialized(this.db, async () => {
      const updated = await withBusyRetry(() =>
        this.db
          .update(calls)
          .set({ callSid })
          .where(eq(calls.id, callId))
          .returning({ id: calls.id }),
      );
      return updated.length === 0 ? { ok: false, reason: "not_found" } : { ok: true };
    });
  }

  async listOpen(): Promise<Call[]> {
    return await serialized(this.db, async () => {
      const rows = await withBusyRetry(() =>
        this.db
          .select()
          .from(calls)
          .where(inArray(calls.status, ["scheduled", "in_progress"])),
      );
      return rows.map(rowToCall);
    });
  }

  async listByErrand(errandId: string): Promise<Call[]> {
    return await serialized(this.db, async () => {
      const rows = await withBusyRetry(() =>
        this.db.select().from(calls).where(eq(calls.errandId, errandId)),
      );
      return rows.map(rowToCall);
    });
  }

  async listRecent(limit: number): Promise<Call[]> {
    requireListLimit(limit, "listRecent");
    return await serialized(this.db, async () => {
      const rows = await withBusyRetry(() =>
        this.db.select().from(calls).orderBy(desc(calls.createdAt), asc(calls.id)).limit(limit),
      );
      return rows.map(rowToCall);
    });
  }

  async callSid(callId: string): Promise<string | undefined> {
    return await serialized(this.db, async () => {
      const [row] = await withBusyRetry(() =>
        this.db.select({ callSid: calls.callSid }).from(calls).where(eq(calls.id, callId)),
      );
      return row?.callSid ?? undefined;
    });
  }
}
