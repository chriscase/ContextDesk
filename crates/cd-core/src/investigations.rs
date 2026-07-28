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
pub const INVESTIGATION_SCHEMA_VERSION: u32 = 3;
const MIN_INVESTIGATION_SCHEMA_VERSION: u32 = 1;
/// Maximum durable investigation documents under one store root.
pub const MAX_INVESTIGATION_DOCUMENTS: usize = 256;
/// Maximum append-only revisions retained for one investigation.
pub const MAX_INVESTIGATION_REVISIONS: u64 = 4_096;
/// Maximum evidence items in one investigation.
pub const MAX_INVESTIGATION_EVIDENCE_ITEMS: usize = 1_024;
/// Maximum findings in one investigation.
pub const MAX_INVESTIGATION_FINDINGS: usize = 1_024;
/// Maximum notes in one investigation.
pub const MAX_INVESTIGATION_NOTES: usize = 2_048;
/// Maximum exact references across one investigation.
pub const MAX_INVESTIGATION_TOTAL_EVENT_REFS: usize = 8_192;
/// Maximum UTF-8 bytes in an investigation or evidence title.
pub const MAX_INVESTIGATION_TITLE_BYTES: usize = 256;
/// Maximum UTF-8 bytes in a finding rationale.
pub const MAX_FINDING_WHY_IT_MATTERS_BYTES: usize = 4_096;
/// Maximum UTF-8 bytes in a note body.
pub const MAX_INVESTIGATION_NOTE_BODY_BYTES: usize = 16_384;
/// Maximum explicit evidence or finding citations on one item.
pub const MAX_INVESTIGATION_ITEM_CITATIONS: usize = 256;
/// Maximum corpus links represented by the versioned document model.
pub const MAX_INVESTIGATION_CORPUS_LINKS: usize = 16;

const MAX_CORPUS_ID_BYTES: usize = 128;
const MAX_SOURCE_IDENTITY_BYTES: usize = 1_024;
const MAX_FINDING_VIEW_LANES: usize = 4;
const MAX_FINDING_VIEW_FILTER_VALUES: usize = 256;
const MAX_FINDING_VIEW_LANE_ID_BYTES: usize = 128;
const MAX_FINDING_VIEW_LANE_LABEL_BYTES: usize = 256;
const MAX_FINDING_VIEW_VALUE_BYTES: usize = 1_024;
const MAX_FINDING_VIEW_FIND_QUERY_BYTES: usize = 4_096;
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

/// Human authorship provenance for durable investigation analysis.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HumanProvenance {
    /// A person explicitly authored and saved the item.
    Human,
}

/// Epistemic kind of a human-authored finding.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingKind {
    /// A directly observed fact supported by cited evidence.
    Observation,
    /// A reasoned conclusion drawn from cited evidence.
    Inference,
    /// A testable explanation that still requires confirmation.
    Hypothesis,
}

/// Human-controlled lifecycle of a durable finding.
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingLifecycle {
    /// The finding is accepted as part of the active investigation record.
    #[default]
    Accepted,
    /// The finding has been addressed or otherwise resolved.
    Resolved,
}

/// Structured filters captured in a durable finding view recipe.
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindingViewFilters {
    /// Exact log levels (OR); empty means any level.
    #[serde(default)]
    pub levels: Vec<String>,
    /// Relative source identities (OR); empty means any source.
    #[serde(default)]
    pub sources: Vec<String>,
    /// Service identities (OR); empty means any service.
    #[serde(default)]
    pub services: Vec<String>,
    /// Host identities (OR); empty means any host.
    #[serde(default)]
    pub hosts: Vec<String>,
    /// Inclusive timestamp/order lower bound.
    pub time_from: Option<i64>,
    /// Exclusive timestamp/order upper bound.
    pub time_to: Option<i64>,
    /// Inclusive stable event-sequence lower bound.
    pub seq_from: Option<u64>,
    /// Inclusive stable event-sequence upper bound.
    pub seq_to: Option<u64>,
    /// Optional exact template identifier.
    pub template_id: Option<u64>,
    /// Optional exact trace identifier.
    pub trace_id: Option<String>,
    /// Optional case-insensitive message keyword filter.
    pub keyword: Option<String>,
}

/// One durable lane definition in a finding view recipe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindingViewLane {
    /// Stable recipe-local lane identifier.
    pub id: String,
    /// Human-facing lane label.
    pub label: String,
    /// Relative source identities assigned to the lane.
    #[serde(default)]
    pub sources: Vec<String>,
}

/// Time-link behavior captured by a finding view recipe.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingViewTimeLinkMode {
    /// Lanes move independently.
    Independent,
    /// Other lanes follow the focused lane cursor.
    FollowCursor,
    /// Lanes align events at the same timestamp.
    AlignTime,
}

/// Find matching strategy captured by a finding view recipe.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FindingViewFindMatchMode {
    /// Treat the query as literal text.
    Literal,
    /// Treat the query as a regular expression.
    Regex,
}

/// Optional Find definition captured by a finding view recipe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindingViewFind {
    /// Bounded query text.
    pub query: String,
    /// Literal or regular-expression matching.
    pub match_mode: FindingViewFindMatchMode,
    /// Whether text matching is case-sensitive.
    pub case_sensitive: bool,
    /// Whether template-semantic expansion was requested.
    pub semantic: bool,
}

/// One lane's exact viewport anchor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindingViewViewportAnchor {
    /// Recipe-local lane identifier.
    pub lane_id: String,
    /// Exact payload-free event identity at the lane viewport.
    pub event_ref: BookmarkEventRef,
}

/// Durable, payload-free Explorer view state attached to a finding.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindingViewRecipe {
    /// Structured global filters.
    pub filters: FindingViewFilters,
    /// All configured lane definitions, including currently hidden lanes.
    pub lanes: Vec<FindingViewLane>,
    /// Number of lanes currently visible.
    pub visible_lane_count: usize,
    /// Current lane time-link behavior.
    #[serde(rename = "linkMode")]
    pub time_link_mode: FindingViewTimeLinkMode,
    /// Optional focused recipe-local lane identifier.
    pub focused_lane_id: Option<String>,
    /// Optional exact focused event identity.
    pub focused_event: Option<BookmarkEventRef>,
    /// Exact selected event identities.
    #[serde(default)]
    pub selection: Vec<BookmarkEventRef>,
    /// Exact resident Find-highlight identities.
    #[serde(default)]
    pub highlights: Vec<BookmarkEventRef>,
    /// Optional Find definition.
    pub find: Option<FindingViewFind>,
    /// At most one exact viewport anchor per configured lane.
    #[serde(default)]
    pub viewport_anchors: Vec<FindingViewViewportAnchor>,
}

/// Preview/apply-time resolution of a durable finding view recipe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindingViewRecipeResolution {
    /// Investigation that owns the finding.
    pub investigation_id: String,
    /// Revision from which the recipe was loaded.
    pub revision: u64,
    /// Finding that owns the recipe.
    pub finding_id: String,
    /// Original durable, payload-free recipe.
    #[serde(rename = "recipe")]
    pub view_recipe: FindingViewRecipe,
    /// Number of saved reference occurrences no longer present in the corpus.
    pub missing_count: usize,
    /// Number of saved reference occurrences whose identity hints are stale.
    pub stale_count: usize,
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

/// A durable human-authored finding with explicit evidence citations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindingItem {
    /// Stable UUIDv7 finding identifier.
    pub id: String,
    /// Epistemic kind selected by the author.
    pub kind: FindingKind,
    /// Human-controlled lifecycle state.
    #[serde(default)]
    pub lifecycle: FindingLifecycle,
    /// Human-facing, redacted title.
    pub title: String,
    /// Human-facing, redacted and bounded explanation of significance.
    pub why_it_matters: String,
    /// Explicit durable evidence identifiers supporting this finding.
    pub evidence_ids: Vec<String>,
    /// Optional durable Explorer view recipe for preview/apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_recipe: Option<FindingViewRecipe>,
    /// Explicit human-only authorship provenance.
    pub provenance: HumanProvenance,
    /// Creation time as Unix seconds.
    pub created_at: i64,
    /// Last update time as Unix seconds.
    pub updated_at: i64,
}

/// A durable human-authored note with explicit citations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteItem {
    /// Stable UUIDv7 note identifier.
    pub id: String,
    /// Human-facing, redacted title.
    pub title: String,
    /// Human-facing, redacted and bounded note body.
    pub body: String,
    /// Explicit durable evidence identifiers supporting this note.
    pub evidence_ids: Vec<String>,
    /// Optional durable finding identifiers discussed by this note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finding_ids: Option<Vec<String>>,
    /// Explicit human-only authorship provenance.
    pub provenance: HumanProvenance,
    /// Creation time as Unix seconds.
    pub created_at: i64,
    /// Last update time as Unix seconds.
    pub updated_at: i64,
}

/// Input for one atomic human finding mutation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddFindingInput {
    /// Epistemic kind selected by the author.
    pub kind: FindingKind,
    /// Human-facing title to redact and validate.
    pub title: String,
    /// Human-facing explanation to redact and validate.
    pub why_it_matters: String,
    /// Exact selected event identities to validate and cite.
    pub event_refs: Vec<BookmarkEventRef>,
    /// Optional full Explorer view recipe to validate and persist.
    #[serde(default)]
    pub view_recipe: Option<FindingViewRecipe>,
}

