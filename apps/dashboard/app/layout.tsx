import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Booker", template: "%s · Booker" },
  description: "Booker's calls, offers, and bookings on this Mac.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
