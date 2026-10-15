import { type SecretStatus, type SecretStore, secretStatus } from "../secret-store.ts";

/** Secrets in a map, for tests: nothing touches the real Keychain. */
export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  async get(name: string): Promise<string | undefined> {
    return this.secrets.get(name);
  }

  async set(name: string, value: string): Promise<void> {
    this.secrets.set(name, value);
  }

  async remove(name: string): Promise<boolean> {
    return this.secrets.delete(name);
  }

  async status(name: string): Promise<SecretStatus> {
    return secretStatus(this.secrets.get(name));
  }
}
