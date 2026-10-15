import { asc, desc, eq } from "drizzle-orm";
import type { ErrandStore, StoredErrand } from "../calls/errand-store.ts";
import type { ErrandBrief } from "../errands/brief.ts";
import { toCanonicalInstant } from "../shared/instants.ts";
import type { Database } from "./database.ts";
import { serialized } from "./database.ts";
import { errands } from "./schema.ts";
import { withBusyRetry } from "./sqlite-errors.ts";

/**
 * Drizzle + libsql `ErrandStore`. `save` upserts by id: a new brief replaces the stored one, and
 * `created_at` keeps the time the errand was first saved.
 */
export class SqliteErrandStore implements ErrandStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async save(brief: ErrandBrief, now: string): Promise<void> {
    await serialized(this.db, async () => {
      const createdAt = toCanonicalInstant(now);
      await withBusyRetry(() =>
        this.db
          .insert(errands)
          .values({ id: brief.id, brief, createdAt })
          .onConflictDoUpdate({ target: errands.id, set: { brief } }),
      );
    });
  }

  async get(errandId: string): Promise<ErrandBrief | undefined> {
    return await serialized(this.db, async () => {
      const [row] = await withBusyRetry(() =>
        this.db.select({ brief: errands.brief }).from(errands).where(eq(errands.id, errandId)),
      );
      return row?.brief;
    });
  }

  async listRecent(limit: number): Promise<StoredErrand[]> {
    return await serialized(this.db, async () => {
      const rows = await withBusyRetry(() =>
        this.db
          .select({ brief: errands.brief, createdAt: errands.createdAt })
          .from(errands)
          .orderBy(desc(errands.createdAt), asc(errands.id))
          .limit(limit),
      );
      return rows.map((row) => ({ brief: row.brief, createdAt: row.createdAt }));
    });
  }
}
