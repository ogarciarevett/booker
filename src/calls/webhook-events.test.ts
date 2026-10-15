import { describe, expect, it } from "vitest";
import {
  computeLeaseExpiresAt,
  elevenLabsEventKey,
  isLeaseExpired,
  validateClaimInput,
} from "./webhook-events.ts";

describe("elevenLabsEventKey", () => {
  it("joins the event type and conversation id with a colon", () => {
    expect(elevenLabsEventKey("post_call_transcription", "conv-1")).toBe(
      "post_call_transcription:conv-1",
    );
  });

  it("gives a transcription and an audio event for the same conversation different keys", () => {
    const transcriptionKey = elevenLabsEventKey("post_call_transcription", "conv-1");
    const audioKey = elevenLabsEventKey("post_call_audio", "conv-1");
    expect(transcriptionKey).not.toBe(audioKey);
  });

  it("rejects an empty type", () => {
    expect(() => elevenLabsEventKey("", "conv-1")).toThrow(RangeError);
  });

  it("rejects an empty conversationId", () => {
    expect(() => elevenLabsEventKey("post_call_transcription", "")).toThrow(RangeError);
  });
});

describe("validateClaimInput", () => {
  const VALID = {
    eventKey: "event-001",
    payloadSha256: "a".repeat(64),
    now: "2026-09-29T10:00:00.000Z",
  };

  it("rejects an empty eventKey", () => {
    expect(() => validateClaimInput({ ...VALID, eventKey: "" })).toThrow(RangeError);
  });

  it("rejects a payloadSha256 shorter than 64 hex digits", () => {
    expect(() => validateClaimInput({ ...VALID, payloadSha256: "a".repeat(63) })).toThrow(
      RangeError,
    );
  });

  it("rejects an uppercase payloadSha256", () => {
    expect(() => validateClaimInput({ ...VALID, payloadSha256: "A".repeat(64) })).toThrow(
      RangeError,
    );
  });

  it("rejects a non-hex payloadSha256", () => {
    expect(() => validateClaimInput({ ...VALID, payloadSha256: `${"a".repeat(63)}z` })).toThrow(
      RangeError,
    );
  });

  it("rejects an offset-less now", () => {
    expect(() => validateClaimInput({ ...VALID, now: "2026-09-29T10:00:00" })).toThrow(RangeError);
  });

  it("resolves the default leaseSeconds when not given", () => {
    expect(validateClaimInput(VALID).leaseSeconds).toBe(300);
  });

  it("keeps an explicit leaseSeconds", () => {
    expect(validateClaimInput({ ...VALID, leaseSeconds: 5 }).leaseSeconds).toBe(5);
  });
});

describe("computeLeaseExpiresAt", () => {
  it("adds leaseSeconds to now as a canonical instant", () => {
    expect(computeLeaseExpiresAt("2026-09-29T10:00:00.000Z", 5)).toBe("2026-09-29T10:00:05.000Z");
  });
});

describe("isLeaseExpired", () => {
  it("is not expired one millisecond before the lease deadline", () => {
    expect(isLeaseExpired("2026-09-29T10:00:05.000Z", "2026-09-29T10:00:04.999Z")).toBe(false);
  });

  it("is expired exactly at the lease deadline", () => {
    expect(isLeaseExpired("2026-09-29T10:00:05.000Z", "2026-09-29T10:00:05.000Z")).toBe(true);
  });
});
