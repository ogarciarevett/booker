import type { ReactNode } from "react";

/** A page's title, an optional one-line description, and anything shown beside them. */
export function PageHeader({
  title,
  description,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1.5">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {description === undefined ? null : (
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}
