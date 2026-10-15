import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { REDACTED } from "./redaction.ts";
import { startTracing, type Tracing } from "./tracing.ts";

/** Generated at run time, so no credential-shaped literal is ever committed. */
const SECRET = randomBytes(16).toString("hex");

/** A loopback server that records the headers of every request it answers. */
async function startRecordingServer(): Promise<{
  server: Server;
  url: string;
  headers: IncomingHttpHeaders[];
}> {
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    headers.push(request.headers);
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}`, headers };
}

describe("startTracing", () => {
  const exporter = new InMemorySpanExporter();
  let tracing: Tracing;
  let local: Awaited<ReturnType<typeof startRecordingServer>>;

  beforeAll(async () => {
    tracing = startTracing({
      serviceName: "booker-test",
      exporter,
      exportImmediately: true,
      secrets: () => [SECRET],
    });
    local = await startRecordingServer();
  });

  afterAll(async () => {
    await tracing.shutdown();
    await new Promise((resolve) => local.server.close(resolve));
  });

  afterEach(() => {
    exporter.reset();
    local.headers.length = 0;
  });

  it("exports spans under the service name and the Phoenix project of the same name", async () => {
    trace.getTracer("test").startSpan("work").end();
    await tracing.flush();

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("work");
    expect(span?.resource.attributes).toMatchObject({
      "service.name": "booker-test",
      "openinference.project.name": "booker-test",
    });
  });

  it("records outgoing fetches by host, without their query string", async () => {
    const response = await fetch(`${local.url}/v1/numbers?phone=%2B15550100123`);
    await response.text();
    await tracing.flush();

    const [span] = exporter.getFinishedSpans();
    const host = new URL(local.url).host;
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.name).toBe(`GET ${host}`);
    expect(span?.attributes["url.full"]).toBe(`${local.url}/v1/numbers`);
    expect(span?.attributes).not.toHaveProperty("url.query");
    expect(JSON.stringify(span?.attributes)).not.toContain("15550100123");
  });

  it("sends trace context to providers but never baggage", async () => {
    const withBaggage = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ owner: { value: "someone" } }),
    );
    await context.with(withBaggage, async () => {
      const response = await fetch(`${local.url}/v1/convai/conversations/conv-1`);
      await response.text();
    });

    expect(local.headers[0]?.["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(local.headers[0]).not.toHaveProperty("baggage");
  });

  it("ignores trace context that arrives with a request", () => {
    const extracted = propagation.extract(ROOT_CONTEXT, {
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00",
      baggage: "owner=someone",
    });

    expect(trace.getSpanContext(extracted)).toBeUndefined();
    expect(propagation.getBaggage(extracted)).toBeUndefined();
  });

  it("redacts the configured secrets before anything is exported", async () => {
    const span = trace.getTracer("test").startSpan("lookup");
    span.setAttribute("note", `key ${SECRET}`);
    span.end();
    await tracing.flush();

    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({ note: `key ${REDACTED}` });
  });
});
