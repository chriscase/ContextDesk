//! Host-side bound for linked-log `search_logs` investigation loops.
//!
//! Detects **non-progress**: a successful or empty search that adds no new
//! host-verified citeable event identities versus the union already seen this
//! turn. Detection is pure (normalized intent + event fingerprint), never
//! demo-string matching. Legitimate refinement that surfaces new `(seq, source)`
//! identities remains allowed.

use std::collections::BTreeSet;

use serde_json::Value;

use super::SearchEvidenceIdentity;

/// Stop after this many consecutive no-new-evidence `search_logs` results.
/// First redundant (or zero-hit) search ends further log retrieval for the turn.
pub const MAX_CONSECUTIVE_NO_PROGRESS_SEARCHES: u32 = 1;

/// Stable host-verified citeable set (sorted seq+source).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CiteableEvidenceSet {
    identities: BTreeSet<(u64, String)>,
}

impl CiteableEvidenceSet {
    /// Build from host `search_logs` evidence only.
    pub fn from_evidence(evidence: &[SearchEvidenceIdentity]) -> Self {
        let mut identities = BTreeSet::new();
        for e in evidence {
            if e.source.is_empty() {
                continue;
            }
            identities.insert((e.seq, e.source.clone()));
        }
        Self { identities }
    }

    /// Empty set (zero hits).
    pub fn empty() -> Self {
        Self::default()
    }

    /// Number of unique citeable identities.
    pub fn len(&self) -> usize {
        self.identities.len()
    }

    /// True when no citeable identities are present.
    pub fn is_empty(&self) -> bool {
        self.identities.is_empty()
    }

    /// Count of identities in `self` that are not in `prior`.
    pub fn new_count_vs(&self, prior: &Self) -> usize {
        self.identities
            .iter()
            .filter(|id| !prior.identities.contains(id))
            .count()
    }

    /// Union in place.
    pub fn extend_union(&mut self, other: &Self) {
        self.identities.extend(other.identities.iter().cloned());
    }

    /// Deterministic fingerprint for equality of citeable sets (order-independent).
    pub fn fingerprint(&self) -> String {
        if self.identities.is_empty() {
            return "empty".into();
        }
        let mut parts = Vec::with_capacity(self.identities.len());
        for (seq, source) in &self.identities {
            parts.push(format!("{seq}\u{1f}{source}"));
        }
        parts.join("\u{1e}")
    }

    /// Sorted view for tests/debug.
    pub fn sorted_pairs(&self) -> Vec<(u64, String)> {
        self.identities.iter().cloned().collect()
    }
}

/// Normalized search intent (argument order / whitespace ignored).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchIntentKey {
    key: String,
}

impl SearchIntentKey {
    /// Build from tool arguments JSON. Unknown fields ignored for the key.
    pub fn from_search_logs_args(args: &Value) -> Self {
        let query = norm_str(args.get("query"));
        let level = norm_str(args.get("level"));
        let service = norm_str(args.get("service"));
        let trace_id = norm_str(args.get("trace_id"));
        let time_from = norm_i64(args.get("time_from"));
        let time_to = norm_i64(args.get("time_to"));
        let semantic = args
            .get("semantic")
            .and_then(|v| v.as_bool())
            .map(|b| if b { "1" } else { "0" })
            .unwrap_or("-");
        let k = args
            .get("k")
            .and_then(|v| v.as_u64())
            .map(|n| n.to_string())
            .unwrap_or_else(|| "-".into());
        // Intent key is for diagnostics only; non-progress is evidence-set based.
        // Including intent still lets us explain "same result under changed args".
        let key = format!(
            "q={query}|lv={level}|svc={service}|tr={trace_id}|tf={time_from}|tt={time_to}|sem={semantic}|k={k}"
        );
        Self { key }
    }

    /// Borrow the canonical intent key string.
    pub fn as_str(&self) -> &str {
        &self.key
    }
}

fn norm_str(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "-".into())
}

fn norm_i64(v: Option<&Value>) -> String {
    v.and_then(|x| {
        x.as_i64()
            .or_else(|| x.as_u64().map(|u| u as i64))
            .or_else(|| x.as_f64().map(|f| f as i64))
    })
    .map(|n| n.to_string())
    .unwrap_or_else(|| "-".into())
}

/// Host decision after one `search_logs` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoundDecision {
    /// New citeable events (or first attempt policy allows continue).
    Allow {
        /// How many identities were new vs prior union.
        new_event_count: usize,
        /// Total unique citeable identities after this result.
        union_size: usize,
    },
    /// No new citeable events; further identical/subset searches are blocked.
    Stop {
        /// Stable machine code for activity / trail.
        reason_code: &'static str,
        /// Appended to the tool result the model sees.
        model_message: String,
        /// Search trail / activity step (no secrets).
        trail_step: String,
    },
}

