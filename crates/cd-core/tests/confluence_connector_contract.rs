//! Adversarial + happy-path proofs for the optional Confluence connector.
//!
//! Every case drives the **shipped** ToolHost / confluence_ro entry points with
//! a hermetic wiremock HTTP server. No real Atlassian tenant, token, or network
//! service is used. Fixtures are synthetic only.

use cd_core::activity::{
    ActivityDetailLevel, ActivityRecorder, ActivityStatus, ActivityStore, DataScope,
    ToolActivityKind,
};
use cd_core::config::{ConfluenceSettings, CONFLUENCE_PAT_REF};
use cd_core::confluence_ro::{self, ConfluenceAuth, ConfluenceRestPathMode, ConfluenceRoConfig};
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::permissions::PermissionDecision;
use cd_core::ssrf::{validate_provider_url, SsrfPolicy};
use cd_core::tool_host::ToolHost;
use cd_core::tools::names;
use cd_core::workspace::Workspace;
use serde_json::json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn empty_host() -> (tempfile::TempDir, ToolHost) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(
        format!("cf-{}", uuid::Uuid::now_v7()),
        vec![dir.path().to_path_buf()],
    );
    let idx = KeywordIndex::build(&ws).unwrap();
    (dir, ToolHost::new(ws, idx, None))
}

fn eng_cfg(base: &str) -> ConfluenceRoConfig {
    ConfluenceRoConfig {
        base_url: base.trim_end_matches('/').to_string(),
        spaces: vec!["ENG".into()],
        rest_path_mode: ConfluenceRestPathMode::Standard,
        url_style: Default::default(),
    }
}

async fn grant_once(host: &mut ToolHost, request_id: &str) {
    host.complete_permission(request_id, PermissionDecision::AllowOnce, Some("WRITE"))
        .expect("grant WRITE");
}

fn permission_request_id(events: &[StreamEvent]) -> String {
    events
        .iter()
        .find_map(|e| match e {
            StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
            _ => None,
        })
        .expect("PermissionRequired event")
}

fn permission_preview(events: &[StreamEvent]) -> String {
    events
        .iter()
        .find_map(|e| match e {
            StreamEvent::PermissionRequired { preview, .. } => Some(preview.clone()),
            _ => None,
        })
        .expect("preview")
}

// ---------------------------------------------------------------------------
// No connector / disabled / keyless
// ---------------------------------------------------------------------------

#[test]
fn no_connector_offers_zero_confluence_tools() {
    let (_d, host) = empty_host();
    let names: Vec<_> = host.specs_for_model().into_iter().map(|s| s.name).collect();
    assert!(
        names.iter().all(|n| !n.starts_with("confluence_")),
        "absent connector must not register Confluence tools: {names:?}"
    );
    assert!(host.confluence_agent_hint().is_none());
    assert!(!host.confluence_write_enabled());
}

#[test]
fn disabled_or_keyless_config_registers_no_tools_and_zero_secret_semantics() {
    let settings = ConfluenceSettings {
        enabled: true,
        base_url: "https://wiki.example.test".into(),
        spaces: vec!["ENG".into()],
        pat_ref: None,
        write_enabled: false,
        ..ConfluenceSettings::default()
    };
    assert!(settings.is_configured());
    assert!(settings.pat_ref.is_none());
    let (_d, mut host) = empty_host();
    host.set_confluence(Some(settings.to_ro_config()), None);
    let names: Vec<_> = host.specs_for_model().into_iter().map(|s| s.name).collect();
    assert!(
        names.iter().all(|n| !n.starts_with("confluence_")),
        "keyless Confluence must not offer tools: {names:?}"
    );
    // Structural: host apply path must gate secret get on pat_ref.
    let host_src = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../desktop/src-tauri/src/lib.rs"
    ));
    let apply = host_src
        .find("fn apply_host_connectors")
        .expect("apply_host_connectors");
    let body = &host_src[apply..apply + 1_200.min(host_src.len() - apply)];
    assert!(
        body.contains("pat_ref.is_some()"),
        "keyless profiles must skip secret-store reads: {body}"
    );
    assert_eq!(CONFLUENCE_PAT_REF, "confluence/default/pat");
}

// ---------------------------------------------------------------------------
// Read path via real ToolHost + wiremock
// ---------------------------------------------------------------------------

