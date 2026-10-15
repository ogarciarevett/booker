import type { z } from "zod";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

/** The part of `fetch` the client uses; injected so tests never reach the network. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type QueryValue = string | readonly string[] | undefined;

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, QueryValue>>;
}

/**
 * A failed ElevenLabs request. The message names the method, the path (never its query, which can
 * hold a phone number), the HTTP status, and ElevenLabs' own error code when it sends one; never
 * the API key, the request body, or ElevenLabs' free-text message, which can echo either.
 */
export class ElevenLabsApiError extends Error {
  override readonly name = "ElevenLabsApiError";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface ElevenLabsClientOptions {
  readonly apiKey: string;
  /** Defaults to `https://api.elevenlabs.io`; tests point it at a fake. */
  readonly baseUrl?: string;
  readonly fetch?: FetchFn;
}

const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/** ElevenLabs' machine-readable error code (`detail.status`), when it is a plain identifier. */
function errorCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("detail" in body)) return undefined;
  const detail = body.detail;
  if (typeof detail !== "object" || detail === null || !("status" in detail)) return undefined;
  return typeof detail.status === "string" && ERROR_CODE_PATTERN.test(detail.status)
    ? detail.status
    : undefined;
}

function networkErrorCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = cause.code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  }
  return "network error";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A small JSON client for the ElevenLabs API: `xi-api-key` auth, snake_case bodies as given, and
 * every answer validated with zod. It never retries anything, on purpose: retrying the
 * outbound-call request after a server error could dial the same person twice.
 */
export class ElevenLabsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchFn;

  constructor(options: ElevenLabsClientOptions) {
    if (options.apiKey.length === 0) {
      throw new RangeError("ElevenLabsClient apiKey must not be empty");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? ELEVENLABS_BASE_URL).replace(/\/+$/, "");
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async request<Schema extends z.ZodType>(
    method: HttpMethod,
    path: string,
    schema: Schema,
    options: RequestOptions = {},
  ): Promise<z.infer<Schema>> {
    const operation = `ElevenLabs ${method} ${path}`;
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      for (const item of typeof value === "string" ? [value] : value) {
        url.searchParams.append(name, item);
      }
    }

    const headers: Record<string, string> = {
      "xi-api-key": this.apiKey,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetch(url.toString(), init);
    } catch (error) {
      throw new ElevenLabsApiError(`${operation} failed: ${networkErrorCode(error)}`);
    }
    const body = parseJson(await response.text());
    if (!response.ok) {
      const code = errorCode(body);
      throw new ElevenLabsApiError(
        `${operation} answered HTTP ${response.status}${code === undefined ? "" : ` (${code})`}`,
        response.status,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ElevenLabsApiError(
        `${operation} answered with an unexpected body`,
        response.status,
      );
    }
    return parsed.data;
  }
}
