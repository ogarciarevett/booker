import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
/** Any permission bit for the group or other users. */
const SHARED_MODE_BITS = 0o077;

/** A private file Booker will not use because other users can read or write it. */
export class PrivateFileError extends Error {
  override readonly name = "PrivateFileError";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/**
 * The trimmed content of a file only its owner may read, or `undefined` when there is none. Like
 * the voice-tools key, a file other users could read or write is refused rather than tightened:
 * it may already have leaked, and only the owner can decide what to rotate.
 */
export async function readPrivateFile(path: string): Promise<string | undefined> {
  let mode: number;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if ((mode & SHARED_MODE_BITS) !== 0) {
    throw new PrivateFileError(
      `${path} is open to other users (mode ${mode.toString(8)}). Run \`chmod 600 ${path}\` ` +
        "and try again, or, if someone else may have read it, replace what it holds.",
    );
  }
  return (await readFile(path, "utf8")).trim();
}

/**
 * Writes `content` to a file only its owner can read (mode 0600, in a 0700 directory): in full
 * under a temporary name first, then renamed into place, so a reader never sees half a file.
 */
export async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode: FILE_MODE, flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
