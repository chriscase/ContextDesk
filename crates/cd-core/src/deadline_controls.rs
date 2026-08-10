//! Friendly whole-turn deadline controls shared by CLI and desktop hosts.
//!
//! Precedence for the effective whole-turn ceiling:
//!
//! 1. **Per-turn CLI override** (`--deadline`) — explicit for that turn only
//! 2. **Saved explicit policy** (`router.deadline_is_explicit = true`)
//! 3. **Adaptive policy** (`router.deadline_is_explicit = false`) —
//!    provider-class totals from [`crate::router::TurnDeadlinePlan`]
//!
//! This module parses and formats user-facing durations and converts policy
//! choices into the two `RouterBudget` deadline fields. It does **not** change
//! provider transport, retries, multi-stage allocation, or phase math.
//! Adaptive *latency learning* is explicitly out of scope; controls only.

use crate::router::RouterBudget;
use serde::Serialize;
use std::fmt;

/// Smallest allowed explicit whole-turn ceiling (matches [`RouterBudget::sanitized`]).
pub const MIN_DEADLINE_MS: u64 = 500;
/// Largest allowed explicit whole-turn ceiling (matches [`RouterBudget::sanitized`]).
pub const MAX_DEADLINE_MS: u64 = 600_000;
/// Fixed "Standard" preset: 3 minutes (managed adaptive default total).
pub const STANDARD_DEADLINE_MS: u64 = 180_000;
/// Fixed "Patient" preset: 5 minutes (local/private adaptive default total).
pub const PATIENT_DEADLINE_MS: u64 = 300_000;

/// Why a duration string was rejected. Display text is stable for CLI users.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeadlineParseError {
    /// Empty or whitespace-only input.
    Empty,
    /// Non-integer magnitude, decimal, sign, or junk before the unit.
    InvalidNumber,
    /// Unit missing or not one of `ms`, `s`, `m`.
    InvalidUnit,
    /// Mixed units, trailing garbage, or multiple magnitudes.
    Malformed,
    /// Parsed magnitude overflowed `u64` before unit scaling.
    Overflow,
    /// Value outside [`MIN_DEADLINE_MS`]..=[`MAX_DEADLINE_MS`].
    OutOfRange {
        /// Parsed millisecond value (when known).
        ms: u64,
    },
}

impl fmt::Display for DeadlineParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "deadline duration is empty"),
            Self::InvalidNumber => write!(
                f,
                "deadline duration must be a positive whole number with unit ms, s, or m \
                 (for example 90s, 3m, or 500ms); decimals and negatives are not accepted"
            ),
            Self::InvalidUnit => write!(
                f,
                "deadline unit must be ms, s, or m (for example 90s, 3m, or 10m)"
            ),
            Self::Malformed => write!(
                f,
                "deadline duration is malformed; use one integer and one unit \
                 (for example 90s, 3m, or 500ms)"
            ),
            Self::Overflow => write!(f, "deadline duration is too large to represent"),
            Self::OutOfRange { ms } => write!(
                f,
                "deadline {ms}ms is outside the allowed range {MIN_DEADLINE_MS}ms–{MAX_DEADLINE_MS}ms \
                 (0.5s–10m); the value was not changed"
            ),
        }
    }
}

impl std::error::Error for DeadlineParseError {}

/// Product-facing deadline policy mode for Settings and CLI show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeadlinePolicyMode {
    /// Adaptive by provider class (does not invent an explicit ceiling).
    Adaptive,
    /// Explicit whole-turn ceiling from a fixed preset or custom duration.
    Explicit,
}

/// Fixed presets offered in Settings (within the 10-minute maximum).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeadlinePreset {
    /// Adaptive policy; stored `deadline_ms` is left unchanged.
    Auto,
    /// Explicit [`STANDARD_DEADLINE_MS`].
    Standard,
    /// Explicit [`PATIENT_DEADLINE_MS`].
    Patient,
    /// Explicit user-authored duration.
    Custom,
}

impl DeadlinePreset {
    /// Stable machine token for CLI/GUI parity tests.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Standard => "standard",
            Self::Patient => "patient",
            Self::Custom => "custom",
        }
    }
}

