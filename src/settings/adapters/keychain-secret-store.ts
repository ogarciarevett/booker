import { type SecretStatus, type SecretStore, secretStatus } from "../secret-store.ts";

/** The part of `@napi-rs/keyring`'s `AsyncEntry` this adapter uses, so tests can fake it. */
export interface KeychainEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export interface KeychainSecretStoreOptions {
  /** The Keychain item's service (`booker`); the account is the setting's name. */
  readonly service: string;
  readonly entry: (service: string, account: string) => KeychainEntry;
}

/** keyring-rs reports a missing item as `NoEntry`: "No matching entry found in secure storage". */
function isMissingItem(error: unknown): boolean {
  return error instanceof Error && /no matching entry/i.test(error.message);
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r\n|\r|\n/u, 1)[0] ?? "";
}

/**
 * Secrets as generic passwords in the owner's login Keychain, one item per setting under one
 * service. The async entry runs each Keychain call off the event loop, so a macOS prompt
 * ("node wants to use your confidential information") never blocks the server. Errors name the
 * setting and the Keychain's own message, which never contains a password.
 */
export class KeychainSecretStore implements SecretStore {
  private readonly service: string;
  private readonly entry: KeychainSecretStoreOptions["entry"];

  constructor(options: KeychainSecretStoreOptions) {
    this.service = options.service;
    this.entry = options.entry;
  }

  async get(name: string): Promise<string | undefined> {
    try {
      const value = await this.entry(this.service, name).getPassword();
      return value === null || value === undefined || value === "" ? undefined : value;
    } catch (error) {
      if (isMissingItem(error)) return undefined;
      throw new Error(`The macOS Keychain could not read ${name}: ${firstLine(error)}`);
    }
  }

  async set(name: string, value: string): Promise<void> {
    try {
      await this.entry(this.service, name).setPassword(value);
    } catch (error) {
      throw new Error(`The macOS Keychain could not save ${name}: ${firstLine(error)}`);
    }
  }

  async remove(name: string): Promise<boolean> {
    try {
      return await this.entry(this.service, name).deleteCredential();
    } catch (error) {
      if (isMissingItem(error)) return false;
      throw new Error(`The macOS Keychain could not remove ${name}: ${firstLine(error)}`);
    }
  }

  async status(name: string): Promise<SecretStatus> {
    return secretStatus(await this.get(name));
  }
}
