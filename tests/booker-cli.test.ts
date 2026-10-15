import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

/** The test runner's environment without anything `serve` reads, so no real secret leaks in. */
function sanitizedEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("ELEVENLABS_") || name.startsWith("BOOKER_")) continue;
    env[name] = value;
  }
  return { ...env, ...overrides };
}

/** Runs `src/cli/main.ts` directly, without `--env-file-if-exists`, so `.env` is never loaded. */
function booker(args: readonly string[], env: NodeJS.ProcessEnv = sanitizedEnv()) {
  return spawnSync(process.execPath, ["src/cli/main.ts", ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env,
  });
}

describe("pnpm booker", () => {
  it("is the package script that loads .env through Node, never through code", () => {
    expect(packageJson.scripts.booker).toBe("node --env-file-if-exists=.env src/cli/main.ts");
  });

  it("prints usage to stderr and exits 2 without a command", () => {
    const result = booker([]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: pnpm booker <command>");
    expect(result.stderr).toMatch(/^ {2}serve {2,}Runs the Booker server/m);
    expect(result.stdout).toBe("");
  });

  it("names an unknown command, prints usage, and exits 2", () => {
    const result = booker(["serv"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown command "serv".');
    expect(result.stderr).toContain("Usage: pnpm booker <command>");
  });

  it("prints usage to stdout and exits 0 for --help", () => {
    const result = booker(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: pnpm booker <command>");
    expect(result.stderr).toBe("");
  });

  it("refuses to serve on an invalid port, naming it, before opening any store", () => {
    const result = booker(["serve"], sanitizedEnv({ BOOKER_PORT: "eighty" }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BOOKER_PORT must be a whole number");
    expect(`${result.stdout}${result.stderr}`).not.toContain("eighty");
  });

  it("refuses to serve on a non-loopback host without printing any value", () => {
    const secret = randomBytes(24).toString("hex");
    const host = "192.0.2.10";

    const result = booker(
      ["serve"],
      sanitizedEnv({ ELEVENLABS_WEBHOOK_SECRET: secret, BOOKER_HOST: host }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BOOKER_HOST must be 127.0.0.1");
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(host);
  });
});
