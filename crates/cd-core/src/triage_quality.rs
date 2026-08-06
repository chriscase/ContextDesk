//! Hermetic broad-triage quality contract and structured rubric.
//!
//! This module is the **host-side** interpretation quality surface. It does
//! **not** replace citation-identity grounding (`linked_grounded_answer_is_valid`),
//! which only verifies that cited `seq`/`source` pairs exist in bounded
//! evidence. Rubric scoring uses evaluator-only known-answer keys that must
//! never be injected into model context.
//!
//! Scripted answers prove plumbing and rejection behavior only — never model
//! reasoning quality. Live-provider scoring is intentionally outside this
//! hermetic acceptance surface.

use crate::log_analysis::SearchEvidenceIdentity;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Characters reserved so a broad-triage model context cannot pack to the
/// hard budget ceiling. Near-ceiling packing (e.g. 119_900 / 120_000) is not
/// success: generation and honest uncertainty need useful headroom.
pub const BROAD_TRIAGE_CONTEXT_HEADROOM_CHARS: usize = 12_000;

/// Minimum headroom ratio of the turn budget that must remain free after packing
/// the broad-triage synthesis request (0.0–1.0).
pub const BROAD_TRIAGE_MIN_HEADROOM_RATIO: f64 = 0.08;

/// Observations section label for structured triage answers.
pub const SECTION_OBSERVATIONS: &str = "observations";
/// Causal candidates section label for structured triage answers.
pub const SECTION_CAUSAL_CANDIDATES: &str = "causal_candidates";
/// Competing explanations section label for structured triage answers.
pub const SECTION_COMPETING_EXPLANATIONS: &str = "competing_explanations";
/// Confidence section label for structured triage answers.
pub const SECTION_CONFIDENCE: &str = "confidence";
/// Missing/next evidence section label for structured triage answers.
pub const SECTION_MISSING_OR_NEXT_EVIDENCE: &str = "missing_or_next_evidence";

/// Canonical ordered section names required by the synthesis contract.
pub const TRIAGE_ANSWER_SECTIONS: [&str; 5] = [
    SECTION_OBSERVATIONS,
    SECTION_CAUSAL_CANDIDATES,
    SECTION_COMPETING_EXPLANATIONS,
    SECTION_CONFIDENCE,
    SECTION_MISSING_OR_NEXT_EVIDENCE,
];

/// Host-authored model-facing synthesis contract text (shared by staged and
/// deepening broad-triage synthesis hints).
pub fn triage_answer_contract_system_text() -> &'static str {
    "STRUCTURED TRIAGE ANSWER CONTRACT (required):\n\
     Answer with these explicit sections in order (markdown headings or JSON keys):\n\
     1) observations — only host-returned facts (counts, levels, sources, cited seq/source pairs).\n\
     2) causal_candidates — plausible triggers supported by evidence; do not equate earliest error with root cause.\n\
     3) competing_explanations — alternate readings and why they remain open.\n\
     4) confidence — high|medium|low with a one-line reason; order-only/mixed time cannot support high cross-source chronology confidence.\n\
     5) missing_or_next_evidence — sources, configs, or reads still needed; if root cause is not establishable, say so explicitly.\n\
     HARD RULES: never invent event counts; never claim every event is an error unless host level facets prove it; \
     never render ingest-order axis values as wall-clock calendar time; never claim a missing/omitted source was observed; \
     never treat the earliest ERROR alone as proven root cause. ContextDesk verifies citation identities only — not interpretation."
}

/// Max sources enumerated in the brief interpretation contract when the source
/// set is small enough that listing does not threaten the hard brief ceiling.
const BRIEF_SOURCE_LIST_CAP: usize = 8;
/// Skip per-source listing when the facet set is large (Top distributions already ranks them).
const BRIEF_SOURCE_LIST_MAX_FACETS: usize = 16;

/// Host-authored brief section reminding the model how to interpret deterministic evidence.
///
/// Kept compact so large corpora still fit under [`crate::tool_host::BROAD_LOG_TRIAGE_BRIEF_MAX_BYTES`].
pub fn triage_interpretation_brief_guardrails(
    sources: &[String],
    time_quality_label: &str,
    exact_unsuppressed_event_count: u64,
    error_event_count_if_known: Option<u64>,
) -> String {
    let mut out = String::from(
        "## Interpretation contract (host)\n\
rules: earliest_error_is_not_root_cause; primary_incident_is_not_proven_cause; \
axis_value_is_not_always_wall_clock; inventing_counts_forbidden; \
all_events_are_errors_only_if_level_facets_prove_it; missing_sources_disclose_not_fabricate\n\
answer_sections_required: observations,causal_candidates,competing_explanations,confidence,missing_or_next_evidence\n",
    );
    out.push_str(&format!(
        "time_quality: {time_quality_label}\n\
exact_unsuppressed_event_count: {exact_unsuppressed_event_count}\n"
    ));
    if let Some(errors) = error_event_count_if_known {
        out.push_str(&format!("exact_error_or_fatal_event_count: {errors}\n"));
        if errors < exact_unsuppressed_event_count {
            out.push_str("level_honesty: not_all_events_are_errors\n");
        }
    }
    out.push_str(&format!("sources_present_count: {}\n", sources.len()));
    // Large source sets are already ranked under Top distributions; re-listing
    // long identities here would only risk the global brief byte ceiling.
    if sources.len() <= BRIEF_SOURCE_LIST_MAX_FACETS {
        for source in sources.iter().take(BRIEF_SOURCE_LIST_CAP) {
            let bounded = if source.len() > 96 {
                format!("{}…", crate::text::truncate_bytes(source, 90))
            } else {
                source.clone()
            };
            let line = serde_json::to_string(&bounded).unwrap_or_else(|_| "\"<invalid>\"".into());
            out.push_str(&format!("- source_present={line}\n"));
        }
        if sources.len() > BRIEF_SOURCE_LIST_CAP {
            out.push_str(&format!(
                "sources_present_omitted_from_list: {}\n",
                sources.len() - BRIEF_SOURCE_LIST_CAP
            ));
        }
    } else {
        out.push_str(
            "sources_present_list: see_top_distributions_source_facet (too_many_to_relist)\n",
        );
    }
    out
}

