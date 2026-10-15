import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SpanKind } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { startCall } from "../src/calls/call.ts";
import { issueCallToken } from "../src/calls/call-token.ts";
import type { VoiceCallPort } from "../src/calls/voice-call-port.ts";
import { parseErrandBrief } from "../src/errands/brief.ts";
import { startTracing, type Tracing } from "../src/observability/tracing.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { SqliteCallStore } from "../src/persistence/sqlite-call-store.ts";
import { SqliteErrandStore } from "../src/persistence/sqlite-errand-store.ts";
import { createBookerApp } from "../src/server/apps.ts";
import { DATABASE_FILE_NAME, startBookerServer } from "../src/server/booker-server.ts";
import { LOOPBACK_HOST } from "../src/server/config.ts";
import type { BookerStores } from "../src/server/stores.ts";

const NOW = "2026-09-30T10:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const CALL_ID = "call-traced-northside";
const CONVERSATION_ID = "conv-traced";
const HARBOR_PHONE = "+15555550101";
const NORTHSIDE_PHONE = "+15555550100";
const QUOTE_TEXT = "We are right next to the old harbour market";
const TRANSCRIPT_TEXT = "My cousin lives on Elm Street, call him later";
// An inbound trace context with the sampled flag off: it must neither parent nor silence a span.
const UNSAMPLED_PARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00";

function secret(): string {
  return randomBytes(24).toString("base64url");
}

function brief() {
  const parsed = parseErrandBrief(drivingSchoolBrief);
  if (!parsed.ok) throw new Error(`invalid fixture brief: ${parsed.issues.join(", ")}`);
  return parsed.brief;
}

function sign(webhookSecret: string, rawBody: string): string {
  const digest = createHmac("sha256", webhookSecret)
    .update(`${NOW_SECONDS}.${rawBody}`)
    .digest("hex");
  return `t=${NOW_SECONDS},v0=${digest}`;
}

/** A stand-in for ElevenLabs on loopback, so outgoing requests are real `fetch` calls. */
async function startProvider(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"failed"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP port");
  return { server, url: `http://${LOOPBACK_HOST}:${address.port}` };
}

/** Everything a span would export, as one string to search for data that must never be there. */
function exported(span: ReadableSpan): string {
  return JSON.stringify([span.name, span.attributes, span.events, span.status, span.links]);
}

function byName(spans: readonly ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((span) => span.name === name);
}

const exporter = new InMemorySpanExporter();
let tracing: Tracing;
let provider: Awaited<ReturnType<typeof startProvider>>;

beforeAll(async () => {
  // No secrets are registered for redaction here: these spans must be clean by construction.
  tracing = startTracing({ serviceName: "booker-test", exporter, exportImmediately: true });
  provider = await startProvider();
});

afterAll(async () => {
  await tracing.shutdown();
  await new Promise((resolve) => provider.server.close(resolve));
});

afterEach(() => {
  exporter.reset();
});

