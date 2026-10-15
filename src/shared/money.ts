import { z } from "zod";

/** ISO 4217 currency codes are three uppercase letters (EUR, USD, ...). */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface Money {
  readonly amountCents: number;
  readonly currency: string;
}

export class CurrencyMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected "${expected}", got "${actual}"`);
    this.name = "CurrencyMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Schema for embedding a Money value inside another zod schema. */
export const moneySchema = z.object({
  amountCents: z.number().int().safe({ error: "amountCents must be a safe integer" }),
  currency: z
    .string()
    .regex(CURRENCY_PATTERN, { error: "currency must be a 3-letter uppercase ISO 4217 code" }),
});

/** Constructs a Money value. Amounts are always an integer number of cents; never a float. */
export function money(amountCents: number, currency: string): Money {
  if (!Number.isSafeInteger(amountCents)) {
    throw new RangeError(`Money amountCents must be a safe integer, got ${amountCents}`);
  }
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new RangeError(
      `Money currency must be a 3-letter uppercase ISO 4217 code, got "${currency}"`,
    );
  }
  return { amountCents, currency };
}

function requireSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function addMoney(a: Money, b: Money): Money {
  requireSameCurrency(a, b);
  return money(a.amountCents + b.amountCents, a.currency);
}

/** Sums a list of Money values. An empty list returns zero in the given currency. */
export function sumMoney(items: readonly Money[], currency: string): Money {
  return items.reduce<Money>((total, item) => addMoney(total, item), money(0, currency));
}

export function multiplyMoney(m: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new RangeError(`multiplyMoney factor must be an integer, got ${factor}`);
  }
  return money(m.amountCents * factor, m.currency);
}

/** Compares two Money values of the same currency: -1, 0, or 1. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  requireSameCurrency(a, b);
  if (a.amountCents < b.amountCents) return -1;
  if (a.amountCents > b.amountCents) return 1;
  return 0;
}
