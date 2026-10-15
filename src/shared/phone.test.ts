import { describe, expect, it } from "vitest";
import { maskPhone } from "./phone.ts";

describe("maskPhone", () => {
  it("hides every digit but the last four, keeping the plus sign and any spacing", () => {
    expect(maskPhone("+15555550100")).toBe("+*******0100");
    expect(maskPhone("+1 555 0100 123")).toBe("+* *** ***0 123");
  });

  it("hides a number too short to show four digits of entirely", () => {
    expect(maskPhone("+123")).toBe("+***");
  });
});
