import { z } from "zod";

// The errand answers of Booker's control API (docs/observability.md#read-only-data-api), checked
// where they enter the dashboard. A stage or provider status this dashboard does not know (from
// a newer Booker, say) becomes "unknown" and is shown as such; an answer without the parts the
// pages need is refused.

export const ERRAND_STAGES = [
  "preparing",
  "calling",
  "waiting_for_you",
  "booked",
  "closed",
] as const;

export const PROVIDER_STATUSES = [
  "not_called",
  "calling",
  "quoted",
  "declined_by_provider",
  "ruled_out_by_rules",
  "no_answer",
  "no_quote",
  "failed",
] as const;

/** One of `values`, or `"unknown"` for anything else. */
function oneOf<const T extends string>(values: readonly T[]) {
  const known = new Set<string>(values);
  return z
    .unknown()
    .transform((value): T | "unknown" =>
      typeof value === "string" && known.has(value) ? (value as T) : "unknown",
    );
}

const count = z.number().int().nonnegative().catch(0);
const moneySchema = z.object({ amountCents: z.number().int(), currency: z.string() });
const evaluationSchema = z.enum(["eligible", "incomplete", "ineligible"]);

const countsSchema = z.object({
  notCalled: count,
  calling: count,
  quoted: count,
  declined: count,
  ruledOut: count,
  noAnswer: count,
  noQuote: count,
  failed: count,
  pending: count,
});

export const errandSummarySchema = z.object({
  errandId: z.string().min(1),
  kind: z.string(),
  objective: z.string(),
  createdAt: z.string().optional(),
  stage: oneOf(ERRAND_STAGES),
  counts: countsSchema,
  progress: z.object({ done: count, total: count }),
  providerCount: count,
  leadingProviderId: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
});

const providerSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  /** All but the last four digits hidden. */
  phone: z.string(),
  status: oneOf(PROVIDER_STATUSES),
  reasons: z.array(z.string()),
  /** The provider's own words behind a decline. */
  quote: z.string().optional(),
  attempts: count,
  maxAttempts: count,
  canRetry: z.boolean(),
  lastCallId: z.string().nullable(),
  offer: z
    .object({
      evaluation: evaluationSchema,
      total: moneySchema,
      perPerson: moneySchema.nullable(),
      estimated: z.boolean(),
      unknowns: z.array(z.string()),
      failures: z.array(z.string()),
    })
    .nullable(),
});

const commitSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({
    state: z.literal("grant_active"),
    /** `null` when Booker could not tell which provider the grant is for. */
    providerId: z.string().nullable(),
    grantExpiresAt: z.string(),
  }),
  z.object({ state: z.literal("booked"), providerId: z.string(), bookingStatus: z.string() }),
  z.object({ state: z.literal("enrolled"), providerId: z.string() }),
]);

export const errandDetailSchema = errandSummarySchema.extend({
  providers: z.array(providerSchema),
  ranking: z.array(
    z.object({
      providerId: z.string(),
      name: z.string(),
      evaluation: evaluationSchema,
      total: moneySchema,
      estimated: z.boolean(),
      unknownCount: count,
    }),
  ),
  missing: z.object({
    providersToCall: z.array(z.object({ providerId: z.string(), name: z.string() })),
    leadingProviderId: z.string().nullable(),
    unknownFields: z.array(z.string()),
    writtenConfirmation: z.enum(["not_required", "pending", "received"]),
    commit: commitSchema,
  }),
});

export type ErrandStage = z.infer<typeof errandSummarySchema>["stage"];
export type ErrandSummary = z.infer<typeof errandSummarySchema>;
export type ErrandCounts = ErrandSummary["counts"];
export type ErrandDetail = z.infer<typeof errandDetailSchema>;
export type ErrandProvider = ErrandDetail["providers"][number];
export type ProviderStatus = ErrandProvider["status"];
export type RankedQuote = ErrandDetail["ranking"][number];
export type CommitState = ErrandDetail["missing"]["commit"];

/** `GET /control/errands`'s errands, or `undefined` when the answer is not usable. */
export function parseErrandList(json: unknown): ErrandSummary[] | undefined {
  const parsed = z.object({ errands: z.array(errandSummarySchema) }).safeParse(json);
  return parsed.success ? parsed.data.errands : undefined;
}

/** `GET /control/errands/:id`'s errand, or `undefined` when the answer is not usable. */
export function parseErrandDetail(json: unknown): ErrandDetail | undefined {
  const parsed = errandDetailSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}
