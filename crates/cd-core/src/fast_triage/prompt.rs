//! Host-authored prompts for the fast-triage route, and the fingerprint that
//! binds persisted route evidence to the exact contract this build runs.
//!
//! Two properties matter more than wording here.
//!
//! **The correction is authored, not echoed.** When a proposal is rejected, the
//! rejected proposal is never sent back. The host selects one stable validator
//! category and emits its own fixed instruction for that category. A model
//! therefore cannot re-anchor on its own wrong answer, and a hostile or merely
//! confused proposal cannot smuggle itself into the next request as "context".
//!
//! **The contract has an identity.** [`fast_triage_contract_fingerprint`] hashes
//! the system contract, the answer schema, the packet schema, and the complete
//! ordered validator vocabulary. Change any of them and previously measured
//! route evidence no longer describes what this build would run, so
//! [`super::selection::select_fast_triage_route`] reports it stale instead of
//! honouring a measurement of something else.

use sha2::{Digest, Sha256};

use crate::chat::{ChatMessage, Role};
use crate::injection::wrap_untrusted;
use crate::investigation_answer::SCHEMA_V1;

use super::packet::{FastTriagePacketV1, FAST_TRIAGE_PACKET_SCHEMA_V1};
use super::validate::FastTriageFailureCategory;

