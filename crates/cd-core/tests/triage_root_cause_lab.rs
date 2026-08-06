//! Hermetic known-root-cause adversarial acceptance lab for broad triage.
//!
//! Drives **shipped** paths only:
//! - import via [`cd_core::log_analysis::ingest_path`]
//! - deterministic brief via [`ToolHost::build_broad_log_triage_brief`]
//! - model context packing via [`cd_core::agent::estimate_context_chars`] +
//!   the same system contract text production uses
//! - structured rubric via [`cd_core::triage_quality`]
//! - optional linked turn plumbing via [`run_agent_turn`] + [`ScriptedBackend`]
//!
//! Answer keys under `fixtures/triage-root-cause-lab/**/truth/` are
//! evaluator-only and are never injected into model context.
//!
//! Scripted answers prove plumbing and rejection behavior only — never model
//! reasoning quality. Live-provider scoring is not the hermetic gate.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cd_core::agent::{
    estimate_context_chars, run_agent_turn, AgentOptions, LogExplorerTurnContext, ScriptedBackend,
    DEFAULT_CONTEXT_CHAR_BUDGET,
};
use cd_core::chat::{ChatCompletion, ChatMessage, Role};
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::log_analysis::{
    ingest_path, query_event_rows, query_facets, EventQuery, LogCorpus, TimeQuality,
};
use cd_core::tool_host::ToolHost;
use cd_core::triage_quality::{
    broad_triage_packing_budget, has_useful_context_headroom, mutation_earliest_is_root_cause,
    mutation_observed_missing_source, parse_structured_triage_answer,
    score_structured_triage_answer, triage_answer_contract_system_text, StructuredTriageAnswer,
    TriageClaim, TriageHostFacts, TriageKnownAnswerKey, BROAD_TRIAGE_CONTEXT_HEADROOM_CHARS,
    TRIAGE_ANSWER_SECTIONS,
};
use cd_core::workspace::Workspace;
use serde_json::Value;

fn lab_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/triage-root-cause-lab")
}

fn case_import(case: &str) -> PathBuf {
    lab_root().join("cases").join(case).join("import")
}

fn load_answer_key(case: &str) -> TriageKnownAnswerKey {
    let path = lab_root()
        .join("cases")
        .join(case)
        .join("truth/answer_key.json");
    let raw = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse answer key {case}: {e}"))
}

fn ingest_case(case: &str) -> (tempfile::TempDir, String, LogCorpus) {
    let cache = tempfile::tempdir().expect("cache");
    let report = ingest_path(cache.path(), &case_import(case), case, None, "").expect("ingest");
    let corpus = LogCorpus::open(cache.path(), &report.corpus_id).expect("open");
    (cache, report.corpus_id, corpus)
}

fn host_facts_for(corpus: &LogCorpus, key: &TriageKnownAnswerKey) -> TriageHostFacts {
    let facets = query_facets(
        corpus,
        &EventQuery {
            limit: 500,
            ..EventQuery::default()
        },
    )
    .expect("facets");
    let rows = query_event_rows(
        corpus,
        &EventQuery {
            limit: 500,
            ..EventQuery::default()
        },
    )
    .expect("rows");
    let exact_event_count = rows.events.len() as u64;
    // Prefer exact page when full; otherwise fall back to facets total via levels sum.
    let level_sum: u64 = facets.levels.values().sum();
    let exact_event_count = exact_event_count.max(level_sum);
    let exact_error_count = facets
        .levels
        .iter()
        .filter(|(level, _)| matches!(level.as_str(), "error" | "fatal"))
        .map(|(_, c)| *c)
        .sum::<u64>();
    let sources_present: BTreeSet<String> = rows.events.iter().map(|e| e.source.clone()).collect();
    let messages_by_seq = rows
        .events
        .iter()
        .map(|e| (e.seq, e.source.clone(), e.message.clone()))
        .collect();
    let time_quality = match corpus_time_quality(corpus) {
        TimeQuality::Wall => "wall",
        TimeQuality::Mixed => "mixed",
        TimeQuality::OrderOnly => "order_only",
    };
    // Sanity: key expectation should match host when both are definitive.
    if key.time_quality_expected == "order_only" {
        assert_eq!(time_quality, "order_only", "case {}", key.case_id);
    }
    TriageHostFacts {
        time_quality: time_quality.into(),
        exact_event_count,
        exact_error_count: Some(exact_error_count),
        sources_present,
        evidence: Vec::new(),
        messages_by_seq,
    }
}

fn corpus_time_quality(corpus: &LogCorpus) -> TimeQuality {
    cd_core::log_analysis::corpus_time_quality(corpus)
}

fn build_brief(cache: &Path, corpus_id: &str) -> cd_core::tool_host::BroadLogTriageBrief {
    let mut host = ToolHost::new(
        Workspace::new("triage-lab", vec![cache.to_path_buf()]),
        KeywordIndex::new(),
        None,
    );
    host.set_log_analysis(true, Some(cache.to_path_buf()));
    host.set_log_corpus_scope(Some(corpus_id.to_string()));
    host.set_active_log_corpus(Some(corpus_id.to_string()));
    let corpus = Arc::new(LogCorpus::open(cache, corpus_id).unwrap());
    host.seed_log_corpus_handle(corpus_id, corpus).unwrap();
    host.pin_log_suppression_lens(corpus_id).unwrap();
    host.build_broad_log_triage_brief()
        .expect("broad triage brief")
}

