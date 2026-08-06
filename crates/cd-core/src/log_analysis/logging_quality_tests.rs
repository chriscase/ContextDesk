//! Hermetic + adversarial mutation tests for logging quality assessment v1.

use super::*;
use crate::log_analysis::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use crate::log_analysis::ingest::ingest_path_with_policy;
use std::fs;
use std::path::Path;
use tempfile::TempDir;

fn policy_none() -> LogEmbedPolicy {
    LogEmbedPolicy {
        mode: LogEmbedMode::None,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "test-none".into(),
        defer_above_source_bytes: None,
    }
}

fn write_tree(root: &Path, files: &[(&str, &str)]) {
    for (rel, body) in files {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }
}

fn ingest_temp(files: &[(&str, &str)]) -> (TempDir, LogCorpus) {
    let tmp = TempDir::new().unwrap();
    let src = tmp.path().join("src");
    fs::create_dir_all(&src).unwrap();
    write_tree(&src, files);
    let cache = tmp.path().join("cache");
    fs::create_dir_all(&cache).unwrap();
    let report = ingest_path_with_policy(&cache, &src, "lq-test", &policy_none(), None).unwrap();
    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    (tmp, corpus)
}

#[test]
fn empty_corpus_is_honest_and_insufficient() {
    let tmp = TempDir::new().unwrap();
    let cache = tmp.path().join("cache");
    fs::create_dir_all(&cache).unwrap();
    let corpus = LogCorpus::create(&cache, "empty-lq").unwrap();
    let a = assess_logging_quality(&corpus).unwrap();
    assert_eq!(a.schema_id, LOGGING_QUALITY_SCHEMA_ID);
    assert_eq!(a.schema_version, LOGGING_QUALITY_SCHEMA_VERSION);
    assert_eq!(a.summary.grade, LoggingQualityGrade::Insufficient);
    assert!(a.findings.iter().any(|f| f.id == "lq.corpus.empty"));
    assert!(!a.limitations.is_empty());
    assert!(a.confidence.non_claims.iter().any(|c| c.contains("LLM")));
}

#[test]
fn assessment_is_deterministic_across_calls() {
    let (_tmp, corpus) = ingest_temp(&[(
        "api/app.jsonl",
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","service":"api","trace_id":"t1","msg":"ok"}"#,
            "\n",
            r#"{"ts":"2026-01-01T12:00:01Z","level":"ERROR","service":"api","trace_id":"t1","msg":"fail"}"#,
            "\n",
            r#"{"ts":"2026-01-01T12:00:02Z","level":"INFO","service":"api","trace_id":"t2","msg":"ok"}"#,
            "\n",
        ),
    )]);
    let a = assess_logging_quality(&corpus).unwrap();
    let b = assess_logging_quality(&corpus).unwrap();
    assert_eq!(
        serde_json::to_string(&a).unwrap(),
        serde_json::to_string(&b).unwrap()
    );
}

#[test]
fn findings_have_evidence_and_fixed_hints() {
    let (_tmp, corpus) = ingest_temp(&[
        (
            "wall.jsonl",
            concat!(
                r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"a"}"#,
                "\n",
                r#"{"ts":"2026-01-01T12:00:01Z","level":"INFO","msg":"b"}"#,
                "\n",
            ),
        ),
        ("order.log", "no timestamp here\nalso none\n"),
    ]);
    let a = assess_logging_quality(&corpus).unwrap();
    assert!(!a.limitations.is_empty());
    for f in &a.findings {
        assert!(!f.evidence.is_empty(), "{}", f.id);
        assert!(!f.measured_fact.is_empty());
        assert!(!f.finding.is_empty());
        assert!(f.improvement_hint.template_id.starts_with("hint."));
        assert!(!f.improvement_hint.acceptance_criteria.is_empty());
        // Never claim confirmed noise
        assert!(!f.finding.to_lowercase().contains("confirmed noise"));
        assert!(!f
            .improvement_hint
            .change
            .to_lowercase()
            .contains("confirmed noise"));
    }
}

