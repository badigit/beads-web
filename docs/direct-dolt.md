# Direct Dolt deployment

The primary Windows deployment uses a single embedded frontend/backend binary and reads Beads databases directly from the central Dolt server.

## Build

```powershell
& "C:\Users\Dee\GitHub\beads-web\scripts\build-windows-direct.ps1"
```

The build produces `bin\beads-web-win-x64-direct.exe`. The upstream `bin\beads-web-win-x64.exe` remains unchanged for rollback.

Flags:

| Flag | Effect |
|---|---|
| `-SkipTests` | Skip `cargo test` (pre-commit runs it anyway). |
| `-NoRestart` | Leave the pm2 instance stopped after the build. |
| `-NoDeploy` | Build only. Nothing is copied, pm2 is not touched; the path to the built `.exe` is printed. |
| `-OutDir <path>` | Copy the binary to `<path>` instead of `bin\`. pm2 is not touched, so the live instance keeps running the old binary. |

The script installs npm dependencies only when `package-lock.json` changed, shares one `CARGO_TARGET_DIR` across worktrees (so a fresh worktree does not rebuild Rust from scratch), and stops the running pm2 instance before replacing the binary — Windows keeps a running `.exe` locked.

### Deployment is global — by design

`bin\` and the `beads-web` pm2 instance exist exactly once, in the **main repository**. A worktree has no `bin\` at all (it is untracked, so it is never created in a new worktree), so the script resolves the destination from the main repo root via `git rev-parse --git-common-dir` — the same technique already used for `CARGO_TARGET_DIR`.

Consequence: **a build launched from any worktree replaces the same live binary and restarts the same pm2 instance.** This is intentional — updating the live service on port 3056 is the point of the script, and that is exactly what an agent verifying a fix from a worktree needs. Two concurrent builds resolve last-writer-wins: nothing is silently corrupted, the earlier deployment simply loses. Re-running a build is cheaper than a locking scheme. The script prints `Deploying to shared binary: <path>` so the global effect is visible in the log rather than implied.

If you need a build **without** replacing the live binary, use `-NoDeploy` or `-OutDir`.

## Building from a git worktree

`rust-embed` needs the frontend directory to exist at compile time, but `out/` is an untracked build artifact and is absent from a fresh worktree. Previously this meant the server crate could not even be compiled there, so the pre-commit `cargo clippy` failed on any `server/` change made in a worktree.

`server/build.rs` now resolves the directory and passes it to the `#[folder]` attribute through `BEADS_WEB_FRONTEND_DIR`, in this order:

1. `BEADS_WEB_FRONTEND_DIR`, if set explicitly (a non-directory value is a hard error).
2. `<repo>/out` — the normal case, and the only one in a plain checkout.
3. The **main repository's** `out/` — the worktree fallback, so lint/check/test builds work without a per-worktree `npm ci && npm run build`.
4. An empty directory under `OUT_DIR` — last resort (fresh clone, CI lint job); the binary then serves no UI.

Cases 3 and 4 emit a `cargo:warning` naming the directory actually embedded, so a binary can never quietly ship somebody else's frontend — or none.

Nothing is written outside the checkout being built: the placeholder lives in Cargo's `OUT_DIR`, and the main repo's `out/` is only ever read. Running `npm run build` inside a worktree creates a real local `out/`, which then takes precedence (case 2) — Cargo picks it up automatically, no `cargo clean` needed.

## Frontend-only changes

Rebuilding the binary is only needed because `rust-embed` bakes `out/` into it. While iterating on UI, skip that loop:

```powershell
npm run dev        # http://localhost:3007
```

The dev server proxies `/api/*` to the running backend (`BEADS_API_PORT`, default 3056), so the UI runs against live central-Dolt data and reloads on save.

## Start

```powershell
& "C:\Users\Dee\GitHub\beads-web\scripts\start-direct-dolt.ps1" -Port 3056
```

The launcher registers local repositories containing `.beads\metadata.json`. Local project paths retain CLI, Git, worktree, and editor actions while issue reads use central Dolt SQL.

Cleanup before start is scoped to `-Port` by default (only the process actually listening on it is stopped). Pass `-KillAll` to additionally kill every `beads-web-win-x64*`/`beads-server` process on the machine by name, regardless of port — only needed to clear a stuck instance that isn't listening on any port. Do not use this routinely: it can kill unrelated running instances (e.g. a pm2-managed instance on a different port).

## Verification

```powershell
Invoke-RestMethod "http://127.0.0.1:3056/api/health"
Invoke-RestMethod "http://127.0.0.1:3056/api/dolt/status"
Invoke-RestMethod "http://127.0.0.1:3056/api/dolt/databases"
```

Expected: health is `ok`, Dolt is running, and non-prefixed databases such as `tvp`, `b24p`, and `zm` are present.

## Rollback

Stop the Direct Dolt process and run the preserved legacy launcher:

```powershell
Get-Process "beads-web-win-x64-direct" -ErrorAction SilentlyContinue | Stop-Process -Force
& "C:\Users\Dee\GitHub\start-beads-web-legacy.ps1"
```
