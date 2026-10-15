import { instantMillis } from "../shared/instants.ts";

const MILLISECONDS_PER_SECOND = 1_000;

/**
 * A commit grant authorizes exactly one in-flight attempt to book an offer for
 * an errand. At most one grant may be active per errand at a time; that
 * exclusivity is enforced by a `CommitGrantStore`, not by this type itself.
 */
export type GrantStatus = "active" | "consumed" | "revoked" | "expired";

export interface CommitGrant {
  readonly id: string;
  readonly errandId: string;
  readonly offerId: string;
  readonly token: string;
  readonly status: GrantStatus;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Generates a fresh opaque id or token. Injected so tests stay deterministic. */
export type IdGenerator = () => string;

export interface NewGrantInput {
  readonly id: string;
  readonly errandId: string;
  readonly offerId: string;
  readonly token: string;
  readonly now: string;
  readonly ttlSeconds: number;
}

/** Builds a fresh, active CommitGrant expiring `ttlSeconds` after `now`. */
export function newGrant(input: NewGrantInput): CommitGrant {
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new RangeError(`newGrant ttlSeconds must be a positive integer, got ${input.ttlSeconds}`);
  }
  const issuedMillis = instantMillis(input.now);
  return {
    id: input.id,
    errandId: input.errandId,
    offerId: input.offerId,
    token: input.token,
    status: "active",
    issuedAt: new Date(issuedMillis).toISOString(),
    expiresAt: new Date(issuedMillis + input.ttlSeconds * MILLISECONDS_PER_SECOND).toISOString(),
  };
}

/**
 * True only for a grant marked active whose expiry has not yet been reached.
 * Times are compared as instants, never as text, so offsets cannot flip expiry.
 */
export function isGrantActive(grant: CommitGrant, now: string): boolean {
  return (
    grant.status === "active" && instantMillis(now) < instantMillis(grant.expiresAt, "expiresAt")
  );
}

export interface AcquireGrantInput {
  readonly errandId: string;
  readonly offerId: string;
  readonly now: string;
  readonly ttlSeconds: number;
}

export type AcquireGrantResult =
  | { readonly granted: true; readonly grant: CommitGrant }
  | { readonly granted: false; readonly reason: "another_active_grant" };

export type ConsumeGrantResult =
  | { readonly ok: true; readonly grant: CommitGrant }
  | { readonly ok: false; readonly reason: "unknown_token" | "not_active" | "expired" };

/**
 * Port for persisting commit grants. `acquire` first expires any grant past
 * its `expiresAt`, then either issues a fresh active grant (ids and the token
 * come from an injected `IdGenerator`) or reports the errand already has one.
 * Implementations must make `acquire` safe under concurrency: at most one
 * caller may ever receive `granted: true` for the same errand.
 */
export interface CommitGrantStore {
  acquire(input: AcquireGrantInput): Promise<AcquireGrantResult>;
  consume(token: string, now: string): Promise<ConsumeGrantResult>;
  revokeAll(errandId: string, now: string): Promise<number>;
  findActive(errandId: string, now: string): Promise<CommitGrant | undefined>;
}
