import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { RUNTIME_MATRIX } from "../../../reasoning/model-matrix.ts";
import type { CallPurpose } from "../../call.ts";
import { AGENT_SCRIPT_PATH, type AgentScript } from "./agent-script.ts";
import type { ElevenLabsClient } from "./client.ts";
import { BOOKER_TOOLS_SECRET_NAME, bookerTools, toolNamesFor } from "./tools.ts";

export const POST_CALL_WEBHOOK_PATH = "/webhooks/elevenlabs/post-call";
export const AGENT_TAG = "booker";
export const AGENT_NAMES: Readonly<Record<CallPurpose, string>> = {
  quote: "booker-quote",
  commit: "booker-commit",
};

export const ROLEPLAY_SCRIPT_PATH = "locales/en-US/roleplay-gpu.yaml";
export const DEMO_SCRIPT_PATH = "locales/en-US/demo.yaml";
const TEST_SCRIPT_NAMES = new Map([
  [ROLEPLAY_SCRIPT_PATH, "roleplay"],
  [DEMO_SCRIPT_PATH, "demo"],
]);

/** Default names stay unchanged; each custom script path gets its own stable pair. */
export function agentNamesFor(
  scriptPath: string = AGENT_SCRIPT_PATH,
): Readonly<Record<CallPurpose, string>> {
  const path = posix.normalize(scriptPath);
  if (path === AGENT_SCRIPT_PATH) return AGENT_NAMES;
  const suffix =
    TEST_SCRIPT_NAMES.get(path) ?? `script-${createHash("sha256").update(path).digest("hex")}`;
  return { quote: `${AGENT_NAMES.quote}-${suffix}`, commit: `${AGENT_NAMES.commit}-${suffix}` };
}

const WEBHOOK_NAME = "Booker post-call";
const TIME_ZONE = "Europe/Madrid";
const TTS_MODEL = "eleven_v4_turbo";
const MAX_CALL_SECONDS = 600;
const SILENCE_END_CALL_SECONDS = 30;
const PAGE_SIZE = 100;

/** Everything a sync created or found, by ElevenLabs id; written to `.local/elevenlabs.json`. */
export interface SyncedIds {
  readonly toolsKeySecretId: string;
  readonly toolIds: Readonly<Record<string, string>>;
  readonly postCallWebhookId: string;
  readonly agentIds: Readonly<Record<CallPurpose, string>>;
  readonly llm: string;
}

export interface AgentSyncResult {
  readonly ids: SyncedIds;
  /** One line per resource: what the sync did with it. Never a secret. */
  readonly actions: readonly string[];
  /** Whether this run had to create the post-call webhook (its secret went to `persistWebhookSecret`). */
  readonly createdWebhook: boolean;
}

export interface AgentSyncInput {
  readonly client: ElevenLabsClient;
  /** The public HTTPS base URL (the Tailscale Funnel) the tools and the webhook point at. */
  readonly publicBaseUrl: string;
  /** The owner's consented voice clone. */
  readonly voiceId: string;
  /** The voice-tools key, pushed to the `booker_tools_key` workspace secret. */
  readonly toolsKey: string;
  readonly script: AgentScript;
  /** Repository-relative script identity; custom paths never replace the default agents. */
  readonly scriptPath?: string;
  /**
   * Stores the signing secret of a webhook this run creates. ElevenLabs returns it only once, so
   * it is called as soon as the webhook exists, before any later step can fail and lose it.
   */
  readonly persistWebhookSecret: (secret: string) => Promise<void>;
}

const secretSchema = z.object({ secret_id: z.string(), name: z.string() });
const secretsPageSchema = z.object({
  secrets: z.array(secretSchema),
  next_cursor: z.string().nullish(),
});
const toolsPageSchema = z.object({
  tools: z.array(z.object({ id: z.string(), tool_config: z.object({ name: z.string() }) })),
  has_more: z.boolean(),
  next_cursor: z.string().nullish(),
});
const toolSchema = z.object({ id: z.string() });
const webhooksSchema = z.object({
  webhooks: z.array(
    z.object({ webhook_id: z.string(), name: z.string(), webhook_url: z.string() }),
  ),
});
const createdWebhookSchema = z.object({
  webhook_id: z.string(),
  webhook_secret: z.string().nullish(),
});
const agentsPageSchema = z.object({
  agents: z.array(z.object({ agent_id: z.string(), name: z.string() })),
  has_more: z.boolean(),
  next_cursor: z.string().nullish(),
});
const createdAgentSchema = z.object({ agent_id: z.string() });
const llmListSchema = z.object({ llms: z.array(z.object({ llm: z.string() })) });
const anything = z.unknown();

/** The in-call model: the model matrix's `inCall` default, as ElevenLabs names it. */
export function inCallModel(): string {
  const role = RUNTIME_MATRIX.inCall;
  const candidate = role.candidates.find((option) => option.id === role.default);
  if (candidate === undefined) throw new Error("the model matrix has no inCall default");
  return candidate.model;
}

