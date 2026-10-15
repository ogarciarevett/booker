import type { Attributes, AttributeValue, Link, SpanStatus } from "@opentelemetry/api";
import type { ReadableSpan, SpanExporter, TimedEvent } from "@opentelemetry/sdk-trace-base";
import { isCredentialName } from "../shared/credential-names.ts";

export const REDACTED = "[redacted]";

/** Shorter values are not treated as secrets: replacing them would mangle ordinary text. */
const MIN_SECRET_LENGTH = 8;
/** Attributes that hold a full URL: kept as origin and path only. */
const URL_ATTRIBUTES = new Set(["url.full", "http.url"]);
/** Attributes that hold a path that may carry a query string. */
const TARGET_ATTRIBUTES = new Set(["http.target"]);
const DROPPED_ATTRIBUTES = new Set(["url.query"]);
const DROPPED_PREFIXES = ["http.request.header.", "http.response.header."];
const STACK_FRAME = /^\s+at\s/;

function firstLine(text: string): string {
  return text.split(/\r\n|\r|\n/u, 1)[0] ?? "";
}

function redactText(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) result = result.replaceAll(secret, REDACTED);
  }
  return result;
}

function withoutQuery(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/u, 1)[0] ?? "";
  }
}

/** The first line of the message (later lines are where data goes) and the stack frames. */
function stackFramesOnly(stack: string): string {
  const [first = "", ...rest] = stack.split(/\r\n|\r|\n/u);
  return [first, ...rest.filter((line) => STACK_FRAME.test(line))].join("\n");
}

function redactValue(key: string, value: AttributeValue, secrets: readonly string[]) {
  if (typeof value === "string") {
    let text = value;
    if (URL_ATTRIBUTES.has(key)) text = withoutQuery(text);
    else if (TARGET_ATTRIBUTES.has(key)) text = text.split(/[?#]/u, 1)[0] ?? "";
    else if (key === "exception.message") text = firstLine(text);
    else if (key === "exception.stacktrace") text = stackFramesOnly(text);
    return redactText(text, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? redactText(item, secrets) : item));
  }
  return value;
}

function redactAttributes(attributes: Attributes, secrets: readonly string[]): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || DROPPED_ATTRIBUTES.has(key)) continue;
    if (DROPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    result[key] = redactValue(key, value, secrets) as AttributeValue;
  }
  return result;
}

function redactStatus(status: SpanStatus, secrets: readonly string[]): SpanStatus {
  return status.message === undefined
    ? status
    : { ...status, message: redactText(firstLine(status.message), secrets) };
}

function redactEvent(event: TimedEvent, secrets: readonly string[]): TimedEvent {
  return event.attributes === undefined
    ? event
    : { ...event, attributes: redactAttributes(event.attributes, secrets) };
}

function redactLink(link: Link, secrets: readonly string[]): Link {
  return link.attributes === undefined
    ? link
    : { ...link, attributes: redactAttributes(link.attributes, secrets) };
}

/**
 * A copy of `span` that is safe to leave this machine's process: no request or response headers,
 * no query strings (an ElevenLabs lookup can carry a phone number there), URLs cut to their
 * origin and path, exception messages cut to their first line and stack traces to their frames
 * (a database error lists the query's parameters on later lines), and every `secrets` value
 * replaced with `[redacted]` wherever it still appears.
 */
export function redactSpan(span: ReadableSpan, secrets: readonly string[]): ReadableSpan {
  return {
    name: redactText(span.name, secrets),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext === undefined ? {} : { parentSpanContext: span.parentSpanContext }),
    startTime: span.startTime,
    endTime: span.endTime,
    status: redactStatus(span.status, secrets),
    attributes: redactAttributes(span.attributes, secrets),
    links: span.links.map((link) => redactLink(link, secrets)),
    events: span.events.map((event) => redactEvent(event, secrets)),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Wraps `inner` so it only ever receives redacted spans; `secrets` is read at each export. */
export function redactingExporter(
  inner: SpanExporter,
  secrets: () => readonly string[],
): SpanExporter {
  return {
    export(spans, done) {
      const current = secrets();
      inner.export(
        spans.map((span) => redactSpan(span, current)),
        done,
      );
    },
    shutdown: () => inner.shutdown(),
    forceFlush: async () => {
      await inner.forceFlush?.();
    },
  };
}

/** The values of `*_KEY`, `*_TOKEN`, `*_SECRET`, and `*_PASSWORD` variables, for redaction. */
export function secretsFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    isCredentialName(name) && value !== undefined && value !== "" ? [value] : [],
  );
}

const registered = new Set<string>();

/**
 * Adds secrets that only exist once the server starts (the voice-tools key, the control token, a
 * saved webhook secret), so spans exported later never carry them either.
 */
export function addSpanSecrets(...values: readonly string[]): void {
  for (const value of values) if (value !== "") registered.add(value);
}

export function registeredSpanSecrets(): readonly string[] {
  return [...registered];
}
