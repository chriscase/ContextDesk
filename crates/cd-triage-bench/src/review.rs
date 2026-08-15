//! Blinded expert-review packets. Strategy identity is masked when feasible.

use crate::canonical::{to_canonical_json, to_pretty_json};
use crate::error::{BenchError, BenchResult};
use crate::packet::{materialize_task_packet, VisibleEvidence};
use crate::types::{
    sha256_hex, Adjudication, BlindingState, Case, CaseResolution, EvaluationTask,
    EvidenceSnapshot, Observed, RubricDimension, RunStatus, TriageRun, REVIEW_PACKET_SCHEMA_V1,
};
use serde::{Deserialize, Serialize};

/// Phase of a two-phase review packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPhase {
    /// Evidence-support review. Case resolution is excluded.
    Support,
    /// Diagnosis review after support is recorded. Resolution may be revealed.
    Diagnosis,
}

impl ReviewPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Support => "support",
            Self::Diagnosis => "diagnosis",
        }
    }
}

/// Strategy-masked view of a run for expert review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlindedRunView {
    pub run_id: String,
    pub status: RunStatus,
    pub raw_output_digest: String,
    pub uncertainty: Observed<String>,
    pub claim_count: usize,
    pub strategy_masked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unblindable_reason: Option<String>,
}

/// Reviewer packet. Structured strategy identity is never included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewPacket {
    pub schema_id: String,
    pub packet_id: String,
    pub phase: ReviewPhase,
    pub case_id: String,
    pub task_id: String,
    pub snapshot_id: String,
    pub run_id: String,
    pub question: String,
    pub protocol: String,
    pub evidence: Vec<VisibleEvidence>,
    pub run: BlindedRunView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output_utf8: Option<String>,
    pub blinding: BlindingState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<CaseResolution>,
}

impl ReviewPacket {
    pub fn to_json(&self) -> BenchResult<String> {
        to_pretty_json(self)
    }
}

pub fn blinded_run_view(run: &TriageRun) -> BlindedRunView {
    blinded_run_view_from_raw(run, None)
}

pub fn blinded_run_view_from_raw(run: &TriageRun, raw: Option<&[u8]>) -> BlindedRunView {
    let unblindable_reason = distinctive_format_reason(run, raw);
    BlindedRunView {
        run_id: run.run_id.clone(),
        status: run.status,
        raw_output_digest: run.raw_output.digest.wire(),
        uncertainty: run.uncertainty.clone(),
        claim_count: run.claims.len(),
        strategy_masked: unblindable_reason.is_none(),
        unblindable_reason,
    }
}

pub fn distinctive_format_reason(run: &TriageRun, raw: Option<&[u8]>) -> Option<String> {
    if run.raw_output.encoding != "utf-8" {
        return Some("non-utf8 raw artifact retains a distinctive encoding".into());
    }
    let raw = raw?;
    let text = std::str::from_utf8(raw).ok()?;
    let name = run.strategy.name.trim();
    if !name.is_empty()
        && text
            .to_ascii_lowercase()
            .contains(&name.to_ascii_lowercase())
    {
        return Some(format!("raw output contains the strategy name `{name}`"));
    }
    None
}

pub fn materialize_review_packet(
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    run: &TriageRun,
    raw: &[u8],
    phase: ReviewPhase,
    support_recorded: bool,
) -> BenchResult<ReviewPacket> {
    if run.task_id != task.task_id {
        return Err(BenchError::Schema(
            "run.task_id does not match the loaded task".into(),
        ));
    }
    if phase == ReviewPhase::Diagnosis && !support_recorded {
        return Err(BenchError::Schema(
            "diagnosis phase requires a recorded evidence-support adjudication first".into(),
        ));
    }
    let task_packet = materialize_task_packet(case, snapshot, task)?;
    let view = blinded_run_view_from_raw(run, Some(raw));
    let blinding = match &view.unblindable_reason {
        Some(reason) => BlindingState::Unblinded {
            reason: reason.clone(),
        },
        None => BlindingState::Blinded,
    };
    let raw_output_utf8 = std::str::from_utf8(raw).ok().map(str::to_string);
    let resolution = match phase {
        ReviewPhase::Support => None,
        ReviewPhase::Diagnosis => case.resolution.clone(),
    };
    let mut packet = ReviewPacket {
        schema_id: REVIEW_PACKET_SCHEMA_V1.into(),
        packet_id: String::new(),
        phase,
        case_id: task.case_id.clone(),
        task_id: task.task_id.clone(),
        snapshot_id: task.snapshot_id.clone(),
        run_id: run.run_id.clone(),
        question: task.question.clone(),
        protocol: task.protocol.clone(),
        evidence: task_packet.evidence,
        run: view,
        raw_output_utf8,
        blinding,
        resolution,
    };
    packet.packet_id = format!(
        "rpkt-{}",
        sha256_hex(to_canonical_json(&review_digest_body(&packet))?.as_bytes())
    );
    assert_review_packet_invariants(&packet)?;
    Ok(packet)
}

