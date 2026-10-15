import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCallStore } from "../src/calls/adapters/in-memory-call-store.ts";
import type { Call } from "../src/calls/call.ts";
import type { ActiveGrantBinding, LiveCallStore } from "../src/calls/call-store.ts";
import { migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteCallStore } from "../src/persistence/sqlite-call-store.ts";

interface Subject {
  readonly store: LiveCallStore;
  readonly teardown: () => void;
}

interface SubjectFactory {
  readonly name: string;
  create(): Promise<Subject> | Subject;
}

function callFixture(overrides: Partial<Call> = {}): Call {
  return {
    id: "call-001",
    errandId: "errand-001",
    providerId: "provider-northside",
    purpose: "commit",
    status: "scheduled",
    attempt: 1,
    tokenHash: "a".repeat(64),
    externalId: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

function bindingFixture(): ActiveGrantBinding {
  return { token: "grant-token-001", termsDigest: "c".repeat(64) };
}

/** One contract suite, run against the in-memory and SQLite `CallStore` adapters. */
function describeCallStoreContract(factory: SubjectFactory): void {
  describe(`call store contract: ${factory.name}`, () => {
    let subject: Subject;

    beforeEach(async () => {
      subject = await factory.create();
    });

    afterEach(() => {
      subject.teardown();
    });

    it("creates a call and finds it by id", async () => {
      expect(await subject.store.create(callFixture())).toEqual({ ok: true });
      expect(await subject.store.findById("call-001")).toEqual(callFixture());
      expect(await subject.store.findById("call-missing")).toBeUndefined();
    });

    it("rejects a second call with the same id", async () => {
      await subject.store.create(callFixture());
      const duplicate = await subject.store.create(callFixture({ errandId: "errand-002" }));
      expect(duplicate).toEqual({ ok: false, reason: "duplicate_call_id" });
    });

    it("updates the lifecycle fields of a call", async () => {
      await subject.store.create(callFixture());
      const ended = callFixture({
        status: "completed",
        externalId: "conv-001",
        endedAt: "2026-09-30T10:05:00.000Z",
      });

      expect(await subject.store.update(ended)).toEqual({ ok: true });
      expect(await subject.store.findById("call-001")).toEqual(ended);
    });

    it("never changes who a call is with, its purpose, or its token hash on update", async () => {
      await subject.store.create(callFixture({ purpose: "quote" }));
      await subject.store.update(
        callFixture({
          errandId: "errand-002",
          providerId: "provider-harbor",
          purpose: "commit",
          attempt: 2,
          tokenHash: "b".repeat(64),
          createdAt: "2026-09-30T11:00:00.000Z",
          status: "in_progress",
        }),
      );

      expect(await subject.store.findById("call-001")).toEqual(
        callFixture({ purpose: "quote", status: "in_progress" }),
      );
    });

    it("reports not_found when updating a call that does not exist", async () => {
      expect(await subject.store.update(callFixture())).toEqual({ ok: false, reason: "not_found" });
    });

    it("finds a call by its external id once set, and not before", async () => {
      await subject.store.create(callFixture());
      expect(await subject.store.findByExternalId("conv-001")).toBeUndefined();

      await subject.store.update(callFixture({ externalId: "conv-001" }));

      expect(await subject.store.findByExternalId("conv-001")).toEqual(
        callFixture({ externalId: "conv-001" }),
      );
      expect(await subject.store.findByExternalId("conv-missing")).toBeUndefined();
    });

    it("rejects a second call sharing another call's external id, on create and on update", async () => {
      await subject.store.create(callFixture({ externalId: "conv-001" }));
      const duplicateOnCreate = await subject.store.create(
        callFixture({ id: "call-002", externalId: "conv-001" }),
      );
      expect(duplicateOnCreate).toEqual({ ok: false, reason: "duplicate_external_id" });

      await subject.store.create(callFixture({ id: "call-003", externalId: null }));
      const duplicateOnUpdate = await subject.store.update(
        callFixture({ id: "call-003", externalId: "conv-001" }),
      );
      expect(duplicateOnUpdate).toEqual({ ok: false, reason: "duplicate_external_id" });
      expect(await subject.store.findById("call-003")).toEqual(
        callFixture({ id: "call-003", externalId: null }),
      );
    });

    it("lists the open calls, and every call of one errand, as independent copies", async () => {
      await subject.store.create(callFixture({ id: "call-open", status: "in_progress" }));
      await subject.store.create(callFixture({ id: "call-scheduled" }));
      await subject.store.create(
        callFixture({ id: "call-done", status: "completed", endedAt: "2026-09-30T10:05:00.000Z" }),
      );
      await subject.store.create(callFixture({ id: "call-other", errandId: "errand-002" }));

      const open = await subject.store.listOpen();
      const ofErrand = await subject.store.listByErrand("errand-001");

      expect(open.map((call) => call.id).sort()).toEqual([
        "call-open",
        "call-other",
        "call-scheduled",
      ]);
      expect(ofErrand.map((call) => call.id).sort()).toEqual([
        "call-done",
        "call-open",
        "call-scheduled",
      ]);
      expect(await subject.store.listByErrand("errand-missing")).toEqual([]);
      (open[0] as { status: string }).status = "cancelled";
      expect((await subject.store.listOpen()).length).toBe(3);
    });

    it("lists the most recently placed calls first, up to a limit, open or ended", async () => {
      const placed = [
        ["call-b", "2026-09-30T10:00:00.000Z"],
        ["call-a", "2026-09-30T10:00:00.000Z"],
        ["call-old", "2026-09-29T09:00:00.000Z"],
        ["call-new", "2026-10-01T08:00:00.000Z"],
      ] as const;
      for (const [id, createdAt] of placed) {
        await subject.store.create(callFixture({ id, createdAt }));
      }
      await subject.store.update({
        ...callFixture({ id: "call-new", createdAt: "2026-10-01T08:00:00.000Z" }),
        status: "completed",
        externalId: "conv-new",
        endedAt: "2026-10-01T08:05:00.000Z",
      });

      const recent = await subject.store.listRecent(3);

      expect(recent.map((call) => call.id)).toEqual(["call-new", "call-a", "call-b"]);
      expect(recent[0]).toMatchObject({ status: "completed", externalId: "conv-new" });
      expect((await subject.store.listRecent(10)).map((call) => call.id)).toEqual([
        "call-new",
        "call-a",
        "call-b",
        "call-old",
      ]);
      (recent[0] as { status: string }).status = "failed";
      expect((await subject.store.findById("call-new"))?.status).toBe("completed");
    });

    it("refuses a listing limit that is not a positive whole number", async () => {
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        await expect(subject.store.listRecent(limit)).rejects.toThrow(RangeError);
      }
    });

    it("keeps the Twilio CallSid a placed call reported, apart from the call's lifecycle", async () => {
      await subject.store.create(callFixture());
      expect(await subject.store.callSid("call-001")).toBeUndefined();

      expect(await subject.store.setCallSid("call-001", "CA-fixture-001")).toEqual({ ok: true });
      await subject.store.update({ ...callFixture(), status: "in_progress", externalId: "conv-1" });

      expect(await subject.store.callSid("call-001")).toBe("CA-fixture-001");
      expect(await subject.store.findById("call-001")).toEqual({
        ...callFixture(),
        status: "in_progress",
        externalId: "conv-1",
      });
      expect(await subject.store.setCallSid("call-missing", "CA-fixture-002")).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(await subject.store.callSid("call-missing")).toBeUndefined();
    });

    it("binds, reads, and clears the call's active grant and its authorized terms", async () => {
      await subject.store.create(callFixture());
      expect(await subject.store.activeGrant("call-001")).toBeUndefined();

      expect(await subject.store.setActiveGrant("call-001", bindingFixture())).toEqual({
        ok: true,
      });
      expect(await subject.store.activeGrant("call-001")).toEqual(bindingFixture());

      const rebound = { token: "grant-token-002", termsDigest: "d".repeat(64) };
      expect(await subject.store.setActiveGrant("call-001", rebound)).toEqual({ ok: true });
      expect(await subject.store.activeGrant("call-001")).toEqual(rebound);

      expect(await subject.store.setActiveGrant("call-001", null)).toEqual({ ok: true });
      expect(await subject.store.activeGrant("call-001")).toBeUndefined();
    });

    it("keeps the active grant when the call itself is updated", async () => {
      await subject.store.create(callFixture());
      await subject.store.setActiveGrant("call-001", bindingFixture());
      await subject.store.update(callFixture({ status: "in_progress" }));
      expect(await subject.store.activeGrant("call-001")).toEqual(bindingFixture());
    });

    it("reports not_found when binding a grant to a call that does not exist", async () => {
      expect(await subject.store.setActiveGrant("call-missing", bindingFixture())).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(await subject.store.activeGrant("call-missing")).toBeUndefined();
    });

    it("never shares state with a grant binding passed in or handed out", async () => {
      await subject.store.create(callFixture());
      const original = bindingFixture();
      await subject.store.setActiveGrant("call-001", original);
      (original as { termsDigest: string }).termsDigest = "e".repeat(64);

      const found = await subject.store.activeGrant("call-001");
      if (found === undefined) throw new Error("expected the binding to exist");
      (found as { token: string }).token = "grant-token-tampered";

      expect(await subject.store.activeGrant("call-001")).toEqual(bindingFixture());
    });

    it("never shares state with a call passed in or handed out", async () => {
      const original = callFixture();
      await subject.store.create(original);
      (original as { status: string }).status = "cancelled";

      const found = await subject.store.findById("call-001");
      if (found === undefined) throw new Error("expected the call to exist");
      (found as { status: string }).status = "failed";

      expect((await subject.store.findById("call-001"))?.status).toBe("scheduled");
    });
  });
}

describeCallStoreContract({
  name: "in-memory",
  create: () => ({ store: new InMemoryCallStore(), teardown: () => {} }),
});

describeCallStoreContract({
  name: "sqlite",
  create: async () => {
    const dir = mkdtempSync(join(tmpdir(), "booker-call-store-"));
    const db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrate(db);
    return {
      store: new SqliteCallStore(db),
      teardown: () => {
        db.$client.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
