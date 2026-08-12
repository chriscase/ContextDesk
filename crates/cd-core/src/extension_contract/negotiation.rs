//! Capability negotiation profile (omit defaults, fail closed).
//!
//! Aligns with OpenAI chat contract modes, qualification ladder, embeddings,
//! reranking, reasoning-effort, and deadline dialects without claiming readiness.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Wire schema id for a negotiation profile snapshot.
pub const NEGOTIATION_SCHEMA_V1: &str = "contextdesk.extension.negotiation.v1";

/// Capability kinds that may be negotiated for a role or turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    PlainChat,
    PromptedJson,
    JsonObject,
    JsonSchema,
    JsonSchemaStrict,
    ForcedTool,
    ToolContinuation,
    Streaming,
    Cancellation,
    Embeddings,
    Reranking,
    /// Reasoning-effort dialect (omit = provider default).
    ReasoningEffort,
    /// Whole-turn deadline policy (omit = adaptive/saved default).
    Deadline,
}

impl CapabilityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PlainChat => "plain_chat",
            Self::PromptedJson => "prompted_json",
            Self::JsonObject => "json_object",
            Self::JsonSchema => "json_schema",
            Self::JsonSchemaStrict => "json_schema_strict",
            Self::ForcedTool => "forced_tool",
            Self::ToolContinuation => "tool_continuation",
            Self::Streaming => "streaming",
            Self::Cancellation => "cancellation",
            Self::Embeddings => "embeddings",
            Self::Reranking => "reranking",
            Self::ReasoningEffort => "reasoning_effort",
            Self::Deadline => "deadline",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "plain_chat" | "plain" => Some(Self::PlainChat),
            "prompted_json" => Some(Self::PromptedJson),
            "json_object" => Some(Self::JsonObject),
            "json_schema" => Some(Self::JsonSchema),
            "json_schema_strict" => Some(Self::JsonSchemaStrict),
            "forced_tool" => Some(Self::ForcedTool),
            "tool_continuation" | "auto_tools" => Some(Self::ToolContinuation),
            "streaming" | "stream" => Some(Self::Streaming),
            "cancellation" | "cancel" => Some(Self::Cancellation),
            "embeddings" | "embedding" => Some(Self::Embeddings),
            "reranking" | "rerank" => Some(Self::Reranking),
            "reasoning_effort" | "effort" => Some(Self::ReasoningEffort),
            "deadline" => Some(Self::Deadline),
            _ => None,
        }
    }

    /// OpenAI-native modes that Ollama/Anthropic must refuse on native wire.
    pub fn is_openai_native(self) -> bool {
        matches!(
            self,
            Self::JsonObject | Self::JsonSchema | Self::JsonSchemaStrict | Self::ForcedTool
        )
    }
}

/// Dialect for negotiation (secret-free).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NegotiationDialect {
    /// OpenAI-compatible Chat Completions / Responses dialects.
    #[serde(rename = "openai_compatible")]
    OpenAiCompatible,
    Ollama,
    Anthropic,
    Unknown,
}

impl NegotiationDialect {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "openai_compatible",
            Self::Ollama => "ollama",
            Self::Anthropic => "anthropic",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "openai_compatible" => Self::OpenAiCompatible,
            "ollama" => Self::Ollama,
            "anthropic" => Self::Anthropic,
            _ => Self::Unknown,
        }
    }
}

/// How a capability is requested for a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityRequest {
    /// Do not send dialect-specific fields (provider default).
    Omit,
    /// Explicitly require the capability / field.
    Require,
    /// Prefer when supported; omit when not (never invent a foreign field).
    Prefer,
}

/// One negotiated capability line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityLineV1 {
    pub kind: CapabilityKind,
    pub request: CapabilityRequest,
    /// Optional dialect-specific wire token (e.g. effort level `high`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// Negotiation profile for one role or turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NegotiationProfileV1 {
    pub schema_id: String,
    pub dialect: NegotiationDialect,
    /// Chat API surface when relevant: `chat_completions` | `responses` | `n/a`.
    #[serde(default = "default_surface")]
    pub surface: String,
    pub capabilities: Vec<CapabilityLineV1>,
}

