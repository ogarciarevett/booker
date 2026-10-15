import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ElevenLabsClient } from "../src/calls/adapters/elevenlabs/client.ts";
import { FakeElevenLabs } from "../src/calls/adapters/elevenlabs/fake-elevenlabs.ts";
import { ElevenLabsVoiceCallPort } from "../src/calls/adapters/elevenlabs/voice-call.ts";
import { InMemoryCallStore } from "../src/calls/adapters/in-memory-call-store.ts";
import { type Call, startCall } from "../src/calls/call.ts";
import type { CallActivity } from "../src/calls/call-activity.ts";
import { reconcileStaleCalls } from "../src/calls/reconciliation.ts";

const PLACED_AT = "2026-10-06T10:00:00.000Z";
const MINUTE_MS = 60_000;

function minutesAfter(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * MINUTE_MS).toISOString();
}

describe("reconcileStaleCalls against ElevenLabs", () => {
  let api: FakeElevenLabs;
  let calls: InMemoryCallStore;
  let voice: ElevenLabsVoiceCallPort;

  async function addCall(
    id: string,
    options: { externalId: string | null; placedAt?: string; status?: Call["status"] },
  ): Promise<void> {
    const call = startCall({
      id,
      errandId: "errand-001",
      providerId: `provider-${id}`,
      purpose: "quote",
      attempt: 1,
      tokenHash: "a".repeat(64),
      now: options.placedAt ?? PLACED_AT,
    });
    await calls.create({
      ...call,
      status: options.status ?? "in_progress",
      externalId: options.externalId,
      endedAt: options.status === "completed" ? PLACED_AT : null,
    });
  }

  function reconcile(now: string, errors: unknown[] = []) {
    return reconcileStaleCalls({
      calls,
      now,
      staleAfterMs: 5 * MINUTE_MS,
      providerReportsFailure: async (externalId) =>
        (await voice.conversationStatus(externalId)) === "failed",
      onError: (error) => errors.push(error),
    });
  }

  beforeEach(() => {
    api = new FakeElevenLabs();
    calls = new InMemoryCallStore();
    voice = new ElevenLabsVoiceCallPort({
      client: new ElevenLabsClient({
        apiKey: randomBytes(16).toString("hex"),
        baseUrl: "https://elevenlabs.test",
        fetch: api.fetch,
      }),
      agentIds: { quote: "agent-quote", commit: "agent-commit" },
      agentPhoneNumberId: "phnum-001",
      ownerName: "Example Owner 1",
      hangUp: async () => {},
      callSidFor: async () => undefined,
    });
  });

  it("ends a stale call ElevenLabs reports as failed as no_answer, so planning can retry it", async () => {
    await addCall("failed", { externalId: "conv-failed" });
    api.conversations.set("conv-failed", "failed");
    const now = minutesAfter(PLACED_AT, 6);

    const result = await reconcile(now);

    expect(result).toEqual({ checked: 1, ended: 1 });
    expect(await calls.findById("failed")).toMatchObject({ status: "no_answer", endedAt: now });
  });

  it("tells the lookup which call it checks, so the server can trace it as that call's", async () => {
    await addCall("failed", { externalId: "conv-failed" });
    const looked: [string, string][] = [];

    await reconcileStaleCalls({
      calls,
      now: minutesAfter(PLACED_AT, 6),
      staleAfterMs: 5 * MINUTE_MS,
      providerReportsFailure: async (externalId, callId) => {
        looked.push([externalId, callId]);
        return false;
      },
    });

    expect(looked).toEqual([["conv-failed", "failed"]]);
  });

  it("reports every call it ends, with the status it ended with", async () => {
    await addCall("failed", { externalId: "conv-failed" });
    await addCall("orphan", { externalId: null, status: "scheduled" });
    await addCall("running", { externalId: "conv-running" });
    api.conversations.set("conv-failed", "failed");
    api.conversations.set("conv-running", "in-progress");
    const now = minutesAfter(PLACED_AT, 6);
    const reported: CallActivity[] = [];

    await reconcileStaleCalls({
      calls,
      now,
      staleAfterMs: 5 * MINUTE_MS,
      providerReportsFailure: async (externalId) =>
        (await voice.conversationStatus(externalId)) === "failed",
      onActivity: (activity) => reported.push(activity),
    });

    expect(reported).toEqual(
      expect.arrayContaining([
        { type: "call_status", callId: "failed", status: "no_answer", at: now },
        { type: "call_status", callId: "orphan", status: "failed", at: now },
      ]),
    );
    expect(reported).toHaveLength(2);
  });

  it("leaves a stale call that is still running or done alone, waiting for its webhook", async () => {
    await addCall("running", { externalId: "conv-running" });
    await addCall("done", { externalId: "conv-done" });
    api.conversations.set("conv-running", "in-progress");
    api.conversations.set("conv-done", "done");

    const result = await reconcile(minutesAfter(PLACED_AT, 6));

    expect(result).toEqual({ checked: 2, ended: 0 });
    expect((await calls.listOpen()).map((call) => call.id).sort()).toEqual(["done", "running"]);
  });

  it("asks nothing about a call placed less than the window ago, or one that already ended", async () => {
    await addCall("recent", { externalId: "conv-recent", placedAt: minutesAfter(PLACED_AT, 4) });
    await addCall("ended", { externalId: "conv-ended", status: "completed" });
    api.conversations.set("conv-recent", "failed");

    const result = await reconcile(minutesAfter(PLACED_AT, 6));

    expect(result).toEqual({ checked: 0, ended: 0 });
    expect(api.requests).toEqual([]);
    expect((await calls.findById("recent"))?.status).toBe("in_progress");
  });

  it("ends a stale call that never got a conversation id as failed, asking ElevenLabs nothing", async () => {
    await addCall("orphan", { externalId: null, status: "scheduled" });
    const now = minutesAfter(PLACED_AT, 6);

    const result = await reconcile(now);

    expect(result).toEqual({ checked: 1, ended: 1 });
    expect(await calls.findById("orphan")).toMatchObject({ status: "failed", endedAt: now });
    expect(api.requests).toEqual([]);
  });

  it("reports a lookup that fails and still reconciles the other calls", async () => {
    await addCall("unknown", { externalId: "conv-unknown" });
    await addCall("failed", { externalId: "conv-failed" });
    api.conversations.set("conv-failed", "failed");
    const errors: unknown[] = [];

    const result = await reconcile(minutesAfter(PLACED_AT, 6), errors);

    expect(result).toEqual({ checked: 2, ended: 1 });
    expect(errors).toHaveLength(1);
    expect((await calls.findById("unknown"))?.status).toBe("in_progress");
    expect((await calls.findById("failed"))?.status).toBe("no_answer");
  });
});
