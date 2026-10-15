import { describe, expect, it } from "vitest";
import type { CallActivity } from "../call-activity.ts";
import { InProcessActivityFeed } from "./in-process-activity-feed.ts";

const PLACED: CallActivity = {
  type: "call_status",
  callId: "call-1",
  status: "in_progress",
  at: "2026-10-06T10:00:00.000Z",
};
const TOOL: CallActivity = {
  type: "tool",
  callId: "call-1",
  tool: "record_quote_field",
  outcome: "ok",
  at: "2026-10-06T10:00:05.000Z",
};

describe("InProcessActivityFeed", () => {
  it("hands every report to every subscriber, in order, until it unsubscribes", () => {
    const feed = new InProcessActivityFeed();
    const first: CallActivity[] = [];
    const second: CallActivity[] = [];
    const stopFirst = feed.subscribe({ onActivity: (a) => first.push(a), onClose: () => {} });
    feed.subscribe({ onActivity: (a) => second.push(a), onClose: () => {} });

    feed.report(PLACED);
    stopFirst();
    feed.report(TOOL);

    expect(first).toEqual([PLACED]);
    expect(second).toEqual([PLACED, TOOL]);
    expect(feed.subscriberCount()).toBe(1);
  });

  it("never lets a failing subscriber stop the report or reach the reporter", () => {
    const feed = new InProcessActivityFeed();
    const received: CallActivity[] = [];
    feed.subscribe({
      onActivity: () => {
        throw new Error("subscriber broke");
      },
      onClose: () => {},
    });
    feed.subscribe({ onActivity: (a) => received.push(a), onClose: () => {} });

    expect(() => feed.report(PLACED)).not.toThrow();
    expect(received).toEqual([PLACED]);
  });

  it("tells every subscriber it closed, drops them, and closes later subscribers at once", () => {
    const feed = new InProcessActivityFeed();
    const closed: string[] = [];
    feed.subscribe({ onActivity: () => {}, onClose: () => closed.push("early") });

    feed.close();
    feed.subscribe({ onActivity: () => {}, onClose: () => closed.push("late") });
    feed.report(PLACED);

    expect(closed).toEqual(["early", "late"]);
    expect(feed.subscriberCount()).toBe(0);
  });
});
