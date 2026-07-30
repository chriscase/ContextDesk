//! Pure per-source timezone declaration and local-time resolution (#779).
//!
//! This module deliberately does not mutate a corpus. It validates a declaration
//! once, resolves only parser-recognized local calendar evidence, and returns
//! event-level decisions that the atomic reanalysis work in #780 can stage in a
//! transaction. Existing wall-clock events are never rewritten.

use super::parse::ParsedLine;
use super::query::{classify_ts, TimeQuality};
use chrono::{LocalResult, NaiveDateTime, Offset, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use thiserror::Error;

/// Current persisted declaration schema.
pub const TIMEZONE_DECLARATION_SCHEMA_VERSION: u32 = 1;

/// Maximum UTF-8 bytes in one portable source identity.
pub const MAX_TIMEZONE_SOURCE_BYTES: usize = 4_096;

/// Maximum UTF-8 bytes in an IANA timezone identifier.
pub const MAX_IANA_TIMEZONE_BYTES: usize = 128;

/// Earliest exact instant accepted by the current whole-second event store.
pub const MIN_RESOLVED_WALL_SECONDS: i64 = 0;

/// Latest exact instant accepted by the current whole-second event store.
pub const MAX_RESOLVED_WALL_SECONDS: i64 = 4_102_444_800;

/// Durable corpus snapshot against which one preview was calculated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimezoneResolutionScope {
    /// Exact corpus identity.
    pub corpus_id: String,
    /// Durable event revision observed before preview.
    pub event_revision: u64,
}

/// How a timezone declaration became authoritative for this resolution.
///
/// The only applicable basis in this slice is an explicit user declaration.
/// A filename, host, producer hint, abbreviation, sibling source, or model
/// statement cannot be represented as source-native evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimezoneDeclarationBasis {
    /// A person explicitly chose and applied the IANA zone for this source.
    UserDeclared,
}

/// Persistable source-scoped timezone declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTimezoneDeclaration {
    /// Declaration schema version.
    pub schema_version: u32,
    /// Portable source identity, relative to the corpus import root.
    pub source: String,
    /// Canonical IANA timezone identifier supplied by the user.
    pub iana_timezone: String,
    /// Explicit provenance basis; never inferred as source-native.
    pub basis: TimezoneDeclarationBasis,
    /// Unix whole seconds when the user applied the declaration.
    pub declared_at: i64,
    /// Corpus event revision that the atomic apply operation will publish.
    pub applied_revision: u64,
}

/// Provenance attached to one successfully resolved event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimestampResolutionProvenance {
    /// Portable source identity covered by the declaration.
    pub source: String,
    /// User-declared IANA timezone. This is not a source-native claim.
    pub iana_timezone: String,
    /// Explicit declaration basis.
    pub basis: TimezoneDeclarationBasis,
    /// Unix whole seconds when the declaration was applied.
    pub declared_at: i64,
    /// Corpus event revision intended to contain this resolved timestamp.
    pub applied_revision: u64,
    /// Parser-validated source-local timestamp text; the raw event is unchanged.
    pub original_local_timestamp: String,
    /// UTC offset selected by the IANA rules at this exact local instant.
    pub resolved_utc_offset_seconds: i32,
}

/// Why parser-recognized local time could not become one exact instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnresolvedTimestampReason {
    /// The parser found no complete local calendar timestamp for this event.
    NoRecognizedLocalTimestamp,
    /// The recognized prefix lacks enough calendar precision for an instant.
    UnsupportedLocalTimestampShape,
    /// The local time occurs twice when clocks move backward.
    AmbiguousDstFold,
    /// The local time does not exist when clocks move forward or rules skip it.
    NonexistentDstGap,
    /// The resolved instant falls outside the event store's documented range.
    ResolvedInstantOutOfRange,
}

