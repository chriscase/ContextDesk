//! Canonical governed log citation identities (#698 / #701 exact-nav).
//!
//! Only lowercase `log_event:<u64>` and `log_template:<u64>` are accepted.
//! The id is digits only, canonical (no leading zeros except `0`), and
//! overflow past `u64::MAX` is rejected explicitly.
//!
//! Shared accept/reject fixtures live at
//! `fixtures/citation-contracts/governed-log-citation-ids.v1.json` and are asserted by
//! both this module and the TypeScript mirror.

/// Kind of a governed log evidence identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GovernedLogCitationKind {
    /// `log_event:<seq>` — corpus event sequence.
    Event,
    /// `log_template:<id>` — Drain template id.
    Template,
}

impl GovernedLogCitationKind {
    /// Scheme prefix including the trailing colon (`log_event:` / `log_template:`).
    pub fn prefix(self) -> &'static str {
        match self {
            Self::Event => "log_event:",
            Self::Template => "log_template:",
        }
    }

    /// Short kind name used in shared fixtures (`event` / `template`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Template => "template",
        }
    }

    /// Parse a fixture / DTO kind string (`event` / `template`).
    pub fn parse_kind(s: &str) -> Option<Self> {
        match s {
            "event" => Some(Self::Event),
            "template" => Some(Self::Template),
            _ => None,
        }
    }
}

/// Parsed governed log citation: kind + canonical decimal id + numeric value.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct GovernedLogCitationId {
    /// Event or template.
    pub kind: GovernedLogCitationKind,
    /// Canonical decimal digit string of [`Self::value`] (never a float path).
    pub id: String,
    /// Trusted u64 value.
    pub value: u64,
}

impl GovernedLogCitationId {
    /// Format the canonical identity string (`log_event:42`, …).
    pub fn format(&self) -> String {
        format_governed_log_citation_id(self.kind, self.value)
    }
}

/// Format a governed identity from kind + u64 (always canonical).
pub fn format_governed_log_citation_id(kind: GovernedLogCitationKind, value: u64) -> String {
    format!("{}{}", kind.prefix(), value)
}

/// Parse a governed log citation identity.
///
/// Accepts optional surrounding whitespace. Rejects uppercase schemes,
/// non-digits, leading zeros (except the single digit `0`), overflow past
/// `u64::MAX`, and any leading/trailing junk after the scheme.
pub fn parse_governed_log_citation_id(raw: &str) -> Option<GovernedLogCitationId> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }

    let (kind, rest) = if let Some(rest) = s.strip_prefix(GovernedLogCitationKind::Event.prefix()) {
        (GovernedLogCitationKind::Event, rest)
    } else {
        let rest = s.strip_prefix(GovernedLogCitationKind::Template.prefix())?;
        (GovernedLogCitationKind::Template, rest)
    };

    parse_canonical_u64_digits(rest).map(|value| GovernedLogCitationId {
        kind,
        id: value.to_string(),
        value,
    })
}

/// True when `raw` is a fully valid governed log citation identity.
pub fn is_governed_log_citation_id(raw: &str) -> bool {
    parse_governed_log_citation_id(raw).is_some()
}

