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

/// Closed provider-returned model identity.
///
/// Successful identities are [`Self::Certified`] with the exact accepted
/// bytes. [`Self::Rejected`] never carries raw bytes. [`Self::Absent`] means
/// no `model` field was present.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ResponseModelIdentity {
    /// No `model` field was present on the wire.
    #[default]
    Absent,
    /// A provider-reported model passed [`certify_provider_model_identity`].
    Certified {
        /// Exact accepted identity bytes; never rewritten.
        value: String,
    },
    /// A provider-reported model was present and rejected without retaining bytes.
    Rejected,
}

impl ResponseModelIdentity {
    /// Distinct status for hosts that still project [`ModelIdentityStatus`].
    pub fn status(&self) -> ModelIdentityStatus {
        match self {
            Self::Absent => ModelIdentityStatus::Absent,
            Self::Certified { .. } => ModelIdentityStatus::Certified,
            Self::Rejected => ModelIdentityStatus::Rejected,
        }
    }

    /// Certified identity bytes when the value was accepted.
    pub fn certified_value(&self) -> Option<&str> {
        match self {
            Self::Certified { value } => Some(value.as_str()),
            Self::Absent | Self::Rejected => None,
        }
    }

    fn from_status_and_value(status: ModelIdentityStatus, value: Option<String>) -> Self {
        match status {
            ModelIdentityStatus::Rejected => Self::Rejected,
            ModelIdentityStatus::Absent => Self::Absent,
            ModelIdentityStatus::Certified => match value {
                Some(raw) if certify_provider_model_identity(&raw).is_ok() => {
                    Self::Certified { value: raw }
                }
                _ => Self::Rejected,
            },
        }
    }

    fn into_status_and_value(self) -> (ModelIdentityStatus, Option<String>) {
        match self {
            Self::Absent => (ModelIdentityStatus::Absent, None),
            Self::Rejected => (ModelIdentityStatus::Rejected, None),
            Self::Certified { value } => (ModelIdentityStatus::Certified, Some(value)),
        }
    }
}

/// Whether a provider-reported response model was present, certified, or rejected.
///
/// [`ModelIdentityStatus::Rejected`] is a captured fact: it is distinct from an
/// absent `model` field, and it never retains the rejected raw bytes. Wire
/// `reported` deserializes as [`Self::Certified`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelIdentityStatus {
    /// No `model` field was present on the wire.
    #[default]
    Absent,
    /// A provider-reported model passed [`certify_provider_model_identity`].
    #[serde(alias = "reported")]
    Certified,
    /// A provider-reported model was present and rejected without retaining bytes.
    Rejected,
}

fn model_identity_status_is_absent(status: &ModelIdentityStatus) -> bool {
    matches!(status, ModelIdentityStatus::Absent)
}

/// Unit error from [`certify_provider_model_identity`]. Never echoes input bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelIdentityRejected;

impl std::fmt::Display for ModelIdentityRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("provider-reported model identity was rejected")
    }
}

impl std::error::Error for ModelIdentityRejected {}

/// Transport facts captured from one OpenAI-compatible HTTP response.
///
/// All numeric / cost fields use [`Option`]: absent means **unknown**, not
/// zero. A genuine zero (e.g. free/BYOK `usage.cost = 0.0`) is retained as
/// `Some(0.0)` and is distinct from missing.
///
/// `response_model` is a projection of [`ResponseModelIdentity`]: it is
/// `Some` only for [`ResponseModelIdentity::Certified`]. Serde refuses to
/// emit or retain [`ModelIdentityStatus::Rejected`] / [`ModelIdentityStatus::Absent`]
/// with a `responseModel` value.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    from = "ProviderTransportTelemetryWire",
    into = "ProviderTransportTelemetryWire"
)]
pub struct ProviderTransportTelemetry {
    /// Model id reported in the response body (`model`), when certified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    /// Distinct from [`Self::response_model`]: rejected identities stay
    /// [`ModelIdentityStatus::Rejected`] with no retained raw bytes.
    #[serde(default, skip_serializing_if = "model_identity_status_is_absent")]
    pub model_identity_status: ModelIdentityStatus,
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
    /// Character count observed in a separate reasoning/analysis channel.
    /// The channel text itself is never retained or serialized.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content_chars: Option<u64>,
    /// Cached prompt tokens when supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u64>,
    /// Total tokens when supplied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    /// Actual gateway/request cost when supplied (never invented as 0).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    /// Requested reasoning-effort policy label (`omit` or level). Share-safe;
    /// never a prompt, body, header, URL, or secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort_requested: Option<String>,
    /// Exact effort request applied on the wire (`omit` or level). Share-safe;
    /// not proof the remote model honored it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort_effective: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTransportTelemetryWire {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    response_model: Option<String>,
    #[serde(default, skip_serializing_if = "model_identity_status_is_absent")]
    model_identity_status: ModelIdentityStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_request_id: Option<String>,
    #[serde(default)]
    observed_route: ObservedRoute,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completion_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_content_chars: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cached_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort_requested: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort_effective: Option<String>,
}

