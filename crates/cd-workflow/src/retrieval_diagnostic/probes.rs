//! Bounded contract probes for the selected embedder and reranker.
//!
//! These answer questions a ranking metric cannot. A lane can score well while
//! the embedder quietly returns a different dimension count on the second
//! call, or while the reranker returns scores that are positional rather than
//! per-document — both of which make every downstream number meaningless
//! without changing it visibly. The probes run once per diagnostic, against
//! synthetic strings only, and never touch corpus text.
//!
//! Every probe is *measurement*, never a gate: a failed probe is reported and
//! marks the run degraded. Nothing here changes a default or a readiness store.

use serde::{Deserialize, Serialize};

use cd_core::embed::EmbedBackend;
use cd_core::embedding_space::EmbeddingSpaceIdentity;
use cd_core::rerank::{RerankBackend, RERANK_MAX_DOCUMENTS};

/// Synthetic probe inputs. Deliberately not corpus text: a probe must never
/// be a reason for content to leave the machine.
const PROBE_TEXTS: [&str; 3] = [
    "contextdesk retrieval diagnostic probe alpha",
    "contextdesk retrieval diagnostic probe beta",
    // Third input duplicates the first: a backend that is not deterministic
    // across duplicate inputs within one call cannot support stable recall.
    "contextdesk retrieval diagnostic probe alpha",
];

/// Measured vector-space behaviour of the selected embedder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VectorStabilityProbe {
    /// Whether the probe completed at all.
    pub executed: bool,
    /// Measured dimension count, when every returned vector agreed.
    pub dimensions: Option<u32>,
    /// Minimum and maximum L2 norm across returned vectors, rounded. A space
    /// whose norms vary wildly is not necessarily wrong, but cosine ranking
    /// over it behaves differently than over a normalized space, and a report
    /// that hides that is hiding the reason two lanes disagree.
    pub l2_norm_min: Option<f64>,
    /// See [`Self::l2_norm_min`].
    pub l2_norm_max: Option<f64>,
    /// Whether duplicate inputs inside one call produced identical vectors.
    pub duplicate_inputs_stable: Option<bool>,
    /// Whether a second call on the same inputs produced identical vectors.
    pub cross_call_stable: Option<bool>,
    /// Whether the second call agreed on dimension count. A cross-call
    /// dimension change silently invalidates every stored vector.
    pub cross_call_dimensions_stable: Option<bool>,
    /// Whether every component of every vector was finite.
    pub finite: Option<bool>,
    /// Typed space the probed backend declares.
    pub space_label: String,
    /// Stable fingerprint of that space.
    pub space_fingerprint: String,
    /// Share-safe failure reasons; empty when the probe fully succeeded.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<String>,
}

impl VectorStabilityProbe {
    /// Whether every measured property held.
    pub fn healthy(&self) -> bool {
        self.executed && self.findings.is_empty()
    }
}

fn l2_norm(vector: &[f32]) -> f64 {
    vector
        .iter()
        .map(|value| f64::from(*value) * f64::from(*value))
        .sum::<f64>()
        .sqrt()
}

