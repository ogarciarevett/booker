import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
import type { CommitGrantStore } from "../src/bookings/commit-grant.ts";
import type { BookingStore } from "../src/bookings/ledger.ts";
import { InMemoryCallStore } from "../src/calls/adapters/in-memory-call-store.ts";
import { InMemoryErrandStore } from "../src/calls/adapters/in-memory-errand-store.ts";
import { InMemoryOfferStore } from "../src/calls/adapters/in-memory-offer-store.ts";
import { type CallPurpose, endCall, startCall } from "../src/calls/call.ts";
import type { CallActivity } from "../src/calls/call-activity.ts";
import type { CallStore } from "../src/calls/call-store.ts";
import { issueCallToken } from "../src/calls/call-token.ts";
import type { ErrandStore } from "../src/calls/errand-store.ts";
import { draftOfferId, type OfferStore } from "../src/calls/offer-drafts.ts";
import { offerTermsDigest } from "../src/calls/offer-terms.ts";
import { type ErrandBrief, parseErrandBrief } from "../src/errands/brief.ts";
import { createVoiceToolsApp, type VoiceToolsDeps } from "../src/http/voice-tools.ts";
import { known } from "../src/offers/field.ts";
import { migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteBookingStore } from "../src/persistence/sqlite-booking-store.ts";
import { SqliteCallStore } from "../src/persistence/sqlite-call-store.ts";
import { SqliteCommitGrantStore } from "../src/persistence/sqlite-commit-grant-store.ts";
import { SqliteErrandStore } from "../src/persistence/sqlite-errand-store.ts";
import { SqliteOfferStore } from "../src/persistence/sqlite-offer-store.ts";
import { parseStandingRules, type StandingRules } from "../src/policies/standing-rules.ts";

const NOW = "2026-09-30T10:00:00.000Z";
const ERRAND_ID = "errand-driving-school-001";
const NORTHSIDE = "provider-northside";
const HARBOR = "provider-harbor";
const QUOTED = {
  total: { amountCents: 110_000, currency: "EUR" },
  deposit: { amountCents: 15_000, currency: "EUR" },
  dates: { start: "2026-11-03", end: "2026-11-12" },
};
const SPEND_LIMIT_AMOUNTS = ["120000", "240000", "20000", "10000"];

/** Every quote field the driving-school brief needs to make an offer eligible, all confirmed. */
function eligibleFields(seats: number) {
  return [
    { field: "seatsAvailable", value: seats, quote: "We have seats that week." },
    { field: "dates", value: QUOTED.dates, quote: "It runs from the 3rd to the 12th." },
    { field: "location", value: "Northside district", quote: "We are in the Northside district." },
    {
      field: "costItem:tuition",
      value: {
        amountCents: 55_000,
        currency: "EUR",
        appliesTo: "each-participant",
        kind: "charge",
      },
      quote: "Tuition is 550 euros per person.",
    },
    { field: "deposit", value: QUOTED.deposit, quote: "The deposit is 150 euros." },
    {
      field: "cancellationPenalty",
      value: { amountCents: 8_000, currency: "EUR" },
      quote: "Cancelling costs 80 euros.",
    },
    { field: "licenceCategory", value: "B", quote: "Category B, yes." },
    { field: "backToBackPhases", value: true, quote: "Theory and practice run back to back." },
  ];
}

