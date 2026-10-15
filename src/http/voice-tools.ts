import { createHash, timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { CommitGrant, CommitGrantStore } from "../bookings/commit-grant.ts";
import { type BookingStore, createBooking } from "../bookings/ledger.ts";
import { type Call, isCallOpen } from "../calls/call.ts";
import { type ReportCallActivity, reportActivity } from "../calls/call-activity.ts";
import type { ActiveGrantBinding, CallStore } from "../calls/call-store.ts";
import { verifyCallToken } from "../calls/call-token.ts";
import type { ErrandStore } from "../calls/errand-store.ts";
import { shareableErrandView } from "../calls/errand-view.ts";
import { emptyOfferDraft, type OfferStore } from "../calls/offer-drafts.ts";
import { offerTermsDigest } from "../calls/offer-terms.ts";
import { applyQuoteField } from "../calls/quote-fields.ts";
import {
  isToolAllowed,
  type RecordQuoteFieldResponse,
  type ReportCommitOutcomeResponse,
  type RequestCommitPermissionResponse,
  recordQuoteFieldRequestSchema,
  reportCommitOutcomeRequestSchema,
  requestCommitPermissionRequestSchema,
  type VoiceToolName,
} from "../calls/tools.ts";
import type { ErrandBrief } from "../errands/brief.ts";
import {
  inSpan,
  joinCallSession,
  SESSION_ID,
  SPAN_KIND,
  TOOL_NAME,
} from "../observability/spans.ts";
import type { Offer } from "../offers/offer.ts";
import { authorizeCommit } from "../policies/authorization.ts";
import type { StandingRules } from "../policies/standing-rules.ts";
import { KeyedQueue } from "./keyed-queue.ts";

export interface VoiceToolsDeps {
  readonly calls: CallStore;
  readonly errands: ErrandStore;
  readonly offers: OfferStore;
  readonly grants: CommitGrantStore;
  readonly bookings: BookingStore;
  readonly standingRules: () => StandingRules;
  readonly now: () => string;
  /** The runtime-level secret every request must carry in `X-Booker-Tools-Key`. */
  readonly toolsKey: string;
  readonly grantTtlSeconds?: number;
  /** Receives unexpected errors (the caller logs them with redaction); the response stays a generic 500. */
  readonly onError?: (error: unknown) => void;
  /** Hears each authenticated tool request: the tool and its outcome, never what was sent. */
  readonly onActivity?: ReportCallActivity;
}

const TOOLS_KEY_HEADER = "X-Booker-Tools-Key";
const BODY_LIMIT_BYTES = 16 * 1024;
const DEFAULT_GRANT_TTL_SECONDS = 600;
// Any well-formed hash: a request for an unknown call still pays for one token check.
const UNKNOWN_CALL_TOKEN_HASH = "0".repeat(64);

const TOOL_ROUTES: readonly (readonly [path: string, tool: VoiceToolName])[] = [
  ["get-errand-context", "get_errand_context"],
  ["record-quote-field", "record_quote_field"],
  ["request-commit-permission", "request_commit_permission"],
  ["report-commit-outcome", "report_commit_outcome"],
];

// Error bodies are fixed strings: they never say which check failed or echo any input.
const UNAUTHORIZED = { error: "unauthorized" } as const;
const FORBIDDEN = { error: "forbidden" } as const;
const PAYLOAD_TOO_LARGE = { error: "payload_too_large" } as const;
const INTERNAL_ERROR = { error: "internal_error" } as const;

// Instructions are read by the voice agent: no amounts, limits, reasons, or tokens.
const GRANTED_INSTRUCTION =
  "You may confirm the booking now, exactly as quoted. Then report the provider's answer.";
const NOT_GRANTED_INSTRUCTION =
  "Do not confirm the booking. Thank the provider and say the person will call back to confirm.";
const TERMS_CHANGED_INSTRUCTION =
  "The terms changed after permission was given. Do not confirm yet; repeat the new terms and request permission again.";

type ToolResult =
  | { readonly status: 200; readonly body: object }
  | { readonly status: 403; readonly body: typeof FORBIDDEN }
  | { readonly status: 409; readonly body: { readonly error: "conflict" } }
  | { readonly status: 422; readonly body: { readonly error: "invalid_request" } };

const INVALID_REQUEST: ToolResult = { status: 422, body: { error: "invalid_request" } };
const CONFLICT: ToolResult = { status: 409, body: { error: "conflict" } };
const RECORDED: ToolResult = {
  status: 200,
  body: { recorded: true } satisfies ReportCommitOutcomeResponse,
};

function permission(granted: boolean): ToolResult {
  const body: RequestCommitPermissionResponse = {
    granted,
    instruction: granted ? GRANTED_INSTRUCTION : NOT_GRANTED_INSTRUCTION,
  };
  return { status: 200, body };
}

/** The tool's outcome as its span records it: `ok`, or the error the response names. */
function toolStatus(result: ToolResult): string {
  return result.status === 200 ? "ok" : result.body.error;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * A voice agent's model may send `null` for a field it has no value for. The tool schemas treat
 * an absent field as "not given", so every `null` object property is dropped before validation;
 * a required field that was `null` is then simply missing and rejected as before.
 */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, property]) => property !== null)
      .map(([name, property]) => [name, withoutNulls(property)]),
  );
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return withoutNulls(JSON.parse(await c.req.text()));
  } catch {
    return undefined;
  }
}

