"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { keyboardAction } from "./keyboard-navigation.ts";

const TEXT_FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Linear-style keys for the page's `[data-board-row]` rows: j and k move focus, Enter opens the
 * focused row, and Escape goes to `backHref` when there is one. Shows the keys as a quiet hint.
 */
export function KeyboardShortcuts({ backHref }: { readonly backHref?: string }) {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-board-row]")];
      const focused = document.activeElement;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = keyboardAction({
        key: event.key,
        current: rows.findIndex((row) => row === focused),
        rows: rows.length,
        typing: target !== null && (target.isContentEditable || TEXT_FIELDS.has(target.tagName)),
        modifier: event.metaKey || event.ctrlKey || event.altKey,
      });
      switch (action.kind) {
        case "focus":
          event.preventDefault();
          rows[action.index]?.focus();
          rows[action.index]?.scrollIntoView({ block: "nearest" });
          break;
        case "open":
          event.preventDefault();
          rows[action.index]?.click();
          break;
        case "back":
          if (backHref !== undefined) {
            event.preventDefault();
            router.push(backHref);
          }
          break;
        case "none":
          break;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [backHref, router]);

  const key = "rounded border bg-muted px-1 font-mono text-[11px] text-foreground";
  return (
    <p className="hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
      <kbd className={key}>j</kbd>
      <kbd className={key}>k</kbd> move
      <kbd className={key}>↵</kbd> open
      {backHref === undefined ? null : (
        <>
          <kbd className={key}>esc</kbd> back
        </>
      )}
    </p>
  );
}
