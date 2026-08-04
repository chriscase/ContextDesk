//! Source-agnostic activity contract: what a turn actually did, in terms a
//! person can audit.
//!
//! This is the shared model behind the Activity Inspector in ordinary chat
//! **and** in linked-log chat, and it is deliberately not log-specific. A
//! step that reads a workspace file, a Confluence page, a memory entry, or
//! an imported log corpus is the same shape here; only its
//! [`DataScope`] and [`EvidenceRef`]s differ. Nothing in this module knows
//! what a corpus is.
//!
//! # Relationship to the turn trace
//!
//! [`crate::turn_trace`] already captures, bounded and redacted, exactly
//! what each provider round was about to send. This module does not
//! duplicate that: [`ActivityRecorder`] consumes
//! [`crate::turn_trace::TracedCall`]s and [`crate::events::StreamEvent`]s
//! and projects them into an auditable record. The agent loop, context
//! composition, and tool execution are untouched and unaware.
//!
//! # Three properties this type system is meant to enforce
//!
//! 1. **Heuristics are never labelled deterministic.** Ranking, scoring,
//!    and selection rules are repeatable — run them twice, get the same
//!    answer — but that is not the same claim as "this is a proof." The
//!    mapping lives in [`ActivityOrigin::determinism`] so no caller can
//!    make that claim by accident, and a test pins it.
//! 2. **Credentials cannot be captured.** Not "are scrubbed" — cannot
//!    reach here. The only content-bearing input is
//!    [`crate::turn_trace::TracedCall`], whose bodies are already scrubbed
//!    and bounded, and which is itself built from a
//!    `(&[ChatMessage], &[ToolSpec])` signature that carries no API key, no
//!    base URL, and no HTTP header.
//! 3. **The default retains no prompt bodies.**
//!    [`ActivityDetailLevel::Summary`] — the default — keeps counts, roles,
//!    and timings and drops every message body. Bodies are opt-in via
//!    [`ActivityDetailLevel::Full`], and even then they are the already
//!    redacted, already capped ones the trace produced.

use crate::turn_trace::{TracedCall, TracedMessage, TracedOutcome};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Version of the activity contract this build emits.
///
/// Persisted alongside every record so a later reader can migrate rather
/// than guess. Bump on any change that a v1 reader could misinterpret;
/// additive optional fields do not require a bump.
pub const ACTIVITY_CONTRACT_VERSION: u32 = 1;

/// Most events retained per turn. A pathological turn (many rounds, many
/// tools) must not turn one transcript entry into an unbounded document.
pub const MAX_ACTIVITY_EVENTS: usize = 512;

/// Most characters kept in a `label`.
pub const MAX_ACTIVITY_LABEL_CHARS: usize = 200;

/// Most characters kept in a `detail`.
pub const MAX_ACTIVITY_DETAIL_CHARS: usize = 2_000;

/// Most evidence references retained per event.
pub const MAX_ACTIVITY_EVIDENCE_REFS: usize = 32;

/// Where a step's authority comes from.
///
/// This is the distinction the inspector exists to make visible: a reader
/// must be able to tell "the host computed this and would compute it again"
/// from "a model produced this" from "a person approved this," without
/// reading code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityOrigin {
    /// Supplied by the client or observed in the user's own input — the
    /// question text, an attached selection, a viewport the UI reported.
    ClientEvidence,
    /// Trusted host work with a defined result: an exact lookup, a parse, a
    /// bounded read that either found the thing or did not.
    DeterministicHost,
    /// A repeatable rule the host applies — ranking, scoring, selection,
    /// summarization heuristics. Same inputs give the same output, which is
    /// *not* the same as being a proof. Never classified as deterministic.
    RepeatableHeuristic,
    /// A request to a language model. Same inputs may give a different
    /// answer.
    ProbabilisticModel,
    /// A system outside this application — an HTTP API, a database, a
    /// connector. Neither the host nor the user controls the result.
    ExternalConnector,
    /// A human answered a question: a permission grant or denial, an
    /// Accept/Discard on a proposed write.
    UserDecision,
    /// A durable mutation that required, and had, an explicit grant.
    GovernedWrite,
}

/// How much a reader may rely on a step reproducing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Determinism {
    /// Defined result for defined inputs.
    Deterministic,
    /// Same inputs, same output — but a rule, not a proof.
    Repeatable,
    /// May differ run to run.
    Probabilistic,
    /// A person decided; not reproducible at all.
    Human,
}

impl ActivityOrigin {
    /// The determinism class this origin implies.
    ///
    /// Deliberately a total function on the origin rather than a field a
    /// caller sets, so "deterministic" cannot be claimed for a heuristic by
    /// filling in a struct carelessly.
    pub const fn determinism(self) -> Determinism {
        match self {
            // Client-supplied input is a fact about what was asked.
            Self::ClientEvidence => Determinism::Deterministic,
            Self::DeterministicHost => Determinism::Deterministic,
            // A rule, not a proof — see the type docs.
            Self::RepeatableHeuristic => Determinism::Repeatable,
            Self::ProbabilisticModel => Determinism::Probabilistic,
            // Outside our control: it may answer differently next time.
            Self::ExternalConnector => Determinism::Probabilistic,
            Self::UserDecision => Determinism::Human,
            // The write itself is defined; the decision to allow it was human,
            // and that decision is its own `UserDecision` event.
            Self::GovernedWrite => Determinism::Deterministic,
        }
    }

