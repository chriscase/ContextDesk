//! Corpus event store (#358) — embedded **DuckDB** for line events.
//!
//! Design: LOG_ANALYSIS.md §4 / §10. DuckDB is MIT (crate `duckdb` 1.x).
//! Template vectors stay on pure-Rust [`VectorIndex`] (Exact/Hnsw) — DuckDB is
//! the **event** store only, not the ANN backend.

use super::drain::TemplateInfo;
use super::ingest_pipeline::{
    classify_ingest_pipeline_identity, deserialize_optional_ingest_pipeline_identity,
    serialize_optional_ingest_pipeline_identity, IngestPipelineCompatibility,
    INGEST_PIPELINE_IDENTITY,
};
use super::parse::{ActiveTimestampBasis, TimestampProvenance};
use super::redact_log::RedactedOriginal;
use crate::error::{CoreError, CoreResult};
use crate::vector_index::{backend_name, select_backend, VectorIndex};
use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use uuid::Uuid;

/// Corpus identifier (UUIDv7 string).
pub type CorpusId = String;

/// Engine id recorded in meta.json (close-proof must show this, not mem_columnar).
pub const EVENT_ENGINE: &str = "duckdb";

/// `meta.json` schema version (v2 adds persisted ingest stats).
pub const META_VERSION: u32 = 2;

/// Bound application-owned corpus metadata before allocation or parsing.
const MAX_CORPUS_META_BYTES: u64 = 8 * 1024 * 1024;

/// Maximum exact event-count predicates retained by one open corpus.
///
/// Explorer filters are user-controlled and therefore unbounded over time.
/// Keeping this cache deliberately small prevents count optimization from
/// becoming a second corpus-sized store.
const EVENT_COUNT_CACHE_CAP: usize = 64;

/// All handles for one corpus database share one process-local revision clock.
///
/// Event-level publication can happen through a different `LogCorpus` handle
/// than an already-open Explorer or tool host. A shared clock makes those
/// handles reject cached facts from the prior DuckDB transaction immediately.
static EVENT_REVISION_CLOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<AtomicU64>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Process-local revision for deterministic template metadata.
///
/// Template patterns/counts are immutable after import in production. This
/// clock nevertheless lets concurrent in-process maintenance or tests make a
/// pinned investigation fail closed instead of mixing old and new metadata.
/// Embedding-vector updates intentionally do not advance it because vectors are
/// not part of deterministic broad-log triage.
static TEMPLATE_ANALYSIS_REVISION_CLOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<AtomicU64>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

type TemplateIdentityStore = Mutex<HashMap<u64, TemplateIdentity>>;

/// Process-local shared deterministic identity metadata for reopened handles.
///
/// The revision clock alone cannot make a handle coherent if each handle owns
/// a different stale identity snapshot. Vectors intentionally remain
/// handle-local with their corresponding vector indexes.
static TEMPLATE_IDENTITY_STORES: LazyLock<Mutex<HashMap<PathBuf, Weak<TemplateIdentityStore>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Reopened handles for one corpus share one serialized DuckDB connection.
///
/// A separately opened DuckDB connection can retain the snapshot from before
/// another connection commits an event revision. Sharing the connection keeps
/// already-open query handles on the same publication boundary.
static CORPUS_CONNECTIONS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<Connection>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Fixed-size identity for an exact event-count predicate.
///
/// Query code hashes a canonical, typed predicate representation. Keeping the
/// key opaque here avoids coupling the event store to Explorer query DTOs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct EventCountCacheKey(pub(crate) [u8; 32]);

#[derive(Debug, Clone, Copy)]
struct CachedEventCount {
    revision: u64,
    count: u64,
}

#[derive(Default)]
struct EventCountCache {
    entries: HashMap<EventCountCacheKey, CachedEventCount>,
    order: VecDeque<EventCountCacheKey>,
}

impl EventCountCache {
    fn get(&mut self, key: &EventCountCacheKey, revision: u64) -> Option<u64> {
        let entry = self.entries.get(key).copied()?;
        if entry.revision != revision {
            self.entries.remove(key);
            self.order.retain(|candidate| candidate != key);
            return None;
        }
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(*key);
        Some(entry.count)
    }

    fn insert(&mut self, key: EventCountCacheKey, entry: CachedEventCount) {
        self.order.retain(|candidate| candidate != &key);
        self.entries.insert(key, entry);
        self.order.push_back(key);
        while self.entries.len() > EVENT_COUNT_CACHE_CAP {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            self.entries.remove(&evicted);
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }
}

/// Snapshot of ingest / corpus statistics (persisted in meta.json).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusStats {
    /// Files successfully read through EOF and imported.
    pub files: u64,
    /// File entries discovered before policy/read decisions.
    #[serde(default)]
    pub discovered_files: u64,
    /// Files excluded by an explicit policy guard.
    #[serde(default)]
    pub excluded_files: u64,
    /// Files that could not be opened or completely read.
    #[serde(default)]
    pub failed_files: u64,
    /// Entries intentionally ignored.
    #[serde(default)]
    pub ignored_files: u64,
    /// Counts by stable exclusion/failure reason.
    #[serde(default)]
    pub exclusion_counts: std::collections::BTreeMap<String, u64>,
    /// Bounded basename-only examples (`reason: basename`).
    #[serde(default)]
    pub exclusion_examples: Vec<String>,
    /// True when discovered content was not fully imported.
    #[serde(default)]
    pub partial: bool,
    /// Lines parsed.
    pub lines: u64,
    /// Distinct templates.
    pub templates: u64,
    /// lines / templates (0 if no templates).
    pub reduction_ratio: f64,
    /// Templates newly embedded at ingest.
    pub embedded: u64,
    /// Bytes read from source files (pre-redact).
    pub source_bytes: u64,
    /// On-disk footprint of corpus artifacts after flush.
    pub corpus_bytes: u64,
    /// Counts by normalized level (error/warn/info/…).
    #[serde(default)]
    pub level_counts: std::collections::BTreeMap<String, u64>,
    /// Earliest event ts (unix secs), if any.
    pub ts_min: Option<i64>,
    /// Latest event ts (unix secs), if any.
    pub ts_max: Option<i64>,
    /// Counts by parse format (json/logfmt/syslog/plain).
    #[serde(default)]
    pub format_counts: std::collections::BTreeMap<String, u64>,
    /// Counts by explicit timestamp provenance.
    #[serde(default)]
    pub timestamp_provenance_counts: std::collections::BTreeMap<String, u64>,
    /// Counts by reversible active timestamp basis.
    #[serde(default)]
    pub active_timestamp_basis_counts: std::collections::BTreeMap<String, u64>,
}

/// Top template row saved at end of ingest for UI without full template load.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopTemplateSnapshot {
    /// Template id.
    pub id: u64,
    /// Drain pattern text.
    pub pattern: String,
    /// Event count for this template.
    pub count: u64,
    /// Severity score 0–max.
    pub severity: u8,
}

/// Persisted availability of semantic template vectors for a corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingState {
    /// No template vectors are available; keyword/structured analysis remains usable.
    #[default]
    KeywordOnly,
    /// Local embedding was deliberately deferred by the bulk policy.
    Deferred,
    /// Some, but not all, templates have vectors.
    Partial,
    /// Every template has a vector.
    Complete,
}

/// Non-secret, restart-safe embedding status stored in `meta.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusEmbeddingStatus {
    /// Current semantic availability.
    #[serde(default)]
    pub state: EmbeddingState,
    /// Local model identity when known; never a credential or endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Templates with vectors.
    #[serde(default)]
    pub embedded_templates: u64,
    /// Total templates at the last embedding decision.
    #[serde(default)]
    pub total_templates: u64,
    /// Stable non-sensitive policy/result reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Unix time of the last completed embedding decision.
    #[serde(default)]
    pub updated_at: i64,
}

impl Default for CorpusEmbeddingStatus {
    fn default() -> Self {
        Self {
            state: EmbeddingState::KeywordOnly,
            model_id: None,
            embedded_templates: 0,
            total_templates: 0,
            reason: Some("legacy_or_not_embedded".into()),
            updated_at: 0,
        }
    }
}

/// Full corpus meta.json document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusMeta {
    /// Schema version for meta.json.
    #[serde(default = "default_meta_version")]
    pub meta_version: u32,
    /// Corpus id (UUID).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Unix creation time.
    pub created_at: i64,
    /// Event engine id (`duckdb`).
    pub engine: String,
    /// License note for close-proof.
    #[serde(default)]
    pub license: String,
    /// Vector index backend description.
    #[serde(default)]
    pub vector_index: String,
    /// Basename-only source label (never a home path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
    /// Original package id when imported from another machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_corpus_id: Option<String>,
    /// Reserved host-managed identity, written before atomic publication.
    ///
    /// Ordinary user ingest and portable package import leave this absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_identity: Option<String>,
    /// Semantic ingest-pipeline identity (parse/frame/normalize/template/storage).
    ///
    /// Absent on pre-provenance corpora → [`IngestPipelineCompatibility::LegacyUnknown`].
    /// Never a Git SHA, path, or secret.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_ingest_pipeline_identity",
        serialize_with = "serialize_optional_ingest_pipeline_identity",
        skip_serializing_if = "Option::is_none"
    )]
    pub ingest_pipeline_identity: Option<String>,
    /// Ingest / corpus statistics when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<CorpusStats>,
    /// Top templates snapshot from last ingest.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub top_templates: Vec<TopTemplateSnapshot>,
    /// Actual semantic-vector availability and local model identity.
    #[serde(default)]
    pub embedding: CorpusEmbeddingStatus,
}

impl CorpusMeta {
    /// Compatibility of this meta's pipeline identity vs the running process.
    pub fn ingest_pipeline_compatibility(&self) -> IngestPipelineCompatibility {
        classify_ingest_pipeline_identity(self.ingest_pipeline_identity.as_deref())
    }
}

fn default_meta_version() -> u32 {
    1
}

/// Lightweight summary for list UIs (no full open analysis).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusSummary {
    /// Corpus id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Event / line count.
    pub event_count: u64,
    /// Template count.
    pub template_count: u64,
    /// Event engine id.
    pub engine: String,
    /// Unix creation time.
    pub created_at: i64,
    /// Basename-only source label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
    /// Persisted semantic ingest-pipeline identity when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingest_pipeline_identity: Option<String>,
    /// Host-neutral compatibility vs this process's pipeline (always set).
    pub ingest_pipeline_compatibility: IngestPipelineCompatibility,
    /// Persisted ingest stats when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<CorpusStats>,
    /// Actual semantic-vector availability.
    #[serde(default)]
    pub embedding: CorpusEmbeddingStatus,
}

impl CorpusSummary {
    fn with_pipeline(mut self, ingest_pipeline_identity: Option<String>) -> Self {
        self.ingest_pipeline_compatibility =
            classify_ingest_pipeline_identity(ingest_pipeline_identity.as_deref());
        self.ingest_pipeline_identity = ingest_pipeline_identity;
        self
    }
}

/// One stored line event after parse/template/redact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEvent {
    /// Event sequence within corpus.
    pub seq: u64,
    /// Unix seconds.
    pub ts: i64,
    /// Durable origin of `ts`; never inferred from its numeric magnitude.
    #[serde(default)]
    pub timestamp_provenance: TimestampProvenance,
    /// Reversible active interpretation of `ts`.
    #[serde(default)]
    pub active_timestamp_basis: ActiveTimestampBasis,
    /// Exact validated local timestamp awaiting an explicit timezone decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unresolved_local_timestamp: Option<String>,
    /// Normalized level.
    pub level: String,
    /// Optional service.
    pub service: Option<String>,
    /// Optional host.
    pub host: Option<String>,
    /// Template id from Drain.
    pub template_id: u64,
    /// Redacted params.
    pub params: Vec<String>,
    /// Optional trace id.
    pub trace_id: Option<String>,
    /// Redacted message (for FTS / exemplars).
    pub message: String,
    /// Source file relative path.
    pub source: String,
}

