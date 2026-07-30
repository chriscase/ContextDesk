//! Bounded, privacy-safe format and time-confidence aggregation for log ingest.

use super::format_profile::FormatFingerprintOutcome;
#[cfg(test)]
use super::parse::ActiveTimestampBasis;
use super::parse::FingerprintedParsedLine;
use super::parse::TimestampProvenance;
use super::query::TimeQuality;
use super::redact_log::redact_message;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Maximum redacted timestamp-prefix examples retained for one source.
pub const MAX_TIMESTAMP_PREFIX_SAMPLES: usize = 3;

/// Maximum characters retained in one redacted timestamp-prefix example.
pub const MAX_TIMESTAMP_PREFIX_SAMPLE_CHARS: usize = 96;

/// Source-level deterministic grammar result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestFormatOutcome {
    /// All structured matches select one versioned grammar. Unknown banner or
    /// continuation records do not override that structured evidence.
    Matched,
    /// At least one record is ambiguous, or more than one structured grammar
    /// is present in the source.
    Ambiguous,
    /// No record matched a structured grammar.
    Unknown,
}

/// Why otherwise valid source-local time could not become an instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedTimeReason {
    /// A valid local calendar timestamp had no timezone or numeric offset.
    NoTimezone,
    /// A source zone abbreviation was present but is not resolved to an IANA
    /// zone or numeric offset.
    ZoneAbbreviationNotResolved,
}

/// Source counts in an [`IngestConfidenceReport`].
///
/// Every field counts sources, not records. The three time-quality fields and
/// three format-outcome fields each partition `sources`. `unresolved` counts
/// sources with at least one explicit unresolved-time reason.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestConfidenceCounts {
    /// Sources containing wall-clock records only.
    pub wall: u64,
    /// Sources containing order-only records only.
    pub order_only: u64,
    /// Sources containing both wall-clock and order-only records.
    pub mixed: u64,
    /// Sources selecting one versioned structured grammar.
    pub matched: u64,
    /// Sources with ambiguous or heterogeneous structured grammar evidence.
    pub ambiguous: u64,
    /// Sources with no structured grammar match.
    pub unknown: u64,
    /// Sources with one or more explicit unresolved-time reasons.
    pub unresolved: u64,
}

/// Bounded, payload-free confidence summary for one portable source identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceIngestConfidence {
    /// Portable identity relative to the selected import root or archive.
    pub source: String,
    /// Imported non-empty physical records from this source.
    pub lines: u64,
    /// Selected stable grammar id when `outcome` is `matched`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_id: Option<String>,
    /// Selected grammar recognition-contract version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_version: Option<u16>,
    /// Aggregate grammar outcome, kept separate from time quality.
    pub outcome: IngestFormatOutcome,
    /// Smallest record-level fingerprint score margin for the selected grammar.
    ///
    /// This remains a grammar score margin. It is never presented as timezone
    /// confidence. `0` denotes an actual record-level tie.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner_up_margin: Option<u16>,
    /// Non-authoritative producer-family hint for the selected grammar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub producer_hint: Option<String>,
    /// Honest source quality folded from imported records.
    pub time_quality: TimeQuality,
    /// Distinct unresolved-time reasons observed in this source.
    ///
    /// A vector is intentional: heterogeneous sources can contain both forms,
    /// and collapsing them to one reason would be misleading.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unresolved_reasons: Vec<UnresolvedTimeReason>,
    /// At most three redacted timestamp prefixes; never payload excerpts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub timestamp_prefix_samples: Vec<String>,
}

/// Privacy-safe confidence report produced by one completed ingest.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestConfidenceReport {
    /// Fail-closed minimum fold across all source qualities.
    pub corpus_time_quality: TimeQuality,
    /// Source-level quality and outcome counts.
    pub counts: IngestConfidenceCounts,
    /// Deterministically sorted portable source summaries.
    pub sources: Vec<SourceIngestConfidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct GrammarIdentity {
    id: String,
    version: u16,
}

#[derive(Debug, Default)]
struct MatchedGrammarEvidence {
    lines: u64,
    minimum_margin: Option<u16>,
    producer_hint: Option<String>,
}

#[derive(Debug, Default)]
struct SourceConfidenceAccumulator {
    lines: u64,
    wall_lines: u64,
    order_only_lines: u64,
    unknown_lines: u64,
    ambiguous_lines: u64,
    matched_grammars: BTreeMap<GrammarIdentity, MatchedGrammarEvidence>,
    unresolved_reasons: BTreeSet<UnresolvedTimeReason>,
    timestamp_prefix_samples: Vec<String>,
}

/// Transient per-ingest aggregator. It retains bounded metadata only and is
/// consumed when the completed report is published.
#[derive(Debug, Default)]
pub(super) struct IngestConfidenceAggregator {
    sources: BTreeMap<String, SourceConfidenceAccumulator>,
}