#[tokio::test]
async fn hermetic_search_and_get_page_with_provenance_and_citation() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/api/content/search"))
        .and(header("Authorization", "Bearer hermetic-pat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [{
                "id": "42",
                "title": "Auth Runbook",
                "space": {"key": "ENG"},
                "excerpt": "rotate JWT"
            }]
        })))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/api/content/42"))
        .and(header("Authorization", "Bearer hermetic-pat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "42",
            "title": "Auth Runbook",
            "space": {"key": "ENG"},
            "version": {"number": 3},
            "body": {"storage": {"value": "<p>Rotate JWT keys</p>"}},
            "_links": {"webui": "/pages/viewpage.action?pageId=42"}
        })))
        .mount(&server)
        .await;

    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("hermetic-pat".into()));
    assert!(host
        .specs_for_model()
        .iter()
        .any(|s| s.name == names::CONFLUENCE_SEARCH));
    assert_eq!(
        host.activity_tool_kinds()
            .get(names::CONFLUENCE_SEARCH)
            .copied(),
        Some(ToolActivityKind::ExternalConnector)
    );

    let search = host
        .execute(
            names::CONFLUENCE_SEARCH,
            &json!({"query": "JWT", "limit": 5}),
            None,
        )
        .await
        .unwrap();
    assert!(search.ok, "{search:?}");
    assert!(
        search.detail_raw.contains("Auth Runbook") || search.summary.contains("hit"),
        "{search:?}"
    );
    let search_cite = search.citation_path.as_deref().expect("search citation");
    assert!(
        search_cite.contains("42")
            && (search_cite.starts_with("http://")
                || search_cite.starts_with("https://")
                || search_cite.starts_with("confluence:")),
        "search citation must reopen exact page identity: {search_cite}"
    );
    // Prefer absolute URL so chat Sources can open the page in a browser.
    assert!(
        search_cite.starts_with("http://") || search_cite.starts_with("https://"),
        "host must emit reopenable absolute URL when constructable: {search_cite}"
    );

    let page = host
        .execute(
            names::CONFLUENCE_GET_PAGE,
            &json!({"page_id": "42", "format": "all"}),
            None,
        )
        .await
        .unwrap();
    assert!(page.ok, "{page:?}");
    assert!(page.detail_raw.contains("Rotate JWT") || page.detail_raw.contains("Auth Runbook"));
    assert!(
        page.detail_raw.contains('3') && page.detail_raw.contains("version"),
        "version provenance required: {}",
        page.detail_raw
    );
    assert!(
        page.detail_raw.contains("ENG"),
        "space provenance required: {}",
        page.detail_raw
    );
    let page_cite = page.citation_path.as_deref().expect("page citation");
    assert!(
        page_cite.contains("42")
            && (page_cite.starts_with("http://") || page_cite.starts_with("https://")),
        "page citation must be reopenable absolute URL: {page_cite}"
    );
    // Shared untrusted-data seam used by files/tools/memory results.
    assert!(
        page.detail_for_model.contains("UNTRUSTED_DATA")
            || page.detail_for_model.contains("untrusted"),
        "must enter shared untrusted-data context seam: {}",
        page.detail_for_model
    );

    // Reopen identity → constructable URL for the same page id.
    let url = confluence_ro::construct_page_url(&eng_cfg(&server.uri()), "42", "ENG", None);
    assert!(url.as_ref().unwrap().contains("42"), "{url:?}");
}

#[tokio::test]
async fn auth_failure_is_fail_closed_and_scrubs_secrets() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/api/content/search"))
        .respond_with(
            ResponseTemplate::new(401)
                .set_body_string("Bearer hermetic-secret-pat was rejected by upstream"),
        )
        .mount(&server)
        .await;
    let (_d, mut host) = empty_host();
    host.set_confluence(
        Some(eng_cfg(&server.uri())),
        Some("hermetic-secret-pat".into()),
    );
    let r = host
        .execute(names::CONFLUENCE_SEARCH, &json!({"query": "x"}), None)
        .await;
    match r {
        Ok(tr) => {
            assert!(!tr.ok || tr.detail_raw.to_ascii_lowercase().contains("unauthor"));
            assert!(
                !tr.detail_raw.contains("hermetic-secret-pat"),
                "PAT must not leak: {}",
                tr.detail_raw
            );
            assert!(!tr.detail_for_model.contains("hermetic-secret-pat"));
        }
        Err(e) => {
            let msg = e.to_string();
            assert!(
                msg.to_ascii_lowercase().contains("unauthor") || msg.contains("401"),
                "{msg}"
            );
            assert!(
                !msg.contains("hermetic-secret-pat"),
                "PAT must not leak in error: {msg}"
            );
        }
    }
}

