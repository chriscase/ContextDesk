//! Corpus bookmarks (line + range) for Log Explorer (#485 / #482 store).
//!
//! Persisted as `bookmarks.json` under the corpus root (sidecar, not in package v1).

use super::store::LogCorpus;
use super::{query::fetch_event_by_seq, TimeQuality};
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Bookmark document version.
pub const BOOKMARKS_VERSION: u32 = 2;
/// A selection is resident and bounded; refuse unexpectedly large evidence sets.
pub const MAX_BOOKMARK_EVENT_REFS: usize = 512;

/// Stable, payload-free identity for one saved evidence event.
///
/// Sequence is authoritative only inside `corpus_id`. Source and time fields are
/// persisted hints that must match the corpus before the reference is opened.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkEventRef {
    /// Corpus that owns the sequence.
    pub corpus_id: String,
    /// Stable event sequence within the corpus.
    pub seq: u64,
    /// Relative source identity, never an absolute path.
    pub source: String,
    /// Persisted timestamp/order hint; revalidated against DuckDB.
    pub timestamp_hint: i64,
    /// Persisted quality hint; it never upgrades the authoritative event.
    pub time_quality_hint: TimeQuality,
}

/// Current validation state for a bookmark's evidence identity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BookmarkEvidenceStatus {
    /// Version-1 seq range with no exact event set.
    LegacyRange,
    /// Every exact reference still matches the authoritative corpus.
    Verified,
    /// At least one referenced sequence no longer exists.
    Missing,
    /// A sequence exists but its persisted corpus/source/time identity differs.
    Stale,
}

/// One bookmark: an exact event set or a legacy inclusive sequence range.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    /// Stable id.
    pub id: String,
    /// Display label.
    pub label: String,
    /// Inclusive start for a legacy range; minimum seq envelope for an exact set.
    pub seq_from: u64,
    /// Inclusive end for a legacy range; maximum seq envelope for an exact set.
    pub seq_to: u64,
    /// Optional legacy wall/order lower hint or exact-set minimum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts_from: Option<i64>,
    /// Optional legacy wall/order upper hint or exact-set maximum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts_to: Option<i64>,
    /// Exact event membership for evidence-aware bookmarks.
    ///
    /// Missing means a legacy range. Empty sets are never written for new
    /// evidence bookmarks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub event_refs: Vec<BookmarkEventRef>,
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
    /// Legacy range start or exact-set minimum seq envelope.
    pub seq_from: u64,
    /// Legacy range end or exact-set maximum seq envelope.
    pub seq_to: u64,
    /// Exact evidence membership when available; empty means legacy range.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub event_refs: Vec<BookmarkEventRef>,
}

/// Bookmark plus current trusted-core validation state.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBookmark {
    /// Persisted bookmark fields.
    #[serde(flatten)]
    pub bookmark: Bookmark,
    /// Current state of the persisted evidence identity.
    pub evidence_status: BookmarkEvidenceStatus,
}

