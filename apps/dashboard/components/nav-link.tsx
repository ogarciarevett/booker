"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A main-navigation link that marks itself current for its own path and any `also` prefix. */
export function NavLink({
  href,
  also = [],
  children,
}: {
  readonly href: string;
  readonly also?: readonly string[];
  readonly children: ReactNode;
}) {
  const pathname = usePathname();
  const current =
    pathname === href ||
    (href !== "/" && pathname.startsWith(`${href}/`)) ||
    also.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground no-underline transition-colors hover:text-foreground",
        current ? "bg-card text-foreground shadow-sm" : null,
      )}
    >
      {children}
    </Link>
  );
}
