import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { type Database, migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteCallStore } from "../src/persistence/sqlite-call-store.ts";
import { SqliteSettingStore } from "../src/persistence/sqlite-setting-store.ts";
import { SqliteTranscriptStore } from "../src/persistence/sqlite-transcript-store.ts";
import { SqliteWebhookEventStore } from "../src/persistence/sqlite-webhook-event-store.ts";

const MIGRATIONS = join(process.cwd(), "src/persistence/migrations");

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** A migrations folder holding only the migrations up to and including `lastIdx`. */
function migrationsUpTo(dir: string, lastIdx: number): string {
  const folder = join(dir, "migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
  ) as Journal;
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

describe("migrations on a database that already holds data", () => {
  let dir: string | undefined;
  let db: Database | undefined;

  afterEach(() => {
    db?.$client.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a webhook event recorded by the first scheme as a completed claim", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-migrations-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrateLibsql(db, { migrationsFolder: migrationsUpTo(dir, 1) });
    const payloadSha256 = "a".repeat(64);
    await db.run(
      sql`INSERT INTO webhook_events (event_key, received_at, payload_sha256)
          VALUES ('post_call_transcription:conv-1', '2026-09-29T10:00:00.000Z', ${payloadSha256})`,
    );

    await migrate(db);

    const [migratedRow] = (
      await db.run(
        sql`SELECT claim_token, lease_expires_at FROM webhook_events
            WHERE event_key = 'post_call_transcription:conv-1'`,
      )
    ).rows;
    expect(migratedRow).toEqual({ claim_token: null, lease_expires_at: null });

    const store = new SqliteWebhookEventStore(db);
    const result = await store.claim({
      eventKey: "post_call_transcription:conv-1",
      payloadSha256,
      now: "2026-09-30T10:00:00.000Z",
    });
    expect(result).toEqual({ outcome: "completed_duplicate" });
  });

  it("adds the calls table without touching the errands and offers already stored", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-migrations-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrateLibsql(db, { migrationsFolder: migrationsUpTo(dir, 2) });
    await db.run(
      sql`INSERT INTO errands (id, brief, created_at)
          VALUES ('errand-001', '{"id":"errand-001"}', '2026-09-29T10:00:00.000Z')`,
    );
    await db.run(
      sql`INSERT INTO offers (id, errand_id, offer, created_at)
          VALUES ('offer-001', 'errand-001', '{"id":"offer-001"}', '2026-09-29T10:00:00.000Z')`,
    );

    await migrate(db);

    const errandRows = (await db.run(sql`SELECT id, brief FROM errands`)).rows;
    expect(errandRows).toEqual([{ id: "errand-001", brief: '{"id":"errand-001"}' }]);
    const offerRows = (await db.run(sql`SELECT id, errand_id FROM offers`)).rows;
    expect(offerRows).toEqual([{ id: "offer-001", errand_id: "errand-001" }]);

    const calls = new SqliteCallStore(db);
    const call = {
      id: "call-001",
      errandId: "errand-001",
      providerId: "provider-northside",
      purpose: "quote",
      status: "scheduled",
      attempt: 1,
      tokenHash: "a".repeat(64),
      externalId: null,
      createdAt: "2026-09-30T10:00:00.000Z",
      endedAt: null,
    } as const;
    expect(await calls.create(call)).toEqual({ ok: true });
    expect(await calls.findById("call-001")).toEqual(call);
  });

  it("keeps stored calls but never honors a grant bound before its terms were fingerprinted", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-migrations-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrateLibsql(db, { migrationsFolder: migrationsUpTo(dir, 3) });
    await db.run(
      sql`INSERT INTO calls (id, errand_id, provider_id, purpose, status, attempt, token_hash,
            external_id, created_at, ended_at, active_grant_token)
          VALUES ('call-001', 'errand-001', 'provider-northside', 'commit', 'in_progress', 1,
            ${"a".repeat(64)}, NULL, '2026-09-29T10:00:00.000Z', NULL, 'grant-token-001')`,
    );

    await migrate(db);

    const calls = new SqliteCallStore(db);
    expect(await calls.findById("call-001")).toMatchObject({
      id: "call-001",
      purpose: "commit",
      status: "in_progress",
    });
    // Without the digest of the terms it authorized, the old binding cannot be checked, so it
    // reads as no binding: its grant simply expires after its TTL, losing no data and booking
    // nothing.
    expect(await calls.activeGrant("call-001")).toBeUndefined();

    const binding = { token: "grant-token-002", termsDigest: "c".repeat(64) };
    expect(await calls.setActiveGrant("call-001", binding)).toEqual({ ok: true });
    expect(await calls.activeGrant("call-001")).toEqual(binding);
  });

  it("adds the call_transcripts table without touching calls already stored", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-migrations-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrateLibsql(db, { migrationsFolder: migrationsUpTo(dir, 4) });
    await db.run(
      sql`INSERT INTO calls (id, errand_id, provider_id, purpose, status, attempt, token_hash,
            external_id, created_at, ended_at, active_grant_token, active_grant_terms_digest)
          VALUES ('call-001', 'errand-001', 'provider-northside', 'commit', 'completed', 1,
            ${"a".repeat(64)}, 'conv-001', '2026-09-29T10:00:00.000Z',
            '2026-09-29T10:05:00.000Z', NULL, NULL)`,
    );

    await migrate(db);

    const calls = new SqliteCallStore(db);
    expect(await calls.findByExternalId("conv-001")).toMatchObject({ id: "call-001" });

    const transcripts = new SqliteTranscriptStore(db);
    expect(await transcripts.findByCallId("call-001")).toBeUndefined();
    await transcripts.save({
      callId: "call-001",
      receivedAt: "2026-09-29T10:05:01.000Z",
      turns: [{ role: "agent", message: "Thanks for calling.", secondsIntoCall: 0 }],
    });
    expect(await transcripts.findByCallId("call-001")).toEqual({
      callId: "call-001",
      receivedAt: "2026-09-29T10:05:01.000Z",
      turns: [{ role: "agent", message: "Thanks for calling.", secondsIntoCall: 0 }],
    });
  });

  it("adds the unique external_id index without touching calls already stored", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-migrations-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrateLibsql(db, { migrationsFolder: migrationsUpTo(dir, 5) });
    await db.run(
      sql`INSERT INTO calls (id, errand_id, provider_id, purpose, status, attempt, token_hash,
            external_id, created_at, ended_at, active_grant_token, active_grant_terms_digest)
          VALUES ('call-001', 'errand-001', 'provider-northside', 'commit', 'completed', 1,
            ${"a".repeat(64)}, 'conv-001', '2026-09-29T10:00:00.000Z',
            '2026-09-29T10:05:00.000Z', NULL, NULL)`,
    );
    await db.run(
      sql`INSERT INTO calls (id, errand_id, provider_id, purpose, status, attempt, token_hash,
            external_id, created_at, ended_at, active_grant_token, active_grant_terms_digest)
          VALUES ('call-002', 'errand-001', 'provider-harbor', 'quote', 'scheduled', 1,
            ${"b".repeat(64)}, NULL, '2026-09-29T10:00:00.000Z', NULL, NULL, NULL)`,
    );

    await migrate(db);

    const calls = new SqliteCallStore(db);
    expect(await calls.findByExternalId("conv-001")).toMatchObject({ id: "call-001" });
    expect(await calls.findById("call-002")).toMatchObject({ id: "call-002", externalId: null });

    // The index now enforces uniqueness for any *new* collision, without having needed one to
    // exist among the pre-migration rows above (it did not).
    const duplicate = await calls.create({
      id: "call-003",
      errandId: "errand-001",
      providerId: "provider-harbor",
      purpose: "quote",
      status: "scheduled",
      attempt: 1,
      tokenHash: "c".repeat(64),
      externalId: "conv-001",
      createdAt: "2026-09-29T10:00:00.000Z",
      endedAt: null,
    });
    expect(duplicate).toEqual({ ok: false, reason: "duplicate_external_id" });
  });

  it("adds the call_sid column without touching calls already stored", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-migrations-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrateLibsql(db, { migrationsFolder: migrationsUpTo(dir, 6) });
    await db.run(
      sql`INSERT INTO calls (id, errand_id, provider_id, purpose, status, attempt, token_hash,
            external_id, created_at, ended_at, active_grant_token, active_grant_terms_digest)
          VALUES ('call-001', 'errand-001', 'provider-northside', 'quote', 'in_progress', 1,
            ${"a".repeat(64)}, 'conv-001', '2026-09-29T10:00:00.000Z', NULL, NULL, NULL)`,
    );

    await migrate(db);

    const calls = new SqliteCallStore(db);
    expect(await calls.findByExternalId("conv-001")).toMatchObject({
      id: "call-001",
      status: "in_progress",
    });
    expect(await calls.callSid("call-001")).toBeUndefined();
    expect(await calls.setCallSid("call-001", "CA-fixture-001")).toEqual({ ok: true });
    expect(await calls.callSid("call-001")).toBe("CA-fixture-001");
  });

  it("adds the settings table without touching calls already stored", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-migrations-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrateLibsql(db, { migrationsFolder: migrationsUpTo(dir, 7) });
    await db.run(
      sql`INSERT INTO calls (id, errand_id, provider_id, purpose, status, attempt, token_hash,
            external_id, created_at, ended_at, active_grant_token, active_grant_terms_digest,
            call_sid)
          VALUES ('call-001', 'errand-001', 'provider-northside', 'quote', 'completed', 1,
            ${"a".repeat(64)}, 'conv-001', '2026-09-29T10:00:00.000Z',
            '2026-09-29T10:05:00.000Z', NULL, NULL, 'CA-fixture-001')`,
    );

    await migrate(db);

    const calls = new SqliteCallStore(db);
    expect(await calls.findByExternalId("conv-001")).toMatchObject({ id: "call-001" });
    expect(await calls.callSid("call-001")).toBe("CA-fixture-001");

    const settings = new SqliteSettingStore(db, () => "2026-10-08T10:00:00.000Z");
    expect(await settings.all()).toEqual(new Map());
    await settings.set("BOOKER_OWNER_NAME", "Example Owner 2");
    expect(await settings.get("BOOKER_OWNER_NAME")).toBe("Example Owner 2");
    const [row] = (await db.run(sql`SELECT updated_at FROM settings`)).rows;
    expect(row).toEqual({ updated_at: "2026-10-08T10:00:00.000Z" });
  });

  it("clears duplicate external ids, keeping the first-inserted (lowest rowid) per group, and audits every cleared row", async () => {
    dir = mkdtempSync(join(tmpdir(), "booker-migrations-"));
    db = openDatabase(`file:${join(dir, "test.db")}`);
    const database = db;
    await migrateLibsql(database, { migrationsFolder: migrationsUpTo(dir, 5) });

    async function insertCall(
      id: string,
      externalId: string | null,
      createdAt: string,
    ): Promise<void> {
      await database.run(
        sql`INSERT INTO calls (id, errand_id, provider_id, purpose, status, attempt, token_hash,
              external_id, created_at, ended_at, active_grant_token, active_grant_terms_digest)
            VALUES (${id}, 'errand-001', 'provider-northside', 'commit', 'completed', 1,
              ${"a".repeat(64)}, ${externalId}, ${createdAt}, NULL, NULL, NULL)`,
      );
    }

    // Group A: three calls share `conv-a`. Insertion order (rowid) deliberately disagrees with
    // `created_at` order, so a keeper picked by `created_at` would differ from one picked by
    // rowid: call-a2 is inserted first (lowest rowid) but is NOT the earliest by `created_at`.
    await insertCall("call-a2", "conv-a", "2026-09-29T12:00:00.000Z");
    await insertCall("call-a1", "conv-a", "2026-09-29T09:00:00.000Z");
    await insertCall("call-a3", "conv-a", "2026-09-29T10:00:00.000Z");
    // Group B: two calls share `conv-b`, same disagreement between rowid and `created_at`.
    await insertCall("call-b2", "conv-b", "2026-09-29T11:00:00.000Z");
    await insertCall("call-b1", "conv-b", "2026-09-29T08:00:00.000Z");

    await migrate(db);

    const calls = new SqliteCallStore(db);
    // Exactly one keeper per group, chosen by lowest rowid (first inserted), not by created_at.
    expect((await calls.findById("call-a2"))?.externalId).toBe("conv-a");
    expect((await calls.findById("call-a1"))?.externalId).toBeNull();
    expect((await calls.findById("call-a3"))?.externalId).toBeNull();
    expect((await calls.findById("call-b2"))?.externalId).toBe("conv-b");
    expect((await calls.findById("call-b1"))?.externalId).toBeNull();
    expect(await calls.findByExternalId("conv-a")).toMatchObject({ id: "call-a2" });
    expect(await calls.findByExternalId("conv-b")).toMatchObject({ id: "call-b2" });

    // Every cleared row is preserved for audit, with its original external id and who kept it —
    // nothing is silently lost.
    const conflictRows = (
      await db.run(
        sql`SELECT call_id, external_id, kept_call_id, cleared_at
            FROM call_external_id_conflicts ORDER BY call_id`,
      )
    ).rows as unknown as {
      call_id: string;
      external_id: string;
      kept_call_id: string;
      cleared_at: string;
    }[];
    expect(
      conflictRows.map(({ call_id, external_id, kept_call_id }) => ({
        call_id,
        external_id,
        kept_call_id,
      })),
    ).toEqual([
      { call_id: "call-a1", external_id: "conv-a", kept_call_id: "call-a2" },
      { call_id: "call-a3", external_id: "conv-a", kept_call_id: "call-a2" },
      { call_id: "call-b1", external_id: "conv-b", kept_call_id: "call-b2" },
    ]);
    for (const row of conflictRows) {
      expect(typeof row.cleared_at).toBe("string");
      expect(row.cleared_at.length).toBeGreaterThan(0);
    }

    const duplicate = await calls.create({
      id: "call-a4",
      errandId: "errand-001",
      providerId: "provider-harbor",
      purpose: "quote",
      status: "scheduled",
      attempt: 1,
      tokenHash: "c".repeat(64),
      externalId: "conv-a",
      createdAt: "2026-09-29T10:00:00.000Z",
      endedAt: null,
    });
    expect(duplicate).toEqual({ ok: false, reason: "duplicate_external_id" });
  });
});
