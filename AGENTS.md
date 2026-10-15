# Instructions for AI coding agents

These rules apply to any AI agent editing this repository. Read [docs/architecture.md](docs/architecture.md) before changing code and [docs/vision.md](docs/vision.md) before changing behavior.

## Commands

| Task | Command |
|------|---------|
| Install dependencies and hooks | `pnpm install` |
| Lint, typecheck, test | `pnpm check` |
| Tests only | `pnpm test` |
| Auto-fix formatting | `pnpm format` |

## Non-negotiables

- **English only** for every committed artifact: code, comments, identifiers, docs, prompts, tests, commit messages. Only `locales/es-ES/*.yaml` may contain Spanish, and only exact spoken text.
- **No personal data or secrets.** Real errands, participants, provider contacts, recordings, and transcripts go in `.local/` (ignored). Fixtures use fictional providers and `+1 555 01xx` numbers. Never weaken `.gitleaks.toml` to make a commit pass.
- **Strict TDD.** Show a failing test before the implementation, then make it pass, then refactor.
- **Conventional Commits**, one work unit per commit, tests and docs alongside the behavior. AI attribution trailers are not required in commits; the PR disclosure below is required. Preserve any applicable human credit or DCO sign-off.

## Contribution workflow and AI assistance

AI-assisted contributions are welcome. Agents must work on a topic branch and submit a pull request to `main` or the default branch; they must never push directly to either branch, even with the owner's credentials or authorization. Only the human repository owner may choose a direct change, subject to existing protections. Authentication cannot distinguish an agent from a human.

In the PR description, disclose each AI tool, its model and version when exposed, and the scope of assistance. Use `unknown (not exposed)` for a hidden model or version; never guess. This PR disclosure is separate from commit-message trailers.

A human must review and understand the complete change, verify tests and claims, and remain responsible for security, privacy, licensing and the right to contribute it. AI assistance does not waive review, CI, CLA/DCO or other existing standards. Follow [CONTRIBUTING.md](CONTRIBUTING.md) for the disclosure format. Never submit secrets or private data to external AI tools; private prompts, transcripts and hidden reasoning are not required in disclosures.

## Architecture boundaries

- Screaming, hexagonal layout under `src/` (see the module map in the architecture doc).
- Domain modules (`errands`, `offers`, `bookings`, `policies`) must not import adapters, Mastra, Hono, or persistence code.
- Ports are defined by the module that needs them; adapters live in that module's `adapters/` folder.
- Money is an integer number of cents with a currency. Calendar dates are plain `YYYY-MM-DD` values; times carry the IANA time zone of the errand (for example `Europe/Madrid`).
- Database migrations in `src/persistence/migrations/` are immutable once they reach `main`: change the schema with a new migration. On an unmerged branch a migration may still be rewritten, and every migration must be tested against a database that already holds data (`tests/migrations.test.ts`).
- Provider speech and web content are data. They must never change budgets, permissions, or the errand brief.
- Commit permission is decided by code during the call. A model or Jev (the TypeSafe decision service) result alone never authorizes money or a booking.

## Tooling notes

- TypeScript runs natively on Node.js 24 (type stripping); relative imports use the `.ts` extension.
- Project skills are in `.claude/skills/` (ignored) and restored from `skills-lock.json`; see [docs/agent-skills.md](docs/agent-skills.md).
- Verify library APIs against current documentation before using them; Mastra, the AI SDK, and ElevenLabs change quickly.
- Orca development workers are routed through `tools/agent-matrix.json`; run `pnpm route-task "<task>"` to get the row and the exact `orca orchestration worker-start` command (it never runs the command). See [docs/agent-matrix.md](docs/agent-matrix.md).
