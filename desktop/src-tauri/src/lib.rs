//! ContextDesk Tauri host — secrets stay here; webview gets redacted DTOs only.

mod handbook;
mod log_diagnostics;

use cd_core::branding::Branding;
use cd_core::chat::{ChatMessage, Role as ChatRole};
use cd_core::config::{
    config_path, ensure_config_dir, load_config, save_config, AppConfig, ConfluenceSettings,
    WorkspaceConfig, XSettings, CONFLUENCE_PAT_REF, X_API_KEY_REF,
};
use cd_core::discovery::{discover_local, ollama_reachable, LocalCandidate};
use cd_core::help::{HelpIndex, HelpPage, HelpSearchHit, HelpSection};
use cd_core::keychain_store::{
    key_ref_confluence_pat, key_ref_for_profile, key_ref_x_api_key, looks_like_raw_secret,
    KeychainSecretStore, SecretStore,
};
use cd_core::memory_fs::{list_memory_files, read_workspace_file, write_memory_file, MemoryFile};
use cd_core::permissions::PermissionDecision;
use cd_core::preflight::{run_preflight, PreflightInput, PreflightReport};
use cd_core::probe::{expand_base_candidates, normalize_gateway_input};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use cd_core::research::{events_to_dto, grant_and_execute, EventDto};
use cd_core::sessions::{
    sanitize_generated_title, session_title_llm_prompt, title_from_prompt, Session, SessionMeta,
    SessionSearchHit, SessionStore,
};
use cd_core::ssrf::{validate_provider_url, SsrfPolicy};
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;
use cd_core::workspace_backup::{
    BackupConfirmationGate, BackupDestination, BackupExclusionReason, BackupPlanOptions,
    BackupPlanSummary, BackupProgress, BackupProgressObserver, BackupProgressPhase,
    BackupRunStatus, BackupRunSummary,
};
use handbook::{HandbookIndex, HandbookLink, HandbookManifest, HandbookPage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const S3_ACCESS_KEY_REF: &str = "s3/default/access_key";
const S3_SECRET_KEY_REF: &str = "s3/default/secret_key";
const S3_SESSION_TOKEN_REF: &str = "s3/default/session_token";
const AGENT_HOST_READY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct HostInitFlightState {
    running: bool,
    waiters: usize,
    last_result: Option<Result<(), String>>,
}

#[derive(Default)]
struct HostInitFlight {
    state: Mutex<HostInitFlightState>,
    changed: Condvar,
}

impl HostInitFlight {
    fn run<F>(&self, initialize: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut initialize = Some(initialize);
        let mut state = self.state.lock().expect("host init flight");
        loop {
            if state.running {
                state.waiters += 1;
                self.changed.notify_all();
                while state.running {
                    state = self.changed.wait(state).expect("host init flight");
                }
                let result = state
                    .last_result
                    .clone()
                    .unwrap_or_else(|| Err("host initialization ended without a result".into()));
                state.waiters -= 1;
                if state.waiters == 0 {
                    self.changed.notify_all();
                }
                return result;
            }
            if state.waiters > 0 {
                state = self.changed.wait(state).expect("host init flight");
                continue;
            }

            state.running = true;
            drop(state);
            let result = initialize
                .take()
                .expect("host initializer must run at most once")();
            state = self.state.lock().expect("host init flight");
            state.running = false;
            state.last_result = Some(result.clone());
            self.changed.notify_all();
            return result;
        }
    }

    #[cfg(test)]
    fn wait_for_waiters(&self, expected: usize, timeout: Duration) -> bool {
        let started = std::time::Instant::now();
        let mut state = self.state.lock().expect("host init flight");
        while state.waiters < expected {
            let Some(remaining) = timeout.checked_sub(started.elapsed()) else {
                return false;
            };
            let (next, status) = self
                .changed
                .wait_timeout(state, remaining)
                .expect("host init flight");
            state = next;
            if status.timed_out() && state.waiters < expected {
                return false;
            }
        }
        true
    }
}

struct AppState {
    branding: Branding,
    config: Mutex<AppConfig>,
    secrets: KeychainSecretStore,
    /// Shared hash-chain state for host/tool/backup audit writes.
    audit_log: Option<cd_core::audit::AuditLog>,
    /// Session id -> chat history
    histories: Mutex<HashMap<String, Vec<ChatMessage>>>,
    /// Live tool host (rebuilt when workspace changes). Arc so the index
    /// watcher callback can reindex without holding AppState.
    host: Arc<Mutex<Option<ToolHost>>>,
    /// Coordinates startup warmup and on-demand construction so only one
    /// blocking host rebuild can be active at a time.
    host_init: HostInitFlight,
    /// Invalidates optional background attachments when the host is rebuilt.
    host_generation: Arc<std::sync::atomic::AtomicU64>,
    /// UI-selected default corpus for log tools. This must be updateable without
    /// forcing host construction; the host picks it up when ready.
    active_log_corpus: Mutex<Option<String>>,
    /// Serializes chat-session writes across windows so governed fields cannot
    /// race ordinary transcript saves (#695).
    chat_session_mutation: Mutex<()>,
    /// Serializes one-process Investigation selection/create/mutation across windows.
    investigation_mutation: Mutex<()>,
    /// Per-session cooperative cancel flags for in-flight turns (#109).
    cancels: Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    /// At most one trusted workspace backup is active.
    backup_cancel: Mutex<Option<cd_core::object_store::ObjectCancellation>>,
    /// Debounced FS watcher for incremental index refresh (#116).
    index_watch: Mutex<Option<cd_core::index_watch::IndexWatchHandle>>,
    /// Background index lifecycle (#117) — search works while Indexing.
    index_status: Arc<Mutex<cd_core::index::IndexStatus>>,
    /// Validated, bundled product Help. This never points at a workspace root.
    help: Mutex<Option<Arc<HelpIndex>>>,
    /// Read-only engineering docs. Deliberately separate from Help and ToolHost.
    handbook: Mutex<Option<Arc<HandbookIndex>>>,
}

fn workspace_from_cfg(cfg: &AppConfig) -> Option<Workspace> {
    cfg.workspace.as_ref().map(|w| Workspace {
        id: w.id.clone(),
        name: w.name.clone(),
        roots: w.roots.clone(),
    })
}

fn session_store(state: &AppState) -> Result<SessionStore, String> {
    let dir = ensure_config_dir(&state.branding)
        .map_err(|e| e.to_string())?
        .join("sessions");
    Ok(SessionStore::new(dir))
}

fn investigation_store(
    state: &AppState,
) -> Result<cd_core::investigations::InvestigationStore, String> {
    let dir = ensure_config_dir(&state.branding)
        .map_err(|e| e.to_string())?
        .join("investigations");
    Ok(cd_core::investigations::InvestigationStore::new(dir))
}

fn seed_history_from_session(state: &AppState, session: &Session) {
    let hist = session.to_chat_history();
    let mut histories = state.histories.lock().expect("hist");
    histories.insert(session.id.clone(), hist);
}

fn normalize_log_corpus_id(corpus_id: Option<String>) -> Option<String> {
    corpus_id.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    })
}

fn active_log_corpus_snapshot(state: &AppState) -> Option<String> {
    state
        .active_log_corpus
        .lock()
        .expect("active_log_corpus")
        .clone()
}

fn apply_active_log_corpus_to_host(state: &AppState, host: &mut ToolHost) {
    host.set_active_log_corpus(active_log_corpus_snapshot(state));
}

fn set_active_log_corpus_state_nonblocking(
    state: &AppState,
    corpus_id: Option<String>,
) -> Option<String> {
    let normalized = normalize_log_corpus_id(corpus_id);
    *state.active_log_corpus.lock().expect("active_log_corpus") = normalized.clone();
    if let Ok(mut host_guard) = state.host.try_lock() {
        if let Some(host) = host_guard.as_mut() {
            host.set_active_log_corpus(normalized.clone());
        }
    }
    normalized
}

fn log_embed_backend_snapshot_nonblocking(
    state: &AppState,
) -> Option<Arc<dyn cd_core::embed::EmbedBackend>> {
    state
        .host
        .try_lock()
        .ok()
        .and_then(|host| host.as_ref().and_then(|h| h.log_embed_backend()))
}

fn ensure_host(state: &AppState) -> Result<(), String> {
    state.host_init.run(|| ensure_host_inner(state))
}

fn ensure_host_inner(state: &AppState) -> Result<(), String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or_else(|| "no workspace configured".to_string())?;
    if ws.roots.is_empty() {
        return Err("workspace has no roots".into());
    }

    let mut host_guard = state.host.lock().expect("host");
    if let Some(host) = host_guard.as_mut() {
        // Long-lived host (#110): keep permissions. Do **not** reindex on every
        // ensure (#117) — full walks run in the background / FS watcher only.
        if host.workspace.roots != ws.roots || host.workspace.id != ws.id {
            // Workspace changed — rebuild.
            drop(host_guard);
            return rebuild_host(state, cfg, ws);
        }
        apply_host_connectors(host, &cfg, state);
        apply_active_log_corpus_to_host(state, host);
        return Ok(());
    }
    drop(host_guard);
    rebuild_host(state, cfg, ws)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HostReadinessFailure {
    Timeout,
    Initialization,
    Worker,
}

impl HostReadinessFailure {
    fn code(&self) -> &'static str {
        match self {
            Self::Timeout => "host_readiness_timeout",
            Self::Initialization => "host_initialization_failed",
            Self::Worker => "host_initialization_worker_failed",
        }
    }

    fn message(&self) -> &'static str {
        match self {
            Self::Timeout => {
                "Workspace tools are still starting. This turn stopped before contacting the \
                 provider. Check that ContextDesk can access the configured workspace, then retry."
            }
            Self::Initialization => {
                "Workspace tools could not start. This turn stopped before contacting the \
                 provider. Check the configured workspace and its permissions, then retry."
            }
            Self::Worker => {
                "Workspace tools stopped unexpectedly while starting. This turn did not contact \
                 the provider. Retry, and check the application logs if the problem continues."
            }
        }
    }
}

async fn wait_for_host_readiness<F>(
    timeout: Duration,
    initialize: F,
) -> Result<(), HostReadinessFailure>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    match tokio::time::timeout(timeout, tauri::async_runtime::spawn_blocking(initialize)).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(error))) => {
            tracing::warn!(error = %error, "workspace host initialization failed");
            Err(HostReadinessFailure::Initialization)
        }
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "workspace host initialization worker failed");
            Err(HostReadinessFailure::Worker)
        }
        Err(_) => Err(HostReadinessFailure::Timeout),
    }
}

fn host_readiness_terminal_events(
    failure: &HostReadinessFailure,
) -> [cd_core::events::StreamEvent; 2] {
    [
        cd_core::events::StreamEvent::Error {
            code: failure.code().into(),
            message: failure.message().into(),
        },
        cd_core::events::StreamEvent::TurnCompleted {
            reason: "host_not_ready".into(),
        },
    ]
}

fn linked_log_fallback_notice() -> cd_core::events::StreamEvent {
    cd_core::events::StreamEvent::Error {
        code: "linked_log_only_fallback".into(),
        message: "Workspace context is still starting, but the linked log corpus is ready. \
             Continuing with bounded read-only log tools for this turn; workspace files, \
             memory, and connectors are not available."
            .into(),
    }
}

fn build_linked_log_fallback_host(
    state: &AppState,
    context: &cd_core::agent::LogExplorerTurnContext,
) -> Result<ToolHost, String> {
    // This host is deliberately independent from configured workspace roots.
    let workspace = Workspace {
        id: "linked-log-fallback".into(),
        name: "Linked log investigation".into(),
        roots: Vec::new(),
    };
    let cache = log_cache_dir(state)?;

    let mut host = ToolHost::new(
        workspace,
        cd_core::index::KeywordIndex::new(),
        state.audit_log.clone(),
    );
    let cfg = state.config.lock().expect("config").clone();
    host.set_router_budget(cfg.router);
    host.set_model_context_budgets(cfg.model_context_budgets);
    host.set_log_analysis(true, Some(cache));
    host.set_log_only_tool_surface(true);
    host.set_log_corpus_scope(Some(context.corpus_id.clone()));
    host.set_active_log_corpus(Some(context.corpus_id.clone()));
    Ok(host)
}

