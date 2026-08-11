//! Hermetic contract for the retrieval diagnostic over **production
//! factories**: the same embedding/rerank adapters, the same SSRF-pinned
//! client, the same protected-file credential path, and the real `ToolHost`
//! `search_logs` surface a model uses.
//!
//! Nothing here needs network beyond a loopback mock gateway, a credential
//! store beyond a `0600` file, or a model. There is no lab-only retrieval
//! algorithm: if a lane is measured here, it is the lane the product runs.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use cd_core::config::{AppConfig, RetrievalRoleModel};
use cd_core::error::{CoreError, CoreResult};
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::{file_secret_ref, ReferencedSecretStore, SecretStore};
use cd_core::log_analysis::{
    ingest_path_with_policy, LogCorpus, LogEmbedMode, LogEmbedPolicy, ReanalysisReason,
};
use cd_core::process_progress::CancelFlag;
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;
use cd_test_gateway::{MockGateway, RecordedRequest, Response, Step};
use cd_workflow::retrieval_diagnostic::{
    metrics::QueryTruth, plan_diagnostic, run_diagnostic, DiagnosticBudgets, DiagnosticLane,
    DiagnosticQuery, DiagnosticRequest, DiagnosticVerdict, LaneStatus,
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// Rows the diagnostic measures. `seq` is assigned by ingest in file order
/// starting at 1, so the truth below is written against those positions.
const ROWS: [&str; 10] = [
    "routine heartbeat lane ok",                                   // 1
    "storage saturation disk free space collapsing on node alpha", // 2  relevant + anchor
    "routine heartbeat lane ok",                                   // 3
    "disk volume nearly full on node beta",                        // 4  relevant
    "billing invoice retry scheduled",                             // 5
    "routine heartbeat lane ok",                                   // 6
    "capacity headroom shrinking on node gamma",                   // 7  relevant
    "billing saturation of the retry queue on the payments path",  // 8  DECOY
    "routine heartbeat lane ok",                                   // 9
    "routine heartbeat lane ok",                                   // 10
];

const ANCHOR_SEQ: u64 = 2;
const DECOY_SEQ: u64 = 8;

fn write_corpus_source(dir: &std::path::Path) {
    let mut lines = String::new();
    for (index, message) in ROWS.iter().enumerate() {
        lines.push_str(&format!(
            "{{\"ts\":{},\"level\":\"info\",\"service\":\"diag\",\"message\":\"{message}\"}}\n",
            1_735_732_800 + index as i64 * 30
        ));
    }
    std::fs::write(dir.join("app.jsonl"), lines).expect("fixture source");
}

/// Deterministic two-dimensional space: storage-shaped text on one axis,
/// everything else on the other. Served over the real OpenAI-compatible wire.
fn embedding_vector_for(text: &str) -> [f64; 2] {
    let lower = text.to_lowercase();
    let storage = ["storage", "saturation", "disk", "capacity", "space", "full"]
        .iter()
        .filter(|token| lower.contains(*token))
        .count();
    if storage > 0 {
        [1.0, 0.0]
    } else {
        [0.0, 1.0]
    }
}

fn embeddings_response(body: &serde_json::Value) -> serde_json::Value {
    let inputs = body
        .get("input")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let data: Vec<serde_json::Value> = inputs
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let vector = embedding_vector_for(value.as_str().unwrap_or(""));
            serde_json::json!({"index": index, "embedding": vector})
        })
        .collect();
    serde_json::json!({"model": "diag-embed", "data": data})
}

/// Document-aware reranker: scores by content, so the reversed-input probe
/// passes and a genuine promotion is possible.
fn rerank_response(body: &serde_json::Value) -> serde_json::Value {
    let query = body
        .get("query")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_lowercase();
    let documents = body
        .get("documents")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let query_tokens: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|token| token.len() > 2)
        .map(str::to_string)
        .collect();
    let results: Vec<serde_json::Value> = documents
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let document = value.as_str().unwrap_or("").to_lowercase();
            let overlap = query_tokens
                .iter()
                .filter(|token| document.contains(token.as_str()))
                .count() as f64;
            let score = overlap / query_tokens.len().max(1) as f64;
            serde_json::json!({"index": index, "relevance_score": score})
        })
        .collect();
    serde_json::json!({"results": results})
}

