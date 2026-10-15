import { describe, expect, it } from "vitest";
import { instantMillis, toCanonicalInstant } from "./instants.ts";

describe("instants", () => {
  it.each([
    ["2026-09-29T10:00:00.000Z", "2026-09-29T10:00:00.000Z"],
    ["2026-09-29T12:00:00+02:00", "2026-09-29T10:00:00.000Z"],
    ["2026-09-29T08:30-01:30", "2026-09-29T10:00:00.000Z"],
    ["2026-09-29T10:00:00.5Z", "2026-09-29T10:00:00.500Z"],
  ])("canonicalizes %s", (input, expected) => {
    expect(toCanonicalInstant(input)).toBe(expected);
  });

  it.each([
    "2026-09-29T10:00:00",
    "2026-09-29",
    "Tue, 29 Sep 2026 10:00:00 GMT",
    "2026-02-30T10:00:00Z",
    "",
  ])("rejects %j, which is not an ISO 8601 instant with an explicit offset", (input) => {
    expect(() => instantMillis(input)).toThrow(/now must be an ISO 8601 instant/);
  });

  it("names the rejected field in the error", () => {
    expect(() => instantMillis("soon", "expiresAt")).toThrow(/expiresAt must be/);
  });
});
