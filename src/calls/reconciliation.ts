import { instantMillis } from "../shared/instants.ts";
import { endCall } from "./call.ts";
import { type ReportCallActivity, reportActivity } from "./call-activity.ts";
import type { LiveCallStore } from "./call-store.ts";

export interface ReconcileStaleCallsInput {
  readonly calls: LiveCallStore;
  readonly now: string;
  /** How long after placement a still-open call is checked with the voice provider. */
  readonly staleAfterMs: number;
  /**
   * True when the voice provider says the call failed (ElevenLabs: conversation `failed`). It also
   * gets Booker's own id for the call, so the caller can label the lookup (the server traces it
   * as part of that call's session).
   */
  readonly providerReportsFailure: (externalId: string, callId: string) => Promise<boolean>;
  /** Receives a failed lookup or update; the sweep carries on with the other calls. */
  readonly onError?: (error: unknown) => void;
  /** Hears each call the sweep ends, with its new status. */
  readonly onActivity?: ReportCallActivity;
}

export interface ReconcileStaleCallsResult {
  readonly checked: number;
  readonly ended: number;
}

/**
 * Recovers calls that never got their webhook: ElevenLabs never retries a
 * `call_initiation_failure`, so one that arrived before the call's conversation id was stored is
 * lost. Every call still open `staleAfterMs` after it was placed is checked: one the provider
 * reports as failed ends as `no_answer` (an attempt, so `planCallRound` can retry the provider),
 * and one that never got a conversation id at all (placement was interrupted) ends as `failed`.
 * Anything else is left for its webhook, which ElevenLabs retries.
 */
export async function reconcileStaleCalls(
  input: ReconcileStaleCallsInput,
): Promise<ReconcileStaleCallsResult> {
  const nowMillis = instantMillis(input.now, "now");
  const stale = (await input.calls.listOpen()).filter(
    (call) => nowMillis - instantMillis(call.createdAt, "createdAt") >= input.staleAfterMs,
  );

  let ended = 0;
  for (const call of stale) {
    try {
      const status =
        call.externalId === null
          ? "failed"
          : (await input.providerReportsFailure(call.externalId, call.id))
            ? "no_answer"
            : undefined;
      if (status === undefined) continue;
      const result = endCall(call, status, input.now);
      if (!result.ok) continue;
      const updated = await input.calls.update(result.call);
      if (updated.ok) {
        ended += 1;
        reportActivity(input.onActivity, {
          type: "call_status",
          callId: call.id,
          status,
          at: result.call.endedAt ?? input.now,
        });
      }
    } catch (error) {
      try {
        input.onError?.(error);
      } catch {
        // A failing logger must not stop the sweep.
      }
    }
  }
  return { checked: stale.length, ended };
}