fn validate_linked_log_corpus_at(cache: &std::path::Path, corpus_id: &str) -> Result<(), String> {
    // Opening validates metadata, engine artifacts, templates, and DuckDB
    // schema before any provider receives the turn.
    cd_core::log_analysis::LogCorpus::open(cache, corpus_id)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn linked_log_preflight_at(
    cache: &std::path::Path,
    context: &cd_core::agent::LogExplorerTurnContext,
    tools_profile: Option<&ProviderProfile>,
    session_id: &str,
) -> Option<Vec<cd_core::events::StreamEvent>> {
    if validate_linked_log_corpus_at(cache, &context.corpus_id).is_err() {
        return Some(linked_log_host_terminal_events().into());
    }
    tools_profile
        .and_then(|profile| cd_core::research::linked_tools_unavailable_events(profile, session_id))
}

fn take_ready_linked_host<F>(
    shared: &Arc<Mutex<Option<ToolHost>>>,
    generation: &std::sync::atomic::AtomicU64,
    fallback: F,
) -> Result<(ToolHost, bool, Option<u64>), String>
where
    F: FnOnce() -> Result<ToolHost, String>,
{
    let ready = shared.try_lock().ok().and_then(|mut guard| {
        let log_ready = guard.as_ref().is_some_and(|host| {
            host.log_analysis_enabled()
                && host
                    .specs_for_model()
                    .iter()
                    .any(|tool| tool.name == cd_core::log_analysis::SEARCH_LOGS)
        });
        log_ready
            .then(|| {
                let borrowed_generation = generation.load(std::sync::atomic::Ordering::SeqCst);
                guard.take().map(|host| (host, borrowed_generation))
            })
            .flatten()
    });
    match ready {
        Some((host, borrowed_generation)) => Ok((host, false, Some(borrowed_generation))),
        None => fallback().map(|host| (host, true, None)),
    }
}

fn restore_host_if_generation_matches(
    shared: &Arc<Mutex<Option<ToolHost>>>,
    generation: &std::sync::atomic::AtomicU64,
    borrowed_generation: u64,
    host: ToolHost,
) -> bool {
    let mut guard = shared.lock().expect("host");
    if generation.load(std::sync::atomic::Ordering::SeqCst) != borrowed_generation
        || guard.is_some()
    {
        return false;
    }
    *guard = Some(host);
    true
}

fn linked_log_host_terminal_events() -> [cd_core::events::StreamEvent; 2] {
    [
        cd_core::events::StreamEvent::Error {
            code: "linked_log_host_unavailable".into(),
            message: "The linked log corpus is unavailable or invalid. This turn stopped before \
                      contacting the provider. Reopen Log Explorer or re-import the logs, then retry."
                .into(),
        },
        cd_core::events::StreamEvent::TurnCompleted {
            reason: "linked_log_host_unavailable".into(),
        },
    ]
}

struct BackgroundIndexBuild {
    index: cd_core::index::KeywordIndex,
    stats: cd_core::index::ReindexStats,
    bytes_capped: bool,
    resident_chunks: usize,
}

struct BackgroundIndexOutcome {
    stats: cd_core::index::ReindexStats,
    bytes_capped: bool,
    resident_chunks: usize,
}

fn build_background_index(
    workspace: &Workspace,
    cache_dir: Option<&std::path::Path>,
    max_files: usize,
    max_index_bytes: usize,
) -> Result<BackgroundIndexBuild, String> {
    let mut index = cd_core::index::KeywordIndex::open_shell_bounded(
        workspace,
        cache_dir,
        Some(max_files),
        Some(max_index_bytes),
    )
    .map_err(|e| e.to_string())?;
    let stats = index.refresh().map_err(|e| e.to_string())?;
    let bytes_capped = index.is_bytes_capped();
    let resident_chunks = index.len();
    Ok(BackgroundIndexBuild {
        index,
        stats,
        bytes_capped,
        resident_chunks,
    })
}

fn install_background_index(
    host_arc: &Arc<Mutex<Option<ToolHost>>>,
    expected_workspace: &Workspace,
    index: cd_core::index::KeywordIndex,
) -> bool {
    let mut pending = Some(index);
    loop {
        let mut guard = host_arc.lock().expect("host");
        match guard.as_mut() {
            Some(host)
                if host.workspace.id == expected_workspace.id
                    && host.workspace.roots == expected_workspace.roots =>
            {
                host.replace_index(pending.take().expect("pending index"));
                return true;
            }
            Some(_) => return false,
            // Agent turns temporarily take the host out of the mutex. Wait in
            // this background worker, never in the chat/request path.
            None => {}
        }
        drop(guard);
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

fn build_and_install_background_index<F>(
    host_arc: &Arc<Mutex<Option<ToolHost>>>,
    expected_workspace: &Workspace,
    build: F,
) -> Result<Option<BackgroundIndexOutcome>, String>
where
    F: FnOnce() -> Result<BackgroundIndexBuild, String>,
{
    // Deliberately run the expensive walk before touching the live host lock.
    let built = build()?;
    let outcome = BackgroundIndexOutcome {
        stats: built.stats,
        bytes_capped: built.bytes_capped,
        resident_chunks: built.resident_chunks,
    };
    if install_background_index(host_arc, expected_workspace, built.index) {
        Ok(Some(outcome))
    } else {
        Ok(None)
    }
}

fn install_prepared_durable_memory(
    live: &mut ToolHost,
    prepared: &ToolHost,
    expected_workspace_id: &str,
) -> bool {
    if live.workspace.id != expected_workspace_id {
        return false;
    }
    let Some(store) = prepared.durable_memory_store() else {
        return false;
    };
    live.set_candidate_inbox(prepared.candidate_inbox());
    live.set_edge_store(prepared.edge_store());
    live.set_harvest_db_path(prepared.harvest_db_path_for_ui());
    live.set_durable_memory(store, true);
    live.set_ambient_recall_enabled(prepared.ambient_recall_enabled());
    true
}

#[allow(clippy::too_many_arguments)]
fn spawn_durable_memory_warmup(
    host_arc: Arc<Mutex<Option<ToolHost>>>,
    workspace: Workspace,
    audit_log: Option<cd_core::audit::AuditLog>,
    branding: Branding,
    memory_config: cd_core::memory::MemoryConfig,
    embed_backend: Option<Arc<dyn cd_core::embed::EmbedBackend>>,
    embed_model: String,
    generation: Arc<std::sync::atomic::AtomicU64>,
    expected_generation: u64,
) {
    if !memory_config.durable_memory_enabled {
        return;
    }
    let expected_workspace_id = workspace.id.clone();
    let _ = std::thread::Builder::new()
        .name("cd-memory-warmup".into())
        .spawn(move || {
            let mut retry_delay = Duration::from_secs(5);
            let prepared = loop {
                if generation.load(std::sync::atomic::Ordering::SeqCst) != expected_generation {
                    return;
                }
                // Prepare against an isolated host. Protected-folder stalls
                // remain confined to this optional worker and cannot hold
                // HostInitFlight or the live ToolHost mutex.
                let mut candidate = ToolHost::new(
                    workspace.clone(),
                    cd_core::index::KeywordIndex::new(),
                    audit_log.clone(),
                );
                candidate.set_embed_backend_with_model(embed_backend.clone(), &embed_model);
                match cd_core::memory::attach_durable_memory_to_host(
                    &mut candidate,
                    &branding,
                    &memory_config,
                ) {
                    Ok(()) => break candidate,
                    Err(error) => {
                        tracing::warn!(
                            error = %error,
                            retry_secs = retry_delay.as_secs(),
                            "durable memory warmup failed; core host remains ready and memory will retry"
                        );
                        std::thread::sleep(retry_delay);
                        retry_delay =
                            std::cmp::min(retry_delay.saturating_mul(2), Duration::from_secs(60));
                    }
                }
            };
            // A live agent turn may temporarily own the shared host. Wait only
            // in this optional installer; never delay startup or a turn.
            loop {
                if generation.load(std::sync::atomic::Ordering::SeqCst) != expected_generation {
                    return;
                }
                if let Ok(mut guard) = host_arc.try_lock() {
                    if generation.load(std::sync::atomic::Ordering::SeqCst) != expected_generation {
                        return;
                    }
                    if let Some(host) = guard.as_mut() {
                        if install_prepared_durable_memory(
                            host,
                            &prepared,
                            &expected_workspace_id,
                        ) {
                            tracing::info!("durable memory attached after isolated warmup");
                        } else {
                            tracing::debug!(
                                "discarding durable memory prepared for a replaced workspace"
                            );
                        }
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
}

fn rebuild_host(state: &AppState, cfg: AppConfig, ws: Workspace) -> Result<(), String> {
    let index_cache = ensure_config_dir(&state.branding)
        .ok()
        .map(|d| d.join("index"));
    let roots = ws.roots.clone();

    // #117: open shell without blocking full walk — search uses loaded store
    // (or empty cold) immediately; full refresh runs in a background thread.
    let index = cd_core::index::KeywordIndex::open_shell_bounded(
        &ws,
        index_cache.as_deref(),
        Some(cfg.index_max_files),
        Some(cfg.index_max_bytes),
    )
    .map_err(|e| e.to_string())?;
    let audit_log = state.audit_log.clone();
    let mut host = ToolHost::new(ws.clone(), index, audit_log);
    host.set_help_index(state.help.lock().expect("help").clone());
    host.set_router_budget(cfg.router.clone());
    host.set_model_context_budgets(cfg.model_context_budgets.clone());
    host.attach_connectors(&cfg.connectors);
    apply_host_connectors(&mut host, &cfg, state);
    apply_active_log_corpus_to_host(state, &mut host);
    // Publish the core workspace/log host before optional durable-memory I/O.
    // Memory tools remain absent until their isolated warmup installs a fully
    // prepared store; no partially initialized capability is advertised.
    host.set_durable_memory_enabled(false);
    host.set_ambient_recall_enabled(false);
    let memory_embed_backend = host.embed_backend();
    let memory_embed_model = host.embed_model().to_string();

    // Do not invalidate an active host or its durable-memory retry worker until
    // every fallible replacement-host construction step has succeeded.
    if let Some(mut prev) = state.index_watch.lock().expect("watch").take() {
        prev.stop();
    }

    {
        let mut st = state.index_status.lock().expect("index_status");
        *st = cd_core::index::IndexStatus {
            phase: cd_core::index::IndexPhase::Indexing,
            scanned: 0,
            added: 0,
            max_files: cfg.index_max_files as u32,
            truncated: false,
            bytes_capped: host.index_bytes_capped(),
            resident_chunks: host.index_resident_chunks() as u32,
            message: "Background index starting — search uses whatever is already loaded.".into(),
        };
    }

    let host_generation = {
        let mut host_guard = state.host.lock().expect("host");
        let generation = state
            .host_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            .saturating_add(1);
        *host_guard = Some(host);
        generation
    };

    spawn_durable_memory_warmup(
        Arc::clone(&state.host),
        ws.clone(),
        state.audit_log.clone(),
        state.branding.clone(),
        cfg.memory.clone(),
        memory_embed_backend,
        memory_embed_model,
        Arc::clone(&state.host_generation),
        host_generation,
    );

    // Background full/incremental refresh off the UI / turn critical path
    // (#117, #596). Build a separate index snapshot without holding the live
    // ToolHost mutex, then swap it under a short lock.
    let host_arc = Arc::clone(&state.host);
    let status_arc = Arc::clone(&state.index_status);
    let refresh_gate = Arc::new(Mutex::new(()));
    let initial_refresh_gate = Arc::clone(&refresh_gate);
    let initial_workspace = ws.clone();
    let initial_cache = index_cache.clone();
    let max_files = cfg.index_max_files;
    let max_index_bytes = cfg.index_max_bytes;
    let _ = std::thread::Builder::new()
        .name("cd-index-bg".into())
        .spawn(move || {
            let _refresh_guard = initial_refresh_gate.lock().expect("index refresh");
            {
                let mut st = status_arc.lock().expect("index_status");
                st.phase = cd_core::index::IndexPhase::Indexing;
                st.message = "Indexing workspace in background…".into();
            }
            let result = build_and_install_background_index(&host_arc, &initial_workspace, || {
                build_background_index(
                    &initial_workspace,
                    initial_cache.as_deref(),
                    max_files,
                    max_index_bytes,
                )
            });
            match result {
                Ok(Some(build)) => {
                    let stats = build.stats;
                    let mut st = status_arc.lock().expect("index_status");
                    st.phase = cd_core::index::IndexPhase::Ready;
                    st.scanned = stats.scanned;
                    st.added = stats.added;
                    st.max_files = stats.max_files;
                    st.truncated = stats.truncated;
                    st.bytes_capped = build.bytes_capped;
                    st.resident_chunks = build.resident_chunks as u32;
                    st.message = if stats.truncated {
                        format!(
                            "Index ready (walk hit soft cap {} files; truncated).",
                            stats.max_files
                        )
                    } else if build.bytes_capped {
                        "Index ready (resident set bytes-capped; search covers recent subset)."
                            .into()
                    } else {
                        format!(
                            "Index ready — scanned {} files, {} added.",
                            stats.scanned, stats.added
                        )
                    };
                    tracing::info!(?stats, "background index complete");
                }
                Ok(None) => {}
                Err(e) => {
                    let mut st = status_arc.lock().expect("index_status");
                    st.phase = cd_core::index::IndexPhase::Error;
                    st.message = format!("Background index failed: {e}");
                    tracing::warn!(error = %e, "background index failed");
                }
            }
        });

    // Start debounced FS watcher → incremental reindex (host-agnostic API).
    let host_arc = Arc::clone(&state.host);
    let status_arc = Arc::clone(&state.index_status);
    let watcher_workspace = ws.clone();
    let watcher_cache = index_cache;
    let watcher_refresh_gate = refresh_gate;
    let on_refresh = Arc::new(move || {
        let _refresh_guard = watcher_refresh_gate.lock().expect("index refresh");
        match build_and_install_background_index(&host_arc, &watcher_workspace, || {
            build_background_index(
                &watcher_workspace,
                watcher_cache.as_deref(),
                max_files,
                max_index_bytes,
            )
        }) {
            Ok(Some(build)) => {
                if let Ok(mut st) = status_arc.lock() {
                    st.phase = cd_core::index::IndexPhase::Ready;
                    st.scanned = build.stats.scanned;
                    st.added = build.stats.added;
                    st.truncated = build.stats.truncated;
                    st.bytes_capped = build.bytes_capped;
                    st.resident_chunks = build.resident_chunks as u32;
                    st.message = format!(
                        "Index refreshed — scanned {}, +{}.",
                        build.stats.scanned, build.stats.added
                    );
                }
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(error = %e, "index watcher refresh failed");
            }
        }
    });
    let handle = cd_core::index_watch::spawn_index_watcher(roots, on_refresh);
    *state.index_watch.lock().expect("watch") = Some(handle);
    Ok(())
}

fn apply_host_connectors(host: &mut ToolHost, cfg: &AppConfig, state: &AppState) {
    // Attach Confluence RO when enabled (PAT from keychain only).
    if cfg.confluence.enabled && cfg.confluence.is_configured() {
        let pat = state.secrets.get(&key_ref_confluence_pat()).ok().flatten();
        host.set_confluence(Some(cfg.confluence.to_ro_config()), pat);
        host.set_confluence_write_enabled(cfg.confluence.write_enabled);
    } else {
        host.set_confluence(None, None);
        host.set_confluence_write_enabled(false);
    }
    host.set_web_research(cfg.web_research_enabled);
    host.set_web_research_sources(&cfg.web_research_sources);
    // Log Phase-1: disposable corpora under app cache (LOG_ANALYSIS.md §10 keep-until-discarded).
    if let Ok(config_dir) = ensure_config_dir(&state.branding) {
        let log_cache = config_dir.join("cache");
        let _ = std::fs::create_dir_all(&log_cache);
        host.set_log_analysis(true, Some(log_cache));
    }
    // #359: product default for log templates = local ONNX (fastembed), not Ollama HTTP.
    // May download the small model once; on failure fall back to shared host embed later.
    match cd_core::embed::default_log_embed_backend() {
        Ok(Some(be)) => {
            host.set_log_embed_backend(Some(be), cd_core::embed::LOCAL_LOG_EMBED_MODEL_ID);
            tracing::info!(
                model = cd_core::embed::LOCAL_LOG_EMBED_MODEL_ID,
                "log template embed: local ONNX (fastembed)"
            );
        }
        Ok(None) => {
            tracing::debug!("log-fastembed not in this build; log embed falls back to host");
        }
        Err(e) => {
            tracing::warn!(error = %e, "local ONNX log embed init failed; will fall back to host embed");
        }
    }
    // #119 hybrid search_kb opt-in; #346 memory embed-on-write needs the same backend
    // whenever durable memory is on (not only when hybrid_retrieval is toggled).
    host.set_hybrid_retrieval(cfg.hybrid_retrieval);
    let want_embed = cfg.hybrid_retrieval || cfg.memory.durable_memory_enabled;
    if want_embed {
        if let Some(profile) = cfg.providers.active() {
            if profile.kind == cd_core::providers::ProviderKind::Ollama {
                match cd_core::chat::OllamaClient::new(
                    &profile.base_url,
                    // Prefer a small embed model id when available; chat model still works
                    // for hosts that share one local model.
                    "nomic-embed-text",
                ) {
                    Ok(client) => {
                        host.set_embed_backend_with_model(
                            Some(std::sync::Arc::new(
                                cd_core::embed::OllamaEmbedBackend::new(client),
                            )),
                            "nomic-embed-text",
                        );
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "embed backend requested but Ollama client failed");
                        host.set_embed_backend(None);
                    }
                }
            } else {
                // Keyword + recency without semantic when no local embed model.
                host.set_embed_backend(None);
            }
        } else {
            host.set_embed_backend(None);
        }
    } else {
        host.set_embed_backend(None);
    }
    if cfg.x.enabled {
        let bearer = state.secrets.get(&key_ref_x_api_key()).ok().flatten();
        host.set_x_search(true, bearer);
    } else {
        host.set_x_search(false, None);
    }
    host.set_router_budget(cfg.router.clone());
    host.set_model_context_budgets(cfg.model_context_budgets.clone());
    // #127–#131: connector registry → dynamic tools (secrets from keychain only).
    let mut pg_passwords = std::collections::HashMap::new();
    let mut http_bearers = std::collections::HashMap::new();
    for c in cfg.connectors.iter().filter(|c| c.enabled) {
        if c.kind == "postgres" {
            let r = cd_core::sql_ro::postgres_password_ref(&c.id);
            if let Ok(Some(pw)) = state.secrets.get(&r) {
                pg_passwords.insert(c.id.clone(), pw);
            }
        }
        if c.kind == "http" {
            let r = cd_core::http_preset::http_bearer_ref(&c.id);
            if let Ok(Some(b)) = state.secrets.get(&r) {
                http_bearers.insert(c.id.clone(), b);
            }
        }
    }
    host.attach_connectors_with_all_secrets(&cfg.connectors, &pg_passwords, &http_bearers);

    // #136: enabled external modules (local install only; capability grants from #135).
    if let Ok(config_dir) = ensure_config_dir(&state.branding) {
        let modules_dir = cd_core::modules::default_modules_dir(&config_dir);
        let grants_path = config_dir.join("module_grants.json");
        let grants = cd_core::modules::ModuleGrantStore::load(&grants_path).unwrap_or_default();
        let discovered = cd_core::modules::discover_modules(&[modules_dir]).unwrap_or_default();
        for id in &cfg.enabled_modules {
            if let Some(m) = discovered.iter().find(|x| &x.id == id) {
                let secrets = &state.secrets;
                let resolve = |r: &str| secrets.get(r).ok().flatten();
                if let Err(e) = host.attach_module(m, &grants, &resolve) {
                    tracing::warn!(module_id = %id, error = %e, "enabled module attach failed");
                }
            }
        }
    }
}

fn spawn_initial_host_warmup(app: tauri::AppHandle) {
    if let Err(e) = std::thread::Builder::new()
        .name("cd-host-warmup".into())
        .spawn(move || {
            let state = app.state::<AppState>();
            if let Err(error) = ensure_host(&state) {
                tracing::warn!(
                    error = %error,
                    "initial host warmup failed after app window startup"
                );
            }
        })
    {
        tracing::warn!(
            error = %e,
            "failed to spawn initial host warmup; host will initialize on demand"
        );
    }
}

#[derive(Debug, Serialize)]
struct BrandingDto {
    name: String,
    slug: String,
    tagline: String,
    version: String,
    protocol: String,
    /// `dev` | `installed` (#338).
    channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    git_describe: Option<String>,
    /// Compact identity line for About / diagnostics.
    identity_line: String,
}

#[tauri::command]
fn get_branding(state: State<'_, AppState>) -> BrandingDto {
    let id = cd_core::build_identity::current();
    BrandingDto {
        name: state.branding.name.clone(),
        slug: state.branding.slug.clone(),
        tagline: state.branding.tagline.clone(),
        version: id.version.clone(),
        protocol: id.protocol.clone(),
        channel: id.channel.as_str().to_string(),
        git_sha: id.git_sha.clone(),
        git_describe: id.git_describe.clone(),
        identity_line: id.display_line(),
    }
}

/// Base dir for session context packs: first workspace root / branding data dir / sessions.
fn session_context_base(state: &AppState) -> Result<std::path::PathBuf, String> {
    let cfg = state.config.lock().expect("config");
    let root = cfg
        .workspace
        .as_ref()
        .and_then(|w| w.roots.first())
        .cloned()
        .ok_or_else(|| "No workspace root — open a workspace first".to_string())?;
    let dir_name = state.branding.workspace_dir_name.clone();
    Ok(root.join(dir_name))
}

#[tauri::command]
fn session_context_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<cd_core::session_context::SessionContextEntry>, String> {
    let base = session_context_base(&state)?;
    let store = cd_core::session_context::SessionContextStore::open(
        &base,
        &session_id,
        cd_core::session_context::SessionContextCaps::default(),
    )
    .map_err(|e| e.to_string())?;
    store.list().map_err(|e| e.to_string())
}

#[tauri::command]
fn session_context_import_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<cd_core::session_context::SessionContextEntry, String> {
    let base = session_context_base(&state)?;
    let store = cd_core::session_context::SessionContextStore::open(
        &base,
        &session_id,
        cd_core::session_context::SessionContextCaps::default(),
    )
    .map_err(|e| e.to_string())?;
    let progress = TauriProcessProgress { app };
    let p = std::path::Path::new(&path);
    // Wizard "both"/session_context with a .zip must extract entries (not store the archive blob).
    let is_zip = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);
    if is_zip && p.is_file() {
        let data = std::fs::read(p).map_err(|e| format!("read zip: {e}"))?;
        let entries = store
            .import_zip_bytes_with_progress(
                &data,
                cd_core::session_context::DEFAULT_MAX_ZIP_NEST,
                &progress,
                None,
            )
            .map_err(|e| e.to_string())?;
        return entries
            .into_iter()
            .next()
            .ok_or_else(|| "zip contained no extractable entries".to_string());
    }
    store
        .import_file_with_progress(p, None, &progress, None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn session_context_import_bytes(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    data: Vec<u8>,
) -> Result<cd_core::session_context::SessionContextEntry, String> {
    let base = session_context_base(&state)?;
    let store = cd_core::session_context::SessionContextStore::open(
        &base,
        &session_id,
        cd_core::session_context::SessionContextCaps::default(),
    )
    .map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let progress = TauriProcessProgress { app };
    store
        .import_bytes_with_progress(
            if safe.is_empty() { "file.bin" } else { &safe },
            &data,
            &progress,
            None,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn session_context_remove(
    state: State<'_, AppState>,
    session_id: String,
    rel_path: String,
) -> Result<(), String> {
    let base = session_context_base(&state)?;
    let store = cd_core::session_context::SessionContextStore::open(
        &base,
        &session_id,
        cd_core::session_context::SessionContextCaps::default(),
    )
    .map_err(|e| e.to_string())?;
    store.remove(&rel_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_context_purge(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let base = session_context_base(&state)?;
    let store = cd_core::session_context::SessionContextStore::open(
        &base,
        &session_id,
        cd_core::session_context::SessionContextCaps::default(),
    )
    .map_err(|e| e.to_string())?;
    store.purge().map_err(|e| e.to_string())
}

#[tauri::command]
fn session_context_import_zip(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<Vec<cd_core::session_context::SessionContextEntry>, String> {
    let base = session_context_base(&state)?;
    let store = cd_core::session_context::SessionContextStore::open(
        &base,
        &session_id,
        cd_core::session_context::SessionContextCaps::default(),
    )
    .map_err(|e| e.to_string())?;
    let progress = TauriProcessProgress { app };
    store
        .import_zip_bytes_with_progress(
            &data,
            cd_core::session_context::DEFAULT_MAX_ZIP_NEST,
            &progress,
            None,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().expect("config lock").clone()
}

#[tauri::command]
fn save_app_config(state: State<'_, AppState>, cfg: AppConfig) -> Result<(), String> {
    for p in &cfg.providers.profiles {
        if let Some(r) = &p.api_key_ref {
            if looks_like_raw_secret(r) {
                return Err("refusing raw secret in api_key_ref".into());
            }
        }
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *state.config.lock().expect("config lock") = cfg;
    // rebuild host
    let _ = ensure_host(&state);
    Ok(())
}

/// Non-secret S3 backup settings and keychain presence for Settings.
#[derive(Clone, Serialize)]
struct S3BackupSettingsDto {
    enabled: bool,
    endpoint: String,
    region: String,
    bucket: String,
    prefix: String,
    path_style: bool,
    allow_private_network: bool,
    credentials_present: bool,
    keychain_service: String,
    access_key_ref: String,
    secret_key_ref: String,
    session_token_ref: String,
}

/// Webview-saveable fields. There is intentionally no credential field.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveS3BackupSettings {
    enabled: bool,
    endpoint: String,
    region: String,
    bucket: String,
    prefix: String,
    path_style: bool,
    allow_private_network: bool,
}

fn s3_backup_plan_options(
    config: &cd_core::s3_object_store::S3ObjectStoreConfig,
    workspace_data_dir_name: &str,
    dry_run: bool,
) -> Result<BackupPlanOptions, String> {
    Ok(BackupPlanOptions {
        destination: BackupDestination {
            endpoint_host: config.endpoint_host().map_err(|e| e.to_string())?,
            bucket: config.bucket.clone(),
            region: config.region.clone(),
            prefix: config.prefix.clone(),
        },
        // The S3 adapter applies the configured prefix exactly once.
        object_prefix: String::new(),
        workspace_data_dir_name: workspace_data_dir_name.to_string(),
        dry_run,
    })
}

async fn plan_s3_workspace_backup(
    workspace: &Workspace,
    config: &cd_core::s3_object_store::S3ObjectStoreConfig,
    workspace_data_dir_name: &str,
    dry_run: bool,
    cancellation: cd_core::object_store::ObjectCancellation,
) -> Result<cd_core::workspace_backup::WorkspaceBackupPlan, String> {
    // The real command and focused host regression share this seam so endpoint
    // policy cannot be bypassed while reaching the core planner.
    config.validate_for_save().map_err(|e| e.to_string())?;
    cd_core::workspace_backup::plan_workspace_backup(
        workspace,
        s3_backup_plan_options(config, workspace_data_dir_name, dry_run)?,
        cancellation,
    )
    .await
    .map_err(|e| e.to_string())
}

fn s3_keychain_refs() -> Result<
    (
        cd_core::s3_object_store::S3KeychainRef,
        cd_core::s3_object_store::S3KeychainRef,
        cd_core::s3_object_store::S3KeychainRef,
    ),
    String,
> {
    Ok((
        cd_core::s3_object_store::S3KeychainRef::parse(S3_ACCESS_KEY_REF)
            .map_err(|e| e.to_string())?,
        cd_core::s3_object_store::S3KeychainRef::parse(S3_SECRET_KEY_REF)
            .map_err(|e| e.to_string())?,
        cd_core::s3_object_store::S3KeychainRef::parse(S3_SESSION_TOKEN_REF)
            .map_err(|e| e.to_string())?,
    ))
}

fn s3_settings_dto(state: &AppState) -> S3BackupSettingsDto {
    let cfg = state.config.lock().expect("config lock");
    let configured = cfg.s3_backup.as_ref();
    let credentials_present = configured.is_some()
        && state.secrets.has(S3_ACCESS_KEY_REF).unwrap_or(false)
        && state.secrets.has(S3_SECRET_KEY_REF).unwrap_or(false);
    S3BackupSettingsDto {
        enabled: configured.is_some_and(|s3| s3.enabled),
        endpoint: configured.map(|s3| s3.endpoint.clone()).unwrap_or_default(),
        region: configured
            .map(|s3| s3.region.clone())
            .unwrap_or_else(|| "us-east-1".into()),
        bucket: configured.map(|s3| s3.bucket.clone()).unwrap_or_default(),
        prefix: configured.map(|s3| s3.prefix.clone()).unwrap_or_default(),
        path_style: configured.is_some_and(|s3| s3.path_style),
        allow_private_network: configured.is_some_and(|s3| s3.allow_private_network),
        credentials_present,
        keychain_service: state.secrets.service_name().to_string(),
        access_key_ref: S3_ACCESS_KEY_REF.into(),
        secret_key_ref: S3_SECRET_KEY_REF.into(),
        session_token_ref: S3_SESSION_TOKEN_REF.into(),
    }
}

#[tauri::command]
fn get_s3_backup_settings(state: State<'_, AppState>) -> S3BackupSettingsDto {
    s3_settings_dto(&state)
}

#[tauri::command]
fn save_s3_backup_settings(
    state: State<'_, AppState>,
    req: SaveS3BackupSettings,
) -> Result<S3BackupSettingsDto, String> {
    let (access_key_ref, secret_key_ref, session_token_ref) = s3_keychain_refs()?;
    let config = cd_core::s3_object_store::S3ObjectStoreConfig {
        enabled: req.enabled,
        endpoint: req.endpoint.trim().trim_end_matches('/').to_string(),
        region: req.region.trim().to_string(),
        bucket: req.bucket.trim().to_string(),
        prefix: req.prefix.trim().trim_matches('/').to_string(),
        path_style: req.path_style,
        allow_private_network: req.allow_private_network,
        access_key_ref,
        secret_key_ref,
        session_token_ref: Some(session_token_ref),
    };
    // Endpoint policy is checked on save and S3ObjectStore::new checks it again
    // immediately before any request.
    config.validate_for_save().map_err(|e| e.to_string())?;
    let mut cfg = state.config.lock().expect("config lock").clone();
    cfg.s3_backup = Some(config);
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *state.config.lock().expect("config lock") = cfg;
    Ok(s3_settings_dto(&state))
}

fn resolve_s3_credentials(
    store: &dyn SecretStore,
    config: &cd_core::s3_object_store::S3ObjectStoreConfig,
) -> Result<cd_core::object_store::ObjectCredentials, String> {
    let access_key = store
        .get(config.access_key_ref.as_str())
        .map_err(|_| "could not read S3 access key from OS keychain".to_string())?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "S3 access key is missing from the OS keychain".to_string())?;
    let secret_key = store
        .get(config.secret_key_ref.as_str())
        .map_err(|_| "could not read S3 secret key from OS keychain".to_string())?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "S3 secret key is missing from the OS keychain".to_string())?;
    let session_token = match &config.session_token_ref {
        Some(reference) => store
            .get(reference.as_str())
            .map_err(|_| "could not read S3 session token from OS keychain".to_string())?
            .filter(|value| !value.trim().is_empty()),
        None => None,
    };
    cd_core::object_store::ObjectCredentials::new(access_key, secret_key, session_token)
        .map_err(|e| e.to_string())
}

fn build_backup_store(
    dry_run: bool,
    secrets: &dyn SecretStore,
    config: &cd_core::s3_object_store::S3ObjectStoreConfig,
) -> Result<Arc<dyn cd_core::object_store::ObjectStore>, String> {
    if dry_run {
        // A dry run has no transport capable of remote writes and remains
        // useful before credential provisioning.
        return Ok(Arc::new(
            cd_core::object_store::InMemoryObjectStore::default(),
        ));
    }
    let credentials = resolve_s3_credentials(secrets, config)?;
    Ok(Arc::new(
        cd_core::s3_object_store::S3ObjectStore::new(config.clone(), credentials)
            .map_err(|e| e.to_string())?,
    ))
}

fn backup_confirmation_message(summary: &BackupPlanSummary) -> String {
    let roots = summary
        .roots
        .iter()
        .map(|root| format!("  • {}", root.display()))
        .collect::<Vec<_>>()
        .join("\n");
    let mode = if summary.dry_run {
        "DRY RUN — no remote writes"
    } else {
        "REAL UPLOAD"
    };
    let mut exclusion_counts = std::collections::BTreeMap::<BackupExclusionReason, u64>::new();
    for exclusion in &summary.exclusions {
        *exclusion_counts.entry(exclusion.reason).or_default() += exclusion.entries;
    }
    let exclusion_detail = if exclusion_counts.is_empty() {
        "  • none".to_string()
    } else {
        exclusion_counts
            .into_iter()
            .map(|(reason, count)| format!("  • {reason}: {count}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "{mode}\n\nWorkspace: {}\nExact roots:\n{}\n\nDestination:\n  Host: {}\n  Bucket: {}\n  Region: {}\n  Prefix: {}\n\nSelected workspace content will leave this machine.\n\nIncluded: {} files ({} bytes)\nExcluded/unreadable: {} entries ({} known bytes)\nReasons:\n{}\n\nContinue?",
        summary.workspace_name,
        roots,
        summary.destination.endpoint_host,
        summary.destination.bucket,
        summary.destination.region,
        if summary.destination.prefix.is_empty() {
            "(bucket root)"
        } else {
            &summary.destination.prefix
        },
        summary.file_count,
        summary.bytes,
        summary.excluded_count,
        summary.excluded_bytes,
        exclusion_detail,
    )
}

struct NativeBackupConfirmation {
    app: tauri::AppHandle,
}

#[async_trait::async_trait]
impl BackupConfirmationGate for NativeBackupConfirmation {
    async fn confirm(&self, summary: &BackupPlanSummary) -> bool {
        let app = self.app.clone();
        let message = backup_confirmation_message(summary);
        tokio::task::spawn_blocking(move || {
            app.dialog()
                .message(message)
                .title("Confirm workspace backup/export")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Continue".into(),
                    "Cancel".into(),
                ))
                .blocking_show()
        })
        .await
        .unwrap_or(false)
    }
}

struct TauriBackupProgress {
    app: tauri::AppHandle,
}

impl BackupProgressObserver for TauriBackupProgress {
    fn progress(&self, update: BackupProgress) {
        let _ = self.app.emit("s3-backup-progress", update);
    }
}

fn audit_s3_backup(
    state: &AppState,
    config: &cd_core::s3_object_store::S3ObjectStoreConfig,
    summary: &BackupRunSummary,
) {
    let Ok((target, detail)) = s3_backup_audit_fields(config, summary) else {
        return;
    };
    let Some(audit_log) = state.audit_log.as_ref() else {
        return;
    };
    let outcome = match summary.status {
        BackupRunStatus::Completed | BackupRunStatus::DryRun => cd_core::audit::outcomes::ALLOWED,
        BackupRunStatus::Declined => cd_core::audit::outcomes::DENIED,
        BackupRunStatus::Failed | BackupRunStatus::Cancelled => cd_core::audit::outcomes::ERROR,
    };
    let _ = audit_log.log(
        "s3_workspace_backup",
        cd_core::tools::ToolSideEffect::HardWrite,
        &target,
        outcome,
        &detail,
        summary.uploaded_bytes,
    );
}

fn s3_backup_audit_fields(
    config: &cd_core::s3_object_store::S3ObjectStoreConfig,
    summary: &BackupRunSummary,
) -> Result<(String, String), String> {
    let host = config.endpoint_host().map_err(|e| e.to_string())?;
    let detail = format!(
        "status={:?} uploaded_files={} uploaded_bytes={} skipped_files={} excluded_files={} failed_files={}",
        summary.status,
        summary.uploaded_files,
        summary.uploaded_bytes,
        summary.skipped_files,
        summary.excluded_files,
        summary.failed_files
    );
    Ok((format!("s3-backup://{host}/{}", config.bucket), detail))
}

#[tauri::command]
async fn run_s3_workspace_backup(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    dry_run: bool,
) -> Result<BackupRunSummary, String> {
    let config = state
        .config
        .lock()
        .expect("config lock")
        .s3_backup
        .clone()
        .ok_or_else(|| "S3 backup destination is not configured".to_string())?;
    if !config.enabled {
        return Err("S3 backup destination is disabled".into());
    }
    let workspace = state
        .config
        .lock()
        .expect("config lock")
        .workspace
        .clone()
        .map(WorkspaceConfig::into_workspace)
        .ok_or_else(|| "no workspace configured".to_string())?;
    let cancellation = cd_core::object_store::ObjectCancellation::default();
    {
        let mut active = state.backup_cancel.lock().expect("backup cancel");
        if active.is_some() {
            return Err("a workspace backup is already running".into());
        }
        *active = Some(cancellation.clone());
    }

    let result = async {
        let _ = app.emit(
            "s3-backup-progress",
            BackupProgress {
                phase: BackupProgressPhase::Planning,
                completed_files: 0,
                total_files: 0,
                completed_bytes: 0,
                total_bytes: 0,
            },
        );
        let plan = plan_s3_workspace_backup(
            &workspace,
            &config,
            &state.branding.workspace_dir_name,
            dry_run,
            cancellation.clone(),
        )
        .await?;
        let store = build_backup_store(dry_run, &state.secrets, &config)?;
        let confirmation = NativeBackupConfirmation { app: app.clone() };
        let progress = TauriBackupProgress { app: app.clone() };
        Ok::<_, String>(
            cd_core::workspace_backup::run_confirmed_workspace_backup(
                store,
                plan,
                &confirmation,
                &progress,
                cancellation,
            )
            .await,
        )
    }
    .await;
    *state.backup_cancel.lock().expect("backup cancel") = None;
    if let Ok(summary) = &result {
        audit_s3_backup(&state, &config, summary);
    }
    result
}

#[tauri::command]
fn cancel_s3_workspace_backup(state: State<'_, AppState>) -> bool {
    let cancellation = state.backup_cancel.lock().expect("backup cancel").clone();
    if let Some(cancellation) = cancellation {
        cancellation.cancel();
        true
    } else {
        false
    }
}

/// Connector row for Settings (#127). No secrets.
#[derive(Clone, serde::Serialize)]
struct ConnectorDto {
    id: String,
    kind: String,
    enabled: bool,
    label: String,
    /// Kind-specific non-secret settings (command/args for MCP, etc.).
    settings: serde_json::Value,
    /// Tools discovered after host attach (MCP `mcp__server__tool` names).
    #[serde(default)]
    discovered_tools: Vec<String>,
}

fn connector_dtos(state: &AppState, cfg: &AppConfig) -> Vec<ConnectorDto> {
    let tool_names: Vec<String> = state
        .host
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref()
                .map(|h| h.specs_for_model().into_iter().map(|s| s.name).collect())
        })
        .unwrap_or_default();
    cfg.connectors
        .iter()
        .map(|c| {
            let discovered_tools = if c.kind == "mcp" {
                let server = c
                    .settings
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(c.id.as_str());
                let prefix = format!("mcp__{server}__");
                tool_names
                    .iter()
                    .filter(|n| n.starts_with(&prefix))
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            ConnectorDto {
                id: c.id.clone(),
                kind: c.kind.clone(),
                enabled: c.enabled,
                label: c.label(),
                settings: c.settings.clone(),
                discovered_tools,
            }
        })
        .collect()
}

#[tauri::command]
fn list_connectors(state: State<'_, AppState>) -> Vec<ConnectorDto> {
    let cfg = state.config.lock().expect("config lock").clone();
    connector_dtos(&state, &cfg)
}

#[tauri::command]
fn list_connector_kinds() -> Vec<String> {
    cd_core::connectors::CONNECTOR_KINDS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

/// Replace workspace connector list (settings JSON only; no secrets over IPC).
#[tauri::command]
fn save_connectors(
    state: State<'_, AppState>,
    connectors: Vec<cd_core::connectors::ConnectorConfig>,
) -> Result<Vec<ConnectorDto>, String> {
    for c in &connectors {
        if c.id.trim().is_empty() || c.kind.trim().is_empty() {
            return Err("connector id and kind are required".into());
        }
        // Refuse accidental secret fields in settings JSON.
        if let Some(obj) = c.settings.as_object() {
            for key in ["api_key", "password", "token", "pat", "secret", "bearer"] {
                if let Some(v) = obj.get(key) {
                    if v.as_str().map(|s| !s.is_empty()).unwrap_or(false) {
                        return Err(format!(
                            "refusing secret field `{key}` in connector settings — use keychain"
                        ));
                    }
                }
            }
        }
    }
    let mut cfg = state.config.lock().expect("config lock").clone();
    cfg.connectors = connectors;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *state.config.lock().expect("config lock") = cfg.clone();
    let _ = ensure_host(&state);
    Ok(connector_dtos(&state, &cfg))
}

/// Store a connector secret in the keychain (Postgres password, etc.). Never returns the secret.
#[tauri::command]
fn set_connector_secret(
    state: State<'_, AppState>,
    connector_id: String,
    kind: String,
    secret: String,
) -> Result<(), String> {
    let connector_id = connector_id.trim();
    if connector_id.is_empty() {
        return Err("connector_id required".into());
    }
    let secret = secret.trim();
    if secret.is_empty() || secret.chars().all(|c| c == '•') {
        return Err("empty secret".into());
    }
    let r = match kind.as_str() {
        "postgres_password" | "password" => cd_core::sql_ro::postgres_password_ref(connector_id),
        "http_bearer" | "bearer" => cd_core::http_preset::http_bearer_ref(connector_id),
        other => return Err(format!("unknown connector secret kind: {other}")),
    };
    state.secrets.set(&r, secret).map_err(|e| e.to_string())?;
    let _ = ensure_host(&state);
    Ok(())
}

/// Whether a connector secret exists in the keychain (bool only over IPC).
#[tauri::command]
fn connector_has_secret(
    state: State<'_, AppState>,
    connector_id: String,
    kind: String,
) -> Result<bool, String> {
    let r = match kind.as_str() {
        "postgres_password" | "password" => {
            cd_core::sql_ro::postgres_password_ref(connector_id.trim())
        }
        "http_bearer" | "bearer" => cd_core::http_preset::http_bearer_ref(connector_id.trim()),
        other => return Err(format!("unknown connector secret kind: {other}")),
    };
    state.secrets.has(&r).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_provider_secret(
    state: State<'_, AppState>,
    profile_id: String,
    secret: String,
) -> Result<(), String> {
    let secret = secret.trim();
    if secret.is_empty() || secret.chars().all(|c| c == '•') {
        return Err("empty secret".into());
    }
    // Never log secret; only store.
    let r = key_ref_for_profile(&profile_id);
    state.secrets.set(&r, secret).map_err(|e| e.to_string())?;
    // Ensure profile records the ref only (not the secret).
    let mut cfg = state.config.lock().expect("config lock");
    if let Some(p) = cfg
        .providers
        .profiles
        .iter_mut()
        .find(|p| p.id == profile_id)
    {
        p.api_key_ref = Some(r);
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn provider_has_secret(state: State<'_, AppState>, profile_id: String) -> Result<bool, String> {
    let r = key_ref_for_profile(&profile_id);
    state.secrets.has(&r).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct SaveProviderReq {
    /// `ollama` | `openai_compatible`
    kind: String,
    base_url: String,
    chat_model: String,
    label: Option<String>,
    /// Optional new API key; empty/null keeps existing keychain entry.
    api_key: Option<String>,
    /// When true, refuse non-loopback remote bases (local-only profile).
    #[serde(default)]
    local_only: Option<bool>,
    /// Optional override for native tool calling (#327). `None` preserves existing.
    #[serde(default)]
    tools_enabled: Option<bool>,
}

#[derive(Debug, Serialize)]
struct ProviderDto {
    id: String,
    kind: String,
    base_url: String,
    chat_model: String,
    label: String,
    /// Keychain ref id only — never the secret.
    api_key_ref: Option<String>,
    has_key: bool,
    /// Native tool calling enabled for this profile (#327).
    tools_enabled: bool,
}

fn provider_to_dto(p: &ProviderProfile, has_key: bool) -> ProviderDto {
    ProviderDto {
        id: p.id.clone(),
        kind: match p.kind {
            ProviderKind::Ollama => "ollama".into(),
            ProviderKind::OpenAiCompatible => "openai_compatible".into(),
            ProviderKind::Anthropic => "anthropic".into(),
            ProviderKind::XaiGrokBuild => "xai_grok_build".into(),
        },
        base_url: p.base_url.clone(),
        chat_model: p.chat_model.clone(),
        label: p.label.clone(),
        api_key_ref: p.api_key_ref.clone(),
        has_key,
        tools_enabled: p.capabilities.tools,
    }
}

/// Persist active provider profile (refs only) and optionally store API key in keychain.
#[tauri::command]
fn save_active_provider(
    state: State<'_, AppState>,
    req: SaveProviderReq,
) -> Result<ProviderDto, String> {
    let kind = match req.kind.as_str() {
        "ollama" => ProviderKind::Ollama,
        "openai_compatible" => ProviderKind::OpenAiCompatible,
        "anthropic" => ProviderKind::Anthropic,
        "xai_grok_build" => ProviderKind::XaiGrokBuild,
        other => return Err(format!("unsupported provider kind: {other}")),
    };
    let desc = cd_core::providers::descriptor_for(kind);
    let id = desc.profile_id_slug.to_string();
    let label = req.label.unwrap_or_else(|| desc.default_label.to_string());
    let mut base_url = req.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        if let Some(def) = desc.default_base_url {
            base_url = def.to_string();
        }
    }
    let chat_model = req.chat_model.trim().to_string();
    if chat_model.is_empty() {
        return Err("chat model is required".into());
    }

    // Grok session credentials live in ~/.grok/auth.json — never paste into keychain via this path.
    if matches!(kind, ProviderKind::XaiGrokBuild) {
        cd_core::grok_auth::assert_grok_base_allowed(&base_url).map_err(|e| e.to_string())?;
        if cd_core::grok_auth::detect_grok_session().is_none() {
            return Err("No Grok session found. Run `grok login`, then try again.".into());
        }
    }

    let mut api_key_ref: Option<String> = None;
    // Grok uses session file, not keychain paste; other needs_api_key kinds accept keychain.
    if !matches!(kind, ProviderKind::XaiGrokBuild) {
        if let Some(key) = req.api_key.as_ref() {
            let key = key.trim();
            if !key.is_empty()
                && !key.chars().all(|c| c == '•')
                && (looks_like_raw_secret(key) || key.len() >= 8)
            {
                let r = key_ref_for_profile(&id);
                state.secrets.set(&r, key).map_err(|e| e.to_string())?;
                api_key_ref = Some(r);
            }
        }
    }

    let mut cfg = state.config.lock().expect("config lock");
    // Keep existing ref if no new key provided (non-Grok).
    if api_key_ref.is_none() && !matches!(kind, ProviderKind::XaiGrokBuild) {
        if let Some(existing) = cfg.providers.profiles.iter().find(|p| p.id == id) {
            api_key_ref = existing.api_key_ref.clone();
        }
    }
    // If still none but key exists under standard ref, record the ref.
    let r = key_ref_for_profile(&id);
    if api_key_ref.is_none()
        && !matches!(kind, ProviderKind::XaiGrokBuild)
        && state.secrets.has(&r).unwrap_or(false)
    {
        api_key_ref = Some(r.clone());
    }

    let local_only = req.local_only.unwrap_or(desc.is_local);
    if local_only && !base_url.is_empty() {
        let policy = SsrfPolicy::local_only();
        if validate_provider_url(&base_url, &policy).is_err() {
            return Err("local-only profile: base URL must be loopback (e.g. 127.0.0.1)".into());
        }
    }

    // #125: seed per-kind defaults; preserve discovered capabilities.tools (#327).
    let mut capabilities = desc.default_capabilities;
    if let Some(existing) = cfg.providers.profiles.iter().find(|p| p.id == id) {
        capabilities.tools = existing.capabilities.tools;
        capabilities.stream = existing.capabilities.stream;
        // embeddings from descriptor when kind changes still uses default above
        if existing.kind == kind {
            capabilities.embeddings = existing.capabilities.embeddings;
        }
    }
    if let Some(te) = req.tools_enabled {
        capabilities.tools = te;
    }
    let profile = ProviderProfile {
        id: id.clone(),
        label: label.clone(),
        kind,
        base_url: base_url.clone(),
        api_key_ref: api_key_ref.clone(),
        chat_model: chat_model.clone(),
        embedding_model: if capabilities.embeddings {
            // Ollama local default embed id when kind supports embeddings.
            Some("nomic-embed-text".into())
        } else {
            None
        },
        embedding_base_url: None,
        capabilities,
        local_only,
    };

    if let Some(slot) = cfg.providers.profiles.iter_mut().find(|p| p.id == id) {
        *slot = profile.clone();
    } else {
        cfg.providers.profiles.push(profile.clone());
    }
    cfg.providers.active_id = Some(id.clone());

    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;

    let has_key = if matches!(kind, ProviderKind::XaiGrokBuild) {
        cd_core::grok_auth::detect_grok_session().is_some()
    } else {
        api_key_ref
            .as_ref()
            .map(|r| state.secrets.has(r).unwrap_or(false))
            .unwrap_or(false)
    };

    Ok(provider_to_dto(&profile, has_key))
}

#[tauri::command]
fn list_local_candidates() -> Vec<LocalCandidate> {
    discover_local()
}

#[derive(Debug, Deserialize)]
struct ProbeRequest {
    base_url: String,
    allow_private: bool,
}

#[derive(Debug, Serialize)]
struct ProbeDto {
    ok: bool,
    effective_base: String,
    candidates: Vec<String>,
    error: Option<String>,
}

#[tauri::command]
fn probe_url(req: ProbeRequest) -> ProbeDto {
    let policy = if req.allow_private {
        SsrfPolicy::allow_private_networks()
    } else {
        SsrfPolicy::default()
    };
    let normalized = normalize_gateway_input(&req.base_url);
    let candidates = expand_base_candidates(&normalized);
    match validate_provider_url(&normalized, &policy) {
        Ok(u) => ProbeDto {
            ok: true,
            effective_base: u.to_string(),
            candidates,
            error: None,
        },
        Err(e) => ProbeDto {
            ok: false,
            effective_base: normalized,
            candidates,
            error: Some(e.to_string()),
        },
    }
}

#[tauri::command]
async fn check_ollama(base_url: String) -> bool {
    ollama_reachable(&base_url).await
}

#[tauri::command]
async fn run_preflight_cmd(state: State<'_, AppState>) -> Result<PreflightReport, String> {
    let cfg = state.config.lock().expect("config lock").clone();
    let ws = workspace_from_cfg(&cfg);
    let active = cfg.providers.active().cloned();
    let mut ollama_ok = None;
    let mut provider_ok = None;
    let mut provider_probe_detail = None;
    let mut key_present = None;
    if let Some(p) = &active {
        let desc = cd_core::providers::descriptor_for(p.kind);
        if p.kind == ProviderKind::Ollama {
            ollama_ok = Some(ollama_reachable(&p.base_url).await);
        } else if p.kind == ProviderKind::XaiGrokBuild {
            key_present = Some(cd_core::grok_auth::detect_grok_session().is_some());
            // #126: real probe (session + models list), not structural URL only.
            let outcome = cd_core::discovery::probe_provider(p, None).await;
            provider_ok = Some(outcome.is_reachable());
            provider_probe_detail = Some(match &outcome {
                cd_core::discovery::ProbeOutcome::Reachable { reason }
                | cd_core::discovery::ProbeOutcome::KeyRejected { reason }
                | cd_core::discovery::ProbeOutcome::Unreachable { reason } => reason.clone(),
            });
        } else if desc.needs_api_key {
            let ref_id = p
                .api_key_ref
                .clone()
                .unwrap_or_else(|| key_ref_for_profile(&p.id));
            let has = state.secrets.has(&ref_id).unwrap_or(false);
            key_present = Some(has);
            // #126: live HTTP probe — same TriageTool-parity path as Discover (corp private OK).
            let api_key = if has {
                state.secrets.get(&ref_id).ok().flatten()
            } else {
                None
            };
            let outcome = cd_core::discovery::probe_provider(p, api_key).await;
            provider_ok = Some(outcome.is_reachable());
            provider_probe_detail = Some(match &outcome {
                cd_core::discovery::ProbeOutcome::Reachable { reason }
                | cd_core::discovery::ProbeOutcome::KeyRejected { reason }
                | cd_core::discovery::ProbeOutcome::Unreachable { reason } => reason.clone(),
            });
        }
    }
    let data_ok = ensure_config_dir(&state.branding).is_ok();
    let confluence_pat = if cfg.confluence.enabled {
        Some(
            state
                .secrets
                .has(&key_ref_confluence_pat())
                .unwrap_or(false),
        )
    } else {
        None
    };
    let grok_session_present = Some(cd_core::grok_auth::detect_grok_session().is_some());
    let mem_active = {
        let host = state.host.lock().expect("host");
        host.as_ref()
            .map(|h| h.durable_memory_active())
            .unwrap_or(false)
    };
    Ok(run_preflight(PreflightInput {
        workspace: ws.as_ref(),
        providers: &cfg.providers,
        data_dir_writable: data_ok,
        ollama_reachable: ollama_ok,
        provider_reachable: provider_ok,
        provider_probe_detail,
        active_key_present: key_present,
        confluence: Some(&cfg.confluence),
        confluence_pat_present: confluence_pat,
        grok_session_present,
        connectors: &cfg.connectors,
        durable_memory_active: Some(mem_active),
    }))
}

#[tauri::command]
fn get_confluence_settings(state: State<'_, AppState>) -> ConfluenceSettings {
    state.config.lock().expect("config").confluence.clone()
}

#[tauri::command]
fn get_web_research_enabled(state: State<'_, AppState>) -> bool {
    state.config.lock().expect("config").web_research_enabled
}

#[tauri::command]
fn get_hybrid_retrieval(state: State<'_, AppState>) -> bool {
    state.config.lock().expect("config").hybrid_retrieval
}

#[tauri::command]
fn set_hybrid_retrieval(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    let mut cfg = state.config.lock().expect("config");
    cfg.hybrid_retrieval = enabled;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(enabled)
}

/// Ambient memory injection each turn (MEMORY.md §10.1 / #271). Default ON.
#[tauri::command]
fn get_ambient_recall_enabled(state: State<'_, AppState>) -> bool {
    state
        .config
        .lock()
        .expect("config")
        .memory
        .ambient_recall_enabled
}

#[tauri::command]
fn set_ambient_recall_enabled(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    let mut cfg = state.config.lock().expect("config");
    cfg.memory.ambient_recall_enabled = enabled;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    // Rebuild host so attach_durable_memory picks up ambient flag.
    let _ = ensure_host(&state);
    Ok(enabled)
}

#[tauri::command]
fn get_router_budget(state: State<'_, AppState>) -> cd_core::router::RouterBudget {
    state.config.lock().expect("config").router.clone()
}

#[derive(Debug, Deserialize)]
struct SetRouterBudgetReq {
    max_sources: usize,
    max_tool_rounds: usize,
    max_results_per_source: usize,
    deadline_ms: u64,
}

#[tauri::command]
fn set_router_budget(
    state: State<'_, AppState>,
    req: SetRouterBudgetReq,
) -> Result<cd_core::router::RouterBudget, String> {
    let budget = cd_core::router::RouterBudget {
        max_sources: req.max_sources,
        max_tool_rounds: req.max_tool_rounds,
        max_results_per_source: req.max_results_per_source,
        deadline_ms: req.deadline_ms,
        order: cd_core::router::RouterBudget::default().order,
    }
    .sanitized();
    let mut cfg = state.config.lock().expect("config");
    cfg.router = budget.clone();
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(budget)
}

/// Open an http(s) URL in the **system** default browser.
///
/// WKWebView / Tauri does not treat `window.open` as a real browser launch.
/// Only http(s) is allowed — no `file:`, no custom schemes, no shell strings.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("empty URL".into());
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("only http(s) URLs may open in the system browser".into());
    }
    // Reject embedded credentials (https://user:pass@host/...).
    if let Some(rest) = url.split("://").nth(1) {
        if rest.contains('@') {
            return Err("credentials in URL are not allowed".into());
        }
    }
    // Basic length guard against abuse.
    if url.len() > 8_192 {
        return Err("URL too long".into());
    }
    open_url_in_default_browser(url)
}

fn open_url_in_default_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("failed to open browser: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        // Prefer rundll32 — `cmd /C start` breaks on long GitHub issue URLs (`&` / length).
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn()
            .map_err(|e| format!("failed to open browser: {e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("failed to open browser: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
    {
        let _ = url;
        Err("opening the system browser is unsupported on this platform".into())
    }
}

#[tauri::command]
fn set_web_research_enabled(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    let mut cfg = state.config.lock().expect("config");
    cfg.web_research_enabled = enabled;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    // Rebuild host so tool specs update for the next agent turn.
    let _ = ensure_host(&state);
    Ok(enabled)
}

/// List curated publisher RSS sources with effective enable flags.
#[tauri::command]
fn list_web_research_sources(
    state: State<'_, AppState>,
) -> Vec<cd_core::news_sources::NewsSourceDto> {
    let overrides = state
        .config
        .lock()
        .expect("config")
        .web_research_sources
        .clone();
    cd_core::news_sources::list_sources_dto(&overrides)
}

/// Save per-source enable map (merged with registry defaults on read).
#[tauri::command]
fn set_web_research_sources(
    state: State<'_, AppState>,
    sources: std::collections::HashMap<String, bool>,
) -> Result<Vec<cd_core::news_sources::NewsSourceDto>, String> {
    // Only persist known registry ids.
    let known: std::collections::HashSet<&str> = cd_core::news_sources::NEWS_SOURCES
        .iter()
        .map(|s| s.id)
        .collect();
    let filtered: std::collections::HashMap<String, bool> = sources
        .into_iter()
        .filter(|(k, _)| known.contains(k.as_str()))
        .collect();
    let mut cfg = state.config.lock().expect("config");
    cfg.web_research_sources = filtered;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    let dto = cd_core::news_sources::list_sources_dto(&cfg.web_research_sources);
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(dto)
}

#[derive(Debug, Deserialize)]
struct SaveConfluenceReq {
    enabled: bool,
    base_url: String,
    /// Comma or space separated space keys.
    spaces: String,
    /// Optional new PAT; empty means keep existing.
    pat: Option<String>,
    /// HardWrite tools (#326 PR7). Default false when omitted.
    #[serde(default)]
    write_enabled: bool,
}

#[tauri::command]
fn save_confluence_settings(
    state: State<'_, AppState>,
    req: SaveConfluenceReq,
) -> Result<ConfluenceSettings, String> {
    let spaces: Vec<String> = req
        .spaces
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let base_url = req.base_url.trim().trim_end_matches('/').to_string();
    if req.enabled && !base_url.is_empty() {
        let policy = SsrfPolicy::default();
        // Allow private wikis on corp networks via allow_private_networks if needed later.
        // For now default SSRF; users on private IP can use advanced override later.
        if let Err(e) = validate_provider_url(&base_url, &policy) {
            // Private corporate wikis: retry with private allowed
            if validate_provider_url(&base_url, &SsrfPolicy::allow_private_networks()).is_err() {
                return Err(format!("Invalid Confluence base URL: {e}"));
            }
        }
    }

    let mut pat_ref = state
        .config
        .lock()
        .expect("config")
        .confluence
        .pat_ref
        .clone();

    if let Some(pat) = req.pat {
        let pat = pat.trim();
        if !pat.is_empty() && !pat.chars().all(|c| c == '•') {
            state
                .secrets
                .set(&key_ref_confluence_pat(), pat)
                .map_err(|e| e.to_string())?;
            pat_ref = Some(CONFLUENCE_PAT_REF.to_string());
        }
    }

    let mut cf = state.config.lock().expect("config").confluence.clone();
    cf.enabled = req.enabled;
    cf.base_url = base_url;
    cf.spaces = spaces;
    cf.pat_ref = pat_ref;
    cf.write_enabled = req.write_enabled;

    let mut cfg = state.config.lock().expect("config");
    cfg.confluence = cf.clone();
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(cf)
}

#[tauri::command]
fn confluence_has_token(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .secrets
        .has(&key_ref_confluence_pat())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_x_settings(state: State<'_, AppState>) -> XSettings {
    state.config.lock().expect("config").x.clone()
}

#[derive(Debug, Deserialize)]
struct SaveXReq {
    enabled: bool,
    /// Optional new bearer; empty means keep existing.
    api_key: Option<String>,
}

#[tauri::command]
fn save_x_settings(state: State<'_, AppState>, req: SaveXReq) -> Result<XSettings, String> {
    let mut api_key_ref = state.config.lock().expect("config").x.api_key_ref.clone();

    if let Some(key) = req.api_key {
        let key = key.trim();
        if !key.is_empty() && !key.chars().all(|c| c == '•') {
            state
                .secrets
                .set(&key_ref_x_api_key(), key)
                .map_err(|e| e.to_string())?;
            api_key_ref = Some(X_API_KEY_REF.to_string());
        }
    }

    let x = XSettings {
        enabled: req.enabled,
        api_key_ref,
    };

    let mut cfg = state.config.lock().expect("config");
    cfg.x = x.clone();
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(x)
}

#[tauri::command]
fn x_has_token(state: State<'_, AppState>) -> Result<bool, String> {
    state
        .secrets
        .has(&key_ref_x_api_key())
        .map_err(|e| e.to_string())
}

/// Validate token presence (no live X API call — avoids burning quota / leaking status).
#[tauri::command]
fn test_x_config(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock().expect("config").x.clone();
    if !cfg.enabled {
        return Ok("X search disabled".into());
    }
    let has = state
        .secrets
        .has(&key_ref_x_api_key())
        .map_err(|e| e.to_string())?;
    if !has {
        return Err(
            "No X API bearer in secure storage. Paste a key under Connectors (paid X API plan)."
                .into(),
        );
    }
    Ok(
        "X enabled with a key on file. Search requires a paid/usable X API plan; free tier cannot search."
            .into(),
    )
}

/// Validate URL + token presence (no live network call to avoid leaking PAT to logs).
#[tauri::command]
fn test_confluence_config(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock().expect("config").confluence.clone();
    if !cfg.enabled {
        return Ok(
            "Confluence disabled — enable it under Settings → Connectors → Confluence.".into(),
        );
    }
    if cfg.base_url.trim().is_empty() {
        return Err("Base URL is required. Open Settings → Connectors → Confluence.".to_string());
    }
    let has = state
        .secrets
        .has(&key_ref_confluence_pat())
        .map_err(|e| e.to_string())?;
    if !has {
        return Err(
            "No personal access token in secure storage. Re-save PAT under Settings → Connectors → Confluence."
                .into(),
        );
    }
    // SSRF check base URL
    let policy = SsrfPolicy::allow_private_networks();
    validate_provider_url(&cfg.base_url, &policy).map_err(|e| e.to_string())?;
    let pat = state
        .secrets
        .get(&key_ref_confluence_pat())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "PAT missing from keychain".to_string())?;
    let ro = cfg.to_ro_config();
    let auth = cd_core::confluence_ro::ConfluenceAuth::bearer(pat);
    // Live probe (authenticated space list) — no PAT in returned message.
    let handle = tokio::runtime::Handle::try_current();
    let probe = if let Ok(h) = handle {
        h.block_on(cd_core::confluence_ro::probe_connection(
            &ro, &auth, &policy,
        ))
        .map_err(|e| e.to_string())?
    } else {
        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
        rt.block_on(cd_core::confluence_ro::probe_connection(
            &ro, &auth, &policy,
        ))
        .map_err(|e| e.to_string())?
    };
    if probe.ok {
        Ok(probe.message)
    } else {
        Err(probe.message)
    }
}

#[derive(Serialize)]
struct ConfluenceSpaceDto {
    key: String,
    name: String,
}

/// List remote Confluence spaces (Read). Does not change allowlist.
#[tauri::command]
fn list_confluence_spaces(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<ConfluenceSpaceDto>, String> {
    let cfg = state.config.lock().expect("config").confluence.clone();
    if !cfg.enabled {
        return Err("Confluence disabled".into());
    }
    if cfg.base_url.trim().is_empty() {
        return Err("Base URL required".into());
    }
    let pat = state
        .secrets
        .get(&key_ref_confluence_pat())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "PAT missing — save under Settings → Connectors → Confluence".to_string())?;
    let policy = SsrfPolicy::allow_private_networks();
    let ro = cfg.to_ro_config();
    let auth = cd_core::confluence_ro::ConfluenceAuth::bearer(pat);
    let lim = limit.unwrap_or(50).min(100) as usize;
    let response = {
        let run = async {
            cd_core::confluence_ro::list_spaces(&ro, &auth, &policy, lim)
                .await
                .map_err(|e| e.to_string())
        };
        if let Ok(h) = tokio::runtime::Handle::try_current() {
            h.block_on(run)
        } else {
            tokio::runtime::Runtime::new()
                .map_err(|e| e.to_string())?
                .block_on(run)
        }
    }?;
    Ok(response
        .value
        .into_iter()
        .map(|s| ConfluenceSpaceDto {
            key: s.key,
            name: s.name,
        })
        .collect())
}

/// Instant path check for workspace settings UI (exists + readable directory).
#[tauri::command]
fn validate_workspace_path(path: String) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if path.trim().is_empty() {
        return Err("Path is empty".into());
    }
    if !p.exists() {
        return Err("Path does not exist".into());
    }
    if !p.is_dir() {
        return Err("Path is not a directory".into());
    }
    if cd_core::workspace::is_whole_home_directory(&p) {
        return Err(
            "Refusing whole home directory as a workspace root — pick a project folder".into(),
        );
    }
    // Readable: try listing one entry
    match std::fs::read_dir(&p) {
        Ok(_) => Ok(format!("Readable directory: {}", p.display())),
        Err(e) => Err(format!("Not readable: {e}")),
    }
}

/// Suggested OS-default workspace (Documents/<product>) without creating it.
#[derive(Serialize)]
struct DefaultWorkspaceDto {
    path: String,
    label: String,
    exists: bool,
}

#[tauri::command]
fn suggest_default_workspace(state: State<'_, AppState>) -> Result<DefaultWorkspaceDto, String> {
    let path = cd_core::workspace::default_workspace_root(&state.branding.name)
        .map_err(|e| e.to_string())?;
    Ok(DefaultWorkspaceDto {
        path: path.display().to_string(),
        label: cd_core::workspace::default_workspace_label(&state.branding.name),
        exists: path.is_dir(),
    })
}

/// Create Documents/<product> if needed and return its absolute path.
#[tauri::command]
fn ensure_default_workspace(state: State<'_, AppState>) -> Result<DefaultWorkspaceDto, String> {
    let path = cd_core::workspace::ensure_default_workspace_root(&state.branding.name)
        .map_err(|e| e.to_string())?;
    Ok(DefaultWorkspaceDto {
        path: path.display().to_string(),
        label: cd_core::workspace::default_workspace_label(&state.branding.name),
        exists: true,
    })
}

#[tauri::command]
fn set_workspace_roots(
    state: State<'_, AppState>,
    name: String,
    roots: Vec<String>,
) -> Result<(), String> {
    let root_paths: Vec<PathBuf> = roots.into_iter().map(PathBuf::from).collect();
    for r in &root_paths {
        if cd_core::workspace::is_whole_home_directory(r) {
            return Err(
                "Refusing whole home directory as a workspace root — pick a project folder".into(),
            );
        }
        if !r.exists() {
            return Err(format!("Root does not exist: {}", r.display()));
        }
    }
    let mut cfg = state.config.lock().expect("config lock");
    let id = cfg
        .workspace
        .as_ref()
        .map(|w| w.id.clone())
        .unwrap_or_else(|| format!("ws-{}", chrono_like()));
    cfg.workspace = Some(WorkspaceConfig {
        id,
        name,
        roots: root_paths,
    });
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    ensure_host(&state)
}

fn chrono_like() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
struct AgentTurnReq {
    session_id: String,
    text: String,
    /// Force offline retrieval (no LLM).
    #[serde(default)]
    force_local: bool,
    /// Optional per-turn / per-chat model override.
    #[serde(default)]
    chat_model: Option<String>,
    /// Optional provider profile id when model is chosen from a non-active source.
    #[serde(default)]
    provider_profile_id: Option<String>,
    /// Session-pinned skill id (#343); inject playbook when set.
    #[serde(default)]
    pinned_skill_id: Option<String>,
    /// Present only for a turn started from a Log Explorer linked chat.
    #[serde(default)]
    log_explorer_context: Option<LogExplorerTurnContextReq>,
}

#[derive(Debug, Deserialize)]
struct LogExplorerTurnContextReq {
    corpus_id: String,
    brief: String,
}

fn validate_log_explorer_turn_context(
    session: &Session,
    window_id: &str,
    request: LogExplorerTurnContextReq,
) -> Result<cd_core::agent::LogExplorerTurnContext, String> {
    if session.linked_corpus_id.as_deref() != Some(request.corpus_id.as_str()) {
        return Err("Log Explorer context does not match this chat session's linked corpus".into());
    }
    cd_core::agent::LogExplorerTurnContext::new(window_id, request.corpus_id, request.brief)
        .map_err(|e| e.to_string())
}

fn linked_log_turn_context(
    session: Option<&Session>,
    window_id: &str,
    explorer_request: Option<LogExplorerTurnContextReq>,
) -> Result<Option<cd_core::agent::LogExplorerTurnContext>, String> {
    if let Some(request) = explorer_request {
        let session =
            session.ok_or_else(|| "Log Explorer chat session is not available".to_string())?;
        return validate_log_explorer_turn_context(session, window_id, request).map(Some);
    }
    session
        .and_then(|session| session.linked_corpus_id.as_deref())
        .map(cd_core::agent::LogExplorerTurnContext::for_main_chat)
        .transpose()
        .map_err(|error| error.to_string())
}

fn load_session_for_turn(
    store: &cd_core::sessions::SessionStore,
    session_id: &str,
) -> Result<Option<Session>, String> {
    match store.load(session_id) {
        Ok(session) => Ok(Some(session)),
        Err(error) => {
            if store.exists(session_id).map_err(|e| e.to_string())? {
                Err(format!(
                    "Chat session is unavailable or corrupt; the turn stopped before provider contact: {error}"
                ))
            } else {
                // A never-sent ordinary draft is intentionally ephemeral. It
                // cannot carry a durable linked corpus.
                Ok(None)
            }
        }
    }
}

fn skill_dirs_for(state: &AppState, cfg: &AppConfig) -> Vec<std::path::PathBuf> {
    let config_dir = ensure_config_dir(&state.branding).ok();
    let roots: Vec<_> = cfg
        .workspace
        .as_ref()
        .map(|w| w.roots.clone())
        .unwrap_or_default();
    cd_core::skills::default_skill_dirs(config_dir.as_deref(), &roots)
}

#[derive(Debug, Serialize)]
struct SkillDto {
    id: String,
    name: String,
    description: String,
    disabled: bool,
    allows_write: bool,
    path: String,
    /// True when a sibling `module.toml` is present (#137).
    has_module: bool,
    module_id: Option<String>,
}

fn skill_to_dto(s: cd_core::skills::Skill) -> SkillDto {
    let module_id = cd_core::skills::skill_module_toml_path(&s)
        .and_then(|p| cd_core::modules::parse_module_file(&p).ok().map(|m| m.id));
    SkillDto {
        has_module: module_id.is_some(),
        module_id,
        id: s.id,
        name: s.name,
        description: s.description,
        disabled: s.disabled,
        allows_write: s.allows_write,
        path: s.path.display().to_string(),
    }
}

#[tauri::command]
fn list_skills_cmd(state: State<'_, AppState>) -> Result<Vec<SkillDto>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let dirs = skill_dirs_for(&state, &cfg);
    let skills = cd_core::skills::discover_skills(&dirs).map_err(|e| e.to_string())?;
    Ok(skills.into_iter().map(skill_to_dto).collect())
}

/// Result of enabling/disabling a skill (#137). May also request module capability approval.
#[derive(Debug, Serialize)]
struct SetSkillEnabledResult {
    id: String,
    enabled: bool,
    /// When enabling a skill that ships `module.toml`, module may need #135 approval.
    needs_module_approval: bool,
    module_id: Option<String>,
    preview: Option<String>,
    reason: Option<String>,
    type_confirm_phrase: Option<String>,
}

/// Persist skill enabled flag; when enabling a skill that ships `module.toml`,
/// install into the modules dir and request first-use capability approval (#135/#136/#137).
#[tauri::command]
fn set_skill_enabled_cmd(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<SetSkillEnabledResult, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("skill id required".into());
    }
    let cfg = state.config.lock().expect("config").clone();
    let dirs = skill_dirs_for(&state, &cfg);
    let skill =
        cd_core::skills::set_skill_enabled(&dirs, &id, enabled).map_err(|e| e.to_string())?;

    if !enabled {
        // Disabling the skill does not force-remove the module install; user manages Modules.
        return Ok(SetSkillEnabledResult {
            id: skill.id,
            enabled: false,
            needs_module_approval: false,
            module_id: None,
            preview: None,
            reason: None,
            type_confirm_phrase: None,
        });
    }

    // Optional tool-shipping: provision sibling module.toml through #136 path.
    let Some(src_dir) = cd_core::skills::skill_module_src_dir(&skill) else {
        return Ok(SetSkillEnabledResult {
            id: skill.id,
            enabled: true,
            needs_module_approval: false,
            module_id: None,
            preview: None,
            reason: None,
            type_confirm_phrase: None,
        });
    };

    let mdir = modules_dir(&state)?;
    let m =
        cd_core::modules::install_module_from_dir(&src_dir, &mdir).map_err(|e| e.to_string())?;
    let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
        .map_err(|e| e.to_string())?;

    if !cd_core::modules::module_tools_allowed(&m, &grants) {
        let req = cd_core::modules::permission_request_for_module_enable(&m);
        return Ok(SetSkillEnabledResult {
            id: skill.id,
            enabled: true,
            needs_module_approval: true,
            module_id: Some(m.id),
            preview: Some(req.preview.clone()),
            reason: Some(req.reason.clone()),
            type_confirm_phrase: req.type_confirm_phrase.clone(),
        });
    }

    // Already granted or no caps required — enable module tools.
    {
        let mut cfg = state.config.lock().expect("config");
        if !cfg.enabled_modules.iter().any(|x| x == &m.id) {
            cfg.enabled_modules.push(m.id.clone());
        }
        let path = config_path(&state.branding).map_err(|e| e.to_string())?;
        save_config(&path, &cfg).map_err(|e| e.to_string())?;
    }
    let _ = ensure_host(&state);

    Ok(SetSkillEnabledResult {
        id: skill.id,
        enabled: true,
        needs_module_approval: false,
        module_id: Some(m.id),
        preview: None,
        reason: None,
        type_confirm_phrase: None,
    })
}

/// Module row for Settings (#136). No secrets.
#[derive(Clone, serde::Serialize)]
struct ModuleDto {
    id: String,
    name: String,
    version: String,
    enabled: bool,
    granted: bool,
    path: String,
    entrypoint: String,
    requested_filesystem_roots: Vec<String>,
    requested_network_hosts: Vec<String>,
    requested_secret_refs: Vec<String>,
    hard_write_tools: Vec<String>,
    provided_tools: Vec<String>,
}

fn modules_dir(state: &AppState) -> Result<std::path::PathBuf, String> {
    let config_dir = ensure_config_dir(&state.branding).map_err(|e| e.to_string())?;
    Ok(cd_core::modules::default_modules_dir(&config_dir))
}

fn grants_path(state: &AppState) -> Result<std::path::PathBuf, String> {
    let config_dir = ensure_config_dir(&state.branding).map_err(|e| e.to_string())?;
    Ok(config_dir.join("module_grants.json"))
}

#[tauri::command]
fn list_modules(state: State<'_, AppState>) -> Result<Vec<ModuleDto>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let dir = modules_dir(&state)?;
    let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
        .map_err(|e| e.to_string())?;
    let found = cd_core::modules::discover_modules(&[dir]).map_err(|e| e.to_string())?;
    Ok(found
        .into_iter()
        .map(|m| ModuleDto {
            enabled: cfg.enabled_modules.iter().any(|x| x == &m.id),
            granted: grants.is_granted(&m.id),
            path: m.path.display().to_string(),
            entrypoint: m.entrypoint.command.display().to_string(),
            requested_filesystem_roots: m
                .requested_capabilities
                .filesystem_roots
                .iter()
                .map(|p| p.display().to_string())
                .collect(),
            requested_network_hosts: m.requested_capabilities.network_hosts,
            requested_secret_refs: m.requested_capabilities.secret_refs,
            hard_write_tools: m.hard_write_tools,
            provided_tools: m.provided_tools.iter().map(|t| t.name.clone()).collect(),
            id: m.id,
            name: m.name,
            version: m.version,
        })
        .collect())
}

/// Install from a **local** directory only (NON_GOALS #7 — no network install).
#[tauri::command]
fn install_module(state: State<'_, AppState>, path: String) -> Result<ModuleDto, String> {
    let src = std::path::PathBuf::from(path.trim());
    let dir = modules_dir(&state)?;
    let m = cd_core::modules::install_module_from_dir(&src, &dir).map_err(|e| e.to_string())?;
    let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
        .map_err(|e| e.to_string())?;
    Ok(ModuleDto {
        enabled: false,
        granted: grants.is_granted(&m.id),
        path: m.path.display().to_string(),
        entrypoint: m.entrypoint.command.display().to_string(),
        requested_filesystem_roots: m
            .requested_capabilities
            .filesystem_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
        requested_network_hosts: m.requested_capabilities.network_hosts,
        requested_secret_refs: m.requested_capabilities.secret_refs,
        hard_write_tools: m.hard_write_tools,
        provided_tools: m.provided_tools.iter().map(|t| t.name.clone()).collect(),
        id: m.id,
        name: m.name,
        version: m.version,
    })
}

#[derive(Clone, serde::Serialize)]
struct SetModuleEnabledResult {
    enabled: bool,
    /// When true, UI must show permission modal before tools attach.
    needs_approval: bool,
    module_id: String,
    risk: String,
    type_confirm_phrase: Option<String>,
    preview: String,
    reason: String,
    request_id: String,
}

#[tauri::command]
fn set_module_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<SetModuleEnabledResult, String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("module id required".into());
    }
    let dir = modules_dir(&state)?;
    let found = cd_core::modules::discover_modules(&[dir]).map_err(|e| e.to_string())?;
    let m = found
        .into_iter()
        .find(|x| x.id == id)
        .ok_or_else(|| format!("module `{id}` not installed"))?;

    if enabled {
        let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
            .map_err(|e| e.to_string())?;
        if !cd_core::modules::module_tools_allowed(&m, &grants) {
            let req = cd_core::modules::permission_request_for_module_enable(&m);
            return Ok(SetModuleEnabledResult {
                enabled: false,
                needs_approval: true,
                module_id: m.id,
                risk: req.risk,
                type_confirm_phrase: req.type_confirm_phrase,
                preview: req.preview,
                reason: req.reason,
                request_id: req.request_id,
            });
        }
        let mut cfg = state.config.lock().expect("config");
        if !cfg.enabled_modules.iter().any(|x| x == &id) {
            cfg.enabled_modules.push(id.clone());
        }
        let path = config_path(&state.branding).map_err(|e| e.to_string())?;
        save_config(&path, &cfg).map_err(|e| e.to_string())?;
        drop(cfg);
        let _ = ensure_host(&state);
        return Ok(SetModuleEnabledResult {
            enabled: true,
            needs_approval: false,
            module_id: id,
            risk: "local".into(),
            type_confirm_phrase: None,
            preview: String::new(),
            reason: String::new(),
            request_id: String::new(),
        });
    }

    // Disable
    let mut cfg = state.config.lock().expect("config");
    cfg.enabled_modules.retain(|x| x != &id);
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(SetModuleEnabledResult {
        enabled: false,
        needs_approval: false,
        module_id: id,
        risk: "local".into(),
        type_confirm_phrase: None,
        preview: String::new(),
        reason: String::new(),
        request_id: String::new(),
    })
}

/// Complete first-use module capability approval (#135/#136) then enable.
#[tauri::command]
fn approve_module_enable(
    state: State<'_, AppState>,
    id: String,
    decision: String,
    typed: Option<String>,
) -> Result<bool, String> {
    let id = id.trim().to_string();
    let dir = modules_dir(&state)?;
    let found = cd_core::modules::discover_modules(&[dir]).map_err(|e| e.to_string())?;
    let m = found
        .into_iter()
        .find(|x| x.id == id)
        .ok_or_else(|| format!("module `{id}` not installed"))?;
    let req = cd_core::modules::permission_request_for_module_enable(&m);
    let dec = match decision.as_str() {
        "deny" => cd_core::permissions::PermissionDecision::Deny,
        "allow_once" => cd_core::permissions::PermissionDecision::AllowOnce,
        "allow_session_path" => cd_core::permissions::PermissionDecision::AllowSessionPath,
        _ => return Err("invalid decision".into()),
    };
    cd_core::permissions::validate_decision(&req, dec, typed.as_deref())?;
    if matches!(dec, cd_core::permissions::PermissionDecision::Deny) {
        return Ok(false);
    }
    let gpath = grants_path(&state)?;
    let mut grants = cd_core::modules::ModuleGrantStore::load(&gpath).map_err(|e| e.to_string())?;
    grants
        .grant_from_ui(&m.id, m.requested_capabilities.clone(), dec)
        .map_err(|e| e.to_string())?;
    grants.save(&gpath).map_err(|e| e.to_string())?;

    let mut cfg = state.config.lock().expect("config");
    if !cfg.enabled_modules.iter().any(|x| x == &id) {
        cfg.enabled_modules.push(id);
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let _ = ensure_host(&state);
    Ok(true)
}

#[tauri::command]
fn remove_module(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    let id = id.trim().to_string();
    let mut cfg = state.config.lock().expect("config");
    cfg.enabled_modules.retain(|x| x != &id);
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    drop(cfg);
    let dir = modules_dir(&state)?;
    cd_core::modules::remove_module_dir(&dir, &id).map_err(|e| e.to_string())?;
    let gpath = grants_path(&state)?;
    if let Ok(mut grants) = cd_core::modules::ModuleGrantStore::load(&gpath) {
        grants.revoke(&id);
        let _ = grants.save(&gpath);
    }
    let _ = ensure_host(&state);
    Ok(true)
}

/// Module registry settings (#139). Empty URL by default; no company hardcode.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModuleRegistrySettingsDto {
    enabled: bool,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
struct ModuleRegistryEntryDto {
    id: String,
    name: String,
    version: String,
    description: String,
    homepage: Option<String>,
    local_path: Option<String>,
    /// True when Install can hand off to #136 with a local path.
    can_install_local: bool,
}

/// Get registry browse settings (defaults: disabled, empty URL).
#[tauri::command]
fn get_module_registry_settings(
    state: State<'_, AppState>,
) -> Result<ModuleRegistrySettingsDto, String> {
    let cfg = state.config.lock().expect("config");
    Ok(ModuleRegistrySettingsDto {
        enabled: cfg.module_registry_enabled,
        url: cfg.module_registry_url.clone(),
    })
}

/// Persist registry opt-in + URL. Does **not** fetch or install (NON_GOALS #7).
#[tauri::command]
fn set_module_registry_settings(
    state: State<'_, AppState>,
    enabled: bool,
    url: String,
) -> Result<ModuleRegistrySettingsDto, String> {
    let url = url.trim().to_string();
    if enabled && !url.is_empty() {
        // SSRF gate on save so bad URLs fail early (no fetch yet).
        cd_core::module_registry::validate_registry_fetch_url(&url, &SsrfPolicy::default())
            .map_err(|e| e.to_string())?;
    }
    let mut cfg = state.config.lock().expect("config");
    cfg.module_registry_enabled = enabled;
    cfg.module_registry_url = url.clone();
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    Ok(ModuleRegistrySettingsDto { enabled, url })
}

/// Browse registry **metadata only** (#139).
///
/// Never installs or executes modules (docs/NON_GOALS.md #7). Remote fetch uses
/// SSRF-pinned HTTP when enabled; optional `file_path` loads a local JSON index
/// (offline browse; no code execution).
#[tauri::command]
async fn browse_module_registry(
    state: State<'_, AppState>,
    file_path: Option<String>,
) -> Result<Vec<ModuleRegistryEntryDto>, String> {
    let idx = if let Some(fp) = file_path
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        // Local JSON only — still metadata; does not install.
        let text = std::fs::read_to_string(fp).map_err(|e| format!("read registry file: {e}"))?;
        cd_core::module_registry::parse_registry_json(&text).map_err(|e| e.to_string())?
    } else {
        let cfg = state.config.lock().expect("config").clone();
        if !cd_core::module_registry::registry_browse_enabled(
            cfg.module_registry_enabled,
            &cfg.module_registry_url,
        ) {
            return Err(
                "registry browse is disabled (enable and set a URL, or pass a local file path)"
                    .into(),
            );
        }
        // Network: metadata JSON only — never module code / install (NON_GOALS #7).
        cd_core::module_registry::fetch_registry_index(
            &cfg.module_registry_url,
            &SsrfPolicy::default(),
        )
        .await
        .map_err(|e| e.to_string())?
    };
    Ok(idx
        .entries
        .into_iter()
        .map(|e| {
            let can = cd_core::module_registry::install_path_for_entry(&e).is_some();
            ModuleRegistryEntryDto {
                id: e.id,
                name: e.name,
                version: e.version,
                description: e.description,
                homepage: e.homepage,
                local_path: e.local_path,
                can_install_local: can,
            }
        })
        .collect())
}

/// Re-install from a local path (same id); local only (NON_GOALS #7).
#[tauri::command]
fn update_module(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<ModuleDto, String> {
    let id = id.trim().to_string();
    let src = std::path::PathBuf::from(path.trim());
    let dir = modules_dir(&state)?;
    let m = cd_core::modules::update_module_from_dir(&src, &dir).map_err(|e| e.to_string())?;
    if m.id != id {
        return Err(format!(
            "source module id `{}` does not match update target `{id}`",
            m.id
        ));
    }
    let grants = cd_core::modules::ModuleGrantStore::load(&grants_path(&state)?)
        .map_err(|e| e.to_string())?;
    let cfg = state.config.lock().expect("config");
    Ok(ModuleDto {
        enabled: cfg.enabled_modules.iter().any(|x| x == &m.id),
        granted: grants.is_granted(&m.id),
        path: m.path.display().to_string(),
        entrypoint: m.entrypoint.command.display().to_string(),
        requested_filesystem_roots: m
            .requested_capabilities
            .filesystem_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect(),
        requested_network_hosts: m.requested_capabilities.network_hosts,
        requested_secret_refs: m.requested_capabilities.secret_refs,
        hard_write_tools: m.hard_write_tools,
        provided_tools: m.provided_tools.iter().map(|t| t.name.clone()).collect(),
        id: m.id,
        name: m.name,
        version: m.version,
    })
}

/// Propose authoring a skill via the SoftWrite tool host path (PermissionRequired).
/// Does **not** write until the UI completes the grant and re-executes.
#[tauri::command]
async fn propose_save_skill_cmd(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: String,
    body: String,
    allows_write: bool,
) -> Result<Vec<EventDto>, String> {
    ensure_host(&state)?;
    // #114: do not hold MutexGuard across `.await` (Send bound).
    let mut host = {
        let mut host_guard = state.host.lock().expect("host");
        host_guard.take().ok_or("host missing")?
    };
    let args = serde_json::json!({
        "id": id,
        "name": name,
        "description": description,
        "body_markdown": body,
        "allows_write": allows_write,
    });
    let result = host
        .execute(cd_core::tools::names::SAVE_SKILL, &args, None)
        .await
        .map_err(|e| e.to_string());
    {
        let mut host_guard = state.host.lock().expect("host");
        *host_guard = Some(host);
    }
    let result = result?;
    Ok(events_to_dto(&result.events))
}

fn event_to_dto_with_linked_corpus(
    event: &cd_core::events::StreamEvent,
    linked_corpus_id: Option<&str>,
) -> EventDto {
    let mut dto = cd_core::research::event_to_dto(event);
    let is_log_citation = matches!(
        event,
        cd_core::events::StreamEvent::Citation { source_id, .. }
            if source_id.starts_with("log_template:") || source_id.starts_with("log_event:")
    );
    if is_log_citation {
        if let (Some(corpus_id), Some(payload)) = (linked_corpus_id, dto.payload.as_object_mut()) {
            payload.insert(
                "corpus_id".into(),
                serde_json::Value::String(corpus_id.to_string()),
            );
        }
    }
    dto
}

#[tauri::command]
async fn agent_turn(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    req: AgentTurnReq,
    on_event: tauri::ipc::Channel<EventDto>,
) -> Result<(), String> {
    let cfg = state.config.lock().expect("config").clone();
    let skill_dirs = skill_dirs_for(&state, &cfg);
    let mut user_text = req.text.clone();
    // Inject skill playbook (slash or session pin #343). Skills cannot elevate grants.
    if let Ok(skills) = cd_core::skills::discover_skills(&skill_dirs) {
        // Prefer pure helper so pin + slash share one path.
        user_text = cd_core::skills::apply_pinned_skill_to_user_text(
            &user_text,
            req.pinned_skill_id.as_deref(),
            &skills,
        );
        // Slash still needs full inject when present (apply_pinned leaves slash text alone).
        if let Some((sid, rest)) = cd_core::skills::parse_skill_slash(&user_text) {
            if let Some(sk) = cd_core::skills::find_skill(&skills, &sid) {
                if !sk.disabled {
                    let ctx = cd_core::skills::skill_context(sk);
                    user_text = if rest.is_empty() {
                        format!("{ctx}\n\nApply this skill to the workspace context.")
                    } else {
                        format!("{ctx}\n\nUser question: {rest}")
                    };
                }
            }
        }
    }
    let mut profile = if let Some(pid) = req
        .provider_profile_id
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        cfg.providers
            .profiles
            .iter()
            .find(|p| p.id == pid)
            .cloned()
            .or_else(|| cfg.providers.active().cloned())
            .unwrap_or_else(ProviderProfile::ollama_local)
    } else {
        cfg.providers
            .active()
            .cloned()
            .unwrap_or_else(ProviderProfile::ollama_local)
    };
    // Per-chat model override (mid-chat switch), else app default, else profile model.
    if let Some(m) = req
        .chat_model
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        // Accept bare model id or provider::model selection key.
        let (_pid, mid) = parse_selection_key(m);
        profile.chat_model = mid;
    } else if let Some(m) = cfg
        .default_chat_model
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        profile.chat_model = m.to_string();
    }
    profile.capabilities.tools = model_tools_enabled(&cfg, &profile, profile.chat_model.as_str());
    let api_key = profile
        .api_key_ref
        .as_ref()
        .and_then(|r| state.secrets.get(r).ok().flatten());

    // Resolve the linked corpus only from the durable session. Explorer may
    // contribute a bounded viewport brief, but neither the model nor an
    // ordinary main-chat turn request chooses or broadens corpus scope.
    let store = session_store(&state)?;
    let stored_session = load_session_for_turn(&store, &req.session_id)?;
    let log_explorer_context = linked_log_turn_context(
        stored_session.as_ref(),
        window.label(),
        req.log_explorer_context,
    )?;

    // Validate the durable corpus before capability checks or provider/host
    // construction. A stale link must never be masked by a tools-disabled
    // profile or silently broadened into an ordinary turn.
    if let Some(context) = log_explorer_context.as_ref() {
        let cache = log_cache_dir(&state)?;
        let tools_profile = (!req.force_local).then_some(&profile);
        if let Some(events) =
            linked_log_preflight_at(&cache, context, tools_profile, &req.session_id)
        {
            for event in events {
                let _ = on_event.send(cd_core::research::event_to_dto(&event));
            }
            return Ok(());
        }
    }

    // Linked log turns never join optional workspace/memory initialization.
    // They take an already-published full host when immediately available and
    // otherwise use an independent turn-local read-only log host.
    let (mut host, using_fallback_host, borrowed_host_generation) =
        if let Some(context) = log_explorer_context.as_ref() {
            match take_ready_linked_host(&state.host, &state.host_generation, || {
                build_linked_log_fallback_host(&state, context)
            }) {
                Ok((host, using_fallback, borrowed_generation)) => {
                    if using_fallback {
                        let notice = linked_log_fallback_notice();
                        let _ = on_event.send(cd_core::research::event_to_dto(&notice));
                    }
                    (host, using_fallback, borrowed_generation)
                }
                Err(error) => {
                    tracing::warn!(error = %error, "linked log-only fallback construction failed");
                    for event in linked_log_host_terminal_events() {
                        let _ = on_event.send(cd_core::research::event_to_dto(&event));
                    }
                    return Ok(());
                }
            }
        } else {
            let app = window.app_handle().clone();
            if let Err(failure) = wait_for_host_readiness(AGENT_HOST_READY_TIMEOUT, move || {
                let state = app.state::<AppState>();
                ensure_host(&state)
            })
            .await
            {
                for event in host_readiness_terminal_events(&failure) {
                    let _ = on_event.send(cd_core::research::event_to_dto(&event));
                }
                return Ok(());
            }
            let mut host_guard = state.host.lock().expect("host");
            let borrowed_generation = state
                .host_generation
                .load(std::sync::atomic::Ordering::SeqCst);
            (
                host_guard.take().ok_or("host missing")?,
                false,
                Some(borrowed_generation),
            )
        };

    let mut history = {
        let mut histories = state.histories.lock().expect("hist");
        histories.entry(req.session_id.clone()).or_default().clone()
    };

    // Fresh cancel flag for this turn (#109).
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        cancels.insert(req.session_id.clone(), cancel.clone());
    }

    let channel = on_event;
    let linked_citation_corpus = log_explorer_context
        .as_ref()
        .map(|context| context.corpus_id.clone());
    let mut sink = |ev: cd_core::events::StreamEvent| {
        let dto = event_to_dto_with_linked_corpus(&ev, linked_citation_corpus.as_deref());
        let _ = channel.send(dto);
    };

    // #114: host was taken out of the mutex before this awaitable turn.
    // Bind session context pack for this turn (#341): search_kb / read_file_slice.
    if !using_fallback_host {
        if let Ok(base) = session_context_base(&state) {
            host.set_session_context_base(Some(base));
        }
    }
    host.set_active_session_id(Some(req.session_id.clone()));
    // Linked turns bind the turn-scoped corpus; ordinary chats must not inherit
    // Explorer ambient active corpus for the duration of the turn (#530).
    let previous_log_corpus = host.active_log_corpus().map(str::to_string);
    let previous_log_scope = host.log_corpus_scope().map(str::to_string);
    if let Some(context) = log_explorer_context.as_ref() {
        host.set_log_corpus_scope(Some(context.corpus_id.clone()));
        host.set_active_log_corpus(Some(context.corpus_id.clone()));
    } else {
        host.set_log_corpus_scope(None);
        host.set_active_log_corpus(None);
    }
    let result = if req.force_local {
        let ev = cd_core::research::research_local_with_skills(
            &mut host,
            &user_text,
            &req.session_id,
            &skill_dirs,
        )
        .await
        .map_err(|e| e.to_string());
        if let Ok(ref events) = ev {
            for e in events {
                sink(e.clone());
            }
        }
        ev
    } else {
        cd_core::research::research_turn_with_cancel_and_context(
            &mut host,
            &profile,
            api_key,
            &user_text,
            &mut history,
            &req.session_id,
            false,
            Some(cancel.clone()),
            log_explorer_context,
            Some(&mut sink),
        )
        .await
        .map_err(|e| e.to_string())
    };
    if !using_fallback_host {
        host.set_log_corpus_scope(previous_log_scope);
        host.set_active_log_corpus(previous_log_corpus);
        if !restore_host_if_generation_matches(
            &state.host,
            &state.host_generation,
            borrowed_host_generation.expect("shared host generation"),
            host,
        ) {
            tracing::info!("discarding turn host replaced by a newer host generation");
        }
    }

    // #327/#650: a gateway/model rejected tools. Persist the exact model as
    // chat-only without poisoning tools-capable siblings behind the profile.
    // Also persist per-model context budgets learned from context-length failures.
    if let Ok(ref events) = result {
        if cd_core::providers::events_indicate_tools_unsupported(events)
            && profile.capabilities.tools
        {
            let mut cfg = state.config.lock().expect("config").clone();
            cfg.model_tools_enabled
                .insert(model_selection_key(&profile.id, &profile.chat_model), false);
            if let Ok(path) = config_path(&state.branding) {
                let _ = save_config(&path, &cfg);
                *state.config.lock().expect("config") = cfg;
            }
        }
        let mut learned_any = false;
        let mut cfg = state.config.lock().expect("config").clone();
        for e in events {
            if let cd_core::events::StreamEvent::Error { code, message } = e {
                if code == "context_budget_learned" {
                    // message: model=… chars_sent=N note=…
                    let model = message
                        .split_whitespace()
                        .find_map(|p| p.strip_prefix("model="))
                        .unwrap_or(profile.chat_model.as_str());
                    let chars_sent = message
                        .split_whitespace()
                        .find_map(|p| p.strip_prefix("chars_sent="))
                        .and_then(|s| s.parse::<usize>().ok())
                        .unwrap_or(0);
                    let note = message
                        .split_once("note=")
                        .map(|(_, n)| n)
                        .unwrap_or("context_length");
                    if chars_sent > 0
                        && cfg
                            .model_context_budgets
                            .learn_from_context_error(Some(model), chars_sent, note)
                            .is_some()
                    {
                        learned_any = true;
                    }
                }
            }
        }
        if learned_any {
            if let Ok(path) = config_path(&state.branding) {
                let _ = save_config(&path, &cfg);
                *state.config.lock().expect("config") = cfg.clone();
            }
            // Keep live host budgets in sync.
            if let Ok(mut hg) = state.host.lock() {
                if let Some(h) = hg.as_mut() {
                    h.set_model_context_budgets(cfg.model_context_budgets.clone());
                }
            }
        }
    }

    {
        let mut cancels = state.cancels.lock().expect("cancels");
        cancels.remove(&req.session_id);
    }
    {
        let mut histories = state.histories.lock().expect("hist");
        histories.insert(req.session_id.clone(), history);
    }
    result.map(|_| ())
}

/// Signal cooperative cancel for an in-flight turn (#109).
#[tauri::command]
fn cancel_turn(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let cancels = state.cancels.lock().expect("cancels");
    if let Some(flag) = cancels.get(&session_id) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(())
}

/// List durable chat sessions (newest first).
#[tauri::command]
fn list_chat_sessions(state: State<'_, AppState>) -> Result<Vec<SessionMeta>, String> {
    session_store(&state)?
        .list_meta()
        .map_err(|e| e.to_string())
}

/// Load one session and seed in-memory agent history.
#[tauri::command]
fn load_chat_session(state: State<'_, AppState>, id: String) -> Result<Session, String> {
    let store = session_store(&state)?;
    let session = store.load(&id).map_err(|e| e.to_string())?;
    seed_history_from_session(&state, &session);
    Ok(session)
}

/// Persist full UI session (auto-save path). Seeds agent history.
fn should_persist_chat_session(session: &Session) -> bool {
    // Ordinary empty drafts stay ephemeral. An explicitly corpus-linked chat is
    // different: the user created it from Log Explorer and the link itself is
    // durable state needed before the first agent turn.
    !session.messages.is_empty() || session.linked_corpus_id.is_some()
}

fn save_chat_session_at(
    store: &cd_core::sessions::SessionStore,
    mut session: Session,
) -> Result<Session, String> {
    // The renderer owns transcript/view fields, but never the governed corpus
    // grant. Preserve the durable host value for an existing chat and strip an
    // attempted grant from a new chat; only set_chat_linked_corpus may change it.
    if store.exists(&session.id).map_err(|e| e.to_string())? {
        let durable = store
            .load(&session.id)
            .map_err(|e| format!("chat session is unavailable or corrupt: {e}"))?;
        session.linked_corpus_id = durable.linked_corpus_id;
    } else {
        session.linked_corpus_id = None;
    }
    session.maybe_auto_title_from_first_user();
    session.touch();
    if should_persist_chat_session(&session) {
        store.save(&session).map_err(|e| e.to_string())?;
    }
    Ok(session)
}

#[tauri::command]
fn save_chat_session(state: State<'_, AppState>, session: Session) -> Result<Session, String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    let store = session_store(&state)?;
    let session = save_chat_session_at(&store, session)?;
    seed_history_from_session(&state, &session);
    Ok(session)
}

/// Rename session; locks auto-title when title is non-placeholder.
#[tauri::command]
fn rename_chat_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<Session, String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    let store = session_store(&state)?;
    let mut session = store.load(&id).map_err(|e| e.to_string())?;
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("title cannot be empty".into());
    }
    session.title = title;
    session.title_locked = !cd_core::sessions::is_placeholder_title(&session.title);
    session.touch();
    store.save(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

/// Soft-delete: move session to trash (recoverable).
#[tauri::command]
fn trash_chat_session(state: State<'_, AppState>, id: String) -> Result<Session, String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    let session = session_store(&state)?
        .trash(&id)
        .map_err(|e| e.to_string())?;
    let mut histories = state.histories.lock().expect("hist");
    histories.remove(&id);
    Ok(session)
}

/// Restore a session from trash.
#[tauri::command]
fn restore_chat_session(state: State<'_, AppState>, id: String) -> Result<Session, String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    session_store(&state)?
        .restore_from_trash(&id)
        .map_err(|e| e.to_string())
}

/// Permanently delete session file and drop in-memory history.
/// Also purges session-scoped context pack files (#341).
#[tauri::command]
fn delete_chat_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    // Best-effort purge of session context pack before removing session metadata (#341).
    if let Ok(base) = session_context_base(&state) {
        let _ = cd_core::session_context::purge_session_at(&base, &id);
    }
    session_store(&state)?
        .delete(&id)
        .map_err(|e| e.to_string())?;
    let mut histories = state.histories.lock().expect("hist");
    histories.remove(&id);
    Ok(())
}

/// Pin / unpin a chat for the sidebar.
#[tauri::command]
fn pin_chat_session(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<Session, String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    let store = session_store(&state)?;
    let mut session = store.load(&id).map_err(|e| e.to_string())?;
    session.pinned = pinned;
    session.touch();
    store.save(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

/// Soft-archive / unarchive a chat.
#[tauri::command]
fn archive_chat_session(
    state: State<'_, AppState>,
    id: String,
    archived: bool,
) -> Result<Session, String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    let store = session_store(&state)?;
    let mut session = store.load(&id).map_err(|e| e.to_string())?;
    session.archived = archived;
    if archived {
        session.pinned = false;
    }
    session.touch();
    store.save(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

/// Keyword search across the chat archive (title + body scoring).
#[tauri::command]
fn search_chat_sessions(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    include_archived: Option<bool>,
    include_trashed: Option<bool>,
    only_trashed: Option<bool>,
) -> Result<Vec<SessionSearchHit>, String> {
    session_store(&state)?
        .search(
            &query,
            limit.unwrap_or(50),
            include_archived.unwrap_or(false),
            include_trashed.unwrap_or(false),
            only_trashed.unwrap_or(false),
        )
        .map_err(|e| e.to_string())
}

/// A selectable chat model for the UI (grouped by provider source).
#[derive(Debug, Clone, Serialize)]
struct ModelOptionDto {
    /// Model id as sent to the API (e.g. `grok-3`, `mistral`).
    id: String,
    /// Display label (usually same as id).
    label: String,
    /// Unique select value: `provider_id::model_id`.
    selection_key: String,
    /// Provider profile this model belongs to.
    provider_id: String,
    /// Human group label for `<optgroup>` (e.g. "Ollama (local)").
    provider_label: String,
    /// Stable group key for sorting/grouping.
    group: String,
    /// True when this is the app default for new chats.
    is_default: bool,
    /// Whether this exact provider/model pair can execute native tools.
    tools_enabled: bool,
    /// `profile` for explicit profile disablement or `model` for a learned
    /// provider/model rejection. `None` means tools are enabled.
    tools_disabled_reason: Option<String>,
}

fn model_selection_key(provider_id: &str, model_id: &str) -> String {
    format!("{provider_id}::{model_id}")
}

fn parse_selection_key(key: &str) -> (Option<String>, String) {
    if let Some((pid, mid)) = key.split_once("::") {
        if !pid.is_empty() && !mid.is_empty() {
            return (Some(pid.to_string()), mid.to_string());
        }
    }
    (None, key.to_string())
}

fn model_tools_disabled_reason(
    cfg: &AppConfig,
    profile: &ProviderProfile,
    model_id: &str,
) -> Option<&'static str> {
    if !profile.capabilities.tools {
        return Some("profile");
    }
    if cfg
        .model_tools_enabled
        .get(&model_selection_key(&profile.id, model_id))
        == Some(&false)
    {
        return Some("model");
    }
    None
}

fn model_tools_enabled(cfg: &AppConfig, profile: &ProviderProfile, model_id: &str) -> bool {
    model_tools_disabled_reason(cfg, profile, model_id).is_none()
}

fn provider_group_label(p: &ProviderProfile) -> String {
    let desc = cd_core::providers::descriptor_for(p.kind);
    // Prefer a non-empty custom profile label for local/gateway groups.
    if !p.label.trim().is_empty()
        && matches!(
            p.kind,
            ProviderKind::Ollama | ProviderKind::OpenAiCompatible
        )
    {
        return p.label.clone();
    }
    desc.group_label.to_string()
}

/// Keep almost everything for the picker (TriageTool shows full catalogs).
/// Only drop clear non-chat tooling entries.
fn looks_like_chat_model_id(id: &str) -> bool {
    let l = id.to_ascii_lowercase();
    if l.contains("embed")
        || l.contains("text-embedding")
        || l.contains("whisper")
        || l.contains("tts-")
        || l.contains("dall-e")
        || l.contains("moderation")
        || l.contains("realtime")
        || l.contains("transcri")
        || l.contains("speech")
    {
        return false;
    }
    // "image" alone is too aggressive (filters valid vision/chat names);
    // only drop explicit image-generation product ids.
    if l.contains("dall") || l.starts_with("image-") || l.contains("-image-") {
        return false;
    }
    true
}

fn resolve_default_model(cfg: &AppConfig) -> String {
    if let Some(m) = cfg
        .default_chat_model
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return m.to_string();
    }
    cfg.providers
        .active()
        .map(|p| p.chat_model.clone())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "mistral".into())
}

fn resolve_default_selection(cfg: &AppConfig) -> String {
    let model = resolve_default_model(cfg);
    let pid = cfg
        .providers
        .active()
        .map(|p| p.id.as_str())
        .unwrap_or("ollama-local");
    model_selection_key(pid, &model)
}

async fn models_for_profile(
    profile: &ProviderProfile,
    secrets: &KeychainSecretStore,
) -> Vec<String> {
    let api_key = profile
        .api_key_ref
        .as_ref()
        .and_then(|r| secrets.get(r).ok().flatten());
    models_for_profile_with_key(profile, api_key.as_deref()).await
}

/// List chat models for the **Settings draft** (not only the saved profile).
#[derive(Debug, Deserialize)]
struct ListModelsDraftReq {
    kind: String,
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    local_only: Option<bool>,
    #[serde(default)]
    chat_model: Option<String>,
}

/// Resolve draft/keychain key for a provider kind (never logs).
fn resolve_draft_api_key(
    state: &AppState,
    kind: ProviderKind,
    draft_key: Option<&str>,
) -> Option<String> {
    if matches!(kind, ProviderKind::XaiGrokBuild | ProviderKind::Ollama) {
        return None;
    }
    let draft = draft_key
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.chars().all(|c| c == '•'))
        .map(|s| s.to_string());
    if draft.is_some() {
        return draft;
    }
    let desc = cd_core::providers::descriptor_for(kind);
    let id = desc.profile_id_slug;
    let r = key_ref_for_profile(id);
    if let Ok(Some(k)) = state.secrets.get(&r) {
        return Some(k);
    }
    let cfg = state.config.lock().expect("config");
    cfg.providers
        .profiles
        .iter()
        .find(|p| p.id == id)
        .and_then(|p| p.api_key_ref.as_ref())
        .and_then(|r| state.secrets.get(r).ok().flatten())
}

/// TriageTool-parity gateway probe (plain HTTP, multi-path, Bearer + x-api-key).
#[derive(Debug, Deserialize)]
struct ProbeAiGatewayReq {
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    /// When true (default), also probe local Ollama.
    #[serde(default)]
    probe_local: Option<bool>,
}

#[tauri::command]
async fn probe_ai_gateway_cmd(
    state: State<'_, AppState>,
    req: ProbeAiGatewayReq,
) -> Result<cd_core::ai_probe::AiProbeResult, String> {
    let draft = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.chars().all(|c| c == '•'));
    // Prefer draft key; else try keychain for either remote flavor.
    let key = if let Some(k) = draft {
        Some(k.to_string())
    } else {
        resolve_draft_api_key(&state, ProviderKind::OpenAiCompatible, None)
            .or_else(|| resolve_draft_api_key(&state, ProviderKind::Anthropic, None))
    };
    let probe_local = req.probe_local.unwrap_or(true);
    let result =
        cd_core::ai_probe::probe_ai_gateway(&req.base_url, key.as_deref(), probe_local).await;
    // Persist catalog-declared context windows when present.
    let mut any = false;
    let mut cfg = state.config.lock().expect("config").clone();
    for m in result.models.iter().chain(result.chat_candidates.iter()) {
        if let Some(tok) = m.context_tokens {
            cfg.model_context_budgets.note_declared_tokens(&m.id, tok);
            any = true;
        }
    }
    if any {
        if let Ok(path) = config_path(&state.branding) {
            let _ = save_config(&path, &cfg);
            *state.config.lock().expect("config") = cfg.clone();
        }
        if let Ok(mut hg) = state.host.lock() {
            if let Some(h) = hg.as_mut() {
                h.set_model_context_budgets(cfg.model_context_budgets);
            }
        }
    }
    Ok(result)
}

#[tauri::command]
async fn list_models_for_draft(
    state: State<'_, AppState>,
    req: ListModelsDraftReq,
) -> Result<Vec<String>, String> {
    let kind = match req.kind.as_str() {
        "ollama" => ProviderKind::Ollama,
        "openai_compatible" => ProviderKind::OpenAiCompatible,
        "anthropic" => ProviderKind::Anthropic,
        "xai_grok_build" => ProviderKind::XaiGrokBuild,
        other => return Err(format!("unsupported provider kind: {other}")),
    };

    // Remote gateway / Ollama list: use TriageTool-parity probe (no SSRF pin).
    if matches!(
        kind,
        ProviderKind::OpenAiCompatible | ProviderKind::Anthropic | ProviderKind::Ollama
    ) {
        let key = resolve_draft_api_key(&state, kind, req.api_key.as_deref());
        let probe_local = matches!(kind, ProviderKind::Ollama)
            || req.base_url.contains("127.0.0.1")
            || req.base_url.to_lowercase().contains("localhost");
        let result =
            cd_core::ai_probe::probe_ai_gateway(&req.base_url, key.as_deref(), probe_local).await;
        // Prefer chat candidates; fall back to full model list.
        let mut ids: Vec<String> = if !result.chat_candidates.is_empty() {
            result.chat_candidates.into_iter().map(|m| m.id).collect()
        } else {
            result
                .models
                .into_iter()
                .filter(|m| m.kind != "embedding")
                .map(|m| m.id)
                .collect()
        };
        // If user forced a flavor that didn't match probe, still return what we got.
        if matches!(kind, ProviderKind::Ollama) && result.flavor.as_deref() != Some("ollama") {
            // Probe may have hit remote — still return ids if any.
        }
        if let Some(cm) = req
            .chat_model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if !ids.iter().any(|x| x == cm) {
                ids.insert(0, cm.to_string());
            }
        }
        ids.sort();
        ids.dedup();
        return Ok(ids);
    }

    // Grok / other: keep profile path with allow_private for remote.
    let desc = cd_core::providers::descriptor_for(kind);
    let id = desc.profile_id_slug.to_string();
    let mut base_url = req.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        if let Some(def) = desc.default_base_url {
            base_url = def.to_string();
        }
    }
    let local_only = req.local_only.unwrap_or(desc.is_local);
    let chat_model = req
        .chat_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("grok-3")
        .to_string();
    let api_key = resolve_draft_api_key(&state, kind, req.api_key.as_deref());
    let profile = ProviderProfile {
        id: id.clone(),
        label: desc.default_label.to_string(),
        kind,
        base_url,
        api_key_ref: None,
        chat_model,
        embedding_model: None,
        embedding_base_url: None,
        local_only,
        capabilities: desc.default_capabilities,
    };
    Ok(models_for_profile_with_key(&profile, api_key.as_deref()).await)
}

/// Active provider for Settings hydrate (no secrets).
#[tauri::command]
fn get_active_provider(state: State<'_, AppState>) -> Option<ProviderDto> {
    let cfg = state.config.lock().expect("config").clone();
    let p = cfg.providers.active()?;
    let has_key = if p.kind == ProviderKind::XaiGrokBuild {
        cd_core::grok_auth::detect_grok_session().is_some()
    } else {
        p.api_key_ref
            .as_ref()
            .map(|r| state.secrets.has(r).unwrap_or(false))
            .unwrap_or(false)
            || state
                .secrets
                .has(&key_ref_for_profile(&p.id))
                .unwrap_or(false)
    };
    Some(provider_to_dto(p, has_key))
}

/// Enable or disable native tool calling on the active (or named) profile (#327).
#[tauri::command]
fn set_provider_tools_enabled(
    state: State<'_, AppState>,
    profile_id: Option<String>,
    tools_enabled: bool,
) -> Result<ProviderDto, String> {
    let mut cfg = state.config.lock().expect("config").clone();
    let id = profile_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| cfg.providers.active_id.clone())
        .ok_or_else(|| "no active provider".to_string())?;
    if !cfg.providers.set_profile_tools_enabled(&id, tools_enabled) {
        return Err(format!("unknown provider profile: {id}"));
    }
    if tools_enabled {
        let prefix = format!("{id}::");
        cfg.model_tools_enabled
            .retain(|selection, _| !selection.starts_with(&prefix));
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *state.config.lock().expect("config") = cfg.clone();
    let p = cfg
        .providers
        .profiles
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "profile missing after update".to_string())?;
    let has_key = if p.kind == ProviderKind::XaiGrokBuild {
        cd_core::grok_auth::detect_grok_session().is_some()
    } else {
        p.api_key_ref
            .as_ref()
            .map(|r| state.secrets.has(r).unwrap_or(false))
            .unwrap_or(false)
            || state
                .secrets
                .has(&key_ref_for_profile(&p.id))
                .unwrap_or(false)
    };
    Ok(provider_to_dto(p, has_key))
}

/// Retry or disable native tools for one exact provider/model pair (#650).
#[tauri::command]
fn set_model_tools_enabled(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
    tools_enabled: bool,
) -> Result<bool, String> {
    let provider_id = provider_id.trim();
    let model_id = model_id.trim();
    if provider_id.is_empty() || model_id.is_empty() {
        return Err("provider and model are required".into());
    }
    let mut cfg = state.config.lock().expect("config").clone();
    let profile = cfg
        .providers
        .profiles
        .iter()
        .find(|profile| profile.id == provider_id)
        .ok_or_else(|| format!("unknown provider profile: {provider_id}"))?;
    if !profile.capabilities.tools && tools_enabled {
        return Err(format!("profile “{}” has tools disabled", profile.label));
    }
    let key = model_selection_key(provider_id, model_id);
    if tools_enabled {
        cfg.model_tools_enabled.remove(&key);
    } else {
        cfg.model_tools_enabled.insert(key, false);
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *state.config.lock().expect("config") = cfg;
    Ok(tools_enabled)
}

/// Like `models_for_profile` but accepts an already-resolved API key (draft paste).
///
/// For remote gateways, walks `expand_base_candidates` (TriageTool parity) and
/// keeps the **largest** successful model list so corporate path shapes work.
async fn models_for_profile_with_key(
    profile: &ProviderProfile,
    api_key: Option<&str>,
) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    match profile.kind {
        ProviderKind::Ollama => {
            if let Ok(client) =
                cd_core::chat::OllamaClient::new(&profile.base_url, &profile.chat_model)
            {
                if let Ok(tags) = client.list_tags().await {
                    ids.extend(tags.into_iter().filter(|m| looks_like_chat_model_id(m)));
                }
            }
        }
        ProviderKind::OpenAiCompatible => {
            // User-configured remote bases may be corporate private DNS — allow private.
            let policy = if profile.local_only {
                SsrfPolicy::local_only()
            } else {
                SsrfPolicy::allow_private_networks()
            };
            let candidates = expand_base_candidates(&profile.base_url);
            let mut best: Vec<String> = Vec::new();
            for base in candidates {
                if let Ok(client) = cd_core::chat::OpenAiCompatibleClient::new(
                    &base,
                    api_key.map(|s| s.to_string()),
                    &profile.chat_model,
                    &policy,
                ) {
                    if let Ok(listed) = client.list_models().await {
                        let filtered: Vec<String> = listed
                            .into_iter()
                            .filter(|m| looks_like_chat_model_id(m))
                            .collect();
                        if filtered.len() > best.len() {
                            best = filtered;
                        }
                    }
                }
            }
            ids.extend(best);
        }
        ProviderKind::XaiGrokBuild => {
            ids.extend(
                ["grok-3", "grok-3-mini", "grok-2", "grok-2-vision-1212"]
                    .into_iter()
                    .map(str::to_string),
            );
            let base = if profile.base_url.trim().is_empty() {
                "https://api.x.ai/v1"
            } else {
                profile.base_url.trim()
            };
            if cd_core::grok_auth::assert_grok_base_allowed(base).is_ok() {
                if let Ok(creds) = cd_core::grok_auth::load_grok_session_credentials() {
                    if let Ok(client) = cd_core::chat::OpenAiCompatibleClient::new(
                        base,
                        None,
                        &profile.chat_model,
                        &SsrfPolicy::default(),
                    ) {
                        let client = client.with_extra_headers(creds.request_headers());
                        if let Ok(listed) = client.list_models().await {
                            for m in listed.into_iter().filter(|m| looks_like_chat_model_id(m)) {
                                if !ids.iter().any(|x| x == &m) {
                                    ids.push(m);
                                }
                            }
                        }
                    }
                }
            }
        }
        ProviderKind::Anthropic => {
            let policy = if profile.local_only {
                SsrfPolicy::local_only()
            } else {
                SsrfPolicy::allow_private_networks()
            };
            let candidates = expand_base_candidates(&profile.base_url);
            let mut best: Vec<String> = Vec::new();
            for base in candidates {
                if let Ok(client) = cd_core::chat::AnthropicClient::new(
                    &base,
                    api_key.map(|s| s.to_string()),
                    &profile.chat_model,
                    &policy,
                ) {
                    if let Ok(listed) = client.list_models().await {
                        let filtered: Vec<String> = listed
                            .into_iter()
                            .filter(|m| looks_like_chat_model_id(m))
                            .collect();
                        if filtered.len() > best.len() {
                            best = filtered;
                        }
                    }
                }
            }
            ids.extend(best);
        }
    }

    let profile_model = profile.chat_model.trim();
    if !profile_model.is_empty() && !ids.iter().any(|x| x == profile_model) {
        ids.insert(0, profile_model.to_string());
    }
    ids.sort();
    ids.dedup();
    ids
}

/// List models from **all** configured providers, for grouped UI selection.
#[tauri::command]
async fn list_chat_models(state: State<'_, AppState>) -> Result<Vec<ModelOptionDto>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let default_model = resolve_default_model(&cfg);
    let default_pid = cfg
        .providers
        .active()
        .map(|p| p.id.clone())
        .unwrap_or_else(|| "ollama-local".into());
    let default_key = model_selection_key(&default_pid, &default_model);

    let mut profiles = cfg.providers.profiles.clone();
    if profiles.is_empty() {
        profiles.push(ProviderProfile::ollama_local());
    }

    let mut out: Vec<ModelOptionDto> = Vec::new();
    for profile in &profiles {
        let ids = models_for_profile(profile, &state.secrets).await;
        let group = provider_group_label(profile);
        for id in ids {
            let selection_key = model_selection_key(&profile.id, &id);
            out.push(ModelOptionDto {
                is_default: selection_key == default_key
                    || (id == default_model && profile.id == default_pid),
                tools_enabled: model_tools_enabled(&cfg, profile, &id),
                tools_disabled_reason: model_tools_disabled_reason(&cfg, profile, &id)
                    .map(str::to_string),
                label: id.clone(),
                selection_key,
                id,
                provider_id: profile.id.clone(),
                provider_label: group.clone(),
                group: group.clone(),
            });
        }
    }

    // Ensure default is present even if listing failed for that provider.
    if !out.iter().any(|m| m.selection_key == default_key) {
        let label = cfg
            .providers
            .active()
            .map(provider_group_label)
            .unwrap_or_else(|| "Default".into());
        out.insert(
            0,
            ModelOptionDto {
                id: default_model.clone(),
                label: default_model.clone(),
                selection_key: default_key.clone(),
                provider_id: default_pid,
                provider_label: label.clone(),
                group: label,
                is_default: true,
                tools_enabled: cfg
                    .providers
                    .active()
                    .map(|profile| model_tools_enabled(&cfg, profile, &default_model))
                    .unwrap_or(true),
                tools_disabled_reason: cfg.providers.active().and_then(|profile| {
                    model_tools_disabled_reason(&cfg, profile, &default_model).map(str::to_string)
                }),
            },
        );
    }

    // Group order: active provider first, then alpha by group, then model id.
    let active_id = cfg.providers.active_id.clone().unwrap_or_default();
    out.sort_by(|a, b| {
        let a_act = a.provider_id == active_id;
        let b_act = b.provider_id == active_id;
        b_act
            .cmp(&a_act)
            .then_with(|| a.group.cmp(&b.group))
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(out)
}

/// Set default model for new chats. `selection` may be `provider::model` or bare model id.
#[tauri::command]
fn set_default_chat_model(state: State<'_, AppState>, model: String) -> Result<String, String> {
    let raw = model.trim().to_string();
    if raw.is_empty() {
        return Err("model id is required".into());
    }
    let (provider_id, model_id) = parse_selection_key(&raw);
    if model_id.is_empty() {
        return Err("model id is required".into());
    }
    let mut cfg = state.config.lock().expect("config");
    cfg.default_chat_model = Some(model_id.clone());
    if let Some(pid) = provider_id {
        if cfg.providers.profiles.iter().any(|p| p.id == pid) {
            cfg.providers.active_id = Some(pid.clone());
            if let Some(p) = cfg.providers.profiles.iter_mut().find(|p| p.id == pid) {
                p.chat_model = model_id.clone();
            }
        }
    } else if let Some(active_id) = cfg.providers.active_id.clone() {
        if let Some(p) = cfg
            .providers
            .profiles
            .iter_mut()
            .find(|p| p.id == active_id)
        {
            p.chat_model = model_id.clone();
        }
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    Ok(model_selection_key(
        cfg.providers.active_id.as_deref().unwrap_or("ollama-local"),
        &model_id,
    ))
}

/// Read resolved default selection key (`provider::model`).
#[tauri::command]
fn get_default_chat_model(state: State<'_, AppState>) -> String {
    let cfg = state.config.lock().expect("config");
    resolve_default_selection(&cfg)
}

/// One-shot LLM title (falls back to short heuristic if model unavailable).
async fn llm_title_for_prompt(state: &AppState, prompt: &str) -> String {
    let fallback = title_from_prompt(prompt, 40);
    if prompt.trim().is_empty() {
        return fallback;
    }
    let cfg = state.config.lock().expect("config").clone();
    let profile = cfg
        .providers
        .active()
        .cloned()
        .unwrap_or_else(ProviderProfile::ollama_local);
    let api_key = profile
        .api_key_ref
        .as_ref()
        .and_then(|r| state.secrets.get(r).ok().flatten());

    let messages = vec![
        ChatMessage {
            role: ChatRole::System,
            content: "You only output a short chat title. No explanation.".into(),
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: ChatRole::User,
            content: session_title_llm_prompt(prompt),
            tool_call_id: None,
            tool_calls: None,
        },
    ];

    let raw = match profile.kind {
        ProviderKind::Ollama => {
            let Ok(client) =
                cd_core::chat::OllamaClient::new(&profile.base_url, &profile.chat_model)
            else {
                return fallback;
            };
            match client.complete(&messages, None).await {
                Ok(c) => c.content,
                Err(_) => return fallback,
            }
        }
        ProviderKind::OpenAiCompatible => {
            let policy = if profile.local_only {
                SsrfPolicy::local_only()
            } else {
                // User-configured corporate gateways often resolve to private IPs.
                SsrfPolicy::allow_private_networks()
            };
            let Ok(client) = cd_core::chat::OpenAiCompatibleClient::new(
                &profile.base_url,
                api_key,
                &profile.chat_model,
                &policy,
            ) else {
                return fallback;
            };
            match client.complete(&messages, None).await {
                Ok(c) => c.content,
                Err(_) => return fallback,
            }
        }
        ProviderKind::XaiGrokBuild => {
            let base = if profile.base_url.trim().is_empty() {
                "https://api.x.ai/v1"
            } else {
                profile.base_url.trim()
            };
            if cd_core::grok_auth::assert_grok_base_allowed(base).is_err() {
                return fallback;
            }
            let Ok(creds) = cd_core::grok_auth::load_grok_session_credentials() else {
                return fallback;
            };
            let Ok(client) = cd_core::chat::OpenAiCompatibleClient::new(
                base,
                None,
                &profile.chat_model,
                &SsrfPolicy::default(),
            ) else {
                return fallback;
            };
            let client = client.with_extra_headers(creds.request_headers());
            match client.complete(&messages, None).await {
                Ok(c) => c.content,
                Err(_) => return fallback,
            }
        }
        ProviderKind::Anthropic => return fallback,
    };

    let cleaned = sanitize_generated_title(&raw, 48);
    if cleaned.is_empty() {
        fallback
    } else {
        cleaned
    }
}

/// Suggest a brief chat title for a user prompt (LLM when possible).
#[tauri::command]
async fn suggest_chat_title(state: State<'_, AppState>, prompt: String) -> Result<String, String> {
    Ok(llm_title_for_prompt(&state, &prompt).await)
}

/// Generate LLM title for session (if not rename-locked) and persist.
#[tauri::command]
async fn retitle_chat_session(state: State<'_, AppState>, id: String) -> Result<Session, String> {
    let store = session_store(&state)?;
    let mut session = store.load(&id).map_err(|e| e.to_string())?;
    if session.title_locked {
        return Ok(session);
    }
    let prompt = session
        .messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    if prompt.trim().is_empty() {
        return Ok(session);
    }
    let title = llm_title_for_prompt(&state, &prompt).await;
    session.apply_suggested_title(&title);
    store.save(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

#[derive(Debug, Deserialize)]
struct GrantReq {
    request_id: String,
    decision: String,
    typed: Option<String>,
    tool_name: String,
    arguments: serde_json::Value,
    /// Session whose model history should receive the grant outcome (#111).
    #[serde(default)]
    session_id: Option<String>,
}

#[tauri::command]
async fn complete_permission_cmd(
    state: State<'_, AppState>,
    req: GrantReq,
) -> Result<Vec<EventDto>, String> {
    let decision = match req.decision.as_str() {
        "allow_once" => PermissionDecision::AllowOnce,
        "allow_session_path" => PermissionDecision::AllowSessionPath,
        _ => PermissionDecision::Deny,
    };
    let session_key = req
        .session_id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // Clone history under its lock, then release before taking host (avoid deadlock
    // with agent_turn which also touches both maps).
    let mut history_buf = session_key.as_ref().map(|sid| {
        let mut histories = state.histories.lock().expect("hist");
        histories.entry(sid.clone()).or_default().clone()
    });
    // #114: take host out — MutexGuard is not Send across await.
    let mut host = {
        let mut host_guard = state.host.lock().expect("host");
        host_guard.take().ok_or("host missing")?
    };
    let events = grant_and_execute(
        &mut host,
        &req.request_id,
        decision,
        req.typed.as_deref(),
        &req.tool_name,
        &req.arguments,
        history_buf.as_mut(),
    )
    .await
    .map_err(|e| e.to_string());
    {
        let mut host_guard = state.host.lock().expect("host");
        *host_guard = Some(host);
    }
    let events = events?;
    if let (Some(sid), Some(h)) = (session_key, history_buf) {
        let mut histories = state.histories.lock().expect("hist");
        histories.insert(sid, h);
    }
    Ok(events_to_dto(&events))
}

#[tauri::command]
fn reindex(state: State<'_, AppState>) -> Result<cd_core::index::IndexStatus, String> {
    ensure_host(&state)?;
    {
        let mut st = state.index_status.lock().expect("index_status");
        st.phase = cd_core::index::IndexPhase::Indexing;
        st.message = "Manual reindex…".into();
    }
    let mut host_guard = state.host.lock().expect("host");
    let host = host_guard.as_mut().ok_or("host missing")?;
    let stats = host.reindex().map_err(|e| e.to_string())?;
    let mut st = state.index_status.lock().expect("index_status");
    st.phase = cd_core::index::IndexPhase::Ready;
    st.scanned = stats.scanned;
    st.added = stats.added;
    st.max_files = stats.max_files;
    st.truncated = stats.truncated;
    st.bytes_capped = host.index_bytes_capped();
    st.resident_chunks = host.index_resident_chunks() as u32;
    st.message = format!(
        "Reindex complete — scanned {}, +{}.",
        stats.scanned, stats.added
    );
    Ok(st.clone())
}

/// Background index status (#117). Search works while phase is `indexing`.
#[tauri::command]
fn get_index_status(state: State<'_, AppState>) -> cd_core::index::IndexStatus {
    let mut st = state.index_status.lock().expect("index_status").clone();
    if let Ok(g) = state.host.lock() {
        if let Some(h) = g.as_ref() {
            st.bytes_capped = h.index_bytes_capped();
            st.resident_chunks = h.index_resident_chunks() as u32;
        }
    }
    st
}

#[tauri::command]
fn read_workspace_file_cmd(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
    read_workspace_file(&ws, &path).map_err(|e| e.to_string())
}

/// Alias used by UI for citation / source preview.
#[tauri::command]
fn read_memory_file(state: State<'_, AppState>, relative: String) -> Result<String, String> {
    read_workspace_file_cmd(state, relative)
}

/// Durable memory row for UI (content already redacted at write time — no raw secrets).
#[derive(Debug, Clone, Serialize)]
struct DurableMemoryDto {
    id: String,
    kind: String,
    title: String,
    content: String,
    status: String,
    scope: String,
    updated_at: i64,
    rev: i64,
    /// Citation / selection key: `memory:{id}`
    source_id: String,
}

impl From<&cd_core::memory::MemoryRecord> for DurableMemoryDto {
    fn from(r: &cd_core::memory::MemoryRecord) -> Self {
        Self {
            id: r.id.to_string(),
            kind: r.kind.as_str().to_string(),
            title: r.title.clone(),
            content: r.content.clone(),
            status: r.status.as_str().to_string(),
            scope: r.scope.as_str().to_string(),
            updated_at: r.updated_at,
            rev: r.rev,
            source_id: format!("memory:{}", r.id),
        }
    }
}

// ── Log analysis surface (#362) — no secrets over IPC ─────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogCorpusStatsDto {
    files: u64,
    discovered_files: u64,
    excluded_files: u64,
    failed_files: u64,
    ignored_files: u64,
    exclusion_counts: std::collections::BTreeMap<String, u64>,
    exclusion_examples: Vec<String>,
    partial: bool,
    lines: u64,
    templates: u64,
    reduction_ratio: f64,
    embedded: u64,
    source_bytes: u64,
    corpus_bytes: u64,
    level_counts: std::collections::BTreeMap<String, u64>,
    ts_min: Option<i64>,
    ts_max: Option<i64>,
    format_counts: std::collections::BTreeMap<String, u64>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogTopTemplateDto {
    id: u64,
    pattern: String,
    count: u64,
    severity: u8,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogCorpusSummaryDto {
    id: String,
    name: String,
    event_count: u64,
    template_count: u64,
    engine: String,
    created_at: i64,
    source_label: Option<String>,
    stats: Option<LogCorpusStatsDto>,
    top_templates: Vec<LogTopTemplateDto>,
    embedding: cd_core::log_analysis::CorpusEmbeddingStatus,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogClusterDto {
    cluster_id: u64,
    label: String,
    count: u64,
    severity: u8,
    score: f32,
    template_ids: Vec<u64>,
    exemplars: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogTimelineBucketDto {
    start: i64,
    width: i64,
    count: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogSearchHitDto {
    template_id: u64,
    pattern: String,
    score: f32,
    semantic_score: f32,
    count: u64,
    severity: u8,
    exemplars: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogIngestReportDto {
    corpus_id: String,
    lines: u64,
    templates: u64,
    reduction_ratio: f64,
    embedded: u64,
    files: u64,
    discovered_files: u64,
    excluded_files: u64,
    failed_files: u64,
    ignored_files: u64,
    exclusion_counts: std::collections::BTreeMap<String, u64>,
    exclusion_examples: Vec<String>,
    partial: bool,
    source_bytes: u64,
    corpus_bytes: u64,
    level_counts: std::collections::BTreeMap<String, u64>,
    ts_min: Option<i64>,
    ts_max: Option<i64>,
    format_counts: std::collections::BTreeMap<String, u64>,
    top_templates: Vec<LogTopTemplateDto>,
    embedding: cd_core::log_analysis::CorpusEmbeddingStatus,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogPackageImportDto {
    corpus_id: String,
    name: String,
    origin_corpus_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogTemplateRowDto {
    id: u64,
    pattern: String,
    count: u64,
    severity: u8,
}

fn log_cache_dir(state: &AppState) -> Result<std::path::PathBuf, String> {
    let dir = ensure_config_dir(&state.branding).map_err(|e| e.to_string())?;
    let cache = dir.join("cache");
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    Ok(cache)
}

fn stats_dto(s: &cd_core::log_analysis::CorpusStats) -> LogCorpusStatsDto {
    LogCorpusStatsDto {
        files: s.files,
        discovered_files: s.discovered_files,
        excluded_files: s.excluded_files,
        failed_files: s.failed_files,
        ignored_files: s.ignored_files,
        exclusion_counts: s.exclusion_counts.clone(),
        exclusion_examples: s.exclusion_examples.clone(),
        partial: s.partial,
        lines: s.lines,
        templates: s.templates,
        reduction_ratio: s.reduction_ratio,
        embedded: s.embedded,
        source_bytes: s.source_bytes,
        corpus_bytes: s.corpus_bytes,
        level_counts: s.level_counts.clone(),
        ts_min: s.ts_min,
        ts_max: s.ts_max,
        format_counts: s.format_counts.clone(),
    }
}

fn summary_dto(c: &cd_core::log_analysis::LogCorpus) -> LogCorpusSummaryDto {
    let meta = c.meta().ok();
    let s = c.summary();
    let top = meta
        .as_ref()
        .map(|m| {
            m.top_templates
                .iter()
                .map(|t| LogTopTemplateDto {
                    id: t.id,
                    pattern: t.pattern.clone(),
                    count: t.count,
                    severity: t.severity,
                })
                .collect()
        })
        .unwrap_or_default();
    LogCorpusSummaryDto {
        id: s.id,
        name: s.name,
        event_count: s.event_count,
        template_count: s.template_count,
        engine: s.engine,
        created_at: s.created_at,
        source_label: s.source_label,
        stats: s.stats.as_ref().map(stats_dto),
        top_templates: top,
        embedding: c.embedding_status(),
    }
}

/// List disposable log corpora under app cache.
#[tauri::command]
fn list_log_corpora(state: State<'_, AppState>) -> Result<Vec<LogCorpusSummaryDto>, String> {
    let cache = log_cache_dir(&state)?;
    let summaries =
        cd_core::log_analysis::LogCorpus::list_summaries(&cache).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for s in summaries {
        if let Ok(c) = cd_core::log_analysis::LogCorpus::open(&cache, &s.id) {
            out.push(summary_dto(&c));
        }
    }
    Ok(out)
}

/// Full summary for one corpus (detail header).
#[tauri::command]
fn get_log_corpus(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<LogCorpusSummaryDto, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    Ok(summary_dto(&c))
}

/// List templates for a corpus (UI table).
#[tauri::command]
fn list_log_templates(
    state: State<'_, AppState>,
    corpus_id: String,
    limit: Option<u32>,
) -> Result<Vec<LogTemplateRowDto>, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200) as usize;
    let mut rows = c.list_templates();
    rows.sort_by_key(|r| std::cmp::Reverse(r.info.count));
    Ok(rows
        .into_iter()
        .take(lim)
        .map(|r| LogTemplateRowDto {
            id: r.info.template_id,
            pattern: r.info.pattern,
            count: r.info.count,
            severity: r.info.severity,
        })
        .collect())
}

/// Export a corpus package zip to a user path (full analysis package).
#[tauri::command]
fn export_log_corpus_package(
    state: State<'_, AppState>,
    corpus_id: String,
    path: String,
) -> Result<String, String> {
    let cache = log_cache_dir(&state)?;
    let man =
        cd_core::log_analysis::export_corpus_zip(&cache, &corpus_id, std::path::Path::new(&path))
            .map_err(|e| e.to_string())?;
    Ok(man.format_version)
}

/// Write one bounded, redacted diagnostic to a path chosen by the native dialog.
#[tauri::command]
fn save_log_diagnostic_report(path: String, format: String, content: String) -> Result<(), String> {
    log_diagnostics::save_log_diagnostic_report(std::path::Path::new(&path), &format, &content)
}

/// Import a portable package zip (SoftWrite — creates disposable corpus).
#[tauri::command]
fn import_log_corpus_package_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<LogPackageImportDto, String> {
    let cache = log_cache_dir(&state)?;
    let report = cd_core::log_analysis::import_corpus_zip_path(&cache, std::path::Path::new(&path))
        .map_err(|e| e.to_string())?;
    set_active_log_corpus_state_nonblocking(&state, Some(report.corpus_id.clone()));
    Ok(LogPackageImportDto {
        corpus_id: report.corpus_id,
        name: report.name,
        origin_corpus_id: report.origin_corpus_id,
    })
}

/// Emits redacted multi-phase progress for long host ops (#445).
struct TauriProcessProgress {
    app: tauri::AppHandle,
}

impl cd_core::process_progress::ProcessProgressObserver for TauriProcessProgress {
    fn progress(&self, update: cd_core::process_progress::ProcessProgress) {
        let _ = self.app.emit("process-progress", update);
    }
}

/// Key used in `AppState.cancels` for SoftWrite log ingest (#498).
const LOG_INGEST_CANCEL_KEY: &str = "log_ingest";
const LOG_REANALYZE_CANCEL_KEY: &str = "log_reanalyze";

fn desktop_local_log_embed_plan(
    host: &ToolHost,
) -> (
    cd_core::log_analysis::LogEmbedPolicy,
    Option<std::sync::Arc<dyn cd_core::embed::EmbedBackend>>,
) {
    let mut policy = cd_core::log_analysis::LogEmbedPolicy::local_default();
    policy.model_id = host.local_log_embed_model().to_string();
    (policy, host.local_log_embed_backend())
}

fn desktop_log_ingest_embed_plan_nonblocking(
    host: &Arc<Mutex<Option<ToolHost>>>,
) -> (
    cd_core::log_analysis::LogEmbedPolicy,
    Option<std::sync::Arc<dyn cd_core::embed::EmbedBackend>>,
) {
    host.try_lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(desktop_local_log_embed_plan))
        .unwrap_or_else(|| (cd_core::log_analysis::LogEmbedPolicy::local_default(), None))
}

/// Ingest a local log file/dir into a disposable corpus (UI SoftWrite path).
/// Emits `process-progress` phases (scan/parse/template/redact/store/embed).
///
/// Runs on a blocking thread pool so the UI event loop is not starved (macOS
/// "Not Responding" during large zip/dir imports). Ordinary imports use the
/// product-local ONNX backend when it is already available. Import never waits
/// for the broader workspace/tool host: keyword/structured analysis remains
/// available while that host is still starting, and input over 64 MiB remains
/// deferred.
#[tauri::command]
async fn ingest_log_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
) -> Result<LogIngestReportDto, String> {
    let cache = log_cache_dir(&state)?;
    let (policy, embed_backend) = desktop_log_ingest_embed_plan_nonblocking(&state.host);
    let progress = TauriProcessProgress { app: app.clone() };
    let name_owned = name.unwrap_or_else(|| "corpus".into());
    let cancel = cd_core::process_progress::CancelFlag::new();
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        cancels.insert(LOG_INGEST_CANCEL_KEY.into(), cancel.inner_arc());
    }
    let cancel_for_job = cancel.clone();
    let report = tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::ingest_path_with_policy_and_observer(
            &cache,
            std::path::Path::new(&path),
            &name_owned,
            &policy,
            embed_backend,
            &progress,
            Some(&cancel_for_job),
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("ingest task join: {e}"))?;
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        cancels.remove(LOG_INGEST_CANCEL_KEY);
    }
    let report = report?;
    // Wizard/UI ingest: default subsequent log tools to this corpus without requiring
    // the model (or user) to re-type the id.
    set_active_log_corpus_state_nonblocking(&state, Some(report.corpus_id.clone()));
    Ok(LogIngestReportDto {
        corpus_id: report.corpus_id,
        lines: report.stats.lines,
        templates: report.stats.templates as u64,
        reduction_ratio: report.stats.reduction_ratio,
        embedded: report.stats.embedded as u64,
        files: report.stats.files as u64,
        discovered_files: report.stats.discovered_files,
        excluded_files: report.stats.excluded_files,
        failed_files: report.stats.failed_files,
        ignored_files: report.stats.ignored_files,
        exclusion_counts: report.stats.exclusion_counts.clone(),
        exclusion_examples: report.stats.exclusion_examples.clone(),
        partial: report.stats.partial,
        source_bytes: report.stats.source_bytes,
        corpus_bytes: report.stats.corpus_bytes,
        level_counts: report.stats.level_counts.clone(),
        ts_min: report.stats.ts_min,
        ts_max: report.stats.ts_max,
        format_counts: report.stats.format_counts.clone(),
        top_templates: report
            .top_templates
            .into_iter()
            .map(|(id, pattern, count, severity)| LogTopTemplateDto {
                id,
                pattern,
                count,
                severity,
            })
            .collect(),
        embedding: report.embedding,
    })
}

/// Trusted local re-analysis of template vectors; raw events are not reparsed.
#[tauri::command]
async fn reanalyze_log_corpus(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<cd_core::log_analysis::CorpusEmbeddingStatus, String> {
    ensure_host(&state)?;
    let cache = log_cache_dir(&state)?;
    let known = cd_core::log_analysis::LogCorpus::list_ids(&cache).map_err(|e| e.to_string())?;
    if !known.iter().any(|known_id| known_id == &corpus_id) {
        return Err("log corpus not found".into());
    }
    let (backend, model_id) = {
        let host = state.host.lock().expect("host");
        let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
        (
            host.local_log_embed_backend().ok_or_else(|| {
                "Local ONNX embedding model is unavailable. Restart after the model is installed."
                    .to_string()
            })?,
            host.local_log_embed_model().to_string(),
        )
    };
    let progress = TauriProcessProgress { app };
    let cancel = cd_core::process_progress::CancelFlag::new();
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        if cancels.contains_key(LOG_REANALYZE_CANCEL_KEY) {
            return Err("a log re-analysis is already running".into());
        }
        cancels.insert(LOG_REANALYZE_CANCEL_KEY.into(), cancel.inner_arc());
    }
    let cancel_for_job = cancel.clone();
    let result = tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::reanalyze_corpus_embeddings(
            &cache,
            &corpus_id,
            backend.as_ref(),
            &model_id,
            &progress,
            Some(&cancel_for_job),
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("re-analysis task join: {error}"));
    state
        .cancels
        .lock()
        .expect("cancels")
        .remove(LOG_REANALYZE_CANCEL_KEY);
    result?
}

/// Cancel the active trusted local template re-analysis.
#[tauri::command]
fn cancel_log_reanalysis(state: State<'_, AppState>) -> Result<bool, String> {
    let cancels = state.cancels.lock().expect("cancels");
    if let Some(flag) = cancels.get(LOG_REANALYZE_CANCEL_KEY) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        return Ok(true);
    }
    Ok(false)
}

/// Request cancel of an in-flight SoftWrite log ingest (#498).
#[tauri::command]
fn cancel_log_ingest(state: State<'_, AppState>) -> Result<bool, String> {
    let cancels = state.cancels.lock().expect("cancels");
    if let Some(flag) = cancels.get(LOG_INGEST_CANCEL_KEY) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        return Ok(true);
    }
    Ok(false)
}

/// Problem clusters for a corpus.
#[tauri::command]
fn log_cluster_problems(
    state: State<'_, AppState>,
    corpus_id: String,
    max_clusters: Option<u32>,
) -> Result<Vec<LogClusterDto>, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    let clusters = cd_core::log_analysis::cluster_problems(&c, max_clusters.unwrap_or(10) as usize)
        .map_err(|e| e.to_string())?;
    Ok(clusters
        .into_iter()
        .map(|cl| LogClusterDto {
            cluster_id: cl.cluster_id,
            label: cl.label,
            count: cl.count,
            severity: cl.severity,
            score: cl.score,
            template_ids: cl.template_ids,
            exemplars: cl.exemplars,
        })
        .collect())
}

/// Timeline buckets for a corpus.
#[tauri::command]
fn log_timeline(
    state: State<'_, AppState>,
    corpus_id: String,
    width_secs: Option<i64>,
) -> Result<Vec<LogTimelineBucketDto>, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    let buckets = cd_core::log_analysis::timeline(&c, width_secs.unwrap_or(60), None, None)
        .map_err(|e| e.to_string())?;
    Ok(buckets
        .into_iter()
        .map(|b| LogTimelineBucketDto {
            start: b.start,
            width: b.width,
            count: b.count,
        })
        .collect())
}

/// Hybrid log search (paraphrase-capable when embed backend present).
#[tauri::command]
fn log_search(
    state: State<'_, AppState>,
    corpus_id: String,
    query: String,
    k: Option<u32>,
) -> Result<Vec<LogSearchHitDto>, String> {
    let cache = log_cache_dir(&state)?;
    let embed_backend = log_embed_backend_snapshot_nonblocking(&state);
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    let q = cd_core::log_analysis::SearchLogsQuery {
        query: Some(query),
        semantic: true,
        k: k.unwrap_or(8) as usize,
        ..Default::default()
    };
    let hits = cd_core::log_analysis::search_logs(&c, &q, embed_backend.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(hits
        .into_iter()
        .map(|h| LogSearchHitDto {
            template_id: h.template_id,
            pattern: h.pattern,
            score: h.score,
            semantic_score: h.semantic_score,
            count: h.count,
            severity: h.severity,
            exemplars: h.exemplars,
        })
        .collect())
}

/// Discard a disposable corpus.
#[tauri::command]
fn discard_log_corpus(state: State<'_, AppState>, corpus_id: String) -> Result<(), String> {
    let cache = log_cache_dir(&state)?;
    cd_core::log_analysis::LogCorpus::discard(&cache, &corpus_id).map_err(|e| e.to_string())?;
    if active_log_corpus_snapshot(&state).as_deref() == Some(corpus_id.as_str()) {
        set_active_log_corpus_state_nonblocking(&state, None);
    }
    Ok(())
}

/// Set the host default log corpus so agent log tools can omit `corpus=` (wizard handoff).
#[tauri::command]
fn set_active_log_corpus(
    state: State<'_, AppState>,
    corpus_id: Option<String>,
) -> Result<Option<String>, String> {
    Ok(set_active_log_corpus_state_nonblocking(&state, corpus_id))
}

/// Current host default log corpus id (if any).
#[tauri::command]
fn get_active_log_corpus(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(active_log_corpus_snapshot(&state))
}

// ── Log Explorer (#480–#487) ────────────────────────────────────────────────

/// Paged/keyset event query for the Log Explorer.
#[tauri::command]
fn log_query_events(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::EventPage, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    cd_core::log_analysis::query_events(&c, &query).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum LogEventOriginalDto {
    Available {
        label: String,
        text: String,
        #[serde(rename = "sourceByteCount")]
        source_byte_count: u64,
        #[serde(rename = "redactedCharCount")]
        redacted_char_count: u64,
        #[serde(rename = "storedCharCount")]
        stored_char_count: u64,
        truncated: bool,
        #[serde(rename = "encodingNormalized")]
        encoding_normalized: bool,
        #[serde(rename = "redactionApplied")]
        redaction_applied: bool,
    },
    Unavailable {
        reason: String,
    },
}

impl From<cd_core::log_analysis::query::EventOriginalRepresentation> for LogEventOriginalDto {
    fn from(value: cd_core::log_analysis::query::EventOriginalRepresentation) -> Self {
        use cd_core::log_analysis::query::EventOriginalRepresentation;
        match value {
            EventOriginalRepresentation::Available {
                label,
                text,
                source_byte_count,
                redacted_char_count,
                stored_char_count,
                truncated,
                encoding_normalized,
                redaction_applied,
            } => Self::Available {
                label,
                text,
                source_byte_count,
                redacted_char_count,
                stored_char_count,
                truncated,
                encoding_normalized,
                redaction_applied,
            },
            EventOriginalRepresentation::Unavailable { reason } => Self::Unavailable { reason },
        }
    }
}

fn query_log_event_original_at(
    cache: &std::path::Path,
    corpus_id: &str,
    seq: u64,
) -> Result<LogEventOriginalDto, String> {
    let corpus =
        cd_core::log_analysis::LogCorpus::open(cache, corpus_id).map_err(|e| e.to_string())?;
    cd_core::log_analysis::query::query_event_original(&corpus, seq)
        .map(LogEventOriginalDto::from)
        .map_err(|e| e.to_string())
}

/// Explicit, read-only fetch for the inspector's Original (redacted) view.
///
/// This remains separate from ordinary Explorer pages, search, evidence, and
/// linked-chat DTOs so source records never enter those paths automatically.
#[tauri::command]
fn log_query_event_original(
    state: State<'_, AppState>,
    corpus_id: String,
    seq: u64,
) -> Result<LogEventOriginalDto, String> {
    let cache = log_cache_dir(&state)?;
    query_log_event_original_at(&cache, &corpus_id, seq)
}

/// Fixed-size, filter-aware timeline summary for the lazy Explorer navigator.
#[tauri::command]
fn log_timeline_summary(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::TimelineSummaryQuery,
) -> Result<cd_core::log_analysis::TimelineSummary, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    cd_core::log_analysis::query_timeline_summary(&c, &query).map_err(|e| e.to_string())
}

/// One bounded global timeline axis with canonical severity and lane tracks.
#[tauri::command]
fn log_shared_timeline_summary(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::SharedTimelineSummaryQuery,
) -> Result<cd_core::log_analysis::SharedTimelineSummary, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    cd_core::log_analysis::query_shared_timeline_summary(&c, &query).map_err(|e| e.to_string())
}

/// Bounded neighborhood around a stable event identity (Find / bookmark seek).
#[tauri::command]
fn log_query_event_neighborhood(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::EventNeighborhoodQuery,
) -> Result<cd_core::log_analysis::EventNeighborhood, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    cd_core::log_analysis::query_event_neighborhood(&c, &query).map_err(|e| e.to_string())
}

/// Facets under filters for explorer filter rail.
#[tauri::command]
fn log_facets(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::LogFacets, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    cd_core::log_analysis::query_facets(&c, &query).map_err(|e| e.to_string())
}

/// IPC args for advanced log search (#523).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogSearchEventsArgs {
    corpus_id: String,
    request_id: String,
    query: Option<String>,
    semantic: Option<bool>,
    k: Option<u32>,
    filter: Option<cd_core::log_analysis::EventQuery>,
    match_mode: Option<String>,
    case_sensitive: Option<bool>,
}

const LOG_SEARCH_CANCEL_PREFIX: &str = "log_search:";

fn log_search_cancel_key(request_id: &str) -> Result<String, String> {
    if request_id.is_empty()
        || request_id.len() > 128
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid log search request id".into());
    }
    Ok(format!("{LOG_SEARCH_CANCEL_PREFIX}{request_id}"))
}

/// Keyword / regex / template-semantic event search (template-first semantic).
/// Returns advanced result with partial/capped diagnostics (#523).
#[tauri::command]
async fn log_search_events(
    state: State<'_, AppState>,
    args: LogSearchEventsArgs,
) -> Result<cd_core::log_analysis::EventSearchResult, String> {
    let cache = log_cache_dir(&state)?;
    let cancel_key = log_search_cancel_key(&args.request_id)?;
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        if cancels.contains_key(&cancel_key) {
            return Err("log search request id is already active".into());
        }
        cancels.insert(cancel_key.clone(), cancel.clone());
    }
    let mode = match args.match_mode.as_deref() {
        Some("regex") => cd_core::log_analysis::SearchMatchMode::Regex,
        _ => cd_core::log_analysis::SearchMatchMode::Literal,
    };
    let semantic = args.semantic.unwrap_or(true);
    let embed_backend = if semantic && mode != cd_core::log_analysis::SearchMatchMode::Regex {
        log_embed_backend_snapshot_nonblocking(&state)
    } else {
        None
    };
    let q = cd_core::log_analysis::EventSearchQuery {
        query: args.query,
        semantic,
        k: args.k.unwrap_or(50) as usize,
        filter: args.filter.unwrap_or_default(),
        match_mode: mode,
        case_sensitive: args.case_sensitive.unwrap_or(false),
    };
    let corpus_id = args.corpus_id;
    let cancel_for_job = cancel.clone();
    let result = tokio::task::spawn_blocking(move || {
        let corpus = cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id)
            .map_err(|error| error.to_string())?;
        let is_cancelled = || cancel_for_job.load(std::sync::atomic::Ordering::SeqCst);
        cd_core::log_analysis::search_events_advanced_with_cancel(
            &corpus,
            &q,
            embed_backend.as_deref(),
            Some(&is_cancelled),
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("log search task join: {error}"));
    state.cancels.lock().expect("cancels").remove(&cancel_key);
    result?
}

/// Signal cooperative cancellation for one in-flight Explorer Find request.
#[tauri::command]
fn cancel_log_search(state: State<'_, AppState>, request_id: String) -> Result<bool, String> {
    let cancel_key = log_search_cancel_key(&request_id)?;
    let cancels = state.cancels.lock().expect("cancels");
    if let Some(flag) = cancels.get(&cancel_key) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        return Ok(true);
    }
    Ok(false)
}

