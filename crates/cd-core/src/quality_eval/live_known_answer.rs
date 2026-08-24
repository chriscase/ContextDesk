//! Truth-isolated provider boundary for the checked-in known-answer suite.
//!
//! A provider sees only an opaque scenario id, the user question, frozen
//! evidence, and a response contract. Fixture case ids, scripted candidates,
//! evaluator truth, expectations, and diagnostic telemetry remain host-only.

use super::answer_score::score_answer;
use super::suite::{
    hex_sha256, scan_privacy_text, LoadedSuite, RUNTIME_FORBIDDEN_EVALUATOR_TOKENS,
};
use super::types::{
    failure_reason, AnswerClaim, AnswerDimension, AnswerScore, AnswerTruth, CandidateAnswer,
    EvidencePacket, LaneStatus, ScriptedAttempt, ScriptedDiagnostic, ScriptedRoleOutcome,
};
use crate::error::{CoreError, CoreResult};
use crate::investigation_team_qualification::InvestigationTeamRole;
use crate::redact::scrub_secrets;
use crate::turn_trace::opaque_absolute_paths;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
#[cfg(unix)]
use std::ffi::{CString, OsStr};
#[cfg(unix)]
use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::path::{Component, Path};

/// Provider-visible request schema.
pub const LIVE_KNOWN_ANSWER_PROMPT_SCHEMA_ID: &str =
    "contextdesk.quality_eval.live_known_answer_prompt.v1";
/// Provider response schema.
pub const LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID: &str =
    "contextdesk.quality_eval.live_known_answer_response.v1";
/// Frozen packet evaluated by this adapter.
pub const LIVE_KNOWN_ANSWER_PACKET_ID: &str = "fixed";
/// Maximum accepted provider response size.
pub const LIVE_KNOWN_ANSWER_RESPONSE_MAX_BYTES: usize = 64 * 1024;
/// Stable failure reason for a source/time citation that does not match the host packet.
pub const EXACT_CITATION_MISMATCH: &str = "exact_source_time_citation_mismatch";
/// Stable failure reason for repeated citation tuples within one claim.
pub const DUPLICATE_EXACT_CITATION: &str = "duplicate_exact_citation";

/// Stable owner-only directory capability for Unix known-answer persistence.
///
/// Every path component is opened relative to the preceding directory with
/// `O_NOFOLLOW`. Callers then perform all store operations relative to the
/// retained final descriptor and can revalidate that the configured pathname
/// still resolves to the same directory identity before committing.
#[cfg(unix)]
#[derive(Debug)]
pub struct LiveKnownAnswerOwnerDirectory {
    directory: File,
    identity: LiveKnownAnswerUnixIdentity,
    effective_uid: u32,
}

/// One owner-only regular file opened relative to a retained directory.
#[cfg(unix)]
#[derive(Debug)]
pub struct LiveKnownAnswerOpenedFile {
    /// Stable open handle used for all reads and validation.
    pub file: File,
    /// Size observed from that handle at open.
    pub size: u64,
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LiveKnownAnswerUnixIdentity {
    device: u64,
    inode: u64,
    uid: u32,
    mode: u32,
}

#[cfg(unix)]
impl LiveKnownAnswerOwnerDirectory {
    /// Open an absolute owner-only directory without following any ancestor
    /// or final-component symlink.
    pub fn open(path: &Path) -> CoreResult<Self> {
        // SAFETY: `geteuid` has no preconditions and retains no pointer.
        let effective_uid = unsafe { libc::geteuid() };
        Self::open_with_expected_uid(path, effective_uid)
    }

    fn open_with_expected_uid(path: &Path, effective_uid: u32) -> CoreResult<Self> {
        if !path.is_absolute() {
            return Err(owner_directory_error("directory path must be absolute"));
        }
        let mut root_options = OpenOptions::new();
        root_options.read(true).custom_flags(
            libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        );
        let mut directory = root_options
            .open("/")
            .map_err(|_| owner_directory_error("cannot open filesystem root securely"))?;
        let mut saw_segment = false;
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(segment) => {
                    directory = open_directory_segment(&directory, segment)?;
                    saw_segment = true;
                }
                _ => {
                    return Err(owner_directory_error(
                        "directory path contains a non-normal component",
                    ));
                }
            }
        }
        if !saw_segment {
            return Err(owner_directory_error(
                "filesystem root cannot be used as the persistence boundary",
            ));
        }
        let metadata = directory
            .metadata()
            .map_err(|_| owner_directory_error("cannot inspect owner directory"))?;
        validate_owner_metadata(&metadata, effective_uid, true)?;
        Ok(Self {
            identity: unix_identity(&metadata),
            directory,
            effective_uid,
        })
    }

    /// Reopen every configured path component no-follow and require that it
    /// resolves to the retained directory identity.
    pub fn revalidate_path(&self, path: &Path) -> CoreResult<()> {
        let current = Self::open_with_expected_uid(path, self.effective_uid)?;
        if current.identity != self.identity {
            return Err(owner_directory_error(
                "configured parent directory identity changed",
            ));
        }
        Ok(())
    }

    /// Open one existing owner-only regular file relative to this directory.
    /// Missing files return `None`; symlinks and non-regular entries fail.
    pub fn open_owner_regular(
        &self,
        name: &str,
        max_bytes: u64,
        read_write: bool,
    ) -> CoreResult<Option<LiveKnownAnswerOpenedFile>> {
        let name = single_component_name(name)?;
        let access = if read_write {
            libc::O_RDWR
        } else {
            libc::O_RDONLY
        };
        // SAFETY: the retained descriptor is a valid directory and `name` is
        // one NUL-terminated path segment. A successful descriptor is adopted
        // exactly once below.
        let descriptor = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                access | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if descriptor < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOENT) {
                return Ok(None);
            }
            return Err(owner_directory_error(
                "cannot securely open owner file relative to its directory",
            ));
        }
        // SAFETY: `openat` returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(descriptor) };
        let metadata = file
            .metadata()
            .map_err(|_| owner_directory_error("cannot inspect owner file"))?;
        validate_owner_metadata(&metadata, self.effective_uid, false)?;
        if metadata.len() > max_bytes {
            return Err(owner_directory_error("owner file exceeds its byte limit"));
        }
        Ok(Some(LiveKnownAnswerOpenedFile {
            file,
            size: metadata.len(),
        }))
    }

    /// Atomically create one new `0600` regular file relative to the retained
    /// directory. Existing entries, including symlinks, fail closed.
    pub fn create_owner_regular(&self, name: &str) -> CoreResult<File> {
        let name = single_component_name(name)?;
        // SAFETY: the retained descriptor and NUL-terminated single segment
        // are valid; a successful descriptor is adopted exactly once.
        let descriptor = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_EXCL
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK,
                0o600,
            )
        };
        if descriptor < 0 {
            return Err(owner_directory_error("cannot atomically create owner file"));
        }
        // SAFETY: `openat` returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(descriptor) };
        let metadata = file
            .metadata()
            .map_err(|_| owner_directory_error("cannot inspect created owner file"))?;
        validate_owner_metadata(&metadata, self.effective_uid, false)?;
        Ok(file)
    }

    /// Remove one file relative to the retained directory. Missing entries are
    /// already clean and succeed.
    pub fn remove_file(&self, name: &str) -> CoreResult<()> {
        let name = single_component_name(name)?;
        // SAFETY: the retained descriptor and single path segment are valid.
        let result = unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENOENT) {
                return Err(owner_directory_error("cannot remove owner file"));
            }
        }
        Ok(())
    }

    /// Atomically replace one destination with another entry in this same
    /// retained directory. This method exists only on Unix.
    pub fn rename_replace(&self, from: &str, to: &str) -> CoreResult<()> {
        let from = single_component_name(from)?;
        let to = single_component_name(to)?;
        // SAFETY: both names are valid single segments relative to the same
        // retained directory descriptor.
        let result = unsafe {
            libc::renameat(
                self.directory.as_raw_fd(),
                from.as_ptr(),
                self.directory.as_raw_fd(),
                to.as_ptr(),
            )
        };
        if result != 0 {
            return Err(owner_directory_error(
                "cannot atomically replace owner file",
            ));
        }
        Ok(())
    }

    /// Fsync the retained directory descriptor after replacement.
    pub fn sync(&self) -> CoreResult<()> {
        self.directory
            .sync_all()
            .map_err(|_| owner_directory_error("cannot sync owner directory"))
    }
}

