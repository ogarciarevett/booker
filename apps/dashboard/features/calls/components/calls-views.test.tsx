import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CallDetail, CallSummary } from "@/lib/types.ts";
import { CallDetailView } from "./call-detail.tsx";
import { CallsTable } from "./calls-table.tsx";

const PLACED = "2026-10-06T10:00:00.000Z";

const northside: CallSummary = {
  callId: "call-northside",
  errandId: "errand-driving-school-001",
  providerId: "provider-northside",
  providerName: "Northside Driving School",
  providerPhone: "+*******0100",
  purpose: "quote",
  status: "in_progress",
  attempt: 1,
  createdAt: PLACED,
  endedAt: null,
  hasConversation: true,
};

const harbor: CallSummary = {
  ...northside,
  callId: "call-harbor",
  providerId: "provider-harbor",
  providerName: "Harbor View Driving Academy",
  providerPhone: "+*******0101",
  status: "no_answer",
  endedAt: "2026-10-06T10:06:00.000Z",
  hasConversation: false,
};

const detail: CallDetail = {
  ...northside,
  status: "completed",
  endedAt: "2026-10-06T10:04:00.000Z",
  conversationId: "conv-001",
  recorded: [
    {
      field: "location",
      status: "known",
      value: "Northside district",
      quote: "We are in the Northside district.",
      capturedAt: "2026-10-06T10:01:00.000Z",
    },
    {
      field: "costItem:tuition",
      status: "estimated",
      value: {
        amountCents: 55_000,
        currency: "EUR",
        appliesTo: "each-participant",
        kind: "charge",
      },
      quote: "Around 550 euros each, I think.",
      capturedAt: "2026-10-06T10:02:00.000Z",
    },
  ],
  unknown: ["seatsAvailable", "deposit"],
  transcript: {
    receivedAt: "2026-10-06T10:04:30.000Z",
    turns: [
      {
        role: "agent",
        message: "Hello, I am an AI assistant calling for Alex.",
        secondsIntoCall: 0.4,
      },
      { role: "user", message: "We are in the Northside district.", secondsIntoCall: 65 },
    ],
  },
  grant: null,
  booking: {
    id: "booking-001",
    providerId: "provider-northside",
    status: "verbal",
    history: [{ status: "verbal", at: "2026-10-06T10:03:00.000Z" }],
  },
};

describe("CallsTable", () => {
  it("lists each call with its provider, masked number, and status in words", () => {
    const html = renderToStaticMarkup(<CallsTable calls={[northside, harbor]} />);

    expect(html).toContain("Northside Driving School");
    expect(html).toContain("+*******0100");
    expect(html).toContain('href="/calls/call-northside"');
    expect(html).toContain("In progress");
    expect(html).toContain("No answer");
    expect(html).toContain("<caption");
  });

  it("says when there are no calls yet", () => {
    expect(renderToStaticMarkup(<CallsTable calls={[]} />)).toContain("No calls yet");
  });
});

describe("CallDetailView", () => {
  it("shows the provider, timeline, transcript, recorded fields, unknowns, and booking", () => {
    const html = renderToStaticMarkup(
      <CallDetailView
        call={detail}
        phoenix={{ kind: "session", url: "http://127.0.0.1:6006/projects/P/sessions/S" }}
      />,
    );

    expect(html).toContain("Northside Driving School");
    expect(html).toContain("Completed");
    expect(html).toContain("Transcript received");
    expect(html).toContain("Hello, I am an AI assistant calling for Alex.");
    expect(html).toContain("1:05");
    expect(html).toContain("Known");
    expect(html).toContain("Estimated");
    expect(html).toContain("550.00 EUR each participant");
    expect(html).toContain("Around 550 euros each, I think.");
    expect(html).toContain("seatsAvailable");
    expect(html).toContain("No commit grant");
    expect(html).toContain("booking-001");
    expect(html).toContain('href="http://127.0.0.1:6006/projects/P/sessions/S"');
    expect(html).toContain("View trace in Phoenix");
  });

  it("explains a missing trace and a Phoenix that is not running", () => {
    const missing = renderToStaticMarkup(
      <CallDetailView
        call={detail}
        phoenix={{ kind: "missing", phoenixUrl: "http://127.0.0.1:6006" }}
      />,
    );
    const down = renderToStaticMarkup(
      <CallDetailView
        call={{ ...detail, transcript: null, booking: null }}
        phoenix={{ kind: "unreachable", phoenixUrl: "http://127.0.0.1:6006" }}
      />,
    );

    expect(missing).toContain("pnpm serve:traced");
    expect(down).toContain("Phoenix is not running");
    expect(down).toContain("No transcript yet");
  });
});
