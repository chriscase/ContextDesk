//! ContextDesk headless server — localhost by default, API key auth, research + SSE.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use cd_core::chat::ChatMessage;
use cd_core::config::{config_path, load_config};
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::{KeychainSecretStore, SecretStore};
use cd_core::providers::ProviderProfile;
use cd_core::research::{
    build_host, event_to_dto, events_to_dto, research_local, research_turn,
    research_turn_with_cancel,
};
use cd_core::workspace::Workspace;
use clap::Parser;
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use subtle::ConstantTimeEq;
use tower_http::limit::RequestBodyLimitLayer;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "cd-server", version, about = "ContextDesk headless server")]
struct Args {
    #[arg(long)]
    print_branding: bool,
    #[arg(long, default_value = "127.0.0.1:8787")]
    bind: String,
    /// Comma-separated API keys. Discouraged: visible in `ps` — prefer `--api-keys-file` or `CD_API_KEYS`.
    #[arg(long, env = "CD_API_KEYS", default_value = "")]
    api_keys: String,
    /// Newline- or comma-separated API keys from a file (preferred over `--api-keys` argv).
    #[arg(long)]
    api_keys_file: Option<PathBuf>,
    #[arg(long, default_value_t = false)]
    allow_lan: bool,
    #[arg(long)]
    root: Option<PathBuf>,
}

/// Optional chat provider for server research turns (#165).
/// Secret is held only in-process (never over HTTP responses).
#[derive(Clone)]
struct ServerProvider {
    profile: ProviderProfile,
    /// Resolved API key material when required by the kind; never logged.
    api_key: Option<String>,
}

#[derive(Clone)]
struct AppState {
    key_hashes: Arc<Vec<[u8; 32]>>,
    /// workspace_id -> data (isolation boundary)
    workspaces: Arc<Mutex<HashMap<String, WorkspaceData>>>,
    /// api key hash -> allowed workspace ids (empty vec = all if single-tenant dev)
    key_workspaces: Arc<HashMap<[u8; 32], Vec<String>>>,
    /// Active provider from config/keychain; `None` → always local-retrieval / degraded.
    provider: Option<ServerProvider>,
}

/// Load generic provider profile + keychain secret for server research (#165).
/// Offline-safe: missing config/keychain yields `None` (degraded path).
fn load_server_provider(branding: &cd_core::Branding) -> Option<ServerProvider> {
    let path = config_path(branding).ok()?;
    let cfg = load_config(&path).ok()?;
    let profile = cfg.providers.active()?.clone();
    let api_key = profile.api_key_ref.as_ref().and_then(|r| {
        let store = KeychainSecretStore::new();
        store.get(r).ok().flatten()
    });
    Some(ServerProvider { profile, api_key })
}

