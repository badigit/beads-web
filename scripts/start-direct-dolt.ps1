param(
  [int]$Port = 3056,
  [string]$ProjectRoot = "C:\Users\Dee\GitHub"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $repoRoot "bin\beads-web-win-x64-direct.exe"
$logDir = Join-Path $repoRoot "server\target"
$outLog = Join-Path $logDir "direct-dolt-$Port.out.log"
$errLog = Join-Path $logDir "direct-dolt-$Port.err.log"

# server\target is the cargo output dir, and since the switch to a shared
# CARGO_TARGET_DIR it no longer exists inside git worktrees -- Start-Process
# would fail on the redirect before the server ever starts.
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path -LiteralPath $binary)) {
  throw "Direct Dolt binary not found: $binary. Run scripts\build-windows-direct.ps1 first."
}

# Configuration is NOT resolved here. The binary finds the Dolt password and the
# bd CLI itself (server/src/config.rs): password -- env -> %APPDATA%\beads\credentials
# (section host:port) -> legacy .dolt.env / .beads\.env; bd.exe -- including the winget
# package folder that never reaches PATH. If something cannot be resolved the server
# says so in its own log ($errLog). Only explicit overrides belong here: the port and
# the Dolt server address. Do not add file reading or binary lookup back -- a new
# setting is resolved ONLY in config.rs (see CLAUDE.md).
$env:PORT = "$Port"
$env:BEADS_DOLT_SERVER_HOST = "10.9.0.105"
$env:BEADS_DOLT_SERVER_PORT = "3307"
$env:BEADS_DOLT_SERVER_USER = "beads"
# Вывод уходит в лог-файлы ниже, поэтому stdout не терминал и вкладка не
# открылась бы и так. Оставлено явно, чтобы намерение читалось (bweb-vqt).
$env:BEADS_WEB_NO_BROWSER = "1"

Get-Process -Name "beads-web-win-x64", "beads-web-win-x64-direct", "beads-server" -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*api-proxy.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

Start-Process -FilePath $binary -WorkingDirectory $repoRoot -WindowStyle Hidden `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$url = "http://127.0.0.1:$Port"
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 300
  try {
    $health = Invoke-RestMethod "$url/api/health" -TimeoutSec 2
  } catch {
    $health = $null
  }
} while (-not $health -and (Get-Date) -lt $deadline)

if (-not $health) {
  throw "Health check failed: $url. See $errLog"
}

$projects = Get-ChildItem -LiteralPath $ProjectRoot -Directory -Force -ErrorAction SilentlyContinue |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName ".beads\metadata.json") }
$known = Invoke-RestMethod "$url/api/projects"
$normalizePath = {
  param([string]$Path)
  $Path.Replace('\', '/').ToLowerInvariant().TrimEnd('/')
}
$knownPaths = @($known | ForEach-Object { & $normalizePath $_.path })

foreach ($project in $projects) {
  $path = $project.FullName
  if ($knownPaths -contains (& $normalizePath $path)) { continue }
  $body = @{ name = $project.Name; path = $path } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$url/api/projects" -ContentType "application/json" -Body $body | Out-Null
}

$dolt = Invoke-RestMethod "$url/api/dolt/status"
$databases = Invoke-RestMethod "$url/api/dolt/databases"
Write-Host "beads-web Direct Dolt: $url"
Write-Host "Dolt: running=$($dolt.running), databases=$(@($databases.databases).Count)"
$registeredProjects = Invoke-RestMethod "$url/api/projects"
Write-Host "Projects: $($registeredProjects.Count)"
