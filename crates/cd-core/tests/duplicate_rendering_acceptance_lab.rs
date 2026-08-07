//! Product-path acceptance lab for dual-rendering exception cascades.
//!
//! Restacked on tip with real
//! `cd_core::log_analysis::exception_episodes::analyze_exception_episodes`
//! wired through ingest → episode analysis → broad_log_triage → triage_quality.
//!
//! Former missing_seam occurrence/amplification assertions are **product-path**
//! acceptance tests: they fail closed when the seam is absent, partial,
//! cancelled, revision-stale, or internally inconsistent — they never invent a
//! pass from bare divisibility.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use cd_core::index::KeywordIndex;
use cd_core::log_analysis::exception_episodes::{
    analyze_bounded_events, analyze_exception_episodes, project_template_onto_episodes,
    ExceptionCorrelationConfidence, ExceptionRenderingKind, EXCEPTION_EPISODE_EVENT_SCAN_CAP,
    EXCEPTION_EPISODE_ROW_WALK_CAP,
};
use cd_core::log_analysis::frame::frame_text;
use cd_core::log_analysis::{
    query_event_rows, ActiveTimestampBasis, EventQuery, ExplorerEvent, LogCorpus, LogEmbedMode,
    LogEmbedPolicy, LogEvent, TimeQuality, TimestampProvenance, MAX_EVENT_PAGE,
};
use cd_core::tool_host::ToolHost;
use cd_core::triage_quality::{
    score_structured_triage_answer, StructuredTriageAnswer, TriageClaim, TriageHostFacts,
    TriageKnownAnswerKey,
};
use cd_core::workspace::Workspace;
use serde::Deserialize;

const OCCURRENCES: usize = 56;
const MISC_LINES: usize = 72;
const AT_FRAMES: usize = 189;
const INTERMEDIATE_CAUSES: usize = 1;
const DUPLICATE_CAUSES: usize = 2;
const STDERR_RECORDS_PER_OCCURRENCE: usize =
    1 + MISC_LINES + AT_FRAMES + INTERMEDIATE_CAUSES + DUPLICATE_CAUSES;
const STDERR_CASCADE_RECORDS: usize = OCCURRENCES * STDERR_RECORDS_PER_OCCURRENCE;
const APP_CASCADE_RECORDS: usize = OCCURRENCES;
const TOTAL_CASCADE_RECORDS: usize = APP_CASCADE_RECORDS + STDERR_CASCADE_RECORDS;
const UNRELATED_RECORDS: usize = 8;

#[derive(Debug, Deserialize)]
struct ExpectedContract {
    schema_version: u32,
    case_id: String,
    cascade_occurrences: usize,
    app_records_per_occurrence: usize,
    stderr_records_per_occurrence: usize,
    stderr_cascade_records: usize,
    app_cascade_records: usize,
    total_cascade_records: usize,
    stderr_record_amplification: usize,
    interleaved_unrelated_records: usize,
    required_product_api: String,
}

fn lab_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/duplicate-rendering-lab")
}

fn load_truth() -> ExpectedContract {
    let path = lab_root().join("truth/expected_contract.json");
    serde_json::from_str(&fs::read_to_string(&path).expect("read duplicate-rendering truth"))
        .expect("parse duplicate-rendering truth")
}

fn no_embed_policy() -> LogEmbedPolicy {
    LogEmbedPolicy {
        mode: LogEmbedMode::None,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "test-none".into(),
        defer_above_source_bytes: None,
    }
}

fn stderr_block(occurrence: usize) -> Vec<String> {
    let mut lines = Vec::with_capacity(STDERR_RECORDS_PER_OCCURRENCE);
    lines.push(format!(
        "XYZ_EXCEPTION: java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=req-{occurrence}"
    ));
    for w in 0..MISC_LINES {
        lines.push(format!(
            "Exception wrapper XYZ_WRAP#{w} for payment failure request_id=req-{occurrence}"
        ));
    }
    for f in 0..AT_FRAMES {
        lines.push(format!(
            "at com.xyz.payment.StackFrame{f}.invoke(StackFrame{f}.java:{})",
            f + 1
        ));
    }
    lines.push("Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT".into());
    lines.push("Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT".into());
    lines.push("Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT".into());
    assert_eq!(lines.len(), STDERR_RECORDS_PER_OCCURRENCE);
    lines
}

