//! Deterministic, bounded **classification** of the host's already-assembled
//! evidence neighborhood.
//!
//! # Audit: what the existing production seam already supplies
//!
//! This module deliberately adds **no** retrieval and **no** second assembler.
//! [`crate::tool_host`]'s `broad_triage_comparison_context` already performs the
//! bounded neighborhood expansion, and the fast route reuses its output as-is:
//!
//! | Requirement | Already supplied by the existing seam | What this module adds |
//! | --- | --- | --- |
//! | focus evidence | candidate groups (`BroadLogTriageCandidate`) built from the structural error/fatal admission | marks them [`FastTriageEvidenceCategory::Focus`] |
//! | same-source before/after context | ±`BROAD_LOG_TRIAGE_COMPARISON_NEIGHBOR_RADIUS` sequence neighbors around each candidate's first and last row | splits them into [`FastTriageEvidenceCategory::PrecedingSameSource`] / [`FastTriageEvidenceCategory::FollowingSameSource`] |
//! | cross-source temporal context | the same neighbor rows, which may come from any source | admits them only under [`FastTriageClockCompatibility::ResolvedComparable`]; otherwise withholds the *temporal* reading |
//! | trace / request links | trace-correlation candidate grouping (`parser_true_trace_correlation_groups…`) | marks [`FastTriageEvidenceCategory::TraceLinked`] and [`FastTriageEvidenceCategory::Propagation`] |
//! | preceding configuration / deployment anchors | the same-source preceding window | surfaces them positionally; the host never asserts a row *is* a configuration change |
//! | propagation | trace grouping across sources | ordinal + source split into [`FastTriageEvidenceCategory::Propagation`] |
//! | contradiction / independent noise | the separately scoped `global_timeline_context`, already documented as "adjacency and order do not establish correlation or causality" | marks [`FastTriageEvidenceCategory::IndependentNoise`] |
//! | rollback / recovery anchors | the same-source following window | surfaces them positionally, same honesty caveat as configuration anchors |
//! | bounded expansion | endpoint cap 6, radius 2, whole-context cap 32, stable ordering | applies its own deterministic per-category cap and reports truncation |
//!
//! # Three invariants
//!
//! * **Adjacency is never causality.** A category says where a row sits, never
//!   what it caused. Nothing in the vocabulary can express "because".
//! * **Order-only records are never wall-clock events.** A cross-source
//!   temporal reading requires the host to have resolved comparable clocks. The
//!   default is fail-closed, and mixed quality is not comparable.
//! * **Expansion is never unbounded.** Every category is capped, the ordering is
//!   total, and what falls outside a cap is *reported*, not silently dropped.

use std::collections::{BTreeMap, BTreeSet};

use crate::log_analysis::TimeQuality;

use super::packet::FastTriageEvidenceScope;

/// Whether the host may read two sources' records as comparable wall-clock
/// events.
///
/// Fail-closed by construction: only a corpus the host resolved as wall-clock
/// throughout is comparable. `Mixed` is not — a mixed corpus is exactly the
/// case where some records carry real time and some carry sequence order, and
/// comparing across that boundary is the mistake this gate exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageClockCompatibility {
    /// The host resolved comparable wall-clock time across sources.
    ResolvedComparable,
    /// Order is known; wall-clock comparison across sources is not justified.
    OrderOnly,
}

impl FastTriageClockCompatibility {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ResolvedComparable => "resolved_comparable",
            Self::OrderOnly => "order_only",
        }
    }
}

/// Derive clock compatibility from the host's own time-quality verdict.
///
/// `Mixed` deliberately maps to [`FastTriageClockCompatibility::OrderOnly`]:
/// "some sources have wall clocks" is not "these two sources are comparable".
pub fn clock_compatibility_from_time_quality(quality: TimeQuality) -> FastTriageClockCompatibility {
    match quality {
        TimeQuality::Wall => FastTriageClockCompatibility::ResolvedComparable,
        TimeQuality::Mixed | TimeQuality::OrderOnly => FastTriageClockCompatibility::OrderOnly,
    }
}

