//! Gateway wire conformance lab — Phase 3: catalog discovery matrix.
//!
//! Drives the real HTTP boundary: `OpenAiCompatibleClient::list_models`,
//! `AnthropicClient::list_models`, `OllamaClient::list_tags`, and the
//! higher-level `discovery::probe_provider_catalog` / `ai_probe::probe_ai_gateway`
//! entrypoints CLI/desktop actually call — against a hermetic
//! `cd_test_gateway::MockGateway`, never a real network or the fixture-JSON
//! parser lane in `crates/cd-core/tests/gateway_contract_fixtures.rs`.
//!
//! # The `ai_probe` loopback special case
//!
//! `ai_probe::probe_ai_gateway` (and therefore `discovery::probe_provider_catalog`
//! for `OpenAiCompatible`/`Anthropic` kinds) treats any base URL whose string
//! contains `"127.0.0.1"` or `"localhost"` as "the user meant local Ollama" and
//! unconditionally probes the hardcoded real `127.0.0.1:11434` instead of the
//! caller's base — see `crates/cd-core/src/ai_probe.rs:274-277`. A
//! `MockGateway` binds to `127.0.0.1`, so used verbatim it would be silently
//! shadowed by that special case rather than actually exercised.
//!
//! Rather than fight that (real, intentional-for-production) heuristic, tests
//! that need to reach `ai_probe`'s remote-gateway candidate-expansion logic
//! address the same mock server with the host written as `127.1` instead of
//! `127.0.0.1` — still exactly loopback (`127.1` is `127.0.0.1` under the
//! IPv4 "implied octets" form the WHATWG URL spec and `reqwest`/`url` both
//! implement), so this stays fully hermetic; it just doesn't contain the
//! literal substring `ai_probe.rs` special-cases on. See `loopback_alias`.

use cd_core::chat::{AnthropicClient, OllamaClient, OpenAiCompatibleClient};
use cd_core::discovery::{classify_probe_http_status, probe_provider_catalog, ProbeOutcome};
use cd_core::providers::{ProviderCapabilities, ProviderKind, ProviderProfile};
use cd_core::ssrf::SsrfPolicy;
use cd_test_gateway::{MockGateway, Response, Step};
use serde_json::json;
use std::time::Duration;

/// Same loopback address, spelled so `ai_probe.rs`'s `contains("127.0.0.1")`
/// heuristic doesn't fire. See module doc.
fn loopback_alias(gateway: &MockGateway) -> String {
    gateway.base_url().replacen("127.0.0.1", "127.1", 1)
}

fn openai_client(base_url: &str) -> OpenAiCompatibleClient {
    OpenAiCompatibleClient::new(base_url, None, "matrix-model", &SsrfPolicy::default())
        .expect("client construction")
}

fn openai_client_v1(gateway: &MockGateway) -> OpenAiCompatibleClient {
    // Forces list_models() to try exactly one URL (base already ends in
    // /v1) instead of fanning out to both /v1/models and /models, so each
    // scenario below can script a single deterministic connection.
    openai_client(&format!("{}/v1", gateway.base_url()))
}

fn anthropic_client(gateway: &MockGateway) -> AnthropicClient {
    AnthropicClient::new(
        gateway.base_url(),
        Some("sk-ant-fixture".into()),
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client construction")
}

fn ollama_client(gateway: &MockGateway) -> OllamaClient {
    OllamaClient::new(gateway.base_url(), "matrix-model").expect("client construction")
}

/// Routes only a `/models`-suffixed path to `catalog`; everything else
/// (notably `/api/tags`, which `ai_probe::probe_ai_gateway` always tries
/// FIRST for every candidate root) gets a 404. `MockGateway::start_ordered`
/// has no path awareness — it would answer an `/api/tags` probe with this
/// same catalog body, which `ai_probe` would misread as "found a local
/// Ollama with zero models" and stop before ever trying the Bearer/x-api-key
/// `/models` path this test actually means to exercise. `start_routed` with
/// this responder is what makes these tests reach the intended dialect.
fn openai_compatible_only_catalog(
    catalog: serde_json::Value,
) -> impl Fn(&cd_test_gateway::RecordedRequest) -> Step {
    move |req| {
        if req.path.ends_with("/models") {
            Step::respond(Response::json_ok(&catalog))
        } else {
            Step::respond(Response::status_only(404))
        }
    }
}

fn openai_profile(base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "discovery-openai".into(),
        label: "discovery openai-compatible".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: base_url.into(),
        api_key_ref: None,
        chat_model: "matrix-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: false,
        deadline_preference: Default::default(),
    }
}