/// Effective packing budget after reserving broad-triage headroom.
pub fn broad_triage_packing_budget(char_budget: usize) -> usize {
    let proportional = char_budget / 10;
    let reservation = BROAD_TRIAGE_CONTEXT_HEADROOM_CHARS.min(proportional);
    char_budget.saturating_sub(reservation)
}

/// Whether measured usage leaves useful headroom relative to the hard budget.
pub fn has_useful_context_headroom(used_chars: usize, budget_chars: usize) -> bool {
    if budget_chars == 0 || used_chars > budget_chars {
        return false;
    }
    let free = budget_chars.saturating_sub(used_chars);
    let ratio = free as f64 / budget_chars as f64;
    free >= BROAD_TRIAGE_CONTEXT_HEADROOM_CHARS.min(budget_chars / 10)
        || ratio + f64::EPSILON >= BROAD_TRIAGE_MIN_HEADROOM_RATIO
}

/// Evaluator-only known-answer key for one adversarial corpus case.
///
/// Must never be attached to model context.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TriageKnownAnswerKey {
    /// Stable case id.
    pub case_id: String,
    /// Expected host time quality label (`wall`, `mixed`, `order_only`).
    pub time_quality_expected: String,
    /// Source identities present in the import.
    pub sources_present: Vec<String>,
    /// Source identities deliberately omitted from the import.
    #[serde(default)]
    pub sources_omitted: Vec<String>,
    /// Message token that identifies a decoy earliest error, when present.
    #[serde(default)]
    pub decoy_earliest_error_message_token: Option<String>,
    /// Message token that identifies the true causal trigger, when establishable.
    #[serde(default)]
    pub true_trigger_message_token: Option<String>,
    /// Tokens that identify downstream symptoms (not causes).
    #[serde(default)]
    pub symptom_message_tokens: Vec<String>,
    /// Whether the imported evidence is sufficient to establish root cause.
    pub root_cause_establishable: bool,
    /// Claims that must not appear as true in a scoring answer.
    #[serde(default)]
    pub forbidden_claims: Vec<String>,
    /// Disclosures that a high-quality answer must include.
    #[serde(default)]
    pub required_disclosures: Vec<String>,
}

/// One citeable observation or causal claim in a structured answer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct TriageClaim {
    /// Free-text claim body.
    #[serde(default)]
    pub text: String,
    /// Optional cited event sequence.
    #[serde(default)]
    pub seq: Option<u64>,
    /// Optional cited source identity.
    #[serde(default)]
    pub source: Option<String>,
    /// Optional role: observation | symptom | trigger | noise | other.
    #[serde(default)]
    pub role: Option<String>,
}

/// Structured model-facing triage answer (JSON form of the contract).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct StructuredTriageAnswer {
    /// Observations grounded in host evidence.
    #[serde(default)]
    pub observations: Vec<TriageClaim>,
    /// Causal candidates (not proven root cause by default).
    #[serde(default)]
    pub causal_candidates: Vec<TriageClaim>,
    /// Competing explanations still open.
    #[serde(default)]
    pub competing_explanations: Vec<String>,
    /// Confidence label: high | medium | low.
    #[serde(default)]
    pub confidence: String,
    /// One-line confidence reason.
    #[serde(default)]
    pub confidence_reason: String,
    /// Missing or next evidence disclosures.
    #[serde(default)]
    pub missing_or_next_evidence: Vec<String>,
    /// Optional asserted event count (mutation surface).
    #[serde(default)]
    pub asserted_event_count: Option<u64>,
    /// Optional assertion that every event is an error (mutation surface).
    #[serde(default)]
    pub asserts_all_events_are_errors: bool,
    /// Optional assertion that earliest error is the root cause (mutation).
    #[serde(default)]
    pub asserts_earliest_error_is_root_cause: bool,
    /// Optional assertion that an omitted source was observed (mutation).
    #[serde(default)]
    pub asserts_observed_sources: Vec<String>,
    /// Optional assertion of confident wall-clock cross-source order (mutation).
    #[serde(default)]
    pub asserts_confident_wall_clock_order: bool,
    /// Optional claim that root cause is established.
    #[serde(default)]
    pub asserts_root_cause_established: bool,
}

