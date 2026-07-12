# Direct Dolt deployment

The primary Windows deployment uses a single embedded frontend/backend binary and reads Beads databases directly from the central Dolt server.

## Build

```powershell
& "C:\Users\Dee\GitHub\beads-web\scripts\build-windows-direct.ps1"
```

The build produces `bin\beads-web-win-x64-direct.exe`. The upstream `bin\beads-web-win-x64.exe` remains unchanged for rollback.

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
