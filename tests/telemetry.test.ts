import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveSettingsFixture } from "../src/persistence/settings-fixture.ts";

const ENTRY = "./src/observability/telemetry.ts";
const TIMEOUT_MS = 30_000;

interface Export {
  readonly path: string;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** An empty repository-like folder, so saved settings come only from what a test writes. */
const scratch = mkdtempSync(join(tmpdir(), "booker-telemetry-"));

/**
 * The environment of this process minus every OTel variable, so only the test's own apply, and
 * with the data directory in `root`, so the real database's saved settings never apply.
 */
function baseEnv(root: string = scratch): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("OTEL_") && name !== "BOOKER_DATA_DIR",
      ),
    ),
    BOOKER_DATA_DIR: join(root, ".local", "data"),
  };
}

/** Runs an ES module snippet in a fresh Node process that preloads the telemetry entry. */
function runWithTelemetry(script: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", ENTRY, "--input-type=module", "--eval", script],
      { env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

// The OTel API keeps its registrations on this global; nothing is there until an SDK registers.
const REPORT_REGISTRATION = `
import { trace } from "@opentelemetry/api";
trace.getTracer("smoke").startSpan("smoke-span").end();
const registered = globalThis[Symbol.for("opentelemetry.js.api.1")]?.trace !== undefined;
console.log(JSON.stringify({ registered }));
`;

describe("the telemetry entry (node --import)", () => {
  let receiver: Server;
  let endpoint: string;
  const exports: Export[] = [];

  beforeAll(async () => {
    receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        exports.push({
          path: request.url ?? "",
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks),
        });
        response.writeHead(200, { "Content-Type": "application/x-protobuf" }).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const address = receiver.address();
    if (address === null || typeof address === "string") throw new Error("expected a TCP port");
    endpoint = `http://127.0.0.1:${address.port}/v1/traces`;
  });

  afterAll(async () => {
    await new Promise((resolve) => receiver.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  it(
    "registers nothing and sends nothing when no endpoint is set",
    async () => {
      exports.length = 0;
      const result = await runWithTelemetry(REPORT_REGISTRATION, baseEnv());

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ registered: false });
      expect(result.stderr).toBe("");
      expect(exports).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "warns about an invalid endpoint without echoing it, and stays off",
    async () => {
      const result = await runWithTelemetry(REPORT_REGISTRATION, {
        ...baseEnv(),
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "phoenix-host:6006/v1/traces",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ registered: false });
      expect(result.stderr).toContain("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
      expect(result.stderr).not.toContain("phoenix-host");
    },
    TIMEOUT_MS,
  );

  it(
    "exports spans as OTLP protobuf over HTTP and flushes them before the process exits",
    async () => {
      exports.length = 0;
      const result = await runWithTelemetry(REPORT_REGISTRATION, {
        ...baseEnv(),
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ registered: true });
      expect(exports).toHaveLength(1);
      expect(exports[0]?.path).toBe("/v1/traces");
      expect(exports[0]?.contentType).toBe("application/x-protobuf");
      expect(exports[0]?.body.includes("smoke-span")).toBe(true);
      expect(exports[0]?.body.includes("booker")).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "sends spans to an endpoint saved in the dashboard when the environment sets none",
    async () => {
      exports.length = 0;
      const root = mkdtempSync(join(tmpdir(), "booker-telemetry-saved-"));
      try {
        await saveSettingsFixture(root, {
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
          OTEL_SERVICE_NAME: "booker-saved",
        });

        const result = await runWithTelemetry(REPORT_REGISTRATION, baseEnv(root));

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ registered: true });
        expect(exports).toHaveLength(1);
        expect(exports[0]?.body.includes("booker-saved")).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});