impl StructuredTriageAnswer {
    /// Render as markdown sections for scripted model text paths.
    pub fn to_markdown(&self) -> String {
        let mut out = String::new();
        out.push_str("## observations\n");
        for claim in &self.observations {
            out.push_str(&format_claim_line(claim));
        }
        out.push_str("## causal_candidates\n");
        for claim in &self.causal_candidates {
            out.push_str(&format_claim_line(claim));
        }
        out.push_str("## competing_explanations\n");
        for line in &self.competing_explanations {
            out.push_str(&format!("- {line}\n"));
        }
        out.push_str(&format!(
            "## confidence\n{} — {}\n",
            self.confidence, self.confidence_reason
        ));
        out.push_str("## missing_or_next_evidence\n");
        for line in &self.missing_or_next_evidence {
            out.push_str(&format!("- {line}\n"));
        }
        if self.asserts_all_events_are_errors {
            out.push_str("\nAll events in this corpus are errors.\n");
        }
        if self.asserts_earliest_error_is_root_cause {
            out.push_str("\nThe earliest error is the root cause.\n");
        }
        if self.asserts_root_cause_established {
            out.push_str("\nRoot cause is established.\n");
        }
        if self.asserts_confident_wall_clock_order {
            out.push_str("\nCross-source wall-clock order is confidently known.\n");
        }
        if let Some(count) = self.asserted_event_count {
            out.push_str(&format!("\nTotal events: {count}.\n"));
        }
        for source in &self.asserts_observed_sources {
            out.push_str(&format!(
                "\nObserved source {source} in the imported evidence.\n"
            ));
        }
        out
    }
}

fn format_claim_line(claim: &TriageClaim) -> String {
    let mut line = format!("- {}", claim.text);
    if let (Some(seq), Some(source)) = (claim.seq, claim.source.as_ref()) {
        line.push_str(&format!(" seq={seq} source=\"{source}\""));
    }
    if let Some(role) = &claim.role {
        line.push_str(&format!(" role={role}"));
    }
    line.push('\n');
    line
}

/// Parse the model's terminal answer into the structured rubric shape.
///
/// The parser accepts either the documented JSON object or the markdown emitted
/// by [`StructuredTriageAnswer::to_markdown`]. Missing sections remain empty so
/// the rubric, rather than the parser, reports the contract failure.
pub fn parse_structured_triage_answer(text: &str) -> Result<StructuredTriageAnswer, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("terminal answer is empty".into());
    }
    if let Ok(answer) = serde_json::from_str::<StructuredTriageAnswer>(trimmed) {
        return Ok(derive_boolean_assertions(answer, trimmed));
    }
    if let Some(fenced) = trimmed
        .strip_prefix("```json")
        .and_then(|value| value.strip_suffix("```"))
    {
        if let Ok(answer) = serde_json::from_str::<StructuredTriageAnswer>(fenced.trim()) {
            return Ok(derive_boolean_assertions(answer, fenced));
        }
    }

    let mut answer = StructuredTriageAnswer::default();
    let mut section = String::new();
    for raw in trimmed.lines() {
        let line = raw.trim();
        if line.is_empty() || line == "```" || line.eq_ignore_ascii_case("```json") {
            continue;
        }
        let assertion = normalize_assertion_text(line);
        if is_positive_all_events_error_claim(&assertion) {
            answer.asserts_all_events_are_errors = true;
            continue;
        }
        if is_positive_earliest_error_root_claim(&assertion) {
            answer.asserts_earliest_error_is_root_cause = true;
            continue;
        }
        if text_has_unnegated_phrase(&assertion, &["root cause is established"]) {
            answer.asserts_root_cause_established = true;
            continue;
        }
        if text_has_unnegated_phrase(
            &assertion,
            &["cross source wall clock order is confidently known"],
        ) {
            answer.asserts_confident_wall_clock_order = true;
            continue;
        }
        if let Some(count) = assertion
            .strip_prefix("total events:")
            .and_then(|v| v.trim().trim_end_matches('.').parse::<u64>().ok())
        {
            answer.asserted_event_count = Some(count);
            continue;
        }
        if assertion.starts_with("observed source ")
            && assertion.ends_with(" in the imported evidence")
            && text_has_unnegated_phrase(&assertion, &["observed source "])
        {
            let source = assertion
                .strip_prefix("observed source ")
                .and_then(|value| value.strip_suffix(" in the imported evidence"))
                .unwrap_or_default();
            answer.asserts_observed_sources.push(source.to_string());
            continue;
        }

        if let Some(heading) = line.strip_prefix('#') {
            section = heading
                .trim_start_matches('#')
                .trim()
                .to_ascii_lowercase()
                .replace([' ', '-'], "_");
            continue;
        }

        match section.as_str() {
            SECTION_OBSERVATIONS => answer.observations.push(parse_claim_line(line)),
            SECTION_CAUSAL_CANDIDATES => {
                answer.causal_candidates.push(parse_claim_line(line));
            }
            SECTION_COMPETING_EXPLANATIONS => {
                answer
                    .competing_explanations
                    .push(strip_bullet(line).to_string());
            }
            SECTION_CONFIDENCE => {
                let value = strip_bullet(line);
                let (label, reason) = value
                    .split_once('—')
                    .or_else(|| value.split_once(" - "))
                    .unwrap_or((value, ""));
                answer.confidence = label.trim().to_string();
                answer.confidence_reason = reason.trim().to_string();
            }
            SECTION_MISSING_OR_NEXT_EVIDENCE => {
                answer
                    .missing_or_next_evidence
                    .push(strip_bullet(line).to_string());
            }
            _ => {}
        }
    }
    Ok(derive_boolean_assertions(answer, trimmed))
}

