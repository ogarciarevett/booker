import { createHmac, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { instantMillis } from "../../shared/instants.ts";
import type { TranscriptTurnRole } from "../transcript-store.ts";
import type {
  PlaceCallDynamicVariables,
  PlaceCallInput,
  PlaceCallResult,
  VoiceCallPort,
} from "../voice-call-port.ts";

const SIGNATURE_HEADER = "ElevenLabs-Signature";
const TOOLS_KEY_HEADER = "X-Booker-Tools-Key";
const MILLISECONDS_PER_SECOND = 1_000;
/** Deterministic spacing between transcript turns: no real timers, just a fixed step. */
const SECONDS_PER_TRANSCRIPT_LINE = 4;
/** How many times a webhook delivery is attempted in total before giving up, mirroring a real
 * provider's own retry behavior on a non-2xx response. */
const MAX_WEBHOOK_ATTEMPTS = 5;

/** How a persona's call ends: a normal transcription (`completed`/`failed`), or the provider
 * never answers at all (`busy`, reported as `call_initiation_failure`). */
export type PersonaOutcome = "completed" | "failed" | "busy";

const TOOL_PATHS = [
  "get-errand-context",
  "record-quote-field",
  "request-commit-permission",
  "report-commit-outcome",
] as const;

export type PersonaToolPath = (typeof TOOL_PATHS)[number];

export interface PersonaTranscriptLine {
  readonly role: TranscriptTurnRole;
  readonly message: string;
}

/**
 * One scripted exchange: the tool call the agent makes (`call_token` is filled in by the
 * runtime from the call's own dynamic variables, never by the persona) plus the transcript
 * lines said around it.
 */
export interface PersonaStep {
  readonly tool: PersonaToolPath;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly transcript?: readonly PersonaTranscriptLine[];
}

/** A fixed, deterministic script a simulated provider follows for one call. */
export interface Persona {
  readonly outcome: PersonaOutcome;
  readonly steps: readonly PersonaStep[];
}

export interface RecordedStep {
  readonly tool: PersonaToolPath;
  readonly status: number;
  readonly body: unknown;
}

export interface SimulatedStepEvent {
  readonly externalId: string;
  readonly tool: PersonaToolPath;
  readonly status: number;
}

export interface SimulatedVoiceRuntimeDeps {
  readonly voiceToolsApp: Hono;
  readonly postCallWebhookApp: Hono;
  /** The runtime-level secret sent in `X-Booker-Tools-Key` on every voice-tools request. */
  readonly toolsKey: string;
  /** The shared secret used to sign every post-call webhook, exactly as ElevenLabs would. */
  readonly webhookSecret: string;
  /** The simulator's clock: drives the webhook's `t=`/`event_timestamp` unix time. */
  readonly now: () => string;
  /** Which script a provider follows, keyed by `providerId`. */
  readonly personas: ReadonlyMap<string, Persona>;
  /** Generates a fresh provider-side conversation id. Injectable for deterministic tests. */
  readonly generateExternalId?: () => string;
  /** Runs after every recorded step, awaited before the next one; a test-only seam used to
   * deterministically exercise `cancelCall` (see simulated-voice.test.ts). */
  readonly onStep?: (event: SimulatedStepEvent) => void | Promise<void>;
  /** Awaited between webhook delivery attempts (see `postWebhook`). Defaults to yielding to the
   * event loop via `setImmediate` — never a wall-clock sleep. Injectable so a test can
   * deterministically choose exactly when a retry happens (see simulated-voice.test.ts). */
  readonly retryDelay?: () => Promise<void>;
  /**
   * When true, `placeCall` never starts the script on its own: it only starts once the caller
   * calls `registered(externalId)` (see below). This is the deterministic alternative to the
   * default macrotask-deferred start — the default counts event-loop turns, which a real,
   * slower store (SQLite) can outlast, letting a webhook race ahead of the caller recording
   * `externalId` and burn through its retries. Callers that know exactly when `externalId` was
   * recorded (see tests/scenarios/support.ts) should set this and call `registered` right after.
   * Defaults to false, matching every existing unit test that never calls `registered`.
   */
  readonly startAfterRegistration?: boolean;
}

function defaultGenerateExternalId(): string {
  return randomUUID();
}

/** Yields to the event loop on the next macrotask (no real delay), used both to defer a
 * persona's script to after `placeCall` returns and as the default `retryDelay`. */
function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** ElevenLabs retries a delivery only on a 5xx, 408, or 429; every other status is final. The
 * webhook answers 503 for "not stored yet" and "still in progress" for exactly this reason. */
function isRetryableWebhookStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Unix seconds (rounded down) of an ISO 8601 instant. */
function unixSeconds(instant: string): number {
  return Math.floor(instantMillis(instant) / MILLISECONDS_PER_SECOND);
}

/** `JSON.parse`s `text` when possible; a non-JSON body (or an empty one) is recorded as-is
 * rather than throwing, since a real tool response is never guaranteed to be valid JSON. */
function parseJsonOrRaw(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Signs `rawBody` exactly as ElevenLabs does: `t=<unix>,v0=<hex HMAC-SHA256 of "<t>.<rawBody>">`. */
function signWebhook(secret: string, rawBody: string, timestampSeconds: number): string {
  const digest = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`, "utf8")
    .digest("hex");
  return `t=${timestampSeconds},v0=${digest}`;
}

interface TranscriptTurnDraft {
  readonly role: TranscriptTurnRole;
  readonly message: string;
  readonly secondsIntoCall: number;
}

/** A script waiting on `registered(externalId)` before it starts (see `startAfterRegistration`). */
interface PendingStart {
  readonly callId: string;
  readonly dynamicVariables: PlaceCallDynamicVariables;
  readonly persona: Persona;
}

/**
 * A simulated `VoiceCallPort`: drives the real voice-tools and post-call-webhook Hono apps
 * in-process, exactly as ElevenLabs would over HTTP, following a fixed per-provider script
 * (see `Persona`). `placeCall` starts the script in the background and returns immediately;
 * `settled` lets a test await it. Deterministic: no real timers, no real randomness beyond the
 * injectable id generator, and every transcript timestamp is derived from step order alone.
 */
export class SimulatedVoiceRuntime implements VoiceCallPort {
  private readonly deps: SimulatedVoiceRuntimeDeps;
  private readonly cancelled = new Set<string>();
  private readonly finished = new Map<string, Promise<void>>();
  private readonly recordedSteps = new Map<string, RecordedStep[]>();
  private readonly pendingStarts = new Map<string, PendingStart>();

  constructor(deps: SimulatedVoiceRuntimeDeps) {
    this.deps = deps;
  }

  async placeCall(input: PlaceCallInput): Promise<PlaceCallResult> {
    const persona = this.deps.personas.get(input.call.providerId);
    if (persona === undefined) {
      throw new RangeError(
        `SimulatedVoiceRuntime: no persona configured for provider "${input.call.providerId}"`,
      );
    }
    const externalId = (this.deps.generateExternalId ?? defaultGenerateExternalId)();
    this.recordedSteps.set(externalId, []);

    if (this.deps.startAfterRegistration) {
      // The caller (tests/scenarios/support.ts) knows exactly when it has recorded `externalId`
      // on the call and calls `registered` right then — no event-loop-turn counting involved.
      this.pendingStarts.set(externalId, {
        callId: input.call.id,
        dynamicVariables: input.dynamicVariables,
        persona,
      });
      return { externalId, callSid: null };
    }

    // Deferred to the next macrotask so `placeCall` always returns to its caller before any
    // tool call or webhook fires — the caller still needs a moment to record `externalId` on
    // the call, and the bounded webhook retry in `postWebhook` covers the rest of that race as
    // defense in depth (see `startAfterRegistration` for the deterministic alternative).
    this.startScript(externalId, () =>
      nextMacrotask().then(() =>
        this.runPersona(input.call.id, input.dynamicVariables, persona, externalId),
      ),
    );
    return { externalId, callSid: null };
  }

  /**
   * Starts the script for a call placed with `startAfterRegistration: true`, once the caller
   * has recorded `externalId` on it. Throws for an externalId that was never placed, or whose
   * script already started (including a second `registered` call for the same externalId).
   */
  registered(externalId: string): void {
    const pending = this.pendingStarts.get(externalId);
    if (pending === undefined) {
      throw new RangeError(
        `SimulatedVoiceRuntime: no call pending registration for externalId "${externalId}"`,
      );
    }
    this.pendingStarts.delete(externalId);
    this.startScript(externalId, () =>
      this.runPersona(pending.callId, pending.dynamicVariables, pending.persona, externalId),
    );
  }

  /** Kicks off `run` in the background, tracked as `externalId`'s script for `settled`. */
  private startScript(externalId: string, run: () => Promise<void>): void {
    const script = run();
    // Attached immediately, before the script can ever settle, so an unobserved failure (nobody
    // calls `settled`/`cancelCall` for this externalId) is never reported as an unhandled
    // rejection. `settled` below still awaits this exact promise and rethrows from it untouched.
    script.catch(() => {});
    this.finished.set(externalId, script);
  }

  /**
   * Marks `externalId` cancelled: the persona script checks this flag before every step (and
   * again before sending its completion webhook) and stops as soon as it sees it. This never
   * awaits `settled` itself — `onStep` (see `SimulatedVoiceRuntimeDeps`) may call `cancelCall`
   * from inside the very script it is cancelling, and waiting here would deadlock against it.
   */
  async cancelCall(externalId: string): Promise<void> {
    this.cancelled.add(externalId);
  }

  /** Awaits this call's persona script (including its webhook delivery) to completion. */
  async settled(externalId: string): Promise<void> {
    await (this.finished.get(externalId) ?? Promise.resolve());
  }

  /** Every tool response the persona recorded for this call so far, in step order. */
  stepsFor(externalId: string): readonly RecordedStep[] {
    return [...(this.recordedSteps.get(externalId) ?? [])];
  }

  private async runPersona(
    callId: string,
    dynamicVariables: PlaceCallDynamicVariables,
    persona: Persona,
    externalId: string,
  ): Promise<void> {
    if (persona.outcome === "busy") {
      await this.sendInitiationFailure(externalId);
      return;
    }

    const turns: TranscriptTurnDraft[] = [];
    let secondsIntoCall = 0;

    for (const step of persona.steps) {
      if (this.cancelled.has(externalId)) return;

      const response = await this.callTool(
        callId,
        step.tool,
        dynamicVariables.call_token,
        step.body ?? {},
      );
      this.recordedSteps
        .get(externalId)
        ?.push({ tool: step.tool, status: response.status, body: response.body });

      for (const line of step.transcript ?? []) {
        secondsIntoCall += SECONDS_PER_TRANSCRIPT_LINE;
        turns.push({ ...line, secondsIntoCall });
      }

      await this.deps.onStep?.({ externalId, tool: step.tool, status: response.status });
    }

    if (this.cancelled.has(externalId)) return;
    await this.sendTranscription(externalId, persona.outcome, turns);
  }

  private async callTool(
    callId: string,
    tool: PersonaToolPath,
    callToken: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const response = await this.deps.voiceToolsApp.request(`/voice-tools/${callId}/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [TOOLS_KEY_HEADER]: this.deps.toolsKey },
      body: JSON.stringify({ call_token: callToken, ...body }),
    });
    const text = await response.text();
    return { status: response.status, body: parseJsonOrRaw(text) };
  }

  /**
   * Delivers one webhook, retrying exactly as a real provider would when the delivery answers
   * a `5xx` (including the `503` for a call whose `externalId` was not recorded yet — see
   * `placeCall` — or a claim still in progress), `408`, or `429`: up to `MAX_WEBHOOK_ATTEMPTS` attempts total, waiting
   * `retryDelay` between them. Any other status, or exhausting every attempt, throws.
   */
  private async postWebhook(payload: object): Promise<void> {
    const rawBody = JSON.stringify(payload);
    const timestampSeconds = unixSeconds(this.deps.now());
    const headers = {
      "Content-Type": "application/json",
      [SIGNATURE_HEADER]: signWebhook(this.deps.webhookSecret, rawBody, timestampSeconds),
    };
    const retryDelay = this.deps.retryDelay ?? nextMacrotask;

    for (let attempt = 1; attempt <= MAX_WEBHOOK_ATTEMPTS; attempt++) {
      const response = await this.deps.postCallWebhookApp.request(
        "/webhooks/elevenlabs/post-call",
        { method: "POST", headers, body: rawBody },
      );
      if (response.ok) return;
      if (!isRetryableWebhookStatus(response.status) || attempt === MAX_WEBHOOK_ATTEMPTS) {
        throw new Error(
          `SimulatedVoiceRuntime: post-call webhook was rejected with status ${response.status} after ${attempt} attempt(s)`,
        );
      }
      await retryDelay();
    }
    // Unreachable: the loop above always returns or throws by its last iteration.
    throw new Error("SimulatedVoiceRuntime: post-call webhook retry loop exited unexpectedly");
  }

  private async sendInitiationFailure(externalId: string): Promise<void> {
    await this.postWebhook({
      type: "call_initiation_failure",
      event_timestamp: unixSeconds(this.deps.now()),
      data: { conversation_id: externalId },
    });
  }

  private async sendTranscription(
    externalId: string,
    outcome: Exclude<PersonaOutcome, "busy">,
    turns: readonly TranscriptTurnDraft[],
  ): Promise<void> {
    await this.postWebhook({
      type: "post_call_transcription",
      event_timestamp: unixSeconds(this.deps.now()),
      data: {
        conversation_id: externalId,
        status: outcome === "completed" ? "done" : "failed",
        transcript: turns.map((turn) => ({
          role: turn.role,
          message: turn.message,
          time_in_call_secs: turn.secondsIntoCall,
        })),
      },
    });
  }
}