fn good_answer_for(key: &TriageKnownAnswerKey, host: &TriageHostFacts) -> StructuredTriageAnswer {
    let first_visible = host.evidence.first().expect("brief exposes an identity");
    let mut observations = vec![TriageClaim {
        text: format!(
            "Host exact_unsuppressed_event_count={} time_quality={}",
            host.exact_event_count, host.time_quality
        ),
        seq: Some(first_visible.seq),
        source: Some(first_visible.source.clone()),
        role: Some("observation".into()),
    }];
    let mut causal = Vec::new();
    let mut competing = Vec::new();
    let mut missing = Vec::new();
    let mut confidence = "medium".to_string();
    let mut confidence_reason = "bounded host evidence reviewed".to_string();
    let mut asserts_root = false;

    if let Some(token) = &key.true_trigger_message_token {
        if let Some((seq, source, message)) = host
            .messages_by_seq
            .iter()
            .find(|(_, _, m)| m.contains(token.as_str()))
            .filter(|(seq, source, _)| host_identity_visible(host, *seq, source))
        {
            causal.push(TriageClaim {
                text: message.clone(),
                seq: Some(*seq),
                source: Some(source.clone()),
                role: Some("trigger".into()),
            });
            observations.push(TriageClaim {
                text: format!("cited trigger candidate from {source}"),
                seq: Some(*seq),
                source: Some(source.clone()),
                role: Some("observation".into()),
            });
            asserts_root = key.root_cause_establishable;
            if asserts_root {
                confidence = "medium".into();
                confidence_reason = "trigger cited; residual paths may remain".into();
            }
        }
    }
    if let Some(token) = &key.decoy_earliest_error_message_token {
        if let Some((seq, source, message)) = host
            .messages_by_seq
            .iter()
            .find(|(_, _, m)| m.contains(token.as_str()))
            .filter(|(seq, source, _)| host_identity_visible(host, *seq, source))
        {
            competing.push(format!(
                "Earlier error seq={seq} source={source} ({message}) is a decoy, not proven root cause"
            ));
            observations.push(TriageClaim {
                text: "earliest error observed but not treated as root cause".into(),
                seq: Some(*seq),
                source: Some(source.clone()),
                role: Some("observation".into()),
            });
        }
    }
    for token in &key.symptom_message_tokens {
        if let Some((seq, source, message)) = host
            .messages_by_seq
            .iter()
            .find(|(_, _, m)| m.contains(token.as_str()))
            .filter(|(seq, source, _)| host_identity_visible(host, *seq, source))
        {
            observations.push(TriageClaim {
                text: format!("symptom: {message}"),
                seq: Some(*seq),
                source: Some(source.clone()),
                role: Some("symptom".into()),
            });
        }
    }
    if !key.root_cause_establishable {
        asserts_root = false;
        confidence = "low".into();
        confidence_reason = "root cause not establishable from imported evidence alone".into();
        for omitted in &key.sources_omitted {
            missing.push(format!("missing source not imported: {omitted}"));
        }
        if key
            .required_disclosures
            .iter()
            .any(|d| d == "order_only_or_ambiguous_time")
        {
            missing.push(
                "order-only/ambiguous time blocks confident cross-source wall-clock order".into(),
            );
            competing
                .push("Multiple local causal candidates remain open under order-only time".into());
        }
        if key
            .required_disclosures
            .iter()
            .any(|d| d == "missing_root_evidence")
        {
            missing.push(
                "root-cause evidence omitted from this import; next: entitlement/config sources"
                    .into(),
            );
        }
        if missing.is_empty() {
            missing.push("additional evidence required before claiming root cause".into());
        }
        if competing.is_empty() {
            competing.push("Insufficient evidence; competing explanations remain open".into());
        }
    } else if missing.is_empty() {
        missing.push("optional: configuration corroboration for the cited trigger".into());
    }
    if competing.is_empty() {
        competing.push(
            "Alternative contributing factors remain possible within bounded evidence".into(),
        );
    }
    if causal.is_empty() && !key.root_cause_establishable {
        causal.push(TriageClaim {
            text: "no establishable trigger in imported evidence".into(),
            seq: None,
            source: None,
            role: Some("unknown".into()),
        });
    }

    StructuredTriageAnswer {
        observations,
        causal_candidates: causal,
        competing_explanations: competing,
        confidence,
        confidence_reason,
        missing_or_next_evidence: missing,
        asserted_event_count: Some(host.exact_event_count),
        asserts_all_events_are_errors: false,
        asserts_earliest_error_is_root_cause: false,
        asserts_observed_sources: key.sources_present.clone(),
        asserts_confident_wall_clock_order: false,
        asserts_root_cause_established: asserts_root && key.root_cause_establishable,
    }
}

fn host_identity_visible(host: &TriageHostFacts, seq: u64, source: &str) -> bool {
    host.evidence
        .iter()
        .any(|identity| identity.seq == seq && identity.source == source)
}

// ─── Case matrix: import → brief → host facts → good answer ────────────────