#[tokio::test]
async fn tenant_mismatch_space_not_allowlisted() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/api/content/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [{
                "id": "9",
                "title": "Secret HR",
                "space": {"key": "HR"},
                "excerpt": "salaries"
            }]
        })))
        .mount(&server)
        .await;
    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("pat".into()));
    let r = host
        .execute(names::CONFLUENCE_SEARCH, &json!({"query": "pay"}), None)
        .await
        .unwrap();
    assert!(
        !r.detail_raw.contains("salaries") && !r.detail_raw.contains("Secret HR"),
        "non-allowlisted space must not surface: {}",
        r.detail_raw
    );
}

#[tokio::test]
async fn pagination_limit_is_capped_on_wire() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/api/content/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"results": []})))
        .mount(&server)
        .await;
    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("pat".into()));
    let _ = host
        .execute(
            names::CONFLUENCE_SEARCH,
            &json!({"query": "x", "limit": 9999}),
            None,
        )
        .await
        .unwrap();
    let reqs = server.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
    let url = reqs[0].url.to_string();
    // limit query must be present and ≤ 25
    let limit = url
        .split(['?', '&'])
        .find_map(|p| p.strip_prefix("limit="))
        .and_then(|v| v.parse::<u64>().ok())
        .expect("limit query");
    assert!(limit > 0 && limit <= 25, "limit={limit} url={url}");
}

#[tokio::test]
async fn rate_limit_retry_recovers() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/api/space"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("Retry-After", "0")
                .set_body_string("slow down"),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/rest/api/space"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [{"key": "ENG", "name": "Engineering"}]
        })))
        .mount(&server)
        .await;
    let cfg = eng_cfg(&server.uri());
    let auth = ConfluenceAuth::bearer("pat");
    let policy = SsrfPolicy::allow_private_networks();
    let response = confluence_ro::list_spaces(&cfg, &auth, &policy, 10)
        .await
        .unwrap();
    assert_eq!(response.value[0].key, "ENG");
    assert!(response
        .retry_notes
        .iter()
        .any(|n| n.contains("rate_limited")));
}

#[tokio::test]
async fn timeout_or_connect_failure_scrubs_secrets() {
    let cfg = ConfluenceRoConfig::new("http://127.0.0.1:1", vec!["ENG".into()]);
    let auth = ConfluenceAuth::bearer("timeout-secret-pat");
    let policy = SsrfPolicy::allow_private_networks();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        confluence_ro::list_spaces(&cfg, &auth, &policy, 1),
    )
    .await;
    match result {
        Ok(Err(e)) => {
            let msg = e.to_string();
            assert!(!msg.contains("timeout-secret-pat"), "{msg}");
        }
        Ok(Ok(_)) => panic!("unexpected success against closed port"),
        Err(_) => { /* outer bound */ }
    }
}

#[tokio::test]
async fn malformed_html_and_malicious_links_are_sanitized() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/api/content/7"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "7",
            "title": "Trap",
            "space": {"key": "ENG"},
            "version": {"number": 1},
            "body": {"storage": {"value":
                "<p>ok</p><script>steal()</script><a href=\"javascript:evil()\">click</a>"
            }}
        })))
        .mount(&server)
        .await;
    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("pat".into()));
    let page = host
        .execute(
            names::CONFLUENCE_GET_PAGE,
            &json!({"page_id": "7", "format": "plain"}),
            None,
        )
        .await
        .unwrap();
    assert!(page.ok, "{page:?}");
    assert!(
        !page.detail_raw.to_ascii_lowercase().contains("<script"),
        "{}",
        page.detail_raw
    );
    assert!(
        !page.detail_raw.to_ascii_lowercase().contains("javascript:"),
        "{}",
        page.detail_raw
    );
}