/// Pure event-level resolution decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimestampResolution {
    /// The parser already established wall-clock time. It remains authoritative
    /// and receives no user-declared timezone provenance.
    ExistingWallClock {
        /// Existing Unix whole seconds, unchanged.
        unix_seconds: i64,
    },
    /// The user declaration resolved parser-recognized local calendar evidence.
    Resolved {
        /// Resolved Unix whole seconds.
        unix_seconds: i64,
        /// Explicit user-declaration provenance.
        provenance: TimestampResolutionProvenance,
    },
    /// This event remains order-only.
    Unresolved {
        /// Stable fail-closed reason.
        reason: UnresolvedTimestampReason,
    },
}

/// Bounded aggregate produced without retaining event payloads or revisions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimezoneResolutionPreview {
    /// Exact corpus identity against which this preview was calculated.
    pub corpus_id: String,
    /// Durable event revision against which this preview was calculated.
    pub event_revision: u64,
    /// Stable declaration/snapshot binding that apply must recompute.
    pub declaration_fingerprint: String,
    /// Portable source identity being previewed.
    pub source: String,
    /// Validated IANA zone supplied by the user.
    pub iana_timezone: String,
    /// Events that would gain an exact wall-clock instant.
    pub affected_records: u64,
    /// Existing wall-clock events that remain authoritative and unchanged.
    pub existing_wall_clock_records: u64,
    /// Order-only events without a complete recognized local timestamp.
    pub unchanged_order_only_records: u64,
    /// First resolved instant, inclusive.
    pub first_resolved_instant: Option<i64>,
    /// Last resolved instant, inclusive.
    pub last_resolved_instant: Option<i64>,
    /// Local timestamps rejected because they fall in a DST/rule gap.
    pub dst_gap_count: u64,
    /// Local timestamps rejected because they fall in a DST fold.
    pub dst_fold_count: u64,
    /// Recognized timestamp prefixes lacking enough precision for resolution.
    pub unsupported_timestamp_count: u64,
    /// Resolved instants rejected by the documented event-store range.
    pub out_of_range_count: u64,
}

impl TimezoneResolutionPreview {
    fn new(
        scope: &TimezoneResolutionScope,
        declaration: &SourceTimezoneDeclaration,
        declaration_fingerprint: String,
    ) -> Self {
        Self {
            corpus_id: scope.corpus_id.clone(),
            event_revision: scope.event_revision,
            declaration_fingerprint,
            source: declaration.source.clone(),
            iana_timezone: declaration.iana_timezone.clone(),
            affected_records: 0,
            existing_wall_clock_records: 0,
            unchanged_order_only_records: 0,
            first_resolved_instant: None,
            last_resolved_instant: None,
            dst_gap_count: 0,
            dst_fold_count: 0,
            unsupported_timestamp_count: 0,
            out_of_range_count: 0,
        }
    }

    fn observe(&mut self, resolution: &TimestampResolution) {
        match resolution {
            TimestampResolution::ExistingWallClock { .. } => {
                self.existing_wall_clock_records =
                    self.existing_wall_clock_records.saturating_add(1);
            }
            TimestampResolution::Resolved { unix_seconds, .. } => {
                self.affected_records = self.affected_records.saturating_add(1);
                self.first_resolved_instant = Some(
                    self.first_resolved_instant
                        .map_or(*unix_seconds, |value| value.min(*unix_seconds)),
                );
                self.last_resolved_instant = Some(
                    self.last_resolved_instant
                        .map_or(*unix_seconds, |value| value.max(*unix_seconds)),
                );
            }
            TimestampResolution::Unresolved { reason } => match reason {
                UnresolvedTimestampReason::AmbiguousDstFold => {
                    self.dst_fold_count = self.dst_fold_count.saturating_add(1);
                }
                UnresolvedTimestampReason::NonexistentDstGap => {
                    self.dst_gap_count = self.dst_gap_count.saturating_add(1);
                }
                UnresolvedTimestampReason::UnsupportedLocalTimestampShape => {
                    self.unsupported_timestamp_count =
                        self.unsupported_timestamp_count.saturating_add(1);
                }
                UnresolvedTimestampReason::ResolvedInstantOutOfRange => {
                    self.out_of_range_count = self.out_of_range_count.saturating_add(1);
                }
                UnresolvedTimestampReason::NoRecognizedLocalTimestamp => {
                    self.unchanged_order_only_records =
                        self.unchanged_order_only_records.saturating_add(1);
                }
            },
        }
    }
}

