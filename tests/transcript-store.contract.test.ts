import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryTranscriptStore } from "../src/calls/adapters/in-memory-transcript-store.ts";
import type { SaveTranscriptInput, TranscriptStore } from "../src/calls/transcript-store.ts";
import { migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteTranscriptStore } from "../src/persistence/sqlite-transcript-store.ts";

interface Subject {
  readonly store: TranscriptStore;
  readonly teardown: () => void;
}

interface SubjectFactory {
  readonly name: string;
  create(): Promise<Subject> | Subject;
}

function transcriptFixture(overrides: Partial<SaveTranscriptInput> = {}): SaveTranscriptInput {
  return {
    callId: "call-001",
    receivedAt: "2026-09-30T10:00:00.000Z",
    turns: [
      { role: "agent", message: "Hello, how can I help?", secondsIntoCall: 0 },
      { role: "user", message: "I need a quote for driving lessons.", secondsIntoCall: 3 },
    ],
    ...overrides,
  };
}

/** One contract suite, run against the in-memory and SQLite `TranscriptStore` adapters. */
function describeTranscriptStoreContract(factory: SubjectFactory): void {
  describe(`transcript store contract: ${factory.name}`, () => {
    let subject: Subject;

    beforeEach(async () => {
      subject = await factory.create();
    });

    afterEach(() => {
      subject.teardown();
    });

    it("finds nothing for a call with no saved transcript", async () => {
      expect(await subject.store.findByCallId("call-missing")).toBeUndefined();
    });

    it("saves a transcript and finds it by call id", async () => {
      await subject.store.save(transcriptFixture());
      expect(await subject.store.findByCallId("call-001")).toEqual(transcriptFixture());
    });

    it("upserts by callId, replacing an earlier transcript for the same call", async () => {
      await subject.store.save(transcriptFixture());
      const replacement = transcriptFixture({
        receivedAt: "2026-09-30T11:00:00.000Z",
        turns: [{ role: "agent", message: "Corrected turn.", secondsIntoCall: 1 }],
      });

      await subject.store.save(replacement);

      expect(await subject.store.findByCallId("call-001")).toEqual(replacement);
    });

    it("never shares state with a saved transcript's turns array", async () => {
      const input = transcriptFixture();
      await subject.store.save(input);
      (input.turns[0] as { message: string }).message = "tampered";

      const found = await subject.store.findByCallId("call-001");
      if (found === undefined) throw new Error("expected the transcript to exist");
      (found.turns[0] as { message: string }).message = "tampered again";

      expect((await subject.store.findByCallId("call-001"))?.turns[0]?.message).toBe(
        "Hello, how can I help?",
      );
    });

    it("purges only transcripts received strictly before the cutoff, reporting the count", async () => {
      await subject.store.save(
        transcriptFixture({ callId: "call-old", receivedAt: "2026-08-01T00:00:00.000Z" }),
      );
      await subject.store.save(
        transcriptFixture({ callId: "call-at-cutoff", receivedAt: "2026-09-01T00:00:00.000Z" }),
      );
      await subject.store.save(
        transcriptFixture({ callId: "call-recent", receivedAt: "2026-09-15T00:00:00.000Z" }),
      );

      const purged = await subject.store.purgeReceivedBefore("2026-09-01T00:00:00.000Z");

      expect(purged).toBe(1);
      expect(await subject.store.findByCallId("call-old")).toBeUndefined();
      expect(await subject.store.findByCallId("call-at-cutoff")).toBeDefined();
      expect(await subject.store.findByCallId("call-recent")).toBeDefined();
    });

    it("reports zero purged when nothing is old enough", async () => {
      await subject.store.save(transcriptFixture());
      expect(await subject.store.purgeReceivedBefore("2026-01-01T00:00:00.000Z")).toBe(0);
    });
  });
}

describeTranscriptStoreContract({
  name: "in-memory",
  create: () => ({ store: new InMemoryTranscriptStore(), teardown: () => {} }),
});

describeTranscriptStoreContract({
  name: "sqlite",
  create: async () => {
    const dir = mkdtempSync(join(tmpdir(), "booker-transcript-store-"));
    const db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrate(db);
    return {
      store: new SqliteTranscriptStore(db),
      teardown: () => {
        db.$client.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
