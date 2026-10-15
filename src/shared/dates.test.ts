import { describe, expect, it } from "vitest";
import {
  dateRangeSchema,
  expandRange,
  isDateWithin,
  isValidTimeZone,
  localDateSchema,
  parseLocalDate,
  rangeContains,
} from "./dates.ts";

describe("LocalDate", () => {
  it("parses a valid YYYY-MM-DD calendar date", () => {
    expect(parseLocalDate("2026-11-02")).toBe("2026-11-02");
  });

  it("rejects a malformed date string", () => {
    expect(() => parseLocalDate("2026-1-2")).toThrow();
    expect(() => parseLocalDate("11/02/2026")).toThrow();
  });

  it("rejects a calendar date that does not exist", () => {
    expect(() => parseLocalDate("2026-02-30")).toThrow();
    expect(() => parseLocalDate("2026-04-31")).toThrow();
    expect(() => parseLocalDate("2026-13-01")).toThrow();
  });

  it("accepts a leap-year February 29", () => {
    expect(parseLocalDate("2028-02-29")).toBe("2028-02-29");
  });

  it("rejects February 29 on a non-leap year", () => {
    expect(() => parseLocalDate("2026-02-29")).toThrow();
  });

  it("exposes a zod schema equivalent to parseLocalDate", () => {
    expect(localDateSchema.safeParse("2026-11-02").success).toBe(true);
    expect(localDateSchema.safeParse("2026-02-30").success).toBe(false);
  });
});

describe("DateRange", () => {
  it("accepts a range where start is before or equal to end", () => {
    expect(dateRangeSchema.safeParse({ start: "2026-11-02", end: "2026-11-13" }).success).toBe(
      true,
    );
    expect(dateRangeSchema.safeParse({ start: "2026-11-02", end: "2026-11-02" }).success).toBe(
      true,
    );
  });

  it("rejects a range where start is after end", () => {
    expect(dateRangeSchema.safeParse({ start: "2026-11-13", end: "2026-11-02" }).success).toBe(
      false,
    );
  });

  it("checks whether a date falls within a range, inclusive of both ends", () => {
    const range = { start: parseLocalDate("2026-11-02"), end: parseLocalDate("2026-11-13") };
    expect(isDateWithin(parseLocalDate("2026-11-02"), range)).toBe(true);
    expect(isDateWithin(parseLocalDate("2026-11-13"), range)).toBe(true);
    expect(isDateWithin(parseLocalDate("2026-11-07"), range)).toBe(true);
    expect(isDateWithin(parseLocalDate("2026-11-01"), range)).toBe(false);
    expect(isDateWithin(parseLocalDate("2026-11-14"), range)).toBe(false);
  });

  it("checks whether an outer range fully contains an inner range", () => {
    const outer = { start: parseLocalDate("2026-11-01"), end: parseLocalDate("2026-11-30") };
    const inner = { start: parseLocalDate("2026-11-10"), end: parseLocalDate("2026-11-20") };
    expect(rangeContains(outer, inner)).toBe(true);
    expect(rangeContains(inner, outer)).toBe(false);
  });

  it("expands a range by a number of days on both ends, correct across a month boundary", () => {
    const range = { start: parseLocalDate("2026-11-02"), end: parseLocalDate("2026-11-29") };
    expect(expandRange(range, 3)).toEqual({
      start: parseLocalDate("2026-10-30"),
      end: parseLocalDate("2026-12-02"),
    });
  });

  it("expands a range correctly across a year boundary", () => {
    const range = { start: parseLocalDate("2026-12-30"), end: parseLocalDate("2026-12-31") };
    expect(expandRange(range, 2)).toEqual({
      start: parseLocalDate("2026-12-28"),
      end: parseLocalDate("2027-01-02"),
    });
  });

  it("returns the same range when expanded by zero days", () => {
    const range = { start: parseLocalDate("2026-11-02"), end: parseLocalDate("2026-11-13") };
    expect(expandRange(range, 0)).toEqual(range);
  });
});

describe("isValidTimeZone", () => {
  it("accepts a well-known IANA time zone", () => {
    expect(isValidTimeZone("Europe/Madrid")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects an unknown or malformed time zone", () => {
    expect(isValidTimeZone("Not/A_Zone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
