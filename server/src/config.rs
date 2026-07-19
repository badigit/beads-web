//! Единая точка резолва конфигурации процесса.
//!
//! Раньше настройки (пароль/хост/порт Dolt, путь к `bd`, PORT сервера)
//! читались напрямую через `env::var()` россыпью по разным файлам
//! (`dolt.rs`, `routes/mod.rs`, `main.rs`, `routes/version.rs`), а часть той
//! же логики (поиск пароля, поиск `bd.exe`) дублировалась ВНЕ процесса в
//! `pm2.config.cjs` / `scripts/start-direct-dolt.ps1`.
//!
//! Каждая настройка резолвится здесь цепочкой источников и возвращает пару
//! `(значение, источник)` — источник понадобится будущему логированию при
//! старте (см. эпик bweb-1ey), поэтому закладывается сразу.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use directories::UserDirs;

/// Откуда взято резолвленное значение конфигурации.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigSource {
    /// Прочитано из указанной переменной окружения.
    Env(&'static str),
    /// Прочитано из централизованного credentials-файла.
    CredentialsFile(PathBuf),
    /// Прочитано из legacy per-repo файла (`.dolt.env`, `.beads/.env`).
    Legacy(PathBuf),
    /// Ни один источник не дал значения — применяется дефолт вызывающего кода.
    Default,
}

// ── INI-парсер credentials-файла ────────────────────────────────────────