    /// Stable short label for UI grouping.
    pub const fn label(self) -> &'static str {
        match self {
            Self::ClientEvidence => "Client evidence",
            Self::DeterministicHost => "Host work",
            Self::RepeatableHeuristic => "Heuristic",
            Self::ProbabilisticModel => "Model request",
            Self::ExternalConnector => "External connector",
            Self::UserDecision => "User decision",
            Self::GovernedWrite => "Governed write",
        }
    }
}

/// Lifecycle position of one operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityPhase {
    /// The operation began.
    Started,
    /// Intermediate report; the operation is still running.
    Progress,
    /// The operation reached a terminal state.
    Completed,
}

/// Terminal (or current) result of an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStatus {
    /// Still running, or awaiting a decision.
    Pending,
    /// Finished as intended.
    Ok,
    /// Finished with an error.
    Failed,
    /// Stopped because the user or host cancelled.
    Cancelled,
    /// Completed, but the result was deliberately not delivered — an
    /// ungrounded answer, a denied write, an exhausted budget.
    Withheld,
}

/// What kind of material an event's captured text is, so a retention or
/// export policy can be applied without inspecting the text.
///
/// There is deliberately no `Secret` variant: credentials never reach this
/// boundary, so a classification for them would imply they might.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyClass {
    /// Counts, names, timings, identifiers. No user or source text.
    Metadata,
    /// Text that passed through redaction and length bounding.
    RedactedContent,
    /// Text the user already sees in the transcript.
    UserVisibleContent,
}

/// The kind of material a turn or step was working over. Source-agnostic on
/// purpose: logs are one case, not the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataScopeKind {
    /// Nothing beyond the conversation itself.
    Conversation,
    /// An imported log corpus.
    LogCorpus,
    /// Files in the user's workspace.
    Workspace,
    /// Durable memory.
    Memory,
    /// An external connector (wiki, tracker, database).
    Connector,
}

/// What a turn or step was scoped to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataScope {
    /// Which kind of material.
    pub kind: DataScopeKind,
    /// Stable identifier within that kind, when one exists. Never a path
    /// containing user content — an id or a corpus/space key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Short display label.
    pub label: String,
}

impl DataScope {
    /// An ordinary chat turn: the conversation and nothing else.
    pub fn conversation() -> Self {
        Self {
            kind: DataScopeKind::Conversation,
            id: None,
            label: "Conversation".to_string(),
        }
    }

    /// A turn linked to an imported log corpus.
    pub fn log_corpus(corpus_id: impl Into<String>) -> Self {
        let id = corpus_id.into();
        Self {
            kind: DataScopeKind::LogCorpus,
            label: format!("Log corpus {id}"),
            id: Some(id),
        }
    }
}

/// What caused a step to happen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "trigger", rename_all = "snake_case")]
pub enum ActivityTrigger {
    /// The user's message started it.
    UserMessage,
    /// The host decided to, as part of its own sequencing.
    HostPolicy,
    /// A model asked for it (a tool call).
    ModelRequest {
        /// Which provider round asked.
        round: u32,
    },
    /// A person answered a prompt.
    UserDecision,
    /// A retry of an earlier step.
    Retry {
        /// The operation being retried.
        of_operation_id: String,
    },
}

/// A pointer to something a step read or produced, for "show me why".
///
/// Identifiers only — never the content itself. What an id means is the
/// scope's business, which is what keeps this host-neutral.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceRef {
    /// What kind of thing this points at (`"event"`, `"file"`, `"page"`,
    /// `"memory"`, …). Free-form so new sources need no contract change.
    pub kind: String,
    /// Stable id within that kind.
    pub id: String,
    /// Optional locator within the thing (line range, anchor, offset).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locator: Option<String>,
}

/// Per-role tallies for one provider round — the shape of the context
/// without the context itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleTally {
    /// `system` | `user` | `assistant` | `tool`.
    pub role: String,
    /// How many messages of this role were sent.
    pub messages: usize,
    /// Sum of redacted character counts for this role.
    pub chars: usize,
}

/// Bounded, redacted metadata about one provider round's context.
///
/// `bodies` is `None` unless the caller opted into
/// [`ActivityDetailLevel::Full`]. Everything else is metadata and is always
/// safe to retain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextMetadata {
    /// 0-based provider round within the turn.
    pub round: u32,
    /// Messages actually sent this round.
    pub message_count: usize,
    /// Sum of redacted characters across **every** message sent, not only
    /// the retained ones.
    pub context_used_chars: usize,
    /// True when more messages were sent than the trace retains, so any
    /// bodies present are a prefix.
    pub messages_capped: bool,
    /// Tool names offered this round. Names only; never schemas.
    pub tool_names: Vec<String>,
    /// Per-role shape of the context.
    pub roles: Vec<RoleTally>,
    /// Redacted, capped message bodies — present only at
    /// [`ActivityDetailLevel::Full`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bodies: Option<Vec<TracedMessage>>,
}

/// How much a record retains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityDetailLevel {
    /// **Default.** Counts, roles, timings, names, identifiers. No prompt
    /// bodies are retained at all — not truncated ones, none.
    #[default]
    Summary,
    /// Additionally retains the redacted, capped message bodies the turn
    /// trace produced. Opt-in, because this is the only level that keeps
    /// conversation text outside the transcript itself.
    Full,
}

