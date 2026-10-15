import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/settings/adapters/in-memory-secret-store.ts";
import {
  type KeychainEntry,
  KeychainSecretStore,
} from "../src/settings/adapters/keychain-secret-store.ts";
import { UnavailableSecretStore } from "../src/settings/adapters/unavailable-secret-store.ts";
import { type SecretStore, SecretStoreUnavailableError } from "../src/settings/secret-store.ts";

/** A fresh secret-shaped value per test, built at runtime so no literal looks like a secret. */
function randomSecret(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Stands in for `@napi-rs/keyring`'s `AsyncEntry`: a missing credential rejects with the error
 * keyring-rs reports for it, as the real binding does, so no test touches the real Keychain.
 */
class FakeKeychain {
  readonly items = new Map<string, string>();

  entry = (service: string, account: string): KeychainEntry => {
    const key = `${service}/${account}`;
    const missing = () => new Error("No matching entry found in secure storage");
    return {
      getPassword: async () => {
        const value = this.items.get(key);
        if (value === undefined) throw missing();
        return value;
      },
      setPassword: async (password) => {
        this.items.set(key, password);
      },
      deleteCredential: async () => {
        if (!this.items.delete(key)) throw missing();
        return true;
      },
    };
  };
}

interface Factory {
  readonly name: string;
  create(): SecretStore;
}

function describeSecretStoreContract(factory: Factory): void {
  describe(`secret store contract: ${factory.name}`, () => {
    it("keeps a secret by name and gives it back", async () => {
      const store = factory.create();
      const secret = randomSecret();

      expect(await store.get("ELEVENLABS_API_KEY")).toBeUndefined();
      await store.set("ELEVENLABS_API_KEY", secret);

      expect(await store.get("ELEVENLABS_API_KEY")).toBe(secret);
      expect(await store.get("TWILIO_AUTH_TOKEN")).toBeUndefined();
    });

    it("replaces a secret", async () => {
      const store = factory.create();
      const replacement = randomSecret();
      await store.set("TWILIO_AUTH_TOKEN", randomSecret());

      await store.set("TWILIO_AUTH_TOKEN", replacement);

      expect(await store.get("TWILIO_AUTH_TOKEN")).toBe(replacement);
    });

    it("removes a secret, saying whether there was one", async () => {
      const store = factory.create();
      await store.set("TWILIO_AUTH_TOKEN", randomSecret());

      expect(await store.remove("TWILIO_AUTH_TOKEN")).toBe(true);
      expect(await store.get("TWILIO_AUTH_TOKEN")).toBeUndefined();
      expect(await store.remove("TWILIO_AUTH_TOKEN")).toBe(false);
    });

    it("reports whether a secret is configured and its last four characters, never the value", async () => {
      const store = factory.create();
      const secret = randomSecret();

      expect(await store.status("ELEVENLABS_API_KEY")).toEqual({ configured: false });
      await store.set("ELEVENLABS_API_KEY", secret);

      const status = await store.status("ELEVENLABS_API_KEY");
      expect(status).toEqual({ configured: true, lastFour: secret.slice(-4) });
      expect(JSON.stringify(status)).not.toContain(secret.slice(0, -4));
    });

    it("does not reveal any part of a secret too short to mask", async () => {
      const store = factory.create();
      await store.set("ELEVENLABS_API_KEY", "short-sec");

      expect(await store.status("ELEVENLABS_API_KEY")).toEqual({ configured: true });
    });
  });
}

describeSecretStoreContract({ name: "in-memory", create: () => new InMemorySecretStore() });

describeSecretStoreContract({
  name: "Keychain adapter over a fake keychain",
  create: () => new KeychainSecretStore({ service: "booker", entry: new FakeKeychain().entry }),
});

describe("Keychain adapter", () => {
  it("files each setting under the service, with the setting name as the account", async () => {
    const keychain = new FakeKeychain();
    const store = new KeychainSecretStore({ service: "booker", entry: keychain.entry });
    const secret = randomSecret();

    await store.set("ELEVENLABS_WEBHOOK_SECRET", secret);

    expect([...keychain.items.keys()]).toEqual(["booker/ELEVENLABS_WEBHOOK_SECRET"]);
  });

  it("passes on a Keychain failure that is not a missing item, naming the setting only", async () => {
    const secret = randomSecret();
    const store = new KeychainSecretStore({
      service: "booker",
      entry: () => ({
        getPassword: async () => {
          throw new Error("User interaction is not allowed.");
        },
        setPassword: async () => {
          throw new Error("User interaction is not allowed.");
        },
        deleteCredential: async () => false,
      }),
    });

    await expect(store.get("ELEVENLABS_API_KEY")).rejects.toThrow(
      "The macOS Keychain could not read ELEVENLABS_API_KEY: User interaction is not allowed.",
    );
    const saving = store.set("ELEVENLABS_API_KEY", secret);
    await expect(saving).rejects.toThrow("could not save ELEVENLABS_API_KEY");
    await saving.catch((error: unknown) => {
      expect(String(error)).not.toContain(secret);
    });
  });
});

describe("secret store on a system without the macOS Keychain", () => {
  it("holds nothing and refuses to save, pointing at .env instead", async () => {
    const store = new UnavailableSecretStore();

    expect(await store.get("ELEVENLABS_API_KEY")).toBeUndefined();
    expect(await store.status("ELEVENLABS_API_KEY")).toEqual({ configured: false });
    expect(await store.remove("ELEVENLABS_API_KEY")).toBe(false);
    await expect(store.set("ELEVENLABS_API_KEY", randomSecret())).rejects.toBeInstanceOf(
      SecretStoreUnavailableError,
    );
    await expect(store.set("ELEVENLABS_API_KEY", randomSecret())).rejects.toThrow(".env");
  });
});

// Opt-in manual check against the real login Keychain (see docs/settings.md): run
// `BOOKER_KEYCHAIN_TEST=1 pnpm vitest run tests/secret-store.contract.test.ts` on a Mac. It uses
// a throwaway service name and removes what it saved. CI never sets the variable.
const realKeychain = process.platform === "darwin" && process.env["BOOKER_KEYCHAIN_TEST"] === "1";

describe.runIf(realKeychain)("real macOS Keychain (opt-in)", () => {
  it("saves, reads, reports, and removes a secret under a throwaway service", async () => {
    const { macosKeychain } = await import("../src/settings/adapters/macos-keychain.ts");
    const store = macosKeychain(`booker-test-${randomBytes(4).toString("hex")}`);
    const secret = randomSecret();

    try {
      expect(await store.get("ELEVENLABS_API_KEY")).toBeUndefined();
      await store.set("ELEVENLABS_API_KEY", secret);
      expect(await store.get("ELEVENLABS_API_KEY")).toBe(secret);
      expect(await store.status("ELEVENLABS_API_KEY")).toEqual({
        configured: true,
        lastFour: secret.slice(-4),
      });
    } finally {
      expect(await store.remove("ELEVENLABS_API_KEY")).toBe(true);
    }
    expect(await store.get("ELEVENLABS_API_KEY")).toBeUndefined();
    expect(await store.remove("ELEVENLABS_API_KEY")).toBe(false);
  });
});
