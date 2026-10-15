import { chooseWithin } from "../decisions/choose-within.ts";
import type {
  ChoiceQuestion,
  ConfidenceThresholds,
  Decision,
  DecisionPort,
} from "../decisions/decision.ts";

/**
 * One model a runtime role may run under. `id` is `${runtime}:${model}`,
 * which is what a Jev answer and the allowlist re-check both compare
 * against. `subscription` is true only for a flat-rate developer
 * subscription runtime (`codex-cli`, `claude-code`): those seats cannot fan
 * out for a parallel run and are excluded under the kill switch, since
 * neither should be trusted to keep running unattended. `description` is
 * the criterion text Jev sees for this option: strengths, cost, and speed.
 */
export interface ModelCandidate {
  readonly id: string;
  readonly runtime: "elevenlabs" | "elevenlabs-custom" | "codex-cli" | "claude-code" | "api";
  readonly model: string;
  readonly subscription: boolean;
  readonly description: string;
}

/** A Booker runtime context that needs a model decision. */
export type ModelRole =
  | "inCall"
  | "briefParsing"
  | "questionPlanning"
  | "transcriptExtraction"
  | "comparisonNarrative";

/** One role's allowlist: its ordinary default and every candidate it may run under. */
export interface RoleMatrixEntry {
  readonly default: string;
  readonly candidates: readonly ModelCandidate[];
}

export type RuntimeMatrix = Readonly<Record<ModelRole, RoleMatrixEntry>>;

function candidate(
  runtime: ModelCandidate["runtime"],
  model: string,
  description: string,
): ModelCandidate {
  return {
    id: `${runtime}:${model}`,
    runtime,
    model,
    subscription: runtime === "codex-cli" || runtime === "claude-code",
    description,
  };
}

/**
 * Shared by `briefParsing`, `questionPlanning`, and `transcriptExtraction`:
 * the same four candidates: only the role default differs between them.
 */
const developmentCandidates: readonly ModelCandidate[] = [
  candidate(
    "codex-cli",
    "gpt-6.1-sol",
    "Codex CLI developer subscription: strong coding and tool-use reasoning, no per-token cost, moderate speed.",
  ),
  candidate(
    "claude-code",
    "claude-sonnet-5-5",
    "Claude Code developer subscription: strong reasoning and long context, no per-token cost, moderate speed.",
  ),
  candidate(
    "api",
    "openai/gpt-6.1-sol",
    "Pay-per-token OpenAI API: stays available when a subscription seat is excluded (parallel work or the kill switch), moderate speed.",
  ),
  candidate(
    "api",
    "anthropic/claude-sonnet-5-5",
    "Pay-per-token Anthropic API: stays available when a subscription seat is excluded (parallel work or the kill switch), moderate speed.",
  ),
];

/**
 * Runtime roles and their allowlisted model candidates (see the ODD
 * document, `odd/tasks/model-matrix.md`, Design → Runtime roles). `inCall`
 * runs on ElevenLabs during a live call; the other roles are development-time
 * Booker workers. No `inCall` candidate is a subscription seat, so
 * `selectModel` never narrows that role's allowlist.
 */
export const RUNTIME_MATRIX: RuntimeMatrix = {
  inCall: {
    default: "elevenlabs:gpt-6-sol",
    candidates: [
      candidate(
        "elevenlabs",
        "gpt-6-sol",
        "ElevenLabs built-in: fastest first-token latency for a live call, lowest cost, solid quality.",
      ),
      candidate(
        "elevenlabs",
        "gpt-6-astra",
        "ElevenLabs built-in: higher quality than gpt-6-sol, somewhat higher latency and cost.",
      ),
      candidate(
        "elevenlabs",
        "claude-sonnet-5",
        "ElevenLabs built-in: strongest reasoning of the built-ins, higher latency and cost.",
      ),
      candidate(
        "elevenlabs-custom",
        "gpt-6.1-sol",
        "Custom ElevenLabs deployment, not yet a built-in: newest model, in-call latency unproven.",
      ),
    ],
  },
  briefParsing: {
    default: "codex-cli:gpt-6.1-sol",
    candidates: developmentCandidates,
  },
  questionPlanning: {
    default: "codex-cli:gpt-6.1-sol",
    candidates: developmentCandidates,
  },
  transcriptExtraction: {
    default: "api:openai/gpt-6.1-sol",
    candidates: developmentCandidates,
  },
  comparisonNarrative: {
    default: "claude-code:claude-sonnet-5-5",
    candidates: developmentCandidates.filter((c) => c.id !== "api:openai/gpt-6.1-sol"),
  },
};