/// Минимальный INI-парсер: находит `[section]`, затем возвращает значение
/// `key = value` внутри неё. `str::lines()` сам режет `\r`, так что CRLF и LF
/// обрабатываются одинаково. Пустое значение считается отсутствующим.
fn parse_ini_value(contents: &str, section: &str, key: &str) -> Option<String> {
    let mut in_section = false;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            in_section = name.trim() == section;
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == key {
                let value = v.trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

// ── Legacy `.env`-файлы (`.dolt.env`, `.beads/.env`) ────────────────────

/// Парсит legacy `.env`-файл построчно: первая строка `KEY=value` побеждает.
/// Зеркалит регэксп-парсинг из `pm2.config.cjs` / `scripts/start-direct-dolt.ps1`.
fn parse_legacy_env_value(contents: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    for line in contents.lines() {
        if let Some(value) = line.strip_prefix(&prefix) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

// ── Credentials-файл: путь ──────────────────────────────────────────────

/// Резолвит путь к централизованному credentials-файлу:
/// env `BEADS_CREDENTIALS_FILE` -> платформенный дефолт
/// (`%APPDATA%\beads\credentials` на Windows, `~/.config/beads/credentials`
/// на Unix, через crate `directories`, уже используемый в `routes/mod.rs`).
pub fn resolve_credentials_path() -> (PathBuf, ConfigSource) {
    if let Ok(value) = env::var("BEADS_CREDENTIALS_FILE") {
        if !value.is_empty() {
            return (
                PathBuf::from(value),
                ConfigSource::Env("BEADS_CREDENTIALS_FILE"),
            );
        }
    }
    (default_credentials_path(), ConfigSource::Default)
}

fn default_credentials_path() -> PathBuf {
    match directories::BaseDirs::new() {
        // `config_dir()` is already `%APPDATA%` on Windows and `~/.config` on
        // Unix -- exactly the two locations the credentials-file convention
        // documents, no per-OS branching needed.
        Some(base) => base.config_dir().join("beads").join("credentials"),
        None => PathBuf::from(".config").join("beads").join("credentials"),
    }
}

// ── Пароль к Dolt ────────────────────────────────────────────────────────

/// Читает пароль из credentials-файла для секции `host:port`.
fn read_credentials_password(path: &Path, section: &str) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    parse_ini_value(&contents, section, "password")
}

/// Читает пароль из legacy `.env`-файла (`.dolt.env` / `.beads/.env`).
fn read_legacy_password(path: &Path) -> Option<String> {
    let contents = fs::read_to_string(path).ok()?;
    parse_legacy_env_value(&contents, "BEADS_DOLT_PASSWORD")
}

/// Возвращает `.dolt.env` / `.beads/.env` относительно текущей рабочей
/// директории процесса -- зеркалит `pm2.config.cjs` / `start-direct-dolt.ps1`.
fn legacy_password_file_candidates() -> Vec<PathBuf> {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    vec![cwd.join(".dolt.env"), cwd.join(".beads").join(".env")]
}

/// Первое непустое значение из списка `(имя_переменной, значение)`.
fn first_non_empty(candidates: &[(&'static str, Option<String>)]) -> Option<(String, &'static str)> {
    candidates.iter().find_map(|(name, value)| {
        value
            .as_ref()
            .filter(|v| !v.is_empty())
            .map(|v| (v.clone(), *name))
    })
}

/// Ядро резолва пароля, не трогающее ни `env::var`, ни реальную ФС напрямую --
/// принимает уже прочитанные env-значения и явные пути, поэтому тестируется
/// без гонок за глобальным окружением процесса.
///
/// Порядок источников: env -> credentials-файл -> legacy-файлы по порядку.
/// Пустое значение в любом источнике трактуется как отсутствующее и не
/// останавливает резолв -- ровно то же поведение, что раньше давал
/// `.filter(|p| !p.is_empty())` в `dolt.rs`, но теперь для каждого источника.
fn resolve_dolt_password_from(
    env_values: &[(&'static str, Option<String>)],
    section: &str,
    credentials_path: &Path,
    legacy_paths: &[PathBuf],
) -> (Option<String>, ConfigSource) {
    if let Some((password, name)) = first_non_empty(env_values) {
        return (Some(password), ConfigSource::Env(name));
    }
    if let Some(password) = read_credentials_password(credentials_path, section) {
        return (
            Some(password),
            ConfigSource::CredentialsFile(credentials_path.to_path_buf()),
        );
    }
    for legacy_path in legacy_paths {
        if let Some(password) = read_legacy_password(legacy_path) {
            return (Some(password), ConfigSource::Legacy(legacy_path.clone()));
        }
    }
    (None, ConfigSource::Default)
}

/// Резолвит пароль к Dolt: env `BEADS_DOLT_PASSWORD`/`DOLT_PASSWORD` ->
/// credentials-файл (секция `host:port`) -> legacy `.dolt.env` /
/// `.beads/.env` -> `None`.
pub fn resolve_dolt_password(host: &str, port: u16) -> (Option<String>, ConfigSource) {
    let env_values = [
        ("BEADS_DOLT_PASSWORD", env::var("BEADS_DOLT_PASSWORD").ok()),
        ("DOLT_PASSWORD", env::var("DOLT_PASSWORD").ok()),
    ];
    let section = format!("{host}:{port}");
    let (credentials_path, _) = resolve_credentials_path();
    let legacy_paths = legacy_password_file_candidates();
    resolve_dolt_password_from(&env_values, &section, &credentials_path, &legacy_paths)
}

// ── Хост / порт / пользователь Dolt ──────────────────────────────────────

/// Первая присутствующая переменная окружения из списка (по присутствию,
/// не по непустоте -- сохраняет точную семантику прежнего
/// `env::var(A).or_else(|_| env::var(B))` в `dolt.rs`).
fn resolve_env_chain(names: &[&'static str], default: &str) -> (String, ConfigSource) {
    for name in names {
        if let Ok(value) = env::var(name) {
            return (value, ConfigSource::Env(name));
        }
    }
    (default.to_string(), ConfigSource::Default)
}

/// Резолвит хост Dolt-сервера: `BEADS_DOLT_SERVER_HOST` -> `DOLT_HOST` ->
/// `127.0.0.1`.
pub fn resolve_dolt_host() -> (String, ConfigSource) {
    resolve_env_chain(&["BEADS_DOLT_SERVER_HOST", "DOLT_HOST"], "127.0.0.1")
}

/// Резолвит пользователя Dolt-сервера: `BEADS_DOLT_SERVER_USER` ->
/// `DOLT_USER` -> `root`.
pub fn resolve_dolt_user() -> (String, ConfigSource) {
    resolve_env_chain(&["BEADS_DOLT_SERVER_USER", "DOLT_USER"], "root")
}

/// Резолвит порт Dolt-сервера: `BEADS_DOLT_SERVER_PORT` -> `DOLT_PORT` ->
/// `3307`. Первая ПРИСУТСТВУЮЩАЯ переменная решает: если она есть, но
/// невалидна, резолв не переходит ко второй переменной -- сразу дефолт.
/// Это в точности повторяет прежнее поведение `dolt.rs`
/// (`.or_else` реагирует только на отсутствие переменной, не на ошибку парсинга).
pub fn resolve_dolt_port() -> (u16, ConfigSource) {
    for name in ["BEADS_DOLT_SERVER_PORT", "DOLT_PORT"] {
        if let Ok(value) = env::var(name) {
            return match value.parse() {
                Ok(port) => (port, ConfigSource::Env(name)),
                Err(_) => (3307, ConfigSource::Default),
            };
        }
    }
    (3307, ConfigSource::Default)
}

// ── PORT сервера ─────────────────────────────────────────────────────────

/// Резолвит порт, на котором слушает сам beads-web сервер: env `PORT` ->
/// дефолт. Дефолт (3008) сохраняет текущее поведение `main.rs`/`version.rs` --
/// НЕ переопределяется на 3056 (то продовое значение задаётся явно через
/// `pm2.config.cjs` / `scripts/start-direct-dolt.ps1`, а не дефолт бинарника).
pub fn resolve_server_port() -> (u16, ConfigSource) {
    if let Ok(value) = env::var("PORT") {
        if let Ok(port) = value.parse() {
            return (port, ConfigSource::Env("PORT"));
        }
    }
    (3008, ConfigSource::Default)
}

// ── Резолв `bd` CLI ──────────────────────────────────────────────────────
//
// Moved here from `routes/mod.rs` (originally added by bweb-0wk) -- same
// principle as the rest of this module: resolve inside the process instead
// of depending on PATH tricks in the launcher scripts.

/// Cached path to the `bd` CLI binary.
///
/// Resolved once at first use and cached for the process lifetime.
/// Searches PATH first, then common install locations.
static BD_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// What to pass to `Command::new` when spawning the `bd` CLI.
///
/// Prefers the resolved binary; falls back to the bare name so the OS still
/// gets a chance to find it. Call this instead of hardcoding `"bd"` -- on
/// Windows a bare `"bd"` resolves to whatever shim sits first in PATH.
pub fn bd_command_path() -> std::ffi::OsString {
    find_bd()
        .map(|path| path.as_os_str().to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("bd"))
}

/// Picks the first spawnable binary out of `where`/`which` output.
///
/// On Windows `where bd` also lists the npm package's shell shims -- an
/// extensionless bash script plus `bd.cmd` / `bd.ps1`. `Command::new` cannot
/// spawn those ("%1 is not a valid Win32 application", os error 193), and the
/// shims often come first in PATH, so only a real `.exe` counts there.
fn pick_executable(lookup_output: &str, windows: bool) -> Option<PathBuf> {
    lookup_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .find(|line| !windows || line.to_ascii_lowercase().ends_with(".exe"))
        .map(PathBuf::from)
}

/// Lists `bd.exe` candidates inside winget package folders.
///
/// winget installs bd into the package folder itself -- there is no alias in
/// `WinGet\Links`, so the binary never reaches PATH -- and the folder suffix
/// changes on reinstall, hence the prefix match. Mirrors the same lookup in
/// `scripts/start-direct-dolt.ps1` and `pm2.config.cjs`.
fn winget_bd_candidates(packages_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(packages_root) else {
        return vec![];
    };

    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("GasTownHall.Beads_"))
        })
        .collect();
    dirs.sort();

    dirs.into_iter().map(|dir| dir.join("bd.exe")).collect()
}

/// Returns the path to the `bd` CLI binary, or `None` if not found.
///
/// Search order:
/// 1. `bd` in PATH (via `which`/`where`, real executables only)
/// 2. winget package folders (`GasTownHall.Beads_*`, Windows only)
/// 3. `~/.cargo/bin/bd`
/// 4. `~/.local/bin/bd`
/// 5. `/usr/local/bin/bd`
/// 6. `~/.beads/bin/bd`
pub fn find_bd() -> Option<&'static PathBuf> {
    BD_PATH.get_or_init(|| {
        // Try PATH first
        if let Ok(output) = crate::process::hidden_std_command(if cfg!(windows) { "where" } else { "which" })
            .arg("bd")
            .output()
        {
            if output.status.success() {
                let path_str = String::from_utf8_lossy(&output.stdout);
                if let Some(path) = pick_executable(&path_str, cfg!(windows)) {
                    if path.exists() {
                        tracing::info!("Found bd CLI in PATH: {}", path.display());
                        return Some(path);
                    }
                }
            }
        }

        // Search common locations
        let home = UserDirs::new().map(|d| d.home_dir().to_path_buf());
        let mut candidates: Vec<PathBuf> = vec![];

        // winget is the primary install channel on Windows and never reaches PATH
        if cfg!(windows) {
            if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
                let packages = Path::new(&local_app_data)
                    .join("Microsoft")
                    .join("WinGet")
                    .join("Packages");
                candidates.extend(winget_bd_candidates(&packages));
            }
        }

        if let Some(ref home) = home {
            candidates.push(home.join(".cargo").join("bin").join(if cfg!(windows) { "bd.exe" } else { "bd" }));
            candidates.push(home.join(".local").join("bin").join("bd"));
            candidates.push(home.join(".beads").join("bin").join("bd"));
            if !cfg!(windows) {
                candidates.push(PathBuf::from("/usr/local/bin/bd"));
            }
        }

        for candidate in &candidates {
            if candidate.exists() {
                tracing::info!("Found bd CLI at: {}", candidate.display());
                return Some(candidate.clone());
            }
        }

        tracing::warn!(
            "bd CLI not found. Searched PATH and: {}. \
             Install bd (https://github.com/steveyegge/beads) or add it to PATH.",
            candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
        );
        None
    }).as_ref()
}

#[cfg(test)]
mod parser_tests {
    use super::*;

    #[test]
    fn ini_finds_value_in_matching_section_among_several() {
        let contents = "[10.9.0.1:3307]\npassword=wrong\n\n[10.9.0.105:3307]\npassword=correct\n";
        assert_eq!(
            parse_ini_value(contents, "10.9.0.105:3307", "password"),
            Some("correct".to_string())
        );
    }

    #[test]
    fn ini_missing_section_returns_none() {
        let contents = "[10.9.0.1:3307]\npassword=wrong\n";
        assert_eq!(parse_ini_value(contents, "10.9.0.105:3307", "password"), None);
    }

    #[test]
    fn ini_empty_contents_returns_none() {
        assert_eq!(parse_ini_value("", "10.9.0.105:3307", "password"), None);
    }

    #[test]
    fn ini_tolerates_spaces_around_equals() {
        let contents = "[10.9.0.105:3307]\n  password   =   correct  \n";
        assert_eq!(
            parse_ini_value(contents, "10.9.0.105:3307", "password"),
            Some("correct".to_string())
        );
    }

    #[test]
    fn ini_tolerates_crlf_line_endings() {
        let contents = "[10.9.0.105:3307]\r\npassword=correct\r\n";
        assert_eq!(
            parse_ini_value(contents, "10.9.0.105:3307", "password"),
            Some("correct".to_string())
        );
    }

    #[test]
    fn ini_mixed_crlf_and_lf_line_endings() {
        let contents = "[10.9.0.1:3307]\r\npassword=wrong\n[10.9.0.105:3307]\r\npassword=correct\n";
        assert_eq!(
            parse_ini_value(contents, "10.9.0.105:3307", "password"),
            Some("correct".to_string())
        );
    }

    #[test]
    fn ini_empty_value_is_treated_as_absent() {
        let contents = "[10.9.0.105:3307]\npassword=\n";
        assert_eq!(parse_ini_value(contents, "10.9.0.105:3307", "password"), None);
    }

    #[test]
    fn legacy_env_finds_matching_key() {
        let contents = "BEADS_DOLT_SERVER_HOST=10.9.0.105\nBEADS_DOLT_PASSWORD=secret\n";
        assert_eq!(
            parse_legacy_env_value(contents, "BEADS_DOLT_PASSWORD"),
            Some("secret".to_string())
        );
    }

    #[test]
    fn legacy_env_missing_key_returns_none() {
        let contents = "BEADS_DOLT_SERVER_HOST=10.9.0.105\n";
        assert_eq!(parse_legacy_env_value(contents, "BEADS_DOLT_PASSWORD"), None);
    }

    #[test]
    fn legacy_env_empty_value_is_treated_as_absent() {
        let contents = "BEADS_DOLT_PASSWORD=\n";
        assert_eq!(parse_legacy_env_value(contents, "BEADS_DOLT_PASSWORD"), None);
    }

    #[test]
    fn legacy_env_crlf_line_endings() {
        let contents = "BEADS_DOLT_PASSWORD=secret\r\n";
        assert_eq!(
            parse_legacy_env_value(contents, "BEADS_DOLT_PASSWORD"),
            Some("secret".to_string())
        );
    }
}

#[cfg(test)]
mod password_resolution_tests {
    use super::*;

    const SECTION: &str = "10.9.0.105:3307";

    fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, contents).unwrap();
        path
    }

    // ── Приоритет источников ────────────────────────────────────────────

    #[test]
    fn env_wins_over_credentials_file() {
        let tmp = tempfile::tempdir().unwrap();
        let cred_path = write(
            tmp.path(),
            "credentials",
            &format!("[{SECTION}]\npassword=from-credentials\n"),
        );
        let env_values = [
            ("BEADS_DOLT_PASSWORD", Some("from-env".to_string())),
            ("DOLT_PASSWORD", None),
        ];

        let (password, source) =
            resolve_dolt_password_from(&env_values, SECTION, &cred_path, &[]);

        assert_eq!(password, Some("from-env".to_string()));
        assert_eq!(source, ConfigSource::Env("BEADS_DOLT_PASSWORD"));
    }

    #[test]
    fn credentials_file_wins_over_legacy() {
        let tmp = tempfile::tempdir().unwrap();
        let cred_path = write(
            tmp.path(),
            "credentials",
            &format!("[{SECTION}]\npassword=from-credentials\n"),
        );
        let legacy_path = write(
            tmp.path(),
            ".dolt.env",
            "BEADS_DOLT_PASSWORD=from-legacy\n",
        );
        let env_values = [
            ("BEADS_DOLT_PASSWORD", None),
            ("DOLT_PASSWORD", None),
        ];

        let (password, source) = resolve_dolt_password_from(
            &env_values,
            SECTION,
            &cred_path,
            std::slice::from_ref(&legacy_path),
        );

        assert_eq!(password, Some("from-credentials".to_string()));
        assert_eq!(source, ConfigSource::CredentialsFile(cred_path));
    }

    #[test]
    fn legacy_used_when_env_and_credentials_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let missing_cred_path = tmp.path().join("credentials");
        let legacy_path = write(
            tmp.path(),
            ".dolt.env",
            "BEADS_DOLT_PASSWORD=from-legacy\n",
        );
        let env_values = [
            ("BEADS_DOLT_PASSWORD", None),
            ("DOLT_PASSWORD", None),
        ];

        let (password, source) = resolve_dolt_password_from(
            &env_values,
            SECTION,
            &missing_cred_path,
            std::slice::from_ref(&legacy_path),
        );

        assert_eq!(password, Some("from-legacy".to_string()));
        assert_eq!(source, ConfigSource::Legacy(legacy_path));
    }

    #[test]
    fn legacy_falls_through_dolt_env_to_beads_env_file() {
        let tmp = tempfile::tempdir().unwrap();
        let missing_cred_path = tmp.path().join("credentials");
        let missing_dolt_env = tmp.path().join(".dolt.env");
        let beads_env = write(
            tmp.path(),
            ".beads/.env",
            "BEADS_DOLT_PASSWORD=second-candidate\n",
        );
        let env_values = [
            ("BEADS_DOLT_PASSWORD", None),
            ("DOLT_PASSWORD", None),
        ];

        let (password, source) = resolve_dolt_password_from(
            &env_values,
            SECTION,
            &missing_cred_path,
            &[missing_dolt_env, beads_env.clone()],
        );

        assert_eq!(password, Some("second-candidate".to_string()));
        assert_eq!(source, ConfigSource::Legacy(beads_env));
    }

    // ── Пустая строка = "не найдено", резолв идёт дальше ─────────────────

    #[test]
    fn empty_env_value_falls_through_to_credentials_file() {
        let tmp = tempfile::tempdir().unwrap();
        let cred_path = write(
            tmp.path(),
            "credentials",
            &format!("[{SECTION}]\npassword=from-credentials\n"),
        );
        let env_values = [
            ("BEADS_DOLT_PASSWORD", Some(String::new())),
            ("DOLT_PASSWORD", None),
        ];

        let (password, source) =
            resolve_dolt_password_from(&env_values, SECTION, &cred_path, &[]);

        assert_eq!(password, Some("from-credentials".to_string()));
        assert_eq!(
            source,
            ConfigSource::CredentialsFile(cred_path)
        );
    }

    #[test]
    fn empty_password_in_credentials_file_falls_through_to_legacy() {
        let tmp = tempfile::tempdir().unwrap();
        let cred_path = write(tmp.path(), "credentials", &format!("[{SECTION}]\npassword=\n"));
        let legacy_path = write(
            tmp.path(),
            ".dolt.env",
            "BEADS_DOLT_PASSWORD=from-legacy\n",
        );
        let env_values = [
            ("BEADS_DOLT_PASSWORD", None),
            ("DOLT_PASSWORD", None),
        ];

        let (password, source) = resolve_dolt_password_from(
            &env_values,
            SECTION,
            &cred_path,
            std::slice::from_ref(&legacy_path),
        );

        assert_eq!(password, Some("from-legacy".to_string()));
        assert_eq!(source, ConfigSource::Legacy(legacy_path));
    }

    // ── Инвариант эпика: полностью пустое окружение не паникует ──────────

    #[test]
    fn completely_empty_environment_returns_none_not_panic() {
        let tmp = tempfile::tempdir().unwrap();
        // Ничего не существует: ни credentials-файла, ни legacy-файлов.
        let missing_cred_path = tmp.path().join("credentials");
        let missing_dolt_env = tmp.path().join(".dolt.env");
        let missing_beads_env = tmp.path().join(".beads").join(".env");
        let env_values = [
            ("BEADS_DOLT_PASSWORD", None),
            ("DOLT_PASSWORD", None),
        ];

        let (password, source) = resolve_dolt_password_from(
            &env_values,
            SECTION,
            &missing_cred_path,
            &[missing_dolt_env, missing_beads_env],
        );

        assert_eq!(password, None, "empty environment must resolve to None, never an empty string");
        assert_eq!(source, ConfigSource::Default);
    }

    #[test]
    fn wrong_section_in_credentials_file_is_treated_as_absent() {
        // Credentials file exists and has *a* password, but for a different
        // host:port -- must not leak across sections.
        let tmp = tempfile::tempdir().unwrap();
        let cred_path = write(
            tmp.path(),
            "credentials",
            "[10.9.0.1:3307]\npassword=other-server-password\n",
        );
        let env_values = [
            ("BEADS_DOLT_PASSWORD", None),
            ("DOLT_PASSWORD", None),
        ];

        let (password, source) =
            resolve_dolt_password_from(&env_values, SECTION, &cred_path, &[]);

        assert_eq!(password, None);
        assert_eq!(source, ConfigSource::Default);
    }
}

