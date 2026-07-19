//! Filesystem API route handlers.
//!
//! Provides endpoints for listing directories and checking path existence.

use axum::{
    extract::Query,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::validate_path_security;

/// Query parameters for the list directory endpoint.
#[derive(Debug, Deserialize)]
pub struct FsListParams {
    /// The directory path to list
    pub path: String,
}

/// Query parameters for the path exists endpoint.
#[derive(Debug, Deserialize)]
pub struct FsExistsParams {
    /// The path to check for existence
    pub path: String,
}

/// Query parameters for the read file endpoint.
#[derive(Debug, Deserialize)]
pub struct FsReadParams {
    /// The file path to read (relative, e.g., ".designs/epic.md")
    pub path: String,
    /// The project path (absolute directory path)
    pub project_path: String,
}

/// Request body for opening a path in an external application.
#[derive(Debug, Deserialize)]
pub struct OpenExternalRequest {
    /// The path to open
    pub path: String,
    /// Target application: "vscode", "cursor", or "finder"
    pub target: String,
}

/// A single directory entry.
#[derive(Debug, Serialize)]
pub struct DirectoryEntry {
    /// The file/directory name
    pub name: String,
    /// The full path
    pub path: String,
    /// Whether this entry is a directory
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
}

/// GET /api/fs/list?path=/some/directory
///
/// Lists the contents of a directory, filtering out hidden files
/// except for .beads directories.
pub async fn list_directory(Query(params): Query<FsListParams>) -> impl IntoResponse {
    let dir_path = PathBuf::from(&params.path);

    // Security: Validate path is within allowed directories
    if let Err(e) = validate_path_security(&dir_path) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": e })),
        );
    }

    // Check if path exists and is a directory
    if !dir_path.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Path does not exist" })),
        );
    }

    if !dir_path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Path is not a directory" })),
        );
    }

    // Read directory entries
    let read_dir = match std::fs::read_dir(&dir_path) {
        Ok(rd) => rd,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to read directory: {}", e) })),
            );
        }
    };

    let mut entries: Vec<DirectoryEntry> = Vec::new();

    for entry_result in read_dir {
        let entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("Failed to read directory entry: {}", e);
                continue;
            }
        };

        let name = entry.file_name().to_string_lossy().to_string();

        // Filter out hidden files except .beads
        if name.starts_with('.') && name != ".beads" {
            continue;
        }

        let path = entry.path();
        let is_directory = path.is_dir();

        entries.push(DirectoryEntry {
            name,
            path: path.to_string_lossy().to_string(),
            is_directory,
        });
    }

    // Sort entries: directories first, then alphabetically
    entries.sort_by(|a, b| {
        match (a.is_directory, b.is_directory) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    (StatusCode::OK, Json(serde_json::json!({ "entries": entries })))
}

/// GET /api/fs/exists?path=/some/path
///
/// Checks if a path exists on the filesystem.
pub async fn path_exists(Query(params): Query<FsExistsParams>) -> impl IntoResponse {
    let path = PathBuf::from(&params.path);

    // Security: Validate path is within allowed directories
    if let Err(e) = validate_path_security(&path) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": e })),
        );
    }

    let exists = path.exists();

    (StatusCode::OK, Json(serde_json::json!({ "exists": exists })))
}

/// Directories a design-doc path is allowed to point into.
///
/// MUST stay in sync with `DESIGN_DOC_PREFIXES` in `src/lib/design-doc.ts` — a
/// mismatch makes the UI render a preview this backend then 403s on (the
/// failure mode fixed in bweb-489.11). Parity is covered by tests on both sides.
///
/// - `.designs/` — superpowers writes `.designs/bd-{id}/spec.md` and `plan.md`
/// - `docs/designs/` — this repo's own design docs
/// - `docs/superpowers/specs/` — superpowers' non-beads project location
pub const DESIGN_DOC_PREFIXES: [&str; 3] =
    [".designs/", "docs/designs/", "docs/superpowers/specs/"];

/// Whether a relative path sits under one of [`DESIGN_DOC_PREFIXES`].
///
/// Rejects any path containing `..` so a caller cannot escape the allow-listed
/// directories before [`validate_path_security`] ever sees the joined path.
fn has_design_doc_prefix(path: &str) -> bool {
    if path.contains("..") {
        return false;
    }
    DESIGN_DOC_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

/// Names of the `.md` files directly inside `dir`, sorted alphabetically.
///
/// Subdirectories and non-markdown files are skipped.
fn collect_markdown_files(dir: &std::path::Path) -> std::io::Result<Vec<String>> {
    let mut names: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_file())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        })
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    names.sort();
    Ok(names)
}

