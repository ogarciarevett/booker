import type { ErrandBrief } from "../errands/brief.ts";
import type { Field } from "../offers/field.ts";
import type { Offer } from "../offers/offer.ts";

export interface RecordedField {
  readonly field: string;
  readonly status: "known" | "estimated";
  readonly value: unknown;
  /** The provider's words the value was recorded from, verbatim, and when. */
  readonly quote: string;
  readonly capturedAt: string;
}

/** What a call recorded so far, for the owner: each recorded value and what is still unknown. */
export interface OfferSummary {
  readonly recorded: readonly RecordedField[];
  readonly unknown: readonly string[];
}

const STANDARD_FIELDS = [
  "seatsAvailable",
  "dates",
  "location",
  "deposit",
  "cancellationPenalty",
] as const;

/**
 * Summarizes a provider's offer draft for the owner: every `known` or `estimated` field with its
 * value (cost items as `costItem:<id>`) and the quote it was recorded from, and the standard
 * fields and brief requirements still unknown.
 */
export function summarizeOffer(
  offer: Offer | undefined,
  brief: ErrandBrief | undefined,
): OfferSummary {
  const recorded: RecordedField[] = [];
  const unknown: string[] = [];
  const add = (field: string, value: Field<unknown> | undefined, shown = (v: unknown) => v) => {
    if (value === undefined || value.status === "unknown") unknown.push(field);
    else {
      recorded.push({
        field,
        status: value.status,
        value: shown(value.value),
        quote: value.evidence.quote,
        capturedAt: value.evidence.capturedAt,
      });
    }
  };

  for (const field of STANDARD_FIELDS) add(field, offer?.[field]);
  for (const item of offer?.costItems ?? []) {
    add(`costItem:${item.id}`, item.amount, (amount) => ({
      ...(amount as object),
      appliesTo: item.appliesTo,
      kind: item.kind,
    }));
  }
  const customFields = new Set([
    ...Object.keys(offer?.customFields ?? {}),
    ...(brief?.hardRequirements.map((requirement) => requirement.field) ?? []),
  ]);
  for (const field of customFields) add(field, offer?.customFields[field]);
  return { recorded, unknown };
}