/// One gateway serving both production wire contracts, routed by path.
async fn start_retrieval_gateway() -> MockGateway {
    MockGateway::start_routed(|request: &RecordedRequest| {
        let body = request.json_body().unwrap_or(serde_json::Value::Null);
        if request.path.ends_with("/embeddings") {
            Step::respond(Response::json_ok(&embeddings_response(&body)))
        } else if request.path.ends_with("/rerank") {
            Step::respond(Response::json_ok(&rerank_response(&body)))
        } else {
            Step::respond(Response::status_only(404))
        }
    })
    .await
}

/// A secret store that counts reads, so "one credential read per configured
/// role" is a measured fact rather than an assumption.
struct CountingSecrets {
    inner: ReferencedSecretStore,
    reads: Arc<AtomicUsize>,
}

impl SecretStore for CountingSecrets {
    fn get(&self, reference: &str) -> CoreResult<Option<String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.inner.get(reference)
    }
    fn set(&self, reference: &str, value: &str) -> CoreResult<()> {
        self.inner.set(reference, value)
    }
    fn delete(&self, reference: &str) -> CoreResult<()> {
        self.inner.delete(reference)
    }
}

fn protected_secret(dir: &tempfile::TempDir) -> String {
    let path = dir.path().join("retrieval.secret");
    std::fs::write(&path, "synthetic-retrieval-key").expect("write synthetic secret");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("protect synthetic secret");
    }
    file_secret_ref(&path).expect("protected file reference")
}

fn roles(base_url: &str, secret_ref: &str) -> (RetrievalRoleModel, RetrievalRoleModel) {
    (
        RetrievalRoleModel {
            enabled: true,
            base_url: base_url.to_string(),
            model: "diag-embed".into(),
            dialect: Some("openai_embeddings".into()),
            allow_remote: false,
            api_key_ref: Some(secret_ref.to_string()),
        },
        RetrievalRoleModel {
            enabled: true,
            base_url: base_url.to_string(),
            model: "diag-rerank".into(),
            dialect: Some("tei_rerank_v1".into()),
            allow_remote: false,
            api_key_ref: Some(secret_ref.to_string()),
        },
    )
}

fn config_with_roles(base_url: &str, secret_ref: &str) -> AppConfig {
    let (embedding, reranker) = roles(base_url, secret_ref);
    let mut config = AppConfig::default();
    config.retrieval.embedding = Some(embedding);
    config.retrieval.reranker = Some(reranker);
    config
}

fn tool_host(cache_root: &std::path::Path) -> CoreResult<ToolHost> {
    let workspace = Workspace::new("contextdesk-diagnostic-test", Vec::new());
    let index = KeywordIndex::build(&workspace)?;
    let mut host = ToolHost::new(workspace, index, None);
    host.set_log_analysis(true, Some(cache_root.to_path_buf()));
    host.set_active_log_corpus(None);
    Ok(host)
}

fn query() -> DiagnosticQuery {
    DiagnosticQuery {
        query_id: "storage".into(),
        question: "storage saturation disk free space".into(),
        keyword_terms: vec!["storage saturation".into()],
        level: None,
        truth: QueryTruth {
            relevant_seqs: [2, 4, 7].into_iter().collect(),
            graded_gains: [(2, 3), (4, 2), (7, 1)].into_iter().collect(),
            mandatory_anchor_seqs: [ANCHOR_SEQ].into_iter().collect(),
            decoy_seqs: [DECOY_SEQ].into_iter().collect(),
        },
    }
}

