import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type Call, type CallStatus, endCall } from "../calls/call.ts";
import { type ReportCallActivity, reportActivity } from "../calls/call-activity.ts";
import type { CallStore } from "../calls/call-store.ts";
import type { TranscriptStore, TranscriptTurn } from "../calls/transcript-store.ts";
import { elevenLabsEventKey, type WebhookEventStore } from "../calls/webhook-events.ts";
import { verifyElevenLabsSignature } from "../calls/webhook-signature.ts";
import { annotateActiveSpan, joinCallSession } from "../observability/spans.ts";

/**
 * The signing secret, or a function read at each delivery so a secret saved or rotated while
 * the server runs applies at once (`undefined` while none is configured).
 */
export type WebhookSecretSource = string | (() => Promise<string | undefined>);

export interface PostCallWebhookDeps {
  readonly webhookSecret: WebhookSecretSource;
  readonly calls: CallStore;
  readonly transcripts: TranscriptStore;
  readonly events: WebhookEventStore;
  readonly now: () => string;
  readonly toleranceSeconds?: number;
  /** Receives unexpected errors (the caller logs them with redaction); the response stays a generic 500. */
  readonly onError?: (error: unknown) => void;
  /** Hears each call a delivery ends, with its new status. */
  readonly onActivity?: ReportCallActivity;
}

const SIGNATURE_HEADER = "ElevenLabs-Signature";
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

// Error bodies are fixed strings: they never say which check failed or echo any input.
const UNAUTHORIZED = { error: "unauthorized" } as const;
const MALFORMED = { error: "malformed_payload" } as const;
const UNKNOWN_CONVERSATION = { error: "unknown_conversation" } as const;
const IN_PROGRESS = { error: "in_progress" } as const;
const CONFLICT = { error: "conflict" } as const;
const PAYLOAD_TOO_LARGE = { error: "payload_too_large" } as const;
const NOT_CONFIGURED = { error: "not_configured" } as const;
const SECRET_UNAVAILABLE = { error: "secret_unavailable" } as const;
const INTERNAL_ERROR = { error: "internal_error" } as const;
const RECEIVED = { received: true } as const;

/**
 * Answers that ask ElevenLabs to deliver again later. It retries a `post_call_transcription` only
 * on 5xx, 408, or 429 (five attempts over about 40 minutes), so "not yet" must be a 503: a 404 or
 * 409 would be final. The webhook is attached to Booker's own agents, so an unknown conversation
 * is a Booker call whose conversation id is not stored yet, not a stranger's.
 */
const RETRY_LATER_STATUS = 503;
const RETRY_AFTER_SECONDS = "30";

/**
 * The three event types this route actually processes: `post_call_transcription` ends the call
 * (`completed`/`failed`, see `mapConversationStatus`) and stores its minimized transcript;
 * `call_initiation_failure` ends the call as `no_answer` — it never connected, but it still
 * counts as one attempt, so `planCallRound` can retry the provider within the attempt cap;
 * `post_call_audio` stores nothing. Every other (undocumented or future) `type` value is still
 * claimed and completed, just without any side effect — see the branch in the route handler
 * below.
 */
const TRANSCRIPTION_TYPE = "post_call_transcription";
const AUDIO_TYPE = "post_call_audio";
const INITIATION_FAILURE_TYPE = "call_initiation_failure";

/**
 * A turn that only carries tool calls or tool results has a `null` or missing `message`; it is
 * accepted here and dropped by `normalizeTranscriptTurns` like any other empty turn.
 */
const transcriptTurnSchema = z.object({
  role: z.enum(["agent", "user"]),
  message: z.string().nullish(),
  time_in_call_secs: z.number(),
});

/**
 * The envelope every ElevenLabs post-call webhook shares, per
 * https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks: `type`, a unix
 * `event_timestamp`, and a `data` object that always carries `conversation_id`. `type` is kept
 * as a bare non-empty string (not a fixed enum) so a future or currently-undocumented event type
 * is tolerated rather than rejected as malformed — see the route handler's branch on `event.type`.
 * `data` is `.passthrough()`, so unknown fields are *kept*, not stripped: this schema only knows
 * about `conversation_id`, but a `post_call_transcription` event's `status` and `transcript` are,
 * from this schema's point of view, exactly such "unknown" fields — stripping them here would
 * make the stricter `transcriptionDataSchema` re-parse below fail to find them.
 */
const postCallWebhookEnvelopeSchema = z.object({
  type: z.string().min(1),
  event_timestamp: z.number(),
  data: z.object({ conversation_id: z.string().min(1) }).passthrough(),
});

/**
 * The extra shape a `post_call_transcription` event's `data` must carry to be processed:
 * `status` (mapped to a call status by `mapConversationStatus`) and `transcript`, an ordered
 * list of turns. Extra fields (`metadata`, `analysis`, ...) are accepted but never read past
 * this parse, which is exactly what keeps them out of storage (data minimization).
 */
