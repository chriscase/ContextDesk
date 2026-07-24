//! ContextDesk headless server — localhost by default, API key auth, research + SSE.

mod jira;
mod telegram;
mod watchers;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use cd_core::audit::{outcomes, AuditLog};
use cd_core::chat::ChatMessage;
use cd_core::config::{config_path, ensure_config_dir, load_config};
use cd_core::connectors::ConnectorConfig;
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::{looks_like_raw_secret, KeychainSecretStore, SecretStore};
use cd_core::memory::{
    MemoryDraft, MemoryRecord, MemoryStore, MemoryWriteOp, Scope, SqliteMemoryStore,
};
use cd_core::permissions::PermissionDecision;
use cd_core::providers::ProviderProfile;
use cd_core::research::{
    build_host_with_connectors, event_to_dto, events_to_dto, grant_and_execute, research_local,
    research_turn, research_turn_with_cancel,
};
use cd_core::ssrf::SystemResolver;
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

use telegram::{
    ChatPermissionProposal, TelegramBridge, TelegramConfig, TelegramIdentity, TelegramMessage,
    TelegramUpdate,
};
use watchers::{
    WatchAction, WatchCondition, WatchSource, WatcherDefinition, WatcherRecord, WatcherStore,
};

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
    /// Optional Telegram input/notification bridge (#289). Secrets remain inside
    /// the Rust process; webhook clients never receive them.
    telegram: Option<Arc<TelegramBridge>>,
    /// Durable watch definitions, source-event claims, and last-run state (#290).
    watchers: Arc<WatcherStore>,
}

/// Session-scoped host retained between prompt and permission.respond (#168).
struct SessionHost {
    host: ToolHost,
    workspace_id: String,
    origin: SessionOrigin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionOrigin {
    TrustedClient,
    Telegram,
    Watcher,
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

/// Resolve Telegram secret references from the OS keychain and build the
/// SSRF-pinned Bot API transport. Raw secret material never enters config or HTTP DTOs.
fn load_telegram_bridge(
    config: Option<&TelegramConfig>,
) -> Result<Option<Arc<TelegramBridge>>, String> {
    let Some(config) = config else {
        return Ok(None);
    };
    telegram::validate_secret_ref("bot_token_ref", &config.bot_token_ref)?;
    telegram::validate_secret_ref("webhook_secret_ref", &config.webhook_secret_ref)?;
    let store = KeychainSecretStore::new();
    let bot_token = store
        .get(&config.bot_token_ref)
        .map_err(|_| {
            format!(
                "failed to read Telegram bot token keychain ref `{}`",
                config.bot_token_ref
            )
        })?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "missing Telegram bot token keychain ref `{}`",
                config.bot_token_ref
            )
        })?;
    let webhook_secret = store
        .get(&config.webhook_secret_ref)
        .map_err(|_| {
            format!(
                "failed to read Telegram webhook secret keychain ref `{}`",
                config.webhook_secret_ref
            )
        })?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "missing Telegram webhook secret keychain ref `{}`",
                config.webhook_secret_ref
            )
        })?;
    TelegramBridge::new_http(config, bot_token, webhook_secret)
        .map(Arc::new)
        .map(Some)
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
    /// Generic connector definitions attached to every workspace ToolHost.
    connectors: Arc<Vec<ConnectorConfig>>,
    /// Connector id → child-only environment values resolved from keychain.
    mcp_env: Arc<jira::McpConnectorEnv>,
    /// Compatibility mirror for the original #167 `/v1/memory/*` wire.
    memory_path: PathBuf,
    /// Server-authoritative workspace memory store (#287).
    sync_memory: Arc<SqliteMemoryStore>,
    /// Durable mutation-id journal: retry-safe even across server restart.
    sync_journal_path: PathBuf,
    sync_journal: HashMap<String, SyncJournalState>,
    /// Server-assigned monotonic write clock for cursor safety.
    sync_clock: Arc<Mutex<i64>>,
    /// Config-level kill switch for all watchers in this workspace.
    watchers_enabled: bool,
}

/// Tool-facing view of the authoritative store. The server has no personal
/// store, so personal writes are rejected and every workspace draft is stamped
/// with the authenticated workspace before it reaches SQLite.
struct AuthoritativeWorkspaceStore {
    workspace_id: String,
    inner: Arc<SqliteMemoryStore>,
    sync_clock: Arc<Mutex<i64>>,
}

impl AuthoritativeWorkspaceStore {
    fn normalize_draft(&self, draft: &mut MemoryDraft) -> cd_core::CoreResult<()> {
        if draft.scope != Scope::Workspace {
            return Err(cd_core::CoreError::Policy(
                "personal memory is device-local and unavailable on cd-server".into(),
            ));
        }
        draft.workspace_id = Some(self.workspace_id.clone());
        Ok(())
    }

    fn ensure_target(&self, id: &uuid::Uuid) -> cd_core::CoreResult<()> {
        let record = self
            .inner
            .get(id)?
            .ok_or_else(|| cd_core::CoreError::Message(format!("memory not found: {id}")))?;
        if record.scope != Scope::Workspace
            || record.workspace_id.as_deref() != Some(self.workspace_id.as_str())
        {
            return Err(cd_core::CoreError::Policy(
                "memory target is outside the server workspace".into(),
            ));
        }
        Ok(())
    }
}

impl MemoryStore for AuthoritativeWorkspaceStore {
    fn put(
        &self,
        mut operation: MemoryWriteOp,
        now_secs: i64,
    ) -> cd_core::CoreResult<MemoryRecord> {
        match &mut operation {
            MemoryWriteOp::Insert(draft) => self.normalize_draft(draft)?,
            MemoryWriteOp::Supersede { old, new } => {
                self.ensure_target(old)?;
                self.normalize_draft(new)?;
            }
            MemoryWriteOp::UpdateMeta { id, .. } | MemoryWriteOp::Retract { id } => {
                self.ensure_target(id)?;
            }
        }
        let accepted_at = reserve_sync_timestamp(&self.sync_clock, now_secs)?;
        self.inner.put(operation, accepted_at)
    }

    fn get(&self, id: &uuid::Uuid) -> cd_core::CoreResult<Option<MemoryRecord>> {
        Ok(self.inner.get(id)?.filter(|record| {
            record.scope == Scope::Workspace
                && record.workspace_id.as_deref() == Some(self.workspace_id.as_str())
        }))
    }

    fn recall(
        &self,
        query: &cd_core::memory::RecallQuery,
        embed: Option<&dyn cd_core::embed::EmbedBackend>,
        weights: cd_core::embed::HybridWeights,
        now_secs: i64,
    ) -> cd_core::CoreResult<Vec<cd_core::memory::RecallHit>> {
        Ok(self
            .inner
            .recall(query, embed, weights, now_secs)?
            .into_iter()
            .filter(|hit| {
                hit.record.scope == Scope::Workspace
                    && hit.record.workspace_id.as_deref() == Some(self.workspace_id.as_str())
            })
            .collect())
    }

    fn set_embed_backend(
        &self,
        backend: Option<Arc<dyn cd_core::embed::EmbedBackend>>,
        model: &str,
    ) {
        self.inner.set_embed_backend(backend, model);
    }

    fn changes_since(&self, cursor: i64) -> cd_core::CoreResult<Vec<MemoryRecord>> {
        Ok(self
            .inner
            .changes_since(cursor)?
            .into_iter()
            .filter(|record| {
                record.scope == Scope::Workspace
                    && record.workspace_id.as_deref() == Some(self.workspace_id.as_str())
            })
            .collect())
    }

