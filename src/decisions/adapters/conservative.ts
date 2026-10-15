import type { ChoiceQuestion, ChooseInput, Decision, DecisionPort } from "../decision.ts";

/** Picks the safe default option for a question. Never inspects Jev or the network. */
export type SafeDefault = (question: ChoiceQuestion<string>) => string;

/**
 * `DecisionPort` fallback that never calls out: it always returns the caller's
 * safe default with zero confidence and no probability distribution, since it
 * never actually weighed the offered options. `safeDefault` is typed over a
 * plain `string` option rather than the per-call generic `Option`, because a
 * single instance answers questions with different option sets over its
 * lifetime; `choose` widens the question and narrows the result back — both
 * are safe since every `ChoiceQuestion<Option>` value is already a valid
 * `ChoiceQuestion<string>` value at runtime, and the caller's function is
 * expected to always return one of the question's own criteria keys.
 */
export class ConservativeDecisionAdapter implements DecisionPort {
  private readonly safeDefault: SafeDefault;

  constructor(safeDefault: SafeDefault) {
    this.safeDefault = safeDefault;
  }

  async choose<Option extends string>(input: ChooseInput<Option>): Promise<Decision<Option>> {
    const picked = this.safeDefault(input.question as unknown as ChoiceQuestion<string>);
    // The last line of defense must still answer inside the offered options.
    if (!Object.hasOwn(input.question.criteria, picked)) {
      throw new RangeError(
        `safe default "${picked}" is not one of the options offered for "${input.question.key}"`,
      );
    }
    const choice = picked as Option;
    return {
      choice,
      confidence: 0,
      probabilities: {},
      modelVersion: null,
      source: "fallback",
    };
  }
}
