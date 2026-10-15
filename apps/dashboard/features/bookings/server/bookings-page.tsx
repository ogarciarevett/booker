import "server-only";
import type { ReactNode } from "react";
import { LiveUpdates } from "@/components/live-updates.tsx";
import { PageHeader } from "@/components/page-header.tsx";
import { Unavailable } from "@/components/unavailable.tsx";
import { BookerUnavailableError, bookerFromEnvironment } from "@/lib/server/booker.ts";
import { BookingsTable } from "../components/bookings-table.tsx";

/** Container for the bookings list. */
export async function BookingsPage() {
  const { booker } = bookerFromEnvironment();
  let content: ReactNode;
  try {
    content = <BookingsTable bookings={await booker.listBookings()} />;
  } catch (error) {
    if (!(error instanceof BookerUnavailableError)) throw error;
    content = <Unavailable message={error.message} />;
  }
  return (
    <>
      <PageHeader title="Bookings">
        <LiveUpdates />
      </PageHeader>
      {content}
    </>
  );
}
