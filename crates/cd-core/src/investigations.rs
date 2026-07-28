//! Durable, payload-free investigation evidence collections.
//!
//! Investigation documents deliberately live under a caller-supplied durable
//! root. They never derive storage from a disposable log corpus cache. Saved
//! evidence contains only bounded, authoritative [`BookmarkEventRef`] values;
//! event messages, excerpts, parameters, and source payloads are resolved from
//! the corpus only for transient previews.
//!
//! Every mutation uses optimistic revision checks and publishes a new,
//! append-only revision file with no-clobber semantics. Existing revisions are
//! never overwritten, so an interrupted or rejected publication cannot damage
//! the last readable revision.

use crate::error::{CoreError, CoreResult};
use crate::log_analysis::bookmarks::canonicalize_exact_event_refs;
use crate::log_analysis::query::fetch_events_by_seqs;
use crate::log_analysis::{BookmarkEventRef, ExplorerEvent, LogCorpus, MAX_BOOKMARK_EVENT_REFS};
use crate::redact::redact_candidate;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use uuid::{Uuid, Version};

/// Investigation document schema understood by this build.
pub const INVESTIGATION_SCHEMA_VERSION: u32 = 1;
/// Maximum durable investigation documents under one store root.
pub const MAX_INVESTIGATION_DOCUMENTS: usize = 256;
/// Maximum append-only revisions retained for one investigation.
pub const MAX_INVESTIGATION_REVISIONS: u64 = 4_096;
/// Maximum evidence items in one investigation.
pub const MAX_INVESTIGATION_EVIDENCE_ITEMS: usize = 1_024;
/// Maximum exact references across one investigation.
pub const MAX_INVESTIGATION_TOTAL_EVENT_REFS: usize = 8_192;
/// Maximum UTF-8 bytes in an investigation or evidence title.
pub const MAX_INVESTIGATION_TITLE_BYTES: usize = 256;
/// Maximum corpus links represented by the versioned document model.
pub const MAX_INVESTIGATION_CORPUS_LINKS: usize = 16;

const MAX_CORPUS_ID_BYTES: usize = 128;
const MAX_SOURCE_IDENTITY_BYTES: usize = 1_024;
const MAX_INVESTIGATION_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_STORE_DIRECTORY_ENTRIES: usize = MAX_INVESTIGATION_DOCUMENTS + 128;
const MAX_INVESTIGATION_DIRECTORY_ENTRIES: usize = MAX_INVESTIGATION_REVISIONS as usize + 128;

/// Lifecycle state for a durable investigation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InvestigationStatus {
    /// Investigation remains open for evidence collection.
    Active,
    /// Investigation is retained but no longer accepts evidence.
    Archived,
}

/// One corpus associated with an investigation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationCorpusLink {
    /// Stable corpus identifier; never a corpus cache path.
    pub corpus_id: String,
}

/// Provenance of one saved evidence item.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceProvenance {
    /// A person explicitly selected and saved the evidence.
    Human,
}

/// A durable exact-event evidence item.
///
/// Only identity hints are persisted. Payloads are resolved transiently from
/// the authoritative corpus and never serialized into this type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceItem {
    /// Stable UUIDv7 evidence identifier.
    pub id: String,
    /// Human-facing, redacted title.
    pub title: String,
    /// Explicit provenance for this saved item.
    pub provenance: EvidenceProvenance,
    /// Corpus that owns every exact event reference.
    pub corpus_id: String,
    /// Bounded, payload-free exact event identities.
    pub event_refs: Vec<BookmarkEventRef>,
    /// Creation time as Unix seconds.
    pub created_at: i64,
    /// Last update time as Unix seconds.
    pub updated_at: i64,
}

/// Complete append-only investigation revision.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationDocument {
    /// Versioned schema. Unknown versions fail closed.
    pub schema_version: u32,
    /// Stable UUIDv7 investigation identifier.
    pub id: String,
    /// Monotonic append-only revision, beginning at one.
    pub revision: u64,
    /// Human-facing, redacted title.
    pub title: String,
    /// Current lifecycle state.
    pub status: InvestigationStatus,
    /// Corpora associated with this investigation.
    pub corpus_links: Vec<InvestigationCorpusLink>,
    /// Durable, human-provenance exact evidence.
    pub evidence: Vec<EvidenceItem>,
    /// Creation time as Unix seconds.
    pub created_at: i64,
    /// Last update time as Unix seconds.
    pub updated_at: i64,
}

/// Bounded list projection that does not resolve corpus payloads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationSummary {
    /// Stable investigation identifier.
    pub id: String,
    /// Latest readable revision.
    pub revision: u64,
    /// Redacted display title.
    pub title: String,
    /// Current lifecycle state.
    pub status: InvestigationStatus,
    /// Linked corpus identifiers.
    pub corpus_links: Vec<InvestigationCorpusLink>,
    /// Number of saved evidence items.
    pub evidence_count: usize,
    /// Creation time as Unix seconds.
    pub created_at: i64,
    /// Last update time as Unix seconds.
    pub updated_at: i64,
}

impl From<&InvestigationDocument> for InvestigationSummary {
    fn from(document: &InvestigationDocument) -> Self {
        Self {
            id: document.id.clone(),
            revision: document.revision,
            title: document.title.clone(),
            status: document.status,
            corpus_links: document.corpus_links.clone(),
            evidence_count: document.evidence.len(),
            created_at: document.created_at,
            updated_at: document.updated_at,
        }
    }
}

/// Current authoritative state of one saved exact reference.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceReferenceStatus {
    /// Corpus, sequence, source, timestamp, and time quality still match.
    Verified,
    /// The saved sequence no longer exists in the authoritative corpus.
    Missing,
    /// The sequence exists but its persisted identity hints no longer match.
    Stale,
}

