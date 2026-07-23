//! Rule-based cue extractor — offline, zero-token (MEMORY.md §5 / §9 Phase 2).
//!
//! Proposes [`MemoryCandidate`] drafts only; never writes durable memory.

use super::score::{score_candidate, ScorePair};
use super::types::{content_hash_for, title_from_content, Kind, Scope};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One proposed memory before human review (not a durable row).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryCandidate {
    /// Pending id (UUIDv7).
    pub id: Uuid,
    /// Proposed kind.
    pub kind: Kind,
    /// Proposed title.
    pub title: String,
    /// Proposed content (may be redacted at approve time).
    pub content: String,
    /// Scope suggestion.
    pub scope: Scope,
    /// Salience 0..1 ("worth remembering").
    pub salience: f32,
    /// Confidence 0..1 ("captured correctly").
    pub confidence: f32,
    /// Content fingerprint for dedup.
    pub content_hash: String,
    /// Origin session when known.
    pub origin_session_id: Option<String>,
    /// Cue label (which rule fired).
    pub cue: String,
    /// Source snippet from the conversation.
    pub source_excerpt: String,
    /// Created at unix secs.
    pub created_at: i64,
    /// Inbox status.
    pub status: CandidateStatus,
    /// When detect-dedup found a near match: propose supersede of this id.
    pub propose_supersede_of: Option<Uuid>,
}

/// Lifecycle of a candidate in the review inbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateStatus {
    /// Awaiting human review.
    Pending,
    /// Human approved → SoftWrite path.
    Approved,
    /// Human discarded.
    Discarded,
}

impl CandidateStatus {
    /// Wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Discarded => "discarded",
        }
    }

    /// Parse status.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(Self::Pending),
            "approved" => Some(Self::Approved),
            "discarded" => Some(Self::Discarded),
            _ => None,
        }
    }
}

/// Extractor options (offline defaults).
#[derive(Debug, Clone, Copy)]
pub struct CueExtractOpts {
    /// Minimum salience to keep.
    pub min_salience: f32,
    /// Minimum confidence to keep.
    pub min_confidence: f32,
    /// Max candidates per turn.
    pub max_candidates: usize,
}

impl Default for CueExtractOpts {
    fn default() -> Self {
        Self {
            min_salience: 0.35,
            min_confidence: 0.40,
            max_candidates: 8,
        }
    }
}

/// Rule-based cue extractor (deterministic, no network).
#[derive(Default)]
pub struct CueExtractor {
    /// Options.
    pub opts: CueExtractOpts,
}

impl CueExtractor {
    /// Create with options.
    pub fn new(opts: CueExtractOpts) -> Self {
        Self { opts }
    }

