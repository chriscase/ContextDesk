//! Host-side bound for linked-log `search_logs` investigation loops.
//!
//! Detects **non-progress**: a successful or empty search that adds no new
//! host-verified citeable event identities versus the union already seen this
//! turn. Detection is pure (normalized tool intent + event fingerprint), never
//! demo-string matching.
//!
//! Policy:
//! - Exact or redundant identical result sets stop promptly.
//! - One **material** zero-hit or subset refinement (changed intent, no new
//!   citeable events) is allowed so the model can narrow once.
//! - Further no-progress after that is bounded.
//! - Overlap that surfaces at least one genuinely new `(seq, source)` remains
//!   allowed without consuming the material-refinement budget.

use std::collections::BTreeSet;

use serde_json::Value;

use super::SearchEvidenceIdentity;

/// How many materially changed zero-hit/subset refinements may run before Stop.
pub const MAX_MATERIAL_NO_PROGRESS_REFINEMENTS: u32 = 1;

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

    /// True when every identity in `self` is already in `prior` (including empty).
    pub fn is_subset_of(&self, prior: &Self) -> bool {
        self.identities
            .iter()
            .all(|id| prior.identities.contains(id))
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
        let candidate_k = args
            .get("candidate_k")
            .and_then(|v| v.as_u64())
            .map(|n| n.to_string())
            .unwrap_or_else(|| "-".into());
        let key = format!(
            "q={query}|lv={level}|svc={service}|tr={trace_id}|tf={time_from}|tt={time_to}|sem={semantic}|k={k}|candidate_k={candidate_k}"
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
    /// New citeable events, first attempt, or one allowed material refinement.
    Allow {
        /// How many identities were new vs prior union.
        new_event_count: usize,
        /// Total unique citeable identities after this result.
        union_size: usize,
    },
    /// Further `search_logs` is blocked for this turn.
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
    search_attempts: u32,
    /// Material zero-hit/subset refinements already consumed this turn.
    material_refinements_used: u32,
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
    /// `ok=false` with empty evidence still counts toward the bound so failed
    /// or missing-corpus retries cannot loop forever.
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
        let exact_repeat = self
            .last_intent
            .as_ref()
            .is_some_and(|prev| prev == &intent)
            && same_fp_as_last;

        let prev_intent = self.last_intent.replace(intent);
        let prev_fp = self.last_evidence_fp.replace(evidence_fp.clone());
        let _ = (prev_intent, prev_fp);

        if new_event_count > 0 {
            self.seen_union.extend_union(&current);
            return BoundDecision::Allow {
                new_event_count,
                union_size: self.seen_union.len(),
            };
        }

        // First search always proceeds (even zero-hit) so the model sees the
        // empty/result once.
        if self.search_attempts == 1 {
            return BoundDecision::Allow {
                new_event_count: 0,
                union_size: self.seen_union.len(),
            };
        }

        // Exact same intent+result, or any re-issue of the identical non-empty
        // result set (redundant "refined" args) → stop promptly.
        let redundant_identical_result = same_fp_as_last && !current.is_empty();
        if exact_repeat || redundant_identical_result {
            return self.stop(
                if exact_repeat {
                    "linked_search_non_progress_duplicate_result"
                } else {
                    "linked_search_non_progress_same_evidence_changed_args"
                },
                &evidence_fp,
            );
        }

        // Material refinement: intent changed and still no new citeable events
        // (zero-hit or strict subset of the union already seen).
        let is_material_refinement =
            intent_changed && (current.is_empty() || current.is_subset_of(&self.seen_union));
        if is_material_refinement
            && self.material_refinements_used < MAX_MATERIAL_NO_PROGRESS_REFINEMENTS
        {
            self.material_refinements_used = self.material_refinements_used.saturating_add(1);
            return BoundDecision::Allow {
                new_event_count: 0,
                union_size: self.seen_union.len(),
            };
        }

        let reason_code = if current.is_empty() {
            "linked_search_non_progress_zero_hits"
        } else if same_fp_as_last && intent_changed {
            "linked_search_non_progress_same_evidence_changed_args"
        } else {
            "linked_search_non_progress_no_new_events"
        };
        self.stop(reason_code, &evidence_fp)
    }

    fn stop(&self, reason_code: &'static str, evidence_fp: &str) -> BoundDecision {
        let model_message = format!(
            "HOST BOUND: further search_logs calls are blocked for this turn because this \
             result added no new host-verified citeable events \
             (fingerprint={evidence_fp}, union_size={}, attempts={}). \
             Do not repeat search_logs. Other tools (workspace search, memory, help) remain \
             available when offered. Synthesize from the evidence already retrieved, or refuse \
             if it is insufficient. Reason: {reason_code}.",
            self.seen_union.len(),
            self.search_attempts
        );
        let trail_step = format!(
            "{reason_code}:attempts={};union={};fp={}",
            self.search_attempts,
            self.seen_union.len(),
            short_fp(evidence_fp)
        );
        BoundDecision::Stop {
            reason_code,
            model_message,
            trail_step,
        }
    }
}

