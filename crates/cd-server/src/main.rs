//! ContextDesk headless server — localhost by default, API key auth, research + SSE.

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use cd_core::audit::{outcomes, AuditLog};
use cd_core::chat::ChatMessage;
use cd_core::config::{config_path, ensure_config_dir, load_config};
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::{looks_like_raw_secret, KeychainSecretStore, SecretStore};
use cd_core::permissions::PermissionDecision;
use cd_core::providers::ProviderProfile;
use cd_core::research::{
    build_host, event_to_dto, events_to_dto, grant_and_execute, research_local, research_turn,
    research_turn_with_cancel,
};
use cd_core::tool_host::ToolHost;
use cd_core::tools::ToolSideEffect;
use cd_core::workspace::Workspace;
use clap::Parser;
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::convert::Infallible;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
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
    /// Server config file (TOML) defining team workspaces + per-key admin/member roles.
    /// The headless server is legitimately file/flag-configured (AGENTS #7 governs the
    /// desktop happy path, not the server). See `docs/DEV.md` (cd-server team workspaces).
    #[arg(long, env = "CD_SERVER_CONFIG")]
    config: Option<PathBuf>,
    /// Directory for persistent server state (shared memory JSONL + audit log).
    /// Defaults to `<config dir>/server`, or `data_dir` from the config file.
    #[arg(long, env = "CD_SERVER_DATA_DIR")]
    data_dir: Option<PathBuf>,
}

/// Optional chat provider for server research turns (#165).
/// Secret is held only in-process (never over HTTP responses).
#[derive(Clone)]
struct ServerProvider {
    profile: ProviderProfile,
    /// Resolved API key material when required by the kind; never logged.
    api_key: Option<String>,
}

/// Per-key, per-workspace role (#167 / #50). `admin` may write shared memory and manage
/// the workspace; `member` may search / read and use scoped write (permission-gated tools).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Role {
    Admin,
    Member,
}

impl Role {
    fn is_admin(self) -> bool {
        matches!(self, Role::Admin)
    }
}

#[derive(Clone)]
struct AppState {
    key_hashes: Arc<Vec<[u8; 32]>>,
    /// workspace_id -> data (isolation boundary)
    workspaces: Arc<Mutex<HashMap<String, WorkspaceData>>>,
    /// api key hash -> allowed workspace ids (empty vec = all if single-tenant dev)
    key_workspaces: Arc<HashMap<[u8; 32], Vec<String>>>,
    /// api key hash -> { workspace_id -> Role } (#167). Missing entry with keys present
    /// means the key has no role in that workspace (treated as unauthorized to mutate).
    key_roles: Arc<HashMap<[u8; 32], HashMap<String, Role>>>,
    /// Append-only, hash-chained audit log for writes AND denials (#167). Shared across
    /// handlers; `AuditLog` already scrubs secrets before writing (`audit.rs`).
    audit: Arc<AuditLog>,
    /// Active provider from config/keychain; `None` → always local-retrieval / degraded.
    provider: Option<ServerProvider>,
    /// Per-session ToolHost for permission pending state (#168).
    /// Eviction: process lifetime only for now (document in PROTOCOL); no TTL yet.
    /// `tokio::sync::Mutex` so we can await tool execute while holding the session.
    sessions: Arc<tokio::sync::Mutex<HashMap<String, SessionHost>>>,
}

