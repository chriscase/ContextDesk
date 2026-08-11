//! ContextDesk Tauri host — secrets stay here; webview gets redacted DTOs only.

mod capability_qualification_host;
mod handbook;
mod investigation_report_export;
mod log_diagnostic_report;
mod log_diagnostics;
mod logging_quality_host;

use cd_core::branding::Branding;
use cd_core::capability_qualification::CatalogChange;
use cd_core::chat::{ChatMessage, Role as ChatRole};
use cd_core::config::{
    config_path, ensure_config_dir, load_config, save_config, AppConfig, ConfluenceSettings,
    WorkspaceConfig, XSettings, CONFLUENCE_PAT_REF, X_API_KEY_REF,
};
use cd_core::discovery::{discover_local, ollama_reachable, LocalCandidate};
use cd_core::help::{HelpIndex, HelpPage, HelpSearchHit, HelpSection};
use cd_core::keychain_store::{
    file_secret_ref, key_ref_confluence_pat, key_ref_for_profile, key_ref_x_api_key,
    looks_like_raw_secret, read_file_secret_ref, ReferencedSecretStore, SecretStore,
};
use cd_core::memory_fs::{list_memory_files, read_workspace_file, write_memory_file, MemoryFile};
use cd_core::model_curation::{
    curation_decision, model_selection_key, parse_model_selection_key, CurationDecision,
    CurationImpactDto, CurationSummaryDto, ModelAvailability, ModelOptionDto,
};
use cd_core::permissions::PermissionDecision;
use cd_core::preflight::{
    run_preflight, PreflightCategory, PreflightInput, PreflightItem, PreflightLevel,
    PreflightReport,
};
use cd_core::probe::{expand_base_candidates, normalize_gateway_input};
use cd_core::providers::{
    ProviderConfig, ProviderDeadlinePreference, ProviderKind, ProviderProfile,
};
use cd_core::research::{events_to_dto, grant_and_execute, EventDto};
use cd_core::sessions::{
    sanitize_generated_title, session_title_llm_prompt, title_from_prompt, Session, SessionMeta,
    SessionSearchHit, SessionStore, StoredMessage,
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
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant as StdInstant};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const S3_ACCESS_KEY_REF: &str = "s3/default/access_key";
const S3_SECRET_KEY_REF: &str = "s3/default/secret_key";
const S3_SESSION_TOKEN_REF: &str = "s3/default/session_token";
const AGENT_HOST_READY_TIMEOUT: Duration = Duration::from_secs(5);
const LINKED_CHECKPOINT_TTL: Duration = Duration::from_secs(30 * 60);
const LINKED_CHECKPOINT_ENTRY_CAP: usize = 16;
const LINKED_CHECKPOINT_TOTAL_BYTES: usize = 2 * 1024 * 1024;
const PENDING_INVESTIGATION_EVIDENCE_CAP: usize = 64;

#[derive(Clone)]
struct StoredLinkedCheckpoint<T> {
    checkpoint: T,
    inserted_at: StdInstant,
    sequence: u64,
    bytes: usize,
}

#[cfg(test)]
mod pending_investigation_evidence_tests {
    use super::*;

    fn pending(index: usize) -> PendingInvestigationEvidence {
        PendingInvestigationEvidence {
            corpus_id: format!("corpus-{index}"),
            title: format!("Evidence {index}"),
            event_refs: Vec::new(),
            noise_lens: cd_core::investigations::InvestigationNoiseLens::Active,
            target: PendingInvestigationTarget::Existing {
                id: format!("investigation-{index}"),
                expected_revision: index as u64 + 1,
            },
        }
    }

    #[test]
    fn prepared_token_is_one_shot_and_preserves_exact_target() {
        let mut store = PendingInvestigationEvidenceStore::default();
        let token = store.insert(pending(4));
        let first = store.take(&token).expect("prepared token");
        assert_eq!(first.corpus_id, "corpus-4");
        assert!(matches!(
            first.target,
            PendingInvestigationTarget::Existing {
                ref id,
                expected_revision: 5
            } if id == "investigation-4"
        ));
        assert!(store.take(&token).is_none(), "token must be exactly once");
    }

    #[test]
    fn prepared_token_store_evicts_oldest_at_bound() {
        let mut store = PendingInvestigationEvidenceStore::default();
        let oldest = store.insert(pending(0));
        for index in 1..=PENDING_INVESTIGATION_EVIDENCE_CAP {
            store.insert(pending(index));
        }
        assert!(store.take(&oldest).is_none());
        assert_eq!(store.by_token.len(), PENDING_INVESTIGATION_EVIDENCE_CAP);
    }
}

struct LinkedCheckpointStore<T = cd_core::agent::LinkedSynthesisCheckpoint> {
    entries: HashMap<String, StoredLinkedCheckpoint<T>>,
    next_sequence: u64,
    total_bytes: usize,
}

impl<T> Default for LinkedCheckpointStore<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            next_sequence: 0,
            total_bytes: 0,
        }
    }
}

impl<T: Clone> LinkedCheckpointStore<T> {
    fn purge_expired_at(&mut self, now: StdInstant) {
        let expired = self
            .entries
            .iter()
            .filter_map(|(session_id, stored)| {
                (now.saturating_duration_since(stored.inserted_at) >= LINKED_CHECKPOINT_TTL)
                    .then_some(session_id.clone())
            })
            .collect::<Vec<_>>();
        for session_id in expired {
            self.remove(&session_id);
        }
    }

    fn insert_value_at(
        &mut self,
        session_id: String,
        checkpoint: T,
        bytes: usize,
        now: StdInstant,
    ) -> bool {
        self.purge_expired_at(now);
        self.remove(&session_id);
        if bytes > LINKED_CHECKPOINT_TOTAL_BYTES {
            return false;
        }
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        let inserted_session_id = session_id.clone();
        self.entries.insert(
            session_id,
            StoredLinkedCheckpoint {
                checkpoint,
                inserted_at: now,
                sequence: self.next_sequence,
                bytes,
            },
        );
        while self.entries.len() > LINKED_CHECKPOINT_ENTRY_CAP
            || self.total_bytes > LINKED_CHECKPOINT_TOTAL_BYTES
        {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(session_id, stored)| (stored.sequence, *session_id))
                .map(|(session_id, _)| session_id.clone());
            let Some(oldest) = oldest else {
                break;
            };
            self.remove(&oldest);
        }
        self.entries.contains_key(&inserted_session_id)
    }

    fn get_value(&mut self, session_id: &str, now: StdInstant) -> Option<T> {
        self.purge_expired_at(now);
        self.entries
            .get(session_id)
            .map(|stored| stored.checkpoint.clone())
    }

    fn remove(&mut self, session_id: &str) -> bool {
        let Some(stored) = self.entries.remove(session_id) else {
            return false;
        };
        self.total_bytes = self.total_bytes.saturating_sub(stored.bytes);
        true
    }
}

impl LinkedCheckpointStore {
    fn insert(
        &mut self,
        session_id: String,
        checkpoint: cd_core::agent::LinkedSynthesisCheckpoint,
    ) -> bool {
        let bytes = checkpoint.retained_payload_bytes();
        self.insert_value_at(session_id, checkpoint, bytes, StdInstant::now())
    }

    fn get(&mut self, session_id: &str) -> Option<cd_core::agent::LinkedSynthesisCheckpoint> {
        self.get_value(session_id, StdInstant::now())
    }
}

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

const LOG_CORPUS_HANDLE_CACHE_CAP: usize = 4;

#[derive(Default)]
struct LogCorpusHandleCacheState {
    entries: HashMap<String, Arc<cd_core::log_analysis::LogCorpus>>,
    order: std::collections::VecDeque<String>,
}

#[derive(Default)]
struct LogCorpusHandleCache {
    state: Mutex<LogCorpusHandleCacheState>,
}

impl LogCorpusHandleCache {
    fn open(
        &self,
        cache_root: &std::path::Path,
        corpus_id: &str,
    ) -> Result<Arc<cd_core::log_analysis::LogCorpus>, String> {
        let mut state = self.state.lock().expect("log corpus handle cache");
        if let Some(corpus) = state.entries.get(corpus_id).cloned() {
            state.order.retain(|id| id != corpus_id);
            state.order.push_back(corpus_id.to_string());
            return Ok(corpus);
        }

        // Hold the small cache lock during open so simultaneous startup reads
        // coalesce into one schema/template/vector initialization.
        let corpus = Arc::new(
            cd_core::log_analysis::LogCorpus::open(cache_root, corpus_id)
                .map_err(|error| error.to_string())?,
        );
        while state.entries.len() >= LOG_CORPUS_HANDLE_CACHE_CAP {
            let Some(evicted) = state.order.pop_front() else {
                break;
            };
            state.entries.remove(&evicted);
        }
        state
            .entries
            .insert(corpus_id.to_string(), Arc::clone(&corpus));
        state.order.push_back(corpus_id.to_string());
        Ok(corpus)
    }

    fn remove(&self, corpus_id: &str) {
        let mut state = self.state.lock().expect("log corpus handle cache");
        state.entries.remove(corpus_id);
        state.order.retain(|id| id != corpus_id);
    }
}

struct AppState {
    branding: Branding,
    config: Mutex<AppConfig>,
    secrets: ReferencedSecretStore,
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
    /// Bounded reusable corpus handles for Explorer/library read commands.
    /// Coalesces repeated schema/template/vector initialization at startup.
    log_corpus_handles: Arc<LogCorpusHandleCache>,
    /// One payload-free failed-ingest diagnostic. Memory-only: replaced when a
    /// later ingest starts, explicitly clearable, and absent after restart.
    failed_log_ingest_diagnostic: Mutex<cd_core::log_analysis::FailedIngestDiagnosticStore>,
    /// Serializes the complete demo check/import/marker transaction.
    demo_log_install: tokio::sync::Mutex<()>,
    /// Bounded host-rendered diagnostic previews keyed by opaque, process-local
    /// report ids. The renderer never supplies export content.
    log_diagnostic_reports: Mutex<log_diagnostic_report::LogDiagnosticReportStore>,
    /// Bounded host-rendered investigation report previews (#532), same
    /// authority model as diagnostics: opaque ids, renderer sends no text.
    investigation_report_exports:
        Mutex<investigation_report_export::InvestigationReportExportStore>,
    /// Serializes chat-session writes across windows so governed fields cannot
    /// race ordinary transcript saves (#695).
    chat_session_mutation: Mutex<()>,
    /// Serializes one-process Investigation selection/create/mutation across windows.
    investigation_mutation: Mutex<()>,
    /// Bounded per-turn Activity Inspector records, keyed by
    /// `(session_id, assistant message id)`. Memory-only and evicting; the
    /// inspector is an explanation of a turn, never a second source of
    /// truth for it. See `cd_core::activity::ActivityStore`.
    activity: Mutex<cd_core::activity::ActivityStore>,
    /// Explicitly opt-in, sensitive developer payloads. Process-local only:
    /// this type has no durable writer and is cleared with its chat session.
    developer_activity: Mutex<cd_core::turn_trace::DeveloperDetailStore>,
    /// One-way per-turn gate: once closed, the owning turn stops retaining
    /// and delivering developer detail for the rest of that turn. A fresh
    /// generation is installed for every turn, so closing it never affects a
    /// later turn on the same session.
    ///
    /// Two independent triggers share this single gate rather than each
    /// getting its own bespoke plumbing:
    ///   - the session is trashed/deleted while the turn is still running
    ///     (`retire_chat_session_activity`) — an in-flight observer must not
    ///     keep delivering a deleted chat's sensitive detail;
    ///   - the operator turns Developer detail off while the turn is still
    ///     running (`suppress_developer_activity_detail`) — delivery stops
    ///     immediately rather than continuing until the turn ends.
    developer_activity_suppressed: DeveloperDetailSuppressionMap,
    /// Opaque, one-shot evidence commits prepared by an explicit renderer preview.
    /// Payload and exact target stay host-only and are bounded in process memory.
    pending_investigation_evidence: Mutex<PendingInvestigationEvidenceStore>,
    /// Per-session cooperative cancel flags for in-flight turns (#109).
    cancels: Mutex<HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    /// Owner generation for each admitted chat turn. A second window cannot
    /// replace cancellation/checkpoint ownership for the same session.
    active_turn_owners: Mutex<HashMap<String, u64>>,
    next_turn_owner: std::sync::atomic::AtomicU64,
    /// Host-only bounded evidence retained for an explicit synthesis-only retry.
    /// Never serialized to config, sessions, logs, or webview IPC.
    linked_synthesis_checkpoints: Mutex<LinkedCheckpointStore>,
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
    /// Explicit capability qualification evidence (#724), shared with the CLI.
    /// Keyed by profile + endpoint fingerprint + exact model + schema version (#650 isolation).
    qualification_store: Mutex<cd_core::capability_qualification::QualificationStore>,
    /// Secret-free evidence file. Viewing it never resolves credentials or contacts a provider.
    qualification_store_path: PathBuf,
    /// One-shot exact Log Explorer navigation targets (#698 exact-nav).
    /// Keyed by corpus id. `take` delivers once; cleared on take, discard, or window destroy.
    log_explorer_nav_targets: Mutex<LogExplorerNavTargetStore>,
}

#[derive(Debug, Clone)]
enum PendingInvestigationTarget {
    Existing { id: String, expected_revision: u64 },
    CreateNew,
}

#[derive(Debug, Clone)]
struct PendingInvestigationEvidence {
    corpus_id: String,
    title: String,
    event_refs: Vec<cd_core::log_analysis::BookmarkEventRef>,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
    target: PendingInvestigationTarget,
}

#[derive(Debug, Default)]
struct PendingInvestigationEvidenceStore {
    by_token: HashMap<String, PendingInvestigationEvidence>,
    order: std::collections::VecDeque<String>,
}

impl PendingInvestigationEvidenceStore {
    fn insert(&mut self, pending: PendingInvestigationEvidence) -> String {
        while self.order.len() >= PENDING_INVESTIGATION_EVIDENCE_CAP {
            if let Some(expired) = self.order.pop_front() {
                self.by_token.remove(&expired);
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        self.by_token.insert(token.clone(), pending);
        self.order.push_back(token.clone());
        token
    }

    fn take(&mut self, token: &str) -> Option<PendingInvestigationEvidence> {
        let pending = self.by_token.remove(token);
        if pending.is_some() {
            self.order.retain(|candidate| candidate != token);
        }
        pending
    }

    fn remove(&mut self, token: &str) -> bool {
        self.take(token).is_some()
    }
}

/// One-shot pending target for a Log Explorer window (process-local only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogExplorerNavTarget {
    /// `event` or `template`.
    kind: String,
    /// Canonical decimal u64 string — never a silent JS Number widen.
    id: String,
}

/// Process-local store of one-shot Explorer navigation targets.
#[derive(Debug, Default)]
struct LogExplorerNavTargetStore {
    by_corpus: HashMap<String, LogExplorerNavTarget>,
}

impl LogExplorerNavTargetStore {
    fn set(&mut self, corpus_id: String, target: LogExplorerNavTarget) {
        self.by_corpus.insert(corpus_id, target);
    }

    fn take(&mut self, corpus_id: &str) -> Option<LogExplorerNavTarget> {
        self.by_corpus.remove(corpus_id)
    }

    fn clear(&mut self, corpus_id: &str) {
        self.by_corpus.remove(corpus_id);
    }

    fn clear_for_window_label(&mut self, label: &str) {
        if !label.starts_with("log-explorer-") {
            return;
        }
        self.by_corpus
            .retain(|corpus_id, _| log_explorer_window_label(corpus_id) != label);
    }

    #[cfg(test)]
    fn peek(&self, corpus_id: &str) -> Option<&LogExplorerNavTarget> {
        self.by_corpus.get(corpus_id)
    }
}

/// Stable Tauri window label for a Log Explorer corpus window.
fn log_explorer_window_label(corpus_id: &str) -> String {
    format!(
        "log-explorer-{}",
        corpus_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
            .take(48)
            .collect::<String>()
    )
}

/// Native title for a dedicated Log Explorer window (#641).
///
/// Corpus name FIRST so macOS end-truncation eats the fixed suffix, never the
/// name the user is looking for. Em dash (U+2014) separator by design.
fn log_explorer_window_title(corpus_name: &str) -> String {
    format!("{corpus_name} — Log Explorer")
}

#[cfg(test)]
mod log_explorer_window_title_tests {
    use super::log_explorer_window_title;

    #[test]
    fn log_explorer_window_title_puts_corpus_first_with_em_dash() {
        assert_eq!(
            log_explorer_window_title("prod-incident-42"),
            "prod-incident-42 — Log Explorer"
        );
        // Separator is an em dash (U+2014), not a hyphen.
        assert!(log_explorer_window_title("x").contains('\u{2014}'));
    }

    #[test]
    fn log_explorer_window_title_passes_unicode_names_through() {
        assert_eq!(
            log_explorer_window_title("ログ検証 — Ünïcode"),
            "ログ検証 — Ünïcode — Log Explorer"
        );
        assert_eq!(log_explorer_window_title(""), " — Log Explorer");
    }
}

/// Tauri event name delivered to an Explorer window when a new exact target is staged.
const LOG_EXPLORER_NAV_TARGET_EVENT: &str = "log-explorer-nav-target";

/// Parse a navigation target DTO into a trusted governed identity.
fn parse_log_explorer_nav_target(
    kind: &str,
    id: &str,
) -> Result<cd_core::log_analysis::GovernedLogCitationId, String> {
    let kind = kind.trim();
    let id = id.trim();
    let prefix = match kind {
        "event" => "log_event:",
        "template" => "log_template:",
        _ => {
            return Err(format!(
                "unsupported log navigation kind `{kind}` (expected event or template)"
            ))
        }
    };
    let raw = format!("{prefix}{id}");
    cd_core::log_analysis::parse_governed_log_citation_id(&raw)
        .ok_or_else(|| format!("invalid governed log identity `{raw}`"))
}

/// Fail closed when the cited evidence is missing from the opened corpus.
fn ensure_log_nav_evidence_exists(
    corpus: &cd_core::log_analysis::LogCorpus,
    parsed: &cd_core::log_analysis::GovernedLogCitationId,
) -> Result<(), String> {
    use cd_core::log_analysis::{
        query_event_neighborhood, EventNeighborhoodQuery, EventQuery, GovernedLogCitationKind,
        TargetResolveStatus,
    };
    match parsed.kind {
        GovernedLogCitationKind::Event => {
            let nb = query_event_neighborhood(
                corpus,
                &EventNeighborhoodQuery {
                    target_seq: parsed.value,
                    before: 0,
                    after: 0,
                    filter: EventQuery::default(),
                    sort_by_time: true,
                },
            )
            .map_err(|e| e.to_string())?;
            if nb.status == TargetResolveStatus::Missing {
                return Err(format!("event {} was not found in this corpus", parsed.id));
            }
            Ok(())
        }
        GovernedLogCitationKind::Template => {
            if corpus.template_pattern(parsed.value).is_none() {
                return Err(format!(
                    "template {} was not found in this corpus",
                    parsed.id
                ));
            }
            Ok(())
        }
    }
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
    TurnDeadline,
    Cancelled,
    Initialization,
    Worker,
}

impl HostReadinessFailure {
    fn code(&self) -> &'static str {
        match self {
            Self::Timeout => "host_readiness_timeout",
            Self::TurnDeadline => "budget_time",
            Self::Cancelled => "cancel",
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
            Self::TurnDeadline => {
                "The whole-turn deadline expired while workspace tools were starting. No provider \
                 request was allowed to continue beyond that deadline."
            }
            Self::Cancelled => {
                "The turn was cancelled while workspace tools were starting. No provider request \
                 was started."
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

async fn wait_for_atomic_cancel(cancel: &std::sync::atomic::AtomicBool) {
    while !cancel.load(std::sync::atomic::Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_host_readiness_for_turn<F>(
    timeout: Duration,
    started: tokio::time::Instant,
    plan: cd_core::router::TurnDeadlinePlan,
    cancel: &std::sync::atomic::AtomicBool,
    initialize: F,
) -> Result<(), HostReadinessFailure>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    let remaining = if plan.total_ms == 0 {
        timeout
    } else {
        Duration::from_millis(plan.total_ms)
            .checked_sub(started.elapsed())
            .ok_or(HostReadinessFailure::TurnDeadline)?
            .min(timeout)
    };
    tokio::select! {
        biased;
        _ = wait_for_atomic_cancel(cancel) => Err(HostReadinessFailure::Cancelled),
        result = wait_for_host_readiness(remaining, initialize) => {
            match result {
                Err(HostReadinessFailure::Timeout)
                    if plan.total_ms > 0
                        && started.elapsed() >= Duration::from_millis(plan.total_ms) =>
                {
                    Err(HostReadinessFailure::TurnDeadline)
                }
                other => other,
            }
        }
    }
}

async fn run_blocking_for_turn<T, F>(
    started: tokio::time::Instant,
    plan: cd_core::router::TurnDeadlinePlan,
    cancel: &std::sync::atomic::AtomicBool,
    task: F,
) -> Result<Result<T, String>, HostReadinessFailure>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let remaining = if plan.total_ms == 0 {
        None
    } else {
        Some(
            Duration::from_millis(plan.total_ms)
                .checked_sub(started.elapsed())
                .ok_or(HostReadinessFailure::TurnDeadline)?,
        )
    };
    tokio::select! {
        biased;
        _ = wait_for_atomic_cancel(cancel) => Err(HostReadinessFailure::Cancelled),
        result = async {
            let worker = tauri::async_runtime::spawn_blocking(task);
            match remaining {
                Some(remaining) => tokio::time::timeout(remaining, worker)
                    .await
                    .map_err(|_| HostReadinessFailure::TurnDeadline),
                None => Ok(worker.await),
            }
        } => match result? {
            Ok(value) => Ok(value),
            Err(error) => {
                tracing::warn!(error = %error, "linked turn blocking setup worker failed");
                Err(HostReadinessFailure::Worker)
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
    host.set_router_budget(cfg.router.clone());
    host.set_model_context_budgets(cfg.model_context_budgets.clone());
    apply_configured_retrieval_roles(&mut host, &cfg, &state.secrets);
    host.set_log_analysis(true, Some(cache));
    if let Ok(store) = investigation_store(state) {
        host.set_investigation_store_dir(Some(store.root().to_path_buf()));
    }
    host.set_log_only_tool_surface(true);
    host.set_log_corpus_scope(Some(context.corpus_id.clone()));
    host.set_active_log_corpus(Some(context.corpus_id.clone()));
    // Bind propose_finding to the newest active Investigation for this corpus (#646).
    if let Ok(store) = investigation_store(state) {
        if let Ok(Some(summary)) = active_investigation_for_corpus(&store, &context.corpus_id) {
            host.set_active_investigation_id(Some(summary.id));
        }
    }
    if context.noise_lens_suspended {
        host.pin_log_suppression_lens_suspended(&context.corpus_id)
            .map_err(|error| error.to_string())?;
    } else {
        host.pin_log_suppression_lens(&context.corpus_id)
            .map_err(|error| error.to_string())?;
    }
    Ok(host)
}

fn validate_linked_log_corpus_at(cache: &std::path::Path, corpus_id: &str) -> Result<(), String> {
    // Opening validates metadata, engine artifacts, templates, and DuckDB
    // schema before any provider receives the turn.
    cd_core::log_analysis::LogCorpus::open(cache, corpus_id)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
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

#[derive(Debug)]
enum LinkedTurnPreparation<T> {
    Ready(T),
    Terminal(Vec<cd_core::events::StreamEvent>),
}

async fn prepare_linked_turn_with<V, C, H, P, T>(
    started: tokio::time::Instant,
    plan: cd_core::router::TurnDeadlinePlan,
    cancel: &std::sync::atomic::AtomicBool,
    validate_corpus: V,
    capability_refusal: C,
    construct_host: H,
) -> Result<LinkedTurnPreparation<T>, HostReadinessFailure>
where
    V: FnOnce() -> Result<P, String> + Send + 'static,
    C: FnOnce() -> Option<Vec<cd_core::events::StreamEvent>>,
    H: FnOnce(P) -> Result<T, String> + Send + 'static,
    P: Send + 'static,
    T: Send + 'static,
{
    let validated = match run_blocking_for_turn(started, plan, cancel, validate_corpus).await? {
        Ok(validated) => validated,
        Err(error) => {
            tracing::warn!(error = %error, "linked corpus validation failed");
            return Ok(LinkedTurnPreparation::Terminal(
                linked_log_host_terminal_events().into(),
            ));
        }
    };
    if let Some(events) = capability_refusal() {
        return Ok(LinkedTurnPreparation::Terminal(events));
    }
    match run_blocking_for_turn(started, plan, cancel, move || construct_host(validated)).await? {
        Ok(host) => Ok(LinkedTurnPreparation::Ready(host)),
        Err(error) => {
            tracing::warn!(error = %error, "linked host construction failed");
            Ok(LinkedTurnPreparation::Terminal(
                linked_log_host_terminal_events().into(),
            ))
        }
    }
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

fn linked_setup_failure_events(
    failure: &HostReadinessFailure,
) -> Vec<cd_core::events::StreamEvent> {
    match failure {
        HostReadinessFailure::Cancelled => vec![cd_core::events::StreamEvent::TurnCompleted {
            reason: "cancel".into(),
        }],
        HostReadinessFailure::TurnDeadline | HostReadinessFailure::Timeout => vec![
            cd_core::events::StreamEvent::Error {
                code: "budget_time".into(),
                message: "The whole-turn deadline expired while validating or opening the linked \
                          corpus. No provider request was started."
                    .into(),
            },
            cd_core::events::StreamEvent::TurnCompleted {
                reason: "budget_time".into(),
            },
        ],
        HostReadinessFailure::Initialization | HostReadinessFailure::Worker => {
            linked_log_host_terminal_events().into()
        }
    }
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
    // Production Confluence seam (shared with CLI): keyless → zero secret reads.
    host.apply_confluence_from_settings(&cfg.confluence, &state.secrets);
    host.set_web_research(cfg.web_research_enabled);
    host.set_web_research_sources(&cfg.web_research_sources);
    // Log Phase-1: disposable corpora under app cache (LOG_ANALYSIS.md §10 keep-until-discarded).
    if let Ok(config_dir) = ensure_config_dir(&state.branding) {
        let log_cache = config_dir.join("cache");
        let _ = std::fs::create_dir_all(&log_cache);
        host.set_log_analysis(true, Some(log_cache));
        let inv = config_dir.join("investigations");
        let _ = std::fs::create_dir_all(&inv);
        host.set_investigation_store_dir(Some(inv));
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
    apply_configured_retrieval_roles(host, cfg, &state.secrets);
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

/// Attach explicitly enabled retrieval roles to the same production ToolHost
/// used by ordinary and linked-log turns. The role factories own dialect and
/// SSRF policy; this host only decides where the already-validated adapters
/// are used. A failed optional role is logged and leaves the existing local
/// or keyword fallback in place.
fn apply_configured_retrieval_roles(
    host: &mut ToolHost,
    cfg: &AppConfig,
    secrets: &ReferencedSecretStore,
) {
    if let Some(role) = cfg.retrieval.embedding.as_ref().filter(|role| role.enabled) {
        match cd_workflow::retrieval::build_embedding_backend(role, Some(secrets)) {
            Ok(backend) => {
                host.set_embed_backend_with_model(Some(Arc::clone(&backend)), &role.model);
                // Linked-log search and ingest use the same configured model
                // identity, so existing vectors fail closed until re-analysis
                // has established a matching corpus binding.
                host.set_log_embed_backend(Some(backend), &role.model);
                tracing::info!(model = %role.model, "configured retrieval embedding role attached");
            }
            Err(error) => {
                tracing::warn!(error = %error, "configured retrieval embedding role unavailable; keeping fallback");
            }
        }
    }
    if let Some(role) = cfg.retrieval.reranker.as_ref().filter(|role| role.enabled) {
        match cd_workflow::retrieval::build_rerank_backend(role, Some(secrets)) {
            Ok(backend) => {
                host.set_log_rerank_backend(Some(backend));
                tracing::info!(model = %role.model, "configured retrieval reranker role attached");
            }
            Err(error) => {
                tracing::warn!(error = %error, "configured retrieval reranker role unavailable; preserving pre-rerank order");
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
    let progress = TauriProcessProgress::new(app);
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
    let progress = TauriProcessProgress::new(app);
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
    let progress = TauriProcessProgress::new(app);
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

/// Non-secret multi-model settings for the Settings surface. The reviewer
/// references a provider profile id; no credential ever crosses IPC.
#[derive(Clone, Serialize)]
struct MultiModelSettingsDto {
    /// `"single"` | `"review"`.
    mode: String,
    /// Reviewer provider profile id, if configured.
    reviewer_profile_id: Option<String>,
    /// Reviewer model override, if any.
    reviewer_model: Option<String>,
    /// Whether a remote reviewer has been acknowledged.
    reviewer_allow_remote: bool,
    /// Whether the reviewer must be measured-qualified.
    reviewer_require_qualified: bool,
}

#[tauri::command]
fn get_multi_model_settings(state: State<'_, AppState>) -> MultiModelSettingsDto {
    let cfg = state.config.lock().expect("config lock");
    let mm = &cfg.multi_model;
    MultiModelSettingsDto {
        mode: mm.mode.as_str().to_string(),
        reviewer_profile_id: mm.reviewer.as_ref().map(|r| r.profile_id.clone()),
        reviewer_model: mm.reviewer.as_ref().and_then(|r| r.model.clone()),
        reviewer_allow_remote: mm.reviewer.as_ref().is_some_and(|r| r.allow_remote),
        reviewer_require_qualified: mm.reviewer.as_ref().is_none_or(|r| r.require_qualified),
    }
}

/// Set the default multi-model mode (`single`/`review`). Persists and rebuilds
/// the host. Reviewer assignment is edited via the provider config; this is
/// the on/off toggle the composer honors by default.
#[tauri::command]
fn set_multi_model_mode(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    let new_mode = match mode.as_str() {
        "review" => cd_core::multi_model::MultiModelMode::Review,
        "single" => cd_core::multi_model::MultiModelMode::Single,
        other => return Err(format!("unknown multi-model mode: {other}")),
    };
    let mut cfg = state.config.lock().expect("config lock").clone();
    cfg.multi_model.mode = new_mode;
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *state.config.lock().expect("config lock") = cfg;
    let _ = ensure_host(&state);
    Ok(())
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
    let cfg = state.config.lock().expect("config lock");
    let Some(profile) = cfg
        .providers
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
    else {
        return Ok(false);
    };
    if profile.kind == ProviderKind::XaiGrokBuild {
        return Ok(cd_core::grok_auth::detect_grok_session().is_some());
    }
    let Some(reference) = profile.api_key_ref.as_deref() else {
        return Ok(false);
    };
    state.secrets.has(reference).map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct SaveProviderReq {
    /// `ollama` | `openai_compatible`
    kind: String,
    base_url: String,
    chat_model: String,
    label: Option<String>,
    /// Optional new API key; empty/null keeps the existing explicit reference.
    api_key: Option<String>,
    /// Optional protected credential file. Mutually exclusive with `api_key`.
    #[serde(default)]
    api_key_file: Option<String>,
    /// When true, refuse non-loopback remote bases (local-only profile).
    #[serde(default)]
    local_only: Option<bool>,
    /// Optional override for native tool calling (#327). `None` preserves existing.
    #[serde(default)]
    tools_enabled: Option<bool>,
    /// Optional explicit latency class. `None` preserves the saved profile value.
    #[serde(default)]
    deadline_preference: Option<String>,
}

#[derive(Debug, Serialize)]
struct ProviderDto {
    id: String,
    kind: String,
    base_url: String,
    chat_model: String,
    label: String,
    /// Credential ref id only — never the secret.
    api_key_ref: Option<String>,
    /// Protected credential path when that source was explicitly selected.
    api_key_file_path: Option<String>,
    has_key: bool,
    /// Native tool calling enabled for this profile (#327).
    tools_enabled: bool,
    /// `auto` | `patient` | `standard`; contains no endpoint or secret.
    deadline_preference: String,
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
        api_key_file_path: p
            .api_key_ref
            .as_deref()
            .and_then(|reference| reference.strip_prefix("file:"))
            .map(str::to_string),
        has_key,
        tools_enabled: p.capabilities.tools,
        deadline_preference: match p.deadline_preference {
            ProviderDeadlinePreference::Auto => "auto",
            ProviderDeadlinePreference::Patient => "patient",
            ProviderDeadlinePreference::Standard => "standard",
        }
        .into(),
    }
}

fn select_provider_credential_reference(
    profile_id: &str,
    kind: ProviderKind,
    existing_reference: Option<String>,
    api_key: Option<&str>,
    api_key_file: Option<&str>,
    secrets: &dyn SecretStore,
) -> Result<Option<String>, String> {
    let raw_key = api_key
        .map(str::trim)
        .filter(|key| !key.is_empty() && !key.chars().all(|c| c == '•'));
    let key_file = api_key_file.map(str::trim).filter(|path| !path.is_empty());
    if raw_key.is_some() && key_file.is_some() {
        return Err("choose either a pasted API key or a protected key file, not both".into());
    }
    if matches!(kind, ProviderKind::XaiGrokBuild) && (raw_key.is_some() || key_file.is_some()) {
        return Err("Grok Build uses its CLI session; do not configure an API key here".into());
    }

    if let Some(path) = key_file {
        let reference = file_secret_ref(&PathBuf::from(path)).map_err(|e| e.to_string())?;
        // Validate the contents now so Save cannot appear successful with an
        // unreadable or empty credential. This path never consults Keychain.
        read_file_secret_ref(&reference).map_err(|e| e.to_string())?;
        return Ok(Some(reference));
    }
    if let Some(key) = raw_key {
        if !(looks_like_raw_secret(key) || key.len() >= 8) {
            return Err("API key is too short".into());
        }
        let reference = key_ref_for_profile(profile_id);
        secrets.set(&reference, key).map_err(|e| e.to_string())?;
        return Ok(Some(reference));
    }
    if matches!(kind, ProviderKind::XaiGrokBuild) {
        Ok(None)
    } else {
        Ok(existing_reference)
    }
}

#[cfg(test)]
mod provider_credential_source_tests {
    use super::*;
    use cd_core::error::CoreResult;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct CountingSecrets {
        reads: AtomicUsize,
        writes: AtomicUsize,
    }

    impl SecretStore for CountingSecrets {
        fn get(&self, _reference: &str) -> CoreResult<Option<String>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }

        fn set(&self, _reference: &str, _secret: &str) -> CoreResult<()> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn delete(&self, _reference: &str) -> CoreResult<()> {
            Ok(())
        }
    }

    #[cfg(unix)]
    #[test]
    fn protected_file_selection_never_touches_secret_store() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider.key");
        std::fs::write(&path, "synthetic-provider-key\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let secrets = CountingSecrets::default();

        let selected = select_provider_credential_reference(
            "work",
            ProviderKind::OpenAiCompatible,
            None,
            None,
            Some(path.to_str().unwrap()),
            &secrets,
        )
        .unwrap();

        assert_eq!(selected, Some(format!("file:{}", path.display())));
        assert_eq!(secrets.reads.load(Ordering::SeqCst), 0);
        assert_eq!(secrets.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn absent_source_preserves_only_an_explicit_existing_reference() {
        let secrets = CountingSecrets::default();
        let selected = select_provider_credential_reference(
            "work",
            ProviderKind::OpenAiCompatible,
            None,
            None,
            None,
            &secrets,
        )
        .unwrap();

        assert_eq!(selected, None);
        assert_eq!(secrets.reads.load(Ordering::SeqCst), 0);
        assert_eq!(secrets.writes.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn pasted_key_and_file_are_rejected_before_any_secret_store_access() {
        let secrets = CountingSecrets::default();
        let error = select_provider_credential_reference(
            "work",
            ProviderKind::OpenAiCompatible,
            None,
            Some("synthetic-provider-key"),
            Some("/tmp/provider.key"),
            &secrets,
        )
        .unwrap_err();

        assert!(error.contains("either a pasted API key or a protected key file"));
        assert_eq!(secrets.reads.load(Ordering::SeqCst), 0);
        assert_eq!(secrets.writes.load(Ordering::SeqCst), 0);
    }
}

/// Persist the active provider and its explicit Keychain or protected-file reference.
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

    let existing_api_key_ref = state
        .config
        .lock()
        .expect("config lock")
        .providers
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .and_then(|profile| profile.api_key_ref.clone());
    let api_key_ref = select_provider_credential_reference(
        &id,
        kind,
        existing_api_key_ref,
        req.api_key.as_deref(),
        req.api_key_file.as_deref(),
        &state.secrets,
    )?;

    let mut cfg = state.config.lock().expect("config lock");

    let local_only = req.local_only.unwrap_or(desc.is_local);
    if local_only && !base_url.is_empty() {
        let policy = SsrfPolicy::local_only();
        if validate_provider_url(&base_url, &policy).is_err() {
            return Err("local-only profile: base URL must be loopback (e.g. 127.0.0.1)".into());
        }
    }

    // #125: seed per-kind defaults; preserve discovered capabilities.tools (#327).
    let mut capabilities = desc.default_capabilities;
    let mut deadline_preference = Default::default();
    if let Some(existing) = cfg.providers.profiles.iter().find(|p| p.id == id) {
        capabilities.tools = existing.capabilities.tools;
        capabilities.stream = existing.capabilities.stream;
        deadline_preference = existing.deadline_preference;
        // embeddings from descriptor when kind changes still uses default above
        if existing.kind == kind {
            capabilities.embeddings = existing.capabilities.embeddings;
        }
    }
    if let Some(te) = req.tools_enabled {
        capabilities.tools = te;
    }
    if let Some(preference) = req.deadline_preference.as_deref() {
        deadline_preference = match preference {
            "auto" => ProviderDeadlinePreference::Auto,
            "patient" => ProviderDeadlinePreference::Patient,
            "standard" => ProviderDeadlinePreference::Standard,
            other => return Err(format!("unsupported deadline preference: {other}")),
        };
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
        deadline_preference,
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
    let mut catalog_change = None;
    let mut key_present = None;
    if let Some(p) = &active {
        let desc = cd_core::providers::descriptor_for(p.kind);
        if p.kind == ProviderKind::Ollama {
            let probe = cd_core::discovery::probe_provider_catalog(p, None).await;
            let reachable = probe.outcome.is_reachable();
            ollama_ok = Some(reachable);
            provider_ok = Some(reachable);
            provider_probe_detail = Some(match &probe.outcome {
                cd_core::discovery::ProbeOutcome::Reachable { reason }
                | cd_core::discovery::ProbeOutcome::KeyRejected { reason }
                | cd_core::discovery::ProbeOutcome::Unreachable { reason } => reason.clone(),
            });
            catalog_change = record_preflight_catalog(&state, p, &probe)?;
        } else if p.kind == ProviderKind::XaiGrokBuild {
            key_present = Some(cd_core::grok_auth::detect_grok_session().is_some());
            // #126: real probe (session + models list), not structural URL only.
            let probe = cd_core::discovery::probe_provider_catalog(p, None).await;
            provider_ok = Some(probe.outcome.is_reachable());
            provider_probe_detail = Some(match &probe.outcome {
                cd_core::discovery::ProbeOutcome::Reachable { reason }
                | cd_core::discovery::ProbeOutcome::KeyRejected { reason }
                | cd_core::discovery::ProbeOutcome::Unreachable { reason } => reason.clone(),
            });
            catalog_change = record_preflight_catalog(&state, p, &probe)?;
        } else if desc.needs_api_key {
            let api_key = p
                .api_key_ref
                .as_deref()
                .and_then(|reference| state.secrets.get(reference).ok().flatten());
            key_present = Some(api_key.is_some());
            // #126: live HTTP probe — same TriageTool-parity path as Discover (corp private OK).
            let probe = cd_core::discovery::probe_provider_catalog(p, api_key).await;
            provider_ok = Some(probe.outcome.is_reachable());
            provider_probe_detail = Some(match &probe.outcome {
                cd_core::discovery::ProbeOutcome::Reachable { reason }
                | cd_core::discovery::ProbeOutcome::KeyRejected { reason }
                | cd_core::discovery::ProbeOutcome::Unreachable { reason } => reason.clone(),
            });
            catalog_change = record_preflight_catalog(&state, p, &probe)?;
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
    let mut report = run_preflight(PreflightInput {
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
    });
    if let Some(change) = catalog_change.filter(CatalogChange::changed) {
        let added_preview = catalog_model_preview(&change.added);
        let detail = if change.added.is_empty() {
            format!(
                "{} model(s) were removed. Existing evidence for unchanged models was preserved.",
                change.removed.len()
            )
        } else {
            format!(
                "{} added ({}); {} removed. Review the additions and qualify only the models you may use. Existing evidence for unchanged models was preserved.",
                change.added.len(),
                added_preview,
                change.removed.len()
            )
        };
        report.items.push(PreflightItem {
            id: "provider.catalog_changed".into(),
            title: "Model catalog changed".into(),
            level: PreflightLevel::Warn,
            detail,
            fix_action: Some("ai".into()),
            category: PreflightCategory::Launch,
        });
    }
    Ok(report)
}

/// Reuse startup/pre-flight discovery as a zero-extra-request catalog drift
/// detector. Behavioral qualification remains an explicit user action.
fn record_preflight_catalog(
    state: &AppState,
    profile: &ProviderProfile,
    probe: &cd_core::discovery::ProviderCatalogProbe,
) -> Result<Option<CatalogChange>, String> {
    if !probe.outcome.is_reachable() || probe.model_ids.is_empty() {
        return Ok(None);
    }
    let mut store = state
        .qualification_store
        .lock()
        .expect("qualification_store");
    let change = store.note_catalog(
        &profile.id,
        &profile.base_url,
        probe.model_ids.iter().cloned(),
    );
    cd_core::capability_qualification::save_qualification_store(
        &state.qualification_store_path,
        &store,
    )
    .map_err(|error| format!("save discovered model catalog: {error}"))?;
    Ok(Some(change))
}

fn catalog_model_preview(model_ids: &[String]) -> String {
    const LIMIT: usize = 5;
    let shown = model_ids.iter().take(LIMIT).cloned().collect::<Vec<_>>();
    if model_ids.len() > LIMIT {
        format!("{} and {} more", shown.join(", "), model_ids.len() - LIMIT)
    } else {
        shown.join(", ")
    }
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
    deadline_is_explicit: bool,
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
        deadline_is_explicit: req.deadline_is_explicit,
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
    /// `bearer` (Server/DC) or `basic` (Cloud email+API token). Default bearer.
    #[serde(default)]
    auth_mode: Option<String>,
    /// Account email for Basic auth (not secret).
    #[serde(default)]
    basic_email: Option<String>,
}

fn parse_confluence_auth_mode(
    raw: Option<&str>,
) -> Result<cd_core::config::ConfluenceAuthMode, String> {
    match raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("bearer")
    {
        "bearer" | "Bearer" => Ok(cd_core::config::ConfluenceAuthMode::Bearer),
        "basic" | "Basic" => Ok(cd_core::config::ConfluenceAuthMode::Basic),
        other => Err(format!(
            "invalid Confluence auth_mode `{other}` (expected bearer or basic)"
        )),
    }
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

    let auth_mode = parse_confluence_auth_mode(req.auth_mode.as_deref())?;
    let basic_email = req
        .basic_email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if matches!(auth_mode, cd_core::config::ConfluenceAuthMode::Basic)
        && req.enabled
        && basic_email.is_none()
    {
        return Err(
            "Basic auth requires account email (Settings → Connectors → Confluence).".into(),
        );
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
    cf.auth_mode = auth_mode;
    cf.basic_email = basic_email;

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
    // Honor auth_mode / basic_email from Settings (Bearer Server/DC, Basic Cloud).
    let auth = cfg.auth_from_pat(pat).map_err(|e| e.to_string())?;
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
    // Same auth_mode path as ToolHost / Test connection (not Bearer-only).
    let auth = cfg.auth_from_pat(pat).map_err(|e| e.to_string())?;
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
    /// Reuse the exact host-retained evidence from this chat's prior synthesis timeout.
    #[serde(default)]
    retry_synthesis_only: bool,
    /// Client-created transcript identities used by the trusted host when a
    /// turn terminates before the ordinary agent persistence path starts.
    #[serde(default)]
    client_user_message_id: Option<String>,
    #[serde(default)]
    client_assistant_message_id: Option<String>,
    /// Per-turn opt-in for sensitive, redacted developer payload inspection.
    #[serde(default)]
    developer_activity_detail: bool,
    /// Explicit one-turn context selected by the user. Never synthesized from
    /// Explorer viewport, ambient memory, or other host observations.
    #[serde(default)]
    user_selection: Option<String>,
    /// Multi-model mode for this turn: `"single"` (default) or `"review"`.
    /// Review opts in to the reviewer pipeline; it degrades to single-model
    /// and reports the reason when unavailable.
    #[serde(default)]
    multi_model_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct LogExplorerTurnContextReq {
    corpus_id: String,
    brief: String,
    /// When true, do not apply durable noise exclusions for this turn (#817).
    #[serde(default)]
    noise_lens_suspended: bool,
}

fn validate_log_explorer_turn_context(
    session: &Session,
    window_id: &str,
    request: LogExplorerTurnContextReq,
) -> Result<cd_core::agent::LogExplorerTurnContext, String> {
    if session.linked_corpus_id.as_deref() != Some(request.corpus_id.as_str()) {
        return Err("Log Explorer context does not match this chat session's linked corpus".into());
    }
    let suspended = request.noise_lens_suspended;
    cd_core::agent::LogExplorerTurnContext::new(window_id, request.corpus_id, request.brief)
        .map(|context| context.with_noise_lens_suspended(suspended))
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
    let (is_log_citation, event_corpus_id) = match event {
        cd_core::events::StreamEvent::Citation {
            source_id,
            corpus_id,
            ..
        } if source_id.starts_with("log_template:") || source_id.starts_with("log_event:") => {
            (true, corpus_id.as_deref())
        }
        _ => (false, None),
    };
    if let Some(payload) = dto.payload.as_object_mut() {
        if !is_log_citation {
            payload.remove("corpus_id");
            return dto;
        }
        if payload.get("corpus_id").is_none() {
            if let Some(corpus_id) = event_corpus_id.or(linked_corpus_id) {
                payload.insert(
                    "corpus_id".into(),
                    serde_json::Value::String(corpus_id.to_string()),
                );
            }
        }
    }
    dto
}

/// Add the host-measured turn clock to core's shared human-progress
/// projection. The source `StreamEvent` is still sent separately and remains
/// authoritative; this DTO is presentation metadata only.
fn progress_dto_for_event(
    event: &cd_core::events::StreamEvent,
    turn_started_at: tokio::time::Instant,
) -> Option<EventDto> {
    let elapsed_ms = u64::try_from(turn_started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    let progress = cd_core::events::progress_for_stream_event(event, elapsed_ms)?;
    Some(EventDto {
        kind: "turn_progress".into(),
        payload: serde_json::to_value(progress).ok()?,
    })
}

struct AdmittedAgentTurn<'a> {
    owners: &'a Mutex<HashMap<String, u64>>,
    cancels: &'a Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    session_id: String,
    owner: u64,
    cancel: Arc<std::sync::atomic::AtomicBool>,
}

const CHAT_TURN_CANCEL_PREFIX: &str = "chat_turn:";

fn chat_turn_cancel_key(session_id: &str) -> String {
    format!("{CHAT_TURN_CANCEL_PREFIX}{session_id}")
}

impl Drop for AdmittedAgentTurn<'_> {
    fn drop(&mut self) {
        finish_agent_turn(self.owners, self.cancels, &self.session_id, self.owner);
    }
}

type DeveloperDetailSuppressionMap =
    Mutex<HashMap<String, cd_core::turn_trace::DeveloperDetailCaptureGate>>;

struct DeveloperDetailCaptureRegistration<'a> {
    map: &'a DeveloperDetailSuppressionMap,
    session_id: String,
    gate: cd_core::turn_trace::DeveloperDetailCaptureGate,
}

impl DeveloperDetailCaptureRegistration<'_> {
    fn gate(&self) -> cd_core::turn_trace::DeveloperDetailCaptureGate {
        self.gate.clone()
    }
}

impl Drop for DeveloperDetailCaptureRegistration<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.map.lock() {
            let owns_current_generation = map
                .get(&self.session_id)
                .is_some_and(|current| current.is_same_generation(&self.gate));
            if owns_current_generation {
                map.remove(&self.session_id);
            }
        }
    }
}

/// Install a fresh capture generation for `session_id`, replacing whatever
/// a prior turn left behind, and return its lifecycle registration.
///
/// Fresh on every call is what makes the gate safe to reuse across turns: a
/// trash performed after turn A finished, or a toggle-off during turn A,
/// must never leak forward and wrongly suppress turn B on the same session.
/// Turn B always gets its own enabled gate.
fn install_developer_detail_capture<'a>(
    map: &'a DeveloperDetailSuppressionMap,
    session_id: &str,
) -> DeveloperDetailCaptureRegistration<'a> {
    let gate = cd_core::turn_trace::DeveloperDetailCaptureGate::new();
    if let Ok(mut map) = map.lock() {
        map.insert(session_id.to_string(), gate.clone());
    } else {
        // If the lifecycle map is unavailable, fail closed: there would be
        // no way for a later Off/trash request to reach this turn's gate.
        gate.suppress();
    }
    DeveloperDetailCaptureRegistration {
        map,
        session_id: session_id.to_string(),
        gate,
    }
}

/// Close the CURRENT capture gate for `session_id`, if a turn installed one.
///
/// Never inserts — a session with no in-flight turn has no gate to close, and
/// inserting one here would only grow the map for a session nobody is about
/// to resume. Shared by both triggers that must stop live developer-detail
/// delivery: the session being trashed/deleted, and the operator turning
/// Developer detail off mid-turn.
fn suppress_developer_detail_for_session(map: &DeveloperDetailSuppressionMap, session_id: &str) {
    if let Ok(map) = map.lock() {
        if let Some(gate) = map.get(session_id) {
            gate.suppress();
        }
    }
}

#[cfg(test)]
mod developer_detail_suppression_tests {
    use super::*;

    #[test]
    fn a_fresh_gate_starts_enabled_and_cleans_up_on_drop() {
        let map: DeveloperDetailSuppressionMap = Mutex::new(HashMap::new());
        let registration = install_developer_detail_capture(&map, "s1");
        assert!(registration.gate().is_enabled());
        assert_eq!(map.lock().unwrap().len(), 1);
        drop(registration);
        assert!(map.lock().unwrap().is_empty());
    }

    #[test]
    fn suppressing_a_session_sets_the_flag_a_live_turn_is_holding() {
        let map: DeveloperDetailSuppressionMap = Mutex::new(HashMap::new());
        let registration = install_developer_detail_capture(&map, "s1");
        let gate = registration.gate();
        assert!(gate.is_enabled());
        suppress_developer_detail_for_session(&map, "s1");
        assert!(
            !gate.is_enabled(),
            "the exact gate the in-flight turn is holding must observe the change"
        );
    }

    #[test]
    fn suppressing_a_session_with_no_in_flight_turn_is_a_harmless_no_op() {
        let map: DeveloperDetailSuppressionMap = Mutex::new(HashMap::new());
        // Must not panic, and must not insert an entry for a session with
        // nothing running — inserting would leak one map entry per ever-
        // trashed session for the life of the process.
        suppress_developer_detail_for_session(&map, "no-such-session");
        assert!(map.lock().unwrap().is_empty());
    }

    #[test]
    fn a_new_turn_on_the_same_session_gets_a_fresh_flag_not_the_retired_one() {
        // This is the exact regression the fresh-flag-per-turn design
        // exists to prevent: trash a session mid-turn (suppressing turn A's
        // flag), then start turn B on the SAME session id (as a restore +
        // new message would). Turn B's flag must start unset.
        let map: DeveloperDetailSuppressionMap = Mutex::new(HashMap::new());
        let turn_a = install_developer_detail_capture(&map, "s1");
        let turn_a_gate = turn_a.gate();
        suppress_developer_detail_for_session(&map, "s1");
        assert!(!turn_a_gate.is_enabled());

        let turn_b = install_developer_detail_capture(&map, "s1");
        let turn_b_gate = turn_b.gate();
        assert!(
            turn_b_gate.is_enabled(),
            "a later turn on the same session must not inherit an earlier \
             turn's suppression"
        );
        drop(turn_a);
        assert_eq!(map.lock().unwrap().len(), 1);
        assert!(turn_b_gate.is_enabled());
        drop(turn_b);
        assert!(map.lock().unwrap().is_empty());
    }

    #[test]
    fn suppressing_after_a_new_turn_installed_only_affects_the_current_flag() {
        let map: DeveloperDetailSuppressionMap = Mutex::new(HashMap::new());
        let turn_a = install_developer_detail_capture(&map, "s1");
        let turn_a_gate = turn_a.gate();
        let turn_b = install_developer_detail_capture(&map, "s1");
        let turn_b_gate = turn_b.gate();
        // A trash/suppress call arriving after B has started must hit B's
        // flag (the one the map currently holds), never resurrect A's.
        suppress_developer_detail_for_session(&map, "s1");
        assert!(!turn_b_gate.is_enabled());
        assert!(turn_a_gate.is_enabled());
    }

    #[test]
    fn completed_turns_across_many_sessions_do_not_grow_the_map() {
        let map: DeveloperDetailSuppressionMap = Mutex::new(HashMap::new());
        for index in 0..1_000 {
            let registration = install_developer_detail_capture(&map, &format!("session-{index}"));
            assert_eq!(map.lock().unwrap().len(), 1);
            drop(registration);
        }
        assert!(map.lock().unwrap().is_empty());
    }
}

fn admit_agent_turn<'a>(
    owners: &'a Mutex<HashMap<String, u64>>,
    cancels: &'a Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    next_owner: &std::sync::atomic::AtomicU64,
    session_id: &str,
) -> Result<AdmittedAgentTurn<'a>, ()> {
    let mut owner_map = owners.lock().expect("active turn owners");
    if owner_map.contains_key(session_id) {
        return Err(());
    }
    let owner = next_owner
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        .saturating_add(1);
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    owner_map.insert(session_id.to_string(), owner);
    cancels
        .lock()
        .expect("cancels")
        .insert(chat_turn_cancel_key(session_id), cancel.clone());
    Ok(AdmittedAgentTurn {
        owners,
        cancels,
        session_id: session_id.to_string(),
        owner,
        cancel,
    })
}

fn finish_agent_turn(
    owners: &Mutex<HashMap<String, u64>>,
    cancels: &Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    session_id: &str,
    owner: u64,
) -> bool {
    let mut owners = owners.lock().expect("active turn owners");
    if owners.get(session_id).copied() != Some(owner) {
        return false;
    }
    owners.remove(session_id);
    cancels
        .lock()
        .expect("cancels")
        .remove(&chat_turn_cancel_key(session_id));
    true
}

fn request_agent_turn_cancel(
    cancels: &Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    session_id: &str,
) -> bool {
    let cancels = cancels.lock().expect("cancels");
    let Some(flag) = cancels.get(&chat_turn_cancel_key(session_id)) else {
        return false;
    };
    flag.store(true, std::sync::atomic::Ordering::SeqCst);
    true
}

fn linked_retry_event(
    available: bool,
    session_id: &str,
    corpus_id: &str,
    provider_profile_id: Option<String>,
    model_id: Option<String>,
) -> cd_core::events::StreamEvent {
    cd_core::events::StreamEvent::LinkedSynthesisRetry {
        available,
        session_id: session_id.to_string(),
        corpus_id: corpus_id.to_string(),
        provider_profile_id,
        model_id,
    }
}

fn terminal_message_id(candidate: Option<&str>) -> String {
    static NEXT_HOST_TERMINAL_ID: std::sync::atomic::AtomicU64 =
        std::sync::atomic::AtomicU64::new(0);
    candidate
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "host-terminal-{}-{}",
                chrono_like(),
                NEXT_HOST_TERMINAL_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            )
        })
}

fn persist_host_terminal_turn_at(
    store: &SessionStore,
    session_id: &str,
    user_text: &str,
    client_user_message_id: Option<&str>,
    client_assistant_message_id: Option<&str>,
    events: &[cd_core::events::StreamEvent],
    provider: (Option<&str>, Option<&str>, Option<&str>),
) -> Result<Session, String> {
    let (provider_profile_id, provider_label, model_id) = provider;
    let mut session = store
        .load(session_id)
        .map_err(|error| format!("chat session is unavailable or corrupt: {error}"))?;
    let assistant_id = terminal_message_id(client_assistant_message_id);
    if session
        .messages
        .iter()
        .any(|message| message.id == assistant_id)
    {
        return Ok(session);
    }

    let user_text = user_text.trim();
    if !user_text.is_empty() {
        let user_id = terminal_message_id(client_user_message_id);
        if !session.messages.iter().any(|message| message.id == user_id) {
            session.messages.push(StoredMessage {
                id: user_id,
                role: "user".into(),
                content: user_text.to_string(),
                tools: None,
                citations: None,
                trail: None,
                meta: Some(serde_json::json!({
                    "host_persisted_terminal": true
                })),
            });
        }
    }

    let errors = events
        .iter()
        .filter_map(|event| match event {
            cd_core::events::StreamEvent::Error { code, message } => {
                Some((code.as_str(), message.as_str()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let reason = events.iter().find_map(|event| match event {
        cd_core::events::StreamEvent::TurnCompleted { reason } => Some(reason.as_str()),
        _ => None,
    });
    let streamed_text = events
        .iter()
        .filter_map(|event| match event {
            cd_core::events::StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    let terminal_text = if errors.is_empty() {
        format!(
            "**Stopped:** This turn ended before provider work completed{}.",
            reason
                .map(|reason| format!(" ({reason})"))
                .unwrap_or_default()
        )
    } else {
        errors
            .iter()
            .map(|(_, message)| format!("**Error:** {message}"))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    let content = if streamed_text.trim().is_empty() {
        terminal_text
    } else {
        format!("{streamed_text}\n\n{terminal_text}")
    };
    let mut tools = Vec::<serde_json::Value>::new();
    for event in events {
        let cd_core::events::StreamEvent::Tool {
            id,
            name,
            summary,
            detail,
            ok,
            ..
        } = event
        else {
            continue;
        };
        if let Some(existing) = tools
            .iter_mut()
            .find(|tool| tool["id"].as_str() == Some(id.as_str()))
        {
            existing["name"] = serde_json::Value::String(name.clone());
            existing["summary"] = serde_json::Value::String(summary.clone());
            existing["detail"] = serde_json::json!(detail);
            existing["ok"] = serde_json::json!(ok);
        } else {
            tools.push(serde_json::json!({
                "id": id,
                "name": name,
                "summary": summary,
                "detail": detail,
                "ok": ok
            }));
        }
    }
    let linked_corpus_id = session.linked_corpus_id.clone();
    let mut citations = Vec::<serde_json::Value>::new();
    for event in events {
        let cd_core::events::StreamEvent::Citation {
            source_id,
            label,
            locator,
            corpus_id,
        } = event
        else {
            continue;
        };
        let is_log_citation =
            source_id.starts_with("log_template:") || source_id.starts_with("log_event:");
        let resolved_corpus = is_log_citation
            .then(|| corpus_id.as_deref().or(linked_corpus_id.as_deref()))
            .flatten();
        if citations.iter().any(|citation| {
            citation["id"].as_str() == Some(source_id.as_str())
                && citation.get("corpusId").and_then(|value| value.as_str()) == resolved_corpus
        }) {
            continue;
        }
        let mut citation = serde_json::json!({
            "id": source_id,
            "label": label,
            "title": locator
        });
        if let Some(corpus_id) = resolved_corpus {
            citation["corpusId"] = serde_json::Value::String(corpus_id.to_string());
        }
        citations.push(citation);
    }
    let trail = events
        .iter()
        .filter_map(|event| match event {
            cd_core::events::StreamEvent::SearchTrail { steps } => Some(steps.as_slice()),
            _ => None,
        })
        .flatten()
        .fold(Vec::<String>::new(), |mut steps, step| {
            if !steps.contains(step) {
                steps.push(step.clone());
            }
            steps
        });
    let error_codes = errors.iter().map(|(code, _)| *code).collect::<Vec<_>>();
    if let Some(model_id) = model_id {
        session.chat_model = Some(model_id.to_string());
    }
    if let Some(provider_profile_id) = provider_profile_id {
        session.provider_profile_id = Some(provider_profile_id.to_string());
    }
    session.messages.push(StoredMessage {
        id: assistant_id.clone(),
        role: "assistant".into(),
        content,
        tools: (!tools.is_empty()).then_some(serde_json::Value::Array(tools)),
        citations: (!citations.is_empty()).then_some(serde_json::Value::Array(citations)),
        trail: (!trail.is_empty()).then_some(trail),
        meta: Some(serde_json::json!({
            "model": model_id,
            "provider_label": provider_label,
            "provider_id": provider_profile_id,
            "linked_corpus_id": linked_corpus_id,
            "host_confirmed": true,
            "host_persisted_terminal": true,
            "terminal": {
                "reason": reason,
                "error_codes": error_codes
            }
        })),
    });
    session.last_read_message_id = Some(assistant_id);
    session.maybe_auto_title_from_first_user();
    session.touch();
    store.save(&session).map_err(|error| error.to_string())?;
    Ok(session)
}

fn linked_provider_loop_terminal_failure(events: &[cd_core::events::StreamEvent]) -> bool {
    let completed = events
        .iter()
        .any(|event| matches!(event, cd_core::events::StreamEvent::TurnCompleted { .. }));
    let cancelled = events.iter().any(|event| {
        matches!(
            event,
            cd_core::events::StreamEvent::TurnCompleted { reason } if reason == "cancel"
        )
    });
    let terminal_error = events.iter().any(|event| {
        matches!(
            event,
            cd_core::events::StreamEvent::Error { code, .. }
                if !matches!(
                    code.as_str(),
                    "context_budget_learned" | "context_compacted" | "tools_unsupported"
                )
        )
    });
    completed && (cancelled || terminal_error)
}

#[allow(clippy::too_many_arguments)] // explicit provenance is the persistence boundary
fn persist_linked_provider_loop_terminal_at(
    store: &SessionStore,
    session_id: &str,
    user_text: &str,
    client_user_message_id: Option<&str>,
    client_assistant_message_id: Option<&str>,
    events: &[cd_core::events::StreamEvent],
    provider: (Option<&str>, Option<&str>, Option<&str>),
) -> Result<bool, String> {
    if !linked_provider_loop_terminal_failure(events) {
        return Ok(false);
    }
    let session = store
        .load(session_id)
        .map_err(|error| format!("chat session is unavailable or corrupt: {error}"))?;
    if session.linked_corpus_id.is_none() {
        return Ok(false);
    }
    persist_host_terminal_turn_at(
        store,
        session_id,
        user_text,
        client_user_message_id,
        client_assistant_message_id,
        events,
        provider,
    )?;
    Ok(true)
}

fn persist_host_terminal_turn(
    state: &AppState,
    req: &AgentTurnReq,
    events: &[cd_core::events::StreamEvent],
    provider_profile_id: Option<&str>,
    provider_label: Option<&str>,
    model_id: Option<&str>,
) -> Result<Session, String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    let store = session_store(state)?;
    persist_host_terminal_turn_at(
        &store,
        &req.session_id,
        &req.text,
        req.client_user_message_id.as_deref(),
        req.client_assistant_message_id.as_deref(),
        events,
        (provider_profile_id, provider_label, model_id),
    )
}

fn persist_and_emit_host_terminal(
    state: &AppState,
    req: &AgentTurnReq,
    events: &[cd_core::events::StreamEvent],
    provider_profile_id: Option<&str>,
    provider_label: Option<&str>,
    model_id: Option<&str>,
    on_event: &tauri::ipc::Channel<EventDto>,
) -> Result<(), String> {
    persist_host_terminal_turn(
        state,
        req,
        events,
        provider_profile_id,
        provider_label,
        model_id,
    )?;
    for event in events {
        let _ = on_event.send(cd_core::research::event_to_dto(event));
    }
    Ok(())
}

fn provider_profile_for_turn(
    config: &AppConfig,
    explicit_profile_id: Option<&str>,
) -> Result<ProviderProfile, String> {
    cd_workflow::provider::resolve_provider_profile(config, explicit_profile_id)
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
    let mut applied_skill_ids = Vec::new();
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
                    applied_skill_ids.push(sk.id.clone());
                    let ctx = cd_core::skills::skill_context(sk);
                    user_text = if rest.is_empty() {
                        format!("{ctx}\n\nApply this skill to the workspace context.")
                    } else {
                        format!("{ctx}\n\nUser question: {rest}")
                    };
                }
            }
        } else if let Some(pinned) = req
            .pinned_skill_id
            .as_deref()
            .and_then(|id| cd_core::skills::find_skill(&skills, id))
            .filter(|skill| !skill.disabled)
        {
            // `apply_pinned_skill_to_user_text` above used this exact resolved
            // host object. Record the authoritative id, never wrapper text.
            applied_skill_ids.push(pinned.id.clone());
        }
    }
    let admitted_turn = match admit_agent_turn(
        &state.active_turn_owners,
        &state.cancels,
        &state.next_turn_owner,
        &req.session_id,
    ) {
        Ok(admitted) => admitted,
        Err(()) => {
            for event in [
                cd_core::events::StreamEvent::TurnStarted {
                    session_id: req.session_id.clone(),
                    model: req.chat_model.clone(),
                },
                cd_core::events::StreamEvent::Error {
                    code: "turn_in_progress".into(),
                    message: "This chat already has an active turn in another window. Stop or \
                              wait for that turn before sending again."
                        .into(),
                },
                cd_core::events::StreamEvent::TurnCompleted {
                    reason: "turn_in_progress".into(),
                },
            ] {
                let _ = on_event.send(cd_core::research::event_to_dto(&event));
            }
            return Ok(());
        }
    };
    // Authoritative turn identity is host-generated and never derived from a
    // renderer transcript id. Client ids remain presentation correlation
    // labels only.
    let turn_id = format!("{}::{}", req.session_id, uuid::Uuid::new_v4());
    // Register the sensitive-capture generation immediately after turn
    // admission, before any fallible preflight or await. Its Drop covers
    // every completion/error/cancel path, and an Off/trash command can reach
    // the gate throughout the admitted turn's entire lifetime.
    let developer_detail_registration = req.developer_activity_detail.then(|| {
        install_developer_detail_capture(&state.developer_activity_suppressed, &req.session_id)
    });
    let developer_detail_gate = developer_detail_registration
        .as_ref()
        .map(DeveloperDetailCaptureRegistration::gate)
        .unwrap_or_default();
    let explicit_profile_id = req.provider_profile_id.as_deref();
    let profile = match provider_profile_for_turn(&cfg, explicit_profile_id) {
        Ok(profile) => profile,
        Err(profile_id) => {
            let events = vec![
                cd_core::events::StreamEvent::TurnStarted {
                    session_id: req.session_id.clone(),
                    model: req.chat_model.clone(),
                },
                cd_core::events::StreamEvent::Error {
                    code: "provider_profile_unavailable".into(),
                    message: "The provider profile selected for this chat no longer exists. \
                              ContextDesk did not fall back to another provider. Choose an \
                              available profile and retry."
                        .into(),
                },
                cd_core::events::StreamEvent::TurnCompleted {
                    reason: "provider_profile_unavailable".into(),
                },
            ];
            persist_and_emit_host_terminal(
                &state,
                &req,
                &events,
                Some(&profile_id),
                None,
                req.chat_model.as_deref(),
                &on_event,
            )?;
            return Ok(());
        }
    };
    // The shared workflow resolver owns the exact model override, tools
    // capability, keychain lookup, and deadline sequence used by the CLI.
    // Tauri keeps its host-shaped missing-profile terminal above.
    // Scope provider credentials to this admitted turn and share the cache
    // with optional reviewer setup. Host connector credentials remain on
    // their existing independent initialization path.
    let provider_credentials =
        cd_workflow::provider::TurnProviderCredentialCache::new(&state.secrets);
    let resolved = cd_workflow::provider::resolve_turn_inputs_from_profile_with_credential_cache(
        &provider_credentials,
        &cfg,
        profile,
        req.chat_model.as_deref(),
    );
    let profile = resolved.profile.clone();
    let cancel = admitted_turn.cancel.clone();
    let turn_started_at = tokio::time::Instant::now();
    let deadline_plan = resolved.deadline_plan;

    // Resolve the multi-model reviewer runtime for this turn (opt-in via
    // req.multi_model_mode). The desktop host resolves the reviewer's measured
    // qualification from its own store; a name is never a qualification.
    let requested_review_mode = match req.multi_model_mode.as_deref() {
        Some("review") => cd_core::multi_model::MultiModelMode::Review,
        Some("single") => cd_core::multi_model::MultiModelMode::Single,
        // No per-turn override → the configured default (a Settings toggle).
        _ => cfg.multi_model.mode,
    };
    let reviewer_qualified = cfg.multi_model.reviewer.as_ref().and_then(|rev| {
        let prof = cfg
            .providers
            .profiles
            .iter()
            .find(|p| p.id == rev.profile_id)?;
        let model = rev.model.as_deref().unwrap_or(&prof.chat_model);
        let key = cd_core::capability_qualification::QualificationKey::with_provider_kind(
            &prof.id,
            &prof.base_url,
            model,
            prof.kind,
        );
        let store = state.qualification_store.lock().ok()?;
        let report = store.get(&key)?;
        use cd_core::capability_qualification::{
            capability_contract_verdict, CapabilityContract, ContractVerdict,
        };
        Some(
            matches!(
                capability_contract_verdict(Some(report), CapabilityContract::JsonProposal),
                ContractVerdict::Qualified
            ),
        )
    });
    let review_context_budget = cfg
        .model_context_budgets
        .resolve(Some(resolved.profile.chat_model.as_str()));
    let multi_model_review = cd_workflow::multi_model::resolve_reviewer_runtime(
        &cfg,
        &provider_credentials,
        // Review is only meaningful for a corpus-linked investigation turn.
        if req.log_explorer_context.is_some() {
            requested_review_mode
        } else {
            cd_core::multi_model::MultiModelMode::Single
        },
        &resolved,
        reviewer_qualified,
        review_context_budget,
    )
    .await;

    // Resolve the linked corpus only from the durable session. Explorer may
    // contribute a bounded viewport brief, but neither the model nor an
    // ordinary main-chat turn request chooses or broadens corpus scope.
    let store = session_store(&state)?;
    let stored_session = load_session_for_turn(&store, &req.session_id)?;
    let investigation_answer_reservation = reserve_investigation_answer_message(
        stored_session.as_ref(),
        &req.session_id,
        &turn_id,
        req.client_assistant_message_id.as_deref(),
    );
    let log_explorer_context = match linked_log_turn_context(
        stored_session.as_ref(),
        window.label(),
        req.log_explorer_context.clone(),
    ) {
        Ok(context) => context,
        Err(error) if req.log_explorer_context.is_some() => {
            let events = vec![
                cd_core::events::StreamEvent::TurnStarted {
                    session_id: req.session_id.clone(),
                    model: Some(profile.chat_model.clone()),
                },
                cd_core::events::StreamEvent::Error {
                    code: "linked_context_rejected".into(),
                    message: format!(
                        "The linked corpus context was rejected before provider contact: {error}"
                    ),
                },
                cd_core::events::StreamEvent::TurnCompleted {
                    reason: "linked_context_rejected".into(),
                },
            ];
            persist_and_emit_host_terminal(
                &state,
                &req,
                &events,
                Some(&profile.id),
                Some(&profile.label),
                Some(&profile.chat_model),
                &on_event,
            )?;
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    // Fast triage is meaningful only for an accepted linked-log turn. Resolve
    // it after linked-context validation so an ordinary, rejected, or forced
    // local turn never builds an unused fallback backend.
    let fast_triage = if cd_workflow::fast_triage::should_resolve_fast_triage(
        log_explorer_context.is_some(),
        req.force_local,
        cancel.load(std::sync::atomic::Ordering::Relaxed),
    ) {
        cd_workflow::fast_triage::resolve_fast_triage_runtime(
            &cfg,
            &provider_credentials,
            &resolved,
        )
        .await
    } else {
        cd_workflow::fast_triage::ResolvedFastTriage {
            runtime: None,
            entry_degradation: None,
        }
    };
    let linked_synthesis_retry = if req.retry_synthesis_only {
        state
            .linked_synthesis_checkpoints
            .lock()
            .expect("linked synthesis checkpoints")
            .get(&req.session_id)
    } else {
        state
            .linked_synthesis_checkpoints
            .lock()
            .expect("linked synthesis checkpoints")
            .remove(&req.session_id);
        None
    };
    if req.retry_synthesis_only && linked_synthesis_retry.is_none() {
        let events = vec![
            cd_core::events::StreamEvent::TurnStarted {
                session_id: req.session_id.clone(),
                model: Some(profile.chat_model.clone()),
            },
            cd_core::events::StreamEvent::Error {
                code: "linked_synthesis_retry_stale".into(),
                message: "No preserved evidence is available for this chat. Run a new linked \
                          investigation before retrying synthesis."
                    .into(),
            },
            cd_core::events::StreamEvent::TurnCompleted {
                reason: "linked_synthesis_retry_stale".into(),
            },
        ];
        persist_and_emit_host_terminal(
            &state,
            &req,
            &events,
            Some(&profile.id),
            Some(&profile.label),
            Some(&profile.chat_model),
            &on_event,
        )?;
        return Ok(());
    }
    if let (Some(context), Some(checkpoint)) = (
        log_explorer_context.as_ref(),
        linked_synthesis_retry.as_ref(),
    ) {
        if !checkpoint.matches(
            &req.session_id,
            &context.corpus_id,
            Some(profile.id.as_str()),
            Some(profile.chat_model.as_str()),
            context.noise_lens_suspended,
        ) {
            state
                .linked_synthesis_checkpoints
                .lock()
                .expect("linked synthesis checkpoints")
                .remove(&req.session_id);
            let events = vec![
                cd_core::events::StreamEvent::TurnStarted {
                    session_id: req.session_id.clone(),
                    model: Some(profile.chat_model.clone()),
                },
                cd_core::events::StreamEvent::Error {
                    code: "linked_synthesis_retry_stale".into(),
                    message:
                        "The preserved evidence belongs to a different chat, corpus, provider \
                              profile, model, or noise-lens mode. Run a new linked investigation \
                              instead."
                            .into(),
                },
                cd_core::events::StreamEvent::TurnCompleted {
                    reason: "linked_synthesis_retry_stale".into(),
                },
            ];
            persist_and_emit_host_terminal(
                &state,
                &req,
                &events,
                Some(&profile.id),
                Some(&profile.label),
                Some(&profile.chat_model),
                &on_event,
            )?;
            return Ok(());
        }
    }

    // Linked log turns never join optional workspace/memory initialization.
    // They take an already-published full host when immediately available and
    // otherwise use an independent turn-local read-only log host.
    let mut turn_prelude_emitted = false;
    let (mut host, using_fallback_host, borrowed_host_generation, validated_log_corpus) =
        if let Some(context) = log_explorer_context.as_ref() {
            let cache = match log_cache_dir(&state) {
                Ok(cache) => cache,
                Err(error) => {
                    tracing::warn!(error = %error, "linked log cache is unavailable");
                    let events = linked_log_host_terminal_events().to_vec();
                    persist_and_emit_host_terminal(
                        &state,
                        &req,
                        &events,
                        Some(&profile.id),
                        Some(&profile.label),
                        Some(&profile.chat_model),
                        &on_event,
                    )?;
                    return Ok(());
                }
            };
            let corpus_id = context.corpus_id.clone();
            let log_corpus_handles = Arc::clone(&state.log_corpus_handles);
            let capability_profile =
                (!req.force_local && linked_synthesis_retry.is_none()).then_some(profile.clone());
            let capability_session_id = req.session_id.clone();
            let app_for_host = window.app_handle().clone();
            let fallback_context = context.clone();
            match prepare_linked_turn_with(
                turn_started_at,
                deadline_plan,
                cancel.as_ref(),
                move || log_corpus_handles.open(&cache, &corpus_id),
                move || {
                    capability_profile.as_ref().and_then(|profile| {
                        cd_core::research::linked_tools_unavailable_events(
                            profile,
                            &capability_session_id,
                        )
                    })
                },
                move |validated_corpus| {
                    let state = app_for_host.state::<AppState>();
                    let (host, using_fallback, borrowed_generation) =
                        take_ready_linked_host(&state.host, &state.host_generation, || {
                            build_linked_log_fallback_host(&state, &fallback_context)
                        })?;
                    Ok((
                        host,
                        using_fallback,
                        borrowed_generation,
                        Some(validated_corpus),
                    ))
                },
            )
            .await
            {
                Ok(LinkedTurnPreparation::Ready((
                    host,
                    using_fallback,
                    borrowed_generation,
                    validated_corpus,
                ))) => {
                    if using_fallback {
                        let notice = linked_log_fallback_notice();
                        let _ = on_event.send(cd_core::research::event_to_dto(&notice));
                    }
                    (host, using_fallback, borrowed_generation, validated_corpus)
                }
                Ok(LinkedTurnPreparation::Terminal(events)) => {
                    persist_and_emit_host_terminal(
                        &state,
                        &req,
                        &events,
                        Some(&profile.id),
                        Some(&profile.label),
                        Some(&profile.chat_model),
                        &on_event,
                    )?;
                    return Ok(());
                }
                Err(failure) => {
                    let events = linked_setup_failure_events(&failure);
                    persist_and_emit_host_terminal(
                        &state,
                        &req,
                        &events,
                        Some(&profile.id),
                        Some(&profile.label),
                        Some(&profile.chat_model),
                        &on_event,
                    )?;
                    return Ok(());
                }
            }
        } else {
            for event in [
                cd_core::events::StreamEvent::TurnStarted {
                    session_id: req.session_id.clone(),
                    model: Some(profile.chat_model.clone()),
                },
                cd_core::events::StreamEvent::TurnPhase {
                    phase: cd_core::router::AgentPhase::ChoosingEvidence,
                },
            ] {
                let _ = on_event.send(cd_core::research::event_to_dto(&event));
                if let Some(progress) = progress_dto_for_event(&event, turn_started_at) {
                    let _ = on_event.send(progress);
                }
            }
            turn_prelude_emitted = true;
            let app = window.app_handle().clone();
            if let Err(failure) = wait_for_host_readiness_for_turn(
                AGENT_HOST_READY_TIMEOUT,
                turn_started_at,
                deadline_plan,
                cancel.as_ref(),
                move || {
                    let state = app.state::<AppState>();
                    ensure_host(&state)
                },
            )
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
                None,
            )
        };

    let mut history = {
        let mut histories = state.histories.lock().expect("hist");
        histories.entry(req.session_id.clone()).or_default().clone()
    };
    // One capture object timestamps both provider completions and the live
    // host stream against the real turn origin. This preserves the causal
    // model → tool → model sequence instead of concatenating two lists later.
    let activity_settings = cfg.activity.clone();
    let channel = on_event.clone();
    let developer_observer = if req.developer_activity_detail {
        req.client_assistant_message_id.as_ref().map(|message_id| {
            let developer_channel = channel.clone();
            let session_id = req.session_id.clone();
            let message_id = message_id.clone();
            let capture_gate = developer_detail_gate.clone();
            std::sync::Arc::new(move |event: cd_core::turn_trace::DeveloperDetailEvent| {
                // Checked per event, live: a session trashed/deleted mid-turn
                // or a Developer-detail toggle-off must stop delivery of
                // further sensitive detail immediately, not merely at the
                // next turn.
                if !capture_gate.is_enabled() {
                    return;
                }
                let _ = developer_channel.send(EventDto {
                    kind: "developer_activity".to_string(),
                    payload: serde_json::json!({
                        "session_id": session_id,
                        "message_id": message_id,
                        "event": event,
                    }),
                });
            })
                as std::sync::Arc<dyn Fn(cd_core::turn_trace::DeveloperDetailEvent) + Send + Sync>
        })
    } else {
        None
    };
    let activity_sink: Option<std::sync::Arc<cd_core::turn_trace::RecordingTurnTrace>> =
        (activity_settings.enabled || developer_observer.is_some()).then(|| {
            std::sync::Arc::new(match developer_observer {
                Some(observer) => {
                    cd_core::turn_trace::RecordingTurnTrace::with_developer_detail_gate(
                        turn_started_at.into_std(),
                        observer,
                        developer_detail_gate.clone(),
                    )
                }
                None => cd_core::turn_trace::RecordingTurnTrace::with_started_at(
                    turn_started_at.into_std(),
                ),
            })
        });
    let activity_tool_kinds = host.activity_tool_kinds();
    let linked_citation_corpus = log_explorer_context
        .as_ref()
        .map(|context| context.corpus_id.clone());
    let mut sink = |ev: cd_core::events::StreamEvent| {
        if let Some(activity_sink) = activity_sink.as_ref() {
            activity_sink.record_host_event(&ev, &activity_tool_kinds);
        }
        let dto = event_to_dto_with_linked_corpus(&ev, linked_citation_corpus.as_deref());
        let _ = channel.send(dto);
        if let Some(progress) = progress_dto_for_event(&ev, turn_started_at) {
            let _ = channel.send(progress);
        }
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
        // Host-selected active Investigation for propose_finding (#646).
        if let Ok(store) = investigation_store(&state) {
            if let Ok(Some(summary)) = active_investigation_for_corpus(&store, &context.corpus_id) {
                host.set_active_investigation_id(Some(summary.id));
            } else {
                host.set_active_investigation_id(None);
            }
        }
        // Host-authored Model provenance for propose_finding (never from tool JSON).
        host.set_propose_model_context(
            Some(profile.id.clone()),
            Some(profile.chat_model.clone()),
            Some(req.session_id.clone()),
        );
        if let Some(corpus) = validated_log_corpus {
            if let Err(error) = host.seed_log_corpus_handle(&context.corpus_id, corpus) {
                tracing::warn!(error = %error, "linked corpus preflight handoff failed");
                host.set_log_corpus_scope(previous_log_scope.clone());
                host.set_active_log_corpus(previous_log_corpus.clone());
                if !using_fallback_host {
                    let _ = restore_host_if_generation_matches(
                        &state.host,
                        &state.host_generation,
                        borrowed_host_generation.expect("shared host generation"),
                        host,
                    );
                }
                let events = linked_log_host_terminal_events().to_vec();
                persist_and_emit_host_terminal(
                    &state,
                    &req,
                    &events,
                    Some(&profile.id),
                    Some(&profile.label),
                    Some(&profile.chat_model),
                    &on_event,
                )?;
                return Ok(());
            }
        }
        let pin_result = if context.noise_lens_suspended {
            host.pin_log_suppression_lens_suspended(&context.corpus_id)
        } else {
            host.pin_log_suppression_lens(&context.corpus_id)
        };
        if let Err(error) = pin_result {
            tracing::warn!(error = %error, "linked suppression preflight failed");
            host.set_log_corpus_scope(previous_log_scope.clone());
            host.set_active_log_corpus(previous_log_corpus.clone());
            if !using_fallback_host {
                let _ = restore_host_if_generation_matches(
                    &state.host,
                    &state.host_generation,
                    borrowed_host_generation.expect("shared host generation"),
                    host,
                );
            }
            let events = vec![
                cd_core::events::StreamEvent::Error {
                    code: "linked_log_suppression_unavailable".into(),
                    message: "The linked corpus noise policy failed validation. Review the \
                              visible corpus diagnostics before retrying; no log tool ran."
                        .into(),
                },
                cd_core::events::StreamEvent::TurnCompleted {
                    reason: "linked_log_suppression_unavailable".into(),
                },
            ];
            persist_and_emit_host_terminal(
                &state,
                &req,
                &events,
                Some(&profile.id),
                Some(&profile.label),
                Some(&profile.chat_model),
                &on_event,
            )?;
            return Ok(());
        }
    } else {
        host.set_log_corpus_scope(None);
        host.set_active_log_corpus(None);
    }
    let linked_snapshot_revision = log_explorer_context
        .as_ref()
        .and_then(|context| host.linked_log_snapshot_revision(&context.corpus_id).ok());
    let mut next_synthesis_checkpoint = linked_synthesis_retry.clone();
    // Activity capture seam. `TracingChatBackend` wraps the same backend and
    // forwards every call unchanged, so this cannot alter execution, tool
    // selection, context composition, or which network requests are made —
    // the sink only observes what was already assembled. With the inspector
    // disabled the sink is `None` and the turn takes byte-identical
    // arguments to before, which is what the on/off equivalence test pins.
    let trace_sink: Option<std::sync::Arc<dyn cd_core::turn_trace::TurnTraceSink>> = activity_sink
        .clone()
        .map(|sink| sink as std::sync::Arc<dyn cd_core::turn_trace::TurnTraceSink>);
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
        // An entry-time reviewer degradation is reported once, before the turn,
        // so the desktop knows review was requested but ran single-model and
        // why. Mid-pipeline degradations are reported by the seam.
        if let Some(reason) = multi_model_review.entry_degradation {
            sink(cd_workflow::multi_model::entry_degradation_event(reason));
        }
        // Preserve the disabled-by-default path. Enabled-route preparation
        // failures are host-authored metadata; route selection still remains
        // evidence-driven inside `cd-core`.
        if cfg.fast_triage.enabled {
            if let Some(reason) = fast_triage.entry_degradation {
                sink(cd_workflow::fast_triage::entry_degradation_event(reason));
            }
        }
        cd_workflow::turn::run_turn(
            &mut host,
            &resolved,
            &user_text,
            &mut history,
            &req.session_id,
            cd_workflow::turn::TurnExecutionOptions {
                turn_id: Some(turn_id.clone()),
                context: log_explorer_context,
                cancel: Some(cancel.clone()),
                dry_run: false,
                trace_sink,
                telemetry_recorder: None,
                telemetry_sequence: None,
                suppress_provider_telemetry_event: false,
                linked_synthesis_retry,
                turn_started_at: Some(turn_started_at),
                turn_prelude_emitted,
                applied_skill_ids: &applied_skill_ids,
                user_selection: req.user_selection.as_deref(),
                multi_model: multi_model_review.runtime.clone(),
                fast_triage: fast_triage.runtime.clone(),
            },
            Some(&mut sink),
            Some(&mut next_synthesis_checkpoint),
        )
        .await
        .map_err(|e| e.to_string())
    };
    let activity_settled = record_turn_activity(
        &state,
        &req,
        activity_settings,
        activity_sink.as_deref(),
        linked_citation_corpus.as_deref(),
        &result,
        turn_started_at,
    );
    // Tell the frontend the settled record is now readable via
    // `get_turn_activity` / `get_developer_turn_activity`, on the real
    // production emit path — not the completePermission-only path this used
    // to rely on. `ChatPane` listens for this exact event to replace its
    // cached placeholder ("not recorded by host" / stale-pending) without a
    // remount (#developer-activity settle).
    if activity_settled {
        if let Some(message_id) = req.client_assistant_message_id.as_deref() {
            let _ = on_event.send(EventDto {
                kind: "activity_settled".to_string(),
                payload: serde_json::json!({
                    "session_id": req.session_id,
                    "message_id": message_id,
                }),
            });
        }
    }
    let linked_terminal_persistence = match (&linked_citation_corpus, &result) {
        (Some(_), Ok(events)) => {
            let _mutation = state
                .chat_session_mutation
                .lock()
                .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
            let store = session_store(&state)?;
            persist_linked_provider_loop_terminal_at(
                &store,
                &req.session_id,
                &req.text,
                req.client_user_message_id.as_deref(),
                req.client_assistant_message_id.as_deref(),
                events,
                (
                    Some(&profile.id),
                    Some(&profile.label),
                    Some(&profile.chat_model),
                ),
            )
        }
        _ => Ok(false),
    };
    // The envelope is durable only through this typed host path. A later
    // renderer autosave is sanitized to retain this exact value (or none), so
    // displayed JSON can never become evidence authority on a follow-up.
    if let Ok(events) = &result {
        let _mutation = state
            .chat_session_mutation
            .lock()
            .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
        let store = session_store(&state)?;
        persist_investigation_answer_at(
            &store,
            investigation_answer_reservation.as_ref(),
            linked_snapshot_revision,
            events,
        )?;
    }
    let retry_available = {
        let mut checkpoints = state
            .linked_synthesis_checkpoints
            .lock()
            .expect("linked synthesis checkpoints");
        if let Some(checkpoint) = next_synthesis_checkpoint {
            checkpoints.insert(req.session_id.clone(), checkpoint)
        } else {
            checkpoints.remove(&req.session_id);
            false
        }
    };
    if let Some(corpus_id) = linked_citation_corpus.as_deref() {
        sink(linked_retry_event(
            retry_available,
            &req.session_id,
            corpus_id,
            Some(profile.id.clone()),
            Some(profile.chat_model.clone()),
        ));
    }
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
        let mut histories = state.histories.lock().expect("hist");
        histories.insert(req.session_id.clone(), history);
    }
    linked_terminal_persistence?;
    result.map(|_| ())
}

/// Signal cooperative cancel for an in-flight turn (#109).
#[tauri::command]
fn cancel_turn(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    request_agent_turn_cancel(&state.cancels, &session_id);
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

/// Key reserved for an answer envelope which crossed the typed host event
/// boundary. The webview can read this ordinary session metadata, but a
/// webview save never gets to create, replace, or revalidate it.
const INVESTIGATION_ANSWER_META_KEY: &str = cd_workflow::chat::INVESTIGATION_ANSWER_META_KEY;

fn preserve_host_investigation_answer_metadata(session: &mut Session, durable: Option<&Session>) {
    let durable_by_id: HashMap<&str, &StoredMessage> = durable
        .map(|saved| {
            saved
                .messages
                .iter()
                .map(|message| (message.id.as_str(), message))
                .collect()
        })
        .unwrap_or_default();
    let incoming_id_counts =
        session
            .messages
            .iter()
            .fold(HashMap::<String, usize>::new(), |mut counts, message| {
                *counts.entry(message.id.clone()).or_default() += 1;
                counts
            });
    for message in &mut session.messages {
        let retained = if message.role == "assistant"
            && incoming_id_counts.get(message.id.as_str()) == Some(&1)
        {
            durable_by_id
                .get(message.id.as_str())
                .filter(|saved| saved.role == "assistant")
                .and_then(|saved| saved.meta.as_ref())
                .and_then(|meta| meta.get(INVESTIGATION_ANSWER_META_KEY))
                .cloned()
        } else {
            None
        };
        if let Some(meta) = message
            .meta
            .as_mut()
            .and_then(serde_json::Value::as_object_mut)
        {
            meta.remove(INVESTIGATION_ANSWER_META_KEY);
            if let Some(envelope) = retained {
                meta.insert(INVESTIGATION_ANSWER_META_KEY.into(), envelope);
            }
        } else if let Some(envelope) = retained {
            message.meta = Some(serde_json::json!({ INVESTIGATION_ANSWER_META_KEY: envelope }));
        }
    }
}

fn clear_host_investigation_answer_metadata(session: &mut Session) {
    for message in &mut session.messages {
        if let Some(meta) = message
            .meta
            .as_mut()
            .and_then(serde_json::Value::as_object_mut)
        {
            meta.remove(INVESTIGATION_ANSWER_META_KEY);
        }
    }
}

/// Process-local proof that one presentation row id was unused when this
/// host-admitted turn began. The renderer chooses the correlation label, but
/// only the host creates this ownership record and the authoritative turn id.
#[derive(Debug)]
struct InvestigationAnswerMessageReservation {
    session_id: String,
    turn_id: String,
    assistant_message_id: String,
}

fn reserve_investigation_answer_message(
    session: Option<&Session>,
    session_id: &str,
    turn_id: &str,
    assistant_message_id: Option<&str>,
) -> Option<InvestigationAnswerMessageReservation> {
    let raw_assistant_message_id = assistant_message_id?;
    let assistant_message_id = raw_assistant_message_id.trim();
    if assistant_message_id.is_empty()
        || assistant_message_id.len() > 128
        || assistant_message_id != raw_assistant_message_id
    {
        return None;
    }
    if session.is_some_and(|session| {
        session.id != session_id
            || session
                .messages
                .iter()
                .any(|message| message.id == assistant_message_id)
    }) {
        return None;
    }
    Some(InvestigationAnswerMessageReservation {
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        assistant_message_id: assistant_message_id.to_string(),
    })
}

/// Store a typed investigation envelope only after the host itself received
/// it from core. There is intentionally no IPC command accepting envelope
/// JSON, and no transcript-to-envelope parser.
fn persist_investigation_answer_at(
    store: &SessionStore,
    reservation: Option<&InvestigationAnswerMessageReservation>,
    expected_snapshot_revision: Option<cd_core::investigation_answer::LogSnapshotRevisionV1>,
    events: &[cd_core::events::StreamEvent],
) -> Result<bool, String> {
    let Some(expected_snapshot_revision) = expected_snapshot_revision else {
        return Ok(false);
    };
    let Some(reservation) = reservation else {
        return Ok(false);
    };
    let mut session = store
        .load(&reservation.session_id)
        .map_err(|error| error.to_string())?;
    let Some(linked_corpus_id) = session.linked_corpus_id.as_deref() else {
        return Ok(false);
    };
    let Some(envelope) = events.iter().rev().find_map(|event| match event {
        cd_core::events::StreamEvent::InvestigationAnswer { envelope }
            if envelope.binding.session_id == reservation.session_id
                && envelope.binding.turn_id == reservation.turn_id
                && envelope.binding.corpus_id == linked_corpus_id
                && envelope.binding.revision == expected_snapshot_revision =>
        {
            Some(envelope)
        }
        _ => None,
    }) else {
        return Ok(false);
    };
    let matching_rows = session
        .messages
        .iter()
        .filter(|message| message.id == reservation.assistant_message_id)
        .count();
    if matching_rows > 1
        || session.messages.iter().any(|message| {
            message.id == reservation.assistant_message_id && message.role != "assistant"
        })
    {
        return Ok(false);
    }
    if matching_rows == 0 {
        // Renderer persistence may race or disappear. Keep a host-owned,
        // deliberately text-free row so later renderer presentation can
        // merge into it without ever supplying the envelope.
        session.messages.push(StoredMessage {
            id: reservation.assistant_message_id.clone(),
            role: "assistant".into(),
            content: String::new(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
    }
    let message = session
        .messages
        .iter_mut()
        .find(|message| message.id == reservation.assistant_message_id)
        .ok_or_else(|| "assistant message was not available after host insert".to_string())?;
    let meta = message.meta.get_or_insert_with(|| serde_json::json!({}));
    let Some(meta) = meta.as_object_mut() else {
        return Err("assistant message metadata is not an object".into());
    };
    meta.insert(
        INVESTIGATION_ANSWER_META_KEY.into(),
        serde_json::json!(envelope),
    );
    session.touch();
    store.save(&session).map_err(|error| error.to_string())?;
    Ok(true)
}

/// Whether a citation id is a governed log evidence identity (#701 / #698).
///
/// Delegates to the shared core grammar: lowercase `log_event:<u64>` /
/// `log_template:<u64>` only (digits, canonical form, overflow rejected).
fn is_governed_log_citation_id(source_id: &str) -> bool {
    cd_core::log_analysis::is_governed_log_citation_id(source_id)
}

/// Host-owned log citation provenance (#698).
///
/// The renderer may carry transcript chips, but it cannot invent or broaden
/// corpus identity. Rules:
/// 1. If an exact citation id + corpus pair already exists on the durable
///    message, preserve it (survives detach/relink and restart).
/// 2. A lone durable identity remains authoritative when an older renderer
///    omits its corpus. Multiple same-id corpus identities stay distinct.
/// 3. Durable unbound legacy identities stay unbound; genuinely new identities
///    may be stamped only with the session's host-governed linked corpus.
/// 4. Never accept a free-form renderer/model corpus id that differs from those
///    host sources.
fn sanitize_log_citation_provenance(session: &mut Session, durable: Option<&Session>) {
    use std::collections::HashMap;
    let durable_by_msg: HashMap<&str, &cd_core::sessions::StoredMessage> = durable
        .map(|s| s.messages.iter().map(|m| (m.id.as_str(), m)).collect())
        .unwrap_or_default();
    let linked = session.linked_corpus_id.clone();

    for message in &mut session.messages {
        let Some(citations) = message.citations.as_mut() else {
            continue;
        };
        let Some(items) = citations.as_array_mut() else {
            continue;
        };
        // Preserve every trusted (id, corpus) identity. Bare-id maps collapse
        // citations after relink and can route a chip into the wrong corpus.
        let durable_log: Vec<(String, Option<String>)> = durable_by_msg
            .get(message.id.as_str())
            .and_then(|m| m.citations.as_ref())
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let obj = item.as_object()?;
                        let id = obj.get("id")?.as_str()?.to_string();
                        if !is_governed_log_citation_id(&id) {
                            return None;
                        }
                        let corpus = obj
                            .get("corpusId")
                            .or_else(|| obj.get("corpus_id"))
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                        Some((id, corpus))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        for item in items.iter_mut() {
            let Some(obj) = item.as_object_mut() else {
                continue;
            };
            let Some(id) = obj.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
                continue;
            };
            if !is_governed_log_citation_id(&id) {
                // Non-log chips never carry corpus provenance.
                obj.remove("corpusId");
                obj.remove("corpus_id");
                continue;
            }
            let claimed = obj
                .get("corpusId")
                .or_else(|| obj.get("corpus_id"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let same_id = durable_log
                .iter()
                .filter(|(durable_id, _)| durable_id == &id)
                .collect::<Vec<_>>();
            let trusted = same_id
                .iter()
                .find(|(_, corpus)| corpus.as_deref() == claimed)
                .map(|(_, corpus)| corpus.clone())
                .or_else(|| {
                    // A lone historical identity is unambiguous even if an
                    // older renderer omitted its corpus field.
                    (same_id.len() == 1).then(|| same_id[0].1.clone())
                })
                .unwrap_or_else(|| {
                    // A genuinely new identity can only receive the current
                    // host-governed link; never accept renderer provenance.
                    linked.clone()
                });
            match trusted {
                Some(corpus_id) => {
                    obj.insert("corpusId".into(), serde_json::Value::String(corpus_id));
                    obj.remove("corpus_id");
                }
                None => {
                    obj.remove("corpusId");
                    obj.remove("corpus_id");
                }
            }
        }
    }
}

#[cfg(test)]
fn save_chat_session_at(
    store: &cd_core::sessions::SessionStore,
    session: Session,
) -> Result<Session, String> {
    save_chat_session_cas_at(store, session, None)
}

fn save_chat_session_cas_at(
    store: &cd_core::sessions::SessionStore,
    mut session: Session,
    expected_updated_at: Option<&str>,
) -> Result<Session, String> {
    // The renderer owns transcript/view fields, but never the governed corpus
    // grant. Preserve the durable host value for an existing chat and strip an
    // attempted grant from a new chat; only set_chat_linked_corpus may change it.
    let durable = if store.exists(&session.id).map_err(|e| e.to_string())? {
        let durable = store
            .load(&session.id)
            .map_err(|e| format!("chat session is unavailable or corrupt: {e}"))?;
        if let Some(expected) = expected_updated_at {
            let durable_revision = serde_json::to_value(durable.updated_at)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .ok_or_else(|| "chat_session_conflict: invalid durable revision".to_string())?;
            if durable_revision != expected {
                return Err(
                    "chat_session_conflict: the conversation changed; reload and retry".to_string(),
                );
            }
        }
        session.linked_corpus_id = durable.linked_corpus_id.clone();
        Some(durable)
    } else {
        session.linked_corpus_id = None;
        None
    };
    preserve_host_investigation_answer_metadata(&mut session, durable.as_ref());
    sanitize_log_citation_provenance(&mut session, durable.as_ref());
    session.maybe_auto_title_from_first_user();
    session.touch();
    if should_persist_chat_session(&session) {
        store.save(&session).map_err(|e| e.to_string())?;
    }
    Ok(session)
}

fn chat_provider_binding_changed(previous: &Session, next: &Session) -> bool {
    previous.provider_profile_id != next.provider_profile_id
        || previous.chat_model != next.chat_model
}

#[tauri::command]
fn save_chat_session(
    state: State<'_, AppState>,
    session: Session,
    expected_updated_at: Option<String>,
) -> Result<Session, String> {
    let _mutation = state
        .chat_session_mutation
        .lock()
        .map_err(|_| "Chat storage is temporarily unavailable".to_string())?;
    let store = session_store(&state)?;
    if expected_updated_at.is_none()
        && store
            .exists(&session.id)
            .map_err(|error| error.to_string())?
    {
        return Err("chat_session_conflict: expected revision is required".to_string());
    }
    let provider_binding_changed = store
        .load(&session.id)
        .ok()
        .is_some_and(|previous| chat_provider_binding_changed(&previous, &session));
    let session = save_chat_session_cas_at(&store, session, expected_updated_at.as_deref())?;
    if provider_binding_changed {
        state
            .linked_synthesis_checkpoints
            .lock()
            .expect("linked synthesis checkpoints")
            .remove(&session.id);
    }
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
    state
        .linked_synthesis_checkpoints
        .lock()
        .expect("linked synthesis checkpoints")
        .remove(&id);
    // Activity can hold redacted conversation text at Full detail — trash
    // must retire memory + durable sidecar, not leave them for another session.
    retire_chat_session_activity(&state, &id);
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
    state
        .linked_synthesis_checkpoints
        .lock()
        .expect("linked synthesis checkpoints")
        .remove(&id);
    // Permanent delete must retire activity explanations with the session.
    retire_chat_session_activity(&state, &id);
    Ok(())
}

/// Shared deletion lifecycle for activity (memory + durable journal).
///
/// Called from `trash_chat_session`, `delete_chat_session`, and the
/// `forget_session_activity` command so every product path shares one
/// retirement path.
fn retire_chat_session_activity(state: &AppState, session_id: &str) {
    if let Ok(mut store) = state.activity.lock() {
        if let Ok(dir) = ensure_config_dir(&state.branding) {
            cd_core::activity::retire_session_activity(&mut store, &dir, session_id);
        } else {
            store.forget_session(session_id);
        }
    }
    if let Ok(mut developer) = state.developer_activity.lock() {
        developer.forget_session(session_id);
    }
    // Stop any turn still running for this session from delivering further
    // live developer detail.
    suppress_developer_detail_for_session(&state.developer_activity_suppressed, session_id);
}

/// Stop live delivery of developer detail for a session's in-flight turn.
///
/// Called when the operator turns Developer detail off while a turn is
/// still streaming. One-way: the same latch `retire_chat_session_activity`
/// uses, so a stale re-enable can never resurrect delivery for a turn that
/// was already cut off. A later turn on the same session is unaffected — it
/// installs its own fresh gate when it starts.
#[tauri::command]
fn suppress_developer_activity_detail(state: State<'_, AppState>, session_id: String) {
    suppress_developer_detail_for_session(&state.developer_activity_suppressed, &session_id);
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
    state
        .linked_synthesis_checkpoints
        .lock()
        .expect("linked synthesis checkpoints")
        .remove(&id);
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

fn parse_selection_key(key: &str) -> (Option<String>, String) {
    let selection = parse_model_selection_key(key);
    let provider = (!selection.provider_id.is_empty()).then_some(selection.provider_id);
    (provider, selection.model_id)
}

fn model_tools_disabled_reason(
    cfg: &AppConfig,
    profile: &ProviderProfile,
    model_id: &str,
) -> Option<&'static str> {
    cd_workflow::provider::model_tools_disabled_reason(cfg, profile, model_id)
}

fn model_tools_enabled(cfg: &AppConfig, profile: &ProviderProfile, model_id: &str) -> bool {
    cd_workflow::provider::model_tools_enabled(cfg, profile, model_id)
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
    secrets: &ReferencedSecretStore,
) -> ProfileModelInventory {
    let api_key = profile
        .api_key_ref
        .as_ref()
        .and_then(|r| secrets.get(r).ok().flatten());
    models_for_profile_with_key(profile, api_key.as_deref()).await
}

#[derive(Debug, Clone)]
struct ProfileModelCandidate {
    id: String,
    availability: ModelAvailability,
    availability_detail: Option<String>,
}

#[derive(Debug, Clone)]
struct ProfileModelInventory {
    models: Vec<ProfileModelCandidate>,
}

/// List chat models for the **Settings draft** (not only the saved profile).
#[derive(Debug, Deserialize)]
struct ListModelsDraftReq {
    kind: String,
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    api_key_file: Option<String>,
    #[serde(default)]
    local_only: Option<bool>,
    #[serde(default)]
    chat_model: Option<String>,
}

/// Resolve an explicit draft credential or the reference recorded on the
/// matching saved profile. Absence never synthesizes a Keychain reference.
fn resolve_draft_api_key(
    state: &AppState,
    kind: ProviderKind,
    draft_key: Option<&str>,
    draft_file: Option<&str>,
) -> Result<Option<String>, String> {
    if matches!(kind, ProviderKind::XaiGrokBuild | ProviderKind::Ollama) {
        return Ok(None);
    }
    let draft = draft_key
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.chars().all(|c| c == '•'))
        .map(|s| s.to_string());
    let file = draft_file.map(str::trim).filter(|path| !path.is_empty());
    if draft.is_some() && file.is_some() {
        return Err("choose either a pasted API key or a protected key file, not both".into());
    }
    if let Some(draft) = draft {
        return Ok(Some(draft));
    }
    if let Some(path) = file {
        let reference = file_secret_ref(&PathBuf::from(path)).map_err(|e| e.to_string())?;
        return read_file_secret_ref(&reference).map_err(|e| e.to_string());
    }
    let desc = cd_core::providers::descriptor_for(kind);
    let id = desc.profile_id_slug;
    let reference = state
        .config
        .lock()
        .expect("config")
        .providers
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .and_then(|profile| profile.api_key_ref.clone());
    let Some(reference) = reference else {
        return Ok(None);
    };
    state.secrets.get(&reference).map_err(|e| e.to_string())
}

/// TriageTool-parity gateway probe (plain HTTP, multi-path, Bearer + x-api-key).
#[derive(Debug, Deserialize)]
struct ProbeAiGatewayReq {
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    api_key_file: Option<String>,
    /// When true (default), also probe local Ollama.
    #[serde(default)]
    probe_local: Option<bool>,
}

#[tauri::command]
async fn probe_ai_gateway_cmd(
    state: State<'_, AppState>,
    req: ProbeAiGatewayReq,
) -> Result<cd_core::ai_probe::AiProbeResult, String> {
    // Prefer an explicit draft source; otherwise use only a reference already
    // recorded on a remote profile. Never probe an implicit Keychain entry.
    let mut key = resolve_draft_api_key(
        &state,
        ProviderKind::OpenAiCompatible,
        req.api_key.as_deref(),
        req.api_key_file.as_deref(),
    )?;
    if key.is_none() {
        key = resolve_draft_api_key(&state, ProviderKind::Anthropic, None, None)?;
    }
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
        let key = resolve_draft_api_key(
            &state,
            kind,
            req.api_key.as_deref(),
            req.api_key_file.as_deref(),
        )?;
        if kind == ProviderKind::OpenAiCompatible
            && cd_core::discovery::is_vercel_ai_gateway(&req.base_url)
        {
            let profile = ProviderProfile {
                id: "vercel-draft".into(),
                label: "Vercel AI Gateway".into(),
                kind,
                base_url: req.base_url.clone(),
                api_key_ref: None,
                chat_model: req.chat_model.clone().unwrap_or_default(),
                embedding_model: None,
                embedding_base_url: None,
                capabilities: cd_core::providers::descriptor_for(kind).default_capabilities,
                local_only: false,
                deadline_preference: Default::default(),
            };
            let probe = cd_core::discovery::probe_provider_catalog(&profile, key.clone()).await;
            if probe.outcome.is_reachable() {
                let mut ids = probe.model_ids;
                if let Some(configured) = req
                    .chat_model
                    .as_deref()
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                {
                    if !ids.iter().any(|model| model == configured) {
                        ids.push(configured.to_string());
                    }
                }
                ids = cd_core::model_role_hints::sort_ids_for_chat_picker(&ids);
                ids.dedup();
                return Ok(ids);
            }
        }
        let probe_local = matches!(kind, ProviderKind::Ollama)
            || req.base_url.contains("127.0.0.1")
            || req.base_url.to_lowercase().contains("localhost");
        let result =
            cd_core::ai_probe::probe_ai_gateway(&req.base_url, key.as_deref(), probe_local).await;
        // Full inventory for the picker: specialty ids remain selectable but are
        // ranked last by the role-hint catalog (#723). Never drop embed/rerank.
        let mut ids: Vec<String> = result.models.into_iter().map(|m| m.id).collect();
        if ids.is_empty() {
            ids = result.chat_candidates.into_iter().map(|m| m.id).collect();
        }
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
                ids.push(cm.to_string());
            }
        }
        ids = cd_core::model_role_hints::sort_ids_for_chat_picker(&ids);
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
    let api_key = resolve_draft_api_key(
        &state,
        kind,
        req.api_key.as_deref(),
        req.api_key_file.as_deref(),
    )?;
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
        deadline_preference: Default::default(),
        capabilities: desc.default_capabilities,
    };
    Ok(models_for_profile_with_key(&profile, api_key.as_deref())
        .await
        .models
        .into_iter()
        .map(|model| model.id)
        .collect())
}

/// Read the Activity Inspector record for one assistant message.
///
/// Returns `None` when the inspector was disabled for that turn, the turn
/// predates this process, or the record has been evicted by the bounded
/// store — all three are ordinary, and the UI must say "not available"
/// rather than invent an explanation.
///
/// Read-only by construction: there is no command that mutates a record,
/// because an explanation the user can edit is not an explanation.
#[tauri::command]
fn get_turn_activity(
    state: State<'_, AppState>,
    session_id: String,
    message_id: String,
) -> Result<Option<cd_core::activity::TurnActivityRecord>, String> {
    let store = state
        .activity
        .lock()
        .map_err(|_| "Activity storage is temporarily unavailable".to_string())?;
    Ok(store.get(&session_id, &message_id).cloned())
}

/// Read opt-in developer detail for one exact session/message pair.
/// The store is process-local and contains only redacted, bounded payloads.
#[tauri::command]
fn get_developer_turn_activity(
    state: State<'_, AppState>,
    session_id: String,
    message_id: String,
) -> Result<Vec<cd_core::turn_trace::DeveloperDetailEvent>, String> {
    let store = state
        .developer_activity
        .lock()
        .map_err(|_| "Developer activity is temporarily unavailable".to_string())?;
    Ok(store
        .get(&session_id, &message_id)
        .map(<[_]>::to_vec)
        .unwrap_or_default())
}

/// Deletion lifecycle: drop every activity record for one session.
///
/// A record can hold redacted conversation text when the operator opted
/// into full detail, so deleting a chat has to mean its explanations go
/// too.
#[tauri::command]
fn forget_session_activity(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    // Same path as trash/delete so the product cannot leave activity behind.
    retire_chat_session_activity(&state, &session_id);
    Ok(())
}

/// Project one finished turn into a bounded Activity Inspector record.
///
/// Runs strictly AFTER the turn: it reads what the trace already recorded
/// and what the host already emitted, and stores a projection. It cannot
/// influence the turn, and a failure here is deliberately non-fatal — the
/// answer the user asked for is not withheld because an explanation could
/// not be filed.
///
/// Keyed by `(session_id, assistant message id)` so "show me what produced
/// THIS answer" is answerable later, which is when a user actually opens
/// the panel.
/// Returns `true` when this call actually published a record (ordinary
/// activity, developer detail, or both) into the process-lifetime store —
/// the caller uses this to decide whether the frontend needs telling that a
/// new record is now readable (#developer-activity settle event).
fn record_turn_activity(
    state: &AppState,
    req: &AgentTurnReq,
    settings: cd_core::config::ActivitySettings,
    sink: Option<&cd_core::turn_trace::RecordingTurnTrace>,
    linked_corpus_id: Option<&str>,
    result: &Result<Vec<cd_core::events::StreamEvent>, String>,
    turn_started_at: tokio::time::Instant,
) -> bool {
    use cd_core::activity::{ActivityRecorder, ActivityStatus, DataScope, TurnActivityRecord};
    let Some(message_id) = req
        .client_assistant_message_id
        .as_deref()
        .map(str::trim)
        .filter(|message_id| !message_id.is_empty())
    else {
        // No durable message to hang the record off; storing it under a
        // synthesized key would make it unreachable anyway.
        return false;
    };
    let record = settings.enabled.then(|| {
        let scope = match linked_corpus_id {
            Some(corpus_id) => DataScope::log_corpus(corpus_id),
            None => DataScope::conversation(),
        };
        let turn_id = format!("{}::{message_id}", req.session_id);
        let mut recorder = ActivityRecorder::new(
            turn_id,
            req.session_id.clone(),
            scope,
            settings.detail_level(),
        );
        if let Some(sink) = sink {
            recorder.record_timeline(&sink.timeline());
        }
        let status = match result {
            Ok(events) => cd_core::activity::status_for_turn_events(events),
            Err(_) => ActivityStatus::Failed,
        };
        let elapsed_ms = u64::try_from(turn_started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        let mut record: TurnActivityRecord = recorder.finish(status, elapsed_ms);
        record.message_id = Some(message_id.to_string());
        record
    });
    let developer_events = if req.developer_activity_detail {
        sink.map(|sink| sink.developer_events()).unwrap_or_default()
    } else {
        Vec::new()
    };
    // Events the recorder itself dropped (its own `MAX_DEVELOPER_EVENTS` cap
    // was already full) — distinct from anything the store truncates below,
    // and folded into the store's own omitted-count marker so a reader sees
    // one honest total instead of a store-only count that undercounts.
    let developer_dropped = if req.developer_activity_detail {
        sink.map(cd_core::turn_trace::RecordingTurnTrace::developer_dropped)
            .unwrap_or(0)
    } else {
        0
    };
    if record.is_none() && developer_events.is_empty() && developer_dropped == 0 {
        return false;
    }

    // One lifecycle section covers "session still exists" and the bounded
    // process-lifetime store. Trash/delete takes these locks in the same
    // order, so a turn that finishes after its chat was retired cannot
    // recreate the explanation the user just deleted.
    let Ok(_session_lifecycle) = state.chat_session_mutation.lock() else {
        return false;
    };
    let Ok(session) = session_store(state).and_then(|store| {
        store
            .load(&req.session_id)
            .map_err(|error| error.to_string())
    }) else {
        return false;
    };
    if session.trashed {
        return false;
    }
    let mut published = false;
    if let Some(record) = record {
        let Ok(mut activity) = state.activity.lock() else {
            return published;
        };
        activity.insert(&req.session_id, message_id, record);
        published = true;
    }
    if !developer_events.is_empty() || developer_dropped > 0 {
        let Ok(mut developer) = state.developer_activity.lock() else {
            return published;
        };
        developer.insert(
            &req.session_id,
            message_id,
            developer_events,
            developer_dropped,
        );
        published = true;
    }
    published
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
        cfg.model_tools_enabled
            .remove(&format!("{provider_id}::{model_id}"));
    } else {
        cfg.model_tools_enabled
            .remove(&format!("{provider_id}::{model_id}"));
        cfg.model_tools_enabled.insert(key, false);
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *state.config.lock().expect("config") = cfg;
    Ok(tools_enabled)
}

// ---------------------------------------------------------------------------
// Curated visibility (#678) — display only; never deletes configuration
// ---------------------------------------------------------------------------

fn profile_by_id<'a>(cfg: &'a AppConfig, provider_id: &str) -> Result<&'a ProviderProfile, String> {
    cfg.providers
        .profiles
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| format!("unknown provider profile: {provider_id}"))
}

fn curation_state_token(cfg: &AppConfig) -> Result<String, String> {
    use sha2::Digest;
    let bytes = serde_json::to_vec(&(&cfg.providers, &cfg.default_chat_model, &cfg.model_curation))
        .map_err(|error| format!("encode curation state: {error}"))?;
    Ok(format!("{:x}", sha2::Sha256::digest(bytes)))
}

fn require_preview_state(cfg: &AppConfig, expected: Option<&str>) -> Result<(), String> {
    let Some(expected) = expected.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if curation_state_token(cfg)? != expected {
        return Err(
            "model configuration changed after preview — review the current choices again".into(),
        );
    }
    Ok(())
}

/// What a hypothetical curation change would do to the default selection.
async fn curation_impact(
    cfg: &AppConfig,
    secrets: &ReferencedSecretStore,
    next: &AppConfig,
) -> Result<CurationImpactDto, String> {
    let before = build_model_options(cfg, secrets, None).await;
    let default_key = before
        .iter()
        .find(|m| m.is_default)
        .map(|m| m.selection_key.clone());

    // Whether the default is offered *now*, before the change. If it is already
    // curated away, this change did not do that, and demanding a replacement
    // would make every unrelated action — including a restore — re-point the
    // user's default as a side effect.
    let default_was_visible = default_key
        .as_ref()
        .map(|k| before.iter().any(|m| &m.selection_key == k && !m.hidden))
        .unwrap_or(false);

    let after = build_model_options(next, secrets, None).await;
    let visible: Vec<&ModelOptionDto> = after.iter().filter(|m| !m.hidden).collect();
    let default_still_visible = default_key
        .as_ref()
        .map(|k| visible.iter().any(|m| &m.selection_key == k))
        .unwrap_or(false);
    let replacement = visible
        .iter()
        .copied()
        .find(|model| model.availability == ModelAvailability::Discovered);

    Ok(CurationImpactDto {
        // A property of the delta, not of the end state.
        affects_default: default_was_visible && !default_still_visible,
        replacement_key: replacement.map(|m| m.selection_key.clone()),
        replacement_label: replacement.map(|m| format!("{} · {}", m.provider_label, m.label)),
        remaining_visible: visible.len() as u32,
        state_token: curation_state_token(cfg)?,
    })
}

/// Counts for the Settings entry point, read from configuration alone.
///
/// Deliberately does **not** list models. Ordinary Settings must not load the
/// hidden inventory, and it must not trigger discovery against every
/// configured provider merely because the page was opened (#678).
#[tauri::command]
fn get_curation_summary(state: State<'_, AppState>) -> Result<CurationSummaryDto, String> {
    let cfg = state.config.lock().expect("config");
    Ok(cfg.model_curation.active_summary(&cfg.providers.profiles))
}

/// Preview hiding a provider or a model before anything is written.
///
/// `model_id` empty means the whole profile. The returned replacement is the
/// exact choice the pickers would fall to, produced by the same builder the
/// apply path uses.
#[tauri::command]
async fn preview_curation_change(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: Option<String>,
    hidden: bool,
) -> Result<CurationImpactDto, String> {
    let cfg = state.config.lock().expect("config").clone();
    let mut next = cfg.clone();
    {
        let profile = profile_by_id(&cfg, provider_id.trim())?.clone();
        match model_id.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            Some(model) => {
                next.model_curation
                    .set_model_hidden(&profile, model, hidden);
            }
            None => {
                next.model_curation.set_provider_hidden(&profile, hidden);
            }
        }
    }
    curation_impact(&cfg, &state.secrets, &next).await
}

/// Hide or restore one exact provider/model pair.
///
/// Refuses rather than silently invalidating the default: when the change
/// would take the default out of ordinary pickers the caller must pass
/// `accept_replacement` equal to the previewed replacement key, which is then
/// promoted to default in the same write.
#[tauri::command]
async fn set_model_hidden(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
    hidden: bool,
    accept_replacement: Option<String>,
    expected_state_token: Option<String>,
) -> Result<CurationImpactDto, String> {
    let provider_id = provider_id.trim().to_string();
    let model_id = model_id.trim().to_string();
    if model_id.is_empty() {
        return Err("model id is required".into());
    }
    let cfg = state.config.lock().expect("config").clone();
    require_preview_state(&cfg, expected_state_token.as_deref())?;
    let profile = profile_by_id(&cfg, &provider_id)?.clone();

    let mut next = cfg.clone();
    next.model_curation
        .set_model_hidden(&profile, &model_id, hidden);
    let impact = curation_impact(&cfg, &state.secrets, &next).await?;
    let target = provider_id.clone();
    let model = model_id.clone();
    apply_curation(state, &impact, accept_replacement, move |fresh| {
        // Re-resolve against the current config: the profile could have been
        // edited or removed while discovery ran.
        let profile = profile_by_id(fresh, &target)?.clone();
        fresh
            .model_curation
            .set_model_hidden(&profile, &model, hidden);
        Ok(())
    })?;
    Ok(impact)
}

/// Hide or restore a whole provider profile. Nothing is deleted: credentials,
/// base URL, and models all remain configured.
#[tauri::command]
async fn set_provider_hidden(
    state: State<'_, AppState>,
    provider_id: String,
    hidden: bool,
    accept_replacement: Option<String>,
    expected_state_token: Option<String>,
) -> Result<CurationImpactDto, String> {
    let provider_id = provider_id.trim().to_string();
    let cfg = state.config.lock().expect("config").clone();
    require_preview_state(&cfg, expected_state_token.as_deref())?;
    let profile = profile_by_id(&cfg, &provider_id)?.clone();

    let mut next = cfg.clone();
    next.model_curation.set_provider_hidden(&profile, hidden);
    let impact = curation_impact(&cfg, &state.secrets, &next).await?;
    let target = provider_id.clone();
    apply_curation(state, &impact, accept_replacement, move |fresh| {
        let profile = profile_by_id(fresh, &target)?.clone();
        fresh.model_curation.set_provider_hidden(&profile, hidden);
        Ok(())
    })?;
    Ok(impact)
}

/// Pin or unpin one model. Pinning appends to the explicit user order.
#[tauri::command]
async fn set_model_pinned(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
    pinned: bool,
) -> Result<bool, String> {
    let provider_id = provider_id.trim().to_string();
    let model_id = model_id.trim().to_string();
    if model_id.is_empty() {
        return Err("model id is required".into());
    }
    let mut guard = state.config.lock().expect("config");
    let mut cfg = guard.clone();
    let profile = profile_by_id(&cfg, &provider_id)?.clone();
    let changed = cfg
        .model_curation
        .set_model_pinned(&profile, &model_id, pinned);
    if changed {
        let path = config_path(&state.branding).map_err(|e| e.to_string())?;
        save_config(&path, &cfg).map_err(|e| e.to_string())?;
        *guard = cfg;
    }
    Ok(changed)
}

/// Commit a curation change, enforcing the replacement contract.
///
/// `mutate` is applied to a **freshly read** configuration, not to the snapshot
/// the impact was computed from. Computing the impact performs live provider
/// discovery and can take seconds; writing that stale snapshot back would
/// silently revert anything saved meanwhile — a learned tool rejection from a
/// concurrent turn, a context-budget update, a provider edit.
fn apply_curation(
    state: State<'_, AppState>,
    impact: &CurationImpactDto,
    accept_replacement: Option<String>,
    mutate: impl FnOnce(&mut AppConfig) -> Result<(), String>,
) -> Result<(), String> {
    let decision = curation_decision(impact, accept_replacement.as_deref());
    if let CurationDecision::Reject(message) = decision {
        return Err(message);
    }

    let mut guard = state.config.lock().expect("config");
    if curation_state_token(&guard)? != impact.state_token {
        return Err(
            "model configuration changed while discovery was running — review the current choices again"
                .into(),
        );
    }
    let mut cfg = guard.clone();
    mutate(&mut cfg)?;
    if let CurationDecision::ApplyWithDefault(replacement) = decision {
        let (pid, model) = parse_selection_key(&replacement);
        let Some(pid) = pid else {
            return Err("replacement default has no provider identity".into());
        };
        let still_configured = cfg
            .providers
            .profiles
            .iter()
            .any(|profile| profile.id == pid);
        if !still_configured {
            return Err("replacement provider is no longer configured — review again".into());
        }
        cfg.default_chat_model = Some(model.clone());
        if let Some(profile) = cfg.providers.profiles.iter_mut().find(|p| p.id == pid) {
            // Keep the profile's own model in step. resolve_default_model
            // falls back to profile.chat_model, so leaving it pointing at
            // the choice we just hid would reintroduce it as the default.
            profile.chat_model = model;
            let pid = profile.id.clone();
            cfg.providers.active_id = Some(pid);
        }
    }
    let path = config_path(&state.branding).map_err(|e| e.to_string())?;
    save_config(&path, &cfg).map_err(|e| e.to_string())?;
    *guard = cfg;
    Ok(())
}

// ---------------------------------------------------------------------------
// Capability qualification (#724) — user-triggered only; never auto-run
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct QualificationSelectReq {
    /// Optional profile id; defaults to active provider.
    #[serde(default)]
    profile_id: Option<String>,
    /// Exact model id to qualify; defaults to profile chat_model or draft.
    #[serde(default)]
    model_id: Option<String>,
    /// Optional draft base URL (unsaved Advanced settings).
    #[serde(default)]
    base_url: Option<String>,
    /// Optional draft API key paste (never logged).
    #[serde(default)]
    api_key: Option<String>,
}

/// Resolve only non-secret identity fields for cached status and clear actions.
/// This path must never touch Keychain merely because Settings or a picker renders.
fn resolve_qualification_identity_target(
    state: &AppState,
    req: &QualificationSelectReq,
) -> Result<(ProviderProfile, String), String> {
    let cfg = state.config.lock().expect("config").clone();
    let profile = if let Some(pid) = req
        .profile_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        cfg.providers
            .profiles
            .iter()
            .find(|p| p.id == pid)
            .cloned()
            .ok_or_else(|| format!("unknown provider profile: {pid}"))?
    } else {
        cfg.providers
            .active()
            .cloned()
            .ok_or_else(|| "no active provider".to_string())?
    };
    let mut profile = profile;
    if let Some(url) = req
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        profile.base_url = url.to_string();
    }
    let model = req
        .model_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let m = profile.chat_model.trim();
            if m.is_empty() {
                None
            } else {
                Some(m.to_string())
            }
        })
        .ok_or_else(|| "model id is required".to_string())?;
    if profile.base_url.trim().is_empty() && !matches!(profile.kind, ProviderKind::XaiGrokBuild) {
        return Err("base URL is required".into());
    }
    if matches!(profile.kind, ProviderKind::XaiGrokBuild) && profile.base_url.trim().is_empty() {
        profile.base_url = "https://api.x.ai/v1".into();
    }
    Ok((profile, model))
}

/// Resolve a live probe target. Credential lookup is confined to this explicit
/// user-triggered path and never used by cached status, clear, GUI labels, or CLI status.
fn resolve_qualification_target(
    state: &AppState,
    req: &QualificationSelectReq,
) -> Result<(ProviderProfile, String, Option<String>), String> {
    let (profile, model) = resolve_qualification_identity_target(state, req)?;
    let api_key = if matches!(profile.kind, ProviderKind::XaiGrokBuild) {
        None
    } else {
        let draft = req
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty() && !key.chars().all(|c| c == '•'));
        if let Some(draft) = draft {
            Some(draft.to_string())
        } else {
            profile
                .api_key_ref
                .as_deref()
                .and_then(|reference| state.secrets.get(reference).ok().flatten())
        }
    };
    Ok((profile, model, api_key))
}

/// Cached report for the selected profile/endpoint/model (no network).
#[tauri::command]
fn get_capability_qualification(
    state: State<'_, AppState>,
    req: QualificationSelectReq,
) -> Result<Option<capability_qualification_host::QualificationReportDto>, String> {
    let (profile, model) = resolve_qualification_identity_target(&state, &req)?;
    let key =
        capability_qualification_host::qualification_key_for_profile(&profile, &model);
    let cfg = state.config.lock().expect("config").clone();
    let tools_for_model = model_tools_enabled(&cfg, &profile, &model);
    let gate = capability_qualification_host::gate_for_model(&profile, tools_for_model, &model);
    let mut store = state
        .qualification_store
        .lock()
        .expect("qualification_store");
    Ok(capability_qualification_host::get_cached_report_with_gate(
        &mut store,
        &key,
        Some(&gate),
    ))
}

/// Explicit user-triggered synthetic qualification. Never called on Settings open.
#[tauri::command]
async fn start_capability_qualification(
    state: State<'_, AppState>,
    req: QualificationSelectReq,
) -> Result<capability_qualification_host::QualificationReportDto, String> {
    let (profile, model, api_key) = resolve_qualification_target(&state, &req)?;
    let cfg = state.config.lock().expect("config").clone();
    let tools_for_model = model_tools_enabled(&cfg, &profile, &model);
    let gate = capability_qualification_host::gate_for_model(&profile, tools_for_model, &model);
    let key =
        capability_qualification_host::qualification_key_for_profile(&profile, &model);

    // Single-flight cancel flag (one qualification at a time).
    let cancel = {
        let mut cancels = state.cancels.lock().expect("cancels");
        if cancels.contains_key(capability_qualification_host::QUALIFICATION_CANCEL_KEY) {
            return Err("qualification already running".into());
        }
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        cancels.insert(
            capability_qualification_host::QUALIFICATION_CANCEL_KEY.to_string(),
            flag.clone(),
        );
        flag
    };

    if !capability_qualification_host::preflight_inert_and_export_guard(None) {
        return Err("inert probe tool set invalid".into());
    }

    let backend = capability_qualification_host::backend_for_provider(profile.kind);
    let base_url = profile.base_url.clone();
    let local_only = profile.local_only;
    let extra_headers = if matches!(profile.kind, ProviderKind::XaiGrokBuild) {
        cd_core::grok_auth::assert_grok_base_allowed(&base_url).map_err(|e| e.to_string())?;
        match cd_core::grok_auth::load_grok_session_credentials() {
            Ok(c) => c.request_headers(),
            Err(e) => {
                let mut cancels = state.cancels.lock().expect("cancels");
                cancels.remove(capability_qualification_host::QUALIFICATION_CANCEL_KEY);
                return Err(format!("Grok session required: {e}"));
            }
        }
    } else {
        Vec::new()
    };

    let run_gate = gate;
    let report = tokio::task::spawn_blocking(move || {
        let mut transport = capability_qualification_host::LiveQualificationTransport::new(
            backend, base_url, api_key, local_only,
        )
        .with_extra_headers(extra_headers);
        cd_core::capability_qualification::run_qualification(
            key.clone(),
            run_gate,
            &mut transport,
            &cancel,
        )
    })
    .await;

    // Clear cancel flag after finish (success or join failure).
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        cancels.remove(capability_qualification_host::QUALIFICATION_CANCEL_KEY);
    }

    let report = report.map_err(|e| format!("qualification join: {e}"))?;
    let mut store = state
        .qualification_store
        .lock()
        .expect("qualification_store");
    let dto = capability_qualification_host::put_report_with_gate(&mut store, report, &gate);
    cd_core::capability_qualification::save_qualification_store(
        &state.qualification_store_path,
        &store,
    )
    .map_err(|error| format!("save qualification evidence: {error}"))?;
    Ok(dto)
}

/// Cooperative cancel for the in-flight qualification run.
#[tauri::command]
fn cancel_capability_qualification(state: State<'_, AppState>) -> bool {
    let cancels = state.cancels.lock().expect("cancels");
    if let Some(flag) = cancels.get(capability_qualification_host::QUALIFICATION_CANCEL_KEY) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        true
    } else {
        false
    }
}

/// Drop cached result for the exact selected model only (#650).
#[tauri::command]
fn clear_capability_qualification(
    state: State<'_, AppState>,
    req: QualificationSelectReq,
) -> Result<bool, String> {
    let (profile, model) = resolve_qualification_identity_target(&state, &req)?;
    let key =
        capability_qualification_host::qualification_key_for_profile(&profile, &model);
    let mut store = state
        .qualification_store
        .lock()
        .expect("qualification_store");
    let changed = capability_qualification_host::clear_report(&mut store, &key);
    if changed {
        cd_core::capability_qualification::save_qualification_store(
            &state.qualification_store_path,
            &store,
        )
        .map_err(|error| format!("save qualification evidence: {error}"))?;
    }
    Ok(changed)
}

/// Like `models_for_profile` but accepts an already-resolved API key (draft paste).
///
/// For remote gateways, walks `expand_base_candidates` (TriageTool parity) and
/// keeps the **largest** successful model list so corporate path shapes work.
async fn models_for_profile_with_key(
    profile: &ProviderProfile,
    api_key: Option<&str>,
) -> ProfileModelInventory {
    let mut known_ids: Vec<String> = Vec::new();
    let mut discovered_ids: Vec<String> = Vec::new();
    let mut discovery_succeeded = false;
    match profile.kind {
        ProviderKind::Ollama => {
            if let Ok(client) =
                cd_core::chat::OllamaClient::new(&profile.base_url, &profile.chat_model)
            {
                if let Ok(tags) = client.list_tags().await {
                    discovery_succeeded = true;
                    discovered_ids.extend(tags);
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
                        discovery_succeeded = true;
                        if listed.len() > best.len() {
                            best = listed;
                        }
                    }
                }
            }
            discovered_ids.extend(best);
        }
        ProviderKind::XaiGrokBuild => {
            known_ids.extend(
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
                            discovery_succeeded = true;
                            for m in listed {
                                if !discovered_ids.iter().any(|x| x == &m) {
                                    discovered_ids.push(m);
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
                        discovery_succeeded = true;
                        if listed.len() > best.len() {
                            best = listed;
                        }
                    }
                }
            }
            discovered_ids.extend(best);
        }
    }

    let profile_model = profile.chat_model.trim();
    if !profile_model.is_empty()
        && !known_ids.iter().any(|x| x == profile_model)
        && !discovered_ids.iter().any(|x| x == profile_model)
    {
        known_ids.push(profile_model.to_string());
    }
    discovered_ids.sort();
    discovered_ids.dedup();
    known_ids.extend(discovered_ids.iter().cloned());
    known_ids.sort();
    known_ids.dedup();
    let unavailable_detail = if discovery_succeeded {
        "Configured model was not returned by the provider's current discovery response."
    } else {
        "Model discovery did not succeed; availability is unverified."
    };
    ProfileModelInventory {
        models: known_ids
            .into_iter()
            .map(|id| {
                let discovered = discovered_ids.binary_search(&id).is_ok();
                ProfileModelCandidate {
                    id,
                    availability: if discovered {
                        ModelAvailability::Discovered
                    } else {
                        ModelAvailability::ConfiguredUnverified
                    },
                    availability_detail: (!discovered).then(|| unavailable_detail.to_string()),
                }
            })
            .collect(),
    }
}

/// List models from **all** configured providers, for grouped UI selection.
///
/// `include_hidden` (default false) is what keeps curated-away choices out of
/// ordinary pickers without a second round trip; the management surface passes
/// true. `keep_keys` always survives the filter so a chat already pinned to a
/// hidden model still renders honestly instead of silently losing its
/// selection (#678).
#[tauri::command]
async fn list_chat_models(
    state: State<'_, AppState>,
    include_hidden: Option<bool>,
    keep_keys: Option<Vec<String>>,
) -> Result<Vec<ModelOptionDto>, String> {
    let cfg = state.config.lock().expect("config").clone();
    let mut out = build_model_options(&cfg, &state.secrets, Some(&state.qualification_store)).await;
    retain_picker_visible(&mut out, include_hidden.unwrap_or(false), keep_keys);
    Ok(out)
}

/// Drop curated-away options for an ordinary picker.
///
/// The app default and any explicitly kept selection always survive: a picker
/// that cannot render its own value would silently show a different model
/// (#678). Pure, so the rule is testable without a host.
fn retain_picker_visible(
    out: &mut Vec<ModelOptionDto>,
    include_hidden: bool,
    keep_keys: Option<Vec<String>>,
) {
    if include_hidden {
        return;
    }
    let keep: std::collections::BTreeSet<String> = keep_keys
        .unwrap_or_default()
        .into_iter()
        .map(|k| {
            let selection = parse_model_selection_key(&k);
            if selection.provider_id.is_empty() {
                selection.model_id
            } else {
                model_selection_key(&selection.provider_id, &selection.model_id)
            }
        })
        .filter(|k| !k.is_empty())
        .collect();
    out.retain(|m| {
        let selection = parse_model_selection_key(&m.selection_key);
        let comparable = if selection.provider_id.is_empty() {
            selection.model_id
        } else {
            model_selection_key(&selection.provider_id, &selection.model_id)
        };
        !m.hidden || m.is_default || keep.contains(&comparable)
    });
}

/// Build the full annotated, ordered model list for a given configuration.
///
/// Preview and apply both go through this, so the replacement a user is shown
/// before confirming is byte-for-byte the one they end up with (#678).
async fn build_model_options(
    cfg: &AppConfig,
    secrets: &ReferencedSecretStore,
    qualification_store: Option<&Mutex<cd_core::capability_qualification::QualificationStore>>,
) -> Vec<ModelOptionDto> {
    let default_model = resolve_default_model(cfg);
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
        let inventory = models_for_profile(profile, secrets).await;
        let group = provider_group_label(profile);
        for candidate in inventory.models {
            let id = candidate.id;
            let selection_key = model_selection_key(&profile.id, &id);
            let hidden_by = cfg.model_curation.hidden_by(profile, &id);
            out.push(ModelOptionDto {
                is_default: selection_key == default_key
                    || (id == default_model && profile.id == default_pid),
                tools_enabled: model_tools_enabled(cfg, profile, &id),
                tools_disabled_reason: model_tools_disabled_reason(cfg, profile, &id)
                    .map(str::to_string),
                availability: candidate.availability,
                availability_detail: candidate.availability_detail,
                readiness: cd_core::capability_qualification::ModelReadiness::unverified(&id),
                hidden: hidden_by.is_some(),
                hidden_by: hidden_by.map(|h| match h {
                    cd_core::model_curation::HiddenBy::Provider => "provider".to_string(),
                    cd_core::model_curation::HiddenBy::Model => "model".to_string(),
                }),
                pinned_rank: cfg.model_curation.pinned_rank(profile, &id),
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
                    .map(|profile| model_tools_enabled(cfg, profile, &default_model))
                    .unwrap_or(true),
                tools_disabled_reason: cfg.providers.active().and_then(|profile| {
                    model_tools_disabled_reason(cfg, profile, &default_model).map(str::to_string)
                }),
                availability: ModelAvailability::ConfiguredUnverified,
                availability_detail: Some(
                    "The configured default was not confirmed by model discovery.".into(),
                ),
                readiness: cd_core::capability_qualification::ModelReadiness::unverified(
                    &default_model,
                ),
                // The default is always offered: it is what a new chat uses.
                hidden: false,
                hidden_by: None,
                pinned_rank: cfg
                    .providers
                    .active()
                    .and_then(|profile| cfg.model_curation.pinned_rank(profile, &default_model)),
            },
        );
    }

    if let Some(store) = qualification_store {
        let mut store = store.lock().expect("qualification_store");
        for option in &mut out {
            let Some(profile) = cfg
                .providers
                .profiles
                .iter()
                .find(|profile| profile.id == option.provider_id)
            else {
                continue;
            };
            let key = cd_core::capability_qualification::QualificationKey::with_provider_kind(
                &profile.id,
                &profile.base_url,
                &option.id,
                profile.kind,
            );
            option.readiness =
                cd_core::capability_qualification::model_readiness_for_selection(&mut store, &key);
        }
    }

    // Hidden entries last. Explicit pins keep their exact order, and an
    // explicit default stays ahead of recommendations. Within ordinary
    // choices, current verified chat evidence is preferred without silently
    // changing the selected/default model.
    let active_id = cfg.providers.active_id.clone().unwrap_or_default();
    out.sort_by(|a, b| {
        let a_act = a.provider_id == active_id;
        let b_act = b.provider_id == active_id;
        a.hidden
            .cmp(&b.hidden)
            .then_with(|| match (a.pinned_rank, b.pinned_rank) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            })
            .then_with(|| b.is_default.cmp(&a.is_default))
            .then_with(|| {
                a.readiness
                    .chat_preference_rank()
                    .cmp(&b.readiness.chat_preference_rank())
            })
            .then_with(|| b_act.cmp(&a_act))
            .then_with(|| a.group.cmp(&b.group))
            .then_with(|| a.id.cmp(&b.id))
    });

    out
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
    let activity_tool_kind = host
        .activity_tool_kinds()
        .get(&req.tool_name)
        .copied()
        .unwrap_or_default();
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
    if let (Some(sid), Some(h)) = (session_key.as_ref(), history_buf) {
        let mut histories = state.histories.lock().expect("hist");
        histories.insert(sid.clone(), h);
    }
    if let Some(session_id) = session_key.as_deref() {
        // Permission completion updates the same process-lifetime record as
        // the original turn. Share the session lifecycle boundary with
        // trash/delete so a late decision cannot recreate retired activity.
        if let Ok(_session_lifecycle) = state.chat_session_mutation.lock() {
            let active_session = session_store(&state)
                .and_then(|store| store.load(session_id).map_err(|error| error.to_string()))
                .is_ok_and(|session| !session.trashed);
            if active_session {
                let _ = state.activity.lock().ok().and_then(|mut store| {
                    store.record_permission_resolution(
                        session_id,
                        &req.request_id,
                        &req.tool_name,
                        decision,
                        activity_tool_kind,
                        &events,
                    )
                });
            }
        }
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
    /// Persisted semantic ingest-pipeline identity when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    ingest_pipeline_identity: Option<String>,
    /// `current` | `legacy_unknown` | `different_version` — never "broken".
    ingest_pipeline_compatibility: cd_core::log_analysis::IngestPipelineCompatibility,
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
    confidence: cd_core::log_analysis::IngestConfidenceReport,
    top_templates: Vec<LogTopTemplateDto>,
    embedding: cd_core::log_analysis::CorpusEmbeddingStatus,
    /// Separate operation phase timings (#824). Progress chrome stays one
    /// monotonic Stream for interleaved work; completion/diagnostics list these.
    phase_timings: cd_core::log_analysis::IngestPhaseTimings,
}

const DEMO_LOG_IDENTITY: &str = "contextdesk.demo.logs.seven-day-25k.behavior-scale.v1";
const DEMO_LOG_NAME: &str = "Demo · seven-day performance triage";
const DEMO_LOG_RESOURCE_DIR: &str = "demo-log-corpus/seven-day-25k";
const DEMO_LOG_MARKER_DIR: &str = ".contextdesk-demo-corpora";
const DEMO_LOG_MARKER_FILE: &str = "seven-day-25k-behavior-scale.v1.json";
const DEMO_LOG_EXPECTED_EVENTS: u64 = 25_000;
const DEMO_LOG_EXPECTED_SOURCES: u64 = 10;

#[derive(Clone, Copy)]
struct DemoLogResourceEntry {
    path: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const DEMO_LOG_RESOURCE_MANIFEST: &[DemoLogResourceEntry] = &[
    DemoLogResourceEntry {
        path: "api/app.jsonl",
        bytes: 1_357_297,
        sha256: "daa9983c529b24d8768bf19b97b9a5c27c9c81a7078ce467952c109ba3a0b730",
    },
    DemoLogResourceEntry {
        path: "auth/auth.jsonl",
        bytes: 66_853,
        sha256: "f2ce52d81dcb90abf275548041be4ed9f3a607eba2a9c6ff1d9e4358473bdfa1",
    },
    DemoLogResourceEntry {
        path: "db/database.log",
        bytes: 313_382,
        sha256: "9812816b6ad145c5a12058da23422148d96f840b868b5ab537f7063a333dc479",
    },
    DemoLogResourceEntry {
        path: "db/database.log.1",
        bytes: 49_681,
        sha256: "84039ec216e0eb76eaaa8d6ac553f98ac453c61497b74f91877c04e2f6a6914d",
    },
    DemoLogResourceEntry {
        path: "edge/access.jsonl",
        bytes: 1_661_664,
        sha256: "b239d6b28374e10a79063899f939e3ee62da3153c720cb638be9215148ca6322",
    },
    DemoLogResourceEntry {
        path: "queue/events.jsonl",
        bytes: 69_767,
        sha256: "fd24ecdf65e0e4faf159f3b2dbf1d321487ff698068a35bb516f94f49dd6e35c",
    },
    DemoLogResourceEntry {
        path: "region-a/app.jsonl",
        bytes: 79_574,
        sha256: "8f3b86f157b629e5fddf8c0c6a388a372187ead992f45596c940276f4d86263f",
    },
    DemoLogResourceEntry {
        path: "region-b/app.jsonl",
        bytes: 54_421,
        sha256: "5e788d2d03c86f484f22ee4d3bd5cc6c4ddc63671c2e06a461d08b8e2c498800",
    },
    DemoLogResourceEntry {
        path: "worker/worker.log",
        bytes: 476_347,
        sha256: "26bff700bf415f35d054270a0fc43785f476642bf4763bfa44069b5b0b5cf414",
    },
    DemoLogResourceEntry {
        path: "worker/worker.log.1",
        bytes: 72_295,
        sha256: "94222d1ffa4ad30680762d910bf90fb72949c904e37bb55eb5f2cae74489fb93",
    },
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum DemoLogInstallStatus {
    Installed,
    AlreadyInstalled,
    Cancelled,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DemoLogInstallDto {
    status: DemoLogInstallStatus,
    demo_identity: String,
    corpus_id: Option<String>,
    corpus_name: String,
    events: Option<u64>,
    detail: String,
    retryable: bool,
}

impl DemoLogInstallDto {
    fn unavailable(detail: impl Into<String>) -> Self {
        Self {
            status: DemoLogInstallStatus::Unavailable,
            demo_identity: DEMO_LOG_IDENTITY.into(),
            corpus_id: None,
            corpus_name: DEMO_LOG_NAME.into(),
            events: None,
            detail: detail.into(),
            retryable: false,
        }
    }

    fn failed(detail: impl Into<String>, retryable: bool) -> Self {
        Self {
            status: DemoLogInstallStatus::Failed,
            demo_identity: DEMO_LOG_IDENTITY.into(),
            corpus_id: None,
            corpus_name: DEMO_LOG_NAME.into(),
            events: None,
            detail: detail.into(),
            retryable,
        }
    }

    fn cancelled() -> Self {
        Self {
            status: DemoLogInstallStatus::Cancelled,
            demo_identity: DEMO_LOG_IDENTITY.into(),
            corpus_id: None,
            corpus_name: DEMO_LOG_NAME.into(),
            events: None,
            detail: "Installation cancelled. No demo corpus was installed.".into(),
            retryable: true,
        }
    }

    fn cancelled_with_retained_corpus(corpus_id: String, events: u64) -> Self {
        Self {
            status: DemoLogInstallStatus::Cancelled,
            demo_identity: DEMO_LOG_IDENTITY.into(),
            corpus_id: Some(corpus_id),
            corpus_name: DEMO_LOG_NAME.into(),
            events: Some(events),
            detail: "Installation cancelled before activation. The published demo corpus was retained safely and will be recovered and activated when you retry. Your previous corpus selection was restored.".into(),
            retryable: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemoLogMarker {
    schema_version: u32,
    demo_identity: String,
    corpus_id: String,
}

fn demo_log_marker_path(cache: &std::path::Path) -> PathBuf {
    cache.join(DEMO_LOG_MARKER_DIR).join(DEMO_LOG_MARKER_FILE)
}

fn normalize_demo_resource_path(path: &std::path::Path) -> Option<String> {
    let mut normalized = Vec::new();
    for component in path.components() {
        let std::path::Component::Normal(component) = component else {
            return None;
        };
        let component = component.to_str()?;
        if component.is_empty() || component.contains('/') || component.contains('\\') {
            return None;
        }
        normalized.push(component);
    }
    (!normalized.is_empty()).then(|| normalized.join("/"))
}

fn validate_demo_log_resource_against_manifest(
    path: &std::path::Path,
    manifest: &[DemoLogResourceEntry],
) -> bool {
    struct ResourceWalk<'a> {
        expected_files: &'a std::collections::BTreeMap<&'static str, DemoLogResourceEntry>,
        expected_directories: &'a std::collections::BTreeSet<String>,
        max_resource_entries: usize,
        entry_count: usize,
        files: std::collections::BTreeSet<String>,
        directories: std::collections::BTreeSet<String>,
    }

    impl ResourceWalk<'_> {
        fn visit(&mut self, root: &std::path::Path, current: &std::path::Path) -> Result<(), ()> {
            use sha2::Digest;
            use std::io::Read;

            let entries = std::fs::read_dir(current).map_err(|_| ())?;
            for entry in entries {
                let entry = entry.map_err(|_| ())?;
                self.entry_count = self.entry_count.checked_add(1).ok_or(())?;
                if self.entry_count > self.max_resource_entries {
                    return Err(());
                }
                let kind = entry.file_type().map_err(|_| ())?;
                if kind.is_symlink() {
                    return Err(());
                }
                let path = entry.path();
                let relative = path.strip_prefix(root).map_err(|_| ())?;
                let relative = normalize_demo_resource_path(relative).ok_or(())?;
                if kind.is_dir() {
                    if !self.expected_directories.contains(&relative) {
                        return Err(());
                    }
                    if !self.directories.insert(relative) {
                        return Err(());
                    }
                    self.visit(root, &path)?;
                } else if kind.is_file() {
                    let expected = self.expected_files.get(relative.as_str()).ok_or(())?;
                    if !self.files.insert(relative) {
                        return Err(());
                    }
                    let mut file = std::fs::File::open(&path).map_err(|_| ())?;
                    let metadata = file.metadata().map_err(|_| ())?;
                    if !metadata.is_file() || metadata.len() != expected.bytes {
                        return Err(());
                    }
                    let mut hasher = sha2::Sha256::new();
                    let mut buffer = [0_u8; 64 * 1024];
                    let mut bytes_read = 0_u64;
                    loop {
                        let read = file.read(&mut buffer).map_err(|_| ())?;
                        if read == 0 {
                            break;
                        }
                        bytes_read = bytes_read.checked_add(read as u64).ok_or(())?;
                        if bytes_read > expected.bytes {
                            return Err(());
                        }
                        hasher.update(&buffer[..read]);
                    }
                    if bytes_read != expected.bytes
                        || format!("{:x}", hasher.finalize()) != expected.sha256
                    {
                        return Err(());
                    }
                } else {
                    return Err(());
                }
            }
            Ok(())
        }
    }

    let Ok(root_metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return false;
    }
    if manifest.len() != DEMO_LOG_EXPECTED_SOURCES as usize {
        return false;
    }
    let mut expected_files = std::collections::BTreeMap::new();
    let mut expected_directories = std::collections::BTreeSet::new();
    for entry in manifest {
        let manifest_path = std::path::Path::new(entry.path);
        if normalize_demo_resource_path(manifest_path).as_deref() != Some(entry.path)
            || entry.sha256.len() != 64
            || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || expected_files.insert(entry.path, *entry).is_some()
        {
            return false;
        }
        let components = entry.path.split('/').collect::<Vec<_>>();
        for depth in 1..components.len() {
            expected_directories.insert(components[..depth].join("/"));
        }
    }
    let max_resource_entries = expected_directories.len() + expected_files.len();
    let mut walk = ResourceWalk {
        expected_files: &expected_files,
        expected_directories: &expected_directories,
        max_resource_entries,
        entry_count: 0,
        files: std::collections::BTreeSet::new(),
        directories: std::collections::BTreeSet::new(),
    };
    if walk.visit(path, path).is_err() {
        return false;
    }
    walk.files
        == expected_files
            .keys()
            .map(|path| (*path).to_string())
            .collect()
        && walk.directories == expected_directories
}

fn validate_demo_log_resource(path: &std::path::Path) -> bool {
    validate_demo_log_resource_against_manifest(path, DEMO_LOG_RESOURCE_MANIFEST)
}

fn resolve_demo_log_resource_from_candidates(
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|candidate| validate_demo_log_resource(candidate))
}

fn resolve_demo_log_resource(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(DEMO_LOG_RESOURCE_DIR));
    }
    #[cfg(debug_assertions)]
    {
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .join("fixtures")
                .join("log-lab")
                .join("acceptance")
                .join("seven-day-25k")
                .join("scenarios")
                .join("behavior-scale")
                .join("import"),
        );
    }
    resolve_demo_log_resource_from_candidates(candidates)
}

enum DemoLogMarkerState {
    Missing,
    Installed(Box<cd_core::log_analysis::LogCorpus>),
    RepairRequired,
}

fn demo_log_corpus_matches_expected(corpus: &cd_core::log_analysis::LogCorpus) -> bool {
    let Ok(meta) = corpus.meta() else {
        return false;
    };
    meta.managed_identity.as_deref() == Some(DEMO_LOG_IDENTITY)
        && meta.stats.as_ref().is_some_and(|stats| {
            stats.lines == DEMO_LOG_EXPECTED_EVENTS
                && stats.files == DEMO_LOG_EXPECTED_SOURCES
                && !stats.partial
        })
}

fn read_demo_log_marker(cache: &std::path::Path) -> Result<DemoLogMarkerState, String> {
    let marker_path = demo_log_marker_path(cache);
    let metadata = match std::fs::symlink_metadata(&marker_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DemoLogMarkerState::Missing)
        }
        Err(error) => {
            return Err(format!(
                "could not inspect the installed demo marker: {error}"
            ))
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Ok(DemoLogMarkerState::RepairRequired);
    }
    let bytes = std::fs::read(&marker_path)
        .map_err(|error| format!("could not read the installed demo marker: {error}"))?;
    let Ok(marker) = serde_json::from_slice::<DemoLogMarker>(&bytes) else {
        return Ok(DemoLogMarkerState::RepairRequired);
    };
    if marker.schema_version != 1 || marker.demo_identity != DEMO_LOG_IDENTITY {
        return Ok(DemoLogMarkerState::RepairRequired);
    }
    match cd_core::log_analysis::LogCorpus::open(cache, &marker.corpus_id) {
        Ok(corpus) if demo_log_corpus_matches_expected(&corpus) => {
            Ok(DemoLogMarkerState::Installed(Box::new(corpus)))
        }
        Ok(_) => Ok(DemoLogMarkerState::RepairRequired),
        Err(_) => Ok(DemoLogMarkerState::RepairRequired),
    }
}

fn managed_demo_log_corpora(
    cache: &std::path::Path,
    cancel: &cd_core::process_progress::CancelFlag,
) -> Result<Vec<cd_core::log_analysis::LogCorpus>, DemoTransactionError> {
    if cancel.is_cancelled() {
        return Err(DemoTransactionError::Cancelled);
    }
    let mut managed = Vec::new();
    for id in cd_core::log_analysis::LogCorpus::list_ids(cache)
        .map_err(|error| DemoTransactionError::Failed(error.to_string()))?
    {
        if cancel.is_cancelled() {
            return Err(DemoTransactionError::Cancelled);
        }
        let Ok(corpus) = cd_core::log_analysis::LogCorpus::open(cache, &id) else {
            continue;
        };
        if demo_log_corpus_matches_expected(&corpus) {
            managed.push(corpus);
        }
    }
    managed.sort_by(|left, right| {
        let left_created = left.meta().map(|meta| meta.created_at).unwrap_or_default();
        let right_created = right.meta().map(|meta| meta.created_at).unwrap_or_default();
        right_created
            .cmp(&left_created)
            .then_with(|| right.id().cmp(left.id()))
    });
    Ok(managed)
}

fn quarantine_demo_log_marker(cache: &std::path::Path) -> Result<(), String> {
    static QUARANTINE_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let marker_path = demo_log_marker_path(cache);
    match std::fs::symlink_metadata(&marker_path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "could not inspect the damaged demo marker: {error}"
            ))
        }
    }
    let parent = marker_path
        .parent()
        .ok_or_else(|| "demo marker has no parent directory".to_string())?;
    let quarantine = parent.join(format!(
        "{DEMO_LOG_MARKER_FILE}.invalid.{}.{}",
        std::process::id(),
        QUARANTINE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::rename(&marker_path, quarantine)
        .map_err(|error| format!("could not quarantine the damaged demo marker: {error}"))
}

#[cfg(unix)]
fn sync_demo_marker_dir(path: &std::path::Path) -> Result<(), String> {
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("could not sync the demo marker directory: {error}"))
}

#[cfg(not(unix))]
fn sync_demo_marker_dir(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

#[derive(Debug, Default, PartialEq, Eq)]
struct DemoMarkerPublishOutcome {
    warning: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum DemoTransactionError {
    Cancelled,
    Failed(String),
}

fn demo_marker_post_commit_outcome(
    backup_cleanup_error: Option<String>,
    directory_sync_error: Option<String>,
) -> DemoMarkerPublishOutcome {
    let mut warnings = Vec::new();
    if let Some(error) = backup_cleanup_error {
        warnings.push(error);
    }
    if let Some(error) = directory_sync_error {
        warnings.push(error);
    }
    DemoMarkerPublishOutcome {
        warning: (!warnings.is_empty()).then(|| warnings.join("; ")),
    }
}

fn persist_demo_log_marker(
    cache: &std::path::Path,
    corpus_id: &str,
    cancel: &cd_core::process_progress::CancelFlag,
) -> Result<DemoMarkerPublishOutcome, DemoTransactionError> {
    use std::io::Write;
    static TEMP_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    if cancel.is_cancelled() {
        return Err(DemoTransactionError::Cancelled);
    }
    let marker_path = demo_log_marker_path(cache);
    let marker_dir = marker_path.parent().ok_or_else(|| {
        DemoTransactionError::Failed("demo marker has no parent directory".into())
    })?;
    std::fs::create_dir_all(marker_dir).map_err(|error| {
        DemoTransactionError::Failed(format!("could not prepare the demo marker: {error}"))
    })?;
    let temp_path = marker_dir.join(format!(
        ".{DEMO_LOG_MARKER_FILE}.{}.{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let marker = DemoLogMarker {
        schema_version: 1,
        demo_identity: DEMO_LOG_IDENTITY.into(),
        corpus_id: corpus_id.into(),
    };
    let bytes = serde_json::to_vec_pretty(&marker).map_err(|error| {
        DemoTransactionError::Failed(format!("could not encode the demo marker: {error}"))
    })?;
    let mut temp = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|error| {
            DemoTransactionError::Failed(format!("could not create the demo marker: {error}"))
        })?;
    let backup_path = marker_dir.join(format!(
        ".{DEMO_LOG_MARKER_FILE}.{}.{}.previous",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let commit_result = (|| -> Result<(), DemoTransactionError> {
        temp.write_all(&bytes).map_err(|error| {
            DemoTransactionError::Failed(format!("could not write the demo marker: {error}"))
        })?;
        temp.sync_all().map_err(|error| {
            DemoTransactionError::Failed(format!("could not sync the demo marker: {error}"))
        })?;
        if cancel.is_cancelled() {
            return Err(DemoTransactionError::Cancelled);
        }
        if std::fs::symlink_metadata(&marker_path).is_ok() {
            std::fs::rename(&marker_path, &backup_path).map_err(|error| {
                DemoTransactionError::Failed(format!(
                    "could not stage the previous demo marker: {error}"
                ))
            })?;
        }
        if cancel.is_cancelled() {
            if std::fs::symlink_metadata(&backup_path).is_ok() {
                std::fs::rename(&backup_path, &marker_path).map_err(|error| {
                    DemoTransactionError::Failed(format!(
                        "installation was cancelled, but the previous demo marker could not be restored: {error}"
                    ))
                })?;
            }
            return Err(DemoTransactionError::Cancelled);
        }
        if let Err(error) = std::fs::rename(&temp_path, &marker_path) {
            let restore = if backup_path.exists() {
                std::fs::rename(&backup_path, &marker_path)
            } else {
                Ok(())
            };
            return Err(DemoTransactionError::Failed(match restore {
                Ok(()) => format!("could not publish the demo marker: {error}"),
                Err(restore_error) => format!(
                    "could not publish the demo marker: {error}; could not restore the previous marker: {restore_error}"
                ),
            }));
        }
        Ok(())
    })();
    if commit_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    commit_result?;

    // The rename above is the commit point. Cleanup and directory durability
    // diagnostics after it must never make an installed corpus look failed.
    let backup_cleanup_error = if backup_path.exists() {
        std::fs::remove_file(&backup_path)
            .err()
            .map(|error| format!("could not retire the previous demo marker: {error}"))
    } else {
        None
    };
    let directory_sync_error = sync_demo_marker_dir(marker_dir).err();
    Ok(demo_marker_post_commit_outcome(
        backup_cleanup_error,
        directory_sync_error,
    ))
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
        ingest_pipeline_identity: s.ingest_pipeline_identity,
        ingest_pipeline_compatibility: s.ingest_pipeline_compatibility,
        stats: s.stats.as_ref().map(stats_dto),
        top_templates: top,
        embedding: c.embedding_status(),
    }
}

/// List disposable log corpora under app cache.
fn list_log_corpora_at(cache: &std::path::Path) -> Result<Vec<LogCorpusSummaryDto>, String> {
    let summaries =
        cd_core::log_analysis::LogCorpus::list_summaries(cache).map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(summaries.len());
    for summary in summaries {
        let top_templates = cd_core::log_analysis::store::read_meta_file(
            &cache.join("log_corpora").join(&summary.id),
        )
        .map(|meta| {
            meta.top_templates
                .into_iter()
                .map(|template| LogTopTemplateDto {
                    id: template.id,
                    pattern: template.pattern,
                    count: template.count,
                    severity: template.severity,
                })
                .collect()
        })
        .unwrap_or_default();
        out.push(LogCorpusSummaryDto {
            id: summary.id,
            name: summary.name,
            event_count: summary.event_count,
            template_count: summary.template_count,
            engine: summary.engine,
            created_at: summary.created_at,
            source_label: summary.source_label,
            ingest_pipeline_identity: summary.ingest_pipeline_identity,
            ingest_pipeline_compatibility: summary.ingest_pipeline_compatibility,
            stats: summary.stats.as_ref().map(stats_dto),
            top_templates,
            embedding: summary.embedding,
        });
    }
    Ok(out)
}

#[tauri::command]
async fn list_log_corpora(state: State<'_, AppState>) -> Result<Vec<LogCorpusSummaryDto>, String> {
    let cache = log_cache_dir(&state)?;
    tokio::task::spawn_blocking(move || list_log_corpora_at(&cache))
        .await
        .map_err(|error| format!("log corpus list task join: {error}"))?
}

/// Full summary for one corpus (detail header).
fn get_log_corpus_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
) -> Result<LogCorpusSummaryDto, String> {
    let corpus = handles.open(cache, corpus_id)?;
    Ok(summary_dto(&corpus))
}

#[tauri::command]
async fn get_log_corpus(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<LogCorpusSummaryDto, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || get_log_corpus_at(&handles, &cache, &corpus_id))
        .await
        .map_err(|error| format!("log corpus metadata task join: {error}"))?
}

/// List templates for a corpus (UI table).
fn list_log_templates_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    limit: Option<u32>,
) -> Result<Vec<LogTemplateRowDto>, String> {
    let corpus = handles.open(cache, corpus_id)?;
    let lim = limit.unwrap_or(200) as usize;
    let mut rows = corpus.list_templates();
    rows.sort_by_key(|row| std::cmp::Reverse(row.info.count));
    Ok(rows
        .into_iter()
        .take(lim)
        .map(|row| LogTemplateRowDto {
            id: row.info.template_id,
            pattern: row.info.pattern,
            count: row.info.count,
            severity: row.info.severity,
        })
        .collect())
}

#[tauri::command]
async fn list_log_templates(
    state: State<'_, AppState>,
    corpus_id: String,
    limit: Option<u32>,
) -> Result<Vec<LogTemplateRowDto>, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || list_log_templates_at(&handles, &cache, &corpus_id, limit))
        .await
        .map_err(|error| format!("log template list task join: {error}"))?
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogDiagnosticExportRequest {
    format: String,
    report_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogDiagnosticPrepareRequest {
    manifest: log_diagnostic_report::LogDiagnosticManifest,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogDiagnosticReleaseRequest {
    report_id: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
enum LogDiagnosticSaveStatus {
    Saved,
    SavedWithWarning { warning: String },
    Cancelled,
}

struct LogDiagnosticDialogSpec {
    title: &'static str,
    file_name: &'static str,
    filter_name: &'static str,
    extension: &'static str,
}

fn log_diagnostic_dialog_spec(format: &str) -> Result<LogDiagnosticDialogSpec, String> {
    match format {
        "markdown" => Ok(LogDiagnosticDialogSpec {
            title: "Save log diagnostics as Markdown",
            file_name: "contextdesk-log-diagnostics.md",
            filter_name: "Markdown",
            extension: "md",
        }),
        "json" => Ok(LogDiagnosticDialogSpec {
            title: "Save log diagnostics as JSON",
            file_name: "contextdesk-log-diagnostics.json",
            filter_name: "JSON",
            extension: "json",
        }),
        _ => Err("diagnostic format must be markdown or json".into()),
    }
}

#[cfg(test)]
fn complete_log_diagnostic_export(
    request: &LogDiagnosticExportRequest,
    reports: &log_diagnostic_report::LogDiagnosticReportStore,
    selected_path: Option<PathBuf>,
) -> Result<LogDiagnosticSaveStatus, String> {
    let content = reports.content(&request.report_id, &request.format)?;
    complete_log_diagnostic_export_content(&request.format, content, selected_path)
}

fn complete_log_diagnostic_export_content(
    format: &str,
    content: &str,
    selected_path: Option<PathBuf>,
) -> Result<LogDiagnosticSaveStatus, String> {
    let Some(path) = selected_path else {
        return Ok(LogDiagnosticSaveStatus::Cancelled);
    };
    let outcome = log_diagnostics::save_log_diagnostic_report_at_host_path(&path, format, content)?;
    Ok(log_diagnostic_save_status(outcome))
}

fn log_diagnostic_save_status(
    outcome: log_diagnostics::DiagnosticPublishOutcome,
) -> LogDiagnosticSaveStatus {
    match outcome.warning {
        Some(warning) => LogDiagnosticSaveStatus::SavedWithWarning { warning },
        None => LogDiagnosticSaveStatus::Saved,
    }
}

/// Validate and scrub a strict payload-free manifest, render both exact
/// previews in the trusted host, and retain them under an opaque memory-only id.
#[tauri::command]
fn prepare_log_diagnostic_report(
    state: State<'_, AppState>,
    request: LogDiagnosticPrepareRequest,
) -> Result<log_diagnostic_report::PreparedLogDiagnostic, String> {
    state
        .log_diagnostic_reports
        .lock()
        .map_err(|_| "diagnostic report store is unavailable".to_string())?
        .prepare(request.manifest)
}

/// Release one process-local diagnostic preview when the renderer replaces or
/// closes it. Unknown/expired ids are harmless; malformed ids fail closed.
#[tauri::command]
fn release_log_diagnostic_report(
    state: State<'_, AppState>,
    request: LogDiagnosticReleaseRequest,
) -> Result<bool, String> {
    state
        .log_diagnostic_reports
        .lock()
        .map_err(|_| "diagnostic report store is unavailable".to_string())?
        .release(&request.report_id)
}

/// Show the host-owned native Save panel and atomically write one bounded,
/// privacy-reviewed diagnostic. The renderer has no destination or overwrite
/// authority.
#[tauri::command]
async fn save_log_diagnostic_report(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    request: LogDiagnosticExportRequest,
) -> Result<LogDiagnosticSaveStatus, String> {
    let content = {
        let reports = state
            .log_diagnostic_reports
            .lock()
            .map_err(|_| "diagnostic report store is unavailable".to_string())?;
        reports
            .content(&request.report_id, &request.format)?
            .to_string()
    };
    let spec = log_diagnostic_dialog_spec(&request.format)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(spec.title)
        .set_file_name(spec.file_name)
        .add_filter(spec.filter_name, &[spec.extension])
        .save_file(move |selected| {
            let _ = sender.send(selected);
        });
    let selected = receiver
        .await
        .map_err(|_| "native diagnostic Save dialog ended unexpectedly".to_string())?
        .map(|path| {
            path.into_path()
                .map_err(|_| "native diagnostic Save dialog returned an invalid path".to_string())
        })
        .transpose()?;
    complete_log_diagnostic_export_content(&request.format, &content, selected)
}

/// Read the one memory-only failed-ingest diagnostic, if the latest trial failed.
#[tauri::command]
fn get_failed_log_ingest_diagnostic(
    state: State<'_, AppState>,
) -> Option<cd_core::log_analysis::FailedIngestDiagnostic> {
    state
        .failed_log_ingest_diagnostic
        .lock()
        .expect("failed_log_ingest_diagnostic")
        .snapshot()
}

/// Explicitly clear the one memory-only failed-ingest diagnostic.
#[tauri::command]
fn clear_failed_log_ingest_diagnostic(state: State<'_, AppState>) -> bool {
    state
        .failed_log_ingest_diagnostic
        .lock()
        .expect("failed_log_ingest_diagnostic")
        .clear()
}

/// Import a portable package zip (SoftWrite — creates disposable corpus).
#[tauri::command]
fn import_log_corpus_package_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<LogPackageImportDto, String> {
    // A package import is a new ingest attempt even though it does not produce
    // the raw-ingest evidence DTO. Clear the prior transient failure before
    // any cache/path validation can fail.
    let diagnostic_attempt = state
        .failed_log_ingest_diagnostic
        .lock()
        .expect("failed_log_ingest_diagnostic")
        .begin_attempt();
    let cache = log_cache_dir(&state)?;
    let report = cd_core::log_analysis::import_corpus_zip_path(&cache, std::path::Path::new(&path))
        .map_err(|e| e.to_string())?;
    state
        .failed_log_ingest_diagnostic
        .lock()
        .expect("failed_log_ingest_diagnostic")
        .record_success(diagnostic_attempt);
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
    invocation: ProcessProgressInvocation,
}

static PROCESS_PROGRESS_OPERATION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn next_process_progress_operation_id() -> String {
    let sequence = PROCESS_PROGRESS_OPERATION_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;
    let epoch_millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("host-{epoch_millis}-{sequence}")
}

#[derive(Clone)]
struct ProcessProgressInvocation {
    operation_id: String,
    correlation_id: String,
}

impl ProcessProgressInvocation {
    fn new(requested_correlation_id: Option<String>) -> Self {
        let operation_id = next_process_progress_operation_id();
        let correlation_id = requested_correlation_id
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 200
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b":_-".contains(&byte))
            })
            .unwrap_or_else(|| format!("host:{operation_id}"));
        Self {
            operation_id,
            correlation_id,
        }
    }
}

#[derive(Clone, Serialize)]
struct TauriProcessProgressPayload {
    operation_id: String,
    correlation_id: String,
    #[serde(flatten)]
    update: cd_core::process_progress::ProcessProgress,
}

impl TauriProcessProgress {
    fn new(app: tauri::AppHandle) -> Self {
        Self::new_correlated(app, None)
    }

    fn new_correlated(app: tauri::AppHandle, correlation_id: Option<String>) -> Self {
        Self {
            app,
            invocation: ProcessProgressInvocation::new(correlation_id),
        }
    }
}

impl cd_core::process_progress::ProcessProgressObserver for TauriProcessProgress {
    fn progress(&self, update: cd_core::process_progress::ProcessProgress) {
        let _ = self.app.emit(
            "process-progress",
            TauriProcessProgressPayload {
                operation_id: self.invocation.operation_id.clone(),
                correlation_id: self.invocation.correlation_id.clone(),
                update,
            },
        );
    }
}

/// Fan one log-ingest progress stream to the UI and the payload-free recorder.
struct TauriLogIngestProgress {
    app: tauri::AppHandle,
    recorder: Arc<cd_core::log_analysis::FailedIngestDiagnosticRecorder>,
    invocation: ProcessProgressInvocation,
}

impl cd_core::process_progress::ProcessProgressObserver for TauriLogIngestProgress {
    fn progress(&self, update: cd_core::process_progress::ProcessProgress) {
        self.recorder.progress(update.clone());
        let _ = self.app.emit(
            "process-progress",
            TauriProcessProgressPayload {
                operation_id: self.invocation.operation_id.clone(),
                correlation_id: self.invocation.correlation_id.clone(),
                update,
            },
        );
    }

    fn log_ingest_evidence(&self, evidence: cd_core::process_progress::LogIngestEvidence) {
        self.recorder.log_ingest_evidence(evidence);
    }
}

/// Key used in `AppState.cancels` for SoftWrite log ingest (#498).
const LOG_INGEST_CANCEL_KEY: &str = "log_ingest";
const LOG_REANALYZE_CANCEL_KEY: &str = "log_reanalyze";

#[derive(Debug, PartialEq, Eq)]
enum LogIngestRunError {
    Cancelled,
    Failed(String),
}

impl LogIngestRunError {
    fn message(&self) -> &str {
        match self {
            Self::Cancelled => "ingest cancelled",
            Self::Failed(message) => message,
        }
    }

    fn into_message(self) -> String {
        self.message().to_string()
    }
}

fn register_exclusive_cancel(
    cancels: &mut HashMap<String, Arc<std::sync::atomic::AtomicBool>>,
    key: &str,
    flag: Arc<std::sync::atomic::AtomicBool>,
    already_active: &str,
) -> Result<(), String> {
    let domain = key.split(':').next().unwrap_or(key);
    let scoped_prefix = format!("{domain}:");
    if cancels
        .keys()
        .any(|existing| existing == domain || existing.starts_with(&scoped_prefix))
    {
        return Err(already_active.into());
    }
    cancels.insert(key.into(), flag);
    Ok(())
}

fn remove_cancel_if_owned(
    cancels: &mut HashMap<String, Arc<std::sync::atomic::AtomicBool>>,
    key: &str,
    owner: &Arc<std::sync::atomic::AtomicBool>,
) -> bool {
    if cancels
        .get(key)
        .is_some_and(|registered| Arc::ptr_eq(registered, owner))
    {
        cancels.remove(key);
        true
    } else {
        false
    }
}

fn find_cancel_for_correlation<'a>(
    cancels: &'a HashMap<String, Arc<std::sync::atomic::AtomicBool>>,
    domain: &str,
    correlation_id: Option<&str>,
) -> Option<&'a Arc<std::sync::atomic::AtomicBool>> {
    if let Some(correlation_id) = correlation_id {
        return cancels.get(&format!("{domain}:{correlation_id}"));
    }
    let prefix = format!("{domain}:");
    let mut matches = cancels
        .iter()
        .filter(|(key, _)| key.as_str() == domain || key.starts_with(&prefix))
        .map(|(_, flag)| flag);
    let only = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    Some(only)
}

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

/// Shared trusted host orchestration for ordinary and packaged-demo ingest.
///
/// Runs on a blocking thread pool so the UI event loop is not starved. Both
/// callers use the same exclusive admission, diagnostics, cancellation,
/// progress, bounded core ingest policy, and active-corpus handoff.
#[allow(clippy::too_many_arguments)]
async fn run_log_ingest(
    app: tauri::AppHandle,
    state: &AppState,
    path: PathBuf,
    name: Option<String>,
    invocation: ProcessProgressInvocation,
    managed_identity: Option<String>,
    selection: Option<cd_core::log_analysis::IngestSelection>,
    cancel: cd_core::process_progress::CancelFlag,
) -> Result<LogIngestReportDto, LogIngestRunError> {
    let selected_path = path;
    let source_kind = cd_core::log_analysis::FailedIngestSourceKind::from_path(&selected_path);
    let recorder = Arc::new(cd_core::log_analysis::FailedIngestDiagnosticRecorder::default());
    // Exclusive admission is not itself an ingest attempt. Once admitted,
    // invalidate the previous generation before cache setup, provider lookup,
    // or any other fallible ingest work. A setup failure belongs to this attempt.
    let diagnostic_attempt = state
        .failed_log_ingest_diagnostic
        .lock()
        .expect("failed_log_ingest_diagnostic")
        .begin_attempt();
    let cache = match log_cache_dir(state) {
        Ok(cache) => cache,
        Err(error) => {
            let diagnostic = recorder.finish(&error, source_kind, cd_core::embed::now_unix_secs());
            state
                .failed_log_ingest_diagnostic
                .lock()
                .expect("failed_log_ingest_diagnostic")
                .record_failure(diagnostic_attempt, diagnostic);
            return Err(LogIngestRunError::Failed(error));
        }
    };
    let (policy, embed_backend) = desktop_log_ingest_embed_plan_nonblocking(&state.host);
    let progress = TauriLogIngestProgress {
        app: app.clone(),
        recorder: Arc::clone(&recorder),
        invocation,
    };
    let name_owned = name.unwrap_or_else(|| "corpus".into());
    let cancel_for_job = cancel.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let result = match (managed_identity, selection) {
            (Some(identity), Some(selection)) => {
                cd_core::log_analysis::ingest_path_with_policy_selection_and_observer_managed(
                    &cache,
                    &selected_path,
                    &name_owned,
                    &policy,
                    embed_backend,
                    &progress,
                    Some(&cancel_for_job),
                    &identity,
                    &selection,
                )
            }
            (Some(identity), None) => {
                cd_core::log_analysis::ingest_path_with_policy_and_observer_managed(
                    &cache,
                    &selected_path,
                    &name_owned,
                    &policy,
                    embed_backend,
                    &progress,
                    Some(&cancel_for_job),
                    &identity,
                )
            }
            (None, Some(selection)) => {
                cd_core::log_analysis::ingest_path_with_policy_selection_and_observer(
                    &cache,
                    &selected_path,
                    &name_owned,
                    &policy,
                    embed_backend,
                    &progress,
                    Some(&cancel_for_job),
                    &selection,
                )
            }
            (None, None) => cd_core::log_analysis::ingest_path_with_policy_and_observer(
                &cache,
                &selected_path,
                &name_owned,
                &policy,
                embed_backend,
                &progress,
                Some(&cancel_for_job),
            ),
        };
        result.map_err(|error| match error {
            cd_core::error::CoreError::Cancelled => LogIngestRunError::Cancelled,
            other => LogIngestRunError::Failed(other.to_string()),
        })
    })
    .await;
    let report = match outcome {
        Ok(Ok(report)) => {
            state
                .failed_log_ingest_diagnostic
                .lock()
                .expect("failed_log_ingest_diagnostic")
                .record_success(diagnostic_attempt);
            report
        }
        Ok(Err(error)) => {
            let diagnostic = recorder.finish(
                error.message(),
                source_kind,
                cd_core::embed::now_unix_secs(),
            );
            state
                .failed_log_ingest_diagnostic
                .lock()
                .expect("failed_log_ingest_diagnostic")
                .record_failure(diagnostic_attempt, diagnostic);
            return Err(error);
        }
        Err(error) => {
            let error = LogIngestRunError::Failed(format!("ingest task join: {error}"));
            let diagnostic = recorder.finish(
                error.message(),
                source_kind,
                cd_core::embed::now_unix_secs(),
            );
            state
                .failed_log_ingest_diagnostic
                .lock()
                .expect("failed_log_ingest_diagnostic")
                .record_failure(diagnostic_attempt, diagnostic);
            return Err(error);
        }
    };
    // Wizard/UI ingest: default subsequent log tools to this corpus without requiring
    // the model (or user) to re-type the id.
    set_active_log_corpus_state_nonblocking(state, Some(report.corpus_id.clone()));
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
        confidence: report.confidence,
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
        phase_timings: report.phase_timings,
    })
}

/// Ingest a user-selected local log file/dir into a disposable corpus
/// (UI SoftWrite path).
#[tauri::command]
async fn ingest_log_path(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
    correlation_id: Option<String>,
) -> Result<LogIngestReportDto, String> {
    let invocation = ProcessProgressInvocation::new(correlation_id);
    let cancel_key = format!("{LOG_INGEST_CANCEL_KEY}:{}", invocation.correlation_id);
    let cancel = cd_core::process_progress::CancelFlag::new();
    let cancel_registration = cancel.inner_arc();
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        register_exclusive_cancel(
            &mut cancels,
            &cancel_key,
            Arc::clone(&cancel_registration),
            "a log import is already running",
        )?;
    }
    let result = run_log_ingest(
        app,
        &state,
        PathBuf::from(path),
        name,
        invocation,
        None,
        None,
        cancel,
    )
    .await;
    remove_cancel_if_owned(
        &mut state.cancels.lock().expect("cancels"),
        &cancel_key,
        &cancel_registration,
    );
    result.map_err(LogIngestRunError::into_message)
}

struct DemoLogIngestReceipt {
    corpus_id: String,
    events: u64,
    sources: u64,
}

fn discard_managed_demo_corpus(cache: &std::path::Path, corpus_id: &str) -> Result<(), String> {
    let corpus = cd_core::log_analysis::LogCorpus::open(cache, corpus_id)
        .map_err(|error| format!("could not inspect the mismatched demo corpus: {error}"))?;
    let is_managed = corpus
        .meta()
        .map_err(|error| format!("could not verify the mismatched demo corpus: {error}"))?
        .managed_identity
        .as_deref()
        == Some(DEMO_LOG_IDENTITY);
    if !is_managed {
        return Err(
            "refused to discard a corpus without the reserved packaged-demo identity".into(),
        );
    }
    drop(corpus);
    cd_core::log_analysis::LogCorpus::discard(cache, corpus_id)
        .map_err(|error| format!("could not discard the mismatched demo corpus: {error}"))
}

#[async_trait::async_trait]
trait DemoLogInstallBackend: Send + Sync {
    fn cache_dir(&self) -> Result<PathBuf, String>;
    fn resolve_resource(&self) -> Option<PathBuf>;
    fn active_corpus(&self) -> Option<String>;
    fn select_corpus(&self, corpus_id: Option<String>);
    fn discard_ingested_corpus(
        &self,
        cache: &std::path::Path,
        corpus_id: &str,
    ) -> Result<(), String>;
    fn publish_marker(
        &self,
        cache: &std::path::Path,
        corpus_id: &str,
        cancel: &cd_core::process_progress::CancelFlag,
    ) -> Result<DemoMarkerPublishOutcome, DemoTransactionError>;
    async fn ingest(
        &self,
        resource: PathBuf,
        cancel: &cd_core::process_progress::CancelFlag,
    ) -> Result<DemoLogIngestReceipt, LogIngestRunError>;
}

struct TauriDemoLogInstallBackend<'a> {
    app: tauri::AppHandle,
    state: &'a AppState,
}

#[async_trait::async_trait]
impl DemoLogInstallBackend for TauriDemoLogInstallBackend<'_> {
    fn cache_dir(&self) -> Result<PathBuf, String> {
        log_cache_dir(self.state)
    }

    fn resolve_resource(&self) -> Option<PathBuf> {
        resolve_demo_log_resource(&self.app)
    }

    fn active_corpus(&self) -> Option<String> {
        active_log_corpus_snapshot(self.state)
    }

    fn select_corpus(&self, corpus_id: Option<String>) {
        set_active_log_corpus_state_nonblocking(self.state, corpus_id);
    }

    fn discard_ingested_corpus(
        &self,
        cache: &std::path::Path,
        corpus_id: &str,
    ) -> Result<(), String> {
        discard_managed_demo_corpus(cache, corpus_id)
    }

    fn publish_marker(
        &self,
        cache: &std::path::Path,
        corpus_id: &str,
        cancel: &cd_core::process_progress::CancelFlag,
    ) -> Result<DemoMarkerPublishOutcome, DemoTransactionError> {
        persist_demo_log_marker(cache, corpus_id, cancel)
    }

    async fn ingest(
        &self,
        resource: PathBuf,
        cancel: &cd_core::process_progress::CancelFlag,
    ) -> Result<DemoLogIngestReceipt, LogIngestRunError> {
        let report = run_log_ingest(
            self.app.clone(),
            self.state,
            resource,
            Some(DEMO_LOG_NAME.into()),
            ProcessProgressInvocation::new(None),
            Some(DEMO_LOG_IDENTITY.into()),
            None,
            cancel.clone(),
        )
        .await?;
        Ok(DemoLogIngestReceipt {
            corpus_id: report.corpus_id,
            events: report.lines,
            sources: report.files,
        })
    }
}

struct ReconciledDemoLog {
    corpus: cd_core::log_analysis::LogCorpus,
    recovered: bool,
    managed_copies: usize,
    warning: Option<String>,
}

fn reconcile_demo_log_corpus<B: DemoLogInstallBackend>(
    backend: &B,
    cache: &std::path::Path,
    cancel: &cd_core::process_progress::CancelFlag,
) -> Result<Option<ReconciledDemoLog>, DemoTransactionError> {
    if cancel.is_cancelled() {
        return Err(DemoTransactionError::Cancelled);
    }
    let marker_needs_repair =
        match read_demo_log_marker(cache).map_err(DemoTransactionError::Failed)? {
            DemoLogMarkerState::Installed(corpus) => {
                if cancel.is_cancelled() {
                    return Err(DemoTransactionError::Cancelled);
                }
                return Ok(Some(ReconciledDemoLog {
                    corpus: *corpus,
                    recovered: false,
                    managed_copies: 1,
                    warning: None,
                }));
            }
            DemoLogMarkerState::Missing => false,
            DemoLogMarkerState::RepairRequired => true,
        };
    if cancel.is_cancelled() {
        return Err(DemoTransactionError::Cancelled);
    }
    let managed = managed_demo_log_corpora(cache, cancel)?;
    if marker_needs_repair {
        if cancel.is_cancelled() {
            return Err(DemoTransactionError::Cancelled);
        }
        quarantine_demo_log_marker(cache).map_err(DemoTransactionError::Failed)?;
    }
    let managed_copies = managed.len();
    let Some(corpus) = managed.into_iter().next() else {
        return Ok(None);
    };
    let publish = backend.publish_marker(cache, corpus.id(), cancel)?;
    Ok(Some(ReconciledDemoLog {
        corpus,
        recovered: true,
        managed_copies,
        warning: publish.warning,
    }))
}

/// Explicit first-run convenience. The resource resolver can only select the
/// packaged input directory (or its debug checkout equivalent); trusted ingest
/// remains identical to an ordinary user-selected import.
async fn install_demo_log_corpus_transaction<B: DemoLogInstallBackend>(
    backend: &B,
    cancel: &cd_core::process_progress::CancelFlag,
) -> DemoLogInstallDto {
    if cancel.is_cancelled() {
        return DemoLogInstallDto::cancelled();
    }
    let cache = match backend.cache_dir() {
        Ok(cache) => cache,
        Err(error) => return DemoLogInstallDto::failed(error, true),
    };
    if cancel.is_cancelled() {
        return DemoLogInstallDto::cancelled();
    }
    match reconcile_demo_log_corpus(backend, &cache, cancel) {
        Ok(Some(reconciled)) => {
            let summary = reconciled.corpus.summary();
            backend.select_corpus(Some(summary.id.clone()));
            let mut detail = if reconciled.recovered {
                if reconciled.managed_copies > 1 {
                    format!(
                        "Recovered the newest packaged demo after an interrupted install; {} older managed copies were left untouched.",
                        reconciled.managed_copies - 1
                    )
                } else {
                    "Recovered the packaged demo after an interrupted install and selected it."
                        .into()
                }
            } else {
                "The packaged demo corpus is already installed and selected.".into()
            };
            if let Some(warning) = reconciled.warning {
                detail.push_str(&format!(" Warning: {warning}"));
            }
            return DemoLogInstallDto {
                status: DemoLogInstallStatus::AlreadyInstalled,
                demo_identity: DEMO_LOG_IDENTITY.into(),
                corpus_id: Some(summary.id),
                corpus_name: summary.name,
                events: Some(summary.event_count),
                detail,
                retryable: false,
            };
        }
        Ok(None) => {}
        Err(DemoTransactionError::Cancelled) => return DemoLogInstallDto::cancelled(),
        Err(DemoTransactionError::Failed(error)) => return DemoLogInstallDto::failed(error, true),
    }
    if cancel.is_cancelled() {
        return DemoLogInstallDto::cancelled();
    }
    let Some(resource) = backend.resolve_resource() else {
        return DemoLogInstallDto::unavailable(
            "The packaged demo logs are unavailable in this installation.",
        );
    };
    if cancel.is_cancelled() {
        return DemoLogInstallDto::cancelled();
    }
    let prior_active_corpus = backend.active_corpus();
    let report = match backend.ingest(resource, cancel).await {
        Ok(report) => report,
        Err(LogIngestRunError::Cancelled) => {
            backend.select_corpus(prior_active_corpus);
            return DemoLogInstallDto::cancelled();
        }
        Err(LogIngestRunError::Failed(error)) => {
            backend.select_corpus(prior_active_corpus);
            return DemoLogInstallDto::failed(error, true);
        }
    };
    if report.events != DEMO_LOG_EXPECTED_EVENTS || report.sources != DEMO_LOG_EXPECTED_SOURCES {
        backend.select_corpus(prior_active_corpus);
        let cleanup_detail = match backend.discard_ingested_corpus(&cache, &report.corpus_id) {
            Ok(()) => " The mismatched demo corpus was discarded.".to_string(),
            Err(error) => format!(
                " Cleanup failed: {error}. The mismatched corpus remains unselected and cannot be activated as the packaged demo."
            ),
        };
        return DemoLogInstallDto::failed(
            format!(
                "The packaged demo did not match its expected post-ingest identity (expected {DEMO_LOG_EXPECTED_SOURCES} sources and {DEMO_LOG_EXPECTED_EVENTS} events; imported {} sources and {} events). The demo was not activated.{cleanup_detail}",
                report.sources, report.events,
            ),
            true,
        );
    }
    let publish = match backend.publish_marker(&cache, &report.corpus_id, cancel) {
        Ok(publish) => publish,
        Err(DemoTransactionError::Cancelled) => {
            backend.select_corpus(prior_active_corpus);
            return DemoLogInstallDto::cancelled_with_retained_corpus(
                report.corpus_id,
                report.events,
            );
        }
        Err(DemoTransactionError::Failed(error)) => {
            // The corpus is intentionally retained: its reserved identity was
            // written before atomic publication, so retry can prove and
            // reconcile this crash window without guessing at user corpora.
            backend.select_corpus(prior_active_corpus);
            return DemoLogInstallDto::failed(error, true);
        }
    };
    let detail = publish.warning.map_or_else(
        || "The packaged demo corpus is installed and selected.".into(),
        |warning| format!("The packaged demo corpus is installed and selected. Warning: {warning}"),
    );
    DemoLogInstallDto {
        status: DemoLogInstallStatus::Installed,
        demo_identity: DEMO_LOG_IDENTITY.into(),
        corpus_id: Some(report.corpus_id),
        corpus_name: DEMO_LOG_NAME.into(),
        events: Some(report.events),
        detail,
        retryable: false,
    }
}

#[cfg(test)]
async fn install_demo_log_corpus_serialized<B: DemoLogInstallBackend>(
    serial: &tokio::sync::Mutex<()>,
    backend: &B,
    cancel: &cd_core::process_progress::CancelFlag,
) -> DemoLogInstallDto {
    let _transaction = serial.lock().await;
    install_demo_log_corpus_transaction(backend, cancel).await
}

#[tauri::command]
async fn install_demo_log_corpus(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<DemoLogInstallDto, String> {
    let _transaction = state.demo_log_install.lock().await;
    let cancel = cd_core::process_progress::CancelFlag::new();
    let cancel_registration = cancel.inner_arc();
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        register_exclusive_cancel(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            Arc::clone(&cancel_registration),
            "a log import is already running",
        )?;
    }
    let backend = TauriDemoLogInstallBackend { app, state: &state };
    let result = install_demo_log_corpus_transaction(&backend, &cancel).await;
    remove_cancel_if_owned(
        &mut state.cancels.lock().expect("cancels"),
        LOG_INGEST_CANCEL_KEY,
        &cancel_registration,
    );
    Ok(result)
}

/// Trusted local re-analysis of template vectors; raw events are not reparsed.
#[tauri::command]
async fn reanalyze_log_corpus(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    corpus_id: String,
    correlation_id: Option<String>,
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
    let invocation = ProcessProgressInvocation::new(correlation_id);
    let cancel_key = format!("{LOG_REANALYZE_CANCEL_KEY}:{}", invocation.correlation_id);
    let progress = TauriProcessProgress { app, invocation };
    let cancel = cd_core::process_progress::CancelFlag::new();
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        register_exclusive_cancel(
            &mut cancels,
            &cancel_key,
            cancel.inner_arc(),
            "a log re-analysis is already running",
        )?;
    }
    let cancel_for_job = cancel.clone();
    let reanalyzed_corpus_id = corpus_id.clone();
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
    state.cancels.lock().expect("cancels").remove(&cancel_key);
    if matches!(&result, Ok(Ok(_))) {
        state.log_corpus_handles.remove(&reanalyzed_corpus_id);
    }
    result?
}

/// Cancel the active trusted local template re-analysis.
#[tauri::command]
fn cancel_log_reanalysis(
    state: State<'_, AppState>,
    correlation_id: Option<String>,
) -> Result<bool, String> {
    let cancels = state.cancels.lock().expect("cancels");
    if let Some(flag) = find_cancel_for_correlation(
        &cancels,
        LOG_REANALYZE_CANCEL_KEY,
        correlation_id.as_deref(),
    ) {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        return Ok(true);
    }
    Ok(false)
}

/// Request cancel of an in-flight SoftWrite log ingest (#498).
#[tauri::command]
fn cancel_log_ingest(
    state: State<'_, AppState>,
    correlation_id: Option<String>,
) -> Result<bool, String> {
    let cancels = state.cancels.lock().expect("cancels");
    if let Some(flag) =
        find_cancel_for_correlation(&cancels, LOG_INGEST_CANCEL_KEY, correlation_id.as_deref())
    {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        return Ok(true);
    }
    Ok(false)
}

/// Problem clusters for a corpus.
fn log_cluster_problems_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    max_clusters: Option<u32>,
) -> Result<Vec<LogClusterDto>, String> {
    let corpus = handles.open(cache, corpus_id)?;
    let clusters =
        cd_core::log_analysis::cluster_problems(&corpus, max_clusters.unwrap_or(10) as usize)
            .map_err(|e| e.to_string())?;
    Ok(clusters
        .into_iter()
        .map(|cluster| LogClusterDto {
            cluster_id: cluster.cluster_id,
            label: cluster.label,
            count: cluster.count,
            severity: cluster.severity,
            score: cluster.score,
            template_ids: cluster.template_ids,
            exemplars: cluster.exemplars,
        })
        .collect())
}

#[tauri::command]
async fn log_cluster_problems(
    state: State<'_, AppState>,
    corpus_id: String,
    max_clusters: Option<u32>,
) -> Result<Vec<LogClusterDto>, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        log_cluster_problems_at(&handles, &cache, &corpus_id, max_clusters)
    })
    .await
    .map_err(|error| format!("log problem cluster task join: {error}"))?
}

/// Timeline buckets for a corpus.
fn log_timeline_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    width_secs: Option<i64>,
) -> Result<Vec<LogTimelineBucketDto>, String> {
    let corpus = handles.open(cache, corpus_id)?;
    let buckets = cd_core::log_analysis::timeline(&corpus, width_secs.unwrap_or(60), None, None)
        .map_err(|e| e.to_string())?;
    Ok(buckets
        .into_iter()
        .map(|bucket| LogTimelineBucketDto {
            start: bucket.start,
            width: bucket.width,
            count: bucket.count,
        })
        .collect())
}

#[tauri::command]
async fn log_timeline(
    state: State<'_, AppState>,
    corpus_id: String,
    width_secs: Option<i64>,
) -> Result<Vec<LogTimelineBucketDto>, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || log_timeline_at(&handles, &cache, &corpus_id, width_secs))
        .await
        .map_err(|error| format!("log analysis timeline task join: {error}"))?
}

/// Hybrid log search (paraphrase-capable when embed backend present).
fn log_search_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: String,
    k: Option<u32>,
    embed_backend: Option<Arc<dyn cd_core::embed::EmbedBackend>>,
) -> Result<Vec<LogSearchHitDto>, String> {
    let corpus = handles.open(cache, corpus_id)?;
    let request = cd_core::log_analysis::SearchLogsQuery {
        query: Some(query),
        semantic: true,
        k: k.unwrap_or(8) as usize,
        ..Default::default()
    };
    let hits = cd_core::log_analysis::search_logs(&corpus, &request, embed_backend.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(hits
        .into_iter()
        .map(|hit| LogSearchHitDto {
            template_id: hit.template_id,
            pattern: hit.pattern,
            score: hit.score,
            semantic_score: hit.semantic_score,
            count: hit.count,
            severity: hit.severity,
            exemplars: hit.exemplars,
        })
        .collect())
}

#[tauri::command]
async fn log_search(
    state: State<'_, AppState>,
    corpus_id: String,
    query: String,
    k: Option<u32>,
) -> Result<Vec<LogSearchHitDto>, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    let embed_backend = log_embed_backend_snapshot_nonblocking(&state);
    tokio::task::spawn_blocking(move || {
        log_search_at(&handles, &cache, &corpus_id, query, k, embed_backend)
    })
    .await
    .map_err(|error| format!("log analysis search task join: {error}"))?
}

/// Discard a disposable corpus.
#[tauri::command]
fn discard_log_corpus(state: State<'_, AppState>, corpus_id: String) -> Result<(), String> {
    let cache = log_cache_dir(&state)?;
    state.log_corpus_handles.remove(&corpus_id);
    cd_core::log_analysis::LogCorpus::discard(&cache, &corpus_id).map_err(|e| e.to_string())?;
    if active_log_corpus_snapshot(&state).as_deref() == Some(corpus_id.as_str()) {
        set_active_log_corpus_state_nonblocking(&state, None);
    }
    // Discarded corpus must not keep a staged exact-nav target for replay.
    if let Ok(mut store) = state.log_explorer_nav_targets.lock() {
        store.clear(&corpus_id);
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogTimezoneDeclarationDto {
    source: String,
    iana_zone: String,
    basis: &'static str,
    declared_at: i64,
    applied_revision: u64,
}

impl From<cd_core::log_analysis::SourceTimezoneDeclaration> for LogTimezoneDeclarationDto {
    fn from(value: cd_core::log_analysis::SourceTimezoneDeclaration) -> Self {
        Self {
            source: value.source,
            iana_zone: value.iana_timezone,
            basis: "user_declared",
            declared_at: value.declared_at,
            applied_revision: value.applied_revision,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogTimezoneSourceStatusDto {
    source: String,
    unresolved_local_records: u64,
    resolved_local_records: u64,
    explicit_wall_clock_records: u64,
    other_order_only_records: u64,
}

impl From<cd_core::log_analysis::TimezoneSourceStatus> for LogTimezoneSourceStatusDto {
    fn from(value: cd_core::log_analysis::TimezoneSourceStatus) -> Self {
        Self {
            source: value.source,
            unresolved_local_records: value.unresolved_local_records,
            resolved_local_records: value.resolved_local_records,
            explicit_wall_clock_records: value.explicit_wall_clock_records,
            other_order_only_records: value.other_order_only_records,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogTimezoneStateDto {
    corpus_id: String,
    event_revision: u64,
    declarations: std::collections::BTreeMap<String, LogTimezoneDeclarationDto>,
    sources: Vec<LogTimezoneSourceStatusDto>,
}

impl From<cd_core::log_analysis::TimezoneResolutionState> for LogTimezoneStateDto {
    fn from(value: cd_core::log_analysis::TimezoneResolutionState) -> Self {
        Self {
            corpus_id: value.scope.corpus_id,
            event_revision: value.scope.event_revision,
            declarations: value
                .declarations
                .into_iter()
                .map(|(source, declaration)| (source, declaration.into()))
                .collect(),
            sources: value.sources.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogTimezonePreviewDto {
    corpus_id: String,
    event_revision: u64,
    source: String,
    iana_zone: String,
    preview_token: String,
    affected_records: u64,
    existing_wall_clock_records: u64,
    first_resolved_ts: Option<i64>,
    last_resolved_ts: Option<i64>,
    dst_gap_records: u64,
    dst_fold_ambiguities: u64,
    unchanged_order_only_records: u64,
    unsupported_timestamp_records: u64,
    zone_abbreviation_mismatch_records: u64,
    out_of_range_records: u64,
    precision: &'static str,
}

impl From<cd_core::log_analysis::TimezoneResolutionPreview> for LogTimezonePreviewDto {
    fn from(value: cd_core::log_analysis::TimezoneResolutionPreview) -> Self {
        Self {
            corpus_id: value.corpus_id,
            event_revision: value.event_revision,
            source: value.source,
            iana_zone: value.iana_timezone,
            preview_token: value.declaration_fingerprint,
            affected_records: value.affected_records,
            existing_wall_clock_records: value.existing_wall_clock_records,
            first_resolved_ts: value.first_resolved_instant,
            last_resolved_ts: value.last_resolved_instant,
            dst_gap_records: value.dst_gap_count,
            dst_fold_ambiguities: value.dst_fold_count,
            unchanged_order_only_records: value.unchanged_order_only_records,
            unsupported_timestamp_records: value.unsupported_timestamp_count,
            zone_abbreviation_mismatch_records: value.zone_abbreviation_mismatch_count,
            out_of_range_records: value.out_of_range_count,
            precision: "whole_second",
        }
    }
}

#[tauri::command]
async fn log_load_timezone_state(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<LogTimezoneStateDto, String> {
    let cache = log_cache_dir(&state)?;
    tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::load_timezone_resolution_state(&cache, &corpus_id)
            .map(Into::into)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("timezone state task join: {error}"))?
}

/// Read-only bounded import preview over a file, directory, or ZIP (#751).
///
/// Never writes or stages anything; classification, counts, and reasons come
/// from trusted core. Registers the shared log-ingest cancel flag, so
/// `cancel_log_ingest` genuinely aborts a long preview walk.
#[tauri::command]
async fn log_preview_import(
    state: State<'_, AppState>,
    path: String,
) -> Result<cd_core::log_analysis::import_preview::ImportPreviewPlan, String> {
    let cancel = cd_core::process_progress::CancelFlag::new();
    let cancel_registration = cancel.inner_arc();
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        register_exclusive_cancel(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            Arc::clone(&cancel_registration),
            "a log import is already running",
        )?;
    }
    let result = tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::import_preview::preview_import_plan(
            std::path::Path::new(&path),
            Some(&cancel),
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("import preview task join: {error}"));
    remove_cancel_if_owned(
        &mut state.cancels.lock().expect("cancels"),
        LOG_INGEST_CANCEL_KEY,
        &cancel_registration,
    );
    result?
}

/// Run a reviewed, plan-bound import (#751).
///
/// Trusted core re-enumerates the root and verifies the plan token before
/// any ingest work: a stale plan (content changed, entries appeared or
/// disappeared, classifications shifted), an unknown or duplicate identity,
/// a selection of non-event content, or an empty selection all fail closed
/// before staging. The UI's disabled state is a courtesy, never the
/// enforcement.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn log_run_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
    plan_token: String,
    plan_version: u32,
    selected: Vec<String>,
    correlation_id: Option<String>,
) -> Result<LogIngestReportDto, String> {
    let invocation = ProcessProgressInvocation::new(correlation_id);
    let cancel_key = format!("{LOG_INGEST_CANCEL_KEY}:{}", invocation.correlation_id);
    let cancel = cd_core::process_progress::CancelFlag::new();
    let cancel_registration = cancel.inner_arc();
    {
        let mut cancels = state.cancels.lock().expect("cancels");
        register_exclusive_cancel(
            &mut cancels,
            &cancel_key,
            Arc::clone(&cancel_registration),
            "a log import is already running",
        )?;
    }
    let verify_path = PathBuf::from(&path);
    let verify_cancel = cancel.clone();
    let selection = tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::import_preview::verify_import_plan(
            &verify_path,
            plan_version,
            &plan_token,
            &selected,
            Some(&verify_cancel),
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("import plan verification task join: {error}"));
    let selection = match selection {
        Ok(Ok(selection)) => selection,
        Ok(Err(message)) | Err(message) => {
            remove_cancel_if_owned(
                &mut state.cancels.lock().expect("cancels"),
                &cancel_key,
                &cancel_registration,
            );
            return Err(message);
        }
    };
    let result = run_log_ingest(
        app,
        &state,
        PathBuf::from(path),
        name,
        invocation,
        None,
        Some(selection),
        cancel,
    )
    .await;
    remove_cancel_if_owned(
        &mut state.cancels.lock().expect("cancels"),
        &cancel_key,
        &cancel_registration,
    );
    result.map_err(LogIngestRunError::into_message)
}

/// Apply reviewed timezone declarations to one or more sources atomically
/// (#813). Every preview token is recomputed and matched server-side; any
/// mismatch fails the whole application before staging.
#[tauri::command]
async fn log_apply_source_timezones(
    state: State<'_, AppState>,
    corpus_id: String,
    expected_revision: u64,
    requests: Vec<cd_core::log_analysis::SourceTimezoneApplyRequest>,
) -> Result<cd_core::log_analysis::EventRevisionReport, String> {
    let cache = log_cache_dir(&state)?;
    let declared_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "system time is before the Unix epoch".to_string())?
        .as_secs();
    let declared_at = i64::try_from(declared_at)
        .map_err(|_| "system time is outside the supported range".to_string())?;
    tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::apply_source_timezones(
            &cache,
            &corpus_id,
            expected_revision,
            &requests,
            declared_at,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("timezone apply task join: {error}"))?
}

/// One-step undo of the current event revision (#813). Publishes forward:
/// the restored state becomes a new revision, preserving the audit chain.
#[tauri::command]
async fn log_undo_event_revision(
    state: State<'_, AppState>,
    corpus_id: String,
    expected_revision: u64,
) -> Result<cd_core::log_analysis::EventRevisionReport, String> {
    let cache = log_cache_dir(&state)?;
    tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::undo_event_revision(&cache, &corpus_id, expected_revision, None)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("event revision undo task join: {error}"))?
}

#[tauri::command]
async fn log_preview_source_timezone(
    state: State<'_, AppState>,
    corpus_id: String,
    event_revision: u64,
    source: String,
    iana_zone: String,
) -> Result<LogTimezonePreviewDto, String> {
    let cache = log_cache_dir(&state)?;
    tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::preview_source_timezone(
            &cache,
            &corpus_id,
            event_revision,
            &source,
            &iana_zone,
        )
        .map(Into::into)
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("timezone preview task join: {error}"))?
}

#[tauri::command]
async fn log_apply_source_timezone(
    state: State<'_, AppState>,
    corpus_id: String,
    expected_revision: u64,
    source: String,
    iana_zone: String,
    preview_token: String,
) -> Result<cd_core::log_analysis::EventRevisionReport, String> {
    let cache = log_cache_dir(&state)?;
    let declared_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "system time is before the Unix epoch".to_string())?
        .as_secs();
    let declared_at = i64::try_from(declared_at)
        .map_err(|_| "system time is outside the supported range".to_string())?;
    tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::apply_source_timezone(
            &cache,
            &corpus_id,
            expected_revision,
            &source,
            &iana_zone,
            &preview_token,
            declared_at,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("timezone apply task join: {error}"))?
}

#[tauri::command]
async fn log_clear_source_timezone(
    state: State<'_, AppState>,
    corpus_id: String,
    expected_revision: u64,
    source: String,
    applied_revision: u64,
) -> Result<cd_core::log_analysis::EventRevisionReport, String> {
    let cache = log_cache_dir(&state)?;
    tokio::task::spawn_blocking(move || {
        cd_core::log_analysis::clear_source_timezone(
            &cache,
            &corpus_id,
            expected_revision,
            &source,
            applied_revision,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("timezone clear task join: {error}"))?
}

fn save_log_operational_metrics_attachment_at(
    cache: &std::path::Path,
    corpus_id: &str,
    document_text: &str,
    display_label: &str,
    source: cd_core::log_analysis::OperationalMetricsAttachmentSource,
) -> Result<
    cd_core::log_analysis::OperationalMetricsAttachment,
    cd_core::log_analysis::OperationalMetricsAttachmentError,
> {
    cd_core::log_analysis::save_operational_metrics_attachment(
        cache,
        corpus_id,
        document_text,
        display_label,
        source,
    )
}

fn validate_log_operational_metrics_request_bounds(
    document_text: &str,
    display_label: &str,
) -> Result<(), cd_core::log_analysis::OperationalMetricsAttachmentError> {
    let content_bytes = u64::try_from(document_text.len()).unwrap_or(u64::MAX);
    if content_bytes > cd_core::log_analysis::MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES {
        return Err(
            cd_core::log_analysis::OperationalMetricsAttachmentError::TooLarge {
                actual_bytes: content_bytes,
                max_bytes: cd_core::log_analysis::MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES,
            },
        );
    }
    if display_label.len() > cd_core::log_analysis::MAX_OPERATIONAL_METRICS_DISPLAY_LABEL_BYTES {
        return Err(
            cd_core::log_analysis::OperationalMetricsAttachmentError::InvalidSource {
                reason: "display label exceeds its bounded input size".into(),
            },
        );
    }
    Ok(())
}

/// Persist one caller-neutral, validated operational-metrics attachment.
///
/// Manual loading and future Incident Evidence Bundle import use this exact
/// core API and metadata contract. No external source path is accepted.
#[tauri::command]
async fn log_save_operational_metrics_attachment(
    state: State<'_, AppState>,
    corpus_id: String,
    document_text: String,
    display_label: String,
    source: cd_core::log_analysis::OperationalMetricsAttachmentSource,
) -> Result<
    cd_core::log_analysis::OperationalMetricsAttachment,
    cd_core::log_analysis::OperationalMetricsAttachmentError,
> {
    validate_log_operational_metrics_request_bounds(&document_text, &display_label)?;
    let cache = log_cache_dir(&state).map_err(|_| {
        cd_core::log_analysis::OperationalMetricsAttachmentError::Storage {
            operation: "resolve corpus storage".into(),
        }
    })?;
    tokio::task::spawn_blocking(move || {
        save_log_operational_metrics_attachment_at(
            &cache,
            &corpus_id,
            &document_text,
            &display_label,
            source,
        )
    })
    .await
    .map_err(
        |_| cd_core::log_analysis::OperationalMetricsAttachmentError::Storage {
            operation: "join attachment save task".into(),
        },
    )?
}

fn load_log_operational_metrics_attachment_at(
    cache: &std::path::Path,
    corpus_id: &str,
) -> Result<
    cd_core::log_analysis::OperationalMetricsAttachment,
    cd_core::log_analysis::OperationalMetricsAttachmentError,
> {
    cd_core::log_analysis::load_operational_metrics_attachment(cache, corpus_id)
}

/// Restore and revalidate one exact corpus attachment.
#[tauri::command]
async fn log_load_operational_metrics_attachment(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<
    cd_core::log_analysis::OperationalMetricsAttachment,
    cd_core::log_analysis::OperationalMetricsAttachmentError,
> {
    let cache = log_cache_dir(&state).map_err(|_| {
        cd_core::log_analysis::OperationalMetricsAttachmentError::Storage {
            operation: "resolve corpus storage".into(),
        }
    })?;
    tokio::task::spawn_blocking(move || {
        load_log_operational_metrics_attachment_at(&cache, &corpus_id)
    })
    .await
    .map_err(
        |_| cd_core::log_analysis::OperationalMetricsAttachmentError::Storage {
            operation: "join attachment load task".into(),
        },
    )?
}

fn remove_log_operational_metrics_attachment_at(
    cache: &std::path::Path,
    corpus_id: &str,
) -> Result<(), cd_core::log_analysis::OperationalMetricsAttachmentError> {
    cd_core::log_analysis::remove_operational_metrics_attachment(cache, corpus_id)
}

/// Remove only the exact corpus attachment.
#[tauri::command]
async fn log_remove_operational_metrics_attachment(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<(), cd_core::log_analysis::OperationalMetricsAttachmentError> {
    let cache = log_cache_dir(&state).map_err(|_| {
        cd_core::log_analysis::OperationalMetricsAttachmentError::Storage {
            operation: "resolve corpus storage".into(),
        }
    })?;
    tokio::task::spawn_blocking(move || {
        remove_log_operational_metrics_attachment_at(&cache, &corpus_id)
    })
    .await
    .map_err(
        |_| cd_core::log_analysis::OperationalMetricsAttachmentError::Storage {
            operation: "join attachment remove task".into(),
        },
    )?
}

#[cfg(test)]
mod operational_metrics_attachment_backend_tests {
    use super::*;

    fn document() -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "id": "tauri-boundary",
            "name": "Tauri boundary metrics",
            "series": [{
                "id": "clients",
                "name": "Concurrent clients",
                "unit": "clients",
                "provenance": {"source": "test-harness"},
                "timeQuality": "wall",
                "points": [
                    {"timestamp": 1_735_737_600.0, "value": 10.0},
                    {"timestamp": 1_735_737_601.0, "value": 20.0}
                ]
            }]
        })
        .to_string()
    }

    #[test]
    fn backend_helpers_reconstruct_replace_and_remove_without_a_source_path() {
        let cache = tempfile::tempdir().expect("cache");
        let corpus = cd_core::log_analysis::LogCorpus::create(cache.path(), "tauri attachment")
            .expect("corpus");
        let corpus_id = corpus.id().to_string();
        let corpus_root = corpus.root().to_path_buf();
        drop(corpus);

        let saved = save_log_operational_metrics_attachment_at(
            cache.path(),
            &corpus_id,
            &document(),
            r"C:\private\customer\performance.json",
            cd_core::log_analysis::OperationalMetricsAttachmentSource::ManualLoad,
        )
        .expect("save");
        assert_eq!(saved.metadata.display_name, "performance.json");

        let restored = load_log_operational_metrics_attachment_at(cache.path(), &corpus_id)
            .expect("restore after fresh corpus open");
        assert_eq!(restored, saved);

        let stored = std::fs::read_dir(&corpus_root)
            .expect("corpus files")
            .filter_map(Result::ok)
            .find_map(|entry| {
                let name = entry.file_name();
                name.to_string_lossy()
                    .starts_with("operational-metrics-attachment")
                    .then(|| std::fs::read_to_string(entry.path()).expect("attachment text"))
            })
            .expect("attachment envelope");
        assert!(!stored.contains(r"C:\private\customer"));

        remove_log_operational_metrics_attachment_at(cache.path(), &corpus_id).expect("remove");
        assert!(matches!(
            load_log_operational_metrics_attachment_at(cache.path(), &corpus_id),
            Err(cd_core::log_analysis::OperationalMetricsAttachmentError::Missing)
        ));
        assert!(corpus_root.join("events.duckdb").is_file());
    }

    #[test]
    fn backend_helpers_reject_corpus_id_traversal_before_storage_access() {
        let cache = tempfile::tempdir().expect("cache");
        assert!(matches!(
            load_log_operational_metrics_attachment_at(cache.path(), "../../outside"),
            Err(cd_core::log_analysis::OperationalMetricsAttachmentError::CorpusUnavailable)
        ));
    }

    #[test]
    fn tauri_boundary_rejects_oversized_content_and_labels_before_core_work() {
        let oversized_document = " "
            .repeat((cd_core::log_analysis::MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES + 1) as usize);
        assert!(matches!(
            validate_log_operational_metrics_request_bounds(&oversized_document, "metrics.json"),
            Err(cd_core::log_analysis::OperationalMetricsAttachmentError::TooLarge { .. })
        ));
        let oversized_label =
            "x".repeat(cd_core::log_analysis::MAX_OPERATIONAL_METRICS_DISPLAY_LABEL_BYTES + 1);
        assert!(matches!(
            validate_log_operational_metrics_request_bounds("{}", &oversized_label),
            Err(cd_core::log_analysis::OperationalMetricsAttachmentError::InvalidSource { .. })
        ));
    }
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

/// Reduce a renderer-supplied exclusion set to what the durable policy allows.
///
/// The webview is outside the trusted computing base (`docs/THREAT_MODEL.md`),
/// so `excludedTemplateIds` arriving over IPC is a **request**, never
/// authority. Every Explorer read path routes through here before touching the
/// corpus, so a stale or compromised renderer cannot hide evidence the #671
/// policy does not authorize. Suspend and temporary reveal keep working
/// because they send fewer ids and this can only ever remove more.
///
/// This never fails the query: an unreadable policy yields an empty effective
/// set, which shows everything rather than withholding evidence.
fn enforce_log_suppression_lens(
    corpus: &cd_core::log_analysis::LogCorpus,
    query: &mut cd_core::log_analysis::EventQuery,
) {
    let _ = cd_core::log_analysis::apply_trusted_suppression_lens(corpus, query);
}

/// Open a corpus and reduce the query's exclusions in one step.
fn open_log_corpus_with_lens(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: &mut cd_core::log_analysis::EventQuery,
) -> Result<Arc<cd_core::log_analysis::LogCorpus>, String> {
    let corpus = handles.open(cache, corpus_id)?;
    enforce_log_suppression_lens(&corpus, query);
    Ok(corpus)
}

/// Paged/keyset event query for the Log Explorer.
fn query_log_events_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: &cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::EventPage, String> {
    let mut query = query.clone();
    let corpus = open_log_corpus_with_lens(handles, cache, corpus_id, &mut query)?;
    cd_core::log_analysis::query_events(&corpus, &query).map_err(|e| e.to_string())
}

#[tauri::command]
async fn log_query_events(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::EventPage, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || query_log_events_at(&handles, &cache, &corpus_id, &query))
        .await
        .map_err(|error| format!("log event query task join: {error}"))?
}

/// Count-free bounded event rows for hosts that load exact totals independently.
fn query_log_event_rows_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: &cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::EventRowsPage, String> {
    let mut query = query.clone();
    let corpus = open_log_corpus_with_lens(handles, cache, corpus_id, &mut query)?;
    cd_core::log_analysis::query_event_rows(&corpus, &query).map_err(|e| e.to_string())
}

#[tauri::command]
async fn log_query_event_rows(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::EventRowsPage, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        query_log_event_rows_at(&handles, &cache, &corpus_id, &query)
    })
    .await
    .map_err(|error| format!("log event rows task join: {error}"))?
}

/// Exact cursor-independent count for one event filter.
fn count_log_events_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: &cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::EventCount, String> {
    let mut query = query.clone();
    let corpus = open_log_corpus_with_lens(handles, cache, corpus_id, &mut query)?;
    cd_core::log_analysis::query_event_count(&corpus, &query).map_err(|e| e.to_string())
}

#[tauri::command]
async fn log_count_events(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::EventCount, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || count_log_events_at(&handles, &cache, &corpus_id, &query))
        .await
        .map_err(|error| format!("log event count task join: {error}"))?
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
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    seq: u64,
) -> Result<LogEventOriginalDto, String> {
    let corpus = handles.open(cache, corpus_id)?;
    cd_core::log_analysis::query::query_event_original(&corpus, seq)
        .map(LogEventOriginalDto::from)
        .map_err(|e| e.to_string())
}

/// Explicit, read-only fetch for the inspector's Original (redacted) view.
///
/// This remains separate from ordinary Explorer pages, search, evidence, and
/// linked-chat DTOs so source records never enter those paths automatically.
#[tauri::command]
async fn log_query_event_original(
    state: State<'_, AppState>,
    corpus_id: String,
    seq: u64,
) -> Result<LogEventOriginalDto, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        query_log_event_original_at(&handles, &cache, &corpus_id, seq)
    })
    .await
    .map_err(|error| format!("log original event task join: {error}"))?
}

/// Fixed-size, filter-aware timeline summary for the lazy Explorer navigator.
fn query_log_timeline_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: &cd_core::log_analysis::TimelineSummaryQuery,
) -> Result<cd_core::log_analysis::TimelineSummary, String> {
    let mut query = query.clone();
    let corpus = open_log_corpus_with_lens(handles, cache, corpus_id, &mut query.filter)?;
    cd_core::log_analysis::query_timeline_summary(&corpus, &query).map_err(|e| e.to_string())
}

#[tauri::command]
async fn log_timeline_summary(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::TimelineSummaryQuery,
) -> Result<cd_core::log_analysis::TimelineSummary, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || query_log_timeline_at(&handles, &cache, &corpus_id, &query))
        .await
        .map_err(|error| format!("log timeline task join: {error}"))?
}

/// One bounded global timeline axis with canonical severity and lane tracks.
fn query_log_shared_timeline_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: &cd_core::log_analysis::SharedTimelineSummaryQuery,
) -> Result<cd_core::log_analysis::SharedTimelineSummary, String> {
    let mut query = query.clone();
    let corpus = open_log_corpus_with_lens(handles, cache, corpus_id, &mut query.filter)?;
    cd_core::log_analysis::query_shared_timeline_summary(&corpus, &query).map_err(|e| e.to_string())
}

#[tauri::command]
async fn log_shared_timeline_summary(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::SharedTimelineSummaryQuery,
) -> Result<cd_core::log_analysis::SharedTimelineSummary, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        query_log_shared_timeline_at(&handles, &cache, &corpus_id, &query)
    })
    .await
    .map_err(|error| format!("shared log timeline task join: {error}"))?
}

/// Bounded neighborhood around a stable event identity (Find / bookmark seek).
fn query_log_event_neighborhood_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: &cd_core::log_analysis::EventNeighborhoodQuery,
) -> Result<cd_core::log_analysis::EventNeighborhood, String> {
    let mut query = query.clone();
    let corpus = open_log_corpus_with_lens(handles, cache, corpus_id, &mut query.filter)?;
    cd_core::log_analysis::query_event_neighborhood(&corpus, &query).map_err(|e| e.to_string())
}

#[tauri::command]
async fn log_query_event_neighborhood(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::EventNeighborhoodQuery,
) -> Result<cd_core::log_analysis::EventNeighborhood, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        query_log_event_neighborhood_at(&handles, &cache, &corpus_id, &query)
    })
    .await
    .map_err(|error| format!("log event neighborhood task join: {error}"))?
}

/// Facets under filters for explorer filter rail.
fn query_log_facets_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: &cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::LogFacets, String> {
    let mut query = query.clone();
    let corpus = open_log_corpus_with_lens(handles, cache, corpus_id, &mut query)?;
    cd_core::log_analysis::query_facets(&corpus, &query).map_err(|e| e.to_string())
}

#[tauri::command]
async fn log_facets(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::EventQuery,
) -> Result<cd_core::log_analysis::LogFacets, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || query_log_facets_at(&handles, &cache, &corpus_id, &query))
        .await
        .map_err(|error| format!("log facets task join: {error}"))?
}

fn query_log_source_catalog_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    query: &cd_core::log_analysis::LogSourceCatalogQuery,
) -> Result<cd_core::log_analysis::LogSourceCatalogPage, String> {
    let corpus = handles.open(cache, corpus_id)?;
    cd_core::log_analysis::query_source_catalog(&corpus, query).map_err(|e| e.to_string())
}

/// Dedicated, stable, paginated full-path source catalog for lane composition.
#[tauri::command]
async fn log_source_catalog(
    state: State<'_, AppState>,
    corpus_id: String,
    query: cd_core::log_analysis::LogSourceCatalogQuery,
) -> Result<cd_core::log_analysis::LogSourceCatalogPage, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        query_log_source_catalog_at(&handles, &cache, &corpus_id, &query)
    })
    .await
    .map_err(|error| format!("log source catalog task join: {error}"))?
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
    let mut q = cd_core::log_analysis::EventSearchQuery {
        query: args.query,
        semantic,
        k: args.k.unwrap_or(50) as usize,
        filter: args.filter.unwrap_or_default(),
        match_mode: mode,
        case_sensitive: args.case_sensitive.unwrap_or(false),
    };
    let corpus_id = args.corpus_id;
    let cancel_for_job = cancel.clone();
    let handles = Arc::clone(&state.log_corpus_handles);
    let result = tokio::task::spawn_blocking(move || {
        // Find is a lensed surface too: without this, a stale renderer could
        // hide a search hit the durable policy no longer suppresses.
        let corpus = open_log_corpus_with_lens(&handles, &cache, &corpus_id, &mut q.filter)?;
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogProposeNoiseCandidatesArgs {
    corpus_id: String,
    max_candidates: Option<usize>,
    max_representatives: Option<usize>,
}

fn propose_log_noise_candidates_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    args: LogProposeNoiseCandidatesArgs,
) -> Result<cd_core::log_analysis::NoiseCandidateReport, String> {
    let corpus = handles.open(cache, &args.corpus_id)?;
    cd_core::log_analysis::propose_noise_candidates(
        &corpus,
        &cd_core::log_analysis::NoiseCandidateOptions {
            max_candidates: args
                .max_candidates
                .unwrap_or(cd_core::log_analysis::DEFAULT_NOISE_CANDIDATE_CAP),
            max_representatives: args
                .max_representatives
                .unwrap_or(cd_core::log_analysis::DEFAULT_NOISE_REPRESENTATIVE_CAP),
            include_already_suppressed: false,
        },
    )
    .map_err(|error| error.to_string())
}

/// Propose bounded exact-template suppression candidates for human review.
///
/// This command is read-only. It cannot preview or activate a suppression rule.
#[tauri::command]
async fn log_propose_noise_candidates(
    state: State<'_, AppState>,
    args: LogProposeNoiseCandidatesArgs,
) -> Result<cd_core::log_analysis::NoiseCandidateReport, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || propose_log_noise_candidates_at(&handles, &cache, args))
        .await
        .map_err(|error| format!("log noise candidate task join: {error}"))?
}

fn load_log_suppression_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
) -> Result<cd_core::log_analysis::SuppressionDocument, String> {
    let corpus = handles.open(cache, corpus_id)?;
    cd_core::log_analysis::load_suppression_document(&corpus).map_err(|error| error.to_string())
}

/// Load the durable exact-template suppression policy for one corpus.
#[tauri::command]
async fn log_load_suppression(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<cd_core::log_analysis::SuppressionDocument, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || load_log_suppression_at(&handles, &cache, &corpus_id))
        .await
        .map_err(|error| format!("log suppression load task join: {error}"))?
}

fn log_suppression_lens_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
) -> Result<cd_core::log_analysis::TrustedSuppressionLens, String> {
    let corpus = handles.open(cache, corpus_id)?;
    Ok((*cd_core::log_analysis::trusted_suppression_lens(&corpus)).clone())
}

/// The exact exclusion set the host will honour for this corpus (#819).
///
/// The renderer asks for this instead of deriving exclusions from the policy
/// document itself, so its disclosure ("N rules · M excluded") describes what
/// the host actually enforces. Requesting these ids back is still only a
/// request — enforcement re-derives the trusted set on every query — so this is
/// disclosure, not a capability token.
#[tauri::command]
async fn log_suppression_lens(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<cd_core::log_analysis::TrustedSuppressionLens, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || log_suppression_lens_at(&handles, &cache, &corpus_id))
        .await
        .map_err(|error| format!("log suppression lens task join: {error}"))?
}

fn log_suppression_diagnostic_snapshot_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
) -> Result<cd_core::log_analysis::SuppressionDiagnosticSnapshot, String> {
    let corpus = handles.open(cache, corpus_id)?;
    cd_core::log_analysis::suppression_diagnostic_snapshot(&corpus).map_err(|e| e.to_string())
}

/// Authoritative, bounded, payload-free suppression evidence for a diagnostic
/// export (#819).
///
/// The renderer must never author policy revisions, resolutions, or counts.
/// This opens the real corpus and derives every field from trusted core, so a
/// stale or forged renderer snapshot cannot be exported as evidence.
#[tauri::command]
async fn log_suppression_diagnostic_snapshot(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<cd_core::log_analysis::SuppressionDiagnosticSnapshot, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        log_suppression_diagnostic_snapshot_at(&handles, &cache, &corpus_id)
    })
    .await
    .map_err(|error| format!("log suppression diagnostic task join: {error}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogPreviewTemplateSuppressionArgs {
    corpus_id: String,
    expected_revision: u64,
    name: String,
    rationale: String,
    template_id: u64,
}

fn preview_log_template_suppression_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    args: LogPreviewTemplateSuppressionArgs,
) -> Result<cd_core::log_analysis::SuppressionPreview, String> {
    let corpus = handles.open(cache, &args.corpus_id)?;
    cd_core::log_analysis::preview_template_suppression(
        &corpus,
        args.expected_revision,
        cd_core::log_analysis::NewSuppressionPreview {
            name: args.name,
            rationale: args.rationale,
            template_id: args.template_id,
            // This IPC represents an explicit person action. Detector/model
            // proposals require a separate review path and cannot impersonate it.
            origin: cd_core::log_analysis::SuppressionRuleOrigin::Human,
        },
    )
    .map_err(|error| error.to_string())
}

/// Compute and persist a trusted-core preview. The webview supplies no counts,
/// representative rows, or template fingerprint.
#[tauri::command]
async fn log_preview_template_suppression(
    state: State<'_, AppState>,
    args: LogPreviewTemplateSuppressionArgs,
) -> Result<cd_core::log_analysis::SuppressionPreview, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || preview_log_template_suppression_at(&handles, &cache, args))
        .await
        .map_err(|error| format!("log suppression preview task join: {error}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogActivateTemplateSuppressionArgs {
    corpus_id: String,
    expected_revision: u64,
    preview_token: String,
}

fn activate_log_template_suppression_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    args: LogActivateTemplateSuppressionArgs,
) -> Result<cd_core::log_analysis::SuppressionMutationResult, String> {
    let corpus = handles.open(cache, &args.corpus_id)?;
    let result = cd_core::log_analysis::activate_template_suppression(
        &corpus,
        args.expected_revision,
        cd_core::log_analysis::ActivateSuppressionPreview {
            preview_token: args.preview_token,
        },
    )
    .map_err(|error| error.to_string());
    // Drop the cached lens whether or not activation succeeded: a failure can
    // still have been preceded by another writer publishing a new sidecar.
    cd_core::log_analysis::invalidate_trusted_suppression_lens(&corpus);
    result
}

/// Activate one current human-authored preview.
#[tauri::command]
async fn log_activate_template_suppression(
    state: State<'_, AppState>,
    args: LogActivateTemplateSuppressionArgs,
) -> Result<cd_core::log_analysis::SuppressionMutationResult, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        activate_log_template_suppression_at(&handles, &cache, args)
    })
    .await
    .map_err(|error| format!("log suppression activation task join: {error}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogMutateTemplateSuppressionRuleArgs {
    corpus_id: String,
    expected_revision: u64,
    rule_id: String,
    mutation: cd_core::log_analysis::SuppressionRuleMutation,
}

fn mutate_log_template_suppression_rule_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    args: LogMutateTemplateSuppressionRuleArgs,
) -> Result<cd_core::log_analysis::SuppressionMutationResult, String> {
    let corpus = handles.open(cache, &args.corpus_id)?;
    let result = cd_core::log_analysis::mutate_template_suppression_rule(
        &corpus,
        args.expected_revision,
        &args.rule_id,
        args.mutation,
    )
    .map_err(|error| error.to_string());
    // Disabling or removing a rule must stop hiding its events on the very next
    // query, not once the sidecar's observed identity happens to be rechecked.
    cd_core::log_analysis::invalidate_trusted_suppression_lens(&corpus);
    result
}

/// Disable, re-enable, or tombstone one durable suppression rule.
#[tauri::command]
async fn log_mutate_template_suppression_rule(
    state: State<'_, AppState>,
    args: LogMutateTemplateSuppressionRuleArgs,
) -> Result<cd_core::log_analysis::SuppressionMutationResult, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        mutate_log_template_suppression_rule_at(&handles, &cache, args)
    })
    .await
    .map_err(|error| format!("log suppression mutation task join: {error}"))?
}

/// List bookmarks for a corpus.
fn list_log_bookmarks_at(
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
) -> Result<Vec<cd_core::log_analysis::ResolvedBookmark>, String> {
    let corpus = handles.open(cache, corpus_id)?;
    cd_core::log_analysis::list_resolved_bookmarks(&corpus).map_err(|e| e.to_string())
}

#[tauri::command]
async fn log_list_bookmarks(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<Vec<cd_core::log_analysis::ResolvedBookmark>, String> {
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || list_log_bookmarks_at(&handles, &cache, &corpus_id))
        .await
        .map_err(|error| format!("log bookmarks task join: {error}"))?
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
fn load_active_log_investigation_at(
    store: &cd_core::investigations::InvestigationStore,
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
) -> Result<Option<cd_core::investigations::ResolvedInvestigationDocument>, String> {
    let Some(summary) = active_investigation_for_corpus(store, corpus_id)? else {
        return Ok(None);
    };
    let corpus = handles.open(cache, corpus_id)?;
    store
        .load_with_policy_lens(&summary.id, &corpus, noise_lens)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn log_load_active_investigation(
    state: State<'_, AppState>,
    corpus_id: String,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
) -> Result<Option<cd_core::investigations::ResolvedInvestigationDocument>, String> {
    let store = investigation_store(&state)?;
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    tokio::task::spawn_blocking(move || {
        load_active_log_investigation_at(&store, &handles, &cache, &corpus_id, noise_lens)
    })
    .await
    .map_err(|error| format!("log investigation task join: {error}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogAddInvestigationEvidenceArgs {
    corpus_id: String,
    investigation_id: Option<String>,
    expected_revision: Option<u64>,
    title: String,
    event_refs: Vec<cd_core::log_analysis::BookmarkEventRef>,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogPrepareInvestigationEvidenceArgs {
    corpus_id: String,
    title: String,
    event_refs: Vec<cd_core::log_analysis::BookmarkEventRef>,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedInvestigationEvidenceTarget {
    commit_token: String,
    investigation_id: Option<String>,
    expected_revision: Option<u64>,
    creates_draft: bool,
}

/// Bind exact evidence payload and exact existing-or-new target to one host token.
/// This is read-only with respect to durable investigation storage.
#[tauri::command]
fn log_prepare_investigation_evidence(
    state: State<'_, AppState>,
    args: LogPrepareInvestigationEvidenceArgs,
) -> Result<PreparedInvestigationEvidenceTarget, String> {
    if args.event_refs.is_empty()
        || args.event_refs.len() > cd_core::log_analysis::MAX_BOOKMARK_EVENT_REFS
    {
        return Err("Investigation evidence selection is empty or too large".into());
    }
    if args.title.trim().is_empty()
        || args.title.len() > cd_core::investigations::MAX_INVESTIGATION_TITLE_BYTES
    {
        return Err("Investigation evidence title is empty or too large".into());
    }
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus = cd_core::log_analysis::LogCorpus::open(&cache, &args.corpus_id)
        .map_err(|e| e.to_string())?;
    let store = investigation_store(&state)?;
    let target = if let Some(summary) = active_investigation_for_corpus(&store, corpus.id())? {
        PendingInvestigationTarget::Existing {
            id: summary.id,
            expected_revision: summary.revision,
        }
    } else {
        PendingInvestigationTarget::CreateNew
    };
    let response_target = target.clone();
    let pending = PendingInvestigationEvidence {
        corpus_id: args.corpus_id,
        title: args.title,
        event_refs: args.event_refs,
        noise_lens: args.noise_lens,
        target,
    };
    let commit_token = state
        .pending_investigation_evidence
        .lock()
        .map_err(|_| "Investigation preparation is temporarily unavailable".to_string())?
        .insert(pending);
    let (investigation_id, expected_revision, creates_draft) = match response_target {
        PendingInvestigationTarget::Existing {
            id,
            expected_revision,
        } => (Some(id), Some(expected_revision), false),
        PendingInvestigationTarget::CreateNew => (None, None, true),
    };
    Ok(PreparedInvestigationEvidenceTarget {
        commit_token,
        investigation_id,
        expected_revision,
        creates_draft,
    })
}

/// Consume a prepared token exactly once. The renderer cannot substitute
/// another corpus, target, title, or event reference at commit time.
#[tauri::command]
fn log_commit_investigation_evidence(
    state: State<'_, AppState>,
    commit_token: String,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    if commit_token.len() > 128 {
        return Err("Invalid investigation evidence commit token".into());
    }
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let pending = state
        .pending_investigation_evidence
        .lock()
        .map_err(|_| "Investigation preparation is temporarily unavailable".to_string())?
        .take(&commit_token)
        .ok_or_else(|| {
            "Unknown, expired, or already-used investigation evidence token".to_string()
        })?;
    let cache = log_cache_dir(&state)?;
    let corpus = cd_core::log_analysis::LogCorpus::open(&cache, &pending.corpus_id)
        .map_err(|e| e.to_string())?;
    let store = investigation_store(&state)?;
    let (investigation_id, expected_revision) = match pending.target {
        PendingInvestigationTarget::Existing {
            id,
            expected_revision,
        } => (id, expected_revision),
        PendingInvestigationTarget::CreateNew => {
            let created = store
                .create(format!("Investigation · {}", corpus.name()), &corpus)
                .map_err(|e| e.to_string())?;
            (created.id, created.revision)
        }
    };
    let updated = store
        .add_exact_evidence(
            &investigation_id,
            expected_revision,
            pending.title,
            &corpus,
            pending.event_refs,
        )
        .map_err(|e| e.to_string())?;
    store
        .load_with_policy_lens(&updated.document.id, &corpus, pending.noise_lens)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn log_cancel_investigation_evidence_prepare(
    state: State<'_, AppState>,
    commit_token: String,
) -> Result<bool, String> {
    if commit_token.len() > 128 {
        return Ok(false);
    }
    state
        .pending_investigation_evidence
        .lock()
        .map_err(|_| "Investigation preparation is temporarily unavailable".to_string())
        .map(|mut pending| pending.remove(&commit_token))
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

    let updated = store
        .add_exact_evidence(
            &investigation_id,
            expected_revision,
            args.title,
            &corpus,
            args.event_refs,
        )
        .map_err(|e| e.to_string())?;
    store
        .load_with_policy_lens(&updated.document.id, &corpus, args.noise_lens)
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
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
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

    let binding =
        cd_core::investigations::InvestigationPolicyBinding::capture(&corpus, args.noise_lens)
            .map_err(|e| e.to_string())?;
    store
        .add_human_finding_bound(
            &investigation_id,
            expected_revision,
            &corpus,
            binding,
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
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
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

    let updated = store
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
        .map_err(|e| e.to_string())?;
    store
        .load_with_policy_lens(&updated.document.id, &corpus, args.noise_lens)
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
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
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
    let store = investigation_store(&state)?;
    let updated = store
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
        .map_err(|e| e.to_string())?;
    store
        .load_with_policy_lens(&updated.document.id, &corpus, args.noise_lens)
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
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
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
    let store = investigation_store(&state)?;
    let updated = store
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
        .map_err(|e| e.to_string())?;
    store
        .load_with_policy_lens(&updated.document.id, &corpus, args.noise_lens)
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
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
) -> Result<cd_core::investigations::FindingViewRecipeResolution, String> {
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .resolve_finding_view_recipe_with_policy_lens(
            &investigation_id,
            &finding_id,
            &corpus,
            noise_lens,
        )
        .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogRecomputeInvestigationFindingViewArgs {
    corpus_id: String,
    investigation_id: String,
    expected_revision: u64,
    finding_id: String,
    view_recipe: cd_core::investigations::FindingViewRecipe,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
}

/// Explicitly replace one saved finding view under the exact current policy.
#[tauri::command]
fn log_recompute_investigation_finding_view(
    state: State<'_, AppState>,
    args: LogRecomputeInvestigationFindingViewArgs,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus = cd_core::log_analysis::LogCorpus::open(&cache, &args.corpus_id)
        .map_err(|e| e.to_string())?;
    let binding =
        cd_core::investigations::InvestigationPolicyBinding::capture(&corpus, args.noise_lens)
            .map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .recompute_human_finding_view(
            &args.investigation_id,
            args.expected_revision,
            &corpus,
            binding,
            &args.finding_id,
            args.view_recipe,
        )
        .map_err(|e| e.to_string())
}

/// SoftWrite-path Apply gate for a finding view recipe (#656).
///
/// Opens the corpus through the shared handle cache (same authority path as
/// Explorer load), then revalidates every exact reference. Returns the durable
/// recipe only when every reference is verified; missing/stale refs fail closed.
/// Does not mutate the Investigation document — the UI applies the returned
/// recipe locally on success only.
fn apply_log_investigation_finding_view_at(
    store: &cd_core::investigations::InvestigationStore,
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    investigation_id: &str,
    finding_id: &str,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
) -> Result<cd_core::investigations::FindingViewRecipeResolution, String> {
    let corpus = handles.open(cache, corpus_id)?;
    store
        .apply_finding_view_recipe(investigation_id, finding_id, &corpus, noise_lens)
        .map_err(|e| e.to_string())
}

/// Trusted-host Apply gate for a finding view recipe (#656).
///
/// Revalidates every exact reference. Returns the recipe only when every
/// reference is verified; missing/stale refs fail closed. Does not mutate
/// the Investigation document — the UI applies the returned recipe locally.
#[tauri::command]
fn log_apply_investigation_finding_view(
    state: State<'_, AppState>,
    corpus_id: String,
    investigation_id: String,
    finding_id: String,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
) -> Result<cd_core::investigations::FindingViewRecipeResolution, String> {
    let cache = log_cache_dir(&state)?;
    let store = investigation_store(&state)?;
    apply_log_investigation_finding_view_at(
        &store,
        &state.log_corpus_handles,
        &cache,
        &corpus_id,
        &investigation_id,
        &finding_id,
        noise_lens,
    )
}

/// Deterministic internal propose path (#646) — same validation as the tool.
#[tauri::command]
fn log_propose_investigation_finding(
    state: State<'_, AppState>,
    corpus_id: String,
    input: cd_core::investigations::ProposeFindingInput,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .propose_finding(&corpus, input)
        .map_err(|e| e.to_string())
}

/// Human Accept or Edit-and-accept of a Proposed finding (#646).
#[tauri::command]
fn log_accept_proposed_finding(
    state: State<'_, AppState>,
    corpus_id: String,
    investigation_id: String,
    input: cd_core::investigations::AcceptProposedFindingInput,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .accept_proposed_finding(&corpus, &investigation_id, input)
        .map_err(|e| e.to_string())
}

/// Human Dismiss-with-reason of a Proposed finding (#646).
#[tauri::command]
fn log_dismiss_proposed_finding(
    state: State<'_, AppState>,
    corpus_id: String,
    investigation_id: String,
    input: cd_core::investigations::DismissProposedFindingInput,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .dismiss_proposed_finding(&corpus, &investigation_id, input)
        .map_err(|e| e.to_string())
}

/// Create or replace one authored report section for its kind (#532).
#[tauri::command]
fn log_set_investigation_report_section(
    state: State<'_, AppState>,
    corpus_id: String,
    investigation_id: String,
    expected_revision: u64,
    input: cd_core::investigations::SetReportSectionInput,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .set_report_section(&investigation_id, expected_revision, &corpus, input)
        .map_err(|e| e.to_string())
}

// NOTE (#532 hardening): there is deliberately NO renderer-invocable propose
// command for report sections. Proposals enter only through the tool host's
// SoftWrite path, where provenance is host-authored, the target investigation
// is host-bound, and the permission gate applies. A renderer IPC propose
// surface would let a compromised webview forge model/detector provenance
// with none of those guarantees.

/// Human Accept or Edit-and-accept of a Proposed report section (#532).
#[tauri::command]
fn log_accept_proposed_report_section(
    state: State<'_, AppState>,
    corpus_id: String,
    investigation_id: String,
    input: cd_core::investigations::AcceptProposedReportSectionInput,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .accept_proposed_report_section(&corpus, &investigation_id, input)
        .map_err(|e| e.to_string())
}

/// Human Dismiss-with-reason of a Proposed report section (#532).
#[tauri::command]
fn log_dismiss_proposed_report_section(
    state: State<'_, AppState>,
    corpus_id: String,
    investigation_id: String,
    input: cd_core::investigations::DismissProposedReportSectionInput,
) -> Result<cd_core::investigations::ResolvedInvestigationDocument, String> {
    let _mutation = state
        .investigation_mutation
        .lock()
        .map_err(|_| "Investigation storage is temporarily unavailable".to_string())?;
    let cache = log_cache_dir(&state)?;
    let corpus =
        cd_core::log_analysis::LogCorpus::open(&cache, &corpus_id).map_err(|e| e.to_string())?;
    investigation_store(&state)?
        .dismiss_proposed_report_section(&corpus, &investigation_id, input)
        .map_err(|e| e.to_string())
}

/// Assemble + render one investigation report projection (#532).
///
/// Strictly non-mutating: loads through the shared handle cache and the
/// standard resolution path and projects. The report's current-policy header
/// comes from the one snapshot the resolution captured — this helper never
/// performs a second policy read. Nothing durable changes; assembling twice
/// over the same revision yields identical output for the same
/// `generated_at`.
fn assemble_log_investigation_report_at(
    store: &cd_core::investigations::InvestigationStore,
    handles: &LogCorpusHandleCache,
    cache: &std::path::Path,
    corpus_id: &str,
    investigation_id: Option<String>,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
    generated_at: i64,
) -> Result<(cd_core::investigations::InvestigationReport, String), String> {
    let corpus = handles.open(cache, corpus_id)?;
    let investigation_id = match investigation_id {
        Some(id) => id,
        None => {
            active_investigation_for_corpus(store, corpus_id)?
                .ok_or_else(|| "No active Investigation is linked to this corpus".to_string())?
                .id
        }
    };
    let resolved = store
        .load_with_policy_lens(&investigation_id, &corpus, noise_lens)
        .map_err(|e| e.to_string())?;
    // One snapshot: the report header reuses the exact policy identity the
    // finding statuses were resolved under. Deliberately no second policy
    // sidecar read here — two reads could disagree under a concurrent policy
    // edit and certify findings against the wrong policy.
    let report = cd_core::investigations::assemble_investigation_report(&resolved, generated_at);
    let markdown = cd_core::investigations::render_investigation_report_markdown(&report);
    Ok((report, markdown))
}

/// Host-assembled report preview: versioned projection + rendered markdown +
/// the retained export artifact for exactly these bytes.
///
/// One assembly drives everything the user sees and saves: the typed surface,
/// the exact markdown preview, and Export. `export_id` names the retained
/// copy of `markdown` in the bounded in-memory export store; when the render
/// cannot pass the export boundary (empty/oversized/unscrubbed), the preview
/// still shows and `export_unavailable_reason` says why Export is off.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogInvestigationReportPreview {
    report: cd_core::investigations::InvestigationReport,
    markdown: String,
    export_id: Option<String>,
    export_bytes: Option<usize>,
    export_unavailable_reason: Option<String>,
}

/// Preview the report for the active (or given) Investigation.
///
/// Nothing durable changes. The rendered bytes are retained in the bounded
/// in-memory export store under an opaque id so Export later writes exactly
/// the previewed bytes — there is no second assembly that could drift from
/// what the user reviewed.
#[tauri::command]
async fn log_assemble_investigation_report(
    state: State<'_, AppState>,
    corpus_id: String,
    investigation_id: Option<String>,
    noise_lens: cd_core::investigations::InvestigationNoiseLens,
) -> Result<LogInvestigationReportPreview, String> {
    let store = investigation_store(&state)?;
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    let generated_at = cd_core::embed::now_unix_secs();
    let (report, markdown) = tokio::task::spawn_blocking(move || {
        assemble_log_investigation_report_at(
            &store,
            &handles,
            &cache,
            &corpus_id,
            investigation_id,
            noise_lens,
            generated_at,
        )
    })
    .await
    .map_err(|error| format!("investigation report task join: {error}"))??;
    let (export_id, export_bytes, export_unavailable_reason) = match state
        .investigation_report_exports
        .lock()
        .map_err(|_| "investigation report export store is unavailable".to_string())?
        .prepare(markdown.clone())
    {
        Ok(prepared) => (Some(prepared.report_id), Some(prepared.bytes), None),
        // The preview must still render; Export is off with the exact reason.
        Err(reason) => (None, None, Some(reason)),
    };
    Ok(LogInvestigationReportPreview {
        report,
        markdown,
        export_id,
        export_bytes,
        export_unavailable_reason,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogInvestigationReportExportRequest {
    report_id: String,
}

// NOTE (#532 hardening): there is deliberately NO separate export-prepare
// command. A second assembly could drift from the preview the user reviewed
// (fresh generated_at, or state that moved underneath), so the artifact
// Export writes is registered by log_assemble_investigation_report itself —
// preview bytes and saved bytes are the same retained copy.

fn complete_investigation_report_export_content(
    content: &str,
    selected_path: Option<PathBuf>,
) -> Result<LogDiagnosticSaveStatus, String> {
    let Some(path) = selected_path else {
        return Ok(LogDiagnosticSaveStatus::Cancelled);
    };
    let outcome =
        investigation_report_export::save_investigation_report_at_host_path(&path, content)?;
    Ok(log_diagnostic_save_status(outcome))
}

/// Show the host-owned native Save panel for one investigation report and
/// atomically write the exact previewed bytes. The renderer has no
/// destination or overwrite authority.
#[tauri::command]
async fn log_save_investigation_report_export(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    request: LogInvestigationReportExportRequest,
) -> Result<LogDiagnosticSaveStatus, String> {
    let content = {
        let reports = state
            .investigation_report_exports
            .lock()
            .map_err(|_| "investigation report export store is unavailable".to_string())?;
        reports.content(&request.report_id)?.to_string()
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Save investigation report as Markdown")
        .set_file_name("contextdesk-investigation-report.md")
        .add_filter("Markdown", &["md"])
        .save_file(move |selected| {
            let _ = sender.send(selected);
        });
    let selected = receiver
        .await
        .map_err(|_| "native report Save dialog ended unexpectedly".to_string())?
        .map(|path| {
            path.into_path()
                .map_err(|_| "native report Save dialog returned an invalid path".to_string())
        })
        .transpose()?;
    complete_investigation_report_export_content(&content, selected)
}

/// Release one process-local report preview when the renderer replaces or
/// closes it. Unknown/expired ids are harmless; malformed ids fail closed.
#[tauri::command]
fn log_release_investigation_report_export(
    state: State<'_, AppState>,
    request: LogInvestigationReportExportRequest,
) -> Result<bool, String> {
    state
        .investigation_report_exports
        .lock()
        .map_err(|_| "investigation report export store is unavailable".to_string())?
        .release(&request.report_id)
}

// ─── Logging Quality Assessment (deterministic host adapter) ─────────────────

/// Run the pure `cd-core` assessor for one imported corpus.
///
/// Returns the shared assessment DTO plus an opaque-key → portable source map
/// for Explorer bridging. Does not write files. Does not call providers.
#[tauri::command]
async fn log_assess_logging_quality(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<logging_quality_host::LoggingQualityAssessmentHostDto, String> {
    let cache = log_cache_dir(&state)?;
    let id = corpus_id.trim().to_string();
    if id.is_empty() {
        return Err("No corpus selected. Import or open a log corpus first.".into());
    }
    tokio::task::spawn_blocking(move || logging_quality_host::assess_at_cache(&cache, &id))
        .await
        .map_err(|e| format!("logging quality assessment task join: {e}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LogLoggingQualityExportRequest {
    corpus_id: String,
    /// `json` or `markdown`.
    format: String,
}

/// Host-owned Save panel + atomic no-clobber export via `cd-workflow`.
///
/// Destination path never enters the webview. Re-assesses (deterministic) so
/// export bytes match current durable corpus state.
#[tauri::command]
async fn log_export_logging_quality_assessment(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    request: LogLoggingQualityExportRequest,
) -> Result<logging_quality_host::LoggingQualityExportStatus, String> {
    let corpus_id = request.corpus_id.trim().to_string();
    if corpus_id.is_empty() {
        return Err("No corpus selected. Import or open a log corpus first.".into());
    }
    let format = logging_quality_host::parse_report_format(&request.format)?;
    let cache = log_cache_dir(&state)?;
    let file_name = logging_quality_host::default_export_file_name(format);
    let (title, filter_name, extension) = match format {
        cd_workflow::logging_quality::LoggingQualityReportFormat::Json => {
            ("Save logging quality assessment as JSON", "JSON", "json")
        }
        cd_workflow::logging_quality::LoggingQualityReportFormat::Markdown => (
            "Save logging quality assessment as Markdown",
            "Markdown",
            "md",
        ),
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title)
        .set_file_name(file_name)
        .add_filter(filter_name, &[extension])
        .save_file(move |selected| {
            let _ = sender.send(selected);
        });
    let selected = receiver
        .await
        .map_err(|_| "native logging-quality Save dialog ended unexpectedly".to_string())?
        .map(|path| {
            path.into_path().map_err(|_| {
                "native logging-quality Save dialog returned an invalid path".to_string()
            })
        })
        .transpose()?;
    let Some(path) = selected else {
        return Ok(logging_quality_host::LoggingQualityExportStatus::Cancelled);
    };
    let cache_for_write = cache.clone();
    let corpus_for_write = corpus_id.clone();
    match tokio::task::spawn_blocking(move || {
        logging_quality_host::export_at_path(&cache_for_write, &corpus_for_write, &path, format)
    })
    .await
    .map_err(|e| format!("logging quality export task join: {e}"))?
    {
        Ok(status) => Ok(status),
        Err(reason) => Ok(logging_quality_host::LoggingQualityExportStatus::Failed { reason }),
    }
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
    let previous_corpus_id = session.linked_corpus_id.clone();
    let corpus_id = normalize_log_corpus_id(corpus_id);
    if let Some(corpus_id) = corpus_id.as_deref() {
        // Validate before mutating or saving. A failed attach leaves both an
        // existing durable chat and a new empty draft unchanged.
        validate_linked_log_corpus_at(cache, corpus_id)?;
    }
    session.set_linked_corpus_id(corpus_id);
    if session.linked_corpus_id != previous_corpus_id {
        // An envelope binds an exact corpus/revision. It remains readable
        // only while that binding is current; a relink makes it unavailable
        // instead of treating old transcript JSON as fresh evidence.
        clear_host_investigation_answer_metadata(&mut session);
    }
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
    let session = set_chat_linked_corpus_at(
        &store,
        &cache,
        &session_id,
        corpus_id,
        draft_session,
        expected_updated_at,
    )?;
    state
        .linked_synthesis_checkpoints
        .lock()
        .expect("linked synthesis checkpoints")
        .remove(&session_id);
    Ok(session)
}

/// Build the SPA URL for a Log Explorer window.
///
/// In **dev**, secondary windows must hit the Vite `devUrl` (External) — `WebviewUrl::App`
/// loads a blank white page because there is no packaged asset protocol for the query
/// route. In **release**, load packaged `index.html` with the same query string.
fn log_explorer_webview_url(
    app: &tauri::AppHandle,
    corpus_id: &str,
    corpus_name: &str,
) -> Result<tauri::WebviewUrl, String> {
    // Encode corpus id for query (UUIDs are safe; keep general). The display
    // name rides along so the renderer can set document.title without a host
    // round-trip (#641 boundary ratchet: main.tsx must not import lib/host).
    let corpus_q = urlencoding_encode(corpus_id);
    let name_q = urlencoding_encode(corpus_name);
    let query = format!("window=log-explorer&corpus={corpus_q}&name={name_q}");

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
    let handles = Arc::clone(&state.log_corpus_handles);
    let open_corpus_id = corpus_id.clone();
    let corpus_name = tokio::task::spawn_blocking(move || handles.open(&cache, &open_corpus_id))
        .await
        .map_err(|error| format!("open log explorer corpus task join: {error}"))??
        .name()
        .to_string();
    let title = log_explorer_window_title(&corpus_name);
    // Set active corpus so agent tools resolve without id.
    set_active_log_corpus_state_nonblocking(&state, Some(corpus_id.clone()));
    let label = log_explorer_window_label(&corpus_id);
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        let _ = w.unminimize();
        return Ok(label);
    }

    let url = log_explorer_webview_url(&app, &corpus_id, &corpus_name)?;
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

/// Host-governed exact navigation into a corpus Explorer (#698).
///
/// Validates the corpus and target, stages a one-shot pending target, opens or
/// focuses exactly that corpus's Explorer, and never substitutes another corpus.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenLogExplorerTargetResult {
    window_label: String,
    corpus_id: String,
    target: LogExplorerNavTarget,
}

#[tauri::command]
async fn open_log_explorer_target(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    corpus_id: String,
    target: LogExplorerNavTarget,
) -> Result<OpenLogExplorerTargetResult, String> {
    let corpus_id = corpus_id.trim().to_string();
    if corpus_id.is_empty() {
        return Err("corpus id is required for exact log navigation".into());
    }
    let parsed = parse_log_explorer_nav_target(&target.kind, &target.id)?;
    let staged = LogExplorerNavTarget {
        kind: parsed.kind.as_str().to_string(),
        id: parsed.id.clone(),
    };

    // Validate corpus + evidence before staging or opening a window.
    let cache = log_cache_dir(&state)?;
    let handles = Arc::clone(&state.log_corpus_handles);
    let open_corpus_id = corpus_id.clone();
    let evidence_id = parsed.clone();
    let corpus_name = tokio::task::spawn_blocking(move || {
        let corpus = handles.open(&cache, &open_corpus_id)?;
        ensure_log_nav_evidence_exists(&corpus, &evidence_id)?;
        Ok::<_, String>(corpus.name().to_string())
    })
    .await
    .map_err(|error| format!("open log explorer target task join: {error}"))??;

    let title = log_explorer_window_title(&corpus_name);
    set_active_log_corpus_state_nonblocking(&state, Some(corpus_id.clone()));
    let label = log_explorer_window_label(&corpus_id);
    use tauri::Emitter;
    use tauri::Manager;

    // Existing window: stage only after we know the window is reachable, then
    // emit so take() delivers once.
    if let Some(w) = app.get_webview_window(&label) {
        stage_log_explorer_nav_target(&state, &corpus_id, staged.clone())?;
        let _ = w.set_focus();
        let _ = w.unminimize();
        let _ = w.emit(LOG_EXPLORER_NAV_TARGET_EVENT, staged.clone());
        return Ok(OpenLogExplorerTargetResult {
            window_label: label,
            corpus_id,
            target: staged,
        });
    }

    // New window: resolve URL *before* staging so a URL failure never leaves a
    // pending target for a later generic open to take (stale replay).
    let url = log_explorer_webview_url(&app, &corpus_id, &corpus_name)?;
    stage_log_explorer_nav_target(&state, &corpus_id, staged.clone())?;
    if let Err(error) = tauri::WebviewWindowBuilder::new(&app, &label, url)
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
    {
        // Window never opened — clear the staged target so a later Explorer
        // open for this corpus cannot take a failed citation.
        clear_log_explorer_nav_target(&state, &corpus_id);
        return Err(format!("open log explorer window: {error}"));
    }
    // Fresh window will take the pending target on mount (no emit required).
    Ok(OpenLogExplorerTargetResult {
        window_label: label,
        corpus_id,
        target: staged,
    })
}

/// Stage a one-shot exact-nav target (last writer wins for the corpus).
fn stage_log_explorer_nav_target(
    state: &AppState,
    corpus_id: &str,
    target: LogExplorerNavTarget,
) -> Result<(), String> {
    let mut store = state
        .log_explorer_nav_targets
        .lock()
        .map_err(|_| "log explorer nav target store poisoned".to_string())?;
    store.set(corpus_id.to_string(), target);
    Ok(())
}

/// Clear any undelivered exact-nav target for a corpus (failed open path).
fn clear_log_explorer_nav_target(state: &AppState, corpus_id: &str) {
    if let Ok(mut store) = state.log_explorer_nav_targets.lock() {
        store.clear(corpus_id);
    }
}

/// Deliver and clear the one-shot exact-nav target for this corpus's Explorer.
///
/// Returns `None` when nothing is pending (already delivered, cleared on close,
/// or never staged). Safe to call repeatedly — never replays a prior target.
#[tauri::command]
fn take_log_explorer_nav_target(
    state: State<'_, AppState>,
    corpus_id: String,
) -> Result<Option<LogExplorerNavTarget>, String> {
    let corpus_id = corpus_id.trim().to_string();
    if corpus_id.is_empty() {
        return Err("corpus id is required".into());
    }
    let mut store = state
        .log_explorer_nav_targets
        .lock()
        .map_err(|_| "log explorer nav target store poisoned".to_string())?;
    Ok(store.take(&corpus_id))
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
    let qualification_store_path = cd_core::capability_qualification::qualification_store_path(
        path.parent().expect("config directory"),
    );
    let qualification_store =
        cd_core::capability_qualification::load_qualification_store(&qualification_store_path)
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "qualification evidence could not be loaded");
                cd_core::capability_qualification::QualificationStore::default()
            });

    let state = AppState {
        branding,
        config: Mutex::new(config),
        secrets: ReferencedSecretStore::new(),
        audit_log,
        histories: Mutex::new(HashMap::new()),
        host: Arc::new(Mutex::new(None)),
        host_init: HostInitFlight::default(),
        host_generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        active_log_corpus: Mutex::new(None),
        log_corpus_handles: Arc::new(LogCorpusHandleCache::default()),
        failed_log_ingest_diagnostic: Mutex::new(
            cd_core::log_analysis::FailedIngestDiagnosticStore::default(),
        ),
        demo_log_install: tokio::sync::Mutex::new(()),
        log_diagnostic_reports: Mutex::new(
            log_diagnostic_report::LogDiagnosticReportStore::default(),
        ),
        investigation_report_exports: Mutex::new(
            investigation_report_export::InvestigationReportExportStore::default(),
        ),
        chat_session_mutation: Mutex::new(()),
        investigation_mutation: Mutex::new(()),
        // Activity remains process-lifetime only until the durable format has
        // closed privacy, global-retention, Windows replacement, and
        // multi-process writer review. Do not hydrate sidecars at startup.
        activity: Mutex::new(cd_core::activity::ActivityStore::default()),
        developer_activity: Mutex::new(cd_core::turn_trace::DeveloperDetailStore::default()),
        developer_activity_suppressed: Mutex::new(HashMap::new()),
        pending_investigation_evidence: Mutex::new(PendingInvestigationEvidenceStore::default()),
        cancels: Mutex::new(HashMap::new()),
        active_turn_owners: Mutex::new(HashMap::new()),
        next_turn_owner: std::sync::atomic::AtomicU64::new(0),
        linked_synthesis_checkpoints: Mutex::new(LinkedCheckpointStore::default()),
        backup_cancel: Mutex::new(None),
        index_watch: Mutex::new(None),
        index_status: Arc::new(Mutex::new(cd_core::index::IndexStatus {
            phase: cd_core::index::IndexPhase::Idle,
            message: "Index not started".into(),
            ..Default::default()
        })),
        help: Mutex::new(None),
        handbook: Mutex::new(None),
        qualification_store: Mutex::new(qualification_store),
        qualification_store_path,
        log_explorer_nav_targets: Mutex::new(LogExplorerNavTargetStore::default()),
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Opt-in signed updates (#173). Check/install only via Settings — never silent.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(state)
        .on_window_event(|window, event| {
            // Close/destroy clears undelivered exact-nav targets so reopen never
            // replays a stale citation reveal.
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_string();
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(mut store) = state.log_explorer_nav_targets.lock() {
                        store.clear_for_window_label(&label);
                    }
                }
            }
        })
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
            get_multi_model_settings,
            set_multi_model_mode,
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
            get_capability_qualification,
            start_capability_qualification,
            cancel_capability_qualification,
            clear_capability_qualification,
            get_active_provider,
            get_turn_activity,
            get_developer_turn_activity,
            forget_session_activity,
            suppress_developer_activity_detail,
            set_provider_tools_enabled,
            set_model_tools_enabled,
            get_curation_summary,
            preview_curation_change,
            set_model_hidden,
            set_provider_hidden,
            set_model_pinned,
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
            install_demo_log_corpus,
            cancel_log_ingest,
            get_failed_log_ingest_diagnostic,
            clear_failed_log_ingest_diagnostic,
            reanalyze_log_corpus,
            cancel_log_reanalysis,
            log_cluster_problems,
            log_timeline,
            log_search,
            discard_log_corpus,
            log_load_timezone_state,
            log_preview_import,
            log_run_import,
            log_apply_source_timezones,
            log_undo_event_revision,
            log_preview_source_timezone,
            log_apply_source_timezone,
            log_clear_source_timezone,
            log_save_operational_metrics_attachment,
            log_load_operational_metrics_attachment,
            log_remove_operational_metrics_attachment,
            set_active_log_corpus,
            get_active_log_corpus,
            log_query_events,
            log_query_event_rows,
            log_count_events,
            log_query_event_original,
            log_timeline_summary,
            log_shared_timeline_summary,
            log_query_event_neighborhood,
            log_facets,
            log_source_catalog,
            log_search_events,
            cancel_log_search,
            log_propose_noise_candidates,
            log_load_suppression,
            log_suppression_lens,
            log_suppression_diagnostic_snapshot,
            log_preview_template_suppression,
            log_activate_template_suppression,
            log_mutate_template_suppression_rule,
            log_list_bookmarks,
            log_add_bookmark,
            log_delete_bookmark,
            log_load_active_investigation,
            log_prepare_investigation_evidence,
            log_commit_investigation_evidence,
            log_cancel_investigation_evidence_prepare,
            log_add_investigation_evidence,
            log_add_investigation_finding,
            log_add_investigation_note,
            log_edit_investigation_finding,
            log_edit_investigation_note,
            log_preview_investigation_evidence,
            log_preview_investigation_finding_view,
            log_recompute_investigation_finding_view,
            log_apply_investigation_finding_view,
            log_propose_investigation_finding,
            log_accept_proposed_finding,
            log_dismiss_proposed_finding,
            log_set_investigation_report_section,
            log_accept_proposed_report_section,
            log_dismiss_proposed_report_section,
            log_assemble_investigation_report,
            log_save_investigation_report_export,
            log_release_investigation_report_export,
            log_assess_logging_quality,
            log_export_logging_quality_assessment,
            list_chat_sessions_for_corpus,
            set_chat_linked_corpus,
            open_log_explorer,
            open_log_explorer_target,
            take_log_explorer_nav_target,
            export_log_corpus_package,
            prepare_log_diagnostic_report,
            release_log_diagnostic_report,
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
mod log_diagnostic_export_authority_tests {
    use super::*;

    fn prepared_request() -> (
        log_diagnostic_report::LogDiagnosticReportStore,
        LogDiagnosticExportRequest,
        String,
    ) {
        let manifest = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "generatedAt": "2026-07-29T12:34:56.000Z",
            "privacy": {
                "redacted": true,
                "reviewRequired": true,
                "excluded": []
            },
            "application": {
                "version": "0.1.0",
                "channel": "dev",
                "gitSha": "de43caeba66df05068a50db9356efad3b64a4a45",
                "os": "macOS"
            },
            "corpus": {
                "id": "019fab76-18ff-7361-8dd8-e4ddc0f1bb6c",
                "name": "Incident",
                "createdAt": 1700000000,
                "engine": "duckdb",
                "eventCount": 12,
                "templateCount": 3,
                "stats": null,
                "embedding": { "state": "keyword_only" }
            },
            "failedIngest": null,
            "activeView": null,
            "currentStatus": null,
            "userNote": null
        }))
        .expect("manifest");
        let mut reports = log_diagnostic_report::LogDiagnosticReportStore::default();
        let prepared = reports.prepare(manifest).expect("prepare report");
        let markdown = prepared.markdown;
        let request = LogDiagnosticExportRequest {
            format: "markdown".into(),
            report_id: prepared.report_id,
        };
        (reports, request, markdown)
    }

    #[test]
    fn ipc_request_rejects_renderer_content_destination_and_overwrite_authority() {
        for forbidden in [
            serde_json::json!({
                "format": "markdown",
                "reportId": "cdlogdiag-0000000000000001-0000000000000001",
                "content": "# Renderer-authored diagnostic"
            }),
            serde_json::json!({
                "format": "markdown",
                "reportId": "cdlogdiag-0000000000000001-0000000000000001",
                "path": "/tmp/renderer-selected.md"
            }),
            serde_json::json!({
                "format": "markdown",
                "reportId": "cdlogdiag-0000000000000001-0000000000000001",
                "overwriteConfirmed": true
            }),
        ] {
            let error = serde_json::from_value::<LogDiagnosticExportRequest>(forbidden)
                .expect_err("unknown renderer authority must fail closed");
            assert!(error.to_string().contains("unknown field"), "{error}");
        }
        serde_json::from_value::<LogDiagnosticExportRequest>(serde_json::json!({
            "format": "markdown",
            "reportId": "cdlogdiag-0000000000000001-0000000000000001"
        }))
        .expect("opaque report id and format are the complete renderer request");
    }

    #[test]
    fn host_dialog_cancellation_is_typed_and_writes_nothing() {
        let root = tempfile::tempdir().expect("temp root");
        let (reports, request, _) = prepared_request();
        let status = complete_log_diagnostic_export(&request, &reports, None)
            .expect("cancel is not an error");
        assert_eq!(status, LogDiagnosticSaveStatus::Cancelled);
        assert_eq!(
            serde_json::to_value(status).expect("serialize status"),
            serde_json::json!({ "status": "cancelled" })
        );
        assert_eq!(
            std::fs::read_dir(root.path())
                .expect("read temp root")
                .count(),
            0
        );
    }

    #[test]
    fn host_selected_path_returns_typed_saved_status() {
        let root = tempfile::tempdir().expect("temp root");
        let destination = root.path().join("diagnostic.md");
        let (reports, request, markdown) = prepared_request();
        let status = complete_log_diagnostic_export(&request, &reports, Some(destination.clone()))
            .expect("host-selected save");
        assert_eq!(status, LogDiagnosticSaveStatus::Saved);
        assert_eq!(
            serde_json::to_value(status).expect("serialize status"),
            serde_json::json!({ "status": "saved" })
        );
        assert_eq!(
            std::fs::read_to_string(destination).expect("read saved report"),
            markdown
        );
    }

    #[test]
    fn post_publication_failure_serializes_as_saved_with_warning() {
        let status = log_diagnostic_save_status(log_diagnostics::DiagnosticPublishOutcome {
            warning: Some("parent directory sync failed".into()),
        });
        assert_eq!(
            serde_json::to_value(status).expect("serialize warning status"),
            serde_json::json!({
                "status": "saved_with_warning",
                "warning": "parent directory sync failed"
            })
        );
    }
}

#[cfg(test)]
mod failed_log_ingest_diagnostic_lifecycle_tests {
    use super::*;

    fn fresh_failed_ingest_state() -> Mutex<cd_core::log_analysis::FailedIngestDiagnosticStore> {
        Mutex::new(cd_core::log_analysis::FailedIngestDiagnosticStore::default())
    }

    #[test]
    fn failed_ingest_diagnostics_are_process_memory_transient_across_fresh_state_construction() {
        let first_state = fresh_failed_ingest_state();
        let diagnostic = cd_core::log_analysis::FailedIngestDiagnosticRecorder::default().finish(
            "source read failed",
            cd_core::log_analysis::FailedIngestSourceKind::Directory,
            1_735_737_600,
        );
        {
            let mut store = first_state.lock().expect("first failed-ingest state");
            let attempt = store.begin_attempt();
            assert!(store.record_failure(attempt, diagnostic.clone()));
            assert_eq!(store.snapshot(), Some(diagnostic));
        }

        drop(first_state);

        let restarted_state = fresh_failed_ingest_state();
        assert!(
            restarted_state
                .lock()
                .expect("restarted failed-ingest state")
                .snapshot()
                .is_none(),
            "a fresh process state must not reconstruct a prior failed-ingest diagnostic"
        );
    }
}

#[cfg(test)]
mod log_ingest_cancel_registry_tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn concurrent_log_ingest_start_cannot_replace_or_steal_cancellation() {
        let mut cancels = HashMap::new();
        let first = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let second = Arc::new(std::sync::atomic::AtomicBool::new(false));

        register_exclusive_cancel(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            Arc::clone(&first),
            "a log import is already running",
        )
        .expect("first import starts");
        let error = register_exclusive_cancel(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            Arc::clone(&second),
            "a log import is already running",
        )
        .expect_err("second import must be rejected");

        assert_eq!(error, "a log import is already running");
        let registered = cancels
            .get(LOG_INGEST_CANCEL_KEY)
            .expect("first registration remains");
        assert!(Arc::ptr_eq(registered, &first));
        registered.store(true, Ordering::SeqCst);
        assert!(first.load(Ordering::SeqCst));
        assert!(!second.load(Ordering::SeqCst));
    }

    #[test]
    fn stale_log_ingest_completion_cannot_clear_a_newer_registration() {
        let mut cancels = HashMap::new();
        let older = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let newer = Arc::new(std::sync::atomic::AtomicBool::new(false));
        register_exclusive_cancel(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            Arc::clone(&older),
            "a log import is already running",
        )
        .expect("older import starts");
        assert!(remove_cancel_if_owned(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            &older,
        ));
        register_exclusive_cancel(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            Arc::clone(&newer),
            "a log import is already running",
        )
        .expect("newer import starts after older cleanup");

        assert!(!remove_cancel_if_owned(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            &older,
        ));
        let registered = cancels
            .get(LOG_INGEST_CANCEL_KEY)
            .expect("newer registration remains");
        assert!(Arc::ptr_eq(registered, &newer));
        assert!(remove_cancel_if_owned(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            &newer,
        ));
        assert!(!cancels.contains_key(LOG_INGEST_CANCEL_KEY));
    }

    #[test]
    fn stale_cancel_correlation_cannot_cancel_a_retry() {
        let mut cancels = HashMap::new();
        let retry = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let retry_key = format!("{LOG_INGEST_CANCEL_KEY}:import:retry");
        register_exclusive_cancel(
            &mut cancels,
            &retry_key,
            Arc::clone(&retry),
            "a log import is already running",
        )
        .expect("retry starts");

        assert!(
            find_cancel_for_correlation(&cancels, LOG_INGEST_CANCEL_KEY, Some("import:stale"),)
                .is_none()
        );
        let current =
            find_cancel_for_correlation(&cancels, LOG_INGEST_CANCEL_KEY, Some("import:retry"))
                .expect("current correlation resolves");
        current.store(true, Ordering::SeqCst);
        assert!(retry.load(Ordering::SeqCst));
    }

    #[test]
    fn scoped_import_and_legacy_preview_are_mutually_exclusive() {
        let mut cancels = HashMap::new();
        register_exclusive_cancel(
            &mut cancels,
            "log_ingest:import:one",
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            "busy",
        )
        .expect("scoped import starts");
        assert_eq!(
            register_exclusive_cancel(
                &mut cancels,
                LOG_INGEST_CANCEL_KEY,
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
                "busy",
            ),
            Err("busy".into())
        );
    }
}

#[cfg(test)]
mod process_progress_invocation_tests {
    use super::*;

    #[test]
    fn host_operations_are_unique_and_correlation_is_validated() {
        let first = ProcessProgressInvocation::new(Some("import:known_1".into()));
        let second = ProcessProgressInvocation::new(Some("private/path.log".into()));
        assert_ne!(first.operation_id, second.operation_id);
        assert_eq!(first.correlation_id, "import:known_1");
        assert_eq!(
            second.correlation_id,
            format!("host:{}", second.operation_id)
        );
    }

    #[test]
    fn event_envelope_flattens_progress_with_both_exact_ids() {
        let payload = TauriProcessProgressPayload {
            operation_id: "host-1".into(),
            correlation_id: "import:one".into(),
            update: cd_core::process_progress::ProcessProgress::phase(
                cd_core::process_progress::ProcessProgressKind::LogIngest,
                cd_core::process_progress::ProcessProgressPhase::Starting,
                "starting",
                true,
            ),
        };
        let value = serde_json::to_value(payload).expect("serialize envelope");
        assert_eq!(value["operation_id"], "host-1");
        assert_eq!(value["correlation_id"], "import:one");
        assert_eq!(value["kind"], "log_ingest");
        assert_eq!(value["phase"], "starting");
        assert!(
            value.get("update").is_none(),
            "core progress must be flattened"
        );
    }
}

#[cfg(test)]
mod log_timezone_host_tests {
    use super::*;

    #[test]
    fn timezone_commands_are_registered_and_keep_corpus_work_off_the_event_loop() {
        let source = include_str!("lib.rs");
        for command in [
            "log_load_timezone_state",
            "log_preview_source_timezone",
            "log_apply_source_timezone",
            "log_clear_source_timezone",
        ] {
            assert!(
                source.contains(&format!("{command},")),
                "{command} must be registered"
            );
            let start = source
                .find(&format!("async fn {command}("))
                .unwrap_or_else(|| panic!("{command} command"));
            let end = source[start..]
                .find("\n#[tauri::command]")
                .map(|offset| start + offset)
                .unwrap_or_else(|| panic!("{command} boundary"));
            let body = &source[start..end];
            assert!(
                body.contains("tokio::task::spawn_blocking"),
                "{command} must keep corpus I/O off the app event loop"
            );
        }
    }

    #[test]
    fn timezone_preview_wire_contract_is_camel_case_and_precision_honest() {
        let preview = cd_core::log_analysis::TimezoneResolutionPreview {
            corpus_id: "corpus-time".into(),
            event_revision: 7,
            source: "server/server.log".into(),
            iana_timezone: "America/Chicago".into(),
            declaration_fingerprint: "preview-token".into(),
            affected_records: 12,
            existing_wall_clock_records: 3,
            first_resolved_instant: Some(1_700_000_000),
            last_resolved_instant: Some(1_700_000_120),
            dst_gap_count: 1,
            dst_fold_count: 2,
            unchanged_order_only_records: 4,
            unsupported_timestamp_count: 5,
            zone_abbreviation_mismatch_count: 7,
            out_of_range_count: 6,
        };
        let wire =
            serde_json::to_value(LogTimezonePreviewDto::from(preview)).expect("serialize preview");
        assert_eq!(wire["corpusId"], "corpus-time");
        assert_eq!(wire["eventRevision"], 7);
        assert_eq!(wire["ianaZone"], "America/Chicago");
        assert_eq!(wire["previewToken"], "preview-token");
        assert_eq!(wire["dstGapRecords"], 1);
        assert_eq!(wire["dstFoldAmbiguities"], 2);
        assert_eq!(wire["zoneAbbreviationMismatchRecords"], 7);
        assert_eq!(wire["precision"], "whole_second");
        assert!(wire.get("event_revision").is_none());
    }
}

#[cfg(test)]
mod log_noise_candidate_host_tests {
    use super::*;
    use cd_core::log_analysis::{
        ActiveTimestampBasis, LogEvent, TemplateInfo, TemplateRow, TimestampProvenance,
    };

    fn candidate_fixture() -> (tempfile::TempDir, PathBuf, String) {
        let root = tempfile::tempdir().expect("temp root");
        let cache = root.path().join("cache");
        let corpus =
            cd_core::log_analysis::LogCorpus::create(&cache, "noise-wire").expect("create corpus");
        corpus
            .upsert_templates((1..=3u64).map(|template_id| TemplateRow {
                info: TemplateInfo {
                    template_id,
                    pattern: format!("candidate family {template_id}"),
                    token_count: 3,
                    count: 40,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_002_340,
                    severity: if template_id == 3 { 4 } else { 1 },
                    example: format!("candidate family {template_id}"),
                },
                content_hash: format!("fp-{template_id}"),
                vector: None,
            }))
            .expect("templates");
        let mut events = Vec::new();
        let mut seq = 1u64;
        for template_id in 1..=3u64 {
            for minute in 0..40u64 {
                events.push(LogEvent {
                    seq,
                    ts: 1_700_000_000 + (minute * 60 + template_id) as i64,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: if template_id == 3 {
                        "ERROR".into()
                    } else {
                        "INFO".into()
                    },
                    service: Some("svc".into()),
                    host: Some(format!("host-{}", minute % 3)),
                    template_id,
                    params: Vec::new(),
                    trace_id: None,
                    message: format!("candidate family {template_id}"),
                    source: format!("source-{}.log", minute % 3),
                });
                seq += 1;
            }
        }
        corpus.push_events(&events).expect("events");
        corpus.flush().expect("flush");
        let corpus_id = corpus.id().to_string();
        drop(corpus);
        (root, cache, corpus_id)
    }

    #[test]
    fn proposal_command_wire_is_bounded_honest_and_read_only() {
        let (_root, cache, corpus_id) = candidate_fixture();
        let handles = LogCorpusHandleCache::default();
        let before =
            load_log_suppression_at(&handles, &cache, &corpus_id).expect("policy before proposal");

        let capped = propose_log_noise_candidates_at(
            &handles,
            &cache,
            LogProposeNoiseCandidatesArgs {
                corpus_id: corpus_id.clone(),
                max_candidates: Some(1),
                max_representatives: Some(1),
            },
        )
        .expect("capped proposals");
        assert_eq!(capped.candidates.len(), 1);
        assert_eq!(capped.eligible_candidate_count, 3);
        assert!(capped.candidate_cap_truncated);

        let report = propose_log_noise_candidates_at(
            &handles,
            &cache,
            LogProposeNoiseCandidatesArgs {
                corpus_id: corpus_id.clone(),
                max_candidates: Some(32),
                max_representatives: Some(2),
            },
        )
        .expect("full proposals");
        let wire = serde_json::to_value(&report).expect("serialize report");
        assert_eq!(wire["eligibleCandidateCount"], 3);
        assert!(wire.get("eligible_candidate_count").is_none());
        for candidate in wire["candidates"].as_array().expect("candidate array") {
            assert!(
                matches!(
                    candidate["shape"].as_str(),
                    Some("steady" | "bursty" | "insufficient_time")
                ),
                "shape must use the closed wire vocabulary: {candidate}"
            );
        }
        let risky = wire["candidates"]
            .as_array()
            .expect("candidate array")
            .iter()
            .find(|candidate| candidate["templateId"] == 3)
            .expect("ERROR-heavy proposal");
        assert_eq!(risky["proposalKind"], "suppression_candidate");
        assert!(risky["reasonCodes"]
            .as_array()
            .expect("reason codes")
            .iter()
            .any(|reason| reason == "repetitive_error_risky"));
        assert!(wire["disclaimer"]
            .as_str()
            .expect("disclaimer")
            .contains("Nothing was auto-suppressed"));

        let after =
            load_log_suppression_at(&handles, &cache, &corpus_id).expect("policy after proposal");
        assert_eq!(after.revision, before.revision);
        assert_eq!(after.rules, before.rules);
        assert_eq!(after, before);
    }

    #[test]
    fn proposal_command_is_registered_strict_local_and_has_no_activation_path() {
        let source = include_str!("lib.rs");
        assert!(source.contains("log_propose_noise_candidates,"));
        let args: Result<LogProposeNoiseCandidatesArgs, _> =
            serde_json::from_value(serde_json::json!({"corpusId": "c", "unexpected": true}));
        assert!(args.is_err(), "unknown IPC fields must fail closed");

        let helper_start = source
            .find("fn propose_log_noise_candidates_at(")
            .expect("proposal helper");
        let helper_end = source[helper_start..]
            .find("/// Propose bounded exact-template")
            .map(|offset| helper_start + offset)
            .expect("proposal helper boundary");
        let helper = &source[helper_start..helper_end];
        assert!(helper.contains("handles.open("));
        assert!(helper.contains("propose_noise_candidates("));
        assert!(!helper.contains("LogCorpus::open"));
        assert!(!helper.contains("preview_template_suppression"));
        assert!(!helper.contains("activate_template_suppression"));
        assert!(!helper.contains("mutate_template_suppression_rule"));

        let command_start = source
            .find("async fn log_propose_noise_candidates(")
            .expect("proposal command");
        let command_end = source[command_start..]
            .find("fn load_log_suppression_at(")
            .map(|offset| command_start + offset)
            .expect("proposal command boundary");
        let command = &source[command_start..command_end];
        assert!(command.contains("tokio::task::spawn_blocking"));
        assert!(command.contains("propose_log_noise_candidates_at"));
        assert!(!command.contains("ensure_host("));
        assert!(!command.contains("LogCorpus::open"));
    }

    /// #824 — SoftWrite ingest must not run DuckDB/analysis on the UI event loop.
    #[test]
    fn log_run_import_verifies_the_plan_in_trusted_core_before_any_ingest() {
        let source = include_str!("lib.rs");
        let start = source
            .find("async fn log_run_import(")
            .expect("log_run_import");
        let end = source[start..]
            .find("\n#[tauri::command]")
            .map(|offset| start + offset)
            .expect("log_run_import boundary");
        let body = &source[start..end];
        let verify = body
            .find("verify_import_plan")
            .expect("log_run_import must call verify_import_plan");
        let run = body
            .find("run_log_ingest(")
            .expect("log_run_import must call run_log_ingest");
        assert!(
            verify < run,
            "plan verification must complete before any ingest work starts"
        );
        assert!(
            !body.contains("deselected"),
            "the run request is an exact allowlist, never a deny-list"
        );
        assert!(
            body.contains("selected: Vec<String>"),
            "the run request carries the exact reviewed selection"
        );
    }

    #[test]
    fn log_preview_import_registers_a_real_cancel_flag() {
        let source = include_str!("lib.rs");
        let start = source
            .find("async fn log_preview_import(")
            .expect("log_preview_import");
        let end = source[start..]
            .find("\n#[tauri::command]")
            .map(|offset| start + offset)
            .expect("log_preview_import boundary");
        let body = &source[start..end];
        assert!(
            body.contains("register_exclusive_cancel"),
            "preview must register the shared cancel key"
        );
        assert!(
            body.contains("Some(&cancel)"),
            "preview must pass its cancel flag into trusted core — the \
             cancellable claim has to be real"
        );
        assert!(
            body.contains("preview_import_plan"),
            "preview returns the plan-bound wire shape"
        );
    }

    #[test]
    fn run_log_ingest_keeps_core_ingest_off_the_event_loop() {
        let source = include_str!("lib.rs");
        let start = source
            .find("async fn run_log_ingest(")
            .expect("run_log_ingest");
        let end = source[start..]
            .find("\n#[tauri::command]")
            .map(|offset| start + offset)
            .expect("run_log_ingest boundary");
        let body = &source[start..end];
        assert!(
            body.contains("tokio::task::spawn_blocking"),
            "run_log_ingest must use spawn_blocking for trusted-core ingest"
        );
        assert!(
            body.contains("ingest_path_with_policy_and_observer"),
            "run_log_ingest must call the shipped core ingest path"
        );
        assert!(
            !body.contains("LogCorpus::open("),
            "run_log_ingest must not open DuckDB on the async host path"
        );
    }

    /// #532 hardening — the report authority model, pinned at the source
    /// level. Needles are split so this test's own text never satisfies (or
    /// defeats) an absence assertion.
    #[test]
    fn investigation_report_authority_source_contract() {
        let source = include_str!("lib.rs");

        // Blocker 2: no renderer-invocable propose command exists. Report
        // proposals enter only through the tool host's SoftWrite path, where
        // provenance is host-authored and the permission gate applies.
        let propose_command = format!("{}{}", "fn log_propose_investigation_", "report_section");
        assert!(
            !source.contains(&propose_command),
            "renderer propose command must not exist"
        );

        // Blocker 3: the host never performs its own policy-sidecar capture —
        // the report header comes from the resolution's single snapshot.
        let capture = format!("{}{}", "capture_suppression_", "policy_binding");
        assert!(
            !source.contains(&capture),
            "no second policy capture on the host"
        );

        // Blocker 5: no second-assembly export prepare command; the assemble
        // command itself retains the rendered bytes it returns.
        let prepare_command = format!("{}{}", "log_prepare_investigation_", "report_export");
        assert!(
            !source.contains(&prepare_command),
            "export must reuse the previewed artifact, never a second assembly"
        );
        let assemble_start = source
            .find("async fn log_assemble_investigation_report(")
            .expect("assemble command");
        let assemble_end = source[assemble_start..]
            .find("struct LogInvestigationReportExportRequest")
            .map(|offset| assemble_start + offset)
            .expect("assemble boundary");
        let assemble = &source[assemble_start..assemble_end];
        assert!(
            assemble.contains(".prepare(markdown.clone())"),
            "assemble must retain exactly the markdown it returns"
        );
        assert!(
            assemble.contains("export_unavailable_reason"),
            "a render refused at the export boundary must still preview, with the reason"
        );

        // Blocker 5: save writes only the retained bytes — it can never
        // re-assemble or re-render.
        let save_start = source
            .find("async fn log_save_investigation_report_export(")
            .expect("save command");
        let save_end = source[save_start..]
            .find("fn log_release_investigation_report_export(")
            .map(|offset| save_start + offset)
            .expect("save boundary");
        let save = &source[save_start..save_end];
        assert!(save.contains("reports.content(&request.report_id)"));
        assert!(!save.contains("assemble_log_investigation_report_at"));
        assert!(!save.contains("render_investigation_report_markdown"));
    }
}

#[cfg(test)]
mod log_explorer_async_query_host_tests {
    use super::*;

    fn assert_async_blocking_command(src: &str, signature: &str, boundary: &str, helper: &str) {
        let start = src.find(signature).unwrap_or_else(|| panic!("{signature}"));
        let end = src[start..]
            .find(boundary)
            .map(|offset| start + offset)
            .unwrap_or_else(|| panic!("{signature} boundary"));
        let command = &src[start..end];
        assert!(
            command.contains("tokio::task::spawn_blocking"),
            "{signature} must move blocking reads off the app event loop"
        );
        assert!(
            command.contains(helper),
            "{signature} must call its blocking helper"
        );
        assert!(
            !command.contains("LogCorpus::open"),
            "{signature} must not open DuckDB on the app event loop"
        );
    }

    #[test]
    fn explorer_startup_queries_are_async_and_leave_duckdb_work_off_the_event_loop() {
        let src = include_str!("lib.rs");
        for (signature, boundary, helper) in [
            (
                "async fn list_log_corpora(",
                "/// Full summary for one corpus",
                "list_log_corpora_at",
            ),
            (
                "async fn get_log_corpus(",
                "/// List templates for a corpus",
                "get_log_corpus_at",
            ),
            (
                "async fn list_log_templates(",
                "/// Export a corpus package zip",
                "list_log_templates_at",
            ),
            (
                "async fn log_cluster_problems(",
                "/// Timeline buckets for a corpus",
                "log_cluster_problems_at",
            ),
            (
                "async fn log_timeline(",
                "/// Hybrid log search",
                "log_timeline_at",
            ),
            (
                "async fn log_search(",
                "/// Discard a disposable corpus",
                "log_search_at",
            ),
            (
                "async fn log_query_events(",
                "/// Count-free bounded event rows",
                "query_log_events_at",
            ),
            (
                "async fn log_query_event_rows(",
                "/// Exact cursor-independent count",
                "query_log_event_rows_at",
            ),
            (
                "async fn log_count_events(",
                "#[derive(Debug, Clone, PartialEq, Eq, Serialize)]",
                "count_log_events_at",
            ),
            (
                "async fn log_query_event_original(",
                "/// Fixed-size, filter-aware timeline summary",
                "query_log_event_original_at",
            ),
            (
                "async fn log_timeline_summary(",
                "/// One bounded global timeline axis",
                "query_log_timeline_at",
            ),
            (
                "async fn log_shared_timeline_summary(",
                "/// Bounded neighborhood around a stable event identity",
                "query_log_shared_timeline_at",
            ),
            (
                "async fn log_query_event_neighborhood(",
                "/// Facets under filters for explorer filter rail",
                "query_log_event_neighborhood_at",
            ),
            (
                "async fn log_facets(",
                "fn query_log_source_catalog_at(",
                "query_log_facets_at",
            ),
            (
                "async fn log_source_catalog(",
                "/// IPC args for advanced log search",
                "query_log_source_catalog_at",
            ),
            (
                "async fn log_propose_noise_candidates(",
                "fn load_log_suppression_at(",
                "propose_log_noise_candidates_at",
            ),
            (
                "async fn log_load_suppression(",
                "struct LogPreviewTemplateSuppressionArgs",
                "load_log_suppression_at",
            ),
            (
                "async fn log_preview_template_suppression(",
                "struct LogActivateTemplateSuppressionArgs",
                "preview_log_template_suppression_at",
            ),
            (
                "async fn log_activate_template_suppression(",
                "struct LogMutateTemplateSuppressionRuleArgs",
                "activate_log_template_suppression_at",
            ),
            (
                "async fn log_mutate_template_suppression_rule(",
                "/// List bookmarks for a corpus",
                "mutate_log_template_suppression_rule_at",
            ),
            (
                "async fn log_list_bookmarks(",
                "#[derive(Debug, Deserialize)]",
                "list_log_bookmarks_at",
            ),
            (
                "async fn log_load_active_investigation(",
                "#[derive(Debug, Deserialize)]",
                "load_active_log_investigation_at",
            ),
            (
                "async fn log_assemble_investigation_report(",
                "struct LogInvestigationReportExportRequest",
                "assemble_log_investigation_report_at",
            ),
        ] {
            assert_async_blocking_command(src, signature, boundary, helper);
        }
    }

    #[test]
    fn blocking_helpers_preserve_startup_read_results() {
        let root = tempfile::tempdir().expect("temp root");
        let logs = root.path().join("logs");
        std::fs::create_dir_all(&logs).expect("logs");
        std::fs::write(
            logs.join("events.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-07-29T12:00:00Z\",\"level\":\"INFO\",",
                "\"service\":\"api\",\"host\":\"node-1\",\"message\":\"started\"}\n",
                "{\"timestamp\":\"2026-07-29T12:00:01Z\",\"level\":\"ERROR\",",
                "\"service\":\"api\",\"host\":\"node-1\",\"message\":\"failed\"}\n",
            ),
        )
        .expect("fixture");
        let cache = root.path().join("cache");
        let report = cd_core::log_analysis::ingest_path(&cache, &logs, "async-query", None, "none")
            .expect("ingest");
        let handles = LogCorpusHandleCache::default();
        let query = cd_core::log_analysis::EventQuery {
            limit: 10,
            ..Default::default()
        };

        let summary =
            get_log_corpus_at(&handles, &cache, &report.corpus_id).expect("corpus summary");
        assert_eq!(summary.event_count, 2);

        let corpora = list_log_corpora_at(&cache).expect("corpus list");
        assert_eq!(corpora.len(), 1);
        assert_eq!(corpora[0].id, report.corpus_id);

        let templates = list_log_templates_at(&handles, &cache, &report.corpus_id, Some(1))
            .expect("template list");
        assert_eq!(templates.len(), 1);
        let suppression =
            load_log_suppression_at(&handles, &cache, &report.corpus_id).expect("empty policy");
        assert_eq!(suppression.revision, 0);
        let preview = preview_log_template_suppression_at(
            &handles,
            &cache,
            LogPreviewTemplateSuppressionArgs {
                corpus_id: report.corpus_id.clone(),
                expected_revision: suppression.revision,
                name: "Routine startup".into(),
                rationale: "Reviewed repetitive startup template".into(),
                template_id: templates[0].id,
            },
        )
        .expect("trusted preview");
        assert!(preview.matching_event_count > 0);
        assert_eq!(preview.corpus_event_count, 2);
        let activated = activate_log_template_suppression_at(
            &handles,
            &cache,
            LogActivateTemplateSuppressionArgs {
                corpus_id: report.corpus_id.clone(),
                expected_revision: preview.rule_revision,
                preview_token: preview.token,
            },
        )
        .expect("activate policy");
        assert_eq!(
            activated.rule.state,
            cd_core::log_analysis::SuppressionRuleState::Enabled
        );
        let disabled = mutate_log_template_suppression_rule_at(
            &handles,
            &cache,
            LogMutateTemplateSuppressionRuleArgs {
                corpus_id: report.corpus_id.clone(),
                expected_revision: activated.revision,
                rule_id: activated.rule.id,
                mutation: cd_core::log_analysis::SuppressionRuleMutation::Disable,
            },
        )
        .expect("disable policy");
        assert_eq!(
            disabled.rule.state,
            cd_core::log_analysis::SuppressionRuleState::Disabled
        );

        let page =
            query_log_events_at(&handles, &cache, &report.corpus_id, &query).expect("event page");
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.total_matched, 2);

        let rows = query_log_event_rows_at(&handles, &cache, &report.corpus_id, &query)
            .expect("count-free event rows");
        assert_eq!(rows.events.len(), 2);
        assert!(rows.next_cursor.is_none());
        let count = count_log_events_at(&handles, &cache, &report.corpus_id, &query)
            .expect("independent exact event count");
        assert_eq!(count.total_matched, 2);

        let facets =
            query_log_facets_at(&handles, &cache, &report.corpus_id, &query).expect("facets");
        assert_eq!(facets.levels.values().sum::<u64>(), 2);
        assert_eq!(facets.services.values().sum::<u64>(), 2);
        assert_eq!(facets.hosts.values().sum::<u64>(), 2);
        assert_eq!(facets.sources.get("events.jsonl"), Some(&2));

        let timeline = query_log_timeline_at(
            &handles,
            &cache,
            &report.corpus_id,
            &cd_core::log_analysis::TimelineSummaryQuery::default(),
        )
        .expect("timeline");
        assert_eq!(timeline.total_matched, 2);

        let shared_timeline = query_log_shared_timeline_at(
            &handles,
            &cache,
            &report.corpus_id,
            &cd_core::log_analysis::SharedTimelineSummaryQuery::default(),
        )
        .expect("shared timeline");
        assert_eq!(shared_timeline.total_matched, 2);

        let clusters = log_cluster_problems_at(&handles, &cache, &report.corpus_id, Some(10))
            .expect("clusters");
        assert!(!clusters.is_empty());

        let analysis_timeline = log_timeline_at(&handles, &cache, &report.corpus_id, Some(60))
            .expect("analysis timeline");
        assert_eq!(
            analysis_timeline
                .iter()
                .map(|bucket| bucket.count)
                .sum::<u64>(),
            2
        );

        let search = log_search_at(
            &handles,
            &cache,
            &report.corpus_id,
            "failed".into(),
            Some(8),
            None,
        )
        .expect("analysis search");
        assert!(!search.is_empty());

        let bookmarks =
            list_log_bookmarks_at(&handles, &cache, &report.corpus_id).expect("resolved bookmarks");
        assert!(bookmarks.is_empty());

        let investigation_store =
            cd_core::investigations::InvestigationStore::new(root.path().join("investigations"));
        assert!(load_active_log_investigation_at(
            &investigation_store,
            &handles,
            &cache,
            &report.corpus_id,
            cd_core::investigations::InvestigationNoiseLens::Active,
        )
        .expect("no investigation")
        .is_none());
        let corpus =
            cd_core::log_analysis::LogCorpus::open(&cache, &report.corpus_id).expect("open corpus");
        investigation_store
            .create("Async startup proof", &corpus)
            .expect("create investigation");
        let investigation = load_active_log_investigation_at(
            &investigation_store,
            &handles,
            &cache,
            &report.corpus_id,
            cd_core::investigations::InvestigationNoiseLens::Active,
        )
        .expect("load investigation")
        .expect("active investigation");
        assert_eq!(investigation.document.title, "Async startup proof");

        let first = handles
            .open(&cache, &report.corpus_id)
            .expect("first handle");
        let second = handles
            .open(&cache, &report.corpus_id)
            .expect("second handle");
        assert!(
            Arc::ptr_eq(&first, &second),
            "startup reads must reuse one initialized corpus handle"
        );
        handles.remove(&report.corpus_id);
        let reopened = handles
            .open(&cache, &report.corpus_id)
            .expect("reopened handle");
        assert!(
            !Arc::ptr_eq(&first, &reopened),
            "explicit invalidation must discard the initialized handle"
        );
    }
}

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
        let handles = LogCorpusHandleCache::default();

        let original =
            query_log_event_original_at(&handles, &cache, &report.corpus_id, 0).expect("original");
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

        let error = query_log_event_original_at(&handles, &cache, &report.corpus_id, 99)
            .expect_err("missing event");
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
        assert!(shared_command.contains("query_log_shared_timeline_at"));
        assert!(
            shared_command.contains("tokio::task::spawn_blocking"),
            "shared timeline must keep DuckDB reads off the app event loop"
        );
        assert!(
            !shared_command.contains("ensure_host("),
            "local bounded summary must not construct the agent host"
        );
    }
}

/// The Explorer's exclusion lens is the host's decision, not the renderer's (#819).
#[cfg(test)]
mod log_suppression_lens_host_tests {
    use super::*;
    use cd_core::log_analysis::{
        ActiveTimestampBasis, LogEvent, SuppressionLensState, TemplateInfo, TemplateRow,
        TimestampProvenance,
    };

    /// Template 1 is genuinely suppressed; templates 2 and 3 are evidence that
    /// no renderer may hide. Template 3 is the ERROR family.
    const SUPPRESSED: u64 = 1;
    const OTHER: u64 = 2;
    const ERRORS: u64 = 3;

    fn lens_fixture() -> (tempfile::TempDir, PathBuf, String, LogCorpusHandleCache) {
        let root = tempfile::tempdir().expect("temp root");
        let cache = root.path().join("cache");
        let corpus =
            cd_core::log_analysis::LogCorpus::create(&cache, "lens-host").expect("create corpus");
        corpus
            .upsert_templates((1..=3u64).map(|template_id| TemplateRow {
                info: TemplateInfo {
                    template_id,
                    pattern: format!("family {template_id} <*>"),
                    token_count: 3,
                    count: 20,
                    first_seen: 1_700_000_000,
                    last_seen: 1_700_001_200,
                    severity: if template_id == ERRORS { 4 } else { 1 },
                    example: format!("family {template_id} sample"),
                },
                content_hash: format!("sha256:fp-{template_id}"),
                vector: None,
            }))
            .expect("templates");
        let mut events = Vec::new();
        let mut seq = 1u64;
        for template_id in 1..=3u64 {
            for step in 0..20u64 {
                events.push(LogEvent {
                    seq,
                    ts: 1_700_000_000 + (step * 60 + template_id) as i64,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: if template_id == ERRORS {
                        "ERROR".into()
                    } else {
                        "INFO".into()
                    },
                    service: Some("svc".into()),
                    host: Some("host-1".into()),
                    template_id,
                    params: Vec::new(),
                    trace_id: None,
                    message: format!("family {template_id} sample"),
                    source: "app.log".into(),
                });
                seq += 1;
            }
        }
        corpus.push_events(&events).expect("events");
        corpus.flush().expect("flush");
        let corpus_id = corpus.id().to_string();
        drop(corpus);

        let handles = LogCorpusHandleCache::default();
        let opened = handles.open(&cache, &corpus_id).expect("open");
        let preview = cd_core::log_analysis::preview_template_suppression(
            &opened,
            0,
            cd_core::log_analysis::NewSuppressionPreview {
                name: "Family one".into(),
                rationale: "Repeated background line".into(),
                template_id: SUPPRESSED,
                origin: cd_core::log_analysis::SuppressionRuleOrigin::Human,
            },
        )
        .expect("preview");
        cd_core::log_analysis::activate_template_suppression(
            &opened,
            preview.rule_revision,
            cd_core::log_analysis::ActivateSuppressionPreview {
                preview_token: preview.token.clone(),
            },
        )
        .expect("activate");
        cd_core::log_analysis::invalidate_trusted_suppression_lens(&opened);
        drop(opened);
        (root, cache, corpus_id, handles)
    }

    /// A renderer that asks to hide every template it knows about.
    fn hostile_query() -> cd_core::log_analysis::EventQuery {
        cd_core::log_analysis::EventQuery {
            excluded_template_ids: vec![SUPPRESSED, OTHER, ERRORS, 9_999],
            limit: 200,
            ..Default::default()
        }
    }

    #[test]
    fn every_explorer_surface_reduces_a_hostile_exclusion_set_to_the_policy() {
        let (_root, cache, corpus_id, handles) = lens_fixture();

        let rows =
            query_log_event_rows_at(&handles, &cache, &corpus_id, &hostile_query()).expect("rows");
        let seen: std::collections::BTreeSet<u64> =
            rows.events.iter().map(|event| event.template_id).collect();
        assert_eq!(
            seen,
            [OTHER, ERRORS].into_iter().collect(),
            "only the policy-authorized template may be hidden"
        );

        let page =
            query_log_events_at(&handles, &cache, &corpus_id, &hostile_query()).expect("page");
        assert!(page
            .events
            .iter()
            .all(|event| event.template_id != SUPPRESSED));
        assert!(page.events.iter().any(|event| event.template_id == ERRORS));

        // Counts, facets and both timelines must agree with the rows.
        let count =
            count_log_events_at(&handles, &cache, &corpus_id, &hostile_query()).expect("count");
        assert_eq!(count.total_matched, 40, "20 other + 20 error events remain");

        let facets =
            query_log_facets_at(&handles, &cache, &corpus_id, &hostile_query()).expect("facets");
        let error_facet: u64 = facets
            .levels
            .iter()
            .filter(|(level, _)| level.eq_ignore_ascii_case("error"))
            .map(|(_, count)| *count)
            .sum();
        assert_eq!(
            error_facet, 20,
            "facets must not drop unauthorized evidence"
        );

        let timeline = query_log_timeline_at(
            &handles,
            &cache,
            &corpus_id,
            &cd_core::log_analysis::TimelineSummaryQuery {
                filter: hostile_query(),
                ..Default::default()
            },
        )
        .expect("timeline");
        assert_eq!(timeline.total_matched, 40);

        let shared = query_log_shared_timeline_at(
            &handles,
            &cache,
            &corpus_id,
            &cd_core::log_analysis::SharedTimelineSummaryQuery {
                filter: hostile_query(),
                ..Default::default()
            },
        )
        .expect("shared timeline");
        assert_eq!(shared.total_matched, 40);

        let neighborhood = query_log_event_neighborhood_at(
            &handles,
            &cache,
            &corpus_id,
            &cd_core::log_analysis::EventNeighborhoodQuery {
                target_seq: 41,
                filter: hostile_query(),
                ..Default::default()
            },
        )
        .expect("neighborhood");
        assert!(neighborhood
            .events
            .iter()
            .all(|event| event.template_id != SUPPRESSED));
        assert!(neighborhood
            .events
            .iter()
            .any(|event| event.template_id == ERRORS));
    }

    #[test]
    fn suspending_the_lens_still_reveals_everything() {
        let (_root, cache, corpus_id, handles) = lens_fixture();
        // Suspend and temporary reveal both send an empty set.
        let suspended = cd_core::log_analysis::EventQuery {
            excluded_template_ids: vec![],
            limit: 200,
            ..Default::default()
        };
        let count = count_log_events_at(&handles, &cache, &corpus_id, &suspended).expect("count");
        assert_eq!(count.total_matched, 60, "suspend must hide nothing");
    }

    #[test]
    fn disabling_a_rule_stops_hiding_its_events_on_the_next_query() {
        let (_root, cache, corpus_id, handles) = lens_fixture();
        let before =
            count_log_events_at(&handles, &cache, &corpus_id, &hostile_query()).expect("before");
        assert_eq!(before.total_matched, 40);

        let corpus = handles.open(&cache, &corpus_id).expect("open");
        let document = cd_core::log_analysis::load_suppression_document(&corpus).expect("document");
        let rule_id = document
            .rules
            .iter()
            .find(|rule| rule.predicate.template_id == SUPPRESSED)
            .map(|rule| rule.id.clone())
            .expect("rule");
        let revision = document.revision;
        drop(corpus);

        mutate_log_template_suppression_rule_at(
            &handles,
            &cache,
            LogMutateTemplateSuppressionRuleArgs {
                corpus_id: corpus_id.clone(),
                expected_revision: revision,
                rule_id,
                mutation: cd_core::log_analysis::SuppressionRuleMutation::Disable,
            },
        )
        .expect("disable");

        let after =
            count_log_events_at(&handles, &cache, &corpus_id, &hostile_query()).expect("after");
        assert_eq!(
            after.total_matched, 60,
            "a disabled rule must stop excluding immediately"
        );
    }

    #[test]
    fn an_unreadable_policy_hides_nothing_and_reports_it() {
        let (_root, cache, corpus_id, handles) = lens_fixture();
        let corpus = handles.open(&cache, &corpus_id).expect("open");
        std::fs::write(corpus.root().join("suppression.json"), b"{ truncated")
            .expect("corrupt sidecar");
        drop(corpus);

        let lens = log_suppression_lens_at(&handles, &cache, &corpus_id).expect("lens");
        assert_eq!(lens.state, SuppressionLensState::Unavailable);
        assert!(lens.template_ids.is_empty());
        assert!(lens.reason.is_some());

        let count =
            count_log_events_at(&handles, &cache, &corpus_id, &hostile_query()).expect("count");
        assert_eq!(
            count.total_matched, 60,
            "an unreadable policy must withhold no evidence"
        );
    }

    #[test]
    fn the_disclosed_lens_matches_what_queries_enforce() {
        let (_root, cache, corpus_id, handles) = lens_fixture();
        let lens = log_suppression_lens_at(&handles, &cache, &corpus_id).expect("lens");
        assert_eq!(lens.state, SuppressionLensState::Resolved);
        assert_eq!(lens.template_ids, vec![SUPPRESSED]);
        assert_eq!(lens.corpus_id, corpus_id);

        // Echoing the disclosed set back is a no-op, so an honest renderer sees
        // exactly what it was told.
        let honest = cd_core::log_analysis::EventQuery {
            excluded_template_ids: lens.template_ids.clone(),
            limit: 200,
            ..Default::default()
        };
        let count = count_log_events_at(&handles, &cache, &corpus_id, &honest).expect("count");
        assert_eq!(count.total_matched, 40);
    }

    #[test]
    fn concurrent_explorer_reads_agree_on_one_effective_lens() {
        let (_root, cache, corpus_id, handles) = lens_fixture();
        let handles = Arc::new(handles);
        let mut workers = Vec::new();
        for _ in 0..6 {
            let handles = Arc::clone(&handles);
            let cache = cache.clone();
            let corpus_id = corpus_id.clone();
            workers.push(std::thread::spawn(move || {
                (0..16)
                    .map(|_| {
                        count_log_events_at(&handles, &cache, &corpus_id, &hostile_query())
                            .expect("count")
                            .total_matched
                    })
                    .collect::<Vec<_>>()
            }));
        }
        for worker in workers {
            for observed in worker.join().expect("worker") {
                assert_eq!(observed, 40);
            }
        }
    }

    /// Structural guard: a future Explorer read command cannot quietly forward
    /// a renderer exclusion set straight to cd-core.
    #[test]
    fn every_renderer_supplied_event_filter_is_routed_through_the_lens() {
        let src = include_str!("lib.rs");
        let lensed = [
            "fn query_log_events_at(",
            "fn query_log_event_rows_at(",
            "fn count_log_events_at(",
            "fn query_log_facets_at(",
            "fn query_log_timeline_at(",
            "fn query_log_shared_timeline_at(",
            "fn query_log_event_neighborhood_at(",
        ];
        for signature in lensed {
            let start = src.find(signature).unwrap_or_else(|| panic!("{signature}"));
            let end = src[start..]
                .find("\n}\n")
                .map(|offset| start + offset)
                .unwrap_or_else(|| panic!("{signature} body"));
            let body = &src[start..end];
            assert!(
                body.contains("open_log_corpus_with_lens"),
                "{signature} must reduce renderer exclusions before querying"
            );
            assert!(
                !body.contains("handles.open("),
                "{signature} must not bypass the lens by opening the corpus directly"
            );
        }

        // Find runs the same filter shape and is lensed inside its blocking task.
        let search_start = src
            .find("async fn log_search_events(")
            .expect("search command");
        let search_end = src[search_start..]
            .find("/// Signal cooperative cancellation")
            .map(|offset| search_start + offset)
            .expect("search boundary");
        assert!(
            src[search_start..search_end].contains("open_log_corpus_with_lens"),
            "Find must reduce renderer exclusions too"
        );

        // Completeness: anything that *accepts* a renderer-supplied event filter
        // must either be one of the lensed helpers above or be enforcement
        // itself. Only parameter positions are scanned, so a test constructing
        // its own EventQuery is not a finding.
        let primitives = [
            "fn enforce_log_suppression_lens(",
            "fn open_log_corpus_with_lens(",
        ];
        let mut unlensed = Vec::new();
        for pattern in [
            "query: &cd_core::log_analysis::EventQuery",
            "query: cd_core::log_analysis::EventQuery",
            "query: &mut cd_core::log_analysis::EventQuery",
            "filter: Option<cd_core::log_analysis::EventQuery>",
        ] {
            for (offset, _) in src.match_indices(pattern) {
                let Some(fn_start) = src[..offset].rfind("fn ") else {
                    continue;
                };
                // An IPC args struct carries the filter as a field, not a
                // parameter; its command is checked explicitly above.
                if src[..offset]
                    .rfind("struct ")
                    .is_some_and(|struct_start| struct_start > fn_start)
                {
                    continue;
                }
                let name_end = src[fn_start..]
                    .find('(')
                    .map(|end| fn_start + end + 1)
                    .unwrap_or(fn_start);
                let signature = &src[fn_start..name_end];
                let body_end = src[fn_start..]
                    .find("\n}\n")
                    .map(|end| fn_start + end)
                    .unwrap_or(src.len());
                let body = &src[fn_start..body_end];
                let routed = lensed.contains(&signature)
                    || primitives.contains(&signature)
                    // A thin command wrapper that only forwards to a lensed helper.
                    || lensed
                        .iter()
                        .any(|helper| body.contains(helper.trim_start_matches("fn ")));
                if !routed {
                    unlensed.push(signature.to_string());
                }
            }
        }
        unlensed.sort();
        unlensed.dedup();
        assert!(
            unlensed.is_empty(),
            "these accept a renderer event filter but never reach the lens: {unlensed:?}"
        );
    }
}

#[cfg(test)]
mod log_source_catalog_host_tests {
    use super::*;

    #[test]
    fn source_catalog_binding_preserves_relative_paths_and_pages_stably() {
        let root = tempfile::tempdir().expect("temp root");
        let logs = root.path().join("logs");
        for region in ["region-a", "region-b"] {
            let dir = logs.join(region);
            std::fs::create_dir_all(&dir).expect("nested fixture directory");
            std::fs::write(
                dir.join("application.log"),
                format!("2026-07-29T12:00:00Z INFO {region}\n"),
            )
            .expect("fixture");
        }
        let cache = root.path().join("cache");
        let report =
            cd_core::log_analysis::ingest_path(&cache, &logs, "source-catalog-host", None, "none")
                .expect("ingest");
        let handles = LogCorpusHandleCache::default();

        let first = query_log_source_catalog_at(
            &handles,
            &cache,
            &report.corpus_id,
            &cd_core::log_analysis::LogSourceCatalogQuery {
                search: Some("REGION-".into()),
                limit: 1,
                ..Default::default()
            },
        )
        .expect("first page");
        assert_eq!(first.total_matched, 2);
        assert_eq!(first.sources.len(), 1);
        assert_eq!(first.sources[0].source, "region-a/application.log");
        assert_eq!(first.sources[0].event_count, 1);
        assert_eq!(
            first.next_cursor.as_deref(),
            Some("region-a/application.log")
        );

        let second = query_log_source_catalog_at(
            &handles,
            &cache,
            &report.corpus_id,
            &cd_core::log_analysis::LogSourceCatalogQuery {
                search: Some("region-".into()),
                cursor: first.next_cursor,
                limit: 1,
            },
        )
        .expect("second page");
        assert_eq!(second.total_matched, 2);
        assert_eq!(second.sources.len(), 1);
        assert_eq!(second.sources[0].source, "region-b/application.log");
        assert_eq!(second.next_cursor, None);

        let wire = serde_json::to_value(&second).expect("serialize host DTO");
        assert_eq!(wire["sources"][0]["source"], "region-b/application.log");
        assert_eq!(wire["sources"][0]["eventCount"], 1);
        assert_eq!(wire["totalMatched"], 2);
        assert!(wire.get("nextCursor").is_some());
    }

    #[test]
    fn source_catalog_command_is_registered_local_and_independent_of_facets() {
        let source = include_str!("lib.rs");
        assert!(source.contains("log_source_catalog,"));
        assert!(source.contains("async fn log_source_catalog("));
        let command_start = source
            .find("fn log_source_catalog(")
            .expect("source catalog command");
        let command_end = source[command_start..]
            .find("/// IPC args for advanced log search")
            .map(|offset| command_start + offset)
            .expect("source catalog command boundary");
        let command = &source[command_start..command_end];
        assert!(command.contains("tokio::task::spawn_blocking"));
        assert!(command.contains("query_log_source_catalog_at"));
        assert!(!command.contains("query_facets"));
        assert!(!command.contains("ensure_host("));
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
mod demo_log_host_tests {
    use super::*;
    use std::collections::VecDeque;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[derive(Clone, Copy)]
    enum FakeIngestOutcome {
        Success,
        SuccessThenCancel,
        CountMismatch { events: u64, sources: u64 },
        Cancelled,
        Failed,
    }

    struct FakeDemoLogBackend {
        cache: PathBuf,
        resource: Option<PathBuf>,
        active: Mutex<Option<String>>,
        outcomes: Mutex<VecDeque<FakeIngestOutcome>>,
        ingest_calls: AtomicUsize,
        fail_next_discard: AtomicBool,
        fail_next_marker: AtomicBool,
        warn_next_marker: Mutex<Option<String>>,
        cache_block: Mutex<Option<FakeCacheBlock>>,
    }

    struct FakeCacheBlock {
        entered: std::sync::mpsc::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    }

    impl FakeDemoLogBackend {
        fn new(cache: PathBuf, outcomes: impl IntoIterator<Item = FakeIngestOutcome>) -> Self {
            Self {
                resource: Some(cache.join("packaged-demo")),
                cache,
                active: Mutex::new(None),
                outcomes: Mutex::new(outcomes.into_iter().collect()),
                ingest_calls: AtomicUsize::new(0),
                fail_next_discard: AtomicBool::new(false),
                fail_next_marker: AtomicBool::new(false),
                warn_next_marker: Mutex::new(None),
                cache_block: Mutex::new(None),
            }
        }

        fn with_active(self, corpus_id: &str) -> Self {
            *self.active.lock().expect("active") = Some(corpus_id.into());
            self
        }

        fn create_managed_corpus(&self) -> cd_core::log_analysis::LogCorpus {
            self.create_managed_corpus_with_counts(
                DEMO_LOG_EXPECTED_EVENTS,
                DEMO_LOG_EXPECTED_SOURCES,
            )
        }

        fn create_managed_corpus_with_counts(
            &self,
            events: u64,
            sources: u64,
        ) -> cd_core::log_analysis::LogCorpus {
            let corpus = cd_core::log_analysis::LogCorpus::create(&self.cache, DEMO_LOG_NAME)
                .expect("managed corpus");
            corpus
                .write_managed_identity(DEMO_LOG_IDENTITY)
                .expect("managed identity");
            corpus
                .write_ingest_summary(
                    None,
                    cd_core::log_analysis::CorpusStats {
                        files: sources,
                        discovered_files: sources,
                        lines: events,
                        ..Default::default()
                    },
                    Vec::new(),
                    cd_core::log_analysis::CorpusEmbeddingStatus::default(),
                )
                .expect("managed ingest summary");
            corpus
        }

        fn block_cache_inspection(
            &self,
        ) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
            let (entered_tx, entered_rx) = std::sync::mpsc::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            *self.cache_block.lock().expect("cache block") = Some(FakeCacheBlock {
                entered: entered_tx,
                release: release_rx,
            });
            (entered_rx, release_tx)
        }
    }

    #[async_trait::async_trait]
    impl DemoLogInstallBackend for FakeDemoLogBackend {
        fn cache_dir(&self) -> Result<PathBuf, String> {
            if let Some(block) = self.cache_block.lock().expect("cache block").as_ref() {
                block.entered.send(()).expect("announce cache inspection");
                block.release.recv().expect("release cache inspection");
            }
            Ok(self.cache.clone())
        }

        fn resolve_resource(&self) -> Option<PathBuf> {
            self.resource.clone()
        }

        fn active_corpus(&self) -> Option<String> {
            self.active.lock().expect("active").clone()
        }

        fn select_corpus(&self, corpus_id: Option<String>) {
            *self.active.lock().expect("active") = corpus_id;
        }

        fn discard_ingested_corpus(&self, cache: &Path, corpus_id: &str) -> Result<(), String> {
            if self.fail_next_discard.swap(false, Ordering::SeqCst) {
                return Err("injected demo cleanup failure".into());
            }
            discard_managed_demo_corpus(cache, corpus_id)
        }

        fn publish_marker(
            &self,
            cache: &Path,
            corpus_id: &str,
            cancel: &cd_core::process_progress::CancelFlag,
        ) -> Result<DemoMarkerPublishOutcome, DemoTransactionError> {
            if self.fail_next_marker.swap(false, Ordering::SeqCst) {
                return Err(DemoTransactionError::Failed(
                    "injected marker publication failure".into(),
                ));
            }
            let mut result = persist_demo_log_marker(cache, corpus_id, cancel)?;
            if let Some(warning) = self.warn_next_marker.lock().expect("marker warning").take() {
                result.warning = Some(match result.warning {
                    Some(existing) => format!("{existing}; {warning}"),
                    None => warning,
                });
            }
            Ok(result)
        }

        async fn ingest(
            &self,
            _resource: PathBuf,
            cancel: &cd_core::process_progress::CancelFlag,
        ) -> Result<DemoLogIngestReceipt, LogIngestRunError> {
            self.ingest_calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            if cancel.is_cancelled() {
                return Err(LogIngestRunError::Cancelled);
            }
            let outcome = self
                .outcomes
                .lock()
                .expect("outcomes")
                .pop_front()
                .unwrap_or(FakeIngestOutcome::Success);
            match outcome {
                FakeIngestOutcome::Success
                | FakeIngestOutcome::SuccessThenCancel
                | FakeIngestOutcome::CountMismatch { .. } => {
                    let (events, sources) = match outcome {
                        FakeIngestOutcome::CountMismatch { events, sources } => (events, sources),
                        _ => (DEMO_LOG_EXPECTED_EVENTS, DEMO_LOG_EXPECTED_SOURCES),
                    };
                    let corpus = self.create_managed_corpus_with_counts(events, sources);
                    if matches!(outcome, FakeIngestOutcome::SuccessThenCancel) {
                        cancel.cancel();
                    }
                    Ok(DemoLogIngestReceipt {
                        corpus_id: corpus.id().into(),
                        events,
                        sources,
                    })
                }
                FakeIngestOutcome::Cancelled => Err(LogIngestRunError::Cancelled),
                FakeIngestOutcome::Failed => {
                    Err(LogIngestRunError::Failed("injected ingest failure".into()))
                }
            }
        }
    }

    fn checked_in_demo_resource() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures")
            .join("log-lab")
            .join("acceptance")
            .join("seven-day-25k")
            .join("scenarios")
            .join("behavior-scale")
            .join("import")
    }

    fn write_required_demo_files(root: &Path) {
        let checked_in = checked_in_demo_resource();
        for entry in DEMO_LOG_RESOURCE_MANIFEST {
            let path = root.join(entry.path);
            std::fs::create_dir_all(path.parent().expect("fixture parent"))
                .expect("fixture parent");
            std::fs::copy(checked_in.join(entry.path), path).expect("copy authenticated fixture");
        }
    }

    #[test]
    fn packaging_maps_only_the_demo_import_directory_and_never_truth() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri config");
        let resources = config["bundle"]["resources"]
            .as_object()
            .expect("resource mapping");
        let source =
            "../../fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/import";
        assert_eq!(
            resources.get(source),
            Some(&serde_json::json!(DEMO_LOG_RESOURCE_DIR))
        );
        for (from, to) in resources {
            assert!(
                !from.to_ascii_lowercase().contains("truth")
                    && !to
                        .as_str()
                        .unwrap_or_default()
                        .to_ascii_lowercase()
                        .contains("truth"),
                "packaged resources must never include evaluator truth: {from} -> {to}"
            );
        }
        assert_eq!(
            resources
                .keys()
                .filter(|path| path.contains("fixtures/log-lab"))
                .count(),
            1
        );
        let checked_in_import = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(source);
        assert!(
            validate_demo_log_resource(&checked_in_import),
            "the exact mapped source tree must contain only the approved runtime files"
        );
    }

    #[test]
    fn packaged_demo_manifest_matches_every_checked_in_source() {
        use sha2::Digest;

        let checked_in = checked_in_demo_resource();
        assert_eq!(
            DEMO_LOG_RESOURCE_MANIFEST.len(),
            DEMO_LOG_EXPECTED_SOURCES as usize
        );
        assert!(
            validate_demo_log_resource(&checked_in),
            "the checked-in fixture bytes must match the compiled manifest"
        );
        let unique_paths = DEMO_LOG_RESOURCE_MANIFEST
            .iter()
            .map(|entry| entry.path)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            unique_paths.len(),
            DEMO_LOG_RESOURCE_MANIFEST.len(),
            "the compiled manifest must not contain duplicate normalized paths"
        );
        for entry in DEMO_LOG_RESOURCE_MANIFEST {
            let bytes = std::fs::read(checked_in.join(entry.path)).expect("manifest source");
            assert_eq!(bytes.len() as u64, entry.bytes, "length: {}", entry.path);
            assert_eq!(
                format!("{:x}", sha2::Sha256::digest(&bytes)),
                entry.sha256,
                "digest: {}",
                entry.path
            );
        }
    }

    #[test]
    fn resource_validation_rejects_one_byte_mutation_and_same_name_replacement() {
        let mutated = tempfile::tempdir().expect("mutated root");
        let mutated_import = mutated.path().join("import");
        write_required_demo_files(&mutated_import);
        let mutated_file = mutated_import.join("queue/events.jsonl");
        let mut bytes = std::fs::read(&mutated_file).expect("mutated source");
        let middle = bytes.len() / 2;
        bytes[middle] ^= 1;
        std::fs::write(&mutated_file, bytes).expect("one-byte mutation");
        assert!(
            !validate_demo_log_resource(&mutated_import),
            "a one-byte mutation must invalidate the packaged fixture"
        );

        let replaced = tempfile::tempdir().expect("replacement root");
        let replaced_import = replaced.path().join("import");
        write_required_demo_files(&replaced_import);
        let replaced_file = replaced_import.join("auth/auth.jsonl");
        let length = std::fs::metadata(&replaced_file)
            .expect("replacement metadata")
            .len();
        std::fs::write(&replaced_file, vec![b'x'; length as usize])
            .expect("same-name same-length replacement");
        assert!(
            !validate_demo_log_resource(&replaced_import),
            "a same-name, same-length replacement must fail its digest"
        );
    }

    #[test]
    fn resource_validation_rejects_truncation_missing_extra_and_manifest_mismatch() {
        let truncated = tempfile::tempdir().expect("truncated root");
        let truncated_import = truncated.path().join("import");
        write_required_demo_files(&truncated_import);
        let truncated_file = truncated_import.join("worker/worker.log.1");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&truncated_file)
            .expect("truncated source");
        file.set_len(
            std::fs::metadata(&truncated_file)
                .expect("truncated metadata")
                .len()
                - 1,
        )
        .expect("truncate source");
        assert!(!validate_demo_log_resource(&truncated_import));

        let missing = tempfile::tempdir().expect("missing root");
        let missing_import = missing.path().join("import");
        write_required_demo_files(&missing_import);
        std::fs::remove_file(missing_import.join("db/database.log.1"))
            .expect("remove required source");
        assert!(!validate_demo_log_resource(&missing_import));

        let extra = tempfile::tempdir().expect("extra root");
        let extra_import = extra.path().join("import");
        write_required_demo_files(&extra_import);
        std::fs::write(extra_import.join("unexpected.log"), b"not approved").expect("extra source");
        assert!(!validate_demo_log_resource(&extra_import));

        let mut mismatched = DEMO_LOG_RESOURCE_MANIFEST.to_vec();
        mismatched[0].sha256 = "0000000000000000000000000000000000000000000000000000000000000000";
        assert!(
            !validate_demo_log_resource_against_manifest(
                checked_in_demo_resource().as_path(),
                &mismatched
            ),
            "a mismatched compiled digest must fail closed"
        );
        let mut duplicate = DEMO_LOG_RESOURCE_MANIFEST.to_vec();
        duplicate.push(DEMO_LOG_RESOURCE_MANIFEST[0]);
        assert!(
            !validate_demo_log_resource_against_manifest(
                checked_in_demo_resource().as_path(),
                &duplicate
            ),
            "duplicate manifest paths must fail closed"
        );
    }

    #[test]
    fn resource_resolution_prefers_the_exact_packaged_mapping_then_debug_fallback() {
        let installed = tempfile::tempdir().expect("installed root");
        let fallback = tempfile::tempdir().expect("fallback root");
        let installed_import = installed.path().join(DEMO_LOG_RESOURCE_DIR);
        let fallback_import = fallback.path().join("import");
        write_required_demo_files(&installed_import);
        write_required_demo_files(&fallback_import);

        assert_eq!(
            resolve_demo_log_resource_from_candidates([
                installed_import.clone(),
                fallback_import.clone(),
            ]),
            Some(installed_import.clone())
        );
        assert_eq!(
            resolve_demo_log_resource_from_candidates([
                installed.path().join("missing"),
                fallback_import.clone(),
            ]),
            Some(fallback_import)
        );
        assert_eq!(
            resolve_demo_log_resource_from_candidates([installed.path().join("missing")]),
            None
        );

        std::fs::write(installed_import.join("unexpected.txt"), b"not approved")
            .expect("unexpected file");
        assert!(
            resolve_demo_log_resource_from_candidates([installed_import.clone()]).is_none(),
            "an unexpected packaged file must make the resource unavailable"
        );
        std::fs::remove_file(installed_import.join("unexpected.txt")).expect("remove extra");
        let forbidden = installed_import.join("truth");
        std::fs::create_dir(&forbidden).expect("forbidden dir");
        std::fs::write(forbidden.join("manifest.json"), b"{}").expect("forbidden file");
        assert!(
            resolve_demo_log_resource_from_candidates([installed_import]).is_none(),
            "truth-like sibling content must never pass resource validation"
        );
    }

    #[test]
    fn resource_validation_rejects_symlink_root_and_bounded_unknown_trees() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;

            let target = tempfile::tempdir().expect("symlink target");
            let target_import = target.path().join("import");
            write_required_demo_files(&target_import);
            let link_parent = tempfile::tempdir().expect("symlink parent");
            let linked_import = link_parent.path().join("import");
            symlink(&target_import, &linked_import).expect("resource root symlink");
            assert!(
                !validate_demo_log_resource(&linked_import),
                "the packaged resource root itself must not be a symlink"
            );

            let linked_entry = tempfile::tempdir().expect("linked entry root");
            let linked_entry_import = linked_entry.path().join("import");
            write_required_demo_files(&linked_entry_import);
            let linked_path = linked_entry_import.join("api/app.jsonl");
            std::fs::remove_file(&linked_path).expect("remove source before link");
            symlink(
                checked_in_demo_resource().join("api/app.jsonl"),
                &linked_path,
            )
            .expect("resource entry symlink");
            assert!(
                !validate_demo_log_resource(&linked_entry_import),
                "a symlinked packaged resource entry must fail closed"
            );
        }

        let deep = tempfile::tempdir().expect("deep unexpected root");
        let deep_import = deep.path().join("import");
        write_required_demo_files(&deep_import);
        let mut unexpected = deep_import.join("unexpected");
        for index in 0..64 {
            unexpected = unexpected.join(format!("depth-{index}"));
        }
        std::fs::create_dir_all(&unexpected).expect("deep unexpected tree");
        std::fs::write(unexpected.join("payload.log"), b"not approved")
            .expect("deep unexpected file");
        assert!(
            !validate_demo_log_resource(&deep_import),
            "an unknown deep tree must be rejected against the exact allowlist"
        );

        let excess = tempfile::tempdir().expect("excess unexpected root");
        let excess_import = excess.path().join("import");
        write_required_demo_files(&excess_import);
        for index in 0..64 {
            std::fs::write(
                excess_import.join(format!("unexpected-{index}.log")),
                b"not approved",
            )
            .expect("excess unexpected file");
        }
        assert!(
            !validate_demo_log_resource(&excess_import),
            "an excess resource tree must be rejected within the strict entry bound"
        );
    }

    #[tokio::test]
    async fn transaction_is_idempotent_and_never_matches_a_same_named_user_corpus() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        std::fs::create_dir_all(&cache).expect("cache");
        let user_corpus =
            cd_core::log_analysis::LogCorpus::create(&cache, DEMO_LOG_NAME).expect("user corpus");
        let backend = FakeDemoLogBackend::new(cache.clone(), [FakeIngestOutcome::Success]);
        let serial = tokio::sync::Mutex::new(());
        let first_cancel = cd_core::process_progress::CancelFlag::new();
        let second_cancel = cd_core::process_progress::CancelFlag::new();

        let first = install_demo_log_corpus_serialized(&serial, &backend, &first_cancel).await;
        let second = install_demo_log_corpus_serialized(&serial, &backend, &second_cancel).await;

        assert_eq!(first.status, DemoLogInstallStatus::Installed);
        assert_eq!(second.status, DemoLogInstallStatus::AlreadyInstalled);
        assert_eq!(first.corpus_id, second.corpus_id);
        assert_ne!(first.corpus_id.as_deref(), Some(user_corpus.id()));
        assert_eq!(backend.ingest_calls.load(Ordering::SeqCst), 1);
        assert!(
            cd_core::log_analysis::LogCorpus::open(&cache, user_corpus.id()).is_ok(),
            "the same-named user corpus must remain untouched"
        );
    }

    #[tokio::test]
    async fn cancellation_is_typed_retryable_and_restores_selection() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        let backend =
            FakeDemoLogBackend::new(cache, [FakeIngestOutcome::Cancelled]).with_active("user");
        let cancel = cd_core::process_progress::CancelFlag::new();

        let result = install_demo_log_corpus_transaction(&backend, &cancel).await;

        assert_eq!(result.status, DemoLogInstallStatus::Cancelled);
        assert_eq!(
            result.detail,
            "Installation cancelled. No demo corpus was installed."
        );
        assert!(result.retryable);
        assert_eq!(backend.active_corpus().as_deref(), Some("user"));
        assert_eq!(backend.ingest_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn post_ingest_identity_mismatch_never_activates_demo_marker() {
        for (events, sources) in [
            (DEMO_LOG_EXPECTED_EVENTS - 1, DEMO_LOG_EXPECTED_SOURCES),
            (DEMO_LOG_EXPECTED_EVENTS, DEMO_LOG_EXPECTED_SOURCES - 1),
        ] {
            let root = tempfile::tempdir().expect("cache root");
            let cache = root.path().join("cache");
            let backend = FakeDemoLogBackend::new(
                cache.clone(),
                [
                    FakeIngestOutcome::CountMismatch { events, sources },
                    FakeIngestOutcome::Success,
                ],
            )
            .with_active("user");
            let cancel = cd_core::process_progress::CancelFlag::new();

            let failed = install_demo_log_corpus_transaction(&backend, &cancel).await;

            assert_eq!(failed.status, DemoLogInstallStatus::Failed);
            assert!(failed.retryable);
            assert!(failed
                .detail
                .contains("expected 10 sources and 25000 events"));
            assert!(failed.detail.contains("was not activated"));
            assert_eq!(backend.active_corpus().as_deref(), Some("user"));
            assert!(!demo_log_marker_path(&cache).exists());
            assert!(
                managed_demo_log_corpora(&cache, &cancel)
                    .expect("managed scan")
                    .is_empty(),
                "a count-mismatched managed corpus must not be recoverable as the demo"
            );
            assert!(
                cd_core::log_analysis::LogCorpus::list_ids(&cache)
                    .expect("corpus list")
                    .is_empty(),
                "the just-created mismatched managed corpus must be discarded"
            );

            let retry = install_demo_log_corpus_transaction(&backend, &cancel).await;
            assert_eq!(retry.status, DemoLogInstallStatus::Installed);
            assert_eq!(retry.events, Some(DEMO_LOG_EXPECTED_EVENTS));
            assert_eq!(backend.ingest_calls.load(Ordering::SeqCst), 2);
        }
    }

    #[tokio::test]
    async fn post_ingest_identity_mismatch_surfaces_scoped_cleanup_failure() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        let backend = FakeDemoLogBackend::new(
            cache.clone(),
            [FakeIngestOutcome::CountMismatch {
                events: DEMO_LOG_EXPECTED_EVENTS - 1,
                sources: DEMO_LOG_EXPECTED_SOURCES,
            }],
        )
        .with_active("user");
        backend.fail_next_discard.store(true, Ordering::SeqCst);
        let cancel = cd_core::process_progress::CancelFlag::new();

        let result = install_demo_log_corpus_transaction(&backend, &cancel).await;

        assert_eq!(result.status, DemoLogInstallStatus::Failed);
        assert!(result.retryable);
        assert!(result.detail.contains("Cleanup failed"));
        assert!(result.detail.contains("injected demo cleanup failure"));
        assert!(result.detail.contains("remains unselected"));
        assert_eq!(backend.active_corpus().as_deref(), Some("user"));
        assert!(!demo_log_marker_path(&cache).exists());
        assert_eq!(
            cd_core::log_analysis::LogCorpus::list_ids(&cache)
                .expect("corpus list")
                .len(),
            1,
            "truthful cleanup failure retains only the scoped managed corpus"
        );
    }

    #[test]
    fn scoped_demo_discard_refuses_to_touch_a_user_corpus() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        let user =
            cd_core::log_analysis::LogCorpus::create(&cache, DEMO_LOG_NAME).expect("user corpus");
        let user_id = user.id().to_string();
        drop(user);

        let error = discard_managed_demo_corpus(&cache, &user_id)
            .expect_err("a user corpus must never be discarded by demo rollback");

        assert!(error.contains("reserved packaged-demo identity"));
        assert!(
            cd_core::log_analysis::LogCorpus::open(&cache, &user_id).is_ok(),
            "the refused user corpus must remain intact"
        );
    }

    #[tokio::test]
    async fn cancellation_between_corpus_publish_and_marker_commit_is_truthful_and_recoverable() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        let backend =
            FakeDemoLogBackend::new(cache.clone(), [FakeIngestOutcome::SuccessThenCancel])
                .with_active("user");
        let cancel = cd_core::process_progress::CancelFlag::new();

        let cancelled = install_demo_log_corpus_transaction(&backend, &cancel).await;

        assert_eq!(cancelled.status, DemoLogInstallStatus::Cancelled);
        assert_eq!(cancelled.events, Some(25_000));
        assert!(cancelled.corpus_id.is_some());
        assert!(cancelled
            .detail
            .contains("published demo corpus was retained"));
        assert!(cancelled.detail.contains("retry"));
        assert!(cancelled.retryable);
        assert_eq!(backend.active_corpus().as_deref(), Some("user"));
        assert!(!demo_log_marker_path(&cache).exists());
        let inspection_cancel = cd_core::process_progress::CancelFlag::new();
        let managed =
            managed_demo_log_corpora(&cache, &inspection_cancel).expect("managed corpus scan");
        assert_eq!(managed.len(), 1);
        assert_eq!(
            cancelled.corpus_id.as_deref(),
            Some(managed[0].id()),
            "the disclosed retained corpus must be the recoverable managed corpus"
        );

        let retry_cancel = cd_core::process_progress::CancelFlag::new();
        let recovered = install_demo_log_corpus_transaction(&backend, &retry_cancel).await;
        assert_eq!(recovered.status, DemoLogInstallStatus::AlreadyInstalled);
        assert_eq!(recovered.corpus_id, cancelled.corpus_id);
        assert_eq!(backend.ingest_calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.active_corpus(), recovered.corpus_id);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transaction_owned_cancel_is_authoritative_while_cache_inspection_is_blocked() {
        let root = tempfile::tempdir().expect("cache root");
        let backend = Arc::new(
            FakeDemoLogBackend::new(root.path().join("cache"), [FakeIngestOutcome::Success])
                .with_active("user"),
        );
        let (entered, release) = backend.block_cache_inspection();
        let serial = Arc::new(tokio::sync::Mutex::new(()));
        let cancel = cd_core::process_progress::CancelFlag::new();
        let cancel_registration = cancel.inner_arc();
        let mut cancels = HashMap::new();
        register_exclusive_cancel(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            Arc::clone(&cancel_registration),
            "already active",
        )
        .expect("register transaction cancel");

        let task = {
            let backend = Arc::clone(&backend);
            let serial = Arc::clone(&serial);
            let cancel = cancel.clone();
            tokio::spawn(async move {
                install_demo_log_corpus_serialized(&serial, backend.as_ref(), &cancel).await
            })
        };
        tokio::task::spawn_blocking(move || entered.recv().expect("cache inspection entered"))
            .await
            .expect("wait for cache inspection");
        let accepted = if let Some(flag) = cancels.get(LOG_INGEST_CANCEL_KEY) {
            flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        };
        release.send(()).expect("release cache inspection");
        let result = task.await.expect("install task");

        assert!(accepted, "Cancel must be accepted before ingest starts");
        assert_eq!(result.status, DemoLogInstallStatus::Cancelled);
        assert_eq!(backend.ingest_calls.load(Ordering::SeqCst), 0);
        assert_eq!(backend.active_corpus().as_deref(), Some("user"));
        assert!(remove_cancel_if_owned(
            &mut cancels,
            LOG_INGEST_CANCEL_KEY,
            &cancel_registration
        ));
    }

    #[tokio::test]
    async fn concurrent_invocations_serialize_the_complete_transaction() {
        let root = tempfile::tempdir().expect("cache root");
        let backend = FakeDemoLogBackend::new(
            root.path().join("cache"),
            [FakeIngestOutcome::Success, FakeIngestOutcome::Failed],
        );
        let serial = tokio::sync::Mutex::new(());
        let first_cancel = cd_core::process_progress::CancelFlag::new();
        let second_cancel = cd_core::process_progress::CancelFlag::new();

        let (first, second) = tokio::join!(
            install_demo_log_corpus_serialized(&serial, &backend, &first_cancel),
            install_demo_log_corpus_serialized(&serial, &backend, &second_cancel)
        );

        assert_eq!(backend.ingest_calls.load(Ordering::SeqCst), 1);
        assert!(
            matches!(first.status, DemoLogInstallStatus::Installed)
                ^ matches!(second.status, DemoLogInstallStatus::Installed)
        );
        assert!(
            matches!(first.status, DemoLogInstallStatus::AlreadyInstalled)
                ^ matches!(second.status, DemoLogInstallStatus::AlreadyInstalled)
        );
        assert_eq!(first.corpus_id, second.corpus_id);
    }

    #[tokio::test]
    async fn marker_fault_leaves_provable_corpus_for_retry_and_restores_selection() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        let backend = FakeDemoLogBackend::new(cache.clone(), [FakeIngestOutcome::Success])
            .with_active("user");
        backend.fail_next_marker.store(true, Ordering::SeqCst);
        let first_cancel = cd_core::process_progress::CancelFlag::new();

        let failed = install_demo_log_corpus_transaction(&backend, &first_cancel).await;
        assert_eq!(failed.status, DemoLogInstallStatus::Failed);
        assert!(failed.retryable);
        assert_eq!(backend.active_corpus().as_deref(), Some("user"));
        let managed = managed_demo_log_corpora(&cache, &first_cancel).expect("managed scan");
        assert_eq!(
            managed.len(),
            1,
            "published managed corpus survives marker fault"
        );
        assert!(!demo_log_marker_path(&cache).exists());

        let retry_cancel = cd_core::process_progress::CancelFlag::new();
        let recovered = install_demo_log_corpus_transaction(&backend, &retry_cancel).await;
        assert_eq!(recovered.status, DemoLogInstallStatus::AlreadyInstalled);
        assert_eq!(recovered.corpus_id.as_deref(), Some(managed[0].id()));
        assert_eq!(backend.ingest_calls.load(Ordering::SeqCst), 1);
        assert_eq!(backend.active_corpus(), recovered.corpus_id);
    }

    #[tokio::test]
    async fn damaged_unknown_marker_is_quarantined_without_touching_user_corpora() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        std::fs::create_dir_all(
            demo_log_marker_path(&cache)
                .parent()
                .expect("marker parent"),
        )
        .expect("marker parent");
        std::fs::write(
            demo_log_marker_path(&cache),
            br#"{"schemaVersion":99,"demoIdentity":"unknown","corpusId":"user"}"#,
        )
        .expect("damaged marker");
        let user =
            cd_core::log_analysis::LogCorpus::create(&cache, DEMO_LOG_NAME).expect("user corpus");
        let backend = FakeDemoLogBackend::new(cache.clone(), [FakeIngestOutcome::Success]);
        let cancel = cd_core::process_progress::CancelFlag::new();

        let result = install_demo_log_corpus_transaction(&backend, &cancel).await;

        assert_eq!(result.status, DemoLogInstallStatus::Installed);
        assert!(cd_core::log_analysis::LogCorpus::open(&cache, user.id()).is_ok());
        assert_ne!(result.corpus_id.as_deref(), Some(user.id()));
        let marker_path = demo_log_marker_path(&cache);
        let marker_dir = marker_path.parent().expect("marker parent");
        assert!(
            std::fs::read_dir(marker_dir)
                .expect("marker entries")
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().contains(".invalid.")),
            "unknown marker is retained as a quarantined diagnostic"
        );
    }

    #[tokio::test]
    async fn valid_marker_pointing_to_user_corpus_is_quarantined_and_never_selected() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        let user =
            cd_core::log_analysis::LogCorpus::create(&cache, DEMO_LOG_NAME).expect("user corpus");
        let marker_cancel = cd_core::process_progress::CancelFlag::new();
        persist_demo_log_marker(&cache, user.id(), &marker_cancel)
            .expect("syntactically valid marker");
        let backend = FakeDemoLogBackend::new(cache.clone(), [FakeIngestOutcome::Success])
            .with_active("prior-user-selection");
        let cancel = cd_core::process_progress::CancelFlag::new();

        let result = install_demo_log_corpus_transaction(&backend, &cancel).await;

        assert_eq!(result.status, DemoLogInstallStatus::Installed);
        assert_ne!(result.corpus_id.as_deref(), Some(user.id()));
        assert_ne!(backend.active_corpus().as_deref(), Some(user.id()));
        assert!(cd_core::log_analysis::LogCorpus::open(&cache, user.id()).is_ok());
        let marker_path = demo_log_marker_path(&cache);
        assert!(
            std::fs::read_dir(marker_path.parent().expect("marker parent"))
                .expect("marker entries")
                .flatten()
                .any(|entry| entry.file_name().to_string_lossy().contains(".invalid.")),
            "the unauthorized marker must be quarantined"
        );
    }

    #[tokio::test]
    async fn post_commit_marker_warning_still_reports_installed() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        let backend = FakeDemoLogBackend::new(cache.clone(), [FakeIngestOutcome::Success]);
        *backend.warn_next_marker.lock().expect("marker warning") =
            Some("could not sync the demo marker directory: injected".into());
        let cancel = cd_core::process_progress::CancelFlag::new();

        let result = install_demo_log_corpus_transaction(&backend, &cancel).await;

        assert_eq!(result.status, DemoLogInstallStatus::Installed);
        assert!(!result.retryable);
        assert!(result.detail.contains("Warning:"));
        assert!(matches!(
            read_demo_log_marker(&cache).expect("committed marker"),
            DemoLogMarkerState::Installed(corpus)
                if Some(corpus.id()) == result.corpus_id.as_deref()
        ));
    }

    #[test]
    fn backup_cleanup_and_directory_sync_failures_are_post_commit_warnings() {
        let outcome = demo_marker_post_commit_outcome(
            Some("backup cleanup failed".into()),
            Some("directory sync failed".into()),
        );

        assert_eq!(
            outcome.warning.as_deref(),
            Some("backup cleanup failed; directory sync failed")
        );
    }

    #[tokio::test]
    async fn damaged_marker_repairs_to_provably_managed_corpus_without_reimport() {
        let root = tempfile::tempdir().expect("cache root");
        let cache = root.path().join("cache");
        let backend = FakeDemoLogBackend::new(cache.clone(), [FakeIngestOutcome::Failed]);
        let managed = backend.create_managed_corpus();
        std::fs::create_dir_all(
            demo_log_marker_path(&cache)
                .parent()
                .expect("marker parent"),
        )
        .expect("marker parent");
        std::fs::write(demo_log_marker_path(&cache), b"not-json").expect("damaged marker");
        let cancel = cd_core::process_progress::CancelFlag::new();

        let repaired = install_demo_log_corpus_transaction(&backend, &cancel).await;

        assert_eq!(repaired.status, DemoLogInstallStatus::AlreadyInstalled);
        assert_eq!(repaired.corpus_id.as_deref(), Some(managed.id()));
        assert_eq!(backend.ingest_calls.load(Ordering::SeqCst), 0);
        assert!(matches!(
            read_demo_log_marker(&cache).expect("repaired marker"),
            DemoLogMarkerState::Installed(corpus) if corpus.id() == managed.id()
        ));
    }

    #[test]
    fn resolved_checked_in_resource_imports_through_the_real_bounded_core_path() {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("fixtures")
            .join("log-lab")
            .join("acceptance")
            .join("seven-day-25k")
            .join("scenarios")
            .join("behavior-scale")
            .join("import");
        let resolved =
            resolve_demo_log_resource_from_candidates([source]).expect("checked-in demo resource");
        let cache = tempfile::tempdir().expect("ingest cache");
        let report = cd_core::log_analysis::ingest_path_with_policy_and_observer_managed(
            cache.path(),
            &resolved,
            DEMO_LOG_NAME,
            &cd_core::log_analysis::LogEmbedPolicy::local_default(),
            None,
            &cd_core::process_progress::NoopProcessProgress,
            None,
            DEMO_LOG_IDENTITY,
        )
        .expect("real bounded demo ingest");
        assert_eq!(report.stats.lines, 25_000);
        assert_eq!(report.stats.files, 10);
        assert_eq!(report.stats.discovered_files, 10);
        assert!(!report.stats.partial);
        let corpus = cd_core::log_analysis::LogCorpus::open(cache.path(), &report.corpus_id)
            .expect("installed demo corpus");
        assert_eq!(corpus.summary().event_count, 25_000);
        assert_eq!(
            corpus.meta().expect("meta").managed_identity.as_deref(),
            Some(DEMO_LOG_IDENTITY),
            "managed identity must be durable before public corpus reconciliation"
        );
    }
}

#[cfg(test)]
mod startup_host_tests {
    use super::{
        admit_agent_turn, build_and_install_background_index, chat_provider_binding_changed,
        chat_turn_cancel_key, desktop_log_ingest_embed_plan_nonblocking,
        ensure_log_nav_evidence_exists, event_to_dto_with_linked_corpus, finish_agent_turn,
        host_readiness_terminal_events, install_prepared_durable_memory,
        is_governed_log_citation_id, linked_log_fallback_notice, linked_log_host_terminal_events,
        linked_log_preflight_at, linked_log_turn_context, load_session_for_turn,
        log_explorer_window_label, log_search_cancel_key, normalize_log_corpus_id,
        parse_log_explorer_nav_target, persist_host_terminal_turn_at,
        persist_investigation_answer_at, persist_linked_provider_loop_terminal_at,
        prepare_linked_turn_with, provider_profile_for_turn, request_agent_turn_cancel,
        reserve_investigation_answer_message, restore_host_if_generation_matches,
        save_chat_session_at, save_chat_session_cas_at, set_chat_linked_corpus_at,
        take_ready_linked_host, validate_linked_log_corpus_at, wait_for_host_readiness,
        BackgroundIndexBuild, HostInitFlight, HostReadinessFailure, LinkedCheckpointStore,
        LinkedTurnPreparation, LogExplorerNavTarget, LogExplorerNavTargetStore,
        LogExplorerTurnContextReq, Session, SessionStore, StdInstant, StoredMessage,
        INVESTIGATION_ANSWER_META_KEY, LINKED_CHECKPOINT_ENTRY_CAP, LINKED_CHECKPOINT_TOTAL_BYTES,
        LINKED_CHECKPOINT_TTL, LOG_INGEST_CANCEL_KEY, LOG_REANALYZE_CANCEL_KEY,
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

    fn validated_investigation_envelope(
        session_id: &str,
        turn_id: &str,
        corpus_id: &str,
        revision: cd_core::investigation_answer::LogSnapshotRevisionV1,
    ) -> cd_core::investigation_answer::AnswerEnvelopeV1 {
        use cd_core::investigation_answer::{
            validate_model_answer, AnswerBindingV1, EvidenceRole, HostEvidenceEntry,
            HostEvidenceLedger, SCHEMA_V1,
        };
        let evidence = vec![HostEvidenceEntry {
            evidence_id: "e1".into(),
            candidate_id: "candidate".into(),
            source_label: "host log".into(),
            locator: "seq=1".into(),
            corpus_id: corpus_id.into(),
            revision,
            role: EvidenceRole::Supporting,
            content: "host-owned evidence".into(),
        }];
        let binding = AnswerBindingV1 {
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            corpus_id: corpus_id.into(),
            revision,
            ledger_digest: HostEvidenceLedger::digest(&evidence),
        };
        let ledger = HostEvidenceLedger::new(binding, evidence).expect("host ledger");
        let proposal = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"candidate","observations":[{{"claim_id":"claim","text":"observed","evidence_ids":["e1"]}}]}}]}}"#
        );
        validate_model_answer(&proposal, &ledger).expect("validated envelope")
    }

    #[test]
    fn typed_investigation_envelope_requires_fresh_host_owned_message_reservation() {
        let root = tempfile::tempdir().expect("sessions");
        let store = SessionStore::new(root.path());
        let mut session = Session::new("Investigation");
        session.set_linked_corpus_id(Some("corpus-a".into()));
        for (id, role) in [
            ("old-assistant", "assistant"),
            ("user-row", "user"),
            ("already-duplicate", "assistant"),
            ("already-duplicate", "assistant"),
        ] {
            session.messages.push(StoredMessage {
                id: id.into(),
                role: role.into(),
                content: "prior transcript".into(),
                tools: None,
                citations: None,
                trail: None,
                meta: None,
            });
        }
        let session_id = session.id.clone();
        store.save(&session).expect("seed");
        let turn_id = format!("{session_id}::{}", uuid::Uuid::new_v4());
        let snapshot = cd_core::investigation_answer::LogSnapshotRevisionV1 {
            event_revision: 7,
            template_analysis_revision: 11,
            suppression_revision: 13,
        };
        let envelope =
            validated_investigation_envelope(&session_id, &turn_id, "corpus-a", snapshot);
        let events = vec![StreamEvent::InvestigationAnswer {
            envelope: envelope.clone(),
        }];
        for stale_id in ["old-assistant", "user-row", "already-duplicate"] {
            assert!(
                reserve_investigation_answer_message(
                    Some(&session),
                    &session_id,
                    &turn_id,
                    Some(stale_id),
                )
                .is_none(),
                "an existing {stale_id} row cannot be reassociated"
            );
        }
        assert!(
            reserve_investigation_answer_message(Some(&session), &session_id, &turn_id, None,)
                .is_none()
        );
        let reservation = reserve_investigation_answer_message(
            Some(&session),
            &session_id,
            &turn_id,
            Some("assistant-current"),
        )
        .expect("fresh assistant correlation id");
        let duplicate_current_reservation = reserve_investigation_answer_message(
            Some(&session),
            &session_id,
            &turn_id,
            Some("assistant-duplicate-current"),
        )
        .expect("initially fresh duplicate test id");
        let user_race_reservation = reserve_investigation_answer_message(
            Some(&session),
            &session_id,
            &turn_id,
            Some("assistant-became-user"),
        )
        .expect("initially fresh role-race test id");

        let mut wrong_scope = store.load(&session_id).expect("linked session");
        wrong_scope.set_linked_corpus_id(Some("corpus-b".into()));
        store.save(&wrong_scope).expect("save wrong scope");
        assert!(
            !persist_investigation_answer_at(&store, Some(&reservation), Some(snapshot), &events)
                .expect("mismatched rejection"),
            "an event for another corpus cannot persist typed authority"
        );
        let mut correct_scope = store.load(&session_id).expect("wrong-scope session");
        correct_scope.set_linked_corpus_id(Some("corpus-a".into()));
        store.save(&correct_scope).expect("save correct scope");
        assert!(!persist_investigation_answer_at(
            &store,
            Some(&reservation),
            Some(cd_core::investigation_answer::LogSnapshotRevisionV1 {
                template_analysis_revision: snapshot.template_analysis_revision + 1,
                ..snapshot
            }),
            &events,
        )
        .expect("stale snapshot rejection"));
        assert!(
            !persist_investigation_answer_at(&store, Some(&reservation), None, &events,)
                .expect("event-only rejection")
        );

        let mut duplicate_current = store.load(&session_id).expect("current session");
        duplicate_current.messages.push(StoredMessage {
            id: "assistant-became-user".into(),
            role: "user".into(),
            content: "must never own assistant authority".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        for _ in 0..2 {
            duplicate_current.messages.push(StoredMessage {
                id: "assistant-duplicate-current".into(),
                role: "assistant".into(),
                content: String::new(),
                tools: None,
                citations: None,
                trail: None,
                meta: None,
            });
        }
        store.save(&duplicate_current).expect("save duplicate race");
        assert!(!persist_investigation_answer_at(
            &store,
            Some(&user_race_reservation),
            Some(snapshot),
            &events,
        )
        .expect("user-row race rejection"));
        assert!(!persist_investigation_answer_at(
            &store,
            Some(&duplicate_current_reservation),
            Some(snapshot),
            &events,
        )
        .expect("duplicate current id rejection"));
        assert!(
            persist_investigation_answer_at(&store, Some(&reservation), Some(snapshot), &events)
                .expect("host persistence"),
            "the exact linked corpus persists"
        );
        let mut renderer_save = store.load(&session_id).expect("reload");
        assert!(
            renderer_save
                .messages
                .iter()
                .filter(|message| message.id != "assistant-current")
                .all(|message| message
                    .meta
                    .as_ref()
                    .and_then(|meta| meta.get(INVESTIGATION_ANSWER_META_KEY))
                    .is_none()),
            "no prior, user, or duplicate row may acquire current-turn authority"
        );
        let current = renderer_save
            .messages
            .iter_mut()
            .find(|message| message.id == "assistant-current")
            .expect("host-owned current assistant row");
        current.meta = Some(serde_json::json!({
            INVESTIGATION_ANSWER_META_KEY: { "forged": true }
        }));
        let saved = save_chat_session_at(&store, renderer_save).expect("renderer save");
        let current = saved
            .messages
            .iter()
            .find(|message| message.id == "assistant-current")
            .expect("saved current row");
        assert_eq!(
            current
                .meta
                .as_ref()
                .and_then(|meta| meta.get(INVESTIGATION_ANSWER_META_KEY)),
            Some(&serde_json::json!(envelope)),
            "a renderer cannot replace the typed host envelope"
        );
        let mut new_renderer_session = Session::new("forged new");
        new_renderer_session.messages.push(StoredMessage {
            id: "forged".into(),
            role: "assistant".into(),
            content: "{}".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: Some(serde_json::json!({ INVESTIGATION_ANSWER_META_KEY: { "forged": true } })),
        });
        let saved_new = save_chat_session_at(&store, new_renderer_session).expect("new save");
        assert!(saved_new.messages[0]
            .meta
            .as_ref()
            .and_then(|meta| meta.get(INVESTIGATION_ANSWER_META_KEY))
            .is_none());

        let cache = tempfile::tempdir().expect("cache");
        let detached = set_chat_linked_corpus_at(
            &store,
            cache.path(),
            &session_id,
            None,
            None,
            Some(wire_session_revision(&saved)),
        )
        .expect("detach linked corpus");
        assert!(
            detached
                .messages
                .iter()
                .find(|message| message.id == "assistant-current")
                .expect("detached current row")
                .meta
                .as_ref()
                .and_then(|meta| meta.get(INVESTIGATION_ANSWER_META_KEY))
                .is_none(),
            "detaching the host-owned corpus makes the historical envelope unavailable"
        );
    }

    #[test]
    fn two_windows_cannot_replace_same_session_turn_or_its_cancel_target() {
        let owners = Mutex::new(std::collections::HashMap::new());
        let cancels = Mutex::new(std::collections::HashMap::new());
        let next_owner = AtomicU64::new(0);

        let first_window =
            admit_agent_turn(&owners, &cancels, &next_owner, "shared-chat").expect("first admit");
        let first_cancel = first_window.cancel.clone();
        assert!(
            admit_agent_turn(&owners, &cancels, &next_owner, "shared-chat").is_err(),
            "a second window must be rejected before replacing ownership"
        );
        cancels
            .lock()
            .unwrap()
            .get(&chat_turn_cancel_key("shared-chat"))
            .unwrap()
            .store(true, Ordering::SeqCst);
        assert!(first_cancel.load(Ordering::SeqCst));
        assert!(
            !finish_agent_turn(&owners, &cancels, "shared-chat", first_window.owner + 1),
            "stale completion must not remove the admitted owner"
        );
        assert!(owners.lock().unwrap().contains_key("shared-chat"));
        drop(first_window);
        assert!(!owners.lock().unwrap().contains_key("shared-chat"));
        assert!(!cancels
            .lock()
            .unwrap()
            .contains_key(&chat_turn_cancel_key("shared-chat")));
    }

    #[test]
    fn chat_turn_cancellation_cannot_collide_with_log_operation_domains() {
        let owners = Mutex::new(std::collections::HashMap::new());
        let cancels = Mutex::new(std::collections::HashMap::new());
        let next_owner = AtomicU64::new(0);
        let log_ingest = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let log_reanalyze = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let log_search = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut registry = cancels.lock().unwrap();
            registry.insert(LOG_INGEST_CANCEL_KEY.into(), log_ingest.clone());
            registry.insert(LOG_REANALYZE_CANCEL_KEY.into(), log_reanalyze.clone());
            registry.insert("log_search:find-123".into(), log_search.clone());
        }

        for session_id in [
            LOG_INGEST_CANCEL_KEY,
            LOG_REANALYZE_CANCEL_KEY,
            "log_search:find-123",
        ] {
            let turn = admit_agent_turn(&owners, &cancels, &next_owner, session_id)
                .expect("chat turn must use a separate cancellation namespace");
            assert!(request_agent_turn_cancel(&cancels, session_id));
            assert!(turn.cancel.load(Ordering::SeqCst));
            assert!(!log_ingest.load(Ordering::SeqCst));
            assert!(!log_reanalyze.load(Ordering::SeqCst));
            assert!(!log_search.load(Ordering::SeqCst));
            drop(turn);
        }

        let registry = cancels.lock().unwrap();
        assert!(Arc::ptr_eq(
            registry.get(LOG_INGEST_CANCEL_KEY).unwrap(),
            &log_ingest
        ));
        assert!(Arc::ptr_eq(
            registry.get(LOG_REANALYZE_CANCEL_KEY).unwrap(),
            &log_reanalyze
        ));
        assert!(Arc::ptr_eq(
            registry.get("log_search:find-123").unwrap(),
            &log_search
        ));
    }

    #[test]
    fn preflight_and_readiness_terminal_turns_are_host_persisted_and_idempotent() {
        for (suffix, code) in [
            ("preflight", "linked_log_host_unavailable"),
            ("readiness", "budget_time"),
        ] {
            let sessions_root = tempfile::tempdir().expect("sessions");
            let store = cd_core::sessions::SessionStore::new(sessions_root.path());
            let mut session = cd_core::sessions::Session::new("Linked");
            session.set_linked_corpus_id(Some("corpus-a".into()));
            store.save(&session).expect("save session");
            let events = vec![
                StreamEvent::Error {
                    code: code.into(),
                    message: format!("{suffix} failed before provider contact"),
                },
                StreamEvent::SearchTrail {
                    steps: vec![format!("terminal:{code}")],
                },
                StreamEvent::TurnCompleted {
                    reason: code.into(),
                },
            ];
            let saved = persist_host_terminal_turn_at(
                &store,
                &session.id,
                "Which logs explain the incident?",
                Some("user-terminal"),
                Some("assistant-terminal"),
                &events,
                (
                    Some("private-profile"),
                    Some("Private provider"),
                    Some("slow-model"),
                ),
            )
            .expect("trusted terminal persistence");
            assert_eq!(saved.messages.len(), 2);
            assert_eq!(saved.messages[0].id, "user-terminal");
            assert_eq!(saved.messages[0].role, "user");
            assert_eq!(
                saved.messages[0].content,
                "Which logs explain the incident?"
            );
            assert_eq!(saved.messages[1].id, "assistant-terminal");
            assert_eq!(saved.messages[1].role, "assistant");
            assert!(saved.messages[1]
                .content
                .contains("failed before provider contact"));
            assert_eq!(
                saved.messages[1]
                    .meta
                    .as_ref()
                    .and_then(|meta| meta["terminal"]["error_codes"][0].as_str()),
                Some(code)
            );
            assert_eq!(
                saved.messages[1].trail.as_deref(),
                Some([format!("terminal:{code}")].as_slice())
            );

            persist_host_terminal_turn_at(
                &store,
                &session.id,
                "Which logs explain the incident?",
                Some("user-terminal"),
                Some("assistant-terminal"),
                &events,
                (
                    Some("private-profile"),
                    Some("Private provider"),
                    Some("slow-model"),
                ),
            )
            .expect("idempotent replay");
            assert_eq!(
                store
                    .load(&session.id)
                    .expect("switch back to chat")
                    .messages
                    .len(),
                2,
                "switching away and back must reveal one durable typed terminal turn"
            );
        }
    }

    #[test]
    fn first_linked_provider_failure_survives_renderer_crash_before_save() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let session_id = {
            let store = cd_core::sessions::SessionStore::new(sessions_root.path());
            let mut session = cd_core::sessions::Session::new("Linked");
            session.set_linked_corpus_id(Some("corpus-a".into()));
            let session_id = session.id.clone();
            store.save(&session).expect("save empty linked session");

            let scripted_first_provider_failure = vec![
                StreamEvent::TurnStarted {
                    session_id: session_id.clone(),
                    model: Some("private-model".into()),
                },
                StreamEvent::Error {
                    code: "linked_retrieval_provider_error".into(),
                    message: "The provider failed before linked evidence was retrieved. No \
                              log-grounded answer was produced."
                        .into(),
                },
                StreamEvent::SearchTrail {
                    steps: vec![
                        "phase:choosing_evidence".into(),
                        "linked_retrieval_provider_failure:missing=linked logs".into(),
                    ],
                },
                StreamEvent::TurnCompleted {
                    reason: "linked_retrieval_provider_error".into(),
                },
            ];
            assert!(
                persist_linked_provider_loop_terminal_at(
                    &store,
                    &session_id,
                    "What caused the worker failure?",
                    Some("linked-user-1"),
                    Some("linked-assistant-1"),
                    &scripted_first_provider_failure,
                    (
                        Some("private-profile"),
                        Some("Private provider"),
                        Some("private-model"),
                    ),
                )
                .expect("persist before returning events"),
                "the linked terminal provider outcome must cross the host durability boundary"
            );

            // Simulate the renderer process disappearing after IPC delivery but before
            // its normal full-session save.
            drop(scripted_first_provider_failure);
            drop(store);
            session_id
        };

        let reopened = cd_core::sessions::SessionStore::new(sessions_root.path())
            .load(&session_id)
            .expect("fresh host process reopens linked transcript");
        assert_eq!(reopened.messages.len(), 2);
        assert_eq!(reopened.messages[0].id, "linked-user-1");
        assert_eq!(reopened.messages[0].role, "user");
        assert_eq!(
            reopened.messages[0].content,
            "What caused the worker failure?"
        );
        assert_eq!(reopened.messages[1].id, "linked-assistant-1");
        assert_eq!(reopened.messages[1].role, "assistant");
        assert!(reopened.messages[1]
            .content
            .contains("No log-grounded answer was produced"));
        assert_eq!(
            reopened.messages[1]
                .meta
                .as_ref()
                .and_then(|meta| meta["terminal"]["reason"].as_str()),
            Some("linked_retrieval_provider_error")
        );
        assert_eq!(
            reopened.messages[1]
                .meta
                .as_ref()
                .and_then(|meta| meta["linked_corpus_id"].as_str()),
            Some("corpus-a")
        );
        assert_eq!(
            reopened.provider_profile_id.as_deref(),
            Some("private-profile")
        );
        assert_eq!(reopened.chat_model.as_deref(), Some("private-model"));
    }

    #[test]
    fn evidence_preserving_linked_failure_persists_provenance_once() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let mut session = cd_core::sessions::Session::new("Linked evidence");
        session.set_linked_corpus_id(Some("corpus-evidence".into()));
        let session_id = session.id.clone();
        store.save(&session).expect("save empty linked session");
        let terminal = vec![
            StreamEvent::TurnStarted {
                session_id: session_id.clone(),
                model: Some("slow-model".into()),
            },
            StreamEvent::Tool {
                id: "tool-1".into(),
                name: "search_logs".into(),
                phase: cd_core::events::ToolPhase::Started,
                summary: "Searching linked logs".into(),
                detail: None,
                ok: None,
            },
            StreamEvent::Tool {
                id: "tool-1".into(),
                name: "search_logs".into(),
                phase: cd_core::events::ToolPhase::Finished,
                summary: "Found bounded evidence".into(),
                detail: Some("seq=42 source=worker.log".into()),
                ok: Some(true),
            },
            StreamEvent::Citation {
                source_id: "log_event:42".into(),
                label: "worker.log · seq 42".into(),
                locator: Some("seq=42 source=worker.log".into()),
                corpus_id: None,
            },
            StreamEvent::SearchTrail {
                steps: vec![
                    "phase:retrieving_evidence".into(),
                    "phase:synthesizing_answer".into(),
                    "linked_evidence_preserved_for_synthesis_retry".into(),
                ],
            },
            StreamEvent::Error {
                code: "linked_synthesis_provider_error".into(),
                message: "The provider failed after bounded evidence was retrieved.".into(),
            },
            StreamEvent::TurnCompleted {
                reason: "linked_synthesis_provider_error".into(),
            },
        ];

        for _ in 0..2 {
            assert!(persist_linked_provider_loop_terminal_at(
                &store,
                &session_id,
                "What evidence explains the incident?",
                Some("evidence-user"),
                Some("evidence-assistant"),
                &terminal,
                (
                    Some("private-profile"),
                    Some("Private provider"),
                    Some("slow-model"),
                ),
            )
            .expect("idempotent terminal persistence"));
        }

        let reopened_store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let reopened = reopened_store
            .load(&session_id)
            .expect("reopen evidence-preserving failure");
        assert_eq!(reopened.messages.len(), 2);
        let assistant = &reopened.messages[1];
        let tools = assistant
            .tools
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .expect("durable tool provenance");
        assert_eq!(tools.len(), 1, "started/finished events fold by tool id");
        assert_eq!(tools[0]["id"], "tool-1");
        assert_eq!(tools[0]["ok"], true);
        let citations = assistant
            .citations
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .expect("durable citation provenance");
        assert_eq!(citations.len(), 1);
        assert_eq!(citations[0]["id"], "log_event:42");
        assert_eq!(citations[0]["corpusId"], "corpus-evidence");
        assert_eq!(
            assistant.trail.as_deref(),
            Some(
                [
                    "phase:retrieving_evidence".to_string(),
                    "phase:synthesizing_answer".to_string(),
                    "linked_evidence_preserved_for_synthesis_retry".to_string(),
                ]
                .as_slice()
            )
        );
        assert_eq!(
            assistant
                .meta
                .as_ref()
                .and_then(|meta| meta["provider_id"].as_str()),
            Some("private-profile")
        );
        assert_eq!(
            assistant
                .meta
                .as_ref()
                .and_then(|meta| meta["model"].as_str()),
            Some("slow-model")
        );
        assert!(
            assistant
                .meta
                .as_ref()
                .and_then(|meta| meta.get("linked_synthesis_retry"))
                .is_none(),
            "process-local synthesis checkpoints must not become durable state"
        );
    }

    #[test]
    fn removed_explicit_provider_never_falls_back_and_terminal_is_durable() {
        let config = cd_core::config::AppConfig {
            providers: cd_core::providers::ProviderConfig::with_local_ollama(),
            ..Default::default()
        };
        assert!(
            provider_profile_for_turn(&config, Some("removed-company-profile")).is_err(),
            "an explicit missing profile must not borrow active Ollama"
        );
        assert_eq!(
            provider_profile_for_turn(&config, None)
                .expect("implicit active profile")
                .id,
            "ollama-local"
        );

        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let session = cd_core::sessions::Session::new("Removed profile");
        store.save(&session).expect("save session");
        let events = vec![
            StreamEvent::Error {
                code: "provider_profile_unavailable".into(),
                message: "Selected provider profile no longer exists".into(),
            },
            StreamEvent::TurnCompleted {
                reason: "provider_profile_unavailable".into(),
            },
        ];
        let saved = persist_host_terminal_turn_at(
            &store,
            &session.id,
            "Investigate these logs",
            Some("removed-user"),
            Some("removed-assistant"),
            &events,
            (Some("removed-company-profile"), None, Some("company-model")),
        )
        .expect("persist removed-profile failure");
        assert_eq!(
            saved.messages[1]
                .meta
                .as_ref()
                .and_then(|meta| meta["provider_id"].as_str()),
            Some("removed-company-profile")
        );
        assert_eq!(
            saved.messages[1]
                .meta
                .as_ref()
                .and_then(|meta| meta["terminal"]["reason"].as_str()),
            Some("provider_profile_unavailable")
        );
    }

    #[test]
    fn linked_checkpoint_store_expires_and_evicts_deterministically() {
        let now = StdInstant::now();
        let mut by_count = LinkedCheckpointStore::<String>::default();
        for index in 0..=LINKED_CHECKPOINT_ENTRY_CAP {
            assert!(by_count.insert_value_at(
                format!("session-{index:02}"),
                format!("checkpoint-{index}"),
                1,
                now,
            ));
        }
        assert!(by_count.get_value("session-00", now).is_none());
        assert_eq!(by_count.entries.len(), LINKED_CHECKPOINT_ENTRY_CAP);
        assert_eq!(
            by_count.get_value("session-16", now).as_deref(),
            Some("checkpoint-16")
        );

        let mut by_bytes = LinkedCheckpointStore::<String>::default();
        let majority = LINKED_CHECKPOINT_TOTAL_BYTES / 2 + 1;
        assert!(by_bytes.insert_value_at("older".into(), "a".into(), majority, now));
        assert!(by_bytes.insert_value_at("newer".into(), "b".into(), majority, now));
        assert!(by_bytes.get_value("older", now).is_none());
        assert_eq!(by_bytes.get_value("newer", now).as_deref(), Some("b"));
        assert!(!by_bytes.insert_value_at(
            "oversized".into(),
            "c".into(),
            LINKED_CHECKPOINT_TOTAL_BYTES + 1,
            now,
        ));

        let expired_at = now + LINKED_CHECKPOINT_TTL;
        assert!(by_bytes.get_value("newer", expired_at).is_none());
        assert_eq!(by_bytes.total_bytes, 0);
    }

    #[test]
    fn linked_log_citation_dto_stamps_only_host_resolved_corpus_identity() {
        let log = cd_core::events::StreamEvent::Citation {
            source_id: "log_template:7".into(),
            label: "template 7".into(),
            locator: None,
            corpus_id: None,
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
            corpus_id: Some("must-not-apply".into()),
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

        let authoritative = cd_core::events::StreamEvent::Citation {
            source_id: "log_event:42".into(),
            label: "event 42".into(),
            locator: Some("seq=42".into()),
            corpus_id: Some("event-corpus".into()),
        };
        assert_eq!(
            event_to_dto_with_linked_corpus(&authoritative, Some("session-fallback"))
                .payload
                .get("corpus_id")
                .and_then(|value| value.as_str()),
            Some("event-corpus"),
            "host-stamped event identity must outrank the linked-session fallback"
        );
    }

    #[test]
    fn host_stamped_log_citation_survives_terminal_chat_persistence() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let session = cd_core::sessions::Session::new("Ordinary chat");
        store.save(&session).expect("save session");
        let events = vec![
            StreamEvent::Citation {
                source_id: "log_event:42".into(),
                label: "worker.log · seq 42".into(),
                locator: Some("seq=42 source=worker.log".into()),
                corpus_id: Some("host-corpus".into()),
            },
            StreamEvent::Citation {
                source_id: "runbook.md".into(),
                label: "runbook".into(),
                locator: None,
                corpus_id: Some("must-not-apply".into()),
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
        ];
        let saved = persist_host_terminal_turn_at(
            &store,
            &session.id,
            "What happened?",
            Some("user-1"),
            Some("assistant-1"),
            &events,
            (None, None, None),
        )
        .expect("persist terminal turn");
        let citations = saved.messages[1]
            .citations
            .as_ref()
            .and_then(|value| value.as_array())
            .expect("persisted citations");
        assert_eq!(
            citations.len(),
            2,
            "non-log citations must also be retained"
        );
        let log = citations
            .iter()
            .find(|citation| citation["id"] == "log_event:42")
            .expect("host log citation");
        assert_eq!(log["corpusId"], "host-corpus");
        let file = citations
            .iter()
            .find(|citation| citation["id"] == "runbook.md")
            .expect("non-log citation");
        assert!(file.get("corpusId").is_none());
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

    #[tokio::test]
    async fn linked_tools_disabled_preflight_validates_corpus_before_refusal_and_precedes_host_readiness(
    ) {
        use std::sync::atomic::AtomicBool;

        #[derive(Debug, PartialEq, Eq)]
        enum SetupStep {
            ValidateCorpus,
            CheckToolCapability,
            BeginHostReadiness,
        }

        let plan = cd_core::router::TurnDeadlinePlan {
            total_ms: 1_000,
            choosing_ms: 1_000,
            retrieving_ms: 1_000,
            synthesizing_ms: 1_000,
            explicit: true,
        };
        let cancel = AtomicBool::new(false);

        let invalid_order = Arc::new(Mutex::new(Vec::new()));
        let validate_order = invalid_order.clone();
        let capability_order = invalid_order.clone();
        let host_order = invalid_order.clone();
        let invalid = prepare_linked_turn_with(
            tokio::time::Instant::now(),
            plan,
            &cancel,
            move || {
                validate_order
                    .lock()
                    .unwrap()
                    .push(SetupStep::ValidateCorpus);
                Err("invalid corpus".into())
            },
            move || {
                capability_order
                    .lock()
                    .unwrap()
                    .push(SetupStep::CheckToolCapability);
                None
            },
            move |_: ()| {
                host_order
                    .lock()
                    .unwrap()
                    .push(SetupStep::BeginHostReadiness);
                Ok(7)
            },
        )
        .await
        .unwrap();
        assert!(matches!(invalid, LinkedTurnPreparation::Terminal(_)));
        assert_eq!(*invalid_order.lock().unwrap(), [SetupStep::ValidateCorpus]);

        let refusal_order = Arc::new(Mutex::new(Vec::new()));
        let validate_order = refusal_order.clone();
        let capability_order = refusal_order.clone();
        let host_order = refusal_order.clone();
        let mut tools_disabled = ProviderProfile::ollama_local();
        tools_disabled.capabilities.tools = false;
        let refused = prepare_linked_turn_with(
            tokio::time::Instant::now(),
            plan,
            &cancel,
            move || {
                validate_order
                    .lock()
                    .unwrap()
                    .push(SetupStep::ValidateCorpus);
                Ok(())
            },
            move || {
                capability_order
                    .lock()
                    .unwrap()
                    .push(SetupStep::CheckToolCapability);
                cd_core::research::linked_tools_unavailable_events(
                    &tools_disabled,
                    "linked-session",
                )
            },
            move |_: ()| {
                host_order
                    .lock()
                    .unwrap()
                    .push(SetupStep::BeginHostReadiness);
                Ok(7)
            },
        )
        .await
        .unwrap();
        let LinkedTurnPreparation::Terminal(events) = refused else {
            panic!("tools-disabled linked turn must terminate before host readiness");
        };
        assert!(events.iter().any(|event| matches!(
            event,
            StreamEvent::Error { code, .. } if code == "linked_tools_unavailable"
        )));
        assert_eq!(
            *refusal_order.lock().unwrap(),
            [SetupStep::ValidateCorpus, SetupStep::CheckToolCapability]
        );

        let ready_order = Arc::new(Mutex::new(Vec::new()));
        let validate_order = ready_order.clone();
        let capability_order = ready_order.clone();
        let host_order = ready_order.clone();
        let ready = prepare_linked_turn_with(
            tokio::time::Instant::now(),
            plan,
            &cancel,
            move || {
                validate_order
                    .lock()
                    .unwrap()
                    .push(SetupStep::ValidateCorpus);
                Ok(())
            },
            move || {
                capability_order
                    .lock()
                    .unwrap()
                    .push(SetupStep::CheckToolCapability);
                None
            },
            move |_: ()| {
                host_order
                    .lock()
                    .unwrap()
                    .push(SetupStep::BeginHostReadiness);
                Ok(7)
            },
        )
        .await
        .unwrap();
        assert!(matches!(ready, LinkedTurnPreparation::Ready(7)));
        assert_eq!(
            *ready_order.lock().unwrap(),
            [
                SetupStep::ValidateCorpus,
                SetupStep::CheckToolCapability,
                SetupStep::BeginHostReadiness
            ]
        );
    }

    #[tokio::test]
    async fn linked_corpus_open_obeys_original_deadline_and_cancel_during_setup() {
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

        let plan = cd_core::router::TurnDeadlinePlan {
            total_ms: 1,
            choosing_ms: 1_000,
            retrieving_ms: 1_000,
            synthesizing_ms: 1_000,
            explicit: true,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let deadline_calls = calls.clone();
        let result = prepare_linked_turn_with(
            tokio::time::Instant::now() - Duration::from_millis(2),
            plan,
            &AtomicBool::new(false),
            move || {
                deadline_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            || None,
            |_| Ok(7),
        )
        .await;
        assert_eq!(result.unwrap_err(), HostReadinessFailure::TurnDeadline);
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let cancel = AtomicBool::new(true);
        let cancel_calls = calls.clone();
        let result = prepare_linked_turn_with(
            tokio::time::Instant::now(),
            cd_core::router::TurnDeadlinePlan {
                total_ms: 1_000,
                ..plan
            },
            &cancel,
            move || {
                cancel_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            || None,
            |_| Ok(7),
        )
        .await;
        assert_eq!(result.unwrap_err(), HostReadinessFailure::Cancelled);
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let slow_deadline_calls = Arc::new(AtomicUsize::new(0));
        let slow_deadline_worker = slow_deadline_calls.clone();
        let result = prepare_linked_turn_with(
            tokio::time::Instant::now(),
            cd_core::router::TurnDeadlinePlan {
                total_ms: 20,
                ..plan
            },
            &AtomicBool::new(false),
            move || {
                slow_deadline_worker.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(100));
                Ok(())
            },
            || None,
            |_| Ok(7),
        )
        .await;
        assert_eq!(result.unwrap_err(), HostReadinessFailure::TurnDeadline);
        assert_eq!(slow_deadline_calls.load(Ordering::SeqCst), 1);

        let active_cancel = Arc::new(AtomicBool::new(false));
        let cancel_trigger = active_cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel_trigger.store(true, AtomicOrdering::SeqCst);
        });
        let host_calls = Arc::new(AtomicUsize::new(0));
        let host_worker_calls = host_calls.clone();
        let result = prepare_linked_turn_with(
            tokio::time::Instant::now(),
            cd_core::router::TurnDeadlinePlan {
                total_ms: 1_000,
                ..plan
            },
            active_cancel.as_ref(),
            || {
                std::thread::sleep(Duration::from_millis(100));
                Ok(())
            },
            || None,
            move |_: ()| {
                host_worker_calls.fetch_add(1, Ordering::SeqCst);
                Ok(7)
            },
        )
        .await;
        assert_eq!(result.unwrap_err(), HostReadinessFailure::Cancelled);
        assert_eq!(host_calls.load(Ordering::SeqCst), 0);
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
    fn generic_save_rejects_a_stale_conversation_revision_without_erasing_history() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let mut original = cd_core::sessions::Session::new("Concurrent");
        original.messages.push(cd_core::sessions::StoredMessage {
            id: "user-1".into(),
            role: "user".into(),
            content: "first".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        store.save(&original).expect("save original");
        let stale_revision = original.updated_at.to_rfc3339();
        let stale = original.clone();

        let mut newer = original.clone();
        std::thread::sleep(std::time::Duration::from_millis(2));
        newer.touch();
        newer.messages.push(cd_core::sessions::StoredMessage {
            id: "assistant-1".into(),
            role: "assistant".into(),
            content: "newer durable answer".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        store.save(&newer).expect("save concurrent winner");

        let error = save_chat_session_cas_at(&store, stale, Some(&stale_revision))
            .expect_err("stale renderer must lose");
        assert!(error.starts_with("chat_session_conflict:"));
        let reopened = store.load(&original.id).expect("reopen winner");
        assert_eq!(reopened.messages.len(), 2);
        assert_eq!(reopened.messages[1].content, "newer durable answer");
    }

    #[test]
    fn retry_binding_changes_on_provider_or_model_switch_only() {
        let original = cd_core::sessions::Session::new("Bound");
        let mut same = original.clone();
        assert!(!chat_provider_binding_changed(&original, &same));

        same.provider_profile_id = Some("private-provider".into());
        assert!(chat_provider_binding_changed(&original, &same));

        let mut model_changed = original.clone();
        model_changed.chat_model = Some("other-model".into());
        assert!(chat_provider_binding_changed(&original, &model_changed));
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
    fn concurrent_empty_linked_create_does_not_duplicate_or_orphan() {
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

        let draft_a = cd_core::sessions::Session::new("A");
        let draft_b = cd_core::sessions::Session::new("B");
        let a = set_chat_linked_corpus_at(
            &store,
            cache.path(),
            &draft_a.id,
            Some(report.corpus_id.clone()),
            Some(draft_a.clone()),
            Some(wire_session_revision(&draft_a)),
        )
        .expect("first create");
        let b = set_chat_linked_corpus_at(
            &store,
            cache.path(),
            &draft_b.id,
            Some(report.corpus_id.clone()),
            Some(draft_b.clone()),
            Some(wire_session_revision(&draft_b)),
        )
        .expect("second create");
        assert_ne!(a.id, b.id);
        assert_eq!(
            a.linked_corpus_id.as_deref(),
            Some(report.corpus_id.as_str())
        );
        assert_eq!(
            b.linked_corpus_id.as_deref(),
            Some(report.corpus_id.as_str())
        );

        // Invalid corpus creates no orphan.
        let orphan = cd_core::sessions::Session::new("Orphan");
        let err = set_chat_linked_corpus_at(
            &store,
            cache.path(),
            &orphan.id,
            Some("missing-corpus".into()),
            Some(orphan.clone()),
            Some(wire_session_revision(&orphan)),
        )
        .expect_err("missing corpus");
        assert!(!err.is_empty());
        assert!(!store.exists(&orphan.id).expect("orphan existence"));

        // First-turn load path sees the durable linked session (no "not available").
        let loaded = load_session_for_turn(&store, &a.id)
            .expect("load")
            .expect("session present");
        assert_eq!(
            loaded.linked_corpus_id.as_deref(),
            Some(report.corpus_id.as_str())
        );
        let ctx = linked_log_turn_context(
            Some(&loaded),
            "win-1",
            Some(LogExplorerTurnContextReq {
                corpus_id: report.corpus_id.clone(),
                brief: "privacy-safe brief".into(),
                noise_lens_suspended: false,
            }),
        )
        .expect("turn context");
        assert!(ctx.is_some());
    }

    #[test]
    fn governed_log_citation_id_uses_strict_u64_grammar() {
        assert!(is_governed_log_citation_id("log_event:42"));
        assert!(is_governed_log_citation_id("log_template:7"));
        assert!(is_governed_log_citation_id(
            "log_event:18446744073709551615"
        ));
        assert!(!is_governed_log_citation_id("log_event:"));
        assert!(!is_governed_log_citation_id("log_event:42/../x"));
        assert!(!is_governed_log_citation_id("LOG_EVENT:42"));
        assert!(!is_governed_log_citation_id("log_event:event_42"));
        assert!(!is_governed_log_citation_id(
            "log_event:18446744073709551616"
        ));
        assert!(!is_governed_log_citation_id("log_event:01"));
    }

    #[test]
    fn exact_nav_target_parse_and_deliver_once_store() {
        let parsed = parse_log_explorer_nav_target("event", "9007199254740993")
            .expect("unsafe-for-JS u64 still parses on host");
        assert_eq!(parsed.id, "9007199254740993");
        assert_eq!(parsed.value, 9007199254740993);
        assert!(parse_log_explorer_nav_target("event", "01").is_err());
        assert!(parse_log_explorer_nav_target("EVENT", "1").is_err());
        assert!(parse_log_explorer_nav_target("event", "18446744073709551616").is_err());

        let mut store = LogExplorerNavTargetStore::default();
        let corpus_a = "corpus-a".to_string();
        let corpus_b = "corpus-b".to_string();
        let target_a = LogExplorerNavTarget {
            kind: "event".into(),
            id: "42".into(),
        };
        let target_b = LogExplorerNavTarget {
            kind: "template".into(),
            id: "7".into(),
        };
        store.set(corpus_a.clone(), target_a.clone());
        store.set(corpus_b.clone(), target_b.clone());
        // Colliding bare ids across corpora stay independent.
        store.set(
            corpus_b.clone(),
            LogExplorerNavTarget {
                kind: "event".into(),
                id: "42".into(),
            },
        );
        assert_eq!(store.peek(&corpus_a).map(|t| t.id.as_str()), Some("42"));
        let first = store.take(&corpus_a).expect("first take");
        assert_eq!(first, target_a);
        assert!(store.take(&corpus_a).is_none(), "deliver-once: no replay");
        // Rapid replace: last writer wins, prior undelivered target dropped.
        store.set(
            corpus_b.clone(),
            LogExplorerNavTarget {
                kind: "event".into(),
                id: "99".into(),
            },
        );
        let last = store.take(&corpus_b).expect("last target");
        assert_eq!(last.id, "99");
        assert!(store.take(&corpus_b).is_none());

        // Window destroy clears undelivered targets for that label only.
        store.set(corpus_a.clone(), target_a.clone());
        store.set(
            "other".into(),
            LogExplorerNavTarget {
                kind: "event".into(),
                id: "1".into(),
            },
        );
        let label = log_explorer_window_label(&corpus_a);
        store.clear_for_window_label(&label);
        assert!(store.peek(&corpus_a).is_none());
        assert!(store.peek("other").is_some());

        // Failed window open after stage must clear so a later generic open
        // cannot take a failed citation (stale replay).
        store.set(corpus_a.clone(), target_a.clone());
        assert!(store.peek(&corpus_a).is_some());
        store.clear(&corpus_a);
        assert!(
            store.take(&corpus_a).is_none(),
            "cleared staged target must not replay on a later take"
        );
    }

    #[test]
    fn exact_nav_missing_evidence_and_corpus_fail_closed() {
        let cache = tempfile::tempdir().expect("cache");
        let logs = tempfile::tempdir().expect("logs");
        std::fs::write(
            logs.path().join("app.log"),
            b"2026-07-28T12:00:00Z ERROR checkout failed\n",
        )
        .expect("fixture");
        let report =
            cd_core::log_analysis::ingest_path(cache.path(), logs.path(), "nav", None, "none")
                .expect("ingest");
        let corpus =
            cd_core::log_analysis::LogCorpus::open(cache.path(), &report.corpus_id).expect("open");

        let event0 = parse_log_explorer_nav_target("event", "0").expect("event 0");
        ensure_log_nav_evidence_exists(&corpus, &event0).expect("seq 0 exists after ingest");

        let missing = parse_log_explorer_nav_target("event", "999999").expect("grammar ok");
        let err = ensure_log_nav_evidence_exists(&corpus, &missing).expect_err("missing event");
        assert!(
            err.to_lowercase().contains("not found"),
            "missing evidence must fail visibly: {err}"
        );

        let missing_template =
            parse_log_explorer_nav_target("template", "999999").expect("grammar ok");
        let err = ensure_log_nav_evidence_exists(&corpus, &missing_template)
            .expect_err("missing template");
        assert!(
            err.to_lowercase().contains("not found"),
            "missing template must fail visibly: {err}"
        );

        // Discarded corpus cannot be opened for substitution.
        cd_core::log_analysis::LogCorpus::discard(cache.path(), &report.corpus_id)
            .expect("discard");
        assert!(
            cd_core::log_analysis::LogCorpus::open(cache.path(), &report.corpus_id).is_err(),
            "discarded corpus must not open"
        );
    }

    #[test]
    fn generic_save_cannot_forge_or_broaden_log_citation_corpus_id() {
        assert!(is_governed_log_citation_id("log_event:42"));
        assert!(!is_governed_log_citation_id("log_event:"));
        assert!(!is_governed_log_citation_id("log_event:42/../x"));

        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let mut durable = cd_core::sessions::Session::new("Grounded");
        durable.set_linked_corpus_id(Some("trusted-corpus".into()));
        durable.messages.push(cd_core::sessions::StoredMessage {
            id: "assistant-1".into(),
            role: "assistant".into(),
            content: "finding".into(),
            tools: None,
            citations: Some(serde_json::json!([{
                "id": "log_event:42",
                "label": "event 42",
                "corpusId": "trusted-corpus"
            }])),
            trail: None,
            meta: None,
        });
        store.save(&durable).expect("save durable");

        // Detach: clear linked_corpus_id but keep historical citation provenance.
        let mut detached = store.load(&durable.id).expect("load");
        detached.set_linked_corpus_id(None);
        store.save(&detached).expect("detach save");

        let mut renderer = store.load(&durable.id).expect("load");
        renderer.messages[0].citations = Some(serde_json::json!([{
            "id": "log_event:42",
            "label": "event 42",
            "corpusId": "attacker-corpus"
        },{
            "id": "runbook.md",
            "label": "runbook",
            "corpusId": "must-not-apply"
        }]));
        let saved = save_chat_session_at(&store, renderer).expect("save");
        let citations = saved.messages[0]
            .citations
            .as_ref()
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            citations[0]["corpusId"].as_str(),
            Some("trusted-corpus"),
            "historical host provenance must win over renderer forgery"
        );
        assert!(citations[1].get("corpusId").is_none());

        // New log citation while linked stamps host corpus; model corpus ignored.
        let mut linked = store.load(&durable.id).expect("load");
        linked.set_linked_corpus_id(Some("trusted-corpus".into()));
        store.save(&linked).expect("relink");
        let mut renderer2 = store.load(&durable.id).expect("load");
        renderer2.messages.push(cd_core::sessions::StoredMessage {
            id: "assistant-2".into(),
            role: "assistant".into(),
            content: "new finding".into(),
            tools: None,
            citations: Some(serde_json::json!([{
                "id": "log_template:7",
                "label": "template 7",
                "corpusId": "smuggled"
            }])),
            trail: None,
            meta: None,
        });
        let saved2 = save_chat_session_at(&store, renderer2).expect("save2");
        let new_cite = saved2
            .messages
            .iter()
            .find(|m| m.id == "assistant-2")
            .and_then(|m| m.citations.as_ref())
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .cloned()
            .expect("new cite");
        assert_eq!(new_cite["corpusId"].as_str(), Some("trusted-corpus"));
    }

    #[test]
    fn generic_save_preserves_equal_log_ids_bound_to_distinct_corpora() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let mut durable = cd_core::sessions::Session::new("Cross-corpus evidence");
        durable.messages.push(cd_core::sessions::StoredMessage {
            id: "assistant-cross-corpus".into(),
            role: "assistant".into(),
            content: "comparison".into(),
            tools: None,
            citations: Some(serde_json::json!([
                {"id":"log_event:7","label":"A","corpusId":"corpus-a"},
                {"id":"log_event:7","label":"B","corpusId":"corpus-b"}
            ])),
            trail: None,
            meta: None,
        });
        store.save(&durable).expect("save durable");

        let renderer = store.load(&durable.id).expect("load renderer");
        let saved = save_chat_session_at(&store, renderer).expect("generic save");
        let citations = saved.messages[0]
            .citations
            .as_ref()
            .and_then(|value| value.as_array())
            .expect("citations");
        assert_eq!(citations.len(), 2);
        assert_eq!(citations[0]["corpusId"], "corpus-a");
        assert_eq!(citations[1]["corpusId"], "corpus-b");
    }

    /// #698 — durable legacy log citations without corpusId stay unbound even
    /// when the session remains linked; save must not rewrite history onto the
    /// current corpus (substitution).
    #[test]
    fn generic_save_leaves_durable_unbound_log_citations_unbound() {
        let sessions_root = tempfile::tempdir().expect("sessions");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let mut durable = cd_core::sessions::Session::new("Legacy unbound");
        durable.set_linked_corpus_id(Some("trusted-corpus".into()));
        durable.messages.push(cd_core::sessions::StoredMessage {
            id: "assistant-legacy".into(),
            role: "assistant".into(),
            content: "old finding".into(),
            tools: None,
            // Present on disk without corpusId — historical fail-closed.
            citations: Some(serde_json::json!([
                {
                    "id": "log_event:99",
                    "label": "log_event:99"
                },
                {
                    "id": "log_template:3",
                    "label": "log_template:3"
                }
            ])),
            trail: None,
            meta: None,
        });
        store.save(&durable).expect("save durable unbound");

        // Renderer still linked and tries to invent provenance for history.
        let mut renderer = store.load(&durable.id).expect("load");
        assert_eq!(renderer.linked_corpus_id.as_deref(), Some("trusted-corpus"));
        renderer.messages[0].citations = Some(serde_json::json!([
            {
                "id": "log_event:99",
                "label": "log_event:99",
                "corpusId": "attacker-or-current-link"
            },
            {
                "id": "log_template:3",
                "label": "log_template:3",
                "corpusId": "trusted-corpus"
            }
        ]));
        let saved = save_chat_session_at(&store, renderer).expect("save");
        let citations = saved.messages[0]
            .citations
            .as_ref()
            .and_then(|v| v.as_array())
            .cloned()
            .expect("citations");
        assert_eq!(citations.len(), 2);
        for item in &citations {
            assert!(
                item.get("corpusId").is_none() && item.get("corpus_id").is_none(),
                "durable unbound log citation must stay unbound: {item}"
            );
        }
        // Reopen proves persistence.
        let reopened = store.load(&durable.id).expect("reopen");
        let reopened_cites = reopened.messages[0]
            .citations
            .as_ref()
            .and_then(|v| v.as_array())
            .cloned()
            .expect("reopened citations");
        for item in &reopened_cites {
            assert!(
                item.get("corpusId").is_none() && item.get("corpus_id").is_none(),
                "reopened unbound citation must remain unbound: {item}"
            );
        }
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
    fn desktop_close_reopen_history_seed_contract_preserves_full_transcript() {
        let sessions_root = tempfile::tempdir().expect("sessions root");
        let store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let mut session = cd_core::sessions::Session::new("Continuity lifecycle");
        session.id = "desktop-continuity-contract".into();
        session.pinned_skill_id = Some("synthetic-triage".into());
        for index in 0..68 {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            let content = if index == 0 {
                "EARLY_DESKTOP_STATE=origin-only; CONSTRAINT=no-restart".to_string()
            } else {
                format!("neutral desktop transcript message {index}")
            };
            session.messages.push(cd_core::sessions::StoredMessage {
                id: format!("desktop-message-{index}"),
                role: role.into(),
                content,
                tools: (index == 17)
                    .then(|| serde_json::json!({"status":"finished","name":"synthetic_read"})),
                citations: (index == 19)
                    .then(|| serde_json::json!([{"id":"synthetic-citation","label":"neutral"}])),
                trail: (index == 21).then(|| vec!["neutral-search-step".into()]),
                meta: (index == 23).then(|| serde_json::json!({"model":"synthetic-model"})),
            });
        }
        let expected_messages = serde_json::to_value(&session.messages).unwrap();

        let saved = save_chat_session_at(&store, session).expect("desktop save contract");
        assert_eq!(saved.messages.len(), 68);
        drop(store);

        let reopened_store = cd_core::sessions::SessionStore::new(sessions_root.path());
        let reopened = reopened_store
            .load("desktop-continuity-contract")
            .expect("desktop reopen contract");
        assert_eq!(reopened.messages.len(), 68);
        assert_eq!(
            serde_json::to_value(&reopened.messages).unwrap(),
            expected_messages,
            "desktop save/load must preserve every transcript field exactly"
        );
        assert_eq!(
            reopened.pinned_skill_id.as_deref(),
            Some("synthetic-triage")
        );
        let seeded = reopened.to_chat_history();
        assert_eq!(seeded.len(), reopened.messages.len());
        for (model_message, stored_message) in seeded.iter().zip(&reopened.messages) {
            assert_eq!(model_message.content, stored_message.content);
            assert_eq!(
                format!("{:?}", model_message.role).to_ascii_lowercase(),
                stored_message.role
            );
        }

        // Source contract for the shipped Tauri path: load must seed the cache,
        // the seed must use Session::to_chat_history, and agent_turn must clone
        // that session-keyed cache into the shared workflow turn kernel. The
        // workflow kernel, in turn, must forward it to the core provider path.
        let source = include_str!("lib.rs");
        let load_start = source
            .find("fn load_chat_session(")
            .expect("load_chat_session command");
        let load_end = source[load_start..]
            .find("fn should_persist_chat_session(")
            .map(|offset| load_start + offset)
            .expect("load command boundary");
        let load_contract = &source[load_start..load_end];
        assert!(load_contract.contains("store.load(&id)"));
        assert!(load_contract.contains("seed_history_from_session(&state, &session)"));

        let seed_start = source
            .find("fn seed_history_from_session(")
            .expect("history seed helper");
        let seed_end = source[seed_start..]
            .find("fn normalize_log_corpus_id(")
            .map(|offset| seed_start + offset)
            .expect("seed helper boundary");
        let seed_contract = &source[seed_start..seed_end];
        assert!(seed_contract.contains("session.to_chat_history()"));
        assert!(seed_contract.contains("histories.insert(session.id.clone(), hist)"));

        let agent_start = source
            .find("async fn agent_turn(")
            .expect("agent_turn command");
        let agent_end = source[agent_start..]
            .find("fn cancel_turn(")
            .map(|offset| agent_start + offset)
            .expect("agent command boundary");
        let agent_contract = &source[agent_start..agent_end];
        assert!(agent_contract.contains("histories.entry(req.session_id.clone())"));
        assert!(agent_contract.contains("cd_workflow::turn::run_turn"));
        assert!(agent_contract.contains("client_assistant_message_id"));
        assert!(
            agent_contract.contains("format!(\"{}::{}\", req.session_id, uuid::Uuid::new_v4())")
        );
        assert!(!agent_contract.contains("format!(\"{}::{message_id}\", req.session_id)"));
        assert!(agent_contract.contains("reserve_investigation_answer_message"));
        assert!(agent_contract.contains("turn_id: Some(turn_id.clone())"));
        assert!(!agent_contract
            .contains("research_turn_with_cancel_and_context_and_checkpoint_and_trace"));

        let workflow_turn = include_str!("../../../crates/cd-workflow/src/turn.rs");
        let shared_start = workflow_turn
            .find("pub async fn run_turn(")
            .expect("shared workflow turn kernel");
        let shared_end = workflow_turn[shared_start..]
            .find("/// Prior tool-host state")
            .map(|offset| shared_start + offset)
            .expect("shared workflow turn boundary");
        assert!(workflow_turn[shared_start..shared_end]
            .contains("research_turn_with_cancel_and_context_and_checkpoint_and_trace"));
    }

    fn opt(key: &str, hidden: bool, is_default: bool) -> ModelOptionDto {
        ModelOptionDto {
            id: key.into(),
            label: key.into(),
            selection_key: key.into(),
            provider_id: "p".into(),
            provider_label: "P".into(),
            group: "P".into(),
            is_default,
            tools_enabled: true,
            tools_disabled_reason: None,
            availability: ModelAvailability::Discovered,
            availability_detail: None,
            readiness: cd_core::capability_qualification::ModelReadiness::unverified(key),
            hidden,
            hidden_by: hidden.then(|| "model".to_string()),
            pinned_rank: None,
        }
    }

    #[test]
    fn ordinary_pickers_do_not_receive_curated_away_models() {
        let mut out = vec![opt("p::keep", false, false), opt("p::gone", true, false)];
        retain_picker_visible(&mut out, false, None);
        assert_eq!(
            out.iter()
                .map(|m| m.selection_key.as_str())
                .collect::<Vec<_>>(),
            vec!["p::keep"]
        );
    }

    #[test]
    fn a_hidden_default_is_still_offered_so_new_chats_have_a_model() {
        let mut out = vec![opt("p::a", false, false), opt("p::def", true, true)];
        retain_picker_visible(&mut out, false, None);
        assert!(out.iter().any(|m| m.selection_key == "p::def"));
    }

    #[test]
    fn an_explicitly_kept_selection_survives_the_filter() {
        // A chat pinned to a hidden model must still get an option for it.
        let mut out = vec![opt("p::a", false, false), opt("p::mine", true, false)];
        retain_picker_visible(&mut out, false, Some(vec!["  p::mine  ".into()]));
        assert!(out.iter().any(|m| m.selection_key == "p::mine"));
    }

    #[test]
    fn the_management_surface_receives_everything() {
        let mut out = vec![opt("p::a", false, false), opt("p::b", true, false)];
        retain_picker_visible(&mut out, true, None);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn blank_keep_keys_do_not_accidentally_keep_everything() {
        let mut out = vec![opt("p::a", false, false), opt("p::b", true, false)];
        retain_picker_visible(&mut out, false, Some(vec!["".into(), "   ".into()]));
        assert_eq!(out.len(), 1);
    }

    fn impact(
        affects_default: bool,
        replacement: Option<&str>,
        remaining: u32,
    ) -> CurationImpactDto {
        CurationImpactDto {
            affects_default,
            replacement_key: replacement.map(str::to_string),
            replacement_label: replacement.map(|r| format!("label {r}")),
            remaining_visible: remaining,
            state_token: "state-1".into(),
        }
    }

    #[test]
    fn curation_that_leaves_the_default_alone_applies_without_confirmation() {
        let decision = curation_decision(&impact(false, Some("p::other"), 4), None);
        assert_eq!(decision, CurationDecision::Apply);
    }

    #[test]
    fn hiding_the_default_is_refused_until_the_exact_replacement_is_echoed_back() {
        let i = impact(true, Some("p::replacement"), 3);

        // No confirmation at all.
        let CurationDecision::Reject(message) = curation_decision(&i, None) else {
            panic!("hiding the default without confirmation must be refused");
        };
        assert!(
            message.contains("p::replacement"),
            "the refusal must name the exact replacement the user will get: {message}"
        );

        // A *different* key must not be accepted as consent.
        assert!(matches!(
            curation_decision(&i, Some("p::something-else")),
            CurationDecision::Reject(_)
        ));

        // Echoing the previewed replacement promotes it in the same write.
        assert_eq!(
            curation_decision(&i, Some("p::replacement")),
            CurationDecision::ApplyWithDefault("p::replacement".into())
        );
    }

    #[test]
    fn confirmation_tolerates_surrounding_whitespace_only() {
        let i = impact(true, Some("p::replacement"), 2);
        assert_eq!(
            curation_decision(&i, Some("  p::replacement  ")),
            CurationDecision::ApplyWithDefault("p::replacement".into())
        );
        assert!(matches!(
            curation_decision(&i, Some("p::replacemen")),
            CurationDecision::Reject(_)
        ));
    }

    #[test]
    fn hiding_the_last_visible_model_is_refused_outright() {
        let CurationDecision::Reject(message) =
            curation_decision(&impact(true, None, 0), Some("anything"))
        else {
            panic!("emptying the picker must be refused");
        };
        assert!(
            message.contains("at least one model must stay visible"),
            "message should explain the honest way out: {message}"
        );
    }

    #[test]
    fn an_empty_inventory_is_refused_even_when_the_default_is_untouched() {
        assert!(matches!(
            curation_decision(&impact(false, None, 0), None),
            CurationDecision::Reject(_)
        ));
    }

    #[test]
    fn unverified_visible_models_are_not_eligible_default_replacements() {
        let CurationDecision::Reject(message) = curation_decision(&impact(true, None, 2), None)
        else {
            panic!("an unverified replacement must not be applied silently");
        };
        assert!(message.contains("discovered replacement"));
    }

    #[test]
    fn curation_state_token_rejects_provider_or_default_drift() {
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        let token = curation_state_token(&cfg).expect("token");
        require_preview_state(&cfg, Some(&token)).expect("same state");
        cfg.default_chat_model = Some("different".into());
        let error = require_preview_state(&cfg, Some(&token)).expect_err("drift");
        assert!(error.contains("changed after preview"));
    }

    #[test]
    fn curation_never_removes_provider_configuration_or_credentials() {
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        let profile = cfg.providers.active().expect("local profile").clone();
        let before_profiles = cfg.providers.profiles.clone();

        cfg.model_curation.set_provider_hidden(&profile, true);
        cfg.model_curation
            .set_model_hidden(&profile, "mistral", true);

        assert_eq!(
            cfg.providers.profiles, before_profiles,
            "hiding must not touch profiles, base URLs, or api_key_ref"
        );
        assert!(
            cfg.providers.active().is_some(),
            "hiding must not clear the active provider"
        );
    }

    #[test]
    fn hidden_state_is_independent_of_tool_capability_truth() {
        // Hiding a model must not make a tools-rejected model look healthy.
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        let profile = cfg.providers.active().expect("local profile").clone();
        cfg.model_tools_enabled
            .insert(model_selection_key(&profile.id, "dolphin"), false);

        cfg.model_curation
            .set_model_hidden(&profile, "dolphin", true);

        assert!(
            !model_tools_enabled(&cfg, &profile, "dolphin"),
            "curation must not launder a learned tool rejection"
        );
        assert_eq!(
            model_tools_disabled_reason(&cfg, &profile, "dolphin"),
            Some("model")
        );
    }

    #[test]
    fn learned_tool_rejection_is_scoped_to_one_provider_model() {
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
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
                noise_lens_suspended: true,
            },
        )
        .expect("matching linked context");
        assert_eq!(context.corpus_id, "corpus-a");
        assert!(context.noise_lens_suspended);
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
                noise_lens_suspended: false,
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
                noise_lens_suspended: false,
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
    fn explicitly_enabled_retrieval_roles_attach_to_the_production_host() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = cd_core::workspace::Workspace::new("roles", vec![dir.path().to_path_buf()]);
        let index = cd_core::index::KeywordIndex::new();
        let mut host = ToolHost::new(workspace, index, None);
        let mut cfg = AppConfig::default();
        cfg.retrieval.embedding = Some(cd_core::config::RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:19001/v1".into(),
            model: "bge-m3".into(),
            dialect: Some("openai_embeddings".into()),
            allow_remote: false,
            api_key_ref: None,
        });
        cfg.retrieval.reranker = Some(cd_core::config::RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:19002".into(),
            model: "qwen3-reranker-0.6b".into(),
            dialect: Some("tei_rerank_v1".into()),
            allow_remote: false,
            api_key_ref: None,
        });
        let secrets = ReferencedSecretStore::new();

        apply_configured_retrieval_roles(&mut host, &cfg, &secrets);

        assert_eq!(
            host.log_embed_backend()
                .expect("embedding role attached")
                .identity(),
            "bge-m3"
        );
        assert!(host.log_rerank_backend().is_some(), "reranker role attached");
    }

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

    /// #824 — product desktop path: host registers `default_log_embed_backend`
    /// (log-fastembed ONNX), not ConceptEmbed as the production claim.
    ///
    /// Requires a usable local ONNX model/cache. Fail hard (do not silently skip)
    /// so green CI cannot hide a missing product backend on the desktop crate.
    #[test]
    fn product_host_init_registers_default_log_embed_backend_not_concept() {
        assert!(
            cd_core::embed::log_fastembed_enabled(),
            "desktop host crate must build with log-fastembed"
        );
        let dir = tempfile::tempdir().unwrap();
        let workspace = cd_core::workspace::Workspace::new("logs", vec![dir.path().to_path_buf()]);
        let index = cd_core::index::KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);
        // Mirror production host setup in this file (default_log_embed_backend).
        let be = cd_core::embed::default_log_embed_backend()
            .expect("default_log_embed_backend must not error on desktop log-fastembed builds")
            .expect(
                "desktop log-fastembed build must supply a backend; check model cache \
                 (e.g. .fastembed_cache / HF hub AllMiniLML6V2)",
            );
        host.set_log_embed_backend(Some(be), cd_core::embed::LOCAL_LOG_EMBED_MODEL_ID);
        let (policy, backend) = desktop_local_log_embed_plan(&host);
        assert_eq!(policy.mode, cd_core::log_analysis::LogEmbedMode::Local);
        assert_eq!(
            policy.model_id,
            cd_core::embed::LOCAL_LOG_EMBED_MODEL_ID,
            "product plan must advertise the local ONNX model id, not a fixture"
        );
        assert_eq!(
            policy.defer_above_source_bytes,
            Some(cd_core::log_analysis::LOCAL_EMBED_DEFER_SOURCE_BYTES)
        );
        assert!(
            backend.is_some(),
            "product host must surface the dedicated log embed backend"
        );
        // Not ConceptEmbed: real backend must embed a tiny batch (model present).
        let be = backend.expect("backend");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let vectors = rt
            .block_on(be.embed(&[
                "connection refused to upstream".into(),
                "GET /health 200".into(),
            ]))
            .expect("product ONNX backend must embed");
        assert_eq!(vectors.len(), 2);
        assert!(
            vectors[0].len() >= 8,
            "vector dims unexpected: {}",
            vectors[0].len()
        );
    }

    /// #824 — host SoftWrite orchestration path: spawn_blocking + production
    /// policy + product ONNX backend + cancel leaves no published corpus;
    /// retry succeeds (same entry points as `run_log_ingest`).
    ///
    /// Requires product `default_log_embed_backend`. No ConceptEmbed fallback —
    /// that would green-theater a non-product path.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn host_softwrite_cancel_then_retry_uses_product_embed_plan() {
        use cd_core::log_analysis::{ingest_path_with_policy_and_observer, LogCorpus};
        use cd_core::process_progress::{
            CancelFlag, ProcessProgress, ProcessProgressObserver, ProcessProgressPhase,
            RecordingProcessProgress,
        };
        use std::io::Write;
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

        assert!(
            cd_core::embed::log_fastembed_enabled(),
            "desktop host crate must build with log-fastembed"
        );
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("bulk.log")).unwrap();
        for i in 0..12_000 {
            writeln!(f, "warn bulk line {i} padding-padding-padding").unwrap();
        }
        drop(f);
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();

        // Product plan only — fail if ONNX backend cannot be constructed.
        let mut policy = cd_core::log_analysis::LogEmbedPolicy::local_default();
        policy.model_id = cd_core::embed::LOCAL_LOG_EMBED_MODEL_ID.into();
        let embed_backend = cd_core::embed::default_log_embed_backend()
            .expect("default_log_embed_backend must not error on desktop log-fastembed builds")
            .expect(
                "product SoftWrite cancel proof requires default_log_embed_backend; \
                 model cache missing or ONNX init failed",
            );

        let flag = CancelFlag::new();
        let cancelled_mid_stream = std::sync::Arc::new(AtomicBool::new(false));
        let cancelled_flag = std::sync::Arc::clone(&cancelled_mid_stream);
        let flag_for_obs = flag.clone();
        struct CancelMid {
            flag: CancelFlag,
            hit: std::sync::Arc<AtomicBool>,
            rec: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for CancelMid {
            fn progress(&self, update: ProcessProgress) {
                if update.phase == ProcessProgressPhase::Stream
                    && update.lines_processed.unwrap_or(0) >= 1_500
                    && !self.hit.swap(true, AtomicOrdering::SeqCst)
                {
                    self.flag.cancel();
                }
                self.rec.progress(update);
            }
        }
        let observer = std::sync::Arc::new(CancelMid {
            flag: flag_for_obs,
            hit: cancelled_flag,
            rec: RecordingProcessProgress::default(),
        });

        let cache_job = cache.clone();
        let logs_job = logs.clone();
        let policy_job = policy.clone();
        let backend_job = Some(std::sync::Arc::clone(&embed_backend));
        let flag_job = flag.clone();
        let observer_job = std::sync::Arc::clone(&observer);
        let cancel_result = tokio::task::spawn_blocking(move || {
            ingest_path_with_policy_and_observer(
                &cache_job,
                &logs_job,
                "host-cancel",
                &policy_job,
                backend_job,
                observer_job.as_ref(),
                Some(&flag_job),
            )
        })
        .await
        .expect("join")
        .expect_err("cancel must fail the SoftWrite attempt");
        assert!(
            format!("{cancel_result}").to_lowercase().contains("cancel"),
            "{cancel_result}"
        );
        assert!(
            cancelled_mid_stream.load(AtomicOrdering::SeqCst),
            "cancel must fire after active stream work"
        );
        assert!(
            LogCorpus::list_ids(&cache).unwrap().is_empty(),
            "cancel must not publish a partial corpus"
        );
        assert!(
            !observer
                .rec
                .phases()
                .contains(&ProcessProgressPhase::Publish),
            "must not reach publish after cancel"
        );

        // Retry succeeds and publishes exactly one completed corpus.
        let report = tokio::task::spawn_blocking({
            let cache = cache.clone();
            let logs = logs.clone();
            let policy = policy.clone();
            let backend = Some(std::sync::Arc::clone(&embed_backend));
            move || {
                ingest_path_with_policy_and_observer(
                    &cache,
                    &logs,
                    "host-retry",
                    &policy,
                    backend,
                    &RecordingProcessProgress::default(),
                    None,
                )
            }
        })
        .await
        .expect("join")
        .expect("retry after cancel must succeed");
        let ids = LogCorpus::list_ids(&cache).unwrap();
        assert_eq!(ids.len(), 1, "relaunch must see only the completed corpus");
        assert_eq!(ids[0], report.corpus_id);
        assert!(report.stats.lines >= 12_000);
        // Relaunch/open: only the completed id is listable.
        let opened = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(opened.event_count() as u64, report.stats.lines);
        assert_eq!(
            policy.model_id,
            cd_core::embed::LOCAL_LOG_EMBED_MODEL_ID,
            "cancel/retry path must use product ONNX model id"
        );
    }
}

/// Host-layer SoftWrite Apply authority for Investigation finding view recipes (#656).
///
/// Exercises the real `apply_log_investigation_finding_view_at` path used by the
/// Tauri command — open corpus through the handle cache, revalidate exact refs,
/// fail closed on missing/stale — not string greps alone.
#[cfg(test)]
mod log_investigation_apply_host_tests {
    use super::*;
    use cd_core::investigations::{
        AddFindingInput, FindingKind, FindingViewFilters, FindingViewLane, FindingViewRecipe,
        FindingViewTimeLinkMode, InvestigationStore,
    };
    use cd_core::log_analysis::{
        ActiveTimestampBasis, BookmarkEventRef, LogCorpus, LogEvent, TimeQuality,
        TimestampProvenance,
    };

    fn fixture_corpus(cache: &std::path::Path) -> LogCorpus {
        let corpus = LogCorpus::create(cache, "host apply investigation").expect("create corpus");
        corpus
            .push_events(&[
                LogEvent {
                    seq: 10,
                    ts: 1_700_000_010,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "error".into(),
                    service: Some("api".into()),
                    host: None,
                    template_id: 1,
                    params: vec![],
                    trace_id: None,
                    message: "checkout failed".into(),
                    source: "api/app.log".into(),
                },
                LogEvent {
                    seq: 11,
                    ts: 1_700_000_011,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "info".into(),
                    service: Some("api".into()),
                    host: None,
                    template_id: 2,
                    params: vec![],
                    trace_id: None,
                    message: "retry scheduled".into(),
                    source: "api/app.log".into(),
                },
            ])
            .expect("push events");
        corpus.flush().expect("flush");
        corpus
    }

    fn event_ref(corpus: &LogCorpus, seq: u64, source: &str, ts: i64) -> BookmarkEventRef {
        BookmarkEventRef {
            corpus_id: corpus.id().to_string(),
            seq,
            source: source.into(),
            timestamp_hint: ts,
            time_quality_hint: TimeQuality::Wall,
        }
    }

    fn minimal_recipe(corpus: &LogCorpus) -> FindingViewRecipe {
        let focused = event_ref(corpus, 10, "api/app.log", 1_700_000_010);
        FindingViewRecipe {
            filters: FindingViewFilters {
                levels: vec!["error".into()],
                sources: vec![],
                services: vec![],
                hosts: vec![],
                time_from: None,
                time_to: None,
                seq_from: None,
                seq_to: None,
                template_id: None,
                trace_id: None,
                keyword: None,
            },
            lanes: vec![FindingViewLane {
                id: "lane-0".into(),
                label: "All sources".into(),
                sources: vec![],
            }],
            visible_lane_count: 1,
            time_link_mode: FindingViewTimeLinkMode::Independent,
            focused_lane_id: Some("lane-0".into()),
            focused_event: Some(focused.clone()),
            selection: vec![focused],
            highlights: vec![],
            find: None,
            viewport_anchors: vec![],
        }
    }

    #[test]
    fn apply_helper_is_registered_and_used_by_trusted_host_command() {
        let src = include_str!("lib.rs");
        assert!(
            src.contains("log_apply_investigation_finding_view,"),
            "Apply command must be registered on the SoftWrite host"
        );
        assert!(
            src.contains("fn apply_log_investigation_finding_view_at("),
            "Apply must use a testable host helper like load_active_log_investigation_at"
        );
        let command_start = src
            .find("fn log_apply_investigation_finding_view(")
            .expect("Apply command");
        // Bound Apply command body to the next investigation IPC (not later SoftWrite helpers).
        let command_end = src[command_start..]
            .find("/// Deterministic internal propose path")
            .or_else(|| src[command_start..].find("/// List chat sessions linked to a corpus"))
            .map(|offset| command_start + offset)
            .expect("command boundary");
        let command_body = &src[command_start..command_end];
        assert!(
            command_body.contains("apply_log_investigation_finding_view_at("),
            "Tauri Apply command must delegate to the SoftWrite helper, not open corpus ad-hoc"
        );
        assert!(
            command_body.contains("noise_lens"),
            "Tauri Apply command must pass the caller's explicit current suppression lens"
        );
        assert!(
            !command_body.contains("LogCorpus::open"),
            "Apply command must not bypass the shared handle-cache SoftWrite path"
        );
    }

    #[test]
    fn host_apply_finding_view_succeeds_only_when_exact_refs_verify() {
        let root = tempfile::tempdir().expect("temp root");
        let cache = root.path().join("cache");
        std::fs::create_dir_all(&cache).expect("cache dir");
        let corpus = fixture_corpus(&cache);
        let corpus_id = corpus.id().to_string();
        let store = InvestigationStore::new(root.path().join("investigations"));
        let handles = LogCorpusHandleCache::default();

        let document = store
            .create("Host Apply gate", &corpus)
            .expect("create investigation");
        let added = store
            .add_human_finding(
                &document.id,
                document.revision,
                &corpus,
                AddFindingInput {
                    kind: FindingKind::Observation,
                    title: "Checkout failure view".into(),
                    why_it_matters: "Anchors the first error for Apply.".into(),
                    event_refs: vec![event_ref(&corpus, 10, "api/app.log", 1_700_000_010)],
                    view_recipe: Some(minimal_recipe(&corpus)),
                },
            )
            .expect("add finding with view recipe");
        let finding_id = added.document.findings[0].id.clone();
        let revision_before = added.document.revision;

        let clean = apply_log_investigation_finding_view_at(
            &store,
            &handles,
            &cache,
            &corpus_id,
            &document.id,
            &finding_id,
            cd_core::investigations::InvestigationNoiseLens::Active,
        )
        .expect("verified SoftWrite Apply must succeed");
        assert_eq!(clean.missing_count, 0);
        assert_eq!(clean.stale_count, 0);
        assert_eq!(clean.finding_id, finding_id);
        assert_eq!(
            clean.policy_binding.status,
            cd_core::investigations::InvestigationPolicyBindingStatus::Current
        );
        assert_eq!(
            clean.view_recipe.filters.levels,
            vec!["error".to_string()],
            "returned recipe must be the durable payload-free recipe"
        );
        // Apply is non-mutating for the Investigation document.
        assert_eq!(
            store
                .load(&document.id, &corpus)
                .expect("reload")
                .document
                .revision,
            revision_before
        );
    }

    #[test]
    fn host_apply_finding_view_fails_closed_on_missing_refs_and_unknown_finding() {
        let root = tempfile::tempdir().expect("temp root");
        let cache = root.path().join("cache");
        std::fs::create_dir_all(&cache).expect("cache dir");
        let corpus = fixture_corpus(&cache);
        let corpus_id = corpus.id().to_string();
        let store = InvestigationStore::new(root.path().join("investigations"));
        let handles = LogCorpusHandleCache::default();

        let document = store
            .create("Host Apply fail-closed", &corpus)
            .expect("create investigation");
        let added = store
            .add_human_finding(
                &document.id,
                document.revision,
                &corpus,
                AddFindingInput {
                    kind: FindingKind::Hypothesis,
                    title: "Potentially stale Apply".into(),
                    why_it_matters: "Missing exact identity must block Apply.".into(),
                    event_refs: vec![event_ref(&corpus, 10, "api/app.log", 1_700_000_010)],
                    view_recipe: Some(minimal_recipe(&corpus)),
                },
            )
            .expect("add finding");
        let finding_id = added.document.findings[0].id.clone();
        let revision_before = added.document.revision;

        // Warm the SoftWrite handle cache the same way Explorer would.
        let warm = handles
            .open(&cache, &corpus_id)
            .expect("open corpus handle");
        warm.with_connection(|connection| {
            connection
                .execute("DELETE FROM events WHERE seq = 10", [])
                .map_err(|error| cd_core::CoreError::Message(format!("test delete: {error}")))?;
            Ok(())
        })
        .expect("delete exact event");

        let err = apply_log_investigation_finding_view_at(
            &store,
            &handles,
            &cache,
            &corpus_id,
            &document.id,
            &finding_id,
            cd_core::investigations::InvestigationNoiseLens::Active,
        )
        .expect_err("missing exact refs must fail closed on SoftWrite Apply path");
        assert!(
            err.contains("Apply blocked") && err.contains("missing"),
            "typed fail-closed explanation required, got: {err}"
        );

        let missing_finding = apply_log_investigation_finding_view_at(
            &store,
            &handles,
            &cache,
            &corpus_id,
            &document.id,
            "019fa8d0-0000-7000-8000-00000000dead",
            cd_core::investigations::InvestigationNoiseLens::Active,
        )
        .expect_err("unknown finding must fail closed");
        assert!(
            !missing_finding.is_empty(),
            "unknown finding must return a non-empty host error"
        );

        // Failed Apply must not advance or rewrite the Investigation revision.
        assert_eq!(
            store
                .load(&document.id, &corpus)
                .expect("reload after fail-closed Apply")
                .document
                .revision,
            revision_before
        );
    }
}
