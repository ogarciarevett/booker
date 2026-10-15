import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  isSettingName,
  SETTING_GROUPS,
  SETTINGS,
  type SettingDefinition,
  type SettingName,
  validateSetting,
} from "../settings/catalog.ts";
import type { ResolvedSetting, SettingsResolver } from "../settings/resolver.ts";
import {
  type SecretStore,
  SecretStoreUnavailableError,
  secretStatus,
} from "../settings/secret-store.ts";
import type { SettingStore } from "../settings/setting-store.ts";

/** A setting saved or removed from the dashboard: its name and what happened, never a value. */
export interface SettingActivity {
  readonly type: "setting";
  readonly name: SettingName;
  readonly action: "saved" | "removed";
  readonly at: string;
}

export interface SettingsControlDeps {
  /** Resolves each setting at each request: the environment, then the stores below. */
  readonly resolver: SettingsResolver;
  /** Where plain values are saved (SQLite). */
  readonly values: SettingStore;
  /** Where secrets are saved (the macOS Keychain). */
  readonly secrets: SecretStore;
  /**
   * What each restart-only setting resolved to when Booker started; a setting whose value is
   * different now waits for a restart.
   */
  readonly atStart: ReadonlyMap<SettingName, string | undefined>;
  /** One line per change: the name, the action, and the store. Never a value. */
  readonly audit?: (line: string) => void;
}

interface SettingsRouteDeps {
  readonly settings: SettingsControlDeps;
  readonly now: () => string;
  readonly report?: (activity: SettingActivity) => void;
}

/** Long enough for any key, URL, or name; a value this long is a paste gone wrong. */
const MAX_VALUE_LENGTH = 4096;
// Line breaks, tabs, and other control characters: a value is one line of text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

const INVALID_REQUEST = { error: "invalid_request" } as const;
const UNKNOWN_SETTING = { error: "unknown_setting" } as const;
const putRequestSchema = z.object({ value: z.string() });

/** How a setting is shown: never a secret's value, at most its last four characters. */
function settingView(
  definition: SettingDefinition,
  resolved: ResolvedSetting,
  atStart: SettingsControlDeps["atStart"],
) {
  const configured = resolved.value !== undefined;
  const fromEnvironment = resolved.source === "dotenv" || resolved.source === "environment";
  const lastFour = definition.secret ? secretStatus(resolved.value).lastFour : undefined;
  return {
    name: definition.name,
    group: definition.group,
    description: definition.description,
    secret: definition.secret,
    applies: definition.applies,
    source: resolved.source,
    configured,
    editable: !definition.envOnly && !fromEnvironment,
    restartPending:
      definition.applies === "restart" &&
      atStart.has(definition.name) &&
      atStart.get(definition.name) !== resolved.value,
    ...(definition.secret || resolved.value === undefined ? {} : { value: resolved.value }),
    ...(lastFour === undefined ? {} : { lastFour }),
  };
}

function definitionFor(name: string): SettingDefinition | undefined {
  return isSettingName(name) ? SETTINGS.find((setting) => setting.name === name) : undefined;
}

/** Why `name` cannot be changed here, or `undefined` when it can. */
function lockedBy(definition: SettingDefinition, resolved: ResolvedSetting) {
  const { name } = definition;
  if (definition.envOnly) {
    return {
      error: "environment_only",
      detail: `${name} is read from .env or the environment only.`,
    };
  }
  if (resolved.source === "dotenv") {
    return {
      error: "set_in_environment",
      detail: `${name} is defined in .env, which wins over the dashboard: remove it there to edit it here.`,
    };
  }
  if (resolved.source === "environment") {
    return {
      error: "set_in_environment",
      detail: `${name} is set in the environment Booker was started with, which wins over the dashboard: unset it there and restart Booker to edit it here.`,
    };
  }
  return undefined;
}

/**
 * The owner's settings, behind the control token like every control route:
 *
 * - `GET /control/settings` lists every catalog setting with its group, description, source
 *   (`dotenv`, `environment`, `store`, `unset`), whether it is configured and editable here, and
 *   whether a restart is pending; a plain value is included, a secret only as its last four.
 * - `PUT /control/settings/:name` `{ value }` validates the trimmed value against the catalog and
 *   saves it (secrets to the secret store, the rest to the setting store). A value from `.env` or
 *   the environment, which always wins, is refused with 409, as is an environment-only setting.
 * - `DELETE /control/settings/:name` removes a saved value, under the same refusals.
 *
 * Each change writes one audit line (name, action, store) and reports a `setting` activity, so
 * open dashboards refresh. No answer, log line, or event ever carries a secret.
 */
export function mountSettingsRoutes(app: Hono, deps: SettingsRouteDeps): void {
  const { settings } = deps;

  async function viewOf(definition: SettingDefinition) {
    return settingView(
      definition,
      await settings.resolver.resolve(definition.name),
      settings.atStart,
    );
  }

  function announce(definition: SettingDefinition, action: SettingActivity["action"]): void {
    const store = definition.secret ? "keychain" : "sqlite";
    settings.audit?.(`setting ${definition.name} ${action} (store: ${store})`);
    try {
      deps.report?.({ type: "setting", name: definition.name, action, at: deps.now() });
    } catch {
      // A failing listener must not change the answer.
    }
  }

  function storeFailure(c: Context, error: unknown): Response {
    if (error instanceof SecretStoreUnavailableError) {
      return c.json({ error: "secret_store_unavailable", detail: error.message }, 503);
    }
    throw error;
  }

  app.get("/control/settings", async (c) => {
    const views = await Promise.all(SETTINGS.map((definition) => viewOf(definition)));
    return c.json({ groups: SETTING_GROUPS, settings: views });
  });

  app.put("/control/settings/:name", async (c) => {
    const definition = definitionFor(c.req.param("name"));
    if (definition === undefined) return c.json(UNKNOWN_SETTING, 404);
    let json: unknown;
    try {
      json = JSON.parse(await c.req.text());
    } catch {
      return c.json(INVALID_REQUEST, 400);
    }
    const request = putRequestSchema.safeParse(json);
    if (!request.success) return c.json(INVALID_REQUEST, 400);

    const locked = lockedBy(definition, await settings.resolver.resolve(definition.name));
    if (locked !== undefined) return c.json(locked, 409);

    const value = request.data.value.trim();
    const validation = validateSetting(definition.name, value);
    if (!validation.ok || value.length > MAX_VALUE_LENGTH || CONTROL_CHARACTERS.test(value)) {
      return c.json({ error: "invalid_value", detail: definition.invalid }, 400);
    }

    try {
      if (definition.secret) await settings.secrets.set(definition.name, value);
      else await settings.values.set(definition.name, value);
    } catch (error) {
      return storeFailure(c, error);
    }
    announce(definition, "saved");
    return c.json(await viewOf(definition));
  });

  app.delete("/control/settings/:name", async (c) => {
    const definition = definitionFor(c.req.param("name"));
    if (definition === undefined) return c.json(UNKNOWN_SETTING, 404);
    const locked = lockedBy(definition, await settings.resolver.resolve(definition.name));
    if (locked !== undefined) return c.json(locked, 409);

    let removed: boolean;
    try {
      removed = definition.secret
        ? await settings.secrets.remove(definition.name)
        : await settings.values.remove(definition.name);
    } catch (error) {
      return storeFailure(c, error);
    }
    if (removed) announce(definition, "removed");
    return c.json(await viewOf(definition));
  });
}
