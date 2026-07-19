//! Memory API route handlers.
//!
//! Backed by **bd's own memories** (`bd remember` / `bd memories` / `bd recall` /
//! `bd forget`), which live in the project's Dolt database and are injected into
//! agent sessions at `bd prime`.
//!
//! # History
//!
//! Until bweb-1vr these handlers read and wrote
//! `{project_path}/.beads/memory/knowledge.jsonl` — a pre-bd-1.1.0 file format
//! introduced by upstream commit dcf329a (2026-01-27). Investigation bweb-30u
//! established that **nothing has written that file since January 2026**: no
//! `.beads/memory/` directory existed in any project on the machine, and
//! `/api/memory/stats` returned zeros for projects whose `bd memories` was
//! non-empty. The panel and bd's memories were two unrelated systems sharing a
//! name. The legacy path is gone — not kept as a fallback — because there is no
//! data anywhere to fall back to, and keeping it would preserve the exact
//! ambiguity this change removes.
//!
//! # Why shell out to `bd` instead of querying Dolt directly
//!
//! beads-web already reads bd's Dolt tables directly elsewhere, and that
//! coupling has bitten us: the bd 1.0.4 → 1.1.0 schema migration (v32 → v53)
//! renamed a column and beads-web silently 404'd until bweb-34e fixed it.
//! The memories table schema is undocumented and subject to the same drift,
//! whereas the CLI's `--json` output is the interface bd actually maintains.
//! Shelling out also matches the project convention for mutations (see
//! `routes::cli` and `project-conventions.md`) and lets bd resolve the database
//! name and credentials itself, rather than reimplementing that here.

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::process::hidden_command;

use super::validate_path_security;

/// Sentinel key bd includes in every `--json` payload. It is protocol metadata,
/// not a memory, and must never be surfaced as an entry.
const SCHEMA_VERSION_KEY: &str = "schema_version";

/// Upper bound on a memory key, matching the slug style bd generates.
const MAX_KEY_LEN: usize = 200;

/// Timeout for a single bd invocation, matching `routes::cli`.
const BD_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single bd memory: an opaque key and its free-text content.
///
/// bd memories carry no type, tags, timestamp, or bead association — the legacy
/// JSONL format had those fields, bd does not.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct MemoryEntry {
    pub key: String,
    pub content: String,
}

/// Aggregate statistics about a project's memories.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct MemoryStats {
    pub total: usize,
}

/// Response for the list memory endpoint.
#[derive(Debug, Serialize)]
pub struct MemoryListResponse {
    pub entries: Vec<MemoryEntry>,
    pub stats: MemoryStats,
}

/// Query parameters for the list endpoint.
#[derive(Debug, Deserialize)]
pub struct MemoryListParams {
    pub path: String,
    /// Optional search term passed through to `bd memories <search>`.
    pub search: Option<String>,
}

/// Query parameters for endpoints that take only a project path.
#[derive(Debug, Deserialize)]
pub struct MemoryParams {
    pub path: String,
}

/// Query parameters for reading a single memory.
#[derive(Debug, Deserialize)]
pub struct MemoryEntryParams {
    pub path: String,
    pub key: String,
}

/// Request body for creating or updating a memory.
///
/// Both map to `bd remember --key <key> -- <content>`, which upserts.
#[derive(Debug, Deserialize)]
pub struct RememberRequest {
    pub path: String,
    pub key: String,
    pub content: String,
}

