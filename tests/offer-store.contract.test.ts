import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryOfferStore } from "../src/calls/adapters/in-memory-offer-store.ts";
import { emptyOfferDraft, type OfferStore } from "../src/calls/offer-drafts.ts";
import { known } from "../src/offers/field.ts";
import type { Offer } from "../src/offers/offer.ts";
import { migrate, openDatabase } from "../src/persistence/database.ts";
import { SqliteOfferStore } from "../src/persistence/sqlite-offer-store.ts";

interface Subject {
  readonly store: OfferStore;
  readonly teardown: () => void;
}

interface SubjectFactory {
  readonly name: string;
  create(): Promise<Subject> | Subject;
}

function offer(overrides: Partial<Offer> = {}): Offer {
  return {
    ...emptyOfferDraft("errand-001", "provider-northside", "2026-09-30T10:00:00.000Z"),
    ...overrides,
  };
}

const LOCATION = known("Northside district", {
  source: "call",
  reference: "call-001",
  quote: "We are in the Northside district.",
  capturedAt: "2026-09-30T10:01:00.000Z",
});

/** One contract suite, run against the in-memory and SQLite `OfferStore` adapters. */
function describeOfferStoreContract(factory: SubjectFactory): void {
  describe(`offer store contract: ${factory.name}`, () => {
    let subject: Subject;

    beforeEach(async () => {
      subject = await factory.create();
    });

    afterEach(() => {
      subject.teardown();
    });

    it("returns undefined when the provider has no offer for the errand", async () => {
      expect(await subject.store.forProvider("errand-001", "provider-northside")).toBeUndefined();
    });

    it("saves an offer and finds it for its errand and provider only", async () => {
      await subject.store.save(offer());
      expect(await subject.store.forProvider("errand-001", "provider-northside")).toEqual(offer());
      expect(await subject.store.forProvider("errand-001", "provider-harbor")).toBeUndefined();
      expect(await subject.store.forProvider("errand-002", "provider-northside")).toBeUndefined();
    });

    it("replaces an offer saved again under the same id", async () => {
      await subject.store.save(offer());
      await subject.store.save(offer({ location: LOCATION }));
      expect(await subject.store.forProvider("errand-001", "provider-northside")).toEqual(
        offer({ location: LOCATION }),
      );
    });

    it("returns the latest offer by queriedAt, then by id", async () => {
      await subject.store.save(offer({ id: "offer-b", queriedAt: "2026-09-30T12:00:00.000Z" }));
      await subject.store.save(offer({ id: "offer-a", queriedAt: "2026-09-30T09:00:00.000Z" }));
      expect((await subject.store.forProvider("errand-001", "provider-northside"))?.id).toBe(
        "offer-b",
      );

      await subject.store.save(offer({ id: "offer-c", queriedAt: "2026-09-30T12:00:00.000Z" }));
      expect((await subject.store.forProvider("errand-001", "provider-northside"))?.id).toBe(
        "offer-c",
      );
    });

    it("compares queriedAt as instants, not as text", async () => {
      await subject.store.save(offer({ id: "offer-utc", queriedAt: "2026-09-30T11:00:00.000Z" }));
      // 12:30+02:00 is 10:30Z, earlier than 11:00Z even though it sorts later as text.
      await subject.store.save(
        offer({ id: "offer-offset", queriedAt: "2026-09-30T12:30:00+02:00" }),
      );
      expect((await subject.store.forProvider("errand-001", "provider-northside"))?.id).toBe(
        "offer-utc",
      );
    });

    it("never shares state with an offer passed in or handed out", async () => {
      const original = offer();
      await subject.store.save(original);
      (original.costItems as unknown[]).push({ id: "intruder" });

      const found = await subject.store.forProvider("errand-001", "provider-northside");
      if (found === undefined) throw new Error("expected the offer to exist");
      (found.extras as unknown[]).push({ id: "intruder" });

      expect(await subject.store.forProvider("errand-001", "provider-northside")).toEqual(offer());
    });
  });
}

describeOfferStoreContract({
  name: "in-memory",
  create: () => ({ store: new InMemoryOfferStore(), teardown: () => {} }),
});

describeOfferStoreContract({
  name: "sqlite",
  create: async () => {
    const dir = mkdtempSync(join(tmpdir(), "booker-offer-store-"));
    const db = openDatabase(`file:${join(dir, "test.db")}`);
    await migrate(db);
    return {
      store: new SqliteOfferStore(db),
      teardown: () => {
        db.$client.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
});
