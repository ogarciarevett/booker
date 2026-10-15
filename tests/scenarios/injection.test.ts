import { afterEach, beforeEach, describe, expect, it } from "vitest";
import drivingSchoolBrief from "../../examples/errands/driving-school.example.json" with {
  type: "json",
};
import { INJECTOR_PERSONA } from "../../simulations/personas.ts";
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
  "a provider trying to inject a new budget with $name",
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

    it("rejects every attempt to record a budget field, leaving the errand and the offer untouched", async () => {
      const before = await stores.errands.get(ERRAND_ID);

      const runtime = personaRuntime(apps, {
        toolsKey,
        webhookSecret,
        now: () => NOW,
        personas: new Map([[NORTHSIDE, INJECTOR_PERSONA]]),
      });
      const call = await placeScenarioCall(stores, runtime, {
        id: "call-quote-injector",
        errandId: ERRAND_ID,
        providerId: NORTHSIDE,
        purpose: "quote",
        phoneE164: "+15555550100",
      });

      expect(call.status).toBe("completed");
      const externalId = call.externalId;
      if (externalId === null) throw new Error("expected the call to have an externalId");
      const steps = runtime.stepsFor(externalId);
      expect(steps).toHaveLength(3);
      expect(steps.every((step) => step.status === 422)).toBe(true);

      expect((await stores.errands.get(ERRAND_ID))?.spendLimits).toEqual(before?.spendLimits);
      expect(await stores.offers.forProvider(ERRAND_ID, NORTHSIDE)).toBeUndefined();

      const transcript = await stores.transcripts.findByCallId(call.id);
      expect(transcript?.turns.some((turn) => turn.message.includes("5,000 euros"))).toBe(true);
    });
  },
);
