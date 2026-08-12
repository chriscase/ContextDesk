//! Provider-neutral reasoning-effort contract (qualified, opt-in, hermetic).
//!
#![allow(missing_docs)] // Wire/DTO field names are the external contract.
//!
//! # Product rules
//!
//! * Levels: `none` / `low` / `medium` / `high` / `xhigh` / `max` form a
//!   provider-neutral request vocabulary. Exact support is **model + gateway +
//!   API-surface specific**, never inferred from a model name or URL.
//! * **Default is omission** (provider default). Selecting no effort never
//!   invents a field on the request body.
//! * Chat Completions and Responses **do not** share one wire field. Mapping is
//!   table-driven per [`ChatApiSurface`].
//! * Unsupported/unknown dialects: **omit** when policy is omit; **fail closed**
//!   with a typed reason when an explicit level is requested (no silent leakage
//!   of a foreign field). OpenAI-compatible transports send the exact explicit
//!   token and preserve a provider refusal; they do not claim the target model
//!   honors every token in this vocabulary.
//! * Effort is **not** a readiness badge; it affects cost/latency only.
//!
//! Precedence for the effective policy on one turn:
//!
//! 1. Per-turn CLI/GUI override (never persisted)
//! 2. Saved AppConfig policy
//! 3. Omit (provider default)

use crate::openai_chat_contract::ChatBackendDialect;
use crate::providers::ProviderKind;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;

/// Schema id for effort status/telemetry records.
pub const REASONING_EFFORT_SCHEMA_V1: &str = "contextdesk.reasoning_effort.v1";

/// Documented effort levels (product vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffortLevel {
    /// Explicitly request no extra reasoning when the exact target accepts `none`.
    None,
    Low,
    Medium,
    High,
    /// Extended high, where the exact target accepts `xhigh`.
    XHigh,
    /// Maximum effort, where the exact target accepts `max`.
    Max,
}

impl ReasoningEffortLevel {
    /// Stable wire / config token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::XHigh => "xhigh",
            Self::Max => "max",
        }
    }

    /// All levels in stable display order.
    pub fn all() -> &'static [Self] {
        &[
            Self::None,
            Self::Low,
            Self::Medium,
            Self::High,
            Self::XHigh,
            Self::Max,
        ]
    }

    /// Parse a level token (case-insensitive). Rejects unknowns without clamping.
    pub fn parse(raw: &str) -> Result<Self, ReasoningEffortParseError> {
        let t = raw.trim();
        if t.is_empty() {
            return Err(ReasoningEffortParseError::Empty);
        }
        match t.to_ascii_lowercase().as_str() {
            "none" => Ok(Self::None),
            "low" => Ok(Self::Low),
            "medium" | "med" => Ok(Self::Medium),
            "high" => Ok(Self::High),
            "xhigh" | "x-high" | "extra_high" | "extra-high" => Ok(Self::XHigh),
            "max" | "maximum" => Ok(Self::Max),
            _ => Err(ReasoningEffortParseError::UnknownLevel { raw: t.to_string() }),
        }
    }
}

impl fmt::Display for ReasoningEffortLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why effort input was rejected (no silent clamp).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasoningEffortParseError {
    /// Empty or whitespace-only.
    Empty,
    /// Token is not a known level.
    UnknownLevel {
        /// Original token (bounded).
        raw: String,
    },
}

impl fmt::Display for ReasoningEffortParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "reasoning effort is empty"),
            Self::UnknownLevel { raw } => write!(
                f,
                "reasoning effort `{raw}` is not supported; use none, low, medium, high, xhigh, or max \
                 (or omit the flag for the provider default)"
            ),
        }
    }
}

impl std::error::Error for ReasoningEffortParseError {}

/// API surface that owns the effort wire shape (never conflated).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatApiSurface {
    /// OpenAI-compatible `/v1/chat/completions` (and clones).
    ChatCompletions,
    /// OpenAI Responses API (`/v1/responses`). Distinct field layout.
    Responses,
}