impl ActivityDetailLevel {
    /// Whether message bodies are retained at this level.
    pub const fn retains_bodies(self) -> bool {
        matches!(self, Self::Full)
    }
}

/// One auditable step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivityEvent {
    /// The turn this belongs to.
    pub turn_id: String,
    /// Stable id for the operation, so `Started`/`Progress`/`Completed`
    /// rows fold into one row in a UI.
    pub operation_id: String,
    /// Monotonic within the turn, starting at 0. Ordering is this field,
    /// never wall-clock time — two events can share a millisecond.
    pub seq: u64,
    /// Milliseconds since the turn started.
    pub elapsed_ms: u64,
    /// Lifecycle position.
    pub phase: ActivityPhase,
    /// Current or terminal result.
    pub status: ActivityStatus,
    /// Where the step's authority comes from.
    pub origin: ActivityOrigin,
    /// Implied by `origin`; stored so a consumer need not re-derive it and
    /// cannot derive it differently.
    pub determinism: Determinism,
    /// One concise line.
    pub label: String,
    /// Optional longer explanation, bounded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// What caused this step.
    pub trigger: ActivityTrigger,
    /// What material it was scoped to.
    pub scope: DataScope,
    /// What it read or produced.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<EvidenceRef>,
    /// Classification of any text this event carries.
    pub privacy: PrivacyClass,
    /// Present on provider-round events only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<ContextMetadata>,
}

/// Everything one turn did, bounded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnActivityRecord {
    /// Contract version — see [`ACTIVITY_CONTRACT_VERSION`].
    #[serde(default = "default_contract_version")]
    pub version: u32,
    /// Stable id for this turn.
    pub turn_id: String,
    /// Owning chat session.
    pub session_id: String,
    /// Owning assistant message, when the host has assigned one. This is
    /// the key durable persistence hangs off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// What the turn as a whole was scoped to.
    pub scope: DataScope,
    /// Terminal status of the turn.
    pub status: ActivityStatus,
    /// Total wall-clock milliseconds.
    pub total_elapsed_ms: u64,
    /// How much this record retains.
    #[serde(default)]
    pub detail_level: ActivityDetailLevel,
    /// Steps, in `seq` order.
    pub events: Vec<ActivityEvent>,
    /// How many events were dropped for the [`MAX_ACTIVITY_EVENTS`] bound.
    /// Non-zero means this record is a prefix, and a reader must say so
    /// rather than presenting it as the whole turn.
    #[serde(default)]
    pub dropped_events: usize,
}

fn default_contract_version() -> u32 {
    ACTIVITY_CONTRACT_VERSION
}

impl TurnActivityRecord {
    /// True when the bound dropped steps, so a UI must not claim
    /// completeness.
    pub fn is_truncated(&self) -> bool {
        self.dropped_events > 0
    }

    /// Provider rounds this turn performed.
    pub fn provider_round_count(&self) -> usize {
        self.events
            .iter()
            .filter(|e| e.origin == ActivityOrigin::ProbabilisticModel)
            .filter(|e| e.phase == ActivityPhase::Completed)
            .count()
    }

    /// Total redacted characters sent across every provider round.
    pub fn total_context_chars(&self) -> usize {
        self.events
            .iter()
            .filter_map(|e| e.context.as_ref())
            .map(|c| c.context_used_chars)
            .sum()
    }
}

fn bound_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        text.chars().take(max).collect()
    }
}

/// Builds a [`TurnActivityRecord`] from what a turn produced.
///
/// Deliberately a projection, not a second capture path: the caller hands
/// over [`TracedCall`]s that [`crate::turn_trace::TracingChatBackend`]
/// already recorded, plus the host's own [`crate::events::StreamEvent`]s.
/// Nothing here can observe anything the turn did not already produce.
#[derive(Debug)]
pub struct ActivityRecorder {
    turn_id: String,
    session_id: String,
    scope: DataScope,
    detail: ActivityDetailLevel,
    events: Vec<ActivityEvent>,
    dropped: usize,
    seq: u64,
}

impl ActivityRecorder {
    /// Start a record for one turn. `detail` defaults to
    /// [`ActivityDetailLevel::Summary`] at every call site that does not
    /// deliberately ask for more.
    pub fn new(
        turn_id: impl Into<String>,
        session_id: impl Into<String>,
        scope: DataScope,
        detail: ActivityDetailLevel,
    ) -> Self {
        Self {
            turn_id: turn_id.into(),
            session_id: session_id.into(),
            scope,
            detail,
            events: Vec::new(),
            dropped: 0,
            seq: 0,
        }
    }

    /// The detail level this recorder was built with.
    pub fn detail_level(&self) -> ActivityDetailLevel {
        self.detail
    }

