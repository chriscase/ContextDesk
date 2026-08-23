//! Truth-isolated provider boundary for the checked-in known-answer suite.
//!
//! A provider sees only an opaque scenario id, the user question, frozen
//! evidence, and a response contract. Fixture case ids, scripted candidates,
//! evaluator truth, expectations, and diagnostic telemetry remain host-only.

use super::answer_score::score_answer;
use super::suite::{
    hex_sha256, scan_privacy_text, LoadedSuite, RUNTIME_FORBIDDEN_EVALUATOR_TOKENS,
};
use super::types::{
    failure_reason, AnswerClaim, AnswerDimension, AnswerScore, AnswerTruth, CandidateAnswer,
    EvidencePacket, LaneStatus, ScriptedDiagnostic,
};
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Provider-visible request schema.
pub const LIVE_KNOWN_ANSWER_PROMPT_SCHEMA_ID: &str =
    "contextdesk.quality_eval.live_known_answer_prompt.v1";
/// Provider response schema.
pub const LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID: &str =
    "contextdesk.quality_eval.live_known_answer_response.v1";
/// Frozen packet evaluated by this adapter.
pub const LIVE_KNOWN_ANSWER_PACKET_ID: &str = "fixed";
/// Maximum accepted provider response size.
pub const LIVE_KNOWN_ANSWER_RESPONSE_MAX_BYTES: usize = 64 * 1024;
/// Stable failure reason for a source/time citation that does not match the host packet.
pub const EXACT_CITATION_MISMATCH: &str = "exact_source_time_citation_mismatch";
/// Stable failure reason for repeated citation tuples within one claim.
pub const DUPLICATE_EXACT_CITATION: &str = "duplicate_exact_citation";

const MAX_CLAIMS: usize = 32;
const MAX_CITATIONS_PER_CLAIM: usize = 16;
const MAX_CLAIM_TEXT_BYTES: usize = 4 * 1024;
const MAX_CONCLUSION_BYTES: usize = 8 * 1024;

/// One provider-visible frozen evidence row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveEvidenceDocument {
    /// Opaque evidence id used by the existing deterministic scorer.
    pub evidence_id: String,
    /// Opaque host-assigned source identity for exact citation checks.
    pub source_id: String,
    /// Opaque host-assigned ordering/time anchor for exact citation checks.
    pub time_anchor: String,
    /// Evidence text visible to the model.
    pub text: String,
}

/// Provider-visible response instructions. These describe syntax, never truth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveResponseContract {
    /// Required response schema id.
    pub schema_id: String,
    /// Neutral instructions shared by every scenario.
    pub instructions: Vec<String>,
    /// Closed claim-role vocabulary.
    pub allowed_claim_roles: Vec<String>,
    /// Closed confidence vocabulary.
    pub allowed_confidence: Vec<String>,
}

/// Complete provider-visible known-answer prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveKnownAnswerPrompt {
    /// Prompt schema id.
    pub schema_id: String,
    /// Opaque id assigned by manifest order; it does not reveal fixture intent.
    pub scenario_id: String,
    /// User question from the model-visible runtime.
    pub question: String,
    /// Frozen fixed-packet evidence.
    pub evidence: Vec<LiveEvidenceDocument>,
    /// Strict response contract.
    pub response_contract: LiveResponseContract,
}

/// Exact citation emitted by the provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveCitation {
    /// Evidence id from the prompt.
    pub evidence_id: String,
    /// Exact source id from the same evidence row.
    pub source_id: String,
    /// Exact time anchor from the same evidence row.
    pub time_anchor: String,
}

/// One structured provider claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveAnswerClaim {
    /// Claim text.
    pub text: String,
    /// Exact evidence/source/time citations.
    #[serde(default)]
    pub citations: Vec<LiveCitation>,
    /// Optional closed-vocabulary causal role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// Strict provider response. Host diagnostics are deliberately absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveKnownAnswerResponse {
    /// Response schema id.
    pub schema_id: String,
    /// Must exactly match the prompt scenario id.
    pub scenario_id: String,
    /// Whether the provider says the initiating cause is established.
    #[serde(default)]
    pub asserts_root_cause_established: bool,
    /// Structured claims.
    #[serde(default)]
    pub claims: Vec<LiveAnswerClaim>,
    /// Concise conclusion.
    #[serde(default)]
    pub conclusion: String,
    /// high | medium | low.
    #[serde(default)]
    pub confidence: String,
}

