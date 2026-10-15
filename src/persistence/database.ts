import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema.ts";

/**
 * A short native busy-timeout. The libsql binding is synchronous, so SQLite's
 * busy wait blocks the Node event loop, including the in-process writer that
 * holds the lock and needs that thread to commit: a longer timeout only stalls
 * longer. Writers in this process never wait here, because `serialized` queues
 * them by file; this timeout plus `withBusyRetry` only cover a writer in
 * another process.
 */
const BUSY_TIMEOUT_MS = 50;

/**
 * One connection per client. The local libsql driver otherwise opens a pool
 * of (by default) 20 connections per `createClient` call; every caller here
 * represents a single logical connection (one request, one store instance),
 * so a pool would only add unnecessary lock contention against the same file.
 */
const CONNECTIONS_PER_CLIENT = 1;

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Opens a libsql-backed Drizzle database at `url` (e.g. `file:local.db`).
 * The returned instance exposes the underlying client as `$client`, so
 * callers close it with `db.$client.close()`.
 */
export function openDatabase(url: string): Database {
  const db = drizzle({
    connection: { url, timeout: BUSY_TIMEOUT_MS, concurrency: CONNECTIONS_PER_CLIENT },
    schema,
  });
  const filePath = localFilePath(url);
  if (filePath !== undefined) databaseFiles.set(db, filePath);
  return db;
}

/**
 * The absolute path of the local SQLite file `url` names, or `undefined` for an in-memory
 * database (`:memory:`, `file::memory:`) or anything that is not a local `file:` URL. Reads the
 * URL the way libsql does: an optional `//` authority (`file:///absolute/path.db`), then the path
 * up to any `?` or `#`, percent-decoded, and resolved against `process.cwd()` when relative, as
 * SQLite opens it. Symlinks are not followed, so one file reached through two different symlinked
 * paths gets two queues. A shared-cache in-memory URL (`file::memory:?cache=shared`) is also
 * treated as private, so its handles are not queued together; Booker never opens one.
 */
function localFilePath(url: string): string | undefined {
  const path = /^file:(?:\/\/[^/?#]*)?([^?#]*)/iu.exec(url)?.[1];
  if (path === undefined || path === "" || path.startsWith(":memory:")) return undefined;
  return resolve(decodeURIComponent(path));
}

/** The file each handle `openDatabase` opened on a local file writes to (see `serialized`). */
const databaseFiles = new WeakMap<Database, string>();
/** Queue tails per database file, removed once the last queued operation settles. */
const fileTails = new Map<string, Promise<void>>();
/** Queue tails per handle, for in-memory databases and handles not opened by `openDatabase`. */
const handleTails = new WeakMap<Database, Promise<void>>();

/**
 * Queues `operation` behind every earlier `serialized` call on the same database, so this process
 * never has two statements or transactions in flight against it at once. Every handle
 * `openDatabase` opened on the same local file shares one queue (keyed by the file's resolved
 * path); an in-memory database, or a handle created any other way, has a queue of its own.
 *
 * A single handle (one libsql client, `concurrency: 1`, see `openDatabase` above) allows only one
 * statement or transaction in flight; a second concurrent caller otherwise fails with libsql's
 * `TRANSACTION_ACTIVE` ("This client has a single connection, which an open transaction..."), for
 * a bare statement just as much as for a transaction. Separate handles to one file must take turns
 * too, because SQLite's write lock belongs to the file and the libsql binding is synchronous: a
 * handle waiting for the lock runs SQLite's busy wait on the Node thread, blocking the very thread
 * the lock holder needs to commit, so waiting can never succeed in-process. Worse, a
 * `BEGIN IMMEDIATE` that fails with `SQLITE_BUSY` stays active in the binding and makes that
 * connection's next `COMMIT` fail with `SQLITE_BUSY` as well.
 *
 * The next queued operation starts only once the previous one has settled, whether it resolved
 * or rejected — but a rejection never gets stuck in the queue: the tail promise tracked per queue
 * is never itself allowed to reject, so operations queued after a failing one still run.
 * `operation`'s own result or error is always returned to its caller unchanged.
 *
 * Every public method of the SQLite stores wraps its entire body in `serialized(this.db, ...)`,
 * outermost around `withBusyRetry`. An operation running in a queue must never queue another
 * operation on the same queue and await it — through the same handle or any other handle to the
 * same file, for example one store method calling another store method — because the inner call
 * would wait on the outer call's own queued tail, which is itself waiting on the inner call to
 * finish: a deadlock.
 *
 * This queue exists per Node process only. Two processes writing the same file still rely on
 * SQLite's own file locking, `withBusyRetry`'s retry-on-`SQLITE_BUSY`, and the partial unique
 * indexes each store relies on to report a business outcome instead of a crash, which is why
 * Booker runs as a single instance.
 */
export function serialized<T>(db: Database, operation: () => Promise<T>): Promise<T> {
  const filePath = databaseFiles.get(db);
  const previousTail =
    (filePath === undefined ? handleTails.get(db) : fileTails.get(filePath)) ?? Promise.resolve();
  const result = previousTail.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  if (filePath === undefined) {
    handleTails.set(db, tail);
  } else {
    fileTails.set(filePath, tail);
    // Forget the file once its queue is empty, so the map holds only files with work queued.
    void tail.then(() => {
      if (fileTails.get(filePath) === tail) fileTails.delete(filePath);
    });
  }
  return result;
}

/**
 * Native path of the migrations folder next to the module at `moduleUrl`. Uses
 * fileURLToPath so encoded characters and Windows drive letters resolve correctly.
 */
export function migrationsFolderFor(moduleUrl: string): string {
  return fileURLToPath(new URL("./migrations", moduleUrl));
}

/** Applies every migration in `src/persistence/migrations/` that `db` has not run yet. */
export async function migrate(db: Database): Promise<void> {
  await migrateLibsql(db, {
    migrationsFolder: migrationsFolderFor(import.meta.url),
  });
  // WAL mode is a property of the file, set once; it lets readers and writers
  // interleave far more gracefully than the default rollback journal does,
  // which matters once several connections write to the same file at once.
  await db.run(sql`PRAGMA journal_mode = WAL`);
}
