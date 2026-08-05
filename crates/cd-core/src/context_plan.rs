//! Source-agnostic deterministic context plan for ordinary chat turns.
//!
//! Host-owned inventory and selection. Discovery uses already-open stores and
//! in-memory snapshots only — never speculative keychain, connector, or network
//! access merely because a candidate exists.
//!
//! Model tool filters (e.g. `recall_memory` `kinds`) constrain **tool execution**,
//! not this inventory. Eligible memory kinds including Preference are always
//! considered when the durable store is present.

use crate::activity::{DataScope, PrivacyClass};
use crate::memory::{Kind, MemoryRecord, MemoryStore, RecallHit, RecallQuery, Status};
use crate::session_context::SessionContextEntry;
use crate::skills::Skill;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// Configurable relevance stage after deterministic inventory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RelevanceStrategy {
    /// Host-only ranking and budgets (default).
    #[default]
    DeterministicOnly,
    /// Single bounded model rerank over known candidate ids; fail-closed.
    OptionalModelRerank,
    /// Reserved multi-step mode (same fail-closed contract; not a free agent).
    MultiStepBounded,
}

/// Whether this plan's selected inventory was actually eligible to become
/// model-facing context through the context-plan seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContextPlanApplication {
    /// Ordinary-chat plan content was already present or eligible for bounded
    /// injection into the provider request.
    #[default]
    ModelFacing,
    /// The host inventoried candidates for visibility only. Linked turns use
    /// their separate, evidence-gated context path and never inject this plan.
    InventoryOnly,
}

impl ContextPlanApplication {
    /// Stable wire label.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ModelFacing => "model_facing",
            Self::InventoryOnly => "inventory_only",
        }
    }

    /// Whether this plan can truthfully be described as context used.
    pub const fn is_model_facing(self) -> bool {
        matches!(self, Self::ModelFacing)
    }
}

/// Eligible source families for ordinary-chat inventory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ContextSourceFamily {
    /// Bounded conversation history / compact summary.
    ConversationHistory,
    /// Durable memory (all eligible kinds; no silent kind-filter exclusion).
    DurableMemory,
    /// Session-scoped chat attachments / context pack.
    ChatAttachment,
    /// Allowlisted workspace search hits (already indexed / listed).
    WorkspaceSearch,
    /// Pinned skill / method pack.
    PinnedSkill,
    /// Optional connector slot (deferred until authorized; no probe).
    OptionalConnector,
    /// Linked log corpus evidence when bound.
    LinkedLogEvidence,
    /// Explorer viewport / investigation snapshot when bound.
    ExplorerViewport,
    /// Explicit user selection (client evidence).
    UserSelection,
}

impl ContextSourceFamily {
    /// Wire label.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ConversationHistory => "conversation_history",
            Self::DurableMemory => "durable_memory",
            Self::ChatAttachment => "chat_attachment",
            Self::WorkspaceSearch => "workspace_search",
            Self::PinnedSkill => "pinned_skill",
            Self::OptionalConnector => "optional_connector",
            Self::LinkedLogEvidence => "linked_log_evidence",
            Self::ExplorerViewport => "explorer_viewport",
            Self::UserSelection => "user_selection",
        }
    }
}

/// Disposition of one candidate after host selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateDisposition {
    /// Selected by the plan. This is model-facing only when the enclosing
    /// [`ContextPlan::application`] is [`ContextPlanApplication::ModelFacing`].
    Included,
    /// Considered but dropped with a host reason.
    Excluded,
    /// Known but not fetched (auth, cost, optional connector).
    Deferred,
    /// Would have been included but lost to global/per-source budget.
    Truncated,
}

/// Host-computed reason codes (stable for tests and Activity).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextReasonCode {
    /// Selected by deterministic ranking under budget.
    IncludedByRank,
    /// Explicit user/client selection.
    IncludedByUserSelection,
    /// Pinned skill / pack for this session.
    IncludedPinnedSkill,
    /// Compact history window retained.
    IncludedHistoryWindow,
    /// Below score / relevance floor.
    ExcludedLowScore,
    /// Echo-suppressed (already in visible history).
    ExcludedEcho,
    /// Irrelevant to query (deterministic lexical gate).
    ExcludedIrrelevant,
    /// Global or per-source char/count budget.
    TruncatedByBudget,
    /// Duplicate of a higher-ranked candidate.
    ExcludedDuplicate,
    /// Connector/keychain not authorized — listed without probing.
    DeferredUnauthorized,
    /// Linked-turn policy skips ordinary ambient inventory for this family.
    DeferredLinkedPolicy,
    /// Source family not available this turn.
    ExcludedUnavailable,
    /// Optional model relevance promoted this id.
    IncludedByModelRelevance,
    /// Optional model relevance demoted this id (host still records reason).
    ExcludedByModelRelevance,
    /// Model relevance failed; deterministic plan retained.
    RelevanceFailedClosed,
    /// Memory kind is eligible; inventory never drops Preference solely for model tool kinds.
    MemoryKindEligible,
    /// Forward-compatible / host-specific reason string.
    Other(String),
}

impl ContextReasonCode {
    /// Wire string.
    pub fn as_str(&self) -> &str {
        match self {
            Self::IncludedByRank => "included_by_rank",
            Self::IncludedByUserSelection => "included_by_user_selection",
            Self::IncludedPinnedSkill => "included_pinned_skill",
            Self::IncludedHistoryWindow => "included_history_window",
            Self::ExcludedLowScore => "excluded_low_score",
            Self::ExcludedEcho => "excluded_echo",
            Self::ExcludedIrrelevant => "excluded_irrelevant",
            Self::TruncatedByBudget => "truncated_by_budget",
            Self::ExcludedDuplicate => "excluded_duplicate",
            Self::DeferredUnauthorized => "deferred_unauthorized",
            Self::DeferredLinkedPolicy => "deferred_linked_policy",
            Self::ExcludedUnavailable => "excluded_unavailable",
            Self::IncludedByModelRelevance => "included_by_model_relevance",
            Self::ExcludedByModelRelevance => "excluded_by_model_relevance",
            Self::RelevanceFailedClosed => "relevance_failed_closed",
            Self::MemoryKindEligible => "memory_kind_eligible",
            Self::Other(s) => s.as_str(),
        }
    }
}

/// One inventory candidate with host provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextCandidate {
    /// Stable id (e.g. `memory:{uuid}`, `history:window`, `attach:rel`).
    pub id: String,
    /// Source family.
    pub family: ContextSourceFamily,
    /// Short human label.
    pub label: String,
    /// Disposition after plan build.
    pub disposition: CandidateDisposition,
    /// Host reason codes (at least one).
    pub reasons: Vec<ContextReasonCode>,
    /// Estimated characters if fully injected.
    pub estimated_chars: usize,
    /// Sensitivity / privacy class for Activity.
    pub privacy: PrivacyClass,
    /// Data scope (conversation vs corpus).
    pub scope: DataScope,
    /// Optional durable memory kind (when family is DurableMemory).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_kind: Option<String>,
    /// Optional snippet (redacted / bounded) for developer detail only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// Host score when known (0..1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
    /// Provenance note (host path, not model prose).
    pub provenance: String,
}

