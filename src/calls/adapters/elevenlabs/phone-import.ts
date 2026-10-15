import { z } from "zod";
import type { ElevenLabsClient } from "./client.ts";

export const PHONE_NUMBER_LABEL = "Booker";

const phoneNumbersPageSchema = z.object({
  phone_numbers: z.array(z.object({ phone_number: z.string(), phone_number_id: z.string() })),
});
const importedSchema = z.object({ phone_number_id: z.string() });

export interface ImportTwilioNumberInput {
  readonly client: ElevenLabsClient;
  /** The Twilio number in E.164. */
  readonly phoneNumber: string;
  /** The Twilio Account SID (`AC…`); with it, `authToken` is the account's Auth Token. */
  readonly accountSid: string;
  readonly authToken: string;
}

/**
 * Makes ElevenLabs know the Twilio number the agents call from: reuses the number when
 * ElevenLabs already has it (looked up by number, so running again never imports it twice), and
 * otherwise imports it with SMS off. Returns its `phone_number_id`, which every outbound call
 * names.
 */
export async function importTwilioNumber(
  input: ImportTwilioNumberInput,
): Promise<{ readonly phoneNumberId: string; readonly created: boolean }> {
  const existing = await input.client.request(
    "GET",
    "/v1/convai/v2/phone-numbers",
    phoneNumbersPageSchema,
    { query: { phone_number: input.phoneNumber, provider: "twilio" } },
  );
  const match = existing.phone_numbers.find((number) => number.phone_number === input.phoneNumber);
  if (match !== undefined) return { phoneNumberId: match.phone_number_id, created: false };

  const imported = await input.client.request("POST", "/v1/convai/phone-numbers", importedSchema, {
    body: {
      provider: "twilio",
      label: PHONE_NUMBER_LABEL,
      phone_number: input.phoneNumber,
      sid: input.accountSid,
      token: input.authToken,
      enable_sms: false,
    },
  });
  return { phoneNumberId: imported.phone_number_id, created: true };
}
