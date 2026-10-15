import { describe, expect, it } from "vitest";
import { drivingSchoolDetail } from "@/features/errands/components/fixtures.ts";
import { BookerUnavailableError, createBookerClient, dashboardSettings } from "./booker.ts";

const TOKEN = "control-token-for-the-dashboard-tests";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("dashboardSettings", () => {
  it("defaults to the local Booker and Phoenix, and the token file under the repository", () => {
    expect(dashboardSettings({}, "/work/booker/apps/dashboard")).toEqual({
      bookerUrl: "http://127.0.0.1:8787",
      phoenixUrl: "http://127.0.0.1:6006",
      tokenPath: "/work/booker/.local/secrets/control-token",
    });
  });

  it("takes BOOKER_URL, PHOENIX_URL, and BOOKER_REPO_ROOT from the environment", () => {
    expect(
      dashboardSettings(
        {
          BOOKER_URL: "http://127.0.0.1:8799/",
          PHOENIX_URL: "http://127.0.0.1:6007/",
          BOOKER_REPO_ROOT: "/elsewhere/booker",
        },
        "/work/booker/apps/dashboard",
      ),
    ).toEqual({
      bookerUrl: "http://127.0.0.1:8799",
      phoenixUrl: "http://127.0.0.1:6007",
      tokenPath: "/elsewhere/booker/.local/secrets/control-token",
    });
  });
});

