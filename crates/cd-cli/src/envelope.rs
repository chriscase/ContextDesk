//! Stable machine-readable output: one JSON envelope shape for one-shot
//! commands, one JSON-object-per-line shape for streaming commands, and a
//! documented, stable exit-code category per outcome.
//!
//! Both shapes and the exit codes are part of the CLI's contract with
//! scripts (see `docs/CLI.md`) — changing a field name or a code's meaning
//! is a breaking change, not a refactor.

use serde::Serialize;
use std::fmt;

/// Bumped only on a breaking change to the envelope shape itself (field
/// removed/renamed/retyped) — never on new optional fields or new commands.
pub const ENVELOPE_SCHEMA_VERSION: u32 = 1;

/// Stable schema id for every `--jsonl` line this CLI emits.
pub const JSONL_STREAM_SCHEMA: &str = "contextdesk.cli.stream.v1";
/// Version of the JSONL stream envelope fields
/// (`schema`/`version`/`session`/`turn`/`operation`/`seq`).
pub const JSONL_STREAM_VERSION: u32 = 1;

/// Stable exit-code categories. Values are deliberately sparse (not 0..N)
/// so a script matching on a specific code today is not silently broken by
/// a future category being inserted between two existing ones.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCategory {
    /// The command completed and did what it said.
    Success = 0,
    /// The input was invalid on its face — bad name, empty value, malformed
    /// flag combination — independent of any stored state.
    UserError = 1,
    /// The named corpus, source, session, profile, or config key does not
    /// exist.
    NotFound = 3,
    /// The operation was rejected because stored state has moved since the
    /// caller last observed it (a stale timezone preview token, a revision
    /// mismatch) — re-read current state and retry, don't blindly resend.
    Conflict = 4,
    /// A tool call requiring permission was denied (explicitly, or by the
    /// default fail-closed behavior in a non-interactive process).
    PermissionDenied = 5,
    /// The configured provider could not be reached or returned an error.
    ProviderError = 6,
    /// The command's grammar exists and was accepted, but the behavior it
    /// names is intentionally not implemented yet. Never conflated with
    /// success — a caller must be able to tell "ran and did nothing" apart
    /// from "refused to pretend to run."
    NotImplemented = 7,
    /// The operation was interrupted by Ctrl-C before it finished. Matches
    /// the conventional Unix SIGINT exit code (128 + 2) rather than joining
    /// the sparse category numbering above, so a script's existing `$? ==
    /// 130` check for "the user hit Ctrl-C" keeps working unmodified.
    Cancelled = 130,
    /// `contextdesk doctor` completed its full readiness check without
    /// itself failing, but the verdict was "not ready" — one or more
    /// checks failed or were skipped. Distinct from every category above:
    /// the command did exactly what it promised (produce an honest
    /// verdict), so this is not an error in the usual sense, only a
    /// process-exit-code signal a script can gate on (`contextdesk doctor
    /// && start_demo.sh`).
    NotReady = 8,
    /// A normalized stream inspection completed and found one or more files
    /// non-conforming. The report is complete; this code makes it gateable.
    NonConforming = 9,
    /// Normalize safely published valid artifacts, but the result was partial
    /// and `--fail-on-partial` requested a failing automation verdict.
    Partial = 10,
    /// Any failure that does not fit an above category — a bug, not an
    /// expected outcome a caller should branch on.
    Internal = 70,
}

impl ExitCategory {
    /// The stable string used in the JSON envelope's `error.kind` field —
    /// intentionally distinct from the Rust variant name so renaming the
    /// enum variant (a Rust-only concern) can never silently change the
    /// wire contract.
    pub fn kind(self) -> &'static str {
        match self {
            ExitCategory::Success => "success",
            ExitCategory::UserError => "user_error",
            ExitCategory::NotFound => "not_found",
            ExitCategory::Conflict => "conflict",
            ExitCategory::PermissionDenied => "permission_denied",
            ExitCategory::ProviderError => "provider_error",
            ExitCategory::NotImplemented => "not_implemented",
            ExitCategory::Cancelled => "cancelled",
            ExitCategory::NotReady => "not_ready",
            ExitCategory::NonConforming => "non_conforming",
            ExitCategory::Partial => "partial",
            ExitCategory::Internal => "internal",
        }
    }

    pub fn code(self) -> i32 {
        self as i32
    }
}

