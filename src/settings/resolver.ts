import { type SettingName, settingDefinition } from "./catalog.ts";
import type { SecretStore } from "./secret-store.ts";
import type { SettingStore } from "./setting-store.ts";

/**
 * Where the value in effect comes from: the `.env` file (which Node loaded into the
 * environment), the shell environment, the dashboard's store (SQLite, or the Keychain for a
 * secret), or nowhere.
 */
export type SettingSource = "dotenv" | "environment" | "store" | "unset";

export interface ResolvedSetting {
  readonly value: string | undefined;
  readonly source: SettingSource;
}

export interface SettingsResolver {
  resolve(name: SettingName): Promise<ResolvedSetting>;
  /** The value in effect, or `undefined` when unset. */
  value(name: SettingName): Promise<string | undefined>;
  /**
   * The environment with each of `names` that is unset there filled from the stores, for the
   * parsers that read an environment. Everything else is left exactly as it was.
   */
  environment(names: readonly SettingName[]): Promise<Record<string, string | undefined>>;
}

export interface SettingsResolverOptions {
  /** The process environment, with `.env` already loaded by Node. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The names `.env` defines (see `readDotenvNames`), which tell a `.env` value from a shell one;
   * `undefined` when `.env` could not be read, so every environment value counts as "environment".
   */
  readonly dotenvNames?: ReadonlySet<string> | undefined;
  readonly values: Pick<SettingStore, "get">;
  readonly secrets: Pick<SecretStore, "get">;
}

const UNSET: ResolvedSetting = { value: undefined, source: "unset" };

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Resolves settings at each call, so a value saved from the dashboard applies at the next use.
 * The environment wins: a non-blank value there is the one in effect, whatever the stores hold.
 * Otherwise a secret comes from the secret store and anything else from the setting store, and
 * an environment-only setting (`BOOKER_DATA_DIR`, `BOOKER_HOST`) is simply unset.
 */
export function createSettingsResolver(options: SettingsResolverOptions): SettingsResolver {
  async function resolve(name: SettingName): Promise<ResolvedSetting> {
    const definition = settingDefinition(name);
    const fromEnvironment = options.env[name];
    if (present(fromEnvironment)) {
      return {
        value: fromEnvironment,
        source: options.dotenvNames?.has(name) === true ? "dotenv" : "environment",
      };
    }
    if (definition.envOnly) return UNSET;
    const stored = definition.secret
      ? await options.secrets.get(name)
      : await options.values.get(name);
    return present(stored) ? { value: stored, source: "store" } : UNSET;
  }

  return {
    resolve,
    async value(name) {
      return (await resolve(name)).value;
    },
    async environment(names) {
      const result: Record<string, string | undefined> = { ...options.env };
      const resolved = await Promise.all(names.map(async (name) => [name, await resolve(name)]));
      for (const [name, setting] of resolved as [SettingName, ResolvedSetting][]) {
        if (setting.source === "store") result[name] = setting.value;
      }
      return result;
    },
  };
}
