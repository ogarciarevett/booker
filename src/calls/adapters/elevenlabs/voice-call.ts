import { z } from "zod";
import { maskPhone } from "../../../shared/phone.ts";
import type { CallPurpose } from "../../call.ts";
import type { PlaceCallInput, PlaceCallResult, VoiceCallPort } from "../../voice-call-port.ts";
import { ElevenLabsApiError, type ElevenLabsClient } from "./client.ts";

/** Long enough for Twilio's reasons; the error goes to the log and the owner's terminal. */
const MAX_REASON_LENGTH = 300;
/**
 * A phone number inside a message, in any common format: an optional `+`, then digits that may be
 * grouped with spaces, dashes, dots, or parentheses (`+1 555-555-0100`, `(555) 555-0100`). Only a
 * run with at least 7 digits counts, so short figures stay as they are.
 */
const PHONE_IN_TEXT = /\+?\(?\d[\d\s().-]{5,}\d/gu;
const MIN_PHONE_DIGITS = 7;

function maskPhones(text: string): string {
  return text.replace(PHONE_IN_TEXT, (match) =>
    match.replace(/\D/gu, "").length >= MIN_PHONE_DIGITS ? maskPhone(match) : match,
  );
}

/**
 * ElevenLabs' reason for not starting a call, as one line the owner can act on: the first line,
 * with every phone number masked to its last four digits (Twilio names the number it refused to
 * call), then shortened, so a cut can never leave part of a number unmasked.
 */
function refusalReason(message: string | null | undefined): string {
  const firstLine = message?.split(/\r\n|\r|\n/u, 1)[0]?.trim() ?? "";
  if (firstLine === "") return "no reason given";
  return maskPhones(firstLine).slice(0, MAX_REASON_LENGTH);
}

const outboundCallResponseSchema = z.object({
  success: z.boolean(),
  /** Why the call did not start, often Twilio's own reason ("Account not authorized to call"). */
  message: z.string().nullish(),
  conversation_id: z.string().nullish(),
  callSid: z.string().nullish(),
});

/** What ElevenLabs reports for a conversation (`GET /v1/convai/conversations/{id}`). */
export type ConversationStatus = "initiated" | "in-progress" | "processing" | "done" | "failed";

const conversationSchema = z.object({
  status: z.enum(["initiated", "in-progress", "processing", "done", "failed"]),
});

export interface ElevenLabsVoiceCallOptions {
  readonly client: ElevenLabsClient;
  /** The agent each call purpose runs: the quote agent never sees the commit tools. */
  readonly agentIds: Readonly<Record<CallPurpose, string>>;
  /** The imported Twilio number the agent calls from (`pnpm booker phone import`). */
  readonly agentPhoneNumberId: string;
  /** Whom the agent calls for: the `owner_name` dynamic variable its first message discloses. */
  readonly ownerName: string;
  /** Hangs up a phone leg by its Twilio CallSid (see `../twilio/hang-up.ts`). */
  readonly hangUp: (callSid: string) => Promise<void>;
  /** The CallSid stored for a conversation, if any. */
  readonly callSidFor: (externalId: string) => Promise<string | undefined>;
}

/**
 * `VoiceCallPort` over ElevenLabs Agents and its native Twilio integration. `placeCall` asks
 * ElevenLabs to dial once (never retried: a retry could dial twice) and returns its conversation
 * id as the call's `externalId`, plus Twilio's CallSid. Recording on Twilio's side is always off.
 * ElevenLabs has no hang-up endpoint, so `cancelCall` hangs the phone leg up through Twilio with
 * the stored CallSid.
 */
export class ElevenLabsVoiceCallPort implements VoiceCallPort {
  private readonly options: ElevenLabsVoiceCallOptions;

  constructor(options: ElevenLabsVoiceCallOptions) {
    if (options.ownerName.trim().length === 0) {
      throw new RangeError("ElevenLabsVoiceCallPort ownerName must not be empty");
    }
    this.options = options;
  }

  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    const response = await this.options.client.request(
      "POST",
      "/v1/convai/twilio/outbound-call",
      outboundCallResponseSchema,
      {
        body: {
          agent_id: this.options.agentIds[input.call.purpose],
          agent_phone_number_id: this.options.agentPhoneNumberId,
          to_number: input.phoneE164,
          conversation_initiation_client_data: {
            dynamic_variables: {
              call_id: input.dynamicVariables.call_id,
              call_token: input.dynamicVariables.call_token,
              owner_name: this.options.ownerName,
            },
          },
          telephony_call_config: { twilio_call_recording_enabled: false },
        },
      },
    );
    const conversationId = response.conversation_id;
    if (response.success !== true || conversationId === null || conversationId === undefined) {
      throw new ElevenLabsApiError(
        `ElevenLabs did not start the call: ${refusalReason(response.message)}`,
      );
    }
    return { externalId: conversationId, callSid: response.callSid ?? null };
  }

  async cancelCall(externalId: string): Promise<void> {
    const callSid = await this.options.callSidFor(externalId);
    if (callSid === undefined) {
      throw new Error(
        `There is no Twilio CallSid stored for conversation ${externalId}, so it cannot be hung up`,
      );
    }
    await this.options.hangUp(callSid);
  }

  /** The conversation's current status; the reconciliation sweep ends calls reported `failed`. */
  async conversationStatus(externalId: string): Promise<ConversationStatus> {
    return await conversationStatus(this.options.client, externalId);
  }
}

/** `GET /v1/convai/conversations/{id}`'s status: initiated, in-progress, processing, done, failed. */
export async function conversationStatus(
  client: ElevenLabsClient,
  externalId: string,
): Promise<ConversationStatus> {
  const conversation = await client.request(
    "GET",
    `/v1/convai/conversations/${encodeURIComponent(externalId)}`,
    conversationSchema,
  );
  return conversation.status;
}
