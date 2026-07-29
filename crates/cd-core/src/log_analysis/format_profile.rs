//! Immutable built-in log grammar registry and deterministic fingerprints.
//!
//! Grammar identity is deliberately separate from a possible producer hint.
//! A product can reuse another product's familiar layout, so a content match
//! never proves which application emitted the record.

use super::parse::{
    looks_like_classic_syslog, looks_like_elasticsearch, looks_like_json_object, looks_like_logfmt,
    looks_like_rfc5424, looks_like_wildfly, looks_like_zone_abbreviated_incomplete_time, LogFormat,
};
use std::borrow::Cow;
use std::path::Path;

/// Stable parser dispatch identity for one built-in grammar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltInGrammar {
    /// One JSON object per physical line.
    JsonObjectLine,
    /// A logfmt record with recognized semantic fields.
    LogfmtRecord,
    /// An RFC5424 record.
    Rfc5424,
    /// A strict yearless classic-syslog record.
    ClassicSyslog,
    /// Date, level, bracketed logger, parenthesized thread, then payload.
    DateLevelLoggerThread,
    /// Four bracketed fields: timestamp, level, component, node.
    BracketedTimestampLevelComponentNode,
    /// Local minute/fraction plus an unresolved zone abbreviation.
    LocalMinuteZoneLevel,
    /// Honest whole-line fallback.
    PlainLine,
}

impl BuiltInGrammar {
    /// Existing coarse format used by corpus metadata and compatibility APIs.
    pub const fn log_format(self) -> LogFormat {
        match self {
            Self::JsonObjectLine => LogFormat::Json,
            Self::LogfmtRecord => LogFormat::Logfmt,
            Self::Rfc5424
            | Self::ClassicSyslog
            | Self::DateLevelLoggerThread
            | Self::BracketedTimestampLevelComponentNode
            | Self::LocalMinuteZoneLevel => LogFormat::Syslog,
            Self::PlainLine => LogFormat::Plain,
        }
    }
}

/// One immutable built-in grammar profile.
#[derive(Clone, Copy)]
pub struct BuiltInFormatProfile {
    /// Stable grammar identity. This must not be a producer assertion.
    pub id: &'static str,
    /// Version of the recognition contract.
    pub version: u16,
    /// Parser dispatch identity.
    pub grammar: BuiltInGrammar,
    /// Optional non-authoritative producer-family clue.
    pub producer_hint: Option<&'static str>,
    /// Content clues that justify a match.
    pub decisive_clue_codes: &'static [&'static str],
    /// Deterministic confidence score for this strict built-in grammar.
    pub score: u16,
    /// True only for the non-competing whole-line fallback.
    pub fallback: bool,
    matcher: fn(&str) -> bool,
}

impl std::fmt::Debug for BuiltInFormatProfile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BuiltInFormatProfile")
            .field("id", &self.id)
            .field("version", &self.version)
            .field("grammar", &self.grammar)
            .field("producer_hint", &self.producer_hint)
            .field("decisive_clue_codes", &self.decisive_clue_codes)
            .field("score", &self.score)
            .field("fallback", &self.fallback)
            .finish_non_exhaustive()
    }
}

/// Deterministic recognition outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatFingerprintOutcome {
    /// One candidate scored strictly above every other candidate.
    Matched,
    /// No structured candidate supplied sufficient content evidence.
    Unknown,
    /// Two or more candidates share the highest score.
    Ambiguous,
}

/// Stable identity of one versioned grammar candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatProfileIdentity {
    /// Stable grammar ID.
    pub format_id: &'static str,
    /// Version of that grammar's recognition contract.
    pub format_version: u16,
}

/// Explainable transient result of classifying one bounded physical record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatFingerprint {
    /// Recognition outcome.
    pub outcome: FormatFingerprintOutcome,
    /// Selected stable grammar ID; plain fallback on `Unknown`, none on ambiguity.
    pub format_id: Option<&'static str>,
    /// Selected grammar version; plain fallback on `Unknown`, none on ambiguity.
    pub format_version: Option<u16>,
    /// Optional non-authoritative producer-family clue.
    pub producer_hint: Option<&'static str>,
    /// Content-only clues that drove the result.
    pub decisive_clue_codes: Cow<'static, [&'static str]>,
    /// Highest candidate score (zero for unknown).
    pub score: u16,
    /// Difference between first and second place; absent when only one matched.
    pub runner_up_margin: Option<u16>,
    /// Equal-scoring versioned top candidates for an ambiguous result.
    pub competing_formats: Vec<FormatProfileIdentity>,
    pub(crate) grammar: Option<BuiltInGrammar>,
}