impl LogEvent {
    pub(crate) fn validate_timestamp_provenance(&self) -> CoreResult<()> {
        const MAX_LOCAL_TIMESTAMP_BYTES: usize = 256;
        match (
            self.timestamp_provenance,
            self.active_timestamp_basis,
            self.unresolved_local_timestamp.as_deref(),
        ) {
            (
                TimestampProvenance::UnresolvedLocal,
                ActiveTimestampBasis::OrderOnly | ActiveTimestampBasis::ResolvedLocal,
                Some(value),
            ) if !value.is_empty()
                && value.len() <= MAX_LOCAL_TIMESTAMP_BYTES
                && !value.contains('\0') =>
            {
                Ok(())
            }
            (TimestampProvenance::UnresolvedLocal, _, _) => Err(CoreError::Message(
                "unresolved-local event requires a bounded timestamp value".into(),
            )),
            (TimestampProvenance::ExplicitWallClock, ActiveTimestampBasis::ExplicitWall, None)
            | (TimestampProvenance::OrderOnly, ActiveTimestampBasis::OrderOnly, None)
            | (
                TimestampProvenance::LegacyUnknown,
                ActiveTimestampBasis::LegacyUnknown | ActiveTimestampBasis::OrderOnly,
                None,
            ) => Ok(()),
            (_, _, Some(_)) => Err(CoreError::Message(
                "only unresolved-local events may retain a local timestamp".into(),
            )),
            _ => Err(CoreError::Message(
                "event timestamp origin and active basis are inconsistent".into(),
            )),
        }
    }

    /// Apply one explicit source-timezone decision to retained local evidence.
    ///
    /// The immutable parser provenance/text remain unchanged.
    pub fn apply_resolved_local_timestamp(&mut self, resolved_ts: i64) -> CoreResult<()> {
        if self.timestamp_provenance != TimestampProvenance::UnresolvedLocal
            || self.unresolved_local_timestamp.is_none()
        {
            return Err(CoreError::Message(
                "only unresolved-local events can receive a resolved timestamp".into(),
            ));
        }
        self.ts = resolved_ts;
        self.active_timestamp_basis = ActiveTimestampBasis::ResolvedLocal;
        self.validate_timestamp_provenance()
    }

    /// Clear a prior local-time resolution and restore the ingest-order value.
    ///
    /// Retained local timestamp evidence is intentionally preserved for a
    /// corrected declaration or later re-apply.
    pub fn clear_resolved_local_timestamp(&mut self) -> CoreResult<()> {
        if self.timestamp_provenance != TimestampProvenance::UnresolvedLocal {
            return Err(CoreError::Message(
                "only unresolved-local events can clear a resolved timestamp".into(),
            ));
        }
        self.ts = i64::try_from(self.seq).map_err(|_| {
            CoreError::Message("event sequence exceeds signed storage range".into())
        })?;
        self.active_timestamp_basis = ActiveTimestampBasis::OrderOnly;
        self.validate_timestamp_provenance()
    }
}

/// Ingest-only event envelope carrying the separately bounded source view.
///
/// Keeping this out of [`LogEvent`] prevents existing explorer/tool payloads
/// from automatically gaining the authoritative source representation.
#[derive(Debug, Clone)]
pub(crate) struct IngestedLogEvent {
    pub event: LogEvent,
    pub original: RedactedOriginal,
}

/// Template row persisted with the corpus (plus optional embedding hash).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateRow {
    /// Drain template info.
    pub info: TemplateInfo,
    /// Content hash of pattern (embed cache key).
    pub content_hash: String,
    /// Dense vector when embedded.
    pub vector: Option<Vec<f32>>,
}

#[derive(Debug, Clone)]
struct TemplateIdentity {
    pattern: String,
    content_hash: String,
}

impl From<&TemplateRow> for TemplateIdentity {
    fn from(row: &TemplateRow) -> Self {
        Self {
            pattern: row.info.pattern.clone(),
            content_hash: row.content_hash.clone(),
        }
    }
}

/// Disposable log corpus under app cache (events in DuckDB; templates + vectors aside).
pub struct LogCorpus {
    id: CorpusId,
    name: String,
    root: PathBuf,
    meta: Mutex<CorpusMeta>,
    db: Arc<Mutex<Connection>>,
    templates: Mutex<HashMap<u64, TemplateRow>>,
    template_identities: Arc<TemplateIdentityStore>,
    /// Vector index over template ids (Exact or Hnsw by size) — pure Rust.
    index: Mutex<Box<dyn VectorIndex>>,
    /// Diagnostics: "exact" | "hnsw".
    index_backend: Mutex<&'static str>,
    /// Exact event counts keyed by cursor-independent filter predicate.
    event_count_cache: Mutex<EventCountCache>,
    /// Changes only after a successful event append or revision publication.
    event_revision: Arc<AtomicU64>,
    /// Changes when deterministic template metadata is replaced in-process.
    template_analysis_revision: Arc<AtomicU64>,
    /// Trusted exclusion lens for Explorer-shaped queries (#819). Scoped to this
    /// handle, so it can never serve one corpus's policy to another and is
    /// bounded by however many handles the host keeps open.
    suppression_lens: Mutex<Option<super::suppression_lens::CachedSuppressionLens>>,
    /// Test instrumentation: physical `COUNT(*)` scans, not cache reads.
    #[cfg(test)]
    event_count_scans: AtomicUsize,
    /// Test instrumentation: sidecar reads plus rule resolutions, not cache hits.
    #[cfg(test)]
    suppression_lens_loads: AtomicUsize,
}

impl LogCorpus {
    /// Create empty corpus directory under `cache_root/log_corpora/{id}`.
    pub fn create(cache_root: &Path, name: impl Into<String>) -> CoreResult<Self> {
        let id = Uuid::now_v7().to_string();
        let root = cache_root.join("log_corpora").join(&id);
        std::fs::create_dir_all(&root)?;
        let name_s = name.into();
        let meta = CorpusMeta {
            meta_version: META_VERSION,
            id: id.clone(),
            name: name_s.clone(),
            created_at: crate::embed::now_unix_secs(),
            engine: EVENT_ENGINE.into(),
            license: "MIT (duckdb-rs + DuckDB)".into(),
            vector_index: "pure-rust VectorIndex (Exact/Hnsw)".into(),
            source_label: None,
            origin_corpus_id: None,
            managed_identity: None,
            ingest_pipeline_identity: Some(INGEST_PIPELINE_IDENTITY.to_string()),
            stats: None,
            top_templates: Vec::new(),
            embedding: CorpusEmbeddingStatus::default(),
        };
        write_meta_file(&root, &meta)?;
        let db_path = root.join("events.duckdb");
        let db = shared_corpus_connection(&db_path)?;
        let event_revision = shared_event_revision_clock(&db_path, 0);
        let template_analysis_revision = shared_template_analysis_revision_clock(&db_path);
        let template_identities = shared_template_identity_store(&db_path, HashMap::new());
        Ok(Self {
            id,
            name: name_s,
            root,
            meta: Mutex::new(meta),
            db,
            templates: Mutex::new(HashMap::new()),
            template_identities,
            index: Mutex::new(select_backend(0)),
            index_backend: Mutex::new(backend_name(0)),
            event_count_cache: Mutex::new(EventCountCache::default()),
            event_revision,
            template_analysis_revision,
            suppression_lens: Mutex::new(None),
            #[cfg(test)]
            event_count_scans: AtomicUsize::new(0),
            #[cfg(test)]
            suppression_lens_loads: AtomicUsize::new(0),
        })
    }

    /// Open existing corpus.
    pub fn open(cache_root: &Path, id: &str) -> CoreResult<Self> {
        validate_corpus_id(id)?;
        Self::open_contained(cache_root, id, id)
    }

    /// Open a package import while it is still hidden under its staging name.
    ///
    /// The directory name is intentionally not a public corpus id. Keep this
    /// narrow so package validation cannot weaken the public identifier policy.
    pub(super) fn open_import_staging(
        cache_root: &Path,
        staging_id: &str,
        published_id: &str,
    ) -> CoreResult<Self> {
        validate_import_staging_id(staging_id)?;
        validate_corpus_id(published_id)?;
        Self::open_contained(cache_root, staging_id, published_id)
    }

    fn open_contained(
        cache_root: &Path,
        directory_id: &str,
        metadata_id: &str,
    ) -> CoreResult<Self> {
        let root = contained_existing_corpus_root(cache_root, directory_id)?;
        let meta = read_meta_file(&root)?;
        if meta.id != metadata_id {
            return Err(CoreError::Message(format!(
                "corpus metadata id mismatch: requested {metadata_id}"
            )));
        }
        let name = meta.name.clone();
        let db_path = root.join("events.duckdb");
        // Legacy mem corpora only had events.jsonl — refuse silent wrong engine.
        if !db_path.exists() {
            if root.join("events.jsonl").exists() {
                return Err(CoreError::Message(format!(
                    "corpus {metadata_id} is legacy mem_columnar (events.jsonl); re-ingest under DuckDB"
                )));
            }
            return Err(CoreError::Message(format!(
                "corpus {metadata_id} missing events.duckdb"
            )));
        }
        let db = shared_corpus_connection(&db_path)?;
        let durable_revision = db
            .lock()
            .ok()
            .and_then(|connection| persisted_event_revision(&connection))
            .unwrap_or(0);
        let event_revision = shared_event_revision_clock(&db_path, durable_revision);
        let template_analysis_revision = shared_template_analysis_revision_clock(&db_path);

        let mut templates = HashMap::new();
        let t_path = root.join("templates.json");
        if t_path.exists() {
            let rows: Vec<TemplateRow> = serde_json::from_str(&std::fs::read_to_string(&t_path)?)?;
            for r in rows {
                templates.insert(r.info.template_id, r);
            }
        }
        let n_tpl = templates.len();
        let initial_identities = templates
            .iter()
            .map(|(template_id, row)| (*template_id, TemplateIdentity::from(row)))
            .collect();
        let template_identities = shared_template_identity_store(&db_path, initial_identities);
        let idx = select_backend(n_tpl);
        for (tid, row) in &templates {
            if let Some(ref v) = row.vector {
                let _ = idx.upsert(*tid, v);
            }
        }
        Ok(Self {
            id: metadata_id.to_string(),
            name,
            root,
            meta: Mutex::new(meta),
            db,
            templates: Mutex::new(templates),
            template_identities,
            index: Mutex::new(idx),
            index_backend: Mutex::new(backend_name(n_tpl)),
            event_count_cache: Mutex::new(EventCountCache::default()),
            event_revision,
            template_analysis_revision,
            suppression_lens: Mutex::new(None),
            #[cfg(test)]
            event_count_scans: AtomicUsize::new(0),
            #[cfg(test)]
            suppression_lens_loads: AtomicUsize::new(0),
        })
    }

