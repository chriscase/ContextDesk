//! Vocabulary-generalization gates for the known-root investigation path.
//!
//! The frozen labs prove behavior on fixed corpora; these gates prove the
//! opposite direction — that shipped behavior is a function of **typed
//! structure and provenance**, never of the words a corpus happens to use.
//! Every test here either (a) runs the same shipped path under several
//! vocabularies — the frozen-fixture lexicon plus alpha-renames that exist
//! nowhere in the repository — and asserts byte-identical host handling, or
//! (b) derives the frozen-fixture lexicon from the fixture trees and asserts
//! it cannot appear in production ranking/prompt/query sources.
//!
//! How each gate resists overfitting:
//! - The metamorphic turns assert *equality of outcomes across vocabularies*,
//!   not any particular phrase, so passing them by recognizing words is
//!   impossible by construction: the fixture-echo family and the alien
//!   families must produce identical events.
//! - The alien families are proven unseen (`alien_markers_are_absent_from_
//!   fixtures_and_production`) before they are trusted as renames.
//! - The lexicon scan derives its needles from the frozen fixture trees at
//!   run time instead of hardcoding a phrase list, so growing the fixtures
//!   automatically grows the ban list, and production cannot re-memorize
//!   fixture wording (or aliases of it) without failing the scan.
//! - The typed-contract gates flip exactly one typed input (an evidence
//!   role, a citation scope) while holding text constant, and flip the text
//!   (fixture-ish causal words vs. bland alien words) while holding the
//!   typed input constant — establishment must track the typed input only.
//!
//! Nothing here touches the frozen fixture trees, goldens, truth labels, or
//! the rubric: new corpora are written to per-test temp dirs.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cd_core::agent::{
    run_agent_turn, AgentOptions, LogExplorerTurnContext, ScriptedBackend,
    DEFAULT_CONTEXT_CHAR_BUDGET,
};
use cd_core::chat::ChatCompletion;
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::investigation_answer::{
    render_answer_markdown, validate_model_answer, AnswerBindingV1, EvidenceRole,
    HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1, ValidationError, SCHEMA_V1,
};
use cd_core::log_analysis::{ingest_path, LogCorpus};
use cd_core::multi_model::{
    validate_candidate_finding, InvestigationRole, RoleBinding, CANDIDATE_FINDING_SCHEMA_V1,
};
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;

// ───────────────────────────── vocabulary families ─────────────────────────

/// One corpus vocabulary: the same semantic scenario (repeated downstream
/// failures plus one note that the authoritative causal source was never
/// collected), phrased in a distinct lexicon.
struct VocabFamily {
    label: &'static str,
    service: &'static str,
    file_name: &'static str,
    effect_line: &'static str,
    gap_line: &'static str,
    /// Words that must be provably unseen in fixtures and production for the
    /// rename to count as unseen. Empty for the fixture-echo family.
    alien_markers: &'static [&'static str],
}

/// The family that reuses the frozen-fixture lexicon verbatim. It is the
/// negative control: if any production path still recognizes these words,
/// its outcomes will differ from the alien families below and the equality
/// assertions fail.
const FIXTURE_ECHO: VocabFamily = VocabFamily {
    label: "fixture-echo",
    service: "checkout",
    file_name: "checkout.jsonl",
    effect_line: "symptom only: feature entitlement check failed feature=export",
    gap_line: "operator note: entitlement authority source not present in this import",
    alien_markers: &[],
};

const ALIEN_FAMILIES: [VocabFamily; 3] = [
    VocabFamily {
        label: "alien-ledger",
        service: "reconciler",
        file_name: "reconciler.jsonl",
        effect_line: "aftershock trace: ledger sync declined batch=b-41",
        gap_line:
            "archivist remark: the upstream ledger authority feed was never captured in this bundle",
        alien_markers: &["aftershock", "archivist"],
    },
    VocabFamily {
        label: "alien-gate",
        service: "dispatch",
        file_name: "dispatch.jsonl",
        // Hedged phrasing: the record itself is uncertain about its own role.
        effect_line: "tollgate reading (uncertain): corridor pass rejected badge=q-7",
        gap_line:
            "curator aside: whichever journal issued the rejection did not accompany this capture",
        alien_markers: &["tollgate", "curator"],
    },
    VocabFamily {
        label: "alien-yard",
        service: "yardworks",
        file_name: "yardworks.jsonl",
        effect_line: "winch stop event: hoist sequence ended early crate=c-9",
        gap_line:
            "registrar footnote: provenance for the stop decision lives outside what was collected",
        alien_markers: &["winch", "registrar"],
    },
];

