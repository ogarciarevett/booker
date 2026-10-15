import { describe, expect, it } from "vitest";
import { BookerUnavailableError, type SettingWriteResult } from "@/lib/server/booker.ts";
import type { SettingView } from "@/lib/types.ts";
import { createSettingsWriteHandler } from "./settings-route.ts";

const SAVED: SettingView = {
  name: "BOOKER_OWNER_NAME",
  group: "Owner",
  description: "Whom the agent says it calls for.",
  secret: false,
  applies: "live",
  source: "store",
  configured: true,
  editable: true,
  restartPending: false,
  value: "Example Owner 3",
};

function jsonRequest(body: unknown, contentType = "application/json"): Request {
  return new Request("http://127.0.0.1:3100/api/settings/BOOKER_OWNER_NAME", {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function setup(
  answer: () => Promise<SettingWriteResult> = async () => ({ ok: true, setting: SAVED }),
) {
  const forwarded: { method: string; name: string; value?: string }[] = [];
  const handle = createSettingsWriteHandler({
    saveSetting: async (name, value) => {
      forwarded.push({ method: "PUT", name, value });
      return await answer();
    },
    removeSetting: async (name) => {
      forwarded.push({ method: "DELETE", name });
      return await answer();
    },
  });
  return { handle, forwarded };
}

describe("the settings write route", () => {
  it("forwards a value to Booker and answers the setting it saved", async () => {
    const { handle, forwarded } = setup();

    const response = await handle(
      "PUT",
      "BOOKER_OWNER_NAME",
      jsonRequest({ value: "Example Owner 3" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ setting: SAVED });
    expect(forwarded).toEqual([
      { method: "PUT", name: "BOOKER_OWNER_NAME", value: "Example Owner 3" },
    ]);
  });

  it("forwards a removal without a body", async () => {
    const { handle, forwarded } = setup();

    const response = await handle(
      "DELETE",
      "TWILIO_AUTH_TOKEN",
      new Request("http://127.0.0.1:3100/api/settings/TWILIO_AUTH_TOKEN", { method: "DELETE" }),
    );

    expect(response.status).toBe(200);
    expect(forwarded).toEqual([{ method: "DELETE", name: "TWILIO_AUTH_TOKEN" }]);
  });

  it("passes Booker's refusal on with its status and message", async () => {
    const { handle } = setup(async () => ({
      ok: false,
      status: 409,
      error: "set_in_environment",
      detail: "BOOKER_OWNER_NAME is defined in .env, which wins over the dashboard.",
    }));

    const response = await handle(
      "PUT",
      "BOOKER_OWNER_NAME",
      jsonRequest({ value: "Example Owner 3" }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "set_in_environment",
      detail: "BOOKER_OWNER_NAME is defined in .env, which wins over the dashboard.",
    });
  });

  it("says Booker is unavailable instead of failing", async () => {
    const { handle } = setup(async () => {
      throw new BookerUnavailableError("Booker is not running at http://127.0.0.1:8787.");
    });

    const response = await handle(
      "PUT",
      "BOOKER_OWNER_NAME",
      jsonRequest({ value: "Example Owner 3" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "booker_unavailable",
      detail: "Booker is not running at http://127.0.0.1:8787.",
    });
  });

  it("refuses what it cannot forward, never echoing the submitted value", async () => {
    const { handle, forwarded } = setup();
    const secret = "submitted-value-that-must-not-echo";

    const responses = await Promise.all([
      handle("PUT", "lower_case", jsonRequest({ value: secret })),
      handle(
        "PUT",
        "BOOKER_OWNER_NAME",
        jsonRequest(`value=${secret}`, "application/x-www-form-urlencoded"),
      ),
      handle("PUT", "BOOKER_OWNER_NAME", jsonRequest(`{"value": "${secret}"`)),
      handle("PUT", "BOOKER_OWNER_NAME", jsonRequest({ value: 42 })),
      handle("PUT", "BOOKER_OWNER_NAME", jsonRequest({ value: "x".repeat(20_000) })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 415, 400, 400, 413]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(bodies.join("\n")).not.toContain(secret);
    expect(forwarded).toEqual([]);
  });
});
