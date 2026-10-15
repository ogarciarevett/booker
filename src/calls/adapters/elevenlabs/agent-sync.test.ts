import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_SCRIPT_PATH, type AgentScript, loadAgentScript } from "./agent-script.ts";
import { type AgentSyncInput, syncAgents } from "./agent-sync.ts";
import { ElevenLabsClient } from "./client.ts";
import { FakeElevenLabs } from "./fake-elevenlabs.ts";
import { BOOKER_TOOLS_SECRET_NAME, toolNamesFor } from "./tools.ts";

const PUBLIC_BASE_URL = "https://public.booker.example";
const WEBHOOK_URL = `${PUBLIC_BASE_URL}/webhooks/elevenlabs/post-call`;

describe("syncAgents", () => {
  let api: FakeElevenLabs;
  let script: AgentScript;
  let toolsKey: string;
  let persistedSecrets: string[];

  function input(overrides: Partial<AgentSyncInput> = {}): AgentSyncInput {
    return {
      client: new ElevenLabsClient({
        apiKey: randomBytes(16).toString("hex"),
        baseUrl: "https://elevenlabs.test",
        fetch: api.fetch,
      }),
      publicBaseUrl: PUBLIC_BASE_URL,
      voiceId: "voice-owner-clone",
      toolsKey,
      script,
      persistWebhookSecret: async (secret) => {
        persistedSecrets.push(secret);
      },
      ...overrides,
    };
  }

  beforeEach(async () => {
    persistedSecrets = [];
    api = new FakeElevenLabs();
    script = await loadAgentScript(join(process.cwd(), AGENT_SCRIPT_PATH));
    toolsKey = randomBytes(32).toString("base64url");
  });

  it("creates the secret, every tool, the webhook, and both agents on a first run", async () => {
    const result = await syncAgents(input());

    const [secretId, secret] = [...api.secrets.entries()][0] ?? [];
    expect(secret).toEqual({ name: BOOKER_TOOLS_SECRET_NAME, value: toolsKey });
    expect(result.ids.toolsKeySecretId).toBe(secretId);
    expect(Object.keys(result.ids.toolIds).sort()).toEqual([...toolNamesFor("commit")].sort());
    expect(api.tools.size).toBe(toolNamesFor("commit").length);
    expect(api.webhooks).toEqual([
      expect.objectContaining({ webhookUrl: WEBHOOK_URL, isDisabled: false, retryEnabled: true }),
    ]);
    expect(result.ids.postCallWebhookId).toBe(api.webhooks[0]?.webhookId);
    expect(result.createdWebhook).toBe(true);
    expect(persistedSecrets).toEqual([api.lastWebhookSecret]);
    expect(result.ids.llm).toBe("gpt-6-sol");
    expect(Object.keys(result.ids.agentIds)).toEqual(["quote", "commit"]);
    expect(result.actions).toContain("created agent booker-quote");
  });

  it("configures each agent with its own tools, the voice, Spanish, privacy, limits, and the webhook", async () => {
    const result = await syncAgents(input());

    const quote = api.agentByName("booker-quote");
    const commit = api.agentByName("booker-commit");
    const quoteToolIds = toolNamesFor("quote").map((name) => result.ids.toolIds[name]);
    const commitToolIds = toolNamesFor("commit").map((name) => result.ids.toolIds[name]);
    expect(quote).toMatchObject({
      name: "booker-quote",
      tags: ["booker"],
      conversation_config: {
        agent: {
          language: "es",
          first_message: script.firstMessage,
          prompt: {
            prompt: script.prompts.quote,
            llm: "gpt-6-sol",
            temperature: 0,
            enable_parallel_tool_calls: false,
            tool_ids: quoteToolIds,
            timezone: "Europe/Madrid",
            built_in_tools: {
              end_call: {
                type: "system",
                name: "end_call",
                description: "",
                params: { system_tool_type: "end_call" },
              },
            },
          },
        },
        tts: { model_id: "eleven_v4_turbo", voice_id: "voice-owner-clone", expressive_mode: true },
        turn: { turn_eagerness: "patient", silence_end_call_timeout: 30 },
        conversation: { max_duration_seconds: 600 },
      },
      platform_settings: {
        privacy: { record_voice: false },
        call_limits: { agent_concurrency_limit: 1, bursting_enabled: false },
        workspace_overrides: {
          webhooks: {
            post_call_webhook_id: result.ids.postCallWebhookId,
            events: ["transcript", "call_initiation_failure"],
          },
        },
      },
    });
    expect(commit).toMatchObject({
      name: "booker-commit",
      conversation_config: {
        agent: { prompt: { prompt: script.prompts.commit, tool_ids: commitToolIds } },
      },
    });
  });

  it("reuses the webhook the owner already made for this URL, turning on its retries", async () => {
    const existing = api.addWebhook("Booker (dashboard)", WEBHOOK_URL);
    api.addWebhook("Another app", "https://elsewhere.example/hook");

    const result = await syncAgents(input());

    expect(result.ids.postCallWebhookId).toBe(existing.webhookId);
    expect(result.createdWebhook).toBe(false);
    expect(persistedSecrets).toEqual([]);
    expect(api.webhooks).toHaveLength(2);
    expect(existing).toMatchObject({ isDisabled: false, retryEnabled: true });
    expect(api.writes().filter((request) => request.path === "/v1/workspace/webhooks")).toEqual([]);
  });

  it("is idempotent: a second run only reads and patches what the first one created", async () => {
    const first = await syncAgents(input());
    const createdBefore = {
      secrets: api.secrets.size,
      tools: api.tools.size,
      webhooks: api.webhooks.length,
      agents: api.agents.size,
    };
    api.requests.length = 0;

    const second = await syncAgents(input());

    expect(second.ids).toEqual(first.ids);
    expect(second.createdWebhook).toBe(false);
    expect(persistedSecrets).toEqual([api.lastWebhookSecret]);
    expect({
      secrets: api.secrets.size,
      tools: api.tools.size,
      webhooks: api.webhooks.length,
      agents: api.agents.size,
    }).toEqual(createdBefore);
    expect(new Set(api.writes().map((request) => request.method))).toEqual(new Set(["PATCH"]));
    expect(second.actions.every((action) => !action.startsWith("created"))).toBe(true);
  });

  it.each([
    ["roleplay-gpu", "roleplay"],
    ["demo", "demo"],
  ])(
    "creates and updates a separate %s pair without changing either Spanish agent",
    async (file, suffix) => {
      const spanish = await syncAgents(input());
      const quoteBefore = structuredClone(api.agentByName("booker-quote"));
      const commitBefore = structuredClone(api.agentByName("booker-commit"));
      const roleplay = input({
        scriptPath: `locales/en-US/${file}.yaml`,
        script: { ...script, language: "en", firstMessage: "Hello from a fictional test" },
      });
      const first = await syncAgents(roleplay);
      const second = await syncAgents(roleplay);

      expect(first.ids.agentIds.quote).not.toBe(spanish.ids.agentIds.quote);
      expect(first.ids.agentIds.commit).not.toBe(spanish.ids.agentIds.commit);
      expect(second.ids.agentIds).toEqual(first.ids.agentIds);
      expect(api.agents.size).toBe(4);
      expect(api.agentByName("booker-quote")).toEqual(quoteBefore);
      expect(api.agentByName("booker-commit")).toEqual(commitBefore);
      for (const purpose of ["quote", "commit"]) {
        expect(api.agentByName(`booker-${purpose}-${suffix}`)).toMatchObject({
          conversation_config: {
            agent: {
              language: "en",
              prompt: { tool_ids: [], built_in_tools: { end_call: expect.any(Object) } },
            },
            conversation: { max_duration_seconds: 180 },
          },
        });
      }
    },
  );

  it("pushes a rotated tools key to the existing secret", async () => {
    await syncAgents(input());
    const rotated = randomBytes(32).toString("base64url");

    await syncAgents(input({ toolsKey: rotated }));

    expect([...api.secrets.values()]).toEqual([{ name: BOOKER_TOOLS_SECRET_NAME, value: rotated }]);
  });

  it("refuses to change anything when the in-call model is not offered", async () => {
    api.llms = ["gpt-6-astra"];

    await expect(syncAgents(input())).rejects.toThrow(/gpt-6-sol/);
    expect(api.writes()).toEqual([]);
  });

  it("refuses a public URL that is not https before calling ElevenLabs", async () => {
    await expect(
      syncAgents(input({ publicBaseUrl: "http://public.booker.example" })),
    ).rejects.toThrow(/https/);
    expect(api.requests).toEqual([]);
  });
});
