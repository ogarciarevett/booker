import { describe, expect, it } from "vitest";
import { classifyConfidence } from "./decision.ts";

describe("classifyConfidence", () => {
  it("returns act at or above the act threshold", () => {
    expect(classifyConfidence(0.9)).toBe("act");
    expect(classifyConfidence(0.95)).toBe("act");
    expect(classifyConfidence(1)).toBe("act");
  });

  it("returns human below the human threshold", () => {
    expect(classifyConfidence(0.49)).toBe("human");
    expect(classifyConfidence(0)).toBe("human");
  });

  it("returns collect for a confidence between the thresholds, including the human boundary", () => {
    expect(classifyConfidence(0.5)).toBe("collect");
    expect(classifyConfidence(0.89)).toBe("collect");
  });

  it("honors custom thresholds", () => {
    expect(classifyConfidence(0.7, { act: 0.8, human: 0.6 })).toBe("collect");
    expect(classifyConfidence(0.8, { act: 0.8, human: 0.6 })).toBe("act");
    expect(classifyConfidence(0.59, { act: 0.8, human: 0.6 })).toBe("human");
  });

  it.each([-0.1, 1.1, Number.NaN])("rejects an out-of-range confidence %p", (confidence) => {
    expect(() => classifyConfidence(confidence)).toThrow(RangeError);
  });

  it("rejects thresholds where act does not exceed human", () => {
    expect(() => classifyConfidence(0.5, { act: 0.4, human: 0.5 })).toThrow(RangeError);
    expect(() => classifyConfidence(0.5, { act: 0.5, human: 0.5 })).toThrow(RangeError);
  });
});