impl ChatApiSurface {
    /// Stable id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChatCompletions => "chat_completions",
            Self::Responses => "responses",
        }
    }
}

/// Durable AppConfig settings. `None` means omit (provider default).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningEffortSettings {
    /// Explicit level when set; omit when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<ReasoningEffortLevel>,
}

impl ReasoningEffortSettings {
    /// Product-facing policy mode.
    pub fn is_omit(&self) -> bool {
        self.level.is_none()
    }

    /// Apply omit policy (clears explicit level).
    pub fn apply_omit(&mut self) {
        self.level = None;
    }

    /// Apply an explicit level (no silent rewrite of unrelated config fields).
    pub fn apply_level(&mut self, level: ReasoningEffortLevel) {
        self.level = Some(level);
    }
}

/// Effective policy after precedence resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EffectiveEffortPolicy {
    /// Do not send an effort field.
    Omit,
    /// Request this exact level without silent downgrade.
    Explicit(ReasoningEffortLevel),
}

impl EffectiveEffortPolicy {
    /// Stable label for telemetry (`omit` or level token).
    pub fn as_label(self) -> &'static str {
        match self {
            Self::Omit => "omit",
            Self::Explicit(level) => level.as_str(),
        }
    }

    /// Level when explicit.
    pub fn level(self) -> Option<ReasoningEffortLevel> {
        match self {
            Self::Omit => None,
            Self::Explicit(level) => Some(level),
        }
    }
}

/// Resolve effective policy: per-turn override → saved → omit.
pub fn resolve_effort_policy(
    turn_override: Option<ReasoningEffortLevel>,
    saved: &ReasoningEffortSettings,
) -> EffectiveEffortPolicy {
    if let Some(level) = turn_override {
        return EffectiveEffortPolicy::Explicit(level);
    }
    match saved.level {
        Some(level) => EffectiveEffortPolicy::Explicit(level),
        None => EffectiveEffortPolicy::Omit,
    }
}

/// Typed reason effort could not be applied on this dialect/surface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffortApplyError {
    /// Dialect does not document effort on this surface.
    UnsupportedDialect {
        dialect: String,
        surface: String,
        requested: String,
    },
    /// Level cannot be represented by this dialect/surface (no silent clamp).
    UnsupportedLevel {
        dialect: String,
        surface: String,
        requested: String,
        allowed: Vec<String>,
    },
}

impl fmt::Display for ReasoningEffortApplyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedDialect {
                dialect,
                surface,
                requested,
            } => write!(
                f,
                "reasoning_effort_unsupported:dialect={dialect},surface={surface},requested={requested}"
            ),
            Self::UnsupportedLevel {
                dialect,
                surface,
                requested,
                allowed,
            } => write!(
                f,
                "reasoning_effort_unsupported_level:dialect={dialect},surface={surface},requested={requested},allowed={}",
                allowed.join("|")
            ),
        }
    }
}

impl std::error::Error for ReasoningEffortApplyError {}

/// Share-safe outcome of applying effort to a request body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct EffortApplyTelemetry {
    /// Schema marker.
    pub schema: &'static str,
    /// Policy before dialect mapping (`omit` or level).
    pub requested: String,
    /// Exact request value put on the wire (`omit` or level). This does not
    /// claim the remote model honored the value.
    pub effective: String,
    /// Dialect id (secret-free).
    pub dialect: String,
    /// API surface id.
    pub surface: String,
    /// Documented wire path when a field was set (e.g. `reasoning_effort`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wire_field: Option<String>,
}

