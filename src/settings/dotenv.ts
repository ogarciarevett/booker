import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export type DotenvNames =
  | { readonly ok: true; readonly names: ReadonlySet<string> }
  | { readonly ok: false; readonly reason: string };

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown error";
}

/**
 * The names `.env` at `path` defines, parsed with Node's own `.env` parser (`util.parseEnv`, the
 * one `--env-file-if-exists` uses), so a setting can be labelled as coming from `.env` rather
 * than the shell. Only the names leave this function: the values are dropped at once, and the
 * value in effect is always the one in `process.env`. No file means no names.
 */
export async function readDotenvNames(path: string): Promise<DotenvNames> {
  try {
    const text = await readFile(path, "utf8");
    return { ok: true, names: new Set(Object.keys(parseEnv(text))) };
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" ? { ok: true, names: new Set() } : { ok: false, reason: code };
  }
}

/** What to tell the owner when `.env` could not be read; never a value. */
export function dotenvWarning(result: DotenvNames): string | undefined {
  return result.ok
    ? undefined
    : `Warning: .env could not be read (${result.reason}), so settings defined there are shown as coming from the environment.`;
}
