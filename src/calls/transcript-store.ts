import { toCanonicalInstant } from "../shared/instants.ts";

/** Who spoke a transcript turn. */
export type TranscriptTurnRole = "agent" | "user";

/**
 * One turn of a call transcript, minimized to exactly what safety and reconciliation need: who
 * spoke, what they said, and when in the call. Nothing else the post-call webhook payload
 * carries (analysis, sentiment, audio, cost, or any other field) is ever kept — see AGENTS.md's
 * data-minimization rule.
 */
export interface TranscriptTurn {
  readonly role: TranscriptTurnRole;
  readonly message: string;
  readonly secondsIntoCall: number;
}

export interface SaveTranscriptInput {
  readonly callId: string;
  readonly receivedAt: string;
  readonly turns: readonly TranscriptTurn[];
}

export interface StoredTranscript {
  readonly callId: string;
  readonly receivedAt: string;
  readonly turns: readonly TranscriptTurn[];
}

/**
 * Port for the minimized transcripts saved from a post-call webhook. `save` upserts by `callId`
 * (idempotent under a webhook replay: saving the same or a corrected transcript again simply
 * replaces it). `purgeReceivedBefore` deletes every transcript whose `receivedAt` is strictly
 * before `cutoff` and returns how many rows were removed, for a scheduled retention purge (see
 * `retention.ts`). Every stored or returned transcript is an independent copy.
 */
export interface TranscriptStore {
  save(input: SaveTranscriptInput): Promise<void>;
  findByCallId(callId: string): Promise<StoredTranscript | undefined>;
  purgeReceivedBefore(cutoff: string): Promise<number>;
}

export interface ValidatedSaveTranscriptInput {
  readonly callId: string;
  readonly receivedAt: string;
  readonly turns: readonly TranscriptTurn[];
}

function validateTurn(turn: TranscriptTurn, index: number): void {
  if (turn.role !== "agent" && turn.role !== "user") {
    throw new RangeError(
      `transcript turn ${index} role must be "agent" or "user", got "${turn.role}"`,
    );
  }
  if (turn.message.length === 0) {
    throw new RangeError(`transcript turn ${index} message must not be empty`);
  }
  if (!Number.isFinite(turn.secondsIntoCall) || turn.secondsIntoCall < 0) {
    throw new RangeError(
      `transcript turn ${index} secondsIntoCall must be >= 0, got ${turn.secondsIntoCall}`,
    );
  }
}

/**
 * Throws a RangeError for an empty `callId`, an offset-less `receivedAt`, or an invalid turn
 * (bad role, empty message, or a negative `secondsIntoCall`); canonicalizes `receivedAt` and
 * returns an independent copy of `turns`.
 */
export function validateSaveTranscriptInput(
  input: SaveTranscriptInput,
): ValidatedSaveTranscriptInput {
  if (input.callId.length === 0) {
    throw new RangeError("save transcript callId must not be empty");
  }
  input.turns.forEach(validateTurn);
  return {
    callId: input.callId,
    receivedAt: toCanonicalInstant(input.receivedAt, "receivedAt"),
    turns: input.turns.map((turn) => ({ ...turn })),
  };
}
