//! Score path A and path B through the real host fast-triage validator.
//!
//! Credit is never awarded for persuasive prose alone. Latency/token labels
//! on callers are metadata only and do not affect the verdict.

use crate::fast_triage::{validate_fast_answer, FastTriageFailureCategory, FastTriageValidation};
use crate::investigation_answer::AnswerEnvelopeV1;

use super::assemble::{assemble_role_decomposition, RoleDecompositionInputs};
use super::candidates::{CandidateKind, PathACandidate, PathBRoles};
use super::cases::BenchmarkCase;

/// Host verdict for one scored candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContributionVerdict {
    /// Host accepted the typed answer.
    Accepted,
    /// Host rejected; fail-closed categories available.
    Rejected,
}

/// What a cheap model usefully contributed under host authority.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RoleCredit {
    /// Extraction/classification produced usable grounded observations.
    pub extraction_useful: bool,
    /// Causal proposal survived host validation as cause/symptom placement.
    pub causal_proposal_useful: bool,
    /// Contradiction/abstention check prevented an unsafe accept.
    pub contradiction_check_useful: bool,
    /// Reviewer synthesis was used and validated (rare in hermetic fixtures).
    pub reviewer_useful: bool,
    /// Explicit: prose never earns credit by itself.
    pub prose_alone_never_credits: bool,
}

/// Aggregate credit + host facts for one path score.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContributionCredit {
    pub roles: RoleCredit,
    /// Host established root cause on the accepted envelope.
    pub root_cause_established: bool,
    /// Whether partial extraction is the best honest credit (rejected full answer
    /// but extraction rows were well-formed / host-groundable).
    pub partial_extraction_credit: bool,
}

/// One scored path result.
#[derive(Debug, Clone)]
pub struct PathScore {
    pub kind: CandidateKind,
    pub verdict: ContributionVerdict,
    pub failure_categories: Vec<FastTriageFailureCategory>,
    pub credit: ContributionCredit,
    /// Present only when accepted.
    pub envelope: Option<AnswerEnvelopeV1>,
    /// Assembled or original proposal body (share-safe fixture text).
    pub proposal_body: String,
}

fn score_body(case: &BenchmarkCase, kind: CandidateKind, body: &str) -> PathScore {
    match validate_fast_answer(body, &case.packet) {
        FastTriageValidation::Accepted(envelope) => {
            let root = envelope.answer.root_cause_established;
            PathScore {
                kind,
                verdict: ContributionVerdict::Accepted,
                failure_categories: vec![],
                credit: ContributionCredit {
                    roles: RoleCredit {
                        extraction_useful: true,
                        causal_proposal_useful: root || case.root_cause_establishable,
                        contradiction_check_useful: false,
                        reviewer_useful: false,
                        prose_alone_never_credits: true,
                    },
                    root_cause_established: root,
                    partial_extraction_credit: false,
                },
                envelope: Some(*envelope),
                proposal_body: body.to_string(),
            }
        }
        FastTriageValidation::Rejected(categories) => {
            // Hard identity/structure failures never earn any contribution credit.
            let hard_fail = categories.iter().any(|c| {
                matches!(
                    c,
                    FastTriageFailureCategory::ForeignEvidenceId
                        | FastTriageFailureCategory::MalformedTerminal
                        | FastTriageFailureCategory::SchemaMismatch
                        | FastTriageFailureCategory::EmptyVisibleAnswer
                )
            });
            // Partial extraction credit is reserved for host-declared partial
            // shapes (extraction-only / omitted role coverage). An unsupported
            // causal claim, role confusion, fabricated id, or other mutation
            // must not earn partial credit merely because RoleCoverage co-occurs.
            let partial_kind = matches!(
                kind,
                CandidateKind::UsefulPartialExtraction | CandidateKind::OmittedEvidence
            );
            let partial = partial_kind && !hard_fail;
            PathScore {
                kind,
                verdict: ContributionVerdict::Rejected,
                failure_categories: categories,
                credit: ContributionCredit {
                    roles: RoleCredit {
                        extraction_useful: partial,
                        causal_proposal_useful: false,
                        contradiction_check_useful: matches!(
                            kind,
                            CandidateKind::UsefulPartialExtraction
                        ),
                        reviewer_useful: false,
                        prose_alone_never_credits: true,
                    },
                    root_cause_established: false,
                    partial_extraction_credit: partial,
                },
                envelope: None,
                proposal_body: body.to_string(),
            }
        }
    }
}

