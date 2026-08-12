//! Deterministic diagnostic-honesty scoring for scripted gateway/tool/role
//! envelopes attached to quality-eval candidates.
//!
//! Reuses production category vocabulary
//! ([`crate::linked_triage_contract::LinkedTriageDiagnosticCategory`]) and the
//! suite privacy scanner. Does not open sockets, resolve credentials, or run a
//! second agent pipeline.

use super::suite::scan_privacy_text;
use super::types::{
    failure_reason, AnswerDimension, DiagnosticTruth, ScriptedDiagnostic, ScriptedToolStep,
};
use crate::linked_triage_contract::LinkedTriageDiagnosticCategory;

/// Append diagnostic-honesty dimensions when host truth requests them.
pub fn score_diagnostic_dimensions(
    diagnostic: Option<&ScriptedDiagnostic>,
    truth: Option<&DiagnosticTruth>,
    dimensions: &mut Vec<AnswerDimension>,
) {
    let Some(truth) = truth else {
        return;
    };
    let Some(diag) = diagnostic else {
        dimensions.push(dim(
            "diagnostic_envelope_present",
            false,
            failure_reason::INVALID_ANSWER_SCHEMA,
        ));
        return;
    };
    dimensions.push(dim(
        "diagnostic_envelope_present",
        true,
        "scripted diagnostic envelope present",
    ));

    // 1) Category allow-list (production labels + host grounding labels).
    let category_ok = if truth.allowed_categories.is_empty() {
        true
    } else {
        truth
            .allowed_categories
            .iter()
            .any(|allowed| allowed == &diag.reported_category)
            && known_category_label(&diag.reported_category)
    };
    dimensions.push(dim(
        "diagnostic_category",
        category_ok,
        if category_ok {
            "reported category is host-allowed"
        } else {
            failure_reason::INVALID_DIAGNOSTIC_CATEGORY
        },
    ));

    // 2) Attempt usefulness honesty (mixed pass/fail, all-attempts semantics).
    let usefulness_ok = if !truth.require_honest_usefulness {
        true
    } else {
        honest_usefulness(diag, &truth.expected_usefulness_policy)
    };
    dimensions.push(dim(
        "attempt_usefulness",
        usefulness_ok,
        if usefulness_ok {
            "usefulness claims match attempt rows"
        } else {
            failure_reason::DISHONEST_ATTEMPT_USEFULNESS
        },
    ));

    // 3) Transport/auth/timeout must not be reported as host grounding.
    let transport_ok = if !truth.separate_transport_from_grounding {
        true
    } else {
        !transport_mislabeled_as_grounding(diag)
    };
    dimensions.push(dim(
        "transport_versus_grounding",
        transport_ok,
        if transport_ok {
            "transport/auth/timeout not reported as host grounding"
        } else {
            failure_reason::TRANSPORT_MISLABELED_AS_GROUNDING
        },
    ));

    // 4) Tool progress requires citeable evidence; non-progress requires withdrawal.
    let zero_cite_ok = if !truth.require_citeable_on_tool_progress {
        true
    } else {
        !tool_progress_without_cites(&diag.tool_steps)
    };
    dimensions.push(dim(
        "tool_citeable_evidence",
        zero_cite_ok,
        if zero_cite_ok {
            "tool progress has citeable hits"
        } else {
            failure_reason::TOOL_ZERO_CITEABLE_EVIDENCE
        },
    ));

    let withdraw_ok = if !truth.require_tool_withdrawal_after_non_progress {
        true
    } else {
        non_progress_ends_with_withdrawal(&diag.tool_steps)
    };
    dimensions.push(dim(
        "tool_non_progress_withdrawal",
        withdraw_ok,
        if withdraw_ok {
            "non-progress tool loops withdraw"
        } else {
            failure_reason::TOOL_NON_PROGRESS_WITHOUT_WITHDRAWAL
        },
    ));

    // 5) Multi-model role coverage / honest budget exhaustion.
    let roles_ok = required_roles_honest(
        &diag.roles,
        &truth.required_roles,
        diag.host_budget_exhausted,
    );
    dimensions.push(dim(
        "multi_model_role_coverage",
        roles_ok,
        if roles_ok {
            "required roles completed or honestly budget-exhausted"
        } else {
            failure_reason::ROLE_DROPOUT_WITHOUT_BUDGET
        },
    ));

    let budget_ok = if !truth.budget_exhaustion_forbids_useful {
        true
    } else {
        !(diag.host_budget_exhausted && diag.claims_useful)
    };
    dimensions.push(dim(
        "host_budget_honesty",
        budget_ok,
        if budget_ok {
            "budget exhaustion not claimed useful"
        } else {
            failure_reason::BUDGET_EXHAUSTION_CLAIMED_USEFUL
        },
    ));

    // 6) Share-safe export sample (no secret/path/raw-body shapes).
    let privacy_ok = if !truth.require_share_safe_export {
        true
    } else {
        scan_privacy_text(&diag.export_text).is_empty()
            && !diag.export_text.contains("\"/Users/")
            && !diag.export_text.to_ascii_lowercase().contains("raw_body")
            && !diag
                .export_text
                .to_ascii_lowercase()
                .contains("authorization:")
    };
    dimensions.push(dim(
        "share_safe_export",
        privacy_ok,
        if privacy_ok {
            "diagnostic export sample is share-safe"
        } else {
            failure_reason::EXPORT_PRIVACY_VIOLATION
        },
    ));
}

