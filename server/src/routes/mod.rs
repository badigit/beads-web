//! Route handlers for the beads-server API.
//!
//! This module contains all HTTP route handlers.
//! Additional handlers will be added as API endpoints are implemented.

pub mod agents;
pub mod beads;
pub mod cli;
pub mod dolt;
pub mod fs;
pub mod git;
pub mod memory;
pub mod projects;
pub mod search;
pub mod version;
pub mod watch;
pub mod worktree;

pub use projects::project_routes;
pub use watch::watch_beads;

use axum::{response::IntoResponse, Json};
use directories::UserDirs;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Health check response structure.
#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}

/// Health check endpoint handler.
///
/// Returns a JSON response indicating the server is running.
pub async fn health() -> impl IntoResponse {
    Json(HealthResponse { status: "ok" })
}

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

/// Validates that a path is safe to access.
///
/// # Security
///
/// This function ensures that:
/// - The path can be canonicalized (no path traversal attacks)
/// - On Windows: the path is on a local drive (not a UNC network path)
/// - On Unix: the path is within the user's home directory
///
/// # Returns
///
/// - `Ok(())` if the path is valid and within allowed directories
/// - `Err(String)` with an error message if validation fails
pub fn validate_path_security(path: &Path) -> Result<(), String> {
    // Reject dolt:// virtual paths — these are not filesystem paths
    if path.to_string_lossy().starts_with("dolt://") {
        return Err("dolt:// paths cannot be used for filesystem operations".to_string());
    }

    // Canonicalize paths for comparison (resolves symlinks and ..)
    let canonical_path = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            // If path doesn't exist yet, check the parent
            if let Some(parent) = path.parent() {
                match parent.canonicalize() {
                    Ok(p) => p.join(path.file_name().unwrap_or_default()),
                    Err(_) => return Err("Invalid path".to_string()),
                }
            } else {
                return Err("Invalid path".to_string());
            }
        }
    };

    // On Windows, allow any local drive but block UNC network paths.
    // On Unix, restrict to the user's home directory.
    if cfg!(windows) {
        let path_str = canonical_path.to_string_lossy();
        // Windows canonicalize produces \\?\C:\... (extended-length path prefix).
        // Strip that prefix before checking for actual UNC paths.
        let normalized = path_str
            .strip_prefix("\\\\?\\")
            .unwrap_or(&path_str);
        // Real UNC paths: \\server\share or \\?\UNC\server\share
        if normalized.starts_with("\\\\") || normalized.starts_with("UNC\\") {
            return Err("Access denied: network (UNC) paths are not allowed".to_string());
        }
        // Must start with a drive letter like C:\
        if !normalized.starts_with(|c: char| c.is_ascii_alphabetic()) {
            return Err("Access denied: invalid path".to_string());
        }
    } else {
        let user_dirs = match UserDirs::new() {
            Some(u) => u,
            None => return Err("Could not determine user directories".to_string()),
        };

        let home_dir = user_dirs.home_dir();

        let canonical_home = match home_dir.canonicalize() {
            Ok(h) => h,
            Err(_) => return Err("Could not canonicalize home directory".to_string()),
        };

        if !canonical_path.starts_with(&canonical_home) {
            return Err("Access denied: path must be within home directory".to_string());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_validate_home_path() {
        if let Some(user_dirs) = UserDirs::new() {
            let test_path = user_dirs.home_dir().join("test");
            // This might fail if test doesn't exist, but the parent check should work
            let result = validate_path_security(&test_path);
            // Should either succeed or fail with "Invalid path" (if test doesn't exist)
            assert!(result.is_ok() || result.unwrap_err().contains("Invalid"));
        }
    }

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

    #[test]
    fn test_reject_unsafe_paths() {
        if cfg!(windows) {
            // UNC paths should be rejected
            let result = validate_path_security(&PathBuf::from("\\\\server\\share\\file"));
            assert!(result.is_err());
            let err_msg = result.unwrap_err();
            assert!(err_msg.contains("denied") || err_msg.contains("Invalid") || err_msg.contains("network"));
        } else {
            // Unix: paths outside home should be rejected
            let result = validate_path_security(&PathBuf::from("/etc/passwd"));
            assert!(result.is_err());
            let err_msg = result.unwrap_err();
            assert!(err_msg.contains("denied") || err_msg.contains("Invalid"));
        }
    }
}