#[test]
fn default_report_omits_raw_bodies_and_private_paths() {
    let (_tmp, corpus) = ingest_temp(&[(
        "svc/app.jsonl",
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"password=supersecret value bearer TOKEN"}"#,
            "\n",
            r#"{"ts":"2026-01-01T12:00:01Z","level":"ERROR","msg":"api_key=abcd"}"#,
            "\n",
        ),
    )]);
    let a = assess_logging_quality(&corpus).unwrap();
    let json = serde_json::to_string_pretty(&a).unwrap();
    let lower = json.to_lowercase();
    for pat in public_assessment_denylist_patterns() {
        assert!(!lower.contains(pat), "denylist hit {pat:?} in {json}");
    }
    assert!(!json.contains("supersecret"));
    assert!(a.sources.iter().all(|s| s.source_key.starts_with("src_")));
    let md = render_logging_quality_markdown(&a);
    assert!(!md.to_lowercase().contains("supersecret"));
    assert!(!md.contains("/Users/"));
    assert!(!md.contains("/home/"));
    // Markdown is projection wording, not a free-form EIP claim
    assert!(md.contains("JSON is the source of truth"));
    assert!(!md.contains("Engineering Improvement Plan"));
}

#[test]
fn mixed_fixture_scores_time_and_sources() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/log-lab/scenarios/mixed-time-quality/import");
    let tmp = TempDir::new().unwrap();
    let cache = tmp.path().join("cache");
    fs::create_dir_all(&cache).unwrap();
    let report = ingest_path_with_policy(&cache, &fixture, "mixed", &policy_none(), None).unwrap();
    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    let a = assess_logging_quality(&corpus).unwrap();
    assert!(a.corpus.event_count > 0);
    assert!(!a.sources.is_empty());
    assert!(!a.limitations.is_empty());
    assert!(!a.metrics.stored_level.severity_provenance_available);
}

#[test]
fn grade_boundaries_are_stable() {
    assert_eq!(
        LoggingQualityGrade::from_score(90, false),
        LoggingQualityGrade::Excellent
    );
    assert_eq!(
        LoggingQualityGrade::from_score(70, false),
        LoggingQualityGrade::Good
    );
    assert_eq!(
        LoggingQualityGrade::from_score(50, false),
        LoggingQualityGrade::Fair
    );
    assert_eq!(
        LoggingQualityGrade::from_score(25, false),
        LoggingQualityGrade::Poor
    );
    assert_eq!(
        LoggingQualityGrade::from_score(90, true),
        LoggingQualityGrade::Insufficient
    );
}

#[test]
fn no_multiline_metrics_in_v1_report() {
    let (_tmp, corpus) = ingest_temp(&[(
        "a.jsonl",
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"line1\nline2"}"#,
            "\n",
        ),
    )]);
    let a = assess_logging_quality(&corpus).unwrap();
    let json = serde_json::to_string(&a).unwrap();
    assert!(!json.contains("messageNewline"));
    assert!(!json.contains("multilineHeuristic"));
    assert!(!json.contains("\"multiline\""));
    assert!(a
        .limitations
        .iter()
        .any(|l| l.to_lowercase().contains("multiline")));
}

// ─── Adversarial mutation coverage ───────────────────────────────────────────

#[test]
fn mutation_bad_time_quality_claims_rejected_by_non_claims() {
    let (_tmp, corpus) = ingest_temp(&[(
        "order.log",
        "no ts
still none
",
    )]);
    let a = assess_logging_quality(&corpus).unwrap();
    let blob = serde_json::to_string(&a).unwrap().to_lowercase();
    assert!(!blob.contains("inferred as utc"));
    assert!(!blob.contains("treat as utc"));
    assert!(a
        .confidence
        .non_claims
        .iter()
        .any(|c| c.to_lowercase().contains("calendar time")
            || c.to_lowercase().contains("order-only")
            || c.to_lowercase().contains("utc")));
    for f in &a.findings {
        assert!(!f.finding.to_lowercase().contains("root cause"));
    }
}

#[test]
fn mutation_severity_matrix_violations_fail_validation() {
    let (_tmp, corpus) = ingest_temp(&[(
        "a.jsonl",
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"x"}"#,
            "\n",
        ),
    )]);
    let mut a = assess_logging_quality(&corpus).unwrap();
    assert!(!a.metrics.stored_level.severity_provenance_available);
    // Honest report validates
    let bytes = serde_json::to_vec(&a).unwrap();
    validate_logging_quality_json(&bytes).unwrap();

    // Mutate: claim provenance available
    a.metrics.stored_level.severity_provenance_available = true;
    let bad = serde_json::to_vec(&a).unwrap();
    assert!(validate_logging_quality_json(&bad).is_err());
}