fn dim(id: &str, passed: bool, reason: &str) -> AnswerDimension {
    AnswerDimension {
        id: id.into(),
        passed,
        reason: reason.into(),
    }
}

fn known_category_label(label: &str) -> bool {
    matches!(
        label,
        "candidate_contract_failure"
            | "final_comparison_failure"
            | "empty_terminal_answer"
            | "transport_failure"
            | "timeout"
            | "successful_bounded_correction"
            | "compatible_success"
            | "host_grounding_refusal"
            | "auth_failure"
            | "mixed_attempts_accounted"
            | "all_attempts_failed"
            | "tool_withdrawn_non_progress"
            | "budget_exhausted"
            | "role_partial_completion"
    ) || LinkedTriageDiagnosticCategory::CompatibleSuccess
        .as_str()
        .eq(label)
        || [
            LinkedTriageDiagnosticCategory::TransportFailure.as_str(),
            LinkedTriageDiagnosticCategory::Timeout.as_str(),
            LinkedTriageDiagnosticCategory::EmptyTerminalAnswer.as_str(),
            LinkedTriageDiagnosticCategory::CandidateContractFailure.as_str(),
            LinkedTriageDiagnosticCategory::FinalComparisonFailure.as_str(),
            LinkedTriageDiagnosticCategory::SuccessfulBoundedCorrection.as_str(),
        ]
        .contains(&label)
}

fn honest_usefulness(diag: &ScriptedDiagnostic, expected_policy: &str) -> bool {
    let any_success = diag.attempts.iter().any(|a| a.succeeded);
    let all_success = !diag.attempts.is_empty() && diag.attempts.iter().all(|a| a.succeeded);
    let any_fail = diag.attempts.iter().any(|a| !a.succeeded);
    let policy = if expected_policy.is_empty() {
        diag.usefulness_policy.as_str()
    } else if diag.usefulness_policy != expected_policy {
        return false;
    } else {
        diag.usefulness_policy.as_str()
    };

    match policy {
        "all_succeeded" => all_success && diag.claims_useful,
        "all_failed" => !any_success && !diag.claims_useful,
        "any_success" => {
            // Partial usefulness is allowed only when at least one attempt
            // succeeded and the report does not pretend every attempt worked.
            any_success && diag.claims_useful && !(any_fail && policy_implies_universal(diag))
        }
        "mixed_accounted" => any_success && any_fail && !policy_implies_universal(diag),
        "none" | "" => !diag.claims_useful || any_success,
        _ => false,
    }
}

