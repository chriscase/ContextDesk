//! OpenAI-compatible chat request contract (typed modes + pure body builder).
//!
//! Production [`crate::chat::OpenAiCompatibleClient`] and capability
//! qualification share this module so `response_format`, forced tools, and
//! channel separation are not ad-hoc per host.
//!
//! ## Modes
//!
//! - [`OpenAiChatRequestMode::Plain`] — default chat; optional tools use
//!   `tool_choice: "auto"`.
//! - [`OpenAiChatRequestMode::JsonObject`] — `response_format.type = json_object`.
//! - [`OpenAiChatRequestMode::JsonSchema`] — `response_format.type = json_schema`.
//! - [`OpenAiChatRequestMode::ForcedTool`] — `tool_choice` forces one function.
//!
//! Qualification never passes structured-output from a model name hint, and
//! never silently downgrades a typed mode mid-turn when the gateway rejects it.

use crate::chat::{tools_to_openai, ChatMessage};
use crate::tools::ToolSpec;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Stable wire/evidence id for a chat request mode (secret-free).
pub const MODE_PLAIN: &str = "plain";
/// JSON object response_format mode.
pub const MODE_JSON_OBJECT: &str = "json_object";
/// JSON schema response_format mode.
pub const MODE_JSON_SCHEMA: &str = "json_schema";
/// Forced tool_choice mode.
pub const MODE_FORCED_TOOL: &str = "forced_tool";

/// Typed OpenAI-compatible chat request mode.
///
/// Hosts pick a mode intentionally. Qualification records the mode that was
/// measured; production chat defaults to [`Self::Plain`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenAiChatRequestMode {
    /// Ordinary completion. Tools (if any) use `tool_choice: "auto"`.
    #[default]
    Plain,
    /// Request a JSON object via `response_format: { "type": "json_object" }`.
    JsonObject,
    /// Request structured JSON via `response_format.json_schema`.
    JsonSchema {
        /// Schema name advertised to the provider (not a secret).
        name: String,
        /// JSON Schema object (as JSON value).
        schema: Value,
        /// When true, request strict schema adherence when the gateway supports it.
        #[serde(default)]
        strict: bool,
    },
    /// Force the model to call one named tool.
    ForcedTool {
        /// Function name that must appear in `tools` and `tool_choice`.
        name: String,
    },
}

impl OpenAiChatRequestMode {
    /// Stable evidence / log id for this mode (no schema body).
    pub fn evidence_id(&self) -> &'static str {
        match self {
            Self::Plain => MODE_PLAIN,
            Self::JsonObject => MODE_JSON_OBJECT,
            Self::JsonSchema { .. } => MODE_JSON_SCHEMA,
            Self::ForcedTool { .. } => MODE_FORCED_TOOL,
        }
    }

    /// True when this mode requests structured JSON via `response_format`.
    pub fn requests_json_response_format(&self) -> bool {
        matches!(self, Self::JsonObject | Self::JsonSchema { .. })
    }
}

/// Build the OpenAI chat/completions JSON body (pure; no I/O).
///
/// `tools` is applied when non-empty. Forced-tool mode requires the named tool
/// to be present in `tools`; otherwise the body still emits `tool_choice` so
/// misconfiguration is visible on the wire rather than silently dropped.
pub fn build_openai_chat_request_body(
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolSpec]>,
    stream: bool,
    mode: &OpenAiChatRequestMode,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": stream,
    });

    let tools_nonempty = tools.map(|t| !t.is_empty()).unwrap_or(false);
    if tools_nonempty {
        if let Some(specs) = tools {
            body["tools"] = tools_to_openai(specs);
        }
    }

    match mode {
        OpenAiChatRequestMode::Plain => {
            if tools_nonempty {
                body["tool_choice"] = json!("auto");
            }
        }
        OpenAiChatRequestMode::JsonObject => {
            body["response_format"] = json!({ "type": "json_object" });
            // OpenAI allows tools + json_object on some gateways; keep tools if offered.
            if tools_nonempty {
                body["tool_choice"] = json!("auto");
            }
        }
        OpenAiChatRequestMode::JsonSchema {
            name,
            schema,
            strict,
        } => {
            body["response_format"] = json!({
                "type": "json_schema",
                "json_schema": {
                    "name": name,
                    "schema": schema,
                    "strict": strict,
                }
            });
            if tools_nonempty {
                body["tool_choice"] = json!("auto");
            }
        }
        OpenAiChatRequestMode::ForcedTool { name } => {
            body["tool_choice"] = json!({
                "type": "function",
                "function": { "name": name }
            });
            // Forced tool without a tools array is a caller error; still emit
            // tool_choice so the failure is explicit on the gateway.
        }
    }

    body
}

/// Content vs reasoning channels extracted from an OpenAI message object.
///
/// ContextDesk never treats reasoning as assistant success text. Structured
/// probes and user-visible answers use [`Self::content`] only.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OpenAiMessageChannels {
    /// Primary assistant content channel.
    pub content: String,
    /// Provider reasoning / thinking channel when present (never success).
    pub reasoning_content: String,
}

/// Extract content and reasoning from a completion `message` object.
///
/// Known reasoning fields (`reasoning_content`, `reasoning`) are collected
/// into the reasoning channel and **never** copied into content.
pub fn extract_openai_message_channels(message: &Value) -> OpenAiMessageChannels {
    let content = message
        .get("content")
        .and_then(|c| {
            if c.is_null() {
                None
            } else {
                c.as_str().map(str::to_string)
            }
        })
        .unwrap_or_default();

    let mut reasoning = String::new();
    for key in ["reasoning_content", "reasoning"] {
        if let Some(text) = message.get(key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                if !reasoning.is_empty() {
                    reasoning.push('\n');
                }
                reasoning.push_str(text);
            }
        }
    }

    OpenAiMessageChannels {
        content,
        reasoning_content: reasoning,
    }
}

