import { describe, expect, it } from "vitest";
import type { ErrandBrief } from "../errands/brief.ts";
import { parseErrandBrief } from "../errands/brief.ts";
import { groupCost } from "../offers/cost.ts";
import { known } from "../offers/field.ts";
import type { Offer } from "../offers/offer.ts";
import { parseOffer } from "../offers/offer.ts";
import { dateRangeSchema } from "../shared/dates.ts";
import { allowedQuoteFields, applyQuoteField, isAllowedQuoteField } from "./quote-fields.ts";

const NOW = "2026-09-29T10:00:00.000Z";
const CALL_ID = "call-001";
const SAMPLE_DATE_RANGE = dateRangeSchema.parse({ start: "2026-11-03", end: "2026-11-12" });

function brief(overrides: Record<string, unknown> = {}): ErrandBrief {
  const result = parseErrandBrief({
    id: "errand-001",
    kind: "driving-school",
    objective: "Enroll one participant.",
    timeZone: "Europe/Madrid",
    participants: [{ id: "participant-a", attributes: {} }],
    location: { area: "Northside district", acceptableAlternatives: [] },
    dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
    hardRequirements: [
      {
        id: "req-licence-category",
        description: "Must cover licence category B",
        field: "licenceCategory",
        rule: { op: "equals", value: "B" },
      },
    ],
    preferences: [],
    spendLimits: { currency: "EUR", totalMax: { amountCents: 120_000, currency: "EUR" } },
    authorizedActions: ["quote", "hold"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: { description: "Enrolled.", requiresWrittenConfirmation: false },
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
    seatsAvailable: { status: "unknown" },
    dates: { status: "unknown" },
    location: { status: "unknown" },
    costItems: [],
    deposit: { status: "unknown" },
    cancellationPenalty: { status: "unknown" },
    extras: [],
    customFields: {},
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture offer: ${result.issues.join(", ")}`);
  return result.offer;
}

describe("allowedQuoteFields", () => {
  it("lists the standard offer fields, the brief's custom fields, and the cost-item pattern", () => {
    const allowed = allowedQuoteFields(brief());
    expect(allowed.standard).toEqual([
      "seatsAvailable",
      "dates",
      "location",
      "deposit",
      "cancellationPenalty",
    ]);
    expect(allowed.custom).toEqual(["licenceCategory"]);
    expect(allowed.costItemPattern.test("costItem:tuition")).toBe(true);
  });
});

describe("isAllowedQuoteField", () => {
  it.each(["seatsAvailable", "dates", "location", "deposit", "cancellationPenalty"])(
    "allows the standard field %s",
    (field) => {
      expect(isAllowedQuoteField(brief(), field)).toBe(true);
    },
  );

  it("allows a custom field named by a hard requirement", () => {
    expect(isAllowedQuoteField(brief(), "licenceCategory")).toBe(true);
  });

  it("allows any costItem:<id> field", () => {
    expect(isAllowedQuoteField(brief(), "costItem:tuition")).toBe(true);
    expect(isAllowedQuoteField(brief(), "costItem:late-fee")).toBe(true);
  });

  it("rejects a costItem field with no id", () => {
    expect(isAllowedQuoteField(brief(), "costItem:")).toBe(false);
  });

  it("rejects an unrecognized field", () => {
    expect(isAllowedQuoteField(brief(), "spendLimits")).toBe(false);
  });
});

describe("applyQuoteField", () => {
  it("rejects a field outside allowedQuoteFields", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "spendLimits", value: "anything", quote: "n/a", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "field_not_allowed" });
  });

  it("stores a confirmed seatsAvailable as known with call evidence", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "seatsAvailable", value: 4, quote: "We have four seats left.", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offer.seatsAvailable).toEqual(
        known(4, {
          source: "call",
          reference: CALL_ID,
          quote: "We have four seats left.",
          capturedAt: NOW,
        }),
      );
    }
  });

  it("stores an unconfirmed seatsAvailable as estimated", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "seatsAvailable", value: 4, quote: "Maybe four seats.", confirmed: false },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.offer.seatsAvailable.status).toBe("estimated");
  });

  it("rejects a negative seatsAvailable", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "seatsAvailable", value: -1, quote: "n/a", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("rejects a non-integer seatsAvailable", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "seatsAvailable", value: 1.5, quote: "n/a", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("stores a valid dates range", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "dates",
        value: SAMPLE_DATE_RANGE,
        quote: "We can do the 3rd through the 12th.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offer.dates).toEqual(
        known(
          { start: "2026-11-03", end: "2026-11-12" },
          {
            source: "call",
            reference: CALL_ID,
            quote: "We can do the 3rd through the 12th.",
            capturedAt: NOW,
          },
        ),
      );
    }
  });

  it("rejects an invalid dates value", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "dates", value: "sometime in November", quote: "n/a", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("stores a location string", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "location",
        value: "Northside district",
        quote: "We're on Northside district.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.offer.location.status).toBe("known");
  });

  it("rejects an empty location", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "location", value: "", quote: "n/a", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("rejects a whitespace-only location", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "location", value: "   ", quote: "n/a", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("stores a location with surrounding whitespace trimmed", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "location",
        value: "  Northside district  ",
        quote: "We're on Northside district.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offer.location).toEqual(
        known("Northside district", {
          source: "call",
          reference: CALL_ID,
          quote: "We're on Northside district.",
          capturedAt: NOW,
        }),
      );
    }
  });

  it("stores a deposit in the brief currency", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "deposit",
        value: { amountCents: 10_000, currency: "EUR" },
        quote: "The deposit is 100 euros.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.offer.deposit.status).toBe("known");
  });

  it("rejects a deposit in the wrong currency", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "deposit",
        value: { amountCents: 10_000, currency: "USD" },
        quote: "n/a",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("rejects a non-Money deposit value", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "deposit", value: "one hundred euros", quote: "n/a", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("stores a cancellationPenalty in the brief currency", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "cancellationPenalty",
        value: { amountCents: 5_000, currency: "EUR" },
        quote: "The cancellation fee is 50 euros.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.offer.cancellationPenalty.status).toBe("known");
  });

  it("rejects creating a new cost item without appliesTo and kind (no default)", () => {
    // A plain Money value used to silently create a "group"/"charge" item; that default
    // misprices a per-participant charge as a shared one, so creation now requires both.
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "costItem:registration-fee",
        value: { amountCents: 3_000, currency: "EUR" },
        quote: "There's a registration fee of 30 euros.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("creates a new cost item using exactly the given appliesTo and kind, labeled from the id", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "costItem:registration-fee",
        value: {
          amountCents: 3_000,
          currency: "EUR",
          appliesTo: "each-participant",
          kind: "charge",
        },
        quote: "There's a registration fee of 30 euros per participant.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offer.costItems).toEqual([
        {
          id: "registration-fee",
          label: "registration fee",
          appliesTo: "each-participant",
          kind: "charge",
          amount: known(
            { amountCents: 3_000, currency: "EUR" },
            {
              source: "call",
              reference: CALL_ID,
              quote: "There's a registration fee of 30 euros per participant.",
              capturedAt: NOW,
            },
          ),
        },
      ]);
    }
  });

  it("charges a per-participant cost item to every participant, not split as a group total", () => {
    const twoParticipantBrief = brief({
      participants: [
        { id: "participant-a", attributes: {} },
        { id: "participant-b", attributes: {} },
      ],
    });
    const result = applyQuoteField(
      offer(),
      twoParticipantBrief,
      {
        field: "costItem:tuition",
        value: {
          amountCents: 60_000,
          currency: "EUR",
          appliesTo: "each-participant",
          kind: "charge",
        },
        quote: "Tuition is 600 euros per participant.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const total = groupCost(twoParticipantBrief, result.offer).total;
      expect(total).toEqual({ amountCents: 120_000, currency: "EUR" });
    }
  });

  it("creates a discount cost item that subtracts from the group total", () => {
    const singleParticipantBrief = brief();
    const charged = applyQuoteField(
      offer(),
      singleParticipantBrief,
      {
        field: "costItem:tuition",
        value: { amountCents: 60_000, currency: "EUR", appliesTo: "group", kind: "charge" },
        quote: "Tuition is 600 euros total.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(charged.ok).toBe(true);
    if (!charged.ok) return;

    const discounted = applyQuoteField(
      charged.offer,
      singleParticipantBrief,
      {
        field: "costItem:early-bird",
        value: { amountCents: 10_000, currency: "EUR", appliesTo: "group", kind: "discount" },
        quote: "There's a 100 euro early-bird discount.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(discounted.ok).toBe(true);
    if (discounted.ok) {
      const total = groupCost(singleParticipantBrief, discounted.offer).total;
      expect(total).toEqual({ amountCents: 50_000, currency: "EUR" });
    }
  });

  it("rejects a costItem appliesTo that names a participant not in the brief", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "costItem:single-room",
        value: {
          amountCents: 2_000,
          currency: "EUR",
          appliesTo: { participantIds: ["participant-ghost"] },
          kind: "charge",
        },
        quote: "There's a single-room supplement.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("updates only the amount of an existing cost item, keeping its label/appliesTo/kind", () => {
    const existing = offer({
      costItems: [
        {
          id: "tuition",
          label: "Tuition per participant",
          appliesTo: "each-participant",
          kind: "charge",
          amount: { status: "unknown" },
        },
      ],
    });
    const result = applyQuoteField(
      existing,
      brief(),
      {
        field: "costItem:tuition",
        value: { amountCents: 60_000, currency: "EUR" },
        quote: "Tuition is 600 euros per participant.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offer.costItems).toEqual([
        {
          id: "tuition",
          label: "Tuition per participant",
          appliesTo: "each-participant",
          kind: "charge",
          amount: known(
            { amountCents: 60_000, currency: "EUR" },
            {
              source: "call",
              reference: CALL_ID,
              quote: "Tuition is 600 euros per participant.",
              capturedAt: NOW,
            },
          ),
        },
      ]);
    }
  });

  it("updates appliesTo and kind of an existing cost item when they are provided", () => {
    const existing = offer({
      costItems: [
        {
          id: "tuition",
          label: "Tuition per participant",
          appliesTo: "each-participant",
          kind: "charge",
          amount: { status: "unknown" },
        },
      ],
    });
    const result = applyQuoteField(
      existing,
      brief(),
      {
        field: "costItem:tuition",
        value: { amountCents: 60_000, currency: "EUR", appliesTo: "group", kind: "discount" },
        quote: "Actually it's a 600 euro group discount.",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const item = result.offer.costItems.find((candidate) => candidate.id === "tuition");
      expect(item?.appliesTo).toBe("group");
      expect(item?.kind).toBe("discount");
      expect(item?.label).toBe("Tuition per participant");
    }
  });

  it("rejects a cost item amount in the wrong currency", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "costItem:tuition",
        value: { amountCents: 60_000, currency: "USD" },
        quote: "n/a",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("stores a custom field named by a hard requirement", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "licenceCategory", value: "B", quote: "It's category B.", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offer.customFields["licenceCategory"]).toEqual(
        known("B", {
          source: "call",
          reference: CALL_ID,
          quote: "It's category B.",
          capturedAt: NOW,
        }),
      );
    }
  });

  it("rejects a Money value for a custom field", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "licenceCategory",
        value: { amountCents: 100, currency: "EUR" },
        quote: "n/a",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("rejects a whitespace-only custom field string", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "licenceCategory", value: "   ", quote: "n/a", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("stores a custom field string with surrounding whitespace trimmed", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "licenceCategory", value: "  B  ", quote: "It's category B.", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.offer.customFields["licenceCategory"]).toEqual(
        known("B", {
          source: "call",
          reference: CALL_ID,
          quote: "It's category B.",
          capturedAt: NOW,
        }),
      );
    }
  });

  it.each([Infinity, -Infinity, NaN])("rejects a non-finite custom field number (%s)", (value) => {
    const result = applyQuoteField(
      offer(),
      brief(),
      { field: "licenceCategory", value, quote: "n/a", confirmed: true },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("rejects updating an existing cost item with an appliesTo naming an unknown participant", () => {
    const existing = offer({
      costItems: [
        {
          id: "tuition",
          label: "Tuition per participant",
          appliesTo: "each-participant",
          kind: "charge",
          amount: { status: "unknown" },
        },
      ],
    });
    const result = applyQuoteField(
      existing,
      brief(),
      {
        field: "costItem:tuition",
        value: {
          amountCents: 60_000,
          currency: "EUR",
          appliesTo: { participantIds: ["participant-ghost"] },
        },
        quote: "n/a",
        confirmed: true,
      },
      NOW,
      CALL_ID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("stores an unconfirmed money field as estimated", () => {
    const result = applyQuoteField(
      offer(),
      brief(),
      {
        field: "deposit",
        value: { amountCents: 10_000, currency: "EUR" },
        quote: "Maybe the deposit is 100 euros.",
        confirmed: false,
      },
      NOW,
      CALL_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.offer.deposit.status).toBe("estimated");
  });
});
