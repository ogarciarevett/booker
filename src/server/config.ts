import { join, resolve } from "node:path";
import { z } from "zod";
import { settingDefinition } from "../settings/catalog.ts";

/** The only address Booker listens on. The public routes reach it through Tailscale Funnel. */
export const LOOPBACK_HOST = "127.0.0.1";
export type LoopbackHost = typeof LOOPBACK_HOST;

export const DEFAULT_PORT = 8787;
/** Where the SQLite database lives, relative to the repository root unless absolute. */
export const DEFAULT_DATA_DIR = ".local/data";
export const DATABASE_FILE_NAME = "booker.db";

export interface ServeConfig {
  readonly host: LoopbackHost;
  readonly port: number;
  /** Absolute path of the directory holding `booker.db`. */
  readonly dataDir: string;
}

export type ParseServeConfigResult =
  | { readonly ok: true; readonly config: ServeConfig }
  | { readonly ok: false; readonly issues: string[] };

// The catalog's rules, so the dashboard and `serve` agree on what a valid value is.
const serveEnvironmentSchema = z.object({
  BOOKER_PORT: settingDefinition("BOOKER_PORT").schema.optional(),
  BOOKER_HOST: settingDefinition("BOOKER_HOST").schema.optional(),
  BOOKER_DATA_DIR: settingDefinition("BOOKER_DATA_DIR").schema.optional(),
});

type ServeVariable = keyof z.input<typeof serveEnvironmentSchema>;

const SERVE_VARIABLES = Object.keys(serveEnvironmentSchema.shape) as ServeVariable[];

/**
 * Where the database lives: `BOOKER_DATA_DIR` from the environment (the database cannot say
 * where it is), resolved against the repository root, or `.local/data`.
 */
export function dataDirectory(
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): string {
  const configured = env["BOOKER_DATA_DIR"];
  return resolve(
    repoRoot,
    configured === undefined || configured === "" ? DEFAULT_DATA_DIR : configured,
  );
}

/** `<data directory>/booker.db`. */
export function databasePath(
  env: Readonly<Record<string, string | undefined>>,
  repoRoot: string,
): string {
  return join(dataDirectory(env, repoRoot), DATABASE_FILE_NAME);
}

/**
 * Reads what `serve` binds at start (host, port, data directory) from `env`: the process
 * environment, or that environment with `BOOKER_PORT` filled from the dashboard's store (see
 * `SettingsResolver.environment`). An empty value counts as unset. Every problem is reported at
 * once, by variable name, with the catalog's fixed message and never with the value that was
 * set. The webhook secret is not part of it: the post-call webhook reads it at each delivery.
 */
export function parseServeConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly repoRoot: string },
): ParseServeConfigResult {
  const input: Partial<Record<ServeVariable, string>> = {};
  for (const variable of SERVE_VARIABLES) {
    const value = env[variable];
    if (value !== undefined && value !== "") input[variable] = value;
  }

  const parsed = serveEnvironmentSchema.safeParse(input);
  if (!parsed.success) {
    const invalid = new Set(parsed.error.issues.map((issue) => issue.path[0]));
    return {
      ok: false,
      issues: SERVE_VARIABLES.filter((variable) => invalid.has(variable)).map(
        (variable) => settingDefinition(variable).invalid,
      ),
    };
  }

  const data = parsed.data;
  return {
    ok: true,
    config: {
      host: LOOPBACK_HOST,
      port: data.BOOKER_PORT === undefined ? DEFAULT_PORT : Number(data.BOOKER_PORT),
      dataDir: dataDirectory(input, options.repoRoot),
    },
  };
}