/// Validation or source-boundary failure. No corpus mutation occurs in this API.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TimezoneResolutionError {
    /// The declaration schema is not supported by this reader.
    #[error("unsupported timezone declaration schema version: {0}")]
    UnsupportedSchema(u32),
    /// The source identity is empty, oversized, absolute, or non-portable.
    #[error("invalid portable source identity")]
    InvalidSource,
    /// The zone is not a bounded, recognized IANA timezone identifier.
    #[error("invalid IANA timezone")]
    InvalidIanaTimezone,
    /// Declaration time is outside Chrono's representable UTC range.
    #[error("invalid declaration time")]
    InvalidDeclarationTime,
    /// Applied revisions begin at one; zero is not a published revision.
    #[error("applied revision must be greater than zero")]
    InvalidAppliedRevision,
    /// The caller attempted to apply one source's declaration to another.
    #[error("timezone declaration source does not match record source")]
    SourceMismatch,
    /// Preview was not bound to one safe exact corpus identity.
    #[error("invalid timezone preview corpus identity")]
    InvalidCorpusIdentity,
    /// The declaration's intended revision is not the next preview revision.
    #[error("timezone declaration revision does not match preview snapshot")]
    AppliedRevisionMismatch,
    /// The current revision cannot be advanced safely.
    #[error("timezone event revision overflow")]
    EventRevisionOverflow,
}

/// Validated resolver reusable across a source scan.
///
/// Construct this before opening a write transaction. A malformed timezone or
/// declaration therefore fails before #780 can stage any event updates.
#[derive(Debug, Clone)]
pub struct SourceTimezoneResolver {
    declaration: SourceTimezoneDeclaration,
    timezone: Tz,
}

impl SourceTimezoneResolver {
    /// Validate one persistable declaration and compile its IANA rules.
    pub fn new(declaration: SourceTimezoneDeclaration) -> Result<Self, TimezoneResolutionError> {
        validate_declaration(&declaration)?;
        let timezone = Tz::from_str(&declaration.iana_timezone)
            .map_err(|_| TimezoneResolutionError::InvalidIanaTimezone)?;
        Ok(Self {
            declaration,
            timezone,
        })
    }

    /// Return the validated declaration intended for persistence by #780.
    pub fn declaration(&self) -> &SourceTimezoneDeclaration {
        &self.declaration
    }

