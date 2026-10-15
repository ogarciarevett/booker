import { describe, expect, it } from "vitest";
import { exitCodeFor } from "./exit-code.ts";

describe("exitCodeFor", () => {
  it("passes on the child's own exit code", () => {
    expect(exitCodeFor(0, null)).toBe(0);
    expect(exitCodeFor(2, null)).toBe(2);
  });

  it("fails with 128 plus the signal number when the child was killed, as a shell reports it", () => {
    expect(exitCodeFor(null, "SIGINT")).toBe(130);
    expect(exitCodeFor(null, "SIGKILL")).toBe(137);
    expect(exitCodeFor(null, "SIGTERM")).toBe(143);
  });

  it("fails when Node reports neither", () => {
    expect(exitCodeFor(null, null)).toBe(1);
  });
});
