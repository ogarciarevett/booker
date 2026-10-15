import { describe, expect, it } from "vitest";
import {
  isSettingName,
  SETTING_GROUPS,
  SETTINGS,
  settingDefinition,
  TRACING_SETTINGS,
  validateSetting,
} from "./catalog.ts";

const SECRETS = [
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_WEBHOOK_SECRET",
  "TWILIO_AUTH_TOKEN",
  "TYPESAFE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
];

describe("settings catalog", () => {
  it("lists every variable Booker reads, each once, in a known group", () => {
    const names = SETTINGS.map((setting) => setting.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        ...SECRETS,
        "BOOKER_OWNER_NAME",
        "PUBLIC_BASE_URL",
        "ELEVENLABS_VOICE_ID",
        "TWILIO_ACCOUNT_SID",
        "TWILIO_PHONE_NUMBER",
        "TYPESAFE_BASE_URL",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_SERVICE_NAME",
        "OTEL_SDK_DISABLED",
        "BOOKER_PORT",
        "BOOKER_HOST",
        "BOOKER_DATA_DIR",
      ]),
    );
    for (const setting of SETTINGS) {
      expect(SETTING_GROUPS).toContain(setting.group);
      expect(setting.description.length).toBeGreaterThan(20);
    }
  });

  it("marks exactly the credentials as secret", () => {
    expect(
      SETTINGS.filter((setting) => setting.secret)
        .map((setting) => setting.name)
        .sort(),
    ).toEqual([...SECRETS].sort());
  });

  it("keeps the data directory and the host in the environment only", () => {
    expect(SETTINGS.filter((setting) => setting.envOnly).map((setting) => setting.name)).toEqual([
      "BOOKER_HOST",
      "BOOKER_DATA_DIR",
    ]);
  });

  it("says which settings apply only after a restart", () => {
    expect(
      SETTINGS.filter((setting) => setting.applies === "restart").map((setting) => setting.name),
    ).toEqual([
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_SERVICE_NAME",
      "OTEL_SDK_DISABLED",
      "BOOKER_PORT",
      "BOOKER_HOST",
      "BOOKER_DATA_DIR",
    ]);
  });

  it("names the tracing settings once, from the Tracing group", () => {
    expect(TRACING_SETTINGS).toEqual([
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_SERVICE_NAME",
      "OTEL_SDK_DISABLED",
    ]);
  });

  it("knows its names and nothing else", () => {
    expect(isSettingName("BOOKER_PORT")).toBe(true);
    expect(isSettingName("PATH")).toBe(false);
    expect(isSettingName("__proto__")).toBe(false);
    expect(settingDefinition("TWILIO_AUTH_TOKEN")).toMatchObject({ group: "Twilio", secret: true });
  });

  it("offers a live, non-secret agent script setting", () => {
    expect(settingDefinition("BOOKER_AGENT_SCRIPT")).toMatchObject({
      group: "ElevenLabs",
      secret: false,
      applies: "live",
      envOnly: false,
    });
  });

  it.each([
    ["BOOKER_PORT", "9100"],
    ["BOOKER_HOST", "127.0.0.1"],
    ["PUBLIC_BASE_URL", "https://public.booker.example"],
    ["TWILIO_ACCOUNT_SID", `AC${"0a".repeat(16)}`],
    ["TWILIO_PHONE_NUMBER", "+15550100100"],
    ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://127.0.0.1:6006/v1/traces"],
    ["OTEL_SDK_DISABLED", "TRUE"],
    ["TYPESAFE_BASE_URL", "http://127.0.0.1:4010"],
    ["BOOKER_OWNER_NAME", "Example Owner 2"],
    ["BOOKER_AGENT_SCRIPT", "locales/en-US/roleplay-gpu.yaml"],
  ] as const)("accepts %s=%s", (name, value) => {
    expect(validateSetting(name, value)).toEqual({ ok: true, value });
  });

  it.each([
    ["BOOKER_PORT", "0"],
    ["BOOKER_PORT", "65536"],
    ["BOOKER_PORT", "eighty"],
    ["BOOKER_HOST", "0.0.0.0"],
    ["PUBLIC_BASE_URL", "http://public.booker.example"],
    ["TWILIO_ACCOUNT_SID", "AC123"],
    ["TWILIO_PHONE_NUMBER", "555 0100"],
    ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "phoenix:6006"],
    ["OTEL_SDK_DISABLED", "yes"],
    ["BOOKER_OWNER_NAME", ""],
    ["BOOKER_AGENT_SCRIPT", "/private/agent.yaml"],
    ["BOOKER_AGENT_SCRIPT", "../agent.yaml"],
    ["BOOKER_AGENT_SCRIPT", "locales/../../agent.yaml"],
    ["BOOKER_AGENT_SCRIPT", "C:\\private\\agent.yaml"],
    ["BOOKER_AGENT_SCRIPT", "locales/agent\u0000.yaml"],
  ] as const)("refuses %s=%j with a fixed message that never quotes the value", (name, value) => {
    const result = validateSetting(name, value);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issue).toContain(name);
    if (value.length > 0) expect(result.issue).not.toContain(value);
  });
});