fn derive_boolean_assertions(
    mut answer: StructuredTriageAnswer,
    model_text: &str,
) -> StructuredTriageAnswer {
    // These booleans are evaluator state, never model authority. JSON may carry
    // the fields for round-trip compatibility, but only textual claims set them.
    answer.asserts_all_events_are_errors = false;
    answer.asserts_earliest_error_is_root_cause = false;
    answer.asserts_confident_wall_clock_order = false;
    answer.asserts_root_cause_established = false;

    let mut texts = model_text.lines().map(str::to_string).collect::<Vec<_>>();
    texts.extend(
        answer
            .observations
            .iter()
            .chain(answer.causal_candidates.iter())
            .map(|claim| claim.text.clone()),
    );
    for text in texts {
        let assertion = normalize_assertion_text(&text);
        if is_positive_all_events_error_claim(&assertion) {
            answer.asserts_all_events_are_errors = true;
        }
        if is_positive_earliest_error_root_claim(&assertion) {
            answer.asserts_earliest_error_is_root_cause = true;
        }
        if text_has_unnegated_phrase(&assertion, &["root cause is established"]) {
            answer.asserts_root_cause_established = true;
        }
        if text_has_unnegated_phrase(
            &assertion,
            &["cross source wall clock order is confidently known"],
        ) {
            answer.asserts_confident_wall_clock_order = true;
        }
    }
    answer
}

fn strip_bullet(line: &str) -> &str {
    line.strip_prefix("- ").unwrap_or(line).trim()
}

fn normalize_assertion_text(line: &str) -> String {
    let mut unwrapped = line.trim().trim_start_matches('#').trim();
    loop {
        let next = ["- ", "* ", "+ ", "> "]
            .iter()
            .find_map(|prefix| unwrapped.strip_prefix(prefix))
            .unwrap_or(unwrapped)
            .trim();
        if next.len() == unwrapped.len() {
            break;
        }
        unwrapped = next;
    }
    let unwrapped = unwrapped.trim_matches(|ch: char| matches!(ch, '*' | '_' | '`'));
    unwrapped
        .chars()
        .map(|ch| match ch {
            '-' | '–' | '—' => ' ',
            other => other.to_ascii_lowercase(),
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch: char| matches!(ch, '.' | '!' | '?' | ':' | ';' | ','))
        .to_string()
}

fn phrase_is_negated(text: &str, phrase_at: usize) -> bool {
    let prefix = text.get(..phrase_at).unwrap_or_default();
    let punctuation_boundary = prefix
        .char_indices()
        .rev()
        .find(|(_, ch)| matches!(ch, '.' | '!' | '?' | ';'))
        .map_or(0, |(idx, ch)| idx + ch.len_utf8());
    let contrast_boundary = [", but ", ", yet ", " however ", " actually "]
        .iter()
        .filter_map(|marker| prefix.rfind(marker).map(|idx| idx + marker.len()))
        .max()
        .unwrap_or(0);
    let boundary = punctuation_boundary.max(contrast_boundary);
    let scope = prefix.get(boundary..).unwrap_or(prefix);
    [
        "not ",
        "no evidence",
        "cannot ",
        "can't ",
        "could not ",
        "does not ",
        "do not ",
        "is not ",
        "isn't ",
        "unsupported",
        "unproven",
        "wrong to say",
        "wrong to claim",
        "wrong to conclude",
        "incorrect to say",
        "incorrect to claim",
        "would be wrong",
        "would be incorrect",
        "must not claim",
        "should not say",
    ]
    .iter()
    .any(|marker| scope.contains(marker))
}

fn text_has_unnegated_phrase(text: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|phrase| {
        text.match_indices(phrase)
            .any(|(idx, _)| !phrase_is_negated(text, idx))
    })
}

fn is_positive_all_events_error_claim(text: &str) -> bool {
    text_has_unnegated_phrase(
        text,
        &[
            "all events in this corpus are errors",
            "all events in the corpus are errors",
            "every event in this corpus is an error",
            "every event in the corpus is an error",
            "the corpus contains only error events",
            "the corpus consists only of error events",
        ],
    )
}

fn is_positive_earliest_error_root_claim(text: &str) -> bool {
    text_has_unnegated_phrase(
        text,
        &[
            "the earliest error is the root cause",
            "the first error is the root cause",
            "earliest observed error is the root cause",
        ],
    )
}

