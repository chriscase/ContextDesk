//! Sequential reviewer-first pipeline (I/O-free, provider-agnostic).
//!
//! Given already-resolved role backends and a plan, this runs:
//!   stage 2 — one typed candidate finding per candidate (independent);
//!   stage 3 — one typed review of those findings (optional; degrades);
//!   stage 5 — the final answer, validated by the existing
//!             [`crate::investigation_answer::validate_model_answer`].
//!
//! It never constructs a provider, reads config, or names a provider kind. It
//! is driven by the workflow layer, which owns config, provider construction,
//! egress/qualification, and persistence. Every stage output is a host-typed
//! value; no stage receives another stage's prose as trusted input.

#![allow(missing_docs)] // Runtime/DTO field names are the schema contract.

use std::sync::atomic::AtomicBool;

use tokio::time::Instant;

use super::contracts::{
    render_review_markdown, validate_candidate_finding, validate_review_report, CandidateFindingV1,
    KnownClaims, ReviewReportV1, CANDIDATE_FINDING_SCHEMA_V1, REVIEW_SCHEMA_V1,
};
use super::{
    DegradationReason, ExecutedMode, InvestigationRole, MultiModelBudget, MultiModelMode,
    MultiModelTurnTelemetry, RoleBinding, StageOutcomeKind, StageTelemetry,
    MULTI_MODEL_TELEMETRY_SCHEMA_V1,
};
use crate::agent::{within_turn_deadline, ChatBackend, TurnAwaitError, TurnClock};
use crate::chat::{ChatMessage, Role};
use crate::context_budgeting::synthesis_packing_budget;
use crate::error::{CoreError, CoreResult};
use crate::investigation_answer::{
    render_answer_markdown, validate_model_answer, AnswerBindingV1, AnswerEnvelopeV1, EvidenceRole,
    HostEvidenceEntry, HostEvidenceLedger, SCHEMA_V1 as INVESTIGATION_ANSWER_SCHEMA_V1,
};
use crate::router::TurnDeadlinePlan;
use crate::tool_host::BroadLogTriageCandidate;

/// The role backends this pipeline needs. Investigator and synthesizer are the
/// same model by default (the host may pass the same reference); the reviewer
/// may be the same or a distinct provider.
pub struct MultiModelBackends<'a> {
    pub investigator: &'a dyn ChatBackend,
    pub reviewer: &'a dyn ChatBackend,
    pub synthesizer: &'a dyn ChatBackend,
}

/// Host-owned role identities (profile + model) for telemetry/provenance.
#[derive(Debug, Clone)]
pub struct MultiModelRoleIds {
    pub investigator_profile: String,
    pub investigator_model: String,
    pub reviewer_profile: String,
    pub reviewer_model: String,
    pub synthesizer_profile: String,
    pub synthesizer_model: String,
}

/// One stage-progress signal for hosts to surface. Host-authored: `detail`
/// never contains model text — only host counts and ids.
#[derive(Debug, Clone)]
pub struct StageProgressEvent {
    pub role: InvestigationRole,
    pub started: bool,
    pub outcome: Option<StageOutcomeKind>,
    pub candidate_id: Option<String>,
    pub detail: String,
}

/// The pipeline's typed result.
pub enum MultiModelOutcome {
    /// A host-validated answer was produced (with or without review).
    Completed {
        envelope: Box<AnswerEnvelopeV1>,
        /// Deterministic host Markdown projection of the answer (visible text).
        content: String,
        /// The validated review, present iff `executed_mode == Review`.
        review: Option<ReviewReportV1>,
        telemetry: Box<MultiModelTurnTelemetry>,
    },
    /// The typed candidate/synthesis path could not produce a valid answer.
    /// The caller should fall through to the existing single-model path.
    FailedClosed {
        reason: &'static str,
        telemetry: Box<MultiModelTurnTelemetry>,
    },
    /// Not eligible for a reviewed comparison (fewer than two candidates).
    /// The caller runs the existing path.
    NotEligible,
    /// The turn was cancelled.
    Cancelled,
    /// The turn hit its deadline before an answer (in a non-reviewer stage).
    Deadline,
    /// A required (investigator/synthesizer) provider call failed.
    ProviderFailed(Box<CoreError>),
}

/// Inputs for one review-pipeline run.
pub struct ReviewPipelineInputs<'a> {
    pub user_text: &'a str,
    pub candidates: &'a [BroadLogTriageCandidate],
    pub binding: AnswerBindingV1,
    pub budget: MultiModelBudget,
    pub role_ids: MultiModelRoleIds,
    /// Whole-turn wall-clock ceiling. `0` = none.
    pub deadline_ms: u64,
    pub started_at: Option<Instant>,
    /// Cooperative cancel flag shared with the driving turn. When set, every
    /// stage stops promptly.
    pub cancel: Option<std::sync::Arc<AtomicBool>>,
}

