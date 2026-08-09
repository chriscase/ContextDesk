//! Retrieval-ablation lab — deterministic hidden-truth benchmark for the
//! incremental value of structured/keyword retrieval, semantic embeddings,
//! reranking, and bounded multi-stage analysis.
//!
//! Small tier runs in default CI. Medium/large tiers are explicit `--ignored`
//! commands documented in `docs/benchmarks/MULTI_MODEL_RETRIEVAL_BENCHMARK.md`
//! (they do not gate CI). No test here needs network, credentials, or models.

#[path = "support/log_lab_generator.rs"]
mod lab;

use lab::{
    assemble_report, candidate_matches_group, generate_retrieval_ablation, load_ra_queries,
    load_ra_suite, load_ra_truth, ra_case_import_root, ra_case_specs, ra_import_case,
    ra_observe_corpus, ra_semantic_truth_digest, ra_triage_key, run_mode_for_case, score_case_mode,
    unavailable_run_record, validate_conservation, validate_run_record, LabResult, RaCallCounts,
    RaCaseInputs, RaEngineManifest, RaImportedCase, RaMode, RaModeStatus, RaPartition, RaQuerySet,
    RaReport, RaRng, RaRunRecord, RaStructuredKeywordAdapter, RaTier, RaTruthManifest, RaViolation,
    RA_DEFAULT_SEED, RA_K, RA_SUITE_REL_ROOT, V_COMPLETENESS_OVERCLAIM, V_DEGENERATE_STRATEGY,
    V_DUPLICATE_TRIALS, V_IDENTITY_OMITTED, V_K_SUBSTITUTION, V_MODE_MISLABEL,
    V_NON_PROGRESS_DIVERGENCE, V_PROVENANCE_OMITTED, V_TIER_SUBSTITUTION, V_UNAVAILABLE_AS_PASS,
};

use cd_core::embed::EmbedBackend;
use cd_core::log_analysis::{query_event_count, query_event_rows, EventQuery, MAX_EVENT_PAGE};
use cd_core::triage_quality::{
    score_structured_triage_answer, StructuredTriageAnswer, TriageClaim, TriageHostFacts,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Roots and shared state
// ---------------------------------------------------------------------------

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/log-lab")
}

/// Suite root under test. Defaults to the committed fixtures; the pinning
/// workflow and the ignored medium/large runners point this at a generated
/// tree via `CD_RA_SUITE_ROOT`. Substituted corpora are still caught by the
/// corpus-identity disclosures in every report.
fn ra_root() -> PathBuf {
    match std::env::var("CD_RA_SUITE_ROOT") {
        Ok(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => fixture_root(),
    }
}

fn require_suite_root() -> PathBuf {
    let root = ra_root();
    let suite = root.join(RA_SUITE_REL_ROOT).join("suite.json");
    assert!(
        suite.is_file(),
        "required retrieval-ablation fixtures are missing or unreadable at {} — generate with \
         `cargo run -p cd-core --example generate_log_lab -- --profile retrieval-ablation --tier small --output <log-lab-root>` \
         (tests never silently self-skip)",
        suite.display()
    );
    root
}

fn contextdesk_sha() -> String {
    std::env::var("CD_GIT_SHA").unwrap_or_else(|_| "unknown-dev-build".into())
}

struct CaseBundle {
    truth: RaTruthManifest,
    queries: RaQuerySet,
    imported: RaImportedCase,
    observed: lab::RaObservedCorpus,
    records: Vec<RaRunRecord>,
}

fn bundles() -> &'static Mutex<BTreeMap<String, Arc<CaseBundle>>> {
    static BUNDLES: OnceLock<Mutex<BTreeMap<String, Arc<CaseBundle>>>> = OnceLock::new();
    BUNDLES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn bundle(case_id: &str) -> Arc<CaseBundle> {
    let mut map = bundles().lock().expect("bundle lock");
    if let Some(existing) = map.get(case_id) {
        return existing.clone();
    }
    let root = require_suite_root();
    let built = build_bundle(&root, case_id).unwrap_or_else(|error| {
        panic!("failed to build case bundle {case_id}: {error}");
    });
    let arc = Arc::new(built);
    map.insert(case_id.to_string(), arc.clone());
    arc
}

fn build_bundle(root: &Path, case_id: &str) -> LabResult<CaseBundle> {
    let truth = load_ra_truth(root, case_id)?;
    let queries = load_ra_queries(root, case_id)?;
    let import_root = ra_case_import_root(root, case_id);
    let imported = ra_import_case(case_id, &import_root)?;
    let observed = ra_observe_corpus(&truth, &imported)?;

    let baseline = RaStructuredKeywordAdapter {
        contextdesk_sha: contextdesk_sha(),
    };
    let mut records = vec![run_mode_for_case(
        &baseline,
        &imported,
        &queries,
        &truth.tier,
        truth.seed,
        truth.expected.events,
        &truth.import_tree_sha256,
        None,
    )?];
    for future in lab::ra_future_adapters() {
        records.push(unavailable_run_record(
            future.mode,
            future.reason,
            future.intended_engine,
            &imported,
            &queries,
            &truth.tier,
            truth.seed,
            truth.expected.events,
            &truth.import_tree_sha256,
        ));
    }
    Ok(CaseBundle {
        truth,
        queries,
        imported,
        observed,
        records,
    })
}

fn all_case_ids() -> Vec<&'static str> {
    ra_case_specs().iter().map(|spec| spec.case_id).collect()
}

fn full_report() -> &'static RaReport {
    static REPORT: OnceLock<RaReport> = OnceLock::new();
    REPORT.get_or_init(|| {
        let root = require_suite_root();
        let suite = load_ra_suite(&root).expect("suite manifest");
        let mut cases = Vec::new();
        for case_id in all_case_ids() {
            let bundle = bundle(case_id);
            cases.push(RaCaseInputs {
                truth: bundle.truth.clone(),
                queries: bundle.queries.clone(),
                observed: bundle.observed.clone(),
                records: bundle.records.clone(),
            });
        }
        assemble_report(&contextdesk_sha(), &suite, &cases, None)
    })
}

// ---------------------------------------------------------------------------
// Generator self-test (fast)
// ---------------------------------------------------------------------------

#[test]
fn generator_self_test_fast() {
    assert_eq!(ra_case_specs().len(), 20);
    assert_eq!(RaTier::Small.noise_multiplier(), 1);
    assert_eq!(RaTier::Medium.noise_multiplier(), 28);
    assert_eq!(RaTier::Large.noise_multiplier(), 124);
    // SplitMix64 stream stability: these exact values must never change or
    // every committed manifest silently drifts.
    let mut rng = RaRng::new(RA_DEFAULT_SEED);
    assert_eq!(rng.next_u64(), 4_187_384_828_358_846_019);
    assert_eq!(rng.next_u64(), 8_005_981_190_941_779_756);
    let epoch = lab::ra_suite_epoch(RA_DEFAULT_SEED);
    assert!((lab::RA_BASE_TS - lab::RA_SEED_JITTER_BOUND_SECS
        ..=lab::RA_BASE_TS + lab::RA_SEED_JITTER_BOUND_SECS)
        .contains(&epoch));
    assert_eq!(epoch % 60, 0, "suite epoch is minute-quantised");
    assert_eq!(
        lab::ra_iso_utc(1_740_000_000, 7),
        "2025-02-19T21:20:00.007Z"
    );
    let tier = RaTier::parse("medium").expect("tier");
    assert_eq!(tier.as_str(), "medium");
    assert!(RaTier::parse("gigantic").is_err());
    assert!(RaMode::parse("structured_keyword").is_ok());
    assert!(RaMode::parse("vibes").is_err());
}

// ---------------------------------------------------------------------------
// Frozen determinism and safety
// ---------------------------------------------------------------------------