    /// Append one step, applying the [`MAX_ACTIVITY_EVENTS`] bound and
    /// assigning the next monotonic `seq`.
    ///
    /// Over the bound, the step is counted in `dropped_events` and
    /// discarded — a prefix that says it is a prefix, never a silent
    /// truncation.
    pub fn push(&mut self, mut event: ActivityEvent) {
        if self.events.len() >= MAX_ACTIVITY_EVENTS {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        event.turn_id.clone_from(&self.turn_id);
        event.seq = self.seq;
        event.determinism = event.origin.determinism();
        event.label = bound_chars(&event.label, MAX_ACTIVITY_LABEL_CHARS);
        event.detail = event
            .detail
            .map(|d| bound_chars(&d, MAX_ACTIVITY_DETAIL_CHARS));
        event.evidence.truncate(MAX_ACTIVITY_EVIDENCE_REFS);
        if !self.detail.retains_bodies() {
            if let Some(context) = event.context.as_mut() {
                context.bodies = None;
            }
        }
        self.seq = self.seq.saturating_add(1);
        self.events.push(event);
    }

    /// Project every provider round from the turn trace into events.
    ///
    /// One [`ActivityEvent`] per [`TracedCall`], carrying the round's
    /// bounded context metadata. Bodies are attached only at
    /// [`ActivityDetailLevel::Full`]; [`Self::push`] strips them otherwise,
    /// so a caller cannot leak them by constructing the event by hand.
    pub fn record_provider_rounds(&mut self, calls: &[TracedCall]) {
        for call in calls {
            let round = u32::try_from(call.seq).unwrap_or(u32::MAX);
            let (status, label, detail) = match &call.outcome {
                TracedOutcome::Completed {
                    finish_reason,
                    tool_call_count,
                } => (
                    ActivityStatus::Ok,
                    format!("Model request (round {})", round + 1),
                    Some(if *tool_call_count > 0 {
                        format!(
                            "finish_reason={finish_reason}; requested {tool_call_count} tool call(s)"
                        )
                    } else {
                        format!("finish_reason={finish_reason}; no tool calls")
                    }),
                ),
                // Already redacted by the trace.
                TracedOutcome::Failed { message } => (
                    ActivityStatus::Failed,
                    format!("Model request failed (round {})", round + 1),
                    Some(message.clone()),
                ),
            };
            let context = ContextMetadata {
                round,
                message_count: call.messages.len(),
                context_used_chars: call.context_used_chars,
                messages_capped: call.messages_capped,
                tool_names: call.tool_names.clone(),
                roles: role_tallies(&call.messages),
                bodies: self.detail.retains_bodies().then(|| call.messages.clone()),
            };
            let privacy = if context.bodies.is_some() {
                PrivacyClass::RedactedContent
            } else {
                PrivacyClass::Metadata
            };
            self.push(ActivityEvent {
                turn_id: String::new(),
                operation_id: format!("provider-round-{round}"),
                seq: 0,
                elapsed_ms: call.elapsed_ms,
                phase: ActivityPhase::Completed,
                status,
                origin: ActivityOrigin::ProbabilisticModel,
                determinism: Determinism::Probabilistic,
                label,
                detail,
                trigger: if round == 0 {
                    ActivityTrigger::UserMessage
                } else {
                    ActivityTrigger::HostPolicy
                },
                scope: self.scope.clone(),
                evidence: Vec::new(),
                privacy,
                context: Some(context),
            });
        }
    }

    /// Project host stream events (tools, permissions, search trail, errors)
    /// into activity steps. Only metadata / already-UI-facing summaries —
    /// never raw tool arguments or permission previews (those can hold
    /// unredacted draft content).
    pub fn record_stream_events(&mut self, events: &[crate::events::StreamEvent]) {
        use crate::events::{StreamEvent, ToolPhase};
        for event in events {
            match event {
                StreamEvent::Tool {
                    id,
                    name,
                    phase,
                    summary,
                    detail,
                    ok,
                } => {
                    let (phase_a, status) = match phase {
                        ToolPhase::Started => (ActivityPhase::Started, ActivityStatus::Pending),
                        ToolPhase::Finished => (
                            ActivityPhase::Completed,
                            if ok.unwrap_or(false) {
                                ActivityStatus::Ok
                            } else {
                                ActivityStatus::Failed
                            },
                        ),
                    };
                    self.push(ActivityEvent {
                        turn_id: String::new(),
                        operation_id: format!("tool-{id}"),
                        seq: 0,
                        elapsed_ms: 0,
                        phase: phase_a,
                        status,
                        origin: ActivityOrigin::DeterministicHost,
                        determinism: Determinism::Deterministic,
                        label: format!("Tool {name}"),
                        detail: Some(bound_chars(summary, MAX_ACTIVITY_DETAIL_CHARS)).filter(|s| {
                            !s.is_empty()
                        }).or_else(|| {
                            detail
                                .as_ref()
                                .map(|d| bound_chars(d, MAX_ACTIVITY_DETAIL_CHARS))
                        }),
                        trigger: ActivityTrigger::ModelRequest { round: 0 },
                        scope: self.scope.clone(),
                        evidence: Vec::new(),
                        privacy: PrivacyClass::Metadata,
                        context: None,
                    });
                }
                StreamEvent::PermissionRequired {
                    request_id,
                    tool_name,
                    target,
                    risk,
                    ..
                } => {
                    // Deliberately ignore `reason`, `preview`, and `arguments` —
                    // those can carry unredacted draft content.
                    self.push(ActivityEvent {
                        turn_id: String::new(),
                        operation_id: format!("permission-{request_id}"),
                        seq: 0,
                        elapsed_ms: 0,
                        phase: ActivityPhase::Started,
                        status: ActivityStatus::Pending,
                        origin: ActivityOrigin::UserDecision,
                        determinism: Determinism::Human,
                        label: format!("Permission: {tool_name}"),
                        detail: Some(bound_chars(
                            &format!("target={target}; risk={risk}"),
                            MAX_ACTIVITY_DETAIL_CHARS,
                        )),
                        trigger: ActivityTrigger::UserDecision,
                        scope: self.scope.clone(),
                        evidence: Vec::new(),
                        privacy: PrivacyClass::Metadata,
                        context: None,
                    });
                }
                StreamEvent::SearchTrail { steps } => {
                    let n = steps.len();
                    self.push(ActivityEvent {
                        turn_id: String::new(),
                        operation_id: format!("retrieval-trail-{}", self.seq),
                        seq: 0,
                        elapsed_ms: 0,
                        phase: ActivityPhase::Completed,
                        status: ActivityStatus::Ok,
                        origin: ActivityOrigin::RepeatableHeuristic,
                        determinism: Determinism::Repeatable,
                        label: format!("Retrieval trail ({n} step(s))"),
                        detail: None, // step text may echo user content
                        trigger: ActivityTrigger::HostPolicy,
                        scope: self.scope.clone(),
                        evidence: Vec::new(),
                        privacy: PrivacyClass::Metadata,
                        context: None,
                    });
                }
                StreamEvent::Citation {
                    source_id,
                    label,
                    locator,
                } => {
                    self.push(ActivityEvent {
                        turn_id: String::new(),
                        operation_id: format!("citation-{source_id}"),
                        seq: 0,
                        elapsed_ms: 0,
                        phase: ActivityPhase::Completed,
                        status: ActivityStatus::Ok,
                        origin: ActivityOrigin::DeterministicHost,
                        determinism: Determinism::Deterministic,
                        label: format!("Citation: {label}"),
                        detail: locator.clone().map(|l| bound_chars(&l, MAX_ACTIVITY_DETAIL_CHARS)),
                        trigger: ActivityTrigger::HostPolicy,
                        scope: self.scope.clone(),
                        evidence: vec![EvidenceRef {
                            kind: "citation".into(),
                            id: source_id.clone(),
                            locator: locator.clone(),
                        }],
                        privacy: PrivacyClass::Metadata,
                        context: None,
                    });
                }
                _ => {}
            }
        }
    }

    /// Finish, producing the record.
    ///
    /// `status` is the turn's terminal status as the host determined it —
    /// this module does not infer it, because "withheld" is a host policy
    /// decision (see [`crate::events::is_withheld_turn_reason`]) and
    /// guessing it here would let the inspector disagree with the product.
    pub fn finish(self, status: ActivityStatus, total_elapsed_ms: u64) -> TurnActivityRecord {
        TurnActivityRecord {
            version: ACTIVITY_CONTRACT_VERSION,
            turn_id: self.turn_id,
            session_id: self.session_id,
            message_id: None,
            scope: self.scope,
            status,
            total_elapsed_ms,
            detail_level: self.detail,
            events: self.events,
            dropped_events: self.dropped,
        }
    }
}

fn role_tallies(messages: &[TracedMessage]) -> Vec<RoleTally> {
    let mut by_role: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for message in messages {
        let entry = by_role.entry(message.role.as_str()).or_insert((0, 0));
        entry.0 += 1;
        entry.1 = entry.1.saturating_add(message.char_count);
    }
    by_role
        .into_iter()
        .map(|(role, (messages, chars))| RoleTally {
            role: role.to_string(),
            messages,
            chars,
        })
        .collect()
}

/// Map a terminal `TurnCompleted.reason` to an activity status.
///
/// Reuses [`crate::events::is_withheld_turn_reason`] rather than
/// re-listing reasons, so the inspector and the product cannot disagree
/// about whether an answer was delivered.
pub fn status_for_turn_reason(reason: &str) -> ActivityStatus {
    if reason == "cancel" || reason == "cancelled" {
        ActivityStatus::Cancelled
    } else if reason == "error" {
        ActivityStatus::Failed
    } else if crate::events::is_withheld_turn_reason(reason) {
        ActivityStatus::Withheld
    } else {
        ActivityStatus::Ok
    }
}

/// Terminal status for a whole turn, from the events it actually emitted.
///
/// This — not [`status_for_turn_reason`] alone — is what a host should call.
/// Two of this product's withholding conditions (`linked_no_tool`,
/// `linked_required_source_missing`) are signalled by a
/// [`crate::events::StreamEvent::Error`] while `TurnCompleted.reason` stays
/// `"stop"`. Classifying on the reason alone would report a knowingly
/// ungrounded answer as a clean success, which is precisely the failure the
/// inspector exists to make impossible.
///
/// A stream with no terminal `TurnCompleted` at all is [`ActivityStatus::Failed`]:
/// the turn did not finish, and calling that success would be the inspector
/// lying about the one thing it exists to show.
pub fn status_for_turn_events(events: &[crate::events::StreamEvent]) -> ActivityStatus {
    let terminal = events.iter().rev().find_map(|event| match event {
        crate::events::StreamEvent::TurnCompleted { reason } => {
            Some(status_for_turn_reason(reason))
        }
        _ => None,
    });
    match terminal {
        None => ActivityStatus::Failed,
        // An ordinary-looking completion can still carry an ungrounded-answer
        // error code; that outranks `Ok`, but never overrides a cancellation
        // or an outright failure, which are already more specific.
        Some(ActivityStatus::Ok)
            if events.iter().any(|event| match event {
                crate::events::StreamEvent::Error { code, .. } => {
                    crate::events::is_withheld_turn_error_code(code)
                }
                _ => false,
            }) =>
        {
            ActivityStatus::Withheld
        }
        Some(status) => status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::StreamEvent;

    #[test]
    fn a_heuristic_is_repeatable_but_never_deterministic() {
        assert_eq!(
            ActivityOrigin::RepeatableHeuristic.determinism(),
            Determinism::Repeatable
        );
        assert_ne!(
            ActivityOrigin::RepeatableHeuristic.determinism(),
            Determinism::Deterministic,
            "a ranking rule is repeatable, not a proof — calling it \
             deterministic overstates what the inspector can promise"
        );
    }

    #[test]
    fn every_origin_has_a_determinism_and_a_label() {
        for origin in [
            ActivityOrigin::ClientEvidence,
            ActivityOrigin::DeterministicHost,
            ActivityOrigin::RepeatableHeuristic,
            ActivityOrigin::ProbabilisticModel,
            ActivityOrigin::ExternalConnector,
            ActivityOrigin::UserDecision,
            ActivityOrigin::GovernedWrite,
        ] {
            assert!(!origin.label().is_empty(), "{origin:?}");
            // A model request and an external connector must never be
            // presented as reproducible host work.
            if matches!(
                origin,
                ActivityOrigin::ProbabilisticModel | ActivityOrigin::ExternalConnector
            ) {
                assert_eq!(origin.determinism(), Determinism::Probabilistic);
            }
        }
    }

    /// `linked_no_tool` is emitted by this product as an `Error` code while
    /// the turn completes with reason `"stop"` — it is deliberately NOT in
    /// `WITHHELD_TURN_REASONS`. Classifying it requires looking at the whole
    /// stream, which is what `status_for_turn_events` is for.
    #[test]
    fn an_ungrounded_answer_signalled_by_error_code_is_not_reported_as_ok() {
        let stream = vec![
            StreamEvent::Error {
                code: "linked_no_tool".into(),
                message: "not log-grounded".into(),
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
        ];
        // The reason alone says Ok — that is the trap.
        assert_eq!(status_for_turn_reason("stop"), ActivityStatus::Ok);
        // The stream as a whole must not.
        assert_eq!(status_for_turn_events(&stream), ActivityStatus::Withheld);
    }

    #[test]
    fn a_clean_turn_is_ok_and_an_unfinished_one_is_never_ok() {
        assert_eq!(
            status_for_turn_events(&[StreamEvent::TurnCompleted {
                reason: "stop".into()
            }]),
            ActivityStatus::Ok
        );
        // No terminal event at all: the turn did not finish.
        assert_eq!(
            status_for_turn_events(&[StreamEvent::TextDelta { text: "hi".into() }]),
            ActivityStatus::Failed
        );
        // A cancellation is more specific than "withheld" and keeps its identity.
        assert_eq!(
            status_for_turn_events(&[
                StreamEvent::Error {
                    code: "linked_no_tool".into(),
                    message: "x".into()
                },
                StreamEvent::TurnCompleted {
                    reason: "cancel".into()
                }
            ]),
            ActivityStatus::Cancelled
        );
    }

    #[test]
    fn withheld_reasons_are_not_reported_as_ok() {
        assert_eq!(status_for_turn_reason("stop"), ActivityStatus::Ok);
        assert_eq!(status_for_turn_reason("cancel"), ActivityStatus::Cancelled);
        assert_eq!(
            status_for_turn_reason("budget_rounds"),
            ActivityStatus::Withheld,
            "the round budget ran out AND the final answer failed"
        );
        assert_eq!(
            status_for_turn_reason("budget_rounds_answer"),
            ActivityStatus::Ok,
            "its sibling DID produce an answer — withholding it would be wrong"
        );
        assert_eq!(
            status_for_turn_reason("context_too_long"),
            ActivityStatus::Withheld
        );
    }

    #[test]
    fn contract_version_is_stamped_and_survives_a_roundtrip() {
        let record = ActivityRecorder::new(
            "turn-1",
            "session-1",
            DataScope::conversation(),
            ActivityDetailLevel::Summary,
        )
        .finish(ActivityStatus::Ok, 12);
        assert_eq!(record.version, ACTIVITY_CONTRACT_VERSION);
        let json = serde_json::to_string(&record).expect("serialize");
        let back: TurnActivityRecord = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, record);
    }

    #[test]
    fn a_record_written_before_versioning_defaults_rather_than_failing() {
        // Forward/backward compatibility: the migration story is "absent
        // optional fields take defaults", so a v0-shaped row still loads.
        let legacy = serde_json::json!({
            "turn_id": "t", "session_id": "s",
            "scope": { "kind": "conversation", "label": "Conversation" },
            "status": "ok", "total_elapsed_ms": 5, "events": []
        });
        let record: TurnActivityRecord = serde_json::from_value(legacy).expect("legacy loads");
        assert_eq!(record.version, ACTIVITY_CONTRACT_VERSION);
        assert_eq!(record.detail_level, ActivityDetailLevel::Summary);
        assert_eq!(record.dropped_events, 0);
        assert!(!record.is_truncated());
    }
}

/// Bounded, process-lifetime store of recent turn activity, keyed by
/// `(session_id, message_id)`.
///
/// # Why this exists in this shape
///
/// The inspector needs a record to be retrievable *after* the turn's event
/// stream has finished, because a user opens the panel when something looks
/// wrong — usually several messages later. Keying on the assistant message
/// is what makes "show me what produced THIS answer" answerable.
///
/// This is deliberately in-memory and bounded. Durable persistence is
/// designed for (every type here carries a contract version and serde
/// defaults, and the key is already `(session, message, turn)`), but is a
/// separate change: writing it into the session file would change a durable
/// on-disk schema every host reads, and that belongs in its own reviewed
/// batch rather than riding along with the capture seam. See
/// `docs/design/ACTIVITY_INSPECTOR.md` for the exact residual.
///
/// Eviction is oldest-first by insertion order, so a long session cannot
/// grow this without bound.
#[derive(Debug)]
pub struct ActivityStore {
    capacity: usize,
    order: std::collections::VecDeque<ActivityKey>,
    records: std::collections::HashMap<ActivityKey, TurnActivityRecord>,
}

/// Durable-shaped key: which turn's activity, within which message, within
/// which session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ActivityKey {
    /// Owning chat session.
    pub session_id: String,
    /// Owning assistant message.
    pub message_id: String,
}

/// Default number of turn records kept in memory.
pub const DEFAULT_ACTIVITY_STORE_CAPACITY: usize = 200;

impl Default for ActivityStore {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_ACTIVITY_STORE_CAPACITY)
    }
}

