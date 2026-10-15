import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/persistence/database.ts";
import {
  SqliteSettingStore,
  settingsInDatabaseFile,
} from "../src/persistence/sqlite-setting-store.ts";
import { InMemorySettingStore } from "../src/settings/adapters/in-memory-setting-store.ts";
import type { SettingStore } from "../src/settings/setting-store.ts";

const NOW = "2026-10-08T10:00:00.000Z";

interface Harness {
  readonly store: SettingStore;
  teardown(): void;
}

interface Factory {
  readonly name: string;
  create(): Promise<Harness>;
}

function describeSettingStoreContract(factory: Factory): void {
  describe(`setting store contract: ${factory.name}`, () => {
    let harness: Harness;

    beforeEach(async () => {
      harness = await factory.create();
    });

    afterEach(() => {
      harness.teardown();
    });

    it("keeps a value by name and lists every stored value", async () => {
      const { store } = harness;

      expect(await store.get("BOOKER_OWNER_NAME")).toBeUndefined();
      await store.set("BOOKER_OWNER_NAME", "Example Owner 2");
      await store.set("BOOKER_PORT", "9100");

      expect(await store.get("BOOKER_OWNER_NAME")).toBe("Example Owner 2");
      expect(await store.all()).toEqual(
        new Map([
          ["BOOKER_OWNER_NAME", "Example Owner 2"],
          ["BOOKER_PORT", "9100"],
        ]),
      );
    });

    it("replaces a value", async () => {
      const { store } = harness;
      await store.set("BOOKER_PORT", "9100");

      await store.set("BOOKER_PORT", "9200");

      expect(await store.get("BOOKER_PORT")).toBe("9200");
    });

    it("removes a value, saying whether there was one", async () => {
      const { store } = harness;
      await store.set("BOOKER_PORT", "9100");

      expect(await store.remove("BOOKER_PORT")).toBe(true);
      expect(await store.get("BOOKER_PORT")).toBeUndefined();
      expect(await store.remove("BOOKER_PORT")).toBe(false);
    });
  });
}

function temporaryDatabase(): { readonly dir: string; readonly path: string } {
  const dir = mkdtempSync(join(tmpdir(), "booker-settings-"));
  return { dir, path: join(dir, "booker.db") };
}

describeSettingStoreContract({
  name: "in-memory",
  create: async () => ({ store: new InMemorySettingStore(), teardown: () => {} }),
});

describeSettingStoreContract({
  name: "SQLite",
  create: async () => {
    const { dir, path } = temporaryDatabase();
    const db = openDatabase(pathToFileURL(path).href);
    await migrate(db);
    return {
      store: new SqliteSettingStore(db, () => NOW),
      teardown: () => {
        db.$client.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});

describeSettingStoreContract({
  name: "SQLite file opened per operation",
  create: async () => {
    const { dir, path } = temporaryDatabase();
    const db = openDatabase(pathToFileURL(path).href);
    await migrate(db);
    db.$client.close();
    return {
      store: settingsInDatabaseFile(path, () => NOW),
      teardown: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
});

describe("settings read from a database file", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    ({ dir, path } = temporaryDatabase());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds nothing, and creates nothing, before the server first made the database", async () => {
    const store = settingsInDatabaseFile(path);

    expect(await store.get("BOOKER_PORT")).toBeUndefined();
    expect(await store.all()).toEqual(new Map());
    expect(existsSync(path)).toBe(false);
    await expect(store.set("BOOKER_PORT", "9100")).rejects.toThrow("pnpm booker serve");
    expect(existsSync(path)).toBe(false);
  });

  it("holds nothing in a database that predates the settings table", async () => {
    const db = openDatabase(pathToFileURL(path).href);
    await db.$client.execute("CREATE TABLE errands (id text PRIMARY KEY)");
    db.$client.close();

    const store = settingsInDatabaseFile(path);

    expect(await store.get("BOOKER_PORT")).toBeUndefined();
    expect(await store.remove("BOOKER_PORT")).toBe(false);
  });

  it("says the saved settings could not be read, naming the file and SQLite's reason", async () => {
    writeFileSync(path, "this is not a database, only text long enough to look like a header");

    await expect(settingsInDatabaseFile(path).get("BOOKER_PORT")).rejects.toThrow(
      `The saved settings in ${path} could not be read: SQLITE_NOTADB: file is not a database`,
    );
  });

  it("takes turns with the server's own connection through the per-file queue", async () => {
    const db = openDatabase(pathToFileURL(path).href);
    await migrate(db);
    const server = new SqliteSettingStore(db, () => NOW);
    const file = settingsInDatabaseFile(path, () => NOW);

    // Interleaved writes from both handles: each runs alone in the file's queue, so none fails.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? server : file).set(`SETTING_${index}`, String(index)),
      ),
    );

    expect((await server.all()).size).toBe(20);
    expect(await file.get("SETTING_19")).toBe("19");
    db.$client.close();
  });

  it("sees what the server's own connection saved", async () => {
    const db = openDatabase(pathToFileURL(path).href);
    await migrate(db);
    await new SqliteSettingStore(db, () => NOW).set("BOOKER_OWNER_NAME", "Example Owner 2");

    expect(await settingsInDatabaseFile(path).get("BOOKER_OWNER_NAME")).toBe("Example Owner 2");
    db.$client.close();
  });
});
