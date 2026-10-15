/**
 * Where secrets saved from the dashboard are kept: the macOS Keychain in production
 * (`adapters/keychain-secret-store.ts`), a map in tests. Values go in and come out only through
 * `get`; anything shown to the owner uses `status`, which never carries the value.
 */
export interface SecretStore {
  /** The saved secret, or `undefined` when there is none. */
  get(name: string): Promise<string | undefined>;
  /** Saves or replaces the secret. */
  set(name: string, value: string): Promise<void>;
  /** Removes the secret; `false` when there was none. */
  remove(name: string): Promise<boolean>;
  status(name: string): Promise<SecretStatus>;
}

/** Whether a secret is saved and, when it is long enough to mask, its last four characters. */
export interface SecretStatus {
  readonly configured: boolean;
  readonly lastFour?: string;
}

/** Shorter secrets show no characters at all: four of eight would give away half. */
export const MIN_LENGTH_FOR_LAST_FOUR = 12;

export function secretStatus(value: string | undefined): SecretStatus {
  if (value === undefined || value === "") return { configured: false };
  return value.length >= MIN_LENGTH_FOR_LAST_FOUR
    ? { configured: true, lastFour: value.slice(-4) }
    : { configured: true };
}

/** This system has nowhere to keep secrets (Booker saves them in the macOS Keychain only). */
export class SecretStoreUnavailableError extends Error {
  override readonly name = "SecretStoreUnavailableError";
}

/**
 * `store`, calling `onValue` with every secret value it hands out or saves, so the server can
 * redact a secret saved from the dashboard from logs and spans from then on.
 */
export function onSecretValue(store: SecretStore, onValue: (value: string) => void): SecretStore {
  return {
    get: async (name) => {
      const value = await store.get(name);
      if (value !== undefined && value !== "") onValue(value);
      return value;
    },
    set: async (name, value) => {
      await store.set(name, value);
      onValue(value);
    },
    remove: (name) => store.remove(name),
    status: (name) => store.status(name),
  };
}
