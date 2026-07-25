//! Explorer view-context snapshot + `log_nav` schema (#481).
//!
//! Pure transforms: filters/selection in → structured agent context out;
//! parse/apply `log_nav` → filter/highlight intent (opt-in in UI).

use super::bookmarks::BookmarkSummary;
use super::query::TimeQuality;
use serde::{Deserialize, Serialize};

/// Cap on selected/visible seqs sent to the model.
pub const MAX_VIEW_SEQS: usize = 64;

/// Cap on bookmark summaries in view context.
pub const MAX_VIEW_BOOKMARKS: usize = 24;

/// One evidence lane's source-group filter.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaneView {
    /// Lane id (stable in UI, e.g. "lane-0").
    pub id: String,
    /// Display label.
    #[serde(default)]
    pub label: String,
    /// Sources included in this lane.
    #[serde(default)]
    pub sources: Vec<String>,
}

/// Active explorer filters (global).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerFilters {
    /// Levels.
    #[serde(default)]
    pub levels: Vec<String>,
    /// Sources (global).
    #[serde(default)]
    pub sources: Vec<String>,
    /// Services.
    #[serde(default)]
    pub services: Vec<String>,
    /// Hosts.
    #[serde(default)]
    pub hosts: Vec<String>,
    /// Time from.
    pub time_from: Option<i64>,
    /// Time to (exclusive).
    pub time_to: Option<i64>,
    /// Keyword box.
    pub keyword: Option<String>,
}

/// Snapshot of what the engineer is looking at (agent context — not dump paste).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewContextSnapshot {
    /// Schema version for this payload.
    pub schema_version: u32,
    /// Bound corpus id.
    pub corpus_id: String,
    /// Corpus display name when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corpus_name: Option<String>,
    /// Global filters.
    pub filters: ExplorerFilters,
    /// Evidence lanes (1–4).
    #[serde(default)]
    pub lanes: Vec<LaneView>,
    /// Whether timestamp link mode is on.
    pub link_mode: bool,
    /// Time quality for honest presentation.
    pub time_quality: TimeQuality,
    /// Selected event seqs (capped).
    #[serde(default)]
    pub selected_seqs: Vec<u64>,
    /// Visible window seq range hint [min, max] when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_seq_range: Option<(u64, u64)>,
    /// Bookmark summaries (capped).
    #[serde(default)]
    pub bookmarks: Vec<BookmarkSummary>,
    /// Density mode: comfortable | compact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<String>,
}

impl ViewContextSnapshot {
    /// Current schema version.
    pub const SCHEMA_VERSION: u32 = 1;
}

/// Build a capped view-context snapshot for agent/tools.
pub fn build_view_context(
    corpus_id: impl Into<String>,
    corpus_name: Option<String>,
    filters: ExplorerFilters,
    lanes: Vec<LaneView>,
    link_mode: bool,
    time_quality: TimeQuality,
    selected_seqs: impl IntoIterator<Item = u64>,
    visible_seq_range: Option<(u64, u64)>,
    bookmarks: Vec<BookmarkSummary>,
    density: Option<String>,
) -> ViewContextSnapshot {
    let mut selected: Vec<u64> = selected_seqs.into_iter().collect();
    selected.sort_unstable();
    selected.dedup();
    selected.truncate(MAX_VIEW_SEQS);

    let mut bms = bookmarks;
    bms.truncate(MAX_VIEW_BOOKMARKS);

    let mut lane_list = lanes;
    if lane_list.len() > 4 {
        lane_list.truncate(4);
    }

    ViewContextSnapshot {
        schema_version: ViewContextSnapshot::SCHEMA_VERSION,
        corpus_id: corpus_id.into(),
        corpus_name,
        filters,
        lanes: lane_list,
        link_mode,
        time_quality,
        selected_seqs: selected,
        visible_seq_range,
        bookmarks: bms,
        density,
    }
}