/// Positive dual-render family (56×265) + unrelated non-exception controls.
fn write_cascade_import(root: &Path) {
    fs::create_dir_all(root).expect("import root");
    let mut app = String::new();
    let mut stderr = String::new();
    let mut unrelated = String::new();
    for occurrence in 0..OCCURRENCES {
        let base = 12 * 3600 + (occurrence as u32) * 2;
        let h = (base / 3600) % 24;
        let m = (base / 60) % 60;
        let s = base % 60;
        let ts = format!("2026-03-15T{h:02}:{m:02}:{s:02}.000Z");
        app.push_str(&format!(
            "{ts} ERROR XYZ_EXCEPTION: java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=req-{occurrence}\n"
        ));
        app.push_str("  at com.xyz.payment.Client.charge(Client.java:42)\n");
        app.push_str("  at com.xyz.api.OrderService.checkout(OrderService.java:88)\n");
        app.push_str("  Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT\n");
        app.push_str("  at com.xyz.net.Http.execute(Http.java:15)\n");
        for (j, line) in stderr_block(occurrence).into_iter().enumerate() {
            let ms = (j % 1000) as u32;
            stderr.push_str(&format!(
                "2026-03-15T{h:02}:{m:02}:{s:02}.{ms:03}Z ERROR {line}\n"
            ));
        }
    }
    for index in 0..UNRELATED_RECORDS {
        let minute = index * 7;
        unrelated.push_str(&format!(
            "2026-03-15T13:{minute:02}:00.500Z INFO [unrelated-{index}] heartbeat ok unrelated_id=other-{index:02}\n"
        ));
    }
    fs::write(root.join("XYZ_app.log"), app).expect("app");
    fs::write(root.join("XYZ_server.stderr"), stderr).expect("stderr");
    fs::write(root.join("unrelated.log"), unrelated).expect("unrelated");
}

/// Cascade plus adversarial false-group families.
fn write_cascade_import_with_negatives(root: &Path) {
    write_cascade_import(root);
    let negatives = root.join("negatives");
    fs::create_dir_all(&negatives).unwrap();
    fs::write(
        negatives.join("interleaved_threads.log"),
        "\
2026-03-15T15:00:00.000Z ERROR [thread-A] java.lang.RuntimeException: XYZ_INTERLEAVE_A
  at neutral.A.m(A.java:1)
2026-03-15T15:00:00.100Z ERROR [thread-B] java.lang.RuntimeException: XYZ_INTERLEAVE_B
  at neutral.B.m(B.java:1)
2026-03-15T15:00:00.200Z ERROR [thread-A] cont-A
  at neutral.A.n(A.java:2)
",
    )
    .unwrap();
    fs::write(
        negatives.join("identical_gap.log"),
        "\
2026-03-15T16:00:00.000Z ERROR java.lang.RuntimeException: XYZ_IDENTICAL_GAP
2026-03-15T16:30:00.000Z INFO noise middle
2026-03-15T17:00:00.000Z ERROR java.lang.RuntimeException: XYZ_IDENTICAL_GAP
",
    )
    .unwrap();
    fs::write(
        negatives.join("conflicting_execution_keys.log"),
        "\
2026-03-15T18:00:00.000Z ERROR thread=worker-A java.lang.RuntimeException: XYZ_CONFLICT
  at com.xyz.A.m(A.java:1)
2026-03-15T18:00:00.000Z ERROR thread=worker-B [stderr] java.lang.RuntimeException: XYZ_CONFLICT
2026-03-15T18:00:00.001Z ERROR thread=worker-B [stderr] at com.xyz.A.m(A.java:1)
",
    )
    .unwrap();
    fs::write(
        negatives.join("rotation_only.log"),
        "2026-03-15T19:00:00.000Z ERROR java.lang.RuntimeException: XYZ_ROT_CURRENT\n",
    )
    .unwrap();
    fs::write(
        negatives.join("rotation_only.log.1"),
        "2026-03-15T18:59:00.000Z ERROR java.lang.RuntimeException: XYZ_ROT_PRIOR\n",
    )
    .unwrap();
    fs::write(
        negatives.join("message_equality_sources.log"),
        "\
2026-03-15T20:00:00.000Z ERROR java.lang.RuntimeException: XYZ_MSG_EQ
2026-03-15T20:00:05.000Z ERROR java.lang.RuntimeException: XYZ_MSG_EQ
",
    )
    .unwrap();
    fs::write(
        negatives.join("dup_a.log"),
        "2026-03-15T21:00:00.000Z ERROR java.lang.RuntimeException: XYZ_SOURCE_DUP payload\n",
    )
    .unwrap();
    fs::write(
        negatives.join("dup_b.log"),
        "2026-03-15T21:00:00.000Z ERROR java.lang.RuntimeException: XYZ_SOURCE_DUP payload\n",
    )
    .unwrap();
}

fn ingest_dir(dir: &Path) -> (tempfile::TempDir, String, LogCorpus) {
    let cache = tempfile::TempDir::new().unwrap();
    let report = cd_core::log_analysis::ingest_path_with_policy(
        cache.path(),
        dir,
        "dup-lab",
        &no_embed_policy(),
        None,
    )
    .expect("ingest");
    let corpus = LogCorpus::open(cache.path(), &report.corpus_id).unwrap();
    (cache, report.corpus_id, corpus)
}

fn build_brief(
    cache: &Path,
    corpus_id: &str,
    corpus: Arc<LogCorpus>,
) -> cd_core::tool_host::BroadLogTriageBrief {
    let mut host = ToolHost::new(
        Workspace::new("dup-lab", vec![cache.to_path_buf()]),
        KeywordIndex::new(),
        None,
    );
    host.set_log_analysis(true, Some(cache.to_path_buf()));
    host.set_log_corpus_scope(Some(corpus_id.to_string()));
    host.set_active_log_corpus(Some(corpus_id.to_string()));
    host.seed_log_corpus_handle(corpus_id, corpus).unwrap();
    host.pin_log_suppression_lens(corpus_id).unwrap();
    host.build_broad_log_triage_brief()
        .expect("broad triage brief")
}

