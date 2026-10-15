import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryWebhookEventStore } from "../src/calls/adapters/in-memory-webhook-events.ts";
import type { WebhookEventStore } from "../src/calls/webhook-events.ts";
import { elevenLabsEventKey } from "../src/calls/webhook-events.ts";
import type { Database } from "../src/persistence/database.ts";
import { migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteWebhookEventStore } from "../src/persistence/sqlite-webhook-event-store.ts";

const NOW = "2026-09-29T10:00:00.000Z";
const PAYLOAD_A = "a".repeat(64);
const PAYLOAD_B = "b".repeat(64);

interface Stores {
  readonly store: WebhookEventStore;
  readonly teardown: () => Promise<void> | void;
  /**
   * A store for exercising this adapter's concurrency model across SEPARATE handles to the same
   * backing file; each call opens a fresh connection to that file. This is not the production
   * topology (production shares one connection per process) and not the cross-process case
   * either: `serialized` (see `database.ts`) queues every handle to one file in this process
   * behind the same queue, so these claims take turns rather than contending for SQLite's write
   * lock. It still proves exactly one claim wins however many handles race. In-memory
   * concurrency is same-process callers racing on one shared instance, so this is just `store`.
   *
   * The shared-single-connection topology — one connection, many requests, where `serialized`
   * keeps concurrent callers from failing with libsql's `TRANSACTION_ACTIVE` — is covered
   * separately by `tests/shared-connection.test.ts`.
   */
  concurrentStore(): WebhookEventStore;
}

interface StoreFactory {
  readonly name: string;
  create(): Promise<Stores> | Stores;
}

/**
 * One shared contract suite, run against every registered `WebhookEventStore`
 * implementation so the in-memory and SQLite adapters are held to exactly the
 * same claim/complete/release lease behavior (see `tests/stores.contract.test.ts`
 * for the same pattern).
 */
