//! Fixed synthetic linked-log cases for the cheap-model benchmark.
//!
//! Every row is host-minted, share-safe, and free of secrets, private paths,
//! endpoints, and raw provider bodies. Cases deliberately include initiating
//! causes, promoted-symptom traps, independent noise, chronology, same-source
//! neighborhood, cross-source context, recovery, contradictions, and opaque
//! evidence ids.

use std::collections::BTreeSet;

use crate::fast_triage::{
    FastTriageClockCompatibility, FastTriageNeighborhoodBudget, FastTriagePacketInputs,
    FastTriagePacketV1,
};
use crate::investigation_answer::{
    AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
};

/// Stable case identifiers used by matrices and goldens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CaseId {
    /// Classic complete timeline: cause + downstream symptom + independent noise.
    CompleteTimeline,
    /// Cause establishable, plus recovery and cross-source context.
    TriggerRecoveryCrossSource,
    /// Competing narratives; host labels one cause and one decoy.
    ContradictionAndDecoy,
    /// Chronology-sensitive: earlier cause, later symptom (must not invert).
    ChronologySensitive,
}

impl CaseId {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CompleteTimeline => "complete_timeline",
            Self::TriggerRecoveryCrossSource => "trigger_recovery_cross_source",
            Self::ContradictionAndDecoy => "contradiction_and_decoy",
            Self::ChronologySensitive => "chronology_sensitive",
        }
    }
}

/// One host-owned synthetic case.
#[derive(Debug, Clone)]
pub struct BenchmarkCase {
    /// Case id.
    pub id: CaseId,
    /// Short share-safe title.
    pub title: &'static str,
    /// Whether host role evidence can establish root cause.
    pub root_cause_establishable: bool,
    /// Complete host packet (ids, roles, chronology, neighborhood).
    pub packet: FastTriagePacketV1,
    /// Host-minted evidence id of the true initiating cause, when labelled.
    pub true_cause_evidence_id: Option<&'static str>,
    /// Host-minted evidence id of the primary downstream symptom, when labelled.
    pub primary_symptom_evidence_id: Option<&'static str>,
    /// Independent/noise evidence ids that must never enter a causal chain.
    pub independent_noise_ids: &'static [&'static str],
    /// Recovery observation id, when present.
    pub recovery_evidence_id: Option<&'static str>,
}

fn revision() -> LogSnapshotRevisionV1 {
    LogSnapshotRevisionV1 {
        event_revision: 11,
        template_analysis_revision: 12,
        suppression_revision: 13,
    }
}

fn entry(
    candidate: &str,
    seq: u64,
    role: EvidenceRole,
    source: &str,
    content: &str,
) -> HostEvidenceEntry {
    HostEvidenceEntry {
        evidence_id: format!("e:{candidate}:{seq}"),
        candidate_id: candidate.into(),
        source_label: source.into(),
        locator: format!("seq={seq}"),
        corpus_id: "bench-corpus".into(),
        revision: revision(),
        role,
        content: content.into(),
    }
}

fn ledger(entries: Vec<HostEvidenceEntry>) -> HostEvidenceLedger {
    let binding = AnswerBindingV1 {
        session_id: "bench-session".into(),
        turn_id: "bench-turn".into(),
        corpus_id: "bench-corpus".into(),
        revision: revision(),
        ledger_digest: HostEvidenceLedger::digest(&entries),
    };
    HostEvidenceLedger::new(binding, entries).expect("benchmark ledger")
}

fn packet(
    entries: Vec<HostEvidenceEntry>,
    independent: Option<&str>,
    correlated: &[&str],
    clock: FastTriageClockCompatibility,
) -> FastTriagePacketV1 {
    let mut set = BTreeSet::new();
    for id in correlated {
        set.insert((*id).to_string());
    }
    FastTriagePacketV1::build(FastTriagePacketInputs {
        ledger: ledger(entries),
        independent_candidate_id: independent,
        timeline_complete: true,
        clock,
        trace_correlated_candidates: &set,
        neighborhood: FastTriageNeighborhoodBudget::default(),
    })
}

/// All case ids in stable matrix order.
pub fn list_case_ids() -> &'static [CaseId] {
    &[
        CaseId::CompleteTimeline,
        CaseId::TriggerRecoveryCrossSource,
        CaseId::ContradictionAndDecoy,
        CaseId::ChronologySensitive,
    ]
}

/// Build one fixed synthetic case by id.
pub fn benchmark_case(id: CaseId) -> BenchmarkCase {
    match id {
        CaseId::CompleteTimeline => complete_timeline(),
        CaseId::TriggerRecoveryCrossSource => trigger_recovery_cross_source(),
        CaseId::ContradictionAndDecoy => contradiction_and_decoy(),
        CaseId::ChronologySensitive => chronology_sensitive(),
    }
}

fn complete_timeline() -> BenchmarkCase {
    let entries = vec![
        entry(
            "trace:alpha",
            10,
            EvidenceRole::Cause,
            "app.log",
            "constraint violation on startup",
        ),
        entry(
            "trace:alpha",
            12,
            EvidenceRole::Neutral,
            "app.log",
            "retry scheduled after startup failure",
        ),
        entry(
            "template:bravo",
            40,
            EvidenceRole::Symptom,
            "worker.log",
            "request rejected: dependency unavailable",
        ),
        entry(
            "global_timeline_context",
            11,
            EvidenceRole::Neutral,
            "app.log",
            "routine checkpoint written",
        ),
        entry(
            "global_timeline_context",
            41,
            EvidenceRole::Neutral,
            "metrics.log",
            "unrelated queue depth sample",
        ),
    ];
    BenchmarkCase {
        id: CaseId::CompleteTimeline,
        title: "Complete timeline with independent noise",
        root_cause_establishable: true,
        packet: packet(
            entries,
            Some("global_timeline_context"),
            &["trace:alpha"],
            FastTriageClockCompatibility::OrderOnly,
        ),
        true_cause_evidence_id: Some("e:trace:alpha:10"),
        primary_symptom_evidence_id: Some("e:template:bravo:40"),
        independent_noise_ids: &[
            "e:global_timeline_context:11",
            "e:global_timeline_context:41",
        ],
        recovery_evidence_id: None,
    }
}

