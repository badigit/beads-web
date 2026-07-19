//! Session spawn route.
//!
//! `POST /api/session/spawn` turns a bead into a working Claude Desktop
//! session in one call:
//!
//! 1. create (or reuse) the git worktree `<repo>/.worktrees/bd-<id>`;
//! 2. run a headless `claude -p` inside it with a server-built prompt passport;
//! 3. take the `session_id` out of the JSON result event;
//! 4. open `claude://resume?session=<id>` so Claude Desktop imports the session.
//!
//! # Security
//!
//! The client sends only `project_path` and `bead_id`. The binary name and the
//! whole argument template are hardcoded here — nothing from the request ever
//! reaches the command line except the validated bead id and the prompt text,
//! which is assembled server-side. `project_path` must pass
//! [`validate_path_security`]. This mirrors `fs::open_external`.
//!
//! # Notes from a live run (see bead bweb-en5.1)
//!
//! * `claude -p` waits 3 seconds for stdin before giving up, so the child's
//!   stdin is closed explicitly ([`Stdio::null`]).
//! * `claude -p --max-turns 1` exits with code 1 even on a good run — the exit
//!   status is deliberately ignored; the presence of a `session_id` is the
//!   success signal.
//! * The session arrives in Claude Desktop unnamed (setting a title
//!   programmatically is impossible — spike bweb-45h). The first prompt line is
//!   therefore `bd-<id>: <title>` so any auto-generated title is meaningful.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::process::hidden_command;

use super::validate_path_security;
use super::worktree::{ensure_worktree, RouteError};

/// How long the headless `claude` run may take. A full spawn measured ~12s;
/// the ceiling only guards against a wedged child process.
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(180);

/// How long `bd show` may take while fetching the bead title.
const BD_TIMEOUT: Duration = Duration::from_secs(15);

/// Base branch new bead worktrees are cut from.
const DEFAULT_BASE_BRANCH: &str = "main";

/// Request body for `POST /api/session/spawn`.
#[derive(Deserialize)]
pub struct SpawnSessionRequest {
    /// Path to the git repository the bead belongs to.
    pub project_path: String,
    /// Bead ID to spawn a session for.
    pub bead_id: String,
    /// Base branch for a freshly created worktree.
    #[serde(default = "default_base_branch")]
    pub base_branch: String,
}

fn default_base_branch() -> String {
    DEFAULT_BASE_BRANCH.to_string()
}

/// Response body for `POST /api/session/spawn`.
#[derive(Serialize)]
pub struct SpawnSessionResponse {
    pub success: bool,
    /// Claude session id, ready for `claude --resume <id>`.
    pub session_id: String,
    /// Worktree the session was started in.
    pub worktree_path: String,
    /// Branch checked out in that worktree.
    pub branch: String,
    /// True when the worktree was reused rather than created.
    pub worktree_already_existed: bool,
    /// Wall-clock duration of the whole spawn.
    pub duration_ms: u64,
}

// ============================================================================
// Validation
// ============================================================================

fn route_error(status: StatusCode, message: impl Into<String>) -> RouteError {
    (
        status,
        Json(serde_json::json!({ "error": message.into() })),
    )
}

/// Bead ids end up in a branch name and in argv, so keep them boring.
fn is_valid_bead_id(bead_id: &str) -> bool {
    !bead_id.is_empty()
        && bead_id.len() <= 64
        && bead_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !bead_id.starts_with('-')
        && !bead_id.contains("..")
}

/// Rejects anything that must never reach the worktree/spawn machinery:
/// unsafe or virtual (`dolt://`) project paths and malformed bead ids.
fn validate_spawn_request(project_path: &str, bead_id: &str) -> Result<(), RouteError> {
    if !is_valid_bead_id(bead_id) {
        return Err(route_error(
            StatusCode::BAD_REQUEST,
            "Invalid bead_id: expected letters, digits, '-', '_' or '.'",
        ));
    }

    validate_path_security(Path::new(project_path))
        .map_err(|e| route_error(StatusCode::FORBIDDEN, e))
}