fn ollama_profile(base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "discovery-ollama".into(),
        label: "discovery ollama".into(),
        kind: ProviderKind::Ollama,
        base_url: base_url.into(),
        api_key_ref: None,
        chat_model: "matrix-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::local_full(),
        local_only: true,
        deadline_preference: Default::default(),
    }
}

// ---------------------------------------------------------------------------
// Normal catalog, missing optional metadata, exact ID preservation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn normal_openai_style_catalog_lists_every_id_in_order() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "object": "list",
        "data": [
            {"id": "gpt-4o-mini", "object": "model", "owned_by": "openai"},
            {"id": "gpt-4o", "object": "model", "owned_by": "openai"},
        ]
    })))])
    .await;
    let ids = openai_client_v1(&gateway)
        .list_models()
        .await
        .expect("catalog lists");
    assert_eq!(ids, vec!["gpt-4o-mini", "gpt-4o"]);
    assert_eq!(gateway.request_count(), 1);
    assert_eq!(gateway.requests()[0].method, "GET");
}

#[tokio::test]
async fn missing_optional_metadata_still_yields_the_id() {
    // No `object`, `owned_by`, `created`, or `permission` fields — only `id`.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "data": [{"id": "bare-model-id"}]
    })))])
    .await;
    let ids = openai_client_v1(&gateway).list_models().await.expect("ok");
    assert_eq!(ids, vec!["bare-model-id"]);
}

#[tokio::test]
async fn exact_model_id_is_preserved_byte_for_byte() {
    let weird_id = "Corp_Gateway.v2-Preview[beta]";
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "data": [{"id": weird_id}]
    })))])
    .await;
    let ids = openai_client_v1(&gateway).list_models().await.expect("ok");
    assert_eq!(
        ids,
        vec![weird_id.to_string()],
        "no trim/case/normalization"
    );
}

// ---------------------------------------------------------------------------
// Pagination/truncation signals: none are followed (documents the gap)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pagination_signals_are_present_but_never_followed() {
    // A `has_more`/`next_page` shaped response — production has no cursor
    // logic anywhere in the discovery wire path, so only the first page's
    // rows are ever returned and no second request is ever issued.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "object": "list",
        "has_more": true,
        "next_page": "page-2-cursor",
        "data": [{"id": "page-1-model"}]
    })))])
    .await;
    let ids = openai_client_v1(&gateway).list_models().await.expect("ok");
    assert_eq!(
        ids,
        vec!["page-1-model"],
        "pagination is not followed; only the first page's rows are visible"
    );
    assert_eq!(
        gateway.request_count(),
        1,
        "no second request for the next page — documents the gap, does not invent support"
    );
}

// ---------------------------------------------------------------------------
// Duplicate IDs, empty catalog, malformed catalog, unexpected envelope
// ---------------------------------------------------------------------------

#[tokio::test]
async fn duplicate_model_ids_are_deduplicated_keeping_first_occurrence() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "data": [
            {"id": "dup-model", "owned_by": "first"},
            {"id": "other-model"},
            {"id": "dup-model", "owned_by": "second"},
        ]
    })))])
    .await;
    let ids = openai_client_v1(&gateway).list_models().await.expect("ok");
    assert_eq!(ids, vec!["dup-model", "other-model"]);
}

