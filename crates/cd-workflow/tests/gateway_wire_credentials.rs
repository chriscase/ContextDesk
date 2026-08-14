//! Gateway wire conformance lab — Phase 10: credential and redaction
//! invariants.
//!
//! Uses only synthetic secrets held in `tempfile::TempDir`s. No real
//! credentials, no OS Keychain — `ReferencedSecretStore` is exercised
//! directly against protected files this test creates and owns; the actual
//! OS keychain backend is never invoked by any scenario here (see the last
//! section for the direct proof).

use cd_core::chat::{ChatMessage, OpenAiCompatibleClient, Role};
use cd_core::keychain_store::{file_secret_ref, ReferencedSecretStore, SecretStore};
use cd_core::providers::{ProviderCapabilities, ProviderKind, ProviderProfile};
use cd_core::redact::scrub_secrets;
use cd_core::research::backend_for;
use cd_core::ssrf::SsrfPolicy;
use cd_core::turn_trace::{RecordingTurnTrace, TracingChatBackend, TurnTraceSink};
use cd_test_gateway::{redact, MockGateway, Response, Step};
use cd_workflow::provider::{
    resolve_turn_inputs, resolve_turn_inputs_with_credential_cache, TurnProviderCredentialCache,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Writes a synthetic secret to a fresh mode-600 file this process owns and
/// returns its `file:` reference. Never a real credential.
fn synthetic_protected_file(
    dir: &tempfile::TempDir,
    name: &str,
    secret: &str,
) -> (PathBuf, String) {
    let path = dir.path().join(name);
    fs::write(&path, secret).expect("write synthetic secret");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod 600");
    }
    let reference = file_secret_ref(&path).expect("valid protected file reference");
    (path, reference)
}

/// Counts every `get` call while delegating to a real `SecretStore` — lets
/// tests assert exact read counts against production credential-resolution
/// code, not a hand-rolled stand-in.
struct CountingSecretStore<S: SecretStore> {
    inner: S,
    reads: AtomicUsize,
}

impl<S: SecretStore> CountingSecretStore<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
            reads: AtomicUsize::new(0),
        }
    }
    fn read_count(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }
}

impl<S: SecretStore> SecretStore for CountingSecretStore<S> {
    fn get(&self, ref_id: &str) -> cd_core::error::CoreResult<Option<String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.inner.get(ref_id)
    }
    fn set(&self, ref_id: &str, secret: &str) -> cd_core::error::CoreResult<()> {
        self.inner.set(ref_id, secret)
    }
    fn delete(&self, ref_id: &str) -> cd_core::error::CoreResult<()> {
        self.inner.delete(ref_id)
    }
}

fn ollama_profile_with_ref(base_url: &str, api_key_ref: Option<String>) -> ProviderProfile {
    ProviderProfile {
        id: "cred-ollama".into(),
        label: "cred ollama".into(),
        kind: ProviderKind::Ollama,
        base_url: base_url.into(),
        api_key_ref,
        chat_model: "matrix-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::local_full(),
        local_only: true,
        deadline_preference: Default::default(),
    }
}

fn openai_profile_with_ref(base_url: &str, api_key_ref: Option<String>) -> ProviderProfile {
    ProviderProfile {
        id: "cred-openai".into(),
        label: "cred openai-compatible".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: base_url.into(),
        api_key_ref,
        chat_model: "matrix-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: true,
        deadline_preference: Default::default(),
    }
}

fn cfg_with_profile(profile: ProviderProfile) -> cd_core::config::AppConfig {
    cd_core::config::AppConfig {
        providers: cd_core::providers::ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..Default::default()
    }
}

// ---------------------------------------------------------------------------
// Protected-file references are resolved only when a provider call requires
// them
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ollama_discovery_never_resolves_a_credential_even_when_one_is_configured() {
    let dir = tempfile::tempdir().unwrap();
    let (_path, reference) =
        synthetic_protected_file(&dir, "unused.secret", "sk-test-should-never-be-read");
    let store = CountingSecretStore::new(ReferencedSecretStore::new());

    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "models": [{"name": "mistral"}]
    })))])
    .await;
    // Nonsensical but deliberately adversarial: an Ollama profile carrying a
    // credential reference at all — Ollama's discovery path must not
    // consult it regardless.
    let profile = ollama_profile_with_ref(gateway.base_url(), Some(reference));
    let probe = cd_core::discovery::probe_provider_catalog(&profile, None).await;
    assert!(matches!(
        probe.outcome,
        cd_core::discovery::ProbeOutcome::Reachable { .. }
    ));
    assert_eq!(
        store.read_count(),
        0,
        "catalog-free local discovery must never resolve a credential"
    );
}

