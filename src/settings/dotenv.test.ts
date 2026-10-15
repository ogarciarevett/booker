import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dotenvWarning, readDotenvNames } from "./dotenv.ts";

describe("readDotenvNames", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "booker-dotenv-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the names a synthetic .env defines, the way Node parses it", async () => {
    const path = join(dir, ".env");
    writeFileSync(
      path,
      [
        "# a comment",
        "BOOKER_OWNER_NAME=Example Owner 2",
        "export BOOKER_PORT=9100",
        'PUBLIC_BASE_URL="https://public.booker.example"',
        "EMPTY=",
        "",
      ].join("\n"),
    );

    const result = await readDotenvNames(path);

    expect(result).toEqual({
      ok: true,
      names: new Set(["BOOKER_OWNER_NAME", "BOOKER_PORT", "PUBLIC_BASE_URL", "EMPTY"]),
    });
  });

  it("returns no names when there is no .env", async () => {
    expect(await readDotenvNames(join(dir, ".env"))).toEqual({ ok: true, names: new Set() });
  });

  it("reports a .env it cannot read by its error code only", async () => {
    const path = join(dir, ".env");
    mkdirSync(path);

    const result = await readDotenvNames(path);

    expect(result).toEqual({ ok: false, reason: "EISDIR" });
  });

  it("warns, without any value, that sources fall back to the environment", () => {
    expect(dotenvWarning({ ok: false, reason: "EACCES" })).toBe(
      "Warning: .env could not be read (EACCES), so settings defined there are shown as coming from the environment.",
    );
    expect(dotenvWarning({ ok: true, names: new Set(["BOOKER_PORT"]) })).toBeUndefined();
  });
});