/// Every command handler returns this. `Ok` carries whatever the command
/// produces; `Err` carries a category (for the exit code) and a message.
pub type CliResult<T> = Result<T, CliError>;

#[derive(Debug)]
pub struct CliError {
    pub category: ExitCategory,
    pub message: String,
}

impl CliError {
    pub fn new(category: ExitCategory, message: impl Into<String>) -> Self {
        Self {
            category,
            message: message.into(),
        }
    }

    pub fn user(message: impl Into<String>) -> Self {
        Self::new(ExitCategory::UserError, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ExitCategory::NotFound, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ExitCategory::Conflict, message)
    }

    pub fn provider(message: impl Into<String>) -> Self {
        Self::new(ExitCategory::ProviderError, message)
    }

    pub fn not_implemented(message: impl Into<String>) -> Self {
        Self::new(ExitCategory::NotImplemented, message)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(ExitCategory::Cancelled, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ExitCategory::Internal, message)
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CliError {}

/// One command's output, able to render itself either as human text or as
/// a JSON value for [`Envelope`]. Deliberately NOT a supertrait bound on
/// `Serialize` (which is not object-safe) so `Box<dyn Render>` works as a
/// uniform return type across every command handler; each implementation's
/// `render_json` body still just calls `serde_json::to_value(self)` on its
/// own `Serialize` derive.
pub trait Render {
    fn render_text(&self) -> String;
    fn render_json(&self) -> serde_json::Value;
}

impl Render for Box<dyn Render> {
    fn render_text(&self) -> String {
        (**self).render_text()
    }

    fn render_json(&self) -> serde_json::Value {
        (**self).render_json()
    }
}

/// The one-shot JSON envelope every non-streaming command's `--json` output
/// uses. Text mode never constructs this — it prints directly.
#[derive(Debug, Serialize)]
pub struct Envelope<T: Serialize> {
    pub schema_version: u32,
    pub ok: bool,
    pub command: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorEnvelope>,
}

#[derive(Debug, Serialize)]
pub struct ErrorEnvelope {
    pub kind: &'static str,
    pub message: String,
}

impl<T: Serialize> Envelope<T> {
    pub fn ok(command: &'static str, data: T) -> Self {
        Self {
            schema_version: ENVELOPE_SCHEMA_VERSION,
            ok: true,
            command,
            data: Some(data),
            error: None,
        }
    }
}

impl Envelope<()> {
    pub fn err(command: &'static str, error: &CliError) -> Self {
        Self {
            schema_version: ENVELOPE_SCHEMA_VERSION,
            ok: false,
            command,
            data: None,
            error: Some(ErrorEnvelope {
                kind: error.category.kind(),
                message: error.message.clone(),
            }),
        }
    }
}

/// One message from a trace, as it was actually about to be sent — bounded
/// and redacted upstream (`cd_core::turn_trace`) before this DTO is ever
/// built. Never the raw pre-redaction content, never a credential, never an
/// authorization header — those never reach `cd_core::turn_trace` in the
/// first place (see that module's docs for why).
#[derive(Debug, Clone, Serialize)]
pub struct TracedMessageLine {
    pub role: String,
    pub content: String,
    pub char_count: usize,
    pub truncated: bool,
}

/// `--trace summary` (also included at `context` and `full`): aggregate
/// facts about the turn, never message content.
#[derive(Debug, Clone, Serialize)]
pub struct TraceSummaryLine {
    pub provider_profile_id: String,
    pub chat_model: String,
    pub corpus_id: Option<String>,
    pub corpus_revision: Option<u64>,
    pub dry_run: bool,
    /// Total chat-history messages after this turn (system + prior + new).
    pub history_messages: usize,
    /// Distinct evidence ids cited (see `evidence_ids`).
    pub retrieved_evidence: usize,
    /// Stable evidence/citation source ids this turn's answer relied on.
    pub evidence_ids: Vec<String>,
    /// This model's resolved context budget, in characters.
    pub context_budget_chars: usize,
    /// Characters actually sent in the last provider call this turn made
    /// (full scrubbed sum across all messages that call offered — not only
    /// the bodies retained under the per-call message storage cap).
    pub context_used_chars: usize,
    /// Typed linked/focused packing telemetry from core (additive; absent on
    /// ordinary chat that never emitted `StreamEvent::ContextBudget`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_budget_telemetry: Option<cd_core::context_budgeting::ContextBudgetTelemetry>,
    /// True when that last call retained only a prefix of messages in the
    /// detailed trace payload; `context_used_chars` remains the full sum.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub context_messages_capped: bool,
    /// Backward-compatible union of offered and executed tool names.
    pub tool_names: Vec<String>,
    /// Distinct tools actually executed, derived only from Tool events.
    pub tools_executed: Vec<String>,
    /// Distinct tools offered to the provider across all recorded rounds.
    pub tools_offered: Vec<String>,
    /// Legacy total of backend-call wall time. Retained for the v1 wire
    /// contract; new consumers should use `provider_call_elapsed_ms_sum`,
    /// whose name makes the scope explicit.
    pub elapsed_ms: u64,
    /// Whole CLI turn wall time, including deterministic host work, provider
    /// setup, every provider call, validation, and session persistence.
    pub turn_elapsed_ms: u64,
    /// Sum of the wall-clock duration of every recorded provider call.
    /// This is accumulated provider-call time, not turn-relative elapsed
    /// time; if a future pipeline runs calls concurrently, the sum may exceed
    /// `turn_elapsed_ms`.
    pub provider_call_elapsed_ms_sum: u64,
    /// `"not_applicable"` (ordinary turn) | `"grounded"` | `"ungrounded"` —
    /// derived from whether the turn completed cleanly or ended with one of
    /// the `linked_*` evidence-validation error codes.
    pub grounding: String,
    /// What `grounding` actually certifies. Citation validation establishes
    /// that referenced evidence identities exist; it does not certify the
    /// model's interpretation, completeness, or causal diagnosis.
    pub grounding_scope: String,
    /// Always false in v1: ContextDesk has no deterministic oracle for a
    /// model's incident interpretation or root-cause conclusion.
    pub interpretation_validated: bool,
    /// Host deterministic context-plan "Context used" summary when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used: Option<String>,
    /// Authoritative provider-turn telemetry (additive; same DTO as Tauri).
    /// Boxed so the CLI `StreamLine` enum stays clippy-friendly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_telemetry: Option<Box<cd_core::provider_telemetry::ProviderTurnTelemetry>>,
}

/// `--trace context` / `--trace full`: one line per provider call this turn
/// made (one for a dry run, one per round for a real multi-round turn),
/// carrying the exact bounded, redacted messages and tool names that call
/// sent — including tool-result messages already folded into history by an
/// earlier round, which is how "context added between rounds" is visible:
/// diff consecutive `TraceContext` lines' `messages`.
#[derive(Debug, Clone, Serialize)]
pub struct TraceContextLine {
    /// 0-based order this call was made in.
    pub round: usize,
    pub elapsed_ms: u64,
    pub tool_names: Vec<String>,
    pub messages: Vec<TracedMessageLine>,
    /// `"completed"` | `"failed"`.
    pub outcome: &'static str,
    pub finish_reason: Option<String>,
    pub tool_call_count: Option<usize>,
    /// Redacted error text, only when `outcome == "failed"`.
    pub error: Option<String>,
    /// Per-round transport + application telemetry (additive).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_round_telemetry: Option<cd_core::provider_telemetry::ProviderRoundTelemetry>,
}

/// `--trace full` only (requires `--trace-ack`): one line per tool call this
/// turn actually made, correlating a bounded (already redacted, already
/// UI-facing) name/outcome/detail to the round that made it. Reuses exactly
/// the `Tool` lifecycle data every trace level already has access to via
/// `StreamEvent::Tool` — no raw tool arguments are captured anywhere in this
/// turn-tracing feature; only what a real UI would already show for a tool
/// call is exposed here, correlated rather than dropped.
#[derive(Debug, Clone, Serialize)]
pub struct TraceToolLine {
    pub id: String,
    pub name: String,
    pub ok: bool,
    pub summary: String,
    pub detail: Option<String>,
}

/// One step of the shared Activity Inspector contract, projected for CLI
/// modes (`--activity`, and optionally embedded in `--jsonl` when activity
/// is requested). Bodies are never present at summary detail.
#[derive(Debug, Clone, Serialize)]
pub struct ActivityLine {
    /// Contract version from `cd_core::activity::ACTIVITY_CONTRACT_VERSION`.
    pub activity_version: u32,
    pub session_id: String,
    pub turn_id: String,
    pub operation_id: String,
    /// Monotonic within the turn (from `ActivityEvent.seq`).
    pub seq: u64,
    pub phase: String,
    pub status: String,
    pub origin: String,
    pub determinism: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    /// True when the parent turn record dropped events at the hard bound.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub turn_truncated: bool,
    /// Count of events omitted by the hard bound (if any).
    #[serde(default, skip_serializing_if = "is_zero_usize")]
    pub omitted_events: usize,
}

fn is_zero_usize(value: &usize) -> bool {
    *value == 0
}

/// One line of a `--jsonl` streaming command's output. Every line is a
/// complete, independently parseable JSON object; a reader must not assume
/// line count or ordering beyond "the line tagged `done` is last."
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamLine<'a> {
    /// Shared human-progress projection derived from the same engine event
    /// delivered to text and desktop hosts.
    Progress(cd_core::events::TurnProgress),
    TextDelta {
        text: &'a str,
    },
    Tool {
        name: &'a str,
        ok: bool,
        summary: &'a str,
    },
    PermissionRequired {
        tool_name: &'a str,
        target: &'a str,
        reason: &'a str,
        risk: &'a str,
    },
    TurnCompleted {
        reason: &'a str,
    },
    Error {
        code: &'a str,
        message: &'a str,
    },
    /// Exact host-validated investigation answer from the typed event.
    InvestigationAnswer {
        envelope: &'a cd_core::investigation_answer::AnswerEnvelopeV1,
    },
    /// Multi-model stage progress / summary. Host-authored counts and ids only.
    MultiModelStage {
        stage: String,
        phase: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        detail: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        candidate_id: Option<String>,
    },
    /// `--trace summary` (and above). See [`TraceSummaryLine`].
    TraceSummary(TraceSummaryLine),
    /// `--trace context` (and `full`). See [`TraceContextLine`].
    TraceContext(TraceContextLine),
    /// `--trace full` only. See [`TraceToolLine`].
    TraceTool(TraceToolLine),
    /// Shared activity projection. See [`ActivityLine`].
    Activity(ActivityLine),
    /// Host "Context used" summary from the deterministic context plan trail.
    ContextUsed {
        /// Concise summary (no bodies); same text as Text-mode stderr line.
        summary: String,
    },
    Done {
        ok: bool,
        session_id: &'a str,
        final_text: &'a str,
    },
}

/// Common envelope fields required on every live `--jsonl` line so a
/// consumer can order and correlate without parsing free-form text.
#[derive(Debug, Serialize)]
pub struct JsonlMetaLine<T: Serialize> {
    pub schema: &'static str,
    pub version: u32,
    pub session: String,
    pub turn: String,
    pub operation: String,
    pub seq: u64,
    #[serde(flatten)]
    pub event: T,
}

impl<T: Serialize> JsonlMetaLine<T> {
    pub fn wrap(
        session: impl Into<String>,
        turn: impl Into<String>,
        operation: impl Into<String>,
        seq: u64,
        event: T,
    ) -> Self {
        Self {
            schema: JSONL_STREAM_SCHEMA,
            version: JSONL_STREAM_VERSION,
            session: session.into(),
            turn: turn.into(),
            operation: operation.into(),
            seq,
            event,
        }
    }
}
