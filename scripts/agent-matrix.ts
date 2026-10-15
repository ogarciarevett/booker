// Loads and validates the development agent matrix (`tools/agent-matrix.json`)
// and routes one development task to a matrix row via Jev, mirroring
// `selectModel` in `src/reasoning/model-matrix.ts`. Lives in `scripts/`,
// which is outside the domain scan (see `tests/architecture.test.ts`), so it
// may import the decisions port directly.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { chooseWithin } from "../src/decisions/choose-within.ts";
import type {
  ChoiceQuestion,
  ConfidenceThresholds,
  Decision,
  DecisionPort,
} from "../src/decisions/decision.ts";

// `model` and `effort` are spliced unquoted into the printed worker-start
// command (see `workerStartCommand`), so they are restricted to a safe token
// shape: letters, digits, `.`, `_`, `:`, `/`, and `-`. A shell metacharacter
// here (`;`, `$(...)`, backticks, quotes, whitespace, ...) would let a
// tampered matrix file inject into a command a coordinator might copy-paste
// and run.
const safeCommandToken = /^[A-Za-z0-9._:/-]+$/;

const agentMatrixRowSchema = z.object({
  id: z.string().min(1),
  agent: z.enum(["claude", "codex"]),
  model: z.string().min(1).regex(safeCommandToken),
  effort: z.string().min(1).regex(safeCommandToken),
  purpose: z.string().min(1),
});

const rawAgentMatrixSchema = z.object({
  default: z.string().min(1),
  rows: z.array(agentMatrixRowSchema).min(1),
});

export type AgentMatrixRow = z.infer<typeof agentMatrixRowSchema>;

/** A validated `tools/agent-matrix.json`: row ids are unique and `default` names one of them. */
export interface AgentMatrix {
  readonly default: string;
  readonly rows: readonly AgentMatrixRow[];
}

/**
 * Checks the invariants `rawAgentMatrixSchema` cannot express on its own:
 * every row id is unique, and `default` names one of them. Zod validates the
 * per-row shape; this is a plain follow-up check, the same split
 * `decision.ts`'s `classifyConfidence` uses for its own range invariant.
 */
function validateAgentMatrix(candidate: unknown): AgentMatrix {
  const parsed = rawAgentMatrixSchema.parse(candidate);
  const ids = parsed.rows.map((matrixRow) => matrixRow.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new Error(`agent matrix has a duplicate row id "${duplicate}"`);
  }
  if (!ids.includes(parsed.default)) {
    throw new Error(`agent matrix "default" ("${parsed.default}") does not name one of its rows`);
  }
  return parsed;
}

/** Reads and validates the agent matrix file at `path` (ordinarily `tools/agent-matrix.json`). */
export function loadAgentMatrix(path: string): AgentMatrix {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return validateAgentMatrix(raw);
}

/**
 * Escapes `value` as one single-quoted POSIX shell word: every embedded `'`
 * becomes `'\''` (close the quote, an escaped literal quote, reopen the
 * quote). Nothing else is special inside single quotes, so this is safe for
 * a task containing `"`, `$(...)`, backticks, or newlines.
 */
export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function workerStartCommand(row: AgentMatrixRow, task: string): string {
  return [
    "orca orchestration worker-start",
    `--spec ${quotePosixShellArg(task)}`,
    "--worktree current",
    `--agent ${row.agent}`,
    `--model ${row.model}`,
    `--effort ${row.effort}`,
    "--json",
  ].join(" ");
}

/** Why `routeTask` returned the row it did. Mirrors `SelectModelReason` in
 * `src/reasoning/model-matrix.ts` minus `"only_option"` (the development
 * matrix always offers more than one row, so `routeTask` always asks) plus
 * `"no_decision_service"`, for when no decision port is configured at all. */
export type RouteTaskReason =
  | "jev"
  | "no_decision_service"
  | "low_confidence_default"
  | "invalid_choice_default"
  | "decision_failed_default";

export interface RouteTaskInput {
  readonly task: string;
  readonly matrix: AgentMatrix;
  /** `undefined` when no decision service is configured (see `scripts/route-task.ts`); `routeTask` then asks nothing and reports `"no_decision_service"`. */
  readonly decisions?: DecisionPort | undefined;
  readonly thresholds?: ConfidenceThresholds;
  /** Secrets to redact from a reported decision error (see `chooseWithin`). */
  readonly redact?: readonly string[];
}

export interface RouteTaskResult {
  readonly row: AgentMatrixRow;
  readonly reason: RouteTaskReason;
  /** The exact `orca orchestration worker-start` command for `row` and the routed task. Never run by `routeTask` itself. */
  readonly command: string;
  /** Present only when a usable decision was reached (`"jev"`, `"low_confidence_default"`, or `"invalid_choice_default"`). */
  readonly decision?: Decision<string>;
  /** Present only for `"decision_failed_default"`: a sanitized error message (never a secret such as an API key). */
  readonly error?: string;
}

function rowById(matrix: AgentMatrix, id: string): AgentMatrixRow {
  const found = matrix.rows.find((matrixRow) => matrixRow.id === id);
  if (found === undefined) {
    throw new Error(`agent matrix row "${id}" is missing`);
  }
  return found;
}

/**
 * Picks the development matrix row for `task` and the exact
 * `orca orchestration worker-start` command to launch it; never runs it.
 * When `decisions` is given, asks it an `"agent-row"` choice question whose
 * criteria are each row id mapped to its `purpose`, through `chooseWithin`
 * (`src/decisions/choose-within.ts`, shared with `selectModel` in
 * `src/reasoning/model-matrix.ts`). Per `AGENTS.md` ("a model or Jev result
 * alone never authorizes" the outcome), that answer is trusted only at the
 * `"act"` confidence tier and only when it names a matrix row; any other
 * outcome — no `decisions` port at all, a low-confidence or unoffered
 * answer, or `decisions.choose` throwing — falls back to `matrix.default`.
 */
export async function routeTask({
  task,
  matrix,
  decisions,
  thresholds,
  redact,
}: RouteTaskInput): Promise<RouteTaskResult> {
  const defaultRow = rowById(matrix, matrix.default);

  const question: ChoiceQuestion<string> = {
    key: "agent-row",
    instructions: "Pick the development matrix row that should run this task.",
    criteria: Object.fromEntries(
      matrix.rows.map((matrixRow): [string, string] => [matrixRow.id, matrixRow.purpose]),
    ),
  };

  const result = await chooseWithin({
    decisions,
    state: task,
    question,
    defaultOption: defaultRow.id,
    thresholds,
    redact,
  });

  const row = rowById(matrix, result.option);
  const reason: RouteTaskReason = result.reason === "decided" ? "jev" : result.reason;
  const command = workerStartCommand(row, task);

  if (result.decision !== undefined) {
    return { row, reason, command, decision: result.decision };
  }
  if (result.error !== undefined) {
    return { row, reason, command, error: result.error };
  }
  return { row, reason, command };
}
