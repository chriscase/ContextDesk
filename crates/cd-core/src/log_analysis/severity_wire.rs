//! Wire-declared severity only: PRI is authoritative over transported CEF.
//!
//! RFC 5424 section 6.2.1 defines PRI as facility * 8 + severity (0..191).
//! Only the low three bits are retained as source severity; facility is not
//! itself a severity. CEF's ascending 0..10 scale is a separate interpretation.
//! ArcSight CEF implementation standard v27 defines 0/Unknown as unspecified.
//! The band mapping here is a product mapping, not a claim that CEF defines OTel.
//! References: https://www.rfc-editor.org/rfc/rfc5424.html#section-6.2.1
//! https://docs.microfocus.com/doc/2097/25.4/siemcefimplementationstandard

use super::severity::{declared, missing};
use super::LogSeverityEvidence;
use serde_json::Value;

const MAX_HEADER_BYTES: usize = 8192;

/// Read explicit wire metadata. Unrecognized payloads do not imply a level.
pub(super) fn wire(raw: &str, message: &str) -> Option<(String, LogSeverityEvidence)> {
    let raw = raw.trim_start();
    if raw.starts_with('<') {
        let end = raw.find('>')?;
        let digits = raw.get(1..end)?;
        let valid = !digits.is_empty()
            && digits.len() <= 3
            && digits.bytes().all(|b| b.is_ascii_digit())
            && (digits == "0" || !digits.starts_with('0'));
        let pri = digits.parse::<u8>().ok().filter(|v| *v <= 191);
        if !valid || pri.is_none() {
            return Some(missing("invalid"));
        }
        if !(super::parse::looks_like_rfc5424(raw) || super::parse::looks_like_classic_syslog(raw))
        {
            return None;
        }
        let code = pri? % 8;
        let (band, number) = match code {
            0 => ("emergency", 24),
            1 => ("alert", 22),
            2 => ("critical", 18),
            3 => ("error", 17),
            4 => ("warn", 13),
            5 => ("notice", 10),
            6 => ("info", 9),
            _ => ("debug", 5),
        };
        return Some(declared(
            &Value::from(code),
            band,
            Some(number),
            "schema_mapped",
        ));
    }
    // An explicit CEF record or a parser-established syslog message is the only
    // place to interpret a CEF header. Never search arbitrary message substrings.
    cef(raw).or_else(|| {
        if super::parse::looks_like_classic_syslog(raw) {
            cef(message.trim_start())
        } else {
            None
        }
    })
}

fn cef(raw: &str) -> Option<(String, LogSeverityEvidence)> {
    let rest = raw.strip_prefix("CEF:")?;
    let mut fields = Vec::with_capacity(7);
    let mut field = String::new();
    let mut escaped = false;
    let mut complete = false;
    for (offset, ch) in rest.char_indices() {
        if offset >= MAX_HEADER_BYTES {
            return Some(missing("invalid"));
        }
        if escaped {
            if !matches!(ch, '|' | '\\') {
                return Some(missing("invalid"));
            }
            field.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '|' {
            fields.push(std::mem::take(&mut field));
            if fields.len() == 7 {
                complete = true;
                break;
            }
        } else {
            field.push(ch);
        }
    }
    if !complete
        || escaped
        || fields.len() != 7
        || !matches!(fields.first().map(String::as_str), Some("0" | "1"))
        || fields.iter().skip(1).take(5).any(String::is_empty)
    {
        return Some(missing("invalid"));
    }
    let severity = fields.last()?;
    // Preserve spelling and case, and refuse whitespace-padded/noncanonical
    // numeric tokens rather than normalizing away source information.
    let numeric = severity
        .parse::<u8>()
        .ok()
        .filter(|n| n.to_string() == *severity);
    let (band, number) = match numeric {
        Some(0) => ("unknown", None),
        Some(1..=3) => ("info", Some(9)),
        Some(4..=6) => ("warn", Some(13)),
        Some(7..=8) => ("error", Some(17)),
        Some(9..=10) => ("fatal", Some(21)),
        Some(_) => return Some(missing("invalid")),
        None => match severity.to_ascii_lowercase().as_str() {
            "unknown" => ("unknown", None),
            "low" => ("info", Some(9)),
            "medium" => ("warn", Some(13)),
            "high" => ("error", Some(17)),
            "very-high" => ("fatal", Some(21)),
            _ => return Some(missing("invalid")),
        },
    };
    Some(declared(
        &Value::String(severity.clone()),
        band,
        number,
        "schema_mapped",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pri_has_inverse_scale_and_excludes_facility() {
        for (pri, expected, code) in [(0, "emergency", 0), (191, "debug", 7), (165, "notice", 5)] {
            let raw = format!("<{pri}>1 2026-01-01T00:00:00Z host app - - - no errors");
            let (level, evidence) = wire(&raw, "no errors").expect("syslog");
            assert_eq!(level, expected);
            assert_eq!(evidence.source_severity, Some(Value::from(code)));
            assert!(!evidence.severity_inferred);
        }
        assert_eq!(
            wire("<14>Jan  2 12:30:00 host app: failed", "failed")
                .expect("classic")
                .0,
            "info"
        );
    }

    #[test]
    fn envelope_severity_wins_over_cef_and_error_text() {
        let payload = "CEF:0|v|p|1|id|name|10|msg=ERROR";
        let raw = format!("<14>1 - host app - - - {payload}");
        assert_eq!(wire(&raw, payload).expect("envelope").0, "info");
        assert_eq!(wire(payload, payload).expect("CEF").0, "fatal");
    }

    #[test]
    fn cef_escaped_fields_and_named_levels_preserve_source() {
        let raw = r"CEF:0|ven\|dor|product|1|id|na\\me|Very-High|status=200";
        let (level, evidence) = wire(raw, raw).expect("CEF");
        assert_eq!(level, "fatal");
        assert_eq!(
            evidence.source_severity,
            Some(Value::String("Very-High".into()))
        );
        for token in ["0", "Unknown"] {
            let raw = format!("CEF:0|v|p|1|id|name|{token}|status=500");
            let (level, evidence) = wire(&raw, &raw).expect("CEF");
            assert_eq!(level, "unknown");
            assert_eq!(evidence.severity_number, None);
        }
    }

    #[test]
    fn malformed_and_nonseverity_fields_never_supply_severity() {
        for raw in [
            "<192>1 - host app - - - error",
            "<014>1 - host app - - - error",
            "CEF:0|v|p|1|id|name|11|",
            "CEF:0|v|p|1|id|name|01|",
            "CEF:0|v|p|1|id|name|",
            "CEF:0|v|p|1|id|name|High",
        ] {
            let (_, evidence) = wire(raw, raw).expect("invalid wire record");
            assert_eq!(evidence.provenance, "invalid", "{raw}");
        }
        for raw in [
            "<14>just plain text",
            "status=500 stream=stderr",
            "message CEF:0|v|p|1|id|name|High|",
        ] {
            assert!(wire(raw, raw).is_none());
        }
        let raw = format!("CEF:0|{}|p|1|id|name|High|", "v".repeat(MAX_HEADER_BYTES));
        assert_eq!(wire(&raw, &raw).expect("oversize").1.provenance, "invalid");
    }
}