/// Whether structured-output success may be claimed from these channels.
///
/// Reasoning-only JSON is **not** success. Empty content is not success.
pub fn structured_content_eligible(channels: &OpenAiMessageChannels) -> bool {
    !channels.content.trim().is_empty()
}

/// Parse a JSON object from the content channel only (never from reasoning).
pub fn parse_structured_json_from_content(
    channels: &OpenAiMessageChannels,
) -> Result<Value, String> {
    if !structured_content_eligible(channels) {
        if !channels.reasoning_content.trim().is_empty() {
            return Err("reasoning_channel_only_not_success".into());
        }
        return Err("empty_content_channel".into());
    }
    serde_json::from_str(channels.content.trim()).map_err(|e| format!("content_not_json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::{ChatMessage, Role};
    use crate::tools::{ToolSideEffect, ToolSpec};

    fn user_msg(text: &str) -> ChatMessage {
        ChatMessage {
            role: Role::User,
            content: text.into(),
            tool_call_id: None,
            tool_calls: None,
        }
    }

    fn echo_tool() -> ToolSpec {
        ToolSpec {
            name: "cd_qualify_echo".into(),
            description: "inert".into(),
            side_effect: ToolSideEffect::Read,
            parameters: json!({"type": "object", "properties": {}}),
        }
    }

    #[test]
    fn plain_body_has_no_response_format() {
        let body = build_openai_chat_request_body(
            "m",
            &[user_msg("hi")],
            None,
            false,
            &OpenAiChatRequestMode::Plain,
        );
        assert_eq!(body["model"], "m");
        assert_eq!(body["stream"], false);
        assert!(body.get("response_format").is_none());
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn plain_with_tools_uses_auto_tool_choice() {
        let tools = [echo_tool()];
        let body = build_openai_chat_request_body(
            "m",
            &[user_msg("hi")],
            Some(&tools),
            false,
            &OpenAiChatRequestMode::Plain,
        );
        assert_eq!(body["tool_choice"], "auto");
        assert!(body["tools"].as_array().unwrap().len() == 1);
    }

    #[test]
    fn json_object_mode_sets_response_format() {
        let body = build_openai_chat_request_body(
            "m",
            &[user_msg("hi")],
            None,
            false,
            &OpenAiChatRequestMode::JsonObject,
        );
        assert_eq!(body["response_format"]["type"], "json_object");
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn json_schema_mode_embeds_name_and_schema() {
        let schema = json!({"type": "object", "properties": {"qualify": {"type": "string"}}});
        let body = build_openai_chat_request_body(
            "m",
            &[user_msg("hi")],
            None,
            true,
            &OpenAiChatRequestMode::JsonSchema {
                name: "qualify_v1".into(),
                schema: schema.clone(),
                strict: true,
            },
        );
        assert_eq!(body["stream"], true);
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["response_format"]["json_schema"]["name"], "qualify_v1");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        assert_eq!(body["response_format"]["json_schema"]["schema"], schema);
    }

    #[test]
    fn forced_tool_mode_sets_tool_choice_function() {
        let tools = [echo_tool()];
        let body = build_openai_chat_request_body(
            "m",
            &[user_msg("hi")],
            Some(&tools),
            false,
            &OpenAiChatRequestMode::ForcedTool {
                name: "cd_qualify_echo".into(),
            },
        );
        assert_eq!(body["tool_choice"]["type"], "function");
        assert_eq!(body["tool_choice"]["function"]["name"], "cd_qualify_echo");
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn extract_channels_keeps_reasoning_out_of_content() {
        let message = json!({
            "role": "assistant",
            "content": "{\"qualify\":\"ok\"}",
            "reasoning_content": "I should output JSON now"
        });
        let ch = extract_openai_message_channels(&message);
        assert_eq!(ch.content, "{\"qualify\":\"ok\"}");
        assert!(ch.reasoning_content.contains("I should output JSON"));
        assert!(!ch.content.contains("I should output"));
    }

    #[test]
    fn reasoning_only_is_not_structured_success() {
        let ch = OpenAiMessageChannels {
            content: String::new(),
            reasoning_content: r#"{"qualify":"ok","v":1}"#.into(),
        };
        assert!(!structured_content_eligible(&ch));
        let err = parse_structured_json_from_content(&ch).unwrap_err();
        assert_eq!(err, "reasoning_channel_only_not_success");
    }

    #[test]
    fn content_json_is_structured_success() {
        let ch = OpenAiMessageChannels {
            content: r#"{"qualify":"ok","v":1}"#.into(),
            reasoning_content: "internal monologue".into(),
        };
        let v = parse_structured_json_from_content(&ch).unwrap();
        assert_eq!(v["qualify"], "ok");
    }

    #[test]
    fn mode_evidence_ids_are_stable() {
        assert_eq!(OpenAiChatRequestMode::Plain.evidence_id(), "plain");
        assert_eq!(
            OpenAiChatRequestMode::JsonObject.evidence_id(),
            "json_object"
        );
        assert_eq!(
            OpenAiChatRequestMode::ForcedTool { name: "x".into() }.evidence_id(),
            "forced_tool"
        );
    }
}
