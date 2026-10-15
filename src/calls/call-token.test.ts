import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueCallToken, verifyCallToken } from "./call-token.ts";

function fixedRandomBytes(fill: number) {
  return (size: number) => Buffer.alloc(size, fill);
}

describe("issueCallToken", () => {
  it("derives a base64url token and the hex SHA-256 hash of that token string", () => {
    const bytes = Buffer.alloc(32, 7);
    const issued = issueCallToken(fixedRandomBytes(7));
    const expectedToken = bytes.toString("base64url");
    expect(issued.token).toBe(expectedToken);
    expect(issued.tokenHash).toBe(createHash("sha256").update(expectedToken, "utf8").digest("hex"));
  });

  it("draws exactly 32 random bytes", () => {
    let requestedSize = -1;
    issueCallToken((size) => {
      requestedSize = size;
      return Buffer.alloc(size, 1);
    });
    expect(requestedSize).toBe(32);
  });

  it("issues a different token on each call with the default random source", () => {
    const first = issueCallToken();
    const second = issueCallToken();
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});

describe("verifyCallToken", () => {
  it("accepts the token that produced the hash", () => {
    const { token, tokenHash } = issueCallToken();
    expect(verifyCallToken(token, tokenHash)).toBe(true);
  });

  it("rejects a token that does not hash to tokenHash", () => {
    const { tokenHash } = issueCallToken();
    const other = issueCallToken();
    expect(verifyCallToken(other.token, tokenHash)).toBe(false);
  });

  it("rejects an empty token without throwing", () => {
    const { tokenHash } = issueCallToken();
    expect(verifyCallToken("", tokenHash)).toBe(false);
  });

  it("rejects an empty tokenHash without throwing", () => {
    const { token } = issueCallToken();
    expect(verifyCallToken(token, "")).toBe(false);
  });

  it("rejects both empty without throwing", () => {
    expect(verifyCallToken("", "")).toBe(false);
  });

  it("rejects a tokenHash of a different length without throwing", () => {
    const { token } = issueCallToken();
    expect(verifyCallToken(token, "ab")).toBe(false);
  });

  it("never throws on malformed, non-hex, non-base64url input", () => {
    expect(() => verifyCallToken("not-base64url!! ", "not-hex-either??")).not.toThrow();
    expect(verifyCallToken("not-base64url!! ", "not-hex-either??")).toBe(false);
  });
});

describe("verifyCallToken stored-hash format", () => {
  it("rejects a stored hash with trailing characters after 64 hex digits", () => {
    const { token, tokenHash } = issueCallToken(fixedRandomBytes(7));
    expect(verifyCallToken(token, `${tokenHash}zz`)).toBe(false);
  });

  it("rejects an uppercase stored hash (hashes are stored in lowercase)", () => {
    const { token, tokenHash } = issueCallToken(fixedRandomBytes(7));
    expect(verifyCallToken(token, tokenHash.toUpperCase())).toBe(false);
  });
});