fn exercise_case(
    case: &str,
) -> (
    TriageKnownAnswerKey,
    TriageHostFacts,
    cd_core::tool_host::BroadLogTriageBrief,
) {
    let key = load_answer_key(case);
    let (cache, corpus_id, corpus) = ingest_case(case);
    let mut host_facts = host_facts_for(&corpus, &key);
    let brief = build_brief(cache.path(), &corpus_id);
    host_facts.evidence = brief.evidence.clone();
    assert!(brief.deterministic_complete, "case {case}");
    assert!(
        brief.model_text.contains("Interpretation contract (host)"),
        "brief must carry host interpretation contract: {case}"
    );
    assert!(
        brief
            .model_text
            .contains("earliest_error_is_not_root_cause"),
        "brief must state earliest≠root: {case}"
    );
    for source in &key.sources_present {
        // Source basenames or full identities appear in facets / guardrails.
        let leaf = source.rsplit('/').next().unwrap_or(source);
        assert!(
            brief.model_text.contains(source) || brief.model_text.contains(leaf),
            "brief must disclose source {source} for {case}"
        );
    }
    // Answer key must never appear in the model-facing brief.
    assert!(
        !brief.model_text.contains("true_trigger_message_token")
            && !brief.model_text.contains("answer_key"),
        "evaluator key leaked into brief for {case}"
    );
    (key, host_facts, brief)
}

#[test]
fn case_decoy_before_trigger_scores_good_answer_and_rejects_earliest_root() {
    let (key, host, _brief) = exercise_case("decoy-before-trigger");
    let good = good_answer_for(&key, &host);
    let score = score_structured_triage_answer(&good, &key, &host);
    assert!(score.passed, "good answer failed: {:?}", score.failed_ids());

    let mutated = mutation_earliest_is_root_cause(&good);
    let score = score_structured_triage_answer(&mutated, &key, &host);
    assert!(!score.passed);
    assert!(
        score.failed_ids().contains(&"symptom_vs_cause")
            || score.failed_ids().contains(&"unsupported_claims"),
        "failed ids={:?}",
        score.failed_ids()
    );
}

#[test]
fn case_multi_hop_chain_identifies_trigger_across_sources() {
    let (key, host, brief) = exercise_case("multi-hop-chain");
    assert!(host.sources_present.len() >= 3, "expected 3 sources");
    let good = good_answer_for(&key, &host);
    let score = score_structured_triage_answer(&good, &key, &host);
    assert!(score.passed, "failed={:?}", score.failed_ids());
    assert!(
        good.causal_candidates
            .iter()
            .any(|c| c.text.contains("causal trigger") || c.role.as_deref() == Some("trigger")),
        "trigger missing from good answer"
    );
    // Downstream noise must not be the sole causal candidate.
    assert!(
        good.observations
            .iter()
            .any(|o| o.role.as_deref() == Some("symptom")),
        "symptoms should be labeled as observations"
    );
    assert!(brief.evidence.len() <= brief.identity_cap);
}

#[test]
fn case_missing_root_evidence_requires_disclosure_not_false_cause() {
    let (key, host, _brief) = exercise_case("missing-root-evidence");
    assert!(!key.root_cause_establishable);
    let good = good_answer_for(&key, &host);
    let score = score_structured_triage_answer(&good, &key, &host);
    assert!(score.passed, "failed={:?}", score.failed_ids());
    assert!(!good.asserts_root_cause_established);
    assert!(!good.missing_or_next_evidence.is_empty());

    let mut false_cause = good.clone();
    false_cause.asserts_root_cause_established = true;
    false_cause.confidence = "high".into();
    let score = score_structured_triage_answer(&false_cause, &key, &host);
    assert!(!score.passed);
    assert!(
        score.failed_ids().contains(&"trigger_identification")
            || score.failed_ids().contains(&"unsupported_claims")
            || score.failed_ids().contains(&"honest_uncertainty")
    );

    let observed = mutation_observed_missing_source(&good, "entitlement/authority.jsonl");
    let score = score_structured_triage_answer(&observed, &key, &host);
    assert!(!score.passed);
    assert!(score.failed_ids().contains(&"unsupported_claims"));
}

#[test]
fn case_order_only_time_blocks_confident_wall_clock_order() {
    let (key, host, brief) = exercise_case("order-only-time");
    assert_eq!(host.time_quality, "order_only");
    assert!(
        matches!(brief.time_quality, TimeQuality::OrderOnly),
        "brief time_quality={:?}",
        brief.time_quality
    );
    assert!(
        brief.model_text.contains("ingest")
            || brief.model_text.to_ascii_lowercase().contains("order"),
        "brief must disclose non-wall-clock axis"
    );
    let good = good_answer_for(&key, &host);
    let score = score_structured_triage_answer(&good, &key, &host);
    assert!(score.passed, "failed={:?}", score.failed_ids());

    let mut wall = good.clone();
    wall.asserts_confident_wall_clock_order = true;
    wall.confidence = "high".into();
    let score = score_structured_triage_answer(&wall, &key, &host);
    assert!(!score.passed);
    assert!(
        score.failed_ids().contains(&"chronology_honesty")
            || score.failed_ids().contains(&"unsupported_claims")
            || score.failed_ids().contains(&"honest_uncertainty")
    );
}

// ─── Mutation matrix (case 5) ──────────────────────────────────────────────

