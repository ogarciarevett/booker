import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import drivingSchoolBrief from "../examples/errands/driving-school.example.json" with {
  type: "json",
};
import { InMemoryErrandStore } from "../src/calls/adapters/in-memory-errand-store.ts";
import type { ErrandStore } from "../src/calls/errand-store.ts";
import { type ErrandBrief, parseErrandBrief } from "../src/errands/brief.ts";
import { migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteErrandStore } from "../src/persistence/sqlite-errand-store.ts";

const NOW = "2026-09-30T10:00:00.000Z";

interface Subject {
  readonly store: ErrandStore;
  readonly teardown: () => void;
}

interface SubjectFactory {
  readonly name: string;
  create(): Promise<Subject> | Subject;
}

function brief(): ErrandBrief {
  const result = parseErrandBrief(drivingSchoolBrief);
  if (!result.ok) throw new Error(`invalid driving-school fixture: ${result.issues.join(", ")}`);
  return result.brief;
}

/** One contract suite, run against the in-memory and SQLite `ErrandStore` adapters. */
function describeErrandStoreContract(factory: SubjectFactory): void {
  describe(`errand store contract: ${factory.name}`, () => {
    let subject: Subject;

    beforeEach(async () => {
      subject = await factory.create();
    });

    afterEach(() => {
      subject.teardown();
    });

    it("saves a brief and gets it back by errand id", async () => {
      await subject.store.save(brief(), NOW);
      expect(await subject.store.get(brief().id)).toEqual(brief());
      expect(await subject.store.get("errand-missing")).toBeUndefined();
    });

    it("replaces a brief saved again under the same id", async () => {
      await subject.store.save(brief(), NOW);
      const revised = { ...brief(), objective: "Enroll two participants in an evening course." };
      await subject.store.save(revised, "2026-09-30T11:00:00.000Z");
      expect(await subject.store.get(brief().id)).toEqual(revised);
    });

    it("never shares state with a brief passed in or handed out", async () => {
      const original = brief();
      await subject.store.save(original, NOW);
      (original.spendLimits as { totalMax?: unknown }).totalMax = undefined;

      const found = await subject.store.get(brief().id);
      if (found === undefined) throw new Error("expected the brief to exist");
      (found.participants as unknown[]).pop();

      expect(await subject.store.get(brief().id)).toEqual(brief());
    });

    it("lists stored errands newest first by when each was first saved, up to a limit", async () => {
      const first = brief();
      const second = { ...brief(), id: "errand-second" };
      const third = { ...brief(), id: "errand-third" };
      await subject.store.save(first, "2026-09-30T10:00:00.000Z");
      await subject.store.save(second, "2026-09-30T11:00:00.000Z");
      await subject.store.save(third, "2026-09-30T12:00:00.000Z");
      // Saving again revises the brief but keeps its place.
      await subject.store.save({ ...first, objective: "Revised." }, "2026-09-30T13:00:00.000Z");

      const listed = await subject.store.listRecent(2);

      expect(listed.map((stored) => [stored.brief.id, stored.createdAt])).toEqual([
        ["errand-third", "2026-09-30T12:00:00.000Z"],
        ["errand-second", "2026-09-30T11:00:00.000Z"],
      ]);
      const all = await subject.store.listRecent(10);
      expect(all.map((stored) => stored.brief.id)).toEqual([
        "errand-third",
        "errand-second",
        first.id,
      ]);
      expect(all[2]?.brief.objective).toBe("Revised.");
    });

    it("rejects an offset-less now with RangeError", async () => {
      await expect(subject.store.save(brief(), "2026-09-30T10:00:00")).rejects.toThrow(RangeError);
    });
  });
}

describeErrandStoreContract({
  name: "in-memory",
  create: () => ({ store: new InMemoryErrandStore(), teardown: () => {} }),
});

describeErrandStoreContract({
  name: "sqlite",
  create: async () => {
    const dir = mkdtempSync(join(tmpdir(), "booker-errand-store-"));
    const db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrate(db);
    return {
      store: new SqliteErrandStore(db),
      teardown: () => {
        db.$client.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
