//! Portable event severity evidence, independent from the legacy query band.

use serde::{Deserialize, Serialize};

/// Source severity and its interpretation; absent evidence never implies INFO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LogSeverityEvidence {
    /// OpenTelemetry severity number (0–24), only when a mapping is established.
    pub severity_number: Option<u8>,
    /// Original bounded textual source level, preserving spelling and case.
    pub severity_text: Option<String>,
    /// Original bounded scalar from the source field, without type coercion.
    pub source_severity: Option<serde_json::Value>,
    /// True only for weak inference from message text.
    pub severity_inferred: bool,
    /// How the source was interpreted; legacy rows make no source claim.
    pub provenance: String,
}
impl Default for LogSeverityEvidence {
    fn default() -> Self {
        Self {
            severity_number: None,
            severity_text: None,
            source_severity: None,
            severity_inferred: false,
            provenance: "legacy_normalized".into(),
        }
    }
}

fn valid_text(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 24
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b' ' | b'_' | b'-'))
        && s.trim() == s
}
impl LogSeverityEvidence {
    /// Validate typed, bounded evidence before rendering or portable export.
    pub fn is_valid(&self) -> bool {
        use serde_json::Value;
        if self.severity_number.is_some_and(|n| n > 24)
            || self
                .severity_text
                .as_deref()
                .is_some_and(|s| !valid_text(s))
            || self.source_severity.as_ref().is_some_and(|v| match v {
                Value::String(s) => !valid_text(s),
                Value::Number(n) => !n
                    .as_i64()
                    .is_some_and(|i| i.unsigned_abs() <= 9_007_199_254_740_991),
                _ => true,
            })
        {
            return false;
        }
        match self.provenance.as_str() {
            "source_declared" | "schema_mapped" => {
                self.source_severity.is_some() && !self.severity_inferred
            }
            "ambiguous" => {
                !self.severity_inferred
                    && self.severity_number.is_none()
                    && (self.source_severity.is_some() || self.severity_text.is_none())
            }
            "text_inferred" => {
                self.severity_inferred
                    && self.source_severity.is_none()
                    && self.severity_text.is_none()
                    && self.severity_number.is_some()
            }
            "legacy_normalized" | "absent" | "invalid" => {
                !self.severity_inferred
                    && self.source_severity.is_none()
                    && self.severity_text.is_none()
                    && self.severity_number.is_none()
            }
            _ => false,
        }
    }
}
pub(super) fn missing(provenance: &str) -> (String, LogSeverityEvidence) {
    (
        "unknown".into(),
        LogSeverityEvidence {
            provenance: provenance.into(),
            ..Default::default()
        },
    )
}
pub(super) fn declared(
    source: &serde_json::Value,
    band: &str,
    number: Option<u8>,
    provenance: &str,
) -> (String, LogSeverityEvidence) {
    let evidence = LogSeverityEvidence {
        severity_text: source.as_str().map(str::to_owned),
        source_severity: Some(source.clone()),
        severity_inferred: false,
        severity_number: number,
        provenance: provenance.into(),
    };
    if evidence.is_valid() {
        (band.into(), evidence)
    } else {
        missing("invalid")
    }
}
pub(super) fn band_number(band: &str) -> Option<u8> {
    Some(match band {
        "trace" => 1,
        "debug" => 5,
        "info" | "log" => 9,
        "notice" => 10,
        "warn" => 13,
        "error" => 17,
        "critical" => 18,
        "fatal" => 21,
        "alert" => 22,
        "emergency" => 24,
        _ => return None,
    })
}
pub(super) fn text_level(text: &str) -> (String, LogSeverityEvidence) {
    let band = super::parse::normalize_level(text);
    let number = band_number(&band);
    declared(
        &serde_json::Value::String(text.to_owned()),
        if number.is_some() { &band } else { "unknown" },
        number,
        if number.is_some() {
            "source_declared"
        } else {
            "ambiguous"
        },
    )
}

#[cfg(test)]
mod integer_boundary {
    use super::*;
    #[test]
    fn typed_source_remains_exact_through_javascript_wire_domain() {
        for edge in [9_007_199_254_740_991_i64, -9_007_199_254_740_991] {
            let source = serde_json::json!(edge);
            assert_eq!(
                declared(&source, "unknown", None, "ambiguous")
                    .1
                    .source_severity,
                Some(source)
            );
        }
        for unsupported in [
            9_007_199_254_740_992_i64,
            9_007_199_254_740_993,
            -9_007_199_254_740_992,
        ] {
            let evidence = declared(
                &serde_json::json!(unsupported),
                "unknown",
                None,
                "ambiguous",
            )
            .1;
            assert_eq!(evidence.provenance, "invalid");
            assert!(evidence.source_severity.is_none());
        }
    }
}
