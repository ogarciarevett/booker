"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { type Connection, connectLive, EVENTS_PATH, type LiveActivity } from "./live-connection.ts";

const CONNECTION_LABELS: Readonly<Record<Connection, string>> = {
  connecting: "Connecting to live updates…",
  live: "Live",
  offline: "Live updates paused: Booker is not reachable. Retrying…",
};

function describe(activity: LiveActivity): string {
  return activity.type === "tool"
    ? `${activity.tool ?? "tool"}: ${activity.outcome ?? ""}`
    : `status: ${activity.status ?? ""}`;
}

/**
 * Re-renders the page from the server when Booker reports call or settings activity (see
 * live-connection.ts), shows whether updates are live, and on a call page lists that call's
 * activity as it arrives.
 */
export function LiveUpdates({
  callId,
  watch,
}: {
  readonly callId?: string;
  readonly watch?: "calls" | "settings" | "errands";
}) {
  const router = useRouter();
  const [connection, setConnection] = useState<Connection>("connecting");
  const [recent, setRecent] = useState<readonly LiveActivity[]>([]);

  useEffect(
    () =>
      connectLive({
        open: () => new EventSource(EVENTS_PATH),
        refresh: () => router.refresh(),
        onConnection: setConnection,
        onActivity: (activity) => setRecent((items) => [activity, ...items].slice(0, 20)),
        ...(callId === undefined ? {} : { callId }),
        ...(watch === undefined ? {} : { watch }),
      }),
    [callId, watch, router],
  );

  return (
    <div className="flex flex-col items-end gap-2">
      <p
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-xs text-muted-foreground"
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-2 rounded-full",
            connection === "live" ? "bg-status-success" : null,
            connection === "offline" ? "bg-status-danger" : null,
            connection === "connecting" ? "bg-status-neutral motion-safe:animate-pulse" : null,
          )}
        />
        {CONNECTION_LABELS[connection]}
      </p>
      {callId !== undefined && recent.length > 0 ? (
        <ol
          aria-label="Activity while this page is open"
          className="space-y-1 text-right font-mono text-xs text-muted-foreground"
        >
          {recent.map((activity) => (
            <li key={`${activity.at}-${activity.type}-${describe(activity)}`}>
              <time dateTime={activity.at}>{new Date(activity.at).toLocaleTimeString()}</time>{" "}
              {describe(activity)}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