/// Ingest a corpus whose vectors were produced by the PRODUCTION embedding
/// factory against the mock gateway, so the stored typed space is a real
/// `openai_embeddings` space with a real endpoint fingerprint.
fn ingest_with_production_backend(
    cache: &std::path::Path,
    source: &std::path::Path,
    config: &AppConfig,
    secrets: &dyn SecretStore,
) -> String {
    let backend = cd_workflow::retrieval::build_embedding_backend(
        config.retrieval.embedding.as_ref().expect("role"),
        Some(secrets),
    )
    .expect("production embedding factory");
    let policy = LogEmbedPolicy {
        mode: LogEmbedMode::Local,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "diag-embed".into(),
        defer_above_source_bytes: None,
    };
    ingest_path_with_policy(cache, source, "diag", &policy, Some(backend))
        .expect("ingest")
        .corpus_id
}

struct Fixture {
    _cache: tempfile::TempDir,
    _source: tempfile::TempDir,
    _secret_dir: tempfile::TempDir,
    cache_root: std::path::PathBuf,
    corpus_id: String,
    config: AppConfig,
    secrets: CountingSecrets,
    reads: Arc<AtomicUsize>,
    gateway: MockGateway,
    /// Provider requests the fixture itself made while building the corpus.
    requests_after_ingest: usize,
}

