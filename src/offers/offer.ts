import { z } from "zod";
import { dateRangeSchema } from "../shared/dates.ts";
import { moneySchema } from "../shared/money.ts";
import { fieldSchema } from "./field.ts";

const customFieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** A cost item applies to every participant, to a named subset, or is shared by the group. */
const costItemAppliesToSchema = z.union([
  z.literal("each-participant"),
  z.literal("group"),
  z.object({ participantIds: z.array(z.string().min(1)).min(1) }),
]);

const costItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  appliesTo: costItemAppliesToSchema,
  kind: z.enum(["charge", "discount"]),
  amount: fieldSchema(moneySchema),
});

const extraSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  unitPrice: fieldSchema(moneySchema),
});

const baseOfferSchema = z.object({
  id: z.string().min(1),
  errandId: z.string().min(1),
  providerId: z.string().min(1),
  queriedAt: z.iso.datetime(),
  seatsAvailable: fieldSchema(z.number().int().min(0)),
  dates: fieldSchema(dateRangeSchema),
  location: fieldSchema(z.string().min(1)),
  costItems: z.array(costItemSchema),
  deposit: fieldSchema(moneySchema),
  cancellationPenalty: fieldSchema(moneySchema),
  extras: z.array(extraSchema),
  customFields: z.record(z.string(), fieldSchema(customFieldValueSchema)),
});

function findDuplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

/** OfferSchema: shape validation plus cost item and extra id uniqueness. */
export const offerSchema = baseOfferSchema.check((ctx) => {
  const offer = ctx.value;

  for (const duplicate of findDuplicateIds(offer.costItems.map((item) => item.id))) {
    ctx.issues.push({
      code: "custom",
      message: `costItems ids must be unique; duplicate "${duplicate}"`,
      input: offer,
      path: ["costItems"],
    });
  }

  for (const duplicate of findDuplicateIds(offer.extras.map((extra) => extra.id))) {
    ctx.issues.push({
      code: "custom",
      message: `extras ids must be unique; duplicate "${duplicate}"`,
      input: offer,
      path: ["extras"],
    });
  }
});

export type CostItem = z.infer<typeof costItemSchema>;
export type Extra = z.infer<typeof extraSchema>;
export type Offer = z.infer<typeof offerSchema>;

export type ParseOfferResult = { ok: true; offer: Offer } | { ok: false; issues: string[] };

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

export function parseOffer(input: unknown): ParseOfferResult {
  const result = offerSchema.safeParse(input);
  if (result.success) {
    return { ok: true, offer: result.data };
  }
  return { ok: false, issues: result.error.issues.map(formatIssue) };
}
