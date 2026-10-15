import { afterEach, beforeEach, describe, expect, it } from "vitest";
import demoBrief from "../../examples/errands/demo.example.json" with { type: "json" };
import restaurantBrief from "../../examples/errands/restaurant.example.json" with { type: "json" };
import {
  HARBORVIEW_AGREED_TERMS,
  HARBORVIEW_COMMIT_PERSONA,
  HARBORVIEW_QUOTE_PERSONA,
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

const ERRAND_ID = "errand-restaurant-001";
const HARBORVIEW = "provider-harborview";
const OLDTOWN = "provider-oldtown";
const PARTICIPANTS = ["participant-a", "participant-b", "participant-c", "participant-d"];

function brief(input: unknown): ErrandBrief {
  const result = parseErrandBrief(input);
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

const CASES = SCENARIO_STORE_FACTORIES.flatMap((factory) =>
  [
    { label: "restaurant", input: restaurantBrief },
    { label: "demo", input: demoBrief },
  ].map((fixture) => ({ ...factory, ...fixture })),
);

describe.each(CASES)("$label errand end to end with $name", (factory) => {
  let stores: ScenarioStores;
  let apps: ScenarioApps;
  let toolsKey: string;
  let webhookSecret: string;

  beforeEach(async () => {
    stores = await factory.create();
    ({ toolsKey, webhookSecret } = toolsKeyAndSecret());
    await stores.errands.save(brief(factory.input), NOW);
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

  it("runs the same planCallRound / voice tools / rankOffers / commit path as the driving school, only the brief and personas differ", async () => {
    const round = planCallRound({ brief: brief(factory.input), calls: [] });
    expect(round).toEqual([HARBORVIEW, OLDTOWN]);

    const quoteRuntime = personaRuntime(apps, {
      toolsKey,
      webhookSecret,
      now: () => NOW,
      personas: new Map([[HARBORVIEW, HARBORVIEW_QUOTE_PERSONA]]),
    });
    const quoteCall = await placeScenarioCall(stores, quoteRuntime, {
      id: "call-quote-harborview",
      errandId: ERRAND_ID,
      providerId: HARBORVIEW,
      purpose: "quote",
      phoneE164: "+15555550102",
    });
    expect(quoteCall.status).toBe("completed");
    expect(await stores.transcripts.findByCallId(quoteCall.id)).toBeDefined();

    const offer = await stores.offers.forProvider(ERRAND_ID, HARBORVIEW);
    if (offer === undefined) throw new Error("expected the harborview offer to exist");
    const ranked = rankOffers(brief(factory.input), [offer]);
    expect(ranked[0]?.evaluation.status).toBe("eligible");
    expect(ranked[0]?.cost.total).toEqual(HARBORVIEW_AGREED_TERMS.total);

    const commitRuntime = personaRuntime(apps, {
      toolsKey,
      webhookSecret,
      now: () => NOW,
      personas: new Map([[HARBORVIEW, HARBORVIEW_COMMIT_PERSONA]]),
    });
    const commitCall = await placeScenarioCall(stores, commitRuntime, {
      id: "call-commit-harborview",
      errandId: ERRAND_ID,
      providerId: HARBORVIEW,
      purpose: "commit",
      phoneE164: "+15555550102",
    });
    const commitExternalId = commitCall.externalId;
    if (commitExternalId === null)
      throw new Error("expected the commit call to have an externalId");
    const steps = commitRuntime.stepsFor(commitExternalId);
    expect(steps).toMatchObject([
      { tool: "get-errand-context", status: 200 },
      { tool: "request-commit-permission", status: 200, body: { granted: true } },
      { tool: "report-commit-outcome", status: 200, body: { recorded: true } },
    ]);

    const booking = await stores.bookings.findOpen(ERRAND_ID);
    expect(booking).toMatchObject({
      providerId: HARBORVIEW,
      participantIds: PARTICIPANTS,
      status: "verbal",
    });
  }, 15_000);
});
