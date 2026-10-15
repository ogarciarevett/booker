import { describe, expect, it } from "vitest";
import { errandBriefSchema, parseErrandBrief } from "./brief.ts";

function validBrief(): unknown {
  return {
    id: "errand-001",
    kind: "driving-school",
    objective: "Enroll one participant in an intensive driving course.",
    timeZone: "Europe/Madrid",
    participants: [
      {
        id: "participant-a",
        label: "Participant A",
        attributes: { theoryExamPassed: true },
      },
    ],
    location: {
      area: "Northside district",
      acceptableAlternatives: ["Northside Annex"],
    },
    dates: {
      window: { start: "2026-11-02", end: "2026-11-13" },
      flexibilityDays: 3,
    },
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
    ],
    shareableAttributes: ["theoryExamPassed"],
  };
}

describe("parseErrandBrief", () => {
  it("accepts a fully valid brief", () => {
    const result = parseErrandBrief(validBrief());
    expect(result.ok).toBe(true);
  });

  it("accepts every hard-requirement DSL operator", () => {
    const brief = validBrief() as Record<string, unknown>;
    brief["hardRequirements"] = [
      {
        id: "r-equals",
        description: "equals",
        field: "licenceCategory",
        rule: { op: "equals", value: "B" },
      },
      {
        id: "r-oneof",
        description: "oneOf",
        field: "vehicleType",
        rule: { op: "oneOf", values: ["manual", "automatic"] },
      },
      {
        id: "r-atleast",
        description: "atLeast",
        field: "seatsAvailable",
        rule: { op: "atLeast", value: 1 },
      },
      {
        id: "r-atmost",
        description: "atMost",
        field: "pricePerSession",
        rule: { op: "atMost", value: 50 },
      },
    ];
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(true);
  });

  it("rejects a brief missing required fields", () => {
    const result = parseErrandBrief({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("rejects duplicate participant ids", () => {
    const brief = validBrief() as { participants: Array<Record<string, unknown>> };
    brief.participants.push({ ...brief.participants[0] });
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("participants"))).toBe(true);
    }
  });

  it("rejects duplicate provider ids", () => {
    const brief = validBrief() as { providers: Array<Record<string, unknown>> };
    brief.providers.push({ ...brief.providers[0] });
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("providers"))).toBe(true);
    }
  });

  it("rejects duplicate hard-requirement ids", () => {
    const brief = validBrief() as { hardRequirements: Array<Record<string, unknown>> };
    brief.hardRequirements.push({ ...brief.hardRequirements[0] });
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("hardRequirements"))).toBe(true);
    }
  });

  it("rejects duplicate question ids", () => {
    const brief = validBrief() as { questions: Array<Record<string, unknown>> };
    brief.questions.push({ ...brief.questions[0] });
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("questions"))).toBe(true);
    }
  });

  it("rejects a spendLimits Money field whose currency does not match spendLimits.currency", () => {
    const brief = validBrief() as { spendLimits: Record<string, unknown> };
    brief.spendLimits["depositMax"] = { amountCents: 5_000, currency: "USD" };
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("depositMax"))).toBe(true);
    }
  });

  it("rejects a shareableAttributes entry that no participant has", () => {
    const brief = validBrief() as { shareableAttributes: string[] };
    brief.shareableAttributes.push("noSuchAttribute");
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("shareableAttributes"))).toBe(true);
    }
  });

  it("rejects an invalid IANA time zone", () => {
    const brief = validBrief() as { timeZone: string };
    brief.timeZone = "Not/A_Zone";
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("timeZone"))).toBe(true);
    }
  });

  it("rejects a provider phone number that is not E.164", () => {
    const brief = validBrief() as { providers: Array<Record<string, unknown>> };
    const provider = brief.providers[0];
    if (provider) provider["phoneE164"] = "555-0100";
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("phoneE164"))).toBe(true);
    }
  });

  it("rejects a brief with no participants", () => {
    const brief = validBrief() as { participants: unknown[] };
    brief.participants = [];
    const result = parseErrandBrief(brief);
    expect(result.ok).toBe(false);
  });

  it("exposes errandBriefSchema directly for schema composition", () => {
    expect(errandBriefSchema.safeParse(validBrief()).success).toBe(true);
  });
});
