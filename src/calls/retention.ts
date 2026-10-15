import { instantMillis } from "../shared/instants.ts";
import type { TranscriptStore } from "./transcript-store.ts";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * The canonical instant `days` whole days before `now` — the cutoff a scheduled purge passes to
 * `TranscriptStore.purgeReceivedBefore` (see `transcript-store.ts`). `days` must be a positive
 * integer; a caller wanting "keep forever" simply never runs the purge, so zero or a negative
 * value is rejected rather than silently purging everything or nothing.
 */
export function transcriptRetentionCutoff(now: string, days: number): string {
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`transcriptRetentionCutoff days must be a positive integer, got ${days}`);
  }
  const cutoffMillis = instantMillis(now, "now") - days * MILLISECONDS_PER_DAY;
  return new Date(cutoffMillis).toISOString();
}

export interface PurgeExpiredTranscriptsInput {
  readonly transcripts: TranscriptStore;
  readonly now: string;
  readonly retentionDays: number;
}

/**
 * The unit a scheduled retention job calls: computes `transcriptRetentionCutoff` and purges
 * everything received before it, returning how many transcripts were removed. The server runs
 * it on a recurring timer (`scheduleTranscriptPurge` in `src/server/transcript-purge.ts`); this
 * function only does the one purge it is asked for.
 */
export async function purgeExpiredTranscripts(
  input: PurgeExpiredTranscriptsInput,
): Promise<number> {
  const cutoff = transcriptRetentionCutoff(input.now, input.retentionDays);
  return await input.transcripts.purgeReceivedBefore(cutoff);
}
