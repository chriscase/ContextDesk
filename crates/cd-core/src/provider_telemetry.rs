//! Authoritative OpenAI-compatible provider transport telemetry.
//!
//! This module owns **wire capture** only: fields taken from an HTTP response
//! body and a strict allowlist of non-secret response headers. Turn-level
//! orchestration (configured profile, application retry reasons, context
//! budget fold-in, host projections) lives in `cd-workflow` so CLI and Tauri
//! cannot independently invent provider behavior.
//!
//! Honesty rules:
//! - Missing token / cost / route / request-id values stay explicitly unknown
//!   (`None` / [`ObservedRoute::Unknown`]) — never zero-filled, never copied
//!   from the configured model id.
//! - Authorization, cookies, and other credential-bearing headers are never
//!   captured.
//! - Vercel / gateway extensions are optional and allowlisted; standards
//!   fields (`usage`, `model`, `id`, `finish_reason`) remain the baseline.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Maximum retained length for a safe request-id / model / route string.
pub const MAX_TELEMETRY_STRING_CHARS: usize = 200;

/// Response headers that may be captured (lowercase ASCII names).
///
/// Anything not on this list is ignored — including `authorization`,
/// `cookie`, `set-cookie`, and proprietary credential headers.
pub const SAFE_RESPONSE_HEADER_ALLOWLIST: &[&str] = &["x-request-id", "x-vercel-id", "cf-ray"];

/// Observed upstream route/provider when the gateway reports it authoritatively.
///
/// Never synthesized from the configured or response model id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ObservedRoute {
    /// No authoritative route/provider was reported on the wire.
    #[default]
    Unknown,
    /// Gateway/provider reported this route string.
    Reported {
        /// Authoritative route / provider name from allowlisted metadata.
        value: String,
    },
}

impl ObservedRoute {
    /// Stable wire / log label.
    pub fn as_status_str(&self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Reported { .. } => "reported",
        }
    }

    /// Reported value when present.
    pub fn reported_value(&self) -> Option<&str> {
        match self {
            Self::Unknown => None,
            Self::Reported { value } => Some(value.as_str()),
        }
    }
}

/// Transport facts captured from one OpenAI-compatible HTTP response.
///
/// All numeric / cost fields use [`Option`]: absent means **unknown**, not
/// zero. A genuine zero (e.g. free/BYOK `usage.cost = 0.0`) is retained as
/// `Some(0.0)` and is distinct from missing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTransportTelemetry {
    /// Model id reported in the response body (`model`), when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    /// Safe provider/gateway request identifier when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_request_id: Option<String>,
    /// Authoritative observed route/provider, or explicit unknown.
    #[serde(default)]
    pub observed_route: ObservedRoute,
    /// Prompt / input tokens when supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    /// Completion / output tokens when supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    /// Reasoning tokens when supplied (OpenAI details or gateway extension).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    /// Cached prompt tokens when supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u64>,
    /// Total tokens when supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    /// Actual gateway/request cost when supplied (never invented as 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
}

/// Sum a per-round numeric metric only when **every** round reports it.
///
/// If `rounds` is empty, or any round omits the metric, returns [`None`]
/// (unknown) — never a partial sum and never an invented zero.
pub fn sum_reported_u64_all<I, F>(rounds: I, mut get: F) -> Option<u64>
where
    I: IntoIterator,
    F: FnMut(&I::Item) -> Option<u64>,
{
    let mut any = false;
    let mut sum = 0u64;
    for round in rounds {
        any = true;
        sum = sum.saturating_add(get(&round)?);
    }
    any.then_some(sum)
}

/// Sum a per-round cost only when **every** round reports cost.
///
/// Genuine `0.0` values are retained and summed; missing cost on any round
/// yields [`None`].
pub fn sum_reported_f64_all<I, F>(rounds: I, mut get: F) -> Option<f64>
where
    I: IntoIterator,
    F: FnMut(&I::Item) -> Option<f64>,
{
    let mut any = false;
    let mut sum = 0.0_f64;
    for round in rounds {
        any = true;
        let v = get(&round)?;
        if !v.is_finite() {
            return None;
        }
        sum += v;
    }
    if !any || !sum.is_finite() {
        None
    } else {
        Some(sum)
    }
}

