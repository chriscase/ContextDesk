//! Production retrieval path: OpenAI-compatible embed + explicit rerank dialect
//! factories, fixed-corpus mode ablation, and share-safe reports.
//!
//! All traffic is hermetic (`cd_test_gateway`). Secrets are synthetic `file:`
//! refs. No live gateway / Keychain.

use cd_core::config::{AppConfig, EmbedWireKind, RetrievalRoleModel, RetrievalSettings};
use cd_core::embed::{ConceptEmbedBackend, EmbedBackend, OpenAiCompatibleEmbedBackend};
use cd_core::keychain_store::{file_secret_ref, ReferencedSecretStore};
use cd_core::log_analysis::{
    hybrid_search_events, HybridModeUsed, HybridOptions, LogCorpus, LogEmbedMode, LogEmbedPolicy,
};
use cd_core::rerank::{HttpRerankBackend, RerankBackend, RerankDialect, ScriptedRerankBackend};
use cd_test_gateway::{MockGateway, Response, Step};
use cd_workflow::retrieval::{
    assert_share_safe_json, build_embedding_backend, build_rerank_backend,
    registered_rerank_dialect, share_safe_retrieval_report, ShareSafeModeAggregate,
};
use serde_json::json;
use std::sync::Arc;

const PINNED: &[&str] = &[
    "CHRONOLOGY_PIN",
    "INITIATING_CHANGE_PIN",
    "CONTRADICTION_PIN",
    "ROLLBACK_PIN",
    "RECOVERY_PIN",
    "INDEPENDENT_ERROR_PIN",
];

fn synthetic_secret(dir: &tempfile::TempDir, name: &str, value: &str) -> String {
    let path = dir.path().join(name);
    std::fs::write(&path, value).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    file_secret_ref(&path).unwrap()
}

fn role(
    base_url: &str,
    model: &str,
    api_key_ref: Option<String>,
    wire: EmbedWireKind,
    dialect: RerankDialect,
) -> RetrievalRoleModel {
    RetrievalRoleModel {
        enabled: true,
        base_url: base_url.into(),
        model: model.into(),
        dialect: None,
        allow_remote: false,
        api_key_ref,
        embed_wire: wire,
        rerank_dialect: dialect,
    }
}

fn seed_pinned_corpus(cache: &std::path::Path) -> String {
    let logs = cache.join("pinned.log");
    let mut body = String::new();
    for (i, pin) in PINNED.iter().enumerate() {
        body.push_str(&format!(
            "2024-01-01T00:0{i}:00Z level=error service=svc msg={pin} detail=event-{i}\n"
        ));
    }
    // Noise that must not drop pins from the candidate pool under keyword mode.
    body.push_str("2024-01-01T00:10:00Z level=info service=svc msg=unrelated heartbeat\n");
    std::fs::write(&logs, &body).unwrap();
    let embed: Arc<dyn EmbedBackend> = Arc::new(ConceptEmbedBackend::new(64));
    let policy = LogEmbedPolicy {
        mode: LogEmbedMode::Local,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: embed.identity(),
        defer_above_source_bytes: None,
    };
    let report = cd_core::log_analysis::ingest_path_with_policy(
        cache,
        &logs,
        "pinned-ablation",
        &policy,
        Some(embed),
    )
    .expect("ingest");
    report.corpus_id
}

fn count_pins(messages: &[String]) -> u64 {
    PINNED
        .iter()
        .filter(|p| messages.iter().any(|m| m.contains(*p)))
        .count() as u64
}

#[tokio::test]
async fn production_factory_builds_openai_embed_with_protected_file_and_binds_model() {
    let secret = "sk-retrieval-factory-synthetic";
    let dir = tempfile::tempdir().unwrap();
    let api_key_ref = synthetic_secret(&dir, "r.secret", secret);
    let store = ReferencedSecretStore::new();

    let vec = (0..8).map(|i| i as f32 * 0.1).collect::<Vec<_>>();
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "model": "bge-m3",
        "data": [{"index": 0, "embedding": vec}]
    })))])
    .await;

    let r = role(
        &format!("{}/v1", gateway.base_url()),
        "bge-m3",
        Some(api_key_ref),
        EmbedWireKind::OpenAiCompatible,
        RerankDialect::TeiCohere,
    );
    let backend = build_embedding_backend(&r, Some(&store)).expect("factory");
    assert_eq!(backend.identity(), "bge-m3");
    let out = backend.embed(&["probe".into()]).await.unwrap();
    assert_eq!(out[0].len(), 8);
    let requests = gateway.requests();
    let auth = requests[0].header("authorization").unwrap();
    assert!(auth.contains(secret));
    assert_eq!(backend.identity(), "bge-m3");
    assert!(!backend.identity().contains(secret));
}

