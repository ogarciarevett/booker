// Who may talk to this dashboard. It shows transcripts and bookings and holds Booker's control
// token on its server side, so it must answer only pages opened at its own loopback address.
// Used by proxy.ts for every request; no data and no token here.

const DEFAULT_PORT = "3100";
/** Fetches a page or the event stream from this same origin, or typed into the address bar. */
const SAME_ORIGIN_SITES = new Set(["same-origin", "none"]);
const READ_METHODS = new Set(["GET", "HEAD"]);

export interface GuardInput {
  readonly method: string;
  readonly pathname: string;
  readonly headers: Headers;
}

export type GuardVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 403 | 421; readonly reason: string };

/** The port Next.js serves on: it sets `PORT` from `-p`; 3100 is what `pnpm dashboard` uses. */
export function dashboardPort(env: Readonly<Record<string, string | undefined>>): string {
  const port = env["PORT"];
  return port !== undefined && /^[0-9]{1,5}$/.test(port) ? port : DEFAULT_PORT;
}

export function misdirected(port: string): string {
  return `This dashboard only answers at http://127.0.0.1:${port} or http://localhost:${port}.`;
}

const CROSS_SITE = "This dashboard does not answer requests from other sites.";

/**
 * Decides whether a request may reach a page or route:
 *
 * - `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`, or the answer is 421. A
 *   DNS-rebinding page reaches 127.0.0.1 under its own host name, so it is refused here.
 * - The event stream (`/api/*`) and anything but GET or HEAD must come from this origin: a
 *   cross-site or same-site `Sec-Fetch-Site`, or a foreign `Origin`, is a 403.
 * - Pages may be opened from a link elsewhere (a top-level navigation), but another site may not
 *   frame or fetch them.
 */
export function guardRequest(input: GuardInput, port: string): GuardVerdict {
  const host = (input.headers.get("host") ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { allowed: false, status: 421, reason: misdirected(port) };
  }

  const origin = input.headers.get("origin");
  if (origin !== null && origin !== `http://${host}`) {
    return { allowed: false, status: 403, reason: CROSS_SITE };
  }
  const site = input.headers.get("sec-fetch-site");
  if (site === null || SAME_ORIGIN_SITES.has(site)) return { allowed: true };

  const strict = input.pathname.startsWith("/api/") || !READ_METHODS.has(input.method);
  const opensPage =
    input.headers.get("sec-fetch-mode") === "navigate" &&
    input.headers.get("sec-fetch-dest") === "document";
  return !strict && opensPage
    ? { allowed: true }
    : { allowed: false, status: 403, reason: CROSS_SITE };
}
