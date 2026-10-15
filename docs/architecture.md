# Architecture

Booker is a single TypeScript service built around a durable workflow. The domain decides; adapters talk to the outside world. This document describes the planned design; modules land feature by feature.

## Components

| Component | Responsibility |
|-----------|----------------|
| [Mastra workflows](https://mastra.ai/docs/workflows) | Orchestrate each errand as a graph; suspend while calls run and resume from post-call webhooks or user approval, with snapshots in SQLite |
| [ElevenLabs Agents](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration) + Twilio | Primary voice runtime: listen, take turns, and speak Spanish (Spain) with the user's consented voice clone; [batch calls](https://elevenlabs.io/docs/eleven-agents/phone-numbers/batch-calls) for parallel rounds |
| [Pipecat](https://docs.pipecat.ai/pipecat/telephony/twilio-websockets) + Twilio Media Streams | Plan B voice runtime (self-hosted Python worker) that keeps ElevenLabs TTS so the voice stays the same; a Cartesia clone is only a separately consented backup |
| Model profiles | Offline reasoning roles backed by `claude-code`, `codex-cli`, or `api`; see the [README caveat](../README.md#using-your-claude-or-chatgpt-subscription) |
| Jev ([TypeSafe](https://docs.typesafe.ai/introduction/quickstart)) | Bounded decisions: pick one allowed action or classify an answer, with a confidence score |
| Hono | HTTP: voice tools, webhooks, control API |
| Drizzle + libsql | SQLite persistence for errands, offers, calls, grants, and bookings |
| Vitest | Test runner; development is strict TDD |
| OpenTelemetry + [Arize Phoenix](https://arize.com/docs/phoenix) | Opt-in local traces, one Phoenix session per call; see [observability.md](observability.md) |

## Module map

Top-level folders name the domain (screaming architecture). Each module owns its ports; adapters live beside it and depend inward.

```text
src/
  errands/        ErrandBrief schema and lifecycle
  offers/         Offer fields as Known{value, evidence} | Estimated | Unknown; group cost comparison
  bookings/       Commit grants (one active per errand) and the booking ledger: verbal → written → enrolled
  policies/       Standing rules and per-errand limits: dates, total, deposit, cancellation
  calls/          VoiceCallPort + adapters/{elevenlabs, pipecat, simulated}; concurrency and attempt caps
  decisions/      DecisionPort + adapters/{jev, conservative}
  reasoning/      Model profile factory and agents: brief parsing, question plan, transcript → offer
  orchestration/  The errand workflow (suspend/resume)
  http/           Voice tools, signed webhooks, control API, stop button
  server/         The local server: configuration, voice-tools key, SQLite wiring, transcript purge
  cli/            `pnpm booker` commands (`serve`, `agent sync`, `phone import`, `call`)
  overview/       Read models for the owner: an errand at a glance (stage, provider outcomes, ranked quotes, what is missing)
  settings/       Settings catalog, SecretStore and SettingStore ports, resolver (environment, then saved values); adapters/{keychain, in-memory}
  observability/  Opt-in OpenTelemetry tracing to a local Phoenix, span redaction (composition root only)
  persistence/    Schema, migrations, repositories
  shared/         Money (integer cents), DateRange (errand time zone), Clock, ids, log redaction
apps/
  dashboard/      Next.js read-only dashboard over the control API; the token stays in lib/server
```

Rule: `errands`, `offers`, `bookings`, and `policies` never import adapters, Mastra, or HTTP code.

## Voice tool contract

Both voice runtimes call the same backend endpoints, so switching providers is a configuration change plus re-pointing the phone number.

| Tool | Input | Output |
|------|-------|--------|
| `get_errand_context` | call id | The brief fields this provider may hear |
| `record_quote_field` | field, value, verbatim evidence, confirmed | Stored on the provider's offer draft as `known` or `estimated`; a change to an offer that holds a grant revokes it, and the agent must ask again |
| `request_commit_permission` | total, deposit, dates | `{ granted, instruction }`, decided during the call; a grant is bound to the call server-side |
| `report_commit_outcome` | outcome, verbatim evidence | `accepted` checks the offer against the terms fingerprint (SHA-256 of its canonical JSON) bound with the grant, revoking the grant on a mismatch, then stores the verbal booking and only then consumes the grant, cancelling the booking if the grant ended meanwhile; `rejected` releases the grant and `unclear` keeps it for reconciliation |

`src/http/voice-tools.ts` serves them as `POST /voice-tools/:callId/<tool>`. Every request carries the runtime key in `X-Booker-Tools-Key` and the per-call token in the body; a wrong key, token, call, or an ended call all get the same 401. Commit tools are only exposed to the commit call (403 otherwise), and bodies are limited to 16 KiB.

A retried `accepted` whose booking was already stored for the call's grant finishes that accept instead of booking again; this is safe only because writing tools run one at a time per errand in a single server instance, so running two instances would need a cross-process lock first.

SQLite has the same limit. Within one process, every handle `openDatabase` opens on the same SQLite file shares one queue (`serialized` in `src/persistence/database.ts`), so two connections never contend for the file's write lock. They cannot wait for it in-process: the libsql binding is synchronous, so a busy wait blocks the event loop that the lock holder needs to commit, and a `BEGIN IMMEDIATE` that fails with `SQLITE_BUSY` makes that connection's next `COMMIT` fail too. Across processes only SQLite's own locking and `withBusyRetry` apply, which is another reason Booker runs as a single instance.

## Post-call webhook and transcript retention

`src/http/post-call-webhook.ts` serves `POST /webhooks/elevenlabs/post-call`. The raw body is verified against `ElevenLabs-Signature` before anything is parsed (401 on any failure, identical body), bodies over 2 MiB are rejected with 413, and a malformed payload is 400. Each delivery is claimed by `${type}:${conversation_id}` and its payload's SHA-256 before processing (see `webhook-events.ts`): a replay completes with 200 without reprocessing, a still-pending claim answers 503, and a payload mismatch on that same key answers 409 and is reported. Finding the call and processing the event both run inside one try/catch, so any failure releases the claim and answers 500 rather than leaving the event stuck claimed forever; a processing error is reported before a release that then also fails is reported, never masked by it. An unknown `conversation_id` releases the claim and answers 503 with `Retry-After`: the webhook is attached to Booker's own agents, so it is a Booker call whose `externalId` is not stored yet, and ElevenLabs retries a `post_call_transcription` only on 5xx, 408, or 429 (five attempts over about 40 minutes) — a 404 or 409 would be final. It never retries a `call_initiation_failure`; a call that misses one is found by the reconciliation sweep. `post_call_transcription` ends the call (`status: "done"` maps to `completed`, anything else to `failed`) and saves a minimized transcript (role, message, seconds into the call — nothing else), dropping any turn with an empty, `null`, or missing message (a turn that only carries tool calls or tool results) or an invalid time rather than failing the whole delivery. `call_initiation_failure` ends the call as `no_answer` (it never connected, but still counts as one attempt, so `planCallRound` can retry the provider within the attempt cap). `post_call_audio` and any other event type are claimed and completed without further processing, since audio is never stored.

Transcripts live in `call_transcripts` (`src/calls/transcript-store.ts`, one row per call, upserted by `callId`). `src/calls/retention.ts`'s `transcriptRetentionCutoff(now, days)` computes the cutoff, and `purgeExpiredTranscripts({ transcripts, now, retentionDays })` runs the purge and reports how many rows were removed. The server runs it on start and then every hour (`scheduleTranscriptPurge` in `src/server/transcript-purge.ts`), keeping transcripts for 30 days.

## Local server

`src/server/` runs everything above as one process, the single instance the voice tools and SQLite rely on; `pnpm booker serve` (`src/cli/serve.ts`) starts it, and [live-calls.md](live-calls.md) covers what runs where, the environment variables, and the public exposure through Tailscale Funnel. `startBookerServer` migrates `<data dir>/booker.db`, builds the SQLite store set (`createSqliteStores`) and both HTTP apps (`createBookerApps`, the same wiring `tests/scenarios/` drives), and serves them with `GET /healthz` through `@hono/node-server` on `127.0.0.1` only. Each request is logged as one line (method, path, status, duration), never with headers, bodies, or query values, and unexpected errors are logged as their first line only with both secrets redacted (`describeError`). Shutdown stops accepting connections, gives in-flight requests up to 5 seconds, waits for a running purge, then gives any handler still running after its connection was cut the same 5 seconds again (`trackInFlight`), so the database never closes under a write; only then does it close the database. A server error after the socket is bound (out of file descriptors, say) is logged, never fatal, and a start that fails after binding closes the listener before it reports the failure.

`parseServeConfig` (`src/server/config.ts`) reads what the server binds at start (host, port, data directory) and names an invalid variable without echoing its value; everything else is resolved at each use through the settings resolver (`src/settings/resolver.ts`): the environment first, then the values saved from the dashboard (SQLite for plain values, the macOS Keychain for secrets). See [settings.md](settings.md). The voice-tools key is generated once into `.local/secrets/voice-tools-key` (32 random bytes, base64url, mode 0600 in a 0700 directory) and reused on every start; a key file other users could read is refused, as OpenSSH refuses a private key, because only the owner can decide whether it leaked and must be rotated. Until standing rules are loaded from the owner's configuration, the server books nothing automatically: `request-commit-permission` answers "not granted".

The same server serves the owner's control routes (`src/http/control.ts`), never exposed through Tailscale Funnel, which only forwards `/voice-tools` and `/webhooks`: every request needs `Authorization: Bearer <control token>`, a token generated once into `.local/secrets/control-token` (0600) and compared in constant time. `POST /control/calls` `{ to, errandFile, purpose: "quote" }` reads a brief from a file whose real path (symlinks resolved) lies under `.local/`, and places the call with `placeQuoteCall` inside the server, because two processes must never write the same SQLite file; it answers `201 { callId, conversationId }`, `409` for a number the brief does not name or a provider that cannot be called now, `503` with the reason when calls are not configured, and `502` when ElevenLabs refuses. The read routes never return a token, a token hash, a grant token, or a full phone number (`maskPhone` keeps the last four digits): `GET /control/calls` lists the most recent calls (`LiveCallStore.listRecent`), `GET /control/calls/:id` answers the call's status and what it recorded (`summarizeOffer`: each known or estimated value with the provider's quote, and what is still unknown), its transcript, whether it holds the errand's commit grant, and the errand's open booking, and `GET /control/bookings` lists bookings (`BookingStore.listRecent`). `GET /control/errands` and `GET /control/errands/:id` show each errand at a glance (`errandOverview` in `src/overview/errand-overview.ts`, derived from the stores with `planCallRound`, `rankOffers`, and the booking ledger). `GET /control/settings`, `PUT /control/settings/:name`, and `DELETE /control/settings/:name` read and change the settings saved from the dashboard (see [settings.md](settings.md#control-api)). `GET /control/events` streams call activity as Server-Sent Events: `placeQuoteCall`, the post-call webhook, `reconcileStaleCalls`, and the voice tools report status changes and tool outcomes through the `ReportCallActivity` port (`src/calls/call-activity.ts`, ids and statuses only) to the server's `InProcessActivityFeed`, which the server closes first on shutdown so open streams end; see [observability.md](observability.md#read-only-data-api). The ElevenLabs port is built per request (`createVoicePortFactory` in `src/server/voice.ts`) from the resolved `ELEVENLABS_API_KEY`, `BOOKER_OWNER_NAME`, and Twilio credentials and `.local/elevenlabs.json`, so a saved setting, a sync, or a phone import made while the server runs applies at the next call; the post-call webhook resolves its secret at each delivery the same way. The server also runs `reconcileStaleCalls` every minute (`scheduleRepeatingTask`), with the API key in effect at each check. `pnpm booker call` (`src/cli/call.ts`) is the client: it posts to the control route with the token and, with `--wait`, polls `GET /control/calls/:id` until the call ends and prints what was recorded.

`pnpm serve:traced` starts the same server with the OpenTelemetry tracer preloaded (`src/observability/telemetry.ts`, loaded with `node --import` and imported by no other module): the voice tools, the post-call webhook, call placement, reconciliation checks, Jev decisions, and outgoing requests become spans filed under the call's Phoenix session (`session.id` = call id), redacted before export. See [observability.md](observability.md).

A call's `external_id` is unique once set (a partial unique index, since many calls hold none yet): `CallStore.create`/`update` report `duplicate_external_id` rather than letting two calls bind to the same voice-provider conversation.

## ElevenLabs voice runtime

`src/calls/adapters/elevenlabs/` is the real `VoiceCallPort`. `ElevenLabsClient` (`client.ts`) is a small `fetch` client (base URL and `fetch` injectable, `xi-api-key` auth, every answer validated with zod) that never retries: retrying the outbound-call request after a server error could dial the same person twice. Its errors name the method, path (never the query), HTTP status, and ElevenLabs' error code, never the key, the body, or ElevenLabs' free-text message. `ElevenLabsVoiceCallPort` (`voice-call.ts`) places a call with `POST /v1/convai/twilio/outbound-call`, choosing the quote or commit agent by the call's purpose, with Twilio recording off and the dynamic variables `call_id`, `call_token`, and `owner_name` (every variable the agent references must be present, or ElevenLabs fails the call). The conversation id becomes the call's `externalId`; Twilio's `callSid` is returned beside it and stored in `calls.call_sid` through `LiveCallStore.setCallSid`, outside `Call` like the grant binding. ElevenLabs has no hang-up endpoint, so `cancelCall` hangs up through Twilio (`src/calls/adapters/twilio/hang-up.ts`, `Status=completed`). The SDK is not used: it retries failed POSTs and strips unknown fields.

ElevenLabs tool parameters cannot use `anyOf`, so `tools.ts` offers the backend's `record_quote_field` (whose `value` is a union) as one webhook tool per value shape — `record_quote_text`, `_number`, `_flag`, `_amount`, `_dates`, and `record_cost_item` — all posting to the same unchanged route, which still validates every field and value; a test fills each tool as the model would and parses the body with the backend's schemas. `call_id` and `call_token` come from dynamic variables (the model never sees them), and `X-Booker-Tools-Key` from the `booker_tools_key` workspace secret. The voice-tools boundary drops `null` object properties before validation, since the model may send `null` for an optional field. `agent-sync.ts` (`pnpm booker agent sync`, `src/cli/agent-sync.ts`) creates or updates the secret, the tools, the post-call webhook (reusing one already pointing at the URL), and the `booker-quote` and `booker-commit` agents by exact name, so a second run only patches; it checks the in-call model against ElevenLabs' LLM list before changing anything, and reads the agents' Spanish text from `locales/es-ES/agent.yaml` (`agent-script.ts`).

`placeQuoteCall` (`src/calls/place-call.ts`) places one real quote call: the number must be one of the brief's providers (Booker never calls a number its brief does not name), the brief is stored (replacing an earlier version with the same id), `planCallRound` must still offer that provider (no open call, under the attempt cap), and the call is created with a fresh per-call token before the voice port dials. The conversation id and CallSid are stored the moment the port answers, so a webhook arriving right after finds the call (and one arriving even earlier gets a 503 and is retried); a refused or failed placement ends the call as `failed`. `reconcileStaleCalls` (`src/calls/reconciliation.ts`) is the reconciliation job: every call still open five minutes after placement is checked with the provider; one ElevenLabs reports `failed` ends as `no_answer` (a lost `call_initiation_failure` is never retried), one that never got a conversation id ends as `failed`, and anything else is left for its webhook.

## Simulated voice runtime

`src/calls/voice-call-port.ts` is the provider-neutral port the orchestration workflow calls: `placeCall({ call, phoneE164, dynamicVariables })` returns `{ externalId }` and `cancelCall(externalId)` ends an in-flight call. `src/calls/adapters/simulated-voice.ts`'s `SimulatedVoiceRuntime` implements it entirely in-process, driving the real `voice-tools` and `post-call-webhook` Hono apps as ElevenLabs would: given a fixed script per provider id (a `Persona`), `placeCall` returns a fresh external id immediately and runs the script in the background — each step is a real `POST /voice-tools/:callId/<tool>` call authenticated with the runtime key and the call's own token, never a token the persona invents — then delivers a correctly signed `post_call_transcription` (or `call_initiation_failure`, for a provider that never answers) webhook carrying the script's transcript lines. `settled(externalId)` awaits that background script for tests; `cancelCall` stops it before its next step. `simulations/personas.ts` holds the fictional scripts (two driving schools — one fully confirmed, one cheaper-looking but leaving its price estimated — a restaurant, a busy provider, a field-injection attempt, and paired commit personas, including one with a one-cent-off misheard total) that `tests/scenarios/*.test.ts` drive end to end against both in-memory and SQLite stores, proving the same code path runs regardless of the errand's `kind`.

## Errand graph

```text
prepareBrief ──(missing data)──▶ suspend for user input
     │
planQueries
     │
foreach provider (max 3 in parallel, max 2 attempts each)
     ├─ placeQueryCall (no commit tools)
     ├─ suspend until post-call webhook
     ├─ extractOffer (structured output + Jev classifications)
     └─ nextAction via Jev: clarify (loop) | save | discard | escalate
     │
compare (code)
     │
select ──(outside standing rules)──▶ suspend for user approval
     │
commitCall (grant checked mid-call) ──▶ suspend until webhook
     │
verify (reconfirm every seat and the joint price) ──▶ calendar
```

A reconciliation job polls the voice provider for calls that never produced a webhook.

## Decisions with Jev

- Request: `POST https://api.typesafe.ai/v1/systemone` with `state` (context) and `questions` keyed by name, each with `type` (`choice`, `score`, or `noul`), `instructions`, and `criteria`.
- The response `model` field (the effective version) is stored with every decision so runs can be compared.
- [Confidence](https://docs.typesafe.ai/confidence) at or above 0.9 may act; below 0.5 goes to a human; anything in between keeps collecting information.
- Jev only picks among actions the backend already allows. It never authorizes money or a commitment. If the API fails, a conservative adapter returns "continue collecting" or "request intervention".

## Model matrix

Every model choice — Booker's own runtime roles and the Orca development workers used to build Booker — goes through one explicit allowlist per context, with Jev picking within it and code validating the pick.

| Role | Default | Other candidates |
|---|---|---|
| `inCall` | `elevenlabs:gpt-6-sol` | `elevenlabs:gpt-6-astra`, `elevenlabs:claude-sonnet-5`, `elevenlabs-custom:gpt-6.1-sol` |
| `briefParsing` | `codex-cli:gpt-6.1-sol` | `claude-code:claude-sonnet-5-5`, `api:openai/gpt-6.1-sol`, `api:anthropic/claude-sonnet-5-5` |
| `questionPlanning` | `codex-cli:gpt-6.1-sol` | same as above |
| `transcriptExtraction` | `api:openai/gpt-6.1-sol` | `codex-cli:gpt-6.1-sol`, `claude-code:claude-sonnet-5-5`, `api:anthropic/claude-sonnet-5-5` |
| `comparisonNarrative` | `claude-code:claude-sonnet-5-5` | `codex-cli:gpt-6.1-sol`, `api:anthropic/claude-sonnet-5-5` |

`src/reasoning/model-matrix.ts` implements this table: `selectModel` asks Jev to choose among the allowlisted candidates for a role, trusts the answer only at the "act" confidence tier and only when it names an allowlisted id, and otherwise falls back to the role's default. Subscription-backed candidates (`codex-cli`, `claude-code`) are excluded during a parallel run or under the kill switch, since neither is trusted to keep running unattended or fan out.

The same pattern routes Orca development workers: [`docs/agent-matrix.md`](agent-matrix.md) documents the row table (maintained by hand and checked against `tools/agent-matrix.json` by a test), `tools/agent-matrix.json` holds it, and `scripts/route-task.ts` prints the `orca orchestration worker-start` command for a task without ever running it. Both `selectModel` and `routeTask` share their bounded-choice logic through `chooseWithin` (`src/decisions/choose-within.ts`). `routeTask`'s reasons — `jev`, `no_decision_service`, `low_confidence_default`, `invalid_choice_default`, `decision_failed_default` — mirror `selectModel`'s; `no_decision_service` means no `TYPESAFE_API_KEY` is configured, so nothing was asked, and on `decision_failed_default` the CLI also prints a sanitized one-line error to stderr (never a secret such as the API key).

## Safety invariants

| Invariant | Enforced by |
|-----------|-------------|
| Provider speech is data, never permission | Extraction output types can only write offer fields |
| Money, dates, and permissions are checked in code | `policies` module, before any grant |
| At most one active commit grant per errand | Unique database constraint plus a transaction |
| Webhooks are authentic and processed once | HMAC signature check and idempotent event storage |
| Missing notifications are recovered | Reconciliation job |
| You can always stop | Stop endpoint cancels pending calls and revokes grants |
| Secrets never reach prompts, the frontend, or logs | Environment-only secrets and log redaction |

## Key decisions

| Decision | Rationale |
|----------|-----------|
| Mastra over Google ADK and Tether QVAC | Durable suspend/resume on external events already exists, and subscription-backed models plug in through AI SDK providers; ADK would need a custom model adapter and QVAC has no orchestration |
| Subscription models never run inside a live call | Measured latency (about 12 s cold start for the Agent SDK, about 0.9 s overhead per Codex turn) is far above conversational turn-taking; the voice runtime's own model handles the call |
| Pipecat as Plan B | Open source, self-hosted, and we own the dialog loop, so the mid-call permission check is a plain `await` |
| One voice tool contract | Keeps the backend independent of the voice provider |
| `locales/es-ES/` is the only non-English content | Exact spoken text (AI disclosure, recording notice) must be verbatim; everything else is English |
