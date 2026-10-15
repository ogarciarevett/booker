import { toCanonicalInstant } from "../../shared/instants.ts";
import type { StoredTranscript, TranscriptStore } from "../transcript-store.ts";
import { validateSaveTranscriptInput } from "../transcript-store.ts";

/**
 * In-memory `TranscriptStore`, useful for tests and the shared contract suite. Not safe across
 * processes; the SQLite adapter is the durable one.
 */
export class InMemoryTranscriptStore implements TranscriptStore {
  private readonly transcripts = new Map<string, StoredTranscript>();

  async save(input: Parameters<TranscriptStore["save"]>[0]): Promise<void> {
    const validated = validateSaveTranscriptInput(input);
    this.transcripts.set(validated.callId, {
      callId: validated.callId,
      receivedAt: validated.receivedAt,
      turns: validated.turns,
    });
  }

  async findByCallId(callId: string): Promise<StoredTranscript | undefined> {
    const found = this.transcripts.get(callId);
    return found === undefined
      ? undefined
      : { ...found, turns: found.turns.map((turn) => ({ ...turn })) };
  }

  async purgeReceivedBefore(cutoff: string): Promise<number> {
    const canonicalCutoff = toCanonicalInstant(cutoff, "cutoff");
    let purged = 0;
    for (const [callId, transcript] of this.transcripts) {
      if (transcript.receivedAt < canonicalCutoff) {
        this.transcripts.delete(callId);
        purged += 1;
      }
    }
    return purged;
  }
}
