import { randomUUID } from "node:crypto";
import type { ErrandBrief } from "../errands/brief.ts";
import { endCall, startCall } from "./call.ts";
import { type ReportCallActivity, reportActivity } from "./call-activity.ts";
import type { LiveCallStore } from "./call-store.ts";
import { type IssuedCallToken, issueCallToken } from "./call-token.ts";
import type { ErrandStore } from "./errand-store.ts";
import { planCallRound } from "./planning.ts";
import type { VoiceCallPort } from "./voice-call-port.ts";

export interface PlaceQuoteCallDeps {
  readonly calls: LiveCallStore;
  readonly errands: ErrandStore;
  readonly voice: VoiceCallPort;
  readonly now: () => string;
  readonly newCallId?: () => string;
  readonly issueToken?: () => IssuedCallToken;
  /** Hears the call's status as it changes: scheduled, then in progress or failed. */
  readonly onActivity?: ReportCallActivity;
}

export interface PlaceQuoteCallInput {
  readonly brief: ErrandBrief;
  /** Must be one of the brief's providers: Booker never calls a number the brief does not name. */
  readonly phoneE164: string;
}

export type PlaceQuoteCallResult =
  | { readonly ok: true; readonly callId: string; readonly conversationId: string }
  | { readonly ok: false; readonly reason: "provider_not_in_brief" | "provider_not_callable" };

/**
 * Places one quote call to the brief's provider at `phoneE164`. The brief is stored first
 * (replacing an earlier version with the same id, since the owner's file is the current intent),
 * then the call is created with a fresh per-call token and placed. Its conversation id and CallSid
 * are stored the moment the voice provider answers, so a post-call webhook that arrives right
 * after finds the call. A provider that already has an open call, or reached its attempt cap, is
 * refused (see `planCallRound`). When the voice provider refuses or fails, the call is ended as
 * `failed` (it counts as an attempt) and the error is rethrown.
 */
export async function placeQuoteCall(
  deps: PlaceQuoteCallDeps,
  input: PlaceQuoteCallInput,
): Promise<PlaceQuoteCallResult> {
  const { brief } = input;
  const provider = brief.providers.find((candidate) => candidate.phoneE164 === input.phoneE164);
  if (provider === undefined) return { ok: false, reason: "provider_not_in_brief" };

  const now = deps.now();
  await deps.errands.save(brief, now);

  const errandCalls = await deps.calls.listByErrand(brief.id);
  const callable = planCallRound({
    brief: { ...brief, providers: [provider] },
    calls: errandCalls,
  });
  if (!callable.includes(provider.id)) return { ok: false, reason: "provider_not_callable" };

  const { token, tokenHash } = (deps.issueToken ?? issueCallToken)();
  const call = startCall({
    id: (deps.newCallId ?? (() => `call-${randomUUID()}`))(),
    errandId: brief.id,
    providerId: provider.id,
    purpose: "quote",
    attempt: errandCalls.filter((existing) => existing.providerId === provider.id).length + 1,
    tokenHash,
    now,
  });
  const created = await deps.calls.create(call);
  if (!created.ok) throw new Error(`the call could not be stored: ${created.reason}`);
  const report = (status: "scheduled" | "in_progress" | "failed", at: string) =>
    reportActivity(deps.onActivity, { type: "call_status", callId: call.id, status, at });
  report("scheduled", now);

  let placed: Awaited<ReturnType<VoiceCallPort["placeCall"]>>;
  try {
    placed = await deps.voice.placeCall({
      call,
      phoneE164: provider.phoneE164,
      dynamicVariables: { call_id: call.id, call_token: token },
    });
  } catch (error) {
    const ended = endCall(call, "failed", deps.now());
    if (ended.ok) {
      await deps.calls.update(ended.call);
      report("failed", ended.call.endedAt ?? deps.now());
    }
    throw error;
  }

  const updated = await deps.calls.update({
    ...call,
    status: "in_progress",
    externalId: placed.externalId,
  });
  if (!updated.ok) throw new Error(`the placed call could not be recorded: ${updated.reason}`);
  report("in_progress", now);
  if (placed.callSid !== null) await deps.calls.setCallSid(call.id, placed.callSid);
  return { ok: true, callId: call.id, conversationId: placed.externalId };
}
