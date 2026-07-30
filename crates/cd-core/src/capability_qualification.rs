//! Explicit synthetic model capability qualification (#724).
//!
//! User-triggered only. Results are keyed by profile + normalized endpoint +
//! exact model id + probe schema version. Name hints from
//! [`crate::model_role_hints`] may select which probes to **offer**, but can
//! never produce a measured `pass`.
//!
//! All probe content is synthetic and data-free. Outbound messages are scrubbed
//! for company/log/workspace/evaluator sentinels. Probe tools are inert.

use crate::model_role_hints::{classify_model_role, ModelRoleHint};
use crate::probe::normalize_gateway_input;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Probe / result schema version (bump when probe contracts change).
pub const QUALIFICATION_SCHEMA_VERSION: &str = "contextdesk.capability_qualification.v1";

/// Synthetic generation prompt — never includes user data.
pub const SYNTH_GENERATION_PROMPT: &str =
    "ContextDesk synthetic qualification probe. Reply with exactly: QUALIFY_OK_V1";

/// Expected generation marker.
pub const SYNTH_GENERATION_MARKER: &str = "QUALIFY_OK_V1";

/// Inert tool name registered only for qualification.
pub const INERT_PROBE_TOOL_NAME: &str = "cd_qualify_echo";

/// Forbidden outbound substrings (company / evaluator / workspace sentinels).
pub const FORBIDDEN_OUTBOUND_SENTINELS: &[&str] = &[
    "company-data",
    "evaluator_truth",
    "EVALUATOR",
    "/Users/",
    "C:\\Users",
    "workspace root",
    "confluence",
    "secret",
    "sk-",
    "Bearer ",
    "password",
];

/// Measured capability identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    /// Basic chat completion with synthetic prompt.
    BasicGeneration,
    /// Model emits a native tool-call shape for the inert probe tool.
    NativeToolCall,
    /// Model continues after a bounded inert tool result.
    ToolResultContinuation,
    /// Structured JSON object where ContextDesk consumes it.
    StructuredOutput,
    /// Streaming yields at least one delta then completes.
    Streaming,
    /// Cancellation stops further tokens after cancel signal.
    Cancellation,
    /// Embedding endpoint returns a finite non-empty vector.
    EmbeddingContract,
    /// Reranker-style ranking response contract.
    RerankerContract,
}

impl CapabilityKind {
    /// Stable wire id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BasicGeneration => "basic_generation",
            Self::NativeToolCall => "native_tool_call",
            Self::ToolResultContinuation => "tool_result_continuation",
            Self::StructuredOutput => "structured_output",
            Self::Streaming => "streaming",
            Self::Cancellation => "cancellation",
            Self::EmbeddingContract => "embedding_contract",
            Self::RerankerContract => "reranker_contract",
        }
    }
}

/// Outcome of one capability check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    /// Probe observed the expected contract.
    Pass,
    /// Partial / weak contract (e.g. stream incomplete but usable).
    Degraded,
    /// Probe failed the expected contract.
    Fail,
    /// Not run (cancelled, gated, or not offered for this role).
    Untested,
}

/// One capability measurement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityCheckResult {
    /// Capability under test.
    pub kind: CapabilityKind,
    /// Measured outcome (never derived from a name hint alone).
    pub status: CapabilityStatus,
    /// Wall time for this probe in milliseconds.
    pub elapsed_ms: u64,
    /// Unix seconds when this check finished.
    pub tested_at: i64,
    /// Secret-free human reason.
    pub reason: String,
}

/// Cache / report identity (no raw secrets; endpoint is fingerprinted).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct QualificationKey {
    /// Provider profile id (local identity, not a secret).
    pub profile_id: String,
    /// SHA-256 hex of normalized endpoint (not the raw private URL).
    pub endpoint_fingerprint: String,
    /// Exact model id selected for qualification.
    pub model_id: String,
    /// Probe schema version that produced the report.
    pub schema_version: String,
}

impl QualificationKey {
    /// Build a key from profile identity fields.
    pub fn new(profile_id: &str, base_url: &str, model_id: &str) -> Self {
        Self {
            profile_id: profile_id.trim().to_string(),
            endpoint_fingerprint: fingerprint_endpoint(base_url),
            model_id: model_id.trim().to_string(),
            schema_version: QUALIFICATION_SCHEMA_VERSION.to_string(),
        }
    }

    /// Compact storage id.
    pub fn storage_id(&self) -> String {
        format!(
            "{}::{}::{}::{}",
            self.profile_id, self.endpoint_fingerprint, self.model_id, self.schema_version
        )
    }
}

/// Full qualification report for one exact profile/endpoint/model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QualificationReport {
    /// Exact profile/endpoint/model/schema identity for this report.
    pub key: QualificationKey,
    /// Per-capability measurements from this run.
    pub checks: Vec<CapabilityCheckResult>,
    /// #723 role hint used only to select which probes ran (never a pass source).
    pub role_hint: String,
    /// True when the user cancelled mid-run.
    pub cancelled: bool,
    /// True when cache is stale relative to current profile/endpoint/model/version.
    pub stale: bool,
    /// Unix seconds when the run finished (or was cancelled).
    pub finished_at: i64,
}

impl QualificationReport {
    /// Status for a kind, or `Untested` if absent.
    pub fn status_of(&self, kind: CapabilityKind) -> CapabilityStatus {
        self.checks
            .iter()
            .find(|c| c.kind == kind)
            .map(|c| c.status)
            .unwrap_or(CapabilityStatus::Untested)
    }
}

/// Profile-level capability flags that remain authoritative over probes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProfileCapabilityGate {
    /// Profile allows tool-calling probes.
    pub tools_enabled: bool,
    /// Profile allows streaming probes.
    pub stream_enabled: bool,
    /// Profile allows embedding probes.
    pub embeddings_enabled: bool,
}