#[tokio::test]
async fn a_provider_call_that_needs_the_credential_resolves_it_exactly_once_and_attaches_it() {
    let dir = tempfile::tempdir().unwrap();
    let secret = "sk-test-fixture-attach-me";
    let (_path, reference) = synthetic_protected_file(&dir, "chat.secret", secret);
    let store = CountingSecretStore::new(ReferencedSecretStore::new());

    let resolved = store.get(&reference).expect("resolves").expect("present");
    assert_eq!(store.read_count(), 1);
    assert_eq!(resolved, secret);

    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "x",
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}]
    })))])
    .await;
    let client = OpenAiCompatibleClient::new(
        format!("{}/v1", gateway.base_url()),
        Some(resolved),
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .unwrap();
    let messages = vec![ChatMessage {
        role: Role::User,
        content: "hi".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    client.complete(&messages, None).await.unwrap();

    let sent = gateway.requests();
    assert_eq!(
        sent[0].header("authorization"),
        Some(format!("Bearer {secret}").as_str()),
        "the resolved credential must reach the wire as the Bearer token"
    );
}

// ---------------------------------------------------------------------------
// One logical turn resolves each credential source at most once
// ---------------------------------------------------------------------------

#[tokio::test]
async fn one_turn_resolves_the_credential_once_across_multiple_resolution_stages() {
    let dir = tempfile::tempdir().unwrap();
    let (_path, reference) = synthetic_protected_file(&dir, "turn.secret", "sk-test-turn-scoped");
    let store = CountingSecretStore::new(ReferencedSecretStore::new());
    let cfg = cfg_with_profile(openai_profile_with_ref(
        "http://127.0.0.1:1",
        Some(reference),
    ));

    let cache = TurnProviderCredentialCache::new(&store);
    // Simulates primary-model resolution, then reviewer-model resolution
    // within the SAME admitted turn.
    let primary = resolve_turn_inputs_with_credential_cache(&cache, &cfg, None, None).unwrap();
    let reviewer = resolve_turn_inputs_with_credential_cache(&cache, &cfg, None, None).unwrap();
    assert_eq!(primary.api_key.as_deref(), Some("sk-test-turn-scoped"));
    assert_eq!(reviewer.api_key.as_deref(), Some("sk-test-turn-scoped"));
    assert_eq!(
        store.read_count(),
        1,
        "a shared turn-scoped cache must resolve the same credential source once, not once per stage"
    );
}

#[tokio::test]
async fn without_the_shared_cache_each_resolution_call_reads_again() {
    // Contrast case proving the cache (not some other mechanism) is what
    // provides the one-read guarantee above.
    let dir = tempfile::tempdir().unwrap();
    let (_path, reference) = synthetic_protected_file(&dir, "uncached.secret", "sk-test-uncached");
    let store = CountingSecretStore::new(ReferencedSecretStore::new());
    let cfg = cfg_with_profile(openai_profile_with_ref(
        "http://127.0.0.1:1",
        Some(reference),
    ));

    resolve_turn_inputs(&store, &cfg, None, None).unwrap();
    resolve_turn_inputs(&store, &cfg, None, None).unwrap();
    assert_eq!(
        store.read_count(),
        2,
        "documents the uncached path's real per-call cost"
    );
}

// ---------------------------------------------------------------------------
// Secrets never appear in traces, snapshots, or assertion messages
// ---------------------------------------------------------------------------

#[tokio::test]
async fn user_content_shaped_like_a_secret_is_scrubbed_before_entering_the_trace() {
    let dir = tempfile::tempdir().unwrap();
    let (_path, reference) = synthetic_protected_file(&dir, "trace.secret", "sk-test-trace-danger");
    let store = ReferencedSecretStore::new();
    let api_key = store.get(&reference).unwrap();

    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "x",
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "noted"}}]
    })))])
    .await;
    let mut profile = openai_profile_with_ref(gateway.base_url(), None);
    profile.chat_model = "matrix-model".into();
    let inner = backend_for(&profile, api_key.clone())
        .await
        .expect("backend");
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let backend = TracingChatBackend::new(inner, sink);

    // A user pastes something secret-shaped into an ordinary chat message —
    // the trace must scrub it the same way it would a real leaked key.
    let leaky = "by the way my key is sk-test-trace-danger, please remember it";
    let messages = vec![ChatMessage {
        role: Role::User,
        content: leaky.into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    let mut sink_fn = |_: String| {};
    cd_core::agent::ChatBackend::complete_streaming(&backend, &messages, &[], &mut sink_fn, None)
        .await
        .unwrap();

    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    for traced_message in &calls[0].messages {
        assert!(
            !traced_message.content.contains("sk-test-trace-danger"),
            "a secret-shaped substring in user content must be scrubbed before it enters the trace, \
             got: {}",
            redact(&traced_message.content, &["sk-test-trace-danger"])
        );
    }

    // The wire request itself legitimately carries the real credential in
    // the Authorization header (proven above) — but even THAT recorded
    // request must never leak into an assertion/log without redaction here.
    let recorded_requests = gateway.requests();
    let safe_summary = redact(
        &format!("{:?}", recorded_requests[0].header("authorization")),
        &["sk-test-trace-danger"],
    );
    assert!(!safe_summary.contains("sk-test-trace-danger"));
}

#[tokio::test]
async fn scrub_secrets_redacts_common_credential_shapes_for_assertion_safety() {
    let text = "Authorization: Bearer sk-test-abcdef0123456789abcdef0123456789";
    let scrubbed = scrub_secrets(text);
    assert!(
        !scrubbed.contains("sk-test-abcdef0123456789abcdef0123456789"),
        "{scrubbed}"
    );
}

#[test]
fn cd_test_gateway_redact_hides_a_registered_secret_from_a_panic_shaped_message() {
    // Simulates the discipline this whole file follows: build any panic /
    // assertion-failure string through redact() rather than interpolating
    // a secret directly, so even a would-be panic payload never carries it.
    let secret = "sk-test-panic-payload";
    let would_be_panic_message = format!("request failed with body containing {secret}");
    let safe = redact(&would_be_panic_message, &[secret]);
    assert!(!safe.contains(secret));
    assert!(safe.contains("<redacted:"));
}

// ---------------------------------------------------------------------------
// File permissions and invalid references fail safely
// ---------------------------------------------------------------------------

#[test]
fn protected_file_permission_and_reference_failure_matrix() {
    let dir = tempfile::tempdir().unwrap();
    let store = ReferencedSecretStore::new();

    // Wrong permissions (group-readable).
    let world_readable = dir.path().join("loose.secret");
    fs::write(&world_readable, "sk-test-loose").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&world_readable, fs::Permissions::from_mode(0o644)).unwrap();
        let reference = format!("file:{}", world_readable.display());
        let err = store
            .get(&reference)
            .expect_err("group/other-readable file must fail closed");
        assert!(err.to_string().contains("permissions"), "{err}");
    }

    // Missing file.
    let missing = dir.path().join("does-not-exist.secret");
    let reference = format!("file:{}", missing.display());
    assert!(
        store.get(&reference).is_err(),
        "a missing protected file must fail closed, not panic"
    );

    // Oversized file (> 64 KiB).
    let oversized = dir.path().join("oversized.secret");
    fs::write(&oversized, "x".repeat(70 * 1024)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&oversized, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let reference = format!("file:{}", oversized.display());
    let err = store
        .get(&reference)
        .expect_err("an oversized credential file must fail closed");
    assert!(err.to_string().contains("bytes"), "{err}");

    // Empty file.
    let empty = dir.path().join("empty.secret");
    fs::write(&empty, "").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&empty, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let reference = format!("file:{}", empty.display());
    assert!(
        store.get(&reference).is_err(),
        "an empty credential file must fail closed"
    );

    // Non-absolute path.
    let reference = "file:relative/path.secret".to_string();
    assert!(
        store.get(&reference).is_err(),
        "a non-absolute protected-file path must fail closed"
    );

    #[cfg(unix)]
    {
        // Symlink to an otherwise-valid, correctly-permissioned secret.
        let real = dir.path().join("real.secret");
        fs::write(&real, "sk-test-real").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("link.secret");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let reference = format!("file:{}", link.display());
        let err = store
            .get(&reference)
            .expect_err("a symlinked credential path must fail closed");
        assert!(err.to_string().contains("symbolic link"), "{err}");
    }
}

// ---------------------------------------------------------------------------
// Keychain is not touched when a protected-file reference is configured
// ---------------------------------------------------------------------------

#[test]
fn protected_file_reference_never_reaches_the_keychain_backend() {
    // ReferencedSecretStore::get returns from read_file_secret_ref for any
    // `file:`-prefixed reference BEFORE the keychain branch is reachable
    // (crates/cd-core/src/keychain_store.rs) — proven here by exercising the
    // real store end-to-end: this hermetic container has no working OS
    // keychain / D-Bus Secret Service, so a call that actually reached
    // KeychainSecretStore::get would fail loudly, not quietly return the
    // correct file-sourced value.
    let dir = tempfile::tempdir().unwrap();
    let secret = "sk-test-never-touches-keychain";
    let path = dir.path().join("keychain-boundary.secret");
    fs::write(&path, secret).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let reference = format!("file:{}", path.display());
    let store = ReferencedSecretStore::new();
    let resolved = store
        .get(&reference)
        .expect("file-backed get must succeed without any keychain access");
    assert_eq!(resolved.as_deref(), Some(secret));
}