#[cfg(unix)]
fn open_directory_segment(directory: &File, segment: &OsStr) -> CoreResult<File> {
    let name = CString::new(segment.as_bytes())
        .map_err(|_| owner_directory_error("directory segment contains NUL"))?;
    // SAFETY: the current descriptor is a valid directory and `name` is one
    // NUL-terminated component. A successful descriptor is adopted once.
    let descriptor = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY
                | libc::O_DIRECTORY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK,
        )
    };
    if descriptor < 0 {
        return Err(owner_directory_error(
            "directory path contains a missing, symlinked, or unreadable component",
        ));
    }
    // SAFETY: `openat` returned a new owned descriptor.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn single_component_name(name: &str) -> CoreResult<CString> {
    if name.is_empty() || name.as_bytes().contains(&b'/') || matches!(name, "." | "..") {
        return Err(owner_directory_error(
            "owner filename is not one path segment",
        ));
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err(owner_directory_error(
            "owner filename is not one path segment",
        ));
    }
    CString::new(name.as_bytes()).map_err(|_| owner_directory_error("owner filename contains NUL"))
}

#[cfg(unix)]
fn validate_owner_metadata(
    metadata: &std::fs::Metadata,
    expected_uid: u32,
    directory: bool,
) -> CoreResult<()> {
    if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
        return Err(owner_directory_error("owner entry has the wrong file type"));
    }
    if metadata.uid() != expected_uid {
        return Err(owner_directory_error("owner entry has the wrong uid"));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(owner_directory_error("owner entry is not owner-only"));
    }
    Ok(())
}

#[cfg(unix)]
fn unix_identity(metadata: &std::fs::Metadata) -> LiveKnownAnswerUnixIdentity {
    LiveKnownAnswerUnixIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        uid: metadata.uid(),
        mode: metadata.mode(),
    }
}

#[cfg(unix)]
fn owner_directory_error(detail: &str) -> CoreError {
    CoreError::Config(format!("live known-answer owner directory: {detail}"))
}

const MAX_CLAIMS: usize = 32;
const MAX_CITATIONS_PER_CLAIM: usize = 16;
const MAX_CLAIM_TEXT_BYTES: usize = 4 * 1024;
const MAX_CONCLUSION_BYTES: usize = 8 * 1024;
const ALLOWED_CLAIM_ROLES: &[&str] = &[
    "trigger",
    "symptom",
    "recovery",
    "independent",
    "observation",
    "other",
];
const ALLOWED_CONFIDENCE: &[&str] = &["high", "medium", "low"];

/// Stable bounded attribution for a rejected provider response. It contains
/// no provider text and is safe to project into durable telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveKnownAnswerResponseFailure {
    /// Invalid JSON, identity, size, or structural response contract.
    Parser,
    /// Credential/path-shaped material failed the privacy gate.
    Privacy,
    /// A claim role or confidence value was outside the closed vocabulary.
    Vocabulary,
}

impl LiveKnownAnswerResponseFailure {
    /// Stable durable failure code.
    pub fn as_code(self) -> &'static str {
        match self {
            Self::Parser => "provider_response_parse_failed",
            Self::Privacy => "provider_response_privacy_rejected",
            Self::Vocabulary => "provider_response_vocabulary_rejected",
        }
    }
}

/// One provider-visible frozen evidence row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveEvidenceDocument {
    /// Opaque evidence id used by the existing deterministic scorer.
    pub evidence_id: String,
    /// Opaque host-assigned source identity for exact citation checks.
    pub source_id: String,
    /// Opaque host-assigned ordering/time anchor for exact citation checks.
    pub time_anchor: String,
    /// Evidence text visible to the model.
    pub text: String,
}

/// Provider-visible response instructions. These describe syntax, never truth.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveResponseContract {
    /// Required response schema id.
    pub schema_id: String,
    /// Neutral instructions shared by every scenario.
    pub instructions: Vec<String>,
    /// Closed claim-role vocabulary.
    pub allowed_claim_roles: Vec<String>,
    /// Closed confidence vocabulary.
    pub allowed_confidence: Vec<String>,
}

/// Complete provider-visible known-answer prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveKnownAnswerPrompt {
    /// Prompt schema id.
    pub schema_id: String,
    /// Opaque id assigned by manifest order; it does not reveal fixture intent.
    pub scenario_id: String,
    /// User question from the model-visible runtime.
    pub question: String,
    /// Frozen fixed-packet evidence.
    pub evidence: Vec<LiveEvidenceDocument>,
    /// Strict response contract.
    pub response_contract: LiveResponseContract,
}

/// Exact citation emitted by the provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveCitation {
    /// Evidence id from the prompt.
    pub evidence_id: String,
    /// Exact source id from the same evidence row.
    pub source_id: String,
    /// Exact time anchor from the same evidence row.
    pub time_anchor: String,
}

/// One structured provider claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveAnswerClaim {
    /// Claim text.
    pub text: String,
    /// Exact evidence/source/time citations.
    #[serde(default)]
    pub citations: Vec<LiveCitation>,
    /// Optional closed-vocabulary causal role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// Strict provider response. Host diagnostics are deliberately absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveKnownAnswerResponse {
    /// Response schema id.
    pub schema_id: String,
    /// Must exactly match the prompt scenario id.
    pub scenario_id: String,
    /// Whether the provider says the initiating cause is established.
    #[serde(default)]
    pub asserts_root_cause_established: bool,
    /// Structured claims.
    #[serde(default)]
    pub claims: Vec<LiveAnswerClaim>,
    /// Concise conclusion.
    #[serde(default)]
    pub conclusion: String,
    /// high | medium | low.
    #[serde(default)]
    pub confidence: String,
}

/// Host-only prepared case. Intentionally does not implement `Serialize`.
#[derive(Debug, Clone)]
pub struct PreparedLiveKnownAnswerCase {
    prompt: LiveKnownAnswerPrompt,
    case_id: String,
    task_id: String,
    packet: EvidencePacket,
    truth: AnswerTruth,
}