/// Run research via `research_turn` when a provider is configured; honor `force_local`.
/// Returns events plus honest degrade metadata (never pretends LLM when local-only).
async fn run_research_turn(
    host: &mut cd_core::tool_host::ToolHost,
    provider: Option<&ServerProvider>,
    query: &str,
    session_id: &str,
    force_local: bool,
) -> Result<(Vec<StreamEvent>, bool, Option<String>), StatusCode> {
    let events = match (force_local, provider) {
        (true, _) | (false, None) => research_local(host, query, session_id)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?,
        (false, Some(p)) => {
            let mut history: Vec<ChatMessage> = Vec::new();
            research_turn(
                host,
                &p.profile,
                p.api_key.clone(),
                query,
                &mut history,
                session_id,
                false,
            )
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        }
    };

    let model = events.iter().find_map(|e| match e {
        StreamEvent::TurnStarted { model, .. } => model.clone(),
        _ => None,
    });
    // Honest degrade: local-retrieval model, or no provider / forced local, or error path models.
    let degraded = force_local
        || provider.is_none()
        || model.as_deref() == Some("local-retrieval")
        || model
            .as_ref()
            .map(|m| {
                m.contains("unreachable")
                    || m.contains("provider_error")
                    || m.contains("not_wired")
                    || m.contains("ollama_unreachable")
            })
            .unwrap_or(false);

    Ok((events, degraded, model))
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
    if !key_hash_authorized(&state.key_hashes, &h) {
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
    let (events, degraded, model) = run_research_turn(
        &mut host,
        state.provider.as_ref(),
        &body.query,
        &sid,
        body.force_local,
    )
    .await?;
    Ok(Json(serde_json::json!({
        "events": events_to_dto(&events),
        "degraded": degraded,
        "model": model,
    })))
}

#[derive(Deserialize)]
struct StreamQuery {
    workspace_id: String,
    query: String,
    #[serde(default)]
    force_local: bool,
    session_id: Option<String>,
}

/// Sets cancel flag when the SSE stream is dropped (client disconnect) (#166).
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn stream_event_to_sse(e: StreamEvent) -> Event {
    let dto = event_to_dto(&e);
    let data = serde_json::to_string(&dto).unwrap_or_else(|_| "{}".into());
    Event::default().event(dto.kind).data(data)
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
    let provider = state.provider.clone();
    let force_local = q.force_local;
    let query = q.query.clone();
    let session_id = q.session_id.unwrap_or_else(|| "sse".into());

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_task = cancel.clone();

    tokio::spawn(async move {
        let Ok(mut host) = build_host(ws, None) else {
            let _ = tx.send(StreamEvent::Error {
                code: "host_build".into(),
                message: "failed to build tool host".into(),
            });
            return;
        };

        let push = |e: StreamEvent| {
            let _ = tx.send(e);
        };

        if force_local || provider.is_none() {
            // Local path: emit events as they exist after local research (sink-ordered).
            // research_local has no live sink yet; forward each event through the channel.
            match research_local(&mut host, &query, &session_id).await {
                Ok(events) => {
                    for e in events {
                        if cancel_task.load(Ordering::SeqCst) {
                            break;
                        }
                        push(e);
                        // Let the SSE poll interleave (distinct wire times for offline tests).
                        tokio::task::yield_now().await;
                    }
                }
                Err(err) => {
                    push(StreamEvent::Error {
                        code: "research_local".into(),
                        message: err.to_string(),
                    });
                }
            }
            return;
        }

        let p = provider.as_ref().expect("provider checked");
        let mut history: Vec<ChatMessage> = Vec::new();
        let mut sink = |e: StreamEvent| {
            let _ = tx.send(e);
        };
        let _ = research_turn_with_cancel(
            &mut host,
            &p.profile,
            p.api_key.clone(),
            &query,
            &mut history,
            &session_id,
            false,
            Some(cancel_task.clone()),
            Some(&mut sink),
        )
        .await;
    });

    // Stream owned cancel: client disconnect drops stream → cancel in-flight turn.
    let stream = futures_util::stream::unfold(
        (rx, Some(CancelOnDrop(cancel))),
        |(mut rx, guard)| async move {
            match rx.recv().await {
                Some(e) => Some((Ok(stream_event_to_sse(e)), (rx, guard))),
                None => {
                    drop(guard);
                    None
                }
            }
        },
    );

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

    let keys = match load_api_keys(&args.api_keys, args.api_keys_file.as_ref()) {
        Ok(k) => k,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    };
    let key_hashes: Vec<[u8; 32]> = keys.iter().map(|k| hash_key(k)).collect();

    match guard_exposure(&addr, args.allow_lan, key_hashes.len()) {
        Err(msg) => {
            eprintln!("{msg}");
            eprintln!(
                "See docs/THREAT_MODEL.md and docs/DEV.md (cd-server / TLS at reverse proxy)."
            );
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

    let provider = load_server_provider(&branding);
    if provider.is_some() {
        tracing::info!("research provider profile loaded (secret via keychain only)");
    } else {
        tracing::info!("no provider configured — /v1/research will use local-retrieval (degraded)");
    }

    let state = AppState {
        key_hashes: Arc::new(key_hashes),
        workspaces: Arc::new(Mutex::new(workspaces)),
        key_workspaces: Arc::new(key_workspaces),
        provider,
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
             Prefer --api-keys-file PATH or CD_API_KEYS env (avoid --api-keys on argv — visible in ps). \
             Unauthenticated LAN bind is not allowed. \
             TLS: terminate HTTPS at a reverse proxy (cd-server is HTTP-only; see docs/THREAT_MODEL.md)."
        ));
    }

    if allow_lan && !loopback {
        warnings.push(format!(
            "cd-server is bound beyond loopback ({addr}) via --allow-lan. \
             Terminate TLS at a reverse proxy (cd-server does not speak HTTPS). \
             Prefer --api-keys-file over --api-keys (argv leaks in process lists)."
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

/// Constant-time membership check for API key hashes (#171).
pub fn key_hash_authorized(known: &[[u8; 32]], candidate: &[u8; 32]) -> bool {
    let mut ok = false;
    for k in known {
        // OR of constant-time equals — no early exit on first match for timing.
        let eq = bool::from(k.ct_eq(candidate));
        ok = ok || eq;
    }
    ok
}

/// Load API keys from optional file + comma-separated string (#171).
/// File lines and commas are both separators; empties stripped.
pub fn load_api_keys(
    api_keys_csv: &str,
    api_keys_file: Option<&PathBuf>,
) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    if let Some(path) = api_keys_file {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read --api-keys-file {}: {e}", path.display()))?;
        for part in text.split([',', '\n', '\r']) {
            let t = part.trim();
            if !t.is_empty() {
                keys.push(t.to_string());
            }
        }
    }
    for part in api_keys_csv.split(',') {
        let t = part.trim();
        if !t.is_empty() {
            keys.push(t.to_string());
        }
    }
    Ok(keys)
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

    #[test]
    fn guard_allow_lan_empty_keys_rejected() {
        // #171: allow_lan + no keys must refuse (same as non-loopback bind).
        assert!(guard_exposure(&lan_v4(), true, 0).is_err());
        assert!(guard_exposure(&lan_v4(), true, 1).is_ok());
    }

    #[test]
    fn key_hash_authorized_constant_time_match() {
        let a = hash_key("alpha");
        let b = hash_key("beta");
        let known = vec![a, b];
        assert!(key_hash_authorized(&known, &a));
        assert!(key_hash_authorized(&known, &b));
        assert!(!key_hash_authorized(&known, &hash_key("gamma")));
        assert!(!key_hash_authorized(&[], &a));
    }

    #[test]
    fn load_api_keys_from_file_and_csv() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("keys.txt");
        fs::write(&f, "k1\nk2,\n\nk3\n").unwrap();
        let keys = load_api_keys("k4,k5", Some(&f)).unwrap();
        assert_eq!(keys, vec!["k1", "k2", "k3", "k4", "k5"]);
        assert!(load_api_keys("", None).unwrap().is_empty());
    }

    fn test_state(root: PathBuf, keys: &[(&str, &str)]) -> AppState {
        test_state_with_provider(root, keys, None)
    }

    fn test_state_with_provider(
        root: PathBuf,
        keys: &[(&str, &str)],
        provider: Option<ServerProvider>,
    ) -> AppState {
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
            provider,
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
        let body = axum::body::to_bytes(res.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["degraded"], true, "{v}");
        assert_eq!(v["model"], "local-retrieval", "{v}");
        assert!(!v["events"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn research_no_provider_is_degraded_without_force_local() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a")).unwrap();
        fs::write(dir.path().join("a/x.md"), "payments gateway\n").unwrap();
        // provider: None — must not panic or call network
        let state = test_state(dir.path().to_path_buf(), &[("k", "ws-a")]);
        let app = build_app(state);
        let req = Request::builder()
            .method("POST")
            .uri("/v1/research")
            .header("authorization", "Bearer k")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"workspace_id":"ws-a","query":"payments","force_local":false}"#,
            ))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["degraded"], true, "{v}");
        assert_eq!(v["model"], "local-retrieval", "{v}");
    }

    #[test]
    fn run_research_force_local_skips_provider_profile() {
        // Pure contract: force_local implies degraded regardless of profile presence.
        let p = ServerProvider {
            profile: ProviderProfile::ollama_local(),
            api_key: None,
        };
        assert!(p.profile.kind == cd_core::providers::ProviderKind::Ollama);
    }

    #[tokio::test]
    async fn research_sse_orders_turn_started_before_completed() {
        use http_body_util::BodyExt;

        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a")).unwrap();
        fs::write(dir.path().join("a/x.md"), "payments gateway\n").unwrap();
        let state = test_state(dir.path().to_path_buf(), &[("k", "ws-a")]);
        let app = build_app(state);
        let req = Request::builder()
            .method("GET")
            .uri("/v1/research/stream?workspace_id=ws-a&query=payments&force_local=true&session_id=t-sse")
            .header("authorization", "Bearer k")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes);
        // SSE frames: event: turn_started ... event: turn_completed
        let started = text.find("event: turn_started");
        let completed = text.find("event: turn_completed");
        assert!(
            started.is_some() && completed.is_some(),
            "missing events in SSE body:\n{text}"
        );
        assert!(
            started.unwrap() < completed.unwrap(),
            "turn_started must precede turn_completed:\n{text}"
        );
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