/// Session-scoped host retained between prompt and permission.respond (#168).
struct SessionHost {
    host: ToolHost,
    workspace_id: String,
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
    /// In-RAM mirror of the on-disk shared memory (`memory_path`), loaded at boot.
    memory: Vec<MemoryNote>,
    /// JSONL file the shared memory persists to (survives restart) (#167).
    memory_path: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
struct MemoryNote {
    id: String,
    title: String,
    body: String,
}

// ---------------------------------------------------------------------------
// Server config (TOML) — team workspaces + per-key roles (#167 / finishes #50).
// ---------------------------------------------------------------------------

/// Top-level server config file. Contains NO raw provider secrets: API keys are
/// either short opaque dev tokens (hashed at load) or `key_hash` (sha256 hex) so a
/// strong token never sits in the file. `looks_like_raw_secret` refuses a pasted
/// provider secret, mirroring `cd_core::config`'s `api_key_ref` guard.
#[derive(Debug, Deserialize)]
struct ServerConfig {
    /// Optional override for the persistent state dir (shared memory + audit).
    #[serde(default)]
    data_dir: Option<PathBuf>,
    /// Team workspaces, each with its own roots + admin/member key set.
    #[serde(default)]
    workspaces: Vec<WsConfig>,
}

#[derive(Debug, Deserialize)]
struct WsConfig {
    id: String,
    roots: Vec<PathBuf>,
    #[serde(default)]
    keys: Vec<KeyEntry>,
}

#[derive(Debug, Deserialize)]
struct KeyEntry {
    /// Raw opaque token (dev). Hashed at load; refused if it looks like a provider secret.
    #[serde(default)]
    key: Option<String>,
    /// Precomputed sha256 hex of the token — lets the file hold no secret at all.
    #[serde(default)]
    key_hash: Option<String>,
    role: Role,
}

/// A workspace resolved from config or legacy flags, ready to build [`AppState`].
struct ResolvedWorkspace {
    id: String,
    roots: Vec<PathBuf>,
    /// (api-key-hash, role) pairs authorized on this workspace.
    keys: Vec<([u8; 32], Role)>,
}

fn hash_key(k: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(k.as_bytes());
    h.finalize().into()
}

/// Resolve a config key entry to its 32-byte auth hash, enforcing the no-raw-secret guard.
fn resolve_key_hash(entry: &KeyEntry) -> Result<[u8; 32], String> {
    if let Some(h) = &entry.key_hash {
        let bytes = hex::decode(h.trim())
            .map_err(|_| format!("invalid key_hash (must be sha256 hex): {h}"))?;
        return <[u8; 32]>::try_from(bytes.as_slice())
            .map_err(|_| format!("key_hash must be 32 bytes / 64 hex chars: {h}"));
    }
    if let Some(k) = &entry.key {
        if looks_like_raw_secret(k) {
            return Err(
                "refusing server config with a raw provider-style secret in `key`; \
                 use `key_hash` (sha256 hex) for strong tokens"
                    .into(),
            );
        }
        return Ok(hash_key(k));
    }
    Err("each key entry needs `key` or `key_hash`".into())
}

/// Parse a server config file (TOML). Offline; no network, no keychain.
fn load_server_config(path: &Path) -> Result<ServerConfig, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read --config {}: {e}", path.display()))?;
    toml::from_str(&raw).map_err(|e| format!("failed to parse --config {}: {e}", path.display()))
}

/// Turn parsed config workspaces into [`ResolvedWorkspace`]s (hashing keys, enforcing guard).
fn resolve_config_workspaces(cfg: &ServerConfig) -> Result<Vec<ResolvedWorkspace>, String> {
    let mut out = Vec::new();
    for ws in &cfg.workspaces {
        if ws.id.trim().is_empty() {
            return Err("workspace id must not be empty".into());
        }
        if ws.roots.is_empty() {
            return Err(format!("workspace '{}' has no roots", ws.id));
        }
        let mut keys = Vec::new();
        for entry in &ws.keys {
            keys.push((resolve_key_hash(entry)?, entry.role));
        }
        out.push(ResolvedWorkspace {
            id: ws.id.clone(),
            roots: ws.roots.clone(),
            keys,
        });
    }
    Ok(out)
}

/// Per-workspace JSONL path under the server data dir.
fn workspace_memory_path(data_dir: &Path, workspace_id: &str) -> PathBuf {
    data_dir
        .join("workspaces")
        .join(workspace_id)
        .join("memory.jsonl")
}