impl PreparedLiveKnownAnswerCase {
    /// Provider-visible prompt only.
    pub fn prompt(&self) -> &LiveKnownAnswerPrompt {
        &self.prompt
    }

    /// Host-only fixture identity for joining scores after provider execution.
    pub fn host_case_id(&self) -> &str {
        &self.case_id
    }

    /// Host-only task identity for joining scores after provider execution.
    pub fn host_task_id(&self) -> &str {
        &self.task_id
    }

    /// Whether this scenario can only be scored with host-owned attempt, tool,
    /// or role telemetry. A direct answer-only provider runner must block these
    /// scenarios rather than inventing an envelope or blaming the model.
    pub fn requires_host_diagnostic(&self) -> bool {
        self.truth.diagnostic.is_some()
    }

    /// Whether the serial answer runner can honestly observe the diagnostic
    /// facts this scenario requires *and* join them into a scored envelope.
    ///
    /// Production `QualificationTransport` is exclusive: `Ok` carries a body
    /// with `raw_error = None`, and `Err` is mapped to empty content plus a
    /// reason. The scored path therefore only emits
    /// [`SERIAL_PARSED_ATTEMPT_CATEGORY`], after one follow-up on a failed
    /// first chat [`MIXED_ATTEMPTS_CATEGORY`], or, when a parsed response
    /// asserts zero claims, [`HOST_GROUNDING_REFUSAL_CATEGORY`].
    /// Timeout/auth/transport can be named from `Err` reasons but never carry
    /// a parsed body, so they can only ever be a host-observed gap
    /// (`host_score_failed`), never a scored envelope. Tool-progress/withdrawal
    /// and three-role budget coverage need host seams this runner does not
    /// have. Those stay pre-dispatch blocked.
    pub fn host_can_observe_diagnostic(&self) -> bool {
        match &self.truth.diagnostic {
            None => true,
            Some(diagnostic) => {
                if diagnostic.require_citeable_on_tool_progress
                    || diagnostic.require_tool_withdrawal_after_non_progress
                    || !diagnostic.required_roles.is_empty()
                {
                    return false;
                }
                diagnostic.allowed_categories.is_empty()
                    || diagnostic.allowed_categories.iter().any(|allowed| {
                        allowed == SERIAL_PARSED_ATTEMPT_CATEGORY
                            || allowed == MIXED_ATTEMPTS_CATEGORY
                            || allowed == HOST_GROUNDING_REFUSAL_CATEGORY
                    })
            }
        }
    }

    /// Pre-dispatch block: diagnostic required but unobservable on this runner.
    pub fn blocks_diagnostic_before_dispatch(&self) -> bool {
        self.requires_host_diagnostic() && !self.host_can_observe_diagnostic()
    }

    /// Whether a host-built `reported_category` is in this case's allow-list.
    /// Empty / absent allow-lists do not constrain the category.
    pub fn host_allows_reported_category(&self, category: &str) -> bool {
        match &self.truth.diagnostic {
            None => true,
            Some(diagnostic) if diagnostic.allowed_categories.is_empty() => true,
            Some(diagnostic) => diagnostic
                .allowed_categories
                .iter()
                .any(|allowed| allowed == category),
        }
    }

    /// Whether the host may dispatch one follow-up chat after a failed first
    /// attempt so mixed pass/fail rows can be recorded. Never used to invent a
    /// failure after a fluent success.
    pub fn host_may_record_follow_up_attempt(&self) -> bool {
        self.host_allows_reported_category(MIXED_ATTEMPTS_CATEGORY)
    }
}

/// Category this serial runner emits for one parsed success attempt.
///
/// qe09/qe10 do not allow this label. Join mixed-attempt or grounding-refusal
/// facts instead of this success envelope. Timeout/auth/transport labels
/// exist on `Err` reasons but are not scored on the production chat seam.
pub const SERIAL_PARSED_ATTEMPT_CATEGORY: &str = "compatible_success";

/// Category emitted when host-observed attempts include both success and
/// failure rows.
pub const MIXED_ATTEMPTS_CATEGORY: &str = "mixed_attempts_accounted";

/// Category emitted when the last parsed attempt in a grounding-vs-transport
/// sequence asserts zero claims. This is a host-observed structural fact
/// (`response.claims.is_empty()`), never a provider self-declared diagnostic
/// field — the response schema has none. A genuinely grounded parsed answer
/// (one or more claims, each contractually carrying a citation) never uses
/// this label; it falls back to [`SERIAL_PARSED_ATTEMPT_CATEGORY`], which
/// qe10 does not allow, so a fluent response without host-observed grounding
/// refusal is never joined into a scored envelope on this scenario.
///
/// Only ever reported on a lineage with no unsucceeded transport/auth/timeout
/// attempt: the scorer's `transport_versus_grounding` dimension rejects this
/// label whenever an earlier attempt carries that class, and qe10's fixed
/// `all_failed` usefulness policy requires every attempt row to report
/// `succeeded = false`. A zero-claims attempt therefore records
/// `failure_class = "host_grounding"` (not `"success"`) with
/// `succeeded = false`: it transport-succeeded, but produced nothing
/// evaluable, so it is honestly not a "successful evaluable analysis".
pub const HOST_GROUNDING_REFUSAL_CATEGORY: &str = "host_grounding_refusal";
const HOST_GROUNDING_FAILURE_CLASS: &str = "host_grounding";

/// Host-owned classification of one observed chat attempt.
/// Never derived from provider JSON `diagnostic` fields or fixture truth labels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostAttemptClass {
    /// Parsed a bounded evaluable answer.
    Success,
    /// Transport/connect/protocol failure.
    Transport,
    /// Authentication/authorization failure.
    Auth,
    /// Deadline or timeout.
    Timeout,
    /// Parsed but empty of evaluable claims.
    Empty,
    /// Host withheld grounding (not produced by this runner).
    Analysis,
}

impl HostAttemptClass {
    /// Stable ScriptedAttempt failure_class label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Transport => "transport",
            Self::Auth => "auth",
            Self::Timeout => "timeout",
            Self::Empty => "empty",
            Self::Analysis => "analysis",
        }
    }

    /// Whether the attempt produced evaluable analysis.
    pub fn succeeded(self) -> bool {
        matches!(self, Self::Success)
    }

    /// Classify a host/transport error string. Never `host_grounding`.
    pub fn from_transport_reason(reason: &str) -> Self {
        let lower = reason.to_ascii_lowercase();
        if lower.contains("timeout") || lower.contains("timed out") || lower.contains("deadline") {
            Self::Timeout
        } else if lower.contains("unauthorized")
            || lower.contains("forbidden")
            || lower.contains("401")
            || lower.contains("403")
            || (lower.contains("auth") && !lower.contains("author"))
        {
            Self::Auth
        } else {
            Self::Transport
        }
    }

    /// Classify one chat_complete outcome from host-observed flags only.
    pub fn from_chat_outcome(
        cancelled: bool,
        raw_error: Option<&str>,
        parsed_ok: bool,
        empty_content: bool,
    ) -> Self {
        if cancelled {
            return Self::Timeout;
        }
        if let Some(reason) = raw_error {
            return Self::from_transport_reason(reason);
        }
        if parsed_ok {
            return Self::Success;
        }
        if empty_content {
            return Self::Empty;
        }
        Self::Analysis
    }
}

