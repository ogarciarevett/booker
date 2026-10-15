import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeElevenLabs } from "../calls/adapters/elevenlabs/fake-elevenlabs.ts";
import { InMemoryCallStore } from "../calls/adapters/in-memory-call-store.ts";
import { startCall } from "../calls/call.ts";
import { InMemorySecretStore } from "../settings/adapters/in-memory-secret-store.ts";
import { InMemorySettingStore } from "../settings/adapters/in-memory-setting-store.ts";
import { createSettingsResolver } from "../settings/resolver.ts";
import { elevenLabsIdsPath, saveElevenLabsIds } from "./elevenlabs-ids.ts";
import { createFailureLookup, createVoicePortFactory } from "./voice.ts";

describe("createVoicePortFactory", () => {
  let repoRoot: string;
  let api: FakeElevenLabs;
  let calls: InMemoryCallStore;
  let env: Record<string, string>;
  let values: InMemorySettingStore;
  let secrets: InMemorySecretStore;

  function settings() {
    return createSettingsResolver({ env, values, secrets });
  }

  let webhookSecret: string | undefined;

  function factory() {
    const create = createVoicePortFactory({
      settings: settings(),
      webhookSecret: async () => webhookSecret,
      repoRoot,
      fetch: api.fetch,
    });
    return () => create(calls);
  }

  async function saveIds(): Promise<void> {
    await saveElevenLabsIds(elevenLabsIdsPath(repoRoot), {
      agentIds: { quote: "agent_q", commit: "agent_c" },
      phoneNumberId: "phnum_1",
    });
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "booker-voice-"));
    api = new FakeElevenLabs();
    calls = new InMemoryCallStore();
    env = {
      ELEVENLABS_API_KEY: randomBytes(16).toString("hex"),
      BOOKER_OWNER_NAME: "Example Owner 1",
    };
    values = new InMemorySettingStore();
    secrets = new InMemorySecretStore();
    webhookSecret = randomBytes(16).toString("hex");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it.each([
    ["ELEVENLABS_API_KEY", "ELEVENLABS_API_KEY"],
    ["BOOKER_OWNER_NAME", "BOOKER_OWNER_NAME"],
  ])("says calls need %s when it is unset", async (variable, named) => {
    delete env[variable];

    const result = await factory()();

    expect(result).toEqual({ ok: false, reason: expect.stringContaining(named) });
  });

  it("places no call while no post-call webhook secret is available to confirm how it ends", async () => {
    await saveIds();
    webhookSecret = undefined;

    expect(await factory()()).toEqual({
      ok: false,
      reason: expect.stringContaining("set ELEVENLABS_WEBHOOK_SECRET first"),
    });
  });

  it("says the Keychain could not be read instead of failing the request", async () => {
    await saveIds();
    env = {};
    const failing = new InMemorySecretStore();
    failing.get = async () => {
      throw new Error(
        "The macOS Keychain could not read ELEVENLABS_API_KEY: User interaction is not allowed.",
      );
    };
    secrets = failing;

    expect(await factory()()).toEqual({
      ok: false,
      reason: expect.stringContaining("User interaction is not allowed"),
    });
  });

  it("asks for agent sync, then for phone import, before calls can be placed", async () => {
    expect(await factory()()).toEqual({
      ok: false,
      reason: expect.stringContaining("pnpm booker agent sync"),
    });
    await saveElevenLabsIds(elevenLabsIdsPath(repoRoot), {
      agentIds: { quote: "agent_q", commit: "agent_c" },
    });
    expect(await factory()()).toEqual({
      ok: false,
      reason: expect.stringContaining("pnpm booker phone import"),
    });
  });

  it("places calls with the saved agent and number, and the owner's name, read at call time", async () => {
    const voice = factory();
    await saveElevenLabsIds(elevenLabsIdsPath(repoRoot), {
      agentIds: { quote: "agent_q", commit: "agent_c" },
      phoneNumberId: "phnum_1",
    });

    const result = await voice();
    if (!result.ok) throw new Error(result.reason);
    const call = startCall({
      id: "call-1",
      errandId: "errand-1",
      providerId: "provider-1",
      purpose: "quote",
      attempt: 1,
      tokenHash: "a".repeat(64),
      now: "2026-10-06T10:00:00.000Z",
    });
    await result.port.placeCall({
      call,
      phoneE164: "+15550100100",
      dynamicVariables: { call_id: "call-1", call_token: "token-1" },
    });

    expect(api.outboundCalls[0]?.body).toMatchObject({
      agent_id: "agent_q",
      agent_phone_number_id: "phnum_1",
      conversation_initiation_client_data: {
        dynamic_variables: {
          call_id: "call-1",
          call_token: "token-1",
          owner_name: "Example Owner 1",
        },
      },
    });
  });

  it("applies a key and an owner name saved while the server runs, at the next call", async () => {
    env = {};
    const voice = factory();
    await saveIds();

    expect(await voice()).toEqual({
      ok: false,
      reason: expect.stringContaining("ELEVENLABS_API_KEY"),
    });
    await secrets.set("ELEVENLABS_API_KEY", randomBytes(16).toString("hex"));
    await values.set("BOOKER_OWNER_NAME", "Example Owner 3");

    const result = await voice();
    if (!result.ok) throw new Error(result.reason);
    const call = startCall({
      id: "call-1",
      errandId: "errand-1",
      providerId: "provider-1",
      purpose: "quote",
      attempt: 1,
      tokenHash: "a".repeat(64),
      now: "2026-10-06T10:00:00.000Z",
    });
    await result.port.placeCall({
      call,
      phoneE164: "+15550100100",
      dynamicVariables: { call_id: "call-1", call_token: "token-1" },
    });
    expect(api.outboundCalls[0]?.body).toMatchObject({
      conversation_initiation_client_data: { dynamic_variables: { owner_name: "Example Owner 3" } },
    });
  });

  it("checks stale calls with the key in effect at each check, and reports none failed without one", async () => {
    env = {};
    const lookup = createFailureLookup({ settings: settings(), fetch: api.fetch });

    expect(await lookup("conv-unknown")).toBe(false);
    expect(api.requests).toHaveLength(0);
  });

  it("cannot hang up without the Twilio credentials, and says which", async () => {
    await saveElevenLabsIds(elevenLabsIdsPath(repoRoot), {
      agentIds: { quote: "agent_q", commit: "agent_c" },
      phoneNumberId: "phnum_1",
    });
    const call = startCall({
      id: "call-1",
      errandId: "errand-1",
      providerId: "provider-1",
      purpose: "quote",
      attempt: 1,
      tokenHash: "a".repeat(64),
      now: "2026-10-06T10:00:00.000Z",
    });
    await calls.create({ ...call, externalId: "conv-1" });
    await calls.setCallSid("call-1", `CA${"0".repeat(32)}`);

    const result = await factory()();
    if (!result.ok) throw new Error(result.reason);

    await expect(result.port.cancelCall("conv-1")).rejects.toThrow(/TWILIO_ACCOUNT_SID/);
  });
});
