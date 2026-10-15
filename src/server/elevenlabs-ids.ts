import { join } from "node:path";
import { z } from "zod";
import { readPrivateFile, writePrivateFile } from "./private-file.ts";

/**
 * The ElevenLabs ids Booker created or found: written by `pnpm booker agent sync` and
 * `pnpm booker phone import`, read by the server to place calls. Ids are not secrets, but the
 * file stays private (0600) like everything else in `.local/secrets`' neighborhood.
 */
const elevenLabsIdsSchema = z.object({
  toolsKeySecretId: z.string().min(1).optional(),
  toolIds: z.record(z.string(), z.string().min(1)).optional(),
  postCallWebhookId: z.string().min(1).optional(),
  agentIds: z.object({ quote: z.string().min(1), commit: z.string().min(1) }).optional(),
  llm: z.string().min(1).optional(),
  phoneNumberId: z.string().min(1).optional(),
});

export type ElevenLabsIds = z.infer<typeof elevenLabsIdsSchema>;

/** `<repoRoot>/.local/elevenlabs.json`. */
export function elevenLabsIdsPath(repoRoot: string): string {
  return join(repoRoot, ".local", "elevenlabs.json");
}

/** The saved ids, or none when nothing was synced yet. A corrupt file is refused, not replaced. */
export async function readElevenLabsIds(path: string): Promise<ElevenLabsIds> {
  const content = await readPrivateFile(path);
  if (content === undefined) return {};
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or delete it, then run agent sync again`);
  }
  const parsed = elevenLabsIdsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path} does not hold ElevenLabs ids; fix or delete it, then sync again`);
  }
  return parsed.data;
}

/** Merges `ids` into the saved ones, keeping whatever `ids` does not mention. */
export async function saveElevenLabsIds(path: string, ids: ElevenLabsIds): Promise<ElevenLabsIds> {
  const merged = { ...(await readElevenLabsIds(path)), ...ids };
  await writePrivateFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