fn default_surface() -> String {
    "chat_completions".into()
}

/// Result of applying negotiation rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NegotiationVerdict {
    /// Capability may be transmitted on this dialect/surface.
    Allowed,
    /// Omitted by policy (default / prefer unsupported).
    Omitted,
    /// Explicit require on unsupported dialect — fail closed.
    Refused {
        kind: CapabilityKind,
        reason: String,
    },
}

/// Whether a capability may be used on this dialect under the request policy.
pub fn negotiation_supports(
    dialect: NegotiationDialect,
    surface: &str,
    kind: CapabilityKind,
    request: CapabilityRequest,
) -> NegotiationVerdict {
    if matches!(request, CapabilityRequest::Omit) {
        return NegotiationVerdict::Omitted;
    }
    let supported = dialect_supports(dialect, surface, kind);
    match (request, supported) {
        (CapabilityRequest::Require, true) | (CapabilityRequest::Prefer, true) => {
            NegotiationVerdict::Allowed
        }
        (CapabilityRequest::Prefer, false) => NegotiationVerdict::Omitted,
        (CapabilityRequest::Require, false) => NegotiationVerdict::Refused {
            kind,
            reason: format!(
                "unsupported_capability:dialect={},surface={},kind={}",
                dialect.as_str(),
                surface,
                kind.as_str()
            ),
        },
        (CapabilityRequest::Omit, _) => NegotiationVerdict::Omitted,
    }
}

fn dialect_supports(dialect: NegotiationDialect, surface: &str, kind: CapabilityKind) -> bool {
    match dialect {
        NegotiationDialect::Unknown => false,
        NegotiationDialect::OpenAiCompatible => match kind {
            CapabilityKind::ReasoningEffort => {
                // Completions and Responses both document effort, with different fields.
                surface == "chat_completions" || surface == "responses"
            }
            _ => true,
        },
        NegotiationDialect::Ollama | NegotiationDialect::Anthropic => {
            // OpenAI-native modes and OpenAI effort field are not honest here.
            if kind.is_openai_native() {
                return false;
            }
            if kind == CapabilityKind::ReasoningEffort {
                return false;
            }
            // Embeddings/reranking are separate dialects; allow negotiation as
            // "capability may exist" without implying a specific model works.
            true
        }
    }
}

impl NegotiationProfileV1 {
    pub fn validate(&self) -> Result<(), super::ExtensionContractError> {
        if self.schema_id != NEGOTIATION_SCHEMA_V1 {
            return Err(super::ExtensionContractError::SchemaMismatch {
                expected: NEGOTIATION_SCHEMA_V1.into(),
                got: self.schema_id.clone(),
            });
        }
        if matches!(self.dialect, NegotiationDialect::Unknown) {
            return Err(super::ExtensionContractError::UnsupportedDialect {
                dialect: "unknown".into(),
            });
        }
        let mut seen = BTreeSet::new();
        for line in &self.capabilities {
            if !seen.insert(line.kind) {
                return Err(super::ExtensionContractError::DuplicateCapability {
                    kind: line.kind.as_str().into(),
                });
            }
            let verdict =
                negotiation_supports(self.dialect, &self.surface, line.kind, line.request);
            if let NegotiationVerdict::Refused { reason, .. } = verdict {
                return Err(super::ExtensionContractError::NegotiationRefused { reason });
            }
            // Explicit effort values must be known tokens when Require/Prefer with value.
            if line.kind == CapabilityKind::ReasoningEffort {
                if let Some(v) = &line.value {
                    let ok = matches!(
                        v.as_str(),
                        "none" | "low" | "medium" | "high" | "xhigh" | "max"
                    );
                    if !ok {
                        return Err(super::ExtensionContractError::MalformedIdentity {
                            field: "reasoning_effort".into(),
                            reason: format!("unknown level `{v}` (no silent clamp)"),
                        });
                    }
                }
            }
        }
        Ok(())
    }
}
