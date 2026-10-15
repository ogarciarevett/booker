import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DEFAULT_PORT, LOOPBACK_HOST } from "../server/config.ts";
import { controlTokenPath, readControlToken } from "../server/control-token.ts";
import { describeError } from "../server/logging.ts";
import { E164_PATTERN, isPort } from "../settings/catalog.ts";
import type { CliContext } from "./context.ts";
import { type Command, USAGE_EXIT_CODE } from "./router.ts";
import { settingsFailure, settingsFor } from "./settings.ts";

const USAGE = "Usage: pnpm booker call --to <E.164> --errand <file> [--wait]";
const POLL_INTERVAL_MS = 3_000;
/** Longer than any call can last (10 minutes) plus the webhook's first retries. */
const WAIT_LIMIT_MS = 20 * 60 * 1_000;
const OPEN_STATUSES = new Set(["scheduled", "in_progress"]);

/** What each refusal from the server means for the owner. */
const REFUSALS: Readonly<Record<string, string>> = {
  provider_not_in_brief: "--to is not the phone number of any provider in the errand file",
  provider_not_callable:
    "that provider has a call still open, or already had as many attempts as allowed",
  errand_file_not_found: "the errand file does not exist",
  errand_file_outside_local: "the errand file must be inside .local/ (for example .local/errands/)",
  invalid_errand: "the errand file is not a valid errand brief",
  invalid_request: "the server refused the request",
  unauthorized:
    "the server refused the control token; restart pnpm booker serve if the token file changed",
};

const placedSchema = z.object({ callId: z.string(), conversationId: z.string() });
const refusalSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
  issues: z.array(z.string()).optional(),
});
const statusSchema = z.object({
  callId: z.string(),
  status: z.string(),
  conversationId: z.string().nullable(),
  recorded: z.array(z.object({ field: z.string(), status: z.string(), value: z.unknown() })),
  unknown: z.array(z.string()),
});

interface CallArguments {
  readonly to: string;
  readonly errand: string;
  readonly wait: boolean;
}

function parseArguments(args: readonly string[]): CallArguments | undefined {
  let to: string | undefined;
  let errand: string | undefined;
  let wait = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--wait") wait = true;
    else if (arg === "--to") to = args[++index];
    else if (arg === "--errand") errand = args[++index];
    else return undefined;
  }
  if (to === undefined || errand === undefined || !E164_PATTERN.test(to)) return undefined;
  return { to, errand, wait };
}

const moneySchema = z.object({ amountCents: z.number().int(), currency: z.string() });
const dateRangeSchema = z.object({ start: z.string(), end: z.string() });

