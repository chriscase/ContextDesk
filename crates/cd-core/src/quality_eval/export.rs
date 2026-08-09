//! Normalized JSON / JSONL export with privacy gates.
//!
//! Never emits absolute filesystem paths. Refuses overwrite unless explicitly
//! allowed. Scans for credential-shaped substrings before write.

use super::suite::scan_privacy_text;
use super::types::{failure_reason, QualityRunRecord};
use crate::error::{CoreError, CoreResult};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

/// Output format for the lab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    /// Single pretty JSON document.
    Json,
    /// One JSON object per line (header + cases).
    Jsonl,
}

impl ExportFormat {
    /// Parse wire string.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "json" => Some(Self::Json),
            "jsonl" => Some(Self::Jsonl),
            _ => None,
        }
    }
}

/// Serialize a run record to stable JSON bytes (pretty, sorted maps via BTreeMap fields).
pub fn serialize_json(record: &QualityRunRecord) -> CoreResult<String> {
    let text = serde_json::to_string_pretty(record)
        .map_err(|e| CoreError::Message(format!("serialize run record: {e}")))?;
    gate_export_text(&text)?;
    Ok(text)
}

/// Serialize as JSONL: first line full record metadata summary, then each case.
pub fn serialize_jsonl(record: &QualityRunRecord) -> CoreResult<String> {
    let mut lines = Vec::new();
    let header = serde_json::json!({
        "schema_id": record.schema_id,
        "schema_version": record.schema_version,
        "suite_id": record.suite_id,
        "suite_digest": record.suite_digest,
        "status": record.status.as_str(),
        "quality_unit": record.quality_unit,
        "judge": record.judge,
        "evidence_classes": record.evidence_classes,
        "case_count": record.cases.len(),
    });
    lines.push(
        serde_json::to_string(&header)
            .map_err(|e| CoreError::Message(format!("jsonl header: {e}")))?,
    );
    for case in &record.cases {
        lines.push(
            serde_json::to_string(case)
                .map_err(|e| CoreError::Message(format!("jsonl case: {e}")))?,
        );
    }
    let text = lines.join("\n") + "\n";
    gate_export_text(&text)?;
    Ok(text)
}

/// Refuse privacy violations in export text.
pub fn gate_export_text(text: &str) -> CoreResult<()> {
    let findings = scan_privacy_text(text);
    if !findings.is_empty() {
        return Err(CoreError::Policy(format!(
            "{}: {}",
            failure_reason::EXPORT_PRIVACY_VIOLATION,
            findings.join("; ")
        )));
    }
    // Relative-path safety: reject Unix absolute home-style paths already covered;
    // also reject bare absolute /tmp style only when looking like filesystem dumps.
    if text.contains("\"/Users/") || text.contains("\"C:\\\\Users") {
        return Err(CoreError::Policy(
            failure_reason::EXPORT_PRIVACY_VIOLATION.into(),
        ));
    }
    Ok(())
}

/// Write export to path. Refuses to overwrite an existing file unless `force`.
pub fn write_export(path: &Path, body: &str, force: bool) -> CoreResult<()> {
    gate_export_text(body)?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| CoreError::Message(format!("create output parent: {e}")))?;
        }
    }
    let mut options = OpenOptions::new();
    options.write(true);
    if force {
        options.create(true).truncate(true);
    } else {
        options.create_new(true);
    }
    let mut file = options.open(path).map_err(|error| {
        if !force && error.kind() == std::io::ErrorKind::AlreadyExists {
            CoreError::Config(format!(
                "output path already exists (pass --force to replace): {}",
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("output")
            ))
        } else {
            CoreError::Message(format!("create output: {error}"))
        }
    })?;
    file.write_all(body.as_bytes())
        .map_err(|e| CoreError::Message(format!("write output: {e}")))?;
    Ok(())
}

/// Canonicalize record for byte-stable comparison: re-parse pretty JSON.
pub fn normalize_for_stability(record: &QualityRunRecord) -> CoreResult<String> {
    let text = serialize_json(record)?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| CoreError::Message(format!("reparse: {e}")))?;
    serde_json::to_string_pretty(&value)
        .map_err(|e| CoreError::Message(format!("reserialize: {e}")))
}

#[cfg(test)]
mod tests {
    use super::super::types::{
        EvidenceClassMarkers, JudgeMetadata, LaneStatus, ModelSubject, QualityUnit, TaskMode,
    };
    use super::*;

    fn minimal_record() -> QualityRunRecord {
        QualityRunRecord {
            schema_id: "contextdesk.quality_eval.run_record.v1".into(),
            schema_version: "contextdesk.quality_eval.v1".into(),
            suite_id: "open-v1".into(),
            suite_digest: "abc".into(),
            quality_unit: QualityUnit {
                build_identity: "deadbeef".into(),
                subject: ModelSubject {
                    gateway_profile_id: "g1".into(),
                    endpoint_fingerprint: "ff".into(),
                    model_id: "m1".into(),
                },
                task_mode: TaskMode::TriageInvestigation,
                prompt_set_hash: "h".into(),
                answer_schema_version: "a".into(),
                suite_id: "open-v1".into(),
                suite_digest: "abc".into(),
                retrieval_mode: "fixed_packet".into(),
                sampling_config: "deterministic_scripted".into(),
                orchestration_policy_fingerprint: "none".into(),
                quality_eval_schema_version: "contextdesk.quality_eval.v1".into(),
            },
            status: LaneStatus::Executed,
            cases: vec![],
            judge: JudgeMetadata::default(),
            evidence_classes: EvidenceClassMarkers::default(),
        }
    }

    #[test]
    fn serialize_rejects_credential_shape() {
        let mut rec = minimal_record();
        rec.suite_id = "sk-not-allowed".into();
        let err = serialize_json(&rec).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("export_privacy") || msg.contains("sk-"),
            "{msg}"
        );
    }

    #[test]
    fn stable_roundtrip() {
        let rec = minimal_record();
        let a = normalize_for_stability(&rec).unwrap();
        let b = normalize_for_stability(&rec).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn write_refuses_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.json");
        write_export(&path, "{\"ok\":true}\n", false).unwrap();
        let err = write_export(&path, "{\"ok\":true}\n", false).unwrap_err();
        assert!(err.to_string().contains("already exists"));
        write_export(&path, "{\"ok\":true}\n", true).unwrap();
    }
}
