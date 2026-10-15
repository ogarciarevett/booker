import type { FetchFn } from "../calls/adapters/elevenlabs/client.ts";
import type { ActiveTracing } from "../observability/settings.ts";
import type { SecretStore } from "../settings/secret-store.ts";
import type { CommandOutput } from "./router.ts";

/** The part of `process` a long-running command uses to hear Ctrl+C and `kill`. */
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** Everything a `pnpm booker` command may touch outside its own module, injected for tests. */
export interface CliContext extends CommandOutput {
  /** The repository root; relative paths such as `.local/` resolve against it. */
  readonly repoRoot: string;
  /** Configuration source: `process.env`, with `.env` already loaded by Node. It wins. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Secrets saved from the dashboard: the macOS Keychain (see `main.ts`). */
  readonly secrets: SecretStore;
  /** The names `.env` defines, to label sources; `undefined` when `.env` could not be read. */
  readonly dotenvNames: ReadonlySet<string> | undefined;
  readonly signals: SignalSource;
  /** How commands reach ElevenLabs and Booker's own server; the global `fetch` when unset. */
  readonly fetch?: FetchFn;
  /** Waits between polls; a real timer when unset. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Set when this process was started with the tracer preloaded (`pnpm serve:traced`). */
  readonly tracing?: ActiveTracing;
}
