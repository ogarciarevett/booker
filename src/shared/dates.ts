import { z } from "zod";

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MILLISECONDS_PER_DAY = 86_400_000;

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function isCalendarCorrectLocalDate(value: string): boolean {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return isRealCalendarDate(Number(year), Number(month), Number(day));
}

/** Branded YYYY-MM-DD calendar date, guaranteed to be a real date (no 2026-02-30). */
export const localDateSchema = z
  .string()
  .regex(LOCAL_DATE_PATTERN, { error: "LocalDate must be formatted as YYYY-MM-DD" })
  .refine(isCalendarCorrectLocalDate, { error: "LocalDate must be a real calendar date" })
  .brand<"LocalDate">();

export type LocalDate = z.infer<typeof localDateSchema>;

export function parseLocalDate(text: string): LocalDate {
  return localDateSchema.parse(text);
}

export interface DateRange {
  readonly start: LocalDate;
  readonly end: LocalDate;
}

/** DateRange is inclusive on both ends; start must not be after end. */
export const dateRangeSchema = z
  .object({
    start: localDateSchema,
    end: localDateSchema,
  })
  .check((ctx) => {
    if (ctx.value.start > ctx.value.end) {
      ctx.issues.push({
        code: "custom",
        message: "DateRange start must not be after end",
        input: ctx.value,
        path: ["end"],
      });
    }
  });

export function isDateWithin(date: LocalDate, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}

export function rangeContains(outer: DateRange, inner: DateRange): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Shifts a LocalDate by a number of days (may be negative), computed in UTC to avoid DST. */
function shiftLocalDate(date: LocalDate, days: number): LocalDate {
  const match = LOCAL_DATE_PATTERN.exec(date) as unknown as [string, string, string, string];
  const [, year, month, day] = match;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const shifted = new Date(base + days * MILLISECONDS_PER_DAY);
  const yyyy = shifted.getUTCFullYear().toString().padStart(4, "0");
  const mm = (shifted.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = shifted.getUTCDate().toString().padStart(2, "0");
  return parseLocalDate(`${yyyy}-${mm}-${dd}`);
}

/**
 * Expands a range by `days` on both ends, calendar-correct across month and year
 * boundaries. `days` must be zero or a positive integer.
 */
export function expandRange(range: DateRange, days: number): DateRange {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(`expandRange days must be a non-negative integer, got ${days}`);
  }
  return {
    start: shiftLocalDate(range.start, -days),
    end: shiftLocalDate(range.end, days),
  };
}

export function isValidTimeZone(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}
