//! Deterministic retrieval-quality metrics over one ranked lane result.
//!
//! Every metric here is a property of the **ranking** against host-owned
//! truth. None of them says anything about whether an answer built from that
//! ranking was useful: that is a different measurement with a different
//! failure mode, and mixing the two is how a retrieval regression hides
//! behind a good-looking answer. The report keeps them in separate sections
//! for exactly that reason.
//!
//! Truth is expressed as durable event `seq` identities, never as message
//! text, so a metric cannot be satisfied by a row that merely reads similarly.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Round to six decimals so two runs of the same deterministic lane produce
/// byte-identical reports.
pub fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

/// Host-owned truth for one diagnostic query.
///
/// `mandatory_anchor_seqs` is deliberately separate from `relevant_seqs`: an
/// aggregate recall of 0.8 is a fine score and still a broken retrieval if the
/// one row that establishes the timeline is the row that was dropped.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryTruth {
    /// Rows that count toward recall/nDCG/MRR.
    #[serde(default)]
    pub relevant_seqs: BTreeSet<u64>,
    /// Graded gains for nDCG; absent ids default to gain 1.
    #[serde(default)]
    pub graded_gains: BTreeMap<u64, u8>,
    /// Rows that MUST appear in top-K for the result to be usable at all.
    #[serde(default)]
    pub mandatory_anchor_seqs: BTreeSet<u64>,
    /// Rows that look relevant but belong to a different incident. Their
    /// presence in top-K is contamination, not a near miss.
    #[serde(default)]
    pub decoy_seqs: BTreeSet<u64>,
}

/// Deterministic metrics for one ranked lane result against [`QueryTruth`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RankingMetrics {
    /// Query this row scores.
    pub query_id: String,
    /// K actually applied when scoring.
    pub k: u32,
    /// Rows returned (may be fewer than K).
    pub returned: u32,
    /// Fraction of `relevant_seqs` present in top-K.
    pub recall_at_k: f64,
    /// Reciprocal rank of the first relevant row (0 when none).
    pub mrr: f64,
    /// Graded nDCG at K.
    pub ndcg_at_k: f64,
    /// Fraction of `mandatory_anchor_seqs` present in top-K. Reported
    /// separately from recall because losing one is a different failure.
    pub mandatory_anchor_retention: f64,
    /// Mandatory anchors that are missing, by seq — named, never just counted.
    pub missing_mandatory_anchors: Vec<u64>,
    /// Fraction of top-K rows that are decoys.
    pub decoy_contamination: f64,
    /// Decoy rows present in top-K, by seq.
    pub decoys_returned: Vec<u64>,
    /// True when the ranking itself was structurally invalid (duplicate ids).
    /// An invalid ranking scores zero and says so rather than being silently
    /// deduplicated into a better number.
    pub invalid_ranking: bool,
}

/// Score one ranked list of event seqs against host truth.
///
/// A duplicate id makes the ranking structurally invalid: deduplicating it
/// would score a broken lane as if it had returned distinct evidence.
pub fn score_ranking(
    query_id: &str,
    ranked_seqs: &[u64],
    truth: &QueryTruth,
    k: u32,
) -> RankingMetrics {
    let k_usize = k as usize;
    let top: Vec<u64> = ranked_seqs.iter().copied().take(k_usize).collect();
    let unique: BTreeSet<u64> = top.iter().copied().collect();
    let invalid_ranking = unique.len() != top.len();

    if invalid_ranking {
        return RankingMetrics {
            query_id: query_id.to_string(),
            k,
            returned: top.len() as u32,
            recall_at_k: 0.0,
            mrr: 0.0,
            ndcg_at_k: 0.0,
            mandatory_anchor_retention: 0.0,
            missing_mandatory_anchors: truth.mandatory_anchor_seqs.iter().copied().collect(),
            decoy_contamination: 0.0,
            decoys_returned: Vec::new(),
            invalid_ranking: true,
        };
    }

    let hits = truth
        .relevant_seqs
        .iter()
        .filter(|seq| unique.contains(seq))
        .count();
    let recall_at_k = if truth.relevant_seqs.is_empty() {
        // No relevant rows declared: recall is undefined, and 1.0 would be a
        // free pass. Report 0 and let the anchor/decoy rows carry the verdict.
        0.0
    } else {
        hits as f64 / truth.relevant_seqs.len() as f64
    };

    let mrr = top
        .iter()
        .position(|seq| truth.relevant_seqs.contains(seq))
        .map(|index| 1.0 / (index as f64 + 1.0))
        .unwrap_or(0.0);

    let gain = |seq: &u64| -> f64 {
        if !truth.relevant_seqs.contains(seq) {
            return 0.0;
        }
        f64::from(truth.graded_gains.get(seq).copied().unwrap_or(1))
    };
    let dcg: f64 = top
        .iter()
        .enumerate()
        .map(|(index, seq)| gain(seq) / ((index as f64 + 2.0).log2()))
        .sum();
    let mut ideal_gains: Vec<f64> = truth.relevant_seqs.iter().map(gain).collect();
    ideal_gains.sort_by(|a, b| b.total_cmp(a));
    let idcg: f64 = ideal_gains
        .into_iter()
        .take(k_usize)
        .enumerate()
        .map(|(index, gain)| gain / ((index as f64 + 2.0).log2()))
        .sum();
    let ndcg_at_k = if idcg > 0.0 { dcg / idcg } else { 0.0 };

    let missing_mandatory_anchors: Vec<u64> = truth
        .mandatory_anchor_seqs
        .iter()
        .copied()
        .filter(|seq| !unique.contains(seq))
        .collect();
    let mandatory_anchor_retention = if truth.mandatory_anchor_seqs.is_empty() {
        // Nothing was declared mandatory, so nothing was lost.
        1.0
    } else {
        let kept = truth.mandatory_anchor_seqs.len() - missing_mandatory_anchors.len();
        kept as f64 / truth.mandatory_anchor_seqs.len() as f64
    };

    let decoys_returned: Vec<u64> = top
        .iter()
        .copied()
        .filter(|seq| truth.decoy_seqs.contains(seq))
        .collect();
    let decoy_contamination = if top.is_empty() {
        0.0
    } else {
        decoys_returned.len() as f64 / top.len() as f64
    };

    RankingMetrics {
        query_id: query_id.to_string(),
        k,
        returned: top.len() as u32,
        recall_at_k: round6(recall_at_k),
        mrr: round6(mrr),
        ndcg_at_k: round6(ndcg_at_k),
        mandatory_anchor_retention: round6(mandatory_anchor_retention),
        missing_mandatory_anchors,
        decoy_contamination: round6(decoy_contamination),
        decoys_returned,
        invalid_ranking: false,
    }
}

