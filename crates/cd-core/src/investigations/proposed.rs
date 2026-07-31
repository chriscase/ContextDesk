//! Agent/detector proposed findings (#646).
//!
//! Proposals are durable queue items. They never become accepted evidence or
//! mutate Explorer state. Only explicit human Accept / Edit-and-accept / Dismiss
//! transitions change lifecycle. History is append-only and inspectable.

use super::*;
use crate::log_analysis::bookmarks::canonicalize_exact_event_refs;
use serde_json::Value;

/// Maximum durable proposed findings in one investigation.
pub const MAX_PROPOSED_FINDINGS: usize = 512;
/// Maximum supporting+contradicting exact refs on one proposal.
pub const MAX_PROPOSAL_EVIDENCE_REFS: usize = 32;
/// Maximum UTF-8 bytes in caveats.
pub const MAX_PROPOSAL_CAVEATS_BYTES: usize = 2_048;
/// Maximum UTF-8 bytes in an idempotency key.
pub const MAX_PROPOSAL_IDEMPOTENCY_KEY_BYTES: usize = 128;
/// Maximum UTF-8 bytes in a dismiss reason.
pub const MAX_PROPOSAL_DISMISS_REASON_BYTES: usize = 512;
/// Maximum UTF-8 bytes for non-secret provenance string fields.
pub const MAX_PROPOSAL_PROVENANCE_FIELD_BYTES: usize = 128;

/// Review lifecycle for a proposed finding.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposedFindingStatus {
    /// Awaiting human review. Never treated as accepted evidence.
    Proposed,
    /// Explicitly accepted (optionally after edit). Linked to a human finding.
    Accepted,
    /// Explicitly dismissed with a reason.
    Dismissed,
    /// Replaced by a newer proposal with the same idempotency family (reserved).
    Superseded,
}

/// Role of one exact evidence identity relative to the proposal claim.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalEvidenceRole {
    /// Evidence that supports the proposed claim.
    Supporting,
    /// Evidence that contradicts or bounds the claim.
    Contradicting,
}

/// Who emitted the proposal (never includes credentials or prompts).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalSourceKind {
    /// Tools-enabled linked chat model via `propose_finding`.
    Model,
    /// Internal deterministic detector.
    Detector,
    /// Host/internal test or migration path.
    Internal,
}

/// Privacy-safe proposal provenance. No credentials, prompts, reasoning,
/// private paths, or raw payload snapshots.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalProvenance {
    /// Emitter class.
    pub source: ProposalSourceKind,
    /// Optional provider id (e.g. `openai_compatible`), never a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Optional model id string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Optional run / turn identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Tool name that produced the proposal (`propose_finding`).
    pub tool_name: String,
    /// Optional deterministic detector id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detector_id: Option<String>,
}

/// One exact evidence identity with supporting/contradicting role.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalEvidenceCitation {
    /// Payload-free exact event identity.
    pub event_ref: BookmarkEventRef,
    /// Role of this identity relative to the claim.
    pub role: ProposalEvidenceRole,
}

/// Bounded deterministic rank inputs (no free-form blobs).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalRankInputs {
    /// Number of exact supporting evidence identities.
    pub supporting_count: u32,
    /// Number of exact contradicting evidence identities.
    pub contradicting_count: u32,
    /// Optional inclusive time span of cited events in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_span_secs: Option<u64>,
    /// Optional level weight 0–100 for deterministic ranking.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level_weight: Option<u8>,
}

/// Human acceptance record appended on Accept / Edit-and-accept.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HumanProposalAcceptance {
    /// Unix seconds when the human accepted.
    pub accepted_at: i64,
    /// True when the human edited fields before accept.
    pub edited: bool,
}

/// Durable proposed finding. Status begins at Proposed and never auto-accepts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedFindingItem {
    /// Stable UUIDv7 proposal identifier.
    pub id: String,
    /// Review lifecycle status.
    pub status: ProposedFindingStatus,
    /// Epistemic kind proposed by the model/detector.
    pub kind: FindingKind,
    /// Redacted title.
    pub title: String,
    /// Redacted why-it-matters.
    pub why_it_matters: String,
    /// Optional redacted caveats.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caveats: Option<String>,
    /// Exact evidence citations with roles.
    pub evidence: Vec<ProposalEvidenceCitation>,
    /// Optional validated Explorer view recipe (payload-free).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_recipe: Option<FindingViewRecipe>,
    /// Bound corpus id (must match investigation corpus).
    pub corpus_id: String,
    /// Bound investigation id.
    pub investigation_id: String,
    /// Optional policy binding captured at propose time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_binding: Option<InvestigationPolicyBinding>,
    /// Template revision pin at propose time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_revision: Option<u64>,
    /// Suppression policy revision pin at propose time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suppression_policy_revision: Option<u64>,
    /// Deterministic rank inputs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rank_inputs: Option<ProposalRankInputs>,
    /// Privacy-safe provenance.
    pub provenance: ProposalProvenance,
    /// Idempotency key for retry-safe propose.
    pub idempotency_key: String,
    /// Human acceptance when status is Accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<HumanProposalAcceptance>,
    /// Dismiss reason when status is Dismissed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismiss_reason: Option<String>,
    /// Linked human finding id after Accept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_finding_id: Option<String>,
    /// Creation time as Unix seconds.
    pub created_at: i64,
    /// Last update time as Unix seconds.
    pub updated_at: i64,
}

