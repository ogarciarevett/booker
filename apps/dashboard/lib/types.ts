// The shapes of Booker's read-only control API (docs/observability.md#read-only-data-api).
// No token, token hash, or full phone number is ever part of them.

export type CallStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "failed"
  | "no_answer"
  | "cancelled";

export interface CallSummary {
  readonly callId: string;
  readonly errandId: string;
  readonly providerId: string;
  readonly providerName: string | null;
  /** All but the last four digits hidden, such as `+*******0100`. */
  readonly providerPhone: string | null;
  readonly purpose: "quote" | "commit";
  readonly status: CallStatus;
  readonly attempt: number;
  readonly createdAt: string;
  readonly endedAt: string | null;
  readonly hasConversation: boolean;
}

export interface RecordedField {
  readonly field: string;
  readonly status: "known" | "estimated";
  readonly value: unknown;
  readonly quote: string;
  readonly capturedAt: string;
}

export interface TranscriptTurn {
  readonly role: "agent" | "user";
  readonly message: string;
  readonly secondsIntoCall: number;
}

export interface BookingHistoryEntry {
  readonly status: string;
  readonly at: string;
}

export interface CallDetail extends CallSummary {
  readonly conversationId: string | null;
  readonly recorded: readonly RecordedField[];
  readonly unknown: readonly string[];
  readonly transcript: {
    readonly receivedAt: string;
    readonly turns: readonly TranscriptTurn[];
  } | null;
  readonly grant: { readonly status: "active"; readonly expiresAt: string } | null;
  readonly booking: {
    readonly id: string;
    readonly providerId: string;
    readonly status: string;
    readonly history: readonly BookingHistoryEntry[];
  } | null;
}

export interface BookingSummary {
  readonly id: string;
  readonly errandId: string;
  readonly offerId: string;
  readonly providerId: string;
  readonly providerName: string | null;
  readonly participantIds: readonly string[];
  readonly status: string;
  readonly history: readonly BookingHistoryEntry[];
}

/** Where the "View trace in Phoenix" link points, if anywhere. */
export type PhoenixLink =
  | { readonly kind: "session"; readonly url: string }
  | { readonly kind: "missing"; readonly phoenixUrl: string }
  | { readonly kind: "unreachable"; readonly phoenixUrl: string };

/** Where a setting's value in effect comes from (docs/settings.md). */
export type SettingSource = "dotenv" | "environment" | "store" | "unset";

/** One setting as `GET /control/settings` shows it: never a secret's value. */
export interface SettingView {
  readonly name: string;
  readonly group: string;
  readonly description: string;
  readonly secret: boolean;
  readonly applies: "live" | "restart";
  readonly source: SettingSource;
  readonly configured: boolean;
  /** False for a value from `.env` or the environment, and for environment-only settings. */
  readonly editable: boolean;
  readonly restartPending: boolean;
  /** Plain settings only. */
  readonly value?: string;
  /** Secrets only, when one of at least 12 characters is configured. */
  readonly lastFour?: string;
}

export interface SettingsList {
  readonly groups: readonly string[];
  readonly settings: readonly SettingView[];
}
