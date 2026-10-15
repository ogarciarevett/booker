import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const workDir = mkdtempSync(join(tmpdir(), "booker-commit-msg-"));

const runHook = (...args: string[]) =>
  spawnSync(process.execPath, ["scripts/check-commit-message.ts", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });

const messageFile = (name: string, content: string): string => {
  const path = join(workDir, name);
  writeFileSync(path, content);
  return path;
};

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("commit-msg hook entry point", () => {
  it("exits 0 for a Conventional Commit", () => {
    const result = runHook(messageFile("ok.txt", "feat: add errand brief\n"));
    expect(result.status).toBe(0);
  });

  it("exits 1 with guidance for a non-conventional message", () => {
    const result = runHook(messageFile("bad.txt", "added stuff\n"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Conventional Commits");
  });

  it("exits 2 with a clear error when the message file cannot be read", () => {
    const result = runHook(join(workDir, "missing.txt"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cannot read commit message file");
  });

  it("exits 2 with usage when no file is given", () => {
    const result = runHook();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage");
  });
});
