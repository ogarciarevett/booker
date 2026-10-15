import "server-only";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ErrandDetail,
  type ErrandSummary,
  parseErrandDetail,
  parseErrandList,
} from "../errands.ts";
import type {
  BookingSummary,
  CallDetail,
  CallSummary,
  SettingsList,
  SettingView,
} from "../types.ts";

// Everything that touches the control token lives in lib/server. "server-only" makes Next.js
// fail the build if a client component ever imports it, so the token never reaches a browser.

const DEFAULT_BOOKER_URL = "http://127.0.0.1:8787";
const DEFAULT_PHOENIX_URL = "http://127.0.0.1:6006";
const REQUEST_TIMEOUT_MS = 5_000;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface DashboardSettings {
  readonly bookerUrl: string;
  readonly phoenixUrl: string;
  /** `<repo>/.local/secrets/control-token`, which `pnpm booker serve` writes on its first start. */
  readonly tokenPath: string;
}

function setting(env: Readonly<Record<string, string | undefined>>, name: string) {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Where Booker, Phoenix, and the control token are: `BOOKER_URL`, `PHOENIX_URL`, and
 * `BOOKER_REPO_ROOT`, defaulting to the local server, the local Phoenix, and the repository two
 * folders up from `cwd` (`apps/dashboard`, where `pnpm dashboard` runs Next.js).
 */
export function dashboardSettings(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): DashboardSettings {
  const repoRoot = setting(env, "BOOKER_REPO_ROOT") ?? resolve(cwd, "..", "..");
  return {
    bookerUrl: (setting(env, "BOOKER_URL") ?? DEFAULT_BOOKER_URL).replace(/\/+$/, ""),
    phoenixUrl: (setting(env, "PHOENIX_URL") ?? DEFAULT_PHOENIX_URL).replace(/\/+$/, ""),
    tokenPath: join(repoRoot, ".local", "secrets", "control-token"),
  };
}

/** Reads the token at every request, so a server started after the dashboard still works. */
export function readTokenFile(path: string): () => Promise<string | undefined> {
  return async () => {
    try {
      const token = (await readFile(path, "utf8")).trim();
      return token === "" ? undefined : token;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  };
}

/** A reason the dashboard cannot show Booker's data, written for the owner; never the token. */
export class BookerUnavailableError extends Error {
  override readonly name = "BookerUnavailableError";
}

export const NO_TOKEN = "There is no control token yet: start pnpm booker serve once.";
export const TOKEN_REFUSED =
  "Booker refused the control token: BOOKER_URL and BOOKER_REPO_ROOT must point at the same server.";

export function notRunning(bookerUrl: string): string {
  return `Booker is not running at ${bookerUrl}: start it with pnpm booker serve.`;
}

export interface BookerClientOptions {
  readonly bookerUrl: string;
  readonly readToken: () => Promise<string | undefined>;
  readonly fetch: FetchFn;
}

/** What Booker answered a settings change: the setting as it is now, or its refusal. */
export type SettingWriteResult =
  | { readonly ok: true; readonly setting?: SettingView }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly detail?: string;
    };

export interface BookerClient {
  listCalls(): Promise<CallSummary[]>;
  /** `undefined` when Booker does not know the call. */
  getCall(callId: string): Promise<CallDetail | undefined>;
  listBookings(): Promise<BookingSummary[]>;
  listErrands(): Promise<ErrandSummary[]>;
  /** `undefined` when Booker does not know the errand. */
  getErrand(errandId: string): Promise<ErrandDetail | undefined>;
  listSettings(): Promise<SettingsList>;
  saveSetting(name: string, value: string): Promise<SettingWriteResult>;
  removeSetting(name: string): Promise<SettingWriteResult>;
}

/** Reads Booker's control API, and changes settings, with the control token as a bearer token. */
export function createBookerClient(options: BookerClientOptions): BookerClient {
  async function get(path: string, init: { method?: string; body?: string } = {}) {
    const token = await options.readToken();
    if (token === undefined) throw new BookerUnavailableError(NO_TOKEN);
    let response: Response;
    try {
      response = await options.fetch(`${options.bookerUrl}${path}`, {
        ...(init.method === undefined ? {} : { method: init.method }),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BookerUnavailableError(notRunning(options.bookerUrl));
    }
    if (response.status === 401) throw new BookerUnavailableError(TOKEN_REFUSED);
    return response;
  }

  /** The body as JSON; an answer that is not JSON, or stops or times out midway, is explained. */
  async function readJson<T>(response: Response, path: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new BookerUnavailableError(
        timedOut
          ? `Booker took too long to answer ${path}: try again in a moment.`
          : `Booker's answer for ${path} could not be read: is BOOKER_URL pointing at Booker?`,
      );
    }
  }

  async function json<T>(path: string): Promise<T> {
    const response = await get(path);
    if (!response.ok) {
      throw new BookerUnavailableError(`Booker answered HTTP ${response.status} for ${path}.`);
    }
    return await readJson<T>(response, path);
  }

  /** `answer` as `parse` reads it; an answer it cannot use is explained, never shown half-read. */
  function checked<T>(path: string, answer: unknown, parse: (json: unknown) => T | undefined): T {
    const parsed = parse(answer);
    if (parsed === undefined) {
      throw new BookerUnavailableError(
        `Booker's answer for ${path} is not in the shape this dashboard expects.`,
      );
    }
    return parsed;
  }

  /** One item by path, or `undefined` when Booker answers 404. */
  async function optional<T>(path: string): Promise<T | undefined> {
    const response = await get(path);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new BookerUnavailableError(`Booker answered HTTP ${response.status} for ${path}.`);
    }
    return await readJson<T>(response, path);
  }

  /**
   * A settings change. The status decides: any 2xx is success, with the setting when Booker sent
   * one (an empty or 204 answer is still success); Booker's refusals (400, 404, 409, 503) are
   * answers with their message, and one that is not JSON keeps its real status.
   */
  async function write(method: string, name: string, body?: string): Promise<SettingWriteResult> {
    const path = `/control/settings/${encodeURIComponent(name)}`;
    const response = await get(path, { method, ...(body === undefined ? {} : { body }) });
    let answer: { readonly error?: unknown; readonly detail?: unknown } | undefined;
    try {
      const text = await response.text();
      answer = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      answer = undefined;
    }
    if (response.ok) {
      return answer === undefined || typeof answer !== "object" || answer === null
        ? { ok: true }
        : { ok: true, setting: answer as SettingView };
    }
    return {
      ok: false,
      status: response.status,
      error: typeof answer?.error === "string" ? answer.error : `http_${response.status}`,
      ...(typeof answer?.detail === "string" ? { detail: answer.detail } : {}),
    };
  }

  return {
    async listCalls() {
      return (await json<{ calls: CallSummary[] }>("/control/calls")).calls;
    },
    getCall: (callId) => optional<CallDetail>(`/control/calls/${encodeURIComponent(callId)}`),
    async listErrands() {
      return checked("/control/errands", await json<unknown>("/control/errands"), parseErrandList);
    },
    async getErrand(errandId) {
      const path = `/control/errands/${encodeURIComponent(errandId)}`;
      const answer = await optional<unknown>(path);
      return answer === undefined ? undefined : checked(path, answer, parseErrandDetail);
    },
    async listBookings() {
      return (await json<{ bookings: BookingSummary[] }>("/control/bookings")).bookings;
    },
    async listSettings() {
      return await json<SettingsList>("/control/settings");
    },
    saveSetting: (name, value) => write("PUT", name, JSON.stringify({ value })),
    removeSetting: (name) => write("DELETE", name),
  };
}

/** This process's settings and a client built from them. */
export function bookerFromEnvironment(): {
  readonly settings: DashboardSettings;
  readonly booker: BookerClient;
} {
  const settings = dashboardSettings(process.env, process.cwd());
  return {
    settings,
    booker: createBookerClient({
      bookerUrl: settings.bookerUrl,
      readToken: readTokenFile(settings.tokenPath),
      fetch: (url, init) => fetch(url, init),
    }),
  };
}