describe("traced requests", () => {
  let root: string;
  let toolsKey: string;
  let webhookSecret: string;
  let controlToken: string;
  let elevenLabsKey: string;
  let callToken: string;
  let stores: BookerStores;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "booker-tracing-"));
    toolsKey = secret();
    webhookSecret = secret();
    controlToken = secret();
    elevenLabsKey = secret();
    stores = {
      calls: new InMemoryCallStore(),
      errands: new InMemoryErrandStore(),
      offers: new InMemoryOfferStore(),
      grants: new InMemoryCommitGrantStore(),
      bookings: new InMemoryBookingStore(),
      transcripts: new InMemoryTranscriptStore(),
      events: new InMemoryWebhookEventStore(),
    };
    await stores.errands.save(brief(), NOW);
    const issued = issueCallToken();
    callToken = issued.token;
    const call = startCall({
      id: CALL_ID,
      errandId: brief().id,
      providerId: "provider-northside",
      purpose: "quote",
      attempt: 1,
      tokenHash: issued.tokenHash,
      now: NOW,
    });
    await stores.calls.create({ ...call, status: "in_progress", externalId: CONVERSATION_ID });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function app() {
    const voice: VoiceCallPort = {
      async placeCall(input) {
        // The real port sends the number and the call token in the body; this one also puts the
        // number in the query, where a provider lookup could.
        const response = await fetch(
          `${provider.url}/v1/convai/twilio/outbound-call?to_number=${encodeURIComponent(input.phoneE164)}`,
          {
            method: "POST",
            headers: { "xi-api-key": elevenLabsKey, "Content-Type": "application/json" },
            body: JSON.stringify({ to: input.phoneE164, variables: input.dynamicVariables }),
          },
        );
        await response.text();
        return { externalId: "conv-placed", callSid: null };
      },
      async cancelCall() {},
    };
    return createBookerApp(stores, {
      toolsKey,
      webhookSecret,
      now: () => NOW,
      standingRules: () => ({ autoBookWithinRules: false }),
      control: {
        token: controlToken,
        errandRoot: join(root, ".local"),
        voice: async () => ({ ok: true, port: voice }),
      },
      tracing: true,
    });
  }

  function tool(path: string, body: object, headers: Record<string, string> = {}) {
    return app().request(`/voice-tools/${CALL_ID}/${path}`, {
      method: "POST",
      headers: { "X-Booker-Tools-Key": toolsKey, "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ call_token: callToken, ...body }),
    });
  }

  async function runSampleRequests(): Promise<string> {
    const responses: Response[] = [];
    responses.push(await tool("get-errand-context", {}, { traceparent: UNSAMPLED_PARENT }));
    responses.push(
      await tool("record-quote-field", {
        field: "location",
        value: "Harbour market",
        quote: QUOTE_TEXT,
        confirmed: true,
      }),
    );
    responses.push(await tool("request-commit-permission", {}));

    const rawBody = JSON.stringify({
      type: "post_call_transcription",
      event_timestamp: NOW_SECONDS,
      data: {
        conversation_id: CONVERSATION_ID,
        status: "done",
        transcript: [{ role: "user", message: TRANSCRIPT_TEXT, time_in_call_secs: 3 }],
      },
    });
    responses.push(
      await app().request("/webhooks/elevenlabs/post-call", {
        method: "POST",
        headers: { "ElevenLabs-Signature": sign(webhookSecret, rawBody) },
        body: rawBody,
      }),
    );

    mkdirSync(join(root, ".local", "errands"), { recursive: true });
    const errandFile = join(root, ".local", "errands", "test.json");
    writeFileSync(errandFile, JSON.stringify(drivingSchoolBrief));
    const placed = await app().request("/control/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${controlToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: HARBOR_PHONE, errandFile, purpose: "quote" }),
    });
    responses.push(placed);
    const { callId } = (await placed.clone().json()) as { callId: string };

    responses.push(
      await app().request(`/control/calls/${callId}`, {
        headers: { Authorization: `Bearer ${controlToken}` },
      }),
    );
    responses.push(await app().request("/healthz"));

    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 403, 200, 201, 200, 200,
    ]);
    await tracing.flush();
    return callId;
  }

  it("files every voice tool request under the call's session, with the tool's name and status", async () => {
    await runSampleRequests();
    const spans = exporter.getFinishedSpans();

    const request = byName(spans, "POST /voice-tools/:callId/get-errand-context")[0];
    expect(request?.attributes["session.id"]).toBe(CALL_ID);
    expect(request?.parentSpanContext).toBeUndefined();

    const tools = spans.filter((span) => span.attributes["openinference.span.kind"] === "TOOL");
    expect(
      tools.map((span) => [
        span.name,
        span.attributes["tool.name"],
        span.attributes["session.id"],
        span.attributes["booker.tool.status"],
      ]),
    ).toEqual([
      ["get_errand_context", "get_errand_context", CALL_ID, "ok"],
      ["record_quote_field", "record_quote_field", CALL_ID, "ok"],
      ["request_commit_permission", "request_commit_permission", CALL_ID, "forbidden"],
    ]);
    expect(tools[0]?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
  });

  it("files the post-call webhook and a placed call under their call's session", async () => {
    const placedCallId = await runSampleRequests();
    const spans = exporter.getFinishedSpans();

    const webhook = byName(spans, "POST /webhooks/elevenlabs/post-call")[0];
    expect(webhook?.attributes).toMatchObject({
      "session.id": CALL_ID,
      "booker.webhook.event": "post_call_transcription",
    });

    const placement = byName(spans, "POST /control/calls")[0];
    expect(placement?.attributes["session.id"]).toBe(placedCallId);
    const outgoing = spans.find(
      (span) => span.parentSpanContext?.spanId === placement?.spanContext().spanId,
    );
    expect(outgoing?.name).toBe(`POST ${new URL(provider.url).host}`);
    expect(outgoing?.attributes["url.full"]).toBe(`${provider.url}/v1/convai/twilio/outbound-call`);
  });

  it("traces only the voice tools, the webhook, and call placement", async () => {
    await runSampleRequests();

    const servers = exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);
    expect(servers.map((span) => span.name)).toEqual([
      "POST /voice-tools/:callId/get-errand-context",
      "POST /voice-tools/:callId/record-quote-field",
      "POST /voice-tools/:callId/request-commit-permission",
      "POST /webhooks/elevenlabs/post-call",
      "POST /control/calls",
    ]);
  });

  it("leaves a request it cannot authenticate out of every session", async () => {
    const response = await tool("get-errand-context", {}, { "X-Booker-Tools-Key": secret() });
    await tracing.flush();

    expect(response.status).toBe(401);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes["http.response.status_code"]).toBe(401);
    expect(spans[0]?.attributes).not.toHaveProperty("session.id");
  });

  it("never exports a key, a token, a secret, a phone number, or what anyone said", async () => {
    await runSampleRequests();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(9);

    const forbidden = [
      toolsKey,
      webhookSecret,
      controlToken,
      elevenLabsKey,
      callToken,
      HARBOR_PHONE.slice(1),
      NORTHSIDE_PHONE.slice(1),
      QUOTE_TEXT,
      TRANSCRIPT_TEXT,
    ];
    for (const span of spans) {
      for (const value of forbidden) expect(exported(span)).not.toContain(value);
    }
  });
});

