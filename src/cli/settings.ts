import { settingsInDatabaseFile } from "../persistence/sqlite-setting-store.ts";
import { databasePath } from "../server/config.ts";
import { createSettingsResolver, type SettingsResolver } from "../settings/resolver.ts";
import type { SecretStore } from "../settings/secret-store.ts";
import type { CliContext } from "./context.ts";

/**
 * The settings a command reads: the environment first, then what the dashboard saved, in the
 * database under `BOOKER_DATA_DIR` (opened per read, never created) and in `secrets` (the
 * context's store unless `serve` wraps it).
 */
export function settingsFor(
  context: CliContext,
  secrets: SecretStore = context.secrets,
): SettingsResolver {
  return createSettingsResolver({
    env: context.env,
    dotenvNames: context.dotenvNames,
    values: settingsInDatabaseFile(databasePath(context.env, context.repoRoot)),
    secrets,
  });
}

/**
 * Why the settings could not be read, for a "Cannot …" line: the first line of the error, which
 * names a setting or the database file but never a value.
 */
export function settingsFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r\n|\r|\n/u, 1)[0] ?? "";
}
