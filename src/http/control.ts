import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { sep } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { CommitGrantStore } from "../bookings/commit-grant.ts";
import type { Booking, BookingStore } from "../bookings/ledger.ts";
import type { Call } from "../calls/call.ts";
import type { CallActivity, CallActivitySource } from "../calls/call-activity.ts";
import type { LiveCallStore } from "../calls/call-store.ts";
import type { ErrandStore } from "../calls/errand-store.ts";
import type { OfferStore } from "../calls/offer-drafts.ts";
import { summarizeOffer } from "../calls/offer-summary.ts";
import { placeQuoteCall } from "../calls/place-call.ts";
import type { TranscriptStore } from "../calls/transcript-store.ts";
import type { VoiceCallPort } from "../calls/voice-call-port.ts";
import { type ErrandBrief, parseErrandBrief } from "../errands/brief.ts";
import { joinCallSession } from "../observability/spans.ts";
import { maskPhone } from "../shared/phone.ts";
import { mountErrandRoutes } from "./control-errands.ts";
import {
  mountSettingsRoutes,
  type SettingActivity,
  type SettingsControlDeps,
} from "./control-settings.ts";

export type { SettingActivity, SettingsControlDeps } from "./control-settings.ts";

/** What `GET /control/events` streams: call activity, and settings saved from the dashboard. */
export type ControlActivity = CallActivity | SettingActivity;

/** Whether real calls can be placed now, and if not, why (shown to the owner as is). */
export type VoicePortAvailability =
  | { readonly ok: true; readonly port: VoiceCallPort }
  | { readonly ok: false; readonly reason: string };

export interface ControlDeps {
  /** Expected as `Authorization: Bearer <token>` on every control request. */
  readonly token: string;
  readonly calls: LiveCallStore;
  readonly errands: ErrandStore;
  readonly offers: OfferStore;
  readonly transcripts: TranscriptStore;
  readonly grants: CommitGrantStore;
  readonly bookings: BookingStore;
  readonly now: () => string;
  /** Errand files must resolve inside this directory (`<repoRoot>/.local`). */
  readonly errandRoot: string;
  /** Built per request, so a new `agent sync` or `phone import` applies without a restart. */
  readonly voice: () => Promise<VoicePortAvailability>;
  /** Receives unexpected errors (the caller logs them with redaction). */
  readonly onError?: (error: unknown) => void;
  /** Where placements report their status, and what `GET /control/events` streams; off when unset. */
  readonly activity?: CallActivitySource<ControlActivity>;
  /** Serves `/control/settings` when set (see `control-settings.ts`). */
  readonly settings?: SettingsControlDeps;
  /** How often an idle event stream sends a comment; 25 seconds by default. */
  readonly eventsKeepAliveMs?: number;
}

const BODY_LIMIT_BYTES = 16 * 1024;
const DEFAULT_KEEP_ALIVE_MS = 25_000;
/**
 * Writes an event stream may have waiting before its client counts as gone. A reader keeps up
 * with one call's events easily; one that stops reading would otherwise hold every later event
 * in memory until it disconnects.
 */
const MAX_PENDING_EVENT_WRITES = 100;
/** How long a browser's `EventSource` waits before it reconnects. */
const RECONNECT_AFTER_MS = 3_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;
/** Errors whose messages are written never to carry a key, a token, or a request body. */
const SAFE_ERROR_NAMES = new Set(["ElevenLabsApiError", "TwilioApiError"]);

const UNAUTHORIZED = { error: "unauthorized" } as const;
const INVALID_REQUEST = { error: "invalid_request" } as const;
const NOT_FOUND = { error: "not_found" } as const;
const INTERNAL_ERROR = { error: "internal_error" } as const;

const placeCallRequestSchema = z.object({
  to: z.string().regex(E164_PATTERN),
  errandFile: z.string().min(1),
  purpose: z.literal("quote"),
});

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** `?limit=` as a whole number from 1 to 200 (50 when absent), or `undefined` when invalid. */
function listLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_LIST_LIMIT;
  if (!/^[0-9]{1,3}$/.test(raw)) return undefined;
  const limit = Number(raw);
  return limit >= 1 && limit <= MAX_LIST_LIMIT ? limit : undefined;
}

/** The provider as the owner sees it: its name and its number with all but four digits hidden. */
function providerView(brief: ErrandBrief | undefined, providerId: string) {
  const provider = brief?.providers.find((candidate) => candidate.id === providerId);
  return {
    providerName: provider?.name ?? null,
    providerPhone: provider === undefined ? null : maskPhone(provider.phoneE164),
  };
}