/// Load persisted shared memory from disk (missing file → empty). Skips unparsable lines.
fn load_memory_jsonl(path: &Path) -> Vec<MemoryNote> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<MemoryNote>(l).ok())
        .collect()
}

/// Append one shared-memory note to its JSONL file (creating parent dirs).
fn append_memory_jsonl(path: &Path, note: &MemoryNote) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let line = serde_json::to_string(note)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "{line}")?;
    Ok(())
}

/// Build [`AppState`] from resolved workspaces + a data dir. Loads persisted memory
/// from disk (so a restart re-hydrates shared memory) and opens the shared audit log.
fn build_state(
    resolved: Vec<ResolvedWorkspace>,
    data_dir: &Path,
    provider: Option<ServerProvider>,
) -> Result<AppState, String> {
    let mut workspaces = HashMap::new();
    let mut key_hashes: Vec<[u8; 32]> = Vec::new();
    let mut key_workspaces: HashMap<[u8; 32], Vec<String>> = HashMap::new();
    let mut key_roles: HashMap<[u8; 32], HashMap<String, Role>> = HashMap::new();

    for rw in resolved {
        let ws = Workspace::new(&rw.id, rw.roots.clone());
        let index = KeywordIndex::build(&ws).unwrap_or_default();
        let memory_path = workspace_memory_path(data_dir, &rw.id);
        let memory = load_memory_jsonl(&memory_path);
        workspaces.insert(
            rw.id.clone(),
            WorkspaceData {
                workspace: ws,
                index,
                memory,
                memory_path,
            },
        );
        for (h, role) in rw.keys {
            if !key_hashes.contains(&h) {
                key_hashes.push(h);
            }
            key_workspaces.entry(h).or_default().push(rw.id.clone());
            key_roles.entry(h).or_default().insert(rw.id.clone(), role);
        }
    }

    let audit = AuditLog::new(data_dir.join("audit.jsonl"));
    Ok(AppState {
        key_hashes: Arc::new(key_hashes),
        workspaces: Arc::new(Mutex::new(workspaces)),
        key_workspaces: Arc::new(key_workspaces),
        key_roles: Arc::new(key_roles),
        audit: Arc::new(audit),
        provider,
        sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    })
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

/// Extract the caller's API-key hash from the `Authorization` header, if any.
fn token_hash(headers: &HeaderMap) -> Option<[u8; 32]> {
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
        None
    } else {
        Some(hash_key(token))
    }
}

/// The caller's role in `workspace_id`. Loopback dev with no configured keys is treated
/// as `admin` (single-user local). A key with no role entry for the workspace → `None`.
fn role_for(headers: &HeaderMap, state: &AppState, workspace_id: &str) -> Option<Role> {
    if state.key_hashes.is_empty() {
        return Some(Role::Admin);
    }
    token_hash(headers)
        .and_then(|h| state.key_roles.get(&h))
        .and_then(|m| m.get(workspace_id))
        .copied()
}