/// Hard cap on candidates retained in the plan vector (after selection).
pub const MAX_PLAN_CANDIDATES: usize = 128;

/// Hard character bound for context text a user explicitly selects for one
/// turn. Hosts must reject larger values rather than silently treating an
/// arbitrary viewport, attachment, or ambient recall result as a selection.
pub const MAX_USER_SELECTION_CHARS: usize = 2_000;

/// Hard cap on serialized Developer-detail plan JSON (characters).
pub const MAX_DEVELOPER_PLAN_JSON_CHARS: usize = 6_000;

/// Complete plan for one ordinary-chat turn (or linked inventory view).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextPlan {
    /// Session id when known.
    pub session_id: String,
    /// Turn / correlation id when known.
    pub turn_id: String,
    /// Whether selected candidates are model-facing or inventory-only.
    #[serde(default)]
    pub application: ContextPlanApplication,
    /// Strategy used.
    pub strategy: RelevanceStrategy,
    /// True when optional model relevance ran successfully.
    pub model_relevance_used: bool,
    /// True when model relevance failed and deterministic plan was kept.
    pub relevance_failed_closed: bool,
    /// Global char budget applied.
    pub global_char_budget: usize,
    /// Estimated chars of included candidates.
    pub included_chars: usize,
    /// Candidates discovered before the hard vector cap.
    pub candidates_discovered: usize,
    /// Candidates dropped solely by [`MAX_PLAN_CANDIDATES`] (honest omit count).
    pub candidates_omitted_by_cap: usize,
    /// True when developer JSON was truncated to the payload cap.
    pub developer_payload_truncated: bool,
    /// All candidates after selection (included + excluded + deferred + truncated),
    /// capped at [`MAX_PLAN_CANDIDATES`].
    pub candidates: Vec<ContextCandidate>,
    /// Side-effect ledger: inventory must never trigger these.
    pub side_effects_forbidden: Vec<String>,
    /// Concise selected-context summary. It is user-facing “Context used” only
    /// for [`ContextPlanApplication::ModelFacing`]; inventory-only plans label
    /// it as inventory instead.
    pub context_used_summary: String,
}

impl ContextPlan {
    /// Included candidates only.
    pub fn included(&self) -> impl Iterator<Item = &ContextCandidate> {
        self.candidates
            .iter()
            .filter(|c| c.disposition == CandidateDisposition::Included)
    }

    /// Whether a stable id is included.
    pub fn includes_id(&self, id: &str) -> bool {
        self.included().any(|c| c.id == id)
    }

    /// Whether any durable memory with this kind string is included.
    pub fn includes_memory_kind(&self, kind: &str) -> bool {
        self.included()
            .any(|c| c.memory_kind.as_deref() == Some(kind))
    }

    /// Whether this plan may truthfully emit a user-facing “Context used”.
    pub const fn is_model_facing(&self) -> bool {
        self.application.is_model_facing()
    }

    /// JSON for developer detail / CLI envelopes (hard-capped; may strip snippets).
    pub fn to_developer_json(&self) -> serde_json::Value {
        let mut compact = serde_json::json!({
            "turn_id": self.turn_id,
            "application": self.application,
            "model_facing": self.is_model_facing(),
            "strategy": self.strategy,
            "model_relevance_used": self.model_relevance_used,
            "relevance_failed_closed": self.relevance_failed_closed,
            "included_chars": self.included_chars,
            "global_char_budget": self.global_char_budget,
            "candidates_discovered": self.candidates_discovered,
            "candidates_omitted_by_cap": self.candidates_omitted_by_cap,
            "candidate_count": self.candidates.len(),
            "side_effects_forbidden": self.side_effects_forbidden,
            "included": self.included().take(32).map(|c| serde_json::json!({
                "id": c.id,
                "family": c.family,
                "label": c.label,
                "memory_kind": c.memory_kind,
                "reasons": c.reasons,
                "estimated_chars": c.estimated_chars,
                "score": c.score,
                // Snippets omitted from developer compact form (bodies stay in model ctx only).
            })).collect::<Vec<_>>(),
            "deferred": self.candidates.iter()
                .filter(|c| c.disposition == CandidateDisposition::Deferred)
                .take(16)
                .map(|c| serde_json::json!({"id": c.id, "family": c.family, "label": c.label}))
                .collect::<Vec<_>>(),
            "truncated_count": self.candidates.iter()
                .filter(|c| c.disposition == CandidateDisposition::Truncated)
                .count(),
            "excluded_count": self.candidates.iter()
                .filter(|c| c.disposition == CandidateDisposition::Excluded)
                .count(),
        });
        let summary_key = if self.is_model_facing() {
            "context_used_summary"
        } else {
            "inventory_summary"
        };
        compact[summary_key] = serde_json::Value::String(self.context_used_summary.clone());
        let s = serde_json::to_string(&compact).unwrap_or_default();
        if s.chars().count() <= MAX_DEVELOPER_PLAN_JSON_CHARS {
            return compact;
        }
        let mut truncated = serde_json::json!({
            "turn_id": self.turn_id,
            "application": self.application,
            "model_facing": self.is_model_facing(),
            "strategy": self.strategy,
            "candidates_discovered": self.candidates_discovered,
            "candidates_omitted_by_cap": self.candidates_omitted_by_cap,
            "candidate_count": self.candidates.len(),
            "included_chars": self.included_chars,
            "developer_payload_truncated": true,
            "note": "plan JSON truncated under MAX_DEVELOPER_PLAN_JSON_CHARS",
        });
        truncated[summary_key] = serde_json::Value::String(self.context_used_summary.clone());
        truncated
    }

    /// Search-trail style steps (CLI / UI).
    pub fn trail_steps(&self) -> Vec<String> {
        let mut steps = vec![format!(
            "context_plan:strategy={:?};application={};model_facing={};included={};excluded={};deferred={};truncated={};chars={}/{};discovered={};omitted_by_cap={}",
            self.strategy,
            self.application.as_str(),
            self.is_model_facing(),
            self.included().count(),
            self.candidates
                .iter()
                .filter(|c| c.disposition == CandidateDisposition::Excluded)
                .count(),
            self.candidates
                .iter()
                .filter(|c| c.disposition == CandidateDisposition::Deferred)
                .count(),
            self.candidates
                .iter()
                .filter(|c| c.disposition == CandidateDisposition::Truncated)
                .count(),
            self.included_chars,
            self.global_char_budget,
            self.candidates_discovered,
            self.candidates_omitted_by_cap,
        )];
        if self.relevance_failed_closed {
            steps.push("context_plan:relevance_failed_closed".into());
        }
        if self.model_relevance_used {
            steps.push("context_plan:model_relevance_applied".into());
        }
        if self.candidates_omitted_by_cap > 0 {
            steps.push(format!(
                "context_plan:candidates_omitted_by_cap={}",
                self.candidates_omitted_by_cap
            ));
        }
        for c in self.included().take(24) {
            let prefix = if self.is_model_facing() {
                "context_included"
            } else {
                "context_inventoried"
            };
            steps.push(format!(
                "{prefix}:{}:{}:{}",
                c.family.as_str(),
                c.id,
                c.reasons.first().map(|r| r.as_str()).unwrap_or("included")
            ));
        }
        if self.is_model_facing() {
            steps.push(format!("context_used:{}", self.context_used_summary));
        } else {
            steps.push(format!(
                "context_inventory_only:not_model_facing;selected={};summary={}",
                self.included().count(),
                self.context_used_summary
            ));
        }
        steps
    }

