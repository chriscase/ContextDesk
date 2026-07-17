//! Streaming event types for the `cd.v1` protocol.

use serde::{Deserialize, Serialize};

/// Phase of a tool invocation in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPhase {
    /// Tool call started.
    Started,
    /// Tool call finished (success or error).
    Finished,
}

/// Events emitted by the agent runtime toward hosts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    /// A turn began.
    TurnStarted {
        /// Session identifier.
        session_id: String,
        /// Model id if known.
        model: Option<String>,
    },
    /// Incremental assistant markdown.
    TextDelta {
        /// UTF-8 chunk (may be partial markdown).
        text: String,
    },
    /// Optional model "thought" channel.
    ThoughtDelta {
        /// Thought chunk.
        text: String,
    },
    /// Tool lifecycle (compact by default in UI).
    Tool {
        /// Correlation id for expand/collapse.
        id: String,
        /// Tool name.
        name: String,
        /// Started or finished.
        phase: ToolPhase,
        /// One-line summary for collapsed UI.
        summary: String,
        /// Optional longer detail (UI may lazy-show).
        detail: Option<String>,
        /// True when finished successfully.
        ok: Option<bool>,
    },
    /// Citation / provenance chip.
    Citation {
        /// Stable source id.
        source_id: String,
        /// Display label (path, page title, etc.).
        label: String,
        /// Optional locator (lines, URL fragment).
        locator: Option<String>,
    },
    /// Where the router looked.
    SearchTrail {
        /// Human-readable steps.
        steps: Vec<String>,
    },
    /// Host must obtain a user decision before a write.
    PermissionRequired {
        /// Request id for `permission.respond`.
        request_id: String,
        /// Tool name.
        tool_name: String,
        /// Target description (path, page, …).
        target: String,
        /// Why the model wants this.
        reason: String,
        /// Human preview of content or draft (may be non-JSON).
        preview: String,
        /// Risk hint: local | remote | destructive.
        risk: String,
        /// Original tool arguments for Accept re-execute (host also stores these).
        #[serde(default)]
        arguments: serde_json::Value,
    },
    /// Turn ended.
    TurnCompleted {
        /// Finish reason (stop, cancel, error, …).
        reason: String,
    },
    /// Safe error for UI.
    Error {
        /// Stable code.
        code: String,
        /// User-visible message (no secrets).
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_event_roundtrip_json() {
        let ev = StreamEvent::TextDelta {
            text: "hello".into(),
        };
        let s = serde_json::to_string(&ev).unwrap();
        let back: StreamEvent = serde_json::from_str(&s).unwrap();
        match back {
            StreamEvent::TextDelta { text } => assert_eq!(text, "hello"),
            _ => panic!("wrong variant"),
        }
    }
}
