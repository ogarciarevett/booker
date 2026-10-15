import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryBookingStore,
  InMemoryCommitGrantStore,
} from "../src/bookings/adapters/in-memory.ts";
import { InMemoryCallStore } from "../src/calls/adapters/in-memory-call-store.ts";
import { InMemoryErrandStore } from "../src/calls/adapters/in-memory-errand-store.ts";
import { InMemoryOfferStore } from "../src/calls/adapters/in-memory-offer-store.ts";
import { InMemoryTranscriptStore } from "../src/calls/adapters/in-memory-transcript-store.ts";
import { InProcessActivityFeed } from "../src/calls/adapters/in-process-activity-feed.ts";
import { type ControlActivity, createControlApp } from "../src/http/control.ts";
import { InMemorySecretStore } from "../src/settings/adapters/in-memory-secret-store.ts";
import { InMemorySettingStore } from "../src/settings/adapters/in-memory-setting-store.ts";
import { UnavailableSecretStore } from "../src/settings/adapters/unavailable-secret-store.ts";
import { SETTINGS, type SettingName } from "../src/settings/catalog.ts";
import { createSettingsResolver } from "../src/settings/resolver.ts";
import type { SecretStore } from "../src/settings/secret-store.ts";

const NOW = "2026-10-08T10:00:00.000Z";

/** A fresh secret-shaped value per test, built at runtime so no literal looks like a secret. */
function randomSecret(): string {
  return randomBytes(16).toString("hex");
}

interface SettingView {
  readonly name: string;
  readonly group: string;
  readonly description: string;
  readonly secret: boolean;
  readonly applies: string;
  readonly source: string;
  readonly configured: boolean;
  readonly editable: boolean;
  readonly restartPending: boolean;
  readonly value?: string;
  readonly lastFour?: string;
}

