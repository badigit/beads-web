param(
  [int]$Port = 3056,
  [string]$ProjectRoot = "C:\Users\Dee\GitHub"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$binary = Join-Path $repoRoot "bin\beads-web-win-x64-direct.exe"
$outLog = Join-Path $repoRoot "server\target\direct-dolt-$Port.out.log"
$errLog = Join-Path $repoRoot "server\target\direct-dolt-$Port.err.log"

if (-not (Test-Path -LiteralPath $binary)) {
  throw "Direct Dolt binary not found: $binary. Run scripts\build-windows-direct.ps1 first."
}

# The server resolves the bd CLI with `where bd` and spawns the first hit, so a real
# bd.exe must be on PATH -- shell shims (bd, bd.cmd, bd.ps1) are not spawnable by the
# server even though `Get-Command bd` resolves them.
if (-not (Get-Command "bd.exe" -ErrorAction SilentlyContinue)) {
  # built by interpolation, not Join-Path: Join-Path resolves the drive qualifier and
  # would throw under $ErrorActionPreference = "Stop" if the root were unavailable.
  $wingetPackages = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages"
  $bdCandidateDirs = @()

  # winget installs bd into the package folder itself (no alias in WinGet\Links),
  # and the folder suffix changes on reinstall -- match by prefix.
  if (Test-Path -LiteralPath $wingetPackages) {
    $bdCandidateDirs += @(
      Get-ChildItem -LiteralPath $wingetPackages -Directory -Filter "GasTownHall.Beads_*" -ErrorAction SilentlyContinue |
        Sort-Object Name |
        Select-Object -ExpandProperty FullName
    )
  }

  # historical `go install` location, kept as a fallback
  $bdCandidateDirs += "$env:USERPROFILE\go\bin"

  $bdDir = $bdCandidateDirs |
    Where-Object { Test-Path -LiteralPath "$_\bd.exe" } |
    Select-Object -First 1

  if ($bdDir) {
    $env:PATH = "$bdDir;$env:PATH"
  } else {
    Write-Warning "bd.exe not found (checked PATH, $wingetPackages\GasTownHall.Beads_*, and $env:USERPROFILE\go\bin). Direct Dolt will still work, but the beads-web CLI fallback will be unavailable."
  }
}

$env:PORT = "$Port"
$env:BEADS_DOLT_SERVER_HOST = "10.9.0.105"
$env:BEADS_DOLT_SERVER_PORT = "3307"
$env:BEADS_DOLT_SERVER_USER = "beads"

if (-not $env:BEADS_DOLT_PASSWORD) {
  $passwordSources = @(
    (Join-Path $repoRoot ".dolt.env"),
    (Join-Path $repoRoot ".beads\.env"),
    (Join-Path $ProjectRoot "trade-vp1\.beads\.env")
  )
  foreach ($source in $passwordSources) {
    if (-not (Test-Path -LiteralPath $source)) { continue }
    foreach ($line in Get-Content -LiteralPath $source) {
      if ($line -match '^BEADS_DOLT_PASSWORD=(.+)$') {
        $env:BEADS_DOLT_PASSWORD = $Matches[1].Trim()
        break
      }
    }
    if ($env:BEADS_DOLT_PASSWORD) { break }
  }
}

if (-not $env:BEADS_DOLT_PASSWORD) {
  throw "BEADS_DOLT_PASSWORD was not found. Create $repoRoot\.dolt.env."
}

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