/// One host-observed attempt. Tests and the trusted runner construct this from
/// transport/cancel/parse facts, never from fixture candidate diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostAttemptObservation {
    /// Stable attempt id assigned by the host.
    pub attempt_id: String,
    /// Host classification.
    pub class: HostAttemptClass,
    /// Whether the host observed citeable citations on a parsed answer.
    pub citeable_evidence: bool,
}

/// Build a `ScriptedDiagnostic` from host-observed attempts only.
///
/// Category, usefulness, and export sample are derived from those rows.
/// Tool steps stay empty: this runner does not execute tools.
pub fn scripted_diagnostic_from_host_attempts(
    attempts: &[HostAttemptObservation],
    configured_role: InvestigationTeamRole,
) -> ScriptedDiagnostic {
    let any_success = attempts.iter().any(|row| row.class.succeeded());
    let any_fail = attempts.iter().any(|row| !row.class.succeeded());
    let all_fail = !attempts.is_empty() && attempts.iter().all(|row| !row.class.succeeded());
    let timeout = attempts
        .iter()
        .any(|row| row.class == HostAttemptClass::Timeout && !row.class.succeeded());
    let auth = attempts
        .iter()
        .any(|row| row.class == HostAttemptClass::Auth && !row.class.succeeded());
    let transport = attempts
        .iter()
        .any(|row| row.class == HostAttemptClass::Transport && !row.class.succeeded());
    let (reported_category, usefulness_policy, claims_useful) = if timeout && !any_success {
        ("timeout", "all_failed", false)
    } else if auth && !any_success {
        ("auth_failure", "all_failed", false)
    } else if transport && !any_success {
        ("transport_failure", "all_failed", false)
    } else if any_success && any_fail {
        (MIXED_ATTEMPTS_CATEGORY, "mixed_accounted", true)
    } else if all_fail {
        ("all_attempts_failed", "all_failed", false)
    } else if any_success {
        (SERIAL_PARSED_ATTEMPT_CATEGORY, "all_succeeded", true)
    } else {
        ("empty_terminal_answer", "none", false)
    };
    let succeeded = attempts.iter().filter(|row| row.class.succeeded()).count();
    let failed = attempts.len().saturating_sub(succeeded);
    let export_text = format!(
        "attempts={} succeeded={} failed={} category={}",
        attempts.len(),
        succeeded,
        failed,
        reported_category
    );
    ScriptedDiagnostic {
        attempts: attempts
            .iter()
            .map(|row| ScriptedAttempt {
                attempt_id: row.attempt_id.clone(),
                failure_class: row.class.as_str().into(),
                succeeded: row.class.succeeded(),
                citeable_evidence: row.citeable_evidence,
            })
            .collect(),
        tool_steps: Vec::new(),
        roles: vec![ScriptedRoleOutcome {
            role: configured_role.as_str().into(),
            status: "completed".into(),
        }],
        host_budget_exhausted: false,
        reported_category: reported_category.into(),
        claims_useful,
        usefulness_policy: usefulness_policy.into(),
        export_text,
    }
}

/// Host diagnostic for one parsed live response (single observed attempt).
pub fn scripted_diagnostic_from_parsed_response(
    response: &LiveKnownAnswerResponse,
    configured_role: InvestigationTeamRole,
) -> ScriptedDiagnostic {
    host_diagnostic_from_chat_outcome(configured_role, false, None, Some(response))
}

/// Build a host-owned diagnostic from observed chat/cancel/error facts.
///
/// Classification always goes through [`HostAttemptClass::from_chat_outcome`] /
/// [`HostAttemptClass::from_transport_reason`]. The result is `None` when this
/// case has no diagnostic truth, or when the derived category is not in the
/// host allow-list (do not join `compatible_success` into qe09/qe10).
pub fn host_diagnostic_for_observed_chat(
    case: &PreparedLiveKnownAnswerCase,
    configured_role: InvestigationTeamRole,
    cancelled: bool,
    raw_error: Option<&str>,
    parsed: Option<&LiveKnownAnswerResponse>,
) -> Option<ScriptedDiagnostic> {
    let empty_content = parsed
        .is_none_or(|response| response.claims.is_empty() && response.conclusion.trim().is_empty());
    host_diagnostic_for_observed_attempts(
        case,
        configured_role,
        &[host_attempt_from_chat(
            "host-1",
            cancelled,
            raw_error,
            parsed,
            empty_content,
        )],
    )
}

/// Join a host-owned diagnostic from one or more observed attempts.
///
/// Returns `None` when the derived category is not allow-listed, so a fluent
/// 1-shot success cannot be scored as `compatible_success` on qe09/qe10.
pub fn host_diagnostic_for_observed_attempts(
    case: &PreparedLiveKnownAnswerCase,
    configured_role: InvestigationTeamRole,
    attempts: &[HostAttemptObservation],
) -> Option<ScriptedDiagnostic> {
    if !case.requires_host_diagnostic() || attempts.is_empty() {
        return None;
    }
    let diagnostic = scripted_diagnostic_from_host_attempts(attempts, configured_role);
    case.host_allows_reported_category(&diagnostic.reported_category)
        .then_some(diagnostic)
}

