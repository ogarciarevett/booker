import { describe, expect, it } from "vitest";
import { keyboardAction } from "./keyboard-navigation.ts";

describe("keyboardAction", () => {
  const rows = 3;

  it("moves down with j and up with k, starting from the first row and stopping at the ends", () => {
    expect(keyboardAction({ key: "j", current: -1, rows })).toEqual({ kind: "focus", index: 0 });
    expect(keyboardAction({ key: "j", current: 0, rows })).toEqual({ kind: "focus", index: 1 });
    expect(keyboardAction({ key: "j", current: 2, rows })).toEqual({ kind: "focus", index: 2 });
    expect(keyboardAction({ key: "k", current: 2, rows })).toEqual({ kind: "focus", index: 1 });
    expect(keyboardAction({ key: "k", current: 0, rows })).toEqual({ kind: "focus", index: 0 });
    expect(keyboardAction({ key: "k", current: -1, rows })).toEqual({ kind: "focus", index: 0 });
  });

  it("opens the focused row with Enter and goes back with Escape", () => {
    expect(keyboardAction({ key: "Enter", current: 1, rows })).toEqual({ kind: "open", index: 1 });
    expect(keyboardAction({ key: "Enter", current: -1, rows })).toEqual({ kind: "none" });
    expect(keyboardAction({ key: "Escape", current: 1, rows })).toEqual({ kind: "back" });
  });

  it("leaves keys alone while typing, with a modifier, or without rows", () => {
    expect(keyboardAction({ key: "j", current: 0, rows, typing: true })).toEqual({ kind: "none" });
    expect(keyboardAction({ key: "j", current: 0, rows, modifier: true })).toEqual({
      kind: "none",
    });
    expect(keyboardAction({ key: "j", current: -1, rows: 0 })).toEqual({ kind: "none" });
    expect(keyboardAction({ key: "x", current: 0, rows })).toEqual({ kind: "none" });
  });
});