/// List bookmarks for a corpus.
#[tauri::command]
fn log_list_bookmarks(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<Vec<cd_core::log_analysis::ResolvedBookmark>, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    cd_core::log_analysis::list_resolved_bookmarks(&c).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogAddBookmarkArgs {
    corpus_id: String,
    seq_from: u64,
    seq_to: u64,
    #[serde(default)]
    event_refs: Vec<cd_core::log_analysis::BookmarkEventRef>,
    label: String,
    note: Option<String>,
    color: Option<String>,
    ts_from: Option<i64>,
    ts_to: Option<i64>,
}

/// Add a line or range bookmark.
#[tauri::command]
fn log_add_bookmark(
    state: State<'_, AppState>,
    args: LogAddBookmarkArgs,
) -> Result<cd_core::log_analysis::ResolvedBookmark, String> {
    let cache = log_cache_dir(&state)?;
    let c = cd_core::log_analysis::LogCorpus::open(&cache, &args.corpus_id)
        .map_err(|e| e.to_string())?;
    let bookmark = if args.event_refs.is_empty() {
        cd_core::log_analysis::add_range_bookmark(
            &c,
            cd_core::log_analysis::NewBookmark {
                seq_from: args.seq_from,
                seq_to: args.seq_to,
                label: args.label,
                note: args.note,
                color: args.color,
                ts_from: args.ts_from,
                ts_to: args.ts_to,
            },
        )
    } else {
        cd_core::log_analysis::add_evidence_bookmark(
            &c,
            cd_core::log_analysis::NewEvidenceBookmark {
                event_refs: args.event_refs,
                label: args.label,
                note: args.note,
                color: args.color,
            },
        )
    }
    .map_err(|e| e.to_string())?;
    cd_core::log_analysis::resolve_bookmark(&c, bookmark).map_err(|e| e.to_string())
}

/// Delete a bookmark by id.
#[tauri::command]
fn log_delete_bookmark(
    state: State<'_, AppState>,
    corpus_id: String,
    bookmark_id: String,
) -> Result<bool, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    cd_core::log_analysis::delete_bookmark(&c, &bookmark_id).map_err(|e| e.to_string())
}

