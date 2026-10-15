// Runs the Next.js CLI with its anonymous usage telemetry off (NEXT_TELEMETRY_DISABLED=1), so
// nothing about this dashboard is reported to Vercel; every argument is passed through. Used by
// this package's dev, build, and start scripts in place of a shell-specific `VAR=value` prefix.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { exitCodeFor } from "./exit-code.ts";

const nextCli = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextCli, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});

// Ctrl+C already reaches Next.js through the terminal's process group; wait for it to stop.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
child.on("exit", (code, signal) => {
  process.exitCode = exitCodeFor(code, signal);
});
