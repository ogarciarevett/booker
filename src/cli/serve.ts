import { isAbsolute, join, relative } from "node:path";
import { addSpanSecrets } from "../observability/redaction.ts";
import { shownEndpoint, tracingSettings } from "../observability/settings.ts";
import { settingsInDatabaseFile } from "../persistence/sqlite-setting-store.ts";
import {
  DATABASE_FILE_NAME,
  type RunningBookerServer,
  startBookerServer,
} from "../server/booker-server.ts";
import { databasePath, parseServeConfig, type ServeConfig } from "../server/config.ts";
import { controlTokenPath, ensureControlToken } from "../server/control-token.ts";
import { describeError } from "../server/logging.ts";
import { PrivateFileError } from "../server/private-file.ts";
import { createFailureLookup, createVoicePortFactory } from "../server/voice.ts";
import {
  ensureVoiceToolsKey,
  VoiceToolsKeyError,
  voiceToolsKeyPath,
} from "../server/voice-tools-key.ts";
import { readSavedWebhookSecret, webhookSecretPath } from "../server/webhook-secret.ts";
import { SETTINGS, type SettingName, TRACING_SETTINGS } from "../settings/catalog.ts";
import type { SettingsResolver } from "../settings/resolver.ts";
import { onSecretValue } from "../settings/secret-store.ts";
import type { CliContext, SignalSource } from "./context.ts";
import { type Command, USAGE_EXIT_CODE } from "./router.ts";
import { settingsFor } from "./settings.ts";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/**
 * Resolves with the first shutdown signal, then stops listening for both: a second Ctrl+C
 * reaches Node's default handler and ends the process at once.
 */
function nextShutdownSignal(signals: SignalSource): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const listeners = SHUTDOWN_SIGNALS.map((signal) => {
      const listener = () => {
        for (const [name, registered] of listeners) signals.off(name, registered);
        resolve(signal);
      };
      return [signal, listener] as const;
    });
    for (const [signal, listener] of listeners) signals.on(signal, listener);
  });
}

/** `path` relative to the repository when it lies inside it, so output stays short. */
function shown(repoRoot: string, path: string): string {
  const fromRoot = relative(repoRoot, path);
  return fromRoot.startsWith("..") || isAbsolute(fromRoot) ? path : fromRoot;
}

