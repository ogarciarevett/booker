import { toCanonicalInstant } from "../../shared/instants.ts";
import type {
  ClaimWebhookEventInput,
  ClaimWebhookEventResult,
  WebhookEventStatus,
  WebhookEventStore,
} from "../webhook-events.ts";
import {
  computeLeaseExpiresAt,
  generateClaimToken,
  isLeaseExpired,
  validateClaimInput,
} from "../webhook-events.ts";

interface StoredWebhookEvent {
  payloadSha256: string;
  status: WebhookEventStatus;
  claimedAt: string;
  completedAt: string | undefined;
  claimToken: string;
  leaseExpiresAt: string;
}

/**
 * In-memory `WebhookEventStore`, useful for tests and the shared contract suite. Not safe
 * across processes; the SQLite adapter is the durable one. `claim` is safe under
 * same-process concurrency because every branch reads and mutates `this.events` synchronously
 * with no `await` in between, so two "concurrent" callers racing for the same `eventKey` are
 * still serialized by the JS event loop — only one of them observes the pre-claim state.
 */
export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly events = new Map<string, StoredWebhookEvent>();

  async claim(input: ClaimWebhookEventInput): Promise<ClaimWebhookEventResult> {
    const validated = validateClaimInput(input);
    const existing = this.events.get(validated.eventKey);

    if (existing === undefined) {
      const claimToken = generateClaimToken();
      this.events.set(validated.eventKey, {
        payloadSha256: validated.payloadSha256,
        status: "pending",
        claimedAt: validated.now,
        completedAt: undefined,
        claimToken,
        leaseExpiresAt: computeLeaseExpiresAt(validated.now, validated.leaseSeconds),
      });
      return { outcome: "claimed", claimToken };
    }

    if (existing.payloadSha256 !== validated.payloadSha256) {
      return { outcome: "payload_mismatch" };
    }

    if (existing.status === "completed") {
      return { outcome: "completed_duplicate" };
    }

    if (!isLeaseExpired(existing.leaseExpiresAt, validated.now)) {
      return { outcome: "in_progress" };
    }

    // Lease expired without ever completing: crash recovery, re-claim in place with a fresh
    // token so the previous holder can no longer complete/release this newer claim.
    const claimToken = generateClaimToken();
    existing.claimedAt = validated.now;
    existing.leaseExpiresAt = computeLeaseExpiresAt(validated.now, validated.leaseSeconds);
    existing.claimToken = claimToken;
    return { outcome: "claimed", claimToken };
  }

  async complete(eventKey: string, claimToken: string, now: string): Promise<boolean> {
    if (eventKey.length === 0) {
      throw new RangeError("complete eventKey must not be empty");
    }
    const canonicalNow = toCanonicalInstant(now, "now");
    const existing = this.events.get(eventKey);
    if (existing === undefined) return false;
    if (existing.status !== "pending" || existing.claimToken !== claimToken) return false;
    existing.status = "completed";
    existing.completedAt = canonicalNow;
    return true;
  }

  async release(eventKey: string, claimToken: string): Promise<boolean> {
    if (eventKey.length === 0) {
      throw new RangeError("release eventKey must not be empty");
    }
    const existing = this.events.get(eventKey);
    if (
      existing === undefined ||
      existing.status !== "pending" ||
      existing.claimToken !== claimToken
    ) {
      return false;
    }
    this.events.delete(eventKey);
    return true;
  }
}