/// In-memory store keyed by [`QualificationKey::storage_id`] (#650 isolation).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct QualificationStore {
    /// Reports keyed by [`QualificationKey::storage_id`].
    #[serde(default)]
    pub by_key: HashMap<String, QualificationReport>,
}

impl QualificationStore {
    /// Insert/replace one report without touching siblings.
    pub fn put(&mut self, report: QualificationReport) {
        self.by_key.insert(report.key.storage_id(), report);
    }

    /// Lookup by exact key.
    pub fn get(&self, key: &QualificationKey) -> Option<&QualificationReport> {
        self.by_key.get(&key.storage_id())
    }

    /// Mark stale when key parts diverge from current profile/endpoint/model/version.
    pub fn mark_stale_if_mismatch(
        &mut self,
        key: &QualificationKey,
        current: &QualificationKey,
    ) -> bool {
        let Some(report) = self.by_key.get_mut(&key.storage_id()) else {
            return false;
        };
        if report.key != *current {
            report.stale = true;
            return true;
        }
        // Same storage id implies same key fields.
        false
    }

    /// Mark prior reports for the **same profile + same model** as stale when
    /// endpoint fingerprint or schema version diverges from the current selection.
    ///
    /// Sibling models on the same profile are never touched (#650 isolation).
    /// Returns how many reports were newly marked stale.
    pub fn mark_stale_for_selection(&mut self, current: &QualificationKey) -> usize {
        let mut n = 0;
        for report in self.by_key.values_mut() {
            // Same exact model identity only — never sibling model_ids.
            if report.key.profile_id != current.profile_id
                || report.key.model_id != current.model_id
            {
                continue;
            }
            // Exact match (including schema) stays fresh.
            if report.key == *current {
                continue;
            }
            // Endpoint and/or schema diverged for this exact model.
            if !report.stale {
                report.stale = true;
                n += 1;
            }
        }
        n
    }

    /// Best cached report for the current selection: exact hit, else a near-miss
    /// (same profile + **same model**, different endpoint/schema) returned as stale.
    ///
    /// Never returns or mutates a sibling model_id (#650).
    pub fn get_for_selection(
        &mut self,
        current: &QualificationKey,
    ) -> Option<&QualificationReport> {
        self.mark_stale_for_selection(current);
        if self.by_key.contains_key(&current.storage_id()) {
            return self.by_key.get(&current.storage_id());
        }
        // Near miss: same profile + model under a previous endpoint/schema only.
        let near_id = self
            .by_key
            .values()
            .find(|r| {
                r.key.profile_id == current.profile_id
                    && r.key.model_id == current.model_id
                    && r.key != *current
            })
            .map(|r| r.key.storage_id());
        near_id.and_then(|id| self.by_key.get(&id))
    }

    /// Drop one exact model result only.
    pub fn remove(&mut self, key: &QualificationKey) -> bool {
        self.by_key.remove(&key.storage_id()).is_some()
    }
}

/// Synthetic chat request (data-free).
#[derive(Debug, Clone)]
pub struct SyntheticChatRequest {
    /// Exact model id for this request.
    pub model_id: String,
    /// Synthetic messages only (no user/workspace content).
    pub messages: Vec<SyntheticMessage>,
    /// Inert tools offered for this probe (if any).
    pub tools: Vec<InertToolSpec>,
    /// Whether the transport should stream tokens.
    pub stream: bool,
    /// Whether the transport should request JSON-object structured output.
    pub expect_json_object: bool,
}

/// Chat message for probes.
#[derive(Debug, Clone)]
pub struct SyntheticMessage {
    /// OpenAI-style role (`user`, `assistant`, `tool`, …).
    pub role: String,
    /// Message body (synthetic only).
    pub content: String,
    /// Tool-call id when role is `tool`.
    pub tool_call_id: Option<String>,
    /// Native tool calls when role is `assistant`.
    pub tool_calls: Vec<SyntheticToolCall>,
}

/// Tool call emitted by the model (or injected in scripted transport).
#[derive(Debug, Clone)]
pub struct SyntheticToolCall {
    /// Provider tool-call id.
    pub id: String,
    /// Tool function name.
    pub name: String,
    /// JSON arguments string.
    pub arguments_json: String,
}

/// Inert tool offered to the model during qualification.
#[derive(Debug, Clone)]
pub struct InertToolSpec {
    /// Tool name (must be the host-validated inert name).
    pub name: String,
    /// Short description shown to the model.
    pub description: String,
    /// JSON Schema parameters object as a string.
    pub parameters_json: String,
}

/// Response from a non-stream or completed stream probe.
#[derive(Debug, Clone, Default)]
pub struct SyntheticChatResponse {
    /// Assistant text content.
    pub content: String,
    /// Native tool calls (empty when prose-only).
    pub tool_calls: Vec<SyntheticToolCall>,
    /// True when at least one stream delta was observed.
    pub streamed: bool,
    /// True when cancel stopped further tokens.
    pub cancelled: bool,
    /// Transport-level error text (secret-scrubbed before reporting).
    pub raw_error: Option<String>,
}

/// Embedding probe response.
#[derive(Debug, Clone, Default)]
pub struct SyntheticEmbeddingResponse {
    /// Finite non-empty embedding vector on success.
    pub vector: Vec<f32>,
    /// Transport-level error text when the call failed.
    pub raw_error: Option<String>,
}

/// Reranker probe response (ordered document indices).
#[derive(Debug, Clone, Default)]
pub struct SyntheticRerankResponse {
    /// Ordered document ids from best to worst.
    pub ranked_ids: Vec<String>,
    /// Transport-level error text when the call failed.
    pub raw_error: Option<String>,
}

/// Transport errors (secret-free reasons for reports).
#[derive(Debug, Clone)]
pub struct TransportError {
    /// Secret-free failure reason.
    pub reason: String,
}