#[tokio::test]
async fn empty_catalog_is_a_client_error_not_a_silent_empty_success() {
    // list_models() only tracks an error from a non-success status or a
    // parse failure; an HTTP-200 response that parses to zero models never
    // updates `last_err`, so the call fails with the constructor's initial
    // placeholder message rather than a status- or parse-specific one. This
    // test pins that exact (slightly misleading, but real) behavior rather
    // than inventing a nicer contract.
    let gateway =
        MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({"data": []})))])
            .await;
    let err = openai_client_v1(&gateway)
        .list_models()
        .await
        .expect_err("an empty catalog is surfaced as an error, not Ok(vec![])");
    assert!(
        err.to_string().contains("no URL attempted"),
        "documents the current (misleading) message for this path: {err}"
    );
}

#[tokio::test]
async fn malformed_catalog_json_fails_closed_with_a_parse_error() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::text(
        200,
        "application/json",
        "{not valid json at all",
    ))])
    .await;
    let err = openai_client_v1(&gateway)
        .list_models()
        .await
        .expect_err("malformed JSON must not be treated as an empty-but-ok catalog");
    assert!(err.to_string().contains("models json"), "got {err}");
}

#[tokio::test]
async fn unexpected_envelope_shape_yields_zero_models_not_an_error() {
    // No `data`, `models`, or top-level array — an object with unrelated
    // keys. This is valid JSON, so it is NOT a parse failure; it silently
    // yields zero ids, then falls into the same "empty catalog" error path
    // as the explicit-empty-array case above.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "status": "ok",
        "unrelated": true
    })))])
    .await;
    let err = openai_client_v1(&gateway)
        .list_models()
        .await
        .expect_err("an envelope with no recognizable model array yields no models");
    assert!(err.to_string().contains("no URL attempted"));
}

#[tokio::test]
async fn wrong_content_type_with_valid_json_body_still_parses() {
    // list_models() never inspects Content-Type — only whether the body
    // text parses as the expected JSON shape.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::text(
        200,
        "text/html",
        serde_json::to_string(&json!({"data": [{"id": "served-as-html"}]})).unwrap(),
    ))])
    .await;
    let ids = openai_client_v1(&gateway).list_models().await.expect("ok");
    assert_eq!(ids, vec!["served-as-html"]);
}

#[tokio::test]
async fn wrong_content_type_with_non_json_body_fails_closed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::text(
        200,
        "text/plain",
        "Model catalog temporarily unavailable, please retry.",
    ))])
    .await;
    let err = openai_client_v1(&gateway)
        .list_models()
        .await
        .expect_err("plain-text body is not a valid catalog");
    assert!(err.to_string().contains("models json"));
}

// ---------------------------------------------------------------------------
// HTTP status matrix: 401/403/404/405/429(+-Retry-After)/500/502/503/504
// ---------------------------------------------------------------------------

#[tokio::test]
async fn status_matrix_all_fail_closed_with_no_retry() {
    for status in [401u16, 403, 404, 405, 429, 500, 502, 503, 504] {
        let gateway =
            MockGateway::start_ordered(vec![Step::respond(Response::status_only(status))]).await;
        let err = openai_client_v1(&gateway)
            .list_models()
            .await
            .expect_err(&format!("HTTP {status} must fail the catalog call"));
        assert!(
            err.to_string().contains(&status.to_string()),
            "status {status} not named in error: {err}"
        );
        assert_eq!(
            gateway.request_count(),
            1,
            "list_models() has no retry loop of its own for HTTP {status} — a single attempt is the documented contract"
        );
    }
}

#[tokio::test]
async fn rate_limit_with_retry_after_is_not_honored_by_catalog_listing() {
    // Unlike chat completions (post_completion_with_429_retry), list_models()
    // has no 429/Retry-After handling at all — this pins that gap rather
    // than inventing retry support that doesn't exist.
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::status_only(429).with_header("retry-after", "0"),
    )])
    .await;
    let err = openai_client_v1(&gateway).list_models().await.unwrap_err();
    assert!(err.to_string().contains("429"));
    assert_eq!(
        gateway.request_count(),
        1,
        "Retry-After is present but list_models() never retries a 429"
    );
}

#[tokio::test]
async fn rate_limit_without_retry_after_behaves_identically() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(429))]).await;
    let err = openai_client_v1(&gateway).list_models().await.unwrap_err();
    assert!(err.to_string().contains("429"));
    assert_eq!(gateway.request_count(), 1);
}

