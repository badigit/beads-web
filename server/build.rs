//! Build script: ties this crate's freshness to the embedded frontend.
//!
//! `rust-embed` inlines `../out/` (the Next.js static export) into the binary
//! at compile time, but Cargo has no idea that directory is a build input.
//! Without the `rerun-if-changed` lines below, a frontend-only change rebuilt
//! `out/` while Cargo considered the crate unchanged and skipped compilation
//! entirely — leaving the *previous* frontend embedded in the binary while the
//! build reported success (bweb-4tn: a release build finished in 7s with no
//! `Compiling` line, and the deployed UI silently stayed stale).

use std::path::{Path, PathBuf};

fn main() {
    let frontend = frontend_dir();

    // The directory itself, so files being added or removed is a change too.
    println!("cargo:rerun-if-changed={}", frontend.display());
    watch_recursively(&frontend);
}

/// Absolute path to the Next.js export embedded by `rust-embed`.
///
/// Derived from `CARGO_MANIFEST_DIR` rather than a bare relative path so the
/// result does not depend on the working directory the build was invoked from
/// (worktrees and CI both build this crate from varying locations).
fn frontend_dir() -> PathBuf {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR is always set for build scripts");
    Path::new(&manifest_dir).join("..").join("out")
}

/// Declares every file under `dir` as a build input, recursively.
///
/// Each file is emitted explicitly instead of relying on Cargo's directory
/// scanning, which has varied across Cargo versions and platforms — this is the
/// one place where being conservative costs nothing.
///
/// A missing directory is deliberately not an error: `rust-embed` reports that
/// case itself with a clearer message than a build-script panic would give.
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
