# Observability

Two local views of what Booker does, both on the owner's Mac only:

- **Traces**: OpenTelemetry spans in [Arize Phoenix](https://arize.com/docs/phoenix), one session per call, showing what the server did and what it asked ElevenLabs, Twilio, and Jev. Off unless you turn it on; without it, Booker never loads the OpenTelemetry SDK.
- **Dashboard**: a small Next.js app (`apps/dashboard`) with live calls, each call's transcript and recorded offer, and bookings, linking each call to its Phoenix session. See [Dashboard](#dashboard).

## Quick path

1. **Phoenix.** In its own terminal, run `pnpm phoenix` and leave it running. It needs [uv](https://docs.astral.sh/uv/) (`uv --version`); the first start downloads Phoenix and its Python packages into uv's cache, about a minute.
2. **Endpoint.** Add `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:6006/v1/traces` to `.env`.
3. **Server.** Start Booker with `pnpm serve:traced` instead of `pnpm booker serve`. It prints `Tracing: on (service booker), spans go to http://127.0.0.1:6006/v1/traces`.
4. **Look.** Open <http://127.0.0.1:6006>: spans land in the `booker` project.

`pnpm booker serve` keeps working as before and says nothing about tracing unless the endpoint is set. Then its `Tracing:` line says why spans are not sent:

| Situation | `serve` prints |
|-----------|----------------|
| Started without the tracer (`pnpm booker serve`) | `Tracing: off; OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set, so start with pnpm serve:traced` |
| `OTEL_SDK_DISABLED=true` | `Tracing: off; OTEL_SDK_DISABLED is true` |
| The endpoint is not an http(s) URL | `Tracing: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an http(s) URL such as http://127.0.0.1:6006/v1/traces; tracing is off` (the value is never printed) |

## Phoenix

`pnpm phoenix` (`scripts/phoenix.ts`) runs `uvx --python 3.13 --from arize-phoenix==20.19.0 phoenix serve` natively, without Docker, and stops on Ctrl+C.

| Setting | Value | Why |
|---------|-------|-----|
| Release | `arize-phoenix==20.19.0` | Pinned; published 2026-10-01 |
| UI and OTLP over HTTP | `127.0.0.1:6006` (`PHOENIX_HOST`, `PHOENIX_PORT`) | Loopback only |
| Data | `.local/phoenix` (`PHOENIX_WORKING_DIR`, folder mode 0700) | Ignored by git, like the rest of `.local/` |
| Usage telemetry | `PHOENIX_TELEMETRY_ENABLED=false` | Phoenix sends nothing about you to Arize |
| Environment | Inherited, minus `BOOKER_*`, `ELEVENLABS_*`, `TWILIO_*`, `TYPESAFE_*`, `OTEL_*`, and anything named `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD` | Phoenix never sees Booker's credentials. `.env` is not loaded |
| Memory | About 600 MB resident once started | Stop it when you are not looking at traces |

> [!WARNING]
> Phoenix 20.19.0 always opens its OTLP **gRPC** receiver on every interface (`*:4317`). Booker does not use it (it exports over HTTP), and it only accepts spans, it does not serve them, but anyone who can reach this Mac on port 4317 could write spans into Phoenix. Keep the macOS firewall on (System Settings, Network, Firewall) or stop Phoenix when you are done.
>
> Checked in the 20.19.0 source (`phoenix/server/grpc_server.py`, `phoenix/config.py`): the receiver binds `[::]:<PHOENIX_GRPC_PORT>` with no host setting, and it is only skipped in read-only mode, which `phoenix serve` never enables. `PHOENIX_GRPC_PORT` moves the port, not the address. What could restrict it (TLS with client certificates, `PHOENIX_ENABLE_AUTH`, or a custom `PHOENIX_GRPC_INTERCEPTOR_PATHS` interceptor) costs more than it protects here, so `pnpm phoenix` leaves it alone.

To delete every stored trace, stop Phoenix and remove `.local/phoenix`.

## Environment variables

Booker reads these only in a process started with the tracer preloaded (`pnpm serve:traced`, which is `node --import ./src/observability/telemetry.ts`), once at start: from the environment, or else from the values saved in Booker's settings (see [settings.md](settings.md)).

| Variable | Default | Value |
|----------|---------|-------|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | unset (tracing off) | An http(s) OTLP/HTTP traces URL; Phoenix's is `http://127.0.0.1:6006/v1/traces`. Spans are sent as protobuf, the only OTLP/HTTP encoding Phoenix accepts. An invalid value is reported by name and tracing stays off |
| `OTEL_SERVICE_NAME` | `booker` | The service name, and the Phoenix project spans are filed under |
| `OTEL_SDK_DISABLED` | `false` | `true` keeps tracing off even with an endpoint |

Booker sets the rest itself and ignores the matching variables: traces only (no OTel metrics or logs), no resource detection, and W3C trace context without baggage.

## What is traced

Every span about one phone call carries `session.id` set to Booker's call id, the [OpenInference session attribute](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md), so Phoenix's **Sessions** tab shows one session per call: its voice-tool requests, its post-call webhook, its placement, and any reconciliation check, in order.

| Span | Name | Attributes |
|------|------|------------|
| Voice-tool request | `POST /voice-tools/:callId/<tool>` (`@hono/otel`) | Method, route, status; `session.id` once the key, call, and token check out (a request that fails them joins no session) |
| Voice tool | The tool, such as `record_quote_field` (OpenInference kind `TOOL`, child of the request) | `tool.name`, `session.id`, `booker.tool.status`: `ok`, `forbidden`, `invalid_request`, or `conflict`. Never the fields, values, or quotes |
| Post-call webhook | `POST /webhooks/elevenlabs/post-call` | Status; `session.id` and `booker.webhook.event` (such as `post_call_transcription`) once the conversation is matched to a call |
| Placing a call | `POST /control/calls` | Status; `session.id` of the new call |
| Reconciliation check | `reconcile call`, one per stale call checked with ElevenLabs | `session.id`, `booker.provider_reports_failure` |
| Jev decision | `jev decision` (kind `LLM`) | `jev.question` (the key), `jev.choice`, `jev.confidence`, `llm.model_name`, token counts; on failure `jev.error_kind`. Never the state, instructions, criteria, or key |
| Outgoing `fetch` (ElevenLabs, Twilio, Jev) | `<METHOD> <host>` (`@opentelemetry/instrumentation-undici`), a child of whatever started it | Method, status, host, port, path; `url.full` without its query string |

Not traced: `GET /healthz` and the `GET /control/*` routes that `pnpm booker call --wait` (and later the dashboard) poll, so Phoenix shows calls rather than polling; the transcript purge; and the reconciliation sweep itself when no call is stale.

## Privacy rules

Spans leave the Booker process, so they follow the same rule as the logs: no secrets and no personal data.

| Never in a span | How |
|-----------------|-----|
| Keys, tokens, the webhook secret, call tokens | Headers and bodies are never recorded. Before export, every span is redacted (`src/observability/redaction.ts`): header attributes and `url.query` are dropped, and any `*_KEY`, `*_TOKEN`, `*_SECRET`, or `*_PASSWORD` value from the environment, plus the voice-tools key, control token, and webhook secret `serve` registers, is replaced with `[redacted]` wherever it appears |
| Phone numbers | They travel in bodies and, for some ElevenLabs lookups, query strings; URLs are cut to origin and path |
| Transcript text and errand details | Bodies are never recorded; an exception keeps only its type, the first line of its message, and its stack frames, since a database error lists the query's parameters on later lines |
| The host name, the process's command line, the OS user | Resource detection is off; the resource is only `service.name` and `openinference.project.name` |
| Data from callers | An incoming `traceparent` or `baggage` header is ignored: the public routes are reachable from the internet, and a caller must not choose Booker's trace ids or whether a request is recorded. Outgoing requests carry `traceparent` only, never `baggage` |

Call ids are not secrets and do appear in spans and URL paths.

## Read-only data API

The server's control routes also serve what a call did, for `pnpm booker call --wait` and the dashboard. Like every control route they need `Authorization: Bearer <.local/secrets/control-token>`, answer the same 401 without it, and are never exposed through Tailscale Funnel.

| Route | Answers |
|-------|---------|
| `GET /control/calls?limit=50` | `{ calls }`, newest first (`limit` 1 to 200, default 50): id, errand, provider id and name, the provider's number masked to its last four digits (`+*******0100`), purpose, status, attempt, `createdAt`, `endedAt`, and `hasConversation` (whether ElevenLabs took the call), never the conversation id |
| `GET /control/calls/:id` | The same fields plus `conversationId`; `recorded` (each known or estimated value with the provider's `quote` and `capturedAt`) and `unknown`; `transcript` (`receivedAt` and the turns: role, message, seconds into the call) or `null`; `grant` (`{ status: "active", expiresAt }` while this call holds the errand's commit grant) or `null`; `booking` (the errand's open booking: id, provider, status, history) or `null` |
| `GET /control/errands?limit=50` | `{ errands }`, newest first by when each brief was first stored: id, kind, objective, `createdAt`, `stage` (`preparing`, `calling`, `waiting_for_you`, `booked`, `closed`), provider `counts` (not called, calling, quoted, declined, ruled out, no answer, no quote, failed, and `pending`, those that can still be called), `progress` (`done` of `total` providers), the leading provider, and the last activity |
| `GET /control/errands/:id` | The same plus one row per provider (status, `reasons`, the provider's `quote` behind a decline, attempts of the cap, whether it can be retried, the number masked to its last four digits, and its quote: evaluation, total, per person, estimated, unknowns, failures), the `ranking` from `rankOffers`, and `missing`: providers `planCallRound` would call now, the leading quote's unknowns, written confirmation (`not_required`, `pending`, `received`), and the commit state. A provider that turns an errand down is only recorded today as no seats available (`declined_by_provider`); a call that ends with nothing recorded shows as `no_quote` |
| `GET /control/bookings?limit=50` | `{ bookings }`, newest first, cancelled ones included: id, errand, offer, provider id and name, participant ids, status, history |
| `GET /control/events` | A Server-Sent Events stream: `ready` once subscribed, then `call_status` (`{ type, callId, status, at }`) whenever a call is scheduled, starts, or ends (placement, post-call webhook, reconciliation), `tool` (`{ type, callId, tool, outcome, at }`) for each authenticated voice-tool request, where `outcome` is `ok` or the error it answered, and `setting` (`{ type, name, action, at }`) when a setting is saved or removed from the dashboard. A `: keep-alive` comment every 25 seconds keeps proxies from closing an idle stream; the stream ends when the server stops |

None of them returns a call token or its hash, a grant token, or a full phone number, and events carry ids, statuses, and tool names only, never what was said or recorded. Events come from an in-process feed (`InProcessActivityFeed`): nothing is stored, so a stream sees what happens after it subscribes, and a client that falls behind or goes away never slows a call down: a client with more than 100 events waiting for it is dropped (its stream ends, and the browser reconnects). Transcripts are personal data: they stay on this machine and are purged after 30 days.

## Dashboard

`pnpm dashboard` runs the dashboard (`apps/dashboard`, Next.js 16 with React 19) at <http://127.0.0.1:3100>, next to a running `pnpm booker serve` (or `pnpm serve:traced`). It reads calls and bookings, and changes nothing in Booker but its settings (see [settings.md](settings.md#dashboard)).

| Page | Shows |
|------|-------|
| Errands (`/errands`) | Errands grouped by stage (calling, waiting for you, preparing, booked, closed) as compact rows with a stage icon, the objective, a chip per provider outcome (calling, quoted, declined, ruled out, no answer, pending), and a progress bar of settled providers; updates live. `j` and `k` move between rows and Enter opens one. The dashboard checks Booker's answers when they arrive: a stage or provider status it does not know (from a newer Booker) shows as Unknown, under Other, instead of breaking the page |
| Errand (`/errands/<id>`) | The errand's stage and progress; one row per provider with a status icon, its outcome in words, the reason (no seats, a rule it fails, no answer after n of the cap), the provider's own words behind a decline, and its quote (total, per person, estimated); the ranked quotes; and what is missing to close (providers to call, the best quote's unknowns, written confirmation, commit state). Enter on a provider opens its last call; Escape goes back |
| Calls (`/`) | Recent calls with provider, masked number, purpose, a status chip, and times; updates live |
| Call (`/calls/<id>`) | Provider and status; a timeline (placed, transcript received, ended, booking steps); recorded values marked **Known** or **Estimated** with the provider's words; what is still unknown; the commit grant and the errand's booking; the transcript; the call's live activity while the page is open; and **View trace in Phoenix** when Phoenix has the call's session |
| Bookings (`/bookings`) | Every booking, cancelled ones included, with its history |
| Settings (`/settings`) | Every setting by group, with where its value comes from; edits saved values and secrets (see [settings.md](settings.md#dashboard)) |

| Setting | Default | Value |
|---------|---------|-------|
| `BOOKER_URL` | `http://127.0.0.1:8787` | Where Booker's control routes answer |
| `BOOKER_REPO_ROOT` | two folders above `apps/dashboard` | The repository whose `.local/secrets/control-token` the dashboard reads |
| `PHOENIX_URL` | `http://127.0.0.1:6006` | Phoenix, for the trace link |

How it keeps the token on the server:

- Only the modules in `apps/dashboard/lib/server/` read `.local/secrets/control-token`, at each request, and call Booker; they `import "server-only"`, so `next build` fails if a client component ever imports one, and a test checks that no client component imports server code or names the token.
- The pages are server components: the browser gets HTML, never the token or Booker's address. Live updates go through the app's own `GET /api/events`, which relays Booker's `GET /control/events` with the token added on the server and none of Booker's headers passed on; closing the tab closes the upstream stream.
- Next.js binds to 127.0.0.1 only (`-H 127.0.0.1 -p 3100`), uses system fonts (nothing is fetched at runtime), and runs with its usage telemetry off (`apps/dashboard/scripts/next.ts` sets `NEXT_TELEMETRY_DISABLED=1`).

### Threat model

The dashboard has no login: it is meant for one person on their own Mac. Since its server adds the control token for whoever asks, the question is who can ask.

| Who | Can they read transcripts and bookings? | Why |
|-----|------------------------------------------|-----|
| Another machine on the network or tailnet | No | Next.js listens on 127.0.0.1 only, and Tailscale Funnel never forwards port 3100 |
| A web page you visit, through DNS rebinding (its host name re-pointed at 127.0.0.1) | No | `apps/dashboard/proxy.ts` runs before every page and route and answers 421, with no data, unless `Host` is exactly `127.0.0.1:<port>` or `localhost:<port>` |
| A web page you visit, calling `http://127.0.0.1:3100` directly | No, and it cannot change settings | The browser does not let it read the answer (no CORS headers); the proxy also refuses the event stream and any non-GET request from another site or origin (`Sec-Fetch-Site`, `Origin`), so a settings change from another site is a 403, and refuses being framed or fetched by another site, while a plain link from elsewhere still opens a page. The settings route also takes only `application/json`, which a cross-site form cannot send |
| Another user account on this Mac, or any local process | **Yes** | Loopback is shared by every user and process on the machine. The dashboard, like Booker's own control routes once a process holds the token, cannot tell them apart. Do not run it on a Mac other people log in to, and stop it when you do not need it |
| Someone with your login | Yes | They can read `.local/` directly anyway |

`pnpm dashboard:build` builds it (`next build`, a few seconds, about 1.4 GB of memory at peak); `pnpm check` lints it with Biome, typechecks it with the repository's TypeScript 7 (`tsc -p apps/dashboard`), and runs its tests, but does not build it. Next.js 16.3 type-checks through the `tsc` CLI by default (`experimental.useTypeScriptCli`), so TypeScript 7 needs no extra flag.