#[tokio::test]
async fn classify_probe_http_status_matrix_matches_the_pure_classifier() {
    // discovery::classify_probe_http_status is the shared pure classifier
    // Ollama/Grok wire paths route status codes through; pin it against the
    // exact status matrix the task specifies (already partly covered
    // in-crate — extended here for the exact set this lab requires).
    for status in [200u16, 201, 204] {
        assert!(matches!(
            classify_probe_http_status(status),
            ProbeOutcome::Reachable { .. }
        ));
    }
    for status in [401u16, 403] {
        assert!(matches!(
            classify_probe_http_status(status),
            ProbeOutcome::KeyRejected { .. }
        ));
    }
    for status in [404u16, 405, 429, 500, 502, 503, 504] {
        assert!(
            matches!(
                classify_probe_http_status(status),
                ProbeOutcome::Unreachable { .. }
            ),
            "status {status} should classify Unreachable"
        );
    }
}

// ---------------------------------------------------------------------------
// Slow headers and cancellation-shaped deadlines
// ---------------------------------------------------------------------------

#[tokio::test]
async fn slow_headers_within_the_client_timeout_still_succeed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::json_ok(&json!({"data": [{"id": "slow-but-fine"}]}))
            .with_header_delay(Duration::from_millis(30)),
    )])
    .await;
    let ids = openai_client_v1(&gateway).list_models().await.expect("ok");
    assert_eq!(ids, vec!["slow-but-fine"]);
}

#[tokio::test(start_paused = true)]
async fn stalled_catalog_call_times_out_at_the_pinned_client_bound_not_hanging_forever() {
    // list_models() takes no cancellation token; the only bound is the
    // client's own fixed 120s timeout (OpenAiCompatibleClient::new). A
    // paused clock lets this fire deterministically without a real 120s wait.
    let gateway = MockGateway::start_ordered(vec![Step::Stall]).await;
    let client = openai_client_v1(&gateway);
    let call = tokio::spawn(async move { client.list_models().await });
    tokio::time::advance(Duration::from_secs(121)).await;
    let outcome = call.await.expect("join");
    assert!(
        outcome.is_err(),
        "a stalled catalog connection must eventually fail, not hang forever"
    );
}

// ---------------------------------------------------------------------------
// Catalog changes between calls
// ---------------------------------------------------------------------------

#[tokio::test]
async fn catalog_changes_between_calls_are_reflected_with_no_stale_cache() {
    let gateway = MockGateway::start_ordered(vec![
        Step::respond(Response::json_ok(&json!({"data": [{"id": "v1-model"}]}))),
        Step::respond(Response::json_ok(&json!({
            "data": [{"id": "v1-model"}, {"id": "v2-model"}]
        }))),
    ])
    .await;
    let client = openai_client_v1(&gateway);
    let first = client.list_models().await.expect("first call");
    assert_eq!(first, vec!["v1-model"]);
    let second = client.list_models().await.expect("second call");
    assert_eq!(
        second,
        vec!["v1-model", "v2-model"],
        "no client-side caching hides the newly added model"
    );
    assert_eq!(
        gateway.request_count(),
        2,
        "discovery makes a fresh call every time"
    );
}

// ---------------------------------------------------------------------------
// Anthropic and Ollama dialects (direct client, single-request contract)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn anthropic_catalog_uses_x_api_key_not_bearer() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "data": [{"id": "claude-matrix-1"}]
    })))])
    .await;
    let ids = anthropic_client(&gateway).list_models().await.expect("ok");
    assert_eq!(ids, vec!["claude-matrix-1"]);
    let sent = gateway.requests();
    assert_eq!(sent[0].header("x-api-key"), Some("sk-ant-fixture"));
    assert!(
        sent[0].header("authorization").is_none(),
        "Anthropic must not also send a Bearer Authorization header"
    );
    assert_eq!(sent[0].header("anthropic-version"), Some("2023-06-01"));
}

#[tokio::test]
async fn anthropic_status_matrix_fails_closed() {
    for status in [401u16, 403, 429, 500, 503] {
        let gateway =
            MockGateway::start_ordered(vec![Step::respond(Response::status_only(status))]).await;
        let err = anthropic_client(&gateway).list_models().await.unwrap_err();
        assert!(err.to_string().contains(&status.to_string()));
    }
}

