import { createHash } from "node:crypto";
import type { Offer } from "../offers/offer.ts";

/**
 * JSON with every object's keys sorted (by UTF-16 code unit) at every depth; arrays keep their
 * order. Undefined properties are dropped and undefined array items become `null`, exactly as
 * `JSON.stringify` and a JSON round trip through storage treat them, so a stored and reloaded
 * value serializes to the same text.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("canonicalJson accepts JSON values only");
  return encoded;
}

/**
 * The fingerprint of an offer's terms as they were authorized: the hex SHA-256 of its canonical
 * JSON. The draft id never changes, so only this digest can tell that the terms changed.
 */
export function offerTermsDigest(offer: Offer): string {
  return createHash("sha256").update(canonicalJson(offer), "utf8").digest("hex");
}
