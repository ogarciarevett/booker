import { describe, expect, it } from "vitest";
import { type CommitGrant, isGrantActive, newGrant } from "./commit-grant.ts";

const NOW = "2026-09-29T10:00:00.000Z";

function grant(overrides: Partial<CommitGrant> = {}): CommitGrant {
  return {
    id: "grant-001",
    errandId: "errand-001",
    offerId: "offer-001",
    token: "token-001",
    status: "active",
    issuedAt: NOW,
    expiresAt: "2026-09-29T10:05:00.000Z",
    ...overrides,
  };
}

describe("newGrant", () => {
  it("builds an active grant expiring ttlSeconds after now", () => {
    const result = newGrant({
      id: "grant-001",
      errandId: "errand-001",
      offerId: "offer-001",
      token: "token-001",
      now: NOW,
      ttlSeconds: 300,
    });
    expect(result).toEqual({
      id: "grant-001",
      errandId: "errand-001",
      offerId: "offer-001",
      token: "token-001",
      status: "active",
      issuedAt: NOW,
      expiresAt: "2026-09-29T10:05:00.000Z",
    });
  });

  it("expands the expiry correctly across a minute boundary", () => {
    const result = newGrant({
      id: "grant-002",
      errandId: "errand-001",
      offerId: "offer-001",
      token: "token-002",
      now: "2026-09-29T10:00:59.500Z",
      ttlSeconds: 1,
    });
    expect(result.expiresAt).toBe("2026-09-29T10:01:00.500Z");
  });

  it("throws RangeError when ttlSeconds is zero", () => {
    expect(() =>
      newGrant({
        id: "grant-003",
        errandId: "errand-001",
        offerId: "offer-001",
        token: "token-003",
        now: NOW,
        ttlSeconds: 0,
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when ttlSeconds is negative", () => {
    expect(() =>
      newGrant({
        id: "grant-004",
        errandId: "errand-001",
        offerId: "offer-001",
        token: "token-004",
        now: NOW,
        ttlSeconds: -10,
      }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when ttlSeconds is not an integer", () => {
    expect(() =>
      newGrant({
        id: "grant-005",
        errandId: "errand-001",
        offerId: "offer-001",
        token: "token-005",
        now: NOW,
        ttlSeconds: 1.5,
      }),
    ).toThrow(RangeError);
  });
});

describe("isGrantActive", () => {
  it("is true for an active grant before its expiry", () => {
    expect(isGrantActive(grant(), "2026-09-29T10:04:59.999Z")).toBe(true);
  });

  it("is false once now reaches expiresAt (boundary is exclusive)", () => {
    expect(isGrantActive(grant(), "2026-09-29T10:05:00.000Z")).toBe(false);
  });

  it("is false once now is past expiresAt", () => {
    expect(isGrantActive(grant(), "2026-09-29T10:05:00.001Z")).toBe(false);
  });

  it("is false for a consumed grant even before its expiry", () => {
    expect(isGrantActive(grant({ status: "consumed" }), "2026-09-29T10:00:00.000Z")).toBe(false);
  });

  it("is false for a revoked grant even before its expiry", () => {
    expect(isGrantActive(grant({ status: "revoked" }), "2026-09-29T10:00:00.000Z")).toBe(false);
  });

  it("is false for a grant already marked expired", () => {
    expect(isGrantActive(grant({ status: "expired" }), "2026-09-29T10:00:00.000Z")).toBe(false);
  });
});

describe("commit grant instants", () => {
  const grant = () =>
    newGrant({
      id: "grant-001",
      errandId: "errand-001",
      offerId: "offer-001",
      token: "token-001",
      now: "2026-09-29T10:00:00.000Z",
      ttlSeconds: 900,
    });

  it("treats an offset timestamp before expiry as active", () => {
    // 11:20 at +02:00 is 09:20 UTC, before the 10:15 UTC expiry.
    expect(isGrantActive(grant(), "2026-09-29T11:20:00+02:00")).toBe(true);
  });

  it("treats an offset timestamp after expiry as expired", () => {
    // 09:20 at -02:00 is 11:20 UTC, after the 10:15 UTC expiry.
    expect(isGrantActive(grant(), "2026-09-29T09:20:00-02:00")).toBe(false);
  });

  it("stores issuedAt and expiresAt as canonical UTC instants", () => {
    const created = newGrant({
      id: "grant-002",
      errandId: "errand-001",
      offerId: "offer-001",
      token: "token-002",
      now: "2026-09-29T12:00:00+02:00",
      ttlSeconds: 60,
    });
    expect(created.issuedAt).toBe("2026-09-29T10:00:00.000Z");
    expect(created.expiresAt).toBe("2026-09-29T10:01:00.000Z");
  });

  it("rejects an unparseable now with a descriptive RangeError", () => {
    expect(() =>
      newGrant({
        id: "grant-003",
        errandId: "errand-001",
        offerId: "offer-001",
        token: "token-003",
        now: "not a time",
        ttlSeconds: 60,
      }),
    ).toThrow(/now must be an ISO 8601 instant/);
    expect(() => isGrantActive(grant(), "yesterday")).toThrow(/now must be an ISO 8601 instant/);
  });
});