    /// Resolve one parsed event without mutating it or its corpus.
    ///
    /// The source check is mandatory. Only `unresolved_local_timestamp`
    /// evidence emitted by the parser is eligible for resolution. Existing
    /// wall-clock timestamps, including explicit-offset records, always win.
    pub fn resolve(
        &self,
        source: &str,
        parsed: &ParsedLine,
    ) -> Result<TimestampResolution, TimezoneResolutionError> {
        if source != self.declaration.source {
            return Err(TimezoneResolutionError::SourceMismatch);
        }

        // Fail safely even if a future or malformed caller presents
        // contradictory fields. Existing wall time is authoritative and is
        // never replaced by a declaration.
        if let Some(unix_seconds) = parsed.ts.filter(|ts| classify_ts(*ts) == TimeQuality::Wall) {
            return Ok(TimestampResolution::ExistingWallClock { unix_seconds });
        }

        let Some(local_text) = parsed.unresolved_local_timestamp.as_deref() else {
            return Ok(TimestampResolution::Unresolved {
                reason: UnresolvedTimestampReason::NoRecognizedLocalTimestamp,
            });
        };

        let Some(local) = parse_complete_local_timestamp(local_text) else {
            return Ok(TimestampResolution::Unresolved {
                reason: UnresolvedTimestampReason::UnsupportedLocalTimestampShape,
            });
        };

        match self.timezone.from_local_datetime(&local) {
            LocalResult::Single(resolved) => {
                let unix_seconds = resolved.timestamp();
                if !(MIN_RESOLVED_WALL_SECONDS..=MAX_RESOLVED_WALL_SECONDS).contains(&unix_seconds)
                {
                    return Ok(TimestampResolution::Unresolved {
                        reason: UnresolvedTimestampReason::ResolvedInstantOutOfRange,
                    });
                }
                Ok(TimestampResolution::Resolved {
                    unix_seconds,
                    provenance: TimestampResolutionProvenance {
                        source: self.declaration.source.clone(),
                        iana_timezone: self.declaration.iana_timezone.clone(),
                        basis: self.declaration.basis,
                        declared_at: self.declaration.declared_at,
                        applied_revision: self.declaration.applied_revision,
                        original_local_timestamp: local_text.to_string(),
                        resolved_utc_offset_seconds: resolved.offset().fix().local_minus_utc(),
                    },
                })
            }
            LocalResult::Ambiguous(_, _) => Ok(TimestampResolution::Unresolved {
                reason: UnresolvedTimestampReason::AmbiguousDstFold,
            }),
            LocalResult::None => Ok(TimestampResolution::Unresolved {
                reason: UnresolvedTimestampReason::NonexistentDstGap,
            }),
        }
    }

    /// Preview a source scan using bounded counters only.
    ///
    /// #780 can run this once for confirmation, then call [`Self::resolve`]
    /// again while staging exact event revisions in one DuckDB transaction.
    pub fn preview<'a>(
        &self,
        scope: &TimezoneResolutionScope,
        records: impl IntoIterator<Item = (&'a str, &'a ParsedLine)>,
    ) -> Result<TimezoneResolutionPreview, TimezoneResolutionError> {
        validate_scope(scope, &self.declaration)?;
        let declaration_fingerprint = declaration_fingerprint(scope, &self.declaration);
        let mut preview =
            TimezoneResolutionPreview::new(scope, &self.declaration, declaration_fingerprint);
        for (source, parsed) in records {
            let resolution = self.resolve(source, parsed)?;
            preview.observe(&resolution);
        }
        Ok(preview)
    }
}

fn validate_scope(
    scope: &TimezoneResolutionScope,
    declaration: &SourceTimezoneDeclaration,
) -> Result<(), TimezoneResolutionError> {
    if scope.corpus_id.is_empty()
        || scope.corpus_id.len() > 128
        || !scope
            .corpus_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(TimezoneResolutionError::InvalidCorpusIdentity);
    }
    let next_revision = scope
        .event_revision
        .checked_add(1)
        .ok_or(TimezoneResolutionError::EventRevisionOverflow)?;
    if next_revision != declaration.applied_revision {
        return Err(TimezoneResolutionError::AppliedRevisionMismatch);
    }
    Ok(())
}

fn declaration_fingerprint(
    scope: &TimezoneResolutionScope,
    declaration: &SourceTimezoneDeclaration,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"contextdesk.timezone-preview.v1\0");
    hasher.update(scope.corpus_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(scope.event_revision.to_le_bytes());
    hasher.update(b"\0");
    hasher.update(declaration.source.as_bytes());
    hasher.update(b"\0");
    hasher.update(declaration.iana_timezone.as_bytes());
    hasher.update(b"\0user_declared\0");
    hasher.update(declaration.applied_revision.to_le_bytes());
    format!("{:x}", hasher.finalize())
}