/// Compact string for model system/tool notes (bounded chars).
pub fn view_context_brief(v: &ViewContextSnapshot, max_chars: usize) -> String {
    let mut parts = Vec::new();
    parts.push(format!("corpusId={}", v.corpus_id));
    if let Some(ref n) = v.corpus_name {
        parts.push(format!("name={n}"));
    }
    parts.push(format!("timeQuality={:?}", v.time_quality));
    if let Some(from) = v.filters.time_from {
        parts.push(format!("timeFrom={from}"));
    }
    if let Some(to) = v.filters.time_to {
        parts.push(format!("timeTo={to}"));
    }
    if !v.filters.levels.is_empty() {
        parts.push(format!("levels={}", v.filters.levels.join(",")));
    }
    if !v.filters.sources.is_empty() {
        parts.push(format!("sources={}", v.filters.sources.join(",")));
    }
    if let Some(ref kw) = v.filters.keyword {
        parts.push(format!("keyword={kw}"));
    }
    if !v.selected_seqs.is_empty() {
        let seqs: Vec<_> = v
            .selected_seqs
            .iter()
            .take(12)
            .map(|s| s.to_string())
            .collect();
        parts.push(format!("selectedSeqs=[{}]", seqs.join(",")));
    }
    if !v.bookmarks.is_empty() {
        parts.push(format!("bookmarks={}", v.bookmarks.len()));
    }
    for lane in &v.lanes {
        parts.push(format!(
            "lane:{}:[{}]",
            lane.id,
            lane.sources.join(",")
        ));
    }
    let s = parts.join("; ");
    if s.len() <= max_chars {
        s
    } else {
        // Prefer char boundary.
        let mut end = max_chars.min(s.len());
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

// ── log_nav (agent → UI, opt-in apply) ─────────────────────────────────────

/// Structured navigation proposal from the agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogNavAction {
    /// Discriminator — always "log_nav" for chip rendering.
    #[serde(rename = "type")]
    pub kind: String,
    /// Target corpus (must match explorer when applying).
    pub corpus_id: String,
    /// Optional source filter to apply.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<String>,
    /// Optional levels.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub levels: Vec<String>,
    /// Time window start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts_from: Option<i64>,
    /// Time window end exclusive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts_to: Option<i64>,
    /// Seqs to highlight.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub highlight_seq: Vec<u64>,
    /// Focus lane id if multi-lane.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus_lane: Option<String>,
    /// Chip label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl LogNavAction {
    /// Construct a typed log_nav action.
    pub fn new(corpus_id: impl Into<String>) -> Self {
        Self {
            kind: "log_nav".into(),
            corpus_id: corpus_id.into(),
            sources: vec![],
            levels: vec![],
            ts_from: None,
            ts_to: None,
            highlight_seq: vec![],
            focus_lane: None,
            label: None,
        }
    }
}

/// Result of applying a log_nav action onto current filters (pure merge).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogNavApplyResult {
    /// Merged filters after apply.
    pub filters: ExplorerFilters,
    /// Seqs to highlight in the UI.
    pub highlight_seq: Vec<u64>,
    /// Optional lane focus.
    pub focus_lane: Option<String>,
    /// Human label for toast/chip.
    pub label: Option<String>,
    /// True when action corpus matches expected.
    pub corpus_match: bool,
}

/// Parse JSON value/string into [`LogNavAction`].
pub fn parse_log_nav(value: &serde_json::Value) -> CoreResultNav<LogNavAction> {
    if let Some(t) = value.get("type").and_then(|x| x.as_str()) {
        if t != "log_nav" {
            return Err(NavError::WrongType(t.into()));
        }
    } else {
        return Err(NavError::MissingType);
    }
    // Accept both camelCase (corpusId) and snake (corpus_id) via alias on deserialize —
    // we use camelCase; also try flexible field names.
    let mut v = value.clone();
    if let Some(obj) = v.as_object_mut() {
        rename_key(obj, "corpusId", "corpusId");
        if let Some(c) = obj.remove("corpus_id") {
            obj.insert("corpusId".into(), c);
        }
        if let Some(c) = obj.remove("tsFrom") {
            obj.insert("tsFrom".into(), c);
        }
        if let Some(c) = obj.remove("ts_from") {
            obj.insert("tsFrom".into(), c);
        }
        if let Some(c) = obj.remove("tsTo") {
            obj.insert("tsTo".into(), c);
        }
        if let Some(c) = obj.remove("ts_to") {
            obj.insert("tsTo".into(), c);
        }
        if let Some(c) = obj.remove("highlightSeq") {
            obj.insert("highlightSeq".into(), c);
        }
        if let Some(c) = obj.remove("highlight_seq") {
            obj.insert("highlightSeq".into(), c);
        }
        if let Some(c) = obj.remove("focusLane") {
            obj.insert("focusLane".into(), c);
        }
        if let Some(c) = obj.remove("focus_lane") {
            obj.insert("focusLane".into(), c);
        }
    }
    serde_json::from_value(v).map_err(|e| NavError::Parse(e.to_string()))
}

