# Development agent matrix

Booker routes every Orca development worker through one matrix (`tools/agent-matrix.json`) instead of picking an agent, model, and effort by hand each time. Jev proposes a row; code validates the pick and never runs anything on its own.

## Quick path

```bash
pnpm route-task "Add a webhook signature check"
```

This prints three lines: the chosen row id, why it was chosen, and the exact `orca orchestration worker-start` command for that row and task. It never runs the command — the coordinator (you, or an orchestrating agent) copies it, runs it, and then compares `launch.requested` with `launch.effective` before trusting which model actually ran.

## The rows

| Row | Agent | Model | Effort | Purpose |
|-----|-------|-------|--------|---------|
| `writer` (default) | codex | `gpt-6.1-sol` | high | Default implementation with strict TDD |
| `critical-writer` | claude | `claude-opus-5-5` | high | Money, permissions, persistence, concurrency |
| `reviewer` | claude | `claude-sonnet-5-5` | medium | Cross-vendor review of codex output |
| `explorer` | claude | `claude-sonnet-5-5` | medium | Read-only mapping and research |
| `docs` | claude | `claude-sonnet-5-5` | medium | Documentation |

This table is maintained by hand from `tools/agent-matrix.json`; if they ever disagree, the JSON file is the source of truth. A test in `tests/agent-matrix.test.ts` checks that every row's id, agent, model, and effort from the JSON file appears in this table, so an edit here that drops a field fails `pnpm check`.

## How Jev picks, and when the default wins

`scripts/route-task.ts` asks Jev a single bounded choice question keyed `agent-row`, with each row's `purpose` as the criterion text, through the same shared `chooseWithin` logic (`src/decisions/choose-within.ts`) the runtime model matrix uses (`src/reasoning/model-matrix.ts`). Jev's answer is trusted only when it clears the same confidence bar:

| Outcome | Reason printed |
|---------|-----------------|
| `TYPESAFE_API_KEY` is not set, so no decision service is configured at all | `no_decision_service` |
| Jev names a row and confidence is at or above the "act" threshold (0.9) | `jev` |
| Jev names a row but confidence is below "act" | `low_confidence_default` |
| A decision port returns a choice that is not one of the offered row ids without rejecting it itself (test doubles; the real Jev adapter rejects unoffered ids and lands in the next row) | `invalid_choice_default` |
| The decision call fails: network failure, bad response, timeout, an out-of-range confidence, or the Jev adapter rejecting an unoffered choice | `decision_failed_default` |

Every non-`jev` outcome falls back to the matrix's own `default` row (`writer`). Code, not the model, has the final say — see AGENTS.md's "Commit permission is decided by code" rule, which this mirrors for development routing.

On `decision_failed_default`, the CLI also prints one line to stderr: the underlying error's message with control characters removed, whitespace collapsed, at most 300 characters, and the configured API key replaced with `[redacted]` before any trimming (the endpoint controls part of that text). Every other outcome prints nothing to stderr.

`pnpm route-task` never calls the real Jev API unless `TYPESAFE_API_KEY` is set in the environment; without it, `routeTask` is given no decision port at all and reports `no_decision_service` without asking anything. `TYPESAFE_BASE_URL` optionally overrides the default Jev endpoint (used by tests to point the CLI at a local server instead of the real API).

## Verifying a launch

`orca orchestration worker-start` accepts `--model` only together with `--effort`. After launching, compare the returned `launch.requested` against `launch.effective` — never assume the requested model actually ran (see `orca skills get orchestration --reference references/coordinator-loop.md`).

## Details

| Topic | Decision |
|-------|----------|
| Where the matrix lives | `tools/agent-matrix.json`, validated by a Zod schema in `scripts/agent-matrix.ts` (unique row ids, `default` names one of them, `agent` in `claude \| codex`, non-empty `model`/`effort`/`purpose`, `model`/`effort` restricted to `^[A-Za-z0-9._:/-]+$`) |
| Routing logic | `routeTask` in `scripts/agent-matrix.ts`, a pure function taking the matrix and an optional `DecisionPort` (`undefined` means no decision service); no filesystem or network access of its own |
| CLI entry point | `scripts/route-task.ts`: reads the task from argv or stdin, loads the matrix, builds the decision port (or none, without a key), prints the result, prints a sanitized error to stderr on `decision_failed_default`, exits 2 on missing usage |
| Command safety | The task is single-quoted for POSIX shells (`'` becomes `'\''`) before being spliced into `--spec`, so quotes, `$(...)`, backticks, and newlines in the task text cannot break out of the argument. `model` and `effort` are restricted at the schema boundary instead, since they are spliced unquoted into `--model`/`--effort` |

## Next step

See `src/reasoning/model-matrix.ts` for the equivalent matrix over Booker's own runtime roles (in-call and offline reasoning), which uses the same Jev-then-validate pattern.
