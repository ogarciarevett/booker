import type { Metadata } from "next";
import { CallsPage } from "@/features/calls/server/calls-page.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Calls · Booker" } };

export default function Page() {
  return <CallsPage />;
}
