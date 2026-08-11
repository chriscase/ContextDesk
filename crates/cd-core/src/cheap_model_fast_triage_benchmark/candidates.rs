//! Scripted candidate outputs representing cheap-model shapes.
//!
//! These are **fixtures**, not live model results. They exercise strong,
//! sloppy-recoverable, unsupported, fabricated, omitted, chronology-wrong,
//! overconfident, and partial-extraction behaviours without network I/O.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use crate::investigation_answer::SCHEMA_V1;

use super::cases::{BenchmarkCase, CaseId};

/// Which scripted shape a candidate represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CandidateKind {
    /// Host-acceptable full structured answer.
    StrongStructured,
    /// Minor structural mess that host validation can still accept.
    SloppyRecoverable,
    /// Asserts a cause the host does not support.
    UnsupportedCausalClaim,
    /// Cites an evidence id the host never minted.
    FabricatedCitation,
    /// Omits host-labelled cause/symptom coverage.
    OmittedEvidence,
    /// Inverts chronology (cause after symptom).
    ChronologyError,
    /// Overconfident prose-heavy answer that still fails structure or roles.
    OverconfidentCheapAnswer,
    /// Useful partial extraction only (observations; no unsafe cause assert).
    UsefulPartialExtraction,
    /// Promotes a host-labelled symptom into a causal section.
    SymptomPromotedToCause,
    /// Pulls independent noise into the causal chain.
    IndependentNoisePromoted,
    /// Role confusion: same id as both cause and symptom.
    RoleConfusion,
    /// Invalid structured output (not a single schema object).
    InvalidStructuredOutput,
}

impl CandidateKind {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StrongStructured => "strong_structured",
            Self::SloppyRecoverable => "sloppy_recoverable",
            Self::UnsupportedCausalClaim => "unsupported_causal_claim",
            Self::FabricatedCitation => "fabricated_citation",
            Self::OmittedEvidence => "omitted_evidence",
            Self::ChronologyError => "chronology_error",
            Self::OverconfidentCheapAnswer => "overconfident_cheap_answer",
            Self::UsefulPartialExtraction => "useful_partial_extraction",
            Self::SymptomPromotedToCause => "symptom_promoted_to_cause",
            Self::IndependentNoisePromoted => "independent_noise_promoted",
            Self::RoleConfusion => "role_confusion",
            Self::InvalidStructuredOutput => "invalid_structured_output",
        }
    }
}

/// Path A: one full proposal body.
#[derive(Debug, Clone)]
pub struct PathACandidate {
    /// Shape label.
    pub kind: CandidateKind,
    /// Exactly one JSON object string for the investigation answer schema, or
    /// deliberate invalid text for fail-closed cases.
    pub proposal_body: String,
    /// Optional latency label (metadata only).
    pub latency_label_ms: u64,
    /// Optional token-budget label (metadata only).
    pub token_budget_label: u32,
}

/// Extraction / classification role output.
#[derive(Debug, Clone)]
pub struct ExtractionRole {
    /// Observations only: (candidate_id, claim_id, text, evidence_ids).
    pub observations: Vec<RoleClaim>,
}

/// Causal-role proposal output.
#[derive(Debug, Clone)]
pub struct CausalProposalRole {
    /// Claims the role wants to place in causal/symptom sections.
    pub claims: Vec<TypedRoleClaim>,
}

/// Contradiction / abstention check output.
#[derive(Debug, Clone)]
pub struct ContradictionRole {
    /// Claim ids the checker wants removed before host assembly.
    pub reject_claim_ids: BTreeSet<String>,
    /// When true, demote every initiating_cause to causal_candidate (or drop
    /// if no supporting host cause role would survive validation).
    pub force_abstention: bool,
}

/// Optional reviewer synthesis (may supply a full proposal the host still
/// validates; never trusted without validation).
#[derive(Debug, Clone, Default)]
pub struct ReviewerRole {
    /// Optional full proposal body. Host uses it only when it validates.
    pub optional_full_proposal: Option<String>,
}