/// Input for one host-validated propose mutation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProposeFindingInput {
    /// Target investigation (must be active and bound to corpus).
    pub investigation_id: String,
    /// Optimistic expected revision.
    pub expected_revision: u64,
    /// Idempotency key (required; retries return existing).
    pub idempotency_key: String,
    /// Epistemic kind.
    pub kind: FindingKind,
    /// Title (redacted/validated).
    pub title: String,
    /// Why it matters (redacted/validated).
    pub why_it_matters: String,
    /// Optional caveats.
    #[serde(default)]
    pub caveats: Option<String>,
    /// Exact evidence with roles.
    pub evidence: Vec<ProposalEvidenceCitation>,
    /// Optional view recipe.
    #[serde(default)]
    pub view_recipe: Option<FindingViewRecipe>,
    /// Expected template revision pin (fail closed if mismatched when Some).
    #[serde(default)]
    pub template_revision: Option<u64>,
    /// Expected suppression policy revision pin.
    #[serde(default)]
    pub suppression_policy_revision: Option<u64>,
    /// Optional rank inputs.
    #[serde(default)]
    pub rank_inputs: Option<ProposalRankInputs>,
    /// Provenance (no secrets).
    pub provenance: ProposalProvenance,
    /// Noise lens for policy capture (default Active).
    #[serde(default)]
    pub noise_lens: Option<InvestigationNoiseLens>,
}

/// Input for human accept of a proposal (optionally with edits).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcceptProposedFindingInput {
    /// Proposal id.
    pub proposal_id: String,
    /// Optimistic expected revision.
    pub expected_revision: u64,
    /// When true, use replacement fields below (edit-and-accept).
    #[serde(default)]
    pub edited: bool,
    /// Optional replacement kind.
    #[serde(default)]
    pub kind: Option<FindingKind>,
    /// Optional replacement title.
    #[serde(default)]
    pub title: Option<String>,
    /// Optional replacement why-it-matters.
    #[serde(default)]
    pub why_it_matters: Option<String>,
}

/// Input for dismiss-with-reason.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DismissProposedFindingInput {
    /// Proposal id.
    pub proposal_id: String,
    /// Optimistic expected revision.
    pub expected_revision: u64,
    /// Required human dismiss reason.
    pub reason: String,
}

/// Machine-readable repair error codes for propose fail-closed paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposeFindingErrorCode {
    /// Tools disabled / unavailable.
    ToolsDisabled,
    /// Wrong corpus binding.
    WrongCorpus,
    /// Stale investigation revision.
    StaleRevision,
    /// Stale template or suppression revision pin.
    StalePolicyRevision,
    /// Missing or cross-corpus event identity.
    BadEvidenceIdentity,
    /// Malformed or over-limit fields.
    InvalidInput,
    /// Concurrent revision conflict.
    ConcurrentRevision,
    /// Proposal not in Proposed status for accept/dismiss.
    InvalidLifecycle,
}

impl ProposeFindingErrorCode {
    /// Stable snake_case code for host/tool feedback.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ToolsDisabled => "tools_disabled",
            Self::WrongCorpus => "wrong_corpus",
            Self::StaleRevision => "stale_revision",
            Self::StalePolicyRevision => "stale_policy_revision",
            Self::BadEvidenceIdentity => "bad_evidence_identity",
            Self::InvalidInput => "invalid_input",
            Self::ConcurrentRevision => "concurrent_revision",
            Self::InvalidLifecycle => "invalid_lifecycle",
        }
    }
}

/// Format a machine-readable repair error for tool/host surfaces.
pub fn propose_repair_error(code: ProposeFindingErrorCode, detail: impl AsRef<str>) -> CoreError {
    CoreError::Policy(format!(
        "propose_finding_error code={} detail={}",
        code.as_str(),
        detail.as_ref()
    ))
}

