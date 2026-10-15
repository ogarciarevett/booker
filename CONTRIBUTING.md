# Contributing

Thanks for helping. This guide covers setup, the checks every change must pass, and the rules that keep a public repository free of secrets and personal data.

## Quick path

1. Install Node.js 24 or later, [pnpm](https://pnpm.io/), and [gitleaks](https://github.com/gitleaks/gitleaks#installing) **8.30.1** (the version pinned as `GITLEAKS_VERSION` in [CI](.github/workflows/ci.yml)).
2. Run `pnpm install`. The `prepare` script installs the git hooks through lefthook. If hooks are missing, run `pnpm exec lefthook install`.
3. Run `pnpm check` (lint, typecheck, tests, export privacy scan) before every commit.

## Checks

| Check | Where it runs | What it does |
|-------|---------------|--------------|
| `gitleaks` | pre-commit hook and CI (full history) | Blocks secrets and Spanish phone numbers |
| `pnpm lint` | pre-commit hook and CI | Biome lint and format check |
| `pnpm typecheck` | pre-commit hook and CI | Strict TypeScript |
| `pnpm test` | CI (run it locally too) | Vitest |
| `pnpm privacy:scan` | `pnpm check` | Requires zero unapproved personal values in exportable text and reviewed media |
| Commit message | commit-msg hook | Conventional Commits via [`scripts/check-commit-message.ts`](scripts/check-commit-message.ts) |

## How we work

- **Strict TDD.** Write a failing test first, make it pass, then refactor. Tests live beside the behavior they verify.
- **Work-unit commits.** Each commit delivers one coherent behavior with its tests and docs. Avoid "models", then "services", then "tests".
- **Conventional Commits.** `<type>(<scope>)?: <summary>`, for example `feat(offers): rank offers by group cost`.
- **Reviewable pull requests.** Aim for about 400 changed lines or fewer. Larger features are split into chained pull requests.
- **Commit attribution.** AI or tool attribution trailers are not required in commits. The PR disclosure below is required; preserve any applicable human credit or DCO sign-off.

## Contribution workflow and AI assistance

AI assistance is welcome for contributors and maintainers. Work on a topic branch and open a pull request to `main` or the default branch. Agents must never push directly to either branch, even with the owner's credentials or authorization. Only the human repository owner may choose a direct change, subject to existing protections; account authentication alone cannot establish human operation.

In the PR description, disclose each AI tool, the model identifier and version when exposed, and the scope of assistance. If a model or version is hidden, write `unknown (not exposed)` instead of guessing. This disclosure belongs in the PR body and does not require an AI attribution trailer in commits.

Example (replace with accurate details):

```text
AI assistance: tool = coding assistant; model = unknown (not exposed).
Version: unknown (not exposed).
Scope: helped draft the implementation and tests.
Human review: identify the human who reviewed and understands the change.
Validation: list checks actually run, results, and checks not run.
```

A human contributor remains responsible for reviewing and understanding the complete change, testing its behavior, checking security and privacy, and confirming the right to contribute code, media and dependencies under their applicable licenses. AI assistance does not waive human review, CI, CLA/DCO, signing or any other existing requirement. Keep strict TDD, work-unit commits and Conventional Commits.

Never submit secrets, personal data or confidential material to external AI tools. Disclosure requires no sensitive prompts, private conversations, transcripts or hidden reasoning. Share only tool/model details, scope, human accountability and actual validation evidence.

## Language policy

Everything committed is in English: code, comments, identifiers, docs, prompts, tests, and commit messages. The single exception is `locales/es-ES/*.yaml`, which holds exact spoken text such as the AI disclosure and the recording notice.

## Personal data policy

- Real errands, participants, provider lists, voice samples, recordings, transcripts, and databases belong in `.local/`, which is ignored.
- Examples and tests use fictional providers and fictional phone numbers in the `+1 555 01xx` range.
- gitleaks rejects Spanish phone numbers and known key formats (ElevenLabs, Claude Code OAuth, plus the upstream rule set). If it flags a false positive, change the fixture rather than weakening the rule.
- Never put secrets in prompts, frontend code, logs, or test fixtures. Use `.env` (ignored) and document new variables in `.env.example` with empty values.

## Agent skills

Project skills for AI coding agents are listed in [docs/agent-skills.md](docs/agent-skills.md).

## Reporting vulnerabilities

Do not open public issues for security problems. Follow [SECURITY.md](SECURITY.md).

## Public tree privacy

Before a public export, follow [public readiness](docs/public-readiness.md). The privacy scan reports only file locations and fails on unapproved contacts, personal identifiers, symlinks and changed media. A public repository needs an explicit owner yes, even when the current tree passes.
