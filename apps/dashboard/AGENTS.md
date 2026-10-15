# Dashboard agent notes

The repository rules in [../../AGENTS.md](../../AGENTS.md) apply here too. Keep everything that touches the control token in `lib/server/` (see [docs/observability.md](../../docs/observability.md#dashboard)). The block at the end is written by `next dev` and kept as is.

## Structure

| Folder | Holds |
|--------|-------|
| `app/` | Thin route files: metadata, `dynamic`, and one container each |
| `features/<name>/server/` | Server containers that read Booker and render the feature's components, plus server-side handlers; every module imports `server-only` |
| `features/<name>/components/` | Presentational components (props in, markup out) and the feature's client components |
| `components/` | Shared pieces (live updates, notices); `components/ui/` holds the shadcn/ui primitives |
| `lib/` | Cross-cutting helpers: formatting, the request guard, the control API types; `lib/server/` is the one Booker client |

Imports use the `@/` alias for the app root.

## Design system

- Tailwind CSS v4 (`postcss.config.mjs`) with the tokens in `app/globals.css`: neutral surfaces, one accent (`--primary`), and `--status-*` colors for data; dark mode follows the system (`prefers-color-scheme`). System fonts only, nothing fetched at runtime.
- shadcn/ui (new-york, Radix) primitives live in `components/ui/` as source. Add one with `pnpm dlx shadcn@<version> view <name>` and copy its file, rather than `shadcn add`, which installs unpinned dependencies; keep every dependency at least a day old.
- Icons come from `lucide-react`. A status always pairs its color or icon with a word.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
