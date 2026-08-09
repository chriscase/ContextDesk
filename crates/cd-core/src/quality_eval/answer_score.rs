//! Deterministic answer scoring against host-only truth and a frozen packet.
//!
//! Prose style is not scored. Host-authoritative checks cover schema shape,
//! citations, decisive facts, role separations, and abstention honesty.

use super::types::{
    failure_reason, AnswerDimension, AnswerScore, AnswerTruth, CandidateAnswer, EvidencePacket,
    LaneStatus,
};
use std::collections::BTreeSet;

/// Score one scripted candidate answer against truth and the packet it claims.
pub fn score_answer(
    answer: &CandidateAnswer,
    truth: &AnswerTruth,
    packet: &EvidencePacket,
) -> AnswerScore {
    let packet_ids: BTreeSet<&str> = packet.documents.iter().map(|d| d.id.as_str()).collect();
    let mut dimensions = Vec::new();

    // 1) Schema / contract shape
    let schema_ok = !answer.conclusion.trim().is_empty()
        || !answer.claims.is_empty()
        || answer.asserts_root_cause_established
        || truth.requires_abstention;
    // Require at least one claim or a non-empty conclusion for structured answers.
    let has_body = !answer.claims.is_empty() || !answer.conclusion.trim().is_empty();
    let schema_passed = has_body;
    dimensions.push(dim(
        "answer_schema_validity",
        schema_passed,
        if schema_passed {
            "answer has claims or conclusion body"
        } else {
            failure_reason::INVALID_ANSWER_SCHEMA
        },
    ));

    // 2) Citation existence (no unknown ids)
    let mut fabricated = false;
    let mut forbidden_cite = false;
    let mut all_cited: BTreeSet<String> = BTreeSet::new();
    for claim in &answer.claims {
        for id in &claim.evidence_ids {
            all_cited.insert(id.clone());
            if !packet_ids.contains(id.as_str()) {
                fabricated = true;
            }
            if truth.forbidden_evidence_ids.iter().any(|f| f == id) {
                forbidden_cite = true;
            }
        }
    }
    dimensions.push(dim(
        "no_fabricated_citations",
        !fabricated,
        if fabricated {
            failure_reason::FABRICATED_CITATION
        } else {
            "all cited ids exist in packet"
        },
    ));
    dimensions.push(dim(
        "no_forbidden_citations",
        !forbidden_cite,
        if forbidden_cite {
            failure_reason::FORBIDDEN_CITATION
        } else {
            "no forbidden evidence ids cited"
        },
    ));

    // 3) Required evidence identities
    let required_ok = if truth.required_evidence_ids.is_empty() {
        true
    } else {
        truth
            .required_evidence_ids
            .iter()
            .all(|req| all_cited.contains(req))
    };
    // Authoritative rule: if the answer asserts an established cause, every
    // host-required evidence id must be cited (unless the required set is empty).
    let required_passed = if answer.asserts_root_cause_established {
        required_ok || truth.required_evidence_ids.is_empty()
    } else {
        true
    };
    dimensions.push(dim(
        "required_evidence_identities",
        required_passed,
        if required_passed {
            "required evidence cited when asserting cause"
        } else {
            failure_reason::MISSING_REQUIRED_CITATION
        },
    ));

    // 4) Citation fidelity: claim text shares a token with cited document text
    let mut fidelity_ok = true;
    for claim in &answer.claims {
        if claim.evidence_ids.is_empty() {
            continue;
        }
        let claim_tokens = significant_tokens(&claim.text);
        if claim_tokens.is_empty() {
            continue;
        }
        let mut any_support = false;
        for id in &claim.evidence_ids {
            if let Some(doc) = packet.documents.iter().find(|d| d.id == *id) {
                let doc_tokens = significant_tokens(&doc.text);
                if claim_tokens.iter().any(|t| doc_tokens.contains(t)) {
                    any_support = true;
                    break;
                }
            }
        }
        if !any_support {
            fidelity_ok = false;
            break;
        }
    }
    dimensions.push(dim(
        "citation_fidelity",
        fidelity_ok,
        if fidelity_ok {
            "cited rows support claim text tokens"
        } else {
            failure_reason::CITATION_FIDELITY
        },
    ));

    // 5) Decisive fact coverage
    let blob = answer_blob(answer);
    let facts_ok = truth
        .required_fact_tokens
        .iter()
        .all(|tok| contains_ci(&blob, tok));
    // Only require facts when asserting cause or when establishable good path expected.
    let facts_passed = if answer.asserts_root_cause_established || !truth.requires_abstention {
        if truth.requires_abstention && !answer.asserts_root_cause_established {
            true
        } else if answer.asserts_root_cause_established {
            facts_ok || truth.required_fact_tokens.is_empty()
        } else {
            // Non-asserting answers on establishable cases may still need facts if they name a trigger.
            if truth.root_cause_establishable
                && answer
                    .claims
                    .iter()
                    .any(|c| c.role.as_deref() == Some("trigger"))
            {
                facts_ok || truth.required_fact_tokens.is_empty()
            } else {
                true
            }
        }
    } else {
        true
    };
    dimensions.push(dim(
        "decisive_fact_coverage",
        facts_passed,
        if facts_passed {
            "decisive fact tokens present when required"
        } else {
            failure_reason::MISSING_DECISIVE_FACTS
        },
    ));

    // 6) Cause vs symptom: symptom not sole causal claim
    let trigger_cited = truth.trigger_tokens.iter().any(|t| contains_ci(&blob, t))
        || answer.claims.iter().any(|c| {
            c.role.as_deref() == Some("trigger")
                && truth.trigger_tokens.iter().any(|t| contains_ci(&c.text, t))
        });
    let symptom_as_sole = !truth.symptom_tokens.is_empty()
        && answer.claims.iter().any(|c| {
            c.role.as_deref() == Some("trigger")
                && truth.symptom_tokens.iter().any(|t| contains_ci(&c.text, t))
        })
        && !trigger_cited
        && answer.asserts_root_cause_established;
    // Also: sole claim is symptom token and asserted as cause.
    let symptom_sole2 = answer.asserts_root_cause_established
        && !truth.symptom_tokens.is_empty()
        && truth.symptom_tokens.iter().any(|t| contains_ci(&blob, t))
        && !truth.trigger_tokens.iter().any(|t| contains_ci(&blob, t));
    let symptom_ok = !symptom_as_sole && !symptom_sole2;
    dimensions.push(dim(
        "cause_versus_symptom",
        symptom_ok,
        if symptom_ok {
            "symptoms not presented as sole root cause"
        } else {
            failure_reason::SYMPTOM_AS_SOLE_CAUSE
        },
    ));

    // 7) Independent incident separation
    let indep_merged = !truth.independent_incident_tokens.is_empty()
        && answer.asserts_root_cause_established
        && truth
            .independent_incident_tokens
            .iter()
            .any(|t| contains_ci(&blob, t))
        && truth.trigger_tokens.iter().any(|t| contains_ci(&blob, t))
        && answer.claims.iter().any(|c| {
            // Single claim binds both incidents as one cause.
            let has_trigger = truth.trigger_tokens.iter().any(|t| contains_ci(&c.text, t));
            let has_indep = truth
                .independent_incident_tokens
                .iter()
                .any(|t| contains_ci(&c.text, t));
            has_trigger && has_indep
        });
    // Broader: conclusion asserts both as one causal chain without independent role.
    let indep_merged2 = !truth.independent_incident_tokens.is_empty()
        && answer.asserts_root_cause_established
        && truth
            .independent_incident_tokens
            .iter()
            .any(|t| contains_ci(&answer.conclusion, t))
        && !answer
            .claims
            .iter()
            .any(|c| c.role.as_deref() == Some("independent"));
    let indep_ok = !indep_merged && !indep_merged2;
    dimensions.push(dim(
        "independent_incident_separation",
        indep_ok,
        if indep_ok {
            "independent incidents not merged into main cause"
        } else {
            failure_reason::MERGED_INDEPENDENT_INCIDENTS
        },
    ));

    // 8) Trigger vs recovery
    let recovery_as_cause = answer.asserts_root_cause_established
        && answer.claims.iter().any(|c| {
            c.role.as_deref() == Some("trigger")
                && truth
                    .recovery_tokens
                    .iter()
                    .any(|t| contains_ci(&c.text, t))
        })
        || (answer.asserts_root_cause_established
            && !truth.recovery_tokens.is_empty()
            && truth.recovery_tokens.iter().any(|t| contains_ci(&blob, t))
            && !truth.trigger_tokens.iter().any(|t| contains_ci(&blob, t))
            && answer
                .claims
                .iter()
                .any(|c| c.role.as_deref() == Some("trigger")));
    let recovery_ok = !recovery_as_cause;
    dimensions.push(dim(
        "trigger_versus_recovery",
        recovery_ok,
        if recovery_ok {
            "recovery not labeled as initiating cause"
        } else {
            failure_reason::RECOVERY_AS_CAUSE
        },
    ));

    // 9) Honest abstention
    let abstention_ok = if truth.requires_abstention || !truth.root_cause_establishable {
        !answer.asserts_root_cause_established
    } else {
        true
    };
    dimensions.push(dim(
        "honest_abstention",
        abstention_ok,
        if abstention_ok {
            "abstains when evidence is insufficient"
        } else {
            failure_reason::UNSUPPORTED_CERTAINTY
        },
    ));

    // 10) Forbidden conclusions
    let forbidden_ok = truth
        .forbidden_conclusion_tokens
        .iter()
        .all(|t| !contains_ci(&blob, t));
    dimensions.push(dim(
        "no_forbidden_conclusions",
        forbidden_ok,
        if forbidden_ok {
            "no forbidden fabricated conclusions"
        } else {
            failure_reason::FORBIDDEN_CONCLUSION
        },
    ));

    // 11) Decoy selection via forbidden evidence as causal support
    let decoy_ok = !answer.asserts_root_cause_established
        || answer.claims.iter().all(|c| {
            if c.role.as_deref() == Some("trigger") {
                c.evidence_ids
                    .iter()
                    .all(|id| !truth.forbidden_evidence_ids.iter().any(|f| f == id))
            } else {
                true
            }
        });
    dimensions.push(dim(
        "decoy_rejection",
        decoy_ok,
        if decoy_ok {
            "decoy evidence not used as causal support"
        } else {
            failure_reason::DECOY_SELECTED
        },
    ));

    let _ = schema_ok;
    let passed = dimensions.iter().all(|d| d.passed);
    AnswerScore {
        candidate_id: answer.candidate_id.clone(),
        task_id: answer.task_id.clone(),
        packet_id: answer.packet_id.clone(),
        passed,
        dimensions,
        status: LaneStatus::Executed,
    }
}