impl InvestigationStore {
    /// Host-validated propose: creates only a durable **Proposed** item.
    ///
    /// Never creates accepted findings, never mutates Explorer. Idempotent on
    /// `idempotency_key` within the investigation.
    pub fn propose_finding(
        &self,
        corpus: &LogCorpus,
        input: ProposeFindingInput,
    ) -> CoreResult<ResolvedInvestigationDocument> {
        let noise_lens = input.noise_lens.unwrap_or(InvestigationNoiseLens::Active);
        let binding = InvestigationPolicyBinding::capture(corpus, noise_lens)?;
        if let Some(expected) = input.template_revision {
            if expected != binding.resolved_template_revision {
                return Err(propose_repair_error(
                    ProposeFindingErrorCode::StalePolicyRevision,
                    format!(
                        "template_revision pin {expected} != current {}",
                        binding.resolved_template_revision
                    ),
                ));
            }
        }
        if let Some(expected) = input.suppression_policy_revision {
            if expected != binding.suppression_policy_revision {
                return Err(propose_repair_error(
                    ProposeFindingErrorCode::StalePolicyRevision,
                    format!(
                        "suppression_policy_revision pin {expected} != current {}",
                        binding.suppression_policy_revision
                    ),
                ));
            }
        }

        let idempotency_key = sanitize_idempotency_key(input.idempotency_key)?;
        let title = sanitize_title("proposal title", input.title).map_err(|e| {
            propose_repair_error(ProposeFindingErrorCode::InvalidInput, e.to_string())
        })?;
        let why_it_matters = sanitize_body(
            "proposal why it matters",
            input.why_it_matters,
            MAX_FINDING_WHY_IT_MATTERS_BYTES,
        )
        .map_err(|e| propose_repair_error(ProposeFindingErrorCode::InvalidInput, e.to_string()))?;
        let caveats = match input.caveats {
            Some(c) if !c.trim().is_empty() => Some(
                sanitize_body("proposal caveats", c, MAX_PROPOSAL_CAVEATS_BYTES).map_err(|e| {
                    propose_repair_error(ProposeFindingErrorCode::InvalidInput, e.to_string())
                })?,
            ),
            _ => None,
        };
        let provenance = sanitize_provenance(input.provenance)?;
        if input.evidence.is_empty() {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                "at least one exact evidence citation is required",
            ));
        }
        if input.evidence.len() > MAX_PROPOSAL_EVIDENCE_REFS {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                format!("evidence exceeds {MAX_PROPOSAL_EVIDENCE_REFS} identities"),
            ));
        }

        let mut document = self.load_document(&input.investigation_id)?;
        ensure_active_single_corpus(&document, corpus).map_err(|e| {
            propose_repair_error(ProposeFindingErrorCode::WrongCorpus, e.to_string())
        })?;

        // Idempotent retry: return existing proposal without a new revision.
        if let Some(existing) = document
            .proposed_findings
            .iter()
            .find(|p| p.idempotency_key == idempotency_key)
        {
            if existing.status == ProposedFindingStatus::Proposed
                || existing.status == ProposedFindingStatus::Accepted
                || existing.status == ProposedFindingStatus::Dismissed
            {
                return resolve_document_with_policy_lens(document, corpus, Some(noise_lens));
            }
        }

        if document.revision != input.expected_revision {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::StaleRevision,
                format!(
                    "expected revision {} current {}",
                    input.expected_revision, document.revision
                ),
            ));
        }
        if document.proposed_findings.len() >= MAX_PROPOSED_FINDINGS {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                format!("investigation exceeds {MAX_PROPOSED_FINDINGS} proposed findings"),
            ));
        }

        let mut citations = Vec::with_capacity(input.evidence.len());
        let mut seen_seqs = HashSet::new();
        for cite in input.evidence {
            if cite.event_ref.corpus_id != corpus.id() {
                return Err(propose_repair_error(
                    ProposeFindingErrorCode::BadEvidenceIdentity,
                    "cross-corpus event identity is refused",
                ));
            }
            if !seen_seqs.insert(cite.event_ref.seq) {
                return Err(propose_repair_error(
                    ProposeFindingErrorCode::BadEvidenceIdentity,
                    format!("reused event seq {}", cite.event_ref.seq),
                ));
            }
            citations.push(ProposalEvidenceCitation {
                event_ref: cite.event_ref,
                role: cite.role,
            });
        }
        let event_refs: Vec<BookmarkEventRef> =
            citations.iter().map(|c| c.event_ref.clone()).collect();
        let event_refs = canonicalize_exact_event_refs(corpus, event_refs).map_err(|e| {
            propose_repair_error(ProposeFindingErrorCode::BadEvidenceIdentity, e.to_string())
        })?;
        // Re-bind canonicalized refs while preserving roles by seq order.
        let mut role_by_seq: HashMap<u64, ProposalEvidenceRole> = citations
            .iter()
            .map(|c| (c.event_ref.seq, c.role))
            .collect();
        let citations: Vec<ProposalEvidenceCitation> = event_refs
            .into_iter()
            .map(|event_ref| {
                let role = role_by_seq
                    .remove(&event_ref.seq)
                    .unwrap_or(ProposalEvidenceRole::Supporting);
                ProposalEvidenceCitation { event_ref, role }
            })
            .collect();

        let view_recipe = input
            .view_recipe
            .map(|recipe| canonicalize_finding_view_recipe(recipe, corpus))
            .transpose()
            .map_err(|e| {
                propose_repair_error(ProposeFindingErrorCode::InvalidInput, e.to_string())
            })?;

        let rank_inputs = input.rank_inputs.map(sanitize_rank_inputs).transpose()?;
        let now = crate::embed::now_unix_secs();
        let proposal = ProposedFindingItem {
            id: Uuid::now_v7().to_string(),
            status: ProposedFindingStatus::Proposed,
            kind: input.kind,
            title,
            why_it_matters,
            caveats,
            evidence: citations,
            view_recipe,
            corpus_id: corpus.id().to_string(),
            investigation_id: document.id.clone(),
            policy_binding: Some(binding.clone()),
            template_revision: Some(binding.resolved_template_revision),
            suppression_policy_revision: Some(binding.suppression_policy_revision),
            rank_inputs,
            provenance,
            idempotency_key,
            acceptance: None,
            dismiss_reason: None,
            accepted_finding_id: None,
            created_at: now,
            updated_at: now,
        };

        advance_revision(&mut document, now)?;
        document.proposed_findings.push(proposal);
        let directory = self.investigation_directory(&document.id)?;
        publish_revision(&directory, &document)?;
        resolve_document_with_policy_lens(document, corpus, Some(noise_lens))
    }

    /// Explicit human Accept or Edit-and-accept. Creates a human finding and
    /// marks the proposal Accepted with preserved proposal provenance.
    pub fn accept_proposed_finding(
        &self,
        corpus: &LogCorpus,
        investigation_id: &str,
        input: AcceptProposedFindingInput,
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
            .proposed_findings
            .iter()
            .position(|p| p.id == input.proposal_id)
            .ok_or_else(|| {
                propose_repair_error(
                    ProposeFindingErrorCode::InvalidInput,
                    format!("proposal {} not found", input.proposal_id),
                )
            })?;
        if document.proposed_findings[idx].status != ProposedFindingStatus::Proposed {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidLifecycle,
                format!(
                    "proposal {} is {:?} and cannot be accepted",
                    input.proposal_id, document.proposed_findings[idx].status
                ),
            ));
        }

        let proposal = document.proposed_findings[idx].clone();
        let edited = input.edited
            || input.kind.is_some()
            || input.title.is_some()
            || input.why_it_matters.is_some();
        let kind = input.kind.unwrap_or(proposal.kind);
        let title = match input.title {
            Some(t) => sanitize_title("finding title", t)?,
            None => proposal.title.clone(),
        };
        let why_it_matters = match input.why_it_matters {
            Some(w) => sanitize_body(
                "finding why it matters",
                w,
                MAX_FINDING_WHY_IT_MATTERS_BYTES,
            )?,
            None => proposal.why_it_matters.clone(),
        };
        let event_refs: Vec<BookmarkEventRef> = proposal
            .evidence
            .iter()
            .filter(|c| c.role == ProposalEvidenceRole::Supporting)
            .map(|c| c.event_ref.clone())
            .collect();
        let event_refs = if event_refs.is_empty() {
            proposal
                .evidence
                .iter()
                .map(|c| c.event_ref.clone())
                .collect()
        } else {
            event_refs
        };
        let event_refs = canonicalize_exact_event_refs(corpus, event_refs)?;
        let view_recipe = proposal.view_recipe.clone();
        let binding =
            proposal
                .policy_binding
                .clone()
                .unwrap_or(InvestigationPolicyBinding::capture(
                    corpus,
                    InvestigationNoiseLens::Active,
                )?);

        // Publish human finding via internal path with policy binding.
        let finding_input = AddFindingInput {
            kind,
            title: title.clone(),
            why_it_matters: why_it_matters.clone(),
            event_refs,
            view_recipe,
        };
        // Use current document revision after checks — accept is one mutation.
        let now = crate::embed::now_unix_secs();
        advance_revision(&mut document, now)?;

        // Re-find index after advance doesn't change proposed_findings order.
        let idx = document
            .proposed_findings
            .iter()
            .position(|p| p.id == input.proposal_id)
            .expect("proposal still present");

        // Append finding (mirror add_human_finding_internal core without second publish).
        let event_refs = finding_input.event_refs.clone();
        let event_refs = canonicalize_exact_event_refs(corpus, event_refs)?;
        let view_recipe = finding_input
            .view_recipe
            .map(|recipe| canonicalize_finding_view_recipe(recipe, corpus))
            .transpose()?;
        if document.findings.len() >= MAX_INVESTIGATION_FINDINGS {
            return Err(CoreError::Message(format!(
                "investigation exceeds {MAX_INVESTIGATION_FINDINGS} findings"
            )));
        }
        let evidence_id =
            reuse_or_append_exact_evidence(&mut document, &title, corpus.id(), event_refs.clone())?;
        let finding_id = Uuid::now_v7().to_string();
        document.findings.push(FindingItem {
            id: finding_id.clone(),
            kind,
            lifecycle: FindingLifecycle::Accepted,
            title,
            why_it_matters,
            evidence_ids: vec![evidence_id],
            view_recipe,
            policy_binding: Some(binding),
            provenance: HumanProvenance::Human,
            created_at: now,
            updated_at: now,
        });

        document.proposed_findings[idx].status = ProposedFindingStatus::Accepted;
        document.proposed_findings[idx].acceptance = Some(HumanProposalAcceptance {
            accepted_at: now,
            edited,
        });
        document.proposed_findings[idx].accepted_finding_id = Some(finding_id);
        document.proposed_findings[idx].updated_at = now;
        // Proposal provenance and original title/why remain inspectable history.

        let directory = self.investigation_directory(investigation_id)?;
        publish_revision(&directory, &document)?;
        resolve_document_with_policy_lens(document, corpus, Some(InvestigationNoiseLens::Active))
    }

    /// Explicit Dismiss-with-reason. History remains inspectable.
    pub fn dismiss_proposed_finding(
        &self,
        corpus: &LogCorpus,
        investigation_id: &str,
        input: DismissProposedFindingInput,
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
            .proposed_findings
            .iter()
            .position(|p| p.id == input.proposal_id)
            .ok_or_else(|| {
                propose_repair_error(
                    ProposeFindingErrorCode::InvalidInput,
                    format!("proposal {} not found", input.proposal_id),
                )
            })?;
        if document.proposed_findings[idx].status != ProposedFindingStatus::Proposed {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidLifecycle,
                format!(
                    "proposal {} is {:?} and cannot be dismissed",
                    input.proposal_id, document.proposed_findings[idx].status
                ),
            ));
        }
        let now = crate::embed::now_unix_secs();
        advance_revision(&mut document, now)?;
        let idx = document
            .proposed_findings
            .iter()
            .position(|p| p.id == input.proposal_id)
            .expect("proposal still present");
        document.proposed_findings[idx].status = ProposedFindingStatus::Dismissed;
        document.proposed_findings[idx].dismiss_reason = Some(reason);
        document.proposed_findings[idx].updated_at = now;
        let directory = self.investigation_directory(investigation_id)?;
        publish_revision(&directory, &document)?;
        resolve_document_with_policy_lens(document, corpus, Some(InvestigationNoiseLens::Active))
    }

    /// Open Proposed items only (accepted/dismissed remain loadable via full document).
    pub fn list_open_proposals(
        &self,
        investigation_id: &str,
    ) -> CoreResult<Vec<ProposedFindingItem>> {
        let document = self.load_document(investigation_id)?;
        Ok(document
            .proposed_findings
            .into_iter()
            .filter(|p| p.status == ProposedFindingStatus::Proposed)
            .collect())
    }
}