    /// Corpus id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Display name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// On-disk root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Event engine id (`duckdb`).
    pub fn event_engine(&self) -> &'static str {
        EVENT_ENGINE
    }

    /// Snapshot of corpus meta (stats, source label, …).
    pub fn meta(&self) -> CoreResult<CorpusMeta> {
        Ok(self.meta.lock().map_err(|_| lock_err())?.clone())
    }

    /// Persist updated ingest stats + top templates into meta.json.
    pub fn write_ingest_summary(
        &self,
        source_label: Option<String>,
        stats: CorpusStats,
        top_templates: Vec<TopTemplateSnapshot>,
        embedding: CorpusEmbeddingStatus,
    ) -> CoreResult<()> {
        let mut meta = self.meta.lock().map_err(|_| lock_err())?;
        meta.meta_version = META_VERSION;
        // Reinforce current pipeline identity on every successful ingest publish.
        meta.ingest_pipeline_identity = Some(INGEST_PIPELINE_IDENTITY.to_string());
        if let Some(label) = source_label {
            meta.source_label = Some(label);
        }
        meta.stats = Some(stats);
        meta.top_templates = top_templates;
        meta.embedding = embedding;
        write_meta_file(&self.root, &meta)?;
        Ok(())
    }

    /// Stamp a bounded reserved host identity into staged metadata.
    ///
    /// Hosts use this only for corpora they manage idempotently. It must be
    /// called before atomic publication so a later process can reconcile a
    /// crash between corpus publication and host-side marker publication.
    pub fn write_managed_identity(&self, identity: &str) -> CoreResult<()> {
        if identity.is_empty()
            || identity.len() > 160
            || !identity
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        {
            return Err(CoreError::Policy(
                "managed corpus identity must be 1-160 safe ASCII characters".into(),
            ));
        }
        let mut meta = self.meta.lock().map_err(|_| lock_err())?;
        meta.managed_identity = Some(identity.to_string());
        write_meta_file(&self.root, &meta)?;
        Ok(())
    }

    /// Actual vector availability, correcting legacy metadata from loaded rows.
    pub fn embedding_status(&self) -> CorpusEmbeddingStatus {
        let rows = self.templates.lock().unwrap_or_else(|e| e.into_inner());
        let total = rows.len() as u64;
        let embedded = rows.values().filter(|row| row.vector.is_some()).count() as u64;
        let mut status = self
            .meta
            .lock()
            .map(|meta| meta.embedding.clone())
            .unwrap_or_default();
        status.total_templates = total;
        status.embedded_templates = embedded;
        status.state = if total > 0 && embedded == total {
            EmbeddingState::Complete
        } else if embedded > 0 {
            EmbeddingState::Partial
        } else if status.state == EmbeddingState::Deferred {
            EmbeddingState::Deferred
        } else {
            EmbeddingState::KeywordOnly
        };
        status
    }

    /// On-disk size of corpus artifacts (meta + duckdb + templates).
    pub fn corpus_bytes_on_disk(&self) -> u64 {
        dir_size(&self.root)
    }

    /// List summary for UI cards.
    ///
    /// Prefer meta.json (stats) without opening DuckDB when possible so Windows
    /// does not hit exclusive file locks when another handle is open.
    pub fn list_summaries(cache_root: &Path) -> CoreResult<Vec<CorpusSummary>> {
        let mut out = Vec::new();
        for id in Self::list_ids(cache_root)? {
            let root = cache_root.join("log_corpora").join(&id);
            if let Ok(meta) = read_meta_file(&root) {
                if let Some(ref stats) = meta.stats {
                    out.push(
                        CorpusSummary {
                            id: meta.id.clone(),
                            name: meta.name.clone(),
                            event_count: stats.lines,
                            template_count: stats.templates,
                            engine: meta.engine.clone(),
                            created_at: meta.created_at,
                            source_label: meta.source_label.clone(),
                            ingest_pipeline_identity: None,
                            ingest_pipeline_compatibility:
                                IngestPipelineCompatibility::LegacyUnknown,
                            stats: Some(stats.clone()),
                            embedding: meta.embedding.clone(),
                        }
                        .with_pipeline(meta.ingest_pipeline_identity.clone()),
                    );
                    continue;
                }
                // Legacy meta without stats: open for live counts if possible.
            }
            match Self::open(cache_root, &id) {
                Ok(c) => out.push(c.summary()),
                Err(_) => continue,
            }
        }
        out.sort_by_key(|b| std::cmp::Reverse(b.created_at));
        Ok(out)
    }

    /// Build a list/detail summary from this open corpus.
    pub fn summary(&self) -> CorpusSummary {
        let meta = self.meta.lock().ok();
        let (created_at, source_label, stats, pipeline_id) = meta
            .as_ref()
            .map(|m| {
                (
                    m.created_at,
                    m.source_label.clone(),
                    m.stats.clone(),
                    m.ingest_pipeline_identity.clone(),
                )
            })
            .unwrap_or((0, None, None, None));
        let (event_count, template_count) = if let Some(ref s) = stats {
            (s.lines, s.templates)
        } else {
            (self.event_count() as u64, self.template_count() as u64)
        };
        drop(meta);
        let embedding = self.embedding_status();
        CorpusSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            event_count,
            template_count,
            engine: EVENT_ENGINE.into(),
            created_at,
            source_label,
            ingest_pipeline_identity: None,
            ingest_pipeline_compatibility: IngestPipelineCompatibility::LegacyUnknown,
            stats,
            embedding,
        }
        .with_pipeline(pipeline_id)
    }

    /// Append events (streaming ingest) into DuckDB.
    pub fn push_events(&self, batch: &[LogEvent]) -> CoreResult<()> {
        self.push_event_rows(batch.iter().map(|event| (event, None)))
    }

    /// Append newly ingested events with their authoritative redacted source.
    pub(crate) fn push_ingested_events(&self, batch: &[IngestedLogEvent]) -> CoreResult<()> {
        self.push_event_rows(
            batch
                .iter()
                .map(|entry| (&entry.event, Some(&entry.original))),
        )
    }

    fn push_event_rows<'a>(
        &self,
        rows: impl Iterator<Item = (&'a LogEvent, Option<&'a RedactedOriginal>)>,
    ) -> CoreResult<()> {
        let rows = rows.collect::<Vec<_>>();
        let batch_is_empty = rows.is_empty();
        if batch_is_empty {
            return Ok(());
        }
        for (event, _) in &rows {
            event.validate_timestamp_provenance()?;
        }
        let conn = self.db.lock().map_err(|_| lock_err())?;
        conn.execute_batch("BEGIN").map_err(duck_err)?;
        let result = (|| {
            {
                let mut app = conn
                    .appender("events")
                    .map_err(|e| CoreError::Message(format!("duckdb appender: {e}")))?;
                for (e, original) in rows {
                    let params_json =
                        serde_json::to_string(&e.params).unwrap_or_else(|_| "[]".into());
                    app.append_row(params![
                        e.seq as i64,
                        e.ts,
                        e.level.as_str(),
                        e.service.as_deref(),
                        e.host.as_deref(),
                        e.template_id as i64,
                        params_json.as_str(),
                        e.trace_id.as_deref(),
                        e.message.as_str(),
                        e.source.as_str(),
                        original.map(|value| value.text.as_str()),
                        original.map(|value| value.source_byte_count as i64),
                        original.map(|value| value.redacted_char_count as i64),
                        original.map(|value| value.truncated),
                        original.map(|value| value.encoding_normalized),
                        original.map(|value| value.redaction_applied),
                        e.timestamp_provenance.as_storage_str(),
                        e.active_timestamp_basis.as_storage_str(),
                        e.unresolved_local_timestamp.as_deref(),
                    ])
                    .map_err(|e| CoreError::Message(format!("duckdb append: {e}")))?;
                }
                app.flush()
                    .map_err(|e| CoreError::Message(format!("duckdb flush: {e}")))?;
            }
            let revision = advance_event_revision_after_append(&conn)?;
            conn.execute_batch("COMMIT").map_err(duck_err)?;
            Ok(revision)
        })();
        let revision = match result {
            Ok(revision) => revision,
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        };
        // Publish the new revision while the database lock is still held. A
        // concurrent count that started before this commit will then refuse to
        // cache its result under the obsolete revision.
        self.event_revision.store(revision, Ordering::SeqCst);
        drop(conn);
        self.event_count_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        Ok(())
    }

    /// Current immutable-event revision used to validate exact-count cache hits.
    pub(crate) fn event_revision(&self) -> u64 {
        self.event_revision.load(Ordering::SeqCst)
    }

    /// Public, process-local revision marker: changes only after a
    /// successful event append or revision publication. A trace/dry-run
    /// summary uses this to state which corpus content a turn was actually
    /// grounded against, without exposing corpus internals.
    pub fn revision(&self) -> u64 {
        self.event_revision()
    }

    /// Read the durable event revision while the caller already holds the
    /// corpus connection lock.
    ///
    /// Event-level re-analysis publishes this value in the same DuckDB
    /// transaction as the active event changes. Keeping this variant separate
    /// avoids recursively locking `db` in count queries.
    pub(crate) fn event_revision_with_connection(&self, conn: &Connection) -> u64 {
        let fallback = self.event_revision.load(Ordering::SeqCst);
        let revision = persisted_event_revision(conn).unwrap_or(fallback);
        let observed = self.event_revision.fetch_max(revision, Ordering::SeqCst);
        observed.max(revision)
    }

    /// Publish a committed durable revision to every in-process corpus handle.
    pub(super) fn publish_event_revision(&self, revision: u64) {
        self.event_revision.store(revision, Ordering::SeqCst);
        self.event_count_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// Return an exact cached count only when it belongs to the current events.
    pub(crate) fn cached_event_count(
        &self,
        key: &EventCountCacheKey,
        revision: u64,
    ) -> Option<u64> {
        if self.event_revision.load(Ordering::SeqCst) != revision {
            return None;
        }
        self.event_count_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(key, revision)
    }

    /// Cache an exact count only if no event append completed during its scan.
    pub(crate) fn cache_event_count_if_current(
        &self,
        key: EventCountCacheKey,
        revision: u64,
        count: u64,
    ) -> bool {
        if self.event_revision.load(Ordering::SeqCst) != revision {
            return false;
        }
        self.event_count_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, CachedEventCount { revision, count });
        self.event_revision.load(Ordering::SeqCst) == revision
    }

    /// Cached trusted suppression lens, if one was resolved for this handle.
    pub(crate) fn cached_suppression_lens(
        &self,
    ) -> Option<super::suppression_lens::CachedSuppressionLens> {
        self.suppression_lens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Replace the cached trusted suppression lens for this handle.
    pub(crate) fn store_suppression_lens(
        &self,
        entry: super::suppression_lens::CachedSuppressionLens,
    ) {
        *self
            .suppression_lens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(entry);
    }

    /// Drop the cached lens so the next query re-resolves the durable policy.
    ///
    /// The host calls this after a policy mutation or import so enforcement
    /// does not wait for the sidecar identity to be observed as changed.
    pub fn invalidate_suppression_lens(&self) {
        *self
            .suppression_lens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// Count one sidecar read plus rule resolution (not a cache hit).
    #[cfg(test)]
    pub(crate) fn record_suppression_lens_load(&self) {
        self.suppression_lens_loads.fetch_add(1, Ordering::SeqCst);
    }

    #[cfg(not(test))]
    pub(crate) fn record_suppression_lens_load(&self) {}

    #[cfg(test)]
    pub(crate) fn suppression_lens_load_count(&self) -> usize {
        self.suppression_lens_loads.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn record_event_count_scan(&self) {
        self.event_count_scans.fetch_add(1, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn event_count_scan_count(&self) -> usize {
        self.event_count_scans.load(Ordering::SeqCst)
    }

    /// Whether this corpus contains at least one authoritative redacted source
    /// representation. Legacy corpora return false after additive schema open.
    pub fn has_original_representations(&self) -> CoreResult<bool> {
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let exists = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM events
                    WHERE original_redacted IS NOT NULL
                    LIMIT 1
                 )",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(duck_err)?;
        Ok(exists)
    }

    /// Upsert template rows (JSON sidecar; not in DuckDB).
    pub fn upsert_templates(&self, rows: impl IntoIterator<Item = TemplateRow>) -> CoreResult<()> {
        let mut g = self.templates.lock().map_err(|_| lock_err())?;
        let mut identity_updates = Vec::new();
        let mut changed = false;
        for r in rows {
            changed = true;
            identity_updates.push((r.info.template_id, TemplateIdentity::from(&r)));
            g.insert(r.info.template_id, r);
        }
        drop(g);
        if changed {
            let mut identities = self.template_identities.lock().map_err(|_| lock_err())?;
            identities.extend(identity_updates);
            self.template_analysis_revision
                .fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }

    /// Current deterministic template-metadata revision.
    pub(crate) fn template_analysis_revision(&self) -> u64 {
        self.template_analysis_revision.load(Ordering::SeqCst)
    }

    /// Set embedding for a template (content-hash cached by caller).
    pub fn set_template_vector(&self, template_id: u64, vector: Vec<f32>) -> CoreResult<()> {
        {
            let mut g = self.templates.lock().map_err(|_| lock_err())?;
            if let Some(row) = g.get_mut(&template_id) {
                row.vector = Some(vector.clone());
            } else {
                return Err(CoreError::Message(format!(
                    "unknown template_id {template_id}"
                )));
            }
        }
        let idx = self.index.lock().map_err(|_| lock_err())?;
        idx.upsert(template_id, &vector)?;
        let n = idx.len();
        drop(idx);
        self.maybe_reselect_backend(n)?;
        Ok(())
    }

    fn maybe_reselect_backend(&self, n: usize) -> CoreResult<()> {
        let want = backend_name(n);
        let mut kind = self.index_backend.lock().map_err(|_| lock_err())?;
        if *kind == want {
            return Ok(());
        }
        let templates = self.templates.lock().map_err(|_| lock_err())?;
        let new_idx = select_backend(n);
        for (tid, row) in templates.iter() {
            if let Some(ref v) = row.vector {
                new_idx.upsert(*tid, v)?;
            }
        }
        drop(templates);
        *self.index.lock().map_err(|_| lock_err())? = new_idx;
        *kind = want;
        Ok(())
    }

    /// Run a closure with the DuckDB connection (explorer query plane).
    ///
    /// Prefer this over loading all events for large corpora.
    pub fn with_connection<R>(
        &self,
        f: impl FnOnce(&Connection) -> CoreResult<R>,
    ) -> CoreResult<R> {
        let conn = self.db.lock().map_err(|_| lock_err())?;
        f(&conn)
    }

    /// Event count (DuckDB).
    pub fn event_count(&self) -> usize {
        let conn = match self.db.lock() {
            Ok(c) => c,
            Err(_) => return 0,
        };
        conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, i64>(0))
            .map(|n| n as usize)
            .unwrap_or(0)
    }

    /// Template count.
    pub fn template_count(&self) -> usize {
        self.templates.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// Snapshot templates.
    pub fn list_templates(&self) -> Vec<TemplateRow> {
        let g = self.templates.lock().unwrap_or_else(|e| e.into_inner());
        let mut v: Vec<_> = g.values().cloned().collect();
        v.sort_by_key(|t| t.info.template_id);
        v
    }

    /// Snapshot template metadata without cloning optional embedding vectors.
    pub fn list_template_infos(&self) -> Vec<TemplateInfo> {
        let g = self.templates.lock().unwrap_or_else(|e| e.into_inner());
        let mut v = g
            .values()
            .map(|template| template.info.clone())
            .collect::<Vec<_>>();
        v.sort_by_key(|info| info.template_id);
        v
    }

    /// Clone one bounded display pattern without cloning its embedding vector.
    pub fn template_pattern(&self, template_id: u64) -> Option<String> {
        self.templates
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&template_id)
            .map(|template| template.info.pattern.clone())
    }

    /// Clone deterministic identity metadata for a bounded set of templates
    /// without cloning optional embedding vectors.
    pub(crate) fn template_candidate_metadata(
        &self,
        template_ids: &[u64],
        fingerprint_max_bytes: usize,
        pattern_scan_max_bytes: usize,
    ) -> HashMap<u64, (String, String)> {
        let templates = self
            .template_identities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        template_ids
            .iter()
            .filter_map(|template_id| {
                templates.get(template_id).and_then(|template| {
                    if template.content_hash.len() > fingerprint_max_bytes {
                        return None;
                    }
                    Some((
                        *template_id,
                        (
                            template.content_hash.clone(),
                            crate::text::truncate_bytes(&template.pattern, pattern_scan_max_bytes)
                                .to_string(),
                        ),
                    ))
                })
            })
            .collect()
    }

    /// Clone only trusted template fingerprints for a bounded id set.
    pub(crate) fn template_fingerprints(
        &self,
        template_ids: &[u64],
        max_bytes: usize,
    ) -> HashMap<u64, String> {
        let templates = self
            .template_identities
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        template_ids
            .iter()
            .filter_map(|template_id| {
                templates
                    .get(template_id)
                    .filter(|template| template.content_hash.len() <= max_bytes)
                    .map(|template| (*template_id, template.content_hash.clone()))
            })
            .collect()
    }

    /// Load all events into memory for a callback (fine for tests / moderate corpora).
    /// Prefer [`Self::scan_template_frequency`] / [`Self::scan_error_by_service`] for large scans.
    pub fn with_events<R>(&self, f: impl FnOnce(&[LogEvent]) -> R) -> R {
        let events = self.load_all_events().unwrap_or_default();
        f(&events)
    }

    pub(crate) fn load_all_events(&self) -> CoreResult<Vec<LogEvent>> {
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare(
                "SELECT seq, ts, level, service, host, template_id, params, trace_id, message, source, \
                        timestamp_provenance, active_timestamp_basis, unresolved_local_timestamp \
                 FROM events ORDER BY seq",
            )
            .map_err(duck_err)?;
        let rows = stmt
            .query_map([], |r| {
                let params_s: String = r.get(6)?;
                let params: Vec<String> = serde_json::from_str(&params_s).unwrap_or_default();
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                    params,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, Option<String>>(10)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, Option<String>>(12)?,
                ))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (
                seq,
                ts,
                level,
                service,
                host,
                template_id,
                params,
                trace_id,
                message,
                source,
                stored_provenance,
                stored_active_basis,
                unresolved_local_timestamp,
            ) = row.map_err(duck_err)?;
            let timestamp_provenance = TimestampProvenance::from_storage_str(
                stored_provenance.as_deref(),
            )
            .ok_or_else(|| CoreError::Message("event has invalid timestamp provenance".into()))?;
            let active_timestamp_basis = ActiveTimestampBasis::from_storage_str(
                stored_active_basis.as_deref(),
            )
            .ok_or_else(|| CoreError::Message("event has invalid active timestamp basis".into()))?;
            let event = LogEvent {
                seq: u64::try_from(seq)
                    .map_err(|_| CoreError::Message("event sequence is negative".into()))?,
                ts,
                timestamp_provenance,
                active_timestamp_basis,
                unresolved_local_timestamp,
                level,
                service,
                host,
                template_id: u64::try_from(template_id)
                    .map_err(|_| CoreError::Message("event template id is negative".into()))?,
                params,
                trace_id,
                message,
                source,
            };
            event.validate_timestamp_provenance()?;
            out.push(event);
        }
        Ok(out)
    }

    /// Semantic search over template vectors (pure-Rust index).
    pub fn search_templates(
        &self,
        query: &[f32],
        k: usize,
        allow: Option<&std::collections::HashSet<u64>>,
    ) -> CoreResult<Vec<(u64, f32)>> {
        let idx = self.index.lock().map_err(|_| lock_err())?;
        idx.search(query, k, allow)
    }

    // ── DuckDB analytical scans (production path for multi-M rows) ──────────

    /// Template frequency: `(template_id, count)` ordered by count desc.
    pub fn scan_template_frequency(
        &self,
        time_from: Option<i64>,
        time_to: Option<i64>,
    ) -> CoreResult<Vec<(u64, u64)>> {
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let sql = r#"
            SELECT template_id, COUNT(*) AS c
            FROM events
            WHERE (?1 IS NULL OR ts >= ?1)
              AND (?2 IS NULL OR ts < ?2)
            GROUP BY template_id
            ORDER BY c DESC
        "#;
        let mut stmt = conn.prepare(sql).map_err(duck_err)?;
        let rows = stmt
            .query_map(params![time_from, time_to], |r| {
                Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    }

    /// Count by service where level is error/fatal.
    pub fn scan_error_by_service(&self) -> CoreResult<Vec<(String, u64)>> {
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT COALESCE(service, ''), COUNT(*) AS c
                FROM events
                WHERE level IN ('error', 'fatal')
                GROUP BY 1
                ORDER BY c DESC
                "#,
            )
            .map_err(duck_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    }

    /// Co-occurrence: pairs of template_ids that appear within `window_secs` of each other.
    ///
    /// Uses time-bucketed pairing (not a full O(n²) self-join) so multi-million
    /// corpora stay interactive. Returns `(a, b, count)` with a < b.
    pub fn scan_co_occurrence(
        &self,
        window_secs: i64,
        limit: usize,
    ) -> CoreResult<Vec<(u64, u64, u64)>> {
        let w = window_secs.max(1);
        let conn = self.db.lock().map_err(|_| lock_err())?;
        // Bucket events by floor(ts/window), then pair distinct templates that share a bucket.
        // This approximates "within window" co-occurrence without n² joins.
        let sql = r#"
            WITH bucketed AS (
                SELECT template_id, (ts / ?1) AS bkt, COUNT(*) AS n
                FROM events
                GROUP BY 1, 2
            ),
            pairs AS (
                SELECT LEAST(a.template_id, b.template_id) AS t_a,
                       GREATEST(a.template_id, b.template_id) AS t_b,
                       SUM(a.n * b.n) AS c
                FROM bucketed a
                JOIN bucketed b
                  ON a.bkt = b.bkt
                 AND a.template_id < b.template_id
                GROUP BY 1, 2
            )
            SELECT t_a, t_b, c FROM pairs
            ORDER BY c DESC
            LIMIT ?2
        "#;
        let mut stmt = conn.prepare(sql).map_err(duck_err)?;
        let rows = stmt
            .query_map(params![w, limit as i64], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, i64>(2)? as u64,
                ))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    }

    /// Count events matching level/service (for timeline-style buckets via SQL).
    pub fn scan_timeline_buckets(
        &self,
        width_secs: i64,
        level: Option<&str>,
        service: Option<&str>,
    ) -> CoreResult<Vec<(i64, u64, String, u64)>> {
        let width = width_secs.max(1);
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let sql = r#"
            SELECT (ts / ?1) * ?1 AS bucket,
                   level,
                   COUNT(*) AS c
            FROM events
            WHERE (?2 IS NULL OR level = ?2)
              AND (?3 IS NULL OR service = ?3)
            GROUP BY 1, 2
            ORDER BY 1, 2
        "#;
        let mut stmt = conn.prepare(sql).map_err(duck_err)?;
        let rows = stmt
            .query_map(params![width, level, service], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    width,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as u64,
                ))
            })
            .map_err(duck_err)?;
        // Return as (bucket_start, width, level, count) flattened — caller aggregates.
        let mut out = Vec::new();
        for row in rows {
            let (b, w, lvl, c) = row.map_err(duck_err)?;
            out.push((b, w as u64, lvl, c));
        }
        Ok(out)
    }

    /// Flush templates JSON + checkpoint DuckDB.
    pub fn flush(&self) -> CoreResult<()> {
        let templates = self.templates.lock().map_err(|_| lock_err())?;
        let rows: Vec<_> = templates.values().cloned().collect();
        std::fs::write(
            self.root.join("templates.json"),
            serde_json::to_vec_pretty(&rows)?,
        )?;
        // DuckDB is durable on append; optional checkpoint.
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let _ = conn.execute_batch("CHECKPOINT");
        Ok(())
    }

    /// Discard corpus directory.
    pub fn discard(cache_root: &Path, id: &str) -> CoreResult<()> {
        validate_corpus_id(id)?;
        let root = cache_root.join("log_corpora").join(id);
        if root.exists() {
            std::fs::remove_dir_all(&root)?;
        }
        Ok(())
    }

    /// Rename a corpus in place (cosmetic only — never touched by ingest
    /// identity, retrieval, or citations, all of which key on `id`).
    ///
    /// Rejects a blank name rather than silently keeping the old one, so a
    /// caller passing empty input by mistake gets an honest error instead of
    /// a no-op that looks like it worked.
    pub fn rename(cache_root: &Path, id: &str, new_name: &str) -> CoreResult<()> {
        validate_corpus_id(id)?;
        let new_name = new_name.trim();
        if new_name.is_empty() {
            return Err(CoreError::Message("corpus name cannot be empty".into()));
        }
        let root = cache_root.join("log_corpora").join(id);
        let mut meta = read_meta_file(&root)?;
        meta.name = new_name.to_string();
        write_meta_file(&root, &meta)
    }

    /// List corpus ids under cache root.
    pub fn list_ids(cache_root: &Path) -> CoreResult<Vec<String>> {
        let dir = cache_root.join("log_corpora");
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            if e.file_type()?.is_dir() && e.path().join("meta.json").exists() {
                out.push(e.file_name().to_string_lossy().to_string());
            }
        }
        out.sort();
        Ok(out)
    }
}

