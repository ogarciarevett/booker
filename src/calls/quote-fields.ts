import type { ErrandBrief } from "../errands/brief.ts";
import { type Evidence, estimated, known } from "../offers/field.ts";
import type { CostItem, Offer } from "../offers/offer.ts";
import { type DateRange, dateRangeSchema } from "../shared/dates.ts";
import { toCanonicalInstant } from "../shared/instants.ts";
import { type Money, moneySchema } from "../shared/money.ts";
import { type CostItemFieldValue, costItemFieldValueSchema } from "./tools.ts";

const STANDARD_OFFER_FIELDS = [
  "seatsAvailable",
  "dates",
  "location",
  "deposit",
  "cancellationPenalty",
] as const;

export type StandardOfferField = (typeof STANDARD_OFFER_FIELDS)[number];

/**
 * A provider-introduced line item (a registration fee, a late fee, ...) cannot be
 * predeclared by the brief, so it is named by convention instead of enumeration:
 * `costItem:<id>`, where `<id>` is one or more letters, digits, `_`, or `-`. Any such id is
 * allowed; its value must be a `CostItemFieldValue` (see tools.ts), never a plain Money
 * amount — `appliesTo` and `kind` have no default, since defaulting a per-participant
 * charge to a shared group charge would misprice a multi-participant errand. Creating a new
 * item requires both explicitly; updating an existing one only touches `amount` unless
 * `appliesTo`/`kind` are also given, in which case those are overwritten too.
 */
const COST_ITEM_FIELD_PATTERN = /^costItem:([A-Za-z0-9_-]+)$/;

export interface AllowedQuoteFields {
  readonly standard: readonly StandardOfferField[];
  readonly custom: readonly string[];
  readonly costItemPattern: RegExp;
}

/** Fields a voice call may record onto an offer draft for this brief. */
export function allowedQuoteFields(brief: ErrandBrief): AllowedQuoteFields {
  return {
    standard: STANDARD_OFFER_FIELDS,
    custom: brief.hardRequirements.map((requirement) => requirement.field),
    costItemPattern: COST_ITEM_FIELD_PATTERN,
  };
}

export function isAllowedQuoteField(brief: ErrandBrief, field: string): boolean {
  const allowed = allowedQuoteFields(brief);
  return (
    (allowed.standard as readonly string[]).includes(field) ||
    allowed.custom.includes(field) ||
    allowed.costItemPattern.test(field)
  );
}

export type QuoteFieldValue = string | number | boolean | Money | DateRange | CostItemFieldValue;

export interface ApplyQuoteFieldInput {
  readonly field: string;
  readonly value: QuoteFieldValue;
  readonly quote: string;
  readonly confirmed: boolean;
}

export type ApplyQuoteFieldResult =
  | { readonly ok: true; readonly offer: Offer }
  | { readonly ok: false; readonly reason: "field_not_allowed" | "invalid_value" };

function evidenceFor(callId: string, quote: string, now: string): Evidence {
  return { source: "call", reference: callId, quote, capturedAt: toCanonicalInstant(now) };
}

function fieldFor<T>(value: T, confirmed: boolean, evidence: Evidence) {
  return confirmed ? known(value, evidence) : estimated(value, evidence);
}

/** "registration-fee" → "registration fee"; falls back to the raw id if that leaves nothing. */
function labelFromCostItemId(id: string): string {
  const label = id.replace(/[-_]+/g, " ").trim();
  return label.length > 0 ? label : id;
}

function invalidValue(): ApplyQuoteFieldResult {
  return { ok: false, reason: "invalid_value" };
}

function moneyInCurrency(value: unknown, currency: string): Money | null {
  const parsed = moneySchema.safeParse(value);
  if (!parsed.success || parsed.data.currency !== currency) return null;
  return parsed.data;
}

type CostItemAppliesTo = CostItem["appliesTo"];

function isParticipantSubset(
  appliesTo: CostItemAppliesTo,
): appliesTo is { participantIds: string[] } {
  return typeof appliesTo === "object";
}

/** False if a `{ participantIds }` appliesTo names someone outside the brief. */
function appliesToIsValid(appliesTo: CostItemAppliesTo, brief: ErrandBrief): boolean {
  if (!isParticipantSubset(appliesTo)) return true;
  const knownParticipantIds = new Set(brief.participants.map((participant) => participant.id));
  return appliesTo.participantIds.every((id) => knownParticipantIds.has(id));
}