/// One saved reference plus its current authoritative resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceReferenceResolution {
    /// Original durable reference; missing or stale identities are never dropped.
    pub event_ref: BookmarkEventRef,
    /// Current resolution state.
    pub status: EvidenceReferenceStatus,
    /// Transient authoritative event when the sequence still exists.
    ///
    /// This payload is returned to a caller for preview only and is never part
    /// of [`InvestigationDocument`] serialization.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<ExplorerEvent>,
}

/// One evidence item with current per-reference resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedEvidenceItem {
    /// Durable payload-free evidence metadata.
    pub item: EvidenceItem,
    /// One status entry for every saved reference, in saved order.
    pub references: Vec<EvidenceReferenceResolution>,
}

/// A loaded investigation plus honest current evidence resolution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedInvestigationDocument {
    /// Latest durable document revision.
    pub document: InvestigationDocument,
    /// Resolved evidence in the same order as `document.evidence`.
    pub evidence: Vec<ResolvedEvidenceItem>,
}

/// Bounded transient preview of one saved evidence item.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePreview {
    /// Investigation that owns the evidence.
    pub investigation_id: String,
    /// Revision from which the evidence was loaded.
    pub revision: u64,
    /// Durable payload-free evidence metadata.
    pub item: EvidenceItem,
    /// One current status and optional authoritative event per saved reference.
    pub references: Vec<EvidenceReferenceResolution>,
}

/// Durable investigation store rooted exactly at a caller-supplied directory.
///
/// The caller is responsible for choosing a profile/config location outside
/// disposable corpus cache storage. This type never derives a path from
/// [`LogCorpus::root`].
#[derive(Debug, Clone)]
pub struct InvestigationStore {
    root: PathBuf,
}

impl InvestigationStore {
    /// Construct a store at the exact supplied durable root.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Exact durable root supplied by the caller.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Create one active investigation linked to `corpus`.
    pub fn create(
        &self,
        title: impl Into<String>,
        corpus: &LogCorpus,
    ) -> CoreResult<InvestigationDocument> {
        let title = sanitize_title("investigation title", title.into())?;
        self.ensure_root()?;
        if self.document_directories()?.len() >= MAX_INVESTIGATION_DOCUMENTS {
            return Err(CoreError::Message(format!(
                "investigation store exceeds {MAX_INVESTIGATION_DOCUMENTS} documents"
            )));
        }

        let now = crate::embed::now_unix_secs();
        for _ in 0..8 {
            let id = Uuid::now_v7().to_string();
            let directory = self.root.join(&id);
            match std::fs::create_dir(&directory) {
                Ok(()) => {
                    let document = InvestigationDocument {
                        schema_version: INVESTIGATION_SCHEMA_VERSION,
                        id,
                        revision: 1,
                        title: title.clone(),
                        status: InvestigationStatus::Active,
                        corpus_links: vec![InvestigationCorpusLink {
                            corpus_id: corpus.id().to_string(),
                        }],
                        evidence: Vec::new(),
                        created_at: now,
                        updated_at: now,
                    };
                    if let Err(error) = publish_revision(&directory, &document) {
                        let _ = std::fs::remove_dir(&directory);
                        return Err(error);
                    }
                    return Ok(document);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(CoreError::Message(format!(
                        "create investigation directory: {error}"
                    )));
                }
            }
        }
        Err(CoreError::Message(
            "could not allocate a unique investigation id".into(),
        ))
    }