#[derive(Serialize)]
struct ReviewDigestBody<'a> {
    phase: ReviewPhase,
    case_id: &'a str,
    task_id: &'a str,
    snapshot_id: &'a str,
    run_id: &'a str,
    evidence: &'a [VisibleEvidence],
    run: &'a BlindedRunView,
    blinding: &'a BlindingState,
    has_resolution: bool,
}

fn review_digest_body(packet: &ReviewPacket) -> ReviewDigestBody<'_> {
    ReviewDigestBody {
        phase: packet.phase,
        case_id: &packet.case_id,
        task_id: &packet.task_id,
        snapshot_id: &packet.snapshot_id,
        run_id: &packet.run_id,
        evidence: &packet.evidence,
        run: &packet.run,
        blinding: &packet.blinding,
        has_resolution: packet.resolution.is_some(),
    }
}

fn assert_review_packet_invariants(packet: &ReviewPacket) -> BenchResult<()> {
    let json = serde_json::to_string(packet).map_err(BenchError::from_serde)?;
    for forbidden in [
        "\"source_kind\"",
        "\"strategy\"",
        "contextdesk_sdk",
        "other_product",
        "web_only",
    ] {
        if json.contains(forbidden) {
            return Err(BenchError::Integrity(format!(
                "review packet leaked strategy identity ({forbidden})"
            )));
        }
    }
    if packet.phase == ReviewPhase::Support
        && (packet.resolution.is_some() || json.contains("adjudicated_root_cause"))
    {
        return Err(BenchError::Integrity(
            "support-phase review packet must exclude case resolution".into(),
        ));
    }
    Ok(())
}

/// Merge deterministic citation-existence flags. Never changes verdicts.
pub fn merge_citation_assists(adj: Adjudication, flags: Vec<String>) -> BenchResult<Adjudication> {
    if flags.is_empty() {
        return Ok(adj);
    }
    let mut outcomes = adj.outcomes.clone();
    for outcome in &mut outcomes {
        if matches!(
            outcome.dimension,
            RubricDimension::UnsafeUnsupportedClaims | RubricDimension::EvidenceSupport
        ) {
            for flag in &flags {
                if !outcome.assist_flags.contains(flag) {
                    outcome.assist_flags.push(flag.clone());
                }
            }
            outcome.assist_flags.sort();
        }
    }
    Adjudication::from_parts(
        adj.privacy,
        adj.case_id,
        adj.task_id,
        adj.snapshot_id,
        adj.run_id,
        adj.reviewer,
        adj.conflict_of_interest,
        adj.rubric_version,
        adj.blinding,
        outcomes,
        adj.created_at,
    )
}