#[test]
fn mutation_partial_bucket_dishonesty_not_from_ignored() {
    let tmp = TempDir::new().unwrap();
    let src = tmp.path().join("src");
    fs::create_dir_all(src.join("api")).unwrap();
    fs::write(
        src.join("api/app.jsonl"),
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"ok"}"#,
            "\n",
        ),
    )
    .unwrap();
    fs::write(src.join(".hidden.log"), "secret noise\n").unwrap();
    fs::write(src.join("noise.bin"), [0u8, 1, 255]).unwrap();
    let cache = tmp.path().join("cache");
    fs::create_dir_all(&cache).unwrap();
    let report = ingest_path_with_policy(&cache, &src, "sel", &policy_none(), None).unwrap();
    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    let a = assess_logging_quality(&corpus).unwrap();
    // Ignored/unsupported may be >0 but must not be folded into a fabricated partial
    // when durable partial is false.
    if !a.metrics.selection.partial {
        assert!(
            !a.findings
                .iter()
                .any(|f| f.id == "lq.selection.partial_import"),
            "must not emit partial_import when durable partial=false"
        );
    }
    if a.metrics.selection.ignored > 0 || a.metrics.selection.unsupported > 0 {
        let cov = a
            .findings
            .iter()
            .find(|f| f.id == "lq.selection.coverage_buckets");
        assert!(
            cov.is_some(),
            "ignored/unsupported should surface as coverage buckets"
        );
        let text = cov.unwrap().finding.to_lowercase();
        assert!(text.contains("not classified as partial") || text.contains("not"));
    }
}

#[test]
fn mutation_confirmed_noise_wording_absent() {
    let mut body = String::new();
    for i in 0..40 {
        body.push_str(&format!(
            "{{\"ts\":\"2026-01-01T12:00:{i:02}Z\",\"level\":\"INFO\",\"msg\":\"heartbeat ok\"}}
"
        ));
    }
    body.push_str(
        "{\"ts\":\"2026-01-01T12:01:00Z\",\"level\":\"ERROR\",\"msg\":\"heartbeat ok\"}
",
    );
    let (_tmp, corpus) = ingest_temp(&[("hot.jsonl", &body)]);
    let a = assess_logging_quality(&corpus).unwrap();
    let blob = serde_json::to_string(&a).unwrap().to_lowercase();
    assert!(!blob.contains("is confirmed noise"));
    assert!(!blob.contains("confirmed as noise"));
    assert!(blob.contains("review-only") || blob.contains("proposal"));
    if let Some(f) = a
        .findings
        .iter()
        .find(|f| f.id == "lq.noise.review_only_concentration")
    {
        let fl = f.finding.to_lowercase();
        assert!(fl.contains("review-only") || fl.contains("never verified"));
        assert!(
            a.metrics.templates.top_template_error_or_fatal_count > 0
                || f.measured_fact.contains("top_error_or_fatal")
        );
    }
}

#[test]
fn mutation_secret_and_path_leaks() {
    let (_tmp, corpus) = ingest_temp(&[(
        "nested/deep/app.jsonl",
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"Authorization: Bearer ghp_leakedtoken1234567890"}"#,
            "\n",
        ),
    )]);
    let a = assess_logging_quality(&corpus).unwrap();
    let json = serde_json::to_string(&a).unwrap().to_lowercase();
    let md = render_logging_quality_markdown(&a).to_lowercase();
    for bad in [
        "ghp_leakedtoken",
        "authorization:",
        "bearer ",
        "/users/",
        "/home/",
        "nested/deep/app.jsonl",
    ] {
        assert!(!json.contains(bad), "json leaked {bad}");
        assert!(!md.contains(bad), "md leaked {bad}");
    }
}

