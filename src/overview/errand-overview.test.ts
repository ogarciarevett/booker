import { describe, expect, it } from "vitest";
import type { Booking } from "../bookings/ledger.ts";
import { type Call, type CallStatus, startCall } from "../calls/call.ts";
import { type ErrandBrief, parseErrandBrief } from "../errands/brief.ts";
import { type Evidence, estimated, known, unknown } from "../offers/field.ts";
import { type Offer, parseOffer } from "../offers/offer.ts";
import { type ErrandOverviewInput, errandOverview } from "./errand-overview.ts";

const NOW = "2026-10-08T10:00:00.000Z";
const NORTHSIDE = "provider-northside";
const HARBOR = "provider-harbor";
const LAKESIDE = "provider-lakeside";

function evidence(quote = "We have two seats left that week."): Evidence {
  return { source: "call", reference: "call-1", quote, capturedAt: "2026-10-08T09:30:00.000Z" };
}

function brief(overrides: Record<string, unknown> = {}): ErrandBrief {
  const result = parseErrandBrief({
    id: "errand-001",
    kind: "driving-school",
    objective: "Enroll two participants in an intensive course.",
    timeZone: "Europe/Madrid",
    participants: [
      { id: "participant-a", attributes: {} },
      { id: "participant-b", attributes: {} },
    ],
    location: { area: "Northside district", acceptableAlternatives: [] },
    dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
    hardRequirements: [],
    preferences: [],
    spendLimits: { currency: "EUR", totalMax: { amountCents: 200_000, currency: "EUR" } },
    authorizedActions: ["quote", "book"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: { description: "Both enrolled.", requiresWrittenConfirmation: false },
    questions: [],
    providers: [
      { id: NORTHSIDE, name: "Northside", phoneE164: "+15555550100" },
      { id: HARBOR, name: "Harbor", phoneE164: "+15555550101" },
      { id: LAKESIDE, name: "Lakeside", phoneE164: "+15555550102" },
    ],
    shareableAttributes: [],
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

function offer(providerId: string, overrides: Record<string, unknown> = {}): Offer {
  const result = parseOffer({
    id: `offer-${providerId}`,
    errandId: "errand-001",
    providerId,
    queriedAt: "2026-10-08T09:30:00.000Z",
    seatsAvailable: known(2, evidence()),
    dates: known({ start: "2026-11-03", end: "2026-11-12" }, evidence()),
    location: known("Northside district", evidence()),
    costItems: [
      {
        id: "tuition",
        label: "Tuition",
        appliesTo: "each-participant",
        kind: "charge",
        amount: known({ amountCents: 60_000, currency: "EUR" }, evidence()),
      },
    ],
    deposit: known({ amountCents: 5_000, currency: "EUR" }, evidence()),
    cancellationPenalty: known({ amountCents: 2_000, currency: "EUR" }, evidence()),
    extras: [],
    customFields: {},
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture offer: ${result.issues.join(", ")}`);
  return result.offer;
}

let sequence = 0;

function call(providerId: string, status: CallStatus, attempt = 1): Call {
  sequence += 1;
  const createdAt = `2026-10-08T09:${String(sequence).padStart(2, "0")}:00.000Z`;
  const started = startCall({
    id: `call-${sequence}`,
    errandId: "errand-001",
    providerId,
    purpose: "quote",
    attempt,
    tokenHash: "a".repeat(64),
    now: createdAt,
  });
  const open = status === "scheduled" || status === "in_progress";
  return { ...started, status, endedAt: open ? null : createdAt };
}

function overview(input: Partial<ErrandOverviewInput> = {}) {
  return errandOverview({
    brief: brief(),
    calls: [],
    offers: [],
    booking: undefined,
    activeGrant: undefined,
    now: NOW,
    ...input,
  });
}

function provider(result: ReturnType<typeof errandOverview>, providerId: string) {
  const found = result.providers.find((candidate) => candidate.providerId === providerId);
  if (found === undefined) throw new Error(`no provider ${providerId}`);
  return found;
}

describe("errandOverview", () => {
  it("starts preparing, with every provider not called yet and all of them left to call", () => {
    const result = overview();

    expect(result.stage).toBe("preparing");
    expect(result.providers.map((row) => [row.providerId, row.status])).toEqual([
      [NORTHSIDE, "not_called"],
      [HARBOR, "not_called"],
      [LAKESIDE, "not_called"],
    ]);
    expect(result.counts).toMatchObject({ notCalled: 3, pending: 3, calling: 0 });
    expect(result.progress).toEqual({ done: 0, total: 3 });
    expect(result.missing.providersToCall.map((row) => row.providerId)).toEqual([
      NORTHSIDE,
      HARBOR,
      LAKESIDE,
    ]);
  });

  it("is calling while any call is open, and leaves the busy provider out of those to call", () => {
    const result = overview({ calls: [call(NORTHSIDE, "in_progress")] });

    expect(result.stage).toBe("calling");
    expect(provider(result, NORTHSIDE)).toMatchObject({ status: "calling", attempts: 1 });
    expect(result.counts.calling).toBe(1);
    expect(result.missing.providersToCall.map((row) => row.providerId)).toEqual([HARBOR, LAKESIDE]);
  });

  it("summarizes a quote: total, per person, estimates, and what is still unknown", () => {
    const quoted = offer(NORTHSIDE, {
      costItems: [
        {
          id: "tuition",
          label: "Tuition",
          appliesTo: "each-participant",
          kind: "charge",
          amount: estimated({ amountCents: 55_000, currency: "EUR" }, evidence()),
        },
      ],
      deposit: unknown(),
    });

    const result = overview({ calls: [call(NORTHSIDE, "completed")], offers: [quoted] });
    const row = provider(result, NORTHSIDE);

    expect(row.status).toBe("quoted");
    expect(row.offer).toMatchObject({
      evaluation: "incomplete",
      total: { amountCents: 110_000, currency: "EUR" },
      perPerson: { amountCents: 55_000, currency: "EUR" },
      estimated: true,
    });
    // evaluateOffer's own wording: the estimated tuition leaves the total unconfirmed.
    expect(row.offer?.unknowns).toEqual(["total: cost is not fully confirmed"]);
    expect(result.stage).toBe("waiting_for_you");
    expect(result.missing.leadingProviderId).toBe(NORTHSIDE);
    expect(result.missing.unknownFields).toEqual(row.offer?.unknowns);
  });

  it("ranks the quotes as rankOffers does: eligible first, then by total", () => {
    const cheaper = offer(HARBOR, {
      costItems: [
        {
          id: "tuition",
          label: "Tuition",
          appliesTo: "each-participant",
          kind: "charge",
          amount: known({ amountCents: 50_000, currency: "EUR" }, evidence()),
        },
      ],
    });

    const result = overview({
      calls: [call(NORTHSIDE, "completed"), call(HARBOR, "completed")],
      offers: [offer(NORTHSIDE), cheaper],
    });

    expect(
      result.ranking.map((row) => [row.providerId, row.evaluation, row.total.amountCents]),
    ).toEqual([
      [HARBOR, "eligible", 100_000],
      [NORTHSIDE, "eligible", 120_000],
    ]);
    expect(result.ranking[0]?.name).toBe("Harbor");
  });

  it("tells a provider that has no seats (it turned the errand down) from one the rules rule out", () => {
    const full = offer(NORTHSIDE, { seatsAvailable: known(0, evidence("Estamos completos.")) });
    const elsewhere = offer(HARBOR, { location: known("Harbor district", evidence()) });

    const result = overview({
      calls: [call(NORTHSIDE, "completed"), call(HARBOR, "completed")],
      offers: [full, elsewhere],
    });

    expect(provider(result, NORTHSIDE)).toMatchObject({
      status: "declined_by_provider",
      reasons: ["No seats available"],
      quote: "Estamos completos.",
    });
    expect(provider(result, HARBOR)).toMatchObject({
      status: "ruled_out_by_rules",
      reasons: ['location "Harbor district" is not the brief area or an acceptable alternative'],
    });
    expect(result.counts).toMatchObject({ declined: 1, ruledOut: 1 });
  });

  it("counts unanswered attempts against the cap, and stops offering a provider once it is spent", () => {
    const once = overview({ calls: [call(NORTHSIDE, "no_answer", 1)] });
    const twice = overview({
      calls: [call(NORTHSIDE, "no_answer", 1), call(NORTHSIDE, "no_answer", 2)],
    });

    expect(provider(once, NORTHSIDE)).toMatchObject({
      status: "no_answer",
      attempts: 1,
      maxAttempts: 2,
      canRetry: true,
      reasons: ["No answer (attempt 1 of 2)"],
    });
    expect(once.missing.providersToCall.map((row) => row.providerId)).toContain(NORTHSIDE);
    expect(provider(twice, NORTHSIDE)).toMatchObject({
      status: "no_answer",
      canRetry: false,
      reasons: ["No answer after 2 attempts"],
    });
    expect(twice.missing.providersToCall.map((row) => row.providerId)).not.toContain(NORTHSIDE);
    expect(twice.progress).toEqual({ done: 1, total: 3 });
  });

  it("says a call that ended with nothing recorded got no quote, and a failed one failed", () => {
    const result = overview({
      calls: [call(NORTHSIDE, "completed"), call(HARBOR, "failed")],
    });

    expect(provider(result, NORTHSIDE)).toMatchObject({
      status: "no_quote",
      reasons: ["The call ended without a quote"],
    });
    expect(provider(result, HARBOR)).toMatchObject({
      status: "failed",
      reasons: ["The call failed"],
    });
  });

  it("is closed when every provider is settled without a quote", () => {
    const calls = [NORTHSIDE, HARBOR, LAKESIDE].flatMap((id) => [
      call(id, "no_answer", 1),
      call(id, "no_answer", 2),
    ]);

    const result = overview({ calls });

    expect(result.stage).toBe("closed");
    expect(result.missing.providersToCall).toEqual([]);
    expect(result.progress).toEqual({ done: 3, total: 3 });
  });

  it("shows the commit grant while it is active", () => {
    const result = overview({
      calls: [call(NORTHSIDE, "completed")],
      offers: [offer(NORTHSIDE)],
      activeGrant: { providerId: NORTHSIDE, expiresAt: "2026-10-08T10:15:00.000Z" },
    });

    expect(result.missing.commit).toEqual({
      state: "grant_active",
      providerId: NORTHSIDE,
      grantExpiresAt: "2026-10-08T10:15:00.000Z",
    });
  });

  it("is booked once a booking holds, waiting for written confirmation when the brief asks", () => {
    const booking: Booking = {
      id: "booking-001",
      errandId: "errand-001",
      offerId: `offer-${NORTHSIDE}`,
      providerId: NORTHSIDE,
      participantIds: ["participant-a", "participant-b"],
      status: "verbal",
      history: [{ status: "verbal", at: "2026-10-08T09:50:00.000Z" }],
    };
    const strict = brief({
      completion: { description: "Both enrolled.", requiresWrittenConfirmation: true },
    });

    const verbal = overview({
      brief: strict,
      calls: [call(NORTHSIDE, "completed")],
      offers: [offer(NORTHSIDE)],
      booking,
    });
    const enrolled = overview({
      brief: strict,
      calls: [call(NORTHSIDE, "completed")],
      offers: [offer(NORTHSIDE)],
      booking: { ...booking, status: "enrolled" },
    });

    expect(verbal.stage).toBe("booked");
    expect(verbal.missing.writtenConfirmation).toBe("pending");
    expect(verbal.missing.commit).toEqual({
      state: "booked",
      providerId: NORTHSIDE,
      bookingStatus: "verbal",
    });
    expect(enrolled.stage).toBe("closed");
    expect(enrolled.missing.writtenConfirmation).toBe("received");
    expect(enrolled.lastActivityAt).toBe("2026-10-08T09:50:00.000Z");
  });

  it("needs no written confirmation when the brief does not ask for one", () => {
    expect(overview().missing.writtenConfirmation).toBe("not_required");
  });
});