/// Host-only prepared case. Intentionally does not implement `Serialize`.
#[derive(Debug, Clone)]
pub struct PreparedLiveKnownAnswerCase {
    prompt: LiveKnownAnswerPrompt,
    case_id: String,
    task_id: String,
    packet: EvidencePacket,
    truth: AnswerTruth,
}

impl PreparedLiveKnownAnswerCase {
    /// Provider-visible prompt only.
    pub fn prompt(&self) -> &LiveKnownAnswerPrompt {
        &self.prompt
    }

    /// Host-only fixture identity for joining scores after provider execution.
    pub fn host_case_id(&self) -> &str {
        &self.case_id
    }

    /// Host-only task identity for joining scores after provider execution.
    pub fn host_task_id(&self) -> &str {
        &self.task_id
    }
}

/// Score joined to both opaque provider and host-only case identities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveKnownAnswerScore {
    /// Opaque id exposed to the provider.
    pub scenario_id: String,
    /// Host-only fixture id.
    pub case_id: String,
    /// Existing deterministic answer score plus exact-citation dimensions.
    pub answer: AnswerScore,
}

/// Prepare every checked-in case in manifest order using its `fixed` packet.
pub fn prepare_live_known_answer_suite(
    suite: &LoadedSuite,
) -> CoreResult<Vec<PreparedLiveKnownAnswerCase>> {
    let mut prepared = Vec::with_capacity(suite.cases.len());
    for (index, case) in suite.cases.iter().enumerate() {
        if case.runtime.questions.len() != 1 || case.truth.answers.len() != 1 {
            return Err(live_error(
                "each live scenario must contain exactly one question and one answer truth",
            ));
        }
        let question = case
            .runtime
            .questions
            .values()
            .next()
            .cloned()
            .ok_or_else(|| live_error("live scenario question missing"))?;
        let truth = case
            .truth
            .answers
            .first()
            .cloned()
            .ok_or_else(|| live_error("live scenario answer truth missing"))?;
        let packet = case
            .runtime
            .packets
            .iter()
            .find(|packet| packet.packet_id == LIVE_KNOWN_ANSWER_PACKET_ID)
            .cloned()
            .ok_or_else(|| live_error("live scenario fixed packet missing"))?;
        if packet.documents.is_empty() {
            return Err(live_error("live scenario fixed packet must not be empty"));
        }

        let scenario_id = format!("scenario-{:03}", index + 1);
        let evidence = packet
            .documents
            .iter()
            .enumerate()
            .map(|(document_index, document)| LiveEvidenceDocument {
                evidence_id: document.id.clone(),
                source_id: format!("source-{:03}", document_index + 1),
                time_anchor: format!("time-{:03}", document_index + 1),
                text: document.text.clone(),
            })
            .collect();
        let prompt = LiveKnownAnswerPrompt {
            schema_id: LIVE_KNOWN_ANSWER_PROMPT_SCHEMA_ID.into(),
            scenario_id,
            question,
            evidence,
            response_contract: LiveResponseContract {
                schema_id: LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID.into(),
                instructions: vec![
                    "Use only the supplied evidence; do not invent records or identities.".into(),
                    "Give every claim one or more exact evidence/source/time citations.".into(),
                    "If the initiating cause is not established, say so and cite the observed condition.".into(),
                    "Return only one JSON object matching the response schema.".into(),
                ],
                allowed_claim_roles: vec![
                    "trigger".into(),
                    "symptom".into(),
                    "recovery".into(),
                    "independent".into(),
                    "observation".into(),
                    "other".into(),
                ],
                allowed_confidence: vec!["high".into(), "medium".into(), "low".into()],
            },
        };
        validate_prompt_values(&prompt)?;
        prepared.push(PreparedLiveKnownAnswerCase {
            prompt,
            case_id: case.truth.case_id.clone(),
            task_id: truth.task_id.clone(),
            packet,
            truth,
        });
    }
    if prepared.is_empty() {
        return Err(live_error("live suite must contain at least one scenario"));
    }
    Ok(prepared)
}

/// Serialize only the provider-visible prompt.
pub fn serialize_live_known_answer_prompt(
    prepared: &PreparedLiveKnownAnswerCase,
) -> CoreResult<String> {
    validate_prompt_values(&prepared.prompt)?;
    serde_json::to_string(&prepared.prompt).map_err(CoreError::from)
}