#[test]
fn mutation_trace_without_trace_claims() {
    let (_tmp, corpus) = ingest_temp(&[(
        "a.jsonl",
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","span_id":"span-1","request_id":"req-1","msg":"x"}"#,
            "
",
            r#"{"ts":"2026-01-01T12:00:01Z","level":"INFO","span_id":"span-2","request_id":"req-2","msg":"y"}"#,
            "
",
            r#"{"ts":"2026-01-01T12:00:02Z","level":"INFO","span_id":"span-3","request_id":"req-3","msg":"z"}"#,
            "
",
            r#"{"ts":"2026-01-01T12:00:03Z","level":"INFO","span_id":"span-4","request_id":"req-4","msg":"w"}"#,
            "
",
            r#"{"ts":"2026-01-01T12:00:04Z","level":"INFO","span_id":"span-5","request_id":"req-5","msg":"v"}"#,
            "
",
            r#"{"ts":"2026-01-01T12:00:05Z","level":"INFO","span_id":"span-6","request_id":"req-6","msg":"u"}"#,
            "
",
            r#"{"ts":"2026-01-01T12:00:06Z","level":"INFO","span_id":"span-7","request_id":"req-7","msg":"t"}"#,
            "
",
            r#"{"ts":"2026-01-01T12:00:07Z","level":"INFO","span_id":"span-8","request_id":"req-8","msg":"s"}"#,
            "
",
            r#"{"ts":"2026-01-01T12:00:08Z","level":"INFO","span_id":"span-9","request_id":"req-9","msg":"r"}"#,
            "
",
            r#"{"ts":"2026-01-01T12:00:09Z","level":"INFO","span_id":"span-a","request_id":"req-a","msg":"q"}"#,
            "
",
        ),
    )]);
    let a = assess_logging_quality(&corpus).unwrap();
    assert_eq!(a.metrics.trace_id.with_trace_id, 0);
    let blob = serde_json::to_string(&a).unwrap().to_lowercase();
    assert!(!blob.contains("tracing is ready"));
    assert!(!blob.contains("\"tracing_ready\":true"));
    assert!(a
        .confidence
        .non_claims
        .iter()
        .any(|c| c.to_lowercase().contains("tracing") || c.to_lowercase().contains("trace_id")));
    assert!(a
        .findings
        .iter()
        .any(|f| f.id == "lq.trace.low_parser_trace_id_coverage"));
}

#[test]
fn mutation_count_parity_selection_and_events() {
    let (_tmp, corpus) = ingest_temp(&[
        (
            "a.jsonl",
            concat!(
                r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"1"}"#,
                "\n",
                r#"{"ts":"2026-01-01T12:00:01Z","level":"WARN","msg":"2"}"#,
                "\n",
            ),
        ),
        ("b.log", "plain one\nplain two\n"),
    ]);
    let a = assess_logging_quality(&corpus).unwrap();
    assert_eq!(
        a.corpus.event_count,
        a.metrics.wall_event_count + a.metrics.order_only_event_count
    );
    assert_eq!(
        a.corpus.event_count,
        a.metrics.stored_level.known_level_count + a.metrics.stored_level.unknown_level_count
    );
    let source_sum: u64 = a.sources.iter().map(|s| s.event_count).sum();
    assert_eq!(source_sum, a.corpus.event_count);
    // selected_imported is files, not events — just ensure non-zero when events exist
    assert!(a.metrics.selection.selected_imported >= 1);
}

#[test]
fn mutation_empty_limitations_rejected() {
    let (_tmp, corpus) = ingest_temp(&[(
        "a.jsonl",
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"x"}"#,
            "\n",
        ),
    )]);
    let mut a = assess_logging_quality(&corpus).unwrap();
    assert!(!a.limitations.is_empty());
    a.limitations.clear();
    let bad = serde_json::to_vec(&a).unwrap();
    let err = validate_logging_quality_json(&bad).unwrap_err();
    assert!(err.to_string().contains("limitations"));
}

#[test]
fn markdown_is_pure_projection_of_json() {
    let (_tmp, corpus) = ingest_temp(&[(
        "a.jsonl",
        concat!(
            r#"{"ts":"2026-01-01T12:00:00Z","level":"ERROR","trace_id":"t","msg":"x"}"#,
            "\n",
        ),
    )]);
    let a = assess_logging_quality(&corpus).unwrap();
    let md = render_logging_quality_markdown(&a);
    assert!(md.contains(&a.corpus.id));
    assert!(md.contains(a.summary.grade.as_str()));
    for f in &a.findings {
        assert!(md.contains(&f.id));
        assert!(md.contains(&f.improvement_hint.template_id));
    }
}
