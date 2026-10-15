import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryBookingStore,
  InMemoryCommitGrantStore,
} from "../src/bookings/adapters/in-memory.ts";
import type { CommitGrantStore } from "../src/bookings/commit-grant.ts";
import type { Booking, BookingStore } from "../src/bookings/ledger.ts";
import { migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteBookingStore } from "../src/persistence/sqlite-booking-store.ts";
import { SqliteCommitGrantStore } from "../src/persistence/sqlite-commit-grant-store.ts";

interface Stores {
  readonly grantStore: CommitGrantStore;
  readonly bookingStore: BookingStore;
  readonly teardown: () => Promise<void> | void;
}

interface StoreFactory {
  readonly name: string;
  create(): Promise<Stores> | Stores;
}

function bookingFixture(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "booking-001",
    errandId: "errand-001",
    offerId: "offer-001",
    providerId: "provider-northside",
    participantIds: ["participant-a", "participant-b"],
    status: "verbal",
    history: [{ status: "verbal", at: "2026-09-29T10:00:00.000Z" }],
    ...overrides,
  };
}

/**
 * One shared contract suite, run against every registered store implementation
 * so the in-memory and SQLite adapters are held to exactly the same behavior.
 */
function describeStoreContract(factory: StoreFactory): void {
  describe(`store contract: ${factory.name}`, () => {
    let stores: Stores;

    beforeEach(async () => {
      stores = await factory.create();
    });

    afterEach(async () => {
      await stores.teardown();
    });

    describe("CommitGrantStore", () => {
      it("acquires a grant, then denies a second acquire for the same errand", async () => {
        const first = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 300,
        });
        expect(first.granted).toBe(true);

        const second = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-002",
          now: "2026-09-29T10:00:01.000Z",
          ttlSeconds: 300,
        });
        expect(second).toEqual({ granted: false, reason: "another_active_grant" });
      });

      it("issues a fresh grant once the previous one has expired", async () => {
        const first = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 1,
        });
        expect(first.granted).toBe(true);

        const second = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-002",
          now: "2026-09-29T10:00:02.000Z",
          ttlSeconds: 300,
        });
        expect(second.granted).toBe(true);
        if (second.granted && first.granted) {
          expect(second.grant.id).not.toBe(first.grant.id);
          expect(second.grant.offerId).toBe("offer-002");
        }
      });

      it("consumes a grant once, then reports not_active on a second consume", async () => {
        const acquired = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 300,
        });
        if (!acquired.granted) throw new Error("expected the grant to be acquired");

        const consumed = await stores.grantStore.consume(
          acquired.grant.token,
          "2026-09-29T10:00:05.000Z",
        );
        expect(consumed).toEqual({
          ok: true,
          grant: { ...acquired.grant, status: "consumed" },
        });

        const secondConsume = await stores.grantStore.consume(
          acquired.grant.token,
          "2026-09-29T10:00:06.000Z",
        );
        expect(secondConsume).toEqual({ ok: false, reason: "not_active" });
      });

      it("reports expired when consuming a grant past its expiry", async () => {
        const acquired = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 1,
        });
        if (!acquired.granted) throw new Error("expected the grant to be acquired");

        const consumed = await stores.grantStore.consume(
          acquired.grant.token,
          "2026-09-29T10:00:02.000Z",
        );
        expect(consumed).toEqual({ ok: false, reason: "expired" });
      });

      it("reports unknown_token for a token that was never issued", async () => {
        const result = await stores.grantStore.consume(
          "never-issued-token",
          "2026-09-29T10:00:00.000Z",
        );
        expect(result).toEqual({ ok: false, reason: "unknown_token" });
      });

      it("revokeAll revokes the active grant and lets a new acquire succeed", async () => {
        const acquired = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 300,
        });
        expect(acquired.granted).toBe(true);

        const revokedCount = await stores.grantStore.revokeAll(
          "errand-001",
          "2026-09-29T10:00:01.000Z",
        );
        expect(revokedCount).toBe(1);

        const again = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-002",
          now: "2026-09-29T10:00:02.000Z",
          ttlSeconds: 300,
        });
        expect(again.granted).toBe(true);

        const nothingLeft = await stores.grantStore.revokeAll(
          "errand-002",
          "2026-09-29T10:00:03.000Z",
        );
        expect(nothingLeft).toBe(0);
      });

      it("findActive returns the active grant, then undefined once revoked", async () => {
        const acquired = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 300,
        });
        if (!acquired.granted) throw new Error("expected the grant to be acquired");

        const active = await stores.grantStore.findActive("errand-001", "2026-09-29T10:00:01.000Z");
        expect(active).toEqual(acquired.grant);

        await stores.grantStore.revokeAll("errand-001", "2026-09-29T10:00:02.000Z");
        const afterRevoke = await stores.grantStore.findActive(
          "errand-001",
          "2026-09-29T10:00:03.000Z",
        );
        expect(afterRevoke).toBeUndefined();
      });

      it("acquiring for a different errand succeeds while another errand holds an active grant", async () => {
        const first = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 300,
        });
        expect(first.granted).toBe(true);

        const second = await stores.grantStore.acquire({
          errandId: "errand-002",
          offerId: "offer-002",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 300,
        });
        expect(second.granted).toBe(true);
      });

      it("reports not_active when consuming a revoked grant", async () => {
        const acquired = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 300,
        });
        if (!acquired.granted) throw new Error("expected the grant to be acquired");

        await stores.grantStore.revokeAll("errand-001", "2026-09-29T10:00:01.000Z");

        const result = await stores.grantStore.consume(
          acquired.grant.token,
          "2026-09-29T10:00:02.000Z",
        );
        expect(result).toEqual({ ok: false, reason: "not_active" });
      });

      it("is active one millisecond before expiresAt and inactive exactly at expiresAt", async () => {
        const acquired = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 5,
        });
        if (!acquired.granted) throw new Error("expected the grant to be acquired");

        const stillActive = await stores.grantStore.findActive(
          "errand-001",
          "2026-09-29T10:00:04.999Z",
        );
        expect(stillActive).toEqual(acquired.grant);

        const afterExpiry = await stores.grantStore.findActive(
          "errand-001",
          "2026-09-29T10:00:05.000Z",
        );
        expect(afterExpiry).toBeUndefined();
      });

      it("consume succeeds one millisecond before expiresAt and reports expired exactly at expiresAt", async () => {
        const stillConsumable = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 5,
        });
        if (!stillConsumable.granted) throw new Error("expected the grant to be acquired");
        const beforeExpiry = await stores.grantStore.consume(
          stillConsumable.grant.token,
          "2026-09-29T10:00:04.999Z",
        );
        expect(beforeExpiry.ok).toBe(true);

        const expiresExactly = await stores.grantStore.acquire({
          errandId: "errand-002",
          offerId: "offer-002",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 5,
        });
        if (!expiresExactly.granted) throw new Error("expected the grant to be acquired");
        const atExpiry = await stores.grantStore.consume(
          expiresExactly.grant.token,
          "2026-09-29T10:00:05.000Z",
        );
        expect(atExpiry).toEqual({ ok: false, reason: "expired" });
      });

      it("consume reports expired for a grant another call already marked expired", async () => {
        const acquired = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 5,
        });
        if (!acquired.granted) throw new Error("expected the grant to be acquired");
        // findActive past expiry marks the stored grant as expired.
        expect(await stores.grantStore.findActive("errand-001", "2026-09-29T10:00:06.000Z")).toBe(
          undefined,
        );

        const consumed = await stores.grantStore.consume(
          acquired.grant.token,
          "2026-09-29T10:00:07.000Z",
        );
        expect(consumed).toEqual({ ok: false, reason: "expired" });
      });
    });

    describe("BookingStore", () => {
      it("creates a booking, then rejects a second open booking for the same errand", async () => {
        const first = await stores.bookingStore.create(bookingFixture());
        expect(first).toEqual({ ok: true });

        const second = await stores.bookingStore.create(
          bookingFixture({ id: "booking-002", offerId: "offer-002" }),
        );
        expect(second).toEqual({ ok: false, reason: "open_booking_exists" });
      });

      it("rejects a booking whose id already exists for a different errand", async () => {
        const first = await stores.bookingStore.create(bookingFixture());
        expect(first).toEqual({ ok: true });

        const duplicate = await stores.bookingStore.create(
          bookingFixture({ errandId: "errand-002" }),
        );
        expect(duplicate).toEqual({ ok: false, reason: "duplicate_booking_id" });
      });

      it("allows a new booking once the previous one is cancelled", async () => {
        await stores.bookingStore.create(bookingFixture());
        const cancelled = await stores.bookingStore.advance(
          "booking-001",
          "cancelled",
          "2026-09-29T11:00:00.000Z",
        );
        expect(cancelled.ok).toBe(true);

        const second = await stores.bookingStore.create(
          bookingFixture({ id: "booking-002", offerId: "offer-002" }),
        );
        expect(second).toEqual({ ok: true });
      });

      it("advances forward, skipping a status, and rejects moving backward", async () => {
        await stores.bookingStore.create(bookingFixture());

        const enrolled = await stores.bookingStore.advance(
          "booking-001",
          "enrolled",
          "2026-09-29T11:00:00.000Z",
        );
        expect(enrolled.ok).toBe(true);
        if (enrolled.ok) expect(enrolled.booking.status).toBe("enrolled");

        const backward = await stores.bookingStore.advance(
          "booking-001",
          "written",
          "2026-09-29T12:00:00.000Z",
        );
        expect(backward).toEqual({ ok: false, reason: "invalid_transition" });
      });

      it("reports not_found when advancing a booking id that does not exist", async () => {
        const result = await stores.bookingStore.advance(
          "missing-booking",
          "written",
          "2026-09-29T11:00:00.000Z",
        );
        expect(result).toEqual({ ok: false, reason: "not_found" });
      });

      it("findOpen returns the open booking, then undefined once cancelled", async () => {
        await stores.bookingStore.create(bookingFixture());
        const open = await stores.bookingStore.findOpen("errand-001");
        expect(open?.id).toBe("booking-001");

        await stores.bookingStore.advance("booking-001", "cancelled", "2026-09-29T11:00:00.000Z");
        const afterCancel = await stores.bookingStore.findOpen("errand-001");
        expect(afterCancel).toBeUndefined();
      });

      it("lists bookings newest first by when they were made, cancelled ones too", async () => {
        await stores.bookingStore.create(bookingFixture());
        await stores.bookingStore.advance("booking-001", "cancelled", "2026-09-29T11:00:00.000Z");
        await stores.bookingStore.create(
          bookingFixture({
            id: "booking-002",
            offerId: "offer-002",
            history: [{ status: "verbal", at: "2026-09-30T10:00:00.000Z" }],
          }),
        );
        await stores.bookingStore.create(
          bookingFixture({
            id: "booking-003",
            errandId: "errand-002",
            history: [{ status: "verbal", at: "2026-09-28T10:00:00.000Z" }],
          }),
        );

        const recent = await stores.bookingStore.listRecent(2);

        expect(recent.map((booking) => [booking.id, booking.status])).toEqual([
          ["booking-002", "verbal"],
          ["booking-001", "cancelled"],
        ]);
        expect((await stores.bookingStore.listRecent(10)).map((booking) => booking.id)).toEqual([
          "booking-002",
          "booking-001",
          "booking-003",
        ]);
        await expect(stores.bookingStore.listRecent(0)).rejects.toThrow(RangeError);
      });

      it("findOpen still returns a booking after it advances to enrolled", async () => {
        await stores.bookingStore.create(bookingFixture());
        await stores.bookingStore.advance("booking-001", "enrolled", "2026-09-29T11:00:00.000Z");
        const open = await stores.bookingStore.findOpen("errand-001");
        expect(open?.status).toBe("enrolled");
      });
    });

    describe("store isolation", () => {
      it("mutating a returned grant does not change the stored grant", async () => {
        const acquired = await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 300,
        });
        if (!acquired.granted) throw new Error("expected the grant to be acquired");

        const mutable = acquired.grant as { status: string };
        mutable.status = "revoked";

        const stillActive = await stores.grantStore.findActive(
          "errand-001",
          "2026-09-29T10:00:01.000Z",
        );
        expect(stillActive?.status).toBe("active");
      });

      it("mutating a booking passed to create does not change the stored booking", async () => {
        const original = bookingFixture();
        await stores.bookingStore.create(original);

        (original.participantIds as string[]).push("participant-intruder");
        (original.history as { status: string; at: string }[]).push({
          status: "written",
          at: "2026-09-29T11:00:00.000Z",
        });

        const stored = await stores.bookingStore.findOpen("errand-001");
        expect(stored?.participantIds).toEqual(["participant-a", "participant-b"]);
        expect(stored?.history).toHaveLength(1);
      });

      it("mutating a booking returned by findOpen does not change the stored booking", async () => {
        await stores.bookingStore.create(bookingFixture());
        const found = await stores.bookingStore.findOpen("errand-001");
        if (found === undefined) throw new Error("expected an open booking");

        (found.participantIds as string[]).push("participant-intruder");

        const again = await stores.bookingStore.findOpen("errand-001");
        expect(again?.participantIds).toEqual(["participant-a", "participant-b"]);
      });
    });

    describe("now validation", () => {
      it("acquire rejects an offset-less now with RangeError", async () => {
        await expect(
          stores.grantStore.acquire({
            errandId: "errand-001",
            offerId: "offer-001",
            now: "2026-09-29T10:00:00",
            ttlSeconds: 300,
          }),
        ).rejects.toThrow(RangeError);
      });

      it("acquire rejects an offset-less now with RangeError even when another grant is already active", async () => {
        await stores.grantStore.acquire({
          errandId: "errand-001",
          offerId: "offer-001",
          now: "2026-09-29T10:00:00.000Z",
          ttlSeconds: 300,
        });
        await expect(
          stores.grantStore.acquire({
            errandId: "errand-001",
            offerId: "offer-002",
            now: "2026-09-29T10:00:00",
            ttlSeconds: 300,
          }),
        ).rejects.toThrow(RangeError);
      });

      it("consume rejects an offset-less now with RangeError", async () => {
        await expect(
          stores.grantStore.consume("never-issued-token", "2026-09-29T10:00:00"),
        ).rejects.toThrow(RangeError);
      });

      it("revokeAll rejects an offset-less now with RangeError", async () => {
        await expect(
          stores.grantStore.revokeAll("errand-001", "2026-09-29T10:00:00"),
        ).rejects.toThrow(RangeError);
      });

      it("findActive rejects an offset-less now with RangeError", async () => {
        await expect(
          stores.grantStore.findActive("errand-001", "2026-09-29T10:00:00"),
        ).rejects.toThrow(RangeError);
      });

      it("advance rejects an offset-less now with RangeError", async () => {
        await expect(
          stores.bookingStore.advance("missing-booking", "written", "2026-09-29T10:00:00"),
        ).rejects.toThrow(RangeError);
      });
    });
  });
}

describeStoreContract({
  name: "in-memory",
  create: () => ({
    grantStore: new InMemoryCommitGrantStore(),
    bookingStore: new InMemoryBookingStore(),
    teardown: () => {},
  }),
});

describeStoreContract({
  name: "sqlite",
  create: async () => {
    const dir = mkdtempSync(join(tmpdir(), "booker-stores-contract-"));
    const db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrate(db);
    return {
      grantStore: new SqliteCommitGrantStore(db),
      bookingStore: new SqliteBookingStore(db),
      teardown: () => {
        db.$client.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