    /// Build a bounded system message body from **included** non-history candidates
    /// so they actually reach the provider (not trail-only). Inventory-only
    /// plans fail closed here even if a caller accidentally attempts injection.
    pub fn format_injection_block(&self) -> Option<String> {
        self.format_injection_block_excluding(&HashSet::new())
    }

    /// Build the provider block while excluding candidate ids already injected
    /// by another host-owned context path (for example ambient memory recall).
    pub fn format_injection_block_excluding(
        &self,
        excluded_ids: &HashSet<String>,
    ) -> Option<String> {
        if !self.is_model_facing() {
            return None;
        }
        let mut lines: Vec<String> = Vec::new();
        for c in self.included() {
            if excluded_ids.contains(&c.id) {
                continue;
            }
            if c.family == ContextSourceFamily::ConversationHistory {
                continue; // already in model_ctx via prepare_model_context
            }
            if c.family == ContextSourceFamily::UserSelection {
                continue; // injected separately without preview truncation
            }
            if c.family == ContextSourceFamily::OptionalConnector {
                continue; // never inject connector content without authorize+invoke
            }
            let snip = c.snippet.as_deref().unwrap_or("").trim();
            if snip.is_empty() && c.family != ContextSourceFamily::PinnedSkill {
                continue;
            }
            let kind = c
                .memory_kind
                .as_deref()
                .map(|k| format!("/{k}"))
                .unwrap_or_default();
            if snip.is_empty() {
                lines.push(format!(
                    "- [{}{}] {} ({})",
                    c.family.as_str(),
                    kind,
                    c.label,
                    c.id
                ));
            } else {
                let body: String = snip.chars().take(200).collect();
                lines.push(format!(
                    "- [{}{}] {} — {} ({})",
                    c.family.as_str(),
                    kind,
                    c.label,
                    body,
                    c.id
                ));
            }
            if lines.len() >= 24 {
                break;
            }
        }
        if lines.is_empty() {
            None
        } else {
            Some(format!(
                "Host context inventory (deterministic; already-open sources only):\n{}",
                lines.join("\n")
            ))
        }
    }
}

/// Per-source quotas + global budget for deterministic selection.
#[derive(Debug, Clone, Copy)]
pub struct ContextPlanBudget {
    /// Max chars across all included candidates.
    pub global_chars: usize,
    /// Max durable memory items.
    pub max_memory: usize,
    /// Max attachment items.
    pub max_attachments: usize,
    /// Max workspace hits.
    pub max_workspace: usize,
    /// Max skill pins.
    pub max_skills: usize,
    /// Min lexical score (token overlap) for memory/workspace relevance.
    pub min_lexical: f32,
}

impl Default for ContextPlanBudget {
    fn default() -> Self {
        Self {
            global_chars: 4_000,
            max_memory: 5,
            max_attachments: 4,
            max_workspace: 6,
            max_skills: 2,
            min_lexical: 0.05,
        }
    }
}

/// Host-visible snapshot for inventory (no speculative I/O).
#[derive(Debug, Clone, Default)]
pub struct ContextInventorySnapshot {
    /// Session id.
    pub session_id: String,
    /// Turn id.
    pub turn_id: String,
    /// User text for this turn.
    pub user_text: String,
    /// Visible history text (for echo suppression / history candidate).
    pub history_text: String,
    /// History message count (full).
    pub history_message_count: usize,
    /// Keep window applied for model history.
    pub history_keep: usize,
    /// Whether a compact summary is present.
    pub history_compacted: bool,
    /// Durable memory hits from **unfiltered** recall (kinds = None).
    pub memory_hits: Vec<MemoryHitSnapshot>,
    /// Full memory list markers (for Preference gap proof when recall ranks poorly).
    pub memory_records: Vec<MemoryRecordSnapshot>,
    /// Session context attachments.
    pub attachments: Vec<AttachmentSnapshot>,
    /// Workspace search snippets already retrieved or listed.
    pub workspace_hits: Vec<WorkspaceHitSnapshot>,
    /// Pinned skills for this turn.
    pub pinned_skills: Vec<SkillSnapshot>,
    /// Optional connector names configured but not necessarily authorized.
    pub optional_connectors: Vec<ConnectorSlotSnapshot>,
    /// Linked corpus id when bound.
    pub linked_corpus_id: Option<String>,
    /// Explorer viewport brief when present.
    pub explorer_viewport: Option<String>,
    /// Explicit user selection text.
    pub user_selection: Option<String>,
    /// Ordinary vs linked turn.
    pub linked_turn: bool,
}

/// Lightweight memory hit for planning.
#[derive(Debug, Clone)]
pub struct MemoryHitSnapshot {
    /// Stable memory source id.
    pub id: String,
    /// Memory kind (preference, fact, …).
    pub kind: Kind,
    /// Title.
    pub title: String,
    /// Snippet.
    pub snippet: String,
    /// Host hybrid score.
    pub score: f32,
}

/// Listed memory record (for kind-complete inventory).
#[derive(Debug, Clone)]
pub struct MemoryRecordSnapshot {
    /// Stable id (`memory:{uuid}`).
    pub id: String,
    /// Kind.
    pub kind: Kind,
    /// Title.
    pub title: String,
    /// Full content (host-only planning; not auto-injected wholesale).
    pub content: String,
    /// Lifecycle status.
    pub status: Status,
}

/// Attachment row.
#[derive(Debug, Clone)]
pub struct AttachmentSnapshot {
    /// Relative path under session context.
    pub rel_path: String,
    /// Display name.
    pub name: String,
    /// Size in bytes.
    pub size: u64,
    /// Optional body snippet if already loaded (never load here).
    pub body_preview: Option<String>,
}

/// Workspace hit.
#[derive(Debug, Clone)]
pub struct WorkspaceHitSnapshot {
    /// Workspace-relative path.
    pub path: String,
    /// Snippet text.
    pub snippet: String,
    /// Host score.
    pub score: f32,
}

/// Skill pin.
#[derive(Debug, Clone)]
pub struct SkillSnapshot {
    /// Skill id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Short description.
    pub description: String,
}

/// Connector slot without probing credentials.
#[derive(Debug, Clone)]
pub struct ConnectorSlotSnapshot {
    /// Connector name.
    pub name: String,
    /// Whether the host already authorized this connector (no secret read here).
    pub authorized: bool,
}

