import { ElevenLabsClient, type FetchFn } from "../calls/adapters/elevenlabs/client.ts";
import {
  conversationStatus,
  ElevenLabsVoiceCallPort,
} from "../calls/adapters/elevenlabs/voice-call.ts";
import { createTwilioHangUp } from "../calls/adapters/twilio/hang-up.ts";
import type { LiveCallStore } from "../calls/call-store.ts";
import type { VoicePortAvailability } from "../http/control.ts";
import type { SettingsResolver } from "../settings/resolver.ts";
import { elevenLabsIdsPath, readElevenLabsIds } from "./elevenlabs-ids.ts";

export interface VoicePortFactoryOptions {
  /** `ELEVENLABS_API_KEY`, `BOOKER_OWNER_NAME`, and, to hang up, the Twilio credentials. */
  readonly settings: Pick<SettingsResolver, "value">;
  /**
   * The post-call webhook's secret as the webhook resolves it. Without one, ElevenLabs cannot tell
   * Booker how a call ended, so no call is placed.
   */
  readonly webhookSecret: () => Promise<string | undefined>;
  readonly repoRoot: string;
  readonly fetch?: FetchFn;
}

/**
 * Builds the ElevenLabs voice port for each call request: the API key, the owner's name, and the
 * Twilio credentials are resolved then (the environment, else what the dashboard saved), and the
 * agent and phone-number ids read from `.local/elevenlabs.json`, so a setting saved, a sync, or
 * an import made while the server runs applies at the next call. When something is missing, it
 * says what to set or run instead of placing a call.
 */
export function createVoicePortFactory(
  options: VoicePortFactoryOptions,
): (calls: LiveCallStore) => Promise<VoicePortAvailability> {
  return async (calls) => {
    try {
      return await buildPort(options, calls);
    } catch (error) {
      // A settings store that cannot be read (a locked Keychain, a busy database) is a reason,
      // not a crash; its messages name the setting, never a value.
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `the settings could not be read: ${firstLine(message)}` };
    }
  };
}

function firstLine(text: string): string {
  return text.split(/\r\n|\r|\n/u, 1)[0] ?? "";
}

async function buildPort(
  options: VoicePortFactoryOptions,
  calls: LiveCallStore,
): Promise<VoicePortAvailability> {
  const { settings } = options;
  const apiKey = await settings.value("ELEVENLABS_API_KEY");
  if (apiKey === undefined) {
    return {
      ok: false,
      reason:
        "ELEVENLABS_API_KEY is not set: save it on the dashboard's Settings page, or add it to .env and restart serve",
    };
  }
  const ownerName = await settings.value("BOOKER_OWNER_NAME");
  if (ownerName === undefined) {
    return {
      ok: false,
      reason:
        "BOOKER_OWNER_NAME is not set: the agent says whom it calls for; save it on the dashboard's Settings page, or add it to .env and restart serve",
    };
  }
  if ((await options.webhookSecret()) === undefined) {
    return {
      ok: false,
      reason:
        "the post-call webhook has no secret, so Booker could not hear how the call ends: set ELEVENLABS_WEBHOOK_SECRET first (the dashboard's Settings page or .env)",
    };
  }
  const ids = await readElevenLabsIds(elevenLabsIdsPath(options.repoRoot));
  if (ids.agentIds === undefined) {
    return { ok: false, reason: "there are no agents yet: run pnpm booker agent sync" };
  }
  if (ids.phoneNumberId === undefined) {
    return { ok: false, reason: "there is no phone number yet: run pnpm booker phone import" };
  }

  const accountSid = await settings.value("TWILIO_ACCOUNT_SID");
  const authToken = await settings.value("TWILIO_AUTH_TOKEN");
  const hangUp =
    accountSid === undefined || authToken === undefined
      ? async () => {
          throw new Error("hanging up needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN");
        }
      : createTwilioHangUp({
          accountSid,
          authToken,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });

  const port = new ElevenLabsVoiceCallPort({
    client: new ElevenLabsClient({
      apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    agentIds: ids.agentIds,
    agentPhoneNumberId: ids.phoneNumberId,
    ownerName,
    hangUp,
    callSidFor: async (externalId) => {
      const call = await calls.findByExternalId(externalId);
      return call === undefined ? undefined : await calls.callSid(call.id);
    },
  });
  return { ok: true, port };
}

/**
 * Whether ElevenLabs reports a conversation as failed, for the reconciliation sweep, with the API
 * key in effect at each check. Without a key nothing can be asked, so no call counts as failed:
 * it is left for its webhook.
 */
export function createFailureLookup(
  options: Pick<VoicePortFactoryOptions, "settings" | "fetch">,
): (externalId: string) => Promise<boolean> {
  return async (externalId) => {
    const apiKey = await options.settings.value("ELEVENLABS_API_KEY");
    if (apiKey === undefined) return false;
    const client = new ElevenLabsClient({
      apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    return (await conversationStatus(client, externalId)) === "failed";
  };
}
