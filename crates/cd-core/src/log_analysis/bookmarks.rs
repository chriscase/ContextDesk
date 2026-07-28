//! Corpus bookmarks (line + range) for Log Explorer (#485 / #482 store).
//!
//! Persisted as `bookmarks.json` under the corpus root (sidecar, not in package v1).

use super::store::LogCorpus;
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Bookmark document version.
pub const BOOKMARKS_VERSION: u32 = 1;

/// One bookmark: single event or inclusive seq range.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    /// Stable id.
    pub id: String,
    /// Display label.
    pub label: String,
    /// Inclusive start seq.
    pub seq_from: u64,
    /// Inclusive end seq (same as from for a single line).
    pub seq_to: u64,
    /// Optional wall/order time lower bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts_from: Option<i64>,
    /// Optional exclusive upper time bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts_to: Option<i64>,
    /// Optional color token (UI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Free-form note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Created unix secs.
    pub created_at: i64,
    /// Updated unix secs.
    pub updated_at: i64,
}

/// Sidecar file body.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkFile {
    /// Schema version.
    #[serde(default = "default_bm_version")]
    pub version: u32,
    /// Bookmarks.
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
}

fn default_bm_version() -> u32 {
    BOOKMARKS_VERSION
}

/// Lightweight summary for agent view context.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkSummary {
    /// Id.
    pub id: String,
    /// Label.
    pub label: String,
    /// Seq from.
    pub seq_from: u64,
    /// Seq to.
    pub seq_to: u64,
}

impl From<&Bookmark> for BookmarkSummary {
    fn from(b: &Bookmark) -> Self {
        Self {
            id: b.id.clone(),
            label: b.label.clone(),
            seq_from: b.seq_from,
            seq_to: b.seq_to,
        }
    }
}

fn bookmarks_path(corpus: &LogCorpus) -> std::path::PathBuf {
    corpus.root().join("bookmarks.json")
}

/// Load bookmarks (empty if missing).
pub fn list_bookmarks(corpus: &LogCorpus) -> CoreResult<Vec<Bookmark>> {
    let path = bookmarks_path(corpus);
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| CoreError::Message(format!("read bookmarks: {e}")))?;
    let file: BookmarkFile = serde_json::from_str(&raw)
        .map_err(|e| CoreError::Message(format!("parse bookmarks: {e}")))?;
    Ok(file.bookmarks)
}

fn write_all(corpus: &LogCorpus, bookmarks: Vec<Bookmark>) -> CoreResult<()> {
    let file = BookmarkFile {
        version: BOOKMARKS_VERSION,
        bookmarks,
    };
    let path = bookmarks_path(corpus);
    std::fs::write(&path, serde_json::to_vec_pretty(&file)?)
        .map_err(|e| CoreError::Message(format!("write bookmarks: {e}")))?;
    Ok(())
}

/// Create a single-line bookmark.
pub fn add_line_bookmark(
    corpus: &LogCorpus,
    seq: u64,
    label: impl Into<String>,
    note: Option<String>,
    color: Option<String>,
    ts: Option<i64>,
) -> CoreResult<Bookmark> {
    add_range_bookmark(
        corpus,
        NewBookmark {
            seq_from: seq,
            seq_to: seq,
            label: label.into(),
            note,
            color,
            ts_from: ts,
            ts_to: ts,
        },
    )
}

/// Parameters for creating a range bookmark.
#[derive(Debug, Clone)]
pub struct NewBookmark {
    /// Inclusive start seq.
    pub seq_from: u64,
    /// Inclusive end seq.
    pub seq_to: u64,
    /// Label.
    pub label: String,
    /// Note.
    pub note: Option<String>,
    /// Color token.
    pub color: Option<String>,
    /// Optional ts from.
    pub ts_from: Option<i64>,
    /// Optional ts to.
    pub ts_to: Option<i64>,
}

/// Create a range bookmark (inclusive seq bounds).
pub fn add_range_bookmark(corpus: &LogCorpus, new: NewBookmark) -> CoreResult<Bookmark> {
    let seq_from = new.seq_from;
    let seq_to = new.seq_to;
    let label = new.label;
    let note = new.note;
    let color = new.color;
    let ts_from = new.ts_from;
    let ts_to = new.ts_to;
    let (from, to) = if seq_from <= seq_to {
        (seq_from, seq_to)
    } else {
        (seq_to, seq_from)
    };
    let mut all = list_bookmarks(corpus)?;
    if let Some(existing) = all
        .iter()
        .find(|bookmark| bookmark.seq_from == from && bookmark.seq_to == to)
    {
        return Ok(existing.clone());
    }
    let now = crate::embed::now_unix_secs();
    let bm = Bookmark {
        id: Uuid::now_v7().to_string(),
        label,
        seq_from: from,
        seq_to: to,
        ts_from,
        ts_to,
        color,
        note,
        created_at: now,
        updated_at: now,
    };
    all.push(bm.clone());
    write_all(corpus, all)?;
    Ok(bm)
}