fn all_families() -> Vec<&'static VocabFamily> {
    let mut families = vec![&FIXTURE_ECHO];
    families.extend(ALIEN_FAMILIES.iter());
    families
}

// ───────────────────────────── linked-turn harness ─────────────────────────

struct FamilyCorpus {
    cache: tempfile::TempDir,
    corpus_id: String,
    /// One real, host-derived evidence identity from the broad-triage brief.
    seq: u64,
    source: String,
}

fn ingest_family(family: &VocabFamily) -> FamilyCorpus {
    let import = tempfile::tempdir().expect("import dir");
    let mut lines = String::new();
    for (i, ts) in [1_700_000_010_u64, 1_700_000_020, 1_700_000_030]
        .iter()
        .enumerate()
    {
        lines.push_str(&format!(
            "{{\"ts\":{ts},\"level\":\"error\",\"service\":\"{}\",\"message\":\"{} attempt={i}\"}}\n",
            family.service, family.effect_line
        ));
    }
    lines.push_str(&format!(
        "{{\"ts\":1700000040,\"level\":\"warn\",\"service\":\"{}\",\"message\":\"{}\"}}\n",
        family.service, family.gap_line
    ));
    fs::write(import.path().join(family.file_name), lines).expect("write corpus");

    let cache = tempfile::tempdir().expect("cache dir");
    let report = ingest_path(cache.path(), import.path(), family.label, None, "").expect("ingest");
    let corpus_id = report.corpus_id;

    let host = tool_host_for(cache.path(), &corpus_id);
    let brief = host
        .build_broad_log_triage_brief()
        .expect("broad triage brief");
    let identity = brief
        .evidence
        .first()
        .expect("brief evidence identity")
        .clone();
    FamilyCorpus {
        cache,
        corpus_id,
        seq: identity.seq,
        source: identity.source,
    }
}

fn tool_host_for(cache: &Path, corpus_id: &str) -> ToolHost {
    let mut host = ToolHost::new(
        Workspace::new("vocab-gates", vec![cache.to_path_buf()]),
        KeywordIndex::new(),
        None,
    );
    host.set_log_analysis(true, Some(cache.to_path_buf()));
    host.set_log_corpus_scope(Some(corpus_id.to_string()));
    host.set_active_log_corpus(Some(corpus_id.to_string()));
    host.seed_log_corpus_handle(
        corpus_id,
        Arc::new(LogCorpus::open(cache, corpus_id).expect("open corpus")),
    )
    .expect("seed corpus handle");
    host.pin_log_suppression_lens(corpus_id).expect("pin lens");
    host
}