/** A call as the listing shows it: whether it reached the voice provider, never the token hash. */
function callView(call: Call, brief: ErrandBrief | undefined) {
  return {
    callId: call.id,
    errandId: call.errandId,
    providerId: call.providerId,
    ...providerView(brief, call.providerId),
    purpose: call.purpose,
    status: call.status,
    attempt: call.attempt,
    createdAt: call.createdAt,
    endedAt: call.endedAt,
    hasConversation: call.externalId !== null,
  };
}

function bookingView(booking: Booking, brief: ErrandBrief | undefined) {
  return {
    id: booking.id,
    errandId: booking.errandId,
    offerId: booking.offerId,
    providerId: booking.providerId,
    providerName: providerView(brief, booking.providerId).providerName,
    participantIds: booking.participantIds,
    status: booking.status,
    history: booking.history,
  };
}

type ErrandFileResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: "errand_file_not_found" | "errand_file_outside_local" };

/** Reads an errand file only when its real path (symlinks resolved) lies inside `root`. */
async function readErrandFile(root: string, path: string): Promise<ErrandFileResult> {
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(root);
    realFile = await realpath(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: false, error: "errand_file_not_found" };
    throw error;
  }
  if (!realFile.startsWith(`${realRoot}${sep}`)) {
    return { ok: false, error: "errand_file_outside_local" };
  }
  return { ok: true, content: await readFile(realFile, "utf8") };
}

/**
 * The owner's control API, served on the same loopback server as the voice tools but never
 * through Tailscale Funnel, which only exposes `/voice-tools` and `/webhooks`. Every request needs
 * the control token as a bearer token (compared in constant time); anything else is the same 401.
 *
 * `POST /control/calls` `{ to, errandFile, purpose: "quote" }` reads the brief from a file under
 * `.local/`, then places the call through `placeQuoteCall` (this server is the only process that
 * writes the database) and answers `201 { callId, conversationId }`.
 *
 * The read routes never return a token, a token hash, a grant token, or a full phone number:
 * `GET /control/calls?limit=` lists the most recent calls, `GET /control/calls/:id` adds what the
 * call recorded (with the provider's quote for each value), its transcript, whether it holds a
 * commit grant, and the errand's open booking, and `GET /control/bookings?limit=` lists bookings.
 * `GET /control/events` streams call activity as Server-Sent Events (`ready`, then `call_status`
 * and `tool` events) until the client leaves or the server stops.
 */