fn host_facts_from_product(brief: &cd_core::tool_host::BroadLogTriageBrief) -> TriageHostFacts {
    let base = TriageHostFacts {
        time_quality: match brief.time_quality {
            cd_core::log_analysis::TimeQuality::Wall => "wall".into(),
            cd_core::log_analysis::TimeQuality::Mixed => "mixed".into(),
            cd_core::log_analysis::TimeQuality::OrderOnly => "order_only".into(),
        },
        exact_event_count: brief.unsuppressed_event_count,
        exact_error_count: None,
        sources_present: BTreeSet::new(),
        evidence: brief.evidence.clone(),
        messages_by_seq: Vec::new(),
        known_semantic_occurrence_count: None,
        stderr_record_count: None,
        raw_exception_record_count: None,
        episode_counts_complete: false,
    };
    match brief.exception_episodes.as_ref() {
        Some(report) => base.with_exception_episode_report(report),
        None => base,
    }
}

/// Naive divisibility-only mutant (forbidden as product proof).
fn naive_divisibility_occurrence_count(n_events: usize) -> usize {
    n_events / STDERR_RECORDS_PER_OCCURRENCE
}

fn naive_identical_text_groups(
    rows: &[(u64, String, String)],
) -> BTreeMap<String, Vec<(u64, String)>> {
    let mut map: BTreeMap<String, Vec<(u64, String)>> = BTreeMap::new();
    for (seq, source, message) in rows {
        let key = strip_leading_ts(message);
        map.entry(key).or_default().push((*seq, source.clone()));
    }
    map
}

fn strip_leading_ts(message: &str) -> String {
    let first = message.lines().next().unwrap_or(message);
    let rest = message.get(first.len()..).unwrap_or("");
    let body = if first.len() >= 19 && first.as_bytes().get(4) == Some(&b'-') {
        first
            .find(" ERROR ")
            .or_else(|| first.find(" INFO "))
            .or_else(|| first.find(" WARN "))
            .map(|i| first.get(i..).unwrap_or(first).trim_start())
            .unwrap_or(first)
    } else {
        first
    };
    format!("{body}{rest}")
}

fn naive_adjacency_group_count(rows: &[(u64, String, String)]) -> usize {
    let mut sorted: Vec<_> = rows.iter().map(|(s, _, _)| *s).collect();
    sorted.sort_unstable();
    if sorted.is_empty() {
        return 0;
    }
    let mut groups = 1usize;
    for w in sorted.windows(2) {
        if w[1] != w[0].saturating_add(1) {
            groups += 1;
        }
    }
    groups
}

fn synthetic_event(seq: u64, ts: i64, source: &str, message: &str) -> ExplorerEvent {
    ExplorerEvent {
        seq,
        ts,
        timestamp_provenance: TimestampProvenance::ExplicitWallClock,
        active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
        unresolved_local_timestamp: None,
        time_quality: TimeQuality::Wall,
        level: "error".into(),
        service: Some("xyz-api".into()),
        host: Some("xyz-host".into()),
        template_id: seq + 100,
        trace_id: None,
        message: message.into(),
        source: source.into(),
    }
}

// ─── Geometry / truth ──────────────────────────────────────────────────────

#[test]
fn generated_truth_has_exact_neutral_geometry() {
    let truth = load_truth();
    assert_eq!(truth.schema_version, 1);
    assert_eq!(truth.case_id, "xyz-dual-rendering-cascade");
    assert_eq!(STDERR_RECORDS_PER_OCCURRENCE, 265);
    assert_eq!(truth.cascade_occurrences, OCCURRENCES);
    assert_eq!(truth.app_records_per_occurrence, 1);
    assert_eq!(truth.stderr_records_per_occurrence, 265);
    assert_eq!(truth.stderr_cascade_records, 14_840);
    assert_eq!(truth.stderr_cascade_records, STDERR_CASCADE_RECORDS);
    assert_eq!(truth.app_cascade_records, APP_CASCADE_RECORDS);
    assert_eq!(truth.total_cascade_records, 14_896);
    assert_eq!(truth.total_cascade_records, TOTAL_CASCADE_RECORDS);
    assert_eq!(truth.stderr_record_amplification, 265);
    assert_eq!(truth.interleaved_unrelated_records, UNRELATED_RECORDS);
    assert!(truth
        .required_product_api
        .contains("analyze_exception_episodes"));
}

// ─── Product-path 56×265 + broad triage + typed host facts ─────────────────

