//! Deterministic retrieval metrics for quality evaluation.
//!
//! Fail closed on invalid rankings: never invent credit for empty, duplicate,
//! or unknown-id result lists.

use super::types::{failure_reason, LaneStatus, QueryTruth, RetrievalMetrics, RetrievalRanking};
use std::collections::{BTreeSet, HashSet};

/// Round to six decimals for cross-platform golden stability.
pub fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn dcg(gains: &[u8]) -> f64 {
    gains
        .iter()
        .enumerate()
        .map(|(index, gain)| f64::from(*gain) / ((index as f64) + 2.0).log2())
        .sum()
}

/// Validate a ranking against the known document universe.
///
/// Returns typed failure reasons; empty means the ranking is structurally valid.
pub fn validate_ranking(ranking: &RetrievalRanking, known_ids: &BTreeSet<String>) -> Vec<String> {
    let mut reasons = Vec::new();
    if ranking.ranked_ids.is_empty() {
        reasons.push(failure_reason::EMPTY_RANKING.to_string());
        return reasons;
    }
    let mut seen = HashSet::new();
    for id in &ranking.ranked_ids {
        if !seen.insert(id.as_str()) {
            reasons.push(failure_reason::DUPLICATE_RANK_IDS.to_string());
            break;
        }
    }
    if ranking
        .ranked_ids
        .iter()
        .any(|id| !known_ids.contains(id.as_str()))
    {
        reasons.push(failure_reason::UNKNOWN_RANK_IDS.to_string());
    }
    if let Some(upstream) = &ranking.upstream_ranked_ids {
        let mut up_seen = HashSet::new();
        for id in upstream {
            if !up_seen.insert(id.as_str()) {
                reasons.push(failure_reason::DUPLICATE_RANK_IDS.to_string());
                break;
            }
        }
        if upstream.iter().any(|id| !known_ids.contains(id.as_str())) {
            reasons.push(failure_reason::UNKNOWN_RANK_IDS.to_string());
        }
    }
    reasons.sort();
    reasons.dedup();
    reasons
}

fn recall_at(ranked: &[String], relevant: &BTreeSet<&str>, k: usize) -> f64 {
    if relevant.is_empty() {
        // Empty truth: perfect recall of "nothing required" only if ranking valid.
        return 1.0;
    }
    if ranked.is_empty() || k == 0 {
        return 0.0;
    }
    let top: BTreeSet<&str> = ranked.iter().take(k).map(String::as_str).collect();
    let hits = relevant.iter().filter(|id| top.contains(*id)).count();
    round6(hits as f64 / relevant.len() as f64)
}

fn mrr(ranked: &[String], relevant: &BTreeSet<&str>) -> f64 {
    if relevant.is_empty() {
        return 0.0;
    }
    for (idx, id) in ranked.iter().enumerate() {
        if relevant.contains(id.as_str()) {
            return round6(1.0 / (idx as f64 + 1.0));
        }
    }
    0.0
}

fn ndcg_at(
    ranked: &[String],
    relevant: &BTreeSet<&str>,
    gains: &std::collections::BTreeMap<String, u8>,
    k: usize,
) -> f64 {
    if relevant.is_empty() || k == 0 {
        return 0.0;
    }
    let mut gains_in_order = Vec::new();
    let mut credited = BTreeSet::new();
    for id in ranked.iter().take(k) {
        if relevant.contains(id.as_str()) && credited.insert(id.as_str()) {
            let gain = gains.get(id).copied().unwrap_or(1);
            gains_in_order.push(gain);
        } else {
            gains_in_order.push(0);
        }
    }
    let mut ideal: Vec<u8> = relevant
        .iter()
        .map(|id| gains.get(*id).copied().unwrap_or(1))
        .collect();
    ideal.sort_unstable_by(|a, b| b.cmp(a));
    ideal.truncate(k);
    let ideal_dcg = dcg(&ideal);
    if ideal_dcg == 0.0 {
        return 0.0;
    }
    round6((dcg(&gains_in_order) / ideal_dcg).clamp(0.0, 1.0))
}

fn must_include_recall(ranked: &[String], must: &[String], k: usize) -> f64 {
    if must.is_empty() {
        return 1.0;
    }
    let top: BTreeSet<&str> = ranked.iter().take(k).map(String::as_str).collect();
    let hits = must.iter().filter(|id| top.contains(id.as_str())).count();
    round6(hits as f64 / must.len() as f64)
}