impl From<ProviderTransportTelemetryWire> for ProviderTransportTelemetry {
    fn from(wire: ProviderTransportTelemetryWire) -> Self {
        let identity = ResponseModelIdentity::from_status_and_value(
            wire.model_identity_status,
            wire.response_model,
        );
        let (model_identity_status, response_model) = identity.into_status_and_value();
        Self {
            response_model,
            model_identity_status,
            provider_request_id: wire.provider_request_id,
            observed_route: wire.observed_route,
            prompt_tokens: wire.prompt_tokens,
            completion_tokens: wire.completion_tokens,
            reasoning_tokens: wire.reasoning_tokens,
            reasoning_content_chars: wire.reasoning_content_chars,
            cached_tokens: wire.cached_tokens,
            total_tokens: wire.total_tokens,
            cost: wire.cost,
            reasoning_effort_requested: wire.reasoning_effort_requested,
            reasoning_effort_effective: wire.reasoning_effort_effective,
        }
    }
}

impl From<ProviderTransportTelemetry> for ProviderTransportTelemetryWire {
    fn from(value: ProviderTransportTelemetry) -> Self {
        let identity = ResponseModelIdentity::from_status_and_value(
            value.model_identity_status,
            value.response_model,
        );
        let (model_identity_status, response_model) = identity.into_status_and_value();
        Self {
            response_model,
            model_identity_status,
            provider_request_id: value.provider_request_id,
            observed_route: value.observed_route,
            prompt_tokens: value.prompt_tokens,
            completion_tokens: value.completion_tokens,
            reasoning_tokens: value.reasoning_tokens,
            reasoning_content_chars: value.reasoning_content_chars,
            cached_tokens: value.cached_tokens,
            total_tokens: value.total_tokens,
            cost: value.cost,
            reasoning_effort_requested: value.reasoning_effort_requested,
            reasoning_effort_effective: value.reasoning_effort_effective,
        }
    }
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
        // An unrepresentable aggregate is not an exact provider fact. Keep it
        // unknown rather than saturating to a fabricated token count.
        sum = sum.checked_add(get(&round)?)?;
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
        matches!(
            self.response_model_identity(),
            ResponseModelIdentity::Absent
        ) && self.provider_request_id.is_none()
            && matches!(self.observed_route, ObservedRoute::Unknown)
            && self.prompt_tokens.is_none()
            && self.completion_tokens.is_none()
            && self.reasoning_tokens.is_none()
            && self.reasoning_content_chars.is_none()
            && self.cached_tokens.is_none()
            && self.total_tokens.is_none()
            && self.cost.is_none()
            && self.reasoning_effort_requested.is_none()
            && self.reasoning_effort_effective.is_none()
    }

    /// Closed identity for this capture. Inconsistent public fields collapse
    /// to [`ResponseModelIdentity::Rejected`] or drop uncertified bytes.
    pub fn response_model_identity(&self) -> ResponseModelIdentity {
        ResponseModelIdentity::from_status_and_value(
            self.model_identity_status,
            self.response_model.clone(),
        )
    }

    /// Merge later patches without inventing values. Later `Some` wins;
    /// `observed_route` upgrades from unknown to reported only.
    pub fn merge_from(&mut self, other: &Self) {
        match other.response_model_identity() {
            ResponseModelIdentity::Certified { value } => {
                if let Ok(certified) = certify_provider_model_identity(&value) {
                    self.response_model = Some(certified.to_string());
                    self.model_identity_status = ModelIdentityStatus::Certified;
                }
            }
            ResponseModelIdentity::Rejected => {
                self.response_model = None;
                self.model_identity_status = ModelIdentityStatus::Rejected;
            }
            ResponseModelIdentity::Absent => {}
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
        self.reasoning_content_chars =
            match (self.reasoning_content_chars, other.reasoning_content_chars) {
                (Some(a), Some(b)) => a.checked_add(b),
                (None, Some(b)) => Some(b),
                (current, None) => current,
            };
        if other.cached_tokens.is_some() {
            self.cached_tokens = other.cached_tokens;
        }
        if other.total_tokens.is_some() {
            self.total_tokens = other.total_tokens;
        }
        if other.cost.is_some() {
            self.cost = other.cost;
        }
        // Share-safe effort labels: later Some wins; None never clears.
        if other.reasoning_effort_requested.is_some() {
            self.reasoning_effort_requested = other.reasoning_effort_requested.clone();
        }
        if other.reasoning_effort_effective.is_some() {
            self.reasoning_effort_effective = other.reasoning_effort_effective.clone();
        }
    }

    /// JSON object for EventDto / CLI projections (camelCase).
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_| Value::Object(Default::default()))
    }
}

/// Bound and scrub a telemetry string so secrets/paths never ride along.
///
/// This is the request-id / non-identity capture path. Provider-returned
/// response models must use [`certify_provider_model_identity`] instead — they
/// are never trimmed, scrubbed, truncated, or otherwise rewritten.
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

/// Reject-only certification for a provider-returned response model.
///
/// Valid identities are returned as the same borrow with exact bytes preserved.
/// Invalid identities yield [`ModelIdentityRejected`] and never echo the input.
/// Callers that need a host-facing `Option` may use [`certified_response_model`];
/// extraction records [`ModelIdentityStatus::Rejected`] instead of collapsing
/// rejection into absence.
pub fn certify_provider_model_identity(raw: &str) -> Result<&str, ModelIdentityRejected> {
    if response_model_identity_is_valid(raw) {
        Ok(raw)
    } else {
        Err(ModelIdentityRejected)
    }
}

