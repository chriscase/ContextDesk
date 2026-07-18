//! ContextDesk headless server — localhost by default, API key auth, research + SSE.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use cd_core::index::KeywordIndex;
use cd_core::research::{build_host, events_to_dto, research_local};
use cd_core::workspace::Workspace;
use clap::Parser;
use futures_util::stream::{self, Stream};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tower_http::limit::RequestBodyLimitLayer;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "cd-server", version, about = "ContextDesk headless server")]
struct Args {
    #[arg(long)]
    print_branding: bool,
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: String,
    #[arg(long, env = "CD_API_KEYS", default_value = "")]
    api_keys: String,
    #[arg(long, default_value_t = false)]
    allow_lan: bool,
    #[arg(long)]
    root: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    key_hashes: Arc<Vec<[u8; 32]>>,
    /// workspace_id -> data (isolation boundary)
    workspaces: Arc<Mutex<HashMap<String, WorkspaceData>>>,
    /// api key hash -> allowed workspace ids (empty vec = all if single-tenant dev)
    key_workspaces: Arc<HashMap<[u8; 32], Vec<String>>>,
}

struct WorkspaceData {
    workspace: Workspace,
    index: KeywordIndex,
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

fn authorize(headers: &HeaderMap, state: &AppState, workspace_id: &str) -> Result<(), StatusCode> {
    // Empty keys: intentional for **loopback-only** single-user dev (#144).
    // Startup `guard_exposure` refuses non-loopback + no-key before bind.
    if state.key_hashes.is_empty() {
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
    if !state.key_hashes.iter().any(|k| k == &h) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if let Some(allowed) = state.key_workspaces.get(&h) {
        if !allowed.is_empty() && !allowed.iter().any(|w| w == workspace_id) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(())
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "product": cd_core::DEFAULT_PRODUCT_NAME,
        "version": cd_core::VERSION,
        "protocol": cd_core::PROTOCOL_VERSION,
    }))
}

#[derive(Deserialize)]
struct SearchBody {
    workspace_id: String,
    query: String,
    limit: Option<usize>,
}

async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SearchBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
    let map = state
        .workspaces
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let data = map.get(&body.workspace_id).ok_or(StatusCode::NOT_FOUND)?;
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
struct PublishBody {
    workspace_id: String,
    title: String,
    body: String,
}

async fn publish_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PublishBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
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
struct WsBody {
    workspace_id: String,
}

async fn list_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<WsBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
    let map = state
        .workspaces
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let data = map.get(&body.workspace_id).ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(serde_json::json!({ "notes": data.memory })))
}

#[derive(Deserialize)]
struct ResearchBody {
    workspace_id: String,
    query: String,
    session_id: Option<String>,
    #[serde(default)]
    force_local: bool,
}

async fn research(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ResearchBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
    let ws = {
        let map = state
            .workspaces
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let data = map.get(&body.workspace_id).ok_or(StatusCode::NOT_FOUND)?;
        data.workspace.clone()
    };
    let mut host = build_host(ws, None).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let sid = body.session_id.unwrap_or_else(|| "server".into());
    let _ = body.force_local;
    let events = research_local(&mut host, &body.query, &sid)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({
        "events": events_to_dto(&events),
    })))
}

#[derive(Deserialize)]
struct StreamQuery {
    workspace_id: String,
    query: String,
}

async fn research_sse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<StreamQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    authorize(&headers, &state, &q.workspace_id)?;
    let ws = {
        let map = state
            .workspaces
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let data = map.get(&q.workspace_id).ok_or(StatusCode::NOT_FOUND)?;
        data.workspace.clone()
    };
    let mut host = build_host(ws, None).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let events = research_local(&mut host, &q.query, "sse")
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let dtos = events_to_dto(&events);
    let stream = stream::iter(dtos.into_iter().map(|dto| {
        let data = serde_json::to_string(&dto).unwrap_or_else(|_| "{}".into());
        Ok(Event::default().event(dto.kind).data(data))
    }));
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/search", post(search))
        .route("/v1/memory/publish", post(publish_memory))
        .route("/v1/memory/list", post(list_memory))
        .route("/v1/research", post(research))
        .route("/v1/research/stream", get(research_sse))
        .layer(RequestBodyLimitLayer::new(1024 * 1024))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    let args = Args::parse();
    let branding = cd_core::Branding::embedded();

    if args.print_branding {
        println!(
            "{} ({}) — {}",
            branding.name, branding.slug, branding.tagline
        );
        return;
    }

    let addr: SocketAddr = args.bind.parse().expect("invalid --bind address");

    let keys: Vec<String> = args
        .api_keys
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let key_hashes: Vec<[u8; 32]> = keys.iter().map(|k| hash_key(k)).collect();

    match guard_exposure(&addr, args.allow_lan, key_hashes.len()) {
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
        Ok(warnings) => {
            for w in warnings {
                eprintln!("WARNING: {w}");
                tracing::warn!("{w}");
            }
        }
    }

    let mut workspaces = HashMap::new();
    if let Some(root) = args.root {
        let ws = Workspace::new("default", vec![root]);
        let index = KeywordIndex::build(&ws).unwrap_or_default();
        workspaces.insert(
            "default".into(),
            WorkspaceData {
                workspace: ws,
                index,
                memory: vec![],
            },
        );
    }

    // Map each key to default workspace only when keys present
    let mut key_workspaces = HashMap::new();
    for h in &key_hashes {
        key_workspaces.insert(*h, vec!["default".into()]);
    }

    let state = AppState {
        key_hashes: Arc::new(key_hashes),
        workspaces: Arc::new(Mutex::new(workspaces)),
        key_workspaces: Arc::new(key_workspaces),
    };

    let app = build_app(state);
    tracing::info!(%addr, "cd-server listening");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

