// pm2-конфиг beads-web (Direct Dolt) для ai-tools-ui / PM2-дашборда.
//
// Запускает Rust-бинарник напрямую (никаких node-обёрток): pm2 держит процесс,
// windowsHide прячет консольное окно, Direct Dolt discovery сам находит все базы
// центрального Dolt — досыпка проектов не нужна.
//
// Конфигурация здесь НЕ резолвится. Пароль к Dolt и путь к `bd` бинарник находит
// сам (`server/src/config.rs`): пароль — env -> `%APPDATA%\beads\credentials`
// (секция `host:port`) -> legacy `.dolt.env` / `.beads/.env`; `bd.exe` — включая
// winget-каталог мимо PATH. Здесь остаются только явные оверрайды: порт сервера
// и адрес Dolt. Не добавляй сюда чтение файлов и поиск бинарников — новая
// настройка резолвится ТОЛЬКО в config.rs (см. CLAUDE.md).
const path = require('path');

const REPO_ROOT = __dirname;

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
        // Под pm2 stdout и так не терминал, поэтому вкладка не откроется и без
        // этой строки. Оставлена явно: рестартов у сервиса много, а лишняя
        // вкладка поверх уже открытого UI раздражает сразу (bweb-vqt).
        BEADS_WEB_NO_BROWSER: '1',
      },
    },
  ],
};
