/**
 * Shared fixtures for tests/scenarios/*.test.ts: a full store set (in-memory and SQLite,
 * sharing one database, exactly like tests/voice-tools.http.test.ts and
 * tests/post-call-webhook.http.test.ts), the two HTTP apps a simulated call drives, and the
 * small helper that places a call through `SimulatedVoiceRuntime` and waits for it to settle.
 * The SQLite store set and the two apps come from the same wiring the real server uses
 * (`src/server/`), so the scenarios exercise exactly what `pnpm booker serve` runs.
 * Not a `*.test.ts` file itself, so vitest never collects it as a suite.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryBookingStore,
  InMemoryCommitGrantStore,
} from "../../src/bookings/adapters/in-memory.ts";
import { InMemoryCallStore } from "../../src/calls/adapters/in-memory-call-store.ts";
import { InMemoryErrandStore } from "../../src/calls/adapters/in-memory-errand-store.ts";
import { InMemoryOfferStore } from "../../src/calls/adapters/in-memory-offer-store.ts";
import { InMemoryTranscriptStore } from "../../src/calls/adapters/in-memory-transcript-store.ts";
import { InMemoryWebhookEventStore } from "../../src/calls/adapters/in-memory-webhook-events.ts";
import type { Persona } from "../../src/calls/adapters/simulated-voice.ts";
import { SimulatedVoiceRuntime } from "../../src/calls/adapters/simulated-voice.ts";
import { type Call, type CallPurpose, startCall } from "../../src/calls/call.ts";
import { issueCallToken } from "../../src/calls/call-token.ts";
import { migrate, openDatabase } from "../../src/persistence/database.ts";
import { parseStandingRules, type StandingRules } from "../../src/policies/standing-rules.ts";
import { type BookerApps, createBookerApps } from "../../src/server/apps.ts";
import { type BookerStores, createSqliteStores } from "../../src/server/stores.ts";

export const NOW = "2026-09-30T10:00:00.000Z";

/**
 * Tracks every call placed through `placeScenarioCall` on this store set, so `teardown` can
 * await them all (ignoring outcome) before the database closes. `placeScenarioCall` already
 * awaits each call's `settled()` itself, so this is belt-and-suspenders: it protects a future
 * scenario that stops doing that, or one that places a call without awaiting it directly.
 */
interface PendingCallTracker {
  track(runtime: SimulatedVoiceRuntime, externalId: string): void;
  drain(): Promise<void>;
}

function createPendingCallTracker(): PendingCallTracker {
  const pending: { runtime: SimulatedVoiceRuntime; externalId: string }[] = [];
  return {
    track(runtime, externalId) {
      pending.push({ runtime, externalId });
    },
    async drain() {
      await Promise.allSettled(
        pending.map(({ runtime, externalId }) => runtime.settled(externalId)),
      );
    },
  };
}

export interface ScenarioStores extends BookerStores {
  readonly trackPlacedCall: (runtime: SimulatedVoiceRuntime, externalId: string) => void;
  readonly teardown: () => Promise<void>;
}