    /// List latest investigation summaries with bounded directory and file work.
    pub fn list(&self) -> CoreResult<Vec<InvestigationSummary>> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut summaries = self
            .document_directories()?
            .into_iter()
            .map(|(id, _)| self.load_document(&id))
            .collect::<CoreResult<Vec<_>>>()?
            .iter()
            .map(InvestigationSummary::from)
            .collect::<Vec<_>>();
        summaries.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        Ok(summaries)
    }

    /// Load the latest revision and resolve every saved reference against `corpus`.
    ///
    /// Missing and stale references remain in the returned structure with an
    /// explicit status; they are never silently removed.
    pub fn load(
        &self,
        investigation_id: &str,
        corpus: &LogCorpus,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        let document = self.load_document(investigation_id)?;
        resolve_document(document, corpus)
    }

    /// Add one exact, human-provenance evidence item.
    ///
    /// `expected_revision` must equal the latest readable revision. A competing
    /// writer that publishes first wins; this writer receives a stale-revision
    /// error without overwriting any revision. Saving the same canonical exact
    /// set again is idempotent and does not create a new revision.
    pub fn add_exact_evidence(
        &self,
        investigation_id: &str,
        expected_revision: u64,
        title: impl Into<String>,
        corpus: &LogCorpus,
        event_refs: Vec<BookmarkEventRef>,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        let title = sanitize_title("evidence title", title.into())?;
        let mut document = self.load_document(investigation_id)?;
        if document.revision != expected_revision {
            return Err(stale_revision_error(
                investigation_id,
                expected_revision,
                document.revision,
            ));
        }
        if document.status != InvestigationStatus::Active {
            return Err(CoreError::Message(format!(
                "investigation {investigation_id} is archived"
            )));
        }
        ensure_corpus_link(&document, corpus.id())?;
        if document
            .evidence
            .iter()
            .any(|item| item.corpus_id != corpus.id())
        {
            return Err(CoreError::Message(
                "first-slice evidence mutation requires one authoritative corpus".into(),
            ));
        }

        let event_refs = canonicalize_exact_event_refs(corpus, event_refs)?;
        if document.evidence.iter().any(|item| {
            item.corpus_id == corpus.id() && exact_event_sets_equal(&item.event_refs, &event_refs)
        }) {
            return resolve_document(document, corpus);
        }

        if document.evidence.len() >= MAX_INVESTIGATION_EVIDENCE_ITEMS {
            return Err(CoreError::Message(format!(
                "investigation exceeds {MAX_INVESTIGATION_EVIDENCE_ITEMS} evidence items"
            )));
        }
        let existing_refs = document.evidence.iter().try_fold(0usize, |total, item| {
            total
                .checked_add(item.event_refs.len())
                .ok_or_else(|| CoreError::Message("investigation reference count overflow".into()))
        })?;
        let total_refs = existing_refs
            .checked_add(event_refs.len())
            .ok_or_else(|| CoreError::Message("investigation reference count overflow".into()))?;
        if total_refs > MAX_INVESTIGATION_TOTAL_EVENT_REFS {
            return Err(CoreError::Message(format!(
                "investigation exceeds {MAX_INVESTIGATION_TOTAL_EVENT_REFS} exact event references"
            )));
        }

        let now = crate::embed::now_unix_secs();
        document.evidence.push(EvidenceItem {
            id: Uuid::now_v7().to_string(),
            title,
            provenance: EvidenceProvenance::Human,
            corpus_id: corpus.id().to_string(),
            event_refs,
            created_at: now,
            updated_at: now,
        });
        document.revision = document
            .revision
            .checked_add(1)
            .ok_or_else(|| CoreError::Message("investigation revision overflow".into()))?;
        document.updated_at = now;

        let directory = self.investigation_directory(investigation_id)?;
        publish_revision(&directory, &document)?;
        resolve_document(document, corpus)
    }

    /// Preview one evidence item without mutating the durable document or Explorer view.
    pub fn preview_evidence(
        &self,
        investigation_id: &str,
        evidence_id: &str,
        corpus: &LogCorpus,
    ) -> CoreResult<EvidencePreview> {
        validate_uuid_v7("evidence id", evidence_id)?;
        let document = self.load_document(investigation_id)?;
        ensure_corpus_link(&document, corpus.id())?;
        let item = document
            .evidence
            .iter()
            .find(|item| item.id == evidence_id)
            .ok_or_else(|| {
                CoreError::Message(format!(
                    "evidence {evidence_id} not found in investigation {investigation_id}"
                ))
            })?
            .clone();
        if item.corpus_id != corpus.id() {
            return Err(CoreError::Message(format!(
                "evidence {evidence_id} belongs to corpus {}, not {}",
                item.corpus_id,
                corpus.id()
            )));
        }
        let references = resolve_evidence_references(&item.event_refs, corpus)?;
        Ok(EvidencePreview {
            investigation_id: document.id,
            revision: document.revision,
            item,
            references,
        })
    }

    fn ensure_root(&self) -> CoreResult<()> {
        std::fs::create_dir_all(&self.root).map_err(|error| {
            CoreError::Message(format!("create investigation store root: {error}"))
        })
    }

    fn document_directories(&self) -> CoreResult<Vec<(String, PathBuf)>> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut directories = Vec::new();
        let mut entries = 0usize;
        for entry in std::fs::read_dir(&self.root)
            .map_err(|error| CoreError::Message(format!("list investigation store: {error}")))?
        {
            entries = entries
                .checked_add(1)
                .ok_or_else(|| CoreError::Message("investigation entry count overflow".into()))?;
            if entries > MAX_STORE_DIRECTORY_ENTRIES {
                return Err(CoreError::Message(format!(
                    "investigation store exceeds {MAX_STORE_DIRECTORY_ENTRIES} directory entries"
                )));
            }
            let entry = entry.map_err(|error| {
                CoreError::Message(format!("read investigation store entry: {error}"))
            })?;
            let file_type = entry.file_type().map_err(|error| {
                CoreError::Message(format!("inspect investigation store entry: {error}"))
            })?;
            if !file_type.is_dir() {
                continue;
            }
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_uuid_v7("investigation id", &id).is_ok() {
                directories.push((id, entry.path()));
            }
        }
        if directories.len() > MAX_INVESTIGATION_DOCUMENTS {
            return Err(CoreError::Message(format!(
                "investigation store exceeds {MAX_INVESTIGATION_DOCUMENTS} documents"
            )));
        }
        Ok(directories)
    }

    fn investigation_directory(&self, investigation_id: &str) -> CoreResult<PathBuf> {
        validate_uuid_v7("investigation id", investigation_id)?;
        let directory = self.root.join(investigation_id);
        let metadata = std::fs::symlink_metadata(&directory).map_err(|error| {
            CoreError::Message(format!(
                "investigation {investigation_id} is unavailable: {error}"
            ))
        })?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(CoreError::Message(format!(
                "investigation {investigation_id} is not a regular directory"
            )));
        }
        Ok(directory)
    }

    fn load_document(&self, investigation_id: &str) -> CoreResult<InvestigationDocument> {
        let directory = self.investigation_directory(investigation_id)?;
        let (revision, path) = latest_revision_path(&directory)?;
        read_revision(&path, investigation_id, revision)
    }
}

