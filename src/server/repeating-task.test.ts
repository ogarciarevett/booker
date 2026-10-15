import { describe, expect, it } from "vitest";
import { scheduleRepeatingTask } from "./repeating-task.ts";
import type { StartRepeatingTimer } from "./transcript-purge.ts";

function fakeTimer() {
  let callback: (() => void) | undefined;
  let cancelled = false;
  let unrefed = false;
  const start: StartRepeatingTimer = (tick) => {
    callback = tick;
    return {
      unref: () => {
        unrefed = true;
      },
      cancel: () => {
        cancelled = true;
      },
    };
  };
  return {
    start,
    tick: () => callback?.(),
    cancelled: () => cancelled,
    unrefed: () => unrefed,
  };
}

describe("scheduleRepeatingTask", () => {
  it("runs on every tick of an unref'd timer, never twice at once, and reports failures", async () => {
    const timer = fakeTimer();
    const errors: unknown[] = [];
    let runs = 0;
    let release: () => void = () => {};
    const schedule = scheduleRepeatingTask({
      intervalMs: 60_000,
      startTimer: timer.start,
      run: async () => {
        runs += 1;
        if (runs === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new Error("lookup failed");
        }
      },
      onError: (error) => errors.push(error),
    });

    timer.tick();
    timer.tick();
    expect(runs).toBe(1);
    release();
    await schedule.idle();
    timer.tick();
    await schedule.idle();

    expect(runs).toBe(2);
    expect(errors).toEqual([new Error("lookup failed")]);
    expect(timer.unrefed()).toBe(true);
    await schedule.stop();
    expect(timer.cancelled()).toBe(true);
  });

  it("waits for a running task on stop, and ignores later ticks", async () => {
    const timer = fakeTimer();
    let runs = 0;
    let release: () => void = () => {};
    const schedule = scheduleRepeatingTask({
      intervalMs: 60_000,
      startTimer: timer.start,
      run: () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    timer.tick();

    let stopped = false;
    const stopping = schedule.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    timer.tick();

    expect(runs).toBe(1);
  });
});