/** Why `selectModel` returned the candidate it did. */
export type SelectModelReason =
  | "jev"
  | "only_option"
  | "low_confidence_default"
  | "invalid_choice_default"
  | "decision_failed_default"
  | "no_decision_service";

export interface SelectModelInput {
  readonly role: ModelRole;
  readonly state: string;
  /** True while this role is also running as an unattended parallel worker. */
  readonly parallel: boolean;
  /** True while the standing kill switch forces every role onto `api` candidates. */
  readonly killSwitch: boolean;
  readonly decisions: DecisionPort;
  readonly matrix?: RuntimeMatrix;
  readonly thresholds?: ConfidenceThresholds;
}

export interface SelectModelResult {
  readonly candidate: ModelCandidate;
  readonly reason: SelectModelReason;
  /** Present only when a usable decision was reached (`"jev"`, `"low_confidence_default"`, or `"invalid_choice_default"`). */
  readonly decision?: Decision<string>;
}

/**
 * Picks the model candidate for `role`. Subscription candidates are dropped
 * from the allowlist when `parallel` or `killSwitch` is set. A single
 * surviving candidate is returned without asking Jev. Otherwise Jev is asked
 * to choose among the allowlisted ids; per `AGENTS.md` ("a model or Jev
 * result alone never authorizes" the outcome), that answer is trusted only
 * at the `"act"` confidence tier and only when it names an allowlisted id.
 * Any other outcome — a low-confidence or out-of-allowlist answer, or
 * `decisions.choose` throwing — falls back to the role's own default, or to
 * the first allowed candidate when the default itself was excluded.
 *
 * Throws when `parallel` or `killSwitch` excludes every candidate for
 * `role`: a matrix where a role has no non-subscription fallback is
 * misconfigured and must fail loudly rather than silently pick nothing.
 */
export async function selectModel({
  role,
  state,
  parallel,
  killSwitch,
  decisions,
  matrix = RUNTIME_MATRIX,
  thresholds,
}: SelectModelInput): Promise<SelectModelResult> {
  const entry = matrix[role];
  const excludeSubscriptions = parallel || killSwitch;
  const allowed = entry.candidates.filter((c) => !(excludeSubscriptions && c.subscription));
  const [firstAllowed] = allowed;

  if (firstAllowed === undefined) {
    throw new Error(
      `model-matrix: no candidate is allowed for role "${role}" ` +
        `(parallel=${parallel}, killSwitch=${killSwitch}); every candidate needs a subscription runtime`,
    );
  }

  const fallbackDefault = allowed.find((c) => c.id === entry.default) ?? firstAllowed;

  if (allowed.length === 1) {
    return { candidate: firstAllowed, reason: "only_option" };
  }

  const question: ChoiceQuestion<string> = {
    key: `model:${role}`,
    instructions: `Pick the model to use for the "${role}" role from the offered candidates.`,
    criteria: Object.fromEntries(allowed.map((c): [string, string] => [c.id, c.description])),
  };

  const result = await chooseWithin({
    decisions,
    state,
    question,
    defaultOption: fallbackDefault.id,
    thresholds,
  });

  if (result.reason === "decided") {
    const chosen = allowed.find((c) => c.id === result.option);
    if (chosen === undefined) {
      // Unreachable: chooseWithin only reports "decided" for an option that
      // is a key of question.criteria, which was built from `allowed`.
      throw new Error(
        `model-matrix: chooseWithin returned option "${result.option}", which is not ` +
          `among the allowed candidates for role "${role}"`,
      );
    }
    return result.decision === undefined
      ? { candidate: chosen, reason: "jev" }
      : { candidate: chosen, reason: "jev", decision: result.decision };
  }

  if (result.reason === "no_decision_service") {
    // A mis-wired caller without a port still gets the safe default, never a crash,
    // and a reason that names the wiring gap rather than an ordinary decision failure.
    return { candidate: fallbackDefault, reason: "no_decision_service" };
  }

  return result.decision === undefined
    ? { candidate: fallbackDefault, reason: result.reason }
    : { candidate: fallbackDefault, reason: result.reason, decision: result.decision };
}