fn sanitize_title(kind: &str, title: String) -> CoreResult<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CoreError::Message(format!("{kind} must not be empty")));
    }
    if title.len() > MAX_INVESTIGATION_TITLE_BYTES {
        return Err(CoreError::Message(format!(
            "{kind} exceeds {MAX_INVESTIGATION_TITLE_BYTES} UTF-8 bytes"
        )));
    }
    if title.chars().any(char::is_control) {
        return Err(CoreError::Message(format!(
            "{kind} contains unsupported control characters"
        )));
    }
    let redaction = redact_candidate(title);
    if redaction.blocked {
        return Err(CoreError::Message(
            redaction
                .block_reason
                .unwrap_or_else(|| format!("{kind} appears credential-dominant")),
        ));
    }
    let redacted = redaction.text.trim().to_string();
    if redacted.is_empty() || redacted.len() > MAX_INVESTIGATION_TITLE_BYTES {
        return Err(CoreError::Message(format!(
            "{kind} is empty or exceeds {MAX_INVESTIGATION_TITLE_BYTES} UTF-8 bytes after redaction"
        )));
    }
    Ok(redacted)
}

fn validate_stored_title(kind: &str, title: &str) -> CoreResult<()> {
    let sanitized = sanitize_title(kind, title.to_string())?;
    if sanitized != title {
        return Err(CoreError::Message(format!(
            "{kind} is not in canonical redacted form"
        )));
    }
    Ok(())
}

fn validate_uuid_v7(kind: &str, value: &str) -> CoreResult<()> {
    let uuid = Uuid::parse_str(value)
        .map_err(|_| CoreError::Message(format!("{kind} must be a UUIDv7")))?;
    if uuid.get_version() != Some(Version::SortRand) {
        return Err(CoreError::Message(format!("{kind} must be a UUIDv7")));
    }
    Ok(())
}

fn validate_corpus_id(corpus_id: &str) -> CoreResult<()> {
    if corpus_id.is_empty() || corpus_id.len() > MAX_CORPUS_ID_BYTES {
        return Err(CoreError::Message(format!(
            "corpus id must contain 1..={MAX_CORPUS_ID_BYTES} UTF-8 bytes"
        )));
    }
    if corpus_id.chars().any(char::is_control) {
        return Err(CoreError::Message(
            "corpus id contains unsupported control characters".into(),
        ));
    }
    Ok(())
}

fn validate_source_identity(source: &str) -> CoreResult<()> {
    if source.is_empty() || source.len() > MAX_SOURCE_IDENTITY_BYTES {
        return Err(CoreError::Message(format!(
            "evidence source must contain 1..={MAX_SOURCE_IDENTITY_BYTES} UTF-8 bytes"
        )));
    }
    let path = Path::new(source);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(CoreError::Message(
            "evidence source must be a relative source identity".into(),
        ));
    }
    Ok(())
}

fn validate_document(
    document: &InvestigationDocument,
    expected_id: Option<&str>,
    expected_revision: Option<u64>,
) -> CoreResult<()> {
    if document.schema_version != INVESTIGATION_SCHEMA_VERSION {
        return Err(CoreError::Message(format!(
            "investigation schema version {} is unsupported; expected {INVESTIGATION_SCHEMA_VERSION}",
            document.schema_version
        )));
    }
    validate_uuid_v7("investigation id", &document.id)?;
    if expected_id.is_some_and(|expected| expected != document.id) {
        return Err(CoreError::Message(
            "investigation id does not match its durable directory".into(),
        ));
    }
    if document.revision == 0 || document.revision > MAX_INVESTIGATION_REVISIONS {
        return Err(CoreError::Message(format!(
            "investigation revision must be within 1..={MAX_INVESTIGATION_REVISIONS}"
        )));
    }
    if expected_revision.is_some_and(|expected| expected != document.revision) {
        return Err(CoreError::Message(
            "investigation revision does not match its revision filename".into(),
        ));
    }
    validate_stored_title("investigation title", &document.title)?;
    if document.created_at > document.updated_at {
        return Err(CoreError::Message(
            "investigation updated_at precedes created_at".into(),
        ));
    }
    if document.corpus_links.is_empty()
        || document.corpus_links.len() > MAX_INVESTIGATION_CORPUS_LINKS
    {
        return Err(CoreError::Message(format!(
            "investigation must contain 1..={MAX_INVESTIGATION_CORPUS_LINKS} corpus links"
        )));
    }
    let mut linked_corpora = HashSet::new();
    for link in &document.corpus_links {
        validate_corpus_id(&link.corpus_id)?;
        if !linked_corpora.insert(link.corpus_id.as_str()) {
            return Err(CoreError::Message(format!(
                "investigation repeats corpus link {}",
                link.corpus_id
            )));
        }
    }
    if document.evidence.len() > MAX_INVESTIGATION_EVIDENCE_ITEMS {
        return Err(CoreError::Message(format!(
            "investigation exceeds {MAX_INVESTIGATION_EVIDENCE_ITEMS} evidence items"
        )));
    }

    let mut evidence_ids = HashSet::new();
    let mut total_refs = 0usize;
    for item in &document.evidence {
        validate_uuid_v7("evidence id", &item.id)?;
        if !evidence_ids.insert(item.id.as_str()) {
            return Err(CoreError::Message(format!(
                "investigation repeats evidence id {}",
                item.id
            )));
        }
        validate_stored_title("evidence title", &item.title)?;
        if item.created_at > item.updated_at {
            return Err(CoreError::Message(format!(
                "evidence {} updated_at precedes created_at",
                item.id
            )));
        }
        validate_corpus_id(&item.corpus_id)?;
        if !linked_corpora.contains(item.corpus_id.as_str()) {
            return Err(CoreError::Message(format!(
                "evidence {} references unlinked corpus {}",
                item.id, item.corpus_id
            )));
        }
        if item.event_refs.is_empty() || item.event_refs.len() > MAX_BOOKMARK_EVENT_REFS {
            return Err(CoreError::Message(format!(
                "evidence {} must contain 1..={MAX_BOOKMARK_EVENT_REFS} exact event references",
                item.id
            )));
        }
        total_refs = total_refs
            .checked_add(item.event_refs.len())
            .ok_or_else(|| CoreError::Message("investigation reference count overflow".into()))?;
        let mut previous_seq = None;
        for event_ref in &item.event_refs {
            if event_ref.corpus_id != item.corpus_id {
                return Err(CoreError::Message(format!(
                    "evidence {} contains a reference for another corpus",
                    item.id
                )));
            }
            validate_source_identity(&event_ref.source)?;
            if previous_seq.is_some_and(|previous| event_ref.seq <= previous) {
                return Err(CoreError::Message(format!(
                    "evidence {} references are not canonical and strictly ordered",
                    item.id
                )));
            }
            previous_seq = Some(event_ref.seq);
        }
    }
    if total_refs > MAX_INVESTIGATION_TOTAL_EVENT_REFS {
        return Err(CoreError::Message(format!(
            "investigation exceeds {MAX_INVESTIGATION_TOTAL_EVENT_REFS} exact event references"
        )));
    }
    Ok(())
}

