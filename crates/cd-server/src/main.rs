//! ContextDesk headless server — localhost by default, API key auth.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use cd_core::index::KeywordIndex;
use cd_core::workspace::Workspace;
use clap::Parser;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tower_http::limit::RequestBodyLimitLayer;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "cd-server", version, about = "ContextDesk headless server")]
struct Args {
    /// Print branding and exit.
    #[arg(long)]
    print_branding: bool,

    /// Bind address (default loopback only).
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: String,

    /// API keys (comma-separated). Hashed at rest in memory.
    #[arg(long, env = "CD_API_KEYS", default_value = "")]
    api_keys: String,

    /// Allow non-loopback bind (requires explicit flag).
    #[arg(long, default_value_t = false)]
    allow_lan: bool,

    /// Workspace root to index (optional).
    #[arg(long)]
    root: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    key_hashes: Arc<Vec<[u8; 32]>>,
    workspaces: Arc<Mutex<HashMap<String, WorkspaceData>>>,
}

struct WorkspaceData {
    index: KeywordIndex,
    /// Shared memory notes.
    memory: Vec<MemoryNote>,
}

#[derive(Clone, Serialize, Deserialize)]
struct MemoryNote {
    id: String,
    title: String,
    body: String,
}

fn hash_key(k: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(k.as_bytes());
    h.finalize().into()
}

fn authorize(headers: &HeaderMap, state: &AppState) -> Result<(), StatusCode> {
    if state.key_hashes.is_empty() {
        // Dev mode: no keys configured → allow localhost only is caller's duty
        return Ok(());
    }
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .unwrap_or(auth)
        .trim();
    if token.is_empty() {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let h = hash_key(token);
    if state.key_hashes.iter().any(|k| k == &h) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "product": cd_core::DEFAULT_PRODUCT_NAME,
        "version": cd_core::VERSION,
        "protocol": cd_core::PROTOCOL_VERSION,
    }))
}

async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SearchBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state)?;
    let ws_id = body.workspace_id.as_str();
    let map = state
        .workspaces
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let data = map.get(ws_id).ok_or(StatusCode::NOT_FOUND)?;
    let hits = data
        .index
        .search(&body.query, body.limit.unwrap_or(8).min(50));
    let out: Vec<_> = hits
        .iter()
        .map(|(score, c)| {
            serde_json::json!({
                "score": score,
                "path": c.path,
                "start_line": c.start_line,
                "end_line": c.end_line,
                "excerpt": c.text.chars().take(240).collect::<String>(),
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "hits": out })))
}

#[derive(Deserialize)]
struct SearchBody {
    workspace_id: String,
    query: String,
    limit: Option<usize>,
}

async fn publish_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PublishBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state)?;
    let mut map = state
        .workspaces
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let data = map
        .get_mut(&body.workspace_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let id = uuid::Uuid::new_v4().to_string();
    data.memory.push(MemoryNote {
        id: id.clone(),
        title: body.title,
        body: body.body,
    });
    Ok(Json(serde_json::json!({ "id": id })))
}

#[derive(Deserialize)]
struct PublishBody {
    workspace_id: String,
    title: String,
    body: String,
}

async fn list_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WsBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state)?;
    let map = state
        .workspaces
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let data = map.get(&body.workspace_id).ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(serde_json::json!({ "notes": data.memory })))
}

#[derive(Deserialize)]
struct WsBody {
    workspace_id: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let args = Args::parse();
    let branding = cd_core::Branding::default();

    if args.print_branding {
        println!(
            "{} ({}) — {}",
            branding.name, branding.slug, branding.tagline
        );
        return;
    }

    let addr: SocketAddr = args.bind.parse().expect("invalid --bind address");
    if !addr.ip().is_loopback() && !args.allow_lan {
        eprintln!(
            "Refusing non-loopback bind {}. Pass --allow-lan (and use TLS at reverse proxy).",
            addr
        );
        std::process::exit(2);
    }

    let key_hashes: Vec<[u8; 32]> = args
        .api_keys
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(hash_key)
        .collect();

    let mut workspaces = HashMap::new();
    if let Some(root) = args.root {
        let ws = Workspace::new("default", vec![root]);
        let index = KeywordIndex::build(&ws).unwrap_or_default();
        workspaces.insert(
            "default".into(),
            WorkspaceData {
                index,
                memory: vec![],
            },
        );
    }

    let state = AppState {
        key_hashes: Arc::new(key_hashes),
        workspaces: Arc::new(Mutex::new(workspaces)),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/search", post(search))
        .route("/v1/memory/publish", post(publish_memory))
        .route("/v1/memory/list", post(list_memory))
        .layer(RequestBodyLimitLayer::new(1024 * 1024))
        .with_state(state);

    tracing::info!(%addr, "cd-server listening");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}
