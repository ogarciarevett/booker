import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Booking } from "../src/bookings/ledger.ts";
import { type Database, migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteBookingStore } from "../src/persistence/sqlite-booking-store.ts";
import { SqliteCommitGrantStore } from "../src/persistence/sqlite-commit-grant-store.ts";
import { SqliteWebhookEventStore } from "../src/persistence/sqlite-webhook-event-store.ts";

const NOW = "2026-09-29T10:00:00.000Z";
const CONCURRENT = 10;
const PAYLOAD = "a".repeat(64);

function bookingFixture(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "booking-shared-001",
    errandId: "errand-shared",
    offerId: "offer-001",
    providerId: "provider-northside",
    participantIds: ["participant-a", "participant-b"],
    status: "verbal",
    history: [{ status: "verbal", at: NOW }],
    ...overrides,
  };
}

/** Every settled entry, asserting none of them rejected. */
function expectNoRejections<T>(settled: PromiseSettledResult<T>[]): T[] {
  const rejected = settled.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  expect(rejected.map((result) => String(result.reason))).toEqual([]);
  return settled.map((result) => {
    if (result.status !== "fulfilled") throw new Error("unreachable: rejected filtered above");
    return result.value;
  });
}

/**
 * Reproduces the production topology: ONE `Database` (one libsql client, `concurrency: 1`, see
 * `openDatabase`), with ONE instance of each SQLite store sharing that single connection — the
 * same handle the HTTP server hands every request. Before `serialized` (see `database.ts`)
 * wrapped every public store method, running two operations on this same handle at once made the
 * second fail with libsql's `TRANSACTION_ACTIVE` ("This client has a single connection, which an
 * open transaction..."), because a shared connection allows only one statement or transaction in
 * flight. `tests/grant-concurrency.test.ts` and the contract suites never caught this: each of
 * their concurrent callers opens its own connection to the same backing file, which is a
 * different topology than requests sharing one connection.
 */
describe("stores sharing a single Database handle", () => {
  let dir: string;
  let db: Database;
  let grantStore: SqliteCommitGrantStore;
  let bookingStore: SqliteBookingStore;
  let webhookStore: SqliteWebhookEventStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-shared-connection-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrate(db);
    grantStore = new SqliteCommitGrantStore(db);
    bookingStore = new SqliteBookingStore(db);
    webhookStore = new SqliteWebhookEventStore(db);
  });

  afterEach(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("grants exactly one of 10 parallel acquire calls for the same errand, with no rejections", async () => {
    const attempts = Array.from({ length: CONCURRENT }, (_, index) =>
      grantStore.acquire({
        errandId: "errand-acquire",
        offerId: `offer-${index}`,
        now: NOW,
        ttlSeconds: 300,
      }),
    );
    const results = expectNoRejections(await Promise.allSettled(attempts));

    expect(results.filter((result) => result.granted)).toHaveLength(1);
    const denied = results.filter((result) => !result.granted);
    expect(denied).toHaveLength(CONCURRENT - 1);
    for (const result of denied) {
      if (!result.granted) expect(result.reason).toBe("another_active_grant");
    }
  }, 15_000);

  it("creates exactly one of 10 parallel booking creates for the same errand, with no rejections", async () => {
    const attempts = Array.from({ length: CONCURRENT }, (_, index) =>
      bookingStore.create(bookingFixture({ id: `booking-${index}`, offerId: `offer-${index}` })),
    );
    const results = expectNoRejections(await Promise.allSettled(attempts));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const denied = results.filter((result) => !result.ok);
    expect(denied).toHaveLength(CONCURRENT - 1);
    for (const result of denied) {
      if (!result.ok) expect(result.reason).toBe("open_booking_exists");
    }
  }, 15_000);

  it("claims exactly one of 10 parallel claims for the same event key, with no rejections", async () => {
    const attempts = Array.from({ length: CONCURRENT }, () =>
      webhookStore.claim({ eventKey: "event-shared", payloadSha256: PAYLOAD, now: NOW }),
    );
    const results = expectNoRejections(await Promise.allSettled(attempts));

    expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "in_progress")).toHaveLength(
      CONCURRENT - 1,
    );
  }, 15_000);

  it("runs a mixed concurrent batch across all three stores with no rejections", async () => {
    const errandId = "errand-mixed";
    const eventKey = "event-mixed";
    const bookingId = "booking-mixed";

    const acquired = await grantStore.acquire({
      errandId,
      offerId: "offer-mixed",
      now: NOW,
      ttlSeconds: 300,
    });
    if (!acquired.granted) throw new Error("expected the setup grant to be acquired");

    const created = await bookingStore.create(bookingFixture({ id: bookingId, errandId }));
    expect(created).toEqual({ ok: true });

    const claimed = await webhookStore.claim({ eventKey, payloadSha256: PAYLOAD, now: NOW });
    expect(claimed.outcome).toBe("claimed");
    if (claimed.outcome !== "claimed") throw new Error("expected the claim to succeed");

    const later = "2026-09-29T10:00:05.000Z";
    const batch: Promise<unknown>[] = [
      grantStore.acquire({ errandId, offerId: "offer-mixed-2", now: later, ttlSeconds: 300 }),
      grantStore.findActive(errandId, later),
      grantStore.consume(acquired.grant.token, later),
      grantStore.revokeAll(errandId, later),
      bookingStore.findOpen(errandId),
      bookingStore.advance(bookingId, "enrolled", later),
      webhookStore.complete(eventKey, claimed.claimToken, later),
      webhookStore.release(eventKey, claimed.claimToken),
    ];

    expectNoRejections(await Promise.allSettled(batch));
  }, 15_000);
});
