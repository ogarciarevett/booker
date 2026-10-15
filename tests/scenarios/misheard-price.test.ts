import { afterEach, beforeEach, describe, expect, it } from "vitest";
import drivingSchoolBrief from "../../examples/errands/driving-school.example.json" with {
  type: "json",
};
import {
  NORTHSIDE_AGREED_TERMS,
  NORTHSIDE_MISHEARD_COMMIT_PERSONA,
  NORTHSIDE_QUOTE_PERSONA,
} from "../../simulations/personas.ts";
import { type ErrandBrief, parseErrandBrief } from "../../src/errands/brief.ts";
import { evaluateOffer } from "../../src/offers/evaluation.ts";
import { authorizeCommit } from "../../src/policies/authorization.ts";
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
  "a commit call quoting a total one cent off with $name",
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

    it("is not granted permission, and no grant or booking exists", async () => {
      const quoteRuntime = personaRuntime(apps, {
        toolsKey,
        webhookSecret,
        now: () => NOW,
        personas: new Map([[NORTHSIDE, NORTHSIDE_QUOTE_PERSONA]]),
      });
      const quoteCall = await placeScenarioCall(stores, quoteRuntime, {
        id: "call-quote-northside",
        errandId: ERRAND_ID,
        providerId: NORTHSIDE,
        purpose: "quote",
        phoneE164: "+15555550100",
      });
      expect(quoteCall.status).toBe("completed");

      // Attribution: prove the offer itself is eligible at the agreed total, and that the
      // exact same total would have been granted — so the one-cent mismatch below is the only
      // reason permission is denied, not some other defect in the offer or standing rules.
      const offer = await stores.offers.forProvider(ERRAND_ID, NORTHSIDE);
      if (offer === undefined) throw new Error("expected the northside offer to exist");
      const evaluation = evaluateOffer(brief(), offer);
      expect(evaluation.status).toBe("eligible");
      if (offer.dates.status !== "known") throw new Error("expected offer.dates to be known");
      const wouldGrantExactTotal = authorizeCommit({
        brief: brief(),
        rules: drivingSchoolStandingRules(),
        offer,
        quoted: {
          total: NORTHSIDE_AGREED_TERMS.total,
          deposit: NORTHSIDE_AGREED_TERMS.deposit,
          dates: offer.dates.value,
        },
      });
      expect(wouldGrantExactTotal.decision).toBe("auto");

      const commitRuntime = personaRuntime(apps, {
        toolsKey,
        webhookSecret,
        now: () => NOW,
        personas: new Map([[NORTHSIDE, NORTHSIDE_MISHEARD_COMMIT_PERSONA]]),
      });
      const commitCall = await placeScenarioCall(stores, commitRuntime, {
        id: "call-commit-northside",
        errandId: ERRAND_ID,
        providerId: NORTHSIDE,
        purpose: "commit",
        phoneE164: "+15555550100",
      });

      const externalId = commitCall.externalId;
      if (externalId === null) throw new Error("expected the commit call to have an externalId");
      const steps = commitRuntime.stepsFor(externalId);
      const permissionStep = steps.find((step) => step.tool === "request-commit-permission");
      expect(permissionStep).toMatchObject({ status: 200, body: { granted: false } });

      expect(await stores.grants.findActive(ERRAND_ID, NOW)).toBeUndefined();
      expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
    });
  },
);
