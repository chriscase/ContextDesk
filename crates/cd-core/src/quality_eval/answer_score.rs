//! Deterministic answer scoring against host-only truth and a frozen packet.
//!
//! Prose style is not scored. Host-authoritative checks cover schema shape,
//! citations, decisive facts, role separations, and abstention honesty.

use super::diagnostic_score::score_diagnostic_dimensions;
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
    let packet_truth = truth.packet_overrides.get(&packet.packet_id);
    let root_cause_establishable = packet_truth
        .map(|override_truth| override_truth.root_cause_establishable)
        .unwrap_or(truth.root_cause_establishable);
    let requires_abstention = packet_truth
        .map(|override_truth| override_truth.requires_abstention)
        .unwrap_or(truth.requires_abstention);

    // 1) Schema / contract shape
    // Require a body plus the declared confidence/claim vocabulary. Unknown
    // role strings must not bypass the typed causal checks below.
    let has_body = !answer.claims.is_empty() || !answer.conclusion.trim().is_empty();
    let confidence_ok = matches!(answer.confidence.as_str(), "high" | "medium" | "low");
    let claims_well_formed = answer.claims.iter().all(|claim| {
        !claim.text.trim().is_empty()
            && claim.role.as_deref().is_none_or(|role| {
                matches!(
                    role,
                    "trigger" | "symptom" | "recovery" | "independent" | "observation" | "other"
                )
            })
    });
    let schema_passed = has_body && confidence_ok && claims_well_formed;
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

    // 4) Citation lexical overlap. This is deliberately a structural smoke
    // check, not semantic entailment or a claim that the citation proves the
    // prose.
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
        "citation_lexical_overlap",
        fidelity_ok,
        if fidelity_ok {
            "claim and a cited row share a significant token; entailment not evaluated"
        } else {
            failure_reason::CITATION_LACKS_LEXICAL_OVERLAP
        },
    ));

    // 5) Decisive fact coverage
    let blob = answer_blob(answer);
    let facts_ok = truth
        .required_fact_tokens
        .iter()
        .all(|tok| contains_ci(&blob, tok));
    // Only require facts when asserting cause or when establishable good path expected.
    let facts_passed = if answer.asserts_root_cause_established || !requires_abstention {
        if requires_abstention && !answer.asserts_root_cause_established {
            true
        } else if answer.asserts_root_cause_established {
            facts_ok || truth.required_fact_tokens.is_empty()
        } else {
            // Non-asserting answers on establishable cases may still need facts if they name a trigger.
            if root_cause_establishable
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

    // 6) Recall of an establishable cause. A generic non-answer must not earn
    // quality credit merely because it avoided every forbidden assertion.
    let establishable_recalled =
        !root_cause_establishable || requires_abstention || answer.asserts_root_cause_established;
    dimensions.push(dim(
        "establishable_cause_recall",
        establishable_recalled,
        if establishable_recalled {
            "establishable cause identified"
        } else {
            failure_reason::MISSED_ESTABLISHABLE_CAUSE
        },
    ));

    let causal_role_ok = !answer.asserts_root_cause_established
        || answer
            .claims
            .iter()
            .any(|claim| claim.role.as_deref() == Some("trigger"));
    dimensions.push(dim(
        "causal_role_contract",
        causal_role_ok,
        if causal_role_ok {
            "established cause has a typed trigger claim"
        } else {
            failure_reason::MISSING_TRIGGER_ROLE
        },
    ));

    // 8) Cause vs symptom.
    //
    // Invariant: a valid trigger claim must not mask a coexisting claim that
    // promotes a truth-labeled symptom into the initiating trigger role.
    // Fail closed only when truth tokens establish the role conflict on a
    // trigger-role claim that does not also carry trigger tokens.
    let symptom_promoted_to_trigger = answer.asserts_root_cause_established
        && !truth.symptom_tokens.is_empty()
        && answer.claims.iter().any(|c| {
            c.role.as_deref() == Some("trigger")
                && truth.symptom_tokens.iter().any(|t| contains_ci(&c.text, t))
                && !truth.trigger_tokens.iter().any(|t| contains_ci(&c.text, t))
        });
    // Unstructured path: symptom tokens appear while no trigger tokens do.
    let symptom_without_trigger = answer.asserts_root_cause_established
        && !truth.symptom_tokens.is_empty()
        && truth.symptom_tokens.iter().any(|t| contains_ci(&blob, t))
        && !truth.trigger_tokens.iter().any(|t| contains_ci(&blob, t));
    let symptom_ok = !symptom_promoted_to_trigger && !symptom_without_trigger;
    let symptom_reason = if symptom_ok {
        "symptoms not labeled as initiating trigger"
    } else if symptom_promoted_to_trigger {
        failure_reason::SYMPTOM_PROMOTED_TO_TRIGGER
    } else {
        failure_reason::SYMPTOM_AS_SOLE_CAUSE
    };
    dimensions.push(dim("cause_versus_symptom", symptom_ok, symptom_reason));

    // 9) Independent incident separation.
    //
    // Invariant: a valid main-cause answer must not mask demoting an
    // independent incident into the main chain via typed role (trigger or
    // symptom). Fail closed only when truth tokens establish the conflict.
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
    // Role demotion: independent tokens labeled as main-chain trigger/symptom
    // while the main trigger is also present. A correct independent role does
    // not collide with this check.
    let indep_demoted = !truth.independent_incident_tokens.is_empty()
        && answer.asserts_root_cause_established
        && truth.trigger_tokens.iter().any(|t| contains_ci(&blob, t))
        && answer.claims.iter().any(|c| {
            let has_indep = truth
                .independent_incident_tokens
                .iter()
                .any(|t| contains_ci(&c.text, t));
            has_indep && matches!(c.role.as_deref(), Some("trigger") | Some("symptom"))
        });
    let indep_ok = !indep_merged && !indep_merged2 && !indep_demoted;
    let indep_reason = if indep_ok {
        "independent incidents not merged into main cause"
    } else if indep_merged || indep_merged2 {
        failure_reason::MERGED_INDEPENDENT_INCIDENTS
    } else {
        failure_reason::INDEPENDENT_DEMOTED_INTO_MAIN
    };
    dimensions.push(dim(
        "independent_incident_separation",
        indep_ok,
        indep_reason,
    ));

    // 10) Trigger vs recovery
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

    // 11) Honest abstention
    let must_abstain = requires_abstention || !root_cause_establishable;
    let abstention_ok = if must_abstain {
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

    let abstention_contract_ok = if must_abstain {
        let conclusion = answer.conclusion.to_ascii_lowercase();
        let explicitly_states_limit = [
            "not established",
            "cannot establish",
            "can't establish",
            "unable to establish",
            "insufficient evidence",
            "not enough evidence",
            "not enough information",
            "cannot determine",
            "can't determine",
            "inconclusive",
        ]
        .iter()
        .any(|marker| conclusion.contains(marker));
        let confidence_is_cautious = matches!(answer.confidence.as_str(), "low" | "medium");
        let has_no_trigger_claim = answer
            .claims
            .iter()
            .all(|claim| claim.role.as_deref() != Some("trigger"));
        !answer.asserts_root_cause_established
            && explicitly_states_limit
            && confidence_is_cautious
            && has_no_trigger_claim
    } else {
        true
    };
    dimensions.push(dim(
        "abstention_contract",
        abstention_contract_ok,
        if abstention_contract_ok {
            "abstention explicitly states the evidence limit with cautious confidence"
        } else {
            failure_reason::INVALID_ABSTENTION_CONTRACT
        },
    ));

    let abstention_basis_ok = if must_abstain {
        let has_cited_observation = answer
            .claims
            .iter()
            .any(|claim| !claim.evidence_ids.is_empty());
        let names_observed_condition = truth.symptom_tokens.is_empty()
            || truth
                .symptom_tokens
                .iter()
                .any(|token| contains_ci(&blob, token));
        has_cited_observation && names_observed_condition
    } else {
        true
    };
    dimensions.push(dim(
        "abstention_evidence_basis",
        abstention_basis_ok,
        if abstention_basis_ok {
            "abstention identifies and cites the observed condition"
        } else {
            failure_reason::UNSUPPORTED_ABSTENTION
        },
    ));

    // 13) Forbidden conclusions
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

    // 14) Decoy selection via forbidden evidence as causal support
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

    // 15) Contradictory cause assertion vs abstention language.
    let abstention_markers = [
        "not established",
        "cannot establish",
        "can't establish",
        "unable to establish",
        "insufficient evidence",
        "not enough evidence",
        "not enough information",
        "cannot determine",
        "can't determine",
        "inconclusive",
    ];
    let contradiction = answer.asserts_root_cause_established
        && abstention_markers
            .iter()
            .any(|marker| answer.conclusion.to_ascii_lowercase().contains(marker));
    dimensions.push(dim(
        "cause_abstention_consistency",
        !contradiction,
        if contradiction {
            failure_reason::CONTRADICTORY_CAUSE_ABSTENTION
        } else {
            "cause assertion and abstention language are consistent"
        },
    ));

    // 16) Diagnostic honesty (gateway/tool/role) — same answer score envelope.
    score_diagnostic_dimensions(
        answer.diagnostic.as_ref(),
        truth.diagnostic.as_ref(),
        &mut dimensions,
    );

    let passed = dimensions.iter().all(|d| d.passed);
    AnswerScore {
        candidate_id: answer.candidate_id.clone(),
        task_id: answer.task_id.clone(),
        packet_id: answer.packet_id.clone(),
        passed,
        dimensions,
        status: LaneStatus::Executed,
        expected_outcome: None,
        expectation_met: None,
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
    use super::super::types::{AnswerClaim, EvidenceDocument, PacketAnswerTruth};
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
            packet_overrides: Default::default(),
            forbidden_conclusion_tokens: vec!["validation bypass".into()],
            diagnostic: None,
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
            diagnostic: None,
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
            diagnostic: None,
        };
        let score = score_answer(&ans, &truth, &pkt);
        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"required_evidence_identities"));
    }

    #[test]
    fn generic_non_answer_fails_when_cause_is_establishable() {
        let truth = base_truth();
        let pkt = packet(&["e-trigger", "e-symptom"]);
        let ans = CandidateAnswer {
            candidate_id: "generic".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: false,
            claims: vec![],
            conclusion: "The available evidence is inconclusive.".into(),
            confidence: "low".into(),
            diagnostic: None,
        };

        let score = score_answer(&ans, &truth, &pkt);

        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"establishable_cause_recall"));
        assert!(score
            .dimensions
            .iter()
            .any(|d| d.reason == failure_reason::MISSED_ESTABLISHABLE_CAUSE));
    }

    #[test]
    fn establishability_is_resolved_per_packet() {
        let mut truth = base_truth();
        truth.packet_overrides.insert(
            "product_path".into(),
            PacketAnswerTruth {
                root_cause_establishable: false,
                requires_abstention: true,
            },
        );
        truth.symptom_tokens = vec!["lease".into()];
        let mut pkt = packet(&["e-symptom"]);
        let mut ans = CandidateAnswer {
            candidate_id: "packet-abstention".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: false,
            claims: vec![AnswerClaim {
                text: "lease symptom observation".into(),
                evidence_ids: vec!["e-symptom".into()],
                role: Some("symptom".into()),
            }],
            conclusion: "The initiating cause is not established from this packet.".into(),
            confidence: "low".into(),
            diagnostic: None,
        };

        let fixed = score_answer(&ans, &truth, &pkt);
        assert!(!fixed.passed);
        assert!(fixed.failed_ids().contains(&"establishable_cause_recall"));

        pkt.packet_id = "product_path".into();
        ans.packet_id = "product_path".into();
        let product = score_answer(&ans, &truth, &pkt);
        assert!(product.passed, "failed: {:?}", product.failed_ids());
    }

    #[test]
    fn asserted_cause_requires_known_roles_and_a_trigger_claim() {
        let truth = base_truth();
        let pkt = packet(&["e-trigger", "e-symptom"]);
        let mut ans = CandidateAnswer {
            candidate_id: "roleless".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![AnswerClaim {
                text: "boundary violation of lease window".into(),
                evidence_ids: vec!["e-trigger".into()],
                role: Some("banana".into()),
            }],
            conclusion: "Invalid lease boundary caused the failure".into(),
            confidence: "medium".into(),
            diagnostic: None,
        };

        let unknown_role = score_answer(&ans, &truth, &pkt);
        assert!(!unknown_role.passed);
        assert!(unknown_role
            .failed_ids()
            .contains(&"answer_schema_validity"));
        assert!(unknown_role.failed_ids().contains(&"causal_role_contract"));

        ans.claims[0].role = Some("other".into());
        let missing_trigger = score_answer(&ans, &truth, &pkt);
        assert!(!missing_trigger.passed);
        assert!(!missing_trigger
            .failed_ids()
            .contains(&"answer_schema_validity"));
        assert!(missing_trigger
            .failed_ids()
            .contains(&"causal_role_contract"));
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
            diagnostic: None,
        };
        let score = score_answer(&ans, &truth, &pkt);
        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"no_fabricated_citations"));
    }

    #[test]
    fn citation_overlap_is_a_named_structural_check_not_entailment() {
        let truth = base_truth();
        let pkt = packet(&["e-trigger"]);
        let ans = CandidateAnswer {
            candidate_id: "no-overlap".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![AnswerClaim {
                text: "zebra orchard quartz".into(),
                evidence_ids: vec!["e-trigger".into()],
                role: Some("trigger".into()),
            }],
            conclusion: "Invalid lease boundary caused the failure".into(),
            confidence: "medium".into(),
            diagnostic: None,
        };

        let score = score_answer(&ans, &truth, &pkt);

        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"citation_lexical_overlap"));
        assert!(score.dimensions.iter().any(|dimension| {
            dimension.reason == failure_reason::CITATION_LACKS_LEXICAL_OVERLAP
        }));
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
            diagnostic: None,
        };
        let score = score_answer(&ans, &truth, &pkt);
        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"honest_abstention"));
    }

    #[test]
    fn generic_abstention_without_an_evidence_basis_fails() {
        let mut truth = base_truth();
        truth.root_cause_establishable = false;
        truth.requires_abstention = true;
        truth.required_evidence_ids.clear();
        let pkt = packet(&["e-symptom"]);
        let ans = CandidateAnswer {
            candidate_id: "generic-abstention".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: false,
            claims: vec![],
            conclusion: "There is not enough information.".into(),
            confidence: "low".into(),
            diagnostic: None,
        };

        let score = score_answer(&ans, &truth, &pkt);

        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"abstention_evidence_basis"));
        assert!(score
            .dimensions
            .iter()
            .any(|dimension| dimension.reason == failure_reason::UNSUPPORTED_ABSTENTION));
    }

    #[test]
    fn confident_causal_prose_cannot_hide_behind_a_false_assertion_flag() {
        let mut truth = base_truth();
        truth.root_cause_establishable = false;
        truth.requires_abstention = true;
        truth.required_evidence_ids.clear();
        truth.required_fact_tokens.clear();
        truth.trigger_tokens.clear();
        truth.symptom_tokens = vec!["aborted".into()];
        let pkt = packet(&["e-symptom"]);
        let ans = CandidateAnswer {
            candidate_id: "hidden-certainty".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: false,
            claims: vec![AnswerClaim {
                text: "aborted requests".into(),
                evidence_ids: vec!["e-symptom".into()],
                role: Some("symptom".into()),
            }],
            conclusion:
                "The database pool was certainly misconfigured; that caused the aborted requests."
                    .into(),
            confidence: "high".into(),
            diagnostic: None,
        };

        let score = score_answer(&ans, &truth, &pkt);

        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"abstention_contract"));
        assert!(score
            .dimensions
            .iter()
            .any(|dimension| { dimension.reason == failure_reason::INVALID_ABSTENTION_CONTRACT }));
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
            diagnostic: None,
        };
        let score = score_answer(&ans, &truth, &pkt);
        assert!(!score.passed);
        let err = apply_judge_cannot_override(&score, true).unwrap_err();
        assert_eq!(err, failure_reason::JUDGE_OVERRIDE_REJECTED);
    }

    #[test]
    fn valid_trigger_does_not_mask_symptom_promoted_to_trigger() {
        let mut truth = base_truth();
        truth.independent_incident_tokens = vec!["telemetry".into()];
        let pkt = packet(&["e-trigger", "e-symptom", "e-indep"]);
        let ans = CandidateAnswer {
            candidate_id: "masked-symptom".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![
                AnswerClaim {
                    text: "boundary violation of lease window".into(),
                    evidence_ids: vec!["e-trigger".into()],
                    role: Some("trigger".into()),
                },
                AnswerClaim {
                    text: "aborted requests from worker loss".into(),
                    evidence_ids: vec!["e-symptom".into()],
                    role: Some("trigger".into()),
                },
            ],
            conclusion: "Lease boundary and aborted requests jointly caused the outage".into(),
            confidence: "high".into(),
            diagnostic: None,
        };

        let score = score_answer(&ans, &truth, &pkt);

        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"cause_versus_symptom"));
        assert!(score.dimensions.iter().any(|d| {
            d.id == "cause_versus_symptom"
                && d.reason == failure_reason::SYMPTOM_PROMOTED_TO_TRIGGER
        }));
    }

    #[test]
    fn valid_trigger_does_not_mask_independent_demoted_to_symptom() {
        let mut truth = base_truth();
        truth.independent_incident_tokens = vec!["telemetry".into()];
        let mut pkt = packet(&["e-trigger", "e-symptom", "e-indep"]);
        pkt.documents[2].text = "record e-indep telemetry sink timeout after recovery".into();
        let ans = CandidateAnswer {
            candidate_id: "masked-independent".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![
                AnswerClaim {
                    text: "boundary violation of lease window".into(),
                    evidence_ids: vec!["e-trigger".into()],
                    role: Some("trigger".into()),
                },
                AnswerClaim {
                    text: "telemetry sink timeout is a symptom of broader stress".into(),
                    evidence_ids: vec!["e-indep".into()],
                    role: Some("symptom".into()),
                },
            ],
            conclusion: "Lease boundary drove the outage chain including sink stress".into(),
            confidence: "high".into(),
            diagnostic: None,
        };

        let score = score_answer(&ans, &truth, &pkt);

        assert!(!score.passed);
        assert!(score
            .failed_ids()
            .contains(&"independent_incident_separation"));
        assert!(score.dimensions.iter().any(|d| {
            d.id == "independent_incident_separation"
                && d.reason == failure_reason::INDEPENDENT_DEMOTED_INTO_MAIN
        }));
    }

    #[test]
    fn correct_trigger_symptom_and_independent_roles_still_pass() {
        let mut truth = base_truth();
        truth.independent_incident_tokens = vec!["telemetry".into()];
        let mut pkt = packet(&["e-trigger", "e-symptom", "e-indep"]);
        // Packet helper text already carries lease/boundary; enrich for roles.
        pkt.documents[1].text = "record e-symptom aborted requests after pool pressure".into();
        pkt.documents[2].text = "record e-indep telemetry sink timeout after recovery".into();
        let ans = CandidateAnswer {
            candidate_id: "good-roles".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![
                AnswerClaim {
                    text: "boundary violation of lease window".into(),
                    evidence_ids: vec!["e-trigger".into()],
                    role: Some("trigger".into()),
                },
                AnswerClaim {
                    text: "aborted requests after pool pressure".into(),
                    evidence_ids: vec!["e-symptom".into()],
                    role: Some("symptom".into()),
                },
                AnswerClaim {
                    text: "telemetry sink timeout is a separate ongoing fault".into(),
                    evidence_ids: vec!["e-indep".into()],
                    role: Some("independent".into()),
                },
            ],
            conclusion: "Lease boundary caused aborts. Telemetry is independent.".into(),
            confidence: "medium".into(),
            diagnostic: None,
        };

        let score = score_answer(&ans, &truth, &pkt);

        assert!(score.passed, "failed: {:?}", score.failed_ids());
    }

    #[test]
    fn multiple_genuine_triggers_are_not_rejected() {
        let mut truth = base_truth();
        truth.trigger_tokens = vec!["boundary".into(), "lease".into()];
        truth.required_fact_tokens = vec!["lease".into(), "boundary".into()];
        let mut pkt = packet(&["e-trigger", "e-symptom"]);
        pkt.documents[1].text = "record e-symptom aborted requests followed the trigger".into();
        let ans = CandidateAnswer {
            candidate_id: "multi-trigger".into(),
            task_id: "t1".into(),
            packet_id: "fixed".into(),
            asserts_root_cause_established: true,
            claims: vec![
                AnswerClaim {
                    text: "boundary violation on the control path".into(),
                    evidence_ids: vec!["e-trigger".into()],
                    role: Some("trigger".into()),
                },
                AnswerClaim {
                    text: "lease window misconfiguration is also an initiating cause".into(),
                    evidence_ids: vec!["e-trigger".into()],
                    role: Some("trigger".into()),
                },
                AnswerClaim {
                    text: "aborted requests followed the trigger".into(),
                    evidence_ids: vec!["e-symptom".into()],
                    role: Some("symptom".into()),
                },
            ],
            conclusion: "Both lease and boundary triggers jointly explain the failure".into(),
            confidence: "medium".into(),
            diagnostic: None,
        };

        let score = score_answer(&ans, &truth, &pkt);

        assert!(score.passed, "failed: {:?}", score.failed_ids());
        assert!(!score.failed_ids().contains(&"cause_versus_symptom"));
    }
}
