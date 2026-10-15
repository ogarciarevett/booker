// The live-update connection behind <LiveUpdates>, kept apart from React so it can be tested.
// It only ever talks to this app's own route: the browser never reaches Booker or the token.

export const EVENTS_PATH = "/api/events";
/** A browser `EventSource` gives up on an error response; this waits, then opens a new one. */
export const RECONNECT_AFTER_MS = 5_000;
const REFRESH_DEBOUNCE_MS = 250;
const CLOSED = 2;

export type Connection = "connecting" | "live" | "offline";

const WATCHED: Readonly<Record<"calls" | "settings" | "errands", readonly string[]>> = {
  calls: ["call_status"],
  settings: ["setting"],
  errands: ["call_status", "tool"],
};

export interface LiveActivity {
  readonly type: "call_status" | "tool" | "setting";
  /** Absent on a `setting` event. */
  readonly callId?: string;
  readonly status?: string;
  readonly tool?: string;
  readonly outcome?: string;
  /** A `setting` event's setting name and action (`saved` or `removed`); never a value. */
  readonly name?: string;
  readonly action?: string;
  readonly at: string;
}

/** The part of `EventSource` used here. */
export interface EventSourceLike {
  readonly readyState: number;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface LiveConnectionOptions {
  readonly open: () => EventSourceLike;
  /** Re-renders the page from the server. */
  readonly refresh: () => void;
  readonly onConnection: (state: Connection) => void;
  /** On a call page: only this call's activity counts, and each item is handed over. */
  readonly callId?: string;
  /**
   * What a page without `callId` follows: call status changes (`calls`, the default), setting
   * changes (`settings`), or both call status changes and tool outcomes (`errands`, since a
   * recorded quote changes an errand).
   */
  readonly watch?: "calls" | "settings" | "errands";
  readonly onActivity?: (activity: LiveActivity) => void;
}

/**
 * Follows Booker's activity and refreshes the page when it changes: on the list, for any call
 * status change; on a call page, for anything about that call; on the settings page, for any
 * setting saved or removed. Once the stream is back after
 * a drop (a `ready` that is not the first), the page is refreshed too, since whatever happened
 * meanwhile was missed. Returns the function that stops it.
 */
export function connectLive(options: LiveConnectionOptions): () => void {
  let source: EventSourceLike | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectedBefore = false;
  let stopped = false;

  const refresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(options.refresh, REFRESH_DEBOUNCE_MS);
  };
  const onActivity = (event: MessageEvent<string>) => {
    const activity = JSON.parse(event.data) as LiveActivity;
    if (options.callId === undefined) {
      if (WATCHED[options.watch ?? "calls"].includes(activity.type)) refresh();
      return;
    }
    if (activity.callId !== options.callId) return;
    options.onActivity?.(activity);
    refresh();
  };
  const connect = () => {
    const current = options.open();
    source = current;
    current.addEventListener("ready", () => {
      options.onConnection("live");
      if (connectedBefore) refresh();
      connectedBefore = true;
    });
    current.addEventListener("call_status", onActivity);
    current.addEventListener("tool", onActivity);
    current.addEventListener("setting", onActivity);
    current.onerror = () => {
      options.onConnection("offline");
      if (current.readyState === CLOSED && !stopped) {
        reconnectTimer = setTimeout(connect, RECONNECT_AFTER_MS);
      }
    };
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(refreshTimer);
    clearTimeout(reconnectTimer);
    source?.close();
  };
}
