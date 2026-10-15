import "server-only";
import { type FetchFn, NO_TOKEN, notRunning, TOKEN_REFUSED } from "./booker.ts";

export interface EventsProxyOptions {
  readonly bookerUrl: string;
  readonly readToken: () => Promise<string | undefined>;
  readonly fetch: FetchFn;
}

function unavailable(error: string): Response {
  return Response.json({ error }, { status: 503 });
}

/**
 * `GET /api/events`: relays Booker's `GET /control/events` stream to the browser. The token is
 * added here, on the server, and none of Booker's response headers are passed on. The browser's
 * own abort signal closes the upstream request, so Booker drops the subscription when the tab
 * goes away.
 */
export function createEventsProxy(
  options: EventsProxyOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const token = await options.readToken();
    if (token === undefined) return unavailable(NO_TOKEN);
    let upstream: Response;
    try {
      upstream = await options.fetch(`${options.bookerUrl}/control/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        cache: "no-store",
        signal: request.signal,
      });
    } catch {
      return unavailable(notRunning(options.bookerUrl));
    }
    if (upstream.status === 401) return unavailable(TOKEN_REFUSED);
    if (!upstream.ok || upstream.body === null) {
      return unavailable(`Booker answered HTTP ${upstream.status} for its event stream.`);
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
