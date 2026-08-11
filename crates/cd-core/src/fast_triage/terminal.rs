//! Typed parsing of one fast-model terminal into **separate channels**.
//!
//! A fast or inexpensive model formats sloppily. The response to that is not a
//! more forgiving parser — a forgiving parser is how prose becomes a "pass".
//! It is to keep the channels apart and to accept only what is explicitly
//! typed:
//!
//! * **visible answer** — what a reader would see, after complete known
//!   reasoning wrappers are removed;
//! * **reasoning** — captured separately, accounted for, and structurally
//!   impossible to render (see [`FastTriageTerminal`]);
//! * **tool calls** — id and name only; argument bodies are untrusted content
//!   and are counted, not retained;
//! * **terminal state** — typed object, empty visible, or malformed;
//! * **errors** — the caller's own transport/deadline/cancel channel, which
//!   never merges into any of the above.
//!
//! Normalization is the shared production one
//! ([`crate::linked_triage_contract`]): complete known reasoning blocks and a
//! complete Markdown JSON fence unwrap; arbitrary prose never does. There is no
//! second, more permissive unwrap path for "fast" models.

use crate::chat::ChatCompletion;
use crate::linked_triage_contract::{normalize_known_json_wrapper, split_complete_reasoning_prefix};

/// What the provider actually terminated with, before any host validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageTerminalState {
    /// Visible content normalized to exactly one JSON object.
    TypedObject,
    /// No non-whitespace visible content survived reasoning removal. This
    /// includes a reasoning-only terminal, which is never a successful answer.
    EmptyVisible,
    /// Visible content exists but is not exactly one JSON object. It is never
    /// guessed into a typed answer.
    Malformed,
}

impl FastTriageTerminalState {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TypedObject => "typed_object",
            Self::EmptyVisible => "empty_visible",
            Self::Malformed => "malformed",
        }
    }
}

/// One tool call the model requested, reduced to its host-safe identity.
///
/// Argument bodies are model text that may quote corpus content, so they are
/// counted rather than retained. This route issues no tools; a tool call here
/// is a *contract observation* (the model tried to act instead of answering)
/// and is recorded as such.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FastTriageToolCallRef {
    /// Provider-assigned call id.
    pub id: String,
    /// Requested tool name.
    pub name: String,
    /// Length of the argument body. The body itself is never retained.
    pub argument_chars: usize,
}

/// One parsed terminal, with its channels kept apart.
///
/// `reasoning` is private and has **no accessor**: the type can report that
/// reasoning was present and how long it was, and nothing more. `Debug` is
/// implemented by hand for the same reason — a derived `Debug` would print it
/// into any log line that formatted the struct.
#[derive(Clone)]
pub struct FastTriageTerminal {
    visible: String,
    typed_object: Option<String>,
    reasoning: String,
    tool_calls: Vec<FastTriageToolCallRef>,
    finish_reason: String,
    state: FastTriageTerminalState,
}

impl std::fmt::Debug for FastTriageTerminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately omits both `visible` and `reasoning`: one is untrusted
        // model text and the other must never be rendered anywhere at all.
        f.debug_struct("FastTriageTerminal")
            .field("state", &self.state)
            .field("finish_reason", &self.finish_reason)
            .field("visible_chars", &self.visible.chars().count())
            .field("reasoning_chars", &self.reasoning.chars().count())
            .field("tool_calls", &self.tool_calls.len())
            .finish()
    }
}

impl FastTriageTerminal {
    /// Parse one completion's visible content and tool calls into channels.
    ///
    /// `streamed` is the host's bounded accumulation of streamed text, used
    /// only when the completion carried no content of its own — the same
    /// precedence the established multi-stage path applies.
    pub fn parse(completion: &ChatCompletion, streamed: &str) -> Self {
        let raw = if completion.content.trim().is_empty() {
            streamed
        } else {
            completion.content.as_str()
        };
        Self::from_raw(
            raw,
            &completion.finish_reason,
            completion
                .tool_calls
                .iter()
                .map(|call| FastTriageToolCallRef {
                    id: call.id.clone(),
                    name: call.function.name.clone(),
                    argument_chars: call.function.arguments.chars().count(),
                })
                .collect(),
        )
    }

    /// Parse a raw terminal body directly. Exposed for host paths that already
    /// hold the bounded body rather than the completion.
    pub fn from_raw(
        raw: &str,
        finish_reason: &str,
        tool_calls: Vec<FastTriageToolCallRef>,
    ) -> Self {
        let (reasoning, visible) = split_complete_reasoning_prefix(raw);
        let (state, typed_object) = if visible.trim().is_empty() {
            (FastTriageTerminalState::EmptyVisible, None)
        } else {
            match normalize_known_json_wrapper(&visible) {
                Some(object) if !object.trim().is_empty() => {
                    (FastTriageTerminalState::TypedObject, Some(object))
                }
                // A complete known wrapper that unwrapped to nothing is the
                // same honest observation as an empty terminal, not a parse
                // failure the model could repair by "trying harder".
                Some(_) => (FastTriageTerminalState::EmptyVisible, None),
                None => (FastTriageTerminalState::Malformed, None),
            }
        };
        Self {
            visible,
            typed_object,
            reasoning,
            tool_calls,
            finish_reason: finish_reason.to_string(),
            state,
        }
    }

    /// Typed terminal classification.
    pub fn state(&self) -> FastTriageTerminalState {
        self.state
    }

