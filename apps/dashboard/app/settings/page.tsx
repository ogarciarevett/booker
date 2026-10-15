import type { Metadata } from "next";
import { SettingsPage } from "@/features/settings/server/settings-page.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default function Page() {
  return <SettingsPage />;
}
