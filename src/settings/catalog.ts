import { posix, win32 } from "node:path";
import { z } from "zod";

/**
 * Every setting Booker reads, in one place: where it shows in the dashboard, whether it is a
 * secret (kept in the macOS Keychain, never shown or returned), how a value is validated, and
 * whether a change applies at once or after a restart. The process environment (`.env` or the
 * shell) always wins over a value saved from the dashboard; see `resolver.ts`.
 */

export const SETTING_GROUPS = [
  "Owner",
  "Public URL",
  "ElevenLabs",
  "Twilio",
  "Jev",
  "Model keys",
  "Tracing",
  "Server",
] as const;

export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** `live`: read at each use, so a change applies at once. `restart`: read when Booker starts. */
export type SettingApplies = "live" | "restart";

/** A phone number in E.164: `+`, a country code, and up to 15 digits in all. */
export const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;
export const TWILIO_ACCOUNT_SID_PATTERN = /^AC[0-9a-f]{32}$/;
const PORT_PATTERN = /^[0-9]+$/;
const MAX_PORT = 65_535;

function urlWithProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** An `https:` URL, for `PUBLIC_BASE_URL`. */
export function isHttpsUrl(value: string): boolean {
  return urlWithProtocol(value, ["https:"]);
}

/** An `http:` or `https:` URL. */
export function isHttpUrl(value: string): boolean {
  return urlWithProtocol(value, ["http:", "https:"]);
}

/** A whole number from 1 to 65535, written with digits only. */
export function isPort(value: string): boolean {
  if (!PORT_PATTERN.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= MAX_PORT;
}

const text = z.string().min(1);

/** A portable file path inside the repository, without parent traversal or control characters. */
export function isRepoRelativePath(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !posix.isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    [...value].every((character) => character >= " " && character !== "\u007f")
  );
}

interface Definition {
  readonly group: SettingGroup;
  readonly secret: boolean;
  /** What the value is for, written for the owner. */
  readonly description: string;
  /** Validates a non-empty value. Its own messages are never shown: they can quote the value. */
  readonly schema: z.ZodType<string, string>;
  /** Shown when a value fails `schema`: names the setting and what it must be, never the value. */
  readonly invalid: string;
  readonly applies: SettingApplies;
  /** Read from the environment only: never saved from the dashboard. */
  readonly envOnly: boolean;
}

