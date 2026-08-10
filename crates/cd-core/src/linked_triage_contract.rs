//! Provider-neutral linked multi-stage triage **response contracts**.
//!
//! These helpers are the production normalization/classification surface used
//! by the multi-stage agent path for OpenAI-compatible gateways that emit
//! reasoning wrappers, Markdown fences, or empty visible bodies. They are
//! deliberately free of provider/model identifiers (including DeepSeek): any
//! OpenAI-compatible reasoning gateway may exercise them.
//!
//! Authority still lives in [`crate::investigation_answer::validate_model_answer`]
//! and the host ledger — this module only unwraps known, complete wrappers
//! and classifies terminal outcomes for diagnostics.

use crate::investigation_answer::ValidationError;

/// Stable, content-free diagnostic category for one linked multi-stage
/// terminal. Suitable for human/JSONL/gateway-diagnose projections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkedTriageDiagnosticCategory {
    /// Candidate-stage JSON/schema/scope contract failed (or failed after
    /// bounded correction). Draft never reaches the comparison ledger.
    CandidateContractFailure,
    /// Final-comparison proposal failed host validation after optional
    /// bounded semantic correction.
    FinalComparisonFailure,
    /// Provider returned empty visible text (optionally with discarded
    /// reasoning telemetry). Never treated as a successful answer.
    EmptyTerminalAnswer,
    /// Provider/transport error on a candidate or comparison round.
    TransportFailure,
    /// Whole-turn or protected-phase deadline stopped the multi-stage path.
    Timeout,
    /// Final comparison accepted after at least one semantic correction.
    SuccessfulBoundedCorrection,
    /// Final comparison accepted on the first attempt (no correction).
    CompatibleSuccess,
}

impl LinkedTriageDiagnosticCategory {
    /// Stable snake_case label for reports and JSONL.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CandidateContractFailure => "candidate_contract_failure",
            Self::FinalComparisonFailure => "final_comparison_failure",
            Self::EmptyTerminalAnswer => "empty_terminal_answer",
            Self::TransportFailure => "transport_failure",
            Self::Timeout => "timeout",
            Self::SuccessfulBoundedCorrection => "successful_bounded_correction",
            Self::CompatibleSuccess => "compatible_success",
        }
    }
}

/// Classify a multi-stage **final comparison** attempt from host-owned facts
/// only (no proposal bodies, no secrets).
pub fn classify_final_comparison_outcome(
    empty_visible: bool,
    validation: Result<(), ValidationError>,
    semantic_attempts: usize,
    transport_failed: bool,
    timed_out: bool,
) -> LinkedTriageDiagnosticCategory {
    if timed_out {
        return LinkedTriageDiagnosticCategory::Timeout;
    }
    if transport_failed {
        return LinkedTriageDiagnosticCategory::TransportFailure;
    }
    if empty_visible {
        return LinkedTriageDiagnosticCategory::EmptyTerminalAnswer;
    }
    match validation {
        Ok(()) if semantic_attempts > 0 => {
            LinkedTriageDiagnosticCategory::SuccessfulBoundedCorrection
        }
        Ok(()) => LinkedTriageDiagnosticCategory::CompatibleSuccess,
        Err(_) => LinkedTriageDiagnosticCategory::FinalComparisonFailure,
    }
}

/// Classify a multi-stage **candidate** stage attempt from host-owned facts.
pub fn classify_candidate_stage_outcome(
    empty_visible: bool,
    contract_accepted: bool,
    transport_failed: bool,
    timed_out: bool,
) -> LinkedTriageDiagnosticCategory {
    if timed_out {
        return LinkedTriageDiagnosticCategory::Timeout;
    }
    if transport_failed {
        return LinkedTriageDiagnosticCategory::TransportFailure;
    }
    if empty_visible {
        return LinkedTriageDiagnosticCategory::EmptyTerminalAnswer;
    }
    if contract_accepted {
        LinkedTriageDiagnosticCategory::CompatibleSuccess
    } else {
        LinkedTriageDiagnosticCategory::CandidateContractFailure
    }
}

