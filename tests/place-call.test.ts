import { describe, expect, it } from "vitest";
import drivingSchoolBrief from "../examples/errands/driving-school.example.json" with {
  type: "json",
};
import { InMemoryCallStore } from "../src/calls/adapters/in-memory-call-store.ts";
import { InMemoryErrandStore } from "../src/calls/adapters/in-memory-errand-store.ts";
import { endCall } from "../src/calls/call.ts";
import type { CallActivity } from "../src/calls/call-activity.ts";
import { verifyCallToken } from "../src/calls/call-token.ts";
import { type PlaceQuoteCallDeps, placeQuoteCall } from "../src/calls/place-call.ts";
import type { PlaceCallInput, VoiceCallPort } from "../src/calls/voice-call-port.ts";
import { type ErrandBrief, parseErrandBrief } from "../src/errands/brief.ts";

const NOW = "2026-10-06T10:00:00.000Z";
const NORTHSIDE_PHONE = "+15555550100";

function brief(overrides: Record<string, unknown> = {}): ErrandBrief {
  const parsed = parseErrandBrief({ ...drivingSchoolBrief, ...overrides });
  if (!parsed.ok) throw new Error(`invalid fixture brief: ${parsed.issues.join(", ")}`);
  return parsed.brief;
}

/** A voice port that records each placed call and answers with fixed ids, or fails. */
function recordingVoice(failure?: Error) {
  const placed: PlaceCallInput[] = [];
  const voice: VoiceCallPort = {
    async placeCall(input) {
      placed.push(input);
      if (failure !== undefined) throw failure;
      return { externalId: `conv-${placed.length}`, callSid: `CA-fixture-${placed.length}` };
    },
    async cancelCall() {},
  };
  return { voice, placed };
}

function deps(voice: VoiceCallPort, overrides: Partial<PlaceQuoteCallDeps> = {}) {
  const calls = new InMemoryCallStore();
  const errands = new InMemoryErrandStore();
  let next = 0;
  return {
    calls,
    errands,
    deps: {
      calls,
      errands,
      voice,
      now: () => NOW,
      newCallId: () => {
        next += 1;
        return `call-${next}`;
      },
      ...overrides,
    } satisfies PlaceQuoteCallDeps,
  };
}

describe("placeQuoteCall", () => {
  it("reports the call as scheduled, then in progress once the voice provider answers", async () => {
    const { voice } = recordingVoice();
    const reported: CallActivity[] = [];
    const { deps: placeDeps } = deps(voice, { onActivity: (activity) => reported.push(activity) });

    await placeQuoteCall(placeDeps, { brief: brief(), phoneE164: NORTHSIDE_PHONE });

    expect(reported).toEqual([
      { type: "call_status", callId: "call-1", status: "scheduled", at: NOW },
      { type: "call_status", callId: "call-1", status: "in_progress", at: NOW },
    ]);
  });

  it("reports a call the voice provider refused as failed, and still rethrows", async () => {
    const { voice } = recordingVoice(new Error("refused"));
    const reported: CallActivity[] = [];
    const { deps: placeDeps } = deps(voice, {
      onActivity: (activity) => {
        reported.push(activity);
        throw new Error("a broken listener must not matter");
      },
    });

    await expect(
      placeQuoteCall(placeDeps, { brief: brief(), phoneE164: NORTHSIDE_PHONE }),
    ).rejects.toThrow("refused");
    expect(reported.map((activity) => activity.type === "call_status" && activity.status)).toEqual([
      "scheduled",
      "failed",
    ]);
  });

  it("stores the errand, places a quote call to the provider with that number, and records the conversation at once", async () => {
    const { voice, placed } = recordingVoice();
    const { calls, errands, deps: placeDeps } = deps(voice);

    const result = await placeQuoteCall(placeDeps, { brief: brief(), phoneE164: NORTHSIDE_PHONE });

    expect(result).toEqual({ ok: true, callId: "call-1", conversationId: "conv-1" });
    expect(await errands.get("errand-driving-school-001")).toEqual(brief());
    expect(await calls.findById("call-1")).toMatchObject({
      errandId: "errand-driving-school-001",
      providerId: "provider-northside",
      purpose: "quote",
      status: "in_progress",
      attempt: 1,
      externalId: "conv-1",
    });
    expect(await calls.callSid("call-1")).toBe("CA-fixture-1");
    expect(placed).toHaveLength(1);
    expect(placed[0]?.phoneE164).toBe(NORTHSIDE_PHONE);
    expect(placed[0]?.dynamicVariables.call_id).toBe("call-1");
    const stored = await calls.findById("call-1");
    expect(
      verifyCallToken(placed[0]?.dynamicVariables.call_token ?? "", stored?.tokenHash ?? ""),
    ).toBe(true);
  });

  it("refuses a number that is not one of the brief's providers, placing nothing", async () => {
    const { voice, placed } = recordingVoice();
    const { calls, deps: placeDeps } = deps(voice);

    const result = await placeQuoteCall(placeDeps, { brief: brief(), phoneE164: "+15550100999" });

    expect(result).toEqual({ ok: false, reason: "provider_not_in_brief" });
    expect(placed).toEqual([]);
    expect(await calls.listOpen()).toEqual([]);
  });

  it("refuses a second call while the provider's first is still open", async () => {
    const { voice } = recordingVoice();
    const { deps: placeDeps } = deps(voice);
    await placeQuoteCall(placeDeps, { brief: brief(), phoneE164: NORTHSIDE_PHONE });

    const second = await placeQuoteCall(placeDeps, { brief: brief(), phoneE164: NORTHSIDE_PHONE });

    expect(second).toEqual({ ok: false, reason: "provider_not_callable" });
  });

  it("counts attempts per provider and stops at the cap", async () => {
    const { voice } = recordingVoice();
    const { calls, deps: placeDeps } = deps(voice);
    for (const expectedAttempt of [1, 2]) {
      const placed = await placeQuoteCall(placeDeps, {
        brief: brief(),
        phoneE164: NORTHSIDE_PHONE,
      });
      if (!placed.ok) throw new Error("expected the call to be placed");
      const call = await calls.findById(placed.callId);
      expect(call?.attempt).toBe(expectedAttempt);
      const ended = endCall(call as NonNullable<typeof call>, "no_answer", NOW);
      if (ended.ok) await calls.update(ended.call);
    }

    const third = await placeQuoteCall(placeDeps, { brief: brief(), phoneE164: NORTHSIDE_PHONE });

    expect(third).toEqual({ ok: false, reason: "provider_not_callable" });
  });

  it("replaces a stored brief with the file's current version", async () => {
    const { voice } = recordingVoice();
    const { errands, deps: placeDeps } = deps(voice);
    await errands.save(brief({ objective: "An older objective." }), NOW);

    await placeQuoteCall(placeDeps, { brief: brief(), phoneE164: NORTHSIDE_PHONE });

    expect((await errands.get("errand-driving-school-001"))?.objective).toBe(
      drivingSchoolBrief.objective,
    );
  });

  it("ends the call as failed when the voice provider refuses it, and reports why", async () => {
    const { voice } = recordingVoice(new Error("ElevenLabs did not start the call"));
    const { calls, deps: placeDeps } = deps(voice);

    await expect(
      placeQuoteCall(placeDeps, { brief: brief(), phoneE164: NORTHSIDE_PHONE }),
    ).rejects.toThrow("ElevenLabs did not start the call");

    expect(await calls.findById("call-1")).toMatchObject({ status: "failed", endedAt: NOW });
    expect(await calls.listOpen()).toEqual([]);
  });
});
