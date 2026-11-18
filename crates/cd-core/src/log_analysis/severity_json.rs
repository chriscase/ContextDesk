//! Schema-gated severity mappings. Numeric direction is never inferred from a
//! generic `level` field. Scale references: OTel logs data model, MongoDB log
//! message schema, Pino default levels, and Microsoft's Winmeta event levels.

use super::severity::{declared, missing};
use super::LogSeverityEvidence;
use serde_json::{Map, Value};

type Evidence = (String, LogSeverityEvidence);

fn band(number: u8) -> &'static str {
    match number {
        1..=4 => "trace",
        5..=8 => "debug",
        9..=12 => "info",
        13..=16 => "warn",
        17..=20 => "error",
        21..=24 => "fatal",
        _ => "unknown",
    }
}

fn text(value: &Value) -> Evidence {
    let Some(s) = value.as_str() else {
        return declared(value, "unknown", None, "ambiguous");
    };
    super::severity::text_level(s)
}

fn alias<'a>(obj: &'a Map<String, Value>, keys: &[&str]) -> Result<Option<&'a Value>, ()> {
    let mut value = None;
    for key in keys {
        if let Some(candidate) = obj.get(*key) {
            if value.is_some_and(|v| v != candidate) {
                return Err(());
            }
            value = Some(candidate);
        }
    }
    Ok(value)
}

fn otel(obj: &Map<String, Value>) -> Option<Evidence> {
    let number = match alias(obj, &["severityNumber", "severity_number"]) {
        Ok(n) => n,
        Err(()) => return Some(missing("ambiguous")),
    };
    let label = match alias(obj, &["severityText", "severity_text"]) {
        Ok(n) => n,
        Err(()) => return Some(missing("ambiguous")),
    };
    if number.is_none() && label.is_none() {
        return None;
    }
    let Some(number) = number else {
        return label.map(text);
    };
    let Some(n) = number.as_u64().filter(|n| *n <= 24).map(|n| n as u8) else {
        return Some(missing("invalid"));
    };
    let mut result = declared(number, band(n), Some(n), "schema_mapped");
    if let Some(label) = label {
        if !label.is_string() {
            return Some(missing("invalid"));
        }
        let label_evidence = text(label);
        if label_evidence.1.source_severity.is_none() {
            return Some(missing("invalid"));
        }
        if n != 0
            && label_evidence
                .1
                .severity_number
                .is_some_and(|v| band(v) != band(n))
        {
            return Some(missing("ambiguous"));
        }
        result.1.severity_text = label_evidence.1.severity_text;
    }
    Some(result)
}

fn windows(obj: &Map<String, Value>) -> Option<Evidence> {
    let system = obj.get("Event").and_then(|v| v.get("System"));
    let winlog = obj.get("winlog");
    let value = if let Some(system) =
        system.filter(|v| v.get("Provider").is_some() && v.get("EventID").is_some())
    {
        system.get("Level")
    } else if let Some(winlog) = winlog.filter(|v| {
        v.get("provider_name").and_then(Value::as_str).is_some() && v.get("event_id").is_some()
    }) {
        winlog.get("level")
    } else {
        None
    }?;
    let mapped = match value.as_u64() {
        Some(0) => 0,
        Some(1) => 21,
        Some(2) => 17,
        Some(3) => 13,
        Some(4) => 9,
        Some(5) => 5,
        _ => return Some(declared(value, "unknown", None, "ambiguous")),
    };
    Some(declared(value, band(mapped), Some(mapped), "schema_mapped"))
}

fn mongo(obj: &Map<String, Value>) -> Option<Evidence> {
    if obj.get("c").and_then(Value::as_str).is_none()
        || obj.get("id").and_then(Value::as_u64).is_none()
        || obj.get("ctx").and_then(Value::as_str).is_none()
    {
        return None;
    }
    let value = obj.get("s")?;
    let number = match value.as_str() {
        Some("F") => Some(21),
        Some("E") => Some(17),
        Some("W") => Some(13),
        Some("I") => Some(9),
        Some("D" | "D1" | "D2" | "D3" | "D4" | "D5") => Some(5),
        _ => None,
    };
    Some(declared(
        value,
        band(number.unwrap_or(0)),
        number,
        "schema_mapped",
    ))
}