/// Build a flat deadline plan (no phase sub-budgets); every phase caps at the
/// whole-turn ceiling so the sequential pipeline is bounded only by `total_ms`.
fn flat_plan(total_ms: u64) -> TurnDeadlinePlan {
    TurnDeadlinePlan {
        total_ms,
        choosing_ms: total_ms,
        retrieving_ms: total_ms,
        synthesizing_ms: total_ms,
        explicit: total_ms > 0,
    }
}

/// One host evidence row for one candidate identity. Mirrors the existing
/// multi-stage ledger construction exactly (role `Neutral`, empty excerpt).
fn candidate_entries(
    candidate: &BroadLogTriageCandidate,
    binding: &AnswerBindingV1,
) -> Vec<HostEvidenceEntry> {
    let mut entries = Vec::new();
    for identity in &candidate.evidence {
        entries.push(HostEvidenceEntry {
            evidence_id: format!("e:{}:{}", candidate.group_id, identity.seq),
            candidate_id: candidate.group_id.clone(),
            source_label: identity
                .citation_source
                .clone()
                .unwrap_or_else(|| identity.source.clone()),
            locator: format!("seq={}", identity.seq),
            corpus_id: binding.corpus_id.clone(),
            revision: binding.revision,
            role: EvidenceRole::Neutral,
            content: String::new(),
        });
    }
    entries
}

/// A ledger over exactly one candidate's identities.
fn candidate_ledger(
    candidate: &BroadLogTriageCandidate,
    binding: &AnswerBindingV1,
) -> Result<HostEvidenceLedger, ()> {
    let entries = candidate_entries(candidate, binding);
    if entries.is_empty() {
        return Err(());
    }
    let binding = AnswerBindingV1 {
        ledger_digest: HostEvidenceLedger::digest(&entries),
        ..binding.clone()
    };
    HostEvidenceLedger::new(binding, entries).map_err(|_| ())
}

/// A ledger over exactly the accepted candidates' identities.
fn union_ledger(
    accepted: &[&BroadLogTriageCandidate],
    binding: &AnswerBindingV1,
) -> Result<HostEvidenceLedger, ()> {
    let mut entries = Vec::new();
    for candidate in accepted {
        entries.extend(candidate_entries(candidate, binding));
    }
    if entries.is_empty() {
        return Err(());
    }
    let binding = AnswerBindingV1 {
        ledger_digest: HostEvidenceLedger::digest(&entries),
        ..binding.clone()
    };
    HostEvidenceLedger::new(binding, entries).map_err(|_| ())
}

/// The visible evidence lines the host shows a role for one candidate: id +
/// host source label + host locator. No model text, no corpus payload.
fn candidate_evidence_lines(ledger: &HostEvidenceLedger) -> String {
    let mut lines = ledger.entries();
    lines.sort_by(|a, b| a.evidence_id.cmp(&b.evidence_id));
    lines
        .iter()
        .map(|e| format!("- {} ({} {})", e.evidence_id, e.source_label, e.locator))
        .collect::<Vec<_>>()
        .join("\n")
}

fn system(content: String) -> ChatMessage {
    ChatMessage {
        role: Role::System,
        content,
        tool_call_id: None,
        tool_calls: None,
    }
}

fn user(content: String) -> ChatMessage {
    ChatMessage {
        role: Role::User,
        content,
        tool_call_id: None,
        tool_calls: None,
    }
}

/// Investigator prompt for one candidate. Provider-neutral, vocabulary-free:
/// it describes the JSON schema and the id boundary, never a domain.
fn investigator_messages(
    user_text: &str,
    candidate_id: &str,
    evidence_lines: &str,
    correction: bool,
) -> Vec<ChatMessage> {
    let correction_note = if correction {
        " Your previous JSON was rejected by host validation. Return exactly one corrected JSON \
         object using only the supplied evidence ids."
    } else {
        ""
    };
    vec![
        system(format!(
            "You investigate ONE candidate group of evidence in isolation. Return exactly one \
             JSON object with schema \"{CANDIDATE_FINDING_SCHEMA_V1}\" and fields: candidate_id \
             (string, must equal the supplied id), and optional arrays observations, symptoms, \
             causal_candidates, missing_evidence. Each item is {{\"claim_id\":string, \
             \"text\":string, \"evidence_ids\":[string]}}. Cite ONLY the supplied evidence ids for \
             THIS candidate. Do not invent ids, do not cite another candidate, do not assert an \
             established root cause, and do not add any other field. missing_evidence items may \
             have an empty evidence_ids array.{correction_note}"
        )),
        user(format!(
            "Question: {user_text}\ncandidate_id: {candidate_id}\nSupplied evidence for this \
             candidate:\n{evidence_lines}\nReturn only the JSON object."
        )),
    ]
}

