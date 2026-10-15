import {
  type SecretStatus,
  type SecretStore,
  SecretStoreUnavailableError,
} from "../secret-store.ts";

/**
 * The secret store on a system without the macOS Keychain (CI, Linux): it holds nothing, so
 * secrets come from `.env` or the environment only, and saving one says so.
 */
export class UnavailableSecretStore implements SecretStore {
  async get(_name: string): Promise<string | undefined> {
    return undefined;
  }

  async set(name: string, _value: string): Promise<void> {
    throw new SecretStoreUnavailableError(
      `Booker saves secrets in the macOS Keychain only; on this system set ${name} in .env or the environment.`,
    );
  }

  async remove(_name: string): Promise<boolean> {
    return false;
  }

  async status(_name: string): Promise<SecretStatus> {
    return { configured: false };
  }
}