/// One untyped observation claim from extraction.
#[derive(Debug, Clone)]
pub struct RoleClaim {
    pub candidate_id: String,
    pub claim_id: String,
    pub text: String,
    pub evidence_ids: Vec<String>,
}

/// Claim kind section for path-B causal proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoleClaimSection {
    Observation,
    Symptom,
    CausalCandidate,
    InitiatingCause,
    CompetingExplanation,
    MissingEvidence,
}

/// One typed claim from the causal-proposal role.
#[derive(Debug, Clone)]
pub struct TypedRoleClaim {
    pub candidate_id: String,
    pub claim_id: String,
    pub section: RoleClaimSection,
    pub text: String,
    pub evidence_ids: Vec<String>,
}

/// Path B role bundle for one candidate kind on one case.
#[derive(Debug, Clone)]
pub struct PathBRoles {
    pub kind: CandidateKind,
    pub extraction: ExtractionRole,
    pub causal: CausalProposalRole,
    pub contradiction: ContradictionRole,
    pub reviewer: ReviewerRole,
    pub latency_label_ms: u64,
    pub token_budget_label: u32,
}

/// Scripted set for one case (path A + path B per kind).
#[derive(Debug, Clone)]
pub struct ScriptedCandidateSet {
    pub case_id: CaseId,
    pub path_a: Vec<PathACandidate>,
    pub path_b: Vec<PathBRoles>,
}

fn claim(id: &str, text: &str, evidence: &[&str]) -> Value {
    json!({
        "claim_id": id,
        "text": text,
        "evidence_ids": evidence,
    })
}

fn proposal(candidates: Value) -> String {
    json!({ "schema": SCHEMA_V1, "candidates": candidates }).to_string()
}

fn ids_for(case: &BenchmarkCase) -> CaseIds {
    CaseIds {
        cause: case.true_cause_evidence_id.unwrap_or(""),
        symptom: case.primary_symptom_evidence_id.unwrap_or(""),
        recovery: case.recovery_evidence_id.unwrap_or(""),
        noise: case.independent_noise_ids.first().copied().unwrap_or(""),
        noise2: case.independent_noise_ids.get(1).copied().unwrap_or(""),
    }
}

struct CaseIds {
    cause: &'static str,
    symptom: &'static str,
    recovery: &'static str,
    noise: &'static str,
    noise2: &'static str,
}

fn candidate_of(evidence_id: &str) -> String {
    // e:trace:alpha:10 → trace:alpha
    let rest = evidence_id.strip_prefix("e:").unwrap_or(evidence_id);
    let mut parts: Vec<&str> = rest.split(':').collect();
    if parts.len() >= 2 {
        parts.pop(); // drop seq
        parts.join(":")
    } else {
        rest.to_string()
    }
}