fn exact_event_sets_equal(left: &[BookmarkEventRef], right: &[BookmarkEventRef]) -> bool {
    left == right
}

fn ensure_corpus_link(document: &InvestigationDocument, corpus_id: &str) -> CoreResult<()> {
    if document
        .corpus_links
        .iter()
        .any(|link| link.corpus_id == corpus_id)
    {
        Ok(())
    } else {
        Err(CoreError::Message(format!(
            "investigation {} is not linked to corpus {corpus_id}",
            document.id
        )))
    }
}

fn resolve_document(
    document: InvestigationDocument,
    corpus: &LogCorpus,
) -> CoreResult<ResolvedInvestigationDocument> {
    ensure_corpus_link(&document, corpus.id())?;
    if document
        .evidence
        .iter()
        .any(|item| item.corpus_id != corpus.id())
    {
        return Err(CoreError::Message(
            "loading a multi-corpus investigation requires all authoritative corpora".into(),
        ));
    }
    let seqs = document
        .evidence
        .iter()
        .flat_map(|item| item.event_refs.iter().map(|event_ref| event_ref.seq))
        .collect::<Vec<_>>();
    let actual_by_seq = fetch_events_by_seqs(corpus, &seqs)?
        .into_iter()
        .map(|event| (event.seq, event))
        .collect::<HashMap<_, _>>();
    let evidence = document
        .evidence
        .iter()
        .cloned()
        .map(|item| ResolvedEvidenceItem {
            references: resolve_references_from_map(&item.event_refs, corpus.id(), &actual_by_seq),
            item,
        })
        .collect();
    Ok(ResolvedInvestigationDocument { document, evidence })
}

fn resolve_evidence_references(
    event_refs: &[BookmarkEventRef],
    corpus: &LogCorpus,
) -> CoreResult<Vec<EvidenceReferenceResolution>> {
    let seqs = event_refs
        .iter()
        .map(|event_ref| event_ref.seq)
        .collect::<Vec<_>>();
    let actual_by_seq = fetch_events_by_seqs(corpus, &seqs)?
        .into_iter()
        .map(|event| (event.seq, event))
        .collect::<HashMap<_, _>>();
    Ok(resolve_references_from_map(
        event_refs,
        corpus.id(),
        &actual_by_seq,
    ))
}

fn resolve_references_from_map(
    event_refs: &[BookmarkEventRef],
    corpus_id: &str,
    actual_by_seq: &HashMap<u64, ExplorerEvent>,
) -> Vec<EvidenceReferenceResolution> {
    event_refs
        .iter()
        .cloned()
        .map(|event_ref| {
            let event = actual_by_seq.get(&event_ref.seq).cloned();
            let status = match event.as_ref() {
                None => EvidenceReferenceStatus::Missing,
                Some(actual)
                    if event_ref.corpus_id != corpus_id
                        || actual.source != event_ref.source
                        || actual.ts != event_ref.timestamp_hint
                        || actual.time_quality != event_ref.time_quality_hint =>
                {
                    EvidenceReferenceStatus::Stale
                }
                Some(_) => EvidenceReferenceStatus::Verified,
            };
            EvidenceReferenceResolution {
                event_ref,
                status,
                event,
            }
        })
        .collect()
}

fn revision_filename(revision: u64) -> String {
    format!("revision-{revision:020}.json")
}