/// Mean of a metric across query rows, or `None` when there are no rows.
/// Never fabricates a zero for "nothing measured".
pub fn mean(values: impl IntoIterator<Item = f64>) -> Option<f64> {
    let values: Vec<f64> = values.into_iter().collect();
    if values.is_empty() {
        return None;
    }
    Some(round6(values.iter().sum::<f64>() / values.len() as f64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn truth() -> QueryTruth {
        QueryTruth {
            relevant_seqs: [10, 20, 30].into_iter().collect(),
            graded_gains: [(10, 3), (20, 2), (30, 1)].into_iter().collect(),
            mandatory_anchor_seqs: [10].into_iter().collect(),
            decoy_seqs: [99].into_iter().collect(),
        }
    }

    #[test]
    fn a_perfect_ranking_scores_one_across_the_board() {
        let metrics = score_ranking("q1", &[10, 20, 30], &truth(), 3);
        assert_eq!(metrics.recall_at_k, 1.0);
        assert_eq!(metrics.mrr, 1.0);
        assert_eq!(metrics.ndcg_at_k, 1.0);
        assert_eq!(metrics.mandatory_anchor_retention, 1.0);
        assert_eq!(metrics.decoy_contamination, 0.0);
        assert!(metrics.missing_mandatory_anchors.is_empty());
        assert!(!metrics.invalid_ranking);
    }

    #[test]
    fn a_lost_mandatory_anchor_is_reported_separately_from_recall() {
        // Two of three relevant rows retrieved: a respectable 0.667 recall
        // that is nevertheless unusable, because the mandatory row is gone.
        let metrics = score_ranking("q1", &[20, 30], &truth(), 3);
        assert_eq!(metrics.recall_at_k, round6(2.0 / 3.0));
        assert_eq!(metrics.mandatory_anchor_retention, 0.0);
        assert_eq!(
            metrics.missing_mandatory_anchors,
            vec![10],
            "the missing anchor is named, not just counted"
        );
    }

    #[test]
    fn decoys_are_contamination_not_a_near_miss() {
        let metrics = score_ranking("q1", &[10, 99], &truth(), 2);
        assert_eq!(metrics.decoy_contamination, 0.5);
        assert_eq!(metrics.decoys_returned, vec![99]);
        // Recall is unaffected by the decoy; the two facts stay independent.
        assert_eq!(metrics.recall_at_k, round6(1.0 / 3.0));
    }

    #[test]
    fn a_duplicate_id_invalidates_the_ranking_instead_of_scoring_well() {
        let metrics = score_ranking("q1", &[10, 10, 20], &truth(), 3);
        assert!(metrics.invalid_ranking);
        assert_eq!(metrics.recall_at_k, 0.0);
        assert_eq!(metrics.ndcg_at_k, 0.0);
        assert_eq!(metrics.mrr, 0.0);
        assert_eq!(
            metrics.mandatory_anchor_retention, 0.0,
            "an invalid ranking retains nothing, even when the row is present"
        );
    }

    #[test]
    fn k_truncates_before_scoring() {
        // Rank 3 holds the only mandatory anchor; K=2 must not see it.
        let metrics = score_ranking("q1", &[20, 30, 10], &truth(), 2);
        assert_eq!(metrics.returned, 2);
        assert_eq!(metrics.mandatory_anchor_retention, 0.0);
        assert_eq!(metrics.mrr, 1.0, "rank 1 is relevant");
    }

    #[test]
    fn ndcg_rewards_the_graded_order() {
        let ordered = score_ranking("q1", &[10, 20, 30], &truth(), 3).ndcg_at_k;
        let reversed = score_ranking("q1", &[30, 20, 10], &truth(), 3).ndcg_at_k;
        assert!(
            ordered > reversed,
            "graded gains must reward putting the decisive row first: {ordered} vs {reversed}"
        );
    }

    #[test]
    fn undeclared_truth_never_becomes_a_free_pass() {
        let empty = QueryTruth::default();
        let metrics = score_ranking("q1", &[1, 2, 3], &empty, 3);
        assert_eq!(
            metrics.recall_at_k, 0.0,
            "undefined recall must not report as perfect"
        );
        assert_eq!(
            metrics.mandatory_anchor_retention, 1.0,
            "nothing was declared mandatory, so nothing was lost"
        );
        assert!(mean(Vec::<f64>::new()).is_none(), "no rows means unknown");
        assert_eq!(mean([1.0, 2.0]), Some(1.5));
    }
}
