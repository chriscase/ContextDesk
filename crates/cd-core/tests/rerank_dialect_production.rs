//! Explicit rerank dialect contracts — production + shared parser hermetic lab.

use cd_core::rerank::{
    parse_tei_cohere_ranking_indices, parse_tei_cohere_rerank_scores, resolve_rerank_dialect,
    HttpRerankBackend, RerankBackend, RerankDialect,
};
use cd_test_gateway::{MockGateway, Response, Step};
use serde_json::json;

#[test]
fn dialect_never_inferred_from_url_string() {
    assert!(RerankDialect::parse_explicit("https://ai-gateway.example/v1").is_err());
    assert!(RerankDialect::parse_explicit("http://127.0.0.1:8080/rerank").is_err());
    assert_eq!(
        resolve_rerank_dialect(None).as_str(),
        "tei_cohere",
        "unset config uses registered default, not a URL probe"
    );
    assert_eq!(
        RerankDialect::parse_explicit("qwen_reranker").unwrap(),
        RerankDialect::TeiCohere
    );
}

#[tokio::test]
async fn explicit_tei_cohere_dialect_realigns_qwen_style_scores() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "results": [
            {"index": 2, "relevanceScore": 0.1},
            {"index": 0, "relevanceScore": 0.95},
            {"index": 1, "relevanceScore": 0.4},
        ]
    })))])
    .await;
    let backend = HttpRerankBackend::with_dialect(
        gateway.base_url(),
        "qwen3-reranker-0.6b",
        None,
        RerankDialect::TeiCohere,
    )
    .unwrap();
    assert_eq!(backend.dialect(), RerankDialect::TeiCohere);
    let docs = vec!["d0".into(), "d1".into(), "d2".into()];
    let scores = backend.rerank("query", &docs).await.unwrap();
    assert_eq!(scores, vec![0.95, 0.4, 0.1]);
    let body = gateway.requests()[0].json_body().unwrap();
    assert_eq!(body["top_n"], 3, "top-N bound preserved on the wire");
}

#[tokio::test]
async fn malformed_rerank_envelopes_fail_closed_so_callers_keep_pre_rerank_order() {
    for body in [
        json!({"results": [{"index": 0, "relevance_score": 0.5}]}), // missing
        json!({"results": [
            {"index": 0, "relevance_score": 0.5},
            {"index": 0, "relevance_score": 0.6},
        ]}), // duplicate
        json!({"results": [
            {"index": 0, "relevance_score": 0.5},
            {"index": 99, "relevance_score": 0.6},
        ]}), // OOR
    ] {
        let gateway =
            MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&body))]).await;
        let backend = HttpRerankBackend::with_dialect(
            gateway.base_url(),
            "m",
            None,
            RerankDialect::TeiCohere,
        )
        .unwrap();
        let err = backend
            .rerank("q", &["a".into(), "b".into()])
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("rerank response contract")
                || err.to_string().contains("out of range")
                || err.to_string().contains("duplicate")
                || err.to_string().contains("missing"),
            "{err}"
        );
    }
}

#[test]
fn shared_ranking_indices_agree_with_score_realignment() {
    let body = json!({
        "results": [
            {"index": 1, "relevance_score": 0.2},
            {"index": 0, "relevance_score": 0.9},
        ]
    });
    let scores = parse_tei_cohere_rerank_scores(&body, 2).unwrap();
    assert_eq!(scores, vec![0.9, 0.2]);
    let indices = parse_tei_cohere_ranking_indices(&body, 2).unwrap();
    assert_eq!(indices, vec![0, 1], "higher score first");
}
