import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readPrivateFile, writePrivateFile } from "./private-file.ts";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `<repoRoot>/.local/secrets/control-token`: the bearer token of the local control routes. */
export function controlTokenPath(repoRoot: string): string {
  return join(repoRoot, ".local", "secrets", "control-token");
}

/** The stored control token, or `undefined` when the server never ran; refuses a shared file. */
export async function readControlToken(path: string): Promise<string | undefined> {
  const token = await readPrivateFile(path);
  if (token === undefined) return undefined;
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(`${path} is not a valid control token. Delete it and start the server again.`);
  }
  return token;
}

/**
 * The token `pnpm booker call` sends to the server's control routes, generated on the server's
 * first start (32 random bytes, base64url, in a 0600 file) and reused after. It never leaves this
 * machine: the control routes are not behind Tailscale Funnel.
 */
export async function ensureControlToken(
  path: string,
): Promise<{ readonly token: string; readonly created: boolean }> {
  const existing = await readControlToken(path);
  if (existing !== undefined) return { token: existing, created: false };
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  await writePrivateFile(path, token);
  return { token, created: true };
}