function httpsBaseUrl(publicBaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    throw new RangeError("PUBLIC_BASE_URL must be an https URL");
  }
  if (url.protocol !== "https:") throw new RangeError("PUBLIC_BASE_URL must be an https URL");
  return publicBaseUrl.replace(/\/+$/, "");
}

/**
 * Creates or updates everything Booker's calls need in the ElevenLabs workspace, matching each
 * resource by its exact name (or, for the webhook, its URL), so running it again only updates:
 * the `booker_tools_key` secret, every voice tool, the post-call webhook (reusing one that
 * already points at this URL, with retries on), and the `booker-quote` and `booker-commit`
 * agents by default (custom scripts use separate names). The in-call model is checked against
 * ElevenLabs' list before anything changes.
 */
export async function syncAgents(input: AgentSyncInput): Promise<AgentSyncResult> {
  const baseUrl = httpsBaseUrl(input.publicBaseUrl);
  const { client } = input;
  const actions: string[] = [];
  const names = agentNamesFor(input.scriptPath);
  const testOnly = TEST_SCRIPT_NAMES.has(posix.normalize(input.scriptPath ?? AGENT_SCRIPT_PATH));

  const llm = inCallModel();
  const offered = await client.request("GET", "/v1/convai/llm/list", llmListSchema);
  if (!offered.llms.some((option) => option.llm === llm)) {
    throw new Error(
      `ElevenLabs does not offer the in-call model ${llm} (the model matrix's inCall default); nothing was changed`,
    );
  }

  const toolsKeySecretId = await upsertSecret(client, input.toolsKey, actions);

  const existingTools = await listTools(client);
  const toolIds: Record<string, string> = {};
  for (const tool of bookerTools({ publicBaseUrl: baseUrl, toolsKeySecretId })) {
    const existingId = existingTools.get(tool.name);
    if (existingId === undefined) {
      const created = await client.request("POST", "/v1/convai/tools", toolSchema, {
        body: { tool_config: tool.toolConfig },
      });
      toolIds[tool.name] = created.id;
      actions.push(`created tool ${tool.name}`);
    } else {
      await client.request(
        "PATCH",
        `/v1/convai/tools/${encodeURIComponent(existingId)}`,
        anything,
        {
          body: { tool_config: tool.toolConfig },
        },
      );
      toolIds[tool.name] = existingId;
      actions.push(`updated tool ${tool.name}`);
    }
  }

  const webhook = await upsertWebhook(
    client,
    `${baseUrl}${POST_CALL_WEBHOOK_PATH}`,
    actions,
    input.persistWebhookSecret,
  );

  const existingAgents = await listAgents(client);
  const agentIds: Record<string, string> = {};
  for (const purpose of ["quote", "commit"] as const) {
    const name = names[purpose];
    const body = agentBody({
      name,
      purpose,
      script: input.script,
      voiceId: input.voiceId,
      llm,
      toolIds: testOnly ? [] : toolNamesFor(purpose).map((toolName) => toolIds[toolName] ?? ""),
      maxCallSeconds: testOnly ? 180 : MAX_CALL_SECONDS,
      postCallWebhookId: webhook.webhookId,
    });
    const existingId = existingAgents.get(name);
    if (existingId === undefined) {
      const created = await client.request("POST", "/v1/convai/agents/create", createdAgentSchema, {
        body,
      });
      agentIds[purpose] = created.agent_id;
      actions.push(`created agent ${name}`);
    } else {
      await client.request(
        "PATCH",
        `/v1/convai/agents/${encodeURIComponent(existingId)}`,
        anything,
        {
          body,
        },
      );
      agentIds[purpose] = existingId;
      actions.push(`updated agent ${name}`);
    }
  }

  return {
    ids: {
      toolsKeySecretId,
      toolIds,
      postCallWebhookId: webhook.webhookId,
      agentIds: { quote: agentIds["quote"] ?? "", commit: agentIds["commit"] ?? "" },
      llm,
    },
    actions,
    createdWebhook: webhook.created,
  };
}

async function upsertSecret(
  client: ElevenLabsClient,
  value: string,
  actions: string[],
): Promise<string> {
  let existing: string | undefined;
  let cursor: string | undefined;
  do {
    const page = await client.request("GET", "/v1/convai/secrets", secretsPageSchema, {
      query: { search: BOOKER_TOOLS_SECRET_NAME, page_size: String(PAGE_SIZE), cursor },
    });
    existing = page.secrets.find((secret) => secret.name === BOOKER_TOOLS_SECRET_NAME)?.secret_id;
    cursor = page.next_cursor ?? undefined;
  } while (existing === undefined && cursor !== undefined);

  if (existing !== undefined) {
    await client.request("PATCH", `/v1/convai/secrets/${encodeURIComponent(existing)}`, anything, {
      body: { type: "update", name: BOOKER_TOOLS_SECRET_NAME, value },
    });
    actions.push(`updated secret ${BOOKER_TOOLS_SECRET_NAME}`);
    return existing;
  }
  const created = await client.request("POST", "/v1/convai/secrets", secretSchema, {
    body: { type: "new", name: BOOKER_TOOLS_SECRET_NAME, value },
  });
  actions.push(`created secret ${BOOKER_TOOLS_SECRET_NAME}`);
  return created.secret_id;
}