impl ActivityStore {
    /// Empty store holding at most `capacity` records (minimum 1).
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            order: std::collections::VecDeque::new(),
            records: std::collections::HashMap::new(),
        }
    }

    /// Store one record, evicting the oldest if at capacity.
    ///
    /// Re-inserting the same key replaces in place and does not consume a
    /// second slot — a retried turn overwrites its own record rather than
    /// pushing an unrelated session's out.
    pub fn insert(&mut self, session_id: &str, message_id: &str, record: TurnActivityRecord) {
        let key = ActivityKey {
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
        };
        if self.records.insert(key.clone(), record).is_none() {
            self.order.push_back(key);
            while self.order.len() > self.capacity {
                if let Some(evicted) = self.order.pop_front() {
                    self.records.remove(&evicted);
                }
            }
        }
    }

    /// Fetch a record.
    pub fn get(&self, session_id: &str, message_id: &str) -> Option<&TurnActivityRecord> {
        self.records.get(&ActivityKey {
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
        })
    }

    /// How many records are held.
    pub fn len(&self) -> usize {
        self.records.len()
    }

    /// True when nothing is held.
    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Deletion lifecycle: drop everything for one session.
    ///
    /// A chat that is deleted or trashed must not leave its activity behind
    /// — the record can hold redacted conversation text at `Full` detail,
    /// and "I deleted that chat" has to mean it.
    pub fn forget_session(&mut self, session_id: &str) {
        self.records.retain(|key, _| key.session_id != session_id);
        self.order.retain(|key| key.session_id != session_id);
    }

    /// Deletion lifecycle: drop one message's record.
    pub fn forget_message(&mut self, session_id: &str, message_id: &str) {
        let key = ActivityKey {
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
        };
        self.records.remove(&key);
        self.order.retain(|existing| existing != &key);
    }

    /// Deletion lifecycle: drop everything.
    pub fn clear(&mut self) {
        self.records.clear();
        self.order.clear();
    }

    /// Snapshot every held record as `(session_id, message_id, record)`.
    pub fn entries(&self) -> Vec<(String, String, TurnActivityRecord)> {
        self.order
            .iter()
            .filter_map(|key| {
                self.records
                    .get(key)
                    .map(|r| (key.session_id.clone(), key.message_id.clone(), r.clone()))
            })
            .collect()
    }
}