/// Run one scripted single-stage linked/broad turn and return its events.
fn run_scripted_turn(corpus: &FamilyCorpus, completions: Vec<String>) -> Vec<StreamEvent> {
    let backend = ScriptedBackend::new(
        completions
            .into_iter()
            .map(|content| ChatCompletion {
                content,
                tool_calls: vec![],
                finish_reason: "stop".into(),
                telemetry: Default::default(),
            })
            .collect(),
    );
    let mut tool_host = tool_host_for(corpus.cache.path(), &corpus.corpus_id);
    let mut history = Vec::new();
    let opts = AgentOptions {
        session_id: "vocab-gates".into(),
        model: Some("scripted-gates".into()),
        // Below the multi-stage reservation: the established single-stage
        // synthesis path (the one that carried the removed phrase matcher)
        // is the path under test.
        max_rounds: 2,
        context_char_budget: DEFAULT_CONTEXT_CHAR_BUDGET,
        ambient_recall_enabled: false,
        log_explorer_context: Some(
            LogExplorerTurnContext::for_main_chat(&corpus.corpus_id).expect("main chat context"),
        ),
        ..Default::default()
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(run_agent_turn(
            &backend,
            &mut tool_host,
            "What failed here and is the cause established?",
            &mut history,
            &opts,
        ))
        .expect("run_agent_turn")
}

fn released_text(events: &[StreamEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn trail_steps(events: &[StreamEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::SearchTrail { steps } => Some(steps.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

fn error_codes(events: &[StreamEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::Error { code, .. } => Some(code.clone()),
            _ => None,
        })
        .collect()
}

fn completion_reasons(events: &[StreamEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TurnCompleted { reason } => Some(reason.clone()),
            _ => None,
        })
        .collect()
}

/// Host-behavior fingerprint that must be equal across vocabularies for a
/// fixed answer shape: whether the scripted text was released verbatim,
/// every error code, the turn-completion reasons, and whether any
/// host-authored causal demotion/rewrite marker appeared.
#[derive(Debug, PartialEq, Eq)]
struct TurnOutcome {
    released_verbatim: bool,
    released_empty: bool,
    error_codes: Vec<String>,
    completion_reasons: Vec<String>,
    demotion_markers: Vec<String>,
}

fn outcome(events: &[StreamEvent], scripted: &str) -> TurnOutcome {
    let released = released_text(events);
    let demotion_markers = trail_steps(events)
        .into_iter()
        .filter(|step| {
            step.contains("linked_host_cause_not_established")
                || step.contains("linked_causal_overclaim_rejected")
        })
        .collect();
    TurnOutcome {
        released_verbatim: released == scripted,
        released_empty: released.trim().is_empty(),
        error_codes: error_codes(events),
        completion_reasons: completion_reasons(events),
        demotion_markers,
    }
}

// ───────────────────── metamorphic linked-turn invariance ──────────────────

/// Answer styles cover the hedging spectrum: a confident causal lead, an
/// explicit non-establishment lead, and plain prose with no lead at all.
/// The host may only ever act on typed structure (citation identities), so
/// for a fixed style every vocabulary must yield an identical outcome.
fn answer_styles(seq: u64, source: &str) -> Vec<(&'static str, String)> {
    vec![
        (
            "confident-lead",
            format!(
                "**Likely cause:** the earliest recorded change explains the later failures. \
                 Evidence: seq={seq} source={source}."
            ),
        ),
        (
            "withheld-lead",
            format!(
                "**Cause not established:** the records show repeated downstream failures \
                 without a named mechanism. Evidence: seq={seq} source={source}."
            ),
        ),
        (
            "plain-prose",
            format!(
                "The failure activity concentrates in one service and one template. \
                 Evidence: seq={seq} source={source}."
            ),
        ),
    ]
}

#[test]
fn linked_turn_outcomes_are_invariant_under_unseen_vocabulary_renames() {
    let mut per_style: Vec<(String, Vec<(&'static str, TurnOutcome)>)> = Vec::new();
    for family in all_families() {
        let corpus = ingest_family(family);
        for (style, scripted) in answer_styles(corpus.seq, &corpus.source) {
            let events = run_scripted_turn(&corpus, vec![scripted.clone()]);
            let turn_outcome = outcome(&events, &scripted);

            // Positive control per turn: a validly-cited answer is released
            // verbatim — the host never rewrites, demotes, or promotes it.
            assert!(
                turn_outcome.released_verbatim,
                "[{}/{style}] host altered a validly-cited answer: {events:?}",
                family.label
            );
            assert!(
                turn_outcome.error_codes.is_empty(),
                "[{}/{style}] unexpected error: {events:?}",
                family.label
            );
            assert!(
                turn_outcome.demotion_markers.is_empty(),
                "[{}/{style}] vocabulary-driven demotion resurfaced: {events:?}",
                family.label
            );

            match per_style.iter_mut().find(|(s, _)| s == style) {
                Some((_, outcomes)) => outcomes.push((family.label, turn_outcome)),
                None => per_style.push((style.to_string(), vec![(family.label, turn_outcome)])),
            }
        }
    }

    // Metamorphic relation: for each answer style, the fixture-echo corpus
    // and every unseen rename must produce the same host outcome. A
    // vocabulary-coupled branch anywhere in the path would break equality.
    for (style, outcomes) in &per_style {
        let (reference_label, reference) = &outcomes[0];
        for (label, other) in &outcomes[1..] {
            assert_eq!(
                reference, other,
                "outcome for style {style} diverged between {reference_label} and {label}"
            );
        }
    }
}

#[test]
fn invalid_citations_fail_closed_identically_across_vocabularies() {
    let mut outcomes: Vec<(&'static str, TurnOutcome)> = Vec::new();
    for family in all_families() {
        let corpus = ingest_family(family);
        let scripted = format!(
            "**Likely cause:** a phantom record proves it. Evidence: seq=987654 \
             source=phantom-{}.log.",
            family.label
        );
        // Two identical completions: the first consumes the one invalid-
        // synthesis retry, the second forces the terminal fail-closed path.
        let events = run_scripted_turn(&corpus, vec![scripted.clone(), scripted.clone()]);
        let turn_outcome = outcome(&events, &scripted);

        assert!(
            turn_outcome.released_empty,
            "[{}] fabricated citation escaped withholding: {events:?}",
            family.label
        );
        assert!(
            turn_outcome
                .error_codes
                .contains(&"linked_invalid_grounded_answer".to_string()),
            "[{}] missing fail-closed error: {events:?}",
            family.label
        );
        outcomes.push((family.label, turn_outcome));
    }

    let (reference_label, reference) = &outcomes[0];
    for (label, other) in &outcomes[1..] {
        assert_eq!(
            reference, other,
            "fail-closed outcome diverged between {reference_label} and {label}"
        );
    }
}

// ───────────────── typed establishment / anti-union invariance ─────────────

fn revision() -> LogSnapshotRevisionV1 {
    LogSnapshotRevisionV1 {
        event_revision: 3,
        template_analysis_revision: 2,
        suppression_revision: 1,
    }
}

fn entry(
    evidence_id: &str,
    candidate_id: &str,
    role: EvidenceRole,
    content: &str,
) -> HostEvidenceEntry {
    HostEvidenceEntry {
        evidence_id: evidence_id.into(),
        candidate_id: candidate_id.into(),
        source_label: "app/service.jsonl".into(),
        locator: format!("seq:{evidence_id}"),
        corpus_id: "corpus-vocab-gates".into(),
        revision: revision(),
        role,
        content: content.into(),
    }
}

fn ledger(entries: Vec<HostEvidenceEntry>) -> HostEvidenceLedger {
    let binding = AnswerBindingV1 {
        session_id: "vocab-gates".into(),
        turn_id: "turn-1".into(),
        corpus_id: "corpus-vocab-gates".into(),
        revision: revision(),
        ledger_digest: HostEvidenceLedger::digest(&entries),
    };
    HostEvidenceLedger::new(binding, entries).expect("ledger")
}

/// Evidence content variants: causal-sounding fixture-flavored words vs.
/// bland unseen words. Establishment must be blind to both.
const CONTENT_VARIANTS: [(&str, &str); 2] = [
    (
        "causal-flavored",
        "root cause identified: entitlement authority disabled by operator",
    ),
    (
        "bland-alien",
        "registrar copied one line into the winch journal",
    ),
];

#[test]
fn root_establishment_tracks_evidence_role_never_evidence_wording() {
    for (variant, content) in CONTENT_VARIANTS {
        for (role, expect_established) in
            [(EvidenceRole::Neutral, false), (EvidenceRole::Cause, true)]
        {
            let ledger = ledger(vec![entry("e-1", "cand-a", role, content)]);
            let raw = format!(
                r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"cand-a","initiating_causes":[{{"claim_id":"c-1","text":"the recorded change initiated the failures","evidence_ids":["e-1"]}}]}}]}}"#
            );
            let envelope = validate_model_answer(&raw, &ledger).expect("validate");
            assert_eq!(
                envelope.answer.root_cause_established, expect_established,
                "establishment must equal (role == Cause) for content variant {variant}"
            );
            let claim = &envelope.answer.candidates[0].claims[0];
            let expected_status = if expect_established {
                cd_core::investigation_answer::ClaimStatus::Supported
            } else {
                cd_core::investigation_answer::ClaimStatus::Withheld
            };
            assert_eq!(
                claim.status, expected_status,
                "initiating-cause status must track the typed role only ({variant})"
            );
            let markdown = render_answer_markdown(&envelope);
            let line = if expect_established {
                "- Root cause established: yes"
            } else {
                "- Root cause established: no"
            };
            assert!(
                markdown.contains(line),
                "typed establishment line missing for {variant}: {markdown}"
            );
        }
    }
}

#[test]
fn claim_scope_stays_anti_union_under_any_vocabulary() {
    for (variant, content) in CONTENT_VARIANTS {
        let ledger = ledger(vec![
            entry("e-a", "cand-a", EvidenceRole::Neutral, content),
            entry("e-b", "cand-b", EvidenceRole::Neutral, content),
        ]);

        // Final synthesis: a cand-a claim citing cand-b evidence is rejected
        // even though both candidates are present and the id is real.
        let cross_scope = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"cand-a","observations":[{{"claim_id":"c-1","text":"cross-scope citation","evidence_ids":["e-b"]}}]}},{{"candidate_id":"cand-b","observations":[{{"claim_id":"c-2","text":"in-scope citation","evidence_ids":["e-b"]}}]}}]}}"#
        );
        assert_eq!(
            validate_model_answer(&cross_scope, &ledger).expect_err("cross-scope must fail"),
            ValidationError::WrongScope,
            "final-synthesis anti-union regressed for {variant}"
        );

        // Stage-2 candidate finding: same anti-union under the same lexicon.
        let stage2 = format!(
            r#"{{"schema":"{CANDIDATE_FINDING_SCHEMA_V1}","candidate_id":"cand-a","observations":[{{"claim_id":"s-1","text":"cross-scope citation","evidence_ids":["e-b"]}}]}}"#
        );
        let binding = RoleBinding {
            role: InvestigationRole::Investigator,
            profile_id: "profile-hermetic".into(),
            model: "scripted-gates".into(),
            semantic_attempts: 0,
        };
        assert_eq!(
            validate_candidate_finding(&stage2, &ledger, "cand-a", binding.clone())
                .expect_err("stage-2 cross-scope must fail"),
            cd_core::investigation_answer::ValidationError::WrongScope,
            "stage-2 anti-union regressed for {variant}"
        );

        // Stage-2 cannot even express establishment: the schema has no
        // initiating-cause section, so the typed contract (not vocabulary)
        // withholds establishment from investigators.
        let stage2_establish = format!(
            r#"{{"schema":"{CANDIDATE_FINDING_SCHEMA_V1}","candidate_id":"cand-a","initiating_causes":[{{"claim_id":"s-2","text":"I establish the cause","evidence_ids":["e-a"]}}]}}"#
        );
        assert!(
            validate_candidate_finding(&stage2_establish, &ledger, "cand-a", binding).is_err(),
            "stage-2 accepted an establishment section for {variant}"
        );
    }
}

