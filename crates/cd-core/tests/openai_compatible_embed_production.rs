//! Production OpenAI-compatible embeddings — hermetic wire lab.
//!
//! Drives [`cd_core::embed::OpenAiCompatibleEmbedBackend`] (the EmbedBackend
//! real hybrid retrieval uses for remote employer gateways) against
//! `cd_test_gateway::MockGateway`. No live network, no Keychain.

use cd_core::embed::{
    parse_openai_embeddings_response, validate_embedding_batch, EmbedBackend,
    OpenAiCompatibleEmbedBackend, EMBED_MAX_BATCH,
};
use cd_core::keychain_store::{file_secret_ref, ReferencedSecretStore, SecretStore};
use cd_test_gateway::{MockGateway, Response, Step};
use serde_json::json;

fn bge_m3_vector(seed: f32) -> Vec<f32> {
    // 1024-d BGE-M3-shaped dense vector (finite, non-zero).
    (0..1024)
        .map(|i| ((i as f32 * 0.001) + seed).sin() * 0.01)
        .collect()
}

fn openai_embed_backend(
    gateway: &MockGateway,
    model: &str,
    bearer: Option<String>,
) -> OpenAiCompatibleEmbedBackend {
    OpenAiCompatibleEmbedBackend::new(&format!("{}/v1", gateway.base_url()), model, bearer)
        .expect("backend")
}

#[tokio::test]
async fn batch_embeddings_preserve_order_with_permuted_indexes() {
    let v0 = bge_m3_vector(0.1);
    let v1 = bge_m3_vector(0.2);
    let v2 = bge_m3_vector(0.3);
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "model": "bge-m3",
        "data": [
            {"index": 2, "embedding": v2},
            {"index": 0, "embedding": v0},
            {"index": 1, "embedding": v1},
        ]
    })))])
    .await;
    let backend = openai_embed_backend(&gateway, "bge-m3", None);
    let texts = vec!["a".into(), "b".into(), "c".into()];
    let vectors = backend.embed(&texts).await.expect("vectors");
    assert_eq!(vectors.len(), 3);
    assert_eq!(vectors[0].len(), 1024, "BGE-M3-shaped 1024-d");
    assert_eq!(vectors[0][0], v0[0]);
    assert_eq!(vectors[1][0], v1[0]);
    assert_eq!(vectors[2][0], v2[0]);
    validate_embedding_batch(&vectors, 3).unwrap();

    let sent = gateway.requests();
    assert_eq!(sent.len(), 1, "one batched request");
    assert!(
        sent[0].path.ends_with("/embeddings"),
        "path={}",
        sent[0].path
    );
    let body = sent[0].json_body().unwrap();
    assert_eq!(body["model"], "bge-m3");
    assert_eq!(body["input"].as_array().unwrap().len(), 3);
    assert_eq!(backend.identity(), "bge-m3");
    let space = backend.space();
    assert_eq!(space.model, "bge-m3");
    assert_eq!(space.dialect, "openai_embeddings");
    assert_eq!(
        space.endpoint_fingerprint,
        cd_core::capability_qualification::fingerprint_endpoint(backend.endpoint_url())
    );
}

#[tokio::test]
async fn protected_file_credential_reaches_authorization_never_identity_or_debug() {
    let secret = "sk-embed-production-synthetic-ONLY";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("embed.secret");
    std::fs::write(&path, secret).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let reference = file_secret_ref(&path).unwrap();
    let store = ReferencedSecretStore::new();
    let bearer = store.get(&reference).unwrap().expect("secret");

    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "model": "bge-m3",
        "data": [{"index": 0, "embedding": bge_m3_vector(0.0)}]
    })))])
    .await;
    let backend = openai_embed_backend(&gateway, "bge-m3", Some(bearer));
    let _ = backend.embed(&["probe".into()]).await.unwrap();
    let requests = gateway.requests();
    let auth = requests[0]
        .header("authorization")
        .expect("Authorization header");
    assert!(auth.contains(secret), "credential must reach the wire");
    assert_eq!(backend.identity(), "bge-m3");
    assert!(!backend.identity().contains(secret));
    let dbg = format!("{backend:?}");
    assert!(!dbg.contains(secret));
    assert!(dbg.contains("<redacted>"));
}

#[tokio::test]
async fn model_identity_mismatch_on_wire_fails_closed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "model": "different-model",
        "data": [{"index": 0, "embedding": [0.1, 0.2]}]
    })))])
    .await;
    let backend = openai_embed_backend(&gateway, "bge-m3", None);
    let err = backend.embed(&["x".into()]).await.unwrap_err();
    assert!(err.to_string().contains("model identity mismatch"), "{err}");
}

#[tokio::test]
async fn malformed_batch_fails_closed_no_silent_empty_vectors() {
    // Heterogeneous dimensions
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "data": [
            {"index": 0, "embedding": [0.1, 0.2]},
            {"index": 1, "embedding": [0.3]},
        ]
    })))])
    .await;
    let backend = openai_embed_backend(&gateway, "m", None);
    assert!(backend.embed(&["a".into(), "b".into()]).await.is_err());

    // Duplicate index
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "data": [
            {"index": 0, "embedding": [0.1]},
            {"index": 0, "embedding": [0.2]},
        ]
    })))])
    .await;
    let backend = openai_embed_backend(&gateway, "m", None);
    assert!(backend.embed(&["a".into(), "b".into()]).await.is_err());

    // Missing row
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "data": [{"index": 0, "embedding": [0.1]}]
    })))])
    .await;
    let backend = openai_embed_backend(&gateway, "m", None);
    assert!(backend.embed(&["a".into(), "b".into()]).await.is_err());
}

#[tokio::test]
async fn empty_batch_and_oversize_batch_bounds() {
    // Gateway must never be contacted for empty or oversize batches.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "data": [{"embedding": [0.0]}]
    })))])
    .await;
    let backend = openai_embed_backend(&gateway, "m", None);
    assert_eq!(backend.embed(&[]).await.unwrap(), Vec::<Vec<f32>>::new());
    assert_eq!(gateway.request_count(), 0);

    let too_many: Vec<String> = (0..=EMBED_MAX_BATCH).map(|i| format!("t{i}")).collect();
    let err = backend.embed(&too_many).await.unwrap_err();
    assert!(err.to_string().contains("batch bound"), "{err}");
    assert_eq!(gateway.request_count(), 0);
}

#[tokio::test]
async fn http_error_fails_closed_without_echoing_body() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json(
        401,
        &json!({"error": {"message": "invalid_api_key sk-must-not-leak"}}),
    ))])
    .await;
    let backend = openai_embed_backend(&gateway, "m", Some("sk-must-not-leak".into()));
    let err = backend.embed(&["x".into()]).await.unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("401"), "{msg}");
    assert!(
        !msg.contains("sk-must-not-leak"),
        "must not echo body: {msg}"
    );
}

#[test]
fn parse_helpers_match_backend_contract() {
    let body = json!({
        "data": [
            {"index": 1, "embedding": [0.0, 1.0]},
            {"index": 0, "embedding": [1.0, 0.0]},
        ]
    });
    let v = parse_openai_embeddings_response(&body, 2).unwrap();
    assert_eq!(v, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
}
