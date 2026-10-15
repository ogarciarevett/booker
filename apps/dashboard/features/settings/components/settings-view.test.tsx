import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SettingsList, SettingView } from "@/lib/types.ts";
import { SettingsView } from "./settings-view.tsx";

// The interactive fields refresh the page through Next's router, which only exists in the app.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

function setting(overrides: Partial<SettingView> & Pick<SettingView, "name">): SettingView {
  return {
    group: "Owner",
    description: `What ${overrides.name} is for.`,
    secret: false,
    applies: "live",
    source: "unset",
    configured: false,
    editable: true,
    restartPending: false,
    ...overrides,
  };
}

/** A secret the API would never send: the view must not render it even if it did. */
const LEAKED_VALUE = "value-that-must-never-render-0001";

const fixture: SettingsList = {
  groups: ["Owner", "ElevenLabs", "Twilio", "Server"],
  settings: [
    setting({
      name: "BOOKER_OWNER_NAME",
      source: "dotenv",
      configured: true,
      editable: false,
      value: "Alex",
    }),
    setting({
      name: "ELEVENLABS_API_KEY",
      group: "ElevenLabs",
      secret: true,
      source: "store",
      configured: true,
      lastFour: "1234",
      value: LEAKED_VALUE,
    }),
    setting({
      name: "ELEVENLABS_WEBHOOK_SECRET",
      group: "ElevenLabs",
      secret: true,
      source: "environment",
      configured: true,
      editable: false,
      lastFour: "9876",
    }),
    setting({ name: "TWILIO_AUTH_TOKEN", group: "Twilio", secret: true }),
    setting({
      name: "TWILIO_PHONE_NUMBER",
      group: "Twilio",
      source: "store",
      configured: true,
      value: "+15550100100",
    }),
    setting({
      name: "BOOKER_PORT",
      group: "Server",
      applies: "restart",
      source: "store",
      configured: true,
      value: "9100",
      restartPending: true,
    }),
    setting({
      name: "BOOKER_DATA_DIR",
      group: "Server",
      applies: "restart",
      source: "unset",
      editable: false,
    }),
  ],
};

describe("SettingsView", () => {
  const html = renderToStaticMarkup(<SettingsView {...fixture} />);

  it("groups the settings under their headings, in catalog order", () => {
    const headings = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((match) => match[1]);

    expect(headings).toEqual([
      "Restart Booker to apply",
      "Owner",
      "ElevenLabs",
      "Twilio",
      "Server",
    ]);
  });

  it("labels every setting with where its value comes from", () => {
    for (const label of [
      ".env file",
      "Terminal environment",
      "Keychain",
      "Saved in dashboard",
      "Not set",
    ]) {
      expect(html).toContain(`>${label}<`);
    }
  });

  it("shows a value from .env or the environment read-only, saying where to change it", () => {
    expect(html).toContain(
      "Defined in .env (or your terminal environment); remove it there to edit it here.",
    );
    expect(html).toMatch(
      /<input[^>]*readOnly=""[^>]*value="Alex"|<input[^>]*value="Alex"[^>]*readOnly=""/,
    );
    expect(html).toContain("Configured · ends in …9876");
  });

  it("offers a saved secret as configured with its last four, to replace or remove, never its value", () => {
    expect(html).toContain("Configured · ends in …1234");
    expect(html).toContain(">Replace<");
    expect(html).toContain(">Remove<");
    expect(html).not.toContain(LEAKED_VALUE);
  });

  it("asks for an unset secret in a write-only field", () => {
    const field = html.match(/<input[^>]*id="setting-TWILIO_AUTH_TOKEN"[^>]*>/)?.[0] ?? "";

    expect(field).toContain('type="password"');
    expect(field).toContain('autoComplete="off"');
    expect(field).not.toContain("value=");
  });

  it("lets a saved plain value be edited and removed", () => {
    const field = html.match(/<input[^>]*id="setting-TWILIO_PHONE_NUMBER"[^>]*>/)?.[0] ?? "";

    expect(field).toContain('type="text"');
    expect(field).toContain('value="+15550100100"');
  });

  it("says which change waits for a restart", () => {
    expect(html).toContain("Restart Booker to apply");
    expect(html).toContain("BOOKER_PORT changed since Booker started");
    expect(html).toContain("Read from .env or the environment only.");
  });
});