    /// The exact JSON object to validate, when the terminal was typed.
    pub fn typed_object(&self) -> Option<&str> {
        self.typed_object.as_deref()
    }

    /// Number of visible characters (reasoning excluded).
    pub fn visible_chars(&self) -> usize {
        self.visible.chars().count()
    }

    /// Whether the provider emitted a reasoning channel.
    pub fn reasoning_present(&self) -> bool {
        !self.reasoning.trim().is_empty()
    }

    /// Length of the reasoning channel. The text itself is never exposed.
    pub fn reasoning_chars(&self) -> usize {
        self.reasoning.chars().count()
    }

    /// Tool calls requested on this terminal (identity only).
    pub fn tool_calls(&self) -> &[FastTriageToolCallRef] {
        &self.tool_calls
    }

    /// Provider-reported finish reason, verbatim.
    pub fn finish_reason(&self) -> &str {
        &self.finish_reason
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::{ChatCompletion, FunctionCall, ToolCallMsg};

    fn completion(content: &str, tool_calls: Vec<ToolCallMsg>) -> ChatCompletion {
        ChatCompletion::from_parts(content, tool_calls, "stop")
    }

    #[test]
    fn reasoning_stays_in_its_own_channel_and_never_becomes_visible() {
        let terminal = FastTriageTerminal::parse(
            &completion(
                "<think>private chain of thought</think>\n```json\n{\"schema\":\"x\"}\n```",
                Vec::new(),
            ),
            "",
        );
        assert_eq!(terminal.state(), FastTriageTerminalState::TypedObject);
        assert_eq!(terminal.typed_object(), Some("{\"schema\":\"x\"}"));
        assert!(terminal.reasoning_present());
        assert_eq!(terminal.reasoning_chars(), "private chain of thought".len());
        // Neither the debug projection nor any accessor can surface the text.
        let debug = format!("{terminal:?}");
        assert!(!debug.contains("private chain of thought"));
        assert!(!debug.contains("schema"));
    }

    #[test]
    fn a_reasoning_only_terminal_is_empty_not_a_pass() {
        let terminal =
            FastTriageTerminal::parse(&completion("<think>I will answer next turn</think>", Vec::new()), "");
        assert_eq!(terminal.state(), FastTriageTerminalState::EmptyVisible);
        assert!(terminal.typed_object().is_none());
        assert!(terminal.reasoning_present());
        assert_eq!(terminal.visible_chars(), 0);
    }

    #[test]
    fn malformed_prose_is_never_guessed_into_a_typed_object() {
        for raw in [
            "Here is the answer: {\"schema\":\"x\"}",
            "```json\n{\"schema\":\"x\"}\n``` and also some prose",
            "The initiating cause is clearly the first error.",
        ] {
            let terminal = FastTriageTerminal::parse(&completion(raw, Vec::new()), "");
            assert_eq!(
                terminal.state(),
                FastTriageTerminalState::Malformed,
                "must not accept {raw}"
            );
            assert!(terminal.typed_object().is_none());
        }
        // Two concatenated objects start with `{` and end with `}`, so the
        // shared normalizer hands them on rather than searching prose for a
        // brace pair. They are still not an answer: the host validator rejects
        // them at parse time, which is where a second object must die.
        let two = FastTriageTerminal::parse(
            &completion("{\"schema\":\"x\"} {\"schema\":\"y\"}", Vec::new()),
            "",
        );
        assert_eq!(two.state(), FastTriageTerminalState::TypedObject);
        assert!(serde_json::from_str::<serde_json::Value>(
            two.typed_object().unwrap_or_default()
        )
        .is_err());
    }

    #[test]
    fn streamed_text_is_used_only_when_the_completion_carried_none() {
        let from_stream =
            FastTriageTerminal::parse(&completion("   ", Vec::new()), "{\"schema\":\"x\"}");
        assert_eq!(from_stream.typed_object(), Some("{\"schema\":\"x\"}"));
        let from_completion =
            FastTriageTerminal::parse(&completion("{\"schema\":\"y\"}", Vec::new()), "{\"schema\":\"x\"}");
        assert_eq!(from_completion.typed_object(), Some("{\"schema\":\"y\"}"));
    }

    #[test]
    fn tool_calls_keep_identity_and_drop_argument_bodies() {
        let terminal = FastTriageTerminal::parse(
            &completion(
                "",
                vec![ToolCallMsg {
                    id: "call-1".into(),
                    kind: "function".into(),
                    function: FunctionCall {
                        name: "search_logs".into(),
                        arguments: "{\"q\":\"secret corpus text\"}".into(),
                    },
                }],
            ),
            "",
        );
        assert_eq!(terminal.tool_calls().len(), 1);
        assert_eq!(terminal.tool_calls()[0].name, "search_logs");
        assert_eq!(terminal.tool_calls()[0].argument_chars, 26);
        let projected = serde_json::to_string(&terminal.tool_calls()[0]).expect("json");
        assert!(!projected.contains("secret corpus text"));
    }

    #[test]
    fn wire_labels_are_stable_snake_case() {
        assert_eq!(FastTriageTerminalState::TypedObject.as_str(), "typed_object");
        assert_eq!(
            FastTriageTerminalState::EmptyVisible.as_str(),
            "empty_visible"
        );
        assert_eq!(FastTriageTerminalState::Malformed.as_str(), "malformed");
    }
}
