//! Public, host-neutral runtime facade for triage execution.
//!
//! Wire contracts remain in `cd-triage-sdk`. This crate adds canonical request
//! identity, dispatch guards, a host-implemented engine port, replay binding,
//! and typed terminal extraction. It does not resolve providers, configuration,
//! credentials, corpora, files, databases, or network transports.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use std::fmt;

use async_trait::async_trait;
use cd_triage_sdk::{
    TriageCancellationV1, TriageContractError, TriagePolicySelectionV2, TriageReconciliationV1,
    TriageReplayV1, TriageRequestV2, TriageResultV2, TriageRunEventPayloadV2, TriageRunEventV2,
    TriageSlotKindV2, TriageValidationState,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// Validate `request` and fingerprint its recursively canonicalized JSON.
///
/// Object keys are sorted at every depth before the SHA-256 digest is taken.
/// Array order remains significant. The returned value uses the public
/// `sha256:<hex>` namespace.
pub fn canonical_request_fingerprint(
    request: &TriageRequestV2,
) -> Result<String, TriageRuntimeError> {
    request
        .validate()
        .map_err(TriageRuntimeError::InvalidRequest)?;
    fingerprint_validated_request(request)
}

fn fingerprint_validated_request(request: &TriageRequestV2) -> Result<String, TriageRuntimeError> {
    let mut value =
        serde_json::to_value(request).map_err(|_| TriageRuntimeError::Canonicalization)?;
    let Value::Object(fields) = &mut value else {
        return Err(TriageRuntimeError::Canonicalization);
    };
    // Run identity is checked separately and may itself be derived from this
    // fingerprint by deterministic adapters. Excluding it avoids a dependency
    // cycle without weakening exact replay-to-run binding.
    if fields.remove("run_id").is_none() {
        return Err(TriageRuntimeError::Canonicalization);
    }
    let canonical = canonicalize_json(value);
    let bytes = serde_json::to_vec(&canonical).map_err(|_| TriageRuntimeError::Canonicalization)?;
    let digest = Sha256::digest(bytes);
    Ok(format!("sha256:{digest:x}"))
}

fn canonicalize_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let mut entries = values
                .into_iter()
                .map(|(key, value)| (key, canonicalize_json(value)))
                .collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.cmp(&right.0));
            let mut canonical = Map::new();
            for (key, value) in entries {
                canonical.insert(key, value);
            }
            Value::Object(canonical)
        }
        scalar => scalar,
    }
}

/// A validated request bound to its canonical public fingerprint.
///
/// Fields are private so instances can only be created through [`Self::new`].
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedTriageRequest {
    request: TriageRequestV2,
    fingerprint: String,
}

impl ValidatedTriageRequest {
    /// Validate and canonically fingerprint a request.
    pub fn new(request: TriageRequestV2) -> Result<Self, TriageRuntimeError> {
        request
            .validate()
            .map_err(TriageRuntimeError::InvalidRequest)?;
        let fingerprint = fingerprint_validated_request(&request)?;
        Ok(Self {
            request,
            fingerprint,
        })
    }

    /// Return the validated wire request.
    pub fn request(&self) -> &TriageRequestV2 {
        &self.request
    }

    /// Return the canonical `sha256:<hex>` request fingerprint.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// Consume the wrapper and return the validated wire request.
    pub fn into_request(self) -> TriageRequestV2 {
        self.request
    }
}

/// Bounded, content-free failure categories exposed by a host engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TriageEngineFailureCategory {
    /// Host preflight could not authorize or resolve the request.
    PreflightRejected,
    /// A required host capability was unavailable.
    HostUnavailable,
    /// Execution failed without a valid terminal replay.
    ExecutionFailed,
    /// The host deadline elapsed without a valid terminal replay.
    DeadlineExceeded,
    /// Execution was cancelled without a valid terminal replay.
    Cancelled,
    /// A provisional event failed the public event validator.
    InvalidEvent,
    /// Cancellation dispatch failed.
    CancellationFailed,
}

impl fmt::Display for TriageEngineFailureCategory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::PreflightRejected => "preflight_rejected",
            Self::HostUnavailable => "host_unavailable",
            Self::ExecutionFailed => "execution_failed",
            Self::DeadlineExceeded => "deadline_exceeded",
            Self::Cancelled => "cancelled",
            Self::InvalidEvent => "invalid_event",
            Self::CancellationFailed => "cancellation_failed",
        };
        formatter.write_str(value)
    }
}

