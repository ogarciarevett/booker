import { httpInstrumentationMiddleware } from "@hono/otel";
import { Hono } from "hono";
import type { CallActivitySource } from "../calls/call-activity.ts";
import { type ControlActivity, type ControlDeps, createControlApp } from "../http/control.ts";
import { createPostCallWebhookApp, type WebhookSecretSource } from "../http/post-call-webhook.ts";
import { createVoiceToolsApp } from "../http/voice-tools.ts";
import type { StandingRules } from "../policies/standing-rules.ts";
import type { BookerStores } from "./stores.ts";

export interface BookerApps {
  readonly voiceToolsApp: Hono;
  readonly postCallWebhookApp: Hono;
}

export interface BookerAppsOptions {
  /** Expected in `X-Booker-Tools-Key` on every voice-tool request. */
  readonly toolsKey: string;
  /** Verifies `ElevenLabs-Signature` on every post-call webhook; a function is read per delivery. */
  readonly webhookSecret: WebhookSecretSource;
  readonly now: () => string;
  readonly standingRules: () => StandingRules;
  /** Receives unexpected errors; responses stay a generic 500. */
  readonly onError?: (error: unknown) => void;
  /** Mounts the owner's control routes (`/control/*`) when set. */
  readonly control?: Pick<
    ControlDeps,
    "token" | "errandRoot" | "voice" | "eventsKeepAliveMs" | "settings"
  >;
  /** Hears what happens to calls (tools, status changes) and feeds `GET /control/events`. */
  readonly activity?: CallActivitySource<ControlActivity>;
  /**
   * Opens a server span for each request worth a trace: the voice tools, the post-call webhook,
   * and placing a call. Set only when the tracer runs (`pnpm serve:traced`); `/healthz` and the
   * control routes the CLI and the dashboard poll stay out, so Phoenix shows calls, not polling.
   */
  readonly tracing?: boolean;
}

const INTERNAL_ERROR = { error: "internal_error" } as const;

/** The two HTTP apps a voice runtime drives, sharing one store set and one clock. */
export function createBookerApps(stores: BookerStores, options: BookerAppsOptions): BookerApps {
  const onError = options.onError === undefined ? {} : { onError: options.onError };
  const onActivity = options.activity === undefined ? {} : { onActivity: options.activity.report };
  return {
    voiceToolsApp: createVoiceToolsApp({
      calls: stores.calls,
      errands: stores.errands,
      offers: stores.offers,
      grants: stores.grants,
      bookings: stores.bookings,
      standingRules: options.standingRules,
      now: options.now,
      toolsKey: options.toolsKey,
      ...onError,
      ...onActivity,
    }),
    postCallWebhookApp: createPostCallWebhookApp({
      webhookSecret: options.webhookSecret,
      calls: stores.calls,
      transcripts: stores.transcripts,
      events: stores.events,
      now: options.now,
      ...onError,
      ...onActivity,
    }),
  };
}

/**
 * The whole server as one Hono app: the voice tools (`/voice-tools/*`), the post-call webhook
 * (`/webhooks/elevenlabs/post-call`), the owner's control routes (`/control/*`, when configured;
 * never behind Tailscale Funnel), and `GET /healthz`, which answers `{ "status": "ok" }` and
 * nothing else. Each mounted app keeps its own body limits and error handling.
 */
export function createBookerApp(stores: BookerStores, options: BookerAppsOptions): Hono {
  const apps = createBookerApps(stores, options);
  const app = new Hono();
  app.onError((error, c) => {
    try {
      options.onError?.(error);
    } catch {
      // A failing logger must not change the response.
    }
    return c.json(INTERNAL_ERROR, 500);
  });
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  if (options.tracing === true) {
    // No request or response header is captured: they carry the tools key and the bearer token.
    const traced = httpInstrumentationMiddleware({ captureActiveRequests: false });
    app.use("/voice-tools/*", traced);
    app.use("/webhooks/*", traced);
    app.on("POST", "/control/calls", traced);
  }
  app.route("/", apps.voiceToolsApp);
  app.route("/", apps.postCallWebhookApp);
  if (options.control !== undefined) {
    app.route(
      "/",
      createControlApp({
        ...options.control,
        calls: stores.calls,
        errands: stores.errands,
        offers: stores.offers,
        transcripts: stores.transcripts,
        grants: stores.grants,
        bookings: stores.bookings,
        now: options.now,
        ...(options.onError === undefined ? {} : { onError: options.onError }),
        ...(options.activity === undefined ? {} : { activity: options.activity }),
      }),
    );
  }
  return app;
}