/// Build deterministic plan from a host snapshot (pure; no I/O).
pub fn build_context_plan(
    snap: &ContextInventorySnapshot,
    budget: ContextPlanBudget,
    strategy: RelevanceStrategy,
) -> ContextPlan {
    let mut raw: Vec<ContextCandidate> = Vec::new();
    let query_tokens = tokenize(&snap.user_text);

    // --- Conversation history ---
    let hist_chars = snap.history_text.chars().count().min(2_000);
    if snap.history_message_count > 0 {
        raw.push(ContextCandidate {
            id: "history:window".into(),
            family: ContextSourceFamily::ConversationHistory,
            label: format!(
                "chat history ({} msgs, keep={})",
                snap.history_message_count, snap.history_keep
            ),
            disposition: CandidateDisposition::Included,
            reasons: vec![ContextReasonCode::IncludedHistoryWindow],
            estimated_chars: hist_chars.max(64),
            privacy: PrivacyClass::UserVisibleContent,
            scope: DataScope::conversation(),
            memory_kind: None,
            snippet: None,
            score: Some(1.0),
            provenance: if snap.history_compacted {
                "sessions::prepare_model_context compact+keep".into()
            } else {
                "sessions::context window".into()
            },
        });
    }

    // --- Durable memory: unfiltered hits + listed records (Preference gap fix) ---
    let mut seen_mem: HashSet<String> = HashSet::new();
    for hit in &snap.memory_hits {
        let id = normalize_memory_id(&hit.id);
        if !seen_mem.insert(id.clone()) {
            continue;
        }
        let lex = lexical_score(&query_tokens, &format!("{} {}", hit.title, hit.snippet));
        let score = hit.score.max(lex);
        raw.push(memory_candidate(
            &id,
            &hit.kind,
            &hit.title,
            &hit.snippet,
            score,
            &query_tokens,
            budget.min_lexical,
            &snap.history_text,
        ));
    }
    // Ensure every active listed memory kind is at least considered (Preference etc.).
    for rec in &snap.memory_records {
        if rec.status != Status::Active {
            continue;
        }
        let id = normalize_memory_id(&rec.id);
        if !seen_mem.insert(id.clone()) {
            // Already from hits — still annotate kind-eligible reason if Preference.
            if let Some(c) = raw.iter_mut().find(|c| c.id == id) {
                if !c.reasons.contains(&ContextReasonCode::MemoryKindEligible) {
                    c.reasons.push(ContextReasonCode::MemoryKindEligible);
                }
            }
            continue;
        }
        let snippet: String = rec.content.chars().take(160).collect();
        let lex = lexical_score(&query_tokens, &format!("{} {}", rec.title, snippet));
        raw.push(memory_candidate(
            &id,
            &rec.kind,
            &rec.title,
            &snippet,
            lex,
            &query_tokens,
            budget.min_lexical,
            &snap.history_text,
        ));
    }

    // --- Attachments ---
    for att in &snap.attachments {
        let id = format!("attach:{}", att.rel_path);
        let preview = att.body_preview.clone().unwrap_or_default();
        let lex = lexical_score(
            &query_tokens,
            &format!("{} {} {}", att.name, att.rel_path, preview),
        );
        let relevant = lex >= budget.min_lexical
            || query_tokens
                .iter()
                .any(|t| att.name.to_lowercase().contains(t));
        raw.push(ContextCandidate {
            id,
            family: ContextSourceFamily::ChatAttachment,
            label: att.name.clone(),
            disposition: if relevant {
                CandidateDisposition::Included
            } else {
                CandidateDisposition::Excluded
            },
            reasons: vec![if relevant {
                ContextReasonCode::IncludedByRank
            } else {
                ContextReasonCode::ExcludedIrrelevant
            }],
            estimated_chars: att.size.min(2_000) as usize + preview.chars().count().min(200),
            privacy: PrivacyClass::UserVisibleContent,
            scope: DataScope::conversation(),
            memory_kind: None,
            snippet: att
                .body_preview
                .as_ref()
                .map(|s| s.chars().take(120).collect()),
            score: Some(lex),
            provenance: format!("session_context:{}", att.rel_path),
        });
    }

    // --- Workspace ---
    for hit in &snap.workspace_hits {
        let id = format!("workspace:{}", hit.path);
        let lex = lexical_score(&query_tokens, &format!("{} {}", hit.path, hit.snippet));
        let score = hit.score.max(lex);
        let relevant = score >= budget.min_lexical;
        raw.push(ContextCandidate {
            id,
            family: ContextSourceFamily::WorkspaceSearch,
            label: hit.path.clone(),
            disposition: if relevant {
                CandidateDisposition::Included
            } else {
                CandidateDisposition::Excluded
            },
            reasons: vec![if relevant {
                ContextReasonCode::IncludedByRank
            } else {
                ContextReasonCode::ExcludedIrrelevant
            }],
            estimated_chars: hit.snippet.chars().count().min(400) + hit.path.len(),
            privacy: PrivacyClass::UserVisibleContent,
            scope: DataScope::conversation(),
            memory_kind: None,
            snippet: Some(hit.snippet.chars().take(120).collect()),
            score: Some(score),
            provenance: format!("workspace_index:{}", hit.path),
        });
    }

    // --- Skills ---
    for sk in &snap.pinned_skills {
        raw.push(ContextCandidate {
            id: format!("skill:{}", sk.id),
            family: ContextSourceFamily::PinnedSkill,
            label: sk.name.clone(),
            disposition: CandidateDisposition::Included,
            reasons: vec![ContextReasonCode::IncludedPinnedSkill],
            estimated_chars: sk.description.chars().count() + 200,
            privacy: PrivacyClass::Metadata,
            scope: DataScope::conversation(),
            memory_kind: None,
            snippet: Some(sk.description.chars().take(100).collect()),
            score: Some(1.0),
            provenance: format!("pinned_skill:{}", sk.id),
        });
    }

    // --- Optional connectors: never probe ---
    for conn in &snap.optional_connectors {
        raw.push(ContextCandidate {
            id: format!("connector:{}", conn.name),
            family: ContextSourceFamily::OptionalConnector,
            label: conn.name.clone(),
            // Always deferred in inventory — never probes credentials whether or not
            // a prior host grant exists.
            disposition: CandidateDisposition::Deferred,
            reasons: vec![ContextReasonCode::DeferredUnauthorized],
            estimated_chars: 0,
            privacy: PrivacyClass::Metadata,
            scope: DataScope::conversation(),
            memory_kind: None,
            snippet: None,
            score: None,
            provenance: "connector_slot_no_probe".into(),
        });
    }

    // --- Linked / viewport ---
    if let Some(corpus) = &snap.linked_corpus_id {
        let disp = if snap.linked_turn {
            CandidateDisposition::Included
        } else {
            CandidateDisposition::Deferred
        };
        raw.push(ContextCandidate {
            id: format!("corpus:{corpus}"),
            family: ContextSourceFamily::LinkedLogEvidence,
            label: format!("linked corpus {corpus}"),
            disposition: disp,
            reasons: vec![if snap.linked_turn {
                ContextReasonCode::IncludedByRank
            } else {
                ContextReasonCode::DeferredLinkedPolicy
            }],
            estimated_chars: if snap.linked_turn { 1_500 } else { 0 },
            privacy: PrivacyClass::UserVisibleContent,
            scope: DataScope::log_corpus(corpus.clone()),
            memory_kind: None,
            snippet: None,
            score: None,
            provenance: "log_explorer_bind".into(),
        });
    }
    if let Some(vp) = &snap.explorer_viewport {
        raw.push(ContextCandidate {
            id: "explorer:viewport".into(),
            family: ContextSourceFamily::ExplorerViewport,
            label: "explorer viewport".into(),
            disposition: CandidateDisposition::Included,
            reasons: vec![ContextReasonCode::IncludedByUserSelection],
            estimated_chars: vp.chars().count().min(2_000),
            privacy: PrivacyClass::UserVisibleContent,
            scope: snap
                .linked_corpus_id
                .as_ref()
                .map(|c| DataScope::log_corpus(c.clone()))
                .unwrap_or_else(DataScope::conversation),
            memory_kind: None,
            snippet: Some(vp.chars().take(80).collect()),
            score: Some(1.0),
            provenance: "explorer_viewport_snapshot".into(),
        });
    }
    if let Some(sel) = &snap.user_selection {
        raw.push(ContextCandidate {
            id: "user:selection".into(),
            family: ContextSourceFamily::UserSelection,
            label: "user selection".into(),
            disposition: CandidateDisposition::Included,
            reasons: vec![ContextReasonCode::IncludedByUserSelection],
            estimated_chars: sel.chars().count().min(2_000),
            privacy: PrivacyClass::UserVisibleContent,
            scope: DataScope::conversation(),
            memory_kind: None,
            // Keep the full bounded selection so it can reach the provider;
            // Developer JSON still omits every snippet body.
            snippet: Some(sel.chars().take(MAX_USER_SELECTION_CHARS).collect()),
            score: Some(1.0),
            provenance: "client_selection".into(),
        });
    }

    // Stable sort by family, then -score, then id (shuffle-stable).
    raw.sort_by(|a, b| {
        a.family
            .cmp(&b.family)
            .then_with(|| {
                let sa = a.score.unwrap_or(0.0);
                let sb = b.score.unwrap_or(0.0);
                sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.id.cmp(&b.id))
    });

    // Dedupe by id (keep first after sort).
    let mut deduped = Vec::new();
    let mut seen = HashSet::new();
    for mut c in raw {
        if !seen.insert(c.id.clone()) {
            c.disposition = CandidateDisposition::Excluded;
            c.reasons = vec![ContextReasonCode::ExcludedDuplicate];
        }
        deduped.push(c);
    }

    // Apply per-source quotas + global budget on Included set.
    let mut selected = apply_quotas_and_budget(deduped, budget);
    let discovered = selected.len();
    let omitted_by_cap = selected.len().saturating_sub(MAX_PLAN_CANDIDATES);
    if selected.len() > MAX_PLAN_CANDIDATES {
        // Prefer keeping Included, then Deferred, then Truncated, then Excluded.
        selected.sort_by_key(|c| match c.disposition {
            CandidateDisposition::Included => 0u8,
            CandidateDisposition::Deferred => 1,
            CandidateDisposition::Truncated => 2,
            CandidateDisposition::Excluded => 3,
        });
        selected.truncate(MAX_PLAN_CANDIDATES);
    }

    let included_chars: usize = selected
        .iter()
        .filter(|c| c.disposition == CandidateDisposition::Included)
        .map(|c| c.estimated_chars)
        .sum();

    let summary = build_context_used_summary(&selected);

    let mut plan = ContextPlan {
        session_id: snap.session_id.clone(),
        turn_id: snap.turn_id.clone(),
        application: if snap.linked_turn {
            ContextPlanApplication::InventoryOnly
        } else {
            ContextPlanApplication::ModelFacing
        },
        strategy,
        model_relevance_used: false,
        relevance_failed_closed: false,
        global_char_budget: budget.global_chars,
        included_chars,
        candidates_discovered: discovered,
        candidates_omitted_by_cap: omitted_by_cap,
        developer_payload_truncated: false,
        candidates: selected,
        side_effects_forbidden: vec![
            "keychain_read".into(),
            "connector_network".into(),
            "network_fetch".into(),
            "hard_write".into(),
            "soft_write".into(),
        ],
        context_used_summary: summary,
    };
    // Detect developer JSON truncation without mutating semantics of selection.
    let dev = plan.to_developer_json();
    plan.developer_payload_truncated = dev
        .get("developer_payload_truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    plan
}

/// Optional single-shot model relevance: ranks known ids only; fail-closed.
///
/// `ranked_ids` is highest-priority first. Unknown ids are ignored (never invented).
/// On empty / error signal (`Ok(None)` path), returns `plan` with `relevance_failed_closed`.
pub fn apply_model_relevance(mut plan: ContextPlan, ranked_ids: Option<&[String]>) -> ContextPlan {
    plan.strategy = RelevanceStrategy::OptionalModelRerank;
    let Some(order) = ranked_ids else {
        plan.relevance_failed_closed = true;
        // Annotate one candidate or synthetic note.
        if let Some(c) = plan.candidates.first_mut() {
            c.reasons.push(ContextReasonCode::RelevanceFailedClosed);
        }
        return plan;
    };
    if order.is_empty() {
        plan.relevance_failed_closed = true;
        return plan;
    }
    let known: HashSet<String> = plan.candidates.iter().map(|c| c.id.clone()).collect();
    let valid: Vec<String> = order
        .iter()
        .filter(|id| known.contains(id.as_str()))
        .cloned()
        .collect();
    if valid.is_empty() {
        // Model invented ids or returned garbage — fail closed.
        plan.relevance_failed_closed = true;
        return plan;
    }
    // Promote first valid ids that were excluded for low score to included if budget allows.
    let mut used = plan.included_chars;
    let budget = plan.global_char_budget;
    for id in &valid {
        if let Some(c) = plan.candidates.iter_mut().find(|c| &c.id == id) {
            if c.disposition == CandidateDisposition::Excluded
                && matches!(
                    c.reasons.first(),
                    Some(ContextReasonCode::ExcludedIrrelevant)
                        | Some(ContextReasonCode::ExcludedLowScore)
                )
                && used + c.estimated_chars <= budget
            {
                c.disposition = CandidateDisposition::Included;
                c.reasons
                    .insert(0, ContextReasonCode::IncludedByModelRelevance);
                used += c.estimated_chars;
            } else if c.disposition == CandidateDisposition::Included {
                c.reasons.push(ContextReasonCode::IncludedByModelRelevance);
            }
        }
    }
    // Demote included not in top-N model list when model provided ranking (optional soft demote).
    let top: HashSet<&str> = valid.iter().take(8).map(|s| s.as_str()).collect();
    for c in &mut plan.candidates {
        if c.disposition == CandidateDisposition::Included
            && c.family == ContextSourceFamily::DurableMemory
            && !top.contains(c.id.as_str())
            && valid.len() >= 3
        {
            // Only demote low-score memories not in model top list.
            if c.score.unwrap_or(0.0) < 0.2 {
                c.disposition = CandidateDisposition::Excluded;
                c.reasons
                    .insert(0, ContextReasonCode::ExcludedByModelRelevance);
            }
        }
    }
    plan.model_relevance_used = true;
    plan.included_chars = plan
        .candidates
        .iter()
        .filter(|c| c.disposition == CandidateDisposition::Included)
        .map(|c| c.estimated_chars)
        .sum();
    plan.context_used_summary = build_context_used_summary(&plan.candidates);
    let _ = valid;
    plan
}

/// Collect memory hits with **no kinds filter** from an open store (read-only).
pub fn collect_memory_hits_unfiltered(
    store: &dyn MemoryStore,
    query: &str,
    k: usize,
    now_secs: i64,
) -> Vec<MemoryHitSnapshot> {
    let mut q = RecallQuery::new(query);
    q.k = k.clamp(1, 50);
    q.kinds = None; // never apply model tool kinds here
    let hits = store
        .recall(&q, None, crate::embed::HybridWeights::default(), now_secs)
        .unwrap_or_default();
    hits.into_iter()
        .map(|h: RecallHit| MemoryHitSnapshot {
            id: h.source_id.clone(),
            kind: h.record.kind.clone(),
            title: h.record.title.clone(),
            snippet: h.snippet.clone(),
            score: h.score,
        })
        .collect()
}

/// List active memory records without kind filter (bounded).
pub fn collect_memory_records_unfiltered(
    store: &dyn MemoryStore,
    now_secs: i64,
    limit: usize,
) -> Vec<MemoryRecordSnapshot> {
    store
        .list(None, false, false, now_secs, limit.clamp(1, 500))
        .unwrap_or_default()
        .into_iter()
        .map(|r: MemoryRecord| MemoryRecordSnapshot {
            id: format!("memory:{}", r.id),
            kind: r.kind.clone(),
            title: r.title.clone(),
            content: r.content.clone(),
            status: r.status,
        })
        .collect()
}

/// Build attachment snapshots from session-context list (metadata only).
pub fn attachments_from_entries(entries: &[SessionContextEntry]) -> Vec<AttachmentSnapshot> {
    entries
        .iter()
        .map(|e| AttachmentSnapshot {
            rel_path: e.rel_path.clone(),
            name: e.name.clone(),
            size: e.size,
            body_preview: None,
        })
        .collect()
}

/// Load small previews for already-listed session-context files under an open store root.
///
/// Local filesystem only (no network). Skips files larger than `max_file_bytes`.
pub fn attachments_with_previews(
    store: &crate::session_context::SessionContextStore,
    entries: &[SessionContextEntry],
    max_file_bytes: u64,
    max_preview_chars: usize,
) -> Vec<AttachmentSnapshot> {
    use std::fs;
    let root = store.root();
    entries
        .iter()
        .map(|e| {
            let mut att = AttachmentSnapshot {
                rel_path: e.rel_path.clone(),
                name: e.name.clone(),
                size: e.size,
                body_preview: None,
            };
            if e.size > 0 && e.size <= max_file_bytes {
                let path = root.join(&e.rel_path);
                if let Ok(raw) = fs::read_to_string(&path) {
                    att.body_preview = Some(raw.chars().take(max_preview_chars).collect());
                }
            }
            att
        })
        .collect()
}

/// Workspace hits from an already-built local [`crate::index::KeywordIndex`] (no network).
pub fn workspace_hits_from_index(
    index: &crate::index::KeywordIndex,
    query: &str,
    limit: usize,
) -> Vec<WorkspaceHitSnapshot> {
    index
        .search(query, limit.clamp(1, 16))
        .into_iter()
        .map(|(score, chunk)| WorkspaceHitSnapshot {
            path: chunk.path.display().to_string(),
            snippet: chunk.text.chars().take(220).collect(),
            // Normalize TF-IDF-ish scores into a soft 0..1 band for lexical mix.
            score: (score / 20.0).clamp(0.0, 1.0),
        })
        .collect()
}

/// Connector **availability metadata** only — never opens keychain or network.
pub fn connector_slots_from_configs(
    configs: &[crate::connectors::ConnectorConfig],
) -> Vec<ConnectorSlotSnapshot> {
    configs
        .iter()
        .map(|c| ConnectorSlotSnapshot {
            // Availability flag from config, not a secret probe.
            name: c.id.clone(),
            // "authorized" here means "enabled in config"; still Deferred until invoke.
            authorized: c.enabled,
        })
        .collect()
}

/// Skill snapshots from discovered skills + pin id.
pub fn skill_snapshots(skills: &[Skill], pinned_id: Option<&str>) -> Vec<SkillSnapshot> {
    let Some(pid) = pinned_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    skills
        .iter()
        .filter(|s| s.id == pid && !s.disabled)
        .map(|s| SkillSnapshot {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
        })
        .collect()
}

// --- internals ---

fn normalize_memory_id(id: &str) -> String {
    if id.starts_with("memory:") {
        id.to_string()
    } else {
        format!("memory:{id}")
    }
}

#[allow(clippy::too_many_arguments)]
fn memory_candidate(
    id: &str,
    kind: &Kind,
    title: &str,
    snippet: &str,
    score: f32,
    query_tokens: &BTreeSet<String>,
    min_lexical: f32,
    history_text: &str,
) -> ContextCandidate {
    let label = if title.is_empty() {
        kind.as_str().to_string()
    } else {
        title.to_string()
    };
    let history_l = history_text.to_lowercase();
    let title_l = title.to_lowercase();
    let snip_l = snippet.to_lowercase();
    let mut reasons = vec![ContextReasonCode::MemoryKindEligible];
    let mut disposition = CandidateDisposition::Included;

    let echo = (!title_l.is_empty() && history_l.contains(&title_l))
        || (snip_l.len() > 24 && history_l.contains(&snip_l));
    if echo {
        disposition = CandidateDisposition::Excluded;
        reasons.push(ContextReasonCode::ExcludedEcho);
    } else if score < min_lexical
        && lexical_score(query_tokens, &format!("{title} {snippet}")) < min_lexical
    {
        disposition = CandidateDisposition::Excluded;
        reasons.push(ContextReasonCode::ExcludedIrrelevant);
    } else if score < 0.15 {
        disposition = CandidateDisposition::Excluded;
        reasons.push(ContextReasonCode::ExcludedLowScore);
    } else {
        reasons.push(ContextReasonCode::IncludedByRank);
    }

    ContextCandidate {
        id: id.to_string(),
        family: ContextSourceFamily::DurableMemory,
        label,
        disposition,
        reasons,
        estimated_chars: snippet.chars().count().min(400) + title.len() + 32,
        privacy: PrivacyClass::UserVisibleContent,
        scope: DataScope::conversation(),
        memory_kind: Some(kind.as_str().to_string()),
        snippet: Some(snippet.chars().take(120).collect()),
        score: Some(score),
        provenance: format!("durable_memory:{}", kind.as_str()),
    }
}

fn apply_quotas_and_budget(
    mut candidates: Vec<ContextCandidate>,
    budget: ContextPlanBudget,
) -> Vec<ContextCandidate> {
    let mut family_counts: BTreeMap<ContextSourceFamily, usize> = BTreeMap::new();
    let mut used_chars = 0usize;

    // Process in stable order; first-pass mark Included that pass quota.
    for c in &mut candidates {
        if c.disposition != CandidateDisposition::Included {
            continue;
        }
        let cap = match c.family {
            ContextSourceFamily::DurableMemory => budget.max_memory,
            ContextSourceFamily::ChatAttachment => budget.max_attachments,
            ContextSourceFamily::WorkspaceSearch => budget.max_workspace,
            ContextSourceFamily::PinnedSkill => budget.max_skills,
            ContextSourceFamily::ConversationHistory => 1,
            _ => 8,
        };
        let count = family_counts.entry(c.family).or_insert(0);
        if *count >= cap {
            c.disposition = CandidateDisposition::Truncated;
            c.reasons.insert(0, ContextReasonCode::TruncatedByBudget);
            continue;
        }
        if used_chars + c.estimated_chars > budget.global_chars
            && c.family != ContextSourceFamily::ConversationHistory
        {
            c.disposition = CandidateDisposition::Truncated;
            c.reasons.insert(0, ContextReasonCode::TruncatedByBudget);
            continue;
        }
        *count += 1;
        used_chars += c.estimated_chars;
    }
    candidates
}

fn build_context_used_summary(candidates: &[ContextCandidate]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for c in candidates
        .iter()
        .filter(|c| c.disposition == CandidateDisposition::Included)
    {
        let kind = c
            .memory_kind
            .as_deref()
            .map(|k| format!("/{k}"))
            .unwrap_or_default();
        parts.push(format!("{}{}:{}", c.family.as_str(), kind, c.label));
        if parts.len() >= 8 {
            break;
        }
    }
    if parts.is_empty() {
        "none".into()
    } else {
        parts.join("; ")
    }
}

fn tokenize(text: &str) -> BTreeSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_')
        .filter(|t| t.len() >= 2)
        .map(|s| s.to_string())
        .collect()
}

fn lexical_score(query: &BTreeSet<String>, doc: &str) -> f32 {
    if query.is_empty() {
        return 0.0;
    }
    let doc_tokens = tokenize(doc);
    if doc_tokens.is_empty() {
        return 0.0;
    }
    let mut hit = 0usize;
    for t in query {
        if doc_tokens.contains(t) || doc.to_lowercase().contains(t) {
            hit += 1;
        }
    }
    hit as f32 / query.len() as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::now_unix_secs;
    use crate::memory::{MemoryDraft, MemoryWriteOp, SqliteMemoryStore};

    fn store_with_pref_and_noise() -> SqliteMemoryStore {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let now = now_unix_secs();
        let mut pref = MemoryDraft::new(
            Kind::Preference,
            "GUI demo codename is cobalt-window for the acceptance pack",
        );
        pref.title = "cobalt-window".into();
        store.put(MemoryWriteOp::Insert(pref), now).unwrap();
        let mut noise = MemoryDraft::new(
            Kind::Fact,
            "totally unrelated fact about coffee beans and roast profiles",
        );
        noise.title = "coffee-roast".into();
        store.put(MemoryWriteOp::Insert(noise), now).unwrap();
        store
    }

    #[test]
    fn preference_memory_considered_without_kind_filter() {
        let store = store_with_pref_and_noise();
        let now = now_unix_secs();
        let hits = collect_memory_hits_unfiltered(&store, "gui demo codename cobalt", 10, now);
        let records = collect_memory_records_unfiltered(&store, now, 50);
        assert!(
            records.iter().any(|r| r.kind == Kind::Preference),
            "list must surface Preference without kinds filter"
        );
        let snap = ContextInventorySnapshot {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            user_text: "What is the saved GUI demo codename?".into(),
            history_text: String::new(),
            history_message_count: 2,
            history_keep: 4,
            history_compacted: false,
            memory_hits: hits,
            memory_records: records,
            ..Default::default()
        };
        let plan = build_context_plan(
            &snap,
            ContextPlanBudget::default(),
            RelevanceStrategy::DeterministicOnly,
        );
        let pref = plan
            .candidates
            .iter()
            .find(|c| c.memory_kind.as_deref() == Some("preference"))
            .expect("Preference must appear in inventory");
        assert!(
            matches!(
                pref.disposition,
                CandidateDisposition::Included | CandidateDisposition::Truncated
            ) || pref
                .reasons
                .contains(&ContextReasonCode::MemoryKindEligible),
            "Preference must be eligible, got {pref:?}"
        );
        // Relevant preference should be Included for codename query.
        assert!(
            plan.included().any(|c| {
                c.memory_kind.as_deref() == Some("preference")
                    && (c.label.contains("cobalt")
                        || c.snippet.as_deref().unwrap_or("").contains("cobalt-window"))
            }),
            "relevant Preference cobalt-window must be Included: {:?}",
            plan.context_used_summary
        );
        // Irrelevant coffee fact excluded.
        assert!(
            plan.candidates.iter().any(|c| {
                c.label.contains("coffee")
                    && matches!(
                        c.disposition,
                        CandidateDisposition::Excluded | CandidateDisposition::Truncated
                    )
            }) || !plan.included().any(|c| c.label.contains("coffee")),
            "irrelevant memory must not be included"
        );
    }

    #[test]
    fn model_kind_filter_does_not_gate_inventory() {
        // Simulate what tool_recall would return with narrow kinds vs inventory.
        let store = store_with_pref_and_noise();
        let now = now_unix_secs();
        let mut q = RecallQuery::new("cobalt-window codename");
        q.kinds = Some(vec![Kind::Fact, Kind::ProjectNote, Kind::Term]);
        let filtered = store
            .recall(&q, None, crate::embed::HybridWeights::default(), now)
            .unwrap();
        assert!(
            !filtered.iter().any(|h| h.record.kind == Kind::Preference),
            "fixture: narrow kinds hide Preference"
        );
        let hits = collect_memory_hits_unfiltered(&store, "cobalt-window codename", 10, now);
        let records = collect_memory_records_unfiltered(&store, now, 50);
        let snap = ContextInventorySnapshot {
            session_id: "s".into(),
            turn_id: "t".into(),
            user_text: "What is the GUI demo codename cobalt-window?".into(),
            memory_hits: hits,
            memory_records: records,
            history_message_count: 1,
            history_text: String::new(),
            history_keep: 4,
            ..Default::default()
        };
        let plan = build_context_plan(
            &snap,
            ContextPlanBudget::default(),
            RelevanceStrategy::DeterministicOnly,
        );
        assert!(
            plan.candidates
                .iter()
                .any(|c| c.memory_kind.as_deref() == Some("preference")),
            "inventory must still consider Preference despite model kinds filter"
        );
    }

    #[test]
    fn linked_plan_is_inventory_only_and_cannot_format_injection() {
        let plan = build_context_plan(
            &ContextInventorySnapshot {
                session_id: "same-session".into(),
                turn_id: "real-turn-42".into(),
                user_text: "investigate the linked logs".into(),
                linked_corpus_id: Some("corpus-1".into()),
                explorer_viewport: Some("source=worker.log seq=42".into()),
                linked_turn: true,
                ..Default::default()
            },
            ContextPlanBudget::default(),
            RelevanceStrategy::DeterministicOnly,
        );
        assert_eq!(plan.turn_id, "real-turn-42");
        assert_eq!(plan.application, ContextPlanApplication::InventoryOnly);
        assert!(!plan.is_model_facing());
        assert_eq!(plan.format_injection_block(), None);
        let trail = plan.trail_steps().join("|");
        assert!(trail.contains("context_inventory_only:not_model_facing"));
        assert!(!trail.contains("context_used:"));
        let developer = plan.to_developer_json();
        assert_eq!(developer["turn_id"], "real-turn-42");
        assert_eq!(developer["model_facing"], false);
        assert!(developer.get("inventory_summary").is_some());
        assert!(developer.get("context_used_summary").is_none());
    }

    #[test]
    fn plan_stable_under_shuffled_discovery() {
        let mut snap = ContextInventorySnapshot {
            session_id: "s".into(),
            turn_id: "t".into(),
            user_text: "pool settings runbook".into(),
            history_message_count: 3,
            history_text: "prior".into(),
            history_keep: 4,
            ..Default::default()
        };
        snap.workspace_hits = vec![
            WorkspaceHitSnapshot {
                path: "b.md".into(),
                snippet: "pool settings".into(),
                score: 0.5,
            },
            WorkspaceHitSnapshot {
                path: "a.md".into(),
                snippet: "pool settings".into(),
                score: 0.5,
            },
        ];
        let p1 = build_context_plan(
            &snap,
            ContextPlanBudget::default(),
            RelevanceStrategy::DeterministicOnly,
        );
        snap.workspace_hits.reverse();
        let p2 = build_context_plan(
            &snap,
            ContextPlanBudget::default(),
            RelevanceStrategy::DeterministicOnly,
        );
        let ids1: Vec<_> = p1.included().map(|c| c.id.as_str()).collect();
        let ids2: Vec<_> = p2.included().map(|c| c.id.as_str()).collect();
        assert_eq!(ids1, ids2, "shuffle-stable included ids");
    }

    #[test]
    fn injection_block_excludes_source_id_and_skips_separate_user_selection() {
        let snap = ContextInventorySnapshot {
            session_id: "s".into(),
            turn_id: "t".into(),
            user_text: "release dashboard preference".into(),
            memory_records: vec![MemoryRecordSnapshot {
                id: "memory:one".into(),
                kind: Kind::Preference,
                title: "release dashboard preference".into(),
                content: "saffron ambient plan dedup".into(),
                status: Status::Active,
            }],
            workspace_hits: vec![WorkspaceHitSnapshot {
                path: "dashboard.md".into(),
                snippet: "release dashboard retained workspace context".into(),
                score: 1.0,
            }],
            user_selection: Some("client selection uses its separate envelope".into()),
            ..Default::default()
        };
        let plan = build_context_plan(
            &snap,
            ContextPlanBudget::default(),
            RelevanceStrategy::DeterministicOnly,
        );
        let full = plan.format_injection_block().expect("full block");
        assert!(full.contains("saffron ambient plan dedup"));
        assert!(full.contains("retained workspace context"));
        assert!(!full.contains("client selection uses its separate envelope"));

        let excluded = HashSet::from(["memory:one".to_string()]);
        let filtered = plan
            .format_injection_block_excluding(&excluded)
            .expect("workspace context remains");
        assert!(!filtered.contains("saffron ambient plan dedup"));
        assert!(filtered.contains("retained workspace context"));
        assert!(!filtered.contains("client selection uses its separate envelope"));
    }

    #[test]
    fn thousands_of_candidates_stay_bounded() {
        let mut snap = ContextInventorySnapshot {
            session_id: "s".into(),
            turn_id: "t".into(),
            user_text: "needle unique-xyz".into(),
            history_message_count: 1,
            history_text: "h".into(),
            history_keep: 2,
            ..Default::default()
        };
        for i in 0..3000 {
            snap.memory_records.push(MemoryRecordSnapshot {
                id: format!("memory:{i}"),
                kind: if i == 42 {
                    Kind::Preference
                } else {
                    Kind::Fact
                },
                title: if i == 42 {
                    "needle unique-xyz".into()
                } else {
                    format!("noise-{i}")
                },
                content: if i == 42 {
                    "needle unique-xyz preference body".into()
                } else {
                    format!("zzzz filler {i}")
                },
                status: Status::Active,
            });
        }
        let budget = ContextPlanBudget {
            global_chars: 2_000,
            max_memory: 5,
            ..Default::default()
        };
        let plan = build_context_plan(&snap, budget, RelevanceStrategy::DeterministicOnly);
        assert_eq!(plan.candidates_discovered, 3001); // history + 3000 memory
        assert!(
            plan.candidates.len() <= MAX_PLAN_CANDIDATES,
            "plan must hard-cap retained candidates, got {}",
            plan.candidates.len()
        );
        assert!(
            plan.candidates_omitted_by_cap > 0,
            "honest omit count required when discovered >> cap"
        );
        assert!(plan.included().count() <= 20);
        assert!(plan.included_chars <= budget.global_chars + 500);
        let dev = plan.to_developer_json();
        let s = serde_json::to_string(&dev).unwrap();
        assert!(
            s.chars().count() <= MAX_DEVELOPER_PLAN_JSON_CHARS + 200,
            "developer JSON must stay near hard cap, got {}",
            s.chars().count()
        );
        // Full plan must not serialize 3k snippets into developer detail.
        assert!(!s.contains("zzzz filler 2999") || plan.developer_payload_truncated);
    }

    #[test]
    fn model_relevance_fail_closed_keeps_deterministic() {
        let snap = ContextInventorySnapshot {
            session_id: "s".into(),
            turn_id: "t".into(),
            user_text: "hello".into(),
            history_message_count: 1,
            history_text: "h".into(),
            history_keep: 2,
            ..Default::default()
        };
        let det = build_context_plan(
            &snap,
            ContextPlanBudget::default(),
            RelevanceStrategy::DeterministicOnly,
        );
        let failed = apply_model_relevance(det.clone(), None);
        assert!(failed.relevance_failed_closed);
        assert_eq!(
            failed.included().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            det.included().map(|c| c.id.as_str()).collect::<Vec<_>>()
        );
        // Invented ids ignored.
        let bogus = apply_model_relevance(det, Some(&["memory:does-not-exist".into()]));
        assert!(bogus.relevance_failed_closed);
    }

    #[test]
    fn no_speculative_side_effects_listed() {
        let plan = build_context_plan(
            &ContextInventorySnapshot {
                session_id: "s".into(),
                turn_id: "t".into(),
                user_text: "x".into(),
                optional_connectors: vec![ConnectorSlotSnapshot {
                    name: "confluence".into(),
                    authorized: false,
                }],
                ..Default::default()
            },
            ContextPlanBudget::default(),
            RelevanceStrategy::DeterministicOnly,
        );
        assert!(plan
            .side_effects_forbidden
            .iter()
            .any(|s| s == "keychain_read"));
        assert!(plan.candidates.iter().any(|c| {
            c.family == ContextSourceFamily::OptionalConnector
                && c.disposition == CandidateDisposition::Deferred
                && c.reasons.contains(&ContextReasonCode::DeferredUnauthorized)
        }));
    }
}