/// A content-free engine failure.
///
/// This type intentionally cannot retain provider bodies, endpoints, paths,
/// prompts, credentials, or arbitrary host error strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("triage engine failure ({category})")]
pub struct TriageEngineFailure {
    category: TriageEngineFailureCategory,
}

impl TriageEngineFailure {
    /// Construct a failure from a bounded category.
    pub const fn new(category: TriageEngineFailureCategory) -> Self {
        Self { category }
    }

    /// Return the bounded failure category.
    pub const fn category(self) -> TriageEngineFailureCategory {
        self.category
    }
}

/// Host-local callback for individually validated public run events.
///
/// Calling [`Self::emit`] validates an event before forwarding it. Streamed
/// events remain provisional: they are not authoritative unless the engine's
/// final returned replay passes all facade validation. The sink neither
/// duplicates nor reorders events.
pub struct TriageEventSink {
    run_id: String,
    request_fingerprint: String,
    next_sequence: u64,
    callback: Box<dyn FnMut(&TriageRunEventV2) + Send + 'static>,
}

impl TriageEventSink {
    /// Bind a host-local event callback to one validated request.
    pub fn new<F>(request: &ValidatedTriageRequest, callback: F) -> Self
    where
        F: FnMut(&TriageRunEventV2) + Send + 'static,
    {
        Self {
            run_id: request.request().run_id.clone(),
            request_fingerprint: request.fingerprint().to_string(),
            next_sequence: 0,
            callback: Box::new(callback),
        }
    }

    /// Validate and forward one request-bound provisional event unchanged.
    pub fn emit(&mut self, event: &TriageRunEventV2) -> Result<(), TriageEngineFailure> {
        event
            .validate()
            .map_err(|_| TriageEngineFailure::new(TriageEngineFailureCategory::InvalidEvent))?;
        if event.run_id != self.run_id || event.sequence != self.next_sequence {
            return Err(TriageEngineFailure::new(
                TriageEngineFailureCategory::InvalidEvent,
            ));
        }
        match (&event.event, self.next_sequence) {
            (
                TriageRunEventPayloadV2::RunStarted {
                    request_fingerprint,
                    ..
                },
                0,
            ) if request_fingerprint == &self.request_fingerprint => {}
            (TriageRunEventPayloadV2::RunStarted { .. }, _) | (_, 0) => {
                return Err(TriageEngineFailure::new(
                    TriageEngineFailureCategory::InvalidEvent,
                ));
            }
            _ => {}
        }
        (self.callback)(event);
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| TriageEngineFailure::new(TriageEngineFailureCategory::InvalidEvent))?;
        Ok(())
    }

    fn is_bound_to(&self, request: &ValidatedTriageRequest) -> bool {
        self.run_id == request.request().run_id
            && self.request_fingerprint == request.fingerprint()
            && self.next_sequence == 0
    }
}

impl fmt::Debug for TriageEventSink {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TriageEventSink(..)")
    }
}

/// Host-owned execution port used by the public facade.
///
/// Provider/configuration/corpus resolution and all retry, deadline, and
/// cancellation mechanics stay behind this trait. The facade always calls
/// [`Self::preflight`] before [`Self::execute`]. Engine methods use shared
/// references so a host's interior-mutable cancellation signal can be
/// dispatched while execution is in flight.
#[async_trait]
pub trait TriageEngine: Send + Sync {
    /// Host-owned, content-opaque authorization and resolution result.
    type Preflight: Send;

    /// Resolve and authorize everything needed to execute this exact request.
    async fn preflight(
        &self,
        request: &ValidatedTriageRequest,
    ) -> Result<Self::Preflight, TriageEngineFailure>;

    /// Execute a preflighted request and return the authoritative replay.
    async fn execute(
        &self,
        request: ValidatedTriageRequest,
        preflight: Self::Preflight,
        events: Option<TriageEventSink>,
    ) -> Result<TriageReplayV1, TriageEngineFailure>;

    /// Dispatch a validated cancellation request.
    fn cancel(&self, cancellation: &TriageCancellationV1) -> Result<(), TriageEngineFailure>;
}

/// Typed terminal state derived from the last event of a validated replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriageExecutionTerminal {
    /// The run completed with an authoritative result.
    Completed {
        /// Completed result.
        result: TriageResultV2,
    },
    /// The run failed, possibly with an honest partial result.
    Failed {
        /// Content-free public failure category.
        category: String,
        /// Honest partial result retained by the terminal event.
        partial_result: Option<TriageResultV2>,
    },
    /// The run timed out, possibly with an honest partial result.
    TimedOut {
        /// Content-free public timeout category.
        category: String,
        /// Honest partial result retained by the terminal event.
        partial_result: Option<TriageResultV2>,
    },
    /// The run was cancelled, possibly with an honest partial result.
    Cancelled {
        /// Cancellation identity bound to the request.
        cancellation_id: String,
        /// Honest partial result retained by the terminal event.
        partial_result: Option<TriageResultV2>,
    },
}

