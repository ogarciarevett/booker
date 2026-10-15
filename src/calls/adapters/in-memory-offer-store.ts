import type { Offer } from "../../offers/offer.ts";
import { instantMillis } from "../../shared/instants.ts";
import type { OfferStore } from "../offer-drafts.ts";

/** True when `a` is later than `b`: greater `queriedAt` instant, ties broken by the greater id. */
function isLater(a: Offer, b: Offer): boolean {
  const difference =
    instantMillis(a.queriedAt, "queriedAt") - instantMillis(b.queriedAt, "queriedAt");
  return difference !== 0 ? difference > 0 : a.id > b.id;
}

/**
 * In-memory `OfferStore`, useful for tests and the shared contract suite. Not safe across
 * processes; the SQLite adapter is the durable one.
 */
export class InMemoryOfferStore implements OfferStore {
  private readonly offers = new Map<string, Offer>();

  async forProvider(errandId: string, providerId: string): Promise<Offer | undefined> {
    let latest: Offer | undefined;
    for (const offer of this.offers.values()) {
      if (offer.errandId !== errandId || offer.providerId !== providerId) continue;
      if (latest === undefined || isLater(offer, latest)) latest = offer;
    }
    return latest === undefined ? undefined : structuredClone(latest);
  }

  async save(offer: Offer): Promise<void> {
    instantMillis(offer.queriedAt, "queriedAt");
    this.offers.set(offer.id, structuredClone(offer));
  }
}
