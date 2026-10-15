import { describe, expect, it } from "vitest";
import { type Call, endCall, isCallOpen, startCall } from "./call.ts";

function call(overrides: Partial<Call> = {}): Call {
  return {
    id: "call-001",
    errandId: "errand-001",
    providerId: "provider-northside",
    purpose: "quote",
    status: "scheduled",
    attempt: 1,
    tokenHash: "a".repeat(64),
    externalId: null,
    createdAt: "2026-09-29T10:00:00.000Z",
    endedAt: null,
    ...overrides,
  };
}

describe("startCall", () => {
  it("builds a fresh scheduled call with no external id and no end time", () => {
    const result = startCall({
      id: "call-001",
      errandId: "errand-001",
      providerId: "provider-northside",
      purpose: "quote",
      attempt: 1,
      tokenHash: "a".repeat(64),
      now: "2026-09-29T10:00:00.000Z",
    });
    expect(result).toEqual({
      id: "call-001",
      errandId: "errand-001",
      providerId: "provider-northside",
      purpose: "quote",
      status: "scheduled",
      attempt: 1,
      tokenHash: "a".repeat(64),
      externalId: null,
      createdAt: "2026-09-29T10:00:00.000Z",
      endedAt: null,
    });
  });

  it("canonicalizes createdAt to UTC", () => {
    const result = startCall({
      id: "call-002",
      errandId: "errand-001",
      providerId: "provider-northside",
      purpose: "commit",
      attempt: 2,
      tokenHash: "b".repeat(64),
      now: "2026-09-29T12:00:00+02:00",
    });
    expect(result.createdAt).toBe("2026-09-29T10:00:00.000Z");
  });

  it("throws RangeError when attempt is not a positive integer", () => {
    expect(() =>
      startCall({
        id: "call-003",
        errandId: "errand-001",
        providerId: "provider-northside",
        purpose: "quote",
        attempt: 0,
        tokenHash: "c".repeat(64),
        now: "2026-09-29T10:00:00.000Z",
      }),
    ).toThrow(RangeError);
  });
});

describe("isCallOpen", () => {
  it("is true for a scheduled call", () => {
    expect(isCallOpen(call({ status: "scheduled" }))).toBe(true);
  });

  it("is true for an in_progress call", () => {
    expect(isCallOpen(call({ status: "in_progress" }))).toBe(true);
  });

  it.each(["completed", "failed", "no_answer", "cancelled"] as const)(
    "is false for a %s call",
    (status) => {
      expect(isCallOpen(call({ status }))).toBe(false);
    },
  );
});

describe("endCall", () => {
  it("ends a scheduled call with a terminal status and canonicalizes endedAt", () => {
    const result = endCall(call({ status: "scheduled" }), "completed", "2026-09-29T12:00:00+02:00");
    expect(result).toEqual({
      ok: true,
      call: call({ status: "completed", endedAt: "2026-09-29T10:00:00.000Z" }),
    });
  });

  it("ends an in_progress call", () => {
    const result = endCall(
      call({ status: "in_progress" }),
      "no_answer",
      "2026-09-29T10:05:00.000Z",
    );
    expect(result).toEqual({
      ok: true,
      call: call({ status: "no_answer", endedAt: "2026-09-29T10:05:00.000Z" }),
    });
  });

  it("rejects ending a call that is already terminal", () => {
    const result = endCall(call({ status: "completed" }), "failed", "2026-09-29T10:05:00.000Z");
    expect(result).toEqual({ ok: false, reason: "not_open" });
  });

  it("throws RangeError when the target status is not terminal", () => {
    expect(() =>
      endCall(call({ status: "scheduled" }), "in_progress", "2026-09-29T10:05:00.000Z"),
    ).toThrow(RangeError);
  });
});