/// A validated authoritative replay and its typed terminal projection.
///
/// No usage, cost, or timing values are synthesized by this facade.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriageExecution {
    replay: TriageReplayV1,
    terminal: TriageExecutionTerminal,
}

impl TriageExecution {
    /// Return the validated authoritative replay.
    pub fn replay(&self) -> &TriageReplayV1 {
        &self.replay
    }

    /// Return the terminal state projected from the replay's final event.
    pub fn terminal(&self) -> &TriageExecutionTerminal {
        &self.terminal
    }

    /// Consume the execution and return its validated replay.
    pub fn into_replay(self) -> TriageReplayV1 {
        self.replay
    }
}

/// Execute a Standard request after host preflight.
///
/// Saved and inline policy requests fail before engine preflight.
pub async fn triage<E>(
    engine: &E,
    request: TriageRequestV2,
    events: Option<TriageEventSink>,
) -> Result<TriageExecution, TriageRuntimeError>
where
    E: TriageEngine + ?Sized,
{
    let request = ValidatedTriageRequest::new(request)?;
    if !matches!(
        &request.request().policy,
        TriagePolicySelectionV2::Standard { .. }
    ) {
        return Err(TriageRuntimeError::StandardPolicyRequired);
    }
    execute_preflighted(engine, request, events).await
}

/// Execute a Saved or Inline policy request after host preflight.
///
/// Standard requests fail before engine preflight.
pub async fn triage_with_policy<E>(
    engine: &E,
    request: TriageRequestV2,
    events: Option<TriageEventSink>,
) -> Result<TriageExecution, TriageRuntimeError>
where
    E: TriageEngine + ?Sized,
{
    let request = ValidatedTriageRequest::new(request)?;
    if matches!(
        &request.request().policy,
        TriagePolicySelectionV2::Standard { .. }
    ) {
        return Err(TriageRuntimeError::ConfiguredPolicyRequired);
    }
    execute_preflighted(engine, request, events).await
}

async fn execute_preflighted<E>(
    engine: &E,
    request: ValidatedTriageRequest,
    events: Option<TriageEventSink>,
) -> Result<TriageExecution, TriageRuntimeError>
where
    E: TriageEngine + ?Sized,
{
    if events
        .as_ref()
        .is_some_and(|sink| !sink.is_bound_to(&request))
    {
        return Err(TriageRuntimeError::EventSinkRequestMismatch);
    }
    let preflight = engine.preflight(&request).await?;
    let replay = engine.execute(request.clone(), preflight, events).await?;
    replay_validated(&request, replay)
}

/// Validate a request and bind an existing replay to it without executing.
pub fn replay(
    request: TriageRequestV2,
    replay: TriageReplayV1,
) -> Result<TriageExecution, TriageRuntimeError> {
    replay_validated(&ValidatedTriageRequest::new(request)?, replay)
}

/// Bind an existing replay to an already validated request.
///
/// This verifies canonical replay ordering, exact run and request fingerprint
/// identity, terminal result identity, and cancellation identity.
pub fn replay_validated(
    request: &ValidatedTriageRequest,
    replay: TriageReplayV1,
) -> Result<TriageExecution, TriageRuntimeError> {
    replay
        .validate()
        .map_err(TriageRuntimeError::InvalidReplay)?;
    if replay.run_id != request.request.run_id {
        return Err(TriageRuntimeError::ReplayRunIdentityMismatch);
    }
    if replay.request_fingerprint != request.fingerprint {
        return Err(TriageRuntimeError::ReplayRequestFingerprintMismatch);
    }

    let event = replay
        .events
        .last()
        .ok_or(TriageRuntimeError::InvalidReplay(
            TriageContractError::EmptyReplay,
        ))?;
    let terminal = terminal_from_event(event)?;
    if terminal_result(&terminal).is_some_and(|result| result.run_id != request.request.run_id) {
        return Err(TriageRuntimeError::TerminalResultRunIdentityMismatch);
    }
    if let TriageExecutionTerminal::Cancelled {
        cancellation_id, ..
    } = &terminal
    {
        if cancellation_id != &request.request.cancellation_id {
            return Err(TriageRuntimeError::CancellationIdentityMismatch);
        }
    }
    validate_cross_event_bindings(request, &replay, &terminal)?;

    Ok(TriageExecution { replay, terminal })
}

