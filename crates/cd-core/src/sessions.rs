//! Chat sessions and compaction without deleting full history.
//!
//! Desktop persists full UI transcripts via [`SessionStore`]; host agent history
//! is derived from stored messages on load. Compact/fold is view-only.

use crate::chat::{ChatMessage, Role};
use crate::error::{CoreError, CoreResult};
use chrono::{DateTime, Utc};
use serde::de::{IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use uuid::Uuid;

const SESSION_META_CACHE_VERSION: u8 = 1;
const SESSION_META_CACHE_DIR: &str = ".meta";
const MAX_SESSION_META_CACHE_BYTES: u64 = 64 * 1024;
/// Maximum linked-chat rows returned to the Explorer selector.
///
/// The selector is intentionally bounded independently of transcript length
/// and total linked-chat count. A future paged management surface can expose
/// older rows without weakening this production bound.
pub const MAX_LINKED_SESSION_META: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SessionSourceFingerprint {
    bytes: u64,
    modified_ns: Option<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedSessionMeta {
    version: u8,
    source: SessionSourceFingerprint,
    meta: SessionMeta,
}

#[derive(Debug, Default)]
struct MessageCount(usize);

impl<'de> Deserialize<'de> for MessageCount {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct MessageCountVisitor;

        impl<'de> Visitor<'de> for MessageCountVisitor {
            type Value = MessageCount;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a chat message array")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut count = 0usize;
                while seq.next_element::<IgnoredAny>()?.is_some() {
                    count = count.saturating_add(1);
                }
                Ok(MessageCount(count))
            }
        }

        deserializer.deserialize_seq(MessageCountVisitor)
    }
}

/// Streaming projection used to migrate legacy sessions without materializing
/// their message histories merely to populate a selector row.
#[derive(Debug, Deserialize)]
struct SessionMetaProjection {
    id: String,
    title: String,
    messages: MessageCount,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    trashed: bool,
    #[serde(default)]
    trashed_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    linked_corpus_id: Option<String>,
}

impl SessionMetaProjection {
    fn into_meta(self) -> SessionMeta {
        SessionMeta {
            id: self.id,
            title: self.title,
            archived: self.archived,
            trashed: self.trashed,
            pinned: self.pinned,
            created_at: self.created_at,
            updated_at: self.updated_at,
            trashed_at: self.trashed_at,
            message_count: self.messages.0,
            // Legacy migration intentionally avoids reading message bodies.
            // A normal subsequent save refreshes this bounded preview.
            preview: String::new(),
            linked_corpus_id: self.linked_corpus_id,
        }
    }
}

/// Lightweight row for sidebar / archive lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    /// Id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Archived (soft-hide from default lists).
    pub archived: bool,
    /// In trash (soft-deleted; recoverable until permanent delete).
    #[serde(default)]
    pub trashed: bool,
    /// Pinned to the app sidebar.
    #[serde(default)]
    pub pinned: bool,
    /// Created.
    pub created_at: DateTime<Utc>,
    /// Updated.
    pub updated_at: DateTime<Utc>,
    /// When moved to trash (if trashed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<DateTime<Utc>>,
    /// Message count (full history).
    pub message_count: usize,
    /// Short preview for list rows.
    pub preview: String,
    /// Linked log corpus id when set (#480).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_corpus_id: Option<String>,
}

/// Scored search hit for the chat archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSearchHit {
    /// Session metadata.
    pub meta: SessionMeta,
    /// Relevance score (higher is better).
    pub score: f32,
    /// Optional matched snippet from body.
    #[serde(default)]
    pub snippet: String,
}

/// A durable chat session (UI-compatible fields for desktop).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// Id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Full message history (UI-shaped).
    pub messages: Vec<StoredMessage>,
    /// Compact summary of older turns (optional; not required for UI fold).
    #[serde(default)]
    pub compact_summary: Option<String>,
    /// How many recent messages stay fully expanded in model context helpers.
    #[serde(default = "default_keep_last")]
    pub compact_keep_last: usize,
    /// When true, UI shows full history instead of auto-fold.
    #[serde(default)]
    pub show_full_history: bool,
    /// Created.
    pub created_at: DateTime<Utc>,
    /// Updated.
    pub updated_at: DateTime<Utc>,
    /// Archived (soft-hide).
    #[serde(default)]
    pub archived: bool,
    /// Soft-deleted into trash (recoverable).
    #[serde(default)]
    pub trashed: bool,
    /// When the session was moved to trash.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<DateTime<Utc>>,
    /// Pinned to sidebar shortcuts.
    #[serde(default)]
    pub pinned: bool,
    /// True once the user explicitly renames (blocks auto-title).
    #[serde(default)]
    pub title_locked: bool,
    /// Chat model id for this session (None → app default / active profile).
    #[serde(default)]
    pub chat_model: Option<String>,
    /// Provider profile id when the session model is not from the active default source.
    #[serde(default)]
    pub provider_profile_id: Option<String>,
    /// Last message id the user has scrolled into view / marked read.
    #[serde(default)]
    pub last_read_message_id: Option<String>,
    /// Pinned skill id for this chat (#343) — injected each turn until cleared.
    #[serde(default)]
    pub pinned_skill_id: Option<String>,
    /// Optional log analysis corpus this chat is linked to (#480 / Log Explorer).
    /// Any chat may set this; explorer lists sessions by this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_corpus_id: Option<String>,
}

fn default_keep_last() -> usize {
    6
}

/// Default keep-last window for model context (public for agent options).
pub fn default_compact_keep_last() -> usize {
    default_keep_last()
}

/// Pairing-safe start index for the keep-tail of a chat history (#112).
///
/// If the naive `len - keep` boundary falls on a `Role::Tool` message (orphaning
/// it from its assistant tool_calls parent), walk left until the pair is intact
/// or the history start is reached.
pub fn pairing_safe_start(messages: &[ChatMessage], keep: usize) -> usize {
    if messages.len() <= keep {
        return 0;
    }
    let mut start = messages.len().saturating_sub(keep);
    while start > 0 {
        match messages[start].role {
            Role::Tool => {
                // Keep walking left to include the assistant that owns this tool result.
                start -= 1;
            }
            Role::Assistant if messages[start].tool_calls.is_some() => {
                // Start on an assistant-with-tools is fine (tool results follow).
                break;
            }
            _ => break,
        }
    }
    // Never drop a lone system message at index 0 if it is the policy message —
    // callers may re-inject system; still prefer keeping it when start==0.
    start
}

/// Hard cap for the **summary** portion of compact context (#33).
///
/// Independent of transcript length so shrinking `keep` cannot explode
/// model-facing context by dumping every older message at 160 chars each.
pub const COMPACT_SUMMARY_CHAR_BUDGET: usize = 8_000;

/// Hard cap for the **complete** model-facing context (system + summary + tail).
///
/// This is the production budget enforced by [`prepare_model_context`] and the
/// agent path immediately before a provider request. Summary-only caps are not
/// sufficient: the pairing-safe tail can still exceed this alone.
pub const DEFAULT_CONTEXT_CHAR_BUDGET: usize = 120_000;

/// Explicit marker appended when a single message's model-facing body is truncated.
pub const MODEL_CONTEXT_TRUNCATE_MARKER: &str = "…[truncated for model context budget]";

/// Build a compact summary string from messages older than the keep window.
/// Returns `None` when nothing is older than keep.
///
/// The result is hard-capped at [`COMPACT_SUMMARY_CHAR_BUDGET`] characters
/// (newest-of-the-old first, then truncated) so long histories stay bounded.
pub fn recompact_chat_history(messages: &[ChatMessage], keep: usize) -> Option<String> {
    recompact_chat_history_budgeted(messages, keep, COMPACT_SUMMARY_CHAR_BUDGET)
}

/// Like [`recompact_chat_history`] with an explicit summary budget (tests).
pub fn recompact_chat_history_budgeted(
    messages: &[ChatMessage],
    keep: usize,
    summary_budget: usize,
) -> Option<String> {
    if messages.len() <= keep {
        return None;
    }
    let start = pairing_safe_start(messages, keep);
    if start == 0 {
        return None;
    }
    let older = &messages[..start];
    // Prefer more recent older turns when budget is tight (walk reverse).
    let mut lines_rev: Vec<String> = Vec::new();
    let mut used = 0usize;
    let budget = summary_budget.max(64);
    for m in older.iter().rev() {
        let snippet: String = m.content.chars().take(120).collect();
        let line = format!("- {:?}: {snippet}", m.role);
        let add = line.chars().count() + if lines_rev.is_empty() { 0 } else { 1 };
        if used + add > budget {
            break;
        }
        used += add;
        lines_rev.push(line);
    }
    if lines_rev.is_empty() {
        // Still emit a single truncated line so the model knows history existed.
        let m = &older[older.len() - 1];
        let snippet: String = m.content.chars().take(80).collect();
        return Some(format!("- {:?}: {snippet}…", m.role));
    }
    lines_rev.reverse();
    Some(lines_rev.join("\n"))
}

