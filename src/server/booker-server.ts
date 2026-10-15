import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { InProcessActivityFeed } from "../calls/adapters/in-process-activity-feed.ts";
import type { LiveCallStore } from "../calls/call-store.ts";
import { reconcileStaleCalls } from "../calls/reconciliation.ts";
import type { ControlActivity, ControlDeps, VoicePortAvailability } from "../http/control.ts";
import type { WebhookSecretSource } from "../http/post-call-webhook.ts";
import { inSpan, SESSION_ID } from "../observability/spans.ts";
import { migrate, openDatabase } from "../persistence/database.ts";
import type { StandingRules } from "../policies/standing-rules.ts";
import { createBookerApp } from "./apps.ts";
import { DATABASE_FILE_NAME, type LoopbackHost } from "./config.ts";
import {
  DEFAULT_SHUTDOWN_GRACE_MS,
  type InFlightRequests,
  type ListeningServer,
  listen,
  trackInFlight,
} from "./http-server.ts";
import { describeError, withRequestLog } from "./logging.ts";
import { type RepeatingTask, scheduleRepeatingTask } from "./repeating-task.ts";
import { createSqliteStores } from "./stores.ts";
import {
  type StartRepeatingTimer,
  scheduleTranscriptPurge,
  type TranscriptPurgeSchedule,
} from "./transcript-purge.ts";

export { DATABASE_FILE_NAME } from "./config.ts";
/** Transcripts are kept this long after their post-call webhook, then purged. */
export const TRANSCRIPT_RETENTION_DAYS = 30;
export const TRANSCRIPT_PURGE_INTERVAL_MS = 60 * 60 * 1_000;
/** How often open calls are checked with the voice provider, and after how long. */
export const RECONCILE_INTERVAL_MS = 60 * 1_000;
export const RECONCILE_STALE_AFTER_MS = 5 * 60 * 1_000;

const DATA_DIRECTORY_MODE = 0o700;

/**
 * The owner's standing rules are not loaded yet, so nothing is booked automatically:
 * `request-commit-permission` answers "not granted" and the person confirms by calling back.
 */
const NO_AUTOMATIC_BOOKING: StandingRules = { autoBookWithinRules: false };

/** The owner's control routes and the reconciliation sweep, for a server that places calls. */
export interface ServerControlOptions
  extends Pick<ControlDeps, "token" | "errandRoot" | "settings"> {
  /** The voice port for one call request, given the server's own call store. */
  readonly voice: (calls: LiveCallStore) => Promise<VoicePortAvailability>;
  /** Checks stale open calls with the voice provider; omitted when no provider is configured. */
  readonly reconcile?: {
    readonly providerReportsFailure: (externalId: string) => Promise<boolean>;
    readonly staleAfterMs?: number;
    readonly intervalMs?: number;
  };
}

export interface BookerServerOptions {
  readonly host: LoopbackHost;
  /** 0 picks a free port (tests); `pnpm booker serve` passes the configured one. */
  readonly port: number;
  /** Holds `booker.db`; created with mode 0700 when missing. */
  readonly dataDir: string;
  readonly toolsKey: string;
  /** The post-call webhook's secret, or a function read at each delivery (see `serve`). */
  readonly webhookSecret: WebhookSecretSource;
  /** Values to redact from logged errors besides the tools key and a fixed webhook secret. */
  readonly redact?: () => readonly string[];
  /** Request lines and notices. */
  readonly log: (line: string) => void;
  /** Error lines; defaults to `log`. Never carries a key or the webhook secret. */
  readonly logError?: (line: string) => void;
  readonly now?: () => string;
  readonly startTimer?: StartRepeatingTimer;
  readonly shutdownGraceMs?: number;
  readonly control?: ServerControlOptions;
  /** True when the tracer runs in this process: traces requests and reconciliation lookups. */
  readonly tracing?: boolean;
}

export interface RunningBookerServer {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  readonly port: number;
  /**
   * Stops accepting connections, waits briefly for in-flight requests and any running purge,
   * then closes the database. Calling it again returns the same promise.
   */
  close(): Promise<void>;
}

function systemNow(): string {
  return new Date().toISOString();
}

/**
 * Runs Booker as one local process: migrates `<dataDir>/booker.db`, serves the voice tools, the
 * post-call webhook, and `/healthz` on `host:port` with one log line per request, and purges
 * expired transcripts on start and every hour. Booker runs as a single instance (see
 * docs/architecture.md), so this is the only process that should open the database.
 */