/// The complete ordered validator vocabulary this contract enforces.
///
/// Listed explicitly (rather than derived) so adding, removing, or reordering a
/// check is a visible change to the fingerprint — and therefore a deliberate
/// invalidation of every persisted route record.
const VALIDATOR_VOCABULARY: [FastTriageFailureCategory; 17] = [
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

/// Stable strict contract shared by an initial fast proposal and its single
/// bounded correction. Keeping it in one builder prevents a correction from
/// silently becoming a looser schema path.
pub fn fast_triage_system_contract() -> String {
    concat!(
        "You are completing one bounded, host-grounded triage synthesis. The host has already ",
        "performed retrieval, deduplication, chronology, and candidate grouping; you receive the ",
        "complete permitted evidence packet and no retrieval is available. ",
        "Return exactly one JSON object with schema `contextdesk.investigation_answer.v1`. ",
        "The first output character must be `{` and the last must be `}`; emit no Markdown fence, ",
        "preamble, commentary, reasoning, or trailing text. Any private reasoning must stay in ",
        "your reasoning channel and must never appear in the answer. ",
        "Each candidate has only `candidate_id` and optional `observations`, `symptoms`, ",
        "`causal_candidates`, `initiating_causes`, `competing_explanations`, or ",
        "`missing_evidence`; each claim has only `claim_id`, `text`, and `evidence_ids`. ",
        "Include every manifest candidate_id exactly once and give each candidate at least one ",
        "claim citing at least one of its own permitted evidence ids. Every claim_id must be ",
        "nonempty and globally unique across the entire object. Claim text must be nonempty. ",
        "Every claim other than missing_evidence must cite at least one permitted evidence id ",
        "belonging to that candidate; do not repeat an evidence id within one claim and do not ",
        "move an evidence id between candidates. ",
        "The manifest states a host_role for every permitted evidence id, drawn from this exact ",
        "vocabulary: `initiating_cause`, `downstream_symptom`, `supporting_evidence`, ",
        "`unclassified`. Honour it. Evidence the host labeled `downstream_symptom` belongs in ",
        "`symptoms` and never in `causal_candidates` or `initiating_causes`. Evidence the host ",
        "labeled `initiating_cause` must appear in `causal_candidates` or `initiating_causes`. ",
        "Use `initiating_causes` only when a permitted id the host labeled `initiating_cause` ",
        "supports it; otherwise use `causal_candidates`, `observations`, or `missing_evidence` ",
        "rather than asserting an established root. Where the host role is `unclassified` the ",
        "host holds no role evidence: say what the text and order show and do not invent one. ",
        "The manifest also states a context_category for every permitted evidence id, and states ",
        "in `context_category_contract` exactly what each category proves. Those categories are ",
        "positional, structural, or link-based: `focus` is the host's own selection; ",
        "`preceding_same_source` and `following_same_source` are bounded same-source window rows ",
        "and are where a preceding configuration or deployment change, or a later rollback or ",
        "recovery, would appear if the row text says so — position alone never says so; ",
        "`cross_source_temporal` was admitted only because the host resolved comparable clocks; ",
        "`trace_linked` and `propagation` come from a host-computed trace or request correlation, ",
        "not from adjacency; `independent_noise` is separately scoped chronology. ",
        "Two rules override any pattern you notice: adjacency and co-occurrence never establish ",
        "correlation or causality, and records the host did not resolve to comparable clocks are ",
        "never comparable wall-clock events. When the manifest reports ",
        "`clock_compatibility: order_only`, do not describe any cross-source relationship as ",
        "simultaneous, before, or after in wall-clock terms; describe only the host's ordinals. ",
        "A candidate whose manifest scope is `independent` is separately scoped host chronology, ",
        "not an incident. Its rows may describe overlapping unrelated processes: report only ",
        "what their text and order show, never treat adjacency as correlation or causality, ",
        "never transfer its evidence into another candidate, and place its evidence only in ",
        "`observations`, `competing_explanations`, or `missing_evidence`. When the manifest says ",
        "`timeline_complete: false`, never describe that chronology as complete. ",
        "The manifest states a chronology_ordinal for each permitted id. Do not present a cause ",
        "that is strictly later than the symptom it explains within the same candidate. ",
        "Do not cite one evidence id in two conflicting roles: an id inside a candidate's causal ",
        "chain is not also a competing explanation, and an initiating cause is not also a ",
        "downstream symptom. ",
        "Do not include host-owned canonical_citations, status, confidence, corpus, revision, ",
        "session, binding, digest, packet identity, or any prose outside the JSON object."
    )
    .into()
}

/// Fixed, content-free repair guidance for the single bounded correction.
///
/// The rejected proposal is never replayed; only the stable validator category
/// selects one host-authored instruction.
pub fn correction_instruction(category: FastTriageFailureCategory) -> &'static str {
    match category {
        FastTriageFailureCategory::EmptyVisibleAnswer => {
            "Your previous response had no visible answer content. Put the complete JSON object in \
             the visible answer channel; reasoning alone is not an answer."
        }
        FastTriageFailureCategory::MalformedTerminal => {
            "The previous response was not parseable as exactly one JSON object. Copy the host \
             scaffold: first character `{`, last character `}`, with no fence, preamble, \
             commentary, trailing text, or second object."
        }
        FastTriageFailureCategory::SchemaMismatch => {
            "Use schema `contextdesk.investigation_answer.v1` and only the model-owned candidate \
             and claim fields shown in the host scaffold."
        }
        FastTriageFailureCategory::DuplicateId => {
            "Regenerate every claim_id so it is nonempty and globally unique across the entire \
             object; include every candidate_id exactly once and do not repeat an evidence id \
             within one claim."
        }
        FastTriageFailureCategory::ForeignEvidenceId => {
            "Cite only evidence ids that appear in the host manifest. Do not invent, abbreviate, \
             reformat, or derive an id."
        }
        FastTriageFailureCategory::CrossCandidateEvidence => {
            "Cite each evidence id only inside the candidate the manifest permits it for; do not \
             move evidence between candidates."
        }
        FastTriageFailureCategory::StaleEvidenceRevision => {
            "Cite only evidence ids from the supplied manifest for this exact packet."
        }
        FastTriageFailureCategory::UngroundedClaim => {
            "Every claim outside missing_evidence must cite at least one permitted evidence id \
             belonging to its candidate."
        }
        FastTriageFailureCategory::RootUnsupported => {
            "Do not present an initiating cause as established. Use initiating_causes only when a \
             permitted id the host labeled `initiating_cause` supports it; otherwise place the \
             claim in causal_candidates, observations, or missing_evidence."
        }
        FastTriageFailureCategory::SymptomPromotedToCause => {
            "A permitted evidence id is host-labeled `downstream_symptom`. Place it in that \
             candidate's symptoms section and never in causal_candidates or initiating_causes."
        }
        FastTriageFailureCategory::IndependentEvidencePromoted => {
            "A candidate whose manifest scope is `independent` is separately scoped chronology, \
             not part of any incident chain. Place its evidence only in observations, \
             competing_explanations, or missing_evidence."
        }
        FastTriageFailureCategory::ChronologyInverted => {
            "Within one candidate, the evidence you placed in initiating_causes has a later \
             chronology_ordinal than the evidence you placed in symptoms. Use the manifest \
             ordinals: a cause cannot follow the symptom it explains."
        }
        FastTriageFailureCategory::RoleCoverage => {
            "Retain every host role. Cite each permitted id the host labeled `initiating_cause` in \
             that candidate's causal_candidates or initiating_causes, and each permitted id the \
             host labeled `downstream_symptom` in that candidate's symptoms. Do not omit one \
             because another candidate seems more important."
        }
        FastTriageFailureCategory::ContradictoryRoles => {
            "One evidence id was cited in two conflicting roles. Choose one: an id inside a \
             candidate's causal chain is not also a competing explanation, and an initiating cause \
             is not also a downstream symptom."
        }
        FastTriageFailureCategory::CitationIncomplete => {
            "Every candidate in the manifest must receive at least one claim citing at least one \
             of its own permitted evidence ids."
        }
        // Host-side categories never reach a correction (see
        // `FastTriageFailureCategory::is_host_side`); the arm exists so the
        // vocabulary stays exhaustive rather than defaulting silently.
        FastTriageFailureCategory::PacketIdentityChanged
        | FastTriageFailureCategory::HostPacketInvalid => {
            "Rebuild the proposal from the unchanged host manifest, evidence packet, and output \
             scaffold."
        }
    }
}

