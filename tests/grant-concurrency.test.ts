import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, migrate, openDatabase } from "../src/persistence/database.ts";
import { commitGrants } from "../src/persistence/schema.ts";
import { SqliteCommitGrantStore } from "../src/persistence/sqlite-commit-grant-store.ts";

const CONCURRENT_ACQUIRES = 20;
const ERRAND_ID = "errand-concurrent";
const NOW = "2026-09-29T10:00:00.000Z";

describe("SqliteCommitGrantStore concurrency", () => {
  let dir: string;
  let dbUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-grant-concurrency-"));
    dbUrl = `file:${join(dir, "test.db")}`;
    const migrationDb = openDatabase(dbUrl);
    await migrate(migrationDb);
    migrationDb.$client.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("grants exactly one of 20 parallel acquire calls for the same errand", async () => {
    // Separate store instances (each its own libsql client) sharing one
    // database file. They are not separate processes: `serialized` (see
    // `database.ts`) queues every handle to this file together, so this checks
    // the one-active-grant rule across handles, not cross-process locking.
    const databases: Database[] = Array.from({ length: CONCURRENT_ACQUIRES }, () =>
      openDatabase(dbUrl),
    );
    const stores = databases.map((db) => new SqliteCommitGrantStore(db));

    try {
      const results = await Promise.all(
        stores.map((store, index) =>
          store.acquire({
            errandId: ERRAND_ID,
            offerId: `offer-${index}`,
            now: NOW,
            ttlSeconds: 300,
          }),
        ),
      );

      const granted = results.filter((result) => result.granted);
      expect(granted).toHaveLength(1);

      const denied = results.filter((result) => !result.granted);
      expect(denied).toHaveLength(CONCURRENT_ACQUIRES - 1);
      for (const result of denied) {
        if (!result.granted) expect(result.reason).toBe("another_active_grant");
      }

      const [firstDb] = databases;
      if (firstDb === undefined) throw new Error("expected at least one database");
      const activeRows = await firstDb
        .select()
        .from(commitGrants)
        .where(and(eq(commitGrants.errandId, ERRAND_ID), eq(commitGrants.status, "active")));
      expect(activeRows).toHaveLength(1);
    } finally {
      for (const db of databases) db.$client.close();
    }
  }, 15_000);
});
