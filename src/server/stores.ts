import type { CommitGrantStore } from "../bookings/commit-grant.ts";
import type { BookingStore } from "../bookings/ledger.ts";
import type { LiveCallStore } from "../calls/call-store.ts";
import type { ErrandStore } from "../calls/errand-store.ts";
import type { OfferStore } from "../calls/offer-drafts.ts";
import type { TranscriptStore } from "../calls/transcript-store.ts";
import type { WebhookEventStore } from "../calls/webhook-events.ts";
import type { Database } from "../persistence/database.ts";
import { SqliteBookingStore } from "../persistence/sqlite-booking-store.ts";
import { SqliteCallStore } from "../persistence/sqlite-call-store.ts";
import { SqliteCommitGrantStore } from "../persistence/sqlite-commit-grant-store.ts";
import { SqliteErrandStore } from "../persistence/sqlite-errand-store.ts";
import { SqliteOfferStore } from "../persistence/sqlite-offer-store.ts";
import { SqliteTranscriptStore } from "../persistence/sqlite-transcript-store.ts";
import { SqliteWebhookEventStore } from "../persistence/sqlite-webhook-event-store.ts";

/** Every store the voice tools and the post-call webhook read and write. */
export interface BookerStores {
  readonly calls: LiveCallStore;
  readonly errands: ErrandStore;
  readonly offers: OfferStore;
  readonly grants: CommitGrantStore;
  readonly bookings: BookingStore;
  readonly transcripts: TranscriptStore;
  readonly events: WebhookEventStore;
}

/** The SQLite store set on one migrated database; every store queues on `db`'s file. */
export function createSqliteStores(db: Database): BookerStores {
  return {
    calls: new SqliteCallStore(db),
    errands: new SqliteErrandStore(db),
    offers: new SqliteOfferStore(db),
    grants: new SqliteCommitGrantStore(db),
    bookings: new SqliteBookingStore(db),
    transcripts: new SqliteTranscriptStore(db),
    events: new SqliteWebhookEventStore(db),
  };
}
