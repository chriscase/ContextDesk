//! Gateway wire conformance lab — Phase 8: reranking matrix.
//!
//! Drives `HttpRerankBackend` — the TEI/Cohere-shaped `/rerank` dialect wired
//! into real hybrid retrieval — over a hermetic `cd_test_gateway::MockGateway`.
//! `crates/cd-core/src/rerank.rs`'s own `#[cfg(test)]` module already covers
//! stable document identity through permutation, missing-scores-fail-closed,
//! and duplicate-index-fails-closed at the wiremock level; this file adds
//! the wire-boundary cells that module does not cover (out-of-range index,
//! ties, non-finite scores actually deliverable over JSON, an unexpected
//! generative response, route rejection, and a genuine wire-level timeout)
//! plus documents the second (Vercel v4) dialect this codebase implements
//! outside the `RerankBackend` trait.

use cd_core::rerank::{rerank_blocking, HttpRerankBackend, RerankBackend};
use cd_test_gateway::{Body, MockGateway, Response, Step};
use serde_json::json;
use std::time::Duration;

fn backend(gateway: &MockGateway) -> HttpRerankBackend {
    HttpRerankBackend::new(gateway.base_url(), "matrix-reranker", None).expect("backend")
}

fn docs(n: usize) -> Vec<String> {
    (0..n).map(|i| format!("document {i}")).collect()
}

// ---------------------------------------------------------------------------
// Request shape and stable document identity through permutation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn request_shape_sends_model_query_and_documents_verbatim() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "results": [{"index": 0, "relevance_score": 0.9}]
    })))])
    .await;
    let documents = vec!["only doc".to_string()];
    let _ = backend(&gateway)
        .rerank("my query", &documents)
        .await
        .unwrap();
    let sent = gateway.requests()[0].json_body().unwrap();
    assert_eq!(sent["model"], "matrix-reranker");
    assert_eq!(sent["query"], "my query");
    assert_eq!(sent["documents"][0], "only doc");
    assert_eq!(gateway.requests()[0].path, "/rerank");
}

#[tokio::test]
async fn a_full_permutation_unscrambles_back_to_document_order() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "results": [
            {"index": 3, "relevance_score": 0.1},
            {"index": 0, "relevance_score": 0.9},
            {"index": 2, "relevance_score": 0.5},
            {"index": 1, "relevance_score": 0.7},
        ]
    })))])
    .await;
    let scores = backend(&gateway).rerank("q", &docs(4)).await.unwrap();
    assert_eq!(
        scores,
        vec![0.9, 0.7, 0.5, 0.1],
        "scores realign to input (document) order"
    );
}

// ---------------------------------------------------------------------------
// Out-of-range indexes
// ---------------------------------------------------------------------------

#[tokio::test]
async fn out_of_range_index_fails_closed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "results": [
            {"index": 0, "relevance_score": 0.5},
            {"index": 99, "relevance_score": 0.9},
        ]
    })))])
    .await;
    let err = backend(&gateway).rerank("q", &docs(2)).await.unwrap_err();
    assert!(err.to_string().contains("out of range"), "{err}");
}

// ---------------------------------------------------------------------------
// Non-finite scores: an out-of-range JSON numeric literal (the only wire-
// deliverable way to attempt a non-finite float — raw `NaN`/`Infinity`
// tokens are not valid JSON at all) is rejected by serde_json's own number
// parser before validate_rerank_scores's `.is_finite()` check ever runs.
// This is a stronger property than "the finiteness check catches it": no
// value that reaches that check over real JSON can ever be non-finite in
// the first place, at least via literal magnitude — proven here rather than
// assumed, since serde_json's behavior here (parse-time range rejection
// rather than silent overflow to infinity) is not obvious from the type
// signature alone.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn out_of_range_numeric_literal_is_rejected_by_json_parsing_itself() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::text(
        200,
        "application/json",
        r#"{"results": [{"index": 0, "relevance_score": 1e400}]}"#,
    ))])
    .await;
    let err = backend(&gateway).rerank("q", &docs(1)).await.unwrap_err();
    assert!(
        err.to_string().contains("rerank response contract"),
        "must fail closed via the JSON deserialization step, got {err}"
    );
}

// ---------------------------------------------------------------------------
// Ties: identical scores are not special-cased, order preserved by index
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tied_scores_are_accepted_and_returned_faithfully() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "results": [
            {"index": 0, "relevance_score": 0.5},
            {"index": 1, "relevance_score": 0.5},
            {"index": 2, "relevance_score": 0.5},
        ]
    })))])
    .await;
    let scores = backend(&gateway).rerank("q", &docs(3)).await.unwrap();
    assert_eq!(scores, vec![0.5, 0.5, 0.5]);
}