// ============================================================================
// Prompt passport
// ============================================================================

/// Builds the prompt handed to the headless run.
///
/// The first line is `bd-<id>: <title>` — Claude Desktop cannot be told a
/// session title programmatically, so this line is the only lever on the
/// auto-generated one.
fn build_prompt(bead_id: &str, title: Option<&str>, worktree_path: &str) -> String {
    let headline = match title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(title) => format!("bd-{bead_id}: {title}"),
        None => format!("bd-{bead_id}"),
    };

    format!(
        "{headline}\n\
         \n\
         BEAD_ID: {bead_id}\n\
         Worktree: {worktree_path} (ветка bd-{bead_id}, уже создана)\n\
         \n\
         Это стартовый паспорт сессии. Порядок работы:\n\
         1. Прочитай контекст бэда: `bd show {bead_id}` и `bd comments {bead_id}`.\n\
         2. Поищи прошлые решения: `bd memories \"<ключевое слово>\"`.\n\
         3. Следуй .claude/rules/beads-workflow.md — работай ТОЛЬКО в этом worktree.\n\
         4. Свою ветку не мержи: запушь bd-{bead_id} и оставь комментарий в бэде.\n\
         \n\
         Сейчас: кратко подтверди, что понял задачу, и назови первый шаг плана."
    )
}

// ============================================================================
// Session id parsing
// ============================================================================

/// Session ids are UUIDs; validated before they are pasted into a `claude://`
/// URL so nothing can smuggle extra URL syntax through.
fn is_session_id(candidate: &str) -> bool {
    (8..=64).contains(&candidate.len())
        && candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Extracts the session id from `claude --output-format json` output.
///
/// `claude` emits a JSON *array* of events (`[{"type":"system",…},…,
/// {"type":"result",…}]`); older/streaming forms emit one object per line or a
/// single object. All three are accepted, leading non-JSON noise (warnings) is
/// skipped. The `type: "result"` event wins; any other `session_id` is a
/// fallback — every event of a run carries the same id.
fn parse_session_id(output: &str) -> Option<String> {
    let mut fallback: Option<String> = None;

    for event in claude_events(output) {
        let Some(session_id) = event.get("session_id").and_then(|v| v.as_str()) else {
            continue;
        };
        if !is_session_id(session_id) {
            continue;
        }
        if event.get("type").and_then(|v| v.as_str()) == Some("result") {
            return Some(session_id.to_string());
        }
        fallback.get_or_insert_with(|| session_id.to_string());
    }

    // Last resort: an aborted run (failed SessionEnd hook, killed child) can
    // leave the JSON array unterminated and therefore unparseable, while the
    // session itself exists and is worth importing.
    fallback.or_else(|| scan_session_id_text(output))
}

static SESSION_ID_RE: OnceLock<regex::Regex> = OnceLock::new();

/// Pulls the first `"session_id": "..."` out of raw, possibly truncated output.
fn scan_session_id_text(output: &str) -> Option<String> {
    let re = SESSION_ID_RE.get_or_init(|| {
        regex::Regex::new(r#""session_id"\s*:\s*"([A-Za-z0-9-]{8,64})""#)
            .expect("session id pattern is a valid regex")
    });
    re.captures(output)
        .map(|caps| caps[1].to_string())
        .filter(|id| is_session_id(id))
}

/// Flattens `claude` stdout into individual event objects.
fn claude_events(output: &str) -> Vec<serde_json::Value> {
    // The whole payload first (array or single object), then a line-by-line
    // pass for the stream form. Duplicates are harmless: every event of one run
    // carries the same session id.
    let whole = output
        .find(['[', '{'])
        .map(|start| output[start..].trim())
        .into_iter();

    whole
        .chain(output.lines().map(str::trim))
        .filter(|chunk| chunk.starts_with('[') || chunk.starts_with('{'))
        .filter_map(|chunk| serde_json::from_str::<serde_json::Value>(chunk).ok())
        .flat_map(|value| match value {
            serde_json::Value::Array(items) => items,
            other => vec![other],
        })
        .collect()
}

// ============================================================================
// Binary resolution
// ============================================================================

static CLAUDE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Resolves the `claude` CLI binary.
///
/// Same problem as `find_bd`: on Windows a bare `claude` in PATH is often an
/// extensionless shell shim that `Command::new` cannot spawn (os error 193), so
/// only a real `.exe` counts there.
fn find_claude() -> Option<&'static PathBuf> {
    CLAUDE_PATH
        .get_or_init(|| {
            let lookup = if cfg!(windows) { "where" } else { "which" };
            if let Ok(output) = crate::process::hidden_std_command(lookup)
                .arg("claude")
                .output()
            {
                if output.status.success() {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    if let Some(path) =
                        crate::config::pick_executable(&stdout, cfg!(windows))
                    {
                        if path.exists() {
                            tracing::info!("Found claude CLI in PATH: {}", path.display());
                            return Some(path);
                        }
                    }
                }
            }

            for candidate in claude_fallback_candidates() {
                if candidate.exists() {
                    tracing::info!("Found claude CLI at: {}", candidate.display());
                    return Some(candidate);
                }
            }

            tracing::warn!(
                "claude CLI not found in PATH or the usual install locations — \
                 POST /api/session/spawn will fail until it is installed"
            );
            None
        })
        .as_ref()
}

/// Install locations checked when `claude` is not on PATH.
fn claude_fallback_candidates() -> Vec<PathBuf> {
    let Some(home) = directories::UserDirs::new().map(|d| d.home_dir().to_path_buf()) else {
        return vec![];
    };
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };

    vec![
        home.join(".local").join("bin").join(exe),
        home.join(".claude").join("local").join(exe),
        home.join("AppData")
            .join("Roaming")
            .join("npm")
            .join(exe),
    ]
}