fn validate_corpus_id(id: &str) -> CoreResult<()> {
    let is_safe = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if is_safe {
        Ok(())
    } else {
        Err(CoreError::Message("invalid corpus id".into()))
    }
}

fn validate_import_staging_id(id: &str) -> CoreResult<()> {
    let Some(suffix) = id.strip_prefix(".import-") else {
        return Err(CoreError::Message("invalid import staging id".into()));
    };
    validate_corpus_id(suffix).map_err(|_| CoreError::Message("invalid import staging id".into()))
}

fn contained_existing_corpus_root(cache_root: &Path, id: &str) -> CoreResult<PathBuf> {
    let cache_root = std::fs::canonicalize(cache_root)
        .map_err(|_| CoreError::Message(format!("corpus not found: {id}")))?;
    let corpora_root = std::fs::canonicalize(cache_root.join("log_corpora"))
        .map_err(|_| CoreError::Message(format!("corpus not found: {id}")))?;
    if !corpora_root.starts_with(&cache_root) {
        return Err(CoreError::Message(
            "log corpus directory escapes cache root".into(),
        ));
    }

    let root = std::fs::canonicalize(corpora_root.join(id))
        .map_err(|_| CoreError::Message(format!("corpus not found: {id}")))?;
    if !root.starts_with(&corpora_root) {
        return Err(CoreError::Message(format!(
            "corpus directory escapes cache root: {id}"
        )));
    }
    Ok(root)
}

