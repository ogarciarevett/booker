import { afterEach, beforeEach, describe, expect, it } from "vitest";
import drivingSchoolBrief from "../../examples/errands/driving-school.example.json" with {
  type: "json",
};
import { COMMIT_TOOLS_ON_QUOTE_CALL_PERSONA } from "../../simulations/personas.ts";
import { type ErrandBrief, parseErrandBrief } from "../../src/errands/brief.ts";
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

describe.each(SCENARIO_STORE_FACTORIES)(
  "a quote-purpose call trying both commit tools with $name",
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
        rules: standingRules,
      });
    });

    afterEach(async () => {
      await stores.teardown();
    });

    it("gets 403 for request-commit-permission and report-commit-outcome, and nothing changes", async () => {
      const runtime = personaRuntime(apps, {
        toolsKey,
        webhookSecret,
        now: () => NOW,
        personas: new Map([[NORTHSIDE, COMMIT_TOOLS_ON_QUOTE_CALL_PERSONA]]),
      });
      const call = await placeScenarioCall(stores, runtime, {
        id: "call-quote-northside",
        errandId: ERRAND_ID,
        providerId: NORTHSIDE,
        purpose: "quote",
        phoneE164: "+15555550100",
      });

      const externalId = call.externalId;
      if (externalId === null) throw new Error("expected the call to have an externalId");
      const steps = runtime.stepsFor(externalId);
      expect(steps.map((step) => ({ tool: step.tool, status: step.status }))).toEqual([
        { tool: "request-commit-permission", status: 403 },
        { tool: "report-commit-outcome", status: 403 },
      ]);

      expect(await stores.grants.findActive(ERRAND_ID, NOW)).toBeUndefined();
      expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
      expect(await stores.offers.forProvider(ERRAND_ID, NORTHSIDE)).toBeUndefined();
    });
  },
);
