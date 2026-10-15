import { afterEach, beforeEach, describe, expect, it } from "vitest";
import drivingSchoolBrief from "../../examples/errands/driving-school.example.json" with {
  type: "json",
};
import { BUSY_PROVIDER_PERSONA } from "../../simulations/personas.ts";
import { planCallRound } from "../../src/calls/planning.ts";
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
const HARBOR = "provider-harbor";

function brief(): ErrandBrief {
  const result = parseErrandBrief(drivingSchoolBrief);
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

describe.each(SCENARIO_STORE_FACTORIES)("a provider that never answers with $name", (factory) => {
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

  it("ends each attempt as no_answer, gets offered again under the attempt cap, and not after it", async () => {
    const runtime = personaRuntime(apps, {
      toolsKey,
      webhookSecret,
      now: () => NOW,
      personas: new Map([[NORTHSIDE, BUSY_PROVIDER_PERSONA]]),
    });

    const firstAttempt = await placeScenarioCall(stores, runtime, {
      id: "call-northside-attempt-1",
      errandId: ERRAND_ID,
      providerId: NORTHSIDE,
      purpose: "quote",
      attempt: 1,
      phoneE164: "+15555550100",
    });
    expect(firstAttempt.status).toBe("no_answer");
    expect(await stores.transcripts.findByCallId(firstAttempt.id)).toBeUndefined();

    const afterFirstAttempt = planCallRound({ brief: brief(), calls: [firstAttempt] });
    expect(afterFirstAttempt).toEqual([NORTHSIDE, HARBOR]);

    const secondAttempt = await placeScenarioCall(stores, runtime, {
      id: "call-northside-attempt-2",
      errandId: ERRAND_ID,
      providerId: NORTHSIDE,
      purpose: "quote",
      attempt: 2,
      phoneE164: "+15555550100",
    });
    expect(secondAttempt.status).toBe("no_answer");

    const afterSecondAttempt = planCallRound({
      brief: brief(),
      calls: [firstAttempt, secondAttempt],
    });
    expect(afterSecondAttempt).toEqual([HARBOR]);
  });
});
