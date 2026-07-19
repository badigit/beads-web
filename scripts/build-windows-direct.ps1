<#
.SYNOPSIS
  Собирает Direct Dolt-бинарник beads-web под Windows (GNU-таргет).

.DESCRIPTION
  Фронт собирается статическим экспортом в out/, оттуда rust-embed вшивает его
  в бинарник — поэтому после любой правки фронта нужен и cargo build.

  Скрипт бережёт время на трёх вещах:
  - зависимости ставятся только когда изменился package-lock.json;
  - cargo target общий для всех worktree (см. Resolve-MainRepoRoot);
  - pm2-инстанс останавливается перед копированием бинарника (иначе Windows
    держит файл занятым и Copy-Item падает) и поднимается обратно.

  ВЫКЛАДКА ГЛОБАЛЬНА — ОСОЗНАННОЕ РЕШЕНИЕ (bweb-g80).
  bin/ и pm2-инстанс beads-web существуют в единственном экземпляре: они живут
  в ОСНОВНОМ репозитории, а не в том checkout, откуда запущен скрипт (в worktree
  каталога bin/ просто нет — он untracked). Поэтому сборка из любого worktree
  подменяет один и тот же рабочий бинарник и рестартует один и тот же инстанс.

  Это поведение сохранено намеренно: смысл скрипта — обновить ЖИВОЙ сервис на
  порту 3056, и агенту из worktree нужно ровно это. Две параллельные сборки
  разойдутся по принципу «последний выигрывает» — молчаливой порчи не будет,
  проиграет лишь та выкладка, что завершилась раньше; перезапустить дешевле,
  чем городить блокировки. Скрипт печатает целевой путь, чтобы глобальность
  действия была видна в логе, а не подразумевалась (ср. bweb-0vq, где неявное
  глобальное действие глушило чужие инстансы).

  Не нужна подмена живого бинарника — есть -NoDeploy и -OutDir: оба собирают
  всё то же самое, но не трогают ни bin/, ни pm2.

.PARAMETER SkipTests
  Пропустить cargo test. Тесты и так гоняет pre-commit.

.PARAMETER NoRestart
  Не поднимать pm2-инстанс обратно после сборки.

.PARAMETER NoDeploy
  Собрать, но не копировать бинарник и не трогать pm2. Путь к собранному exe
  печатается в конце. Безопасный режим для параллельной работы из worktree.

.PARAMETER OutDir
  Скопировать бинарник в указанный каталог вместо bin/ основного репозитория.
  pm2 при этом не трогается — живой инстанс продолжает работать на старом exe.
#>
param(
  [switch]$SkipTests,
  [switch]$NoRestart,
  [switch]$NoDeploy,
  [string]$OutDir
)

if ($NoDeploy -and $OutDir) {
  throw "-NoDeploy и -OutDir взаимоисключающие: первый ничего не копирует, второй копирует в указанный каталог."
}

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$mingwBin = Join-Path $env:USERPROFILE "scoop\apps\mingw\current\bin"
$env:PATH = "$cargoBin;$mingwBin;$env:PATH"

# ── Корень основного репозитория ──────────────────────────────────────────
# Два ресурса общие для всех worktree и живут только в основном checkout:
#   - cargo target: свой в каждом worktree означал бы холодную сборку (~20 мин)
#     и лишние гигабайты, а worktree здесь заводятся на каждый бид;
#   - bin/: untracked, поэтому в worktree его вообще нет, и именно оттуда pm2
#     запускает рабочий инстанс.
# git-common-dir указывает на .git основного репозитория и в обычном checkout
# совпадает с git-dir — то есть один и тот же код верен для обоих случаев.
function Resolve-MainRepoRoot {
  $commonDir = (& git -C $repoRoot rev-parse --git-common-dir 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $commonDir) { return $null }

  if (-not [System.IO.Path]::IsPathRooted($commonDir)) {
    $commonDir = Join-Path $repoRoot $commonDir
  }
  $resolved = Resolve-Path -LiteralPath $commonDir -ErrorAction SilentlyContinue
  if (-not $resolved) { return $null }

  return (Split-Path -Parent $resolved.Path)
}