#[tokio::test]
async fn ollama_tags_lists_local_models_by_name() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "models": [
            {"name": "mistral:latest", "size": 4109865159_u64},
            {"name": "llama3:8b"},
        ]
    })))])
    .await;
    let names = ollama_client(&gateway).list_tags().await.expect("ok");
    assert_eq!(names, vec!["mistral:latest", "llama3:8b"]);
    let sent = gateway.requests();
    assert_eq!(sent[0].path, "/api/tags");
    assert_eq!(sent[0].method, "GET");
}

#[tokio::test]
async fn ollama_missing_models_key_yields_empty_not_an_error() {
    // Unlike the OpenAI-compatible client, OllamaClient::list_tags() treats
    // "no `models` array" as Ok(vec![]), not an error — a real, documented
    // asymmetry between the two dialects.
    let gateway =
        MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({})))]).await;
    let names = ollama_client(&gateway)
        .list_tags()
        .await
        .expect("ok, not err");
    assert!(names.is_empty());
}

#[tokio::test]
async fn ollama_status_matrix_fails_closed() {
    for status in [404u16, 500, 503] {
        let gateway =
            MockGateway::start_ordered(vec![Step::respond(Response::status_only(status))]).await;
        let err = ollama_client(&gateway).list_tags().await.unwrap_err();
        assert!(err.to_string().to_lowercase().contains("tags"));
    }
}

// ---------------------------------------------------------------------------
// discovery::probe_provider_catalog — the actual entrypoint CLI/desktop use
// ---------------------------------------------------------------------------

#[tokio::test]
async fn probe_provider_catalog_ollama_reachable_reports_model_ids() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "models": [{"name": "mistral"}, {"name": "mistral"}]
    })))])
    .await;
    let profile = ollama_profile(gateway.base_url());
    let probe = probe_provider_catalog(&profile, None).await;
    assert!(matches!(probe.outcome, ProbeOutcome::Reachable { .. }));
    assert_eq!(probe.model_ids, vec!["mistral"], "de-duplicated");
    assert_eq!(probe.effective_base_url, gateway.base_url());
}

#[tokio::test]
async fn probe_provider_catalog_ollama_unreachable_when_connection_refused() {
    // A profile pointed at a port nothing listens on.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    let profile = ollama_profile(&format!("http://127.0.0.1:{port}"));
    let probe = probe_provider_catalog(&profile, None).await;
    assert!(matches!(probe.outcome, ProbeOutcome::Unreachable { .. }));
    assert!(probe.model_ids.is_empty());
}

#[tokio::test]
async fn probe_provider_catalog_openai_compatible_via_ai_probe_reaches_the_mock() {
    let gateway = MockGateway::start_routed(openai_compatible_only_catalog(json!({
        "data": [{"id": "corp-gateway-model"}]
    })))
    .await;
    let profile = openai_profile(&loopback_alias(&gateway));
    let probe = probe_provider_catalog(&profile, Some("sk-corp-fixture".into())).await;
    assert!(
        matches!(probe.outcome, ProbeOutcome::Reachable { .. }),
        "got {:?}",
        probe.outcome
    );
    assert_eq!(probe.model_ids, vec!["corp-gateway-model"]);
    let sent = gateway.requests();
    assert!(
        sent.iter()
            .any(|r| r.header("authorization") == Some("Bearer sk-corp-fixture")),
        "the configured api key must be attached as a Bearer token on at least one candidate URL attempt"
    );
}

#[tokio::test]
async fn probe_provider_catalog_openai_compatible_401_is_key_rejected() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(401))]).await;
    let profile = openai_profile(&loopback_alias(&gateway));
    let probe = probe_provider_catalog(&profile, Some("sk-wrong".into())).await;
    assert!(
        matches!(probe.outcome, ProbeOutcome::KeyRejected { .. }),
        "got {:?}",
        probe.outcome
    );
    assert!(probe.model_ids.is_empty());
}

