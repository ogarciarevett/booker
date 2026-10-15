import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  verifyElevenLabsSignature,
} from "./webhook-signature.ts";

// Fixture secret assembled at runtime so it never reads as a literal committed credential.
const SECRET = ["whsec", "test", "fixture"].join("-");
const NOW = "2026-09-29T10:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1000);
const RAW_BODY = JSON.stringify({
  type: "post_call_transcription",
  data: { conversation_id: "conv-1" },
});

function signatureHeader(body: string, timestampSeconds: number, secret: string = SECRET): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v0=${digest}`;
}

describe("verifyElevenLabsSignature", () => {
  it("accepts a valid signature", () => {
    const header = signatureHeader(RAW_BODY, NOW_SECONDS);
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: true, timestamp: NOW_SECONDS });
  });

  it("rejects a tampered body", () => {
    const header = signatureHeader(RAW_BODY, NOW_SECONDS);
    const tamperedBody = RAW_BODY.replace("conv-1", "conv-2");
    const result = verifyElevenLabsSignature({
      rawBody: tamperedBody,
      header,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects the wrong secret", () => {
    const header = signatureHeader(RAW_BODY, NOW_SECONDS);
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header,
      secret: ["whsec", "other", "fixture"].join("-"),
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a missing header", () => {
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header: undefined,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects an empty header", () => {
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header: "",
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "missing_header" });
  });

  it.each([
    ["no v0 entry", `t=${NOW_SECONDS}`],
    ["no t entry", "v0=abcdef"],
    ["non-numeric timestamp", "t=not-a-number,v0=abcdef"],
    ["duplicate t= entries", `t=${NOW_SECONDS},t=${NOW_SECONDS},v0=abcdef`],
    ["garbage", "this is not a signature header"],
  ])("rejects a malformed header (%s)", (_label, header) => {
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_header" });
  });

  it("rejects a timestamp older than the tolerance", () => {
    const staleSeconds = NOW_SECONDS - (DEFAULT_WEBHOOK_TOLERANCE_SECONDS + 1);
    const header = signatureHeader(RAW_BODY, staleSeconds);
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a timestamp further in the future than the tolerance", () => {
    const futureSeconds = NOW_SECONDS + (DEFAULT_WEBHOOK_TOLERANCE_SECONDS + 1);
    const header = signatureHeader(RAW_BODY, futureSeconds);
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("accepts a timestamp exactly at the tolerance boundary", () => {
    const boundarySeconds = NOW_SECONDS - DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
    const header = signatureHeader(RAW_BODY, boundarySeconds);
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: true, timestamp: boundarySeconds });
  });

  it("respects a custom toleranceSeconds", () => {
    const secondsAgo = NOW_SECONDS - 120;
    const header = signatureHeader(RAW_BODY, secondsAgo);
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header,
      secret: SECRET,
      now: NOW,
      toleranceSeconds: 60,
    });
    expect(result).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("accepts when any of several v0 entries matches (key rotation)", () => {
    const digest = createHmac("sha256", SECRET)
      .update(`${NOW_SECONDS}.${RAW_BODY}`, "utf8")
      .digest("hex");
    const header = `t=${NOW_SECONDS},v0=0000000000000000000000000000000000000000000000000000000000000000,v0=${digest}`;
    const result = verifyElevenLabsSignature({
      rawBody: RAW_BODY,
      header,
      secret: SECRET,
      now: NOW,
    });
    expect(result).toEqual({ ok: true, timestamp: NOW_SECONDS });
  });

  it("throws a RangeError for an empty secret", () => {
    const header = signatureHeader(RAW_BODY, NOW_SECONDS);
    expect(() =>
      verifyElevenLabsSignature({ rawBody: RAW_BODY, header, secret: "", now: NOW }),
    ).toThrow(RangeError);
  });

  it("throws a RangeError for a NaN toleranceSeconds", () => {
    const header = signatureHeader(RAW_BODY, NOW_SECONDS);
    expect(() =>
      verifyElevenLabsSignature({
        rawBody: RAW_BODY,
        header,
        secret: SECRET,
        now: NOW,
        toleranceSeconds: Number.NaN,
      }),
    ).toThrow(RangeError);
  });

  it("throws a RangeError for a negative toleranceSeconds", () => {
    const header = signatureHeader(RAW_BODY, NOW_SECONDS);
    expect(() =>
      verifyElevenLabsSignature({
        rawBody: RAW_BODY,
        header,
        secret: SECRET,
        now: NOW,
        toleranceSeconds: -1,
      }),
    ).toThrow(RangeError);
  });
});