describe("traced reconciliation", () => {
  it("files each stale call it checks with the provider under that call's session", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "booker-tracing-server-"));
    const ticks: (() => void)[] = [];
    const server = await startBookerServer({
      host: LOOPBACK_HOST,
      port: 0,
      dataDir,
      toolsKey: secret(),
      webhookSecret: secret(),
      log: () => {},
      now: () => "2026-09-30T10:10:00.000Z",
      startTimer: (callback) => {
        ticks.push(callback);
        return { unref: () => {}, cancel: () => {} };
      },
      tracing: true,
      control: {
        token: secret(),
        errandRoot: join(dataDir, "errands"),
        voice: async () => ({ ok: false, reason: "not configured in this test" }),
        reconcile: {
          providerReportsFailure: async (externalId) => {
            const response = await fetch(`${provider.url}/v1/convai/conversations/${externalId}`);
            return ((await response.json()) as { status: string }).status === "failed";
          },
        },
      },
    });
    try {
      const db = openDatabase(pathToFileURL(join(dataDir, DATABASE_FILE_NAME)).href);
      try {
        await new SqliteErrandStore(db).save(brief(), NOW);
        const call = startCall({
          id: CALL_ID,
          errandId: brief().id,
          providerId: "provider-northside",
          purpose: "quote",
          attempt: 1,
          tokenHash: issueCallToken().tokenHash,
          now: NOW,
        });
        await new SqliteCallStore(db).create({
          ...call,
          status: "in_progress",
          externalId: CONVERSATION_ID,
        });
      } finally {
        db.$client.close();
      }

      for (const tick of ticks) tick();
      await vi.waitFor(async () => {
        await tracing.flush();
        expect(byName(exporter.getFinishedSpans(), "reconcile call")).toHaveLength(1);
      });

      const spans = exporter.getFinishedSpans();
      const check = byName(spans, "reconcile call")[0];
      expect(check?.attributes).toEqual({
        "session.id": CALL_ID,
        "booker.provider_reports_failure": true,
      });
      const lookup = spans.find(
        (span) => span.parentSpanContext?.spanId === check?.spanContext().spanId,
      );
      expect(lookup?.attributes["url.path"]).toBe(`/v1/convai/conversations/${CONVERSATION_ID}`);
    } finally {
      await server.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
