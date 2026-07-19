//! Beads Kanban UI Server
//!
//! An Axum-based HTTP server that serves the beads-kanban-ui frontend
//! and provides API endpoints for backend functionality.

mod config;
mod db;
mod doctor;
mod dolt;
mod process;
mod routes;

use axum::{
    body::Body,
    extract::Extension,
    http::{header, Request, Response, StatusCode},
    response::IntoResponse,
    routing::{delete, get, patch, post, put},
    Router,
};
use rust_embed::Embed;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

/// Embedded static files from the Next.js build output.
///
/// The path is not hardcoded to `../out/` because that directory is an
/// untracked build artifact and is therefore absent from a fresh `git
/// worktree` — which made this crate fail to compile there at all, blocking the
/// pre-commit `cargo clippy` on any `server/` change. `build.rs` resolves the
/// directory (local export, main checkout's export, or an empty placeholder)
/// and hands it over in `BEADS_WEB_FRONTEND_DIR`.
#[derive(Embed)]
#[folder = "$BEADS_WEB_FRONTEND_DIR"]
struct Assets;

/// Serves embedded static files, with fallback to index.html for SPA routing.
async fn serve_static(req: Request<Body>) -> impl IntoResponse {
    let path = req.uri().path().trim_start_matches('/');

    // Try the exact path first
    if let Some(content) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime.as_ref())
            .body(Body::from(content.data.into_owned()))
            .unwrap();
    }

    // Try with .html extension (for Next.js static export)
    let html_path = format!("{}.html", path);
    if let Some(content) = Assets::get(&html_path) {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(content.data.into_owned()))
            .unwrap();
    }

    // Try index.html in subdirectory
    let index_path = if path.is_empty() {
        "index.html".to_string()
    } else {
        format!("{}/index.html", path)
    };
    if let Some(content) = Assets::get(&index_path) {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(content.data.into_owned()))
            .unwrap();
    }

    // Fallback to root index.html for SPA client-side routing
    if let Some(content) = Assets::get("index.html") {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(content.data.into_owned()))
            .unwrap();
    }

    // 404 if nothing found
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(Body::from("Not Found"))
        .unwrap()
}