/** Every webhook tool by name; with duplicate names, the first one listed wins. */
async function listTools(client: ElevenLabsClient): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await client.request("GET", "/v1/convai/tools", toolsPageSchema, {
      query: { types: ["webhook"], page_size: String(PAGE_SIZE), cursor },
    });
    for (const tool of page.tools) {
      if (!byName.has(tool.tool_config.name)) byName.set(tool.tool_config.name, tool.id);
    }
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return byName;
}

/** Booker's agents by exact name (the search is fuzzy, so the name is matched here). */
async function listAgents(client: ElevenLabsClient): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const page = await client.request("GET", "/v1/convai/agents", agentsPageSchema, {
      query: { search: "booker", tags: [AGENT_TAG], page_size: String(PAGE_SIZE), cursor },
    });
    for (const agent of page.agents) {
      if (!byName.has(agent.name)) byName.set(agent.name, agent.agent_id);
    }
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor !== undefined);
  return byName;
}

/**
 * Reuses the workspace webhook that already points at `url` (the owner may have made it in the
 * dashboard, and its signing secret is then already in `ELEVENLABS_WEBHOOK_SECRET`), or creates
 * one. Either way it is enabled with retries on, so ElevenLabs retries a transcription that
 * arrives before Booker stored the conversation id.
 */
async function upsertWebhook(
  client: ElevenLabsClient,
  url: string,
  actions: string[],
  persistSecret: (secret: string) => Promise<void>,
): Promise<{ webhookId: string; created: boolean }> {
  const { webhooks } = await client.request("GET", "/v1/workspace/webhooks", webhooksSchema);
  const existing = webhooks.find((webhook) => webhook.webhook_url.replace(/\/+$/, "") === url);

  let webhookId: string;
  let name: string;
  const created = existing === undefined;
  if (existing === undefined) {
    const response = await client.request("POST", "/v1/workspace/webhooks", createdWebhookSchema, {
      body: { settings: { auth_type: "hmac", name: WEBHOOK_NAME, webhook_url: url } },
    });
    if (typeof response.webhook_secret !== "string" || response.webhook_secret.length === 0) {
      throw new Error("ElevenLabs created the webhook but returned no signing secret");
    }
    // Before anything else can fail: the next run reuses this webhook and never sees the secret.
    await persistSecret(response.webhook_secret);
    webhookId = response.webhook_id;
    name = WEBHOOK_NAME;
    actions.push("created the post-call webhook");
  } else {
    webhookId = existing.webhook_id;
    name = existing.name;
    actions.push("reused the post-call webhook");
  }

  await client.request(
    "PATCH",
    `/v1/workspace/webhooks/${encodeURIComponent(webhookId)}`,
    anything,
    {
      body: { name, is_disabled: false, retry_enabled: true },
    },
  );
  return { webhookId, created };
}

interface AgentBodyInput {
  readonly name: string;
  readonly purpose: CallPurpose;
  readonly script: AgentScript;
  readonly voiceId: string;
  readonly llm: string;
  readonly toolIds: readonly string[];
  readonly postCallWebhookId: string;
  readonly maxCallSeconds: number;
}

/**
 * One agent's whole configuration: the script's language, first message and purpose's prompt,
 * deterministic sampling, one tool call at a time, the purpose's tools plus `end_call`, the owner's
 * voice, patient turn-taking, the selected duration cap, no recorded audio, one call at a time, and the
 * post-call webhook for transcripts and initiation failures.
 */
function agentBody(input: AgentBodyInput): Record<string, unknown> {
  return {
    name: input.name,
    tags: [AGENT_TAG],
    conversation_config: {
      agent: {
        language: input.script.language,
        first_message: input.script.firstMessage,
        prompt: {
          prompt: input.script.prompts[input.purpose],
          llm: input.llm,
          temperature: 0,
          enable_parallel_tool_calls: false,
          tool_ids: input.toolIds,
          timezone: TIME_ZONE,
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
      // Expressive mode lets eleven_v4_turbo follow the prompt's sparing audio tags ([laughs]).
      tts: { model_id: TTS_MODEL, voice_id: input.voiceId, expressive_mode: true },
      turn: { turn_eagerness: "patient", silence_end_call_timeout: SILENCE_END_CALL_SECONDS },
      conversation: { max_duration_seconds: input.maxCallSeconds },
    },
    platform_settings: {
      privacy: { record_voice: false },
      call_limits: { agent_concurrency_limit: 1, bursting_enabled: false },
      workspace_overrides: {
        webhooks: {
          post_call_webhook_id: input.postCallWebhookId,
          events: ["transcript", "call_initiation_failure"],
        },
      },
    },
  };
}