impl ProviderTransportTelemetry {
    /// True when no transport facts were captured.
    pub fn is_empty(&self) -> bool {
        self.response_model.is_none()
            && self.provider_request_id.is_none()
            && matches!(self.observed_route, ObservedRoute::Unknown)
            && self.prompt_tokens.is_none()
            && self.completion_tokens.is_none()
            && self.reasoning_tokens.is_none()
            && self.cached_tokens.is_none()
            && self.total_tokens.is_none()
            && self.cost.is_none()
    }

    /// Merge later patches without inventing values. Later `Some` wins;
    /// `observed_route` upgrades from unknown to reported only.
    pub fn merge_from(&mut self, other: &Self) {
        if other.response_model.is_some() {
            self.response_model = other.response_model.clone();
        }
        if other.provider_request_id.is_some() {
            self.provider_request_id = other.provider_request_id.clone();
        }
        if matches!(self.observed_route, ObservedRoute::Unknown) {
            if let ObservedRoute::Reported { value } = &other.observed_route {
                self.observed_route = ObservedRoute::Reported {
                    value: value.clone(),
                };
            }
        } else if let ObservedRoute::Reported { value } = &other.observed_route {
            self.observed_route = ObservedRoute::Reported {
                value: value.clone(),
            };
        }
        if other.prompt_tokens.is_some() {
            self.prompt_tokens = other.prompt_tokens;
        }
        if other.completion_tokens.is_some() {
            self.completion_tokens = other.completion_tokens;
        }
        if other.reasoning_tokens.is_some() {
            self.reasoning_tokens = other.reasoning_tokens;
        }
        if other.cached_tokens.is_some() {
            self.cached_tokens = other.cached_tokens;
        }
        if other.total_tokens.is_some() {
            self.total_tokens = other.total_tokens;
        }
        if other.cost.is_some() {
            self.cost = other.cost;
        }
    }

    /// JSON object for EventDto / CLI projections (camelCase).
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| Value::Object(Default::default()))
    }
}

/// Bound and scrub a telemetry string so secrets/paths never ride along.
pub fn bound_telemetry_string(raw: &str) -> Option<String> {
    let scrubbed = crate::redact::scrub_secrets(raw.trim());
    if scrubbed.is_empty() {
        return None;
    }
    let mut out = scrubbed;
    if out.chars().count() > MAX_TELEMETRY_STRING_CHARS {
        out = out.chars().take(MAX_TELEMETRY_STRING_CHARS).collect();
    }
    Some(out)
}

/// Scrub and length-bound a configured profile id or model override before it
/// enters workflow DTOs / events.
///
/// Legitimate provider/model identifiers pass through unchanged (aside from
/// trimming). Credential-shaped or overlong values are scrubbed and capped;
/// a value that is empty after scrubbing becomes `"[redacted]"` so hosts never
/// receive the raw secret and the field remains a non-empty string.
pub fn sanitize_configured_identity(raw: &str) -> String {
    match bound_telemetry_string(raw) {
        Some(s) => s,
        None => "[redacted]".to_string(),
    }
}

fn json_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
        .or_else(|| {
            value.as_f64().and_then(|n| {
                if n.is_finite() && n >= 0.0 && n.fract() == 0.0 {
                    Some(n as u64)
                } else {
                    None
                }
            })
        })
}

fn json_cost(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|v| v.is_finite()),
        _ => None,
    }
}

/// Capture allowlisted safe response headers into a telemetry patch.
pub fn capture_safe_response_headers<I, K, V>(headers: I) -> ProviderTransportTelemetry
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    let mut out = ProviderTransportTelemetry::default();
    for (name, value) in headers {
        let key = name.as_ref().trim().to_ascii_lowercase();
        if !SAFE_RESPONSE_HEADER_ALLOWLIST
            .iter()
            .any(|allowed| *allowed == key)
        {
            continue;
        }
        // Prefer the first allowlisted request-id style header we see.
        if out.provider_request_id.is_some() {
            continue;
        }
        if let Some(id) = bound_telemetry_string(value.as_ref()) {
            out.provider_request_id = Some(id);
        }
    }
    out
}