$mainRepoRoot = Resolve-MainRepoRoot
if (-not $mainRepoRoot) { $mainRepoRoot = $repoRoot }
if ($mainRepoRoot -ne $repoRoot) {
  Write-Host "Running from a worktree; shared resources come from $mainRepoRoot"
}

$env:CARGO_TARGET_DIR = Join-Path $mainRepoRoot "server\target"
Write-Host "Cargo target: $($env:CARGO_TARGET_DIR)"

# ── Зависимости только при изменении lock ─────────────────────────────────
function Install-NodeDepsIfStale {
  $lockFile = Join-Path $repoRoot "package-lock.json"
  $stampFile = Join-Path $repoRoot "node_modules\.beads-web-lock-hash"

  if (-not (Test-Path -LiteralPath $lockFile)) {
    npm install
    return
  }

  $currentHash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash
  $storedHash = if (Test-Path -LiteralPath $stampFile) {
    (Get-Content -LiteralPath $stampFile -Raw).Trim()
  } else { "" }

  if ((Test-Path -LiteralPath (Join-Path $repoRoot "node_modules")) -and $currentHash -eq $storedHash) {
    Write-Host "Dependencies up to date (package-lock.json unchanged)"
    return
  }

  npm ci
  Set-Content -LiteralPath $stampFile -Value $currentHash -NoNewline
}

# ── pm2: освободить бинарник на время копирования ─────────────────────────
function Get-Pm2BeadsWebApp {
  if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) { return $null }

  try {
    $apps = (pm2 jlist 2>$null | ConvertFrom-Json -AsHashtable)
  } catch {
    return $null
  }
  return $apps | Where-Object { $_.name -eq 'beads-web' } | Select-Object -First 1
}

Push-Location $repoRoot
try {
  Install-NodeDepsIfStale
  npm run build

  if (-not $SkipTests) {
    cargo +stable-x86_64-pc-windows-gnu test --manifest-path "server\Cargo.toml"
  }
  cargo +stable-x86_64-pc-windows-gnu build --release --manifest-path "server\Cargo.toml"

  $source = Join-Path $env:CARGO_TARGET_DIR "release\beads-server.exe"

  if ($NoDeploy) {
    Write-Host "Built (not deployed): $source"
    return
  }

  # -OutDir выкладывает копию в сторону: живой bin/ и pm2 остаются нетронутыми,
  # поэтому и останавливать нечего.
  if ($OutDir) {
    if (-not (Test-Path -LiteralPath $OutDir)) {
      New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    }
    $destination = Join-Path $OutDir "beads-web-win-x64-direct.exe"
    Copy-Item -LiteralPath $source -Destination $destination -Force
    Write-Host "Built: $destination (pm2 not touched)"
    return
  }

  # bin/ — untracked, поэтому в worktree его нет: цель всегда в основном
  # репозитории, откуда pm2 и запускает рабочий инстанс. Путь печатается, чтобы
  # глобальность действия была видна (см. заголовок скрипта).
  $binDir = Join-Path $mainRepoRoot "bin"
  if (-not (Test-Path -LiteralPath $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  }
  $destination = Join-Path $binDir "beads-web-win-x64-direct.exe"
  Write-Host "Deploying to shared binary: $destination"

  # Запущенный инстанс держит exe открытым — Copy-Item упадёт с отказом доступа.
  $pm2App = Get-Pm2BeadsWebApp
  $wasOnline = $pm2App -and $pm2App.pm2_env.status -eq 'online'
  if ($wasOnline) {
    Write-Host "Stopping pm2 beads-web to release the binary..."
    pm2 stop beads-web | Out-Null
  }

  try {
    Copy-Item -LiteralPath $source -Destination $destination -Force
    Write-Host "Built: $destination"
  } finally {
    if ($wasOnline -and -not $NoRestart) {
      Write-Host "Starting pm2 beads-web..."
      pm2 start beads-web | Out-Null
    }
  }
} finally {
  Pop-Location
}