/// Pure bind/auth exposure policy (#144). Offline-testable; does not bind sockets.
///
/// Returns `Ok(warnings)` to print, or `Err(message)` to refuse startup.
pub fn guard_exposure(
    addr: &SocketAddr,
    allow_lan: bool,
    key_count: usize,
) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    let loopback = addr.ip().is_loopback();

    if !loopback && !allow_lan {
        return Err(format!(
            "Refusing non-loopback bind {addr}. Pass --allow-lan (and use TLS at a reverse proxy)."
        ));
    }

    if !loopback && key_count == 0 {
        return Err(format!(
            "Refusing non-loopback bind {addr} with no API keys. \
             Set --api-keys / CD_API_KEYS (comma-separated) before --allow-lan exposure. \
             Unauthenticated LAN bind is not allowed."
        ));
    }

    if allow_lan && !loopback {
        warnings.push(format!(
            "cd-server is bound beyond loopback ({addr}) via --allow-lan. \
             Expect TLS at a reverse proxy and rotate API keys; traffic is not encrypted by cd-server itself."
        ));
    }

    if loopback && key_count == 0 {
        tracing::info!(
            %addr,
            "API auth disabled (no --api-keys); bind is loopback-only"
        );
    }

    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::fs;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use tempfile::tempdir;
    use tower::ServiceExt;

    fn loopback_v4() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 8787)
    }
    fn lan_v4() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0)), 8787)
    }
    fn lan_public() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)), 8787)
    }

    #[test]
    fn guard_loopback_no_key_ok() {
        let r = guard_exposure(&loopback_v4(), false, 0);
        assert!(r.is_ok(), "{r:?}");
        assert!(r.unwrap().is_empty());
    }

    #[test]
    fn guard_lan_no_key_err() {
        let r = guard_exposure(&lan_v4(), true, 0);
        assert!(r.is_err());
        let msg = r.unwrap_err();
        assert!(
            msg.contains("no API keys") || msg.contains("API key"),
            "{msg}"
        );
        assert!(!msg.contains("sk-"));
    }

    #[test]
    fn guard_lan_without_flag_err() {
        let r = guard_exposure(&lan_public(), false, 1);
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("allow-lan"));
    }

    #[test]
    fn guard_lan_with_key_warns() {
        let r = guard_exposure(&lan_v4(), true, 1).unwrap();
        assert!(
            r.iter()
                .any(|w| w.contains("allow-lan") || w.contains("beyond loopback")),
            "{r:?}"
        );
    }

    #[test]
    fn guard_loopback_with_key_ok() {
        let r = guard_exposure(&loopback_v4(), false, 2).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn guard_v6_loopback_no_key_ok() {
        let a = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 8787);
        assert!(guard_exposure(&a, false, 0).is_ok());
    }

    fn test_state(root: PathBuf, keys: &[(&str, &str)]) -> AppState {
        // keys: (api_key, workspace_id)
        let ws_a = Workspace::new("a", vec![root.join("a")]);
        let ws_b = Workspace::new("b", vec![root.join("b")]);
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/secret-a.md"), "alpha only data\n").unwrap();
        fs::write(root.join("b/secret-b.md"), "beta only data\n").unwrap();
        let mut workspaces = HashMap::new();
        workspaces.insert(
            "ws-a".into(),
            WorkspaceData {
                index: KeywordIndex::build(&ws_a).unwrap(),
                workspace: ws_a,
                memory: vec![],
            },
        );
        workspaces.insert(
            "ws-b".into(),
            WorkspaceData {
                index: KeywordIndex::build(&ws_b).unwrap(),
                workspace: ws_b,
                memory: vec![],
            },
        );
        let mut key_hashes = Vec::new();
        let mut key_workspaces = HashMap::new();
        for (key, ws) in keys {
            let h = hash_key(key);
            key_hashes.push(h);
            key_workspaces.insert(h, vec![(*ws).into()]);
        }
        AppState {
            key_hashes: Arc::new(key_hashes),
            workspaces: Arc::new(Mutex::new(workspaces)),
            key_workspaces: Arc::new(key_workspaces),
        }
    }

    #[tokio::test]
    async fn isolation_key_a_cannot_search_b() {
        let dir = tempdir().unwrap();
        let state = test_state(
            dir.path().to_path_buf(),
            &[("key-a", "ws-a"), ("key-b", "ws-b")],
        );
        let app = build_app(state);

        // key-a searching ws-b -> 403
        let req = Request::builder()
            .method("POST")
            .uri("/v1/search")
            .header("authorization", "Bearer key-a")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"workspace_id":"ws-b","query":"beta"}"#))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // key-a searching ws-a -> 200
        let req = Request::builder()
            .method("POST")
            .uri("/v1/search")
            .header("authorization", "Bearer key-a")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"workspace_id":"ws-a","query":"alpha"}"#))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn research_returns_events() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a")).unwrap();
        fs::write(dir.path().join("a/x.md"), "payments gateway\n").unwrap();
        let state = test_state(dir.path().to_path_buf(), &[("k", "ws-a")]);
        // fix workspace root content already set
        let app = build_app(state);
        let req = Request::builder()
            .method("POST")
            .uri("/v1/research")
            .header("authorization", "Bearer k")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"workspace_id":"ws-a","query":"payments","force_local":true}"#,
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn health_ok() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path().to_path_buf(), &[]);
        let app = build_app(state);
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