/// Turn-scoped tracker for linked-log search non-progress.
#[derive(Debug, Clone, Default)]
pub struct LinkedSearchProgressTracker {
    seen_union: CiteableEvidenceSet,
    consecutive_no_progress: u32,
    search_attempts: u32,
    last_intent: Option<SearchIntentKey>,
    last_evidence_fp: Option<String>,
}

impl LinkedSearchProgressTracker {
    /// Empty tracker for a new agent turn.
    pub fn new() -> Self {
        Self::default()
    }

    /// How many `search_logs` results have been observed this turn.
    pub fn search_attempts(&self) -> u32 {
        self.search_attempts
    }

    /// Size of the union of all citeable identities seen so far.
    pub fn union_size(&self) -> usize {
        self.seen_union.len()
    }

    /// Fingerprint of the union set (for activity / tests).
    pub fn seen_fingerprint(&self) -> String {
        self.seen_union.fingerprint()
    }

    /// Observe one finished `search_logs` (ok or empty). Pure update + decision.
    ///
    /// `ok=false` with empty evidence still counts as no-progress toward the bound
    /// so zero-hit refinements cannot loop forever.
    pub fn observe_search_logs(
        &mut self,
        args: &Value,
        evidence: &[SearchEvidenceIdentity],
        _ok: bool,
    ) -> BoundDecision {
        self.search_attempts = self.search_attempts.saturating_add(1);
        let intent = SearchIntentKey::from_search_logs_args(args);
        let current = CiteableEvidenceSet::from_evidence(evidence);
        let new_event_count = current.new_count_vs(&self.seen_union);
        let evidence_fp = current.fingerprint();
        let same_fp_as_last = self
            .last_evidence_fp
            .as_ref()
            .is_some_and(|fp| fp == &evidence_fp);
        let intent_changed = self
            .last_intent
            .as_ref()
            .is_some_and(|prev| prev != &intent);

        self.last_intent = Some(intent);
        self.last_evidence_fp = Some(evidence_fp.clone());

        if new_event_count > 0 {
            self.seen_union.extend_union(&current);
            self.consecutive_no_progress = 0;
            return BoundDecision::Allow {
                new_event_count,
                union_size: self.seen_union.len(),
            };
        }

        // No new citeable events (empty or subset/identical set, any arg shape).
        self.consecutive_no_progress = self.consecutive_no_progress.saturating_add(1);
        // First search attempt always proceeds (even zero-hit) so the model can
        // see the empty/result once; any later no-progress stops further retrieval.
        let should_stop = self.search_attempts > 1
            && self.consecutive_no_progress >= MAX_CONSECUTIVE_NO_PROGRESS_SEARCHES;
        if should_stop {
            let reason_code = if current.is_empty() {
                "linked_search_non_progress_zero_hits"
            } else if same_fp_as_last && intent_changed {
                "linked_search_non_progress_same_evidence_changed_args"
            } else if same_fp_as_last {
                "linked_search_non_progress_duplicate_result"
            } else {
                "linked_search_non_progress_no_new_events"
            };
            let model_message = format!(
                "HOST BOUND: further search_logs calls are blocked for this turn because this \
                 result added no new host-verified citeable events \
                 (fingerprint={evidence_fp}, union_size={}, attempts={}). \
                 Do not repeat search_logs. Synthesize from the evidence already retrieved, \
                 or refuse if it is insufficient. Reason: {reason_code}.",
                self.seen_union.len(),
                self.search_attempts
            );
            let trail_step = format!(
                "{reason_code}:attempts={};union={};fp={}",
                self.search_attempts,
                self.seen_union.len(),
                short_fp(&evidence_fp)
            );
            return BoundDecision::Stop {
                reason_code,
                model_message,
                trail_step,
            };
        }

        BoundDecision::Allow {
            new_event_count: 0,
            union_size: self.seen_union.len(),
        }
    }
}

fn short_fp(fp: &str) -> String {
    if fp.len() <= 48 {
        return fp.to_string();
    }
    format!("{}…", &fp[..48])
}

