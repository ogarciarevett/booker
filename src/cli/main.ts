// Entry point for `pnpm booker <command>`, which runs
// `node --env-file-if-exists=.env src/cli/main.ts`: Node loads `.env` into `process.env`. This
// module only reads the names `.env` defines (never its values), to tell the dashboard which
// settings come from it. Exit codes: 0 done, 1 failed, 2 unknown command or bad arguments.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startedTracing } from "../observability/settings.ts";
import { UnavailableSecretStore } from "../settings/adapters/unavailable-secret-store.ts";
import { dotenvWarning, readDotenvNames } from "../settings/dotenv.ts";
import type { SecretStore } from "../settings/secret-store.ts";
import { agentSyncCommand } from "./agent-sync.ts";
import { callCommand } from "./call.ts";
import type { CliContext } from "./context.ts";
import { phoneImportCommand } from "./phone-import.ts";
import { type Command, runCommand } from "./router.ts";
import { serveCommand } from "./serve.ts";

/** Every `pnpm booker` command. Adding one is a module exporting a `Command` plus a line here. */
const COMMANDS: readonly Command<CliContext>[] = [
  serveCommand,
  agentSyncCommand,
  phoneImportCommand,
  callCommand,
];

// `pnpm serve:traced` preloads src/observability/telemetry.ts, which records that tracing runs.
const tracing = startedTracing();
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Secrets saved from the dashboard live in the macOS Keychain; elsewhere only the environment
// holds them. The Keychain module (a native binding) loads only where it is used.
const secrets: SecretStore =
  process.platform === "darwin"
    ? (await import("../settings/adapters/macos-keychain.ts")).macosKeychain()
    : new UnavailableSecretStore();

const dotenv = await readDotenvNames(join(repoRoot, ".env"));
const warning = dotenvWarning(dotenv);
if (warning !== undefined) process.stderr.write(`${warning}\n`);

process.exitCode = await runCommand(process.argv.slice(2), COMMANDS, {
  repoRoot,
  env: process.env,
  secrets,
  dotenvNames: dotenv.ok ? dotenv.names : undefined,
  signals: process,
  ...(tracing === undefined ? {} : { tracing }),
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
});
