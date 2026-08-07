//! Provider-failure terminal projection — workflow seam, generic over status.
//!
//! The frozen transport/semantic oracle pins the 429 case end-to-end. This
//! file proves the same projection is driven by the *status the provider
//! returned* rather than by any one provider's prose, and that the projection
//! carries nothing from the provider's response body.
//!
//! Why these three properties and not "the terminal is typed":
//!
//! * **Classification is status-driven.** A rate limit, a refused credential,
//!   and a server fault are different operator actions. Collapsing them into
//!   one code would make the typed terminal no more useful than the opaque
//!   `Err` it replaced.
//! * **No provider body reaches the stream.** Provider bodies routinely echo
//!   the request — endpoints, and filesystem paths lifted from the operator's
//!   own logs. The transcript and the activity journal are deliberately free
//!   of both; the full scrubbed transport message stays on the turn trace,
//!   behind the developer-trace opt-in.
//! * **A failed turn never reads as success.** The provider never answered,
//!   so the shared classifier must call the turn `Failed` — not `Ok`, and not
//!   `Withheld`, which means ContextDesk declined to deliver an answer it had.

use cd_core::activity::{status_for_turn_events, ActivityStatus};
use cd_core::config::AppConfig;
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::MemorySecretStore;
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;
use cd_workflow::provider::{resolve_turn_inputs, ResolvedTurnInputs};
use cd_workflow::turn::{run_turn, TurnExecutionOptions};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A provider body that echoes exactly what must never reach the stream: a
/// path out of the operator's own logs and a credential.
const LEAKY_BODY: &str = r#"{"error":{"message":"upstream failed reading /srv/private/customer.log with bearer sk-live-must-not-appear"}}"#;

async fn mount_status(server: &MockServer, status: u16) {
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(status)
                .insert_header("content-type", "application/json")
                // Retry-After: 0 keeps the bounded 429 budget hermetic.
                .insert_header("retry-after", "0")
                .set_body_raw(LEAKY_BODY, "application/json"),
        )
        .mount(server)
        .await;
}

fn resolved_inputs(base_url: &str) -> (MemorySecretStore, ResolvedTurnInputs) {
    let secrets = MemorySecretStore::new();
    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = base_url.to_string();
    profile.local_only = true;
    profile.chat_model = "projection-test-model".into();
    profile.capabilities.tools = false;
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    let resolved = resolve_turn_inputs(&secrets, &cfg, None, None).expect("resolved inputs");
    (secrets, resolved)
}

fn ordinary_host() -> (tempfile::TempDir, ToolHost) {
    let workspace_dir = tempfile::tempdir().expect("workspace dir");
    let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
    let index = KeywordIndex::build(&workspace).expect("index");
    (workspace_dir, ToolHost::new(workspace, index, None))
}

async fn ordinary_turn_events(status: u16, session: &str) -> Vec<StreamEvent> {
    let server = MockServer::start().await;
    mount_status(&server, status).await;
    let (_workspace_dir, mut host) = ordinary_host();
    let (_secrets, resolved) = resolved_inputs(&server.uri());
    let mut history = Vec::new();
    run_turn(
        &mut host,
        &resolved,
        "hi there",
        &mut history,
        session,
        TurnExecutionOptions::default(),
        None,
        None,
    )
    .await
    .unwrap_or_else(|error| {
        panic!("HTTP {status} must terminate typed, not as an opaque Err: {error}")
    })
}

fn terminal_reason(events: &[StreamEvent]) -> String {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            StreamEvent::TurnCompleted { reason } => Some(reason.clone()),
            _ => None,
        })
        .expect("every terminated turn reports a reason")
}

fn error_message(events: &[StreamEvent]) -> String {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            StreamEvent::Error { message, .. } => Some(message.clone()),
            _ => None,
        })
        .expect("a failed turn reports an explicit error")
}

#[tokio::test]
async fn each_provider_status_class_projects_its_own_typed_terminal() {
    for (status, expected_reason) in [
        (429u16, "provider_rate_limited"),
        (401, "provider_unauthorized"),
        (403, "provider_unauthorized"),
        (500, "provider_unavailable"),
        (503, "provider_unavailable"),
        (418, "provider_failed"),
    ] {
        let events = ordinary_turn_events(status, &format!("s-projection-{status}")).await;
        assert_eq!(
            terminal_reason(&events),
            expected_reason,
            "HTTP {status} must classify by the status the provider returned"
        );
        assert!(
            error_message(&events).contains(&format!("HTTP {status}")),
            "the operator needs the provider's own status: HTTP {status}"
        );
    }
}

/// The terminal the transcript and the activity journal are built from must
/// carry nothing the provider wrote. (`ProviderTelemetry.rounds[].error`
/// deliberately still carries the scrubbed transport message — that channel
/// is the operator's explicit `--trace` opt-in, and reading the provider's
/// actual error is its entire purpose.)
#[tokio::test]
async fn a_provider_failure_terminal_carries_nothing_from_the_response_body() {
    for status in [429u16, 401, 500] {
        let events = ordinary_turn_events(status, &format!("s-noleak-{status}")).await;
        let message = error_message(&events);
        assert!(
            !message.contains("/srv/private"),
            "a provider body must never put a log path into the terminal (HTTP {status}): {message}"
        );
        assert!(
            !message.contains("sk-live-must-not-appear"),
            "a provider body must never put a credential into the terminal (HTTP {status})"
        );
        assert!(
            !message.contains("upstream failed reading"),
            "the provider's prose must not be quoted into the terminal (HTTP {status})"
        );

        // Whatever the diagnostic channel does carry is credential-scrubbed.
        let rendered = serde_json::to_string(&events).expect("events serialize");
        assert!(
            !rendered.contains("sk-live-must-not-appear"),
            "a credential must never survive anywhere in the stream (HTTP {status})"
        );
    }
}

#[tokio::test]
async fn a_provider_failure_is_reported_as_failed_not_as_success_or_withholding() {
    for status in [429u16, 401, 500] {
        let events = ordinary_turn_events(status, &format!("s-status-{status}")).await;
        assert_eq!(
            status_for_turn_events(&events),
            ActivityStatus::Failed,
            "HTTP {status} produced no answer; reporting it as anything else is a lie"
        );
        assert!(
            cd_core::events::withheld_turn_reason(&events).is_none(),
            "HTTP {status} is the provider not answering, not ContextDesk withholding"
        );
    }
}

/// The failed provider round is the whole point of terminating typed: an
/// opaque `Err` erased it for both hosts.
#[tokio::test]
async fn the_failed_provider_round_survives_in_typed_telemetry() {
    let events = ordinary_turn_events(500, "s-telemetry-500").await;
    let telemetry = events
        .iter()
        .find_map(|event| match event {
            StreamEvent::ProviderTelemetry { telemetry } => Some((**telemetry).clone()),
            _ => None,
        })
        .expect("run_turn appends one authoritative ProviderTelemetry event");
    assert_eq!(telemetry.provider_round_count, 1);
    assert_eq!(telemetry.rounds[0].outcome, "failed");
}
