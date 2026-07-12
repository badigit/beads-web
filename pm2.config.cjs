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
const BD_DIR = path.join(os.homedir(), 'go', 'bin');

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

const bdPath = fs.existsSync(path.join(BD_DIR, 'bd.exe'))
  ? `${BD_DIR};${process.env.PATH || ''}`
  : (process.env.PATH || '');

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