/// Exact tokens this transport shape can represent.
///
/// This is deliberately **not** a model capability claim. An
/// OpenAI-compatible gateway may accept only a subset (or none) for a selected
/// model. ContextDesk sends an explicit token unchanged and surfaces refusal;
/// qualification/live evidence owns any stronger exact-target claim.
/// Empty means the dialect has no implemented effort wire mapping.
pub fn transport_candidate_levels(
    dialect: ChatBackendDialect,
    surface: ChatApiSurface,
) -> &'static [ReasoningEffortLevel] {
    match (dialect, surface) {
        // OpenAI Chat Completions: top-level `reasoning_effort`. The supported
        // subset varies by exact model and gateway, so this transport layer
        // must not hard-code a smaller model-family set.
        (ChatBackendDialect::OpenAiCompatible, ChatApiSurface::ChatCompletions) => &[
            ReasoningEffortLevel::None,
            ReasoningEffortLevel::Low,
            ReasoningEffortLevel::Medium,
            ReasoningEffortLevel::High,
            ReasoningEffortLevel::XHigh,
            ReasoningEffortLevel::Max,
        ],
        // OpenAI Responses: nested `reasoning.effort`. Exact model support is
        // still narrower for some models; refusal remains typed provider
        // evidence rather than a silent clamp.
        (ChatBackendDialect::OpenAiCompatible, ChatApiSurface::Responses) => &[
            ReasoningEffortLevel::None,
            ReasoningEffortLevel::Low,
            ReasoningEffortLevel::Medium,
            ReasoningEffortLevel::High,
            ReasoningEffortLevel::XHigh,
            ReasoningEffortLevel::Max,
        ],
        // Ollama / Anthropic: no OpenAI effort field — omit-only.
        (ChatBackendDialect::Ollama | ChatBackendDialect::Anthropic, _) => &[],
    }
}

/// Map provider kind to chat dialect for effort application.
pub fn dialect_from_provider_kind(kind: ProviderKind) -> ChatBackendDialect {
    match kind {
        ProviderKind::Ollama => ChatBackendDialect::Ollama,
        ProviderKind::Anthropic => ChatBackendDialect::Anthropic,
        ProviderKind::OpenAiCompatible | ProviderKind::XaiGrokBuild => {
            ChatBackendDialect::OpenAiCompatible
        }
    }
}

/// Apply effort to a chat request JSON body (pure; no I/O).
///
/// When policy is [`EffectiveEffortPolicy::Omit`], the body is left unchanged
/// and no effort-shaped keys are introduced. When explicit, only the
/// dialect-owned field is set — never a foreign field name. A successful body
/// build proves only exact transmission intent, not that the selected model
/// supports or honors the value.
pub fn apply_reasoning_effort_to_body(
    body: &mut Value,
    dialect: ChatBackendDialect,
    surface: ChatApiSurface,
    policy: EffectiveEffortPolicy,
) -> Result<EffortApplyTelemetry, ReasoningEffortApplyError> {
    let dialect_s = dialect.as_str().to_string();
    let surface_s = surface.as_str().to_string();
    let requested = policy.as_label().to_string();

    match policy {
        EffectiveEffortPolicy::Omit => Ok(EffortApplyTelemetry {
            schema: REASONING_EFFORT_SCHEMA_V1,
            requested,
            effective: "omit".into(),
            dialect: dialect_s,
            surface: surface_s,
            wire_field: None,
        }),
        EffectiveEffortPolicy::Explicit(level) => {
            let allowed = transport_candidate_levels(dialect, surface);
            if allowed.is_empty() {
                return Err(ReasoningEffortApplyError::UnsupportedDialect {
                    dialect: dialect_s,
                    surface: surface_s,
                    requested: level.as_str().into(),
                });
            }
            if !allowed.contains(&level) {
                return Err(ReasoningEffortApplyError::UnsupportedLevel {
                    dialect: dialect_s,
                    surface: surface_s,
                    requested: level.as_str().into(),
                    allowed: allowed.iter().map(|l| l.as_str().to_string()).collect(),
                });
            }
            let wire_field = match (dialect, surface) {
                (ChatBackendDialect::OpenAiCompatible, ChatApiSurface::ChatCompletions) => {
                    // Documented Completions field — not the Responses nest.
                    body["reasoning_effort"] = json!(level.as_str());
                    "reasoning_effort"
                }
                (ChatBackendDialect::OpenAiCompatible, ChatApiSurface::Responses) => {
                    // Documented Responses nest — not top-level reasoning_effort.
                    if !body
                        .get("reasoning")
                        .map(|v| v.is_object())
                        .unwrap_or(false)
                    {
                        body["reasoning"] = json!({});
                    }
                    body["reasoning"]["effort"] = json!(level.as_str());
                    "reasoning.effort"
                }
                _ => {
                    return Err(ReasoningEffortApplyError::UnsupportedDialect {
                        dialect: dialect_s,
                        surface: surface_s,
                        requested: level.as_str().into(),
                    });
                }
            };
            Ok(EffortApplyTelemetry {
                schema: REASONING_EFFORT_SCHEMA_V1,
                requested,
                effective: level.as_str().into(),
                dialect: dialect.as_str().into(),
                surface: surface.as_str().into(),
                wire_field: Some(wire_field.into()),
            })
        }
    }
}