export async function startBookerServer(
  options: BookerServerOptions,
): Promise<RunningBookerServer> {
  const log = options.log;
  const logError = options.logError ?? log;
  const now = options.now ?? systemNow;
  const fixed = [
    options.toolsKey,
    ...(typeof options.webhookSecret === "string" ? [options.webhookSecret] : []),
  ];
  const reportError = (context: string) => (error: unknown) =>
    logError(`${context}: ${describeError(error, [...fixed, ...(options.redact?.() ?? [])])}`);

  await mkdir(options.dataDir, { recursive: true, mode: DATA_DIRECTORY_MODE });
  const db = openDatabase(pathToFileURL(join(options.dataDir, DATABASE_FILE_NAME)).href);

  const graceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  let http: ListeningServer | undefined;
  let inFlight: InFlightRequests;
  let purge: TranscriptPurgeSchedule | undefined;
  let reconciliation: RepeatingTask | undefined;
  // Call activity for `GET /control/events`; closing it ends every open stream at shutdown.
  const activity = new InProcessActivityFeed<ControlActivity>();
  try {
    await migrate(db);
    const stores = createSqliteStores(db);
    const control = options.control;
    const app = createBookerApp(stores, {
      toolsKey: options.toolsKey,
      webhookSecret: options.webhookSecret,
      now,
      standingRules: () => NO_AUTOMATIC_BOOKING,
      onError: reportError("request failed"),
      activity,
      ...(options.tracing === true ? { tracing: true } : {}),
      ...(control === undefined
        ? {}
        : {
            control: {
              token: control.token,
              errandRoot: control.errandRoot,
              voice: () => control.voice(stores.calls),
              ...(control.settings === undefined ? {} : { settings: control.settings }),
            },
          }),
    });
    inFlight = trackInFlight(withRequestLog((request) => app.fetch(request), log));
    http = await listen(inFlight.fetch, {
      host: options.host,
      port: options.port,
      onError: reportError("server error"),
    });
    purge = scheduleTranscriptPurge({
      transcripts: stores.transcripts,
      retentionDays: TRANSCRIPT_RETENTION_DAYS,
      intervalMs: TRANSCRIPT_PURGE_INTERVAL_MS,
      now,
      ...(options.startTimer === undefined ? {} : { startTimer: options.startTimer }),
      onPurged: (count) => {
        if (count > 0) log(`transcript purge: removed ${count} expired transcript(s)`);
      },
      onError: reportError("transcript purge failed"),
    });
    const reconcile = options.control?.reconcile;
    if (reconcile !== undefined) {
      reconciliation = scheduleRepeatingTask({
        intervalMs: reconcile.intervalMs ?? RECONCILE_INTERVAL_MS,
        ...(options.startTimer === undefined ? {} : { startTimer: options.startTimer }),
        run: async () => {
          const { ended } = await reconcileStaleCalls({
            calls: stores.calls,
            now: now(),
            staleAfterMs: reconcile.staleAfterMs ?? RECONCILE_STALE_AFTER_MS,
            providerReportsFailure: (externalId, callId) =>
              // One trace per checked call, in that call's session; the lookup is its child.
              inSpan("reconcile call", { [SESSION_ID]: callId }, async (span) => {
                const failed = await reconcile.providerReportsFailure(externalId);
                span.setAttribute("booker.provider_reports_failure", failed);
                return failed;
              }),
            onError: reportError("reconciliation lookup failed"),
            onActivity: activity.report,
          });
          if (ended > 0) log(`reconciliation: ended ${ended} call(s) the provider reported failed`);
        },
        onError: reportError("reconciliation failed"),
      });
    }
  } catch (error) {
    activity.close();
    await purge?.stop().catch(() => {});
    await http?.close(0).catch(() => {});
    db.$client.close();
    throw error;
  }
  const listening = http;
  const purging = purge;

  async function shutdown(): Promise<void> {
    // Event streams never finish on their own: end them first so their connections can close.
    activity.close();
    const results = await Promise.allSettled([
      listening.close(graceMs),
      purging.stop(),
      reconciliation?.stop(),
    ]);
    // The grace period cuts connections, not handlers: one may still be writing. Give those the
    // same grace again before the database closes under them.
    if (!(await inFlight.settled(graceMs))) {
      logError(`closing the database with ${inFlight.count()} request(s) still running`);
    }
    db.$client.close();
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }

  let closing: Promise<void> | undefined;
  return {
    url: `http://${options.host}:${listening.port}`,
    port: listening.port,
    close() {
      closing ??= shutdown();
      return closing;
    },
  };
}