/// Parse a friendly duration into milliseconds without clamping.
///
/// Accepted grammar (case-insensitive unit, optional surrounding whitespace):
/// - `<u64>ms` — milliseconds
/// - `<u64>s` — seconds
/// - `<u64>m` — minutes
///
/// Rejects empty input, decimals, signs, mixed/unknown units, overflow, and
/// values outside [`MIN_DEADLINE_MS`]..=[`MAX_DEADLINE_MS`].
pub fn parse_deadline_duration(input: &str) -> Result<u64, DeadlineParseError> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(DeadlineParseError::Empty);
    }
    // ASCII-only magnitude + unit keeps the grammar unambiguous and avoids
    // locale decimal commas being misread as valid input.
    let bytes = raw.as_bytes();
    let mut i = 0usize;
    if bytes[i] == b'+' || bytes[i] == b'-' {
        return Err(DeadlineParseError::InvalidNumber);
    }
    let start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return Err(DeadlineParseError::InvalidNumber);
    }
    // Reject decimals / fraction markers before the unit.
    if i < bytes.len() && (bytes[i] == b'.' || bytes[i] == b',') {
        return Err(DeadlineParseError::InvalidNumber);
    }
    let number =
        std::str::from_utf8(&bytes[start..i]).map_err(|_| DeadlineParseError::Malformed)?;
    let magnitude: u64 = number.parse().map_err(|_| DeadlineParseError::Overflow)?;
    if magnitude == 0 {
        return Err(DeadlineParseError::InvalidNumber);
    }
    // Unit is ASCII-only (ms/s/m) and must be immediately adjacent to the
    // digits. Take the remainder as bytes to avoid clippy::string_slice on
    // potentially multi-byte user input. The complete input was already
    // trimmed above, so internal whitespace (for example `3 m`) remains
    // invalid and matches the desktop TypeScript grammar.
    let unit = std::str::from_utf8(&bytes[i..])
        .map_err(|_| DeadlineParseError::Malformed)?
        .to_ascii_lowercase();
    if unit.is_empty() {
        return Err(DeadlineParseError::InvalidUnit);
    }
    // Single unit only; reject "1m30s", "ms", "sec", internal spaces, etc.
    let ms = match unit.as_str() {
        "ms" => magnitude,
        "s" => magnitude
            .checked_mul(1_000)
            .ok_or(DeadlineParseError::Overflow)?,
        "m" => magnitude
            .checked_mul(60_000)
            .ok_or(DeadlineParseError::Overflow)?,
        _ if unit.chars().any(|c| c.is_whitespace()) => {
            return Err(DeadlineParseError::Malformed);
        }
        _ => return Err(DeadlineParseError::InvalidUnit),
    };
    if !(MIN_DEADLINE_MS..=MAX_DEADLINE_MS).contains(&ms) {
        return Err(DeadlineParseError::OutOfRange { ms });
    }
    Ok(ms)
}

/// Format milliseconds as a compact human duration (`500ms`, `90s`, `3m`, …).
///
/// Prefers whole minutes, then whole seconds, else milliseconds. Does not
/// invent fractional units.
pub fn format_deadline_ms(ms: u64) -> String {
    if ms > 0 && ms.is_multiple_of(60_000) {
        format!("{}m", ms / 60_000)
    } else if ms > 0 && ms.is_multiple_of(1_000) {
        format!("{}s", ms / 1_000)
    } else {
        format!("{ms}ms")
    }
}

/// Classify a budget as adaptive or explicit for product surfaces.
pub fn policy_mode(budget: &RouterBudget) -> DeadlinePolicyMode {
    if budget.deadline_is_explicit {
        DeadlinePolicyMode::Explicit
    } else {
        DeadlinePolicyMode::Adaptive
    }
}

/// Best-effort preset classification for Settings (exact fixed presets only).
pub fn classify_preset(budget: &RouterBudget) -> DeadlinePreset {
    if !budget.deadline_is_explicit {
        return DeadlinePreset::Auto;
    }
    match budget.deadline_ms {
        STANDARD_DEADLINE_MS => DeadlinePreset::Standard,
        PATIENT_DEADLINE_MS => DeadlinePreset::Patient,
        _ => DeadlinePreset::Custom,
    }
}

/// Apply the Auto (adaptive) policy. Preserves the stored numeric value.
pub fn apply_auto_policy(budget: &mut RouterBudget) {
    budget.deadline_is_explicit = false;
}

/// Apply the Standard fixed preset as an explicit ceiling.
pub fn apply_standard_preset(budget: &mut RouterBudget) {
    budget.deadline_ms = STANDARD_DEADLINE_MS;
    budget.deadline_is_explicit = true;
}

