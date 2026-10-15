import { afterEach, beforeEach, describe, expect, it } from "vitest";
import drivingSchoolBrief from "../../examples/errands/driving-school.example.json" with {
  type: "json",
};
import {
  HARBOR_QUOTE_PERSONA,
  NORTHSIDE_AGREED_TERMS,
  NORTHSIDE_COMMIT_PERSONA,
  NORTHSIDE_QUOTE_PERSONA,
} from "../../simulations/personas.ts";
import { planCallRound } from "../../src/calls/planning.ts";
import { type ErrandBrief, parseErrandBrief } from "../../src/errands/brief.ts";
import { rankOffers } from "../../src/offers/ranking.ts";
import {
  createScenarioApps,
  NOW,
  personaRuntime,
  placeScenarioCall,
  SCENARIO_STORE_FACTORIES,
  type ScenarioApps,
  type ScenarioStores,
  standingRules,
  toolsKeyAndSecret,
} from "./support.ts";

const ERRAND_ID = "errand-driving-school-001";
const NORTHSIDE = "provider-northside";
const HARBOR = "provider-harbor";

function brief(): ErrandBrief {
  const result = parseErrandBrief(drivingSchoolBrief);
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

function drivingSchoolStandingRules() {
  return standingRules({
    allowedWindows: [{ start: "2026-10-15", end: "2026-11-30" }],
    maxTotal: { amountCents: 240_000, currency: "EUR" },
    maxDeposit: { amountCents: 20_000, currency: "EUR" },
    maxCancellationPenalty: { amountCents: 10_000, currency: "EUR" },
  });
}

describe.each(SCENARIO_STORE_FACTORIES)(
  "driving-school errand end to end with $name",
  (factory) => {
    let stores: ScenarioStores;
    let apps: ScenarioApps;
    let toolsKey: string;
    let webhookSecret: string;

    beforeEach(async () => {
      stores = await factory.create();
      ({ toolsKey, webhookSecret } = toolsKeyAndSecret());
      await stores.errands.save(brief(), NOW);
      apps = createScenarioApps(stores, {
        toolsKey,
        webhookSecret,
        now: () => NOW,
        rules: drivingSchoolStandingRules,
      });
    });

    afterEach(async () => {
      await stores.teardown();
    });

    it("quotes both providers, ranks the fully confirmed one first, then books it verbally", async () => {
      const round = planCallRound({ brief: brief(), calls: [] });
      expect(round).toEqual([NORTHSIDE, HARBOR]);

      const quoteRuntime = personaRuntime(apps, {
        toolsKey,
        webhookSecret,
        now: () => NOW,
        personas: new Map([
          [NORTHSIDE, NORTHSIDE_QUOTE_PERSONA],
          [HARBOR, HARBOR_QUOTE_PERSONA],
        ]),
      });

      const [northsideCall, harborCall] = await Promise.all([
        placeScenarioCall(stores, quoteRuntime, {
          id: "call-quote-northside",
          errandId: ERRAND_ID,
          providerId: NORTHSIDE,
          purpose: "quote",
          phoneE164: "+15555550100",
        }),
        placeScenarioCall(stores, quoteRuntime, {
          id: "call-quote-harbor",
          errandId: ERRAND_ID,
          providerId: HARBOR,
          purpose: "quote",
          phoneE164: "+15555550101",
        }),
      ]);

      expect(northsideCall.status).toBe("completed");
      expect(harborCall.status).toBe("completed");
      expect(await stores.transcripts.findByCallId(northsideCall.id)).toBeDefined();
      expect(await stores.transcripts.findByCallId(harborCall.id)).toBeDefined();

      const northsideOffer = await stores.offers.forProvider(ERRAND_ID, NORTHSIDE);
      const harborOffer = await stores.offers.forProvider(ERRAND_ID, HARBOR);
      if (northsideOffer === undefined || harborOffer === undefined) {
        throw new Error("expected both offers to exist");
      }

      const ranked = rankOffers(brief(), [harborOffer, northsideOffer]);
      expect(ranked[0]?.offer.providerId).toBe(NORTHSIDE);
      expect(ranked[0]?.evaluation.status).toBe("eligible");
      expect(ranked[0]?.cost.total).toEqual(NORTHSIDE_AGREED_TERMS.total);
      expect(ranked[1]?.offer.providerId).toBe(HARBOR);
      expect(ranked[1]?.evaluation.status).toBe("incomplete");

      const commitRuntime = personaRuntime(apps, {
        toolsKey,
        webhookSecret,
        now: () => NOW,
        personas: new Map([[NORTHSIDE, NORTHSIDE_COMMIT_PERSONA]]),
      });
      const commitCall = await placeScenarioCall(stores, commitRuntime, {
        id: "call-commit-northside",
        errandId: ERRAND_ID,
        providerId: NORTHSIDE,
        purpose: "commit",
        phoneE164: "+15555550100",
      });

      const commitExternalId = commitCall.externalId;
      if (commitExternalId === null)
        throw new Error("expected the commit call to have an externalId");
      const steps = commitRuntime.stepsFor(commitExternalId);
      expect(steps.map((step) => step.tool)).toEqual([
        "get-errand-context",
        "request-commit-permission",
        "report-commit-outcome",
      ]);
      expect(steps[1]).toMatchObject({ status: 200, body: { granted: true } });
      expect(steps[2]).toMatchObject({ status: 200, body: { recorded: true } });

      const booking = await stores.bookings.findOpen(ERRAND_ID);
      expect(booking).toMatchObject({
        providerId: NORTHSIDE,
        participantIds: ["participant-a", "participant-b"],
        status: "verbal",
      });
      expect(await stores.grants.findActive(ERRAND_ID, NOW)).toBeUndefined();
    }, 15_000);
  },
);