fn parse_claim_line(line: &str) -> TriageClaim {
    let line = strip_bullet(line);
    let seq_marker = line.rfind(" seq=");
    let source_marker = line.rfind(" source=\"");
    let role_marker = line.rfind(" role=");
    let first_meta = [seq_marker, source_marker, role_marker]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(line.len());
    let seq = seq_marker.and_then(|idx| {
        line.get(idx + " seq=".len()..)?
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()
    });
    let source = source_marker.and_then(|idx| {
        let rest = line.get(idx + " source=\"".len()..)?;
        let end = rest.find('"')?;
        Some(rest.get(..end)?.to_string())
    });
    let role = role_marker.and_then(|idx| {
        line.get(idx + " role=".len()..)?
            .split_whitespace()
            .next()
            .map(ToString::to_string)
    });
    TriageClaim {
        text: line
            .get(..first_meta)
            .unwrap_or_default()
            .trim()
            .to_string(),
        seq,
        source,
        role,
    }
}

/// Per-dimension rubric outcome.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RubricDimension {
    /// Dimension id.
    pub id: String,
    /// Whether this dimension passed.
    pub passed: bool,
    /// Short machine-readable reason.
    pub reason: String,
}

/// Full structured rubric score for one answer against a known key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TriageRubricScore {
    /// Case under evaluation.
    pub case_id: String,
    /// Overall pass (all critical dimensions).
    pub passed: bool,
    /// Dimension results.
    pub dimensions: Vec<RubricDimension>,
}

impl TriageRubricScore {
    /// Dimension ids that failed.
    pub fn failed_ids(&self) -> Vec<&str> {
        self.dimensions
            .iter()
            .filter(|d| !d.passed)
            .map(|d| d.id.as_str())
            .collect()
    }
}

/// Host facts available at scoring time (from import + brief, not the key alone).
#[derive(Debug, Clone, Default)]
pub struct TriageHostFacts {
    /// Time quality label from the brief/corpus.
    pub time_quality: String,
    /// Exact unsuppressed event count.
    pub exact_event_count: u64,
    /// Exact error/fatal count when known.
    pub exact_error_count: Option<u64>,
    /// Sources present in the corpus.
    pub sources_present: BTreeSet<String>,
    /// Trusted citeable identities from the brief.
    pub evidence: Vec<SearchEvidenceIdentity>,
    /// Event messages keyed by seq for token matching (evaluator-only).
    pub messages_by_seq: Vec<(u64, String, String)>, // seq, source, message
}