/// Reviewer prompt. Consumes only typed, host-validated findings (candidate id,
/// claim id, claim text) — never raw investigator prose.
fn reviewer_messages(
    findings_summary: &str,
    evidence_lines: &str,
    correction: bool,
) -> Vec<ChatMessage> {
    let correction_note = if correction {
        " Your previous JSON was rejected by host validation. Return exactly one corrected JSON \
         object using only the supplied ids."
    } else {
        ""
    };
    vec![
        system(format!(
            "You review independent candidate findings for evidence gaps and cross-candidate \
             contradictions. Return exactly one JSON object with schema \"{REVIEW_SCHEMA_V1}\" and \
             fields: optional arrays evidence_gaps and contradictions. A gap is \
             {{\"gap_id\":string, \"candidate_id\":string, \"text\":string, \
             \"related_evidence_ids\":[string]}}. A contradiction is {{\"contradiction_id\":string, \
             \"candidate_a\":string, \"claim_a_id\":string, \"candidate_b\":string, \
             \"claim_b_id\":string, \"text\":string, \"evidence_ids\":[string]}}. A contradiction \
             must name two DIFFERENT candidates and reference existing claim ids that belong to \
             them. Reference ONLY supplied candidate ids, claim ids, and evidence ids. Do not \
             invent ids and do not establish any cause.{correction_note}"
        )),
        user(format!(
            "Candidate findings (candidate_id / claim_id / claim text):\n{findings_summary}\n\
             Supplied evidence ids:\n{evidence_lines}\nReturn only the JSON object."
        )),
    ]
}

/// Synthesizer prompt. Consumes typed findings and the typed review; emits the
/// existing investigation_answer.v1 the host already validates.
fn synthesizer_messages(
    user_text: &str,
    findings_summary: &str,
    review_summary: &str,
    candidate_ids: &[String],
    correction: bool,
) -> Vec<ChatMessage> {
    let correction_note = if correction {
        " Your previous JSON was rejected by host validation. Return exactly one corrected JSON \
         object using only the supplied evidence ids and naming every candidate id."
    } else {
        ""
    };
    vec![
        system(format!(
            "You produce the final investigation answer from independent candidate findings and a \
             review. Return exactly one JSON object with schema \"{INVESTIGATION_ANSWER_SCHEMA_V1}\" \
             and fields: candidates (array). Each candidate is {{\"candidate_id\":string, and \
             optional arrays observations, symptoms, causal_candidates, initiating_causes, \
             competing_explanations, missing_evidence}}, each item {{\"claim_id\":string, \
             \"text\":string, \"evidence_ids\":[string]}}. Include EVERY supplied candidate id, keep \
             candidates separate, cite ONLY the supplied evidence ids for the owning candidate, and \
             do not add any host-owned field (no citations, status, corpus, revision, or session). \
             The host, not you, decides whether a root cause is established.{correction_note}"
        )),
        user(format!(
            "Question: {user_text}\nCandidate ids to include: {}\nCandidate findings:\n{findings_summary}\n\
             Review:\n{review_summary}\nReturn only the JSON object.",
            candidate_ids.join(", ")
        )),
    ]
}

/// A host-authored (model-text-free) summary of typed findings for the next
/// stage's prompt. Only host-validated claim text is included, and it is fenced
/// as data, never as instructions.
fn findings_summary(findings: &[CandidateFindingV1]) -> String {
    let mut out = String::new();
    for finding in findings {
        for claim in &finding.claims {
            out.push_str(&format!(
                "{} / {} / {}\n",
                finding.candidate_id,
                claim.claim_id,
                claim.text.replace('\n', " ")
            ));
        }
    }
    out
}

/// A model-text-free summary of a review for the synthesizer prompt.
fn review_summary(review: &ReviewReportV1) -> String {
    let mut out = String::new();
    for gap in &review.gaps {
        out.push_str(&format!(
            "gap {} candidate {}: {}\n",
            gap.gap_id,
            gap.candidate_id,
            gap.text.replace('\n', " ")
        ));
    }
    for c in &review.contradictions {
        out.push_str(&format!(
            "contradiction {} {}#{} vs {}#{}: {}\n",
            c.contradiction_id,
            c.candidate_a,
            c.claim_a_id,
            c.candidate_b,
            c.claim_b_id,
            c.text.replace('\n', " ")
        ));
    }
    if out.is_empty() {
        out.push_str("(no gaps or contradictions reported)\n");
    }
    out
}

