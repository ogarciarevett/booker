import { eq, lt } from "drizzle-orm";
import type {
  SaveTranscriptInput,
  StoredTranscript,
  TranscriptStore,
} from "../calls/transcript-store.ts";
import { validateSaveTranscriptInput } from "../calls/transcript-store.ts";
import { toCanonicalInstant } from "../shared/instants.ts";
import type { Database } from "./database.ts";
import { serialized } from "./database.ts";
import { callTranscripts } from "./schema.ts";
import { withBusyRetry } from "./sqlite-errors.ts";

/**
 * Drizzle + libsql `TranscriptStore`. `save` upserts by `callId`, so a webhook replay (or a
 * corrected re-delivery) simply replaces the stored turns rather than duplicating a row.
 */
export class SqliteTranscriptStore implements TranscriptStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async save(input: SaveTranscriptInput): Promise<void> {
    const validated = validateSaveTranscriptInput(input);
    await serialized(this.db, async () => {
      await withBusyRetry(() =>
        this.db
          .insert(callTranscripts)
          .values({
            callId: validated.callId,
            receivedAt: validated.receivedAt,
            turns: validated.turns,
          })
          .onConflictDoUpdate({
            target: callTranscripts.callId,
            set: { receivedAt: validated.receivedAt, turns: validated.turns },
          }),
      );
    });
  }

  async findByCallId(callId: string): Promise<StoredTranscript | undefined> {
    return await serialized(this.db, async () => {
      const [row] = await withBusyRetry(() =>
        this.db.select().from(callTranscripts).where(eq(callTranscripts.callId, callId)),
      );
      return row === undefined
        ? undefined
        : { callId: row.callId, receivedAt: row.receivedAt, turns: row.turns };
    });
  }

  async purgeReceivedBefore(cutoff: string): Promise<number> {
    const canonicalCutoff = toCanonicalInstant(cutoff, "cutoff");
    return await serialized(this.db, async () => {
      const deleted = await withBusyRetry(() =>
        this.db
          .delete(callTranscripts)
          .where(lt(callTranscripts.receivedAt, canonicalCutoff))
          .returning({ callId: callTranscripts.callId }),
      );
      return deleted.length;
    });
  }
}