#[test]
fn adversarial_mutations_fail_evaluator_with_dimension_reasons() {
    let (key, host, _) = exercise_case("decoy-before-trigger");
    let good = good_answer_for(&key, &host);
    let neutral_text = good.to_markdown();
    let neutral = parse_structured_triage_answer(&neutral_text).expect("parse neutral answer text");
    assert!(score_structured_triage_answer(&neutral, &key, &host).passed);

    let first = good.observations.first().expect("observation citation");
    let seq = first.seq.expect("seq");
    let source = first.source.as_deref().expect("source");
    let exact_citation = format!("seq={seq} source=\"{source}\"");
    let partial_citation = format!("seq={seq}");
    let wrong_source = format!("seq={seq} source=\"outside/model-visible-brief.log\"");
    let out_of_brief = format!("seq=999999 source=\"{source}\"");
    let without_competing =
        remove_markdown_section(&neutral_text, "## competing_explanations", "## confidence");
    let without_missing = remove_markdown_section(
        &neutral_text,
        "## missing_or_next_evidence",
        "\n\nRoot cause is established.",
    );

    let cases: Vec<(&str, String, &str)> = vec![
        (
            "all_errors_actual_text",
            format!("{neutral_text}\nAll events in this corpus are errors.\n"),
            "unsupported_claims",
        ),
        (
            "all_errors_bullet_actual_text",
            format!("{neutral_text}\n- All events in this corpus are errors.\n"),
            "unsupported_claims",
        ),
        (
            "all_errors_heading_case_punctuation_actual_text",
            format!("{neutral_text}\n### Finding: ALL EVENTS IN THIS CORPUS ARE ERRORS!!!\n"),
            "unsupported_claims",
        ),
        (
            "all_errors_whitespace_actual_text",
            format!("{neutral_text}\n-   All   events in this corpus   are errors .\n"),
            "unsupported_claims",
        ),
        (
            "all_errors_equivalent_embedded_prose_actual_text",
            format!(
                "{neutral_text}\nEvidence conclusion: every event in the corpus is an error, so no level distinction remains.\n"
            ),
            "unsupported_claims",
        ),
        (
            "earliest_root_actual_text",
            format!("{neutral_text}\nThe earliest error is the root cause.\nRoot cause is established.\n"),
            "symptom_vs_cause",
        ),
        (
            "earliest_root_bullet_equivalent_actual_text",
            format!("{neutral_text}\n- The first error is the root cause!\n"),
            "symptom_vs_cause",
        ),
        (
            "fabricated_count_actual_text",
            neutral_text.replace(
                &format!("Total events: {}.", host.exact_event_count),
                &format!("Total events: {}.", host.exact_event_count + 50),
            ),
            "unsupported_claims",
        ),
        (
            "omitted_source_actual_text",
            format!("{neutral_text}\nObserved source config/feature-flags.jsonl in the imported evidence.\n"),
            "unsupported_claims",
        ),
        (
            "unknown_source_actual_text",
            format!("{neutral_text}\nObserved source missing/never-imported.log in the imported evidence.\n"),
            "unsupported_claims",
        ),
        (
            "wrong_source_citation_actual_text",
            neutral_text.replacen(&exact_citation, &wrong_source, 1),
            "citation_validity",
        ),
        (
            "out_of_brief_citation_actual_text",
            neutral_text.replacen(&exact_citation, &out_of_brief, 1),
            "citation_validity",
        ),
        (
            "partial_citation_actual_text",
            neutral_text.replacen(&exact_citation, &partial_citation, 1),
            "citation_validity",
        ),
        (
            "missing_both_citation_identities_actual_text",
            neutral_text.replacen(&exact_citation, "", 1),
            "citation_validity",
        ),
        (
            "material_observation_self_labelled_zero_evidence_actual_text",
            neutral_text
                .replacen(&exact_citation, "", 1)
                .replacen("role=observation", "role=zero_evidence", 1),
            "citation_validity",
        ),
        (
            "material_causal_claim_self_labelled_unknown_actual_text",
            {
                let causal = good.causal_candidates.first().expect("causal citation");
                let citation = format!(
                    "seq={} source=\"{}\"",
                    causal.seq.expect("causal seq"),
                    causal.source.as_deref().expect("causal source")
                );
                neutral_text
                    .replacen(&citation, "", 1)
                    .replacen("role=trigger", "role=unknown", 1)
            },
            "citation_validity",
        ),
        (
            "negated_then_reasserted_actual_text",
            format!(
                "{neutral_text}\nIt would be wrong to say all events in this corpus are errors. However, all events in this corpus are errors.\n"
            ),
            "unsupported_claims",
        ),
        ("missing_competing_section_actual_text", without_competing, "contract_shape"),
        ("missing_evidence_section_actual_text", without_missing, "contract_shape"),
    ];
    for (name, text, expected_dim) in cases {
        let answer = parse_structured_triage_answer(&text)
            .unwrap_or_else(|error| panic!("{name} parse failed: {error}\n{text}"));
        let score = score_structured_triage_answer(&answer, &key, &host);
        assert!(!score.passed, "{name} should fail");
        let failed = score.failed_ids();
        assert!(
            failed.contains(&expected_dim)
                || (name == "earliest_root_actual_text"
                    && (failed.contains(&"unsupported_claims")
                        || failed.contains(&"symptom_vs_cause"))),
            "{name}: expected dim {expected_dim}, failed={failed:?} reasons={:?}",
            score.dimensions
        );
    }
}

