//! Portable interaction traces shared with collab (`cd-collab.interaction_trace.v1`).
//!
//! This module parses the collab camelCase document and projects strategy
//! comparisons. It does not duplicate gold, adjudication, or decision schemas.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::{BenchError, BenchResult};
use crate::gold::{GoldReference, GOLD_ALIGNMENT_NOT_CORRECTNESS, GOLD_IS_HUMAN_BENCHMARK};
use crate::types::{sha256_hex, validate_id};

pub const INTERACTION_TRACE_SCHEMA_V1: &str = "cd-collab.interaction_trace.v1";
pub const TRACE_UNKNOWN_STAYS_UNKNOWN: &str = "Ambiguous transcript structure stays unknown.";
pub const TEXTUAL_SIMILARITY_NOT_WINNER: &str = "Textual similarity is not a winner.";
pub const AGREEMENT_NOT_CORRECTNESS: &str = "Agreement is not proof of correctness.";
const MAX_EXCERPT: usize = 240;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionTrace {
    pub schema_id: String,
    pub trace_id: String,
    pub candidate_id: String,
    pub source_kind: String,
    pub completeness: String,
    pub privacy_class: String,
    pub raw_hash: Option<String>,
    pub events: Vec<InteractionEvent>,
    pub efficiency: TraceEfficiency,
    pub unknowns: Vec<String>,
    pub notes: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteractionEvent {
    pub event_id: String,
    pub sequence: u64,
    pub kind: String,
    pub actor: String,
    pub role: Option<String>,
    pub parent_event_id: Option<String>,
    pub evidence_refs: Vec<String>,
    pub observed_at: ObservedStamp,
    pub excerpt: Option<String>,
    pub excerpt_hash: Option<String>,
    pub unknowns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedStamp {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milliseconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceEfficiency {
    pub turn_count: ObservedStamp,
    pub evidence_acquisition_steps: ObservedStamp,
    pub latency: ObservedStamp,
    pub cost: ObservedStamp,
    pub provider_calls: ObservedStamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyComparison {
    pub schema_id: String,
    pub shared_evidence: Vec<String>,
    pub unique_evidence: BTreeMap<String, Vec<String>>,
    pub question_paths: Vec<String>,
    pub gold_convergence: Vec<String>,
    pub notes: Vec<String>,
}

impl InteractionTrace {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> BenchResult<()> {
        if self.schema_id != INTERACTION_TRACE_SCHEMA_V1 {
            return Err(BenchError::Schema(format!(
                "trace schema must be {INTERACTION_TRACE_SCHEMA_V1}"
            )));
        }
        validate_id("traceId", &self.trace_id)?;
        validate_id("candidateId", &self.candidate_id)?;
        if self.privacy_class != "share_safe" {
            return Err(BenchError::Schema("traces must be share_safe".into()));
        }
        if self.source_kind == "plain_text" && self.completeness == "exact" {
            return Err(BenchError::Schema(
                "plain-text traces cannot claim exact completeness".into(),
            ));
        }
        if !self
            .notes
            .iter()
            .any(|note| note == TRACE_UNKNOWN_STAYS_UNKNOWN)
        {
            return Err(BenchError::Schema(
                "trace notes must include the unknown-structure caveat".into(),
            ));
        }
        for event in &self.events {
            validate_id("eventId", &event.event_id)?;
            if event.sequence < 1 {
                return Err(BenchError::Schema("event sequence must be >= 1".into()));
            }
            if let Some(excerpt) = &event.excerpt {
                if excerpt.chars().count() > MAX_EXCERPT {
                    return Err(BenchError::Schema("excerpt exceeds bound".into()));
                }
                if contains_forbidden(excerpt) {
                    return Err(BenchError::Privacy("excerpt is not share-safe".into()));
                }
            }
        }
        Ok(())
    }
}

fn contains_forbidden(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("bearer ")
        || lower.contains("ai-gateway.vercel.sh")
        || lower.contains("apikey")
        || lower.contains("api_key")
        || lower.contains("authorization")
}

fn bound_excerpt(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if contains_forbidden(trimmed) {
        return Some("[redacted]".into());
    }
    if trimmed.chars().count() <= MAX_EXCERPT {
        Some(trimmed.to_string())
    } else {
        Some(trimmed.chars().take(MAX_EXCERPT).collect())
    }
}

fn match_turn_label(line: &str) -> Option<(&'static str, String)> {
    let idx = line.find(':')?;
    if idx == 0 {
        return None;
    }
    let label = line[..idx].trim().to_ascii_lowercase();
    let body = line[idx + 1..].trim().to_string();
    let kind = match label.as_str() {
        "user" | "human" | "question" => "question",
        "assistant" | "ai" | "answer" => "assistant_response",
        "tool" | "function" => "tool_call",
        "tool result" => "tool_result",
        "hypothesis" => "hypothesis",
        "recommendation" => "recommendation",
        "annotation" => "human_annotation",
        _ => return None,
    };
    Some((kind, body))
}

fn actor_for(kind: &str) -> &'static str {
    match kind {
        "question" | "human_annotation" => "human",
        "tool_call" | "tool_result" => "tool",
        _ => "assistant",
    }
}

fn extract_evidence_refs(text: &str) -> Vec<String> {
    let mut refs = BTreeSet::new();
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if bytes[i] == b'e' && bytes[i + 1] == b'v' && bytes[i + 2] == b'-' {
            let mut j = i + 3;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-') {
                j += 1;
            }
            if j > i + 3 {
                let start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
                if start {
                    refs.insert(lower[i..j].to_string());
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    refs.into_iter().collect()
}

fn unknown_stamp() -> ObservedStamp {
    ObservedStamp {
        status: "unknown".into(),
        timestamp: None,
        count: None,
        milliseconds: None,
        amount: None,
    }
}

/// Best-effort plain-text extraction. Ambiguous structure stays unknown.
pub fn extract_plain_transcript(
    text: &str,
    candidate_id: &str,
    created_at: &str,
) -> BenchResult<InteractionTrace> {
    let normalized = text.replace("\r\n", "\n");
    let mut turns: Vec<(&str, String)> = Vec::new();
    let mut preamble = false;
    for line in normalized.split('\n') {
        if let Some((kind, body)) = match_turn_label(line) {
            turns.push((kind, body));
        } else if turns.is_empty() {
            if !line.trim().is_empty() {
                preamble = true;
            }
        } else if let Some(last) = turns.last_mut() {
            if last.1.is_empty() {
                last.1 = line.to_string();
            } else {
                last.1 = format!("{}\n{line}", last.1);
            }
        }
    }

    let mut unknowns = Vec::new();
    let mut events = Vec::new();
    if turns.is_empty() {
        unknowns.extend(["turns".into(), "tools".into()]);
        let refs = extract_evidence_refs(&normalized);
        if refs.is_empty() {
            unknowns.push("evidence".into());
        }
        events.push(InteractionEvent {
            event_id: format!("evt-{candidate_id}-1"),
            sequence: 1,
            kind: "assistant_response".into(),
            actor: "unknown".into(),
            role: None,
            parent_event_id: None,
            evidence_refs: refs,
            observed_at: unknown_stamp(),
            excerpt: bound_excerpt(&normalized),
            excerpt_hash: Some(sha256_hex(normalized.as_bytes())),
            unknowns: vec![
                "kind".into(),
                "actor".into(),
                "role".into(),
                "timestamp".into(),
            ],
        });
    } else {
        if preamble {
            unknowns.push("preamble".into());
        }
        for (i, (kind, body)) in turns.iter().enumerate() {
            let sequence = (i as u64) + 1;
            let refs = extract_evidence_refs(body);
            let mut event_unknowns = vec!["timestamp".to_string()];
            if body.trim().is_empty() {
                event_unknowns.push("text".into());
            }
            if *kind == "tool_call" || *kind == "tool_result" {
                event_unknowns.push("toolName".into());
            }
            events.push(InteractionEvent {
                event_id: format!("evt-{candidate_id}-{sequence}"),
                sequence,
                kind: (*kind).into(),
                actor: actor_for(kind).into(),
                role: None,
                parent_event_id: if sequence == 1 {
                    None
                } else {
                    Some(format!("evt-{candidate_id}-{}", sequence - 1))
                },
                evidence_refs: refs,
                observed_at: unknown_stamp(),
                excerpt: bound_excerpt(body),
                excerpt_hash: if body.trim().is_empty() {
                    None
                } else {
                    Some(sha256_hex(body.as_bytes()))
                },
                unknowns: event_unknowns,
            });
        }
        if !events
            .iter()
            .any(|event| event.kind == "tool_call" || event.kind == "tool_result")
        {
            unknowns.push("tools".into());
        }
        if !events.iter().any(|event| !event.evidence_refs.is_empty()) {
            unknowns.push("evidence".into());
        }
    }

    let evidence_steps = events
        .iter()
        .filter(|event| !event.evidence_refs.is_empty())
        .count() as u64;
    let mut efficiency = TraceEfficiency {
        turn_count: unknown_stamp(),
        evidence_acquisition_steps: unknown_stamp(),
        latency: unknown_stamp(),
        cost: unknown_stamp(),
        provider_calls: unknown_stamp(),
    };
    if !turns.is_empty() {
        efficiency.turn_count = ObservedStamp {
            status: "observed".into(),
            count: Some(turns.len() as u64),
            timestamp: None,
            milliseconds: None,
            amount: None,
        };
    }
    if evidence_steps > 0 {
        efficiency.evidence_acquisition_steps = ObservedStamp {
            status: "observed".into(),
            count: Some(evidence_steps),
            timestamp: None,
            milliseconds: None,
            amount: None,
        };
    }

    let trace = InteractionTrace {
        schema_id: INTERACTION_TRACE_SCHEMA_V1.into(),
        trace_id: format!(
            "trace-{candidate_id}-{}",
            &sha256_hex(normalized.as_bytes())[..12]
        ),
        candidate_id: candidate_id.into(),
        source_kind: "plain_text".into(),
        completeness: if turns.is_empty() {
            "unknown".into()
        } else {
            "partial".into()
        },
        privacy_class: "share_safe".into(),
        raw_hash: Some(sha256_hex(normalized.as_bytes())),
        events,
        efficiency,
        unknowns,
        notes: vec![TRACE_UNKNOWN_STAYS_UNKNOWN.into()],
        created_at: created_at.into(),
    };
    trace.validate()?;
    Ok(trace)
}

/// Evidence-only strategy comparison. Never ranks textual similarity.
pub fn compare_traces(
    traces: &[InteractionTrace],
    gold: Option<&GoldReference>,
) -> StrategyComparison {
    let mut owners: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut questions: BTreeSet<String> = BTreeSet::new();
    for trace in traces {
        for event in &trace.events {
            if event.kind == "question" {
                if let Some(excerpt) = &event.excerpt {
                    questions.insert(excerpt.clone());
                }
            }
            for evidence in &event.evidence_refs {
                owners
                    .entry(evidence.clone())
                    .or_default()
                    .insert(trace.candidate_id.clone());
            }
        }
    }
    let mut shared = Vec::new();
    let mut unique: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (evidence, candidates) in &owners {
        if candidates.len() > 1 {
            shared.push(evidence.clone());
        } else if let Some(candidate) = candidates.iter().next() {
            unique
                .entry(candidate.clone())
                .or_default()
                .push(evidence.clone());
        }
    }
    let gold_set: BTreeSet<&str> = gold
        .map(|row| row.evidence_anchors.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let gold_convergence = shared
        .iter()
        .filter(|evidence| gold_set.contains(evidence.as_str()))
        .cloned()
        .collect();
    StrategyComparison {
        schema_id: "cd-collab.strategy_comparison.v1".into(),
        shared_evidence: shared,
        unique_evidence: unique,
        question_paths: questions.into_iter().collect(),
        gold_convergence,
        notes: vec![
            AGREEMENT_NOT_CORRECTNESS.into(),
            GOLD_ALIGNMENT_NOT_CORRECTNESS.into(),
            GOLD_IS_HUMAN_BENCHMARK.into(),
            TRACE_UNKNOWN_STAYS_UNKNOWN.into(),
            TEXTUAL_SIMILARITY_NOT_WINNER.into(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_programmatic_fixture() {
        let trace = InteractionTrace::parse_json(include_str!(
            "../../../collab/contracts/fixtures/interaction-trace.programmatic.json"
        ))
        .unwrap();
        assert_eq!(trace.candidate_id, "cand-programmatic-agent");
        assert!(trace.events.iter().any(|event| event.kind == "tool_call"));
    }

    #[test]
    fn rejects_unknown_fields() {
        let err = InteractionTrace::parse_json(include_str!(
            "../../../collab/contracts/fixtures/interaction-trace.unknown-field.json"
        ))
        .unwrap_err();
        assert!(err.to_string().contains("unknown") || err.to_string().contains("endpoint"));
    }

    #[test]
    fn plain_text_unknown_and_labeled_extraction_match_collab_ids() {
        let unknown = extract_plain_transcript(
            "checkout timed out, not sure about the pool\nmaybe inventory",
            "cand-chat-operator",
            "2026-08-19T00:00:00Z",
        )
        .unwrap();
        assert_eq!(unknown.completeness, "unknown");
        assert_eq!(unknown.events[0].event_id, "evt-cand-chat-operator-1");
        assert_eq!(unknown.events[0].actor, "unknown");

        let labeled = extract_plain_transcript(
            "User: What timed out in checkout?\nAssistant: The checkout log and inventory timeout line up. ev-demo-checkout-log ev-demo-inventory-timeout\n",
            "cand-chat-operator",
            "2026-08-19T00:00:00Z",
        )
        .unwrap();
        assert_eq!(labeled.completeness, "partial");
        assert_eq!(labeled.events[0].kind, "question");
        assert_eq!(
            labeled.events[1].evidence_refs,
            vec!["ev-demo-checkout-log", "ev-demo-inventory-timeout"]
        );
    }

    #[test]
    fn comparison_is_not_a_winner() {
        let programmatic = InteractionTrace::parse_json(include_str!(
            "../../../collab/contracts/fixtures/interaction-trace.programmatic.json"
        ))
        .unwrap();
        let chat = InteractionTrace::parse_json(include_str!(
            "../../../collab/contracts/fixtures/interaction-trace.chat.json"
        ))
        .unwrap();
        let comparison = compare_traces(&[programmatic, chat], None);
        assert!(comparison
            .shared_evidence
            .contains(&"ev-demo-checkout-log".into()));
        assert!(comparison.question_paths.len() > 1);
        assert!(comparison
            .notes
            .iter()
            .any(|note| note == TEXTUAL_SIMILARITY_NOT_WINNER));
        assert!(comparison.gold_convergence.is_empty());
    }
}