fn active_investigation_for_corpus(
    store: &cd_core::investigations::InvestigationStore,
    corpus_id: &str,
) -> Result<Option<cd_core::investigations::InvestigationSummary>, String> {
    store.list().map_err(|e| e.to_string()).map(|summaries| {
        summaries.into_iter().find(|summary| {
            summary.status == cd_core::investigations::InvestigationStatus::Active
                && summary
                    .corpus_links
                    .iter()
                    .any(|link| link.corpus_id == corpus_id)
        })
    })
}

/// Load the newest active durable Investigation linked to a corpus.
#[tauri::command]
fn log_load_active_investigation(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<Option<cd_core::investigations::ResolvedInvestigationDocument>, String> {
    let store = investigation_store(&state)?;
    let Some(summary) = active_investigation_for_corpus(&store, &corpus_id)? else {
        return Ok(None);
    };
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    store
        .load(&summary.id, &corpus)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogAddInvestigationEvidenceArgs {
    corpus_id: String,
    investigation_id: Option<String>,
    expected_revision: Option<u64>,
    title: String,
    event_refs: Vec<cd_core::log_analysis::BookmarkEventRef>,
}

fn investigation_mutation_target(
    store: &cd_core::investigations::InvestigationStore,
    corpus: &cd_core::log_analysis::LogCorpus,
    investigation_id: Option<String>,
    expected_revision: Option<u64>,
) -> Result<(String, u64), String> {
    match (investigation_id, expected_revision) {
        (Some(id), Some(revision)) => Ok((id, revision)),
        (None, None) => {
            if let Some(summary) = active_investigation_for_corpus(store, corpus.id())? {
                Ok((summary.id, summary.revision))
            } else {
                let created = store
                    .create(format!("Investigation · {}", corpus.name()), corpus)
                    .map_err(|e| e.to_string())?;
                Ok((created.id, created.revision))
            }
        }
        _ => Err("Investigation identity and expected revision must be supplied together".into()),
    }
}

/// Save exact selected identities into the corpus's durable Investigation.
#[tauri::command]
fn log_add_investigation_evidence(
    state: State<'_, AppState>,
    args: LogAddInvestigationEvidenceArgs,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus = cd_core::log_analysis::LogCorpus::open(&cache, &args.corpus_id)
        .map_err(|e| e.to_string())?;
    let store = investigation_store(&state)?;
    let (investigation_id, expected_revision) = investigation_mutation_target(
        &store,
        &corpus,
        args.investigation_id,
        args.expected_revision,
    )?;

    store
        .add_exact_evidence(
            &investigation_id,
            expected_revision,
            args.title,
            &corpus,
            args.event_refs,
        )
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogAddInvestigationFindingArgs {
    corpus_id: String,
    investigation_id: Option<String>,
    expected_revision: Option<u64>,
    kind: cd_core::investigations::FindingKind,
    title: String,
    why_it_matters: String,
    event_refs: Vec<cd_core::log_analysis::BookmarkEventRef>,
    view_recipe: Option<cd_core::investigations::FindingViewRecipe>,
}

/// Atomically save exact selected identities and a human-authored finding.
#[tauri::command]
fn log_add_investigation_finding(
    state: State<'_, AppState>,
    args: LogAddInvestigationFindingArgs,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus = cd_core::log_analysis::LogCorpus::open(&cache, &args.corpus_id)
        .map_err(|e| e.to_string())?;
    let store = investigation_store(&state)?;
    let (investigation_id, expected_revision) = investigation_mutation_target(
        &store,
        &corpus,
        args.investigation_id,
        args.expected_revision,
    )?;

    store
        .add_human_finding(
            &investigation_id,
            expected_revision,
            &corpus,
            cd_core::investigations::AddFindingInput {
                kind: args.kind,
                title: args.title,
                why_it_matters: args.why_it_matters,
                event_refs: args.event_refs,
                view_recipe: args.view_recipe,
            },
        )
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogAddInvestigationNoteArgs {
    corpus_id: String,
    investigation_id: Option<String>,
    expected_revision: Option<u64>,
    title: String,
    body: String,
    event_refs: Vec<cd_core::log_analysis::BookmarkEventRef>,
    #[serde(default)]
    finding_ids: Vec<String>,
}

/// Atomically save exact selected identities and a human-authored cited note.
#[tauri::command]
fn log_add_investigation_note(
    state: State<'_, AppState>,
    args: LogAddInvestigationNoteArgs,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus = cd_core::log_analysis::LogCorpus::open(&cache, &args.corpus_id)
        .map_err(|e| e.to_string())?;
    let store = investigation_store(&state)?;
    let (investigation_id, expected_revision) = investigation_mutation_target(
        &store,
        &corpus,
        args.investigation_id,
        args.expected_revision,
    )?;

    store
        .add_human_note(
            &investigation_id,
            expected_revision,
            &corpus,
            cd_core::investigations::AddNoteInput {
                title: args.title,
                body: args.body,
                event_refs: args.event_refs,
                finding_ids: args.finding_ids,
            },
        )
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogEditInvestigationFindingArgs {
    corpus_id: String,
    investigation_id: String,
    expected_revision: u64,
    finding_id: String,
    kind: cd_core::investigations::FindingKind,
    lifecycle: cd_core::investigations::FindingLifecycle,
    title: String,
    why_it_matters: String,
}

/// Edit human-controlled finding fields under optimistic concurrency.
#[tauri::command]
fn log_edit_investigation_finding(
    state: State<'_, AppState>,
    args: LogEditInvestigationFindingArgs,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus = cd_core::log_analysis::LogCorpus::open(&cache, &args.corpus_id)
        .map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .edit_human_finding(
            &args.investigation_id,
            args.expected_revision,
            &corpus,
            cd_core::investigations::EditFindingInput {
                finding_id: args.finding_id,
                kind: args.kind,
                lifecycle: args.lifecycle,
                title: args.title,
                why_it_matters: args.why_it_matters,
            },
        )
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogEditInvestigationNoteArgs {
    corpus_id: String,
    investigation_id: String,
    expected_revision: u64,
    note_id: String,
    title: String,
    body: String,
    evidence_ids: Vec<String>,
    #[serde(default)]
    finding_ids: Vec<String>,
}

/// Edit human-controlled note fields and citations under optimistic concurrency.
#[tauri::command]
fn log_edit_investigation_note(
    state: State<'_, AppState>,
    args: LogEditInvestigationNoteArgs,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus = cd_core::log_analysis::LogCorpus::open(&cache, &args.corpus_id)
        .map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .edit_human_note(
            &args.investigation_id,
            args.expected_revision,
            &corpus,
            cd_core::investigations::EditNoteInput {
                note_id: args.note_id,
                title: args.title,
                body: args.body,
                evidence_ids: args.evidence_ids,
                finding_ids: args.finding_ids,
            },
        )
        .map_err(|e| e.to_string())
}

/// Resolve a bounded evidence item for preview without mutating Explorer state.
#[tauri::command]
fn log_preview_investigation_evidence(
    state: State<'_, AppState>,
    corpus_id: String,
    investigation_id: String,
    evidence_id: String,
) -> Result<cd_core::investigations::EvidencePreview, String> {
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .preview_evidence(&investigation_id, &evidence_id, &corpus)
        .map_err(|e| e.to_string())
}

/// Revalidate a finding's payload-free view recipe without mutating Explorer state.
#[tauri::command]
fn log_preview_investigation_finding_view(
    state: State<'_, AppState>,
    corpus_id: String,
    investigation_id: String,
    finding_id: String,
) -> Result<cd_core::investigations::FindingViewRecipeResolution, String> {
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .resolve_finding_view_recipe(&investigation_id, &finding_id, &corpus)
        .map_err(|e| e.to_string())
}

/// List chat sessions linked to a corpus (any chat may link).
#[tauri::command]
fn list_chat_sessions_for_corpus(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<Vec<cd_core::sessions::SessionMeta>, String> {
    session_store(&state)?
        .list_meta_for_corpus(&corpus_id)
        .map_err(|e| e.to_string())
}

/// Set or clear `linked_corpus_id` on a chat session.
fn set_chat_linked_corpus_at(
    store: &cd_core::sessions::SessionStore,
    cache: &std::path::Path,
    session_id: &str,
    corpus_id: Option<String>,
    draft_session: Option<Session>,
    expected_updated_at: Option<String>,
) -> Result<Session, String> {
    let mut session = match store.load(session_id) {
        Ok(session) => {
            let durable_revision = serde_json::to_value(session.updated_at)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string));
            if expected_updated_at != durable_revision {
                return Err(
                    "Chat changed in another window; reload it before changing log context".into(),
                );
            }
            session
        }
        Err(error) => {
            if store.exists(session_id).map_err(|e| e.to_string())? {
                return Err(format!("chat session is unavailable or corrupt: {error}"));
            }
            let draft = draft_session.ok_or_else(|| "chat session does not exist".to_string())?;
            if draft.id != session_id
                || draft.trashed
                || draft.archived
                || !draft.messages.is_empty()
                || expected_updated_at
                    != serde_json::to_value(draft.updated_at)
                        .ok()
                        .and_then(|value| value.as_str().map(str::to_string))
            {
                return Err("draft chat identity is invalid".into());
            }
            // Construct a minimal host-owned draft. Do not trust renderer
            // messages, lifecycle flags, linked corpus, or timestamps wholesale.
            let mut safe = Session::new(draft.title);
            safe.id = session_id.to_string();
            safe.compact_keep_last = draft.compact_keep_last;
            safe.show_full_history = draft.show_full_history;
            safe.title_locked = draft.title_locked;
            safe.chat_model = draft.chat_model;
            safe.provider_profile_id = draft.provider_profile_id;
            safe.pinned_skill_id = draft.pinned_skill_id;
            safe
        }
    };
    let corpus_id = normalize_log_corpus_id(corpus_id);
    if let Some(corpus_id) = corpus_id.as_deref() {
        // Validate before mutating or saving. A failed attach leaves both an
        // existing durable chat and a new empty draft unchanged.
        validate_linked_log_corpus_at(cache, corpus_id)?;
    }
    session.set_linked_corpus_id(corpus_id);
    store.save(&session).map_err(|e| e.to_string())?;
    Ok(session)
}

#[tauri::command]
fn set_chat_linked_corpus(
    state: State<'_, AppState>,
    session_id: String,
    corpus_id: Option<String>,
    draft_session: Option<Session>,
    expected_updated_at: Option<String>,
) -> Result<cd_core::sessions::Session, String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    let store = session_store(&state)?;
    let cache = log_cache_dir(&state)?;
    set_chat_linked_corpus_at(
        &store,
        &cache,
        &session_id,
        corpus_id,
        draft_session,
        expected_updated_at,
    )
}

/// Build the SPA URL for a Log Explorer window.
///
/// In **dev**, secondary windows must hit the Vite `devUrl` (External) — `WebviewUrl::App`
/// loads a blank white page because there is no packaged asset protocol for the query
/// route. In **release**, load packaged `index.html` with the same query string.
fn log_explorer_webview_url(
    app: &tauri::AppHandle,
    corpus_id: &str,
) -> Result<tauri::WebviewUrl, String> {
    // Encode corpus id for query (UUIDs are safe; keep general).
    let corpus_q = urlencoding_encode(corpus_id);
    let query = format!("window=log-explorer&corpus={corpus_q}");

    // Only use Vite devUrl while running `tauri dev`. In release builds the same
    // conf still lists devUrl — using it would open a blank localhost window.
    if tauri::is_dev() {
        if let Some(dev) = app.config().build.dev_url.as_ref() {
            let base = dev.as_str().trim_end_matches('/');
            let full = format!("{base}/?{query}");
            let parsed = full
                .parse()
                .map_err(|e| format!("log explorer dev url: {e}"))?;
            return Ok(tauri::WebviewUrl::External(parsed));
        }
    }

    // Packaged app: App protocol + query (Vite-built SPA still reads location.search).
    Ok(tauri::WebviewUrl::App(format!("index.html?{query}").into()))
}

/// Minimal percent-encoding for query values (alphanumeric + `-_`. unchanged).
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Open (or focus) a multi-window Log Explorer bound to `corpus_id`.
///
/// **Async** on purpose: creating a `WebviewWindow` from a sync command can leave a
/// blank white, uncloseable window on some platforms (Tauri / WebView2 guidance).
#[tauri::command]
async fn open_log_explorer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<String, String> {
    let cache = log_cache_dir(&state)?;
    let c =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    let title = format!("Log Explorer · {}", c.name());
    // Set active corpus so agent tools resolve without id.
    set_active_log_corpus_state_nonblocking(&state, Some(corpus_id.clone()));
    // Window labels: alphanumeric + `-` only (Tauri constraint). Keep short.
    let label = format!(
        "log-explorer-{}",
        corpus_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .take(48)
            .collect::<String>()
    );
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        let _ = w.unminimize();
        return Ok(label);
    }

    let url = log_explorer_webview_url(&app, &corpus_id)?;
    // Build on the main runtime — async command is the supported path.
    tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title(title)
        .inner_size(1400.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .closable(true)
        .decorations(true)
        .background_color(tauri::window::Color(0x0b, 0x0c, 0x0e, 0xff))
        .build()
        .map_err(|e| format!("open log explorer window: {e}"))?;
    Ok(label)
}

fn handbook_webview_url(app: &tauri::AppHandle) -> Result<tauri::WebviewUrl, String> {
    let query = "window=engineering-handbook";
    if tauri::is_dev() {
        if let Some(dev) = app.config().build.dev_url.as_ref() {
            let base = dev.as_str().trim_end_matches('/');
            return format!("{base}/?{query}")
                .parse()
                .map(tauri::WebviewUrl::External)
                .map_err(|error| format!("engineering handbook dev url: {error}"));
        }
    }
    Ok(tauri::WebviewUrl::App(format!("index.html?{query}").into()))
}

/// Open or focus the single read-only engineering handbook window.
#[tauri::command]
async fn open_engineering_handbook(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Refuse to create a blank shell when packaging omitted the handbook.
    handbook_index(&state)?;
    const LABEL: &str = "engineering-handbook";
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(LABEL.into());
    }
    let url = handbook_webview_url(&app)?;
    tauri::WebviewWindowBuilder::new(&app, LABEL, url)
        .title("ContextDesk · Engineering handbook")
        .inner_size(1180.0, 820.0)
        .min_inner_size(760.0, 560.0)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .closable(true)
        .decorations(true)
        .background_color(tauri::window::Color(0x0b, 0x0c, 0x0e, 0xff))
        .build()
        .map_err(|error| format!("open engineering handbook window: {error}"))?;
    Ok(LABEL.into())
}

/// Harvest row DTO for Harvest Browser (#326 PR6 / PR8).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HarvestRowDto {
    id: String,
    system: String,
    remote_id: String,
    space: Option<String>,
    url: Option<String>,
    transform: String,
    sync_status: String,
    destination: String,
    last_synced_at: i64,
    /// Remote page version when known (required for Publish update).
    remote_version: Option<i64>,
    /// True when transform is raw_storage (Publish without storage paste).
    can_publish_from_local: bool,
}

/// DTO for guided source-run git update (#340).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceGitStatusDto {
    is_git_repo: bool,
    path: Option<String>,
    remote: Option<String>,
    remote_url: Option<String>,
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    dirty: bool,
    summary: String,
    rebuild_hint: String,
    fetch_allowed: bool,
}

fn dto_from_source(s: cd_core::git_source::SourceGitStatus) -> SourceGitStatusDto {
    SourceGitStatusDto {
        is_git_repo: s.is_git_repo,
        path: s.path,
        remote: s.remote,
        remote_url: s.remote_url,
        branch: s.branch,
        ahead: s.ahead,
        behind: s.behind,
        dirty: s.dirty,
        summary: s.summary,
        rebuild_hint: s.rebuild_hint,
        fetch_allowed: s.fetch_allowed,
    }
}

/// Resolve **product** source checkout — never the active user workspace (#340).
fn resolve_product_source_root() -> Option<std::path::PathBuf> {
    let cwd = std::env::current_dir().ok();
    let env = std::env::var("CONTEXTDESK_SOURCE_ROOT").ok();
    let exe = std::env::current_exe().ok();
    let cands = cd_core::git_source::resolve_product_source_candidates(
        cwd.as_deref(),
        env.as_deref(),
        exe.as_deref(),
    );
    cd_core::git_source::select_product_source(&cands)
}

/// Inspect ContextDesk **product** source checkout (#340). Never hard-resets.
#[tauri::command]
fn source_git_status(_state: State<'_, AppState>) -> Result<SourceGitStatusDto, String> {
    let Some(root) = resolve_product_source_root() else {
        return Ok(dto_from_source(
            cd_core::git_source::SourceGitStatus::not_repo(),
        ));
    };
    Ok(dto_from_source(
        cd_core::git_source::inspect_product_source(&root),
    ))
}

/// Explicit fetch of the product upstream only (#340). Never pull/reset/`--all`.
#[tauri::command]
fn source_git_fetch(_state: State<'_, AppState>) -> Result<SourceGitStatusDto, String> {
    let root = resolve_product_source_root()
        .ok_or_else(|| "not a ContextDesk source checkout".to_string())?;
    let st = cd_core::git_source::inspect_product_source(&root);
    if !st.fetch_allowed {
        return Err(st.summary);
    }
    let remote = st.remote.as_deref().unwrap_or("origin");
    cd_core::git_source::fetch_product_source(&root, remote)?;
    Ok(dto_from_source(
        cd_core::git_source::inspect_product_source(&root),
    ))
}

/// List harvest provenance rows (co-located with workspace memory).
#[tauri::command]
fn list_harvests(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<HarvestRowDto>, String> {
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    // Path is set with durable memory attach
    let path = host
        .harvest_db_path_for_ui()
        .ok_or_else(|| "harvest store not attached".to_string())?;
    let store = cd_core::harvest::HarvestStore::open(path).map_err(|e| e.to_string())?;
    let rows = store
        .list(limit.unwrap_or(100) as usize)
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let destination = match &r.destination {
                cd_core::harvest::HarvestDestination::Memory { memory_id, .. } => {
                    format!("memory:{memory_id}")
                }
                cd_core::harvest::HarvestDestination::File { workspace_path } => {
                    format!("file:{workspace_path}")
                }
            };
            HarvestRowDto {
                id: r.id.to_string(),
                system: r.source.system,
                remote_id: r.source.remote_id,
                space: r.source.collection,
                url: r.source.url,
                transform: r.transform_profile.clone(),
                sync_status: r.sync_status.as_str().to_string(),
                destination,
                last_synced_at: r.last_synced_at,
                remote_version: r.source.remote_version,
                can_publish_from_local: cd_core::harvest::publish_from_local_body_allowed(
                    &r.transform_profile,
                ),
            }
        })
        .collect())
}

