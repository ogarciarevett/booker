# Live calls

Real calls run Booker on the owner's Mac: an ElevenLabs agent speaks through a Twilio number and calls back into Booker's voice tools and post-call webhook, which Tailscale Funnel exposes, and nothing else.

## Runbook: the first call

Do these in order. Steps 1 and 3 change things outside this repository, so they are yours to run.

1. **Environment.** Add to `.env` every variable in [Environment variables](#environment-variables) marked "first call", including `BOOKER_OWNER_NAME` (whom the agent says it calls for) and `PUBLIC_BASE_URL=https://public.booker.example`.
2. **Server.** In its own terminal, run `pnpm booker serve` and leave it running. It should print `Calls: on`. Check it with `curl http://127.0.0.1:8787/healthz`, which answers `{"status":"ok"}`.
3. **Public routes.** Expose only the voice tools and the webhook through Tailscale Funnel, in the background:

   ```sh
   tailscale funnel --bg --set-path /voice-tools http://127.0.0.1:8787/voice-tools
   tailscale funnel --bg --set-path /webhooks http://127.0.0.1:8787/webhooks
   tailscale funnel status
   ```

   Then check from outside that only those two paths answer, and that Booker itself answers them:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://public.booker.example/healthz
   # expected: 404 (not exposed)
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://public.booker.example/voice-tools/x/get-errand-context
   # expected: 401 (Booker refused a request without the key), and a log line in the server terminal
   ```

   `tailscale funnel reset` removes every Funnel mapping on this machine when you are done.
4. **Agents.** `pnpm booker agent sync`. It reuses the post-call webhook you made in the dashboard (same URL) and turns its retries on.
5. **Phone number.** `pnpm booker phone import`.
6. **Call your own phone.** Copy the test errand and put your own number as its provider's `phoneE164`:

   ```sh
   mkdir -p .local/errands
   cp examples/errands/test-call.example.json .local/errands/test.json
   # edit .local/errands/test.json: providers[0].phoneE164 = your phone, in E.164
   pnpm booker call --to <your phone> --errand .local/errands/test.json --wait
   ```

   Answer it: the agent introduces itself as an AI assistant calling for you, asks the errand's questions, and hangs up. The command then prints what it recorded.

## What runs where

| Piece | Where | Notes |
|-------|-------|-------|
| Booker server | `127.0.0.1:8787` on the owner's Mac | Never listens on any other address |
| Public exposure | Tailscale Funnel in front of `127.0.0.1` | Only `/voice-tools/*` and `/webhooks/*`; `/healthz`, `/control/*`, and everything else stay local |
| Database | `.local/data/booker.db` (SQLite, migrated on every start) | Errands, offers, calls, grants, bookings, transcripts; the folder is created with mode 0700 |
| Voice-tools key | `.local/secrets/voice-tools-key` (mode 0600, folder 0700) | Generated on the first start and reused after; the agent sends it as `X-Booker-Tools-Key` |
| Control token | `.local/secrets/control-token` (mode 0600) | Generated on the first start; `pnpm booker call` sends it to the local control routes |
| ElevenLabs ids | `.local/elevenlabs.json` (mode 0600) | Written by `agent sync` and `phone import`, read by the server for every call |
| Agents and phone number | ElevenLabs, with the Twilio number imported | Reach the two public routes through the Funnel URL |

Everything in `.local/` is ignored by git. Run one server per database: Booker is a single instance (see [architecture](architecture.md#local-server)).

## Environment variables

`pnpm booker` starts Node with `--env-file-if-exists=.env`, so Node loads `.env` and a variable already set in the shell wins over it. A value in `.env` or the environment always wins; otherwise Booker uses the value saved from the dashboard (non-secret values in SQLite, secrets in the macOS Keychain), resolved at each use, so most changes apply without a restart. Booker's code reads only the names `.env` defines, to show where each value comes from. An empty value counts as unset. Errors name a missing or invalid variable but never print its value. See [settings.md](settings.md) for the full catalog, the sources, and which settings need a restart.

Live calls require the owner name, public URL, ElevenLabs credentials and consented voice, plus Twilio account credentials and an owned phone number. Agent and imported phone identifiers are generated into ignored `.local/elevenlabs.json`; they are not environment variables. Without a webhook secret the server still starts, but calls stay off and webhook deliveries receive 503.

The complete reference matches the README and `.env.example`. Keep credentials in 1Password, with the macOS Keychain as the local cache. Dashboard overrides must be exported in its launching shell; the root `.env` is only loaded by the Booker command.

| Name | Required for | Where to get it | Default |
| --- | --- | --- | --- |
| `BOOKER_OWNER_NAME` | Live calls: named owner in disclosure | Owner supplied name, kept locally | Unset |
| `PUBLIC_BASE_URL` | Agent setup: public tool and webhook URLs | Owner configured Tailscale Funnel HTTPS URL | Unset |
| `ELEVENLABS_API_KEY` | Agent setup, phone import, live calls and reconciliation | ElevenLabs workspace API keys, stored in 1Password | Unset |
| `ELEVENLABS_WEBHOOK_SECRET` | Signed webhooks and live call readiness | ElevenLabs post-call webhook signing secret, stored in 1Password | Unset; fallback to `.local/secrets/elevenlabs-webhook-secret` |
| `ELEVENLABS_VOICE_ID` | Agent setup: consented owner voice | ElevenLabs voice library after consent and verification | Unset |
| `BOOKER_AGENT_SCRIPT` | Agent sync: selects the script and a separate agent pair for custom paths | Dashboard or shell; repository-relative YAML path | `locales/es-ES/agent.yaml` |
| `TWILIO_ACCOUNT_SID` | Phone import and ending calls | Twilio account console, stored in 1Password | Unset |
| `TWILIO_AUTH_TOKEN` | Phone import and ending calls | Twilio account console, stored in 1Password | Unset |
| `TWILIO_PHONE_NUMBER` | Phone import: outbound number | Owned Twilio number, E.164, kept locally | Unset |
| `TYPESAFE_API_KEY` | Optional Jev routing in `pnpm route-task` | TypeSafe account API key, stored in 1Password | Unset; conservative default row |
| `TYPESAFE_BASE_URL` | Optional Jev endpoint override | TypeSafe deployment configuration | `https://api.typesafe.ai` |
| `OPENAI_API_KEY` | Future OpenAI model profile; currently unused | OpenAI project API keys, stored in 1Password | Unset |
| `ANTHROPIC_API_KEY` | Future Anthropic model profile; currently unused | Anthropic console API keys, stored in 1Password | Unset |
| `GEMINI_API_KEY` | Future Gemini model profile; currently unused | Google AI Studio API keys, stored in 1Password | Unset |
| `BOOKER_HOST` | Server binding; environment only | Local configuration, loopback only | `127.0.0.1` |
| `BOOKER_PORT` | Server and call client | Local configuration, integer from 1 to 65535 | `8787` |
| `BOOKER_DATA_DIR` | Database location; environment only | Local configuration, relative to repository or absolute | `.local/data` |
| `BOOKER_URL` | Dashboard connection to Booker | Local server URL; match its port | `http://127.0.0.1:8787` |
| `BOOKER_REPO_ROOT` | Dashboard control token lookup | Absolute path to the checkout holding `.local/secrets/control-token` | Two directories above dashboard working directory |
| `PHOENIX_URL` | Dashboard links to local traces | Local Phoenix URL | `http://127.0.0.1:6006` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Optional traces with `pnpm serve:traced` | Local Phoenix receiver: `http://127.0.0.1:6006/v1/traces` | Unset; tracing off |
| `OTEL_SERVICE_NAME` | Trace service and Phoenix project name | Local configuration | `booker` |
| `OTEL_SDK_DISABLED` | Explicit tracing disable switch | Local configuration, `true` or `false` | Unset; endpoint decides |
| `NODE_ENV` | Node and Next.js runtime mode | Runtime launcher | Development for dev; production for build and start |
| `PORT` | Dashboard request guard; managed by Next.js | Next.js sets it from the launcher port argument | `3100` in `pnpm dashboard` |
| `NEXT_TELEMETRY_DISABLED` | Next.js telemetry switch; managed | Dashboard launcher forces it | `1` |
| `PHOENIX_HOST` | Phoenix binding; managed | `pnpm phoenix` forces loopback | `127.0.0.1` |
| `PHOENIX_PORT` | Phoenix UI and OTLP receiver; managed | `pnpm phoenix` forces the port | `6006` |
| `PHOENIX_WORKING_DIR` | Phoenix storage; managed | `pnpm phoenix` forces local storage | `<repo>/.local/phoenix` |
| `PHOENIX_TELEMETRY_ENABLED` | Phoenix telemetry switch; managed | `pnpm phoenix` forces telemetry off | `false` |

## Running the server

```text
$ pnpm booker serve
Booker is listening on http://127.0.0.1:8787 (Ctrl+C stops it).
Database: .local/data/booker.db
Voice-tools key: generated at .local/secrets/voice-tools-key
Control token: generated at .local/secrets/control-token
Calls: on (agents and number from .local/elevenlabs.json); stale calls are checked every minute
2026-10-06T12:35:18.242Z GET /healthz 200 2ms
2026-10-06T12:35:18.254Z POST /voice-tools/call-x/get-errand-context 401 2ms
SIGINT received: shutting down (Ctrl+C again forces it).
Stopped.
```

| Behavior | Detail |
|----------|--------|
| Request log | One line per request: time, method, path, status, duration. Never headers, bodies, query values, keys, or tokens |
| Errors | The first line of the error only, with the key and the webhook secret redacted |
| Transcript retention | Transcripts older than 30 days are purged on start and every hour |
| Reconciliation | Every minute, with the API key in effect then: a call still open 5 minutes after it was placed that ElevenLabs reports `failed` ends as `no_answer` |
| Booking | Standing rules are not loaded yet, so nothing is booked automatically: `request-commit-permission` answers "not granted" |
| Shutdown | Ctrl+C or SIGTERM stops new connections, gives in-flight requests up to 5 seconds (and handlers still running after that another 5), then closes the database. A second Ctrl+C ends the process at once |
| Webhook secret | Read at each delivery. While none is set, `serve` prints `Post-call webhook: off until ELEVENLABS_WEBHOOK_SECRET is set` and answers deliveries with 503 and `Retry-After`, so a secret saved later applies without a restart |
| Exit codes | `0` stopped cleanly, `1` could not start (configuration, key file, or port), `2` unknown command or arguments |
| Tracing | Off. `pnpm serve:traced` runs the same server and sends OpenTelemetry spans to a local Phoenix; see [observability](observability.md) |

## The voice-tools key

The key is 32 random bytes in base64url. It is never logged or printed; `agent sync` pushes it to ElevenLabs as the `booker_tools_key` workspace secret.

| Situation | What to do |
|-----------|------------|
| `serve` says the key file is open to other users | Run the `chmod 600` command it prints. If anyone else may have read the file, delete it instead |
| `serve` says the file is not a valid key | Delete it |
| Rotating the key | Delete the file, start `serve` again, then run `pnpm booker agent sync` |

Booker refuses a key file other users can read rather than fixing its mode, as OpenSSH does with a private key: only the owner can tell whether it leaked.

## Syncing the agents

`pnpm booker agent sync` makes the ElevenLabs workspace match this repository. It needs `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `PUBLIC_BASE_URL`, and the voice-tools key (run `serve` once first). Running it again only updates what the first run created; it matches each resource by its exact name, and the webhook by its URL.

| Resource | What sync does |
|----------|----------------|
| Workspace secret `booker_tools_key` | Holds the voice-tools key; updated on every run, so rotating the key is: delete the key file, restart `serve`, run sync |
| Nine webhook tools | `get_errand_context`, six `record_*` tools (one per value shape, since ElevenLabs tools cannot take a union), `request_commit_permission`, `report_commit_outcome`; all point at `PUBLIC_BASE_URL/voice-tools/{call_id}/...` with `X-Booker-Tools-Key` from the secret |
| Post-call webhook | Reuses the workspace webhook whose URL is `PUBLIC_BASE_URL/webhooks/elevenlabs/post-call`, or creates one and saves its secret to `.local/secrets/elevenlabs-webhook-secret` (0600, never printed); retries are turned on either way |
| Agents `booker-quote` and `booker-commit` (tag `booker`) | Spanish, the owner's voice on `eleven_v4_turbo` with expressive mode on (so the prompt's few audio tags such as `[laughs]` sound natural), the model matrix's in-call model (`gpt-6-sol`, checked against ElevenLabs' list first), temperature 0, one tool call at a time, `end_call`, patient turn-taking, 30 s of silence ends the call, 10 minutes at most, no recorded audio, one call at a time, transcripts and initiation failures to the webhook. The quote agent never gets the commit tools |

The first message and the prompts come from `BOOKER_AGENT_SCRIPT`, defaulting to [`locales/es-ES/agent.yaml`](../locales/es-ES/agent.yaml), the only place their Spanish text lives. The default first message says, in one short line, that the caller is `{{owner_name}}`'s AI assistant; a test keeps that notice in it. The default prompts ask for a natural, everyday tone, the purpose of the call in one sentence right after the greeting, and audio tags used sparingly. Ids go to `.local/elevenlabs.json` (0600).

### Role-play test call

Select the English GPU buyer script in the dashboard's Settings page, or set it for sync in the shell:

```sh
BOOKER_AGENT_SCRIPT=locales/en-US/roleplay-gpu.yaml pnpm booker agent sync
```

This creates or updates `booker-quote-roleplay` and `booker-commit-roleplay`, keeping the Spanish `booker-quote` and `booker-commit` agents intact. Other custom script paths use a stable SHA-256 path suffix to keep their pairs separate too. Sync saves the selected pair as the active IDs in `.local/elevenlabs.json`; the running server reads those IDs at the next call, without a restart. The role-play pair has only `end_call`, no errand or booking tools, and a three-minute cap. Audio recording remains off; local transcript retention remains 30 days.

Use the normal `pnpm booker call` command with a test brief under `.local/` and a consenting test contact listed among its providers. The exact first message identifies the AI booker and asks permission; the fictional H100 or H200 buyer conversation continues only with consent and ends immediately on refusal or discomfort. No payment or real commitment is allowed.

To restore Spanish calls, select the default path and sync again:

```sh
BOOKER_AGENT_SCRIPT=locales/es-ES/agent.yaml pnpm booker agent sync
```

If you saved the role-play path in the dashboard, remove or replace that saved setting as well. Merely removing the variable does not switch the active IDs until the next sync.

### Demo test call

Use `BOOKER_AGENT_SCRIPT=locales/en-US/demo.yaml pnpm booker agent sync` for a short English introduction to Booker and an optional fictional provider quote demonstration. It asks permission first, then offers to let the contact play a restaurant or repair service provider. Use the same local test brief and consenting contact flow above.

Sync selects separate `booker-quote-demo` and `booker-commit-demo` agents, preserving both Spanish and GPU role-play agents. The demo uses only `end_call`, has the same 180-second cap, aims for about two minutes, and makes no real booking. Re-sync the Spanish default afterward to restore normal calls.

## Importing the phone number

`pnpm booker phone import` makes ElevenLabs know the Twilio number the agents call from (`TWILIO_PHONE_NUMBER`, with `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, plus `ELEVENLABS_API_KEY`). It looks the number up first, so it imports it once and reuses it after, with SMS off, and saves its `phone_number_id` to `.local/elevenlabs.json`.

## Placing a call

`pnpm booker call --to <E.164> --errand <file> [--wait]` asks the running server to place one quote call; the server writes the database, so the command never opens it. The errand file must be under `.local/`, and `--to` must be the phone number of one of its providers: Booker never calls a number its brief does not name. The agent for quote calls never gets the commit tools.

```text
$ pnpm booker call --to +15550100100 --errand .local/errands/test.json --wait
Placed call call-6f1c… (conversation conv_…).
Waiting for the call to end (Ctrl+C stops waiting, not the call)...
Call call-6f1c… ended: completed.
Recorded:
  dates             known      2026-11-03 to 2026-11-14
  costItem:tuition  estimated  550.00 EUR (each-participant, charge)
Still unknown: seatsAvailable, location, deposit, cancellationPenalty
```

The command reaches the server's control routes on `127.0.0.1` with the control token; Funnel never exposes them. A call ends when its post-call webhook arrives (`completed` or `failed`), when ElevenLabs reports it never connected (`no_answer`), or through reconciliation.

| Message | What to do |
|---------|------------|
| The Booker server is not running | Start `pnpm booker serve` in another terminal |
| There is no control token yet | Start `pnpm booker serve` once |
| `ELEVENLABS_API_KEY` or `BOOKER_OWNER_NAME` is not set | Save it on the dashboard's Settings page (applies at the next call), or add it to `.env` and restart `serve` |
| The post-call webhook has no secret: set ELEVENLABS_WEBHOOK_SECRET first | Save it on the Settings page or in `.env`: without it Booker could not hear how a call ends, so it places none, and `serve` says `Calls: off until ELEVENLABS_WEBHOOK_SECRET is set` |
| There are no agents yet / no phone number yet | Run `pnpm booker agent sync` / `pnpm booker phone import`; no restart needed |
| `--to` is not the phone number of any provider | Put that number in the errand's `providers`, in E.164 |
| That provider has a call still open | Wait for it to end (at most about 15 minutes with reconciliation), or use another errand id |
| ElevenLabs ... answered HTTP 4xx | Check the agent and number in the ElevenLabs dashboard; run `agent sync` and `phone import` again |
| ElevenLabs did not start the call: <reason> | The reason is ElevenLabs' (often Twilio's), with phone numbers masked; for example "Account not authorized to call" means the Twilio account needs that country enabled in its geographic permissions |
