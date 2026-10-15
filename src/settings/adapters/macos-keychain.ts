import { AsyncEntry } from "@napi-rs/keyring";
import type { SecretStore } from "../secret-store.ts";
import { KeychainSecretStore } from "./keychain-secret-store.ts";

/** The Keychain service Booker's items are filed under; the account is the setting's name. */
export const KEYCHAIN_SERVICE = "booker";

/**
 * The owner's login Keychain through `@napi-rs/keyring`. The composition root, privacy scan
 * command and opt-in manual test import this module. Automated tests never touch the real Keychain.
 */
export function macosKeychain(service: string = KEYCHAIN_SERVICE): SecretStore {
  return new KeychainSecretStore({
    service,
    entry: (itemService, account) => new AsyncEntry(itemService, account),
  });
}
