import { localDateSchema } from "./dates.ts";

// An ISO 8601 date-time with an explicit offset. Offset-less times would be read in the
// host's local time zone, so they are rejected rather than guessed.
const ISO_INSTANT =
  /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Epoch milliseconds of an ISO 8601 instant; throws a RangeError naming `label` otherwise. */
export function instantMillis(value: string, label = "now"): number {
  const match = ISO_INSTANT.exec(value);
  const millis = Date.parse(value);
  if (match === null || !localDateSchema.safeParse(match[1]).success || Number.isNaN(millis)) {
    throw new RangeError(
      `${label} must be an ISO 8601 instant with an explicit offset, got "${value}"`,
    );
  }
  return millis;
}

/** Canonical UTC form (`YYYY-MM-DDTHH:mm:ss.sssZ`) of an ISO 8601 instant. */
export function toCanonicalInstant(value: string, label = "now"): string {
  return new Date(instantMillis(value, label)).toISOString();
}
