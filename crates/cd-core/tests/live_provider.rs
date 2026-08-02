//! Explicit, ignored acceptance checks for real local provider tool loops.
//!
//! These tests never run in ordinary CI. They use synthetic evidence only and
//! refuse non-loopback provider URLs.

use cd_core::agent::LogExplorerTurnContext;
use cd_core::chat::{ChatMessage, Role};
use cd_core::events::{StreamEvent, ToolPhase};
use cd_core::log_analysis::ingest_path;
use cd_core::providers::ProviderCapabilities;
use cd_core::research::{build_host, research_turn_with_cancel_and_context};
use cd_core::workspace::Workspace;
use cd_core::{ProviderDeadlinePreference, ProviderKind, ProviderProfile};
use std::fs;
use std::io::Write;
use std::time::Instant;

const ENABLE_ENV: &str = "CONTEXTDESK_LIVE_OLLAMA";
const URL_ENV: &str = "CONTEXTDESK_LIVE_OLLAMA_URL";
const MODEL_ENV: &str = "CONTEXTDESK_LIVE_OLLAMA_MODEL";
const GROK_ENABLE_ENV: &str = "CONTEXTDESK_LIVE_GROK_BUILD";
const GROK_MODEL_ENV: &str = "CONTEXTDESK_LIVE_GROK_BUILD_MODEL";
const DEFAULT_URL: &str = "http://127.0.0.1:11434";
const DEFAULT_MODEL: &str = "mistral";
const LOG_MARKER: &str = "LIVE_OLLAMA_LOG_MARKER";
const RUNBOOK_MARKER: &str = "LIVE_OLLAMA_RUNBOOK_MARKER";
const LOG_VALUE: &str = "job-live-7f3a";
const RUNBOOK_VALUE: &str = "restart-worker-pool";

fn describes_runbook_action(answer: &str) -> bool {
    let words = answer
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    words.iter().any(|word| word.starts_with("restart"))
        && words.iter().any(|word| word == "worker")
        && words.iter().any(|word| word == "pool")
}

fn explicit_loopback_url() -> String {
    assert_eq!(
        std::env::var(ENABLE_ENV).as_deref(),
        Ok("1"),
        "live provider test is opt-in; set {ENABLE_ENV}=1"
    );
    let raw = std::env::var(URL_ENV).unwrap_or_else(|_| DEFAULT_URL.into());
    let parsed = url::Url::parse(&raw).expect("valid Ollama URL");
    assert_eq!(
        parsed.scheme(),
        "http",
        "live acceptance only permits loopback HTTP"
    );
    assert!(
        matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "::1")),
        "live acceptance refuses non-loopback provider URL: {raw}"
    );
    raw.trim_end_matches('/').to_string()
}

fn explicit_grok_build_profile() -> ProviderProfile {
    assert_eq!(
        std::env::var(GROK_ENABLE_ENV).as_deref(),
        Ok("1"),
        "live Grok Build test is opt-in; set {GROK_ENABLE_ENV}=1"
    );
    let model = std::env::var(GROK_MODEL_ENV).unwrap_or_else(|_| "grok-4.5".into());
    ProviderProfile {
        id: "live-grok-build".into(),
        label: format!("Live Grok Build {model}"),
        kind: ProviderKind::XaiGrokBuild,
        base_url: "https://api.x.ai/v1".into(),
        api_key_ref: None,
        chat_model: model,
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: false,
        deadline_preference: ProviderDeadlinePreference::Standard,
    }
}

