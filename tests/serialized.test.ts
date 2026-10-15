import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, openDatabase, serialized } from "../src/persistence/database.ts";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Resolves once every pending microtask has run, so any operation free to start has started. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Unit tests for `serialized` itself (see `database.ts`), isolated from any real SQL: it keys its
 * queue by the database file a handle was opened on (or by the handle itself for an in-memory
 * database), so these open connections without migrating them.
 */
describe("serialized", () => {
  let dirs: string[] = [];
  let dbs: Database[] = [];

  beforeEach(() => {
    dirs = [];
    dbs = [];
  });

  afterEach(() => {
    for (const db of dbs) db.$client.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** Absolute path of a database file in a fresh temporary directory. */
  function newFilePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "booker-serialized-"));
    dirs.push(dir);
    return join(dir, "test.db");
  }

  function open(url: string): Database {
    const db = openDatabase(url);
    dbs.push(db);
    return db;
  }

  function newDb(): Database {
    return open(`file:${newFilePath()}`);
  }

  it("preserves call order: a later operation never starts before an earlier one settles", async () => {
    const db = newDb();
    const events: string[] = [];

    const first = serialized(db, async () => {
      events.push("first:start");
      await sleep(20);
      events.push("first:end");
      return "first";
    });
    const second = serialized(db, async () => {
      events.push("second:start");
      await sleep(1);
      events.push("second:end");
      return "second";
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("does not block a later operation after an earlier one rejects", async () => {
    const db = newDb();

    const failing = serialized(db, async () => {
      throw new Error("boom");
    });
    const following = serialized(db, async () => "ok");

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("ok");
  });

  it("passes through both a resolved value and a rejection unchanged", async () => {
    const db = newDb();

    await expect(serialized(db, async () => 42)).resolves.toBe(42);
    await expect(
      serialized(db, async () => {
        throw new RangeError("bad input");
      }),
    ).rejects.toThrow(RangeError);
  });

  it("queues operations across separate handles opened on the same file", async () => {
    const url = `file:${newFilePath()}`;
    const dbA = open(url);
    const dbB = open(url);
    const releaseA = Promise.withResolvers<void>();
    let startedB = false;

    const onA = serialized(dbA, () => releaseA.promise);
    const onB = serialized(dbB, async () => {
      startedB = true;
    });

    await drainMicrotasks();
    // Both handles write the same file, so B waits for A even though it is a different handle.
    expect(startedB).toBe(false);

    releaseA.resolve();
    await Promise.all([onA, onB]);
    expect(startedB).toBe(true);
  });

  it("treats relative and absolute spellings of one file as the same queue", async () => {
    const absolutePath = newFilePath();
    const dbAbsolute = open(`file:${absolutePath}`);
    // Relative paths resolve against the working directory, exactly as SQLite opens them.
    const dbRelative = open(`file:${relative(process.cwd(), absolutePath)}`);
    const dbTripleSlash = open(`file://${absolutePath}`);
    const releaseAbsolute = Promise.withResolvers<void>();
    const started: string[] = [];

    const onAbsolute = serialized(dbAbsolute, () => releaseAbsolute.promise);
    const onRelative = serialized(dbRelative, async () => {
      started.push("relative");
    });
    const onTripleSlash = serialized(dbTripleSlash, async () => {
      started.push("triple-slash");
    });

    await drainMicrotasks();
    expect(started).toEqual([]);

    releaseAbsolute.resolve();
    await Promise.all([onAbsolute, onRelative, onTripleSlash]);
    expect(started).toEqual(["relative", "triple-slash"]);
  });

  it("does not block another handle on the same file after an operation rejects", async () => {
    const url = `file:${newFilePath()}`;
    const dbA = open(url);
    const dbB = open(url);
    const failA = Promise.withResolvers<void>();
    let startedB = false;

    const failing = serialized(dbA, () => failA.promise);
    const following = serialized(dbB, async () => {
      startedB = true;
      return "ok";
    });

    await drainMicrotasks();
    expect(startedB).toBe(false);

    failA.reject(new Error("boom"));
    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("ok");
  });

  it("runs operations on handles to different files concurrently", async () => {
    const dbA = newDb();
    const dbB = newDb();
    const releaseA = Promise.withResolvers<void>();
    let finishedB = false;

    const onA = serialized(dbA, () => releaseA.promise);
    const onB = serialized(dbB, async () => {
      finishedB = true;
    });

    await drainMicrotasks();
    // A different file has its own write lock, so B never waits behind the pending A.
    expect(finishedB).toBe(true);

    releaseA.resolve();
    await Promise.all([onA, onB]);
  });

  it("keeps a file's queue when an earlier operation settles while a later one is pending", async () => {
    const url = `file:${newFilePath()}`;
    const dbA = open(url);
    const dbB = open(url);
    const dbC = open(url);
    const releaseA = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    let startedC = false;

    const onA = serialized(dbA, () => releaseA.promise);
    const onB = serialized(dbB, () => releaseB.promise);
    releaseA.resolve();
    await onA;
    await drainMicrotasks();

    // A settling must not forget the file while B is still running, or C would skip the queue.
    const onC = serialized(dbC, async () => {
      startedC = true;
    });
    await drainMicrotasks();
    expect(startedC).toBe(false);

    releaseB.resolve();
    await Promise.all([onB, onC]);
    expect(startedC).toBe(true);
  });

  it("keeps a separate queue per handle for private in-memory databases", async () => {
    // A private in-memory connection (no shared cache) is its own database, so there is no
    // shared file to queue by.
    const dbA = open(":memory:");
    const dbB = open("file::memory:");
    const releaseA = Promise.withResolvers<void>();
    let finishedB = false;

    const onA = serialized(dbA, () => releaseA.promise);
    const onB = serialized(dbB, async () => {
      finishedB = true;
    });

    await drainMicrotasks();
    expect(finishedB).toBe(true);

    releaseA.resolve();
    await Promise.all([onA, onB]);
  });
});
