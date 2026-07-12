//! Git route handlers for checking repository status.
//!
//! Provides endpoints for querying git branch status and repository state.

use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::path::Path;
use crate::process::hidden_command;

use super::validate_path_security;

/// Query parameters for the branch status endpoint.
#[derive(Deserialize)]
pub struct GitStatusParams {
    /// Path to the git repository.
    pub path: String,
    /// Branch name to check status for.
    pub branch: String,
}

/// Response body for the branch status endpoint.
#[derive(Serialize)]
pub struct BranchStatusResponse {
    /// Whether the branch exists.
    pub exists: bool,
    /// Number of commits ahead of main.
    pub ahead: i32,
    /// Number of commits behind main.
    pub behind: i32,
    /// Whether there are uncommitted changes.
    pub dirty: bool,
}

/// Get the status of a git branch relative to main.
///
/// # Endpoint
///
/// `GET /api/git/branch-status?path=...&branch=...`
///
/// # Response
///
/// Returns branch existence, ahead/behind counts, and dirty status.
pub async fn branch_status(Query(params): Query<GitStatusParams>) -> impl IntoResponse {
    let repo_path = Path::new(&params.path);

    if let Err(e) = validate_path_security(repo_path) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": e }))).into_response();
    }

    // Validate repository path exists
    if !repo_path.exists() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Repository path does not exist: {}", params.path)
            })),
        )
            .into_response();
    }

    if !repo_path.is_dir() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("Path is not a directory: {}", params.path)
            })),
        )
            .into_response();
    }

    // Check if branch exists
    let branch_exists = check_branch_exists(&params.path, &params.branch).await;

    if !branch_exists {
        return Json(BranchStatusResponse {
            exists: false,
            ahead: 0,
            behind: 0,
            dirty: false,
        })
        .into_response();
    }

    // Get ahead/behind counts relative to main
    let (ahead, behind) = get_ahead_behind(&params.path, &params.branch).await;

    // Check for uncommitted changes
    let dirty = check_dirty(&params.path).await;

    Json(BranchStatusResponse {
        exists: true,
        ahead,
        behind,
        dirty,
    })
    .into_response()
}

/// Check if a branch exists in the repository.
async fn check_branch_exists(repo_path: &str, branch: &str) -> bool {
    let output = hidden_command("git")
        .args(["rev-parse", "--verify", branch])
        .current_dir(repo_path)
        .output()
        .await;

    matches!(output, Ok(o) if o.status.success())
}

/// Get the number of commits ahead and behind relative to main.
async fn get_ahead_behind(repo_path: &str, branch: &str) -> (i32, i32) {
    // Try both 'main' and 'master' as the base branch
    let base_branches = ["main", "master"];

    for base in base_branches {
        let output = hidden_command("git")
            .args([
                "rev-list",
                "--left-right",
                "--count",
                &format!("{}...{}", base, branch),
            ])
            .current_dir(repo_path)
            .output()
            .await;

        if let Ok(output) = output {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let parts: Vec<&str> = stdout.trim().split('\t').collect();
                if parts.len() == 2 {
                    let behind = parts[0].parse().unwrap_or(0);
                    let ahead = parts[1].parse().unwrap_or(0);
                    return (ahead, behind);
                }
            }
        }
    }

    (0, 0)
}

/// Check if the repository has uncommitted changes.
async fn check_dirty(repo_path: &str) -> bool {
    let output = hidden_command("git")
        .args(["status", "--porcelain"])
        .current_dir(repo_path)
        .output()
        .await;

    match output {
        Ok(o) => !o.stdout.is_empty(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_branch_status_response_serialization() {
        let response = BranchStatusResponse {
            exists: true,
            ahead: 5,
            behind: 2,
            dirty: false,
        };
        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"exists\":true"));
        assert!(json.contains("\"ahead\":5"));
        assert!(json.contains("\"behind\":2"));
        assert!(json.contains("\"dirty\":false"));
    }
}