/// Apply the Patient fixed preset as an explicit ceiling.
pub fn apply_patient_preset(budget: &mut RouterBudget) {
    budget.deadline_ms = PATIENT_DEADLINE_MS;
    budget.deadline_is_explicit = true;
}

/// Apply an explicit custom duration already validated by
/// [`parse_deadline_duration`] (or a known-in-range host value).
pub fn apply_explicit_deadline_ms(
    budget: &mut RouterBudget,
    ms: u64,
) -> Result<(), DeadlineParseError> {
    if !(MIN_DEADLINE_MS..=MAX_DEADLINE_MS).contains(&ms) {
        return Err(DeadlineParseError::OutOfRange { ms });
    }
    budget.deadline_ms = ms;
    budget.deadline_is_explicit = true;
    Ok(())
}

/// Apply a per-turn override: always explicit for that turn's host budget.
///
/// Callers must not persist the resulting budget to `AppConfig`.
pub fn apply_turn_override(budget: &mut RouterBudget, ms: u64) -> Result<(), DeadlineParseError> {
    apply_explicit_deadline_ms(budget, ms)
}

/// Read-only deadline status for CLI/desktop machine output.
///
/// Contains no profile ids, endpoints, model ids, paths, or secrets.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DeadlineStatus {
    /// Stable schema id for JSON consumers.
    pub schema: &'static str,
    /// Adaptive vs explicit.
    pub policy: DeadlinePolicyMode,
    /// Stored numeric ceiling (fallback under adaptive; active under explicit).
    pub deadline_ms: u64,
    /// Human form of [`Self::deadline_ms`].
    pub deadline_human: String,
    /// True when the stored value is an explicit user ceiling.
    pub deadline_is_explicit: bool,
    /// Allowed minimum (ms).
    pub min_ms: u64,
    /// Allowed maximum (ms).
    pub max_ms: u64,
    /// Standard preset (ms).
    pub standard_ms: u64,
    /// Patient preset (ms).
    pub patient_ms: u64,
}

/// Schema token for [`DeadlineStatus`] JSON.
pub const DEADLINE_STATUS_SCHEMA: &str = "contextdesk.deadline.v1";