/// The shared 403 body used when a path falls outside the allow-list.
fn design_doc_prefix_denied() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "error": format!(
            "Access denied: path must start with one of {}",
            DESIGN_DOC_PREFIXES.join(", ")
        )
    }))
}

/// GET /api/fs/list-design-docs?path=.designs/bd-{id}&project_path=/absolute/path
///
/// Lists the markdown files inside a design-doc directory. Used to render the
/// spec/plan file list superpowers writes to `.designs/bd-{id}/`.
///
/// # Security constraints:
/// - Path must start with one of [`DESIGN_DOC_PREFIXES`] and contain no `..`
/// - Resolved path must be within allowed directories
pub async fn list_design_docs(Query(params): Query<FsReadParams>) -> impl IntoResponse {
    if !has_design_doc_prefix(&params.path) {
        return (StatusCode::FORBIDDEN, design_doc_prefix_denied());
    }

    let dir_path = PathBuf::from(&params.project_path).join(&params.path);

    if let Err(e) = validate_path_security(&dir_path) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": e })),
        );
    }

    if !dir_path.is_dir() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Directory does not exist" })),
        );
    }

    match collect_markdown_files(&dir_path) {
        Ok(files) => (
            StatusCode::OK,
            Json(serde_json::json!({ "files": files, "path": params.path })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to list design docs: {}", e)
            })),
        ),
    }
}

/// GET /api/fs/read?path=.designs/{EPIC_ID}.md&project_path=/absolute/path
///
/// Reads a design document file from an allow-listed design-doc directory.
///
/// # Security constraints:
/// - Max file size: 100KB
/// - Only .md extension allowed
/// - Path must be within project directory
/// - Path must start with one of [`DESIGN_DOC_PREFIXES`] and contain no `..`
pub async fn read_file(Query(params): Query<FsReadParams>) -> impl IntoResponse {
    // Security: Path must sit under an allow-listed design-doc directory
    if !has_design_doc_prefix(&params.path) {
        return (StatusCode::FORBIDDEN, design_doc_prefix_denied());
    }

    // Parse relative path to validate extension
    let relative_path = PathBuf::from(&params.path);

    // Security: Only .md extension allowed
    if relative_path.extension().and_then(|s| s.to_str()) != Some("md") {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "Access denied: only .md files are allowed"
            })),
        );
    }

    // Join project path with relative design doc path to get absolute path
    let project_root = PathBuf::from(&params.project_path);
    let file_path = project_root.join(&params.path);

    // Security: Validate absolute path is within allowed directories
    if let Err(e) = validate_path_security(&file_path) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": e })),
        );
    }

    // Check if file exists
    if !file_path.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "File does not exist" })),
        );
    }

    // Check if path is a file (not a directory)
    if !file_path.is_file() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Path is not a file" })),
        );
    }

    // Security: Check file size (max 100KB)
    let metadata = match std::fs::metadata(&file_path) {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Failed to read file metadata: {}", e)
                })),
            );
        }
    };

    const MAX_FILE_SIZE: u64 = 100 * 1024; // 100KB
    if metadata.len() > MAX_FILE_SIZE {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "error": format!("File too large: {} bytes (max {} bytes)", metadata.len(), MAX_FILE_SIZE)
            })),
        );
    }

    // Read file contents
    let contents = match std::fs::read_to_string(&file_path) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("Failed to read file: {}", e)
                })),
            );
        }
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "content": contents,
            "path": params.path
        })),
    )
}

/// POST /api/fs/open-external
///
/// Opens a path in an external application (VS Code, Cursor, or Finder/Explorer).
///
/// # Security constraints:
/// - Path must be within user's home directory
/// - Target must be one of: "vscode", "cursor", "finder"
pub async fn open_external(Json(request): Json<OpenExternalRequest>) -> impl IntoResponse {
    let path = PathBuf::from(&request.path);

    // Security: Validate path is within allowed directories
    if let Err(e) = validate_path_security(&path) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": e })),
        );
    }

    // Check if path exists
    if !path.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Path does not exist" })),
        );
    }

    // Execute the appropriate command based on target
    let result = match request.target.as_str() {
        "vscode" => {
            // Try "code" command first, fall back to macOS open command
            let code_result = crate::process::hidden_std_command("code").arg(&path).spawn();
            if code_result.is_err() {
                // Fallback for macOS: use open -a "Visual Studio Code"
                #[cfg(target_os = "macos")]
                {
                    crate::process::hidden_std_command("open")
                        .args(["-a", "Visual Studio Code"])
                        .arg(&path)
                        .spawn()
                }
                #[cfg(not(target_os = "macos"))]
                {
                    code_result
                }
            } else {
                code_result
            }
        }
        "cursor" => {
            // Try "cursor" command first, fall back to macOS open command
            let cursor_result = crate::process::hidden_std_command("cursor").arg(&path).spawn();
            if cursor_result.is_err() {
                // Fallback for macOS: use open -a "Cursor"
                #[cfg(target_os = "macos")]
                {
                    crate::process::hidden_std_command("open")
                        .args(["-a", "Cursor"])
                        .arg(&path)
                        .spawn()
                }
                #[cfg(not(target_os = "macos"))]
                {
                    cursor_result
                }
            } else {
                cursor_result
            }
        }
        "finder" => {
            // Use the `open` crate for cross-platform support
            // On macOS: opens Finder, on Linux: file manager, on Windows: Explorer
            match open::that(&path) {
                Ok(_) => {
                    return (
                        StatusCode::OK,
                        Json(serde_json::json!({ "success": true })),
                    );
                }
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "error": format!("Failed to open: {}", e)
                        })),
                    );
                }
            }
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "Invalid target. Must be 'vscode', 'cursor', or 'finder'"
                })),
            );
        }
    };

    match result {
        Ok(_) => (
            StatusCode::OK,
            Json(serde_json::json!({ "success": true })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("Failed to open: {}. Make sure the application is installed.", e)
            })),
        ),
    }
}

