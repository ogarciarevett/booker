import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startCall } from "../../call.ts";
import { ElevenLabsApiError, ElevenLabsClient, type FetchFn } from "./client.ts";
import { type ElevenLabsVoiceCallOptions, ElevenLabsVoiceCallPort } from "./voice-call.ts";

const BASE_URL = "https://elevenlabs.test";
const NOW = "2026-10-06T10:00:00.000Z";

interface SentRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function fakeFetch(respond: (request: SentRequest) => { status: number; body: unknown }) {
  const sent: SentRequest[] = [];
  const fetch: FetchFn = async (input, init) => {
    const url = new URL(input);
    const request: SentRequest = {
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    const { status, body } = respond(request);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, sent };
}

function call(purpose: "quote" | "commit" = "quote") {
  return startCall({
    id: "call-001",
    errandId: "errand-001",
    providerId: "provider-northside",
    purpose,
    attempt: 1,
    tokenHash: "a".repeat(64),
    now: NOW,
  });
}

function port(fetch: FetchFn, overrides: Partial<ElevenLabsVoiceCallOptions> = {}) {
  const hungUp: string[] = [];
  const voice = new ElevenLabsVoiceCallPort({
    client: new ElevenLabsClient({
      apiKey: randomBytes(16).toString("hex"),
      baseUrl: BASE_URL,
      fetch,
    }),
    agentIds: { quote: "agent-quote", commit: "agent-commit" },
    agentPhoneNumberId: "phnum-001",
    ownerName: "Example Owner 1",
    hangUp: async (callSid) => {
      hungUp.push(callSid);
    },
    callSidFor: async (externalId) => (externalId === "conv-001" ? "CA-fixture-001" : undefined),
    ...overrides,
  });
  return { voice, hungUp };
}

const PLACED = {
  success: true,
  message: "Success",
  conversation_id: "conv-001",
  callSid: "CA-fixture-001",
};

describe("ElevenLabsVoiceCallPort", () => {
  it("places an outbound call with the purpose's agent, the call's dynamic variables, and no recording", async () => {
    const { fetch, sent } = fakeFetch(() => ({ status: 200, body: PLACED }));
    const { voice } = port(fetch);

    const placed = await voice.placeCall({
      call: call("quote"),
      phoneE164: "+15550100",
      dynamicVariables: { call_id: "call-001", call_token: "token-001" },
    });

    expect(placed).toEqual({ externalId: "conv-001", callSid: "CA-fixture-001" });
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/v1/convai/twilio/outbound-call",
        body: {
          agent_id: "agent-quote",
          agent_phone_number_id: "phnum-001",
          to_number: "+15550100",
          conversation_initiation_client_data: {
            dynamic_variables: {
              call_id: "call-001",
              call_token: "token-001",
              owner_name: "Example Owner 1",
            },
          },
          telephony_call_config: { twilio_call_recording_enabled: false },
        },
      },
    ]);
  });

  it("uses the commit agent for a commit call", async () => {
    const { fetch, sent } = fakeFetch(() => ({ status: 200, body: PLACED }));
    const { voice } = port(fetch);

    await voice.placeCall({
      call: call("commit"),
      phoneE164: "+15550100",
      dynamicVariables: { call_id: "call-001", call_token: "token-001" },
    });

    expect(sent[0]?.body).toMatchObject({ agent_id: "agent-commit" });
  });

  it("keeps a missing CallSid as null", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { ...PLACED, callSid: null } }));
    const { voice } = port(fetch);

    const placed = await voice.placeCall({
      call: call(),
      phoneE164: "+15550100",
      dynamicVariables: { call_id: "call-001", call_token: "token-001" },
    });

    expect(placed).toEqual({ externalId: "conv-001", callSid: null });
  });

  it.each([
    ["success is false", { ...PLACED, success: false, conversation_id: null }],
    ["there is no conversation id", { ...PLACED, conversation_id: null }],
  ])("fails when %s", async (_label, body) => {
    const { fetch } = fakeFetch(() => ({ status: 200, body }));
    const { voice } = port(fetch);

    await expect(
      voice.placeCall({
        call: call(),
        phoneE164: "+15550100",
        dynamicVariables: { call_id: "call-001", call_token: "token-001" },
      }),
    ).rejects.toThrow("ElevenLabs did not start the call");
  });

  it("says why ElevenLabs did not start the call, in its own words, with numbers masked", async () => {
    const apiKey = randomBytes(16).toString("hex");
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: {
        success: false,
        conversation_id: null,
        callSid: null,
        message:
          "Twilio: Account not authorized to call +15550100100. Enable international permissions.",
      },
    }));
    const { voice } = port(fetch, {
      client: new ElevenLabsClient({ apiKey, baseUrl: BASE_URL, fetch }),
    });

    const error = await voice
      .placeCall({
        call: call(),
        phoneE164: "+15550100100",
        dynamicVariables: { call_id: "call-001", call_token: "token-001" },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElevenLabsApiError);
    expect((error as Error).message).toBe(
      "ElevenLabs did not start the call: Twilio: Account not authorized to call +*******0100. Enable international permissions.",
    );
    expect((error as Error).message).not.toContain(apiKey);
  });

  it.each([
    [
      "grouped and national numbers",
      "Twilio: cannot call +1 555-555-0100, (555) 555-0100, or 555.555.0100 from this account.",
      "Twilio: cannot call +* ***-***-0100, (***) ***-0100, or ***.***.0100 from this account.",
    ],
    [
      "a number cut by the length limit",
      `${"x".repeat(290)} +15550100100 is not allowed`,
      `${"x".repeat(290)} +*******0`,
    ],
  ])("masks %s before shortening the reason", async (_label, message, shown) => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { success: false, conversation_id: null, callSid: null, message },
    }));
    const { voice } = port(fetch);

    await expect(
      voice.placeCall({
        call: call(),
        phoneE164: "+15550100100",
        dynamicVariables: { call_id: "call-001", call_token: "token-001" },
      }),
    ).rejects.toThrow(`ElevenLabs did not start the call: ${shown}`);
  });

  it("says no reason was given when ElevenLabs sends none", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: { success: false, conversation_id: null, callSid: null },
    }));
    const { voice } = port(fetch);

    await expect(
      voice.placeCall({
        call: call(),
        phoneE164: "+15550100",
        dynamicVariables: { call_id: "call-001", call_token: "token-001" },
      }),
    ).rejects.toThrow("ElevenLabs did not start the call: no reason given");
  });

  it("never retries the outbound call: a server error is one request and one failure", async () => {
    const { fetch, sent } = fakeFetch(() => ({ status: 502, body: {} }));
    const { voice } = port(fetch);

    await expect(
      voice.placeCall({
        call: call(),
        phoneE164: "+15550100",
        dynamicVariables: { call_id: "call-001", call_token: "token-001" },
      }),
    ).rejects.toBeInstanceOf(ElevenLabsApiError);
    expect(sent).toHaveLength(1);
  });

  it("refuses to place a call without the owner's name, which the first message needs", () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: PLACED }));
    expect(() => port(fetch, { ownerName: " " })).toThrow(RangeError);
  });

  it("cancels a call by hanging up its stored Twilio CallSid", async () => {
    const { fetch, sent } = fakeFetch(() => ({ status: 200, body: {} }));
    const { voice, hungUp } = port(fetch);

    await voice.cancelCall("conv-001");

    expect(hungUp).toEqual(["CA-fixture-001"]);
    expect(sent).toEqual([]);
  });

  it("refuses to cancel a call whose CallSid is unknown", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: {} }));
    const { voice, hungUp } = port(fetch);

    await expect(voice.cancelCall("conv-unknown")).rejects.toThrow(/no Twilio CallSid/);
    expect(hungUp).toEqual([]);
  });

  it("reads a conversation's status", async () => {
    const { fetch, sent } = fakeFetch(() => ({
      status: 200,
      body: { agent_id: "agent-quote", conversation_id: "conv-001", status: "failed" },
    }));
    const { voice } = port(fetch);

    expect(await voice.conversationStatus("conv-001")).toBe("failed");
    expect(sent[0]?.path).toBe("/v1/convai/conversations/conv-001");
  });
});
