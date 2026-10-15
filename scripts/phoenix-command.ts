import { join } from "node:path";
import { isCredentialName } from "../src/shared/credential-names.ts";

/** Pinned: published 2026-10-01, at least a day before it was adopted. */
export const PHOENIX_PACKAGE = "arize-phoenix==20.19.0";
export const PHOENIX_HOST = "127.0.0.1";
export const PHOENIX_PORT = "6006";
export const PHOENIX_URL = `http://${PHOENIX_HOST}:${PHOENIX_PORT}`;
const PYTHON_VERSION = "3.13";

/** Booker's own configuration and anything named like a credential stays out of Phoenix. */
const WITHHELD_PREFIXES = ["BOOKER_", "ELEVENLABS_", "TWILIO_", "TYPESAFE_", "OTEL_"];

export interface PhoenixCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * How `pnpm phoenix` starts Arize Phoenix natively through `uvx` (no Docker): the pinned release,
 * the UI and OTLP/HTTP receiver on 127.0.0.1:6006 only, its data in `<repoRoot>/.local/phoenix`,
 * and its usage telemetry off. Phoenix inherits the environment minus Booker's variables, OTel
 * settings meant for Booker, and credentials; other `PHOENIX_*` variables still apply, but these
 * four always win.
 */
export function phoenixCommand(options: {
  readonly repoRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): PhoenixCommand {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env)) {
    if (value === undefined) continue;
    if (WITHHELD_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (isCredentialName(name)) continue;
    inherited[name] = value;
  }
  return {
    command: "uvx",
    args: ["--python", PYTHON_VERSION, "--from", PHOENIX_PACKAGE, "phoenix", "serve"],
    env: {
      ...inherited,
      PHOENIX_HOST,
      PHOENIX_PORT,
      PHOENIX_WORKING_DIR: join(options.repoRoot, ".local", "phoenix"),
      PHOENIX_TELEMETRY_ENABLED: "false",
    },
  };
}
