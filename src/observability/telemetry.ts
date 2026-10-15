// Preloaded with `node --import ./src/observability/telemetry.ts` (see `pnpm serve:traced` and
// docs/observability.md), before any Booker module, so `fetch` is instrumented from the start.
// Only the composition root loads this file: domain modules never import it.
//
// Without OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (in the environment, or saved from the dashboard) it
// does nothing else: the SDK is never imported.
import { fileURLToPath } from "node:url";
import { savedTracingEnvironment } from "./saved-settings.ts";
import { markTracingStarted, tracingSettings } from "./settings.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const settings = tracingSettings(
  await savedTracingEnvironment(process.env, repoRoot, (warning) =>
    process.stderr.write(`${warning}\n`),
  ),
);

if (settings.status === "invalid") {
  process.stderr.write(`Tracing: ${settings.issue}\n`);
} else if (settings.status === "on") {
  const [{ OTLPTraceExporter }, { startTracing }, redaction] = await Promise.all([
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("./tracing.ts"),
    import("./redaction.ts"),
  ]);
  const environmentSecrets = redaction.secretsFromEnvironment(process.env);
  const tracing = startTracing({
    serviceName: settings.serviceName,
    exporter: new OTLPTraceExporter({ url: settings.endpoint }),
    secrets: () => [...environmentSecrets, ...redaction.registeredSpanSecrets()],
  });
  markTracingStarted(settings);

  // Spans are exported in batches; flush the last ones once nothing else is left to run.
  // `beforeExit` fires again after the flush, and the guard inside `shutdown` ends it there.
  process.on("beforeExit", () => {
    tracing.shutdown().catch(() => {});
  });
}
