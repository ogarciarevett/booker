import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BookingSummary } from "@/lib/types.ts";
import { BookingsTable } from "./bookings-table.tsx";

const PLACED = "2026-10-06T10:00:00.000Z";

describe("BookingsTable", () => {
  it("lists bookings with the provider and their latest status", () => {
    const bookings: BookingSummary[] = [
      {
        id: "booking-001",
        errandId: "errand-driving-school-001",
        offerId: "offer-001",
        providerId: "provider-northside",
        providerName: "Northside Driving School",
        participantIds: ["participant-a", "participant-b"],
        status: "cancelled",
        history: [
          { status: "verbal", at: PLACED },
          { status: "cancelled", at: "2026-10-06T11:00:00.000Z" },
        ],
      },
    ];

    const html = renderToStaticMarkup(<BookingsTable bookings={bookings} />);

    expect(html).toContain("Northside Driving School");
    expect(html).toContain("Cancelled");
    expect(html).toContain("2 participants");
    expect(renderToStaticMarkup(<BookingsTable bookings={[]} />)).toContain("No bookings yet");
  });
});
