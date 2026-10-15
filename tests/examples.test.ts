import { describe, expect, it } from "vitest";
import drivingSchoolBrief from "../examples/errands/driving-school.example.json" with {
  type: "json",
};
import restaurantBrief from "../examples/errands/restaurant.example.json" with { type: "json" };
import testCallBrief from "../examples/errands/test-call.example.json" with { type: "json" };
import { parseErrandBrief } from "../src/errands/brief.ts";

describe("example errand briefs", () => {
  it("parses the driving-school example", () => {
    const result = parseErrandBrief(drivingSchoolBrief);
    expect(result.ok).toBe(true);
  });

  it("parses the restaurant example", () => {
    const result = parseErrandBrief(restaurantBrief);
    expect(result.ok).toBe(true);
  });

  it("parses the test-call example, with one fictional provider to replace with your own phone", () => {
    const result = parseErrandBrief(testCallBrief);
    expect(result.ok).toBe(true);
    expect(testCallBrief.providers).toHaveLength(1);
    expect(testCallBrief.providers[0]?.phoneE164).toMatch(/^\+1555010\d{2,}$/);
  });
});
