import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registeredSpanSecrets } from "../observability/redaction.ts";
import { saveSettingsFixture } from "../persistence/settings-fixture.ts";
import { controlTokenPath } from "../server/control-token.ts";
import { ensureVoiceToolsKey, voiceToolsKeyPath } from "../server/voice-tools-key.ts";
import { webhookSecretPath } from "../server/webhook-secret.ts";
import { InMemorySecretStore } from "../settings/adapters/in-memory-secret-store.ts";
import type { CliContext } from "./context.ts";
import { serveCommand } from "./serve.ts";

function randomHex(): string {
  return randomBytes(24).toString("hex");
}

/** Binds an ephemeral loopback port and keeps it, so a test can find it taken. */
function occupyPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP address"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

async function freePort(): Promise<number> {
  const { server, port } = await occupyPort();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface TestContext extends CliContext {
  readonly out: string[];
  readonly err: string[];
  readonly signals: EventEmitter;
}

function context(
  repoRoot: string,
  env: Record<string, string>,
  secrets: InMemorySecretStore = new InMemorySecretStore(),
): TestContext {
  const out: string[] = [];
  const err: string[] = [];
  return {
    repoRoot,
    env,
    secrets,
    dotenvNames: new Set(),
    signals: new EventEmitter(),
    out,
    err,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
}

/** An `ElevenLabs-Signature` header for `rawBody`, signed now. */
function signature(secret: string, rawBody: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v0=${digest}`;
}

describe("booker serve", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "booker-serve-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /**
   * Starts `serve` and waits until it listens. The exit promise is wrapped in an object: an
   * async function returning it bare would wait for the exit itself.
   */
  async function startServe(
    ctx: TestContext,
    port: number,
  ): Promise<{ readonly exited: Promise<number> }> {
    const exited = serveCommand.run([], ctx);
    await vi.waitFor(() => {
      expect(ctx.out.join("\n")).toContain(`http://127.0.0.1:${port}`);
    });
    return { exited };
  }

  it("serves on the configured port with a key it generated, and stops cleanly on SIGTERM", async () => {
    const port = await freePort();
    const webhookSecret = randomHex();
    const ctx = context(repoRoot, {
      ELEVENLABS_WEBHOOK_SECRET: webhookSecret,
      BOOKER_PORT: String(port),
    });

    const { exited } = await startServe(ctx, port);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    const keyPath = voiceToolsKeyPath(repoRoot);

    expect(health.status).toBe(200);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(repoRoot, ".local", "data", "booker.db"))).toBe(true);
    expect(ctx.out.join("\n")).toContain(
      "Voice-tools key: generated at .local/secrets/voice-tools-key",
    );
    expect(statSync(controlTokenPath(repoRoot)).mode & 0o777).toBe(0o600);
    expect(ctx.out.join("\n")).toContain(
      "Control token: generated at .local/secrets/control-token",
    );
    expect(ctx.out.join("\n")).toContain(
      "Calls: off until ELEVENLABS_API_KEY and BOOKER_OWNER_NAME are set",
    );
    const anonymous = await fetch(`http://127.0.0.1:${port}/control/calls/x`);
    expect(anonymous.status).toBe(401);

    ctx.signals.emit("SIGTERM");

    expect(await exited).toBe(0);
    expect(ctx.out.at(-1)).toBe("Stopped.");
    expect(ctx.signals.listenerCount("SIGINT")).toBe(0);
    expect(ctx.signals.listenerCount("SIGTERM")).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toMatch(/ GET \/healthz 200 \d+ms/);
    expect(printed).not.toContain(readFileSync(keyPath, "utf8"));
    expect(printed).not.toContain(readFileSync(controlTokenPath(repoRoot), "utf8"));
    expect(printed).not.toContain(webhookSecret);
  });

  it("says calls are on once the API key and the owner's name are set", async () => {
    const port = await freePort();
    const ctx = context(repoRoot, {
      ELEVENLABS_WEBHOOK_SECRET: randomHex(),
      BOOKER_PORT: String(port),
      ELEVENLABS_API_KEY: randomHex(),
      BOOKER_OWNER_NAME: "Example Owner 1",
    });

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    expect(ctx.out.join("\n")).toContain(
      "Calls: on (agents and number from .local/elevenlabs.json); stale calls are checked every minute",
    );
  });

  it("starts without the webhook secret, and applies one saved while it runs", async () => {
    const port = await freePort();
    const secrets = new InMemorySecretStore();
    const ctx = context(repoRoot, { BOOKER_PORT: String(port) }, secrets);
    const deliver = (headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/webhooks/elevenlabs/post-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}",
      });

    const { exited } = await startServe(ctx, port);
    expect(ctx.out.join("\n")).toContain(
      "Post-call webhook: off until ELEVENLABS_WEBHOOK_SECRET is set; deliveries get 503 and are retried",
    );
    expect((await deliver()).status).toBe(503);

    const secret = randomHex();
    await secrets.set("ELEVENLABS_WEBHOOK_SECRET", secret);
    expect((await deliver()).status).toBe(401);
    expect((await deliver({ "ElevenLabs-Signature": signature(secret, "{}") })).status).toBe(400);

    ctx.signals.emit("SIGINT");
    expect(await exited).toBe(0);
  });

  it("listens on a port saved in the dashboard, and says calls are on with saved credentials", async () => {
    const port = await freePort();
    await saveSettingsFixture(repoRoot, {
      BOOKER_PORT: String(port),
      BOOKER_OWNER_NAME: "Example Owner 1",
    });
    const secrets = new InMemorySecretStore();
    const apiKey = randomHex();
    await secrets.set("ELEVENLABS_API_KEY", apiKey);
    await secrets.set("ELEVENLABS_WEBHOOK_SECRET", randomHex());
    const ctx = context(repoRoot, {}, secrets);

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    const printed = ctx.out.join("\n");
    expect(printed).toContain("Calls: on");
    expect(printed).not.toContain("Post-call webhook: off");
    expect(registeredSpanSecrets()).toContain(apiKey);
  });

  it("refuses a port saved in the dashboard that is not valid, naming it only", async () => {
    await saveSettingsFixture(repoRoot, { BOOKER_PORT: "eighty" });
    const ctx = context(repoRoot, {});

    expect(await serveCommand.run([], ctx)).toBe(1);
    const printed = ctx.err.join("\n");
    expect(printed).toContain("BOOKER_PORT");
    expect(printed).not.toContain("eighty");
  });

  it("says tracing is off when the endpoint saved in the dashboard needs pnpm serve:traced", async () => {
    const port = await freePort();
    await saveSettingsFixture(repoRoot, {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:6006/v1/traces",
    });
    const ctx = context(repoRoot, { BOOKER_PORT: String(port) });

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    expect(ctx.out.join("\n")).toContain(
      "Tracing: off; OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set, so start with pnpm serve:traced",
    );
  });

  it("serves the settings routes: a saved value applies, a restart-only one waits, a secret is redacted", async () => {
    const port = await freePort();
    const secrets = new InMemorySecretStore();
    const ctx = context(repoRoot, { BOOKER_PORT: String(port) }, secrets);
    const { exited } = await startServe(ctx, port);
    const token = readFileSync(controlTokenPath(repoRoot), "utf8");
    const request = (method: string, path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const secret = randomHex();

    expect((await request("PUT", "/control/settings/BOOKER_PORT", { value: "9100" })).status).toBe(
      409,
    );
    const service = await request("PUT", "/control/settings/OTEL_SERVICE_NAME", {
      value: "booker-local",
    });
    expect(await service.json()).toMatchObject({ source: "store", restartPending: true });
    const saved = await request("PUT", "/control/settings/ELEVENLABS_WEBHOOK_SECRET", {
      value: secret,
    });
    expect(saved.status).toBe(200);
    expect(await secrets.get("ELEVENLABS_WEBHOOK_SECRET")).toBe(secret);
    expect(registeredSpanSecrets()).toContain(secret);
    const listed = await (await request("GET", "/control/settings")).text();
    expect(listed).not.toContain(secret);

    ctx.signals.emit("SIGINT");
    expect(await exited).toBe(0);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain("setting OTEL_SERVICE_NAME saved (store: sqlite)");
    expect(printed).toContain("setting ELEVENLABS_WEBHOOK_SECRET saved (store: keychain)");
    expect(printed).not.toContain(secret);
  });

  it("keeps calls off while the post-call webhook has no secret, and says so", async () => {
    const port = await freePort();
    const ctx = context(repoRoot, {
      BOOKER_PORT: String(port),
      ELEVENLABS_API_KEY: randomHex(),
      BOOKER_OWNER_NAME: "Example Owner 1",
    });

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    expect(ctx.out.join("\n")).toContain("Calls: off until ELEVENLABS_WEBHOOK_SECRET is set");
  });

  it("starts when the Keychain refuses, saying so, and uses the webhook secret agent sync saved", async () => {
    const port = await freePort();
    const secretPath = webhookSecretPath(repoRoot);
    mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
    const saved = randomHex();
    writeFileSync(secretPath, saved, { mode: 0o600 });
    const locked = new InMemorySecretStore();
    locked.get = async (name) => {
      throw new Error(
        `The macOS Keychain could not read ${name}: User interaction is not allowed.`,
      );
    };
    const ctx = context(repoRoot, { BOOKER_PORT: String(port) }, locked);

    const { exited } = await startServe(ctx, port);
    const delivery = await fetch(`http://127.0.0.1:${port}/webhooks/elevenlabs/post-call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ElevenLabs-Signature": signature(saved, "{}"),
      },
      body: "{}",
    });
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    expect(delivery.status).toBe(400);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain(
      "Keychain unavailable: The macOS Keychain could not read ELEVENLABS_WEBHOOK_SECRET: User interaction is not allowed.",
    );
    expect(printed).not.toContain("Post-call webhook: off");
    expect(printed).not.toContain(saved);
  });

  it("prints nothing about tracing when no OTel variable is set", async () => {
    const port = await freePort();
    const ctx = context(repoRoot, {
      ELEVENLABS_WEBHOOK_SECRET: randomHex(),
      BOOKER_PORT: String(port),
    });

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain("Tracing");
  });

  it("says where spans go when tracing runs, without the endpoint's credentials", async () => {
    const port = await freePort();
    const ctx: TestContext = {
      ...context(repoRoot, { ELEVENLABS_WEBHOOK_SECRET: randomHex(), BOOKER_PORT: String(port) }),
      tracing: {
        status: "on",
        endpoint: "http://user:hunter22@127.0.0.1:6006/v1/traces?key=abc",
        serviceName: "booker",
      },
    };

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain(
      "Tracing: on (service booker), spans go to http://127.0.0.1:6006/v1/traces",
    );
    expect(printed).not.toContain("hunter22");
    expect(printed).not.toContain("key=abc");
  });

  it("says tracing is off when the endpoint is set but the tracer was not preloaded", async () => {
    const port = await freePort();
    const ctx = context(repoRoot, {
      ELEVENLABS_WEBHOOK_SECRET: randomHex(),
      BOOKER_PORT: String(port),
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:6006/v1/traces",
    });

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    expect(ctx.out.join("\n")).toContain(
      "Tracing: off; OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set, so start with pnpm serve:traced",
    );
  });

  it("says why tracing is off for an invalid endpoint, without echoing it", async () => {
    const port = await freePort();
    const ctx = context(repoRoot, {
      ELEVENLABS_WEBHOOK_SECRET: randomHex(),
      BOOKER_PORT: String(port),
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "phoenix-host:6006/v1/traces",
    });

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain(
      "Tracing: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an http(s) URL such as http://127.0.0.1:6006/v1/traces; tracing is off",
    );
    expect(printed).not.toContain("serve:traced");
    expect(printed).not.toContain("phoenix-host");
  });

  it("says tracing is off because OTEL_SDK_DISABLED is true", async () => {
    const port = await freePort();
    const ctx = context(repoRoot, {
      ELEVENLABS_WEBHOOK_SECRET: randomHex(),
      BOOKER_PORT: String(port),
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:6006/v1/traces",
      OTEL_SDK_DISABLED: "true",
    });

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain("Tracing: off; OTEL_SDK_DISABLED is true");
    expect(printed).not.toContain("serve:traced");
  });

  it("registers the server's own secrets for redaction from exported spans", async () => {
    const port = await freePort();
    const webhookSecret = randomHex();
    const ctx = context(repoRoot, {
      ELEVENLABS_WEBHOOK_SECRET: webhookSecret,
      BOOKER_PORT: String(port),
    });

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    expect(registeredSpanSecrets()).toEqual(
      expect.arrayContaining([
        readFileSync(voiceToolsKeyPath(repoRoot), "utf8"),
        readFileSync(controlTokenPath(repoRoot), "utf8"),
        webhookSecret,
      ]),
    );
  });

  it("reuses the key on a later start and stops on SIGINT", async () => {
    const port = await freePort();
    const env = { ELEVENLABS_WEBHOOK_SECRET: randomHex(), BOOKER_PORT: String(port) };
    const { key } = await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
    const ctx = context(repoRoot, env);

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    expect(ctx.out.join("\n")).toContain("Voice-tools key: .local/secrets/voice-tools-key");
    expect(readFileSync(voiceToolsKeyPath(repoRoot), "utf8")).toBe(key);
  });

  it("falls back to the webhook secret agent sync saved when the variable is unset", async () => {
    const port = await freePort();
    const secretPath = webhookSecretPath(repoRoot);
    mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
    const webhookSecret = randomHex();
    writeFileSync(secretPath, webhookSecret, { mode: 0o600 });
    const ctx = context(repoRoot, { BOOKER_PORT: String(port) });

    const { exited } = await startServe(ctx, port);
    ctx.signals.emit("SIGINT");

    expect(await exited).toBe(0);
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain(webhookSecret);
  });

  it("refuses a saved webhook secret other users can read", async () => {
    const secretPath = webhookSecretPath(repoRoot);
    mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
    writeFileSync(secretPath, randomHex(), { mode: 0o644 });
    const ctx = context(repoRoot, { BOOKER_PORT: String(await freePort()) });

    expect(await serveCommand.run([], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toContain(`chmod 600 ${secretPath}`);
  });

  it("refuses an invalid configuration before writing anything, naming each variable", async () => {
    const ctx = context(repoRoot, { BOOKER_HOST: "0.0.0.0", BOOKER_PORT: "eighty" });

    expect(await serveCommand.run([], ctx)).toBe(1);

    const printed = ctx.err.join("\n");
    expect(printed).toContain("BOOKER_HOST");
    expect(printed).toContain("BOOKER_PORT");
    expect(printed).not.toContain("0.0.0.0");
    expect(printed).not.toContain("eighty");
    expect(existsSync(join(repoRoot, ".local"))).toBe(false);
  });

  it("refuses a key file other users can read, without printing the key", async () => {
    const keyPath = voiceToolsKeyPath(repoRoot);
    const { key } = await ensureVoiceToolsKey(keyPath);
    chmodSync(keyPath, 0o644);
    const ctx = context(repoRoot, {
      ELEVENLABS_WEBHOOK_SECRET: randomHex(),
      BOOKER_PORT: String(await freePort()),
    });

    expect(await serveCommand.run([], ctx)).toBe(1);

    expect(ctx.err.join("\n")).toContain(`chmod 600 ${keyPath}`);
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain(key);
    expect(existsSync(join(repoRoot, ".local", "data"))).toBe(false);
  });

  it("reports a port that is already taken", async () => {
    const taken = await occupyPort();
    try {
      const ctx = context(repoRoot, {
        ELEVENLABS_WEBHOOK_SECRET: randomHex(),
        BOOKER_PORT: String(taken.port),
      });

      expect(await serveCommand.run([], ctx)).toBe(1);
      expect(ctx.err.join("\n")).toMatch(/Cannot start: .*EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => taken.server.close(() => resolve()));
    }
  });

  it("takes no arguments: its configuration comes from the environment", async () => {
    const ctx = context(repoRoot, { ELEVENLABS_WEBHOOK_SECRET: randomHex() });

    expect(await serveCommand.run(["--port", "9000"], ctx)).toBe(2);
    expect(ctx.err.join("\n")).toContain("docs/live-calls.md");
    expect(existsSync(join(repoRoot, ".local"))).toBe(false);
  });
});
