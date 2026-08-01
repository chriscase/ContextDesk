//! Durable investigation report sections and the versioned report projection.
//!
//! Authored report sections are human-provenance analysis bound to one
//! investigation (at most one section per kind). Proposed report sections
//! mirror proposed findings (#646): durable queue items that only explicit
//! human Accept / Edit-and-accept / Dismiss transitions change. Assembly and
//! markdown rendering are pure projections over an already-resolved document —
//! they never mutate the durable investigation record and never surface event
//! payloads, only exact identities.

use super::*;
use crate::log_analysis::TimeQuality;
use serde_json::Value;

/// Maximum UTF-8 bytes in one authored or proposed report section body.
pub const MAX_REPORT_SECTION_BODY_BYTES: usize = 16_384;
/// Shared maximum citations (evidence + finding + note ids) on one section.
pub const MAX_REPORT_SECTION_CITATIONS: usize = 256;
/// Maximum durable proposed report sections in one investigation.
pub const MAX_PROPOSED_REPORT_SECTIONS: usize = 64;
/// Maximum rendered timeline entries; the remainder is an explicit omitted count.
pub const MAX_REPORT_TIMELINE_ENTRIES: usize = 512;
/// Versioned schema of the assembled [`InvestigationReport`] projection.
pub const INVESTIGATION_REPORT_SCHEMA_VERSION: u32 = 1;
/// Stable tool name for agent-proposed report sections.
pub const PROPOSE_REPORT_SECTION_TOOL: &str = "propose_report_section";

/// Authorable report section kind. Scope, findings, timeline, and hypotheses
/// sections are derived-only and never authored.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ReportSectionKind {
    /// Human summary of the incident and its impact.
    ExecutiveSummary,
    /// Open questions that the evidence does not yet answer.
    UnresolvedQuestions,
    /// Concrete follow-up actions.
    NextActions,
}

impl ReportSectionKind {
    /// Every authorable kind in fixed render order.
    pub const ALL: [ReportSectionKind; 3] = [
        ReportSectionKind::ExecutiveSummary,
        ReportSectionKind::UnresolvedQuestions,
        ReportSectionKind::NextActions,
    ];

    /// Stable snake_case identifier (matches serde).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExecutiveSummary => "executive_summary",
            Self::UnresolvedQuestions => "unresolved_questions",
            Self::NextActions => "next_actions",
        }
    }

    /// Human-facing markdown heading.
    pub fn heading(self) -> &'static str {
        match self {
            Self::ExecutiveSummary => "Executive summary",
            Self::UnresolvedQuestions => "Unresolved questions",
            Self::NextActions => "Next actions",
        }
    }
}

/// A durable, human-provenance authored report section (at most one per kind).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportSectionItem {
    /// Stable UUIDv7 section identifier, preserved across in-place replacement.
    pub id: String,
    /// Authorable section kind.
    pub kind: ReportSectionKind,
    /// Redacted, canonical, bounded section body.
    pub body: String,
    /// Durable evidence-item citations within the same investigation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<String>,
    /// Durable finding citations within the same investigation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub finding_ids: Vec<String>,
    /// Durable note citations within the same investigation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub note_ids: Vec<String>,
    /// Explicit human-only authorship provenance.
    pub provenance: HumanProvenance,
    /// Proposal this section was accepted from, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_from_proposal_id: Option<String>,
    /// Creation time as Unix seconds.
    pub created_at: i64,
    /// Last update time as Unix seconds.
    pub updated_at: i64,
}

/// Durable proposed report section. Status begins at Proposed and never
/// auto-accepts; only explicit human review changes lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedReportSectionItem {
    /// Stable UUIDv7 proposal identifier.
    pub id: String,
    /// Review lifecycle status (shared with proposed findings).
    pub status: ProposedFindingStatus,
    /// Proposed section kind.
    pub kind: ReportSectionKind,
    /// Redacted, canonical, bounded proposed body.
    pub body: String,
    /// Durable evidence-item citations within the same investigation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence_ids: Vec<String>,
    /// Durable finding citations within the same investigation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub finding_ids: Vec<String>,
    /// Durable note citations within the same investigation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub note_ids: Vec<String>,
    /// Bound corpus id (must match the investigation corpus).
    pub corpus_id: String,
    /// Bound investigation id.
    pub investigation_id: String,
    /// Privacy-safe provenance (no credentials, prompts, or payloads).
    pub provenance: ProposalProvenance,
    /// Idempotency key for retry-safe propose.
    pub idempotency_key: String,
    /// Human acceptance when status is Accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<HumanProposalAcceptance>,
    /// Dismiss reason when status is Dismissed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismiss_reason: Option<String>,
    /// Linked authored section id after Accept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_section_id: Option<String>,
    /// Creation time as Unix seconds.
    pub created_at: i64,
    /// Last update time as Unix seconds.
    pub updated_at: i64,
}

/// Input for one atomic human set/replace of an authored report section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetReportSectionInput {
    /// Section kind to create or replace.
    pub kind: ReportSectionKind,
    /// Human-facing body to redact and validate.
    pub body: String,
    /// Existing evidence citations, or empty for none.
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    /// Existing finding citations, or empty for none.
    #[serde(default)]
    pub finding_ids: Vec<String>,
    /// Existing note citations, or empty for none.
    #[serde(default)]
    pub note_ids: Vec<String>,
}

/// Input for one host-validated report section propose mutation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProposeReportSectionInput {
    /// Target investigation (must be active and bound to corpus).
    pub investigation_id: String,
    /// Optimistic expected revision.
    pub expected_revision: u64,
    /// Idempotency key (required; identical retries return existing).
    pub idempotency_key: String,
    /// Proposed section kind.
    pub kind: ReportSectionKind,
    /// Proposed body (redacted/validated).
    pub body: String,
    /// Existing evidence citations, or empty for none.
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    /// Existing finding citations, or empty for none.
    #[serde(default)]
    pub finding_ids: Vec<String>,
    /// Existing note citations, or empty for none.
    #[serde(default)]
    pub note_ids: Vec<String>,
    /// Provenance (no secrets); host-authored on the tool path.
    pub provenance: ProposalProvenance,
}

/// Input for human accept of a proposed report section (optionally edited).
///
/// There is deliberately no renderer-claimed `edited` flag: whether the
/// acceptance was an edit is host-derived from whether the durable body
/// actually differs from the proposal body, so the acceptance record can
/// never assert an edit that did not happen.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptProposedReportSectionInput {
    /// Proposal id.
    pub proposal_id: String,
    /// Optimistic expected revision.
    pub expected_revision: u64,
    /// Optional replacement body (edit-and-accept).
    #[serde(default)]
    pub body: Option<String>,
}

/// Input for dismiss-with-reason of a proposed report section.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DismissProposedReportSectionInput {
    /// Proposal id.
    pub proposal_id: String,
    /// Optimistic expected revision.
    pub expected_revision: u64,
    /// Required human dismiss reason.
    pub reason: String,
}

/// Validated same-investigation citations for one report section.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ReportSectionCitations {
    evidence_ids: Vec<String>,
    finding_ids: Vec<String>,
    note_ids: Vec<String>,
}

impl InvestigationStore {
    /// Create or replace the authored report section for one kind.
    ///
    /// At most one section exists per kind; replacement preserves the section
    /// id and creation time. Provenance is always human. Supplying content
    /// already present is idempotent and does not publish a revision. A manual
    /// set clears any prior accepted-from-proposal link because the replacement
    /// body is fresh human authorship.
    pub fn set_report_section(
        &self,
        investigation_id: &str,
        expected_revision: u64,
        corpus: &LogCorpus,
        input: SetReportSectionInput,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        let kind = input.kind;
        let body = sanitize_body(
            "report section body",
            input.body,
            MAX_REPORT_SECTION_BODY_BYTES,
        )?;
        let mut document = self.load_document(investigation_id)?;
        ensure_active_single_corpus(&document, corpus)?;
        let citations = validate_requested_report_citations(
            &document,
            input.evidence_ids,
            input.finding_ids,
            input.note_ids,
        )?;

        if report_section_matches(&document, kind, &body, &citations) {
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
        upsert_report_section(
            &mut document,
            kind,
            body.clone(),
            citations.clone(),
            None,
            now,
        );
        advance_revision(&mut document, now)?;

        let directory = self.investigation_directory(investigation_id)?;
        match publish_revision(&directory, &document) {
            Ok(()) => resolve_document(document, corpus),
            Err(publication_error) => {
                let latest = self.load_document(investigation_id)?;
                if report_section_matches(&latest, kind, &body, &citations) {
                    resolve_document(latest, corpus)
                } else {
                    Err(publication_error)
                }
            }
        }
    }

    /// Host-validated propose: creates only a durable **Proposed** report section.
    ///
    /// Never creates or replaces authored sections, never mutates Explorer.
    /// Idempotent on `idempotency_key` within the investigation; the same key
    /// with a materially different payload fails closed.
    pub fn propose_report_section(
        &self,
        corpus: &LogCorpus,
        input: ProposeReportSectionInput,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        let idempotency_key = proposed::sanitize_idempotency_key(input.idempotency_key)?;
        let body = sanitize_body(
            "report section body",
            input.body,
            MAX_REPORT_SECTION_BODY_BYTES,
        )
        .map_err(|e| propose_repair_error(ProposeFindingErrorCode::InvalidInput, e.to_string()))?;
        let provenance = proposed::sanitize_provenance(input.provenance)?;
        let kind = input.kind;

        let mut document = self.load_document(&input.investigation_id)?;
        ensure_active_single_corpus(&document, corpus).map_err(|e| {
            propose_repair_error(ProposeFindingErrorCode::WrongCorpus, e.to_string())
        })?;
        if document.revision != input.expected_revision {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::StaleRevision,
                format!(
                    "expected revision {} current {}",
                    input.expected_revision, document.revision
                ),
            ));
        }
        if document.proposed_report_sections.len() >= MAX_PROPOSED_REPORT_SECTIONS {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                format!(
                    "investigation exceeds {MAX_PROPOSED_REPORT_SECTIONS} proposed report sections"
                ),
            ));
        }
        let citations = validate_requested_report_citations(
            &document,
            input.evidence_ids,
            input.finding_ids,
            input.note_ids,
        )
        .map_err(|e| propose_repair_error(ProposeFindingErrorCode::InvalidInput, e.to_string()))?;

        // Exact idempotency: same key + same canonical payload → return existing
        // (any terminal status). Same key + different payload → typed conflict.
        if let Some(existing) = document
            .proposed_report_sections
            .iter()
            .find(|p| p.idempotency_key == idempotency_key)
        {
            if report_proposal_payload_matches(existing, kind, &body, &citations) {
                return resolve_document(document, corpus);
            }
            return Err(propose_repair_error(
                ProposeFindingErrorCode::IdempotencyConflict,
                format!(
                    "idempotency_key {idempotency_key} already used by report section proposal {} with a different payload",
                    existing.id
                ),
            ));
        }

        let now = crate::embed::now_unix_secs();
        let proposal = ProposedReportSectionItem {
            id: Uuid::now_v7().to_string(),
            status: ProposedFindingStatus::Proposed,
            kind,
            body,
            evidence_ids: citations.evidence_ids,
            finding_ids: citations.finding_ids,
            note_ids: citations.note_ids,
            corpus_id: corpus.id().to_string(),
            investigation_id: document.id.clone(),
            provenance,
            idempotency_key,
            acceptance: None,
            dismiss_reason: None,
            accepted_section_id: None,
            created_at: now,
            updated_at: now,
        };
        advance_revision(&mut document, now)?;
        document.proposed_report_sections.push(proposal);
        let directory = self.investigation_directory(&document.id)?;
        publish_revision(&directory, &document)?;
        resolve_document(document, corpus)
    }

    /// Explicit human Accept or Edit-and-accept of a proposed report section.
    ///
    /// Creates or replaces the authored section for the proposal's kind with an
    /// accepted-from-proposal link, marks the proposal Accepted, and preserves
    /// the proposal body and provenance as inspectable history.
    pub fn accept_proposed_report_section(
        &self,
        corpus: &LogCorpus,
        investigation_id: &str,
        input: AcceptProposedReportSectionInput,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        let mut document = self.load_document(investigation_id)?;
        ensure_active_single_corpus(&document, corpus)?;
        if document.revision != input.expected_revision {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::StaleRevision,
                format!(
                    "expected revision {} current {}",
                    input.expected_revision, document.revision
                ),
            ));
        }
        let idx = document
            .proposed_report_sections
            .iter()
            .position(|p| p.id == input.proposal_id)
            .ok_or_else(|| {
                propose_repair_error(
                    ProposeFindingErrorCode::InvalidInput,
                    format!("report section proposal {} not found", input.proposal_id),
                )
            })?;
        if document.proposed_report_sections[idx].status != ProposedFindingStatus::Proposed {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidLifecycle,
                format!(
                    "report section proposal {} is {:?} and cannot be accepted",
                    input.proposal_id, document.proposed_report_sections[idx].status
                ),
            ));
        }

        let proposal = document.proposed_report_sections[idx].clone();
        let body = match input.body {
            Some(replacement) => sanitize_body(
                "report section body",
                replacement,
                MAX_REPORT_SECTION_BODY_BYTES,
            )?,
            None => proposal.body.clone(),
        };
        // Host-derived truth: an accept is an edit exactly when the durable
        // body differs from the proposed body — never a renderer claim.
        let edited = body != proposal.body;
        // Fail closed if any cited item no longer validates against the document.
        let citations = validate_requested_report_citations(
            &document,
            proposal.evidence_ids.clone(),
            proposal.finding_ids.clone(),
            proposal.note_ids.clone(),
        )?;

        let now = crate::embed::now_unix_secs();
        advance_revision(&mut document, now)?;
        let section_id = upsert_report_section(
            &mut document,
            proposal.kind,
            body,
            citations,
            Some(proposal.id.clone()),
            now,
        );
        let idx = document
            .proposed_report_sections
            .iter()
            .position(|p| p.id == input.proposal_id)
            .expect("proposal still present");
        document.proposed_report_sections[idx].status = ProposedFindingStatus::Accepted;
        document.proposed_report_sections[idx].acceptance = Some(HumanProposalAcceptance {
            accepted_at: now,
            edited,
        });
        document.proposed_report_sections[idx].accepted_section_id = Some(section_id);
        document.proposed_report_sections[idx].updated_at = now;

        let directory = self.investigation_directory(investigation_id)?;
        publish_revision(&directory, &document)?;
        resolve_document(document, corpus)
    }

    /// Explicit Dismiss-with-reason. History remains inspectable.
    pub fn dismiss_proposed_report_section(
        &self,
        corpus: &LogCorpus,
        investigation_id: &str,
        input: DismissProposedReportSectionInput,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        let reason = sanitize_body(
            "dismiss reason",
            input.reason,
            MAX_PROPOSAL_DISMISS_REASON_BYTES,
        )
        .map_err(|e| propose_repair_error(ProposeFindingErrorCode::InvalidInput, e.to_string()))?;
        if reason.trim().is_empty() {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                "dismiss reason is required",
            ));
        }
        let mut document = self.load_document(investigation_id)?;
        ensure_active_single_corpus(&document, corpus)?;
        if document.revision != input.expected_revision {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::StaleRevision,
                format!(
                    "expected revision {} current {}",
                    input.expected_revision, document.revision
                ),
            ));
        }
        let idx = document
            .proposed_report_sections
            .iter()
            .position(|p| p.id == input.proposal_id)
            .ok_or_else(|| {
                propose_repair_error(
                    ProposeFindingErrorCode::InvalidInput,
                    format!("report section proposal {} not found", input.proposal_id),
                )
            })?;
        if document.proposed_report_sections[idx].status != ProposedFindingStatus::Proposed {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidLifecycle,
                format!(
                    "report section proposal {} is {:?} and cannot be dismissed",
                    input.proposal_id, document.proposed_report_sections[idx].status
                ),
            ));
        }
        let now = crate::embed::now_unix_secs();
        advance_revision(&mut document, now)?;
        let idx = document
            .proposed_report_sections
            .iter()
            .position(|p| p.id == input.proposal_id)
            .expect("proposal still present");
        document.proposed_report_sections[idx].status = ProposedFindingStatus::Dismissed;
        document.proposed_report_sections[idx].dismiss_reason = Some(reason);
        document.proposed_report_sections[idx].updated_at = now;
        let directory = self.investigation_directory(investigation_id)?;
        publish_revision(&directory, &document)?;
        resolve_document(document, corpus)
    }

    /// Open Proposed report sections only (terminal states remain loadable via
    /// the full document).
    pub fn list_open_report_section_proposals(
        &self,
        investigation_id: &str,
    ) -> CoreResult<Vec<ProposedReportSectionItem>> {
        let document = self.load_document(investigation_id)?;
        Ok(document
            .proposed_report_sections
            .into_iter()
            .filter(|p| p.status == ProposedFindingStatus::Proposed)
            .collect())
    }
}

