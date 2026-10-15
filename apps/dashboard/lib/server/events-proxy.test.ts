import { describe, expect, it } from "vitest";
import { createEventsProxy } from "./events-proxy.ts";

const TOKEN = "control-token-for-the-proxy-tests";

describe("createEventsProxy", () => {
  it("relays Booker's event stream to the browser, keeping the token on the server", async () => {
    const upstream: { url: string; authorization: string | null; signal: AbortSignal | null }[] =
      [];
    const proxy = createEventsProxy({
      bookerUrl: "http://127.0.0.1:8787",
      readToken: async () => TOKEN,
      fetch: async (url, init) => {
        upstream.push({
          url,
          authorization: new Headers(init.headers).get("Authorization"),
          signal: init.signal ?? null,
        });
        return new Response("event: ready\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream", "X-Upstream": "yes" },
        });
      },
    });
    const browser = new AbortController();

    const response = await proxy(
      new Request("http://127.0.0.1:3100/api/events", { signal: browser.signal }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("X-Upstream")).toBeNull();
    expect(await response.text()).toBe("event: ready\ndata: {}\n\n");
    expect(upstream[0]?.url).toBe("http://127.0.0.1:8787/control/events");
    expect(upstream[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify([...response.headers])).not.toContain(TOKEN);
    browser.abort();
    expect(upstream[0]?.signal?.aborted).toBe(true);
  });

  it("answers 503 with the reason when Booker cannot be reached", async () => {
    const proxy = createEventsProxy({
      bookerUrl: "http://127.0.0.1:8787",
      readToken: async () => TOKEN,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    const response = await proxy(new Request("http://127.0.0.1:3100/api/events"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Booker is not running at http://127.0.0.1:8787: start it with pnpm booker serve.",
    });
  });
});