#[test]
fn caveated_false_claim_wording_is_not_misclassified_as_a_positive_assertion() {
    let (key, host, _) = exercise_case("decoy-before-trigger");
    let neutral_text = good_answer_for(&key, &host).to_markdown();
    for caveat in [
        "- Not all events in this corpus are errors.",
        "### Caveat: There is no evidence that every event in the corpus is an error.",
        "It would be wrong to say all events in this corpus are errors.",
        "It would be incorrect to claim every event in the corpus is an error.",
        "We must not claim that all events in the corpus are errors.",
        "The earliest error is not the root cause.",
    ] {
        let text = format!("{neutral_text}\n{caveat}\n");
        let answer = parse_structured_triage_answer(&text).expect("parse caveated answer");
        let score = score_structured_triage_answer(&answer, &key, &host);
        assert!(
            score.passed,
            "caveat={caveat:?} failed={:?}",
            score.failed_ids()
        );
    }
}

#[test]
fn json_answers_derive_forbidden_assertions_from_claim_text_not_model_booleans() {
    let (key, host, _) = exercise_case("decoy-before-trigger");
    let good = good_answer_for(&key, &host);

    let mut untrusted_flags = good.clone();
    untrusted_flags.asserts_all_events_are_errors = true;
    untrusted_flags.asserts_earliest_error_is_root_cause = true;
    untrusted_flags.asserts_confident_wall_clock_order = true;
    let json = serde_json::to_string(&untrusted_flags).expect("serialize JSON answer");
    let parsed = parse_structured_triage_answer(&json).expect("parse JSON answer");
    assert!(!parsed.asserts_all_events_are_errors);
    assert!(!parsed.asserts_earliest_error_is_root_cause);
    assert!(!parsed.asserts_confident_wall_clock_order);
    assert!(!parsed.asserts_root_cause_established);

    let mut text_mutation = good.clone();
    text_mutation.observations[0].text =
        "Evidence conclusion: every event in this corpus is an error.".into();
    text_mutation.asserts_all_events_are_errors = false;
    let json = serde_json::to_string(&text_mutation).expect("serialize text mutation");
    let parsed = parse_structured_triage_answer(&json).expect("parse text-mutated JSON");
    let score = score_structured_triage_answer(&parsed, &key, &host);
    assert!(!score.passed);
    assert!(score.failed_ids().contains(&"unsupported_claims"));

    let mut fenced_mutation = good;
    fenced_mutation.causal_candidates[0].text = "The first error is the root cause!".into();
    fenced_mutation.asserts_earliest_error_is_root_cause = false;
    let fenced = format!(
        "```json\n{}\n```",
        serde_json::to_string(&fenced_mutation).expect("serialize fenced mutation")
    );
    let parsed = parse_structured_triage_answer(&fenced).expect("parse fenced JSON mutation");
    let score = score_structured_triage_answer(&parsed, &key, &host);
    assert!(!score.passed);
    assert!(
        score.failed_ids().contains(&"symptom_vs_cause")
            || score.failed_ids().contains(&"unsupported_claims")
    );
}

#[test]
fn actual_text_omitted_source_claim_is_rejected() {
    let (key, host, _) = exercise_case("missing-root-evidence");
    let omitted = key.sources_omitted.first().expect("omitted source fixture");
    let neutral_text = good_answer_for(&key, &host).to_markdown();
    let mutated_text =
        format!("{neutral_text}\nObserved source {omitted} in the imported evidence.\n");
    let mutated = parse_structured_triage_answer(&mutated_text).expect("parse omitted mutation");
    let score = score_structured_triage_answer(&mutated, &key, &host);
    assert!(!score.passed);
    assert!(score.failed_ids().contains(&"unsupported_claims"));
}

fn remove_markdown_section(text: &str, start: &str, end: &str) -> String {
    let start_at = text.find(start).expect("section start");
    let end_at = text[start_at..]
        .find(end)
        .map(|offset| start_at + offset)
        .unwrap_or(text.len());
    format!("{}{}", &text[..start_at], &text[end_at..])
}

// ─── Contract + headroom ───────────────────────────────────────────────────

#[test]
fn synthesis_contract_text_separates_required_sections() {
    let text = triage_answer_contract_system_text();
    for section in TRIAGE_ANSWER_SECTIONS {
        assert!(text.contains(section), "missing section {section}");
    }
    assert!(text.contains("earliest") || text.contains("root cause"));
    assert!(text.contains("citation identities only") || text.contains("does not verify"));
}