export function createControlApp(deps: ControlDeps): Hono {
  if (deps.token.length === 0) throw new RangeError("createControlApp token must not be empty");
  const tokenDigest = sha256(deps.token);

  function reportError(error: unknown): void {
    try {
      deps.onError?.(error);
    } catch {
      // A failing logger must not change the response.
    }
  }

  const app = new Hono();
  app.onError((error, c) => {
    reportError(error);
    return c.json(INTERNAL_ERROR, 500);
  });
  app.use("/control/*", async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!timingSafeEqual(sha256(presented), tokenDigest)) return c.json(UNAUTHORIZED, 401);
    await next();
    return undefined;
  });
  app.use(
    "/control/*",
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
  );

  app.post("/control/calls", async (c) => {
    let json: unknown;
    try {
      json = JSON.parse(await c.req.text());
    } catch {
      return c.json(INVALID_REQUEST, 400);
    }
    const request = placeCallRequestSchema.safeParse(json);
    if (!request.success) return c.json(INVALID_REQUEST, 400);

    const file = await readErrandFile(deps.errandRoot, request.data.errandFile);
    if (!file.ok) return c.json({ error: file.error }, 400);
    let briefJson: unknown;
    try {
      briefJson = JSON.parse(file.content);
    } catch {
      return c.json({ error: "invalid_errand", issues: ["the file is not valid JSON"] }, 422);
    }
    const brief = parseErrandBrief(briefJson);
    if (!brief.ok) return c.json({ error: "invalid_errand", issues: brief.issues }, 422);

    const voice = await deps.voice();
    if (!voice.ok) return c.json({ error: "calls_not_configured", detail: voice.reason }, 503);

    try {
      const placed = await placeQuoteCall(
        {
          calls: deps.calls,
          errands: deps.errands,
          voice: voice.port,
          now: deps.now,
          ...(deps.activity === undefined ? {} : { onActivity: deps.activity.report }),
        },
        { brief: brief.brief, phoneE164: request.data.to },
      );
      if (!placed.ok) return c.json({ error: placed.reason }, 409);
      joinCallSession(placed.callId);
      return c.json({ callId: placed.callId, conversationId: placed.conversationId }, 201);
    } catch (error) {
      reportError(error);
      const detail =
        error instanceof Error && SAFE_ERROR_NAMES.has(error.name)
          ? error.message
          : "see the server log";
      return c.json({ error: "voice_provider_failed", detail }, 502);
    }
  });

  /** Each errand's brief, read once per request however many calls or bookings share it. */
  function briefReader(): (errandId: string) => Promise<ErrandBrief | undefined> {
    const briefs = new Map<string, Promise<ErrandBrief | undefined>>();
    return (errandId) => {
      let brief = briefs.get(errandId);
      if (brief === undefined) {
        brief = deps.errands.get(errandId);
        briefs.set(errandId, brief);
      }
      return brief;
    };
  }

  app.get("/control/calls", async (c) => {
    const limit = listLimit(c.req.query("limit"));
    if (limit === undefined) return c.json(INVALID_REQUEST, 400);
    const briefOf = briefReader();
    const calls = await deps.calls.listRecent(limit);
    return c.json({
      calls: await Promise.all(
        calls.map(async (call) => callView(call, await briefOf(call.errandId))),
      ),
    });
  });

  app.get("/control/calls/:id", async (c) => {
    const call = await deps.calls.findById(c.req.param("id"));
    if (call === undefined) return c.json(NOT_FOUND, 404);
    const [offer, brief, transcript, binding, activeGrant, booking] = await Promise.all([
      deps.offers.forProvider(call.errandId, call.providerId),
      deps.errands.get(call.errandId),
      deps.transcripts.findByCallId(call.id),
      deps.calls.activeGrant(call.id),
      deps.grants.findActive(call.errandId, deps.now()),
      deps.bookings.findOpen(call.errandId),
    ]);
    // The call holds a grant only while its binding is the errand's active grant.
    const holdsGrant =
      binding !== undefined && activeGrant !== undefined && activeGrant.token === binding.token;
    return c.json({
      ...callView(call, brief),
      conversationId: call.externalId,
      ...summarizeOffer(offer, brief),
      transcript:
        transcript === undefined
          ? null
          : { receivedAt: transcript.receivedAt, turns: transcript.turns },
      grant: holdsGrant ? { status: "active", expiresAt: activeGrant.expiresAt } : null,
      booking:
        booking === undefined
          ? null
          : {
              id: booking.id,
              providerId: booking.providerId,
              status: booking.status,
              history: booking.history,
            },
    });
  });

  app.get("/control/bookings", async (c) => {
    const limit = listLimit(c.req.query("limit"));
    if (limit === undefined) return c.json(INVALID_REQUEST, 400);
    const briefOf = briefReader();
    const bookings = await deps.bookings.listRecent(limit);
    return c.json({
      bookings: await Promise.all(
        bookings.map(async (booking) => bookingView(booking, await briefOf(booking.errandId))),
      ),
    });
  });

  mountErrandRoutes(app, {
    calls: deps.calls,
    errands: deps.errands,
    offers: deps.offers,
    grants: deps.grants,
    bookings: deps.bookings,
    now: deps.now,
    listLimit,
  });

  if (deps.settings !== undefined) {
    mountSettingsRoutes(app, {
      settings: deps.settings,
      now: deps.now,
      ...(deps.activity === undefined ? {} : { report: deps.activity.report }),
    });
  }

  const activity = deps.activity;
  if (activity !== undefined) {
    const keepAliveMs = deps.eventsKeepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
    // Writes are queued in order and never awaited here: a slow reader must not hold up the
    // report, which runs inside the request that changed the call. A client with too many
    // writes waiting is dropped instead.
    app.get("/control/events", (c) =>
      streamSSE(c, async (stream) => {
        await new Promise<void>((resolve) => {
          let ended = false;
          let unsubscribe = () => {};
          let keepAlive: NodeJS.Timeout | undefined;
          let pending = 0;
          const send = (write: () => Promise<unknown>) => {
            if (ended) return;
            if (pending >= MAX_PENDING_EVENT_WRITES) {
              // Cancels the stream, which settles the waiting writes and runs `end`.
              stream.abort();
              return;
            }
            pending += 1;
            void write().finally(() => {
              pending -= 1;
            });
          };
          const end = () => {
            if (ended) return;
            ended = true;
            clearInterval(keepAlive);
            unsubscribe();
            resolve();
          };
          unsubscribe = activity.subscribe({
            onActivity: (event) => {
              send(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }));
            },
            onClose: end,
          });
          // A feed that already closed (the server is stopping) ends the stream at once,
          // possibly before `subscribe` returned: drop the subscription it may have made.
          if (ended) {
            unsubscribe();
            return;
          }
          keepAlive = setInterval(() => {
            send(() => stream.write(": keep-alive\n\n"));
          }, keepAliveMs);
          keepAlive.unref();
          stream.onAbort(end);
          send(() => stream.writeSSE({ event: "ready", data: "{}", retry: RECONNECT_AFTER_MS }));
        });
      }),
    );
  }

  return app;
}
