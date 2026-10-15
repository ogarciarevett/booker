import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The control token lives only in server modules (lib/server and each feature's server/): those
// import "server-only", so Next.js refuses to build if a client component ever imports one, and
// client components may only talk to this app's own routes. These checks keep that true before
// any build runs.
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRS = ["app", "components", "features", "lib"];
const IMPORT_PATTERN = /\bimport\s+(?:type\s+)?(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(APP_ROOT, dir)));
/** `lib/server/...` or `features/<name>/server/...`. */
const isServerModule = (file: string) =>
  /^(?:lib|features\/[^/]+)\/server\//.test(relative(APP_ROOT, file));
const isClient = (source: string) =>
  /^\s*["']use client["'];?/m.test(source.split("\n", 3).join("\n"));

describe("the client boundary", () => {
  it("has client components to check", () => {
    expect(files.filter((file) => isClient(readFileSync(file, "utf8")))).not.toEqual([]);
  });

  it("keeps every client component away from server modules, Node built-ins, and Booker itself", () => {
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      if (!isClient(source)) return [];
      return [...source.matchAll(IMPORT_PATTERN)]
        .map((match) => match[1] ?? "")
        .filter(
          (specifier) =>
            specifier.includes("/server/") ||
            specifier.startsWith("node:") ||
            specifier === "server-only",
        )
        .map((specifier) => `${relative(APP_ROOT, file)} imports ${specifier}`);
    });
    expect(violations).toEqual([]);
  });

  it("marks every server module server-only, so a client import fails the build", () => {
    const unmarked = files
      .filter(isServerModule)
      .filter((file) => !readFileSync(file, "utf8").includes('import "server-only";'))
      .map((file) => relative(APP_ROOT, file));
    expect(unmarked).toEqual([]);
  });

  it("has server modules in lib and in the features to check", () => {
    const servers = files.filter(isServerModule).map((file) => relative(APP_ROOT, file));
    expect(servers.some((file) => file.startsWith("lib/server/"))).toBe(true);
    expect(servers.some((file) => file.startsWith("features/"))).toBe(true);
  });

  it("never names the token, its file, or Booker's address outside the server modules", () => {
    const leaks = files
      .filter((file) => !isServerModule(file))
      .filter((file) => /control-token|Authorization|8787/.test(readFileSync(file, "utf8")))
      .map((file) => relative(APP_ROOT, file));
    expect(leaks).toEqual([]);
  });
});