// ============================================================================
// Re-entrancy guard
// ============================================================================

static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn in_flight() -> &'static Mutex<HashSet<String>> {
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Holds a `<repo>|<bead>` slot for the duration of one spawn. A spawn costs
/// money and takes ~12s, so a second click must not start a second run.
struct SpawnSlot {
    key: String,
}

impl SpawnSlot {
    fn acquire(key: String) -> Option<Self> {
        let mut guard = in_flight().lock().unwrap_or_else(|e| e.into_inner());
        if guard.insert(key.clone()) {
            Some(Self { key })
        } else {
            None
        }
    }
}

impl Drop for SpawnSlot {
    fn drop(&mut self) {
        in_flight()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

// ============================================================================
// External calls
// ============================================================================

/// Reads the bead title via `bd show <id> --json`. Best-effort: a missing title
/// only degrades the prompt headline, it must not fail the spawn.
async fn fetch_bead_title(project_path: &str, bead_id: &str) -> Option<String> {
    let bd_path = super::find_bd()?;

    let result = tokio::time::timeout(
        BD_TIMEOUT,
        hidden_command(bd_path)
            .args(["show", bead_id, "--json"])
            .current_dir(project_path)
            .stdin(Stdio::null())
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(output)) if output.status.success() => output,
        Ok(Ok(output)) => {
            tracing::warn!(
                bead_id,
                status = %output.status,
                "bd show failed while fetching bead title — prompt headline will omit it"
            );
            return None;
        }
        Ok(Err(e)) => {
            tracing::warn!(bead_id, error = %e, "failed to run bd show");
            return None;
        }
        Err(_) => {
            tracing::warn!(bead_id, "bd show timed out while fetching bead title");
            return None;
        }
    };

    extract_title(&String::from_utf8_lossy(&output.stdout))
}

/// Pulls `.title` out of `bd show --json`, which returns an array of beads on
/// bd 1.1.x but a bare object on older builds.
fn extract_title(stdout: &str) -> Option<String> {
    let start = stdout.find(['[', '{'])?;
    let value: serde_json::Value = serde_json::from_str(stdout[start..].trim()).ok()?;
    let bead = match &value {
        serde_json::Value::Array(items) => items.first()?,
        other => other,
    };
    bead.get("title")
        .and_then(|t| t.as_str())
        .map(str::to_string)
}

/// Runs the headless `claude` and returns its session id.
///
/// The argument template is fixed; only `prompt` and the working directory
/// vary, and both are built server-side.
async fn run_headless_claude(worktree_path: &str, prompt: &str) -> Result<String, RouteError> {
    let claude = find_claude().ok_or_else(|| {
        route_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "claude CLI not found. Install Claude Code or add `claude` to PATH.",
        )
    })?;

