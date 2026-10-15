import { describe, expect, it } from "vitest";
import { chooseWithin } from "./choose-within.ts";
import type { ChoiceQuestion, ChooseInput, Decision, DecisionPort } from "./decision.ts";

function question(): ChoiceQuestion<string> {
  return {
    key: "test-question",
    instructions: "Pick one.",
    criteria: { a: "Option A", b: "Option B", c: "Option C" },
  };
}

function jevDecision(choice: string, confidence: number): Decision<string> {
  return {
    choice,
    confidence,
    probabilities: { [choice]: confidence },
    modelVersion: "jev-test",
    source: "jev",
  };
}

function fakePort(respond: () => Decision<string> | Promise<Decision<string>>): DecisionPort {
  return {
    async choose<Option extends string>(_input: ChooseInput<Option>): Promise<Decision<Option>> {
      const result = await respond();
      return result as unknown as Decision<Option>;
    },
  };
}

function throwingPort(error: unknown): DecisionPort {
  return {
    async choose(): Promise<never> {
      throw error;
    },
  };
}

describe("chooseWithin", () => {
  it('returns "decided" with the port\'s choice at or above the act threshold', async () => {
    const result = await chooseWithin({
      decisions: fakePort(() => jevDecision("b", 0.95)),
      state: "state",
      question: question(),
      defaultOption: "a",
    });
    expect(result).toEqual({ option: "b", reason: "decided", decision: jevDecision("b", 0.95) });
  });

  it('returns "no_decision_service" without asking anything when decisions is undefined', async () => {
    const result = await chooseWithin({
      decisions: undefined,
      state: "state",
      question: question(),
      defaultOption: "a",
    });
    expect(result).toEqual({ option: "a", reason: "no_decision_service" });
  });

  it('falls back with "low_confidence_default" below the act threshold', async () => {
    const result = await chooseWithin({
      decisions: fakePort(() => jevDecision("b", 0.6)),
      state: "state",
      question: question(),
      defaultOption: "a",
    });
    expect(result.reason).toBe("low_confidence_default");
    expect(result.option).toBe("a");
    expect(result.decision?.confidence).toBe(0.6);
  });

  it('falls back with "invalid_choice_default" for a choice outside criteria', async () => {
    const result = await chooseWithin({
      decisions: fakePort(() => jevDecision("ghost", 0.99)),
      state: "state",
      question: question(),
      defaultOption: "a",
    });
    expect(result.reason).toBe("invalid_choice_default");
    expect(result.option).toBe("a");
  });

  it('falls back with a sanitized "decision_failed_default" error when the port throws', async () => {
    const result = await chooseWithin({
      decisions: throwingPort(new Error("jev unavailable")),
      state: "state",
      question: question(),
      defaultOption: "a",
    });
    expect(result.reason).toBe("decision_failed_default");
    expect(result.option).toBe("a");
    expect(result.error).toBe("jev unavailable");
    expect(result.decision).toBeUndefined();
  });

  it("passes custom thresholds through to the confidence check", async () => {
    const result = await chooseWithin({
      decisions: fakePort(() => jevDecision("c", 0.75)),
      state: "state",
      question: question(),
      defaultOption: "a",
      thresholds: { act: 0.7, human: 0.3 },
    });
    expect(result.reason).toBe("decided");
    expect(result.option).toBe("c");
  });

  it.each([Number.NaN, 1.5])(
    "treats an out-of-range confidence (%s) as a failed decision",
    async (confidence) => {
      const result = await chooseWithin({
        decisions: fakePort(() => jevDecision("b", confidence)),
        state: "state",
        question: question(),
        defaultOption: "a",
      });
      expect(result.reason).toBe("decision_failed_default");
      expect(result.option).toBe("a");
      expect(result.error).toBeDefined();
    },
  );

  it("sends the exact state and question through to the port", async () => {
    let seenState: string | undefined;
    let seenKey: string | undefined;
    const decisions: DecisionPort = {
      async choose<Option extends string>(input: ChooseInput<Option>): Promise<Decision<Option>> {
        seenState = input.state;
        seenKey = input.question.key;
        return jevDecision("a", 0.95) as unknown as Decision<Option>;
      },
    };
    await chooseWithin({
      decisions,
      state: "the exact state",
      question: question(),
      defaultOption: "a",
    });
    expect(seenState).toBe("the exact state");
    expect(seenKey).toBe("test-question");
  });
});

describe("chooseWithin error sanitization", () => {
  const question: ChoiceQuestion<"a" | "b"> = {
    key: "pick",
    instructions: "Pick one.",
    criteria: { a: "first", b: "second" },
  };
  const throwing = (message: string): DecisionPort => ({
    async choose(): Promise<never> {
      throw new Error(message);
    },
  });

  it("returns a single line without control characters, capped in length", async () => {
    const result = await chooseWithin({
      decisions: throwing(`bad\u001b[31m answer\r\nsecond line\t${"x".repeat(1_000)}`),
      state: "state",
      question,
      defaultOption: "a",
    });
    expect(result.reason).toBe("decision_failed_default");
    expect(result.error).toBeDefined();
    const hasControl = Array.from(result.error ?? "").some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
    expect(hasControl).toBe(false);
    expect(result.error?.startsWith("bad[31m answer second line x")).toBe(true);
    expect(result.error?.length).toBeLessThanOrEqual(300);
  });
});

describe("chooseWithin secret redaction", () => {
  const question: ChoiceQuestion<"a" | "b"> = {
    key: "pick",
    instructions: "Pick one.",
    criteria: { a: "first", b: "second" },
  };
  const throwing = (message: string): DecisionPort => ({
    async choose(): Promise<never> {
      throw new Error(message);
    },
  });

  it("redacts a secret before truncation, even when it crosses the length cap", async () => {
    // Assembled at runtime so the fixture never looks like a committed key to gitleaks.
    const secret = ["redaction", "probe", "value"].join("-");
    const result = await chooseWithin({
      decisions: throwing(`${"x".repeat(290)}${secret} and more text`),
      state: "state",
      question,
      defaultOption: "a",
      redact: [secret],
    });
    expect(result.error).toContain("[redacted");
    expect(result.error).not.toContain("redaction");
  });

  it("never splits a character that sits on the length cap", async () => {
    const result = await chooseWithin({
      decisions: throwing(`${"a".repeat(298)}😀 tail after the cap`),
      state: "state",
      question,
      defaultOption: "a",
    });
    expect(result.error?.isWellFormed()).toBe(true);
  });
});