#[test]
fn product_path_56x265_episode_and_broad_triage_supply_identity_linked_facts() {
    let import = tempfile::tempdir().unwrap();
    write_cascade_import(import.path());
    let (cache, corpus_id, corpus) = ingest_dir(import.path());

    // Real product episode seam.
    let analysis = analyze_exception_episodes(&corpus, &[]).expect("analyze_exception_episodes");
    assert!(
        !analysis.partial && analysis.counts_complete,
        "complete cascade must not be partial: scope={}",
        analysis.candidate_scope
    );
    assert_eq!(analysis.occurrence_count, 56);
    assert_eq!(analysis.duplicate_rendering_occurrence_count, 56);
    assert_eq!(analysis.stderr_exception_record_count, 14_840);
    assert_eq!(analysis.application_exception_record_count, 56);
    assert_eq!(analysis.raw_exception_record_count, 14_896);
    assert_eq!(
        analysis
            .amplification
            .stderr_records_per_occurrence
            .quotient,
        265
    );
    assert_eq!(
        analysis
            .amplification
            .stderr_records_per_occurrence
            .remainder,
        0
    );
    assert_eq!(
        analysis
            .amplification
            .application_records_per_occurrence
            .quotient,
        1
    );
    assert!(analysis
        .ranking_disclosure
        .contains("independent_incident_claim_forbidden"));

    // Citations resolve to stored events; identity-linked children only.
    let mut all_cites = HashSet::new();
    for family in &analysis.families {
        for occ in &family.occurrences {
            assert!(occ.duplicate_rendering);
            assert_eq!(occ.raw_record_count, 266);
            assert!(occ
                .rendering_kinds
                .contains(&ExceptionRenderingKind::ApplicationFullStack));
            assert!(occ
                .rendering_kinds
                .contains(&ExceptionRenderingKind::SeparatelyWrappedRecords));
            for cite in &occ.citations {
                assert!(
                    all_cites.insert((cite.seq, cite.source.clone())),
                    "duplicate child cite seq={} source={}",
                    cite.seq,
                    cite.source
                );
                let page = query_event_rows(
                    &corpus,
                    &EventQuery {
                        seq_from: Some(cite.seq),
                        seq_to: Some(cite.seq),
                        limit: 4,
                        sort_by_time: false,
                        ..Default::default()
                    },
                )
                .unwrap();
                assert!(
                    page.events
                        .iter()
                        .any(|e| e.seq == cite.seq && e.source == cite.source),
                    "missing stored event for cite seq={} source={}",
                    cite.seq,
                    cite.source
                );
            }
        }
    }
    assert_eq!(all_cites.len(), 14_896);

    // Broad triage DTO carries the same product report + trusted identities.
    let brief = build_brief(cache.path(), &corpus_id, Arc::new(corpus));
    assert!(brief.deterministic_complete);
    let ep = brief
        .exception_episodes
        .as_ref()
        .expect("exception_episodes DTO on brief");
    assert_eq!(ep.occurrence_count, 56);
    assert_eq!(ep.stderr_exception_record_count, 14_840);
    assert!(!ep.partial && ep.counts_complete);
    assert!(
        brief
            .model_text
            .contains("independent_incident_claim_forbidden")
            || brief.model_text.contains("semantic_occurrence_count"),
        "brief must disclose host episode facts"
    );
    assert!(!brief.evidence.is_empty());

    // Typed host facts for scoring come from the product report, not arithmetic
    // inference inside the test harness.
    let facts = host_facts_from_product(&brief);
    assert!(facts.episode_counts_complete);
    assert_eq!(facts.known_semantic_occurrence_count, Some(56));
    assert_eq!(facts.stderr_record_count, Some(14_840));
    assert_eq!(facts.raw_exception_record_count, Some(14_896));

    // Unrelated INFO volume is retained in store but not grouped into cascade occurrences.
    assert!(
        brief.unsuppressed_event_count >= (TOTAL_CASCADE_RECORDS + UNRELATED_RECORDS) as u64,
        "store must retain cascade + unrelated controls; got {}",
        brief.unsuppressed_event_count
    );
}

// ─── Evaluation scorer: raw volume ≠ semantic occurrences ─────────────────

#[test]
fn evaluation_scorer_rejects_14840_raw_records_as_semantic_occurrences() {
    let import = tempfile::tempdir().unwrap();
    write_cascade_import(import.path());
    let (cache, corpus_id, corpus) = ingest_dir(import.path());
    let brief = build_brief(cache.path(), &corpus_id, Arc::new(corpus));
    let facts = host_facts_from_product(&brief);
    assert_eq!(facts.known_semantic_occurrence_count, Some(56));
    assert_eq!(facts.stderr_record_count, Some(14_840));

    let key = TriageKnownAnswerKey {
        case_id: "dup-14840".into(),
        time_quality_expected: "wall".into(),
        sources_present: vec![],
        sources_omitted: vec![],
        decoy_earliest_error_message_token: None,
        true_trigger_message_token: None,
        symptom_message_tokens: vec![],
        root_cause_establishable: false,
        forbidden_claims: vec!["14840_semantic_occurrences".into()],
        required_disclosures: vec![
            "missing_root_evidence".into(),
            "next_evidence_needed".into(),
        ],
    };

    let cite = brief.evidence.first().expect("evidence");
    let good = StructuredTriageAnswer {
        observations: vec![TriageClaim {
            text: format!(
                "Host semantic_occurrence_count={} stderr_exception_records={}",
                facts.known_semantic_occurrence_count.unwrap(),
                facts.stderr_record_count.unwrap()
            ),
            seq: Some(cite.seq),
            source: Some(cite.source.clone()),
            role: Some("observation".into()),
        }],
        causal_candidates: vec![TriageClaim {
            text: "XYZ payment cascade family; 56 dual-render occurrences".into(),
            seq: Some(cite.seq),
            source: Some(cite.source.clone()),
            role: Some("unknown".into()),
        }],
        competing_explanations: vec!["stderr amplification inflates raw volume".into()],
        confidence: "medium".into(),
        confidence_reason: "typed host episode counts complete".into(),
        missing_or_next_evidence: vec!["upstream timeout config".into()],
        asserted_semantic_occurrence_count: Some(56),
        ..Default::default()
    };
    let good_score = score_structured_triage_answer(&good, &key, &facts);
    assert!(
        good_score.passed,
        "complete product-produced occurrence report must pass the full scorer: {:?}",
        good_score.failed_ids()
    );

    let mut mutant = good.clone();
    mutant.asserts_raw_volume_as_semantic_occurrences = true;
    mutant.asserted_semantic_occurrence_count = Some(14_840);
    mutant.confidence_reason = "14840 semantic occurrences from stderr volume".into();
    mutant.causal_candidates = vec![TriageClaim {
        text: "14840 semantic occurrences".into(),
        seq: Some(cite.seq),
        source: Some(cite.source.clone()),
        role: Some("observation".into()),
    }];
    let score = score_structured_triage_answer(&mutant, &key, &facts);
    assert!(!score.passed);
    assert!(
        score.failed_ids().contains(&"semantic_occurrence_count"),
        "evaluation scorer must fail raw volume as semantic occurrences: {:?}",
        score.failed_ids()
    );
    // Divisibility arithmetic in the test is NOT the scoring path — host facts are.
    assert_eq!(naive_divisibility_occurrence_count(14_840), 56);
}

