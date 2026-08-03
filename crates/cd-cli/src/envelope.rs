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

/// One line of a `--jsonl` streaming command's output. Every line is a
/// complete, independently parseable JSON object; a reader must not assume
/// line count or ordering beyond "the line tagged `done` is last."
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamLine<'a> {
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
    Done {
        ok: bool,
        session_id: &'a str,
        final_text: &'a str,
    },
}