/** A recorded value as the owner reads it: money as `150.00 EUR`, dates as `a to b`. */
function shownValue(value: unknown): string {
  const money = moneySchema.safeParse(value);
  if (money.success) {
    const amount = `${(money.data.amountCents / 100).toFixed(2)} ${money.data.currency}`;
    const extra = Object.entries(value as object)
      .filter(([key]) => key !== "amountCents" && key !== "currency")
      .map(([, part]) => String(part));
    return extra.length === 0 ? amount : `${amount} (${extra.join(", ")})`;
  }
  const range = dateRangeSchema.safeParse(value);
  if (range.success) return `${range.data.start} to ${range.data.end}`;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The local server, on `BOOKER_PORT` from the environment or the dashboard, else 8787. */
async function serverUrl(context: CliContext): Promise<string> {
  const port = await settingsFor(context).value("BOOKER_PORT");
  return `http://${LOOPBACK_HOST}:${port !== undefined && isPort(port) ? port : DEFAULT_PORT}`;
}

/**
 * `pnpm booker call --to <E.164> --errand <file> [--wait]`: asks the running server to place one
 * quote call (the server writes the database, so this command never opens it) and prints the
 * call's ids. With `--wait` it then polls the call until it ends and prints what was recorded,
 * known or estimated, and what is still unknown.
 */
export const callCommand: Command<CliContext> = {
  name: "call",
  summary: "Places a quote call through the running server (--wait follows it)",
  async run(args, context) {
    const parsed = parseArguments(args);
    if (parsed === undefined) {
      context.stderr(USAGE);
      context.stderr(
        "  --to must be in E.164 (for example +15550100100), and the errand file a brief.",
      );
      return USAGE_EXIT_CODE;
    }

    let token: string | undefined;
    try {
      token = await readControlToken(controlTokenPath(context.repoRoot));
    } catch (error) {
      context.stderr(`Cannot call: ${describeError(error, [])}`);
      return 1;
    }
    if (token === undefined) {
      context.stderr(
        "Cannot call: there is no control token yet. Start the server once with pnpm booker serve.",
      );
      return 1;
    }

    let base: string;
    try {
      base = await serverUrl(context);
    } catch (error) {
      context.stderr(`Cannot call: ${settingsFailure(error)}`);
      return 1;
    }
    const send = context.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
    const sleep = context.sleep ?? ((ms: number) => delay(ms));
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const request = async (path: string, init: RequestInit): Promise<Response | undefined> => {
      try {
        return await send(`${base}${path}`, { ...init, headers });
      } catch {
        context.stderr(
          `Cannot call: the Booker server is not running on ${base}. Start it with pnpm booker serve, then try again.`,
        );
        return undefined;
      }
    };

    const response = await request("/control/calls", {
      method: "POST",
      body: JSON.stringify({
        to: parsed.to,
        errandFile: resolve(context.repoRoot, parsed.errand),
        purpose: "quote",
      }),
    });
    if (response === undefined) return 1;
    const body: unknown = await response.json().catch(() => undefined);
    if (response.status !== 201) {
      const refusal = refusalSchema.safeParse(body);
      const code = refusal.success ? refusal.data.error : `HTTP ${response.status}`;
      const detail = refusal.success ? refusal.data.detail : undefined;
      context.stderr(`Cannot call: ${detail ?? REFUSALS[code] ?? code}.`);
      for (const issue of refusal.success ? (refusal.data.issues ?? []) : []) {
        context.stderr(`  - ${issue}`);
      }
      return 1;
    }
    const placed = placedSchema.parse(body);
    context.stdout(`Placed call ${placed.callId} (conversation ${placed.conversationId}).`);
    if (!parsed.wait) return 0;

    context.stdout("Waiting for the call to end (Ctrl+C stops waiting, not the call)...");
    const deadline = Date.now() + WAIT_LIMIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const polled = await request(`/control/calls/${encodeURIComponent(placed.callId)}`, {
        method: "GET",
      });
      if (polled === undefined) return 1;
      const status = statusSchema.safeParse(await polled.json().catch(() => undefined));
      if (!polled.ok || !status.success) {
        context.stderr(`Cannot follow the call: the server answered HTTP ${polled.status}.`);
        return 1;
      }
      if (OPEN_STATUSES.has(status.data.status)) continue;

      context.stdout(`Call ${placed.callId} ended: ${status.data.status}.`);
      if (status.data.recorded.length === 0) {
        context.stdout("Nothing was recorded.");
      } else {
        context.stdout("Recorded:");
        const width = Math.max(...status.data.recorded.map(({ field }) => field.length));
        for (const { field, status: fieldStatus, value } of status.data.recorded) {
          context.stdout(
            `  ${field.padEnd(width)}  ${fieldStatus.padEnd(9)}  ${shownValue(value)}`,
          );
        }
      }
      if (status.data.unknown.length > 0) {
        context.stdout(`Still unknown: ${status.data.unknown.join(", ")}`);
      }
      return 0;
    }
    context.stderr(
      `Stopped waiting after ${WAIT_LIMIT_MS / 60_000} minutes; the call is still open.`,
    );
    return 1;
  },
};
