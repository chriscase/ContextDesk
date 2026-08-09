//! Load, digest, and isolate OPEN quality-eval fixtures.

use super::types::{
    failure_reason, CaseRuntime, CaseTruth, SuiteManifest, CASE_SCHEMA_ID,
    QUALITY_EVAL_SCHEMA_VERSION, RUNTIME_SCHEMA_ID, SUITE_SCHEMA_ID, TRUTH_SCHEMA_ID,
};
use crate::error::{CoreError, CoreResult};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

/// Tokens that must never appear in model-visible runtime text.
pub const RUNTIME_FORBIDDEN_EVALUATOR_TOKENS: &[&str] = &[
    "must_include",
    "must_exclude",
    "mustInclude",
    "mustExclude",
    "root_cause",
    "root cause",
    "evaluator_only",
    "evaluator_truth",
    "EVALUATOR",
    "initiating_evidence",
    "propagated_symptom",
    "answer_key",
    "decoy:",
    "causal trigger:",
    "symptom only:",
];

/// Credential / path shapes forbidden in fixtures and exports.
pub const PRIVACY_FORBIDDEN_SUBSTRINGS: &[&str] =
    &["/Users/", "C:\\Users", "sk-", "Bearer ", "xai-", "ghp_"];

/// One loaded case with runtime/truth separation enforced.
#[derive(Debug, Clone)]
pub struct LoadedCase {
    /// Case directory name.
    pub case_dir: String,
    /// Model-visible runtime.
    pub runtime: CaseRuntime,
    /// Host-only truth.
    pub truth: CaseTruth,
}

/// Fully loaded suite with content digest.
#[derive(Debug, Clone)]
pub struct LoadedSuite {
    /// Absolute-path-free suite root used for loading (may be absolute internally;
    /// never serialized into run records).
    pub suite_root: PathBuf,
    /// Manifest.
    pub manifest: SuiteManifest,
    /// Cases in manifest order.
    pub cases: Vec<LoadedCase>,
    /// SHA-256 hex of canonical suite bytes.
    pub digest: String,
}

/// Load suite from a directory containing `suite.json` and `cases/<id>/`.
pub fn load_suite(suite_root: &Path) -> CoreResult<LoadedSuite> {
    let manifest_path = suite_root.join("suite.json");
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|e| CoreError::Config(format!("read suite.json: {e}")))?;
    let manifest: SuiteManifest = serde_json::from_str(&raw)
        .map_err(|e| CoreError::Config(format!("parse suite.json: {e}")))?;
    if manifest.schema_id != SUITE_SCHEMA_ID {
        return Err(CoreError::Config(format!(
            "suite schema_id {} != {SUITE_SCHEMA_ID}",
            manifest.schema_id
        )));
    }
    if manifest.schema_version != QUALITY_EVAL_SCHEMA_VERSION {
        return Err(CoreError::Config(format!(
            "suite schema_version {} != {QUALITY_EVAL_SCHEMA_VERSION}",
            manifest.schema_version
        )));
    }

    let mut cases = Vec::new();
    let mut digest_input = Vec::new();
    digest_input.extend_from_slice(raw.as_bytes());

    for case_dir in &manifest.cases {
        let case_path = suite_root.join("cases").join(case_dir);
        let runtime_raw = fs::read_to_string(case_path.join("runtime.json"))
            .map_err(|e| CoreError::Config(format!("read cases/{case_dir}/runtime.json: {e}")))?;
        let truth_raw = fs::read_to_string(case_path.join("truth.json"))
            .map_err(|e| CoreError::Config(format!("read cases/{case_dir}/truth.json: {e}")))?;
        digest_input.extend_from_slice(case_dir.as_bytes());
        digest_input.extend_from_slice(runtime_raw.as_bytes());
        digest_input.extend_from_slice(truth_raw.as_bytes());

        let runtime: CaseRuntime = serde_json::from_str(&runtime_raw)
            .map_err(|e| CoreError::Config(format!("parse runtime {case_dir}: {e}")))?;
        let truth: CaseTruth = serde_json::from_str(&truth_raw)
            .map_err(|e| CoreError::Config(format!("parse truth {case_dir}: {e}")))?;

        validate_case_pair(case_dir, &runtime, &truth)?;
        cases.push(LoadedCase {
            case_dir: case_dir.clone(),
            runtime,
            truth,
        });
    }

    let digest = hex_sha256(&digest_input);
    Ok(LoadedSuite {
        suite_root: suite_root.to_path_buf(),
        manifest,
        cases,
        digest,
    })
}

/// Recompute digest and ensure it matches an expected value.
pub fn assert_suite_digest(suite: &LoadedSuite, expected: &str) -> CoreResult<()> {
    if suite.digest != expected {
        return Err(CoreError::Config(format!(
            "{}: expected {}, got {}",
            failure_reason::SUITE_DIGEST_MISMATCH,
            expected,
            suite.digest
        )));
    }
    Ok(())
}