fn report_section_matches(
    document: &InvestigationDocument,
    kind: ReportSectionKind,
    body: &str,
    citations: &ReportSectionCitations,
) -> bool {
    document.report_sections.iter().any(|section| {
        section.kind == kind
            && section.body == body
            && section.evidence_ids == citations.evidence_ids
            && section.finding_ids == citations.finding_ids
            && section.note_ids == citations.note_ids
    })
}

fn report_proposal_payload_matches(
    existing: &ProposedReportSectionItem,
    kind: ReportSectionKind,
    body: &str,
    citations: &ReportSectionCitations,
) -> bool {
    existing.kind == kind
        && existing.body == body
        && existing.evidence_ids == citations.evidence_ids
        && existing.finding_ids == citations.finding_ids
        && existing.note_ids == citations.note_ids
}

/// Replace-in-place (preserving id and creation time) or append the authored
/// section for `kind`. Returns the durable section id.
///
/// Replacement keeps proposal history truthful: any previously **Accepted**
/// proposal that recorded itself as this section's origin no longer authored
/// its content, so it transitions to `Superseded` — acceptance record and
/// section link stay as inspectable history, but the row can never silently
/// keep claiming authorship of content it did not write.
fn upsert_report_section(
    document: &mut InvestigationDocument,
    kind: ReportSectionKind,
    body: String,
    citations: ReportSectionCitations,
    accepted_from_proposal_id: Option<String>,
    now: i64,
) -> String {
    if let Some(index) = document
        .report_sections
        .iter()
        .position(|section| section.kind == kind)
    {
        let incoming_origin = accepted_from_proposal_id.clone();
        let existing = &mut document.report_sections[index];
        existing.body = body;
        existing.evidence_ids = citations.evidence_ids;
        existing.finding_ids = citations.finding_ids;
        existing.note_ids = citations.note_ids;
        existing.accepted_from_proposal_id = accepted_from_proposal_id;
        existing.updated_at = now;
        let section_id = document.report_sections[index].id.clone();
        for proposal in &mut document.proposed_report_sections {
            if proposal.status == ProposedFindingStatus::Accepted
                && proposal.accepted_section_id.as_deref() == Some(section_id.as_str())
                && incoming_origin.as_deref() != Some(proposal.id.as_str())
            {
                proposal.status = ProposedFindingStatus::Superseded;
                proposal.updated_at = now;
            }
        }
        return section_id;
    }
    let id = Uuid::now_v7().to_string();
    document.report_sections.push(ReportSectionItem {
        id: id.clone(),
        kind,
        body,
        evidence_ids: citations.evidence_ids,
        finding_ids: citations.finding_ids,
        note_ids: citations.note_ids,
        provenance: HumanProvenance::Human,
        accepted_from_proposal_id,
        created_at: now,
        updated_at: now,
    });
    id
}

fn validate_requested_report_citations(
    document: &InvestigationDocument,
    evidence_ids: Vec<String>,
    finding_ids: Vec<String>,
    note_ids: Vec<String>,
) -> CoreResult<ReportSectionCitations> {
    let total = evidence_ids
        .len()
        .checked_add(finding_ids.len())
        .and_then(|total| total.checked_add(note_ids.len()))
        .ok_or_else(|| CoreError::Message("report section citation count overflow".into()))?;
    if total > MAX_REPORT_SECTION_CITATIONS {
        return Err(CoreError::Message(format!(
            "report section exceeds {MAX_REPORT_SECTION_CITATIONS} citations"
        )));
    }
    let available_evidence = document
        .evidence
        .iter()
        .map(|item| item.id.as_str())
        .collect::<HashSet<_>>();
    let available_findings = document
        .findings
        .iter()
        .map(|finding| finding.id.as_str())
        .collect::<HashSet<_>>();
    let available_notes = document
        .notes
        .iter()
        .map(|note| note.id.as_str())
        .collect::<HashSet<_>>();
    validate_report_citation_list(
        "report section evidence",
        &evidence_ids,
        &available_evidence,
    )?;
    validate_report_citation_list("report section finding", &finding_ids, &available_findings)?;
    validate_report_citation_list("report section note", &note_ids, &available_notes)?;
    Ok(ReportSectionCitations {
        evidence_ids,
        finding_ids,
        note_ids,
    })
}

/// Like [`validate_citation_ids`] but an empty list is legal for report sections.
fn validate_report_citation_list(
    kind: &str,
    citations: &[String],
    available: &HashSet<&str>,
) -> CoreResult<()> {
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

/// Stored-form validation for both report collections, called on every
/// document read and publication.
pub(super) fn validate_stored_report_collections(
    document: &InvestigationDocument,
    evidence_ids: &HashSet<&str>,
    finding_ids: &HashSet<&str>,
    note_ids: &HashSet<&str>,
) -> CoreResult<()> {
    let linked_corpora = document
        .corpus_links
        .iter()
        .map(|link| link.corpus_id.as_str())
        .collect::<HashSet<_>>();
    if document.report_sections.len() > ReportSectionKind::ALL.len() {
        return Err(CoreError::Message(format!(
            "investigation exceeds {} report sections",
            ReportSectionKind::ALL.len()
        )));
    }
    let mut section_ids = HashSet::new();
    let mut kinds = HashSet::new();
    for section in &document.report_sections {
        validate_uuid_v7("report section id", &section.id)?;
        if !section_ids.insert(section.id.as_str()) {
            return Err(CoreError::Message(format!(
                "investigation repeats report section id {}",
                section.id
            )));
        }
        if !kinds.insert(section.kind) {
            return Err(CoreError::Message(format!(
                "investigation repeats report section kind {}",
                section.kind.as_str()
            )));
        }
        validate_stored_body(
            "report section body",
            &section.body,
            MAX_REPORT_SECTION_BODY_BYTES,
        )?;
        if section.created_at > section.updated_at {
            return Err(CoreError::Message(format!(
                "report section {} updated_at precedes created_at",
                section.id
            )));
        }
        validate_stored_report_citations(
            &section.evidence_ids,
            &section.finding_ids,
            &section.note_ids,
            evidence_ids,
            finding_ids,
            note_ids,
        )?;
        if let Some(proposal_id) = section.accepted_from_proposal_id.as_deref() {
            validate_uuid_v7("report section accepted proposal id", proposal_id)?;
        }
    }

    if document.proposed_report_sections.len() > MAX_PROPOSED_REPORT_SECTIONS {
        return Err(CoreError::Message(format!(
            "investigation exceeds {MAX_PROPOSED_REPORT_SECTIONS} proposed report sections"
        )));
    }
    let mut proposal_ids = HashSet::new();
    let mut idempotency_keys = HashSet::new();
    for proposal in &document.proposed_report_sections {
        validate_uuid_v7("report section proposal id", &proposal.id)?;
        if !proposal_ids.insert(proposal.id.as_str()) {
            return Err(CoreError::Message(format!(
                "investigation repeats report section proposal id {}",
                proposal.id
            )));
        }
        validate_uuid_v7(
            "report section proposal investigation id",
            &proposal.investigation_id,
        )?;
        if proposal.investigation_id != document.id {
            return Err(CoreError::Message(
                "report section proposal investigation_id must match document id".into(),
            ));
        }
        validate_corpus_id(&proposal.corpus_id)?;
        if !linked_corpora.contains(proposal.corpus_id.as_str()) {
            return Err(CoreError::Message(format!(
                "report section proposal {} references unlinked corpus {}",
                proposal.id, proposal.corpus_id
            )));
        }
        let canonical_provenance = proposed::sanitize_provenance(proposal.provenance.clone())?;
        if canonical_provenance != proposal.provenance {
            return Err(CoreError::Message(format!(
                "report section proposal {} provenance is not canonical",
                proposal.id
            )));
        }
        validate_stored_body(
            "report section proposal body",
            &proposal.body,
            MAX_REPORT_SECTION_BODY_BYTES,
        )?;
        if proposal.created_at > proposal.updated_at {
            return Err(CoreError::Message(format!(
                "report section proposal {} updated_at precedes created_at",
                proposal.id
            )));
        }
        validate_stored_report_citations(
            &proposal.evidence_ids,
            &proposal.finding_ids,
            &proposal.note_ids,
            evidence_ids,
            finding_ids,
            note_ids,
        )?;
        if proposal.idempotency_key.trim().is_empty()
            || proposal.idempotency_key.len() > MAX_PROPOSAL_IDEMPOTENCY_KEY_BYTES
        {
            return Err(CoreError::Message(format!(
                "report section proposal {} idempotency key is empty or over-limit",
                proposal.id
            )));
        }
        if !idempotency_keys.insert(proposal.idempotency_key.as_str()) {
            return Err(CoreError::Message(format!(
                "investigation repeats report section proposal idempotency key {}",
                proposal.idempotency_key
            )));
        }
        if let Some(acceptance) = proposal.acceptance.as_ref() {
            if acceptance.accepted_at < proposal.created_at
                || acceptance.accepted_at > proposal.updated_at
            {
                return Err(CoreError::Message(format!(
                    "report section proposal {} acceptance time is outside its lifecycle",
                    proposal.id
                )));
            }
        }
        match proposal.status {
            ProposedFindingStatus::Accepted => {
                if proposal.acceptance.is_none()
                    || proposal.accepted_section_id.is_none()
                    || proposal.dismiss_reason.is_some()
                {
                    return Err(CoreError::Message(format!(
                        "accepted report section proposal {} has inconsistent lifecycle state",
                        proposal.id
                    )));
                }
                // Link truth: an Accepted proposal must still be the recorded
                // origin of the section it claims. Replacement transitions the
                // prior origin to Superseded, so a stored document where an
                // Accepted row points at a section that no longer links back
                // is corrupt acceptance history and fails closed.
                let section_id = proposal.accepted_section_id.as_deref().unwrap_or_default();
                let links_back = document.report_sections.iter().any(|section| {
                    section.id == section_id
                        && section.accepted_from_proposal_id.as_deref()
                            == Some(proposal.id.as_str())
                });
                if !links_back {
                    return Err(CoreError::Message(format!(
                        "accepted report section proposal {} claims a section that does not record it as origin; a replaced origin must be superseded",
                        proposal.id
                    )));
                }
            }
            ProposedFindingStatus::Dismissed => {
                if proposal
                    .dismiss_reason
                    .as_deref()
                    .is_none_or(|reason| reason.trim().is_empty())
                    || proposal.acceptance.is_some()
                    || proposal.accepted_section_id.is_some()
                {
                    return Err(CoreError::Message(format!(
                        "dismissed report section proposal {} has inconsistent lifecycle state",
                        proposal.id
                    )));
                }
                validate_stored_body(
                    "report section proposal dismiss reason",
                    proposal.dismiss_reason.as_deref().unwrap_or_default(),
                    MAX_PROPOSAL_DISMISS_REASON_BYTES,
                )?;
            }
            ProposedFindingStatus::Proposed => {
                if proposal.acceptance.is_some()
                    || proposal.dismiss_reason.is_some()
                    || proposal.accepted_section_id.is_some()
                {
                    return Err(CoreError::Message(format!(
                        "proposed report section proposal {} has terminal lifecycle state",
                        proposal.id
                    )));
                }
            }
            ProposedFindingStatus::Superseded => {
                // Superseded is reached only by replacing a previously
                // accepted section. Its acceptance record and former section
                // id remain durable history, but it cannot also be dismissed.
                if proposal.acceptance.is_none()
                    || proposal.accepted_section_id.is_none()
                    || proposal.dismiss_reason.is_some()
                {
                    return Err(CoreError::Message(format!(
                        "superseded report section proposal {} has inconsistent lifecycle state",
                        proposal.id
                    )));
                }
            }
        }
        if let Some(section_id) = proposal.accepted_section_id.as_deref() {
            validate_uuid_v7("report section proposal accepted section id", section_id)?;
        }
    }
    for section in &document.report_sections {
        let Some(proposal_id) = section.accepted_from_proposal_id.as_deref() else {
            continue;
        };
        let origin_is_current = document.proposed_report_sections.iter().any(|proposal| {
            proposal.id == proposal_id
                && proposal.status == ProposedFindingStatus::Accepted
                && proposal.accepted_section_id.as_deref() == Some(section.id.as_str())
        });
        if !origin_is_current {
            return Err(CoreError::Message(format!(
                "report section {} records proposal {} as origin without a matching accepted proposal",
                section.id, proposal_id
            )));
        }
    }
    Ok(())
}

fn validate_stored_report_citations(
    section_evidence_ids: &[String],
    section_finding_ids: &[String],
    section_note_ids: &[String],
    evidence_ids: &HashSet<&str>,
    finding_ids: &HashSet<&str>,
    note_ids: &HashSet<&str>,
) -> CoreResult<()> {
    let total = section_evidence_ids
        .len()
        .checked_add(section_finding_ids.len())
        .and_then(|total| total.checked_add(section_note_ids.len()))
        .ok_or_else(|| CoreError::Message("report section citation count overflow".into()))?;
    if total > MAX_REPORT_SECTION_CITATIONS {
        return Err(CoreError::Message(format!(
            "report section exceeds {MAX_REPORT_SECTION_CITATIONS} citations"
        )));
    }
    validate_report_citation_list(
        "report section evidence",
        section_evidence_ids,
        evidence_ids,
    )?;
    validate_report_citation_list("report section finding", section_finding_ids, finding_ids)?;
    validate_report_citation_list("report section note", section_note_ids, note_ids)?;
    Ok(())
}

/// Locate the report section proposal with the given idempotency key (any status).
pub fn find_report_section_proposal_by_idempotency_key<'a>(
    document: &'a InvestigationDocument,
    key: &str,
) -> Option<&'a ProposedReportSectionItem> {
    document
        .proposed_report_sections
        .iter()
        .find(|p| p.idempotency_key == key)
}

