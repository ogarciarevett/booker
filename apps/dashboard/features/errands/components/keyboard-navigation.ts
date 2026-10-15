// The keyboard rules of the errand pages, kept apart from the DOM so they can be tested: j and k
// move between rows, Enter opens the focused one, Escape goes back.

export type KeyboardAction =
  | { readonly kind: "none" }
  | { readonly kind: "focus"; readonly index: number }
  | { readonly kind: "open"; readonly index: number }
  | { readonly kind: "back" };

export interface KeyboardInput {
  readonly key: string;
  /** The focused row's index, or -1 when no row has focus. */
  readonly current: number;
  readonly rows: number;
  /** Focus is in a text field: keys belong to it. */
  readonly typing?: boolean;
  /** Cmd, Ctrl, or Alt is held: keys belong to the browser. */
  readonly modifier?: boolean;
}

const NONE: KeyboardAction = { kind: "none" };

export function keyboardAction(input: KeyboardInput): KeyboardAction {
  if (input.typing === true || input.modifier === true) return NONE;
  switch (input.key) {
    case "j":
      if (input.rows === 0) return NONE;
      return { kind: "focus", index: Math.min(input.current + 1, input.rows - 1) };
    case "k":
      if (input.rows === 0) return NONE;
      return { kind: "focus", index: Math.max(input.current - 1, 0) };
    case "Enter":
      return input.current < 0 ? NONE : { kind: "open", index: input.current };
    case "Escape":
      return { kind: "back" };
    default:
      return NONE;
  }
}
