import { describe, expect, it } from "vitest";
import type { ErrandBrief } from "../errands/brief.ts";
import { parseErrandBrief } from "../errands/brief.ts";
import type { Call, CallStatus } from "./call.ts";
import { planCallRound } from "./planning.ts";

const NOW = "2026-09-29T10:00:00.000Z";

function brief(providerIds: readonly string[]): ErrandBrief {
  const result = parseErrandBrief({
    id: "errand-001",
    kind: "driving-school",
    objective: "Enroll one participant.",
    timeZone: "Europe/Madrid",
    participants: [{ id: "participant-a", attributes: {} }],
    location: { area: "Northside district", acceptableAlternatives: [] },
    dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
    hardRequirements: [],
    preferences: [],
    spendLimits: { currency: "EUR", totalMax: { amountCents: 120_000, currency: "EUR" } },
    authorizedActions: ["quote", "hold"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: { description: "Enrolled.", requiresWrittenConfirmation: false },
    questions: [],
    providers: providerIds.map((id, index) => ({
      id,
      name: `Provider ${index + 1}`,
      phoneE164: `+1555555010${index}`,
    })),
    shareableAttributes: [],
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

function call(providerId: string, status: CallStatus, attempt = 1): Call {
  return {
    id: `call-${providerId}-${attempt}`,
    errandId: "errand-001",
    providerId,
    purpose: "quote",
    status,
    attempt,
    tokenHash: "a".repeat(64),
    externalId: null,
    createdAt: NOW,
    endedAt: status === "scheduled" || status === "in_progress" ? null : NOW,
  };
}

describe("planCallRound", () => {
  it("picks every provider when there are no calls yet, in brief order", () => {
    const result = planCallRound({ brief: brief(["p-a", "p-b", "p-c"]), calls: [] });
    expect(result).toEqual(["p-a", "p-b", "p-c"]);
  });

  it("skips a provider with an open (scheduled) call", () => {
    const result = planCallRound({
      brief: brief(["p-a", "p-b"]),
      calls: [call("p-a", "scheduled")],
    });
    expect(result).toEqual(["p-b"]);
  });

  it("skips a provider with an open (in_progress) call", () => {
    const result = planCallRound({
      brief: brief(["p-a", "p-b"]),
      calls: [call("p-a", "in_progress")],
    });
    expect(result).toEqual(["p-b"]);
  });

  it("does not skip a provider whose only call already ended", () => {
    const result = planCallRound({
      brief: brief(["p-a", "p-b"]),
      calls: [call("p-a", "no_answer")],
    });
    expect(result).toEqual(["p-a", "p-b"]);
  });

  it("skips a provider that already reached the attempt cap", () => {
    const result = planCallRound({
      brief: brief(["p-a", "p-b"]),
      calls: [call("p-a", "no_answer", 1), call("p-a", "failed", 2)],
      maxAttemptsPerProvider: 2,
    });
    expect(result).toEqual(["p-b"]);
  });

  it("never returns more providers than maxConcurrent allows across the whole round", () => {
    const result = planCallRound({
      brief: brief(["p-a", "p-b", "p-c", "p-d"]),
      calls: [],
      maxConcurrent: 2,
    });
    expect(result).toEqual(["p-a", "p-b"]);
  });

  it("counts existing open calls against the maxConcurrent budget", () => {
    const result = planCallRound({
      brief: brief(["p-a", "p-b", "p-c"]),
      calls: [call("p-a", "in_progress")],
      maxConcurrent: 2,
    });
    expect(result).toEqual(["p-b"]);
  });

  it("returns nothing once maxConcurrent open calls are already running", () => {
    const result = planCallRound({
      brief: brief(["p-a", "p-b", "p-c"]),
      calls: [call("p-a", "in_progress"), call("p-b", "scheduled")],
      maxConcurrent: 2,
    });
    expect(result).toEqual([]);
  });

  it("defaults to maxConcurrent 3 and maxAttemptsPerProvider 2", () => {
    const result = planCallRound({
      brief: brief(["p-a", "p-b", "p-c", "p-d"]),
      calls: [call("p-a", "in_progress"), call("p-b", "no_answer", 1), call("p-b", "failed", 2)],
    });
    expect(result).toEqual(["p-c", "p-d"]);
  });
});

describe("planCallRound cap validation", () => {
  it.each([Number.NaN, 2.5, 0, -1])("rejects maxConcurrent %s instead of failing open", (value) => {
    expect(() =>
      planCallRound({
        brief: brief(["provider-a", "provider-b"]),
        calls: [],
        maxConcurrent: value,
      }),
    ).toThrow(RangeError);
  });

  it.each([Number.NaN, 1.5, 0])("rejects maxAttemptsPerProvider %s", (value) => {
    expect(() =>
      planCallRound({
        brief: brief(["provider-a"]),
        calls: [],
        maxAttemptsPerProvider: value,
      }),
    ).toThrow(RangeError);
  });
});
