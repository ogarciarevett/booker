import type { ChoiceQuestion, ConfidenceThresholds, Decision, DecisionPort } from "./decision.ts";
import { classifyConfidence } from "./decision.ts";

/**
 * Why `chooseWithin` returned the option it did. `"decided"` means the
 * offered `decisions` port named one of the question's own `criteria` keys
 * at or above the "act" confidence tier; every other reason falls back to
 * `defaultOption` without acting on an untrusted or unusable answer.
 */
export type ChooseWithinReason =
  | "decided"
  | "no_decision_service"
  | "low_confidence_default"
  | "invalid_choice_default"
  | "decision_failed_default";

export interface ChooseWithinInput<Option extends string> {
  /** `undefined` when no decision service is configured; no question is asked. */
  readonly decisions: DecisionPort | undefined;
  readonly state: string;
  readonly question: ChoiceQuestion<Option>;
  readonly defaultOption: Option;
  readonly thresholds?: ConfidenceThresholds | undefined;
  /** Secrets (such as an API key) replaced with `[redacted]` in any reported error, before it is trimmed. */
  readonly redact?: readonly string[] | undefined;
}

export interface ChooseWithinResult<Option extends string> {
  readonly option: Option;
  readonly reason: ChooseWithinReason;
  /** Present only when a decision was actually reached (`"decided"`, `"low_confidence_default"`, or `"invalid_choice_default"`). */
  readonly decision?: Decision<Option>;
  /** Present only for `"decision_failed_default"`: the thrown error's message, never a secret such as an API key. */
  readonly error?: string;
}

const MAX_ERROR_LENGTH = 300;

/**
 * Error text can carry content from a remote endpoint, so it is never
 * reported as-is. Order matters: secrets are redacted on the raw text first,
 * so neither sanitizing nor truncation can leave part of a secret behind;
 * then control characters are removed, whitespace collapses to one line, and
 * the result is capped by code points so no character is split.
 */
function errorMessage(error: unknown, redact: readonly string[]): string {
  let raw = error instanceof Error ? error.message : String(error);
  for (const secret of redact) {
    if (secret.length > 0) raw = raw.replaceAll(secret, "[redacted]");
  }
  const printable = Array.from(raw, (character) => {
    if (character === "\n" || character === "\r" || character === "\t") return " ";
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "" : character;
  }).join("");
  const characters = Array.from(printable.replace(/\s+/g, " ").trim());
  return characters.length <= MAX_ERROR_LENGTH
    ? characters.join("")
    : `${characters.slice(0, MAX_ERROR_LENGTH - 1).join("")}…`;
}

/**
 * Shared bounded-choice logic behind `selectModel` (`src/reasoning/model-matrix.ts`)
 * and `routeTask` (`scripts/agent-matrix.ts`): asks `decisions` a single
 * `ChoiceQuestion` and trusts the answer only when it names one of the
 * question's own `criteria` keys at or above the "act" confidence tier.
 * Every other outcome — no decision service configured, the port throwing,
 * an out-of-range confidence, a below-"act" confidence, or a choice outside
 * `criteria` — returns `defaultOption` with a reason distinguishing why, per
 * `AGENTS.md`'s "a model or Jev result alone never authorizes" rule.
 */
export async function chooseWithin<Option extends string>({
  decisions,
  state,
  question,
  defaultOption,
  thresholds,
  redact = [],
}: ChooseWithinInput<Option>): Promise<ChooseWithinResult<Option>> {
  if (decisions === undefined) {
    return { option: defaultOption, reason: "no_decision_service" };
  }

  let decision: Decision<Option>;
  try {
    decision = await decisions.choose({ state, question });
  } catch (error) {
    return {
      option: defaultOption,
      reason: "decision_failed_default",
      error: errorMessage(error, redact),
    };
  }

  let tier: ReturnType<typeof classifyConfidence>;
  try {
    tier = classifyConfidence(decision.confidence, thresholds);
  } catch (error) {
    // A confidence outside [0, 1] means the decision itself is unusable.
    return {
      option: defaultOption,
      reason: "decision_failed_default",
      error: errorMessage(error, redact),
    };
  }

  // An unoffered choice is the more specific fault, so it is reported before low confidence.
  if (!Object.hasOwn(question.criteria, decision.choice)) {
    return { option: defaultOption, reason: "invalid_choice_default", decision };
  }
  if (tier !== "act") {
    return { option: defaultOption, reason: "low_confidence_default", decision };
  }

  return { option: decision.choice, reason: "decided", decision };
}
