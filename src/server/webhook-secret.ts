import { join } from "node:path";
import { readPrivateFile, writePrivateFile } from "./private-file.ts";

/**
 * `<repoRoot>/.local/secrets/elevenlabs-webhook-secret`: where `pnpm booker agent sync` keeps the
 * signing secret of a post-call webhook it had to create. `serve` reads it when
 * `ELEVENLABS_WEBHOOK_SECRET` is unset; a webhook made in the dashboard keeps its secret in `.env`.
 */
export function webhookSecretPath(repoRoot: string): string {
  return join(repoRoot, ".local", "secrets", "elevenlabs-webhook-secret");
}

/** The saved webhook secret, or `undefined` when there is none; refuses a shared file. */
export async function readSavedWebhookSecret(path: string): Promise<string | undefined> {
  const secret = await readPrivateFile(path);
  return secret === undefined || secret.length === 0 ? undefined : secret;
}

export async function saveWebhookSecret(path: string, secret: string): Promise<void> {
  await writePrivateFile(path, secret);
}
