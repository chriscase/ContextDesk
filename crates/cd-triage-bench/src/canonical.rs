//! Deterministic JSON canonicalization for content addressing and reports.

use crate::error::{BenchError, BenchResult};
use serde::Serialize;
use serde_json::Value;

/// Serialize `value` to canonical JSON: sorted object keys, no whitespace.
pub fn to_canonical_json<T: Serialize>(value: &T) -> BenchResult<String> {
    let parsed = serde_json::to_value(value).map_err(BenchError::from_serde)?;
    Ok(canonical_value(&parsed))
}

/// Canonical JSON for an already-parsed value.
pub fn canonical_value(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        Value::String(key.clone()),
                        canonical_value(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => {
            let body: Vec<String> = items.iter().map(canonical_value).collect();
            format!("[{}]", body.join(","))
        }
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

/// Pretty JSON with a trailing newline. Object keys follow serde_json's map
/// order (BTreeMap unless `preserve_order` is enabled).
pub fn to_pretty_json<T: Serialize>(value: &T) -> BenchResult<String> {
    let mut text = serde_json::to_string_pretty(value).map_err(BenchError::from_serde)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_keys_are_sorted() {
        let value = json!({"b": 1, "a": 2});
        assert_eq!(canonical_value(&value), "{\"a\":2,\"b\":1}");
    }

    #[test]
    fn pretty_json_is_stable_for_the_same_value() {
        let value = json!({"task_id": "t1", "snapshot_id": "s1"});
        let once = to_pretty_json(&value).unwrap();
        let twice = to_pretty_json(&value).unwrap();
        assert_eq!(once, twice);
        assert!(once.ends_with('\n'));
    }
}
