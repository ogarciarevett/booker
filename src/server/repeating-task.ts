import { type StartRepeatingTimer, startSystemTimer } from "./transcript-purge.ts";

export interface RepeatingTaskOptions {
  readonly intervalMs: number;
  readonly run: () => Promise<void>;
  readonly startTimer?: StartRepeatingTimer;
  /** Called when a run fails; the next tick tries again. */
  readonly onError?: (error: unknown) => void;
}

export interface RepeatingTask {
  /** Resolves once no run is in progress. */
  idle(): Promise<void>;
  /** Cancels the timer and waits for a run in progress, so the database can close after it. */
  stop(): Promise<void>;
}

/**
 * Runs `run` on every tick of a timer that never keeps the process alive. A tick that arrives
 * while a run is still going is skipped, and a failed run is reported and tried again next tick.
 */
export function scheduleRepeatingTask(options: RepeatingTaskOptions): RepeatingTask {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new RangeError(
      `scheduleRepeatingTask intervalMs must be a positive integer, got ${options.intervalMs}`,
    );
  }
  let running: Promise<void> | undefined;
  let stopped = false;

  function tick(): void {
    if (stopped || running !== undefined) return;
    running = options
      .run()
      .catch((error: unknown) => {
        try {
          options.onError?.(error);
        } catch {
          // A failing logger must not stop the schedule.
        }
      })
      .finally(() => {
        running = undefined;
      });
  }

  const timer = (options.startTimer ?? startSystemTimer)(tick, options.intervalMs);
  timer.unref();

  return {
    async idle() {
      await running;
    },
    async stop() {
      stopped = true;
      timer.cancel();
      await running;
    },
  };
}