/** The driving-school example plus a participant attribute the brief never shares. */
function brief(overrides: Record<string, unknown> = {}): ErrandBrief {
  const [first, ...rest] = drivingSchoolBrief.participants;
  const result = parseErrandBrief({
    ...drivingSchoolBrief,
    participants: [
      {
        ...first,
        attributes: { ...first?.attributes, homeAddress: "100 Fictional Example Street" },
      },
      ...rest,
    ],
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

function standingRules(): StandingRules {
  const result = parseStandingRules({
    allowedWindows: [{ start: "2026-10-15", end: "2026-11-30" }],
    maxTotal: { amountCents: 240_000, currency: "EUR" },
    maxDeposit: { amountCents: 20_000, currency: "EUR" },
    maxCancellationPenalty: { amountCents: 10_000, currency: "EUR" },
    autoBookWithinRules: true,
  });
  if (!result.ok) throw new Error(`invalid fixture standing rules: ${result.issues.join(", ")}`);
  return result.rules;
}

interface Stores {
  readonly calls: CallStore;
  readonly errands: ErrandStore;
  readonly offers: OfferStore;
  readonly grants: CommitGrantStore;
  readonly bookings: BookingStore;
  readonly teardown: () => void;
}

const STORE_FACTORIES: readonly { name: string; create: () => Promise<Stores> }[] = [
  {
    name: "in-memory stores",
    create: async () => ({
      calls: new InMemoryCallStore(),
      errands: new InMemoryErrandStore(),
      offers: new InMemoryOfferStore(),
      grants: new InMemoryCommitGrantStore(),
      bookings: new InMemoryBookingStore(),
      teardown: () => {},
    }),
  },
  {
    name: "SQLite stores sharing one database",
    create: async () => {
      const dir = mkdtempSync(join(tmpdir(), "booker-voice-tools-"));
      const db = openDatabase(`file:${join(dir, "test.db")}`);
      await migrate(db);
      return {
        calls: new SqliteCallStore(db),
        errands: new SqliteErrandStore(db),
        offers: new SqliteOfferStore(db),
        grants: new SqliteCommitGrantStore(db),
        bookings: new SqliteBookingStore(db),
        teardown: () => {
          db.$client.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

describe.each(STORE_FACTORIES)("voice tools over HTTP with $name", (factory) => {
  let stores: Stores;
  let app: ReturnType<typeof createVoiceToolsApp>;
  let toolsKey: string;

  async function addCall(
    id: string,
    purpose: CallPurpose,
    providerId: string,
    errandId = ERRAND_ID,
  ): Promise<string> {
    const { token, tokenHash } = issueCallToken();
    const created = await stores.calls.create(
      startCall({ id, errandId, providerId, purpose, attempt: 1, tokenHash, now: NOW }),
    );
    if (!created.ok) throw new Error(`could not create call ${id}`);
    return token;
  }

  function post(
    callId: string,
    tool: string,
    body: unknown,
    key: string | null = toolsKey,
  ): Promise<Response> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (key !== null) headers.set("X-Booker-Tools-Key", key);
    return Promise.resolve(
      app.request(`/voice-tools/${callId}/${tool}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  }

  async function recordEligibleOffer(callId: string, token: string, seats = 2): Promise<void> {
    for (const field of eligibleFields(seats)) {
      const response = await post(callId, "record-quote-field", {
        call_token: token,
        ...field,
        confirmed: true,
      });
      expect(response.status).toBe(200);
    }
  }

  async function requestPermission(callId: string, token: string, quoted = QUOTED) {
    const response = await post(callId, "request-commit-permission", {
      call_token: token,
      ...quoted,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { granted: boolean; instruction: string };
  }

  function reportOutcome(callId: string, token: string, outcome: string): Promise<Response> {
    return post(callId, "report-commit-outcome", {
      call_token: token,
      outcome,
      quote: "Yes, you are both booked.",
    });
  }

  function createApp(
    overrides: Partial<VoiceToolsDeps> = {},
  ): ReturnType<typeof createVoiceToolsApp> {
    return createVoiceToolsApp({
      calls: stores.calls,
      errands: stores.errands,
      offers: stores.offers,
      grants: stores.grants,
      bookings: stores.bookings,
      standingRules,
      now: () => NOW,
      toolsKey,
      ...overrides,
    });
  }

  beforeEach(async () => {
    stores = await factory.create();
    toolsKey = randomBytes(24).toString("hex");
    app = createApp();
    await stores.errands.save(brief(), NOW);
  });

  afterEach(() => {
    stores.teardown();
  });

  it("refuses to start without a tools key", () => {
    expect(() =>
      createVoiceToolsApp({ ...stores, standingRules, now: () => NOW, toolsKey: "" }),
    ).toThrow(RangeError);
  });

  it("answers every authentication failure with the same 401", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    const otherToken = await addCall("call-commit-harbor", "commit", HARBOR);
    const endedToken = await addCall("call-ended", "commit", NORTHSIDE);
    const ended = await stores.calls.findById("call-ended");
    if (ended === undefined) throw new Error("expected the call to exist");
    const endResult = endCall(ended, "completed", NOW);
    if (!endResult.ok) throw new Error("expected the call to end");
    await stores.calls.update(endResult.call);

    const responses = await Promise.all([
      post("call-commit-northside", "get-errand-context", { call_token: token }, `${toolsKey}0`),
      post("call-commit-northside", "get-errand-context", { call_token: token }, null),
      post("call-missing", "get-errand-context", { call_token: token }),
      post("call-commit-northside", "get-errand-context", { call_token: otherToken }),
      post("call-commit-northside", "get-errand-context", {}),
      post("call-commit-northside", "request-commit-permission", { ...QUOTED }),
      post("call-ended", "get-errand-context", { call_token: endedToken }),
    ]);

    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(responses.map((response) => response.status)).toEqual(Array(7).fill(401));
    expect(new Set(bodies).size).toBe(1);
  });

  it("rejects both commit tools on a quote call with 403", async () => {
    const token = await addCall("call-quote-northside", "quote", NORTHSIDE);
    await recordEligibleOffer("call-quote-northside", token);

    const permission = await post("call-quote-northside", "request-commit-permission", {
      call_token: token,
      ...QUOTED,
    });
    const outcome = await reportOutcome("call-quote-northside", token, "accepted");

    expect([permission.status, outcome.status]).toEqual([403, 403]);
    expect(await stores.grants.findActive(ERRAND_ID, NOW)).toBeUndefined();
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
  });

  it("reports each authenticated tool request with its outcome, never its content", async () => {
    const reported: CallActivity[] = [];
    app = createApp({ onActivity: (activity) => reported.push(activity) });
    const token = await addCall("call-quote-northside", "quote", NORTHSIDE);

    await post("call-quote-northside", "get-errand-context", { call_token: token });
    await post("call-quote-northside", "record-quote-field", { call_token: token, field: "x" });
    await post("call-quote-northside", "request-commit-permission", {
      call_token: token,
      ...QUOTED,
    });
    await post("call-quote-northside", "get-errand-context", { call_token: "wrong" });

    expect(reported).toEqual([
      {
        type: "tool",
        callId: "call-quote-northside",
        tool: "get_errand_context",
        outcome: "ok",
        at: NOW,
      },
      {
        type: "tool",
        callId: "call-quote-northside",
        tool: "record_quote_field",
        outcome: "invalid_request",
        at: NOW,
      },
      {
        type: "tool",
        callId: "call-quote-northside",
        tool: "request_commit_permission",
        outcome: "forbidden",
        at: NOW,
      },
    ]);
  });

  it("rejects a body over 16 KiB with 413 before storing anything", async () => {
    const token = await addCall("call-quote-northside", "quote", NORTHSIDE);
    const response = await post("call-quote-northside", "record-quote-field", {
      call_token: token,
      field: "location",
      value: "x".repeat(17 * 1024),
      quote: "We are in the Northside district.",
      confirmed: true,
    });

    expect(response.status).toBe(413);
    expect(await stores.offers.forProvider(ERRAND_ID, NORTHSIDE)).toBeUndefined();
  });

  it("treats a null the voice agent sends for an optional field as absent", async () => {
    const token = await addCall("call-quote-northside", "quote", NORTHSIDE);
    await recordEligibleOffer("call-quote-northside", token);

    const response = await post("call-quote-northside", "record-quote-field", {
      call_token: token,
      field: "costItem:tuition",
      value: { amountCents: 50_000, currency: "EUR", appliesTo: null, kind: null },
      quote: "Tuition is 500 euros per person.",
      confirmed: true,
    });

    expect(response.status).toBe(200);
    const offer = await stores.offers.forProvider(ERRAND_ID, NORTHSIDE);
    expect(offer?.costItems).toEqual([
      expect.objectContaining({
        id: "tuition",
        appliesTo: "each-participant",
        kind: "charge",
        amount: expect.objectContaining({ value: { amountCents: 50_000, currency: "EUR" } }),
      }),
    ]);
  });

  it("returns only what the provider may hear as the errand context", async () => {
    const token = await addCall("call-quote-northside", "quote", NORTHSIDE);
    const response = await post("call-quote-northside", "get-errand-context", {
      call_token: token,
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ providerName: "Northside Driving School" });
    for (const amount of SPEND_LIMIT_AMOUNTS) expect(text).not.toContain(amount);
    expect(text).not.toContain("homeAddress");
    expect(text).not.toContain("100 Fictional Example Street");
    expect(text).not.toContain("Harbor View");
  });

  it("stores a confirmed field as known and an unconfirmed one as estimated", async () => {
    const token = await addCall("call-quote-northside", "quote", NORTHSIDE);
    const confirmed = await post("call-quote-northside", "record-quote-field", {
      call_token: token,
      field: "location",
      value: "Northside district",
      quote: "We are in the Northside district.",
      confirmed: true,
    });
    const unconfirmed = await post("call-quote-northside", "record-quote-field", {
      call_token: token,
      field: "seatsAvailable",
      value: 2,
      quote: "I think there are two seats left.",
      confirmed: false,
    });

    expect(await confirmed.json()).toEqual({ stored: true, status: "known" });
    expect(await unconfirmed.json()).toEqual({ stored: true, status: "estimated" });
    const draft = await stores.offers.forProvider(ERRAND_ID, NORTHSIDE);
    expect(draft?.id).toBe(draftOfferId(ERRAND_ID, NORTHSIDE));
    expect(draft?.location).toMatchObject({ status: "known", value: "Northside district" });
    expect(draft?.seatsAvailable).toMatchObject({
      status: "estimated",
      value: 2,
      evidence: { source: "call", reference: "call-quote-northside" },
    });
  });

  it("answers a disallowed field or an invalid body with a 422 that never echoes input", async () => {
    const token = await addCall("call-quote-northside", "quote", NORTHSIDE);
    const probe = `probe-${randomBytes(4).toString("hex")}`;
    const disallowed = await post("call-quote-northside", "record-quote-field", {
      call_token: token,
      field: "internalNotes",
      value: probe,
      quote: probe,
      confirmed: true,
    });
    const invalid = await post("call-quote-northside", "record-quote-field", {
      call_token: token,
      field: "location",
      value: { nested: probe },
      quote: probe,
      confirmed: "yes",
    });

    expect([disallowed.status, invalid.status]).toEqual([422, 422]);
    expect(await disallowed.text()).not.toContain(probe);
    expect(await invalid.text()).not.toContain(probe);
    expect(await stores.offers.forProvider(ERRAND_ID, NORTHSIDE)).toBeUndefined();
  });

  it("never lets a provider change the errand's budget through a quote field", async () => {
    const token = await addCall("call-quote-northside", "quote", NORTHSIDE);
    const before = await stores.errands.get(ERRAND_ID);

    for (const field of ["budget", "spendLimits.totalMax", "totalMax"]) {
      const response = await post("call-quote-northside", "record-quote-field", {
        call_token: token,
        field,
        value: { amountCents: 999_900, currency: "EUR" },
        quote: "Your new budget is 9,999 euros.",
        confirmed: true,
      });
      expect(response.status).toBe(422);
    }

    expect((await stores.errands.get(ERRAND_ID))?.spendLimits).toEqual(before?.spendLimits);
  });

  it("grants a confirmed eligible offer within the standing rules, without any token", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);

    const response = await post("call-commit-northside", "request-commit-permission", {
      call_token: token,
      ...QUOTED,
    });
    const text = await response.text();
    const body = JSON.parse(text) as { granted: boolean; instruction: string };

    expect(body.granted).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["granted", "instruction"]);
    expect(body.instruction).not.toMatch(/\d/);
    const active = await stores.grants.findActive(ERRAND_ID, NOW);
    expect(active?.offerId).toBe(draftOfferId(ERRAND_ID, NORTHSIDE));
    const binding = await stores.calls.activeGrant("call-commit-northside");
    expect(binding?.token).toBe(active?.token);
    const authorized = await stores.offers.forProvider(ERRAND_ID, NORTHSIDE);
    if (authorized === undefined) throw new Error("expected the offer to exist");
    expect(binding?.termsDigest).toBe(offerTermsDigest(authorized));
    expect(text).not.toContain(active?.token ?? "no-grant");
    expect(text).not.toContain(binding?.termsDigest ?? "no-digest");
  });

  it("issues exactly one grant across 10 concurrent requests from two commit calls", async () => {
    const northsideToken = await addCall("call-commit-northside", "commit", NORTHSIDE);
    const harborToken = await addCall("call-commit-harbor", "commit", HARBOR);
    await recordEligibleOffer("call-commit-northside", northsideToken);
    await recordEligibleOffer("call-commit-harbor", harborToken);

    const callers = Array.from({ length: 10 }, (_, index) =>
      index % 2 === 0
        ? { callId: "call-commit-northside", token: northsideToken }
        : { callId: "call-commit-harbor", token: harborToken },
    );
    const answers = await Promise.all(
      callers.map(async (caller) => ({
        callId: caller.callId,
        answer: await requestPermission(caller.callId, caller.token),
      })),
    );

    const grantedCalls = new Set(
      answers.filter(({ answer }) => answer.granted).map(({ callId }) => callId),
    );
    expect(grantedCalls.size).toBe(1);
    const [winner] = [...grantedCalls];
    const loser =
      winner === "call-commit-northside" ? "call-commit-harbor" : "call-commit-northside";
    expect(
      answers.filter(({ callId }) => callId === loser).map(({ answer }) => answer.granted),
    ).toEqual(Array(5).fill(false));

    const active = await stores.grants.findActive(ERRAND_ID, NOW);
    expect(active).toBeDefined();
    expect((await stores.calls.activeGrant(winner ?? ""))?.token).toBe(active?.token);
    expect(await stores.calls.activeGrant(loser)).toBeUndefined();
  }, 15_000);

  it("does not grant a total misheard by one cent", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);

    const answer = await requestPermission("call-commit-northside", token, {
      ...QUOTED,
      total: { amountCents: 110_001, currency: "EUR" },
    });

    expect(answer.granted).toBe(false);
    expect(answer.instruction).not.toMatch(/\d/);
    expect(await stores.grants.findActive(ERRAND_ID, NOW)).toBeUndefined();
    expect(await stores.calls.activeGrant("call-commit-northside")).toBeUndefined();
  });

  it("books every participant verbally once on accepted, then answers 409", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    const harborToken = await addCall("call-commit-harbor", "commit", HARBOR);
    await recordEligibleOffer("call-commit-northside", token);
    await recordEligibleOffer("call-commit-harbor", harborToken);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);

    const accepted = await reportOutcome("call-commit-northside", token, "accepted");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ recorded: true });

    const booking = await stores.bookings.findOpen(ERRAND_ID);
    expect(booking).toMatchObject({
      offerId: draftOfferId(ERRAND_ID, NORTHSIDE),
      providerId: NORTHSIDE,
      participantIds: ["participant-a", "participant-b"],
      status: "verbal",
    });
    expect(await stores.grants.findActive(ERRAND_ID, NOW)).toBeUndefined();

    const again = await reportOutcome("call-commit-northside", token, "accepted");
    expect(again.status).toBe(409);
    expect((await stores.bookings.findOpen(ERRAND_ID))?.id).toBe(booking?.id);
    // A booked errand never grants another commit, even to a different provider.
    expect((await requestPermission("call-commit-harbor", harborToken)).granted).toBe(false);
  });

  it("books only the seats offered when the brief allows a partial booking", async () => {
    await stores.errands.save(
      brief({
        id: "errand-partial-001",
        groupPolicy: { sameProvider: true, allowPartialBooking: true },
      }),
      NOW,
    );
    const token = await addCall("call-partial", "commit", NORTHSIDE, "errand-partial-001");
    await recordEligibleOffer("call-partial", token, 1);
    expect((await requestPermission("call-partial", token)).granted).toBe(true);

    expect((await reportOutcome("call-partial", token, "accepted")).status).toBe(200);
    expect((await stores.bookings.findOpen("errand-partial-001"))?.participantIds).toEqual([
      "participant-a",
    ]);
  });

  it("releases the grant on rejected, so another call can be granted", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    const harborToken = await addCall("call-commit-harbor", "commit", HARBOR);
    await recordEligibleOffer("call-commit-northside", token);
    await recordEligibleOffer("call-commit-harbor", harborToken);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);

    const rejected = await reportOutcome("call-commit-northside", token, "rejected");

    expect(await rejected.json()).toEqual({ recorded: true });
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
    expect(await stores.calls.activeGrant("call-commit-northside")).toBeUndefined();
    expect((await requestPermission("call-commit-harbor", harborToken)).granted).toBe(true);
  });

  it("keeps the grant on unclear for reconciliation", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    const harborToken = await addCall("call-commit-harbor", "commit", HARBOR);
    await recordEligibleOffer("call-commit-northside", token);
    await recordEligibleOffer("call-commit-harbor", harborToken);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);
    const held = await stores.grants.findActive(ERRAND_ID, NOW);

    const unclear = await reportOutcome("call-commit-northside", token, "unclear");

    expect(await unclear.json()).toEqual({ recorded: true });
    expect((await stores.grants.findActive(ERRAND_ID, NOW))?.token).toBe(held?.token);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
    expect((await requestPermission("call-commit-harbor", harborToken)).granted).toBe(false);
  });

  it("revokes the grant when the offer changes after permission was given", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);

    // The provider adds a fee after the price was confirmed.
    const changed = await post("call-commit-northside", "record-quote-field", {
      call_token: token,
      field: "costItem:enrollment-fee",
      value: { amountCents: 5_000, currency: "EUR", appliesTo: "group", kind: "charge" },
      quote: "Oh, and there is a fifty euro enrollment fee.",
      confirmed: true,
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ stored: true, grantRevoked: true });

    expect(await stores.grants.findActive(ERRAND_ID, NOW)).toBeUndefined();
    const accepted = await reportOutcome("call-commit-northside", token, "accepted");
    expect(accepted.status).toBe(409);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
  });

  it("refuses to book terms changed behind the grant, then grants the new terms again", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);
    const held = await stores.grants.findActive(ERRAND_ID, NOW);

    // Another process edits the offer directly, without record-quote-field's revocation.
    const offer = await stores.offers.forProvider(ERRAND_ID, NORTHSIDE);
    if (offer === undefined) throw new Error("expected the offer to exist");
    await stores.offers.save({
      ...offer,
      cancellationPenalty: known(
        { amountCents: 5_000, currency: "EUR" },
        {
          source: "email",
          reference: "email-northside-001",
          quote: "Cancelling now costs 50 euros.",
          capturedAt: NOW,
        },
      ),
    });

    const accepted = await reportOutcome("call-commit-northside", token, "accepted");

    expect(accepted.status).toBe(409);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
    expect(await stores.grants.findActive(ERRAND_ID, NOW)).toBeUndefined();
    expect(await stores.grants.consume(held?.token ?? "", NOW)).toEqual({
      ok: false,
      reason: "not_active",
    });
    expect(await stores.calls.activeGrant("call-commit-northside")).toBeUndefined();

    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);
    expect((await reportOutcome("call-commit-northside", token, "accepted")).status).toBe(200);
    expect((await stores.bookings.findOpen(ERRAND_ID))?.status).toBe("verbal");
  });

  it("keeps the grant when storing the booking fails, so a retried accept books once", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);
    const held = await stores.grants.findActive(ERRAND_ID, NOW);

    const errors: unknown[] = [];
    const stored: string[] = [];
    let failNextCreate = true;
    app = createApp({
      bookings: {
        create: async (booking) => {
          if (failNextCreate) {
            failNextCreate = false;
            throw new Error("ledger offline");
          }
          const result = await stores.bookings.create(booking);
          if (result.ok) stored.push(booking.id);
          return result;
        },
        advance: (id, status, now) => stores.bookings.advance(id, status, now),
        findOpen: (errandId) => stores.bookings.findOpen(errandId),
        listRecent: (limit) => stores.bookings.listRecent(limit),
      },
      onError: (error) => errors.push(error),
    });

    const failed = await reportOutcome("call-commit-northside", token, "accepted");
    expect(failed.status).toBe(500);
    expect(errors).toHaveLength(1);
    expect((await stores.grants.findActive(ERRAND_ID, NOW))?.token).toBe(held?.token);
    expect((await stores.calls.activeGrant("call-commit-northside"))?.token).toBe(held?.token);

    const retried = await reportOutcome("call-commit-northside", token, "accepted");
    expect(retried.status).toBe(200);
    expect(stored).toHaveLength(1);
    expect((await stores.bookings.findOpen(ERRAND_ID))?.id).toBe(stored[0]);
    expect(await stores.grants.findActive(ERRAND_ID, NOW)).toBeUndefined();
    expect(await stores.calls.activeGrant("call-commit-northside")).toBeUndefined();
  });

  /** An app whose grant store throws on the next `failures` consumes, then consumes normally. */
  function appWithFailingConsume(failures: number, errors: unknown[]) {
    let remaining = failures;
    return createApp({
      grants: {
        acquire: (input) => stores.grants.acquire(input),
        findActive: (errandId, now) => stores.grants.findActive(errandId, now),
        revokeAll: (errandId, now) => stores.grants.revokeAll(errandId, now),
        consume: async (grantToken, now) => {
          if (remaining > 0) {
            remaining -= 1;
            throw new Error("grant store offline");
          }
          return await stores.grants.consume(grantToken, now);
        },
      },
      onError: (error) => errors.push(error),
    });
  }

  it("finishes a retried accept whose booking was stored before the consume failed", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);
    const held = await stores.grants.findActive(ERRAND_ID, NOW);
    const errors: unknown[] = [];
    app = appWithFailingConsume(1, errors);

    const failed = await reportOutcome("call-commit-northside", token, "accepted");
    expect(failed.status).toBe(500);
    const booking = await stores.bookings.findOpen(ERRAND_ID);
    expect(booking?.id).toBe(`booking-${held?.id}`);
    expect((await stores.grants.findActive(ERRAND_ID, NOW))?.token).toBe(held?.token);

    const retried = await reportOutcome("call-commit-northside", token, "accepted");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ recorded: true });
    expect(await stores.grants.consume(held?.token ?? "", NOW)).toEqual({
      ok: false,
      reason: "not_active",
    });
    expect(await stores.calls.activeGrant("call-commit-northside")).toBeUndefined();
    expect(await stores.bookings.findOpen(ERRAND_ID)).toEqual(booking);
    expect(errors).toHaveLength(1);
  });

  it("keeps the booking on a retried accept whose consume fails again, reporting it", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);
    const errors: unknown[] = [];
    app = appWithFailingConsume(2, errors);

    expect((await reportOutcome("call-commit-northside", token, "accepted")).status).toBe(500);
    const booking = await stores.bookings.findOpen(ERRAND_ID);

    const retried = await reportOutcome("call-commit-northside", token, "accepted");
    expect(retried.status).toBe(200);
    expect(errors).toHaveLength(2);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toEqual(booking);
    expect(await stores.calls.activeGrant("call-commit-northside")).toBeUndefined();
  });

  it("cancels a stored booking on retry when its grant ended in between, like a first attempt", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);

    let consumeCalls = 0;
    app = createApp({
      grants: {
        acquire: (input) => stores.grants.acquire(input),
        findActive: (errandId, now) => stores.grants.findActive(errandId, now),
        revokeAll: (errandId, now) => stores.grants.revokeAll(errandId, now),
        consume: async (grantToken, now) => {
          consumeCalls += 1;
          // First attempt: the store is offline after the booking is stored.
          if (consumeCalls === 1) throw new Error("grant store offline");
          // Retry: the grant ends between the check and the consume.
          await stores.grants.revokeAll(ERRAND_ID, now);
          return await stores.grants.consume(grantToken, now);
        },
      },
    });

    expect((await reportOutcome("call-commit-northside", token, "accepted")).status).toBe(500);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeDefined();

    const retry = await reportOutcome("call-commit-northside", token, "accepted");
    expect(retry.status).toBe(409);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
    expect(await stores.calls.activeGrant("call-commit-northside")).toBeUndefined();
  });

  it("never cancels a booking whose grant was already consumed before a later step failed", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);

    let clearFailures = 1;
    app = createApp({
      calls: {
        create: (call) => stores.calls.create(call),
        findById: (id) => stores.calls.findById(id),
        findByExternalId: (externalId) => stores.calls.findByExternalId(externalId),
        update: (call) => stores.calls.update(call),
        activeGrant: (callId) => stores.calls.activeGrant(callId),
        setActiveGrant: async (callId, binding) => {
          // The grant is consumed, then clearing the binding fails once.
          if (binding === null && clearFailures > 0) {
            clearFailures -= 1;
            throw new Error("call store offline");
          }
          return await stores.calls.setActiveGrant(callId, binding);
        },
      },
    });

    expect((await reportOutcome("call-commit-northside", token, "accepted")).status).toBe(500);
    const booked = await stores.bookings.findOpen(ERRAND_ID);
    expect(booked?.status).toBe("verbal");

    // The consumed grant is no longer active, so the retry stops before any cancellation.
    expect((await reportOutcome("call-commit-northside", token, "accepted")).status).toBe(409);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toEqual(booked);
  });

  it("cancels the booking it stored when the grant ends before it is consumed", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);

    const stored: string[] = [];
    const cancelled: string[] = [];
    app = createApp({
      grants: {
        acquire: (input) => stores.grants.acquire(input),
        findActive: (errandId, now) => stores.grants.findActive(errandId, now),
        revokeAll: (errandId, now) => stores.grants.revokeAll(errandId, now),
        // Another process revokes the grant between the check and the consume.
        consume: async (grantToken, now) => {
          await stores.grants.revokeAll(ERRAND_ID, now);
          return await stores.grants.consume(grantToken, now);
        },
      },
      bookings: {
        create: async (booking) => {
          const result = await stores.bookings.create(booking);
          if (result.ok) stored.push(booking.id);
          return result;
        },
        advance: async (id, status, now) => {
          const result = await stores.bookings.advance(id, status, now);
          if (result.ok && status === "cancelled") cancelled.push(id);
          return result;
        },
        findOpen: (errandId) => stores.bookings.findOpen(errandId),
        listRecent: (limit) => stores.bookings.listRecent(limit),
      },
    });

    const accepted = await reportOutcome("call-commit-northside", token, "accepted");

    expect(accepted.status).toBe(409);
    expect(stored).toHaveLength(1);
    expect(cancelled).toEqual(stored);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
  });

  it("answers 409 and books nothing once the grant has expired", async () => {
    let clock = NOW;
    app = createApp({ now: () => clock, grantTtlSeconds: 60 });
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    await recordEligibleOffer("call-commit-northside", token);
    expect((await requestPermission("call-commit-northside", token)).granted).toBe(true);

    clock = "2026-09-30T10:01:01.000Z";
    const accepted = await reportOutcome("call-commit-northside", token, "accepted");

    expect(accepted.status).toBe(409);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
    expect(await stores.grants.findActive(ERRAND_ID, clock)).toBeUndefined();
  });

  it("reports an unexpected error through onError and answers a generic 500", async () => {
    const token = await addCall("call-quote-northside", "quote", NORTHSIDE);
    const errors: unknown[] = [];
    const failingApp = createVoiceToolsApp({
      calls: stores.calls,
      errands: {
        save: stores.errands.save.bind(stores.errands),
        get: async () => {
          throw new Error("storage offline");
        },
        listRecent: stores.errands.listRecent.bind(stores.errands),
      },
      offers: stores.offers,
      grants: stores.grants,
      bookings: stores.bookings,
      standingRules,
      now: () => NOW,
      toolsKey,
      onError: (error) => errors.push(error),
    });

    const response = await failingApp.request(
      "/voice-tools/call-quote-northside/get-errand-context",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Booker-Tools-Key": toolsKey },
        body: JSON.stringify({ call_token: token }),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("storage offline");
    expect(errors).toHaveLength(1);
  });

  it("answers 409 when the call holds no active grant", async () => {
    const token = await addCall("call-commit-northside", "commit", NORTHSIDE);
    const response = await reportOutcome("call-commit-northside", token, "accepted");
    expect(response.status).toBe(409);
    expect(await stores.bookings.findOpen(ERRAND_ID)).toBeUndefined();
  });
});