impl IngestConfidenceAggregator {
    pub(super) fn observe(&mut self, source: &str, line: &FingerprintedParsedLine) {
        let source = self.sources.entry(source.to_string()).or_default();
        source.lines = source.lines.saturating_add(1);

        match line.parsed.timestamp_provenance {
            TimestampProvenance::ExplicitWallClock => {
                source.wall_lines = source.wall_lines.saturating_add(1);
            }
            TimestampProvenance::UnresolvedLocal
            | TimestampProvenance::OrderOnly
            | TimestampProvenance::LegacyUnknown => {
                source.order_only_lines = source.order_only_lines.saturating_add(1);
            }
        }

        match line.fingerprint.outcome {
            FormatFingerprintOutcome::Matched => {
                if let (Some(format_id), Some(format_version)) =
                    (line.fingerprint.format_id, line.fingerprint.format_version)
                {
                    let evidence = source
                        .matched_grammars
                        .entry(GrammarIdentity {
                            id: format_id.to_string(),
                            version: format_version,
                        })
                        .or_default();
                    evidence.lines = evidence.lines.saturating_add(1);
                    evidence.minimum_margin = minimum_optional_margin(
                        evidence.minimum_margin,
                        line.fingerprint.runner_up_margin,
                    );
                    if evidence.producer_hint.is_none() {
                        evidence.producer_hint =
                            line.fingerprint.producer_hint.map(ToString::to_string);
                    }
                } else {
                    // A matched fingerprint without a stable identity is not
                    // safe to publish as matched source evidence.
                    source.ambiguous_lines = source.ambiguous_lines.saturating_add(1);
                }
            }
            FormatFingerprintOutcome::Ambiguous => {
                source.ambiguous_lines = source.ambiguous_lines.saturating_add(1);
            }
            FormatFingerprintOutcome::Unknown => {
                source.unknown_lines = source.unknown_lines.saturating_add(1);
            }
        }

        if let Some(prefix) = line.parsed.unresolved_local_timestamp.as_deref() {
            let reason = if line.fingerprint.format_id == Some("local-minute-zone-level-record") {
                UnresolvedTimeReason::ZoneAbbreviationNotResolved
            } else {
                UnresolvedTimeReason::NoTimezone
            };
            source.unresolved_reasons.insert(reason);
            retain_timestamp_prefix_sample(&mut source.timestamp_prefix_samples, prefix);
        }
    }

    pub(super) fn finish(self) -> IngestConfidenceReport {
        let sources = self
            .sources
            .into_iter()
            .map(|(source, evidence)| evidence.finish(source))
            .collect::<Vec<_>>();
        let counts = count_sources(&sources);
        let corpus_time_quality = fold_corpus_time_quality(&sources);
        IngestConfidenceReport {
            corpus_time_quality,
            counts,
            sources,
        }
    }
}

impl SourceConfidenceAccumulator {
    fn finish(self, source: String) -> SourceIngestConfidence {
        let time_quality = fold_line_quality(self.wall_lines, self.order_only_lines);
        let (outcome, format_id, format_version, runner_up_margin, producer_hint) =
            if self.ambiguous_lines > 0 || self.matched_grammars.len() > 1 {
                (
                    IngestFormatOutcome::Ambiguous,
                    None,
                    None,
                    (self.ambiguous_lines > 0).then_some(0),
                    None,
                )
            } else if let Some((identity, evidence)) = self.matched_grammars.into_iter().next() {
                (
                    IngestFormatOutcome::Matched,
                    Some(identity.id),
                    Some(identity.version),
                    evidence.minimum_margin,
                    evidence.producer_hint,
                )
            } else {
                debug_assert_eq!(self.unknown_lines, self.lines);
                (IngestFormatOutcome::Unknown, None, None, None, None)
            };

        SourceIngestConfidence {
            source,
            lines: self.lines,
            format_id,
            format_version,
            outcome,
            runner_up_margin,
            producer_hint,
            time_quality,
            unresolved_reasons: self.unresolved_reasons.into_iter().collect(),
            timestamp_prefix_samples: self.timestamp_prefix_samples,
        }
    }
}

fn minimum_optional_margin(current: Option<u16>, candidate: Option<u16>) -> Option<u16> {
    match (current, candidate) {
        (Some(current), Some(candidate)) => Some(current.min(candidate)),
        (None, candidate) | (candidate, None) => candidate,
    }
}

fn fold_line_quality(wall_lines: u64, order_only_lines: u64) -> TimeQuality {
    match (wall_lines > 0, order_only_lines > 0) {
        (true, false) => TimeQuality::Wall,
        (false, true) | (false, false) => TimeQuality::OrderOnly,
        (true, true) => TimeQuality::Mixed,
    }
}