/// Deterministic digest of the exact provider-visible prompt set.
pub fn live_known_answer_prompt_set_hash(
    prepared: &[PreparedLiveKnownAnswerCase],
) -> CoreResult<String> {
    if prepared.is_empty() {
        return Err(live_error("cannot hash an empty live prompt set"));
    }
    let mut framed = Vec::new();
    for case in prepared {
        let bytes = serialize_live_known_answer_prompt(case)?.into_bytes();
        framed.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
        framed.extend_from_slice(&bytes);
    }
    Ok(hex_sha256(&framed))
}

/// Parse a bounded strict provider response for one exact scenario.
pub fn parse_live_known_answer_response(
    prepared: &PreparedLiveKnownAnswerCase,
    raw: &str,
) -> CoreResult<LiveKnownAnswerResponse> {
    if raw.len() > LIVE_KNOWN_ANSWER_RESPONSE_MAX_BYTES {
        return Err(live_error("provider response exceeds the byte limit"));
    }
    if !scan_privacy_text(raw).is_empty() {
        return Err(CoreError::Policy(
            failure_reason::EXPORT_PRIVACY_VIOLATION.into(),
        ));
    }
    let response: LiveKnownAnswerResponse = serde_json::from_str(raw)?;
    validate_response_contract(prepared, &response)?;
    Ok(response)
}

/// Score one strict response. Diagnostic evidence can only enter through the
/// separate host-owned argument; providers cannot serialize that field.
pub fn score_live_known_answer_response(
    prepared: &PreparedLiveKnownAnswerCase,
    response: &LiveKnownAnswerResponse,
    host_diagnostic: Option<ScriptedDiagnostic>,
) -> CoreResult<LiveKnownAnswerScore> {
    validate_response_contract(prepared, response)?;
    let mut exact_citations = true;
    let mut unique_citations = true;
    let mut every_claim_cited = !response.claims.is_empty();
    let claims = response
        .claims
        .iter()
        .map(|claim| {
            if claim.citations.is_empty() || claim.text.trim().is_empty() {
                every_claim_cited = false;
            }
            let mut seen = BTreeSet::new();
            let mut evidence_ids = Vec::with_capacity(claim.citations.len());
            for citation in &claim.citations {
                let tuple = (
                    citation.evidence_id.as_str(),
                    citation.source_id.as_str(),
                    citation.time_anchor.as_str(),
                );
                if !seen.insert(tuple) {
                    unique_citations = false;
                }
                let matches = prepared.prompt.evidence.iter().any(|evidence| {
                    evidence.evidence_id == citation.evidence_id
                        && evidence.source_id == citation.source_id
                        && evidence.time_anchor == citation.time_anchor
                });
                if !matches {
                    exact_citations = false;
                }
                evidence_ids.push(citation.evidence_id.clone());
            }
            AnswerClaim {
                text: claim.text.clone(),
                evidence_ids,
                role: claim.role.clone(),
            }
        })
        .collect();

    let candidate = CandidateAnswer {
        candidate_id: format!("live:{}", prepared.prompt.scenario_id),
        task_id: prepared.task_id.clone(),
        packet_id: prepared.packet.packet_id.clone(),
        asserts_root_cause_established: response.asserts_root_cause_established,
        claims,
        conclusion: response.conclusion.clone(),
        confidence: response.confidence.clone(),
        diagnostic: host_diagnostic,
    };
    let mut answer = score_answer(&candidate, &prepared.truth, &prepared.packet);
    answer.dimensions.push(AnswerDimension {
        id: "live_claim_citation_contract".into(),
        passed: every_claim_cited,
        reason: if every_claim_cited {
            "every live claim has exact citation fields".into()
        } else {
            failure_reason::MISSING_REQUIRED_CITATION.into()
        },
    });
    answer.dimensions.push(AnswerDimension {
        id: "live_exact_source_time_citations".into(),
        passed: exact_citations,
        reason: if exact_citations {
            "all live citations match one frozen evidence/source/time tuple".into()
        } else {
            EXACT_CITATION_MISMATCH.into()
        },
    });
    answer.dimensions.push(AnswerDimension {
        id: "live_unique_citations".into(),
        passed: unique_citations,
        reason: if unique_citations {
            "live citations are unique within each claim".into()
        } else {
            DUPLICATE_EXACT_CITATION.into()
        },
    });
    answer.passed = answer.dimensions.iter().all(|dimension| dimension.passed);
    answer.status = LaneStatus::Executed;

    Ok(LiveKnownAnswerScore {
        scenario_id: prepared.prompt.scenario_id.clone(),
        case_id: prepared.case_id.clone(),
        answer,
    })
}