/// Extract transport telemetry from one OpenAI-compatible JSON object
/// (non-stream completion or a single SSE `data:` payload).
///
/// Does **not** treat the top-level / choice `model` as an observed route.
pub fn extract_transport_telemetry_from_value(v: &Value) -> ProviderTransportTelemetry {
    let mut out = ProviderTransportTelemetry::default();

    if let Some(model) = v.get("model").and_then(|m| m.as_str()) {
        out.response_model = bound_telemetry_string(model);
    }
    if let Some(id) = v.get("id").and_then(|m| m.as_str()) {
        out.provider_request_id = bound_telemetry_string(id);
    }

    // Optional gateway metadata (Vercel-shaped and standards-adjacent).
    // Strict allowlist — never walk arbitrary nested objects into the DTO.
    if let Some(gateway) = v
        .get("providerMetadata")
        .and_then(|m| m.get("gateway"))
        .or_else(|| v.get("provider_metadata").and_then(|m| m.get("gateway")))
    {
        if out.provider_request_id.is_none() {
            if let Some(gen) = gateway
                .get("generationId")
                .or_else(|| gateway.get("generation_id"))
                .and_then(|g| g.as_str())
            {
                out.provider_request_id = bound_telemetry_string(gen);
            }
        }
        // Authoritative routing only — never parse `provider/model` from model id.
        let routing = gateway.get("routing");
        let route = routing
            .and_then(|r| {
                r.get("finalProvider")
                    .or_else(|| r.get("final_provider"))
                    .or_else(|| r.get("provider"))
            })
            .and_then(|p| p.as_str())
            .or_else(|| gateway.get("provider").and_then(|p| p.as_str()))
            .or_else(|| gateway.get("providerName").and_then(|p| p.as_str()));
        if let Some(route) = route.and_then(bound_telemetry_string) {
            out.observed_route = ObservedRoute::Reported { value: route };
        }
    }

    if let Some(usage) = v.get("usage") {
        out.prompt_tokens = usage
            .get("prompt_tokens")
            .or_else(|| usage.get("input_tokens"))
            .and_then(json_u64);
        out.completion_tokens = usage
            .get("completion_tokens")
            .or_else(|| usage.get("output_tokens"))
            .and_then(json_u64);
        out.total_tokens = usage.get("total_tokens").and_then(json_u64);
        out.reasoning_tokens = usage
            .get("completion_tokens_details")
            .and_then(|d| d.get("reasoning_tokens"))
            .or_else(|| usage.get("reasoning_tokens"))
            .and_then(json_u64);
        out.cached_tokens = usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .or_else(|| usage.get("cached_tokens"))
            .and_then(json_u64);
        // Actual charged cost when the gateway supplies it. Absent stays None
        // (unknown) — never coerced to 0.0.
        out.cost = usage
            .get("cost")
            .or_else(|| usage.get("total_cost"))
            .and_then(json_cost);
    }

    out
}

/// Parse a JSON completion body into transport telemetry (ignore parse errors).
pub fn extract_transport_telemetry_from_json_text(text: &str) -> ProviderTransportTelemetry {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => extract_transport_telemetry_from_value(&v),
        Err(_) => ProviderTransportTelemetry::default(),
    }
}

/// Whether visible assistant text is empty after trimming.
pub fn visible_answer_empty(content: &str) -> bool {
    content.trim().is_empty()
}

/// Whether the finish reason indicates length / truncation stop.
pub fn finish_reason_is_length(finish_reason: &str) -> bool {
    let fr = finish_reason.trim().to_ascii_lowercase();
    matches!(
        fr.as_str(),
        "length" | "max_tokens" | "max_completion_tokens"
    )
}

/// One application-level retry that produced a subsequent provider round.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationRetryReason {
    /// Provider round index (0-based) that was entered because of this retry.
    pub round: u32,
    /// Stable application reason code (never a gateway-internal counter).
    pub reason: String,
}

/// Per-round telemetry combining transport capture with host-known facts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRoundTelemetry {
    /// 0-based application provider round.
    pub round: u32,
    /// Wall-clock latency for this round when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Provider finish reason when the round completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    /// Tool calls returned on this round.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_count: Option<usize>,
    /// `"completed"` | `"failed"`.
    pub outcome: String,
    /// Redacted failure text when `outcome == "failed"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// True when visible assistant text for this round is empty.
    pub empty_visible_answer: bool,
    /// True when finish_reason indicates length truncation.
    pub truncated_by_length: bool,
    /// Wire transport capture for this round.
    #[serde(default)]
    pub transport: ProviderTransportTelemetry,
    /// Application retry reason that caused this round, when any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_retry_reason: Option<String>,
}

