import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PHOENIX_PACKAGE, PHOENIX_URL, phoenixCommand } from "../scripts/phoenix-command.ts";

const REPO_ROOT = "/work/booker";

/** Generated at run time, so no credential-shaped literal is ever committed. */
function fakeCredential(): string {
  return randomBytes(16).toString("hex");
}

describe("phoenixCommand", () => {
  it("runs the pinned Phoenix release through uvx", () => {
    const command = phoenixCommand({ repoRoot: REPO_ROOT, env: {} });

    expect(PHOENIX_PACKAGE).toBe("arize-phoenix==20.19.0");
    expect(command.command).toBe("uvx");
    expect(command.args).toEqual([
      "--python",
      "3.13",
      "--from",
      PHOENIX_PACKAGE,
      "phoenix",
      "serve",
    ]);
  });

  it("binds Phoenix to loopback, keeps its data under .local/phoenix, and turns telemetry off", () => {
    const { env } = phoenixCommand({
      repoRoot: REPO_ROOT,
      env: { PATH: "/usr/bin", PHOENIX_HOST: "0.0.0.0", PHOENIX_TELEMETRY_ENABLED: "true" },
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      PHOENIX_HOST: "127.0.0.1",
      PHOENIX_PORT: "6006",
      PHOENIX_WORKING_DIR: "/work/booker/.local/phoenix",
      PHOENIX_TELEMETRY_ENABLED: "false",
    });
    expect(PHOENIX_URL).toBe("http://127.0.0.1:6006");
  });

  it("never hands Booker's credentials or configuration to Phoenix", () => {
    const { env } = phoenixCommand({
      repoRoot: REPO_ROOT,
      env: {
        HOME: "/Users/someone",
        ELEVENLABS_API_KEY: fakeCredential(),
        TWILIO_AUTH_TOKEN: fakeCredential(),
        TWILIO_ACCOUNT_SID: "AC0123456789",
        TYPESAFE_API_KEY: fakeCredential(),
        BOOKER_OWNER_NAME: "Example Owner 4",
        GITHUB_TOKEN: fakeCredential(),
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:6006/v1/traces",
      },
    });

    expect(Object.keys(env).sort()).toEqual([
      "HOME",
      "PHOENIX_HOST",
      "PHOENIX_PORT",
      "PHOENIX_TELEMETRY_ENABLED",
      "PHOENIX_WORKING_DIR",
    ]);
  });
});