#[cfg(test)]
mod credentials_path_tests {
    use super::*;

    #[test]
    fn default_credentials_path_ends_with_beads_credentials() {
        let path = default_credentials_path();
        assert_eq!(path.file_name().unwrap(), "credentials");
        assert_eq!(
            path.parent().unwrap().file_name().unwrap(),
            "beads"
        );
    }
}

#[cfg(test)]
mod bd_cli_tests {
    use super::*;

    #[test]
    fn windows_where_output_skips_shell_shims() {
        // Real `where bd` output when the npm package's shims shadow winget:
        // the extensionless bash script comes first and cannot be spawned.
        let output = "C:\\Users\\Dee\\AppData\\Roaming\\fnm\\aliases\\default\\bd\n\
                      C:\\Users\\Dee\\AppData\\Roaming\\fnm\\aliases\\default\\bd.cmd\n\
                      C:\\Users\\Dee\\tools\\bd.exe\n";

        assert_eq!(
            pick_executable(output, true),
            Some(PathBuf::from("C:\\Users\\Dee\\tools\\bd.exe"))
        );
    }

    #[test]
    fn windows_where_output_without_exe_yields_nothing() {
        let output = "C:\\shims\\bd\nC:\\shims\\bd.ps1\n";

        assert_eq!(pick_executable(output, true), None);
    }

    #[test]
    fn unix_which_output_takes_first_line() {
        assert_eq!(
            pick_executable("/usr/local/bin/bd\n/usr/bin/bd\n", false),
            Some(PathBuf::from("/usr/local/bin/bd"))
        );
    }

    #[test]
    fn empty_lookup_output_yields_nothing() {
        assert_eq!(pick_executable("  \n\n", true), None);
        assert_eq!(pick_executable("", false), None);
    }

    #[test]
    fn winget_candidates_match_package_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        // winget folder suffix changes on reinstall, hence the prefix match
        let pkg = root.join("GasTownHall.Beads_Microsoft.Winget.Source_8wekyb3d8bbwe");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("bd.exe"), b"binary").unwrap();
        // an unrelated package must not be picked up
        let other = root.join("Some.Other.Package_1234");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("bd.exe"), b"binary").unwrap();

        assert_eq!(winget_bd_candidates(root), vec![pkg.join("bd.exe")]);
    }

    #[test]
    fn winget_candidates_tolerate_missing_root() {
        let missing = PathBuf::from("Z:\\no\\such\\winget\\packages");

        assert!(winget_bd_candidates(&missing).is_empty());
    }
}