/// Build a safe status snapshot from the current router budget.
pub fn deadline_status(budget: &RouterBudget) -> DeadlineStatus {
    DeadlineStatus {
        schema: DEADLINE_STATUS_SCHEMA,
        policy: policy_mode(budget),
        deadline_ms: budget.deadline_ms,
        deadline_human: format_deadline_ms(budget.deadline_ms),
        deadline_is_explicit: budget.deadline_is_explicit,
        min_ms: MIN_DEADLINE_MS,
        max_ms: MAX_DEADLINE_MS,
        standard_ms: STANDARD_DEADLINE_MS,
        patient_ms: PATIENT_DEADLINE_MS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adversarial_accept_matrix_whitespace_case_units_and_bounds() {
        // Keep accept strings in lockstep with desktop deadlineControls.test.ts.
        let cases = [
            ("500ms", 500u64),
            ("600000ms", 600_000),
            ("1s", 1_000),
            ("90s", 90_000),
            ("3m", 180_000),
            ("10m", 600_000),
            ("  2M  ", 120_000),
            ("10S", 10_000),
            ("\t90s\n", 90_000),
            ("500MS", 500),
            ("  10m  ", 600_000),
        ];
        for (input, want) in cases {
            assert_eq!(
                parse_deadline_duration(input).unwrap(),
                want,
                "accept input={input:?}"
            );
        }
    }

    #[test]
    fn adversarial_reject_matrix_signs_decimals_zero_junk_mixed_overflow_range() {
        // (input, class of rejection — we only require Err, with stronger
        // checks where the product contract pins a variant)
        let must_err: &[&str] = &[
            "",
            "   ",
            "\t\n",
            "-3m",
            "+3m",
            "1.5m",
            "1,5m",
            "0s",
            "0ms",
            "0m",
            "3",
            "3min",
            "1m30s",
            "90 s",
            "90  s",
            "90s30ms",
            "ms",
            "s",
            "m",
            "abc",
            "90sec",
            "90seconds",
            "٩٠s",  // Arabic-Indic digits
            "90ｓ", // fullwidth unit-ish junk
            "90s!",
            "90s\0",
            "😊3m",
            "3m😊",
            "1e3s",
            "0x10s",
            "499ms",
            "11m",
            "100ms",
            "15m",
            "601s", // 601000 > max
            "18446744073709551615m",
            "18446744073709551615s",
            "99999999999999999999ms",
        ];
        for input in must_err {
            assert!(
                parse_deadline_duration(input).is_err(),
                "expected reject for {input:?}"
            );
        }
        assert!(matches!(
            parse_deadline_duration("-3m"),
            Err(DeadlineParseError::InvalidNumber)
        ));
        assert!(matches!(
            parse_deadline_duration("+90s"),
            Err(DeadlineParseError::InvalidNumber)
        ));
        assert!(matches!(
            parse_deadline_duration("1.5m"),
            Err(DeadlineParseError::InvalidNumber)
        ));
        assert!(matches!(
            parse_deadline_duration("3"),
            Err(DeadlineParseError::InvalidUnit)
        ));
        assert!(matches!(
            parse_deadline_duration("3min"),
            Err(DeadlineParseError::InvalidUnit)
        ));
        assert!(matches!(
            parse_deadline_duration("1m30s"),
            Err(DeadlineParseError::InvalidUnit)
        ));
        assert!(matches!(
            parse_deadline_duration("3 m"),
            Err(DeadlineParseError::Malformed)
        ));
        assert!(matches!(
            parse_deadline_duration("0s"),
            Err(DeadlineParseError::InvalidNumber)
        ));
        assert!(matches!(
            parse_deadline_duration("90 s"),
            Err(DeadlineParseError::Malformed)
        ));
        assert!(matches!(
            parse_deadline_duration("499ms"),
            Err(DeadlineParseError::OutOfRange { ms: 499 })
        ));
        assert!(matches!(
            parse_deadline_duration("11m"),
            Err(DeadlineParseError::OutOfRange { ms: 660_000 })
        ));
        assert!(matches!(
            parse_deadline_duration("18446744073709551615m"),
            Err(DeadlineParseError::Overflow)
        ));
    }

    #[test]
    fn never_silently_clamps_out_of_range() {
        let err = parse_deadline_duration("100ms").unwrap_err();
        assert!(matches!(err, DeadlineParseError::OutOfRange { ms: 100 }));
        let err = parse_deadline_duration("15m").unwrap_err();
        assert!(matches!(
            err,
            DeadlineParseError::OutOfRange { ms: 900_000 }
        ));
        // Boundary: one below min / one above max never round inward.
        assert!(matches!(
            parse_deadline_duration("499ms"),
            Err(DeadlineParseError::OutOfRange { ms: 499 })
        ));
        assert!(matches!(
            parse_deadline_duration("600001ms"),
            Err(DeadlineParseError::OutOfRange { ms: 600_001 })
        ));
        assert_eq!(parse_deadline_duration("500ms").unwrap(), MIN_DEADLINE_MS);
        assert_eq!(
            parse_deadline_duration("600000ms").unwrap(),
            MAX_DEADLINE_MS
        );
    }

    #[test]
    fn format_prefers_whole_minutes_and_seconds() {
        assert_eq!(format_deadline_ms(180_000), "3m");
        assert_eq!(format_deadline_ms(90_000), "90s");
        assert_eq!(format_deadline_ms(500), "500ms");
        assert_eq!(format_deadline_ms(1_500), "1500ms");
    }

    #[test]
    fn auto_preserves_numeric_value() {
        let mut budget = RouterBudget {
            deadline_ms: 90_000,
            deadline_is_explicit: true,
            ..RouterBudget::default()
        };
        apply_auto_policy(&mut budget);
        assert!(!budget.deadline_is_explicit);
        assert_eq!(budget.deadline_ms, 90_000);
    }

    #[test]
    fn presets_set_only_deadline_fields() {
        let mut budget = RouterBudget {
            max_sources: 7,
            max_tool_rounds: 9,
            max_results_per_source: 4,
            deadline_ms: 90_000,
            deadline_is_explicit: false,
            order: RouterBudget::default().order,
        };
        apply_standard_preset(&mut budget);
        assert_eq!(budget.deadline_ms, STANDARD_DEADLINE_MS);
        assert!(budget.deadline_is_explicit);
        assert_eq!(budget.max_sources, 7);
        assert_eq!(budget.max_tool_rounds, 9);
        assert_eq!(budget.max_results_per_source, 4);

        apply_patient_preset(&mut budget);
        assert_eq!(budget.deadline_ms, PATIENT_DEADLINE_MS);
        assert!(budget.deadline_is_explicit);
        assert_eq!(budget.max_sources, 7);
    }

    #[test]
    fn explicit_custom_and_turn_override() {
        let mut budget = RouterBudget::default();
        apply_explicit_deadline_ms(&mut budget, 42_000).unwrap();
        assert!(budget.deadline_is_explicit);
        assert_eq!(budget.deadline_ms, 42_000);

        apply_turn_override(&mut budget, 120_000).unwrap();
        assert_eq!(budget.deadline_ms, 120_000);
        assert!(budget.deadline_is_explicit);

        assert!(apply_explicit_deadline_ms(&mut budget, 100).is_err());
        assert_eq!(budget.deadline_ms, 120_000, "failed apply must not mutate");
    }

    #[test]
    fn saved_policy_precedence_override_beats_explicit_beats_adaptive() {
        // Adaptive stored value is a fallback only; explicit saved wins over it;
        // turn override wins over both and must not be written back by these helpers.
        let mut saved = RouterBudget {
            deadline_ms: PATIENT_DEADLINE_MS,
            deadline_is_explicit: false,
            ..RouterBudget::default()
        };
        assert_eq!(policy_mode(&saved), DeadlinePolicyMode::Adaptive);

        // Explicit saved policy.
        apply_explicit_deadline_ms(&mut saved, 90_000).unwrap();
        assert_eq!(policy_mode(&saved), DeadlinePolicyMode::Explicit);
        assert_eq!(saved.deadline_ms, 90_000);

        // Per-turn override on a *clone* of the host budget.
        let mut turn = saved.clone();
        apply_turn_override(&mut turn, 600_000).unwrap();
        assert_eq!(turn.deadline_ms, 600_000);
        assert!(turn.deadline_is_explicit);
        // Saved policy unchanged — override never persists via these APIs.
        assert_eq!(saved.deadline_ms, 90_000);
        assert!(saved.deadline_is_explicit);

        // Returning to adaptive keeps the stored numeric value.
        apply_auto_policy(&mut saved);
        assert!(!saved.deadline_is_explicit);
        assert_eq!(saved.deadline_ms, 90_000);
    }

    #[test]
    fn legacy_router_json_missing_deadline_is_explicit_migrates_as_explicit() {
        // Matches RouterBudget serde default `migrated_deadline_is_explicit = true`
        // so upgrades never silently lengthen a pre-field ceiling.
        let budget: RouterBudget = serde_json::from_value(serde_json::json!({
            "max_sources": 3,
            "max_tool_rounds": 12,
            "max_results_per_source": 8,
            "deadline_ms": 90_000,
            "order": ["memory", "files"]
        }))
        .expect("legacy budget");
        assert!(
            budget.deadline_is_explicit,
            "absent deadline_is_explicit must migrate as explicit"
        );
        assert_eq!(budget.deadline_ms, 90_000);
        assert_eq!(classify_preset(&budget), DeadlinePreset::Custom);
        assert_eq!(policy_mode(&budget), DeadlinePolicyMode::Explicit);
    }

    #[test]
    fn status_json_is_safe_and_versioned() {
        let budget = RouterBudget {
            deadline_ms: 180_000,
            deadline_is_explicit: false,
            ..RouterBudget::default()
        };
        let status = deadline_status(&budget);
        assert_eq!(status.schema, DEADLINE_STATUS_SCHEMA);
        assert_eq!(status.policy, DeadlinePolicyMode::Adaptive);
        let json = serde_json::to_value(&status).unwrap();
        let blob = json.to_string();
        for forbidden in [
            "profile/",
            "endpoint",
            "\"model\"",
            "http://",
            "https://",
            "secret",
            "api_key",
            "/Users/",
            "sk-",
            "Bearer ",
        ] {
            assert!(
                !blob.contains(forbidden),
                "status must not contain {forbidden}: {blob}"
            );
        }
        assert_eq!(json["deadline_human"], "3m");
        assert_eq!(json["deadline_ms"], 180_000);
    }

    #[test]
    fn classify_preset_matches_product_modes() {
        let mut budget = RouterBudget::default();
        assert_eq!(classify_preset(&budget), DeadlinePreset::Auto);
        apply_standard_preset(&mut budget);
        assert_eq!(classify_preset(&budget), DeadlinePreset::Standard);
        apply_patient_preset(&mut budget);
        assert_eq!(classify_preset(&budget), DeadlinePreset::Patient);
        apply_explicit_deadline_ms(&mut budget, 90_000).unwrap();
        assert_eq!(classify_preset(&budget), DeadlinePreset::Custom);
    }
}