function applyCostItemField(
  offer: Offer,
  costItemId: string,
  input: ApplyQuoteFieldInput,
  brief: ErrandBrief,
  evidence: Evidence,
): ApplyQuoteFieldResult {
  const parsed = costItemFieldValueSchema.safeParse(input.value);
  if (!parsed.success || parsed.data.currency !== brief.spendLimits.currency) {
    return invalidValue();
  }
  const { amountCents, currency, appliesTo, kind } = parsed.data;
  if (appliesTo !== undefined && !appliesToIsValid(appliesTo, brief)) {
    return invalidValue();
  }

  const amount = fieldFor({ amountCents, currency }, input.confirmed, evidence);
  const existingIndex = offer.costItems.findIndex((item) => item.id === costItemId);

  let costItems: CostItem[];
  if (existingIndex === -1) {
    // No default: a caller must state how a brand-new line item applies and whether it is a
    // charge or a discount, so it can never silently become a shared group charge.
    if (appliesTo === undefined || kind === undefined) return invalidValue();
    costItems = [
      ...offer.costItems,
      { id: costItemId, label: labelFromCostItemId(costItemId), appliesTo, kind, amount },
    ];
  } else {
    const existing = offer.costItems[existingIndex];
    if (existing === undefined) return invalidValue();
    const updated: CostItem = {
      ...existing,
      amount,
      ...(appliesTo !== undefined ? { appliesTo } : {}),
      ...(kind !== undefined ? { kind } : {}),
    };
    costItems = offer.costItems.map((item, index) => (index === existingIndex ? updated : item));
  }

  return { ok: true, offer: { ...offer, costItems } };
}

function applyStandardField(
  offer: Offer,
  field: StandardOfferField,
  input: ApplyQuoteFieldInput,
  brief: ErrandBrief,
  evidence: Evidence,
): ApplyQuoteFieldResult {
  switch (field) {
    case "seatsAvailable": {
      if (typeof input.value !== "number" || !Number.isInteger(input.value) || input.value < 0) {
        return invalidValue();
      }
      return {
        ok: true,
        offer: { ...offer, seatsAvailable: fieldFor(input.value, input.confirmed, evidence) },
      };
    }
    case "dates": {
      const range = dateRangeSchema.safeParse(input.value);
      if (!range.success) return invalidValue();
      return {
        ok: true,
        offer: { ...offer, dates: fieldFor(range.data, input.confirmed, evidence) },
      };
    }
    case "location": {
      if (typeof input.value !== "string") return invalidValue();
      const trimmedLocation = input.value.trim();
      if (trimmedLocation.length === 0) return invalidValue();
      return {
        ok: true,
        offer: { ...offer, location: fieldFor(trimmedLocation, input.confirmed, evidence) },
      };
    }
    case "deposit": {
      const money = moneyInCurrency(input.value, brief.spendLimits.currency);
      if (money === null) return invalidValue();
      return { ok: true, offer: { ...offer, deposit: fieldFor(money, input.confirmed, evidence) } };
    }
    case "cancellationPenalty": {
      const money = moneyInCurrency(input.value, brief.spendLimits.currency);
      if (money === null) return invalidValue();
      return {
        ok: true,
        offer: { ...offer, cancellationPenalty: fieldFor(money, input.confirmed, evidence) },
      };
    }
  }
}

/**
 * A custom field's string value must be non-empty after trimming (the trimmed value is what
 * gets stored); a numeric value must be finite, since Infinity/NaN pass `typeof === "number"`
 * but are never a real spoken quantity.
 */
function normalizedCustomFieldValue(
  value: string | number | boolean,
): string | number | boolean | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return value;
}

function applyCustomField(
  offer: Offer,
  field: string,
  input: ApplyQuoteFieldInput,
  evidence: Evidence,
): ApplyQuoteFieldResult {
  if (
    typeof input.value !== "string" &&
    typeof input.value !== "number" &&
    typeof input.value !== "boolean"
  ) {
    return invalidValue();
  }
  const normalized = normalizedCustomFieldValue(input.value);
  if (normalized === null) return invalidValue();
  return {
    ok: true,
    offer: {
      ...offer,
      customFields: {
        ...offer.customFields,
        [field]: fieldFor(normalized, input.confirmed, evidence),
      },
    },
  };
}

/**
 * Applies one voice-reported quote field to an offer draft. Rejects a field name outside
 * `allowedQuoteFields(brief)`, or a value whose shape does not fit that field (money must be
 * an integer-cents amount in the brief currency; dates must form a valid range). Stores a
 * `known` field with call evidence when `confirmed`, otherwise `estimated`.
 */
export function applyQuoteField(
  offer: Offer,
  brief: ErrandBrief,
  input: ApplyQuoteFieldInput,
  now: string,
  callId: string,
): ApplyQuoteFieldResult {
  if (!isAllowedQuoteField(brief, input.field)) {
    return { ok: false, reason: "field_not_allowed" };
  }

  const evidence = evidenceFor(callId, input.quote, now);

  const costItemId = COST_ITEM_FIELD_PATTERN.exec(input.field)?.[1];
  if (costItemId !== undefined) {
    return applyCostItemField(offer, costItemId, input, brief, evidence);
  }

  if ((STANDARD_OFFER_FIELDS as readonly string[]).includes(input.field)) {
    return applyStandardField(offer, input.field as StandardOfferField, input, brief, evidence);
  }

  return applyCustomField(offer, input.field, input, evidence);
}