/// Build a `ScriptedDiagnostic` for a grounding-vs-transport sequence.
///
/// The reported category comes from the *last* observed attempt only:
/// a still-failing bodyless attempt names its transport/auth/timeout class
/// (never scored, since there is no parsed body to build a candidate
/// answer from); a successful parse with zero claims is an honest
/// [`HOST_GROUNDING_REFUSAL_CATEGORY`] refusal; a successful parse with one
/// or more claims (each contractually cited) is
/// [`SERIAL_PARSED_ATTEMPT_CATEGORY`], which this scenario never allows, so
/// a fluent but genuinely grounded response cannot be joined here either —
/// only an honest refusal can. Earlier bodyless attempts stay in the
/// `attempts` lineage for audit but never change the terminal category.
///
/// The grounding-refusal attempt row itself records
/// `failure_class = "host_grounding"` and `succeeded = false` rather than
/// reusing the raw transport-success classification: it transport-succeeded
/// but produced nothing evaluable, so `attempt_usefulness`'s `all_failed`
/// policy (every attempt honestly reports non-success) and
/// `transport_versus_grounding` (never label a `transport`/`auth`/`timeout`
/// class row as grounding) both hold.
pub fn scripted_diagnostic_for_grounding_sequence(
    attempts: &[HostAttemptObservation],
    configured_role: InvestigationTeamRole,
    last_parsed_zero_claims: Option<bool>,
) -> ScriptedDiagnostic {
    let last_index = attempts.len().checked_sub(1);
    // A prior unsucceeded transport/auth/timeout attempt anywhere earlier in
    // the lineage makes a grounding-refusal claim on the last attempt
    // unverifiable honesty: the scorer's `transport_versus_grounding`
    // dimension would reject it, and the host cannot rule out the earlier
    // failure as the true cause. Never claimed in that case.
    let has_prior_transport_failure = last_index
        .map(|last_index| {
            attempts[..last_index].iter().any(|row| {
                !row.class.succeeded()
                    && matches!(
                        row.class,
                        HostAttemptClass::Transport
                            | HostAttemptClass::Auth
                            | HostAttemptClass::Timeout
                    )
            })
        })
        .unwrap_or(false);
    let grounding_refusal = !has_prior_transport_failure
        && matches!(attempts.last(), Some(last) if last.class.succeeded())
        && last_parsed_zero_claims == Some(true);
    let (reported_category, usefulness_policy, claims_useful) = match attempts.last() {
        Some(last) if last.class.succeeded() => {
            if grounding_refusal {
                (HOST_GROUNDING_REFUSAL_CATEGORY, "all_failed", false)
            } else {
                (SERIAL_PARSED_ATTEMPT_CATEGORY, "all_succeeded", true)
            }
        }
        Some(last) => match last.class {
            HostAttemptClass::Timeout => ("timeout", "all_failed", false),
            HostAttemptClass::Auth => ("auth_failure", "all_failed", false),
            HostAttemptClass::Transport => ("transport_failure", "all_failed", false),
            HostAttemptClass::Empty | HostAttemptClass::Analysis | HostAttemptClass::Success => {
                ("empty_terminal_answer", "none", false)
            }
        },
        None => ("empty_terminal_answer", "none", false),
    };
    let scripted_attempts: Vec<ScriptedAttempt> = attempts
        .iter()
        .enumerate()
        .map(|(idx, row)| {
            let is_grounding_row = grounding_refusal && Some(idx) == last_index;
            ScriptedAttempt {
                attempt_id: row.attempt_id.clone(),
                failure_class: if is_grounding_row {
                    HOST_GROUNDING_FAILURE_CLASS.into()
                } else {
                    row.class.as_str().into()
                },
                succeeded: if is_grounding_row {
                    false
                } else {
                    row.class.succeeded()
                },
                citeable_evidence: row.citeable_evidence,
            }
        })
        .collect();
    let succeeded = scripted_attempts.iter().filter(|row| row.succeeded).count();
    let failed = scripted_attempts.len().saturating_sub(succeeded);
    let export_text = format!(
        "attempts={} succeeded={} failed={} category={}",
        scripted_attempts.len(),
        succeeded,
        failed,
        reported_category
    );
    ScriptedDiagnostic {
        attempts: scripted_attempts,
        tool_steps: Vec::new(),
        roles: vec![ScriptedRoleOutcome {
            role: configured_role.as_str().into(),
            status: "completed".into(),
        }],
        host_budget_exhausted: false,
        reported_category: reported_category.into(),
        claims_useful,
        usefulness_policy: usefulness_policy.into(),
        export_text,
    }
}

/// Join a host-owned grounding-vs-transport diagnostic from observed attempts
/// plus whether the last parsed response (if any) asserted zero claims.
///
/// Returns `None` when the derived category is not allow-listed — including
/// a genuinely grounded fluent response, which has no allowed category on
/// this scenario and therefore can never pass through this join.
pub fn host_diagnostic_for_grounding_sequence(
    case: &PreparedLiveKnownAnswerCase,
    configured_role: InvestigationTeamRole,
    attempts: &[HostAttemptObservation],
    last_parsed_zero_claims: Option<bool>,
) -> Option<ScriptedDiagnostic> {
    if !case.requires_host_diagnostic() || attempts.is_empty() {
        return None;
    }
    let diagnostic = scripted_diagnostic_for_grounding_sequence(
        attempts,
        configured_role,
        last_parsed_zero_claims,
    );
    case.host_allows_reported_category(&diagnostic.reported_category)
        .then_some(diagnostic)
}

/// Classify one chat complete/cancel/error into a host attempt row.
pub fn host_attempt_from_chat(
    attempt_id: impl Into<String>,
    cancelled: bool,
    raw_error: Option<&str>,
    parsed: Option<&LiveKnownAnswerResponse>,
    empty_content: bool,
) -> HostAttemptObservation {
    let class =
        HostAttemptClass::from_chat_outcome(cancelled, raw_error, parsed.is_some(), empty_content);
    let citeable_evidence = parsed.is_some_and(|response| {
        response
            .claims
            .iter()
            .any(|claim| !claim.citations.is_empty())
    });
    HostAttemptObservation {
        attempt_id: attempt_id.into(),
        class,
        citeable_evidence,
    }
}

fn host_diagnostic_from_chat_outcome(
    configured_role: InvestigationTeamRole,
    cancelled: bool,
    raw_error: Option<&str>,
    parsed: Option<&LiveKnownAnswerResponse>,
) -> ScriptedDiagnostic {
    let empty_content = parsed.is_some_and(|response| {
        response.claims.is_empty() && response.conclusion.trim().is_empty()
    });
    let class =
        HostAttemptClass::from_chat_outcome(cancelled, raw_error, parsed.is_some(), empty_content);
    let citeable_evidence = parsed.is_some_and(|response| {
        response
            .claims
            .iter()
            .any(|claim| !claim.citations.is_empty())
    });
    scripted_diagnostic_from_host_attempts(
        &[HostAttemptObservation {
            attempt_id: "host-1".into(),
            class,
            citeable_evidence,
        }],
        configured_role,
    )
}

/// Score joined to both opaque provider and host-only case identities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveKnownAnswerScore {
    /// Opaque id exposed to the provider.
    pub scenario_id: String,
    /// Host-only fixture id.
    pub case_id: String,
    /// Existing deterministic answer score plus exact-citation dimensions.
    pub answer: AnswerScore,
}

/// Prepare every checked-in case in manifest order using its `fixed` packet.
pub fn prepare_live_known_answer_suite(
    suite: &LoadedSuite,
) -> CoreResult<Vec<PreparedLiveKnownAnswerCase>> {
    let mut prepared = Vec::with_capacity(suite.cases.len());
    for (index, case) in suite.cases.iter().enumerate() {
        if case.runtime.questions.len() != 1 || case.truth.answers.len() != 1 {
            return Err(live_error(
                "each live scenario must contain exactly one question and one answer truth",
            ));
        }
        let question = case
            .runtime
            .questions
            .values()
            .next()
            .cloned()
            .ok_or_else(|| live_error("live scenario question missing"))?;
        let truth = case
            .truth
            .answers
            .first()
            .cloned()
            .ok_or_else(|| live_error("live scenario answer truth missing"))?;
        let packet = case
            .runtime
            .packets
            .iter()
            .find(|packet| packet.packet_id == LIVE_KNOWN_ANSWER_PACKET_ID)
            .cloned()
            .ok_or_else(|| live_error("live scenario fixed packet missing"))?;
        if packet.documents.is_empty() {
            return Err(live_error("live scenario fixed packet must not be empty"));
        }

        let scenario_id = format!("scenario-{:03}", index + 1);
        let evidence = packet
            .documents
            .iter()
            .enumerate()
            .map(|(document_index, document)| LiveEvidenceDocument {
                evidence_id: document.id.clone(),
                source_id: format!("source-{:03}", document_index + 1),
                time_anchor: format!("time-{:03}", document_index + 1),
                text: document.text.clone(),
            })
            .collect();
        let prompt = LiveKnownAnswerPrompt {
            schema_id: LIVE_KNOWN_ANSWER_PROMPT_SCHEMA_ID.into(),
            scenario_id,
            question,
            evidence,
            response_contract: LiveResponseContract {
                schema_id: LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID.into(),
                instructions: vec![
                    "Use only the supplied evidence; do not invent records or identities.".into(),
                    "Give every claim one or more exact evidence/source/time citations.".into(),
                    "If the initiating cause is not established, say so and cite the observed condition.".into(),
                    "Return only one JSON object matching the response schema.".into(),
                ],
                allowed_claim_roles: ALLOWED_CLAIM_ROLES
                    .iter()
                    .map(|value| (*value).into())
                    .collect(),
                allowed_confidence: ALLOWED_CONFIDENCE
                    .iter()
                    .map(|value| (*value).into())
                    .collect(),
            },
        };
        validate_prompt_values(&prompt)?;
        prepared.push(PreparedLiveKnownAnswerCase {
            prompt,
            case_id: case.truth.case_id.clone(),
            task_id: truth.task_id.clone(),
            packet,
            truth,
        });
    }
    if prepared.is_empty() {
        return Err(live_error("live suite must contain at least one scenario"));
    }
    Ok(prepared)
}

