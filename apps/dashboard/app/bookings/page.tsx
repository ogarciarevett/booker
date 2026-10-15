import type { Metadata } from "next";
import { BookingsPage } from "@/features/bookings/server/bookings-page.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Bookings" };

export default function Page() {
  return <BookingsPage />;
}