/// True when the body contains any effort-shaped key we know about.
///
/// Used by mutation tests to prove omit leaves bodies free of leakage.
pub fn body_has_effort_field(body: &Value) -> bool {
    if body.get("reasoning_effort").is_some() {
        return true;
    }
    body.get("reasoning")
        .and_then(|r| r.get("effort"))
        .is_some()
}

/// Status DTO for CLI/GUI show (share-safe).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasoningEffortStatus {
    pub schema: &'static str,
    /// `omit` or level token for the saved policy.
    pub policy: String,
    /// Saved level when explicit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// Human note.
    pub note: String,
}

/// Build status from saved settings.
pub fn effort_status(settings: &ReasoningEffortSettings) -> ReasoningEffortStatus {
    match settings.level {
        None => ReasoningEffortStatus {
            schema: REASONING_EFFORT_SCHEMA_V1,
            policy: "omit".into(),
            level: None,
            note: "provider default (no reasoning_effort field on the wire); not a readiness badge"
                .into(),
        },
        Some(level) => ReasoningEffortStatus {
            schema: REASONING_EFFORT_SCHEMA_V1,
            policy: "explicit".into(),
            level: Some(level.as_str().into()),
            note: "explicit effort affects cost and latency; not a readiness badge".into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openai_chat_contract::build_openai_chat_request_body;
    use crate::openai_chat_contract::OpenAiChatRequestMode;

    #[test]
    fn parse_accepts_all_levels_rejects_unknown_without_clamp() {
        assert_eq!(
            ReasoningEffortLevel::parse("high").unwrap(),
            ReasoningEffortLevel::High
        );
        assert_eq!(
            ReasoningEffortLevel::parse("XHIGH").unwrap(),
            ReasoningEffortLevel::XHigh
        );
        assert!(matches!(
            ReasoningEffortLevel::parse("ultra"),
            Err(ReasoningEffortParseError::UnknownLevel { .. })
        ));
        assert!(matches!(
            ReasoningEffortLevel::parse(""),
            Err(ReasoningEffortParseError::Empty)
        ));
        // No silent clamp of "higher" → high
        assert!(ReasoningEffortLevel::parse("higher").is_err());
    }

    #[test]
    fn precedence_override_beats_saved_beats_omit() {
        let mut saved = ReasoningEffortSettings::default();
        assert_eq!(
            resolve_effort_policy(None, &saved),
            EffectiveEffortPolicy::Omit
        );
        saved.apply_level(ReasoningEffortLevel::Medium);
        assert_eq!(
            resolve_effort_policy(None, &saved),
            EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Medium)
        );
        assert_eq!(
            resolve_effort_policy(Some(ReasoningEffortLevel::Low), &saved),
            EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Low)
        );
    }

    #[test]
    fn omit_leaves_chat_completions_body_without_effort_field() {
        let mut body =
            build_openai_chat_request_body("m", &[], None, false, &OpenAiChatRequestMode::Plain);
        let tel = apply_reasoning_effort_to_body(
            &mut body,
            ChatBackendDialect::OpenAiCompatible,
            ChatApiSurface::ChatCompletions,
            EffectiveEffortPolicy::Omit,
        )
        .unwrap();
        assert_eq!(tel.effective, "omit");
        assert!(!body_has_effort_field(&body));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn chat_completions_emits_only_reasoning_effort_field() {
        let mut body = json!({"model": "m", "messages": []});
        let tel = apply_reasoning_effort_to_body(
            &mut body,
            ChatBackendDialect::OpenAiCompatible,
            ChatApiSurface::ChatCompletions,
            EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::High),
        )
        .unwrap();
        assert_eq!(tel.wire_field.as_deref(), Some("reasoning_effort"));
        assert_eq!(body["reasoning_effort"], json!("high"));
        // Must not invent Responses nest on Completions.
        assert!(body
            .get("reasoning")
            .and_then(|r| r.get("effort"))
            .is_none());
    }

    #[test]
    fn responses_emits_nested_reasoning_effort_not_top_level() {
        let mut body = json!({"model": "m"});
        let tel = apply_reasoning_effort_to_body(
            &mut body,
            ChatBackendDialect::OpenAiCompatible,
            ChatApiSurface::Responses,
            EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::XHigh),
        )
        .unwrap();
        assert_eq!(tel.wire_field.as_deref(), Some("reasoning.effort"));
        assert_eq!(body["reasoning"]["effort"], json!("xhigh"));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn completions_transmits_xhigh_exactly_without_silent_clamp() {
        let mut body = json!({});
        let tel = apply_reasoning_effort_to_body(
            &mut body,
            ChatBackendDialect::OpenAiCompatible,
            ChatApiSurface::ChatCompletions,
            EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::XHigh),
        )
        .unwrap();
        assert_eq!(tel.requested, "xhigh");
        assert_eq!(tel.effective, "xhigh");
        assert_eq!(body["reasoning_effort"], json!("xhigh"));
    }

    #[test]
    fn ollama_explicit_fails_closed_without_field_leakage() {
        let mut body = json!({"model": "m"});
        let err = apply_reasoning_effort_to_body(
            &mut body,
            ChatBackendDialect::Ollama,
            ChatApiSurface::ChatCompletions,
            EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Medium),
        )
        .unwrap_err();
        assert!(matches!(
            err,
            ReasoningEffortApplyError::UnsupportedDialect { .. }
        ));
        assert!(!body_has_effort_field(&body));
        // Omit still ok
        apply_reasoning_effort_to_body(
            &mut body,
            ChatBackendDialect::Ollama,
            ChatApiSurface::ChatCompletions,
            EffectiveEffortPolicy::Omit,
        )
        .unwrap();
        assert!(!body_has_effort_field(&body));
    }

    #[test]
    fn anthropic_explicit_fails_closed() {
        let mut body = json!({});
        let err = apply_reasoning_effort_to_body(
            &mut body,
            ChatBackendDialect::Anthropic,
            ChatApiSurface::ChatCompletions,
            EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Low),
        )
        .unwrap_err();
        assert!(matches!(
            err,
            ReasoningEffortApplyError::UnsupportedDialect { .. }
        ));
    }

    #[test]
    fn saved_settings_roundtrip_preserves_omit_and_level() {
        let omit = ReasoningEffortSettings::default();
        let s = serde_json::to_string(&omit).unwrap();
        assert!(!s.contains("level") || s == "{}");
        let back: ReasoningEffortSettings = serde_json::from_str("{}").unwrap();
        assert!(back.is_omit());

        let mut explicit = ReasoningEffortSettings::default();
        explicit.apply_level(ReasoningEffortLevel::Low);
        let s = serde_json::to_string(&explicit).unwrap();
        let back: ReasoningEffortSettings = serde_json::from_str(&s).unwrap();
        assert_eq!(back.level, Some(ReasoningEffortLevel::Low));
    }
}
