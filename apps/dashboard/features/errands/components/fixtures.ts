// Fictional errands for the view tests: the shapes GET /control/errands and /control/errands/:id
// answer, with masked numbers only.
import type { ErrandCounts, ErrandDetail, ErrandSummary } from "@/lib/errands.ts";

const NO_COUNTS: ErrandCounts = {
  notCalled: 0,
  calling: 0,
  quoted: 0,
  declined: 0,
  ruledOut: 0,
  noAnswer: 0,
  noQuote: 0,
  failed: 0,
  pending: 0,
};

export function errandSummary(
  overrides: Partial<ErrandSummary> & Pick<ErrandSummary, "errandId">,
): ErrandSummary {
  return {
    kind: "driving-school",
    objective: `Objective of ${overrides.errandId}`,
    createdAt: "2026-10-08T08:00:00.000Z",
    stage: "preparing",
    counts: NO_COUNTS,
    progress: { done: 0, total: 3 },
    providerCount: 3,
    leadingProviderId: null,
    lastActivityAt: null,
    ...overrides,
  };
}

export const drivingSchoolDetail: ErrandDetail = {
  ...errandSummary({
    errandId: "errand-driving-school-001",
    objective: "Enroll two participants in an intensive course",
    stage: "calling",
    counts: { ...NO_COUNTS, calling: 1, quoted: 1, declined: 1, noAnswer: 1, pending: 1 },
    progress: { done: 2, total: 4 },
    providerCount: 4,
    leadingProviderId: "provider-harbor",
    lastActivityAt: "2026-10-08T09:30:00.000Z",
  }),
  providers: [
    {
      providerId: "provider-northside",
      name: "Northside Driving School",
      phone: "+*******0100",
      status: "calling",
      reasons: [],
      attempts: 1,
      maxAttempts: 2,
      canRetry: false,
      lastCallId: "call-001",
      offer: null,
    },
    {
      providerId: "provider-harbor",
      name: "Harbor View Driving Academy",
      phone: "+*******0101",
      status: "quoted",
      reasons: [],
      attempts: 1,
      maxAttempts: 2,
      canRetry: true,
      lastCallId: "call-002",
      offer: {
        evaluation: "incomplete",
        total: { amountCents: 110_000, currency: "EUR" },
        perPerson: { amountCents: 55_000, currency: "EUR" },
        estimated: true,
        unknowns: ["total: cost is not fully confirmed"],
        failures: [],
      },
    },
    {
      providerId: "provider-lakeside",
      name: "Lakeside Driving",
      phone: "+*******0102",
      status: "declined_by_provider",
      reasons: ["No seats available"],
      quote: "We are full until December.",
      attempts: 1,
      maxAttempts: 2,
      canRetry: true,
      lastCallId: "call-003",
      offer: null,
    },
    {
      providerId: "provider-hilltop",
      name: "Hilltop Lessons",
      phone: "+*******0103",
      status: "no_answer",
      reasons: ["No answer (attempt 1 of 2)"],
      attempts: 1,
      maxAttempts: 2,
      canRetry: true,
      lastCallId: "call-004",
      offer: null,
    },
  ],
  ranking: [
    {
      providerId: "provider-harbor",
      name: "Harbor View Driving Academy",
      evaluation: "incomplete",
      total: { amountCents: 110_000, currency: "EUR" },
      estimated: true,
      unknownCount: 1,
    },
  ],
  missing: {
    providersToCall: [{ providerId: "provider-hilltop", name: "Hilltop Lessons" }],
    leadingProviderId: "provider-harbor",
    unknownFields: ["total: cost is not fully confirmed"],
    writtenConfirmation: "pending",
    commit: { state: "none" },
  },
};
