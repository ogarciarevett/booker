import { describe, expect, it } from "vitest";
import { parseOffer } from "../offers/offer.ts";
import { draftOfferId, emptyOfferDraft } from "./offer-drafts.ts";

describe("draftOfferId", () => {
  it("is the same for the same errand and provider", () => {
    expect(draftOfferId("errand-001", "provider-northside")).toBe(
      draftOfferId("errand-001", "provider-northside"),
    );
  });

  it("differs by errand and by provider", () => {
    const base = draftOfferId("errand-001", "provider-northside");
    expect(draftOfferId("errand-002", "provider-northside")).not.toBe(base);
    expect(draftOfferId("errand-001", "provider-harbor")).not.toBe(base);
  });

  it("never lets a separator inside an id collide with another pair", () => {
    expect(draftOfferId("errand:a", "b")).not.toBe(draftOfferId("errand", "a:b"));
  });
});

describe("emptyOfferDraft", () => {
  it("builds a valid offer with every field unknown and the deterministic id", () => {
    const draft = emptyOfferDraft("errand-001", "provider-northside", "2026-09-30T12:00:00+02:00");

    expect(parseOffer(draft).ok).toBe(true);
    expect(draft).toEqual({
      id: draftOfferId("errand-001", "provider-northside"),
      errandId: "errand-001",
      providerId: "provider-northside",
      queriedAt: "2026-09-30T10:00:00.000Z",
      seatsAvailable: { status: "unknown" },
      dates: { status: "unknown" },
      location: { status: "unknown" },
      costItems: [],
      deposit: { status: "unknown" },
      cancellationPenalty: { status: "unknown" },
      extras: [],
      customFields: {},
    });
  });
});