/// Preserve a provider-returned response model only when the **raw** bytes
/// already satisfy the bounded identifier contract.
///
/// Valid identities are returned unchanged. Invalid identities become [`None`].
/// This convenience cannot distinguish rejection from absence; use
/// [`certify_provider_model_identity`] and [`ModelIdentityStatus`] for that.
pub fn certified_response_model(raw: &str) -> Option<String> {
    certify_provider_model_identity(raw)
        .ok()
        .map(str::to_string)
}

/// Shared accept/reject cases for provider-returned model identity.
///
/// `true` means the raw bytes must be preserved exactly. `false` means the
/// value must be rejected without retention. Catalog-style ids and opaque
/// gateway forms used by supported providers are included alongside
/// adversarial controls, padding, credentials, paths, URLs, and endpoint
/// shapes. All names are synthetic fixtures.
pub const PROVIDER_MODEL_IDENTITY_COMPATIBILITY_CASES: &[(&str, bool)] = &[
    ("qwen3", true),
    ("qwen2.5-coder", true),
    ("qwen2.5:7b", true),
    ("Qwen3-Reranker-0.6B", true),
    ("gpt-oss", true),
    ("gpt-oss-120b", true),
    ("gpt-oss:20b", true),
    ("gpt-oss:20", true),
    ("openai/gpt-oss-120b", true),
    ("ministral-3b", true),
    ("mistral/ministral-14b", true),
    ("deepseek-chat", true),
    ("deepseek-reasoner", true),
    ("deepseek/deepseek-chat", true),
    ("accounts/fictional-gateway/models/qwen3", true),
    ("publishers/fictional/models/gpt-oss", true),
    ("org-alpha/deployments/ministral-3b", true),
    ("vertex:publishers:qwen3", true),
    ("qwen2.5:7", true),
    ("vertex:publishers:qwen3:revision:9", true),
    (
        "accounts/fictional-gateway/alpha/beta/gamma/delta/epsilon/zeta/eta/theta/models/qwen3",
        true,
    ),
    ("", false),
    (" qwen3", false),
    ("qwen3 ", false),
    ("qwen3\n", false),
    ("qwen3\u{0007}", false),
    ("qwen3`alpha", false),
    ("sk-fixturekey00000001", false),
    ("Bearer fixturetokenvalue0001", false),
    ("key=secret-fixture", false),
    ("/abs/alpha/model", false),
    ("//unc-alpha/share/model", false),
    (r"C:\alpha-share\model", false),
    ("C:/alpha-share/model", false),
    ("https://fixture.invalid/v1", false),
    ("http://192.0.2.80/v1", false),
    ("192.0.2.80", false),
    ("192.0.2.80:443", false),
    ("2001:db8::1", false),
    ("[2001:db8::1]", false),
    ("fixture.invalid:8443", false),
    ("fixture.invalid", false),
    ("alpha.internal", false),
    ("alpha.localhost", false),
    ("v1/chat/completions", false),
    ("api/embeddings", false),
    ("qwen3/../outside", false),
    ("qwen3?x=1", false),
    ("qwen3#frag", false),
    ("catalog-fixture.com", false),
    ("198.51.100.9:443", false),
];

const MAX_MODEL_IDENTITY_BYTES: usize = 256;
const MAX_MODEL_IDENTITY_SEGMENT_BYTES: usize = 128;

fn response_model_identity_is_valid(value: &str) -> bool {
    if value.is_empty()
        || value.trim() != value
        || value.len() > MAX_MODEL_IDENTITY_BYTES
        || value.chars().count() > MAX_TELEMETRY_STRING_CHARS
        || value.contains('%')
        || value.contains('\\')
        || value.contains('?')
        || value.contains('#')
        || value.contains("://")
        || value.starts_with('/')
        || value.starts_with('[')
        || identity_is_windows_drive(value)
        || value.chars().any(|character| {
            character.is_control() || character.is_whitespace() || character == '`'
        })
        || crate::redact::scrub_secrets(value) != value
        || identity_contains_credential_assignment(value)
        || identity_looks_like_network_host(value)
        || value.parse::<std::net::IpAddr>().is_ok()
    {
        return false;
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.is_empty()
        || segments.iter().any(|segment| {
            segment.is_empty()
                || *segment == "."
                || *segment == ".."
                || segment.len() > MAX_MODEL_IDENTITY_SEGMENT_BYTES
                || !segment.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+' | b':')
                })
                || identity_looks_like_network_host(segment)
                || segment.parse::<std::net::IpAddr>().is_ok()
                || identity_is_endpoint_hostport(segment)
        })
        || identity_is_endpoint_hostport(value)
        || response_model_segments_are_route_shaped(&segments)
    {
        return false;
    }
    true
}

fn identity_is_windows_drive(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || bytes[2] == b'/' || bytes[2] == b'\\')
}

fn identity_is_endpoint_hostport(value: &str) -> bool {
    let Some((host, port)) = value.rsplit_once(':') else {
        return false;
    };
    if host.is_empty() || port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    identity_looks_like_network_host(host)
}

fn identity_looks_like_network_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || identity_is_internal_hostname(host)
        || host.parse::<std::net::IpAddr>().is_ok()
        || identity_looks_like_dns_hostname(host)
}

