$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$mingwBin = Join-Path $env:USERPROFILE "scoop\apps\mingw\current\bin"
$env:PATH = "$cargoBin;$mingwBin;$env:PATH"

Push-Location $repoRoot
try {
  npm ci
  npm run build
  cargo +stable-x86_64-pc-windows-gnu test --manifest-path "server\Cargo.toml"
  cargo +stable-x86_64-pc-windows-gnu build --release --manifest-path "server\Cargo.toml"

  $source = Join-Path $repoRoot "server\target\release\beads-server.exe"
  $destination = Join-Path $repoRoot "bin\beads-web-win-x64-direct.exe"
  Copy-Item -LiteralPath $source -Destination $destination -Force
  Write-Host "Built: $destination"
} finally {
  Pop-Location
}