    let started = Instant::now();
    let result = tokio::time::timeout(
        CLAUDE_TIMEOUT,
        hidden_command(claude)
            .args(["-p", prompt, "--output-format", "json", "--max-turns", "1"])
            .current_dir(worktree_path)
            // Without this the child burns exactly 3s on
            // "Warning: no stdin data received in 3s".
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await;

    let output = match result {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            tracing::error!(error = %e, worktree_path, "failed to spawn claude");
            return Err(route_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to run claude: {e}"),
            ));
        }
        Err(_) => {
            tracing::error!(
                worktree_path,
                timeout_s = CLAUDE_TIMEOUT.as_secs(),
                "claude run timed out"
            );
            return Err(route_error(
                StatusCode::GATEWAY_TIMEOUT,
                format!("claude timed out after {}s", CLAUDE_TIMEOUT.as_secs()),
            ));
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    // `--max-turns 1` exits non-zero on a perfectly good run, so the exit code
    // is informational only — the session id decides.
    match parse_session_id(&stdout) {
        Some(session_id) => {
            tracing::info!(
                session_id,
                exit_status = %output.status,
                duration_ms = started.elapsed().as_millis() as u64,
                "headless claude run finished"
            );
            Ok(session_id)
        }
        None => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::error!(
                worktree_path,
                exit_status = %output.status,
                stderr = %truncate(&stderr, 400),
                stdout = %truncate(&stdout, 400),
                "claude produced no session_id"
            );
            Err(route_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "claude returned no session_id (exit {}): {}",
                    output.status,
                    truncate(&stderr, 200)
                ),
            ))
        }
    }
}

fn truncate(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    match trimmed.char_indices().nth(max) {
        Some((idx, _)) => format!("{}…", &trimmed[..idx]),
        None => trimmed.to_string(),
    }
}

/// Hands `claude://resume?session=<id>` to the OS so Claude Desktop imports the
/// session into its registry. The record appears after a couple of seconds.
async fn import_into_claude_desktop(session_id: &str) -> Result<(), RouteError> {
    let url = format!("claude://resume?session={session_id}");
    let for_task = url.clone();

    let result = tokio::task::spawn_blocking(move || open::that(for_task)).await;

    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            tracing::error!(error = %e, url, "failed to open claude:// URL");
            Err(route_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to import session into Claude Desktop: {e}"),
            ))
        }
        Err(e) => {
            tracing::error!(error = %e, url, "claude:// opener task panicked");
            Err(route_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to import session into Claude Desktop",
            ))
        }
    }
}

// ============================================================================
// Handler
// ============================================================================

/// Creates a worktree for a bead and spawns a Claude session in it.
///
/// # Endpoint
///
/// `POST /api/session/spawn`
///
/// ```json
/// { "project_path": "C:\\repo", "bead_id": "bweb-en5.1" }
/// ```
///
/// Returns `session_id` and `worktree_path`. Concurrent spawns for the same
/// bead are rejected with `409 Conflict`.
pub async fn spawn_session(Json(request): Json<SpawnSessionRequest>) -> impl IntoResponse {
    match spawn_session_inner(request).await {
        Ok(response) => Json(response).into_response(),
        Err(resp) => resp.into_response(),
    }
}

