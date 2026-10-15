import type { ErrandBrief } from "../errands/brief.ts";
import type { ShareableErrandView } from "./tools.ts";

/**
 * Builds the view a provider may hear during a call: the objective, the provider's own
 * name, dates, questions, and each participant's *shareable* attributes only. Never
 * includes spendLimits, standing rules, an unshared attribute value, another provider, or
 * a phone number — those never leave this module.
 */
export function shareableErrandView(brief: ErrandBrief, providerId: string): ShareableErrandView {
  const provider = brief.providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined) {
    throw new RangeError(`shareableErrandView: no provider "${providerId}" in the brief`);
  }

  const shareableKeys = new Set(brief.shareableAttributes);

  return {
    objective: brief.objective,
    providerName: provider.name,
    // Projected field by field so a future internal field never reaches a provider,
    // and copied so the view cannot be used to change the brief.
    dates: {
      window: { start: brief.dates.window.start, end: brief.dates.window.end },
      flexibilityDays: brief.dates.flexibilityDays,
    },
    questions: brief.questions.map((question) => ({ id: question.id, text: question.text })),
    participants: brief.participants.map((participant) => ({
      id: participant.id,
      attributes: Object.fromEntries(
        Object.entries(participant.attributes).filter(([key]) => shareableKeys.has(key)),
      ),
    })),
  };
}
