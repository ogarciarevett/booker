import { describe, expect, it } from "vitest";
import type { ChoiceQuestion } from "../decision.ts";
import { ConservativeDecisionAdapter } from "./conservative.ts";

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

describe("ConservativeDecisionAdapter", () => {
  it("always returns the safe default with zero confidence and no probabilities", async () => {
    const adapter = new ConservativeDecisionAdapter(() => "no");

    const decision = await adapter.choose({ state: "anything", question: question() });

    expect(decision).toEqual({
      choice: "no",
      confidence: 0,
      probabilities: {},
      modelVersion: null,
      source: "fallback",
    });
  });

  it("passes the question to the safe-default function so the choice can depend on it", async () => {
    const safeDefault = (q: ChoiceQuestion<Vote>): Vote =>
      q.key === "shouldProceed" ? "maybe" : "no";
    const adapter = new ConservativeDecisionAdapter(safeDefault);

    const decision = await adapter.choose({ state: "anything", question: question() });

    expect(decision.choice).toBe("maybe");
    expect(decision.source).toBe("fallback");
  });
});

describe("ConservativeDecisionAdapter misconfiguration", () => {
  it("throws when the safe default is not one of the question's options", async () => {
    const adapter = new ConservativeDecisionAdapter(() => "later");
    await expect(adapter.choose({ state: "offer summary", question: question() })).rejects.toThrow(
      RangeError,
    );
  });
});
