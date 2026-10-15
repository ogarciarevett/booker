/**
 * A bounded choice question: the model may only pick one of the offered
 * `criteria` keys. `key` names this question inside a batched Jev request.
 */
export interface ChoiceQuestion<Option extends string> {
  readonly key: string;
  readonly instructions: string;
  readonly criteria: Record<Option, string>;
}

/**
 * One decision reached over a `ChoiceQuestion`. `probabilities` is partial
 * because a fallback decision (see `adapters/conservative.ts`) never computed
 * a distribution over the offered options; typing it as a full `Record`
 * would claim knowledge the fallback never had.
 */
export interface Decision<Option extends string> {
  readonly choice: Option;
  readonly confidence: number;
  readonly probabilities: Partial<Record<Option, number>>;
  readonly modelVersion: string | null;
  readonly source: "jev" | "fallback";
}

export interface ChooseInput<Option extends string> {
  readonly state: string;
  readonly question: ChoiceQuestion<Option>;
}

/** Port for reaching a bounded decision. Code, not the port, has the final say on the outcome. */
export interface DecisionPort {
  choose<Option extends string>(input: ChooseInput<Option>): Promise<Decision<Option>>;
}

export interface ConfidenceThresholds {
  readonly act: number;
  readonly human: number;
}

export type ConfidenceTier = "act" | "collect" | "human";

const DEFAULT_THRESHOLDS: ConfidenceThresholds = { act: 0.9, human: 0.5 };

/**
 * Classifies a confidence score into `"act"` (at or above `act`), `"human"`
 * (below `human`), or `"collect"` (in between, including the `human`
 * boundary itself). Throws a `RangeError` for a confidence outside `[0, 1]`
 * or thresholds where `act` does not exceed `human`.
 */
export function classifyConfidence(
  confidence: number,
  thresholds: ConfidenceThresholds = DEFAULT_THRESHOLDS,
): ConfidenceTier {
  if (!(confidence >= 0 && confidence <= 1)) {
    throw new RangeError(
      `classifyConfidence confidence must be between 0 and 1, got ${confidence}`,
    );
  }
  if (!(thresholds.act > thresholds.human)) {
    throw new RangeError(
      `classifyConfidence thresholds.act (${thresholds.act}) must exceed thresholds.human (${thresholds.human})`,
    );
  }
  if (confidence >= thresholds.act) return "act";
  if (confidence < thresholds.human) return "human";
  return "collect";
}