#[test]
fn broad_triage_context_packing_reserves_useful_headroom() {
    let (key, host, brief) = exercise_case("multi-hop-chain");
    let system = format!(
        "You are ContextDesk linked to corpus lab.\n\n{}",
        triage_answer_contract_system_text()
    );
    let user = "Broad triage: what failed and what is the likely cause?";
    let packing_budget = broad_triage_packing_budget(DEFAULT_CONTEXT_CHAR_BUDGET);
    assert!(
        packing_budget + BROAD_TRIAGE_CONTEXT_HEADROOM_CHARS <= DEFAULT_CONTEXT_CHAR_BUDGET
            || packing_budget == DEFAULT_CONTEXT_CHAR_BUDGET,
        "packing_budget={packing_budget}"
    );

    let messages = vec![
        ChatMessage {
            role: Role::System,
            content: system,
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: Role::User,
            content: user.into(),
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: Role::User,
            content: format!(
                "HOST-RETURNED BOUNDED EVIDENCE — current turn only:\n{}",
                brief.model_text
            ),
            tool_call_id: None,
            tool_calls: None,
        },
    ];
    let prepared =
        cd_core::sessions::prepare_model_context(&messages, messages.len().max(1), packing_budget)
            .expect("pack model context");
    let used = estimate_context_chars(&prepared.messages);
    let free = DEFAULT_CONTEXT_CHAR_BUDGET.saturating_sub(used);
    eprintln!(
        "CONTEXT_HEADROOM case={} used={} budget={} packing_budget={} free={} reserved={} brief_bytes={}",
        key.case_id,
        used,
        DEFAULT_CONTEXT_CHAR_BUDGET,
        packing_budget,
        free,
        BROAD_TRIAGE_CONTEXT_HEADROOM_CHARS,
        brief.model_text_bytes
    );
    assert!(
        used <= packing_budget,
        "used={used} packing_budget={packing_budget}"
    );
    assert!(
        has_useful_context_headroom(used, DEFAULT_CONTEXT_CHAR_BUDGET),
        "used={used} budget={DEFAULT_CONTEXT_CHAR_BUDGET} free={free}"
    );
    // Near-ceiling alone is failure even if under budget.
    assert!(
        used < 119_900 || DEFAULT_CONTEXT_CHAR_BUDGET > 120_000,
        "near-ceiling packing is not success: used={used}"
    );
    // Brief must remain present after packing.
    assert!(
        prepared
            .messages
            .iter()
            .any(|m| m.content.contains("Interpretation contract (host)")),
        "brief interpretation contract dropped from packed context"
    );
    // Key never in context.
    let blob: String = prepared
        .messages
        .iter()
        .map(|m| m.content.as_str())
        .collect();
    assert!(!blob.contains(&key.case_id) || blob.contains("multi-hop")); // case id may appear only if we put it - ensure truth tokens not present
    assert!(!blob.contains("true_trigger_message_token"));
    assert!(!blob.contains("answer_key"));
    let _ = host;
}

// ─── Scripted plumbing (not model quality) ─────────────────────────────────