function readCallToken(body: unknown): string {
  if (typeof body !== "object" || body === null || !("call_token" in body)) return "";
  return typeof body.call_token === "string" ? body.call_token : "";
}

/** A partial group is booked only when the brief allows it and fewer seats were confirmed. */
function participantsToBook(brief: ErrandBrief, offer: Offer): string[] {
  const participantIds = brief.participants.map((participant) => participant.id);
  const seats = offer.seatsAvailable;
  if (
    brief.groupPolicy.allowPartialBooking &&
    seats.status === "known" &&
    seats.value < participantIds.length
  ) {
    return participantIds.slice(0, seats.value);
  }
  return participantIds;
}

/**
 * The mid-call voice tools as a Hono app: `POST /voice-tools/:callId/<tool>`. Each request needs
 * the runtime key header and the call's own token in the body; the call must still be open. Any
 * of those failing returns the same 401. A tool outside the call's purpose returns 403, a body
 * the tool's schema rejects returns 422, and a body over 16 KiB returns 413.
 *
 * Tools that write (quote fields, grants, bookings) run one at a time per errand in this process.
 * Nothing a provider says can change the brief: the tools only read errands, and a quote field
 * can only write offer fields (see `applyQuoteField`).
 */
export function createVoiceToolsApp(deps: VoiceToolsDeps): Hono {
  if (deps.toolsKey.length === 0) {
    throw new RangeError("createVoiceToolsApp toolsKey must not be empty");
  }
  const toolsKeyDigest = sha256(deps.toolsKey);
  const grantTtlSeconds = deps.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
  const errandQueue = new KeyedQueue();

  function reportError(error: unknown): void {
    try {
      deps.onError?.(error);
    } catch {
      // A failing logger must not change the response.
    }
  }

  async function requireBrief(errandId: string): Promise<ErrandBrief> {
    const brief = await deps.errands.get(errandId);
    if (brief === undefined) throw new Error("the call's errand is missing");
    return brief;
  }

  /** The open call this request is authenticated for, or undefined for any failure. */
  async function authenticate(c: Context, body: unknown): Promise<Call | undefined> {
    const keyMatches = timingSafeEqual(
      sha256(c.req.header(TOOLS_KEY_HEADER) ?? ""),
      toolsKeyDigest,
    );
    if (!keyMatches) return undefined;
    const call = await deps.calls.findById(c.req.param("callId") ?? "");
    const tokenMatches = verifyCallToken(
      readCallToken(body),
      call?.tokenHash ?? UNKNOWN_CALL_TOKEN_HASH,
    );
    return call !== undefined && tokenMatches && isCallOpen(call) ? call : undefined;
  }

  async function getErrandContext(call: Call): Promise<ToolResult> {
    const brief = await requireBrief(call.errandId);
    return { status: 200, body: shareableErrandView(brief, call.providerId) };
  }

  async function recordQuoteField(call: Call, body: unknown): Promise<ToolResult> {
    const parsed = recordQuoteFieldRequestSchema.safeParse(body);
    if (!parsed.success) return INVALID_REQUEST;
    const { field, value, quote, confirmed } = parsed.data;

    return await errandQueue.run(call.errandId, async () => {
      const now = deps.now();
      const brief = await requireBrief(call.errandId);
      const draft =
        (await deps.offers.forProvider(call.errandId, call.providerId)) ??
        emptyOfferDraft(call.errandId, call.providerId, now);
      const applied = applyQuoteField(
        draft,
        brief,
        { field, value, quote, confirmed },
        now,
        call.id,
      );
      if (!applied.ok) return INVALID_REQUEST;
      await deps.offers.save(applied.offer);

      // A grant covers the terms that were checked. Any later change to that offer voids it,
      // so the agent cannot accept terms the backend never authorized.
      const active = await deps.grants.findActive(call.errandId, now);
      if (active !== undefined && active.offerId === applied.offer.id) {
        await deps.grants.revokeAll(call.errandId, now);
        if ((await deps.calls.activeGrant(call.id))?.token === active.token) {
          await deps.calls.setActiveGrant(call.id, null);
        }
        const revoked: RecordQuoteFieldResponse = {
          stored: true,
          status: confirmed ? "known" : "estimated",
          grantRevoked: true,
          instruction: TERMS_CHANGED_INSTRUCTION,
        };
        return { status: 200, body: revoked };
      }

      const response: RecordQuoteFieldResponse = {
        stored: true,
        status: confirmed ? "known" : "estimated",
      };
      return { status: 200, body: response };
    });
  }

  async function requestCommitPermission(call: Call, body: unknown): Promise<ToolResult> {
    const parsed = requestCommitPermissionRequestSchema.safeParse(body);
    if (!parsed.success) return INVALID_REQUEST;
    const { total, deposit, dates } = parsed.data;

    return await errandQueue.run(call.errandId, async () => {
      const now = deps.now();
      const brief = await requireBrief(call.errandId);
      const offer = await deps.offers.forProvider(call.errandId, call.providerId);
      if (offer === undefined) return permission(false);
      // A booked errand never commits again, whichever provider asks.
      if ((await deps.bookings.findOpen(call.errandId)) !== undefined) return permission(false);

      const decision = authorizeCommit({
        brief,
        rules: deps.standingRules(),
        offer,
        quoted: { total, deposit, dates },
      });
      if (decision.decision !== "auto") return permission(false);

      const active = await deps.grants.findActive(call.errandId, now);
      if (active !== undefined) {
        // A retried request from the call already holding the errand's grant gets the same answer.
        return permission(active.token === (await deps.calls.activeGrant(call.id))?.token);
      }
      const acquired = await deps.grants.acquire({
        errandId: call.errandId,
        offerId: offer.id,
        now,
        ttlSeconds: grantTtlSeconds,
      });
      if (!acquired.granted) return permission(false);
      await deps.calls.setActiveGrant(call.id, {
        token: acquired.grant.token,
        termsDigest: offerTermsDigest(offer),
      });
      return permission(true);
    });
  }

  /**
   * Books the offer the provider accepted, in an order that never loses a confirmed booking: the
   * offer must still match the terms the grant authorized (otherwise the grant is revoked), the
   * booking is stored, and only then is the grant consumed. A failure before the consume leaves
   * the grant active so a retried `accepted` can still book; a grant that ended in the meantime
   * cancels the booking just stored. The call's binding is cleared only once the booking holds.
   */
  async function bookVerbally(
    call: Call,
    binding: ActiveGrantBinding,
    grant: CommitGrant,
    now: string,
  ): Promise<ToolResult> {
    const bookingId = `booking-${grant.id}`;
    // A retry after a failure past storing this grant's booking finishes that accept. This relies
    // on `errandQueue` and a single server instance: a second process could see the booking while
    // the first is still consuming the grant, and the two would race.
    if ((await deps.bookings.findOpen(call.errandId))?.id === bookingId) {
      return await finishStoredBooking(call, binding, bookingId, now);
    }

    const brief = await requireBrief(call.errandId);
    const offer = await deps.offers.forProvider(call.errandId, call.providerId);
    if (
      offer === undefined ||
      offer.id !== grant.offerId ||
      offerTermsDigest(offer) !== binding.termsDigest
    ) {
      await deps.grants.revokeAll(call.errandId, now);
      await deps.calls.setActiveGrant(call.id, null);
      return CONFLICT;
    }

    const created = createBooking({
      brief,
      offer,
      participantIds: participantsToBook(brief, offer),
      id: bookingId,
      now,
    });
    if (!created.ok) throw new Error(`the granted offer cannot be booked: ${created.reason}`);
    const stored = await deps.bookings.create(created.booking);
    if (!stored.ok) return CONFLICT;

    const consumed = await deps.grants.consume(binding.token, now);
    if (!consumed.ok) {
      const cancelled = await deps.bookings.advance(created.booking.id, "cancelled", now);
      if (!cancelled.ok) throw new Error("the booking stored without a grant cannot be cancelled");
      return CONFLICT;
    }
    await deps.calls.setActiveGrant(call.id, null);
    return RECORDED;
  }

  /**
   * Completes an accept whose booking is already stored. The provider has accepted, so a failed
   * consume is reported and never cancels the booking; the grant then expires after its TTL.
   */
  async function finishStoredBooking(
    call: Call,
    binding: ActiveGrantBinding,
    bookingId: string,
    now: string,
  ): Promise<ToolResult> {
    // Same rule as a first attempt: a grant that ended before it was consumed voids the
    // booking; an infrastructure failure keeps it, since the provider already accepted.
    let consumed: Awaited<ReturnType<typeof deps.grants.consume>> | undefined;
    try {
      consumed = await deps.grants.consume(binding.token, now);
    } catch (error) {
      reportError(error);
    }
    await deps.calls.setActiveGrant(call.id, null);
    if (consumed !== undefined && !consumed.ok) {
      const cancelled = await deps.bookings.advance(bookingId, "cancelled", now);
      if (!cancelled.ok) throw new Error("the booking stored without a grant cannot be cancelled");
      return CONFLICT;
    }
    return RECORDED;
  }

  async function reportCommitOutcome(call: Call, body: unknown): Promise<ToolResult> {
    const parsed = reportCommitOutcomeRequestSchema.safeParse(body);
    if (!parsed.success) return INVALID_REQUEST;
    const { outcome } = parsed.data;

    return await errandQueue.run(call.errandId, async () => {
      const now = deps.now();
      const binding = await deps.calls.activeGrant(call.id);
      const active = await deps.grants.findActive(call.errandId, now);
      // The call must still hold the errand's active grant: not expired, consumed, or revoked.
      if (binding === undefined || active === undefined || active.token !== binding.token) {
        return CONFLICT;
      }

      switch (outcome) {
        case "accepted":
          return await bookVerbally(call, binding, active, now);
        case "rejected":
          await deps.grants.revokeAll(call.errandId, now);
          await deps.calls.setActiveGrant(call.id, null);
          return RECORDED;
        case "unclear":
          // Kept so reconciliation can check with this provider before anyone else.
          return RECORDED;
      }
    });
  }

  const handlers: Record<VoiceToolName, (call: Call, body: unknown) => Promise<ToolResult>> = {
    get_errand_context: getErrandContext,
    record_quote_field: recordQuoteField,
    request_commit_permission: requestCommitPermission,
    report_commit_outcome: reportCommitOutcome,
  };

  const app = new Hono();
  app.use(
    "/voice-tools/*",
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (c) => c.json(PAYLOAD_TOO_LARGE, 413),
    }),
  );
  app.onError((error, c) => {
    reportError(error);
    return c.json(INTERNAL_ERROR, 500);
  });

  for (const [path, tool] of TOOL_ROUTES) {
    app.post(`/voice-tools/:callId/${path}`, async (c) => {
      const body = await readJsonBody(c);
      const call = await authenticate(c, body);
      if (call === undefined) return c.json(UNAUTHORIZED, 401);
      // Only an authenticated request joins the call's session; the tool's span records its
      // name and outcome, never what was sent or answered.
      joinCallSession(call.id);
      const toolAttributes = { [SPAN_KIND]: "TOOL", [TOOL_NAME]: tool, [SESSION_ID]: call.id };
      const result = await inSpan(tool, toolAttributes, async (span) => {
        const outcome: ToolResult = isToolAllowed(call.purpose, tool)
          ? await handlers[tool](call, body)
          : { status: 403, body: FORBIDDEN };
        span.setAttribute("booker.tool.status", toolStatus(outcome));
        return outcome;
      });
      reportActivity(deps.onActivity, {
        type: "tool",
        callId: call.id,
        tool,
        outcome: toolStatus(result),
        at: deps.now(),
      });
      return c.json(result.body, result.status);
    });
  }
  return app;
}