/// Score path A: one full answer through the host validator.
pub fn score_path_a(case: &BenchmarkCase, candidate: &PathACandidate) -> PathScore {
    score_body(case, candidate.kind, &candidate.proposal_body)
}

/// Score path B: host assembly then the same validator.
pub fn score_path_b(case: &BenchmarkCase, roles: &PathBRoles) -> PathScore {
    let body = assemble_role_decomposition(RoleDecompositionInputs { case, roles });
    let mut score = score_body(case, roles.kind, &body);
    // Annotate path-B role credit more precisely.
    if score.verdict == ContributionVerdict::Accepted {
        score.credit.roles.extraction_useful = !roles.extraction.observations.is_empty();
        score.credit.roles.causal_proposal_useful = !roles.causal.claims.is_empty();
        score.credit.roles.contradiction_check_useful = roles.contradiction.force_abstention
            || !roles.contradiction.reject_claim_ids.is_empty();
        score.credit.roles.reviewer_useful = roles.reviewer.optional_full_proposal.is_some();
    } else if roles.kind == CandidateKind::UsefulPartialExtraction {
        score.credit.roles.extraction_useful = true;
        score.credit.partial_extraction_credit = true;
        score.credit.roles.contradiction_check_useful = roles.contradiction.force_abstention;
    }
    score.proposal_body = body;
    score
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cheap_model_fast_triage_benchmark::candidates::{
        path_a_candidate, path_b_roles, CandidateKind,
    };
    use crate::cheap_model_fast_triage_benchmark::cases::{benchmark_case, CaseId};

    #[test]
    fn strong_path_a_accepts() {
        let case = benchmark_case(CaseId::CompleteTimeline);
        let cand = path_a_candidate(&case, CandidateKind::StrongStructured);
        let score = score_path_a(&case, &cand);
        assert_eq!(score.verdict, ContributionVerdict::Accepted);
        assert!(score.credit.root_cause_established);
        assert!(score.credit.roles.prose_alone_never_credits);
    }

    #[test]
    fn fabricated_path_a_fails_closed() {
        let case = benchmark_case(CaseId::CompleteTimeline);
        let cand = path_a_candidate(&case, CandidateKind::FabricatedCitation);
        let score = score_path_a(&case, &cand);
        assert_eq!(score.verdict, ContributionVerdict::Rejected);
        assert!(score
            .failure_categories
            .contains(&FastTriageFailureCategory::ForeignEvidenceId));
        assert!(!score.credit.partial_extraction_credit);
    }

    #[test]
    fn overconfident_prose_never_accepts() {
        let case = benchmark_case(CaseId::CompleteTimeline);
        let cand = path_a_candidate(&case, CandidateKind::OverconfidentCheapAnswer);
        let score = score_path_a(&case, &cand);
        assert_eq!(score.verdict, ContributionVerdict::Rejected);
        assert!(!score.credit.root_cause_established);
    }

    #[test]
    fn path_b_strong_matches_host_accept() {
        let case = benchmark_case(CaseId::CompleteTimeline);
        let roles = path_b_roles(&case, CandidateKind::StrongStructured);
        let score = score_path_b(&case, &roles);
        assert_eq!(score.verdict, ContributionVerdict::Accepted);
    }

    #[test]
    fn unsupported_causal_claim_never_earns_partial_extraction_credit() {
        let case = benchmark_case(CaseId::CompleteTimeline);
        for path_score in [
            score_path_a(
                &case,
                &path_a_candidate(&case, CandidateKind::UnsupportedCausalClaim),
            ),
            score_path_b(
                &case,
                &path_b_roles(&case, CandidateKind::UnsupportedCausalClaim),
            ),
        ] {
            assert_eq!(path_score.verdict, ContributionVerdict::Rejected);
            assert!(
                !path_score.credit.partial_extraction_credit,
                "unsupported cause must not look like useful partial extraction; cats={:?}",
                path_score.failure_categories
            );
            assert!(!path_score.credit.roles.extraction_useful);
        }
    }

    #[test]
    fn role_confusion_never_earns_partial_extraction_credit() {
        let case = benchmark_case(CaseId::CompleteTimeline);
        let score = score_path_a(
            &case,
            &path_a_candidate(&case, CandidateKind::RoleConfusion),
        );
        assert_eq!(score.verdict, ContributionVerdict::Rejected);
        assert!(!score.credit.partial_extraction_credit);
    }
}
