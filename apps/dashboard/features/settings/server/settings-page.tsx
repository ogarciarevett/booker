import "server-only";
import type { ReactNode } from "react";
import { LiveUpdates } from "@/components/live-updates.tsx";
import { PageHeader } from "@/components/page-header.tsx";
import { Unavailable } from "@/components/unavailable.tsx";
import { BookerUnavailableError, bookerFromEnvironment } from "@/lib/server/booker.ts";
import { SettingsView } from "../components/settings-view.tsx";

/** Container for the settings: reads them from Booker on the server. */
export async function SettingsPage() {
  const { booker } = bookerFromEnvironment();
  let content: ReactNode;
  try {
    content = <SettingsView {...(await booker.listSettings())} />;
  } catch (error) {
    if (!(error instanceof BookerUnavailableError)) throw error;
    content = <Unavailable message={error.message} />;
  }
  return (
    <>
      <PageHeader
        title="Settings"
        description="Where each value comes from, and the ones you can change here."
      >
        <LiveUpdates watch="settings" />
      </PageHeader>
      {content}
    </>
  );
}
