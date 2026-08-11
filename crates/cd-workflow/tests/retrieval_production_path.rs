//! Production retrieval seam: configured embedding and reranker roles must
//! reach the real hybrid-search workflow through the shared adapters.
//!
//! This is deliberately hermetic. The mock gateway stands in for an
//! OpenAI-compatible employer deployment, while the credential is read from
//! a protected `file:` reference. No Keychain, live gateway, or incident data
//! is involved.

use cd_core::config::RetrievalRoleModel;
use cd_core::embed::EmbedBackend;
use cd_core::keychain_store::{file_secret_ref, ReferencedSecretStore};
use cd_core::log_analysis::{
    hybrid_search_events, ingest_path_with_policy, HybridModeUsed, HybridOptions, LogEmbedMode,
    LogEmbedPolicy,
};
use cd_test_gateway::{MockGateway, Response, Step};
use cd_workflow::retrieval::{build_embedding_backend, build_rerank_backend};
use serde_json::json;
use std::sync::Arc;

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

fn embedding_role(base_url: &str, api_key_ref: &str) -> RetrievalRoleModel {
    RetrievalRoleModel {
        enabled: true,
        base_url: base_url.to_string(),
        model: "bge-m3".into(),
        dialect: Some("openai_embeddings".into()),
        allow_remote: false,
        api_key_ref: Some(api_key_ref.to_string()),
    }
}

fn reranker_role(base_url: &str, api_key_ref: &str) -> RetrievalRoleModel {
    RetrievalRoleModel {
        enabled: true,
        base_url: base_url.to_string(),
        model: "qwen3-reranker-0.6b".into(),
        dialect: Some("tei_rerank_v1".into()),
        allow_remote: false,
        api_key_ref: Some(api_key_ref.to_string()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_roles_use_protected_file_and_real_hybrid_retrieval_seam() {
    let secrets_dir = tempfile::tempdir().unwrap();
    let secret_ref = protected_secret(&secrets_dir);
    let secrets = ReferencedSecretStore::new();

    // One template is enough to exercise ingestion, query embedding, and
    // reranking. The ordered mock repeats its final response if the adapter
    // makes another bounded request.
    let embedding_gateway =
        MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
            "model": "bge-m3",
            "data": [{"index": 0, "embedding": [0.9, 0.1]}]
        })))])
        .await;
    let rerank_gateway =
        MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
            "results": [{"index": 0, "relevance_score": 0.99}]
        })))])
        .await;

    let embedding = build_embedding_backend(
        &embedding_role(embedding_gateway.base_url(), &secret_ref),
        Some(&secrets),
    )
    .expect("configured embedding factory");
    let reranker = build_rerank_backend(
        &reranker_role(rerank_gateway.base_url(), &secret_ref),
        Some(&secrets),
    )
    .expect("configured reranker factory");
    assert_eq!(embedding.identity(), "bge-m3");
    assert_eq!(reranker.identity(), "qwen3-reranker-0.6b");

    let cache = tempfile::tempdir().unwrap();
    let source = cache.path().join("synthetic.log");
    std::fs::write(
        &source,
        "2026-01-01T00:00:00Z level=error service=db msg=database connection timeout\n",
    )
    .unwrap();
    let policy = LogEmbedPolicy {
        mode: LogEmbedMode::Cloud,
        cloud_content_leaves_machine: true,
        cloud_base_url: Some(embedding_gateway.base_url().to_string()),
        model_id: "bge-m3".into(),
        defer_above_source_bytes: None,
    };
    let report = tokio::task::block_in_place(|| {
        ingest_path_with_policy(
            cache.path(),
            &source,
            "production-retrieval-seam",
            &policy,
            Some(Arc::clone(&embedding) as Arc<dyn EmbedBackend>),
        )
    })
    .expect("synthetic corpus ingest");
    let corpus = cd_core::log_analysis::LogCorpus::open(cache.path(), &report.corpus_id)
        .expect("open synthetic corpus");
    assert_eq!(
        corpus.embedding_status().model_id.as_deref(),
        Some("bge-m3")
    );

    let outcome = tokio::task::block_in_place(|| {
        hybrid_search_events(
            &corpus,
            &HybridOptions {
                keyword_terms: vec!["database".into()],
                semantic_query: Some("database connection timeout".into()),
                k: 10,
                // Pool == K: this test asserts the wire seam, not the effect
                // of a wider candidate pool.
                rerank_candidate_depth: 10,
                ..HybridOptions::default()
            },
            Some(embedding.as_ref()),
            Some(reranker.as_ref()),
            None,
        )
    })
    .expect("hybrid retrieval");

    assert_eq!(outcome.mode_used, HybridModeUsed::HybridEmbeddingReranked);
    assert_eq!(outcome.telemetry.embedding_calls, Some(1));
    assert_eq!(outcome.telemetry.rerank_calls, Some(1));
    assert_eq!(outcome.telemetry.embedding_model.as_deref(), Some("bge-m3"));
    assert_eq!(
        outcome.telemetry.rerank_model.as_deref(),
        Some("qwen3-reranker-0.6b")
    );
    assert_eq!(outcome.candidates.len(), 1);
    assert_eq!(outcome.candidates[0].final_rank, 1);

    let embedding_request = &embedding_gateway.requests()[0];
    assert_eq!(embedding_request.path, "/v1/embeddings");
    assert_eq!(
        embedding_request.header("authorization"),
        Some("Bearer synthetic-retrieval-key")
    );
    let rerank_request = &rerank_gateway.requests()[0];
    assert_eq!(rerank_request.path, "/rerank");
    assert_eq!(
        rerank_request.header("authorization"),
        Some("Bearer synthetic-retrieval-key")
    );
}
