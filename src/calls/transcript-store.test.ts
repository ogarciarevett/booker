import { describe, expect, it } from "vitest";
import { validateSaveTranscriptInput } from "./transcript-store.ts";

describe("validateSaveTranscriptInput", () => {
  const VALID = {
    callId: "call-001",
    receivedAt: "2026-09-29T10:00:00.000Z",
    turns: [
      { role: "agent" as const, message: "Hello, how can I help?", secondsIntoCall: 0 },
      { role: "user" as const, message: "I need a quote.", secondsIntoCall: 3.5 },
    ],
  };

  it("passes valid input through, canonicalizing receivedAt", () => {
    const validated = validateSaveTranscriptInput({
      ...VALID,
      receivedAt: "2026-09-29T10:00:00+00:00",
    });
    expect(validated).toEqual({ ...VALID, receivedAt: "2026-09-29T10:00:00.000Z" });
  });

  it("rejects an empty callId", () => {
    expect(() => validateSaveTranscriptInput({ ...VALID, callId: "" })).toThrow(RangeError);
  });

  it("rejects an offset-less receivedAt", () => {
    expect(() =>
      validateSaveTranscriptInput({ ...VALID, receivedAt: "2026-09-29T10:00:00" }),
    ).toThrow(RangeError);
  });

  it("rejects a turn whose role is not agent or user", () => {
    expect(() =>
      validateSaveTranscriptInput({
        ...VALID,
        turns: [{ role: "system" as unknown as "agent", message: "x", secondsIntoCall: 0 }],
      }),
    ).toThrow(RangeError);
  });

  it("rejects a turn with an empty message", () => {
    expect(() =>
      validateSaveTranscriptInput({
        ...VALID,
        turns: [{ role: "agent", message: "", secondsIntoCall: 0 }],
      }),
    ).toThrow(RangeError);
  });

  it("rejects a turn with a negative secondsIntoCall", () => {
    expect(() =>
      validateSaveTranscriptInput({
        ...VALID,
        turns: [{ role: "agent", message: "x", secondsIntoCall: -1 }],
      }),
    ).toThrow(RangeError);
  });

  it("accepts an empty turns array", () => {
    expect(validateSaveTranscriptInput({ ...VALID, turns: [] }).turns).toEqual([]);
  });

  it("never shares state with the turns array passed in", () => {
    const turns = [{ role: "agent" as const, message: "Hi", secondsIntoCall: 0 }];
    const validated = validateSaveTranscriptInput({ ...VALID, turns });
    (turns[0] as { message: string }).message = "tampered";
    expect(validated.turns[0]?.message).toBe("Hi");
  });
});
