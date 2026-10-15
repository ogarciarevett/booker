import { spawn, spawnSync } from "node:child_process";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

const sanitizedEnv = (): NodeJS.ProcessEnv => {
  const { TYPESAFE_API_KEY: _unusedKey, TYPESAFE_BASE_URL: _unusedUrl, ...rest } = process.env;
  return rest;
};

const run = (args: readonly string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ["scripts/route-task.ts", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env,
  });

interface AsyncRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the CLI asynchronously (not `spawnSync`), so this process's own event
 * loop stays free to serve the local Jev endpoint the test started while the
 * child process is running.
 */
function runAsync(args: readonly string[], env: NodeJS.ProcessEnv): Promise<AsyncRunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["scripts/route-task.ts", ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

/** Starts a local, loopback-only Jev stand-in; tests must never reach the internet. */
function startLocalJev(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected the local Jev stand-in to bind to a network address"));
        return;
      }
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

describe("route-task CLI", () => {
  it('routes to the default row with reason "no_decision_service" and asks nothing when no Jev API key is set', () => {
    const result = run(["Add a webhook signature check"], sanitizedEnv());

    expect(result.status).toBe(0);
    const [rowId, reason, command] = result.stdout.trim().split("\n");
    expect(rowId).toBe("writer");
    expect(reason).toBe("no_decision_service");
    expect(command).toBe(
      "orca orchestration worker-start --spec 'Add a webhook signature check' " +
        "--worktree current --agent codex --model gpt-6.1-sol --effort high --json",
    );
    expect(result.stderr).toBe("");
  });

  it("exits 2 with usage when no task is given on argv or stdin", () => {
    const result = spawnSync(process.execPath, ["scripts/route-task.ts"], {
      encoding: "utf8",
      timeout: 10_000,
      env: sanitizedEnv(),
      input: "",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage");
  });

  it("reads the task from stdin when no argv task is given", () => {
    const result = spawnSync(process.execPath, ["scripts/route-task.ts"], {
      encoding: "utf8",
      timeout: 10_000,
      env: sanitizedEnv(),
      input: "Add a webhook signature check\n",
    });

    expect(result.status).toBe(0);
    const [rowId] = result.stdout.trim().split("\n");
    expect(rowId).toBe("writer");
  });
});

describe("route-task CLI against a local Jev stand-in", () => {
  it('reports "decision_failed_default" and a sanitized error on stderr when Jev responds with a server error', async () => {
    const { server, baseUrl } = await startLocalJev((_req, res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    try {
      const result = await runAsync(["Add a webhook signature check"], {
        ...sanitizedEnv(),
        TYPESAFE_API_KEY: "test-key",
        TYPESAFE_BASE_URL: baseUrl,
      });

      expect(result.status).toBe(0);
      const [rowId, reason, command] = result.stdout.trim().split("\n");
      expect(rowId).toBe("writer");
      expect(reason).toBe("decision_failed_default");
      expect(command).toContain("orca orchestration worker-start");
      expect(result.stderr).toContain("status 500");
      expect(result.stderr).not.toContain("test-key");
    } finally {
      server.close();
    }
  });

  it('reports "decision_failed_default" when Jev answers with a row id that was never offered', async () => {
    const { server, baseUrl } = await startLocalJev((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "jev-test",
          answers: {
            "agent-row": {
              type: "choice",
              choice: "ghost-writer",
              confidence: 0.95,
              probabilities: { "ghost-writer": 0.95 },
            },
          },
        }),
      );
    });
    try {
      const result = await runAsync(["Add a webhook signature check"], {
        ...sanitizedEnv(),
        TYPESAFE_API_KEY: "test-key",
        TYPESAFE_BASE_URL: baseUrl,
      });

      expect(result.status).toBe(0);
      const [rowId, reason] = result.stdout.trim().split("\n");
      expect(rowId).toBe("writer");
      expect(reason).toBe("decision_failed_default");
      expect(result.stderr).toContain("ghost-writer");
      expect(result.stderr).not.toContain("test-key");
    } finally {
      server.close();
    }
  });

  it("never prints the API key, even when the endpoint echoes it back", async () => {
    const { server, baseUrl } = await startLocalJev((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "jev-test",
          answers: {
            "agent-row": {
              type: "choice",
              choice: "echoed-secret-value",
              confidence: 0.95,
              probabilities: {},
            },
          },
        }),
      );
    });
    try {
      const result = await runAsync(["Add a webhook signature check"], {
        ...sanitizedEnv(),
        TYPESAFE_API_KEY: "echoed-secret-value",
        TYPESAFE_BASE_URL: baseUrl,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("echoed-secret-value");
      expect(result.stderr).not.toContain("echoed-secret-value");
      expect(result.stderr).toContain("[redacted]");
    } finally {
      server.close();
    }
  });
});
