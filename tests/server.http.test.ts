import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import drivingSchoolBrief from "../examples/errands/driving-school.example.json" with {
  type: "json",
};
import { startCall } from "../src/calls/call.ts";
import { issueCallToken } from "../src/calls/call-token.ts";
import { parseErrandBrief } from "../src/errands/brief.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { SqliteCallStore } from "../src/persistence/sqlite-call-store.ts";
import { SqliteErrandStore } from "../src/persistence/sqlite-errand-store.ts";
import {
  DATABASE_FILE_NAME,
  type RunningBookerServer,
  startBookerServer,
} from "../src/server/booker-server.ts";
import { LOOPBACK_HOST } from "../src/server/config.ts";
import { listen } from "../src/server/http-server.ts";

const NOW = "2026-09-30T10:00:00.000Z";
const CALL_ID = "call-quote-northside";

function randomHex(): string {
  return randomBytes(24).toString("hex");
}

/** Signs `rawBody` the way ElevenLabs does: HMAC-SHA256 over `<timestamp>.<rawBody>`. */
function sign(secret: string, rawBody: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v0=${digest}`;
}

/** Resolves once a TCP connection to `port` opens; rejects when it is refused. */
function connect(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Seeds the driving-school errand and one open quote call through a second database handle. */
async function seedQuoteCall(dataDir: string): Promise<string> {
  const db = openDatabase(pathToFileURL(join(dataDir, DATABASE_FILE_NAME)).href);
  try {
    const parsed = parseErrandBrief(drivingSchoolBrief);
    if (!parsed.ok) throw new Error(`invalid fixture brief: ${parsed.issues.join(", ")}`);
    await new SqliteErrandStore(db).save(parsed.brief, NOW);
    const { token, tokenHash } = issueCallToken();
    const created = await new SqliteCallStore(db).create(
      startCall({
        id: CALL_ID,
        errandId: parsed.brief.id,
        providerId: "provider-northside",
        purpose: "quote",
        attempt: 1,
        tokenHash,
        now: NOW,
      }),
    );
    if (!created.ok) throw new Error(`could not seed the call: ${created.reason}`);
    return token;
  } finally {
    db.$client.close();
  }
}

describe("the Booker server over a real socket", () => {
  let dataDir: string;
  let toolsKey: string;
  let webhookSecret: string;
  let lines: string[];
  let server: RunningBookerServer;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "booker-server-"));
    toolsKey = randomHex();
    webhookSecret = randomHex();
    lines = [];
    server = await startBookerServer({
      host: LOOPBACK_HOST,
      port: 0,
      dataDir,
      toolsKey,
      webhookSecret,
      log: (line) => lines.push(line),
    });
  });

  afterEach(async () => {
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function postTool(callId: string, key: string, body: object): Promise<Response> {
    return fetch(`${server.url}/voice-tools/${callId}/get-errand-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Booker-Tools-Key": key },
      body: JSON.stringify(body),
    });
  }

  function postWebhook(rawBody: string, signature: string): Promise<Response> {
    return fetch(`${server.url}/webhooks/elevenlabs/post-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ElevenLabs-Signature": signature },
      body: rawBody,
    });
  }

  it("listens on 127.0.0.1 and answers GET /healthz with 200 and no data", async () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);

    const response = await fetch(`${server.url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("migrates its SQLite database inside the data directory", () => {
    expect(existsSync(join(dataDir, DATABASE_FILE_NAME))).toBe(true);
  });

  it("answers a voice tool with a wrong X-Booker-Tools-Key with 401", async () => {
    const token = await seedQuoteCall(dataDir);

    const response = await postTool(CALL_ID, `${toolsKey}0`, { call_token: token });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("serves a voice tool with the right key and call token from the SQLite stores", async () => {
    const token = await seedQuoteCall(dataDir);

    const response = await postTool(CALL_ID, toolsKey, { call_token: token });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ objective: drivingSchoolBrief.objective });
  });

  it("answers a post-call webhook with a bad signature with 401", async () => {
    const rawBody = JSON.stringify({
      type: "post_call_transcription",
      event_timestamp: Math.floor(Date.now() / 1000),
      data: { conversation_id: "conv-unknown" },
    });

    const response = await postWebhook(rawBody, sign(randomHex(), rawBody));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("verifies post-call webhooks with the configured secret", async () => {
    const rawBody = JSON.stringify({
      type: "call_initiation_failure",
      event_timestamp: Math.floor(Date.now() / 1000),
      data: { conversation_id: "conv-unknown" },
    });

    const response = await postWebhook(rawBody, sign(webhookSecret, rawBody));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unknown_conversation" });
  });

  it("logs one line per request, never a key, call token, or signature", async () => {
    const token = await seedQuoteCall(dataDir);
    const rawBody = JSON.stringify({ type: "x", event_timestamp: 1, data: {} });
    const signature = sign(randomHex(), rawBody);

    await fetch(`${server.url}/healthz?probe=${token}`);
    await postTool(CALL_ID, toolsKey, { call_token: token });
    await postWebhook(rawBody, signature);

    expect(lines).toEqual([
      expect.stringMatching(/^GET \/healthz 200 \d+ms$/),
      expect.stringMatching(
        /^POST \/voice-tools\/call-quote-northside\/get-errand-context 200 \d+ms$/,
      ),
      expect.stringMatching(/^POST \/webhooks\/elevenlabs\/post-call 401 \d+ms$/),
    ]);
    const logged = lines.join("\n");
    for (const value of [toolsKey, webhookSecret, token, signature]) {
      expect(logged).not.toContain(value);
    }
  });

  it("stops listening when closed, and closing twice is harmless", async () => {
    const port = server.port;

    await server.close();
    await server.close();

    await expect(connect(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});

describe("the Booker server's control routes and reconciliation", () => {
  it("serves the control routes behind the control token, and ends a stale failed call on a tick", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "booker-server-"));
    const controlToken = randomBytes(32).toString("base64url");
    const ticks: (() => void)[] = [];
    const looked: string[] = [];
    const server = await startBookerServer({
      host: LOOPBACK_HOST,
      port: 0,
      dataDir,
      toolsKey: randomHex(),
      webhookSecret: randomHex(),
      log: () => {},
      now: () => "2026-09-30T10:10:00.000Z",
      startTimer: (callback) => {
        ticks.push(callback);
        return { unref: () => {}, cancel: () => {} };
      },
      control: {
        token: controlToken,
        errandRoot: join(dataDir, "errands"),
        voice: async () => ({ ok: false, reason: "not configured in this test" }),
        reconcile: {
          staleAfterMs: 5 * 60_000,
          providerReportsFailure: async (externalId) => {
            looked.push(externalId);
            return true;
          },
        },
      },
    });
    try {
      await seedQuoteCall(dataDir);
      const db = openDatabase(pathToFileURL(join(dataDir, DATABASE_FILE_NAME)).href);
      try {
        const calls = new SqliteCallStore(db);
        const call = await calls.findById(CALL_ID);
        if (call === undefined) throw new Error("expected the seeded call");
        await calls.update({ ...call, status: "in_progress", externalId: "conv-stale" });
      } finally {
        db.$client.close();
      }

      const anonymous = await fetch(`${server.url}/control/calls/${CALL_ID}`);
      expect(anonymous.status).toBe(401);

      for (const tick of ticks) tick();
      await vi.waitFor(async () => {
        const response = await fetch(`${server.url}/control/calls/${CALL_ID}`, {
          headers: { Authorization: `Bearer ${controlToken}` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "no_answer" });
      });
      expect(looked).toEqual(["conv-stale"]);
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("startBookerServer when the transcript purge cannot be scheduled", () => {
  it("stops listening before it reports the failure", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "booker-server-"));
    const probe = await listen(() => new Response(), { host: LOOPBACK_HOST, port: 0 });
    const port = probe.port;
    await probe.close();
    try {
      await expect(
        startBookerServer({
          host: LOOPBACK_HOST,
          port,
          dataDir,
          toolsKey: randomHex(),
          webhookSecret: randomHex(),
          log: () => {},
          startTimer: () => {
            throw new Error("no timers left");
          },
        }),
      ).rejects.toThrow("no timers left");

      await expect(connect(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("listen", () => {
  it("lets an in-flight request finish while it refuses new connections", async () => {
    const entered = deferred();
    const release = deferred();
    const app = new Hono();
    app.get("/slow", async (c) => {
      entered.resolve();
      await release.promise;
      return c.text("done");
    });
    const server = await listen((request) => app.fetch(request), { host: LOOPBACK_HOST, port: 0 });

    const pending = fetch(`http://127.0.0.1:${server.port}/slow`);
    await entered.promise;
    let closed = false;
    const closing = server.close(5_000).then(() => {
      closed = true;
    });

    await expect(connect(server.port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(closed).toBe(false);
    const released = performance.now();
    release.resolve();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("done");
    await closing;
    expect(closed).toBe(true);
    // The finished request's keep-alive connection must not hold the shutdown open.
    expect(performance.now() - released).toBeLessThan(1_000);
  });

  it("cuts a request that is still running when the grace period ends", async () => {
    const entered = deferred();
    const release = deferred();
    const app = new Hono();
    app.get("/stuck", async (c) => {
      entered.resolve();
      await release.promise;
      return c.text("too late");
    });
    const server = await listen((request) => app.fetch(request), { host: LOOPBACK_HOST, port: 0 });

    const outcome = fetch(`http://127.0.0.1:${server.port}/stuck`).then(
      () => "answered",
      () => "cut",
    );
    await entered.promise;
    await server.close(50);

    expect(await outcome).toBe("cut");
    release.resolve();
  });

  it("refuses to start on a port that is already taken", async () => {
    const app = new Hono();
    const first = await listen((request) => app.fetch(request), { host: LOOPBACK_HOST, port: 0 });
    try {
      await expect(
        listen((request) => app.fetch(request), { host: LOOPBACK_HOST, port: first.port }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});
