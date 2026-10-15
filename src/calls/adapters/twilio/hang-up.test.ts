import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTwilioHangUp, type FetchFn, TwilioApiError } from "./hang-up.ts";

const BASE_URL = "https://twilio.test";

function sid(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

function fakeFetch(status: number) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetch: FetchFn = async (url, init) => {
    sent.push({ url, init });
    return new Response("{}", { status });
  };
  return { fetch, sent };
}

describe("createTwilioHangUp", () => {
  const accountSid = sid("AC");
  const authToken = randomBytes(16).toString("hex");

  it("ends the call by setting its status to completed, with basic auth", async () => {
    const { fetch, sent } = fakeFetch(200);
    const callSid = sid("CA");

    await createTwilioHangUp({ accountSid, authToken, baseUrl: BASE_URL, fetch })(callSid);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(
      `${BASE_URL}/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
    );
    expect(sent[0]?.init.method).toBe("POST");
    const headers = new Headers(sent[0]?.init.headers);
    expect(headers.get("Authorization")).toBe(
      `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
    );
    expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(String(sent[0]?.init.body)).toBe("Status=completed");
  });

  it("reports a refused hang-up by status, never with the token", async () => {
    const { fetch } = fakeFetch(404);
    const callSid = sid("CA");

    const error = await createTwilioHangUp({ accountSid, authToken, baseUrl: BASE_URL, fetch })(
      callSid,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TwilioApiError);
    expect((error as Error).message).toBe(`Twilio could not hang up call ${callSid}: HTTP 404`);
    expect((error as Error).message).not.toContain(authToken);
  });

  it("refuses a CallSid or Account SID that is not one, before sending anything", async () => {
    const { fetch, sent } = fakeFetch(200);

    await expect(
      createTwilioHangUp({ accountSid, authToken, baseUrl: BASE_URL, fetch })("CA/../../x"),
    ).rejects.toThrow(RangeError);
    expect(() =>
      createTwilioHangUp({ accountSid: "not-a-sid", authToken, baseUrl: BASE_URL, fetch }),
    ).toThrow(RangeError);
    expect(sent).toEqual([]);
  });
});