/// Serialize only the provider-visible prompt.
pub fn serialize_live_known_answer_prompt(
    prepared: &PreparedLiveKnownAnswerCase,
) -> CoreResult<String> {
    validate_prompt_values(&prepared.prompt)?;
    serde_json::to_string(&prepared.prompt).map_err(CoreError::from)
}

/// Deterministic digest of the exact provider-visible prompt set.
pub fn live_known_answer_prompt_set_hash(
    prepared: &[PreparedLiveKnownAnswerCase],
) -> CoreResult<String> {
    if prepared.is_empty() {
        return Err(live_error("cannot hash an empty live prompt set"));
    }
    let mut framed = Vec::new();
    for case in prepared {
        let bytes = serialize_live_known_answer_prompt(case)?.into_bytes();
        framed.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
        framed.extend_from_slice(&bytes);
    }
    Ok(hex_sha256(&framed))
}

/// Parse a bounded strict provider response for one exact scenario.
pub fn parse_live_known_answer_response(
    prepared: &PreparedLiveKnownAnswerCase,
    raw: &str,
) -> CoreResult<LiveKnownAnswerResponse> {
    parse_live_known_answer_response_classified(prepared, raw).map_err(response_failure_to_core)
}

/// Parse one response while retaining a bounded, text-free rejection class.
pub fn parse_live_known_answer_response_classified(
    prepared: &PreparedLiveKnownAnswerCase,
    raw: &str,
) -> Result<LiveKnownAnswerResponse, LiveKnownAnswerResponseFailure> {
    if raw.len() > LIVE_KNOWN_ANSWER_RESPONSE_MAX_BYTES {
        return Err(LiveKnownAnswerResponseFailure::Parser);
    }
    validate_provider_controlled_text(raw)?;
    let response: LiveKnownAnswerResponse =
        serde_json::from_str(raw).map_err(|_| LiveKnownAnswerResponseFailure::Parser)?;
    validate_live_known_answer_canonical_response(&response, &prepared.prompt.scenario_id)?;
    validate_response_prompt_separation(&response, &prepared.prompt)?;
    Ok(response)
}

/// Validate the canonical response shape independently of evaluator truth.
/// This is the reload gate for privacy-safe response captures.
pub fn validate_live_known_answer_canonical_response(
    response: &LiveKnownAnswerResponse,
    expected_scenario_id: &str,
) -> Result<(), LiveKnownAnswerResponseFailure> {
    if response.schema_id != LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID
        || response.scenario_id != expected_scenario_id
    {
        return Err(LiveKnownAnswerResponseFailure::Parser);
    }
    if !ALLOWED_CONFIDENCE.contains(&response.confidence.as_str())
        || response.claims.iter().any(|claim| {
            claim
                .role
                .as_deref()
                .is_some_and(|role| !ALLOWED_CLAIM_ROLES.contains(&role))
        })
    {
        return Err(LiveKnownAnswerResponseFailure::Vocabulary);
    }
    if response.claims.len() > MAX_CLAIMS
        || response.conclusion.len() > MAX_CONCLUSION_BYTES
        || response.claims.iter().any(|claim| {
            claim.text.len() > MAX_CLAIM_TEXT_BYTES
                || claim.citations.len() > MAX_CITATIONS_PER_CLAIM
        })
        || serde_json::to_vec(response)
            .map_err(|_| LiveKnownAnswerResponseFailure::Parser)?
            .len()
            > LIVE_KNOWN_ANSWER_RESPONSE_MAX_BYTES
    {
        return Err(LiveKnownAnswerResponseFailure::Parser);
    }
    validate_response_values_classified(response)
}

/// Score one strict response. Diagnostic evidence can only enter through the
/// separate host-owned argument; providers cannot serialize that field.
pub fn score_live_known_answer_response(
    prepared: &PreparedLiveKnownAnswerCase,
    response: &LiveKnownAnswerResponse,
    host_diagnostic: Option<ScriptedDiagnostic>,
) -> CoreResult<LiveKnownAnswerScore> {
    validate_live_known_answer_canonical_response(response, &prepared.prompt.scenario_id)
        .map_err(response_failure_to_core)?;
    let mut exact_citations = true;
    let mut unique_citations = true;
    let mut every_claim_cited = !response.claims.is_empty();
    let claims = response
        .claims
        .iter()
        .map(|claim| {
            if claim.citations.is_empty() || claim.text.trim().is_empty() {
                every_claim_cited = false;
            }
            let mut seen = BTreeSet::new();
            let mut evidence_ids = Vec::with_capacity(claim.citations.len());
            for citation in &claim.citations {
                let tuple = (
                    citation.evidence_id.as_str(),
                    citation.source_id.as_str(),
                    citation.time_anchor.as_str(),
                );
                if !seen.insert(tuple) {
                    unique_citations = false;
                }
                let matches = prepared.prompt.evidence.iter().any(|evidence| {
                    evidence.evidence_id == citation.evidence_id
                        && evidence.source_id == citation.source_id
                        && evidence.time_anchor == citation.time_anchor
                });
                if !matches {
                    exact_citations = false;
                }
                evidence_ids.push(citation.evidence_id.clone());
            }
            AnswerClaim {
                text: claim.text.clone(),
                evidence_ids,
                role: claim.role.clone(),
            }
        })
        .collect();

    let candidate = CandidateAnswer {
        candidate_id: format!("live:{}", prepared.prompt.scenario_id),
        task_id: prepared.task_id.clone(),
        packet_id: prepared.packet.packet_id.clone(),
        asserts_root_cause_established: response.asserts_root_cause_established,
        claims,
        conclusion: response.conclusion.clone(),
        confidence: response.confidence.clone(),
        diagnostic: host_diagnostic,
    };
    let mut answer = score_answer(&candidate, &prepared.truth, &prepared.packet);
    answer.dimensions.push(AnswerDimension {
        id: "live_claim_citation_contract".into(),
        passed: every_claim_cited,
        reason: if every_claim_cited {
            "every live claim has exact citation fields".into()
        } else {
            failure_reason::MISSING_REQUIRED_CITATION.into()
        },
    });
    answer.dimensions.push(AnswerDimension {
        id: "live_exact_source_time_citations".into(),
        passed: exact_citations,
        reason: if exact_citations {
            "all live citations match one frozen evidence/source/time tuple".into()
        } else {
            EXACT_CITATION_MISMATCH.into()
        },
    });
    answer.dimensions.push(AnswerDimension {
        id: "live_unique_citations".into(),
        passed: unique_citations,
        reason: if unique_citations {
            "live citations are unique within each claim".into()
        } else {
            DUPLICATE_EXACT_CITATION.into()
        },
    });
    answer.passed = answer.dimensions.iter().all(|dimension| dimension.passed);
    answer.status = LaneStatus::Executed;

    Ok(LiveKnownAnswerScore {
        scenario_id: prepared.prompt.scenario_id.clone(),
        case_id: prepared.case_id.clone(),
        answer,
    })
}

