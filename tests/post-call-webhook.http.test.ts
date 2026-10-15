import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryCallStore } from "../src/calls/adapters/in-memory-call-store.ts";
import { InMemoryTranscriptStore } from "../src/calls/adapters/in-memory-transcript-store.ts";
import { InMemoryWebhookEventStore } from "../src/calls/adapters/in-memory-webhook-events.ts";
import { startCall } from "../src/calls/call.ts";
import type { CallActivity } from "../src/calls/call-activity.ts";
import type { CallStore } from "../src/calls/call-store.ts";
import { issueCallToken } from "../src/calls/call-token.ts";
import { planCallRound } from "../src/calls/planning.ts";
import type { TranscriptStore } from "../src/calls/transcript-store.ts";
import type { WebhookEventStore } from "../src/calls/webhook-events.ts";
import { type ErrandBrief, parseErrandBrief } from "../src/errands/brief.ts";
import {
  createPostCallWebhookApp,
  type PostCallWebhookDeps,
} from "../src/http/post-call-webhook.ts";
import { migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteCallStore } from "../src/persistence/sqlite-call-store.ts";
import { SqliteTranscriptStore } from "../src/persistence/sqlite-transcript-store.ts";
import { SqliteWebhookEventStore } from "../src/persistence/sqlite-webhook-event-store.ts";

const NOW = "2026-09-30T10:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const SIGNATURE_HEADER = "ElevenLabs-Signature";

interface Stores {
  readonly calls: CallStore;
  readonly transcripts: TranscriptStore;
  readonly events: WebhookEventStore;
  readonly teardown: () => void;
}

