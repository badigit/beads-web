//! Build script: locates the embedded frontend and ties crate freshness to it.
//!
//! `rust-embed` inlines the Next.js static export into the binary at compile
//! time. Two things have to be arranged here, because the macro itself can do
//! neither:
//!
//! 1. **Where the export lives.** `out/` is an untracked build artifact, so a
//!    fresh `git worktree` does not have one — and `rust-embed` hard-errors on a
//!    missing folder, which made `cargo clippy` (and therefore the pre-commit
//!    hook) fail for *any* change under `server/` made in a worktree. The crate
//!    now takes the path from `BEADS_WEB_FRONTEND_DIR`, resolved below.
//!
//! 2. **Rebuild on frontend change.** Cargo has no idea the directory is a build
//!    input. Without the `rerun-if-changed` lines below, a frontend-only change
//!    rebuilt `out/` while Cargo considered the crate unchanged and skipped
//!    compilation entirely — leaving the *previous* frontend embedded while the
//!    build reported success (bweb-4tn: a release build finished in 7s with no
//!    `Compiling` line, and the deployed UI silently stayed stale).

use std::path::{Path, PathBuf};
use std::process::Command;

/// Environment variable read by the `#[folder]` attribute in `main.rs`.
const FRONTEND_DIR_VAR: &str = "BEADS_WEB_FRONTEND_DIR";

fn main() {
    let local = local_frontend_dir();
    let frontend = resolve_frontend_dir(&local);

    println!(
        "cargo:rustc-env={}={}",
        FRONTEND_DIR_VAR,
        frontend.display()
    );
    println!("cargo:rerun-if-env-changed={}", FRONTEND_DIR_VAR);

    // Watched even when it does not exist: Cargo re-runs this script once the
    // path appears, so building the frontend inside a worktree takes effect
    // without a manual `cargo clean`.
    println!("cargo:rerun-if-changed={}", local.display());

    println!("cargo:rerun-if-changed={}", frontend.display());
    watch_recursively(&frontend);
}

/// The export directory belonging to *this* checkout: `<crate>/../out`.
fn local_frontend_dir() -> PathBuf {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR is always set for build scripts");
    normalize(&Path::new(&manifest_dir).join("..").join("out"))
}

/// Picks the frontend to embed, in descending order of specificity:
///
/// 1. `BEADS_WEB_FRONTEND_DIR` — explicit override, hard error if it is bogus.
/// 2. `<crate>/../out` — the normal case, and the only one in a plain checkout.
/// 3. The main repository's `out/` — the worktree fallback, so lint and test
///    builds work without a per-worktree `npm ci && npm run build`.
/// 4. An empty scratch directory, so compilation still succeeds where no
///    frontend exists at all (fresh clone, CI lint job).
///
/// Falling back is announced with `cargo:warning`, never silently: embedding
/// somebody else's frontend — or none — must be visible in the build log.
fn resolve_frontend_dir(local: &Path) -> PathBuf {
    if let Some(explicit) = std::env::var_os(FRONTEND_DIR_VAR) {
        let path = normalize(Path::new(&explicit));
        assert!(
            path.is_dir(),
            "{FRONTEND_DIR_VAR} points at {}, which is not a directory",
            path.display()
        );
        return path;
    }

    if local.is_dir() {
        return local.to_path_buf();
    }

    if let Some(main_repo_out) = main_repo_frontend_dir() {
        println!(
            "cargo:warning=no frontend at {} — embedding the main checkout's {} instead. \
             Run `npm ci && npm run build` here (or set {FRONTEND_DIR_VAR}) to embed this \
             worktree's own frontend.",
            local.display(),
            main_repo_out.display()
        );
        return main_repo_out;
    }

    println!(
        "cargo:warning=no frontend found at {} — embedding an EMPTY asset set. \
         The resulting binary serves no UI. Run `npm ci && npm run build` first.",
        local.display()
    );
    empty_placeholder_dir()
}

/// `out/` of the main repository, when this crate is being built from a
/// worktree and the main checkout has a build.
///
/// `git rev-parse --git-common-dir` points at the main repo's `.git` and equals
/// `--git-dir` in a plain checkout — the same technique the build and hook
/// scripts already use to share one Cargo target across worktrees.
fn main_repo_frontend_dir() -> Option<PathBuf> {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").ok()?;
    let output = Command::new("git")
        .args(["-C", &manifest_dir, "rev-parse", "--git-common-dir"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let common_dir = String::from_utf8(output.stdout).ok()?;
    let common_dir = Path::new(common_dir.trim());
    let common_dir = if common_dir.is_absolute() {
        common_dir.to_path_buf()
    } else {
        Path::new(&manifest_dir).join(common_dir)
    };

    let candidate = normalize(&common_dir.join("..").join("out"));
    candidate.is_dir().then_some(candidate)
}

/// A guaranteed-empty directory under `OUT_DIR`, so the last-resort fallback
/// never writes into the source tree of this or any other checkout.
fn empty_placeholder_dir() -> PathBuf {
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is always set for build scripts");
    let placeholder = Path::new(&out_dir).join("empty-frontend");
    std::fs::create_dir_all(&placeholder).expect("failed to create empty frontend placeholder");
    placeholder
}

/// Resolves `.` and `..` lexically, without touching the filesystem.
///
/// `std::fs::canonicalize` is deliberately avoided: on Windows it returns a
/// `\\?\`-prefixed path, which does not survive the round trip through the
/// `#[folder]` attribute.
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            other => result.push(other),
        }
    }
    result
}

/// Declares every file under `dir` as a build input, recursively.
///
/// Each file is emitted explicitly instead of relying on Cargo's directory
/// scanning, which has varied across Cargo versions and platforms — this is the
/// one place where being conservative costs nothing.
fn watch_recursively(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            watch_recursively(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}
