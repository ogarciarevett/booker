import { purgeExpiredTranscripts } from "../calls/retention.ts";
import type { TranscriptStore } from "../calls/transcript-store.ts";

export interface RepeatingTimer {
  /** Lets the process exit while the timer is still scheduled. */
  unref(): void;
  cancel(): void;
}

/** Calls `callback` every `intervalMs` until cancelled; injected so tests fire it by hand. */
export type StartRepeatingTimer = (callback: () => void, intervalMs: number) => RepeatingTimer;

export const startSystemTimer: StartRepeatingTimer = (callback, intervalMs) => {
  const timer = setInterval(callback, intervalMs);
  return {
    unref: () => {
      timer.unref();
    },
    cancel: () => {
      clearInterval(timer);
    },
  };
};

export interface TranscriptPurgeOptions {
  readonly transcripts: TranscriptStore;
  readonly retentionDays: number;
  readonly intervalMs: number;
  readonly now: () => string;
  readonly startTimer?: StartRepeatingTimer;
  /** Called after every successful purge with how many transcripts it removed. */
  readonly onPurged?: (count: number) => void;
  /** Called when a purge fails; the next tick tries again. */
  readonly onError?: (error: unknown) => void;
}

export interface TranscriptPurgeSchedule {
  /** Resolves once no purge is running. */
  idle(): Promise<void>;
  /** Cancels the timer and waits for a running purge, so the database can close after it. */
  stop(): Promise<void>;
}

/**
 * Runs `purgeExpiredTranscripts` once right away and then every `intervalMs`, on a timer that
 * never keeps the process alive. A tick that arrives while a purge is still running is skipped,
 * and a failed purge is reported and retried on the next tick. A retention period that is not a
 * positive whole number of days throws here, before any timer starts.
 */
export function scheduleTranscriptPurge(options: TranscriptPurgeOptions): TranscriptPurgeSchedule {
  if (!Number.isInteger(options.retentionDays) || options.retentionDays <= 0) {
    throw new RangeError(
      `scheduleTranscriptPurge retentionDays must be a positive integer, got ${options.retentionDays}`,
    );
  }
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new RangeError(
      `scheduleTranscriptPurge intervalMs must be a positive integer, got ${options.intervalMs}`,
    );
  }

  let running: Promise<void> | undefined;
  let stopped = false;

  function notify<T>(callback: ((value: T) => void) | undefined, value: T): void {
    try {
      callback?.(value);
    } catch {
      // A failing logger must not stop the schedule.
    }
  }

  async function purgeOnce(): Promise<void> {
    try {
      const count = await purgeExpiredTranscripts({
        transcripts: options.transcripts,
        now: options.now(),
        retentionDays: options.retentionDays,
      });
      notify(options.onPurged, count);
    } catch (error) {
      notify(options.onError, error);
    }
  }

  function run(): void {
    if (stopped || running !== undefined) return;
    running = purgeOnce().finally(() => {
      running = undefined;
    });
  }

  const timer = (options.startTimer ?? startSystemTimer)(run, options.intervalMs);
  timer.unref();
  run();

  async function idle(): Promise<void> {
    await running;
  }

  return {
    idle,
    async stop() {
      stopped = true;
      timer.cancel();
      await idle();
    },
  };
}
