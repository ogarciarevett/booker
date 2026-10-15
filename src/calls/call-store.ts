import type { Call } from "./call.ts";

export type CreateCallResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "duplicate_call_id" | "duplicate_external_id" };

export type UpdateCallResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" | "duplicate_external_id" };

/**
 * The commit grant a call holds, with the terms it was issued for: `termsDigest` is the
 * `offerTermsDigest` of the offer as it was authorized (see `offer-terms.ts`).
 */
export interface ActiveGrantBinding {
  readonly token: string;
  readonly termsDigest: string;
}

/**
 * Port for persisting calls. `update` only writes a call's lifecycle fields (`status`,
 * `externalId`, `endedAt`): who the call is with, its purpose, attempt, token hash, and creation
 * time are fixed at `create`, so a quote call can never be turned into a commit call.
 *
 * A non-null `externalId` must be unique across calls: two calls can never share one voice
 * provider conversation id. `create` or `update` with a colliding `externalId` reports
 * `duplicate_external_id` rather than silently binding two calls to the same conversation.
 *
 * `setActiveGrant` binds a commit grant's token and authorized terms to the call server-side (the
 * voice agent never sees either); `null` clears the binding. Updating the call never touches that
 * binding. Every stored or returned `Call` and binding is an independent copy.
 */
export interface CallStore {
  create(call: Call): Promise<CreateCallResult>;
  findById(id: string): Promise<Call | undefined>;
  /** The call whose `externalId` (the voice provider's own call id) matches, or `undefined`
   * before it is known — used by the post-call webhook to find the call a delivery is for. */
  findByExternalId(externalId: string): Promise<Call | undefined>;
  update(call: Call): Promise<UpdateCallResult>;
  setActiveGrant(callId: string, binding: ActiveGrantBinding | null): Promise<UpdateCallResult>;
  activeGrant(callId: string): Promise<ActiveGrantBinding | undefined>;
}

/**
 * The call store the local server places real calls through: `CallStore` plus the Twilio
 * CallSid of a placed call, which is only needed to hang it up (ElevenLabs has no hang-up
 * endpoint), and the listings that placement and the reconciliation sweep need. Like the grant
 * binding, the CallSid lives beside the call rather than in `Call`, and updating the call never
 * touches it.
 */
export interface LiveCallStore extends CallStore {
  setCallSid(callId: string, callSid: string): Promise<UpdateCallResult>;
  callSid(callId: string): Promise<string | undefined>;
  /** Every call still scheduled or in progress. */
  listOpen(): Promise<Call[]>;
  /** Every call ever placed for an errand, open or ended. */
  listByErrand(errandId: string): Promise<Call[]>;
  /**
   * The `limit` most recently placed calls, open or ended: newest `createdAt` first, ties by id.
   * Throws a RangeError unless `limit` is a positive whole number.
   */
  listRecent(limit: number): Promise<Call[]>;
}
