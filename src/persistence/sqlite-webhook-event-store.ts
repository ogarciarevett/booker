import { and, eq } from "drizzle-orm";
import type {
  ClaimWebhookEventInput,
  ClaimWebhookEventResult,
  ValidatedClaimInput,
  WebhookEventStore,
} from "../calls/webhook-events.ts";
import {
  computeLeaseExpiresAt,
  generateClaimToken,
  isLeaseExpired,
  validateClaimInput,
} from "../calls/webhook-events.ts";
import { toCanonicalInstant } from "../shared/instants.ts";
import type { Database } from "./database.ts";
import { serialized } from "./database.ts";
import { webhookEvents } from "./schema.ts";
import { isUniqueConstraintViolationOn, withBusyRetry } from "./sqlite-errors.ts";

/** Internal signal that a concurrent writer changed the row between our read and our write,
 * so the caller must re-run the read-and-decide step against the now-current state. Never
 * escapes `claim`. */
type ClaimAttemptResult = ClaimWebhookEventResult | "retry";

/**
 * A still-pending row always carries the `claim_token`/`lease_expires_at` this store itself
 * wrote at claim (or re-claim) time; only rows migrated from the first, pre-lease scheme can be
 * missing them, and those always land `"completed"` (see `schema.ts`). This asserts that
 * invariant rather than silently treating a corrupt row as expired or active.
 */
function requirePendingLease(row: { claimToken: string | null; leaseExpiresAt: string | null }): {
  claimToken: string;
  leaseExpiresAt: string;
} {
  if (row.claimToken === null || row.leaseExpiresAt === null) {
    throw new Error("pending webhook_events row is missing claim_token or lease_expires_at");
  }
  return { claimToken: row.claimToken, leaseExpiresAt: row.leaseExpiresAt };
}

/**
 * Drizzle + libsql `WebhookEventStore` backing a claim/complete/release lease.
 *
 * `claim` reads the current row and decides the outcome inside one transaction, then either
 * inserts (no prior row) or compare-and-swaps on the prior claim's `claim_token` (a prior row
 * whose lease expired). Two writers can still race to be the one that inserts or re-claims:
 * SQLite's single-writer lock serializes their transactions, so the loser either gets
 * `SQLITE_BUSY` (retried whole by `withBusyRetry`) or completes its own write only to find the
 * row already changed underneath it — an insert then reports a primary-key conflict on
 * `event_key`, and a re-claim's conditional update affects zero rows. Both cases re-run the
 * read-and-decide step against the now-current row rather than trusting the stale decision, so
 * at most one caller ever reports `"claimed"` for a given claim generation.
 *
 * `complete`/`release` require the exact `claimToken` handed back by that `"claimed"` outcome
 * and only act while it still matches the row's active claim, so a stale holder — one whose
 * lease already expired and was re-claimed by someone else — can never touch the newer claim.
 */
export class SqliteWebhookEventStore implements WebhookEventStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async claim(input: ClaimWebhookEventInput): Promise<ClaimWebhookEventResult> {
    return await serialized(this.db, async () => {
      const validated = validateClaimInput(input);
      for (;;) {
        const result = await this.attemptClaim(validated);
        if (result !== "retry") return result;
      }
    });
  }

  private async attemptClaim(validated: ValidatedClaimInput): Promise<ClaimAttemptResult> {
    try {
      return await withBusyRetry(() =>
        this.db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(webhookEvents)
            .where(eq(webhookEvents.eventKey, validated.eventKey));

          if (row === undefined) {
            const claimToken = generateClaimToken();
            await tx.insert(webhookEvents).values({
              eventKey: validated.eventKey,
              payloadSha256: validated.payloadSha256,
              status: "pending",
              claimedAt: validated.now,
              completedAt: null,
              claimToken,
              leaseExpiresAt: computeLeaseExpiresAt(validated.now, validated.leaseSeconds),
            });
            return { outcome: "claimed", claimToken } as const;
          }

          if (row.payloadSha256 !== validated.payloadSha256) {
            return { outcome: "payload_mismatch" } as const;
          }

          if (row.status === "completed") {
            return { outcome: "completed_duplicate" } as const;
          }

          const activeLease = requirePendingLease(row);
          if (!isLeaseExpired(activeLease.leaseExpiresAt, validated.now)) {
            return { outcome: "in_progress" } as const;
          }

          // Lease expired without ever completing: crash recovery. The compare-and-swap on the
          // exact claim_token we just read means a concurrent re-claim of the same expired
          // lease cannot silently double-report "claimed" to two different callers, and it
          // invalidates the old token so its holder can no longer complete/release this claim.
          const claimToken = generateClaimToken();
          const reclaimed = await tx
            .update(webhookEvents)
            .set({
              claimedAt: validated.now,
              leaseExpiresAt: computeLeaseExpiresAt(validated.now, validated.leaseSeconds),
              claimToken,
            })
            .where(
              and(
                eq(webhookEvents.eventKey, validated.eventKey),
                eq(webhookEvents.claimToken, activeLease.claimToken),
              ),
            )
            .returning();
          return reclaimed.length === 0
            ? ("retry" as const)
            : ({ outcome: "claimed", claimToken } as const);
        }),
      );
    } catch (error) {
      if (isUniqueConstraintViolationOn(error, "webhook_events.event_key")) {
        // Lost a concurrent race to insert the first claim; the winner's row is now visible,
        // so the caller re-runs the read-and-decide step to report the correct outcome.
        return "retry";
      }
      throw error;
    }
  }

  async complete(eventKey: string, claimToken: string, now: string): Promise<boolean> {
    return await serialized(this.db, async () => {
      if (eventKey.length === 0) {
        throw new RangeError("complete eventKey must not be empty");
      }
      const canonicalNow = toCanonicalInstant(now, "now");
      return await withBusyRetry(async () => {
        const updated = await this.db
          .update(webhookEvents)
          .set({ status: "completed", completedAt: canonicalNow })
          .where(
            and(
              eq(webhookEvents.eventKey, eventKey),
              eq(webhookEvents.status, "pending"),
              eq(webhookEvents.claimToken, claimToken),
            ),
          )
          .returning();
        return updated.length > 0;
      });
    });
  }

  async release(eventKey: string, claimToken: string): Promise<boolean> {
    return await serialized(this.db, async () => {
      if (eventKey.length === 0) {
        throw new RangeError("release eventKey must not be empty");
      }
      return await withBusyRetry(async () => {
        const deleted = await this.db
          .delete(webhookEvents)
          .where(
            and(
              eq(webhookEvents.eventKey, eventKey),
              eq(webhookEvents.status, "pending"),
              eq(webhookEvents.claimToken, claimToken),
            ),
          )
          .returning();
        return deleted.length > 0;
      });
    });
  }
}
