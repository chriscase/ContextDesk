//! Local, host-owned validation of one fast-model proposal.
//!
//! Every check here is decidable from host facts alone — the immutable ledger,
//! the packet's scope assignment, and the packet's chronology ordinals. None of
//! them asks the model to be trusted about anything, and none of them invents a
//! fact the host does not hold:
//!
//! * where the host has **no** role evidence, role checks abstain rather than
//!   pass (see [`super::packet::FastTriageRoleEvidence`]);
//! * where the host **does** hold a role, a proposal that contradicts it is
//!   rejected, not renegotiated;
//! * a claim's *own* internal contradictions are always checkable, so those are
//!   enforced regardless of what the host knows semantically.
//!
//! Authority is [`crate::investigation_answer::validate_model_answer`] — the
//! same validator every other typed answer path uses. This module adds the
//! stricter requirements that belong to *this* contract (a fast model handed a
//! complete packet), and translates every outcome into stable, content-free
//! categories that a correction, an escalation, and telemetry can all read.

use std::collections::{BTreeMap, BTreeSet};

use crate::investigation_answer::{
    validate_model_answer, AnswerEnvelopeV1, ClaimKind, ClaimStatus, EvidenceRole, ValidationError,
};

use super::packet::{FastTriageEvidenceScope, FastTriagePacketV1};

/// Stable, content-free reason one fast proposal was not accepted.
///
/// Every variant is a *host* label. None of them carries the rejected proposal,
/// any evidence text, or any provider detail, so all three consumers — the
/// bounded correction, the escalation request, and telemetry — can read the
/// same value without any of them becoming a leak.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageFailureCategory {
    /// No visible content survived reasoning removal.
    EmptyVisibleAnswer,
    /// Visible content was not exactly one JSON object.
    MalformedTerminal,
    /// The object did not use the host answer schema / model-owned fields.
    SchemaMismatch,
    /// A candidate, claim, or evidence id was repeated where it must be unique.
    DuplicateId,
    /// A cited evidence id was not minted by the host for this packet.
    ForeignEvidenceId,
    /// A cited evidence id belongs to a different candidate than the claim.
    CrossCandidateEvidence,
    /// A cited row is outside this turn's corpus/revision snapshot.
    StaleEvidenceRevision,
    /// A claim outside `missing_evidence` cited no permitted evidence.
    UngroundedClaim,
    /// An initiating cause was asserted without host cause-role support.
    RootUnsupported,
    /// Host-labelled downstream symptom evidence was placed in a causal or
    /// initiating-cause section.
    SymptomPromotedToCause,
    /// Separately scoped chronology evidence was pulled into a causal chain.
    IndependentEvidencePromoted,
    /// Within one candidate, the asserted cause is strictly later than the
    /// symptom it is offered to explain.
    ChronologyInverted,
    /// A host-labelled cause or symptom row was omitted from the sections the
    /// host requires it to appear in.
    RoleCoverage,
    /// One evidence id was cited in two mutually exclusive roles.
    ContradictoryRoles,
    /// A permitted candidate received no grounded claim at all.
    CitationIncomplete,
    /// The packet backing this validation is not the packet that was sent.
    PacketIdentityChanged,
    /// The host packet itself did not hold (empty, unbound, or digest drift).
    HostPacketInvalid,
}

