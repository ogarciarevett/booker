import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../proxy.ts";

describe("the dashboard proxy", () => {
  // proxy() reads the port from the live environment; pin it so a PORT set in the shell or CI
  // cannot change which Host these requests must carry.
  beforeEach(() => {
    vi.stubEnv("PORT", "3100");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers a request for another host with 421 and no data", async () => {
    const response = proxy(
      new NextRequest("http://evil.example:3100/calls/call-1", {
        headers: { Host: "evil.example:3100" },
      }),
    );

    expect(response.status).toBe(421);
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(await response.text()).toBe(
      "This dashboard only answers at http://127.0.0.1:3100 or http://localhost:3100.",
    );
  });

  it("refuses a cross-site request for the event stream with 403", () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3100/api/events", {
        headers: { Host: "127.0.0.1:3100", "Sec-Fetch-Site": "cross-site" },
      }),
    );

    expect(response.status).toBe(403);
  });

  it("passes a request for this dashboard on to the page", () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3100/calls/call-1", {
        headers: { Host: "127.0.0.1:3100" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    ["PUT", "/api/settings/BOOKER_OWNER_NAME", { "Sec-Fetch-Site": "cross-site" }],
    ["DELETE", "/api/settings/ELEVENLABS_API_KEY", { "Sec-Fetch-Site": "same-site" }],
    ["POST", "/settings", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" }],
    ["PUT", "/api/settings/BOOKER_OWNER_NAME", { Origin: "http://evil.example" }],
  ])("refuses a %s to %s from another site with 403", (method, path, headers) => {
    const response = proxy(
      new NextRequest(`http://127.0.0.1:3100${path}`, {
        method,
        headers: { Host: "127.0.0.1:3100", ...headers },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("passes a same-origin settings change on to its route", () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3100/api/settings/BOOKER_OWNER_NAME", {
        method: "PUT",
        headers: {
          Host: "127.0.0.1:3100",
          Origin: "http://127.0.0.1:3100",
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: "Example Owner 3" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