/// Propose Confluence Publish for a harvest row via ToolHost HardWrite (#326 PR8).
///
/// Returns permission_required events until UI Allow once + type WRITE + re-execute
/// via `complete_permission_cmd`. Never bypasses the tool host.
#[tauri::command]
async fn propose_confluence_publish(
    state: State<'_, AppState>,
    harvest_id: String,
    body_storage_override: Option<String>,
    title: Option<String>,
) -> Result<Vec<EventDto>, String> {
    ensure_host(&state)?;
    let hid = cd_core::memory::parse_memory_id(harvest_id.trim())
        .map_err(|e| format!("harvest_id: {e}"))?;

    // Resolve harvest + body while holding host briefly (sync IO).
    let args = {
        let host_guard = state.host.lock().expect("host");
        let host = host_guard.as_ref().ok_or("host missing")?;
        if !host.confluence_write_enabled() {
            return Err(
                "Confluence write_enabled is false (Settings → Connectors → enable write)".into(),
            );
        }
        let path = host
            .harvest_db_path_for_ui()
            .ok_or_else(|| "harvest store not attached".to_string())?;
        let store = cd_core::harvest::HarvestStore::open(path).map_err(|e| e.to_string())?;
        let record = store
            .get(&hid)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("harvest not found: {hid}"))?;

        let override_body = body_storage_override
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        cd_core::harvest::gate_publish(&record.transform_profile, override_body)
            .map_err(|e| e.to_string())?;

        let body = if let Some(b) = override_body {
            b.to_string()
        } else {
            match &record.destination {
                cd_core::harvest::HarvestDestination::Memory { memory_id, .. } => {
                    let mem = host
                        .durable_memory_store()
                        .ok_or_else(|| "durable memory not attached".to_string())?;
                    let rec = mem
                        .get(memory_id)
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| format!("memory missing for harvest: {memory_id}"))?;
                    rec.content
                }
                cd_core::harvest::HarvestDestination::File { workspace_path } => {
                    let cfg = state.config.lock().expect("config").clone();
                    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
                    read_workspace_file(&ws, workspace_path).map_err(|e| e.to_string())?
                }
            }
        };
        if body.trim().is_empty() {
            return Err("publish body is empty".into());
        }
        cd_core::harvest::build_update_args(&record, &body, title.as_deref())
            .map_err(|e| e.to_string())?
    };

    let mut host = {
        let mut host_guard = state.host.lock().expect("host");
        host_guard.take().ok_or("host missing")?
    };
    let result = host
        .execute(cd_core::tools::names::CONFLUENCE_UPDATE_PAGE, &args, None)
        .await
        .map_err(|e| e.to_string());
    {
        let mut host_guard = state.host.lock().expect("host");
        *host_guard = Some(host);
    }
    let result = result?;
    Ok(events_to_dto(&result.events))
}

