import type { Hono } from "hono";
import type { CommitGrantStore } from "../bookings/commit-grant.ts";
import type { BookingStore } from "../bookings/ledger.ts";
import type { LiveCallStore } from "../calls/call-store.ts";
import type { ErrandStore } from "../calls/errand-store.ts";
import type { OfferStore } from "../calls/offer-drafts.ts";
import type { ErrandBrief } from "../errands/brief.ts";
import type { Offer } from "../offers/offer.ts";
import { type ErrandOverview, errandOverview } from "../overview/errand-overview.ts";
import { maskPhone } from "../shared/phone.ts";

export interface ErrandRouteDeps {
  readonly calls: LiveCallStore;
  readonly errands: ErrandStore;
  readonly offers: OfferStore;
  readonly grants: CommitGrantStore;
  readonly bookings: BookingStore;
  readonly now: () => string;
  /** Parses `?limit=`: a whole number from 1 to 200, the default when absent, else `undefined`. */
  readonly listLimit: (raw: string | undefined) => number | undefined;
}

const NOT_FOUND = { error: "not_found" } as const;
const INVALID_REQUEST = { error: "invalid_request" } as const;

/** Everything `errandOverview` needs for one errand, read from the stores at once. */
async function overviewOf(deps: ErrandRouteDeps, brief: ErrandBrief): Promise<ErrandOverview> {
  const now = deps.now();
  const [calls, offerList, booking, grant] = await Promise.all([
    deps.calls.listByErrand(brief.id),
    Promise.all(brief.providers.map((provider) => deps.offers.forProvider(brief.id, provider.id))),
    deps.bookings.findOpen(brief.id),
    deps.grants.findActive(brief.id, now),
  ]);
  const offers = offerList.filter((offer): offer is Offer => offer !== undefined);
  const grantOffer =
    grant === undefined ? undefined : offers.find((offer) => offer.id === grant.offerId);
  return errandOverview({
    brief,
    calls,
    offers,
    booking,
    // A grant whose offer is not among the drafts is still active: it is shown, its provider
    // unknown, rather than dropped.
    activeGrant:
      grant === undefined
        ? undefined
        : { providerId: grantOffer?.providerId ?? null, expiresAt: grant.expiresAt },
    now,
  });
}

/** One errand as both routes show it. */
function summaryView(overview: ErrandOverview) {
  return {
    errandId: overview.errandId,
    kind: overview.kind,
    objective: overview.objective,
    stage: overview.stage,
    counts: overview.counts,
    progress: overview.progress,
    providerCount: overview.providers.length,
    leadingProviderId: overview.missing.leadingProviderId,
    lastActivityAt: overview.lastActivityAt,
  };
}

/** One errand in full; a provider's number is masked to its last four digits. */
function detailView(overview: ErrandOverview) {
  return {
    ...summaryView(overview),
    providers: overview.providers.map(({ phoneE164, ...provider }) => ({
      ...provider,
      phone: maskPhone(phoneE164),
    })),
    ranking: overview.ranking,
    missing: overview.missing,
  };
}

/**
 * The owner's errands, behind the control token like every control route:
 * `GET /control/errands?limit=` lists the most recent errands with their stage, counts, and
 * progress, and `GET /control/errands/:id` adds each provider's outcome and reason, the ranked
 * quotes, and what is missing to close (see `errandOverview`). Never a token, a token hash, or a
 * full phone number.
 */
export function mountErrandRoutes(app: Hono, deps: ErrandRouteDeps): void {
  app.get("/control/errands", async (c) => {
    const limit = deps.listLimit(c.req.query("limit"));
    if (limit === undefined) return c.json(INVALID_REQUEST, 400);
    const stored = await deps.errands.listRecent(limit);
    const errands = await Promise.all(
      stored.map(async ({ brief, createdAt }) => ({
        ...summaryView(await overviewOf(deps, brief)),
        createdAt,
      })),
    );
    return c.json({ errands });
  });

  app.get("/control/errands/:id", async (c) => {
    const errandId = c.req.param("id");
    const brief = await deps.errands.get(errandId);
    if (brief === undefined) return c.json(NOT_FOUND, 404);
    return c.json(detailView(await overviewOf(deps, brief)));
  });
}
