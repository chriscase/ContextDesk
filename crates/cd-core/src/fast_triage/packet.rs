//! The complete, host-owned evidence packet handed to a fast model in one
//! bounded request.
//!
//! The preserved research this route implements found that a fast model failed
//! *evidence handoff*, not transport: candidate-local synthesis withheld the
//! initiating cause, while a complete host-prepared timeline did not. So this
//! packet is deliberately whole — every permitted candidate group **and** the
//! host-owned linked timeline — and it is deliberately literal: every reference
//! the model may make is a host-minted id printed verbatim beside its host role,
//! host scope, and host chronology ordinal.
//!
//! Authority is unchanged. The packet is built from an immutable
//! [`HostEvidenceLedger`] and nothing else; it mints no id, assigns no role, and
//! reorders nothing. [`crate::investigation_answer::validate_model_answer`]
//! remains the validator, so a claim citing something this packet did not
//! permit fails exactly as it does on every other path.
//!
//! The packet also carries its own identity ([`FastTriagePacketV1::packet_id`]).
//! That identity is what makes "the *unchanged* host packet was escalated" a
//! checkable fact rather than a claim, and what lets a host detect a packet that
//! went stale under a turn.

use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};

use crate::investigation_answer::{
    literal_display_text, literal_span, EvidenceRole, HostEvidenceLedger, SCHEMA_V1,
};

use super::neighborhood::{
    classify_neighborhood, FastTriageClockCompatibility, FastTriageEvidenceCategory,
    FastTriageNeighborhood, FastTriageNeighborhoodBudget, NeighborhoodRow,
};

/// Stable schema id for the packet's host-authored projections.
pub const FAST_TRIAGE_PACKET_SCHEMA_V1: &str = "contextdesk.fast_triage.packet.v1";

/// Host-owned scope of one permitted evidence row.
///
/// Scope is structural and deterministic — it says *where the host put a row*,
/// not what the row means. That is exactly why it can be validated: the host can
/// prove a row came from the separately scoped linked timeline without claiming
/// to know whether it is a cause.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageEvidenceScope {
    /// Belongs to one candidate evidence/correlation group.
    Candidate,
    /// Belongs to the separately scoped host chronology. Its rows may describe
    /// overlapping, unrelated processes: adjacency there is not correlation and
    /// never causality, so it may never enter another candidate's causal chain.
    Independent,
}

impl FastTriageEvidenceScope {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Candidate => "candidate",
            Self::Independent => "independent",
        }
    }
}

/// Stable wire label for a host evidence role, shared by the packet projection,
/// the prompt's role vocabulary, and telemetry.
pub fn evidence_role_label(role: EvidenceRole) -> &'static str {
    match role {
        EvidenceRole::Cause => "initiating_cause",
        EvidenceRole::Supporting => "supporting_evidence",
        EvidenceRole::Symptom => "downstream_symptom",
        EvidenceRole::Neutral => "unclassified",
    }
}

/// One permitted evidence row, reduced to the host facts a validator can prove.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FastTriagePacketRow {
    /// Host-minted evidence id. The only reference the model may make.
    pub evidence_id: String,
    /// Host-minted owning candidate id.
    pub candidate_id: String,
    /// Host-assigned role, or [`EvidenceRole::Neutral`] when the host has no
    /// role evidence for this row. Neutral is honest ignorance, never a cause.
    pub role: EvidenceRole,
    /// Host-assigned structural scope.
    pub scope: FastTriageEvidenceScope,
    /// Host chronology ordinal (the ledger's own `seq=` locator). `None` when
    /// the host locator carries no ordinal, in which case chronology checks
    /// abstain for this row rather than guessing an order.
    pub chronology_ordinal: Option<u64>,
    /// What the host can prove about this row's place in the already-assembled,
    /// already-bounded neighborhood. Positional and structural only — never a
    /// causal statement. See [`super::neighborhood`].
    pub context_category: FastTriageEvidenceCategory,
}