#[tokio::test]
async fn oversized_html_is_bounded() {
    let server = MockServer::start().await;
    let huge = "Z".repeat(300_000);
    Mock::given(method("GET"))
        .and(path("/rest/api/content/8"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "8",
            "title": "Huge",
            "space": {"key": "ENG"},
            "version": {"number": 1},
            "body": {"storage": {"value": format!("<p>{huge}</p>")}}
        })))
        .mount(&server)
        .await;
    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("pat".into()));
    let page = host
        .execute(
            names::CONFLUENCE_GET_PAGE,
            &json!({"page_id": "8", "format": "storage"}),
            None,
        )
        .await
        .unwrap();
    assert!(page.ok, "{page:?}");
    assert!(
        page.detail_raw.len() < 300_000,
        "oversized body must be bounded ({})",
        page.detail_raw.len()
    );
    assert!(
        page.detail_raw.contains("truncated") || page.detail_raw.len() <= 256 * 1024 + 200,
        "expected truncation marker or hard bound"
    );
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn write_tools_absent_when_write_disabled() {
    let (_d, mut host) = empty_host();
    host.set_confluence(
        Some(eng_cfg("https://wiki.example.test")),
        Some("pat".into()),
    );
    host.set_confluence_write_enabled(false);
    let names: Vec<_> = host.specs_for_model().into_iter().map(|s| s.name).collect();
    assert!(!names.iter().any(|n| n == names::CONFLUENCE_CREATE_PAGE));
    assert!(!names.iter().any(|n| n == names::CONFLUENCE_UPDATE_PAGE));
}

#[tokio::test]
async fn hardwrite_requires_confirm_preview_create_and_idempotent_retry() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/rest/api/content"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "100",
            "title": "New Page",
            "space": {"key": "ENG"},
            "version": {"number": 1}
        })))
        .mount(&server)
        .await;

    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("pat".into()));
    host.set_confluence_write_enabled(true);
    let args = json!({
        "space": "ENG",
        "title": "New Page",
        "body_storage": "<p>Hello body</p>"
    });

    // No grant → permission required, zero POSTs.
    let pending = host
        .execute(names::CONFLUENCE_CREATE_PAGE, &args, None)
        .await
        .unwrap();
    assert!(!pending.ok);
    let preview = permission_preview(&pending.events);
    assert!(
        preview.contains("operation: create") || preview.contains("classification: create"),
        "create classification missing: {preview}"
    );
    assert!(preview.contains("Hello body") || preview.contains("proposed body"));
    assert_eq!(server.received_requests().await.unwrap().len(), 0);

    // Deny → still zero writes.
    let req_id = permission_request_id(&pending.events);
    host.complete_permission(&req_id, PermissionDecision::Deny, None)
        .unwrap();
    assert_eq!(server.received_requests().await.unwrap().len(), 0);

    // AllowOnce + WRITE → one create.
    let pending2 = host
        .execute(names::CONFLUENCE_CREATE_PAGE, &args, None)
        .await
        .unwrap();
    let req_id2 = permission_request_id(&pending2.events);
    grant_once(&mut host, &req_id2).await;
    let done = host
        .execute(names::CONFLUENCE_CREATE_PAGE, &args, Some(&req_id2))
        .await
        .unwrap();
    assert!(done.ok, "{done:?}");
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
    assert!(
        done.citation_path
            .as_deref()
            .is_some_and(|c| c.contains("confluence:") || c.contains("100")),
        "{:?}",
        done.citation_path
    );

    // Duplicate identical create → idempotent reuse, no second POST.
    let pending3 = host
        .execute(names::CONFLUENCE_CREATE_PAGE, &args, None)
        .await
        .unwrap();
    let req_id3 = permission_request_id(&pending3.events);
    grant_once(&mut host, &req_id3).await;
    let again = host
        .execute(names::CONFLUENCE_CREATE_PAGE, &args, Some(&req_id3))
        .await
        .unwrap();
    assert!(again.ok, "{again:?}");
    assert!(
        again.summary.contains("idempotent") || again.summary.contains("reuse"),
        "{}",
        again.summary
    );
    assert_eq!(
        server.received_requests().await.unwrap().len(),
        1,
        "duplicate create must not POST again"
    );
}

