import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/settings/adapters/in-memory-secret-store.ts";
import { InMemorySettingStore } from "../src/settings/adapters/in-memory-setting-store.ts";
import { createSettingsResolver } from "../src/settings/resolver.ts";

/** A fresh secret-shaped value per test, built at runtime so no literal looks like a secret. */
function randomSecret(): string {
  return randomBytes(16).toString("hex");
}

function setup(
  env: Record<string, string | undefined>,
  dotenvNames: ReadonlySet<string> | undefined = new Set(),
) {
  const values = new InMemorySettingStore();
  const secrets = new InMemorySecretStore();
  const settings = createSettingsResolver({ env, dotenvNames, values, secrets });
  return { values, secrets, settings };
}

describe("settings resolver", () => {
  it("labels a value Node loaded from .env as coming from the .env file", async () => {
    const { settings } = setup(
      { BOOKER_OWNER_NAME: "Example Owner 1" },
      new Set(["BOOKER_OWNER_NAME"]),
    );

    expect(await settings.resolve("BOOKER_OWNER_NAME")).toEqual({
      value: "Example Owner 1",
      source: "dotenv",
    });
  });

  it("labels a value .env does not define as coming from the environment", async () => {
    const { settings } = setup({ BOOKER_OWNER_NAME: "Example Owner 1" }, new Set(["BOOKER_PORT"]));

    expect(await settings.resolve("BOOKER_OWNER_NAME")).toEqual({
      value: "Example Owner 1",
      source: "environment",
    });
  });

  it("labels every environment value as environment when .env could not be read", async () => {
    const { settings } = setup({ BOOKER_OWNER_NAME: "Example Owner 1" }, undefined);

    expect((await settings.resolve("BOOKER_OWNER_NAME")).source).toBe("environment");
  });

  it("lets the environment win over a saved value", async () => {
    const fromShell = randomSecret();
    const { settings, values, secrets } = setup({
      BOOKER_OWNER_NAME: "Example Owner 1",
      ELEVENLABS_API_KEY: fromShell,
    });
    await values.set("BOOKER_OWNER_NAME", "Example Owner 3");
    await secrets.set("ELEVENLABS_API_KEY", randomSecret());

    expect(await settings.value("BOOKER_OWNER_NAME")).toBe("Example Owner 1");
    expect(await settings.value("ELEVENLABS_API_KEY")).toBe(fromShell);
  });

  it("reads non-secrets from the setting store and secrets from the secret store", async () => {
    const { settings, values, secrets } = setup({});
    const fromKeychain = randomSecret();
    await values.set("BOOKER_OWNER_NAME", "Example Owner 3");
    await secrets.set("ELEVENLABS_API_KEY", fromKeychain);
    // A secret is never looked up in the plain store, nor a plain value in the secret store.
    await values.set("TWILIO_AUTH_TOKEN", randomSecret());
    await secrets.set("TWILIO_ACCOUNT_SID", randomSecret());

    expect(await settings.resolve("BOOKER_OWNER_NAME")).toEqual({
      value: "Example Owner 3",
      source: "store",
    });
    expect(await settings.resolve("ELEVENLABS_API_KEY")).toEqual({
      value: fromKeychain,
      source: "store",
    });
    expect(await settings.resolve("TWILIO_AUTH_TOKEN")).toEqual({
      value: undefined,
      source: "unset",
    });
    expect(await settings.resolve("TWILIO_ACCOUNT_SID")).toEqual({
      value: undefined,
      source: "unset",
    });
  });

  it("treats an empty or blank environment value as unset, so a saved value applies", async () => {
    const { settings, values } = setup({ BOOKER_OWNER_NAME: "  ", BOOKER_PORT: "" });
    await values.set("BOOKER_OWNER_NAME", "Example Owner 3");

    expect(await settings.resolve("BOOKER_OWNER_NAME")).toEqual({
      value: "Example Owner 3",
      source: "store",
    });
    expect(await settings.resolve("BOOKER_PORT")).toEqual({ value: undefined, source: "unset" });
  });

  it("never reads an environment-only setting from a store", async () => {
    const { settings, values } = setup({});
    await values.set("BOOKER_DATA_DIR", "/elsewhere");

    expect(await settings.resolve("BOOKER_DATA_DIR")).toEqual({
      value: undefined,
      source: "unset",
    });
  });

  it("sees a saved change at the next lookup, without being rebuilt", async () => {
    const { settings, secrets } = setup({});

    const rotated = randomSecret();
    expect(await settings.value("ELEVENLABS_WEBHOOK_SECRET")).toBeUndefined();
    await secrets.set("ELEVENLABS_WEBHOOK_SECRET", rotated);
    expect(await settings.value("ELEVENLABS_WEBHOOK_SECRET")).toBe(rotated);
    await secrets.remove("ELEVENLABS_WEBHOOK_SECRET");
    expect(await settings.value("ELEVENLABS_WEBHOOK_SECRET")).toBeUndefined();
  });

  it("fills an environment for the existing parsers, keeping everything else as it was", async () => {
    const { settings, values } = setup({ PATH: "/usr/bin", BOOKER_PORT: "  " });
    await values.set("PUBLIC_BASE_URL", "https://public.booker.example");

    const env = await settings.environment(["PUBLIC_BASE_URL", "BOOKER_PORT"]);

    expect(env).toEqual({
      PATH: "/usr/bin",
      BOOKER_PORT: "  ",
      PUBLIC_BASE_URL: "https://public.booker.example",
    });
  });
});
