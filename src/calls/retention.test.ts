import { describe, expect, it } from "vitest";
import { purgeExpiredTranscripts, transcriptRetentionCutoff } from "./retention.ts";
import type { SaveTranscriptInput, StoredTranscript, TranscriptStore } from "./transcript-store.ts";

/**
 * A minimal hand-rolled `TranscriptStore` fake, not the real adapter: domain code (this test
 * included) must not import from an `adapters/` folder (see `tests/architecture.test.ts`).
 */
class FakeTranscriptStore implements TranscriptStore {
  private readonly transcripts = new Map<string, StoredTranscript>();

  async save(input: SaveTranscriptInput): Promise<void> {
    this.transcripts.set(input.callId, { ...input });
  }

  async findByCallId(callId: string): Promise<StoredTranscript | undefined> {
    return this.transcripts.get(callId);
  }

  async purgeReceivedBefore(cutoff: string): Promise<number> {
    let purged = 0;
    for (const [callId, transcript] of this.transcripts) {
      if (transcript.receivedAt < cutoff) {
        this.transcripts.delete(callId);
        purged += 1;
      }
    }
    return purged;
  }
}

describe("transcriptRetentionCutoff", () => {
  it("subtracts a whole number of days from now, as a canonical instant", () => {
    expect(transcriptRetentionCutoff("2026-09-30T10:00:00.000Z", 30)).toBe(
      "2026-08-31T10:00:00.000Z",
    );
  });

  it("canonicalizes an offset now", () => {
    expect(transcriptRetentionCutoff("2026-09-30T12:00:00+02:00", 1)).toBe(
      "2026-09-29T10:00:00.000Z",
    );
  });

  it("rejects a zero days", () => {
    expect(() => transcriptRetentionCutoff("2026-09-30T10:00:00.000Z", 0)).toThrow(RangeError);
  });

  it("rejects a negative days", () => {
    expect(() => transcriptRetentionCutoff("2026-09-30T10:00:00.000Z", -1)).toThrow(RangeError);
  });

  it("rejects a non-integer days", () => {
    expect(() => transcriptRetentionCutoff("2026-09-30T10:00:00.000Z", 1.5)).toThrow(RangeError);
  });

  it("rejects an offset-less now", () => {
    expect(() => transcriptRetentionCutoff("2026-09-30T10:00:00", 30)).toThrow(RangeError);
  });
});

describe("purgeExpiredTranscripts", () => {
  it("purges only transcripts older than retentionDays, reporting how many", async () => {
    const transcripts = new FakeTranscriptStore();
    await transcripts.save({
      callId: "call-old",
      receivedAt: "2026-08-01T00:00:00.000Z",
      turns: [{ role: "agent", message: "Hello.", secondsIntoCall: 0 }],
    });
    await transcripts.save({
      callId: "call-recent",
      receivedAt: "2026-09-29T00:00:00.000Z",
      turns: [{ role: "agent", message: "Hello.", secondsIntoCall: 0 }],
    });

    const purged = await purgeExpiredTranscripts({
      transcripts,
      now: "2026-09-30T00:00:00.000Z",
      retentionDays: 30,
    });

    expect(purged).toBe(1);
    expect(await transcripts.findByCallId("call-old")).toBeUndefined();
    expect(await transcripts.findByCallId("call-recent")).toBeDefined();
  });

  it("rejects a non-positive retentionDays", async () => {
    const transcripts = new FakeTranscriptStore();
    await expect(
      purgeExpiredTranscripts({ transcripts, now: "2026-09-30T00:00:00.000Z", retentionDays: 0 }),
    ).rejects.toThrow(RangeError);
  });
});