/// Model-facing context: optional summary + pairing-safe last N (full history unchanged).
pub fn context_chat_messages(
    messages: &[ChatMessage],
    compact_summary: Option<&str>,
    keep: usize,
) -> Vec<ChatMessage> {
    if messages.len() <= keep {
        return messages.to_vec();
    }
    let start = pairing_safe_start(messages, keep);
    let mut out = Vec::new();
    // Prefer an existing system policy message at the head of the tail, else
    // inject a summary-only system note before the keep window.
    let tail = &messages[start..];
    let has_system = tail.iter().any(|m| matches!(m.role, Role::System));
    if let Some(sum) = compact_summary {
        if !sum.is_empty() {
            out.push(ChatMessage {
                role: Role::System,
                content: format!("[Compacted earlier conversation]\n{sum}"),
                tool_call_id: None,
                tool_calls: None,
            });
        }
    }
    // If the full history had a system policy before the window and the tail
    // already includes it (start==0), do not duplicate — already in tail.
    // If tail has no system but messages[0] is system, prepend it so tools remain visible.
    if !has_system {
        if let Some(sys) = messages.iter().find(|m| matches!(m.role, Role::System)) {
            // Avoid double-injecting when we already pushed a compaction system msg:
            // still need the tool policy system content — merge into first system or push.
            if out.is_empty() || !matches!(out[0].role, Role::System) {
                out.insert(
                    0,
                    ChatMessage {
                        role: Role::System,
                        content: sys.content.clone(),
                        tool_call_id: None,
                        tool_calls: None,
                    },
                );
            } else {
                // Prepend policy before compacted summary content.
                out[0].content = format!("{}\n\n{}", sys.content, out[0].content);
            }
        }
    }
    out.extend(tail.iter().cloned());
    out
}

/// Cheap char estimate shared with the agent path (#33 / #113).
pub fn estimate_context_chars(messages: &[ChatMessage]) -> usize {
    messages.iter().map(|m| m.content.len()).sum()
}

/// Result of preparing model-facing context under a hard total budget.
#[derive(Debug, Clone)]
pub struct PreparedModelContext {
    /// Messages actually safe to send to the provider (≤ budget).
    pub messages: Vec<ChatMessage>,
    /// Keep window used after shrink.
    pub keep: usize,
    /// True when keep was reduced or history was summarized.
    pub compacted: bool,
    /// True when individual model-facing bodies were truncated with the marker.
    pub truncated: bool,
    /// Number of distinct stored history messages represented directly in
    /// `messages` (the synthetic compact summary is not counted).
    pub retained_history_messages: usize,
    /// Number of stored history messages not represented directly at the
    /// provider seam. This is computed while selecting the pairing-safe tail,
    /// never inferred later by subtracting unrelated injected messages.
    pub omitted_history_messages: usize,
    /// True only when this preparation inserted the host-authored compact
    /// summary message. User text that resembles the marker cannot set it.
    pub compact_summary_included: bool,
}

/// Failure when context cannot be forced under budget (budget smaller than
/// irreducible policy + newest-turn floor).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextBudgetError {
    /// Estimated chars after all compaction/truncation attempts.
    pub estimate: usize,
    /// Configured budget.
    pub budget: usize,
}

impl std::fmt::Display for ContextBudgetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "model context still over budget after compaction ({} > {} chars)",
            self.estimate, self.budget
        )
    }
}

impl std::error::Error for ContextBudgetError {}

/// Truncate a single message's **model-facing** content to at most `max_chars`,
/// appending [`MODEL_CONTEXT_TRUNCATE_MARKER`] when shortened. Structure
/// (role, tool_call_id, tool_calls) is preserved; the stored transcript is never
/// touched by this helper.
pub fn truncate_message_for_model(msg: &ChatMessage, max_chars: usize) -> ChatMessage {
    let mut out = msg.clone();
    if max_chars == 0 {
        out.content = MODEL_CONTEXT_TRUNCATE_MARKER.to_string();
        return out;
    }
    if out.content.chars().count() <= max_chars {
        return out;
    }
    let marker = MODEL_CONTEXT_TRUNCATE_MARKER;
    let marker_len = marker.chars().count();
    let body_budget = max_chars.saturating_sub(marker_len).max(1);
    let body: String = out.content.chars().take(body_budget).collect();
    out.content = format!("{body}{marker}");
    out
}

/// Force `messages` under `budget` by deterministic model-facing truncation.
///
/// Priority: preserve the first system/policy message and the newest useful
/// turn (last message, and its tool-call parent when the last is a tool result).
/// Shrink older tail bodies first. Pairing structure is kept (no orphan tool
/// results; tool_call_id / tool_calls fields are not dropped).
pub fn fit_model_context_to_budget(
    messages: &[ChatMessage],
    budget: usize,
) -> Result<Vec<ChatMessage>, ContextBudgetError> {
    let budget = budget.max(64);
    let mut out = messages.to_vec();
    if estimate_context_chars(&out) <= budget {
        return Ok(out);
    }

    // Identify protected indices: first system, and newest turn (+ tool parent).
    let mut protected: Vec<usize> = Vec::new();
    if let Some((i, _)) = out
        .iter()
        .enumerate()
        .find(|(_, m)| matches!(m.role, Role::System))
    {
        protected.push(i);
    }
    if !out.is_empty() {
        let last = out.len() - 1;
        protected.push(last);
        if matches!(out[last].role, Role::Tool) {
            // Walk left to assistant-with-tools parent.
            let mut j = last;
            while j > 0 {
                j -= 1;
                if matches!(out[j].role, Role::Assistant) && out[j].tool_calls.is_some() {
                    protected.push(j);
                    break;
                }
                if !matches!(out[j].role, Role::Tool) {
                    break;
                }
            }
        }
    }
    protected.sort_unstable();
    protected.dedup();

    // Pass 1: shrink non-protected messages from oldest, largest first.
    for _ in 0..64 {
        if estimate_context_chars(&out) <= budget {
            return Ok(out);
        }
        let overflow = estimate_context_chars(&out).saturating_sub(budget);
        // Pick oldest non-protected message with the most content.
        let mut best: Option<(usize, usize)> = None; // (idx, content_len)
        for (i, m) in out.iter().enumerate() {
            if protected.contains(&i) {
                continue;
            }
            let len = m.content.len();
            if len <= MODEL_CONTEXT_TRUNCATE_MARKER.len() + 8 {
                continue;
            }
            match best {
                None => best = Some((i, len)),
                Some((_, bl)) if len > bl => best = Some((i, len)),
                Some((bi, bl)) if len == bl && i < bi => best = Some((i, len)),
                _ => {}
            }
        }
        let Some((idx, len)) = best else {
            break;
        };
        // Cut enough to remove overflow, but leave a useful stub.
        let target = len
            .saturating_sub(overflow + MODEL_CONTEXT_TRUNCATE_MARKER.len())
            .max(32);
        out[idx] = truncate_message_for_model(&out[idx], target);
    }

    // Pass 2: if still over, shrink protected bodies (newest first after system).
    if estimate_context_chars(&out) > budget {
        let mut order = protected.clone();
        // Truncate newest-protected first among non-system, then system last.
        order.sort_by_key(|&i| {
            let is_sys = matches!(out[i].role, Role::System);
            (if is_sys { 1 } else { 0 }, usize::MAX - i)
        });
        for idx in order {
            if estimate_context_chars(&out) <= budget {
                break;
            }
            let overflow = estimate_context_chars(&out).saturating_sub(budget);
            let len = out[idx].content.len();
            if len <= MODEL_CONTEXT_TRUNCATE_MARKER.len() + 4 {
                continue;
            }
            let target = len
                .saturating_sub(overflow + MODEL_CONTEXT_TRUNCATE_MARKER.len())
                .max(16);
            out[idx] = truncate_message_for_model(&out[idx], target);
        }
    }

    // Pass 3: hard clamp every message proportionally if still over (pathological).
    if estimate_context_chars(&out) > budget {
        let n = out.len().max(1);
        let per = (budget / n).max(MODEL_CONTEXT_TRUNCATE_MARKER.len() + 1);
        for m in &mut out {
            if m.content.len() > per {
                *m = truncate_message_for_model(m, per);
            }
        }
    }

    let est = estimate_context_chars(&out);
    if est > budget {
        return Err(ContextBudgetError {
            estimate: est,
            budget,
        });
    }
    Ok(out)
}