/// Probe the embedder's vector-space stability with two bounded calls.
///
/// `run` bridges the async backend into the caller's runtime with whatever
/// budget the caller enforces, and returns `None` on failure or timeout.
pub fn probe_vector_stability(
    backend: &dyn EmbedBackend,
    space: &EmbeddingSpaceIdentity,
    mut run: impl FnMut(&[String]) -> Option<Vec<Vec<f32>>>,
) -> VectorStabilityProbe {
    let mut probe = VectorStabilityProbe {
        executed: false,
        dimensions: None,
        l2_norm_min: None,
        l2_norm_max: None,
        duplicate_inputs_stable: None,
        cross_call_stable: None,
        cross_call_dimensions_stable: None,
        finite: None,
        space_label: space.report_label(),
        space_fingerprint: space.fingerprint(),
        findings: Vec::new(),
    };
    let _ = backend;
    let inputs: Vec<String> = PROBE_TEXTS.iter().map(|text| text.to_string()).collect();

    let Some(first) = run(&inputs) else {
        probe
            .findings
            .push("embedding probe failed, was cancelled, or exceeded its budget".into());
        return probe;
    };
    probe.executed = true;
    if first.len() != inputs.len() {
        probe.findings.push(format!(
            "embedding returned {} vectors for {} inputs",
            first.len(),
            inputs.len()
        ));
        return probe;
    }

    let finite = first
        .iter()
        .all(|vector| vector.iter().all(|value| value.is_finite()));
    probe.finite = Some(finite);
    if !finite {
        probe
            .findings
            .push("embedding returned a non-finite component (NaN or infinity)".into());
    }

    let dims: std::collections::BTreeSet<usize> = first.iter().map(Vec::len).collect();
    if dims.len() == 1 {
        probe.dimensions = dims
            .iter()
            .next()
            .copied()
            .filter(|value| *value > 0)
            .and_then(|value| u32::try_from(value).ok());
        if probe.dimensions.is_none() {
            probe
                .findings
                .push("embedding returned empty vectors".into());
        }
    } else {
        probe.findings.push(format!(
            "embedding returned heterogeneous dimensions within one call: {dims:?}"
        ));
    }

    let norms: Vec<f64> = first.iter().map(|vector| l2_norm(vector)).collect();
    probe.l2_norm_min = norms
        .iter()
        .copied()
        .fold(None, |acc: Option<f64>, n| {
            Some(acc.map_or(n, |a| a.min(n)))
        })
        .map(super::metrics::round6);
    probe.l2_norm_max = norms
        .iter()
        .copied()
        .fold(None, |acc: Option<f64>, n| {
            Some(acc.map_or(n, |a| a.max(n)))
        })
        .map(super::metrics::round6);

    // Input 2 duplicates input 0.
    let duplicate_stable = first[0] == first[2];
    probe.duplicate_inputs_stable = Some(duplicate_stable);
    if !duplicate_stable {
        probe.findings.push(
            "identical inputs produced different vectors within one call; recall cannot be stable"
                .into(),
        );
    }

    let Some(second) = run(&inputs) else {
        probe
            .findings
            .push("second embedding call failed, was cancelled, or exceeded its budget".into());
        return probe;
    };
    let second_dims: std::collections::BTreeSet<usize> = second.iter().map(Vec::len).collect();
    let cross_call_dimensions_stable = second_dims == dims;
    probe.cross_call_dimensions_stable = Some(cross_call_dimensions_stable);
    if !cross_call_dimensions_stable {
        probe.findings.push(format!(
            "dimension count changed between calls ({dims:?} then {second_dims:?}); stored vectors \
             would be silently incomparable"
        ));
    }
    let cross_call_stable = first == second;
    probe.cross_call_stable = Some(cross_call_stable);
    if !cross_call_stable && cross_call_dimensions_stable {
        probe.findings.push(
            "the same inputs produced different vectors across calls; lane comparisons are not \
             reproducible"
                .into(),
        );
    }
    probe
}

/// Measured permutation and score semantics of the selected reranker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RerankSemanticsProbe {
    /// Whether the probe completed at all.
    pub executed: bool,
    /// Configured model identity.
    pub model: String,
    /// Explicit wire dialect the adapter declares — reported, never inferred.
    pub dialect: String,
    /// Whether the response carried exactly one finite score per document.
    pub complete_permutation: Option<bool>,
    /// Whether scores follow the DOCUMENT rather than its position: the same
    /// documents submitted in reverse order must produce the reversed score
    /// vector. A reranker that scores positionally silently ranks by input
    /// order, which looks like a working reranker and is not one.
    pub scores_follow_documents: Option<bool>,
    /// Whether a document placed beyond the final K can outscore the head, so
    /// a wider pool can actually promote it.
    pub promotes_beyond_k: Option<bool>,
    /// Share-safe failure reasons; empty when the probe fully succeeded.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub findings: Vec<String>,
}

impl RerankSemanticsProbe {
    /// Whether every measured property held.
    pub fn healthy(&self) -> bool {
        self.executed && self.findings.is_empty()
    }
}