/// Parse a decimal digit string as a canonical u64.
///
/// Rules:
/// - non-empty
/// - digits only (`0`-`9`)
/// - no leading zeros unless the entire id is `0`
/// - value ≤ `u64::MAX` (explicit overflow reject)
fn parse_canonical_u64_digits(digits: &str) -> Option<u64> {
    if digits.is_empty() {
        return None;
    }
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Canonical form: no leading zeros except the value zero itself.
    if digits.len() > 1 && digits.as_bytes()[0] == b'0' {
        return None;
    }
    // Overflow: reject anything larger than u64::MAX without wrapping.
    digits.parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct Fixture {
        catalog_version: String,
        accept: Vec<AcceptCase>,
        reject: Vec<RejectCase>,
    }

    #[derive(Debug, Deserialize)]
    struct AcceptCase {
        input: String,
        kind: String,
        id: String,
    }

    #[derive(Debug, Deserialize)]
    struct RejectCase {
        input: String,
        #[allow(dead_code)]
        reason: String,
    }

    const FIXTURE: &str =
        include_str!("../../../../fixtures/citation-contracts/governed-log-citation-ids.v1.json");
    const CATALOG_VERSION: &str = "contextdesk.governed_log_citation_ids.v1";

    #[test]
    fn shared_accept_reject_fixtures_match_rust_parser() {
        let fixture: Fixture =
            serde_json::from_str(FIXTURE).expect("shared governed log citation fixture must parse");
        assert_eq!(
            fixture.catalog_version, CATALOG_VERSION,
            "catalog fixture version must move with production rules"
        );

        for case in &fixture.accept {
            let parsed = parse_governed_log_citation_id(&case.input).unwrap_or_else(|| {
                panic!("expected accept for {:?}", case.input);
            });
            let kind = GovernedLogCitationKind::parse_kind(&case.kind)
                .unwrap_or_else(|| panic!("unknown fixture kind {}", case.kind));
            assert_eq!(parsed.kind, kind, "kind for {:?}", case.input);
            assert_eq!(parsed.id, case.id, "id string for {:?}", case.input);
            let expected_value: u64 = case
                .id
                .parse()
                .unwrap_or_else(|_| panic!("fixture id must be u64 decimal: {}", case.id));
            assert_eq!(parsed.value, expected_value, "value for {:?}", case.input);
            // Round-trip: formatted form is always canonical (trimmed input may differ).
            assert_eq!(
                parse_governed_log_citation_id(&parsed.format()).as_ref(),
                Some(&parsed),
                "round-trip for {:?}",
                case.input
            );
        }

        for case in &fixture.reject {
            assert!(
                parse_governed_log_citation_id(&case.input).is_none(),
                "expected reject for {:?} ({})",
                case.input,
                case.reason
            );
        }
    }

    #[test]
    fn u64_max_and_overflow_boundaries() {
        let max = format_governed_log_citation_id(GovernedLogCitationKind::Event, u64::MAX);
        assert_eq!(max, "log_event:18446744073709551615");
        let parsed = parse_governed_log_citation_id(&max).expect("u64::MAX must accept");
        assert_eq!(parsed.value, u64::MAX);
        assert_eq!(parsed.id, "18446744073709551615");

        assert!(parse_governed_log_citation_id("log_event:18446744073709551616").is_none());
        // Unsafe-for-JS integers still accept as string-identical u64 values.
        let unsafe_js = parse_governed_log_citation_id("log_event:9007199254740993")
            .expect("must accept beyond Number.MAX_SAFE_INTEGER");
        assert_eq!(unsafe_js.id, "9007199254740993");
        assert_eq!(unsafe_js.value, 9007199254740993);
    }

    #[test]
    fn format_is_always_canonical() {
        assert_eq!(
            format_governed_log_citation_id(GovernedLogCitationKind::Template, 0),
            "log_template:0"
        );
        assert_eq!(
            format_governed_log_citation_id(GovernedLogCitationKind::Event, 42),
            "log_event:42"
        );
    }

    #[test]
    fn rejects_case_and_grammar_adversaries() {
        for bad in [
            "LOG_EVENT:1",
            "log_Event:1",
            "log_event:01",
            "log_event:",
            "log_event:1a",
            "log_event:1.0",
            "log_event: 1",
            "log_event:\t1",
        ] {
            // Internal whitespace after the colon is not trimmed per-component.
            assert!(
                parse_governed_log_citation_id(bad).is_none(),
                "should reject {bad:?}"
            );
        }
        // Outer trim only:
        assert_eq!(
            parse_governed_log_citation_id("\nlog_event:3\n").map(|p| p.value),
            Some(3)
        );
    }
}
