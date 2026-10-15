import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, lte, type SQL } from "drizzle-orm";
import type {
  AcquireGrantInput,
  AcquireGrantResult,
  CommitGrant,
  CommitGrantStore,
  ConsumeGrantResult,
  IdGenerator,
} from "../bookings/commit-grant.ts";
import { newGrant } from "../bookings/commit-grant.ts";
import { toCanonicalInstant } from "../shared/instants.ts";
import type { Database } from "./database.ts";
import { serialized } from "./database.ts";
import { commitGrants } from "./schema.ts";
import { isUniqueConstraintViolationOn, withBusyRetry } from "./sqlite-errors.ts";

export interface SqliteCommitGrantStoreOptions {
  readonly generateId?: IdGenerator;
  readonly generateToken?: IdGenerator;
}

function rowToGrant(row: typeof commitGrants.$inferSelect): CommitGrant {
  return {
    id: row.id,
    errandId: row.errandId,
    offerId: row.offerId,
    token: row.token,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Drizzle + libsql `CommitGrantStore`. Every method canonicalizes `now`
 * before touching the database, so a malformed or offset-less `now` always
 * throws a `RangeError`, never a silent state-dependent result. `acquire`
 * expires stale grants and inserts the new one inside a single transaction;
 * a unique-constraint violation on the partial "one active grant per errand"
 * index is caught and reported as `another_active_grant` rather than thrown,
 * so concurrent callers racing for the same errand never see an unhandled
 * error. SQL comparisons against `expires_at` use the canonical UTC `now`,
 * since a textual comparison is only correct when both sides share the same
 * canonical format.
 */
export class SqliteCommitGrantStore implements CommitGrantStore {
  private readonly db: Database;
  private readonly generateId: IdGenerator;
  private readonly generateToken: IdGenerator;

  constructor(db: Database, options: SqliteCommitGrantStoreOptions = {}) {
    this.db = db;
    this.generateId = options.generateId ?? (() => randomUUID());
    this.generateToken = options.generateToken ?? (() => randomBytes(32).toString("base64url"));
  }

  private expireStaleWhere(errandId: string, now: string): SQL {
    return and(
      eq(commitGrants.errandId, errandId),
      eq(commitGrants.status, "active"),
      lte(commitGrants.expiresAt, now),
    ) as SQL;
  }

  async acquire(input: AcquireGrantInput): Promise<AcquireGrantResult> {
    return await serialized(this.db, async () => {
      const canonicalNow = toCanonicalInstant(input.now);
      const grant = newGrant({
        id: this.generateId(),
        errandId: input.errandId,
        offerId: input.offerId,
        token: this.generateToken(),
        now: canonicalNow,
        ttlSeconds: input.ttlSeconds,
      });

      try {
        return await withBusyRetry(() =>
          this.db.transaction(async (tx) => {
            await tx
              .update(commitGrants)
              .set({ status: "expired" })
              .where(this.expireStaleWhere(input.errandId, canonicalNow));

            await tx.insert(commitGrants).values(grant);
            return { granted: true, grant } as const;
          }),
        );
      } catch (error) {
        // Only the one-active-grant-per-errand index means "another active grant"; an id or
        // token collision is a real fault and must surface.
        if (isUniqueConstraintViolationOn(error, "commit_grants.errand_id")) {
          return { granted: false, reason: "another_active_grant" };
        }
        throw error;
      }
    });
  }

  async consume(token: string, now: string): Promise<ConsumeGrantResult> {
    return await serialized(this.db, async () => {
      const canonicalNow = toCanonicalInstant(now);
      return await withBusyRetry(() =>
        this.db.transaction(async (tx) => {
          const [row] = await tx.select().from(commitGrants).where(eq(commitGrants.token, token));
          if (row === undefined) return { ok: false, reason: "unknown_token" };

          // Already marked expired by another call, or past expiry now: both report "expired".
          if (row.status === "expired") return { ok: false, reason: "expired" };
          if (row.status === "active" && row.expiresAt <= canonicalNow) {
            await tx
              .update(commitGrants)
              .set({ status: "expired" })
              .where(eq(commitGrants.id, row.id));
            return { ok: false, reason: "expired" };
          }
          if (row.status !== "active") {
            return { ok: false, reason: "not_active" };
          }

          const [updated] = await tx
            .update(commitGrants)
            .set({ status: "consumed" })
            .where(eq(commitGrants.id, row.id))
            .returning();
          if (updated === undefined) return { ok: false, reason: "unknown_token" };
          return { ok: true, grant: rowToGrant(updated) };
        }),
      );
    });
  }

  async revokeAll(errandId: string, now: string): Promise<number> {
    return await serialized(this.db, async () => {
      const canonicalNow = toCanonicalInstant(now);
      return await withBusyRetry(() =>
        this.db.transaction(async (tx) => {
          await tx
            .update(commitGrants)
            .set({ status: "expired" })
            .where(this.expireStaleWhere(errandId, canonicalNow));

          const revoked = await tx
            .update(commitGrants)
            .set({ status: "revoked" })
            .where(and(eq(commitGrants.errandId, errandId), eq(commitGrants.status, "active")))
            .returning();
          return revoked.length;
        }),
      );
    });
  }

  async findActive(errandId: string, now: string): Promise<CommitGrant | undefined> {
    return await serialized(this.db, async () => {
      const canonicalNow = toCanonicalInstant(now);
      return await withBusyRetry(() =>
        this.db.transaction(async (tx) => {
          await tx
            .update(commitGrants)
            .set({ status: "expired" })
            .where(this.expireStaleWhere(errandId, canonicalNow));

          const [row] = await tx
            .select()
            .from(commitGrants)
            .where(and(eq(commitGrants.errandId, errandId), eq(commitGrants.status, "active")));
          return row === undefined ? undefined : rowToGrant(row);
        }),
      );
    });
  }
}
