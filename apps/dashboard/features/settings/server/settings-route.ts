import "server-only";
import { type BookerClient, BookerUnavailableError } from "@/lib/server/booker.ts";

// The write side of the Settings page: the browser calls this app's own /api/settings/<name>,
// and this forwards the change to Booker with the control token added here, on the server.
// proxy.ts has already refused any request from another site or host before it gets here.

/** A catalog name such as `ELEVENLABS_API_KEY`; Booker checks it against the catalog itself. */
const SETTING_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Booker accepts values up to 4096 characters; this is room for that plus the JSON around it. */
const MAX_BODY_BYTES = 16 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function answer(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

type SettingsWriter = Pick<BookerClient, "saveSetting" | "removeSetting">;

/**
 * `PUT /api/settings/<name>` `{ value }` saves a setting and `DELETE` removes it, through Booker's
 * control API. Booker's own refusals (an invalid value, a value from `.env`) come back with their
 * status and message. Only `application/json` is accepted, which a cross-site form cannot send,
 * and no answer ever repeats the submitted value.
 */
export function createSettingsWriteHandler(booker: SettingsWriter) {
  return async (method: "PUT" | "DELETE", name: string, request: Request): Promise<Response> => {
    if (!SETTING_NAME.test(name)) return answer({ error: "unknown_setting" }, 404);
    let value: string | undefined;
    if (method === "PUT") {
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        return answer({ error: "unsupported_media_type" }, 415);
      }
      const text = await request.text();
      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
        return answer({ error: "payload_too_large" }, 413);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return answer({ error: "invalid_request" }, 400);
      }
      const submitted = (json as { value?: unknown } | null)?.value;
      if (typeof submitted !== "string") return answer({ error: "invalid_request" }, 400);
      value = submitted;
    }

    try {
      const result =
        value === undefined
          ? await booker.removeSetting(name)
          : await booker.saveSetting(name, value);
      if (result.ok)
        return answer(result.setting === undefined ? {} : { setting: result.setting }, 200);
      return answer(
        { error: result.error, ...(result.detail === undefined ? {} : { detail: result.detail }) },
        result.status,
      );
    } catch (error) {
      if (!(error instanceof BookerUnavailableError)) throw error;
      return answer({ error: "booker_unavailable", detail: error.message }, 503);
    }
  };
}