/// Resolve only the trusted structural root for an exact published corpus.
///
/// Attachment sidecars use this path so restore does not open DuckDB, parse
/// templates, or construct a vector index merely to locate corpus-owned
/// storage. Identity and containment remain identical to [`LogCorpus::open`].
pub(super) fn contained_exact_corpus_root(cache_root: &Path, id: &str) -> CoreResult<PathBuf> {
    validate_corpus_id(id)?;
    let root = contained_existing_corpus_root(cache_root, id)?;
    let meta = read_meta_file(&root)?;
    if meta.id != id {
        return Err(CoreError::Message(format!(
            "corpus metadata id mismatch: requested {id}"
        )));
    }
    if !root.join("events.duckdb").is_file() {
        return Err(CoreError::Message(format!(
            "corpus {id} missing events.duckdb"
        )));
    }
    Ok(root)
}

fn init_schema(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS events (
            seq BIGINT NOT NULL,
            ts BIGINT NOT NULL,
            level VARCHAR NOT NULL,
            service VARCHAR,
            host VARCHAR,
            template_id BIGINT NOT NULL,
            params VARCHAR NOT NULL,
            trace_id VARCHAR,
            message VARCHAR NOT NULL,
            source VARCHAR NOT NULL,
            original_redacted VARCHAR,
            original_source_bytes BIGINT,
            original_redacted_chars BIGINT,
            original_truncated BOOLEAN,
            original_encoding_normalized BOOLEAN,
            original_redaction_applied BOOLEAN,
            timestamp_provenance VARCHAR,
            active_timestamp_basis VARCHAR,
            unresolved_local_timestamp VARCHAR
        );
        ALTER TABLE events ADD COLUMN IF NOT EXISTS original_redacted VARCHAR;
        ALTER TABLE events ADD COLUMN IF NOT EXISTS original_source_bytes BIGINT;
        ALTER TABLE events ADD COLUMN IF NOT EXISTS original_redacted_chars BIGINT;
        ALTER TABLE events ADD COLUMN IF NOT EXISTS original_truncated BOOLEAN;
        ALTER TABLE events ADD COLUMN IF NOT EXISTS original_encoding_normalized BOOLEAN;
        ALTER TABLE events ADD COLUMN IF NOT EXISTS original_redaction_applied BOOLEAN;
        ALTER TABLE events ADD COLUMN IF NOT EXISTS timestamp_provenance VARCHAR;
        ALTER TABLE events ADD COLUMN IF NOT EXISTS active_timestamp_basis VARCHAR;
        ALTER TABLE events ADD COLUMN IF NOT EXISTS unresolved_local_timestamp VARCHAR;
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_events_timestamp_provenance ON events(timestamp_provenance);
        CREATE INDEX IF NOT EXISTS idx_events_active_timestamp_basis ON events(active_timestamp_basis);
        CREATE INDEX IF NOT EXISTS idx_events_template ON events(template_id);
        CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
        CREATE INDEX IF NOT EXISTS idx_events_service ON events(service);
        CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);
        CREATE TABLE IF NOT EXISTS event_revision_state (
            singleton INTEGER PRIMARY KEY,
            current_revision BIGINT NOT NULL,
            previous_revision BIGINT,
            current_metadata_json VARCHAR NOT NULL,
            previous_metadata_json VARCHAR,
            event_count BIGINT NOT NULL,
            wall_event_count BIGINT NOT NULL,
            ts_min BIGINT,
            ts_max BIGINT,
            previous_event_count BIGINT,
            previous_wall_event_count BIGINT,
            previous_ts_min BIGINT,
            previous_ts_max BIGINT
        );
        ALTER TABLE event_revision_state
            ADD COLUMN IF NOT EXISTS wall_event_count BIGINT;
        ALTER TABLE event_revision_state
            ADD COLUMN IF NOT EXISTS previous_wall_event_count BIGINT;
        INSERT INTO event_revision_state
        SELECT 1, 0, NULL, '{}', NULL,
               stats.event_count, stats.wall_event_count,
               stats.ts_min, stats.ts_max,
               NULL, NULL, NULL, NULL
        FROM (
            SELECT COUNT(*) AS event_count,
                   COALESCE(SUM(
                       CASE WHEN active_timestamp_basis
                                      IN ('explicit_wall', 'resolved_local')
                            THEN 1 ELSE 0 END
                   ), 0) AS wall_event_count,
                   MIN(ts) AS ts_min,
                   MAX(ts) AS ts_max
            FROM events
        ) stats
        WHERE NOT EXISTS (
            SELECT 1 FROM event_revision_state WHERE singleton = 1
        );
        UPDATE event_revision_state
        SET wall_event_count = (
            SELECT COALESCE(SUM(
                CASE WHEN active_timestamp_basis
                               IN ('explicit_wall', 'resolved_local')
                     THEN 1 ELSE 0 END
            ), 0)
            FROM events
        )
        WHERE wall_event_count IS NULL;
        "#,
    )
    .map_err(duck_err)?;
    Ok(())
}

fn advance_event_revision_after_append(conn: &Connection) -> CoreResult<u64> {
    let current = persisted_event_revision(conn)
        .ok_or_else(|| CoreError::Message("event revision state is unavailable".into()))?;
    let revision = current
        .checked_add(1)
        .filter(|value| *value <= i64::MAX as u64)
        .ok_or_else(|| CoreError::Message("event revision overflow".into()))?;
    let (event_count, wall_event_count, ts_min, ts_max) = conn
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(
                        CASE WHEN active_timestamp_basis
                                       IN ('explicit_wall', 'resolved_local')
                             THEN 1 ELSE 0 END
                    ), 0),
                    MIN(ts), MAX(ts)
             FROM events",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .map_err(duck_err)?;
    if event_count < 0 || wall_event_count < 0 || wall_event_count > event_count {
        return Err(CoreError::Message(
            "event time-quality counts are outside supported range".into(),
        ));
    }
    conn.execute_batch(
        "DROP TABLE IF EXISTS events_previous;
         DROP TABLE IF EXISTS event_revision_timestamp_changes;",
    )
    .map_err(duck_err)?;
    conn.execute(
        "UPDATE event_revision_state
         SET current_revision = ?1,
             previous_revision = NULL,
             current_metadata_json = '{}',
             previous_metadata_json = NULL,
             event_count = ?2,
             wall_event_count = ?3,
             ts_min = ?4,
             ts_max = ?5,
             previous_event_count = NULL,
             previous_wall_event_count = NULL,
             previous_ts_min = NULL,
             previous_ts_max = NULL
         WHERE singleton = 1",
        params![
            revision as i64,
            event_count,
            wall_event_count,
            ts_min,
            ts_max
        ],
    )
    .map_err(duck_err)?;
    Ok(revision)
}

fn persisted_event_revision(conn: &Connection) -> Option<u64> {
    conn.query_row(
        "SELECT current_revision
         FROM event_revision_state
         WHERE singleton = 1",
        [],
        |row| row.get::<_, i64>(0),
    )
    .ok()
    .and_then(|revision| u64::try_from(revision).ok())
}

fn shared_event_revision_clock(db_path: &Path, durable_revision: u64) -> Arc<AtomicU64> {
    let key = std::fs::canonicalize(db_path).unwrap_or_else(|_| db_path.to_path_buf());
    let mut clocks = EVENT_REVISION_CLOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clocks.retain(|_, clock| clock.strong_count() > 0);
    if let Some(clock) = clocks.get(&key).and_then(Weak::upgrade) {
        clock.fetch_max(durable_revision, Ordering::SeqCst);
        return clock;
    }
    let clock = Arc::new(AtomicU64::new(durable_revision));
    clocks.insert(key, Arc::downgrade(&clock));
    clock
}

fn shared_template_analysis_revision_clock(db_path: &Path) -> Arc<AtomicU64> {
    let key = std::fs::canonicalize(db_path).unwrap_or_else(|_| db_path.to_path_buf());
    let mut clocks = TEMPLATE_ANALYSIS_REVISION_CLOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    clocks.retain(|_, clock| clock.strong_count() > 0);
    if let Some(clock) = clocks.get(&key).and_then(Weak::upgrade) {
        return clock;
    }
    let clock = Arc::new(AtomicU64::new(0));
    clocks.insert(key, Arc::downgrade(&clock));
    clock
}