function describeStoreContract(factory: StoreFactory): void {
  describe(`webhook event store contract: ${factory.name}`, () => {
    let stores: Stores;

    beforeEach(async () => {
      stores = await factory.create();
    });

    afterEach(async () => {
      await stores.teardown();
    });

    it("claims a brand-new event", async () => {
      const result = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: NOW,
      });
      expect(result.outcome).toBe("claimed");
      if (result.outcome !== "claimed") throw new Error("unreachable: checked above");
      expect(typeof result.claimToken).toBe("string");
      expect(result.claimToken.length).toBeGreaterThan(0);
    });

    it("reports in_progress for the same event and payload while the claim is still pending", async () => {
      await stores.store.claim({ eventKey: "event-001", payloadSha256: PAYLOAD_A, now: NOW });
      const replay = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: NOW,
      });
      expect(replay).toEqual({ outcome: "in_progress" });
    });

    it("reports payload_mismatch when a pending claim's payload hash disagrees", async () => {
      await stores.store.claim({ eventKey: "event-001", payloadSha256: PAYLOAD_A, now: NOW });
      const mismatched = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_B,
        now: NOW,
      });
      expect(mismatched).toEqual({ outcome: "payload_mismatch" });
    });

    it("reports completed_duplicate once the claim has been completed", async () => {
      const claimed = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: NOW,
      });
      if (claimed.outcome !== "claimed") throw new Error("expected the first claim to succeed");
      const completed = await stores.store.complete(
        "event-001",
        claimed.claimToken,
        "2026-09-29T10:00:01.000Z",
      );
      expect(completed).toBe(true);
      const replay = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: "2026-09-29T10:00:02.000Z",
      });
      expect(replay).toEqual({ outcome: "completed_duplicate" });
    });

    it("reports payload_mismatch against a completed event with a different payload hash", async () => {
      const claimed = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: NOW,
      });
      if (claimed.outcome !== "claimed") throw new Error("expected the first claim to succeed");
      await stores.store.complete("event-001", claimed.claimToken, "2026-09-29T10:00:01.000Z");
      const mismatched = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_B,
        now: "2026-09-29T10:00:02.000Z",
      });
      expect(mismatched).toEqual({ outcome: "payload_mismatch" });
    });

    it("tracks different event keys independently", async () => {
      const first = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: NOW,
      });
      const second = await stores.store.claim({
        eventKey: "event-002",
        payloadSha256: PAYLOAD_B,
        now: NOW,
      });
      expect(first.outcome).toBe("claimed");
      expect(second.outcome).toBe("claimed");
    });

    it("gives a transcription and an audio event for the same conversation independent claims", async () => {
      const transcriptionKey = elevenLabsEventKey("post_call_transcription", "conv-1");
      const audioKey = elevenLabsEventKey("post_call_audio", "conv-1");
      const transcription = await stores.store.claim({
        eventKey: transcriptionKey,
        payloadSha256: PAYLOAD_A,
        now: NOW,
      });
      const audio = await stores.store.claim({
        eventKey: audioKey,
        payloadSha256: PAYLOAD_B,
        now: NOW,
      });
      expect(transcription.outcome).toBe("claimed");
      expect(audio.outcome).toBe("claimed");
    });

    it("lets a released pending claim be claimed again immediately", async () => {
      const claimed = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: NOW,
      });
      if (claimed.outcome !== "claimed") throw new Error("expected the first claim to succeed");
      const released = await stores.store.release("event-001", claimed.claimToken);
      expect(released).toBe(true);
      const reclaimed = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: "2026-09-29T10:00:00.001Z",
      });
      expect(reclaimed.outcome).toBe("claimed");
    });

    it("re-claims an event whose pending lease has expired (crash recovery)", async () => {
      const first = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: NOW,
        leaseSeconds: 5,
      });
      expect(first.outcome).toBe("claimed");

      const stillLeased = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: "2026-09-29T10:00:04.999Z",
        leaseSeconds: 5,
      });
      expect(stillLeased).toEqual({ outcome: "in_progress" });

      const afterExpiry = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: "2026-09-29T10:00:05.000Z",
        leaseSeconds: 5,
      });
      expect(afterExpiry.outcome).toBe("claimed");
      if (afterExpiry.outcome !== "claimed") throw new Error("unreachable: checked above");
      if (first.outcome !== "claimed") throw new Error("unreachable: checked above");
      expect(afterExpiry.claimToken).not.toBe(first.claimToken);
    });

    it("denies a stale holder's release and complete once another delivery has re-claimed its expired lease", async () => {
      const firstClaim = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: NOW,
        leaseSeconds: 5,
      });
      if (firstClaim.outcome !== "claimed") throw new Error("expected the first claim to succeed");

      const leaseExpiredAt = "2026-09-29T10:00:05.000Z";
      const secondClaim = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: leaseExpiredAt,
      });
      if (secondClaim.outcome !== "claimed") {
        throw new Error("expected the re-claim after lease expiry to succeed");
      }
      expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);

      const staleRelease = await stores.store.release("event-001", firstClaim.claimToken);
      expect(staleRelease).toBe(false);

      const staleComplete = await stores.store.complete(
        "event-001",
        firstClaim.claimToken,
        leaseExpiredAt,
      );
      expect(staleComplete).toBe(false);

      // The newer holder's claim survives both stale calls untouched: a third claim still finds
      // it in progress rather than free to claim (or gone, or duplicated).
      const thirdClaim = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: leaseExpiredAt,
      });
      expect(thirdClaim).toEqual({ outcome: "in_progress" });
    });

    it("decides lease expiry from the deadline recorded at claim time, not a later claim attempt's leaseSeconds", async () => {
      const shortLease = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: NOW,
        leaseSeconds: 5,
      });
      expect(shortLease.outcome).toBe("claimed");

      // The 5s lease from the first claim is now exactly expired. This claim attempt passes no
      // leaseSeconds (so it resolves to the much longer default) — the reclaim must still
      // succeed, because expiry is decided by the deadline the FIRST claim recorded, never by
      // whatever leaseSeconds a later caller happens to pass.
      const afterOriginalExpiry = await stores.store.claim({
        eventKey: "event-001",
        payloadSha256: PAYLOAD_A,
        now: "2026-09-29T10:00:05.000Z",
      });
      expect(afterOriginalExpiry.outcome).toBe("claimed");
    });

    it("rejects an empty eventKey with RangeError", async () => {
      await expect(
        stores.store.claim({ eventKey: "", payloadSha256: PAYLOAD_A, now: NOW }),
      ).rejects.toThrow(RangeError);
    });

    it("rejects a malformed payloadSha256 with RangeError", async () => {
      await expect(
        stores.store.claim({ eventKey: "event-001", payloadSha256: "not-a-hash", now: NOW }),
      ).rejects.toThrow(RangeError);
    });

    it("rejects an offset-less now with RangeError", async () => {
      await expect(
        stores.store.claim({
          eventKey: "event-001",
          payloadSha256: PAYLOAD_A,
          now: "2026-09-29T10:00:00",
        }),
      ).rejects.toThrow(RangeError);
    });

    it("yields exactly one claimed across 10 concurrent claims of the same brand-new event", async () => {
      const attempts = Array.from({ length: 10 }, () =>
        stores
          .concurrentStore()
          .claim({ eventKey: "event-concurrent", payloadSha256: PAYLOAD_A, now: NOW }),
      );
      const results = await Promise.all(attempts);
      const claimedCount = results.filter((result) => result.outcome === "claimed").length;
      expect(claimedCount).toBe(1);
    });
  });
}

describeStoreContract({
  name: "in-memory",
  create: () => {
    const store = new InMemoryWebhookEventStore();
    return {
      store,
      concurrentStore: () => store,
      teardown: () => {},
    };
  },
});

describeStoreContract({
  name: "sqlite",
  create: async () => {
    const dir = mkdtempSync(join(tmpdir(), "booker-webhook-events-contract-"));
    const url = `file:${join(dir, "test.db")}`;
    const db = openDatabase(url);
    await migrate(db);
    const extraConnections: Database[] = [];
    return {
      store: new SqliteWebhookEventStore(db),
      concurrentStore: () => {
        // A fresh connection to the same backing file; `serialized` queues it together with
        // every other handle to this file.
        const extraDb = openDatabase(url);
        extraConnections.push(extraDb);
        return new SqliteWebhookEventStore(extraDb);
      },
      teardown: () => {
        for (const extraDb of extraConnections) extraDb.$client.close();
        db.$client.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
