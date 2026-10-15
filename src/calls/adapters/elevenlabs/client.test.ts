import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ElevenLabsApiError, ElevenLabsClient, type FetchFn } from "./client.ts";

interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/** A fetch that records each request and answers with `respond`'s status and JSON body. */
function fakeFetch(respond: (request: SentRequest) => { status: number; body: unknown }) {
  const sent: SentRequest[] = [];
  const fetch: FetchFn = async (url, init) => {
    const request: SentRequest = {
      method: init.method ?? "GET",
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    const { status, body } = respond(request);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, sent };
}

const BASE_URL = "https://elevenlabs.test";

describe("ElevenLabsClient", () => {
  const apiKey = randomBytes(16).toString("hex");

  it("sends JSON with the xi-api-key header to the injected base URL and validates the answer", async () => {
    const { fetch, sent } = fakeFetch(() => ({ status: 200, body: { id: "tool-1", extra: 1 } }));
    const client = new ElevenLabsClient({ apiKey, baseUrl: BASE_URL, fetch });

    const result = await client.request("POST", "/v1/convai/tools", z.object({ id: z.string() }), {
      body: { tool_config: { name: "get_errand_context" } },
    });

    expect(result).toEqual({ id: "tool-1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.url).toBe(`${BASE_URL}/v1/convai/tools`);
    expect(sent[0]?.headers.get("xi-api-key")).toBe(apiKey);
    expect(sent[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(sent[0]?.body).toEqual({ tool_config: { name: "get_errand_context" } });
  });

  it("encodes query parameters, repeating an array, and skips undefined ones", async () => {
    const { fetch, sent } = fakeFetch(() => ({ status: 200, body: {} }));
    const client = new ElevenLabsClient({ apiKey, baseUrl: BASE_URL, fetch });

    await client.request("GET", "/v1/convai/tools", z.object({}), {
      query: { search: "record quote", types: ["webhook"], cursor: undefined },
    });

    expect(sent[0]?.url).toBe(`${BASE_URL}/v1/convai/tools?search=record+quote&types=webhook`);
  });

  it("reports an HTTP error with its status and ElevenLabs' error code, never the key or the message", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 401,
      body: { detail: { status: "invalid_api_key", message: `Key ${apiKey} is not valid` } },
    }));
    const client = new ElevenLabsClient({ apiKey, baseUrl: BASE_URL, fetch });

    const error = await client
      .request("GET", "/v1/convai/agents", z.object({}))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElevenLabsApiError);
    expect((error as ElevenLabsApiError).status).toBe(401);
    expect((error as Error).message).toBe(
      "ElevenLabs GET /v1/convai/agents answered HTTP 401 (invalid_api_key)",
    );
    expect(String((error as Error).message)).not.toContain(apiKey);
  });

  it("rejects an answer that does not match the expected shape, without echoing it", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: { agent: "+15550100" } }));
    const client = new ElevenLabsClient({ apiKey, baseUrl: BASE_URL, fetch });

    const error = await client
      .request("POST", "/v1/convai/agents/create", z.object({ agent_id: z.string() }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElevenLabsApiError);
    expect((error as Error).message).toBe(
      "ElevenLabs POST /v1/convai/agents/create answered with an unexpected body",
    );
  });

  it("reports a network failure by its code, never the URL's query", async () => {
    const fetch: FetchFn = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    };
    const client = new ElevenLabsClient({ apiKey, baseUrl: BASE_URL, fetch });

    const error = await client
      .request("GET", "/v1/convai/v2/phone-numbers", z.object({}), {
        query: { phone_number: "+15550100" },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ElevenLabsApiError);
    expect((error as Error).message).toBe(
      "ElevenLabs GET /v1/convai/v2/phone-numbers failed: ECONNREFUSED",
    );
  });

  it("refuses an empty API key", () => {
    expect(() => new ElevenLabsClient({ apiKey: "", baseUrl: BASE_URL })).toThrow(RangeError);
  });
});