/// True when the raw terminal has no non-whitespace **visible** content after
/// discarding complete known reasoning blocks. Reasoning-only payloads are
/// empty terminals — never successful answers.
pub fn is_empty_visible_terminal(raw: &str) -> bool {
    let without_reasoning = strip_complete_reasoning_blocks(raw.trim());
    without_reasoning.trim().is_empty()
}

/// Strip complete known reasoning blocks (`<think>`, `<analysis>`,
/// `<reasoning>`) from the start of the payload. Incomplete or mid-body tags
/// are left untouched so untrusted content cannot smuggle structure.
#[allow(clippy::string_slice)] // offsets from ASCII delimiter matches only
fn strip_complete_reasoning_blocks(raw: &str) -> String {
    let mut trimmed = raw.trim();
    for _ in 0..4 {
        let mut unwrapped = false;
        for tag in ["think", "analysis", "reasoning"] {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            if let Some(body) = trimmed.strip_prefix(open.as_str()) {
                if let Some(end) = body.find(close.as_str()) {
                    trimmed = body[end + close.len()..].trim();
                    unwrapped = true;
                    break;
                }
            }
        }
        if !unwrapped {
            break;
        }
    }
    trimmed.to_string()
}

/// Normalize only the small set of provider response wrappers that are known
/// to carry a single JSON object without changing its authority. Some
/// reasoning gateways leave a `<think>`/`<analysis>` block in visible content,
/// and some OpenAI-compatible servers wrap JSON in a fenced block even when
/// the prompt forbids it. The wrapper itself is discarded; the object still
/// goes through host-owned schema, evidence, and role validators.
///
/// Deliberately does not search arbitrary prose for a brace pair. A prefix or
/// suffix is accepted only when it is a complete known reasoning block or a
/// complete Markdown JSON fence, so untrusted output cannot smuggle a second
/// object or silently turn prose into an answer.
///
/// Production multi-stage candidate and final-comparison paths share this
/// function — there is no second, diagnostic-only normalizer.
#[allow(clippy::string_slice)] // all offsets come from ASCII delimiter matches
pub fn normalize_known_json_wrapper(raw: &str) -> Option<String> {
    let mut trimmed = raw.trim();
    // A bounded number of nested wrappers is enough for real gateways and
    // prevents a hostile response from turning normalization into recursion.
    for _ in 0..4 {
        let mut unwrapped_reasoning = false;
        for tag in ["think", "analysis", "reasoning"] {
            let open = format!("<{tag}>");
            let close = format!("</{tag}>");
            if let Some(body) = trimmed.strip_prefix(open.as_str()) {
                let end = body.find(close.as_str())?;
                trimmed = body[end + close.len()..].trim();
                unwrapped_reasoning = true;
                break;
            }
        }
        if !unwrapped_reasoning {
            break;
        }
    }
    if let Some(fence_body) = trimmed.strip_prefix("```") {
        let newline = fence_body.find('\n')?;
        let body = &fence_body[newline + 1..];
        let close = body.rfind("```")?;
        if !body[close + 3..].trim().is_empty() {
            return None;
        }
        let object = body[..close].trim();
        if object.starts_with('{') && object.ends_with('}') {
            return Some(object.to_string());
        }
        return None;
    }
    (trimmed.starts_with('{') && trimmed.ends_with('}')).then(|| trimmed.to_string())
}

/// Prepare terminal model content for host validation: unwrap known wrappers,
/// then reject empty visible terminals. Does not invent JSON.
pub fn preparation_for_host_validation(
    raw: &str,
) -> Result<String, LinkedTriageDiagnosticCategory> {
    if is_empty_visible_terminal(raw) {
        return Err(LinkedTriageDiagnosticCategory::EmptyTerminalAnswer);
    }
    if let Some(object) = normalize_known_json_wrapper(raw) {
        if object.trim().is_empty() {
            return Err(LinkedTriageDiagnosticCategory::EmptyTerminalAnswer);
        }
        return Ok(object);
    }
    // Bare non-JSON content fails at parse time; surface as comparison/contract
    // failure once the caller chooses the stage.
    Ok(raw.trim().to_string())
}

