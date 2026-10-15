import { z } from "zod";
import { type DateRange, dateRangeSchema } from "../shared/dates.ts";
import { moneySchema } from "../shared/money.ts";
import type { CallPurpose } from "./call.ts";

/**
 * The four voice tools ElevenLabs Agents and Pipecat both call. `get_errand_context` and
 * `record_quote_field` are visible on every call; `request_commit_permission` and
 * `report_commit_outcome` are only visible on a commit call (see `toolsFor`).
 */
export type VoiceToolName =
  | "get_errand_context"
  | "record_quote_field"
  | "request_commit_permission"
  | "report_commit_outcome";

const QUOTE_TOOLS: readonly VoiceToolName[] = ["get_errand_context", "record_quote_field"];
const COMMIT_ONLY_TOOLS: readonly VoiceToolName[] = [
  "request_commit_permission",
  "report_commit_outcome",
];

/** Tools visible for a call of the given purpose, in a fixed order. */
export function toolsFor(purpose: CallPurpose): readonly VoiceToolName[] {
  return purpose === "commit" ? [...QUOTE_TOOLS, ...COMMIT_ONLY_TOOLS] : QUOTE_TOOLS;
}

export function isToolAllowed(purpose: CallPurpose, tool: VoiceToolName): boolean {
  return toolsFor(purpose).includes(tool);
}

const callTokenSchema = z.object({ call_token: z.string().min(1) });

/**
 * Mirrors offers/offer.ts's `costItemAppliesToSchema` (not exported there, so re-declared
 * here rather than coupling the tool contract to offer internals): a charge or discount
 * applies to every participant, to a named subset, or is shared by the group.
 */
const costItemAppliesToValueSchema = z.union([
  z.literal("each-participant"),
  z.literal("group"),
  z.object({ participantIds: z.array(z.string().min(1)).min(1) }),
]);

/**
 * The value record_quote_field must send for a `costItem:<id>` field (see
 * quote-fields.ts): a Money amount plus how it applies and whether it is a charge or a
 * discount. `appliesTo`/`kind` are optional so a call can correct just the amount of a cost
 * item that already exists; creating a brand-new one requires both — there is no default,
 * since defaulting a per-participant charge to a shared group charge would misprice a
 * multi-participant errand (see quote-fields.ts's `applyQuoteField`).
 */
export const costItemFieldValueSchema = moneySchema
  .extend({
    appliesTo: costItemAppliesToValueSchema.optional(),
    kind: z.enum(["charge", "discount"]).optional(),
  })
  .strict();

export type CostItemFieldValue = z.infer<typeof costItemFieldValueSchema>;

// A plain Money object (no appliesTo/kind at all) must still be usable for deposit and
// cancellationPenalty. It is kept strict here too: without `.strict()`, this branch would
// silently accept and strip an invalid `appliesTo`/`kind` that failed the cost-item schema
// above, and a union succeeds if *any* branch matches — so an object union member must
// never be looser than the more specific schema it sits beside.
const strictMoneySchema = moneySchema.strict();

/**
 * The value shapes a quote field may hold: a primitive (string/number/boolean, matching
 * offer custom fields), a cost-item update, a plain Money amount (deposit,
 * cancellationPenalty), or a DateRange (the offer's dates).
 */
const quoteFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  costItemFieldValueSchema,
  strictMoneySchema,
  dateRangeSchema,
]);

export const getErrandContextRequestSchema = callTokenSchema;

export const recordQuoteFieldRequestSchema = callTokenSchema.extend({
  field: z.string().min(1),
  value: quoteFieldValueSchema,
  quote: z.string().min(1).max(500),
  confirmed: z.boolean(),
});

export const requestCommitPermissionRequestSchema = callTokenSchema.extend({
  total: moneySchema,
  deposit: moneySchema,
  dates: dateRangeSchema,
});

export const reportCommitOutcomeRequestSchema = callTokenSchema.extend({
  outcome: z.enum(["accepted", "rejected", "unclear"]),
  quote: z.string().min(1).max(500),
});

export type GetErrandContextRequest = z.infer<typeof getErrandContextRequestSchema>;
export type RecordQuoteFieldRequest = z.infer<typeof recordQuoteFieldRequestSchema>;
export type RequestCommitPermissionRequest = z.infer<typeof requestCommitPermissionRequestSchema>;
export type ReportCommitOutcomeRequest = z.infer<typeof reportCommitOutcomeRequestSchema>;

/**
 * The shape of `get_errand_context`'s response: only what a provider may hear. Owned here
 * (the tool contract) rather than in errand-view.ts, which builds values of this shape from
 * a brief and never leaks spendLimits, standing rules, unshared attributes, other
 * providers, or phone numbers.
 */
export interface ShareableErrandView {
  readonly objective: string;
  readonly providerName: string;
  readonly dates: { readonly window: DateRange; readonly flexibilityDays: number };
  readonly questions: readonly { readonly id: string; readonly text: string }[];
  readonly participants: readonly {
    readonly id: string;
    readonly attributes: Readonly<Record<string, string | number | boolean>>;
  }[];
}

export type GetErrandContextResponse = ShareableErrandView;

export interface RecordQuoteFieldResponse {
  readonly stored: true;
  readonly status: "known" | "estimated";
  /** Present when the change revoked a commit grant: the agent must ask for permission again. */
  readonly grantRevoked?: true;
  readonly instruction?: string;
}

export interface RequestCommitPermissionResponse {
  readonly granted: boolean;
  readonly instruction: string;
}

export interface ReportCommitOutcomeResponse {
  readonly recorded: true;
}