/// Every known claim id → owning candidate, for reviewer scope checks.
fn known_claims(findings: &[CandidateFindingV1]) -> KnownClaims {
    let mut map = KnownClaims::new();
    for finding in findings {
        for claim in &finding.claims {
            map.insert(claim.claim_id.clone(), finding.candidate_id.clone());
        }
    }
    map
}

/// Result of driving one model call with a bounded correction budget. Every
/// non-cancel variant carries what the stage actually consumed so telemetry is
/// accurate even when a provider error or deadline lands on a correction
/// attempt after an earlier round already completed.
enum CallResult<T> {
    Ok {
        value: T,
        rounds: u32,
        corrections: u8,
        chars: u64,
    },
    SemanticInvalid {
        rounds: u32,
        corrections: u8,
        chars: u64,
    },
    Provider {
        error: CoreError,
        rounds: u32,
        corrections: u8,
        chars: u64,
    },
    Deadline {
        rounds: u32,
        corrections: u8,
        chars: u64,
    },
    Cancelled,
}

/// Drive one stage: up to `1 + max_corrections` model calls, re-prompting only
/// on host-validation failure. A provider error, deadline, or cancel returns
/// immediately. Transport retries live below `complete_streaming` and never
/// increment `rounds`.
#[allow(clippy::too_many_arguments)]
async fn drive_stage<T>(
    backend: &dyn ChatBackend,
    clock: &TurnClock,
    cancel: Option<&AtomicBool>,
    build_messages: impl Fn(bool) -> Vec<ChatMessage>,
    validate: impl Fn(&str) -> Option<T>,
    max_corrections: u8,
    max_rounds_here: u32,
) -> CallResult<T> {
    let mut rounds = 0u32;
    let mut corrections = 0u8;
    let mut chars = 0u64;
    loop {
        if rounds >= max_rounds_here {
            return CallResult::SemanticInvalid {
                rounds,
                corrections,
                chars,
            };
        }
        let messages = build_messages(corrections > 0);
        chars = chars.saturating_add(messages.iter().map(|m| m.content.len() as u64).sum::<u64>());
        let mut buffered = String::new();
        let mut on_text = |t: String| buffered.push_str(&t);
        let completion = match within_turn_deadline(
            clock,
            cancel,
            backend.complete_streaming(&messages, &[], &mut on_text, cancel),
        )
        .await
        {
            Ok(Ok(completion)) => completion,
            Ok(Err(error)) => {
                if error.to_string().contains("cancelled") {
                    return CallResult::Cancelled;
                }
                return CallResult::Provider {
                    error,
                    rounds,
                    corrections,
                    chars,
                };
            }
            Err(TurnAwaitError::Cancelled) => return CallResult::Cancelled,
            Err(TurnAwaitError::Deadline) => {
                return CallResult::Deadline {
                    rounds,
                    corrections,
                    chars,
                }
            }
        };
        rounds = rounds.saturating_add(1);
        let content = if completion.content.trim().is_empty() {
            buffered
        } else {
            completion.content
        };
        if let Some(value) = validate(&content) {
            return CallResult::Ok {
                value,
                rounds,
                corrections,
                chars,
            };
        }
        if corrections >= max_corrections {
            return CallResult::SemanticInvalid {
                rounds,
                corrections,
                chars,
            };
        }
        corrections = corrections.saturating_add(1);
    }
}

fn role_binding(
    role: InvestigationRole,
    profile: &str,
    model: &str,
    corrections: u8,
) -> RoleBinding {
    RoleBinding {
        role,
        profile_id: profile.to_string(),
        model: model.to_string(),
        semantic_attempts: corrections,
    }
}