pub fn run_has_support_adjudication(adjudications: &[Adjudication], run_id: &str) -> bool {
    adjudications
        .iter()
        .any(|adj| adj.run_id == run_id && adj.outcome(RubricDimension::EvidenceSupport).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        citation_assist_flags, ClaimedCitation, Completeness, ConflictOfInterest, ContentDigest,
        DimensionOutcome, DimensionVerdict, PrivacyClass, PromptWorkflow, RawOutput, SourceKind,
        StrategyIdentity, RUN_SCHEMA_V1,
    };
    use std::collections::BTreeSet;

    fn sample_run(name: &str, encoding: &str) -> TriageRun {
        let digest = ContentDigest::of_bytes(b"hello");
        let mut run = TriageRun {
            schema_id: RUN_SCHEMA_V1.into(),
            run_id: "run-pending".into(),
            privacy: PrivacyClass::ShareSafe,
            case_id: "case-1".into(),
            task_id: "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            snapshot_id: "snap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .into(),
            strategy: StrategyIdentity {
                name: name.into(),
                version: Observed::Unknown,
                build: Observed::Unknown,
            },
            source_kind: SourceKind::Human,
            prompt_workflow: PromptWorkflow {
                completeness: Completeness::Unknown,
                prompt: Observed::Unknown,
                workflow: Observed::Unknown,
            },
            raw_output: RawOutput {
                digest: digest.clone(),
                byte_length: 5,
                encoding: encoding.into(),
            },
            claims: vec![],
            timing: Observed::Unknown,
            cost: Observed::Unknown,
            uncertainty: Observed::Unknown,
            fairness: crate::types::FairnessClass::SameSnapshot,
            status: RunStatus::Completed,
            operator: "op".into(),
            importer: None,
            created_at: "2026-01-15T08:00:00Z".into(),
            near_duplicate_of: None,
        };
        run.run_id = format!("run-{}", run.fingerprint().unwrap());
        run
    }

    #[test]
    fn strategy_name_in_raw_is_unblindable() {
        let run = sample_run("web-assistant", "utf-8");
        let reason = distinctive_format_reason(&run, Some(b"web-assistant says DNS"));
        assert!(reason.unwrap().contains("strategy name"));
        let view = blinded_run_view_from_raw(&run, Some(b"plain write-up"));
        assert!(view.strategy_masked);
        assert!(view.unblindable_reason.is_none());
    }

    #[test]
    fn citation_assists_never_change_verdicts() {
        let flags = citation_assist_flags(
            &BTreeSet::from(["ev-log-1".into()]),
            &[ClaimedCitation {
                claim: "invented".into(),
                evidence_item_id: Some("ev-does-not-exist".into()),
                locator: None,
            }],
        );
        assert_eq!(flags, vec!["citation_not_in_snapshot:ev-does-not-exist"]);
        let outcomes = vec![
            DimensionOutcome {
                dimension: RubricDimension::DiagnosisCorrectness,
                verdict: DimensionVerdict::Score { value: 1 },
                rationale: "r".into(),
                assist_flags: vec![],
            },
            DimensionOutcome {
                dimension: RubricDimension::EvidenceSupport,
                verdict: DimensionVerdict::Score { value: 1 },
                rationale: "r".into(),
                assist_flags: vec![],
            },
            DimensionOutcome {
                dimension: RubricDimension::Actionability,
                verdict: DimensionVerdict::Score { value: 1 },
                rationale: "r".into(),
                assist_flags: vec![],
            },
            DimensionOutcome {
                dimension: RubricDimension::UncertaintyCalibration,
                verdict: DimensionVerdict::Score { value: 1 },
                rationale: "r".into(),
                assist_flags: vec![],
            },
            DimensionOutcome {
                dimension: RubricDimension::UnsafeUnsupportedClaims,
                verdict: DimensionVerdict::Score { value: 0 },
                rationale: "fabricated citation".into(),
                assist_flags: vec![],
            },
        ];
        let adj = Adjudication::from_parts(
            PrivacyClass::ShareSafe,
            "case-1".into(),
            "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            "snap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            "run-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            "reviewer-a".into(),
            ConflictOfInterest {
                declared: false,
                notes: None,
            },
            crate::types::RUBRIC_V1.into(),
            BlindingState::Blinded,
            outcomes,
            "2026-01-15T10:00:00Z".into(),
        )
        .unwrap();
        let before = adj
            .outcome(RubricDimension::UnsafeUnsupportedClaims)
            .unwrap()
            .verdict
            .clone();
        let merged = merge_citation_assists(adj, flags).unwrap();
        assert_eq!(
            merged
                .outcome(RubricDimension::UnsafeUnsupportedClaims)
                .unwrap()
                .verdict,
            before
        );
        assert!(merged
            .outcome(RubricDimension::UnsafeUnsupportedClaims)
            .unwrap()
            .assist_flags
            .iter()
            .any(|f| f.contains("citation_not_in_snapshot")));
    }
}