fn shared_template_identity_store(
    db_path: &Path,
    initial: HashMap<u64, TemplateIdentity>,
) -> Arc<TemplateIdentityStore> {
    let key = std::fs::canonicalize(db_path).unwrap_or_else(|_| db_path.to_path_buf());
    let mut stores = TEMPLATE_IDENTITY_STORES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    stores.retain(|_, store| store.strong_count() > 0);
    if let Some(store) = stores.get(&key).and_then(Weak::upgrade) {
        return store;
    }
    let store = Arc::new(Mutex::new(initial));
    stores.insert(key, Arc::downgrade(&store));
    store
}

fn shared_corpus_connection(db_path: &Path) -> CoreResult<Arc<Mutex<Connection>>> {
    let key = canonical_db_key(db_path);
    let mut connections = CORPUS_CONNECTIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    connections.retain(|_, connection| connection.strong_count() > 0);
    if let Some(connection) = connections.get(&key).and_then(Weak::upgrade) {
        return Ok(connection);
    }
    let connection = Connection::open(db_path).map_err(duck_err)?;
    init_schema(&connection)?;
    let connection = Arc::new(Mutex::new(connection));
    connections.insert(key, Arc::downgrade(&connection));
    Ok(connection)
}

fn canonical_db_key(db_path: &Path) -> PathBuf {
    std::fs::canonicalize(db_path).unwrap_or_else(|_| {
        db_path
            .parent()
            .and_then(|parent| std::fs::canonicalize(parent).ok())
            .and_then(|parent| db_path.file_name().map(|name| parent.join(name)))
            .unwrap_or_else(|| db_path.to_path_buf())
    })
}

fn lock_err() -> CoreError {
    CoreError::Message("log corpus lock poisoned".into())
}

fn duck_err(e: impl std::fmt::Display) -> CoreError {
    CoreError::Message(format!("duckdb: {e}"))
}

/// Write meta.json under a corpus root.
pub fn write_meta_file(root: &Path, meta: &CorpusMeta) -> CoreResult<()> {
    std::fs::write(root.join("meta.json"), serde_json::to_vec_pretty(meta)?)
        .map_err(|e| CoreError::Message(format!("write meta: {e}")))
}

/// Read meta.json from a corpus root.
pub fn read_meta_file(root: &Path) -> CoreResult<CorpusMeta> {
    let path = root.join("meta.json");
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut file = options
        .open(path)
        .map_err(|error| CoreError::Message(format!("read meta: {error}")))?;
    let metadata = file
        .metadata()
        .map_err(|error| CoreError::Message(format!("inspect meta: {error}")))?;
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_CORPUS_META_BYTES
    {
        return Err(CoreError::Message(
            "meta.json must be a bounded regular non-symlink file".into(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_CORPUS_META_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| CoreError::Message(format!("read meta: {error}")))?;
    if bytes.len() as u64 > MAX_CORPUS_META_BYTES {
        return Err(CoreError::Message(
            "meta.json exceeds its storage bound".into(),
        ));
    }
    let raw = std::str::from_utf8(&bytes)
        .map_err(|_| CoreError::Message("meta.json must be valid UTF-8".into()))?;
    // Prefer typed parse; fall back for very old meta shapes.
    if let Ok(m) = serde_json::from_str::<CorpusMeta>(raw) {
        return Ok(m);
    }
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| CoreError::Message(format!("parse meta: {e}")))?;
    Ok(CorpusMeta {
        meta_version: v.get("meta_version").and_then(|x| x.as_u64()).unwrap_or(1) as u32,
        id: v.get("id").and_then(|x| x.as_str()).unwrap_or("").into(),
        name: v.get("name").and_then(|x| x.as_str()).unwrap_or("").into(),
        created_at: v.get("created_at").and_then(|x| x.as_i64()).unwrap_or(0),
        engine: v
            .get("engine")
            .and_then(|x| x.as_str())
            .unwrap_or(EVENT_ENGINE)
            .into(),
        license: v
            .get("license")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .into(),
        vector_index: v
            .get("vector_index")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .into(),
        source_label: None,
        origin_corpus_id: None,
        managed_identity: None,
        ingest_pipeline_identity: super::ingest_pipeline::normalize_ingest_pipeline_identity_value(
            v.get("ingestPipelineIdentity")
                .cloned()
                .or_else(|| v.get("ingest_pipeline_identity").cloned()),
        ),
        stats: None,
        top_templates: Vec::new(),
        embedding: CorpusEmbeddingStatus::default(),
    })
}

/// Recursive directory size in bytes (best-effort).
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            total = total.saturating_add(dir_size(&p));
        } else if let Ok(m) = e.metadata() {
            total = total.saturating_add(m.len());
        }
    }
    total
}

/// Content hash for template embed cache.
pub fn template_content_hash(pattern: &str) -> String {
    crate::embed::chunk_content_key(pattern)
}

#[cfg(test)]
mod tests {
    use super::super::drain::TemplateInfo;
    use super::*;
    use std::fs::File;
    use std::time::Instant;

    fn assert_rejected_before_db_initialization(cache: &Path, id: &str) {
        let error = LogCorpus::open(cache, id)
            .err()
            .expect("unsafe corpus id must be rejected");
        assert!(
            error.to_string().contains("invalid corpus id"),
            "unexpected error for {id:?}: {error}"
        );
    }