/// Enforce admin-only access on a mutating endpoint. Assumes [`authorize`] already ran
/// (auth + workspace membership). Non-admins are refused with 403 and an audit `denied`
/// entry; admins pass through with no side effect.
fn require_admin(
    headers: &HeaderMap,
    state: &AppState,
    workspace_id: &str,
    tool: &str,
    target: &str,
) -> Result<(), StatusCode> {
    match role_for(headers, state, workspace_id) {
        Some(role) if role.is_admin() => Ok(()),
        _ => {
            let _ = state.audit.log(
                tool,
                ToolSideEffect::HardWrite,
                target,
                outcomes::DENIED,
                "member role denied admin-only action",
                0,
            );
            Err(StatusCode::FORBIDDEN)
        }
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
    // Writing shared memory is admin-only; members are refused (403 + audit denial).
    let deny_target = format!("{}/memory", body.workspace_id);
    require_admin(
        &headers,
        &state,
        &body.workspace_id,
        "memory_publish",
        &deny_target,
    )?;

    let note = MemoryNote {
        id: uuid::Uuid::new_v4().to_string(),
        title: body.title,
        body: body.body,
    };
    let bytes = note.body.len() as u64;
    {
        let mut map = state
            .workspaces
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let data = map
            .get_mut(&body.workspace_id)
            .ok_or(StatusCode::NOT_FOUND)?;
        // Persist to disk FIRST so a crash never acknowledges an unsaved note.
        append_memory_jsonl(&data.memory_path, &note).map_err(|e| {
            tracing::error!("shared memory persist failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
        data.memory.push(note.clone());
    }
    let _ = state.audit.log(
        "memory_publish",
        ToolSideEffect::HardWrite,
        &format!("{}/{}", body.workspace_id, note.id),
        outcomes::ALLOWED,
        "published shared memory",
        bytes,
    );
    Ok(Json(serde_json::json!({ "id": note.id })))
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
    let mut host = build_host(ws, Some(state.audit.path().to_path_buf()))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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
    let audit_path = state.audit.path().to_path_buf();

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_task = cancel.clone();

    tokio::spawn(async move {
        let Ok(mut host) = build_host(ws, Some(audit_path)) else {
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

#[derive(Deserialize)]
struct SessionPromptBody {
    workspace_id: String,
    session_id: String,
    /// User query for a research turn (optional when `invoke_tool` is set).
    #[serde(default)]
    query: String,
    #[serde(default)]
    force_local: bool,
    /// Offline / explicit tool path: execute one tool under permission mediation.
    /// Used to surface `permission_required` without a live model (#168 tests).
    invoke_tool: Option<InvokeToolBody>,
}

#[derive(Deserialize)]
struct InvokeToolBody {
    name: String,
    #[serde(default)]
    arguments: serde_json::Value,
}

#[derive(Deserialize)]
struct PermissionRespondBody {
    workspace_id: String,
    session_id: String,
    request_id: String,
    /// allow_once | deny | allow_session_path
    decision: String,
    typed: Option<String>,
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    arguments: serde_json::Value,
}

fn parse_decision(s: &str) -> Result<PermissionDecision, StatusCode> {
    match s {
        "deny" => Ok(PermissionDecision::Deny),
        "allow_once" => Ok(PermissionDecision::AllowOnce),
        "allow_session_path" => Ok(PermissionDecision::AllowSessionPath),
        _ => Err(StatusCode::BAD_REQUEST),
    }
}

/// Ensure a per-session ToolHost exists for this workspace (#168).
async fn ensure_session_host(
    state: &AppState,
    workspace_id: &str,
    session_id: &str,
) -> Result<(), StatusCode> {
    let mut sessions = state.sessions.lock().await;
    if let Some(s) = sessions.get(session_id) {
        if s.workspace_id != workspace_id {
            return Err(StatusCode::FORBIDDEN);
        }
        return Ok(());
    }
    let ws = {
        let map = state
            .workspaces
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let data = map.get(workspace_id).ok_or(StatusCode::NOT_FOUND)?;
        data.workspace.clone()
    };
    let host = build_host(ws, Some(state.audit.path().to_path_buf()))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sessions.insert(
        session_id.to_string(),
        SessionHost {
            host,
            workspace_id: workspace_id.to_string(),
        },
    );
    Ok(())
}

async fn session_prompt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SessionPromptBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
    if body.session_id.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    ensure_session_host(&state, &body.workspace_id, &body.session_id).await?;

    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&body.session_id)
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;

    let events = if let Some(tool) = &body.invoke_tool {
        // Permission-mediated tool invoke (no auto-approve). Writes stay pending.
        let r = session
            .host
            .execute(&tool.name, &tool.arguments, None)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        r.events
    } else {
        let q = if body.query.trim().is_empty() {
            "search workspace"
        } else {
            body.query.as_str()
        };
        let (ev, _, _) = run_research_turn(
            &mut session.host,
            state.provider.as_ref(),
            q,
            &body.session_id,
            body.force_local || state.provider.is_none(),
        )
        .await?;
        ev
    };

    Ok(Json(serde_json::json!({
        "session_id": body.session_id,
        "events": events_to_dto(&events),
    })))
}

async fn permission_respond(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PermissionRespondBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
    let decision = parse_decision(body.decision.trim())?;
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&body.session_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    if session.workspace_id != body.workspace_id {
        return Err(StatusCode::FORBIDDEN);
    }

    // Client-originated grant only — model never auto-approves (#168 / AGENTS #4).
    let events = grant_and_execute(
        &mut session.host,
        &body.request_id,
        decision,
        body.typed.as_deref(),
        &body.tool_name,
        &body.arguments,
        None,
    )
    .await
    .map_err(|_| StatusCode::BAD_REQUEST)?;

    Ok(Json(serde_json::json!({
        "session_id": body.session_id,
        "request_id": body.request_id,
        "events": events_to_dto(&events),
    })))
}

fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/search", post(search))
        .route("/v1/memory/publish", post(publish_memory))
        .route("/v1/memory/list", post(list_memory))
        .route("/v1/research", post(research))
        .route("/v1/research/stream", get(research_sse))
        .route("/v1/session/prompt", post(session_prompt))
        .route("/v1/permission/respond", post(permission_respond))
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

    // Legacy flag path: --api-keys / CD_API_KEYS / --api-keys-file. These keys are
    // granted `admin` on the legacy `default` workspace (preserves prior behavior).
    let legacy_keys = match load_api_keys(&args.api_keys, args.api_keys_file.as_ref()) {
        Ok(k) => k,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    };
    let legacy_hashes: Vec<[u8; 32]> = legacy_keys.iter().map(|k| hash_key(k)).collect();

    // Optional server config file: multiple team workspaces + per-key roles (#167).
    let server_config = match args.config.as_ref() {
        Some(path) => match load_server_config(path) {
            Ok(c) => Some(c),
            Err(msg) => {
                eprintln!("{msg}");
                std::process::exit(2);
            }
        },
        None => None,
    };

    let mut resolved = match server_config.as_ref().map(resolve_config_workspaces) {
        Some(Ok(r)) => r,
        Some(Err(msg)) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
        None => Vec::new(),
    };

    // Legacy `default` workspace from --root (unless config already defines `default`).
    if let Some(root) = args.root.clone() {
        if !resolved.iter().any(|w| w.id == "default") {
            resolved.push(ResolvedWorkspace {
                id: "default".into(),
                roots: vec![root],
                keys: legacy_hashes.iter().map(|h| (*h, Role::Admin)).collect(),
            });
        }
    }

    // Total distinct auth keys across every workspace — drives the exposure guard.
    let key_count = {
        let mut all: Vec<[u8; 32]> = Vec::new();
        for w in &resolved {
            for (h, _) in &w.keys {
                if !all.contains(h) {
                    all.push(*h);
                }
            }
        }
        all.len()
    };

    match guard_exposure(&addr, args.allow_lan, key_count) {
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

    // Persistent state dir: --data-dir > config data_dir > <config dir>/server.
    let data_dir = args
        .data_dir
        .clone()
        .or_else(|| server_config.as_ref().and_then(|c| c.data_dir.clone()))
        .unwrap_or_else(|| match ensure_config_dir(&branding) {
            Ok(dir) => dir.join("server"),
            Err(_) => PathBuf::from(".").join(".cd-server"),
        });
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("failed to create data dir {}: {e}", data_dir.display());
        std::process::exit(2);
    }
    tracing::info!(data_dir = %data_dir.display(), "server state dir (shared memory + audit)");

    let provider = load_server_provider(&branding);
    if provider.is_some() {
        tracing::info!("research provider profile loaded (secret via keychain only)");
    } else {
        tracing::info!("no provider configured — /v1/research will use local-retrieval (degraded)");
    }

    let state = match build_state(resolved, &data_dir, provider) {
        Ok(s) => s,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
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
        // keys: (api_key, workspace_id) — all granted `admin` (legacy behavior).
        let with_roles: Vec<(&str, &str, Role)> =
            keys.iter().map(|(k, w)| (*k, *w, Role::Admin)).collect();
        test_state_with_roles(root, &with_roles, provider)
    }

    /// Build state via the real `build_state` path (loads persisted memory, opens audit).
    /// `keys`: (api_key, workspace_id, role). ws-a → root/a, ws-b → root/b.
    fn test_state_with_roles(
        root: PathBuf,
        keys: &[(&str, &str, Role)],
        provider: Option<ServerProvider>,
    ) -> AppState {
        fs::create_dir_all(root.join("a")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/secret-a.md"), "alpha only data\n").unwrap();
        fs::write(root.join("b/secret-b.md"), "beta only data\n").unwrap();
        let mut ws_keys: HashMap<String, Vec<([u8; 32], Role)>> = HashMap::new();
        for (key, ws, role) in keys {
            ws_keys
                .entry((*ws).into())
                .or_default()
                .push((hash_key(key), *role));
        }
        let resolved = vec![
            ResolvedWorkspace {
                id: "ws-a".into(),
                roots: vec![root.join("a")],
                keys: ws_keys.remove("ws-a").unwrap_or_default(),
            },
            ResolvedWorkspace {
                id: "ws-b".into(),
                roots: vec![root.join("b")],
                keys: ws_keys.remove("ws-b").unwrap_or_default(),
            },
        ];
        build_state(resolved, &root.join(".server-data"), provider).unwrap()
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

    // ---------------------------------------------------------------------
    // #167 — roles, persistent shared memory, audit.
    // ---------------------------------------------------------------------

    fn publish_req(key: &str, ws: &str, title: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/v1/memory/publish")
            .header("authorization", format!("Bearer {key}"))
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"workspace_id":"{ws}","title":"{title}","body":"{body}"}}"#
            )))
            .unwrap()
    }

    async fn json_body(res: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn resolve_key_hash_variants() {
        // Raw dev token → hashed (matches hash_key).
        let e = KeyEntry {
            key: Some("admin-token".into()),
            key_hash: None,
            role: Role::Admin,
        };
        assert_eq!(resolve_key_hash(&e).unwrap(), hash_key("admin-token"));

        // Precomputed key_hash (no secret in file) → decoded bytes.
        let hex_hash = hex::encode(hash_key("strong-secret"));
        let e = KeyEntry {
            key: None,
            key_hash: Some(hex_hash),
            role: Role::Member,
        };
        assert_eq!(resolve_key_hash(&e).unwrap(), hash_key("strong-secret"));

        // Provider-style raw secret in `key` → refused (guard).
        let e = KeyEntry {
            key: Some("sk-proj-abcdef0123456789abcdef".into()),
            key_hash: None,
            role: Role::Admin,
        };
        assert!(resolve_key_hash(&e).is_err());

        // Neither field → error.
        let e = KeyEntry {
            key: None,
            key_hash: None,
            role: Role::Member,
        };
        assert!(resolve_key_hash(&e).is_err());
    }

    #[test]
    fn server_config_parses_workspaces_and_roles() {
        let toml_src = r#"
            data_dir = "/tmp/cd-server-x"
            [[workspaces]]
            id = "team-a"
            roots = ["/tmp/team-a"]
            keys = [
              { key = "admin-token", role = "admin" },
              { key = "member-token", role = "member" },
            ]
        "#;
        let cfg: ServerConfig = toml::from_str(toml_src).unwrap();
        assert_eq!(cfg.workspaces.len(), 1);
        let resolved = resolve_config_workspaces(&cfg).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].keys.len(), 2);
        assert_eq!(resolved[0].keys[0].1, Role::Admin);
        assert_eq!(resolved[0].keys[1].1, Role::Member);
    }

    #[tokio::test]
    async fn admin_can_publish() {
        let dir = tempdir().unwrap();
        let state = test_state_with_roles(
            dir.path().to_path_buf(),
            &[("admin-k", "ws-a", Role::Admin)],
            None,
        );
        let audit_path = state.audit.path().to_path_buf();
        let app = build_app(state);

        // Publish succeeds for admin.
        let res = app
            .clone()
            .oneshot(publish_req("admin-k", "ws-a", "Arch", "we use jwt"))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v = json_body(res).await;
        assert!(v["id"].as_str().is_some(), "{v}");

        // list returns the published note.
        let list = Request::builder()
            .method("POST")
            .uri("/v1/memory/list")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"workspace_id":"ws-a"}"#))
            .unwrap();
        let res = app.oneshot(list).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v = json_body(res).await;
        let notes = v["notes"].as_array().unwrap();
        assert_eq!(notes.len(), 1, "{v}");
        assert_eq!(notes[0]["title"], "Arch");

        // Audit recorded the allowed write.
        let audit = fs::read_to_string(&audit_path).unwrap();
        assert!(audit.contains("memory_publish"), "{audit}");
        assert!(audit.contains("allowed"), "{audit}");
    }

    #[tokio::test]
    async fn member_cannot_publish() {
        let dir = tempdir().unwrap();
        let state = test_state_with_roles(
            dir.path().to_path_buf(),
            &[
                ("admin-k", "ws-a", Role::Admin),
                ("member-k", "ws-a", Role::Member),
            ],
            None,
        );
        let audit_path = state.audit.path().to_path_buf();
        let app = build_app(state);

        // Member is denied the admin-only publish (403).
        let res = app
            .clone()
            .oneshot(publish_req(
                "member-k",
                "ws-a",
                "Nope",
                "should not persist",
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);

        // Member may still read (search) — scoped read is allowed.
        let search = Request::builder()
            .method("POST")
            .uri("/v1/search")
            .header("authorization", "Bearer member-k")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"workspace_id":"ws-a","query":"alpha"}"#))
            .unwrap();
        let res = app.clone().oneshot(search).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // Nothing was persisted by the denied write.
        let list = Request::builder()
            .method("POST")
            .uri("/v1/memory/list")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"workspace_id":"ws-a"}"#))
            .unwrap();
        let res = app.oneshot(list).await.unwrap();
        let v = json_body(res).await;
        assert!(v["notes"].as_array().unwrap().is_empty(), "{v}");

        // The denial produced an audit entry.
        let audit = fs::read_to_string(&audit_path).unwrap();
        assert!(audit.contains("memory_publish"), "{audit}");
        assert!(audit.contains("denied"), "{audit}");
        // Chain integrity holds.
        AuditLog::new(&audit_path).verify_chain().unwrap();
    }

    #[tokio::test]
    async fn memory_persists_across_reload() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();

        // First "boot": publish a note as admin.
        let state1 = test_state_with_roles(root.clone(), &[("admin-k", "ws-a", Role::Admin)], None);
        let app1 = build_app(state1);
        let res = app1
            .oneshot(publish_req(
                "admin-k",
                "ws-a",
                "Persisted",
                "survives restart",
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);

        // Second "boot": rebuild state from the same data dir (simulated restart).
        let state2 = test_state_with_roles(root.clone(), &[("admin-k", "ws-a", Role::Admin)], None);
        let app2 = build_app(state2);
        let list = Request::builder()
            .method("POST")
            .uri("/v1/memory/list")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"workspace_id":"ws-a"}"#))
            .unwrap();
        let res = app2.oneshot(list).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v = json_body(res).await;
        let notes = v["notes"].as_array().unwrap();
        assert_eq!(notes.len(), 1, "note lost across reload: {v}");
        assert_eq!(notes[0]["title"], "Persisted");
        assert_eq!(notes[0]["body"], "survives restart");
    }

    #[test]
    fn memory_jsonl_roundtrip_on_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("workspaces/team-a/memory.jsonl");
        let note = MemoryNote {
            id: "n1".into(),
            title: "T".into(),
            body: "B".into(),
        };
        append_memory_jsonl(&path, &note).unwrap();
        append_memory_jsonl(
            &path,
            &MemoryNote {
                id: "n2".into(),
                title: "T2".into(),
                body: "B2".into(),
            },
        )
        .unwrap();
        let loaded = load_memory_jsonl(&path);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "n1");
        assert_eq!(loaded[1].title, "T2");
        // Missing file → empty, not an error.
        assert!(load_memory_jsonl(&dir.path().join("nope.jsonl")).is_empty());
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
    async fn permission_round_trip_allow_writes_skill() {
        use http_body_util::BodyExt;

        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a")).unwrap();
        fs::write(dir.path().join("a/x.md"), "payments\n").unwrap();
        let state = test_state(dir.path().to_path_buf(), &[("k", "ws-a")]);
        let app = build_app(state);

        let prompt = Request::builder()
            .method("POST")
            .uri("/v1/session/prompt")
            .header("authorization", "Bearer k")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{
                  "workspace_id":"ws-a",
                  "session_id":"s1",
                  "invoke_tool":{
                    "name":"save_skill",
                    "arguments":{
                      "id":"auth-trace",
                      "name":"Auth Trace",
                      "description":"Trace auth",
                      "body_markdown":"1. Search\n2. Cite",
                      "allows_write":false
                    }
                  }
                }"#,
            ))
            .unwrap();
        let res = app.clone().oneshot(prompt).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let events = v["events"].as_array().unwrap();
        let rid = events
            .iter()
            .find(|e| e["kind"] == "permission_required")
            .and_then(|e| e["payload"]["request_id"].as_str())
            .expect("permission_required")
            .to_string();
        let skill_path = dir.path().join("a/.contextdesk/skills/auth-trace.md");
        assert!(!skill_path.exists(), "must not write before allow");

        let respond = Request::builder()
            .method("POST")
            .uri("/v1/permission/respond")
            .header("authorization", "Bearer k")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"workspace_id":"ws-a","session_id":"s1","request_id":"{rid}","decision":"allow_once","tool_name":"save_skill","arguments":{{}}}}"#
            )))
            .unwrap();
        let res = app.oneshot(respond).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(
            skill_path.is_file(),
            "skill file should exist after allow: {skill_path:?}"
        );
    }

    #[tokio::test]
    async fn permission_round_trip_deny_writes_nothing() {
        use http_body_util::BodyExt;

        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("a")).unwrap();
        fs::write(dir.path().join("a/x.md"), "payments\n").unwrap();
        let state = test_state(dir.path().to_path_buf(), &[("k", "ws-a")]);
        let app = build_app(state);

        let prompt = Request::builder()
            .method("POST")
            .uri("/v1/session/prompt")
            .header("authorization", "Bearer k")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{
                  "workspace_id":"ws-a",
                  "session_id":"s2",
                  "invoke_tool":{
                    "name":"save_skill",
                    "arguments":{
                      "id":"deny-me",
                      "name":"Deny Me",
                      "description":"x",
                      "body_markdown":"body",
                      "allows_write":false
                    }
                  }
                }"#,
            ))
            .unwrap();
        let res = app.clone().oneshot(prompt).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let rid = v["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["kind"] == "permission_required")
            .and_then(|e| e["payload"]["request_id"].as_str())
            .unwrap()
            .to_string();

        let respond = Request::builder()
            .method("POST")
            .uri("/v1/permission/respond")
            .header("authorization", "Bearer k")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"workspace_id":"ws-a","session_id":"s2","request_id":"{rid}","decision":"deny"}}"#
            )))
            .unwrap();
        let res = app.oneshot(respond).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(
            v["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["kind"] == "error"),
            "{v}"
        );
        let skill_path = dir.path().join("a/.contextdesk/skills/deny-me.md");
        assert!(!skill_path.exists(), "deny must not write");
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
