import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { controlTokenPath, ensureControlToken, readControlToken } from "./control-token.ts";

describe("control token", () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "booker-control-token-"));
    path = controlTokenPath(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lives in .local/secrets", () => {
    expect(controlTokenPath("/work/booker")).toBe("/work/booker/.local/secrets/control-token");
  });

  it("is generated once as 32 random bytes in a private file, then reused", async () => {
    const first = await ensureControlToken(path);
    const second = await ensureControlToken(path);

    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toEqual({ token: first.token, created: false });
    expect(readFileSync(path, "utf8")).toBe(first.token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await readControlToken(path)).toBe(first.token);
  });

  it("reads nothing when the server never ran", async () => {
    expect(await readControlToken(path)).toBeUndefined();
  });

  it("refuses a token file other users can read, and one that holds no token", async () => {
    const { token } = await ensureControlToken(path);
    chmodSync(path, 0o644);
    const sharedError = await readControlToken(path).catch((error: unknown) => error);
    expect((sharedError as Error).message).toContain("chmod 600");
    expect((sharedError as Error).message).not.toContain(token);

    writeFileSync(path, "short", { mode: 0o600 });
    chmodSync(path, 0o600);
    await expect(ensureControlToken(path)).rejects.toThrow(/not a valid control token/);
  });
});
