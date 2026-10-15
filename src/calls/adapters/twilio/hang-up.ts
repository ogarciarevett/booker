export const TWILIO_BASE_URL = "https://api.twilio.com";

/** The part of `fetch` the hang-up uses; injected so tests never reach the network. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const ACCOUNT_SID_PATTERN = /^AC[0-9a-f]{32}$/;
const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/;

/** A refused hang-up. The message names the CallSid and the HTTP status, never the auth token. */
export class TwilioApiError extends Error {
  override readonly name = "TwilioApiError";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface TwilioHangUpOptions {
  readonly accountSid: string;
  readonly authToken: string;
  /** Defaults to `https://api.twilio.com`; tests point it at a fake. */
  readonly baseUrl?: string;
  readonly fetch?: FetchFn;
}

/**
 * Returns a function that ends a Twilio call by its CallSid: `POST
 * /2010-04-01/Accounts/{AccountSid}/Calls/{CallSid}.json` with `Status=completed`, which Twilio
 * applies to a call that is ringing or already in progress. Both SIDs are checked against their
 * exact shape before anything is sent, so neither can bend the request path.
 */
export function createTwilioHangUp(
  options: TwilioHangUpOptions,
): (callSid: string) => Promise<void> {
  if (!ACCOUNT_SID_PATTERN.test(options.accountSid)) {
    throw new RangeError("createTwilioHangUp accountSid must be a Twilio Account SID (AC…)");
  }
  if (options.authToken.length === 0) {
    throw new RangeError("createTwilioHangUp authToken must not be empty");
  }
  const baseUrl = (options.baseUrl ?? TWILIO_BASE_URL).replace(/\/+$/, "");
  const send: FetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  const authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;

  return async (callSid) => {
    if (!CALL_SID_PATTERN.test(callSid)) {
      throw new RangeError("a Twilio CallSid must look like CA followed by 32 hex digits");
    }
    const url = `${baseUrl}/2010-04-01/Accounts/${options.accountSid}/Calls/${callSid}.json`;
    let response: Response;
    try {
      response = await send(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ Status: "completed" }).toString(),
      });
    } catch {
      throw new TwilioApiError(`Twilio could not hang up call ${callSid}: network error`);
    }
    await response.text();
    if (!response.ok) {
      throw new TwilioApiError(
        `Twilio could not hang up call ${callSid}: HTTP ${response.status}`,
        response.status,
      );
    }
  };
}
