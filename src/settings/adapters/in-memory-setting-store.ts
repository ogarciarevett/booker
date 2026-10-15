import type { SettingStore } from "../setting-store.ts";

/** Non-secret settings in a map, for tests. */
export class InMemorySettingStore implements SettingStore {
  private readonly values = new Map<string, string>();

  async get(name: string): Promise<string | undefined> {
    return this.values.get(name);
  }

  async all(): Promise<ReadonlyMap<string, string>> {
    return new Map(this.values);
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name, value);
  }

  async remove(name: string): Promise<boolean> {
    return this.values.delete(name);
  }
}
