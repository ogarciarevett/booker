import { randomBytes } from "node:crypto";
import { type HrTime, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { resources } from "@opentelemetry/sdk-node";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  addSpanSecrets,
  REDACTED,
  redactingExporter,
  redactSpan,
  registeredSpanSecrets,
  secretsFromEnvironment,
} from "./redaction.ts";

/** Generated at run time, so no credential-shaped literal is ever committed. */
function fakeSecret(): string {
  return randomBytes(16).toString("base64url");
}

const KEY = fakeSecret();
const TOKEN = fakeSecret();
const T0: HrTime = [1_790_000_000, 0];
const T1: HrTime = [1_790_000_001, 0];
const CONTEXT = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };

function span(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    name: "POST /voice-tools/:callId/get-errand-context",
    kind: SpanKind.SERVER,
    spanContext: () => CONTEXT,
    startTime: T0,
    endTime: T1,
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    links: [],
    events: [],
    duration: [1, 0],
    ended: true,
    resource: resources.resourceFromAttributes({ "service.name": "booker" }),
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    ...overrides,
  };
}

describe("redactSpan", () => {
  it("drops headers and query strings, and strips URLs to their origin and path", () => {
    const redacted = redactSpan(
      span({
        attributes: {
          "url.full": "https://user:pass@api.example.com/v1/numbers?phone=%2B15550100123#top",
          "http.url": "http://127.0.0.1:8787/control/calls?token=abc",
          "http.target": "/v1/numbers?phone=%2B15550100123",
          "url.query": "?phone=%2B15550100123",
          "url.path": "/v1/numbers",
          "http.request.header.authorization": ["Bearer abc"],
          "http.response.header.set-cookie": ["session=abc"],
          "http.response.status_code": 200,
        },
      }),
      [],
    );

    expect(redacted.attributes).toEqual({
      "url.full": "https://api.example.com/v1/numbers",
      "http.url": "http://127.0.0.1:8787/control/calls",
      "http.target": "/v1/numbers",
      "url.path": "/v1/numbers",
      "http.response.status_code": 200,
    });
  });

  it("replaces every secret in names, attribute values, statuses, events, and links", () => {
    const redacted = redactSpan(
      span({
        name: `lookup ${KEY}`,
        attributes: { note: `key=${KEY}`, list: ["ok", `token ${TOKEN}`], count: 3 },
        status: { code: SpanStatusCode.ERROR, message: `failed with ${TOKEN}` },
        events: [{ name: "note", time: T0, attributes: { detail: `saw ${KEY}` } }],
        links: [{ context: CONTEXT, attributes: { detail: `saw ${TOKEN}` } }],
      }),
      [KEY, TOKEN],
    );

    expect(redacted.name).toBe(`lookup ${REDACTED}`);
    expect(redacted.attributes).toEqual({
      note: `key=${REDACTED}`,
      list: ["ok", `token ${REDACTED}`],
      count: 3,
    });
    expect(redacted.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: `failed with ${REDACTED}`,
    });
    expect(redacted.events[0]?.attributes).toEqual({ detail: `saw ${REDACTED}` });
    expect(redacted.links[0]?.attributes).toEqual({ detail: `saw ${REDACTED}` });
  });

  it("keeps an exception's type, the first line of its message, and its stack frames only", () => {
    const redacted = redactSpan(
      span({
        status: { code: SpanStatusCode.ERROR, message: "Failed query: insert\nparams: secret" },
        events: [
          {
            name: "exception",
            time: T0,
            attributes: {
              "exception.type": "DrizzleQueryError",
              "exception.message": "Failed query: insert into calls\nparams: call-1,transcript",
              "exception.stacktrace": [
                "DrizzleQueryError: Failed query: insert into calls",
                "params: call-1,transcript",
                "    at SqliteCallStore.update (src/persistence/sqlite-call-store.ts:40:11)",
                "    at async handler (src/http/voice-tools.ts:12:3)",
              ].join("\n"),
            },
          },
        ],
      }),
      [],
    );

    expect(redacted.status.message).toBe("Failed query: insert");
    expect(redacted.events[0]?.attributes).toEqual({
      "exception.type": "DrizzleQueryError",
      "exception.message": "Failed query: insert into calls",
      "exception.stacktrace": [
        "DrizzleQueryError: Failed query: insert into calls",
        "    at SqliteCallStore.update (src/persistence/sqlite-call-store.ts:40:11)",
        "    at async handler (src/http/voice-tools.ts:12:3)",
      ].join("\n"),
    });
  });

  it("ignores secrets too short to redact safely and leaves the span's identity alone", () => {
    const original = span({ attributes: { method: "POST" } });
    const redacted = redactSpan(original, ["POST", ""]);

    expect(redacted.attributes).toEqual({ method: "POST" });
    expect(redacted.spanContext()).toEqual(CONTEXT);
    expect(redacted.parentSpanContext).toBeUndefined();
    expect([redacted.kind, redacted.startTime, redacted.endTime]).toEqual([
      SpanKind.SERVER,
      T0,
      T1,
    ]);
    expect(redacted.resource).toBe(original.resource);
  });
});

describe("redactingExporter", () => {
  it("exports redacted copies and forwards flush and shutdown", async () => {
    const exported: ReadableSpan[][] = [];
    const calls: string[] = [];
    const inner: SpanExporter = {
      export(spans, done) {
        exported.push(spans);
        done({ code: 0 });
      },
      async shutdown() {
        calls.push("shutdown");
      },
      async forceFlush() {
        calls.push("flush");
      },
    };
    const exporter = redactingExporter(inner, () => [KEY]);

    const result = await new Promise((resolve) =>
      exporter.export([span({ attributes: { note: KEY } })], resolve),
    );
    await exporter.forceFlush?.();
    await exporter.shutdown();

    expect(result).toEqual({ code: 0 });
    expect(exported[0]?.[0]?.attributes).toEqual({ note: REDACTED });
    expect(calls).toEqual(["flush", "shutdown"]);
  });
});

describe("span secrets", () => {
  it("takes the values of key, token, secret, and password variables from the environment", () => {
    const [apiKey, authToken, webhookSecret, password] = [1, 2, 3, 4].map(fakeSecret);
    expect(
      secretsFromEnvironment({
        ELEVENLABS_API_KEY: apiKey,
        TWILIO_AUTH_TOKEN: authToken,
        ELEVENLABS_WEBHOOK_SECRET: webhookSecret,
        DB_PASSWORD: password,
        TWILIO_ACCOUNT_SID: "AC-not-a-secret",
        BOOKER_PORT: "8787",
        EMPTY_TOKEN: "",
        UNSET_KEY: undefined,
      }),
    ).toEqual([apiKey, authToken, webhookSecret, password]);
  });

  it("remembers secrets the server registers after it starts", () => {
    addSpanSecrets(KEY, "", TOKEN);
    expect(registeredSpanSecrets()).toEqual(expect.arrayContaining([KEY, TOKEN]));
    expect(registeredSpanSecrets()).not.toContain("");
  });
});