fn validate_declaration(
    declaration: &SourceTimezoneDeclaration,
) -> Result<(), TimezoneResolutionError> {
    if declaration.schema_version != TIMEZONE_DECLARATION_SCHEMA_VERSION {
        return Err(TimezoneResolutionError::UnsupportedSchema(
            declaration.schema_version,
        ));
    }
    if !valid_portable_source(&declaration.source) {
        return Err(TimezoneResolutionError::InvalidSource);
    }
    if declaration.iana_timezone.is_empty()
        || declaration.iana_timezone.len() > MAX_IANA_TIMEZONE_BYTES
        || declaration.iana_timezone.chars().any(char::is_control)
    {
        return Err(TimezoneResolutionError::InvalidIanaTimezone);
    }
    if chrono::DateTime::<Utc>::from_timestamp(declaration.declared_at, 0).is_none() {
        return Err(TimezoneResolutionError::InvalidDeclarationTime);
    }
    if declaration.applied_revision == 0 {
        return Err(TimezoneResolutionError::InvalidAppliedRevision);
    }
    Ok(())
}

fn valid_portable_source(source: &str) -> bool {
    if source.is_empty()
        || source.len() > MAX_TIMEZONE_SOURCE_BYTES
        || source.starts_with('/')
        || source.starts_with('\\')
        || source.contains('\\')
        || source.contains(':')
        || source.chars().any(char::is_control)
    {
        return false;
    }
    source
        .split('/')
        .all(|component| !component.is_empty() && component != "." && component != "..")
}