fn policy_implies_universal(diag: &ScriptedDiagnostic) -> bool {
    diag.usefulness_policy == "all_succeeded"
        || diag
            .export_text
            .to_ascii_lowercase()
            .contains("all attempts succeeded")
}

fn transport_mislabeled_as_grounding(diag: &ScriptedDiagnostic) -> bool {
    let has_transport_class = diag.attempts.iter().any(|a| {
        matches!(a.failure_class.as_str(), "transport" | "auth" | "timeout") && !a.succeeded
    });
    let reported_as_grounding = diag.reported_category == "host_grounding_refusal"
        || diag.reported_category.contains("grounding");
    has_transport_class && reported_as_grounding
}

fn tool_progress_without_cites(steps: &[ScriptedToolStep]) -> bool {
    steps
        .iter()
        .any(|s| s.progress && !s.withdrawn && s.citeable_hits == 0)
}

fn non_progress_ends_with_withdrawal(steps: &[ScriptedToolStep]) -> bool {
    if steps.is_empty() {
        return true;
    }
    let mut streak = 0u32;
    let mut saw_non_progress = false;
    for step in steps {
        if !step.progress {
            saw_non_progress = true;
            streak = streak.saturating_add(1);
            if streak >= 2 && step.withdrawn {
                return true;
            }
        } else {
            streak = 0;
        }
    }
    // If there was a non-progress streak of 2+ without a withdrawn step, fail.
    if !saw_non_progress {
        return true;
    }
    let non_progress: Vec<_> = steps.iter().filter(|s| !s.progress).collect();
    if non_progress.len() < 2 {
        // Single non-progress without withdrawal is allowed (retry once).
        return true;
    }
    non_progress.iter().any(|s| s.withdrawn)
}

