//! Gateway wire conformance lab — Phase 7: embedding matrix.
//!
//! Drives the ONE production, network-calling `EmbedBackend`:
//! `OllamaEmbedBackend` (wrapping `OllamaClient::embed`, `POST /api/embeddings`,
//! single input per call — the trait's batch signature loops sequentially,
//! never a single batched wire request).
//!
//! Two other embedding wire dialects exist in this codebase
//! (`cd_workflow::capability_qualification`'s OpenAI-standard `/v1/embeddings`
//! probe, and the standalone `cd-vercel-retrieval-lab` bin's batched Vercel
//! v4 dialect) but neither is wired into the `EmbedBackend` trait real hybrid
//! retrieval uses — the qualification probe is covered by the capability
//! probe test below; the Vercel lab bin is an explicitly-labeled dev tool,
//! out of scope for this lab. Batch-shaped concerns the task asks about
//! (duplicate/missing result indexes, heterogeneous per-item dimensions
//! within one response) do not apply to `OllamaEmbedBackend`'s wire shape at
//! all — there is no index concept in a single-embedding response. Where a
//! scenario does not apply to the implemented boundary, this file documents
//! that rather than inventing a fake indexed dialect to test against.

use cd_core::chat::OllamaClient;
use cd_core::embed::{EmbedBackend, OllamaEmbedBackend};
use cd_test_gateway::{MockGateway, Response, Step};
use serde_json::json;
use std::time::Duration;

fn embed_backend(gateway: &MockGateway) -> OllamaEmbedBackend {
    let client = OllamaClient::new(gateway.base_url(), "nomic-embed-text").expect("client");
    OllamaEmbedBackend::new(client)
}

// ---------------------------------------------------------------------------
// One input
// ---------------------------------------------------------------------------

#[tokio::test]
async fn one_input_embeds_via_a_single_post_to_api_embeddings() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "embedding": [0.1, 0.2, 0.3]
    })))])
    .await;
    let vectors = embed_backend(&gateway)
        .embed(&["hello world".to_string()])
        .await
        .unwrap();
    assert_eq!(vectors, vec![vec![0.1, 0.2, 0.3]]);
    assert_eq!(gateway.request_count(), 1);
    let sent = gateway.requests();
    assert_eq!(sent[0].path, "/api/embeddings");
    let body = sent[0].json_body().unwrap();
    assert_eq!(body["model"], "nomic-embed-text");
    assert_eq!(body["prompt"], "hello world");
}

// ---------------------------------------------------------------------------
// Batched inputs: N sequential single-input requests, stable ordering
// ---------------------------------------------------------------------------

#[tokio::test]
async fn batched_inputs_issue_one_sequential_request_per_input_in_order() {
    let gateway = MockGateway::start_ordered(vec![
        Step::respond(Response::json_ok(&json!({"embedding": [1.0, 0.0]}))),
        Step::respond(Response::json_ok(&json!({"embedding": [0.0, 1.0]}))),
        Step::respond(Response::json_ok(&json!({"embedding": [0.5, 0.5]}))),
    ])
    .await;
    let texts = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    let vectors = embed_backend(&gateway).embed(&texts).await.unwrap();
    assert_eq!(
        vectors,
        vec![vec![1.0, 0.0], vec![0.0, 1.0], vec![0.5, 0.5]]
    );
    assert_eq!(
        gateway.request_count(),
        3,
        "no batching at the wire — one request per input"
    );
    let sent = gateway.requests();
    let prompts: Vec<_> = sent
        .iter()
        .map(|r| {
            r.json_body().unwrap()["prompt"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(
        prompts,
        vec!["a", "b", "c"],
        "requests are issued in input order"
    );
}

// ---------------------------------------------------------------------------
// Empty batch: zero HTTP calls
// ---------------------------------------------------------------------------

#[tokio::test]
async fn empty_batch_makes_no_request_and_returns_an_empty_vector() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(500))]).await;
    let vectors = embed_backend(&gateway).embed(&[]).await.unwrap();
    assert!(vectors.is_empty());
    assert_eq!(
        gateway.request_count(),
        0,
        "an empty batch must never touch the wire"
    );
}

