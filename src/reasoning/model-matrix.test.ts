import { describe, expect, it } from "vitest";
import type { ChooseInput, Decision, DecisionPort } from "../decisions/decision.ts";
import type { RuntimeMatrix } from "./model-matrix.ts";
import { RUNTIME_MATRIX, selectModel } from "./model-matrix.ts";

/** Builds the exact criteria map `selectModel` should send for a candidate list. */
function criteriaOf(
  candidates: readonly { id: string; description: string }[],
): Record<string, string> {
  return Object.fromEntries(candidates.map((c): [string, string] => [c.id, c.description]));
}

function jevDecision(choice: string, confidence: number): Decision<string> {
  return {
    choice,
    confidence,
    probabilities: { [choice]: confidence },
    modelVersion: "jev-2026-09-30",
    source: "jev",
  };
}

/** A `DecisionPort` test double recording every call, styled like `with-fallback.test.ts`'s. */
interface RecordingPort extends DecisionPort {
  readonly calls: number;
  readonly lastInput: ChooseInput<string> | undefined;
}

function fakePort(
  respond: (input: ChooseInput<string>) => Decision<string> | Promise<Decision<string>>,
): RecordingPort {
  let calls = 0;
  let lastInput: ChooseInput<string> | undefined;
  return {
    get calls() {
      return calls;
    },
    get lastInput() {
      return lastInput;
    },
    async choose<Option extends string>(input: ChooseInput<Option>): Promise<Decision<Option>> {
      calls += 1;
      lastInput = input as unknown as ChooseInput<string>;
      const result = await respond(input as unknown as ChooseInput<string>);
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

describe("RUNTIME_MATRIX", () => {
  it.each(Object.entries(RUNTIME_MATRIX))(
    "keeps the %s role's allowlist internally consistent",
    (_role, entry) => {
      const ids = entry.candidates.map((c) => c.id);
      expect(ids).toContain(entry.default);
      expect(new Set(ids).size).toBe(ids.length);
      for (const candidate of entry.candidates) {
        expect(candidate.description.trim().length).toBeGreaterThan(0);
      }
    },
  );

  it("never marks an inCall candidate as a subscription", () => {
    expect(RUNTIME_MATRIX.inCall.candidates.every((c) => !c.subscription)).toBe(true);
  });
});

describe("selectModel", () => {
  it("returns Jev's pick with the decision when confidence is at least the act threshold", async () => {
    const decisions = fakePort(() => jevDecision("api:anthropic/claude-sonnet-5-5", 0.9));

    const result = await selectModel({
      role: "briefParsing",
      state: "state",
      parallel: false,
      killSwitch: false,
      decisions,
    });

    expect(result.reason).toBe("jev");
    expect(result.candidate.id).toBe("api:anthropic/claude-sonnet-5-5");
    expect(result.decision?.confidence).toBe(0.9);
  });

  it("falls back to the role default when confidence is below the act threshold", async () => {
    const decisions = fakePort(() => jevDecision("api:anthropic/claude-sonnet-5-5", 0.6));

    const result = await selectModel({
      role: "briefParsing",
      state: "state",
      parallel: false,
      killSwitch: false,
      decisions,
    });

    expect(result.reason).toBe("low_confidence_default");
    expect(result.candidate.id).toBe(RUNTIME_MATRIX.briefParsing.default);
    expect(result.decision?.confidence).toBe(0.6);
  });

  it("falls back to the role default when Jev names a candidate outside the allowlist", async () => {
    const decisions = fakePort(() => jevDecision("api:google/gemini-x", 0.99));

    const result = await selectModel({
      role: "briefParsing",
      state: "state",
      parallel: false,
      killSwitch: false,
      decisions,
    });

    expect(result.reason).toBe("invalid_choice_default");
    expect(result.candidate.id).toBe(RUNTIME_MATRIX.briefParsing.default);
  });

  it("falls back to the role default when the port throws", async () => {
    const decisions = throwingPort(new Error("jev unavailable"));

    const result = await selectModel({
      role: "briefParsing",
      state: "state",
      parallel: false,
      killSwitch: false,
      decisions,
    });

    expect(result.reason).toBe("decision_failed_default");
    expect(result.candidate.id).toBe(RUNTIME_MATRIX.briefParsing.default);
    expect(result.decision).toBeUndefined();
  });

  it("excludes subscription candidates during a parallel run and asks only the rest", async () => {
    const decisions = fakePort(() => jevDecision("api:openai/gpt-6.1-sol", 0.95));
    const allowed = RUNTIME_MATRIX.briefParsing.candidates.filter((c) => !c.subscription);

    const result = await selectModel({
      role: "briefParsing",
      state: "state",
      parallel: true,
      killSwitch: false,
      decisions,
    });

    expect(decisions.lastInput?.question.criteria).toEqual(criteriaOf(allowed));
    expect(result.reason).toBe("jev");
    expect(result.candidate.id).toBe("api:openai/gpt-6.1-sol");
  });

  it("falls back to the first allowed candidate when the role default is excluded and Jev fails", async () => {
    const decisions = throwingPort(new Error("jev unavailable"));

    const result = await selectModel({
      role: "briefParsing",
      state: "state",
      parallel: true,
      killSwitch: false,
      decisions,
    });

    expect(result.reason).toBe("decision_failed_default");
    expect(result.candidate.id).toBe("api:openai/gpt-6.1-sol");
  });

  it("excludes subscription candidates under the kill switch, falling back without asking Jev", async () => {
    const decisions = fakePort(() => {
      throw new Error("selectModel must not call the port with a single allowed candidate");
    });

    const result = await selectModel({
      role: "comparisonNarrative",
      state: "state",
      parallel: false,
      killSwitch: true,
      decisions,
    });

    expect(result.reason).toBe("only_option");
    expect(result.candidate.id).toBe("api:anthropic/claude-sonnet-5-5");
    expect(decisions.calls).toBe(0);
    expect(result.decision).toBeUndefined();
  });

  it("does not narrow inCall, since none of its candidates are a subscription", async () => {
    const decisions = fakePort(() => jevDecision("elevenlabs:claude-sonnet-5", 0.95));

    const result = await selectModel({
      role: "inCall",
      state: "state",
      parallel: true,
      killSwitch: true,
      decisions,
    });

    expect(decisions.lastInput?.question.criteria).toEqual(
      criteriaOf(RUNTIME_MATRIX.inCall.candidates),
    );
    expect(result.reason).toBe("jev");
  });

  it("sends the exact question key, state, and criteria to the port", async () => {
    const decisions = fakePort(() => jevDecision("codex-cli:gpt-6.1-sol", 0.95));

    await selectModel({
      role: "briefParsing",
      state: "the brief mentions three providers",
      parallel: false,
      killSwitch: false,
      decisions,
    });

    expect(decisions.lastInput?.state).toBe("the brief mentions three providers");
    expect(decisions.lastInput?.question.key).toBe("model:briefParsing");
    expect(decisions.lastInput?.question.criteria).toEqual(
      criteriaOf(RUNTIME_MATRIX.briefParsing.candidates),
    );
  });

  it("throws a descriptive error when every candidate for a role is excluded", async () => {
    const decisions = fakePort(() => jevDecision("x", 1));
    const matrix: RuntimeMatrix = {
      ...RUNTIME_MATRIX,
      briefParsing: {
        default: "codex-cli:gpt-6.1-sol",
        candidates: RUNTIME_MATRIX.briefParsing.candidates.filter((c) => c.subscription),
      },
    };

    await expect(
      selectModel({
        role: "briefParsing",
        state: "state",
        parallel: true,
        killSwitch: false,
        decisions,
        matrix,
      }),
    ).rejects.toThrow(/no candidate is allowed/);
  });
});

describe("selectModel diagnostics and thresholds", () => {
  const base = {
    role: "briefParsing" as const,
    state: "brief text",
    parallel: false,
    killSwitch: false,
  };

  it("reports an out-of-allowlist choice separately from low confidence", async () => {
    const result = await selectModel({
      ...base,
      decisions: fakePort(() => jevDecision("api:unknown/model", 0.99)),
    });
    expect(result.reason).toBe("invalid_choice_default");
    expect(result.candidate.id).toBe("codex-cli:gpt-6.1-sol");
  });

  it("passes custom thresholds through to the confidence check", async () => {
    const result = await selectModel({
      ...base,
      thresholds: { act: 0.7, human: 0.3 },
      decisions: fakePort(() => jevDecision("api:anthropic/claude-sonnet-5-5", 0.75)),
    });
    expect(result.reason).toBe("jev");
    expect(result.candidate.id).toBe("api:anthropic/claude-sonnet-5-5");
  });

  it.each([Number.NaN, 1.5])(
    "treats an out-of-range confidence (%s) from the port as a failed decision",
    async (confidence) => {
      const result = await selectModel({
        ...base,
        decisions: fakePort(() => jevDecision("api:openai/gpt-6.1-sol", confidence)),
      });
      expect(result.reason).toBe("decision_failed_default");
      expect(result.candidate.id).toBe("codex-cli:gpt-6.1-sol");
    },
  );
});

describe("selectModel without a decision port", () => {
  it("degrades to the role default and names the missing port", async () => {
    const result = await selectModel({
      role: "briefParsing",
      state: "brief text",
      parallel: false,
      killSwitch: false,
      decisions: undefined as unknown as DecisionPort,
    });
    expect(result.reason).toBe("no_decision_service");
    expect(result.candidate.id).toBe(RUNTIME_MATRIX.briefParsing.default);
  });
});