/// Turn-level authoritative provider telemetry shared by CLI and Tauri.
///
/// Aggregation policy (enforced in `cd-workflow`):
/// - **Per-round transport** is preserved independently on [`Self::rounds`].
/// - **Numeric turn totals** (prompt/completion/reasoning/cached/total tokens
///   and cost) are the sum across every provider round **only when every round
///   reports that metric**. Any omission → turn-level field is absent/unknown
///   (never a partial sum, never invented as zero).
/// - **Identity fields** (`response_model`, `provider_request_id`,
///   `observed_route`, `finish_reason`) are **not** summed: they come from the
///   last round that authoritatively reported them (finish reason from the last
///   completed round).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTurnTelemetry {
    /// Configured provider profile id (scrubbed / length-bounded).
    pub configured_profile_id: String,
    /// Model id requested / configured for the turn (scrubbed / length-bounded).
    pub configured_model: String,
    /// Model actually reported on the last response that included `model`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    /// Safe request id from the last round that reported one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_request_id: Option<String>,
    /// Authoritative observed route from the last reported round, else unknown.
    #[serde(default)]
    pub observed_route: ObservedRoute,
    /// Aggregated prompt tokens when reported on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    /// Aggregated completion tokens when reported on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    /// Aggregated reasoning tokens when reported on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    /// Aggregated cached prompt tokens when reported on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u64>,
    /// Aggregated total tokens when reported on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    /// Actual cost when supplied on the wire; unknown stays omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Shared context budget / packing telemetry when emitted this turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_budget: Option<crate::context_budgeting::ContextBudgetTelemetry>,
    /// Application provider-round count (not gateway-internal retries).
    pub provider_round_count: u32,
    /// Application-level retry reasons only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub application_retry_reasons: Vec<ApplicationRetryReason>,
    /// Final turn outcome (`TurnCompleted.reason`) when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_turn_outcome: Option<String>,
    /// Finish reason from the last completed provider round.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    /// True when the last completed round had empty visible text.
    pub empty_visible_answer: bool,
    /// True when the last completed round finished due to length.
    pub truncated_by_length: bool,
    /// Total tool calls across completed rounds.
    pub tool_call_count: usize,
    /// Sum of per-round latencies when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Per-round detail (same capture both hosts project).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rounds: Vec<ProviderRoundTelemetry>,
}

impl ProviderTurnTelemetry {
    /// JSON object for EventDto / CLI (camelCase).
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| Value::Object(Default::default()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn vercel_shaped_usage_captures_cost_reasoning_cached_model_and_id() {
        let v = json!({
            "id": "chatcmpl-vercel-1",
            "model": "anthropic/claude-sonnet-4",
            "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "total_tokens": 30,
                "cost": 0.00123,
                "completion_tokens_details": { "reasoning_tokens": 8 },
                "prompt_tokens_details": { "cached_tokens": 4 }
            },
            "providerMetadata": {
                "gateway": {
                    "generationId": "gen_abc",
                    "routing": { "finalProvider": "anthropic" }
                }
            }
        });
        let tel = extract_transport_telemetry_from_value(&v);
        assert_eq!(
            tel.response_model.as_deref(),
            Some("anthropic/claude-sonnet-4")
        );
        // Body id wins over generationId when both present.
        assert_eq!(
            tel.provider_request_id.as_deref(),
            Some("chatcmpl-vercel-1")
        );
        assert_eq!(
            tel.observed_route,
            ObservedRoute::Reported {
                value: "anthropic".into()
            }
        );
        assert_eq!(tel.prompt_tokens, Some(10));
        assert_eq!(tel.completion_tokens, Some(20));
        assert_eq!(tel.reasoning_tokens, Some(8));
        assert_eq!(tel.cached_tokens, Some(4));
        assert_eq!(tel.total_tokens, Some(30));
        assert_eq!(tel.cost, Some(0.00123));
    }