/// Real, credentials-free linked turn against an explicitly selected local
/// Ollama model. Run with:
///
/// `CONTEXTDESK_LIVE_OLLAMA=1 cargo test -p cd-core
/// live_ollama_linked_turn_uses_logs_and_workspace -- --ignored --nocapture`
#[tokio::test]
#[ignore = "explicit live loopback Ollama acceptance; never part of deterministic CI"]
async fn live_ollama_linked_turn_uses_logs_and_workspace() {
    let base_url = explicit_loopback_url();
    let model = std::env::var(MODEL_ENV).unwrap_or_else(|_| DEFAULT_MODEL.into());

    let fixture = tempfile::tempdir().expect("fixture root");
    fs::write(
        fixture.path().join("recovery-runbook.md"),
        format!("# Synthetic recovery runbook\n\n{RUNBOOK_MARKER}={RUNBOOK_VALUE}\n"),
    )
    .expect("write runbook");
    let logs = fixture.path().join("logs");
    fs::create_dir_all(&logs).expect("create logs");
    let mut log = fs::File::create(logs.join("worker.log")).expect("create log");
    writeln!(
        log,
        r#"{{"ts":1700000100,"level":"error","service":"worker","message":"{LOG_MARKER}={LOG_VALUE} queue stalled"}}"#
    )
    .expect("write log");

    let cache = tempfile::tempdir().expect("log cache");
    let report = ingest_path(cache.path(), &logs, "live-ollama", None, "none")
        .expect("ingest synthetic log");
    let workspace = Workspace::new("live-ollama", vec![fixture.path().to_path_buf()]);
    let mut host = build_host(workspace, None).expect("build production tool host");
    host.set_log_analysis(true, Some(cache.path().to_path_buf()));
    host.set_active_log_corpus(Some(report.corpus_id.clone()));

    let mut profile = ProviderProfile::ollama_local();
    profile.base_url = base_url.clone();
    profile.chat_model = model.clone();
    profile.label = format!("Live Ollama {model}");
    assert!(profile.capabilities.tools);
    assert!(profile.local_only);

    let context = LogExplorerTurnContext::new(
        "live-ollama-window",
        report.corpus_id.as_str(),
        format!(
            "corpusId={}; sources=worker.log; timeQuality=wall",
            report.corpus_id
        ),
    )
    .expect("linked context");
    let prompt = format!(
        "Investigate the synthetic incident identified by `{LOG_MARKER}` in the linked logs. \
         Cross-check it against the recovery runbook in the workspace, whose marker key is \
         `{RUNBOOK_MARKER}`. Use the available read tools, do not guess, and report the exact \
         value associated with each marker. Do not call write tools."
    );
    let mut history: Vec<ChatMessage> = Vec::new();
    let started = Instant::now();
    let events = research_turn_with_cancel_and_context(
        &mut host,
        &profile,
        None,
        &prompt,
        &mut history,
        "live-ollama-session",
        false,
        None,
        Some(context),
        None,
    )
    .await
    .expect("live linked turn");
    let elapsed = started.elapsed();

    let successful_tools = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::Tool {
                name,
                phase: ToolPhase::Finished,
                ok: Some(true),
                ..
            } => Some(name.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(
        successful_tools.contains(&"search_logs"),
        "real provider did not complete search_logs:\nevents={events:#?}\nhistory={history:#?}"
    );
    assert!(
        successful_tools.contains(&"search_kb"),
        "real provider did not complete search_kb:\nevents={events:#?}\nhistory={history:#?}"
    );
    assert!(
        !history
            .iter()
            .filter_map(|message| message.tool_calls.as_ref())
            .flatten()
            .any(|call| call.id.starts_with("fallback_")),
        "acceptance requires the provider's native function-call channel: {history:#?}"
    );
    let tool_evidence = history
        .iter()
        .filter(|message| message.role == Role::Tool)
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>();
    assert!(
        tool_evidence
            .iter()
            .any(|content| content.contains(&format!("{LOG_MARKER}={LOG_VALUE}"))),
        "native tools did not return the exact log marker/value pair: {tool_evidence:#?}"
    );
    assert!(
        tool_evidence
            .iter()
            .any(|content| content.contains(&format!("{RUNBOOK_MARKER}={RUNBOOK_VALUE}"))),
        "native tools did not return the exact runbook marker/value pair: {tool_evidence:#?}"
    );

    let answer = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();
    assert!(
        answer.contains(LOG_VALUE),
        "answer={answer:?}\nhistory={history:#?}"
    );
    assert!(
        describes_runbook_action(&answer),
        "answer={answer:?}\nhistory={history:#?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, StreamEvent::Error { .. })),
        "live linked turn emitted an error: {events:#?}"
    );
    let completion = events.iter().find_map(|event| match event {
        StreamEvent::TurnCompleted { reason } => Some(reason.as_str()),
        _ => None,
    });
    assert!(completion.is_some(), "turn never completed: {events:#?}");

    let citations = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::Citation {
                source_id, label, ..
            } => Some(format!("{source_id}:{label}")),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(
        citations
            .iter()
            .any(|citation| citation.starts_with("log_template:")),
        "missing log provenance: {citations:?}"
    );
    assert!(
        citations
            .iter()
            .any(|citation| citation.contains("recovery-runbook.md")),
        "missing workspace provenance: {citations:?}"
    );

    eprintln!(
        "LIVE_OLLAMA_ACCEPTANCE PASS model={model} url={base_url} elapsed_ms={} \
         tools={} citations={} completion={} answer_chars={}",
        elapsed.as_millis(),
        successful_tools.join(","),
        citations.join(","),
        completion.unwrap_or("missing"),
        answer.chars().count()
    );
}

/// Real linked-log broad triage through the explicitly authorized local Grok
/// Build session. The fixture is synthetic, the session credential remains in
/// Rust, and ordinary CI never opts in.
#[tokio::test]
#[ignore = "explicit live Grok Build acceptance; never part of deterministic CI"]
async fn live_grok_build_linked_broad_triage_is_grounded() {
    let profile = explicit_grok_build_profile();
    let fixture = tempfile::tempdir().expect("fixture root");
    let logs = fixture.path().join("logs");
    fs::create_dir_all(&logs).expect("create logs");
    let mut log = fs::File::create(logs.join("service.log")).expect("create log");
    writeln!(
        log,
        r#"{{"ts":1700000100,"level":"error","service":"api","message":"SYNTHETIC_GROK_ACCEPT connection pool exhausted"}}"#
    )
    .expect("write error");
    writeln!(
        log,
        r#"{{"ts":1700000101,"level":"warn","service":"api","message":"SYNTHETIC_GROK_ACCEPT retry delayed"}}"#
    )
    .expect("write warning");

    let cache = tempfile::tempdir().expect("log cache");
    let report =
        ingest_path(cache.path(), &logs, "live-grok", None, "none").expect("ingest synthetic logs");
    let workspace = Workspace::new("live-grok", vec![fixture.path().to_path_buf()]);
    let mut host = build_host(workspace, None).expect("build production tool host");
    host.set_log_analysis(true, Some(cache.path().to_path_buf()));
    host.set_active_log_corpus(Some(report.corpus_id.clone()));

    let context = LogExplorerTurnContext::new(
        "live-grok-window",
        report.corpus_id.as_str(),
        format!("corpusId={}; timeQuality=wall", report.corpus_id),
    )
    .expect("linked context");
    let mut history = Vec::new();
    let started = Instant::now();
    let events = research_turn_with_cancel_and_context(
        &mut host,
        &profile,
        None,
        "What problems do you see in these logs? Use bounded evidence and separate observation from inference.",
        &mut history,
        "live-grok-session",
        false,
        None,
        Some(context),
        None,
    )
    .await
    .expect("live Grok Build linked turn");

    let successful_log_reads = events
        .iter()
        .filter(|event| {
            matches!(
                event,
                StreamEvent::Tool {
                    name,
                    phase: ToolPhase::Finished,
                    ok: Some(true),
                    ..
                } if name == "broad_log_triage" || name == "search_logs"
            )
        })
        .count();
    let answer_chars = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.chars().count()),
            _ => None,
        })
        .sum::<usize>();
    let citations = events
        .iter()
        .filter(|event| matches!(event, StreamEvent::Citation { .. }))
        .count();
    let completion = events.iter().find_map(|event| match event {
        StreamEvent::TurnCompleted { reason } => Some(reason.as_str()),
        _ => None,
    });
    let error_codes = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::Error { code, .. } => Some(code.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();

    eprintln!(
        "LIVE_GROK_BUILD_ACCEPTANCE RESULT model={} elapsed_ms={} log_reads={} citations={} answer_chars={} completion={} errors={}",
        profile.chat_model,
        started.elapsed().as_millis(),
        successful_log_reads,
        citations,
        answer_chars,
        completion.unwrap_or("missing"),
        error_codes.join(",")
    );

    assert!(successful_log_reads > 0, "no successful bounded log read");
    assert!(answer_chars > 0, "provider returned no answer text");
    assert!(
        completion.is_some_and(|reason| {
            reason != "linked_invalid_grounded_answer" && reason != "linked_no_tool"
        }),
        "linked turn did not complete with a grounded answer"
    );
    assert!(
        !events.iter().any(|event| matches!(
            event,
            StreamEvent::Error { code, .. }
                if code == "linked_invalid_grounded_answer" || code == "linked_no_tool"
        )),
        "linked turn failed its grounding contract"
    );
}

#[test]
fn live_acceptance_allows_equivalent_runbook_action_wording() {
    assert!(describes_runbook_action("Use restart-worker-pool."));
    assert!(describes_runbook_action(
        "The runbook recommends restarting the worker pool."
    ));
    assert!(!describes_runbook_action("Review the recovery runbook."));
}
