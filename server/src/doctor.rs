//! `--doctor`: диагностика конфигурации одной командой.
//!
//! Печатает ту же сводку источников, что и старт сервера (см. `config.rs`),
//! плюс живые проверки: доступен ли Dolt и проходит ли аутентификация,
//! находится ли `bd` CLI и какой он версии, есть ли credentials-файл.
//! Сервер при этом НЕ поднимается.
//!
//! Смысл: заменить получасовое расследование (сверка `pm2 jlist` с реестром
//! PATH и с содержимым credentials-файла) одним вызовом.
//!
//! Секреты не печатаются: строку про пароль форматирует `config.rs`, и она
//! содержит только факт резолва и источник.

use std::path::Path;

use crate::config::ResolvedConfig;
use crate::dolt::DoltManager;
use crate::process::hidden_std_command;

/// Аргумент, включающий режим диагностики.
const DOCTOR_FLAG: &str = "--doctor";

/// Есть ли `--doctor` среди аргументов командной строки.
pub fn is_doctor_invocation<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().any(|arg| arg == DOCTOR_FLAG)
}

/// Результат одной проверки: вердикт плюс готовая строка отчёта.
struct Check {
    ok: bool,
    text: String,
}

impl Check {
    fn pass(text: String) -> Self {
        Self { ok: true, text }
    }

    fn fail(text: String) -> Self {
        Self { ok: false, text }
    }

    /// Печатает проверку с маркером вердикта.
    fn print(&self) {
        println!("  [{}] {}", if self.ok { "ok" } else { "FAIL" }, self.text);
    }
}

/// Прогоняет диагностику и возвращает код выхода процесса:
/// `0` — всё резолвнулось и связь есть, `1` — что-то требует внимания.
pub async fn run() -> i32 {
    let config = ResolvedConfig::resolve();

    println!("beads-web doctor");
    let unresolved = print_configuration(&config);
    let checks = [
        check_credentials_file(&config),
        check_bd(&config),
        check_dolt(&config).await,
    ];
    print_checks(&checks);

    let failed = unresolved || checks.iter().any(|check| !check.ok);
    print_verdict(failed);
    i32::from(failed)
}

/// Печатает сводку источников. Возвращает `true`, если хоть одна настройка
/// не резолвнулась.
fn print_configuration(config: &ResolvedConfig) -> bool {
    println!();
    println!("configuration (what resolved, and from where):");
    let summary = config.summary();
    for line in &summary {
        println!("  {}{}", if line.warn { "! " } else { "" }, line.text);
    }
    summary.iter().any(|line| line.warn)
}

fn print_checks(checks: &[Check]) {
    println!();
    println!("checks:");
    for check in checks {
        check.print();
    }
}

fn print_verdict(failed: bool) {
    println!();
    println!(
        "{}",
        if failed {
            "doctor: attention needed (see ! and FAIL above)"
        } else {
            "doctor: all good"
        }
    );
}

/// Существует ли централизованный credentials-файл.
///
/// Само отсутствие файла — не приговор (пароль мог прийти из env), поэтому
/// вердикт зависит от того, резолвнулся ли пароль вообще.
fn check_credentials_file(config: &ResolvedConfig) -> Check {
    let path = &config.credentials_path.0;
    let text = format!(
        "credentials file {} — {}",
        path.display(),
        if path.exists() { "exists" } else { "MISSING" }
    );
    if path.exists() || config.dolt_password.password.is_some() {
        Check::pass(text)
    } else {
        Check::fail(format!("{text} (and no password from any other source)"))
    }
}

/// Находится ли `bd` CLI и запускается ли он.
fn check_bd(config: &ResolvedConfig) -> Check {
    let Some(path) = config.bd_path.as_deref() else {
        return Check::fail("bd CLI: not found".to_string());
    };
    match spawn_bd_version(path) {
        Ok(version) => Check::pass(format!("bd CLI {} — {}", path.display(), version)),
        Err(reason) => Check::fail(format!("bd CLI {} — {}", path.display(), reason)),
    }
}

/// Запускает `bd --version` и возвращает вывод либо причину неудачи.
fn spawn_bd_version(path: &Path) -> Result<String, String> {
    let output = hidden_std_command(path)
        .arg("--version")
        .output()
        .map_err(|err| format!("cannot spawn: {err}"))?;
    if !output.status.success() {
        return Err(format!("`bd --version` exited with {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Живая проверка Dolt: сначала TCP до `host:port`, затем реальный запрос —
/// он же проверяет, что резолвнутый пароль вообще подходит.
async fn check_dolt(config: &ResolvedConfig) -> Check {
    let endpoint = format!("{}:{}", config.dolt_host.0, config.dolt_port.0);
    let manager = DoltManager::new();

    if !manager.check_server().await {
        return Check::fail(format!("dolt {endpoint} — unreachable (TCP connect failed)"));
    }
    match manager.discover_databases().await {
        Ok(databases) => Check::pass(format!(
            "dolt {endpoint} — connected as {}, {} beads databases",
            config.dolt_user.0,
            databases.len()
        )),
        Err(err) => Check::fail(format!(
            "dolt {endpoint} — TCP reachable but query failed: {err}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_the_flag_anywhere_in_the_argument_list() {
        assert!(is_doctor_invocation(args(&["beads-server", "--doctor"])));
        assert!(is_doctor_invocation(args(&[
            "beads-server",
            "--doctor",
            "--whatever"
        ])));
    }

    #[test]
    fn plain_startup_is_not_a_doctor_invocation() {
        assert!(!is_doctor_invocation(args(&["beads-server"])));
    }

    #[test]
    fn similar_arguments_do_not_trigger_the_flag() {
        assert!(!is_doctor_invocation(args(&["beads-server", "doctor"])));
        assert!(!is_doctor_invocation(args(&["beads-server", "--doctorate"])));
    }

    #[test]
    fn failed_check_is_marked_and_counts_against_the_exit_code() {
        assert!(!Check::fail("dolt: unreachable".to_string()).ok);
        assert!(Check::pass("dolt: fine".to_string()).ok);
    }
}
