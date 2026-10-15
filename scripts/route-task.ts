// Entry point for routing one development task to an agent-matrix row:
// node scripts/route-task.ts "<task>" (or the task piped on stdin).
// Prints the chosen row id, the reason, and the exact worker-start command
// on separate lines, in that order. On "decision_failed_default", also
// prints a sanitized one-line error to stderr. Never runs the command.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JevDecisionAdapter } from "../src/decisions/adapters/jev.ts";
import type { DecisionPort } from "../src/decisions/decision.ts";
import { loadAgentMatrix, routeTask } from "./agent-matrix.ts";

function readTask(argv: readonly string[]): string | undefined {
  const fromArgv = argv[2];
  if (fromArgv !== undefined && fromArgv.length > 0) {
    return fromArgv;
  }
  if (!process.stdin.isTTY) {
    const fromStdin = readFileSync(0, "utf8").trim();
    if (fromStdin.length > 0) {
      return fromStdin;
    }
  }
  return undefined;
}

/**
 * The Jev adapter directly (no `withFallback`) when `TYPESAFE_API_KEY` is
 * set, so `routeTask` sees a Jev failure as-is instead of it being masked as
 * a low-confidence fallback; `undefined` otherwise, so a missing key never
 * attempts a network call and `routeTask` reports `"no_decision_service"`
 * without asking anything. `TYPESAFE_BASE_URL` overrides the default Jev
 * endpoint; it is read only here, so a test can point the CLI at a local
 * server instead of the real Jev API.
 */
function buildDecisions(): DecisionPort | undefined {
  const apiKey = process.env["TYPESAFE_API_KEY"];
  if (apiKey === undefined || apiKey.length === 0) {
    return undefined;
  }
  const baseUrl = process.env["TYPESAFE_BASE_URL"];
  return new JevDecisionAdapter(
    baseUrl === undefined || baseUrl.length === 0 ? { apiKey } : { apiKey, baseUrl },
  );
}

const task = readTask(process.argv);
if (task === undefined) {
  console.error('Usage: node scripts/route-task.ts "<task>" (or pipe the task on stdin)');
  process.exit(2);
}

const matrixPath = resolve(dirname(fileURLToPath(import.meta.url)), "../tools/agent-matrix.json");
const matrix = loadAgentMatrix(matrixPath);
const decisions = buildDecisions();
const apiKey = process.env["TYPESAFE_API_KEY"];
// The key is redacted inside chooseWithin, before the error is trimmed, so no part of it survives.
const result = await routeTask({
  task,
  matrix,
  decisions,
  redact: apiKey === undefined || apiKey.length === 0 ? [] : [apiKey],
});

console.log(result.row.id);
console.log(result.reason);
console.log(result.command);
if (result.error !== undefined) {
  console.error(result.error);
}
