import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { SettingStore } from "../settings/setting-store.ts";
import { type Database, openDatabase, serialized } from "./database.ts";
import { settings } from "./schema.ts";
import { withBusyRetry } from "./sqlite-errors.ts";

function systemNow(): string {
  return new Date().toISOString();
}

/** Drizzle + libsql `SettingStore` on a migrated database. */
export class SqliteSettingStore implements SettingStore {
  private readonly db: Database;
  private readonly now: () => string;

  constructor(db: Database, now: () => string = systemNow) {
    this.db = db;
    this.now = now;
  }

  async get(name: string): Promise<string | undefined> {
    return await serialized(this.db, async () => {
      const [row] = await withBusyRetry(() =>
        this.db.select({ value: settings.value }).from(settings).where(eq(settings.name, name)),
      );
      return row?.value;
    });
  }

  async all(): Promise<ReadonlyMap<string, string>> {
    return await serialized(this.db, async () => {
      const rows = await withBusyRetry(() =>
        this.db.select({ name: settings.name, value: settings.value }).from(settings),
      );
      return new Map(rows.map((row) => [row.name, row.value]));
    });
  }

  async set(name: string, value: string): Promise<void> {
    const updatedAt = this.now();
    await serialized(this.db, async () => {
      await withBusyRetry(() =>
        this.db
          .insert(settings)
          .values({ name, value, updatedAt })
          .onConflictDoUpdate({ target: settings.name, set: { value, updatedAt } }),
      );
    });
  }

  async remove(name: string): Promise<boolean> {
    return await serialized(this.db, async () => {
      const deleted = await withBusyRetry(() =>
        this.db.delete(settings).where(eq(settings.name, name)).returning({ name: settings.name }),
      );
      return deleted.length > 0;
    });
  }
}

async function hasSettingsTable(db: Database): Promise<boolean> {
  const result = await serialized(db, () =>
    withBusyRetry(() =>
      db.run(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'`),
    ),
  );
  return result.rows.length > 0;
}

/**
 * SQLite's own reason, such as `SQLITE_BUSY: database is locked`: the first line of the first
 * error in the cause chain that carries a code (libsql's, which prefixes it to the message),
 * else of the innermost error. Drizzle's own message only quotes the query.
 */
function rootReason(error: unknown): string {
  let reason: unknown = error;
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    reason = current;
    if ("code" in current && typeof current.code === "string") break;
  }
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.split(/\r\n|\r|\n/u, 1)[0] ?? "";
}

/**
 * Settings in the SQLite file at `path`, opened for each operation and closed after it, for
 * processes that never keep the database open: the CLI commands, and `serve` before its server
 * has opened (and migrated) it. Reading never creates the file: before the server's first start,
 * or in a database older than the settings table, there is simply nothing saved. Saving needs the
 * database the server made. Handles to one file share `serialized`'s queue in this process.
 */
export function settingsInDatabaseFile(path: string, now: () => string = systemNow): SettingStore {
  async function withStore<T>(
    missing: () => T,
    operation: (store: SqliteSettingStore) => Promise<T>,
    verb: "read" | "saved" = "read",
  ): Promise<T> {
    if (!existsSync(path)) return missing();
    let db: Database | undefined;
    try {
      db = openDatabase(pathToFileURL(path).href);
      if (!(await hasSettingsTable(db))) return missing();
      return await operation(new SqliteSettingStore(db, now));
    } catch (error) {
      // Drizzle's own message quotes the query; the reason is SQLite's, at the end of the causes.
      throw new Error(`The saved settings in ${path} could not be ${verb}: ${rootReason(error)}`, {
        cause: error,
      });
    } finally {
      db?.$client.close();
    }
  }

  const notCreatedYet = (): never => {
    throw new Error(
      "The database has no settings table yet: start pnpm booker serve once, then save again.",
    );
  };

  return {
    get: (name) =>
      withStore(
        () => undefined,
        (store) => store.get(name),
      ),
    all: () =>
      withStore(
        () => new Map<string, string>(),
        (store) => store.all(),
      ),
    set: (name, value) => withStore(notCreatedYet, (store) => store.set(name, value), "saved"),
    remove: (name) =>
      withStore(
        () => false,
        (store) => store.remove(name),
        "saved",
      ),
  };
}
