import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeElevenLabs } from "../calls/adapters/elevenlabs/fake-elevenlabs.ts";
import { saveSettingsFixture } from "../persistence/settings-fixture.ts";
import { elevenLabsIdsPath, saveElevenLabsIds } from "../server/elevenlabs-ids.ts";
import { InMemorySecretStore } from "../settings/adapters/in-memory-secret-store.ts";
import type { CliContext } from "./context.ts";
import { phoneImportCommand } from "./phone-import.ts";

const PHONE_NUMBER = "+15550100123";

interface TestContext extends CliContext {
  readonly out: string[];
  readonly err: string[];
}

describe("booker phone import", () => {
  let repoRoot: string;
  let api: FakeElevenLabs;
  let env: Record<string, string>;

  function context(
    overrides: Record<string, string> = env,
    secrets: InMemorySecretStore = new InMemorySecretStore(),
  ): TestContext {
    const out: string[] = [];
    const err: string[] = [];
    return {
      repoRoot,
      env: overrides,
      secrets,
      dotenvNames: new Set(),
      signals: new EventEmitter(),
      fetch: api.fetch,
      out,
      err,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    };
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "booker-phone-import-"));
    api = new FakeElevenLabs();
    env = {
      ELEVENLABS_API_KEY: randomBytes(16).toString("hex"),
      TWILIO_ACCOUNT_SID: `AC${randomBytes(16).toString("hex")}`,
      TWILIO_AUTH_TOKEN: randomBytes(16).toString("hex"),
      TWILIO_PHONE_NUMBER: PHONE_NUMBER,
    };
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("uses the number and SID saved in the dashboard and the credentials in the Keychain", async () => {
    const apiKey = env["ELEVENLABS_API_KEY"] ?? "";
    const authToken = env["TWILIO_AUTH_TOKEN"] ?? "";
    await saveSettingsFixture(repoRoot, {
      TWILIO_ACCOUNT_SID: env["TWILIO_ACCOUNT_SID"] ?? "",
      TWILIO_PHONE_NUMBER: PHONE_NUMBER,
    });
    const secrets = new InMemorySecretStore();
    await secrets.set("ELEVENLABS_API_KEY", apiKey);
    await secrets.set("TWILIO_AUTH_TOKEN", authToken);
    const ctx = context({}, secrets);

    expect(await phoneImportCommand.run([], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("Imported TWILIO_PHONE_NUMBER into ElevenLabs");
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).not.toContain(apiKey);
    expect(printed).not.toContain(authToken);
  });

  it("says why it cannot read the settings instead of crashing", async () => {
    const locked = new InMemorySecretStore();
    locked.get = async (name) => {
      throw new Error(
        `The macOS Keychain could not read ${name}: User interaction is not allowed.`,
      );
    };
    const ctx = context({}, locked);

    expect(await phoneImportCommand.run([], ctx)).toBe(1);
    expect(ctx.err.join("\n")).toMatch(
      /^Cannot import the number: The macOS Keychain could not read \w+: User interaction is not allowed\.$/,
    );
  });

  it("imports the Twilio number once, keeping the other saved ids, and never prints a credential", async () => {
    const idsPath = elevenLabsIdsPath(repoRoot);
    await saveElevenLabsIds(idsPath, { agentIds: { quote: "agent_q", commit: "agent_c" } });
    const ctx = context();

    expect(await phoneImportCommand.run([], ctx)).toBe(0);

    const [phoneNumberId, imported] = [...api.phoneNumbers.entries()][0] ?? [];
    expect(imported?.body).toEqual({
      provider: "twilio",
      label: "Booker",
      phone_number: PHONE_NUMBER,
      sid: env["TWILIO_ACCOUNT_SID"],
      token: env["TWILIO_AUTH_TOKEN"],
      enable_sms: false,
    });
    expect(JSON.parse(readFileSync(idsPath, "utf8"))).toEqual({
      agentIds: { quote: "agent_q", commit: "agent_c" },
      phoneNumberId,
    });
    expect(statSync(idsPath).mode & 0o777).toBe(0o600);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain(String(phoneNumberId));
    for (const name of ["ELEVENLABS_API_KEY", "TWILIO_AUTH_TOKEN"]) {
      expect(printed).not.toContain(env[name]);
    }
  });

  it("reuses a number ElevenLabs already has instead of importing it twice", async () => {
    expect(await phoneImportCommand.run([], context())).toBe(0);
    api.requests.length = 0;

    const ctx = context();
    expect(await phoneImportCommand.run([], ctx)).toBe(0);

    expect(api.writes()).toEqual([]);
    expect(api.phoneNumbers.size).toBe(1);
    expect(api.requests[0]?.query.get("phone_number")).toBe(PHONE_NUMBER);
    expect(api.requests[0]?.query.get("provider")).toBe("twilio");
    expect(ctx.out.join("\n")).toContain("already imported");
  });

  it("names every missing or invalid variable without its value, and calls nothing", async () => {
    const ctx = context({
      TWILIO_ACCOUNT_SID: "SK-not-an-account",
      TWILIO_PHONE_NUMBER: "555 0100",
    });

    expect(await phoneImportCommand.run([], ctx)).toBe(1);

    const printed = ctx.err.join("\n");
    for (const name of [
      "ELEVENLABS_API_KEY",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_PHONE_NUMBER",
    ]) {
      expect(printed).toContain(name);
    }
    expect(printed).not.toContain("SK-not-an-account");
    expect(printed).not.toContain("555 0100");
    expect(api.requests).toEqual([]);
  });
});
