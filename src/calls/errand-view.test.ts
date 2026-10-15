import { describe, expect, it } from "vitest";
import type { ErrandBrief } from "../errands/brief.ts";
import { parseErrandBrief } from "../errands/brief.ts";
import { shareableErrandView } from "./errand-view.ts";

function brief(overrides: Record<string, unknown> = {}): ErrandBrief {
  const result = parseErrandBrief({
    id: "errand-001",
    kind: "driving-school",
    objective: "Enroll one participant in an intensive driving course.",
    timeZone: "Europe/Madrid",
    participants: [
      {
        id: "participant-a",
        label: "Participant A",
        attributes: { theoryExamPassed: true, homeAddress: "100 Fictional Example Street" },
      },
    ],
    location: { area: "Northside district", acceptableAlternatives: ["Northside Annex"] },
    dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
    hardRequirements: [
      {
        id: "req-licence-category",
        description: "Course must cover licence category B",
        field: "licenceCategory",
        rule: { op: "equals", value: "B" },
      },
    ],
    preferences: [{ id: "pref-morning", description: "Prefer weekday mornings" }],
    spendLimits: {
      currency: "EUR",
      perParticipantMax: { amountCents: 120_000, currency: "EUR" },
      totalMax: { amountCents: 120_000, currency: "EUR" },
    },
    authorizedActions: ["quote", "hold"],
    groupPolicy: { sameProvider: true, allowPartialBooking: false },
    completion: {
      description: "Participant enrolled with a confirmed schedule.",
      requiresWrittenConfirmation: true,
    },
    questions: [{ id: "q-schedule", text: "What start dates are available?" }],
    providers: [
      { id: "provider-northside", name: "Northside Driving School", phoneE164: "+15555550100" },
      { id: "provider-southgate", name: "Southgate Driving School", phoneE164: "+15555550101" },
    ],
    shareableAttributes: ["theoryExamPassed"],
    ...overrides,
  });
  if (!result.ok) throw new Error(`invalid fixture brief: ${result.issues.join(", ")}`);
  return result.brief;
}

describe("shareableErrandView", () => {
  it("includes the objective, provider name, dates, questions, and shareable attributes", () => {
    const view = shareableErrandView(brief(), "provider-northside");
    expect(view).toEqual({
      objective: "Enroll one participant in an intensive driving course.",
      providerName: "Northside Driving School",
      dates: { window: { start: "2026-11-02", end: "2026-11-13" }, flexibilityDays: 3 },
      questions: [{ id: "q-schedule", text: "What start dates are available?" }],
      participants: [{ id: "participant-a", attributes: { theoryExamPassed: true } }],
    });
  });

  it("names the provider the call is actually with, not the first one", () => {
    const view = shareableErrandView(brief(), "provider-southgate");
    expect(view.providerName).toBe("Southgate Driving School");
  });

  it("throws RangeError when providerId is not in the brief", () => {
    expect(() => shareableErrandView(brief(), "provider-unknown")).toThrow(RangeError);
  });

  it("never includes spendLimits values anywhere in the serialized view", () => {
    const view = shareableErrandView(brief(), "provider-northside");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("120000");
  });

  it("never includes an unshared participant attribute value", () => {
    const view = shareableErrandView(brief(), "provider-northside");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("100 Fictional Example Street");
    expect(serialized).not.toContain("homeAddress");
  });

  it("never includes another provider's name or phone number", () => {
    const view = shareableErrandView(brief(), "provider-northside");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("Southgate");
    expect(serialized).not.toContain("+15555550100");
    expect(serialized).not.toContain("+15555550101");
  });
});

describe("shareableErrandView projection", () => {
  it("copies only the named fields of dates and questions, never extra keys", () => {
    const base = brief();
    const withInternals = {
      ...base,
      dates: { ...base.dates, internalNote: "internal only" },
      questions: base.questions.map((question) => ({ ...question, internalNote: "internal only" })),
    } as unknown as ErrandBrief;

    const view = shareableErrandView(withInternals, base.providers[0]?.id ?? "");

    expect(JSON.stringify(view)).not.toContain("internal only");
  });

  it("returns a view the caller cannot use to mutate the brief", () => {
    const base = brief();
    const view = shareableErrandView(base, base.providers[0]?.id ?? "");
    (view.questions[0] as { text: string }).text = "changed";
    expect(base.questions[0]?.text).not.toBe("changed");
  });
});