const DEFINITIONS = {
  BOOKER_OWNER_NAME: {
    group: "Owner",
    secret: false,
    description:
      "Whom the agent says it calls for, sent with every call as owner_name. Personal data.",
    schema: text.max(200),
    invalid: "BOOKER_OWNER_NAME must be a name of 1 to 200 characters",
    applies: "live",
    envOnly: false,
  },
  PUBLIC_BASE_URL: {
    group: "Public URL",
    secret: false,
    description:
      "The Tailscale Funnel's https base URL. Agent sync points the voice tools and the post-call webhook here.",
    schema: text.refine(isHttpsUrl),
    invalid:
      "PUBLIC_BASE_URL must be an https URL: the Tailscale Funnel address the agent calls back",
    applies: "live",
    envOnly: false,
  },
  ELEVENLABS_API_KEY: {
    group: "ElevenLabs",
    secret: true,
    description:
      "ElevenLabs API key. Places calls, checks stale calls, and runs agent sync and phone import.",
    schema: text,
    invalid: "ELEVENLABS_API_KEY must be an ElevenLabs API key",
    applies: "live",
    envOnly: false,
  },
  ELEVENLABS_WEBHOOK_SECRET: {
    group: "ElevenLabs",
    secret: true,
    description:
      "Signing secret of the post-call webhook, from the ElevenLabs workspace. Verifies every delivery.",
    schema: text,
    invalid: "ELEVENLABS_WEBHOOK_SECRET must be the post-call webhook's signing secret",
    applies: "live",
    envOnly: false,
  },
  ELEVENLABS_VOICE_ID: {
    group: "ElevenLabs",
    secret: false,
    description: "The owner's consented voice clone. Agent sync gives it to both agents.",
    schema: text,
    invalid: "ELEVENLABS_VOICE_ID must be the id of the owner's voice clone",
    applies: "live",
    envOnly: false,
  },
  BOOKER_AGENT_SCRIPT: {
    group: "ElevenLabs",
    secret: false,
    description:
      "Agent script relative to the repository root. Agent sync defaults to locales/es-ES/agent.yaml; custom scripts use separate agents.",
    schema: text.refine(isRepoRelativePath),
    invalid: "BOOKER_AGENT_SCRIPT must be a repository-relative file path without parent traversal",
    applies: "live",
    envOnly: false,
  },
  TWILIO_ACCOUNT_SID: {
    group: "Twilio",
    secret: false,
    description: "The Twilio Account SID. Used by phone import and to hang up a call.",
    schema: z.string().regex(TWILIO_ACCOUNT_SID_PATTERN),
    invalid: "TWILIO_ACCOUNT_SID must be the Twilio Account SID (AC followed by 32 hex digits)",
    applies: "live",
    envOnly: false,
  },
  TWILIO_AUTH_TOKEN: {
    group: "Twilio",
    secret: true,
    description: "The Twilio account's Auth Token. Used by phone import and to hang up a call.",
    schema: text,
    invalid: "TWILIO_AUTH_TOKEN must be the Twilio account's Auth Token",
    applies: "live",
    envOnly: false,
  },
  TWILIO_PHONE_NUMBER: {
    group: "Twilio",
    secret: false,
    description: "The number the agents call from, in E.164. Phone import gives it to ElevenLabs.",
    schema: z.string().regex(E164_PATTERN),
    invalid: "TWILIO_PHONE_NUMBER must be the Twilio number in E.164, such as +15550100100",
    applies: "live",
    envOnly: false,
  },
  TYPESAFE_API_KEY: {
    group: "Jev",
    secret: true,
    description:
      "Jev (TypeSafe) API key for bounded decisions. Only pnpm route-task uses Jev today, and it reads .env or the environment.",
    schema: text,
    invalid: "TYPESAFE_API_KEY must be a TypeSafe API key",
    applies: "live",
    envOnly: false,
  },
  TYPESAFE_BASE_URL: {
    group: "Jev",
    secret: false,
    description:
      "Overrides Jev's API address. Only pnpm route-task uses Jev today, and it reads .env or the environment.",
    schema: text.refine(isHttpUrl),
    invalid: "TYPESAFE_BASE_URL must be an http(s) URL",
    applies: "live",
    envOnly: false,
  },
  OPENAI_API_KEY: {
    group: "Model keys",
    secret: true,
    description: "OpenAI API key for the api:openai model profiles. Nothing reads it yet.",
    schema: text,
    invalid: "OPENAI_API_KEY must be an OpenAI API key",
    applies: "live",
    envOnly: false,
  },
  ANTHROPIC_API_KEY: {
    group: "Model keys",
    secret: true,
    description: "Anthropic API key for the api:anthropic model profiles. Nothing reads it yet.",
    schema: text,
    invalid: "ANTHROPIC_API_KEY must be an Anthropic API key",
    applies: "live",
    envOnly: false,
  },
  GEMINI_API_KEY: {
    group: "Model keys",
    secret: true,
    description:
      "Google Gemini API key for future api:google model profiles. Nothing reads it yet.",
    schema: text,
    invalid: "GEMINI_API_KEY must be a Gemini API key",
    applies: "live",
    envOnly: false,
  },
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: {
    group: "Tracing",
    secret: false,
    description:
      "Where pnpm serve:traced sends spans, as an OTLP/HTTP URL; Phoenix's is http://127.0.0.1:6006/v1/traces. Unset keeps tracing off.",
    schema: text.refine(isHttpUrl),
    invalid:
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an http(s) URL such as http://127.0.0.1:6006/v1/traces",
    applies: "restart",
    envOnly: false,
  },
  OTEL_SERVICE_NAME: {
    group: "Tracing",
    secret: false,
    description: "The service name, and the Phoenix project spans are filed under (booker).",
    schema: text.max(100),
    invalid: "OTEL_SERVICE_NAME must be a name of 1 to 100 characters",
    applies: "restart",
    envOnly: false,
  },
  OTEL_SDK_DISABLED: {
    group: "Tracing",
    secret: false,
    description: "true keeps tracing off even with an endpoint set.",
    schema: z.string().regex(/^(?:true|false)$/i),
    invalid: "OTEL_SDK_DISABLED must be true or false",
    applies: "restart",
    envOnly: false,
  },
  BOOKER_PORT: {
    group: "Server",
    secret: false,
    description: "The loopback port Booker listens on (8787 when unset).",
    schema: z.string().refine(isPort),
    invalid: "BOOKER_PORT must be a whole number from 1 to 65535",
    applies: "restart",
    envOnly: false,
  },
  BOOKER_HOST: {
    group: "Server",
    secret: false,
    description:
      "Only 127.0.0.1: Booker listens on loopback alone, and Tailscale Funnel exposes the public routes.",
    schema: z.literal("127.0.0.1"),
    invalid:
      "BOOKER_HOST must be 127.0.0.1 or unset: Booker listens only on loopback, and Tailscale Funnel exposes the public routes",
    applies: "restart",
    envOnly: true,
  },
  BOOKER_DATA_DIR: {
    group: "Server",
    secret: false,
    description:
      "Folder for booker.db, relative to the repository unless absolute (.local/data when unset). The database cannot say where it lives.",
    schema: text,
    invalid: "BOOKER_DATA_DIR must be a directory path",
    applies: "restart",
    envOnly: true,
  },
} as const satisfies Record<string, Definition>;

export type SettingName = keyof typeof DEFINITIONS;

export interface SettingDefinition extends Definition {
  readonly name: SettingName;
}

/** Every setting, in the order the dashboard shows them. */
export const SETTINGS: readonly SettingDefinition[] = (
  Object.entries(DEFINITIONS) as [SettingName, Definition][]
).map(([name, definition]) => ({ name, ...definition }));

const BY_NAME = new Map<string, SettingDefinition>(
  SETTINGS.map((setting) => [setting.name, setting]),
);

/** The settings the tracer reads when it starts (`pnpm serve:traced`): the Tracing group. */
export const TRACING_SETTINGS: readonly SettingName[] = SETTINGS.filter(
  (setting) => setting.group === "Tracing",
).map((setting) => setting.name);

export function isSettingName(name: string): name is SettingName {
  return BY_NAME.has(name);
}

export function settingDefinition(name: SettingName): SettingDefinition {
  const definition = BY_NAME.get(name);
  if (definition === undefined) throw new RangeError(`unknown setting ${name}`);
  return definition;
}

export type SettingValidation =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly issue: string };

/** Checks `value` against the setting's rule; an issue never repeats the value. */
export function validateSetting(name: SettingName, value: string): SettingValidation {
  const definition = settingDefinition(name);
  return definition.schema.safeParse(value).success
    ? { ok: true, value }
    : { ok: false, issue: definition.invalid };
}