/// Production helper used immediately before a provider request (#33).
///
/// 1. Build summary + pairing-safe tail via [`context_chat_messages`].
/// 2. Shrink `keep` while over budget (floor 2).
/// 3. Fit remaining bodies with explicit truncation markers.
/// 4. Return [`ContextBudgetError`] if still over budget (agent must terminal-error).
///
/// **Never** mutates the caller's stored transcript — only the returned model view.
pub fn prepare_model_context(
    history: &[ChatMessage],
    initial_keep: usize,
    budget: usize,
) -> Result<PreparedModelContext, ContextBudgetError> {
    let budget = budget.max(64);
    let mut keep = initial_keep.max(1);
    let mut compacted = false;
    let mut summary = recompact_chat_history(history, keep);
    let mut model_ctx = context_chat_messages(history, summary.as_deref(), keep);

    // Shrink keep window (pairing-safe) until under budget or floor.
    while estimate_context_chars(&model_ctx) > budget && keep > 2 {
        keep = (keep / 2).max(2);
        summary = recompact_chat_history(history, keep);
        model_ctx = context_chat_messages(history, summary.as_deref(), keep);
        compacted = true;
    }

    let before_fit = estimate_context_chars(&model_ctx);
    let fitted = fit_model_context_to_budget(&model_ctx, budget)?;
    // A shorter fitted request is the authoritative proof that this call
    // truncated a body. Never infer from marker-shaped message content: a
    // user is allowed to type the marker literally.
    let truncated = estimate_context_chars(&fitted) < before_fit;
    if estimate_context_chars(&fitted) > budget {
        return Err(ContextBudgetError {
            estimate: estimate_context_chars(&fitted),
            budget,
        });
    }
    let compact_summary_included = summary.as_deref().is_some_and(|value| !value.is_empty());
    let retained_history_messages = if history.len() <= keep {
        history.len()
    } else {
        let start = pairing_safe_start(history, keep);
        let tail = &history[start..];
        let retained_head_system = usize::from(
            !tail
                .iter()
                .any(|message| matches!(message.role, Role::System))
                && history
                    .iter()
                    .any(|message| matches!(message.role, Role::System)),
        );
        tail.len().saturating_add(retained_head_system)
    };
    Ok(PreparedModelContext {
        messages: fitted,
        keep,
        // Only true when keep was reduced for budget — mere presence of a
        // compact summary for long transcripts is normal and must not spam UI.
        compacted,
        truncated,
        retained_history_messages,
        omitted_history_messages: history.len().saturating_sub(retained_history_messages),
        compact_summary_included,
    })
}

/// One stored message (desktop transcript).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    /// Stable client id.
    pub id: String,
    /// `user` | `assistant` | `system` | `tool`.
    pub role: String,
    /// Text body.
    pub content: String,
    /// Optional tool-call UI payload (opaque JSON).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<serde_json::Value>,
    /// Optional citations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citations: Option<serde_json::Value>,
    /// Optional search trail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trail: Option<Vec<String>>,
    /// Optional generation metadata (model, provider, base URL) for footers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

impl Session {
    /// New empty session with placeholder title.
    pub fn new(title: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            title: title.into(),
            messages: vec![],
            compact_summary: None,
            compact_keep_last: default_keep_last(),
            show_full_history: false,
            created_at: now,
            updated_at: now,
            archived: false,
            trashed: false,
            trashed_at: None,
            pinned: false,
            title_locked: false,
            chat_model: None,
            provider_profile_id: None,
            last_read_message_id: None,
            pinned_skill_id: None,
            linked_corpus_id: None,
        }
    }

    /// Touch updated_at.
    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }

    /// List preview from last non-empty message.
    pub fn preview(&self) -> String {
        self.messages
            .iter()
            .rev()
            .find(|m| !m.content.trim().is_empty())
            .map(|m| {
                let t = m.content.replace('\n', " ");
                let t = t.trim();
                if t.chars().count() > 80 {
                    format!("{}…", t.chars().take(80).collect::<String>())
                } else {
                    t.to_string()
                }
            })
            .unwrap_or_default()
    }

    /// Convert to host agent history (role + content only).
    pub fn to_chat_history(&self) -> Vec<ChatMessage> {
        self.messages
            .iter()
            .filter_map(|m| {
                let role = match m.role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    "system" => Role::System,
                    "tool" => Role::Tool,
                    _ => return None,
                };
                Some(ChatMessage {
                    role,
                    content: m.content.clone(),
                    tool_call_id: None,
                    tool_calls: None,
                })
            })
            .collect()
    }

    /// Apply **heuristic** auto-title from first user prompt when allowed.
    ///
    /// Does not lock the title — LLM can upgrade later while `title_locked` is false.
    pub fn maybe_auto_title_from_first_user(&mut self) {
        if self.title_locked {
            return;
        }
        // Only replace placeholders or prior heuristic-length auto titles when empty-ish.
        if !is_placeholder_title(&self.title) {
            return;
        }
        if let Some(first) = self.messages.iter().find(|m| m.role == "user") {
            let t = title_from_prompt(&first.content, 40);
            if !t.is_empty() {
                self.title = t;
            }
        }
    }

    /// Apply an LLM (or other) suggested title when the user has not renamed.
    pub fn apply_suggested_title(&mut self, suggested: &str) {
        if self.title_locked {
            return;
        }
        let t = sanitize_generated_title(suggested, 48);
        if !t.is_empty() {
            self.title = t;
            self.touch();
        }
    }

    /// Messages for model context: summary + last N full (pairing-safe, #112).
    pub fn context_messages(&self) -> Vec<ChatMessage> {
        let hist = self.to_chat_history();
        context_chat_messages(
            &hist,
            self.compact_summary.as_deref(),
            self.compact_keep_last,
        )
    }

    /// Build compact summary from older messages (lossy; full history retained).
    pub fn recompact(&mut self) {
        let hist = self.to_chat_history();
        self.compact_summary = recompact_chat_history(&hist, self.compact_keep_last);
        self.touch();
    }

    /// Meta row for listings.
    pub fn meta(&self) -> SessionMeta {
        SessionMeta {
            id: self.id.clone(),
            title: self.title.clone(),
            archived: self.archived,
            trashed: self.trashed,
            pinned: self.pinned,
            created_at: self.created_at,
            updated_at: self.updated_at,
            trashed_at: self.trashed_at,
            message_count: self.messages.len(),
            preview: self.preview(),
            linked_corpus_id: self.linked_corpus_id.clone(),
        }
    }

    /// Link this session to a log analysis corpus (any chat may link — #480).
    pub fn set_linked_corpus_id(&mut self, corpus_id: Option<String>) {
        self.linked_corpus_id = corpus_id.filter(|s| !s.trim().is_empty());
        self.touch();
    }

    /// Move to trash (soft-delete). Clears pin.
    pub fn move_to_trash(&mut self) {
        self.trashed = true;
        self.trashed_at = Some(Utc::now());
        self.pinned = false;
        self.touch();
    }

    /// Restore from trash (not archived).
    pub fn restore_from_trash(&mut self) {
        self.trashed = false;
        self.trashed_at = None;
        self.touch();
    }
}

/// True when title is still an auto placeholder (`Chat`, `Chat 1`, …).
pub fn is_placeholder_title(title: &str) -> bool {
    let t = title.trim();
    if t.is_empty() {
        return true;
    }
    if t.eq_ignore_ascii_case("chat") {
        return true;
    }
    // Chat N / Chat 12
    let lower = t.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("chat ") {
        return rest.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// Derive a **short** session title from the first user prompt (no LLM).
///
/// Prefer first sentence / clause; hard-cap length so the sidebar never shows
/// the entire prompt.
pub fn title_from_prompt(prompt: &str, max_chars: usize) -> String {
    let one_line = prompt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .replace('\t', " ");
    let collapsed: String = one_line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return String::new();
    }
    // Cut at sentence / clause boundary when short enough.
    let cut_at = collapsed
        .find(['.', '?', '!'])
        .map(|i| i + 1)
        .or_else(|| collapsed.find([';', ',']))
        .filter(|&i| i >= 12 && i <= max_chars.max(24));
    let base = if let Some(i) = cut_at {
        // cut_at is from find on ASCII punctuation.
        #[allow(clippy::string_slice)] // safe: index from find of ASCII punctuation
        {
            collapsed[..i]
                .trim_end_matches(['.', '?', '!', ';', ','])
                .trim()
        }
    } else {
        collapsed.as_str()
    };
    let max = max_chars.clamp(8, 48);
    let mut out: String = base.chars().take(max).collect();
    if base.chars().count() > max {
        // Prefer break on last space inside window.
        if let Some(sp) = out.rfind(' ') {
            if sp >= 8 {
                out.truncate(sp);
            }
        }
        out = out.trim_end().to_string();
        out.push('…');
    }
    out
}

/// Prompt for a one-shot chat title completion (no tools).
pub fn session_title_llm_prompt(user_message: &str) -> String {
    let snippet: String = user_message.chars().take(800).collect();
    format!(
        "Create a concise chat title for this message.\n\
         Rules: 3–7 words, Title Case preferred, no quotes, no trailing punctuation, \
         no prefix like \"Title:\", English unless the message is clearly another language.\n\
         Message:\n{snippet}\n\
         Title:"
    )
}

/// Clean model output into a safe sidebar title.
pub fn sanitize_generated_title(raw: &str, max_chars: usize) -> String {
    let mut t = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .to_string();
    for prefix in [
        "Title:",
        "title:",
        "Chat title:",
        "Here's a title:",
        "Here is a title:",
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim().to_string();
        }
    }
    t = t
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '*')
        .trim()
        .trim_end_matches(['.', '!', '?'])
        .trim()
        .to_string();
    // Collapse whitespace.
    t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() || is_placeholder_title(&t) {
        return String::new();
    }
    let max = max_chars.clamp(8, 64);
    if t.chars().count() > max {
        let mut out: String = t.chars().take(max).collect();
        if let Some(sp) = out.rfind(' ') {
            if sp >= 8 {
                out.truncate(sp);
            }
        }
        t = out.trim_end().to_string();
        if !t.ends_with('…') {
            t.push('…');
        }
    }
    t
}