export const SCENARIO_STORE_FACTORIES: readonly {
  name: string;
  create: () => Promise<ScenarioStores>;
}[] = [
  {
    name: "in-memory stores",
    create: async () => {
      const tracker = createPendingCallTracker();
      return {
        calls: new InMemoryCallStore(),
        errands: new InMemoryErrandStore(),
        offers: new InMemoryOfferStore(),
        grants: new InMemoryCommitGrantStore(),
        bookings: new InMemoryBookingStore(),
        transcripts: new InMemoryTranscriptStore(),
        events: new InMemoryWebhookEventStore(),
        trackPlacedCall: tracker.track,
        teardown: () => tracker.drain(),
      };
    },
  },
  {
    name: "SQLite stores sharing one database",
    create: async () => {
      const tracker = createPendingCallTracker();
      const dir = mkdtempSync(join(tmpdir(), "booker-scenarios-"));
      const db = openDatabase(`file:${join(dir, "test.db")}`);
      await migrate(db);
      return {
        ...createSqliteStores(db),
        trackPlacedCall: tracker.track,
        teardown: async () => {
          await tracker.drain();
          db.$client.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

/** Standing rules a scenario can override; `autoBookWithinRules` defaults to true so the
 * scenarios that expect an automatic grant do not have to repeat it. */
export function standingRules(overrides: Record<string, unknown> = {}): StandingRules {
  const result = parseStandingRules({ autoBookWithinRules: true, ...overrides });
  if (!result.ok) throw new Error(`invalid fixture standing rules: ${result.issues.join(", ")}`);
  return result.rules;
}

export type ScenarioApps = BookerApps;

/** Builds the two HTTP apps a simulated call drives, sharing one clock and one store set. */
export function createScenarioApps(
  stores: ScenarioStores,
  options: {
    readonly toolsKey: string;
    readonly webhookSecret: string;
    readonly now: () => string;
    readonly rules: () => StandingRules;
  },
): ScenarioApps {
  return createBookerApps(stores, {
    toolsKey: options.toolsKey,
    webhookSecret: options.webhookSecret,
    now: options.now,
    standingRules: options.rules,
  });
}

export interface PlaceScenarioCallInput {
  readonly id: string;
  readonly errandId: string;
  readonly providerId: string;
  readonly purpose: CallPurpose;
  readonly attempt?: number;
  readonly phoneE164: string;
}

/**
 * Creates a call with a fresh token, places it through `runtime`, records the provider's
 * conversation id on the call (the orchestration workflow's job — the port itself never
 * touches `CallStore`), and awaits the persona script and its post-call webhook. Returns the
 * call as the webhook left it.
 */
export async function placeScenarioCall(
  stores: ScenarioStores,
  runtime: SimulatedVoiceRuntime,
  input: PlaceScenarioCallInput,
): Promise<Call> {
  const { token, tokenHash } = issueCallToken();
  const call = startCall({
    id: input.id,
    errandId: input.errandId,
    providerId: input.providerId,
    purpose: input.purpose,
    attempt: input.attempt ?? 1,
    tokenHash,
    now: NOW,
  });
  const created = await stores.calls.create(call);
  if (!created.ok) throw new Error(`could not create call ${input.id}: ${created.reason}`);

  const { externalId } = await runtime.placeCall({
    call,
    phoneE164: input.phoneE164,
    dynamicVariables: { call_id: call.id, call_token: token },
  });
  stores.trackPlacedCall(runtime, externalId);
  const updated = await stores.calls.update({ ...call, externalId });
  if (!updated.ok)
    throw new Error(`could not set externalId on call ${input.id}: ${updated.reason}`);
  // `personaRuntime` builds every runtime with `startAfterRegistration: true`, so the script
  // only starts now — deterministically, not by racing the write above against a timer.
  runtime.registered(externalId);

  await runtime.settled(externalId);
  const ended = await stores.calls.findById(input.id);
  if (ended === undefined) throw new Error(`expected call ${input.id} to still exist`);
  return ended;
}

/** A fresh, fictional-strength tools key or webhook secret, distinct on every call. */
function randomHex(): string {
  return randomBytes(24).toString("hex");
}

export function toolsKeyAndSecret(): { readonly toolsKey: string; readonly webhookSecret: string } {
  return { toolsKey: randomHex(), webhookSecret: randomHex() };
}

export function personaRuntime(
  apps: ScenarioApps,
  options: {
    readonly toolsKey: string;
    readonly webhookSecret: string;
    readonly now: () => string;
    readonly personas: ReadonlyMap<string, Persona>;
  },
): SimulatedVoiceRuntime {
  return new SimulatedVoiceRuntime({
    voiceToolsApp: apps.voiceToolsApp,
    postCallWebhookApp: apps.postCallWebhookApp,
    toolsKey: options.toolsKey,
    webhookSecret: options.webhookSecret,
    now: options.now,
    personas: options.personas,
    // Deterministic start: `placeScenarioCall` calls `registered` right after recording
    // `externalId`, so no scenario depends on outracing a webhook retry timer.
    startAfterRegistration: true,
  });
}
