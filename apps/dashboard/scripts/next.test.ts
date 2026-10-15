import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), "next.ts");

describe("the Next.js launcher", () => {
  it("runs the Next.js CLI with its usage telemetry off, whatever the environment says", () => {
    const { NEXT_TELEMETRY_DISABLED: _ignored, ...env } = process.env;
    const result = spawnSync(process.execPath, [LAUNCHER, "telemetry", "status"], {
      encoding: "utf8",
      env,
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Status: Disabled/);
  }, 30_000);
});
