import "server-only";
import type { ReactNode } from "react";
import { LiveUpdates } from "@/components/live-updates.tsx";
import { PageHeader } from "@/components/page-header.tsx";
import { Unavailable } from "@/components/unavailable.tsx";
import { BookerUnavailableError, bookerFromEnvironment } from "@/lib/server/booker.ts";
import { ErrandBoard } from "../components/errand-board.tsx";
import { KeyboardShortcuts } from "../components/keyboard-shortcuts.tsx";

/** Container for the errand board: reads every errand's overview on the server. */
export async function ErrandsPage() {
  const { booker } = bookerFromEnvironment();
  let content: ReactNode;
  try {
    content = <ErrandBoard errands={await booker.listErrands()} />;
  } catch (error) {
    if (!(error instanceof BookerUnavailableError)) throw error;
    content = <Unavailable message={error.message} />;
  }
  return (
    <>
      <PageHeader
        title="Errands"
        description="From the first quote to the final confirmation. See what is moving and what needs you."
      >
        <div className="flex flex-col items-end gap-2">
          <LiveUpdates watch="errands" />
          <KeyboardShortcuts />
        </div>
      </PageHeader>
      {content}
    </>
  );
}
