import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

type Version = [major: number, minor: number, patch: number];

const parseVersion = (text: string): Version => {
  const [major = 0, minor = 0, patch = 0] = text
    .replace(/^[^\d]*/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return [major, minor, patch];
};

const isAtLeast = (current: Version, minimum: Version): boolean => {
  for (let index = 0; index < 3; index++) {
    const difference = (current[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
};

describe("toolchain", () => {
  it("runs on a Node.js version that satisfies the package.json engines lower bound", () => {
    expect(packageJson.engines.node).toMatch(/^\^\d+\.\d+\.\d+$/);

    const minimum = parseVersion(packageJson.engines.node);
    const current = parseVersion(process.versions.node);

    expect(current[0]).toBe(minimum[0]);
    expect(isAtLeast(current, minimum)).toBe(true);
  });
});
