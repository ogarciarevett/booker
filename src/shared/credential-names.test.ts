import { describe, expect, it } from "vitest";
import { isCredentialName } from "./credential-names.ts";

describe("isCredentialName", () => {
  it("matches *_KEY, *_TOKEN, *_SECRET, and *_PASSWORD names, and those words alone", () => {
    for (const name of [
      "ELEVENLABS_API_KEY",
      "TWILIO_AUTH_TOKEN",
      "ELEVENLABS_WEBHOOK_SECRET",
      "DB_PASSWORD",
      "GITHUB_TOKEN",
      "TOKEN",
      "SECRET_KEY_BASE",
    ]) {
      expect(isCredentialName(name), name).toBe(true);
    }
  });

  it("leaves identifiers and words that merely contain those letters alone", () => {
    for (const name of ["TWILIO_ACCOUNT_SID", "BOOKER_PORT", "KEYBOARD_LAYOUT", "MONKEY", "PATH"]) {
      expect(isCredentialName(name), name).toBe(false);
    }
  });
});
