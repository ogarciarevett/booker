import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  InMemoryBookingStore,
  InMemoryCommitGrantStore,
} from "../../bookings/adapters/in-memory.ts";
import { parseErrandBrief } from "../../errands/brief.ts";
import { createPostCallWebhookApp } from "../../http/post-call-webhook.ts";
import { createVoiceToolsApp } from "../../http/voice-tools.ts";
import { migrate, openDatabase } from "../../persistence/database.ts";
import { SqliteCallStore } from "../../persistence/sqlite-call-store.ts";
import { SqliteTranscriptStore } from "../../persistence/sqlite-transcript-store.ts";
import { SqliteWebhookEventStore } from "../../persistence/sqlite-webhook-event-store.ts";
import { parseStandingRules } from "../../policies/standing-rules.ts";
import { startCall } from "../call.ts";
import { issueCallToken } from "../call-token.ts";
import { InMemoryCallStore } from "./in-memory-call-store.ts";
import { InMemoryErrandStore } from "./in-memory-errand-store.ts";
import { InMemoryOfferStore } from "./in-memory-offer-store.ts";
import { InMemoryTranscriptStore } from "./in-memory-transcript-store.ts";
import { InMemoryWebhookEventStore } from "./in-memory-webhook-events.ts";
import {
  type Persona,
  SimulatedVoiceRuntime,
  type SimulatedVoiceRuntimeDeps,
} from "./simulated-voice.ts";

const NOW = "2026-09-30T10:00:00.000Z";
const ERRAND_ID = "errand-001";
const PROVIDER_ID = "provider-northside";