/// Maximum UTF-8 bytes for one session's durable activity file.
pub const MAX_DURABLE_ACTIVITY_FILE_BYTES: usize = 512 * 1024;

/// Maximum durable records retained per session on disk.
pub const MAX_DURABLE_ACTIVITY_RECORDS_PER_SESSION: usize = 100;

/// Sidecar journal under `{data_dir}/activity/<session_id>.json`.
///
/// Stores **Summary-only** records (bodies stripped) so a restart can restore
/// metadata without rehydrating redacted prompt text. Atomic write
/// (temp + rename). Unknown schema versions load as empty rather than
/// inventing meaning.
#[derive(Debug, Clone)]
pub struct DurableActivityJournal {
    /// Directory that holds per-session JSON files.
    root: std::path::PathBuf,
    max_records: usize,
    max_file_bytes: usize,
}

impl DurableActivityJournal {
    /// Open (or create) the journal root under `data_dir/activity`.
    pub fn open(data_dir: &std::path::Path) -> crate::error::CoreResult<Self> {
        let root = data_dir.join("activity");
        std::fs::create_dir_all(&root).map_err(|e| {
            crate::error::CoreError::Message(format!("activity journal mkdir: {e}"))
        })?;
        Ok(Self {
            root,
            max_records: MAX_DURABLE_ACTIVITY_RECORDS_PER_SESSION,
            max_file_bytes: MAX_DURABLE_ACTIVITY_FILE_BYTES,
        })
    }