/// Run the reviewer-first pipeline. See the module docs for the contract.
///
/// The caller guarantees the reviewer backend is present and its entry
/// preconditions (qualification, egress, local-only) already hold; this
/// function owns only the mid-pipeline budget/provider/deadline/semantic
/// degradations. On any reviewer failure it degrades to synthesis without
/// review — never fabricating a review and never re-running work.
pub async fn run_review_pipeline(
    backends: &MultiModelBackends<'_>,
    inputs: ReviewPipelineInputs<'_>,
    on_stage: &mut (dyn FnMut(StageProgressEvent) + Send),
) -> CoreResult<MultiModelOutcome> {
    let clock = TurnClock::new(flat_plan(inputs.deadline_ms), inputs.started_at);
    let cancel: Option<&AtomicBool> = inputs.cancel.as_deref();
    let budget = inputs.budget;
    let max_corr = budget.max_semantic_corrections_per_stage;
    let packing = synthesis_packing_budget(budget.context_char_budget);

    let candidates: Vec<&BroadLogTriageCandidate> = inputs
        .candidates
        .iter()
        .filter(|c| !c.evidence.is_empty())
        .collect();
    if candidates.len() < 2 {
        return Ok(MultiModelOutcome::NotEligible);
    }
    // The minimum viable typed path is two investigator rounds plus one
    // synthesis round. A ceiling below that cannot host the pipeline, so fall
    // through to the single-model path rather than start work we cannot finish.
    if budget.max_total_provider_rounds < 3 {
        return Ok(MultiModelOutcome::NotEligible);
    }
    // Worst-case rounds one stage may consume (one attempt plus corrections).
    let stage_cap = u32::from(max_corr) + 1;
    // Clamp a stage to what the global ceiling still allows, so `used_rounds`
    // can never exceed `max_total_provider_rounds` — the documented hard
    // ceiling holds for every stage, not just the reviewer.
    let stage_budget = |used: u32, reserve_for_synth: u32| -> u32 {
        let remaining = budget
            .max_total_provider_rounds
            .saturating_sub(used)
            .saturating_sub(reserve_for_synth);
        stage_cap.min(remaining)
    };

    let mut stages: Vec<StageTelemetry> = Vec::new();
    let mut used_rounds = 0u32;
    let mut used_chars = 0u64;

    // ---- Stage 2: investigator, one typed finding per candidate ----
    let mut findings: Vec<CandidateFindingV1> = Vec::new();
    let mut accepted: Vec<&BroadLogTriageCandidate> = Vec::new();
    for candidate in &candidates {
        let Ok(ledger) = candidate_ledger(candidate, &inputs.binding) else {
            continue;
        };
        let evidence_lines = candidate_evidence_lines(&ledger);
        // A candidate whose prompt cannot fit the packing budget is skipped,
        // exactly as the existing path declines an over-budget candidate.
        if crate::agent::estimate_context_chars(&investigator_messages(
            inputs.user_text,
            &candidate.group_id,
            &evidence_lines,
            false,
        )) > packing
        {
            continue;
        }
        // Reserve one round for the mandatory synthesis stage so investigators
        // can never consume the whole ceiling.
        let investigator_rounds_here = stage_budget(used_rounds, 1);
        if investigator_rounds_here == 0 {
            break;
        }
        on_stage(StageProgressEvent {
            role: InvestigationRole::Investigator,
            started: true,
            outcome: None,
            candidate_id: Some(candidate.group_id.clone()),
            detail: "investigating candidate".into(),
        });
        let group_id = candidate.group_id.clone();
        let result = drive_stage(
            backends.investigator,
            &clock,
            cancel,
            |correction| {
                investigator_messages(inputs.user_text, &group_id, &evidence_lines, correction)
            },
            |content| {
                validate_candidate_finding(
                    content,
                    &ledger,
                    &group_id,
                    role_binding(
                        InvestigationRole::Investigator,
                        &inputs.role_ids.investigator_profile,
                        &inputs.role_ids.investigator_model,
                        0,
                    ),
                )
                .ok()
            },
            max_corr,
            investigator_rounds_here,
        )
        .await;
        match result {
            CallResult::Ok {
                mut value,
                rounds,
                corrections,
                chars,
            } => {
                used_rounds = used_rounds.saturating_add(rounds);
                used_chars = used_chars.saturating_add(chars);
                value.role_binding.semantic_attempts = corrections;
                stages.push(StageTelemetry {
                    role: InvestigationRole::Investigator,
                    profile_id: inputs.role_ids.investigator_profile.clone(),
                    model: inputs.role_ids.investigator_model.clone(),
                    provider_rounds: rounds,
                    semantic_corrections: corrections,
                    context_chars_sent: chars,
                    outcome: StageOutcomeKind::Completed,
                });
                on_stage(StageProgressEvent {
                    role: InvestigationRole::Investigator,
                    started: false,
                    outcome: Some(StageOutcomeKind::Completed),
                    candidate_id: Some(candidate.group_id.clone()),
                    detail: format!("{} claim(s) validated", value.claims.len()),
                });
                accepted.push(candidate);
                findings.push(value);
            }
            CallResult::SemanticInvalid {
                rounds,
                corrections,
                chars,
            } => {
                used_rounds = used_rounds.saturating_add(rounds);
                used_chars = used_chars.saturating_add(chars);
                stages.push(StageTelemetry {
                    role: InvestigationRole::Investigator,
                    profile_id: inputs.role_ids.investigator_profile.clone(),
                    model: inputs.role_ids.investigator_model.clone(),
                    provider_rounds: rounds,
                    semantic_corrections: corrections,
                    context_chars_sent: chars,
                    outcome: StageOutcomeKind::SemanticInvalid,
                });
                on_stage(StageProgressEvent {
                    role: InvestigationRole::Investigator,
                    started: false,
                    outcome: Some(StageOutcomeKind::SemanticInvalid),
                    candidate_id: Some(candidate.group_id.clone()),
                    detail: "candidate finding failed host validation".into(),
                });
                // Rejected candidate: excluded from the answer, fail-closed.
            }
            CallResult::Provider { error, .. } => {
                return Ok(MultiModelOutcome::ProviderFailed(Box::new(error)))
            }
            CallResult::Deadline { .. } => return Ok(MultiModelOutcome::Deadline),
            CallResult::Cancelled => return Ok(MultiModelOutcome::Cancelled),
        }
    }

    // A typed path that could not produce two valid findings falls through to
    // the single-model path. No review ran and no answer was produced, so the
    // executed mode is single and no reviewer degradation is claimed.
    if findings.len() < 2 {
        return Ok(MultiModelOutcome::FailedClosed {
            reason: "fewer than two candidate findings passed host validation",
            telemetry: Box::new(finalize_telemetry(
                MultiModelMode::Review,
                ExecutedMode::Single,
                None,
                stages,
                used_rounds,
                used_chars,
            )),
        });
    }

    let Ok(ledger) = union_ledger(&accepted, &inputs.binding) else {
        return Ok(MultiModelOutcome::FailedClosed {
            reason: "host evidence ledger was invalid",
            telemetry: Box::new(finalize_telemetry(
                MultiModelMode::Review,
                ExecutedMode::Single,
                None,
                stages,
                used_rounds,
                used_chars,
            )),
        });
    };
    let candidate_ids: Vec<String> = accepted.iter().map(|c| c.group_id.clone()).collect();
    let all_evidence_lines = candidate_evidence_lines(&ledger);

    // ---- Stage 3: reviewer (optional; degrades) ----
    let mut executed = ExecutedMode::Review;
    let mut degradation: Option<DegradationReason> = None;
    let mut review: Option<ReviewReportV1> = None;

    // Reserve one synthesis round after the reviewer; the reviewer may use
    // whatever the ceiling still allows beyond that reserve.
    let reviewer_rounds_here = stage_budget(used_rounds, 1);
    let fits_rounds = reviewer_rounds_here > 0;
    let reviewer_msgs = reviewer_messages(&findings_summary(&findings), &all_evidence_lines, false);
    let reviewer_chars: u64 = reviewer_msgs.iter().map(|m| m.content.len() as u64).sum();
    let fits_usage = match budget.max_context_chars_total {
        Some(limit) => used_chars.saturating_add(reviewer_chars) <= limit,
        None => true,
    };

    if !fits_rounds {
        executed = ExecutedMode::ReviewDegraded;
        degradation = Some(DegradationReason::BudgetRoundsInsufficient);
        emit_skip(
            on_stage,
            DegradationReason::BudgetRoundsInsufficient,
            &mut stages,
            &inputs,
        );
    } else if !fits_usage {
        executed = ExecutedMode::ReviewDegraded;
        degradation = Some(DegradationReason::BudgetUsageInsufficient);
        emit_skip(
            on_stage,
            DegradationReason::BudgetUsageInsufficient,
            &mut stages,
            &inputs,
        );
    } else {
        on_stage(StageProgressEvent {
            role: InvestigationRole::Reviewer,
            started: true,
            outcome: None,
            candidate_id: None,
            detail: "reviewing candidate findings".into(),
        });
        let known = known_claims(&findings);
        let summary = findings_summary(&findings);
        let result = drive_stage(
            backends.reviewer,
            &clock,
            cancel,
            |correction| reviewer_messages(&summary, &all_evidence_lines, correction),
            |content| {
                validate_review_report(
                    content,
                    &ledger,
                    &known,
                    role_binding(
                        InvestigationRole::Reviewer,
                        &inputs.role_ids.reviewer_profile,
                        &inputs.role_ids.reviewer_model,
                        0,
                    ),
                )
                .ok()
            },
            max_corr,
            reviewer_rounds_here,
        )
        .await;
        match result {
            CallResult::Ok {
                mut value,
                rounds,
                corrections,
                chars,
            } => {
                used_rounds = used_rounds.saturating_add(rounds);
                used_chars = used_chars.saturating_add(chars);
                value.role_binding.semantic_attempts = corrections;
                stages.push(StageTelemetry {
                    role: InvestigationRole::Reviewer,
                    profile_id: inputs.role_ids.reviewer_profile.clone(),
                    model: inputs.role_ids.reviewer_model.clone(),
                    provider_rounds: rounds,
                    semantic_corrections: corrections,
                    context_chars_sent: chars,
                    outcome: StageOutcomeKind::Completed,
                });
                on_stage(StageProgressEvent {
                    role: InvestigationRole::Reviewer,
                    started: false,
                    outcome: Some(StageOutcomeKind::Completed),
                    candidate_id: None,
                    detail: format!(
                        "{} gap(s), {} contradiction(s)",
                        value.gaps.len(),
                        value.contradictions.len()
                    ),
                });
                review = Some(value);
            }
            // Cancellation is a user action, not a reviewer defect: stop the
            // whole turn rather than degrade.
            CallResult::Cancelled => return Ok(MultiModelOutcome::Cancelled),
            // Every reviewer failure degrades to synthesis-without-review. It
            // never re-runs work and never fabricates a review. The reviewer
            // telemetry records what the stage consumed.
            reviewer_failure => {
                let (outcome_kind, reason, rounds, corrections, chars) = match reviewer_failure {
                    CallResult::Provider {
                        rounds,
                        corrections,
                        chars,
                        ..
                    } => (
                        StageOutcomeKind::ProviderFailed,
                        DegradationReason::ReviewerProviderFailed,
                        rounds,
                        corrections,
                        chars.max(reviewer_chars),
                    ),
                    CallResult::Deadline {
                        rounds,
                        corrections,
                        chars,
                    } => (
                        StageOutcomeKind::Deadline,
                        DegradationReason::ReviewerDeadline,
                        rounds,
                        corrections,
                        chars.max(reviewer_chars),
                    ),
                    CallResult::SemanticInvalid {
                        rounds,
                        corrections,
                        chars,
                    } => (
                        StageOutcomeKind::SemanticInvalid,
                        DegradationReason::ReviewerSemanticInvalid,
                        rounds,
                        corrections,
                        chars,
                    ),
                    CallResult::Ok { .. } | CallResult::Cancelled => unreachable!(),
                };
                used_rounds = used_rounds.saturating_add(rounds);
                used_chars = used_chars.saturating_add(chars);
                stages.push(StageTelemetry {
                    role: InvestigationRole::Reviewer,
                    profile_id: inputs.role_ids.reviewer_profile.clone(),
                    model: inputs.role_ids.reviewer_model.clone(),
                    provider_rounds: rounds,
                    semantic_corrections: corrections,
                    context_chars_sent: chars,
                    outcome: outcome_kind,
                });
                executed = ExecutedMode::ReviewDegraded;
                degradation = Some(reason);
                on_stage(StageProgressEvent {
                    role: InvestigationRole::Reviewer,
                    started: false,
                    outcome: Some(outcome_kind),
                    candidate_id: None,
                    detail: reason.detail().into(),
                });
            }
        }
    }

    // ---- Stage 5: synthesis (reuses the existing host validation) ----
    // The mandatory synthesis stage is clamped to the remaining ceiling; the
    // investigator/reviewer phases each reserved a round for it, so this is
    // non-zero on any budget that passed the entry guard, but a defensive
    // fall-through keeps the ceiling honest even if it is not.
    let synth_rounds_here = stage_budget(used_rounds, 0);
    if synth_rounds_here == 0 {
        return Ok(MultiModelOutcome::FailedClosed {
            reason: "round budget exhausted before synthesis",
            telemetry: Box::new(finalize_telemetry(
                MultiModelMode::Review,
                executed,
                degradation.or(Some(DegradationReason::BudgetRoundsInsufficient)),
                stages,
                used_rounds,
                used_chars,
            )),
        });
    }
    on_stage(StageProgressEvent {
        role: InvestigationRole::Synthesizer,
        started: true,
        outcome: None,
        candidate_id: None,
        detail: "synthesizing final answer".into(),
    });
    let summary = findings_summary(&findings);
    let review_text = review.as_ref().map(review_summary).unwrap_or_default();
    let synth = drive_stage(
        backends.synthesizer,
        &clock,
        cancel,
        |correction| {
            synthesizer_messages(
                inputs.user_text,
                &summary,
                &review_text,
                &candidate_ids,
                correction,
            )
        },
        |content| validate_model_answer(content, &ledger).ok(),
        max_corr,
        synth_rounds_here,
    )
    .await;
    match synth {
        CallResult::Ok {
            value,
            rounds,
            corrections,
            chars,
        } => {
            used_rounds = used_rounds.saturating_add(rounds);
            used_chars = used_chars.saturating_add(chars);
            stages.push(StageTelemetry {
                role: InvestigationRole::Synthesizer,
                profile_id: inputs.role_ids.synthesizer_profile.clone(),
                model: inputs.role_ids.synthesizer_model.clone(),
                provider_rounds: rounds,
                semantic_corrections: corrections,
                context_chars_sent: chars,
                outcome: StageOutcomeKind::Completed,
            });
            on_stage(StageProgressEvent {
                role: InvestigationRole::Synthesizer,
                started: false,
                outcome: Some(StageOutcomeKind::Completed),
                candidate_id: None,
                detail: "final answer validated".into(),
            });
            let mut envelope = value;
            envelope.semantic_attempts = corrections;
            let content = render_answer_markdown(&envelope);
            let telemetry = finalize_telemetry(
                MultiModelMode::Review,
                executed,
                degradation,
                stages,
                used_rounds,
                used_chars,
            );
            Ok(MultiModelOutcome::Completed {
                envelope: Box::new(envelope),
                content,
                review: if executed == ExecutedMode::Review {
                    review
                } else {
                    None
                },
                telemetry: Box::new(telemetry),
            })
        }
        CallResult::SemanticInvalid {
            rounds,
            corrections,
            chars,
        } => {
            used_rounds = used_rounds.saturating_add(rounds);
            used_chars = used_chars.saturating_add(chars);
            stages.push(StageTelemetry {
                role: InvestigationRole::Synthesizer,
                profile_id: inputs.role_ids.synthesizer_profile.clone(),
                model: inputs.role_ids.synthesizer_model.clone(),
                provider_rounds: rounds,
                semantic_corrections: corrections,
                context_chars_sent: chars,
                outcome: StageOutcomeKind::SemanticInvalid,
            });
            on_stage(StageProgressEvent {
                role: InvestigationRole::Synthesizer,
                started: false,
                outcome: Some(StageOutcomeKind::SemanticInvalid),
                candidate_id: None,
                detail: "final synthesis failed host validation".into(),
            });
            Ok(MultiModelOutcome::FailedClosed {
                reason: "final synthesis failed host validation",
                telemetry: Box::new(finalize_telemetry(
                    MultiModelMode::Review,
                    executed,
                    degradation,
                    stages,
                    used_rounds,
                    used_chars,
                )),
            })
        }
        CallResult::Provider { error, .. } => {
            Ok(MultiModelOutcome::ProviderFailed(Box::new(error)))
        }
        CallResult::Deadline { .. } => Ok(MultiModelOutcome::Deadline),
        CallResult::Cancelled => Ok(MultiModelOutcome::Cancelled),
    }
}