impl FastTriageFailureCategory {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EmptyVisibleAnswer => "empty_visible_answer",
            Self::MalformedTerminal => "malformed_terminal",
            Self::SchemaMismatch => "schema_mismatch",
            Self::DuplicateId => "duplicate_id",
            Self::ForeignEvidenceId => "foreign_evidence_id",
            Self::CrossCandidateEvidence => "cross_candidate_evidence",
            Self::StaleEvidenceRevision => "stale_evidence_revision",
            Self::UngroundedClaim => "ungrounded_claim",
            Self::RootUnsupported => "root_unsupported",
            Self::SymptomPromotedToCause => "symptom_promoted_to_cause",
            Self::IndependentEvidencePromoted => "independent_evidence_promoted",
            Self::ChronologyInverted => "chronology_inverted",
            Self::RoleCoverage => "role_coverage",
            Self::ContradictoryRoles => "contradictory_roles",
            Self::CitationIncomplete => "citation_incomplete",
            Self::PacketIdentityChanged => "packet_identity_changed",
            Self::HostPacketInvalid => "host_packet_invalid",
        }
    }

    /// Translate one shared-validator error into this contract's vocabulary.
    pub fn from_validation_error(error: &ValidationError) -> Self {
        match error {
            ValidationError::Parse => Self::MalformedTerminal,
            ValidationError::Schema => Self::SchemaMismatch,
            ValidationError::DuplicateId => Self::DuplicateId,
            ValidationError::UnknownEvidence => Self::ForeignEvidenceId,
            ValidationError::WrongScope => Self::CrossCandidateEvidence,
            ValidationError::WrongRevision => Self::StaleEvidenceRevision,
            ValidationError::EmptyEvidence => Self::UngroundedClaim,
            ValidationError::RootRole => Self::RootUnsupported,
            ValidationError::RoleMismatch => Self::SymptomPromotedToCause,
            ValidationError::RoleCoverage => Self::RoleCoverage,
            ValidationError::EmptyLedger
            | ValidationError::InvalidBinding
            | ValidationError::DigestMismatch => Self::HostPacketInvalid,
        }
    }

    /// Whether this category describes a packet/host problem rather than
    /// something the model could repair. These never earn a correction: asking
    /// a model to fix the host's own evidence would be theatre.
    pub fn is_host_side(self) -> bool {
        matches!(self, Self::PacketIdentityChanged | Self::HostPacketInvalid)
    }
}

/// Outcome of validating one proposal against one packet.
#[derive(Debug, Clone)]
pub enum FastTriageValidation {
    /// The host validated the proposal into a typed envelope.
    Accepted(Box<AnswerEnvelopeV1>),
    /// The proposal was rejected. Categories are ordered and deduplicated; the
    /// first is the primary one a bounded correction addresses.
    Rejected(Vec<FastTriageFailureCategory>),
}

impl FastTriageValidation {
    /// The primary category, when rejected.
    pub fn primary_category(&self) -> Option<FastTriageFailureCategory> {
        match self {
            Self::Accepted(_) => None,
            Self::Rejected(categories) => categories.first().copied(),
        }
    }

    /// All categories, when rejected.
    pub fn categories(&self) -> &[FastTriageFailureCategory] {
        match self {
            Self::Accepted(_) => &[],
            Self::Rejected(categories) => categories,
        }
    }
}

/// Claim kinds that place evidence inside a candidate's causal chain.
const CHAIN_KINDS: [ClaimKind; 3] = [
    ClaimKind::Symptom,
    ClaimKind::CausalCandidate,
    ClaimKind::InitiatingCause,
];

fn is_chain_kind(kind: ClaimKind) -> bool {
    CHAIN_KINDS.contains(&kind)
}