/// GET /api/fs/roots
///
/// Returns the user's home directory and filesystem root paths.
/// On Windows, roots are available drive letters (C:\, D:\, M:\, etc.).
/// On Unix, roots is just ["/"].
pub async fn fs_roots() -> impl IntoResponse {
    let home = directories::UserDirs::new()
        .map(|u| u.home_dir().to_string_lossy().to_string())
        .unwrap_or_default();

    let roots: Vec<String> = if cfg!(windows) {
        // Check drives A-Z for existence
        (b'A'..=b'Z')
            .filter_map(|letter| {
                let drive = format!("{}:\\", letter as char);
                if PathBuf::from(&drive).exists() {
                    Some(drive)
                } else {
                    None
                }
            })
            .collect()
    } else {
        vec!["/".to_string()]
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({ "home": home, "roots": roots })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_directory_entry_serialization() {
        let entry = DirectoryEntry {
            name: "test".to_string(),
            path: "/home/user/test".to_string(),
            is_directory: true,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"isDirectory\":true"));
    }

    #[test]
    fn allows_every_configured_design_doc_prefix() {
        assert!(has_design_doc_prefix(".designs/bd-bweb-489.9/spec.md"));
        assert!(has_design_doc_prefix("docs/designs/epic-support.md"));
        assert!(has_design_doc_prefix(
            "docs/superpowers/specs/2026-07-19-topic-design.md"
        ));
    }

    #[test]
    fn rejects_paths_outside_the_allow_list() {
        assert!(!has_design_doc_prefix("src/lib/design-doc.md"));
        assert!(!has_design_doc_prefix("/etc/passwd"));
        assert!(!has_design_doc_prefix(""));
    }

    #[test]
    fn rejects_parent_directory_traversal() {
        // A `..` anywhere disqualifies the path before it reaches the filesystem.
        assert!(!has_design_doc_prefix("../.designs/escape.md"));
        assert!(!has_design_doc_prefix(".designs/../../etc/passwd"));
        assert!(!has_design_doc_prefix("docs/designs/../../../secret.md"));
    }

    #[test]
    fn prefix_list_matches_the_frontend_allow_list() {
        // Keep in sync with DESIGN_DOC_PREFIXES in src/lib/design-doc.ts.
        assert_eq!(
            DESIGN_DOC_PREFIXES,
            [".designs/", "docs/designs/", "docs/superpowers/specs/"]
        );
    }

    #[test]
    fn lists_only_markdown_files_sorted_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let design_dir = dir.path().join(".designs").join("bd-bweb-489.9");
        std::fs::create_dir_all(&design_dir).unwrap();
        std::fs::write(design_dir.join("plan.md"), "# Plan").unwrap();
        std::fs::write(design_dir.join("spec.md"), "# Spec").unwrap();
        std::fs::write(design_dir.join("notes.txt"), "ignored").unwrap();
        std::fs::create_dir(design_dir.join("subdir")).unwrap();

        let names = collect_markdown_files(&design_dir).unwrap();

        assert_eq!(names, vec!["plan.md".to_string(), "spec.md".to_string()]);
    }

    #[test]
    fn listing_an_empty_directory_yields_no_files() {
        let dir = tempfile::tempdir().unwrap();
        let design_dir = dir.path().join(".designs").join("bd-empty");
        std::fs::create_dir_all(&design_dir).unwrap();

        let names = collect_markdown_files(&design_dir).unwrap();

        assert!(names.is_empty());
    }
}