/// Whether the host actually holds semantic role evidence for this packet.
///
/// Reported in telemetry so a reader can tell "role checks passed" from "there
/// was no role evidence to check". Neutral-only packets still get every
/// structural check (scope isolation, chronology, contradictions, coverage of
/// permitted candidates) — the host simply does not pretend to know more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageRoleEvidence {
    /// At least one row carries a host cause/symptom/supporting role.
    HostLabelled,
    /// Every row is unclassified. Role-coverage and symptom-promotion checks
    /// have nothing to assert and the host says so instead of implying a pass.
    HostNeutral,
}

impl FastTriageRoleEvidence {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HostLabelled => "host_labelled",
            Self::HostNeutral => "host_neutral",
        }
    }
}

/// Everything the host must decide before a packet exists.
///
/// A struct rather than a long argument list, because every field is a host
/// policy decision a reader should be able to see at the call site: which scope
/// is the chronology, whether the chronology is complete, whether clocks are
/// comparable, which groups are trace-correlated, and how far expansion may go.
pub struct FastTriagePacketInputs<'a> {
    /// The immutable ledger. The only source of ids, roles, and content.
    pub ledger: HostEvidenceLedger,
    /// Host scope id for the separately scoped linked timeline, when present.
    pub independent_candidate_id: Option<&'a str>,
    /// The host's honest completeness flag for that chronology.
    pub timeline_complete: bool,
    /// Whether the host resolved comparable clocks across sources.
    pub clock: FastTriageClockCompatibility,
    /// Candidate ids the host grouped by a trace/request correlation key.
    pub trace_correlated_candidates: &'a BTreeSet<String>,
    /// Bounded expansion budget for neighborhood classification.
    pub neighborhood: FastTriageNeighborhoodBudget,
}

/// The complete host-owned packet for one fast-triage route.
#[derive(Debug, Clone)]
pub struct FastTriagePacketV1 {
    ledger: HostEvidenceLedger,
    rows: Vec<FastTriagePacketRow>,
    independent_candidate_id: Option<String>,
    timeline_complete: bool,
    clock: FastTriageClockCompatibility,
    neighborhood: FastTriageNeighborhood,
    packet_id: String,
}

