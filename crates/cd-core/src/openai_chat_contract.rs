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
/// Prompted JSON over plain chat (no response_format on the wire).
pub const MODE_PROMPTED_JSON: &str = "prompted_json";
/// JSON object response_format mode (OpenAI-native).
pub const MODE_JSON_OBJECT: &str = "json_object";
/// JSON schema response_format mode (non-strict).
pub const MODE_JSON_SCHEMA: &str = "json_schema";
/// JSON schema response_format mode with strict=true.
pub const MODE_JSON_SCHEMA_STRICT: &str = "json_schema_strict";
/// Automatic tool_choice mode (tools present + auto).
pub const MODE_AUTO_TOOLS: &str = "auto_tools";
/// Forced tool_choice mode.
pub const MODE_FORCED_TOOL: &str = "forced_tool";

/// Dialect identity for the live chat backend (secret-free, no endpoints).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatBackendDialect {
    /// OpenAI-compatible `/v1/chat/completions`.
    OpenAiCompatible,
    /// Ollama native `/api/chat`.
    Ollama,
    /// Anthropic Messages API.
    Anthropic,
}

impl ChatBackendDialect {
    /// Stable wire/evidence id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "openai_compatible",
            Self::Ollama => "ollama",
            Self::Anthropic => "anthropic",
        }
    }

    /// Whether this dialect can transmit OpenAI-native request modes on the wire.
    pub fn supports_openai_native_modes(self) -> bool {
        matches!(self, Self::OpenAiCompatible)
    }
}

/// Typed OpenAI-compatible chat request mode.
///
/// Hosts pick a mode intentionally. Qualification records the mode that was
/// measured; production chat defaults to [`Self::Plain`].
///
/// [`Self::PromptedJson`] is **not** native structured output: the body is the
/// same as plain chat; only the synthetic prompt asks for JSON. It must never
/// be recorded as `json_object`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenAiChatRequestMode {
    /// Ordinary completion. Tools (if any) use `tool_choice: "auto"`.
    #[default]
    Plain,
    /// Plain wire body + instruction to reply with JSON (prompted only).
    PromptedJson,
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
            Self::PromptedJson => MODE_PROMPTED_JSON,
            Self::JsonObject => MODE_JSON_OBJECT,
            Self::JsonSchema { strict: true, .. } => MODE_JSON_SCHEMA_STRICT,
            Self::JsonSchema { strict: false, .. } => MODE_JSON_SCHEMA,
            Self::ForcedTool { .. } => MODE_FORCED_TOOL,
        }
    }

    /// True when this mode requires OpenAI-native wire fields (`response_format`
    /// or forced `tool_choice` function object).
    pub fn is_openai_native(&self) -> bool {
        matches!(
            self,
            Self::JsonObject | Self::JsonSchema { .. } | Self::ForcedTool { .. }
        )
    }

    /// True when this mode requests structured JSON via `response_format`.
    pub fn requests_json_response_format(&self) -> bool {
        matches!(self, Self::JsonObject | Self::JsonSchema { .. })
    }

    /// Schema probe name when this is a json_schema mode (never the schema body).
    pub fn schema_probe_id(&self) -> Option<&str> {
        match self {
            Self::JsonSchema { name, .. } => Some(name.as_str()),
            _ => None,
        }
    }

    /// Strictness flag for json_schema modes only.
    pub fn schema_strict(&self) -> Option<bool> {
        match self {
            Self::JsonSchema { strict, .. } => Some(*strict),
            _ => None,
        }
    }
}

/// Whether a dialect may transmit the given mode. OpenAI-native modes are only
/// honest on the OpenAI-compatible dialect.
pub fn dialect_supports_mode(dialect: ChatBackendDialect, mode: &OpenAiChatRequestMode) -> bool {
    if mode.is_openai_native() {
        dialect.supports_openai_native_modes()
    } else {
        true
    }
}

/// Stable unsupported-mode reason (secret-free) for transports and probes.
pub fn unsupported_mode_reason(
    dialect: ChatBackendDialect,
    mode: &OpenAiChatRequestMode,
) -> String {
    format!(
        "unsupported_request_mode:dialect={},mode={}",
        dialect.as_str(),
        mode.evidence_id()
    )
}