// ---------------------------------------------------------------------------
// Versioned report projection (assembly is pure; it never mutates anything).
// ---------------------------------------------------------------------------

/// Current-policy identity captured by the caller at assembly time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportCurrentPolicy {
    /// Current suppression sidecar revision.
    pub suppression_policy_revision: u64,
    /// Current template-analysis revision.
    pub resolved_template_revision: u64,
    /// Current payload-free identity of the effective suppression policy.
    pub effective_policy_sha256: String,
    /// Exact noise lens used to resolve finding policy-binding status.
    pub noise_lens: Option<InvestigationNoiseLens>,
}

/// Inclusive evidence time window derived only from durable evidence refs.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportTimeWindow {
    /// Minimum persisted timestamp/order hint.
    pub min_timestamp_hint: i64,
    /// Maximum persisted timestamp/order hint.
    pub max_timestamp_hint: i64,
    /// True when any cited reference is not uniform wall-clock quality.
    pub mixed_quality: bool,
}

/// Report scope: corpora, item counts, and the honest evidence time window.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportScope {
    /// Linked corpus identifiers, sorted for determinism.
    pub corpus_ids: Vec<String>,
    /// Number of durable evidence items.
    pub evidence_count: usize,
    /// Number of durable findings.
    pub finding_count: usize,
    /// Number of durable notes.
    pub note_count: usize,
    /// Evidence time window, absent when no exact references exist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_window: Option<ReportTimeWindow>,
}

/// One authored section carried into the projection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportAuthoredSection {
    /// Durable section id.
    pub section_id: String,
    /// Redacted canonical body.
    pub body: String,
    /// Cited evidence ids.
    pub evidence_ids: Vec<String>,
    /// Cited finding ids.
    pub finding_ids: Vec<String>,
    /// Cited note ids.
    pub note_ids: Vec<String>,
    /// Proposal this section was accepted from, when applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_from_proposal_id: Option<String>,
    /// Privacy-safe model/detector provenance retained from the accepted
    /// proposal so a standalone report does not erase its agent origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_proposal_provenance: Option<ProposalProvenance>,
    /// Human acceptance record for the accepted proposal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_proposal_acceptance: Option<HumanProposalAcceptance>,
    /// Last update time as Unix seconds.
    pub updated_at: i64,
}

/// Authored sections in fixed order; `None` renders an explicit
/// not-authored marker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportSections {
    /// Executive summary, when authored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executive_summary: Option<ReportAuthoredSection>,
    /// Unresolved questions, when authored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unresolved_questions: Option<ReportAuthoredSection>,
    /// Next actions, when authored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_actions: Option<ReportAuthoredSection>,
}

/// One exact event identity plus its current resolution status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportEventReference {
    /// Corpus that owns the sequence.
    pub corpus_id: String,
    /// Stable event sequence.
    pub seq: u64,
    /// Relative source identity.
    pub source: String,
    /// Persisted timestamp/order hint.
    pub timestamp_hint: i64,
    /// Persisted time-quality hint.
    pub time_quality_hint: TimeQuality,
    /// Current authoritative resolution status.
    pub status: EvidenceReferenceStatus,
}

/// One evidence citation on a finding, with per-reference statuses.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportFindingCitation {
    /// Durable evidence id.
    pub evidence_id: String,
    /// Redacted evidence title.
    pub evidence_title: String,
    /// Exact references with current statuses, in saved order.
    pub references: Vec<ReportEventReference>,
}

/// One durable finding carried into the projection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportFindingEntry {
    /// Durable finding id.
    pub finding_id: String,
    /// Epistemic kind.
    pub kind: FindingKind,
    /// Human-controlled lifecycle.
    pub lifecycle: FindingLifecycle,
    /// Redacted title.
    pub title: String,
    /// Redacted rationale.
    pub why_it_matters: String,
    /// Stable snake_case policy-binding status string.
    pub policy_binding_status: String,
    /// True when a durable saved-view recipe is attached.
    pub has_saved_view: bool,
    /// Evidence citations with per-reference statuses.
    pub citations: Vec<ReportFindingCitation>,
    /// Creation time as Unix seconds (stable sort key).
    pub created_at: i64,
}

/// One bounded timeline entry: exact identity plus evidence context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportTimelineEntry {
    /// Corpus that owns the sequence.
    pub corpus_id: String,
    /// Stable event sequence.
    pub seq: u64,
    /// Relative source identity.
    pub source: String,
    /// Persisted timestamp/order hint.
    pub timestamp_hint: i64,
    /// Persisted time-quality hint.
    pub time_quality_hint: TimeQuality,
    /// Evidence item that cites this reference.
    pub evidence_id: String,
    /// Redacted evidence title.
    pub evidence_title: String,
    /// Current authoritative resolution status.
    pub status: EvidenceReferenceStatus,
}

/// Bounded evidence-backed timeline with an explicit omitted count.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReportTimeline {
    /// Bounded entries in deterministic (timestamp, seq, corpus) order.
    pub entries: Vec<ReportTimelineEntry>,
    /// Number of references omitted by the bound.
    pub omitted_count: usize,
}

/// Versioned, payload-free investigation report projection.
///
/// Proposals — open or dismissed — never appear anywhere in this projection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InvestigationReport {
    /// Report projection schema version ([`INVESTIGATION_REPORT_SCHEMA_VERSION`]).
    pub schema_version: u32,
    /// Investigation identifier.
    pub investigation_id: String,
    /// Redacted investigation title.
    pub title: String,
    /// Investigation lifecycle state.
    pub status: InvestigationStatus,
    /// Document revision this projection was assembled from.
    pub source_revision: u64,
    /// Caller-supplied assembly time as Unix seconds (deterministic input).
    pub generated_at: i64,
    /// Current-policy identity, when the caller captured one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_policy: Option<ReportCurrentPolicy>,
    /// Scope: corpora, item counts, and the honest evidence time window.
    pub scope: ReportScope,
    /// Authored sections or explicit not-authored markers.
    pub sections: ReportSections,
    /// Durable findings sorted by (created_at, id).
    pub findings: Vec<ReportFindingEntry>,
    /// Bounded evidence-backed timeline.
    pub timeline: ReportTimeline,
}

fn policy_binding_status_str(status: InvestigationPolicyBindingStatus) -> &'static str {
    match status {
        InvestigationPolicyBindingStatus::UnboundLegacy => "unbound_legacy",
        InvestigationPolicyBindingStatus::Current => "current",
        InvestigationPolicyBindingStatus::MadeUnderDifferentPolicy => "made_under_different_policy",
        InvestigationPolicyBindingStatus::MadeUnderDifferentLens => "made_under_different_lens",
        InvestigationPolicyBindingStatus::CurrentLensUnknown => "current_lens_unknown",
    }
}

fn authored_section(
    document: &InvestigationDocument,
    kind: ReportSectionKind,
) -> Option<ReportAuthoredSection> {
    document
        .report_sections
        .iter()
        .find(|section| section.kind == kind)
        .map(|section| {
            let accepted_proposal =
                section
                    .accepted_from_proposal_id
                    .as_deref()
                    .and_then(|proposal_id| {
                        document
                            .proposed_report_sections
                            .iter()
                            .find(|proposal| proposal.id == proposal_id)
                    });
            ReportAuthoredSection {
                section_id: section.id.clone(),
                body: section.body.clone(),
                evidence_ids: section.evidence_ids.clone(),
                finding_ids: section.finding_ids.clone(),
                note_ids: section.note_ids.clone(),
                accepted_from_proposal_id: section.accepted_from_proposal_id.clone(),
                accepted_proposal_provenance: accepted_proposal
                    .map(|proposal| proposal.provenance.clone()),
                accepted_proposal_acceptance: accepted_proposal
                    .and_then(|proposal| proposal.acceptance.clone()),
                updated_at: section.updated_at,
            }
        })
}

/// Assemble the versioned report projection from an already-resolved document.
///
/// Pure and deterministic for identical inputs: findings sort by
/// `(created_at, id)`; the timeline sorts by `(timestamp_hint, seq, corpus_id,
/// evidence_id)` and is bounded with an explicit omitted count. Implements the
/// INVESTIGATION_LOOP.md §6.6 rules: accepted findings and their citations are
/// selected, current evidence statuses are carried per reference, kinds are
/// marked, source identities and time-quality limits are explicit, dismissed
/// and open proposals never appear, stale/missing references stay visible,
/// saved-view presence is retained as a flag, and nothing is mutated.
///
/// The report's current-policy header comes from `resolved.resolution_policy`
/// — the single snapshot the finding statuses were computed against. There is
/// deliberately no way to pass a different snapshot: one resolution, one
/// policy identity, no second read that could disagree.
pub fn assemble_investigation_report(
    resolved: &ResolvedInvestigationDocument,
    generated_at: i64,
) -> InvestigationReport {
    let document = &resolved.document;

    let mut corpus_ids: Vec<String> = document
        .corpus_links
        .iter()
        .map(|link| link.corpus_id.clone())
        .collect();
    corpus_ids.sort();

    let mut min_hint: Option<i64> = None;
    let mut max_hint: Option<i64> = None;
    let mut mixed_quality = false;
    for item in &document.evidence {
        for event_ref in &item.event_refs {
            min_hint = Some(min_hint.map_or(event_ref.timestamp_hint, |current| {
                current.min(event_ref.timestamp_hint)
            }));
            max_hint = Some(max_hint.map_or(event_ref.timestamp_hint, |current| {
                current.max(event_ref.timestamp_hint)
            }));
            if event_ref.time_quality_hint != TimeQuality::Wall {
                mixed_quality = true;
            }
        }
    }
    let time_window = match (min_hint, max_hint) {
        (Some(min_timestamp_hint), Some(max_timestamp_hint)) => Some(ReportTimeWindow {
            min_timestamp_hint,
            max_timestamp_hint,
            mixed_quality,
        }),
        _ => None,
    };

    let resolved_by_id: HashMap<&str, &ResolvedEvidenceItem> = resolved
        .evidence
        .iter()
        .map(|item| (item.item.id.as_str(), item))
        .collect();

    let mut findings: Vec<ReportFindingEntry> = resolved
        .findings
        .iter()
        .map(|finding| {
            let citations = finding
                .item
                .evidence_ids
                .iter()
                .map(
                    |evidence_id| match resolved_by_id.get(evidence_id.as_str()) {
                        Some(resolved_item) => ReportFindingCitation {
                            evidence_id: evidence_id.clone(),
                            evidence_title: resolved_item.item.title.clone(),
                            references: resolved_item
                                .references
                                .iter()
                                .map(|reference| ReportEventReference {
                                    corpus_id: reference.event_ref.corpus_id.clone(),
                                    seq: reference.event_ref.seq,
                                    source: reference.event_ref.source.clone(),
                                    timestamp_hint: reference.event_ref.timestamp_hint,
                                    time_quality_hint: reference.event_ref.time_quality_hint,
                                    status: reference.status,
                                })
                                .collect(),
                        },
                        None => ReportFindingCitation {
                            evidence_id: evidence_id.clone(),
                            evidence_title: "(unknown evidence)".into(),
                            references: Vec::new(),
                        },
                    },
                )
                .collect();
            ReportFindingEntry {
                finding_id: finding.item.id.clone(),
                kind: finding.item.kind,
                lifecycle: finding.item.lifecycle,
                title: finding.item.title.clone(),
                why_it_matters: finding.item.why_it_matters.clone(),
                policy_binding_status: policy_binding_status_str(finding.policy_binding.status)
                    .to_string(),
                has_saved_view: finding.item.view_recipe.is_some(),
                citations,
                created_at: finding.item.created_at,
            }
        })
        .collect();
    findings.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.finding_id.cmp(&right.finding_id))
    });

    let mut timeline_entries: Vec<ReportTimelineEntry> = resolved
        .evidence
        .iter()
        .flat_map(|item| {
            item.references.iter().map(|reference| ReportTimelineEntry {
                corpus_id: reference.event_ref.corpus_id.clone(),
                seq: reference.event_ref.seq,
                source: reference.event_ref.source.clone(),
                timestamp_hint: reference.event_ref.timestamp_hint,
                time_quality_hint: reference.event_ref.time_quality_hint,
                evidence_id: item.item.id.clone(),
                evidence_title: item.item.title.clone(),
                status: reference.status,
            })
        })
        .collect();
    timeline_entries.sort_by(|left, right| {
        left.timestamp_hint
            .cmp(&right.timestamp_hint)
            .then_with(|| left.seq.cmp(&right.seq))
            .then_with(|| left.corpus_id.cmp(&right.corpus_id))
            .then_with(|| left.evidence_id.cmp(&right.evidence_id))
    });
    let total = timeline_entries.len();
    timeline_entries.truncate(MAX_REPORT_TIMELINE_ENTRIES);
    let omitted_count = total.saturating_sub(timeline_entries.len());

    InvestigationReport {
        schema_version: INVESTIGATION_REPORT_SCHEMA_VERSION,
        investigation_id: document.id.clone(),
        title: document.title.clone(),
        status: document.status,
        source_revision: document.revision,
        generated_at,
        current_policy: resolved
            .resolution_policy
            .as_ref()
            .map(|policy| ReportCurrentPolicy {
                suppression_policy_revision: policy.suppression_policy_revision,
                resolved_template_revision: policy.resolved_template_revision,
                effective_policy_sha256: policy.effective_policy_sha256.clone(),
                noise_lens: resolved.resolution_noise_lens,
            }),
        scope: ReportScope {
            corpus_ids,
            evidence_count: document.evidence.len(),
            finding_count: document.findings.len(),
            note_count: document.notes.len(),
            time_window,
        },
        sections: ReportSections {
            executive_summary: authored_section(document, ReportSectionKind::ExecutiveSummary),
            unresolved_questions: authored_section(
                document,
                ReportSectionKind::UnresolvedQuestions,
            ),
            next_actions: authored_section(document, ReportSectionKind::NextActions),
        },
        findings,
        timeline: ReportTimeline {
            entries: timeline_entries,
            omitted_count,
        },
    }
}