    /// Propose candidates from a user turn + optional assistant reply.
    ///
    /// Never writes memory. Returns only proposals that clear score floors.
    pub fn extract(
        &self,
        user_text: &str,
        assistant_text: Option<&str>,
        session_id: Option<&str>,
        now_secs: i64,
    ) -> Vec<MemoryCandidate> {
        let mut out = Vec::new();
        let combined = match assistant_text {
            Some(a) if !a.trim().is_empty() => format!("{user_text}\n{a}"),
            _ => user_text.to_string(),
        };
        // Prefer user text for explicit "remember" cues; scan both for decisions.
        out.extend(self.scan_text(user_text, "user", session_id, now_secs));
        if let Some(a) = assistant_text {
            // Assistant-only: light scan for "I'll remember" restatements is out of scope;
            // we only extract when the user stated durable content (honest capture).
            let _ = a;
        }
        // Also scan combined for decision markers spanning turns.
        if out.is_empty() {
            out.extend(self.scan_text(&combined, "turn", session_id, now_secs));
        }
        // Dedupe by content_hash within this batch.
        let mut seen = std::collections::HashSet::new();
        out.retain(|c| seen.insert(c.content_hash.clone()));
        out.sort_by(|a, b| {
            b.salience
                .partial_cmp(&a.salience)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out.truncate(self.opts.max_candidates.max(1));
        out
    }

    fn scan_text(
        &self,
        text: &str,
        _role: &str,
        session_id: Option<&str>,
        now_secs: i64,
    ) -> Vec<MemoryCandidate> {
        let mut out = Vec::new();
        let lower = text.to_lowercase();

        // Explicit remember cues
        for (pat, kind, cue) in [
            ("remember that ", Kind::Fact, "explicit_remember_that"),
            ("remember: ", Kind::Fact, "explicit_remember_colon"),
            ("please remember ", Kind::Fact, "explicit_please_remember"),
            ("don't forget ", Kind::Fact, "explicit_dont_forget"),
            ("note that ", Kind::Fact, "explicit_note_that"),
        ] {
            if let Some(rest) = extract_after_ci(&lower, text, pat) {
                if let Some(c) =
                    self.make_candidate(kind, rest.as_str(), cue, text, session_id, now_secs)
                {
                    out.push(c);
                }
            }
        }

        // Decision cues
        for (pat, cue) in [
            ("we decided ", "decision_we_decided"),
            ("we chose ", "decision_we_chose"),
            ("decision: ", "decision_label"),
            ("i decided ", "decision_i_decided"),
            ("going with ", "decision_going_with"),
        ] {
            if let Some(rest) = extract_after_ci(&lower, text, pat) {
                if let Some(c) = self.make_candidate(
                    Kind::Decision,
                    rest.as_str(),
                    cue,
                    text,
                    session_id,
                    now_secs,
                ) {
                    out.push(c);
                }
            }
        }

        // Preference cues
        for (pat, cue) in [
            ("i prefer ", "pref_i_prefer"),
            ("my preference is ", "pref_my_preference"),
            ("i always want ", "pref_always_want"),
            ("please always ", "pref_please_always"),
        ] {
            if let Some(rest) = extract_after_ci(&lower, text, pat) {
                if let Some(c) = self.make_candidate(
                    Kind::Preference,
                    rest.as_str(),
                    cue,
                    text,
                    session_id,
                    now_secs,
                ) {
                    out.push(c);
                }
            }
        }

        // Task / todo cues
        for (pat, cue) in [
            ("todo: ", "task_todo"),
            ("i need to ", "task_need_to"),
            ("remind me to ", "task_remind"),
        ] {
            if let Some(rest) = extract_after_ci(&lower, text, pat) {
                if let Some(c) =
                    self.make_candidate(Kind::Task, rest.as_str(), cue, text, session_id, now_secs)
                {
                    out.push(c);
                }
            }
        }

        // Bookmark URL lines
        for line in text.lines() {
            let t = line.trim();
            if t.starts_with("http://") || t.starts_with("https://") {
                if let Some(c) = self.make_candidate(
                    Kind::Bookmark,
                    t,
                    "bookmark_url",
                    text,
                    session_id,
                    now_secs,
                ) {
                    out.push(c);
                }
            }
        }

        out
    }

    fn make_candidate(
        &self,
        kind: Kind,
        raw_body: &str,
        cue: &str,
        source: &str,
        session_id: Option<&str>,
        now_secs: i64,
    ) -> Option<MemoryCandidate> {
        let content = clean_body(raw_body);
        if content.chars().count() < 8 {
            return None;
        }
        // Cap body length
        let content = if content.chars().count() > 500 {
            content.chars().take(500).collect::<String>() + "…"
        } else {
            content
        };
        let title = title_from_content(&content, kind.as_str());
        let ScorePair {
            salience,
            confidence,
        } = score_candidate(kind.clone(), &content, cue);
        if salience < self.opts.min_salience || confidence < self.opts.min_confidence {
            return None;
        }
        let excerpt: String = source.chars().take(200).collect();
        Some(MemoryCandidate {
            id: Uuid::now_v7(),
            kind,
            title,
            content_hash: content_hash_for(&content),
            content,
            scope: Scope::Workspace,
            salience,
            confidence,
            origin_session_id: session_id.map(|s| s.to_string()),
            cue: cue.to_string(),
            source_excerpt: excerpt,
            created_at: now_secs,
            status: CandidateStatus::Pending,
            propose_supersede_of: None,
        })
    }
}

fn extract_after_ci(lower: &str, original: &str, pat_lower: &str) -> Option<String> {
    let idx = lower.find(pat_lower)?;
    let start = idx + pat_lower.len();
    // Map byte index carefully: patterns are ASCII.
    let rest = original.get(start..)?.trim();
    // Take until sentence end or newline
    let end = rest
        .find(['\n', '.', '!', '?'])
        .map(|i| {
            if rest.as_bytes().get(i) == Some(&b'\n') {
                i
            } else {
                i + 1
            }
        })
        .unwrap_or(rest.len());
    let body = rest.get(..end)?.trim();
    if body.is_empty() {
        None
    } else {
        Some(body.to_string())
    }
}

fn clean_body(s: &str) -> String {
    s.trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_remember_fact() {
        let ex = CueExtractor::default();
        let cands = ex.extract(
            "Please remember that our staging DB is Postgres on port 5433.",
            None,
            Some("sess-1"),
            1_000,
        );
        assert!(!cands.is_empty(), "{cands:?}");
        assert!(cands.iter().any(|c| c.kind == Kind::Fact));
        assert!(cands
            .iter()
            .any(|c| c.content.to_lowercase().contains("postgres")));
        assert!(cands.iter().all(|c| c.status == CandidateStatus::Pending));
    }

    #[test]
    fn extracts_decision() {
        let ex = CueExtractor::default();
        let cands = ex.extract(
            "We decided to use SQLite for durable memory in v1.",
            None,
            None,
            2_000,
        );
        assert!(cands.iter().any(|c| c.kind == Kind::Decision));
    }

    #[test]
    fn extracts_preference() {
        let ex = CueExtractor::default();
        let cands = ex.extract("I prefer dark mode in the editor always.", None, None, 3);
        assert!(cands.iter().any(|c| c.kind == Kind::Preference));
    }

    #[test]
    fn ignores_chitchat() {
        let ex = CueExtractor::default();
        let cands = ex.extract("hello there, how are you today?", None, None, 4);
        assert!(
            cands.is_empty(),
            "chitchat must not propose candidates: {cands:?}"
        );
    }

    #[test]
    fn never_auto_writes_status_pending_only() {
        let ex = CueExtractor::default();
        let cands = ex.extract(
            "Remember that the API key lives in the keychain.",
            None,
            None,
            5,
        );
        assert!(!cands.is_empty());
        assert!(cands.iter().all(|c| c.status == CandidateStatus::Pending));
    }
}