fn strong_for(case: &BenchmarkCase) -> String {
    let ids = ids_for(case);
    match case.id {
        CaseId::CompleteTimeline => proposal(json!([
            {
                "candidate_id": "trace:alpha",
                "initiating_causes": [claim("c1", "startup constraint violation", &[ids.cause])],
                "observations": [claim("o1", "a retry followed", &["e:trace:alpha:12"])]
            },
            {
                "candidate_id": "template:bravo",
                "symptoms": [claim("s1", "requests rejected downstream", &[ids.symptom])]
            },
            {
                "candidate_id": "global_timeline_context",
                "observations": [
                    claim("g1", "checkpoint written", &["e:global_timeline_context:11"]),
                    claim("g2", "queue depth sampled", &["e:global_timeline_context:41"])
                ]
            }
        ])),
        CaseId::TriggerRecoveryCrossSource => proposal(json!([
            {
                "candidate_id": "svc:orders",
                "initiating_causes": [claim("c1", "connection reservoir exhausted", &[ids.cause])],
                "symptoms": [claim("s1", "order writes could not persist", &[ids.symptom])],
                "observations": [claim("r1", "pool reclaimed; writes resume", &[ids.recovery])]
            },
            {
                "candidate_id": "svc:edge",
                "observations": [claim("e1", "edge latency spike observed", &["e:svc:edge:102"])]
            },
            {
                "candidate_id": "global_timeline_context",
                "observations": [
                    claim("g1", "unrelated cpu sample", &[ids.noise]),
                    claim("g2", "unrelated disk sample", &[ids.noise2])
                ]
            }
        ])),
        CaseId::ContradictionAndDecoy => proposal(json!([
            {
                "candidate_id": "trace:primary",
                "initiating_causes": [claim("c1", "feature_x disabled by deploy", &[ids.cause])],
                "symptoms": [claim("s1", "feature_x path returned 503", &[ids.symptom])]
            },
            {
                "candidate_id": "trace:decoy",
                "observations": [
                    claim("d1", "batch cache warning (independent decoy)", &["e:trace:decoy:15"]),
                    claim("d2", "batch completed with warnings", &["e:trace:decoy:18"])
                ],
                "competing_explanations": [claim(
                    "d3",
                    "batch cache warnings are independent of feature_x",
                    &["e:trace:decoy:15"]
                )]
            },
            {
                "candidate_id": "global_timeline_context",
                "observations": [claim("g1", "background GC sample", &["e:global_timeline_context:22"])]
            }
        ])),
        CaseId::ChronologySensitive => proposal(json!([
            {
                "candidate_id": "trace:chain",
                "initiating_causes": [claim("c1", "schema migration aborted", &[ids.cause])],
                "symptoms": [
                    claim("s1", "missing column on read path", &[ids.symptom]),
                    claim("s2", "health check marked unhealthy", &["e:trace:chain:60"])
                ]
            },
            {
                "candidate_id": "global_timeline_context",
                "observations": [claim("g1", "unrelated request rate sample", &[ids.noise])]
            }
        ])),
    }
}

fn sloppy_for(case: &BenchmarkCase) -> String {
    // Same structure as strong; "sloppy" adds longer prose and a competing
    // explanation on the independent timeline (never on chain evidence — citing
    // an id already used as cause/symptom yields ContradictoryRoles).
    let mut body = strong_for(case);
    let ids = ids_for(case);
    if let Ok(mut value) = serde_json::from_str::<Value>(&body) {
        if let Some(cands) = value.get_mut("candidates").and_then(|c| c.as_array_mut()) {
            // Prefer the independent chronology candidate when present.
            let target = cands.iter_mut().find(|c| {
                c.get("candidate_id").and_then(|v| v.as_str()) == Some("global_timeline_context")
            });
            if let Some(obj) = target.and_then(|c| c.as_object_mut()) {
                let cite = if !ids.noise.is_empty() {
                    ids.noise
                } else {
                    case.packet
                        .rows()
                        .iter()
                        .find(|r| r.candidate_id == "global_timeline_context")
                        .map(|r| r.evidence_id.as_str())
                        .unwrap_or(ids.cause)
                };
                obj.insert(
                    "competing_explanations".into(),
                    json!([claim(
                        "sloppy1",
                        "maybe transient network blip but evidence does not establish that; longer cheap-model prose",
                        &[cite]
                    )]),
                );
            }
        }
        body = value.to_string();
    }
    body
}

fn fabricated_for(case: &BenchmarkCase) -> String {
    let ids = ids_for(case);
    let cause_cand = candidate_of(ids.cause);
    let symptom_cand = candidate_of(ids.symptom);
    proposal(json!([
        {
            "candidate_id": cause_cand,
            "initiating_causes": [claim(
                "c1",
                "invented root with fabricated citation",
                &["e:fabricated:9999"]
            )]
        },
        {
            "candidate_id": symptom_cand,
            "symptoms": [claim("s1", "symptom text", &[ids.symptom])]
        }
    ]))
}