#[test]
fn small_generation_is_frozen_deterministic_and_safe() {
    let committed_root = require_suite_root();
    let committed = load_ra_suite(&committed_root).expect("committed suite manifest");
    assert_eq!(committed.tier, "small", "committed tier must be small");
    assert_eq!(
        committed.seed, RA_DEFAULT_SEED,
        "committed seed must be the default"
    );

    let first = tempfile::tempdir().expect("tmp");
    let second = tempfile::tempdir().expect("tmp");
    let summary_a = generate_retrieval_ablation(first.path(), RaTier::Small, RA_DEFAULT_SEED)
        .expect("generate A");
    let summary_b = generate_retrieval_ablation(second.path(), RaTier::Small, RA_DEFAULT_SEED)
        .expect("generate B");
    assert_eq!(
        summary_a.corpus_identity_sha256,
        summary_b.corpus_identity_sha256
    );
    assert_eq!(
        lab::tree_hashes(&first.path().join(RA_SUITE_REL_ROOT)).expect("hashes A"),
        lab::tree_hashes(&second.path().join(RA_SUITE_REL_ROOT)).expect("hashes B"),
        "same seed must be byte-for-byte identical"
    );

    // Regenerated output must match the committed tree exactly, including the
    // schema contract documents.
    assert_eq!(
        summary_a.corpus_identity_sha256, committed.corpus_identity_sha256,
        "regenerated corpus identity diverged from the committed suite — never update the \
         committed hash merely to go green; explain the generator change"
    );
    // The committed subtree additionally holds reports/ (pinned baseline
    // outputs, not generator products); every generator-emitted byte must
    // match and nothing else may exist besides reports/.
    let generated_hashes =
        lab::tree_hashes(&first.path().join(RA_SUITE_REL_ROOT)).expect("hashes A");
    let committed_hashes: BTreeMap<String, String> =
        lab::tree_hashes(&committed_root.join(RA_SUITE_REL_ROOT))
            .expect("committed hashes")
            .into_iter()
            .filter(|(rel, _)| !rel.starts_with("reports/"))
            .collect();
    assert_eq!(generated_hashes, committed_hashes);
    for (name, _) in lab::ra_schema_documents() {
        let generated =
            std::fs::read(first.path().join("schema").join(name)).expect("generated schema");
        let checked_in = std::fs::read(committed_root.join("schema").join(name))
            .unwrap_or_else(|_| panic!("committed schema {name} missing"));
        assert_eq!(generated, checked_in, "schema document {name} drifted");
    }
}

#[test]
fn different_seed_keeps_semantic_truth_and_changes_neutral_surface() {
    let committed_root = require_suite_root();
    let committed = load_ra_suite(&committed_root).expect("suite");
    let other = tempfile::tempdir().expect("tmp");
    let summary = generate_retrieval_ablation(other.path(), RaTier::Small, RA_DEFAULT_SEED + 1)
        .expect("generate other seed");
    let other_suite = load_ra_suite(other.path()).expect("other suite");

    assert_ne!(
        summary.corpus_identity_sha256,
        committed.corpus_identity_sha256
    );
    assert_eq!(
        other_suite.semantic_suite_digest, committed.semantic_suite_digest,
        "a seed change must never change semantic truth"
    );
    assert_eq!(other_suite.total_events, committed.total_events);

    // Neutral identities differ; semantic digests agree case by case.
    for case_id in [
        "rb01-lexical-easy",
        "rb09-time-uncertainty",
        "rb20-partial-corpus",
    ] {
        let committed_truth = load_ra_truth(&committed_root, case_id).expect("committed truth");
        let other_truth = load_ra_truth(other.path(), case_id).expect("other truth");
        assert_eq!(
            committed_truth.semantic_truth_digest,
            other_truth.semantic_truth_digest
        );
        assert_ne!(
            committed_truth.import_tree_sha256,
            other_truth.import_tree_sha256
        );
        let committed_token = &committed_truth.evidence_groups[0].token;
        let other_token = &other_truth.evidence_groups[0].token;
        if committed_truth.evidence_groups[0]
            .token
            .chars()
            .any(|c| c.is_ascii_hexdigit())
        {
            assert_ne!(
                committed_token, other_token,
                "neutral tokens must vary with the seed"
            );
        }
        // Recomputing the digest from the manifest must agree with the stored
        // value (no hand-edited manifests).
        assert_eq!(
            ra_semantic_truth_digest(&other_truth).expect("digest"),
            other_truth.semantic_truth_digest
        );
    }
}

// ---------------------------------------------------------------------------
// Truth isolation
// ---------------------------------------------------------------------------

fn scan_tree_for_markers(root: &Path, markers: &[String]) -> Vec<String> {
    let mut findings = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current).expect("readable import tree") {
            let entry = entry.expect("entry");
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let bytes = std::fs::read(&path).expect("readable file");
            let text = String::from_utf8_lossy(&bytes);
            for marker in markers {
                if text.contains(marker.as_str()) {
                    findings.push(format!("{}: contains `{marker}`", path.display()));
                }
            }
        }
    }
    findings
}

fn truth_markers(truth: &RaTruthManifest) -> Vec<String> {
    let mut markers: Vec<String> = truth
        .evidence_groups
        .iter()
        .map(|group| group.group_id.clone())
        .collect();
    markers.push(lab::RA_TRUTH_SCHEMA_ID.to_string());
    markers.push("evaluator_only".into());
    markers.push("answer_key".into());
    markers.push("semantic_truth_digest".into());
    markers
}

#[test]
fn evaluator_truth_never_reaches_model_visible_input() {
    let root = require_suite_root();
    for case_id in all_case_ids() {
        let truth = load_ra_truth(&root, case_id).expect("truth");
        let import_root = ra_case_import_root(&root, case_id);
        let findings = scan_tree_for_markers(&import_root, &truth_markers(&truth));
        assert!(
            findings.is_empty(),
            "{case_id}: evaluator truth leaked into model input:\n{}",
            findings.join("\n")
        );
    }

    // The imported durable store must be equally clean: group ids and the
    // truth schema id must have zero matches through production search.
    let sample = bundle("rb01-lexical-easy");
    let corpus = sample.imported.open().expect("corpus");
    for marker in truth_markers(&sample.truth) {
        let query = EventQuery {
            keyword: Some(marker.clone()),
            ..Default::default()
        };
        let count = query_event_count(&corpus, &query).expect("count");
        assert_eq!(
            count.total_matched, 0,
            "marker `{marker}` is searchable in the imported corpus"
        );
    }
}

#[test]
fn truth_leaked_into_import_is_caught_by_the_scanner() {
    // Booby-trap (mutation M1): copying the evaluator manifest into a COPY of
    // the import tree must be detected by the same scanner that just proved
    // isolation — so "scanner finds nothing" can never be a silent no-op.
    let root = require_suite_root();
    let case_id = "rb01-lexical-easy";
    let truth = load_ra_truth(&root, case_id).expect("truth");
    let source = ra_case_import_root(&root, case_id);
    let tmp = tempfile::tempdir().expect("tmp");
    copy_tree(&source, tmp.path());
    std::fs::write(
        tmp.path().join("api/leaked-answer-key.json"),
        serde_json::to_vec_pretty(&serde_json::to_value(&truth).expect("json")).expect("bytes"),
    )
    .expect("write leak");
    let findings = scan_tree_for_markers(tmp.path(), &truth_markers(&truth));
    assert!(
        !findings.is_empty(),
        "the isolation scanner failed to catch a planted truth leak"
    );
}