/// Score a structured answer against host facts + known-answer key.
///
/// Prefer claim/citation relationships and host counters over phrase matching.
/// Phrase tokens from the key are used only to bind host events to roles.
pub fn score_structured_triage_answer(
    answer: &StructuredTriageAnswer,
    key: &TriageKnownAnswerKey,
    host: &TriageHostFacts,
) -> TriageRubricScore {
    let mut dimensions = Vec::new();

    // 1) Contract shape
    let contract_ok = !answer.observations.is_empty()
        && !answer.causal_candidates.is_empty()
        && !answer.competing_explanations.is_empty()
        && !answer.confidence.trim().is_empty()
        && !answer.confidence_reason.trim().is_empty()
        && !answer.missing_or_next_evidence.is_empty();
    dimensions.push(RubricDimension {
        id: "contract_shape".into(),
        passed: contract_ok,
        reason: if contract_ok {
            "required sections populated".into()
        } else {
            "missing required structured sections".into()
        },
    });

    // 2) Citation validity (identities must exist when claimed)
    let evidence_set: BTreeSet<(u64, String)> = host
        .evidence
        .iter()
        .map(|e| (e.seq, e.source.clone()))
        .collect();
    let mut citation_ok = true;
    for claim in &answer.observations {
        match (claim.seq, claim.source.as_ref()) {
            (Some(seq), Some(source)) if evidence_set.contains(&(seq, source.clone())) => {}
            (None, None) if observation_is_explicitly_non_material(claim) => {}
            _ => {
                citation_ok = false;
                break;
            }
        }
    }
    if citation_ok {
        for claim in &answer.causal_candidates {
            match (claim.seq, claim.source.as_ref()) {
                (Some(seq), Some(source)) if evidence_set.contains(&(seq, source.clone())) => {}
                (None, None) if causal_claim_is_explicitly_non_material(claim) => {}
                _ => {
                    citation_ok = false;
                    break;
                }
            }
        }
    }
    dimensions.push(RubricDimension {
        id: "citation_validity".into(),
        passed: citation_ok,
        reason: if citation_ok {
            "cited identities exist in host evidence".into()
        } else {
            "answer cites unknown seq/source pairs".into()
        },
    });

    // 3) Trigger identification (when establishable)
    let trigger_seq = key
        .true_trigger_message_token
        .as_ref()
        .and_then(|token| find_token_seq(host, token));
    let decoy_seq = key
        .decoy_earliest_error_message_token
        .as_ref()
        .and_then(|token| find_token_seq(host, token));
    let trigger_cited = trigger_seq.is_some_and(|(seq, source)| {
        answer.causal_candidates.iter().any(|c| {
            c.seq == Some(seq)
                && c.source.as_deref() == Some(source.as_str())
                && c.role.as_deref() != Some("symptom")
        })
    });
    let trigger_ok = if key.root_cause_establishable {
        trigger_cited
    } else {
        // Must not assert a proven root cause when none is establishable.
        !answer.asserts_root_cause_established
            && answer
                .missing_or_next_evidence
                .iter()
                .any(|line| !line.trim().is_empty())
    };
    dimensions.push(RubricDimension {
        id: "trigger_identification".into(),
        passed: trigger_ok,
        reason: if key.root_cause_establishable {
            if trigger_ok {
                "true trigger cited as causal candidate".into()
            } else {
                "true trigger not identified among causal candidates".into()
            }
        } else if trigger_ok {
            "honest non-establishment with missing/next evidence".into()
        } else {
            "claimed established root cause without sufficient evidence".into()
        },
    });

    // 4) Symptom vs cause separation
    let symptom_as_sole_cause = key.symptom_message_tokens.iter().any(|token| {
        find_token_seq(host, token).is_some_and(|(seq, source)| {
            answer.causal_candidates.iter().any(|c| {
                c.seq == Some(seq)
                    && c.source.as_deref() == Some(source.as_str())
                    && answer.causal_candidates.len() == 1
                    && c.role.as_deref() != Some("symptom")
            })
        })
    });
    let earliest_as_root = answer.asserts_earliest_error_is_root_cause
        && (decoy_seq.is_some()
            || answer.causal_candidates.iter().any(|c| {
                decoy_seq.as_ref().is_some_and(|(seq, source)| {
                    c.seq == Some(*seq)
                        && c.source.as_deref() == Some(source.as_str())
                        && c.role.as_deref() == Some("trigger")
                })
            }));
    let separation_ok = !symptom_as_sole_cause && !earliest_as_root;
    dimensions.push(RubricDimension {
        id: "symptom_vs_cause".into(),
        passed: separation_ok,
        reason: if separation_ok {
            "symptoms not presented as sole proven cause; earliest≠root".into()
        } else {
            "symptom/decoy treated as proven root cause".into()
        },
    });

    // 5) Chronology honesty
    let order_only = host.time_quality == "order_only"
        || key.time_quality_expected == "order_only"
        || host.time_quality == "OrderOnly";
    let chronology_ok = if order_only {
        !answer.asserts_confident_wall_clock_order
            && !matches!(answer.confidence.to_ascii_lowercase().as_str(), "high")
    } else {
        !answer.asserts_confident_wall_clock_order
            || host.time_quality == "wall"
            || host.time_quality == "Wall"
    };
    dimensions.push(RubricDimension {
        id: "chronology_honesty".into(),
        passed: chronology_ok,
        reason: if chronology_ok {
            "chronology claims respect time quality".into()
        } else {
            "fabricated wall-clock cross-source order under order-only/ambiguous time".into()
        },
    });

    // 6) Unsupported claims (counts, all-errors, omitted sources)
    let mut unsupported = false;
    let mut reasons = Vec::new();
    if answer.asserts_all_events_are_errors {
        let all_errors = host
            .exact_error_count
            .is_some_and(|errors| errors == host.exact_event_count && host.exact_event_count > 0);
        if !all_errors {
            unsupported = true;
            reasons.push("all_events_are_errors");
        }
    }
    if let Some(asserted) = answer.asserted_event_count {
        if asserted != host.exact_event_count {
            unsupported = true;
            reasons.push("fabricated_event_count");
        }
    }
    for claimed in &answer.asserts_observed_sources {
        if !host.sources_present.contains(claimed)
            && key.sources_omitted.iter().any(|s| s == claimed)
        {
            unsupported = true;
            reasons.push("observed_omitted_source");
            break;
        }
        if !host.sources_present.contains(claimed)
            && !key.sources_present.iter().any(|s| s == claimed)
        {
            unsupported = true;
            reasons.push("observed_unknown_source");
            break;
        }
    }
    if answer.asserts_root_cause_established && !key.root_cause_establishable {
        unsupported = true;
        reasons.push("root_cause_established_without_evidence");
    }
    for claim in &key.forbidden_claims {
        match claim.as_str() {
            "all_events_are_errors" if answer.asserts_all_events_are_errors => {
                unsupported = true;
                reasons.push("forbidden:all_events_are_errors");
            }
            "earliest_error_is_root_cause" if answer.asserts_earliest_error_is_root_cause => {
                unsupported = true;
                reasons.push("forbidden:earliest_error_is_root_cause");
            }
            "observed_omitted_source"
                if answer
                    .asserts_observed_sources
                    .iter()
                    .any(|s| key.sources_omitted.iter().any(|o| o == s)) =>
            {
                unsupported = true;
                reasons.push("forbidden:observed_omitted_source");
            }
            "root_cause_established" if answer.asserts_root_cause_established => {
                unsupported = true;
                reasons.push("forbidden:root_cause_established");
            }
            "confident_cross_source_wall_clock_order"
                if answer.asserts_confident_wall_clock_order =>
            {
                unsupported = true;
                reasons.push("forbidden:confident_wall_clock_order");
            }
            _ => {}
        }
    }
    dimensions.push(RubricDimension {
        id: "unsupported_claims".into(),
        passed: !unsupported,
        reason: if unsupported {
            reasons.join(",")
        } else {
            "no unsupported host-contradicted claims".into()
        },
    });

    // 7) Honest uncertainty / required disclosures
    let blob = answer_text_blob(answer).to_ascii_lowercase();
    let mut disclosure_ok = true;
    let mut missing = Vec::new();
    for required in &key.required_disclosures {
        let present = match required.as_str() {
            "missing_root_evidence" => {
                !answer.missing_or_next_evidence.is_empty()
                    || blob.contains("missing")
                    || blob.contains("not present")
                    || blob.contains("insufficient")
            }
            "next_evidence_needed" => !answer.missing_or_next_evidence.is_empty(),
            "order_only_or_ambiguous_time" => {
                blob.contains("order")
                    || blob.contains("ambiguous")
                    || blob.contains("ingest")
                    || answer.confidence.eq_ignore_ascii_case("low")
                    || answer.confidence.eq_ignore_ascii_case("medium")
            }
            "competing_explanations" => !answer.competing_explanations.is_empty(),
            other => blob.contains(&other.replace('_', " ")),
        };
        if !present {
            disclosure_ok = false;
            missing.push(required.clone());
        }
    }
    if !key.root_cause_establishable && answer.confidence.eq_ignore_ascii_case("high") {
        disclosure_ok = false;
        missing.push("overconfident_without_establishable_cause".into());
    }
    dimensions.push(RubricDimension {
        id: "honest_uncertainty".into(),
        passed: disclosure_ok,
        reason: if disclosure_ok {
            "required uncertainty/missing-evidence disclosures present".into()
        } else {
            format!("missing disclosures: {}", missing.join(","))
        },
    });

    let passed = dimensions.iter().all(|d| d.passed);
    TriageRubricScore {
        case_id: key.case_id.clone(),
        passed,
        dimensions,
    }
}

