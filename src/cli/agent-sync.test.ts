import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_SCRIPT_PATH } from "../calls/adapters/elevenlabs/agent-script.ts";
import { FakeElevenLabs } from "../calls/adapters/elevenlabs/fake-elevenlabs.ts";
import { saveSettingsFixture } from "../persistence/settings-fixture.ts";
import { elevenLabsIdsPath } from "../server/elevenlabs-ids.ts";
import { ensureVoiceToolsKey, voiceToolsKeyPath } from "../server/voice-tools-key.ts";
import { webhookSecretPath } from "../server/webhook-secret.ts";
import { InMemorySecretStore } from "../settings/adapters/in-memory-secret-store.ts";
import { agentSyncCommand } from "./agent-sync.ts";
import type { CliContext } from "./context.ts";

const PUBLIC_BASE_URL = "https://public.booker.example";

interface TestContext extends CliContext {
  readonly out: string[];
  readonly err: string[];
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("booker agent sync", () => {
  let repoRoot: string;
  let api: FakeElevenLabs;
  let apiKey: string;

  function context(
    env: Record<string, string>,
    secrets: InMemorySecretStore = new InMemorySecretStore(),
  ): TestContext {
    const out: string[] = [];
    const err: string[] = [];
    return {
      repoRoot,
      env,
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

  function validEnv(): Record<string, string> {
    return {
      ELEVENLABS_API_KEY: apiKey,
      ELEVENLABS_VOICE_ID: "voice-owner-clone",
      PUBLIC_BASE_URL,
    };
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "booker-agent-sync-"));
    const script = join(repoRoot, AGENT_SCRIPT_PATH);
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(join(process.cwd(), AGENT_SCRIPT_PATH), script);
    api = new FakeElevenLabs();
    apiKey = randomBytes(16).toString("hex");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("uses the voice and public URL saved in the dashboard and the API key in the Keychain", async () => {
    await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
    await saveSettingsFixture(repoRoot, {
      ELEVENLABS_VOICE_ID: "voice-saved-clone",
      PUBLIC_BASE_URL,
    });
    const secrets = new InMemorySecretStore();
    await secrets.set("ELEVENLABS_API_KEY", apiKey);
    const ctx = context({}, secrets);

    expect(await agentSyncCommand.run([], ctx)).toBe(0);
    expect(ctx.out.join("\n")).toContain("voice voice-saved-clone");
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain(apiKey);
  });

  it.each(["", "   "])(
    "defaults to the Spanish script when BOOKER_AGENT_SCRIPT is blank (%j)",
    async (value) => {
      await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
      expect(
        await agentSyncCommand.run([], context({ ...validEnv(), BOOKER_AGENT_SCRIPT: value })),
      ).toBe(0);
      expect(api.agentByName("booker-quote")).toMatchObject({
        conversation_config: { agent: { language: "es" } },
      });
    },
  );

  it.each([
    ["roleplay-gpu", "roleplay"],
    ["demo", "demo"],
  ])(
    "loads the bundled %s from the environment and reports its separate active agents",
    async (file, suffix) => {
      await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
      const path = `locales/en-US/${file}.yaml`;
      mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
      copyFileSync(join(process.cwd(), path), join(repoRoot, path));
      const ctx = context({ ...validEnv(), BOOKER_AGENT_SCRIPT: path });

      expect(await agentSyncCommand.run([], ctx)).toBe(0);
      expect(ctx.out.join("\n")).toContain(`agents: booker-quote-${suffix}`);
      expect(api.agentByName(`booker-quote-${suffix}`)).toMatchObject({
        conversation_config: { agent: { language: "en" } },
      });
      expect(api.agentByName("booker-quote")).toBeUndefined();
    },
  );

  it("syncs a saved custom script to separate agents and can restore the Spanish pair", async () => {
    await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
    expect(await agentSyncCommand.run([], context(validEnv()))).toBe(0);
    const idsPath = elevenLabsIdsPath(repoRoot);
    const spanishIds = JSON.parse(readFileSync(idsPath, "utf8")).agentIds;
    const spanishQuote = structuredClone(api.agentByName("booker-quote"));
    const spanishCommit = structuredClone(api.agentByName("booker-commit"));
    const customPath = "locales/custom-test.yaml";
    writeFileSync(
      join(repoRoot, customPath),
      "language: en\nfirst_message: Hello from a fictional test\nprompt:\n  shared: Friendly test\n  quote: Ask about capacity\n  commit: Do not commit\n",
    );
    await saveSettingsFixture(repoRoot, { BOOKER_AGENT_SCRIPT: customPath });

    expect(await agentSyncCommand.run([], context(validEnv()))).toBe(0);
    const customIds = JSON.parse(readFileSync(idsPath, "utf8")).agentIds;
    expect(customIds.quote).not.toBe(spanishIds.quote);
    expect(customIds.commit).not.toBe(spanishIds.commit);
    expect(api.agentByName("booker-quote")).toEqual(spanishQuote);
    expect(api.agentByName("booker-commit")).toEqual(spanishCommit);
    expect([...api.agents.values()].map((agent) => agent.config)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversation_config: expect.objectContaining({
            agent: expect.objectContaining({
              language: "en",
              first_message: "Hello from a fictional test",
            }),
          }),
        }),
      ]),
    );
    expect(await agentSyncCommand.run([], context(validEnv()))).toBe(0);
    expect(JSON.parse(readFileSync(idsPath, "utf8")).agentIds).toEqual(customIds);
    expect(api.agents.size).toBe(4);

    expect(
      await agentSyncCommand.run(
        [],
        context({ ...validEnv(), BOOKER_AGENT_SCRIPT: AGENT_SCRIPT_PATH }),
      ),
    ).toBe(0);
    expect(JSON.parse(readFileSync(idsPath, "utf8")).agentIds).toEqual(spanishIds);
  });

  it.each([
    ["missing.yaml", undefined],
    ["invalid.yaml", "language: en\n"],
    ["broken.yaml", "language: [\nprivate-content"],
    ["../outside.yaml", undefined],
  ])(
    "refuses BOOKER_AGENT_SCRIPT=%s before any remote request without printing its value or content",
    async (path, content) => {
      await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
      if (content !== undefined) writeFileSync(join(repoRoot, path), content);
      const ctx = context({ ...validEnv(), BOOKER_AGENT_SCRIPT: path });

      expect(await agentSyncCommand.run([], ctx)).toBe(1);
      expect(ctx.err.join("\n")).toContain("BOOKER_AGENT_SCRIPT");
      expect(ctx.err.join("\n")).not.toContain(path);
      expect(ctx.err.join("\n")).not.toContain("private-content");
      expect(ctx.err.join("\n")).not.toContain(apiKey);
      expect(api.requests).toEqual([]);
      expect(existsSync(elevenLabsIdsPath(repoRoot))).toBe(false);
    },
  );

  it("says why it cannot read the settings instead of crashing", async () => {
    const locked = new InMemorySecretStore();
    locked.get = async (name) => {
      throw new Error(
        `The macOS Keychain could not read ${name}: User interaction is not allowed.`,
      );
    };
    const ctx = context({}, locked);

    expect(await agentSyncCommand.run([], ctx)).toBe(1);
    expect(ctx.err).toEqual([
      "Cannot sync: The macOS Keychain could not read ELEVENLABS_API_KEY: User interaction is not allowed.",
    ]);
  });

  it("syncs, saves every id in a private file, and keeps a created webhook's secret private", async () => {
    const { key } = await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
    const ctx = context(validEnv());

    expect(await agentSyncCommand.run([], ctx)).toBe(0);

    const idsPath = elevenLabsIdsPath(repoRoot);
    const ids = JSON.parse(readFileSync(idsPath, "utf8"));
    expect(modeOf(idsPath)).toBe(0o600);
    expect(ids).toMatchObject({
      toolsKeySecretId: expect.any(String),
      postCallWebhookId: expect.any(String),
      agentIds: { quote: expect.any(String), commit: expect.any(String) },
      llm: "gpt-6-sol",
    });
    const secretPath = webhookSecretPath(repoRoot);
    expect(readFileSync(secretPath, "utf8")).toBe(api.lastWebhookSecret);
    expect(modeOf(secretPath)).toBe(0o600);

    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain("booker-quote");
    expect(printed).toContain(".local/elevenlabs.json");
    expect(printed).toContain("restart");
    for (const secret of [key, apiKey, api.lastWebhookSecret ?? "missing"]) {
      expect(printed).not.toContain(secret);
    }
  });

  it("saves a created webhook's secret even when a later step fails, and says where it is", async () => {
    await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
    const ctx: TestContext = {
      ...context(validEnv()),
      // Creating the agents fails after the webhook (and its one-time secret) already exists.
      fetch: (input, init) => {
        const url = new URL(input);
        if (init?.method === "POST" && url.pathname === "/v1/convai/agents/create") {
          return Promise.resolve(new Response('{"detail":"unavailable"}', { status: 503 }));
        }
        return api.fetch(input, init);
      },
    };

    expect(await agentSyncCommand.run([], ctx)).toBe(1);

    const secretPath = webhookSecretPath(repoRoot);
    expect(readFileSync(secretPath, "utf8")).toBe(api.lastWebhookSecret);
    expect(modeOf(secretPath)).toBe(0o600);
    const printed = [...ctx.out, ...ctx.err].join("\n");
    expect(printed).toContain(".local/secrets/elevenlabs-webhook-secret");
    expect(printed).not.toContain(api.lastWebhookSecret ?? "missing");
  });

  it("keeps ids it does not own, such as the imported phone number, on a second run", async () => {
    await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
    api.addWebhook("Booker", `${PUBLIC_BASE_URL}/webhooks/elevenlabs/post-call`);
    expect(await agentSyncCommand.run([], context(validEnv()))).toBe(0);
    const idsPath = elevenLabsIdsPath(repoRoot);
    const withPhone = { ...JSON.parse(readFileSync(idsPath, "utf8")), phoneNumberId: "phnum_1" };
    writeFileSync(idsPath, JSON.stringify(withPhone), { mode: 0o600 });

    expect(await agentSyncCommand.run([], context(validEnv()))).toBe(0);

    expect(JSON.parse(readFileSync(idsPath, "utf8"))).toEqual(withPhone);
    expect(existsSync(webhookSecretPath(repoRoot))).toBe(false);
  });

  it("names every missing or invalid variable, without its value, and calls nothing", async () => {
    const ctx = context({ PUBLIC_BASE_URL: "http://public.booker.example" });

    expect(await agentSyncCommand.run([], ctx)).toBe(1);

    const printed = ctx.err.join("\n");
    expect(printed).toContain("ELEVENLABS_API_KEY");
    expect(printed).toContain("ELEVENLABS_VOICE_ID");
    expect(printed).toContain("PUBLIC_BASE_URL must be an https URL");
    expect(printed).not.toContain("http://public.booker.example");
    expect(api.requests).toEqual([]);
  });

  it("asks for the server to run once when there is no voice-tools key yet", async () => {
    const ctx = context(validEnv());

    expect(await agentSyncCommand.run([], ctx)).toBe(1);

    expect(ctx.err.join("\n")).toContain("pnpm booker serve");
    expect(api.requests).toEqual([]);
  });

  it("reports an ElevenLabs failure without the API key", async () => {
    await ensureVoiceToolsKey(voiceToolsKeyPath(repoRoot));
    api.llms = [];
    const ctx = context(validEnv());

    expect(await agentSyncCommand.run([], ctx)).toBe(1);

    expect(ctx.err.join("\n")).toContain("gpt-6-sol");
    expect([...ctx.out, ...ctx.err].join("\n")).not.toContain(apiKey);
    expect(existsSync(elevenLabsIdsPath(repoRoot))).toBe(false);
  });
});
