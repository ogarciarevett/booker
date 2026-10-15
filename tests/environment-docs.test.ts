import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../src/settings/catalog.ts";

const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const liveCalls = readFileSync(new URL("../docs/live-calls.md", import.meta.url), "utf8");
const names = [
  ...SETTINGS.map(({ name }) => name),
  "BOOKER_URL",
  "BOOKER_REPO_ROOT",
  "PHOENIX_URL",
];

describe("environment reference", () => {
  it("covers every runtime setting and dashboard override in the example and both guides", () => {
    for (const name of names) {
      expect(example, name).toMatch(new RegExp(`^${name}=`, "m"));
      expect(readme, name).toContain(`| \`${name}\` |`);
      expect(liveCalls, name).toContain(`| \`${name}\` |`);
    }
  });

  it("leaves every example value empty for local configuration", () => {
    const assignments = example.split("\n").filter((line) => /^[A-Z][A-Z_]*=/.test(line));
    expect(assignments.length).toBeGreaterThanOrEqual(names.length);
    expect(assignments.every((line) => /^[A-Z][A-Z_]*=$/.test(line))).toBe(true);
  });
});