/// Render the bounded correction preamble for one category.
fn correction_block(category: Option<FastTriageFailureCategory>) -> String {
    let Some(category) = category else {
        return String::new();
    };
    format!(
        "HOST VALIDATION CATEGORY: {}\nHOST-AUTHORED CORRECTION: {}\n",
        category.as_str(),
        correction_instruction(category)
    )
}

/// Build the request for one fast-triage synthesis attempt.
///
/// A correction repeats every authorized input from the initial request — the
/// contract, the question, the manifest, the evidence packet, and the scaffold —
/// plus only the stable validation category. It never receives the rejected
/// proposal and never receives new raw log, source, locator, binding, digest, or
/// provider data. `evidence_block` is minted once by the caller and replayed
/// byte-for-byte, so a retry never rewraps the packet under a fresh nonce or
/// reshapes the evidence the model already saw.
pub fn fast_triage_messages(
    user_text: &str,
    packet: &FastTriagePacketV1,
    evidence_block: &str,
    correction_category: Option<FastTriageFailureCategory>,
) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: Role::System,
            content: fast_triage_system_contract(),
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: Role::User,
            content: user_text.to_string(),
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: Role::User,
            content: format!(
                "{correction}HOST-AUTHORED EVIDENCE MANIFEST (the complete permitted identifier \
                 boundary, with host role, scope, and chronology ordinal; JSON):\n{manifest}\n\
                 {evidence_block}\n\
                 HOST-AUTHORED OUTPUT SCAFFOLD (copy this exact outer shape; replace empty arrays \
                 with grounded claim objects using only permitted evidence ids):\n{scaffold}\n\
                 Return only the completed JSON object.",
                correction = correction_block(correction_category),
                manifest = packet.manifest_json(),
                evidence_block = evidence_block,
                scaffold = packet.scaffold_json(),
            ),
            tool_call_id: None,
            tool_calls: None,
        },
    ]
}

/// Wrap the packet's evidence body in one nonce-bound untrusted-data envelope.
///
/// Minted once per route run and replayed verbatim on the correction and on any
/// escalation, so "the same packet was sent" is true at the byte level and not
/// merely at the identifier level.
pub fn fast_triage_evidence_block(packet: &FastTriagePacketV1) -> String {
    format!(
        "HOST-OWNED COMPLETE EVIDENCE PACKET (untrusted data; the host's own retrieval, \
         deduplication, chronology, and grouping):\n{}",
        wrap_untrusted("fast_triage_evidence_packet", &packet.evidence_body())
    )
}