fn sanitize_idempotency_key(key: String) -> CoreResult<String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            "idempotency_key must not be empty",
        ));
    }
    if key.len() > MAX_PROPOSAL_IDEMPOTENCY_KEY_BYTES {
        return Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            format!("idempotency_key exceeds {MAX_PROPOSAL_IDEMPOTENCY_KEY_BYTES} bytes"),
        ));
    }
    if key.contains('\0') || key.contains('/') || key.contains('\\') {
        return Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            "idempotency_key contains forbidden characters",
        ));
    }
    Ok(key)
}

fn sanitize_provenance_field(label: &str, value: Option<String>) -> CoreResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_PROPOSAL_PROVENANCE_FIELD_BYTES {
        return Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            format!("{label} exceeds {MAX_PROPOSAL_PROVENANCE_FIELD_BYTES} bytes"),
        ));
    }
    // Refuse credential-looking material in provenance fields.
    let redacted = crate::redact::redact_candidate(&value);
    if redacted.redacted || redacted.blocked || redacted.text != value {
        return Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            format!("{label} must not contain credential-shaped material"),
        ));
    }
    if value.contains('/') || value.contains('\\') || value.contains('\0') {
        return Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            format!("{label} must not contain path separators"),
        ));
    }
    Ok(Some(value))
}

fn sanitize_provenance(p: ProposalProvenance) -> CoreResult<ProposalProvenance> {
    let tool_name = p.tool_name.trim().to_string();
    if tool_name.is_empty() || tool_name.len() > MAX_PROPOSAL_PROVENANCE_FIELD_BYTES {
        return Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            "tool_name is required and bounded",
        ));
    }
    Ok(ProposalProvenance {
        source: p.source,
        provider: sanitize_provenance_field("provider", p.provider)?,
        model_id: sanitize_provenance_field("model_id", p.model_id)?,
        run_id: sanitize_provenance_field("run_id", p.run_id)?,
        tool_name,
        detector_id: sanitize_provenance_field("detector_id", p.detector_id)?,
    })
}

