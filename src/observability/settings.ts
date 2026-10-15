/** The service name, and Phoenix project, when `OTEL_SERVICE_NAME` is not set. */
export const DEFAULT_SERVICE_NAME = "booker";

const ENDPOINT_VARIABLE = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT";

export type TracingSettings =
  | { readonly status: "off" }
  /** An endpoint is set, but `OTEL_SDK_DISABLED=true` keeps the SDK from starting. */
  | { readonly status: "disabled" }
  | { readonly status: "invalid"; readonly issue: string }
  | { readonly status: "on"; readonly endpoint: string; readonly serviceName: string };

function variable(env: Readonly<Record<string, string | undefined>>, name: string) {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Tracing is on only when `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` names an http(s) URL, such as
 * Phoenix's `http://127.0.0.1:6006/v1/traces`, and `OTEL_SDK_DISABLED` is not `true`. An
 * invalid endpoint is reported by name, never echoed, since an endpoint URL can carry
 * credentials.
 */
export function tracingSettings(
  env: Readonly<Record<string, string | undefined>>,
): TracingSettings {
  const endpoint = variable(env, ENDPOINT_VARIABLE);
  // The SDK's own switch: honored here too, so nothing claims tracing runs when it does not.
  const disabled = variable(env, "OTEL_SDK_DISABLED")?.toLowerCase() === "true";
  if (endpoint === undefined) return { status: "off" };
  if (disabled) return { status: "disabled" };
  if (!isHttpUrl(endpoint)) {
    return {
      status: "invalid",
      issue: `${ENDPOINT_VARIABLE} must be an http(s) URL such as http://127.0.0.1:6006/v1/traces; tracing is off`,
    };
  }
  return {
    status: "on",
    endpoint,
    serviceName: variable(env, "OTEL_SERVICE_NAME") ?? DEFAULT_SERVICE_NAME,
  };
}

/** The endpoint as it may be printed: origin and path, without credentials, query, or fragment. */
export function shownEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.origin}${url.pathname}`;
}

export type ActiveTracing = Extract<TracingSettings, { status: "on" }>;

let started: ActiveTracing | undefined;

/** Called by the telemetry entry once the SDK runs in this process. */
export function markTracingStarted(settings: ActiveTracing): void {
  started = settings;
}

/**
 * The settings tracing started with in this process, or `undefined` when the process was not
 * started with `--import ./src/observability/telemetry.ts` or tracing is off.
 */
export function startedTracing(): ActiveTracing | undefined {
  return started;
}