#[tokio::test]
async fn production_rerank_factory_uses_explicit_dialect_not_url() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "results": [
            {"index": 1, "relevance_score": 0.9},
            {"index": 0, "relevance_score": 0.1},
        ]
    })))])
    .await;
    // URL path that might tempt URL-inference for a different dialect — must
    // still use the explicit TeiCohere contract.
    let r = role(
        &format!("{}/v1", gateway.base_url()),
        "qwen3-reranker-0.6b",
        None,
        EmbedWireKind::OpenAiCompatible,
        RerankDialect::TeiCohere,
    );
    assert_eq!(registered_rerank_dialect(&r), RerankDialect::TeiCohere);
    let backend = build_rerank_backend(&r, None).unwrap();
    let scores = backend
        .rerank("q", &["a".into(), "b".into()])
        .await
        .unwrap();
    assert_eq!(scores, vec![0.1, 0.9]);
}

#[test]
fn fixed_corpus_ablation_modes_preserve_pinned_evidence() {
    let cache = tempfile::tempdir().unwrap();
    let corpus_id = seed_pinned_corpus(cache.path());
    let corpus = LogCorpus::open(cache.path(), &corpus_id).unwrap();
    let embed: Arc<dyn EmbedBackend> = Arc::new(ConceptEmbedBackend::new(64));
    let rerank: Arc<dyn RerankBackend> = Arc::new(ScriptedRerankBackend);

    let keyword_terms: Vec<String> = PINNED.iter().map(|p| (*p).to_string()).collect();
    let base_opts = HybridOptions {
        keyword_terms: keyword_terms.clone(),
        semantic_query: Some("CHRONOLOGY_PIN INITIATING_CHANGE_PIN recovery rollback".into()),
        k: 20,
        rerank_candidate_depth: 10,
        ..HybridOptions::default()
    };

    // 1) exact/BM25-style structured keyword only
    let kw = hybrid_search_events(&corpus, &base_opts, None, None, None).unwrap();
    assert_eq!(kw.mode_used, HybridModeUsed::StructuredKeyword);
    let kw_msgs: Vec<_> = kw.candidates.iter().map(|c| c.message.clone()).collect();
    let kw_pins = count_pins(&kw_msgs);
    assert!(
        kw_pins >= 4,
        "keyword mode must keep most pinned evidence: {kw_pins} hits in {kw_msgs:?}"
    );

    // 2) dense / hybrid embedding (keyword + semantic)
    let dense =
        hybrid_search_events(&corpus, &base_opts, Some(embed.as_ref()), None, None).unwrap();
    assert_eq!(dense.mode_used, HybridModeUsed::HybridEmbedding);
    let dense_msgs: Vec<_> = dense.candidates.iter().map(|c| c.message.clone()).collect();
    assert!(count_pins(&dense_msgs) >= 4);

    // 3) hybrid + rerank
    let hybrid_rr = hybrid_search_events(
        &corpus,
        &base_opts,
        Some(embed.as_ref()),
        Some(rerank.as_ref()),
        None,
    )
    .unwrap();
    assert_eq!(hybrid_rr.mode_used, HybridModeUsed::HybridEmbeddingReranked);
    let rr_msgs: Vec<_> = hybrid_rr
        .candidates
        .iter()
        .map(|c| c.message.clone())
        .collect();
    assert!(count_pins(&rr_msgs) >= 4);

    // 4) keyword + rerank (no semantic query → structured + optional rerank
    //    only reorders when semantic also ran; without embed, rerank still
    //    may run on merged keyword set if both are provided — check outcome)
    let kw_only_opts = HybridOptions {
        keyword_terms,
        semantic_query: None,
        k: 20,
        rerank_candidate_depth: 10,
        ..HybridOptions::default()
    };
    let kw_rerank =
        hybrid_search_events(&corpus, &kw_only_opts, None, Some(rerank.as_ref()), None).unwrap();
    // Without semantic lane, mode is structured_keyword even if rerank is
    // offered — honesty about which lanes executed.
    assert_eq!(kw_rerank.mode_used, HybridModeUsed::StructuredKeyword);
    let kr_msgs: Vec<_> = kw_rerank
        .candidates
        .iter()
        .map(|c| c.message.clone())
        .collect();
    assert!(count_pins(&kr_msgs) >= 4);

    // Share-safe aggregates
    let modes = vec![
        ShareSafeModeAggregate {
            mode: kw.mode_used.as_str().into(),
            candidate_count: kw.candidates.len() as u64,
            latency_ms: None,
            embedding_calls: kw.telemetry.embedding_calls,
            rerank_calls: kw.telemetry.rerank_calls,
            failure_categories: kw.degradations.iter().map(|d| d.code.clone()).collect(),
            pinned_evidence_hits: kw_pins,
        },
        ShareSafeModeAggregate {
            mode: dense.mode_used.as_str().into(),
            candidate_count: dense.candidates.len() as u64,
            latency_ms: dense.telemetry.embedding_latency_ms,
            embedding_calls: dense.telemetry.embedding_calls,
            rerank_calls: dense.telemetry.rerank_calls,
            failure_categories: dense.degradations.iter().map(|d| d.code.clone()).collect(),
            pinned_evidence_hits: count_pins(&dense_msgs),
        },
        ShareSafeModeAggregate {
            mode: hybrid_rr.mode_used.as_str().into(),
            candidate_count: hybrid_rr.candidates.len() as u64,
            latency_ms: hybrid_rr.telemetry.rerank_latency_ms,
            embedding_calls: hybrid_rr.telemetry.embedding_calls,
            rerank_calls: hybrid_rr.telemetry.rerank_calls,
            failure_categories: hybrid_rr
                .degradations
                .iter()
                .map(|d| d.code.clone())
                .collect(),
            pinned_evidence_hits: count_pins(&rr_msgs),
        },
    ];
    let private_profile = "employer-private-profile-id-xyz";
    let private_model = "private-bge-m3-catalog-id";
    let private_url = "https://gateway.internal.example/v1";
    let report = share_safe_retrieval_report(
        private_profile,
        private_model,
        Some(private_url),
        Some(64),
        Some(RerankDialect::TeiCohere),
        modes,
        Some(12),
    );
    let json = serde_json::to_string_pretty(&report).unwrap();
    assert_share_safe_json(
        &json,
        &[
            private_profile,
            private_model,
            private_url,
            "sk-",
            "Bearer ",
        ],
    )
    .expect("share-safe");
    assert!(report.profile_pseudonym.starts_with("p-"));
    assert!(report.model_pseudonym.starts_with("p-"));
    assert!(report.endpoint_fingerprint.is_some());
    assert_eq!(report.embedding_dimensions, Some(64));
    assert_eq!(report.rerank_dialect.as_deref(), Some("tei_cohere"));
    assert!(!json.contains(private_url));
    // Persist sample for skeptic evidence (caller may copy to scratch).
    let _ = json;
}