/// Session store on disk (`*.json` per session).
#[derive(Debug, Clone)]
pub struct SessionStore {
    dir: PathBuf,
}

impl SessionStore {
    /// Create store under dir.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Sessions directory path.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Ensure dir.
    pub fn ensure(&self) -> CoreResult<()> {
        fs::create_dir_all(&self.dir)?;
        Ok(())
    }

    fn path(&self, id: &str) -> PathBuf {
        // Reject path traversal in id.
        let safe = id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !safe || id.is_empty() {
            return self.dir.join("_invalid.json");
        }
        self.dir.join(format!("{id}.json"))
    }

    fn meta_dir(&self) -> PathBuf {
        self.dir.join(SESSION_META_CACHE_DIR)
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.meta_dir().join(format!("{id}.json"))
    }

    fn validate_id(id: &str) -> CoreResult<()> {
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(CoreError::Policy("invalid session id".into()));
        }
        Ok(())
    }

    fn source_fingerprint(path: &Path) -> CoreResult<SessionSourceFingerprint> {
        let metadata = fs::metadata(path)?;
        let modified_ns = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos());
        Ok(SessionSourceFingerprint {
            bytes: metadata.len(),
            modified_ns,
        })
    }

    fn write_meta_cache(
        &self,
        session_id: &str,
        meta: SessionMeta,
        source_path: &Path,
    ) -> CoreResult<()> {
        let meta_dir = self.meta_dir();
        fs::create_dir_all(&meta_dir)?;
        let cached = CachedSessionMeta {
            version: SESSION_META_CACHE_VERSION,
            source: Self::source_fingerprint(source_path)?,
            meta,
        };
        let target = self.meta_path(session_id);
        let temp = meta_dir.join(format!(".{session_id}.{}.tmp", Uuid::new_v4()));
        fs::write(&temp, serde_json::to_vec(&cached)?)?;
        // Windows cannot atomically replace an existing destination. A missing
        // cache is safe: readers fall back to the authoritative session once.
        if target.exists() {
            fs::remove_file(&target)?;
        }
        if let Err(error) = fs::rename(&temp, &target) {
            let _ = fs::remove_file(&temp);
            return Err(error.into());
        }
        Ok(())
    }

    fn read_meta_cache(&self, id: &str, source_path: &Path) -> CoreResult<Option<SessionMeta>> {
        let cache_path = self.meta_path(id);
        let metadata = match fs::metadata(&cache_path) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => return Ok(None),
        };
        if metadata.len() > MAX_SESSION_META_CACHE_BYTES {
            return Ok(None);
        }
        let raw = match fs::read(&cache_path) {
            Ok(raw) => raw,
            Err(_) => return Ok(None),
        };
        let cached: CachedSessionMeta = match serde_json::from_slice(&raw) {
            Ok(cached) => cached,
            Err(_) => return Ok(None),
        };
        if cached.version != SESSION_META_CACHE_VERSION
            || cached.meta.id != id
            || cached.source != Self::source_fingerprint(source_path)?
        {
            return Ok(None);
        }
        Ok(Some(cached.meta))
    }

    fn meta_for_path(&self, id: &str, source_path: &Path) -> CoreResult<SessionMeta> {
        if let Some(meta) = self.read_meta_cache(id, source_path)? {
            return Ok(meta);
        }
        let file = fs::File::open(source_path)?;
        let projection: SessionMetaProjection = serde_json::from_reader(BufReader::new(file))?;
        if projection.id != id {
            return Err(CoreError::Policy(
                "session metadata id does not match filename".into(),
            ));
        }
        let meta = projection.into_meta();
        // The session is authoritative. If cache refresh fails, this listing
        // remains correct and a later read can retry migration.
        let _ = self.write_meta_cache(id, meta.clone(), source_path);
        Ok(meta)
    }

    /// Save session.
    pub fn save(&self, session: &Session) -> CoreResult<()> {
        Self::validate_id(&session.id)?;
        self.ensure()?;
        let p = self.path(&session.id);
        fs::write(&p, serde_json::to_string_pretty(session)?)?;
        // Metadata is a validated cache, never the authoritative session.
        // Legacy/corrupt/missing cache rows migrate on the next list operation.
        let _ = self.write_meta_cache(&session.id, session.meta(), &p);
        Ok(())
    }

    /// Load session.
    pub fn load(&self, id: &str) -> CoreResult<Session> {
        Self::validate_id(id)?;
        let raw = fs::read_to_string(self.path(id))?;
        Ok(serde_json::from_str(&raw)?)
    }

    /// Whether an authoritative session file exists for a validated id.
    pub fn exists(&self, id: &str) -> CoreResult<bool> {
        Self::validate_id(id)?;
        Ok(self.path(id).exists())
    }

    /// Delete session file if present (permanent).
    pub fn delete(&self, id: &str) -> CoreResult<()> {
        Self::validate_id(id)?;
        let p = self.path(id);
        if p.exists() {
            fs::remove_file(p)?;
        }
        let meta = self.meta_path(id);
        if meta.exists() {
            fs::remove_file(meta)?;
        }
        Ok(())
    }

    /// Soft-delete: mark trashed and unpin.
    pub fn trash(&self, id: &str) -> CoreResult<Session> {
        let mut s = self.load(id)?;
        s.move_to_trash();
        self.save(&s)?;
        Ok(s)
    }

    /// Restore a trashed session back to the active archive.
    pub fn restore_from_trash(&self, id: &str) -> CoreResult<Session> {
        let mut s = self.load(id)?;
        s.restore_from_trash();
        self.save(&s)?;
        Ok(s)
    }

    /// List sessions (ids + titles + archived) — unsorted legacy shape.
    pub fn list(&self) -> CoreResult<Vec<(String, String, bool)>> {
        let metas = self.list_meta()?;
        Ok(metas
            .into_iter()
            .map(|m| (m.id, m.title, m.archived))
            .collect())
    }

    /// List session metadata, newest `updated_at` first (pinned first among ties).
    pub fn list_meta(&self) -> CoreResult<Vec<SessionMeta>> {
        self.ensure()?;
        let mut metas = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.dir) {
            for ent in rd.flatten() {
                let path = ent.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|x| x.to_str()) else {
                    continue;
                };
                if let Ok(meta) = self.meta_for_path(stem, &path) {
                    metas.push(meta);
                }
            }
        }
        metas.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(metas)
    }

    /// Sessions linked to a log corpus (any chat may link — Log Explorer #480).
    ///
    /// Excludes trashed by default.
    pub fn list_meta_for_corpus(&self, corpus_id: &str) -> CoreResult<Vec<SessionMeta>> {
        self.list_meta_for_corpus_bounded(corpus_id, MAX_LINKED_SESSION_META)
    }

    /// Bounded linked-session listing, newest `updated_at` first.
    ///
    /// Reads validated metadata sidecars instead of chat transcripts. Missing
    /// legacy sidecars are migrated one session at a time.
    pub fn list_meta_for_corpus_bounded(
        &self,
        corpus_id: &str,
        limit: usize,
    ) -> CoreResult<Vec<SessionMeta>> {
        let id = corpus_id.trim();
        if id.is_empty() || limit == 0 {
            return Ok(vec![]);
        }
        self.ensure()?;
        let limit = limit.min(MAX_LINKED_SESSION_META);
        let mut metas = Vec::with_capacity(limit.min(32));
        if let Ok(rd) = fs::read_dir(&self.dir) {
            for ent in rd.flatten() {
                let path = ent.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|x| x.to_str()) else {
                    continue;
                };
                let Ok(meta) = self.meta_for_path(stem, &path) else {
                    continue;
                };
                if meta.trashed || meta.linked_corpus_id.as_deref() != Some(id) {
                    continue;
                }
                metas.push(meta);
                if metas.len() > limit {
                    metas.sort_by(|a, b| {
                        b.pinned
                            .cmp(&a.pinned)
                            .then_with(|| b.updated_at.cmp(&a.updated_at))
                    });
                    metas.truncate(limit);
                }
            }
        }
        metas.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(metas)
    }

    /// Load every session from disk.
    pub fn load_all(&self) -> CoreResult<Vec<Session>> {
        self.ensure()?;
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.dir) {
            for ent in rd.flatten() {
                let path = ent.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|x| x.to_str()) else {
                    continue;
                };
                if let Ok(s) = self.load(stem) {
                    out.push(s);
                }
            }
        }
        Ok(out)
    }

    /// Keyword search over titles + message bodies (scored, newest break ties).
    ///
    /// Empty query returns metas as zero-score hits (archive browse).
    /// Trashed sessions are excluded unless `only_trashed` or `include_trashed`.
    pub fn search(
        &self,
        query: &str,
        limit: usize,
        include_archived: bool,
        include_trashed: bool,
        only_trashed: bool,
    ) -> CoreResult<Vec<SessionSearchHit>> {
        let terms = tokenize_query(query);
        let mut hits = Vec::new();
        for s in self.load_all()? {
            if only_trashed {
                if !s.trashed {
                    continue;
                }
            } else {
                if s.trashed && !include_trashed {
                    continue;
                }
                if s.archived && !include_archived {
                    continue;
                }
            }
            if terms.is_empty() {
                hits.push(SessionSearchHit {
                    meta: s.meta(),
                    score: if s.pinned { 0.1 } else { 0.0 },
                    snippet: s.preview(),
                });
                continue;
            }
            let (score, snippet) = score_session(&s, &terms);
            if score > 0.0 {
                hits.push(SessionSearchHit {
                    meta: s.meta(),
                    score,
                    snippet,
                });
            }
        }
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.meta.updated_at.cmp(&a.meta.updated_at))
        });
        if limit > 0 && hits.len() > limit {
            hits.truncate(limit);
        }
        Ok(hits)
    }
}