fn fold_corpus_time_quality(sources: &[SourceIngestConfidence]) -> TimeQuality {
    let Some(first) = sources.first() else {
        return TimeQuality::OrderOnly;
    };
    sources
        .iter()
        .skip(1)
        .fold(first.time_quality, |quality, source| {
            match (quality, source.time_quality) {
                (TimeQuality::Wall, TimeQuality::Wall) => TimeQuality::Wall,
                (TimeQuality::OrderOnly, TimeQuality::OrderOnly) => TimeQuality::OrderOnly,
                _ => TimeQuality::Mixed,
            }
        })
}

fn count_sources(sources: &[SourceIngestConfidence]) -> IngestConfidenceCounts {
    let mut counts = IngestConfidenceCounts::default();
    for source in sources {
        match source.time_quality {
            TimeQuality::Wall => counts.wall = counts.wall.saturating_add(1),
            TimeQuality::Mixed => counts.mixed = counts.mixed.saturating_add(1),
            TimeQuality::OrderOnly => {
                counts.order_only = counts.order_only.saturating_add(1);
            }
        }
        match source.outcome {
            IngestFormatOutcome::Matched => counts.matched = counts.matched.saturating_add(1),
            IngestFormatOutcome::Ambiguous => {
                counts.ambiguous = counts.ambiguous.saturating_add(1);
            }
            IngestFormatOutcome::Unknown => counts.unknown = counts.unknown.saturating_add(1),
        }
        if !source.unresolved_reasons.is_empty() {
            counts.unresolved = counts.unresolved.saturating_add(1);
        }
    }
    counts
}

