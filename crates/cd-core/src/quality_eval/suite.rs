//! Load, digest, and isolate OPEN quality-eval fixtures.

use super::types::{
    failure_reason, CaseRuntime, CaseTruth, SuiteManifest, CASE_SCHEMA_ID,
    QUALITY_EVAL_SCHEMA_VERSION, RUNTIME_SCHEMA_ID, SUITE_SCHEMA_ID, TRUTH_SCHEMA_ID,
};
use crate::error::{CoreError, CoreResult};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
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
pub const PRIVACY_FORBIDDEN_SUBSTRINGS: &[&str] = &[
    "/users/",
    "/home/",
    "c:\\users",
    "sk-",
    "bearer ",
    "xai-",
    "ghp_",
];

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
    let root = suite_root.to_path_buf();
    load_suite_documents(root.clone(), raw, move |case_dir, file_name| {
        fs::read_to_string(root.join("cases").join(case_dir).join(file_name))
            .map_err(|e| CoreError::Config(format!("read cases/{case_dir}/{file_name}: {e}")))
    })
}

fn load_suite_documents<F>(
    suite_root: PathBuf,
    raw: String,
    mut read_case: F,
) -> CoreResult<LoadedSuite>
where
    F: FnMut(&str, &str) -> CoreResult<String>,
{
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
    if manifest.cases.is_empty() {
        return Err(CoreError::Config(format!(
            "{}: suite must contain at least one case",
            failure_reason::INVALID_FIXTURE_CONTRACT
        )));
    }

    let mut cases = Vec::new();
    let mut digest_input = Vec::new();
    extend_digest_segment(&mut digest_input, raw.as_bytes());

    let mut seen_case_dirs = BTreeSet::new();
    for case_dir in &manifest.cases {
        let mut components = Path::new(case_dir).components();
        let single_normal_component =
            matches!(components.next(), Some(std::path::Component::Normal(_)))
                && components.next().is_none();
        if !single_normal_component || !seen_case_dirs.insert(case_dir.as_str()) {
            return Err(CoreError::Config(format!(
                "{}: case entries must be unique direct child names",
                failure_reason::INVALID_FIXTURE_CONTRACT
            )));
        }
        let runtime_raw = read_case(case_dir, "runtime.json")?;
        let truth_raw = read_case(case_dir, "truth.json")?;
        extend_digest_segment(&mut digest_input, case_dir.as_bytes());
        extend_digest_segment(&mut digest_input, runtime_raw.as_bytes());
        extend_digest_segment(&mut digest_input, truth_raw.as_bytes());

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
        suite_root,
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
    if runtime.case_id != case_dir {
        return Err(fixture_error(case_dir, "case directory must equal case_id"));
    }
    if runtime.rankings.is_empty() && runtime.candidates.is_empty() {
        return Err(fixture_error(
            case_dir,
            "case must contain at least one retrieval ranking or candidate answer",
        ));
    }

    let mut documents = BTreeMap::new();
    for document in &runtime.documents {
        if document.id.trim().is_empty()
            || !is_opaque_document_id(&document.id)
            || documents
                .insert(document.id.as_str(), document.text.as_str())
                .is_some()
        {
            return Err(fixture_error(
                case_dir,
                "document ids must be unique opaque values such as d01",
            ));
        }
    }

    let truth_query_ids: BTreeSet<&str> = truth
        .queries
        .iter()
        .map(|query| query.query_id.as_str())
        .collect();
    if truth_query_ids.len() != truth.queries.len()
        || truth_query_ids
            != runtime
                .questions
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>()
    {
        return Err(fixture_error(
            case_dir,
            "runtime questions and truth query ids must be unique and identical",
        ));
    }
    for query in &truth.queries {
        if runtime.questions.get(&query.query_id) != Some(&query.question) || query.top_k == 0 {
            return Err(fixture_error(
                case_dir,
                "truth questions must match runtime text and use top_k greater than zero",
            ));
        }
        let relevant: BTreeSet<&str> = query.relevant_ids.iter().map(String::as_str).collect();
        let referenced_ids = query
            .relevant_ids
            .iter()
            .chain(&query.must_include_ids)
            .chain(&query.must_exclude_ids)
            .chain(&query.foreign_incident_ids);
        if referenced_ids
            .into_iter()
            .any(|id| !documents.contains_key(id.as_str()))
            || query
                .graded_gains
                .keys()
                .any(|id| !relevant.contains(id.as_str()))
            || query
                .must_include_ids
                .iter()
                .any(|id| !relevant.contains(id.as_str()))
            || query
                .must_exclude_ids
                .iter()
                .any(|id| relevant.contains(id.as_str()))
        {
            return Err(fixture_error(
                case_dir,
                "query truth contains unknown or contradictory evidence identities",
            ));
        }
    }

    let mut packet_ids = BTreeSet::new();
    for packet in &runtime.packets {
        if packet.packet_id.trim().is_empty() || !packet_ids.insert(packet.packet_id.as_str()) {
            return Err(fixture_error(
                case_dir,
                "packet ids must be non-empty and unique",
            ));
        }
        let mut seen_packet_docs = BTreeSet::new();
        for document in &packet.documents {
            if !seen_packet_docs.insert(document.id.as_str())
                || documents.get(document.id.as_str()).copied() != Some(document.text.as_str())
            {
                return Err(fixture_error(
                    case_dir,
                    "packet documents must be unique exact copies of corpus documents",
                ));
            }
        }
    }

    let answer_task_ids: BTreeSet<&str> = truth
        .answers
        .iter()
        .map(|answer| answer.task_id.as_str())
        .collect();
    if answer_task_ids.len() != truth.answers.len() {
        return Err(fixture_error(case_dir, "answer task ids must be unique"));
    }
    for answer in &truth.answers {
        if answer.requires_abstention && answer.root_cause_establishable {
            return Err(fixture_error(
                case_dir,
                "answer truth cannot require abstention when the cause is establishable",
            ));
        }
        if answer
            .packet_overrides
            .iter()
            .any(|(packet_id, override_truth)| {
                !packet_ids.contains(packet_id.as_str())
                    || (override_truth.requires_abstention
                        && override_truth.root_cause_establishable)
            })
        {
            return Err(fixture_error(
                case_dir,
                "packet answer overrides must reference known packets and use consistent truth",
            ));
        }
        if answer
            .required_evidence_ids
            .iter()
            .chain(&answer.forbidden_evidence_ids)
            .any(|id| !documents.contains_key(id.as_str()))
        {
            return Err(fixture_error(
                case_dir,
                "answer truth contains unknown evidence identities",
            ));
        }
    }
    if runtime.candidates.iter().any(|candidate| {
        !answer_task_ids.contains(candidate.task_id.as_str())
            || !packet_ids.contains(candidate.packet_id.as_str())
    }) || runtime
        .rankings
        .iter()
        .any(|ranking| !truth_query_ids.contains(ranking.query_id.as_str()))
    {
        return Err(fixture_error(
            case_dir,
            "candidate or ranking references an unknown task, packet, or query",
        ));
    }
    let candidate_ids: BTreeSet<&str> = runtime
        .candidates
        .iter()
        .map(|candidate| candidate.candidate_id.as_str())
        .collect();
    if candidate_ids.len() != runtime.candidates.len() {
        return Err(CoreError::Config(format!(
            "{case_dir}: {}: duplicate scripted candidate id",
            failure_reason::CANDIDATE_EXPECTATION_MISMATCH
        )));
    }
    let expected_ids: BTreeSet<&str> = truth
        .candidate_expectations
        .keys()
        .map(String::as_str)
        .collect();
    if candidate_ids != expected_ids {
        return Err(CoreError::Config(format!(
            "{case_dir}: {}: every scripted candidate needs one host-only expectation",
            failure_reason::CANDIDATE_EXPECTATION_MISMATCH
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

fn fixture_error(case_dir: &str, detail: &str) -> CoreError {
    CoreError::Config(format!(
        "{case_dir}: {}: {detail}",
        failure_reason::INVALID_FIXTURE_CONTRACT
    ))
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
        if let Some(diag) = &cand.diagnostic {
            surfaces.push(diag.reported_category.as_str());
            surfaces.push(diag.usefulness_policy.as_str());
            // export_text is scanned by privacy, not isolation evaluator tokens
            // beyond the shared blob join below when present in prose fields.
            for attempt in &diag.attempts {
                surfaces.push(attempt.attempt_id.as_str());
                surfaces.push(attempt.failure_class.as_str());
            }
            for step in &diag.tool_steps {
                surfaces.push(step.step_id.as_str());
                surfaces.push(step.kind.as_str());
            }
            for role in &diag.roles {
                surfaces.push(role.role.as_str());
                surfaces.push(role.status.as_str());
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
    let normalized = text.to_ascii_lowercase();
    for token in PRIVACY_FORBIDDEN_SUBSTRINGS {
        if normalized.contains(token) {
            findings.push(format!("forbidden substring `{token}`"));
        }
    }
    findings
}

fn is_opaque_document_id(id: &str) -> bool {
    id.strip_prefix('d')
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
}

fn extend_digest_segment(buffer: &mut Vec<u8>, segment: &[u8]) {
    buffer.extend_from_slice(&(segment.len() as u64).to_be_bytes());
    buffer.extend_from_slice(segment);
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

/// Relative label for the bundled OPEN v1 suite (never an absolute path).
pub const BUNDLED_OPEN_V1_RELATIVE: &str = "fixtures/quality-eval/open-v1";

const EMBEDDED_OPEN_V1_CASES: &[(&str, &str, &str)] = &[
    (
        "qe01-simple-diagnosis",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe01-simple-diagnosis/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe01-simple-diagnosis/truth.json"),
    ),
    (
        "qe02-symptom-versus-trigger",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe02-symptom-versus-trigger/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe02-symptom-versus-trigger/truth.json"),
    ),
    (
        "qe03-loud-near-match",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe03-loud-near-match/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe03-loud-near-match/truth.json"),
    ),
    (
        "qe04-independent-incidents",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe04-independent-incidents/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe04-independent-incidents/truth.json"),
    ),
    (
        "qe05-trigger-and-recovery",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe05-trigger-and-recovery/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe05-trigger-and-recovery/truth.json"),
    ),
    (
        "qe06-insufficient-evidence",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe06-insufficient-evidence/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe06-insufficient-evidence/truth.json"),
    ),
    (
        "qe07-foreign-identity",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe07-foreign-identity/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe07-foreign-identity/truth.json"),
    ),
    (
        "qe08-retrieval-ranking",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe08-retrieval-ranking/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe08-retrieval-ranking/truth.json"),
    ),
    (
        "qe09-attempt-usefulness",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe09-attempt-usefulness/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe09-attempt-usefulness/truth.json"),
    ),
    (
        "qe10-grounding-vs-transport",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe10-grounding-vs-transport/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe10-grounding-vs-transport/truth.json"),
    ),
    (
        "qe11-tool-progress",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe11-tool-progress/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe11-tool-progress/truth.json"),
    ),
    (
        "qe12-multimodel-budget",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe12-multimodel-budget/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe12-multimodel-budget/truth.json"),
    ),
    (
        "qe13-chronology-contradiction",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe13-chronology-contradiction/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe13-chronology-contradiction/truth.json"),
    ),
    (
        "qe14-retrieval-ablation",
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe14-retrieval-ablation/runtime.json"),
        include_str!("../../../../fixtures/quality-eval/open-v1/cases/qe14-retrieval-ablation/truth.json"),
    ),
];

/// Load the checked-in OPEN v1 suite from compile-time host bytes.
///
/// This is the packaged-desktop path: evaluator truth remains inside trusted
/// Rust code and is never copied into Tauri's browseable resource directory or
/// renderer IPC. The same parser, validation, and digest framing used by the
/// filesystem loader are applied to these exact committed bytes.
pub fn load_embedded_open_v1_suite() -> CoreResult<LoadedSuite> {
    let manifest = include_str!("../../../../fixtures/quality-eval/open-v1/suite.json").to_string();
    load_suite_documents(
        PathBuf::from(BUNDLED_OPEN_V1_RELATIVE),
        manifest,
        |case_dir, file_name| {
            let (_, runtime, truth) = EMBEDDED_OPEN_V1_CASES
                .iter()
                .find(|(known, _, _)| *known == case_dir)
                .ok_or_else(|| {
                    CoreError::Config(format!("embedded OPEN v1 case is missing: {case_dir}"))
                })?;
            match file_name {
                "runtime.json" => Ok((*runtime).to_string()),
                "truth.json" => Ok((*truth).to_string()),
                _ => Err(CoreError::Config(format!(
                    "unsupported embedded OPEN v1 document: {file_name}"
                ))),
            }
        },
    )
}

/// One catalog entry for a bundled or discovered OPEN quality-eval suite.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SuiteCatalogEntry {
    /// Suite id from suite.json when readable; otherwise directory name.
    pub suite_id: String,
    /// Human title when the manifest loads.
    pub title: String,
    /// Repo-relative path label only (never absolute).
    pub relative_path: String,
    /// Case count from the manifest when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_count: Option<usize>,
    /// True when this is the default OPEN suite for `eval run`.
    pub is_default: bool,
}

/// Resolve suite path from CLI argument or environment / default.
///
/// Does not read app config, Keychain, or network. Explicit paths may be
/// absolute (caller-supplied); default discovery never *emits* absolute paths
/// into records.
pub fn resolve_suite_path(explicit: Option<&Path>) -> CoreResult<PathBuf> {
    if let Some(p) = explicit {
        let path = p.to_path_buf();
        if !path.join("suite.json").is_file() {
            return Err(CoreError::Config(format!(
                "suite path has no suite.json: {}",
                path.file_name().and_then(|n| n.to_str()).unwrap_or("suite")
            )));
        }
        return Ok(path);
    }
    if let Ok(env) = std::env::var("CONTEXTDESK_QUALITY_EVAL_SUITE") {
        let path = PathBuf::from(env);
        if path.join("suite.json").is_file() {
            return Ok(path);
        }
        return Err(CoreError::Config(
            "CONTEXTDESK_QUALITY_EVAL_SUITE does not contain suite.json".into(),
        ));
    }
    // Walk up from cwd looking for fixtures/quality-eval/open-v1
    let cwd = std::env::current_dir().map_err(|e| CoreError::Config(format!("cwd: {e}")))?;
    let mut cur = cwd.as_path();
    loop {
        let candidate = cur.join(BUNDLED_OPEN_V1_RELATIVE);
        if candidate.join("suite.json").is_file() {
            return Ok(candidate);
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => break,
        }
    }
    Err(CoreError::Config(
        "could not locate fixtures/quality-eval/open-v1; pass --suite or set CONTEXTDESK_QUALITY_EVAL_SUITE".into(),
    ))
}

/// List known OPEN quality-eval suites under `fixtures/quality-eval/` (cwd walk).
///
/// State-free: filesystem read of committed fixtures only. Never returns absolute
/// path strings in the catalog entries.
pub fn list_bundled_suites() -> CoreResult<Vec<SuiteCatalogEntry>> {
    let cwd = std::env::current_dir().map_err(|e| CoreError::Config(format!("cwd: {e}")))?;
    let mut cur = cwd.as_path();
    let root = loop {
        let candidate = cur.join("fixtures/quality-eval");
        if candidate.is_dir() {
            break candidate;
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => {
                return Err(CoreError::Config(
                    "could not locate fixtures/quality-eval; run from a ContextDesk checkout"
                        .into(),
                ));
            }
        }
    };

    let mut entries = Vec::new();
    let read =
        fs::read_dir(&root).map_err(|e| CoreError::Config(format!("read quality-eval: {e}")))?;
    for entry in read {
        let entry =
            entry.map_err(|e| CoreError::Config(format!("read quality-eval entry: {e}")))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if !path.join("suite.json").is_file() {
            continue;
        }
        let dir_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("suite")
            .to_string();
        let relative = format!("fixtures/quality-eval/{dir_name}");
        let is_default = dir_name == "open-v1";
        match load_suite(&path) {
            Ok(loaded) => entries.push(SuiteCatalogEntry {
                suite_id: loaded.manifest.suite_id,
                title: loaded.manifest.title,
                relative_path: relative,
                case_count: Some(loaded.cases.len()),
                is_default,
            }),
            Err(_) => entries.push(SuiteCatalogEntry {
                suite_id: dir_name,
                title: "(unreadable suite.json)".into(),
                relative_path: relative,
                case_count: None,
                is_default,
            }),
        }
    }
    entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    if entries.is_empty() {
        return Err(CoreError::Config(
            "no quality-eval suites with suite.json found under fixtures/quality-eval".into(),
        ));
    }
    Ok(entries)
}

/// Count expected-pass / expected-fail answer outcomes for honest CLI text.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExpectationAccounting {
    /// Host-declared expected-pass candidates that passed.
    pub expected_pass_met: u32,
    /// Host-declared expected-pass candidates that failed.
    pub expected_pass_missed: u32,
    /// Host-declared expected-fail candidates that failed (cage success).
    pub expected_fail_met: u32,
    /// Host-declared expected-fail candidates that passed (vacuous green).
    pub expected_fail_missed: u32,
    /// Candidates without a declared expectation.
    pub undeclared: u32,
}

/// Summarize expectation accounting from a run record (no truth files required).
pub fn expectation_accounting(record: &super::types::QualityRunRecord) -> ExpectationAccounting {
    use super::types::CandidateExpectation;
    let mut acc = ExpectationAccounting::default();
    for case in &record.cases {
        for answer in &case.answers {
            match (answer.expected_outcome, answer.expectation_met) {
                (Some(CandidateExpectation::Pass), Some(true)) => acc.expected_pass_met += 1,
                (Some(CandidateExpectation::Pass), _) => acc.expected_pass_missed += 1,
                (Some(CandidateExpectation::Fail), Some(true)) => acc.expected_fail_met += 1,
                (Some(CandidateExpectation::Fail), _) => acc.expected_fail_missed += 1,
                (None, _) => acc.undeclared += 1,
            }
        }
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::super::types::{
        AnswerTruth, CandidateAnswer, CandidateExpectation, EvidenceDocument, EvidencePacket,
        QueryTruth,
    };
    use super::*;

    fn valid_pair() -> (CaseRuntime, CaseTruth) {
        let document = EvidenceDocument {
            id: "d1".into(),
            text: "service changed its configured boundary".into(),
        };
        let runtime = CaseRuntime {
            schema_id: RUNTIME_SCHEMA_ID.into(),
            case_id: "case".into(),
            documents: vec![document.clone()],
            questions: BTreeMap::from([("q1".into(), "What changed?".into())]),
            packets: vec![EvidencePacket {
                packet_id: "fixed".into(),
                documents: vec![document],
            }],
            rankings: vec![],
            candidates: vec![CandidateAnswer {
                candidate_id: "candidate".into(),
                task_id: "t1".into(),
                packet_id: "fixed".into(),
                asserts_root_cause_established: true,
                claims: vec![],
                conclusion: "configured boundary changed".into(),
                confidence: "medium".into(),
                diagnostic: None,
            }],
        };
        let truth = CaseTruth {
            schema_id: TRUTH_SCHEMA_ID.into(),
            case_id: "case".into(),
            title: "case".into(),
            queries: vec![QueryTruth {
                query_id: "q1".into(),
                question: "What changed?".into(),
                relevant_ids: vec!["d1".into()],
                graded_gains: BTreeMap::new(),
                must_include_ids: vec!["d1".into()],
                must_exclude_ids: vec![],
                foreign_incident_ids: vec![],
                top_k: 1,
            }],
            answers: vec![AnswerTruth {
                task_id: "t1".into(),
                root_cause_establishable: true,
                required_fact_tokens: vec!["boundary".into()],
                trigger_tokens: vec!["boundary".into()],
                symptom_tokens: vec![],
                recovery_tokens: vec![],
                independent_incident_tokens: vec![],
                required_evidence_ids: vec!["d1".into()],
                forbidden_evidence_ids: vec![],
                requires_abstention: false,
                packet_overrides: BTreeMap::new(),
                forbidden_conclusion_tokens: vec![],
                diagnostic: None,
            }],
            candidate_expectations: BTreeMap::from([(
                "candidate".into(),
                CandidateExpectation::Pass,
            )]),
            incidents: BTreeMap::new(),
        };
        (runtime, truth)
    }

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
        assert!(!scan_privacy_text("file is under /home/nobody/secret").is_empty());
        assert!(!scan_privacy_text("BEARER not-a-real-token").is_empty());
    }

    #[test]
    fn descriptive_document_ids_are_rejected_as_truth_leakage() {
        let (mut runtime, truth) = valid_pair();
        runtime.documents[0].id = "d-trigger".into();
        runtime.packets[0].documents[0].id = "d-trigger".into();
        runtime.candidates[0].claims.clear();

        let error = validate_case_pair("case", &runtime, &truth).unwrap_err();

        assert!(error
            .to_string()
            .contains(failure_reason::INVALID_FIXTURE_CONTRACT));
    }

    #[test]
    fn packet_rows_must_match_the_corpus_exactly() {
        let (mut runtime, truth) = valid_pair();
        runtime.packets[0].documents[0].text = "invented packet row".into();

        let error = validate_case_pair("case", &runtime, &truth).unwrap_err();

        assert!(error
            .to_string()
            .contains(failure_reason::INVALID_FIXTURE_CONTRACT));
    }

    #[test]
    fn candidate_expectations_are_exact_host_only_coverage() {
        let (runtime, mut truth) = valid_pair();
        truth.candidate_expectations.clear();

        let error = validate_case_pair("case", &runtime, &truth).unwrap_err();

        assert!(error
            .to_string()
            .contains(failure_reason::CANDIDATE_EXPECTATION_MISMATCH));
    }

    #[test]
    fn manifest_case_paths_cannot_escape_the_suite() {
        let directory = tempfile::tempdir().unwrap();
        let manifest = SuiteManifest {
            schema_id: SUITE_SCHEMA_ID.into(),
            suite_id: "test".into(),
            title: "test".into(),
            schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
            cases: vec!["../outside".into()],
        };
        fs::write(
            directory.path().join("suite.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let error = load_suite(directory.path()).unwrap_err();

        assert!(error
            .to_string()
            .contains(failure_reason::INVALID_FIXTURE_CONTRACT));
    }

    #[test]
    fn empty_suite_cannot_claim_executed_quality() {
        let directory = tempfile::tempdir().unwrap();
        let manifest = SuiteManifest {
            schema_id: SUITE_SCHEMA_ID.into(),
            suite_id: "empty".into(),
            title: "empty".into(),
            schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
            cases: vec![],
        };
        fs::write(
            directory.path().join("suite.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let error = load_suite(directory.path()).unwrap_err();

        assert!(error
            .to_string()
            .contains(failure_reason::INVALID_FIXTURE_CONTRACT));
    }

    #[test]
    fn unknown_runtime_fields_cannot_bypass_isolation_scanning() {
        let (runtime, _) = valid_pair();
        let mut value = serde_json::to_value(runtime).unwrap();
        value.as_object_mut().unwrap().insert(
            "root_cause".into(),
            serde_json::json!("hidden evaluator truth"),
        );

        let error = serde_json::from_value::<CaseRuntime>(value).unwrap_err();

        assert!(error.to_string().contains("unknown field"));
    }
}
