import { unknown } from "../offers/field.ts";
import type { Offer } from "../offers/offer.ts";
import { toCanonicalInstant } from "../shared/instants.ts";

/**
 * The offer draft a provider's calls write into: one per errand and provider, so every call to
 * the same provider (a quote call, a retry, the commit call) builds on the same draft. Each part
 * is URI-encoded, so a `:` inside an id can never make two different pairs collide.
 */
export function draftOfferId(errandId: string, providerId: string): string {
  return `offer-draft:${encodeURIComponent(errandId)}:${encodeURIComponent(providerId)}`;
}

/** A fresh draft with every field `unknown`, ready for the first recorded quote field. */
export function emptyOfferDraft(errandId: string, providerId: string, now: string): Offer {
  return {
    id: draftOfferId(errandId, providerId),
    errandId,
    providerId,
    queriedAt: toCanonicalInstant(now),
    seatsAvailable: unknown(),
    dates: unknown(),
    location: unknown(),
    costItems: [],
    deposit: unknown(),
    cancellationPenalty: unknown(),
    extras: [],
    customFields: {},
  };
}

/**
 * Port for the offers the voice tools read and write. `forProvider` returns the latest offer for
 * that errand and provider (greatest `queriedAt`, ties broken by the greater id), or `undefined`.
 * `save` inserts or replaces an offer by id. Every stored or returned offer is an independent
 * copy.
 */
export interface OfferStore {
  forProvider(errandId: string, providerId: string): Promise<Offer | undefined>;
  save(offer: Offer): Promise<void>;
}