/// Extract source evidence only when field structure establishes its scale.
pub(super) fn json_evidence(obj: &Map<String, Value>) -> Option<Evidence> {
    let specialized: Vec<Evidence> = [otel(obj), windows(obj), mongo(obj)]
        .into_iter()
        .flatten()
        .collect();
    if specialized.len() > 1 {
        return Some(missing("ambiguous"));
    }
    // Documented PostgreSQL jsonlog field has authority over a generic alias.
    // Do not let it override another positively recognized producer schema.
    if let Some(pg) = obj.get("error_severity") {
        return Some(if specialized.is_empty() {
            text(pg)
        } else {
            missing("ambiguous")
        });
    }
    let generic = match alias(obj, &["level", "severity", "lvl"]) {
        Ok(v) => v,
        Err(()) => return Some(missing("ambiguous")),
    };
    if let Some(specialized) = specialized.into_iter().next() {
        // A second schema cannot silently override an authoritative declaration.
        if generic.is_some() {
            return Some(missing("ambiguous"));
        }
        return Some(specialized);
    }
    let value = generic?;
    if value.is_string() {
        return Some(text(value));
    }
    let pino = obj.get("pid").and_then(Value::as_u64).is_some()
        && obj.get("hostname").and_then(Value::as_str).is_some()
        && obj.get("time").is_some_and(Value::is_number)
        && obj.get("msg").and_then(Value::as_str).is_some()
        && obj.get("level") == Some(value);
    if pino {
        let n = match value.as_u64() {
            Some(10) => Some(1),
            Some(20) => Some(5),
            Some(30) => Some(9),
            Some(40) => Some(13),
            Some(50) => Some(17),
            Some(60) => Some(21),
            _ => None,
        };
        return Some(declared(
            value,
            band(n.unwrap_or(0)),
            n,
            if n.is_some() {
                "schema_mapped"
            } else {
                "ambiguous"
            },
        ));
    }
    Some(declared(value, "unknown", None, "ambiguous"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn evidence(v: Value) -> Evidence {
        json_evidence(v.as_object().expect("object fixture")).expect("severity fixture")
    }
    #[test]
    fn numeric_scales_require_structural_evidence_and_preserve_scalar() {
        assert_eq!(evidence(json!({"level":50})).0, "unknown");
        let pino = evidence(json!({"level":50,"pid":1,"hostname":"fixture","time":1,"msg":"test"}));
        assert_eq!(pino.0, "error");
        assert_eq!(pino.1.source_severity, Some(json!(50)));
        let windows = evidence(json!({"Event":{"System":{"Provider":{},"EventID":1,"Level":2}}}));
        assert_eq!(windows.1.severity_number, Some(17));
        assert_eq!(windows.1.source_severity, Some(json!(2)));
        assert_eq!(
            evidence(json!({"Event":{"System":{"Provider":{},"EventID":1,"Level":0}}}))
                .1
                .severity_number,
            Some(0)
        );
    }
    #[test]
    fn otel_both_fields_are_preserved_and_conflicts_fail_closed() {
        let result = evidence(json!({"severityNumber":18,"severityText":"ERROR"}));
        assert_eq!(result.1.severity_number, Some(18));
        assert_eq!(result.1.severity_text.as_deref(), Some("ERROR"));
        for v in [
            json!({"severityNumber":25}),
            json!({"severityNumber":17,"severityText":2}),
            json!({"severityNumber":17,"severityText":null}),
            json!({"severityNumber":17,"severityText":true}),
            json!({"severityNumber":17,"severityText":"INFO"}),
            json!({"severityNumber":17,"severity_number":9}),
            json!({"level":"ERROR","severity":"INFO"}),
        ] {
            assert_eq!(evidence(v).0, "unknown");
        }
    }
    #[test]
    fn mongo_and_postgres_keep_source_vocabulary() {
        for value in ["D1", "D2", "D3", "D4", "D5"] {
            let result = evidence(json!({"s":value,"c":"NETWORK","id":1,"ctx":"thread"}));
            assert_eq!(result.0, "debug");
            assert_eq!(result.1.severity_text.as_deref(), Some(value));
        }
        let pg = evidence(json!({"error_severity":"NOTICE"}));
        assert_eq!(pg.0, "notice");
        assert_eq!(pg.1.severity_text.as_deref(), Some("NOTICE"));
        assert!(json_evidence(json!({"s":"E"}).as_object().expect("object")).is_none());
    }
    #[test]
    fn malformed_or_payload_values_cannot_become_evidence() {
        for v in [
            json!({"level":{"secret":"value"}}),
            json!({"severityText":"password=private"}),
            json!({"level":["ERROR"]}),
        ] {
            let result = evidence(v);
            assert_eq!(result.0, "unknown");
            assert!(result.1.source_severity.is_none());
        }
        assert!(json_evidence(
            json!({"status":500,"outcome":"error"})
                .as_object()
                .expect("object")
        )
        .is_none());
    }
}