    #[test]
    fn missing_metadata_stays_explicitly_unknown() {
        let tel = extract_transport_telemetry_from_value(&json!({
            "choices": [{"message": {"content": ""}, "finish_reason": "length"}]
        }));
        assert!(tel.response_model.is_none());
        assert!(tel.provider_request_id.is_none());
        assert_eq!(tel.observed_route, ObservedRoute::Unknown);
        assert!(tel.prompt_tokens.is_none());
        assert!(tel.cost.is_none());
    }

    #[test]
    fn configured_model_shape_in_response_model_is_not_observed_route() {
        let tel = extract_transport_telemetry_from_value(&json!({
            "model": "anthropic/claude-sonnet-4",
            "choices": [{"message": {"content": "x"}, "finish_reason": "stop"}],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
        }));
        assert_eq!(
            tel.response_model.as_deref(),
            Some("anthropic/claude-sonnet-4")
        );
        assert_eq!(tel.observed_route, ObservedRoute::Unknown);
        assert_eq!(tel.observed_route.as_status_str(), "unknown");
    }

    #[test]
    fn secret_headers_are_never_captured() {
        let tel = capture_safe_response_headers([
            ("Authorization", "Bearer sk-secret-should-not-leak"),
            ("Cookie", "session=evil"),
            ("Set-Cookie", "token=nope"),
            ("x-api-key", "also-secret"),
            ("x-request-id", "req-safe-1"),
        ]);
        assert_eq!(tel.provider_request_id.as_deref(), Some("req-safe-1"));
        let dumped = format!("{tel:?}");
        assert!(!dumped.contains("sk-secret"));
        assert!(!dumped.contains("session=evil"));
        assert!(!dumped.contains("also-secret"));
    }

    #[test]
    fn zero_cost_is_retained_distinct_from_unknown() {
        let known_zero = extract_transport_telemetry_from_value(&json!({
            "usage": { "cost": 0.0, "prompt_tokens": 1, "completion_tokens": 0, "total_tokens": 1 }
        }));
        assert_eq!(known_zero.cost, Some(0.0));
        let unknown = extract_transport_telemetry_from_value(&json!({
            "usage": { "prompt_tokens": 1, "completion_tokens": 0, "total_tokens": 1 }
        }));
        assert!(unknown.cost.is_none());
    }

    #[test]
    fn length_finish_with_empty_visible_helpers() {
        assert!(visible_answer_empty("   "));
        assert!(finish_reason_is_length("length"));
        assert!(!finish_reason_is_length("stop"));
    }

    #[test]
    fn sanitize_configured_identity_scrubs_secrets_and_bounds_length() {
        let legit = sanitize_configured_identity("anthropic/claude-sonnet-4");
        assert_eq!(legit, "anthropic/claude-sonnet-4");

        let with_key = sanitize_configured_identity("model-sk-abcdefghijklmnop-override");
        assert!(with_key.contains("sk-***"), "{with_key}");
        assert!(!with_key.contains("abcdefghijklmnop"), "{with_key}");

        let bearer = sanitize_configured_identity("Bearer tokentokentoken12345");
        assert!(bearer.contains("Bearer ***"), "{bearer}");
        assert!(!bearer.contains("tokentokentoken12345"), "{bearer}");

        let long = "m".repeat(MAX_TELEMETRY_STRING_CHARS + 50);
        let bounded = sanitize_configured_identity(&long);
        assert_eq!(bounded.chars().count(), MAX_TELEMETRY_STRING_CHARS);
    }

    #[test]
    fn sum_reported_requires_every_round() {
        let a = ProviderTransportTelemetry {
            prompt_tokens: Some(10),
            cost: Some(0.1),
            ..Default::default()
        };
        let b = ProviderTransportTelemetry {
            prompt_tokens: Some(5),
            cost: Some(0.2),
            ..Default::default()
        };
        let missing = ProviderTransportTelemetry {
            prompt_tokens: Some(1),
            cost: None,
            ..Default::default()
        };
        assert_eq!(
            sum_reported_u64_all([&a, &b], |t| t.prompt_tokens),
            Some(15)
        );
        let summed_cost = sum_reported_f64_all([&a, &b], |t| t.cost).unwrap();
        assert!((summed_cost - 0.3).abs() < 1e-9);
        assert_eq!(sum_reported_f64_all([&a, &missing], |t| t.cost), None);
        assert_eq!(sum_reported_u64_all([&a], |t| t.prompt_tokens), Some(10));
    }
}