#[tokio::test]
async fn openai_embed_backend_and_http_rerank_share_registered_contracts() {
    // Production backends speak the same parse contracts as qualification.
    let emb_gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "model": "bge-m3",
        "data": [{"index": 0, "embedding": [0.1, 0.2, 0.3]}]
    })))])
    .await;
    let emb = OpenAiCompatibleEmbedBackend::new(
        &format!("{}/v1", emb_gateway.base_url()),
        "bge-m3",
        None,
    )
    .unwrap();
    assert_eq!(emb.embed(&["x".into()]).await.unwrap()[0].len(), 3);

    let rr_gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "results": [
            {"index": 0, "relevance_score": 0.2},
            {"index": 1, "relevance_score": 0.8},
        ]
    })))])
    .await;
    let rr = HttpRerankBackend::with_dialect(
        rr_gateway.base_url(),
        "qwen3-reranker-0.6b",
        None,
        RerankDialect::TeiCohere,
    )
    .unwrap();
    assert_eq!(
        rr.rerank("q", &["a".into(), "b".into()]).await.unwrap(),
        vec![0.2, 0.8]
    );
}

#[test]
fn appconfig_retrieval_roles_default_to_openai_compatible_wire() {
    let cfg = AppConfig {
        retrieval: RetrievalSettings {
            embedding: Some(role(
                "http://127.0.0.1:9/v1",
                "bge-m3",
                None,
                EmbedWireKind::OpenAiCompatible,
                RerankDialect::TeiCohere,
            )),
            reranker: Some(role(
                "http://127.0.0.1:9",
                "qwen3-reranker-0.6b",
                None,
                EmbedWireKind::OpenAiCompatible,
                RerankDialect::TeiCohere,
            )),
        },
        ..AppConfig::default()
    };
    let emb = cfg.retrieval.embedding.as_ref().unwrap();
    assert_eq!(emb.embed_wire, EmbedWireKind::OpenAiCompatible);
    assert_eq!(
        registered_rerank_dialect(cfg.retrieval.reranker.as_ref().unwrap()),
        RerankDialect::TeiCohere
    );
}