async fn fixture() -> Fixture {
    let gateway = start_retrieval_gateway().await;
    let cache = tempfile::tempdir().expect("cache");
    let source = tempfile::tempdir().expect("source");
    let secret_dir = tempfile::tempdir().expect("secrets");
    write_corpus_source(source.path());
    let secret_ref = protected_secret(&secret_dir);
    let config = config_with_roles(gateway.base_url(), &secret_ref);
    let reads = Arc::new(AtomicUsize::new(0));
    let secrets = CountingSecrets {
        inner: ReferencedSecretStore::new(),
        reads: Arc::clone(&reads),
    };
    let corpus_id = ingest_with_production_backend(cache.path(), source.path(), &config, &secrets);
    // Ingest reads its own credential and issues its own embedding requests;
    // every assertion below is written against the state AFTER ingest.
    reads.store(0, Ordering::SeqCst);
    let requests_after_ingest = gateway.request_count();
    Fixture {
        cache_root: cache.path().to_path_buf(),
        _cache: cache,
        _source: source,
        _secret_dir: secret_dir,
        corpus_id,
        config,
        secrets,
        reads,
        gateway,
        requests_after_ingest,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_lane_runs_through_production_factories_and_reports_measured_facts() {
    let fixture = fixture().await;
    let request = DiagnosticRequest {
        corpus_id: fixture.corpus_id.clone(),
        queries: vec![query()],
        budgets: DiagnosticBudgets {
            candidate_k: 4,
            rerank_candidate_depth: 10,
            packed_context_chars: 100_000,
            rerank_timeout_ms: 8_000,
        },
        lanes: DiagnosticLane::ALL.to_vec(),
        egress_acknowledged: false,
    };
    let cache_root = fixture.cache_root.clone();
    let report = run_diagnostic(
        &fixture.cache_root,
        &request,
        &fixture.config,
        Some(&fixture.secrets),
        |_lane| tool_host(&cache_root),
        None,
    )
    .await
    .expect("diagnostic runs");

    assert_eq!(report.lanes.len(), 6, "every requested lane is reported");
    for lane in &report.lanes {
        assert_ne!(
            lane.status,
            LaneStatus::Blocked,
            "lane {} blocked: {:?}",
            lane.lane,
            lane.blocked_reason
        );
    }

    // The engines are the production ones, named in the report.
    let engines: Vec<&str> = report
        .lanes
        .iter()
        .map(|lane| lane.engine.as_str())
        .collect();
    assert!(engines.contains(&"tool_host_search_logs"));
    assert!(engines.contains(&"workflow_hybrid_rrf"));

    // Corpus identity pins BOTH clocks.
    assert_eq!(report.corpus.corpus_id, fixture.corpus_id);
    assert_eq!(report.corpus.event_count, ROWS.len() as u64);
    assert!(report.corpus.embedded_templates > 0);
    let stored_space = report
        .corpus
        .stored_space_label
        .as_deref()
        .expect("the corpus carries a typed embedding space");
    assert!(
        stored_space.contains("openai_embeddings") && stored_space.contains("diag-embed"),
        "stored space must name the real dialect and model: {stored_space}"
    );
    assert!(report.corpus.stored_space_fingerprint.is_some());

    // Every lane that used the reranker reports the dialect that ACTUALLY
    // parsed, from the adapter — never guessed from the endpoint.
    let rrf_reranked = report
        .lanes
        .iter()
        .find(|lane| lane.lane == "hybrid_rrf_rerank")
        .expect("rrf rerank lane");
    assert_eq!(
        rrf_reranked.rerank_dialect.as_deref(),
        Some("tei_rerank_v1")
    );
    assert_eq!(rrf_reranked.rerank_model.as_deref(), Some("diag-rerank"));
    assert_eq!(
        rrf_reranked.execution.rerank_calls,
        Some(1),
        "one bounded rerank request per query"
    );
    assert!(
        rrf_reranked.execution.candidate_pool_size.unwrap_or(0) >= 1,
        "the pool size is measured, not assumed"
    );

    // Both contract probes ran against the production adapters.
    let vector = report
        .vector_stability
        .as_ref()
        .expect("embedder probe ran");
    assert!(vector.healthy(), "{:?}", vector.findings);
    assert_eq!(vector.dimensions, Some(2));
    assert_eq!(vector.cross_call_dimensions_stable, Some(true));
    assert_eq!(vector.duplicate_inputs_stable, Some(true));
    let rerank = report
        .rerank_semantics
        .as_ref()
        .expect("reranker probe ran");
    assert_eq!(rerank.dialect, "tei_rerank_v1");
    assert_eq!(
        rerank.scores_follow_documents,
        Some(true),
        "reversed-input probe must prove scores follow the document, not its position"
    );

    // The gateway saw only the two production wire paths.
    for recorded in fixture.gateway.requests() {
        assert!(
            recorded.path.ends_with("/embeddings") || recorded.path.ends_with("/rerank"),
            "unexpected wire path {}",
            recorded.path
        );
        assert_eq!(
            recorded.header("authorization"),
            Some("Bearer synthetic-retrieval-key"),
            "the protected-file credential reached the wire"
        );
    }

    // Exactly one credential read per configured role for the WHOLE run.
    assert_eq!(
        fixture.reads.load(Ordering::SeqCst),
        2,
        "roles are built once, not once per lane"
    );

    // Retrieval and answer usefulness stay separate, and nothing is claimed.
    assert_eq!(report.evidence.answer_usefulness, "not_evaluated");
    assert_eq!(report.evidence.compatibility_readiness, "not_evaluated");
    assert!(report.comparable());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_report_is_share_safe_and_carries_no_endpoint_credential_or_corpus_text() {
    let fixture = fixture().await;
    let request = DiagnosticRequest::new(fixture.corpus_id.clone(), vec![query()]);
    let cache_root = fixture.cache_root.clone();
    let report = run_diagnostic(
        &fixture.cache_root,
        &request,
        &fixture.config,
        Some(&fixture.secrets),
        |_lane| tool_host(&cache_root),
        None,
    )
    .await
    .expect("diagnostic runs");

    let json = serde_json::to_string(&report).expect("report serializes");
    assert!(!json.contains("http://"), "no endpoint in the report");
    assert!(!json.contains("https://"));
    assert!(!json.contains("synthetic-retrieval-key"), "no credential");
    assert!(!json.contains("Bearer"));
    assert!(!json.contains("authorization"));
    assert!(
        !json.contains(fixture.gateway.base_url()),
        "not even the loopback base URL"
    );
    // Corpus text never leaves the machine through a report: row identities
    // are seq numbers, which mean nothing without the corpus.
    for row in ROWS {
        assert!(!json.contains(row), "corpus text leaked: {row}");
    }
    assert!(!json.contains("/Users/"), "no absolute path");
    // The corpus lives under a temp directory whose path carries the current
    // user's name on most platforms; none of it may reach the report.
    let cache_path = fixture.cache_root.to_string_lossy().to_string();
    assert!(
        !json.contains(&cache_path),
        "the cache path leaked into the report"
    );
    for component in cache_path.split(std::path::MAIN_SEPARATOR) {
        if component.len() > 6 {
            assert!(
                !json.contains(component),
                "path component `{component}` leaked into the report"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unacknowledged_remote_role_blocks_every_lane_that_would_use_it() {
    let fixture = fixture().await;
    // Point the roles at a non-loopback host. Nothing may be constructed or
    // read; the refusal happens on configuration alone.
    let mut config = fixture.config.clone();
    for role in [
        config.retrieval.embedding.as_mut(),
        config.retrieval.reranker.as_mut(),
    ]
    .into_iter()
    .flatten()
    {
        role.base_url = "https://gateway.example.invalid".into();
    }

    let request = DiagnosticRequest::new(fixture.corpus_id.clone(), vec![query()]);
    let plan =
        plan_diagnostic(&fixture.cache_root, &request, &config).expect("plan is always safe");
    assert!(plan.requires_egress_consent);
    assert!(!plan.egress_acknowledged);
    let refused: Vec<&str> = plan
        .blocked_lanes
        .iter()
        .filter(|blocked| blocked.code == "retrieval_egress_not_acknowledged")
        .map(|blocked| blocked.lane.as_str())
        .collect();
    for lane in DiagnosticLane::ALL
        .iter()
        .filter(|lane| lane.uses_embedder())
    {
        assert!(
            refused.contains(&lane.as_str()),
            "lane {} must be refused without egress consent",
            lane.as_str()
        );
    }
    assert_eq!(
        fixture.reads.load(Ordering::SeqCst),
        0,
        "planning must never read a credential"
    );
    assert_eq!(
        fixture.gateway.request_count(),
        fixture.requests_after_ingest,
        "planning must never touch the network"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_absent_reranker_blocks_only_the_rerank_lanes_and_keeps_the_baseline() {
    let fixture = fixture().await;
    let mut config = fixture.config.clone();
    config.retrieval.reranker = None;

    let request = DiagnosticRequest::new(fixture.corpus_id.clone(), vec![query()]);
    let cache_root = fixture.cache_root.clone();
    let report = run_diagnostic(
        &fixture.cache_root,
        &request,
        &config,
        Some(&fixture.secrets),
        |_lane| tool_host(&cache_root),
        None,
    )
    .await
    .expect("an absent optional role never fails the run");

    for lane in &report.lanes {
        let expected_blocked = DiagnosticLane::ALL
            .iter()
            .find(|candidate| candidate.as_str() == lane.lane)
            .expect("known lane")
            .uses_reranker();
        if expected_blocked {
            assert_eq!(lane.status, LaneStatus::Blocked, "lane {}", lane.lane);
            assert_eq!(
                lane.blocked_reason.as_ref().map(|r| r.code.as_str()),
                Some("rerank_role_unconfigured")
            );
        } else {
            assert_ne!(lane.status, LaneStatus::Blocked, "lane {}", lane.lane);
        }
    }
    assert!(report.rerank_semantics.is_none(), "no reranker, no probe");
    assert!(report.comparable(), "the baseline lanes still compare");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rerank_role_without_an_explicit_dialect_blocks_before_any_provider_work() {
    let fixture = fixture().await;
    let mut config = fixture.config.clone();
    config.retrieval.reranker.as_mut().expect("role").dialect = None;

    let request = DiagnosticRequest::new(fixture.corpus_id.clone(), vec![query()]);
    let plan = plan_diagnostic(&fixture.cache_root, &request, &config).expect("plan");
    let blocked: Vec<&str> = plan
        .blocked_lanes
        .iter()
        .filter(|blocked| blocked.code == "rerank_dialect_not_explicit")
        .map(|blocked| blocked.lane.as_str())
        .collect();
    assert_eq!(
        blocked.len(),
        3,
        "exactly the three rerank lanes: {blocked:?}"
    );
    assert_eq!(
        fixture.gateway.request_count(),
        fixture.requests_after_ingest,
        "planning must never touch the network"
    );
    assert_eq!(
        fixture.reads.load(Ordering::SeqCst),
        0,
        "planning must never read a credential"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_drifted_embedding_space_fails_closed_and_the_plan_names_the_repair() {
    let fixture = fixture().await;
    // Same endpoint and dialect, different model: a drift the old free-form
    // `model_id` binding would also have caught, plus a dialect change it
    // would not have.
    let mut config = fixture.config.clone();
    let embedding = config.retrieval.embedding.as_mut().expect("role");
    embedding.model = "a-different-model".into();

    let request = DiagnosticRequest::new(fixture.corpus_id.clone(), vec![query()]);
    let plan = plan_diagnostic(&fixture.cache_root, &request, &config).expect("plan");
    let reanalysis = plan.reanalysis.expect("a drifted corpus needs re-analysis");
    match &reanalysis.reason {
        ReanalysisReason::SpaceDrift { fields } => {
            assert!(fields.iter().any(|field| field == "model"), "{fields:?}");
        }
        other => panic!("expected drift, got {other:?}"),
    }
    // The endpoint is loopback, so the repair is local and needs no consent.
    assert!(!reanalysis.requires_egress_consent);
    assert!(reanalysis
        .locality_copy()
        .contains("does not leave this machine"));

    let cache_root = fixture.cache_root.clone();
    let report = run_diagnostic(
        &fixture.cache_root,
        &request,
        &config,
        Some(&fixture.secrets),
        |_lane| tool_host(&cache_root),
        None,
    )
    .await
    .expect("a drifted space degrades, it does not fail the run");

    let rrf = report
        .lanes
        .iter()
        .find(|lane| lane.lane == "hybrid_rrf")
        .expect("rrf lane");
    assert!(
        rrf.execution
            .fallback_codes
            .iter()
            .any(|code| code == "embedding_space_drift"),
        "a drifted space must be refused with a typed code: {:?}",
        rrf.execution.fallback_codes
    );
    assert_eq!(
        rrf.execution.mode_used.as_deref(),
        Some("structured_keyword"),
        "the semantic lane is withheld and the baseline is kept"
    );
    assert_ne!(report.verdict, DiagnosticVerdict::Executed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_legacy_corpus_without_a_typed_space_fails_closed_until_reanalysis_rebinds_it() {
    let fixture = fixture().await;
    // Simulate a corpus written by an older build: strip the typed space from
    // meta.json while leaving the vectors and the legacy `modelId` intact.
    let meta_path = fixture
        .cache_root
        .join("log_corpora")
        .join(&fixture.corpus_id)
        .join("meta.json");
    let before = std::fs::read(&meta_path).expect("meta");
    let mut meta: serde_json::Value = serde_json::from_slice(&before).expect("meta json");
    meta["embedding"]
        .as_object_mut()
        .expect("embedding object")
        .remove("space");
    std::fs::write(&meta_path, serde_json::to_vec_pretty(&meta).unwrap()).expect("rewrite meta");

    let status = LogCorpus::open(&fixture.cache_root, &fixture.corpus_id)
        .expect("open")
        .embedding_status();
    assert!(status.space.is_none(), "the fixture is now legacy");
    assert!(status.embedded_templates > 0, "vectors still present");
    assert!(
        status.model_id.is_some(),
        "legacy model label still present"
    );

    let request = DiagnosticRequest::new(fixture.corpus_id.clone(), vec![query()]);
    let plan = plan_diagnostic(&fixture.cache_root, &request, &fixture.config).expect("plan");
    assert_eq!(
        plan.reanalysis.expect("plan").reason,
        ReanalysisReason::LegacyUnbound,
        "a legacy binding is repaired by re-analysis, never assumed compatible"
    );

    let cache_root = fixture.cache_root.clone();
    let report = run_diagnostic(
        &fixture.cache_root,
        &request,
        &fixture.config,
        Some(&fixture.secrets),
        |_lane| tool_host(&cache_root),
        None,
    )
    .await
    .expect("legacy degrades, it does not fail the run");

    let rrf = report
        .lanes
        .iter()
        .find(|lane| lane.lane == "hybrid_rrf")
        .expect("rrf lane");
    assert!(
        rrf.execution
            .fallback_codes
            .iter()
            .any(|code| code == "embedding_space_legacy_unbound"),
        "legacy must fail closed with its own code: {:?}",
        rrf.execution.fallback_codes
    );
    assert_eq!(
        rrf.execution.mode_used.as_deref(),
        Some("structured_keyword"),
        "the keyword baseline remains fully usable"
    );
    assert!(
        !rrf.queries.is_empty(),
        "a refused semantic lane still produces a scored baseline"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pre_cancelled_run_stops_without_provider_work_or_a_report_claim() {
    let fixture = fixture().await;
    let before = fixture.gateway.request_count();
    let cancel = CancelFlag::new();
    cancel.cancel();

    let request = DiagnosticRequest::new(fixture.corpus_id.clone(), vec![query()]);
    let cache_root = fixture.cache_root.clone();
    let report = run_diagnostic(
        &fixture.cache_root,
        &request,
        &fixture.config,
        Some(&fixture.secrets),
        |_lane| tool_host(&cache_root),
        Some(&cancel),
    )
    .await;

    match report {
        Err(CoreError::Cancelled) => {}
        Ok(report) => {
            assert!(
                report
                    .lanes
                    .iter()
                    .all(|lane| lane.status == LaneStatus::Cancelled
                        || lane.status == LaneStatus::Blocked),
                "a cancelled run must not report executed lanes"
            );
            assert_eq!(report.verdict, DiagnosticVerdict::Inconclusive);
        }
        Err(other) => panic!("unexpected error: {other}"),
    }
    // The probes run before the lanes, so a few probe calls are expected; what
    // must NOT happen is a full six-lane sweep after cancellation.
    let after = fixture.gateway.request_count();
    assert!(
        after - before < 12,
        "a cancelled run kept issuing provider requests: {} new",
        after - before
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn measuring_never_writes_configuration_or_corpus_state() {
    let fixture = fixture().await;
    let corpus_root = fixture
        .cache_root
        .join("log_corpora")
        .join(&fixture.corpus_id);
    let meta_before = std::fs::read(corpus_root.join("meta.json")).expect("meta");
    let templates_before = std::fs::read(corpus_root.join("templates.json")).expect("templates");
    let config_before = serde_json::to_vec(&fixture.config).expect("config");

    let request = DiagnosticRequest::new(fixture.corpus_id.clone(), vec![query()]);
    let cache_root = fixture.cache_root.clone();
    let report = run_diagnostic(
        &fixture.cache_root,
        &request,
        &fixture.config,
        Some(&fixture.secrets),
        |_lane| tool_host(&cache_root),
        None,
    )
    .await
    .expect("diagnostic runs");
    assert!(!report.lanes.is_empty());

    assert_eq!(
        std::fs::read(corpus_root.join("meta.json")).expect("meta after"),
        meta_before,
        "a benchmark must not rewrite corpus metadata"
    );
    assert_eq!(
        std::fs::read(corpus_root.join("templates.json")).expect("templates after"),
        templates_before,
        "a benchmark must not rewrite the template index"
    );
    assert_eq!(
        serde_json::to_vec(&fixture.config).expect("config after"),
        config_before,
        "a benchmark must not change configuration"
    );
    // No re-analysis candidates or backups were left behind.
    let leftovers: Vec<String> = std::fs::read_dir(&corpus_root)
        .expect("read corpus dir")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.contains(".candidate") || name.contains(".backup"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "leftover staging files: {leftovers:?}"
    );
}