fn trigger_recovery_cross_source() -> BenchmarkCase {
    let entries = vec![
        entry(
            "svc:orders",
            100,
            EvidenceRole::Cause,
            "orders.log",
            "connection reservoir exhausted for borrowable pool",
        ),
        entry(
            "svc:orders",
            105,
            EvidenceRole::Symptom,
            "orders.log",
            "order transaction could not persist",
        ),
        entry(
            "svc:orders",
            130,
            EvidenceRole::Supporting,
            "orders.log",
            "pool reclaimed after cooldown; writes resume",
        ),
        entry(
            "svc:edge",
            102,
            EvidenceRole::Neutral,
            "edge.log",
            "edge request latency spike observed",
        ),
        entry(
            "global_timeline_context",
            101,
            EvidenceRole::Neutral,
            "metrics.log",
            "cpu sample on unrelated host",
        ),
        entry(
            "global_timeline_context",
            140,
            EvidenceRole::Neutral,
            "metrics.log",
            "disk util sample on unrelated host",
        ),
    ];
    BenchmarkCase {
        id: CaseId::TriggerRecoveryCrossSource,
        title: "Trigger, recovery, and cross-source context",
        root_cause_establishable: true,
        packet: packet(
            entries,
            Some("global_timeline_context"),
            &["svc:orders"],
            FastTriageClockCompatibility::ResolvedComparable,
        ),
        true_cause_evidence_id: Some("e:svc:orders:100"),
        primary_symptom_evidence_id: Some("e:svc:orders:105"),
        independent_noise_ids: &[
            "e:global_timeline_context:101",
            "e:global_timeline_context:140",
        ],
        recovery_evidence_id: Some("e:svc:orders:130"),
    }
}

fn contradiction_and_decoy() -> BenchmarkCase {
    let entries = vec![
        entry(
            "trace:primary",
            20,
            EvidenceRole::Cause,
            "app.log",
            "config key feature_x disabled by deploy",
        ),
        entry(
            "trace:primary",
            25,
            EvidenceRole::Symptom,
            "app.log",
            "feature_x path returned 503",
        ),
        entry(
            "trace:decoy",
            15,
            EvidenceRole::Neutral,
            "batch.log",
            "batch job warning: low cache hit ratio",
        ),
        entry(
            "trace:decoy",
            18,
            EvidenceRole::Neutral,
            "batch.log",
            "batch job completed with warnings",
        ),
        entry(
            "global_timeline_context",
            22,
            EvidenceRole::Neutral,
            "metrics.log",
            "background GC pause sample",
        ),
    ];
    BenchmarkCase {
        id: CaseId::ContradictionAndDecoy,
        title: "True cause with independent decoy narrative",
        root_cause_establishable: true,
        packet: packet(
            entries,
            Some("global_timeline_context"),
            &["trace:primary"],
            FastTriageClockCompatibility::OrderOnly,
        ),
        true_cause_evidence_id: Some("e:trace:primary:20"),
        primary_symptom_evidence_id: Some("e:trace:primary:25"),
        // Only Independent-scoped chronology rows: decoy is a separate candidate
        // (noise narrative) but not Independent scope.
        independent_noise_ids: &["e:global_timeline_context:22"],
        recovery_evidence_id: None,
    }
}

fn chronology_sensitive() -> BenchmarkCase {
    let entries = vec![
        entry(
            "trace:chain",
            50,
            EvidenceRole::Cause,
            "app.log",
            "schema migration aborted mid-apply",
        ),
        entry(
            "trace:chain",
            55,
            EvidenceRole::Symptom,
            "app.log",
            "read path fails with missing column",
        ),
        entry(
            "trace:chain",
            60,
            EvidenceRole::Symptom,
            "app.log",
            "health check marks dependency unhealthy",
        ),
        entry(
            "global_timeline_context",
            52,
            EvidenceRole::Neutral,
            "metrics.log",
            "unrelated request rate sample",
        ),
    ];
    BenchmarkCase {
        id: CaseId::ChronologySensitive,
        title: "Chronology-sensitive cause before symptoms",
        root_cause_establishable: true,
        packet: packet(
            entries,
            Some("global_timeline_context"),
            &["trace:chain"],
            FastTriageClockCompatibility::ResolvedComparable,
        ),
        true_cause_evidence_id: Some("e:trace:chain:50"),
        primary_symptom_evidence_id: Some("e:trace:chain:55"),
        independent_noise_ids: &["e:global_timeline_context:52"],
        recovery_evidence_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_case_builds_a_nonempty_packet_with_opaque_ids() {
        for id in list_case_ids() {
            let case = benchmark_case(*id);
            assert!(!case.packet.rows().is_empty());
            for row in case.packet.rows() {
                assert!(row.evidence_id.starts_with("e:"));
                assert!(!row.evidence_id.contains('/'));
                assert!(!row.evidence_id.contains("sk-"));
            }
            assert!(!case.id.as_str().contains(' '));
        }
    }
}
