import type { FetchHandler } from "./http-server.ts";

const MAX_ERROR_LENGTH = 300;
const MAX_PATH_LENGTH = 200;

function firstLine(text: string): string {
  return text.split(/\r\n|\r|\n/u, 1)[0] ?? "";
}

function summary(error: Error): string {
  return `${error.name}: ${firstLine(error.message)}`;
}

/** Drops control characters (so a line stays one line) and caps the length by code points. */
function printable(text: string, maxLength: number): string {
  const characters = Array.from(text).filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
  });
  return characters.length <= maxLength
    ? characters.join("")
    : `${characters.slice(0, maxLength - 1).join("")}…`;
}

/**
 * One log-safe line for an unexpected error: its name and the first line of its message, plus
 * the same for its cause. Later lines are dropped because they are where data goes: a Drizzle
 * query error, for one, lists the query's parameters (transcript text, tokens) on its second
 * line. `secrets` are replaced with `[redacted]` before anything is cut, so no part of one is
 * left behind. A thrown value that is not an `Error` is never printed at all.
 */
export function describeError(error: unknown, secrets: readonly string[]): string {
  if (!(error instanceof Error)) return `a non-Error value was thrown (${typeof error})`;
  let text = summary(error);
  if (error.cause instanceof Error) text += ` (cause: ${summary(error.cause)})`;
  for (const secret of secrets) {
    if (secret.length > 0) text = text.replaceAll(secret, "[redacted]");
  }
  return printable(text, MAX_ERROR_LENGTH);
}

/**
 * Wraps `fetch` to log one line per request once it is answered: method, path (percent-encoded,
 * without the query string), status, and duration. Never headers, bodies, or query values,
 * which is where keys, call tokens, and personal data travel. It wraps the whole app rather
 * than running as Hono middleware, because middleware never runs for a path the router cannot
 * match (one with an encoded line break, say), and those requests deserve a line too.
 */
export function withRequestLog(fetch: FetchHandler, log: (line: string) => void): FetchHandler {
  return async (request) => {
    const started = performance.now();
    const response = await fetch(request);
    const durationMs = Math.round(performance.now() - started);
    const path = printable(new URL(request.url).pathname, MAX_PATH_LENGTH);
    try {
      log(`${request.method} ${path} ${response.status} ${durationMs}ms`);
    } catch {
      // A failing logger must not change the response.
    }
    return response;
  };
}