#[tokio::main]
async fn main() {
    // Initialize tracing subscriber for logging
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .finish();
    tracing::subscriber::set_global_default(subscriber)
        .expect("Failed to set tracing subscriber");

    // `--doctor` prints the same configuration summary plus live connectivity
    // checks, then exits without starting the server.
    if doctor::is_doctor_invocation(std::env::args()) {
        std::process::exit(doctor::run().await);
    }

    // Every setting, and where it came from -- a stale cached environment or a
    // password that no documented source provides must be visible in the first
    // lines of the log, not require digging through `pm2 jlist` (bweb-1ey.2).
    let resolved = config::ResolvedConfig::resolve();
    config::log_startup_summary(&resolved);
    let (port, _) = resolved.server_port;

    // Configure CORS for development
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Initialize the database
    let database = Arc::new(
        db::Database::new().expect("Failed to initialize database"),
    );
    info!("Database initialized");

    // Initialize Dolt connection manager
    let dolt_manager = Arc::new(dolt::DoltManager::new());
    if dolt_manager.check_server().await {
        info!("Dolt server is available at {}", dolt_manager.endpoint());
    } else {
        info!(
            "Dolt server not detected at {} — will use bd CLI / JSONL fallback",
            dolt_manager.endpoint()
        );
    }

    // Check bd CLI compatibility. Its path is already reported by the startup
    // summary above, so only the version and the --json probe are logged here.
    if let Some(bd) = routes::find_bd() {
        if let Ok(output) = process::hidden_std_command(bd).arg("--version").output() {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout);
                info!("bd version: {}", version.trim());
            }
        }
        // Verify --json flag works (older bd versions output plain text)
        let test_dir = std::env::temp_dir();
        if let Ok(output) = process::hidden_std_command(bd)
            .args(["list", "--json", "--limit", "1"])
            .current_dir(&test_dir)
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let trimmed = stdout.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('[') {
                tracing::warn!("⚠ bd CLI does not support --json output");
                tracing::warn!("  Beads will not load for filesystem projects");
                tracing::warn!("  Please update: npm install -g beads");
            }
        }
    } else {
        tracing::warn!("  beads read/write will not work for filesystem projects");
        tracing::warn!("  Install: https://github.com/steveyegge/beads");
    }

    // Initialize version check cache
    let version_cache = routes::version::new_cache();

    // Build the router
    let app = Router::new()
        .route("/api/health", get(routes::health))
        .nest("/api", routes::project_routes().with_state(database.clone()))
        .route("/api/beads", get(routes::beads::read_beads))
        .route("/api/beads/counts", get(routes::beads::read_bead_counts))
        .route("/api/beads/create", post(routes::beads::create_bead_handler))
        .route("/api/beads/update", patch(routes::beads::update_bead_handler))
        // Global cross-project search
        .route("/api/search", get(routes::search::global_search))
        // Dolt endpoints
        .route("/api/dolt/status", get(routes::dolt::dolt_status))
        .route("/api/dolt/databases", get(routes::dolt::dolt_databases))
        .route("/api/dolt/servers", get(routes::dolt::dolt_servers))
        .route("/api/fs/list", get(routes::fs::list_directory))
        .route("/api/fs/exists", get(routes::fs::path_exists))
        .route("/api/fs/read", get(routes::fs::read_file))
        .route(
            "/api/fs/list-design-docs",
            get(routes::fs::list_design_docs),
        )
        .route("/api/fs/roots", get(routes::fs::fs_roots))
        .route("/api/fs/open-external", post(routes::fs::open_external))
        .route("/api/bd/command", post(routes::cli::bd_command))
        .route("/api/git/branch-status", get(routes::git::branch_status))
        // Worktree endpoints
        .route("/api/git/worktree-status", get(routes::worktree::worktree_status))
        .route("/api/git/worktree", post(routes::worktree::create_worktree))
        .route("/api/git/worktree", delete(routes::worktree::delete_worktree))
        .route("/api/git/worktrees", get(routes::worktree::list_worktrees))
        // PR endpoints
        .route("/api/git/pr-status", get(routes::worktree::pr_status))
        .route("/api/git/pr-files", get(routes::worktree::pr_files))
        .route("/api/git/create-pr", post(routes::worktree::create_pr))
        .route("/api/git/merge-pr", post(routes::worktree::merge_pr))
        .route("/api/git/rebase-siblings", post(routes::worktree::rebase_siblings))
        // Session endpoints
        .route("/api/session/spawn", post(routes::session::spawn_session))
        // Agent endpoints
        .route("/api/agents", get(routes::agents::list_agents))
        .route("/api/agents/:filename", put(routes::agents::update_agent))
        // Memory endpoints
        .route(
            "/api/memory",
            get(routes::memory::list_memory)
                .post(routes::memory::create_memory)
                .put(routes::memory::update_memory)
                .delete(routes::memory::delete_memory),
        )
        .route("/api/memory/stats", get(routes::memory::memory_stats))
        .route("/api/memory/entry", get(routes::memory::get_memory))
        .route("/api/watch/beads", get(routes::watch_beads))
        .route("/api/version/check", get(routes::version::version_check))
        .route("/api/update", post(routes::version::perform_update))
        .fallback(serve_static)
        .layer(Extension(version_cache))
        .layer(Extension(database))
        .layer(Extension(dolt_manager))
        .layer(cors);

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind to address");

    info!("Server starting on http://localhost:{}", port);

    // Открывается только при интерактивном запуске. Под pm2/службой каждый
    // рестарт иначе плодит новую вкладку поверх уже открытой (bweb-vqt);
    // решение и его причина видны в стартовой сводке выше.
    if resolved.open_browser.0 {
        if let Err(e) = open::that(format!("http://localhost:{}", port)) {
            tracing::warn!("Failed to open browser: {}", e);
        }
    }

    // Start the server
    axum::serve(listener, app)
        .await
        .expect("Server failed to start");
}
