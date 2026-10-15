import { createHmac, timingSafeEqual } from "node:crypto";
import { instantMillis } from "../shared/instants.ts";

/** The 30-minute tolerance ElevenLabs' own reference SDKs use for a stale timestamp. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 1800;
const MILLISECONDS_PER_SECOND = 1_000;
const TIMESTAMP_PATTERN = /^\d+$/;
const HEX_DIGEST_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface VerifyElevenLabsSignatureInput {
  readonly rawBody: string;
  readonly header: string | undefined;
  readonly secret: string;
  readonly now: string;
  readonly toleranceSeconds?: number;
}

export type VerifyElevenLabsSignatureResult =
  | { readonly ok: true; readonly timestamp: number }
  | {
      readonly ok: false;
      readonly reason: "missing_header" | "malformed_header" | "stale_timestamp" | "bad_signature";
    };

interface ParsedSignatureHeader {
  readonly timestamp: string;
  readonly signatures: readonly string[];
}

/**
 * Splits `ElevenLabs-Signature: t=<unix seconds>,v0=<hex>[,v0=<hex>...]` into its raw
 * timestamp text and every `v0=` candidate. Returns `null` for anything that does not carry
 * exactly one `t=` entry and at least one `v0=` entry — a caller with more than one
 * conflicting timestamp is treated the same as one with none, since either is ambiguous.
 */
function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    if (part.startsWith("t=")) {
      if (timestamp !== undefined) return null;
      timestamp = part.slice(2);
    } else if (part.startsWith("v0=")) {
      signatures.push(part.slice(3));
    }
  }
  if (timestamp === undefined || !TIMESTAMP_PATTERN.test(timestamp) || signatures.length === 0) {
    return null;
  }
  return { timestamp, signatures };
}

/**
 * Constant-time equality between our own computed hex digest (always a well-formed 64-char
 * lowercase SHA-256 hex string) and an untrusted candidate from the request header. Never
 * throws: a candidate that is not exactly 64 hex characters is simply not a match, so a
 * malformed or truncated `v0=` value cannot crash verification or leak timing about *why* it
 * failed to decode.
 */
function hexDigestsMatch(expectedHex: string, candidateHex: string): boolean {
  if (!HEX_DIGEST_PATTERN.test(candidateHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const candidate = Buffer.from(candidateHex, "hex");
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}

/**
 * Verifies an ElevenLabs post-call webhook signature. The header carries a plaintext unix
 * timestamp (`t=`) and one or more HMAC-SHA256 hex digests (`v0=`) of `<t>.<rawBody>` keyed by
 * the workspace webhook secret; a delivery is accepted if the header's timestamp falls within
 * `toleranceSeconds` of `now` (in either direction — this is intentionally stricter than
 * ElevenLabs' own reference SDKs, which only reject a *stale* timestamp and let a
 * far-future one through) and any `v0=` entry matches the digest we compute ourselves
 * (accepting any match, not just the first, tolerates in-progress secret rotation).
 *
 * Never throws for a malformed request — every failure mode is a typed `{ ok: false }`
 * result — except for a call-time misconfiguration, which must fail loudly rather than
 * silently accept or reject every request: an empty `secret`, or a `toleranceSeconds` that is
 * not finite and non-negative.
 */
export function verifyElevenLabsSignature(
  input: VerifyElevenLabsSignatureInput,
): VerifyElevenLabsSignatureResult {
  if (input.secret.length === 0) {
    throw new RangeError("verifyElevenLabsSignature: secret must not be empty");
  }

  const toleranceSeconds = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError(
      `verifyElevenLabsSignature: toleranceSeconds must be finite and >= 0, got ${toleranceSeconds}`,
    );
  }

  if (input.header === undefined || input.header.length === 0) {
    return { ok: false, reason: "missing_header" };
  }

  const parsed = parseSignatureHeader(input.header);
  if (parsed === null) {
    return { ok: false, reason: "malformed_header" };
  }

  const nowMillis = instantMillis(input.now);
  const timestampSeconds = Number(parsed.timestamp);
  const timestampMillis = timestampSeconds * MILLISECONDS_PER_SECOND;
  const driftSeconds = Math.abs(nowMillis - timestampMillis) / MILLISECONDS_PER_SECOND;
  if (driftSeconds > toleranceSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const message = `${parsed.timestamp}.${input.rawBody}`;
  const expectedDigest = createHmac("sha256", input.secret).update(message, "utf8").digest("hex");
  const signatureMatches = parsed.signatures.some((candidate) =>
    hexDigestsMatch(expectedDigest, candidate),
  );
  if (!signatureMatches) {
    return { ok: false, reason: "bad_signature" };
  }

  return { ok: true, timestamp: timestampSeconds };
}