fn observation_is_explicitly_non_material(claim: &TriageClaim) -> bool {
    let text = normalize_assertion_text(&claim.text);
    [
        "zero unsuppressed events",
        "no unsuppressed events",
        "no event evidence is available",
        "no events were returned",
    ]
    .iter()
    .any(|disclosure| text.contains(disclosure))
}

fn causal_claim_is_explicitly_non_material(claim: &TriageClaim) -> bool {
    let text = normalize_assertion_text(&claim.text);
    [
        "no establishable trigger",
        "no causal candidate can be established",
        "root cause is not establishable",
        "insufficient evidence to identify a causal candidate",
        "zero unsuppressed events",
    ]
    .iter()
    .any(|disclosure| text.contains(disclosure))
}

fn find_token_seq(host: &TriageHostFacts, token: &str) -> Option<(u64, String)> {
    host.messages_by_seq
        .iter()
        .find_map(|(seq, source, message)| {
            if message.contains(token) {
                Some((*seq, source.clone()))
            } else {
                None
            }
        })
}

fn answer_text_blob(answer: &StructuredTriageAnswer) -> String {
    let mut parts = Vec::new();
    for c in answer
        .observations
        .iter()
        .chain(answer.causal_candidates.iter())
    {
        parts.push(c.text.clone());
    }
    parts.extend(answer.competing_explanations.iter().cloned());
    parts.push(answer.confidence_reason.clone());
    parts.extend(answer.missing_or_next_evidence.iter().cloned());
    parts.join("\n")
}

/// Build adversarial mutations that must fail the rubric for the right reasons.
pub fn mutation_all_events_are_errors(base: &StructuredTriageAnswer) -> StructuredTriageAnswer {
    let mut m = base.clone();
    m.asserts_all_events_are_errors = true;
    m
}

/// Mutation: earliest error equated with root cause.
pub fn mutation_earliest_is_root_cause(base: &StructuredTriageAnswer) -> StructuredTriageAnswer {
    let mut m = base.clone();
    m.asserts_earliest_error_is_root_cause = true;
    m.asserts_root_cause_established = true;
    m.confidence = "high".into();
    m
}

/// Mutation: fabricated event count.
pub fn mutation_fabricated_count(
    base: &StructuredTriageAnswer,
    wrong_count: u64,
) -> StructuredTriageAnswer {
    let mut m = base.clone();
    m.asserted_event_count = Some(wrong_count);
    m
}

