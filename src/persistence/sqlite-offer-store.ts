import { and, desc, eq, sql } from "drizzle-orm";
import type { OfferStore } from "../calls/offer-drafts.ts";
import type { Offer } from "../offers/offer.ts";
import { toCanonicalInstant } from "../shared/instants.ts";
import type { Database } from "./database.ts";
import { serialized } from "./database.ts";
import { offers } from "./schema.ts";
import { withBusyRetry } from "./sqlite-errors.ts";

/**
 * Drizzle + libsql `OfferStore`. `save` upserts by id and keeps `created_at` as the canonical UTC
 * form of the offer's `queriedAt`, so "latest" is a plain text ordering on that column. The
 * provider is read from the stored offer JSON, which needs no extra column or migration.
 */
export class SqliteOfferStore implements OfferStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async forProvider(errandId: string, providerId: string): Promise<Offer | undefined> {
    return await serialized(this.db, async () => {
      const [row] = await withBusyRetry(() =>
        this.db
          .select({ offer: offers.offer })
          .from(offers)
          .where(
            and(
              eq(offers.errandId, errandId),
              sql`json_extract(${offers.offer}, '$.providerId') = ${providerId}`,
            ),
          )
          .orderBy(desc(offers.createdAt), desc(offers.id))
          .limit(1),
      );
      return row?.offer;
    });
  }

  async save(offer: Offer): Promise<void> {
    await serialized(this.db, async () => {
      const createdAt = toCanonicalInstant(offer.queriedAt, "queriedAt");
      await withBusyRetry(() =>
        this.db
          .insert(offers)
          .values({ id: offer.id, errandId: offer.errandId, offer, createdAt })
          .onConflictDoUpdate({
            target: offers.id,
            set: { errandId: offer.errandId, offer, createdAt },
          }),
      );
    });
  }
}
