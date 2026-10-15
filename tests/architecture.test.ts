import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Domain modules never import adapters, persistence, or framework code (see AGENTS.md).
// They may import each other, `zod`, and `node:` built-ins; tests may also import `vitest`.
const DOMAIN_DIRS = [
  "src/shared",
  "src/errands",
  "src/offers",
  "src/policies",
  "src/bookings",
  "src/decisions",
  "src/reasoning",
  "src/calls",
  "src/settings",
];

const REPO_ROOT = process.cwd();
const DOMAIN_ROOTS = DOMAIN_DIRS.map((dir) => resolve(REPO_ROOT, dir));

const IMPORT_FROM_PATTERN = /\bimport\s+(?:type\s+)?(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g;
const EXPORT_FROM_PATTERN = /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

// Checked relative to the repo root so a parent folder named "adapters" does not matter.
const isAdapterPath = (absolutePath: string, root: string = REPO_ROOT): boolean =>
  relative(root, absolutePath).split("/").includes("adapters");

const isDomainPath = (absolutePath: string): boolean =>
  !isAdapterPath(absolutePath) &&
  DOMAIN_ROOTS.some((root) => absolutePath === root || absolutePath.startsWith(`${root}/`));

function listDomainFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "adapters") {
      files.push(...listDomainFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of [IMPORT_FROM_PATTERN, EXPORT_FROM_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** Returns why `specifier`, imported from repo-relative `file`, breaks the rules, or null if allowed. */
function importViolation(file: string, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(resolve(REPO_ROOT, file)), specifier);
    return isDomainPath(target) ? null : `leaves the domain (${relative(REPO_ROOT, target)})`;
  }
  if (specifier.startsWith("node:")) return null;
  if (specifier === "zod" || specifier.startsWith("zod/")) return null;
  if (file.endsWith(".test.ts") && (specifier === "vitest" || specifier.startsWith("vitest/"))) {
    return null;
  }
  return "package or absolute path not allowed in the domain";
}

describe("adapter path detection", () => {
  it("ignores an adapters folder above the repository root", () => {
    expect(
      isAdapterPath("/work/adapters/booker/src/offers/offer.ts", "/work/adapters/booker"),
    ).toBe(false);
  });

  it("detects an adapters folder inside the repository", () => {
    expect(isAdapterPath("/work/booker/src/bookings/adapters/sqlite.ts", "/work/booker")).toBe(
      true,
    );
  });
});

describe("architecture import rules", () => {
  it.each([
    ["src/offers/offer.ts", "../shared/money.ts"],
    ["src/offers/offer.ts", "./field.ts"],
    ["src/errands/brief.ts", "zod"],
    ["src/shared/dates.ts", "node:util"],
    ["src/offers/offer.test.ts", "vitest"],
  ])("allows %s → %s", (file, specifier) => {
    expect(importViolation(file, specifier)).toBeNull();
  });

  it.each([
    ["src/offers/offer.ts", "../http/server.ts"],
    ["src/offers/offer.ts", "../persistence/db.ts"],
    ["src/offers/offer.ts", "../bookings/adapters/in-memory.ts"],
    ["src/offers/offer.ts", "../bookings/adapters/sqlite/grant-store.ts"],
    ["src/offers/offer.ts", "../../scripts/commit-message.ts"],
    ["src/offers/offer.ts", "/etc/hosts"],
    ["src/offers/offer.ts", "hono"],
    ["src/offers/offer.ts", "@mastra/core"],
    ["src/offers/offer.ts", "vitest"],
  ])("rejects %s → %s", (file, specifier) => {
    expect(importViolation(file, specifier)).not.toBeNull();
  });
});

describe("architecture", () => {
  it("keeps domain modules free of adapters, persistence, and framework imports", () => {
    const files = DOMAIN_DIRS.filter((dir) => existsSync(dir)).flatMap(listDomainFiles);
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap((file) =>
      extractImportSpecifiers(readFileSync(file, "utf8")).flatMap((specifier) => {
        const reason = importViolation(file, specifier);
        return reason === null ? [] : [`${file}: "${specifier}" ${reason}`];
      }),
    );

    expect(violations).toEqual([]);
  });
});