/// Probe the reranker's permutation and score semantics with two bounded
/// calls over synthetic documents.
///
/// `run` bridges the async backend into the caller's runtime under the
/// caller's budget and returns `None` on failure, timeout, or cancellation.
pub fn probe_rerank_semantics(
    backend: &dyn RerankBackend,
    mut run: impl FnMut(&str, &[String]) -> Option<Vec<f32>>,
) -> RerankSemanticsProbe {
    let mut probe = RerankSemanticsProbe {
        executed: false,
        model: backend.identity(),
        dialect: backend.dialect().to_string(),
        complete_permutation: None,
        scores_follow_documents: None,
        promotes_beyond_k: None,
        findings: Vec::new(),
    };
    // The decisive document is deliberately LAST, so a positional reranker and
    // a document-aware one disagree.
    let query = "contextdesk retrieval diagnostic probe decisive marker";
    let documents: Vec<String> = vec![
        "unrelated filler row one".into(),
        "unrelated filler row two".into(),
        "unrelated filler row three".into(),
        "decisive marker row matching the probe query exactly".into(),
    ];
    debug_assert!(documents.len() <= RERANK_MAX_DOCUMENTS);

    let Some(forward) = run(query, &documents) else {
        probe
            .findings
            .push("rerank probe failed, was cancelled, or exceeded its budget".into());
        return probe;
    };
    probe.executed = true;
    let complete = forward.len() == documents.len() && forward.iter().all(|s| s.is_finite());
    probe.complete_permutation = Some(complete);
    if !complete {
        probe.findings.push(format!(
            "rerank returned {} finite scores for {} documents",
            forward.iter().filter(|s| s.is_finite()).count(),
            documents.len()
        ));
        return probe;
    }

    // The decisive row is last; a document-aware reranker scores it highest.
    let decisive = documents.len() - 1;
    let promotes = forward
        .iter()
        .enumerate()
        .all(|(index, score)| index == decisive || *score <= forward[decisive]);
    probe.promotes_beyond_k = Some(promotes);
    if !promotes {
        probe.findings.push(
            "the reranker did not score the decisive synthetic row highest; a wider candidate \
             pool cannot be relied on to promote a near miss"
                .into(),
        );
    }

    let reversed: Vec<String> = documents.iter().rev().cloned().collect();
    let Some(backward) = run(query, &reversed) else {
        probe.findings.push(
            "reversed-input rerank probe failed, was cancelled, or exceeded its budget".into(),
        );
        return probe;
    };
    if backward.len() != reversed.len() {
        probe
            .findings
            .push("reversed-input rerank returned a different score count".into());
        return probe;
    }
    let expected: Vec<f32> = forward.iter().rev().copied().collect();
    let follows = backward
        .iter()
        .zip(expected.iter())
        .all(|(actual, expected)| (actual - expected).abs() <= 1e-4);
    probe.scores_follow_documents = Some(follows);
    if !follows {
        probe.findings.push(
            "reversing the submitted documents did not reverse the scores; scores appear to \
             follow input POSITION rather than document content, so this stage is not reranking"
                .into(),
        );
    }
    probe
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::error::CoreResult;

    struct StubEmbed;

    #[async_trait::async_trait]
    impl EmbedBackend for StubEmbed {
        async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        }
        fn identity(&self) -> String {
            "stub".into()
        }
    }

    fn space() -> EmbeddingSpaceIdentity {
        EmbeddingSpaceIdentity::synthetic("stub").with_dimensions(Some(2))
    }

    #[test]
    fn a_stable_embedder_passes_every_measured_property() {
        let probe = probe_vector_stability(&StubEmbed, &space(), |texts| {
            Some(texts.iter().map(|_| vec![0.6, 0.8]).collect())
        });
        assert!(probe.healthy(), "{:?}", probe.findings);
        assert_eq!(probe.dimensions, Some(2));
        assert_eq!(probe.duplicate_inputs_stable, Some(true));
        assert_eq!(probe.cross_call_stable, Some(true));
        assert_eq!(probe.cross_call_dimensions_stable, Some(true));
        assert_eq!(probe.finite, Some(true));
        assert_eq!(probe.l2_norm_min, Some(1.0));
        assert_eq!(probe.l2_norm_max, Some(1.0));
    }

    #[test]
    fn cross_call_dimension_drift_is_caught() {
        let mut call = 0;
        let probe = probe_vector_stability(&StubEmbed, &space(), |texts| {
            call += 1;
            let dims = if call == 1 { 2 } else { 3 };
            Some(texts.iter().map(|_| vec![1.0; dims]).collect())
        });
        assert!(!probe.healthy());
        assert_eq!(probe.cross_call_dimensions_stable, Some(false));
        assert!(probe
            .findings
            .iter()
            .any(|finding| finding.contains("dimension count changed between calls")));
    }

    #[test]
    fn heterogeneous_dimensions_and_non_finite_components_are_caught() {
        let probe = probe_vector_stability(&StubEmbed, &space(), |texts| {
            Some(
                texts
                    .iter()
                    .enumerate()
                    .map(|(index, _)| vec![1.0; index + 1])
                    .collect(),
            )
        });
        assert!(probe
            .findings
            .iter()
            .any(|finding| finding.contains("heterogeneous dimensions")));
        assert!(probe.dimensions.is_none());

        let nan = probe_vector_stability(&StubEmbed, &space(), |texts| {
            Some(texts.iter().map(|_| vec![f32::NAN, 1.0]).collect())
        });
        assert_eq!(nan.finite, Some(false));
        assert!(nan
            .findings
            .iter()
            .any(|finding| finding.contains("non-finite")));
    }

    #[test]
    fn unstable_duplicates_and_a_failed_call_are_caught() {
        let mut index = 0u32;
        let unstable = probe_vector_stability(&StubEmbed, &space(), |texts| {
            Some(
                texts
                    .iter()
                    .map(|_| {
                        index += 1;
                        vec![index as f32, 1.0]
                    })
                    .collect(),
            )
        });
        assert_eq!(unstable.duplicate_inputs_stable, Some(false));

        let failed = probe_vector_stability(&StubEmbed, &space(), |_| None);
        assert!(!failed.executed);
        assert!(failed
            .findings
            .iter()
            .any(|finding| finding.contains("failed, was cancelled")));
    }

    struct StubRerank(&'static str);

    #[async_trait::async_trait]
    impl RerankBackend for StubRerank {
        async fn rerank(&self, _query: &str, documents: &[String]) -> CoreResult<Vec<f32>> {
            Ok(vec![0.0; documents.len()])
        }
        fn identity(&self) -> String {
            "stub-rerank".into()
        }
        fn dialect(&self) -> &'static str {
            self.0
        }
    }

    /// Score by content: the decisive row wins wherever it sits.
    fn document_aware(_query: &str, documents: &[String]) -> Option<Vec<f32>> {
        Some(
            documents
                .iter()
                .map(|document| {
                    if document.contains("decisive marker") {
                        0.99
                    } else {
                        0.10
                    }
                })
                .collect(),
        )
    }

    #[test]
    fn a_document_aware_reranker_passes_every_measured_property() {
        let probe = probe_rerank_semantics(&StubRerank("tei_rerank_v1"), document_aware);
        assert!(probe.healthy(), "{:?}", probe.findings);
        assert_eq!(probe.complete_permutation, Some(true));
        assert_eq!(probe.scores_follow_documents, Some(true));
        assert_eq!(probe.promotes_beyond_k, Some(true));
        assert_eq!(
            probe.dialect, "tei_rerank_v1",
            "the dialect is reported from the adapter, never inferred"
        );
    }

    #[test]
    fn a_positional_reranker_is_caught_by_the_reversed_input_probe() {
        // Scores decrease with position regardless of content — indistinguishable
        // from a working reranker until the inputs are reversed.
        let positional = |_query: &str, documents: &[String]| {
            Some(
                (0..documents.len())
                    .map(|index| 1.0 - index as f32 * 0.1)
                    .collect(),
            )
        };
        let probe = probe_rerank_semantics(&StubRerank("tei_rerank_v1"), positional);
        assert_eq!(probe.scores_follow_documents, Some(false));
        assert!(!probe.healthy());
        assert!(probe
            .findings
            .iter()
            .any(|finding| finding.contains("input POSITION")));
    }

    #[test]
    fn incomplete_and_failed_rerank_responses_are_caught() {
        let short = probe_rerank_semantics(&StubRerank("tei_rerank_v1"), |_, documents| {
            Some(vec![0.5; documents.len().saturating_sub(1)])
        });
        assert_eq!(short.complete_permutation, Some(false));
        assert!(!short.healthy());

        let nan = probe_rerank_semantics(&StubRerank("tei_rerank_v1"), |_, documents| {
            let mut scores = vec![0.5; documents.len()];
            scores[0] = f32::NAN;
            Some(scores)
        });
        assert_eq!(nan.complete_permutation, Some(false));

        let failed = probe_rerank_semantics(&StubRerank("tei_rerank_v1"), |_, _| None);
        assert!(!failed.executed);
        assert!(!failed.healthy());
    }
}