/// Update label/note/color on an existing bookmark.
pub fn update_bookmark(
    corpus: &LogCorpus,
    id: &str,
    label: Option<String>,
    note: Option<Option<String>>,
    color: Option<Option<String>>,
) -> CoreResult<Bookmark> {
    let mut all = list_bookmarks(corpus)?;
    let bm = all
        .iter_mut()
        .find(|b| b.id == id)
        .ok_or_else(|| CoreError::Message(format!("bookmark not found: {id}")))?;
    if let Some(l) = label {
        bm.label = l;
    }
    if let Some(n) = note {
        bm.note = n;
    }
    if let Some(c) = color {
        bm.color = c;
    }
    bm.updated_at = crate::embed::now_unix_secs();
    let out = bm.clone();
    write_all(corpus, all)?;
    Ok(out)
}

/// Delete by id (no-op success if missing).
pub fn delete_bookmark(corpus: &LogCorpus, id: &str) -> CoreResult<bool> {
    let mut all = list_bookmarks(corpus)?;
    let before = all.len();
    all.retain(|b| b.id != id);
    if all.len() == before {
        return Ok(false);
    }
    write_all(corpus, all)?;
    Ok(true)
}

/// Summaries for agent view context (capped).
pub fn bookmark_summaries(corpus: &LogCorpus, cap: usize) -> CoreResult<Vec<BookmarkSummary>> {
    let mut all = list_bookmarks(corpus)?;
    all.sort_by_key(|b| std::cmp::Reverse(b.updated_at));
    Ok(all
        .iter()
        .take(cap.clamp(1, 100))
        .map(BookmarkSummary::from)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::store::LogEvent;

    #[test]
    fn bookmark_crud_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "bm").unwrap();
        c.push_events(&[
            LogEvent {
                seq: 1,
                ts: 1_700_000_000,
                level: "error".into(),
                service: None,
                host: None,
                template_id: 1,
                params: vec![],
                trace_id: None,
                message: "a".into(),
                source: "a.log".into(),
            },
            LogEvent {
                seq: 2,
                ts: 1_700_000_001,
                level: "info".into(),
                service: None,
                host: None,
                template_id: 2,
                params: vec![],
                trace_id: None,
                message: "b".into(),
                source: "a.log".into(),
            },
        ])
        .unwrap();
        c.flush().unwrap();
        let id = c.id().to_string();

        let b1 = add_line_bookmark(
            &c,
            1,
            "interesting",
            Some("note".into()),
            None,
            Some(1_700_000_000),
        )
        .unwrap();
        let b2 = add_range_bookmark(
            &c,
            NewBookmark {
                seq_from: 1,
                seq_to: 2,
                label: "range".into(),
                note: None,
                color: Some("red".into()),
                ts_from: None,
                ts_to: None,
            },
        )
        .unwrap();
        assert_eq!(list_bookmarks(&c).unwrap().len(), 2);

        drop(c);
        let c2 = LogCorpus::open(dir.path(), &id).unwrap();
        let all = list_bookmarks(&c2).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all
            .iter()
            .any(|b| b.id == b1.id && b.label == "interesting"));
        assert!(all.iter().any(|b| b.id == b2.id && b.seq_from == 1));

        update_bookmark(&c2, &b1.id, Some("renamed".into()), None, None).unwrap();
        assert_eq!(
            list_bookmarks(&c2)
                .unwrap()
                .iter()
                .find(|b| b.id == b1.id)
                .unwrap()
                .label,
            "renamed"
        );
        assert!(delete_bookmark(&c2, &b1.id).unwrap());
        assert_eq!(list_bookmarks(&c2).unwrap().len(), 1);
    }

    #[test]
    fn repeated_and_reversed_ranges_are_idempotent_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "bm-idempotent").unwrap();
        let id = c.id().to_string();

        let first = add_range_bookmark(
            &c,
            NewBookmark {
                seq_from: 4,
                seq_to: 9,
                label: "first".into(),
                note: None,
                color: None,
                ts_from: None,
                ts_to: None,
            },
        )
        .unwrap();
        let repeated = add_range_bookmark(
            &c,
            NewBookmark {
                seq_from: 4,
                seq_to: 9,
                label: "repeated".into(),
                note: Some("must not overwrite".into()),
                color: Some("red".into()),
                ts_from: None,
                ts_to: None,
            },
        )
        .unwrap();
        let reversed = add_range_bookmark(
            &c,
            NewBookmark {
                seq_from: 9,
                seq_to: 4,
                label: "reversed".into(),
                note: None,
                color: None,
                ts_from: None,
                ts_to: None,
            },
        )
        .unwrap();
        let distinct = add_range_bookmark(
            &c,
            NewBookmark {
                seq_from: 4,
                seq_to: 10,
                label: "distinct".into(),
                note: None,
                color: None,
                ts_from: None,
                ts_to: None,
            },
        )
        .unwrap();

        assert_eq!(repeated.id, first.id);
        assert_eq!(reversed.id, first.id);
        assert_ne!(distinct.id, first.id);
        assert_eq!(list_bookmarks(&c).unwrap().len(), 2);

        drop(c);
        let reopened = LogCorpus::open(dir.path(), &id).unwrap();
        let after_reopen = add_range_bookmark(
            &reopened,
            NewBookmark {
                seq_from: 9,
                seq_to: 4,
                label: "after reopen".into(),
                note: None,
                color: None,
                ts_from: None,
                ts_to: None,
            },
        )
        .unwrap();
        assert_eq!(after_reopen.id, first.id);
        assert_eq!(list_bookmarks(&reopened).unwrap().len(), 2);
    }
}