describe("createBookerClient", () => {
  function client(fetch: (url: string, init: RequestInit) => Promise<Response>) {
    const requests: { url: string; authorization: string | null }[] = [];
    const booker = createBookerClient({
      bookerUrl: "http://127.0.0.1:8787",
      readToken: async () => TOKEN,
      fetch: async (url, init) => {
        requests.push({ url, authorization: new Headers(init.headers).get("Authorization") });
        return await fetch(url, init);
      },
    });
    return { booker, requests };
  }

  it("reads calls, one call, and bookings from the control API with the bearer token", async () => {
    const { booker, requests } = client(async (url) => {
      if (url.endsWith("/control/calls")) return jsonResponse({ calls: [{ callId: "call-1" }] });
      if (url.endsWith("/control/calls/call-1")) return jsonResponse({ callId: "call-1" });
      if (url.endsWith("/control/bookings")) return jsonResponse({ bookings: [] });
      return jsonResponse({ error: "not_found" }, 404);
    });

    expect(await booker.listCalls()).toEqual([{ callId: "call-1" }]);
    expect(await booker.getCall("call-1")).toEqual({ callId: "call-1" });
    expect(await booker.getCall("call/../x")).toBeUndefined();
    expect(await booker.listBookings()).toEqual([]);
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:8787/control/calls",
      "http://127.0.0.1:8787/control/calls/call-1",
      "http://127.0.0.1:8787/control/calls/call%2F..%2Fx",
      "http://127.0.0.1:8787/control/bookings",
    ]);
    expect(new Set(requests.map((request) => request.authorization))).toEqual(
      new Set([`Bearer ${TOKEN}`]),
    );
  });

  it("explains a server that is not running, without the token", async () => {
    const { booker } = client(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });

    const error = await booker.listCalls().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BookerUnavailableError);
    expect((error as Error).message).toBe(
      "Booker is not running at http://127.0.0.1:8787: start it with pnpm booker serve.",
    );
  });

  it("explains an answer it cannot read: not JSON, or cut off or timed out mid-body", async () => {
    const notJson = client(async () => new Response("<html>a proxy page</html>")).booker;
    const brokenBody = client(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"calls": ['));
              controller.error(new DOMException("The operation timed out.", "TimeoutError"));
            },
          }),
        ),
    ).booker;

    const errors = await Promise.all([
      notJson.listCalls().catch((caught: unknown) => caught),
      notJson.getCall("call-1").catch((caught: unknown) => caught),
      notJson.listBookings().catch((caught: unknown) => caught),
      brokenBody.listCalls().catch((caught: unknown) => caught),
      brokenBody.getCall("call-1").catch((caught: unknown) => caught),
    ]);

    for (const error of errors) expect(error).toBeInstanceOf(BookerUnavailableError);
    expect((errors[0] as Error).message).toBe(
      "Booker's answer for /control/calls could not be read: is BOOKER_URL pointing at Booker?",
    );
    expect((errors[3] as Error).message).toBe(
      "Booker took too long to answer /control/calls: try again in a moment.",
    );
  });

  it("explains a missing control token and a refused one, without the token", async () => {
    const missing = createBookerClient({
      bookerUrl: "http://127.0.0.1:8787",
      readToken: async () => undefined,
      fetch: async () => jsonResponse({}),
    });
    const refused = client(async () => jsonResponse({ error: "unauthorized" }, 401)).booker;

    const errors = await Promise.all([
      missing.listCalls().catch((caught: unknown) => caught),
      refused.listCalls().catch((caught: unknown) => caught),
    ]);

    expect(errors.map((error) => (error as Error).message)).toEqual([
      "There is no control token yet: start pnpm booker serve once.",
      "Booker refused the control token: BOOKER_URL and BOOKER_REPO_ROOT must point at the same server.",
    ]);
    for (const error of errors) expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("lists settings and saves and removes one, passing Booker's refusals on as they are", async () => {
    const calls: { method: string; url: string; body: string | null }[] = [];
    const { booker, requests } = client(async (url, init) => {
      calls.push({ method: init.method ?? "GET", url, body: (init.body as string) ?? null });
      if (init.method === "PUT") {
        return jsonResponse(
          { error: "set_in_environment", detail: "BOOKER_OWNER_NAME is defined in .env, ..." },
          409,
        );
      }
      if (init.method === "DELETE") return jsonResponse({ name: "TWILIO_PHONE_NUMBER" });
      return jsonResponse({ groups: ["Owner"], settings: [] });
    });

    expect(await booker.listSettings()).toEqual({ groups: ["Owner"], settings: [] });
    expect(await booker.saveSetting("BOOKER_OWNER_NAME", "Example Owner 3")).toEqual({
      ok: false,
      status: 409,
      error: "set_in_environment",
      detail: "BOOKER_OWNER_NAME is defined in .env, ...",
    });
    expect(await booker.removeSetting("TWILIO_PHONE_NUMBER")).toEqual({
      ok: true,
      setting: { name: "TWILIO_PHONE_NUMBER" },
    });
    expect(calls).toEqual([
      { method: "GET", url: "http://127.0.0.1:8787/control/settings", body: null },
      {
        method: "PUT",
        url: "http://127.0.0.1:8787/control/settings/BOOKER_OWNER_NAME",
        body: JSON.stringify({ value: "Example Owner 3" }),
      },
      {
        method: "DELETE",
        url: "http://127.0.0.1:8787/control/settings/TWILIO_PHONE_NUMBER",
        body: null,
      },
    ]);
    expect(new Set(requests.map((request) => request.authorization))).toEqual(
      new Set([`Bearer ${TOKEN}`]),
    );
  });

  it("reads errands and one errand, answering undefined for one Booker does not know", async () => {
    const errand = { ...drivingSchoolDetail, errandId: "e-1" };
    const { booker, requests } = client(async (url) => {
      if (url.endsWith("/control/errands")) return jsonResponse({ errands: [errand] });
      if (url.endsWith("/control/errands/e-1")) return jsonResponse(errand);
      return jsonResponse({ error: "not_found" }, 404);
    });

    expect((await booker.listErrands()).map((summary) => summary.errandId)).toEqual(["e-1"]);
    expect(await booker.getErrand("e-1")).toEqual(errand);
    expect(await booker.getErrand("e/2")).toBeUndefined();
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:8787/control/errands",
      "http://127.0.0.1:8787/control/errands/e-1",
      "http://127.0.0.1:8787/control/errands/e%2F2",
    ]);
  });

  it("takes an empty or 204 answer to a change as success, and keeps the status of one it cannot read", async () => {
    const answers = [
      new Response(null, { status: 204 }),
      new Response("", { status: 200 }),
      new Response("<html>Bad gateway</html>", { status: 502 }),
    ];
    const { booker } = client(async () => answers.shift() ?? jsonResponse({}, 500));

    expect(await booker.removeSetting("TWILIO_PHONE_NUMBER")).toEqual({ ok: true });
    expect(await booker.saveSetting("BOOKER_OWNER_NAME", "Example Owner 3")).toEqual({ ok: true });
    expect(await booker.saveSetting("BOOKER_OWNER_NAME", "Example Owner 3")).toEqual({
      ok: false,
      status: 502,
      error: "http_502",
    });
  });

  it("checks errand answers: an unknown stage reads as unknown, a malformed answer is explained", async () => {
    const { booker } = client(async (url) =>
      url.endsWith("/control/errands")
        ? jsonResponse({ errands: [{ ...drivingSchoolDetail, stage: "archived" }] })
        : jsonResponse({ errandId: 7 }),
    );

    expect((await booker.listErrands())[0]?.stage).toBe("unknown");
    await expect(booker.getErrand("e-1")).rejects.toThrow(
      "Booker's answer for /control/errands/e-1 is not in the shape this dashboard expects.",
    );
  });
});
