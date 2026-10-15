import { describe, expect, it, vi } from "vitest";
import type { ChoiceQuestion, ChooseInput, Decision, DecisionPort } from "./decision.ts";
import { withFallback } from "./with-fallback.ts";

type Vote = "yes" | "no" | "maybe";

function question(): ChoiceQuestion<Vote> {
  return {
    key: "shouldProceed",
    instructions: "Should the errand proceed with this offer?",
    criteria: {
      yes: "The offer clears every standing rule",
      no: "The offer fails a hard constraint",
      maybe: "More information is needed",
    },
  };
}

function decision(choice: Vote, source: "jev" | "fallback"): Decision<Vote> {
  return {
    choice,
    confidence: source === "jev" ? 0.95 : 0,
    probabilities: {},
    modelVersion: null,
    source,
  };
}

/**
 * A `DecisionPort` test double with a call counter. `choose` is written as a
 * genuinely generic method (its own `<Option>`, not the surrounding
 * function's) because `DecisionPort.choose` is generic per call; a mock
 * built from a single concrete `Decision<Vote>` cannot satisfy that
 * signature, so the fixed `result` is cast back through `unknown` — safe
 * here since every test call uses the same `Vote` question.
 */
interface CountedPort extends DecisionPort {
  readonly calls: number;
}

function portReturning(result: Decision<Vote>): CountedPort {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async choose<Option extends string>(_input: ChooseInput<Option>): Promise<Decision<Option>> {
      calls += 1;
      return result as unknown as Decision<Option>;
    },
  };
}

function portThrowing(error: unknown): CountedPort {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async choose<Option extends string>(_input: ChooseInput<Option>): Promise<Decision<Option>> {
      calls += 1;
      throw error;
    },
  };
}

describe("withFallback", () => {
  it("returns the primary's decision when it succeeds", async () => {
    const primary = portReturning(decision("yes", "jev"));
    const fallback = portReturning(decision("no", "fallback"));
    const onError = vi.fn();

    const port = withFallback(primary, fallback, onError);
    const result = await port.choose({ state: "state", question: question() });

    expect(result).toEqual(decision("yes", "jev"));
    expect(fallback.calls).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it("returns the fallback's decision and reports the error when the primary throws", async () => {
    const error = new Error("primary is unavailable");
    const primary = portThrowing(error);
    const fallback = portReturning(decision("no", "fallback"));
    const onError = vi.fn();

    const port = withFallback(primary, fallback, onError);
    const result = await port.choose({ state: "state", question: question() });

    expect(result).toEqual(decision("no", "fallback"));
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  });

  it("still falls back to the primary's error when onError is omitted", async () => {
    const primary = portThrowing(new Error("boom"));
    const fallback = portReturning(decision("maybe", "fallback"));

    const port = withFallback(primary, fallback);
    const result = await port.choose({ state: "state", question: question() });

    expect(result).toEqual(decision("maybe", "fallback"));
  });

  it("propagates a fallback error when both the primary and the fallback throw", async () => {
    const primary = portThrowing(new Error("primary down"));
    const fallbackError = new Error("fallback down too");
    const fallback = portThrowing(fallbackError);

    const port = withFallback(primary, fallback);

    await expect(port.choose({ state: "state", question: question() })).rejects.toThrow(
      fallbackError,
    );
  });
});

describe("withFallback error reporting", () => {
  it("still returns the fallback's decision when onError itself throws", async () => {
    const port = withFallback(
      portThrowing(new Error("primary down")),
      portReturning(decision("no", "fallback")),
      () => {
        throw new Error("logger broken");
      },
    );
    const result = await port.choose({ state: "offer summary", question: question() });
    expect(result).toEqual(decision("no", "fallback"));
  });
});
