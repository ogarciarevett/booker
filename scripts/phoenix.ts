// Entry point for `pnpm phoenix`: runs Arize Phoenix natively with uv until Ctrl+C.
// See docs/observability.md. Needs `uv` on the PATH (https://docs.astral.sh/uv/).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exitCodeFor } from "./exit-code.ts";
import { PHOENIX_URL, phoenixCommand } from "./phoenix-command.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const { command, args, env } = phoenixCommand({ repoRoot, env: process.env });

// Phoenix keeps every exported span here: keep it private, like the rest of `.local/`.
mkdirSync(env["PHOENIX_WORKING_DIR"] ?? "", { recursive: true, mode: 0o700 });

console.log(`Starting Phoenix at ${PHOENIX_URL} (Ctrl+C stops it).`);
console.log(`Send traces to ${PHOENIX_URL}/v1/traces with: pnpm serve:traced`);

const child = spawn(command, args, { env, stdio: "inherit" });
// Ctrl+C already reaches Phoenix through the terminal's process group; sending it again would
// make Phoenix skip its graceful shutdown. This process just waits for Phoenix to stop.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
child.on("error", (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === "ENOENT"
      ? "uvx was not found: install uv (https://docs.astral.sh/uv/) and try again."
      : `Could not start Phoenix: ${error.message}`,
  );
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = exitCodeFor(code, signal);
});