/// List durable memories from the Phase-1 store (#274).
#[tauri::command]
fn list_durable_memories(
    state: State<'_, AppState>,
    kind: Option<String>,
    include_superseded: Option<bool>,
    include_retracted: Option<bool>,
    limit: Option<u32>,
) -> Result<Vec<DurableMemoryDto>, String> {
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let store = host
        .durable_memory_store()
        .ok_or_else(|| "durable memory not attached".to_string())?;
    let kinds_owned = kind.map(|k| vec![cd_core::memory::Kind::parse(&k)]);
    let kinds_ref = kinds_owned.as_deref();
    let list = store
        .list(
            kinds_ref,
            include_superseded.unwrap_or(false),
            include_retracted.unwrap_or(false),
            cd_core::embed::now_unix_secs(),
            limit.unwrap_or(100) as usize,
        )
        .map_err(|e| e.to_string())?;
    Ok(list.iter().map(DurableMemoryDto::from).collect())
}

/// Fetch one durable memory by UUID (citation open).
#[tauri::command]
fn get_durable_memory(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<DurableMemoryDto>, String> {
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let store = host
        .durable_memory_store()
        .ok_or_else(|| "durable memory not attached".to_string())?;
    let uuid = cd_core::memory::parse_memory_id(&id).map_err(|e| e.to_string())?;
    let rec = store.get(&uuid).map_err(|e| e.to_string())?;
    Ok(rec.as_ref().map(DurableMemoryDto::from))
}

/// User-initiated composition save (#293): insert or supersede after redaction.
///
/// UI-originated — no model SoftWrite round-trip; the human already clicked Save.
#[tauri::command]
fn save_composition_draft(
    state: State<'_, AppState>,
    content: String,
    title: String,
    kind: Option<String>,
    scope: Option<String>,
    supersede_id: Option<String>,
) -> Result<DurableMemoryDto, String> {
    ensure_host(&state)?;
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let store = host
        .durable_memory_store()
        .ok_or_else(|| "durable memory not attached".to_string())?;

    // Redact before any persist (same path as tools).
    let redaction = cd_core::redact::redact_candidate(&content);
    if redaction.blocked {
        return Err(redaction
            .block_reason
            .unwrap_or_else(|| "credential-dominant content blocked".into()));
    }
    let safe = redaction.text;
    let mem_kind = kind
        .as_deref()
        .map(cd_core::memory::Kind::parse)
        .unwrap_or(cd_core::memory::Kind::ProjectNote);
    let mut draft = cd_core::memory::MemoryDraft::new(mem_kind, safe);
    draft.title = title;
    draft.source = cd_core::memory::MemorySource::User;
    draft.created_by = "user".into();
    draft.origin_tool = Some("composition_pane".into());
    if let Some(sc) = scope.as_deref().and_then(cd_core::memory::Scope::parse) {
        draft.scope = sc;
    }
    let now = cd_core::embed::now_unix_secs();
    let op = if let Some(ref sid) = supersede_id {
        let old = cd_core::memory::parse_memory_id(sid).map_err(|e| e.to_string())?;
        cd_core::memory::MemoryWriteOp::Supersede { old, new: draft }
    } else {
        cd_core::memory::MemoryWriteOp::Insert(draft)
    };
    let rec = store.put(op, now).map_err(|e| e.to_string())?;
    Ok(DurableMemoryDto::from(&rec))
}

/// Phase-2 candidate review inbox row (not durable until approve).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryCandidateDto {
    id: String,
    kind: String,
    title: String,
    content: String,
    scope: String,
    salience: f32,
    confidence: f32,
    cue: String,
    source_excerpt: String,
    status: String,
    propose_supersede_of: Option<String>,
    created_at: i64,
}