fn validate_cross_event_bindings(
    request: &ValidatedTriageRequest,
    replay: &TriageReplayV1,
    terminal: &TriageExecutionTerminal,
) -> Result<(), TriageRuntimeError> {
    let mut packet_id = None;
    let mut reconciliation: Option<&TriageReconciliationV1> = None;
    let mut validation_passed = None;
    let mut standard_attempts = 0usize;
    let standard_model = match &request.request().policy {
        TriagePolicySelectionV2::Standard { model } => Some(model),
        TriagePolicySelectionV2::Saved { .. } | TriagePolicySelectionV2::Inline { .. } => None,
    };

    for event in &replay.events {
        match &event.event {
            TriageRunEventPayloadV2::PacketReady {
                packet_id: ready, ..
            } => packet_id = Some(ready.as_str()),
            TriageRunEventPayloadV2::RoleAttempt { attempt } if standard_model.is_some() => {
                standard_attempts += 1;
                if attempt.role != TriageSlotKindV2::Finalizer
                    || attempt.role_slot_id != "standard-finalizer"
                    || attempt.model.as_ref() != standard_model
                {
                    return Err(TriageRuntimeError::StandardAttemptBindingMismatch);
                }
            }
            TriageRunEventPayloadV2::Reconciliation { summary }
            | TriageRunEventPayloadV2::PreliminaryReconciliation { summary }
            | TriageRunEventPayloadV2::FinalReconciliation { summary } => {
                reconciliation = Some(summary)
            }
            TriageRunEventPayloadV2::Validation { passed, .. } => validation_passed = Some(*passed),
            _ => {}
        }
    }

    if standard_model.is_some()
        && (standard_attempts > 1
            || (standard_attempts != 1
                && !matches!(terminal, TriageExecutionTerminal::Cancelled { .. })))
    {
        return Err(TriageRuntimeError::StandardAttemptBindingMismatch);
    }

    if let Some(result) = terminal_result(terminal) {
        if packet_id != Some(result.packet_id.as_str()) {
            return Err(TriageRuntimeError::PacketIdentityMismatch);
        }
        if reconciliation.is_some_and(|summary| summary != &result.reconciliation) {
            return Err(TriageRuntimeError::ReconciliationMismatch);
        }
        let result_passed = result.validation_state == TriageValidationState::Passed;
        let validation_mismatch = validation_passed.is_some_and(|passed| passed != result_passed)
            || (validation_passed.is_none() && result_passed);
        // Validation is a checkpoint, not the terminal commit. A cancellation
        // or whole-turn deadline observed after a passed checkpoint may only
        // make the outcome more conservative. Accept that exact downgrade
        // when the terminal strips the answer/evidence and records the typed
        // interruption; never permit it for Completed or Failed terminals.
        if validation_mismatch
            && !post_validation_interruption_downgrade(validation_passed, terminal, result)
        {
            return Err(TriageRuntimeError::ValidationResultMismatch);
        }
    }

    Ok(())
}

fn post_validation_interruption_downgrade(
    validation_passed: Option<bool>,
    terminal: &TriageExecutionTerminal,
    result: &TriageResultV2,
) -> bool {
    if validation_passed != Some(true)
        || result.validation_state != TriageValidationState::Failed
        || result.answer.is_some()
        || !result.accepted_evidence_ids.is_empty()
    {
        return false;
    }
    match terminal {
        TriageExecutionTerminal::Cancelled {
            partial_result: Some(_),
            ..
        } => result.reason_codes.iter().any(|code| code == "cancelled"),
        TriageExecutionTerminal::TimedOut {
            category,
            partial_result: Some(_),
        } => category == "deadline" && result.reason_codes.iter().any(|code| code == "deadline"),
        TriageExecutionTerminal::Completed { .. }
        | TriageExecutionTerminal::Failed { .. }
        | TriageExecutionTerminal::TimedOut {
            partial_result: None,
            ..
        }
        | TriageExecutionTerminal::Cancelled {
            partial_result: None,
            ..
        } => false,
    }
}

