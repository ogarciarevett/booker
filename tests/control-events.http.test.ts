import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import drivingSchoolBrief from "../examples/errands/driving-school.example.json" with {
  type: "json",
};
import {
  InMemoryBookingStore,
  InMemoryCommitGrantStore,
} from "../src/bookings/adapters/in-memory.ts";
import { InMemoryCallStore } from "../src/calls/adapters/in-memory-call-store.ts";
import { InMemoryErrandStore } from "../src/calls/adapters/in-memory-errand-store.ts";
import { InMemoryOfferStore } from "../src/calls/adapters/in-memory-offer-store.ts";
import { InMemoryTranscriptStore } from "../src/calls/adapters/in-memory-transcript-store.ts";
import { InMemoryWebhookEventStore } from "../src/calls/adapters/in-memory-webhook-events.ts";
import { InProcessActivityFeed } from "../src/calls/adapters/in-process-activity-feed.ts";
import type { VoiceCallPort } from "../src/calls/voice-call-port.ts";
import type { ControlActivity } from "../src/http/control.ts";
import { createBookerApp } from "../src/server/apps.ts";
import { startBookerServer } from "../src/server/booker-server.ts";
import { LOOPBACK_HOST } from "../src/server/config.ts";
import type { BookerStores } from "../src/server/stores.ts";
import { InMemorySecretStore } from "../src/settings/adapters/in-memory-secret-store.ts";
import { InMemorySettingStore } from "../src/settings/adapters/in-memory-setting-store.ts";
import { createSettingsResolver } from "../src/settings/resolver.ts";

const NOW = "2026-10-06T10:00:00.000Z";
const NORTHSIDE_PHONE = "+15555550100";

interface ServerSentEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/** Reads a `text/event-stream` body block by block: events, and comments apart. */
function eventReader(response: Response) {
  const body = response.body;
  if (body === null) throw new Error("expected a streamed body");
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  /** The next block, or `undefined` once the stream ends. */
  async function nextBlock(): Promise<string[] | undefined> {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return block.split("\n");
      }
      const { done, value } = await reader.read();
      if (done) return undefined;
      buffer += value;
    }
  }

  /** The next event, skipping comments, or `undefined` once the stream ends. */
  async function next(): Promise<ServerSentEvent | undefined> {
    for (;;) {
      const lines = await nextBlock();
      if (lines === undefined) return undefined;
      const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
      if (data.length === 0) continue;
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
      return { event, data: data.join("\n") };
    }
  }

  /** The next comment line, skipping events, or `undefined` once the stream ends. */
  async function nextComment(): Promise<string | undefined> {
    for (;;) {
      const lines = await nextBlock();
      if (lines === undefined) return undefined;
      const comment = lines.find((line) => line.startsWith(":"));
      if (comment !== undefined) return comment;
    }
  }

  return { next, nextComment, cancel: () => reader.cancel() };
}