fn sanitize_rank_inputs(r: ProposalRankInputs) -> CoreResult<ProposalRankInputs> {
    if r.supporting_count > MAX_PROPOSAL_EVIDENCE_REFS as u32
        || r.contradicting_count > MAX_PROPOSAL_EVIDENCE_REFS as u32
    {
        return Err(propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            "rank_inputs counts exceed evidence bounds",
        ));
    }
    if let Some(w) = r.level_weight {
        if w > 100 {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                "level_weight must be 0..=100",
            ));
        }
    }
    Ok(r)
}

/// Parse propose tool arguments into [`ProposeFindingInput`] (strict, compact).
pub fn propose_finding_input_from_tool_args(
    args: &Value,
    investigation_id: String,
    expected_revision: u64,
) -> CoreResult<ProposeFindingInput> {
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
    let kind = match args.get("kind").and_then(|v| v.as_str()).unwrap_or("") {
        "observation" => FindingKind::Observation,
        "inference" => FindingKind::Inference,
        "hypothesis" => FindingKind::Hypothesis,
        other => {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                format!("kind must be observation|inference|hypothesis, got {other:?}"),
            ))
        }
    };
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            propose_repair_error(ProposeFindingErrorCode::InvalidInput, "title is required")
        })?
        .to_string();
    let why_it_matters = args
        .get("why_it_matters")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                "why_it_matters is required",
            )
        })?
        .to_string();
    let caveats = args
        .get("caveats")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let evidence = parse_evidence_array(args.get("evidence"))?;
    let view_recipe = match args.get("view_recipe") {
        None | Some(Value::Null) => None,
        Some(v) => Some(serde_json::from_value(v.clone()).map_err(|e| {
            propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                format!("view_recipe: {e}"),
            )
        })?),
    };
    let template_revision = args.get("template_revision").and_then(|v| v.as_u64());
    let suppression_policy_revision = args
        .get("suppression_policy_revision")
        .and_then(|v| v.as_u64());
    let rank_inputs = match args.get("rank_inputs") {
        None | Some(Value::Null) => None,
        Some(v) => Some(serde_json::from_value(v.clone()).map_err(|e| {
            propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                format!("rank_inputs: {e}"),
            )
        })?),
    };
    let provenance = parse_provenance(args.get("provenance"))?;
    Ok(ProposeFindingInput {
        investigation_id,
        expected_revision,
        idempotency_key,
        kind,
        title,
        why_it_matters,
        caveats,
        evidence,
        view_recipe,
        template_revision,
        suppression_policy_revision,
        rank_inputs,
        provenance,
        noise_lens: None,
    })
}

