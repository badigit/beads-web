//! Opt-in browser acceptance with an in-memory project registry and a disposable Dolt database.

use super::*;
use std::future::IntoFuture;

#[tokio::test]
#[ignore = "requires a disposable BEADS_WEB_TEST_DATABASE and an explicit BEADS_WEB_PREVIEW_PORT"]
async fn preview_isolated_board() {
    let name = std::env::var("BEADS_WEB_TEST_DATABASE").expect("explicit test database");
    assert!(name.starts_with("bweb_tsw_verify_"));
    let port: u16 = std::env::var("BEADS_WEB_PREVIEW_PORT").expect("explicit preview port")
        .parse().expect("numeric port");
    assert_ne!(port, 3056);
    let database = Arc::new(db::Database::new_in_memory().unwrap());
    let project = database.create_project(db::CreateProjectInput {
        name: "bd pipeline acceptance".to_string(), path: format!("dolt://{name}"), local_path: None,
    }).unwrap();
    let dolt = Arc::new(dolt::DoltManager::new());
    assert!(dolt.check_server().await);
    let app = Router::new()
        .nest("/api", routes::project_routes().with_state(database.clone()))
        .route("/api/health", get(routes::health))
        .route("/api/beads", get(routes::beads::read_beads))
        .route("/api/beads/counts", get(routes::beads::read_bead_counts))
        .route("/api/beads/labels", get(routes::beads::read_bead_labels))
        .route("/api/beads/create", post(routes::beads::create_bead_handler))
        .route("/api/beads/update", patch(routes::beads::update_bead_handler))
        .route("/api/dolt/watch", get(routes::dolt_watch::watch_dolt))
        .route("/api/version/check", get(routes::version::version_check))
        .layer(Extension(routes::version::new_cache()))
        .layer(Extension(routes::dolt_watch::new_registry()))
        .layer(Extension(database))
        .layer(Extension(dolt))
        .fallback(serve_static);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    println!("PREVIEW http://127.0.0.1:{port}/project?id={}", project.id);
    let _ = tokio::time::timeout(Duration::from_secs(180), axum::serve(listener, app).into_future()).await;
}