impl From<&cd_core::memory::MemoryCandidate> for MemoryCandidateDto {
    fn from(c: &cd_core::memory::MemoryCandidate) -> Self {
        Self {
            id: c.id.to_string(),
            kind: c.kind.as_str().to_string(),
            title: c.title.clone(),
            content: c.content.clone(),
            scope: c.scope.as_str().to_string(),
            salience: c.salience,
            confidence: c.confidence,
            cue: c.cue.clone(),
            source_excerpt: c.source_excerpt.clone(),
            status: c.status.as_str().to_string(),
            propose_supersede_of: c.propose_supersede_of.map(|u| u.to_string()),
            created_at: c.created_at,
        }
    }
}

/// List pending (or all) memory candidates from the review inbox.
#[tauri::command]
fn list_memory_candidates(
    state: State<'_, AppState>,
    include_resolved: Option<bool>,
    limit: Option<u32>,
) -> Result<Vec<MemoryCandidateDto>, String> {
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let inbox = host
        .candidate_inbox()
        .ok_or_else(|| "candidate inbox not attached".to_string())?;
    let list = inbox
        .list(
            include_resolved.unwrap_or(false),
            limit.unwrap_or(100) as usize,
        )
        .map_err(|e| e.to_string())?;
    Ok(list.iter().map(MemoryCandidateDto::from).collect())
}

/// SoftWrite-style approve: human confirmed → store.put (embed + redaction).
#[tauri::command]
fn approve_memory_candidate(
    state: State<'_, AppState>,
    id: String,
) -> Result<DurableMemoryDto, String> {
    ensure_host(&state)?;
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let uuid = cd_core::memory::parse_memory_id(&id).map_err(|e| e.to_string())?;
    let rec = host
        .approve_memory_candidate(&uuid)
        .map_err(|e| e.to_string())?;
    Ok(DurableMemoryDto::from(&rec))
}

/// Discard a pending candidate (no durable write).
#[tauri::command]
fn discard_memory_candidate(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let inbox = host
        .candidate_inbox()
        .ok_or_else(|| "candidate inbox not attached".to_string())?;
    let uuid = cd_core::memory::parse_memory_id(&id).map_err(|e| e.to_string())?;
    inbox.discard(&uuid).map_err(|e| e.to_string())
}

/// Edit pending candidate title/content before approve.
#[tauri::command]
fn edit_memory_candidate(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    content: Option<String>,
) -> Result<MemoryCandidateDto, String> {
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let inbox = host
        .candidate_inbox()
        .ok_or_else(|| "candidate inbox not attached".to_string())?;
    let uuid = cd_core::memory::parse_memory_id(&id).map_err(|e| e.to_string())?;
    let c = inbox
        .edit(&uuid, title.as_deref(), content.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(MemoryCandidateDto::from(&c))
}

/// Batch approve above confidence/salience floors; large batches need type_confirm "APPROVE".
#[tauri::command]
fn batch_approve_memory_candidates(
    state: State<'_, AppState>,
    min_confidence: Option<f32>,
    min_salience: Option<f32>,
    type_confirm: Option<String>,
) -> Result<Vec<DurableMemoryDto>, String> {
    ensure_host(&state)?;
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let inbox = host
        .candidate_inbox()
        .ok_or_else(|| "candidate inbox not attached".to_string())?;
    let store = host
        .durable_memory_store()
        .ok_or_else(|| "durable memory not attached".to_string())?;
    let now = cd_core::embed::now_unix_secs();
    let recs = inbox
        .batch_approve_above(
            store.as_ref(),
            min_confidence.unwrap_or(0.55),
            min_salience.unwrap_or(0.40),
            3, // type-to-confirm threshold
            type_confirm.as_deref(),
            now,
        )
        .map_err(|e| e.to_string())?;
    Ok(recs.iter().map(DurableMemoryDto::from).collect())
}

/// GDPR purge: hard-delete content, keep tombstone. Type-to-confirm "PURGE".
/// Distinct from reversible retract.
#[tauri::command]
fn purge_memory_gdpr(
    state: State<'_, AppState>,
    id: String,
    type_confirm: String,
) -> Result<serde_json::Value, String> {
    if type_confirm.trim() != "PURGE" {
        return Err("type-to-confirm required: type PURGE exactly".into());
    }
    ensure_host(&state)?;
    let host = state.host.lock().expect("host");
    let host = host.as_ref().ok_or_else(|| "host not ready".to_string())?;
    let store = host
        .durable_memory_store()
        .ok_or_else(|| "durable memory not attached".to_string())?;
    let uuid = cd_core::memory::parse_memory_id(&id).map_err(|e| e.to_string())?;
    let now = cd_core::embed::now_unix_secs();
    let tomb = store
        .purge_gdpr(&uuid, now, "gdpr_ui")
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "id": tomb.id.to_string(),
        "purged_at": tomb.purged_at,
        "kind": tomb.kind,
        "scope": tomb.scope,
        "title_redacted": tomb.title_redacted,
        "reason": tomb.reason,
    }))
}

#[tauri::command]
async fn list_memory_notes(state: State<'_, AppState>) -> Result<Vec<MemoryFile>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
    // Prefer durable store when attached (#274); fall back to memory_fs .md notes.
    if let Ok(host_g) = state.host.lock() {
        if let Some(h) = host_g.as_ref() {
            if let Some(store) = h.durable_memory_store() {
                if let Ok(list) =
                    store.list(None, false, false, cd_core::embed::now_unix_secs(), 200)
                {
                    if !list.is_empty() || h.durable_memory_active() {
                        return Ok(list
                            .iter()
                            .map(|r| MemoryFile {
                                path: std::path::PathBuf::from(format!("memory:{}", r.id)),
                                relative: format!("memory:{}", r.id),
                                title: if r.title.is_empty() {
                                    r.kind.as_str().to_string()
                                } else {
                                    r.title.clone()
                                },
                                body: r.content.clone(),
                            })
                            .collect());
                    }
                }
            }
        }
    }
    tauri::async_runtime::spawn_blocking(move || list_memory_files(&ws))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_memory_note(
    state: State<'_, AppState>,
    filename: String,
    title: String,
    body: String,
) -> Result<String, String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
    let path = write_memory_file(&ws, &filename, &title, &body).map_err(|e| e.to_string())?;
    // refresh index if host exists
    if let Ok(mut g) = state.host.lock() {
        if let Some(h) = g.as_mut() {
            let _ = h.reindex();
        }
    }
    Ok(path.display().to_string())
}

#[tauri::command]
fn sql_ro_query(
    state: State<'_, AppState>,
    db_path: String,
    sql: String,
) -> Result<cd_core::sql_ro::SqlRoResult, String> {
    let cfg = state.config.lock().expect("config").clone();
    let ws = workspace_from_cfg(&cfg).ok_or("no workspace")?;
    let path =
        cd_core::paths::resolve_allowed_path(&ws, &db_path, false).map_err(|e| e.to_string())?;
    cd_core::sql_ro::execute_sqlite_ro(&path, &sql).map_err(|e| e.to_string())
}

// ── Bundled product Help (#438) ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct HelpAssetDto {
    mime: String,
    data_url: String,
}

fn load_bundled_help(app: &tauri::App) -> Option<Arc<HelpIndex>> {
    use tauri::Manager;

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("help"));
    }
    #[cfg(debug_assertions)]
    {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join("docs")
                .join("help"),
        );
    }
    candidates
        .into_iter()
        .find_map(|root| HelpIndex::load(root).ok().map(Arc::new))
}

fn load_bundled_handbook(app: &tauri::App) -> Option<Arc<HandbookIndex>> {
    use tauri::Manager;

    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("handbook"));
    }
    #[cfg(debug_assertions)]
    {
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    }
    candidates
        .into_iter()
        .find_map(|root| HandbookIndex::load(root).ok().map(Arc::new))
}