fn validate_case_pair(case_dir: &str, runtime: &CaseRuntime, truth: &CaseTruth) -> CoreResult<()> {
    if runtime.schema_id != RUNTIME_SCHEMA_ID {
        return Err(CoreError::Config(format!(
            "{case_dir}: runtime schema_id {}",
            runtime.schema_id
        )));
    }
    if truth.schema_id != TRUTH_SCHEMA_ID {
        return Err(CoreError::Config(format!(
            "{case_dir}: truth schema_id {}",
            truth.schema_id
        )));
    }
    if runtime.case_id != truth.case_id {
        return Err(CoreError::Config(format!(
            "{case_dir}: case_id mismatch runtime={} truth={}",
            runtime.case_id, truth.case_id
        )));
    }
    // Silence unused CASE_SCHEMA_ID without exporting a case.json requirement.
    let _ = CASE_SCHEMA_ID;

    let isolation = scan_runtime_isolation(runtime);
    if !isolation.is_empty() {
        return Err(CoreError::Config(format!(
            "{}: {}",
            failure_reason::TRUTH_LEAKED_INTO_RUNTIME,
            isolation.join("; ")
        )));
    }
    let privacy = scan_privacy_text(&serde_json::to_string(runtime).unwrap_or_default());
    if !privacy.is_empty() {
        return Err(CoreError::Config(format!(
            "{} in runtime: {}",
            failure_reason::EXPORT_PRIVACY_VIOLATION,
            privacy.join("; ")
        )));
    }
    let privacy_truth = scan_privacy_text(&serde_json::to_string(truth).unwrap_or_default());
    if !privacy_truth.is_empty() {
        return Err(CoreError::Config(format!(
            "{} in truth: {}",
            failure_reason::EXPORT_PRIVACY_VIOLATION,
            privacy_truth.join("; ")
        )));
    }
    Ok(())
}

/// Scan **model-visible text surfaces** for evaluator labels.
///
/// Structural schema field names (e.g. `asserts_root_cause_established`) are
/// not searchable document content and are intentionally excluded. Only
/// document bodies, questions, packet text, and candidate prose are scanned.
pub fn scan_runtime_isolation(runtime: &CaseRuntime) -> Vec<String> {
    let mut findings = Vec::new();
    let mut surfaces = Vec::new();
    for doc in &runtime.documents {
        surfaces.push(doc.text.as_str());
        surfaces.push(doc.id.as_str());
    }
    for (qid, q) in &runtime.questions {
        surfaces.push(qid.as_str());
        surfaces.push(q.as_str());
    }
    for packet in &runtime.packets {
        for doc in &packet.documents {
            surfaces.push(doc.text.as_str());
            surfaces.push(doc.id.as_str());
        }
    }
    for cand in &runtime.candidates {
        surfaces.push(cand.conclusion.as_str());
        for claim in &cand.claims {
            surfaces.push(claim.text.as_str());
            for id in &claim.evidence_ids {
                surfaces.push(id.as_str());
            }
        }
    }
    for ranking in &runtime.rankings {
        for id in &ranking.ranked_ids {
            surfaces.push(id.as_str());
        }
        if let Some(up) = &ranking.upstream_ranked_ids {
            for id in up {
                surfaces.push(id.as_str());
            }
        }
    }
    let blob = surfaces.join("\n").to_ascii_lowercase();
    for token in RUNTIME_FORBIDDEN_EVALUATOR_TOKENS {
        if blob.contains(&token.to_ascii_lowercase()) {
            findings.push(format!("runtime contains evaluator token `{token}`"));
        }
    }
    findings
}

/// Scan text for absolute paths and credential-shaped substrings.
pub fn scan_privacy_text(text: &str) -> Vec<String> {
    let mut findings = Vec::new();
    for token in PRIVACY_FORBIDDEN_SUBSTRINGS {
        if text.contains(token) {
            findings.push(format!("forbidden substring `{token}`"));
        }
    }
    findings
}

/// Document id universe for a case runtime.
pub fn known_document_ids(runtime: &CaseRuntime) -> BTreeSet<String> {
    runtime.documents.iter().map(|d| d.id.clone()).collect()
}

/// SHA-256 hex of bytes.
pub fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Default committed suite root relative to a crate or repo root.
pub fn default_suite_path_from_manifest_dir(manifest_dir: &Path) -> PathBuf {
    // crates/cd-core -> repo root
    manifest_dir
        .join("../../fixtures/quality-eval/open-v1")
        .canonicalize()
        .unwrap_or_else(|_| manifest_dir.join("../../fixtures/quality-eval/open-v1"))
}

/// Resolve suite path from CLI argument or environment / default.
pub fn resolve_suite_path(explicit: Option<&Path>) -> CoreResult<PathBuf> {
    if let Some(p) = explicit {
        return Ok(p.to_path_buf());
    }
    if let Ok(env) = std::env::var("CONTEXTDESK_QUALITY_EVAL_SUITE") {
        return Ok(PathBuf::from(env));
    }
    // Walk up from cwd looking for fixtures/quality-eval/open-v1
    let cwd = std::env::current_dir().map_err(|e| CoreError::Config(format!("cwd: {e}")))?;
    let mut cur = cwd.as_path();
    loop {
        let candidate = cur.join("fixtures/quality-eval/open-v1");
        if candidate.join("suite.json").is_file() {
            return Ok(candidate);
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => break,
        }
    }
    Err(CoreError::Config(
        "could not locate fixtures/quality-eval/open-v1; pass --suite".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forbidden_tokens_detected() {
        let runtime = CaseRuntime {
            schema_id: RUNTIME_SCHEMA_ID.into(),
            case_id: "x".into(),
            documents: vec![super::super::types::EvidenceDocument {
                id: "d1".into(),
                text: "this mentions root cause explicitly".into(),
            }],
            questions: Default::default(),
            packets: vec![],
            rankings: vec![],
            candidates: vec![],
        };
        let findings = scan_runtime_isolation(&runtime);
        assert!(!findings.is_empty());
    }

    #[test]
    fn privacy_scan_catches_home_paths() {
        let findings = scan_privacy_text("file is under /Users/nobody/secret");
        assert!(!findings.is_empty());
    }
}