impl FastTriagePacketV1 {
    /// Build a packet from an immutable ledger and the host's neighborhood
    /// policy.
    pub fn build(inputs: FastTriagePacketInputs<'_>) -> Self {
        let FastTriagePacketInputs {
            ledger,
            independent_candidate_id,
            timeline_complete,
            clock,
            trace_correlated_candidates,
            neighborhood: budget,
        } = inputs;
        let independent_candidate_id = independent_candidate_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned);
        // `entries()` is ordered by the ledger's own `BTreeMap`, so row order —
        // and therefore every projection and the packet id — is deterministic
        // for a given ledger regardless of how the caller assembled it.
        let entries = ledger.entries();
        let scope_of = |candidate_id: &str| {
            if independent_candidate_id.as_deref() == Some(candidate_id) {
                FastTriageEvidenceScope::Independent
            } else {
                FastTriageEvidenceScope::Candidate
            }
        };
        let ordinal_of = |locator: &str| {
            locator
                .strip_prefix("seq=")
                .and_then(|value| value.trim().parse::<u64>().ok())
        };
        let neighborhood_rows = entries
            .iter()
            .map(|entry| NeighborhoodRow {
                evidence_id: entry.evidence_id.as_str(),
                candidate_id: entry.candidate_id.as_str(),
                source_label: entry.source_label.as_str(),
                scope: scope_of(&entry.candidate_id),
                chronology_ordinal: ordinal_of(&entry.locator),
            })
            .collect::<Vec<_>>();
        let neighborhood = classify_neighborhood(
            &neighborhood_rows,
            trace_correlated_candidates,
            clock,
            budget,
        );
        let rows = entries
            .into_iter()
            .map(|entry| FastTriagePacketRow {
                scope: scope_of(&entry.candidate_id),
                chronology_ordinal: ordinal_of(&entry.locator),
                context_category: neighborhood
                    .category(&entry.evidence_id)
                    .unwrap_or(FastTriageEvidenceCategory::IndependentNoise),
                evidence_id: entry.evidence_id,
                candidate_id: entry.candidate_id,
                role: entry.role,
            })
            .collect::<Vec<_>>();
        let packet_id = packet_identity(
            &ledger,
            &rows,
            independent_candidate_id.as_deref(),
            timeline_complete,
            clock,
            budget,
        );
        Self {
            ledger,
            rows,
            independent_candidate_id,
            timeline_complete,
            clock,
            neighborhood,
            packet_id,
        }
    }

    /// Build a packet with fail-closed neighborhood defaults.
    ///
    /// Clocks are treated as [`FastTriageClockCompatibility::OrderOnly`] and no
    /// group is treated as trace-correlated, so a caller that has not resolved
    /// those facts cannot accidentally publish a cross-source temporal reading
    /// it never established. Callers that *have* resolved them use
    /// [`FastTriagePacketV1::build`].
    pub fn from_ledger(
        ledger: HostEvidenceLedger,
        independent_candidate_id: Option<&str>,
        timeline_complete: bool,
    ) -> Self {
        Self::build(FastTriagePacketInputs {
            ledger,
            independent_candidate_id,
            timeline_complete,
            clock: FastTriageClockCompatibility::OrderOnly,
            trace_correlated_candidates: &BTreeSet::new(),
            neighborhood: FastTriageNeighborhoodBudget::default(),
        })
    }

    /// Whether the host resolved comparable clocks for this packet.
    pub fn clock(&self) -> FastTriageClockCompatibility {
        self.clock
    }

    /// The neighborhood classification and its honest accounting.
    pub fn neighborhood(&self) -> &FastTriageNeighborhood {
        &self.neighborhood
    }

    /// Stable identity of this exact packet.
    ///
    /// Two packets share an id only when their binding, ledger digest, rows,
    /// scope assignment, and completeness flag all match. An escalation that
    /// reports this id has demonstrably carried the same evidence, not a
    /// re-derived approximation of it.
    pub fn packet_id(&self) -> &str {
        &self.packet_id
    }

    /// The immutable ledger backing this packet. Validation authority.
    pub fn ledger(&self) -> &HostEvidenceLedger {
        &self.ledger
    }

    /// Permitted rows, in deterministic host order.
    pub fn rows(&self) -> &[FastTriagePacketRow] {
        &self.rows
    }

    /// Host scope id for the linked timeline, when this packet carries one.
    pub fn independent_candidate_id(&self) -> Option<&str> {
        self.independent_candidate_id.as_deref()
    }

    /// Whether the host chronology in this packet is complete.
    pub fn timeline_complete(&self) -> bool {
        self.timeline_complete
    }

    /// Whether the host holds any semantic role evidence for this packet.
    pub fn role_evidence(&self) -> FastTriageRoleEvidence {
        if self
            .rows
            .iter()
            .any(|row| row.role != EvidenceRole::Neutral)
        {
            FastTriageRoleEvidence::HostLabelled
        } else {
            FastTriageRoleEvidence::HostNeutral
        }
    }

    /// Candidate ids in this packet, excluding the independent timeline scope.
    pub fn candidate_ids(&self) -> BTreeSet<String> {
        self.rows
            .iter()
            .filter(|row| row.scope == FastTriageEvidenceScope::Candidate)
            .map(|row| row.candidate_id.clone())
            .collect()
    }

    /// Look up one permitted row by host evidence id.
    pub fn row(&self, evidence_id: &str) -> Option<&FastTriagePacketRow> {
        self.rows.iter().find(|row| row.evidence_id == evidence_id)
    }

    /// Content-free identifier boundary: every candidate and the exact evidence
    /// ids it permits, each with its host role, scope, and chronology ordinal.
    ///
    /// JSON is deliberate prompt scaffolding: it gives every host-minted id an
    /// unambiguous quoted boundary, so punctuation inside an id cannot change
    /// the apparent structure a provider sees.
    pub fn manifest_json(&self) -> String {
        let mut by_candidate: BTreeMap<&str, Vec<&FastTriagePacketRow>> = BTreeMap::new();
        for row in &self.rows {
            by_candidate
                .entry(row.candidate_id.as_str())
                .or_default()
                .push(row);
        }
        let mut vocabulary = self
            .rows
            .iter()
            .map(|row| row.context_category)
            .collect::<Vec<_>>();
        vocabulary.sort_unstable();
        vocabulary.dedup();
        serde_json::json!({
            "schema": FAST_TRIAGE_PACKET_SCHEMA_V1,
            "packet_id": self.packet_id,
            "timeline_complete": self.timeline_complete,
            "clock_compatibility": self.clock.as_str(),
            // The host states what each context category proves — and, by
            // omission, what it does not. Adjacency is never causality, and an
            // order-only corpus never yields a cross-source temporal reading.
            "context_category_contract": vocabulary.iter().map(|category| serde_json::json!({
                "context_category": category.as_str(),
                "means": category.contract(),
            })).collect::<Vec<_>>(),
            "candidates": by_candidate.into_iter().map(|(candidate_id, rows)| {
                serde_json::json!({
                    "candidate_id": candidate_id,
                    "scope": rows
                        .first()
                        .map(|row| row.scope.as_str())
                        .unwrap_or(FastTriageEvidenceScope::Candidate.as_str()),
                    "permitted_evidence": rows.iter().map(|row| serde_json::json!({
                        "evidence_id": row.evidence_id,
                        "host_role": evidence_role_label(row.role),
                        "context_category": row.context_category.as_str(),
                        "chronology_ordinal": row.chronology_ordinal,
                    })).collect::<Vec<_>>(),
                })
            }).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// Content-free output shape generated from the same rows the validator
    /// uses. Empty arrays are placeholders for model-owned claims; host-owned
    /// fields and evidence metadata are intentionally absent.
    pub fn scaffold_json(&self) -> String {
        let mut candidates = self
            .rows
            .iter()
            .map(|row| row.candidate_id.as_str())
            .collect::<Vec<_>>();
        candidates.sort_unstable();
        candidates.dedup();
        serde_json::json!({
            "schema": SCHEMA_V1,
            "candidates": candidates.into_iter().map(|candidate_id| serde_json::json!({
                "candidate_id": candidate_id,
                "observations": [],
                "symptoms": [],
                "causal_candidates": [],
                "initiating_causes": [],
                "competing_explanations": [],
                "missing_evidence": [],
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// The complete evidence body, as one deterministic host projection.
    ///
    /// Every dynamic value — including host-owned-but-corpus-derived source
    /// labels, locators, and excerpts — goes through the shared presentation
    /// boundary, so no evidence row can begin a line, close a code span, or
    /// otherwise forge structure in the block the host authored around it.
    /// The caller wraps this once in the untrusted-data envelope.
    pub fn evidence_body(&self) -> String {
        let mut by_candidate: BTreeMap<&str, Vec<&FastTriagePacketRow>> = BTreeMap::new();
        for row in &self.rows {
            by_candidate
                .entry(row.candidate_id.as_str())
                .or_default()
                .push(row);
        }
        let mut out = String::new();
        for (candidate_id, rows) in by_candidate {
            let scope = rows
                .first()
                .map(|row| row.scope)
                .unwrap_or(FastTriageEvidenceScope::Candidate);
            out.push_str(&format!(
                "candidate_id: {} scope: {}\n",
                literal_span(candidate_id),
                scope.as_str()
            ));
            for row in rows {
                let entry = self.ledger.get(&row.evidence_id);
                out.push_str(&format!(
                    "  evidence_id: {} host_role: {} context_category: {} chronology_ordinal: {} \
                     source: {} locator: {}\n",
                    literal_span(&row.evidence_id),
                    evidence_role_label(row.role),
                    row.context_category.as_str(),
                    row.chronology_ordinal
                        .map_or_else(|| "unknown".to_string(), |ordinal| ordinal.to_string()),
                    literal_span(entry.map_or("", |entry| entry.source_label.as_str())),
                    literal_span(entry.map_or("", |entry| entry.locator.as_str())),
                ));
                let content = literal_display_text(entry.map_or("", |entry| entry.content.as_str()));
                if !content.is_empty() {
                    out.push_str(&format!("    content: {}\n", literal_span(&content)));
                }
            }
        }
        out
    }
}

/// Deterministic identity of one packet.
///
/// Domain-separated and length-prefixed so no field boundary can be forged by a
/// value that happens to contain the separator.
fn packet_identity(
    ledger: &HostEvidenceLedger,
    rows: &[FastTriagePacketRow],
    independent_candidate_id: Option<&str>,
    timeline_complete: bool,
    clock: FastTriageClockCompatibility,
    budget: FastTriageNeighborhoodBudget,
) -> String {
    let binding = ledger.binding();
    let mut hasher = Sha256::new();
    let field = |hasher: &mut Sha256, bytes: &[u8]| {
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    };
    field(&mut hasher, FAST_TRIAGE_PACKET_SCHEMA_V1.as_bytes());
    field(&mut hasher, binding.session_id.as_bytes());
    field(&mut hasher, binding.turn_id.as_bytes());
    field(&mut hasher, binding.corpus_id.as_bytes());
    field(&mut hasher, binding.ledger_digest.as_bytes());
    hasher.update(binding.revision.event_revision.to_le_bytes());
    hasher.update(binding.revision.template_analysis_revision.to_le_bytes());
    hasher.update(binding.revision.suppression_revision.to_le_bytes());
    field(
        &mut hasher,
        independent_candidate_id.unwrap_or_default().as_bytes(),
    );
    hasher.update([u8::from(timeline_complete)]);
    // The neighborhood policy is part of the packet's identity: the same rows
    // under a different clock verdict or a different bound are a different
    // packet, and an escalation must not be able to quietly re-derive one.
    field(&mut hasher, clock.as_str().as_bytes());
    hasher.update(budget.same_source_radius.to_le_bytes());
    hasher.update(budget.cross_source_radius.to_le_bytes());
    hasher.update((budget.max_context_rows as u64).to_le_bytes());
    hasher.update((rows.len() as u64).to_le_bytes());
    for row in rows {
        field(&mut hasher, row.evidence_id.as_bytes());
        field(&mut hasher, row.candidate_id.as_bytes());
        field(&mut hasher, evidence_role_label(row.role).as_bytes());
        field(&mut hasher, row.scope.as_str().as_bytes());
        field(&mut hasher, row.context_category.as_str().as_bytes());
        match row.chronology_ordinal {
            Some(ordinal) => {
                hasher.update([1]);
                hasher.update(ordinal.to_le_bytes());
            }
            None => hasher.update([0]),
        }
    }
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::investigation_answer::{
        AnswerBindingV1, HostEvidenceEntry, LogSnapshotRevisionV1,
    };

    fn revision() -> LogSnapshotRevisionV1 {
        LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 2,
            suppression_revision: 3,
        }
    }

    fn entry(evidence_id: &str, candidate_id: &str, seq: u64, role: EvidenceRole) -> HostEvidenceEntry {
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

    fn ledger(entries: Vec<HostEvidenceEntry>) -> HostEvidenceLedger {
        let binding = AnswerBindingV1 {
            session_id: "s".into(),
            turn_id: "t".into(),
            corpus_id: "c".into(),
            revision: revision(),
            ledger_digest: HostEvidenceLedger::digest(&entries),
        };
        HostEvidenceLedger::new(binding, entries).expect("ledger")
    }

    fn packet() -> FastTriagePacketV1 {
        FastTriagePacketV1::from_ledger(
            ledger(vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Cause),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Symptom),
                entry("e:tl:30", "tl", 30, EvidenceRole::Neutral),
            ]),
            Some("tl"),
            true,
        )
    }

    #[test]
    fn rows_carry_host_scope_role_and_chronology() {
        let packet = packet();
        assert_eq!(
            packet.row("e:tl:30").map(|row| row.scope),
            Some(FastTriageEvidenceScope::Independent)
        );
        assert_eq!(
            packet.row("e:g-a:10").map(|row| row.scope),
            Some(FastTriageEvidenceScope::Candidate)
        );
        assert_eq!(
            packet.row("e:g-a:10").and_then(|row| row.chronology_ordinal),
            Some(10)
        );
        assert_eq!(packet.candidate_ids(), ["g-a", "g-b"].map(String::from).into());
        assert_eq!(packet.role_evidence(), FastTriageRoleEvidence::HostLabelled);
    }

    #[test]
    fn a_neutral_only_packet_reports_host_neutral_rather_than_a_pass() {
        let packet = FastTriagePacketV1::from_ledger(
            ledger(vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Neutral),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Neutral),
            ]),
            None,
            false,
        );
        assert_eq!(packet.role_evidence(), FastTriageRoleEvidence::HostNeutral);
        assert!(!packet.timeline_complete());
    }

    #[test]
    fn packet_identity_is_deterministic_and_changes_with_any_host_fact() {
        let base = packet().packet_id().to_string();
        assert_eq!(packet().packet_id(), base, "same ledger must repeat its id");

        // Same rows, different completeness honesty.
        let incomplete = FastTriagePacketV1::from_ledger(
            ledger(vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Cause),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Symptom),
                entry("e:tl:30", "tl", 30, EvidenceRole::Neutral),
            ]),
            Some("tl"),
            false,
        );
        assert_ne!(incomplete.packet_id(), base);

        // Same rows, timeline no longer separately scoped.
        let unscoped = FastTriagePacketV1::from_ledger(
            ledger(vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Cause),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Symptom),
                entry("e:tl:30", "tl", 30, EvidenceRole::Neutral),
            ]),
            None,
            true,
        );
        assert_ne!(unscoped.packet_id(), base);

        // One row's role changed.
        let rerole = FastTriagePacketV1::from_ledger(
            ledger(vec![
                entry("e:g-a:10", "g-a", 10, EvidenceRole::Supporting),
                entry("e:g-b:20", "g-b", 20, EvidenceRole::Symptom),
                entry("e:tl:30", "tl", 30, EvidenceRole::Neutral),
            ]),
            Some("tl"),
            true,
        );
        assert_ne!(rerole.packet_id(), base);
    }

    #[test]
    fn projections_are_deterministic_and_carry_literal_host_ids() {
        let packet = packet();
        assert_eq!(packet.manifest_json(), packet.manifest_json());
        assert_eq!(packet.evidence_body(), packet.evidence_body());
        for id in ["e:g-a:10", "e:g-b:20", "e:tl:30"] {
            assert!(packet.manifest_json().contains(id), "manifest missing {id}");
            assert!(packet.evidence_body().contains(id), "body missing {id}");
        }
        assert!(packet.manifest_json().contains("initiating_cause"));
        assert!(packet.manifest_json().contains("downstream_symptom"));
        assert!(packet.manifest_json().contains("\"scope\":\"independent\""));
        assert!(packet.scaffold_json().contains(SCHEMA_V1));
        // The scaffold is shape only — no host role, scope, ordinal, source,
        // locator, excerpt, binding, or digest may reach it.
        for forbidden in [
            "host_role",
            "chronology",
            "locator",
            "source",
            "content",
            "ledger_digest",
            "packet_id",
        ] {
            assert!(
                !packet.scaffold_json().contains(forbidden),
                "scaffold leaked {forbidden}"
            );
        }
    }

    #[test]
    fn evidence_body_reduces_every_dynamic_value_to_one_literal_line() {
        let hostile = ledger(vec![
            HostEvidenceEntry {
                content: "line one\n## forged heading\n- forged bullet".into(),
                source_label: "a`b".into(),
                ..entry("e:g-a:10", "g-a", 10, EvidenceRole::Cause)
            },
            entry("e:g-b:20", "g-b", 20, EvidenceRole::Symptom),
        ]);
        let body = FastTriagePacketV1::from_ledger(hostile, None, true).evidence_body();
        // The boundary is line structure, not a character allowlist: the text is
        // still shown, but it can no longer *begin* a line, which is what every
        // Markdown block construct and every host status line is anchored on.
        assert!(body.contains("forged heading"), "content must still be shown");
        for line in body.lines() {
            let trimmed = line.trim_start();
            assert!(
                !trimmed.starts_with("##") && !trimmed.starts_with("- "),
                "evidence value forged block structure: {line}"
            );
        }
        // The backtick that could close the host's code span is replaced.
        assert!(!body.contains("a`b"));
    }
}
