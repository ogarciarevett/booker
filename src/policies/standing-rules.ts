import { z } from "zod";
import { dateRangeSchema } from "../shared/dates.ts";
import { moneySchema } from "../shared/money.ts";

const baseStandingRulesSchema = z.object({
  allowedWindows: z.array(dateRangeSchema).optional(),
  maxTotal: moneySchema.optional(),
  maxDeposit: moneySchema.optional(),
  maxCancellationPenalty: moneySchema.optional(),
  autoBookWithinRules: z.boolean(),
});

/**
 * StandingRules: pre-authorized limits an errand's owner sets ahead of time.
 * Every Money amount in one rule set must share a currency (checked below);
 * `allowedWindows` dates carry no currency and need no such check.
 */
export const standingRulesSchema = baseStandingRulesSchema.check((ctx) => {
  const { maxTotal, maxDeposit, maxCancellationPenalty } = ctx.value;
  const amounts = [
    ["maxTotal", maxTotal],
    ["maxDeposit", maxDeposit],
    ["maxCancellationPenalty", maxCancellationPenalty],
  ] as const;
  const currency = amounts.find(([, amount]) => amount !== undefined)?.[1]?.currency;
  if (currency === undefined) return;
  for (const [field, amount] of amounts) {
    if (amount !== undefined && amount.currency !== currency) {
      ctx.issues.push({
        code: "custom",
        message: `${field} currency must match the other rule amounts ("${currency}")`,
        input: ctx.value,
        path: [field],
      });
    }
  }
});

export type StandingRules = z.infer<typeof standingRulesSchema>;

export type ParseStandingRulesResult =
  | { ok: true; rules: StandingRules }
  | { ok: false; issues: string[] };

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

export function parseStandingRules(input: unknown): ParseStandingRulesResult {
  const result = standingRulesSchema.safeParse(input);
  if (result.success) {
    return { ok: true, rules: result.data };
  }
  return { ok: false, issues: result.error.issues.map(formatIssue) };
}