fn terminal_from_event(
    event: &TriageRunEventV2,
) -> Result<TriageExecutionTerminal, TriageRuntimeError> {
    match &event.event {
        TriageRunEventPayloadV2::Completed { result } => Ok(TriageExecutionTerminal::Completed {
            result: result.as_ref().clone(),
        }),
        TriageRunEventPayloadV2::Failed {
            category,
            partial_result,
        } => Ok(TriageExecutionTerminal::Failed {
            category: category.clone(),
            partial_result: partial_result.as_deref().cloned(),
        }),
        TriageRunEventPayloadV2::TimedOut {
            category,
            partial_result,
        } => Ok(TriageExecutionTerminal::TimedOut {
            category: category.clone(),
            partial_result: partial_result.as_deref().cloned(),
        }),
        TriageRunEventPayloadV2::Cancelled {
            cancellation_id,
            partial_result,
        } => Ok(TriageExecutionTerminal::Cancelled {
            cancellation_id: cancellation_id.clone(),
            partial_result: partial_result.as_deref().cloned(),
        }),
        _ => Err(TriageRuntimeError::InvalidReplay(
            TriageContractError::TerminalCount(0),
        )),
    }
}

fn terminal_result(terminal: &TriageExecutionTerminal) -> Option<&TriageResultV2> {
    match terminal {
        TriageExecutionTerminal::Completed { result } => Some(result),
        TriageExecutionTerminal::Failed { partial_result, .. }
        | TriageExecutionTerminal::TimedOut { partial_result, .. }
        | TriageExecutionTerminal::Cancelled { partial_result, .. } => partial_result.as_ref(),
    }
}

/// Validate and request-bind a cancellation before host dispatch.
pub fn cancel<E>(
    engine: &E,
    request: &ValidatedTriageRequest,
    cancellation: &TriageCancellationV1,
) -> Result<(), TriageRuntimeError>
where
    E: TriageEngine + ?Sized,
{
    cancellation
        .validate()
        .map_err(TriageRuntimeError::InvalidCancellation)?;
    if cancellation.run_id != request.request().run_id
        || cancellation.cancellation_id != request.request().cancellation_id
    {
        return Err(TriageRuntimeError::CancellationRequestMismatch);
    }
    engine.cancel(cancellation)?;
    Ok(())
}

/// Public runtime facade failure.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TriageRuntimeError {
    /// Request validation failed.
    #[error("triage request validation failed")]
    InvalidRequest(#[source] TriageContractError),
    /// Cancellation validation failed.
    #[error("triage cancellation validation failed")]
    InvalidCancellation(#[source] TriageContractError),
    /// Replay validation failed.
    #[error("triage replay validation failed")]
    InvalidReplay(#[source] TriageContractError),
    /// Canonical request JSON could not be serialized.
    #[error("triage request canonicalization failed")]
    Canonicalization,
    /// `triage` received a non-Standard policy selection.
    #[error("triage requires a Standard policy selection")]
    StandardPolicyRequired,
    /// `triage_with_policy` received a Standard policy selection.
    #[error("triage_with_policy requires a Saved or Inline policy selection")]
    ConfiguredPolicyRequired,
    /// A provisional event sink was created for another request.
    #[error("triage event sink does not match the request")]
    EventSinkRequestMismatch,
    /// Replay run identity differs from the request run identity.
    #[error("triage replay run identity does not match the request")]
    ReplayRunIdentityMismatch,
    /// Replay fingerprint differs from the request's canonical fingerprint.
    #[error("triage replay request fingerprint does not match the request")]
    ReplayRequestFingerprintMismatch,
    /// A terminal result differs from the request run identity.
    #[error("triage terminal result run identity does not match the request")]
    TerminalResultRunIdentityMismatch,
    /// A cancellation terminal differs from the request cancellation identity.
    #[error("triage cancellation terminal does not match the request")]
    CancellationIdentityMismatch,
    /// A cancellation DTO does not name the validated request.
    #[error("triage cancellation does not match the request")]
    CancellationRequestMismatch,
    /// A terminal result names a packet other than the announced packet.
    #[error("triage terminal packet does not match the replay packet")]
    PacketIdentityMismatch,
    /// A Standard attempt does not bind the exact requested finalizer model.
    #[error("triage Standard attempt does not match the requested finalizer")]
    StandardAttemptBindingMismatch,
    /// The terminal result and authoritative reconciliation differ.
    #[error("triage terminal reconciliation does not match the replay")]
    ReconciliationMismatch,
    /// The validation event and terminal result disagree.
    #[error("triage validation does not match the terminal result")]
    ValidationResultMismatch,
    /// The host engine failed without returning a valid authoritative replay.
    #[error(transparent)]
    Engine(#[from] TriageEngineFailure),
}