#[tokio::test]
async fn update_preview_and_version_conflict_fail_closed() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/api/content/55"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "55",
            "title": "Old",
            "space": {"key": "ENG"},
            "version": {"number": 5},
            "body": {"storage": {"value": "<p>old</p>"}}
        })))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/rest/api/content/55"))
        .respond_with(ResponseTemplate::new(409).set_body_string("Version conflict"))
        .mount(&server)
        .await;

    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("pat".into()));
    host.set_confluence_write_enabled(true);
    let args = json!({
        "page_id": "55",
        "title": "New Title",
        "body_storage": "<p>new body</p>",
        "version": 4
    });
    let pending = host
        .execute(names::CONFLUENCE_UPDATE_PAGE, &args, None)
        .await
        .unwrap();
    let preview = permission_preview(&pending.events);
    assert!(
        preview.contains("operation: update") || preview.contains("classification: update"),
        "{preview}"
    );
    assert!(preview.contains("optimistic_version") || preview.contains("version"));

    let req_id = permission_request_id(&pending.events);
    grant_once(&mut host, &req_id).await;
    let result = host
        .execute(names::CONFLUENCE_UPDATE_PAGE, &args, Some(&req_id))
        .await;
    match result {
        Ok(tr) => assert!(!tr.ok, "version conflict must not report success: {tr:?}"),
        Err(e) => {
            let msg = e.to_string();
            assert!(
                msg.contains("409")
                    || msg.to_ascii_lowercase().contains("conflict")
                    || msg.contains("other"),
                "expected conflict-class error: {msg}"
            );
        }
    }
}

#[tokio::test]
async fn cancel_before_confirm_performs_zero_writes() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/rest/api/content"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "1", "title": "t", "space": {"key": "ENG"}, "version": {"number": 1}
        })))
        .mount(&server)
        .await;
    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("pat".into()));
    host.set_confluence_write_enabled(true);
    let _pending = host
        .execute(
            names::CONFLUENCE_CREATE_PAGE,
            &json!({"space":"ENG","title":"t","body_storage":"<p>x</p>"}),
            None,
        )
        .await
        .unwrap();
    // Never complete_permission — cancel by dropping the pending grant.
    drop(host);
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

#[tokio::test]
async fn read_tools_cannot_self_grant_write() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/rest/api/content"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "1", "title": "t", "space": {"key": "ENG"}, "version": {"number": 1}
        })))
        .mount(&server)
        .await;
    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("pat".into()));
    host.set_confluence_write_enabled(true);
    // Bogus grant id from "model text" — must fail closed.
    let bad = host
        .execute(
            names::CONFLUENCE_CREATE_PAGE,
            &json!({"space":"ENG","title":"t","body_storage":"<p>x</p>"}),
            Some("model-invented-grant"),
        )
        .await;
    assert!(bad.is_err(), "self-grant must fail");
    assert_eq!(server.received_requests().await.unwrap().len(), 0);
}

// ---------------------------------------------------------------------------
// Activity parity + session deletion + SSRF
// ---------------------------------------------------------------------------

#[tokio::test]
async fn activity_events_from_real_confluence_execute_omit_bodies_and_secrets() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/rest/api/content/search"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [{
                "id": "77",
                "title": "Public Title",
                "space": {"key": "ENG"},
                "excerpt": "no-secret-here"
            }]
        })))
        .mount(&server)
        .await;

    let (_d, mut host) = empty_host();
    let secret_pat = "activity-secret-pat-should-not-leak";
    host.set_confluence(Some(eng_cfg(&server.uri())), Some(secret_pat.into()));
    assert_eq!(
        host.activity_tool_kinds()
            .get(names::CONFLUENCE_SEARCH)
            .copied(),
        Some(ToolActivityKind::ExternalConnector)
    );

    let result = host
        .execute(
            names::CONFLUENCE_SEARCH,
            &json!({"query": "Public", "limit": 3}),
            None,
        )
        .await
        .unwrap();
    assert!(result.ok, "{result:?}");

    // Project the real tool events through the activity recorder (shipped path).
    let mut rec = ActivityRecorder::new(
        "turn-cf",
        "sess-cf",
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    rec.record_stream_events(&result.events);
    let record = rec.finish(ActivityStatus::Ok, 12);
    let json = serde_json::to_string(&record).unwrap();
    assert!(
        !json.contains(secret_pat),
        "activity must not journal PAT: {json}"
    );
    assert!(
        !json.contains("body_storage") && !json.contains("<p>"),
        "activity summary must not journal page bodies: {json}"
    );
    assert!(
        !record.events.is_empty(),
        "expected activity events from real confluence execute events={:?} record={:?}",
        result.events,
        record.events
    );
    let has_external = record.events.iter().any(|e| {
        e.origin == cd_core::activity::ActivityOrigin::ExternalConnector
            || e.label.to_ascii_lowercase().contains("confluence")
            || e.operation_id.contains("confluence")
            || e.label.to_ascii_lowercase().contains("search")
    });
    assert!(
        has_external,
        "activity parity: expected external/tool signal in {record:?}"
    );
}

