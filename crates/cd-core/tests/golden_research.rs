//! Golden Q harness: offline fixture workspace research.

use cd_core::events::StreamEvent;
use cd_core::research::{build_host, research_local, research_scripted_tool_turn};
use cd_core::workspace::Workspace;
use std::path::PathBuf;

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/kb")
}

#[tokio::test]
async fn golden_billing_local_research() {
    let root = fixture_root();
    assert!(root.join("billing.md").is_file(), "missing fixtures/kb");
    let ws = Workspace::new("golden", vec![root]);
    let mut host = build_host(ws, None).expect("host");
    let events = research_local(&mut host, "payments invoices settlement", "g1")
        .await
        .expect("research");

    let text: String = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();

    assert!(
        text.to_lowercase().contains("payment")
            || text.to_lowercase().contains("invoice")
            || text.to_lowercase().contains("billing"),
        "expected billing content in answer, got: {text}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::Tool { .. })
                || matches!(e, StreamEvent::Citation { .. })),
        "expected tool or citation"
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::TurnCompleted { .. })));
}

#[tokio::test]
async fn golden_auth_scripted_tool_turn() {
    let root = fixture_root();
    let ws = Workspace::new("golden", vec![root]);
    let mut host = build_host(ws, None).expect("host");
    let events = research_scripted_tool_turn(&mut host, "JWT gateway sessions", "g2")
        .await
        .expect("scripted");
    assert!(events.iter().any(|e| matches!(e, StreamEvent::Tool { .. })));
}
