import { PhoneCall } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { NavLink } from "./nav-link.tsx";

/** The frame around every page: a skip link, the brand and main navigation, and the content. */
export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold tracking-tight no-underline"
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <PhoneCall aria-hidden="true" className="size-4" />
            </span>
            <span>
              <span className="block text-base">Booker</span>
              <span className="block text-xs font-normal tracking-normal text-muted-foreground">
                Your calls, quotes and bookings
              </span>
            </span>
          </Link>
          <nav
            aria-label="Main"
            className="flex w-full items-center justify-between gap-1 rounded-lg bg-muted/60 p-1 sm:w-auto"
          >
            <NavLink href="/errands">Errands</NavLink>
            <NavLink href="/" also={["/calls"]}>
              Calls
            </NavLink>
            <NavLink href="/bookings">Bookings</NavLink>
            <NavLink href="/settings">Settings</NavLink>
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 pt-8 pb-16 sm:px-6 sm:pt-10">
        {children}
      </main>
    </>
  );
}
