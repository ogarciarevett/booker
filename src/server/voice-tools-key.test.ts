import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureVoiceToolsKey, readVoiceToolsKey, voiceToolsKeyPath } from "./voice-tools-key.ts";

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("voice-tools key", () => {
  let root: string;
  let keyPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "booker-voice-tools-key-"));
    keyPath = voiceToolsKeyPath(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lives in .local/secrets under the repository root", () => {
    expect(voiceToolsKeyPath("/work/booker")).toBe("/work/booker/.local/secrets/voice-tools-key");
  });

  it("is generated once: 32 random bytes as base64url, in a 0600 file inside a 0700 directory", async () => {
    const ensured = await ensureVoiceToolsKey(keyPath);

    expect(ensured.created).toBe(true);
    expect(ensured.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(ensured.key, "base64url")).toHaveLength(32);
    expect(readFileSync(keyPath, "utf8")).toBe(ensured.key);
    expect(modeOf(keyPath)).toBe(0o600);
    expect(modeOf(dirname(keyPath))).toBe(0o700);
  });

  it("is reused on later starts, never regenerated", async () => {
    const first = await ensureVoiceToolsKey(keyPath);
    const second = await ensureVoiceToolsKey(keyPath);

    expect(second).toEqual({ key: first.key, created: false });
    expect(readFileSync(keyPath, "utf8")).toBe(first.key);
  });

  it("differs between two fresh repositories", async () => {
    const other = mkdtempSync(join(tmpdir(), "booker-voice-tools-key-"));
    try {
      const mine = await ensureVoiceToolsKey(keyPath);
      const theirs = await ensureVoiceToolsKey(voiceToolsKeyPath(other));
      expect(theirs.key).not.toBe(mine.key);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("creates exactly one key when two starts race", async () => {
    const [a, b] = await Promise.all([ensureVoiceToolsKey(keyPath), ensureVoiceToolsKey(keyPath)]);

    expect(a.key).toBe(b.key);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });

  it("is read back unchanged for `agent sync`", async () => {
    const { key } = await ensureVoiceToolsKey(keyPath);

    await expect(readVoiceToolsKey(keyPath)).resolves.toBe(key);
  });

  it("is never invented by a read: a missing key file says how to create it", async () => {
    await expect(readVoiceToolsKey(keyPath)).rejects.toThrow(/pnpm booker serve/);
  });

  it.each([0o644, 0o640, 0o604, 0o660])(
    "is refused when the file mode is %o, without printing the key",
    async (mode) => {
      const { key } = await ensureVoiceToolsKey(keyPath);
      chmodSync(keyPath, mode);

      const ensureError = await ensureVoiceToolsKey(keyPath).catch((error: unknown) => error);
      const readError = await readVoiceToolsKey(keyPath).catch((error: unknown) => error);

      for (const error of [ensureError, readError]) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain(keyPath);
        expect(message).toContain("chmod 600");
        expect(message).not.toContain(key);
      }
      expect(readFileSync(keyPath, "utf8")).toBe(key);
      expect(modeOf(keyPath)).toBe(mode);
    },
  );

  it.each([
    ["empty", ""],
    ["too short", "c2hvcnQ"],
    ["too long", "a".repeat(44)],
    ["not base64url", `${"a".repeat(40)} +/=`],
  ])("is refused, not replaced, when the file is %s", async (_label, content) => {
    await ensureVoiceToolsKey(keyPath);
    writeFileSync(keyPath, content, { mode: 0o600 });

    await expect(ensureVoiceToolsKey(keyPath)).rejects.toThrow(/not a valid voice-tools key/);
    await expect(readVoiceToolsKey(keyPath)).rejects.toThrow(/not a valid voice-tools key/);
    expect(readFileSync(keyPath, "utf8")).toBe(content);
  });
});