const STORE_FACTORIES: readonly { name: string; create: () => Promise<Stores> }[] = [
  {
    name: "in-memory stores",
    create: async () => ({
      calls: new InMemoryCallStore(),
      transcripts: new InMemoryTranscriptStore(),
      events: new InMemoryWebhookEventStore(),
      teardown: () => {},
    }),
  },
  {
    name: "SQLite stores sharing one database",
    create: async () => {
      const dir = mkdtempSync(join(tmpdir(), "booker-post-call-webhook-"));
      const db = openDatabase(`file:${join(dir, "test.db")}`);
      await migrate(db);
      return {
        calls: new SqliteCallStore(db),
        transcripts: new SqliteTranscriptStore(db),
        events: new SqliteWebhookEventStore(db),
        teardown: () => {
          db.$client.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

/** Signs `rawBody` the same way ElevenLabs does: HMAC-SHA256 over `<timestamp>.<rawBody>`. */
function sign(secret: string, rawBody: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v0=${digest}`;
}

function transcriptionPayload(
  conversationId: string,
  dataOverrides: Record<string, unknown> = {},
): object {
  return {
    type: "post_call_transcription",
    event_timestamp: NOW_SECONDS,
    data: {
      conversation_id: conversationId,
      status: "done",
      transcript: [
        { role: "agent", message: "Hello, how can I help?", time_in_call_secs: 0 },
        { role: "user", message: "I need a quote for driving lessons.", time_in_call_secs: 4 },
      ],
      metadata: {
        start_time_unix_secs: NOW_SECONDS,
        call_duration_secs: 42,
        termination_reason: "user_hangup",
      },
      analysis: { call_successful: true, transcript_summary: "Caller asked for a quote." },
      ...dataOverrides,
    },
  };
}

function audioPayload(conversationId: string): object {
  return {
    type: "post_call_audio",
    event_timestamp: NOW_SECONDS,
    data: { conversation_id: conversationId, full_audio: "ZmFrZS1hdWRpby1ieXRlcw==" },
  };
}

function initiationFailurePayload(conversationId: string): object {
  return {
    type: "call_initiation_failure",
    event_timestamp: NOW_SECONDS,
    data: {
      agent_id: "agent-001",
      conversation_id: conversationId,
      failure_reason: "busy",
      metadata: { type: "twilio", CallSid: "CA-fixture-001", CallStatus: "busy" },
    },
  };
}

/** A minimal one-provider brief for exercising `planCallRound` after a webhook ends a call. */
function briefWithProvider(providerId: string): ErrandBrief {
  const result = parseErrandBrief({
    id: "errand-001",
    kind: "driving-school",
    objective: "Enroll one participant.",
    timeZone: "Europe/Madrid",
    participants: [{ id: "participant-a", attributes: {} }],
    location: { area: "Northside district", acceptableAlternatives: [] },
    dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
    hardRequirements: [],
    preferences: [],
    spendLimits: { currency: "EUR", totalMax: { amountCents: 120_000, currency: "EUR" } },
    authorizedActions: ["quote", "hold"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: { description: "Enrolled.", requiresWrittenConfirmation: false },
    questions: [],
    providers: [{ id: providerId, name: "Northside Driving School", phoneE164: "+15555550100" }],
    shareableAttributes: [],
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

describe.each(STORE_FACTORIES)("post-call webhook over HTTP with $name", (factory) => {
  let stores: Stores;
  let app: ReturnType<typeof createPostCallWebhookApp>;
  let webhookSecret: string;

  function createApp(
    overrides: Partial<PostCallWebhookDeps> = {},
  ): ReturnType<typeof createPostCallWebhookApp> {
    return createPostCallWebhookApp({
      webhookSecret,
      calls: stores.calls,
      transcripts: stores.transcripts,
      events: stores.events,
      now: () => NOW,
      ...overrides,
    });
  }

  async function addCall(id: string, externalId: string | null): Promise<void> {
    const { tokenHash } = issueCallToken();
    const created = await stores.calls.create(
      startCall({
        id,
        errandId: "errand-001",
        providerId: "provider-northside",
        purpose: "commit",
        attempt: 1,
        tokenHash,
        now: NOW,
      }),
    );
    if (!created.ok) throw new Error(`could not create call ${id}`);
    if (externalId !== null) {
      const call = await stores.calls.findById(id);
      if (call === undefined) throw new Error("expected the call to exist");
      const updated = await stores.calls.update({ ...call, externalId });
      if (!updated.ok) throw new Error(`could not set externalId on call ${id}`);
    }
  }

  function postWebhook(rawBody: string, header: string | undefined): Promise<Response> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (header !== undefined) headers.set(SIGNATURE_HEADER, header);
    return Promise.resolve(
      app.request("/webhooks/elevenlabs/post-call", { method: "POST", headers, body: rawBody }),
    );
  }

  function postSigned(payload: object, secret: string = webhookSecret): Promise<Response> {
    const rawBody = JSON.stringify(payload);
    return postWebhook(rawBody, sign(secret, rawBody, NOW_SECONDS));
  }

  beforeEach(async () => {
    stores = await factory.create();
    webhookSecret = randomBytes(24).toString("hex");
    app = createApp();
  });

  afterEach(() => {
    stores.teardown();
  });

  it("refuses to start without a webhook secret", () => {
    expect(() =>
      createPostCallWebhookApp({
        webhookSecret: "",
        calls: stores.calls,
        transcripts: stores.transcripts,
        events: stores.events,
        now: () => NOW,
      }),
    ).toThrow(RangeError);
  });

  it("reads a live secret at each delivery, so a rotated secret applies without a restart", async () => {
    await addCall("call-001", "conv-001");
    let current: string | undefined = webhookSecret;
    app = createApp({ webhookSecret: async () => current });
    const rotated = randomBytes(24).toString("hex");

    expect((await postSigned(transcriptionPayload("conv-001"))).status).toBe(200);
    current = rotated;
    expect((await postSigned(transcriptionPayload("conv-001"))).status).toBe(401);
    expect((await postSigned(transcriptionPayload("conv-001"), rotated)).status).toBe(200);
  });

  it("asks ElevenLabs to retry later when the secret cannot be read, reporting why without it", async () => {
    await addCall("call-001", "conv-001");
    const errors: unknown[] = [];
    app = createApp({
      webhookSecret: async () => {
        throw new Error(
          "The macOS Keychain could not read ELEVENLABS_WEBHOOK_SECRET: User interaction is not allowed.",
        );
      },
      onError: (error) => errors.push(error),
    });

    const response = await postSigned(transcriptionPayload("conv-001"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toEqual({ error: "secret_unavailable" });
    expect(errors.map(String)).toEqual([
      expect.stringContaining("User interaction is not allowed"),
    ]);
    expect(errors.map(String).join("\n")).not.toContain(webhookSecret);
  });

  it("asks ElevenLabs to retry later while no secret is configured, processing nothing", async () => {
    await addCall("call-001", "conv-001");
    app = createApp({ webhookSecret: async () => undefined });

    const response = await postSigned(transcriptionPayload("conv-001"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toEqual({ error: "not_configured" });
    expect(await stores.transcripts.findByCallId("call-001")).toBeUndefined();
  });

  it("answers every signature failure with the same 401, including a tampered body", async () => {
    await addCall("call-001", "conv-001");
    const payload = transcriptionPayload("conv-001");
    const rawBody = JSON.stringify(payload);
    const validHeader = sign(webhookSecret, rawBody, NOW_SECONDS);
    const wrongSecret = `${webhookSecret}0`;

    const responses = await Promise.all([
      postWebhook(rawBody, undefined),
      postWebhook(rawBody, sign(wrongSecret, rawBody, NOW_SECONDS)),
      postWebhook(rawBody, sign(webhookSecret, rawBody, NOW_SECONDS - 3600)),
      postWebhook(`${rawBody} `, validHeader),
    ]);

    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status)).toEqual(Array(4).fill(401));
    expect(new Set(bodies).size).toBe(1);
    expect(await stores.transcripts.findByCallId("call-001")).toBeUndefined();
  });

  it("reports the status a delivery ends a call with, and nothing for a replay", async () => {
    const reported: CallActivity[] = [];
    app = createApp({ onActivity: (activity) => reported.push(activity) });
    await addCall("call-001", "conv-001");
    await addCall("call-002", "conv-002");

    await postSigned(transcriptionPayload("conv-001"));
    await postSigned(transcriptionPayload("conv-001"));
    await postSigned(initiationFailurePayload("conv-002"));
    await postSigned(audioPayload("conv-001"));

    expect(reported).toEqual([
      { type: "call_status", callId: "call-001", status: "completed", at: NOW },
      { type: "call_status", callId: "call-002", status: "no_answer", at: NOW },
    ]);
  });

  it("rejects a body over 2 MiB with 413 before verifying anything", async () => {
    const oversized = "x".repeat(2 * 1024 * 1024 + 1);
    const response = await postWebhook(oversized, undefined);
    expect(response.status).toBe(413);
  });

  it("answers 400 for a body that is not valid JSON", async () => {
    const rawBody = "not json";
    const response = await postWebhook(rawBody, sign(webhookSecret, rawBody, NOW_SECONDS));
    expect(response.status).toBe(400);
  });

  it("answers 400 for a transcription payload missing its transcript", async () => {
    const response = await postSigned({
      type: "post_call_transcription",
      event_timestamp: NOW_SECONDS,
      data: { conversation_id: "conv-001", status: "done" },
    });
    expect(response.status).toBe(400);
  });

  it("ends the call and stores only the minimized transcript on a valid transcription", async () => {
    await addCall("call-001", "conv-001");

    const response = await postSigned(transcriptionPayload("conv-001"));

    expect(response.status).toBe(200);
    const call = await stores.calls.findById("call-001");
    expect(call?.status).toBe("completed");
    expect(call?.endedAt).toBe(NOW);

    const transcript = await stores.transcripts.findByCallId("call-001");
    expect(transcript).toEqual({
      callId: "call-001",
      receivedAt: NOW,
      turns: [
        { role: "agent", message: "Hello, how can I help?", secondsIntoCall: 0 },
        { role: "user", message: "I need a quote for driving lessons.", secondsIntoCall: 4 },
      ],
    });
    const stored = JSON.stringify(transcript);
    for (const leaked of [
      "call_duration_secs",
      "termination_reason",
      "start_time_unix_secs",
      "call_successful",
      "transcript_summary",
    ]) {
      expect(stored).not.toContain(leaked);
    }
  });

  it("ends the call as failed when the webhook reports a non-done status", async () => {
    await addCall("call-002", "conv-002");
    const response = await postSigned(transcriptionPayload("conv-002", { status: "failed" }));
    expect(response.status).toBe(200);
    expect((await stores.calls.findById("call-002"))?.status).toBe("failed");
  });

  it("processes a replayed delivery once, without a second save", async () => {
    await addCall("call-001", "conv-001");
    let saveCalls = 0;
    app = createApp({
      transcripts: {
        save: async (input) => {
          saveCalls += 1;
          await stores.transcripts.save(input);
        },
        findByCallId: (callId) => stores.transcripts.findByCallId(callId),
        purgeReceivedBefore: (cutoff) => stores.transcripts.purgeReceivedBefore(cutoff),
      },
    });
    const payload = transcriptionPayload("conv-001");

    expect((await postSigned(payload)).status).toBe(200);
    expect((await postSigned(payload)).status).toBe(200);

    expect(saveCalls).toBe(1);
  });

  it("processes an audio event and a transcription event for the same conversation independently", async () => {
    await addCall("call-001", "conv-001");

    const audio = await postSigned(audioPayload("conv-001"));
    const transcription = await postSigned(transcriptionPayload("conv-001"));

    expect([audio.status, transcription.status]).toEqual([200, 200]);
    expect((await stores.calls.findById("call-001"))?.status).toBe("completed");
    expect(await stores.transcripts.findByCallId("call-001")).toBeDefined();
  });

  it("completes an unrecognized event type without processing it", async () => {
    await addCall("call-001", "conv-001");

    const response = await postSigned({
      type: "some_future_event_type",
      event_timestamp: NOW_SECONDS,
      data: { conversation_id: "conv-001", anything: "goes" },
    });

    expect(response.status).toBe(200);
    expect((await stores.calls.findById("call-001"))?.status).toBe("scheduled");
    expect(await stores.transcripts.findByCallId("call-001")).toBeUndefined();
  });

  it("ends the call as no_answer on a call_initiation_failure, storing nothing else", async () => {
    await addCall("call-001", "conv-001");

    const response = await postSigned(initiationFailurePayload("conv-001"));

    expect(response.status).toBe(200);
    const call = await stores.calls.findById("call-001");
    expect(call?.status).toBe("no_answer");
    expect(call?.endedAt).toBe(NOW);
    expect(await stores.transcripts.findByCallId("call-001")).toBeUndefined();
  });

  it("lets planCallRound offer the provider again after a call_initiation_failure, under the attempt cap", async () => {
    await addCall("call-001", "conv-001");
    expect((await postSigned(initiationFailurePayload("conv-001"))).status).toBe(200);

    const call = await stores.calls.findById("call-001");
    if (call === undefined) throw new Error("expected the call to exist");
    const round = planCallRound({
      brief: briefWithProvider("provider-northside"),
      calls: [call],
      maxAttemptsPerProvider: 2,
    });

    expect(round).toEqual(["provider-northside"]);
  });

  it("processes a replayed call_initiation_failure once, without ending the call twice", async () => {
    await addCall("call-001", "conv-001");
    let updateCalls = 0;
    app = createApp({
      calls: {
        create: (call) => stores.calls.create(call),
        findById: (id) => stores.calls.findById(id),
        findByExternalId: (externalId) => stores.calls.findByExternalId(externalId),
        update: async (call) => {
          updateCalls += 1;
          return await stores.calls.update(call);
        },
        activeGrant: (callId) => stores.calls.activeGrant(callId),
        setActiveGrant: (callId, binding) => stores.calls.setActiveGrant(callId, binding),
      },
    });
    const payload = initiationFailurePayload("conv-001");

    expect((await postSigned(payload)).status).toBe(200);
    expect((await postSigned(payload)).status).toBe(200);

    expect(updateCalls).toBe(1);
    expect((await stores.calls.findById("call-001"))?.status).toBe("no_answer");
  });

  it("asks for a retry (503 with Retry-After) for an unknown conversation on a call_initiation_failure", async () => {
    await addCall("call-001", null);

    const response = await postSigned(initiationFailurePayload("conv-001"));

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(await response.json()).toEqual({ error: "unknown_conversation" });
    expect((await stores.calls.findById("call-001"))?.status).toBe("scheduled");
  });

  it("asks for a retry (503) for an unknown conversation, then processes once the call's externalId is set", async () => {
    await addCall("call-001", null);
    const payload = transcriptionPayload("conv-001");

    const first = await postSigned(payload);
    expect(first.status).toBe(503);
    expect(first.headers.get("Retry-After")).toBe("30");
    expect(await stores.transcripts.findByCallId("call-001")).toBeUndefined();

    const call = await stores.calls.findById("call-001");
    if (call === undefined) throw new Error("expected the call to exist");
    await stores.calls.update({ ...call, externalId: "conv-001" });

    const retry = await postSigned(payload);
    expect(retry.status).toBe(200);
    expect((await stores.calls.findById("call-001"))?.status).toBe("completed");
  });

  it("answers 500 on an unexpected processing failure, and a retry succeeds afterward", async () => {
    await addCall("call-001", "conv-001");
    const errors: unknown[] = [];
    let failNext = true;
    app = createApp({
      calls: {
        create: (call) => stores.calls.create(call),
        findById: (id) => stores.calls.findById(id),
        findByExternalId: (externalId) => stores.calls.findByExternalId(externalId),
        update: async (call) => {
          if (failNext) {
            failNext = false;
            throw new Error("call store offline");
          }
          return await stores.calls.update(call);
        },
        activeGrant: (callId) => stores.calls.activeGrant(callId),
        setActiveGrant: (callId, binding) => stores.calls.setActiveGrant(callId, binding),
      },
      onError: (error) => errors.push(error),
    });
    const payload = transcriptionPayload("conv-001");

    const failed = await postSigned(payload);
    expect(failed.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect(await stores.transcripts.findByCallId("call-001")).toBeUndefined();

    const retried = await postSigned(payload);
    expect(retried.status).toBe(200);
    expect((await stores.calls.findById("call-001"))?.status).toBe("completed");
    expect(await stores.transcripts.findByCallId("call-001")).toBeDefined();
  });

  it("answers 409 for a payload mismatch on an already-processed conversation, and reports it", async () => {
    await addCall("call-001", "conv-001");
    const errors: unknown[] = [];
    app = createApp({ onError: (error) => errors.push(error) });

    expect((await postSigned(transcriptionPayload("conv-001"))).status).toBe(200);
    const mismatched = await postSigned(transcriptionPayload("conv-001", { status: "failed" }));

    expect(mismatched.status).toBe(409);
    expect(errors).toHaveLength(1);
    expect((await stores.calls.findById("call-001"))?.status).toBe("completed");
  });

  it("releases the claim when findByExternalId itself throws, so a retry claims again instead of 409", async () => {
    await addCall("call-001", "conv-001");
    const errors: unknown[] = [];
    let failNext = true;
    app = createApp({
      calls: {
        create: (call) => stores.calls.create(call),
        findById: (id) => stores.calls.findById(id),
        findByExternalId: async (externalId) => {
          if (failNext) {
            failNext = false;
            throw new Error("call store offline");
          }
          return await stores.calls.findByExternalId(externalId);
        },
        update: (call) => stores.calls.update(call),
        activeGrant: (callId) => stores.calls.activeGrant(callId),
        setActiveGrant: (callId, binding) => stores.calls.setActiveGrant(callId, binding),
      },
      onError: (error) => errors.push(error),
    });
    const payload = transcriptionPayload("conv-001");

    const failed = await postSigned(payload);
    expect(failed.status).toBe(500);
    expect(errors).toHaveLength(1);

    const retried = await postSigned(payload);
    expect(retried.status).toBe(200);
    expect((await stores.calls.findById("call-001"))?.status).toBe("completed");
  });

  it("reports the processing error before a failing release, and still answers 500", async () => {
    await addCall("call-001", "conv-001");
    const errors: unknown[] = [];
    app = createApp({
      calls: {
        create: (call) => stores.calls.create(call),
        findById: (id) => stores.calls.findById(id),
        findByExternalId: (externalId) => stores.calls.findByExternalId(externalId),
        update: async () => {
          throw new Error("processing failed");
        },
        activeGrant: (callId) => stores.calls.activeGrant(callId),
        setActiveGrant: (callId, binding) => stores.calls.setActiveGrant(callId, binding),
      },
      events: {
        claim: (input) => stores.events.claim(input),
        complete: (eventKey, claimToken, now) => stores.events.complete(eventKey, claimToken, now),
        release: async () => {
          throw new Error("release failed");
        },
      },
      onError: (error) => errors.push(error),
    });

    const response = await postSigned(transcriptionPayload("conv-001"));

    expect(response.status).toBe(500);
    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toBe("processing failed");
    expect((errors[1] as Error).message).toBe("release failed");
  });

  it("drops an invalid transcript turn, keeps the rest, ends the call once, and does not reprocess on replay", async () => {
    await addCall("call-001", "conv-001");
    const errors: unknown[] = [];
    let saveCalls = 0;
    app = createApp({
      transcripts: {
        save: async (input) => {
          saveCalls += 1;
          await stores.transcripts.save(input);
        },
        findByCallId: (callId) => stores.transcripts.findByCallId(callId),
        purgeReceivedBefore: (cutoff) => stores.transcripts.purgeReceivedBefore(cutoff),
      },
      onError: (error) => errors.push(error),
    });
    const payload = transcriptionPayload("conv-001", {
      transcript: [
        { role: "agent", message: "Hello, how can I help?", time_in_call_secs: 0 },
        { role: "user", message: "   ", time_in_call_secs: 4 },
        { role: "agent", message: "One moment please.", time_in_call_secs: -1 },
        { role: "user", message: "Yes, please.", time_in_call_secs: 12 },
      ],
    });

    const response = await postSigned(payload);

    expect(response.status).toBe(200);
    expect((await stores.calls.findById("call-001"))?.status).toBe("completed");
    expect(await stores.transcripts.findByCallId("call-001")).toEqual({
      callId: "call-001",
      receivedAt: NOW,
      turns: [
        { role: "agent", message: "Hello, how can I help?", secondsIntoCall: 0 },
        { role: "user", message: "Yes, please.", secondsIntoCall: 12 },
      ],
    });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe(
      "dropped 2 invalid transcript turn(s) for call call-001",
    );

    const replay = await postSigned(payload);
    expect(replay.status).toBe(200);
    expect(saveCalls).toBe(1);
  });

  it("drops tool-call turns whose message is null or missing instead of rejecting the delivery", async () => {
    await addCall("call-001", "conv-001");
    const payload = transcriptionPayload("conv-001", {
      transcript: [
        { role: "agent", message: "Hello, how can I help?", time_in_call_secs: 0 },
        {
          role: "agent",
          message: null,
          tool_calls: [{ tool_name: "get_errand_context", params_as_json: "{}" }],
          time_in_call_secs: 2,
        },
        { role: "agent", tool_results: [{ result_value: "{}" }], time_in_call_secs: 3 },
        { role: "user", message: "Yes, please.", time_in_call_secs: 12 },
      ],
    });

    const response = await postSigned(payload);

    expect(response.status).toBe(200);
    expect((await stores.calls.findById("call-001"))?.status).toBe("completed");
    expect((await stores.transcripts.findByCallId("call-001"))?.turns).toEqual([
      { role: "agent", message: "Hello, how can I help?", secondsIntoCall: 0 },
      { role: "user", message: "Yes, please.", secondsIntoCall: 12 },
    ]);
  });

  it("asks for a retry (503) for a second delivery arriving while the first is still processing", async () => {
    await addCall("call-001", "conv-001");
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalClaimed: (() => void) | undefined;
    const claimed = new Promise<void>((resolve) => {
      signalClaimed = resolve;
    });
    app = createApp({
      calls: {
        create: (call) => stores.calls.create(call),
        findById: (id) => stores.calls.findById(id),
        findByExternalId: async (externalId) => {
          // findByExternalId only runs after the claim has already succeeded (see the route
          // handler), so signaling here — instead of a fixed sleep — deterministically tells the
          // test when the first delivery's claim is in place and safe to race against.
          signalClaimed?.();
          await gate;
          return await stores.calls.findByExternalId(externalId);
        },
        update: (call) => stores.calls.update(call),
        activeGrant: (callId) => stores.calls.activeGrant(callId),
        setActiveGrant: (callId, binding) => stores.calls.setActiveGrant(callId, binding),
      },
    });
    const payload = transcriptionPayload("conv-001");

    const first = postSigned(payload);
    try {
      await claimed;
      const second = await postSigned(payload);
      expect(second.status).toBe(503);
      expect(second.headers.get("Retry-After")).toBe("30");
      expect(await second.json()).toEqual({ error: "in_progress" });
    } finally {
      // Always release the gate, even on a failed assertion above, so the first request's promise
      // is never left permanently pending.
      releaseGate?.();
    }
    expect((await first).status).toBe(200);
  });

  it("reports an unexpected error through onError and answers a generic 500 without echoing it", async () => {
    await addCall("call-001", "conv-001");
    const errors: unknown[] = [];
    app = createApp({
      transcripts: {
        save: async () => {
          throw new Error("transcript store offline");
        },
        findByCallId: (callId) => stores.transcripts.findByCallId(callId),
        purgeReceivedBefore: (cutoff) => stores.transcripts.purgeReceivedBefore(cutoff),
      },
      onError: (error) => errors.push(error),
    });

    const response = await postSigned(transcriptionPayload("conv-001"));

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("transcript store offline");
    expect(errors).toHaveLength(1);
  });
});
