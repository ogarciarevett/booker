import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentMatrix, AgentMatrixRow } from "../scripts/agent-matrix.ts";
import { loadAgentMatrix, quotePosixShellArg, routeTask } from "../scripts/agent-matrix.ts";
import type { ChooseInput, Decision, DecisionPort } from "../src/decisions/decision.ts";

const REAL_MATRIX_PATH = join(process.cwd(), "tools/agent-matrix.json");
const DOCS_PATH = join(process.cwd(), "docs/agent-matrix.md");

const workDir = mkdtempSync(join(tmpdir(), "booker-agent-matrix-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const writeMatrixFile = (name: string, content: unknown): string => {
  const path = join(workDir, name);
  writeFileSync(path, JSON.stringify(content));
  return path;
};

function row(overrides: Partial<AgentMatrixRow> = {}): AgentMatrixRow {
  return {
    id: "writer",
    agent: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    purpose: "Default implementation under strict TDD.",
    ...overrides,
  };
}

function fakeMatrix(rows: readonly AgentMatrixRow[], defaultId = "writer"): AgentMatrix {
  return { default: defaultId, rows };
}

/** A `DecisionPort` test double, styled like `src/reasoning/model-matrix.test.ts`'s. */
interface RecordingPort extends DecisionPort {
  readonly calls: number;
  readonly lastInput: ChooseInput<string> | undefined;
}

function fakePort(
  respond: (input: ChooseInput<string>) => Decision<string> | Promise<Decision<string>>,
): RecordingPort {
  let calls = 0;
  let lastInput: ChooseInput<string> | undefined;
  return {
    get calls() {
      return calls;
    },
    get lastInput() {
      return lastInput;
    },
    async choose<Option extends string>(input: ChooseInput<Option>): Promise<Decision<Option>> {
      calls += 1;
      lastInput = input as unknown as ChooseInput<string>;
      const result = await respond(input as unknown as ChooseInput<string>);
      return result as unknown as Decision<Option>;
    },
  };
}

function throwingPort(error: unknown): DecisionPort {
  return {
    async choose(): Promise<never> {
      throw error;
    },
  };
}

function jevDecision(choice: string, confidence: number): Decision<string> {
  return {
    choice,
    confidence,
    probabilities: { [choice]: confidence },
    modelVersion: "jev-2026-09-30",
    source: "jev",
  };
}

describe("loadAgentMatrix", () => {
  it("loads and validates the real tools/agent-matrix.json", () => {
    const matrix = loadAgentMatrix(REAL_MATRIX_PATH);
    expect(matrix.rows.length).toBeGreaterThan(0);
    expect(matrix.rows.some((r) => r.id === matrix.default)).toBe(true);
  });

  it("rejects a matrix with a duplicate row id", () => {
    const path = writeMatrixFile("duplicate.json", {
      default: "writer",
      rows: [row({ id: "writer" }), row({ id: "writer", agent: "claude" })],
    });
    expect(() => loadAgentMatrix(path)).toThrow(/duplicate/i);
  });

  it("rejects a matrix whose default does not name a row", () => {
    const path = writeMatrixFile("missing-default.json", {
      default: "ghost",
      rows: [row({ id: "writer" })],
    });
    expect(() => loadAgentMatrix(path)).toThrow(/default/i);
  });

  it("rejects an agent outside claude | codex", () => {
    const path = writeMatrixFile("bad-agent.json", {
      default: "writer",
      rows: [row({ agent: "gemini" as unknown as AgentMatrixRow["agent"] })],
    });
    expect(() => loadAgentMatrix(path)).toThrow();
  });

  it.each(["model", "effort", "purpose"] as const)("rejects an empty %s", (field) => {
    const path = writeMatrixFile(`empty-${field}.json`, {
      default: "writer",
      rows: [row({ [field]: "" })],
    });
    expect(() => loadAgentMatrix(path)).toThrow();
  });

  it.each(["model", "effort"] as const)(
    "rejects a %s containing a shell metacharacter",
    (field) => {
      const path = writeMatrixFile(`unsafe-${field}.json`, {
        default: "writer",
        rows: [row({ [field]: "gpt-6.1-sol; rm -rf /" })],
      });
      expect(() => loadAgentMatrix(path)).toThrow();
    },
  );
});

describe("routeTask", () => {
  const matrix = fakeMatrix([
    row({ id: "writer", purpose: "Default implementation under strict TDD." }),
    row({
      id: "critical-writer",
      agent: "claude",
      model: "claude-opus-5-5",
      purpose: "Money, permissions, persistence, or concurrency.",
    }),
    row({
      id: "reviewer",
      agent: "claude",
      model: "claude-sonnet-5-5",
      effort: "medium",
      purpose: "Cross-vendor review.",
    }),
  ]);

  it('returns Jev\'s pick with reason "jev" at or above the act threshold', async () => {
    const decisions = fakePort(() => jevDecision("critical-writer", 0.95));

    const result = await routeTask({ task: "Add a money transfer", matrix, decisions });

    expect(result.reason).toBe("jev");
    expect(result.row.id).toBe("critical-writer");
    expect(result.decision?.confidence).toBe(0.95);
  });

  it('falls back to the default row with reason "low_confidence_default" below the act threshold', async () => {
    const decisions = fakePort(() => jevDecision("critical-writer", 0.6));

    const result = await routeTask({ task: "Add a money transfer", matrix, decisions });

    expect(result.reason).toBe("low_confidence_default");
    expect(result.row.id).toBe("writer");
  });

  it('falls back to the default row with reason "invalid_choice_default" for an unoffered row id', async () => {
    const decisions = fakePort(() => jevDecision("ghost-writer", 0.99));

    const result = await routeTask({ task: "Add a money transfer", matrix, decisions });

    expect(result.reason).toBe("invalid_choice_default");
    expect(result.row.id).toBe("writer");
  });

  it('returns the default row with reason "no_decision_service" and asks nothing when no decision port is given', async () => {
    const result = await routeTask({ task: "Add a money transfer", matrix });

    expect(result.reason).toBe("no_decision_service");
    expect(result.row.id).toBe("writer");
    expect(result.decision).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('falls back to the default row with reason "decision_failed_default" when the port throws', async () => {
    const decisions = throwingPort(new Error("jev unavailable"));

    const result = await routeTask({ task: "Add a money transfer", matrix, decisions });

    expect(result.reason).toBe("decision_failed_default");
    expect(result.row.id).toBe("writer");
    expect(result.decision).toBeUndefined();
  });

  it("sends every row id mapped to its purpose as the question criteria", async () => {
    const decisions = fakePort(() => jevDecision("writer", 0.95));

    await routeTask({ task: "state", matrix, decisions });

    expect(decisions.lastInput?.question.key).toBe("agent-row");
    expect(decisions.lastInput?.state).toBe("state");
    expect(decisions.lastInput?.question.criteria).toEqual({
      writer: "Default implementation under strict TDD.",
      "critical-writer": "Money, permissions, persistence, or concurrency.",
      reviewer: "Cross-vendor review.",
    });
  });

  it("returns the worker-start command as a plain string, without executing a dangerous task", async () => {
    const decisions = fakePort(() => jevDecision("writer", 0.95));
    const result = await routeTask({ task: "rm -rf /", matrix, decisions });
    expect(result.command).toContain("orca orchestration worker-start");
  });

  describe("command for every row of the real tools/agent-matrix.json", () => {
    const realMatrix = loadAgentMatrix(REAL_MATRIX_PATH);

    it.each(realMatrix.rows)("builds the worker-start command for row %o", async (realRow) => {
      const decisions = fakePort(() => jevDecision(realRow.id, 0.95));

      const result = await routeTask({
        task: "Add a webhook signature check",
        matrix: realMatrix,
        decisions,
      });

      expect(result.row.id).toBe(realRow.id);
      expect(result.command).toBe(
        `orca orchestration worker-start --spec 'Add a webhook signature check' ` +
          `--worktree current --agent ${realRow.agent} --model ${realRow.model} ` +
          `--effort ${realRow.effort} --json`,
      );
    });
  });
});

describe("quotePosixShellArg", () => {
  it.each([
    "simple task",
    "task with a 'single quote'",
    'task with "double quotes"',
    "task with $(command substitution)",
    "task with `backticks`",
    "task with\nan embedded newline",
    "task with '$(rm -rf /)' and `echo pwned`",
  ])("round-trips through sh -c 'printf %%s ...' for: %s", (task) => {
    const quoted = quotePosixShellArg(task);
    const output = execFileSync("sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });
    expect(output).toBe(task);
  });
});

/** The "## The rows" table in `docs/agent-matrix.md`, up to the next heading. */
function rowsTableSection(docs: string): string {
  const start = docs.indexOf("## The rows");
  if (start === -1) {
    throw new Error('docs/agent-matrix.md is missing a "## The rows" section');
  }
  const end = docs.indexOf("\n## ", start + 1);
  return end === -1 ? docs.slice(start) : docs.slice(start, end);
}

describe("docs/agent-matrix.md", () => {
  it("lists every real matrix row's id, agent, model, and effort in its table", () => {
    const matrix = loadAgentMatrix(REAL_MATRIX_PATH);
    const table = rowsTableSection(readFileSync(DOCS_PATH, "utf8"));

    const lines = table.split("\n");
    for (const matrixRow of matrix.rows) {
      // Each row's fields must sit together on that row's own table line.
      const line = lines.find((candidate) => candidate.startsWith(`| \`${matrixRow.id}\``));
      expect(line, `docs table row for ${matrixRow.id}`).toBeDefined();
      const cells = (line ?? "").split("|").map((cell) => cell.trim().replaceAll("`", ""));
      expect(cells[2]).toBe(matrixRow.agent);
      expect(cells[3]).toBe(matrixRow.model);
      expect(cells[4]).toBe(matrixRow.effort);
    }
  });
});