    fn path_for(&self, session_id: &str) -> std::path::PathBuf {
        // Session ids are opaque UUIDs / host keys — still refuse path separators.
        let safe: String = session_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.root.join(format!("{safe}.json"))
    }

    /// Persist one record for its session (Summary-only, bounded).
    pub fn save_record(&self, record: &TurnActivityRecord) -> crate::error::CoreResult<()> {
        let session_id = &record.session_id;
        let message_id = record.message_id.as_deref().unwrap_or("");
        if message_id.is_empty() {
            return Ok(()); // nothing durable to key on
        }
        let mut durable = record.clone();
        strip_bodies_for_durability(&mut durable);
        if looks_like_secret_payload(&durable) {
            return Err(crate::error::CoreError::Message(
                "activity journal refused record with secret-like content".into(),
            ));
        }
        let mut map = self.load_session_map(session_id)?;
        map.insert(message_id.to_string(), durable);
        // Evict oldest by total_elapsed insertion order approximation: keep last N keys.
        if map.len() > self.max_records {
            let drop_n = map.len() - self.max_records;
            let keys: Vec<String> = map.keys().cloned().collect();
            for k in keys.into_iter().take(drop_n) {
                map.remove(&k);
            }
        }
        self.write_session_map(session_id, &map)
    }