fn parse_revision_filename(path: &Path) -> Option<u64> {
    let name = path.file_name()?.to_str()?;
    let digits = name.strip_prefix("revision-")?.strip_suffix(".json")?;
    if digits.len() != 20 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

fn latest_revision_path(directory: &Path) -> CoreResult<(u64, PathBuf)> {
    let mut latest: Option<(u64, PathBuf)> = None;
    let mut entries = 0usize;
    let mut revision_files = 0usize;
    for entry in std::fs::read_dir(directory)
        .map_err(|error| CoreError::Message(format!("list investigation revisions: {error}")))?
    {
        entries = entries
            .checked_add(1)
            .ok_or_else(|| CoreError::Message("investigation revision entry overflow".into()))?;
        if entries > MAX_INVESTIGATION_DIRECTORY_ENTRIES {
            return Err(CoreError::Message(format!(
                "investigation directory exceeds {MAX_INVESTIGATION_DIRECTORY_ENTRIES} entries"
            )));
        }
        let entry = entry.map_err(|error| {
            CoreError::Message(format!("read investigation revision entry: {error}"))
        })?;
        let file_type = entry.file_type().map_err(|error| {
            CoreError::Message(format!("inspect investigation revision entry: {error}"))
        })?;
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let Some(revision) = parse_revision_filename(&entry.path()) else {
            continue;
        };
        revision_files = revision_files
            .checked_add(1)
            .ok_or_else(|| CoreError::Message("investigation revision count overflow".into()))?;
        if revision_files > MAX_INVESTIGATION_REVISIONS as usize {
            return Err(CoreError::Message(format!(
                "investigation exceeds {MAX_INVESTIGATION_REVISIONS} revision files"
            )));
        }
        if latest
            .as_ref()
            .is_none_or(|(current, _)| revision > *current)
        {
            latest = Some((revision, entry.path()));
        }
    }
    latest.ok_or_else(|| {
        CoreError::Message(format!(
            "investigation at {} has no readable revision",
            directory.display()
        ))
    })
}

fn read_revision(
    path: &Path,
    expected_id: &str,
    expected_revision: u64,
) -> CoreResult<InvestigationDocument> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| CoreError::Message(format!("inspect investigation revision: {error}")))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(CoreError::Message(
            "investigation revision is not a regular file".into(),
        ));
    }
    if metadata.len() > MAX_INVESTIGATION_DOCUMENT_BYTES {
        return Err(CoreError::Message(format!(
            "investigation revision exceeds {MAX_INVESTIGATION_DOCUMENT_BYTES} bytes"
        )));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| CoreError::Message(format!("read investigation revision: {error}")))?;
    let document: InvestigationDocument = serde_json::from_slice(&bytes)
        .map_err(|error| CoreError::Message(format!("parse investigation revision: {error}")))?;
    validate_document(&document, Some(expected_id), Some(expected_revision))?;
    Ok(document)
}

fn publish_revision(directory: &Path, document: &InvestigationDocument) -> CoreResult<()> {
    validate_document(document, Some(&document.id), Some(document.revision))?;
    let bytes = serde_json::to_vec_pretty(document)?;
    if bytes.len() as u64 > MAX_INVESTIGATION_DOCUMENT_BYTES {
        return Err(CoreError::Message(format!(
            "investigation revision exceeds {MAX_INVESTIGATION_DOCUMENT_BYTES} bytes"
        )));
    }
    let reparsed: InvestigationDocument = serde_json::from_slice(&bytes)?;
    validate_document(&reparsed, Some(&document.id), Some(document.revision))?;
    if reparsed != *document {
        return Err(CoreError::Message(
            "investigation revision failed serialization validation".into(),
        ));
    }

    let target = directory.join(revision_filename(document.revision));
    let mut temporary = tempfile::Builder::new()
        .prefix(".investigation-revision-")
        .tempfile_in(directory)
        .map_err(|error| {
            CoreError::Message(format!("create investigation temporary file: {error}"))
        })?;
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| {
            CoreError::Message(format!("write investigation temporary file: {error}"))
        })?;

    let persisted = temporary.persist_noclobber(&target).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists || target.exists() {
            CoreError::Message(format!(
                "stale investigation revision: {} already exists",
                document.revision
            ))
        } else {
            CoreError::Message(format!(
                "publish investigation revision without overwrite: {}",
                error.error
            ))
        }
    })?;
    persisted
        .sync_all()
        .map_err(|error| CoreError::Message(format!("sync investigation revision: {error}")))?;
    sync_directory(directory)?;

    let published = read_revision(&target, &document.id, document.revision)?;
    if published != *document {
        return Err(CoreError::Message(
            "published investigation revision failed validation".into(),
        ));
    }
    Ok(())
}

fn sync_directory(_directory: &Path) -> CoreResult<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(_directory)
            .and_then(|file| file.sync_all())
            .map_err(|error| {
                CoreError::Message(format!("sync investigation directory: {error}"))
            })?;
    }
    Ok(())
}

