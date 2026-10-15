import type { ReactNode } from "react";

/** A designed "nothing here yet" surface, with what to do about it. */
export function EmptyState({ children }: { readonly children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed px-5 py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  );
}