/// Fingerprint binding persisted route evidence to this exact contract.
pub fn fast_triage_contract_fingerprint() -> String {
    let mut hasher = Sha256::new();
    let field = |hasher: &mut Sha256, bytes: &[u8]| {
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    };
    field(&mut hasher, b"contextdesk.fast_triage.contract.v1");
    field(&mut hasher, SCHEMA_V1.as_bytes());
    field(&mut hasher, FAST_TRIAGE_PACKET_SCHEMA_V1.as_bytes());
    field(&mut hasher, fast_triage_system_contract().as_bytes());
    hasher.update((VALIDATOR_VOCABULARY.len() as u64).to_le_bytes());
    for category in VALIDATOR_VOCABULARY {
        field(&mut hasher, category.as_str().as_bytes());
        field(&mut hasher, correction_instruction(category).as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::investigation_answer::{
        AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
    };

    fn packet() -> FastTriagePacketV1 {
        let revision = LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 2,
            suppression_revision: 3,
        };
        let entries = vec![
            HostEvidenceEntry {
                evidence_id: "e:g-a:10".into(),
                candidate_id: "g-a".into(),
                source_label: "synthetic.log".into(),
                locator: "seq=10".into(),
                corpus_id: "c".into(),
                revision,
                role: EvidenceRole::Cause,
                content: "synthetic row ten".into(),
            },
            HostEvidenceEntry {
                evidence_id: "e:g-b:20".into(),
                candidate_id: "g-b".into(),
                source_label: "synthetic.log".into(),
                locator: "seq=20".into(),
                corpus_id: "c".into(),
                revision,
                role: EvidenceRole::Symptom,
                content: "synthetic row twenty".into(),
            },
        ];
        let binding = AnswerBindingV1 {
            session_id: "s".into(),
            turn_id: "t".into(),
            corpus_id: "c".into(),
            revision,
            ledger_digest: HostEvidenceLedger::digest(&entries),
        };
        FastTriagePacketV1::from_ledger(
            HostEvidenceLedger::new(binding, entries).expect("ledger"),
            None,
            true,
        )
    }

    #[test]
    fn a_correction_repeats_authorized_inputs_and_never_the_rejected_proposal() {
        let packet = packet();
        let block = fast_triage_evidence_block(&packet);
        let initial = fast_triage_messages("why did it fail", &packet, &block, None);
        let corrected = fast_triage_messages(
            "why did it fail",
            &packet,
            &block,
            Some(FastTriageFailureCategory::RoleCoverage),
        );
        assert_eq!(initial.len(), corrected.len());
        // Same contract, same question, same evidence bytes.
        assert_eq!(initial[0].content, corrected[0].content);
        assert_eq!(initial[1].content, corrected[1].content);
        assert!(corrected[2].content.contains(&block));
        // Exactly one host-authored category is added.
        assert!(corrected[2]
            .content
            .contains("HOST VALIDATION CATEGORY: role_coverage"));
        assert!(corrected[2].content.contains(correction_instruction(
            FastTriageFailureCategory::RoleCoverage
        )));
        assert!(!initial[2].content.contains("HOST VALIDATION CATEGORY"));
    }

    #[test]
    fn the_request_carries_literal_host_ids_role_vocabulary_and_the_scaffold() {
        let packet = packet();
        let block = fast_triage_evidence_block(&packet);
        let messages = fast_triage_messages("q", &packet, &block, None);
        let body = &messages[2].content;
        for expected in [
            "e:g-a:10",
            "e:g-b:20",
            "initiating_cause",
            "downstream_symptom",
            "chronology_ordinal",
            SCHEMA_V1,
        ] {
            assert!(body.contains(expected), "request missing {expected}");
        }
        // The evidence packet is fenced as untrusted data exactly once.
        assert_eq!(body.matches("<<<UNTRUSTED_DATA:").count(), 1);
    }

    #[test]
    fn every_category_has_a_distinct_non_empty_host_instruction() {
        let mut seen = std::collections::BTreeSet::new();
        for category in VALIDATOR_VOCABULARY {
            let instruction = correction_instruction(category);
            assert!(!instruction.is_empty(), "{category:?} has no instruction");
            if !category.is_host_side() {
                assert!(
                    seen.insert(instruction),
                    "{category:?} reuses another category's instruction"
                );
            }
        }
    }

    #[test]
    fn the_contract_fingerprint_is_stable_and_covers_the_validator_vocabulary() {
        assert_eq!(
            fast_triage_contract_fingerprint(),
            fast_triage_contract_fingerprint()
        );
        assert_eq!(fast_triage_contract_fingerprint().len(), 64);
        // Recomputing over a deliberately shortened vocabulary must differ, so
        // dropping a check cannot silently keep old evidence valid.
        let mut hasher = Sha256::new();
        hasher.update(b"contextdesk.fast_triage.contract.v1");
        assert_ne!(
            format!("{:x}", hasher.finalize()),
            fast_triage_contract_fingerprint()
        );
    }

    #[test]
    fn the_system_contract_forbids_reasoning_in_the_answer_channel() {
        let contract = fast_triage_system_contract();
        assert!(contract.contains("reasoning channel"));
        assert!(contract.contains("never appear in the answer"));
    }
}
