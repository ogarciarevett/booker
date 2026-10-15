import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unknown } from "../offers/field.ts";
import { emptyOfferDraft } from "./offer-drafts.ts";
import { canonicalJson, offerTermsDigest } from "./offer-terms.ts";

describe("canonicalJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });

  it("serializes the same value built in a different key order identically", () => {
    expect(canonicalJson({ first: 1, second: { inner: 2, outer: 3 } })).toBe(
      canonicalJson({ second: { outer: 3, inner: 2 }, first: 1 }),
    );
  });

  it("drops undefined properties, as a JSON round trip through storage would", () => {
    expect(canonicalJson({ kept: 1, dropped: undefined })).toBe('{"kept":1}');
  });
});

describe("offerTermsDigest", () => {
  const draft = emptyOfferDraft("errand-001", "provider-northside", "2026-09-30T10:00:00.000Z");

  it("is the hex SHA-256 of the offer's canonical JSON", () => {
    expect(offerTermsDigest(draft)).toBe(
      createHash("sha256").update(canonicalJson(draft), "utf8").digest("hex"),
    );
  });

  it("survives a JSON round trip and changes with any term", () => {
    const roundTripped = JSON.parse(JSON.stringify(draft)) as typeof draft;
    expect(offerTermsDigest(roundTripped)).toBe(offerTermsDigest(draft));
    expect(offerTermsDigest({ ...draft, customFields: { licenceCategory: unknown() } })).not.toBe(
      offerTermsDigest(draft),
    );
  });
});