// ---------------------------------------------------------------------------
// Dimension mismatch / heterogeneous dimensions: documents a real gap —
// nothing at this layer cross-checks dimension consistency between calls.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn heterogeneous_dimensions_across_calls_are_not_rejected_documents_the_gap() {
    let gateway = MockGateway::start_ordered(vec![
        Step::respond(Response::json_ok(&json!({"embedding": [0.1, 0.2, 0.3]}))),
        Step::respond(Response::json_ok(&json!({"embedding": [0.1, 0.2]}))),
    ])
    .await;
    let texts = vec!["three-dim".to_string(), "two-dim".to_string()];
    let vectors = embed_backend(&gateway)
        .embed(&texts)
        .await
        .expect("no dimension-consistency check exists at this layer");
    assert_eq!(vectors[0].len(), 3);
    assert_eq!(
        vectors[1].len(),
        2,
        "documents the gap: EmbedBackend::embed does not enforce a uniform dimension \
         across the batch — that protection lives one layer up, in \
         log_analysis::hybrid_retrieval's CountingEmbed/embedding_binding_mismatch, \
         which is retrieval policy rather than a wire-boundary concern this lab tests"
    );
}

// ---------------------------------------------------------------------------
// Non-finite values: `.is_finite()` really is absent from OllamaClient::embed
// (unlike rerank's validate_rerank_scores) — but proven over the real wire,
// the only way to attempt a non-finite component (an out-of-range numeric
// literal; raw NaN/Infinity tokens are not valid JSON) is rejected by
// serde_json's own parser before any component-level check would run at
// all. So while the missing `.is_finite()` guard is a real, documented gap
// in the source, it is not reachable via a standards-conformant JSON
// response — this test proves that boundary rather than assuming it.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn out_of_range_numeric_literal_is_rejected_by_json_parsing_itself() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::text(
        200,
        "application/json",
        r#"{"embedding": [1e400, 0.2, -1e400]}"#,
    ))])
    .await;
    let err = embed_backend(&gateway)
        .embed(&["overflow".to_string()])
        .await
        .expect_err("an out-of-range exponent must fail at JSON parse time");
    assert!(err.to_string().contains("embed json"), "{err}");
}

// ---------------------------------------------------------------------------
// Truncated vectors / malformed body
// ---------------------------------------------------------------------------

#[tokio::test]
async fn truncated_response_body_fails_closed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(cd_test_gateway::Response::new(
        200,
        cd_test_gateway::Body::FixedThenDrop {
            declared_len: 100,
            sent: br#"{"embedding": [0.1, 0.2"#.to_vec(),
            reset: false,
        },
    ))])
    .await;
    let err = embed_backend(&gateway)
        .embed(&["x".to_string()])
        .await
        .expect_err("a truncated body must not parse as a valid embedding");
    assert!(!err.to_string().is_empty());
}

#[tokio::test]
async fn malformed_json_fails_closed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::text(
        200,
        "application/json",
        "not json",
    ))])
    .await;
    let err = embed_backend(&gateway)
        .embed(&["x".to_string()])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("json"));
}

// ---------------------------------------------------------------------------
// Duplicate/missing result indexes: not applicable to this dialect
// ---------------------------------------------------------------------------
//
// Ollama's /api/embeddings response is a single flat `embedding` array with
// no index field at all — there is nothing to duplicate or omit an index
// for. This is intentionally NOT tested with a synthetic indexed shape,
// which would invent support this dialect does not have (contrast with
// Phase 8's rerank matrix, whose TEI/Cohere dialect genuinely is indexed).

// ---------------------------------------------------------------------------
// Unexpected chat-shaped response
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_shaped_response_fails_closed_with_a_clear_reason() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "model": "nomic-embed-text",
        "message": {"role": "assistant", "content": "I am a chat response, not an embedding."},
        "done": true
    })))])
    .await;
    let err = embed_backend(&gateway)
        .embed(&["x".to_string()])
        .await
        .unwrap_err();
    assert!(err.to_string().contains("missing embedding array"), "{err}");
}

// ---------------------------------------------------------------------------
// Model/route rejection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn status_matrix_fails_closed() {
    for status in [404u16, 500, 503] {
        let gateway =
            MockGateway::start_ordered(vec![Step::respond(Response::status_only(status))]).await;
        let err = embed_backend(&gateway)
            .embed(&["x".to_string()])
            .await
            .unwrap_err();
        assert!(err.to_string().contains(&status.to_string()), "{err}");
    }
}

// ---------------------------------------------------------------------------
// Cancellation and timeout: OllamaClient::embed accepts no cancellation
// token at all — only the client's own fixed 120s timeout bounds a stalled
// call. This documents that gap and proves the timeout ceiling itself.
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn stalled_embed_call_times_out_at_the_pinned_client_bound() {
    let gateway = MockGateway::start_ordered(vec![Step::Stall]).await;
    let backend = embed_backend(&gateway);
    let call = tokio::spawn(async move { backend.embed(&["x".to_string()]).await });
    tokio::time::advance(Duration::from_secs(121)).await;
    let outcome = call.await.expect("join");
    assert!(
        outcome.is_err(),
        "documents that timeout is the only ceiling — OllamaClient::embed takes no cancel token"
    );
}