impl FormatFingerprint {
    /// Existing coarse format for compatibility and corpus summary counts.
    pub fn log_format(&self) -> LogFormat {
        self.grammar
            .unwrap_or(BuiltInGrammar::PlainLine)
            .log_format()
    }
}

fn never_matches(_: &str) -> bool {
    false
}

/// Minimum score required for a structured grammar to be eligible.
pub const MIN_STRUCTURED_FORMAT_SCORE: u16 = 60;

/// Immutable, versioned registry of built-in record grammars.
///
/// Registry order has no semantic effect. Ties are reported as ambiguous.
pub const BUILT_IN_FORMAT_PROFILES: &[BuiltInFormatProfile] = &[
    BuiltInFormatProfile {
        id: "json-object-line",
        version: 1,
        grammar: BuiltInGrammar::JsonObjectLine,
        producer_hint: None,
        decisive_clue_codes: &["content.json_object"],
        score: 100,
        fallback: false,
        matcher: looks_like_json_object,
    },
    BuiltInFormatProfile {
        id: "logfmt-record",
        version: 1,
        grammar: BuiltInGrammar::LogfmtRecord,
        producer_hint: None,
        decisive_clue_codes: &["content.logfmt_known_fields"],
        score: 70,
        fallback: false,
        matcher: looks_like_logfmt,
    },
    BuiltInFormatProfile {
        id: "rfc5424-record",
        version: 1,
        grammar: BuiltInGrammar::Rfc5424,
        producer_hint: None,
        decisive_clue_codes: &["content.rfc5424_header"],
        score: 95,
        fallback: false,
        matcher: looks_like_rfc5424,
    },
    BuiltInFormatProfile {
        id: "classic-syslog-record",
        version: 1,
        grammar: BuiltInGrammar::ClassicSyslog,
        producer_hint: None,
        decisive_clue_codes: &["content.classic_syslog_header"],
        score: 90,
        fallback: false,
        matcher: looks_like_classic_syslog,
    },
    BuiltInFormatProfile {
        id: "date-level-logger-thread-record",
        version: 1,
        grammar: BuiltInGrammar::DateLevelLoggerThread,
        producer_hint: Some("wildfly-or-jboss-family"),
        decisive_clue_codes: &["content.date_level_logger_thread"],
        score: 100,
        fallback: false,
        matcher: looks_like_wildfly,
    },
    BuiltInFormatProfile {
        id: "bracketed-timestamp-level-component-node-record",
        version: 1,
        grammar: BuiltInGrammar::BracketedTimestampLevelComponentNode,
        producer_hint: Some("elasticsearch-classic-family"),
        decisive_clue_codes: &["content.bracketed_timestamp_level_component_node"],
        score: 100,
        fallback: false,
        matcher: looks_like_elasticsearch,
    },
    BuiltInFormatProfile {
        id: "local-minute-zone-level-record",
        version: 1,
        grammar: BuiltInGrammar::LocalMinuteZoneLevel,
        producer_hint: None,
        decisive_clue_codes: &["content.local_minute_zone_level"],
        score: 100,
        fallback: false,
        matcher: looks_like_zone_abbreviated_incomplete_time,
    },
    BuiltInFormatProfile {
        id: "plain-line",
        version: 1,
        grammar: BuiltInGrammar::PlainLine,
        producer_hint: None,
        decisive_clue_codes: &["fallback.no_structured_match"],
        score: 0,
        fallback: true,
        matcher: never_matches,
    },
];

/// Fingerprint one bounded physical record using content evidence.
///
/// `path` is accepted so callers do not need a separate API when future
/// shortlisting is added. It intentionally cannot select or score a profile:
/// `.json` text that is not a JSON object remains unknown/plain.
pub fn fingerprint_format(sample: &str, path: Option<&Path>) -> FormatFingerprint {
    let _non_decisive_path_hint = path;
    fingerprint_with_registry(sample, BUILT_IN_FORMAT_PROFILES)
}

