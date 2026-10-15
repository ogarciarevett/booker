import "server-only";
import type { ReactNode } from "react";
import { LiveUpdates } from "@/components/live-updates.tsx";
import { PageHeader } from "@/components/page-header.tsx";
import { Unavailable } from "@/components/unavailable.tsx";
import { BookerUnavailableError, bookerFromEnvironment } from "@/lib/server/booker.ts";
import { CallsTable } from "../components/calls-table.tsx";

/** Container for the calls list: reads Booker on the server, renders the table. */
export async function CallsPage() {
  const { booker } = bookerFromEnvironment();
  let content: ReactNode;
  try {
    content = <CallsTable calls={await booker.listCalls()} />;
  } catch (error) {
    if (!(error instanceof BookerUnavailableError)) throw error;
    content = <Unavailable message={error.message} />;
  }
  return (
    <>
      <PageHeader
        title="Calls"
        description="Follow each conversation, review its quotes, and see what was confirmed."
      >
        <LiveUpdates />
      </PageHeader>
      {content}
    </>
  );
}