fn parse_complete_local_timestamp(value: &str) -> Option<NaiveDateTime> {
    let mut canonical = value.trim().to_string();

    // WildFly/JBoss and classic Elasticsearch retain exactly three fractional
    // digits and accept comma or dot separators.
    if canonical.len() == 23
        && canonical
            .as_bytes()
            .get(10)
            .is_some_and(|value| matches!(value, b' ' | b'T'))
        && canonical
            .as_bytes()
            .get(19)
            .is_some_and(|value| matches!(value, b',' | b'.'))
    {
        canonical.replace_range(10..11, " ");
        canonical.replace_range(19..20, ".");
        return NaiveDateTime::parse_from_str(&canonical, "%Y-%m-%d %H:%M:%S%.3f").ok();
    }

    // This also supports future parser-recognized offsetless RFC3339-shaped
    // evidence without accepting abbreviations or guessing missing fields.
    NaiveDateTime::parse_from_str(&canonical, "%Y-%m-%dT%H:%M:%S%.f")
        .ok()
        .or_else(|| NaiveDateTime::parse_from_str(&canonical, "%Y-%m-%d %H:%M:%S%.f").ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::{parse_line, LogFormat};

    const SOURCE: &str = "server/server.log";

    fn declaration(zone: &str) -> SourceTimezoneDeclaration {
        SourceTimezoneDeclaration {
            schema_version: TIMEZONE_DECLARATION_SCHEMA_VERSION,
            source: SOURCE.into(),
            iana_timezone: zone.into(),
            basis: TimezoneDeclarationBasis::UserDeclared,
            declared_at: 1_753_833_600,
            applied_revision: 7,
        }
    }

    fn scope() -> TimezoneResolutionScope {
        TimezoneResolutionScope {
            corpus_id: "corpus-779".into(),
            event_revision: 6,
        }
    }

    #[test]
    fn invalid_zone_and_source_fail_before_resolution() {
        let invalid_zone = SourceTimezoneResolver::new(declaration("Not/A_Real_Zone"));
        assert_eq!(
            invalid_zone.unwrap_err(),
            TimezoneResolutionError::InvalidIanaTimezone
        );

        for source in ["", "/server.log", "../server.log", "C:\\server.log"] {
            let mut invalid = declaration("Europe/Berlin");
            invalid.source = source.into();
            assert_eq!(
                SourceTimezoneResolver::new(invalid).unwrap_err(),
                TimezoneResolutionError::InvalidSource
            );
        }
    }

    #[test]
    fn multiple_iana_zones_resolve_the_same_local_text_deterministically() {
        let line = "2021-03-05 02:53:53,654 ERROR [org.jboss.Clock] (worker) synthetic failure";
        let parsed = parse_line(line, None, 10);

        let utc = SourceTimezoneResolver::new(declaration("UTC"))
            .unwrap()
            .resolve(SOURCE, &parsed)
            .unwrap();
        let new_york = SourceTimezoneResolver::new(declaration("America/New_York"))
            .unwrap()
            .resolve(SOURCE, &parsed)
            .unwrap();

        assert_eq!(resolved_seconds(&utc), 1_614_912_833);
        assert_eq!(resolved_seconds(&new_york), 1_614_930_833);
    }

    #[test]
    fn dst_fold_gap_and_historic_rule_change_fail_closed() {
        let new_york = SourceTimezoneResolver::new(declaration("America/New_York")).unwrap();
        let fold = parse_line(
            "2021-11-07 01:30:00,000 INFO [org.jboss.Clock] (worker) fold",
            None,
            1,
        );
        let gap = parse_line(
            "2021-03-14 02:30:00,000 INFO [org.jboss.Clock] (worker) gap",
            None,
            2,
        );
        assert_eq!(
            new_york.resolve(SOURCE, &fold).unwrap(),
            TimestampResolution::Unresolved {
                reason: UnresolvedTimestampReason::AmbiguousDstFold
            }
        );
        assert_eq!(
            new_york.resolve(SOURCE, &gap).unwrap(),
            TimestampResolution::Unresolved {
                reason: UnresolvedTimestampReason::NonexistentDstGap
            }
        );

        let apia = SourceTimezoneResolver::new(declaration("Pacific/Apia")).unwrap();
        let skipped_day = parse_line(
            "2011-12-30 12:00:00,000 INFO [org.jboss.Clock] (worker) skipped day",
            None,
            3,
        );
        assert_eq!(
            apia.resolve(SOURCE, &skipped_day).unwrap(),
            TimestampResolution::Unresolved {
                reason: UnresolvedTimestampReason::NonexistentDstGap
            }
        );
    }

    #[test]
    fn leap_day_resolves_and_provenance_is_only_user_declared() {
        let parsed = parse_line(
            "2020-02-29 23:59:59,999 INFO [org.jboss.Clock] (worker) leap day",
            None,
            4,
        );
        let result = SourceTimezoneResolver::new(declaration("Europe/Berlin"))
            .unwrap()
            .resolve(SOURCE, &parsed)
            .unwrap();
        let TimestampResolution::Resolved {
            unix_seconds,
            provenance,
        } = result
        else {
            panic!("expected resolved leap-day timestamp");
        };
        assert_eq!(unix_seconds, 1_583_017_199);
        assert_eq!(provenance.basis, TimezoneDeclarationBasis::UserDeclared);
        assert_eq!(provenance.iana_timezone, "Europe/Berlin");
        assert_eq!(
            provenance.original_local_timestamp,
            "2020-02-29 23:59:59,999"
        );
        assert_eq!(provenance.resolved_utc_offset_seconds, 3_600);
    }

    #[test]
    fn explicit_offset_remains_authoritative_in_preview() {
        let local = parse_line(
            "2021-03-05 02:53:53,654 ERROR [org.jboss.Clock] (worker) local",
            None,
            10,
        );
        let explicit = parse_line(
            "2021-03-05 02:53:53,654Z ERROR [org.jboss.Clock] (worker) explicit",
            None,
            11,
        );
        let order_only = parse_line("ordinary continuation", Some(LogFormat::Plain), 12);
        let resolver =
            SourceTimezoneResolver::new(declaration("America/New_York")).expect("valid resolver");
        let preview = resolver
            .preview(
                &scope(),
                [(SOURCE, &local), (SOURCE, &explicit), (SOURCE, &order_only)],
            )
            .unwrap();

        assert_eq!(preview.corpus_id, "corpus-779");
        assert_eq!(preview.event_revision, 6);
        assert_eq!(preview.declaration_fingerprint.len(), 64);
        assert_eq!(preview.affected_records, 1);
        assert_eq!(preview.existing_wall_clock_records, 1);
        assert_eq!(preview.unchanged_order_only_records, 1);
        assert_eq!(preview.first_resolved_instant, Some(1_614_930_833));
        assert_eq!(preview.last_resolved_instant, Some(1_614_930_833));

        assert_eq!(
            resolver.resolve(SOURCE, &explicit).unwrap(),
            TimestampResolution::ExistingWallClock {
                unix_seconds: 1_614_912_833
            }
        );
    }

    #[test]
    fn incomplete_abbreviation_shape_stays_order_only_with_an_iana_declaration() {
        let parsed = parse_line(
            "2021-03-05T00:06,350 CET. INFO: synthetic payload",
            None,
            44,
        );
        let result = SourceTimezoneResolver::new(declaration("Europe/Berlin"))
            .unwrap()
            .resolve(SOURCE, &parsed)
            .unwrap();
        assert_eq!(
            result,
            TimestampResolution::Unresolved {
                reason: UnresolvedTimestampReason::UnsupportedLocalTimestampShape
            }
        );
        assert_eq!(parsed.ts, Some(44));
        assert_eq!(
            parsed.unresolved_local_timestamp.as_deref(),
            Some("2021-03-05T00:06,350 CET")
        );
    }

    #[test]
    fn resolver_rejects_cross_source_application() {
        let parsed = parse_line(
            "2021-03-05 02:53:53,654 INFO [org.jboss.Clock] (worker) local",
            None,
            5,
        );
        let resolver = SourceTimezoneResolver::new(declaration("UTC")).unwrap();
        assert_eq!(
            resolver.resolve("other/server.log", &parsed).unwrap_err(),
            TimezoneResolutionError::SourceMismatch
        );
    }

    #[test]
    fn preview_is_bound_to_exact_corpus_revision_and_declaration() {
        let resolver = SourceTimezoneResolver::new(declaration("Europe/Berlin")).expect("resolver");
        let empty: [(&str, &ParsedLine); 0] = [];
        let preview = resolver.preview(&scope(), empty).expect("empty preview");
        assert_eq!(preview.affected_records, 0);
        assert_eq!(preview.existing_wall_clock_records, 0);
        assert_eq!(preview.unchanged_order_only_records, 0);

        let mut later_declaration = declaration("Europe/Berlin");
        later_declaration.declared_at += 300;
        let later = SourceTimezoneResolver::new(later_declaration)
            .expect("later resolver")
            .preview(&scope(), empty)
            .expect("later preview");
        assert_eq!(
            later.declaration_fingerprint, preview.declaration_fingerprint,
            "preview binding must not freeze the eventual apply timestamp"
        );

        let mut stale = scope();
        stale.event_revision = 7;
        assert_eq!(
            resolver.preview(&stale, empty).unwrap_err(),
            TimezoneResolutionError::AppliedRevisionMismatch
        );

        let mut invalid = scope();
        invalid.corpus_id = "../corpus".into();
        assert_eq!(
            resolver.preview(&invalid, empty).unwrap_err(),
            TimezoneResolutionError::InvalidCorpusIdentity
        );
    }

    #[test]
    fn resolved_local_instants_outside_the_store_range_fail_closed() {
        let resolver = SourceTimezoneResolver::new(declaration("UTC")).expect("resolver");
        let line = parse_line(
            "1960-03-05 02:53:53,654 ERROR [org.jboss.Clock] (worker) old",
            None,
            12,
        );
        assert_eq!(
            resolver.resolve(SOURCE, &line).unwrap(),
            TimestampResolution::Unresolved {
                reason: UnresolvedTimestampReason::ResolvedInstantOutOfRange
            }
        );
    }

    fn resolved_seconds(value: &TimestampResolution) -> i64 {
        match value {
            TimestampResolution::Resolved { unix_seconds, .. } => *unix_seconds,
            other => panic!("expected resolved timestamp, got {other:?}"),
        }
    }
}