fn validate_prompt_values(prompt: &LiveKnownAnswerPrompt) -> CoreResult<()> {
    if prompt.schema_id != LIVE_KNOWN_ANSWER_PROMPT_SCHEMA_ID
        || prompt.response_contract.schema_id != LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID
        || prompt.scenario_id.trim().is_empty()
        || prompt.question.trim().is_empty()
        || prompt.evidence.is_empty()
    {
        return Err(live_error("invalid provider-visible prompt contract"));
    }
    let values = [
        prompt.schema_id.as_str(),
        prompt.scenario_id.as_str(),
        prompt.question.as_str(),
        prompt.response_contract.schema_id.as_str(),
    ]
    .into_iter()
    .chain(
        prompt
            .response_contract
            .instructions
            .iter()
            .map(String::as_str),
    )
    .chain(
        prompt
            .response_contract
            .allowed_claim_roles
            .iter()
            .map(String::as_str),
    )
    .chain(
        prompt
            .response_contract
            .allowed_confidence
            .iter()
            .map(String::as_str),
    )
    .chain(prompt.evidence.iter().flat_map(|document| {
        [
            document.evidence_id.as_str(),
            document.source_id.as_str(),
            document.time_anchor.as_str(),
            document.text.as_str(),
        ]
    }))
    .collect::<Vec<_>>();
    let visible_blob = values.join("\n");
    if !scan_privacy_text(&visible_blob).is_empty() {
        return Err(CoreError::Policy(
            failure_reason::EXPORT_PRIVACY_VIOLATION.into(),
        ));
    }
    let normalized = visible_blob.to_ascii_lowercase();
    if RUNTIME_FORBIDDEN_EVALUATOR_TOKENS
        .iter()
        .any(|token| normalized.contains(&token.to_ascii_lowercase()))
    {
        return Err(CoreError::Policy(
            failure_reason::TRUTH_LEAKED_INTO_RUNTIME.into(),
        ));
    }
    Ok(())
}

fn validate_response_values_classified(
    response: &LiveKnownAnswerResponse,
) -> Result<(), LiveKnownAnswerResponseFailure> {
    let values = [
        response.schema_id.as_str(),
        response.scenario_id.as_str(),
        response.conclusion.as_str(),
        response.confidence.as_str(),
    ]
    .into_iter()
    .chain(response.claims.iter().flat_map(|claim| {
        std::iter::once(claim.text.as_str())
            .chain(claim.role.iter().map(String::as_str))
            .chain(claim.citations.iter().flat_map(|citation| {
                [
                    citation.evidence_id.as_str(),
                    citation.source_id.as_str(),
                    citation.time_anchor.as_str(),
                ]
            }))
    }))
    .collect::<Vec<_>>();
    for value in values {
        validate_provider_controlled_text(value)?;
    }
    Ok(())
}

/// Reject provider-controlled text when any shared secret scrubber, absolute
/// path detector, endpoint detector, or evaluator-only marker would change or
/// classify it. This is a reject-only gate: captured text is never rewritten.
pub(super) fn validate_provider_controlled_text(
    value: &str,
) -> Result<(), LiveKnownAnswerResponseFailure> {
    if contains_shared_private_material(value) || contains_endpoint_reference(value) {
        return Err(LiveKnownAnswerResponseFailure::Privacy);
    }
    let normalized = value.to_ascii_lowercase();
    const ENDPOINT_MARKERS: &[&str] = &[
        "http://",
        "https://",
        "file://",
        "ftp://",
        "ssh://",
        "ws://",
        "wss://",
        "ldap://",
        "ldaps://",
        "postgres://",
        "postgresql://",
    ];
    const EVALUATOR_MARKERS: &[&str] = &[
        "must_include",
        "must_exclude",
        "mustinclude",
        "mustexclude",
        "evaluator_only",
        "evaluator_truth",
        "initiating_evidence",
        "propagated_symptom",
        "answer_key",
        "decoy:",
        "causal trigger:",
        "symptom only:",
        "response_contract",
        LIVE_KNOWN_ANSWER_PROMPT_SCHEMA_ID,
        "treat the user json as the complete evidence packet",
    ];
    if ENDPOINT_MARKERS
        .iter()
        .chain(EVALUATOR_MARKERS)
        .any(|marker| normalized.contains(marker))
    {
        return Err(LiveKnownAnswerResponseFailure::Privacy);
    }
    Ok(())
}

/// Validate a provider-reported or configured model identity without treating
/// a legitimate `namespace/model` name as prose containing a route. The
/// identity remains reject-only: endpoint, address, route, secret, path, and
/// control-character forms are never rewritten into something publishable.
pub(super) fn validate_provider_model_identity(
    value: &str,
) -> Result<(), LiveKnownAnswerResponseFailure> {
    if value.trim() != value
        || value.is_empty()
        || value.len() > 256
        || value.chars().any(|character| {
            character.is_control() || character.is_whitespace() || character == '`'
        })
        || contains_shared_private_material(value)
        || contains_endpoint_reference(value)
    {
        return Err(LiveKnownAnswerResponseFailure::Privacy);
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.len() > 3
        || segments.iter().any(|segment| {
            segment.is_empty()
                || segment.len() > 128
                || !segment.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'+')
                })
        })
        || route_segments_are_endpoint_shaped(&segments)
    {
        return Err(LiveKnownAnswerResponseFailure::Privacy);
    }
    Ok(())
}

fn contains_shared_private_material(value: &str) -> bool {
    !scan_privacy_text(value).is_empty()
        || scrub_secrets(value) != value
        || opaque_absolute_paths(value) != value
        || contains_unc_path(value)
        || contains_secret_assignment(value)
}

fn contains_unc_path(value: &str) -> bool {
    value.contains("\\\\") || value.trim_start().starts_with("//")
}

fn contains_secret_assignment(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    const ASSIGNMENTS: &[&str] = &[
        "token=",
        "token:",
        "api_key=",
        "api_key:",
        "api-key=",
        "api-key:",
        "apikey=",
        "apikey:",
        "access_token=",
        "access_token:",
        "secret=",
        "secret:",
        "password=",
        "password:",
        "authorization=",
        "authorization:",
        "bearer ",
    ];
    ASSIGNMENTS.iter().any(|marker| normalized.contains(marker))
}