#[test]
fn invalid_credential_ref_misses_secret_and_offers_no_tools() {
    // Simulate host apply path: pat_ref recorded but secret-store miss → None pat.
    let settings = ConfluenceSettings {
        enabled: true,
        base_url: "https://wiki.example.test".into(),
        spaces: vec!["ENG".into()],
        pat_ref: Some(CONFLUENCE_PAT_REF.into()),
        write_enabled: false,
        ..ConfluenceSettings::default()
    };
    assert!(settings.pat_ref.is_some());
    // Secret miss → host attaches cfg with None pat (apply_host_connectors).
    let (_d, mut host) = empty_host();
    host.set_confluence(Some(settings.to_ro_config()), None);
    host.set_confluence_auth_mode(settings.auth_mode, settings.basic_email.clone());
    let names: Vec<_> = host.specs_for_model().into_iter().map(|s| s.name).collect();
    assert!(
        names.iter().all(|n| !n.starts_with("confluence_")),
        "invalid/missing secret must fail closed with zero tools: {names:?}"
    );
    // Structural: desktop apply gates secret get on pat_ref and uses None when absent.
    let host_src = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../desktop/src-tauri/src/lib.rs"
    ));
    assert!(
        host_src.contains("pat_ref.is_some()") && host_src.contains("set_confluence_auth_mode"),
        "host must gate secret reads and apply auth_mode"
    );
}

#[tokio::test]
async fn basic_auth_mode_sends_basic_header_not_bearer() {
    let server = MockServer::start().await;
    let expected = cd_core::confluence_ro::ConfluenceAuth::Basic {
        email: "user@example.test".into(),
        token: "cloud-api-token".into(),
    }
    .authorization_header();
    Mock::given(method("GET"))
        .and(path("/rest/api/content/search"))
        .and(header("Authorization", expected.as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [{
                "id": "1",
                "title": "Cloud Page",
                "space": {"key": "ENG"},
                "excerpt": "ok"
            }]
        })))
        .mount(&server)
        .await;

    let (_d, mut host) = empty_host();
    host.set_confluence(Some(eng_cfg(&server.uri())), Some("cloud-api-token".into()));
    host.set_confluence_auth_mode(
        cd_core::config::ConfluenceAuthMode::Basic,
        Some("user@example.test".into()),
    );
    let r = host
        .execute(names::CONFLUENCE_SEARCH, &json!({"query": "Cloud"}), None)
        .await
        .unwrap();
    assert!(r.ok, "Basic auth must authenticate: {r:?}");
    assert!(r.detail_raw.contains("Cloud Page") || r.summary.contains("hit"));
    // Bearer-only bug would fail the Authorization matcher (no matching mock → error).
}

#[test]
fn session_deletion_clears_activity_store() {
    let mut store = ActivityStore::default();
    let rec = ActivityRecorder::new(
        "t1",
        "sess-a",
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    let mut record = rec.finish(ActivityStatus::Ok, 1);
    record.message_id = Some("m1".into());
    store.insert("sess-a", "m1", record);
    assert!(store.get("sess-a", "m1").is_some());
    store.forget_session("sess-a");
    assert!(store.get("sess-a", "m1").is_none());
}

#[test]
fn ssrf_rejects_link_local_metadata_style_urls() {
    let policy = SsrfPolicy::default();
    let err = validate_provider_url("http://169.254.169.254/latest/meta-data/", &policy);
    assert!(err.is_err(), "link-local metadata must be blocked");
}

#[test]
fn citation_identity_is_stable_page_id() {
    let cfg = eng_cfg("https://wiki.example.test");
    let url = confluence_ro::construct_page_url(&cfg, "42", "ENG", None);
    assert!(url.as_deref().unwrap().contains("42"), "{url:?}");
    assert_eq!(format!("confluence:{}", "42"), "confluence:42");
}
