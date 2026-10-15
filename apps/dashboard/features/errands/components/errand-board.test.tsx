import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrandBoard } from "./errand-board.tsx";
import { errandSummary } from "./fixtures.ts";

const errands = [
  errandSummary({ errandId: "errand-booked", stage: "booked", progress: { done: 3, total: 3 } }),
  errandSummary({
    errandId: "errand-calling",
    stage: "calling",
    counts: {
      notCalled: 0,
      calling: 2,
      quoted: 1,
      declined: 1,
      ruledOut: 0,
      noAnswer: 1,
      noQuote: 0,
      failed: 0,
      pending: 1,
    },
    progress: { done: 2, total: 5 },
    providerCount: 5,
  }),
  errandSummary({ errandId: "errand-waiting", stage: "waiting_for_you" }),
  errandSummary({ errandId: "errand-other-call", stage: "calling" }),
  errandSummary({ errandId: "errand-from-the-future", stage: "unknown" }),
];

describe("ErrandBoard", () => {
  const html = renderToStaticMarkup(<ErrandBoard errands={errands} />);

  it("groups errands by stage, in the order work moves, with a count per group", () => {
    const headings = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gs)].map((match) =>
      (match[1] ?? "")
        .replaceAll(/<[^>]+>/g, " ")
        .replaceAll(/\s+/g, " ")
        .trim(),
    );

    expect(headings).toEqual(["Calling 2", "Waiting for you 1", "Booked 1", "Other 1"]);
  });

  it("links each row to its errand and marks it for keyboard navigation", () => {
    expect(html).toContain('href="/errands/errand-calling"');
    expect(html.match(/data-board-row=""/g)).toHaveLength(5);
  });

  it("shows count chips in words and a progress bar a screen reader can read", () => {
    const row = html.slice(html.indexOf('href="/errands/errand-calling"'));

    expect(row).toContain("2 calling");
    expect(row).toContain("1 quoted");
    expect(row).toContain("1 declined");
    expect(row).toContain("1 no answer");
    expect(row).toContain("1 pending");
    expect(row).toMatch(/role="progressbar"[^>]*aria-valuenow="2"[^>]*aria-valuemax="5"/);
  });

  it("says when there are no errands yet", () => {
    expect(renderToStaticMarkup(<ErrandBoard errands={[]} />)).toContain("No errands yet");
  });

  it("summarizes active work, decisions and bookings without counting closed or unknown errands", () => {
    const summary = html.match(/<dl aria-label="Errand summary".*?<\/dl>/s)?.[0] ?? "";
    expect(summary).toMatch(/In progress<\/dt><dd[^>]*>2<\/dd>/);
    expect(summary).toMatch(/Needs your attention<\/dt><dd[^>]*>1<\/dd>/);
    expect(summary).toMatch(/Booked<\/dt><dd[^>]*>1<\/dd>/);
  });

  it("explains what happens next for each stage", () => {
    expect(html).toContain("Collecting quotes from your chosen providers.");
    expect(html).toContain("Review the open questions before moving forward.");
    expect(html).toContain("Check the confirmation and any remaining steps.");
  });

  it("guides a new owner to configuration without offering a call action", () => {
    const empty = renderToStaticMarkup(<ErrandBoard errands={[]} />);
    expect(empty).toContain('href="/settings"');
    expect(empty).toContain("Review settings");
    expect(empty).toContain("Quotes first. A booking needs permission.");
  });

  it("shows an errand in a stage it does not know under Other, saying the stage is unknown", () => {
    const other = html.slice(html.indexOf('id="stage-other"'));

    expect(other).toContain('href="/errands/errand-from-the-future"');
    expect(other).toContain('aria-label="Stage: Unknown"');
  });
});
