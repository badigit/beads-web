// pm2-конфиг beads-web (Direct Dolt) для ai-tools-ui / PM2-дашборда.
//
// Запускает Rust-бинарник напрямую (никаких node-обёрток): pm2 держит процесс,
// windowsHide прячет консольное окно, Direct Dolt discovery сам находит все базы
// центрального Dolt — досыпка проектов не нужна.
//
// Пароль к Dolt НЕ хранится здесь: берётся из env BEADS_DOLT_PASSWORD либо из
// локального .dolt.env / .beads/.env (gitignored). Порт правится в env.PORT.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = __dirname;

function readDoltPassword() {
  if (process.env.BEADS_DOLT_PASSWORD) return process.env.BEADS_DOLT_PASSWORD.trim();
  const sources = [
    path.join(REPO_ROOT, '.dolt.env'),
    path.join(REPO_ROOT, '.beads', '.env'),
  ];
  for (const src of sources) {
    try {
      for (const line of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^BEADS_DOLT_PASSWORD=(.+)$/);
        if (m) return m[1].trim();
      }
    } catch {}
  }
  return '';
}

/**
 * Найти каталог с НАСТОЯЩИМ bd.exe.
 *
 * Сервер спавнит bd через Command::new, поэтому shell-шимы npm-пакета
 * (bd без расширения, bd.cmd, bd.ps1) не годятся: Windows не может их
 * запустить -- os error 193. winget кладёт bd внутрь самой папки пакета
 * (алиаса в WinGet\Links нет), а суффикс папки меняется при переустановке,
 * поэтому ищем по префиксу. Зеркалит scripts/start-direct-dolt.ps1.
 */
function resolveBdDir() {
  const candidates = (process.env.PATH || '').split(path.delimiter).filter(Boolean);

  const wingetPackages = path.join(
    process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages'
  );
  try {
    for (const entry of fs.readdirSync(wingetPackages).sort()) {
      if (entry.startsWith('GasTownHall.Beads_')) {
        candidates.push(path.join(wingetPackages, entry));
      }
    }
  } catch {}

  // историческое расположение `go install`, оставлено как fallback
  candidates.push(path.join(os.homedir(), 'go', 'bin'));

  return candidates.find((dir) => fs.existsSync(path.join(dir, 'bd.exe'))) || null;
}

const bdDir = resolveBdDir();
const bdPath = bdDir ? `${bdDir};${process.env.PATH || ''}` : (process.env.PATH || '');

module.exports = {
  apps: [
    {
      name: 'beads-web',
      cwd: REPO_ROOT,
      script: path.join(REPO_ROOT, 'bin', 'beads-web-win-x64-direct.exe'),
      interpreter: 'none',
      windowsHide: true,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        PORT: '3056',
        BEADS_DOLT_SERVER_HOST: '10.9.0.105',
        BEADS_DOLT_SERVER_PORT: '3307',
        BEADS_DOLT_SERVER_USER: 'beads',
        BEADS_DOLT_PASSWORD: readDoltPassword(),
        PATH: bdPath,
      },
    },
  ],
};