// ---------------------------------------------------------------------------
// Fewer results than requested (already unit-tested in rerank.rs; wire
// smoke-check here proves the real HTTP path, not just the parser)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fewer_results_than_documents_fails_closed_over_the_real_wire() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "results": [{"index": 0, "relevance_score": 0.5}]
    })))])
    .await;
    let err = backend(&gateway).rerank("q", &docs(3)).await.unwrap_err();
    // Shared TEI/Cohere parser rejects incomplete envelopes before inventing
    // zeros or non-finite sentinels for uncovered document slots.
    let msg = err.to_string();
    assert!(
        msg.contains("missing") || msg.contains("finite") || msg.contains("contract"),
        "{msg}"
    );
}

// ---------------------------------------------------------------------------
// Unexpected generative (chat-shaped) response
// ---------------------------------------------------------------------------

#[tokio::test]
async fn chat_shaped_response_fails_closed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "x",
        "choices": [{"message": {"role": "assistant", "content": "I ranked them for you: doc 0 first."}}]
    })))])
    .await;
    let err = backend(&gateway).rerank("q", &docs(2)).await.unwrap_err();
    assert!(
        err.to_string().contains("rerank response contract"),
        "{err}"
    );
}

// ---------------------------------------------------------------------------
// Route rejection
// ---------------------------------------------------------------------------

#[tokio::test]
async fn status_matrix_fails_closed() {
    for status in [404u16, 401, 429, 500, 503] {
        let gateway =
            MockGateway::start_ordered(vec![Step::respond(Response::status_only(status))]).await;
        let err = backend(&gateway).rerank("q", &docs(1)).await.unwrap_err();
        assert!(err.to_string().contains(&status.to_string()), "{err}");
    }
}

// ---------------------------------------------------------------------------
// Empty batch, batch bound
// ---------------------------------------------------------------------------

#[tokio::test]
async fn empty_document_list_makes_no_request() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(500))]).await;
    let scores = backend(&gateway).rerank("q", &[]).await.unwrap();
    assert!(scores.is_empty());
    assert_eq!(gateway.request_count(), 0);
}

#[tokio::test]
async fn batch_over_the_documented_bound_is_rejected_before_any_request() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(500))]).await;
    let too_many = docs(cd_core::rerank::RERANK_MAX_DOCUMENTS + 1);
    let err = backend(&gateway).rerank("q", &too_many).await.unwrap_err();
    assert!(err.to_string().contains("batch bound"));
    assert_eq!(
        gateway.request_count(),
        0,
        "the bound is enforced client-side, before any wire call"
    );
}

// ---------------------------------------------------------------------------
// Cancellation and timeout: rerank_blocking takes a fixed timeout but no
// cancellation token — proven here over a REAL stalled HTTP connection
// (rerank.rs's own test only stalls an in-process synthetic future).
// ---------------------------------------------------------------------------

#[test]
fn rerank_blocking_times_out_over_a_genuinely_stalled_real_connection() {
    // rerank_blocking spins its own fresh Tokio runtime on an OS thread
    // (rerank.rs:89-109), so this is a plain #[test], not #[tokio::test] —
    // matching the existing rerank_blocking_times_out_to_none test's shape.
    let rt = tokio::runtime::Runtime::new().unwrap();
    let gateway = rt.block_on(MockGateway::start_ordered(vec![Step::Stall]));
    let backend = HttpRerankBackend::new(gateway.base_url(), "m", None).expect("backend");
    let documents = vec!["a".to_string()];
    let started = std::time::Instant::now();
    let scores = rerank_blocking(&backend, "q", &documents, 50);
    assert!(
        scores.is_none(),
        "a genuinely stalled wire connection must degrade to None, not hang"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "must honor the 50ms bound over a real socket, took {:?}",
        started.elapsed()
    );
}

// ---------------------------------------------------------------------------
// Fail-closed when documents cannot be mapped exactly (duplicate index —
// already covered in rerank.rs; this proves the same contract survives a
// fragmented, real multi-chunk HTTP response, not just a buffered wiremock body)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn duplicate_index_fails_closed_even_when_the_body_arrives_fragmented() {
    let payload = serde_json::to_vec(&json!({
        "results": [
            {"index": 0, "relevance_score": 0.5},
            {"index": 0, "relevance_score": 0.9}
        ]
    }))
    .unwrap();
    let frames = cd_test_gateway::split_evenly(&payload, 5);
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::FixedFragments(frames))
            .with_header("content-type", "application/json"),
    )])
    .await;
    let err = backend(&gateway).rerank("q", &docs(2)).await.unwrap_err();
    assert!(err.to_string().contains("duplicate index"), "{err}");
}

// ---------------------------------------------------------------------------
// Dialect documentation: Vercel AI Gateway v4 (`/reranking-model`) is a
// genuinely different rerank dialect with a shared production
// `VercelV4RerankBackend`. Its specialty-envelope tests live beside that
// adapter in `cd-core/src/rerank.rs`; this integration file remains focused
// on the TEI/Cohere-style `/rerank` contract. Both adapters enforce complete
// request-relative score alignment and fail closed on malformed responses.