// ---------------------------------------------------------------------------
// Deterministic markdown rendering.
// ---------------------------------------------------------------------------

/// Marker rendered for a verified exact reference.
pub const REPORT_MARKER_VERIFIED: &str = "[verified]";
/// Marker rendered for a missing exact reference.
pub const REPORT_MARKER_MISSING: &str = "[missing]";
/// Marker rendered for a stale exact reference.
pub const REPORT_MARKER_STALE: &str = "[stale]";
/// Placeholder rendered for a section that has not been authored.
pub const REPORT_NOT_AUTHORED: &str = "_Not authored._";

fn status_marker(status: EvidenceReferenceStatus) -> &'static str {
    match status {
        EvidenceReferenceStatus::Verified => REPORT_MARKER_VERIFIED,
        EvidenceReferenceStatus::Missing => REPORT_MARKER_MISSING,
        EvidenceReferenceStatus::Stale => REPORT_MARKER_STALE,
    }
}

fn investigation_status_str(status: InvestigationStatus) -> &'static str {
    match status {
        InvestigationStatus::Active => "active",
        InvestigationStatus::Archived => "archived",
    }
}

fn finding_kind_str(kind: FindingKind) -> &'static str {
    match kind {
        FindingKind::Observation => "observation",
        FindingKind::Inference => "inference",
        FindingKind::Hypothesis => "hypothesis",
    }
}

fn finding_lifecycle_str(lifecycle: FindingLifecycle) -> &'static str {
    match lifecycle {
        FindingLifecycle::Accepted => "accepted",
        FindingLifecycle::Resolved => "resolved",
    }
}

/// Short display identity: UUIDs render as their first eight characters so the
/// high-entropy scrubber can never mangle rendered ids; other identifiers pass
/// through (and remain subject to the final scrub).
fn display_id(id: &str) -> &str {
    if Uuid::parse_str(id).is_ok() {
        id.get(..8).unwrap_or(id)
    } else {
        id
    }
}

fn fmt_unix_wall(secs: i64) -> String {
    match chrono::DateTime::from_timestamp(secs, 0) {
        Some(datetime) => datetime.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        None => format!("unix:{secs}"),
    }
}

fn fmt_hint(hint: i64, quality: TimeQuality) -> String {
    match quality {
        TimeQuality::Wall => fmt_unix_wall(hint),
        other => format!("order {hint} ({})", other.label()),
    }
}

fn push_reference_line(out: &mut String, reference: &ReportEventReference) {
    out.push_str(&format!(
        "  - {} seq={} · source={} · {}\n",
        status_marker(reference.status),
        reference.seq,
        reference.source,
        fmt_hint(reference.timestamp_hint, reference.time_quality_hint),
    ));
}

fn push_citation_summary(out: &mut String, section: &ReportAuthoredSection) {
    let mut groups: Vec<String> = Vec::new();
    if !section.evidence_ids.is_empty() {
        let ids: Vec<&str> = section
            .evidence_ids
            .iter()
            .map(|id| display_id(id))
            .collect();
        groups.push(format!("evidence {}", ids.join(", ")));
    }
    if !section.finding_ids.is_empty() {
        let ids: Vec<&str> = section
            .finding_ids
            .iter()
            .map(|id| display_id(id))
            .collect();
        groups.push(format!("findings {}", ids.join(", ")));
    }
    if !section.note_ids.is_empty() {
        let ids: Vec<&str> = section.note_ids.iter().map(|id| display_id(id)).collect();
        groups.push(format!("notes {}", ids.join(", ")));
    }
    if !groups.is_empty() {
        out.push_str(&format!("_Citations: {}_\n\n", groups.join(" · ")));
    }
}

fn proposal_source_kind_str(source: ProposalSourceKind) -> &'static str {
    match source {
        ProposalSourceKind::Model => "model",
        ProposalSourceKind::Detector => "detector",
        ProposalSourceKind::Internal => "internal",
    }
}

fn push_accepted_proposal_origin(out: &mut String, section: &ReportAuthoredSection) {
    let (Some(proposal_id), Some(provenance), Some(acceptance)) = (
        section.accepted_from_proposal_id.as_deref(),
        section.accepted_proposal_provenance.as_ref(),
        section.accepted_proposal_acceptance.as_ref(),
    ) else {
        return;
    };
    let mut details = vec![
        format!(
            "human accepted {} proposal {}",
            proposal_source_kind_str(provenance.source),
            display_id(proposal_id)
        ),
        format!("tool {}", provenance.tool_name),
        format!("accepted {}", fmt_unix_wall(acceptance.accepted_at)),
        format!("edited {}", if acceptance.edited { "yes" } else { "no" }),
    ];
    if let Some(provider) = provenance.provider.as_deref() {
        details.push(format!("provider {provider}"));
    }
    if let Some(model_id) = provenance.model_id.as_deref() {
        details.push(format!("model {model_id}"));
    }
    if let Some(detector_id) = provenance.detector_id.as_deref() {
        details.push(format!("detector {detector_id}"));
    }
    if let Some(run_id) = provenance.run_id.as_deref() {
        details.push(format!("run {run_id}"));
    }
    out.push_str(&format!("_Origin: {}._\n\n", details.join(" · ")));
}

fn push_authored_section(out: &mut String, section: Option<&ReportAuthoredSection>) {
    match section {
        Some(section) => {
            out.push_str(&section.body);
            out.push_str("\n\n");
            push_accepted_proposal_origin(out, section);
            push_citation_summary(out, section);
        }
        None => {
            out.push_str(REPORT_NOT_AUTHORED);
            out.push_str("\n\n");
        }
    }
}

fn push_finding_block(out: &mut String, finding: &ReportFindingEntry) {
    out.push_str(&format!("### {}\n\n", finding.title));
    out.push_str(&format!("- Kind: {}\n", finding_kind_str(finding.kind)));
    out.push_str(&format!(
        "- Lifecycle: {}\n",
        finding_lifecycle_str(finding.lifecycle)
    ));
    out.push_str(&format!(
        "- Policy binding: {}\n",
        finding.policy_binding_status
    ));
    out.push_str(&format!(
        "- Saved view attached: {}\n\n",
        if finding.has_saved_view { "yes" } else { "no" }
    ));
    out.push_str(&finding.why_it_matters);
    out.push_str("\n\n");
    if finding.citations.is_empty() {
        out.push_str("_No evidence citations._\n\n");
        return;
    }
    out.push_str("Evidence:\n");
    for citation in &finding.citations {
        out.push_str(&format!(
            "- {} (evidence {})\n",
            citation.evidence_title,
            display_id(&citation.evidence_id)
        ));
        for reference in &citation.references {
            push_reference_line(out, reference);
        }
    }
    out.push('\n');
}

/// Render the assembled report as deterministic markdown.
///
/// Fixed section order: Incident scope & window, Executive summary, Accepted
/// findings, Evidence-backed timeline, Hypotheses & alternatives, Unresolved
/// questions, Next actions. Only exact identities appear — never event
/// payloads or message text. The final text is passed through
/// [`crate::redact::scrub_secrets`] as defense in depth, and that scrub is a
/// fixed point: rendering already-rendered content changes nothing.
pub fn render_investigation_report_markdown(report: &InvestigationReport) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Investigation report: {}\n\n", report.title));
    out.push_str(&format!(
        "- Report schema version: {}\n",
        report.schema_version
    ));
    out.push_str(&format!(
        "- Investigation: {} ({})\n",
        display_id(&report.investigation_id),
        investigation_status_str(report.status)
    ));
    out.push_str(&format!("- Source revision: {}\n", report.source_revision));
    let corpora = if report.scope.corpus_ids.is_empty() {
        "(none)".to_string()
    } else {
        report
            .scope
            .corpus_ids
            .iter()
            .map(|id| display_id(id))
            .collect::<Vec<_>>()
            .join(", ")
    };
    out.push_str(&format!("- Corpora: {corpora}\n"));
    out.push_str(&format!(
        "- Generated at: {}\n",
        fmt_unix_wall(report.generated_at)
    ));
    match &report.current_policy {
        Some(policy) => {
            let sha_prefix = policy
                .effective_policy_sha256
                .get(..12)
                .unwrap_or(policy.effective_policy_sha256.as_str());
            out.push_str(&format!(
                "- Current noise policy: sidecar r{}, template r{}, lens {}, sha {sha_prefix}…\n",
                policy.suppression_policy_revision,
                policy.resolved_template_revision,
                match policy.noise_lens {
                    Some(InvestigationNoiseLens::Active) => "active",
                    Some(InvestigationNoiseLens::Suspended) => "suspended",
                    None => "unknown",
                }
            ));
        }
        None => out.push_str("- Current noise policy: not captured at assembly\n"),
    }
    out.push('\n');

    out.push_str("## Incident scope & window\n\n");
    out.push_str(&format!(
        "- Evidence items: {}\n",
        report.scope.evidence_count
    ));
    out.push_str(&format!("- Findings: {}\n", report.scope.finding_count));
    out.push_str(&format!("- Notes: {}\n", report.scope.note_count));
    match &report.scope.time_window {
        None => out.push_str("- Time window: no exact evidence references\n"),
        Some(window) if window.mixed_quality => {
            out.push_str(&format!(
                "- Time window: hints {} → {} (mixed time quality; not uniform calendar time)\n",
                window.min_timestamp_hint, window.max_timestamp_hint
            ));
        }
        Some(window) => {
            out.push_str(&format!(
                "- Time window: {} → {}\n",
                fmt_unix_wall(window.min_timestamp_hint),
                fmt_unix_wall(window.max_timestamp_hint)
            ));
        }
    }
    out.push('\n');

    out.push_str("## Executive summary\n\n");
    push_authored_section(&mut out, report.sections.executive_summary.as_ref());

    out.push_str("## Accepted findings\n\n");
    let accepted: Vec<&ReportFindingEntry> = report
        .findings
        .iter()
        .filter(|finding| finding.kind != FindingKind::Hypothesis)
        .collect();
    if accepted.is_empty() {
        out.push_str("_No accepted findings._\n\n");
    } else {
        for finding in accepted {
            push_finding_block(&mut out, finding);
        }
    }

    out.push_str("## Evidence-backed timeline\n\n");
    if report.timeline.entries.is_empty() {
        out.push_str("_No exact evidence references._\n\n");
    } else {
        for entry in &report.timeline.entries {
            out.push_str(&format!(
                "- {} {} · seq={} · source={} · corpus {} · evidence: {}\n",
                status_marker(entry.status),
                fmt_hint(entry.timestamp_hint, entry.time_quality_hint),
                entry.seq,
                entry.source,
                display_id(&entry.corpus_id),
                entry.evidence_title,
            ));
        }
        // Bounded ordering claim: entries sort by stored hint, and a hint is
        // only calendar time for wall-clock references. When the timeline
        // mixes qualities the cross-quality order is a storage artifact, and
        // the render says so instead of implying an established sequence.
        let has_wall = report
            .timeline
            .entries
            .iter()
            .any(|entry| entry.time_quality_hint == TimeQuality::Wall);
        let has_non_wall = report
            .timeline
            .entries
            .iter()
            .any(|entry| entry.time_quality_hint != TimeQuality::Wall);
        if has_wall && has_non_wall {
            out.push_str(
                "\n_Entries mix wall-clock and order-only references; \
cross-quality order is by stored hint, not established time._\n",
            );
        }
        if report.timeline.omitted_count > 0 {
            out.push_str(&format!(
                "\n_{} timeline entries omitted (bounded render)._\n",
                report.timeline.omitted_count
            ));
        }
        out.push('\n');
    }

    out.push_str("## Hypotheses & alternatives\n\n");
    let hypotheses: Vec<&ReportFindingEntry> = report
        .findings
        .iter()
        .filter(|finding| finding.kind == FindingKind::Hypothesis)
        .collect();
    if hypotheses.is_empty() {
        out.push_str("_No hypotheses recorded._\n\n");
    } else {
        for finding in hypotheses {
            push_finding_block(&mut out, finding);
        }
    }

    out.push_str("## Unresolved questions\n\n");
    push_authored_section(&mut out, report.sections.unresolved_questions.as_ref());

    out.push_str("## Next actions\n\n");
    push_authored_section(&mut out, report.sections.next_actions.as_ref());

    crate::redact::scrub_secrets(&out)
}

// ---------------------------------------------------------------------------
// SoftWrite tool surface (host wiring lands separately).
// ---------------------------------------------------------------------------