fn rename_key(
    _obj: &mut serde_json::Map<String, serde_json::Value>,
    _from: &str,
    _to: &str,
) {
    // no-op placeholder; aliases handled above
}

/// Apply log_nav onto existing filters. Does **not** mutate UI — caller opts in.
pub fn apply_log_nav(
    current: &ExplorerFilters,
    action: &LogNavAction,
    expected_corpus_id: &str,
) -> LogNavApplyResult {
    let corpus_match = action.corpus_id == expected_corpus_id;
    let mut filters = current.clone();
    if corpus_match {
        if !action.sources.is_empty() {
            filters.sources = action.sources.clone();
        }
        if !action.levels.is_empty() {
            filters.levels = action.levels.clone();
        }
        if action.ts_from.is_some() {
            filters.time_from = action.ts_from;
        }
        if action.ts_to.is_some() {
            filters.time_to = action.ts_to;
        }
    }
    LogNavApplyResult {
        filters,
        highlight_seq: action.highlight_seq.clone(),
        focus_lane: action.focus_lane.clone(),
        label: action.label.clone(),
        corpus_match,
    }
}

/// Parse errors for log_nav (not CoreError — UI can show soft fail).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavError {
    /// Missing type field.
    MissingType,
    /// Wrong type string.
    WrongType(String),
    /// JSON shape error.
    Parse(String),
}

impl std::fmt::Display for NavError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingType => write!(f, "log_nav missing type"),
            Self::WrongType(t) => write!(f, "expected type log_nav, got {t}"),
            Self::Parse(e) => write!(f, "log_nav parse: {e}"),
        }
    }
}

type CoreResultNav<T> = Result<T, NavError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_view_context_caps_seqs() {
        let v = build_view_context(
            "c1",
            Some("incident".into()),
            ExplorerFilters {
                levels: vec!["error".into()],
                time_from: Some(100),
                ..Default::default()
            },
            vec![LaneView {
                id: "lane-0".into(),
                label: "api".into(),
                sources: vec!["api.log".into()],
            }],
            true,
            TimeQuality::Wall,
            0..200u64,
            Some((10, 50)),
            vec![],
            Some("compact".into()),
        );
        assert_eq!(v.schema_version, 1);
        assert_eq!(v.selected_seqs.len(), MAX_VIEW_SEQS);
        assert_eq!(v.corpus_id, "c1");
        let brief = view_context_brief(&v, 200);
        assert!(brief.contains("corpusId=c1"));
        assert!(brief.len() <= 200 || brief.ends_with('…'));
    }

    #[test]
    fn parse_and_apply_log_nav() {
        let json = serde_json::json!({
            "type": "log_nav",
            "corpusId": "abc",
            "sources": ["api.log"],
            "tsFrom": 1000,
            "tsTo": 2000,
            "highlightSeq": [5, 6],
            "label": "Auth failures"
        });
        let action = parse_log_nav(&json).unwrap();
        assert_eq!(action.kind, "log_nav");
        assert_eq!(action.sources, vec!["api.log"]);

        let current = ExplorerFilters {
            levels: vec!["info".into()],
            ..Default::default()
        };
        let applied = apply_log_nav(&current, &action, "abc");
        assert!(applied.corpus_match);
        assert_eq!(applied.filters.sources, vec!["api.log"]);
        assert_eq!(applied.filters.time_from, Some(1000));
        assert_eq!(applied.highlight_seq, vec![5, 6]);
        // levels unchanged when action omits them
        assert_eq!(applied.filters.levels, vec!["info"]);

        let wrong = apply_log_nav(&current, &action, "other");
        assert!(!wrong.corpus_match);
        assert!(wrong.filters.sources.is_empty());
    }

    #[test]
    fn parse_log_nav_snake_alias() {
        let json = serde_json::json!({
            "type": "log_nav",
            "corpus_id": "x",
            "ts_from": 1,
            "highlight_seq": [9]
        });
        let action = parse_log_nav(&json).unwrap();
        assert_eq!(action.corpus_id, "x");
        assert_eq!(action.ts_from, Some(1));
        assert_eq!(action.highlight_seq, vec![9]);
    }
}