/** An error's first line: the Keychain adapter's messages name the setting, never a value. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r\n|\r|\n/u, 1)[0] ?? "";
}

/** `a`, `a and b`, or `a, b, and c`. */
function listed(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function timestamped(write: (line: string) => void): (line: string) => void {
  return (line) => write(`${new Date().toISOString()} ${line}`);
}

/** Where spans go, or why they do not although an endpoint is set; nothing when unconfigured. */
async function describeTracing(
  context: CliContext,
  settings: SettingsResolver,
): Promise<string | undefined> {
  if (context.tracing !== undefined) {
    const { serviceName, endpoint } = context.tracing;
    return `Tracing: on (service ${serviceName}), spans go to ${shownEndpoint(endpoint)}`;
  }
  const tracing = tracingSettings(await settings.environment(TRACING_SETTINGS));
  switch (tracing.status) {
    case "off":
      return undefined;
    case "disabled":
      return "Tracing: off; OTEL_SDK_DISABLED is true";
    case "invalid":
      return `Tracing: ${tracing.issue}`;
    case "on":
      return "Tracing: off; OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set, so start with pnpm serve:traced";
  }
}

function reportIssues(context: CliContext, issues: readonly string[]): number {
  context.stderr("Cannot start: the configuration is incomplete or invalid.");
  for (const issue of issues) context.stderr(`  - ${issue}`);
  context.stderr(
    "Fix these in .env, the environment, or Booker's saved settings (see docs/live-calls.md).",
  );
  return 1;
}

/**
 * `pnpm booker serve`: checks the configuration, makes sure the voice-tools key exists, runs
 * the server until SIGINT or SIGTERM, then shuts it down gracefully. Nothing is written to disk
 * before the configuration is valid, and neither the key nor any secret is ever printed.
 *
 * What it binds at start (host, port, data directory) is read once; everything else (the webhook
 * secret, the voice credentials, the owner's name) is resolved at each use through the settings
 * resolver, so a value saved from the dashboard applies without a restart. The environment
 * always wins over a saved value.
 */
export const serveCommand: Command<CliContext> = {
  name: "serve",
  summary: "Runs the Booker server on 127.0.0.1 until Ctrl+C",
  async run(args, context) {
    if (args.length > 0) {
      context.stderr(
        "serve takes no arguments: it reads Booker's settings (see docs/live-calls.md).",
      );
      return USAGE_EXIT_CODE;
    }

    // The environment alone first: a bad host or port there fails before any store is opened.
    const fromEnvironment = parseServeConfig(context.env, { repoRoot: context.repoRoot });
    if (!fromEnvironment.ok) return reportIssues(context, fromEnvironment.issues);

    // Every secret read or saved is redacted from logs and spans from then on.
    const knownSecrets = new Set<string>();
    const secrets = onSecretValue(context.secrets, (value) => {
      knownSecrets.add(value);
      addSpanSecrets(value);
    });
    const settings = settingsFor(context, secrets);

    // A Keychain that cannot be read (locked, as over SSH or under launchd) does not stop Booker:
    // it says so and carries on with .env, the environment, and the saved files.
    const secretAtStart = async (name: SettingName): Promise<string | undefined> => {
      try {
        return await settings.value(name);
      } catch (error) {
        context.stderr(
          `Keychain unavailable: ${firstLine(error)} Continuing with .env, the environment, and saved files.`,
        );
        return undefined;
      }
    };

    let savedWebhookSecret: string | undefined;
    let webhookConfigured: boolean;
    let apiKey: string | undefined;
    let ownerName: string | undefined;
    let config: ServeConfig;
    const atStart = new Map<SettingName, string | undefined>();
    try {
      const parsed = parseServeConfig(await settings.environment(["BOOKER_PORT"]), {
        repoRoot: context.repoRoot,
      });
      if (!parsed.ok) return reportIssues(context, parsed.issues);
      config = parsed.config;
      // A webhook that `agent sync` created keeps its secret in a private file; any configured
      // secret (the environment or the Keychain) wins over it.
      const webhookSecret = await secretAtStart("ELEVENLABS_WEBHOOK_SECRET");
      if (webhookSecret === undefined) {
        savedWebhookSecret = await readSavedWebhookSecret(webhookSecretPath(context.repoRoot));
      }
      webhookConfigured = webhookSecret !== undefined || savedWebhookSecret !== undefined;
      apiKey = await secretAtStart("ELEVENLABS_API_KEY");
      ownerName = await settings.value("BOOKER_OWNER_NAME");
      // What each restart-only setting is now, so the dashboard can say when one changed.
      for (const { name } of SETTINGS.filter((setting) => setting.applies === "restart")) {
        atStart.set(name, await settings.value(name));
      }
    } catch (error) {
      const reason =
        error instanceof PrivateFileError ? error.message : describeError(error, [...knownSecrets]);
      context.stderr(`Cannot start: ${reason}`);
      return 1;
    }

    const keyPath = voiceToolsKeyPath(context.repoRoot);
    let toolsKey: string;
    let keyCreated: boolean;
    try {
      ({ key: toolsKey, created: keyCreated } = await ensureVoiceToolsKey(keyPath));
    } catch (error) {
      const reason = error instanceof VoiceToolsKeyError ? error.message : describeError(error, []);
      context.stderr(`Cannot start: ${reason}`);
      return 1;
    }
    const tokenPath = controlTokenPath(context.repoRoot);
    let controlToken: string;
    let tokenCreated: boolean;
    try {
      ({ token: controlToken, created: tokenCreated } = await ensureControlToken(tokenPath));
    } catch (error) {
      context.stderr(`Cannot start: ${describeError(error, [])}`);
      return 1;
    }
    const startupSecrets = [
      toolsKey,
      controlToken,
      ...(savedWebhookSecret === undefined ? [] : [savedWebhookSecret]),
      ...["ELEVENLABS_API_KEY", "TWILIO_AUTH_TOKEN", "ELEVENLABS_WEBHOOK_SECRET"].flatMap(
        (name) => context.env[name] ?? [],
      ),
    ];
    // Spans never carry these by construction; this catches anything that slips through.
    addSpanSecrets(...startupSecrets);
    const redact = () => [...startupSecrets, ...knownSecrets];
    const fetchOption = context.fetch === undefined ? {} : { fetch: context.fetch };
    const missingForCalls = [
      ...(apiKey === undefined ? ["ELEVENLABS_API_KEY"] : []),
      ...(ownerName === undefined ? ["BOOKER_OWNER_NAME"] : []),
      ...(webhookConfigured ? [] : ["ELEVENLABS_WEBHOOK_SECRET"]),
    ];
    // Read at each delivery; when the Keychain cannot be read, a saved secret still verifies.
    const webhookSecret = async (): Promise<string | undefined> => {
      try {
        return (await settings.value("ELEVENLABS_WEBHOOK_SECRET")) ?? savedWebhookSecret;
      } catch (error) {
        if (savedWebhookSecret !== undefined) return savedWebhookSecret;
        throw error;
      }
    };

    let server: RunningBookerServer;
    try {
      server = await startBookerServer({
        host: config.host,
        port: config.port,
        dataDir: config.dataDir,
        toolsKey,
        webhookSecret,
        redact,
        log: timestamped(context.stdout),
        logError: timestamped(context.stderr),
        ...(context.tracing === undefined ? {} : { tracing: true }),
        control: {
          token: controlToken,
          errandRoot: join(context.repoRoot, ".local"),
          voice: createVoicePortFactory({
            settings,
            webhookSecret,
            repoRoot: context.repoRoot,
            ...fetchOption,
          }),
          reconcile: { providerReportsFailure: createFailureLookup({ settings, ...fetchOption }) },
          settings: {
            resolver: settings,
            values: settingsInDatabaseFile(databasePath(context.env, context.repoRoot)),
            secrets,
            atStart,
            audit: timestamped(context.stdout),
          },
        },
      });
    } catch (error) {
      context.stderr(`Cannot start: ${describeError(error, redact())}`);
      return 1;
    }

    const shownKeyPath = shown(context.repoRoot, keyPath);
    context.stdout(`Booker is listening on ${server.url} (Ctrl+C stops it).`);
    context.stdout(
      `Database: ${shown(context.repoRoot, join(config.dataDir, DATABASE_FILE_NAME))}`,
    );
    context.stdout(
      keyCreated
        ? `Voice-tools key: generated at ${shownKeyPath}`
        : `Voice-tools key: ${shownKeyPath}`,
    );
    context.stdout(
      tokenCreated
        ? `Control token: generated at ${shown(context.repoRoot, tokenPath)}`
        : `Control token: ${shown(context.repoRoot, tokenPath)}`,
    );
    context.stdout(
      missingForCalls.length === 0
        ? "Calls: on (agents and number from .local/elevenlabs.json); stale calls are checked every minute"
        : `Calls: off until ${listed(missingForCalls)} ${missingForCalls.length === 1 ? "is" : "are"} set`,
    );
    if (!webhookConfigured) {
      context.stdout(
        "Post-call webhook: off until ELEVENLABS_WEBHOOK_SECRET is set; deliveries get 503 and are retried",
      );
    }
    const tracingLine = await describeTracing(context, settings).catch(() => undefined);
    if (tracingLine !== undefined) context.stdout(tracingLine);

    const signal = await nextShutdownSignal(context.signals);
    context.stdout(`${signal} received: shutting down (Ctrl+C again forces it).`);
    try {
      await server.close();
    } catch (error) {
      context.stderr(`Shutdown failed: ${describeError(error, redact())}`);
      return 1;
    }
    context.stdout("Stopped.");
    return 0;
  },
};