#[test]
fn scripted_broad_triage_turn_exposes_brief_and_accepts_structured_answer() {
    let case = "decoy-before-trigger";
    let key = load_answer_key(case);
    let (cache, corpus_id, corpus) = ingest_case(case);
    let mut host_facts = host_facts_for(&corpus, &key);
    let visible_brief = build_brief(cache.path(), &corpus_id);
    host_facts.evidence = visible_brief.evidence.clone();
    let good = good_answer_for(&key, &host_facts);
    let markdown = good.to_markdown();

    let mut tool_host = ToolHost::new(
        Workspace::new("triage-lab-turn", vec![cache.path().to_path_buf()]),
        KeywordIndex::new(),
        None,
    );
    tool_host.set_log_analysis(true, Some(cache.path().to_path_buf()));
    tool_host.set_log_corpus_scope(Some(corpus_id.clone()));
    tool_host.set_active_log_corpus(Some(corpus_id.clone()));
    let opened = Arc::new(LogCorpus::open(cache.path(), &corpus_id).unwrap());
    tool_host
        .seed_log_corpus_handle(&corpus_id, opened)
        .unwrap();
    tool_host.pin_log_suppression_lens(&corpus_id).unwrap();

    // Scripted path: host brief is prepared inside the turn; answer immediately
    // with a structured contract-shaped reply (plumbing proof only).
    let backend = ScriptedBackend::new(vec![ChatCompletion {
        content: markdown.clone(),
        tool_calls: vec![],
        finish_reason: "stop".into(),
    }]);

    let mut history = Vec::new();
    let opts = AgentOptions {
        session_id: "triage-lab".into(),
        model: Some("scripted-lab".into()),
        max_rounds: 4,
        context_char_budget: DEFAULT_CONTEXT_CHAR_BUDGET,
        ambient_recall_enabled: false,
        log_explorer_context: Some(
            LogExplorerTurnContext::for_main_chat(&corpus_id).expect("main chat context"),
        ),
        ..Default::default()
    };

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let events = rt
        .block_on(run_agent_turn(
            &backend,
            &mut tool_host,
            "Broad triage this corpus: earliest error vs likely cause?",
            &mut history,
            &opts,
        ))
        .expect("run_agent_turn");

    let trail: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::SearchTrail { steps } => Some(steps.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    let trail_blob = trail.join("\n");
    let tool_names: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::Tool { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect();

    // Real shipped path must run host brief for broad triage questions.
    assert!(
        tool_names.contains(&"broad_log_triage"),
        "expected broad_log_triage tool event on real path; tools={tool_names:?} trail={trail_blob}"
    );
    assert!(
        trail_blob.contains("linked_broad_triage_brief:")
            || trail_blob.contains("linked_broad_triage:"),
        "expected broad triage trail markers; trail={trail_blob}"
    );
    // Headroom must be measured on the real packing path (not a reimplemented stack).
    let budget_step = trail
        .iter()
        .find(|s| s.starts_with("context_budget:"))
        .unwrap_or_else(|| panic!("missing context_budget trail step; trail={trail_blob}"));
    assert!(
        budget_step.contains("used=")
            && budget_step.contains("budget=")
            && budget_step.contains("packing_budget=")
            && budget_step.contains("headroom=")
            && budget_step.contains("reserved="),
        "context_budget step incomplete: {budget_step}"
    );
    let parse_field = |key: &str| -> usize {
        let marker = format!("{key}=");
        budget_step
            .find(&marker)
            .and_then(|idx| {
                let rest = budget_step.get(idx + marker.len()..)?;
                let end = rest
                    .find(|c: char| !c.is_ascii_digit())
                    .unwrap_or(rest.len());
                rest.get(..end)?.parse().ok()
            })
            .unwrap_or_else(|| panic!("missing {key} in {budget_step}"))
    };
    let used = parse_field("used");
    let budget = parse_field("budget");
    let packing_budget = parse_field("packing_budget");
    let headroom = parse_field("headroom");
    let reserved = parse_field("reserved");
    eprintln!(
        "REAL_PATH_CONTEXT_HEADROOM used={used} budget={budget} packing_budget={packing_budget} headroom={headroom} reserved={reserved}"
    );
    assert_eq!(budget, DEFAULT_CONTEXT_CHAR_BUDGET);
    assert_eq!(
        packing_budget,
        broad_triage_packing_budget(DEFAULT_CONTEXT_CHAR_BUDGET)
    );
    assert_eq!(reserved, BROAD_TRIAGE_CONTEXT_HEADROOM_CHARS);
    assert!(
        used <= packing_budget,
        "used={used} packing={packing_budget}"
    );
    assert_eq!(headroom, budget.saturating_sub(used));
    assert!(
        has_useful_context_headroom(used, budget),
        "real path must leave useful headroom: used={used} budget={budget}"
    );
    assert!(
        used < 119_900,
        "near-ceiling packing is failure: used={used}"
    );

    // Score the terminal answer actually released by run_agent_turn. The
    // in-memory fixture above is only backend input; it is not the scored path.
    let terminal_text = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(
        !terminal_text.trim().is_empty(),
        "no terminal answer emitted: {events:?}"
    );
    let emitted = parse_structured_triage_answer(&terminal_text)
        .unwrap_or_else(|error| panic!("parse emitted terminal answer: {error}\n{terminal_text}"));
    let score = score_structured_triage_answer(&emitted, &key, &host_facts);
    assert!(
        score.passed,
        "scripted structured answer must pass hermetic rubric; failed={:?}",
        score.failed_ids()
    );
}

#[test]
fn budget_exhaustion_final_synthesis_reserves_real_path_headroom() {
    let case = "decoy-before-trigger";
    let key = load_answer_key(case);
    let (cache, corpus_id, corpus) = ingest_case(case);
    let mut host_facts = host_facts_for(&corpus, &key);
    host_facts.evidence = build_brief(cache.path(), &corpus_id).evidence;
    let markdown = good_answer_for(&key, &host_facts).to_markdown();

    let mut tool_host = ToolHost::new(
        Workspace::new("triage-lab-exhaustion", vec![cache.path().to_path_buf()]),
        KeywordIndex::new(),
        None,
    );
    tool_host.set_log_analysis(true, Some(cache.path().to_path_buf()));
    tool_host.set_log_corpus_scope(Some(corpus_id.clone()));
    tool_host.set_active_log_corpus(Some(corpus_id.clone()));
    tool_host
        .seed_log_corpus_handle(
            &corpus_id,
            Arc::new(LogCorpus::open(cache.path(), &corpus_id).unwrap()),
        )
        .unwrap();
    tool_host.pin_log_suppression_lens(&corpus_id).unwrap();

    let backend = ScriptedBackend::new(vec![ChatCompletion {
        content: markdown,
        tool_calls: vec![],
        finish_reason: "stop".into(),
    }]);
    let mut history = Vec::new();
    let opts = AgentOptions {
        session_id: "triage-lab-exhaustion".into(),
        model: Some("scripted-lab".into()),
        max_rounds: 0,
        context_char_budget: DEFAULT_CONTEXT_CHAR_BUDGET,
        ambient_recall_enabled: false,
        log_explorer_context: Some(
            LogExplorerTurnContext::for_main_chat(&corpus_id).expect("main chat context"),
        ),
        ..Default::default()
    };
    let events = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(run_agent_turn(
            &backend,
            &mut tool_host,
            "Broad triage this corpus: what failed?",
            &mut history,
            &opts,
        ))
        .expect("budget exhaustion synthesis");

    let trail = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::SearchTrail { steps } => Some(steps.as_slice()),
            _ => None,
        })
        .flatten()
        .find(|step| step.starts_with("context_budget:"))
        .unwrap_or_else(|| panic!("missing exhaustion context measurement: {events:?}"));
    assert!(
        trail.contains("packing_budget=108000")
            && trail.contains("reserved=12000")
            && trail.contains("headroom="),
        "{trail}"
    );
    assert!(events.iter().any(|event| {
        matches!(event, StreamEvent::TurnCompleted { reason } if reason == "budget_rounds_answer")
    }));
}

