/**
 * Non-secret settings saved from the dashboard, by name (SQLite in production, see
 * `src/persistence/sqlite-setting-store.ts`). Values are stored as written: validation against
 * the catalog happens before `set`.
 */
export interface SettingStore {
  get(name: string): Promise<string | undefined>;
  /** Every saved value, by name. */
  all(): Promise<ReadonlyMap<string, string>>;
  set(name: string, value: string): Promise<void>;
  /** Removes the value; `false` when there was none. */
  remove(name: string): Promise<boolean>;
}