// ───────────────────────── derived fixture-lexicon scan ────────────────────

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn production_prompt_and_ranking_sources() -> Vec<PathBuf> {
    // The five files the security gate already scans, plus the qualification
    // prompt/rubric module and the multi-model pipeline surfaces the
    // known-root path now leans on.
    [
        "src/agent.rs",
        "src/investigation_answer.rs",
        "src/log_analysis/search.rs",
        "src/log_analysis/linked_search_bound.rs",
        "src/tool_host.rs",
        "src/triage_quality.rs",
        "src/multi_model/mod.rs",
        "src/multi_model/contracts.rs",
        "src/multi_model/pipeline.rs",
    ]
    .iter()
    .map(|relative| manifest_dir().join(relative))
    .collect()
}

fn walk_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for dir_entry in entries.flatten() {
        let path = dir_entry.path();
        if path.is_dir() {
            walk_files(&path, output);
        } else {
            output.push(path);
        }
    }
}

/// Forbidden lexicon derived from the frozen triage-root-cause lab at run
/// time: word-boundary prefixes (≥ 12 chars) of every message-bearing
/// answer-key token, and every 3–6 word phrase (≥ 14 chars) of every import
/// message. Contract identifiers (snake_case section/field names shared with
/// the rubric by design) are not message-bearing and are not banned.
fn derived_fixture_lexicon() -> BTreeSet<String> {
    let lab_root = manifest_dir().join("../../fixtures/triage-root-cause-lab/cases");
    let mut needles = BTreeSet::new();
    let mut files = Vec::new();
    walk_files(&lab_root, &mut files);
    assert!(
        !files.is_empty(),
        "expected frozen triage lab fixtures under {}",
        lab_root.display()
    );

    let mut message_tokens: Vec<String> = Vec::new();
    let mut messages: Vec<String> = Vec::new();
    for path in &files {
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        if path.ends_with("truth/answer_key.json")
            || path.file_name().is_some_and(|n| n == "answer_key.json")
        {
            let value: serde_json::Value =
                serde_json::from_str(&text).expect("parse frozen answer key");
            for field in [
                "symptom_message_tokens",
                "competing_trigger_message_tokens",
                "sources_omitted",
            ] {
                if let Some(list) = value.get(field).and_then(serde_json::Value::as_array) {
                    message_tokens.extend(
                        list.iter()
                            .filter_map(serde_json::Value::as_str)
                            .map(str::to_string),
                    );
                }
            }
            for field in [
                "true_trigger_message_token",
                "decoy_earliest_error_message_token",
            ] {
                if let Some(token) = value.get(field).and_then(serde_json::Value::as_str) {
                    message_tokens.push(token.to_string());
                }
            }
        } else if path
            .components()
            .any(|component| component.as_os_str() == "import")
        {
            for line in text.lines() {
                match serde_json::from_str::<serde_json::Value>(line) {
                    Ok(value) => {
                        if let Some(message) =
                            value.get("message").and_then(serde_json::Value::as_str)
                        {
                            messages.push(message.to_string());
                        }
                    }
                    Err(_) => messages.push(line.to_string()),
                }
            }
        }
    }
    assert!(
        !message_tokens.is_empty() && !messages.is_empty(),
        "lexicon derivation found no message vocabulary; the scan would be vacuous"
    );

    for token in &message_tokens {
        let lower = token.to_ascii_lowercase();
        let mut prefix = String::new();
        for word in lower.split_whitespace() {
            if !prefix.is_empty() {
                prefix.push(' ');
            }
            prefix.push_str(word);
            if prefix.chars().count() >= 12 {
                needles.insert(prefix.clone());
            }
        }
    }
    for message in &messages {
        let lower = message.to_ascii_lowercase();
        let words: Vec<&str> = lower.split_whitespace().collect();
        for n in 3..=6usize {
            for window in words.windows(n) {
                let gram = window.join(" ");
                if gram.chars().count() >= 14 {
                    needles.insert(gram);
                }
            }
        }
    }
    needles
}