/// What the host can prove about one row's place in the neighborhood.
///
/// Every variant is positional, structural, or link-based. None of them asserts
/// meaning, and none of them can be read as a causal statement.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageEvidenceCategory {
    /// The host's own focus selection for a candidate group.
    Focus,
    /// Same source as a focus row and earlier, inside the bounded radius. A
    /// preceding configuration or deployment anchor appears here when one
    /// exists; the host marks the position, never the meaning.
    PrecedingSameSource,
    /// Same source as a focus row and later, inside the bounded radius. A
    /// rollback or recovery anchor appears here when one exists; same caveat.
    FollowingSameSource,
    /// A different source than any focus row, admitted as temporal context only
    /// because the host resolved comparable clocks.
    CrossSourceTemporal,
    /// Linked to a candidate by a host-computed trace/request correlation —
    /// never by adjacency.
    TraceLinked,
    /// Trace-linked, in a different source, and strictly later than the
    /// candidate's earliest row. Propagation of an already-linked execution,
    /// not an inference from co-occurrence.
    Propagation,
    /// Separately scoped chronology. It may contradict the chain and may never
    /// enter it. Rows withheld by the clock gate or by a bound land here.
    IndependentNoise,
}

impl FastTriageEvidenceCategory {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Focus => "focus",
            Self::PrecedingSameSource => "preceding_same_source",
            Self::FollowingSameSource => "following_same_source",
            Self::CrossSourceTemporal => "cross_source_temporal",
            Self::TraceLinked => "trace_linked",
            Self::Propagation => "propagation",
            Self::IndependentNoise => "independent_noise",
        }
    }

    /// One host-authored sentence describing exactly what the category proves.
    /// Rendered into the prompt so the model is told the limits, not just the
    /// labels.
    pub fn contract(self) -> &'static str {
        match self {
            Self::Focus => "host-selected evidence for this candidate group",
            Self::PrecedingSameSource => {
                "same source, earlier, inside the host's bounded window; position only, not a cause"
            }
            Self::FollowingSameSource => {
                "same source, later, inside the host's bounded window; position only, not a repair"
            }
            Self::CrossSourceTemporal => {
                "different source, admitted only where the host resolved comparable clocks; \
                 nearness in time is not correlation"
            }
            Self::TraceLinked => {
                "linked to this candidate by a host-computed trace or request correlation"
            }
            Self::Propagation => {
                "trace-linked, different source, strictly later than this candidate's earliest row"
            }
            Self::IndependentNoise => {
                "separately scoped chronology; may be an unrelated concurrent process, and may \
                 never be moved into a causal chain"
            }
        }
    }
}

/// Bounded expansion budget. Defaults mirror the existing production seam's own
/// caps so the fast route cannot quietly widen what the host already bounded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FastTriageNeighborhoodBudget {
    /// Maximum ordinal distance for a same-source context row.
    pub same_source_radius: u64,
    /// Maximum ordinal distance for a cross-source temporal context row.
    pub cross_source_radius: u64,
    /// Maximum rows that may receive a *context* category. Beyond this the rows
    /// remain visible as independent chronology and the overflow is reported.
    pub max_context_rows: usize,
}

impl Default for FastTriageNeighborhoodBudget {
    fn default() -> Self {
        Self {
            same_source_radius: crate::tool_host::BROAD_LOG_TRIAGE_COMPARISON_NEIGHBOR_RADIUS,
            cross_source_radius: crate::tool_host::BROAD_LOG_TRIAGE_COMPARISON_NEIGHBOR_RADIUS,
            max_context_rows: crate::tool_host::BROAD_LOG_TRIAGE_COMPARISON_CONTEXT_IDENTITY_CAP,
        }
    }
}

/// One row's host facts, as the classifier needs them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NeighborhoodRow<'a> {
    /// Host-minted evidence id — preserved verbatim, never rewritten.
    pub evidence_id: &'a str,
    /// Host-minted owning candidate id.
    pub candidate_id: &'a str,
    /// Host source label.
    pub source_label: &'a str,
    /// Host structural scope.
    pub scope: FastTriageEvidenceScope,
    /// Host chronology ordinal, when the host locator carries one.
    pub chronology_ordinal: Option<u64>,
}