fn must_exclude_rate(ranked: &[String], exclude: &[String], k: usize) -> f64 {
    if k == 0 || ranked.is_empty() {
        return 0.0;
    }
    let take = k.min(ranked.len());
    if take == 0 {
        return 0.0;
    }
    let exclude_set: BTreeSet<&str> = exclude.iter().map(String::as_str).collect();
    let hits = ranked
        .iter()
        .take(take)
        .filter(|id| exclude_set.contains(id.as_str()))
        .count();
    round6(hits as f64 / take as f64)
}

fn foreign_hits(ranked: &[String], foreign: &[String], k: usize) -> u64 {
    let foreign_set: BTreeSet<&str> = foreign.iter().map(String::as_str).collect();
    ranked
        .iter()
        .take(k)
        .filter(|id| foreign_set.contains(id.as_str()))
        .count() as u64
}

/// Score one ranking against host query truth.
pub fn score_retrieval(
    truth: &QueryTruth,
    ranking: &RetrievalRanking,
    known_ids: &BTreeSet<String>,
) -> RetrievalMetrics {
    let mut failure_reasons = validate_ranking(ranking, known_ids);
    if ranking.query_id != truth.query_id {
        failure_reasons.push(failure_reason::INVALID_RANKING.to_string());
    }
    failure_reasons.sort();
    failure_reasons.dedup();

    if !failure_reasons.is_empty() {
        return RetrievalMetrics {
            query_id: truth.query_id.clone(),
            recall_at_k: 0.0,
            mrr: 0.0,
            ndcg_at_k: 0.0,
            must_include_recall: 0.0,
            must_exclude_rate: 0.0,
            foreign_incident_hits: 0,
            upstream_recall_at_k: None,
            final_recall_at_k: None,
            status: LaneStatus::Failed,
            failure_reasons,
        };
    }

    let k = ranking.k.unwrap_or(truth.top_k).max(1) as usize;
    let k = k.min(ranking.ranked_ids.len().max(1));
    let relevant: BTreeSet<&str> = truth.relevant_ids.iter().map(String::as_str).collect();

    // Empty relevant + non-empty ranking is valid (negative query); recall=1, mrr=0.
    let recall = recall_at(&ranking.ranked_ids, &relevant, k);
    let mrr_v = mrr(&ranking.ranked_ids, &relevant);
    let ndcg = ndcg_at(&ranking.ranked_ids, &relevant, &truth.graded_gains, k);
    let mi = must_include_recall(&ranking.ranked_ids, &truth.must_include_ids, k);
    let me = must_exclude_rate(&ranking.ranked_ids, &truth.must_exclude_ids, k);
    let foreign = foreign_hits(&ranking.ranked_ids, &truth.foreign_incident_ids, k);

    let (upstream_recall, final_recall) = if let Some(upstream) = &ranking.upstream_ranked_ids {
        let uk = k.min(upstream.len().max(1));
        (Some(recall_at(upstream, &relevant, uk)), Some(recall))
    } else {
        (None, None)
    };

    RetrievalMetrics {
        query_id: truth.query_id.clone(),
        recall_at_k: recall,
        mrr: mrr_v,
        ndcg_at_k: ndcg,
        must_include_recall: mi,
        must_exclude_rate: me,
        foreign_incident_hits: foreign,
        upstream_recall_at_k: upstream_recall,
        final_recall_at_k: final_recall,
        status: LaneStatus::Executed,
        failure_reasons: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn known(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }

    fn truth_with(relevant: &[&str], must_in: &[&str], must_ex: &[&str]) -> QueryTruth {
        QueryTruth {
            query_id: "q1".into(),
            question: "why?".into(),
            relevant_ids: relevant.iter().map(|s| (*s).to_string()).collect(),
            graded_gains: BTreeMap::new(),
            must_include_ids: must_in.iter().map(|s| (*s).to_string()).collect(),
            must_exclude_ids: must_ex.iter().map(|s| (*s).to_string()).collect(),
            foreign_incident_ids: must_ex.iter().map(|s| (*s).to_string()).collect(),
            top_k: 3,
        }
    }

    #[test]
    fn perfect_ranking_scores_one() {
        let t = truth_with(&["a", "b"], &["a"], &["x"]);
        let r = RetrievalRanking {
            query_id: "q1".into(),
            ranked_ids: vec!["a".into(), "b".into(), "c".into()],
            upstream_ranked_ids: None,
            k: Some(3),
        };
        let m = score_retrieval(&t, &r, &known(&["a", "b", "c", "x"]));
        assert_eq!(m.status, LaneStatus::Executed);
        assert!((m.recall_at_k - 1.0).abs() < 1e-9);
        assert!((m.mrr - 1.0).abs() < 1e-9);
        assert!((m.must_include_recall - 1.0).abs() < 1e-9);
        assert!((m.must_exclude_rate - 0.0).abs() < 1e-9);
    }

    #[test]
    fn duplicate_ids_fail_closed() {
        let t = truth_with(&["a"], &["a"], &[]);
        let r = RetrievalRanking {
            query_id: "q1".into(),
            ranked_ids: vec!["a".into(), "a".into()],
            upstream_ranked_ids: None,
            k: Some(2),
        };
        let m = score_retrieval(&t, &r, &known(&["a"]));
        assert_eq!(m.status, LaneStatus::Failed);
        assert!(m
            .failure_reasons
            .iter()
            .any(|r| r == failure_reason::DUPLICATE_RANK_IDS));
        assert_eq!(m.recall_at_k, 0.0);
    }

    #[test]
    fn unknown_ids_fail_closed() {
        let t = truth_with(&["a"], &[], &[]);
        let r = RetrievalRanking {
            query_id: "q1".into(),
            ranked_ids: vec!["ghost".into()],
            upstream_ranked_ids: None,
            k: Some(1),
        };
        let m = score_retrieval(&t, &r, &known(&["a"]));
        assert_eq!(m.status, LaneStatus::Failed);
        assert!(m
            .failure_reasons
            .iter()
            .any(|r| r == failure_reason::UNKNOWN_RANK_IDS));
    }

    #[test]
    fn empty_ranking_fails() {
        let t = truth_with(&["a"], &["a"], &[]);
        let r = RetrievalRanking {
            query_id: "q1".into(),
            ranked_ids: vec![],
            upstream_ranked_ids: None,
            k: Some(1),
        };
        let m = score_retrieval(&t, &r, &known(&["a"]));
        assert_eq!(m.status, LaneStatus::Failed);
        assert!(m
            .failure_reasons
            .iter()
            .any(|r| r == failure_reason::EMPTY_RANKING));
    }

    #[test]
    fn empty_truth_recall_is_one_on_valid_list() {
        let t = truth_with(&[], &[], &[]);
        let r = RetrievalRanking {
            query_id: "q1".into(),
            ranked_ids: vec!["noise".into()],
            upstream_ranked_ids: None,
            k: Some(1),
        };
        let m = score_retrieval(&t, &r, &known(&["noise"]));
        assert_eq!(m.status, LaneStatus::Executed);
        assert!((m.recall_at_k - 1.0).abs() < 1e-9);
        assert_eq!(m.mrr, 0.0);
    }

    #[test]
    fn upstream_versus_final_recall_separated() {
        let t = truth_with(&["a", "b"], &["a"], &[]);
        let r = RetrievalRanking {
            query_id: "q1".into(),
            ranked_ids: vec!["a".into(), "c".into()],
            upstream_ranked_ids: Some(vec!["a".into(), "b".into(), "c".into()]),
            k: Some(2),
        };
        let m = score_retrieval(&t, &r, &known(&["a", "b", "c"]));
        assert_eq!(m.status, LaneStatus::Executed);
        let up = m.upstream_recall_at_k.expect("upstream");
        let fin = m.final_recall_at_k.expect("final");
        // upstream has both a,b in top-2; final has only a in top-2
        assert!((up - 1.0).abs() < 1e-9);
        assert!((fin - 0.5).abs() < 1e-9);
    }

    #[test]
    fn foreign_incident_hits_counted() {
        let t = truth_with(&["a"], &["a"], &["x"]);
        let r = RetrievalRanking {
            query_id: "q1".into(),
            ranked_ids: vec!["a".into(), "x".into()],
            upstream_ranked_ids: None,
            k: Some(2),
        };
        let m = score_retrieval(&t, &r, &known(&["a", "x"]));
        assert_eq!(m.foreign_incident_hits, 1);
        assert!((m.must_exclude_rate - 0.5).abs() < 1e-9);
    }
}
