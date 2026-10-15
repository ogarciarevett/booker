import type { CallStatus } from "./call.ts";
import type { VoiceToolName } from "./tools.ts";

/**
 * What just happened to a call, for anyone watching live (the dashboard, through
 * `GET /control/events`). Ids, statuses, and tool names only: never a token, a phone number, or
 * anything anyone said.
 */
export type CallActivity =
  | {
      readonly type: "call_status";
      readonly callId: string;
      readonly status: CallStatus;
      readonly at: string;
    }
  | {
      readonly type: "tool";
      readonly callId: string;
      readonly tool: VoiceToolName;
      /** `ok`, or the error the tool answered with (`forbidden`, `invalid_request`, `conflict`). */
      readonly outcome: string;
      readonly at: string;
    };

/** Port: receives call activity as it happens. */
export type ReportCallActivity = (activity: CallActivity) => void;

/** Reports `activity` when someone listens; a failing listener never changes what a call does. */
export function reportActivity(
  report: ReportCallActivity | undefined,
  activity: CallActivity,
): void {
  try {
    report?.(activity);
  } catch {
    // Watching a call must never break it.
  }
}

/** `T` lets a live view carry other activity beside calls' (the control stream adds settings). */
export interface CallActivitySubscriber<T = CallActivity> {
  readonly onActivity: (activity: T) => void;
  /** The source closed (the server is stopping): end the subscription. */
  readonly onClose: () => void;
}

/** Port: where call activity is reported, and how a live view subscribes to it. */
export interface CallActivitySource<T = CallActivity> {
  readonly report: (activity: T) => void;
  /** Returns the function that unsubscribes. */
  subscribe(subscriber: CallActivitySubscriber<T>): () => void;
}