/// Request body for deleting a memory.
#[derive(Debug, Deserialize)]
pub struct ForgetRequest {
    pub path: String,
    pub key: String,
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Validates a memory key before it is passed to bd as `--key <key>`.
///
/// Keys are restricted to the slug alphabet bd itself generates. A leading `-`
/// is rejected outright: even as a separate argv element it would be parsed as
/// a flag by bd's argument parser rather than as the key's value.
pub(crate) fn validate_memory_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("Memory key must not be empty".to_string());
    }
    if key.len() > MAX_KEY_LEN {
        return Err(format!(
            "Memory key must be at most {} characters (got {})",
            MAX_KEY_LEN,
            key.len()
        ));
    }
    if key.starts_with('-') {
        return Err("Memory key must not start with '-'".to_string());
    }
    if key == SCHEMA_VERSION_KEY {
        return Err(format!("'{}' is reserved by bd", SCHEMA_VERSION_KEY));
    }
    if let Some(bad) = key
        .chars()
        .find(|c| !c.is_ascii_alphanumeric() && !matches!(c, '-' | '_' | '.'))
    {
        return Err(format!(
            "Memory key may only contain letters, digits, '-', '_' and '.' (found {:?})",
            bad
        ));
    }
    Ok(())
}

/// Validates memory content.
///
/// Content itself is unrestricted — it is passed after a `--` separator so that
/// text starting with `-` (a markdown bullet, for instance) reaches bd intact.
fn validate_memory_content(content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("Memory content must not be empty".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Parsers for bd --json output
// ---------------------------------------------------------------------------

/// Parses `bd memories [search] --json`.
///
/// The payload is a flat object of `key -> content`, plus the `schema_version`
/// sentinel. Non-string values are skipped defensively: a future bd version
/// adding another metadata field must not corrupt the entry list.
/// Entries are sorted by key for a stable UI ordering (bd returns no timestamp
/// to sort by).
pub(crate) fn parse_memories_json(stdout: &str) -> Result<Vec<MemoryEntry>, String> {
    let value: serde_json::Value =
        serde_json::from_str(stdout).map_err(|e| format!("Failed to parse bd output: {}", e))?;

    let map = value
        .as_object()
        .ok_or_else(|| "Expected a JSON object from 'bd memories --json'".to_string())?;

    let mut entries: Vec<MemoryEntry> = map
        .iter()
        .filter(|(key, _)| key.as_str() != SCHEMA_VERSION_KEY)
        .filter_map(|(key, value)| {
            value.as_str().map(|content| MemoryEntry {
                key: key.clone(),
                content: content.to_string(),
            })
        })
        .collect();

    entries.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(entries)
}

/// Parses `bd recall <key> --json`, returning `None` when the key is unknown.
pub(crate) fn parse_recall_json(stdout: &str) -> Result<Option<String>, String> {
    let value: serde_json::Value =
        serde_json::from_str(stdout).map_err(|e| format!("Failed to parse bd output: {}", e))?;

    if !json_flag(&value, "found") {
        return Ok(None);
    }

    Ok(Some(
        value
            .get("value")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    ))
}

/// Parses `bd remember --key <key> --json -- <content>`, returning bd's action
/// (`"remembered"` for a new memory, `"updated"` for an existing one).
pub(crate) fn parse_remember_json(stdout: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(stdout).map_err(|e| format!("Failed to parse bd output: {}", e))?;

    value
        .get("action")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "bd did not report an action for the stored memory".to_string())
}

/// Parses `bd forget <key> --json`, returning whether a memory was deleted.
///
/// bd exits 0 whether or not the key existed, and reports booleans as JSON
/// *strings* (`"deleted": "true"` / `"found": "false"`), so a missing key is
/// only detectable from the payload.
pub(crate) fn parse_forget_json(stdout: &str) -> Result<bool, String> {
    let value: serde_json::Value =
        serde_json::from_str(stdout).map_err(|e| format!("Failed to parse bd output: {}", e))?;

    if json_flag(&value, "deleted") {
        return Ok(true);
    }
    // An explicit `found: false` is the documented "no such key" response.
    if value.get("found").is_some() && !json_flag(&value, "found") {
        return Ok(false);
    }
    Err("Unexpected response from 'bd forget'".to_string())
}

/// Reads a boolean field that bd may encode as either a JSON bool or a string.
fn json_flag(value: &serde_json::Value, field: &str) -> bool {
    match value.get(field) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// bd invocation
// ---------------------------------------------------------------------------

/// An error from invoking bd, already shaped into an HTTP response.
type BdError = (StatusCode, String);

/// Whether bd printed a JSON object, i.e. a structured answer rather than a
/// crash or a usage error.
///
/// Used to decide whether a non-zero exit still carries a meaningful payload —
/// see [`run_bd_lenient`].
pub(crate) fn is_json_object(stdout: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(stdout)
        .map(|v| v.is_object())
        .unwrap_or(false)
}

/// Runs bd and requires a successful exit.
///
/// Used for `bd memories` and `bd remember`, where a non-zero exit is a genuine
/// failure.
async fn run_bd(project_path: &Path, args: &[&str]) -> Result<String, BdError> {
    let output = bd_output(project_path, args).await?;

    if !output.success {
        return Err(bd_failure(args, &output));
    }

    Ok(output.stdout)
}

/// Runs bd, tolerating a non-zero exit when bd still produced a JSON object.
///
/// `bd recall` and `bd forget` **exit 1 when the key does not exist** but still
/// print the JSON describing the miss (`{"found": "false", ...}`). For those two
/// commands the payload, not the exit status, is the authoritative answer, so
/// treating a non-zero exit as fatal would turn every legitimate 404 into a 500.
/// Verified live against bd 1.1.0 during bweb-1vr — a bug the unit tests missed,
/// because they exercised the parsers without the exit status around them.
async fn run_bd_lenient(project_path: &Path, args: &[&str]) -> Result<String, BdError> {
    let output = bd_output(project_path, args).await?;

    if !output.success && !is_json_object(&output.stdout) {
        return Err(bd_failure(args, &output));
    }

    Ok(output.stdout)
}

/// Raw result of a bd invocation.
struct BdOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Builds the error for a bd invocation that failed without a usable payload.
fn bd_failure(args: &[&str], output: &BdOutput) -> BdError {
    let detail = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    tracing::warn!("bd {} failed: {}", args.join(" "), detail);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("bd {} failed: {}", args.join(" "), detail),
    )
}

/// Validates the project path and runs bd inside it, returning its raw output.
///
/// The project directory is used as the working directory so that bd resolves
/// the project's own database exactly as it would for a developer running the
/// command by hand.
async fn bd_output(project_path: &Path, args: &[&str]) -> Result<BdOutput, BdError> {
    validate_path_security(project_path).map_err(|e| (StatusCode::FORBIDDEN, e))?;

    if !project_path.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Project directory does not exist: {}",
                project_path.display()
            ),
        ));
    }

    let bd_path = super::find_bd().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "bd CLI not found. Install beads (https://github.com/steveyegge/beads) or add bd to PATH.".to_string(),
        )
    })?;

    let mut cmd = hidden_command(bd_path);
    cmd.args(args).current_dir(project_path);

    let output = tokio::time::timeout(BD_TIMEOUT, cmd.output())
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                format!("bd {} timed out after {:?}", args.join(" "), BD_TIMEOUT),
            )
        })?
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to execute bd: {}", e),
            )
        })?;

    Ok(BdOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

/// Turns a `BdError` into a JSON error response.
fn error_response(err: BdError) -> (StatusCode, Json<serde_json::Value>) {
    let (status, message) = err;
    (status, Json(serde_json::json!({ "error": message })))
}

/// Turns a parse failure into a 502 — bd ran, but said something unexpected.
fn parse_error(message: String) -> (StatusCode, Json<serde_json::Value>) {
    tracing::warn!("Unexpected bd output: {}", message);
    (
        StatusCode::BAD_GATEWAY,
        Json(serde_json::json!({ "error": message })),
    )
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// GET `/api/memory?path={project_path}[&search={term}]`
///
/// Lists the project's bd memories, optionally filtered by a search term.
pub async fn list_memory(Query(params): Query<MemoryListParams>) -> impl IntoResponse {
    let project_path = PathBuf::from(&params.path);

    let search = params.search.as_deref().map(str::trim).unwrap_or_default();
    let mut args: Vec<&str> = vec!["memories"];
    if !search.is_empty() {
        args.push(search);
    }
    args.push("--json");

    let stdout = match run_bd(&project_path, &args).await {
        Ok(out) => out,
        Err(e) => return error_response(e),
    };

    let entries = match parse_memories_json(&stdout) {
        Ok(entries) => entries,
        Err(e) => return parse_error(e),
    };

    let stats = MemoryStats {
        total: entries.len(),
    };

    (
        StatusCode::OK,
        Json(serde_json::json!(MemoryListResponse { entries, stats })),
    )
}

/// GET `/api/memory/stats?path={project_path}`
///
/// Lightweight endpoint returning only the memory count.
pub async fn memory_stats(Query(params): Query<MemoryParams>) -> impl IntoResponse {
    let project_path = PathBuf::from(&params.path);

    let stdout = match run_bd(&project_path, &["memories", "--json"]).await {
        Ok(out) => out,
        Err(e) => return error_response(e),
    };

    let entries = match parse_memories_json(&stdout) {
        Ok(entries) => entries,
        Err(e) => return parse_error(e),
    };

    (
        StatusCode::OK,
        Json(serde_json::json!(MemoryStats {
            total: entries.len()
        })),
    )
}

/// GET `/api/memory/entry?path={project_path}&key={key}`
///
/// Reads the full content of a single memory (`bd recall`).
pub async fn get_memory(Query(params): Query<MemoryEntryParams>) -> impl IntoResponse {
    if let Err(e) = validate_memory_key(&params.key) {
        return error_response((StatusCode::BAD_REQUEST, e));
    }

    let project_path = PathBuf::from(&params.path);

    // Lenient: bd exits 1 for an unknown key but still reports `found: false`.
    let stdout = match run_bd_lenient(&project_path, &["recall", &params.key, "--json"]).await {
        Ok(out) => out,
        Err(e) => return error_response(e),
    };

    match parse_recall_json(&stdout) {
        Ok(Some(content)) => (
            StatusCode::OK,
            Json(serde_json::json!(MemoryEntry {
                key: params.key,
                content,
            })),
        ),
        Ok(None) => error_response((
            StatusCode::NOT_FOUND,
            format!("Memory with key '{}' not found", params.key),
        )),
        Err(e) => parse_error(e),
    }
}

/// POST `/api/memory` — create a memory.
///
/// This path did not exist before bweb-1vr: the legacy JSONL API could only
/// edit or delete entries that some other tool had written.
pub async fn create_memory(Json(payload): Json<RememberRequest>) -> impl IntoResponse {
    remember(payload).await
}

/// PUT `/api/memory` — update a memory.
///
/// `bd remember --key` upserts, so create and update issue the same command.
pub async fn update_memory(Json(payload): Json<RememberRequest>) -> impl IntoResponse {
    remember(payload).await
}

/// Shared implementation of create and update.
async fn remember(payload: RememberRequest) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(e) = validate_memory_key(&payload.key) {
        return error_response((StatusCode::BAD_REQUEST, e));
    }
    if let Err(e) = validate_memory_content(&payload.content) {
        return error_response((StatusCode::BAD_REQUEST, e));
    }

    let project_path = PathBuf::from(&payload.path);

    // `--` terminates flag parsing so content starting with '-' is preserved.
    let args = ["remember", "--key", &payload.key, "--json", "--", &payload.content];

    let stdout = match run_bd(&project_path, &args).await {
        Ok(out) => out,
        Err(e) => return error_response(e),
    };

    let action = match parse_remember_json(&stdout) {
        Ok(action) => action,
        Err(e) => return parse_error(e),
    };

    let created = action == "remembered";
    (
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(serde_json::json!({
            "success": true,
            "created": created,
            "entry": MemoryEntry {
                key: payload.key,
                content: payload.content,
            }
        })),
    )
}

/// DELETE `/api/memory` — permanently remove a memory (`bd forget`).
///
/// bd has no archive concept, so the legacy `archive` flag is gone.
pub async fn delete_memory(Json(payload): Json<ForgetRequest>) -> impl IntoResponse {
    if let Err(e) = validate_memory_key(&payload.key) {
        return error_response((StatusCode::BAD_REQUEST, e));
    }

    let project_path = PathBuf::from(&payload.path);

    // Lenient: bd exits 1 for an unknown key but still reports `found: false`.
    let stdout = match run_bd_lenient(&project_path, &["forget", &payload.key, "--json"]).await {
        Ok(out) => out,
        Err(e) => return error_response(e),
    };

    match parse_forget_json(&stdout) {
        Ok(true) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true, "key": payload.key })),
        ),
        Ok(false) => error_response((
            StatusCode::NOT_FOUND,
            format!("Memory with key '{}' not found", payload.key),
        )),
        Err(e) => parse_error(e),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- parse_memories_json --------------------------------------------

    /// Captured verbatim from a real `bd memories --json` run (bd 1.1.0).
    const MEMORIES_SAMPLE: &str = r#"{
        "beads-web-build-windows": "Use the GNU toolchain.",
        "bd-cli-winget-path": "bd lives in the winget package folder.",
        "schema_version": 1
    }"#;

    #[test]
    fn parses_memories_into_entries() {
        let entries = parse_memories_json(MEMORIES_SAMPLE).unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn drops_the_schema_version_sentinel() {
        let entries = parse_memories_json(MEMORIES_SAMPLE).unwrap();
        assert!(
            !entries.iter().any(|e| e.key == SCHEMA_VERSION_KEY),
            "schema_version is protocol metadata and must not surface as a memory"
        );
    }

    #[test]
    fn sorts_entries_by_key() {
        let entries = parse_memories_json(MEMORIES_SAMPLE).unwrap();
        assert_eq!(entries[0].key, "bd-cli-winget-path");
        assert_eq!(entries[1].key, "beads-web-build-windows");
    }

    #[test]
    fn keeps_entry_content() {
        let entries = parse_memories_json(MEMORIES_SAMPLE).unwrap();
        assert_eq!(entries[1].content, "Use the GNU toolchain.");
    }

    #[test]
    fn parses_empty_memories() {
        let entries = parse_memories_json(r#"{"schema_version": 1}"#).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn skips_future_non_string_metadata_fields() {
        // A future bd version adding a numeric field must not break the list.
        let json = r#"{"a": "content", "entry_count": 7, "schema_version": 1}"#;
        let entries = parse_memories_json(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].key, "a");
    }

    #[test]
    fn rejects_malformed_memories_json() {
        assert!(parse_memories_json("not json").is_err());
    }

    #[test]
    fn rejects_non_object_memories_json() {
        assert!(parse_memories_json(r#"["a", "b"]"#).is_err());
    }

    // -- parse_recall_json ----------------------------------------------

    #[test]
    fn parses_found_recall() {
        let json = r#"{"found": true, "key": "k", "value": "the content", "schema_version": 1}"#;
        assert_eq!(
            parse_recall_json(json).unwrap(),
            Some("the content".to_string())
        );
    }

    #[test]
    fn parses_missing_recall_as_none() {
        let json = r#"{"found": false, "key": "k", "value": "", "schema_version": 1}"#;
        assert_eq!(parse_recall_json(json).unwrap(), None);
    }

    #[test]
    fn rejects_malformed_recall_json() {
        assert!(parse_recall_json("{oops").is_err());
    }

    // -- parse_remember_json --------------------------------------------

    #[test]
    fn parses_remembered_action_for_new_memory() {
        let json = r#"{"action": "remembered", "key": "k", "value": "v", "schema_version": 1}"#;
        assert_eq!(parse_remember_json(json).unwrap(), "remembered");
    }

    #[test]
    fn parses_updated_action_for_existing_memory() {
        let json = r#"{"action": "updated", "key": "k", "value": "v", "schema_version": 1}"#;
        assert_eq!(parse_remember_json(json).unwrap(), "updated");
    }

    #[test]
    fn rejects_remember_response_without_action() {
        assert!(parse_remember_json(r#"{"key": "k"}"#).is_err());
    }

    // -- parse_forget_json ----------------------------------------------

    #[test]
    fn parses_string_encoded_deleted_true() {
        // bd reports booleans as strings here — verified against bd 1.1.0.
        let json = r#"{"deleted": "true", "key": "k", "schema_version": 1}"#;
        assert!(parse_forget_json(json).unwrap());
    }

    #[test]
    fn parses_string_encoded_found_false_as_not_deleted() {
        let json = r#"{"found": "false", "key": "k", "schema_version": 1}"#;
        assert!(!parse_forget_json(json).unwrap());
    }

    #[test]
    fn tolerates_real_booleans_from_a_future_bd() {
        assert!(parse_forget_json(r#"{"deleted": true}"#).unwrap());
        assert!(!parse_forget_json(r#"{"found": false}"#).unwrap());
    }

    #[test]
    fn rejects_unrecognized_forget_response() {
        assert!(parse_forget_json(r#"{"schema_version": 1}"#).is_err());
    }

    // -- validate_memory_key --------------------------------------------

    #[test]
    fn accepts_bd_style_slug_keys() {
        assert!(validate_memory_key("beads-web-build-windows").is_ok());
        assert!(validate_memory_key("auth_jwt.v2").is_ok());
        assert!(validate_memory_key("bd42").is_ok());
    }

    #[test]
    fn rejects_empty_key() {
        assert!(validate_memory_key("").is_err());
    }

    #[test]
    fn rejects_leading_dash_key() {
        // Would be consumed as a flag by bd's argument parser.
        assert!(validate_memory_key("-json").is_err());
    }

    #[test]
    fn rejects_reserved_schema_version_key() {
        assert!(validate_memory_key(SCHEMA_VERSION_KEY).is_err());
    }

    #[test]
    fn rejects_keys_with_shell_or_space_characters() {
        for key in ["has space", "semi;colon", "quote\"d", "back`tick", "sl/ash"] {
            assert!(
                validate_memory_key(key).is_err(),
                "expected {:?} to be rejected",
                key
            );
        }
    }

    #[test]
    fn rejects_overlong_key() {
        assert!(validate_memory_key(&"a".repeat(MAX_KEY_LEN + 1)).is_err());
        assert!(validate_memory_key(&"a".repeat(MAX_KEY_LEN)).is_ok());
    }

    // -- is_json_object --------------------------------------------------
    //
    // Guards the regression found during bweb-1vr live verification: bd exits 1
    // for an unknown key on `recall`/`forget` while still printing a JSON
    // payload, so the payload must be preferred over the exit status. Treating
    // the exit status as authoritative turned every 404 into a 500.

    #[test]
    fn recognizes_a_structured_bd_payload() {
        assert!(is_json_object(r#"{"found": "false", "key": "ghost"}"#));
    }

    #[test]
    fn recognizes_a_payload_with_surrounding_whitespace() {
        assert!(is_json_object("\n  {\"deleted\": \"true\"}\n"));
    }

    #[test]
    fn does_not_treat_a_usage_error_as_a_payload() {
        assert!(!is_json_object("Error: accepts 1 arg(s), received 4"));
        assert!(!is_json_object(""));
    }

    #[test]
    fn does_not_treat_a_json_array_as_a_payload() {
        assert!(!is_json_object(r#"["a"]"#));
    }

    // -- validate_memory_content ----------------------------------------

    #[test]
    fn rejects_blank_content() {
        assert!(validate_memory_content("").is_err());
        assert!(validate_memory_content("   \n ").is_err());
    }

    #[test]
    fn accepts_content_starting_with_a_dash() {
        // Passed after `--`, so a markdown bullet survives.
        assert!(validate_memory_content("- a bullet point").is_ok());
    }
}
