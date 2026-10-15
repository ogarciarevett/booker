import { settingsInDatabaseFile } from "../persistence/sqlite-setting-store.ts";
import { databasePath } from "../server/config.ts";
import { UnavailableSecretStore } from "../settings/adapters/unavailable-secret-store.ts";
import { TRACING_SETTINGS } from "../settings/catalog.ts";
import { createSettingsResolver } from "../settings/resolver.ts";

/**
 * `env` with the tracing settings it leaves unset filled from the dashboard's saved settings
 * (none of them is a secret, so the Keychain is never asked). Read once, when the tracer starts:
 * tracing settings apply after a restart. A database that cannot be read leaves `env` as it is.
 */
export async function savedTracingEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
  warn: (line: string) => void,
): Promise<Readonly<Record<string, string | undefined>>> {
  try {
    return await createSettingsResolver({
      env,
      values: settingsInDatabaseFile(databasePath(env, repoRoot)),
      secrets: new UnavailableSecretStore(),
    }).environment(TRACING_SETTINGS);
  } catch {
    warn("Tracing: the saved settings could not be read; using the environment only");
    return env;
  }
}