describe("the settings control routes", () => {
  let token: string;
  let env: Record<string, string>;
  let dotenvNames: Set<string>;
  let values: InMemorySettingStore;
  let secrets: SecretStore;
  let atStart: Map<SettingName, string | undefined>;
  let audit: string[];
  let events: ControlActivity[];
  let bodies: string[];

  function app() {
    const activity = new InProcessActivityFeed<ControlActivity>();
    activity.subscribe({ onActivity: (event) => events.push(event), onClose: () => {} });
    return createControlApp({
      token,
      calls: new InMemoryCallStore(),
      errands: new InMemoryErrandStore(),
      offers: new InMemoryOfferStore(),
      transcripts: new InMemoryTranscriptStore(),
      grants: new InMemoryCommitGrantStore(),
      bookings: new InMemoryBookingStore(),
      now: () => NOW,
      errandRoot: "/nonexistent",
      voice: async () => ({ ok: false, reason: "not in these tests" }),
      activity,
      settings: {
        resolver: createSettingsResolver({ env, dotenvNames, values, secrets }),
        values,
        secrets,
        atStart,
        audit: (line) => audit.push(line),
      },
    });
  }

  async function send(
    method: string,
    path: string,
    body?: unknown,
    bearer: string | null = token,
  ): Promise<Response> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (bearer !== null) headers.set("Authorization", `Bearer ${bearer}`);
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const response = await app().request(path, init);
    bodies.push(await response.clone().text());
    return response;
  }

  async function list(): Promise<SettingView[]> {
    const response = await send("GET", "/control/settings");
    expect(response.status).toBe(200);
    return ((await response.json()) as { settings: SettingView[] }).settings;
  }

  async function view(name: string): Promise<SettingView | undefined> {
    return (await list()).find((setting) => setting.name === name);
  }

  const put = (name: string, value: unknown) => send("PUT", `/control/settings/${name}`, { value });
  const remove = (name: string) => send("DELETE", `/control/settings/${name}`);

  beforeEach(() => {
    token = randomBytes(32).toString("base64url");
    env = {};
    dotenvNames = new Set();
    values = new InMemorySettingStore();
    secrets = new InMemorySecretStore();
    atStart = new Map();
    audit = [];
    events = [];
    bodies = [];
  });

  it("answers every settings request without the right bearer token with the same 401", async () => {
    const responses = await Promise.all([
      send("GET", "/control/settings", undefined, null),
      send("GET", "/control/settings", undefined, `${token}x`),
      send("PUT", "/control/settings/BOOKER_OWNER_NAME", { value: "Example Owner 1" }, null),
      send("DELETE", "/control/settings/BOOKER_OWNER_NAME", undefined, token.slice(1)),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    expect(new Set(bodies).size).toBe(1);
    expect(await values.all()).toEqual(new Map());
  });

  it("lists every setting with its group, source, and whether it can be edited here", async () => {
    env = {
      BOOKER_OWNER_NAME: "Example Owner 1",
      BOOKER_PORT: "9100",
      BOOKER_DATA_DIR: "/srv/booker",
    };
    dotenvNames = new Set(["BOOKER_OWNER_NAME"]);
    await values.set("PUBLIC_BASE_URL", "https://public.booker.example");

    const settings = await list();

    expect(settings.map((setting) => setting.name)).toEqual(SETTINGS.map(({ name }) => name));
    expect(settings.find((setting) => setting.name === "BOOKER_OWNER_NAME")).toEqual({
      name: "BOOKER_OWNER_NAME",
      group: "Owner",
      description: expect.any(String),
      secret: false,
      applies: "live",
      source: "dotenv",
      configured: true,
      editable: false,
      restartPending: false,
      value: "Example Owner 1",
    });
    expect(settings.find((setting) => setting.name === "BOOKER_PORT")).toMatchObject({
      source: "environment",
      editable: false,
      value: "9100",
    });
    expect(settings.find((setting) => setting.name === "PUBLIC_BASE_URL")).toMatchObject({
      source: "store",
      editable: true,
      value: "https://public.booker.example",
    });
    expect(settings.find((setting) => setting.name === "TWILIO_ACCOUNT_SID")).toMatchObject({
      source: "unset",
      configured: false,
      editable: true,
    });
    expect(settings.find((setting) => setting.name === "BOOKER_DATA_DIR")).toMatchObject({
      source: "environment",
      editable: false,
    });
    expect(settings.find((setting) => setting.name === "BOOKER_HOST")).toMatchObject({
      source: "unset",
      editable: false,
    });
  });

  it("shows a secret as configured with its last four characters only, wherever it comes from", async () => {
    const fromShell = randomSecret();
    const fromKeychain = randomSecret();
    env = { TWILIO_AUTH_TOKEN: fromShell };
    await secrets.set("ELEVENLABS_API_KEY", fromKeychain);

    const settings = await list();

    expect(settings.find((setting) => setting.name === "ELEVENLABS_API_KEY")).toEqual({
      name: "ELEVENLABS_API_KEY",
      group: "ElevenLabs",
      description: expect.any(String),
      secret: true,
      applies: "live",
      source: "store",
      configured: true,
      editable: true,
      restartPending: false,
      lastFour: fromKeychain.slice(-4),
    });
    expect(settings.find((setting) => setting.name === "TWILIO_AUTH_TOKEN")).toMatchObject({
      source: "environment",
      editable: false,
      lastFour: fromShell.slice(-4),
    });
    expect(bodies.join("\n")).not.toContain(fromShell);
    expect(bodies.join("\n")).not.toContain(fromKeychain);
  });

  it("saves a plain value, trimmed, in the setting store, and reports and audits the change", async () => {
    const response = await put("BOOKER_OWNER_NAME", "  Example Owner 3  ");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "BOOKER_OWNER_NAME",
      source: "store",
      value: "Example Owner 3",
    });
    expect(await values.get("BOOKER_OWNER_NAME")).toBe("Example Owner 3");
    expect(await secrets.get("BOOKER_OWNER_NAME")).toBeUndefined();
    expect(audit).toEqual(["setting BOOKER_OWNER_NAME saved (store: sqlite)"]);
    expect(events).toEqual([
      { type: "setting", name: "BOOKER_OWNER_NAME", action: "saved", at: NOW },
    ]);
  });

  it("saves a secret in the secret store only, and never answers or logs its value", async () => {
    const secret = randomSecret();

    const response = await put("ELEVENLABS_WEBHOOK_SECRET", secret);

    expect(response.status).toBe(200);
    const body = (await response.json()) as SettingView;
    expect(body).toMatchObject({ source: "store", configured: true, lastFour: secret.slice(-4) });
    expect(body.value).toBeUndefined();
    expect(await secrets.get("ELEVENLABS_WEBHOOK_SECRET")).toBe(secret);
    expect(await values.all()).toEqual(new Map());
    expect(audit).toEqual(["setting ELEVENLABS_WEBHOOK_SECRET saved (store: keychain)"]);
    expect([...bodies, ...audit, JSON.stringify(events)].join("\n")).not.toContain(secret);
  });

  it("refuses with 409 to change a value that comes from .env or the environment", async () => {
    env = { BOOKER_OWNER_NAME: "Example Owner 1", ELEVENLABS_API_KEY: randomSecret() };
    dotenvNames = new Set(["BOOKER_OWNER_NAME"]);

    const fromDotenv = await put("BOOKER_OWNER_NAME", "Example Owner 3");
    const fromShell = await put("ELEVENLABS_API_KEY", randomSecret());
    const removal = await remove("BOOKER_OWNER_NAME");

    expect([fromDotenv.status, fromShell.status, removal.status]).toEqual([409, 409, 409]);
    expect(await fromDotenv.json()).toEqual({
      error: "set_in_environment",
      detail:
        "BOOKER_OWNER_NAME is defined in .env, which wins over the dashboard: remove it there to edit it here.",
    });
    expect(await fromShell.json()).toEqual({
      error: "set_in_environment",
      detail:
        "ELEVENLABS_API_KEY is set in the environment Booker was started with, which wins over the dashboard: unset it there and restart Booker to edit it here.",
    });
    expect(await values.all()).toEqual(new Map());
    expect(await secrets.get("ELEVENLABS_API_KEY")).toBeUndefined();
    expect(audit).toEqual([]);
  });

  it("refuses with 409 to save a setting read from the environment only", async () => {
    const response = await put("BOOKER_DATA_DIR", "/elsewhere");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "environment_only",
      detail: "BOOKER_DATA_DIR is read from .env or the environment only.",
    });
  });

  it("refuses an invalid value with 400 and the catalog's message, never echoing it", async () => {
    const responses = [
      await put("BOOKER_PORT", "eighty"),
      await put("PUBLIC_BASE_URL", "http://public.booker.example"),
      await put("BOOKER_OWNER_NAME", "   "),
      await put("BOOKER_OWNER_NAME", "line\nbreak"),
    ];

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(await responses[0]?.json()).toEqual({
      error: "invalid_value",
      detail: "BOOKER_PORT must be a whole number from 1 to 65535",
    });
    expect(bodies.join("\n")).not.toContain("eighty");
    expect(bodies.join("\n")).not.toContain("booker.example");
    expect(await values.all()).toEqual(new Map());
  });

  it("refuses a malformed request with 400 and an unknown setting with 404", async () => {
    const malformed = await send("PUT", "/control/settings/BOOKER_OWNER_NAME", "{not json");
    const noValue = await send("PUT", "/control/settings/BOOKER_OWNER_NAME", { other: 1 });
    const numeric = await put("BOOKER_OWNER_NAME", 42);
    const unknown = await put("PATH", "/usr/bin");
    const unknownRemoval = await remove("__proto__");

    expect([malformed.status, noValue.status, numeric.status]).toEqual([400, 400, 400]);
    expect(await malformed.json()).toEqual({ error: "invalid_request" });
    expect([unknown.status, unknownRemoval.status]).toEqual([404, 404]);
    expect(await unknown.json()).toEqual({ error: "unknown_setting" });
  });

  it("removes a saved value or secret, reporting and auditing only an actual removal", async () => {
    await values.set("TWILIO_PHONE_NUMBER", "+15550100100");
    await secrets.set("TWILIO_AUTH_TOKEN", randomSecret());

    const plain = await remove("TWILIO_PHONE_NUMBER");
    const secret = await remove("TWILIO_AUTH_TOKEN");
    const nothing = await remove("TWILIO_AUTH_TOKEN");

    expect([plain.status, secret.status, nothing.status]).toEqual([200, 200, 200]);
    expect(await secret.json()).toMatchObject({ source: "unset", configured: false });
    expect(await values.get("TWILIO_PHONE_NUMBER")).toBeUndefined();
    expect(await secrets.get("TWILIO_AUTH_TOKEN")).toBeUndefined();
    expect(audit).toEqual([
      "setting TWILIO_PHONE_NUMBER removed (store: sqlite)",
      "setting TWILIO_AUTH_TOKEN removed (store: keychain)",
    ]);
    expect(events.map((event) => event.type === "setting" && event.action)).toEqual([
      "removed",
      "removed",
    ]);
  });

  it("flags a restart-only setting whose value changed since Booker started", async () => {
    atStart = new Map([["BOOKER_PORT", undefined]]);

    expect((await view("BOOKER_PORT"))?.restartPending).toBe(false);
    expect((await (await put("BOOKER_PORT", "9100")).json()) as SettingView).toMatchObject({
      restartPending: true,
    });
    expect((await view("BOOKER_PORT"))?.restartPending).toBe(true);
    await remove("BOOKER_PORT");
    expect((await view("BOOKER_PORT"))?.restartPending).toBe(false);
    await put("BOOKER_OWNER_NAME", "Example Owner 3");
    expect((await view("BOOKER_OWNER_NAME"))?.restartPending).toBe(false);
  });

  it("says where to put a secret when this system has no Keychain", async () => {
    secrets = new UnavailableSecretStore();

    const response = await put("ELEVENLABS_API_KEY", randomSecret());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "secret_store_unavailable",
      detail: expect.stringContaining(".env"),
    });
  });

  it("never answers any secret value, on any route", async () => {
    const all = SETTINGS.filter((setting) => setting.secret).map((setting, index) => ({
      name: setting.name,
      value: randomSecret(),
      fromEnvironment: index % 2 === 0,
    }));
    env = Object.fromEntries(
      all.filter((secret) => secret.fromEnvironment).map(({ name, value }) => [name, value]),
    );
    for (const secret of all.filter((candidate) => !candidate.fromEnvironment)) {
      await secrets.set(secret.name, secret.value);
    }
    const replacement = randomSecret();

    await list();
    for (const { name } of all) {
      await put(name, replacement);
      await remove(name);
    }
    await list();

    const answered = [...bodies, ...audit, JSON.stringify(events)].join("\n");
    for (const { value } of all) expect(answered).not.toContain(value);
    expect(answered).not.toContain(replacement);
  });
});
