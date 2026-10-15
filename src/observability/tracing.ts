import type { TextMapPropagator } from "@opentelemetry/api";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { core, NodeSDK, resources } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { redactingExporter } from "./redaction.ts";

/** OpenInference's resource attribute naming the Phoenix project spans are filed under. */
const PHOENIX_PROJECT = "openinference.project.name";

export interface TracingOptions {
  readonly serviceName: string;
  readonly exporter: SpanExporter;
  /** Exports every span as it ends instead of in batches (tests). */
  readonly exportImmediately?: boolean;
  /** Values redacted from every span before export; read at each export. */
  readonly secrets?: () => readonly string[];
}

export interface Tracing {
  /** Exports every span that has ended. */
  flush(): Promise<void>;
  /** Flushes, then stops tracing; spans started afterwards are dropped. */
  shutdown(): Promise<void>;
}

/**
 * W3C trace context out, nothing in. Outgoing requests carry `traceparent` (no baggage, which
 * could carry data to providers), but an incoming `traceparent` is ignored: the voice tools and
 * the webhook are reachable from the internet, and a caller's header would otherwise choose the
 * trace id, and through its sampled flag whether Booker records the request at all.
 */
function outboundTraceContext(): TextMapPropagator {
  const w3c = new core.W3CTraceContextPropagator();
  return {
    inject: (context, carrier, setter) => w3c.inject(context, carrier, setter),
    extract: (context) => context,
    fields: () => w3c.fields(),
  };
}

/**
 * Starts the OpenTelemetry Node SDK for traces only: no metrics, no logs, no resource detection
 * (which would export the host name and the process's command line and owner). Outgoing `fetch`
 * calls (ElevenLabs, Twilio, Jev) become client spans named by method and host. Every span is
 * redacted (`redactingExporter`) before it reaches `exporter`.
 */
export function startTracing(options: TracingOptions): Tracing {
  const exporter = redactingExporter(options.exporter, options.secrets ?? (() => []));
  const processor = options.exportImmediately
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);
  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    resource: resources.resourceFromAttributes({ [PHOENIX_PROJECT]: options.serviceName }),
    autoDetectResources: false,
    spanProcessors: [processor],
    metricReaders: [],
    logRecordProcessors: [],
    textMapPropagator: outboundTraceContext(),
    instrumentations: [
      new UndiciInstrumentation({
        requestHook: (span, request) => {
          span.updateName(`${request.method} ${new URL(request.origin).host}`);
        },
      }),
    ],
  });
  sdk.start();

  let stopping: Promise<void> | undefined;
  return {
    flush: () => processor.forceFlush(),
    shutdown() {
      stopping ??= sdk.shutdown();
      return stopping;
    },
  };
}
