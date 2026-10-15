import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate, openDatabase } from "./database.ts";
import { SqliteSettingStore } from "./sqlite-setting-store.ts";

/**
 * Saves non-secret settings the way the dashboard does, in a migrated
 * `<repoRoot>/.local/data/booker.db` (the default data directory). Test support only.
 */
export async function saveSettingsFixture(
  repoRoot: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const dataDir = join(repoRoot, ".local", "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(pathToFileURL(join(dataDir, "booker.db")).href);
  try {
    await migrate(db);
    const store = new SqliteSettingStore(db);
    for (const [name, value] of Object.entries(values)) await store.set(name, value);
  } finally {
    db.$client.close();
  }
}