describe("GET /control/events", () => {
  let root: string;
  let token: string;
  let toolsKey: string;
  let feed: InProcessActivityFeed<ControlActivity>;
  let stores: BookerStores;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "booker-events-"));
    token = randomBytes(32).toString("base64url");
    toolsKey = randomBytes(24).toString("hex");
    feed = new InProcessActivityFeed<ControlActivity>();
    stores = {
      calls: new InMemoryCallStore(),
      errands: new InMemoryErrandStore(),
      offers: new InMemoryOfferStore(),
      grants: new InMemoryCommitGrantStore(),
      bookings: new InMemoryBookingStore(),
      transcripts: new InMemoryTranscriptStore(),
      events: new InMemoryWebhookEventStore(),
    };
  });

  afterEach(() => {
    feed.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** The call token each placed call was given, as the voice agent would receive it. */
  const callTokens = new Map<string, string>();

  /** Settings in memory, served on the same app as the event stream. */
  const settingValues = new InMemorySettingStore();
  const settingSecrets = new InMemorySecretStore();

  function app(eventsKeepAliveMs?: number) {
    const voice: VoiceCallPort = {
      async placeCall(input) {
        callTokens.set(input.call.id, input.dynamicVariables.call_token);
        return { externalId: "conv-001", callSid: null };
      },
      async cancelCall() {},
    };
    return createBookerApp(stores, {
      toolsKey,
      webhookSecret: randomBytes(24).toString("hex"),
      now: () => NOW,
      standingRules: () => ({ autoBookWithinRules: false }),
      activity: feed,
      control: {
        token,
        errandRoot: join(root, ".local"),
        voice: async () => ({ ok: true, port: voice }),
        settings: {
          resolver: createSettingsResolver({
            env: {},
            values: settingValues,
            secrets: settingSecrets,
          }),
          values: settingValues,
          secrets: settingSecrets,
          atStart: new Map(),
        },
        ...(eventsKeepAliveMs === undefined ? {} : { eventsKeepAliveMs }),
      },
    });
  }

  function subscribe(bearer: string | null = token, eventsKeepAliveMs?: number) {
    const headers = new Headers();
    if (bearer !== null) headers.set("Authorization", `Bearer ${bearer}`);
    return Promise.resolve(app(eventsKeepAliveMs).request("/control/events", { headers }));
  }

  it("answers 401 without the control token and subscribes no one", async () => {
    const responses = await Promise.all([subscribe(null), subscribe(`${token}x`), subscribe("")]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(feed.subscriberCount()).toBe(0);
  });

  it("streams call status changes and tool activity as they happen, and nothing else", async () => {
    const response = await subscribe();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    const events = eventReader(response);
    expect(await events.next()).toEqual({ event: "ready", data: "{}" });

    mkdirSync(join(root, ".local", "errands"), { recursive: true });
    const errandFile = join(root, ".local", "errands", "test.json");
    writeFileSync(errandFile, JSON.stringify(drivingSchoolBrief));
    const placed = await app().request("/control/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: NORTHSIDE_PHONE, errandFile, purpose: "quote" }),
    });
    const { callId } = (await placed.json()) as { callId: string };
    const tool = (path: string, body: object) =>
      app().request(`/voice-tools/${callId}/${path}`, {
        method: "POST",
        headers: { "X-Booker-Tools-Key": toolsKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    // Unauthenticated: answered 401 and reported to no one.
    expect((await tool("get-errand-context", { call_token: "not the call's token" })).status).toBe(
      401,
    );
    const callToken = callTokens.get(callId) ?? "";
    expect((await tool("get-errand-context", { call_token: callToken })).status).toBe(200);
    expect((await tool("record-quote-field", { call_token: callToken, field: "x" })).status).toBe(
      422,
    );

    const received = [];
    for (let index = 0; index < 4; index += 1) received.push(await events.next());
    expect(received.map((event) => [event?.event, JSON.parse(event?.data ?? "null")])).toEqual([
      ["call_status", { type: "call_status", callId, status: "scheduled", at: NOW }],
      ["call_status", { type: "call_status", callId, status: "in_progress", at: NOW }],
      ["tool", { type: "tool", callId, tool: "get_errand_context", outcome: "ok", at: NOW }],
      [
        "tool",
        { type: "tool", callId, tool: "record_quote_field", outcome: "invalid_request", at: NOW },
      ],
    ]);
    expect(JSON.stringify(received)).not.toContain(callToken);
    await events.cancel();
  });

  it("streams a setting event when a setting is saved or removed, never its value", async () => {
    const response = await subscribe();
    const events = eventReader(response);
    expect(await events.next()).toEqual({ event: "ready", data: "{}" });
    const secret = randomBytes(16).toString("hex");
    const change = (method: string, name: string, body?: object) =>
      app().request(`/control/settings/${name}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    expect((await change("PUT", "ELEVENLABS_API_KEY", { value: secret })).status).toBe(200);
    expect((await change("DELETE", "ELEVENLABS_API_KEY")).status).toBe(200);

    const saved = await events.next();
    const removed = await events.next();
    expect(saved?.event).toBe("setting");
    expect(JSON.parse(saved?.data ?? "")).toEqual({
      type: "setting",
      name: "ELEVENLABS_API_KEY",
      action: "saved",
      at: NOW,
    });
    expect(JSON.parse(removed?.data ?? "")).toMatchObject({ action: "removed" });
    expect(`${saved?.data}${removed?.data}`).not.toContain(secret);
    await events.cancel();
  });

  it("stops listening when the client goes away", async () => {
    const events = eventReader(await subscribe());
    await events.next();
    expect(feed.subscriberCount()).toBe(1);

    await events.cancel();

    await vi.waitFor(() => expect(feed.subscriberCount()).toBe(0));
  });

  it("ends the stream when the feed closes, so the server can stop", async () => {
    const events = eventReader(await subscribe());
    await events.next();

    feed.close();

    expect(await events.next()).toBeUndefined();
  });

  it("drops a client that stops reading once too many events are waiting for it", async () => {
    const stalled = await subscribe();
    expect(feed.subscriberCount()).toBe(1);

    for (let index = 0; index < 300; index += 1) {
      feed.report({
        type: "tool",
        callId: "call-1",
        tool: "get_errand_context",
        outcome: "ok",
        at: NOW,
      });
    }

    await vi.waitFor(() => expect(feed.subscriberCount()).toBe(0));
    // The stream ends instead of holding every queued event for a reader that never comes.
    const delivered = (await stalled.text()).split("event: tool").length - 1;
    expect(delivered).toBeLessThan(300);
  });

  it("keeps a client that reads through a burst of events", async () => {
    const events = eventReader(await subscribe());
    await events.next();

    for (let index = 0; index < 50; index += 1) {
      feed.report({
        type: "tool",
        callId: `call-${index}`,
        tool: "get_errand_context",
        outcome: "ok",
        at: NOW,
      });
    }
    const received = [];
    for (let index = 0; index < 50; index += 1) received.push(await events.next());

    expect(received.map((event) => JSON.parse(event?.data ?? "{}").callId)).toEqual(
      Array.from({ length: 50 }, (_, index) => `call-${index}`),
    );
    expect(feed.subscriberCount()).toBe(1);
    await events.cancel();
  });

  it("ends a stream opened after the feed closed, cleanly and without an error", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      feed.close();

      const response = await subscribe();
      const events = eventReader(response);

      expect(response.status).toBe(200);
      expect(await events.next()).toBeUndefined();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("sends a keep-alive comment while nothing happens, so proxies keep the stream open", async () => {
    const events = eventReader(await subscribe(token, 10));
    await events.next();

    expect(await events.nextComment()).toBe(": keep-alive");
    await events.cancel();
  });
});

describe("the server with an open event stream", () => {
  it("ends the stream and stops without waiting out the shutdown grace", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "booker-events-server-"));
    const token = randomBytes(32).toString("base64url");
    const server = await startBookerServer({
      host: LOOPBACK_HOST,
      port: 0,
      dataDir,
      toolsKey: randomBytes(24).toString("hex"),
      webhookSecret: randomBytes(24).toString("hex"),
      log: () => {},
      shutdownGraceMs: 5_000,
      control: {
        token,
        errandRoot: join(dataDir, "errands"),
        voice: async () => ({ ok: false, reason: "not configured in this test" }),
      },
    });
    try {
      const response = await fetch(`${server.url}/control/events`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const events = eventReader(response);
      expect(await events.next()).toEqual({ event: "ready", data: "{}" });

      const started = performance.now();
      await server.close();

      expect(performance.now() - started).toBeLessThan(2_000);
      expect(await events.next()).toBeUndefined();
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
