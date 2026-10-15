import type { ErrandBrief } from "../errands/brief.ts";
import { type Call, isCallOpen } from "./call.ts";

/** How many calls may be open at once, unless the caller sets another cap. */
export const DEFAULT_MAX_CONCURRENT = 3;
/** How many calls one provider gets, unless the caller sets another cap. */
export const DEFAULT_MAX_ATTEMPTS_PER_PROVIDER = 2;

/** Caps must be positive integers: NaN or a fraction would let the round fail open. */
function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer, got ${value}`);
  }
  return value;
}

export interface PlanCallRoundInput {
  readonly brief: ErrandBrief;
  readonly calls: readonly Call[];
  readonly maxConcurrent?: number;
  readonly maxAttemptsPerProvider?: number;
}

/**
 * Picks which providers to call next, in the brief's provider order. Skips a provider that
 * has an open call (already scheduled or in progress) or that already reached
 * `maxAttemptsPerProvider` attempts, and never returns more providers than the remaining
 * budget under `maxConcurrent` total open calls (existing open calls count against it too).
 */
export function planCallRound(input: PlanCallRoundInput): readonly string[] {
  const maxConcurrent = positiveInteger(
    input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    "maxConcurrent",
  );
  const maxAttemptsPerProvider = positiveInteger(
    input.maxAttemptsPerProvider ?? DEFAULT_MAX_ATTEMPTS_PER_PROVIDER,
    "maxAttemptsPerProvider",
  );

  let remainingSlots = Math.max(0, maxConcurrent - input.calls.filter(isCallOpen).length);
  if (remainingSlots === 0) return [];

  const callsByProvider = new Map<string, Call[]>();
  for (const call of input.calls) {
    const providerCalls = callsByProvider.get(call.providerId);
    if (providerCalls) providerCalls.push(call);
    else callsByProvider.set(call.providerId, [call]);
  }

  const picked: string[] = [];
  for (const provider of input.brief.providers) {
    if (remainingSlots === 0) break;
    const providerCalls = callsByProvider.get(provider.id) ?? [];
    if (providerCalls.some(isCallOpen)) continue;
    if (providerCalls.length >= maxAttemptsPerProvider) continue;
    picked.push(provider.id);
    remainingSlots -= 1;
  }
  return picked;
}
