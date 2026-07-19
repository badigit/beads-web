# Direct Dolt deployment

The primary Windows deployment uses a single embedded frontend/backend binary and reads Beads databases directly from the central Dolt server.

## Build

```powershell
& "C:\Users\Dee\GitHub\beads-web\scripts\build-windows-direct.ps1"
```

The build produces `bin\beads-web-win-x64-direct.exe`. The upstream `bin\beads-web-win-x64.exe` remains unchanged for rollback.

Flags: `-SkipTests` skips `cargo test` (pre-commit runs it anyway), `-NoRestart` leaves the pm2 instance stopped. The script installs npm dependencies only when `package-lock.json` changed, shares one `CARGO_TARGET_DIR` across worktrees (so a fresh worktree does not rebuild Rust from scratch), and stops the running pm2 instance before replacing the binary — Windows keeps a running `.exe` locked.

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