fn copy_tree(from: &Path, to: &Path) {
    let mut stack = vec![from.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current).expect("readdir") {
            let entry = entry.expect("entry");
            let path = entry.path();
            let rel = path.strip_prefix(from).expect("prefix");
            let dest = to.join(rel);
            if path.is_dir() {
                std::fs::create_dir_all(&dest).expect("mkdir");
                stack.push(path);
            } else {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent).expect("mkdir");
                }
                std::fs::copy(&path, &dest).expect("copy");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Import conservation across all cases
// ---------------------------------------------------------------------------

#[test]
fn production_import_conserves_every_case_geometry() {
    let mut failures = Vec::new();
    for case_id in all_case_ids() {
        let bundle = bundle(case_id);
        let violations = validate_conservation(&bundle.truth, &bundle.observed);
        let expected: &[&str] = expected_conservation_codes(case_id);
        let observed_codes: Vec<&str> = violations
            .iter()
            .map(|violation| violation.code.as_str())
            .collect();
        if observed_codes != expected {
            failures.push(format!(
                "{case_id}: conservation codes {observed_codes:?}, pinned {expected:?}\n  {}",
                violations
                    .iter()
                    .map(|violation| violation.detail.clone())
                    .collect::<Vec<_>>()
                    .join("\n  ")
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// Pinned conservation findings on the current production pipeline. An empty
/// slice means the importer agrees exactly with truth. Non-empty entries are
/// HONEST open findings (documented in the benchmark doc); fixing the product
/// or the generator must update this table deliberately.
const PINNED_CONSERVATION_FINDINGS: &[(&str, &[&str])] = &[];

fn expected_conservation_codes(case_id: &str) -> &'static [&'static str] {
    PINNED_CONSERVATION_FINDINGS
        .iter()
        .find(|(pinned_case, _)| *pinned_case == case_id)
        .map(|(_, codes)| *codes)
        .unwrap_or(&[])
}

// ---------------------------------------------------------------------------
// Baseline report and partition
// ---------------------------------------------------------------------------

#[test]
fn baseline_small_tier_report_matches_committed_golden() {
    let report = full_report();
    let normalized = report.normalized_for_golden();

    // Machine-readable + human-readable copies for inspection on every run.
    let out_dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("retrieval-ablation");
    std::fs::create_dir_all(&out_dir).expect("out dir");
    std::fs::write(
        out_dir.join("small-structured_keyword.report.json"),
        serde_json::to_vec_pretty(&serde_json::to_value(report).expect("json")).expect("bytes"),
    )
    .expect("write report");
    std::fs::write(
        out_dir.join("small-structured_keyword.report.md"),
        report.to_projection_markdown(),
    )
    .expect("write markdown");

    let committed_path = require_suite_root()
        .join(RA_SUITE_REL_ROOT)
        .join("reports/baseline/small-structured_keyword.report.json");
    assert!(
        committed_path.is_file(),
        "committed baseline report missing at {} (current run written to {})",
        committed_path.display(),
        out_dir.display()
    );
    let committed: RaReport =
        serde_json::from_slice(&std::fs::read(&committed_path).expect("committed report readable"))
            .expect("committed report parses");
    let committed_normalized = committed.normalized_for_golden();
    assert_eq!(
        serde_json::to_value(&normalized).expect("json"),
        serde_json::to_value(&committed_normalized).expect("json"),
        "baseline report drifted from the committed golden (fresh copy at {}). Never update the \
         golden merely to go green; explain the change",
        out_dir.display()
    );
}

#[test]
fn oracle_partition_retrieval_ablation() {
    let report = full_report();
    // Exactly one classification per (case, mode).
    let total: u64 = report.partition_counts.values().sum();
    assert_eq!(
        total, 80,
        "20 cases x 4 modes must classify exactly once each"
    );
    assert_eq!(
        report
            .partition_counts
            .get("FUTURE_CAPABILITY_UNAVAILABLE")
            .copied(),
        Some(60),
        "the three future modes stay unavailable until their lanes land"
    );
    // The baseline partition is pinned by the golden report; assert the
    // documented distribution here so a silent reclassification is loud.
    let baseline: BTreeMap<&str, RaPartition> = report
        .cases
        .iter()
        .map(|case| {
            let score = case
                .modes
                .iter()
                .find(|mode| mode.mode == RaMode::StructuredKeyword)
                .expect("baseline scored");
            (case.case_id.as_str(), score.partition)
        })
        .collect();
    for (case_id, partition) in &baseline {
        let expected_class = bundle(case_id).truth.baseline_expectation.class.clone();
        match partition {
            RaPartition::PassOnBase => assert_eq!(expected_class, "pass", "{case_id}"),
            RaPartition::BaselineLimitation => assert_eq!(expected_class, "limitation", "{case_id}"),
            other => panic!("{case_id}: unexpected baseline partition {other} (expectation class {expected_class})"),
        }
    }
}

#[test]
fn unavailable_modes_report_unavailable_and_never_score() {
    let report = full_report();
    for mode_summary in &report.modes {
        match mode_summary.mode {
            RaMode::StructuredKeyword => {
                assert_eq!(mode_summary.status, "executed");
                assert_eq!(mode_summary.embedding_calls, Some(0));
                assert_eq!(mode_summary.rerank_calls, Some(0));
                assert_eq!(mode_summary.provider_calls, Some(0));
            }
            _ => {
                assert_eq!(mode_summary.status, "unavailable");
                assert!(mode_summary.unavailable_reason.is_some());
                assert!(mode_summary.mean_recall_at_25.is_none());
            }
        }
    }
    let markdown = report.to_projection_markdown();
    assert!(
        markdown.matches("FUTURE_CAPABILITY_UNAVAILABLE").count() >= 9,
        "the projection table must display FUTURE_CAPABILITY_UNAVAILABLE for every unavailable cell"
    );
    assert!(
        !markdown.contains("| + semantic embedding | 0."),
        "no fabricated future rows"
    );
}

// ---------------------------------------------------------------------------
// False-green mutations (each paired with its positive control)
// ---------------------------------------------------------------------------

fn baseline_record(case_id: &str) -> RaRunRecord {
    bundle(case_id)
        .records
        .iter()
        .find(|record| record.mode == RaMode::StructuredKeyword)
        .expect("baseline record")
        .clone()
}

fn assert_violation(
    truth: &RaTruthManifest,
    queries: &RaQuerySet,
    record: &RaRunRecord,
    code: &str,
    label: &str,
) {
    let violations = validate_run_record(truth, queries, record);
    assert!(
        violations.iter().any(|violation| violation.code == code),
        "{label}: expected {code}, got {violations:?}"
    );
}

#[test]
fn mutations_disclosure_and_labeling_false_greens_fail() {
    let bundle = bundle("rb01-lexical-easy");
    let truth = &bundle.truth;
    let queries = &bundle.queries;
    let clean = baseline_record("rb01-lexical-easy");

    // Positive control: the honest record validates clean.
    let control = validate_run_record(truth, queries, &clean);
    assert!(
        control.is_empty(),
        "control record must validate: {control:?}"
    );

    // M9 — lower k substituted without disclosure.
    let mut lower_k = clean.clone();
    for run in &mut lower_k.queries {
        run.k_requested = 25;
    }
    assert_violation(truth, queries, &lower_k, V_K_SUBSTITUTION, "M9 lower k");

    // M10/M18 — smaller corpus tier substituted / mislabeled event counts.
    let mut tier_lie = clean.clone();
    tier_lie.tier_claimed = "medium".into();
    tier_lie.corpus.tier_requested = "medium".into();
    assert_violation(
        truth,
        queries,
        &tier_lie,
        V_TIER_SUBSTITUTION,
        "M10 tier substitution",
    );
    let mut count_lie = clean.clone();
    count_lie.corpus.events_expected = 250_000;
    assert_violation(
        truth,
        queries,
        &count_lie,
        V_TIER_SUBSTITUTION,
        "M18 10k labeled 250k",
    );
    let mut corpus_lie = clean.clone();
    corpus_lie.corpus.import_tree_sha256 = "0".repeat(64);
    assert_violation(
        truth,
        queries,
        &corpus_lie,
        V_TIER_SUBSTITUTION,
        "M18 corpus identity",
    );

    // M12 — baseline results labeled as embedding results.
    let mut relabeled = clean.clone();
    relabeled.mode = RaMode::HybridEmbedding;
    assert_violation(
        truth,
        queries,
        &relabeled,
        V_MODE_MISLABEL,
        "M12 relabeled baseline",
    );
    // Positive control: a field-consistent embedding-mode record passes the
    // labeling validator (full pluggability is proven in the contract test).
    let mut consistent = clean.clone();
    consistent.mode = RaMode::HybridEmbedding;
    consistent.engine.model_identity = Some("contract-test-embedding".into());
    consistent.calls.embedding_calls = Some(7);
    let leftover: Vec<RaViolation> = validate_run_record(truth, queries, &consistent)
        .into_iter()
        .filter(|violation| violation.code == V_MODE_MISLABEL)
        .collect();
    assert!(
        leftover.is_empty(),
        "consistent embedding labeling must not trip M12: {leftover:?}"
    );

    // M13 — model/configuration identity omitted.
    let mut anonymous = clean.clone();
    anonymous.engine.contextdesk_sha = String::new();
    assert_violation(
        truth,
        queries,
        &anonymous,
        V_IDENTITY_OMITTED,
        "M13 identity omitted",
    );

    // M15 — seed / generator version omitted or wrong.
    let mut versionless = clean.clone();
    versionless.corpus.generator_version = String::new();
    assert_violation(
        truth,
        queries,
        &versionless,
        V_PROVENANCE_OMITTED,
        "M15 generator omitted",
    );
    let mut reseeded = clean.clone();
    reseeded.corpus.seed = 1;
    assert_violation(
        truth,
        queries,
        &reseeded,
        V_PROVENANCE_OMITTED,
        "M15 seed drift",
    );

    // M8 — skipped/unavailable mode reported as passing.
    let mut fake_unavailable = clean.clone();
    fake_unavailable.mode = RaMode::HybridEmbedding;
    fake_unavailable.mode_status = RaModeStatus::unavailable("not_implemented");
    assert_violation(
        truth,
        queries,
        &fake_unavailable,
        V_UNAVAILABLE_AS_PASS,
        "M8 unavailable with results",
    );
    // Positive control: a true unavailable record classifies UNAVAILABLE.
    let honest_unavailable = unavailable_run_record(
        RaMode::HybridEmbedding,
        "not_implemented",
        "contract",
        &bundle.imported,
        queries,
        &truth.tier,
        truth.seed,
        truth.expected.events,
        &truth.import_tree_sha256,
    );
    let score = score_case_mode(truth, queries, &honest_unavailable, &[]);
    assert_eq!(score.partition, RaPartition::FutureCapabilityUnavailable);

    // Degenerate strategies can never pass.
    let mut empty = clean.clone();
    for run in &mut empty.queries {
        run.candidates.clear();
    }
    let score = score_case_mode(truth, queries, &empty, &[]);
    assert_eq!(score.partition, RaPartition::RedRequiredFix);
    assert!(score
        .violations
        .iter()
        .any(|v| v.code == V_DEGENERATE_STRATEGY));
    let mut flood = clean.clone();
    let template = flood.queries[0].candidates[0].clone();
    if let Some(run) = flood.queries.get_mut(0) {
        while (run.candidates.len() as u64) <= RA_K {
            let mut extra = template.clone();
            extra.rank = run.candidates.len() as u64 + 1;
            run.candidates.push(extra);
        }
    }
    assert_violation(
        truth,
        queries,
        &flood,
        V_DEGENERATE_STRATEGY,
        "retrieve everything",
    );
}

#[test]
fn mutations_metric_false_greens_fail() {
    // M4 — rare causal records removed from top-k must move the metrics.
    let rb03 = bundle("rb03-rare-causal");
    let clean = baseline_record("rb03-rare-causal");
    let clean_score = score_case_mode(&rb03.truth, &rb03.queries, &clean, &[]);
    let trigger_group = rb03
        .truth
        .evidence_groups
        .iter()
        .find(|group| group.group_id.ends_with("-g01"))
        .expect("trigger group");
    let mut pruned = clean.clone();
    for run in &mut pruned.queries {
        run.candidates
            .retain(|candidate| !candidate_matches_group(candidate, trigger_group));
        for (index, candidate) in run.candidates.iter_mut().enumerate() {
            candidate.rank = index as u64 + 1;
        }
    }
    let pruned_score = score_case_mode(&rb03.truth, &rb03.queries, &pruned, &[]);
    let clean_rare = clean_score.rare_trigger_recall_at_25.unwrap_or(0.0);
    let pruned_rare = pruned_score.rare_trigger_recall_at_25.unwrap_or(0.0);
    assert!(
        pruned_rare < clean_rare || pruned_score.evidence_omitted_total > clean_score.evidence_omitted_total,
        "pruning the rare trigger must be visible: clean rare={clean_rare} pruned rare={pruned_rare}"
    );

    // M7 — merging unrelated incidents shows up as contamination.
    let rb07 = bundle("rb07-interleaved");
    let clean07 = baseline_record("rb07-interleaved");
    let clean07_score = score_case_mode(&rb07.truth, &rb07.queries, &clean07, &[]);
    let g_b = rb07
        .truth
        .evidence_groups
        .iter()
        .find(|group| group.group_id.ends_with("-g02"))
        .expect("lane-b group");
    let donor: Vec<lab::RaCandidate> = clean07
        .queries
        .iter()
        .flat_map(|run| run.candidates.iter().cloned())
        .filter(|candidate| candidate_matches_group(candidate, g_b))
        .collect();
    assert!(
        !donor.is_empty(),
        "lane-b evidence must exist in the clean run"
    );
    let mut merged = clean07.clone();
    let target_query = format!("{}-q2", rb07.truth.case_id);
    for run in &mut merged.queries {
        if run.query_id == target_query {
            for extra in donor.iter().take(3).cloned() {
                run.candidates.insert(0, extra);
            }
            for (index, candidate) in run.candidates.iter_mut().enumerate() {
                candidate.rank = index as u64 + 1;
            }
            run.candidates.truncate(RA_K as usize);
        }
    }
    let merged_score = score_case_mode(&rb07.truth, &rb07.queries, &merged, &[]);
    assert!(
        merged_score.false_grouping_contaminations_at_25
            > clean07_score.false_grouping_contaminations_at_25,
        "cross-request merging must surface as contamination"
    );

    // M11 — duplicated trials must not count as independent.
    let rb01 = bundle("rb01-lexical-easy");
    let suite = load_ra_suite(&require_suite_root()).expect("suite");
    let case_inputs = vec![RaCaseInputs {
        truth: rb01.truth.clone(),
        queries: rb01.queries.clone(),
        observed: rb01.observed.clone(),
        records: vec![
            baseline_record("rb01-lexical-easy"),
            baseline_record("rb01-lexical-easy"),
        ],
    }];
    let report = assemble_report("test-sha", &suite, &case_inputs, None);
    let flagged = report.cases[0].modes.iter().any(|score| {
        score
            .violations
            .iter()
            .any(|v| v.code == V_DUPLICATE_TRIALS)
    });
    assert!(flagged, "duplicate trials must be flagged");

    // M14 — truncated/lower-bound corpus reported as complete.
    let rb20 = bundle("rb20-partial-corpus");
    let violation = lab::validate_coverage_claim(&rb20.truth, "complete");
    assert!(
        violation
            .as_ref()
            .is_some_and(|v| v.code == V_COMPLETENESS_OVERCLAIM),
        "claiming complete coverage over a partial corpus must fail"
    );
    // Positive control: observed_only is always honest, and a genuinely
    // complete case may claim complete.
    assert!(lab::validate_coverage_claim(&rb20.truth, "observed_only").is_none());
    let rb01_truth = &bundle("rb01-lexical-easy").truth;
    assert!(lab::validate_coverage_claim(rb01_truth, "complete").is_none());

    // Equivalent-query divergence (rb16 cosmetic variants) is enforced.
    let rb16 = bundle("rb16-search-non-progress");
    let clean16 = baseline_record("rb16-search-non-progress");
    let clean16_score = score_case_mode(&rb16.truth, &rb16.queries, &clean16, &[]);
    assert!(
        !clean16_score
            .violations
            .iter()
            .any(|v| v.code == V_NON_PROGRESS_DIVERGENCE),
        "production search must return identical evidence for cosmetic variants: {:?}",
        clean16_score.violations
    );
    let mut divergent = clean16.clone();
    let variant_query = format!("{}-q2b", rb16.truth.case_id);
    for run in &mut divergent.queries {
        if run.query_id == variant_query {
            run.candidates.pop();
        }
    }
    let divergent_score = score_case_mode(&rb16.truth, &rb16.queries, &divergent, &[]);
    assert!(
        divergent_score
            .violations
            .iter()
            .any(|v| v.code == V_NON_PROGRESS_DIVERGENCE),
        "cosmetic-variant divergence must be flagged"
    );
}

// ---------------------------------------------------------------------------
// Final-analysis hard gates (production rubric reuse; deterministic)
// ---------------------------------------------------------------------------

fn host_facts_for(case_id: &str) -> TriageHostFacts {
    let bundle = bundle(case_id);
    let corpus = bundle.imported.open().expect("corpus");
    let mut messages = Vec::new();
    let mut after_seq: Option<u64> = None;
    let mut after_ts: Option<i64> = None;
    loop {
        let query = EventQuery {
            limit: MAX_EVENT_PAGE,
            after_seq,
            after_ts,
            ..Default::default()
        };
        let page = query_event_rows(&corpus, &query).expect("page");
        for event in &page.events {
            messages.push((event.seq, event.source.clone(), event.message.clone()));
        }
        match (page.next_cursor, page.next_ts) {
            (Some(cursor), ts) => {
                after_seq = Some(cursor);
                after_ts = ts;
            }
            _ => break,
        }
    }
    let error_count = query_event_count(
        &corpus,
        &EventQuery {
            levels: vec!["error".into(), "fatal".into()],
            ..Default::default()
        },
    )
    .expect("error count")
    .total_matched;
    let evidence = messages
        .iter()
        .map(
            |(seq, source, _)| cd_core::log_analysis::SearchEvidenceIdentity {
                seq: *seq,
                source: source.clone(),
                citation_source: None,
                template_id: 0,
            },
        )
        .collect();
    TriageHostFacts {
        time_quality: bundle.truth.expected.time_quality.clone(),
        exact_event_count: bundle.observed.events_imported,
        exact_error_count: Some(error_count),
        sources_present: bundle
            .truth
            .expected
            .sources
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>(),
        evidence,
        messages_by_seq: messages,
        known_semantic_occurrence_count: None,
        stderr_record_count: None,
        raw_exception_record_count: None,
        episode_counts_complete: false,
    }
}

fn find_row(host: &TriageHostFacts, token: &str) -> (u64, String, String) {
    host.messages_by_seq
        .iter()
        .find(|(_, _, message)| message.contains(token))
        .cloned()
        .unwrap_or_else(|| panic!("no host row carries token {token}"))
}

fn honest_answer(case_id: &str, host: &TriageHostFacts) -> StructuredTriageAnswer {
    let bundle = bundle(case_id);
    let truth = &bundle.truth;
    let mut observations = Vec::new();
    let mut causal = Vec::new();
    for group in &truth.evidence_groups {
        if group.role == lab::RaRole::Decoy {
            continue;
        }
        let (seq, source, message) = find_row(host, &group.token);
        let claim = TriageClaim {
            text: message.clone(),
            seq: Some(seq),
            source: Some(source),
            role: Some(match group.role {
                lab::RaRole::Trigger => "trigger".into(),
                lab::RaRole::Symptom => "symptom".into(),
                _ => "observation".into(),
            }),
        };
        if group.role == lab::RaRole::Trigger {
            causal.push(claim);
        } else {
            observations.push(claim);
        }
    }
    if causal.is_empty() {
        // Unknown-root cases keep causal candidates honest: restate the
        // strongest symptom without crowning it.
        if let Some(first) = observations.first().cloned() {
            causal.push(TriageClaim {
                role: Some("other".into()),
                ..first
            });
        }
    }
    let mut missing: Vec<String> = truth.permitted_uncertainty.clone();
    if missing.is_empty() {
        missing.push("no further in-corpus evidence is expected".into());
    }
    let competing = if truth.competing_explanations.is_empty() {
        vec!["no equally supported alternative explanation survives the evidence".into()]
    } else {
        truth.competing_explanations.clone()
    };
    StructuredTriageAnswer {
        observations,
        causal_candidates: causal,
        competing_explanations: competing,
        confidence: "medium".into(),
        confidence_reason: "grounded in cited corpus rows with disclosed uncertainty".into(),
        missing_or_next_evidence: missing,
        ..Default::default()
    }
}

#[test]
fn final_analysis_hard_gates_reuse_production_rubric() {
    // rb04: honest answer passes; crowning the frequency decoy fails.
    let rb04 = bundle("rb04-frequency-decoy");
    let key = ra_triage_key(&rb04.truth);
    let host = host_facts_for("rb04-frequency-decoy");
    let honest = honest_answer("rb04-frequency-decoy", &host);
    let honest_score = score_structured_triage_answer(&honest, &key, &host);
    assert!(
        honest_score.passed,
        "honest rb04 answer must pass the production rubric: {:?}",
        honest_score
            .dimensions
            .iter()
            .filter(|d| !d.passed)
            .collect::<Vec<_>>()
    );

    // M5 — high-frequency decoy crowned as cause.
    let decoy_group = rb04
        .truth
        .evidence_groups
        .iter()
        .find(|group| group.role == lab::RaRole::Decoy)
        .expect("decoy");
    let (seq, source, message) = find_row(&host, &decoy_group.token);
    let mut crowned = honest.clone();
    crowned.causal_candidates = vec![TriageClaim {
        text: format!("{message} — this missing index is the root cause of the outage"),
        seq: Some(seq),
        source: Some(source),
        role: Some("trigger".into()),
    }];
    crowned.asserts_root_cause_established = true;
    crowned.confidence = "high".into();
    let crowned_score = score_structured_triage_answer(&crowned, &key, &host);
    assert!(
        !crowned_score.passed,
        "crowning the frequency decoy must fail"
    );

    // M2 — valid citation moved to the wrong claim (transplant).
    let trigger_group = rb04
        .truth
        .evidence_groups
        .iter()
        .find(|group| group.role == lab::RaRole::Trigger)
        .expect("trigger");
    let (trigger_seq, trigger_source, _) = find_row(&host, &trigger_group.token);
    let mut transplanted = honest.clone();
    transplanted.causal_candidates = vec![TriageClaim {
        text: format!("{message} sequential scans exhausted the pool"),
        seq: Some(trigger_seq),
        source: Some(trigger_source),
        role: Some("trigger".into()),
    }];
    let transplanted_score = score_structured_triage_answer(&transplanted, &key, &host);
    assert!(
        !transplanted_score.passed,
        "decoy prose carried on the trigger's citation must fail claim-evidence correspondence"
    );

    // M3 — raw volume used as incident count (rb06 geometry).
    let rb06 = bundle("rb06-duplicate-renderings");
    let key06 = ra_triage_key(&rb06.truth);
    let corpus06 = rb06.imported.open().expect("corpus");
    let analysis =
        cd_core::log_analysis::analyze_exception_episodes(&corpus06, &[]).expect("episodes");
    let host06 =
        host_facts_for("rb06-duplicate-renderings").with_exception_episode_report(&analysis);
    let honest06 = honest_answer("rb06-duplicate-renderings", &host06);
    let honest06_score = score_structured_triage_answer(&honest06, &key06, &host06);
    assert!(
        honest06_score.passed,
        "honest rb06 answer must pass: {:?}",
        honest06_score
            .dimensions
            .iter()
            .filter(|d| !d.passed)
            .collect::<Vec<_>>()
    );
    let mut volume = honest06.clone();
    volume.asserts_raw_volume_as_semantic_occurrences = true;
    volume.asserted_semantic_occurrence_count = Some(201);
    let volume_score = score_structured_triage_answer(&volume, &key06, &host06);
    assert!(
        !volume_score.passed,
        "raw volume as occurrence count must fail"
    );

    // M6 — high-severity isolated decoy crowned (rb19).
    let rb19 = bundle("rb19-severity-isolated");
    let key19 = ra_triage_key(&rb19.truth);
    let host19 = host_facts_for("rb19-severity-isolated");
    let honest19 = honest_answer("rb19-severity-isolated", &host19);
    assert!(score_structured_triage_answer(&honest19, &key19, &host19).passed);
    let fatal = rb19
        .truth
        .evidence_groups
        .iter()
        .find(|group| group.role == lab::RaRole::Decoy)
        .expect("fatal decoy");
    let (fatal_seq, fatal_source, fatal_message) = find_row(&host19, &fatal.token);
    let mut fatal_crowned = honest19.clone();
    fatal_crowned.causal_candidates = vec![TriageClaim {
        text: format!("{fatal_message} — the watchdog fatal caused the checkout failures"),
        seq: Some(fatal_seq),
        source: Some(fatal_source),
        role: Some("trigger".into()),
    }];
    fatal_crowned.asserts_root_cause_established = true;
    fatal_crowned.confidence = "high".into();
    assert!(
        !score_structured_triage_answer(&fatal_crowned, &key19, &host19).passed,
        "severity alone must not crown an unrelated FATAL"
    );

    // M16 — recovery evidence labeled as trigger (rb15).
    let rb15 = bundle("rb15-recovery-evidence");
    let key15 = ra_triage_key(&rb15.truth);
    let host15 = host_facts_for("rb15-recovery-evidence");
    let honest15 = honest_answer("rb15-recovery-evidence", &host15);
    assert!(score_structured_triage_answer(&honest15, &key15, &host15).passed);
    let recovery = rb15
        .truth
        .evidence_groups
        .iter()
        .find(|group| group.role == lab::RaRole::Recovery)
        .expect("recovery group");
    let (rec_seq, rec_source, rec_message) = find_row(&host15, &recovery.token);
    let mut recovery_as_trigger = honest15.clone();
    recovery_as_trigger.causal_candidates = vec![TriageClaim {
        text: format!("{rec_message} — the recovery promotion caused the write failures"),
        seq: Some(rec_seq),
        source: Some(rec_source),
        role: Some("trigger".into()),
    }];
    recovery_as_trigger.asserts_root_cause_established = true;
    recovery_as_trigger.confidence = "high".into();
    assert!(
        !score_structured_triage_answer(&recovery_as_trigger, &key15, &host15).passed,
        "recovery evidence must not be classified as the trigger"
    );

    // M17 — unresolved local timestamps used for confident chronology (rb09).
    let rb09 = bundle("rb09-time-uncertainty");
    let key09 = ra_triage_key(&rb09.truth);
    let host09 = host_facts_for("rb09-time-uncertainty");
    let honest09 = honest_answer("rb09-time-uncertainty", &host09);
    let honest09_score = score_structured_triage_answer(&honest09, &key09, &host09);
    assert!(
        honest09_score.passed,
        "honest rb09 answer must pass: {:?}",
        honest09_score
            .dimensions
            .iter()
            .filter(|d| !d.passed)
            .collect::<Vec<_>>()
    );
    let mut confident = honest09.clone();
    confident.asserts_confident_wall_clock_order = true;
    assert!(
        !score_structured_triage_answer(&confident, &key09, &host09).passed,
        "confident cross-source chronology over mixed/order-only time must fail"
    );

    // Competing roots (rb10): the tie must be representable and collapse with
    // overclaim must fail.
    let rb10 = bundle("rb10-competing-roots");
    let key10 = ra_triage_key(&rb10.truth);
    assert_eq!(
        key10.competing_trigger_message_tokens.len(),
        2,
        "tie is representable"
    );
    let host10 = host_facts_for("rb10-competing-roots");
    let honest10 = honest_answer("rb10-competing-roots", &host10);
    assert!(score_structured_triage_answer(&honest10, &key10, &host10).passed);
    let (a_seq, a_source, a_message) =
        find_row(&host10, &key10.competing_trigger_message_tokens[0]);
    let mut collapsed = honest10.clone();
    collapsed.causal_candidates = vec![TriageClaim {
        text: a_message,
        seq: Some(a_seq),
        source: Some(a_source),
        role: Some("trigger".into()),
    }];
    collapsed.asserts_root_cause_established = true;
    collapsed.confidence = "high".into();
    let collapsed_score = score_structured_triage_answer(&collapsed, &key10, &host10);
    assert!(
        !collapsed_score.passed,
        "confidently crowning one of two equally supported roots must fail"
    );
}

// ---------------------------------------------------------------------------
// Future-capability contract pluggability (NOT a capability measurement)
// ---------------------------------------------------------------------------

struct CountingConceptEmbed {
    inner: cd_core::embed::ConceptEmbedBackend,
    calls: std::sync::atomic::AtomicU64,
}

#[async_trait::async_trait]
impl cd_core::embed::EmbedBackend for CountingConceptEmbed {
    async fn embed(&self, texts: &[String]) -> cd_core::error::CoreResult<Vec<Vec<f32>>> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.embed(texts).await
    }

    fn identity(&self) -> String {
        // Counting must not change the binding identity of the wrapped
        // backend, or the stored/query comparison would fail spuriously.
        self.inner.identity()
    }
}

/// Proves the hybrid_embedding adapter seam: the SAME contract (queries,
/// truth, run-record schema, scorer) accepts a semantic engine — here the
/// deterministic offline ConceptEmbedBackend. This is contract validation
/// ONLY; it is never a BGE-M3 measurement and never feeds baseline reports.
#[test]
fn embedding_adapter_contract_plugs_in_without_touching_truth_or_scoring() {
    let root = require_suite_root();
    let case_id = "rb02-semantic-gap";
    let truth = load_ra_truth(&root, case_id).expect("truth");
    let queries = load_ra_queries(&root, case_id).expect("queries");
    let import_root = ra_case_import_root(&root, case_id);

    let cache = tempfile::tempdir().expect("cache");
    let backend = Arc::new(CountingConceptEmbed {
        inner: cd_core::embed::ConceptEmbedBackend::default(),
        calls: std::sync::atomic::AtomicU64::new(0),
    });
    let policy = cd_core::log_analysis::LogEmbedPolicy {
        mode: cd_core::log_analysis::LogEmbedMode::Local,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "concept-embed-contract-test".into(),
        defer_above_source_bytes: None,
    };
    let report = cd_core::log_analysis::ingest_path_with_policy(
        cache.path(),
        &import_root,
        case_id,
        &policy,
        Some(backend.clone()),
    )
    .expect("embedded ingest");
    let corpus =
        cd_core::log_analysis::LogCorpus::open(cache.path(), &report.corpus_id).expect("open");
    assert!(
        corpus.embedding_status().embedded_templates > 0,
        "the production honesty gate requires embedded templates before semantic search"
    );

    let k = RA_K as usize;
    let mut runs = Vec::new();
    for query in &queries.queries {
        let search = cd_core::log_analysis::EventSearchQuery {
            query: Some(query.question.clone()),
            filter: EventQuery::default(),
            semantic: true,
            k,
            match_mode: cd_core::log_analysis::SearchMatchMode::Literal,
            case_sensitive: false,
        };
        let result = cd_core::log_analysis::search_events_advanced(
            &corpus,
            &search,
            Some(backend.as_ref() as &dyn cd_core::embed::EmbedBackend),
        )
        .expect("semantic search");
        let candidates = result
            .hits
            .iter()
            .enumerate()
            .map(|(index, hit)| lab::RaCandidate {
                rank: index as u64 + 1,
                seq: hit.event.seq,
                source: hit.event.source.clone(),
                ts: hit.event.ts,
                timestamp_provenance: format!("{:?}", hit.event.timestamp_provenance),
                level: Some(hit.event.level.clone()),
                template_id: Some(hit.event.template_id),
                score: Some(f64::from(hit.score)),
                content: hit.event.message.clone(),
            })
            .collect();
        runs.push(lab::RaQueryRun {
            query_id: query.query_id.clone(),
            k_requested: RA_K,
            matched_total: result.total_matched,
            scanned: result.scanned,
            partial: result.partial,
            runtime_ms: None,
            candidates,
        });
    }
    let record = RaRunRecord {
        schema_id: lab::RA_RUN_RECORD_SCHEMA_ID.into(),
        schema_version: lab::RA_RUN_RECORD_SCHEMA_VERSION,
        suite_id: lab::RA_SUITE_ID.into(),
        suite_version: lab::RA_SUITE_VERSION,
        case_id: case_id.into(),
        tier_claimed: truth.tier.clone(),
        mode: RaMode::HybridEmbedding,
        mode_status: RaModeStatus::executed(),
        engine: RaEngineManifest {
            kind: "cd-core.log_analysis.search_events_advanced(semantic=true)".into(),
            contextdesk_sha: contextdesk_sha(),
            ranking: "score DESC, seq ASC".into(),
            model_identity: Some(backend.identity()),
            reranker_identity: None,
            deterministic: true,
        },
        corpus: lab::RaCorpusStamp {
            tier_requested: truth.tier.clone(),
            seed: truth.seed,
            generator_version: lab::RA_GENERATOR_VERSION.into(),
            truth_schema_id: lab::RA_TRUTH_SCHEMA_ID.into(),
            events_expected: truth.expected.events,
            events_imported: report.stats.lines,
            files: report.stats.files as u64,
            bytes: 0,
            import_tree_sha256: truth.import_tree_sha256.clone(),
            generation_ms: None,
            import_ms: None,
        },
        calls: RaCallCounts {
            embedding_calls: Some(backend.calls.load(std::sync::atomic::Ordering::SeqCst)),
            rerank_calls: Some(0),
            provider_calls: Some(0),
            tokens_in: Some(0),
            tokens_out: Some(0),
            cost_usd: Some(0.0),
        },
        queries: runs,
    };
    assert!(
        record.calls.embedding_calls.unwrap() > 0,
        "the semantic path must have embedded"
    );

    // The identical validator + scorer accept the record: same truth, same
    // queries, same evidence identities, same scoring.
    let violations = validate_run_record(&truth, &queries, &record);
    assert!(violations.is_empty(), "contract violations: {violations:?}");
    let score = score_case_mode(&truth, &queries, &record, &[]);
    assert!(score.violations.is_empty());
    assert!(
        matches!(
            score.partition,
            RaPartition::PassOnBase | RaPartition::BaselineLimitation
        ),
        "executed contract run classifies on the normal gates"
    );
}

// ---------------------------------------------------------------------------
// Medium / large tiers (explicit, never CI)
// ---------------------------------------------------------------------------

fn generated_root(tier: &str) -> PathBuf {
    fixture_root()
        .join("generated/retrieval-ablation")
        .join(tier)
}

#[test]
#[ignore = "medium tier (~250k events, ~45 MiB): run explicitly with --ignored; generates under fixtures/log-lab/generated/ (git-ignored)"]
fn generate_medium_tier_corpus_on_demand() {
    // (This is `#[ignore]`), so this generation never runs in default CI.
    let root = generated_root("medium");
    if root.exists() {
        std::fs::remove_dir_all(&root).expect("clear prior medium tree");
    }
    std::fs::create_dir_all(&root).expect("mkdir");
    let summary = generate_retrieval_ablation(&root, RaTier::Medium, RA_DEFAULT_SEED)
        .expect("medium generation");
    println!(
        "MEDIUM tier={} seed={} cases={} files={} events={} bytes={} corpus_identity_sha256={}",
        summary.tier,
        summary.seed,
        summary.cases,
        summary.files,
        summary.events,
        summary.bytes,
        summary.corpus_identity_sha256
    );
    assert!(
        summary.events >= 200_000,
        "medium tier must stay ~250k events"
    );
}

#[test]
#[ignore = "large tier (>=1M events, ~200 MiB disk): run explicitly with --ignored after checking free disk"]
fn generate_large_tier_corpus_on_demand() {
    // (This is `#[ignore]`), so this generation never runs in default CI.
    let root = generated_root("large");
    if root.exists() {
        std::fs::remove_dir_all(&root).expect("clear prior large tree");
    }
    std::fs::create_dir_all(&root).expect("mkdir");
    let summary = generate_retrieval_ablation(&root, RaTier::Large, RA_DEFAULT_SEED)
        .expect("large generation");
    println!(
        "LARGE tier={} seed={} cases={} files={} events={} bytes={} corpus_identity_sha256={}",
        summary.tier,
        summary.seed,
        summary.cases,
        summary.files,
        summary.events,
        summary.bytes,
        summary.corpus_identity_sha256
    );
    assert!(
        summary.events >= 1_000_000,
        "large tier must reach one million events"
    );
}

// ---------------------------------------------------------------------------
// Hybrid adapters: hermetic contract execution (default CI) and env-gated
// LIVE measurement (never CI, never a mock-as-capability)
// ---------------------------------------------------------------------------

/// The hybrid adapters execute through the identical contract, validator and
/// scorer with deterministic offline backends. Contract validation ONLY:
/// synthetic identities scream synthetic, nothing here is a capability
/// measurement, and nothing touches the committed baseline.
#[test]
fn hybrid_adapters_execute_hermetically_through_the_same_contract() {
    let root = require_suite_root();
    let case_id = "rb02-semantic-gap";
    let truth = load_ra_truth(&root, case_id).expect("truth");
    let queries = load_ra_queries(&root, case_id).expect("queries");
    let import_root = ra_case_import_root(&root, case_id);
    let backend: Arc<dyn cd_core::embed::EmbedBackend> =
        Arc::new(cd_core::embed::ConceptEmbedBackend::default());
    let imported = lab::ra_import_case_with_embedding(
        case_id,
        &import_root,
        Some(backend.clone()),
        "concept-embed-contract-test",
    )
    .expect("embedded import");
    assert_eq!(
        imported.events_imported, truth.expected.events,
        "embedding at import must not change event identity"
    );

    for reranked in [false, true] {
        let adapter = if reranked {
            lab::RaHybridAdapter::reranked(
                backend.clone(),
                "concept-embed-contract-test (deterministic synthetic; NOT a capability)",
                Arc::new(cd_core::rerank::ScriptedRerankBackend),
                &contextdesk_sha(),
            )
        } else {
            lab::RaHybridAdapter::embedding(
                backend.clone(),
                "concept-embed-contract-test (deterministic synthetic; NOT a capability)",
                &contextdesk_sha(),
            )
        };
        let record_a = run_mode_for_case(
            &adapter,
            &imported,
            &queries,
            &truth.tier,
            truth.seed,
            truth.expected.events,
            &truth.import_tree_sha256,
            None,
        )
        .expect("hybrid run");
        let record_b = run_mode_for_case(
            &adapter,
            &imported,
            &queries,
            &truth.tier,
            truth.seed,
            truth.expected.events,
            &truth.import_tree_sha256,
            None,
        )
        .expect("hybrid rerun");
        let digest = |record: &RaRunRecord| {
            let mut normalized = record.clone();
            for run in &mut normalized.queries {
                run.runtime_ms = None;
            }
            normalized.calls.embedding_calls = None;
            normalized.calls.rerank_calls = None;
            serde_json::to_string(&normalized).expect("serialize")
        };
        assert_eq!(
            digest(&record_a),
            digest(&record_b),
            "adapter is deterministic"
        );
        assert_eq!(record_a.mode_status.state, "executed");
        let violations = validate_run_record(&truth, &queries, &record_a);
        assert!(violations.is_empty(), "contract violations: {violations:?}");
        assert!(
            record_a.calls.embedding_calls.unwrap() > 0,
            "measured embedding calls"
        );
        if reranked {
            assert!(
                record_a.calls.rerank_calls.unwrap() > 0,
                "measured rerank calls"
            );
            assert!(record_a
                .engine
                .reranker_identity
                .as_deref()
                .unwrap()
                .contains("synthetic"));
        }
        let score = score_case_mode(&truth, &queries, &record_a, &[]);
        assert!(score.violations.is_empty(), "{:?}", score.violations);
        assert!(matches!(
            score.partition,
            RaPartition::PassOnBase | RaPartition::BaselineLimitation
        ));
    }
}

fn live_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// LIVE small-tier measurement against real configured endpoints.
///
/// Env contract (never CI):
///   CD_RA_LIVE_EMBED_BASE_URL   e.g. http://127.0.0.1:11434
///   CD_RA_LIVE_EMBED_MODEL      e.g. bge-m3 (any embedding model the
///                               endpoint actually serves; identity recorded)
///   CD_RA_LIVE_RERANK_BASE_URL  optional /rerank-compatible endpoint
///   CD_RA_LIVE_RERANK_MODEL     optional reranker model id
///
/// Unset env => the test FAILS with instructions (never a silent green).
/// Reports are written under fixtures/log-lab/generated/retrieval-ablation/
/// live-reports/ (git-ignored) and compared against the COMMITTED baseline,
/// which is never modified.
#[test]
#[ignore = "live measurement against configured endpoints; run explicitly with --ignored after setting CD_RA_LIVE_EMBED_BASE_URL/MODEL"]
fn live_hybrid_small_tier_measurement() {
    let base_url = live_env("CD_RA_LIVE_EMBED_BASE_URL")
        .expect("set CD_RA_LIVE_EMBED_BASE_URL (e.g. http://127.0.0.1:11434)");
    let embed_model = live_env("CD_RA_LIVE_EMBED_MODEL")
        .expect("set CD_RA_LIVE_EMBED_MODEL to a model the endpoint serves");
    let rerank_base = live_env("CD_RA_LIVE_RERANK_BASE_URL");
    let rerank_model = live_env("CD_RA_LIVE_RERANK_MODEL");

    // Health first: a dead endpoint is an UNAVAILABLE result, not a hang.
    let client = cd_core::chat::OllamaClient::new(&base_url, &embed_model).expect("client");
    let embed_backend: Arc<dyn cd_core::embed::EmbedBackend> =
        Arc::new(cd_core::embed::OllamaEmbedBackend::new(client));
    let probe = cd_core::memory::embed_blocking(
        embed_backend.as_ref(),
        "contextdesk retrieval health probe",
        10_000,
    );
    let dims = probe.map(|vector| vector.len()).unwrap_or(0);
    assert!(
        dims > 0,
        "embedding endpoint failed the health probe; record UNAVAILABLE, do not fabricate"
    );
    let rerank_backend: Option<Arc<dyn cd_core::rerank::RerankBackend>> =
        match (&rerank_base, &rerank_model) {
            (Some(base), Some(model)) => Some(Arc::new(
                cd_core::rerank::HttpRerankBackend::new(base, model.clone(), None)
                    .expect("rerank backend"),
            )),
            _ => None,
        };

    let root = require_suite_root();
    let suite = load_ra_suite(&root).expect("suite");
    let committed: RaReport = serde_json::from_slice(
        &std::fs::read(
            root.join(RA_SUITE_REL_ROOT)
                .join("reports/baseline/small-structured_keyword.report.json"),
        )
        .expect("committed baseline"),
    )
    .expect("baseline parses");
    let baseline_by_case: BTreeMap<String, (f64, Option<f64>, f64)> = committed
        .cases
        .iter()
        .map(|case| {
            let score = case
                .modes
                .iter()
                .find(|mode| mode.mode == RaMode::StructuredKeyword)
                .expect("baseline mode");
            (
                case.case_id.clone(),
                (
                    score.mean_recall_at_25_answerable,
                    score.rare_trigger_recall_at_25,
                    score.max_decoy_share_at_25,
                ),
            )
        })
        .collect();

    let started = std::time::Instant::now();
    let mut rows = Vec::new();
    let mut inputs = Vec::new();
    for case_id in all_case_ids() {
        let truth = load_ra_truth(&root, case_id).expect("truth");
        let queries = load_ra_queries(&root, case_id).expect("queries");
        let import_root = ra_case_import_root(&root, case_id);
        let imported = lab::ra_import_case_with_embedding(
            case_id,
            &import_root,
            Some(embed_backend.clone()),
            &embed_model,
        )
        .expect("embedded import");
        let observed = ra_observe_corpus(&truth, &imported).expect("observe");
        // Baseline over the SAME embedded corpus: proves embedding at import
        // leaves structured/keyword results byte-identical to the committed
        // pinned baseline.
        let baseline_adapter = lab::RaStructuredKeywordAdapter {
            contextdesk_sha: contextdesk_sha(),
        };
        let baseline_record = run_mode_for_case(
            &baseline_adapter,
            &imported,
            &queries,
            &truth.tier,
            truth.seed,
            truth.expected.events,
            &truth.import_tree_sha256,
            None,
        )
        .expect("baseline over embedded corpus");
        let baseline_score = score_case_mode(&truth, &queries, &baseline_record, &[]);
        let adapter = lab::RaHybridAdapter::embedding(
            embed_backend.clone(),
            &format!("{embed_model} @ ollama ({dims} dims)"),
            &contextdesk_sha(),
        );
        let record = run_mode_for_case(
            &adapter,
            &imported,
            &queries,
            &truth.tier,
            truth.seed,
            truth.expected.events,
            &truth.import_tree_sha256,
            None,
        )
        .expect("live hybrid run");
        let mut records = vec![baseline_record, record];
        match &rerank_backend {
            Some(rerank) => {
                let adapter = lab::RaHybridAdapter::reranked(
                    embed_backend.clone(),
                    &format!("{embed_model} @ ollama ({dims} dims)"),
                    rerank.clone(),
                    &contextdesk_sha(),
                );
                records.push(
                    run_mode_for_case(
                        &adapter,
                        &imported,
                        &queries,
                        &truth.tier,
                        truth.seed,
                        truth.expected.events,
                        &truth.import_tree_sha256,
                        None,
                    )
                    .expect("live reranked run"),
                );
            }
            None => records.push(unavailable_run_record(
                RaMode::HybridEmbeddingReranked,
                "unavailable: no /rerank-compatible endpoint configured or discovered (qwen3-reranker-0.6b remains a configuration example)",
                "cd-core.log_analysis.hybrid_search_events + HttpRerankBackend",
                &imported,
                &queries,
                &truth.tier,
                truth.seed,
                truth.expected.events,
                &truth.import_tree_sha256,
            )),
        }
        let conservation = validate_conservation(&truth, &observed);
        assert!(
            conservation.is_empty(),
            "{case_id}: embedded import broke conservation: {conservation:?}"
        );
        for record in &records {
            if record.mode_status.state == "executed" {
                let violations = validate_run_record(&truth, &queries, record);
                assert!(violations.is_empty(), "{case_id}: {violations:?}");
            }
        }
        let hybrid_score = score_case_mode(&truth, &queries, &records[1], &conservation);
        let (baseline_recall, baseline_rare, baseline_decoy) = baseline_by_case
            .get(case_id)
            .copied()
            .expect("baseline row");
        assert_eq!(
            (
                baseline_score.mean_recall_at_25_answerable,
                baseline_score.rare_trigger_recall_at_25,
                baseline_score.max_decoy_share_at_25,
            ),
            (baseline_recall, baseline_rare, baseline_decoy),
            "{case_id}: structured/keyword baseline drifted on the embedded corpus"
        );
        rows.push(serde_json::json!({
            "case_id": case_id,
            "intended_probe": truth.intended_probe,
            "baseline": {
                "recall_at_25": baseline_recall,
                "rare_trigger": baseline_rare,
                "decoy_share": baseline_decoy,
            },
            "hybrid_embedding": {
                "recall_at_25": hybrid_score.mean_recall_at_25_answerable,
                "rare_trigger": hybrid_score.rare_trigger_recall_at_25,
                "decoy_share": hybrid_score.max_decoy_share_at_25,
                "partition": hybrid_score.partition.as_str(),
                "violations": hybrid_score.violations,
            },
            "delta_recall_at_25":
                hybrid_score.mean_recall_at_25_answerable - baseline_recall,
        }));
        inputs.push(RaCaseInputs {
            truth,
            queries,
            observed,
            records,
        });
    }
    let report = assemble_report(&contextdesk_sha(), &suite, &inputs, None);
    let runtime_ms = started.elapsed().as_millis() as u64;

    let out_dir = fixture_root().join("generated/retrieval-ablation/live-reports");
    std::fs::create_dir_all(&out_dir).expect("live report dir");
    std::fs::write(
        out_dir.join("live-hybrid-small.report.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_id": "contextdesk.log_lab.retrieval_live_comparison.v1",
            "schema_version": 1,
            "contextdesk_sha": contextdesk_sha(),
            "suite_seed": suite.seed,
            "corpus_identity_sha256": suite.corpus_identity_sha256,
            "embedding_model": format!("{embed_model} @ {base_url} ({dims} dims)"),
            "reranker": rerank_model.clone().map(|m| format!("{m} @ {}", rerank_base.clone().unwrap_or_default())),
            "total_runtime_ms": runtime_ms,
            "modes": report.modes,
            "per_case": rows,
        }))
        .expect("json"),
    )
    .expect("write live json");
    std::fs::write(
        out_dir.join("live-hybrid-small.report.md"),
        report.to_projection_markdown(),
    )
    .expect("write live md");
    println!(
        "LIVE_HYBRID_SMALL_OK model={embed_model} dims={dims} runtime_ms={runtime_ms} out={}",
        out_dir.display()
    );
}
