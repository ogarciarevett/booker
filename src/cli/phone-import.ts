import { relative } from "node:path";
import { z } from "zod";
import { ElevenLabsClient } from "../calls/adapters/elevenlabs/client.ts";
import { importTwilioNumber } from "../calls/adapters/elevenlabs/phone-import.ts";
import { elevenLabsIdsPath, saveElevenLabsIds } from "../server/elevenlabs-ids.ts";
import { describeError } from "../server/logging.ts";
import { E164_PATTERN, type SettingName, TWILIO_ACCOUNT_SID_PATTERN } from "../settings/catalog.ts";
import type { CliContext } from "./context.ts";
import { parseEnvironment } from "./environment.ts";
import { type Command, USAGE_EXIT_CODE } from "./router.ts";
import { settingsFailure, settingsFor } from "./settings.ts";

const phoneImportEnvironmentSchema = z.object({
  ELEVENLABS_API_KEY: z.string(),
  TWILIO_ACCOUNT_SID: z.string().regex(TWILIO_ACCOUNT_SID_PATTERN),
  TWILIO_AUTH_TOKEN: z.string(),
  TWILIO_PHONE_NUMBER: z.string().regex(E164_PATTERN),
});

const PHONE_IMPORT_SETTINGS = Object.keys(phoneImportEnvironmentSchema.shape) as SettingName[];

const ISSUE_MESSAGES = {
  ELEVENLABS_API_KEY: "ELEVENLABS_API_KEY is required: an ElevenLabs API key",
  TWILIO_ACCOUNT_SID:
    "TWILIO_ACCOUNT_SID must be the Twilio Account SID (AC followed by 32 hex digits)",
  TWILIO_AUTH_TOKEN: "TWILIO_AUTH_TOKEN is required: the Twilio account's Auth Token",
  TWILIO_PHONE_NUMBER:
    "TWILIO_PHONE_NUMBER must be the Twilio number in E.164, such as +15550100100",
} as const;

/**
 * `pnpm booker phone import`: makes ElevenLabs know the Twilio number (importing it once, reusing
 * it after) and saves its id to `.local/elevenlabs.json`. Credentials are never printed.
 */
export const phoneImportCommand: Command<CliContext> = {
  name: "phone import",
  summary: "Imports the Twilio number into ElevenLabs (once)",
  async run(args, context) {
    if (args.length > 0) {
      context.stderr("phone import takes no arguments: it reads Booker's settings.");
      return USAGE_EXIT_CODE;
    }
    let resolved: Record<string, string | undefined>;
    try {
      resolved = await settingsFor(context).environment(PHONE_IMPORT_SETTINGS);
    } catch (error) {
      context.stderr(`Cannot import the number: ${settingsFailure(error)}`);
      return 1;
    }
    const parsed = parseEnvironment(resolved, phoneImportEnvironmentSchema, ISSUE_MESSAGES);
    if (!parsed.ok) {
      context.stderr("Cannot import the number: the configuration is incomplete or invalid.");
      for (const issue of parsed.issues) context.stderr(`  - ${issue}`);
      context.stderr("Set these in .env or the environment (see docs/live-calls.md).");
      return 1;
    }
    const env = parsed.value;

    try {
      const { phoneNumberId, created } = await importTwilioNumber({
        client: new ElevenLabsClient({
          apiKey: env.ELEVENLABS_API_KEY,
          ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
        }),
        phoneNumber: env.TWILIO_PHONE_NUMBER,
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
      });
      const idsPath = elevenLabsIdsPath(context.repoRoot);
      await saveElevenLabsIds(idsPath, { phoneNumberId });
      context.stdout(
        created
          ? `Imported TWILIO_PHONE_NUMBER into ElevenLabs as ${phoneNumberId}.`
          : `TWILIO_PHONE_NUMBER was already imported, as ${phoneNumberId}.`,
      );
      context.stdout(`Id saved to ${relative(context.repoRoot, idsPath)}.`);
      return 0;
    } catch (error) {
      context.stderr(
        `Cannot import the number: ${describeError(error, [env.ELEVENLABS_API_KEY, env.TWILIO_AUTH_TOKEN])}`,
      );
      return 1;
    }
  },
};
