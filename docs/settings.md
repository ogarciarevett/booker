# Settings

Every setting Booker reads is listed in one catalog, [`src/settings/catalog.ts`](../src/settings/catalog.ts): its group, whether it is a secret, what it is for, how a value is validated, and whether a change applies at once or after a restart.

## Where a value comes from

Booker resolves each setting at the moment it uses it, in this order:

| Order | Source | Label | Notes |
|-------|--------|-------|-------|
| 1 | `.env` | `.env` file | Node loads `.env` into the environment when `pnpm booker` starts. A value there always wins |
| 1 | Shell environment | Terminal environment | Same rank as `.env`; a variable set in the shell also wins over the same name in `.env` (Node's rule) |
| 2 | Saved settings | Dashboard (SQLite) or Keychain | Non-secret values in the `settings` table of `booker.db`; secrets in the macOS Keychain |
| 3 | Nothing | Not set | The setting's default applies, if it has one |

An empty or blank value counts as unset, so a saved value applies.

To tell `.env` from the shell, `pnpm booker` reads the names `.env` defines with Node's own parser (`util.parseEnv`, the one `--env-file-if-exists` uses) and keeps only the names; the value in effect is always the environment's. A name in both `.env` and the shell is labelled `.env` file. If `.env` exists but cannot be read, Booker prints a warning (with the error code only) and labels every environment value as coming from the environment. `.env` changes apply after a restart, as before.

`BOOKER_DATA_DIR` and `BOOKER_HOST` are read from the environment only: the database cannot say where it lives, and Booker listens on loopback alone.

## Catalog

"Live" settings are read at each use, so a saved change applies without a restart. "Restart" settings are read when Booker starts.

| Setting | Group | Secret | Applies |
|---------|-------|--------|---------|
| `BOOKER_OWNER_NAME` | Owner | no | live (each call) |
| `PUBLIC_BASE_URL` | Public URL | no | live (each agent sync) |
| `ELEVENLABS_API_KEY` | ElevenLabs | yes | live (each call, reconciliation check, CLI run) |
| `ELEVENLABS_WEBHOOK_SECRET` | ElevenLabs | yes | live (each webhook delivery) |
| `ELEVENLABS_VOICE_ID` | ElevenLabs | no | live (each agent sync) |
| `BOOKER_AGENT_SCRIPT` | ElevenLabs | no | live (each agent sync); defaults to `locales/es-ES/agent.yaml` |
| `TWILIO_ACCOUNT_SID` | Twilio | no | live (each call, phone import) |
| `TWILIO_AUTH_TOKEN` | Twilio | yes | live (each call, phone import) |
| `TWILIO_PHONE_NUMBER` | Twilio | no | live (each phone import) |
| `TYPESAFE_API_KEY` | Jev | yes | live; only `pnpm route-task` uses Jev today, and it reads the environment only |
| `TYPESAFE_BASE_URL` | Jev | no | live; same as above |
| `OPENAI_API_KEY` | Model keys | yes | live; nothing reads it yet |
| `ANTHROPIC_API_KEY` | Model keys | yes | live; nothing reads it yet |
| `GEMINI_API_KEY` | Model keys | yes | live; nothing reads it yet |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Tracing | no | restart (`pnpm serve:traced`) |
| `OTEL_SERVICE_NAME` | Tracing | no | restart |
| `OTEL_SDK_DISABLED` | Tracing | no | restart |
| `BOOKER_PORT` | Server | no | restart (also read by `pnpm booker call`) |
| `BOOKER_HOST` | Server | no | restart; environment only |
| `BOOKER_DATA_DIR` | Server | no | restart; environment only |

The dashboard's own variables (`BOOKER_URL`, `BOOKER_REPO_ROOT`, `PHOENIX_URL`, `PORT`) configure the dashboard process, which must find Booker before it can ask it anything, so they stay in its environment and outside the catalog. Phoenix's `PHOENIX_*` variables belong to `pnpm phoenix`.

`BOOKER_AGENT_SCRIPT` selects a YAML script by a path relative to the repository root. Absolute paths, parent traversal, and control characters are refused. At sync, the file must be readable and satisfy the existing agent script schema. Errors name the setting without repeating the path or file contents. When unset everywhere, it uses the Spanish default; blank values count as unset. Custom paths get separate agents. Changing this setting takes effect when you next run `pnpm booker agent sync`, which selects the active agent IDs for calls. See the [role-play test call](live-calls.md#role-play-test-call) instructions.

## Secrets and the macOS Keychain

Secrets saved from the dashboard are generic passwords in the owner's login Keychain, service `booker`, account the setting's name (for example `booker` / `ELEVENLABS_API_KEY`). Keychain Access shows them under that name. Booker uses [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) 1.3.0, a prebuilt native binding with no install script, through its async API, so a Keychain call never blocks the server.

- Values never leave Booker's process: logs, errors, API answers, and spans carry at most whether a secret is configured and, for one of at least 12 characters, its last four.
- `serve` registers every secret it reads for redaction from logged errors and exported spans.
- macOS may ask "node wants to use your confidential information stored in "booker" in your keychain" when a different `node` binary (after a Node upgrade, say) first reads an item. Choose **Always Allow** for the `node` you run Booker with. The prompt never blocks requests in flight.
- On a system without the macOS Keychain (CI, Linux), secrets come from `.env` or the environment only, and saving one is refused with a message saying so.
- A Keychain that cannot be read (locked, as over SSH or under launchd, where macOS answers "User interaction is not allowed") never stops Booker. `serve` prints `Keychain unavailable: …` and carries on with `.env`, the environment, and the webhook secret `agent sync` saved; a call request says the settings could not be read; and the post-call webhook answers 503 with `Retry-After`, so ElevenLabs delivers again later.

`pnpm booker agent sync` still keeps the secret of a post-call webhook it had to create in `.local/secrets/elevenlabs-webhook-secret`; `serve` uses that file only when `ELEVENLABS_WEBHOOK_SECRET` is unset everywhere else.

## Non-secret values in SQLite

The `settings` table (`name`, `value`, `updated_at`; migration `0008`) holds non-secret values only. `serve` and the CLI commands open the database file for each read and close it after (`settingsInDatabaseFile` in `src/persistence/sqlite-setting-store.ts`); reading never creates the file, and before the server's first start there is simply nothing saved.

## Control API

The server serves the settings to the dashboard on its control routes, behind the control token like every other one (`src/http/control-settings.ts`), and never through Tailscale Funnel.

| Route | Answers |
|-------|---------|
| `GET /control/settings` | `{ groups, settings }`: every catalog setting with `name`, `group`, `description`, `secret`, `applies`, `source` (`dotenv`, `environment`, `store`, `unset`), `configured`, `editable`, `restartPending`, and `value` for a plain setting or `lastFour` for a secret of at least 12 characters. Never a secret's value |
| `PUT /control/settings/:name` `{ value }` | Trims and validates the value against the catalog, saves it (a secret in the Keychain, anything else in SQLite), and answers the setting as `GET` shows it. `400 invalid_value` with the catalog's message (never the value), `400 invalid_request` for a malformed body, `404 unknown_setting`, `409 set_in_environment` when `.env` or the environment defines it, `409 environment_only` for `BOOKER_DATA_DIR` and `BOOKER_HOST`, `503 secret_store_unavailable` without a Keychain |
| `DELETE /control/settings/:name` | Removes the saved value, with the same refusals, and answers the setting as it is now |

`editable` is false for a value from `.env` or the environment (it wins, so it must be removed there first) and for the environment-only settings. `restartPending` is true for a restart-only setting whose value in effect differs from the one Booker started with.

Each save or removal writes one line to the server log, such as `setting ELEVENLABS_API_KEY saved (store: keychain)` (name, action, store; never a value), and sends a `setting` event (`{ type, name, action, at }`) on `GET /control/events`, so open dashboards refresh.

## Dashboard

The dashboard's **Settings** page (`/settings`) lists every setting by group with a badge for its source: **.env file**, **Terminal environment**, **Saved in dashboard**, **Keychain**, or **Not set**.

- A value from `.env` or the environment is read-only, with "Defined in .env (or your terminal environment); remove it there to edit it here."
- A secret's field is write-only (`type=password`, `autocomplete=off`): it is never filled in. Once saved it shows "Configured · ends in …1234" with **Replace** and **Remove**.
- A restart-only setting that changed since Booker started shows "Restart Booker to apply", and so does a banner at the top.
- The page follows `setting` events, so a change made in another tab shows up at once.

Changes go from the browser to the dashboard's own `PUT` and `DELETE /api/settings/<name>` (`apps/dashboard/features/settings/server/settings-route.ts`), which adds the control token on the server and forwards them to Booker; the browser never sees the token or Booker's address. The proxy refuses any such request from another site or origin, and the route accepts only `application/json`.

## Tests and the manual Keychain check

Automated tests never touch the real Keychain: they use the in-memory secret store, and the Keychain adapter's own tests run against a fake keyring entry that fails a missing item the way keyring-rs does. One opt-in check uses the real login Keychain with a throwaway service name and removes what it saved:

```sh
BOOKER_KEYCHAIN_TEST=1 pnpm vitest run tests/secret-store.contract.test.ts
```

It runs only on macOS with that variable set; CI never sets it.