fn validate_prompt_values(prompt: &LiveKnownAnswerPrompt) -> CoreResult<()> {
    if prompt.schema_id != LIVE_KNOWN_ANSWER_PROMPT_SCHEMA_ID
        || prompt.response_contract.schema_id != LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID
        || prompt.scenario_id.trim().is_empty()
        || prompt.question.trim().is_empty()
        || prompt.evidence.is_empty()
    {
        return Err(live_error("invalid provider-visible prompt contract"));
    }
    let values = [
        prompt.schema_id.as_str(),
        prompt.scenario_id.as_str(),
        prompt.question.as_str(),
        prompt.response_contract.schema_id.as_str(),
    ]
    .into_iter()
    .chain(
        prompt
            .response_contract
            .instructions
            .iter()
            .map(String::as_str),
    )
    .chain(
        prompt
            .response_contract
            .allowed_claim_roles
            .iter()
            .map(String::as_str),
    )
    .chain(
        prompt
            .response_contract
            .allowed_confidence
            .iter()
            .map(String::as_str),
    )
    .chain(prompt.evidence.iter().flat_map(|document| {
        [
            document.evidence_id.as_str(),
            document.source_id.as_str(),
            document.time_anchor.as_str(),
            document.text.as_str(),
        ]
    }))
    .collect::<Vec<_>>();
    let visible_blob = values.join("\n");
    if !scan_privacy_text(&visible_blob).is_empty() {
        return Err(CoreError::Policy(
            failure_reason::EXPORT_PRIVACY_VIOLATION.into(),
        ));
    }
    let normalized = visible_blob.to_ascii_lowercase();
    if RUNTIME_FORBIDDEN_EVALUATOR_TOKENS
        .iter()
        .any(|token| normalized.contains(&token.to_ascii_lowercase()))
    {
        return Err(CoreError::Policy(
            failure_reason::TRUTH_LEAKED_INTO_RUNTIME.into(),
        ));
    }
    Ok(())
}

fn validate_response_values(response: &LiveKnownAnswerResponse) -> CoreResult<()> {
    let values = [
        response.schema_id.as_str(),
        response.scenario_id.as_str(),
        response.conclusion.as_str(),
        response.confidence.as_str(),
    ]
    .into_iter()
    .chain(response.claims.iter().flat_map(|claim| {
        std::iter::once(claim.text.as_str())
            .chain(claim.role.iter().map(String::as_str))
            .chain(claim.citations.iter().flat_map(|citation| {
                [
                    citation.evidence_id.as_str(),
                    citation.source_id.as_str(),
                    citation.time_anchor.as_str(),
                ]
            }))
    }))
    .collect::<Vec<_>>();
    if !scan_privacy_text(&values.join("\n")).is_empty() {
        return Err(CoreError::Policy(
            failure_reason::EXPORT_PRIVACY_VIOLATION.into(),
        ));
    }
    Ok(())
}

fn validate_response_contract(
    prepared: &PreparedLiveKnownAnswerCase,
    response: &LiveKnownAnswerResponse,
) -> CoreResult<()> {
    if response.schema_id != LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID
        || response.scenario_id != prepared.prompt.scenario_id
    {
        return Err(live_error("provider response identity mismatch"));
    }
    if !prepared
        .prompt
        .response_contract
        .allowed_confidence
        .contains(&response.confidence)
        || response.claims.iter().any(|claim| {
            claim.role.as_ref().is_some_and(|role| {
                !prepared
                    .prompt
                    .response_contract
                    .allowed_claim_roles
                    .contains(role)
            })
        })
    {
        return Err(live_error(
            "provider response uses a value outside the closed vocabulary",
        ));
    }
    if response.claims.len() > MAX_CLAIMS
        || response.conclusion.len() > MAX_CONCLUSION_BYTES
        || response.claims.iter().any(|claim| {
            claim.text.len() > MAX_CLAIM_TEXT_BYTES
                || claim.citations.len() > MAX_CITATIONS_PER_CLAIM
        })
    {
        return Err(live_error("provider response exceeds structural limits"));
    }
    if serde_json::to_vec(response)?.len() > LIVE_KNOWN_ANSWER_RESPONSE_MAX_BYTES {
        return Err(live_error("provider response exceeds the byte limit"));
    }
    validate_response_values(response)
}

fn live_error(detail: &str) -> CoreError {
    CoreError::Config(format!(
        "{}: {detail}",
        failure_reason::INVALID_ANSWER_SCHEMA
    ))
}