fn contains_endpoint_reference(value: &str) -> bool {
    value
        .split(|character: char| {
            character.is_whitespace()
                || matches!(character, '"' | '\'' | '(' | ')' | ',' | ';' | '<' | '>')
        })
        .map(|token| {
            token.trim_matches(|character: char| matches!(character, '.' | '!' | '?' | '{' | '}'))
        })
        .filter(|token| !token.is_empty())
        .any(token_is_endpoint_reference)
}

fn token_is_endpoint_reference(token: &str) -> bool {
    if let Some(bracketed) = token.strip_prefix('[') {
        if let Some((host, suffix)) = bracketed.split_once(']') {
            if host.parse::<std::net::IpAddr>().is_ok() {
                return suffix.is_empty()
                    || suffix.starts_with('/')
                    || suffix
                        .strip_prefix(':')
                        .and_then(|port| port.split('/').next())
                        .is_some_and(valid_endpoint_port);
            }
        }
    }

    let authority = token.split('/').next().unwrap_or(token);
    if authority.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }

    if let Some((host, port)) = authority.rsplit_once(':') {
        if !host.is_empty() && valid_endpoint_port(port) {
            return host.parse::<std::net::IpAddr>().is_ok()
                || host.eq_ignore_ascii_case("localhost")
                || is_hostname(host)
                || is_single_dns_label(host);
        }
    }

    let segments = token
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    token.starts_with('/')
        || (token.contains('/')
            && (authority.parse::<std::net::IpAddr>().is_ok()
                || is_hostname(authority)
                || is_internal_hostname(authority)
                || route_segments_are_endpoint_shaped(&segments)))
        || is_internal_hostname(token)
}

fn valid_endpoint_port(port: &str) -> bool {
    port.parse::<u16>().is_ok_and(|parsed| parsed > 0)
}

fn is_hostname(host: &str) -> bool {
    host.contains('.') && host.split('.').all(is_single_dns_label)
}

fn is_single_dns_label(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 63
        && !host.starts_with('-')
        && !host.ends_with('-')
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn is_internal_hostname(host: &str) -> bool {
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
        || normalized.starts_with("ip-10-")
        || normalized.starts_with("ip-127-")
        || normalized.starts_with("ip-169-254-")
        || normalized.starts_with("ip-192-168-")
}

fn route_segments_are_endpoint_shaped(segments: &[&str]) -> bool {
    if segments.len() < 2 {
        return false;
    }
    const ROUTE_WORDS: &[&str] = &[
        "api",
        "chat",
        "completions",
        "completion",
        "embeddings",
        "models",
        "responses",
    ];
    segments.iter().any(|segment| {
        let normalized = segment.to_ascii_lowercase();
        normalized.strip_prefix('v').is_some_and(|version| {
            !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
        }) || ROUTE_WORDS.contains(&normalized.as_str())
    })
}

pub(super) fn validate_response_prompt_separation(
    response: &LiveKnownAnswerResponse,
    prompt: &LiveKnownAnswerPrompt,
) -> Result<(), LiveKnownAnswerResponseFailure> {
    let response_text = std::iter::once(response.conclusion.as_str())
        .chain(response.claims.iter().flat_map(|claim| {
            std::iter::once(claim.text.as_str()).chain(claim.citations.iter().flat_map(
                |citation| {
                    [
                        citation.evidence_id.as_str(),
                        citation.source_id.as_str(),
                        citation.time_anchor.as_str(),
                    ]
                },
            ))
        }))
        .collect::<Vec<_>>();
    let prompt_fragments = std::iter::once(prompt.question.as_str())
        .chain(
            prompt
                .evidence
                .iter()
                .map(|document| document.text.as_str()),
        )
        .chain(
            prompt
                .response_contract
                .instructions
                .iter()
                .map(String::as_str),
        );
    for fragment in prompt_fragments {
        let fragment = fragment.trim();
        if fragment.len() < 24 {
            continue;
        }
        let normalized_fragment = fragment.to_ascii_lowercase();
        if response_text
            .iter()
            .any(|value| value.to_ascii_lowercase().contains(&normalized_fragment))
        {
            return Err(LiveKnownAnswerResponseFailure::Privacy);
        }
    }
    Ok(())
}

fn response_failure_to_core(failure: LiveKnownAnswerResponseFailure) -> CoreError {
    match failure {
        LiveKnownAnswerResponseFailure::Privacy => {
            CoreError::Policy(failure_reason::EXPORT_PRIVACY_VIOLATION.into())
        }
        LiveKnownAnswerResponseFailure::Parser => {
            live_error("provider response failed the strict parser")
        }
        LiveKnownAnswerResponseFailure::Vocabulary => {
            live_error("provider response uses a value outside the closed vocabulary")
        }
    }
}

fn live_error(detail: &str) -> CoreError {
    CoreError::Config(format!(
        "{}: {detail}",
        failure_reason::INVALID_ANSWER_SCHEMA
    ))
}

#[cfg(all(test, unix))]
mod owner_directory_tests {
    use super::{validate_owner_metadata, LiveKnownAnswerOwnerDirectory};
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use tempfile::{Builder, TempDir};

    fn owner_tempdir() -> TempDir {
        let root = std::env::temp_dir()
            .canonicalize()
            .expect("canonical temporary root");
        let directory = Builder::new()
            .prefix("contextdesk-owner-directory-")
            .tempdir_in(root)
            .expect("owner temporary directory");
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .expect("owner-only temporary directory");
        directory
    }

    #[test]
    fn owner_directory_rejects_mode_uid_and_symlink_boundaries() {
        let root = owner_tempdir();
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).expect("parent");
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
            .expect("parent mode");
        let metadata = std::fs::metadata(&parent).expect("metadata");
        LiveKnownAnswerOwnerDirectory::open(&parent).expect("safe owner directory");

        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o750))
            .expect("unsafe parent mode");
        assert!(LiveKnownAnswerOwnerDirectory::open(&parent).is_err());
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
            .expect("restore parent mode");

        assert!(LiveKnownAnswerOwnerDirectory::open_with_expected_uid(
            &parent,
            metadata.uid().wrapping_add(1),
        )
        .is_err());

        let link = root.path().join("parent-link");
        symlink(&parent, &link).expect("parent symlink");
        assert!(LiveKnownAnswerOwnerDirectory::open(&link).is_err());
    }

    #[test]
    fn owner_directory_detects_path_replacement_and_file_uid_mismatch() {
        let root = owner_tempdir();
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).expect("parent");
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
            .expect("parent mode");
        let directory = LiveKnownAnswerOwnerDirectory::open(&parent).expect("directory");
        for unsafe_name in ["", ".", "..", "nested/file", "file/"] {
            assert!(directory.create_owner_regular(unsafe_name).is_err());
        }
        let file = directory
            .create_owner_regular("store.json")
            .expect("owner file");
        let metadata = file.metadata().expect("file metadata");
        assert!(
            validate_owner_metadata(&metadata, metadata.uid().wrapping_add(1), false,).is_err()
        );

        let moved = root.path().join("moved-parent");
        std::fs::rename(&parent, &moved).expect("move retained parent");
        std::fs::create_dir(&parent).expect("replacement parent");
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
            .expect("replacement mode");
        assert!(directory.revalidate_path(&parent).is_err());
    }
}