    #[test]
    fn canonical_db_key_is_stable_when_the_database_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("events.duckdb");
        let before_create = canonical_db_key(&db_path);
        File::create(&db_path).unwrap();
        let after_create = canonical_db_key(&db_path);
        assert_eq!(before_create, after_create);
    }

    #[test]
    fn open_rejects_unsafe_corpus_ids_before_db_initialization() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let outside = cache.join("escape-target");
        std::fs::create_dir_all(cache.join("log_corpora")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        File::create(outside.join("events.duckdb")).unwrap();

        for id in [
            "",
            ".",
            "..",
            "../escape-target",
            "nested/corpus",
            r"nested\corpus",
            "/tmp/corpus",
            r"C:\temp\corpus",
            r"\\server\share\corpus",
            "corpus:name",
            " corpus ",
        ] {
            assert_rejected_before_db_initialization(&cache, id);
        }

        assert_eq!(
            std::fs::metadata(outside.join("events.duckdb"))
                .unwrap()
                .len(),
            0,
            "rejected identifiers must not initialize an escaped database"
        );
    }

    #[test]
    fn corpus_metadata_reader_rejects_oversized_content_before_parsing() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "bounded meta").unwrap();
        std::fs::write(
            corpus.root().join("meta.json"),
            vec![b' '; (MAX_CORPUS_META_BYTES + 1) as usize],
        )
        .unwrap();
        let error = read_meta_file(corpus.root()).unwrap_err();
        assert!(error.to_string().contains("bounded regular"));
    }

    #[cfg(unix)]
    #[test]
    fn corpus_metadata_reader_never_follows_a_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "meta symlink").unwrap();
        let meta_path = corpus.root().join("meta.json");
        let outside = dir.path().join("outside-meta.json");
        std::fs::rename(&meta_path, &outside).unwrap();
        symlink(&outside, &meta_path).unwrap();
        let error = read_meta_file(corpus.root()).unwrap_err();
        assert!(error.to_string().contains("read meta"));
        assert!(outside.is_file());
    }

    #[test]
    fn import_staging_open_is_contained_without_becoming_a_public_id() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "staged").unwrap();
        let published_id = corpus.id().to_string();
        let published_root = corpus.root().to_path_buf();
        drop(corpus);

        let staging_id = format!(".import-{published_id}");
        let staging_root = dir.path().join("log_corpora").join(&staging_id);
        std::fs::rename(&published_root, &staging_root).unwrap();

        let public_error = LogCorpus::open(dir.path(), &staging_id)
            .err()
            .expect("staging names must not become public corpus ids");
        assert!(public_error.to_string().contains("invalid corpus id"));

        let staged =
            LogCorpus::open_import_staging(dir.path(), &staging_id, &published_id).unwrap();
        assert_eq!(staged.id(), published_id);
        drop(staged);

        for unsafe_id in [
            ".import-",
            ".import-../escape",
            ".import-nested/corpus",
            "import-safe",
        ] {
            let error = LogCorpus::open_import_staging(dir.path(), unsafe_id, &published_id)
                .err()
                .expect("unsafe staging id must be rejected");
            assert!(error.to_string().contains("invalid import staging id"));
        }
    }

    #[test]
    fn open_rejects_metadata_id_mismatch_before_db_initialization() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "mismatch").unwrap();
        let id = corpus.id().to_string();
        let root = corpus.root().to_path_buf();
        let mut meta = corpus.meta().unwrap();
        drop(corpus);

        meta.id = "different-safe-id".into();
        write_meta_file(&root, &meta).unwrap();
        File::create(root.join("events.duckdb")).unwrap();

        let error = LogCorpus::open(dir.path(), &id)
            .err()
            .expect("metadata mismatch must be rejected");
        assert!(error.to_string().contains("metadata id mismatch"));
        assert_eq!(
            std::fs::metadata(root.join("events.duckdb")).unwrap().len(),
            0,
            "metadata mismatch must be rejected before DuckDB initialization"
        );
    }

    #[cfg(unix)]
    #[test]
    fn open_rejects_symlink_escape_before_db_initialization() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let external_cache = dir.path().join("external-cache");
        std::fs::create_dir_all(cache.join("log_corpora")).unwrap();
        let external = LogCorpus::create(&external_cache, "external").unwrap();
        let id = external.id().to_string();
        let external_root = external.root().to_path_buf();
        drop(external);
        symlink(&external_root, cache.join("log_corpora").join(&id)).unwrap();

        let error = LogCorpus::open(&cache, &id)
            .err()
            .expect("symlink escape must be rejected");
        assert!(error.to_string().contains("escapes cache root"));
    }

    #[test]
    fn open_accepts_generated_and_safe_legacy_corpus_ids() {
        let dir = tempfile::tempdir().unwrap();
        let generated = LogCorpus::create(dir.path(), "generated").unwrap();
        let generated_id = generated.id().to_string();
        let generated_root = generated.root().to_path_buf();
        drop(generated);
        assert_eq!(
            LogCorpus::open(dir.path(), &generated_id).unwrap().id(),
            generated_id
        );

        let legacy_id = "legacy-current_1";
        let legacy_root = dir.path().join("log_corpora").join(legacy_id);
        std::fs::rename(&generated_root, &legacy_root).unwrap();
        let mut meta = read_meta_file(&legacy_root).unwrap();
        meta.id = legacy_id.into();
        write_meta_file(&legacy_root, &meta).unwrap();
        assert_eq!(
            LogCorpus::open(dir.path(), legacy_id).unwrap().id(),
            legacy_id
        );
    }

    #[test]
    fn legacy_meta_without_stats_still_opens() {
        let dir = tempfile::tempdir().unwrap();
        let id = "legacy-meta-1";
        let root = dir.path().join("log_corpora").join(id);
        std::fs::create_dir_all(&root).unwrap();
        // v1-style meta: no stats, no meta_version
        let meta = serde_json::json!({
            "id": id,
            "name": "old-incident",
            "created_at": 1_700_000_000,
            "engine": "duckdb",
            "license": "MIT",
            "vector_index": "exact"
        });
        std::fs::write(
            root.join("meta.json"),
            serde_json::to_vec_pretty(&meta).unwrap(),
        )
        .unwrap();
        // Minimal duckdb via create then copy? open requires events.duckdb — create empty via LogCorpus then overwrite meta
        let c = LogCorpus::create(dir.path(), "tmp").unwrap();
        let real_id = c.id().to_string();
        drop(c);
        let real_root = dir.path().join("log_corpora").join(&real_id);
        // Replace meta with legacy shape keeping same id field wrong — better: write legacy meta for real_id
        let legacy = serde_json::json!({
            "id": real_id,
            "name": "old-incident",
            "created_at": 1_700_000_000,
            "engine": "duckdb"
        });
        std::fs::write(
            real_root.join("meta.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();
        let opened = LogCorpus::open(dir.path(), &real_id).expect("legacy meta must open");
        assert_eq!(opened.name(), "old-incident");
        let s = opened.summary();
        // counts derived from store when stats absent
        assert_eq!(s.event_count, opened.event_count() as u64);
        assert!(s.stats.is_none());
        assert!(s.ingest_pipeline_identity.is_none());
        assert_eq!(
            s.ingest_pipeline_compatibility,
            IngestPipelineCompatibility::LegacyUnknown
        );
    }

    #[test]
    fn new_corpus_records_current_ingest_pipeline_identity() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "fresh").unwrap();
        let meta = c.meta().unwrap();
        assert_eq!(
            meta.ingest_pipeline_identity.as_deref(),
            Some(INGEST_PIPELINE_IDENTITY)
        );
        assert_eq!(
            meta.ingest_pipeline_compatibility(),
            IngestPipelineCompatibility::Current
        );
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(c.root().join("meta.json")).unwrap())
                .unwrap();
        assert_eq!(raw["ingestPipelineIdentity"], INGEST_PIPELINE_IDENTITY);
        let summary = c.summary();
        assert_eq!(
            summary.ingest_pipeline_compatibility,
            IngestPipelineCompatibility::Current
        );
    }

    #[test]
    fn different_pipeline_version_reports_different_version() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "future").unwrap();
        let id = c.id().to_string();
        let root = c.root().to_path_buf();
        let mut meta = c.meta().unwrap();
        drop(c);
        meta.ingest_pipeline_identity = Some("contextdesk.ingest_pipeline.v99".into());
        write_meta_file(&root, &meta).unwrap();
        let opened = LogCorpus::open(dir.path(), &id).unwrap();
        let summary = opened.summary();
        assert_eq!(
            summary.ingest_pipeline_identity.as_deref(),
            Some("contextdesk.ingest_pipeline.v99")
        );
        assert_eq!(
            summary.ingest_pipeline_compatibility,
            IngestPipelineCompatibility::DifferentVersion
        );
        assert!(summary
            .ingest_pipeline_compatibility
            .needs_reimport_advisory());
    }

    #[test]
    fn past_pipeline_version_reports_different_version() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "past").unwrap();
        let id = c.id().to_string();
        let root = c.root().to_path_buf();
        let mut meta = c.meta().unwrap();
        drop(c);
        meta.ingest_pipeline_identity = Some("contextdesk.ingest_pipeline.v0".into());
        write_meta_file(&root, &meta).unwrap();
        let summary = LogCorpus::open(dir.path(), &id).unwrap().summary();
        assert_eq!(
            summary.ingest_pipeline_compatibility,
            IngestPipelineCompatibility::DifferentVersion
        );
    }

    #[test]
    fn malformed_pipeline_identity_still_opens_as_different_version() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "malformed").unwrap();
        let id = c.id().to_string();
        let root = c.root().to_path_buf();
        drop(c);
        let mut raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("meta.json")).unwrap())
                .unwrap();
        raw["ingestPipelineIdentity"] = serde_json::json!(42);
        std::fs::write(
            root.join("meta.json"),
            serde_json::to_vec_pretty(&raw).unwrap(),
        )
        .unwrap();
        let opened =
            LogCorpus::open(dir.path(), &id).expect("malformed identity must not block open");
        assert_eq!(opened.name(), "malformed");
        let summary = opened.summary();
        assert_eq!(
            summary.ingest_pipeline_compatibility,
            IngestPipelineCompatibility::DifferentVersion
        );
        // Identity must never leak secrets/paths even when malformed.
        let id_str = summary.ingest_pipeline_identity.unwrap_or_default();
        assert!(!id_str.contains('/'));
        assert!(!id_str.contains("password"));
    }

    #[test]
    fn ingest_reinforces_current_pipeline_identity() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("a.log")).unwrap();
        writeln!(f, "ts=1700000000 level=error msg=fail").unwrap();
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let report = crate::log_analysis::ingest_path(&cache, &logs, "s", None, "none").unwrap();
        let meta = LogCorpus::open(&cache, &report.corpus_id)
            .unwrap()
            .meta()
            .unwrap();
        assert_eq!(
            meta.ingest_pipeline_identity.as_deref(),
            Some(INGEST_PIPELINE_IDENTITY)
        );
        let list = LogCorpus::list_summaries(&cache).unwrap();
        let row = list.iter().find(|s| s.id == report.corpus_id).unwrap();
        assert_eq!(
            row.ingest_pipeline_compatibility,
            IngestPipelineCompatibility::Current
        );
    }

    #[test]
    fn list_summaries_reports_legacy_without_mutating_meta() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "stamp").unwrap();
        let id = c.id().to_string();
        let root = c.root().to_path_buf();
        // Give it stats so list_summaries takes the meta-only path.
        let mut meta = c.meta().unwrap();
        drop(c);
        meta.ingest_pipeline_identity = None;
        meta.stats = Some(CorpusStats {
            lines: 3,
            templates: 1,
            files: 1,
            ..CorpusStats::default()
        });
        write_meta_file(&root, &meta).unwrap();
        let before = std::fs::read_to_string(root.join("meta.json")).unwrap();
        let list = LogCorpus::list_summaries(dir.path()).unwrap();
        let row = list.iter().find(|s| s.id == id).unwrap();
        assert_eq!(
            row.ingest_pipeline_compatibility,
            IngestPipelineCompatibility::LegacyUnknown
        );
        let after = std::fs::read_to_string(root.join("meta.json")).unwrap();
        assert_eq!(before, after, "listing must not mutate meta.json");
        assert!(!before.contains("ingestPipelineIdentity"));
    }

    #[test]
    fn ingest_persists_meta_version_and_stats() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("a.log")).unwrap();
        for i in 0..40 {
            writeln!(f, "ts={} level=error msg=fail {}", 1_700_000_000 + i, i % 4).unwrap();
        }
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let report = crate::log_analysis::ingest_path(&cache, &logs, "s", None, "none").unwrap();
        assert!(report.stats.reduction_ratio > 1.0);
        assert!(report.stats.source_bytes > 0);
        assert!(report.stats.corpus_bytes > 0);
        let c = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let meta = c.meta().unwrap();
        assert_eq!(meta.meta_version, META_VERSION);
        let stats = meta.stats.expect("stats persisted");
        assert_eq!(stats.lines, report.stats.lines);
        assert!((stats.reduction_ratio - report.stats.reduction_ratio).abs() < 0.01);
        assert!(!meta.top_templates.is_empty());
        // list summaries
        let list = LogCorpus::list_summaries(&cache).unwrap();
        assert!(list
            .iter()
            .any(|s| s.id == report.corpus_id && s.stats.is_some()));
    }

    #[test]
    fn create_push_flush_open_is_duckdb() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "t1").unwrap();
        assert_eq!(c.event_engine(), "duckdb");
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(c.root().join("meta.json")).unwrap())
                .unwrap();
        assert_eq!(meta["engine"], "duckdb");
        assert!(c.root().join("events.duckdb").exists());
        let id = c.id().to_string();
        c.push_events(&[LogEvent {
            seq: 0,
            ts: 1,
            timestamp_provenance: TimestampProvenance::OrderOnly,
            active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
            unresolved_local_timestamp: None,
            level: "error".into(),
            service: Some("api".into()),
            host: None,
            template_id: 1,
            params: vec![],
            trace_id: None,
            message: "boom".into(),
            source: "a.log".into(),
        }])
        .unwrap();
        c.upsert_templates([TemplateRow {
            info: TemplateInfo {
                template_id: 1,
                pattern: "boom".into(),
                token_count: 1,
                count: 1,
                first_seen: 1,
                last_seen: 1,
                severity: 4,
                example: "boom".into(),
            },
            content_hash: "x".into(),
            vector: None,
        }])
        .unwrap();
        c.flush().unwrap();
        drop(c);
        let c2 = LogCorpus::open(dir.path(), &id).unwrap();
        assert_eq!(c2.event_engine(), "duckdb");
        assert_eq!(c2.event_count(), 1);
        assert_eq!(c2.template_count(), 1);
        let freq = c2.scan_template_frequency(None, None).unwrap();
        assert_eq!(freq, vec![(1, 1)]);
        LogCorpus::discard(dir.path(), &id).unwrap();
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn timestamp_provenance_and_unresolved_local_text_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "timestamp provenance").unwrap();
        let id = corpus.id().to_string();
        corpus
            .push_events(&[
                LogEvent {
                    seq: 1,
                    ts: 946_684_799,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "error".into(),
                    service: None,
                    host: None,
                    template_id: 1,
                    params: vec![],
                    trace_id: None,
                    message: "pre-2000 explicit".into(),
                    source: "old.log".into(),
                },
                LogEvent {
                    seq: 2,
                    ts: 1_000_000_000,
                    timestamp_provenance: TimestampProvenance::UnresolvedLocal,
                    active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                    unresolved_local_timestamp: Some("2021-03-05 02:53:53,654".into()),
                    level: "error".into(),
                    service: None,
                    host: None,
                    template_id: 2,
                    params: vec![],
                    trace_id: None,
                    message: "local timestamp".into(),
                    source: "server.log".into(),
                },
                LogEvent {
                    seq: 3,
                    ts: 1_000_000_001,
                    timestamp_provenance: TimestampProvenance::OrderOnly,
                    active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                    unresolved_local_timestamp: None,
                    level: "unknown".into(),
                    service: None,
                    host: None,
                    template_id: 3,
                    params: vec![],
                    trace_id: None,
                    message: "missing timestamp".into(),
                    source: "plain.log".into(),
                },
            ])
            .unwrap();
        corpus.flush().unwrap();
        drop(corpus);

        let reopened = LogCorpus::open(dir.path(), &id).unwrap();
        let events = reopened.with_events(ToOwned::to_owned);
        assert_eq!(events.len(), 3);
        assert_eq!(
            events[0].timestamp_provenance,
            TimestampProvenance::ExplicitWallClock
        );
        assert_eq!(
            events[0].active_timestamp_basis,
            ActiveTimestampBasis::ExplicitWall
        );
        assert_eq!(events[0].ts, 946_684_799);
        assert_eq!(
            events[1].timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(
            events[1].active_timestamp_basis,
            ActiveTimestampBasis::OrderOnly
        );
        assert_eq!(
            events[1].unresolved_local_timestamp.as_deref(),
            Some("2021-03-05 02:53:53,654")
        );
        assert_eq!(
            events[2].timestamp_provenance,
            TimestampProvenance::OrderOnly
        );
        assert_eq!(
            events[2].active_timestamp_basis,
            ActiveTimestampBasis::OrderOnly
        );
        assert_eq!(events[2].ts, 1_000_000_001);
        assert_eq!(events[2].message, "missing timestamp");
        assert_eq!(events[2].source, "plain.log");
    }

    #[test]
    fn timestamp_provenance_active_resolution_apply_and_clear_are_reversible() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "reversible local resolution").unwrap();
        let id = corpus.id().to_string();
        let mut event = LogEvent {
            seq: 42,
            ts: 42,
            timestamp_provenance: TimestampProvenance::UnresolvedLocal,
            active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
            unresolved_local_timestamp: Some("2021-03-05 02:53:53,654".into()),
            level: "error".into(),
            service: None,
            host: None,
            template_id: 1,
            params: vec![],
            trace_id: None,
            message: "local event".into(),
            source: "server.log".into(),
        };
        event.apply_resolved_local_timestamp(1_614_910_433).unwrap();
        assert_eq!(
            event.timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(
            event.active_timestamp_basis,
            ActiveTimestampBasis::ResolvedLocal
        );
        assert_eq!(
            event.unresolved_local_timestamp.as_deref(),
            Some("2021-03-05 02:53:53,654")
        );
        corpus.push_events(&[event]).unwrap();
        drop(corpus);

        let reopened = LogCorpus::open(dir.path(), &id).unwrap();
        let mut reopened_event = reopened.with_events(|events| events[0].clone());
        assert_eq!(reopened_event.ts, 1_614_910_433);
        assert_eq!(
            reopened_event.timestamp_provenance,
            TimestampProvenance::UnresolvedLocal
        );
        assert_eq!(
            reopened_event.active_timestamp_basis,
            ActiveTimestampBasis::ResolvedLocal
        );
        reopened_event.clear_resolved_local_timestamp().unwrap();
        assert_eq!(reopened_event.ts, 42);
        assert_eq!(
            reopened_event.active_timestamp_basis,
            ActiveTimestampBasis::OrderOnly
        );
        assert_eq!(
            reopened_event.unresolved_local_timestamp.as_deref(),
            Some("2021-03-05 02:53:53,654")
        );
    }

    #[test]
    fn timestamp_provenance_legacy_schema_migrates_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "legacy timestamp schema").unwrap();
        let id = corpus.id().to_string();
        corpus
            .with_connection(|connection| {
                connection
                    .execute(
                        "INSERT INTO events (
                            seq, ts, level, service, host, template_id, params,
                            trace_id, message, source
                         ) VALUES (1, 1700000000, 'error', NULL, NULL, 1, '[]',
                                   NULL, 'legacy payload', 'legacy.log')",
                        [],
                    )
                    .map_err(duck_err)?;
                connection
                    .execute_batch(
                        "DROP TABLE event_revision_state;
                         DROP INDEX idx_events_ts;
                         DROP INDEX idx_events_template;
                         DROP INDEX idx_events_level;
                         DROP INDEX idx_events_service;
                         DROP INDEX idx_events_trace;
                         DROP INDEX idx_events_timestamp_provenance;
                         DROP INDEX idx_events_active_timestamp_basis;
                         ALTER TABLE events DROP COLUMN timestamp_provenance;
                         ALTER TABLE events DROP COLUMN active_timestamp_basis;
                         ALTER TABLE events DROP COLUMN unresolved_local_timestamp;",
                    )
                    .map_err(duck_err)
            })
            .unwrap();
        drop(corpus);

        let reopened = LogCorpus::open(dir.path(), &id).unwrap();
        let events = reopened.with_events(ToOwned::to_owned);
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].timestamp_provenance,
            TimestampProvenance::LegacyUnknown
        );
        assert_eq!(
            events[0].active_timestamp_basis,
            ActiveTimestampBasis::LegacyUnknown
        );
        assert_eq!(events[0].ts, 1_700_000_000);
        assert_eq!(events[0].message, "legacy payload");
        assert_eq!(events[0].source, "legacy.log");
        assert_eq!(reopened.event_revision(), 0);
        reopened
            .with_connection(|connection| {
                let (revision, count, min, max) = connection
                    .query_row(
                        "SELECT current_revision, event_count, ts_min, ts_max
                         FROM event_revision_state WHERE singleton = 1",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, Option<i64>>(2)?,
                                row.get::<_, Option<i64>>(3)?,
                            ))
                        },
                    )
                    .map_err(duck_err)?;
                assert_eq!((revision, count), (0, 1));
                assert_eq!((min, max), (Some(1_700_000_000), Some(1_700_000_000)));
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn append_publishes_monotonic_durable_revision_and_clears_stale_undo() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(dir.path(), "durable append revision").unwrap();
        let id = corpus.id().to_string();
        assert_eq!(corpus.event_revision(), 0);
        corpus
            .push_events(&[
                LogEvent {
                    seq: 1,
                    ts: 10,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "info".into(),
                    service: None,
                    host: None,
                    template_id: 1,
                    params: vec![],
                    trace_id: None,
                    message: "first".into(),
                    source: "a.log".into(),
                },
                LogEvent {
                    seq: 2,
                    ts: 20,
                    timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                    active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                    unresolved_local_timestamp: None,
                    level: "warn".into(),
                    service: None,
                    host: None,
                    template_id: 2,
                    params: vec![],
                    trace_id: None,
                    message: "second".into(),
                    source: "a.log".into(),
                },
            ])
            .unwrap();
        assert_eq!(corpus.event_revision(), 1);
        corpus
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "CREATE TABLE events_previous AS SELECT * FROM events;
                         UPDATE event_revision_state
                            SET previous_revision = 0,
                                previous_metadata_json = '{}',
                                previous_event_count = 2,
                                previous_ts_min = 10,
                                previous_ts_max = 20
                          WHERE singleton = 1;",
                    )
                    .map_err(duck_err)
            })
            .unwrap();
        corpus
            .push_events(&[LogEvent {
                seq: 3,
                ts: 5,
                timestamp_provenance: TimestampProvenance::OrderOnly,
                active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                unresolved_local_timestamp: None,
                level: "unknown".into(),
                service: None,
                host: None,
                template_id: 3,
                params: vec![],
                trace_id: None,
                message: "third".into(),
                source: "plain.log".into(),
            }])
            .unwrap();
        assert_eq!(corpus.event_revision(), 2);
        corpus
            .with_connection(|connection| {
                let state = connection
                    .query_row(
                        "SELECT current_revision, previous_revision, event_count,
                                ts_min, ts_max, previous_event_count
                         FROM event_revision_state WHERE singleton = 1",
                        [],
                        |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, Option<i64>>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, Option<i64>>(3)?,
                                row.get::<_, Option<i64>>(4)?,
                                row.get::<_, Option<i64>>(5)?,
                            ))
                        },
                    )
                    .map_err(duck_err)?;
                assert_eq!(state, (2, None, 3, Some(5), Some(20), None));
                let previous_tables = connection
                    .query_row(
                        "SELECT COUNT(*) FROM information_schema.tables
                         WHERE table_name = 'events_previous'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(duck_err)?;
                assert_eq!(previous_tables, 0);
                Ok(())
            })
            .unwrap();
        drop(corpus);

        let reopened = LogCorpus::open(dir.path(), &id).unwrap();
        assert_eq!(reopened.event_revision(), 2);
        assert_eq!(reopened.event_count(), 3);
    }

    /// Default-suite medium scan (keeps CI fast). Multi-million is #[ignore].
    #[test]
    fn duckdb_scan_bench_200k() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "bench").unwrap();
        assert_eq!(c.event_engine(), EVENT_ENGINE);
        let n = 200_000u64;
        let mut batch = Vec::with_capacity(4096);
        let t_ingest = Instant::now();
        for i in 0..n {
            batch.push(LogEvent {
                seq: i,
                ts: (i / 10) as i64,
                timestamp_provenance: TimestampProvenance::OrderOnly,
                active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                unresolved_local_timestamp: None,
                level: if i % 10 == 0 { "error" } else { "info" }.into(),
                service: Some(if i % 3 == 0 { "api" } else { "worker" }.into()),
                host: Some("h1".into()),
                template_id: (i % 50) + 1,
                params: vec![],
                trace_id: None,
                message: format!("event {i}"),
                source: "b.log".into(),
            });
            if batch.len() >= 4096 {
                c.push_events(&batch).unwrap();
                batch.clear();
            }
        }
        if !batch.is_empty() {
            c.push_events(&batch).unwrap();
        }
        let ingest_dt = t_ingest.elapsed();

        let t0 = Instant::now();
        let freq = c.scan_template_frequency(None, None).unwrap();
        let freq_dt = t0.elapsed();
        assert_eq!(freq.len(), 50);

        let t1 = Instant::now();
        let by_svc = c.scan_error_by_service().unwrap();
        let err_dt = t1.elapsed();
        let err_total: u64 = by_svc.iter().map(|(_, c)| *c).sum();
        assert_eq!(err_total, n / 10);

        let t2 = Instant::now();
        let co = c.scan_co_occurrence(5, 20).unwrap();
        let co_dt = t2.elapsed();

        eprintln!(
            "duckdb_scan engine={} rows={n} ingest={ingest_dt:?} \
             template_frequency={freq_dt:?} error_by_service={err_dt:?} \
             co_occurrence(window=5s,top20)={co_dt:?} co_pairs={}",
            c.event_engine(),
            co.len()
        );
        assert!(c.event_count() as u64 == n);
    }

    /// Multi-million-row real DuckDB analytical scan (#358 close-proof).
    /// Run: `cargo test -p cd-core duckdb_multi_million -- --ignored --nocapture`
    #[test]
    #[ignore = "multi-million DuckDB ingest; run offline for #358 close-proof"]
    fn duckdb_multi_million_scan() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "mm").unwrap();
        assert_eq!(c.event_engine(), "duckdb");
        let n = 2_000_000u64;
        let templates_n = 80u64;
        let mut batch = Vec::with_capacity(8192);
        let t_ingest = Instant::now();
        for i in 0..n {
            batch.push(LogEvent {
                seq: i,
                ts: (i / 100) as i64,
                timestamp_provenance: TimestampProvenance::OrderOnly,
                active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                unresolved_local_timestamp: None,
                level: if i % 20 == 0 {
                    "error"
                } else if i % 7 == 0 {
                    "warn"
                } else {
                    "info"
                }
                .into(),
                service: Some(
                    match i % 4 {
                        0 => "api",
                        1 => "worker",
                        2 => "db",
                        _ => "gateway",
                    }
                    .into(),
                ),
                host: Some(format!("node-{}", i % 16)),
                template_id: (i % templates_n) + 1,
                params: vec![format!("{}", i % 1000)],
                trace_id: if i % 50 == 0 {
                    Some(format!("tr-{}", i % 5000))
                } else {
                    None
                },
                message: format!("t{} param {}", i % templates_n, i % 1000),
                source: "synth.log".into(),
            });
            if batch.len() >= 8192 {
                c.push_events(&batch).unwrap();
                batch.clear();
            }
        }
        if !batch.is_empty() {
            c.push_events(&batch).unwrap();
        }
        let ingest_dt = t_ingest.elapsed();
        // Fake drain reduction: n events / templates_n unique templates
        let reduction = n as f64 / templates_n as f64;

        let t0 = Instant::now();
        let freq = c.scan_template_frequency(None, None).unwrap();
        let freq_dt = t0.elapsed();

        let t1 = Instant::now();
        let by_svc = c.scan_error_by_service().unwrap();
        let err_dt = t1.elapsed();

        let t2 = Instant::now();
        // Co-occurrence on full 2M self-join is heavy; sample via time slice if needed.
        // Window 2s on dense timestamps is still large — limit pair output.
        let co = c.scan_co_occurrence(2, 50).unwrap();
        let co_dt = t2.elapsed();

        eprintln!(
            "duckdb_multi_million engine={} rows={n} templates={templates_n} \
             reduction_ratio={reduction:.1} ingest={ingest_dt:?} \
             template_frequency={freq_dt:?} (groups={}) \
             error_by_service={err_dt:?} (services={}) \
             co_occurrence={co_dt:?} (pairs={})",
            c.event_engine(),
            freq.len(),
            by_svc.len(),
            co.len()
        );
        assert_eq!(c.event_count() as u64, n);
        assert_eq!(freq.len() as u64, templates_n);
        assert!(
            freq_dt.as_secs_f64() < 60.0,
            "frequency scan too slow: {freq_dt:?}"
        );
    }
}