#[test]
fn production_prompts_and_ranking_carry_no_fixture_lexicon_or_alias_tables() {
    let needles = derived_fixture_lexicon();
    assert!(
        needles.len() >= 100,
        "derived lexicon suspiciously small ({}); derivation regressed",
        needles.len()
    );
    // Sanity that the derivation still covers the two historically-leaked
    // phrases (these literals live only in this test and the frozen fixtures,
    // never in production sources).
    for historical in ["symptom only:", "not present in this import"] {
        assert!(
            needles.contains(historical),
            "derivation lost the historical leak phrase {historical:?}"
        );
    }

    let mut leaks = Vec::new();
    for path in production_prompt_and_ranking_sources() {
        let source = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
            .to_ascii_lowercase();
        // Conservative full-file scan (including inline tests): a truncated
        // scan could silently skip reachable production prompts or ranking.
        assert!(
            !source.contains("token_aliases"),
            "alias table forbidden in production source: {}",
            path.display()
        );
        for needle in &needles {
            if source.contains(needle.as_str()) {
                leaks.push(format!("{} contains {needle:?}", path.display()));
            }
        }
    }
    assert!(
        leaks.is_empty(),
        "fixture lexicon leaked into production prompt/ranking sources:\n{}",
        leaks.join("\n")
    );
}

#[test]
fn alien_markers_are_absent_from_fixtures_and_production() {
    let mut fixture_files = Vec::new();
    walk_files(&manifest_dir().join("../../fixtures"), &mut fixture_files);
    assert!(!fixture_files.is_empty(), "expected fixture trees");

    let mut scan_targets = production_prompt_and_ranking_sources();
    scan_targets.extend(fixture_files);

    let mut sightings = Vec::new();
    for path in scan_targets {
        let Ok(text) = fs::read_to_string(&path) else {
            continue; // binary fixture payloads (zips) cannot carry the markers as text we teach
        };
        let lower = text.to_ascii_lowercase();
        for family in &ALIEN_FAMILIES {
            for marker in family.alien_markers {
                if lower.contains(marker) {
                    sightings.push(format!("{} contains {marker:?}", path.display()));
                }
            }
        }
    }
    assert!(
        sightings.is_empty(),
        "alien rename markers must be unseen for the metamorphic tests to mean anything:\n{}",
        sightings.join("\n")
    );
}