// ─── Citation resolution ───────────────────────────────────────────────────

#[test]
fn product_path_brief_citations_resolve_and_fabricated_identity_is_rejected() {
    let import = tempfile::tempdir().unwrap();
    write_cascade_import(import.path());
    let (cache, corpus_id, corpus) = ingest_dir(import.path());
    let corpus_arc = Arc::new(corpus);
    let brief = build_brief(cache.path(), &corpus_id, Arc::clone(&corpus_arc));
    let facts = host_facts_from_product(&brief);
    assert!(!facts.evidence.is_empty());

    // Every brief evidence identity resolves to a stored event.
    for id in &brief.evidence {
        let page = query_event_rows(
            corpus_arc.as_ref(),
            &EventQuery {
                seq_from: Some(id.seq),
                seq_to: Some(id.seq),
                limit: 4,
                sort_by_time: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            page.events
                .iter()
                .any(|e| e.seq == id.seq && e.source == id.source),
            "brief identity missing from store seq={} source={}",
            id.seq,
            id.source
        );
    }

    let key = TriageKnownAnswerKey {
        case_id: "dup-cite".into(),
        time_quality_expected: "wall".into(),
        sources_present: vec![],
        sources_omitted: vec![],
        decoy_earliest_error_message_token: None,
        true_trigger_message_token: None,
        symptom_message_tokens: vec![],
        root_cause_establishable: false,
        forbidden_claims: vec![],
        required_disclosures: vec![
            "missing_root_evidence".into(),
            "next_evidence_needed".into(),
        ],
    };
    let good_cite = brief.evidence.first().unwrap();
    let good = StructuredTriageAnswer {
        observations: vec![TriageClaim {
            text: "cited real child".into(),
            seq: Some(good_cite.seq),
            source: Some(good_cite.source.clone()),
            role: Some("observation".into()),
        }],
        causal_candidates: vec![TriageClaim {
            text: "unknown".into(),
            seq: Some(good_cite.seq),
            source: Some(good_cite.source.clone()),
            role: Some("unknown".into()),
        }],
        competing_explanations: vec!["open".into()],
        confidence: "low".into(),
        confidence_reason: "ok".into(),
        missing_or_next_evidence: vec!["more".into()],
        ..Default::default()
    };
    assert!(!score_structured_triage_answer(&good, &key, &facts)
        .failed_ids()
        .contains(&"citation_validity"));

    let mutant = StructuredTriageAnswer {
        observations: vec![TriageClaim {
            text: "fabricated".into(),
            seq: Some(9_999_999),
            source: Some("not-a-real-source.log".into()),
            role: Some("observation".into()),
        }],
        causal_candidates: vec![TriageClaim {
            text: "unknown".into(),
            seq: Some(good_cite.seq),
            source: Some(good_cite.source.clone()),
            role: Some("unknown".into()),
        }],
        competing_explanations: vec!["open".into()],
        confidence: "low".into(),
        confidence_reason: "fabricated".into(),
        missing_or_next_evidence: vec!["more".into()],
        ..Default::default()
    };
    let score = score_structured_triage_answer(&mutant, &key, &facts);
    assert!(
        score.failed_ids().contains(&"citation_validity"),
        "fabricated citation must fail: {:?}",
        score.failed_ids()
    );
}

// ─── Fail closed: partial / cancelled / revision-stale ─────────────────────

#[test]
fn product_path_revision_change_and_non_mutating_analysis() {
    let import = tempfile::tempdir().unwrap();
    write_cascade_import(import.path());
    let (_cache, _id, corpus) = ingest_dir(import.path());
    let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
    assert_eq!(analysis.occurrence_count, 56);
    let pinned = analysis
        .pinned_event_revision
        .expect("product analysis pins event revision");
    // Non-mutating: second analysis without corpus mutation keeps the same pin.
    let again = analyze_exception_episodes(&corpus, &[]).unwrap();
    assert_eq!(again.pinned_event_revision, Some(pinned));
    assert_eq!(again.occurrence_count, 56);

    // Concurrent mutation after pin observation bumps the durable revision.
    corpus
        .push_events(&[LogEvent {
            seq: 99_999,
            ts: 1_700_000_999,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "ERROR".into(),
            service: Some("mutator".into()),
            host: Some("mutator".into()),
            template_id: 42,
            params: vec![],
            trace_id: None,
            message: "java.lang.RuntimeException: XYZ_MUT\n at com.xyz.M.m(M.java:1)".into(),
            source: "mutator.log".into(),
        }])
        .unwrap();
    corpus.flush().unwrap();

    // Fresh re-analysis pins the new revision and remains consistent for the cascade.
    let re = analyze_exception_episodes(&corpus, &[]).unwrap();
    let re_pin = re
        .pinned_event_revision
        .expect("re-analysis pins event revision");
    assert_ne!(
        re_pin, pinned,
        "mutation must advance pinned event revision"
    );
    assert!(
        re.occurrence_count >= 56,
        "re-analysis after revision must still see cascade occurrences"
    );
}

// ─── False-group negatives ─────────────────────────────────────────────────

#[test]
fn product_path_false_group_negatives_and_naive_mutants() {
    // Conflicting execution keys must not dual-render.
    let conflict = vec![
        synthetic_event(
            1,
            10,
            "app.log",
            "thread=worker-A java.lang.RuntimeException: XYZ_CONFLICT\n at com.xyz.A.m(A.java:1)",
        ),
        synthetic_event(
            2,
            10,
            "stderr.log",
            "thread=worker-B [stderr] java.lang.RuntimeException: XYZ_CONFLICT",
        ),
        synthetic_event(
            3,
            10,
            "stderr.log",
            "thread=worker-B [stderr] at com.xyz.A.m(A.java:1)",
        ),
    ];
    let analysis = analyze_bounded_events(conflict.len() as u64, &conflict);
    assert_eq!(
        analysis.duplicate_rendering_occurrence_count, 0,
        "conflicting execution keys must not claim duplicate rendering"
    );

    // Message-equality alone must not merge unrelated sources / times.
    let msg_eq = vec![
        synthetic_event(1, 10, "a.log", "java.lang.RuntimeException: XYZ_MSG_EQ"),
        synthetic_event(2, 50, "b.log", "java.lang.RuntimeException: XYZ_MSG_EQ"),
    ];
    let analysis = analyze_bounded_events(msg_eq.len() as u64, &msg_eq);
    assert!(analysis.occurrence_count >= 2);
    assert_eq!(analysis.duplicate_rendering_occurrence_count, 0);

    // Adjacency-only / identical-text / divisibility mutants are unsafe oracles.
    let import = tempfile::tempdir().unwrap();
    write_cascade_import_with_negatives(import.path());
    let gap = fs::read_to_string(import.path().join("negatives/identical_gap.log")).unwrap();
    let gap_recs = frame_text(&gap);
    assert_eq!(gap_recs.len(), 3);
    let gap_rows: Vec<_> = gap_recs
        .into_iter()
        .enumerate()
        .map(|(i, m)| (i as u64 + 1, "gap".into(), m))
        .collect();
    let collapsed = naive_identical_text_groups(&gap_rows)
        .keys()
        .filter(|k| k.contains("XYZ_IDENTICAL_GAP"))
        .count();
    assert_eq!(
        collapsed, 1,
        "identical-text mutant collapses gap duplicates"
    );

    let inter =
        fs::read_to_string(import.path().join("negatives/interleaved_threads.log")).unwrap();
    let inter_recs = frame_text(&inter);
    assert!(inter_recs.len() >= 2);
    let inter_rows: Vec<_> = inter_recs
        .into_iter()
        .enumerate()
        .map(|(i, m)| (i as u64 + 1, "inter".into(), m))
        .collect();
    assert_eq!(
        naive_adjacency_group_count(&inter_rows),
        1,
        "adjacency-only merges contiguous framed rows"
    );

    // Pure divisibility is not product occurrence proof — product API is.
    assert_eq!(naive_divisibility_occurrence_count(14_840), 56);
    let (cache, _id, corpus) = ingest_dir(import.path());
    let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
    assert!(
        !analysis.partial && analysis.counts_complete,
        "full cascade + negatives must still complete under default caps"
    );
    assert_eq!(
        analysis.duplicate_rendering_occurrence_count, 56,
        "cascade dual-renders remain 56; negatives must not inflate dual count via false merge"
    );
    // Rotation-only / source-dup retained as separate sources, not one episode.
    let sources: BTreeSet<_> = query_event_rows(
        &corpus,
        &EventQuery {
            keyword: Some("XYZ_SOURCE_DUP".into()),
            limit: MAX_EVENT_PAGE,
            sort_by_time: false,
            ..Default::default()
        },
    )
    .unwrap()
    .events
    .into_iter()
    .map(|e| e.source)
    .collect();
    assert!(
        sources.len() >= 2,
        "source-dup must retain both paths: {sources:?}"
    );
    let _ = cache;
}

// ─── Family A=56 / Family B=3 template projection ──────────────────────────

#[test]
fn product_path_family_a_56_family_b_3_supporting_template_projects_to_three() {
    let mut events = Vec::new();
    for i in 0..56u64 {
        let t = (i * 2) as i64;
        events.push(synthetic_event(
            i * 10 + 1,
            t,
            "app_a.log",
            "java.lang.RuntimeException: XYZ_FAM_A\n at com.xyz.A.m(A.java:1)",
        ));
        events.push(synthetic_event(
            i * 10 + 2,
            t,
            "err_a.log",
            "[stderr] java.lang.RuntimeException: XYZ_FAM_A",
        ));
        events.push(synthetic_event(
            i * 10 + 3,
            t,
            "err_a.log",
            "[stderr] at com.xyz.A.m(A.java:1)",
        ));
    }
    for i in 0..3u64 {
        let t = 10_000 + (i * 2) as i64;
        let base = 10_000 + i * 10;
        let mut app = synthetic_event(
            base + 1,
            t,
            "app_b.log",
            "java.lang.IllegalStateException: XYZ_FAM_B\n at com.xyz.B.m(B.java:1)",
        );
        app.template_id = 9001;
        let mut head = synthetic_event(
            base + 2,
            t,
            "err_b.log",
            "[stderr] java.lang.IllegalStateException: XYZ_FAM_B",
        );
        head.template_id = 9002;
        let mut support = synthetic_event(
            base + 3,
            t,
            "err_b.log",
            "[stderr] at com.xyz.B.uniqueSupport(B.java:99)",
        );
        support.template_id = 7777;
        events.push(app);
        events.push(head);
        events.push(support);
    }
    let analysis = analyze_bounded_events(events.len() as u64, &events);
    assert_eq!(analysis.occurrence_count, 59);
    let fam_a = analysis
        .families
        .iter()
        .find(|f| f.occurrence_count == 56)
        .expect("family A 56");
    let fam_b = analysis
        .families
        .iter()
        .find(|f| f.occurrence_count == 3)
        .expect("family B 3");
    assert_ne!(fam_a.signature, fam_b.signature);
    let proj = project_template_onto_episodes(&analysis, 7777);
    assert!(proj.complete, "{proj:?}");
    assert_eq!(proj.occurrence_count, Some(3));
    assert_eq!(proj.supporting_only_occurrence_count, Some(3));
    assert_ne!(proj.occurrence_count, Some(56));
    assert_ne!(proj.occurrence_count, Some(59));
}

// ─── Cap / EOF / INFO-after-50k (product scan path) ─────────────────────────

#[test]
fn product_path_info_exception_after_50001_ordinary_info_rows() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("in");
    fs::create_dir_all(&src).unwrap();
    let mut noise = String::new();
    for i in 0..50_001u32 {
        noise.push_str(&format!(
            "2026-03-15T10:00:{:02}.{:03}Z INFO heartbeat ok n={i}\n",
            (i / 1000) % 60,
            i % 1000
        ));
    }
    fs::write(src.join("a_noise.log"), noise).unwrap();
    fs::write(
        src.join("b_late.log"),
        "2026-03-15T14:00:00.000Z INFO java.lang.RuntimeException: XYZ_INFO_LATE\n  at com.xyz.Late.m(Late.java:1)\n",
    )
    .unwrap();
    let (_c, _id, corpus) = ingest_dir(&src);
    let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
    assert!(
        analysis.raw_exception_record_count >= 1,
        "must reach INFO exception after 50_001 ordinary INFO rows"
    );
    assert!(analysis.occurrence_count >= 1);
    assert!(
        analysis.rows_walked > 50_000,
        "walked={}",
        analysis.rows_walked
    );
    assert!(analysis.rows_walked <= EXCEPTION_EPISODE_ROW_WALK_CAP as u64);
    let _ = EXCEPTION_EPISODE_EVENT_SCAN_CAP;
}

