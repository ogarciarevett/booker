import type { ErrandBrief } from "../../errands/brief.ts";
import { toCanonicalInstant } from "../../shared/instants.ts";
import { type ErrandStore, newestErrandsFirst, type StoredErrand } from "../errand-store.ts";

/**
 * In-memory `ErrandStore`, useful for tests and the shared contract suite. Not safe across
 * processes; the SQLite adapter is the durable one.
 */
export class InMemoryErrandStore implements ErrandStore {
  private readonly briefs = new Map<string, ErrandBrief>();
  private readonly createdAt = new Map<string, string>();

  async save(brief: ErrandBrief, now: string): Promise<void> {
    // Kept as the first-saved time, like the SQLite adapter.
    const instant = toCanonicalInstant(now);
    if (!this.createdAt.has(brief.id)) this.createdAt.set(brief.id, instant);
    this.briefs.set(brief.id, structuredClone(brief));
  }

  async listRecent(limit: number): Promise<StoredErrand[]> {
    const stored = [...this.briefs.values()].map((brief) => ({
      brief: structuredClone(brief),
      createdAt: this.createdAt.get(brief.id) ?? "",
    }));
    return newestErrandsFirst(stored, limit);
  }

  async get(errandId: string): Promise<ErrandBrief | undefined> {
    const stored = this.briefs.get(errandId);
    return stored === undefined ? undefined : structuredClone(stored);
  }
}