fn parse_evidence_array(value: Option<&Value>) -> CoreResult<Vec<ProposalEvidenceCitation>> {
    let arr = value.and_then(|v| v.as_array()).ok_or_else(|| {
        propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            "evidence array is required",
        )
    })?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let event_ref: BookmarkEventRef =
            serde_json::from_value(item.get("event_ref").cloned().ok_or_else(|| {
                propose_repair_error(
                    ProposeFindingErrorCode::InvalidInput,
                    "evidence[].event_ref is required",
                )
            })?)
            .map_err(|e| {
                propose_repair_error(
                    ProposeFindingErrorCode::BadEvidenceIdentity,
                    format!("event_ref: {e}"),
                )
            })?;
        let role = match item
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("supporting")
        {
            "supporting" => ProposalEvidenceRole::Supporting,
            "contradicting" => ProposalEvidenceRole::Contradicting,
            other => {
                return Err(propose_repair_error(
                    ProposeFindingErrorCode::InvalidInput,
                    format!("evidence role must be supporting|contradicting, got {other:?}"),
                ))
            }
        };
        out.push(ProposalEvidenceCitation { event_ref, role });
    }
    Ok(out)
}

fn parse_provenance(value: Option<&Value>) -> CoreResult<ProposalProvenance> {
    let obj = value.and_then(|v| v.as_object()).ok_or_else(|| {
        propose_repair_error(
            ProposeFindingErrorCode::InvalidInput,
            "provenance object is required",
        )
    })?;
    let source = match obj
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("model")
    {
        "model" => ProposalSourceKind::Model,
        "detector" => ProposalSourceKind::Detector,
        "internal" => ProposalSourceKind::Internal,
        other => {
            return Err(propose_repair_error(
                ProposeFindingErrorCode::InvalidInput,
                format!("provenance.source invalid: {other:?}"),
            ))
        }
    };
    let tool_name = obj
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or(PROPOSE_FINDING_TOOL)
        .to_string();
    Ok(ProposalProvenance {
        source,
        provider: obj
            .get("provider")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        model_id: obj
            .get("model_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        run_id: obj
            .get("run_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        tool_name,
        detector_id: obj
            .get("detector_id")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Stable tool name for agent-proposed findings (#646).
pub const PROPOSE_FINDING_TOOL: &str = "propose_finding";

/// Compact SoftWrite tool spec for linked tools-enabled chat.
pub fn propose_finding_tool_spec() -> crate::tools::ToolSpec {
    use crate::tools::{ToolSideEffect, ToolSpec};
    use serde_json::json;
    ToolSpec {
        name: PROPOSE_FINDING_TOOL.into(),
        description: "Propose a structured finding for human review on the linked Investigation. \
Creates only a Proposed item — never accepted evidence, never Explorer mutation. \
Requires exact event identities from prior search_logs. SoftWrite: durable proposal queue only."
            .into(),
        side_effect: ToolSideEffect::SoftWrite,
        parameters: json!({
            "type": "object",
            "properties": {
                "investigation_id": { "type": "string", "description": "Active investigation UUIDv7" },
                "expected_revision": { "type": "integer", "minimum": 1 },
                "idempotency_key": { "type": "string", "maxLength": 128 },
                "kind": { "type": "string", "enum": ["observation", "inference", "hypothesis"] },
                "title": { "type": "string", "maxLength": 256 },
                "why_it_matters": { "type": "string", "maxLength": 4096 },
                "caveats": { "type": "string", "maxLength": 2048 },
                "evidence": {
                    "type": "array",
                    "maxItems": 32,
                    "items": {
                        "type": "object",
                        "properties": {
                            "event_ref": {
                                "type": "object",
                                "properties": {
                                    "corpusId": { "type": "string" },
                                    "seq": { "type": "integer" },
                                    "source": { "type": "string" },
                                    "timestampHint": { "type": "integer" },
                                    "timeQualityHint": { "type": "string" }
                                },
                                "required": ["corpusId", "seq", "source", "timestampHint", "timeQualityHint"]
                            },
                            "role": { "type": "string", "enum": ["supporting", "contradicting"] }
                        },
                        "required": ["event_ref", "role"]
                    }
                },
                "template_revision": { "type": "integer" },
                "suppression_policy_revision": { "type": "integer" },
                "rank_inputs": {
                    "type": "object",
                    "properties": {
                        "supportingCount": { "type": "integer" },
                        "contradictingCount": { "type": "integer" },
                        "timeSpanSecs": { "type": "integer" },
                        "levelWeight": { "type": "integer", "minimum": 0, "maximum": 100 }
                    }
                },
                "provenance": {
                    "type": "object",
                    "properties": {
                        "source": { "type": "string", "enum": ["model", "detector", "internal"] },
                        "provider": { "type": "string" },
                        "model_id": { "type": "string" },
                        "run_id": { "type": "string" },
                        "tool_name": { "type": "string" },
                        "detector_id": { "type": "string" }
                    },
                    "required": ["source", "tool_name"]
                }
            },
            "required": [
                "investigation_id",
                "expected_revision",
                "idempotency_key",
                "kind",
                "title",
                "why_it_matters",
                "evidence",
                "provenance"
            ],
            "additionalProperties": false
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::{ActiveTimestampBasis, LogEvent, TimeQuality, TimestampProvenance};

    fn fixture_corpus(cache: &tempfile::TempDir) -> LogCorpus {
        let corpus = LogCorpus::create(cache.path(), "propose fixture").unwrap();
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
                    message: "retry".into(),
                    source: "api/app.log".into(),
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

    fn base_input(
        corpus: &LogCorpus,
        investigation_id: &str,
        revision: u64,
    ) -> ProposeFindingInput {
        ProposeFindingInput {
            investigation_id: investigation_id.into(),
            expected_revision: revision,
            idempotency_key: "det-key-1".into(),
            kind: FindingKind::Hypothesis,
            title: "Checkout failure cluster".into(),
            why_it_matters: "First error anchors the retry sequence.".into(),
            caveats: Some("Single source sample.".into()),
            evidence: vec![
                ProposalEvidenceCitation {
                    event_ref: event_ref(corpus, 10, "api/app.log", 1_700_000_010),
                    role: ProposalEvidenceRole::Supporting,
                },
                ProposalEvidenceCitation {
                    event_ref: event_ref(corpus, 11, "api/app.log", 1_700_000_011),
                    role: ProposalEvidenceRole::Contradicting,
                },
            ],
            view_recipe: None,
            template_revision: None,
            suppression_policy_revision: None,
            rank_inputs: Some(ProposalRankInputs {
                supporting_count: 1,
                contradicting_count: 1,
                time_span_secs: Some(1),
                level_weight: Some(80),
            }),
            provenance: ProposalProvenance {
                source: ProposalSourceKind::Detector,
                provider: None,
                model_id: None,
                run_id: Some("run-1".into()),
                tool_name: PROPOSE_FINDING_TOOL.into(),
                detector_id: Some("deterministic-v1".into()),
            },
            noise_lens: Some(InvestigationNoiseLens::Active),
        }
    }

    #[test]
    fn propose_creates_only_proposed_never_accepted_finding() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = fixture_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let doc = store.create("Propose only", &corpus).unwrap();
        let resolved = store
            .propose_finding(&corpus, base_input(&corpus, &doc.id, 1))
            .unwrap();
        assert_eq!(resolved.document.proposed_findings.len(), 1);
        let p = &resolved.document.proposed_findings[0];
        assert_eq!(p.status, ProposedFindingStatus::Proposed);
        assert!(p.acceptance.is_none());
        assert!(p.accepted_finding_id.is_none());
        // No accepted human findings from propose alone.
        assert!(resolved.document.findings.is_empty());
        assert_eq!(resolved.document.revision, 2);
        // Privacy: serialized document has no message payload.
        let rev_path = durable
            .path()
            .join(&doc.id)
            .join(revision_filename(resolved.document.revision));
        let text = std::fs::read_to_string(&rev_path).expect("revision file exists");
        assert!(!text.contains("checkout failed"));
        assert!(!text.contains("sk-proj"));
        assert!(text.contains("proposed"));
    }

    #[test]
    fn propose_idempotent_retry_does_not_duplicate() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = fixture_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let doc = store.create("Idempotent", &corpus).unwrap();
        let first = store
            .propose_finding(&corpus, base_input(&corpus, &doc.id, 1))
            .unwrap();
        let second = store
            .propose_finding(
                &corpus,
                base_input(&corpus, &doc.id, first.document.revision),
            )
            .unwrap();
        // Same key → no new revision / no second proposal.
        assert_eq!(second.document.revision, first.document.revision);
        assert_eq!(second.document.proposed_findings.len(), 1);
        assert_eq!(
            second.document.proposed_findings[0].id,
            first.document.proposed_findings[0].id
        );
    }

    #[test]
    fn propose_fail_closed_wrong_corpus_stale_rev_missing_and_cross_corpus() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = fixture_corpus(&cache);
        let other_cache = tempfile::tempdir().unwrap();
        let other = fixture_corpus(&other_cache);
        let store = InvestigationStore::new(durable.path());
        let doc = store.create("Fail closed", &corpus).unwrap();

        // Stale revision
        let err = store
            .propose_finding(&corpus, base_input(&corpus, &doc.id, 99))
            .unwrap_err()
            .to_string();
        assert!(err.contains("stale_revision"), "{err}");

        // Cross-corpus identity
        let mut bad = base_input(&corpus, &doc.id, 1);
        bad.evidence[0].event_ref.corpus_id = other.id().to_string();
        let err = store.propose_finding(&corpus, bad).unwrap_err().to_string();
        assert!(
            err.contains("bad_evidence_identity") || err.contains("cross-corpus"),
            "{err}"
        );

        // Missing seq
        let mut missing = base_input(&corpus, &doc.id, 1);
        missing.evidence[0].event_ref.seq = 999;
        let err = store
            .propose_finding(&corpus, missing)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("bad_evidence_identity")
                || err.contains("missing")
                || err.contains("not found")
                || err.contains("seq"),
            "{err}"
        );

        // Wrong corpus document
        let err = store
            .propose_finding(&other, base_input(&other, &doc.id, 1))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("wrong_corpus") || err.contains("corpus"),
            "{err}"
        );
    }

    #[test]
    fn accept_preserves_proposal_provenance_and_edit_does_not_rewrite_history() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = fixture_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let doc = store.create("Accept", &corpus).unwrap();
        let proposed = store
            .propose_finding(&corpus, base_input(&corpus, &doc.id, 1))
            .unwrap();
        let proposal_id = proposed.document.proposed_findings[0].id.clone();
        let original_title = proposed.document.proposed_findings[0].title.clone();
        let original_prov = proposed.document.proposed_findings[0].provenance.clone();

        let accepted = store
            .accept_proposed_finding(
                &corpus,
                &doc.id,
                AcceptProposedFindingInput {
                    proposal_id: proposal_id.clone(),
                    expected_revision: proposed.document.revision,
                    edited: true,
                    kind: None,
                    title: Some("Human edited title".into()),
                    why_it_matters: None,
                },
            )
            .unwrap();
        assert_eq!(accepted.document.findings.len(), 1);
        assert_eq!(accepted.document.findings[0].title, "Human edited title");
        assert_eq!(
            accepted.document.findings[0].lifecycle,
            FindingLifecycle::Accepted
        );
        let p = &accepted.document.proposed_findings[0];
        assert_eq!(p.status, ProposedFindingStatus::Accepted);
        assert_eq!(p.title, original_title, "proposal history title preserved");
        assert_eq!(p.provenance, original_prov);
        assert!(p.acceptance.as_ref().unwrap().edited);
        assert_eq!(
            p.accepted_finding_id.as_deref(),
            Some(accepted.document.findings[0].id.as_str())
        );
    }

    #[test]
    fn dismiss_records_reason_and_cannot_silently_reappear_as_open() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = fixture_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let doc = store.create("Dismiss", &corpus).unwrap();
        let proposed = store
            .propose_finding(&corpus, base_input(&corpus, &doc.id, 1))
            .unwrap();
        let proposal_id = proposed.document.proposed_findings[0].id.clone();
        let dismissed = store
            .dismiss_proposed_finding(
                &corpus,
                &doc.id,
                DismissProposedFindingInput {
                    proposal_id: proposal_id.clone(),
                    expected_revision: proposed.document.revision,
                    reason: "Not actionable for this incident".into(),
                },
            )
            .unwrap();
        assert_eq!(
            dismissed.document.proposed_findings[0].status,
            ProposedFindingStatus::Dismissed
        );
        assert_eq!(
            dismissed.document.proposed_findings[0]
                .dismiss_reason
                .as_deref(),
            Some("Not actionable for this incident")
        );
        let open = store.list_open_proposals(&doc.id).unwrap();
        assert!(open.is_empty());
        // History still loadable
        let loaded = store.load(&doc.id, &corpus).unwrap();
        assert_eq!(loaded.document.proposed_findings.len(), 1);
        assert_eq!(
            loaded.document.proposed_findings[0].status,
            ProposedFindingStatus::Dismissed
        );
    }

    #[test]
    fn concurrent_accept_second_fails_closed_on_revision() {
        let cache = tempfile::tempdir().unwrap();
        let durable = tempfile::tempdir().unwrap();
        let corpus = fixture_corpus(&cache);
        let store = InvestigationStore::new(durable.path());
        let doc = store.create("Concurrent", &corpus).unwrap();
        let mut input2 = base_input(&corpus, &doc.id, 1);
        input2.idempotency_key = "det-key-2".into();
        let p1 = store
            .propose_finding(&corpus, base_input(&corpus, &doc.id, 1))
            .unwrap();
        let p2 = store
            .propose_finding(&corpus, {
                let mut i = input2;
                i.expected_revision = p1.document.revision;
                i
            })
            .unwrap();
        let id1 = p1.document.proposed_findings[0].id.clone();
        let id2 = p2
            .document
            .proposed_findings
            .iter()
            .find(|p| p.id != id1)
            .unwrap()
            .id
            .clone();
        let rev = p2.document.revision;
        store
            .accept_proposed_finding(
                &corpus,
                &doc.id,
                AcceptProposedFindingInput {
                    proposal_id: id1,
                    expected_revision: rev,
                    edited: false,
                    kind: None,
                    title: None,
                    why_it_matters: None,
                },
            )
            .unwrap();
        let err = store
            .accept_proposed_finding(
                &corpus,
                &doc.id,
                AcceptProposedFindingInput {
                    proposal_id: id2,
                    expected_revision: rev, // stale
                    edited: false,
                    kind: None,
                    title: None,
                    why_it_matters: None,
                },
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("stale_revision"), "{err}");
    }
}
