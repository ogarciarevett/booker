import { describe, expect, it } from "vitest";
import {
  addMoney,
  CurrencyMismatchError,
  compareMoney,
  money,
  moneySchema,
  multiplyMoney,
  sumMoney,
} from "./money.ts";

describe("money", () => {
  it("constructs a Money value from a safe integer amount and an uppercase currency", () => {
    expect(money(1_050, "EUR")).toEqual({ amountCents: 1_050, currency: "EUR" });
  });

  it("rejects a non safe integer amount", () => {
    expect(() => money(1.5, "EUR")).toThrow(RangeError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "EUR")).toThrow(RangeError);
  });

  it("rejects a currency that is not a 3-letter uppercase code", () => {
    expect(() => money(100, "eur")).toThrow(RangeError);
    expect(() => money(100, "EU")).toThrow(RangeError);
    expect(() => money(100, "EURO")).toThrow(RangeError);
  });

  it("adds two Money values in the same currency", () => {
    expect(addMoney(money(100, "EUR"), money(50, "EUR"))).toEqual({
      amountCents: 150,
      currency: "EUR",
    });
  });

  it("throws CurrencyMismatchError when adding different currencies", () => {
    expect(() => addMoney(money(100, "EUR"), money(50, "USD"))).toThrow(CurrencyMismatchError);
  });

  it("sums a list of Money values", () => {
    expect(sumMoney([money(100, "EUR"), money(200, "EUR"), money(300, "EUR")], "EUR")).toEqual({
      amountCents: 600,
      currency: "EUR",
    });
  });

  it("returns zero in the requested currency for an empty list", () => {
    expect(sumMoney([], "EUR")).toEqual({ amountCents: 0, currency: "EUR" });
  });

  it("rejects a mismatched currency inside the list", () => {
    expect(() => sumMoney([money(100, "EUR"), money(50, "USD")], "EUR")).toThrow(
      CurrencyMismatchError,
    );
  });

  it("multiplies a Money value by an integer", () => {
    expect(multiplyMoney(money(150, "EUR"), 3)).toEqual({ amountCents: 450, currency: "EUR" });
  });

  it("rejects a non-integer multiplier", () => {
    expect(() => multiplyMoney(money(150, "EUR"), 1.5)).toThrow(RangeError);
  });

  it("compares two Money values in the same currency", () => {
    expect(compareMoney(money(100, "EUR"), money(200, "EUR"))).toBe(-1);
    expect(compareMoney(money(200, "EUR"), money(100, "EUR"))).toBe(1);
    expect(compareMoney(money(100, "EUR"), money(100, "EUR"))).toBe(0);
  });

  it("throws CurrencyMismatchError when comparing different currencies", () => {
    expect(() => compareMoney(money(100, "EUR"), money(100, "USD"))).toThrow(CurrencyMismatchError);
  });

  it("validates a Money-shaped value with moneySchema", () => {
    expect(moneySchema.safeParse({ amountCents: 100, currency: "EUR" }).success).toBe(true);
    expect(moneySchema.safeParse({ amountCents: 1.5, currency: "EUR" }).success).toBe(false);
    expect(moneySchema.safeParse({ amountCents: 100, currency: "eur" }).success).toBe(false);
  });
});