fn help_index(state: &AppState) -> Result<Arc<HelpIndex>, String> {
    state
        .help
        .lock()
        .map_err(|_| "Bundled Help is temporarily unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "Bundled Help is unavailable in this installation.".to_string())
}

fn handbook_index(state: &AppState) -> Result<Arc<HandbookIndex>, String> {
    state
        .handbook
        .lock()
        .map_err(|_| "Engineering handbook is temporarily unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "Engineering handbook is unavailable in this installation.".to_string())
}

#[tauri::command]
fn list_help_sections(state: State<'_, AppState>) -> Result<Vec<HelpSection>, String> {
    Ok(help_index(&state)?.sections())
}

#[tauri::command]
fn get_help_page(state: State<'_, AppState>, id: String) -> Result<HelpPage, String> {
    help_index(&state)?
        .page(&id)
        .map_err(|_| "That Help page is unavailable.".to_string())
}

#[tauri::command]
fn search_help_pages(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<HelpSearchHit>, String> {
    let index = help_index(&state)?;
    Ok(index.search_keyword(&query, limit.unwrap_or(8)))
}

#[tauri::command]
fn get_help_asset(
    state: State<'_, AppState>,
    page_id: String,
    path: String,
) -> Result<HelpAssetDto, String> {
    let (mime, bytes) = help_index(&state)?
        .asset(&page_id, &path)
        .map_err(|_| "That Help illustration is unavailable.".to_string())?;
    let encoded = base64_standard(&bytes);
    Ok(HelpAssetDto {
        data_url: format!("data:{mime};base64,{encoded}"),
        mime,
    })
}

#[tauri::command]
fn get_handbook_manifest(state: State<'_, AppState>) -> Result<HandbookManifest, String> {
    Ok(handbook_index(&state)?.manifest())
}

#[tauri::command]
fn get_handbook_page(state: State<'_, AppState>, id: String) -> Result<HandbookPage, String> {
    handbook_index(&state)?.page(&id)
}

#[tauri::command]
fn export_handbook_document(
    state: State<'_, AppState>,
    path: String,
    scope: String,
    format: String,
    page_id: Option<String>,
    rendered_html: Option<String>,
) -> Result<usize, String> {
    handbook_index(&state)?.export_document(
        std::path::Path::new(&path),
        &scope,
        &format,
        page_id.as_deref(),
        rendered_html.as_deref(),
    )
}

#[tauri::command]
fn resolve_handbook_link(
    state: State<'_, AppState>,
    from_page_id: String,
    target: String,
) -> Result<HandbookLink, String> {
    handbook_index(&state)?.resolve_link(&from_page_id, &target)
}

fn base64_standard(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        out.push(ALPHABET[(a >> 2) as usize] as char);
        out.push(ALPHABET[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(c & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let branding = Branding::embedded();
    let _ = ensure_config_dir(&branding);
    let path = config_path(&branding).expect("config path");
    let mut config = load_config(&path).unwrap_or_default();
    if config.providers.profiles.is_empty() {
        config.providers = ProviderConfig::with_local_ollama();
    }
    let audit_log = ensure_config_dir(&branding)
        .ok()
        .map(|dir| cd_core::audit::AuditLog::new(dir.join("audit.jsonl")));

    let state = AppState {
        branding,
        config: Mutex::new(config),
        secrets: KeychainSecretStore::new(),
        audit_log,
        histories: Mutex::new(HashMap::new()),
        host: Arc::new(Mutex::new(None)),
        host_init: HostInitFlight::default(),
        host_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        active_log_corpus: Mutex::new(None),
        chat_session_mutation: Mutex::new(()),
        investigation_mutation: Mutex::new(()),
        cancels: Mutex::new(HashMap::new()),
        backup_cancel: Mutex::new(None),
        index_watch: Mutex::new(None),
        index_status: Arc::new(Mutex::new(cd_core::index::IndexStatus {
            phase: cd_core::index::IndexPhase::Idle,
            message: "Index not started".into(),
            ..Default::default()
        })),
        help: Mutex::new(None),
        handbook: Mutex::new(None),
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Opt-in signed updates (#173). Check/install only via Settings — never silent.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .setup(|app| {
            // Dark window/webview fill before React mounts (avoids white flash).
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let dark = tauri::window::Color(0x0b, 0x0c, 0x0e, 0xff);
                let _ = win.set_background_color(Some(dark));
            }
            let help = load_bundled_help(app);
            if help.is_none() {
                tracing::warn!("bundled Help corpus unavailable");
            }
            let handbook = load_bundled_handbook(app);
            if handbook.is_none() {
                tracing::warn!("bundled engineering handbook unavailable");
            }
            *app.state::<AppState>().help.lock().expect("help") = help.clone();
            *app.state::<AppState>().handbook.lock().expect("handbook") = handbook;
            if let Ok(mut host) = app.state::<AppState>().host.lock() {
                if let Some(host) = host.as_mut() {
                    host.set_help_index(help);
                }
            }
            spawn_initial_host_warmup(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_branding,
            list_help_sections,
            get_help_page,
            search_help_pages,
            get_help_asset,
            get_handbook_manifest,
            get_handbook_page,
            export_handbook_document,
            resolve_handbook_link,
            open_engineering_handbook,
            session_context_list,
            session_context_import_path,
            session_context_import_bytes,
            session_context_import_zip,
            session_context_remove,
            session_context_purge,
            get_config,
            save_app_config,
            get_s3_backup_settings,
            save_s3_backup_settings,
            run_s3_workspace_backup,
            cancel_s3_workspace_backup,
            list_connectors,
            list_connector_kinds,
            save_connectors,
            set_connector_secret,
            connector_has_secret,
            set_connector_secret,
            connector_has_secret,
            set_provider_secret,
            provider_has_secret,
            save_active_provider,
            list_local_candidates,
            probe_url,
            check_ollama,
            run_preflight_cmd,
            set_workspace_roots,
            validate_workspace_path,
            suggest_default_workspace,
            ensure_default_workspace,
            list_chat_sessions,
            load_chat_session,
            save_chat_session,
            rename_chat_session,
            trash_chat_session,
            restore_chat_session,
            delete_chat_session,
            pin_chat_session,
            archive_chat_session,
            search_chat_sessions,
            list_chat_models,
            list_models_for_draft,
            probe_ai_gateway_cmd,
            get_active_provider,
            set_provider_tools_enabled,
            set_model_tools_enabled,
            set_default_chat_model,
            get_default_chat_model,
            suggest_chat_title,
            retitle_chat_session,
            agent_turn,
            complete_permission_cmd,
            list_skills_cmd,
            set_skill_enabled_cmd,
            propose_save_skill_cmd,
            propose_confluence_publish,
            list_modules,
            install_module,
            set_module_enabled,
            approve_module_enable,
            remove_module,
            get_module_registry_settings,
            set_module_registry_settings,
            browse_module_registry,
            update_module,
            reindex,
            get_index_status,
            read_memory_file,
            read_workspace_file_cmd,
            list_memory_notes,
            list_harvests,
            source_git_status,
            source_git_fetch,
            list_durable_memories,
            get_durable_memory,
            save_composition_draft,
            list_memory_candidates,
            approve_memory_candidate,
            discard_memory_candidate,
            edit_memory_candidate,
            batch_approve_memory_candidates,
            purge_memory_gdpr,
            list_log_corpora,
            get_log_corpus,
            list_log_templates,
            ingest_log_path,
            cancel_log_ingest,
            reanalyze_log_corpus,
            cancel_log_reanalysis,
            log_cluster_problems,
            log_timeline,
            log_search,
            discard_log_corpus,
            set_active_log_corpus,
            get_active_log_corpus,
            log_query_events,
            log_query_event_original,
            log_timeline_summary,
            log_shared_timeline_summary,
            log_query_event_neighborhood,
            log_facets,
            log_search_events,
            cancel_log_search,
            log_list_bookmarks,
            log_add_bookmark,
            log_delete_bookmark,
            log_load_active_investigation,
            log_add_investigation_evidence,
            log_add_investigation_finding,
            log_add_investigation_note,
            log_edit_investigation_finding,
            log_edit_investigation_note,
            log_preview_investigation_evidence,
            log_preview_investigation_finding_view,
            list_chat_sessions_for_corpus,
            set_chat_linked_corpus,
            open_log_explorer,
            export_log_corpus_package,
            save_log_diagnostic_report,
            import_log_corpus_package_path,
            write_memory_note,
            sql_ro_query,
            get_confluence_settings,
            save_confluence_settings,
            confluence_has_token,
            test_confluence_config,
            list_confluence_spaces,
            get_x_settings,
            save_x_settings,
            x_has_token,
            test_x_config,
            get_web_research_enabled,
            set_web_research_enabled,
            get_hybrid_retrieval,
            set_hybrid_retrieval,
            get_ambient_recall_enabled,
            set_ambient_recall_enabled,
            get_router_budget,
            set_router_budget,
            list_web_research_sources,
            set_web_research_sources,
            open_external_url,
            cancel_turn,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ContextDesk");
}

#[cfg(test)]
mod s3_backup_host_tests;

#[cfg(test)]
mod log_original_host_tests {
    use super::*;

    #[test]
    fn explicit_original_query_maps_fidelity_metadata_and_missing_events() {
        let root = tempfile::tempdir().expect("temp root");
        let logs = root.path().join("logs");
        std::fs::create_dir_all(&logs).expect("logs");
        std::fs::write(
            logs.join("event.jsonl"),
            br#"{"timestamp":"2026-07-28T12:00:00Z","level":"ERROR","message":"failure","unknown":"kept","token":"ghp_example_invalid_secret_marker_1234567890"}
"#,
        )
        .expect("fixture");
        let cache = root.path().join("cache");
        let report = cd_core::log_analysis::ingest_path(&cache, &logs, "original", None, "none")
            .expect("ingest");

        let original = query_log_event_original_at(&cache, &report.corpus_id, 0).expect("original");
        let LogEventOriginalDto::Available {
            label,
            text,
            source_byte_count,
            redacted_char_count,
            stored_char_count,
            truncated,
            encoding_normalized,
            redaction_applied,
        } = original
        else {
            panic!("newly ingested event should have an original representation");
        };
        assert_eq!(label, "Original (redacted)");
        assert!(text.contains(r#""unknown":"kept""#));
        assert!(!text.contains("ghp_example_invalid_secret_marker_1234567890"));
        assert!(source_byte_count > 0);
        assert_eq!(stored_char_count, text.chars().count() as u64);
        assert!(redacted_char_count >= stored_char_count);
        assert!(!truncated);
        assert!(!encoding_normalized);
        assert!(redaction_applied);

        let error =
            query_log_event_original_at(&cache, &report.corpus_id, 99).expect_err("missing event");
        assert!(error.contains("event seq 99 not found"), "{error}");
    }

    #[test]
    fn original_ipc_is_registered_and_ordinary_pages_remain_separate() {
        let src = include_str!("lib.rs");
        assert!(
            src.contains("log_query_event_original,"),
            "explicit command must be registered"
        );
        let page_start = src
            .find("fn log_query_events(")
            .expect("ordinary page command");
        let original_start = src
            .find("enum LogEventOriginalDto")
            .expect("separate original DTO");
        let page_src = &src[page_start..original_start];
        assert!(
            !page_src.contains("query_event_original"),
            "ordinary event pages must never fetch original records"
        );
        let original_command_start = src
            .find("fn log_query_event_original(")
            .expect("original command");
        let timeline_start = src[original_command_start..]
            .find("fn log_timeline_summary(")
            .map(|offset| original_command_start + offset)
            .expect("original command boundary");
        let original_command = &src[original_command_start..timeline_start];
        assert!(original_command.contains("query_log_event_original_at"));
        assert!(
            !original_command.contains("ensure_host("),
            "local read-only record lookup must not construct the agent host"
        );
        assert!(
            src.contains("log_shared_timeline_summary,"),
            "shared-axis timeline command must be registered"
        );
        let shared_start = src
            .find("fn log_shared_timeline_summary(")
            .expect("shared timeline command");
        let neighborhood_start = src[shared_start..]
            .find("fn log_query_event_neighborhood(")
            .map(|offset| shared_start + offset)
            .expect("shared timeline command boundary");
        let shared_command = &src[shared_start..neighborhood_start];
        assert!(shared_command.contains("query_shared_timeline_summary"));
        assert!(
            !shared_command.contains("ensure_host("),
            "local bounded summary must not construct the agent host"
        );
    }
}

#[cfg(test)]
mod help_host_tests {
    use super::*;

    #[test]
    fn help_asset_data_url_encoding_is_standard_and_bounded_to_svg_bytes() {
        assert_eq!(base64_standard(b""), "");
        assert_eq!(base64_standard(b"f"), "Zg==");
        assert_eq!(base64_standard(b"fo"), "Zm8=");
        assert_eq!(base64_standard(b"<svg/>"), "PHN2Zy8+");
    }

    #[test]
    fn help_packaging_maps_a_validated_corpus_to_the_installed_resource() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri config");
        assert_eq!(
            config["bundle"]["resources"]["../../docs/help"],
            serde_json::json!("help")
        );

        let source_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("docs")
            .join("help");
        let index = HelpIndex::load(source_root).expect("checked-in corpus");
        assert!(index.len() >= 7);
        assert_eq!(
            index
                .search_keyword("log analysis", 1)
                .first()
                .map(|hit| hit.page_id.as_str()),
            Some("log-analysis-pipeline")
        );
        assert!(
            index.page("PROVEN_METHODS").is_err(),
            "bundling the engineering handbook must not widen user Help retrieval"
        );
    }

    #[test]
    fn handbook_packaging_and_window_lifecycle_are_explicit_and_isolated() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri config");
        assert_eq!(
            config["bundle"]["resources"]["../../docs/design"],
            serde_json::json!("handbook/docs/design")
        );
        assert_eq!(
            config["bundle"]["resources"]["../../AGENTS.md"],
            serde_json::json!("handbook/AGENTS.md")
        );

        let source = include_str!("lib.rs");
        let open_start = source
            .find("async fn open_engineering_handbook(")
            .expect("open command");
        let open_end = source[open_start..]
            .find("/// Harvest row DTO")
            .map(|offset| open_start + offset)
            .expect("open command boundary");
        let command = &source[open_start..open_end];
        assert!(command.contains("get_webview_window(LABEL)"));
        assert!(command.contains("window.set_focus()"));
        assert!(command.contains("handbook_index(&state)?"));
        assert!(!command.contains("ensure_host("));
        for registration in [
            "get_handbook_manifest,",
            "get_handbook_page,",
            "export_handbook_document,",
            "resolve_handbook_link,",
            "open_engineering_handbook,",
        ] {
            assert!(source.contains(registration), "{registration}");
        }
    }
}

#[cfg(test)]
mod startup_host_tests {
    use super::{
        build_and_install_background_index, desktop_log_ingest_embed_plan_nonblocking,
        event_to_dto_with_linked_corpus, host_readiness_terminal_events,
        install_prepared_durable_memory, linked_log_fallback_notice,
        linked_log_host_terminal_events, linked_log_preflight_at, log_search_cancel_key,
        normalize_log_corpus_id, restore_host_if_generation_matches, save_chat_session_at,
        set_chat_linked_corpus_at, take_ready_linked_host, validate_linked_log_corpus_at,
        wait_for_host_readiness, BackgroundIndexBuild, HostInitFlight, HostReadinessFailure,
    };
    use cd_core::events::StreamEvent;
    use cd_core::index::{KeywordIndex, ReindexStats};
    use cd_core::providers::ProviderProfile;
    use cd_core::tool_host::ToolHost;
    use cd_core::workspace::Workspace;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Barrier, Mutex};
    use std::time::Duration;

    fn wire_session_revision(session: &cd_core::sessions::Session) -> String {
        serde_json::to_value(session.updated_at)
            .expect("serialize revision")
            .as_str()
            .expect("revision string")
            .to_string()
    }

    #[test]
    fn linked_log_citation_dto_stamps_only_host_resolved_corpus_identity() {
        let log = cd_core::events::StreamEvent::Citation {
            source_id: "log_template:7".into(),
            label: "template 7".into(),
            locator: None,
        };
        let stamped = event_to_dto_with_linked_corpus(&log, Some("trusted-corpus"));
        assert_eq!(
            stamped
                .payload
                .get("corpus_id")
                .and_then(|value| value.as_str()),
            Some("trusted-corpus")
        );

        let file = cd_core::events::StreamEvent::Citation {
            source_id: "runbook.md".into(),
            label: "runbook".into(),
            locator: None,
        };
        assert!(
            event_to_dto_with_linked_corpus(&file, Some("trusted-corpus"))
                .payload
                .get("corpus_id")
                .is_none()
        );
        assert!(event_to_dto_with_linked_corpus(&log, None)
            .payload
            .get("corpus_id")
            .is_none());
    }

    #[test]
    fn log_ingest_embed_plan_does_not_wait_for_the_workspace_host_lock() {
        let host = Arc::new(Mutex::new(None::<ToolHost>));
        let held = host.lock().expect("held host lock");
        let host_for_worker = Arc::clone(&host);
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = tx.send(desktop_log_ingest_embed_plan_nonblocking(&host_for_worker));
        });

        let result = rx.recv_timeout(Duration::from_secs(1));
        drop(held);
        worker.join().expect("embed-plan worker");
        let (policy, backend) =
            result.expect("embed planning must not wait for the held host lock");

        assert!(backend.is_none());
        assert_eq!(
            policy.model_id,
            cd_core::log_analysis::LogEmbedPolicy::local_default().model_id
        );
    }

    #[test]
    fn packaged_startup_warms_host_after_window_setup_not_before() {
        let src = include_str!("lib.rs");
        let run_start = src.find("pub fn run()").expect("run function");
        let run_src = &src[run_start..];
        let builder_start = run_src
            .find("tauri::Builder::default()")
            .expect("tauri builder");
        let pre_builder = &run_src[..builder_start];

        assert!(
            !pre_builder.contains("ensure_host(&state)"),
            "packaged startup must not synchronously initialize the host before Tauri can create a window"
        );
        assert!(
            run_src.contains("spawn_initial_host_warmup(app.handle().clone())"),
            "startup must still warm the host after the app/window setup path is available"
        );
        assert!(
            src.contains(".name(\"cd-host-warmup\".into())"),
            "background host warmup should stay named for native diagnostics"
        );
        let rebuild_start = src.find("fn rebuild_host(").expect("rebuild_host");
        let rebuild = &src[rebuild_start..];
        let publish = rebuild
            .find("*host_guard = Some(host)")
            .expect("core host publication");
        let memory = rebuild
            .find("spawn_durable_memory_warmup(")
            .expect("isolated memory warmup");
        let shell = rebuild
            .find("KeywordIndex::open_shell_bounded(")
            .expect("replacement index shell");
        let generation = rebuild
            .find(".host_generation")
            .expect("host generation publication");
        assert!(
            shell < generation,
            "failed replacement construction must not invalidate the active host generation"
        );
        assert!(
            publish < memory,
            "optional durable-memory I/O must begin only after the core host is published"
        );
        assert!(
            src.contains(".name(\"cd-memory-warmup\".into())"),
            "optional memory warmup must remain isolated on a named worker"
        );
    }

    #[test]
    fn prepared_memory_installs_only_into_the_matching_ready_host() {
        let workspace = Workspace::new("memory", vec![std::env::temp_dir()]);
        let expected_id = workspace.id.clone();
        let mut prepared = ToolHost::new(workspace.clone(), KeywordIndex::new(), None);
        prepared.set_durable_memory(
            Arc::new(
                cd_core::memory::TwoScopeMemory::open_in_memory(expected_id.clone())
                    .expect("memory"),
            ),
            true,
        );
        prepared.set_ambient_recall_enabled(true);

        let mut live = ToolHost::new(workspace, KeywordIndex::new(), None);
        assert!(install_prepared_durable_memory(
            &mut live,
            &prepared,
            &expected_id
        ));
        assert!(live.durable_memory_active());
        assert!(live.ambient_recall_enabled());

        let other = Workspace::new("other", vec![std::env::temp_dir()]);
        let mut replaced = ToolHost::new(other, KeywordIndex::new(), None);
        assert!(!install_prepared_durable_memory(
            &mut replaced,
            &prepared,
            &expected_id
        ));
        assert!(!replaced.durable_memory_active());
    }

    #[test]
    fn linked_tools_disabled_guard_precedes_host_construction() {
        let src = include_str!("lib.rs");
        let turn_start = src.find("async fn agent_turn(").expect("agent_turn");
        let turn_end = src[turn_start..]
            .find("/// Signal cooperative cancel")
            .map(|offset| turn_start + offset)
            .expect("agent_turn boundary");
        let turn_src = &src[turn_start..turn_end];
        let guard = turn_src
            .find("linked_tools_unavailable_events")
            .expect("linked tools-disabled guard");
        let host = turn_src
            .find("wait_for_host_readiness(AGENT_HOST_READY_TIMEOUT")
            .expect("bounded host readiness wait");

        assert!(
            guard < host,
            "provider-free linked refusal must not wait for workspace host/index warmup"
        );
    }

    #[test]
    fn linked_log_selection_never_waits_for_a_locked_workspace_host() {
        let shared = Arc::new(Mutex::new(None::<ToolHost>));
        let generation = AtomicU64::new(4);
        let held = shared.lock().expect("simulate permanently blocked host");
        let started = std::time::Instant::now();
        let (host, used_fallback, borrowed_generation) =
            take_ready_linked_host(&shared, &generation, || {
                Ok(ToolHost::new(
                    Workspace::new("linked fallback", Vec::new()),
                    KeywordIndex::new(),
                    None,
                ))
            })
            .expect("fallback");
        assert!(used_fallback);
        assert_eq!(borrowed_generation, None);
        assert!(host.workspace.roots.is_empty());
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "linked fallback must not join the blocked initialization flight"
        );
        drop(held);
    }

    #[test]
    fn linked_log_selection_recovers_to_an_already_ready_full_host() {
        let workspace = Workspace::new("ready", vec![std::env::temp_dir()]);
        let expected_id = workspace.id.clone();
        let mut ready = ToolHost::new(workspace, KeywordIndex::new(), None);
        ready.set_log_analysis(true, Some(std::env::temp_dir()));
        let shared = Arc::new(Mutex::new(Some(ready)));
        let generation = AtomicU64::new(7);
        let (host, used_fallback, borrowed_generation) =
            take_ready_linked_host(&shared, &generation, || {
                panic!("ready host should be taken without constructing fallback")
            })
            .expect("ready host");
        assert!(!used_fallback);
        assert_eq!(borrowed_generation, Some(7));
        assert_eq!(host.workspace.id, expected_id);
    }

    #[test]
    fn linked_log_selection_rejects_a_host_without_log_tools() {
        let workspace = Workspace::new("not-log-ready", vec![std::env::temp_dir()]);
        let expected_id = workspace.id.clone();
        let shared = Arc::new(Mutex::new(Some(ToolHost::new(
            workspace,
            KeywordIndex::new(),
            None,
        ))));
        let generation = AtomicU64::new(11);
        let (fallback, used_fallback, borrowed_generation) =
            take_ready_linked_host(&shared, &generation, || {
                let mut host = ToolHost::new(
                    Workspace::new("fallback", Vec::new()),
                    KeywordIndex::new(),
                    None,
                );
                host.set_log_analysis(true, Some(std::env::temp_dir()));
                Ok(host)
            })
            .expect("fallback");
        assert!(used_fallback);
        assert_eq!(borrowed_generation, None);
        assert!(fallback.log_analysis_enabled());
        assert_eq!(
            shared
                .lock()
                .expect("shared")
                .as_ref()
                .map(|host| host.workspace.id.as_str()),
            Some(expected_id.as_str()),
            "non-log host must remain available for ordinary workspace turns"
        );
    }

    #[test]
    fn completed_turn_cannot_overwrite_a_newer_host_generation() {
        let generation = AtomicU64::new(21);
        let old_workspace = Workspace::new("old", vec![std::env::temp_dir()]);
        let old_host = ToolHost::new(old_workspace, KeywordIndex::new(), None);
        let shared = Arc::new(Mutex::new(None::<ToolHost>));

        let new_workspace = Workspace::new("new", vec![std::env::temp_dir()]);
        let new_id = new_workspace.id.clone();
        *shared.lock().expect("host") =
            Some(ToolHost::new(new_workspace, KeywordIndex::new(), None));
        generation.store(22, Ordering::SeqCst);

        assert!(!restore_host_if_generation_matches(
            &shared,
            &generation,
            21,
            old_host,
        ));
        assert_eq!(
            shared
                .lock()
                .expect("host")
                .as_ref()
                .map(|host| host.workspace.id.as_str()),
            Some(new_id.as_str())
        );
    }

    #[test]
    fn linked_corpus_preflight_rejects_missing_and_corrupt_artifacts() {
        let cache = tempfile::tempdir().expect("cache");
        assert!(validate_linked_log_corpus_at(cache.path(), "missing").is_err());

        let root = cache.path().join("log_corpora").join("corrupt");
        std::fs::create_dir_all(&root).expect("corpus dir");
        std::fs::write(root.join("meta.json"), b"not json").expect("corrupt meta");
        std::fs::write(root.join("events.duckdb"), b"not duckdb").expect("corrupt db");
        assert!(validate_linked_log_corpus_at(cache.path(), "corrupt").is_err());

        let events = linked_log_host_terminal_events();
        assert!(matches!(
            &events[0],
            StreamEvent::Error { code, message }
                if code == "linked_log_host_unavailable"
                    && message.contains("before contacting the provider")
        ));
        assert!(matches!(
            &events[1],
            StreamEvent::TurnCompleted { reason }
                if reason == "linked_log_host_unavailable"
        ));
    }

    #[test]
    fn stale_link_precedes_tools_capability_for_every_profile() {
        let cache = tempfile::tempdir().expect("cache");
        let context = cd_core::agent::LogExplorerTurnContext::for_main_chat("discarded").unwrap();
        let mut tools_disabled = ProviderProfile::ollama_local();
        tools_disabled.capabilities.tools = false;
        let tools_enabled = ProviderProfile::ollama_local();

        for profile in [&tools_disabled, &tools_enabled] {
            let events =
                linked_log_preflight_at(cache.path(), &context, Some(profile), "session-a")
                    .expect("terminal stale-corpus events");
            assert!(matches!(
                events.first(),
                Some(StreamEvent::Error { code, message })
                    if code == "linked_log_host_unavailable"
                        && message.contains("before contacting the provider")
            ));
            assert!(
                !events.iter().any(|event| matches!(
                    event,
                    StreamEvent::Error { code, .. } if code == "linked_tools_unavailable"
                )),
                "stale corpus must win before tool capability: {events:?}"
            );
        }
    }

    #[test]
    fn failed_attach_leaves_existing_and_empty_draft_sessions_unchanged() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let cache = tempfile::tempdir().expect("cache");

        let existing = cd_core::sessions::Session::new("Existing");
        store.save(&existing).expect("save existing");
        assert!(set_chat_linked_corpus_at(
            &store,
            cache.path(),
            &existing.id,
            Some("missing-corpus".into()),
            None,
            Some(wire_session_revision(&existing)),
        )
        .is_err());
        assert!(store
            .load(&existing.id)
            .expect("existing unchanged")
            .linked_corpus_id
            .is_none());

        let draft = cd_core::sessions::Session::new("Draft");
        assert!(set_chat_linked_corpus_at(
            &store,
            cache.path(),
            &draft.id,
            Some("missing-corpus".into()),
            Some(draft.clone()),
            Some(wire_session_revision(&draft)),
        )
        .is_err());
        assert!(
            !store.exists(&draft.id).expect("draft existence"),
            "failed attach must not create a durable draft"
        );
    }

    #[test]
    fn validated_attach_atomically_creates_an_empty_linked_chat() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let cache = tempfile::tempdir().expect("cache");
        let logs = tempfile::tempdir().expect("logs");
        std::fs::write(
            logs.path().join("app.log"),
            b"2026-07-28T12:00:00Z ERROR checkout failed\n",
        )
        .expect("fixture");
        let report =
            cd_core::log_analysis::ingest_path(cache.path(), logs.path(), "incident", None, "none")
                .expect("ingest");
        let draft = cd_core::sessions::Session::new("Incident");

        let saved = set_chat_linked_corpus_at(
            &store,
            cache.path(),
            &draft.id,
            Some(report.corpus_id.clone()),
            Some(draft.clone()),
            Some(wire_session_revision(&draft)),
        )
        .expect("validated attach");
        assert!(saved.messages.is_empty());
        assert_eq!(
            saved.linked_corpus_id.as_deref(),
            Some(report.corpus_id.as_str())
        );
        assert_eq!(
            store
                .load(&draft.id)
                .expect("reopen")
                .linked_corpus_id
                .as_deref(),
            Some(report.corpus_id.as_str())
        );
    }

    #[test]
    fn generic_save_cannot_attach_detach_or_switch_governed_log_context() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let mut durable = cd_core::sessions::Session::new("Governed");
        durable.set_linked_corpus_id(Some("trusted-corpus".into()));
        store.save(&durable).expect("save governed session");

        for attempted in [None, Some("other-corpus".to_string())] {
            let mut renderer = durable.clone();
            renderer.linked_corpus_id = attempted;
            let saved = save_chat_session_at(&store, renderer).expect("generic save");
            assert_eq!(saved.linked_corpus_id.as_deref(), Some("trusted-corpus"));
            assert_eq!(
                store
                    .load(&durable.id)
                    .expect("reopen governed session")
                    .linked_corpus_id
                    .as_deref(),
                Some("trusted-corpus")
            );
        }

        let mut new_renderer = cd_core::sessions::Session::new("New");
        new_renderer.linked_corpus_id = Some("smuggled-corpus".into());
        new_renderer
            .messages
            .push(cd_core::sessions::StoredMessage {
                id: "user-1".into(),
                role: "user".into(),
                content: "hello".into(),
                tools: None,
                citations: None,
                trail: None,
                meta: None,
            });
        let saved = save_chat_session_at(&store, new_renderer).expect("save new session");
        assert!(saved.linked_corpus_id.is_none());
        assert!(store
            .load(&saved.id)
            .expect("reopen new session")
            .linked_corpus_id
            .is_none());
    }

    #[test]
    fn linked_corpus_change_rejects_a_stale_session_revision() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let cache = tempfile::tempdir().expect("cache");
        let logs = tempfile::tempdir().expect("logs");
        std::fs::write(
            logs.path().join("app.log"),
            b"2026-07-28T12:00:00Z ERROR checkout failed\n",
        )
        .expect("fixture");
        let report =
            cd_core::log_analysis::ingest_path(cache.path(), logs.path(), "incident", None, "none")
                .expect("ingest");

        let session = cd_core::sessions::Session::new("Concurrent");
        let stale_revision = wire_session_revision(&session);
        store.save(&session).expect("save session");
        let mut newer = session.clone();
        newer.title = "Changed elsewhere".into();
        std::thread::sleep(Duration::from_millis(2));
        newer.touch();
        store.save(&newer).expect("save newer revision");

        let error = set_chat_linked_corpus_at(
            &store,
            cache.path(),
            &session.id,
            Some(report.corpus_id),
            None,
            Some(stale_revision),
        )
        .expect_err("stale mutation must fail");
        assert!(error.contains("changed in another window"));
        let reopened = store.load(&session.id).expect("reopen");
        assert_eq!(reopened.title, "Changed elsewhere");
        assert!(reopened.linked_corpus_id.is_none());
    }

    #[test]
    fn linked_corpus_attach_rejects_renderer_supplied_nonempty_draft() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let cache = tempfile::tempdir().expect("cache");
        let mut draft = cd_core::sessions::Session::new("Unsafe draft");
        draft.messages.push(cd_core::sessions::StoredMessage {
            id: "user-1".into(),
            role: "user".into(),
            content: "renderer supplied".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        let draft_id = draft.id.clone();
        let updated_at = wire_session_revision(&draft);

        let error = set_chat_linked_corpus_at(
            &store,
            cache.path(),
            &draft_id,
            None,
            Some(draft),
            Some(updated_at),
        )
        .expect_err("nonempty draft must fail");
        assert!(error.contains("draft chat identity is invalid"));
        assert!(!store.exists(&draft_id).expect("draft existence"));
    }

    #[test]
    fn linked_log_fallback_notice_discloses_unavailable_context() {
        let event = linked_log_fallback_notice();
        assert!(matches!(
            event,
            StreamEvent::Error { code, message }
                if code == "linked_log_only_fallback"
                    && message.contains("Continuing with bounded read-only log tools")
                    && message.contains("workspace files, memory, and connectors are not available")
        ));
    }

    #[test]
    fn concurrent_startup_and_turn_share_one_host_initialization_flight() {
        let flight = Arc::new(HostInitFlight::default());
        let init_started = Arc::new(Barrier::new(2));
        let release_init = Arc::new(Barrier::new(2));
        let init_calls = Arc::new(AtomicUsize::new(0));

        let startup_flight = Arc::clone(&flight);
        let startup_started = Arc::clone(&init_started);
        let startup_release = Arc::clone(&release_init);
        let startup_calls = Arc::clone(&init_calls);
        let startup = std::thread::spawn(move || {
            startup_flight.run(|| {
                startup_calls.fetch_add(1, Ordering::SeqCst);
                startup_started.wait();
                startup_release.wait();
                Ok(())
            })
        });

        init_started.wait();
        let turn_flight = Arc::clone(&flight);
        let turn_calls = Arc::clone(&init_calls);
        let turn = std::thread::spawn(move || {
            turn_flight.run(|| {
                turn_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        });

        assert!(
            flight.wait_for_waiters(1, Duration::from_secs(1)),
            "turn should join the startup initialization flight"
        );
        assert_eq!(init_calls.load(Ordering::SeqCst), 1);
        release_init.wait();

        startup
            .join()
            .expect("startup thread")
            .expect("startup init");
        turn.join().expect("turn thread").expect("turn init");
        assert_eq!(
            init_calls.load(Ordering::SeqCst),
            1,
            "the waiting turn must reuse the startup result"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn host_timeout_is_terminal_provider_free_and_retry_recovers() {
        let flight = Arc::new(HostInitFlight::default());
        let init_started = Arc::new(Barrier::new(2));
        let release_init = Arc::new(Barrier::new(2));
        let init_calls = Arc::new(AtomicUsize::new(0));
        let provider_calls = Arc::new(AtomicUsize::new(0));

        let blocked_flight = Arc::clone(&flight);
        let blocked_started = Arc::clone(&init_started);
        let blocked_release = Arc::clone(&release_init);
        let blocked_calls = Arc::clone(&init_calls);
        let first_turn = tokio::spawn(async move {
            wait_for_host_readiness(Duration::from_millis(50), move || {
                blocked_flight.run(|| {
                    blocked_calls.fetch_add(1, Ordering::SeqCst);
                    blocked_started.wait();
                    blocked_release.wait();
                    Ok(())
                })
            })
            .await
        });

        let started_wait = Arc::clone(&init_started);
        tokio::task::spawn_blocking(move || started_wait.wait())
            .await
            .expect("initialization start barrier");
        let first_result = first_turn.await.expect("first turn task");
        if first_result.is_ok() {
            provider_calls.fetch_add(1, Ordering::SeqCst);
        }
        assert_eq!(first_result, Err(HostReadinessFailure::Timeout));
        assert_eq!(
            provider_calls.load(Ordering::SeqCst),
            0,
            "a host-readiness timeout must not reach the provider"
        );

        let events = host_readiness_terminal_events(&HostReadinessFailure::Timeout);
        assert!(matches!(
            &events[0],
            StreamEvent::Error { code, message }
                if code == "host_readiness_timeout"
                    && message.contains("before contacting the provider")
                    && message.contains("retry")
        ));
        assert!(matches!(
            &events[1],
            StreamEvent::TurnCompleted { reason } if reason == "host_not_ready"
        ));

        let retry_flight = Arc::clone(&flight);
        let retry_calls = Arc::clone(&init_calls);
        let retry = tokio::spawn(async move {
            wait_for_host_readiness(Duration::from_secs(1), move || {
                retry_flight.run(|| {
                    retry_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            })
            .await
        });

        let waiter_flight = Arc::clone(&flight);
        assert!(
            tokio::task::spawn_blocking(move || {
                waiter_flight.wait_for_waiters(1, Duration::from_secs(1))
            })
            .await
            .expect("retry waiter observation"),
            "retry should wait on the still-running initialization flight"
        );
        let release_wait = Arc::clone(&release_init);
        tokio::task::spawn_blocking(move || release_wait.wait())
            .await
            .expect("initialization release barrier");

        let retry_result = retry.await.expect("retry task");
        if retry_result.is_ok() {
            provider_calls.fetch_add(1, Ordering::SeqCst);
        }
        assert_eq!(retry_result, Ok(()));
        assert_eq!(
            init_calls.load(Ordering::SeqCst),
            1,
            "retry must reuse the initialization that became ready"
        );
        assert_eq!(
            provider_calls.load(Ordering::SeqCst),
            1,
            "provider work may resume only after host readiness succeeds"
        );
    }

    #[test]
    fn background_index_build_keeps_live_host_mutex_available() {
        let dir = tempfile::tempdir().expect("temp workspace");
        let workspace = Workspace::new("workspace", vec![dir.path().to_path_buf()]);
        let host = ToolHost::new(workspace.clone(), KeywordIndex::new(), None);
        let host_arc = Arc::new(Mutex::new(Some(host)));
        let worker_host = Arc::clone(&host_arc);
        let worker_workspace = workspace.clone();
        let build_started = Arc::new(Barrier::new(2));
        let allow_install = Arc::new(Barrier::new(2));
        let worker_started = Arc::clone(&build_started);
        let worker_install = Arc::clone(&allow_install);

        let worker = std::thread::spawn(move || {
            build_and_install_background_index(&worker_host, &worker_workspace, || {
                worker_started.wait();
                worker_install.wait();
                Ok(BackgroundIndexBuild {
                    index: KeywordIndex::new(),
                    stats: ReindexStats::default(),
                    bytes_capped: false,
                    resident_chunks: 0,
                })
            })
        });

        build_started.wait();
        let live_host = host_arc
            .try_lock()
            .expect("background index build must not hold the live host mutex");
        assert!(live_host.is_some());
        drop(live_host);
        allow_install.wait();

        assert!(worker.join().expect("worker").expect("build").is_some());
    }

    #[test]
    fn memory_note_fallback_listing_runs_off_the_app_main_thread() {
        let src = include_str!("lib.rs");
        let fn_start = src
            .find("async fn list_memory_notes")
            .expect("async list_memory_notes command");
        let fn_src = &src[fn_start..];
        let fallback_call = fn_src
            .find("list_memory_files(&ws)")
            .expect("memory_fs fallback");
        let spawn_blocking = fn_src
            .find("tauri::async_runtime::spawn_blocking")
            .expect("blocking worker fallback");

        assert!(
            spawn_blocking < fallback_call,
            "workspace memory note fallback must not read directories/files on the app main thread"
        );
    }

    #[test]
    fn active_log_corpus_ui_commands_do_not_force_host_construction() {
        let src = include_str!("lib.rs");
        let set_start = src
            .find("fn set_active_log_corpus(")
            .expect("set_active_log_corpus command");
        let get_start = src
            .find("fn get_active_log_corpus(")
            .expect("get_active_log_corpus command");
        let log_explorer_marker = src
            .find("// ── Log Explorer")
            .expect("Log Explorer section marker");
        let explorer_start = src
            .find("async fn open_log_explorer(")
            .expect("open_log_explorer command");
        let explorer_end = src[explorer_start..]
            .find("/// Harvest row DTO")
            .map(|offset| explorer_start + offset)
            .expect("open_log_explorer boundary");

        let set_src = &src[set_start..get_start];
        let get_src = &src[get_start..log_explorer_marker];
        let explorer_src = &src[explorer_start..explorer_end];

        assert!(
            set_src.contains("set_active_log_corpus_state_nonblocking(&state, corpus_id)"),
            "selecting a log corpus should update active corpus state without building the host"
        );
        assert!(
            !set_src.contains("ensure_host(&state)"),
            "set_active_log_corpus must not synchronously construct the host from Logs-pane selection"
        );
        assert!(
            get_src.contains("active_log_corpus_snapshot(&state)"),
            "get_active_log_corpus should read the UI-selected corpus state"
        );
        assert!(
            !get_src.contains("ensure_host(&state)"),
            "get_active_log_corpus must not synchronously construct the host"
        );
        assert!(
            explorer_src.contains("set_active_log_corpus_state_nonblocking"),
            "opening Explorer should still remember the active corpus for later tools"
        );
        assert!(
            !explorer_src.contains("ensure_host(&state)"),
            "open_log_explorer must not strand the packaged window on host setup"
        );
        assert!(
            src.contains("active_log_corpus: Mutex<Option<String>>"),
            "AppState should retain the UI-selected corpus independently of ToolHost readiness"
        );
        assert!(
            src.contains("apply_active_log_corpus_to_host(state, &mut host)"),
            "rebuilt hosts must receive the pending active corpus"
        );
    }

    #[test]
    fn active_log_corpus_id_is_trimmed_and_blank_means_none() {
        assert_eq!(
            normalize_log_corpus_id(Some(" incident ".into())),
            Some("incident".into())
        );
        assert_eq!(normalize_log_corpus_id(Some(" \t\n ".into())), None);
        assert_eq!(normalize_log_corpus_id(None), None);
    }

    #[test]
    fn log_search_cancel_keys_are_bounded_and_namespaced() {
        assert_eq!(
            log_search_cancel_key("find-123").unwrap(),
            "log_search:find-123"
        );
        for invalid in ["", "contains space", "../escape"] {
            assert!(log_search_cancel_key(invalid).is_err(), "{invalid}");
        }
        assert!(log_search_cancel_key(&"a".repeat(129)).is_err());
    }

    #[test]
    fn log_explorer_local_search_and_bookmarks_do_not_force_host_construction() {
        let src = include_str!("lib.rs");
        let log_search_start = src.find("fn log_search(").expect("log_search command");
        let discard_start = src
            .find("fn discard_log_corpus(")
            .expect("discard_log_corpus command");
        let event_search_start = src
            .find("fn log_search_events(")
            .expect("log_search_events command");
        let bookmarks_start = src
            .find("fn log_list_bookmarks(")
            .expect("log_list_bookmarks command");
        let add_bookmark_start = src
            .find("fn log_add_bookmark(")
            .expect("log_add_bookmark command");
        let delete_bookmark_start = src
            .find("fn log_delete_bookmark(")
            .expect("log_delete_bookmark command");
        let linked_chats_start = src
            .find("fn list_chat_sessions_for_corpus(")
            .expect("linked chat command");

        let log_search_src = &src[log_search_start..discard_start];
        let event_search_src = &src[event_search_start..bookmarks_start];
        let add_bookmark_src = &src[add_bookmark_start..delete_bookmark_start];
        let delete_bookmark_src = &src[delete_bookmark_start..linked_chats_start];

        assert!(
            log_search_src.contains("log_embed_backend_snapshot_nonblocking(&state)"),
            "overview log search should use an optional embed backend snapshot"
        );
        assert!(
            !log_search_src.contains("ensure_host(&state)"),
            "overview log search must not build the host to search a persisted corpus"
        );
        assert!(
            event_search_src.contains("log_embed_backend_snapshot_nonblocking(&state)"),
            "Explorer Find should use an optional embed backend snapshot"
        );
        assert!(
            !event_search_src.contains("ensure_host(&state)"),
            "Explorer Find must not strand the packaged window on host setup"
        );
        assert!(
            event_search_src.contains("tokio::task::spawn_blocking"),
            "Explorer Find must keep bounded scans off the app event loop"
        );
        assert!(
            event_search_src.contains("search_events_advanced_with_cancel"),
            "Explorer Find must pass the request cancellation flag into trusted core"
        );
        assert!(
            event_search_src.contains("fn cancel_log_search("),
            "Explorer Find must expose request-scoped cooperative cancellation"
        );
        assert!(
            !add_bookmark_src.contains("ensure_host(&state)"),
            "adding a local log bookmark must not build the host"
        );
        assert!(
            !delete_bookmark_src.contains("ensure_host(&state)"),
            "deleting a local log bookmark must not build the host"
        );
    }
}

#[cfg(test)]
mod chat_session_host_tests {
    use super::*;

    #[test]
    fn learned_tool_rejection_is_scoped_to_one_provider_model() {
        let mut cfg = AppConfig::default();
        cfg.providers = ProviderConfig::with_local_ollama();
        let profile = cfg.providers.active().expect("local profile").clone();

        assert!(model_tools_enabled(&cfg, &profile, "mistral:latest"));
        assert!(model_tools_enabled(&cfg, &profile, "dolphin-llama3:8b"));

        cfg.model_tools_enabled
            .insert(model_selection_key(&profile.id, "dolphin-llama3:8b"), false);
        assert!(!model_tools_enabled(&cfg, &profile, "dolphin-llama3:8b"));
        assert_eq!(
            model_tools_disabled_reason(&cfg, &profile, "dolphin-llama3:8b"),
            Some("model")
        );
        assert!(model_tools_enabled(&cfg, &profile, "mistral:latest"));

        let mut profile_disabled = profile;
        profile_disabled.capabilities.tools = false;
        assert_eq!(
            model_tools_disabled_reason(&cfg, &profile_disabled, "mistral:latest"),
            Some("profile")
        );
    }

    #[test]
    fn linked_empty_chat_is_durable_but_ordinary_empty_draft_is_not() {
        let ordinary = Session::new("Chat");
        assert!(!should_persist_chat_session(&ordinary));

        let mut linked = Session::new("Logs · fixture");
        linked.set_linked_corpus_id(Some("corpus-1".into()));
        assert!(should_persist_chat_session(&linked));
    }

    #[test]
    fn explorer_turn_context_must_match_the_durable_session_link() {
        let mut linked = Session::new("Logs · fixture");
        linked.set_linked_corpus_id(Some("corpus-a".into()));

        let context = validate_log_explorer_turn_context(
            &linked,
            "log-explorer-a",
            LogExplorerTurnContextReq {
                corpus_id: "corpus-a".into(),
                brief: "levels=error; selectedSeqs=[1,2]".into(),
            },
        )
        .expect("matching linked context");
        assert_eq!(context.corpus_id, "corpus-a");
        assert!(matches!(
            context.origin,
            cd_core::agent::LinkedLogTurnOrigin::Explorer { ref window_id, .. }
                if window_id == "log-explorer-a"
        ));

        let mismatch = validate_log_explorer_turn_context(
            &linked,
            "log-explorer-b",
            LogExplorerTurnContextReq {
                corpus_id: "corpus-b".into(),
                brief: "levels=info".into(),
            },
        )
        .unwrap_err();
        assert!(mismatch.contains("does not match"), "{mismatch}");

        let ordinary = Session::new("Chat");
        assert!(validate_log_explorer_turn_context(
            &ordinary,
            "main",
            LogExplorerTurnContextReq {
                corpus_id: "corpus-a".into(),
                brief: "levels=error".into(),
            },
        )
        .is_err());
    }

    #[test]
    fn ordinary_unlinked_session_resolves_no_log_context() {
        let ordinary = Session::new("Ordinary");
        assert!(linked_log_turn_context(Some(&ordinary), "main", None)
            .expect("ordinary context")
            .is_none());
        assert!(linked_log_turn_context(None, "main", None)
            .expect("ephemeral ordinary chat")
            .is_none());
    }

    #[test]
    fn main_chat_linked_context_comes_only_from_the_durable_session() {
        let mut linked = Session::new("Incident");
        linked.set_linked_corpus_id(Some("corpus-a".into()));

        let context = linked_log_turn_context(Some(&linked), "main", None)
            .expect("valid context")
            .expect("linked context");
        assert_eq!(context.corpus_id, "corpus-a");
        assert_eq!(
            context.origin,
            cd_core::agent::LinkedLogTurnOrigin::MainChat
        );
    }

    #[test]
    fn stale_main_chat_link_fails_corpus_preflight_before_provider_host_path() {
        let cache = tempfile::tempdir().expect("cache");
        let mut linked = Session::new("Incident");
        linked.set_linked_corpus_id(Some("discarded-corpus".into()));
        let context = linked_log_turn_context(Some(&linked), "main", None)
            .expect("valid durable link")
            .expect("linked context");

        let error = validate_linked_log_corpus_at(cache.path(), &context.corpus_id)
            .expect_err("stale corpus must fail closed");
        assert!(!error.trim().is_empty());
    }

    #[test]
    fn corrupt_durable_session_cannot_degrade_into_an_ordinary_turn() {
        let root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(root.path());
        let session = Session::new("Incident");
        store.save(&session).expect("save");
        std::fs::write(
            root.path().join(format!("{}.json", session.id)),
            b"{not-json",
        )
        .expect("corrupt session");

        let error = load_session_for_turn(&store, &session.id)
            .expect_err("corrupt durable session must fail closed");
        assert!(error.contains("before provider contact"), "{error}");

        assert!(load_session_for_turn(&store, "new-ephemeral")
            .expect("ephemeral draft")
            .is_none());
    }
}

#[cfg(test)]
mod log_embedding_host_tests {
    use super::*;

    #[test]
    fn desktop_ingest_plan_uses_dedicated_local_backend_and_bulk_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = cd_core::workspace::Workspace::new("logs", vec![dir.path().to_path_buf()]);
        let index = cd_core::index::KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);
        host.set_log_embed_backend(
            Some(std::sync::Arc::new(
                cd_core::embed::ConceptEmbedBackend::new(32),
            )),
            "fixture-local",
        );

        let (policy, backend) = desktop_local_log_embed_plan(&host);
        assert_eq!(policy.mode, cd_core::log_analysis::LogEmbedMode::Local);
        assert_eq!(policy.model_id, "fixture-local");
        assert_eq!(
            policy.defer_above_source_bytes,
            Some(cd_core::log_analysis::LOCAL_EMBED_DEFER_SOURCE_BYTES)
        );
        assert!(backend.is_some());
    }
}