fn emit_skip(
    on_stage: &mut (dyn FnMut(StageProgressEvent) + Send),
    reason: DegradationReason,
    stages: &mut Vec<StageTelemetry>,
    inputs: &ReviewPipelineInputs<'_>,
) {
    stages.push(StageTelemetry {
        role: InvestigationRole::Reviewer,
        profile_id: inputs.role_ids.reviewer_profile.clone(),
        model: inputs.role_ids.reviewer_model.clone(),
        provider_rounds: 0,
        semantic_corrections: 0,
        context_chars_sent: 0,
        outcome: StageOutcomeKind::Skipped,
    });
    on_stage(StageProgressEvent {
        role: InvestigationRole::Reviewer,
        started: false,
        outcome: Some(StageOutcomeKind::Skipped),
        candidate_id: None,
        detail: reason.detail().into(),
    });
}

fn finalize_telemetry(
    configured: MultiModelMode,
    executed: ExecutedMode,
    degradation: Option<DegradationReason>,
    stages: Vec<StageTelemetry>,
    total_rounds: u32,
    total_chars: u64,
) -> MultiModelTurnTelemetry {
    MultiModelTurnTelemetry {
        schema: MULTI_MODEL_TELEMETRY_SCHEMA_V1.to_string(),
        configured_mode: configured,
        executed_mode: executed,
        degradation,
        stages,
        total_provider_rounds: total_rounds,
        total_context_chars_sent: total_chars,
    }
}

/// Render a completed outcome's review section, if any, for hosts that want to
/// show the review beneath the answer. Uses the shared presentation boundary.
pub fn render_outcome_review(review: &ReviewReportV1) -> String {
    render_review_markdown(review)
}