/// Mutation: claim omitted source was observed.
pub fn mutation_observed_missing_source(
    base: &StructuredTriageAnswer,
    omitted: &str,
) -> StructuredTriageAnswer {
    let mut m = base.clone();
    m.asserts_observed_sources.push(omitted.to_string());
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_key() -> TriageKnownAnswerKey {
        TriageKnownAnswerKey {
            case_id: "unit".into(),
            time_quality_expected: "wall".into(),
            sources_present: vec!["app/worker.jsonl".into()],
            sources_omitted: vec!["config/flags.jsonl".into()],
            decoy_earliest_error_message_token: Some("decoy".into()),
            true_trigger_message_token: Some("causal trigger".into()),
            symptom_message_tokens: vec!["downstream symptom".into()],
            root_cause_establishable: true,
            forbidden_claims: vec![
                "all_events_are_errors".into(),
                "earliest_error_is_root_cause".into(),
                "observed_omitted_source".into(),
            ],
            required_disclosures: vec![],
        }
    }

    fn sample_host() -> TriageHostFacts {
        TriageHostFacts {
            time_quality: "wall".into(),
            exact_event_count: 5,
            exact_error_count: Some(3),
            sources_present: BTreeSet::from(["app/worker.jsonl".into()]),
            evidence: vec![
                SearchEvidenceIdentity {
                    seq: 1,
                    source: "app/worker.jsonl".into(),
                    citation_source: None,
                    template_id: 1,
                },
                SearchEvidenceIdentity {
                    seq: 2,
                    source: "app/worker.jsonl".into(),
                    citation_source: None,
                    template_id: 2,
                },
                SearchEvidenceIdentity {
                    seq: 3,
                    source: "app/worker.jsonl".into(),
                    citation_source: None,
                    template_id: 3,
                },
            ],
            messages_by_seq: vec![
                (1, "app/worker.jsonl".into(), "decoy early".into()),
                (
                    2,
                    "app/worker.jsonl".into(),
                    "causal trigger lease refused".into(),
                ),
                (
                    3,
                    "app/worker.jsonl".into(),
                    "downstream symptom task failed".into(),
                ),
            ],
        }
    }

    fn good_answer() -> StructuredTriageAnswer {
        StructuredTriageAnswer {
            observations: vec![TriageClaim {
                text: "Host reports 5 unsuppressed events with mixed levels".into(),
                seq: Some(2),
                source: Some("app/worker.jsonl".into()),
                role: Some("observation".into()),
            }],
            causal_candidates: vec![TriageClaim {
                text: "resource lease refused".into(),
                seq: Some(2),
                source: Some("app/worker.jsonl".into()),
                role: Some("trigger".into()),
            }],
            competing_explanations: vec![
                "Early decoy error is noise, not the batch failure trigger".into(),
            ],
            confidence: "medium".into(),
            confidence_reason: "trigger is cited; residual retry path open".into(),
            missing_or_next_evidence: vec!["pool quota configuration for compute".into()],
            asserted_event_count: Some(5),
            ..Default::default()
        }
    }

    #[test]
    fn packing_budget_reserves_headroom() {
        let budget = 120_000;
        let pack = broad_triage_packing_budget(budget);
        assert_eq!(pack, budget - BROAD_TRIAGE_CONTEXT_HEADROOM_CHARS);
        assert!(has_useful_context_headroom(pack, budget));
        assert!(!has_useful_context_headroom(119_900, budget));

        let small_custom_budget = crate::model_context::MIN_CONTEXT_CHAR_BUDGET;
        let small_pack = broad_triage_packing_budget(small_custom_budget);
        assert_eq!(small_pack, small_custom_budget - small_custom_budget / 10);
        assert!(small_pack > 0);
        assert!(has_useful_context_headroom(small_pack, small_custom_budget));
    }

    #[test]
    fn good_answer_passes_rubric() {
        let score = score_structured_triage_answer(&good_answer(), &sample_key(), &sample_host());
        assert!(score.passed, "failed={:?}", score.failed_ids());
    }

    #[test]
    fn material_claims_need_citations_but_explicit_zero_evidence_does_not_invent_one() {
        let key = sample_key();
        let host = sample_host();
        let mut stripped = good_answer();
        stripped.observations[0].seq = None;
        stripped.observations[0].source = None;
        let score = score_structured_triage_answer(&stripped, &key, &host);
        assert!(score.failed_ids().contains(&"citation_validity"));

        stripped.observations[0].role = Some("zero_evidence".into());
        let score = score_structured_triage_answer(&stripped, &key, &host);
        assert!(score.failed_ids().contains(&"citation_validity"));

        stripped.observations[0].text = "Host reports zero unsuppressed events".into();
        let score = score_structured_triage_answer(&stripped, &key, &host);
        assert!(!score.failed_ids().contains(&"citation_validity"));

        let mut self_labelled = good_answer();
        self_labelled.causal_candidates[0].seq = None;
        self_labelled.causal_candidates[0].source = None;
        self_labelled.causal_candidates[0].role = Some("unknown".into());
        let score = score_structured_triage_answer(&self_labelled, &key, &host);
        assert!(score.failed_ids().contains(&"citation_validity"));
    }

    #[test]
    fn mutations_fail_for_the_right_dimension() {
        let base = good_answer();
        let key = sample_key();
        let host = sample_host();

        let all_err = mutation_all_events_are_errors(&base);
        let score = score_structured_triage_answer(&all_err, &key, &host);
        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"unsupported_claims"));

        let earliest = mutation_earliest_is_root_cause(&base);
        let score = score_structured_triage_answer(&earliest, &key, &host);
        assert!(!score.passed);
        assert!(
            score.failed_ids().contains(&"symptom_vs_cause")
                || score.failed_ids().contains(&"unsupported_claims")
        );

        let fab = mutation_fabricated_count(&base, 999);
        let score = score_structured_triage_answer(&fab, &key, &host);
        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"unsupported_claims"));
        assert!(score
            .dimensions
            .iter()
            .find(|d| d.id == "unsupported_claims")
            .is_some_and(|d| d.reason.contains("fabricated_event_count")));

        let missing = mutation_observed_missing_source(&base, "config/flags.jsonl");
        let score = score_structured_triage_answer(&missing, &key, &host);
        assert!(!score.passed);
        assert!(score.failed_ids().contains(&"unsupported_claims"));
    }

    #[test]
    fn contract_system_text_lists_required_sections() {
        let text = triage_answer_contract_system_text();
        for section in TRIAGE_ANSWER_SECTIONS {
            assert!(text.contains(section), "missing {section}");
        }
        assert!(text.contains("does not verify") || text.contains("citation identities only"));
    }
}