/// Validate one typed proposal against one complete host packet.
///
/// The shared validator runs first: if the proposal cannot even be bound to the
/// ledger there is nothing further to say about roles or chronology, and
/// reporting a speculative second reason would be noise. Once bound, every
/// contract-specific check runs and *all* violated categories are reported, so
/// an escalation carries the full picture rather than only the first tripwire.
pub fn validate_fast_answer(object: &str, packet: &FastTriagePacketV1) -> FastTriageValidation {
    let envelope = match validate_model_answer(object, packet.ledger()) {
        Ok(envelope) => envelope,
        Err(error) => {
            return FastTriageValidation::Rejected(vec![
                FastTriageFailureCategory::from_validation_error(&error),
            ])
        }
    };

    let mut categories = BTreeSet::new();

    // Every cited id already resolves to a permitted row (the shared validator
    // proved that), so a missing row here is impossible rather than tolerated.
    let mut cited_kinds: BTreeMap<&str, BTreeSet<ClaimKind>> = BTreeMap::new();
    let mut candidate_has_grounded_claim: BTreeMap<&str, bool> = packet
        .rows()
        .iter()
        .map(|row| (row.candidate_id.as_str(), false))
        .collect();
    // Earliest host ordinal cited per (candidate, kind), for chronology.
    let mut earliest: BTreeMap<(&str, ClaimKind), u64> = BTreeMap::new();
    // Host-labelled rows the answer must place somewhere specific.
    let mut cause_rows: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let mut symptom_rows: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for row in packet.rows() {
        match row.role {
            EvidenceRole::Cause => {
                cause_rows
                    .entry(row.candidate_id.as_str())
                    .or_default()
                    .insert(row.evidence_id.as_str());
            }
            EvidenceRole::Symptom => {
                symptom_rows
                    .entry(row.candidate_id.as_str())
                    .or_default()
                    .insert(row.evidence_id.as_str());
            }
            EvidenceRole::Supporting | EvidenceRole::Neutral => {}
        }
    }

    for candidate in &envelope.answer.candidates {
        for claim in &candidate.claims {
            if !claim.evidence_ids.is_empty() {
                candidate_has_grounded_claim.insert(candidate.candidate_id.as_str(), true);
            }
            // An initiating cause the host would not establish must not be
            // presented as one. The shared validator already withheld it; for
            // this contract that is a rejection the model can repair by using
            // `causal_candidates` instead of asserting a root.
            if claim.claim_kind == ClaimKind::InitiatingCause
                && claim.status == ClaimStatus::Withheld
            {
                categories.insert(FastTriageFailureCategory::RootUnsupported);
            }
            for evidence_id in &claim.evidence_ids {
                let Some(row) = packet.row(evidence_id) else {
                    continue;
                };
                cited_kinds
                    .entry(row.evidence_id.as_str())
                    .or_default()
                    .insert(claim.claim_kind);
                if let Some(ordinal) = row.chronology_ordinal {
                    earliest
                        .entry((candidate.candidate_id.as_str(), claim.claim_kind))
                        .and_modify(|current| *current = (*current).min(ordinal))
                        .or_insert(ordinal);
                }
                // Host-labelled downstream symptom evidence may never carry a
                // causal or initiating role. The shared validator covers the
                // causal-candidate case; initiating causes are covered here so
                // the two sections cannot disagree.
                if row.role == EvidenceRole::Symptom
                    && matches!(
                        claim.claim_kind,
                        ClaimKind::CausalCandidate | ClaimKind::InitiatingCause
                    )
                {
                    categories.insert(FastTriageFailureCategory::SymptomPromotedToCause);
                }
                // Separately scoped chronology is descriptive. Order alone
                // never grants causal, support, or symptom authority, so its
                // rows may only be observed, competed, or declared missing.
                if row.scope == FastTriageEvidenceScope::Independent
                    && is_chain_kind(claim.claim_kind)
                {
                    categories.insert(FastTriageFailureCategory::IndependentEvidencePromoted);
                }
            }
        }
    }

    // One evidence id cannot be both inside a candidate's causal chain and an
    // unrelated competing explanation, and cannot be both the initiating cause
    // and a downstream symptom of that same chain.
    for kinds in cited_kinds.values() {
        let in_chain = kinds.iter().copied().any(is_chain_kind);
        if in_chain && kinds.contains(&ClaimKind::CompetingExplanation) {
            categories.insert(FastTriageFailureCategory::ContradictoryRoles);
        }
        if kinds.contains(&ClaimKind::InitiatingCause) && kinds.contains(&ClaimKind::Symptom) {
            categories.insert(FastTriageFailureCategory::ContradictoryRoles);
        }
    }

    // A cause cannot be strictly later than the symptom it explains. Only rows
    // the host actually ordered participate; rows with no ordinal abstain.
    for candidate in &envelope.answer.candidates {
        let id = candidate.candidate_id.as_str();
        if let (Some(cause), Some(symptom)) = (
            earliest.get(&(id, ClaimKind::InitiatingCause)),
            earliest.get(&(id, ClaimKind::Symptom)),
        ) {
            if cause > symptom {
                categories.insert(FastTriageFailureCategory::ChronologyInverted);
            }
        }
    }

    // Host-labelled roles must survive into the answer. Omitting a known cause
    // or a known symptom is the usefulness failure this route exists to catch.
    let cited_in = |candidate_id: &str, kinds: &[ClaimKind], ids: &BTreeSet<&str>| -> bool {
        envelope
            .answer
            .candidates
            .iter()
            .find(|candidate| candidate.candidate_id == candidate_id)
            .is_some_and(|candidate| {
                candidate.claims.iter().any(|claim| {
                    kinds.contains(&claim.claim_kind)
                        && claim
                            .evidence_ids
                            .iter()
                            .any(|id| ids.contains(id.as_str()))
                })
            })
    };
    for (candidate_id, ids) in &cause_rows {
        if !cited_in(
            candidate_id,
            &[ClaimKind::CausalCandidate, ClaimKind::InitiatingCause],
            ids,
        ) {
            categories.insert(FastTriageFailureCategory::RoleCoverage);
        }
    }
    for (candidate_id, ids) in &symptom_rows {
        if !cited_in(candidate_id, &[ClaimKind::Symptom], ids) {
            categories.insert(FastTriageFailureCategory::RoleCoverage);
        }
    }

    // Every permitted candidate must receive at least one grounded claim. The
    // shared validator requires each candidate to be *present*; this requires
    // it to actually be answered.
    if candidate_has_grounded_claim
        .values()
        .any(|grounded| !grounded)
    {
        categories.insert(FastTriageFailureCategory::CitationIncomplete);
    }

    if categories.is_empty() {
        FastTriageValidation::Accepted(Box::new(envelope))
    } else {
        FastTriageValidation::Rejected(categories.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::investigation_answer::{
        AnswerBindingV1, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1, SCHEMA_V1,
    };
    use serde_json::json;

    fn revision() -> LogSnapshotRevisionV1 {
        LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 2,
            suppression_revision: 3,
        }
    }

    fn entry(
        evidence_id: &str,
        candidate_id: &str,
        seq: u64,
        role: EvidenceRole,
    ) -> HostEvidenceEntry {
        HostEvidenceEntry {
            evidence_id: evidence_id.into(),
            candidate_id: candidate_id.into(),
            source_label: "synthetic.log".into(),
            locator: format!("seq={seq}"),
            corpus_id: "c".into(),
            revision: revision(),
            role,
            content: format!("synthetic row {seq}"),
        }
    }

    fn packet_from(entries: Vec<HostEvidenceEntry>, independent: Option<&str>) -> FastTriagePacketV1 {
        let binding = AnswerBindingV1 {
            session_id: "s".into(),
            turn_id: "t".into(),
            corpus_id: "c".into(),
            revision: revision(),
            ledger_digest: HostEvidenceLedger::digest(&entries),
        };
        FastTriagePacketV1::from_ledger(
            HostEvidenceLedger::new(binding, entries).expect("ledger"),
            independent,
            true,
        )
    }

    /// Cause row in `g-a` at ordinal 10, symptom row in `g-b` at 20, and a
    /// separately scoped chronology row at 30.
    fn labelled_packet() -> FastTriagePacketV1 {
        packet_from(
            vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Cause),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Symptom),
                entry("e:tl:30", "tl", 30, EvidenceRole::Neutral),
            ],
            Some("tl"),
        )
    }

    fn claim(id: &str, evidence: &[&str]) -> serde_json::Value {
        json!({"claim_id": id, "text": "synthetic claim", "evidence_ids": evidence})
    }

    fn proposal(candidates: serde_json::Value) -> String {
        json!({"schema": SCHEMA_V1, "candidates": candidates}).to_string()
    }

    fn complete_correct() -> String {
        proposal(json!([
            {"candidate_id": "g-a", "initiating_causes": [claim("c1", &["e:g-a:10"])]},
            {"candidate_id": "g-b", "symptoms": [claim("s1", &["e:g-b:20"])]},
            {"candidate_id": "tl", "observations": [claim("o1", &["e:tl:30"])]},
        ]))
    }

    #[test]
    fn a_complete_correct_answer_is_accepted() {
        let validation = validate_fast_answer(&complete_correct(), &labelled_packet());
        let FastTriageValidation::Accepted(envelope) = validation else {
            panic!("expected acceptance, got {validation:?}");
        };
        assert!(envelope.answer.root_cause_established);
    }

    #[test]
    fn an_omitted_trigger_is_a_role_coverage_failure() {
        let omitted = proposal(json!([
            {"candidate_id": "g-a", "observations": [claim("o0", &["e:g-a:10"])]},
            {"candidate_id": "g-b", "symptoms": [claim("s1", &["e:g-b:20"])]},
            {"candidate_id": "tl", "observations": [claim("o1", &["e:tl:30"])]},
        ]));
        assert_eq!(
            validate_fast_answer(&omitted, &labelled_packet()).categories(),
            [FastTriageFailureCategory::RoleCoverage]
        );
    }

    #[test]
    fn a_symptom_promoted_to_a_cause_is_rejected_in_both_causal_sections() {
        // `causal_candidates` is caught by the shared validator …
        let as_candidate = proposal(json!([
            {"candidate_id": "g-a", "initiating_causes": [claim("c1", &["e:g-a:10"])]},
            {"candidate_id": "g-b", "causal_candidates": [claim("s1", &["e:g-b:20"])]},
            {"candidate_id": "tl", "observations": [claim("o1", &["e:tl:30"])]},
        ]));
        assert_eq!(
            validate_fast_answer(&as_candidate, &labelled_packet()).categories(),
            [FastTriageFailureCategory::SymptomPromotedToCause]
        );
        // … and `initiating_causes` by this contract's own check.
        let as_root = proposal(json!([
            {"candidate_id": "g-a", "initiating_causes": [claim("c1", &["e:g-a:10"])]},
            {"candidate_id": "g-b", "initiating_causes": [claim("s1", &["e:g-b:20"])]},
            {"candidate_id": "tl", "observations": [claim("o1", &["e:tl:30"])]},
        ]));
        let categories = validate_fast_answer(&as_root, &labelled_packet())
            .categories()
            .to_vec();
        assert!(categories.contains(&FastTriageFailureCategory::SymptomPromotedToCause));
        // The unsupported root is reported alongside it, not instead of it.
        assert!(categories.contains(&FastTriageFailureCategory::RootUnsupported));
        assert!(categories.contains(&FastTriageFailureCategory::RoleCoverage));
    }

    #[test]
    fn independent_chronology_may_never_enter_a_causal_chain() {
        for section in ["symptoms", "causal_candidates", "initiating_causes"] {
            let promoted = proposal(json!([
                {"candidate_id": "g-a", "initiating_causes": [claim("c1", &["e:g-a:10"])]},
                {"candidate_id": "g-b", "symptoms": [claim("s1", &["e:g-b:20"])]},
                {"candidate_id": "tl", section: [claim("o1", &["e:tl:30"])]},
            ]));
            let categories = validate_fast_answer(&promoted, &labelled_packet())
                .categories()
                .to_vec();
            assert!(
                categories.contains(&FastTriageFailureCategory::IndependentEvidencePromoted),
                "{section} must not admit chronology evidence"
            );
        }
    }

    #[test]
    fn a_foreign_or_cross_candidate_id_is_rejected_by_the_shared_validator() {
        let foreign = proposal(json!([
            {"candidate_id": "g-a", "initiating_causes": [claim("c1", &["e:not-minted:1"])]},
            {"candidate_id": "g-b", "symptoms": [claim("s1", &["e:g-b:20"])]},
            {"candidate_id": "tl", "observations": [claim("o1", &["e:tl:30"])]},
        ]));
        assert_eq!(
            validate_fast_answer(&foreign, &labelled_packet()).categories(),
            [FastTriageFailureCategory::ForeignEvidenceId]
        );
        let crossed = proposal(json!([
            {"candidate_id": "g-a", "initiating_causes": [claim("c1", &["e:g-b:20"])]},
            {"candidate_id": "g-b", "symptoms": [claim("s1", &["e:g-b:20"])]},
            {"candidate_id": "tl", "observations": [claim("o1", &["e:tl:30"])]},
        ]));
        assert_eq!(
            validate_fast_answer(&crossed, &labelled_packet()).categories(),
            [FastTriageFailureCategory::CrossCandidateEvidence]
        );
    }

    #[test]
    fn chronology_inversion_is_caught_within_one_candidate() {
        let packet = packet_from(
            vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Neutral),
                entry("e:g-a:90", "g-a", 90, EvidenceRole::Neutral),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Neutral),
            ],
            None,
        );
        // Cause at 90, symptom at 10: the asserted cause is later than what it
        // is offered to explain.
        let inverted = proposal(json!([
            {"candidate_id": "g-a",
             "initiating_causes": [claim("c1", &["e:g-a:90"])],
             "symptoms": [claim("s1", &["e:g-a:10"])]},
            {"candidate_id": "g-b", "observations": [claim("o1", &["e:g-b:20"])]},
        ]));
        let categories = validate_fast_answer(&inverted, &packet).categories().to_vec();
        assert!(categories.contains(&FastTriageFailureCategory::ChronologyInverted));
        // The same placement in the correct order is not a chronology failure.
        let ordered = proposal(json!([
            {"candidate_id": "g-a",
             "causal_candidates": [claim("c1", &["e:g-a:10"])],
             "symptoms": [claim("s1", &["e:g-a:90"])]},
            {"candidate_id": "g-b", "observations": [claim("o1", &["e:g-b:20"])]},
        ]));
        assert!(!validate_fast_answer(&ordered, &packet)
            .categories()
            .contains(&FastTriageFailureCategory::ChronologyInverted));
    }

    #[test]
    fn an_unsupported_root_is_rejected_when_the_host_holds_no_cause_evidence() {
        let neutral = packet_from(
            vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Neutral),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Neutral),
            ],
            None,
        );
        let asserted = proposal(json!([
            {"candidate_id": "g-a", "initiating_causes": [claim("c1", &["e:g-a:10"])]},
            {"candidate_id": "g-b", "observations": [claim("o1", &["e:g-b:20"])]},
        ]));
        assert_eq!(
            validate_fast_answer(&asserted, &neutral).categories(),
            [FastTriageFailureCategory::RootUnsupported]
        );
        // Offering it as a candidate rather than an established root passes.
        let honest = proposal(json!([
            {"candidate_id": "g-a", "causal_candidates": [claim("c1", &["e:g-a:10"])]},
            {"candidate_id": "g-b", "observations": [claim("o1", &["e:g-b:20"])]},
        ]));
        let FastTriageValidation::Accepted(envelope) = validate_fast_answer(&honest, &neutral) else {
            panic!("honest candidate answer must be accepted");
        };
        assert!(!envelope.answer.root_cause_established);
    }

    #[test]
    fn one_id_cannot_hold_two_mutually_exclusive_roles() {
        let neutral = packet_from(
            vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Neutral),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Neutral),
            ],
            None,
        );
        let contradictory = proposal(json!([
            {"candidate_id": "g-a",
             "causal_candidates": [claim("c1", &["e:g-a:10"])],
             "competing_explanations": [claim("x1", &["e:g-a:10"])]},
            {"candidate_id": "g-b", "observations": [claim("o1", &["e:g-b:20"])]},
        ]));
        assert!(validate_fast_answer(&contradictory, &neutral)
            .categories()
            .contains(&FastTriageFailureCategory::ContradictoryRoles));
    }

    #[test]
    fn a_candidate_with_no_grounded_claim_is_incomplete() {
        let neutral = packet_from(
            vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Neutral),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Neutral),
            ],
            None,
        );
        let hollow = proposal(json!([
            {"candidate_id": "g-a", "observations": [claim("o1", &["e:g-a:10"])]},
            {"candidate_id": "g-b", "missing_evidence": [claim("m1", &[] as &[&str])]},
        ]));
        assert_eq!(
            validate_fast_answer(&hollow, &neutral).categories(),
            [FastTriageFailureCategory::CitationIncomplete]
        );
    }

    #[test]
    fn categories_are_stable_content_free_and_ordered() {
        let categories = [
            FastTriageFailureCategory::EmptyVisibleAnswer,
            FastTriageFailureCategory::MalformedTerminal,
            FastTriageFailureCategory::SchemaMismatch,
            FastTriageFailureCategory::DuplicateId,
            FastTriageFailureCategory::ForeignEvidenceId,
            FastTriageFailureCategory::CrossCandidateEvidence,
            FastTriageFailureCategory::StaleEvidenceRevision,
            FastTriageFailureCategory::UngroundedClaim,
            FastTriageFailureCategory::RootUnsupported,
            FastTriageFailureCategory::SymptomPromotedToCause,
            FastTriageFailureCategory::IndependentEvidencePromoted,
            FastTriageFailureCategory::ChronologyInverted,
            FastTriageFailureCategory::RoleCoverage,
            FastTriageFailureCategory::ContradictoryRoles,
            FastTriageFailureCategory::CitationIncomplete,
            FastTriageFailureCategory::PacketIdentityChanged,
            FastTriageFailureCategory::HostPacketInvalid,
        ];
        let labels = categories.map(FastTriageFailureCategory::as_str);
        assert_eq!(
            labels.iter().collect::<BTreeSet<_>>().len(),
            labels.len(),
            "labels must be distinct"
        );
        assert!(FastTriageFailureCategory::PacketIdentityChanged.is_host_side());
        assert!(FastTriageFailureCategory::HostPacketInvalid.is_host_side());
        assert!(!FastTriageFailureCategory::RoleCoverage.is_host_side());
    }

    #[test]
    fn every_shared_validator_error_maps_to_one_category() {
        for (error, expected) in [
            (ValidationError::Parse, FastTriageFailureCategory::MalformedTerminal),
            (ValidationError::Schema, FastTriageFailureCategory::SchemaMismatch),
            (ValidationError::DuplicateId, FastTriageFailureCategory::DuplicateId),
            (
                ValidationError::UnknownEvidence,
                FastTriageFailureCategory::ForeignEvidenceId,
            ),
            (
                ValidationError::WrongScope,
                FastTriageFailureCategory::CrossCandidateEvidence,
            ),
            (
                ValidationError::WrongRevision,
                FastTriageFailureCategory::StaleEvidenceRevision,
            ),
            (
                ValidationError::EmptyEvidence,
                FastTriageFailureCategory::UngroundedClaim,
            ),
            (ValidationError::RootRole, FastTriageFailureCategory::RootUnsupported),
            (
                ValidationError::RoleMismatch,
                FastTriageFailureCategory::SymptomPromotedToCause,
            ),
            (ValidationError::RoleCoverage, FastTriageFailureCategory::RoleCoverage),
            (
                ValidationError::DigestMismatch,
                FastTriageFailureCategory::HostPacketInvalid,
            ),
        ] {
            assert_eq!(
                FastTriageFailureCategory::from_validation_error(&error),
                expected
            );
        }
    }
}