impl From<&Bookmark> for BookmarkSummary {
    fn from(b: &Bookmark) -> Self {
        Self {
            id: b.id.clone(),
            label: b.label.clone(),
            seq_from: b.seq_from,
            seq_to: b.seq_to,
            event_refs: b.event_refs.clone(),
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

fn validate_event_ref(
    corpus: &LogCorpus,
    event_ref: &BookmarkEventRef,
) -> CoreResult<BookmarkEvidenceStatus> {
    if event_ref.corpus_id != corpus.id() {
        return Ok(BookmarkEvidenceStatus::Stale);
    }
    let Some(actual) = fetch_event_by_seq(corpus, event_ref.seq)? else {
        return Ok(BookmarkEvidenceStatus::Missing);
    };
    if actual.source != event_ref.source
        || actual.ts != event_ref.timestamp_hint
        || actual.time_quality != event_ref.time_quality_hint
    {
        return Ok(BookmarkEvidenceStatus::Stale);
    }
    Ok(BookmarkEvidenceStatus::Verified)
}

/// Validate one bookmark against the current authoritative corpus.
pub fn resolve_bookmark(corpus: &LogCorpus, bookmark: Bookmark) -> CoreResult<ResolvedBookmark> {
    let evidence_status = if bookmark.event_refs.is_empty() {
        BookmarkEvidenceStatus::LegacyRange
    } else {
        let mut status = BookmarkEvidenceStatus::Verified;
        for event_ref in &bookmark.event_refs {
            match validate_event_ref(corpus, event_ref)? {
                BookmarkEvidenceStatus::Missing => {
                    status = BookmarkEvidenceStatus::Missing;
                    break;
                }
                BookmarkEvidenceStatus::Stale => {
                    status = BookmarkEvidenceStatus::Stale;
                }
                BookmarkEvidenceStatus::Verified | BookmarkEvidenceStatus::LegacyRange => {}
            }
        }
        status
    };
    Ok(ResolvedBookmark {
        bookmark,
        evidence_status,
    })
}

/// Load bookmarks and validate exact evidence references without rewriting the sidecar.
pub fn list_resolved_bookmarks(corpus: &LogCorpus) -> CoreResult<Vec<ResolvedBookmark>> {
    list_bookmarks(corpus)?
        .into_iter()
        .map(|bookmark| resolve_bookmark(corpus, bookmark))
        .collect()
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

/// Parameters for an exact, bounded evidence bookmark.
#[derive(Debug, Clone)]
pub struct NewEvidenceBookmark {
    /// Requested exact references. The core resolves every sequence and
    /// canonicalizes the stored hints before publication.
    pub event_refs: Vec<BookmarkEventRef>,
    /// Label.
    pub label: String,
    /// Note.
    pub note: Option<String>,
    /// Color token.
    pub color: Option<String>,
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
        event_refs: vec![],
        color,
        note,
        created_at: now,
        updated_at: now,
    };
    all.push(bm.clone());
    write_all(corpus, all)?;
    Ok(bm)
}

fn canonicalize_event_refs(
    corpus: &LogCorpus,
    requested: Vec<BookmarkEventRef>,
) -> CoreResult<Vec<BookmarkEventRef>> {
    if requested.is_empty() {
        return Err(CoreError::Message(
            "bookmark evidence set must contain at least one event".into(),
        ));
    }
    if requested.len() > MAX_BOOKMARK_EVENT_REFS {
        return Err(CoreError::Message(format!(
            "bookmark evidence set exceeds {MAX_BOOKMARK_EVENT_REFS} events"
        )));
    }

    let mut canonical = Vec::with_capacity(requested.len());
    for requested_ref in requested {
        if requested_ref.corpus_id != corpus.id() {
            return Err(CoreError::Message(format!(
                "bookmark event seq {} belongs to a different corpus",
                requested_ref.seq
            )));
        }
        let Some(actual) = fetch_event_by_seq(corpus, requested_ref.seq)? else {
            return Err(CoreError::Message(format!(
                "bookmark event seq {} is missing from corpus",
                requested_ref.seq
            )));
        };
        if actual.source != requested_ref.source
            || actual.ts != requested_ref.timestamp_hint
            || actual.time_quality != requested_ref.time_quality_hint
        {
            return Err(CoreError::Message(format!(
                "bookmark event seq {} no longer matches source/time identity",
                requested_ref.seq
            )));
        }
        canonical.push(BookmarkEventRef {
            corpus_id: corpus.id().to_string(),
            seq: actual.seq,
            source: actual.source,
            timestamp_hint: actual.ts,
            time_quality_hint: actual.time_quality,
        });
    }
    canonical.sort_by(|left, right| {
        left.seq
            .cmp(&right.seq)
            .then_with(|| left.source.cmp(&right.source))
    });
    canonical.dedup_by(|left, right| left.seq == right.seq);
    Ok(canonical)
}

fn exact_sets_equal(left: &[BookmarkEventRef], right: &[BookmarkEventRef]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut left = left.to_vec();
    let mut right = right.to_vec();
    let sort = |refs: &mut Vec<BookmarkEventRef>| {
        refs.sort_by(|left, right| {
            left.seq
                .cmp(&right.seq)
                .then_with(|| left.source.cmp(&right.source))
        });
    };
    sort(&mut left);
    sort(&mut right);
    left == right
}

/// Create an exact evidence bookmark after trusted-core identity validation.
pub fn add_evidence_bookmark(corpus: &LogCorpus, new: NewEvidenceBookmark) -> CoreResult<Bookmark> {
    let event_refs = canonicalize_event_refs(corpus, new.event_refs)?;
    let mut all = list_bookmarks(corpus)?;
    if let Some(existing) = all
        .iter()
        .find(|bookmark| exact_sets_equal(&bookmark.event_refs, &event_refs))
    {
        return Ok(existing.clone());
    }

    let seq_from = event_refs
        .first()
        .map(|event_ref| event_ref.seq)
        .ok_or_else(|| CoreError::Message("bookmark evidence set is empty".into()))?;
    let seq_to = event_refs
        .last()
        .map(|event_ref| event_ref.seq)
        .ok_or_else(|| CoreError::Message("bookmark evidence set is empty".into()))?;
    let ts_from = event_refs
        .iter()
        .map(|event_ref| event_ref.timestamp_hint)
        .min();
    let ts_to = event_refs
        .iter()
        .map(|event_ref| event_ref.timestamp_hint)
        .max();
    let now = crate::embed::now_unix_secs();
    let bookmark = Bookmark {
        id: Uuid::now_v7().to_string(),
        label: new.label,
        seq_from,
        seq_to,
        ts_from,
        ts_to,
        event_refs,
        color: new.color,
        note: new.note,
        created_at: now,
        updated_at: now,
    };
    all.push(bookmark.clone());
    write_all(corpus, all)?;
    Ok(bookmark)
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

    fn evidence_corpus(dir: &tempfile::TempDir) -> LogCorpus {
        let corpus = LogCorpus::create(dir.path(), "evidence").unwrap();
        corpus
            .push_events(&[
                LogEvent {
                    seq: 10,
                    ts: 1_700_000_010,
                    level: "error".into(),
                    service: None,
                    host: None,
                    template_id: 1,
                    params: vec![],
                    trace_id: None,
                    message: "first payload must not enter bookmark sidecar".into(),
                    source: "api.log".into(),
                },
                LogEvent {
                    seq: 11,
                    ts: 1_700_000_011,
                    level: "info".into(),
                    service: None,
                    host: None,
                    template_id: 2,
                    params: vec![],
                    trace_id: None,
                    message: "unselected intervening payload".into(),
                    source: "api.log".into(),
                },
                LogEvent {
                    seq: 12,
                    ts: 1_700_000_010,
                    level: "warn".into(),
                    service: None,
                    host: None,
                    template_id: 3,
                    params: vec![],
                    trace_id: None,
                    message: "same timestamp, different source".into(),
                    source: "worker.log".into(),
                },
            ])
            .unwrap();
        corpus.flush().unwrap();
        corpus
    }

    fn evidence_ref(
        corpus: &LogCorpus,
        seq: u64,
        source: &str,
        timestamp_hint: i64,
    ) -> BookmarkEventRef {
        BookmarkEventRef {
            corpus_id: corpus.id().to_string(),
            seq,
            source: source.into(),
            timestamp_hint,
            time_quality_hint: TimeQuality::Wall,
        }
    }

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

    #[test]
    fn exact_noncontiguous_evidence_is_idempotent_and_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&dir);
        let corpus_id = corpus.id().to_string();
        let first = add_evidence_bookmark(
            &corpus,
            NewEvidenceBookmark {
                event_refs: vec![
                    evidence_ref(&corpus, 12, "worker.log", 1_700_000_010),
                    evidence_ref(&corpus, 10, "api.log", 1_700_000_010),
                ],
                label: "exact clues".into(),
                note: None,
                color: None,
            },
        )
        .unwrap();
        assert_eq!(first.seq_from, 10);
        assert_eq!(first.seq_to, 12);
        assert_eq!(
            first
                .event_refs
                .iter()
                .map(|event_ref| event_ref.seq)
                .collect::<Vec<_>>(),
            vec![10, 12]
        );
        assert_eq!(first.event_refs[0].source, "api.log");
        assert_eq!(first.event_refs[1].source, "worker.log");
        let mut reversed_refs = first.event_refs.clone();
        reversed_refs.reverse();
        assert!(exact_sets_equal(&first.event_refs, &reversed_refs));
        assert_eq!(
            first.event_refs[0].timestamp_hint,
            first.event_refs[1].timestamp_hint
        );

        let repeated = add_evidence_bookmark(
            &corpus,
            NewEvidenceBookmark {
                event_refs: vec![
                    evidence_ref(&corpus, 10, "api.log", 1_700_000_010),
                    evidence_ref(&corpus, 12, "worker.log", 1_700_000_010),
                ],
                label: "must not duplicate".into(),
                note: Some("must not overwrite".into()),
                color: Some("red".into()),
            },
        )
        .unwrap();
        assert_eq!(repeated.id, first.id);
        assert_eq!(list_bookmarks(&corpus).unwrap().len(), 1);

        let raw = std::fs::read_to_string(bookmarks_path(&corpus)).unwrap();
        assert!(raw.contains("\"eventRefs\""));
        assert!(!raw.contains("first payload"));
        assert!(!raw.contains("unselected intervening payload"));
        assert!(!raw.contains("same timestamp, different source"));

        drop(corpus);
        let reopened = LogCorpus::open(dir.path(), &corpus_id).unwrap();
        let resolved = list_resolved_bookmarks(&reopened).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(
            resolved[0].evidence_status,
            BookmarkEvidenceStatus::Verified
        );
        assert_eq!(
            resolved[0]
                .bookmark
                .event_refs
                .iter()
                .map(|event_ref| event_ref.seq)
                .collect::<Vec<_>>(),
            vec![10, 12]
        );
    }

    #[test]
    fn exact_contiguous_evidence_is_validated_before_save() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&dir);
        let saved = add_evidence_bookmark(
            &corpus,
            NewEvidenceBookmark {
                event_refs: vec![
                    evidence_ref(&corpus, 10, "api.log", 1_700_000_010),
                    evidence_ref(&corpus, 11, "api.log", 1_700_000_011),
                ],
                label: "contiguous api evidence".into(),
                note: None,
                color: None,
            },
        )
        .unwrap();
        assert_eq!((saved.seq_from, saved.seq_to), (10, 11));
        assert_eq!(saved.event_refs.len(), 2);

