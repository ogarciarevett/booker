import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import drivingSchoolBrief from "../examples/errands/driving-school.example.json" with {
  type: "json",
};
import {
  InMemoryBookingStore,
  InMemoryCommitGrantStore,
} from "../src/bookings/adapters/in-memory.ts";
import { ElevenLabsApiError } from "../src/calls/adapters/elevenlabs/client.ts";
import { InMemoryCallStore } from "../src/calls/adapters/in-memory-call-store.ts";
import { InMemoryErrandStore } from "../src/calls/adapters/in-memory-errand-store.ts";
import { InMemoryOfferStore } from "../src/calls/adapters/in-memory-offer-store.ts";
import { InMemoryTranscriptStore } from "../src/calls/adapters/in-memory-transcript-store.ts";
import { emptyOfferDraft } from "../src/calls/offer-drafts.ts";
import type { PlaceCallInput, VoiceCallPort } from "../src/calls/voice-call-port.ts";
import { type ControlDeps, createControlApp } from "../src/http/control.ts";
import { estimated, known } from "../src/offers/field.ts";

const NOW = "2026-10-06T10:00:00.000Z";
const NORTHSIDE_PHONE = "+15555550100";
const HARBOR_PHONE = "+15555550101";
const ERRAND_ID = "errand-driving-school-001";