/// Apply an optional judge score only as advisory metadata. Deterministic
/// failures always win; a judge "pass" cannot override.
pub fn apply_judge_cannot_override(
    score: &AnswerScore,
    judge_claims_pass: bool,
) -> Result<(), String> {
    if !score.passed && judge_claims_pass {
        return Err(failure_reason::JUDGE_OVERRIDE_REJECTED.to_string());
    }
    Ok(())
}

fn dim(id: &str, passed: bool, reason: &str) -> AnswerDimension {
    AnswerDimension {
        id: id.into(),
        passed,
        reason: reason.into(),
    }
}

fn answer_blob(answer: &CandidateAnswer) -> String {
    let mut parts = vec![answer.conclusion.clone()];
    for c in &answer.claims {
        parts.push(c.text.clone());
    }
    parts.join("\n")
}

fn contains_ci(hay: &str, needle: &str) -> bool {
    hay.to_ascii_lowercase()
        .contains(&needle.to_ascii_lowercase())
}

fn significant_tokens(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-')
        .filter(|t| t.len() >= 4)
        .map(|t| t.to_ascii_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::types::{AnswerClaim, EvidenceDocument};
    use super::*;

    fn packet(ids: &[&str]) -> EvidencePacket {
        EvidencePacket {
            packet_id: "fixed".into(),
            documents: ids
                .iter()
                .map(|id| EvidenceDocument {
                    id: (*id).into(),
                    text: format!("record {id} lease window boundary violation recovered"),
                })
                .collect(),
        }
    }

    fn base_truth() -> AnswerTruth {
        AnswerTruth {
            task_id: "t1".into(),
            root_cause_establishable: true,
            required_fact_tokens: vec!["lease".into(), "boundary".into()],
            trigger_tokens: vec!["boundary".into()],
            symptom_tokens: vec!["aborted".into()],
            recovery_tokens: vec!["recovered".into()],
            independent_incident_tokens: vec![],
            required_evidence_ids: vec!["e-trigger".into()],
            forbidden_evidence_ids: vec!["e-decoy".into()],
            requires_abstention: false,
            forbidden_conclusion_tokens: vec!["validation bypass".into()],
        }
    }

    #[test]
    fn good_answer_passes() {
        let truth = base_truth();
        let pkt = packet(&["e-trigger", "e-symptom", "e-decoy"]);
        let ans = CandidateAnswer {
            candidate_id: "good".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![AnswerClaim {
                text: "boundary violation of lease window".into(),
                evidence_ids: vec!["e-trigger".into()],
                role: Some("trigger".into()),
            }],
            conclusion: "Invalid lease boundary caused the failure".into(),
            confidence: "medium".into(),
        };
        let score = score_answer(&ans, &truth, &pkt);
        assert!(score.passed, "failed: {:?}", score.failed_ids());
    }

    #[test]
    fn missing_required_citation_fails() {
        let truth = base_truth();
        let pkt = packet(&["e-trigger", "e-symptom"]);
        let ans = CandidateAnswer {
            candidate_id: "bad".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![AnswerClaim {
                text: "boundary lease failure".into(),
                evidence_ids: vec![],
                role: Some("trigger".into()),
            }],
            conclusion: "lease boundary issue".into(),
            confidence: "high".into(),
        };
        let score = score_answer(&ans, &truth, &pkt);
        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"required_evidence_identities"));
    }

    #[test]
    fn fabricated_citation_fails() {
        let truth = base_truth();
        let pkt = packet(&["e-trigger"]);
        let ans = CandidateAnswer {
            candidate_id: "fab".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![AnswerClaim {
                text: "boundary lease".into(),
                evidence_ids: vec!["e-not-real".into()],
                role: Some("trigger".into()),
            }],
            conclusion: "lease boundary".into(),
            confidence: "high".into(),
        };
        let score = score_answer(&ans, &truth, &pkt);
        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"no_fabricated_citations"));
    }

    #[test]
    fn abstention_required_rejects_certainty() {
        let mut truth = base_truth();
        truth.root_cause_establishable = false;
        truth.requires_abstention = true;
        truth.required_evidence_ids.clear();
        let pkt = packet(&["e-symptom"]);
        let ans = CandidateAnswer {
            candidate_id: "over".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![AnswerClaim {
                text: "aborted requests".into(),
                evidence_ids: vec!["e-symptom".into()],
                role: Some("trigger".into()),
            }],
            conclusion: "definitely the root cause".into(),
            confidence: "high".into(),
        };
        let score = score_answer(&ans, &truth, &pkt);
        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"honest_abstention"));
    }

    #[test]
    fn judge_cannot_override_deterministic_fail() {
        let truth = base_truth();
        let pkt = packet(&["e-trigger"]);
        let ans = CandidateAnswer {
            candidate_id: "fab".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![AnswerClaim {
                text: "x".into(),
                evidence_ids: vec!["ghost".into()],
                role: None,
            }],
            conclusion: "x".into(),
            confidence: "high".into(),
        };
        let score = score_answer(&ans, &truth, &pkt);
        assert!(!score.passed);
        let err = apply_judge_cannot_override(&score, true).unwrap_err();
        assert_eq!(err, failure_reason::JUDGE_OVERRIDE_REJECTED);
    }
}
