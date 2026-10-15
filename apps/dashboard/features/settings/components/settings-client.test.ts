import { describe, expect, it } from "vitest";
import { writeSetting } from "./settings-client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("writeSetting", () => {
  it("saves through this app's own route, never Booker's", async () => {
    const sent: { url: string; init: RequestInit }[] = [];

    const result = await writeSetting(
      async (url, init) => {
        sent.push({ url, init });
        return jsonResponse({ setting: { name: "BOOKER_OWNER_NAME" } });
      },
      "BOOKER_OWNER_NAME",
      "Example Owner 3",
    );

    expect(result).toEqual({ ok: true });
    expect(sent).toEqual([
      {
        url: "/api/settings/BOOKER_OWNER_NAME",
        init: {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "Example Owner 3" }),
          cache: "no-store",
        },
      },
    ]);
  });

  it("removes with DELETE and shows the server's message when refused", async () => {
    const result = await writeSetting(
      async (_url, init) =>
        jsonResponse(
          { error: "set_in_environment", detail: `refused ${String(init.method)}` },
          409,
        ),
      "TWILIO_AUTH_TOKEN",
      null,
    );

    expect(result).toEqual({ ok: false, message: "refused DELETE" });
  });

  it("explains a failure without a message, or no answer at all", async () => {
    const empty = await writeSetting(async () => new Response("oops", { status: 500 }), "X", "1");
    const offline = await writeSetting(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      "X",
      "1",
    );

    expect(empty).toEqual({ ok: false, message: "The dashboard could not save it (HTTP 500)." });
    expect(offline).toEqual({
      ok: false,
      message: "The dashboard could not be reached. Is it still running?",
    });
  });
});