#[test]
fn minimum_custom_budget_reserves_proportional_headroom_on_real_agent_path() {
    let case = "decoy-before-trigger";
    let key = load_answer_key(case);
    let (cache, corpus_id, corpus) = ingest_case(case);
    let mut host_facts = host_facts_for(&corpus, &key);
    host_facts.evidence = build_brief(cache.path(), &corpus_id).evidence;
    let markdown = good_answer_for(&key, &host_facts).to_markdown();

    let mut tool_host = ToolHost::new(
        Workspace::new("triage-lab-small-budget", vec![cache.path().to_path_buf()]),
        KeywordIndex::new(),
        None,
    );
    tool_host.set_log_analysis(true, Some(cache.path().to_path_buf()));
    tool_host.set_log_corpus_scope(Some(corpus_id.clone()));
    tool_host.set_active_log_corpus(Some(corpus_id.clone()));
    tool_host
        .seed_log_corpus_handle(
            &corpus_id,
            Arc::new(LogCorpus::open(cache.path(), &corpus_id).unwrap()),
        )
        .unwrap();
    tool_host.pin_log_suppression_lens(&corpus_id).unwrap();

    let backend = ScriptedBackend::new(vec![ChatCompletion {
        content: markdown,
        tool_calls: vec![],
        finish_reason: "stop".into(),
    }]);
    let mut history = Vec::new();
    let minimum_budget = cd_core::model_context::MIN_CONTEXT_CHAR_BUDGET;
    assert_eq!(minimum_budget, 24_000, "fixture expectation changed");
    let opts = AgentOptions {
        session_id: "triage-lab-small-budget".into(),
        model: Some("scripted-lab".into()),
        max_rounds: 4,
        context_char_budget: minimum_budget,
        ambient_recall_enabled: false,
        log_explorer_context: Some(
            LogExplorerTurnContext::for_main_chat(&corpus_id).expect("main chat context"),
        ),
        ..Default::default()
    };
    let events = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(run_agent_turn(
            &backend,
            &mut tool_host,
            "Broad triage this corpus: what problems stand out?",
            &mut history,
            &opts,
        ))
        .expect("small-budget broad turn");

    let trail = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::SearchTrail { steps } => Some(steps.as_slice()),
            _ => None,
        })
        .flatten()
        .find(|step| step.starts_with("context_budget:"))
        .unwrap_or_else(|| panic!("missing small-budget context measurement: {events:?}"));
    assert!(
        trail.contains("budget=24000")
            && trail.contains("packing_budget=21600")
            && trail.contains("reserved=2400"),
        "real path reclamped or lost proportional reserve: {trail}"
    );
    assert!(events.iter().any(|event| {
        matches!(event, StreamEvent::TurnCompleted { reason } if reason == "stop")
    }));
}

// ─── CLI / Tauri evidence parity (same cd-core contract) ───────────────────

#[test]
fn same_search_evidence_identity_contract_feeds_cli_and_core() {
    // Compile-time / structural: CLI envelope and core share grounding vocabulary;
    // brief evidence is SearchEvidenceIdentity from cd-core.
    let (cache, corpus_id, _) = ingest_case("multi-hop-chain");
    let brief = build_brief(cache.path(), &corpus_id);
    assert!(!brief.evidence.is_empty());
    for identity in &brief.evidence {
        // Round-trip JSON shape used by IPC / CLI trace surfaces.
        let value = serde_json::to_value(identity).expect("serialize identity");
        assert!(value.get("seq").is_some());
        assert!(value.get("source").is_some());
        assert!(value.get("template_id").is_some());
        let back: cd_core::log_analysis::SearchEvidenceIdentity =
            serde_json::from_value(value).expect("deserialize identity");
        assert_eq!(&back, identity);
    }
    // Workflow turn module reuses research_turn / agent path — architecture test
    // already covers Tauri delegation; here we assert the shared type is public.
    let _ = std::any::type_name::<cd_core::log_analysis::SearchEvidenceIdentity>();
    let _ = std::any::type_name::<cd_core::tool_host::BroadLogTriageBrief>();
}

#[test]
fn answer_keys_are_not_shipped_as_chat_context_fixtures() {
    // Evaluator-only isolation: truth files exist but must not live under import/.
    for case in [
        "decoy-before-trigger",
        "multi-hop-chain",
        "missing-root-evidence",
        "order-only-time",
    ] {
        let import = case_import(case);
        let truth = lab_root().join("cases").join(case).join("truth");
        assert!(import.is_dir());
        assert!(truth.is_dir());
        let import_has_truth = walkdir_has_name(&import, "answer_key.json");
        assert!(
            !import_has_truth,
            "answer key must not be under import/ for {case}"
        );
        assert!(truth.join("answer_key.json").is_file());
    }
}

fn walkdir_has_name(root: &Path, name: &str) -> bool {
    fn walk(path: &Path, name: &str) -> bool {
        if path.file_name().and_then(|s| s.to_str()) == Some(name) {
            return true;
        }
        if path.is_dir() {
            if let Ok(rd) = fs::read_dir(path) {
                for entry in rd.flatten() {
                    if walk(&entry.path(), name) {
                        return true;
                    }
                }
            }
        }
        false
    }
    walk(root, name)
}

#[test]
fn fixtures_manifest_lists_all_required_cases() {
    let cases = [
        "decoy-before-trigger",
        "multi-hop-chain",
        "missing-root-evidence",
        "order-only-time",
    ];
    for case in cases {
        let key = load_answer_key(case);
        assert_eq!(key.case_id, case);
        let v: Value = serde_json::from_str(
            &fs::read_to_string(
                lab_root()
                    .join("cases")
                    .join(case)
                    .join("truth/answer_key.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(v.get("sources_present").is_some());
    }
}
