import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Connection,
  connectLive,
  type EventSourceLike,
  type LiveActivity,
  RECONNECT_AFTER_MS,
} from "./live-connection.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/** Stands in for the browser's EventSource. */
class FakeSource implements EventSourceLike {
  readyState = CONNECTING;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }

  emit(type: string, data: unknown = {}): void {
    if (type === "ready") this.readyState = OPEN;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }

  fail(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

const NOW = "2026-10-06T10:00:00.000Z";

describe("connectLive", () => {
  let sources: FakeSource[];
  let refreshes: number;
  let states: Connection[];
  let activity: LiveActivity[];

  function connect(callId?: string, watch?: "calls" | "settings" | "errands") {
    return connectLive({
      open: () => {
        const source = new FakeSource();
        sources.push(source);
        return source;
      },
      refresh: () => {
        refreshes += 1;
      },
      onConnection: (state) => states.push(state),
      onActivity: (item) => activity.push(item),
      ...(callId === undefined ? {} : { callId }),
      ...(watch === undefined ? {} : { watch }),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sources = [];
    refreshes = 0;
    states = [];
    activity = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("on the settings page, refreshes when a setting changes and ignores call activity", () => {
    connect(undefined, "settings");
    sources[0]?.emit("ready");
    sources[0]?.emit("call_status", {
      type: "call_status",
      callId: "call-1",
      status: "completed",
      at: NOW,
    });
    vi.runAllTimers();
    expect(refreshes).toBe(0);

    sources[0]?.emit("setting", {
      type: "setting",
      name: "BOOKER_OWNER_NAME",
      action: "saved",
      at: NOW,
    });
    vi.runAllTimers();
    expect(refreshes).toBe(1);
  });

  it("on the errand pages, refreshes on call status changes and on tool outcomes", () => {
    connect(undefined, "errands");
    sources[0]?.emit("ready");
    sources[0]?.emit("tool", { type: "tool", callId: "call-1", tool: "x", outcome: "ok", at: NOW });
    vi.runAllTimers();
    expect(refreshes).toBe(1);

    sources[0]?.emit("call_status", {
      type: "call_status",
      callId: "call-1",
      status: "completed",
      at: NOW,
    });
    vi.runAllTimers();
    expect(refreshes).toBe(2);
  });

  it("on the calls list, ignores setting changes", () => {
    connect();
    sources[0]?.emit("ready");
    sources[0]?.emit("setting", {
      type: "setting",
      name: "BOOKER_OWNER_NAME",
      action: "saved",
      at: NOW,
    });
    vi.runAllTimers();

    expect(refreshes).toBe(0);
  });

  it("goes live on the first ready without refreshing a page that was just rendered", () => {
    connect();
    sources[0]?.emit("ready");
    vi.runAllTimers();

    expect(states).toEqual(["live"]);
    expect(refreshes).toBe(0);
  });

  it("refreshes once the stream is back after a drop, since events were missed meanwhile", () => {
    connect();
    sources[0]?.emit("ready");
    sources[0]?.fail(CONNECTING);
    sources[0]?.emit("ready");
    vi.runAllTimers();

    expect(states).toEqual(["live", "offline", "live"]);
    expect(refreshes).toBe(1);
  });

  it("opens a new stream after the browser gave up, and refreshes when it is ready", () => {
    connect();
    sources[0]?.emit("ready");
    sources[0]?.fail(CLOSED);
    vi.advanceTimersByTime(RECONNECT_AFTER_MS);
    sources[1]?.emit("ready");
    vi.runAllTimers();

    expect(sources).toHaveLength(2);
    expect(refreshes).toBe(1);
  });

  it("refreshes for a status change on the list, and only for this call on a call page", () => {
    connect();
    sources[0]?.emit("ready");
    sources[0]?.emit("tool", { type: "tool", callId: "call-1", tool: "x", outcome: "ok", at: NOW });
    vi.runAllTimers();
    expect(refreshes).toBe(0);
    sources[0]?.emit("call_status", {
      type: "call_status",
      callId: "call-1",
      status: "completed",
      at: NOW,
    });
    vi.runAllTimers();
    expect(refreshes).toBe(1);

    refreshes = 0;
    connect("call-2");
    sources[1]?.emit("ready");
    sources[1]?.emit("call_status", {
      type: "call_status",
      callId: "call-1",
      status: "failed",
      at: NOW,
    });
    sources[1]?.emit("tool", { type: "tool", callId: "call-2", tool: "x", outcome: "ok", at: NOW });
    vi.runAllTimers();
    expect(activity).toEqual([
      { type: "tool", callId: "call-2", tool: "x", outcome: "ok", at: NOW },
    ]);
    expect(refreshes).toBe(1);
  });

  it("closes the stream and cancels pending work when stopped", () => {
    const stop = connect();
    sources[0]?.fail(CLOSED);
    stop();
    vi.advanceTimersByTime(RECONNECT_AFTER_MS * 2);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.closed).toBe(true);
  });
});