/// Injectable transport for qualification (mock in tests; live in host).
pub trait QualificationTransport {
    /// Non-stream chat completion (or stream collected to a final message).
    fn chat_complete(
        &mut self,
        req: &SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, TransportError>;

    /// Embedding vector for a synthetic text.
    fn embed(
        &mut self,
        model_id: &str,
        text: &str,
        cancel: &AtomicBool,
    ) -> Result<SyntheticEmbeddingResponse, TransportError>;

    /// Rerank synthetic document ids for a synthetic query.
    fn rerank(
        &mut self,
        model_id: &str,
        query: &str,
        document_ids: &[&str],
        cancel: &AtomicBool,
    ) -> Result<SyntheticRerankResponse, TransportError>;
}

/// Fingerprint a base URL without retaining the private host string in exports.
pub fn fingerprint_endpoint(base_url: &str) -> String {
    let normalized = normalize_gateway_input(base_url);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Which capability probes to offer based on #723 role hint (never a pass).
pub fn probes_for_role_hint(role: ModelRoleHint) -> Vec<CapabilityKind> {
    match role {
        ModelRoleHint::Investigator | ModelRoleHint::Unknown => vec![
            CapabilityKind::BasicGeneration,
            CapabilityKind::NativeToolCall,
            CapabilityKind::ToolResultContinuation,
            CapabilityKind::StructuredOutput,
            CapabilityKind::Streaming,
            CapabilityKind::Cancellation,
        ],
        ModelRoleHint::Embedding => vec![CapabilityKind::EmbeddingContract],
        ModelRoleHint::Reranker => vec![CapabilityKind::RerankerContract],
    }
}

/// Inert tool definitions (host must validate — no filesystem/network).
pub fn inert_probe_tools() -> Vec<InertToolSpec> {
    vec![InertToolSpec {
        name: INERT_PROBE_TOOL_NAME.into(),
        description:
            "ContextDesk synthetic qualification echo. Returns the provided token. No side effects."
                .into(),
        parameters_json:
            r#"{"type":"object","properties":{"token":{"type":"string"}},"required":["token"]}"#
                .into(),
    }]
}

/// Host-side execution of the inert tool (pure, no I/O).
pub fn execute_inert_probe_tool(name: &str, arguments_json: &str) -> Result<String, String> {
    if name != INERT_PROBE_TOOL_NAME {
        return Err("unknown_probe_tool".into());
    }
    let v: serde_json::Value =
        serde_json::from_str(arguments_json).map_err(|_| "invalid_tool_arguments".to_string())?;
    let token = v
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "missing_token".to_string())?;
    if token.len() > 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("token_rejected".into());
    }
    Ok(format!(r#"{{"echo":"{token}"}}"#))
}

/// Assert outbound text has no forbidden sentinels (for tests and host scrub).
pub fn assert_outbound_clean(text: &str) -> Result<(), String> {
    let lower = text.to_ascii_lowercase();
    for s in FORBIDDEN_OUTBOUND_SENTINELS {
        if lower.contains(&s.to_ascii_lowercase()) {
            return Err(format!("forbidden_sentinel:{s}"));
        }
    }
    Ok(())
}

/// Scrub free-text reasons for accidental secret shapes.
pub fn redact_reason(raw: &str) -> String {
    let mut out = raw.to_string();
    for s in FORBIDDEN_OUTBOUND_SENTINELS {
        if out.to_ascii_lowercase().contains(&s.to_ascii_lowercase()) {
            out = out.replace(s, "[redacted]");
        }
    }
    // Truncate long provider dumps.
    if out.len() > 240 {
        out.truncate(240);
        out.push('…');
    }
    out
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn elapsed_ms(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn check(
    kind: CapabilityKind,
    status: CapabilityStatus,
    start: std::time::Instant,
    reason: impl Into<String>,
) -> CapabilityCheckResult {
    CapabilityCheckResult {
        kind,
        status,
        elapsed_ms: elapsed_ms(start),
        tested_at: now_secs(),
        reason: redact_reason(&reason.into()),
    }
}

/// Run a qualification suite against an injectable transport.
///
/// `cancel` is the **user** cancel flag only. The cancellation *capability*
/// probe uses a probe-local signal and must never set this flag.
pub fn run_qualification(
    key: QualificationKey,
    gate: ProfileCapabilityGate,
    transport: &mut dyn QualificationTransport,
    cancel: &Arc<AtomicBool>,
) -> QualificationReport {
    let role = classify_model_role(&key.model_id);
    let offered = probes_for_role_hint(role.role);
    let mut checks = Vec::new();

    for kind in offered {
        // User cancel (or residual flag): fill remaining as untested — never skip rows.
        if cancel.load(Ordering::SeqCst) {
            checks.push(check(
                kind,
                CapabilityStatus::Untested,
                std::time::Instant::now(),
                "cancelled before probe",
            ));
            continue;
        }
        let start = std::time::Instant::now();
        let result = match kind {
            CapabilityKind::BasicGeneration => probe_basic_generation(transport, &key, cancel),
            CapabilityKind::NativeToolCall => {
                if !gate.tools_enabled {
                    check(
                        kind,
                        CapabilityStatus::Fail,
                        start,
                        "profile tools disabled (authoritative)",
                    )
                } else {
                    probe_native_tool_call(transport, &key, cancel)
                }
            }
            CapabilityKind::ToolResultContinuation => {
                if !gate.tools_enabled {
                    check(
                        kind,
                        CapabilityStatus::Fail,
                        start,
                        "profile tools disabled (authoritative)",
                    )
                } else {
                    probe_tool_result_continuation(transport, &key, cancel)
                }
            }
            CapabilityKind::StructuredOutput => probe_structured_output(transport, &key, cancel),
            CapabilityKind::Streaming => {
                if !gate.stream_enabled {
                    check(
                        kind,
                        CapabilityStatus::Fail,
                        start,
                        "profile stream disabled (authoritative)",
                    )
                } else {
                    probe_streaming(transport, &key, cancel)
                }
            }
            CapabilityKind::Cancellation => probe_cancellation(transport, &key, cancel),
            CapabilityKind::EmbeddingContract => {
                if !gate.embeddings_enabled {
                    check(
                        kind,
                        CapabilityStatus::Fail,
                        start,
                        "profile embeddings disabled (authoritative)",
                    )
                } else {
                    probe_embedding(transport, &key, cancel)
                }
            }
            CapabilityKind::RerankerContract => probe_reranker(transport, &key, cancel),
        };
        checks.push(result);
        // Do not break: remaining kinds are filled as untested on the next iterations.
    }

    // Name hint must never appear as a measured pass source — only role_hint field.
    // report.cancelled means the *user* cancel flag only (not the cancellation probe).
    QualificationReport {
        key,
        checks,
        role_hint: role.role.as_kind_str().to_string(),
        cancelled: cancel.load(Ordering::SeqCst),
        stale: false,
        finished_at: now_secs(),
    }
}

fn probe_basic_generation(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: SYNTH_GENERATION_PROMPT.into(),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: vec![],
        stream: false,
        expect_json_object: false,
    };
    if let Err(e) = assert_outbound_clean(&req.messages[0].content) {
        return check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Fail,
            start,
            e,
        );
    }
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if cancel.load(Ordering::SeqCst) || resp.cancelled => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Untested,
            start,
            "cancelled during generation",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_else(|| "provider_error".into()),
        ),
        Ok(resp) if resp.content.contains(SYNTH_GENERATION_MARKER) => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Pass,
            start,
            "synthetic marker present in completion",
        ),
        Ok(resp) if !resp.content.trim().is_empty() => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Degraded,
            start,
            "completion non-empty but missing synthetic marker",
        ),
        Ok(_) => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Fail,
            start,
            "empty completion",
        ),
        Err(e) => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_native_tool_call(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: format!(
                "ContextDesk synthetic tool probe. Call tool {INERT_PROBE_TOOL_NAME} with token QUALIFY_TOOL_V1."
            ),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: inert_probe_tools(),
        stream: false,
        expect_json_object: false,
    };
    let _ = assert_outbound_clean(&req.messages[0].content);
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if resp.cancelled || cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::NativeToolCall,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => {
            let reason = resp.raw_error.unwrap_or_default();
            if reason.contains("tools_unsupported") {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Fail,
                    start,
                    "tools_unsupported",
                )
            } else {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Fail,
                    start,
                    reason,
                )
            }
        }
        Ok(resp) => {
            let hit = resp
                .tool_calls
                .iter()
                .any(|t| t.name == INERT_PROBE_TOOL_NAME);
            // Fabricated prose that only *mentions* tools must not pass.
            let prose_fake =
                resp.content.contains(INERT_PROBE_TOOL_NAME) && resp.tool_calls.is_empty();
            if hit {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Pass,
                    start,
                    "native tool_call for inert probe tool",
                )
            } else if prose_fake {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Fail,
                    start,
                    "tool-shaped prose without native tool_call",
                )
            } else {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Fail,
                    start,
                    "no native tool_call observed",
                )
            }
        }
        Err(e) => check(
            CapabilityKind::NativeToolCall,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_tool_result_continuation(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let tool_result =
        match execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"QUALIFY_TOOL_V1"}"#) {
            Ok(s) => s,
            Err(e) => {
                return check(
                    CapabilityKind::ToolResultContinuation,
                    CapabilityStatus::Fail,
                    start,
                    e,
                );
            }
        };
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![
            SyntheticMessage {
                role: "user".into(),
                content: "ContextDesk synthetic continuation probe.".into(),
                tool_call_id: None,
                tool_calls: vec![],
            },
            SyntheticMessage {
                role: "assistant".into(),
                content: String::new(),
                tool_call_id: None,
                tool_calls: vec![SyntheticToolCall {
                    id: "call_qualify_1".into(),
                    name: INERT_PROBE_TOOL_NAME.into(),
                    arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                }],
            },
            SyntheticMessage {
                role: "tool".into(),
                content: tool_result,
                tool_call_id: Some("call_qualify_1".into()),
                tool_calls: vec![],
            },
        ],
        tools: inert_probe_tools(),
        stream: false,
        expect_json_object: false,
    };
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if resp.cancelled || cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_default(),
        ),
        Ok(resp) if !resp.content.trim().is_empty() => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Pass,
            start,
            "non-empty continuation after inert tool result",
        ),
        Ok(_) => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Fail,
            start,
            "empty continuation",
        ),
        Err(e) => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_structured_output(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: r#"ContextDesk synthetic structured probe. Reply with JSON only: {"qualify":"ok","v":1}"#.into(),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: vec![],
        stream: false,
        expect_json_object: true,
    };
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if resp.cancelled || cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::StructuredOutput,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::StructuredOutput,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_default(),
        ),
        Ok(resp) => {
            let parsed = serde_json::from_str::<serde_json::Value>(resp.content.trim());
            match parsed {
                Ok(v) if v.get("qualify").and_then(|x| x.as_str()) == Some("ok") => check(
                    CapabilityKind::StructuredOutput,
                    CapabilityStatus::Pass,
                    start,
                    "valid synthetic JSON object",
                ),
                Ok(_) => check(
                    CapabilityKind::StructuredOutput,
                    CapabilityStatus::Degraded,
                    start,
                    "JSON object missing expected fields",
                ),
                Err(_) => check(
                    CapabilityKind::StructuredOutput,
                    CapabilityStatus::Fail,
                    start,
                    "response is not a JSON object",
                ),
            }
        }
        Err(e) => check(
            CapabilityKind::StructuredOutput,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_streaming(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: SYNTH_GENERATION_PROMPT.into(),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: vec![],
        stream: true,
        expect_json_object: false,
    };
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if resp.cancelled || cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.streamed && !resp.content.is_empty() => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Pass,
            start,
            "stream deltas observed",
        ),
        Ok(resp) if !resp.content.is_empty() => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Degraded,
            start,
            "completion without stream flag",
        ),
        Ok(_) => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Fail,
            start,
            "no stream content",
        ),
        Err(e) => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_cancellation(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    user_cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    // User cancel before this probe: leave untested (do not measure).
    if user_cancel.load(Ordering::SeqCst) {
        return check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Untested,
            start,
            "cancelled before probe",
        );
    }
    // Probe-local cancel signal only — never store into the user-cancel flag.
    // report.cancelled must mean the user cancelled the qualification run.
    let probe_cancel = AtomicBool::new(true);
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: SYNTH_GENERATION_PROMPT.into(),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: vec![],
        stream: true,
        expect_json_object: false,
    };
    match transport.chat_complete(&req, &probe_cancel) {
        Ok(resp) if resp.cancelled => check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Pass,
            start,
            "transport reported cancelled",
        ),
        Err(e) if e.reason.to_ascii_lowercase().contains("cancel") => check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Pass,
            start,
            "cancelled via transport error",
        ),
        Ok(_) => check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Fail,
            start,
            "completion ignored cancel signal",
        ),
        Err(e) => check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_embedding(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let text = "ContextDesk synthetic embed token QUALIFY_EMBED_V1";
    let _ = assert_outbound_clean(text);
    match transport.embed(&key.model_id, text, cancel) {
        Ok(resp) if cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_default(),
        ),
        Ok(resp) if !resp.vector.is_empty() && resp.vector.iter().all(|f| f.is_finite()) => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Pass,
            start,
            format!("vector_len={}", resp.vector.len()),
        ),
        Ok(_) => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Fail,
            start,
            "empty or non-finite embedding",
        ),
        Err(e) => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_reranker(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let docs = ["doc_a", "doc_b", "doc_c"];
    let query = "ContextDesk synthetic rerank query QUALIFY_RERANK_V1";
    let _ = assert_outbound_clean(query);
    match transport.rerank(&key.model_id, query, &docs, cancel) {
        Ok(resp) if cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::RerankerContract,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::RerankerContract,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_default(),
        ),
        Ok(resp)
            if !resp.ranked_ids.is_empty()
                && resp.ranked_ids.iter().all(|id| docs.contains(&id.as_str())) =>
        {
            check(
                CapabilityKind::RerankerContract,
                CapabilityStatus::Pass,
                start,
                "ranked ids are a permutation of synthetic docs",
            )
        }
        Ok(_) => check(
            CapabilityKind::RerankerContract,
            CapabilityStatus::Fail,
            start,
            "malformed rerank ranking",
        ),
        Err(e) => check(
            CapabilityKind::RerankerContract,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

// ---------------------------------------------------------------------------
// Scripted mock transport for deterministic tests
// ---------------------------------------------------------------------------

/// Scripted responses for unit tests (no network).
#[derive(Debug, Default)]
pub struct ScriptedQualificationTransport {
    /// FIFO of chat responses (popped from the end).
    pub chat_queue: Vec<Result<SyntheticChatResponse, TransportError>>,
    /// FIFO of embedding responses (popped from the end).
    pub embed_queue: Vec<Result<SyntheticEmbeddingResponse, TransportError>>,
    /// FIFO of rerank responses (popped from the end).
    pub rerank_queue: Vec<Result<SyntheticRerankResponse, TransportError>>,
    /// Last chat request observed (for outbound scrub assertions).
    pub last_chat: Option<SyntheticChatRequest>,
    /// Last embedding text observed.
    pub last_embed_text: Option<String>,
    /// Last rerank query observed.
    pub last_rerank_query: Option<String>,
    /// When true, cancelled flags short-circuit before consuming queues.
    pub honor_cancel: bool,
}

impl QualificationTransport for ScriptedQualificationTransport {
    fn chat_complete(
        &mut self,
        req: &SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, TransportError> {
        self.last_chat = Some(req.clone());
        if self.honor_cancel && cancel.load(Ordering::SeqCst) {
            return Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            });
        }
        self.chat_queue
            .pop()
            .unwrap_or_else(|| {
                Err(TransportError {
                    reason: "scripted_chat_exhausted".into(),
                })
            })
            .map(|mut r| {
                if req.stream {
                    r.streamed = true;
                }
                r
            })
    }

    fn embed(
        &mut self,
        _model_id: &str,
        text: &str,
        cancel: &AtomicBool,
    ) -> Result<SyntheticEmbeddingResponse, TransportError> {
        self.last_embed_text = Some(text.to_string());
        if self.honor_cancel && cancel.load(Ordering::SeqCst) {
            return Err(TransportError {
                reason: "cancelled".into(),
            });
        }
        self.embed_queue.pop().unwrap_or_else(|| {
            Err(TransportError {
                reason: "scripted_embed_exhausted".into(),
            })
        })
    }

    fn rerank(
        &mut self,
        _model_id: &str,
        query: &str,
        _document_ids: &[&str],
        cancel: &AtomicBool,
    ) -> Result<SyntheticRerankResponse, TransportError> {
        self.last_rerank_query = Some(query.to_string());
        if self.honor_cancel && cancel.load(Ordering::SeqCst) {
            return Err(TransportError {
                reason: "cancelled".into(),
            });
        }
        self.rerank_queue.pop().unwrap_or_else(|| {
            Err(TransportError {
                reason: "scripted_rerank_exhausted".into(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(model: &str) -> QualificationKey {
        QualificationKey::new("profile-a", "https://gateway.example.com/v1", model)
    }

    fn gate_full() -> ProfileCapabilityGate {
        ProfileCapabilityGate {
            tools_enabled: true,
            stream_enabled: true,
            embeddings_enabled: true,
        }
    }

    #[test]
    fn name_hint_cannot_produce_measured_pass() {
        // Even with a strong investigator name, empty scripted responses fail.
        let mut t = ScriptedQualificationTransport::default();
        // Exhaust queues → fails, not pass from name.
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert!(
            report
                .checks
                .iter()
                .all(|c| c.status != CapabilityStatus::Pass),
            "name alone must not pass: {:?}",
            report.checks
        );
        assert_eq!(report.role_hint, "chat");
    }

    #[test]
    fn success_path_basic_generation_and_tools() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            ..Default::default()
        };
        // probes order for investigator: gen, tool, continuation, structured, stream, cancel
        // cancel probe sets cancel=true first; honor_cancel returns cancelled → pass for cancel
        // Queue is LIFO via insert(0) — push in reverse run order.
        // Run order: gen, tool, cont, struct, stream, cancel
        // pop order: last pushed first. Push cancel first ... then gen last with insert(0) means
        // insert(0) puts at front; pop takes from end. Use push to end:
        t.chat_queue.clear();
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: SYNTH_GENERATION_MARKER.into(),
            ..Default::default()
        })); // gen
        t.chat_queue.push(Ok(SyntheticChatResponse {
            tool_calls: vec![SyntheticToolCall {
                id: "c1".into(),
                name: INERT_PROBE_TOOL_NAME.into(),
                arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
            }],
            ..Default::default()
        })); // tool
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: "continued".into(),
            ..Default::default()
        })); // cont
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: r#"{"qualify":"ok","v":1}"#.into(),
            ..Default::default()
        })); // struct
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: SYNTH_GENERATION_MARKER.into(),
            streamed: true,
            ..Default::default()
        })); // stream
             // cancel uses honor_cancel after cancel flag set
        t.chat_queue.push(Ok(SyntheticChatResponse {
            cancelled: true,
            ..Default::default()
        }));

        // pop takes from end — so reverse the queue
        t.chat_queue.reverse();

        let report = run_qualification(
            key("gpt-4o-mini"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::NativeToolCall),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::ToolResultContinuation),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::StructuredOutput),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::Streaming),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::Cancellation),
            CapabilityStatus::Pass
        );
        // Cancellation *probe* must not set report.cancelled (user-cancel only).
        assert!(
            !report.cancelled,
            "cancellation probe must not mark the run as user-cancelled"
        );
    }

    #[test]
    fn fabricated_tool_prose_fails_native_tool_call() {
        let mut t = ScriptedQualificationTransport::default();
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: format!("I would call {INERT_PROBE_TOOL_NAME} now"),
            tool_calls: vec![],
            ..Default::default()
        }));
        // Only run tool probe: use embedding model role to limit? Better call probe directly
        // via run with role that only has tools — use investigator and only check tool after gen fails
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: SYNTH_GENERATION_MARKER.into(),
            ..Default::default()
        }));
        t.chat_queue.reverse();
        // Actually fill enough stubs
        for _ in 0..6 {
            if t.chat_queue.len() < 6 {
                t.chat_queue.insert(
                    0,
                    Ok(SyntheticChatResponse {
                        content: "x".into(),
                        ..Default::default()
                    }),
                );
            }
        }
        let mut t = ScriptedQualificationTransport::default();
        // reverse-pop: push gen first then tool
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: format!("please use {INERT_PROBE_TOOL_NAME}"),
                tool_calls: vec![],
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "c".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "{}".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "s".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        t.honor_cancel = true;
        let report = run_qualification(
            key("claude-sonnet"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::NativeToolCall),
            CapabilityStatus::Fail
        );
        assert!(report
            .checks
            .iter()
            .find(|c| c.kind == CapabilityKind::NativeToolCall)
            .unwrap()
            .reason
            .contains("prose"));
    }

    #[test]
    fn profile_tools_disabled_is_authoritative() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            ..Default::default()
        };
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            // tools probes should not even need responses
            Ok(SyntheticChatResponse {
                content: "s".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: r#"{"qualify":"ok","v":1}"#.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        // Need enough for gen, stream, structured, cancel — tools short-circuit
        // order: gen, tool(fail gate), cont(fail gate), struct, stream, cancel
        responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: r#"{"qualify":"ok","v":1}"#.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "stream".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        let gate = ProfileCapabilityGate {
            tools_enabled: false,
            stream_enabled: true,
            embeddings_enabled: true,
        };
        let report = run_qualification(
            key("mistral"),
            gate,
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::NativeToolCall),
            CapabilityStatus::Fail
        );
        assert!(report
            .checks
            .iter()
            .find(|c| c.kind == CapabilityKind::NativeToolCall)
            .unwrap()
            .reason
            .contains("profile tools disabled"));
    }

    #[test]
    fn sibling_model_isolation_in_store() {
        let mut store = QualificationStore::default();
        let k1 = key("model-a");
        let k2 = QualificationKey::new("profile-a", "https://gateway.example.com/v1", "model-b");
        store.put(QualificationReport {
            key: k1.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Pass,
                std::time::Instant::now(),
                "ok",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        store.put(QualificationReport {
            key: k2.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Fail,
                std::time::Instant::now(),
                "fail",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert_eq!(
            store
                .get(&k1)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Pass
        );
        assert_eq!(
            store
                .get(&k2)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Fail
        );
        store.remove(&k1);
        assert!(store.get(&k1).is_none());
        assert!(store.get(&k2).is_some());
    }

    #[test]
    fn endpoint_or_model_change_changes_cache_key() {
        let a = QualificationKey::new("p", "https://a.example.com/v1", "m");
        let b = QualificationKey::new("p", "https://b.example.com/v1", "m");
        let c = QualificationKey::new("p", "https://a.example.com/v1", "m2");
        assert_ne!(a.storage_id(), b.storage_id());
        assert_ne!(a.storage_id(), c.storage_id());
        assert_ne!(a.endpoint_fingerprint, b.endpoint_fingerprint);
    }

    #[test]
    fn outbound_sentinels_rejected() {
        assert!(assert_outbound_clean(SYNTH_GENERATION_PROMPT).is_ok());
        assert!(assert_outbound_clean("please read company-data dump").is_err());
        assert!(assert_outbound_clean("path /Users/me/secret").is_err());
    }

    #[test]
    fn inert_tool_has_no_side_effects_and_rejects_unknown() {
        let ok = execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"ABC_1"}"#).unwrap();
        assert!(ok.contains("ABC_1"));
        assert!(execute_inert_probe_tool("write_file", r#"{}"#).is_err());
        assert!(
            execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"../etc/passwd"}"#)
                .is_err()
        );
    }

    #[test]
    fn embedding_and_reranker_roles_offer_specialty_probes_only() {
        assert_eq!(
            probes_for_role_hint(ModelRoleHint::Embedding),
            vec![CapabilityKind::EmbeddingContract]
        );
        assert_eq!(
            probes_for_role_hint(ModelRoleHint::Reranker),
            vec![CapabilityKind::RerankerContract]
        );
        let mut t = ScriptedQualificationTransport::default();
        t.embed_queue.push(Ok(SyntheticEmbeddingResponse {
            vector: vec![0.1, 0.2, 0.3],
            raw_error: None,
        }));
        let report = run_qualification(
            key("bge-m3"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(report.checks.len(), 1);
        assert_eq!(
            report.status_of(CapabilityKind::EmbeddingContract),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Untested
        );
    }

    #[test]
    fn malformed_embedding_and_rerank_fail() {
        let mut t = ScriptedQualificationTransport::default();
        t.embed_queue.push(Ok(SyntheticEmbeddingResponse {
            vector: vec![f32::NAN],
            raw_error: None,
        }));
        let report = run_qualification(
            key("nomic-embed-text"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::EmbeddingContract),
            CapabilityStatus::Fail
        );

        let mut t2 = ScriptedQualificationTransport::default();
        t2.rerank_queue.push(Ok(SyntheticRerankResponse {
            ranked_ids: vec!["not_a_doc".into()],
            raw_error: None,
        }));
        let report2 = run_qualification(
            key("qwen3-reranker-0.6b"),
            gate_full(),
            &mut t2,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report2.status_of(CapabilityKind::RerankerContract),
            CapabilityStatus::Fail
        );
    }

    #[test]
    fn cancel_before_run_marks_remaining_untested() {
        let mut t = ScriptedQualificationTransport::default();
        let cancel = Arc::new(AtomicBool::new(true));
        let report = run_qualification(key("gpt-4"), gate_full(), &mut t, &cancel);
        assert!(report.cancelled);
        let offered = probes_for_role_hint(ModelRoleHint::Investigator);
        assert_eq!(report.checks.len(), offered.len());
        assert!(report
            .checks
            .iter()
            .all(|c| c.status == CapabilityStatus::Untested));
    }

    #[test]
    fn user_cancel_mid_run_fills_remaining_as_untested() {
        /// Transport that cancels the *user* flag after the first chat call.
        struct CancelAfterFirst {
            cancel: Arc<AtomicBool>,
            inner: ScriptedQualificationTransport,
            calls: usize,
        }
        impl QualificationTransport for CancelAfterFirst {
            fn chat_complete(
                &mut self,
                req: &SyntheticChatRequest,
                cancel: &AtomicBool,
            ) -> Result<SyntheticChatResponse, TransportError> {
                // Raise user-cancel only *after* the first probe has fully returned,
                // so the first measured check is not reclassified as untested.
                if self.calls >= 1 {
                    self.cancel.store(true, Ordering::SeqCst);
                }
                self.calls += 1;
                self.inner.chat_complete(req, cancel)
            }
            fn embed(
                &mut self,
                model_id: &str,
                text: &str,
                cancel: &AtomicBool,
            ) -> Result<SyntheticEmbeddingResponse, TransportError> {
                self.inner.embed(model_id, text, cancel)
            }
            fn rerank(
                &mut self,
                model_id: &str,
                query: &str,
                document_ids: &[&str],
                cancel: &AtomicBool,
            ) -> Result<SyntheticRerankResponse, TransportError> {
                self.inner.rerank(model_id, query, document_ids, cancel)
            }
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let mut t = CancelAfterFirst {
            cancel: cancel.clone(),
            inner: ScriptedQualificationTransport {
                chat_queue: vec![Ok(SyntheticChatResponse {
                    content: SYNTH_GENERATION_MARKER.into(),
                    ..Default::default()
                })],
                honor_cancel: true,
                ..Default::default()
            },
            calls: 0,
        };
        let report = run_qualification(key("gpt-4o"), gate_full(), &mut t, &cancel);
        assert!(report.cancelled);
        let offered = probes_for_role_hint(ModelRoleHint::Investigator);
        assert_eq!(report.checks.len(), offered.len());
        assert_eq!(
            report.status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Pass
        );
        // All remaining after first must be untested (not omitted).
        let untested = report
            .checks
            .iter()
            .filter(|c| c.status == CapabilityStatus::Untested)
            .count();
        assert!(
            untested >= offered.len() - 1,
            "expected remaining untested after user cancel, got {:?}",
            report.checks
        );
    }

    #[test]
    fn cancellation_probe_does_not_set_user_cancelled_flag() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            chat_queue: {
                let mut q = vec![
                    Ok(SyntheticChatResponse {
                        content: SYNTH_GENERATION_MARKER.into(),
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        tool_calls: vec![SyntheticToolCall {
                            id: "c1".into(),
                            name: INERT_PROBE_TOOL_NAME.into(),
                            arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                        }],
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        content: "continued".into(),
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        content: r#"{"qualify":"ok","v":1}"#.into(),
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        content: "s".into(),
                        streamed: true,
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        cancelled: true,
                        ..Default::default()
                    }),
                ];
                q.reverse();
                q
            },
            ..Default::default()
        };
        let user_cancel = Arc::new(AtomicBool::new(false));
        let report = run_qualification(key("gpt-4o"), gate_full(), &mut t, &user_cancel);
        assert!(
            !user_cancel.load(Ordering::SeqCst),
            "cancellation probe must not store into the user-cancel flag"
        );
        assert!(!report.cancelled);
        assert_eq!(
            report.status_of(CapabilityKind::Cancellation),
            CapabilityStatus::Pass
        );
    }

    #[test]
    fn timeout_fails_basic_generation() {
        let mut t = ScriptedQualificationTransport::default();
        t.chat_queue.push(Err(TransportError {
            reason: "timeout after 30s".into(),
        }));
        // fill remaining with fails
        for _ in 0..5 {
            t.chat_queue.insert(
                0,
                Ok(SyntheticChatResponse {
                    content: String::new(),
                    ..Default::default()
                }),
            );
        }
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Fail
        );
        assert!(report
            .checks
            .iter()
            .find(|c| c.kind == CapabilityKind::BasicGeneration)
            .unwrap()
            .reason
            .contains("timeout"));
        assert!(!report.cancelled);
    }

    #[test]
    fn streaming_interruption_marks_stream_untested() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            ..Default::default()
        };
        // gen, tool, cont, struct, stream(cancelled), cancel-probe
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                tool_calls: vec![SyntheticToolCall {
                    id: "c1".into(),
                    name: INERT_PROBE_TOOL_NAME.into(),
                    arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                }],
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "continued".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: r#"{"qualify":"ok","v":1}"#.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "partial".into(),
                streamed: true,
                cancelled: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::Streaming),
            CapabilityStatus::Untested
        );
        assert!(!report.cancelled);
    }

    #[test]
    fn malformed_structured_output_fails() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            ..Default::default()
        };
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                tool_calls: vec![SyntheticToolCall {
                    id: "c1".into(),
                    name: INERT_PROBE_TOOL_NAME.into(),
                    arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                }],
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "continued".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "this is not json at all".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "s".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::StructuredOutput),
            CapabilityStatus::Fail
        );
        assert!(report
            .checks
            .iter()
            .find(|c| c.kind == CapabilityKind::StructuredOutput)
            .unwrap()
            .reason
            .contains("not a JSON"));
    }

    #[test]
    fn store_retry_overwrites_previous_result() {
        let mut store = QualificationStore::default();
        let k = key("model-retry");
        store.put(QualificationReport {
            key: k.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Fail,
                std::time::Instant::now(),
                "first fail",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert_eq!(
            store
                .get(&k)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Fail
        );
        // Retry: replace with pass (clear+put or put overwrite).
        store.remove(&k);
        store.put(QualificationReport {
            key: k.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Pass,
                std::time::Instant::now(),
                "retry pass",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert_eq!(
            store
                .get(&k)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Pass
        );
        assert_eq!(store.by_key.len(), 1);
    }

    #[test]
    fn endpoint_change_marks_prior_report_stale_for_selection() {
        let mut store = QualificationStore::default();
        let old = QualificationKey::new("profile-a", "https://a.example.com/v1", "model-x");
        let current = QualificationKey::new("profile-a", "https://b.example.com/v1", "model-x");
        store.put(QualificationReport {
            key: old.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Pass,
                std::time::Instant::now(),
                "old endpoint",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert!(store.get(&current).is_none());
        let n = store.mark_stale_for_selection(&current);
        assert_eq!(n, 1);
        assert!(store.get(&old).unwrap().stale);
        let near = store.get_for_selection(&current).unwrap();
        assert!(near.stale);
        assert_eq!(near.key.model_id, "model-x");
    }

    #[test]
    fn sibling_model_not_marked_stale_when_selecting_other_model() {
        // #650: selecting model-A (new endpoint) must never mutate model-B's report.
        let mut store = QualificationStore::default();
        let model_a_old = QualificationKey::new("profile-a", "https://a.example.com/v1", "model-a");
        let model_a_new = QualificationKey::new("profile-a", "https://b.example.com/v1", "model-a");
        let model_b = QualificationKey::new("profile-a", "https://a.example.com/v1", "model-b");
        store.put(QualificationReport {
            key: model_a_old.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Pass,
                std::time::Instant::now(),
                "a",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        store.put(QualificationReport {
            key: model_b.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Fail,
                std::time::Instant::now(),
                "b",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });

        let n = store.mark_stale_for_selection(&model_a_new);
        assert_eq!(n, 1, "only model-a's prior endpoint should go stale");
        assert!(store.get(&model_a_old).unwrap().stale);
        assert!(
            !store.get(&model_b).unwrap().stale,
            "sibling model-b must remain non-stale under #650"
        );
        assert_eq!(
            store
                .get(&model_b)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Fail,
            "sibling measured result must be unchanged"
        );

        // get_for_selection for model-a must not return or touch model-b.
        let near = store.get_for_selection(&model_a_new).unwrap();
        assert_eq!(near.key.model_id, "model-a");
        assert!(near.stale);
        assert!(!store.get(&model_b).unwrap().stale);

        // Selecting model-b exactly still hits its non-stale report.
        let b_hit = store.get_for_selection(&model_b).unwrap();
        assert!(!b_hit.stale);
        assert_eq!(b_hit.key.model_id, "model-b");
    }

    #[test]
    fn mark_stale_if_mismatch_requires_key_lookup() {
        let mut store = QualificationStore::default();
        let old = key("m1");
        let current = QualificationKey::new("profile-a", "https://other.example.com/v1", "m1");
        store.put(QualificationReport {
            key: old.clone(),
            checks: vec![],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert!(store.mark_stale_if_mismatch(&old, &current));
        assert!(store.get(&old).unwrap().stale);
        assert!(!store.mark_stale_if_mismatch(&current, &current)); // miss
    }

    #[test]
    fn redact_reason_strips_secret_shapes() {
        let r = redact_reason("failed with Bearer sk-abc123 from /Users/me");
        assert!(!r.contains("sk-"));
        assert!(!r.contains("/Users/"));
    }

    #[test]
    fn tools_unsupported_error_fails_tool_probe() {
        let mut t = ScriptedQualificationTransport::default();
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                raw_error: Some("tools_unsupported".into()),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "c".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: r#"{"qualify":"ok","v":1}"#.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "s".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        t.honor_cancel = true;
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::NativeToolCall),
            CapabilityStatus::Fail
        );
    }
}
