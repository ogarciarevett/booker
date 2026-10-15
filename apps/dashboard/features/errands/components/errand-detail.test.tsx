import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrandDetailView } from "./errand-detail.tsx";
import { drivingSchoolDetail } from "./fixtures.ts";

describe("ErrandDetailView", () => {
  const html = renderToStaticMarkup(<ErrandDetailView errand={drivingSchoolDetail} />);
  const text = html.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ");

  it("heads the page with the objective, the stage, and the progress", () => {
    expect(html).toMatch(/<h1[^>]*>Enroll two participants in an intensive course<\/h1>/);
    expect(text).toContain("Calling");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="2"[^>]*aria-valuemax="4"/);
  });

  it("gives every provider a row with its status in words, its reason, and a masked number", () => {
    expect(text).toContain("Northside Driving School");
    expect(text).toContain("+*******0100");
    expect(text).toContain("Declined by provider");
    expect(text).toContain("No seats available");
    expect(text).toContain("We are full until December.");
    expect(text).toContain("No answer (attempt 1 of 2)");
    expect(text).toContain("1,100.00 EUR");
    expect(text).toContain("550.00 EUR per person");
    expect(html.match(/data-board-row=""/g)).toHaveLength(4);
    expect(html).toContain('href="/calls/call-002"');
  });

  it("ranks the quotes and lists what is missing to close", () => {
    expect(text).toContain("Ranked quotes");
    expect(text).toContain("Missing to close");
    expect(text).toContain("Call Hilltop Lessons");
    expect(text).toContain("total: cost is not fully confirmed");
    expect(text).toContain("Written confirmation pending");
    expect(text).toContain("No commit grant or booking yet");
  });

  it("shows an active grant whose provider Booker could not tell", () => {
    const unknownProvider = renderToStaticMarkup(
      <ErrandDetailView
        errand={{
          ...drivingSchoolDetail,
          missing: {
            ...drivingSchoolDetail.missing,
            commit: {
              state: "grant_active",
              providerId: null,
              grantExpiresAt: "2026-10-08T10:10:00.000Z",
            },
          },
        }}
      />,
    ).replaceAll(/<[^>]+>/g, " ");

    expect(unknownProvider).toMatch(/Commit grant for an unknown provider active until/);
  });

  it("renders a stage and a provider status it does not know as Unknown, with a neutral icon", () => {
    const [first, ...rest] = drivingSchoolDetail.providers;
    if (first === undefined) throw new Error("expected a provider");
    const html = renderToStaticMarkup(
      <ErrandDetailView
        errand={{
          ...drivingSchoolDetail,
          stage: "unknown",
          providers: [{ ...first, status: "unknown" }, ...rest],
        }}
      />,
    );
    const shown = html.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ");

    expect(shown).toContain("Unknown");
    expect(shown).toContain("Northside Driving School");
    expect(html).toContain("lucide-circle-question-mark");
  });
});