        let error = add_evidence_bookmark(
            &corpus,
            NewEvidenceBookmark {
                event_refs: vec![evidence_ref(&corpus, 10, "wrong-source.log", 1_700_000_010)],
                label: "stale".into(),
                note: None,
                color: None,
            },
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("no longer matches source/time identity"));
        assert_eq!(list_bookmarks(&corpus).unwrap().len(), 1);
    }

    #[test]
    fn stale_and_missing_exact_references_remain_visible() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&dir);
        let saved = add_evidence_bookmark(
            &corpus,
            NewEvidenceBookmark {
                event_refs: vec![evidence_ref(&corpus, 10, "api.log", 1_700_000_010)],
                label: "durable clue".into(),
                note: None,
                color: None,
            },
        )
        .unwrap();

        let mut all = list_bookmarks(&corpus).unwrap();
        all[0].event_refs[0].source = "replaced.log".into();
        write_all(&corpus, all).unwrap();
        let stale = list_resolved_bookmarks(&corpus).unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].bookmark.id, saved.id);
        assert_eq!(stale[0].evidence_status, BookmarkEvidenceStatus::Stale);

        let mut all = list_bookmarks(&corpus).unwrap();
        all[0].event_refs[0].seq = 404;
        write_all(&corpus, all).unwrap();
        let missing = list_resolved_bookmarks(&corpus).unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].bookmark.id, saved.id);
        assert_eq!(missing[0].evidence_status, BookmarkEvidenceStatus::Missing);
    }

    #[test]
    fn opening_legacy_sidecar_is_byte_preserving_and_range_remains_readable() {
        let dir = tempfile::tempdir().unwrap();
        let corpus = evidence_corpus(&dir);
        let legacy = br#"{
  "version": 1,
  "bookmarks": [
    {
      "id": "legacy-range",
      "label": "old incident window",
      "seqFrom": 10,
      "seqTo": 12,
      "tsFrom": 1700000010,
      "tsTo": 1700000010,
      "createdAt": 1,
      "updatedAt": 1
    }
  ]
}
"#;
        std::fs::write(bookmarks_path(&corpus), legacy).unwrap();

        let listed = list_resolved_bookmarks(&corpus).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].bookmark.seq_from, 10);
        assert!(listed[0].bookmark.event_refs.is_empty());
        assert_eq!(
            listed[0].evidence_status,
            BookmarkEvidenceStatus::LegacyRange
        );
        assert_eq!(
            std::fs::read(bookmarks_path(&corpus)).unwrap(),
            legacy.as_slice()
        );
    }
}