/// Deterministic classification result plus its honest accounting.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FastTriageNeighborhood {
    categories: BTreeMap<String, FastTriageEvidenceCategory>,
    /// Rows a resolved-clock gate would have admitted but the host's clock
    /// quality did not justify reading as temporal context.
    pub withheld_clock_incompatible: usize,
    /// Rows outside the bounded radius.
    pub withheld_out_of_radius: usize,
    /// Rows a context category would have covered but the row cap did not.
    pub withheld_over_budget: usize,
}

impl FastTriageNeighborhood {
    /// Category for one host evidence id, if the row was classified.
    pub fn category(&self, evidence_id: &str) -> Option<FastTriageEvidenceCategory> {
        self.categories.get(evidence_id).copied()
    }

    /// Count of rows in one category.
    pub fn count(&self, category: FastTriageEvidenceCategory) -> usize {
        self.categories
            .values()
            .filter(|value| **value == category)
            .count()
    }

    /// Every classified id, in deterministic host-id order.
    pub fn entries(&self) -> impl Iterator<Item = (&str, FastTriageEvidenceCategory)> {
        self.categories
            .iter()
            .map(|(id, category)| (id.as_str(), *category))
    }
}

/// Classify one already-assembled, already-bounded neighborhood.
///
/// This is a pure function of host facts: it issues no query, admits no row the
/// caller did not already hold, and produces the same result for the same input
/// every time. Ordering is total — `(distance, ordinal, evidence_id)` — so the
/// deterministic truncation is reproducible rather than arbitrary.
pub fn classify_neighborhood(
    rows: &[NeighborhoodRow<'_>],
    trace_correlated_candidates: &BTreeSet<String>,
    clock: FastTriageClockCompatibility,
    budget: FastTriageNeighborhoodBudget,
) -> FastTriageNeighborhood {
    let mut out = FastTriageNeighborhood::default();

    // Focus geometry: per candidate, the earliest row and its source; per
    // source, the ordinals the host actually focused on.
    let mut candidate_first: BTreeMap<&str, (u64, &str)> = BTreeMap::new();
    let mut focus_ordinals_by_source: BTreeMap<&str, BTreeSet<u64>> = BTreeMap::new();
    let mut all_focus_ordinals: BTreeSet<u64> = BTreeSet::new();
    for row in rows
        .iter()
        .filter(|row| row.scope == FastTriageEvidenceScope::Candidate)
    {
        let Some(ordinal) = row.chronology_ordinal else {
            continue;
        };
        candidate_first
            .entry(row.candidate_id)
            .and_modify(|current| {
                // Total order, so a tie never resolves by slice position.
                if (ordinal, row.source_label) < (current.0, current.1) {
                    *current = (ordinal, row.source_label);
                }
            })
            .or_insert((ordinal, row.source_label));
        focus_ordinals_by_source
            .entry(row.source_label)
            .or_default()
            .insert(ordinal);
        all_focus_ordinals.insert(ordinal);
    }

    // Candidate-scope rows are the host's focus selection. Inside a
    // trace-correlated group, a row from another source is a *link*, and a
    // later one is propagation of that same linked execution.
    for row in rows
        .iter()
        .filter(|row| row.scope == FastTriageEvidenceScope::Candidate)
    {
        let trace = trace_correlated_candidates.contains(row.candidate_id);
        let first = candidate_first.get(row.candidate_id).copied();
        let category = match (trace, first, row.chronology_ordinal) {
            (true, Some((first_ordinal, first_source)), Some(ordinal))
                if row.source_label != first_source =>
            {
                if ordinal > first_ordinal {
                    FastTriageEvidenceCategory::Propagation
                } else {
                    FastTriageEvidenceCategory::TraceLinked
                }
            }
            (true, Some((_, first_source)), _) if row.source_label != first_source => {
                FastTriageEvidenceCategory::TraceLinked
            }
            _ => FastTriageEvidenceCategory::Focus,
        };
        out.categories
            .insert(row.evidence_id.to_string(), category);
    }

    // Independent-scope rows are the host's bounded chronology sample. Rank
    // every candidate context row by distance first, so a tighter row is never
    // dropped in favour of a looser one when the cap bites.
    struct Ranked<'a> {
        distance: u64,
        ordinal: u64,
        evidence_id: &'a str,
        category: FastTriageEvidenceCategory,
    }
    let mut ranked: Vec<Ranked<'_>> = Vec::new();
    for row in rows
        .iter()
        .filter(|row| row.scope == FastTriageEvidenceScope::Independent)
    {
        let Some(ordinal) = row.chronology_ordinal else {
            // No host ordinal means no host geometry. Abstain rather than guess.
            out.categories.insert(
                row.evidence_id.to_string(),
                FastTriageEvidenceCategory::IndependentNoise,
            );
            continue;
        };
        let same_source = focus_ordinals_by_source.get(row.source_label);
        let (distance, category) = match same_source {
            Some(focus) => {
                let nearest = focus
                    .iter()
                    .map(|value| (value.abs_diff(ordinal), *value))
                    .min()
                    .unwrap_or((u64::MAX, ordinal));
                if nearest.0 > budget.same_source_radius {
                    out.withheld_out_of_radius += 1;
                    out.categories.insert(
                        row.evidence_id.to_string(),
                        FastTriageEvidenceCategory::IndependentNoise,
                    );
                    continue;
                }
                (
                    nearest.0,
                    if ordinal < nearest.1 {
                        FastTriageEvidenceCategory::PrecedingSameSource
                    } else {
                        FastTriageEvidenceCategory::FollowingSameSource
                    },
                )
            }
            None => {
                // A different source than every focus row. Only a resolved,
                // comparable clock justifies reading it as temporal context;
                // otherwise the row stays independent chronology and the host
                // records that it withheld the temporal reading.
                if clock != FastTriageClockCompatibility::ResolvedComparable {
                    out.withheld_clock_incompatible += 1;
                    out.categories.insert(
                        row.evidence_id.to_string(),
                        FastTriageEvidenceCategory::IndependentNoise,
                    );
                    continue;
                }
                let nearest = all_focus_ordinals
                    .iter()
                    .map(|value| value.abs_diff(ordinal))
                    .min()
                    .unwrap_or(u64::MAX);
                if nearest > budget.cross_source_radius {
                    out.withheld_out_of_radius += 1;
                    out.categories.insert(
                        row.evidence_id.to_string(),
                        FastTriageEvidenceCategory::IndependentNoise,
                    );
                    continue;
                }
                (nearest, FastTriageEvidenceCategory::CrossSourceTemporal)
            }
        };
        ranked.push(Ranked {
            distance,
            ordinal,
            evidence_id: row.evidence_id,
            category,
        });
    }
    ranked.sort_by(|left, right| {
        left.distance
            .cmp(&right.distance)
            .then_with(|| left.ordinal.cmp(&right.ordinal))
            .then_with(|| left.evidence_id.cmp(right.evidence_id))
    });
    for (index, row) in ranked.into_iter().enumerate() {
        let category = if index < budget.max_context_rows {
            row.category
        } else {
            out.withheld_over_budget += 1;
            FastTriageEvidenceCategory::IndependentNoise
        };
        out.categories
            .insert(row.evidence_id.to_string(), category);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row<'a>(
        evidence_id: &'a str,
        candidate_id: &'a str,
        source: &'a str,
        scope: FastTriageEvidenceScope,
        ordinal: u64,
    ) -> NeighborhoodRow<'a> {
        NeighborhoodRow {
            evidence_id,
            candidate_id,
            source_label: source,
            scope,
            chronology_ordinal: Some(ordinal),
        }
    }

    fn no_traces() -> BTreeSet<String> {
        BTreeSet::new()
    }

    #[test]
    fn same_source_context_splits_into_preceding_and_following() {
        let rows = vec![
            row("f", "g-a", "app.log", FastTriageEvidenceScope::Candidate, 50),
            row("before", "tl", "app.log", FastTriageEvidenceScope::Independent, 49),
            row("after", "tl", "app.log", FastTriageEvidenceScope::Independent, 51),
        ];
        let near = classify_neighborhood(
            &rows,
            &no_traces(),
            FastTriageClockCompatibility::OrderOnly,
            FastTriageNeighborhoodBudget::default(),
        );
        assert_eq!(near.category("f"), Some(FastTriageEvidenceCategory::Focus));
        assert_eq!(
            near.category("before"),
            Some(FastTriageEvidenceCategory::PrecedingSameSource)
        );
        assert_eq!(
            near.category("after"),
            Some(FastTriageEvidenceCategory::FollowingSameSource)
        );
        assert_eq!(near.withheld_out_of_radius, 0);
    }

    #[test]
    fn cross_source_context_needs_a_resolved_comparable_clock() {
        let rows = vec![
            row("f", "g-a", "app.log", FastTriageEvidenceScope::Candidate, 50),
            row("other", "tl", "db.log", FastTriageEvidenceScope::Independent, 51),
        ];
        let untrustworthy = classify_neighborhood(
            &rows,
            &no_traces(),
            FastTriageClockCompatibility::OrderOnly,
            FastTriageNeighborhoodBudget::default(),
        );
        assert_eq!(
            untrustworthy.category("other"),
            Some(FastTriageEvidenceCategory::IndependentNoise)
        );
        assert_eq!(untrustworthy.withheld_clock_incompatible, 1);

        let trustworthy = classify_neighborhood(
            &rows,
            &no_traces(),
            FastTriageClockCompatibility::ResolvedComparable,
            FastTriageNeighborhoodBudget::default(),
        );
        assert_eq!(
            trustworthy.category("other"),
            Some(FastTriageEvidenceCategory::CrossSourceTemporal)
        );
        assert_eq!(trustworthy.withheld_clock_incompatible, 0);
    }

    #[test]
    fn mixed_time_quality_is_not_comparable() {
        assert_eq!(
            clock_compatibility_from_time_quality(TimeQuality::Wall),
            FastTriageClockCompatibility::ResolvedComparable
        );
        for quality in [TimeQuality::Mixed, TimeQuality::OrderOnly] {
            assert_eq!(
                clock_compatibility_from_time_quality(quality),
                FastTriageClockCompatibility::OrderOnly,
                "{quality:?} must not be treated as comparable"
            );
        }
    }

    #[test]
    fn simultaneous_independent_noise_never_becomes_context() {
        // A second, unrelated source emitting at the same ordinal as the focus
        // row is the classic false correlation. Without a resolved clock it
        // stays independent; even with one it is only *temporal* context, never
        // part of the chain (the packet validator enforces the rest).
        let rows = vec![
            row("f", "g-a", "app.log", FastTriageEvidenceScope::Candidate, 50),
            row("noise", "tl", "unrelated.log", FastTriageEvidenceScope::Independent, 50),
        ];
        assert_eq!(
            classify_neighborhood(
                &rows,
                &no_traces(),
                FastTriageClockCompatibility::OrderOnly,
                FastTriageNeighborhoodBudget::default(),
            )
            .category("noise"),
            Some(FastTriageEvidenceCategory::IndependentNoise)
        );
        assert_eq!(
            classify_neighborhood(
                &rows,
                &no_traces(),
                FastTriageClockCompatibility::ResolvedComparable,
                FastTriageNeighborhoodBudget::default(),
            )
            .category("noise"),
            Some(FastTriageEvidenceCategory::CrossSourceTemporal)
        );
    }

    #[test]
    fn expansion_is_bounded_by_radius_and_by_row_cap() {
        let mut rows = vec![row(
            "f",
            "g-a",
            "app.log",
            FastTriageEvidenceScope::Candidate,
            50,
        )];
        // Two rows inside the default radius of 2, one outside it.
        rows.push(row("n1", "tl", "app.log", FastTriageEvidenceScope::Independent, 48));
        rows.push(row("n2", "tl", "app.log", FastTriageEvidenceScope::Independent, 52));
        rows.push(row("far", "tl", "app.log", FastTriageEvidenceScope::Independent, 90));
        let bounded = classify_neighborhood(
            &rows,
            &no_traces(),
            FastTriageClockCompatibility::OrderOnly,
            FastTriageNeighborhoodBudget::default(),
        );
        assert_eq!(bounded.withheld_out_of_radius, 1);
        assert_eq!(
            bounded.category("far"),
            Some(FastTriageEvidenceCategory::IndependentNoise)
        );

        // The row cap truncates deterministically by distance, then ordinal.
        let capped = classify_neighborhood(
            &rows,
            &no_traces(),
            FastTriageClockCompatibility::OrderOnly,
            FastTriageNeighborhoodBudget {
                max_context_rows: 1,
                ..FastTriageNeighborhoodBudget::default()
            },
        );
        assert_eq!(capped.withheld_over_budget, 1);
        // Both are distance 2; `n1` wins on the lower ordinal, every time.
        assert_eq!(
            capped.category("n1"),
            Some(FastTriageEvidenceCategory::PrecedingSameSource)
        );
        assert_eq!(
            capped.category("n2"),
            Some(FastTriageEvidenceCategory::IndependentNoise)
        );
        assert_eq!(capped, classify_neighborhood(
            &rows,
            &no_traces(),
            FastTriageClockCompatibility::OrderOnly,
            FastTriageNeighborhoodBudget {
                max_context_rows: 1,
                ..FastTriageNeighborhoodBudget::default()
            },
        ));
    }

    #[test]
    fn trace_links_and_propagation_come_from_grouping_not_adjacency() {
        // `a` is the group's earliest row. `b` is a later row in another
        // source (propagation of the same linked execution); `c` shares the
        // earliest ordinal in another source, so it is a link, not propagation.
        let rows = vec![
            row("a", "trace:x", "app.log", FastTriageEvidenceScope::Candidate, 10),
            row("b", "trace:x", "db.log", FastTriageEvidenceScope::Candidate, 30),
            row("c", "trace:x", "db.log", FastTriageEvidenceScope::Candidate, 10),
            row("d", "template:y", "db.log", FastTriageEvidenceScope::Candidate, 40),
        ];
        let traces = BTreeSet::from(["trace:x".to_string()]);
        let near = classify_neighborhood(
            &rows,
            &traces,
            FastTriageClockCompatibility::OrderOnly,
            FastTriageNeighborhoodBudget::default(),
        );
        assert_eq!(near.category("a"), Some(FastTriageEvidenceCategory::Focus));
        assert_eq!(
            near.category("b"),
            Some(FastTriageEvidenceCategory::Propagation)
        );
        assert_eq!(
            near.category("c"),
            Some(FastTriageEvidenceCategory::TraceLinked)
        );
        // A non-trace group is focus evidence regardless of its sources.
        assert_eq!(near.category("d"), Some(FastTriageEvidenceCategory::Focus));
    }

    #[test]
    fn exact_host_ids_are_preserved_verbatim() {
        let rows = vec![
            row(
                "e:trace:alpha:11",
                "trace:alpha",
                "app.log",
                FastTriageEvidenceScope::Candidate,
                11,
            ),
            row(
                "e:global_timeline_context:12",
                "global_timeline_context",
                "app.log",
                FastTriageEvidenceScope::Independent,
                12,
            ),
        ];
        let near = classify_neighborhood(
            &rows,
            &no_traces(),
            FastTriageClockCompatibility::OrderOnly,
            FastTriageNeighborhoodBudget::default(),
        );
        let ids = near.entries().map(|(id, _)| id).collect::<Vec<_>>();
        assert_eq!(ids, ["e:global_timeline_context:12", "e:trace:alpha:11"]);
    }

    #[test]
    fn every_category_has_a_stable_label_and_a_host_contract_sentence() {
        let categories = [
            FastTriageEvidenceCategory::Focus,
            FastTriageEvidenceCategory::PrecedingSameSource,
            FastTriageEvidenceCategory::FollowingSameSource,
            FastTriageEvidenceCategory::CrossSourceTemporal,
            FastTriageEvidenceCategory::TraceLinked,
            FastTriageEvidenceCategory::Propagation,
            FastTriageEvidenceCategory::IndependentNoise,
        ];
        let labels = categories.map(FastTriageEvidenceCategory::as_str);
        assert_eq!(labels.iter().collect::<BTreeSet<_>>().len(), labels.len());
        for category in categories {
            assert!(!category.contract().is_empty());
            // No category may state a causal relationship.
            let contract = category.contract().to_ascii_lowercase();
            for forbidden in ["caused by", "root cause", "led to", "resulted in"] {
                assert!(
                    !contract.contains(forbidden),
                    "{category:?} contract implies causality"
                );
            }
        }
    }
}
