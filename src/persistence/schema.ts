import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { GrantStatus } from "../bookings/commit-grant.ts";
import type { BookingHistoryEntry, BookingStatus } from "../bookings/ledger.ts";
import type { CallPurpose, CallStatus } from "../calls/call.ts";
import type { TranscriptTurn } from "../calls/transcript-store.ts";
import type { ErrandBrief } from "../errands/brief.ts";
import type { Offer } from "../offers/offer.ts";

/**
 * Drizzle table definitions for Booker's SQLite persistence. Every timestamp
 * is an ISO datetime string produced by the caller's injected clock (`now`),
 * never a database-generated value, so behavior stays deterministic in tests.
 * `persistence` is not a domain module (see `tests/architecture.test.ts`), so
 * importing domain types here to brand JSON columns is allowed.
 */

export const errands = sqliteTable("errands", {
  id: text("id").primaryKey(),
  brief: text("brief", { mode: "json" }).notNull().$type<ErrandBrief>(),
  createdAt: text("created_at").notNull(),
});

export const offers = sqliteTable("offers", {
  id: text("id").primaryKey(),
  errandId: text("errand_id").notNull(),
  offer: text("offer", { mode: "json" }).notNull().$type<Offer>(),
  createdAt: text("created_at").notNull(),
});

/**
 * One row per placed call (see `Call` in `src/calls/call.ts`). `tokenHash` is the SHA-256 of the
 * per-call token, never the token itself. `activeGrantToken` binds the commit grant this call
 * acquired, so the voice agent never has to carry it, and `activeGrantTermsDigest` holds the
 * `offerTermsDigest` of the offer that grant authorized; both are null when the call holds none.
 * A non-null `external_id` is unique: two calls can never share one voice provider conversation.
 * `callSid` is Twilio's id for the phone leg of a placed call, kept only to hang it up.
 */
export const calls = sqliteTable(
  "calls",
  {
    id: text("id").primaryKey(),
    errandId: text("errand_id").notNull(),
    providerId: text("provider_id").notNull(),
    purpose: text("purpose").notNull().$type<CallPurpose>(),
    status: text("status").notNull().$type<CallStatus>(),
    attempt: integer("attempt").notNull(),
    tokenHash: text("token_hash").notNull(),
    externalId: text("external_id"),
    createdAt: text("created_at").notNull(),
    endedAt: text("ended_at"),
    activeGrantToken: text("active_grant_token"),
    activeGrantTermsDigest: text("active_grant_terms_digest"),
    callSid: text("call_sid"),
  },
  (table) => [
    // Only a non-null external_id is constrained: many calls may still hold no conversation yet.
    uniqueIndex("calls_external_id_idx")
      .on(table.externalId)
      .where(sql`${table.externalId} is not null`),
  ],
);

/**
 * Audit trail written once, by the 0006 migration, for every call whose `external_id` it cleared
 * to satisfy `calls_external_id_idx` above: `externalId` is what that call held before clearing,
 * and `keptCallId` is the call (the first-inserted one, lowest rowid, per external_id) that kept
 * it — so a wrong automatic pairing can still be relinked by hand instead of the data simply
 * being lost. Nothing else in this codebase writes to this table.
 */
export const callExternalIdConflicts = sqliteTable("call_external_id_conflicts", {
  callId: text("call_id").primaryKey(),
  externalId: text("external_id").notNull(),
  keptCallId: text("kept_call_id").notNull(),
  clearedAt: text("cleared_at").notNull(),
});

/** Commit grant status, mirrors `GrantStatus` in `src/bookings/commit-grant.ts`. */
export const commitGrants = sqliteTable(
  "commit_grants",
  {
    id: text("id").primaryKey(),
    errandId: text("errand_id").notNull(),
    offerId: text("offer_id").notNull(),
    token: text("token").notNull().unique(),
    status: text("status").notNull().$type<GrantStatus>(),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    // At most one active grant per errand; expired/consumed/revoked rows are exempt.
    uniqueIndex("commit_grants_active_errand_idx")
      .on(table.errandId)
      .where(sql`${table.status} = 'active'`),
  ],
);

/**
 * One row per webhook `eventKey` ever claimed, backing a claim/complete/release lease (see
 * `src/calls/webhook-events.ts`). `eventKey` is built by `elevenLabsEventKey(type,
 * conversationId)`, never a bare `conversation_id`, since a transcription and an audio event
 * for the same conversation must claim independently. `status` starts `"pending"` at
 * `claimedAt` and moves to `"completed"` at `completedAt`; a `"pending"` row past its
 * `leaseExpiresAt` may be re-claimed (crash recovery). `claimToken` identifies the current claim
 * generation so a stale holder whose lease already expired can never `complete`/`release` a
 * claim someone else has since re-claimed. Both columns are nullable because rows migrated from
 * the first (pre-lease) scheme land here already `"completed"`, with no claim generation of
 * their own to track.
 */
export const webhookEvents = sqliteTable("webhook_events", {
  eventKey: text("event_key").primaryKey(),
  payloadSha256: text("payload_sha256").notNull(),
  status: text("status").notNull().$type<"pending" | "completed">(),
  claimedAt: text("claimed_at").notNull(),
  completedAt: text("completed_at"),
  claimToken: text("claim_token"),
  leaseExpiresAt: text("lease_expires_at"),
});

/**
 * One row per call whose post-call transcription webhook was processed (see
 * `src/calls/transcript-store.ts`). `turns` holds only the minimized shape: role, message, and
 * seconds into the call for each turn — never audio, analysis, or any other webhook field.
 * `receivedAt` backs the retention purge (`purgeReceivedBefore`).
 */
export const callTranscripts = sqliteTable("call_transcripts", {
  callId: text("call_id").primaryKey(),
  receivedAt: text("received_at").notNull(),
  turns: text("turns", { mode: "json" }).notNull().$type<readonly TranscriptTurn[]>(),
});

/** Booking status, mirrors `BookingStatus` in `src/bookings/ledger.ts`. */
export const bookings = sqliteTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    errandId: text("errand_id").notNull(),
    offerId: text("offer_id").notNull(),
    providerId: text("provider_id").notNull(),
    participantIds: text("participant_ids", { mode: "json" }).notNull().$type<readonly string[]>(),
    status: text("status").notNull().$type<BookingStatus>(),
    history: text("history", { mode: "json" }).notNull().$type<readonly BookingHistoryEntry[]>(),
  },
  (table) => [
    // At most one non-cancelled (open) booking per errand.
    uniqueIndex("bookings_open_errand_idx")
      .on(table.errandId)
      .where(sql`${table.status} <> 'cancelled'`),
  ],
);

/**
 * Non-secret settings saved from the dashboard, one row per catalog name (see
 * `src/settings/catalog.ts`). Secrets never land here: they go to the macOS Keychain.
 * `updatedAt` comes from the caller's clock like every other timestamp.
 */
export const settings = sqliteTable("settings", {
  name: text("name").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});