fn fingerprint_with_registry(sample: &str, registry: &[BuiltInFormatProfile]) -> FormatFingerprint {
    let trimmed = sample.trim();
    let mut top: Option<&BuiltInFormatProfile> = None;
    let mut runner_up_score: Option<u16> = None;
    // The common matched/unknown paths allocate nothing. This vector allocates
    // only when two strict profiles actually tie.
    let mut tied = Vec::new();
    for profile in registry.iter().filter(|profile| {
        !profile.fallback
            && profile.score >= MIN_STRUCTURED_FORMAT_SCORE
            && (profile.matcher)(trimmed)
    }) {
        match top {
            None => top = Some(profile),
            Some(current) if profile.score > current.score => {
                runner_up_score = Some(runner_up_score.unwrap_or_default().max(current.score));
                top = Some(profile);
                tied.clear();
            }
            Some(current) if profile.score == current.score => {
                if tied.is_empty() {
                    tied.push(current);
                }
                tied.push(profile);
            }
            Some(_) => {
                runner_up_score = Some(runner_up_score.unwrap_or_default().max(profile.score));
            }
        }
    }

    let Some(top) = top else {
        let fallback = registry
            .iter()
            .find(|profile| profile.fallback)
            .copied()
            .unwrap_or(BUILT_IN_FORMAT_PROFILES[BUILT_IN_FORMAT_PROFILES.len() - 1]);
        return FormatFingerprint {
            outcome: FormatFingerprintOutcome::Unknown,
            format_id: Some(fallback.id),
            format_version: Some(fallback.version),
            producer_hint: None,
            decisive_clue_codes: Cow::Borrowed(fallback.decisive_clue_codes),
            score: 0,
            runner_up_margin: None,
            competing_formats: Vec::new(),
            grammar: Some(BuiltInGrammar::PlainLine),
        };
    };

    if tied.len() > 1 {
        let mut clues = tied
            .iter()
            .flat_map(|profile| profile.decisive_clue_codes.iter().copied())
            .collect::<Vec<_>>();
        clues.sort();
        clues.dedup();
        tied.sort_by(|left, right| {
            left.id
                .cmp(right.id)
                .then_with(|| left.version.cmp(&right.version))
        });
        return FormatFingerprint {
            outcome: FormatFingerprintOutcome::Ambiguous,
            format_id: None,
            format_version: None,
            producer_hint: None,
            decisive_clue_codes: Cow::Owned(clues),
            score: top.score,
            runner_up_margin: Some(0),
            competing_formats: tied
                .iter()
                .map(|profile| FormatProfileIdentity {
                    format_id: profile.id,
                    format_version: profile.version,
                })
                .collect(),
            grammar: None,
        };
    }

    let runner_up_margin = runner_up_score.map(|runner_up| top.score.saturating_sub(runner_up));
    FormatFingerprint {
        outcome: FormatFingerprintOutcome::Matched,
        format_id: Some(top.id),
        format_version: Some(top.version),
        producer_hint: top.producer_hint,
        decisive_clue_codes: Cow::Borrowed(top.decisive_clue_codes),
        score: top.score,
        runner_up_margin,
        competing_formats: Vec::new(),
        grammar: Some(top.grammar),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn always_matches(_: &str) -> bool {
        true
    }

    const TIED_A: BuiltInFormatProfile = BuiltInFormatProfile {
        id: "synthetic-a",
        version: 1,
        grammar: BuiltInGrammar::JsonObjectLine,
        producer_hint: None,
        decisive_clue_codes: &["test.a"],
        score: 80,
        fallback: false,
        matcher: always_matches,
    };
    const TIED_B: BuiltInFormatProfile = BuiltInFormatProfile {
        id: "synthetic-b",
        version: 2,
        grammar: BuiltInGrammar::LogfmtRecord,
        producer_hint: None,
        decisive_clue_codes: &["test.b"],
        score: 80,
        fallback: false,
        matcher: always_matches,
    };
    const TEST_FALLBACK: BuiltInFormatProfile = BuiltInFormatProfile {
        id: "plain-line",
        version: 1,
        grammar: BuiltInGrammar::PlainLine,
        producer_hint: None,
        decisive_clue_codes: &["fallback.no_structured_match"],
        score: 0,
        fallback: true,
        matcher: never_matches,
    };
    const INSUFFICIENT: BuiltInFormatProfile = BuiltInFormatProfile {
        id: "synthetic-insufficient",
        version: 1,
        grammar: BuiltInGrammar::JsonObjectLine,
        producer_hint: None,
        decisive_clue_codes: &["test.insufficient"],
        score: MIN_STRUCTURED_FORMAT_SCORE - 1,
        fallback: false,
        matcher: always_matches,
    };

    #[test]
    fn built_in_registry_ids_and_versions_are_unique_and_immutable() {
        let mut identities = BUILT_IN_FORMAT_PROFILES
            .iter()
            .map(|profile| (profile.id, profile.version))
            .collect::<Vec<_>>();
        let original_len = identities.len();
        identities.sort_unstable();
        identities.dedup();
        assert_eq!(identities.len(), original_len);
        assert_eq!(
            BUILT_IN_FORMAT_PROFILES
                .iter()
                .filter(|profile| profile.fallback)
                .count(),
            1
        );
    }

    #[test]
    fn fingerprint_separates_grammar_identity_from_optional_producer_hint() {
        let line = "2026-07-29 09:14:05,123 INFO [com.example.Logger] (worker-1) ready";
        let fingerprint = fingerprint_format(line, None);
        assert_eq!(fingerprint.outcome, FormatFingerprintOutcome::Matched);
        assert_eq!(
            fingerprint.format_id,
            Some("date-level-logger-thread-record")
        );
        assert_eq!(fingerprint.format_version, Some(1));
        assert_eq!(fingerprint.producer_hint, Some("wildfly-or-jboss-family"));
        assert_eq!(
            fingerprint.decisive_clue_codes.as_ref(),
            ["content.date_level_logger_thread"]
        );
    }

    #[test]
    fn incidental_key_values_and_extension_disagreement_remain_unknown() {
        let incidental = "request text includes user=42 and retry=true as payload";
        let incidental_fingerprint = fingerprint_format(incidental, None);
        assert_eq!(
            incidental_fingerprint.outcome,
            FormatFingerprintOutcome::Unknown
        );
        assert_eq!(incidental_fingerprint.format_id, Some("plain-line"));

        let path = Path::new("misleading.jsonl");
        let extension_disagreement =
            fingerprint_format("ordinary text that is not a JSON object", Some(path));
        assert_eq!(
            extension_disagreement.outcome,
            FormatFingerprintOutcome::Unknown
        );
        assert_eq!(extension_disagreement.format_id, Some("plain-line"));

        let generic_logfmt = fingerprint_format("alpha=42 outcome=retry", None);
        assert_eq!(generic_logfmt.outcome, FormatFingerprintOutcome::Matched);
        assert_eq!(generic_logfmt.format_id, Some("logfmt-record"));
    }

    #[test]
    fn pseudo_pri_and_non_syslog_jan_text_remain_unknown() {
        for line in [
            "<abc>1 2026-07-29T12:00:00Z host app 1 ID47 - payload",
            "Janitor completed a long ordinary-text maintenance operation",
        ] {
            let fingerprint = fingerprint_format(line, None);
            assert_eq!(
                fingerprint.outcome,
                FormatFingerprintOutcome::Unknown,
                "line={line}"
            );
        }
    }

    #[test]
    fn equal_scores_are_ambiguous_independent_of_registry_order() {
        let forward = [TIED_A, TIED_B, TEST_FALLBACK];
        let reverse = [TIED_B, TIED_A, TEST_FALLBACK];
        let first = fingerprint_with_registry("anything", &forward);
        let second = fingerprint_with_registry("anything", &reverse);

        assert_eq!(first, second);
        assert_eq!(first.outcome, FormatFingerprintOutcome::Ambiguous);
        assert_eq!(first.format_id, None);
        assert_eq!(first.runner_up_margin, Some(0));
        assert_eq!(
            first.competing_formats,
            [
                FormatProfileIdentity {
                    format_id: "synthetic-a",
                    format_version: 1,
                },
                FormatProfileIdentity {
                    format_id: "synthetic-b",
                    format_version: 2,
                },
            ]
        );
    }

    #[test]
    fn insufficient_candidate_score_is_unknown_not_declaration_order() {
        let registry = [INSUFFICIENT, TEST_FALLBACK];
        let fingerprint = fingerprint_with_registry("anything", &registry);
        assert_eq!(fingerprint.outcome, FormatFingerprintOutcome::Unknown);
        assert_eq!(fingerprint.format_id, Some("plain-line"));
        assert_eq!(fingerprint.score, 0);
    }
}
