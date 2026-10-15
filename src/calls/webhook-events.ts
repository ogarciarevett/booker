import { randomUUID } from "node:crypto";
import { instantMillis, toCanonicalInstant } from "../shared/instants.ts";

const PAYLOAD_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_LEASE_SECONDS = 300;
const MILLISECONDS_PER_SECOND = 1_000;

export type WebhookEventStatus = "pending" | "completed";

export interface ClaimWebhookEventInput {
  readonly eventKey: string;
  readonly payloadSha256: string;
  readonly now: string;
  readonly leaseSeconds?: number;
}

/**
 * - `{ outcome: "claimed"; claimToken }`: no prior claim existed, or the prior claim's lease
 *   expired without ever completing (crash recovery) — the caller must process the event and
 *   then call `complete`/`release` with this exact `claimToken`.
 * - `{ outcome: "completed_duplicate" }`: this exact event already finished processing; do not
 *   reprocess.
 * - `{ outcome: "in_progress" }`: another caller currently holds an unexpired claim on this
 *   event.
 * - `{ outcome: "payload_mismatch" }`: this `eventKey` was already claimed or completed with a
 *   *different* payload hash — never processed; the caller logs it and answers 409.
 */
export type ClaimWebhookEventResult =
  | { readonly outcome: "claimed"; readonly claimToken: string }
  | { readonly outcome: "completed_duplicate" | "in_progress" | "payload_mismatch" };

/**
 * Port for exactly-once processing of inbound webhook deliveries via a claim/complete/release
 * lease. A simpler "record before processing" scheme loses a delivery forever if the process
 * crashes mid-handler: the retry would see the record and skip it as already-seen, even though
 * the event was never actually processed. A lease survives that crash instead — once
 * `leaseSeconds` elapses with no `complete`, the event becomes claimable again.
 *
 * Implementations must make `claim` atomic under concurrency: for the same `eventKey`, at most
 * one caller may ever receive `"claimed"` for a given claim generation.
 *
 * Each `"claimed"` outcome carries a fresh, unguessable `claimToken` identifying that claim
 * generation. `complete`/`release` require it and act only when it still matches the row's
 * active claim, so a handler whose lease already expired — and was re-claimed by someone else —
 * can never complete or release the *newer* claim it no longer holds (a stale holder).
 */
export interface WebhookEventStore {
  claim(input: ClaimWebhookEventInput): Promise<ClaimWebhookEventResult>;
  /**
   * Marks a claimed event finished so later deliveries see `"completed_duplicate"`. Returns
   * `true` when `claimToken` matched the row's active pending claim and it completed; `false`
   * (no-op) when it didn't — the row is missing, already completed, or the claim was superseded
   * by a later re-claim.
   */
  complete(eventKey: string, claimToken: string, now: string): Promise<boolean>;
  /**
   * Gives up a still-pending claim early (e.g. the handler failed), freeing `eventKey` for an
   * immediate re-claim without waiting out the lease. Returns `true` when `claimToken` matched
   * the row's active pending claim and it was released; `false` (no-op) otherwise — never
   * touches a completed event or a claim superseded by a later re-claim.
   */
  release(eventKey: string, claimToken: string): Promise<boolean>;
}

export interface ValidatedClaimInput {
  readonly eventKey: string;
  readonly payloadSha256: string;
  readonly now: string;
  readonly leaseSeconds: number;
}

/**
 * Throws a RangeError for an empty `eventKey` or a `payloadSha256` that is not exactly 64
 * lowercase hex digits (a SHA-256 digest); canonicalizes `now` and resolves `leaseSeconds` to
 * its default when not given.
 */
export function validateClaimInput(input: ClaimWebhookEventInput): ValidatedClaimInput {
  if (input.eventKey.length === 0) {
    throw new RangeError("claim eventKey must not be empty");
  }
  if (!PAYLOAD_SHA256_PATTERN.test(input.payloadSha256)) {
    throw new RangeError(
      `claim payloadSha256 must be 64 lowercase hex digits, got "${input.payloadSha256}"`,
    );
  }
  return {
    eventKey: input.eventKey,
    payloadSha256: input.payloadSha256,
    now: toCanonicalInstant(input.now, "now"),
    leaseSeconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
  };
}

/**
 * The canonical instant `leaseSeconds` after `now` — the lease deadline to store at claim time.
 * Storing this computed instant (rather than re-deriving it later from `claimedAt` and whatever
 * `leaseSeconds` a *later* caller happens to pass) is what keeps expiry decisions consistent: the
 * deadline is fixed the moment the claim is taken, not recomputed against a different lease
 * duration on every check.
 */
export function computeLeaseExpiresAt(now: string, leaseSeconds: number): string {
  const deadlineMillis = instantMillis(now, "now") + leaseSeconds * MILLISECONDS_PER_SECOND;
  return new Date(deadlineMillis).toISOString();
}

/** True once the stored `leaseExpiresAt` deadline is at or before `now` — a lease past expiry. */
export function isLeaseExpired(leaseExpiresAt: string, now: string): boolean {
  return instantMillis(leaseExpiresAt, "leaseExpiresAt") <= instantMillis(now, "now");
}

/** A fresh, unguessable identifier for one claim generation (see `WebhookEventStore`). */
export function generateClaimToken(): string {
  return randomUUID();
}

/**
 * This call's post-call webhook idempotency key: `${type}:${conversationId}`. A bare
 * `conversation_id` is not enough — ElevenLabs can send more than one webhook event type
 * (`post_call_transcription`, `post_call_audio`, ...) for the same conversation, and each must
 * be claimed and processed independently, not treated as a replay of the other.
 */
export function elevenLabsEventKey(type: string, conversationId: string): string {
  if (type.length === 0) {
    throw new RangeError("elevenLabsEventKey type must not be empty");
  }
  if (conversationId.length === 0) {
    throw new RangeError("elevenLabsEventKey conversationId must not be empty");
  }
  return `${type}:${conversationId}`;
}