#[tokio::test]
async fn probe_provider_catalog_openai_compatible_429_is_unreachable_not_key_rejected() {
    // ai_probe's own classification: a 429 note contains neither "401" nor
    // "403", so discovery::probe_provider_catalog buckets it as Unreachable,
    // not KeyRejected — pinning that (slightly surprising) real behavior.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(429))]).await;
    let profile = openai_profile(&loopback_alias(&gateway));
    let probe = probe_provider_catalog(&profile, Some("sk-fixture".into())).await;
    assert!(
        matches!(probe.outcome, ProbeOutcome::Unreachable { .. }),
        "got {:?}",
        probe.outcome
    );
}

#[tokio::test]
async fn probe_provider_catalog_never_issues_more_than_the_documented_candidate_fanout() {
    // ai_probe expands up to 12 candidate base shapes but stops at the
    // first success. A mock that succeeds on the first root it can reach a
    // /models path for must therefore short-circuit (after its own
    // preliminary /api/tags miss), not fan out through every remaining
    // candidate shape.
    let gateway = MockGateway::start_routed(openai_compatible_only_catalog(json!({
        "data": [{"id": "first-shape-wins"}]
    })))
    .await;
    let profile = openai_profile(&loopback_alias(&gateway));
    let probe = probe_provider_catalog(&profile, Some("sk-fixture".into())).await;
    assert!(matches!(probe.outcome, ProbeOutcome::Reachable { .. }));
    assert!(
        gateway.request_count() <= 3,
        "expected an early stop on first success (api/tags miss + one /models hit), saw {} requests",
        gateway.request_count()
    );
}

// ---------------------------------------------------------------------------
// Discovery never launches qualification
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discovery_never_issues_a_chat_completion_request() {
    let gateway = MockGateway::start_routed(openai_compatible_only_catalog(json!({
        "data": [{"id": "discover-only"}]
    })))
    .await;
    let profile = openai_profile(&loopback_alias(&gateway));
    let _ = probe_provider_catalog(&profile, Some("sk-fixture".into())).await;
    for req in gateway.requests() {
        assert_ne!(
            req.method, "POST",
            "discovery must never POST (e.g. to /chat/completions) — that would be qualification, \
             which is explicit-only; saw {} {}",
            req.method, req.path
        );
    }
}

#[tokio::test]
async fn direct_list_models_call_makes_exactly_one_get_and_nothing_else() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "data": [{"id": "one-shot"}]
    })))])
    .await;
    let _ = openai_client_v1(&gateway).list_models().await.expect("ok");
    assert_eq!(gateway.request_count(), 1);
    assert_eq!(gateway.requests()[0].method, "GET");
}

// ---------------------------------------------------------------------------
// XaiGrokBuild: host pin is a hard boundary this lab must not defeat
// ---------------------------------------------------------------------------

#[tokio::test]
async fn grok_build_kind_without_a_session_file_is_key_rejected_before_any_wire_call() {
    // probe_provider_catalog's XaiGrokBuild branch calls the no-arg
    // detect_grok_session(), which is hardcoded to the real
    // dirs::home_dir()/.grok/auth.json — there is no injection seam to
    // point it at a synthetic path. Rather than assume a clean $HOME (which
    // holds in CI but not necessarily on a developer machine that already
    // uses Grok Build), check first and skip with a clear reason instead of
    // risking a false failure against a real session file.
    if let Some(auth) = dirs::home_dir().map(|h| h.join(".grok").join("auth.json")) {
        if auth.is_file() {
            eprintln!(
                "skipping: a real Grok session file exists at {}; this test only proves the \
                 no-session path",
                auth.display()
            );
            return;
        }
    }
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(200))]).await;
    let mut profile = openai_profile(gateway.base_url());
    profile.kind = ProviderKind::XaiGrokBuild;
    let probe = probe_provider_catalog(&profile, None).await;
    assert!(
        matches!(probe.outcome, ProbeOutcome::KeyRejected { .. }),
        "got {:?}",
        probe.outcome
    );
    assert_eq!(
        gateway.request_count(),
        0,
        "no HTTP call should ever be attempted without a Grok session file"
    );
}