async fn spawn_session_inner(
    request: SpawnSessionRequest,
) -> Result<SpawnSessionResponse, RouteError> {
    let started = Instant::now();
    let SpawnSessionRequest {
        project_path,
        bead_id,
        base_branch,
    } = request;

    validate_spawn_request(&project_path, &bead_id)?;

    let _slot = SpawnSlot::acquire(format!("{project_path}|{bead_id}")).ok_or_else(|| {
        tracing::warn!(bead_id, project_path, "spawn rejected: already in flight");
        route_error(
            StatusCode::CONFLICT,
            "A session for this bead is already being spawned",
        )
    })?;

    tracing::info!(bead_id, project_path, base_branch, "session spawn started");

    let worktree = ensure_worktree(&project_path, &bead_id, &base_branch).await?;
    tracing::info!(
        bead_id,
        worktree_path = worktree.worktree_path,
        already_existed = worktree.already_existed,
        "worktree ready"
    );

    let title = fetch_bead_title(&project_path, &bead_id).await;
    let prompt = build_prompt(&bead_id, title.as_deref(), &worktree.worktree_path);

    let session_id = run_headless_claude(&worktree.worktree_path, &prompt).await?;
    import_into_claude_desktop(&session_id).await?;

    let duration_ms = started.elapsed().as_millis() as u64;
    tracing::info!(
        bead_id,
        session_id,
        worktree_path = worktree.worktree_path,
        duration_ms,
        "session spawn finished"
    );

    Ok(SpawnSessionResponse {
        success: true,
        session_id,
        worktree_path: worktree.worktree_path,
        branch: worktree.branch,
        worktree_already_existed: worktree.already_existed,
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_starts_with_bead_id_and_title() {
        let prompt = build_prompt(
            "bweb-en5.1",
            Some("Спавн сессии"),
            "C:\\repo\\.worktrees\\bd-bweb-en5.1",
        );
        let first = prompt.lines().next().unwrap();
        assert_eq!(first, "bd-bweb-en5.1: Спавн сессии");
    }

    #[test]
    fn prompt_headline_survives_a_missing_title() {
        let prompt = build_prompt("bweb-en5.1", None, "C:\\repo");
        assert_eq!(prompt.lines().next().unwrap(), "bd-bweb-en5.1");
    }

    #[test]
    fn prompt_carries_bead_id_and_worktree() {
        let prompt = build_prompt("bweb-en5.1", Some("T"), "C:\\repo\\.worktrees\\bd-bweb-en5.1");
        assert!(prompt.contains("BEAD_ID: bweb-en5.1"));
        assert!(prompt.contains("C:\\repo\\.worktrees\\bd-bweb-en5.1"));
    }

    #[test]
    fn parses_session_id_from_result_event() {
        let out = r#"{"type":"result","session_id":"11111111-2222-3333-4444-555555555555"}"#;
        assert_eq!(
            parse_session_id(out).as_deref(),
            Some("11111111-2222-3333-4444-555555555555")
        );
    }

    /// Verbatim shape of `claude -p --output-format json` stdout (claude 2.x,
    /// captured from a live run): a top-level array of events, `result` last.
    #[test]
    fn parses_session_id_from_the_real_event_array() {
        let out = concat!(
            r#"[{"type":"system","subtype":"init","cwd":"C:\\repo","session_id":"7f5b7532-b9ba-47af-9472-8153aa609e91","tools":["Bash"]},"#,
            r#"{"type":"assistant","session_id":"7f5b7532-b9ba-47af-9472-8153aa609e91"},"#,
            r#"{"type":"result","subtype":"success","session_id":"7f5b7532-b9ba-47af-9472-8153aa609e91","result":"ok"}]"#
        );
        assert_eq!(
            parse_session_id(out).as_deref(),
            Some("7f5b7532-b9ba-47af-9472-8153aa609e91")
        );
    }

    /// A run cut short (hook failure, --max-turns) never reaches the `result`
    /// event, but the session exists and must still be importable.
    #[test]
    fn falls_back_to_a_non_result_event_when_the_run_is_truncated() {
        let out = r#"[{"type":"system","subtype":"init","session_id":"7f5b7532-b9ba-47af-9472-8153aa609e91"}]"#;
        assert_eq!(
            parse_session_id(out).as_deref(),
            Some("7f5b7532-b9ba-47af-9472-8153aa609e91")
        );
    }

    #[test]
    fn result_event_wins_over_earlier_events_in_a_stream() {
        let out = concat!(
            r#"{"type":"system","session_id":"aaaaaaaa-0000-0000-0000-000000000000"}"#,
            "\n",
            r#"{"type":"result","session_id":"bbbbbbbb-1111-1111-1111-111111111111"}"#,
            "\n"
        );
        assert_eq!(
            parse_session_id(out).as_deref(),
            Some("bbbbbbbb-1111-1111-1111-111111111111")
        );
    }

    #[test]
    fn session_id_is_found_past_non_json_warning_lines() {
        let out = concat!(
            "Warning: no stdin data received in 3s\n",
            r#"{"type":"result","session_id":"cccccccc-2222-2222-2222-222222222222"}"#
        );
        assert_eq!(
            parse_session_id(out).as_deref(),
            Some("cccccccc-2222-2222-2222-222222222222")
        );
    }

    #[test]
    fn missing_or_malformed_session_id_yields_none() {
        assert_eq!(parse_session_id(""), None);
        assert_eq!(parse_session_id("not json at all"), None);
        assert_eq!(parse_session_id(r#"{"type":"result"}"#), None);
        // Anything that could smuggle URL syntax must be rejected.
        assert_eq!(
            parse_session_id(r#"{"type":"result","session_id":"abc&foo=bar"}"#),
            None
        );
    }

    /// Unterminated array — the JSON parse fails, the textual scan saves it.
    #[test]
    fn recovers_session_id_from_truncated_output() {
        let out = r#"[{"type":"system","session_id":"7f5b7532-b9ba-47af-9472-8153aa609e91","tools":["Bas"#;
        assert_eq!(
            parse_session_id(out).as_deref(),
            Some("7f5b7532-b9ba-47af-9472-8153aa609e91")
        );
    }

    #[test]
    fn rejects_invalid_project_path() {
        assert!(validate_spawn_request("dolt://foo", "bweb-en5.1").is_err());
    }

    #[test]
    fn rejects_dolt_path_with_forbidden_status() {
        let (status, _) = validate_spawn_request("dolt://beads-web", "bweb-en5.1").unwrap_err();
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn rejects_malformed_bead_ids_before_touching_the_filesystem() {
        for bad in ["", "../etc", "bd id", "-rf", "a/b", "x;whoami"] {
            let err = validate_spawn_request("C:\\repo", bad);
            assert!(err.is_err(), "bead_id {bad:?} must be rejected");
            assert_eq!(err.unwrap_err().0, StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn accepts_normal_bead_ids() {
        for good in ["bweb-en5.1", "bd_123", "ABC-9"] {
            assert!(is_valid_bead_id(good), "bead_id {good:?} must be accepted");
        }
    }

    #[test]
    fn extracts_title_from_array_and_object_forms() {
        assert_eq!(
            extract_title(r#"[{"id":"x","title":"Hello"}]"#).as_deref(),
            Some("Hello")
        );
        assert_eq!(
            extract_title(r#"{"id":"x","title":"Hello"}"#).as_deref(),
            Some("Hello")
        );
        assert_eq!(extract_title("no json here"), None);
        assert_eq!(extract_title("[]"), None);
    }

    #[test]
    fn spawn_slot_is_exclusive_until_dropped() {
        let key = "test-repo|test-bead".to_string();
        let first = SpawnSlot::acquire(key.clone()).expect("first acquire must succeed");
        assert!(SpawnSlot::acquire(key.clone()).is_none());
        drop(first);
        assert!(SpawnSlot::acquire(key).is_some());
    }

    #[test]
    fn truncate_keeps_short_text_and_marks_cut_text() {
        assert_eq!(truncate("  short  ", 100), "short");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }
}