fn required_roles_honest(
    roles: &[super::types::ScriptedRoleOutcome],
    required: &[String],
    host_budget_exhausted: bool,
) -> bool {
    if required.is_empty() {
        return true;
    }
    for need in required {
        let Some(row) = roles.iter().find(|r| &r.role == need) else {
            return host_budget_exhausted;
        };
        match row.status.as_str() {
            "completed" => {}
            "budget_exhausted" => {}
            "dropped" | "transport_failed" => {
                if !host_budget_exhausted && row.status != "budget_exhausted" {
                    // Dropped without budget accounting fails.
                    if row.status == "dropped" {
                        return false;
                    }
                }
            }
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::super::types::{ScriptedAttempt, ScriptedRoleOutcome};
    use super::*;

    fn base_truth() -> DiagnosticTruth {
        DiagnosticTruth {
            allowed_categories: vec!["mixed_attempts_accounted".into()],
            expected_usefulness_policy: "mixed_accounted".into(),
            require_honest_usefulness: true,
            separate_transport_from_grounding: true,
            require_citeable_on_tool_progress: true,
            require_tool_withdrawal_after_non_progress: true,
            required_roles: vec!["investigator".into(), "synthesizer".into()],
            budget_exhaustion_forbids_useful: true,
            require_share_safe_export: true,
        }
    }

    #[test]
    fn mixed_attempts_honest_policy_passes() {
        let diag = ScriptedDiagnostic {
            attempts: vec![
                ScriptedAttempt {
                    attempt_id: "a1".into(),
                    failure_class: "success".into(),
                    succeeded: true,
                    citeable_evidence: true,
                },
                ScriptedAttempt {
                    attempt_id: "a2".into(),
                    failure_class: "transport".into(),
                    succeeded: false,
                    citeable_evidence: false,
                },
            ],
            tool_steps: vec![
                ScriptedToolStep {
                    step_id: "t1".into(),
                    kind: "search".into(),
                    citeable_hits: 0,
                    progress: false,
                    withdrawn: false,
                },
                ScriptedToolStep {
                    step_id: "t2".into(),
                    kind: "search".into(),
                    citeable_hits: 0,
                    progress: false,
                    withdrawn: true,
                },
            ],
            roles: vec![
                ScriptedRoleOutcome {
                    role: "investigator".into(),
                    status: "completed".into(),
                },
                ScriptedRoleOutcome {
                    role: "synthesizer".into(),
                    status: "completed".into(),
                },
            ],
            host_budget_exhausted: false,
            reported_category: "mixed_attempts_accounted".into(),
            claims_useful: true,
            usefulness_policy: "mixed_accounted".into(),
            export_text: "attempts=2 succeeded=1 failed=1 category=mixed_attempts_accounted".into(),
        };
        let mut dims = Vec::new();
        score_diagnostic_dimensions(Some(&diag), Some(&base_truth()), &mut dims);
        assert!(
            dims.iter().all(|d| d.passed),
            "failed: {:?}",
            dims.iter().filter(|d| !d.passed).collect::<Vec<_>>()
        );
    }

    #[test]
    fn transport_reported_as_grounding_fails() {
        let mut diag = ScriptedDiagnostic {
            attempts: vec![ScriptedAttempt {
                attempt_id: "a1".into(),
                failure_class: "timeout".into(),
                succeeded: false,
                citeable_evidence: false,
            }],
            reported_category: "host_grounding_refusal".into(),
            claims_useful: false,
            usefulness_policy: "all_failed".into(),
            export_text: "category=host_grounding_refusal".into(),
            ..Default::default()
        };
        let mut truth = base_truth();
        truth.allowed_categories = vec!["host_grounding_refusal".into()];
        truth.expected_usefulness_policy = "all_failed".into();
        truth.required_roles.clear();
        truth.require_tool_withdrawal_after_non_progress = false;
        truth.require_citeable_on_tool_progress = false;
        let mut dims = Vec::new();
        score_diagnostic_dimensions(Some(&diag), Some(&truth), &mut dims);
        assert!(dims.iter().any(|d| {
            d.id == "transport_versus_grounding"
                && !d.passed
                && d.reason == failure_reason::TRANSPORT_MISLABELED_AS_GROUNDING
        }));
        // Positive control: label correctly.
        diag.reported_category = "timeout".into();
        truth.allowed_categories = vec!["timeout".into()];
        let mut dims2 = Vec::new();
        score_diagnostic_dimensions(Some(&diag), Some(&truth), &mut dims2);
        assert!(dims2
            .iter()
            .find(|d| d.id == "transport_versus_grounding")
            .is_some_and(|d| d.passed));
    }

    #[test]
    fn zero_cite_progress_and_role_dropout_fail() {
        let diag = ScriptedDiagnostic {
            attempts: vec![ScriptedAttempt {
                attempt_id: "a1".into(),
                failure_class: "success".into(),
                succeeded: true,
                citeable_evidence: true,
            }],
            tool_steps: vec![ScriptedToolStep {
                step_id: "t1".into(),
                kind: "search".into(),
                citeable_hits: 0,
                progress: true,
                withdrawn: false,
            }],
            roles: vec![
                ScriptedRoleOutcome {
                    role: "investigator".into(),
                    status: "completed".into(),
                },
                ScriptedRoleOutcome {
                    role: "synthesizer".into(),
                    status: "dropped".into(),
                },
            ],
            host_budget_exhausted: false,
            reported_category: "compatible_success".into(),
            claims_useful: true,
            usefulness_policy: "all_succeeded".into(),
            export_text: "ok".into(),
        };
        let mut truth = base_truth();
        truth.allowed_categories = vec!["compatible_success".into()];
        truth.expected_usefulness_policy = "all_succeeded".into();
        truth.require_tool_withdrawal_after_non_progress = false;
        let mut dims = Vec::new();
        score_diagnostic_dimensions(Some(&diag), Some(&truth), &mut dims);
        assert!(dims.iter().any(|d| {
            d.id == "tool_citeable_evidence"
                && d.reason == failure_reason::TOOL_ZERO_CITEABLE_EVIDENCE
        }));
        assert!(dims.iter().any(|d| {
            d.id == "multi_model_role_coverage"
                && d.reason == failure_reason::ROLE_DROPOUT_WITHOUT_BUDGET
        }));
    }
}