fn identity_looks_like_dns_hostname(host: &str) -> bool {
    if host.contains('/') || !host.contains('.') {
        return false;
    }
    let labels = host.split('.').collect::<Vec<_>>();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) {
        return false;
    }
    let tld = labels[labels.len() - 1];
    tld.len() >= 2 && tld.bytes().all(|byte| byte.is_ascii_alphabetic())
}

fn identity_contains_credential_assignment(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "token=",
        "api_key=",
        "api-key=",
        "apikey=",
        "access_token=",
        "secret=",
        "password=",
        "authorization=",
        "bearer ",
    ];
    MARKERS.iter().any(|marker| normalized.contains(marker))
}

fn response_model_segments_are_route_shaped(segments: &[&str]) -> bool {
    if segments.is_empty() {
        return false;
    }
    const ROUTE_WORDS: &[&str] = &[
        "api",
        "chat",
        "completions",
        "completion",
        "embeddings",
        "responses",
    ];
    let first = segments[0].to_ascii_lowercase();
    if first.strip_prefix('v').is_some_and(|version| {
        !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        return true;
    }
    segments.iter().any(|segment| {
        let normalized = segment.to_ascii_lowercase();
        ROUTE_WORDS.contains(&normalized.as_str())
    })
}

fn identity_is_internal_hostname(host: &str) -> bool {
    let normalized = host.to_ascii_lowercase();
    normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".internal")
        || normalized.ends_with(".local")
        || normalized.ends_with(".localdomain")
        || normalized.ends_with(".lan")
        || normalized.ends_with(".home")
        || normalized.ends_with(".home.arpa")
        || normalized.ends_with(".corp")
        || normalized.ends_with(".intranet")
        || normalized.ends_with(".private")
        || normalized.ends_with(".test")
        || normalized.ends_with(".invalid")
        || normalized.ends_with(".example")
        || normalized.ends_with(".svc")
        || normalized.contains(".svc.")
        || normalized.ends_with(".cluster")
        || normalized.ends_with(".cluster.local")
        || normalized.ends_with(".docker.internal")
        || normalized.parse::<std::net::IpAddr>().is_ok()
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

/// Count known reasoning-channel fields without retaining their contents.
/// DeepSeek, Qwen, and several OpenAI-compatible gateways use one of these
/// names when reasoning is separated from user-visible assistant text.
fn reasoning_content_chars_from_value(v: &Value) -> Option<u64> {
    const CHANNEL_KEYS: &[&str] = &[
        "reasoning_content",
        "reasoning",
        "analysis",
        "thinking",
        "thinking_content",
    ];

    fn add_object(value: &Value, total: &mut u64, found: &mut bool) {
        for key in CHANNEL_KEYS {
            let Some(text) = value.get(*key).and_then(Value::as_str) else {
                continue;
            };
            *found = true;
            let chars = u64::try_from(text.chars().count()).unwrap_or(u64::MAX);
            *total = total.checked_add(chars).unwrap_or(u64::MAX);
        }
    }

    let mut total = 0u64;
    let mut found = false;
    add_object(v, &mut total, &mut found);
    if let Some(choices) = v.get("choices").and_then(Value::as_array) {
        for choice in choices {
            add_object(choice, &mut total, &mut found);
            if let Some(message) = choice.get("message") {
                add_object(message, &mut total, &mut found);
            }
            if let Some(delta) = choice.get("delta") {
                add_object(delta, &mut total, &mut found);
            }
        }
    }
    found.then_some(total)
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
/// The response `model` is certified with [`certify_provider_model_identity`]:
/// valid identities are preserved exactly. Invalid or non-string `model`
/// values set [`ModelIdentityStatus::Rejected`] / [`ResponseModelIdentity::Rejected`]
/// and do not retain raw bytes. A missing `model` field stays
/// [`ModelIdentityStatus::Absent`]. A valid identity is
/// [`ModelIdentityStatus::Certified`].
pub fn extract_transport_telemetry_from_value(v: &Value) -> ProviderTransportTelemetry {
    let mut out = ProviderTransportTelemetry::default();

    match v.get("model") {
        None => {}
        Some(model) => match model.as_str() {
            Some(raw) => match certify_provider_model_identity(raw) {
                Ok(id) => {
                    out.response_model = Some(id.to_string());
                    out.model_identity_status = ModelIdentityStatus::Certified;
                }
                Err(_) => {
                    out.response_model = None;
                    out.model_identity_status = ModelIdentityStatus::Rejected;
                }
            },
            None => {
                out.response_model = None;
                out.model_identity_status = ModelIdentityStatus::Rejected;
            }
        },
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

    out.reasoning_content_chars = reasoning_content_chars_from_value(v);

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
#[serde(
    rename_all = "camelCase",
    from = "ProviderTurnTelemetryWire",
    into = "ProviderTurnTelemetryWire"
)]
pub struct ProviderTurnTelemetry {
    /// Configured provider profile id (scrubbed / length-bounded).
    pub configured_profile_id: String,
    /// Model id requested / configured for the turn (scrubbed / length-bounded).
    pub configured_model: String,
    /// Model actually reported on the last response that included `model`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    /// Distinguishes an absent provider identity from a rejected one. Rejected
    /// values never retain or serialize their raw bytes.
    #[serde(default, skip_serializing_if = "model_identity_status_is_absent")]
    pub model_identity_status: ModelIdentityStatus,
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
    /// Aggregated character count observed in separate reasoning/analysis
    /// channels. Channel text is never retained.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content_chars: Option<u64>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTurnTelemetryWire {
    configured_profile_id: String,
    configured_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    response_model: Option<String>,
    #[serde(default, skip_serializing_if = "model_identity_status_is_absent")]
    model_identity_status: ModelIdentityStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_request_id: Option<String>,
    #[serde(default)]
    observed_route: ObservedRoute,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    prompt_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    completion_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_content_chars: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cached_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    total_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_budget: Option<crate::context_budgeting::ContextBudgetTelemetry>,
    provider_round_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    application_retry_reasons: Vec<ApplicationRetryReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    final_turn_outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finish_reason: Option<String>,
    empty_visible_answer: bool,
    truncated_by_length: bool,
    tool_call_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    latency_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    rounds: Vec<ProviderRoundTelemetry>,
}

impl From<ProviderTurnTelemetryWire> for ProviderTurnTelemetry {
    fn from(wire: ProviderTurnTelemetryWire) -> Self {
        let identity = ResponseModelIdentity::from_status_and_value(
            wire.model_identity_status,
            wire.response_model,
        );
        let (model_identity_status, response_model) = identity.into_status_and_value();
        Self {
            configured_profile_id: wire.configured_profile_id,
            configured_model: wire.configured_model,
            response_model,
            model_identity_status,
            provider_request_id: wire.provider_request_id,
            observed_route: wire.observed_route,
            prompt_tokens: wire.prompt_tokens,
            completion_tokens: wire.completion_tokens,
            reasoning_tokens: wire.reasoning_tokens,
            reasoning_content_chars: wire.reasoning_content_chars,
            cached_tokens: wire.cached_tokens,
            total_tokens: wire.total_tokens,
            cost: wire.cost,
            context_budget: wire.context_budget,
            provider_round_count: wire.provider_round_count,
            application_retry_reasons: wire.application_retry_reasons,
            final_turn_outcome: wire.final_turn_outcome,
            finish_reason: wire.finish_reason,
            empty_visible_answer: wire.empty_visible_answer,
            truncated_by_length: wire.truncated_by_length,
            tool_call_count: wire.tool_call_count,
            latency_ms: wire.latency_ms,
            rounds: wire.rounds,
        }
    }
}

impl From<ProviderTurnTelemetry> for ProviderTurnTelemetryWire {
    fn from(value: ProviderTurnTelemetry) -> Self {
        let identity = ResponseModelIdentity::from_status_and_value(
            value.model_identity_status,
            value.response_model,
        );
        let (model_identity_status, response_model) = identity.into_status_and_value();
        Self {
            configured_profile_id: value.configured_profile_id,
            configured_model: value.configured_model,
            response_model,
            model_identity_status,
            provider_request_id: value.provider_request_id,
            observed_route: value.observed_route,
            prompt_tokens: value.prompt_tokens,
            completion_tokens: value.completion_tokens,
            reasoning_tokens: value.reasoning_tokens,
            reasoning_content_chars: value.reasoning_content_chars,
            cached_tokens: value.cached_tokens,
            total_tokens: value.total_tokens,
            cost: value.cost,
            context_budget: value.context_budget,
            provider_round_count: value.provider_round_count,
            application_retry_reasons: value.application_retry_reasons,
            final_turn_outcome: value.final_turn_outcome,
            finish_reason: value.finish_reason,
            empty_visible_answer: value.empty_visible_answer,
            truncated_by_length: value.truncated_by_length,
            tool_call_count: value.tool_call_count,
            latency_ms: value.latency_ms,
            rounds: value.rounds,
        }
    }
}

impl ProviderTurnTelemetry {
    /// Closed identity for the turn-level projection.
    pub fn response_model_identity(&self) -> ResponseModelIdentity {
        ResponseModelIdentity::from_status_and_value(
            self.model_identity_status,
            self.response_model.clone(),
        )
    }

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
            "model": "qwen3",
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
                    "routing": { "finalProvider": "fictional-gateway" }
                }
            }
        });
        let tel = extract_transport_telemetry_from_value(&v);
        assert_eq!(tel.response_model.as_deref(), Some("qwen3"));
        assert_eq!(tel.model_identity_status, ModelIdentityStatus::Certified);
        // Body id wins over generationId when both present.
        assert_eq!(
            tel.provider_request_id.as_deref(),
            Some("chatcmpl-vercel-1")
        );
        assert_eq!(
            tel.observed_route,
            ObservedRoute::Reported {
                value: "fictional-gateway".into()
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
    fn separate_reasoning_channel_is_counted_without_retaining_text() {
        let v = serde_json::json!({
            "choices": [{
                "message": {
                    "reasoning_content": "private reasoning that must not be retained",
                    "content": "visible answer"
                },
                "finish_reason": "stop"
            }]
        });
        let tel = extract_transport_telemetry_from_value(&v);
        assert_eq!(
            tel.reasoning_content_chars,
            Some(
                "private reasoning that must not be retained"
                    .chars()
                    .count() as u64
            )
        );
        let dumped = serde_json::to_string(&tel).unwrap();
        assert!(!dumped.contains("private reasoning"));
        assert!(!dumped.contains("visible answer"));
    }

    #[test]
    fn missing_metadata_stays_explicitly_unknown() {
        let tel = extract_transport_telemetry_from_value(&json!({
            "choices": [{"message": {"content": ""}, "finish_reason": "length"}]
        }));
        assert!(tel.response_model.is_none());
        assert_eq!(tel.model_identity_status, ModelIdentityStatus::Absent);
        assert!(tel.provider_request_id.is_none());
        assert_eq!(tel.observed_route, ObservedRoute::Unknown);
        assert!(tel.prompt_tokens.is_none());
        assert!(tel.cost.is_none());
    }

    #[test]
    fn configured_model_shape_in_response_model_is_not_observed_route() {
        let tel = extract_transport_telemetry_from_value(&json!({
            "model": "deepseek/deepseek-chat",
            "choices": [{"message": {"content": "x"}, "finish_reason": "stop"}],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
        }));
        assert_eq!(
            tel.response_model.as_deref(),
            Some("deepseek/deepseek-chat")
        );
        assert_eq!(tel.model_identity_status, ModelIdentityStatus::Certified);
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
        let legit = sanitize_configured_identity("qwen3");
        assert_eq!(legit, "qwen3");

        let with_key = sanitize_configured_identity("model-sk-fixturekey00000001-override");
        assert!(with_key.contains("sk-***"), "{with_key}");
        assert!(!with_key.contains("fixturekey00000001"), "{with_key}");

        let bearer = sanitize_configured_identity("Bearer fixturetokenvalue0001");
        assert!(bearer.contains("Bearer ***"), "{bearer}");
        assert!(!bearer.contains("fixturetokenvalue0001"), "{bearer}");

        let long = "m".repeat(MAX_TELEMETRY_STRING_CHARS + 50);
        let bounded = sanitize_configured_identity(&long);
        assert_eq!(bounded.chars().count(), MAX_TELEMETRY_STRING_CHARS);
    }

    #[test]
    fn certify_provider_model_identity_compatibility_table() {
        for (model, accepted) in PROVIDER_MODEL_IDENTITY_COMPATIBILITY_CASES {
            if *accepted {
                assert_eq!(
                    certify_provider_model_identity(model),
                    Ok(*model),
                    "must preserve exact bytes for {model:?}"
                );
                assert_eq!(certified_response_model(model).as_deref(), Some(*model));
                let tel = extract_transport_telemetry_from_value(&json!({ "model": model }));
                assert_eq!(tel.response_model.as_deref(), Some(*model));
                assert_eq!(tel.model_identity_status, ModelIdentityStatus::Certified);
                assert_eq!(
                    tel.response_model_identity(),
                    ResponseModelIdentity::Certified {
                        value: (*model).into()
                    }
                );
            } else {
                assert_eq!(
                    certify_provider_model_identity(model),
                    Err(ModelIdentityRejected),
                    "must reject {model:?}"
                );
                assert_eq!(certified_response_model(model), None);
                let tel = extract_transport_telemetry_from_value(&json!({ "model": model }));
                assert_eq!(tel.response_model, None, "must not retain {model:?}");
                assert_eq!(tel.model_identity_status, ModelIdentityStatus::Rejected);
                let dumped = serde_json::to_string(&tel).unwrap();
                if !model.is_empty() {
                    assert!(
                        !dumped.contains(model),
                        "rejected bytes must not serialize for {model:?}: {dumped}"
                    );
                }
            }
        }
        let overlong = "m".repeat(MAX_TELEMETRY_STRING_CHARS + 1);
        assert_eq!(
            certify_provider_model_identity(&overlong),
            Err(ModelIdentityRejected)
        );
        assert_eq!(
            extract_transport_telemetry_from_value(&json!({ "model": overlong }))
                .model_identity_status,
            ModelIdentityStatus::Rejected
        );
        let raw = "qwen3";
        assert_eq!(
            certify_provider_model_identity(raw).unwrap().as_ptr(),
            raw.as_ptr(),
            "certified identity must be the same borrow, not a rewritten copy"
        );
    }

    #[test]
    fn rejected_model_identity_is_distinct_from_absent() {
        let absent = extract_transport_telemetry_from_value(&json!({
            "choices": [{"message": {"content": "x"}}]
        }));
        assert_eq!(absent.response_model, None);
        assert_eq!(absent.model_identity_status, ModelIdentityStatus::Absent);
        assert!(absent.is_empty());

        let rejected = extract_transport_telemetry_from_value(&json!({
            "model": "https://fixture.invalid/v1"
        }));
        assert_eq!(rejected.response_model, None);
        assert_eq!(
            rejected.model_identity_status,
            ModelIdentityStatus::Rejected
        );
        assert!(!rejected.is_empty());
        let dumped = serde_json::to_string(&rejected).unwrap();
        assert!(!dumped.contains("fixture.invalid"));
        assert!(dumped.contains("rejected"));

        let non_string = extract_transport_telemetry_from_value(&json!({ "model": 7 }));
        assert_eq!(non_string.response_model, None);
        assert_eq!(
            non_string.model_identity_status,
            ModelIdentityStatus::Rejected
        );
        assert!(!serde_json::to_string(&non_string).unwrap().contains("7"));
    }

    #[test]
    fn request_id_redaction_still_trims_scrubs_and_truncates() {
        assert_eq!(
            bound_telemetry_string("  req-safe-1  ").as_deref(),
            Some("req-safe-1")
        );
        let tel = extract_transport_telemetry_from_value(&json!({
            "model": " qwen3",
            "id": "  chatcmpl-padded-1  "
        }));
        assert_eq!(tel.response_model, None);
        assert_eq!(tel.model_identity_status, ModelIdentityStatus::Rejected);
        assert_eq!(
            tel.provider_request_id.as_deref(),
            Some("chatcmpl-padded-1")
        );

        let secret_id = extract_transport_telemetry_from_value(&json!({
            "id": "req-sk-fixturekey00000001-trace"
        }));
        let request_id = secret_id.provider_request_id.expect("request id");
        assert!(request_id.contains("sk-***"), "{request_id}");
        assert!(!request_id.contains("fixturekey00000001"), "{request_id}");

        let long = "r".repeat(MAX_TELEMETRY_STRING_CHARS + 40);
        let truncated = bound_telemetry_string(&long).expect("truncated request id");
        assert_eq!(truncated.chars().count(), MAX_TELEMETRY_STRING_CHARS);

        let headers = capture_safe_response_headers([
            ("x-request-id", "  hdr-sk-fixturekey00000001-1  "),
            ("Authorization", "Bearer sk-secret-should-not-leak"),
        ]);
        let header_id = headers.provider_request_id.as_deref().expect("header id");
        assert!(header_id.contains("sk-***"), "{header_id}");
        assert!(!header_id.contains("fixturekey00000001"), "{header_id}");
        assert!(!format!("{headers:?}").contains("sk-secret"));
    }

    #[test]
    fn merge_from_propagates_rejected_certified_and_absent_model_identity() {
        let mut base = ProviderTransportTelemetry {
            response_model: Some("gpt-oss-120b".into()),
            model_identity_status: ModelIdentityStatus::Certified,
            provider_request_id: Some("req-1".into()),
            ..Default::default()
        };
        let invalid_payload = ProviderTransportTelemetry {
            response_model: Some(" sk-fixturekey00000001 ".into()),
            model_identity_status: ModelIdentityStatus::Absent,
            provider_request_id: Some("req-2".into()),
            ..Default::default()
        };
        base.merge_from(&invalid_payload);
        assert_eq!(base.response_model.as_deref(), Some("gpt-oss-120b"));
        assert_eq!(base.model_identity_status, ModelIdentityStatus::Certified);
        assert_eq!(base.provider_request_id.as_deref(), Some("req-2"));

        let rejected = ProviderTransportTelemetry {
            response_model: None,
            model_identity_status: ModelIdentityStatus::Rejected,
            ..Default::default()
        };
        base.merge_from(&rejected);
        assert_eq!(base.response_model, None);
        assert_eq!(base.model_identity_status, ModelIdentityStatus::Rejected);
        assert!(!base.is_empty());

        let absent = ProviderTransportTelemetry::default();
        base.merge_from(&absent);
        assert_eq!(base.response_model, None);
        assert_eq!(base.model_identity_status, ModelIdentityStatus::Rejected);

        let later_valid = ProviderTransportTelemetry {
            response_model: Some("qwen3".into()),
            model_identity_status: ModelIdentityStatus::Certified,
            ..Default::default()
        };
        base.merge_from(&later_valid);
        assert_eq!(base.response_model.as_deref(), Some("qwen3"));
        assert_eq!(base.model_identity_status, ModelIdentityStatus::Certified);

        let mut empty = ProviderTransportTelemetry::default();
        empty.merge_from(&rejected);
        assert_eq!(empty.response_model, None);
        assert_eq!(empty.model_identity_status, ModelIdentityStatus::Rejected);
        let dumped = serde_json::to_string(&empty).unwrap();
        assert!(!dumped.contains("fixturekey00000001"));
        assert!(!dumped.contains("sk-fixture"));
    }

    #[test]
    fn merge_from_preserves_reasoning_effort_labels() {
        let mut base = ProviderTransportTelemetry {
            reasoning_effort_requested: Some("high".into()),
            reasoning_effort_effective: Some("high".into()),
            prompt_tokens: Some(1),
            ..Default::default()
        };
        // Later body usage must not wipe effort labels.
        let body_only = ProviderTransportTelemetry {
            completion_tokens: Some(2),
            ..Default::default()
        };
        base.merge_from(&body_only);
        assert_eq!(base.reasoning_effort_requested.as_deref(), Some("high"));
        assert_eq!(base.reasoning_effort_effective.as_deref(), Some("high"));
        assert_eq!(base.completion_tokens, Some(2));
        assert_eq!(base.prompt_tokens, Some(1));

        // Later Some wins.
        let later = ProviderTransportTelemetry {
            reasoning_effort_requested: Some("low".into()),
            reasoning_effort_effective: Some("low".into()),
            ..Default::default()
        };
        base.merge_from(&later);
        assert_eq!(base.reasoning_effort_requested.as_deref(), Some("low"));
        assert!(!base.is_empty());
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

    #[test]
    fn reported_aggregation_rejects_numeric_overflow() {
        assert_eq!(
            sum_reported_u64_all([u64::MAX, 1], |value| Some(*value)),
            None,
            "an overflowing token sum must remain unknown"
        );
        assert_eq!(
            sum_reported_f64_all([f64::MAX, f64::MAX], |value| Some(*value)),
            None,
            "an infinite cost sum must remain unknown"
        );
        assert_eq!(
            sum_reported_f64_all([f64::NAN], |value| Some(*value)),
            None,
            "a non-finite reported cost must remain unknown"
        );
    }

    #[test]
    fn inconsistent_response_model_states_fail_closed_and_never_emit_rejected_bytes() {
        let adversarial = "https://fixture.invalid/v1";
        let rejected_with_bytes: ProviderTransportTelemetry = serde_json::from_value(json!({
            "modelIdentityStatus": "rejected",
            "responseModel": adversarial,
            "promptTokens": 3
        }))
        .unwrap();
        assert_eq!(
            rejected_with_bytes.model_identity_status,
            ModelIdentityStatus::Rejected
        );
        assert_eq!(rejected_with_bytes.response_model, None);
        assert_eq!(rejected_with_bytes.prompt_tokens, Some(3));
        assert_eq!(
            rejected_with_bytes.response_model_identity(),
            ResponseModelIdentity::Rejected
        );
        let dumped = serde_json::to_string(&rejected_with_bytes).unwrap();
        assert!(!dumped.contains(adversarial));
        assert!(!dumped.contains("fixture.invalid"));
        assert!(dumped.contains("rejected"));

        let absent_with_bytes: ProviderTransportTelemetry = serde_json::from_value(json!({
            "modelIdentityStatus": "absent",
            "responseModel": adversarial
        }))
        .unwrap();
        assert_eq!(
            absent_with_bytes.model_identity_status,
            ModelIdentityStatus::Absent
        );
        assert_eq!(absent_with_bytes.response_model, None);
        assert_eq!(
            absent_with_bytes.response_model_identity(),
            ResponseModelIdentity::Absent
        );
        let dumped = serde_json::to_string(&absent_with_bytes).unwrap();
        assert!(!dumped.contains(adversarial));
        assert!(!dumped.contains("responseModel"));

        let reported_alias: ProviderTransportTelemetry = serde_json::from_value(json!({
            "modelIdentityStatus": "reported",
            "responseModel": "qwen3"
        }))
        .unwrap();
        assert_eq!(
            reported_alias.model_identity_status,
            ModelIdentityStatus::Certified
        );
        assert_eq!(reported_alias.response_model.as_deref(), Some("qwen3"));
        assert_eq!(
            reported_alias.response_model_identity(),
            ResponseModelIdentity::Certified {
                value: "qwen3".into()
            }
        );

        let certified_invalid: ProviderTransportTelemetry = serde_json::from_value(json!({
            "modelIdentityStatus": "certified",
            "responseModel": adversarial
        }))
        .unwrap();
        assert_eq!(
            certified_invalid.model_identity_status,
            ModelIdentityStatus::Rejected
        );
        assert_eq!(certified_invalid.response_model, None);
        assert!(!serde_json::to_string(&certified_invalid)
            .unwrap()
            .contains(adversarial));

        let inconsistent = ProviderTransportTelemetry {
            response_model: Some(adversarial.into()),
            model_identity_status: ModelIdentityStatus::Rejected,
            ..Default::default()
        };
        let dumped = serde_json::to_string(&inconsistent).unwrap();
        assert!(!dumped.contains(adversarial));
        assert!(!dumped.contains("fixture.invalid"));
        let roundtrip: ProviderTransportTelemetry = serde_json::from_str(&dumped).unwrap();
        assert_eq!(roundtrip.response_model, None);
        assert_eq!(
            roundtrip.model_identity_status,
            ModelIdentityStatus::Rejected
        );
    }

    #[test]
    fn turn_identity_serde_is_fail_closed_and_accepts_reported_alias() {
        let adversarial = "https://fixture.invalid/v1";
        let rejected: ProviderTurnTelemetry = serde_json::from_value(json!({
            "configuredProfileId": "profile-a",
            "configuredModel": "configured-a",
            "responseModel": adversarial,
            "modelIdentityStatus": "rejected",
            "observedRoute": {"status": "unknown"},
            "providerRoundCount": 0,
            "emptyVisibleAnswer": false,
            "truncatedByLength": false,
            "toolCallCount": 0
        }))
        .unwrap();
        assert_eq!(rejected.response_model, None);
        assert_eq!(
            rejected.model_identity_status,
            ModelIdentityStatus::Rejected
        );
        let dumped = serde_json::to_string(&rejected).unwrap();
        assert!(!dumped.contains(adversarial));
        assert!(!dumped.contains("fixture.invalid"));

        let reported_alias: ProviderTurnTelemetry = serde_json::from_value(json!({
            "configuredProfileId": "profile-a",
            "configuredModel": "configured-a",
            "responseModel": "qwen3",
            "modelIdentityStatus": "reported",
            "observedRoute": {"status": "unknown"},
            "providerRoundCount": 0,
            "emptyVisibleAnswer": false,
            "truncatedByLength": false,
            "toolCallCount": 0
        }))
        .unwrap();
        assert_eq!(reported_alias.response_model.as_deref(), Some("qwen3"));
        assert_eq!(
            reported_alias.model_identity_status,
            ModelIdentityStatus::Certified
        );
    }
}