/// Compact SoftWrite tool spec for linked tools-enabled chat.
pub fn propose_report_section_tool_spec() -> crate::tools::ToolSpec {
    use crate::tools::{ToolSideEffect, ToolSpec};
    use serde_json::json;
    ToolSpec {
        name: PROPOSE_REPORT_SECTION_TOOL.into(),
        description: "Propose one investigation report section (executive_summary, \
unresolved_questions, or next_actions) for human review on the linked Investigation. \
Creates only a Proposed item — never authored report content, never Explorer mutation. \
Citations must reference already-saved evidence, finding, or note ids from the same \
investigation. SoftWrite: durable proposal queue only. Provenance is host-authored \
(source=Model, tool_name=propose_report_section); do not supply provenance."
            .into(),
        side_effect: ToolSideEffect::SoftWrite,
        parameters: json!({
            "type": "object",
            "properties": {
                "investigation_id": { "type": "string", "description": "Must match host-selected active Investigation when supplied; host binding is authoritative" },
                "expected_revision": { "type": "integer", "minimum": 1, "description": "Required. The investigation revision this proposal was reasoned against; a stale revision fails closed before any write" },
                "idempotency_key": { "type": "string", "maxLength": 128 },
                "kind": { "type": "string", "enum": ["executive_summary", "unresolved_questions", "next_actions"] },
                "body": { "type": "string", "maxLength": 16384 },
                "evidence_ids": { "type": "array", "maxItems": 256, "items": { "type": "string" } },
                "finding_ids": { "type": "array", "maxItems": 256, "items": { "type": "string" } },
                "note_ids": { "type": "array", "maxItems": 256, "items": { "type": "string" } }
            },
            "required": ["expected_revision", "idempotency_key", "kind", "body"],
            "additionalProperties": false
        }),
    }
}

fn parse_report_section_kind(value: &str) -> CoreResult<ReportSectionKind> {
    match value {
        "executive_summary" => Ok(ReportSectionKind::ExecutiveSummary),
        "unresolved_questions" => Ok(ReportSectionKind::UnresolvedQuestions),
        "next_actions" => Ok(ReportSectionKind::NextActions),
        other => Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            format!(
                "kind must be executive_summary|unresolved_questions|next_actions, got {other:?}"
            ),
        )),
    }
}

fn parse_id_array(args: &Value, field: &str) -> CoreResult<Vec<String>> {
    match args.get(field) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item.as_str() {
                    Some(id) => out.push(id.to_string()),
                    None => {
                        return Err(propose_repair_error(
                            ProposeFindingErrorCode::InvalidInput,
                            format!("{field} entries must be strings"),
                        ))
                    }
                }
            }
            Ok(out)
        }
        Some(_) => Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            format!("{field} must be an array of strings"),
        )),
    }
}

/// Parse propose tool arguments into [`ProposeReportSectionInput`] without
/// trusting model provenance. The caller **must** set `provenance` via
/// [`host_model_report_section_provenance`] (tool path) or an internal
/// host-authored value. `investigation_id` is host-resolved before this call;
/// tool JSON `investigation_id` is not used. `expected_revision` is the
/// model-supplied pin the tool host extracts and hard-requires (the tool
/// schema declares it required); the store re-validates it against the durable
/// revision and fails closed on drift — the host never substitutes its own
/// current-revision read.
pub fn propose_report_section_input_from_tool_args(
    args: &Value,
    investigation_id: String,
    expected_revision: u64,
    provenance: ProposalProvenance,
) -> CoreResult<ProposeReportSectionInput> {
    let idempotency_key = args
        .get("idempotency_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                "idempotency_key is required",
            )
        })?
        .to_string();
    let kind = parse_report_section_kind(args.get("kind").and_then(|v| v.as_str()).unwrap_or(""))?;
    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            propose_repair_error(ProposeFindingErrorCode::InvalidInput, "body is required")
        })?
        .to_string();
    let evidence_ids = parse_id_array(args, "evidence_ids")?;
    let finding_ids = parse_id_array(args, "finding_ids")?;
    let note_ids = parse_id_array(args, "note_ids")?;
    // Ignore any model-supplied provenance object entirely.
    let _ = args.get("provenance");
    Ok(ProposeReportSectionInput {
        investigation_id,
        expected_revision,
        idempotency_key,
        kind,
        body,
        evidence_ids,
        finding_ids,
        note_ids,
        provenance,
    })
}

/// Host-authored Model provenance for the report-section SoftWrite tool path.
///
/// Forces `source=Model` and `tool_name=propose_report_section`. Model-supplied
/// provenance fields in tool arguments are ignored by the tool host.
pub fn host_model_report_section_provenance(
    ctx: &TrustedModelProposeContext,
) -> CoreResult<ProposalProvenance> {
    proposed::sanitize_provenance(ProposalProvenance {
        source: ProposalSourceKind::Model,
        provider: ctx.provider.clone(),
        model_id: ctx.model_id.clone(),
        run_id: ctx.run_id.clone(),
        tool_name: PROPOSE_REPORT_SECTION_TOOL.into(),
        detector_id: None,
    })
}

/// Dedicated SoftWrite permission preview for `propose_report_section`.
///
/// Not the durable-memory formatter. Bounded, redacted, Proposed-only.
pub fn propose_report_section_permission_preview(
    args: &Value,
    host_investigation_id: Option<&str>,
) -> String {
    let inv = host_investigation_id
        .or_else(|| args.get("investigation_id").and_then(|v| v.as_str()))
        .unwrap_or("(host investigation required)");
    let kind = args.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
    let body = args
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("(missing body)");
    let body = crate::redact::redact_candidate(body).text;
    let body = crate::text::truncate_bytes(&body, 400);
    let count = |field: &str| {
        args.get(field)
            .and_then(|v| v.as_array())
            .map_or(0, |items| items.len())
    };
    let evidence_count = count("evidence_ids");
    let finding_count = count("finding_ids");
    let note_count = count("note_ids");
    format!(
        "--- propose_report_section (SoftWrite) ---\n\
         outcome: Proposed report section only — never authored report content, never Explorer mutation\n\
         investigation: {inv}\n\
         kind: {kind}\n\
         body: {body}\n\
         citations: evidence {evidence_count} · findings {finding_count} · notes {note_count}\n\
         Accept creates a durable Proposed report section for human review (Accept / Edit-and-accept / Dismiss)."
    )
}

#[cfg(test)]
mod tests {
    use super::super::tests::{
        event_ref, evidence_corpus, finding_input, note_input, publish_policy_preview,
        selected_refs, PAYLOAD_SENTINEL,
    };
    use super::*;
    use crate::log_analysis::{ActiveTimestampBasis, LogEvent, TimestampProvenance};

    fn report_provenance() -> ProposalProvenance {
        ProposalProvenance {
            source: ProposalSourceKind::Detector,
            provider: None,
            model_id: None,
            run_id: Some("run-report-1".into()),
            tool_name: PROPOSE_REPORT_SECTION_TOOL.into(),
            detector_id: Some("report-detector-v1".into()),
        }
    }

    fn propose_input(
        investigation_id: &str,
        revision: u64,
        kind: ReportSectionKind,
        body: &str,
    ) -> ProposeReportSectionInput {
        ProposeReportSectionInput {
            investigation_id: investigation_id.into(),
            expected_revision: revision,
            idempotency_key: "report-key-1".into(),
            kind,
            body: body.into(),
            evidence_ids: Vec::new(),
            finding_ids: Vec::new(),
            note_ids: Vec::new(),
            provenance: report_provenance(),
        }
    }

    fn set_input(kind: ReportSectionKind, body: &str) -> SetReportSectionInput {
        SetReportSectionInput {
            kind,
            body: body.into(),
            evidence_ids: Vec::new(),
            finding_ids: Vec::new(),
            note_ids: Vec::new(),
        }
    }

