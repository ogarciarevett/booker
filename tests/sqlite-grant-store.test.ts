import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Database,
  migrate,
  migrationsFolderFor,
  openDatabase,
} from "../src/persistence/database.ts";
import { SqliteBookingStore } from "../src/persistence/sqlite-booking-store.ts";
import { SqliteCommitGrantStore } from "../src/persistence/sqlite-commit-grant-store.ts";

const NOW = "2026-09-29T10:00:00.000Z";

describe("SqliteCommitGrantStore error mapping", () => {
  let dir: string | undefined;
  let db: Database | undefined;

  afterEach(() => {
    db?.$client.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces an id collision instead of reporting another active grant", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-grant-store-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrate(db);
    let token = 0;
    const store = new SqliteCommitGrantStore(db, {
      generateId: () => "grant-fixed",
      generateToken: () => `token-${++token}`,
    });

    const first = await store.acquire({
      errandId: "errand-a",
      offerId: "offer-1",
      now: NOW,
      ttlSeconds: 60,
    });
    expect(first.granted).toBe(true);

    const collision = await store
      .acquire({ errandId: "errand-b", offerId: "offer-2", now: NOW, ttlSeconds: 60 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(errorChainMessages(collision)).toContain("commit_grants.id");
  });

  it("surfaces a NOT NULL failure instead of reporting an open booking", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-booking-store-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrate(db);
    const store = new SqliteBookingStore(db);
    const broken = {
      id: "booking-001",
      errandId: "errand-001",
      offerId: "offer-001",
      providerId: null as unknown as string,
      participantIds: ["participant-a"],
      status: "verbal" as const,
      history: [{ status: "verbal" as const, at: NOW }],
    };

    const failure = await store.create(broken).then(
      (result) => result,
      (error: unknown) => error,
    );
    expect(errorChainMessages(failure)).toContain("NOT NULL");
  });
});

describe("migrations folder", () => {
  it("resolves a module URL with encoded characters to a native path on any platform", () => {
    // Built from a native temp path, so the case holds on POSIX and on Windows drive paths.
    const moduleDir = join(tmpdir(), "with space", "src", "persistence");
    const moduleUrl = pathToFileURL(join(moduleDir, "database.ts")).href;
    expect(moduleUrl).toContain("%20");
    expect(migrationsFolderFor(moduleUrl)).toBe(join(moduleDir, "migrations"));
  });
});

/** Joins the messages of an error and its `cause` chain; empty for a non-error value. */
function errorChainMessages(value: unknown): string {
  const messages: string[] = [];
  let current: unknown = value;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
}