/// Extract dialect id from a transport error reason when it is an unsupported-mode refusal.
///
/// Used so probe evidence records typed `dialect` on refuse paths, not only a reason string.
pub fn dialect_from_transport_reason(reason: &str) -> Option<&'static str> {
    fn map_dialect(dialect: &str) -> Option<&'static str> {
        match dialect.trim() {
            "openai_compatible" => Some("openai_compatible"),
            "ollama" => Some("ollama"),
            "anthropic" => Some("anthropic"),
            _ => None,
        }
    }
    // Prefer structured token from unsupported_mode_reason.
    if let Some(rest) = reason.strip_prefix("unsupported_request_mode:dialect=") {
        let dialect = rest.split(',').next().unwrap_or(rest);
        return map_dialect(dialect);
    }
    // Fallback: reason embeds dialect=… anywhere (e.g. "mode=json_object: … dialect=ollama").
    // Split on the ASCII marker without byte-index slicing untrusted UTF-8.
    if let Some((_, after)) = reason.split_once("dialect=") {
        let dialect = after.split([',', ' ', ':']).next().unwrap_or("");
        return map_dialect(dialect);
    }
    None
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
        // PromptedJson is intentionally identical on the wire to Plain: only
        // the user message content differs. Never emit response_format.
        OpenAiChatRequestMode::Plain | OpenAiChatRequestMode::PromptedJson => {
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

/// Synthetic schema used by qualification json_schema probes (name only is
/// recorded in evidence; never export the body from DTOs as a secret surface).
pub fn synth_qualify_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "qualify": { "type": "string" },
            "v": { "type": "integer" }
        },
        "required": ["qualify", "v"],
        "additionalProperties": false
    })
}

/// Schema probe id recorded on evidence (not a schema body).
pub const SYNTH_SCHEMA_PROBE_ID: &str = "qualify_v1";

/// Validate synthetic structured content against the qualify contract.
pub fn validate_synth_qualify_json(value: &Value) -> Result<(), String> {
    let qualify = value
        .get("qualify")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "missing_qualify_field".to_string())?;
    if qualify != "ok" {
        return Err("qualify_field_not_ok".into());
    }
    match value.get("v") {
        Some(v) if v.as_i64() == Some(1) || v.as_u64() == Some(1) => Ok(()),
        Some(_) => Err("v_field_not_1".into()),
        None => Err("missing_v_field".into()),
    }
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
            OpenAiChatRequestMode::PromptedJson.evidence_id(),
            "prompted_json"
        );
        assert_eq!(
            OpenAiChatRequestMode::JsonObject.evidence_id(),
            "json_object"
        );
        assert_eq!(
            OpenAiChatRequestMode::JsonSchema {
                name: "qualify_v1".into(),
                schema: json!({}),
                strict: false,
            }
            .evidence_id(),
            "json_schema"
        );
        assert_eq!(
            OpenAiChatRequestMode::JsonSchema {
                name: "qualify_v1".into(),
                schema: json!({}),
                strict: true,
            }
            .evidence_id(),
            "json_schema_strict"
        );
        assert_eq!(
            OpenAiChatRequestMode::ForcedTool { name: "x".into() }.evidence_id(),
            "forced_tool"
        );
        assert!(OpenAiChatRequestMode::JsonObject.is_openai_native());
        assert!(!OpenAiChatRequestMode::PromptedJson.is_openai_native());
        assert!(!dialect_supports_mode(
            ChatBackendDialect::Ollama,
            &OpenAiChatRequestMode::JsonObject
        ));
        assert!(dialect_supports_mode(
            ChatBackendDialect::Ollama,
            &OpenAiChatRequestMode::PromptedJson
        ));
        assert!(!dialect_supports_mode(
            ChatBackendDialect::Anthropic,
            &OpenAiChatRequestMode::JsonObject
        ));
        assert!(!dialect_supports_mode(
            ChatBackendDialect::Anthropic,
            &OpenAiChatRequestMode::JsonSchema {
                name: "q".into(),
                schema: json!({}),
                strict: true,
            }
        ));
        assert!(!dialect_supports_mode(
            ChatBackendDialect::Anthropic,
            &OpenAiChatRequestMode::ForcedTool {
                name: "cd_qualify_echo".into()
            }
        ));
        assert!(dialect_supports_mode(
            ChatBackendDialect::Anthropic,
            &OpenAiChatRequestMode::PromptedJson
        ));
        let refuse = unsupported_mode_reason(
            ChatBackendDialect::Anthropic,
            &OpenAiChatRequestMode::JsonObject,
        );
        assert_eq!(
            dialect_from_transport_reason(&refuse),
            Some("anthropic")
        );
        assert_eq!(
            dialect_from_transport_reason(&format!("mode=json_object: {refuse}")),
            Some("anthropic")
        );
        assert_eq!(
            dialect_from_transport_reason("unrelated error"),
            None
        );
    }

    #[test]
    fn prompted_json_body_has_no_response_format() {
        let body = build_openai_chat_request_body(
            "m",
            &[user_msg(r#"Reply JSON {"qualify":"ok","v":1}"#)],
            None,
            false,
            &OpenAiChatRequestMode::PromptedJson,
        );
        assert!(body.get("response_format").is_none());
        assert_ne!(
            OpenAiChatRequestMode::PromptedJson.evidence_id(),
            MODE_JSON_OBJECT
        );
    }
}
