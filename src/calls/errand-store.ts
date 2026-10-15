import type { ErrandBrief } from "../errands/brief.ts";

/**
 * Port for reading and writing errand briefs. `save` inserts or replaces a brief by id, keeping
 * the time it was first saved; `now` must be an ISO 8601 instant with an offset. Every stored or
 * returned brief is an independent copy. The voice tools only ever read briefs: nothing a
 * provider says may change one.
 */
export interface ErrandStore {
  save(brief: ErrandBrief, now: string): Promise<void>;
  get(errandId: string): Promise<ErrandBrief | undefined>;
  /** Up to `limit` errands, newest first by when each was first saved (ties by id). */
  listRecent(limit: number): Promise<StoredErrand[]>;
}

/** A stored brief and when it was first saved (an ISO instant). */
export interface StoredErrand {
  readonly brief: ErrandBrief;
  readonly createdAt: string;
}

/** Newest first by `createdAt`, ties by id, for `ErrandStore.listRecent`. */
export function newestErrandsFirst(
  errands: readonly StoredErrand[],
  limit: number,
): StoredErrand[] {
  return [...errands]
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.brief.id < b.brief.id
          ? -1
          : 1
        : a.createdAt < b.createdAt
          ? 1
          : -1,
    )
    .slice(0, limit);
}
