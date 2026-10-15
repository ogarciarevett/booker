import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, dataDirectory, LOOPBACK_HOST, parseServeConfig } from "./config.ts";

const REPO_ROOT = "/work/booker";

/** A fresh secret-shaped value per test, built at runtime so no literal looks like a secret. */
function randomSecret(): string {
  return randomBytes(24).toString("hex");
}

function parse(env: Record<string, string | undefined>) {
  return parseServeConfig(env, { repoRoot: REPO_ROOT });
}

function issuesOf(env: Record<string, string | undefined>): string[] {
  const result = parse(env);
  if (result.ok) throw new Error("expected the configuration to be rejected");
  return result.issues;
}

describe("parseServeConfig", () => {
  it("applies the defaults when nothing is set, the webhook secret included (it is read at each delivery)", () => {
    expect(parse({})).toEqual({
      ok: true,
      config: {
        host: LOOPBACK_HOST,
        port: DEFAULT_PORT,
        dataDir: resolve(REPO_ROOT, ".local/data"),
      },
    });
    expect(DEFAULT_PORT).toBe(8787);
    expect(LOOPBACK_HOST).toBe("127.0.0.1");
  });

  it("reads the port, the loopback host, and a data directory resolved against the repo root", () => {
    const result = parse({
      ELEVENLABS_WEBHOOK_SECRET: randomSecret(),
      BOOKER_PORT: "9100",
      BOOKER_HOST: "127.0.0.1",
      BOOKER_DATA_DIR: "var/booker",
    });

    expect(result.ok && result.config.port).toBe(9100);
    expect(result.ok && result.config.host).toBe("127.0.0.1");
    expect(result.ok && result.config.dataDir).toBe(resolve(REPO_ROOT, "var/booker"));
  });

  it("keeps an absolute data directory as it is", () => {
    const result = parse({
      ELEVENLABS_WEBHOOK_SECRET: randomSecret(),
      BOOKER_DATA_DIR: "/srv/booker-data",
    });

    expect(result.ok && result.config.dataDir).toBe("/srv/booker-data");
  });

  it("treats empty values as unset, as an .env line with nothing after `=` leaves them", () => {
    const result = parse({
      ELEVENLABS_WEBHOOK_SECRET: randomSecret(),
      BOOKER_PORT: "",
      BOOKER_HOST: "",
      BOOKER_DATA_DIR: "",
    });

    expect(result.ok && result.config.port).toBe(DEFAULT_PORT);
    expect(result.ok && result.config.host).toBe(LOOPBACK_HOST);
    expect(result.ok && result.config.dataDir).toBe(resolve(REPO_ROOT, ".local/data"));
  });

  it("finds the data directory from the environment alone, as the database cannot say where it is", () => {
    expect(dataDirectory({}, REPO_ROOT)).toBe(resolve(REPO_ROOT, ".local/data"));
    expect(dataDirectory({ BOOKER_DATA_DIR: "var/booker" }, REPO_ROOT)).toBe(
      resolve(REPO_ROOT, "var/booker"),
    );
    expect(dataDirectory({ BOOKER_DATA_DIR: "" }, REPO_ROOT)).toBe(
      resolve(REPO_ROOT, ".local/data"),
    );
  });

  it.each(["0.0.0.0", "localhost", "::1", "192.0.2.10"])(
    "refuses BOOKER_HOST=%s: Booker listens only on 127.0.0.1",
    (host) => {
      const issues = issuesOf({ ELEVENLABS_WEBHOOK_SECRET: randomSecret(), BOOKER_HOST: host });

      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("BOOKER_HOST");
      expect(issues[0]).toContain("127.0.0.1");
      expect(issues[0]).toContain("Tailscale Funnel");
    },
  );

  it.each(["abc", "0", "65536", "80.5", "-1", " 8787", "8787abc"])(
    "rejects BOOKER_PORT=%j, naming the variable",
    (port) => {
      const issues = issuesOf({ ELEVENLABS_WEBHOOK_SECRET: randomSecret(), BOOKER_PORT: port });

      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain("BOOKER_PORT");
    },
  );

  it("reports every invalid variable at once, each one only once", () => {
    const issues = issuesOf({ BOOKER_PORT: "not-a-port", BOOKER_HOST: "0.0.0.0" });

    expect(issues).toHaveLength(2);
    expect(issues.join("\n")).toContain("BOOKER_PORT");
    expect(issues.join("\n")).toContain("BOOKER_HOST");
  });

  it("never repeats a configured value in an error", () => {
    const secret = randomSecret();
    const port = `port-${randomSecret()}`;
    const host = `host-${randomSecret()}.example`;

    const issues = issuesOf({
      ELEVENLABS_WEBHOOK_SECRET: secret,
      BOOKER_PORT: port,
      BOOKER_HOST: host,
    });

    const text = issues.join("\n");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(port);
    expect(text).not.toContain(host);
  });
});