/// Build host citation chips from search evidence (never model prose).
pub fn citations_from_search_evidence(
    evidence: &[SearchEvidenceIdentity],
    max: usize,
) -> Vec<(String, String, Option<String>)> {
    use super::governed_citation::{format_governed_log_citation_id, GovernedLogCitationKind};
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for e in evidence {
        if out.len() >= max {
            break;
        }
        if e.source.is_empty() {
            continue;
        }
        let source_id =
            format_governed_log_citation_id(GovernedLogCitationKind::Event, e.seq);
        if !seen.insert(source_id.clone()) {
            continue;
        }
        let label = e.source.clone();
        let locator = Some(format!("log_template:{}", e.template_id));
        out.push((source_id, label, locator));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(seq: u64, source: &str) -> SearchEvidenceIdentity {
        SearchEvidenceIdentity {
            seq,
            source: source.into(),
            citation_source: None,
            template_id: 1,
        }
    }

    #[test]
    fn reordered_identical_event_sets_share_fingerprint() {
        let a = CiteableEvidenceSet::from_evidence(&[ev(2, "b.log"), ev(1, "a.log")]);
        let b = CiteableEvidenceSet::from_evidence(&[ev(1, "a.log"), ev(2, "b.log")]);
        assert_eq!(a.fingerprint(), b.fingerprint());
        assert_eq!(a.new_count_vs(&b), 0);
    }

    #[test]
    fn second_identical_search_stops_even_when_args_change() {
        let mut t = LinkedSearchProgressTracker::new();
        let evidence = vec![ev(10, "xyz/api.log"), ev(11, "xyz/worker.log")];
        let d1 = t.observe_search_logs(&json!({"query": "job", "k": 8}), &evidence, true);
        assert!(matches!(d1, BoundDecision::Allow { new_event_count: 2, .. }));

        let d2 = t.observe_search_logs(
            &json!({"query": "job-refined", "k": 16, "level": "error"}),
            &evidence,
            true,
        );
        match d2 {
            BoundDecision::Stop { reason_code, model_message, .. } => {
                assert!(
                    reason_code.contains("non_progress"),
                    "{reason_code}"
                );
                assert!(model_message.contains("HOST BOUND"));
                assert!(model_message.contains("Synthesize"));
            }
            other => panic!("expected Stop, got {other:?}"),
        }
    }

    #[test]
    fn overlap_plus_one_new_event_allows_continue() {
        let mut t = LinkedSearchProgressTracker::new();
        let first = vec![ev(1, "a.log"), ev(2, "b.log")];
        assert!(matches!(
            t.observe_search_logs(&json!({"query": "x"}), &first, true),
            BoundDecision::Allow { new_event_count: 2, .. }
        ));
        let second = vec![ev(2, "b.log"), ev(3, "c.log")];
        match t.observe_search_logs(&json!({"query": "x2"}), &second, true) {
            BoundDecision::Allow { new_event_count, union_size } => {
                assert_eq!(new_event_count, 1);
                assert_eq!(union_size, 3);
            }
            other => panic!("expected Allow, got {other:?}"),
        }
    }

    #[test]
    fn zero_hit_refinement_stops_without_infinite_loop() {
        let mut t = LinkedSearchProgressTracker::new();
        let d1 = t.observe_search_logs(&json!({"query": "nope"}), &[], true);
        assert!(
            matches!(d1, BoundDecision::Allow { new_event_count: 0, .. }),
            "first zero-hit is visible once: {d1:?}"
        );
        let d2 = t.observe_search_logs(&json!({"query": "nope2"}), &[], true);
        match d2 {
            BoundDecision::Stop { reason_code, .. } => {
                assert_eq!(reason_code, "linked_search_non_progress_zero_hits");
            }
            other => panic!("expected Stop on second zero-hit, got {other:?}"),
        }
    }

    #[test]
    fn first_productive_search_then_subset_stops() {
        let mut t = LinkedSearchProgressTracker::new();
        let full = vec![ev(1, "a.log"), ev(2, "b.log"), ev(3, "c.log")];
        t.observe_search_logs(&json!({}), &full, true);
        let subset = vec![ev(1, "a.log"), ev(2, "b.log")];
        match t.observe_search_logs(&json!({"query": "narrow"}), &subset, true) {
            BoundDecision::Stop { reason_code, .. } => {
                assert!(reason_code.contains("no_new_events") || reason_code.contains("non_progress"));
            }
            other => panic!("expected Stop on subset, got {other:?}"),
        }
    }

    #[test]
    fn intent_key_normalizes_whitespace_and_case() {
        let a = SearchIntentKey::from_search_logs_args(&json!({"query": "  Job  ", "level": "ERROR"}));
        let b = SearchIntentKey::from_search_logs_args(&json!({"level": "error", "query": "job"}));
        assert_eq!(a, b);
    }

    #[test]
    fn citations_from_evidence_are_governed_log_events() {
        let cites = citations_from_search_evidence(&[ev(42, "xyz/api.log")], 8);
        assert_eq!(cites.len(), 1);
        assert_eq!(cites[0].0, "log_event:42");
        assert_eq!(cites[0].1, "xyz/api.log");
    }

    #[test]
    fn citations_skip_empty_source_and_respect_max() {
        let mut many = Vec::new();
        for i in 0..10 {
            many.push(ev(i, &format!("s{i}.log")));
        }
        many.push(ev(99, ""));
        let cites = citations_from_search_evidence(&many, 3);
        assert_eq!(cites.len(), 3);
        assert!(cites.iter().all(|c| c.0.starts_with("log_event:")));
    }
}