fn tokenize_query(q: &str) -> Vec<String> {
    q.split(|c: char| !c.is_alphanumeric())
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| t.len() >= 2)
        .collect()
}

fn score_session(s: &Session, terms: &[String]) -> (f32, String) {
    let title_l = s.title.to_ascii_lowercase();
    let mut body = String::new();
    for m in &s.messages {
        body.push_str(&m.content);
        body.push('\n');
    }
    let body_l = body.to_ascii_lowercase();
    let mut score = 0.0_f32;
    let mut snippet = String::new();
    for term in terms {
        if title_l.contains(term) {
            score += 4.0;
        }
        if let Some(idx) = body_l.find(term.as_str()) {
            score += 1.0;
            if snippet.is_empty() {
                let start = idx.saturating_sub(40);
                let end = (idx + term.len() + 60).min(body.len());
                // Map byte indices carefully — use char boundaries on original body via lower match
                let raw = body.get(start..end).unwrap_or("").replace('\n', " ");
                snippet = format!("…{}…", raw.trim());
            }
        }
    }
    if score <= 0.0 {
        return (0.0, String::new());
    }
    if s.pinned {
        score += 0.25;
    }
    // Mild recency boost only when there was a keyword hit
    let age_hours = (Utc::now() - s.updated_at).num_hours().max(0) as f32;
    score += (1.0 / (1.0 + age_hours / 720.0)) * 0.5;
    if snippet.is_empty() {
        snippet = s.preview();
    }
    (score, snippet)
}