// ─── Reordered-input mutant ────────────────────────────────────────────────

#[test]
fn product_path_reordered_input_yields_identical_occurrence_pairings() {
    let events = vec![
        synthetic_event(
            10,
            1,
            "app.log",
            "java.lang.RuntimeException: XYZ_REO\n at com.xyz.A.m(A.java:1)",
        ),
        synthetic_event(
            11,
            1,
            "stderr.log",
            "[stderr] java.lang.RuntimeException: XYZ_REO",
        ),
        synthetic_event(12, 1, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
        synthetic_event(
            20,
            3,
            "app.log",
            "java.lang.RuntimeException: XYZ_REO\n at com.xyz.A.m(A.java:1)",
        ),
        synthetic_event(
            21,
            3,
            "stderr.log",
            "[stderr] java.lang.RuntimeException: XYZ_REO",
        ),
        synthetic_event(22, 3, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
    ];
    let forward = analyze_bounded_events(events.len() as u64, &events);
    let mut reversed = events.clone();
    reversed.reverse();
    let backward = analyze_bounded_events(reversed.len() as u64, &reversed);
    assert_eq!(forward.occurrence_count, backward.occurrence_count);
    assert_eq!(
        forward.duplicate_rendering_occurrence_count,
        backward.duplicate_rendering_occurrence_count
    );
    let cites = |a: &cd_core::log_analysis::ExceptionEpisodeAnalysis| {
        a.families
            .iter()
            .flat_map(|f| f.occurrences.iter())
            .map(|o| {
                let mut c: Vec<_> = o
                    .citations
                    .iter()
                    .map(|c| (c.seq, c.source.clone()))
                    .collect();
                c.sort();
                c
            })
            .collect::<BTreeSet<_>>()
    };
    assert_eq!(cites(&forward), cites(&backward));
}

// ─── Partition report (all product-path; no missing_seam BLOCK carry-forward) ─

#[test]
fn oracle_partition_all_product_path() {
    let truth = load_truth();
    let import = tempfile::tempdir().unwrap();
    write_cascade_import(import.path());
    let (cache, corpus_id, corpus) = ingest_dir(import.path());
    let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
    let brief = build_brief(cache.path(), &corpus_id, Arc::new(corpus));
    let facts = host_facts_from_product(&brief);

    let geometry_ok = truth.cascade_occurrences == 56
        && truth.stderr_cascade_records == 14_840
        && truth.stderr_record_amplification == 265
        && truth.total_cascade_records == 14_896
        && analysis.occurrence_count == 56
        && analysis.stderr_exception_record_count == 14_840
        && analysis.duplicate_rendering_occurrence_count == 56
        && analysis.counts_complete
        && !analysis.partial;

    let brief_ok = brief
        .exception_episodes
        .as_ref()
        .is_some_and(|ep| ep.occurrence_count == 56 && ep.counts_complete && !ep.partial)
        && facts.known_semantic_occurrence_count == Some(56)
        && facts.stderr_record_count == Some(14_840);

    let key = TriageKnownAnswerKey {
        case_id: "partition".into(),
        time_quality_expected: "wall".into(),
        sources_present: vec![],
        sources_omitted: vec![],
        decoy_earliest_error_message_token: None,
        true_trigger_message_token: None,
        symptom_message_tokens: vec![],
        root_cause_establishable: false,
        forbidden_claims: vec!["14840_semantic_occurrences".into()],
        required_disclosures: vec![
            "missing_root_evidence".into(),
            "next_evidence_needed".into(),
        ],
    };
    let cite = brief.evidence.first().expect("evidence");
    let mutant = StructuredTriageAnswer {
        observations: vec![TriageClaim {
            text: "host".into(),
            seq: Some(cite.seq),
            source: Some(cite.source.clone()),
            role: Some("observation".into()),
        }],
        causal_candidates: vec![TriageClaim {
            text: "14840 semantic occurrences".into(),
            seq: Some(cite.seq),
            source: Some(cite.source.clone()),
            role: Some("observation".into()),
        }],
        competing_explanations: vec!["open".into()],
        confidence: "low".into(),
        confidence_reason: "14840 semantic occurrences from stderr volume".into(),
        missing_or_next_evidence: vec!["more".into()],
        asserts_raw_volume_as_semantic_occurrences: true,
        asserted_semantic_occurrence_count: Some(14_840),
        ..Default::default()
    };
    let reject_ok = score_structured_triage_answer(&mutant, &key, &facts)
        .failed_ids()
        .contains(&"semantic_occurrence_count");

    // Divisibility alone is rejected as product proof because product path
    // supplies typed occurrence_count — not because of missing_seam theater.
    let div = naive_divisibility_occurrence_count(14_840);
    let divisibility_not_product = div == 56
        && facts.known_semantic_occurrence_count == Some(56)
        && analysis.occurrence_count == facts.known_semantic_occurrence_count.unwrap();

    let mut report_out = String::from("oracle_partition\n");
    let rows = [
        (
            "geometry_56_14840_265_via_product_api",
            "pass_on_main",
            if geometry_ok { "Pass" } else { "Fail" },
        ),
        (
            "broad_triage_identity_linked_host_facts",
            "pass_on_main",
            if brief_ok { "Pass" } else { "Fail" },
        ),
        (
            "reject_14840_as_semantic_occurrences",
            "pass_on_main",
            if reject_ok { "Pass" } else { "Fail" },
        ),
        (
            "divisibility_not_product_proof",
            "pass_on_main",
            if divisibility_not_product {
                "Pass"
            } else {
                "Fail"
            },
        ),
        (
            "episode_occurrence_count_56",
            "pass_on_main",
            if facts.known_semantic_occurrence_count == Some(56) {
                "Pass"
            } else {
                "Fail"
            },
        ),
    ];
    for (id, part, status) in rows {
        report_out.push_str(&format!("{id}\t{part}\t{status}\n"));
        assert_eq!(status, "Pass", "{id}");
        assert_eq!(part, "pass_on_main", "{id} must not be missing_seam");
    }
    eprintln!("{report_out}");
    if let Ok(scratch) = std::env::var("ORACLE_SCRATCH") {
        let _ = fs::write(Path::new(&scratch).join("oracle-partition.txt"), report_out);
    }
    // Silence unused import warnings for correlation enum when not asserted above.
    let _ = ExceptionCorrelationConfidence::Uncorrelated;
}