const transcriptionDataSchema = z.object({
  conversation_id: z.string().min(1),
  status: z.string().min(1),
  transcript: z.array(transcriptTurnSchema),
});

type PostCallWebhookEnvelope = z.infer<typeof postCallWebhookEnvelopeSchema>;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface NormalizedTranscript {
  readonly turns: readonly TranscriptTurn[];
  readonly droppedCount: number;
}

/**
 * Converts ElevenLabs' transcript shape to `TranscriptTurn`s, dropping any turn a real (if
 * buggy or unlucky) delivery could carry that `TranscriptStore.save` would otherwise reject
 * outright: a message that is missing, `null` (a tool-call turn), or empty once trimmed, or a
 * `time_in_call_secs` that is negative or
 * not finite. A schema-level type check (`z.number()`) already rules out non-numbers and `NaN`
 * before this runs, but not a negative value or `Infinity`. Without this normalization, one bad
 * turn in an otherwise-good transcript would make `save` throw every single time the event is
 * retried — even after the call had already been ended successfully — turning one malformed
 * delivery into a permanent processing failure for that call. The caller reports `droppedCount`
 * once via `onError` rather than for each dropped turn.
 */
function normalizeTranscriptTurns(
  transcript: readonly z.infer<typeof transcriptTurnSchema>[],
): NormalizedTranscript {
  const turns: TranscriptTurn[] = [];
  let droppedCount = 0;
  for (const turn of transcript) {
    const message = turn.message ?? "";
    const hasMessage = message.trim().length > 0;
    const hasValidTime = Number.isFinite(turn.time_in_call_secs) && turn.time_in_call_secs >= 0;
    if (hasMessage && hasValidTime) {
      turns.push({
        role: turn.role,
        message,
        secondsIntoCall: turn.time_in_call_secs,
      });
    } else {
      droppedCount += 1;
    }
  }
  return { turns, droppedCount };
}

/**
 * Ends `call` with `status` and persists it — unless it has already ended: an ended call is
 * never ended twice (see `endCall`), so a second delivery that reaches this point (a replay that
 * somehow got past the webhook-event claim, or a second event type for a call another delivery
 * already ended) is a silent no-op here rather than an error.
 */
async function endAndPersistCall(
  deps: Pick<PostCallWebhookDeps, "calls" | "onActivity">,
  call: Call,
  status: CallStatus,
  now: string,
): Promise<void> {
  const endResult = endCall(call, status, now);
  if (!endResult.ok) return;
  const updated = await deps.calls.update(endResult.call);
  if (!updated.ok) throw new Error("the call disappeared while ending it");
  reportActivity(deps.onActivity, {
    type: "call_status",
    callId: call.id,
    status,
    at: endResult.call.endedAt ?? now,
  });
}

/**
 * Maps ElevenLabs' conversation `status` to a terminal `CallStatus`. The only success value the
 * documented shape names is `"done"`; every other value (an explicit `"failed"`, or anything
 * undocumented) is treated as a failed call, since silently reporting an unrecognized status as
 * a success would be the wrong direction to guess in.
 */
function mapConversationStatus(status: string): "completed" | "failed" {
  return status === "done" ? "completed" : "failed";
}

/**
 * The ElevenLabs post-call webhook as a Hono app: `POST /webhooks/elevenlabs/post-call`. The raw
 * body is verified against `ElevenLabs-Signature` before anything is parsed (401 on any failure,
 * identical body). A body over 2 MiB is rejected with 413 before verification. Every delivery is
 * claimed by `${type}:${conversation_id}` and its payload hash before processing, so a replay
 * completes with 200 without reprocessing, a payload mismatch on that same key answers 409 and is
 * reported through `onError`, and a still-pending claim answers 503 so ElevenLabs delivers it
 * again later. `post_call_transcription`
 * ends the call and stores its minimized transcript; `call_initiation_failure` ends the call as
 * `no_answer` so the provider can be retried within the attempt cap; `post_call_audio` and any
 * other event type end nothing and store nothing (see the constants above). Any failure while
 * finding the call or processing the event releases the claim so a retry can claim it again,
 * rather than leaving it stuck as permanently in-progress. An unknown conversation releases the
 * claim too and answers 503: the call was placed but its conversation id is not stored yet.
 */
function retryLater(c: Context, body: object): Response {
  c.header("Retry-After", RETRY_AFTER_SECONDS);
  return c.json(body, RETRY_LATER_STATUS);
}