fn stale_revision_error(
    investigation_id: &str,
    expected_revision: u64,
    actual_revision: u64,
) -> CoreError {
    CoreError::Message(format!(
        "stale investigation revision for {investigation_id}: expected {expected_revision}, current {actual_revision}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::{LogEvent, TimeQuality};

    const PAYLOAD_SENTINEL: &str = "INVESTIGATION_PAYLOAD_SENTINEL_MUST_NOT_PERSIST";

    fn evidence_corpus(cache: &tempfile::TempDir) -> LogCorpus {
        let corpus = LogCorpus::create(cache.path(), "investigation evidence").unwrap();
        corpus
            .push_events(&[
                LogEvent {
                    seq: 10,
                    ts: 1_700_000_010,
                    level: "error".into(),
                    service: Some("api".into()),
                    host: None,
                    template_id: 1,
                    params: vec!["sensitive parameter".into()],
                    trace_id: None,
                    message: PAYLOAD_SENTINEL.into(),
                    source: "api/app.log".into(),
                },
                LogEvent {
                    seq: 11,
                    ts: 1_700_000_011,
                    level: "info".into(),
                    service: Some("api".into()),
                    host: None,
                    template_id: 2,
                    params: vec![],
                    trace_id: None,
                    message: "intervening event".into(),
                    source: "api/app.log".into(),
                },
                LogEvent {
                    seq: 12,
                    ts: 1_700_000_012,
                    level: "warn".into(),
                    service: Some("worker".into()),
                    host: None,
                    template_id: 3,
                    params: vec![],
                    trace_id: None,
                    message: "selected noncontiguous event".into(),
                    source: "worker/worker.log".into(),
                },
            ])
            .unwrap();
        corpus.flush().unwrap();
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

    fn selected_refs(corpus: &LogCorpus) -> Vec<BookmarkEventRef> {
        vec![
            event_ref(corpus, 12, "worker/worker.log", 1_700_000_012),
            event_ref(corpus, 10, "api/app.log", 1_700_000_010),
        ]
    }

    #[test]
    fn investigation_noncontiguous_evidence_reopens_and_duplicate_is_idempotent() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let corpus_id = corpus.id().to_string();
        let store = InvestigationStore::new(durable.path().join("investigations"));
        let created = store.create("API incident", &corpus).unwrap();

        let added = store
            .add_exact_evidence(
                &created.id,
                created.revision,
                "Failure boundaries",
                &corpus,
                selected_refs(&corpus),
            )
            .unwrap();
        assert_eq!(added.document.revision, 2);
        assert_eq!(added.document.evidence.len(), 1);
        assert_eq!(
            added.document.evidence[0]
                .event_refs
                .iter()
                .map(|event_ref| event_ref.seq)
                .collect::<Vec<_>>(),
            vec![10, 12]
        );

        let duplicate = store
            .add_exact_evidence(
                &created.id,
                added.document.revision,
                "A different duplicate title",
                &corpus,
                selected_refs(&corpus),
            )
            .unwrap();
        assert_eq!(duplicate.document.revision, 2);
        assert_eq!(duplicate.document.evidence.len(), 1);

        drop(corpus);
        let reopened_corpus = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        let reopened_store = InvestigationStore::new(durable.path().join("investigations"));
        let reopened = reopened_store.load(&created.id, &reopened_corpus).unwrap();
        assert_eq!(reopened.document.revision, 2);
        assert_eq!(reopened.evidence[0].references.len(), 2);
        assert!(reopened.evidence[0]
            .references
            .iter()
            .all(|reference| reference.status == EvidenceReferenceStatus::Verified));
        assert_eq!(reopened_store.list().unwrap()[0].evidence_count, 1);
    }

    #[test]
    fn investigation_rejects_wrong_missing_and_stale_input_refs() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let other = LogCorpus::create(cache.path(), "other").unwrap();
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Input validation", &corpus).unwrap();

        let wrong = event_ref(&other, 10, "api/app.log", 1_700_000_010);
        assert!(store
            .add_exact_evidence(&document.id, 1, "Wrong corpus", &corpus, vec![wrong])
            .unwrap_err()
            .to_string()
            .contains("different corpus"));
        let missing = event_ref(&corpus, 999, "api/app.log", 1_700_000_010);
        assert!(store
            .add_exact_evidence(&document.id, 1, "Missing row", &corpus, vec![missing])
            .unwrap_err()
            .to_string()
            .contains("missing"));
        let stale = event_ref(&corpus, 10, "changed.log", 1_700_000_010);
        assert!(store
            .add_exact_evidence(&document.id, 1, "Stale row", &corpus, vec![stale])
            .unwrap_err()
            .to_string()
            .contains("no longer matches"));
        assert_eq!(
            store.load(&document.id, &corpus).unwrap().document.revision,
            1
        );
    }

    #[test]
    fn investigation_load_and_preview_report_stale_and_missing_refs() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Resolution honesty", &corpus).unwrap();
        let added = store
            .add_exact_evidence(
                &document.id,
                1,
                "Two events",
                &corpus,
                selected_refs(&corpus),
            )
            .unwrap();
        let evidence_id = added.document.evidence[0].id.clone();

        corpus
            .with_connection(|connection| {
                connection
                    .execute("UPDATE events SET source = 'moved.log' WHERE seq = 10", [])
                    .map_err(|error| CoreError::Message(format!("test update: {error}")))?;
                connection
                    .execute("DELETE FROM events WHERE seq = 12", [])
                    .map_err(|error| CoreError::Message(format!("test delete: {error}")))?;
                Ok(())
            })
            .unwrap();

        let loaded = store.load(&document.id, &corpus).unwrap();
        assert_eq!(loaded.evidence[0].references.len(), 2);
        assert_eq!(
            loaded.evidence[0].references[0].status,
            EvidenceReferenceStatus::Stale
        );
        assert!(loaded.evidence[0].references[0].event.is_some());
        assert_eq!(
            loaded.evidence[0].references[1].status,
            EvidenceReferenceStatus::Missing
        );
        assert!(loaded.evidence[0].references[1].event.is_none());

        let preview = store
            .preview_evidence(&document.id, &evidence_id, &corpus)
            .unwrap();
        assert_eq!(preview.references.len(), 2);
        assert_eq!(preview.references[0].status, EvidenceReferenceStatus::Stale);
        assert_eq!(
            preview.references[1].status,
            EvidenceReferenceStatus::Missing
        );
    }

    #[test]
    fn investigation_bounds_titles_items_and_references() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        assert!(store.create("x".repeat(257), &corpus).is_err());
        let created = store.create("Bounds", &corpus).unwrap();
        let too_many_refs =
            vec![event_ref(&corpus, 10, "api/app.log", 1_700_000_010); MAX_BOOKMARK_EVENT_REFS + 1];
        assert!(store
            .add_exact_evidence(
                &created.id,
                1,
                "Too many references",
                &corpus,
                too_many_refs,
            )
            .is_err());

        let mut too_many_items = created.clone();
        for _ in 0..=MAX_INVESTIGATION_EVIDENCE_ITEMS {
            too_many_items.evidence.push(EvidenceItem {
                id: Uuid::now_v7().to_string(),
                title: "bounded".into(),
                provenance: EvidenceProvenance::Human,
                corpus_id: corpus.id().to_string(),
                event_refs: vec![event_ref(&corpus, 10, "api/app.log", 1_700_000_010)],
                created_at: created.created_at,
                updated_at: created.updated_at,
            });
        }
        assert!(validate_document(&too_many_items, None, None)
            .unwrap_err()
            .to_string()
            .contains("evidence items"));

        let mut too_many_total_refs = created.clone();
        let mut next_seq = 1u64;
        while too_many_total_refs
            .evidence
            .iter()
            .map(|item| item.event_refs.len())
            .sum::<usize>()
            <= MAX_INVESTIGATION_TOTAL_EVENT_REFS
        {
            let remaining = MAX_INVESTIGATION_TOTAL_EVENT_REFS + 1
                - too_many_total_refs
                    .evidence
                    .iter()
                    .map(|item| item.event_refs.len())
                    .sum::<usize>();
            let count = remaining.min(MAX_BOOKMARK_EVENT_REFS);
            let refs = (0..count)
                .map(|_| {
                    let seq = next_seq;
                    next_seq += 1;
                    BookmarkEventRef {
                        corpus_id: corpus.id().to_string(),
                        seq,
                        source: "bounded.log".into(),
                        timestamp_hint: 1_700_000_000 + seq as i64,
                        time_quality_hint: TimeQuality::Wall,
                    }
                })
                .collect();
            too_many_total_refs.evidence.push(EvidenceItem {
                id: Uuid::now_v7().to_string(),
                title: "bounded refs".into(),
                provenance: EvidenceProvenance::Human,
                corpus_id: corpus.id().to_string(),
                event_refs: refs,
                created_at: created.created_at,
                updated_at: created.updated_at,
            });
        }
        assert!(validate_document(&too_many_total_refs, None, None)
            .unwrap_err()
            .to_string()
            .contains("exact event references"));

        for _ in 0..MAX_INVESTIGATION_DOCUMENTS {
            std::fs::create_dir(durable.path().join(Uuid::now_v7().to_string())).unwrap();
        }
        assert!(store.list().unwrap_err().to_string().contains("documents"));
    }

    #[test]
    fn investigation_stale_expected_revision_cannot_overwrite_winner() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let first = InvestigationStore::new(durable.path());
        let second = InvestigationStore::new(durable.path());
        let document = first.create("Optimistic writes", &corpus).unwrap();

        let winner = first
            .add_exact_evidence(
                &document.id,
                1,
                "Winner",
                &corpus,
                vec![event_ref(&corpus, 10, "api/app.log", 1_700_000_010)],
            )
            .unwrap();
        let loser = second
            .add_exact_evidence(
                &document.id,
                1,
                "Loser",
                &corpus,
                vec![event_ref(&corpus, 12, "worker/worker.log", 1_700_000_012)],
            )
            .unwrap_err();
        assert!(loser.to_string().contains("stale investigation revision"));
        let loaded = second.load(&document.id, &corpus).unwrap();
        assert_eq!(loaded.document.revision, winner.document.revision);
        assert_eq!(loaded.document.evidence[0].title, "Winner");
    }

    #[test]
    fn investigation_future_schema_fails_closed() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Future schema", &corpus).unwrap();
        let mut future = document.clone();
        future.schema_version = INVESTIGATION_SCHEMA_VERSION + 1;
        future.revision = 2;
        let path = durable.path().join(&document.id).join(revision_filename(2));
        std::fs::write(path, serde_json::to_vec_pretty(&future).unwrap()).unwrap();

        let error = store.load(&document.id, &corpus).unwrap_err();
        assert!(error.to_string().contains("schema version"));
        assert!(error.to_string().contains("unsupported"));
    }

    #[test]
    fn investigation_invalid_or_no_clobber_publication_preserves_prior_revision() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Publication safety", &corpus).unwrap();
        let directory = durable.path().join(&document.id);

        let no_clobber = publish_revision(&directory, &document).unwrap_err();
        assert!(no_clobber.to_string().contains("already exists"));
        assert_eq!(
            store.load(&document.id, &corpus).unwrap().document,
            document
        );

        let mut invalid = document.clone();
        invalid.revision = 2;
        invalid.schema_version = INVESTIGATION_SCHEMA_VERSION + 1;
        assert!(publish_revision(&directory, &invalid).is_err());
        assert!(!directory.join(revision_filename(2)).exists());
        assert_eq!(
            store.load(&document.id, &corpus).unwrap().document,
            document
        );
    }

    #[test]
    fn investigation_persistence_contains_no_event_payload_or_params() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Payload boundary", &corpus).unwrap();
        store
            .add_exact_evidence(
                &document.id,
                1,
                "Exact evidence",
                &corpus,
                vec![event_ref(&corpus, 10, "api/app.log", 1_700_000_010)],
            )
            .unwrap();

        let directory = durable.path().join(&document.id);
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if parse_revision_filename(&path).is_some() {
                let bytes = std::fs::read(path).unwrap();
                let text = String::from_utf8(bytes).unwrap();
                assert!(!text.contains(PAYLOAD_SENTINEL));
                assert!(!text.contains("sensitive parameter"));
                assert!(!text.contains("\"message\""));
                assert!(!text.contains("\"params\""));
            }
        }
    }

    #[test]
    fn investigation_titles_are_redacted_and_credential_dominant_values_rejected() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let secret = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz012345"].concat();
        let document = store
            .create(
                format!("Investigate token {secret} in deployment logs"),
                &corpus,
            )
            .unwrap();
        assert!(!document.title.contains(&secret));
        assert!(document.title.contains("sk-***"));
        assert!(store.create(secret.clone(), &corpus).is_err());

        let added = store
            .add_exact_evidence(
                &document.id,
                1,
                format!("Observed {secret} near an error boundary"),
                &corpus,
                vec![event_ref(&corpus, 10, "api/app.log", 1_700_000_010)],
            )
            .unwrap();
        assert!(!added.document.evidence[0].title.contains(&secret));
        assert!(added.document.evidence[0].title.contains("sk-***"));
    }
}
