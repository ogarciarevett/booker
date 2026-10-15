import { describe, expect, it } from "vitest";
import { InMemoryTranscriptStore } from "../calls/adapters/in-memory-transcript-store.ts";
import type { TranscriptStore } from "../calls/transcript-store.ts";
import { type StartRepeatingTimer, scheduleTranscriptPurge } from "./transcript-purge.ts";

const NOW = "2026-10-06T10:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

function daysAfter(instant: string, days: number): string {
  return new Date(Date.parse(instant) + days * DAY_MS).toISOString();
}

/** A timer the test fires by hand, recording how the schedule used it. */
function fakeTimer() {
  const state = {
    callback: undefined as (() => void) | undefined,
    intervalMs: undefined as number | undefined,
    unrefed: false,
    cancelled: false,
  };
  const start: StartRepeatingTimer = (callback, intervalMs) => {
    state.callback = callback;
    state.intervalMs = intervalMs;
    return {
      unref: () => {
        state.unrefed = true;
      },
      cancel: () => {
        state.cancelled = true;
      },
    };
  };
  return {
    start,
    state,
    tick: () => {
      if (state.callback === undefined) throw new Error("the timer was never started");
      state.callback();
    },
  };
}

async function storeWith(
  transcripts: readonly { callId: string; receivedAt: string }[],
): Promise<InMemoryTranscriptStore> {
  const store = new InMemoryTranscriptStore();
  for (const { callId, receivedAt } of transcripts) {
    await store.save({
      callId,
      receivedAt,
      turns: [{ role: "user", message: "Fictional line.", secondsIntoCall: 1 }],
    });
  }
  return store;
}

/** A store whose purge waits until the test releases it. */
function blockedStore() {
  let release: () => void = () => {};
  let calls = 0;
  const store: TranscriptStore = {
    save: async () => {},
    findByCallId: async () => undefined,
    purgeReceivedBefore: () => {
      calls += 1;
      return new Promise<number>((resolve) => {
        release = () => resolve(0);
      });
    },
  };
  return { store, release: () => release(), calls: () => calls };
}

describe("scheduleTranscriptPurge", () => {
  it("purges expired transcripts on start and then on every tick of an unref'd timer", async () => {
    const transcripts = await storeWith([
      { callId: "call-old", receivedAt: daysAfter(NOW, -31) },
      { callId: "call-recent", receivedAt: daysAfter(NOW, -1) },
    ]);
    const timer = fakeTimer();
    const purged: number[] = [];
    let now = NOW;

    const schedule = scheduleTranscriptPurge({
      transcripts,
      retentionDays: 30,
      intervalMs: HOUR_MS,
      now: () => now,
      startTimer: timer.start,
      onPurged: (count) => purged.push(count),
    });
    await schedule.idle();

    expect(await transcripts.findByCallId("call-old")).toBeUndefined();
    expect(await transcripts.findByCallId("call-recent")).toBeDefined();
    expect(timer.state.intervalMs).toBe(HOUR_MS);
    expect(timer.state.unrefed).toBe(true);

    now = daysAfter(NOW, 30);
    timer.tick();
    await schedule.idle();

    expect(await transcripts.findByCallId("call-recent")).toBeUndefined();
    expect(purged).toEqual([1, 1]);

    await schedule.stop();
    expect(timer.state.cancelled).toBe(true);
  });

  it("reports a failed purge and tries again on the next tick", async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const transcripts: TranscriptStore = {
      save: async () => {},
      findByCallId: async () => undefined,
      purgeReceivedBefore: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database is locked");
        return 2;
      },
    };
    const timer = fakeTimer();
    const purged: number[] = [];

    const schedule = scheduleTranscriptPurge({
      transcripts,
      retentionDays: 30,
      intervalMs: HOUR_MS,
      now: () => NOW,
      startTimer: timer.start,
      onPurged: (count) => purged.push(count),
      onError: (error) => errors.push(error),
    });
    await schedule.idle();
    timer.tick();
    await schedule.idle();

    expect(errors).toEqual([new Error("database is locked")]);
    expect(purged).toEqual([2]);
    await schedule.stop();
  });

  it("skips a tick while the previous purge is still running", async () => {
    const blocked = blockedStore();
    const timer = fakeTimer();

    const schedule = scheduleTranscriptPurge({
      transcripts: blocked.store,
      retentionDays: 30,
      intervalMs: HOUR_MS,
      now: () => NOW,
      startTimer: timer.start,
    });
    timer.tick();
    blocked.release();
    await schedule.idle();

    expect(blocked.calls()).toBe(1);
    await schedule.stop();
  });

  it("stops by cancelling the timer, waiting for a running purge, and ignoring later ticks", async () => {
    const blocked = blockedStore();
    const timer = fakeTimer();
    const schedule = scheduleTranscriptPurge({
      transcripts: blocked.store,
      retentionDays: 30,
      intervalMs: HOUR_MS,
      now: () => NOW,
      startTimer: timer.start,
    });

    let stopped = false;
    const stopping = schedule.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(timer.state.cancelled).toBe(true);
    expect(stopped).toBe(false);

    blocked.release();
    await stopping;
    timer.tick();
    await schedule.idle();
    expect(blocked.calls()).toBe(1);
  });

  it.each([0, -1, 1.5])("rejects a retention of %s days before starting any timer", (days) => {
    const timer = fakeTimer();

    expect(() =>
      scheduleTranscriptPurge({
        transcripts: new InMemoryTranscriptStore(),
        retentionDays: days,
        intervalMs: HOUR_MS,
        now: () => NOW,
        startTimer: timer.start,
      }),
    ).toThrow(RangeError);
    expect(timer.state.callback).toBeUndefined();
  });
});