function brief() {
  const result = parseErrandBrief({
    id: ERRAND_ID,
    kind: "driving-school",
    objective: "Enroll one participant.",
    timeZone: "Europe/Madrid",
    participants: [{ id: "participant-a", attributes: {} }],
    location: { area: "Northside district", acceptableAlternatives: [] },
    dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
    hardRequirements: [],
    preferences: [],
    spendLimits: { currency: "EUR", totalMax: { amountCents: 120_000, currency: "EUR" } },
    authorizedActions: ["quote", "hold", "book"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: { description: "Enrolled.", requiresWrittenConfirmation: false },
    questions: [],
    providers: [{ id: PROVIDER_ID, name: "Northside Driving School", phoneE164: "+15555550100" }],
    shareableAttributes: [],
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

function standingRules() {
  const result = parseStandingRules({ autoBookWithinRules: true });
  if (!result.ok) throw new Error(`invalid fixture standing rules: ${result.issues.join(", ")}`);
  return result.rules;
}

interface Harness {
  readonly calls: InMemoryCallStore;
  readonly transcripts: InMemoryTranscriptStore;
  readonly runtime: (
    personas: ReadonlyMap<string, Persona>,
    overrides?: Partial<SimulatedVoiceRuntimeDeps>,
  ) => SimulatedVoiceRuntime;
  readonly toolsKey: string;
  readonly webhookSecret: string;
}

function setup(): Harness {
  const calls = new InMemoryCallStore();
  const errands = new InMemoryErrandStore();
  const offers = new InMemoryOfferStore();
  const grants = new InMemoryCommitGrantStore();
  const bookings = new InMemoryBookingStore();
  const transcripts = new InMemoryTranscriptStore();
  const events = new InMemoryWebhookEventStore();
  const toolsKey = randomBytes(24).toString("hex");
  const webhookSecret = randomBytes(24).toString("hex");
  void errands.save(brief(), NOW);

  const voiceToolsApp = createVoiceToolsApp({
    calls,
    errands,
    offers,
    grants,
    bookings,
    standingRules,
    now: () => NOW,
    toolsKey,
  });
  const postCallWebhookApp = createPostCallWebhookApp({
    webhookSecret,
    calls,
    transcripts,
    events,
    now: () => NOW,
  });

  return {
    calls,
    transcripts,
    toolsKey,
    webhookSecret,
    runtime: (personas, overrides = {}) =>
      new SimulatedVoiceRuntime({
        voiceToolsApp,
        postCallWebhookApp,
        toolsKey,
        webhookSecret,
        now: () => NOW,
        personas,
        ...overrides,
      }),
  };
}

async function placeCall(harness: Harness, runtime: SimulatedVoiceRuntime, id: string) {
  const { token, tokenHash } = issueCallToken();
  const call = startCall({
    id,
    errandId: ERRAND_ID,
    providerId: PROVIDER_ID,
    purpose: "quote",
    attempt: 1,
    tokenHash,
    now: NOW,
  });
  const created = await harness.calls.create(call);
  if (!created.ok) throw new Error(`could not create call ${id}`);
  const { externalId } = await runtime.placeCall({
    call,
    phoneE164: "+15555550100",
    dynamicVariables: { call_id: id, call_token: token },
  });
  // The orchestration workflow (not the port) records the provider's own conversation id, so
  // the post-call webhook can later find the call it belongs to.
  const updated = await harness.calls.update({ ...call, externalId });
  if (!updated.ok) throw new Error(`could not set externalId on call ${id}`);
  return externalId;
}

describe("SimulatedVoiceRuntime", () => {
  it("returns an external id before the persona script has run any step", async () => {
    const harness = setup();
    const persona: Persona = {
      outcome: "completed",
      steps: [{ tool: "get-errand-context", transcript: [{ role: "agent", message: "Hi." }] }],
    };
    const runtime = harness.runtime(new Map([[PROVIDER_ID, persona]]));

    const externalId = await placeCall(harness, runtime, "call-001");

    expect(runtime.stepsFor(externalId)).toEqual([]);
    await runtime.settled(externalId);
  });

  it("calls each step against the voice tools app with the call's own token, then ends the call via a signed transcription webhook", async () => {
    const harness = setup();
    const persona: Persona = {
      outcome: "completed",
      steps: [
        {
          tool: "get-errand-context",
          transcript: [{ role: "agent", message: "Hello, this is Booker calling." }],
        },
        {
          tool: "record-quote-field",
          body: {
            field: "seatsAvailable",
            value: 1,
            quote: "We have one seat.",
            confirmed: true,
          },
          transcript: [
            { role: "agent", message: "Do you have a seat available?" },
            { role: "user", message: "We have one seat." },
          ],
        },
      ],
    };
    const runtime = harness.runtime(new Map([[PROVIDER_ID, persona]]));

    const externalId = await placeCall(harness, runtime, "call-002");
    await runtime.settled(externalId);

    const steps = runtime.stepsFor(externalId);
    expect(steps.map((step) => step.status)).toEqual([200, 200]);

    const call = await harness.calls.findByExternalId(externalId);
    expect(call?.status).toBe("completed");
    expect(call?.endedAt).toBe(NOW);

    const transcript = await harness.transcripts.findByCallId(call?.id ?? "");
    expect(transcript?.turns).toEqual([
      {
        role: "agent",
        message: "Hello, this is Booker calling.",
        secondsIntoCall: expect.any(Number),
      },
      {
        role: "agent",
        message: "Do you have a seat available?",
        secondsIntoCall: expect.any(Number),
      },
      { role: "user", message: "We have one seat.", secondsIntoCall: expect.any(Number) },
    ]);
  });

  it("ends the call as no_answer via a call_initiation_failure webhook for a busy persona", async () => {
    const harness = setup();
    const persona: Persona = { outcome: "busy", steps: [] };
    const runtime = harness.runtime(new Map([[PROVIDER_ID, persona]]));

    const externalId = await placeCall(harness, runtime, "call-003");
    await runtime.settled(externalId);

    expect(runtime.stepsFor(externalId)).toEqual([]);
    const call = await harness.calls.findByExternalId(externalId);
    expect(call?.status).toBe("no_answer");
    expect(await harness.transcripts.findByCallId(call?.id ?? "")).toBeUndefined();
  });

  it("records a non-200 response instead of throwing, and keeps running the rest of the script", async () => {
    const harness = setup();
    const persona: Persona = {
      outcome: "completed",
      steps: [
        { tool: "request-commit-permission", body: { total: {}, deposit: {}, dates: {} } },
        { tool: "get-errand-context" },
      ],
    };
    const runtime = harness.runtime(new Map([[PROVIDER_ID, persona]]));

    const externalId = await placeCall(harness, runtime, "call-004");
    await runtime.settled(externalId);

    expect(runtime.stepsFor(externalId).map((step) => step.status)).toEqual([403, 200]);
  });

  it("stops the script before its next step once cancelled, and sends no completion webhook", async () => {
    const harness = setup();
    let runtime!: SimulatedVoiceRuntime;
    const cancelledOnce = new Set<string>();
    const persona: Persona = {
      outcome: "completed",
      steps: [
        { tool: "get-errand-context" },
        { tool: "get-errand-context" },
        { tool: "get-errand-context" },
      ],
    };
    runtime = new SimulatedVoiceRuntime({
      voiceToolsApp: createVoiceToolsApp({
        calls: harness.calls,
        errands: new InMemoryErrandStore(),
        offers: new InMemoryOfferStore(),
        grants: new InMemoryCommitGrantStore(),
        bookings: new InMemoryBookingStore(),
        standingRules,
        now: () => NOW,
        toolsKey: harness.toolsKey,
      }),
      postCallWebhookApp: createPostCallWebhookApp({
        webhookSecret: harness.webhookSecret,
        calls: harness.calls,
        transcripts: harness.transcripts,
        events: new InMemoryWebhookEventStore(),
        now: () => NOW,
      }),
      toolsKey: harness.toolsKey,
      webhookSecret: harness.webhookSecret,
      now: () => NOW,
      personas: new Map([[PROVIDER_ID, persona]]),
      onStep: async ({ externalId }) => {
        if (!cancelledOnce.has(externalId)) {
          cancelledOnce.add(externalId);
          await runtime.cancelCall(externalId);
        }
      },
    });

    const externalId = await placeCall(harness, runtime, "call-005");
    await runtime.settled(externalId);

    expect(runtime.stepsFor(externalId)).toHaveLength(1);
    const call = await harness.calls.findByExternalId(externalId);
    expect(call?.status).toBe("scheduled");
    expect(await harness.transcripts.findByCallId(call?.id ?? "")).toBeUndefined();
  });

  it("throws for a provider without a configured persona", async () => {
    const harness = setup();
    const runtime = harness.runtime(new Map());
    await expect(placeCall(harness, runtime, "call-006")).rejects.toThrow(RangeError);
  });

  it("retries a webhook delivery until externalId is recorded, ending a busy call as no_answer, retrying at least once", async () => {
    const harness = setup();
    const persona: Persona = { outcome: "busy", steps: [] };
    let recordExternalId: (() => Promise<void>) | undefined;
    let retryDelayCalls = 0;
    const runtime = harness.runtime(new Map([[PROVIDER_ID, persona]]), {
      // Only invoked after a webhook attempt actually failed (necessarily 503, since
      // externalId is not recorded yet), so the race is exercised deterministically rather
      // than by hoping real timing lines up.
      retryDelay: async () => {
        retryDelayCalls += 1;
        await recordExternalId?.();
      },
    });

    const { token, tokenHash } = issueCallToken();
    const id = "call-race";
    const call = startCall({
      id,
      errandId: ERRAND_ID,
      providerId: PROVIDER_ID,
      purpose: "quote",
      attempt: 1,
      tokenHash,
      now: NOW,
    });
    const created = await harness.calls.create(call);
    if (!created.ok) throw new Error(`could not create call ${id}`);

    const { externalId } = await runtime.placeCall({
      call,
      phoneE164: "+15555550100",
      dynamicVariables: { call_id: id, call_token: token },
    });
    // Deliberately not recorded yet: the busy persona's first webhook attempt races ahead
    // of a slow caller and finds no call bound to this externalId.
    recordExternalId = async () => {
      const updated = await harness.calls.update({ ...call, externalId });
      if (!updated.ok) throw new Error(`could not set externalId on call ${id}`);
    };

    await runtime.settled(externalId);

    expect(retryDelayCalls).toBeGreaterThanOrEqual(1);
    expect((await harness.calls.findByExternalId(externalId))?.status).toBe("no_answer");
  });

  it("records a non-JSON tool response as raw text instead of throwing, and keeps running the script", async () => {
    const harness = setup();
    const plainTextApp = new Hono();
    plainTextApp.post("/voice-tools/:callId/get-errand-context", (c) => c.text("not json", 200));
    plainTextApp.post("/voice-tools/:callId/record-quote-field", (c) =>
      c.json({ stored: true, status: "known" }, 200),
    );
    const persona: Persona = {
      outcome: "completed",
      steps: [
        { tool: "get-errand-context" },
        {
          tool: "record-quote-field",
          body: { field: "seatsAvailable", value: 1, quote: "One seat.", confirmed: true },
        },
      ],
    };
    const runtime = new SimulatedVoiceRuntime({
      voiceToolsApp: plainTextApp,
      postCallWebhookApp: createPostCallWebhookApp({
        webhookSecret: harness.webhookSecret,
        calls: harness.calls,
        transcripts: harness.transcripts,
        events: new InMemoryWebhookEventStore(),
        now: () => NOW,
      }),
      toolsKey: harness.toolsKey,
      webhookSecret: harness.webhookSecret,
      now: () => NOW,
      personas: new Map([[PROVIDER_ID, persona]]),
    });

    const externalId = await placeCall(harness, runtime, "call-007");
    await runtime.settled(externalId);

    const steps = runtime.stepsFor(externalId);
    expect(steps[0]).toEqual({ tool: "get-errand-context", status: 200, body: "not json" });
    expect(steps[1]).toMatchObject({
      tool: "record-quote-field",
      status: 200,
      body: { stored: true },
    });
  });

  it("never reports an unhandled rejection when nobody awaits settled before the script's webhook exhausts its retries, but settled still surfaces the error", async () => {
    const harness = setup();
    const persona: Persona = { outcome: "busy", steps: [] };
    const runtime = harness.runtime(new Map([[PROVIDER_ID, persona]]));

    let sawUnhandledRejection = false;
    const onUnhandledRejection = () => {
      sawUnhandledRejection = true;
    };
    process.on("unhandledRejection", onUnhandledRejection);

    const { token, tokenHash } = issueCallToken();
    const id = "call-unobserved";
    const call = startCall({
      id,
      errandId: ERRAND_ID,
      providerId: PROVIDER_ID,
      purpose: "quote",
      attempt: 1,
      tokenHash,
      now: NOW,
    });
    await harness.calls.create(call);
    const { externalId } = await runtime.placeCall({
      call,
      phoneE164: "+15555550100",
      dynamicVariables: { call_id: id, call_token: token },
    });
    // externalId is never recorded: every webhook attempt answers 503 forever, so the script
    // exhausts its retries and its background promise rejects.
    await expect(runtime.settled(externalId)).rejects.toThrow(/post-call webhook/);

    process.removeListener("unhandledRejection", onUnhandledRejection);
    expect(sawUnhandledRejection).toBe(false);
  });

  it("with startAfterRegistration, a zero-step busy persona on SQLite ends no_answer with zero webhook retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booker-simulated-voice-"));
    try {
      const db = openDatabase(`file:${join(dir, "test.db")}`);
      try {
        await migrate(db);
        const calls = new SqliteCallStore(db);
        const transcripts = new SqliteTranscriptStore(db);
        const events = new SqliteWebhookEventStore(db);
        const toolsKey = randomBytes(24).toString("hex");
        const webhookSecret = randomBytes(24).toString("hex");
        let retryDelayCalls = 0;

        const runtime = new SimulatedVoiceRuntime({
          voiceToolsApp: createVoiceToolsApp({
            calls,
            errands: new InMemoryErrandStore(),
            offers: new InMemoryOfferStore(),
            grants: new InMemoryCommitGrantStore(),
            bookings: new InMemoryBookingStore(),
            standingRules,
            now: () => NOW,
            toolsKey,
          }),
          postCallWebhookApp: createPostCallWebhookApp({
            webhookSecret,
            calls,
            transcripts,
            events,
            now: () => NOW,
          }),
          toolsKey,
          webhookSecret,
          now: () => NOW,
          personas: new Map([[PROVIDER_ID, { outcome: "busy", steps: [] } satisfies Persona]]),
          startAfterRegistration: true,
          retryDelay: async () => {
            retryDelayCalls += 1;
          },
        });

        const { token, tokenHash } = issueCallToken();
        const id = "call-sqlite-busy";
        const call = startCall({
          id,
          errandId: ERRAND_ID,
          providerId: PROVIDER_ID,
          purpose: "quote",
          attempt: 1,
          tokenHash,
          now: NOW,
        });
        const created = await calls.create(call);
        if (!created.ok) throw new Error(`could not create call ${id}`);

        const { externalId } = await runtime.placeCall({
          call,
          phoneE164: "+15555550100",
          dynamicVariables: { call_id: id, call_token: token },
        });
        const updated = await calls.update({ ...call, externalId });
        if (!updated.ok) throw new Error(`could not set externalId on call ${id}`);
        runtime.registered(externalId);

        await runtime.settled(externalId);

        expect(retryDelayCalls).toBe(0);
        expect((await calls.findByExternalId(externalId))?.status).toBe("no_answer");
      } finally {
        db.$client.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("startAfterRegistration keeps placeCall dormant until registered(), and registered() throws for an unknown externalId", async () => {
    const harness = setup();
    const persona: Persona = {
      outcome: "completed",
      steps: [{ tool: "get-errand-context" }],
    };
    const runtime = harness.runtime(new Map([[PROVIDER_ID, persona]]), {
      startAfterRegistration: true,
    });

    const { token, tokenHash } = issueCallToken();
    const id = "call-registered";
    const call = startCall({
      id,
      errandId: ERRAND_ID,
      providerId: PROVIDER_ID,
      purpose: "quote",
      attempt: 1,
      tokenHash,
      now: NOW,
    });
    await harness.calls.create(call);
    const { externalId } = await runtime.placeCall({
      call,
      phoneE164: "+15555550100",
      dynamicVariables: { call_id: id, call_token: token },
    });

    expect(() => runtime.registered("unknown-external-id")).toThrow(RangeError);
    expect(runtime.stepsFor(externalId)).toEqual([]);

    const updated = await harness.calls.update({ ...call, externalId });
    if (!updated.ok) throw new Error(`could not set externalId on call ${id}`);
    runtime.registered(externalId);
    await runtime.settled(externalId);

    expect(runtime.stepsFor(externalId)).toHaveLength(1);
    expect(() => runtime.registered(externalId)).toThrow(RangeError);
  });
});