    fn list(
        &self,
        kinds: Option<&[cd_core::memory::Kind]>,
        include_superseded: bool,
        include_retracted: bool,
        now_secs: i64,
        limit: usize,
    ) -> cd_core::CoreResult<Vec<MemoryRecord>> {
        Ok(self
            .inner
            .list(
                kinds,
                include_superseded,
                include_retracted,
                now_secs,
                limit,
            )?
            .into_iter()
            .filter(|record| {
                record.scope == Scope::Workspace
                    && record.workspace_id.as_deref() == Some(self.workspace_id.as_str())
            })
            .collect())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct MemoryNote {
    id: String,
    title: String,
    body: String,
}

#[derive(Clone)]
enum SyncJournalState {
    Indeterminate,
    Applied(Box<MemoryRecord>),
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum SyncJournalEntry {
    Pending {
        mutation_id: String,
    },
    Applied {
        mutation_id: String,
        record: Box<MemoryRecord>,
    },
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
    /// Optional Telegram bridge. Contains keychain reference ids, never raw secrets.
    telegram: Option<TelegramConfig>,
}

#[derive(Debug, Deserialize)]
struct WsConfig {
    id: String,
    roots: Vec<PathBuf>,
    #[serde(default = "default_true")]
    watchers_enabled: bool,
    #[serde(default)]
    connectors: Vec<ConnectorConfig>,
    #[serde(default)]
    keys: Vec<KeyEntry>,
}

fn default_true() -> bool {
    true
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
    watchers_enabled: bool,
    connectors: Vec<ConnectorConfig>,
    mcp_env: jira::McpConnectorEnv,
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

fn connector_settings_embed_raw_secret(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(value) => looks_like_raw_secret(value) || value.contains("ATATT"),
        serde_json::Value::Array(values) => values.iter().any(connector_settings_embed_raw_secret),
        serde_json::Value::Object(values) => {
            values.values().any(connector_settings_embed_raw_secret)
        }
        _ => false,
    }
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
        let mut connector_ids = std::collections::HashSet::new();
        for connector in &ws.connectors {
            if connector.id.trim().is_empty() || connector.kind.trim().is_empty() {
                return Err(format!(
                    "workspace '{}' connector id and kind must not be empty",
                    ws.id
                ));
            }
            if !connector_ids.insert(connector.id.as_str()) {
                return Err(format!(
                    "workspace '{}' has duplicate connector id '{}'",
                    ws.id, connector.id
                ));
            }
            if connector_settings_embed_raw_secret(&connector.settings) {
                return Err(format!(
                    "workspace '{}' connector '{}' embeds a raw secret; use a keychain reference",
                    ws.id, connector.id
                ));
            }
        }
        let mut keys = Vec::new();
        for entry in &ws.keys {
            keys.push((resolve_key_hash(entry)?, entry.role));
        }
        out.push(ResolvedWorkspace {
            id: ws.id.clone(),
            roots: ws.roots.clone(),
            watchers_enabled: ws.watchers_enabled,
            connectors: ws.connectors.clone(),
            mcp_env: HashMap::new(),
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

fn workspace_sync_db_path(data_dir: &Path, workspace_id: &str) -> PathBuf {
    data_dir
        .join("workspaces")
        .join(workspace_id)
        .join("memory.sqlite")
}

fn workspace_sync_journal_path(data_dir: &Path, workspace_id: &str) -> PathBuf {
    data_dir
        .join("workspaces")
        .join(workspace_id)
        .join("sync-mutations.jsonl")
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

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn reserve_sync_timestamp(clock: &Mutex<i64>, requested_at: i64) -> cd_core::CoreResult<i64> {
    let mut last = clock
        .lock()
        .map_err(|_| cd_core::CoreError::Message("sync clock lock poisoned".into()))?;
    let accepted_at = requested_at.max(last.saturating_add(1));
    *last = accepted_at;
    Ok(accepted_at)
}

fn legacy_memory_id(workspace_id: &str, note_id: &str) -> uuid::Uuid {
    if let Ok(id) = uuid::Uuid::parse_str(note_id) {
        return id;
    }
    let mut hasher = Sha256::new();
    hasher.update(b"contextdesk-server-legacy-memory\0");
    hasher.update(workspace_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(note_id.as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // Mark the stable hash as RFC 4122 variant/version 5-shaped UUID bytes.
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes)
}

/// Import the original #167 JSONL notes once into the authoritative store.
/// Existing ids are preserved when they are UUIDs; `put_imported` is idempotent.
fn import_legacy_memory(
    store: &SqliteMemoryStore,
    workspace_id: &str,
    notes: &[MemoryNote],
) -> Result<(), String> {
    let mut at = now_unix_secs();
    for note in notes {
        let mut draft = MemoryDraft::new(cd_core::memory::Kind::ProjectNote, &note.body);
        draft.title = note.title.clone();
        draft.scope = Scope::Workspace;
        draft.workspace_id = Some(workspace_id.to_string());
        draft.source = cd_core::memory::MemorySource::Import;
        draft.created_by = "server-jsonl-migration".into();
        store
            .put_imported(legacy_memory_id(workspace_id, &note.id), draft, at)
            .map_err(|e| format!("legacy memory import failed: {e}"))?;
        at = at.saturating_add(1);
    }
    Ok(())
}

fn load_sync_journal(path: &Path) -> Result<HashMap<String, SyncJournalState>, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Ok(HashMap::new());
    };
    let mut out = HashMap::new();
    for (line_no, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let entry: SyncJournalEntry = serde_json::from_str(line).map_err(|e| {
            format!(
                "invalid sync journal {} line {}: {e}",
                path.display(),
                line_no + 1
            )
        })?;
        match entry {
            SyncJournalEntry::Pending { mutation_id } => {
                out.insert(mutation_id, SyncJournalState::Indeterminate);
            }
            SyncJournalEntry::Applied {
                mutation_id,
                record,
            } => {
                out.insert(mutation_id, SyncJournalState::Applied(record));
            }
        }
    }
    Ok(out)
}

/// Append and fsync before/after the store mutation. A crash after `pending`
/// returns an indeterminate retry instead of risking a duplicate insert.
fn append_sync_journal(path: &Path, entry: &SyncJournalEntry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("sync journal directory: {e}"))?;
    }
    let line = serde_json::to_string(entry).map_err(|e| format!("sync journal json: {e}"))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("sync journal open: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("sync journal append: {e}"))?;
    file.sync_data()
        .map_err(|e| format!("sync journal fsync: {e}"))
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
        let legacy_memory = load_memory_jsonl(&memory_path);
        let sync_memory = Arc::new(
            SqliteMemoryStore::open(workspace_sync_db_path(data_dir, &rw.id))
                .map_err(|e| format!("workspace '{}' sync memory: {e}", rw.id))?,
        );
        import_legacy_memory(&sync_memory, &rw.id, &legacy_memory)?;
        let sync_journal_path = workspace_sync_journal_path(data_dir, &rw.id);
        let sync_journal = load_sync_journal(&sync_journal_path)?;
        let last_sync_updated_at = sync_memory
            .changes_since(i64::MIN)
            .map_err(|e| format!("workspace '{}' sync cursor init: {e}", rw.id))?
            .into_iter()
            .map(|record| record.updated_at)
            .max()
            .unwrap_or(0);
        workspaces.insert(
            rw.id.clone(),
            WorkspaceData {
                workspace: ws,
                index,
                connectors: Arc::new(rw.connectors),
                mcp_env: Arc::new(rw.mcp_env),
                memory_path,
                sync_memory,
                sync_journal_path,
                sync_journal,
                sync_clock: Arc::new(Mutex::new(last_sync_updated_at)),
                watchers_enabled: rw.watchers_enabled,
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
    let watchers = WatcherStore::open(data_dir.join("watchers.sqlite"))?;
    Ok(AppState {
        key_hashes: Arc::new(key_hashes),
        workspaces: Arc::new(Mutex::new(workspaces)),
        key_workspaces: Arc::new(key_workspaces),
        key_roles: Arc::new(key_roles),
        audit: Arc::new(audit),
        provider,
        sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        telegram: None,
        watchers: Arc::new(watchers),
    })
}

fn build_authoritative_host(
    workspace: Workspace,
    connectors: &[ConnectorConfig],
    mcp_env: &jira::McpConnectorEnv,
    sync_memory: Arc<SqliteMemoryStore>,
    sync_clock: Arc<Mutex<i64>>,
    audit_path: PathBuf,
) -> Result<ToolHost, StatusCode> {
    // Server workspaces are keyed by the configured name; `Workspace::id` is a
    // locally generated filesystem identity and is not the sync protocol id.
    let workspace_id = workspace.name.clone();
    let mut host =
        build_host_with_connectors(workspace, Some(audit_path), None, None, None, None, &[])
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    host.attach_connectors_with_mcp_secrets(connectors, &HashMap::new(), &HashMap::new(), mcp_env);
    let store: Arc<dyn MemoryStore> = Arc::new(AuthoritativeWorkspaceStore {
        workspace_id,
        inner: sync_memory,
        sync_clock,
    });
    host.set_durable_memory(store, true);
    Ok(host)
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

    let bytes = body.body.len() as u64;
    let note = {
        let mut map = state
            .workspaces
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let data = map
            .get_mut(&body.workspace_id)
            .ok_or(StatusCode::NOT_FOUND)?;
        let at = reserve_sync_timestamp(&data.sync_clock, now_unix_secs())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let mut draft = MemoryDraft::new(cd_core::memory::Kind::ProjectNote, body.body);
        draft.title = body.title;
        draft.scope = Scope::Workspace;
        draft.workspace_id = Some(body.workspace_id.clone());
        draft.created_by = "server-api".into();
        let record = data
            .sync_memory
            .put(MemoryWriteOp::Insert(draft), at)
            .map_err(|e| {
                tracing::error!(error = %e, "authoritative shared memory persist failed");
                StatusCode::INTERNAL_SERVER_ERROR
            })?;
        let note = MemoryNote {
            id: record.id.to_string(),
            title: record.title,
            body: record.content,
        };
        // Compatibility mirror for operators/tests from #167. SQLite above is
        // authoritative; a failed mirror never acknowledges the request.
        append_memory_jsonl(&data.memory_path, &note).map_err(|e| {
            tracing::error!("shared memory JSONL mirror failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;
        note
    };
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
    let records = data
        .sync_memory
        .list(None, false, false, now_unix_secs(), 500)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let notes: Vec<MemoryNote> = records
        .into_iter()
        .filter(|record| {
            record.scope == Scope::Workspace
                && record.workspace_id.as_deref() == Some(body.workspace_id.as_str())
        })
        .map(|record| MemoryNote {
            id: record.id.to_string(),
            title: record.title,
            body: record.content,
        })
        .collect();
    Ok(Json(serde_json::json!({ "notes": notes })))
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
    let (ws, connectors, mcp_env, sync_memory, sync_clock) = {
        let map = state
            .workspaces
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let data = map.get(&body.workspace_id).ok_or(StatusCode::NOT_FOUND)?;
        (
            data.workspace.clone(),
            data.connectors.clone(),
            data.mcp_env.clone(),
            data.sync_memory.clone(),
            data.sync_clock.clone(),
        )
    };
    let mut host = build_authoritative_host(
        ws,
        &connectors,
        &mcp_env,
        sync_memory,
        sync_clock,
        state.audit.path().to_path_buf(),
    )?;
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
    let (ws, connectors, mcp_env, sync_memory, sync_clock) = {
        let map = state
            .workspaces
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let data = map.get(&q.workspace_id).ok_or(StatusCode::NOT_FOUND)?;
        (
            data.workspace.clone(),
            data.connectors.clone(),
            data.mcp_env.clone(),
            data.sync_memory.clone(),
            data.sync_clock.clone(),
        )
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
        let Ok(mut host) = build_authoritative_host(
            ws,
            &connectors,
            &mcp_env,
            sync_memory,
            sync_clock,
            audit_path,
        ) else {
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
    origin: SessionOrigin,
) -> Result<(), StatusCode> {
    let mut sessions = state.sessions.lock().await;
    if let Some(s) = sessions.get(session_id) {
        if s.workspace_id != workspace_id || s.origin != origin {
            return Err(StatusCode::FORBIDDEN);
        }
        return Ok(());
    }
    let (ws, connectors, mcp_env, sync_memory, sync_clock) = {
        let map = state
            .workspaces
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let data = map.get(workspace_id).ok_or(StatusCode::NOT_FOUND)?;
        (
            data.workspace.clone(),
            data.connectors.clone(),
            data.mcp_env.clone(),
            data.sync_memory.clone(),
            data.sync_clock.clone(),
        )
    };
    let host = build_authoritative_host(
        ws,
        &connectors,
        &mcp_env,
        sync_memory,
        sync_clock,
        state.audit.path().to_path_buf(),
    )?;
    sessions.insert(
        session_id.to_string(),
        SessionHost {
            host,
            workspace_id: workspace_id.to_string(),
            origin,
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
    ensure_session_host(
        &state,
        &body.workspace_id,
        &body.session_id,
        SessionOrigin::TrustedClient,
    )
    .await?;

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
    // External-origin pending writes are only actionable through the paired-
    // desktop approval endpoint. Knowing/guessing a request id is not enough.
    if session.origin != SessionOrigin::TrustedClient {
        let _ = state.audit.log(
            "external_permission_respond",
            ToolSideEffect::HardWrite,
            &body.session_id,
            outcomes::DENIED,
            "generic permission endpoint refused external-origin session",
            0,
        );
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

// ---------------------------------------------------------------------------
// Server-authoritative workspace memory sync (#287, server half only).
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct SyncMembership {
    workspace_id: String,
    role: Role,
}

async fn sync_membership(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    let mut memberships = Vec::new();
    if state.key_hashes.is_empty() {
        let map = state
            .workspaces
            .lock()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        memberships.extend(map.keys().cloned().map(|workspace_id| SyncMembership {
            workspace_id,
            role: Role::Admin,
        }));
    } else {
        let hash = token_hash(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
        if !key_hash_authorized(&state.key_hashes, &hash) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        if let Some(roles) = state.key_roles.get(&hash) {
            memberships.extend(roles.iter().map(|(workspace_id, role)| SyncMembership {
                workspace_id: workspace_id.clone(),
                role: *role,
            }));
        }
    }
    memberships.sort_by(|a, b| a.workspace_id.cmp(&b.workspace_id));
    Ok(Json(serde_json::json!({ "workspaces": memberships })))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct SyncCursor {
    updated_at: i64,
    rev: i64,
    id: String,
}

impl SyncCursor {
    fn for_record(record: &MemoryRecord) -> Self {
        Self {
            updated_at: record.updated_at,
            rev: record.rev,
            id: record.id.to_string(),
        }
    }
}

fn sync_record_after_cursor(record: &MemoryRecord, cursor: &SyncCursor) -> bool {
    (record.updated_at, record.rev, record.id.to_string())
        > (cursor.updated_at, cursor.rev, cursor.id.clone())
}

fn overlay_journal_origin(
    mut record: MemoryRecord,
    journal: &HashMap<String, SyncJournalState>,
) -> MemoryRecord {
    // SQLite's v1 write op does not accept origin_node. Preserve the most
    // recent journaled origin for this row at or before its current revision;
    // a later supersession changes the old row without changing its author.
    let origin = journal
        .values()
        .filter_map(|state| match state {
            SyncJournalState::Applied(applied)
                if applied.id == record.id
                    && (applied.updated_at, applied.rev) <= (record.updated_at, record.rev) =>
            {
                Some(applied.as_ref())
            }
            _ => None,
        })
        .max_by_key(|applied| (applied.updated_at, applied.rev))
        .and_then(|applied| applied.origin_node.clone());
    if let Some(origin) = origin {
        record.origin_node = Some(origin);
    }
    record
}

#[derive(Deserialize)]
struct SyncChangesBody {
    workspace_id: String,
    cursor: Option<SyncCursor>,
    limit: Option<usize>,
}

async fn sync_changes_since(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SyncChangesBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
    let cursor = body.cursor.unwrap_or(SyncCursor {
        updated_at: i64::MIN,
        rev: i64::MIN,
        id: String::new(),
    });
    let limit = body.limit.unwrap_or(200).clamp(1, 500);
    let map = state
        .workspaces
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let data = map.get(&body.workspace_id).ok_or(StatusCode::NOT_FOUND)?;
    // Query one second back so records sharing the cursor timestamp remain visible;
    // the tuple cursor below removes already-delivered rows deterministically.
    let query_cursor = cursor.updated_at.saturating_sub(1);
    let mut records: Vec<MemoryRecord> = data
        .sync_memory
        .changes_since(query_cursor)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .into_iter()
        .filter(|record| {
            record.scope == Scope::Workspace
                && record.workspace_id.as_deref() == Some(body.workspace_id.as_str())
                && sync_record_after_cursor(record, &cursor)
        })
        .map(|record| overlay_journal_origin(record, &data.sync_journal))
        .collect();
    records.sort_by_key(|record| (record.updated_at, record.rev, record.id.to_string()));
    let has_more = records.len() > limit;
    records.truncate(limit);
    let next_cursor = records.last().map(SyncCursor::for_record).unwrap_or(cursor);
    Ok(Json(serde_json::json!({
        "workspace_id": body.workspace_id,
        "records": records,
        "next_cursor": next_cursor,
        "has_more": has_more,
        "server_time": now_unix_secs(),
    })))
}

#[derive(Deserialize)]
struct SyncApplyBody {
    workspace_id: String,
    mutations: Vec<SyncMutation>,
}

#[derive(Deserialize)]
struct SyncMutation {
    mutation_id: String,
    origin_node: String,
    client_updated_at: i64,
    client_rev: i64,
    base_rev: Option<i64>,
    operation: MemoryWriteOp,
}

#[derive(Serialize)]
struct SyncApplyResult {
    mutation_id: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    record: Option<MemoryRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_record: Option<MemoryRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

fn sync_identifier_valid(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
}

fn sync_operation_target(operation: &MemoryWriteOp) -> Option<uuid::Uuid> {
    match operation {
        MemoryWriteOp::Insert(_) => None,
        MemoryWriteOp::UpdateMeta { id, .. } | MemoryWriteOp::Retract { id } => Some(*id),
        MemoryWriteOp::Supersede { old, .. } => Some(*old),
    }
}

fn normalize_sync_operation(
    mut operation: MemoryWriteOp,
    workspace_id: &str,
) -> Result<MemoryWriteOp, &'static str> {
    let normalize = |draft: &mut MemoryDraft| -> Result<(), &'static str> {
        if draft.scope != Scope::Workspace {
            return Err("personal scope is device-local and cannot be synced");
        }
        draft.workspace_id = Some(workspace_id.to_string());
        Ok(())
    };
    match &mut operation {
        MemoryWriteOp::Insert(draft) => normalize(draft)?,
        MemoryWriteOp::Supersede { new, .. } => normalize(new)?,
        MemoryWriteOp::UpdateMeta { .. } | MemoryWriteOp::Retract { .. } => {}
    }
    Ok(operation)
}

fn rejected_sync_result(mutation_id: String, status: &str, detail: &str) -> SyncApplyResult {
    SyncApplyResult {
        mutation_id,
        status: status.into(),
        record: None,
        server_record: None,
        detail: Some(detail.into()),
    }
}

async fn sync_apply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SyncApplyBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
    require_admin(
        &headers,
        &state,
        &body.workspace_id,
        "sync_apply",
        &body.workspace_id,
    )?;
    if body.mutations.is_empty() || body.mutations.len() > 100 {
        return Err(StatusCode::BAD_REQUEST);
    }

    let server_now = now_unix_secs();
    let mut map = state
        .workspaces
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let data = map
        .get_mut(&body.workspace_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    let mut results = Vec::with_capacity(body.mutations.len());

    for mutation in body.mutations {
        let mutation_id = mutation.mutation_id.trim().to_string();
        if !sync_identifier_valid(&mutation_id) || !sync_identifier_valid(&mutation.origin_node) {
            results.push(rejected_sync_result(
                mutation_id,
                "rejected",
                "mutation_id/origin_node must be 1-128 safe identifier characters",
            ));
            continue;
        }
        if mutation.client_rev < 0 || mutation.client_updated_at > server_now.saturating_add(300) {
            results.push(rejected_sync_result(
                mutation_id,
                "rejected",
                "invalid revision or client timestamp exceeds allowed clock skew",
            ));
            continue;
        }
        if let Some(previous) = data.sync_journal.get(&mutation_id) {
            results.push(match previous {
                SyncJournalState::Applied(record) => SyncApplyResult {
                    mutation_id,
                    status: "duplicate".into(),
                    record: Some(record.as_ref().clone()),
                    server_record: None,
                    detail: None,
                },
                SyncJournalState::Indeterminate => rejected_sync_result(
                    mutation_id,
                    "indeterminate",
                    "a prior attempt may have committed; pull changes before retrying",
                ),
            });
            continue;
        }

        let operation = match normalize_sync_operation(mutation.operation, &body.workspace_id) {
            Ok(operation) => operation,
            Err(detail) => {
                let _ = state.audit.log(
                    "sync_apply",
                    ToolSideEffect::SoftWrite,
                    &body.workspace_id,
                    outcomes::DENIED,
                    detail,
                    0,
                );
                results.push(rejected_sync_result(mutation_id, "rejected", detail));
                continue;
            }
        };

        if let Some(target_id) = sync_operation_target(&operation) {
            let current = data
                .sync_memory
                .get(&target_id)
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
            let Some(current) = current else {
                results.push(rejected_sync_result(
                    mutation_id,
                    "not_found",
                    "target record does not exist",
                ));
                continue;
            };
            if current.scope != Scope::Workspace
                || current.workspace_id.as_deref() != Some(body.workspace_id.as_str())
            {
                let _ = state.audit.log(
                    "sync_apply",
                    ToolSideEffect::SoftWrite,
                    &target_id.to_string(),
                    outcomes::DENIED,
                    "cross-workspace or personal target denied",
                    0,
                );
                results.push(rejected_sync_result(
                    mutation_id,
                    "rejected",
                    "target is outside the requested workspace",
                ));
                continue;
            }
            let base_matches = mutation.base_rev == Some(current.rev);
            let candidate_wins = (mutation.client_updated_at, mutation.client_rev)
                > (current.updated_at, current.rev);
            if !base_matches && !candidate_wins {
                results.push(SyncApplyResult {
                    mutation_id,
                    status: "conflict".into(),
                    record: None,
                    server_record: Some(overlay_journal_origin(current, &data.sync_journal)),
                    detail: Some("server record wins by updated_at/rev".into()),
                });
                continue;
            }
        } else if mutation.base_rev.is_some() {
            results.push(rejected_sync_result(
                mutation_id,
                "rejected",
                "insert must not include base_rev",
            ));
            continue;
        }

        if append_sync_journal(
            &data.sync_journal_path,
            &SyncJournalEntry::Pending {
                mutation_id: mutation_id.clone(),
            },
        )
        .is_err()
        {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
        data.sync_journal
            .insert(mutation_id.clone(), SyncJournalState::Indeterminate);
        let accepted_at = reserve_sync_timestamp(&data.sync_clock, server_now)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let stored = match data.sync_memory.put(operation, accepted_at) {
            Ok(record) => record,
            Err(_) => {
                let _ = state.audit.log(
                    "sync_apply",
                    ToolSideEffect::SoftWrite,
                    &body.workspace_id,
                    outcomes::ERROR,
                    "authoritative memory store rejected mutation",
                    0,
                );
                results.push(rejected_sync_result(
                    mutation_id,
                    "indeterminate",
                    "store rejected mutation; pull changes before retrying",
                ));
                continue;
            }
        };
        let mut record = stored;
        record.origin_node = Some(mutation.origin_node.clone());
        if append_sync_journal(
            &data.sync_journal_path,
            &SyncJournalEntry::Applied {
                mutation_id: mutation_id.clone(),
                record: Box::new(record.clone()),
            },
        )
        .is_err()
        {
            results.push(rejected_sync_result(
                mutation_id,
                "indeterminate",
                "mutation committed but result journal failed; pull before retry",
            ));
            continue;
        }
        data.sync_journal.insert(
            mutation_id.clone(),
            SyncJournalState::Applied(Box::new(record.clone())),
        );
        let _ = state.audit.log(
            "sync_apply",
            ToolSideEffect::SoftWrite,
            &format!("{}/{}", body.workspace_id, record.id),
            outcomes::ALLOWED,
            &format!("origin_node={}", mutation.origin_node),
            record.content.len() as u64,
        );
        results.push(SyncApplyResult {
            mutation_id,
            status: "applied".into(),
            record: Some(record),
            server_record: None,
            detail: None,
        });
    }

    Ok(Json(serde_json::json!({
        "workspace_id": body.workspace_id,
        "results": results,
        "server_time": now_unix_secs(),
    })))
}

// Telegram chat bridge (#289).
// ---------------------------------------------------------------------------

enum TelegramAction {
    Research(String),
    InvokeTool {
        name: String,
        arguments: serde_json::Value,
    },
}

fn telegram_action(text: &str) -> Result<TelegramAction, String> {
    let trimmed = text.trim();
    if trimmed == "/save" {
        return Err("Use /save <title> followed by an optional newline and note body.".into());
    }
    if let Some(rest) = trimmed
        .strip_prefix("/save ")
        .or_else(|| trimmed.strip_prefix("/save\n"))
    {
        let rest = rest.trim();
        let (title, body) = rest.split_once('\n').unwrap_or((rest, rest));
        return Ok(TelegramAction::InvokeTool {
            name: cd_core::tools::names::SAVE_MEMORY.into(),
            arguments: serde_json::json!({
                "title": title.trim(),
                "body_markdown": body.trim(),
                "content": body.trim(),
                "kind": "project_note",
                "scope": "workspace",
            }),
        });
    }
    Ok(TelegramAction::Research(trimmed.to_string()))
}

fn telegram_reply_text(
    events: &[StreamEvent],
    permission_sides: &HashMap<String, ToolSideEffect>,
    identity: &TelegramIdentity,
) -> String {
    let mut out = String::new();
    for event in events {
        match event {
            StreamEvent::TextDelta { text } => out.push_str(text),
            StreamEvent::Citation { label, locator, .. } => {
                if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
                out.push_str("Source: ");
                out.push_str(label);
                if let Some(locator) = locator {
                    out.push_str(" — ");
                    out.push_str(locator);
                }
                out.push('\n');
            }
            StreamEvent::PermissionRequired {
                request_id,
                tool_name,
                target,
                preview,
                ..
            } => {
                if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
                match permission_sides
                    .get(request_id)
                    .copied()
                    .unwrap_or(ToolSideEffect::HardWrite)
                {
                    ToolSideEffect::SoftWrite
                        if identity.role.is_admin() && identity.allow_soft_write =>
                    {
                        out.push_str(&format!(
                            "SoftWrite proposal from {tool_name} for {target}:\n{preview}\n\
                             Confirm with /approve_soft {request_id} WRITE"
                        ));
                    }
                    ToolSideEffect::SoftWrite => out.push_str(&format!(
                        "SoftWrite proposal from {tool_name} for {target} was queued for a trusted desktop."
                    )),
                    ToolSideEffect::HardWrite | ToolSideEffect::Read => out.push_str(&format!(
                        "HardWrite proposal from {tool_name} for {target} was queued for a trusted desktop. Chat cannot approve it."
                    )),
                }
                out.push('\n');
            }
            StreamEvent::Error { message, .. } => {
                if !out.ends_with('\n') && !out.is_empty() {
                    out.push('\n');
                }
                out.push_str("Request failed: ");
                out.push_str(message);
                out.push('\n');
            }
            _ => {}
        }
    }
    if out.trim().is_empty() {
        "Request completed.".into()
    } else {
        out.trim().to_string()
    }
}

async fn run_telegram_action(
    state: &AppState,
    bridge: &TelegramBridge,
    identity: &TelegramIdentity,
    message: &TelegramMessage,
    session_id: &str,
    action: TelegramAction,
) -> Result<Vec<StreamEvent>, String> {
    ensure_session_host(
        state,
        &identity.workspace_id,
        session_id,
        SessionOrigin::Telegram,
    )
    .await
    .map_err(|status| format!("session host failed: {status}"))?;

    let (events, permission_sides) = {
        let mut sessions = state.sessions.lock().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Telegram session disappeared".to_string())?;
        let events = match action {
            TelegramAction::Research(query) => {
                let query = if query.is_empty() {
                    "search workspace"
                } else {
                    query.as_str()
                };
                run_research_turn(
                    &mut session.host,
                    state.provider.as_ref(),
                    query,
                    session_id,
                    false,
                )
                .await
                .map_err(|status| format!("research turn failed: {status}"))?
                .0
            }
            TelegramAction::InvokeTool { name, arguments } => {
                session
                    .host
                    .execute(&name, &arguments, None)
                    .await
                    .map_err(|_| "Telegram tool invocation failed".to_string())?
                    .events
            }
        };
        let permission_sides = events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::PermissionRequired {
                    request_id,
                    tool_name,
                    ..
                } => Some((request_id.clone(), session.host.side_effect_for(tool_name))),
                _ => None,
            })
            .collect::<HashMap<_, _>>();
        (events, permission_sides)
    };

    for event in &events {
        if let StreamEvent::PermissionRequired {
            request_id,
            tool_name,
            target,
            reason,
            preview,
            risk,
            ..
        } = event
        {
            let side_effect = permission_sides
                .get(request_id)
                .copied()
                .unwrap_or(ToolSideEffect::HardWrite);
            bridge.queue_proposal(ChatPermissionProposal {
                request_id: request_id.clone(),
                workspace_id: identity.workspace_id.clone(),
                session_id: session_id.to_string(),
                user_id: identity.user_id,
                chat_id: message.chat.id,
                message_thread_id: message.message_thread_id,
                tool_name: tool_name.clone(),
                target: target.clone(),
                reason: reason.clone(),
                preview: preview.clone(),
                risk: risk.clone(),
                side_effect,
                trusted_desktop_connected: false,
            })?;
            let _ = state.audit.log(
                "telegram_permission_proposal",
                side_effect,
                target,
                outcomes::PENDING,
                &format!(
                    "origin=telegram user_id={} workspace_id={}",
                    identity.user_id, identity.workspace_id
                ),
                preview.len() as u64,
            );
        }
    }

    let reply = telegram_reply_text(&events, &permission_sides, identity);
    bridge
        .send_text(
            message.chat.id,
            message.message_thread_id,
            Some(message.message_id),
            &reply,
        )
        .await?;
    Ok(events)
}

async fn execute_external_permission(
    state: &AppState,
    proposal: &ChatPermissionProposal,
    decision: PermissionDecision,
    typed: Option<&str>,
) -> Result<Vec<StreamEvent>, StatusCode> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&proposal.session_id)
        .ok_or(StatusCode::NOT_FOUND)?;
    if session.workspace_id != proposal.workspace_id
        || !matches!(
            session.origin,
            SessionOrigin::Telegram | SessionOrigin::Watcher
        )
    {
        return Err(StatusCode::FORBIDDEN);
    }
    grant_and_execute(
        &mut session.host,
        &proposal.request_id,
        decision,
        typed,
        "",
        &serde_json::Value::Null,
        None,
    )
    .await
    .map_err(|_| StatusCode::BAD_REQUEST)
}

async fn telegram_soft_approval(
    state: &AppState,
    bridge: &TelegramBridge,
    identity: &TelegramIdentity,
    message: &TelegramMessage,
    text: &str,
) -> Result<bool, String> {
    let mut parts = text.split_whitespace();
    if parts.next() != Some("/approve_soft") {
        return Ok(false);
    }
    let Some(request_id) = parts.next() else {
        bridge
            .send_text(
                message.chat.id,
                message.message_thread_id,
                Some(message.message_id),
                "Use /approve_soft <request-id> WRITE",
            )
            .await?;
        return Ok(true);
    };
    let typed = parts.next().unwrap_or("");
    let proposal = bridge
        .proposal(request_id)?
        .ok_or_else(|| "Unknown or expired SoftWrite proposal.".to_string())?;
    let allowed_identity = identity.user_id == proposal.user_id
        && identity.workspace_id == proposal.workspace_id
        && identity.role.is_admin()
        && identity.allow_soft_write;
    if !allowed_identity || proposal.side_effect != ToolSideEffect::SoftWrite || typed != "WRITE" {
        let _ = state.audit.log(
            "telegram_softwrite_approval",
            proposal.side_effect,
            &proposal.target,
            outcomes::DENIED,
            "chat approval rejected: policy, side-effect, identity, or phrase mismatch",
            0,
        );
        let notice = if proposal.side_effect == ToolSideEffect::HardWrite {
            "HardWrite cannot be approved from Telegram; use the paired desktop."
        } else {
            "SoftWrite approval rejected. Check the configured admin policy and type WRITE exactly."
        };
        bridge
            .send_text(
                message.chat.id,
                message.message_thread_id,
                Some(message.message_id),
                notice,
            )
            .await?;
        return Ok(true);
    }

    let events = execute_external_permission(
        state,
        &proposal,
        PermissionDecision::AllowOnce,
        Some("WRITE"),
    )
    .await
    .map_err(|status| format!("SoftWrite approval failed: {status}"))?;
    bridge.remove_proposal(request_id)?;
    let reply = telegram_reply_text(&events, &HashMap::new(), identity);
    bridge
        .send_text(
            proposal.chat_id,
            proposal.message_thread_id,
            Some(message.message_id),
            &reply,
        )
        .await?;
    let _ = state.audit.log(
        "telegram_softwrite_approval",
        ToolSideEffect::SoftWrite,
        &proposal.target,
        outcomes::ALLOWED,
        &format!("origin=telegram configured_admin={}", identity.user_id),
        0,
    );
    Ok(true)
}

async fn process_telegram_update(state: &AppState, update: TelegramUpdate) -> Result<(), String> {
    let bridge = state
        .telegram
        .as_deref()
        .ok_or_else(|| "Telegram bridge is not configured".to_string())?;
    let Some(message) = update.message else {
        return Ok(());
    };
    let Some(user) = &message.from_user else {
        return Ok(());
    };
    let Some(text) = message.text.as_deref() else {
        return Ok(());
    };
    let Some(identity) = bridge.identity(user.id) else {
        let _ = state.audit.log(
            "telegram_message",
            ToolSideEffect::Read,
            &format!("telegram:user:{}/chat:{}", user.id, message.chat.id),
            outcomes::DENIED,
            "unmapped Telegram user",
            text.len() as u64,
        );
        bridge
            .send_text(
                message.chat.id,
                message.message_thread_id,
                Some(message.message_id),
                "This Telegram account is not authorized for a workspace.",
            )
            .await?;
        return Ok(());
    };

    if telegram_soft_approval(state, bridge, &identity, &message, text).await? {
        return Ok(());
    }

    let session_id = bridge.session_id(message.chat.id, message.message_thread_id)?;
    let _ = state.audit.log(
        "telegram_message",
        ToolSideEffect::Read,
        &format!(
            "telegram:user:{}/chat:{}/session:{}",
            user.id, message.chat.id, session_id
        ),
        outcomes::ALLOWED,
        &format!(
            "origin=telegram workspace_id={} role={:?}",
            identity.workspace_id, identity.role
        ),
        text.len() as u64,
    );
    let action = match telegram_action(text) {
        Ok(action) => action,
        Err(help) => {
            bridge
                .send_text(
                    message.chat.id,
                    message.message_thread_id,
                    Some(message.message_id),
                    &help,
                )
                .await?;
            return Ok(());
        }
    };
    run_telegram_action(state, bridge, &identity, &message, &session_id, action).await?;
    Ok(())
}

async fn telegram_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(update): Json<TelegramUpdate>,
) -> Result<impl IntoResponse, StatusCode> {
    let bridge = state.telegram.as_deref().ok_or(StatusCode::NOT_FOUND)?;
    let secret = headers
        .get("x-telegram-bot-api-secret-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !bridge.webhook_secret_matches(secret) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if !bridge
        .accept_update(update.update_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Ok(Json(serde_json::json!({ "ok": true, "duplicate": true })));
    }
    let failure_reply = update.message.as_ref().map(|message| {
        (
            message.chat.id,
            message.message_thread_id,
            message.message_id,
        )
    });
    let failure_bridge = state.telegram.clone();
    // Telegram expects a quick webhook acknowledgement; the turn and outbound
    // replies continue on a detached task using the same process state.
    tokio::spawn(async move {
        if let Err(error) = process_telegram_update(&state, update).await {
            tracing::warn!(error = %error, "Telegram update failed");
            if let (Some(bridge), Some((chat_id, thread_id, message_id))) =
                (failure_bridge, failure_reply)
            {
                let _ = bridge
                    .send_text(
                        chat_id,
                        thread_id,
                        Some(message_id),
                        "The request failed safely. Try again or use the trusted desktop.",
                    )
                    .await;
            }
        }
    });
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ChatPairBody {
    workspace_id: String,
    device_label: String,
}

async fn chat_pair(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ChatPairBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
    require_admin(
        &headers,
        &state,
        &body.workspace_id,
        "chat_pair",
        &body.workspace_id,
    )?;
    let bridge = state.telegram.as_deref().ok_or(StatusCode::NOT_FOUND)?;
    let (pairing_id, created_at_unix) = bridge
        .pair_desktop(&body.workspace_id, &body.device_label)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = state.audit.log(
        "chat_pair",
        ToolSideEffect::SoftWrite,
        &body.workspace_id,
        outcomes::ALLOWED,
        "trusted desktop paired for chat proposals",
        0,
    );
    Ok(Json(serde_json::json!({
        "pairing_id": pairing_id,
        "workspace_id": body.workspace_id,
        "created_at_unix": created_at_unix,
    })))
}

#[derive(Deserialize)]
struct ChatApprovalsQuery {
    workspace_id: String,
    pairing_id: String,
}

async fn chat_approvals(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ChatApprovalsQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &query.workspace_id)?;
    require_admin(
        &headers,
        &state,
        &query.workspace_id,
        "chat_approvals",
        &query.workspace_id,
    )?;
    let bridge = state.telegram.as_deref().ok_or(StatusCode::NOT_FOUND)?;
    bridge
        .validate_pairing(&query.pairing_id, &query.workspace_id)
        .map_err(|_| StatusCode::FORBIDDEN)?;
    let proposals = bridge
        .proposals_for_workspace(&query.workspace_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({ "proposals": proposals })))
}

#[derive(Deserialize)]
struct ChatApprovalRespondBody {
    workspace_id: String,
    pairing_id: String,
    request_id: String,
    /// Paired desktop supports only deny or allow_once for chat proposals.
    decision: String,
    typed: Option<String>,
}

async fn chat_approval_respond(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ChatApprovalRespondBody>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &body.workspace_id)?;
    require_admin(
        &headers,
        &state,
        &body.workspace_id,
        "chat_approval_respond",
        &body.request_id,
    )?;
    let bridge = state.telegram.as_deref().ok_or(StatusCode::NOT_FOUND)?;
    bridge
        .validate_pairing(&body.pairing_id, &body.workspace_id)
        .map_err(|_| StatusCode::FORBIDDEN)?;
    let decision = match body.decision.trim() {
        "deny" => PermissionDecision::Deny,
        "allow_once" => PermissionDecision::AllowOnce,
        _ => return Err(StatusCode::BAD_REQUEST),
    };
    let proposal = bridge
        .proposal(&body.request_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    if proposal.workspace_id != body.workspace_id {
        return Err(StatusCode::FORBIDDEN);
    }
    // Preflight the current core type-to-confirm contract before consuming the
    // pending request. A typo must fail closed while remaining retryable.
    if matches!(decision, PermissionDecision::AllowOnce)
        && matches!(proposal.risk.as_str(), "remote" | "destructive")
        && body.typed.as_deref().map(str::trim) != Some("WRITE")
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let events =
        execute_external_permission(&state, &proposal, decision, body.typed.as_deref()).await?;
    bridge
        .remove_proposal(&body.request_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let desktop_identity = TelegramIdentity {
        user_id: proposal.user_id,
        workspace_id: proposal.workspace_id.clone(),
        role: Role::Admin,
        allow_soft_write: false,
    };
    let reply = telegram_reply_text(&events, &HashMap::new(), &desktop_identity);
    if let Err(error) = bridge
        .send_text(proposal.chat_id, proposal.message_thread_id, None, &reply)
        .await
    {
        tracing::warn!(error = %error, "approved chat proposal executed but Telegram notify failed");
    }
    let _ = state.audit.log(
        "chat_approval_respond",
        proposal.side_effect,
        &proposal.target,
        if matches!(decision, PermissionDecision::Deny) {
            outcomes::DENIED
        } else {
            outcomes::ALLOWED
        },
        "origin=trusted_paired_desktop",
        0,
    );
    Ok(Json(serde_json::json!({
        "request_id": body.request_id,
        "events": events_to_dto(&events),
    })))
}

// ---------------------------------------------------------------------------
// Persistent server-resident watchers / triggers (#290).
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct WatchObservation {
    event_key: String,
    text: String,
    result_count: usize,
}

#[derive(Debug, Serialize)]
struct WatcherRunReport {
    watcher_id: String,
    outcome: String,
    event_key: Option<String>,
    request_id: Option<String>,
}

fn unix_timestamp_i64() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

fn workspace_watchers_enabled(state: &AppState, workspace_id: &str) -> Result<bool, StatusCode> {
    state
        .workspaces
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .get(workspace_id)
        .map(|workspace| workspace.watchers_enabled)
        .ok_or(StatusCode::NOT_FOUND)
}

fn watch_condition_matches(condition: &WatchCondition, observation: &WatchObservation) -> bool {
    match condition {
        WatchCondition::Always => true,
        WatchCondition::Contains { needle } => observation
            .text
            .to_lowercase()
            .contains(&needle.to_lowercase()),
        WatchCondition::ResultCountAtLeast { minimum } => observation.result_count >= *minimum,
    }
}

fn bounded_watch_text(value: &str, max_chars: usize) -> String {
    let mut output = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        output.push('…');
    }
    output
}

fn connector_registers_tool(connector: &ConnectorConfig, tool_name: &str) -> bool {
    if !connector.enabled {
        return false;
    }
    if connector
        .settings
        .get("stub_tool")
        .and_then(|stub| stub.get("name"))
        .and_then(|name| name.as_str())
        == Some(tool_name)
    {
        return true;
    }
    match connector.kind.as_str() {
        "mcp" => tool_name.starts_with(&format!("mcp__{}__", connector.id)),
        "sqlite" | "postgres" => tool_name == format!("sql_query__{}", connector.id),
        "http" => tool_name == format!("http_get__{}", connector.id),
        _ => false,
    }
}

async fn observe_watcher(
    state: &AppState,
    definition: &WatcherDefinition,
    now: i64,
) -> Result<WatchObservation, String> {
    match &definition.watch {
        WatchSource::Query {
            query,
            result_limit,
            ..
        } => {
            // Rebuild from the workspace roots on each scheduled run. The server's
            // request index is a startup snapshot; watchers must see later file changes.
            let workspace = {
                let workspaces = state
                    .workspaces
                    .lock()
                    .map_err(|_| "workspace lock poisoned".to_string())?;
                workspaces
                    .get(&definition.workspace_id)
                    .map(|workspace| workspace.workspace.clone())
                    .ok_or_else(|| "watcher workspace not found".to_string())?
            };
            let index = KeywordIndex::build(&workspace)
                .map_err(|_| "watch query index rebuild failed".to_string())?;
            let matches = index.search(query, *result_limit);
            let mut text = String::new();
            for (score, chunk) in &matches {
                text.push_str(&format!(
                    "{}:{}-{} score={score:.3}\n{}\n",
                    chunk.path.display(),
                    chunk.start_line,
                    chunk.end_line,
                    chunk.text
                ));
            }
            let event_key = watchers::event_key("query", text.as_bytes());
            Ok(WatchObservation {
                event_key,
                text: bounded_watch_text(&text, 12_000),
                result_count: matches.len(),
            })
        }
        WatchSource::Schedule {
            interval_seconds, ..
        } => {
            let slot = now.div_euclid(*interval_seconds as i64);
            Ok(WatchObservation {
                event_key: format!("schedule:{slot}"),
                text: format!("scheduled interval slot {slot}"),
                result_count: 1,
            })
        }
        WatchSource::ConnectorPoll {
            connector_id,
            tool_name,
            arguments,
            ..
        } => {
            let connector_matches = {
                let workspaces = state
                    .workspaces
                    .lock()
                    .map_err(|_| "workspace lock poisoned".to_string())?;
                let workspace = workspaces
                    .get(&definition.workspace_id)
                    .ok_or_else(|| "watcher workspace not found".to_string())?;
                workspace.connectors.iter().any(|connector| {
                    connector.id == *connector_id && connector_registers_tool(connector, tool_name)
                })
            };
            if !connector_matches {
                return Err(format!(
                    "connector poll tool '{tool_name}' is not registered by enabled connector '{connector_id}'"
                ));
            }
            let session_id = format!("watcher-{}", definition.id);
            ensure_session_host(
                state,
                &definition.workspace_id,
                &session_id,
                SessionOrigin::Watcher,
            )
            .await
            .map_err(|status| format!("connector poll session failed: {status}"))?;
            let result = {
                let mut sessions = state.sessions.lock().await;
                let session = sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| "watcher session disappeared".to_string())?;
                if session.host.side_effect_for(tool_name) != ToolSideEffect::Read {
                    return Err(
                        "connector poll tool is not Read; writes cannot be watch sources".into(),
                    );
                }
                session
                    .host
                    .execute(tool_name, arguments, None)
                    .await
                    .map_err(|_| "connector poll tool failed".to_string())?
            };
            if !result.ok {
                return Err("connector poll returned an unsuccessful result".into());
            }
            let text = bounded_watch_text(&result.detail_raw, 12_000);
            let key_material = format!("{connector_id}\0{text}");
            Ok(WatchObservation {
                event_key: watchers::event_key("connector", key_material.as_bytes()),
                text,
                result_count: 1,
            })
        }
    }
}

fn permission_proposal_from_event(
    event: &StreamEvent,
    definition: &WatcherDefinition,
    session_id: &str,
    side_effect: ToolSideEffect,
    chat_id: i64,
    message_thread_id: Option<i64>,
) -> Option<ChatPermissionProposal> {
    let StreamEvent::PermissionRequired {
        request_id,
        tool_name,
        target,
        reason,
        preview,
        risk,
        ..
    } = event
    else {
        return None;
    };
    Some(ChatPermissionProposal {
        request_id: request_id.clone(),
        workspace_id: definition.workspace_id.clone(),
        session_id: session_id.to_string(),
        // Watchers are a system origin, never a Telegram user. This also makes
        // in-chat SoftWrite approval impossible; only the paired desktop can grant.
        user_id: 0,
        chat_id,
        message_thread_id,
        tool_name: tool_name.clone(),
        target: target.clone(),
        reason: reason.clone(),
        preview: preview.clone(),
        risk: risk.clone(),
        side_effect,
        trusted_desktop_connected: false,
    })
}

async fn execute_watch_action(
    state: &AppState,
    definition: &WatcherDefinition,
    observation: &WatchObservation,
) -> Result<Option<String>, String> {
    match &definition.action {
        WatchAction::Notify {
            chat_id,
            message_thread_id,
            text,
        } => {
            let bridge = state
                .telegram
                .as_deref()
                .ok_or_else(|| "Telegram bridge is not configured".to_string())?;
            let rendered = text
                .replace("{{watcher_id}}", &definition.id)
                .replace("{{event}}", &bounded_watch_text(&observation.text, 2_000));
            bridge
                .send_text(*chat_id, *message_thread_id, None, &rendered)
                .await?;
            let _ = state.audit.log(
                "watcher_notify",
                ToolSideEffect::Read,
                &definition.id,
                outcomes::ALLOWED,
                &format!("workspace_id={}", definition.workspace_id),
                rendered.len() as u64,
            );
            Ok(None)
        }
        WatchAction::ProposeTool {
            tool_name,
            arguments,
            chat_id,
            message_thread_id,
        } => {
            // Do not create an unreachable pending permission when no approval
            // queue/paired-desktop transport exists.
            let bridge = state
                .telegram
                .as_deref()
                .ok_or_else(|| "Telegram bridge is not configured".to_string())?;
            let session_id = format!("watcher-{}", definition.id);
            ensure_session_host(
                state,
                &definition.workspace_id,
                &session_id,
                SessionOrigin::Watcher,
            )
            .await
            .map_err(|status| format!("watch action session failed: {status}"))?;

            let (events, side_effect) = {
                let mut sessions = state.sessions.lock().await;
                let session = sessions
                    .get_mut(&session_id)
                    .ok_or_else(|| "watcher session disappeared".to_string())?;
                let side_effect = session.host.side_effect_for(tool_name);
                if side_effect == ToolSideEffect::Read {
                    return Err(
                        "propose_tool requires a write-classified tool; Read actions are not proposals"
                            .into(),
                    );
                }
                let events = session
                    .host
                    .execute(tool_name, arguments, None)
                    .await
                    .map_err(|_| "watcher tool proposal failed".to_string())?
                    .events;
                (events, side_effect)
            };

            let proposal = events
                .iter()
                .find_map(|event| {
                    permission_proposal_from_event(
                        event,
                        definition,
                        &session_id,
                        side_effect,
                        *chat_id,
                        *message_thread_id,
                    )
                })
                .ok_or_else(|| {
                    "write action did not produce a permission proposal; execution refused"
                        .to_string()
                })?;
            let request_id = proposal.request_id.clone();
            bridge.queue_proposal(proposal)?;
            let _ = state.audit.log(
                "watcher_permission_proposal",
                side_effect,
                &definition.id,
                outcomes::PENDING,
                &format!(
                    "origin=watcher workspace_id={} event_key={}",
                    definition.workspace_id, observation.event_key
                ),
                0,
            );
            bridge
                .send_text(
                    *chat_id,
                    *message_thread_id,
                    None,
                    &format!(
                        "Watcher `{}` proposed `{}`. A paired desktop must approve request `{}`.",
                        definition.id, tool_name, request_id
                    ),
                )
                .await?;
            Ok(Some(request_id))
        }
    }
}

async fn run_watcher_record(
    state: &AppState,
    record: &WatcherRecord,
    now: i64,
) -> Result<WatcherRunReport, String> {
    let definition = &record.definition;
    if !definition.enabled {
        return Ok(WatcherRunReport {
            watcher_id: definition.id.clone(),
            outcome: "disabled".into(),
            event_key: None,
            request_id: None,
        });
    }
    if !workspace_watchers_enabled(state, &definition.workspace_id)
        .map_err(|status| format!("watcher workspace unavailable: {status}"))?
    {
        state
            .watchers
            .record_run(&definition.id, now, None, "workspace_disabled")?;
        return Ok(WatcherRunReport {
            watcher_id: definition.id.clone(),
            outcome: "workspace_disabled".into(),
            event_key: None,
            request_id: None,
        });
    }

    let observation = match observe_watcher(state, definition, now).await {
        Ok(observation) => observation,
        Err(error) => {
            state
                .watchers
                .record_run(&definition.id, now, None, "source_error")?;
            return Err(error);
        }
    };
    if !watch_condition_matches(&definition.condition, &observation) {
        state.watchers.record_run(
            &definition.id,
            now,
            Some(&observation.event_key),
            "condition_not_met",
        )?;
        return Ok(WatcherRunReport {
            watcher_id: definition.id.clone(),
            outcome: "condition_not_met".into(),
            event_key: Some(observation.event_key),
            request_id: None,
        });
    }
    if !state
        .watchers
        .claim_event(&definition.id, &observation.event_key, now)?
    {
        return Ok(WatcherRunReport {
            watcher_id: definition.id.clone(),
            outcome: "duplicate".into(),
            event_key: Some(observation.event_key),
            request_id: None,
        });
    }

    let request_id = match execute_watch_action(state, definition, &observation).await {
        Ok(request_id) => request_id,
        Err(error) => {
            state.watchers.record_run(
                &definition.id,
                now,
                Some(&observation.event_key),
                "action_error",
            )?;
            return Err(error);
        }
    };
    let outcome = if request_id.is_some() {
        "proposed"
    } else {
        "notified"
    };
    state.watchers.record_fired(&definition.id, now, outcome)?;
    Ok(WatcherRunReport {
        watcher_id: definition.id.clone(),
        outcome: outcome.into(),
        event_key: Some(observation.event_key),
        request_id,
    })
}

async fn watcher_scheduler_tick(state: &AppState, now: i64) -> Result<usize, String> {
    let records = state.watchers.list_enabled()?;
    let mut ran = 0;
    for record in records
        .iter()
        .filter(|record| watchers::is_due(record, now))
    {
        match run_watcher_record(state, record, now).await {
            Ok(_) => ran += 1,
            Err(error) => tracing::warn!(
                watcher_id = %record.definition.id,
                error = %error,
                "watcher tick failed closed"
            ),
        }
    }
    Ok(ran)
}

async fn watcher_scheduler_loop(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        interval.tick().await;
        if let Err(error) = watcher_scheduler_tick(&state, unix_timestamp_i64()).await {
            tracing::warn!(error = %error, "watcher scheduler tick failed");
        }
    }
}

#[derive(Deserialize)]
struct WatchersQuery {
    workspace_id: String,
}

async fn watchers_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<WatchersQuery>,
) -> Result<impl IntoResponse, StatusCode> {
    authorize(&headers, &state, &query.workspace_id)?;
    let records = state
        .watchers
        .list_workspace(&query.workspace_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(serde_json::json!({
        "workspace_id": query.workspace_id,
        "workspace_enabled": workspace_watchers_enabled(&state, &query.workspace_id)?,
        "watchers": records,
    })))
}

async fn watchers_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(watcher_id): AxumPath<String>,
) -> Result<impl IntoResponse, StatusCode> {
    let record = state
        .watchers
        .get(&watcher_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    authorize(&headers, &state, &record.definition.workspace_id)?;
    Ok(Json(record))
}

async fn watchers_put(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(watcher_id): AxumPath<String>,
    Json(mut definition): Json<WatcherDefinition>,
) -> Result<impl IntoResponse, StatusCode> {
    if watcher_id.trim().is_empty()
        || (!definition.id.trim().is_empty() && definition.id != watcher_id)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    definition.id = watcher_id;
    authorize(&headers, &state, &definition.workspace_id)?;
    require_admin(
        &headers,
        &state,
        &definition.workspace_id,
        "watcher_put",
        &definition.id,
    )?;
    workspace_watchers_enabled(&state, &definition.workspace_id)?;
    definition.validate().map_err(|_| StatusCode::BAD_REQUEST)?;
    if let Some(existing) = state
        .watchers
        .get(&definition.id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        if existing.definition.workspace_id != definition.workspace_id {
            return Err(StatusCode::CONFLICT);
        }
    }
    state
        .watchers
        .put(&definition, unix_timestamp_i64())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let _ = state.audit.log(
        "watcher_put",
        ToolSideEffect::SoftWrite,
        &definition.id,
        outcomes::ALLOWED,
        &format!("workspace_id={}", definition.workspace_id),
        0,
    );
    Ok((StatusCode::OK, Json(definition)))
}

async fn watchers_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(watcher_id): AxumPath<String>,
) -> Result<impl IntoResponse, StatusCode> {
    let record = state
        .watchers
        .get(&watcher_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    authorize(&headers, &state, &record.definition.workspace_id)?;
    require_admin(
        &headers,
        &state,
        &record.definition.workspace_id,
        "watcher_delete",
        &watcher_id,
    )?;
    let deleted = state
        .watchers
        .delete(&watcher_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if !deleted {
        return Err(StatusCode::NOT_FOUND);
    }
    let _ = state.audit.log(
        "watcher_delete",
        ToolSideEffect::SoftWrite,
        &watcher_id,
        outcomes::ALLOWED,
        &format!("workspace_id={}", record.definition.workspace_id),
        0,
    );
    Ok(StatusCode::NO_CONTENT)
}

async fn watchers_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(watcher_id): AxumPath<String>,
) -> Result<impl IntoResponse, StatusCode> {
    let record = state
        .watchers
        .get(&watcher_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::NOT_FOUND)?;
    authorize(&headers, &state, &record.definition.workspace_id)?;
    require_admin(
        &headers,
        &state,
        &record.definition.workspace_id,
        "watcher_run",
        &watcher_id,
    )?;
    let report = run_watcher_record(&state, &record, unix_timestamp_i64())
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;
    Ok(Json(report))
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
        .route("/v1/sync/membership", get(sync_membership))
        .route("/v1/sync/changes_since", post(sync_changes_since))
        .route("/v1/sync/apply", post(sync_apply))
        .route("/v1/chat/telegram/webhook", post(telegram_webhook))
        .route("/v1/chat/pair", post(chat_pair))
        .route("/v1/chat/approvals", get(chat_approvals))
        .route("/v1/chat/approvals/respond", post(chat_approval_respond))
        .route("/v1/watchers", get(watchers_list))
        .route(
            "/v1/watchers/{watcher_id}",
            get(watchers_get).put(watchers_put).delete(watchers_delete),
        )
        .route("/v1/watchers/{watcher_id}/run", post(watchers_run))
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
                watchers_enabled: true,
                connectors: Vec::new(),
                mcp_env: HashMap::new(),
                keys: legacy_hashes.iter().map(|h| (*h, Role::Admin)).collect(),
            });
        }
    }

    // Normalize opted-in Atlassian Rovo MCP presets and resolve API tokens
    // directly from the OS keychain into child-only environment maps.
    let secret_store = KeychainSecretStore::new();
    for workspace in &mut resolved {
        let prepared =
            match jira::prepare_connectors(&workspace.connectors, &secret_store, &SystemResolver) {
                Ok(prepared) => prepared,
                Err(message) => {
                    eprintln!("{message}");
                    std::process::exit(2);
                }
            };
        workspace.connectors = prepared.connectors;
        workspace.mcp_env = prepared.mcp_env;
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

    if let Some(telegram) = server_config.as_ref().and_then(|c| c.telegram.as_ref()) {
        for user in &telegram.users {
            if !resolved
                .iter()
                .any(|workspace| workspace.id == user.workspace_id)
            {
                eprintln!(
                    "Telegram user {} references unknown workspace `{}`",
                    user.user_id, user.workspace_id
                );
                std::process::exit(2);
            }
        }
    }

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

    let telegram =
        match load_telegram_bridge(server_config.as_ref().and_then(|c| c.telegram.as_ref())) {
            Ok(bridge) => bridge,
            Err(message) => {
                eprintln!("{message}");
                std::process::exit(2);
            }
        };
    if telegram.is_some() {
        tracing::info!("Telegram bridge configured (secrets resolved from keychain)");
    }

    let mut state = match build_state(resolved, &data_dir, provider) {
        Ok(s) => s,
        Err(msg) => {
            eprintln!("{msg}");
            std::process::exit(2);
        }
    };
    state.telegram = telegram;

    let watcher_state = state.clone();
    tokio::spawn(async move {
        watcher_scheduler_loop(watcher_state).await;
    });
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
                watchers_enabled: true,
                connectors: Vec::new(),
                mcp_env: HashMap::new(),
                keys: ws_keys.remove("ws-a").unwrap_or_default(),
            },
            ResolvedWorkspace {
                id: "ws-b".into(),
                roots: vec![root.join("b")],
                watchers_enabled: true,
                connectors: Vec::new(),
                mcp_env: HashMap::new(),
                keys: ws_keys.remove("ws-b").unwrap_or_default(),
            },
        ];
        build_state(resolved, &root.join(".server-data"), provider).unwrap()
    }

    fn telegram_test_state(
        root: PathBuf,
        role: Role,
        allow_soft_write: bool,
    ) -> (AppState, telegram::CapturedMessages) {
        let mut state = test_state_with_roles(
            root,
            &[
                ("admin-k", "ws-a", Role::Admin),
                ("member-k", "ws-a", Role::Member),
            ],
            None,
        );
        let config = TelegramConfig {
            bot_token_ref: "telegram/default/bot_token".into(),
            webhook_secret_ref: "telegram/default/webhook_secret".into(),
            users: vec![telegram::TelegramUserConfig {
                user_id: 42,
                workspace_id: "ws-a".into(),
                role,
                allow_soft_write,
            }],
        };
        let (bridge, sent) = TelegramBridge::new_capture(&config, "webhook-secret").unwrap();
        state.telegram = Some(Arc::new(bridge));
        (state, sent)
    }

    fn telegram_update(text: &str) -> TelegramUpdate {
        TelegramUpdate {
            update_id: 1,
            message: Some(TelegramMessage {
                message_id: 9,
                chat: telegram::TelegramChat { id: -1001 },
                from_user: Some(telegram::TelegramUser { id: 42 }),
                message_thread_id: Some(7),
                text: Some(text.into()),
            }),
        }
    }

    fn jira_fixture_paths() -> Option<(PathBuf, PathBuf)> {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/jira_mcp_server.py");
        if !script.is_file() {
            return None;
        }
        let python = std::env::var_os("PYTHON")
            .map(PathBuf::from)
            .or_else(|| {
                for name in ["python3", "python", "python.exe"] {
                    let path = std::env::var_os("PATH")?;
                    for directory in std::env::split_paths(&path) {
                        let candidate = directory.join(name);
                        if candidate.is_file() {
                            return std::fs::canonicalize(&candidate).ok().or(Some(candidate));
                        }
                    }
                }
                None
            })
            .filter(|path| path.is_absolute())?;
        Some((python, script))
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

    fn sync_apply_req(key: &str, workspace_id: &str, mutation: SyncMutation) -> Request<Body> {
        let body = serde_json::json!({
            "workspace_id": workspace_id,
            "mutations": [{
                "mutation_id": mutation.mutation_id,
                "origin_node": mutation.origin_node,
                "client_updated_at": mutation.client_updated_at,
                "client_rev": mutation.client_rev,
                "base_rev": mutation.base_rev,
                "operation": mutation.operation,
            }],
        });
        Request::builder()
            .method("POST")
            .uri("/v1/sync/apply")
            .header("authorization", format!("Bearer {key}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn test_sync_mutation(
        mutation_id: &str,
        origin_node: &str,
        client_updated_at: i64,
        client_rev: i64,
        base_rev: Option<i64>,
        operation: MemoryWriteOp,
    ) -> SyncMutation {
        SyncMutation {
            mutation_id: mutation_id.into(),
            origin_node: origin_node.into(),
            client_updated_at,
            client_rev,
            base_rev,
            operation,
        }
    }

    fn sync_changes_req(
        key: &str,
        workspace_id: &str,
        cursor: Option<SyncCursor>,
        limit: usize,
    ) -> Request<Body> {
        let body = serde_json::json!({
            "workspace_id": workspace_id,
            "cursor": cursor,
            "limit": limit,
        });
        Request::builder()
            .method("POST")
            .uri("/v1/sync/changes_since")
            .header("authorization", format!("Bearer {key}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    fn workspace_draft(content: &str) -> MemoryDraft {
        let mut draft = MemoryDraft::new(cd_core::memory::Kind::ProjectNote, content);
        draft.scope = Scope::Workspace;
        draft
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
            [telegram]
            bot_token_ref = "telegram/default/bot_token"
            webhook_secret_ref = "telegram/default/webhook_secret"
            users = [
              { user_id = 42, workspace_id = "team-a", role = "admin", allow_soft_write = true },
            ]
            [[workspaces]]
            id = "team-a"
            roots = ["/tmp/team-a"]
            keys = [
              { key = "admin-token", role = "admin" },
              { key = "member-token", role = "member" },
            ]
            [[workspaces.connectors]]
            id = "jira"
            kind = "mcp"
            enabled = true
            [workspaces.connectors.settings]
            preset = "atlassian_rovo"
            command = "/opt/local/bin/mcp-remote"
            api_key_ref = "connector/jira/api_key"
            auth_kind = "service_bearer"
        "#;
        let cfg: ServerConfig = toml::from_str(toml_src).unwrap();
        assert_eq!(cfg.workspaces.len(), 1);
        let resolved = resolve_config_workspaces(&cfg).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].keys.len(), 2);
        assert!(resolved[0].watchers_enabled);
        assert_eq!(resolved[0].connectors.len(), 1);
        assert_eq!(
            resolved[0].connectors[0].settings["preset"],
            "atlassian_rovo"
        );
        assert_eq!(resolved[0].keys[0].1, Role::Admin);
        assert_eq!(resolved[0].keys[1].1, Role::Member);
        let telegram = cfg.telegram.as_ref().unwrap();
        assert_eq!(telegram.users.len(), 1);
        assert!(telegram.users[0].allow_soft_write);
    }

    #[test]
    fn server_workspace_connectors_reject_embedded_secrets() {
        let cfg = ServerConfig {
            data_dir: None,
            workspaces: vec![WsConfig {
                id: "team-a".into(),
                roots: vec![PathBuf::from("/tmp/team-a")],
                watchers_enabled: true,
                connectors: vec![ConnectorConfig {
                    id: "jira".into(),
                    kind: "mcp".into(),
                    enabled: true,
                    settings: serde_json::json!({
                        "token": "ATATT3xFfGF0example-secret-that-must-not-be-configured"
                    }),
                }],
                keys: Vec::new(),
            }],
            telegram: None,
        };
        let error = resolve_config_workspaces(&cfg).err().unwrap();
        assert!(error.contains("raw secret"), "{error}");
        assert!(error.contains("keychain"), "{error}");
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
    async fn sync_membership_enforces_roles_and_workspace_isolation() {
        let dir = tempdir().unwrap();
        let state = test_state_with_roles(
            dir.path().to_path_buf(),
            &[
                ("member-a", "ws-a", Role::Member),
                ("admin-b", "ws-b", Role::Admin),
            ],
            None,
        );
        let app = build_app(state);

        let membership = Request::builder()
            .uri("/v1/sync/membership")
            .header("authorization", "Bearer member-a")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(membership).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["workspaces"].as_array().unwrap().len(), 1, "{body}");
        assert_eq!(body["workspaces"][0]["workspace_id"], "ws-a");
        assert_eq!(body["workspaces"][0]["role"], "member");

        let response = app
            .clone()
            .oneshot(sync_changes_req("member-a", "ws-b", None, 10))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = app
            .oneshot(sync_apply_req(
                "member-a",
                "ws-a",
                test_sync_mutation(
                    "member-write",
                    "laptop-a",
                    now_unix_secs(),
                    1,
                    None,
                    MemoryWriteOp::Insert(workspace_draft("must not persist")),
                ),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn sync_apply_pull_cursor_and_restart_are_idempotent() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let operation = MemoryWriteOp::Insert(workspace_draft("server truth"));
        let state = test_state_with_roles(root.clone(), &[("admin", "ws-a", Role::Admin)], None);
        let app = build_app(state);

        let response = app
            .clone()
            .oneshot(sync_apply_req(
                "admin",
                "ws-a",
                test_sync_mutation(
                    "mutation-1",
                    "desktop-a",
                    now_unix_secs(),
                    1,
                    None,
                    operation.clone(),
                ),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let applied = json_body(response).await;
        assert_eq!(applied["results"][0]["status"], "applied", "{applied}");
        assert_eq!(applied["results"][0]["record"]["workspace_id"], "ws-a");
        assert_eq!(applied["results"][0]["record"]["origin_node"], "desktop-a");
        let record_id = applied["results"][0]["record"]["id"]
            .as_str()
            .unwrap()
            .to_string();

        let response = app
            .clone()
            .oneshot(sync_changes_req("admin", "ws-a", None, 1))
            .await
            .unwrap();
        let page = json_body(response).await;
        assert_eq!(page["records"].as_array().unwrap().len(), 1, "{page}");
        assert_eq!(page["records"][0]["id"], record_id);
        assert_eq!(page["records"][0]["origin_node"], "desktop-a");
        let cursor: SyncCursor = serde_json::from_value(page["next_cursor"].clone()).unwrap();
        let response = app
            .clone()
            .oneshot(sync_changes_req("admin", "ws-a", Some(cursor), 1))
            .await
            .unwrap();
        let next_page = json_body(response).await;
        assert!(next_page["records"].as_array().unwrap().is_empty());

        let response = app
            .oneshot(sync_apply_req(
                "admin",
                "ws-a",
                test_sync_mutation(
                    "mutation-1",
                    "desktop-a",
                    now_unix_secs(),
                    1,
                    None,
                    operation.clone(),
                ),
            ))
            .await
            .unwrap();
        let duplicate = json_body(response).await;
        assert_eq!(duplicate["results"][0]["status"], "duplicate");
        assert_eq!(duplicate["results"][0]["record"]["id"], record_id);

        let restarted = test_state_with_roles(root, &[("admin", "ws-a", Role::Admin)], None);
        let response = build_app(restarted)
            .oneshot(sync_apply_req(
                "admin",
                "ws-a",
                test_sync_mutation(
                    "mutation-1",
                    "desktop-a",
                    now_unix_secs(),
                    1,
                    None,
                    operation,
                ),
            ))
            .await
            .unwrap();
        let duplicate_after_restart = json_body(response).await;
        assert_eq!(duplicate_after_restart["results"][0]["status"], "duplicate");
        assert_eq!(
            duplicate_after_restart["results"][0]["record"]["id"],
            record_id
        );
    }

    #[tokio::test]
    async fn sync_rejects_personal_and_preserves_conflict_and_supersession() {
        let dir = tempdir().unwrap();
        let state = test_state_with_roles(
            dir.path().to_path_buf(),
            &[("admin", "ws-a", Role::Admin)],
            None,
        );
        let app = build_app(state);

        let mut personal = workspace_draft("device only");
        personal.scope = Scope::Personal;
        let response = app
            .clone()
            .oneshot(sync_apply_req(
                "admin",
                "ws-a",
                test_sync_mutation(
                    "personal-1",
                    "desktop-a",
                    now_unix_secs(),
                    1,
                    None,
                    MemoryWriteOp::Insert(personal),
                ),
            ))
            .await
            .unwrap();
        let rejected = json_body(response).await;
        assert_eq!(rejected["results"][0]["status"], "rejected");
        assert!(rejected["results"][0]["detail"]
            .as_str()
            .unwrap()
            .contains("device-local"));

        let response = app
            .clone()
            .oneshot(sync_apply_req(
                "admin",
                "ws-a",
                test_sync_mutation(
                    "insert-1",
                    "desktop-a",
                    now_unix_secs(),
                    1,
                    None,
                    MemoryWriteOp::Insert(workspace_draft("original")),
                ),
            ))
            .await
            .unwrap();
        let inserted = json_body(response).await;
        let old_id =
            uuid::Uuid::parse_str(inserted["results"][0]["record"]["id"].as_str().unwrap())
                .unwrap();

        let stale_update = MemoryWriteOp::UpdateMeta {
            id: old_id,
            tags: Some(vec!["stale".into()]),
            pinned: None,
            valid_to: None,
            status: None,
        };
        let response = app
            .clone()
            .oneshot(sync_apply_req(
                "admin",
                "ws-a",
                test_sync_mutation("stale-1", "desktop-b", 0, 0, None, stale_update),
            ))
            .await
            .unwrap();
        let conflict = json_body(response).await;
        assert_eq!(conflict["results"][0]["status"], "conflict");
        assert_eq!(
            conflict["results"][0]["server_record"]["id"],
            old_id.to_string()
        );

        let winning_update = MemoryWriteOp::UpdateMeta {
            id: old_id,
            tags: Some(vec!["confirmed".into()]),
            pinned: None,
            valid_to: None,
            status: None,
        };
        let response = app
            .clone()
            .oneshot(sync_apply_req(
                "admin",
                "ws-a",
                test_sync_mutation(
                    "update-1",
                    "desktop-b",
                    now_unix_secs(),
                    2,
                    Some(1),
                    winning_update,
                ),
            ))
            .await
            .unwrap();
        let updated = json_body(response).await;
        assert_eq!(updated["results"][0]["status"], "applied");
        let updated_rev = updated["results"][0]["record"]["rev"].as_i64().unwrap();

        let replacement = workspace_draft("replacement");
        let response = app
            .clone()
            .oneshot(sync_apply_req(
                "admin",
                "ws-a",
                test_sync_mutation(
                    "supersede-1",
                    "desktop-b",
                    now_unix_secs(),
                    updated_rev + 1,
                    Some(updated_rev),
                    MemoryWriteOp::Supersede {
                        old: old_id,
                        new: replacement,
                    },
                ),
            ))
            .await
            .unwrap();
        let superseded = json_body(response).await;
        assert_eq!(superseded["results"][0]["status"], "applied");
        assert_eq!(
            superseded["results"][0]["record"]["supersedes"],
            old_id.to_string()
        );

        let response = app
            .oneshot(sync_changes_req("admin", "ws-a", None, 20))
            .await
            .unwrap();
        let changes = json_body(response).await;
        let records = changes["records"].as_array().unwrap();
        assert_eq!(records.len(), 2, "{changes}");
        let old = records
            .iter()
            .find(|record| record["id"] == old_id.to_string())
            .unwrap();
        assert_eq!(old["status"], "superseded");
        assert!(old["superseded_by"].as_str().is_some());
        assert_eq!(old["origin_node"], "desktop-b");
    }

    #[tokio::test]
    async fn legacy_publish_and_permissioned_tool_writes_feed_sync_pull() {
        use http_body_util::BodyExt;

        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let state = test_state_with_roles(root, &[("admin", "ws-a", Role::Admin)], None);
        let app = build_app(state);

        let response = app
            .clone()
            .oneshot(publish_req(
                "admin",
                "ws-a",
                "Legacy",
                "compatibility write",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(sync_changes_req("admin", "ws-a", None, 20))
            .await
            .unwrap();
        let first_pull = json_body(response).await;
        assert_eq!(first_pull["records"].as_array().unwrap().len(), 1);
        assert_eq!(first_pull["records"][0]["content"], "compatibility write");
        let cursor: SyncCursor = serde_json::from_value(first_pull["next_cursor"].clone()).unwrap();

        let prompt = Request::builder()
            .method("POST")
            .uri("/v1/session/prompt")
            .header("authorization", "Bearer admin")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{
                  "workspace_id":"ws-a",
                  "session_id":"sync-tool",
                  "invoke_tool":{
                    "name":"save_memory",
                    "arguments":{
                      "kind":"decision",
                      "title":"Tool write",
                      "content":"permissioned authoritative write",
                      "scope":"workspace"
                    }
                  }
                }"#,
            ))
            .unwrap();
        let response = app.clone().oneshot(prompt).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let request_id = body["events"]
            .as_array()
            .unwrap()
            .iter()
            .find(|event| event["kind"] == "permission_required")
            .and_then(|event| event["payload"]["request_id"].as_str())
            .unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/permission/respond")
                    .header("authorization", "Bearer admin")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"workspace_id":"ws-a","session_id":"sync-tool","request_id":"{request_id}","decision":"allow_once","tool_name":"save_memory","arguments":{{}}}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(sync_changes_req("admin", "ws-a", Some(cursor), 20))
            .await
            .unwrap();
        let changes = json_body(response).await;
        let records = changes["records"].as_array().unwrap();
        assert_eq!(records.len(), 1, "{changes}");
        assert!(records
            .iter()
            .all(|record| { record["scope"] == "workspace" && record["workspace_id"] == "ws-a" }));
        assert!(records
            .iter()
            .any(|record| record["content"] == "permissioned authoritative write"));
    }

    #[test]
    fn legacy_non_uuid_import_id_is_stable() {
        assert_eq!(
            legacy_memory_id("ws-a", "old-note"),
            legacy_memory_id("ws-a", "old-note")
        );
        assert_ne!(
            legacy_memory_id("ws-a", "old-note"),
            legacy_memory_id("ws-b", "old-note")
        );
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
    async fn telegram_message_research_event_stream_reply_and_audit_round_trip() {
        let dir = tempdir().unwrap();
        let (state, sent) = telegram_test_state(dir.path().to_path_buf(), Role::Member, false);
        let audit_path = state.audit.path().to_path_buf();

        process_telegram_update(&state, telegram_update("alpha"))
            .await
            .unwrap();

        {
            let sent = sent.lock().unwrap();
            assert_eq!(sent.len(), 1, "one Telegram reply expected: {sent:?}");
            assert_eq!(sent[0].chat_id, -1001);
            assert_eq!(sent[0].message_thread_id, Some(7));
            assert!(
                sent[0].text.to_ascii_lowercase().contains("alpha"),
                "cd.v1 research reply missing query hit: {sent:?}"
            );
        }

        let sessions = state.sessions.lock().await;
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions.values().next().unwrap().origin,
            SessionOrigin::Telegram
        );
        drop(sessions);

        let audit = fs::read_to_string(&audit_path).unwrap();
        assert!(audit.contains("telegram_message"), "{audit}");
        assert!(audit.contains("origin=telegram"), "{audit}");
        assert!(
            !audit.contains("\"detail\":\"alpha\""),
            "message text leaked to audit: {audit}"
        );
        state.audit.verify_chain().unwrap();
    }

    #[tokio::test]
    async fn telegram_softwrite_needs_explicit_configured_admin_phrase() {
        use cd_core::memory::{MemoryStore, SqliteMemoryStore};

        let dir = tempdir().unwrap();
        let (state, sent) = telegram_test_state(dir.path().to_path_buf(), Role::Admin, true);
        let bridge = state.telegram.as_deref().unwrap();
        let store = {
            let workspaces = state.workspaces.lock().unwrap();
            workspaces.get("ws-a").unwrap().sync_memory.clone()
        };

        process_telegram_update(&state, telegram_update("/save Launch note\nShip Friday"))
            .await
            .unwrap();
        let proposals = bridge.proposals_for_workspace("ws-a").unwrap();
        assert_eq!(proposals.len(), 1);
        let proposal = proposals[0].clone();
        assert_eq!(proposal.side_effect, ToolSideEffect::SoftWrite);
        assert_eq!(proposal.target, "mem://workspace/new");
        assert!(
            store.changes_since(0).unwrap().is_empty(),
            "authoritative store must remain unchanged before explicit confirmation"
        );
        let legacy_store =
            SqliteMemoryStore::open(dir.path().join("a/.contextdesk/memory/memory.sqlite"))
                .unwrap();
        assert!(
            legacy_store.changes_since(0).unwrap().is_empty(),
            "Telegram must not write to the replaced workspace-local store"
        );
        assert!(
            sent.lock().unwrap()[0].text.contains("/approve_soft"),
            "in-channel confirmation instruction missing"
        );

        // Arbitrary chat assent is model input, never a permission grant.
        process_telegram_update(&state, telegram_update("yes"))
            .await
            .unwrap();
        assert!(bridge.proposal(&proposal.request_id).unwrap().is_some());
        assert!(store.changes_since(0).unwrap().is_empty());

        process_telegram_update(
            &state,
            telegram_update(&format!("/approve_soft {} WRITE", proposal.request_id)),
        )
        .await
        .unwrap();
        assert!(bridge.proposal(&proposal.request_id).unwrap().is_none());
        let records = store.changes_since(0).unwrap();
        assert_eq!(
            records.len(),
            1,
            "SoftWrite missing from authoritative store: {records:?}"
        );
        assert_eq!(records[0].title, "Launch note");
        assert_eq!(records[0].content, "Ship Friday");
        assert_eq!(records[0].workspace_id.as_deref(), Some("ws-a"));
        assert!(
            legacy_store.changes_since(0).unwrap().is_empty(),
            "approved SoftWrite must only land in the authoritative store"
        );
    }

    #[tokio::test]
    async fn telegram_hardwrite_escalates_and_only_paired_desktop_can_confirm() {
        use cd_core::connectors::{ConnectorExecutor, RegisteredTool};
        use cd_core::tools::ToolSpec;

        let dir = tempdir().unwrap();
        let (state, sent) = telegram_test_state(dir.path().to_path_buf(), Role::Admin, true);
        let bridge = state.telegram.as_deref().unwrap();
        let identity = bridge.identity(42).unwrap();
        let message = telegram_update("ignored").message.unwrap();
        let session_id = bridge
            .session_id(message.chat.id, message.message_thread_id)
            .unwrap();
        ensure_session_host(&state, "ws-a", &session_id, SessionOrigin::Telegram)
            .await
            .unwrap();
        {
            let mut sessions = state.sessions.lock().await;
            sessions
                .get_mut(&session_id)
                .unwrap()
                .host
                .register_tool(RegisteredTool {
                    spec: ToolSpec {
                        name: "remote_publish".into(),
                        description: "test HardWrite".into(),
                        side_effect: ToolSideEffect::HardWrite,
                        parameters: serde_json::json!({"type":"object"}),
                    },
                    exec: ConnectorExecutor::Stub {
                        detail: "remote publish executed".into(),
                    },
                });
        }

        let events = run_telegram_action(
            &state,
            bridge,
            &identity,
            &message,
            &session_id,
            TelegramAction::InvokeTool {
                name: "remote_publish".into(),
                arguments: serde_json::json!({}),
            },
        )
        .await
        .unwrap();
        let request_id = events
            .iter()
            .find_map(|event| match event {
                StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
            .expect("HardWrite must emit permission_required");
        let proposal = bridge.proposal(&request_id).unwrap().unwrap();
        assert_eq!(proposal.side_effect, ToolSideEffect::HardWrite);
        assert!(!proposal.trusted_desktop_connected);
        assert!(
            sent.lock()
                .unwrap()
                .last()
                .unwrap()
                .text
                .contains("Chat cannot approve"),
            "HardWrite escalation notice missing"
        );

        // Even the configured chat admin + exact SoftWrite phrase cannot approve HardWrite.
        process_telegram_update(
            &state,
            telegram_update(&format!("/approve_soft {request_id} WRITE")),
        )
        .await
        .unwrap();
        assert!(bridge.proposal(&request_id).unwrap().is_some());

        let app = build_app(state.clone());
        // The generic permission endpoint is also barred for Telegram sessions.
        let generic = Request::builder()
            .method("POST")
            .uri("/v1/permission/respond")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"workspace_id":"ws-a","session_id":"{session_id}","request_id":"{request_id}","decision":"allow_once","typed":"WRITE"}}"#
            )))
            .unwrap();
        let response = app.clone().oneshot(generic).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(bridge.proposal(&request_id).unwrap().is_some());

        let member_pair = Request::builder()
            .method("POST")
            .uri("/v1/chat/pair")
            .header("authorization", "Bearer member-k")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"workspace_id":"ws-a","device_label":"Untrusted member"}"#,
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(member_pair).await.unwrap().status(),
            StatusCode::FORBIDDEN,
            "member API key must not create a trusted desktop pairing"
        );

        let pair = Request::builder()
            .method("POST")
            .uri("/v1/chat/pair")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"workspace_id":"ws-a","device_label":"Desktop test"}"#,
            ))
            .unwrap();
        let response = app.clone().oneshot(pair).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let paired = json_body(response).await;
        let pairing_id = paired["pairing_id"].as_str().unwrap();

        let wrong_phrase = Request::builder()
            .method("POST")
            .uri("/v1/chat/approvals/respond")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"workspace_id":"ws-a","pairing_id":"{pairing_id}","request_id":"{request_id}","decision":"allow_once","typed":"NOPE"}}"#
            )))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(wrong_phrase).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        assert!(
            bridge.proposal(&request_id).unwrap().is_some(),
            "wrong type-to-confirm must leave the HardWrite proposal retryable"
        );

        let approve = Request::builder()
            .method("POST")
            .uri("/v1/chat/approvals/respond")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"workspace_id":"ws-a","pairing_id":"{pairing_id}","request_id":"{request_id}","decision":"allow_once","typed":"WRITE"}}"#
            )))
            .unwrap();
        let response = app.oneshot(approve).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let approved = json_body(response).await;
        assert!(
            approved["events"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["kind"] == "tool" && event["payload"]["ok"] == true),
            "paired desktop did not execute HardWrite stub: {approved}"
        );
        assert!(bridge.proposal(&request_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn telegram_webhook_requires_telegram_secret_header() {
        let dir = tempdir().unwrap();
        let (state, sent) = telegram_test_state(dir.path().to_path_buf(), Role::Member, false);
        let app = build_app(state);
        let body = serde_json::to_vec(&telegram_update("alpha")).unwrap();

        let missing = Request::builder()
            .method("POST")
            .uri("/v1/chat/telegram/webhook")
            .header("content-type", "application/json")
            .body(Body::from(body.clone()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(missing).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );

        let valid = Request::builder()
            .method("POST")
            .uri("/v1/chat/telegram/webhook")
            .header("content-type", "application/json")
            .header("x-telegram-bot-api-secret-token", "webhook-secret")
            .body(Body::from(body.clone()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(valid).await.unwrap().status(),
            StatusCode::OK
        );
        for _ in 0..100 {
            if !sent.lock().unwrap().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(sent.lock().unwrap().len(), 1, "webhook task did not reply");

        // Telegram retry of the same update id is acknowledged but not re-run.
        let duplicate = Request::builder()
            .method("POST")
            .uri("/v1/chat/telegram/webhook")
            .header("content-type", "application/json")
            .header("x-telegram-bot-api-secret-token", "webhook-secret")
            .body(Body::from(body))
            .unwrap();
        assert_eq!(
            app.oneshot(duplicate).await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(
            sent.lock().unwrap().len(),
            1,
            "duplicate update was processed"
        );
    }

    #[tokio::test]
    async fn jira_mcp_read_uses_keychain_and_create_requires_hardwrite_confirmation() {
        use cd_core::keychain_store::MemorySecretStore;
        use cd_core::ssrf::MapResolver;
        use std::net::{IpAddr, Ipv4Addr};

        let Some((python, script)) = jira_fixture_paths() else {
            eprintln!("skip Jira MCP fixture: no absolute Python interpreter on PATH");
            return;
        };
        let secrets = MemorySecretStore::new();
        secrets
            .set("connector/jira/api_key", "fixture-service-token")
            .unwrap();
        let config = ConnectorConfig {
            id: "jira".into(),
            kind: "mcp".into(),
            enabled: true,
            settings: serde_json::json!({
                "preset": jira::ATLASSIAN_ROVO_PRESET,
                "command": python,
                "api_key_ref": "connector/jira/api_key",
                "auth_kind": "service_bearer"
            }),
        };
        let resolver = MapResolver::from_pairs([(
            "mcp.atlassian.com",
            vec![IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34))],
        )]);
        let mut prepared = jira::prepare_connectors(&[config], &secrets, &resolver).unwrap();
        // The production preset launches the locally installed mcp-remote
        // executable against the fixed official endpoint. The hermetic test
        // substitutes only its argv with a Jira-shaped stdio fixture.
        prepared.connectors[0].settings["args"] = serde_json::json!([script.to_string_lossy()]);

        let dir = tempdir().unwrap();
        let state = test_state(dir.path().to_path_buf(), &[]);
        {
            let mut workspaces = state.workspaces.lock().unwrap();
            let workspace = workspaces.get_mut("ws-a").unwrap();
            workspace.connectors = Arc::new(prepared.connectors);
            workspace.mcp_env = Arc::new(prepared.mcp_env);
        }
        ensure_session_host(
            &state,
            "ws-a",
            "jira-fixture-session",
            SessionOrigin::TrustedClient,
        )
        .await
        .unwrap();
        let mut sessions = state.sessions.lock().await;
        let host = &mut sessions.get_mut("jira-fixture-session").unwrap().host;

        let read_name = "mcp__jira__getJiraIssue";
        let create_name = "mcp__jira__createJiraIssue";
        assert_eq!(host.side_effect_for(read_name), ToolSideEffect::Read);
        assert_eq!(host.side_effect_for(create_name), ToolSideEffect::HardWrite);

        let read_pending = host
            .execute(
                read_name,
                &serde_json::json!({"issueIdOrKey":"PROJ-1"}),
                None,
            )
            .await
            .unwrap();
        assert!(!read_pending.ok, "MCP Read must retain first-use approval");
        let read_request = read_pending
            .events
            .iter()
            .find_map(|event| match event {
                StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
            .unwrap();
        host.complete_permission(&read_request, PermissionDecision::AllowOnce, None)
            .unwrap();
        let read = host
            .execute(
                read_name,
                &serde_json::json!({"issueIdOrKey":"PROJ-1"}),
                Some(&read_request),
            )
            .await
            .unwrap();
        assert!(read.ok, "Jira fixture Read failed: {}", read.detail_raw);
        assert!(
            read.detail_raw.contains("auth_present") && read.detail_raw.contains("true"),
            "Jira fixture did not receive child-only auth: {}",
            read.detail_raw
        );
        assert!(
            read.detail_raw.contains("getJiraIssue"),
            "wrong Jira read tool result: {}",
            read.detail_raw
        );
        assert!(
            !read.detail_raw.contains("fixture-service-token"),
            "keychain token leaked into tool output"
        );

        let create_pending = host
            .execute(
                create_name,
                &serde_json::json!({"projectKey":"PROJ","summary":"Fixture story"}),
                None,
            )
            .await
            .unwrap();
        assert!(!create_pending.ok);
        assert_eq!(create_pending.detail_raw, "permission required");
        let create_request = create_pending
            .events
            .iter()
            .find_map(|event| match event {
                StreamEvent::PermissionRequired {
                    request_id, risk, ..
                } if risk == "destructive" => Some(request_id.clone()),
                _ => None,
            })
            .expect("createJiraIssue must emit destructive permission request");
        let session_grant = host.complete_permission(
            &create_request,
            PermissionDecision::AllowSessionPath,
            Some("WRITE"),
        );
        assert!(
            session_grant
                .unwrap_err()
                .to_string()
                .contains("fresh AllowOnce"),
            "MCP HardWrite must reject session-wide permission"
        );
        assert!(
            host.has_pending(&create_request),
            "rejected session grant must leave the write retryable"
        );
        host.complete_permission(
            &create_request,
            PermissionDecision::AllowOnce,
            Some("WRITE"),
        )
        .unwrap();
        let created = host
            .execute(
                create_name,
                &serde_json::json!({"projectKey":"PROJ","summary":"Fixture story"}),
                Some(&create_request),
            )
            .await
            .unwrap();
        assert!(
            created.ok
                && created.detail_raw.contains("createJiraIssue")
                && created.detail_raw.contains("auth_present"),
            "confirmed Jira create did not execute: {}",
            created.detail_raw
        );
        let second_create = host
            .execute(
                create_name,
                &serde_json::json!({"projectKey":"PROJ","summary":"Second fixture story"}),
                None,
            )
            .await
            .unwrap();
        assert!(
            !second_create.ok
                && second_create
                    .events
                    .iter()
                    .any(|event| matches!(event, StreamEvent::PermissionRequired { .. })),
            "a prior Jira create approval must not auto-authorize the next write"
        );
    }

    fn schedule_notify_watcher(id: &str) -> WatcherDefinition {
        WatcherDefinition {
            id: id.into(),
            workspace_id: "ws-a".into(),
            enabled: true,
            watch: WatchSource::Schedule {
                interval_seconds: watchers::MIN_INTERVAL_SECONDS,
            },
            condition: WatchCondition::Always,
            action: WatchAction::Notify {
                chat_id: -1001,
                message_thread_id: Some(7),
                text: "Watcher {{watcher_id}} fired: {{event}}".into(),
            },
        }
    }

    #[tokio::test]
    async fn watcher_crud_is_workspace_scoped_and_admin_mutated() {
        let dir = tempdir().unwrap();
        let state = test_state_with_roles(
            dir.path().to_path_buf(),
            &[
                ("admin-k", "ws-a", Role::Admin),
                ("member-k", "ws-a", Role::Member),
            ],
            None,
        );
        let app = build_app(state);
        let definition = schedule_notify_watcher("crud-watch");
        let body = serde_json::to_string(&definition).unwrap();

        let member_put = Request::builder()
            .method("PUT")
            .uri("/v1/watchers/crud-watch")
            .header("authorization", "Bearer member-k")
            .header("content-type", "application/json")
            .body(Body::from(body.clone()))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(member_put).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );

        let admin_put = Request::builder()
            .method("PUT")
            .uri("/v1/watchers/crud-watch")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(body))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(admin_put).await.unwrap().status(),
            StatusCode::OK
        );

        let list = Request::builder()
            .uri("/v1/watchers?workspace_id=ws-a")
            .header("authorization", "Bearer member-k")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(list).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let listed = json_body(response).await;
        assert_eq!(listed["watchers"].as_array().unwrap().len(), 1, "{listed}");
        assert_eq!(listed["watchers"][0]["definition"]["id"], "crud-watch");

        let delete = Request::builder()
            .method("DELETE")
            .uri("/v1/watchers/crud-watch")
            .header("authorization", "Bearer admin-k")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(delete).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );

        let get = Request::builder()
            .uri("/v1/watchers/crud-watch")
            .header("authorization", "Bearer admin-k")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(get).await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn watcher_notify_fires_once_and_deduplicates_same_schedule_event() {
        let dir = tempdir().unwrap();
        let (state, sent) = telegram_test_state(dir.path().to_path_buf(), Role::Admin, false);
        let definition = schedule_notify_watcher("notify-watch");
        state.watchers.put(&definition, 1).unwrap();
        let record = state.watchers.get(&definition.id).unwrap().unwrap();

        let first = run_watcher_record(&state, &record, 600).await.unwrap();
        assert_eq!(first.outcome, "notified");
        assert_eq!(sent.lock().unwrap().len(), 1);
        assert!(sent.lock().unwrap()[0].text.contains("notify-watch"));

        let second = run_watcher_record(&state, &record, 600).await.unwrap();
        assert_eq!(second.outcome, "duplicate");
        assert_eq!(
            sent.lock().unwrap().len(),
            1,
            "same schedule event fired a second notification"
        );
        let persisted = state.watchers.get(&definition.id).unwrap().unwrap();
        assert_eq!(persisted.state.last_fired_at, Some(600));
        assert_eq!(persisted.state.last_outcome.as_deref(), Some("duplicate"));
    }

    #[tokio::test]
    async fn watcher_workspace_kill_switch_prevents_action() {
        let dir = tempdir().unwrap();
        let (state, sent) = telegram_test_state(dir.path().to_path_buf(), Role::Admin, false);
        state
            .workspaces
            .lock()
            .unwrap()
            .get_mut("ws-a")
            .unwrap()
            .watchers_enabled = false;
        let definition = schedule_notify_watcher("disabled-workspace-watch");
        state.watchers.put(&definition, 1).unwrap();
        let record = state.watchers.get(&definition.id).unwrap().unwrap();

        let report = run_watcher_record(&state, &record, 600).await.unwrap();
        assert_eq!(report.outcome, "workspace_disabled");
        assert!(sent.lock().unwrap().is_empty());
        let persisted = state.watchers.get(&definition.id).unwrap().unwrap();
        assert_eq!(
            persisted.state.last_outcome.as_deref(),
            Some("workspace_disabled")
        );
        assert!(persisted.state.last_fired_at.is_none());
    }

    #[tokio::test]
    async fn watcher_supports_query_connector_poll_and_schedule_sources() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path().to_path_buf(), &[]);

        let query = WatcherDefinition {
            id: "query-source".into(),
            workspace_id: "ws-a".into(),
            enabled: true,
            watch: WatchSource::Query {
                query: "alpha".into(),
                interval_seconds: watchers::MIN_INTERVAL_SECONDS,
                result_limit: 5,
            },
            condition: WatchCondition::Contains {
                needle: "alpha only data".into(),
            },
            action: WatchAction::Notify {
                chat_id: 1,
                message_thread_id: None,
                text: "unused".into(),
            },
        };
        let query_observation = observe_watcher(&state, &query, 600).await.unwrap();
        assert_eq!(query_observation.result_count, 1);
        assert!(watch_condition_matches(
            &query.condition,
            &query_observation
        ));

        let connector = WatcherDefinition {
            id: "connector-source".into(),
            workspace_id: "ws-a".into(),
            enabled: true,
            watch: WatchSource::ConnectorPoll {
                connector_id: "fixture".into(),
                tool_name: "fixture_poll".into(),
                arguments: serde_json::json!({}),
                interval_seconds: watchers::MIN_INTERVAL_SECONDS,
            },
            condition: WatchCondition::Contains {
                needle: "new ticket".into(),
            },
            action: WatchAction::Notify {
                chat_id: 1,
                message_thread_id: None,
                text: "unused".into(),
            },
        };
        let connector_session = "watcher-connector-source";
        {
            let mut workspaces = state.workspaces.lock().unwrap();
            workspaces.get_mut("ws-a").unwrap().connectors = Arc::new(vec![ConnectorConfig {
                id: "fixture".into(),
                kind: "fixture".into(),
                enabled: true,
                settings: serde_json::json!({
                    "stub_tool": {
                        "name": "fixture_poll",
                        "description": "offline connector poll fixture",
                        "detail": "new ticket ABC-123",
                        "side_effect": "read"
                    }
                }),
            }]);
        }
        assert!(!state.sessions.lock().await.contains_key(connector_session));
        let connector_observation = observe_watcher(&state, &connector, 600).await.unwrap();
        assert!(watch_condition_matches(
            &connector.condition,
            &connector_observation
        ));
        assert!(connector_observation.event_key.starts_with("connector:"));
        let mut mismatched_connector = connector.clone();
        if let WatchSource::ConnectorPoll { connector_id, .. } = &mut mismatched_connector.watch {
            *connector_id = "different-connector".into();
        }
        assert!(observe_watcher(&state, &mismatched_connector, 600)
            .await
            .unwrap_err()
            .contains("not registered by enabled connector"));

        let schedule = schedule_notify_watcher("schedule-source");
        let schedule_observation = observe_watcher(&state, &schedule, 600).await.unwrap();
        assert_eq!(schedule_observation.event_key, "schedule:2");
    }

    #[tokio::test]
    async fn watcher_hardwrite_only_executes_after_paired_desktop_approval() {
        use cd_core::connectors::{ConnectorExecutor, RegisteredTool};
        use cd_core::tools::ToolSpec;

        let dir = tempdir().unwrap();
        let (state, sent) = telegram_test_state(dir.path().to_path_buf(), Role::Admin, false);
        let bridge = state.telegram.as_deref().unwrap();
        let (pairing_id, _) = bridge.pair_desktop("ws-a", "Watcher test desktop").unwrap();
        let definition = WatcherDefinition {
            id: "write-watch".into(),
            workspace_id: "ws-a".into(),
            enabled: true,
            watch: WatchSource::Schedule {
                interval_seconds: watchers::MIN_INTERVAL_SECONDS,
            },
            condition: WatchCondition::Always,
            action: WatchAction::ProposeTool {
                tool_name: "remote_publish".into(),
                arguments: serde_json::json!({"issue": "ABC-123"}),
                chat_id: -1001,
                message_thread_id: Some(7),
            },
        };
        state.watchers.put(&definition, 1).unwrap();
        let session_id = "watcher-write-watch";
        ensure_session_host(&state, "ws-a", session_id, SessionOrigin::Watcher)
            .await
            .unwrap();
        {
            let mut sessions = state.sessions.lock().await;
            sessions
                .get_mut(session_id)
                .unwrap()
                .host
                .register_tool(RegisteredTool {
                    spec: ToolSpec {
                        name: "remote_publish".into(),
                        description: "offline HardWrite fixture".into(),
                        side_effect: ToolSideEffect::HardWrite,
                        parameters: serde_json::json!({"type":"object"}),
                    },
                    exec: ConnectorExecutor::Stub {
                        detail: "remote publish executed".into(),
                    },
                });
        }

        let record = state.watchers.get(&definition.id).unwrap().unwrap();
        let report = run_watcher_record(&state, &record, 600).await.unwrap();
        assert_eq!(report.outcome, "proposed");
        let request_id = report.request_id.expect("write must produce request id");
        let proposal = bridge.proposal(&request_id).unwrap().unwrap();
        assert_eq!(proposal.side_effect, ToolSideEffect::HardWrite);
        assert!(proposal.trusted_desktop_connected);
        assert!(
            sent.lock()
                .unwrap()
                .iter()
                .all(|message| !message.text.contains("remote publish executed")),
            "triggered HardWrite executed before approval"
        );

        let app = build_app(state.clone());
        let generic = Request::builder()
            .method("POST")
            .uri("/v1/permission/respond")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"workspace_id":"ws-a","session_id":"{session_id}","request_id":"{request_id}","decision":"allow_once","typed":"WRITE"}}"#
            )))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(generic).await.unwrap().status(),
            StatusCode::FORBIDDEN,
            "generic endpoint must not grant watcher-originated writes"
        );

        let approve = Request::builder()
            .method("POST")
            .uri("/v1/chat/approvals/respond")
            .header("authorization", "Bearer admin-k")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"workspace_id":"ws-a","pairing_id":"{pairing_id}","request_id":"{request_id}","decision":"allow_once","typed":"WRITE"}}"#
            )))
            .unwrap();
        let response = app.oneshot(approve).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let approved = json_body(response).await;
        assert!(
            approved["events"].as_array().unwrap().iter().any(|event| {
                event["kind"] == "tool"
                    && event["payload"]["ok"] == true
                    && event["payload"]["detail"] == "remote publish executed"
            }),
            "paired desktop did not execute watcher HardWrite: {approved}"
        );
        assert!(bridge.proposal(&request_id).unwrap().is_none());
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