fn retain_timestamp_prefix_sample(samples: &mut Vec<String>, prefix: &str) {
    if samples.len() >= MAX_TIMESTAMP_PREFIX_SAMPLES {
        return;
    }
    let redacted = redact_message(prefix);
    let bounded = redacted
        .chars()
        .take(MAX_TIMESTAMP_PREFIX_SAMPLE_CHARS)
        .collect::<String>();
    if !bounded.is_empty() && !samples.contains(&bounded) {
        samples.push(bounded);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::{
        parse_line_with_fingerprint, FingerprintedParsedLine, FormatFingerprint, LogFormat,
        ParsedLine,
    };
    use std::borrow::Cow;

    fn observe(aggregator: &mut IngestConfidenceAggregator, source: &str, line: &str, seq: u64) {
        let parsed = parse_line_with_fingerprint(line, None, seq);
        aggregator.observe(source, &parsed);
    }

    fn synthetic_ambiguous_line(seq: u64) -> FingerprintedParsedLine {
        FingerprintedParsedLine {
            parsed: ParsedLine {
                ts: Some(seq as i64),
                timestamp_provenance: TimestampProvenance::OrderOnly,
                active_timestamp_basis: ActiveTimestampBasis::OrderOnly,
                unresolved_local_timestamp: None,
                level: "unknown".into(),
                service: None,
                host: None,
                trace_id: None,
                message: "ambiguous synthetic record".into(),
                raw: "ambiguous synthetic record".into(),
                format: LogFormat::Plain,
            },
            fingerprint: FormatFingerprint {
                outcome: FormatFingerprintOutcome::Ambiguous,
                format_id: None,
                format_version: None,
                producer_hint: None,
                decisive_clue_codes: Cow::Borrowed(&["test.tie"]),
                score: 100,
                runner_up_margin: Some(0),
                competing_formats: Vec::new(),
                grammar: None,
            },
        }
    }

    #[test]
    fn all_wall_sources_fold_to_wall_without_unresolved_time() {
        let mut aggregator = IngestConfidenceAggregator::default();
        observe(
            &mut aggregator,
            "api/app.jsonl",
            r#"{"ts":"2025-01-01T12:00:00Z","level":"info","message":"ready"}"#,
            1,
        );
        observe(
            &mut aggregator,
            "worker/worker.log",
            "2025-01-01 13:00:00,123+01:00 ERROR [worker] (main) failed",
            2,
        );

        let report = aggregator.finish();
        assert_eq!(report.corpus_time_quality, TimeQuality::Wall);
        assert_eq!(report.counts.wall, 2);
        assert_eq!(report.counts.order_only, 0);
        assert_eq!(report.counts.unresolved, 0);
    }

    #[test]
    fn all_order_only_sources_fold_to_order_only_and_distinguish_reasons() {
        let mut aggregator = IngestConfidenceAggregator::default();
        observe(
            &mut aggregator,
            "server/server.log",
            "2021-03-05 02:53:53,654 ERROR [org.jboss] (worker) failed",
            1,
        );
        observe(
            &mut aggregator,
            "legacy/legacy.log",
            "2021-03-05T00:06,350 CET. INFO: started",
            2,
        );

        let report = aggregator.finish();
        assert_eq!(report.corpus_time_quality, TimeQuality::OrderOnly);
        assert_eq!(report.counts.order_only, 2);
        assert_eq!(report.counts.unresolved, 2);
        assert_eq!(
            report.sources[0].unresolved_reasons,
            vec![UnresolvedTimeReason::ZoneAbbreviationNotResolved]
        );
        assert_eq!(
            report.sources[1].unresolved_reasons,
            vec![UnresolvedTimeReason::NoTimezone]
        );
    }

    #[test]
    fn mixed_sources_fold_corpus_quality_fail_closed() {
        let mut aggregator = IngestConfidenceAggregator::default();
        observe(
            &mut aggregator,
            "wall.log",
            r#"{"ts":"2025-01-01T12:00:00Z","message":"wall"}"#,
            1,
        );
        observe(&mut aggregator, "order.log", "plain order-only record", 2);

        let report = aggregator.finish();
        assert_eq!(report.corpus_time_quality, TimeQuality::Mixed);
        assert_eq!(report.counts.wall, 1);
        assert_eq!(report.counts.order_only, 1);
        assert_eq!(report.counts.mixed, 0);
    }

    #[test]
    fn unknown_source_stays_payload_free_and_order_only() {
        let mut aggregator = IngestConfidenceAggregator::default();
        observe(
            &mut aggregator,
            "relative/unknown.log",
            "Bearer secret-value payload must not enter confidence",
            1,
        );

        let report = aggregator.finish();
        let source = &report.sources[0];
        assert_eq!(source.outcome, IngestFormatOutcome::Unknown);
        assert_eq!(source.time_quality, TimeQuality::OrderOnly);
        assert!(source.timestamp_prefix_samples.is_empty());
        let encoded = serde_json::to_string(&report).unwrap();
        assert!(!encoded.contains("secret-value"));
        assert!(!encoded.contains("/Users/"));
    }

    #[test]
    fn ambiguous_record_fails_closed_without_selected_grammar() {
        let mut aggregator = IngestConfidenceAggregator::default();
        aggregator.observe("ambiguous.log", &synthetic_ambiguous_line(1));

        let report = aggregator.finish();
        let source = &report.sources[0];
        assert_eq!(source.outcome, IngestFormatOutcome::Ambiguous);
        assert_eq!(source.runner_up_margin, Some(0));
        assert_eq!(source.format_id, None);
        assert_eq!(source.format_version, None);
        assert_eq!(report.counts.ambiguous, 1);
    }

    #[test]
    fn banner_then_structured_selects_structured_grammar() {
        let mut aggregator = IngestConfidenceAggregator::default();
        observe(&mut aggregator, "server.log", "Synthetic startup banner", 1);
        observe(
            &mut aggregator,
            "server.log",
            "2021-03-05 02:53:53,654 ERROR [org.jboss] (worker) failed",
            2,
        );

        let report = aggregator.finish();
        let source = &report.sources[0];
        assert_eq!(source.outcome, IngestFormatOutcome::Matched);
        assert_eq!(
            source.format_id.as_deref(),
            Some("date-level-logger-thread-record")
        );
        assert_eq!(
            source.producer_hint.as_deref(),
            Some("wildfly-or-jboss-family")
        );
        assert_eq!(source.lines, 2);
    }

    #[test]
    fn explicit_offset_plus_offsetless_records_make_source_mixed() {
        let mut aggregator = IngestConfidenceAggregator::default();
        observe(
            &mut aggregator,
            "server.log",
            "2021-03-05 02:53:53,654Z ERROR [org.jboss] (worker) wall",
            1,
        );
        for seq in 2..=5 {
            observe(
                &mut aggregator,
                "server.log",
                &format!("2021-03-05 02:53:5{seq},654 ERROR [org.jboss] (worker) local-{seq}"),
                seq,
            );
        }

        let report = aggregator.finish();
        let source = &report.sources[0];
        assert_eq!(report.corpus_time_quality, TimeQuality::Mixed);
        assert_eq!(source.time_quality, TimeQuality::Mixed);
        assert_eq!(report.counts.mixed, 1);
        assert_eq!(
            source.unresolved_reasons,
            vec![UnresolvedTimeReason::NoTimezone]
        );
        assert_eq!(
            source.timestamp_prefix_samples.len(),
            MAX_TIMESTAMP_PREFIX_SAMPLES
        );
        assert!(source
            .timestamp_prefix_samples
            .iter()
            .all(|sample| sample.len() <= MAX_TIMESTAMP_PREFIX_SAMPLE_CHARS));
        let encoded = serde_json::to_string(source).unwrap();
        assert!(!encoded.contains("local-"));
    }
}