    /// Load every durable record for a session.
    pub fn load_session(
        &self,
        session_id: &str,
    ) -> crate::error::CoreResult<Vec<(String, TurnActivityRecord)>> {
        let map = self.load_session_map(session_id)?;
        Ok(map.into_iter().collect())
    }

    /// Hydrate an in-memory store from every session file under the journal.
    pub fn hydrate_store(&self, store: &mut ActivityStore) -> crate::error::CoreResult<usize> {
        let mut n = 0usize;
        let rd = match std::fs::read_dir(&self.root) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => {
                return Err(crate::error::CoreError::Message(format!(
                    "activity journal readdir: {e}"
                )))
            }
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if raw.len() > self.max_file_bytes {
                continue;
            }
            let file: DurableSessionFile = match serde_json::from_str(&raw) {
                Ok(f) => f,
                Err(_) => continue, // fail-safe: unknown/corrupt schema
            };
            if file.version > ACTIVITY_CONTRACT_VERSION + 1 {
                continue; // future major: refuse rather than invent
            }
            for (message_id, mut record) in file.records {
                strip_bodies_for_durability(&mut record);
                if looks_like_secret_payload(&record) {
                    continue;
                }
                let session_id = record.session_id.clone();
                store.insert(&session_id, &message_id, record);
                n += 1;
            }
        }
        Ok(n)
    }

    /// Remove one session's durable file (chat delete).
    pub fn forget_session(&self, session_id: &str) -> crate::error::CoreResult<()> {
        let path = self.path_for(session_id);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(crate::error::CoreError::Message(format!(
                "activity journal forget: {e}"
            ))),
        }
    }

    fn load_session_map(
        &self,
        session_id: &str,
    ) -> crate::error::CoreResult<BTreeMap<String, TurnActivityRecord>> {
        let path = self.path_for(session_id);
        if !path.is_file() {
            return Ok(BTreeMap::new());
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| {
            crate::error::CoreError::Message(format!("activity journal read: {e}"))
        })?;
        if raw.len() > self.max_file_bytes {
            return Ok(BTreeMap::new());
        }
        let file: DurableSessionFile = match serde_json::from_str(&raw) {
            Ok(f) => f,
            Err(_) => return Ok(BTreeMap::new()),
        };
        if file.version > ACTIVITY_CONTRACT_VERSION + 1 {
            return Ok(BTreeMap::new());
        }
        Ok(file.records)
    }

    fn write_session_map(
        &self,
        session_id: &str,
        map: &BTreeMap<String, TurnActivityRecord>,
    ) -> crate::error::CoreResult<()> {
        let file = DurableSessionFile {
            version: ACTIVITY_CONTRACT_VERSION,
            session_id: session_id.to_string(),
            records: map.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|e| {
            crate::error::CoreError::Message(format!("activity journal encode: {e}"))
        })?;
        if bytes.len() > self.max_file_bytes {
            return Err(crate::error::CoreError::Message(
                "activity journal over byte budget".into(),
            ));
        }
        let path = self.path_for(session_id);
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &bytes).map_err(|e| {
            crate::error::CoreError::Message(format!("activity journal write: {e}"))
        })?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            crate::error::CoreError::Message(format!("activity journal rename: {e}"))
        })?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DurableSessionFile {
    #[serde(default = "default_contract_version")]
    version: u32,
    session_id: String,
    #[serde(default)]
    records: BTreeMap<String, TurnActivityRecord>,
}

/// Force Summary retention before any disk write.
pub fn strip_bodies_for_durability(record: &mut TurnActivityRecord) {
    record.detail_level = ActivityDetailLevel::Summary;
    for event in &mut record.events {
        if let Some(ctx) = event.context.as_mut() {
            ctx.bodies = None;
        }
        // Never persist UserVisibleContent at Full privacy on disk.
        if event.privacy == PrivacyClass::RedactedContent
            || event.privacy == PrivacyClass::UserVisibleContent
        {
            event.privacy = PrivacyClass::Metadata;
        }
    }
}

fn looks_like_secret_payload(record: &TurnActivityRecord) -> bool {
    let mut blob = String::new();
    for e in &record.events {
        blob.push_str(&e.label);
        if let Some(d) = &e.detail {
            blob.push_str(d);
        }
    }
    let lower = blob.to_ascii_lowercase();
    lower.contains("sk-")
        || lower.contains("authorization: bearer")
        || lower.contains("api_key")
        || lower.contains("-----begin ")
}