/// True when `visible` (e.g. host-rendered answer markdown or authoritative
/// JSON) contains residual reasoning-wrapper markers that must never leak.
pub fn visible_text_leaks_reasoning_markers(visible: &str) -> bool {
    let lower = visible.to_ascii_lowercase();
    lower.contains("<think>")
        || lower.contains("</think>")
        || lower.contains("<analysis>")
        || lower.contains("</analysis>")
        || lower.contains("<reasoning>")
        || lower.contains("</reasoning>")
}

/// Map a final-comparison [`ValidationError`] to the comparison-failure
/// diagnostic (never collapses into candidate_contract).
pub fn category_for_final_validation_error(
    _error: &ValidationError,
) -> LinkedTriageDiagnosticCategory {
    LinkedTriageDiagnosticCategory::FinalComparisonFailure
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_and_fence_wrappers_unwrap_to_json_only() {
        assert_eq!(
            normalize_known_json_wrapper(
                "<think>private reasoning must not leak</think>\n```json\n{\"ok\":true}\n```"
            ),
            Some("{\"ok\":true}".into())
        );
        assert_eq!(
            normalize_known_json_wrapper("<analysis>still private</analysis>\n{\"schema\":\"x\"}"),
            Some("{\"schema\":\"x\"}".into())
        );
        assert_eq!(
            normalize_known_json_wrapper("prefix prose {\"ok\":true}"),
            None
        );
        assert_eq!(
            normalize_known_json_wrapper("```json\n{\"ok\":true}\n``` trailing"),
            None
        );
    }

    #[test]
    fn reasoning_only_is_empty_terminal_not_success() {
        assert!(is_empty_visible_terminal(
            "<think>I will emit JSON next turn</think>"
        ));
        assert!(is_empty_visible_terminal(
            "<analysis>no object</analysis>\n   "
        ));
        assert!(!is_empty_visible_terminal(
            "<think>x</think>\n{\"schema\":\"contextdesk.investigation_answer.v1\",\"candidates\":[]}"
        ));
        assert_eq!(
            preparation_for_host_validation("<think>only thoughts</think>"),
            Err(LinkedTriageDiagnosticCategory::EmptyTerminalAnswer)
        );
    }

    #[test]
    fn diagnostic_categories_are_distinct() {
        assert_ne!(
            LinkedTriageDiagnosticCategory::CandidateContractFailure.as_str(),
            LinkedTriageDiagnosticCategory::FinalComparisonFailure.as_str()
        );
        assert_eq!(
            classify_final_comparison_outcome(true, Ok(()), 0, false, false),
            LinkedTriageDiagnosticCategory::EmptyTerminalAnswer
        );
        assert_eq!(
            classify_final_comparison_outcome(false, Ok(()), 1, false, false),
            LinkedTriageDiagnosticCategory::SuccessfulBoundedCorrection
        );
        assert_eq!(
            classify_final_comparison_outcome(false, Ok(()), 0, false, false),
            LinkedTriageDiagnosticCategory::CompatibleSuccess
        );
        assert_eq!(
            classify_final_comparison_outcome(false, Err(ValidationError::Parse), 0, false, false),
            LinkedTriageDiagnosticCategory::FinalComparisonFailure
        );
        assert_eq!(
            classify_final_comparison_outcome(false, Ok(()), 0, true, false),
            LinkedTriageDiagnosticCategory::TransportFailure
        );
        assert_eq!(
            classify_final_comparison_outcome(false, Ok(()), 0, false, true),
            LinkedTriageDiagnosticCategory::Timeout
        );
        assert_eq!(
            classify_candidate_stage_outcome(false, false, false, false),
            LinkedTriageDiagnosticCategory::CandidateContractFailure
        );
    }

    #[test]
    fn reasoning_markers_must_not_appear_in_visible_projections() {
        assert!(visible_text_leaks_reasoning_markers(
            "answer <think>leaked</think>"
        ));
        assert!(!visible_text_leaks_reasoning_markers(
            "## initiating_causes\n- host projection only"
        ));
    }
}
