import "server-only";
import type { PhoenixLink } from "../types.ts";
import type { FetchFn } from "./booker.ts";

const LOOKUP_TIMEOUT_MS = 1_500;

/** Phoenix ids are base64 (`UHJvamVjdDoy`), used as is in its UI paths; only `/` needs escaping. */
function segment(id: string): string {
  return id.replaceAll("/", "%2F");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The Phoenix page of the call's session. Booker files every span of a call under
 * `session.id` = the call id, and Phoenix's `GET /v1/sessions/{session_id}` returns the ids its
 * UI uses in `/projects/{project}/sessions/{session}`. A Phoenix that is down or slow only costs
 * the link, never the page.
 */
export async function phoenixLink(
  phoenixUrl: string,
  callId: string,
  fetch: FetchFn = (url, init) => globalThis.fetch(url, init),
): Promise<PhoenixLink> {
  try {
    const response = await fetch(`${phoenixUrl}/v1/sessions/${encodeURIComponent(callId)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (response.status === 404) return { kind: "missing", phoenixUrl };
    if (response.ok) {
      const body: unknown = await response.json();
      const data =
        typeof body === "object" && body !== null && "data" in body ? body.data : undefined;
      if (typeof data === "object" && data !== null && "id" in data && "project_id" in data) {
        const session = text(data.id);
        const project = text(data.project_id);
        if (session !== undefined && project !== undefined) {
          return {
            kind: "session",
            url: `${phoenixUrl}/projects/${segment(project)}/sessions/${segment(session)}`,
          };
        }
      }
    }
  } catch {
    // Unreachable, timed out, or not JSON: treated alike below.
  }
  return { kind: "unreachable", phoenixUrl };
}
