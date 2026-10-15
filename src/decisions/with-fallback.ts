import type { ChooseInput, Decision, DecisionPort } from "./decision.ts";

/** Called with whatever `primary` threw, so the caller can log it. Never awaited. */
export type OnDecisionError = (error: unknown) => void;

/**
 * A `DecisionPort` that tries `primary` first. If `primary` throws for any
 * reason (a `JevError`, a network failure, anything), `onError` is notified
 * and `fallback`'s decision is returned instead. If `fallback` also throws,
 * that error propagates to the caller.
 */
export function withFallback(
  primary: DecisionPort,
  fallback: DecisionPort,
  onError?: OnDecisionError,
): DecisionPort {
  return {
    async choose<Option extends string>(input: ChooseInput<Option>): Promise<Decision<Option>> {
      try {
        return await primary.choose(input);
      } catch (error) {
        try {
          onError?.(error);
        } catch {
          // A failing logger must never cost the caller its safe default.
        }
        return fallback.choose(input);
      }
    },
  };
}