fn unsupported_for(case: &BenchmarkCase) -> String {
    let ids = ids_for(case);
    // Promote independent noise as initiating cause.
    let noise_cand = candidate_of(ids.noise);
    let cause_cand = candidate_of(ids.cause);
    let symptom_cand = candidate_of(ids.symptom);
    let mut candidates = vec![
        json!({
            "candidate_id": noise_cand,
            "initiating_causes": [claim(
                "bad",
                "unrelated sample is the root cause",
                &[ids.noise]
            )]
        }),
        json!({
            "candidate_id": cause_cand,
            "observations": [claim("o1", "mentions real cause without asserting it", &[ids.cause])]
        }),
    ];
    if symptom_cand != cause_cand {
        candidates.push(json!({
            "candidate_id": symptom_cand,
            "symptoms": [claim("s1", "symptom", &[ids.symptom])]
        }));
    } else {
        // same candidate: add symptom section on cause candidate
        if let Some(obj) = candidates.get_mut(1).and_then(|v| v.as_object_mut()) {
            obj.insert(
                "symptoms".into(),
                json!([claim("s1", "symptom", &[ids.symptom])]),
            );
        }
    }
    // Ensure every packet candidate appears
    ensure_all_candidates(case, candidates)
}

fn ensure_all_candidates(case: &BenchmarkCase, mut candidates: Vec<Value>) -> String {
    let present: BTreeSet<String> = candidates
        .iter()
        .filter_map(|c| {
            c.get("candidate_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect();
    let mut needed: BTreeSet<String> = BTreeSet::new();
    for row in case.packet.rows() {
        needed.insert(row.candidate_id.clone());
    }
    for id in needed {
        if !present.contains(&id) {
            // pick first evidence for this candidate
            let eid = case
                .packet
                .rows()
                .iter()
                .find(|r| r.candidate_id == id)
                .map(|r| r.evidence_id.as_str())
                .unwrap_or("");
            candidates.push(json!({
                "candidate_id": id,
                "observations": [claim(&format!("fill-{id}"), "filler observation", &[eid])]
            }));
        }
    }
    proposal(json!(candidates))
}

fn omitted_for(case: &BenchmarkCase) -> String {
    let ids = ids_for(case);
    let cause_cand = candidate_of(ids.cause);
    // Place the cause evidence only as an observation (role coverage fail).
    let mut candidates = vec![json!({
        "candidate_id": cause_cand,
        "observations": [claim("o1", "saw an error", &[ids.cause])]
    })];
    ensure_all_candidates_body(case, &mut candidates, ids.symptom);
    proposal(json!(candidates))
}

fn ensure_all_candidates_body(case: &BenchmarkCase, candidates: &mut Vec<Value>, symptom: &str) {
    let mut present: BTreeSet<String> = candidates
        .iter()
        .filter_map(|c| {
            c.get("candidate_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .collect();
    // One entry per candidate (not per evidence row) so claim/candidate ids stay unique.
    let mut by_candidate: BTreeMap<String, String> = BTreeMap::new();
    for row in case.packet.rows() {
        by_candidate
            .entry(row.candidate_id.clone())
            .or_insert_with(|| row.evidence_id.clone());
    }
    for (cand_id, eid) in by_candidate {
        if present.contains(&cand_id) {
            continue;
        }
        let section = if Some(eid.as_str()) == case.primary_symptom_evidence_id
            || Some(symptom) == Some(eid.as_str())
        {
            "symptoms"
        } else {
            "observations"
        };
        let claim_id = format!("auto-{cand_id}-{eid}");
        candidates.push(json!({
            "candidate_id": cand_id,
            section: [claim(&claim_id, "auto fill", &[eid.as_str()])]
        }));
        present.insert(
            candidates
                .last()
                .and_then(|c| c.get("candidate_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        );
    }
}

fn chronology_error_for(case: &BenchmarkCase) -> String {
    let ids = ids_for(case);
    // For chronology: put initiating cause on later symptom evidence and
    // symptom on earlier cause evidence when both share a candidate.
    if matches!(case.id, CaseId::ChronologySensitive) {
        return proposal(json!([
            {
                "candidate_id": "trace:chain",
                "initiating_causes": [claim(
                    "c1",
                    "claims later symptom is the cause",
                    &["e:trace:chain:60"]
                )],
                "symptoms": [claim("s1", "claims earlier cause is only a symptom", &[ids.cause])]
            },
            {
                "candidate_id": "global_timeline_context",
                "observations": [claim("g1", "noise", &[ids.noise])]
            }
        ]));
    }
    // Other cases: invert by citing symptom as initiating cause with earlier cause as symptom on same candidate when possible.
    let cause_cand = candidate_of(ids.cause);
    let mut candidates = vec![json!({
        "candidate_id": cause_cand,
        "initiating_causes": [claim("c1", "later event as cause", &[ids.symptom])],
        "symptoms": [claim("s1", "earlier event as symptom", &[ids.cause])]
    })];
    // If symptom is different candidate, this becomes symptom-promoted; still a fail-closed shape.
    ensure_all_candidates_body(case, &mut candidates, ids.symptom);
    proposal(json!(candidates))
}

fn overconfident_for(case: &BenchmarkCase) -> String {
    // Prose-heavy invalid structure mixed with certainty language — not valid schema.
    format!(
        "I am completely certain the root cause is obvious from the logs on case {}. \
         Based on my expertise, nothing else could explain it. \
         The definitive answer is: network partition everywhere.",
        case.id.as_str()
    )
}

fn partial_extraction_answer_for(case: &BenchmarkCase) -> String {
    // Valid structure that only observes — omits required role coverage for causes/symptoms.
    let ids = ids_for(case);
    let mut candidates = Vec::new();
    let mut seen = BTreeSet::new();
    for row in case.packet.rows() {
        if seen.insert(row.candidate_id.clone()) {
            candidates.push(json!({
                "candidate_id": row.candidate_id,
                "observations": [claim(
                    &format!("obs-{}", row.evidence_id),
                    "extracted observation only",
                    &[row.evidence_id.as_str()]
                )]
            }));
        }
    }
    let _ = ids;
    proposal(json!(candidates))
}

fn symptom_promoted_for(case: &BenchmarkCase) -> String {
    let ids = ids_for(case);
    let symptom_cand = candidate_of(ids.symptom);
    let cause_cand = candidate_of(ids.cause);
    let mut candidates = vec![
        json!({
            "candidate_id": cause_cand,
            "initiating_causes": [claim("c1", "true cause", &[ids.cause])]
        }),
        json!({
            "candidate_id": symptom_cand,
            "causal_candidates": [claim(
                "bad",
                "promoted symptom as causal",
                &[ids.symptom]
            )]
        }),
    ];
    if cause_cand == symptom_cand {
        candidates = vec![json!({
            "candidate_id": cause_cand,
            "initiating_causes": [claim("c1", "true cause", &[ids.cause])],
            "causal_candidates": [claim("bad", "promoted symptom as causal", &[ids.symptom])]
        })];
    }
    ensure_all_candidates_body(case, &mut candidates, ids.symptom);
    proposal(json!(candidates))
}

fn independent_promoted_for(case: &BenchmarkCase) -> String {
    let ids = ids_for(case);
    let noise_cand = candidate_of(ids.noise);
    let cause_cand = candidate_of(ids.cause);
    let mut candidates = vec![
        json!({
            "candidate_id": cause_cand,
            "initiating_causes": [claim("c1", "true cause", &[ids.cause])]
        }),
        json!({
            "candidate_id": noise_cand,
            "symptoms": [claim("n1", "noise treated as symptom chain", &[ids.noise])]
        }),
    ];
    ensure_all_candidates_body(case, &mut candidates, ids.symptom);
    // If symptom candidate missing from above, add properly
    if let Some(sym) = case.primary_symptom_evidence_id {
        let sc = candidate_of(sym);
        let present: BTreeSet<_> = candidates
            .iter()
            .filter_map(|c| {
                c.get("candidate_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
            .collect();
        if !present.contains(&sc) {
            candidates.push(json!({
                "candidate_id": sc,
                "symptoms": [claim("s1", "symptom", &[sym])]
            }));
        } else if sc != cause_cand {
            // ensure symptom section exists
            for c in &mut candidates {
                if c.get("candidate_id").and_then(|v| v.as_str()) == Some(sc.as_str())
                    && c.get("symptoms").is_none()
                {
                    if let Some(o) = c.as_object_mut() {
                        o.insert("symptoms".into(), json!([claim("s1", "symptom", &[sym])]));
                    }
                }
            }
        } else {
            for c in &mut candidates {
                if c.get("candidate_id").and_then(|v| v.as_str()) == Some(cause_cand.as_str()) {
                    if let Some(o) = c.as_object_mut() {
                        o.insert("symptoms".into(), json!([claim("s1", "symptom", &[sym])]));
                    }
                }
            }
        }
    }
    proposal(json!(candidates))
}

fn role_confusion_for(case: &BenchmarkCase) -> String {
    let ids = ids_for(case);
    let cause_cand = candidate_of(ids.cause);
    // Same evidence as both initiating cause and symptom.
    let mut candidates = vec![json!({
        "candidate_id": cause_cand,
        "initiating_causes": [claim("c1", "cause", &[ids.cause])],
        "symptoms": [claim("s1", "same id also as symptom", &[ids.cause])]
    })];
    ensure_all_candidates_body(case, &mut candidates, ids.symptom);
    proposal(json!(candidates))
}

/// Path A candidate for one kind on one case.
pub fn path_a_candidate(case: &BenchmarkCase, kind: CandidateKind) -> PathACandidate {
    let proposal_body = match kind {
        CandidateKind::StrongStructured => strong_for(case),
        CandidateKind::SloppyRecoverable => sloppy_for(case),
        CandidateKind::UnsupportedCausalClaim => unsupported_for(case),
        CandidateKind::FabricatedCitation => fabricated_for(case),
        CandidateKind::OmittedEvidence => omitted_for(case),
        CandidateKind::ChronologyError => chronology_error_for(case),
        CandidateKind::OverconfidentCheapAnswer => overconfident_for(case),
        CandidateKind::UsefulPartialExtraction => partial_extraction_answer_for(case),
        CandidateKind::SymptomPromotedToCause => symptom_promoted_for(case),
        CandidateKind::IndependentNoisePromoted => independent_promoted_for(case),
        CandidateKind::RoleConfusion => role_confusion_for(case),
        CandidateKind::InvalidStructuredOutput => {
            "```json\n{\"not\": \"a valid investigation answer\"}\n```".into()
        }
    };
    PathACandidate {
        kind,
        proposal_body,
        latency_label_ms: match kind {
            CandidateKind::StrongStructured => 800,
            CandidateKind::SloppyRecoverable => 950,
            CandidateKind::UsefulPartialExtraction => 400,
            _ => 700,
        },
        token_budget_label: match kind {
            CandidateKind::OverconfidentCheapAnswer => 2048,
            CandidateKind::UsefulPartialExtraction => 512,
            _ => 1024,
        },
    }
}

/// Path B role bundle approximating the same shape.
pub fn path_b_roles(case: &BenchmarkCase, kind: CandidateKind) -> PathBRoles {
    let ids = ids_for(case);
    let cause_cand = candidate_of(ids.cause);
    let symptom_cand = candidate_of(ids.symptom);
    let noise_cand = candidate_of(ids.noise);

    let mut extraction_obs = Vec::new();
    for row in case.packet.rows() {
        extraction_obs.push(RoleClaim {
            candidate_id: row.candidate_id.clone(),
            claim_id: format!("ex-{}", row.evidence_id),
            text: format!("extracted: {}", row.evidence_id),
            evidence_ids: vec![row.evidence_id.clone()],
        });
    }

    let (causal, contradiction, reviewer) = match kind {
        CandidateKind::StrongStructured | CandidateKind::SloppyRecoverable => {
            let mut claims = vec![
                TypedRoleClaim {
                    candidate_id: cause_cand.clone(),
                    claim_id: "c1".into(),
                    section: RoleClaimSection::InitiatingCause,
                    text: "host-supported initiating cause".into(),
                    evidence_ids: vec![ids.cause.into()],
                },
                TypedRoleClaim {
                    candidate_id: symptom_cand.clone(),
                    claim_id: "s1".into(),
                    section: RoleClaimSection::Symptom,
                    text: "host-supported symptom".into(),
                    evidence_ids: vec![ids.symptom.into()],
                },
            ];
            if let Some(rec) = case.recovery_evidence_id {
                claims.push(TypedRoleClaim {
                    candidate_id: candidate_of(rec),
                    claim_id: "r1".into(),
                    section: RoleClaimSection::Observation,
                    text: "recovery observed".into(),
                    evidence_ids: vec![rec.into()],
                });
            }
            if kind == CandidateKind::SloppyRecoverable {
                let noise_id = if !ids.noise.is_empty() {
                    ids.noise.to_string()
                } else {
                    case.packet
                        .rows()
                        .iter()
                        .find(|r| r.candidate_id == "global_timeline_context")
                        .map(|r| r.evidence_id.clone())
                        .unwrap_or_else(|| ids.cause.into())
                };
                claims.push(TypedRoleClaim {
                    candidate_id: candidate_of(&noise_id),
                    claim_id: "sloppy1".into(),
                    section: RoleClaimSection::CompetingExplanation,
                    text: "maybe network blip (unsupported); longer cheap-model prose".into(),
                    evidence_ids: vec![noise_id],
                });
            }
            (
                CausalProposalRole { claims },
                ContradictionRole {
                    reject_claim_ids: BTreeSet::new(),
                    force_abstention: false,
                },
                ReviewerRole::default(),
            )
        }
        CandidateKind::UsefulPartialExtraction => (
            CausalProposalRole { claims: vec![] },
            ContradictionRole {
                reject_claim_ids: BTreeSet::new(),
                force_abstention: true,
            },
            ReviewerRole::default(),
        ),
        CandidateKind::FabricatedCitation => (
            CausalProposalRole {
                claims: vec![TypedRoleClaim {
                    candidate_id: cause_cand.clone(),
                    claim_id: "fab".into(),
                    section: RoleClaimSection::InitiatingCause,
                    text: "fabricated".into(),
                    evidence_ids: vec!["e:fabricated:9999".into()],
                }],
            },
            ContradictionRole {
                reject_claim_ids: BTreeSet::new(),
                force_abstention: false,
            },
            ReviewerRole::default(),
        ),
        CandidateKind::UnsupportedCausalClaim => (
            CausalProposalRole {
                claims: vec![TypedRoleClaim {
                    candidate_id: noise_cand.clone(),
                    claim_id: "bad".into(),
                    section: RoleClaimSection::InitiatingCause,
                    text: "noise as root".into(),
                    evidence_ids: vec![ids.noise.into()],
                }],
            },
            ContradictionRole {
                reject_claim_ids: BTreeSet::new(),
                force_abstention: false,
            },
            ReviewerRole::default(),
        ),
        CandidateKind::OmittedEvidence => (
            CausalProposalRole { claims: vec![] },
            ContradictionRole {
                reject_claim_ids: BTreeSet::new(),
                force_abstention: false,
            },
            ReviewerRole::default(),
        ),
        CandidateKind::ChronologyError => (
            CausalProposalRole {
                claims: vec![
                    TypedRoleClaim {
                        candidate_id: cause_cand.clone(),
                        claim_id: "c1".into(),
                        section: RoleClaimSection::InitiatingCause,
                        text: "later as cause".into(),
                        evidence_ids: vec![if matches!(case.id, CaseId::ChronologySensitive) {
                            "e:trace:chain:60".into()
                        } else {
                            ids.symptom.into()
                        }],
                    },
                    TypedRoleClaim {
                        candidate_id: cause_cand.clone(),
                        claim_id: "s1".into(),
                        section: RoleClaimSection::Symptom,
                        text: "earlier as symptom".into(),
                        evidence_ids: vec![ids.cause.into()],
                    },
                ],
            },
            ContradictionRole {
                reject_claim_ids: BTreeSet::new(),
                force_abstention: false,
            },
            ReviewerRole::default(),
        ),
        CandidateKind::SymptomPromotedToCause => (
            CausalProposalRole {
                claims: vec![
                    TypedRoleClaim {
                        candidate_id: cause_cand.clone(),
                        claim_id: "c1".into(),
                        section: RoleClaimSection::InitiatingCause,
                        text: "true cause".into(),
                        evidence_ids: vec![ids.cause.into()],
                    },
                    TypedRoleClaim {
                        candidate_id: symptom_cand.clone(),
                        claim_id: "bad".into(),
                        section: RoleClaimSection::CausalCandidate,
                        text: "promoted symptom".into(),
                        evidence_ids: vec![ids.symptom.into()],
                    },
                ],
            },
            ContradictionRole {
                reject_claim_ids: BTreeSet::new(),
                force_abstention: false,
            },
            ReviewerRole::default(),
        ),
        CandidateKind::IndependentNoisePromoted => (
            CausalProposalRole {
                claims: vec![
                    TypedRoleClaim {
                        candidate_id: cause_cand.clone(),
                        claim_id: "c1".into(),
                        section: RoleClaimSection::InitiatingCause,
                        text: "true cause".into(),
                        evidence_ids: vec![ids.cause.into()],
                    },
                    TypedRoleClaim {
                        candidate_id: symptom_cand.clone(),
                        claim_id: "s1".into(),
                        section: RoleClaimSection::Symptom,
                        text: "symptom".into(),
                        evidence_ids: vec![ids.symptom.into()],
                    },
                    TypedRoleClaim {
                        candidate_id: noise_cand.clone(),
                        claim_id: "n1".into(),
                        section: RoleClaimSection::Symptom,
                        text: "noise as chain".into(),
                        evidence_ids: vec![ids.noise.into()],
                    },
                ],
            },
            ContradictionRole {
                reject_claim_ids: BTreeSet::new(),
                force_abstention: false,
            },
            ReviewerRole::default(),
        ),
        CandidateKind::RoleConfusion => (
            CausalProposalRole {
                claims: vec![
                    TypedRoleClaim {
                        candidate_id: cause_cand.clone(),
                        claim_id: "c1".into(),
                        section: RoleClaimSection::InitiatingCause,
                        text: "cause".into(),
                        evidence_ids: vec![ids.cause.into()],
                    },
                    TypedRoleClaim {
                        candidate_id: cause_cand.clone(),
                        claim_id: "s1".into(),
                        section: RoleClaimSection::Symptom,
                        text: "same id as symptom".into(),
                        evidence_ids: vec![ids.cause.into()],
                    },
                ],
            },
            ContradictionRole {
                reject_claim_ids: BTreeSet::new(),
                force_abstention: false,
            },
            ReviewerRole::default(),
        ),
        CandidateKind::OverconfidentCheapAnswer | CandidateKind::InvalidStructuredOutput => (
            CausalProposalRole { claims: vec![] },
            ContradictionRole {
                reject_claim_ids: BTreeSet::new(),
                force_abstention: false,
            },
            ReviewerRole {
                optional_full_proposal: Some(overconfident_for(case)),
            },
        ),
    };

    // For path B strong path, extraction still provides observations for all
    // candidates so assembly can fill coverage.
    PathBRoles {
        kind,
        extraction: ExtractionRole {
            observations: extraction_obs,
        },
        causal,
        contradiction,
        reviewer,
        latency_label_ms: 1200,
        token_budget_label: 1536,
    }
}

/// All path-A kinds exercised in the matrix for a case.
pub fn matrix_path_a_kinds() -> &'static [CandidateKind] {
    &[
        CandidateKind::StrongStructured,
        CandidateKind::SloppyRecoverable,
        CandidateKind::UnsupportedCausalClaim,
        CandidateKind::FabricatedCitation,
        CandidateKind::OmittedEvidence,
        CandidateKind::ChronologyError,
        CandidateKind::OverconfidentCheapAnswer,
        CandidateKind::UsefulPartialExtraction,
        CandidateKind::SymptomPromotedToCause,
        CandidateKind::IndependentNoisePromoted,
        CandidateKind::RoleConfusion,
        CandidateKind::InvalidStructuredOutput,
    ]
}

/// All path-B kinds exercised in the matrix for a case.
pub fn matrix_path_b_kinds() -> &'static [CandidateKind] {
    matrix_path_a_kinds()
}