/// Input for one atomic human note mutation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AddNoteInput {
    /// Human-facing title to redact and validate.
    pub title: String,
    /// Human-facing body to redact and validate.
    pub body: String,
    /// Exact selected event identities to validate and cite.
    pub event_refs: Vec<BookmarkEventRef>,
    /// Existing findings to cite, or an empty vector for none.
    #[serde(default)]
    pub finding_ids: Vec<String>,
}

/// Replacement values for an expected-revision finding edit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditFindingInput {
    /// Existing UUIDv7 finding identifier.
    pub finding_id: String,
    /// Replacement epistemic kind.
    pub kind: FindingKind,
    /// Replacement lifecycle state.
    pub lifecycle: FindingLifecycle,
    /// Replacement human-facing title to redact and validate.
    pub title: String,
    /// Replacement human-facing explanation to redact and validate.
    pub why_it_matters: String,
}

/// Replacement values for an expected-revision note edit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditNoteInput {
    /// Existing UUIDv7 note identifier.
    pub note_id: String,
    /// Replacement human-facing title to redact and validate.
    pub title: String,
    /// Replacement human-facing body to redact and validate.
    pub body: String,
    /// Replacement existing evidence citations.
    pub evidence_ids: Vec<String>,
    /// Replacement existing finding citations, or an empty vector for none.
    #[serde(default)]
    pub finding_ids: Vec<String>,
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
    /// Durable human-authored findings.
    ///
    /// This additive field defaults empty so existing schema-version-1
    /// revisions remain readable.
    #[serde(default)]
    pub findings: Vec<FindingItem>,
    /// Durable human-authored notes.
    ///
    /// This additive field defaults empty so existing schema-version-1
    /// revisions remain readable.
    #[serde(default)]
    pub notes: Vec<NoteItem>,
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
    /// Number of saved findings.
    pub finding_count: usize,
    /// Number of saved notes.
    pub note_count: usize,
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
            finding_count: document.findings.len(),
            note_count: document.notes.len(),
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
                        findings: Vec::new(),
                        notes: Vec::new(),
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
        document.schema_version = INVESTIGATION_SCHEMA_VERSION;
        document.updated_at = now;

        let directory = self.investigation_directory(investigation_id)?;
        publish_revision(&directory, &document)?;
        resolve_document(document, corpus)
    }

    /// Atomically save exact selected evidence and a human-authored finding.
    ///
    /// The selected references are canonicalized against `corpus`. An existing
    /// evidence item for the exact canonical set is reused; otherwise a
    /// payload-free evidence item is created in the same append-only revision
    /// as the finding. A rapid retry of the same semantic mutation is
    /// idempotent, including when its original expected revision just lost a
    /// publication race to the identical mutation.
    pub fn add_human_finding(
        &self,
        investigation_id: &str,
        expected_revision: u64,
        corpus: &LogCorpus,
        input: AddFindingInput,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        let title = sanitize_title("finding title", input.title)?;
        let why_it_matters = sanitize_body(
            "finding why it matters",
            input.why_it_matters,
            MAX_FINDING_WHY_IT_MATTERS_BYTES,
        )?;
        let kind = input.kind;
        let mut document = self.load_document(investigation_id)?;
        ensure_active_single_corpus(&document, corpus)?;
        let event_refs = canonicalize_exact_event_refs(corpus, input.event_refs)?;
        let view_recipe = input
            .view_recipe
            .map(|recipe| canonicalize_finding_view_recipe(recipe, corpus))
            .transpose()?;

        if finding_for_exact_set(
            &document,
            corpus.id(),
            &event_refs,
            kind,
            &title,
            &why_it_matters,
            view_recipe.as_ref(),
        )
        .is_some()
        {
            return resolve_document(document, corpus);
        }
        if document.revision != expected_revision {
            return Err(stale_revision_error(
                investigation_id,
                expected_revision,
                document.revision,
            ));
        }
        if document.findings.len() >= MAX_INVESTIGATION_FINDINGS {
            return Err(CoreError::Message(format!(
                "investigation exceeds {MAX_INVESTIGATION_FINDINGS} findings"
            )));
        }

        let evidence_id =
            reuse_or_append_exact_evidence(&mut document, &title, corpus.id(), event_refs.clone())?;
        let now = crate::embed::now_unix_secs();
        document.findings.push(FindingItem {
            id: Uuid::now_v7().to_string(),
            kind,
            lifecycle: FindingLifecycle::Accepted,
            title: title.clone(),
            why_it_matters: why_it_matters.clone(),
            evidence_ids: vec![evidence_id],
            view_recipe: view_recipe.clone(),
            provenance: HumanProvenance::Human,
            created_at: now,
            updated_at: now,
        });
        advance_revision(&mut document, now)?;

        let directory = self.investigation_directory(investigation_id)?;
        match publish_revision(&directory, &document) {
            Ok(()) => resolve_document(document, corpus),
            Err(publication_error) => {
                let latest = self.load_document(investigation_id)?;
                if finding_for_exact_set(
                    &latest,
                    corpus.id(),
                    &event_refs,
                    kind,
                    &title,
                    &why_it_matters,
                    view_recipe.as_ref(),
                )
                .is_some()
                {
                    resolve_document(latest, corpus)
                } else {
                    Err(publication_error)
                }
            }
        }
    }

    /// Atomically save exact selected evidence and a human-authored note.
    ///
    /// Every supplied finding identifier must already exist in this
    /// investigation. Empty `finding_ids` are stored as no finding citations.
    /// Evidence reuse, append-only publication, and rapid-retry idempotence
    /// follow the same contract as [`Self::add_human_finding`].
    pub fn add_human_note(
        &self,
        investigation_id: &str,
        expected_revision: u64,
        corpus: &LogCorpus,
        input: AddNoteInput,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        let title = sanitize_title("note title", input.title)?;
        let body = sanitize_body("note body", input.body, MAX_INVESTIGATION_NOTE_BODY_BYTES)?;
        let mut document = self.load_document(investigation_id)?;
        ensure_active_single_corpus(&document, corpus)?;
        let event_refs = canonicalize_exact_event_refs(corpus, input.event_refs)?;
        let finding_ids = validate_requested_finding_ids(&document, input.finding_ids)?;

        if note_for_exact_set(
            &document,
            corpus.id(),
            &event_refs,
            &title,
            &body,
            finding_ids.as_deref(),
        )
        .is_some()
        {
            return resolve_document(document, corpus);
        }
        if document.revision != expected_revision {
            return Err(stale_revision_error(
                investigation_id,
                expected_revision,
                document.revision,
            ));
        }
        if document.notes.len() >= MAX_INVESTIGATION_NOTES {
            return Err(CoreError::Message(format!(
                "investigation exceeds {MAX_INVESTIGATION_NOTES} notes"
            )));
        }

        let evidence_id =
            reuse_or_append_exact_evidence(&mut document, &title, corpus.id(), event_refs.clone())?;
        let now = crate::embed::now_unix_secs();
        document.notes.push(NoteItem {
            id: Uuid::now_v7().to_string(),
            title: title.clone(),
            body: body.clone(),
            evidence_ids: vec![evidence_id],
            finding_ids: finding_ids.clone(),
            provenance: HumanProvenance::Human,
            created_at: now,
            updated_at: now,
        });
        advance_revision(&mut document, now)?;

        let directory = self.investigation_directory(investigation_id)?;
        match publish_revision(&directory, &document) {
            Ok(()) => resolve_document(document, corpus),
            Err(publication_error) => {
                let latest = self.load_document(investigation_id)?;
                if note_for_exact_set(
                    &latest,
                    corpus.id(),
                    &event_refs,
                    &title,
                    &body,
                    finding_ids.as_deref(),
                )
                .is_some()
                {
                    resolve_document(latest, corpus)
                } else {
                    Err(publication_error)
                }
            }
        }
    }

    /// Replace editable fields on one human finding in a new revision.
    ///
    /// Evidence citations and authorship provenance remain immutable. Supplying
    /// values already present is idempotent and does not publish a revision.
    pub fn edit_human_finding(
        &self,
        investigation_id: &str,
        expected_revision: u64,
        corpus: &LogCorpus,
        input: EditFindingInput,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        validate_uuid_v7("finding id", &input.finding_id)?;
        let title = sanitize_title("finding title", input.title)?;
        let why_it_matters = sanitize_body(
            "finding why it matters",
            input.why_it_matters,
            MAX_FINDING_WHY_IT_MATTERS_BYTES,
        )?;
        let mut document = self.load_document(investigation_id)?;
        ensure_active_single_corpus(&document, corpus)?;
        let existing = document
            .findings
            .iter()
            .find(|finding| finding.id == input.finding_id)
            .ok_or_else(|| {
                CoreError::Message(format!(
                    "finding {} not found in investigation {investigation_id}",
                    input.finding_id
                ))
            })?;
        if existing.kind == input.kind
            && existing.lifecycle == input.lifecycle
            && existing.title == title
            && existing.why_it_matters == why_it_matters
        {
            return resolve_document(document, corpus);
        }
        if document.revision != expected_revision {
            return Err(stale_revision_error(
                investigation_id,
                expected_revision,
                document.revision,
            ));
        }

        let now = crate::embed::now_unix_secs();
        let finding = document
            .findings
            .iter_mut()
            .find(|finding| finding.id == input.finding_id)
            .expect("finding existence was checked");
        finding.kind = input.kind;
        finding.lifecycle = input.lifecycle;
        finding.title = title;
        finding.why_it_matters = why_it_matters;
        finding.updated_at = now;
        advance_revision(&mut document, now)?;

        let directory = self.investigation_directory(investigation_id)?;
        match publish_revision(&directory, &document) {
            Ok(()) => resolve_document(document, corpus),
            Err(publication_error) => {
                let latest = self.load_document(investigation_id)?;
                let edited = document
                    .findings
                    .iter()
                    .find(|finding| finding.id == input.finding_id)
                    .expect("edited finding remains present");
                let matches_retry = latest.findings.iter().any(|finding| {
                    finding.id == input.finding_id
                        && finding.kind == input.kind
                        && finding.lifecycle == input.lifecycle
                        && finding.title == edited.title
                        && finding.why_it_matters == edited.why_it_matters
                });
                if matches_retry {
                    resolve_document(latest, corpus)
                } else {
                    Err(publication_error)
                }
            }
        }
    }

    /// Replace editable fields and citations on one human note in a new revision.
    ///
    /// Authorship provenance remains immutable. Every replacement citation must
    /// already exist in the same investigation. Supplying values already
    /// present is idempotent and does not publish a revision.
    pub fn edit_human_note(
        &self,
        investigation_id: &str,
        expected_revision: u64,
        corpus: &LogCorpus,
        input: EditNoteInput,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        validate_uuid_v7("note id", &input.note_id)?;
        let title = sanitize_title("note title", input.title)?;
        let body = sanitize_body("note body", input.body, MAX_INVESTIGATION_NOTE_BODY_BYTES)?;
        let mut document = self.load_document(investigation_id)?;
        ensure_active_single_corpus(&document, corpus)?;
        let evidence_ids = validate_requested_evidence_ids(&document, input.evidence_ids)?;
        let finding_ids = validate_requested_finding_ids(&document, input.finding_ids)?;
        let existing = document
            .notes
            .iter()
            .find(|note| note.id == input.note_id)
            .ok_or_else(|| {
                CoreError::Message(format!(
                    "note {} not found in investigation {investigation_id}",
                    input.note_id
                ))
            })?;
        if existing.title == title
            && existing.body == body
            && existing.evidence_ids == evidence_ids
            && existing.finding_ids == finding_ids
        {
            return resolve_document(document, corpus);
        }
        if document.revision != expected_revision {
            return Err(stale_revision_error(
                investigation_id,
                expected_revision,
                document.revision,
            ));
        }

        let now = crate::embed::now_unix_secs();
        let note = document
            .notes
            .iter_mut()
            .find(|note| note.id == input.note_id)
            .expect("note existence was checked");
        note.title = title;
        note.body = body;
        note.evidence_ids = evidence_ids;
        note.finding_ids = finding_ids;
        note.updated_at = now;
        advance_revision(&mut document, now)?;

        let directory = self.investigation_directory(investigation_id)?;
        match publish_revision(&directory, &document) {
            Ok(()) => resolve_document(document, corpus),
            Err(publication_error) => {
                let latest = self.load_document(investigation_id)?;
                let edited = document
                    .notes
                    .iter()
                    .find(|note| note.id == input.note_id)
                    .expect("edited note remains present");
                let matches_retry = latest.notes.iter().any(|note| {
                    note.id == input.note_id
                        && note.title == edited.title
                        && note.body == edited.body
                        && note.evidence_ids == edited.evidence_ids
                        && note.finding_ids == edited.finding_ids
                });
                if matches_retry {
                    resolve_document(latest, corpus)
                } else {
                    Err(publication_error)
                }
            }
        }
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

    /// Revalidate a finding's durable view recipe without resolving event payloads.
    ///
    /// Missing and stale reference occurrences are counted honestly while the
    /// original recipe remains unchanged for a caller-controlled preview/apply
    /// decision. Findings without a saved recipe fail closed.
    pub fn resolve_finding_view_recipe(
        &self,
        investigation_id: &str,
        finding_id: &str,
        corpus: &LogCorpus,
    ) -> CoreResult<FindingViewRecipeResolution> {
        validate_uuid_v7("finding id", finding_id)?;
        let document = self.load_document(investigation_id)?;
        ensure_corpus_link(&document, corpus.id())?;
        let finding = document
            .findings
            .iter()
            .find(|finding| finding.id == finding_id)
            .ok_or_else(|| {
                CoreError::Message(format!(
                    "finding {finding_id} not found in investigation {investigation_id}"
                ))
            })?;
        let recipe = finding.view_recipe.clone().ok_or_else(|| {
            CoreError::Message(format!("finding {finding_id} has no saved view recipe"))
        })?;
        let references = finding_view_recipe_references(&recipe);
        let seqs = references
            .iter()
            .map(|event_ref| event_ref.seq)
            .collect::<Vec<_>>();
        let actual_by_seq = fetch_events_by_seqs(corpus, &seqs)?
            .into_iter()
            .map(|event| (event.seq, event))
            .collect::<HashMap<_, _>>();
        let mut missing_count = 0usize;
        let mut stale_count = 0usize;
        for event_ref in references {
            match exact_reference_status(event_ref, corpus.id(), &actual_by_seq) {
                EvidenceReferenceStatus::Missing => missing_count += 1,
                EvidenceReferenceStatus::Stale => stale_count += 1,
                EvidenceReferenceStatus::Verified => {}
            }
        }
        Ok(FindingViewRecipeResolution {
            investigation_id: document.id,
            revision: document.revision,
            finding_id: finding_id.to_string(),
            view_recipe: recipe,
            missing_count,
            stale_count,
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

fn sanitize_body(kind: &str, body: String, max_bytes: usize) -> CoreResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err(CoreError::Message(format!("{kind} must not be empty")));
    }
    if body.len() > max_bytes {
        return Err(CoreError::Message(format!(
            "{kind} exceeds {max_bytes} UTF-8 bytes"
        )));
    }
    if body
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(CoreError::Message(format!(
            "{kind} contains unsupported control characters"
        )));
    }
    let redaction = redact_candidate(body);
    if redaction.blocked {
        return Err(CoreError::Message(
            redaction
                .block_reason
                .unwrap_or_else(|| format!("{kind} appears credential-dominant")),
        ));
    }
    let redacted = redaction.text.trim().to_string();
    if redacted.is_empty() || redacted.len() > max_bytes {
        return Err(CoreError::Message(format!(
            "{kind} is empty or exceeds {max_bytes} UTF-8 bytes after redaction"
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

fn validate_stored_body(kind: &str, body: &str, max_bytes: usize) -> CoreResult<()> {
    let sanitized = sanitize_body(kind, body.to_string(), max_bytes)?;
    if sanitized != body {
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
    let bytes = source.as_bytes();
    let windows_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\');
    let portable_traversal = source.split(['/', '\\']).any(|component| component == "..");
    let path = Path::new(source);
    if path.is_absolute()
        || source.starts_with('/')
        || source.starts_with('\\')
        || windows_absolute
        || portable_traversal
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

fn sanitize_finding_view_string(kind: &str, value: String, max_bytes: usize) -> CoreResult<String> {
    let redaction = redact_candidate(&value);
    if redaction.blocked {
        return Err(CoreError::Message(
            redaction
                .block_reason
                .unwrap_or_else(|| format!("{kind} appears credential-dominant")),
        ));
    }
    let sanitized = redaction.text.trim().to_string();
    if sanitized.is_empty()
        || sanitized.len() > max_bytes
        || sanitized.chars().any(char::is_control)
    {
        return Err(CoreError::Message(format!(
            "{kind} must contain 1..={max_bytes} safe UTF-8 bytes after redaction"
        )));
    }
    Ok(sanitized)
}

fn canonicalize_finding_view_values(
    kind: &str,
    values: Vec<String>,
    source_identities: bool,
) -> CoreResult<Vec<String>> {
    if values.len() > MAX_FINDING_VIEW_FILTER_VALUES {
        return Err(CoreError::Message(format!(
            "{kind} exceeds {MAX_FINDING_VIEW_FILTER_VALUES} values"
        )));
    }
    let mut canonical = Vec::with_capacity(values.len());
    for value in values {
        if source_identities {
            validate_source_identity(&value)?;
        }
        let value = sanitize_finding_view_string(kind, value, MAX_FINDING_VIEW_VALUE_BYTES)?;
        if source_identities {
            validate_source_identity(&value)?;
        }
        canonical.push(value);
    }
    canonical.sort();
    canonical.dedup();
    Ok(canonical)
}

fn canonicalize_optional_finding_view_string(
    kind: &str,
    value: Option<String>,
    max_bytes: usize,
) -> CoreResult<Option<String>> {
    value
        .map(|value| sanitize_finding_view_string(kind, value, max_bytes))
        .transpose()
}

fn canonicalize_finding_view_refs(
    refs: Vec<BookmarkEventRef>,
    corpus: &LogCorpus,
    kind: &str,
) -> CoreResult<Vec<BookmarkEventRef>> {
    if refs.len() > MAX_BOOKMARK_EVENT_REFS {
        return Err(CoreError::Message(format!(
            "{kind} exceeds {MAX_BOOKMARK_EVENT_REFS} exact event references"
        )));
    }
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    canonicalize_exact_event_refs(corpus, refs)
}

fn canonicalize_optional_finding_view_ref(
    event_ref: Option<BookmarkEventRef>,
    corpus: &LogCorpus,
) -> CoreResult<Option<BookmarkEventRef>> {
    event_ref
        .map(|event_ref| {
            canonicalize_exact_event_refs(corpus, vec![event_ref]).map(|mut refs| refs.remove(0))
        })
        .transpose()
}

fn canonicalize_finding_view_recipe(
    mut recipe: FindingViewRecipe,
    corpus: &LogCorpus,
) -> CoreResult<FindingViewRecipe> {
    recipe.filters.levels =
        canonicalize_finding_view_values("finding view levels", recipe.filters.levels, false)?;
    recipe.filters.sources =
        canonicalize_finding_view_values("finding view sources", recipe.filters.sources, true)?;
    recipe.filters.services =
        canonicalize_finding_view_values("finding view services", recipe.filters.services, false)?;
    recipe.filters.hosts =
        canonicalize_finding_view_values("finding view hosts", recipe.filters.hosts, false)?;
    recipe.filters.trace_id = canonicalize_optional_finding_view_string(
        "finding view trace id",
        recipe.filters.trace_id,
        MAX_FINDING_VIEW_VALUE_BYTES,
    )?;
    recipe.filters.keyword = canonicalize_optional_finding_view_string(
        "finding view keyword",
        recipe.filters.keyword,
        MAX_FINDING_VIEW_VALUE_BYTES,
    )?;
    if recipe
        .filters
        .time_from
        .zip(recipe.filters.time_to)
        .is_some_and(|(from, to)| from >= to)
    {
        return Err(CoreError::Message(
            "finding view timeFrom must precede timeTo".into(),
        ));
    }
    if recipe
        .filters
        .seq_from
        .zip(recipe.filters.seq_to)
        .is_some_and(|(from, to)| from > to)
    {
        return Err(CoreError::Message(
            "finding view seqFrom must not exceed seqTo".into(),
        ));
    }
    if recipe.lanes.is_empty() || recipe.lanes.len() > MAX_FINDING_VIEW_LANES {
        return Err(CoreError::Message(format!(
            "finding view must contain 1..={MAX_FINDING_VIEW_LANES} lanes"
        )));
    }
    let mut lane_ids = HashSet::new();
    for lane in &mut recipe.lanes {
        lane.id = sanitize_finding_view_string(
            "finding view lane id",
            std::mem::take(&mut lane.id),
            MAX_FINDING_VIEW_LANE_ID_BYTES,
        )?;
        if !lane_ids.insert(lane.id.clone()) {
            return Err(CoreError::Message(format!(
                "finding view repeats lane id {}",
                lane.id
            )));
        }
        lane.label = sanitize_finding_view_string(
            "finding view lane label",
            std::mem::take(&mut lane.label),
            MAX_FINDING_VIEW_LANE_LABEL_BYTES,
        )?;
        lane.sources = canonicalize_finding_view_values(
            "finding view lane sources",
            std::mem::take(&mut lane.sources),
            true,
        )?;
    }
    if recipe.visible_lane_count == 0 || recipe.visible_lane_count > recipe.lanes.len() {
        return Err(CoreError::Message(format!(
            "finding view visibleLaneCount must be within 1..={}",
            recipe.lanes.len()
        )));
    }
    recipe.focused_lane_id = canonicalize_optional_finding_view_string(
        "finding view focused lane id",
        recipe.focused_lane_id,
        MAX_FINDING_VIEW_LANE_ID_BYTES,
    )?;
    if recipe
        .focused_lane_id
        .as_ref()
        .is_some_and(|lane_id| !lane_ids.contains(lane_id))
    {
        return Err(CoreError::Message(
            "finding view focused lane does not exist".into(),
        ));
    }
    recipe.focused_event = canonicalize_optional_finding_view_ref(recipe.focused_event, corpus)?;
    recipe.selection =
        canonicalize_finding_view_refs(recipe.selection, corpus, "finding view selection")?;
    recipe.highlights =
        canonicalize_finding_view_refs(recipe.highlights, corpus, "finding view highlights")?;
    if let Some(find) = &mut recipe.find {
        find.query = sanitize_finding_view_string(
            "finding view Find query",
            std::mem::take(&mut find.query),
            MAX_FINDING_VIEW_FIND_QUERY_BYTES,
        )?;
    }
    if recipe.viewport_anchors.len() > recipe.lanes.len() {
        return Err(CoreError::Message(
            "finding view has more viewport anchors than lanes".into(),
        ));
    }
    let lane_order = recipe
        .lanes
        .iter()
        .enumerate()
        .map(|(index, lane)| (lane.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut anchor_lanes = HashSet::new();
    for anchor in &mut recipe.viewport_anchors {
        anchor.lane_id = sanitize_finding_view_string(
            "finding view anchor lane id",
            std::mem::take(&mut anchor.lane_id),
            MAX_FINDING_VIEW_LANE_ID_BYTES,
        )?;
        if !lane_ids.contains(&anchor.lane_id) {
            return Err(CoreError::Message(
                "finding view viewport anchor lane does not exist".into(),
            ));
        }
        if !anchor_lanes.insert(anchor.lane_id.clone()) {
            return Err(CoreError::Message(format!(
                "finding view repeats viewport anchor for lane {}",
                anchor.lane_id
            )));
        }
        anchor.event_ref =
            canonicalize_exact_event_refs(corpus, vec![anchor.event_ref.clone()])?.remove(0);
    }
    recipe
        .viewport_anchors
        .sort_by_key(|anchor| lane_order[&anchor.lane_id]);
    Ok(recipe)
}

fn finding_view_recipe_references(recipe: &FindingViewRecipe) -> Vec<&BookmarkEventRef> {
    recipe
        .focused_event
        .iter()
        .chain(recipe.selection.iter())
        .chain(recipe.highlights.iter())
        .chain(
            recipe
                .viewport_anchors
                .iter()
                .map(|anchor| &anchor.event_ref),
        )
        .collect()
}

fn validate_stored_finding_view_recipe(
    recipe: &FindingViewRecipe,
    linked_corpora: &HashSet<&str>,
) -> CoreResult<()> {
    if recipe.lanes.is_empty() || recipe.lanes.len() > MAX_FINDING_VIEW_LANES {
        return Err(CoreError::Message(format!(
            "finding view must contain 1..={MAX_FINDING_VIEW_LANES} lanes"
        )));
    }
    if recipe.visible_lane_count == 0 || recipe.visible_lane_count > recipe.lanes.len() {
        return Err(CoreError::Message(
            "finding view visibleLaneCount is invalid".into(),
        ));
    }
    if recipe.selection.len() > MAX_BOOKMARK_EVENT_REFS
        || recipe.highlights.len() > MAX_BOOKMARK_EVENT_REFS
    {
        return Err(CoreError::Message(format!(
            "finding view selection/highlights exceed {MAX_BOOKMARK_EVENT_REFS} references"
        )));
    }
    let mut lane_ids = HashSet::new();
    for lane in &recipe.lanes {
        validate_stored_finding_view_string(
            "finding view lane id",
            &lane.id,
            MAX_FINDING_VIEW_LANE_ID_BYTES,
        )?;
        validate_stored_finding_view_string(
            "finding view lane label",
            &lane.label,
            MAX_FINDING_VIEW_LANE_LABEL_BYTES,
        )?;
        if !lane_ids.insert(lane.id.as_str()) {
            return Err(CoreError::Message(format!(
                "finding view repeats lane id {}",
                lane.id
            )));
        }
        validate_stored_finding_view_values("finding view lane sources", &lane.sources, true)?;
    }
    validate_stored_finding_view_values("finding view levels", &recipe.filters.levels, false)?;
    validate_stored_finding_view_values("finding view sources", &recipe.filters.sources, true)?;
    validate_stored_finding_view_values("finding view services", &recipe.filters.services, false)?;
    validate_stored_finding_view_values("finding view hosts", &recipe.filters.hosts, false)?;
    if let Some(trace_id) = recipe.filters.trace_id.as_deref() {
        validate_stored_finding_view_string(
            "finding view trace id",
            trace_id,
            MAX_FINDING_VIEW_VALUE_BYTES,
        )?;
    }
    if let Some(keyword) = recipe.filters.keyword.as_deref() {
        validate_stored_finding_view_string(
            "finding view keyword",
            keyword,
            MAX_FINDING_VIEW_VALUE_BYTES,
        )?;
    }
    if recipe
        .filters
        .time_from
        .zip(recipe.filters.time_to)
        .is_some_and(|(from, to)| from >= to)
        || recipe
            .filters
            .seq_from
            .zip(recipe.filters.seq_to)
            .is_some_and(|(from, to)| from > to)
    {
        return Err(CoreError::Message(
            "finding view filter bounds are invalid".into(),
        ));
    }
    if recipe
        .focused_lane_id
        .as_deref()
        .is_some_and(|lane_id| !lane_ids.contains(lane_id))
    {
        return Err(CoreError::Message(
            "finding view focused lane does not exist".into(),
        ));
    }
    if let Some(focused_lane_id) = recipe.focused_lane_id.as_deref() {
        validate_stored_finding_view_string(
            "finding view focused lane id",
            focused_lane_id,
            MAX_FINDING_VIEW_LANE_ID_BYTES,
        )?;
    }
    if let Some(find) = &recipe.find {
        validate_stored_finding_view_string(
            "finding view Find query",
            &find.query,
            MAX_FINDING_VIEW_FIND_QUERY_BYTES,
        )?;
    }
    if recipe.viewport_anchors.len() > recipe.lanes.len() {
        return Err(CoreError::Message(
            "finding view has more viewport anchors than lanes".into(),
        ));
    }
    let mut anchor_lanes = HashSet::new();
    let lane_order = recipe
        .lanes
        .iter()
        .enumerate()
        .map(|(index, lane)| (lane.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut previous_anchor_index = None;
    for anchor in &recipe.viewport_anchors {
        if !lane_ids.contains(anchor.lane_id.as_str()) {
            return Err(CoreError::Message(
                "finding view viewport anchor lane does not exist".into(),
            ));
        }
        if !anchor_lanes.insert(anchor.lane_id.as_str()) {
            return Err(CoreError::Message(format!(
                "finding view repeats viewport anchor for lane {}",
                anchor.lane_id
            )));
        }
        let anchor_index = lane_order[anchor.lane_id.as_str()];
        if previous_anchor_index.is_some_and(|previous| previous >= anchor_index) {
            return Err(CoreError::Message(
                "finding view viewport anchors are not in lane order".into(),
            ));
        }
        previous_anchor_index = Some(anchor_index);
    }
    for refs in [&recipe.selection, &recipe.highlights] {
        let mut previous_seq = None;
        for event_ref in refs {
            if previous_seq.is_some_and(|previous| previous >= event_ref.seq) {
                return Err(CoreError::Message(
                    "finding view exact reference list is not canonical".into(),
                ));
            }
            previous_seq = Some(event_ref.seq);
        }
    }
    for event_ref in finding_view_recipe_references(recipe) {
        if !linked_corpora.contains(event_ref.corpus_id.as_str()) {
            return Err(CoreError::Message(
                "finding view reference belongs to an unlinked corpus".into(),
            ));
        }
        validate_source_identity(&event_ref.source)?;
    }
    Ok(())
}

fn validate_stored_finding_view_string(
    kind: &str,
    value: &str,
    max_bytes: usize,
) -> CoreResult<()> {
    let canonical = sanitize_finding_view_string(kind, value.to_string(), max_bytes)?;
    if canonical != value {
        return Err(CoreError::Message(format!(
            "{kind} is not in canonical redacted form"
        )));
    }
    Ok(())
}

fn validate_stored_finding_view_values(
    kind: &str,
    values: &[String],
    source_identities: bool,
) -> CoreResult<()> {
    if values.len() > MAX_FINDING_VIEW_FILTER_VALUES {
        return Err(CoreError::Message(format!(
            "{kind} exceeds {MAX_FINDING_VIEW_FILTER_VALUES} values"
        )));
    }
    let mut previous = None;
    for value in values {
        if source_identities {
            validate_source_identity(value)?;
        }
        validate_stored_finding_view_string(kind, value, MAX_FINDING_VIEW_VALUE_BYTES)?;
        if previous.is_some_and(|previous: &str| previous >= value.as_str()) {
            return Err(CoreError::Message(format!(
                "{kind} is not canonical and strictly ordered"
            )));
        }
        previous = Some(value.as_str());
    }
    Ok(())
}

fn ensure_active_single_corpus(
    document: &InvestigationDocument,
    corpus: &LogCorpus,
) -> CoreResult<()> {
    if document.status != InvestigationStatus::Active {
        return Err(CoreError::Message(format!(
            "investigation {} is archived",
            document.id
        )));
    }
    ensure_corpus_link(document, corpus.id())?;
    if document
        .evidence
        .iter()
        .any(|item| item.corpus_id != corpus.id())
    {
        return Err(CoreError::Message(
            "investigation mutation requires one authoritative corpus".into(),
        ));
    }
    Ok(())
}

fn exact_evidence_for_set<'a>(
    document: &'a InvestigationDocument,
    corpus_id: &str,
    event_refs: &[BookmarkEventRef],
) -> Option<&'a EvidenceItem> {
    document.evidence.iter().find(|item| {
        item.corpus_id == corpus_id && exact_event_sets_equal(&item.event_refs, event_refs)
    })
}

fn finding_for_exact_set<'a>(
    document: &'a InvestigationDocument,
    corpus_id: &str,
    event_refs: &[BookmarkEventRef],
    kind: FindingKind,
    title: &str,
    why_it_matters: &str,
    view_recipe: Option<&FindingViewRecipe>,
) -> Option<&'a FindingItem> {
    let evidence_id = exact_evidence_for_set(document, corpus_id, event_refs)?
        .id
        .as_str();
    document.findings.iter().find(|finding| {
        finding.kind == kind
            && finding.title == title
            && finding.why_it_matters == why_it_matters
            && finding.evidence_ids.as_slice() == [evidence_id]
            && finding.view_recipe.as_ref() == view_recipe
    })
}

fn note_for_exact_set<'a>(
    document: &'a InvestigationDocument,
    corpus_id: &str,
    event_refs: &[BookmarkEventRef],
    title: &str,
    body: &str,
    finding_ids: Option<&[String]>,
) -> Option<&'a NoteItem> {
    let evidence_id = exact_evidence_for_set(document, corpus_id, event_refs)?
        .id
        .as_str();
    document.notes.iter().find(|note| {
        note.title == title
            && note.body == body
            && note.evidence_ids.as_slice() == [evidence_id]
            && note.finding_ids.as_deref() == finding_ids
    })
}

fn reuse_or_append_exact_evidence(
    document: &mut InvestigationDocument,
    title: &str,
    corpus_id: &str,
    event_refs: Vec<BookmarkEventRef>,
) -> CoreResult<String> {
    if let Some(existing) = exact_evidence_for_set(document, corpus_id, &event_refs) {
        return Ok(existing.id.clone());
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

    let id = Uuid::now_v7().to_string();
    let now = crate::embed::now_unix_secs();
    document.evidence.push(EvidenceItem {
        id: id.clone(),
        title: title.to_string(),
        provenance: EvidenceProvenance::Human,
        corpus_id: corpus_id.to_string(),
        event_refs,
        created_at: now,
        updated_at: now,
    });
    Ok(id)
}

fn validate_requested_finding_ids(
    document: &InvestigationDocument,
    finding_ids: Vec<String>,
) -> CoreResult<Option<Vec<String>>> {
    if finding_ids.len() > MAX_INVESTIGATION_ITEM_CITATIONS {
        return Err(CoreError::Message(format!(
            "note exceeds {MAX_INVESTIGATION_ITEM_CITATIONS} finding citations"
        )));
    }
    let available = document
        .findings
        .iter()
        .map(|finding| finding.id.as_str())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    for finding_id in &finding_ids {
        validate_uuid_v7("finding citation id", finding_id)?;
        if !seen.insert(finding_id.as_str()) {
            return Err(CoreError::Message(format!(
                "note repeats finding citation {finding_id}"
            )));
        }
        if !available.contains(finding_id.as_str()) {
            return Err(CoreError::Message(format!(
                "note cites missing finding {finding_id}"
            )));
        }
    }
    Ok((!finding_ids.is_empty()).then_some(finding_ids))
}

fn validate_requested_evidence_ids(
    document: &InvestigationDocument,
    evidence_ids: Vec<String>,
) -> CoreResult<Vec<String>> {
    if evidence_ids.is_empty() || evidence_ids.len() > MAX_INVESTIGATION_ITEM_CITATIONS {
        return Err(CoreError::Message(format!(
            "note evidence citations must contain 1..={MAX_INVESTIGATION_ITEM_CITATIONS} ids"
        )));
    }
    let available = document
        .evidence
        .iter()
        .map(|evidence| evidence.id.as_str())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    for evidence_id in &evidence_ids {
        validate_uuid_v7("evidence citation id", evidence_id)?;
        if !seen.insert(evidence_id.as_str()) {
            return Err(CoreError::Message(format!(
                "note repeats evidence citation {evidence_id}"
            )));
        }
        if !available.contains(evidence_id.as_str()) {
            return Err(CoreError::Message(format!(
                "note cites missing evidence {evidence_id}"
            )));
        }
    }
    Ok(evidence_ids)
}

fn advance_revision(document: &mut InvestigationDocument, now: i64) -> CoreResult<()> {
    document.revision = document
        .revision
        .checked_add(1)
        .ok_or_else(|| CoreError::Message("investigation revision overflow".into()))?;
    if document.revision > MAX_INVESTIGATION_REVISIONS {
        return Err(CoreError::Message(format!(
            "investigation exceeds {MAX_INVESTIGATION_REVISIONS} revisions"
        )));
    }
    document.schema_version = INVESTIGATION_SCHEMA_VERSION;
    document.updated_at = now;
    Ok(())
}

fn validate_document(
    document: &InvestigationDocument,
    expected_id: Option<&str>,
    expected_revision: Option<u64>,
) -> CoreResult<()> {
    if !(MIN_INVESTIGATION_SCHEMA_VERSION..=INVESTIGATION_SCHEMA_VERSION)
        .contains(&document.schema_version)
    {
        return Err(CoreError::Message(format!(
            "investigation schema version {} is unsupported; expected {MIN_INVESTIGATION_SCHEMA_VERSION}..={INVESTIGATION_SCHEMA_VERSION}",
            document.schema_version
        )));
    }
    if document.schema_version == 1 && (!document.findings.is_empty() || !document.notes.is_empty())
    {
        return Err(CoreError::Message(
            "investigation schema version 1 cannot contain findings or notes".into(),
        ));
    }
    if document.schema_version < 3
        && document
            .findings
            .iter()
            .any(|finding| finding.view_recipe.is_some())
    {
        return Err(CoreError::Message(
            "investigation schema versions 1 and 2 cannot contain finding view recipes".into(),
        ));
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

    if document.findings.len() > MAX_INVESTIGATION_FINDINGS {
        return Err(CoreError::Message(format!(
            "investigation exceeds {MAX_INVESTIGATION_FINDINGS} findings"
        )));
    }
    let mut finding_ids = HashSet::new();
    for finding in &document.findings {
        validate_uuid_v7("finding id", &finding.id)?;
        if !finding_ids.insert(finding.id.as_str()) {
            return Err(CoreError::Message(format!(
                "investigation repeats finding id {}",
                finding.id
            )));
        }
        validate_stored_title("finding title", &finding.title)?;
        validate_stored_body(
            "finding why it matters",
            &finding.why_it_matters,
            MAX_FINDING_WHY_IT_MATTERS_BYTES,
        )?;
        if finding.created_at > finding.updated_at {
            return Err(CoreError::Message(format!(
                "finding {} updated_at precedes created_at",
                finding.id
            )));
        }
        validate_citation_ids("finding evidence", &finding.evidence_ids, &evidence_ids)?;
        if let Some(recipe) = &finding.view_recipe {
            validate_stored_finding_view_recipe(recipe, &linked_corpora)?;
        }
    }

    if document.notes.len() > MAX_INVESTIGATION_NOTES {
        return Err(CoreError::Message(format!(
            "investigation exceeds {MAX_INVESTIGATION_NOTES} notes"
        )));
    }
    let mut note_ids = HashSet::new();
    for note in &document.notes {
        validate_uuid_v7("note id", &note.id)?;
        if !note_ids.insert(note.id.as_str()) {
            return Err(CoreError::Message(format!(
                "investigation repeats note id {}",
                note.id
            )));
        }
        validate_stored_title("note title", &note.title)?;
        validate_stored_body("note body", &note.body, MAX_INVESTIGATION_NOTE_BODY_BYTES)?;
        if note.created_at > note.updated_at {
            return Err(CoreError::Message(format!(
                "note {} updated_at precedes created_at",
                note.id
            )));
        }
        validate_citation_ids("note evidence", &note.evidence_ids, &evidence_ids)?;
        if let Some(citations) = note.finding_ids.as_deref() {
            validate_citation_ids("note finding", citations, &finding_ids)?;
        }
    }
    Ok(())
}

fn validate_citation_ids(
    kind: &str,
    citations: &[String],
    available: &HashSet<&str>,
) -> CoreResult<()> {
    if citations.is_empty() || citations.len() > MAX_INVESTIGATION_ITEM_CITATIONS {
        return Err(CoreError::Message(format!(
            "{kind} citations must contain 1..={MAX_INVESTIGATION_ITEM_CITATIONS} ids"
        )));
    }
    let mut seen = HashSet::new();
    for citation in citations {
        validate_uuid_v7(&format!("{kind} citation id"), citation)?;
        if !seen.insert(citation.as_str()) {
            return Err(CoreError::Message(format!(
                "{kind} repeats citation {citation}"
            )));
        }
        if !available.contains(citation.as_str()) {
            return Err(CoreError::Message(format!(
                "{kind} cites missing id {citation}"
            )));
        }
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
            let status = exact_reference_status(&event_ref, corpus_id, actual_by_seq);
            EvidenceReferenceResolution {
                event_ref,
                status,
                event,
            }
        })
        .collect()
}

fn exact_reference_status(
    event_ref: &BookmarkEventRef,
    corpus_id: &str,
    actual_by_seq: &HashMap<u64, ExplorerEvent>,
) -> EvidenceReferenceStatus {
    match actual_by_seq.get(&event_ref.seq) {
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
    }
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

    fn finding_input(corpus: &LogCorpus) -> AddFindingInput {
        AddFindingInput {
            kind: FindingKind::Observation,
            title: "Failure boundary".into(),
            why_it_matters: "The selected events bracket the incident.".into(),
            event_refs: selected_refs(corpus),
            view_recipe: None,
        }
    }

    fn finding_view_recipe(corpus: &LogCorpus) -> FindingViewRecipe {
        FindingViewRecipe {
            filters: FindingViewFilters {
                levels: vec!["warn".into(), "error".into(), "error".into()],
                sources: vec!["worker/worker.log".into(), "api/app.log".into()],
                services: vec!["worker".into(), "api".into()],
                hosts: vec!["host-b".into(), "host-a".into()],
                time_from: Some(1_700_000_000),
                time_to: Some(1_700_000_100),
                seq_from: Some(10),
                seq_to: Some(12),
                template_id: Some(1),
                trace_id: Some("trace-incident".into()),
                keyword: Some("failure boundary".into()),
            },
            lanes: vec![
                FindingViewLane {
                    id: "lane-api".into(),
                    label: "API".into(),
                    sources: vec!["api/app.log".into()],
                },
                FindingViewLane {
                    id: "lane-worker".into(),
                    label: "Worker".into(),
                    sources: vec!["worker/worker.log".into()],
                },
            ],
            visible_lane_count: 2,
            time_link_mode: FindingViewTimeLinkMode::AlignTime,
            focused_lane_id: Some("lane-api".into()),
            focused_event: Some(event_ref(corpus, 10, "api/app.log", 1_700_000_010)),
            selection: selected_refs(corpus),
            highlights: vec![event_ref(corpus, 12, "worker/worker.log", 1_700_000_012)],
            find: Some(FindingViewFind {
                query: "failure|warning".into(),
                match_mode: FindingViewFindMatchMode::Regex,
                case_sensitive: false,
                semantic: false,
            }),
            viewport_anchors: vec![
                FindingViewViewportAnchor {
                    lane_id: "lane-worker".into(),
                    event_ref: event_ref(corpus, 12, "worker/worker.log", 1_700_000_012),
                },
                FindingViewViewportAnchor {
                    lane_id: "lane-api".into(),
                    event_ref: event_ref(corpus, 10, "api/app.log", 1_700_000_010),
                },
            ],
        }
    }

    fn note_input(corpus: &LogCorpus, finding_ids: Vec<String>, title: &str) -> AddNoteInput {
        AddNoteInput {
            title: title.into(),
            body: "Follow up with the service owner.".into(),
            event_refs: selected_refs(corpus),
            finding_ids,
        }
    }

    #[test]
    fn investigation_v1_loads_without_rewrite_and_first_mutation_upgrades_to_v3() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Legacy investigation", &corpus).unwrap();
        let revision_path = durable.path().join(&document.id).join(revision_filename(1));
        let mut legacy = serde_json::to_value(&document).unwrap();
        legacy["schemaVersion"] = serde_json::json!(1);
        legacy.as_object_mut().unwrap().remove("findings");
        legacy.as_object_mut().unwrap().remove("notes");
        let legacy_bytes = serde_json::to_vec_pretty(&legacy).unwrap();
        std::fs::write(&revision_path, &legacy_bytes).unwrap();

        let loaded = store.load(&document.id, &corpus).unwrap();
        assert_eq!(loaded.document.schema_version, 1);
        assert!(loaded.document.findings.is_empty());
        assert!(loaded.document.notes.is_empty());
        assert_eq!(std::fs::read(&revision_path).unwrap(), legacy_bytes);
        assert!(!durable
            .path()
            .join(&document.id)
            .join(revision_filename(2))
            .exists());

        let upgraded = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        assert_eq!(upgraded.document.schema_version, 3);
        assert_eq!(upgraded.document.revision, 2);
        assert!(revision_path.exists());
    }

    #[test]
    fn investigation_v2_loads_without_rewrite_and_first_recipe_mutation_upgrades_to_v3() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Version two investigation", &corpus).unwrap();
        let with_legacy_finding = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        let revision_path = durable.path().join(&document.id).join(revision_filename(2));
        let mut legacy = serde_json::to_value(&with_legacy_finding.document).unwrap();
        legacy["schemaVersion"] = serde_json::json!(2);
        let legacy_bytes = serde_json::to_vec_pretty(&legacy).unwrap();
        std::fs::write(&revision_path, &legacy_bytes).unwrap();

        let loaded = store.load(&document.id, &corpus).unwrap();
        assert_eq!(loaded.document.schema_version, 2);
        assert_eq!(loaded.document.findings.len(), 1);
        assert!(loaded.document.findings[0].view_recipe.is_none());
        assert_eq!(std::fs::read(&revision_path).unwrap(), legacy_bytes);
        assert!(!durable
            .path()
            .join(&document.id)
            .join(revision_filename(3))
            .exists());

        let mut input = finding_input(&corpus);
        input.view_recipe = Some(finding_view_recipe(&corpus));
        let upgraded = store
            .add_human_finding(&document.id, 2, &corpus, input)
            .unwrap();
        assert_eq!(upgraded.document.schema_version, 3);
        assert_eq!(upgraded.document.revision, 3);
        assert_eq!(upgraded.document.findings.len(), 2);
        assert!(upgraded.document.findings[1].view_recipe.is_some());
        assert_eq!(std::fs::read(&revision_path).unwrap(), legacy_bytes);
    }

    #[test]
    fn investigation_findings_and_notes_reopen_with_exact_citations_and_counts() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let corpus_id = corpus.id().to_string();
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Cited analysis", &corpus).unwrap();

        let with_finding = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        let finding = with_finding.document.findings[0].clone();
        let evidence_id = with_finding.document.evidence[0].id.clone();
        assert_eq!(finding.lifecycle, FindingLifecycle::Accepted);
        assert_eq!(finding.evidence_ids, vec![evidence_id.clone()]);
        assert_eq!(with_finding.document.evidence.len(), 1);

        let with_note = store
            .add_human_note(
                &document.id,
                2,
                &corpus,
                note_input(&corpus, vec![finding.id.clone()], "Owner follow-up"),
            )
            .unwrap();
        assert_eq!(with_note.document.evidence.len(), 1);
        assert_eq!(with_note.document.notes[0].evidence_ids, vec![evidence_id]);
        assert_eq!(
            with_note.document.notes[0].finding_ids,
            Some(vec![finding.id])
        );

        drop(corpus);
        let reopened_corpus = LogCorpus::open(cache.path(), &corpus_id).unwrap();
        let reopened = InvestigationStore::new(durable.path())
            .load(&document.id, &reopened_corpus)
            .unwrap();
        assert_eq!(reopened.document.findings.len(), 1);
        assert_eq!(reopened.document.notes.len(), 1);
        let summary = InvestigationStore::new(durable.path()).list().unwrap();
        assert_eq!(summary[0].finding_count, 1);
        assert_eq!(summary[0].note_count, 1);
    }

    #[test]
    fn investigation_finding_and_note_retries_are_idempotent() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Retry safety", &corpus).unwrap();

        let first = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        let retry = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        assert_eq!(retry.document.revision, first.document.revision);
        assert_eq!(retry.document.findings.len(), 1);
        assert_eq!(retry.document.evidence.len(), 1);

        let finding_id = first.document.findings[0].id.clone();
        let note = note_input(&corpus, vec![finding_id], "Retry note");
        let first_note = store
            .add_human_note(&document.id, 2, &corpus, note.clone())
            .unwrap();
        let retry_note = store
            .add_human_note(&document.id, 2, &corpus, note)
            .unwrap();
        assert_eq!(retry_note.document.revision, first_note.document.revision);
        assert_eq!(retry_note.document.notes.len(), 1);
        assert_eq!(retry_note.document.evidence.len(), 1);
    }

    #[test]
    fn investigation_finding_view_recipe_roundtrips_and_is_part_of_idempotence() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Durable view", &corpus).unwrap();
        let mut input = finding_input(&corpus);
        let requested_recipe = finding_view_recipe(&corpus);
        input.view_recipe = Some(requested_recipe.clone());

        let first = store
            .add_human_finding(&document.id, 1, &corpus, input.clone())
            .unwrap();
        let saved = first.document.findings[0].view_recipe.as_ref().unwrap();
        assert_eq!(saved.filters.levels, vec!["error", "warn"]);
        assert_eq!(saved.selection[0].seq, 10);
        assert_eq!(saved.viewport_anchors[0].lane_id, "lane-api");
        assert_eq!(saved.viewport_anchors[1].lane_id, "lane-worker");

        let retry = store
            .add_human_finding(&document.id, 1, &corpus, input)
            .unwrap();
        assert_eq!(retry.document.revision, first.document.revision);
        assert_eq!(retry.document.findings.len(), 1);

        let mut different = finding_input(&corpus);
        let mut different_recipe = requested_recipe;
        different_recipe.time_link_mode = FindingViewTimeLinkMode::FollowCursor;
        different.view_recipe = Some(different_recipe);
        let second = store
            .add_human_finding(&document.id, first.document.revision, &corpus, different)
            .unwrap();
        assert_eq!(second.document.findings.len(), 2);
        assert_eq!(second.document.revision, first.document.revision + 1);

        let reopened = store.load(&document.id, &corpus).unwrap();
        let json = serde_json::to_string(&reopened.document).unwrap();
        assert!(json.contains("\"viewRecipe\""));
        assert!(json.contains("\"linkMode\":\"align_time\""));
        assert!(!json.contains("\"timeLinkMode\""));
        assert!(!json.contains(PAYLOAD_SENTINEL));
        assert!(!json.contains("\"message\""));
        assert_eq!(
            reopened.document.findings[0].view_recipe.as_ref(),
            first.document.findings[0].view_recipe.as_ref()
        );
    }

    #[test]
    fn investigation_finding_view_recipe_rejects_unsafe_shapes_refs_and_secrets() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Adversarial recipes", &corpus).unwrap();

        let reject = |recipe: FindingViewRecipe| {
            let mut input = finding_input(&corpus);
            input.view_recipe = Some(recipe);
            store
                .add_human_finding(&document.id, 1, &corpus, input)
                .unwrap_err()
                .to_string()
        };

        let mut too_many_lanes = finding_view_recipe(&corpus);
        too_many_lanes
            .lanes
            .extend((3..=5).map(|index| FindingViewLane {
                id: format!("lane-{index}"),
                label: format!("Lane {index}"),
                sources: Vec::new(),
            }));
        assert!(reject(too_many_lanes).contains("1..=4 lanes"));

        let mut duplicate_lane = finding_view_recipe(&corpus);
        duplicate_lane.lanes[1].id = duplicate_lane.lanes[0].id.clone();
        assert!(reject(duplicate_lane).contains("repeats lane id"));

        let mut missing_focus = finding_view_recipe(&corpus);
        missing_focus.focused_lane_id = Some("missing-lane".into());
        assert!(reject(missing_focus).contains("focused lane does not exist"));

        let mut duplicate_anchor = finding_view_recipe(&corpus);
        duplicate_anchor.viewport_anchors[1].lane_id = "lane-worker".into();
        assert!(reject(duplicate_anchor).contains("repeats viewport anchor"));

        let mut oversized_selection = finding_view_recipe(&corpus);
        oversized_selection.selection =
            vec![event_ref(&corpus, 10, "api/app.log", 1_700_000_010); MAX_BOOKMARK_EVENT_REFS + 1];
        assert!(reject(oversized_selection).contains("selection exceeds"));

        let mut missing_ref = finding_view_recipe(&corpus);
        missing_ref.focused_event = Some(event_ref(&corpus, 99, "api/app.log", 1_700_000_099));
        assert!(reject(missing_ref).contains("missing from corpus"));

        let mut stale_ref = finding_view_recipe(&corpus);
        stale_ref.highlights = vec![event_ref(&corpus, 10, "changed.log", 1_700_000_010)];
        assert!(reject(stale_ref).contains("no longer matches"));

        let mut absolute_source = finding_view_recipe(&corpus);
        absolute_source.filters.sources = vec!["/var/log/private.log".into()];
        assert!(reject(absolute_source).contains("relative source identity"));

        let mut traversal_source = finding_view_recipe(&corpus);
        traversal_source.lanes[0].sources = vec!["../private.log".into()];
        assert!(reject(traversal_source).contains("relative source identity"));

        let mut portable_absolute_source = finding_view_recipe(&corpus);
        portable_absolute_source.filters.sources = vec![r"C:\logs\private.log".into()];
        assert!(reject(portable_absolute_source).contains("relative source identity"));

        let mut portable_traversal_source = finding_view_recipe(&corpus);
        portable_traversal_source.lanes[0].sources = vec![r"..\private.log".into()];
        assert!(reject(portable_traversal_source).contains("relative source identity"));

        let secret = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz012345"].concat();
        let mut secret_keyword = finding_view_recipe(&corpus);
        secret_keyword.filters.keyword = Some(secret.clone());
        assert!(reject(secret_keyword).contains("credential"));

        let mut secret_find = finding_view_recipe(&corpus);
        secret_find.find.as_mut().unwrap().query = secret;
        assert!(reject(secret_find).contains("credential"));

        let mut reversed_time = finding_view_recipe(&corpus);
        reversed_time.filters.time_from = Some(10);
        reversed_time.filters.time_to = Some(10);
        assert!(reject(reversed_time).contains("timeFrom"));

        let mut unknown_payload = serde_json::to_value(finding_view_recipe(&corpus)).unwrap();
        unknown_payload["message"] = serde_json::json!("payload must not deserialize");
        assert!(serde_json::from_value::<FindingViewRecipe>(unknown_payload)
            .unwrap_err()
            .to_string()
            .contains("unknown field"));

        assert_eq!(
            store.load(&document.id, &corpus).unwrap().document.revision,
            1
        );
    }

    #[test]
    fn investigation_finding_view_preview_counts_stale_and_missing_without_payload() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Recipe resolution", &corpus).unwrap();
        let mut input = finding_input(&corpus);
        input.view_recipe = Some(finding_view_recipe(&corpus));
        let added = store
            .add_human_finding(&document.id, 1, &corpus, input)
            .unwrap();
        let finding_id = added.document.findings[0].id.clone();
        let durable_recipe = added.document.findings[0]
            .view_recipe
            .clone()
            .expect("recipe was saved");

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

        let resolved = store
            .resolve_finding_view_recipe(&document.id, &finding_id, &corpus)
            .unwrap();
        assert_eq!(resolved.stale_count, 3);
        assert_eq!(resolved.missing_count, 3);
        assert_eq!(resolved.view_recipe, durable_recipe);
        let json = serde_json::to_string(&resolved).unwrap();
        assert!(json.contains("\"recipe\""));
        assert!(!json.contains("\"viewRecipe\""));
        assert!(!json.contains(PAYLOAD_SENTINEL));
        assert!(!json.contains("\"event\""));
        assert!(!json.contains("\"message\""));
        assert_eq!(
            store.load(&document.id, &corpus).unwrap().document.revision,
            added.document.revision
        );
    }

    #[test]
    fn investigation_edits_findings_and_notes_in_append_only_revisions() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Editable analysis", &corpus).unwrap();
        let with_finding = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        let finding_id = with_finding.document.findings[0].id.clone();
        let with_note = store
            .add_human_note(
                &document.id,
                2,
                &corpus,
                note_input(&corpus, vec![finding_id.clone()], "Original note"),
            )
            .unwrap();
        let note_id = with_note.document.notes[0].id.clone();
        let evidence_id = with_note.document.evidence[0].id.clone();

        let edited_finding = store
            .edit_human_finding(
                &document.id,
                3,
                &corpus,
                EditFindingInput {
                    finding_id: finding_id.clone(),
                    kind: FindingKind::Inference,
                    lifecycle: FindingLifecycle::Resolved,
                    title: "Corrected finding".into(),
                    why_it_matters: "The owner confirmed the causal boundary.".into(),
                },
            )
            .unwrap();
        assert_eq!(edited_finding.document.revision, 4);
        assert_eq!(
            edited_finding.document.findings[0].lifecycle,
            FindingLifecycle::Resolved
        );

        let edited_note = store
            .edit_human_note(
                &document.id,
                4,
                &corpus,
                EditNoteInput {
                    note_id,
                    title: "Corrected note".into(),
                    body: "The follow-up is complete.".into(),
                    evidence_ids: vec![evidence_id],
                    finding_ids: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(edited_note.document.revision, 5);
        assert_eq!(edited_note.document.notes[0].finding_ids, None);
        assert_eq!(edited_note.document.notes[0].title, "Corrected note");
        assert!(durable
            .path()
            .join(&document.id)
            .join(revision_filename(3))
            .exists());
        assert!(durable
            .path()
            .join(&document.id)
            .join(revision_filename(5))
            .exists());

        let no_op = store
            .edit_human_finding(
                &document.id,
                4,
                &corpus,
                EditFindingInput {
                    finding_id,
                    kind: FindingKind::Inference,
                    lifecycle: FindingLifecycle::Resolved,
                    title: "Corrected finding".into(),
                    why_it_matters: "The owner confirmed the causal boundary.".into(),
                },
            )
            .unwrap();
        assert_eq!(no_op.document.revision, 5);

        let stale_edit = store
            .edit_human_finding(
                &document.id,
                4,
                &corpus,
                EditFindingInput {
                    finding_id: no_op.document.findings[0].id.clone(),
                    kind: FindingKind::Hypothesis,
                    lifecycle: FindingLifecycle::Accepted,
                    title: "Conflicting stale edit".into(),
                    why_it_matters: "This writer did not observe revision five.".into(),
                },
            )
            .unwrap_err();
        assert!(stale_edit
            .to_string()
            .contains("stale investigation revision"));
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
        let missing = event_ref(&corpus, 999, "api/app.log", 1_700_000_010);
        let mut missing_finding = finding_input(&corpus);
        missing_finding.event_refs = vec![missing];
        assert!(store
            .add_human_finding(&document.id, 1, &corpus, missing_finding)
            .unwrap_err()
            .to_string()
            .contains("missing"));
        let stale = event_ref(&corpus, 10, "changed.log", 1_700_000_010);
        let stale_note = AddNoteInput {
            title: "Stale note".into(),
            body: "This must not persist.".into(),
            event_refs: vec![stale],
            finding_ids: Vec::new(),
        };
        assert!(store
            .add_human_note(&document.id, 1, &corpus, stale_note)
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

        let stale_finding = first
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap_err();
        assert!(stale_finding
            .to_string()
            .contains("stale investigation revision"));
        assert!(first
            .load(&document.id, &corpus)
            .unwrap()
            .document
            .findings
            .is_empty());
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
        let with_evidence = store
            .add_exact_evidence(
                &document.id,
                1,
                "Exact evidence",
                &corpus,
                vec![event_ref(&corpus, 10, "api/app.log", 1_700_000_010)],
            )
            .unwrap();
        let with_finding = store
            .add_human_finding(
                &document.id,
                with_evidence.document.revision,
                &corpus,
                finding_input(&corpus),
            )
            .unwrap();
        store
            .add_human_note(
                &document.id,
                with_finding.document.revision,
                &corpus,
                note_input(
                    &corpus,
                    vec![with_finding.document.findings[0].id.clone()],
                    "Payload-free note",
                ),
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

        let finding = store
            .add_human_finding(
                &document.id,
                added.document.revision,
                &corpus,
                AddFindingInput {
                    kind: FindingKind::Hypothesis,
                    title: format!("Finding around {secret} in deployment"),
                    why_it_matters: format!(
                        "The owner should rotate {secret} after confirming the boundary."
                    ),
                    event_refs: selected_refs(&corpus),
                    view_recipe: None,
                },
            )
            .unwrap();
        let saved_finding = &finding.document.findings[0];
        assert!(!saved_finding.title.contains(&secret));
        assert!(!saved_finding.why_it_matters.contains(&secret));
        assert!(saved_finding.title.contains("sk-***"));
        assert!(saved_finding.why_it_matters.contains("sk-***"));

        let note = store
            .add_human_note(
                &document.id,
                finding.document.revision,
                &corpus,
                AddNoteInput {
                    title: format!("Note about {secret} during review"),
                    body: format!("Discussed rotating {secret} with the service owner."),
                    event_refs: selected_refs(&corpus),
                    finding_ids: vec![saved_finding.id.clone()],
                },
            )
            .unwrap();
        assert!(!note.document.notes[0].title.contains(&secret));
        assert!(!note.document.notes[0].body.contains(&secret));

        let mut blocked = finding_input(&corpus);
        blocked.why_it_matters = secret.clone();
        assert!(store
            .add_human_finding(&document.id, note.document.revision, &corpus, blocked)
            .is_err());
    }

    #[test]
    fn investigation_finding_note_bounds_and_citations_fail_closed() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Analysis validation", &corpus).unwrap();

        let mut long_finding = finding_input(&corpus);
        long_finding.why_it_matters = "x".repeat(MAX_FINDING_WHY_IT_MATTERS_BYTES + 1);
        assert!(store
            .add_human_finding(&document.id, 1, &corpus, long_finding)
            .unwrap_err()
            .to_string()
            .contains("exceeds"));

        let missing_finding_id = Uuid::now_v7().to_string();
        let missing_citation = note_input(&corpus, vec![missing_finding_id], "Missing citation");
        assert!(store
            .add_human_note(&document.id, 1, &corpus, missing_citation)
            .unwrap_err()
            .to_string()
            .contains("missing finding"));

        let with_finding = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        let finding_id = with_finding.document.findings[0].id.clone();
        let too_many_citations = AddNoteInput {
            title: "Too many citations".into(),
            body: "This should fail before publication.".into(),
            event_refs: selected_refs(&corpus),
            finding_ids: (0..=MAX_INVESTIGATION_ITEM_CITATIONS)
                .map(|_| Uuid::now_v7().to_string())
                .collect(),
        };
        assert!(store
            .add_human_note(&document.id, 2, &corpus, too_many_citations)
            .unwrap_err()
            .to_string()
            .contains("finding citations"));
        let duplicate = note_input(
            &corpus,
            vec![finding_id.clone(), finding_id],
            "Duplicate citation",
        );
        assert!(store
            .add_human_note(&document.id, 2, &corpus, duplicate)
            .unwrap_err()
            .to_string()
            .contains("repeats finding citation"));

        let mut long_note = note_input(&corpus, Vec::new(), "Long body");
        long_note.body = "x".repeat(MAX_INVESTIGATION_NOTE_BODY_BYTES + 1);
        assert!(store
            .add_human_note(&document.id, 2, &corpus, long_note)
            .unwrap_err()
            .to_string()
            .contains("exceeds"));

        let note = store
            .add_human_note(
                &document.id,
                2,
                &corpus,
                note_input(&corpus, Vec::new(), "Editable citations"),
            )
            .unwrap();
        let missing_evidence = Uuid::now_v7().to_string();
        assert!(store
            .edit_human_note(
                &document.id,
                note.document.revision,
                &corpus,
                EditNoteInput {
                    note_id: note.document.notes[0].id.clone(),
                    title: "Still valid".into(),
                    body: "But its replacement citation is not.".into(),
                    evidence_ids: vec![missing_evidence],
                    finding_ids: Vec::new(),
                },
            )
            .unwrap_err()
            .to_string()
            .contains("missing evidence"));
        assert_eq!(
            store.load(&document.id, &corpus).unwrap().document.revision,
            note.document.revision
        );

        let mut too_many_findings = with_finding.document.clone();
        let seed_finding = too_many_findings.findings[0].clone();
        while too_many_findings.findings.len() <= MAX_INVESTIGATION_FINDINGS {
            let mut finding = seed_finding.clone();
            finding.id = Uuid::now_v7().to_string();
            too_many_findings.findings.push(finding);
        }
        assert!(validate_document(&too_many_findings, None, None)
            .unwrap_err()
            .to_string()
            .contains("findings"));

        let mut too_many_notes = note.document.clone();
        let seed_note = too_many_notes.notes[0].clone();
        while too_many_notes.notes.len() <= MAX_INVESTIGATION_NOTES {
            let mut note = seed_note.clone();
            note.id = Uuid::now_v7().to_string();
            too_many_notes.notes.push(note);
        }
        assert!(validate_document(&too_many_notes, None, None)
            .unwrap_err()
            .to_string()
            .contains("notes"));

        let mut archived = note.document.clone();
        archived.status = InvestigationStatus::Archived;
        advance_revision(&mut archived, crate::embed::now_unix_secs()).unwrap();
        publish_revision(&durable.path().join(&document.id), &archived).unwrap();
        assert!(store
            .add_human_finding(
                &document.id,
                archived.revision,
                &corpus,
                AddFindingInput {
                    kind: FindingKind::Observation,
                    title: "Archived write".into(),
                    why_it_matters: "Archived investigations must reject this.".into(),
                    event_refs: selected_refs(&corpus),
                    view_recipe: None,
                },
            )
            .unwrap_err()
            .to_string()
            .contains("archived"));
    }
}
