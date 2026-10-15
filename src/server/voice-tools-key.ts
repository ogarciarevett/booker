import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 32 random bytes: exactly 43 base64url characters, the only shape Booker ever generates. */
const KEY_BYTES = 32;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
/** Any permission bit for the group or other users. */
const SHARED_MODE_BITS = 0o077;

/** A key file Booker will not use: shared with other users, or not a key. */
export class VoiceToolsKeyError extends Error {
  override readonly name = "VoiceToolsKeyError";
}

export interface EnsuredVoiceToolsKey {
  readonly key: string;
  /** True only on the start that generated the key. */
  readonly created: boolean;
}

/** `<repoRoot>/.local/secrets/voice-tools-key`: ignored by git, like everything in `.local/`. */
export function voiceToolsKeyPath(repoRoot: string): string {
  return join(repoRoot, ".local", "secrets", "voice-tools-key");
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * The key stored at `path`, or `undefined` when there is no file. Like OpenSSH with a private
 * key, a file that other users could read or write is refused rather than silently tightened:
 * the key may already have leaked, and only the owner can decide whether to rotate it. A file
 * that does not hold a key is refused too, rather than replaced, since ElevenLabs keeps a copy.
 */
async function readKeyIfPresent(path: string): Promise<string | undefined> {
  let mode: number;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if ((mode & SHARED_MODE_BITS) !== 0) {
    throw new VoiceToolsKeyError(
      `The voice-tools key file ${path} is open to other users (mode ${mode.toString(8)}). ` +
        `Run \`chmod 600 ${path}\` and start again, or, if someone else may have read it, ` +
        "delete it so a new key is generated and push that one to ElevenLabs again.",
    );
  }
  const key = (await readFile(path, "utf8")).trim();
  if (!KEY_PATTERN.test(key)) {
    throw new VoiceToolsKeyError(
      `${path} is not a valid voice-tools key. Delete it so a new key is generated, ` +
        "then push that one to ElevenLabs again.",
    );
  }
  return key;
}

/**
 * The key the voice runtime sends in `X-Booker-Tools-Key`, generated on the first start and
 * reused on every later one. The file is written in full under a temporary name and then
 * hard-linked into place, so two starts racing each other share one complete key. The key is
 * never logged or printed; `pnpm booker agent sync` reads it with `readVoiceToolsKey`.
 */
export async function ensureVoiceToolsKey(path: string): Promise<EnsuredVoiceToolsKey> {
  const existing = await readKeyIfPresent(path);
  if (existing !== undefined) return { key: existing, created: false };

  await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  const key = randomBytes(KEY_BYTES).toString("base64url");
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, key, { mode: FILE_MODE, flag: "wx" });
    await link(temporaryPath, path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    // Another start linked its key first: use that one.
    return { key: await readVoiceToolsKey(path), created: false };
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { key, created: true };
}

/** The stored key, for pushing to ElevenLabs. Never generates one. */
export async function readVoiceToolsKey(path: string): Promise<string> {
  const key = await readKeyIfPresent(path);
  if (key === undefined) {
    throw new VoiceToolsKeyError(
      `There is no voice-tools key at ${path}. Run \`pnpm booker serve\` once to generate it.`,
    );
  }
  return key;
}
