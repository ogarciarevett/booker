import { join, relative } from "node:path";
import { z } from "zod";
import {
  AGENT_SCRIPT_PATH,
  type AgentScript,
  loadAgentScript,
} from "../calls/adapters/elevenlabs/agent-script.ts";
import { agentNamesFor, syncAgents } from "../calls/adapters/elevenlabs/agent-sync.ts";
import { ElevenLabsClient } from "../calls/adapters/elevenlabs/client.ts";
import { elevenLabsIdsPath, saveElevenLabsIds } from "../server/elevenlabs-ids.ts";
import { describeError } from "../server/logging.ts";
import {
  readVoiceToolsKey,
  VoiceToolsKeyError,
  voiceToolsKeyPath,
} from "../server/voice-tools-key.ts";
import { saveWebhookSecret, webhookSecretPath } from "../server/webhook-secret.ts";
import { isHttpsUrl, isRepoRelativePath, type SettingName } from "../settings/catalog.ts";
import type { CliContext } from "./context.ts";
import { parseEnvironment } from "./environment.ts";
import { type Command, USAGE_EXIT_CODE } from "./router.ts";
import { settingsFailure, settingsFor } from "./settings.ts";

const agentSyncEnvironmentSchema = z.object({
  ELEVENLABS_API_KEY: z.string(),
  ELEVENLABS_VOICE_ID: z.string(),
  PUBLIC_BASE_URL: z.string().refine(isHttpsUrl),
  BOOKER_AGENT_SCRIPT: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().refine(isRepoRelativePath).optional(),
  ),
});

const AGENT_SYNC_SETTINGS = Object.keys(agentSyncEnvironmentSchema.shape) as SettingName[];

const ISSUE_MESSAGES = {
  ELEVENLABS_API_KEY: "ELEVENLABS_API_KEY is required: an ElevenLabs API key",
  ELEVENLABS_VOICE_ID: "ELEVENLABS_VOICE_ID is required: the owner's consented voice clone",
  PUBLIC_BASE_URL:
    "PUBLIC_BASE_URL must be an https URL: the Tailscale Funnel address the agent calls back",
  BOOKER_AGENT_SCRIPT:
    "BOOKER_AGENT_SCRIPT must be a repository-relative file path without parent traversal",
} as const;

/**
 * `pnpm booker agent sync`: makes the ElevenLabs workspace match this repository (the tools-key
 * secret, the voice tools, the post-call webhook, and the two agents), saves their ids to
 * `.local/elevenlabs.json`, and prints what it did. Running it again only updates. No key, token,
 * or secret is ever printed.
 */
export const agentSyncCommand: Command<CliContext> = {
  name: "agent sync",
  summary: "Creates or updates the ElevenLabs agents, tools, secret, and webhook",
  async run(args, context) {
    if (args.length > 0) {
      context.stderr("agent sync takes no arguments: it reads Booker's settings.");
      return USAGE_EXIT_CODE;
    }
    let resolved: Record<string, string | undefined>;
    try {
      resolved = await settingsFor(context).environment(AGENT_SYNC_SETTINGS);
    } catch (error) {
      context.stderr(`Cannot sync: ${settingsFailure(error)}`);
      return 1;
    }
    const parsed = parseEnvironment(resolved, agentSyncEnvironmentSchema, ISSUE_MESSAGES);
    if (!parsed.ok) {
      context.stderr("Cannot sync: the configuration is incomplete or invalid.");
      for (const issue of parsed.issues) context.stderr(`  - ${issue}`);
      context.stderr("Set these in .env or the environment (see docs/live-calls.md).");
      return 1;
    }
    const env = parsed.value;
    const scriptPath = env.BOOKER_AGENT_SCRIPT ?? AGENT_SCRIPT_PATH;
    let script: AgentScript;
    try {
      script = await loadAgentScript(join(context.repoRoot, scriptPath));
    } catch {
      context.stderr(
        "Cannot sync: BOOKER_AGENT_SCRIPT must name an existing, readable YAML file with a valid agent script (language, first_message, prompt.shared, prompt.quote, prompt.commit).",
      );
      return 1;
    }

    let toolsKey: string;
    try {
      toolsKey = await readVoiceToolsKey(voiceToolsKeyPath(context.repoRoot));
    } catch (error) {
      const reason = error instanceof VoiceToolsKeyError ? error.message : describeError(error, []);
      context.stderr(`Cannot sync: ${reason}`);
      return 1;
    }
    const secrets = [env.ELEVENLABS_API_KEY, toolsKey];

    const shown = (path: string) => relative(context.repoRoot, path);
    const secretPath = webhookSecretPath(context.repoRoot);
    const secretHint =
      `The new post-call webhook's signing secret is in ${shown(secretPath)}. ` +
      "Unset ELEVENLABS_WEBHOOK_SECRET if it is set, then restart pnpm booker serve so it uses it.";
    let savedWebhookSecret = false;
    try {
      const result = await syncAgents({
        client: new ElevenLabsClient({
          apiKey: env.ELEVENLABS_API_KEY,
          ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
        }),
        publicBaseUrl: env.PUBLIC_BASE_URL,
        voiceId: env.ELEVENLABS_VOICE_ID,
        toolsKey,
        script,
        scriptPath,
        persistWebhookSecret: async (secret) => {
          await saveWebhookSecret(secretPath, secret);
          savedWebhookSecret = true;
        },
      });
      const idsPath = elevenLabsIdsPath(context.repoRoot);
      await saveElevenLabsIds(idsPath, result.ids);

      context.stdout(
        `ElevenLabs is in sync (in-call model ${result.ids.llm}, voice ${env.ELEVENLABS_VOICE_ID}).`,
      );
      for (const action of result.actions) context.stdout(`  ${action}`);
      const names = agentNamesFor(scriptPath);
      context.stdout(
        `  agents: ${names.quote} ${result.ids.agentIds.quote}, ${names.commit} ${result.ids.agentIds.commit}`,
      );
      context.stdout(`Ids saved to ${shown(idsPath)}.`);
      if (result.createdWebhook) context.stdout(secretHint);
      return 0;
    } catch (error) {
      context.stderr(`Cannot sync: ${describeError(error, secrets)}`);
      // The webhook outlives a failed run, and the next run reuses it without its secret.
      if (savedWebhookSecret) context.stderr(secretHint);
      return 1;
    }
  },
};
