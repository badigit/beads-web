# Project Conventions

## Tech Stack

### Frontend
- **React** 18.3 + **Next.js** 14.2 (App Router, static export via `output: 'export'`)
- **TypeScript** 5.x (strict mode)
- **Tailwind CSS** 3.4 + `tailwindcss-animate` + `@tailwindcss/typography`
- **Radix UI** primitives (dialog, dropdown, toast, tooltip, tabs, select, popover, scroll-area, alert-dialog)
- **Lucide React** for icons
- **Motion** (framer-motion successor) for animations
- **date-fns** for date formatting
- **react-markdown** + rehype-highlight for markdown rendering
- **recharts** for charts
- **@dnd-kit** for drag-and-drop (kanban columns)
- **class-variance-authority** + **clsx** + **tailwind-merge** for className composition

### Backend
- **Rust** (edition 2021) with **Axum** 0.7
- **rusqlite** (bundled) for local project/tag metadata
- **mysql_async** 0.34 for Dolt SQL connections
- **rust-embed** — compiles `../out/` (Next.js build) into the binary
- **notify** 6 for filesystem watching (SSE)
- **tokio** full async runtime
- **thiserror** for error types
- **tracing** for logging

### Build & Deploy
- Frontend: `npm run build` → static export to `out/`
- Backend: `cargo build --release` (embeds `out/` into binary)
- **IMPORTANT**: Must rebuild backend after every frontend build (rust-embed)
- CI: GitHub Actions (`release.yml`) — cross-platform builds (macOS arm64/x64, Linux x64, Windows x64)
- Node 20 in CI

## Architecture

- **Style**: Monolithic SPA with embedded backend. Frontend is a static Next.js export served by the Rust binary.
- **Data flow**: React hooks → `src/lib/api.ts` (fetch wrapper) → Axum REST API → rusqlite / bd CLI / Dolt SQL / filesystem
- **Mutations**: Bead CRUD goes through `bd` CLI via `POST /api/bd/command` (whitelisted commands). Project/tag CRUD via direct SQLite.
- **Real-time**: SSE file watcher for filesystem projects; 15s polling for `dolt://` projects
- **Error handling**: `fetchApi()` throws on non-OK responses with parsed error body. Components use try/catch + state.
- **State management**: Local React state + custom hooks. No global store (no Redux/Zustand/Context).
- **Validation**: Manual validation in components and API handlers. No validation library.
- **`dolt://` prefix**: Convention for Dolt-only projects without filesystem path. Frontend guards skip filesystem-dependent API calls.

## Structure

```
src/
  app/                    # Next.js App Router pages
    layout.tsx            # Root layout (fonts, toaster, devtools)
    page.tsx              # Home — project list
    project/
      page.tsx            # Project view (Suspense wrapper)
      kanban-board.tsx    # Main kanban board (stateful orchestrator)
    settings/
      page.tsx            # Settings page
  components/
    ui/                   # Reusable primitives (shadcn/ui style wrappers over Radix)
    *.tsx                 # Feature components (bead-card, bead-detail, epic-card, etc.)
  hooks/
    use-*.ts              # Custom hooks (data fetching, file watching, filters)
  lib/
    api.ts                # HTTP API layer (fetch wrapper, all endpoints)
    cli.ts                # bd CLI wrapper (addComment, updateStatus, closeBead, createBead)
    beads-parser.ts       # Parse beads from API response, group by status
    db.ts                 # Local SQLite types/helpers
    utils.ts              # cn() and other utilities
  types/
    index.ts              # All TypeScript interfaces/types

server/
  src/
    main.rs               # Axum server setup, static file serving, route registration
    db.rs                  # SQLite DB (projects, tags, relationships)
    dolt.rs                # Dolt SQL connection pool
    routes/
      mod.rs               # Route module exports
      beads.rs             # GET /api/beads (read from bd CLI or Dolt)
      cli.rs               # POST /api/bd/command (whitelisted bd subcommands)
      dolt.rs              # Dolt status/databases endpoints
      projects.rs          # CRUD for projects
      git.rs               # Worktree, PR, branch status endpoints (shells to git/gh)
      fs.rs                # Filesystem browsing, open-external
      memory.rs            # Knowledge base CRUD
      agents.rs            # Agent config read/update
      watch.rs             # SSE file watcher
      worktree.rs          # Worktree management
```

