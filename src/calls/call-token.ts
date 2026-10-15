import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;
const STORED_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Draws `size` cryptographically random bytes. Injectable so tests stay deterministic. */
export type RandomBytesFn = (size: number) => Buffer;

export interface IssuedCallToken {
  readonly token: string;
  readonly tokenHash: string;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Issues a fresh per-call token: 32 random bytes encoded as base64url, plus the hex SHA-256
 * hash that gets stored (see `Call.tokenHash`). The raw token is only ever handed to the
 * voice provider as a dynamic variable; it is never persisted.
 */
export function issueCallToken(randomBytesFn: RandomBytesFn = randomBytes): IssuedCallToken {
  const token = randomBytesFn(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: sha256Hex(token) };
}

/**
 * Constant-time check that `token` hashes to `tokenHash`. Never throws: an empty token, an
 * empty hash, or a length mismatch all resolve to `false` so a caller cannot distinguish
 * failure modes by timing or by exception shape.
 */
export function verifyCallToken(token: string, tokenHash: string): boolean {
  // Buffer.from(..., "hex") stops at the first invalid character, so the stored
  // hash is checked as exactly 64 lowercase hex digits before decoding.
  if (token.length === 0 || !STORED_HASH_PATTERN.test(tokenHash)) return false;
  const candidate = Buffer.from(sha256Hex(token), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}
