import { describe, expect, it } from "vitest";
import type { ErrandBrief } from "../errands/brief.ts";
import { parseErrandBrief } from "../errands/brief.ts";
import { known } from "../offers/field.ts";
import type { Offer } from "../offers/offer.ts";
import { parseOffer } from "../offers/offer.ts";
import { advanceBooking, type Booking, createBooking } from "./ledger.ts";

const NOW = "2026-09-29T10:00:00.000Z";

function evidence() {
  return {
    source: "call" as const,
    reference: "call-2026-09-29-10:00",
    quote: "We can confirm those terms.",
    capturedAt: NOW,
  };
}

function brief(overrides: Record<string, unknown> = {}): ErrandBrief {
  const result = parseErrandBrief({
    id: "errand-001",
    kind: "driving-school",
    objective: "Enroll two participants.",
    timeZone: "Europe/Madrid",
    participants: [
      { id: "participant-a", attributes: {} },
      { id: "participant-b", attributes: {} },
    ],
    location: { area: "Northside district", acceptableAlternatives: [] },
    dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
    hardRequirements: [],
    preferences: [],
    spendLimits: { currency: "EUR" },
    authorizedActions: ["quote", "book"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: { description: "Both enrolled.", requiresWrittenConfirmation: false },
    questions: [],
    providers: [{ id: "provider-northside", name: "Northside", phoneE164: "+15555550100" }],
    shareableAttributes: [],
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

function offer(overrides: Record<string, unknown> = {}): Offer {
  const result = parseOffer({
    id: "offer-001",
    errandId: "errand-001",
    providerId: "provider-northside",
    queriedAt: NOW,
    seatsAvailable: known(2, evidence()),
    dates: known({ start: "2026-11-03", end: "2026-11-12" }, evidence()),
    location: known("Northside district", evidence()),
    costItems: [],
    deposit: known({ amountCents: 10_000, currency: "EUR" }, evidence()),
    cancellationPenalty: known({ amountCents: 5_000, currency: "EUR" }, evidence()),
    extras: [],
    customFields: {},
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture offer: ${result.issues.join(", ")}`);
  return result.offer;
}

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "booking-001",
    errandId: "errand-001",
    offerId: "offer-001",
    providerId: "provider-northside",
    participantIds: ["participant-a", "participant-b"],
    status: "verbal",
    history: [{ status: "verbal", at: NOW }],
    ...overrides,
  };
}

describe("createBooking", () => {
  it("creates a verbal booking for the full participant group", () => {
    const result = createBooking({
      brief: brief(),
      offer: offer(),
      participantIds: ["participant-a", "participant-b"],
      id: "booking-001",
      now: NOW,
    });
    expect(result).toEqual({
      ok: true,
      booking: {
        id: "booking-001",
        errandId: "errand-001",
        offerId: "offer-001",
        providerId: "provider-northside",
        participantIds: ["participant-a", "participant-b"],
        status: "verbal",
        history: [{ status: "verbal", at: NOW }],
      },
    });
  });

  it("rejects a partial group when the brief does not allow it", () => {
    const result = createBooking({
      brief: brief(),
      offer: offer(),
      participantIds: ["participant-a"],
      id: "booking-001",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "partial_group_not_allowed" });
  });

  it("allows a partial group when the brief opts in", () => {
    const result = createBooking({
      brief: brief({ groupPolicy: { sameProvider: true, allowPartialBooking: true } }),
      offer: offer(),
      participantIds: ["participant-a"],
      id: "booking-001",
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown participant id", () => {
    const result = createBooking({
      brief: brief(),
      offer: offer(),
      participantIds: ["participant-a", "participant-ghost"],
      id: "booking-001",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "unknown_participant" });
  });

  it("rejects a duplicate participant id", () => {
    const result = createBooking({
      brief: brief({ groupPolicy: { sameProvider: true, allowPartialBooking: true } }),
      offer: offer(),
      participantIds: ["participant-a", "participant-a"],
      id: "booking-001",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate_participant" });
  });

  it("rejects an offer for a different errand", () => {
    const result = createBooking({
      brief: brief(),
      offer: offer({ errandId: "errand-999" }),
      participantIds: ["participant-a", "participant-b"],
      id: "booking-001",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "offer_errand_mismatch" });
  });
});

describe("advanceBooking", () => {
  it("advances verbal to written", () => {
    const result = advanceBooking(booking(), "written", "2026-09-29T11:00:00.000Z");
    expect(result).toEqual({
      ok: true,
      booking: booking({
        status: "written",
        history: [
          { status: "verbal", at: NOW },
          { status: "written", at: "2026-09-29T11:00:00.000Z" },
        ],
      }),
    });
  });

  it("allows skipping written and going straight to enrolled", () => {
    const result = advanceBooking(booking(), "enrolled", "2026-09-29T11:00:00.000Z");
    expect(result.ok).toBe(true);
  });

  it("allows cancelling from verbal", () => {
    const result = advanceBooking(booking(), "cancelled", "2026-09-29T11:00:00.000Z");
    expect(result.ok).toBe(true);
  });

  it("allows cancelling from enrolled", () => {
    const result = advanceBooking(
      booking({ status: "enrolled", history: [{ status: "enrolled", at: NOW }] }),
      "cancelled",
      "2026-09-29T11:00:00.000Z",
    );
    expect(result.ok).toBe(true);
  });

  it("rejects going backward from written to verbal", () => {
    const result = advanceBooking(
      booking({ status: "written", history: [{ status: "written", at: NOW }] }),
      "verbal",
      "2026-09-29T11:00:00.000Z",
    );
    expect(result).toEqual({ ok: false });
  });

  it("rejects moving to the same status", () => {
    const result = advanceBooking(booking(), "verbal", "2026-09-29T11:00:00.000Z");
    expect(result).toEqual({ ok: false });
  });

  it("rejects any move once cancelled", () => {
    const result = advanceBooking(
      booking({ status: "cancelled", history: [{ status: "cancelled", at: NOW }] }),
      "written",
      "2026-09-29T11:00:00.000Z",
    );
    expect(result).toEqual({ ok: false });
  });
});

describe("ledger instants and empty groups", () => {
  it("rejects an empty participant list even when partial bookings are allowed", () => {
    const result = createBooking({
      brief: brief({ groupPolicy: { sameProvider: true, allowPartialBooking: true } }),
      offer: offer(),
      participantIds: [],
      id: "booking-001",
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "empty_group" });
  });

  it("records history times as canonical UTC instants", () => {
    const created = createBooking({
      brief: brief(),
      offer: offer(),
      participantIds: ["participant-a", "participant-b"],
      id: "booking-001",
      now: "2026-09-29T12:00:00+02:00",
    });
    if (!created.ok) throw new Error("expected a booking");
    expect(created.booking.history).toEqual([{ status: "verbal", at: "2026-09-29T10:00:00.000Z" }]);
  });

  it("rejects a history time without an explicit offset", () => {
    expect(() => advanceBooking(booking(), "written", "2026-09-29T10:00:00")).toThrow(RangeError);
  });

  it("rejects an offset-less now in createBooking before any state-dependent check", () => {
    expect(() =>
      createBooking({
        brief: brief(),
        offer: offer(),
        participantIds: ["participant-a", "participant-b"],
        id: "booking-001",
        now: "2026-09-29T10:00:00",
      }),
    ).toThrow(RangeError);
  });

  it("throws on a malformed now for an invalid transition, instead of returning ok: false", () => {
    const cancelled = booking({ status: "cancelled", history: [{ status: "cancelled", at: NOW }] });
    expect(() => advanceBooking(cancelled, "written", "not a time")).toThrow(RangeError);
  });
});
