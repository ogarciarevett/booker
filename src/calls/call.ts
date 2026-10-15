import { toCanonicalInstant } from "../shared/instants.ts";

/** A quote call may only gather offer data; a commit call may also authorize a booking. */
export type CallPurpose = "quote" | "commit";

export type CallStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "failed"
  | "no_answer"
  | "cancelled";

const OPEN_STATUSES: readonly CallStatus[] = ["scheduled", "in_progress"];
const TERMINAL_STATUSES: readonly CallStatus[] = ["completed", "failed", "no_answer", "cancelled"];

/**
 * One placed or in-flight phone call to a provider. `tokenHash` is the hex SHA-256 of the
 * per-call token (see call-token.ts); the raw token is never stored. `externalId` is the
 * voice provider's own call id, filled in once known.
 */
export interface Call {
  readonly id: string;
  readonly errandId: string;
  readonly providerId: string;
  readonly purpose: CallPurpose;
  readonly status: CallStatus;
  readonly attempt: number;
  readonly tokenHash: string;
  readonly externalId: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface StartCallInput {
  readonly id: string;
  readonly errandId: string;
  readonly providerId: string;
  readonly purpose: CallPurpose;
  readonly attempt: number;
  readonly tokenHash: string;
  readonly now: string;
}

/** Builds a fresh scheduled Call: no external id yet, not ended. */
export function startCall(input: StartCallInput): Call {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new RangeError(`startCall attempt must be a positive integer, got ${input.attempt}`);
  }
  return {
    id: input.id,
    errandId: input.errandId,
    providerId: input.providerId,
    purpose: input.purpose,
    status: "scheduled",
    attempt: input.attempt,
    tokenHash: input.tokenHash,
    externalId: null,
    createdAt: toCanonicalInstant(input.now),
    endedAt: null,
  };
}

export type EndCallResult =
  | { readonly ok: true; readonly call: Call }
  | { readonly ok: false; readonly reason: "not_open" };

/**
 * Ends a call, moving it from `scheduled` or `in_progress` to a terminal status
 * (`completed`, `failed`, `no_answer`, or `cancelled`). Returns `not_open` rather than
 * throwing when the call has already ended, since a race with a status webhook is
 * expected; `status` itself must be terminal or this throws (a caller bug).
 */
export function endCall(call: Call, status: CallStatus, now: string): EndCallResult {
  if (!TERMINAL_STATUSES.includes(status)) {
    throw new RangeError(`endCall status must be terminal, got "${status}"`);
  }
  if (!isCallOpen(call)) {
    return { ok: false, reason: "not_open" };
  }
  return { ok: true, call: { ...call, status, endedAt: toCanonicalInstant(now) } };
}

/** True while a call is still scheduled or in progress (counts against concurrency caps). */
export function isCallOpen(call: Call): boolean {
  return OPEN_STATUSES.includes(call.status);
}
