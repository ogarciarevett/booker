import { describe, expect, it } from "vitest";
import { exitCodeFor } from "../scripts/exit-code.ts";

describe("exitCodeFor (pnpm phoenix)", () => {
  it("passes on the child's code, and fails with 128 plus the signal number when it was killed", () => {
    expect(exitCodeFor(0, null)).toBe(0);
    expect(exitCodeFor(3, null)).toBe(3);
    expect(exitCodeFor(null, "SIGTERM")).toBe(143);
    expect(exitCodeFor(null, "SIGKILL")).toBe(137);
    expect(exitCodeFor(null, null)).toBe(1);
  });
});
