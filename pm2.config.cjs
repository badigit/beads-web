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

// Адрес центрального Dolt — внутренний, а репозиторий публичный, поэтому в нём
// его нет. Значения берутся из окружения машины (User-level env задаёт
// BEADS_DOLT_SERVER_HOST/PORT/USER); этот файл читает pm2 CLI в пользовательском
// шелле, так что они здесь доступны. Не задано — config.rs дефолтится на
// localhost и пишет об этом в свой лог.
const DOLT_ENV_VARS = [
  'BEADS_DOLT_SERVER_HOST',
  'BEADS_DOLT_SERVER_PORT',
  'BEADS_DOLT_SERVER_USER',
];

// Переменная со значением `undefined` дошла бы до процесса строкой "undefined",
// что хуже отсутствия: config.rs счёл бы её заданной.
const doltEnv = Object.fromEntries(
  DOLT_ENV_VARS.filter((name) => process.env[name]).map((name) => [name, process.env[name]])
);

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
        ...doltEnv,
        // Под pm2 stdout и так не терминал, поэтому вкладка не откроется и без
        // этой строки. Оставлена явно: рестартов у сервиса много, а лишняя
        // вкладка поверх уже открытого UI раздражает сразу (bweb-vqt).
        BEADS_WEB_NO_BROWSER: '1',
      },
    },
  ],
};