    /// Recursive (name, bytes) snapshot of a store directory in sorted order.
    fn snapshot_directory(root: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, Vec<u8>)>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir)
                .unwrap()
                .map(|entry| entry.unwrap())
                .collect();
            entries.sort_by_key(std::fs::DirEntry::file_name);
            for entry in entries {
                let path = entry.path();
                let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
                if path.is_dir() {
                    walk(&path, &name, out);
                } else {
                    out.push((name, std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(root, "", &mut out);
        out
    }

    #[test]
    fn report_section_set_assemble_render_lifecycle_and_edit_idempotency() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Report lifecycle", &corpus).unwrap();
        let with_finding = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        let finding_id = with_finding.document.findings[0].id.clone();
        let with_note = store
            .add_human_note(
                &document.id,
                with_finding.document.revision,
                &corpus,
                note_input(&corpus, vec![finding_id.clone()], "Report note"),
            )
            .unwrap();
        let evidence_id = with_note.document.evidence[0].id.clone();
        let note_id = with_note.document.notes[0].id.clone();

        let saved = store
            .set_report_section(
                &document.id,
                with_note.document.revision,
                &corpus,
                SetReportSectionInput {
                    kind: ReportSectionKind::ExecutiveSummary,
                    body: "The checkout failure was bounded by two exact events.".into(),
                    evidence_ids: vec![evidence_id.clone()],
                    finding_ids: vec![finding_id.clone()],
                    note_ids: vec![note_id.clone()],
                },
            )
            .unwrap();
        assert_eq!(saved.document.report_sections.len(), 1);
        let section = &saved.document.report_sections[0];
        assert_eq!(section.kind, ReportSectionKind::ExecutiveSummary);
        assert_eq!(section.provenance, HumanProvenance::Human);
        assert!(section.accepted_from_proposal_id.is_none());
        let section_id = section.id.clone();
        let section_created_at = section.created_at;
        let saved_revision = saved.document.revision;

        // Identical content is idempotent: no new revision.
        let retried = store
            .set_report_section(
                &document.id,
                saved_revision,
                &corpus,
                SetReportSectionInput {
                    kind: ReportSectionKind::ExecutiveSummary,
                    body: "The checkout failure was bounded by two exact events.".into(),
                    evidence_ids: vec![evidence_id.clone()],
                    finding_ids: vec![finding_id.clone()],
                    note_ids: vec![note_id.clone()],
                },
            )
            .unwrap();
        assert_eq!(retried.document.revision, saved_revision);
        assert_eq!(retried.document.report_sections.len(), 1);

        // Assemble + render includes the authored section and explicit
        // not-authored markers for the other kinds.
        let resolved = store.load(&document.id, &corpus).unwrap();
        let report = assemble_investigation_report(&resolved, 1_700_000_600);
        assert_eq!(report.schema_version, INVESTIGATION_REPORT_SCHEMA_VERSION);
        assert_eq!(report.source_revision, saved_revision);
        assert!(report.sections.executive_summary.is_some());
        assert!(report.sections.unresolved_questions.is_none());
        assert!(report.sections.next_actions.is_none());
        let markdown = render_investigation_report_markdown(&report);
        assert!(markdown.contains("## Executive summary"), "{markdown}");
        assert!(
            markdown.contains("The checkout failure was bounded by two exact events."),
            "{markdown}"
        );
        assert!(markdown.contains("_Citations: evidence"), "{markdown}");
        assert_eq!(markdown.matches(REPORT_NOT_AUTHORED).count(), 2);

        // Replacement preserves id and creation time in a new revision.
        let edited = store
            .set_report_section(
                &document.id,
                saved_revision,
                &corpus,
                SetReportSectionInput {
                    kind: ReportSectionKind::ExecutiveSummary,
                    body: "Revised summary after review.".into(),
                    evidence_ids: vec![evidence_id],
                    finding_ids: vec![finding_id],
                    note_ids: vec![note_id],
                },
            )
            .unwrap();
        assert_eq!(edited.document.revision, saved_revision + 1);
        assert_eq!(edited.document.report_sections.len(), 1);
        assert_eq!(edited.document.report_sections[0].id, section_id);
        assert_eq!(
            edited.document.report_sections[0].created_at,
            section_created_at
        );
        assert_eq!(
            edited.document.report_sections[0].body,
            "Revised summary after review."
        );
    }

    #[test]
    fn report_mutations_fail_closed_on_stale_revision() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Stale report", &corpus).unwrap();

        let err = store
            .set_report_section(
                &document.id,
                99,
                &corpus,
                set_input(ReportSectionKind::NextActions, "Rotate the credentials."),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("stale investigation revision"), "{err}");

        let err = store
            .propose_report_section(
                &corpus,
                propose_input(
                    &document.id,
                    99,
                    ReportSectionKind::ExecutiveSummary,
                    "Proposed.",
                ),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("stale_revision"), "{err}");

        // Document unchanged on disk after both failures.
        let loaded = store.load(&document.id, &corpus).unwrap();
        assert_eq!(loaded.document.revision, 1);
        assert!(loaded.document.report_sections.is_empty());
        assert!(loaded.document.proposed_report_sections.is_empty());

        let proposed = store
            .propose_report_section(
                &corpus,
                propose_input(
                    &document.id,
                    1,
                    ReportSectionKind::ExecutiveSummary,
                    "Proposed.",
                ),
            )
            .unwrap();
        let proposal_id = proposed.document.proposed_report_sections[0].id.clone();

        let err = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id: proposal_id.clone(),
                    expected_revision: 99,
                    body: None,
                },
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("stale_revision"), "{err}");

        let err = store
            .dismiss_proposed_report_section(
                &corpus,
                &document.id,
                DismissProposedReportSectionInput {
                    proposal_id,
                    expected_revision: 99,
                    reason: "Stale attempt".into(),
                },
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("stale_revision"), "{err}");

        let loaded = store.load(&document.id, &corpus).unwrap();
        assert_eq!(loaded.document.revision, proposed.document.revision);
        assert_eq!(
            loaded.document.proposed_report_sections[0].status,
            ProposedFindingStatus::Proposed
        );
        assert!(loaded.document.report_sections.is_empty());
    }

    #[test]
    fn propose_report_section_idempotent_retry_returns_existing_and_conflicts_on_change() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Idempotent report", &corpus).unwrap();

        let first = store
            .propose_report_section(
                &corpus,
                propose_input(
                    &document.id,
                    1,
                    ReportSectionKind::ExecutiveSummary,
                    "Summary v1.",
                ),
            )
            .unwrap();
        assert_eq!(first.document.revision, 2);
        assert_eq!(first.document.proposed_report_sections.len(), 1);
        let first_id = first.document.proposed_report_sections[0].id.clone();

        let second = store
            .propose_report_section(
                &corpus,
                propose_input(
                    &document.id,
                    first.document.revision,
                    ReportSectionKind::ExecutiveSummary,
                    "Summary v1.",
                ),
            )
            .unwrap();
        assert_eq!(second.document.revision, first.document.revision);
        assert_eq!(second.document.proposed_report_sections.len(), 1);
        assert_eq!(second.document.proposed_report_sections[0].id, first_id);
        let matched =
            find_report_section_proposal_by_idempotency_key(&second.document, "report-key-1")
                .unwrap();
        assert_eq!(matched.id, first_id);

        let err = store
            .propose_report_section(
                &corpus,
                propose_input(
                    &document.id,
                    second.document.revision,
                    ReportSectionKind::ExecutiveSummary,
                    "Different body under the same key.",
                ),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("idempotency_conflict"), "{err}");
        assert!(err.contains(&first_id), "{err}");
    }

    #[test]
    fn report_citations_must_exist_fail_closed() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Citation validation", &corpus).unwrap();

        let missing = Uuid::now_v7().to_string();
        let mut citing_missing_evidence = set_input(ReportSectionKind::ExecutiveSummary, "Body.");
        citing_missing_evidence.evidence_ids = vec![missing.clone()];
        let err = store
            .set_report_section(&document.id, 1, &corpus, citing_missing_evidence)
            .unwrap_err()
            .to_string();
        assert!(err.contains("cites missing id"), "{err}");

        let mut citing_missing_finding = set_input(ReportSectionKind::ExecutiveSummary, "Body.");
        citing_missing_finding.finding_ids = vec![missing.clone()];
        assert!(store
            .set_report_section(&document.id, 1, &corpus, citing_missing_finding)
            .unwrap_err()
            .to_string()
            .contains("cites missing id"));

        let mut citing_missing_note = set_input(ReportSectionKind::ExecutiveSummary, "Body.");
        citing_missing_note.note_ids = vec![missing.clone()];
        assert!(store
            .set_report_section(&document.id, 1, &corpus, citing_missing_note)
            .unwrap_err()
            .to_string()
            .contains("cites missing id"));

        let mut propose_missing =
            propose_input(&document.id, 1, ReportSectionKind::NextActions, "Do it.");
        propose_missing.evidence_ids = vec![missing.clone()];
        let err = store
            .propose_report_section(&corpus, propose_missing)
            .unwrap_err()
            .to_string();
        assert!(err.contains("invalid_input"), "{err}");
        assert!(err.contains("cites missing id"), "{err}");

        // Duplicate citation ids fail closed even when the target exists.
        let with_finding = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        let finding_id = with_finding.document.findings[0].id.clone();
        let mut duplicated = set_input(ReportSectionKind::ExecutiveSummary, "Body.");
        duplicated.finding_ids = vec![finding_id.clone(), finding_id];
        assert!(store
            .set_report_section(
                &document.id,
                with_finding.document.revision,
                &corpus,
                duplicated
            )
            .unwrap_err()
            .to_string()
            .contains("repeats citation"));

        // Shared citation cap across all three lists fails closed.
        let mut over_cap = set_input(ReportSectionKind::ExecutiveSummary, "Body.");
        over_cap.evidence_ids = (0..=MAX_REPORT_SECTION_CITATIONS)
            .map(|_| Uuid::now_v7().to_string())
            .collect();
        assert!(store
            .set_report_section(
                &document.id,
                with_finding.document.revision,
                &corpus,
                over_cap
            )
            .unwrap_err()
            .to_string()
            .contains("citations"));

        // No failed attempt published a revision.
        assert_eq!(
            store.load(&document.id, &corpus).unwrap().document.revision,
            with_finding.document.revision
        );
    }

    #[test]
    fn propose_report_section_wrong_corpus_fails_closed() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let other_cache = tempfile::tempdir().unwrap();
        let other = evidence_corpus(&other_cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Wrong corpus", &corpus).unwrap();

        let err = store
            .propose_report_section(
                &other,
                propose_input(
                    &document.id,
                    1,
                    ReportSectionKind::ExecutiveSummary,
                    "Body.",
                ),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("wrong_corpus"), "{err}");

        let err = store
            .set_report_section(
                &document.id,
                1,
                &other,
                set_input(ReportSectionKind::ExecutiveSummary, "Body."),
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("not linked"), "{err}");
        assert!(store
            .load(&document.id, &corpus)
            .unwrap()
            .document
            .report_sections
            .is_empty());
    }

    #[test]
    fn dismissed_report_proposal_cannot_be_accepted_and_never_assembles() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Dismiss report", &corpus).unwrap();
        let proposed = store
            .propose_report_section(
                &corpus,
                propose_input(
                    &document.id,
                    1,
                    ReportSectionKind::ExecutiveSummary,
                    "Detector-proposed executive summary body.",
                ),
            )
            .unwrap();
        let proposal_id = proposed.document.proposed_report_sections[0].id.clone();
        let original_provenance = proposed.document.proposed_report_sections[0]
            .provenance
            .clone();
        assert_eq!(
            store
                .list_open_report_section_proposals(&document.id)
                .unwrap()
                .len(),
            1
        );

        // Open proposals never appear in the assembled report.
        let resolved = store.load(&document.id, &corpus).unwrap();
        let report = assemble_investigation_report(&resolved, 1_700_000_700);
        assert!(report.sections.executive_summary.is_none());
        let markdown = render_investigation_report_markdown(&report);
        assert!(
            !markdown.contains("Detector-proposed executive summary body."),
            "{markdown}"
        );

        let dismissed = store
            .dismiss_proposed_report_section(
                &corpus,
                &document.id,
                DismissProposedReportSectionInput {
                    proposal_id: proposal_id.clone(),
                    expected_revision: proposed.document.revision,
                    reason: "Not grounded in the saved evidence".into(),
                },
            )
            .unwrap();
        let record = &dismissed.document.proposed_report_sections[0];
        assert_eq!(record.status, ProposedFindingStatus::Dismissed);
        assert_eq!(
            record.dismiss_reason.as_deref(),
            Some("Not grounded in the saved evidence")
        );
        assert_eq!(record.provenance, original_provenance);
        assert!(store
            .list_open_report_section_proposals(&document.id)
            .unwrap()
            .is_empty());

        // A dismissed proposal can never be accepted afterwards.
        let err = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id,
                    expected_revision: dismissed.document.revision,
                    body: None,
                },
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("invalid_lifecycle"), "{err}");

        // Dismissed proposals never appear in the assembled report either.
        let resolved = store.load(&document.id, &corpus).unwrap();
        assert_eq!(resolved.document.report_sections.len(), 0);
        let report = assemble_investigation_report(&resolved, 1_700_000_700);
        assert!(report.sections.executive_summary.is_none());
        let markdown = render_investigation_report_markdown(&report);
        assert!(
            !markdown.contains("Detector-proposed executive summary body."),
            "{markdown}"
        );
        assert!(
            !markdown.contains("Not grounded in the saved evidence"),
            "{markdown}"
        );
    }

    #[test]
    fn accept_creates_section_and_edit_and_accept_preserves_proposal_history() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Accept report", &corpus).unwrap();
        let with_finding = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        let finding_id = with_finding.document.findings[0].id.clone();
        let mut input = propose_input(
            &document.id,
            with_finding.document.revision,
            ReportSectionKind::UnresolvedQuestions,
            "Why did the worker stall before the error boundary?",
        );
        input.provenance = ProposalProvenance {
            source: ProposalSourceKind::Model,
            provider: Some("openai_compatible".into()),
            model_id: Some("incident-model".into()),
            run_id: Some("run-accept-1".into()),
            tool_name: PROPOSE_REPORT_SECTION_TOOL.into(),
            detector_id: None,
        };
        input.finding_ids = vec![finding_id.clone()];
        let proposed = store.propose_report_section(&corpus, input).unwrap();
        let proposal_id = proposed.document.proposed_report_sections[0].id.clone();

        let accepted = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id: proposal_id.clone(),
                    expected_revision: proposed.document.revision,
                    body: Some("Why did the worker stall, and who owns the fix?".into()),
                },
            )
            .unwrap();
        assert_eq!(accepted.document.report_sections.len(), 1);
        let section = &accepted.document.report_sections[0];
        assert_eq!(section.kind, ReportSectionKind::UnresolvedQuestions);
        assert_eq!(
            section.body,
            "Why did the worker stall, and who owns the fix?"
        );
        assert_eq!(section.finding_ids, vec![finding_id]);
        assert_eq!(section.provenance, HumanProvenance::Human);
        assert_eq!(
            section.accepted_from_proposal_id.as_deref(),
            Some(proposal_id.as_str())
        );

        let record = &accepted.document.proposed_report_sections[0];
        assert_eq!(record.status, ProposedFindingStatus::Accepted);
        assert!(record.acceptance.as_ref().unwrap().edited);
        assert_eq!(
            record.accepted_section_id.as_deref(),
            Some(section.id.as_str())
        );
        // Proposal history keeps the original proposed body.
        assert_eq!(
            record.body,
            "Why did the worker stall before the error boundary?"
        );

        // The accepted section assembles and renders.
        let resolved = store.load(&document.id, &corpus).unwrap();
        let report = assemble_investigation_report(&resolved, 1_700_000_800);
        let authored = report.sections.unresolved_questions.as_ref().unwrap();
        assert_eq!(
            authored.accepted_from_proposal_id.as_deref(),
            Some(proposal_id.as_str())
        );
        assert_eq!(
            authored
                .accepted_proposal_provenance
                .as_ref()
                .and_then(|provenance| provenance.model_id.as_deref()),
            Some("incident-model")
        );
        assert!(authored
            .accepted_proposal_acceptance
            .as_ref()
            .is_some_and(|acceptance| acceptance.edited));
        let markdown = render_investigation_report_markdown(&report);
        assert!(
            markdown.contains("Why did the worker stall, and who owns the fix?"),
            "{markdown}"
        );
        assert!(
            markdown.contains("human accepted model proposal")
                && markdown.contains("provider openai_compatible")
                && markdown.contains("model incident-model")
                && markdown.contains("edited yes"),
            "{markdown}"
        );
    }

    #[test]
    fn assemble_and_render_never_mutate_store() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Preview only", &corpus).unwrap();
        let with_finding = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        store
            .set_report_section(
                &document.id,
                with_finding.document.revision,
                &corpus,
                set_input(ReportSectionKind::ExecutiveSummary, "Preview summary."),
            )
            .unwrap();

        let before = snapshot_directory(durable.path());
        let resolved = store.load(&document.id, &corpus).unwrap();
        let report_one = assemble_investigation_report(&resolved, 1_700_000_900);
        let markdown_one = render_investigation_report_markdown(&report_one);
        let report_two = assemble_investigation_report(&resolved, 1_700_000_900);
        let markdown_two = render_investigation_report_markdown(&report_two);
        assert_eq!(report_one, report_two);
        assert_eq!(markdown_one, markdown_two);

        let after = snapshot_directory(durable.path());
        assert_eq!(
            before, after,
            "assembly/render must never write to the store"
        );
        let reloaded = store.load(&document.id, &corpus).unwrap();
        assert_eq!(reloaded.document, resolved.document);
    }

    #[test]
    fn legacy_v5_document_loads_and_assembles_with_not_authored_markers() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Legacy five", &corpus).unwrap();
        let revision_path = durable.path().join(&document.id).join(revision_filename(1));
        let mut legacy = serde_json::to_value(&document).unwrap();
        legacy["schemaVersion"] = serde_json::json!(5);
        legacy.as_object_mut().unwrap().remove("reportSections");
        legacy
            .as_object_mut()
            .unwrap()
            .remove("proposedReportSections");
        let legacy_bytes = serde_json::to_vec_pretty(&legacy).unwrap();
        std::fs::write(&revision_path, &legacy_bytes).unwrap();

        let loaded = store.load(&document.id, &corpus).unwrap();
        assert_eq!(loaded.document.schema_version, 5);
        assert!(loaded.document.report_sections.is_empty());
        assert!(loaded.document.proposed_report_sections.is_empty());
        assert_eq!(std::fs::read(&revision_path).unwrap(), legacy_bytes);

        let report = assemble_investigation_report(&loaded, 1_700_001_000);
        assert!(report.sections.executive_summary.is_none());
        assert!(report.sections.unresolved_questions.is_none());
        assert!(report.sections.next_actions.is_none());
        let markdown = render_investigation_report_markdown(&report);
        assert_eq!(markdown.matches(REPORT_NOT_AUTHORED).count(), 3);

        // First report mutation upgrades the document to the current schema.
        let upgraded = store
            .set_report_section(
                &document.id,
                1,
                &corpus,
                set_input(ReportSectionKind::NextActions, "Rotate the affected key."),
            )
            .unwrap();
        assert_eq!(
            upgraded.document.schema_version,
            INVESTIGATION_SCHEMA_VERSION
        );
        assert_eq!(upgraded.document.revision, 2);
        assert_eq!(std::fs::read(&revision_path).unwrap(), legacy_bytes);
    }

    #[test]
    fn future_schema_document_fails_closed() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Future report schema", &corpus).unwrap();
        let mut future = document.clone();
        future.schema_version = INVESTIGATION_SCHEMA_VERSION + 1;
        future.revision = 2;
        let path = durable.path().join(&document.id).join(revision_filename(2));
        std::fs::write(path, serde_json::to_vec_pretty(&future).unwrap()).unwrap();

        let error = store.load(&document.id, &corpus).unwrap_err().to_string();
        assert!(error.contains("schema version"), "{error}");
        assert!(error.contains("unsupported"), "{error}");
    }

    #[test]
    fn report_render_deterministic_and_marks_verified_missing_stale() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Marker report", &corpus).unwrap();
        let with_finding = store
            .add_human_finding(&document.id, 1, &corpus, finding_input(&corpus))
            .unwrap();
        let verified_only = store
            .add_exact_evidence(
                &document.id,
                with_finding.document.revision,
                "Verified single event",
                &corpus,
                vec![event_ref(&corpus, 11, "api/app.log", 1_700_000_011)],
            )
            .unwrap();
        store
            .set_report_section(
                &document.id,
                verified_only.document.revision,
                &corpus,
                set_input(
                    ReportSectionKind::ExecutiveSummary,
                    "Summary with all marker classes.",
                ),
            )
            .unwrap();

        // Fabricate a stale ref (seq 10 source changed) and a missing ref (seq 12 deleted).
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

        let resolved = store.load(&document.id, &corpus).unwrap();
        let report_one = assemble_investigation_report(&resolved, 1_700_001_100);
        let report_two = assemble_investigation_report(&resolved, 1_700_001_100);
        assert_eq!(report_one, report_two);
        let markdown_one = render_investigation_report_markdown(&report_one);
        let markdown_two = render_investigation_report_markdown(&report_two);
        assert_eq!(markdown_one, markdown_two, "render must be deterministic");

        assert!(
            markdown_one.contains(REPORT_MARKER_VERIFIED),
            "{markdown_one}"
        );
        assert!(
            markdown_one.contains(REPORT_MARKER_MISSING),
            "{markdown_one}"
        );
        assert!(markdown_one.contains(REPORT_MARKER_STALE), "{markdown_one}");
        assert!(
            markdown_one.contains("## Evidence-backed timeline"),
            "{markdown_one}"
        );
        assert!(
            markdown_one.contains("Current noise policy: sidecar r"),
            "{markdown_one}"
        );
        // Timeline is sorted by timestamp hint: seq 10 before 11 before 12.
        let timeline = &report_one.timeline.entries;
        assert_eq!(
            timeline.iter().map(|entry| entry.seq).collect::<Vec<_>>(),
            vec![10, 11, 12]
        );
        assert_eq!(timeline[0].status, EvidenceReferenceStatus::Stale);
        assert_eq!(timeline[1].status, EvidenceReferenceStatus::Verified);
        assert_eq!(timeline[2].status, EvidenceReferenceStatus::Missing);
        // No event payload/message text ever appears — identities only.
        assert!(!markdown_one.contains(PAYLOAD_SENTINEL), "{markdown_one}");
        assert!(
            !markdown_one.contains("intervening event"),
            "{markdown_one}"
        );
        assert!(
            !markdown_one.contains("selected noncontiguous event"),
            "{markdown_one}"
        );
    }

    #[test]
    fn timeline_is_bounded_with_explicit_omitted_count() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = LogCorpus::create(cache.path(), "bulk timeline").unwrap();
        let total = MAX_REPORT_TIMELINE_ENTRIES + 1;
        let events: Vec<LogEvent> = (1..=total as u64)
            .map(|seq| LogEvent {
                seq,
                ts: 1_700_000_000 + seq as i64,
                timestamp_provenance: TimestampProvenance::ExplicitWallClock,
                active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
                unresolved_local_timestamp: None,
                level: "info".into(),
                service: Some("bulk".into()),
                host: None,
                template_id: 1,
                params: vec![],
                trace_id: None,
                message: "bulk event".into(),
                source: "bulk/bulk.log".into(),
            })
            .collect();
        corpus.push_events(&events).unwrap();
        corpus.flush().unwrap();

        let store = InvestigationStore::new(durable.path());
        let document = store.create("Bounded timeline", &corpus).unwrap();
        let first_batch: Vec<BookmarkEventRef> = (1..=MAX_REPORT_TIMELINE_ENTRIES as u64)
            .map(|seq| BookmarkEventRef {
                corpus_id: corpus.id().to_string(),
                seq,
                source: "bulk/bulk.log".into(),
                timestamp_hint: 1_700_000_000 + seq as i64,
                time_quality_hint: TimeQuality::Wall,
            })
            .collect();
        let saved = store
            .add_exact_evidence(&document.id, 1, "Bulk evidence", &corpus, first_batch)
            .unwrap();
        store
            .add_exact_evidence(
                &document.id,
                saved.document.revision,
                "Tail evidence",
                &corpus,
                vec![BookmarkEventRef {
                    corpus_id: corpus.id().to_string(),
                    seq: total as u64,
                    source: "bulk/bulk.log".into(),
                    timestamp_hint: 1_700_000_000 + total as i64,
                    time_quality_hint: TimeQuality::Wall,
                }],
            )
            .unwrap();

        let resolved = store.load(&document.id, &corpus).unwrap();
        let report = assemble_investigation_report(&resolved, 1_700_002_000);
        assert_eq!(report.timeline.entries.len(), MAX_REPORT_TIMELINE_ENTRIES);
        assert_eq!(report.timeline.omitted_count, 1);
        assert!(!report
            .timeline
            .entries
            .iter()
            .any(|entry| entry.seq == total as u64));
        let markdown = render_investigation_report_markdown(&report);
        assert!(
            markdown.contains("1 timeline entries omitted (bounded render)"),
            "{markdown}"
        );
    }

    #[test]
    fn report_section_bodies_store_redacted_and_render_idempotent() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Redacted report", &corpus).unwrap();
        let saved = store
            .set_report_section(
                &document.id,
                1,
                &corpus,
                set_input(
                    ReportSectionKind::NextActions,
                    "Rotate the leaked header Authorization: Bearer abc123def456 and audit access.",
                ),
            )
            .unwrap();
        let stored = &saved.document.report_sections[0].body;
        assert!(!stored.contains("abc123def456"), "{stored}");
        assert!(stored.contains("Bearer ***"), "{stored}");

        // The stored canonical form reloads (validation re-runs redaction).
        let reloaded = store.load(&document.id, &corpus).unwrap();
        assert_eq!(reloaded.document.report_sections[0].body, *stored);

        let report = assemble_investigation_report(&reloaded, 1_700_002_100);
        let markdown = render_investigation_report_markdown(&report);
        assert!(!markdown.contains("abc123def456"), "{markdown}");
        assert!(markdown.contains("Bearer ***"), "{markdown}");
        // Defense-in-depth scrub is a fixed point over the rendered text.
        assert_eq!(crate::redact::scrub_secrets(&markdown), markdown);

        // A credential-dominant body is refused outright.
        let secret = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz012345"].concat();
        assert!(store
            .set_report_section(
                &document.id,
                saved.document.revision,
                &corpus,
                set_input(ReportSectionKind::ExecutiveSummary, &secret),
            )
            .is_err());
    }

    #[test]
    fn propose_report_section_tool_spec_preview_and_args_parse() {
        let spec = propose_report_section_tool_spec();
        assert_eq!(spec.name, PROPOSE_REPORT_SECTION_TOOL);
        assert!(matches!(
            spec.side_effect,
            crate::tools::ToolSideEffect::SoftWrite
        ));
        let required = spec.parameters["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>();
        assert!(required.contains(&"idempotency_key"));
        assert!(required.contains(&"kind"));
        assert!(required.contains(&"body"));
        // Schema/execution agreement (#532 hardening): the tool host
        // hard-requires expected_revision at execution, so the advertised
        // schema must declare it required too — a schema-conformant provider
        // must never be able to construct a call that only fails at execution
        // because the schema under-declared the revision pin.
        assert!(
            required.contains(&"expected_revision"),
            "tool schema must declare expected_revision required; execution enforces it"
        );
        assert_eq!(
            required,
            vec!["expected_revision", "idempotency_key", "kind", "body"],
            "schema required list must exactly match what execution enforces"
        );

        let evidence_id = Uuid::now_v7().to_string();
        let args = serde_json::json!({
            "idempotency_key": "tool-key-1",
            "kind": "executive_summary",
            "body": "Tool-proposed summary.",
            "evidence_ids": [evidence_id],
            "provenance": { "source": "model", "tool_name": "spoofed" }
        });
        let provenance = host_model_report_section_provenance(&TrustedModelProposeContext {
            provider: Some("openai_compatible".into()),
            model_id: Some("gpt-test".into()),
            run_id: Some("run-7".into()),
        })
        .unwrap();
        assert_eq!(provenance.source, ProposalSourceKind::Model);
        assert_eq!(provenance.tool_name, PROPOSE_REPORT_SECTION_TOOL);
        let input = propose_report_section_input_from_tool_args(
            &args,
            "host-investigation".into(),
            7,
            provenance.clone(),
        )
        .unwrap();
        assert_eq!(input.investigation_id, "host-investigation");
        assert_eq!(input.expected_revision, 7);
        assert_eq!(input.kind, ReportSectionKind::ExecutiveSummary);
        assert_eq!(input.evidence_ids, vec![evidence_id]);
        assert!(input.finding_ids.is_empty());
        // Model-supplied provenance is ignored; the host value wins.
        assert_eq!(input.provenance, provenance);

        // Malformed arguments fail closed with the typed invalid_input code.
        let missing_key = serde_json::json!({ "kind": "executive_summary", "body": "x" });
        let err = propose_report_section_input_from_tool_args(
            &missing_key,
            "inv".into(),
            1,
            report_provenance(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("invalid_input"), "{err}");
        assert!(err.contains("idempotency_key"), "{err}");

        let bad_kind = serde_json::json!({
            "idempotency_key": "k", "kind": "scope", "body": "x"
        });
        let err = propose_report_section_input_from_tool_args(
            &bad_kind,
            "inv".into(),
            1,
            report_provenance(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("invalid_input"), "{err}");
        assert!(err.contains("kind"), "{err}");

        let bad_ids = serde_json::json!({
            "idempotency_key": "k", "kind": "next_actions", "body": "x", "note_ids": [7]
        });
        let err = propose_report_section_input_from_tool_args(
            &bad_ids,
            "inv".into(),
            1,
            report_provenance(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("note_ids entries must be strings"), "{err}");

        // Permission preview is dedicated, bounded, and redacted.
        let secret = ["sk-proj-", "abcdefghijklmnopqrstuvwxyz012345"].concat();
        let preview_args = serde_json::json!({
            "kind": "next_actions",
            "body": format!("Rotate {secret} now."),
            "evidence_ids": ["a", "b"],
            "note_ids": ["c"]
        });
        let preview = propose_report_section_permission_preview(&preview_args, Some("inv-host-9"));
        assert!(
            preview.contains("propose_report_section (SoftWrite)"),
            "{preview}"
        );
        assert!(
            preview.contains("Proposed report section only"),
            "{preview}"
        );
        assert!(preview.contains("inv-host-9"), "{preview}");
        assert!(preview.contains("next_actions"), "{preview}");
        assert!(!preview.contains(&secret), "{preview}");
        assert!(preview.contains("evidence 2"), "{preview}");
        assert!(preview.contains("notes 1"), "{preview}");
    }

    /// Blocker 3 (#532 hardening): the report header's current-policy identity
    /// must be the exact snapshot the finding statuses were resolved against —
    /// one capture, never a second read that could disagree.
    #[test]
    fn report_current_policy_always_matches_the_resolution_snapshot() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Snapshot coherence", &corpus).unwrap();
        let binding = super::super::InvestigationPolicyBinding::capture(
            &corpus,
            super::super::InvestigationNoiseLens::Active,
        )
        .unwrap();
        store
            .add_human_finding_bound(&document.id, 1, &corpus, binding.clone(), {
                finding_input(&corpus)
            })
            .unwrap();

        // The policy moves after the finding was bound.
        let changed_revision = publish_policy_preview(&corpus);
        assert_ne!(changed_revision, binding.suppression_policy_revision);

        let resolved = store
            .load_with_policy_lens(
                &document.id,
                &corpus,
                super::super::InvestigationNoiseLens::Active,
            )
            .unwrap();
        let report = assemble_investigation_report(&resolved, 1_700_003_000);

        // The finding status was computed against the resolution snapshot…
        assert_eq!(
            resolved.findings[0].policy_binding.status,
            super::super::InvestigationPolicyBindingStatus::MadeUnderDifferentPolicy
        );
        let resolution = resolved.resolution_policy.as_ref().expect("snapshot");
        assert_eq!(
            resolved.findings[0]
                .policy_binding
                .current_suppression_policy_revision,
            resolution.suppression_policy_revision
        );
        // …and the report header carries that exact same snapshot, field for
        // field — never a separately-captured one.
        let header = report.current_policy.as_ref().expect("header policy");
        assert_eq!(
            header.suppression_policy_revision,
            resolution.suppression_policy_revision
        );
        assert_eq!(
            header.resolved_template_revision,
            resolution.resolved_template_revision
        );
        assert_eq!(
            header.effective_policy_sha256,
            resolution.effective_policy_sha256
        );
        assert_eq!(header.noise_lens, Some(InvestigationNoiseLens::Active));
        assert_eq!(header.suppression_policy_revision, changed_revision);
        let markdown = render_investigation_report_markdown(&report);
        assert!(
            markdown.contains(&format!("sidecar r{changed_revision}"))
                && markdown.contains("lens active"),
            "{markdown}"
        );

        // Identical sidecar/template/hash under another lens must never carry
        // an identical report policy identity: finding status depends on lens.
        let suspended = store
            .load_with_policy_lens(&document.id, &corpus, InvestigationNoiseLens::Suspended)
            .unwrap();
        let suspended_report = assemble_investigation_report(&suspended, 1_700_003_000);
        let suspended_policy = suspended_report.current_policy.as_ref().unwrap();
        assert_eq!(
            suspended_policy.suppression_policy_revision,
            header.suppression_policy_revision
        );
        assert_eq!(
            suspended_policy.effective_policy_sha256,
            header.effective_policy_sha256
        );
        assert_eq!(
            suspended_policy.noise_lens,
            Some(InvestigationNoiseLens::Suspended)
        );
        assert_ne!(suspended_policy, header);
    }

    /// Blocker 6 (#532 hardening): accepting a replacement proposal for the
    /// same kind supersedes the prior accepted origin — the old row keeps its
    /// acceptance history but can never keep claiming authorship.
    #[test]
    fn accepting_a_replacement_proposal_supersedes_the_prior_accepted_origin() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Supersede on re-accept", &corpus).unwrap();

        let mut first = propose_input(&document.id, 1, ReportSectionKind::ExecutiveSummary, "A.");
        first.idempotency_key = "supersede-a".into();
        let proposed = store.propose_report_section(&corpus, first).unwrap();
        let first_id = proposed.document.proposed_report_sections[0].id.clone();
        let accepted = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id: first_id.clone(),
                    expected_revision: proposed.document.revision,
                    body: None,
                },
            )
            .unwrap();
        let section_id = accepted.document.report_sections[0].id.clone();

        let mut second = propose_input(
            &document.id,
            accepted.document.revision,
            ReportSectionKind::ExecutiveSummary,
            "B.",
        );
        second.idempotency_key = "supersede-b".into();
        let proposed_two = store.propose_report_section(&corpus, second).unwrap();
        let second_id = proposed_two
            .document
            .proposed_report_sections
            .iter()
            .find(|p| p.idempotency_key == "supersede-b")
            .unwrap()
            .id
            .clone();
        let after = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id: second_id.clone(),
                    expected_revision: proposed_two.document.revision,
                    body: None,
                },
            )
            .unwrap();

        // One section per kind, id preserved, content and origin replaced.
        assert_eq!(after.document.report_sections.len(), 1);
        let section = &after.document.report_sections[0];
        assert_eq!(section.id, section_id);
        assert_eq!(section.body, "B.");
        assert_eq!(
            section.accepted_from_proposal_id.as_deref(),
            Some(second_id.as_str())
        );

        // The first proposal is Superseded with its history intact.
        let first_row = after
            .document
            .proposed_report_sections
            .iter()
            .find(|p| p.id == first_id)
            .unwrap();
        assert_eq!(first_row.status, ProposedFindingStatus::Superseded);
        assert!(first_row.acceptance.is_some(), "history stays inspectable");
        assert_eq!(
            first_row.accepted_section_id.as_deref(),
            Some(section_id.as_str())
        );
        let second_row = after
            .document
            .proposed_report_sections
            .iter()
            .find(|p| p.id == second_id)
            .unwrap();
        assert_eq!(second_row.status, ProposedFindingStatus::Accepted);

        // The stored document satisfies the link-truth invariant on reload.
        store.load(&document.id, &corpus).unwrap();
    }

    /// Blocker 6 (#532 hardening): a manual section replacement also
    /// supersedes the prior accepted origin.
    #[test]
    fn manual_set_supersedes_the_prior_accepted_origin() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Supersede on manual set", &corpus).unwrap();

        let mut input = propose_input(&document.id, 1, ReportSectionKind::NextActions, "Old.");
        input.idempotency_key = "manual-set-a".into();
        let proposed = store.propose_report_section(&corpus, input).unwrap();
        let proposal_id = proposed.document.proposed_report_sections[0].id.clone();
        let accepted = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id: proposal_id.clone(),
                    expected_revision: proposed.document.revision,
                    body: None,
                },
            )
            .unwrap();

        let replaced = store
            .set_report_section(
                &document.id,
                accepted.document.revision,
                &corpus,
                set_input(ReportSectionKind::NextActions, "Fresh human authorship."),
            )
            .unwrap();
        let section = &replaced.document.report_sections[0];
        assert!(section.accepted_from_proposal_id.is_none());
        let row = replaced
            .document
            .proposed_report_sections
            .iter()
            .find(|p| p.id == proposal_id)
            .unwrap();
        assert_eq!(row.status, ProposedFindingStatus::Superseded);
        assert!(row.acceptance.is_some());
        store.load(&document.id, &corpus).unwrap();
    }

    /// Blocker 2 (#532 hardening): the acceptance `edited` marker is derived
    /// from whether the durable body actually differs — a renderer cannot
    /// claim an edit that did not happen, and an identical replacement body is
    /// not an edit.
    #[test]
    fn accept_edited_marker_is_derived_from_actual_body_difference() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Edited truth", &corpus).unwrap();

        let mut same = propose_input(
            &document.id,
            1,
            ReportSectionKind::UnresolvedQuestions,
            "Same body.",
        );
        same.idempotency_key = "edited-same".into();
        let proposed = store.propose_report_section(&corpus, same).unwrap();
        let same_id = proposed.document.proposed_report_sections[0].id.clone();
        let accepted = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id: same_id.clone(),
                    // A replacement body byte-identical to the proposal is not
                    // an edit, whatever the caller implies.
                    expected_revision: proposed.document.revision,
                    body: Some("Same body.".into()),
                },
            )
            .unwrap();
        let row = accepted
            .document
            .proposed_report_sections
            .iter()
            .find(|p| p.id == same_id)
            .unwrap();
        assert!(!row.acceptance.as_ref().unwrap().edited);

        let mut diff = propose_input(
            &document.id,
            accepted.document.revision,
            ReportSectionKind::NextActions,
            "Original actions.",
        );
        diff.idempotency_key = "edited-diff".into();
        let proposed_two = store.propose_report_section(&corpus, diff).unwrap();
        let diff_id = proposed_two
            .document
            .proposed_report_sections
            .iter()
            .find(|p| p.idempotency_key == "edited-diff")
            .unwrap()
            .id
            .clone();
        let accepted_two = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id: diff_id.clone(),
                    expected_revision: proposed_two.document.revision,
                    body: Some("Rewritten actions.".into()),
                },
            )
            .unwrap();
        let row = accepted_two
            .document
            .proposed_report_sections
            .iter()
            .find(|p| p.id == diff_id)
            .unwrap();
        assert!(row.acceptance.as_ref().unwrap().edited);
    }

    /// Blocker 4 (#532 hardening): non-wall hints are never rendered as
    /// calendar instants, the mixed window is labeled as hints, and a
    /// cross-quality timeline carries an explicit bounded-ordering caveat.
    #[test]
    fn mixed_quality_time_is_never_rendered_as_calendar_time() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Mixed time", &corpus).unwrap();
        store
            .add_exact_evidence(
                &document.id,
                1,
                "Mixed-quality window",
                &corpus,
                selected_refs(&corpus),
            )
            .unwrap();
        let mut resolved = store.load(&document.id, &corpus).unwrap();
        // Assembly is pure over the resolved document; flip the seq-12 ref
        // to an order-only position the way an order-only corpus stores it
        // (canonicalization may have reordered the saved refs).
        {
            let refs = &mut resolved.document.evidence[0].event_refs;
            let flip = refs.iter().position(|r| r.seq == 12).expect("seq 12");
            refs[flip].time_quality_hint = TimeQuality::OrderOnly;
            refs[flip].timestamp_hint = 12;
            let res = resolved.evidence[0]
                .references
                .iter()
                .position(|r| r.event_ref.seq == 12)
                .expect("resolved seq 12");
            resolved.evidence[0].references[res]
                .event_ref
                .time_quality_hint = TimeQuality::OrderOnly;
            resolved.evidence[0].references[res]
                .event_ref
                .timestamp_hint = 12;
        }

        let report = assemble_investigation_report(&resolved, 1_700_004_000);
        let window = report.scope.time_window.as_ref().expect("window");
        assert!(window.mixed_quality);
        let markdown = render_investigation_report_markdown(&report);

        // The window renders raw hints with the mixed label — never RFC3339.
        assert!(
            markdown.contains(
                "- Time window: hints 12 \u{2192} 1700000010 (mixed time quality; not uniform calendar time)"
            ),
            "{markdown}"
        );
        // The order-only entry renders as an order position with its label.
        assert!(
            markdown.contains("order 12 (order only (not calendar time))"),
            "{markdown}"
        );
        // Its position is never formatted as a calendar instant, while the
        // wall reference still is.
        assert!(!markdown.contains("1970-01-01"), "{markdown}");
        assert!(markdown.contains("2023-11-14T22:13:30Z"), "{markdown}"); // wall seq 10
                                                                          // Cross-quality ordering is explicitly bounded.
        assert!(
            markdown.contains(
                "_Entries mix wall-clock and order-only references; cross-quality order is by stored hint, not established time._"
            ),
            "{markdown}"
        );

        // A uniformly wall-clock timeline carries no caveat.
        let uniform = store.load(&document.id, &corpus).unwrap();
        let uniform_report = assemble_investigation_report(&uniform, 1_700_004_000);
        let uniform_markdown = render_investigation_report_markdown(&uniform_report);
        assert!(
            !uniform_markdown.contains("cross-quality order"),
            "{uniform_markdown}"
        );
        assert!(
            uniform_markdown
                .contains("- Time window: 2023-11-14T22:13:30Z \u{2192} 2023-11-14T22:13:32Z"),
            "{uniform_markdown}"
        );
    }

    /// Blocker 6 (#532 hardening): the stored-form invariant rejects a
    /// document where an Accepted proposal points at a section that no longer
    /// records it as origin — exactly the corrupt history the pre-repair code
    /// used to write on same-kind replacement.
    #[test]
    fn stored_accepted_proposal_must_link_back_to_its_section() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Link truth", &corpus).unwrap();

        let mut input = propose_input(&document.id, 1, ReportSectionKind::ExecutiveSummary, "A.");
        input.idempotency_key = "link-truth-a".into();
        let proposed = store.propose_report_section(&corpus, input).unwrap();
        let proposal_id = proposed.document.proposed_report_sections[0].id.clone();
        let accepted = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id,
                    expected_revision: proposed.document.revision,
                    body: None,
                },
            )
            .unwrap();

        // Corrupt the durable revision the way the pre-repair code did:
        // section origin cleared while the proposal stays Accepted.
        let revision_path = durable
            .path()
            .join(&document.id)
            .join(revision_filename(accepted.document.revision));
        let mut stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&revision_path).unwrap()).unwrap();
        stored["reportSections"][0]["acceptedFromProposalId"] = serde_json::Value::Null;
        std::fs::write(&revision_path, serde_json::to_vec_pretty(&stored).unwrap()).unwrap();

        let err = store.load(&document.id, &corpus).unwrap_err().to_string();
        assert!(err.contains("does not record it as origin"), "{err}");
    }

    #[test]
    fn stored_report_proposal_rejects_unlinked_corpus_and_noncanonical_provenance() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Stored trust boundary", &corpus).unwrap();
        let proposed = store
            .propose_report_section(
                &corpus,
                propose_input(
                    &document.id,
                    1,
                    ReportSectionKind::ExecutiveSummary,
                    "Bound proposal.",
                ),
            )
            .unwrap();
        let revision_path = durable
            .path()
            .join(&document.id)
            .join(revision_filename(proposed.document.revision));
        let original: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&revision_path).unwrap()).unwrap();

        let mut foreign = original.clone();
        foreign["proposedReportSections"][0]["corpusId"] = serde_json::json!("foreign-corpus");
        std::fs::write(&revision_path, serde_json::to_vec_pretty(&foreign).unwrap()).unwrap();
        let err = store.load(&document.id, &corpus).unwrap_err().to_string();
        assert!(err.contains("references unlinked corpus"), "{err}");

        let mut noncanonical = original.clone();
        noncanonical["proposedReportSections"][0]["provenance"]["provider"] =
            serde_json::json!(" provider-with-whitespace ");
        std::fs::write(
            &revision_path,
            serde_json::to_vec_pretty(&noncanonical).unwrap(),
        )
        .unwrap();
        let err = store.load(&document.id, &corpus).unwrap_err().to_string();
        assert!(err.contains("provenance is not canonical"), "{err}");
    }

    #[test]
    fn stored_report_proposal_lifecycle_matrix_is_mutually_exclusive() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let document = store.create("Lifecycle matrix", &corpus).unwrap();
        let proposed = store
            .propose_report_section(
                &corpus,
                propose_input(
                    &document.id,
                    1,
                    ReportSectionKind::ExecutiveSummary,
                    "First proposal.",
                ),
            )
            .unwrap();
        let proposal_id = proposed.document.proposed_report_sections[0].id.clone();
        let proposed_path = durable
            .path()
            .join(&document.id)
            .join(revision_filename(proposed.document.revision));
        let proposed_bytes = std::fs::read(&proposed_path).unwrap();
        let mut invalid_proposed: serde_json::Value =
            serde_json::from_slice(&proposed_bytes).unwrap();
        invalid_proposed["proposedReportSections"][0]["dismissReason"] =
            serde_json::json!("terminal field on Proposed");
        std::fs::write(
            &proposed_path,
            serde_json::to_vec_pretty(&invalid_proposed).unwrap(),
        )
        .unwrap();
        let err = store.load(&document.id, &corpus).unwrap_err().to_string();
        assert!(err.contains("has terminal lifecycle state"), "{err}");
        std::fs::write(&proposed_path, &proposed_bytes).unwrap();

        let dismissed = store
            .dismiss_proposed_report_section(
                &corpus,
                &document.id,
                DismissProposedReportSectionInput {
                    proposal_id,
                    expected_revision: proposed.document.revision,
                    reason: "Not applicable".into(),
                },
            )
            .unwrap();
        let dismissed_path = durable
            .path()
            .join(&document.id)
            .join(revision_filename(dismissed.document.revision));
        let dismissed_bytes = std::fs::read(&dismissed_path).unwrap();
        let mut invalid_dismissed: serde_json::Value =
            serde_json::from_slice(&dismissed_bytes).unwrap();
        invalid_dismissed["proposedReportSections"][0]["acceptance"] = serde_json::json!({
            "acceptedAt": dismissed.document.updated_at,
            "edited": false
        });
        std::fs::write(
            &dismissed_path,
            serde_json::to_vec_pretty(&invalid_dismissed).unwrap(),
        )
        .unwrap();
        let err = store.load(&document.id, &corpus).unwrap_err().to_string();
        assert!(err.contains("has inconsistent lifecycle state"), "{err}");
        std::fs::write(&dismissed_path, &dismissed_bytes).unwrap();

        let mut second_input = propose_input(
            &document.id,
            dismissed.document.revision,
            ReportSectionKind::NextActions,
            "Second proposal.",
        );
        second_input.idempotency_key = "lifecycle-matrix-second".into();
        let second = store.propose_report_section(&corpus, second_input).unwrap();
        let second_id = second
            .document
            .proposed_report_sections
            .iter()
            .find(|proposal| proposal.idempotency_key == "lifecycle-matrix-second")
            .unwrap()
            .id
            .clone();
        let accepted = store
            .accept_proposed_report_section(
                &corpus,
                &document.id,
                AcceptProposedReportSectionInput {
                    proposal_id: second_id.clone(),
                    expected_revision: second.document.revision,
                    body: None,
                },
            )
            .unwrap();
        let accepted_path = durable
            .path()
            .join(&document.id)
            .join(revision_filename(accepted.document.revision));
        let accepted_bytes = std::fs::read(&accepted_path).unwrap();
        let mut invalid_accepted: serde_json::Value =
            serde_json::from_slice(&accepted_bytes).unwrap();
        let accepted_index = invalid_accepted["proposedReportSections"]
            .as_array()
            .unwrap()
            .iter()
            .position(|proposal| proposal["id"] == second_id)
            .unwrap();
        invalid_accepted["proposedReportSections"][accepted_index]["dismissReason"] =
            serde_json::json!("cannot also dismiss");
        std::fs::write(
            &accepted_path,
            serde_json::to_vec_pretty(&invalid_accepted).unwrap(),
        )
        .unwrap();
        let err = store.load(&document.id, &corpus).unwrap_err().to_string();
        assert!(err.contains("has inconsistent lifecycle state"), "{err}");
        std::fs::write(&accepted_path, &accepted_bytes).unwrap();

        let superseded = store
            .set_report_section(
                &document.id,
                accepted.document.revision,
                &corpus,
                set_input(ReportSectionKind::NextActions, "Human replacement."),
            )
            .unwrap();
        let superseded_path = durable
            .path()
            .join(&document.id)
            .join(revision_filename(superseded.document.revision));
        let mut invalid_superseded: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&superseded_path).unwrap()).unwrap();
        let superseded_index = invalid_superseded["proposedReportSections"]
            .as_array()
            .unwrap()
            .iter()
            .position(|proposal| proposal["id"] == second_id)
            .unwrap();
        assert_eq!(
            invalid_superseded["proposedReportSections"][superseded_index]["status"],
            "superseded"
        );
        invalid_superseded["proposedReportSections"][superseded_index]["dismissReason"] =
            serde_json::json!("cannot also dismiss");
        std::fs::write(
            &superseded_path,
            serde_json::to_vec_pretty(&invalid_superseded).unwrap(),
        )
        .unwrap();
        let err = store.load(&document.id, &corpus).unwrap_err().to_string();
        assert!(err.contains("has inconsistent lifecycle state"), "{err}");
    }
}