export function createPostCallWebhookApp(deps: PostCallWebhookDeps): Hono {
  const source = deps.webhookSecret;
  if (typeof source === "string" && source.length === 0) {
    throw new RangeError("createPostCallWebhookApp webhookSecret must not be empty");
  }
  const currentSecret = typeof source === "string" ? async () => source : source;

  function reportError(error: unknown): void {
    try {
      deps.onError?.(error);
    } catch {
      // A failing logger must not change the response.
    }
  }

  const app = new Hono();
  app.use(
    "/webhooks/elevenlabs/post-call",
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => c.json(PAYLOAD_TOO_LARGE, 413),
    }),
  );
  app.onError((error, c) => {
    reportError(error);
    return c.json(INTERNAL_ERROR, 500);
  });

  app.post("/webhooks/elevenlabs/post-call", async (c: Context) => {
    const rawBody = await c.req.text();
    const now = deps.now();

    // No secret yet: nothing can be verified, so ask for the delivery again rather than refuse
    // it for good (ElevenLabs retries a 503, never a 401).
    // A secret store that cannot be read (a locked Keychain) is the same: try again later.
    let secret: string | undefined;
    try {
      secret = await currentSecret();
    } catch (error) {
      reportError(error);
      return retryLater(c, SECRET_UNAVAILABLE);
    }
    if (secret === undefined || secret === "") return retryLater(c, NOT_CONFIGURED);

    const verification = verifyElevenLabsSignature({
      rawBody,
      header: c.req.header(SIGNATURE_HEADER),
      secret,
      now,
      ...(deps.toleranceSeconds === undefined ? {} : { toleranceSeconds: deps.toleranceSeconds }),
    });
    if (!verification.ok) return c.json(UNAUTHORIZED, 401);

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return c.json(MALFORMED, 400);
    }
    const envelopeParsed = postCallWebhookEnvelopeSchema.safeParse(json);
    if (!envelopeParsed.success) return c.json(MALFORMED, 400);
    const event: PostCallWebhookEnvelope = envelopeParsed.data;

    // Parsed once here (not re-parsed later): keeps a single source of truth for the shape and
    // means a later change to `event.data` can never make the two parses disagree.
    let transcriptionData: z.infer<typeof transcriptionDataSchema> | undefined;
    if (event.type === TRANSCRIPTION_TYPE) {
      const parsed = transcriptionDataSchema.safeParse(event.data);
      if (!parsed.success) return c.json(MALFORMED, 400);
      transcriptionData = parsed.data;
    }

    const eventKey = elevenLabsEventKey(event.type, event.data.conversation_id);
    const payloadSha256 = sha256Hex(rawBody);
    const claim = await deps.events.claim({ eventKey, payloadSha256, now });

    switch (claim.outcome) {
      case "completed_duplicate":
        return c.json(RECEIVED, 200);
      case "in_progress":
        return retryLater(c, IN_PROGRESS);
      case "payload_mismatch":
        reportError(new Error(`payload mismatch for webhook event ${eventKey}`));
        return c.json(CONFLICT, 409);
      case "claimed": {
        // Everything from here on runs inside one try/catch, including finding the call: any
        // failure — a lookup error, a store outage mid-processing, anything — must release the
        // claim, or the event would stay claimed forever (a permanent 409 for every retry).
        try {
          const call = await deps.calls.findByExternalId(event.data.conversation_id);
          if (call === undefined) {
            await deps.events.release(eventKey, claim.claimToken);
            return retryLater(c, UNKNOWN_CONVERSATION);
          }
          joinCallSession(call.id);
          annotateActiveSpan({ "booker.webhook.event": event.type });

          if (event.type === TRANSCRIPTION_TYPE && transcriptionData !== undefined) {
            await endAndPersistCall(
              deps,
              call,
              mapConversationStatus(transcriptionData.status),
              now,
            );
            const normalized = normalizeTranscriptTurns(transcriptionData.transcript);
            if (normalized.droppedCount > 0) {
              reportError(
                new Error(
                  `dropped ${normalized.droppedCount} invalid transcript turn(s) for call ${call.id}`,
                ),
              );
            }
            await deps.transcripts.save({
              callId: call.id,
              receivedAt: now,
              turns: normalized.turns,
            });
          } else if (event.type === INITIATION_FAILURE_TYPE) {
            // The call never connected: it counts as one attempt (`no_answer`), so
            // `planCallRound` can retry the provider within the attempt cap. Nothing from this
            // payload is ever stored beyond that status — not even `failure_reason`.
            await endAndPersistCall(deps, call, "no_answer", now);
          } else if (event.type === AUDIO_TYPE) {
            // Audio is never stored (see AGENTS.md's data-minimization rule); nothing to do.
          }
          // Any other (unrecognized) event type: nothing to do either.
          const completed = await deps.events.complete(eventKey, claim.claimToken, now);
          if (!completed) throw new Error("the webhook claim was lost while processing");
          return c.json(RECEIVED, 200);
        } catch (error) {
          // Report the real failure before attempting to release: if release also throws, its
          // error must never mask the one that actually explains what went wrong.
          reportError(error);
          try {
            await deps.events.release(eventKey, claim.claimToken);
          } catch (releaseError) {
            reportError(releaseError);
          }
          return c.json(INTERNAL_ERROR, 500);
        }
      }
    }
  });

  return app;
}
