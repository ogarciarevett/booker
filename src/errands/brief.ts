import { z } from "zod";
import { dateRangeSchema, isValidTimeZone } from "../shared/dates.ts";
import { moneySchema } from "../shared/money.ts";

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/** Values a hard requirement or a participant attribute may hold. */
const attributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const hardRequirementRuleSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("equals"), value: attributeValueSchema }),
  z.object({ op: z.literal("oneOf"), values: z.array(attributeValueSchema).min(1) }),
  z.object({ op: z.literal("atLeast"), value: z.number() }),
  z.object({ op: z.literal("atMost"), value: z.number() }),
]);

const hardRequirementSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  field: z.string().min(1),
  rule: hardRequirementRuleSchema,
});

const participantSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  attributes: z.record(z.string(), attributeValueSchema),
});

const locationSchema = z.object({
  area: z.string().min(1),
  acceptableAlternatives: z.array(z.string().min(1)),
});

const errandDatesSchema = z.object({
  window: dateRangeSchema,
  flexibilityDays: z.number().int().min(0),
});

const preferenceSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
});

/** Every Money field here must use `currency`; enforced below, not by moneySchema alone. */
const spendLimitsSchema = z
  .object({
    currency: z
      .string()
      .regex(CURRENCY_PATTERN, { error: "currency must be a 3-letter uppercase ISO 4217 code" }),
    perParticipantMax: moneySchema.optional(),
    totalMax: moneySchema.optional(),
    depositMax: moneySchema.optional(),
    cancellationPenaltyMax: moneySchema.optional(),
  })
  .check((ctx) => {
    const { currency, perParticipantMax, totalMax, depositMax, cancellationPenaltyMax } = ctx.value;
    const limits = [
      ["perParticipantMax", perParticipantMax],
      ["totalMax", totalMax],
      ["depositMax", depositMax],
      ["cancellationPenaltyMax", cancellationPenaltyMax],
    ] as const;
    for (const [field, limit] of limits) {
      if (limit !== undefined && limit.currency !== currency) {
        ctx.issues.push({
          code: "custom",
          message: `spendLimits.${field} currency must match spendLimits.currency ("${currency}")`,
          input: ctx.value,
          path: [field],
        });
      }
    }
  });

const errandActionSchema = z.enum(["quote", "hold", "book", "pay"]);

const groupPolicySchema = z.object({
  sameProvider: z.boolean(),
  allowPartialBooking: z.boolean(),
});

const completionSchema = z.object({
  description: z.string().min(1),
  requiresWrittenConfirmation: z.boolean(),
});

const questionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  phoneE164: z.string().regex(E164_PATTERN, { error: "phoneE164 must be an E.164 phone number" }),
});

const baseErrandBriefSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  objective: z.string().min(1),
  timeZone: z
    .string()
    .min(1)
    .refine(isValidTimeZone, { error: "timeZone must be a valid IANA time zone" }),
  participants: z.array(participantSchema).min(1),
  location: locationSchema,
  dates: errandDatesSchema,
  hardRequirements: z.array(hardRequirementSchema),
  preferences: z.array(preferenceSchema),
  spendLimits: spendLimitsSchema,
  authorizedActions: z.array(errandActionSchema),
  groupPolicy: groupPolicySchema,
  completion: completionSchema,
  questions: z.array(questionSchema),
  providers: z.array(providerSchema),
  shareableAttributes: z.array(z.string().min(1)),
});

function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

/**
 * ErrandBrief schema: shape validation plus cross-field checks (unique ids,
 * spendLimits currency consistency, shareableAttributes must reference a real
 * participant attribute). timeZone and provider phone numbers are validated
 * per-field above.
 */
export const errandBriefSchema = baseErrandBriefSchema.check((ctx) => {
  const brief = ctx.value;

  const idGroups = [
    ["participants", brief.participants.map((participant) => participant.id)],
    ["providers", brief.providers.map((provider) => provider.id)],
    ["hardRequirements", brief.hardRequirements.map((requirement) => requirement.id)],
    ["questions", brief.questions.map((question) => question.id)],
  ] as const;
  for (const [field, ids] of idGroups) {
    for (const duplicate of findDuplicates(ids)) {
      ctx.issues.push({
        code: "custom",
        message: `${field} ids must be unique; duplicate "${duplicate}"`,
        input: brief,
        path: [field],
      });
    }
  }

  const knownAttributeKeys = new Set(
    brief.participants.flatMap((participant) => Object.keys(participant.attributes)),
  );
  brief.shareableAttributes.forEach((key, index) => {
    if (!knownAttributeKeys.has(key)) {
      ctx.issues.push({
        code: "custom",
        message: `shareableAttributes references an attribute no participant has: "${key}"`,
        input: brief,
        path: ["shareableAttributes", index],
      });
    }
  });
});

export type ErrandBrief = z.infer<typeof errandBriefSchema>;

export type ParseErrandBriefResult =
  | { ok: true; brief: ErrandBrief }
  | { ok: false; issues: string[] };

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

export function parseErrandBrief(input: unknown): ParseErrandBriefResult {
  const result = errandBriefSchema.safeParse(input);
  if (result.success) {
    return { ok: true, brief: result.data };
  }
  return { ok: false, issues: result.error.issues.map(formatIssue) };
}
