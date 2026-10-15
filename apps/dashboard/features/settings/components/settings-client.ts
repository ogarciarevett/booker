// The browser side of saving a setting. It only ever calls this app's own /api/settings route:
// the control token and Booker's address stay on the server.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** Saves `value` for `name`, or removes the saved value when `value` is `null`. */
export async function writeSetting(
  fetchFn: FetchLike,
  name: string,
  value: string | null,
): Promise<WriteResult> {
  const url = `/api/settings/${encodeURIComponent(name)}`;
  const init: RequestInit =
    value === null
      ? { method: "DELETE", cache: "no-store" }
      : {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
          cache: "no-store",
        };
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch {
    return { ok: false, message: "The dashboard could not be reached. Is it still running?" };
  }
  if (response.ok) return { ok: true };
  const body = (await response.json().catch(() => undefined)) as { detail?: unknown } | undefined;
  return {
    ok: false,
    message:
      typeof body?.detail === "string"
        ? body.detail
        : `The dashboard could not save it (HTTP ${response.status}).`,
  };
}
