import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import drivingSchoolBrief from "../examples/errands/driving-school.example.json" with {
  type: "json",
};
import {
  InMemoryBookingStore,
  InMemoryCommitGrantStore,
} from "../src/bookings/adapters/in-memory.ts";
import { InMemoryCallStore } from "../src/calls/adapters/in-memory-call-store.ts";
import { InMemoryErrandStore } from "../src/calls/adapters/in-memory-errand-store.ts";
import { InMemoryOfferStore } from "../src/calls/adapters/in-memory-offer-store.ts";
import { InMemoryTranscriptStore } from "../src/calls/adapters/in-memory-transcript-store.ts";
import { startCall } from "../src/calls/call.ts";
import { draftOfferId, emptyOfferDraft } from "../src/calls/offer-drafts.ts";
import { type ErrandBrief, parseErrandBrief } from "../src/errands/brief.ts";
import { createControlApp } from "../src/http/control.ts";
import { known } from "../src/offers/field.ts";

const NOW = "2026-10-08T10:00:00.000Z";

function drivingSchool(): ErrandBrief {
  const result = parseErrandBrief(drivingSchoolBrief);
  if (!result.ok) throw new Error(result.issues.join(", "));
  return result.brief;
}

describe("the errand control routes", () => {
  let token: string;
  let calls: InMemoryCallStore;
  let errands: InMemoryErrandStore;
  let offers: InMemoryOfferStore;
  let grants: InMemoryCommitGrantStore;
  let bookings: InMemoryBookingStore;
  let brief: ErrandBrief;
  let bodies: string[];

  function app() {
    return createControlApp({
      token,
      calls,
      errands,
      offers,
      transcripts: new InMemoryTranscriptStore(),
      grants,
      bookings,
      now: () => NOW,
      errandRoot: "/nonexistent",
      voice: async () => ({ ok: false, reason: "not in these tests" }),
    });
  }

  async function get(path: string, bearer: string | null = token): Promise<Response> {
    const headers = new Headers();
    if (bearer !== null) headers.set("Authorization", `Bearer ${bearer}`);
    const response = await app().request(path, { headers });
    bodies.push(await response.clone().text());
    return response;
  }

  async function placeCall(providerId: string, status: "in_progress" | "no_answer" | "completed") {
    const started = startCall({
      id: `call-${providerId}`,
      errandId: brief.id,
      providerId,
      purpose: "quote",
      attempt: 1,
      tokenHash: "a".repeat(64),
      now: "2026-10-08T09:00:00.000Z",
    });
    const call = {
      ...started,
      status,
      externalId: `conv-${providerId}`,
      endedAt: status === "in_progress" ? null : "2026-10-08T09:05:00.000Z",
    };
    const created = await calls.create(call);
    if (!created.ok) throw new Error("could not create the call");
  }

  beforeEach(async () => {
    token = randomBytes(32).toString("base64url");
    calls = new InMemoryCallStore();
    errands = new InMemoryErrandStore();
    offers = new InMemoryOfferStore();
    grants = new InMemoryCommitGrantStore();
    bookings = new InMemoryBookingStore();
    bodies = [];
    brief = drivingSchool();
    await errands.save(brief, "2026-10-08T08:00:00.000Z");
  });

  it("answers every errand request without the right bearer token with the same 401", async () => {
    const responses = await Promise.all([
      get("/control/errands", null),
      get(`/control/errands/${brief.id}`, `${token}x`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401]);
    expect(new Set(bodies).size).toBe(1);
  });

  it("lists errands newest first, each with its stage, counts, and progress", async () => {
    const older = { ...brief, id: "errand-older", objective: "An older errand." };
    await errands.save(older, "2026-10-07T08:00:00.000Z");
    const [first, second] = brief.providers;
    if (first === undefined || second === undefined) throw new Error("expected two providers");
    await placeCall(first.id, "in_progress");
    await placeCall(second.id, "no_answer");

    const response = await get("/control/errands");

    expect(response.status).toBe(200);
    const { errands: listed } = (await response.json()) as {
      errands: { errandId: string; stage: string; counts: Record<string, number> }[];
    };
    expect(listed.map((errand) => [errand.errandId, errand.stage])).toEqual([
      [brief.id, "calling"],
      ["errand-older", "preparing"],
    ]);
    expect(listed[0]).toMatchObject({
      kind: brief.kind,
      objective: brief.objective,
      createdAt: "2026-10-08T08:00:00.000Z",
      counts: { calling: 1, noAnswer: 1 },
      progress: { done: 0, total: brief.providers.length },
      providerCount: brief.providers.length,
    });
  });

  it("refuses a limit outside 1 to 200", async () => {
    expect((await get("/control/errands?limit=0")).status).toBe(400);
    expect((await get("/control/errands?limit=abc")).status).toBe(400);
  });

  it("shows one errand's providers with masked numbers, reasons, the ranking, and what is missing", async () => {
    const [first] = brief.providers;
    if (first === undefined) throw new Error("expected a provider");
    await placeCall(first.id, "completed");
    const evidence = {
      source: "call" as const,
      reference: `call-${first.id}`,
      quote: "No nos quedan plazas.",
      capturedAt: "2026-10-08T09:04:00.000Z",
    };
    await offers.save({
      ...emptyOfferDraft(brief.id, first.id, "2026-10-08T09:04:00.000Z"),
      seatsAvailable: known(0, evidence),
    });

    const response = await get(`/control/errands/${encodeURIComponent(brief.id)}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stage: string;
      providers: { providerId: string; status: string; phone: string; reasons: string[] }[];
      missing: { providersToCall: unknown[] };
    };
    expect(body.providers[0]).toMatchObject({
      providerId: first.id,
      name: first.name,
      status: "declined_by_provider",
      reasons: ["No seats available"],
      quote: "No nos quedan plazas.",
      phone: `+${"*".repeat(first.phoneE164.length - 5)}${first.phoneE164.slice(-4)}`,
    });
    expect(body.missing.providersToCall.length).toBe(brief.providers.length - 1);
    for (const provider of brief.providers) {
      expect(bodies.join("\n")).not.toContain(provider.phoneE164);
    }
    expect(bodies.join("\n")).not.toContain("a".repeat(64));
    expect(bodies.join("\n")).not.toContain(draftOfferId(brief.id, first.id));
  });

  it("reports the commit grant with its provider, and the booking once one holds", async () => {
    const [first] = brief.providers;
    if (first === undefined) throw new Error("expected a provider");
    await placeCall(first.id, "completed");
    const offerId = draftOfferId(brief.id, first.id);
    await offers.save(emptyOfferDraft(brief.id, first.id, "2026-10-08T09:04:00.000Z"));
    const acquired = await grants.acquire({
      errandId: brief.id,
      offerId,
      now: NOW,
      ttlSeconds: 600,
    });
    if (!acquired.granted) throw new Error("could not acquire the grant");
    const detail = async () =>
      (await (await get(`/control/errands/${encodeURIComponent(brief.id)}`)).json()) as {
        stage: string;
        missing: { commit: unknown };
      };

    expect((await detail()).missing.commit).toEqual({
      state: "grant_active",
      providerId: first.id,
      grantExpiresAt: "2026-10-08T10:10:00.000Z",
    });

    const created = await bookings.create({
      id: "booking-001",
      errandId: brief.id,
      offerId,
      providerId: first.id,
      participantIds: brief.participants.map((participant) => participant.id),
      status: "verbal",
      history: [{ status: "verbal", at: NOW }],
    });
    if (!created.ok) throw new Error("could not create the booking");

    const booked = await detail();
    expect(booked.stage).toBe("booked");
    expect(booked.missing.commit).toEqual({
      state: "booked",
      providerId: first.id,
      bookingStatus: "verbal",
    });
  });

  it("still reports an active grant whose offer it cannot find, with the provider unknown", async () => {
    const acquired = await grants.acquire({
      errandId: brief.id,
      offerId: "offer-not-among-the-drafts",
      now: NOW,
      ttlSeconds: 600,
    });
    if (!acquired.granted) throw new Error("could not acquire the grant");

    const response = await get(`/control/errands/${encodeURIComponent(brief.id)}`);

    expect(((await response.json()) as { missing: { commit: unknown } }).missing.commit).toEqual({
      state: "grant_active",
      providerId: null,
      grantExpiresAt: "2026-10-08T10:10:00.000Z",
    });
  });

  it("answers 404 for an errand Booker does not know", async () => {
    const response = await get("/control/errands/errand-missing");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});