describe("the control routes", () => {
  let root: string;
  let errandRoot: string;
  let token: string;
  let calls: InMemoryCallStore;
  let errands: InMemoryErrandStore;
  let offers: InMemoryOfferStore;
  let transcripts: InMemoryTranscriptStore;
  let grants: InMemoryCommitGrantStore;
  let bookings: InMemoryBookingStore;
  let placed: PlaceCallInput[];
  let voice: ControlDeps["voice"];
  let errors: unknown[];

  function app() {
    return createControlApp({
      token,
      calls,
      errands,
      offers,
      transcripts,
      grants,
      bookings,
      now: () => NOW,
      errandRoot,
      voice: () => voice(),
      onError: (error) => errors.push(error),
    });
  }

  function writeErrand(name: string, content: unknown): string {
    const path = join(errandRoot, "errands", name);
    mkdirSync(join(errandRoot, "errands"), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  }

  function postCall(body: unknown, bearer: string | null = token): Promise<Response> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (bearer !== null) headers.set("Authorization", `Bearer ${bearer}`);
    return Promise.resolve(
      app().request("/control/calls", { method: "POST", headers, body: JSON.stringify(body) }),
    );
  }

  function get(path: string, bearer: string | null = token): Promise<Response> {
    const headers = new Headers();
    if (bearer !== null) headers.set("Authorization", `Bearer ${bearer}`);
    return Promise.resolve(app().request(path, { headers }));
  }

  function getCall(id: string, bearer: string | null = token): Promise<Response> {
    return get(`/control/calls/${id}`, bearer);
  }

  async function placeCall(to: string): Promise<string> {
    const errandFile = writeErrand("test.json", drivingSchoolBrief);
    const response = await postCall({ to, errandFile, purpose: "quote" });
    expect(response.status).toBe(201);
    return ((await response.json()) as { callId: string }).callId;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "booker-control-"));
    errandRoot = join(root, ".local");
    mkdirSync(errandRoot);
    token = randomBytes(32).toString("base64url");
    calls = new InMemoryCallStore();
    errands = new InMemoryErrandStore();
    offers = new InMemoryOfferStore();
    transcripts = new InMemoryTranscriptStore();
    grants = new InMemoryCommitGrantStore();
    bookings = new InMemoryBookingStore();
    placed = [];
    errors = [];
    const port: VoiceCallPort = {
      async placeCall(input) {
        placed.push(input);
        return { externalId: `conv-00${placed.length}`, callSid: `CA-fixture-00${placed.length}` };
      },
      async cancelCall() {},
    };
    voice = async () => ({ ok: true, port });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("answers every request without the right bearer token with the same 401", async () => {
    const errandFile = writeErrand("test.json", drivingSchoolBrief);
    const body = { to: NORTHSIDE_PHONE, errandFile, purpose: "quote" };

    const responses = await Promise.all([
      postCall(body, null),
      postCall(body, `${token}x`),
      postCall(body, ""),
      getCall("call-1", null),
      getCall("call-1", token.slice(1)),
      get("/control/calls", null),
      get("/control/calls", `${token}x`),
      get("/control/bookings", null),
      get("/control/bookings", token.slice(1)),
    ]);

    expect(responses.map((response) => response.status)).toEqual(Array(9).fill(401));
    expect(new Set(await Promise.all(responses.map((response) => response.text()))).size).toBe(1);
    expect(placed).toEqual([]);
  });

  it("places a quote call from an errand file under .local and answers with its ids", async () => {
    const errandFile = writeErrand("test.json", drivingSchoolBrief);

    const response = await postCall({ to: NORTHSIDE_PHONE, errandFile, purpose: "quote" });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { callId: string; conversationId: string };
    expect(body).toEqual({ callId: expect.stringMatching(/^call-/), conversationId: "conv-001" });
    expect(await calls.findById(body.callId)).toMatchObject({
      status: "in_progress",
      externalId: "conv-001",
      providerId: "provider-northside",
    });
    expect(await calls.callSid(body.callId)).toBe("CA-fixture-001");
    expect(placed[0]?.dynamicVariables.call_id).toBe(body.callId);
  });

  it("refuses an errand file outside .local, even through a symlink", async () => {
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(drivingSchoolBrief));
    mkdirSync(join(errandRoot, "errands"), { recursive: true });
    const link = join(errandRoot, "errands", "link.json");
    symlinkSync(outside, link);

    for (const errandFile of [outside, link, join(errandRoot, "..", "outside.json")]) {
      const response = await postCall({ to: NORTHSIDE_PHONE, errandFile, purpose: "quote" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "errand_file_outside_local" });
    }
    expect(placed).toEqual([]);
  });

  it("names a missing errand file, an invalid brief, and a bad request body", async () => {
    const missing = await postCall({
      to: NORTHSIDE_PHONE,
      errandFile: join(errandRoot, "errands", "missing.json"),
      purpose: "quote",
    });
    const invalid = await postCall({
      to: NORTHSIDE_PHONE,
      errandFile: writeErrand("invalid.json", { id: "errand-x" }),
      purpose: "quote",
    });
    const notJson = await postCall({
      to: NORTHSIDE_PHONE,
      errandFile: writeErrand("broken.json", "{"),
      purpose: "quote",
    });
    const badBody = await postCall({ to: "555 0100", errandFile: "x", purpose: "commit" });

    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "errand_file_not_found" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      error: "invalid_errand",
      issues: expect.arrayContaining([expect.any(String)]),
    });
    expect(notJson.status).toBe(422);
    expect(badBody.status).toBe(400);
    expect(await badBody.json()).toEqual({ error: "invalid_request" });
    expect(placed).toEqual([]);
  });

  it("refuses a number the brief does not name, and a provider with a call still open", async () => {
    const errandFile = writeErrand("test.json", drivingSchoolBrief);

    const stranger = await postCall({ to: "+15550100999", errandFile, purpose: "quote" });
    expect(stranger.status).toBe(409);
    expect(await stranger.json()).toEqual({ error: "provider_not_in_brief" });

    expect((await postCall({ to: NORTHSIDE_PHONE, errandFile, purpose: "quote" })).status).toBe(
      201,
    );
    const again = await postCall({ to: NORTHSIDE_PHONE, errandFile, purpose: "quote" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "provider_not_callable" });
  });

  it("says why calls cannot be placed yet", async () => {
    voice = async () => ({ ok: false, reason: "run pnpm booker agent sync first" });
    const errandFile = writeErrand("test.json", drivingSchoolBrief);

    const response = await postCall({ to: NORTHSIDE_PHONE, errandFile, purpose: "quote" });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "calls_not_configured",
      detail: "run pnpm booker agent sync first",
    });
  });

  it("reports a voice provider failure, ending the call as failed", async () => {
    const failing: VoiceCallPort = {
      async placeCall() {
        throw new ElevenLabsApiError(
          "ElevenLabs POST /v1/convai/twilio/outbound-call answered HTTP 422",
          422,
        );
      },
      async cancelCall() {},
    };
    voice = async () => ({ ok: true, port: failing });
    const errandFile = writeErrand("test.json", drivingSchoolBrief);

    const response = await postCall({ to: NORTHSIDE_PHONE, errandFile, purpose: "quote" });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "voice_provider_failed",
      detail: "ElevenLabs POST /v1/convai/twilio/outbound-call answered HTTP 422",
    });
    expect(await calls.listOpen()).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("shows a call's status and recorded fields, never its token", async () => {
    const errandFile = writeErrand("test.json", drivingSchoolBrief);
    const { callId } = (await (
      await postCall({ to: NORTHSIDE_PHONE, errandFile, purpose: "quote" })
    ).json()) as { callId: string };
    const evidence = {
      source: "call" as const,
      reference: callId,
      quote: "We are in the Northside district.",
      capturedAt: NOW,
    };
    await offers.save({
      ...emptyOfferDraft("errand-driving-school-001", "provider-northside", NOW),
      location: known("Northside district", evidence),
    });

    const response = await getCall(callId);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      callId,
      status: "in_progress",
      purpose: "quote",
      providerId: "provider-northside",
      conversationId: "conv-001",
      recorded: [{ field: "location", status: "known", value: "Northside district" }],
      unknown: expect.arrayContaining(["seatsAvailable", "dates", "deposit", "licenceCategory"]),
    });
    expect(JSON.stringify(body)).not.toContain(placed[0]?.dynamicVariables.call_token ?? "x");
    expect(JSON.stringify(body)).not.toContain("tokenHash");
  });

  it("lists recent calls with the provider's name and a masked number", async () => {
    const first = await placeCall(NORTHSIDE_PHONE);
    voice = async () => ({
      ok: true,
      port: {
        async placeCall() {
          throw new ElevenLabsApiError("ElevenLabs POST /v1/convai/twilio/outbound-call 500", 500);
        },
        async cancelCall() {},
      },
    });
    const errandFile = writeErrand("test.json", drivingSchoolBrief);
    expect((await postCall({ to: HARBOR_PHONE, errandFile, purpose: "quote" })).status).toBe(502);

    const response = await get("/control/calls");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { calls: Record<string, unknown>[] };
    expect(body.calls).toHaveLength(2);
    // Both were placed at the same instant here, so only the ids order them.
    const byProvider = (id: string) => body.calls.find((call) => call["providerId"] === id);
    expect(byProvider("provider-northside")).toEqual({
      callId: first,
      errandId: ERRAND_ID,
      providerId: "provider-northside",
      providerName: "Northside Driving School",
      providerPhone: "+*******0100",
      purpose: "quote",
      status: "in_progress",
      attempt: 1,
      createdAt: NOW,
      endedAt: null,
      hasConversation: true,
    });
    expect(byProvider("provider-harbor")).toMatchObject({
      providerName: "Harbor View Driving Academy",
      providerPhone: "+*******0101",
      status: "failed",
      hasConversation: false,
    });
    const text = JSON.stringify(body);
    for (const hidden of ["5555550100", "5555550101", "conv-001", "tokenHash"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("takes a listing limit from 1 to 200 and refuses anything else", async () => {
    await placeCall(NORTHSIDE_PHONE);
    await placeCall(HARBOR_PHONE);

    const one = (await (await get("/control/calls?limit=1")).json()) as { calls: unknown[] };
    expect(one.calls).toHaveLength(1);
    for (const limit of ["0", "201", "two", "1.5"]) {
      const refused = await get(`/control/calls?limit=${limit}`);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("shows a call's transcript, the evidence for each field, its grant, and the booking", async () => {
    const callId = await placeCall(NORTHSIDE_PHONE);
    const evidence = (quote: string) => ({
      source: "call" as const,
      reference: callId,
      quote,
      capturedAt: NOW,
    });
    const draft = emptyOfferDraft(ERRAND_ID, "provider-northside", NOW);
    await offers.save({
      ...draft,
      location: known("Northside district", evidence("We are in the Northside district.")),
      seatsAvailable: estimated(2, evidence("Probably two seats left.")),
    });
    await transcripts.save({
      callId,
      receivedAt: NOW,
      turns: [
        { role: "agent", message: "Hello, I am an AI assistant.", secondsIntoCall: 0.5 },
        { role: "user", message: "We are in the Northside district.", secondsIntoCall: 4 },
      ],
    });
    const acquired = await grants.acquire({
      errandId: ERRAND_ID,
      offerId: draft.id,
      now: NOW,
      ttlSeconds: 600,
    });
    if (!acquired.granted) throw new Error("expected a grant");
    await calls.setActiveGrant(callId, {
      token: acquired.grant.token,
      termsDigest: "d".repeat(64),
    });
    await bookings.create({
      id: "booking-001",
      errandId: ERRAND_ID,
      offerId: draft.id,
      providerId: "provider-northside",
      participantIds: ["participant-a", "participant-b"],
      status: "verbal",
      history: [{ status: "verbal", at: NOW }],
    });

    const response = await getCall(callId);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      callId,
      providerName: "Northside Driving School",
      providerPhone: "+*******0100",
      hasConversation: true,
      recorded: expect.arrayContaining([
        {
          field: "location",
          status: "known",
          value: "Northside district",
          quote: "We are in the Northside district.",
          capturedAt: NOW,
        },
        {
          field: "seatsAvailable",
          status: "estimated",
          value: 2,
          quote: "Probably two seats left.",
          capturedAt: NOW,
        },
      ]),
      unknown: expect.arrayContaining(["dates", "deposit"]),
      transcript: {
        receivedAt: NOW,
        turns: [
          { role: "agent", message: "Hello, I am an AI assistant.", secondsIntoCall: 0.5 },
          { role: "user", message: "We are in the Northside district.", secondsIntoCall: 4 },
        ],
      },
      grant: { status: "active", expiresAt: acquired.grant.expiresAt },
      booking: {
        id: "booking-001",
        providerId: "provider-northside",
        status: "verbal",
        history: [{ status: "verbal", at: NOW }],
      },
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(acquired.grant.token);
    expect(text).not.toContain("5555550100");
  });

  it("shows no transcript, grant, or booking for a call that has none", async () => {
    const callId = await placeCall(NORTHSIDE_PHONE);

    const body = await (await getCall(callId)).json();

    expect(body).toMatchObject({ transcript: null, grant: null, booking: null });
  });

  it("lists recent bookings with the provider's name, cancelled ones too", async () => {
    await placeCall(NORTHSIDE_PHONE);
    await bookings.create({
      id: "booking-001",
      errandId: ERRAND_ID,
      offerId: "offer-001",
      providerId: "provider-northside",
      participantIds: ["participant-a"],
      status: "verbal",
      history: [{ status: "verbal", at: NOW }],
    });
    await bookings.advance("booking-001", "cancelled", "2026-10-06T11:00:00.000Z");

    const response = await get("/control/bookings");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bookings: [
        {
          id: "booking-001",
          errandId: ERRAND_ID,
          offerId: "offer-001",
          providerId: "provider-northside",
          providerName: "Northside Driving School",
          participantIds: ["participant-a"],
          status: "cancelled",
          history: [
            { status: "verbal", at: NOW },
            { status: "cancelled", at: "2026-10-06T11:00:00.000Z" },
          ],
        },
      ],
    });
  });

  it("answers 404 for a call it does not know", async () => {
    const response = await getCall("call-missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