## Naming

- **Files**: kebab-case (`bead-detail.tsx`, `use-beads.ts`, `beads-parser.ts`)
- **Components**: PascalCase exports (`BeadDetail`, `KanbanColumn`, `CommentList`)
- **Hooks**: `use-*.ts` files, `useCamelCase` exports (`useBeads`, `useFileWatcher`)
- **Types**: PascalCase interfaces/types in `src/types/index.ts`. No `I` prefix.
- **Props**: `ComponentNameProps` interface exported alongside component
- **Rust**: snake_case files and functions, PascalCase structs. `//!` doc comments on modules.
- **CSS**: Tailwind utility classes only. Dark mode via `class` strategy. HSL CSS variables for theme colors.
- **Imports**: Enforced order via ESLint `import/order` — builtin > external > internal (@/) > relative > type. Empty line between groups.

## Patterns

- **Component structure**: `"use client"` directive → imports → types/interfaces → helper functions → exported component
- **Hook pattern**: Return typed result object (`UseXxxResult`). Internal state + useEffect for data fetching. `useCallback` for stable references.
- **API layer**: Single `api.ts` with namespace objects (`api.git.prStatus(...)`, `api.beads.read(...)`)
- **CLI layer**: `cli.ts` wraps `api.bd.command()` with typed functions (`addComment`, `updateStatus`)
- **UI primitives**: shadcn/ui pattern — Radix primitive + `cn()` + CVA variants. Files in `src/components/ui/`.
- **Fonts**: Space Grotesk (headings) + Plus Jakarta Sans (body), loaded via `next/font/google`
- **Icons**: Lucide React exclusively. `aria-hidden="true"` on decorative icons.

## Testing

- **Frontend**: Vitest 4 (`npm test` = `vitest run`; `npm run test:watch` for watch mode). Config in `vitest.config.ts`: jsdom environment, `globals: true`, setup file `src/test-setup.ts` (@testing-library/jest-dom), `@` alias → `./src`.
- **Component/hook tests**: Testing Library (`@testing-library/react`) — render + user interaction, no snapshot testing.
- **Test file layout**: `__tests__/*.test.ts(x)` next to the code under test (`src/lib/__tests__/`, `src/hooks/__tests__/`, `src/components/__tests__/`); co-located `*.test.ts` also works. Currently 15 files / 120 tests.
- **Vitest excludes** (see `vitest.config.ts`): `tests/**` (Playwright e2e), `.worktrees/**`, `node_modules`, `dist`, `out`.
- **E2E**: Playwright (`playwright.config.ts`, specs in `tests/`, e.g. `tests/themes.spec.ts`) — chromium, baseURL localhost:3008, needs a running dev server.
- **Backend**: Rust built-in `#[cfg(test)]` with `#[test]` functions, run via `cargo test`. `tempfile` in dev-dependencies.
- **Full pre-commit gate**: `npm run precommit:full` — lint + typecheck + build + `cargo clippy -- -D warnings` + `cargo test`.

## Do NOT Use

- **Global state libraries** (Redux, Zustand, Jotai) — not used, local state only
- **CSS modules or styled-components** — Tailwind only
- **Manually editing `output: 'export'` to run the dev server** — no longer needed: the config applies it only in production builds and proxies `/api/*` to the backend in dev
- **`bd edit`** — opens $EDITOR, blocks agents
- **Direct file mutations** — always go through `bd` CLI or API
- **`I` prefix on interfaces** — not used in this codebase
- **Repository pattern over SQLite** — direct rusqlite queries in route handlers
- **Try-catch in route handlers (Rust)** — use `Result` types and `impl IntoResponse`