/// Full history always available even when compact view used.
pub fn expand_full_history(session: &Session) -> &[StoredMessage] {
    &session.messages
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn compact_keeps_full_history() {
        let mut s = Session::new("t");
        s.compact_keep_last = 2;
        for i in 0..6 {
            s.messages.push(StoredMessage {
                id: format!("m{i}"),
                role: "user".into(),
                content: format!("msg {i} with details"),
                tools: None,
                citations: None,
                trail: None,
                meta: None,
            });
        }
        s.recompact();
        assert!(s.compact_summary.is_some());
        assert_eq!(expand_full_history(&s).len(), 6);
        let ctx = s.context_messages();
        assert!(ctx.len() < 6);
        assert!(ctx.iter().any(|m| m.content.contains("Compacted")));
    }

    /// #33: complete model context (not summary alone) is hard-bounded.
    #[test]
    fn prepare_model_context_thousands_of_long_messages() {
        let long = "w".repeat(800);
        let mut hist = vec![ChatMessage {
            role: Role::System,
            content: "policy system message for tools".into(),
            tool_call_id: None,
            tool_calls: None,
        }];
        for i in 0..2000 {
            hist.push(ChatMessage {
                role: Role::User,
                content: format!("user {i} {long}"),
                tool_call_id: None,
                tool_calls: None,
            });
            hist.push(ChatMessage {
                role: Role::Assistant,
                content: format!("asst {i} {long}"),
                tool_call_id: None,
                tool_calls: None,
            });
        }
        let persisted: Vec<_> = hist.iter().map(|m| m.content.clone()).collect();
        let prep = prepare_model_context(&hist, 40, DEFAULT_CONTEXT_CHAR_BUDGET).expect("must fit");
        assert!(
            estimate_context_chars(&prep.messages) <= DEFAULT_CONTEXT_CHAR_BUDGET,
            "est={}",
            estimate_context_chars(&prep.messages)
        );
        assert!(
            prep.messages
                .iter()
                .any(|m| m.role == Role::System && m.content.contains("policy")),
            "system policy preserved"
        );
        // Newest turn retained (possibly truncated).
        let last_user = hist.iter().rev().find(|m| m.role == Role::User).unwrap();
        assert!(
            prep.messages.iter().any(|m| {
                m.role == Role::User
                    && (m.content.contains("user 1999")
                        || m.content.contains(MODEL_CONTEXT_TRUNCATE_MARKER))
            }),
            "newest useful turn should appear in model ctx"
        );
        let _ = last_user;
        // Persisted history byte-for-byte unchanged.
        for (i, m) in hist.iter().enumerate() {
            assert_eq!(m.content, persisted[i], "history mutated at {i}");
        }
    }

    /// #33: thousands of assistant/tool-call/result groups stay under budget + pairing-safe.
    #[test]
    fn prepare_model_context_thousands_of_tool_groups() {
        use crate::chat::{FunctionCall, ToolCallMsg};
        let long = "t".repeat(300);
        let mut hist = vec![ChatMessage {
            role: Role::System,
            content: "policy".into(),
            tool_call_id: None,
            tool_calls: None,
        }];
        for i in 0..1500 {
            hist.push(ChatMessage {
                role: Role::User,
                content: format!("q{i}"),
                tool_call_id: None,
                tool_calls: None,
            });
            hist.push(ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_call_id: None,
                tool_calls: Some(vec![ToolCallMsg {
                    id: format!("c{i}"),
                    kind: "function".into(),
                    function: FunctionCall {
                        name: "search_kb".into(),
                        arguments: "{}".into(),
                    },
                }]),
            });
            hist.push(ChatMessage {
                role: Role::Tool,
                content: format!("result {i} {long}"),
                tool_call_id: Some(format!("c{i}")),
                tool_calls: None,
            });
            hist.push(ChatMessage {
                role: Role::Assistant,
                content: format!("done {i}"),
                tool_call_id: None,
                tool_calls: None,
            });
        }
        let prep = prepare_model_context(&hist, 30, DEFAULT_CONTEXT_CHAR_BUDGET).expect("must fit");
        assert!(estimate_context_chars(&prep.messages) <= DEFAULT_CONTEXT_CHAR_BUDGET);
        // Pairing: every tool result in model ctx has a parent assistant with tool_calls
        // or is allowed only if we kept structure (tool_call_id present).
        let tools: Vec<_> = prep
            .messages
            .iter()
            .filter(|m| m.role == Role::Tool)
            .collect();
        for t in &tools {
            assert!(t.tool_call_id.is_some(), "tool must keep call id");
        }
        let asst_tools = prep
            .messages
            .iter()
            .filter(|m| m.role == Role::Assistant && m.tool_calls.is_some())
            .count();
        assert!(
            tools.len() <= asst_tools + 1,
            "orphan tool risk: tools={} asst_tools={}",
            tools.len(),
            asst_tools
        );
    }

    /// #33: two recent messages whose combined size alone exceeds the budget.
    #[test]
    fn prepare_model_context_two_oversize_recent_messages() {
        let huge = "H".repeat(DEFAULT_CONTEXT_CHAR_BUDGET);
        let hist = vec![
            ChatMessage {
                role: Role::System,
                content: "policy".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: format!("first {huge}"),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: format!("second {huge}"),
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        let before = hist[1].content.clone();
        let prep = prepare_model_context(&hist, 4, DEFAULT_CONTEXT_CHAR_BUDGET).expect("must fit");
        assert!(estimate_context_chars(&prep.messages) <= DEFAULT_CONTEXT_CHAR_BUDGET);
        assert!(
            prep.truncated
                || prep
                    .messages
                    .iter()
                    .any(|m| m.content.contains(MODEL_CONTEXT_TRUNCATE_MARKER))
        );
        assert_eq!(hist[1].content, before, "persisted must not change");
        assert!(
            prep.messages
                .iter()
                .any(|m| m.role == Role::System && m.content.contains("policy")),
            "system preserved"
        );
    }

    /// #33: one enormous tool result near the transcript tail.
    #[test]
    fn prepare_model_context_enormous_tool_result_tail() {
        use crate::chat::{FunctionCall, ToolCallMsg};
        let huge = "R".repeat(DEFAULT_CONTEXT_CHAR_BUDGET + 50_000);
        let hist = vec![
            ChatMessage {
                role: Role::System,
                content: "policy".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "search please".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_call_id: None,
                tool_calls: Some(vec![ToolCallMsg {
                    id: "c1".into(),
                    kind: "function".into(),
                    function: FunctionCall {
                        name: "search_kb".into(),
                        arguments: "{}".into(),
                    },
                }]),
            },
            ChatMessage {
                role: Role::Tool,
                content: huge.clone(),
                tool_call_id: Some("c1".into()),
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "now answer".into(),
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        let tool_before = hist[3].content.clone();
        let prep = prepare_model_context(&hist, 8, DEFAULT_CONTEXT_CHAR_BUDGET).expect("must fit");
        assert!(estimate_context_chars(&prep.messages) <= DEFAULT_CONTEXT_CHAR_BUDGET);
        assert_eq!(hist[3].content, tool_before);
        // Tool result model-facing form truncated with marker; call id retained if present.
        let tool_in_ctx = prep.messages.iter().find(|m| m.role == Role::Tool);
        if let Some(t) = tool_in_ctx {
            assert!(
                t.content.contains(MODEL_CONTEXT_TRUNCATE_MARKER) || t.content.len() < huge.len()
            );
            assert_eq!(t.tool_call_id.as_deref(), Some("c1"));
        }
        assert!(
            prep.messages
                .iter()
                .any(|m| m.role == Role::User && m.content.contains("now answer")),
            "newest turn preserved"
        );
    }

    /// #33: pairing-safe truncation of a large tool-call group.
    #[test]
    fn prepare_model_context_pairing_safe_tool_group_truncation() {
        use crate::chat::{FunctionCall, ToolCallMsg};
        let big = "X".repeat(DEFAULT_CONTEXT_CHAR_BUDGET + 20_000);
        let hist = vec![
            ChatMessage {
                role: Role::System,
                content: "policy".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_call_id: None,
                tool_calls: Some(vec![ToolCallMsg {
                    id: "t9".into(),
                    kind: "function".into(),
                    function: FunctionCall {
                        name: "search_kb".into(),
                        arguments: r#"{"q":"x"}"#.into(),
                    },
                }]),
            },
            ChatMessage {
                role: Role::Tool,
                content: big,
                tool_call_id: Some("t9".into()),
                tool_calls: None,
            },
        ];
        let prep = prepare_model_context(&hist, 2, DEFAULT_CONTEXT_CHAR_BUDGET).expect("must fit");
        assert!(estimate_context_chars(&prep.messages) <= DEFAULT_CONTEXT_CHAR_BUDGET);
        let has_tool = prep.messages.iter().any(|m| m.role == Role::Tool);
        let has_asst = prep
            .messages
            .iter()
            .any(|m| m.role == Role::Assistant && m.tool_calls.is_some());
        if has_tool {
            assert!(has_asst, "tool result must not orphan from assistant call");
        }
    }

    /// Mutation regression: the fitter's newest-tool parent walk must execute
    /// under real budget pressure, preserving the call message while older
    /// unprotected content is shortened first.
    #[test]
    fn fit_model_context_protects_newest_tool_group_under_pressure() {
        use crate::chat::{FunctionCall, ToolCallMsg};
        let budget = 120_000;
        let old = "O".repeat(10_000);
        let parent = "P".repeat(50_000);
        let tool = "T".repeat(80_000);
        let messages = vec![
            ChatMessage {
                role: Role::System,
                content: "policy".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: old.clone(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: parent.clone(),
                tool_call_id: None,
                tool_calls: Some(vec![
                    ToolCallMsg {
                        id: "latest-call-1".into(),
                        kind: "function".into(),
                        function: FunctionCall {
                            name: "search_kb".into(),
                            arguments: "{}".into(),
                        },
                    },
                    ToolCallMsg {
                        id: "latest-call-2".into(),
                        kind: "function".into(),
                        function: FunctionCall {
                            name: "search_kb".into(),
                            arguments: "{}".into(),
                        },
                    },
                ]),
            },
            ChatMessage {
                role: Role::Tool,
                content: "first result".into(),
                tool_call_id: Some("latest-call-1".into()),
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Tool,
                content: tool,
                tool_call_id: Some("latest-call-2".into()),
                tool_calls: None,
            },
        ];

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(fit_model_context_to_budget(&messages, budget));
        });
        let fitted = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("newest tool-parent walk must terminate")
            .expect("must fit");
        assert!(estimate_context_chars(&fitted) <= budget);
        assert!(
            fitted[1].content.len() < old.len(),
            "older unprotected content must shrink before the newest tool group"
        );
        assert_eq!(
            fitted[2].content, parent,
            "assistant parent of newest tool result must remain protected"
        );
        assert_eq!(fitted[4].tool_call_id.as_deref(), Some("latest-call-2"));
        assert!(
            fitted[2]
                .tool_calls
                .as_ref()
                .is_some_and(|calls| calls.iter().any(|call| call.id == "latest-call-2")),
            "tool result must retain its assistant parent"
        );
    }

    /// Mutation regression: force the proportional hard-clamp pass after the
    /// 64 selective iterations are exhausted.
    #[test]
    fn fit_model_context_many_messages_reaches_hard_clamp() {
        let budget = 10_000;
        let messages: Vec<ChatMessage> = (0..200)
            .map(|i| ChatMessage {
                role: if i == 0 { Role::System } else { Role::User },
                content: format!("{i:03}-{}", "Z".repeat(1_000)),
                tool_call_id: None,
                tool_calls: None,
            })
            .collect();

        let fitted = fit_model_context_to_budget(&messages, budget).expect("hard clamp must fit");
        assert_eq!(
            fitted.len(),
            messages.len(),
            "model-only truncation must preserve message structure"
        );
        assert!(
            estimate_context_chars(&fitted) <= budget,
            "hard clamp returned an over-budget context"
        );
        assert!(
            fitted
                .iter()
                .filter(|message| message.content.contains(MODEL_CONTEXT_TRUNCATE_MARKER))
                .count()
                > 64,
            "fixture must exercise the all-message proportional clamp"
        );
    }

    /// Mutation regression: loop-bound mutations at the keep floor must return
    /// promptly rather than spinning forever.
    #[test]
    fn prepare_model_context_terminates_at_keep_floor() {
        let history = vec![
            ChatMessage {
                role: Role::System,
                content: "policy".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "U".repeat(20_000),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: "A".repeat(20_000),
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = prepare_model_context(&history, 2, 64);
            let _ = tx.send(result);
        });
        let result = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("preparation must terminate at keep=2");
        match result {
            Ok(prepared) => assert!(estimate_context_chars(&prepared.messages) <= 64),
            Err(error) => assert!(error.estimate > error.budget),
        }
    }

    /// Exact-budget input is already safe: it must not shrink the keep window,
    /// report compaction, truncate content, or fail the final `>` gate.
    #[test]
    fn prepare_model_context_exact_budget_preserves_state() {
        let history = vec![ChatMessage {
            role: Role::User,
            content: "E".repeat(64),
            tool_call_id: None,
            tool_calls: None,
        }];
        let prepared = prepare_model_context(&history, 8, 64).expect("exact budget is valid");
        assert_eq!(prepared.keep, 8);
        assert!(!prepared.compacted);
        assert!(!prepared.truncated);
        assert_eq!(estimate_context_chars(&prepared.messages), 64);
    }

    /// Over-budget input with a wide initial tail must reduce the keep window
    /// before falling back to per-message truncation.
    #[test]
    fn prepare_model_context_over_budget_reduces_keep() {
        let history: Vec<ChatMessage> = (0..12)
            .map(|i| ChatMessage {
                role: if i == 0 { Role::System } else { Role::User },
                content: format!("{i}-{}", "K".repeat(500)),
                tool_call_id: None,
                tool_calls: None,
            })
            .collect();
        let prepared = prepare_model_context(&history, 8, 1_200).expect("must fit");
        assert!(prepared.keep < 8, "keep window was not reduced");
        assert!(prepared.compacted);
        assert!(estimate_context_chars(&prepared.messages) <= 1_200);
    }

    /// #33: shrinking keep converges — successive smaller keeps do not grow context.
    #[test]
    fn prepare_model_context_monotonic_convergence() {
        let long = "m".repeat(500);
        let mut hist = vec![ChatMessage {
            role: Role::System,
            content: "policy".into(),
            tool_call_id: None,
            tool_calls: None,
        }];
        for i in 0..200 {
            hist.push(ChatMessage {
                role: Role::User,
                content: format!("{i} {long}"),
                tool_call_id: None,
                tool_calls: None,
            });
            hist.push(ChatMessage {
                role: Role::Assistant,
                content: format!("a{i} {long}"),
                tool_call_id: None,
                tool_calls: None,
            });
        }
        let mut prev: Option<usize> = None;
        for keep in [64usize, 32, 16, 8, 4, 2] {
            let prep = prepare_model_context(&hist, keep, DEFAULT_CONTEXT_CHAR_BUDGET).unwrap();
            let est = estimate_context_chars(&prep.messages);
            assert!(est <= DEFAULT_CONTEXT_CHAR_BUDGET);
            // Non-increasing across decreasing keep (allow small marker noise ≤ 256).
            if let Some(p) = prev {
                assert!(
                    est <= p.saturating_add(256),
                    "keep={keep} grew context: {est} > prev {p}"
                );
            }
            prev = Some(est);
        }
    }

    /// Mere presence of a compact summary must not set `compacted` (UI spam).
    #[test]
    fn prepare_model_context_compacted_only_when_keep_shrinks() {
        let mut hist = vec![ChatMessage {
            role: Role::System,
            content: "policy".into(),
            tool_call_id: None,
            tool_calls: None,
        }];
        for i in 0..30 {
            hist.push(ChatMessage {
                role: Role::User,
                content: format!("short user {i}"),
                tool_call_id: None,
                tool_calls: None,
            });
            hist.push(ChatMessage {
                role: Role::Assistant,
                content: format!("short asst {i}"),
                tool_call_id: None,
                tool_calls: None,
            });
        }
        let prep = prepare_model_context(&hist, 20, DEFAULT_CONTEXT_CHAR_BUDGET).unwrap();
        // History > keep → summary exists, but keep need not shrink under large budget.
        assert!(
            !prep.compacted,
            "compacted must be false when keep was not reduced for budget"
        );
        assert!(!prep.truncated);
        assert!(estimate_context_chars(&prep.messages) <= DEFAULT_CONTEXT_CHAR_BUDGET);
    }

    /// #33: summary must not grow linearly with transcript; shrink-keep stays bounded.
    #[test]
    fn recompact_summary_hard_budget_long_history() {
        use crate::chat::{FunctionCall, Role, ToolCallMsg};
        let long = "x".repeat(400);
        let mut hist = Vec::new();
        hist.push(ChatMessage {
            role: Role::System,
            content: "policy system message".into(),
            tool_call_id: None,
            tool_calls: None,
        });
        for i in 0..500 {
            hist.push(ChatMessage {
                role: Role::User,
                content: format!("turn {i} {long}"),
                tool_call_id: None,
                tool_calls: None,
            });
            hist.push(ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_call_id: None,
                tool_calls: Some(vec![ToolCallMsg {
                    id: format!("c{i}"),
                    kind: "function".into(),
                    function: FunctionCall {
                        name: "search_kb".into(),
                        arguments: "{}".into(),
                    },
                }]),
            });
            hist.push(ChatMessage {
                role: Role::Tool,
                content: format!("result {i} {long}"),
                tool_call_id: Some(format!("c{i}")),
                tool_calls: None,
            });
            hist.push(ChatMessage {
                role: Role::Assistant,
                content: format!("answer {i}"),
                tool_call_id: None,
                tool_calls: None,
            });
        }
        let sum_wide = recompact_chat_history(&hist, 20).unwrap();
        let sum_narrow = recompact_chat_history(&hist, 4).unwrap();
        assert!(
            sum_wide.chars().count() <= COMPACT_SUMMARY_CHAR_BUDGET,
            "wide keep summary too large: {}",
            sum_wide.chars().count()
        );
        assert!(
            sum_narrow.chars().count() <= COMPACT_SUMMARY_CHAR_BUDGET,
            "narrow keep summary too large: {}",
            sum_narrow.chars().count()
        );
        // Shrinking keep must not explode the summary (old bug: more lines in).
        assert!(
            sum_narrow.chars().count() <= sum_wide.chars().count() + 200,
            "narrow summary grew vs wide: {} vs {}",
            sum_narrow.chars().count(),
            sum_wide.chars().count()
        );
        // Full model context helper: budgeted summary + keep tail.
        let ctx = context_chat_messages(&hist, Some(&sum_narrow), 4);
        let est: usize = ctx.iter().map(|m| m.content.len()).sum();
        assert!(
            est < 120_000,
            "model context estimate should stay under product budget: {est}"
        );
        // No orphan tool: if a tool is in ctx, its assistant parent should be too
        // (pairing_safe_start). Count tools vs assistants-with-tools in tail.
        let tools = ctx.iter().filter(|m| m.role == Role::Tool).count();
        let asst_tools = ctx
            .iter()
            .filter(|m| m.role == Role::Assistant && m.tool_calls.is_some())
            .count();
        assert!(
            tools <= asst_tools + 1,
            "orphan tool results likely: tools={tools} asst_tools={asst_tools}"
        );
        assert_eq!(
            expand_full_history(&{
                let mut s = Session::new("x");
                s.messages = hist
                    .iter()
                    .enumerate()
                    .map(|(i, m)| StoredMessage {
                        id: format!("m{i}"),
                        role: format!("{:?}", m.role).to_ascii_lowercase(),
                        content: m.content.clone(),
                        tools: None,
                        citations: None,
                        trail: None,
                        meta: None,
                    })
                    .collect();
                s
            })
            .len(),
            hist.len()
        );
    }

    /// #112: keep window that would orphan a tool result extends left to the pair.
    #[test]
    fn pairing_safe_keep_includes_tool_parent() {
        use crate::chat::{FunctionCall, ToolCallMsg};
        let mut hist = vec![
            ChatMessage {
                role: Role::System,
                content: "policy".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "old user".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_call_id: None,
                tool_calls: Some(vec![ToolCallMsg {
                    id: "c1".into(),
                    kind: "function".into(),
                    function: FunctionCall {
                        name: "search_kb".into(),
                        arguments: "{}".into(),
                    },
                }]),
            },
            ChatMessage {
                role: Role::Tool,
                content: "tool result body".into(),
                tool_call_id: Some("c1".into()),
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "new user".into(),
                tool_call_id: None,
                tool_calls: None,
            },
        ];
        // keep=2 would start on Tool if naive — pairing_safe must pull assistant in.
        let start = pairing_safe_start(&hist, 2);
        assert!(
            start <= 2,
            "start={start} should include assistant at index 2"
        );
        assert!(!matches!(hist[start].role, Role::Tool));
        let summary = recompact_chat_history(&hist, 2);
        assert!(summary.is_some());
        let ctx = context_chat_messages(&hist, summary.as_deref(), 2);
        // No orphan tool: every Tool has matching assistant tool_calls id in ctx.
        for m in &ctx {
            if matches!(m.role, Role::Tool) {
                let id = m.tool_call_id.as_deref().unwrap();
                let has_parent = ctx.iter().any(|a| {
                    matches!(a.role, Role::Assistant)
                        && a.tool_calls
                            .as_ref()
                            .map(|t| t.iter().any(|tc| tc.id == id))
                            .unwrap_or(false)
                });
                assert!(has_parent, "orphaned tool {id} in ctx");
            }
        }
        // Full hist unchanged
        assert_eq!(hist.len(), 5);
        hist.push(ChatMessage {
            role: Role::Assistant,
            content: "answer".into(),
            tool_call_id: None,
            tool_calls: None,
        });
        assert_eq!(hist.len(), 6);
    }

    #[test]
    fn pinned_skill_id_roundtrip() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut s = Session::new("pin-test");
        s.pinned_skill_id = Some("log-triage".into());
        store.save(&s).unwrap();
        let loaded = store.load(&s.id).unwrap();
        assert_eq!(loaded.pinned_skill_id.as_deref(), Some("log-triage"));
        s.pinned_skill_id = None;
        store.save(&s).unwrap();
        let loaded2 = store.load(&s.id).unwrap();
        assert!(loaded2.pinned_skill_id.is_none());
    }

    #[test]
    fn store_roundtrip() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut s = Session::new("Research");
        s.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "hi".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        store.save(&s).unwrap();
        let loaded = store.load(&s.id).unwrap();
        assert_eq!(loaded.title, "Research");
        assert_eq!(loaded.messages.len(), 1);
    }

    #[test]
    fn auto_title_from_prompt() {
        assert_eq!(
            title_from_prompt("  Hello world\nsecond line  ", 40),
            "Hello world"
        );
        let long = "a".repeat(100);
        let t = title_from_prompt(&long, 20);
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= 21);
        // Does not dump an entire long first sentence when a clause break exists.
        let t2 = title_from_prompt(
            "How do I configure Ollama for local models, and what ports should I open for the API?",
            40,
        );
        assert!(t2.len() < 80);
        assert!(!t2.contains("ports should I open"));
    }

    #[test]
    fn sanitize_llm_title() {
        assert_eq!(
            sanitize_generated_title("Title: \"Ollama Local Setup\"", 48),
            "Ollama Local Setup"
        );
        assert!(sanitize_generated_title("Chat 1", 48).is_empty());
    }

    #[test]
    fn placeholder_titles() {
        assert!(is_placeholder_title("Chat"));
        assert!(is_placeholder_title("Chat 1"));
        assert!(is_placeholder_title("chat 12"));
        assert!(!is_placeholder_title("Hello world"));
    }

    #[test]
    fn maybe_auto_title_locks() {
        let mut s = Session::new("Chat 1");
        s.messages.push(StoredMessage {
            id: "u1".into(),
            role: "user".into(),
            content: "How do I configure Ollama locally?".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        s.maybe_auto_title_from_first_user();
        assert!(s.title.contains("Ollama") || s.title.contains("configure"));
        s.title_locked = true;
        s.title = "My name".into();
        s.maybe_auto_title_from_first_user();
        assert_eq!(s.title, "My name");
    }

    #[test]
    fn linked_corpus_set_list_and_reopen() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut linked = Session::new("On logs");
        linked.id = "linked1".into();
        linked.set_linked_corpus_id(Some("corpus-abc".into()));
        linked.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "what failed?".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        store.save(&linked).unwrap();

        let mut other = Session::new("Unrelated");
        other.id = "other1".into();
        other.set_linked_corpus_id(Some("corpus-other".into()));
        store.save(&other).unwrap();

        let mut none = Session::new("No link");
        none.id = "none1".into();
        store.save(&none).unwrap();

        let for_abc = store.list_meta_for_corpus("corpus-abc").unwrap();
        assert_eq!(for_abc.len(), 1, "{for_abc:?}");
        assert_eq!(for_abc[0].id, "linked1");
        assert_eq!(for_abc[0].linked_corpus_id.as_deref(), Some("corpus-abc"));

        // Reopen and clear
        let mut reopened = store.load("linked1").unwrap();
        assert_eq!(reopened.linked_corpus_id.as_deref(), Some("corpus-abc"));
        reopened.set_linked_corpus_id(None);
        store.save(&reopened).unwrap();
        assert!(store.list_meta_for_corpus("corpus-abc").unwrap().is_empty());
    }

    #[test]
    fn empty_linked_chat_roundtrips_before_its_first_turn() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut linked = Session::new("Incident");
        linked.set_linked_corpus_id(Some("corpus-a".into()));
        assert!(linked.messages.is_empty());

        store.save(&linked).unwrap();
        let reopened = store.load(&linked.id).unwrap();
        assert!(reopened.messages.is_empty());
        assert_eq!(reopened.linked_corpus_id.as_deref(), Some("corpus-a"));
    }

    #[test]
    fn linked_corpus_listing_uses_validated_metadata_without_loading_messages() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut linked = Session::new("Long investigation");
        linked.id = "linked-cache".into();
        linked.set_linked_corpus_id(Some("corpus-cache".into()));
        linked.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "bounded preview".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        store.save(&linked).unwrap();

        // Make the authoritative transcript deliberately unparsable, then
        // update only the cache fingerprint. A metadata listing must still
        // succeed without reading/deserializing message bodies.
        let session_path = store.path("linked-cache");
        let mut raw = fs::read(&session_path).unwrap();
        let message_offset = raw
            .windows(b"bounded preview".len())
            .position(|window| window == b"bounded preview")
            .unwrap();
        raw[message_offset] = 0xff;
        fs::write(&session_path, raw).unwrap();

        let cache_path = store.meta_path("linked-cache");
        let mut cached: CachedSessionMeta =
            serde_json::from_slice(&fs::read(&cache_path).unwrap()).unwrap();
        cached.source = SessionStore::source_fingerprint(&session_path).unwrap();
        fs::write(&cache_path, serde_json::to_vec(&cached).unwrap()).unwrap();

        assert!(store.load("linked-cache").is_err());
        let metas = store.list_meta_for_corpus("corpus-cache").unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].title, "Long investigation");
        assert_eq!(metas[0].message_count, 1);
        assert_eq!(metas[0].preview, "bounded preview");
    }

    #[test]
    fn linked_corpus_listing_migrates_legacy_metadata_and_honors_bound() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        for index in 0..5 {
            let mut session = Session::new(format!("Investigation {index}"));
            session.id = format!("linked-{index}");
            session.set_linked_corpus_id(Some("corpus-bounded".into()));
            store.save(&session).unwrap();
        }

        let legacy_meta = store.meta_path("linked-0");
        fs::remove_file(&legacy_meta).unwrap();
        let legacy_session = store.path("linked-0");
        let mut legacy_json: serde_json::Value =
            serde_json::from_slice(&fs::read(&legacy_session).unwrap()).unwrap();
        legacy_json["messages"] = serde_json::json!([{"legacy_shape": true}]);
        fs::write(
            &legacy_session,
            serde_json::to_vec_pretty(&legacy_json).unwrap(),
        )
        .unwrap();
        assert!(!legacy_meta.exists());
        assert!(
            store.load("linked-0").is_err(),
            "full Session parsing should reject the legacy message shape"
        );

        let metas = store
            .list_meta_for_corpus_bounded("corpus-bounded", 3)
            .unwrap();
        assert_eq!(metas.len(), 3);
        assert!(legacy_meta.exists(), "legacy sidecar should be recreated");
        assert!(metas
            .iter()
            .all(|meta| { meta.linked_corpus_id.as_deref() == Some("corpus-bounded") }));
    }

    #[test]
    fn list_meta_sorted_and_delete() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut a = Session::new("Chat 1");
        a.id = "aaa".into();
        a.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "first".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        a.touch();
        store.save(&a).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut b = Session::new("Chat 2");
        b.id = "bbb".into();
        b.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "second".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        b.touch();
        store.save(&b).unwrap();
        let list = store.list_meta().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "bbb");
        store.delete("bbb").unwrap();
        assert!(!store.meta_path("bbb").exists());
        assert_eq!(store.list_meta().unwrap().len(), 1);
    }

    #[test]
    fn search_scores_title_and_body() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut a = Session::new("Ollama setup");
        a.id = "s1".into();
        a.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "How do I install ollama on macOS?".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        store.save(&a).unwrap();
        let mut b = Session::new("Unrelated");
        b.id = "s2".into();
        b.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "What is the weather?".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        store.save(&b).unwrap();
        let hits = store.search("ollama", 10, false, false, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].meta.id, "s1");
        assert!(hits[0].score > 0.0);
    }

    #[test]
    fn trash_hides_from_search_until_restore() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut a = Session::new("Keep me");
        a.id = "keep".into();
        store.save(&a).unwrap();
        let mut b = Session::new("Trash me");
        b.id = "bin".into();
        b.pinned = true;
        store.save(&b).unwrap();

        store.trash("bin").unwrap();
        let active = store.search("", 20, false, false, false).unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].meta.id, "keep");

        let trashed = store.search("", 20, true, true, true).unwrap();
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].meta.id, "bin");
        assert!(trashed[0].meta.trashed);
        assert!(!trashed[0].meta.pinned);

        store.restore_from_trash("bin").unwrap();
        let again = store.search("", 20, false, false, false).unwrap();
        assert_eq!(again.len(), 2);

        store.trash("bin").unwrap();
        store.delete("bin").unwrap();
        assert_eq!(store.search("", 20, true, true, true).unwrap().len(), 0);
    }

    #[test]
    fn pin_sorts_first_in_list_meta() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut a = Session::new("Old");
        a.id = "old".into();
        a.pinned = false;
        a.touch();
        store.save(&a).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut b = Session::new("New");
        b.id = "new".into();
        b.pinned = false;
        b.touch();
        store.save(&b).unwrap();
        // Pin older one
        a.pinned = true;
        store.save(&a).unwrap();
        let list = store.list_meta().unwrap();
        assert_eq!(list[0].id, "old");
        assert!(list[0].pinned);
    }

    #[test]
    fn rejects_bad_ids() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut s = Session::new("x");
        s.id = "../evil".into();
        assert!(store.save(&s).is_err());
    }
}