fn short_fp(fp: &str) -> String {
    let mut it = fp.chars();
    let head: String = it.by_ref().take(48).collect();
    if it.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// Build host citation chips from search evidence (never model prose).
/// Returns `(source_id, label, locator)` triples; callers attach host corpus_id.
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
        let source_id = format_governed_log_citation_id(GovernedLogCitationKind::Event, e.seq);
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
    fn exact_repeated_intent_and_result_stops_promptly() {
        let mut t = LinkedSearchProgressTracker::new();
        let evidence = vec![ev(10, "xyz/api.log"), ev(11, "xyz/worker.log")];
        let args = json!({"query": "job", "k": 8});
        assert!(matches!(
            t.observe_search_logs(&args, &evidence, true),
            BoundDecision::Allow {
                new_event_count: 2,
                ..
            }
        ));
        match t.observe_search_logs(&args, &evidence, true) {
            BoundDecision::Stop { reason_code, .. } => {
                assert_eq!(reason_code, "linked_search_non_progress_duplicate_result");
            }
            other => panic!("exact repeat must Stop promptly: {other:?}"),
        }
    }

    #[test]
    fn same_evidence_under_changed_args_stops_as_redundant() {
        let mut t = LinkedSearchProgressTracker::new();
        let evidence = vec![ev(10, "xyz/api.log"), ev(11, "xyz/worker.log")];
        let d1 = t.observe_search_logs(&json!({"query": "job", "k": 8}), &evidence, true);
        assert!(matches!(
            d1,
            BoundDecision::Allow {
                new_event_count: 2,
                ..
            }
        ));

        let d2 = t.observe_search_logs(
            &json!({"query": "job-refined", "k": 16, "level": "error"}),
            &evidence,
            true,
        );
        match d2 {
            BoundDecision::Stop {
                reason_code,
                model_message,
                ..
            } => {
                assert!(reason_code.contains("non_progress"), "{reason_code}");
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
            BoundDecision::Allow {
                new_event_count: 2,
                ..
            }
        ));
        let second = vec![ev(2, "b.log"), ev(3, "c.log")];
        match t.observe_search_logs(&json!({"query": "x2"}), &second, true) {
            BoundDecision::Allow {
                new_event_count,
                union_size,
            } => {
                assert_eq!(new_event_count, 1);
                assert_eq!(union_size, 3);
            }
            other => panic!("expected Allow, got {other:?}"),
        }
    }

    #[test]
    fn material_zero_hit_refinement_allowed_once_then_bounded() {
        let mut t = LinkedSearchProgressTracker::new();
        // First zero-hit: always visible.
        assert!(matches!(
            t.observe_search_logs(&json!({"query": "nope"}), &[], true),
            BoundDecision::Allow {
                new_event_count: 0,
                ..
            }
        ));
        // Materially changed zero-hit: allowed once.
        assert!(matches!(
            t.observe_search_logs(
                &json!({"query": "nope-refined", "level": "error"}),
                &[],
                true
            ),
            BoundDecision::Allow {
                new_event_count: 0,
                ..
            }
        ));
        // Further no-progress: bound.
        match t.observe_search_logs(&json!({"query": "nope-again"}), &[], true) {
            BoundDecision::Stop { reason_code, .. } => {
                assert_eq!(reason_code, "linked_search_non_progress_zero_hits");
            }
            other => panic!("expected Stop after one material refinement: {other:?}"),
        }
    }

    #[test]
    fn material_subset_refinement_allowed_once_then_bounded() {
        let mut t = LinkedSearchProgressTracker::new();
        let full = vec![ev(1, "a.log"), ev(2, "b.log"), ev(3, "c.log")];
        t.observe_search_logs(&json!({"query": "broad"}), &full, true);
        let subset = vec![ev(1, "a.log"), ev(2, "b.log")];
        // First material subset with changed intent: allow once.
        assert!(matches!(
            t.observe_search_logs(&json!({"query": "narrow"}), &subset, true),
            BoundDecision::Allow {
                new_event_count: 0,
                ..
            }
        ));
        // Second subset no-progress: stop.
        match t.observe_search_logs(&json!({"query": "narrower"}), &subset, true) {
            BoundDecision::Stop { reason_code, .. } => {
                assert!(
                    reason_code.contains("no_new_events") || reason_code.contains("non_progress"),
                    "{reason_code}"
                );
            }
            other => panic!("expected Stop on second subset: {other:?}"),
        }
    }

    #[test]
    fn exact_zero_hit_repeat_stops_without_consuming_material_budget_twice() {
        let mut t = LinkedSearchProgressTracker::new();
        let args = json!({"query": "absent", "level": "fatal"});
        t.observe_search_logs(&args, &[], true);
        match t.observe_search_logs(&args, &[], true) {
            BoundDecision::Stop { reason_code, .. } => {
                assert_eq!(reason_code, "linked_search_non_progress_duplicate_result");
            }
            other => panic!("exact zero-hit repeat must Stop: {other:?}"),
        }
    }

    #[test]
    fn intent_key_normalizes_whitespace_and_case() {
        let a =
            SearchIntentKey::from_search_logs_args(&json!({"query": "  Job  ", "level": "ERROR"}));
        let b = SearchIntentKey::from_search_logs_args(&json!({"level": "error", "query": "job"}));
        assert_eq!(a, b);
    }

    #[test]
    fn intent_key_distinguishes_candidate_pool_budget() {
        let narrow = SearchIntentKey::from_search_logs_args(
            &json!({"query": "job", "k": 3, "candidate_k": 3}),
        );
        let wide = SearchIntentKey::from_search_logs_args(
            &json!({"query": "job", "k": 3, "candidate_k": 10}),
        );
        assert_ne!(narrow, wide);
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

    #[test]
    fn host_bound_model_message_is_plain_text_not_json_envelope() {
        let mut t = LinkedSearchProgressTracker::new();
        let evidence = vec![ev(1, "a.log")];
        t.observe_search_logs(&json!({"query": "a"}), &evidence, true);
        match t.observe_search_logs(&json!({"query": "b"}), &evidence, true) {
            BoundDecision::Stop {
                model_message,
                reason_code,
                trail_step,
            } => {
                assert!(model_message.starts_with("HOST BOUND:"));
                assert!(!model_message.trim_start().starts_with('{'));
                assert!(!model_message.contains("\n{"));
                assert!(reason_code.starts_with("linked_search_non_progress"));
                assert!(trail_step.starts_with(reason_code));
            }
            other => panic!("expected Stop, got {other:?}"),
        }
    }

    #[test]
    fn cross_source_union_grows_when_new_source_appears() {
        let mut t = LinkedSearchProgressTracker::new();
        let api = vec![ev(1, "api.log"), ev(2, "api.log")];
        assert!(matches!(
            t.observe_search_logs(&json!({"query": "timeout"}), &api, true),
            BoundDecision::Allow { .. }
        ));
        let worker = vec![ev(1, "worker.log"), ev(2, "worker.log")];
        match t.observe_search_logs(
            &json!({"query": "timeout", "service": "worker"}),
            &worker,
            true,
        ) {
            BoundDecision::Allow {
                new_event_count,
                union_size,
            } => {
                assert_eq!(new_event_count, 2);
                assert_eq!(union_size, 4);
            }
            other => panic!("cross-source refinement must continue: {other:?}"),
        }
    }
}
