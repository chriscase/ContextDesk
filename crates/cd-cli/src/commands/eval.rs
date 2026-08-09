//! `contextdesk eval` — state-free hermetic quality-evaluation surface.
//!
//! Zero app config, Keychain, gateway, network, session, corpus, or
//! qualification-store access. Reuses [`cd_core::quality_eval`] only.
//!
//! This does **not** measure live model usefulness or compatibility readiness.

use crate::cli::{EvalAction, EvalRunArgs, EvalValidateArgs};
use crate::envelope::{CliError, CliResult, Render};
use cd_core::quality_eval::{
    expectation_accounting, list_bundled_suites, load_suite, normalize_for_stability,
    resolve_suite_path, run_hermetic_suite, serialize_json, serialize_jsonl, write_export,
    ExpectationAccounting, ExportFormat, HermeticRunOptions, LaneStatus, QualityRunRecord,
    SuiteCatalogEntry, BUNDLED_OPEN_V1_RELATIVE, QUALITY_EVAL_SCHEMA_VERSION, RUN_RECORD_SCHEMA_ID,
};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Stable schema for CLI eval envelopes.
pub const EVAL_OUTPUT_SCHEMA_ID: &str = "contextdesk.cli.eval.v1";

/// Honest evidence labels always present in CLI output.
#[derive(Debug, Clone, Serialize)]
pub struct EvalEvidenceLabels {
    /// Compatibility / readiness probes were not run.
    pub compatibility_readiness: &'static str,
    /// What this command measured.
    pub hermetic_quality: &'static str,
    /// Live model usefulness was not measured.
    pub live_usefulness: &'static str,
    /// Disclosed scoring limitation (lexical, not semantic entailment).
    pub scoring_limitation: &'static str,
}

impl Default for EvalEvidenceLabels {
    fn default() -> Self {
        Self {
            compatibility_readiness: "not_evaluated",
            hermetic_quality: "hermetic_fixture_evidence_only",
            live_usefulness: "not_evaluated",
            scoring_limitation:
                "citation text checks use lexical overlap, not semantic entailment; this command does not prove live model usefulness",
        }
    }
}

/// `contextdesk eval suites` output.
#[derive(Debug, Serialize)]
pub struct EvalSuitesOutput {
    pub schema_id: &'static str,
    pub schema_version: &'static str,
    pub offline: bool,
    pub credentials_read: bool,
    pub network: bool,
    pub evidence: EvalEvidenceLabels,
    pub suites: Vec<SuiteCatalogEntry>,
}

impl Render for EvalSuitesOutput {
    fn render_text(&self) -> String {
        let mut out = String::from("Quality-evaluation suites (offline, no credentials)\n\n");
        out.push_str("  Compatibility/readiness: not evaluated\n");
        out.push_str("  Live model usefulness:   not evaluated\n");
        out.push_str("  Evidence:                hermetic fixture suites only\n\n");
        for suite in &self.suites {
            let default = if suite.is_default { " (default)" } else { "" };
            let cases = suite
                .case_count
                .map(|n| format!("{n} cases"))
                .unwrap_or_else(|| "cases unknown".into());
            out.push_str(&format!(
                "  {}{} — {}\n    path: {}\n    {}\n\n",
                suite.suite_id, default, suite.title, suite.relative_path, cases
            ));
        }
        out.push_str("Run: contextdesk eval run\nValidate: contextdesk eval validate\n");
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// `contextdesk eval validate` output.
#[derive(Debug, Serialize)]
pub struct EvalValidateOutput {
    pub schema_id: &'static str,
    pub schema_version: &'static str,
    pub offline: bool,
    pub credentials_read: bool,
    pub network: bool,
    pub evidence: EvalEvidenceLabels,
    pub suite_id: String,
    pub suite_title: String,
    /// Relative path label only (never absolute).
    pub suite_path_label: String,
    pub case_count: usize,
    pub suite_digest: String,
    pub status: &'static str,
}

impl Render for EvalValidateOutput {
    fn render_text(&self) -> String {
        format!(
            "Quality suite validation (offline)\n\n\
             Status:       {}\n\
             Suite:        {} — {}\n\
             Cases:        {}\n\
             Digest:       {}\n\
             Path label:   {}\n\n\
             Compatibility/readiness: not evaluated\n\
             Live model usefulness:   not evaluated\n\
             Evidence:                hermetic fixture isolation only\n",
            self.status,
            self.suite_id,
            self.suite_title,
            self.case_count,
            self.suite_digest,
            self.suite_path_label
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// `contextdesk eval run` machine envelope.
#[derive(Debug, Serialize)]
pub struct EvalRunOutput {
    pub schema_id: &'static str,
    pub schema_version: &'static str,
    pub offline: bool,
    pub credentials_read: bool,
    pub network: bool,
    pub evidence: EvalEvidenceLabels,
    pub suite_path_label: String,
    pub status: String,
    pub accounting: ExpectationAccounting,
    /// Full hermetic run record (same authority as cd-quality-eval-lab).
    pub record: QualityRunRecord,
    /// Basename only when written; never an absolute path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrote: Option<String>,
}

impl Render for EvalRunOutput {
    fn render_text(&self) -> String {
        let mut out = String::from("Hermetic quality evaluation\n\n");
        out.push_str(&format!("  Status:      {}\n", self.status));
        out.push_str(&format!("  Suite:       {}\n", self.record.suite_id));
        out.push_str(&format!("  Digest:      {}\n", self.record.suite_digest));
        out.push_str(&format!("  Cases:       {}\n", self.record.cases.len()));
        out.push_str(&format!("  Path label:  {}\n", self.suite_path_label));
        if let Some(name) = &self.wrote {
            out.push_str(&format!("  Wrote:       {name}\n"));
        }
        out.push_str("\nEvidence classes\n");
        out.push_str("  Compatibility/readiness: not evaluated\n");
        out.push_str("  Retrieval quality:       hermetic fixture rankings only\n");
        out.push_str("  Answer quality:          hermetic scripted candidates only\n");
        out.push_str("  Live model usefulness:   not evaluated\n");
        out.push_str("  Optional judge:          not scheduled\n");
        out.push_str("\nExpectation accounting (host-declared)\n");
        out.push_str(&format!(
            "  Expected pass met:   {}\n  Expected pass miss:  {}\n  Expected fail met:   {}\n  Expected fail miss:  {}\n  Undeclared:          {}\n",
            self.accounting.expected_pass_met,
            self.accounting.expected_pass_missed,
            self.accounting.expected_fail_met,
            self.accounting.expected_fail_missed,
            self.accounting.undeclared
        ));
        out.push_str("\nCases\n");
        for case in &self.record.cases {
            out.push_str(&format!(
                "  [{}] {} — {}\n",
                case.status.as_str(),
                case.case_id,
                case.title
            ));
            let pass_n = case.answers.iter().filter(|a| a.passed).count();
            let fail_n = case.answers.len().saturating_sub(pass_n);
            if !case.answers.is_empty() {
                out.push_str(&format!(
                    "    answers: {} pass / {} fail (scripted)\n",
                    pass_n, fail_n
                ));
            }
            if !case.retrieval.is_empty() {
                let ok = case
                    .retrieval
                    .iter()
                    .filter(|r| r.status == LaneStatus::Executed)
                    .count();
                out.push_str(&format!(
                    "    retrieval rows: {} executed / {}\n",
                    ok,
                    case.retrieval.len()
                ));
            }
        }
        out.push_str(
            "\nLimitation: citation checks use lexical overlap, not semantic entailment.\n\
             This report does not change model defaults or readiness evidence.\n",
        );
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// Dispatch `eval` subcommands (state-free).
pub fn run(action: &EvalAction) -> CliResult<EvalCommandOutput> {
    match action {
        EvalAction::Suites => Ok(EvalCommandOutput::Suites(suites()?)),
        EvalAction::Validate(args) => Ok(EvalCommandOutput::Validate(validate(args)?)),
        EvalAction::Run(args) => Ok(EvalCommandOutput::Run(Box::new(run_eval(args)?))),
    }
}

/// Tagged output so main can render uniformly.
#[derive(Debug)]
pub enum EvalCommandOutput {
    Suites(EvalSuitesOutput),
    Validate(EvalValidateOutput),
    /// Boxed: full hermetic run records are large.
    Run(Box<EvalRunOutput>),
}

impl Render for EvalCommandOutput {
    fn render_text(&self) -> String {
        match self {
            Self::Suites(o) => o.render_text(),
            Self::Validate(o) => o.render_text(),
            Self::Run(o) => o.render_text(),
        }
    }

    fn render_json(&self) -> serde_json::Value {
        match self {
            Self::Suites(o) => o.render_json(),
            Self::Validate(o) => o.render_json(),
            Self::Run(o) => o.render_json(),
        }
    }
}

impl EvalCommandOutput {
    /// Nonzero exit when hermetic run status is not executed, or validation failed.
    pub fn failed_verdict(&self) -> bool {
        match self {
            Self::Run(o) => o.record.status != LaneStatus::Executed,
            Self::Validate(o) => o.status != "ok",
            Self::Suites(_) => false,
        }
    }
}

fn suites() -> CliResult<EvalSuitesOutput> {
    let suites = list_bundled_suites().map_err(|e| CliError::user(e.to_string()))?;
    // Catalog entries must not leak absolute paths.
    for s in &suites {
        if s.relative_path.contains("/Users/") || s.relative_path.contains("C:\\Users") {
            return Err(CliError::internal(
                "suite catalog leaked an absolute path label",
            ));
        }
    }
    Ok(EvalSuitesOutput {
        schema_id: EVAL_OUTPUT_SCHEMA_ID,
        schema_version: QUALITY_EVAL_SCHEMA_VERSION,
        offline: true,
        credentials_read: false,
        network: false,
        evidence: EvalEvidenceLabels::default(),
        suites,
    })
}

fn validate(args: &EvalValidateArgs) -> CliResult<EvalValidateOutput> {
    let path = resolve_suite(args.suite.as_deref())?;
    let loaded = load_suite(&path).map_err(|e| CliError::user(e.to_string()))?;
    Ok(EvalValidateOutput {
        schema_id: EVAL_OUTPUT_SCHEMA_ID,
        schema_version: QUALITY_EVAL_SCHEMA_VERSION,
        offline: true,
        credentials_read: false,
        network: false,
        evidence: EvalEvidenceLabels::default(),
        suite_id: loaded.manifest.suite_id.clone(),
        suite_title: loaded.manifest.title.clone(),
        suite_path_label: path_label(&path),
        case_count: loaded.cases.len(),
        suite_digest: loaded.digest,
        status: "ok",
    })
}

fn run_eval(args: &EvalRunArgs) -> CliResult<EvalRunOutput> {
    let path = resolve_suite(args.suite.as_deref())?;
    let loaded = load_suite(&path).map_err(|e| CliError::user(e.to_string()))?;
    let mut opts = HermeticRunOptions::default();
    if let Ok(sha) = std::env::var("CD_GIT_SHA") {
        if !sha.trim().is_empty() {
            opts.build_identity = sha.trim().to_string();
        }
    }
    let record = run_hermetic_suite(&loaded, &opts);
    debug_assert_eq!(record.schema_id, RUN_RECORD_SCHEMA_ID);

    let export_format = match args.report_format.as_deref() {
        None | Some("json") => ExportFormat::Json,
        Some("jsonl") => ExportFormat::Jsonl,
        Some(other) => {
            return Err(CliError::user(format!(
                "unknown --report-format {other}; use json or jsonl"
            )));
        }
    };

    // When writing a file, default machine format is JSON unless jsonl requested.
    let wrote = if let Some(out) = args.output.as_ref() {
        let body = match export_format {
            ExportFormat::Json => {
                let body =
                    serialize_json(&record).map_err(|e| CliError::internal(e.to_string()))?;
                let emitted: serde_json::Value = serde_json::from_str(&body)
                    .map_err(|e| CliError::internal(format!("reparse JSON: {e}")))?;
                let expected_text = normalize_for_stability(&record)
                    .map_err(|e| CliError::internal(e.to_string()))?;
                let expected: serde_json::Value = serde_json::from_str(&expected_text)
                    .map_err(|e| CliError::internal(format!("reparse normalized: {e}")))?;
                if emitted != expected {
                    return Err(CliError::internal(
                        "non-deterministic quality export serialization",
                    ));
                }
                body
            }
            ExportFormat::Jsonl => {
                serialize_jsonl(&record).map_err(|e| CliError::internal(e.to_string()))?
            }
        };
        write_export(out, &body, args.force).map_err(|e| {
            let msg = e.to_string();
            if msg.contains("already exists") {
                CliError::user(msg)
            } else {
                CliError::internal(msg)
            }
        })?;
        Some(
            out.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("output")
                .to_string(),
        )
    } else {
        None
    };

    Ok(EvalRunOutput {
        schema_id: EVAL_OUTPUT_SCHEMA_ID,
        schema_version: QUALITY_EVAL_SCHEMA_VERSION,
        offline: true,
        credentials_read: false,
        network: false,
        evidence: EvalEvidenceLabels::default(),
        suite_path_label: path_label(&path),
        status: record.status.as_str().to_string(),
        accounting: expectation_accounting(&record),
        record,
        wrote,
    })
}

fn resolve_suite(explicit: Option<&Path>) -> CliResult<PathBuf> {
    resolve_suite_path(explicit).map_err(|e| CliError::user(e.to_string()))
}

/// Basename or relative fixture label — never a home absolute path.
fn path_label(path: &Path) -> String {
    // Prefer the stable relative form when the path ends with the bundled layout.
    let display = path.to_string_lossy();
    if display.contains("fixtures/quality-eval/") {
        if let Some(idx) = display.find("fixtures/quality-eval/") {
            return display[idx..].replace('\\', "/");
        }
    }
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(BUNDLED_OPEN_V1_RELATIVE)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_label_never_emits_users_home() {
        let p = Path::new("/Users/nobody/fixtures/quality-eval/open-v1");
        let label = path_label(p);
        assert!(!label.starts_with("/Users/"));
        assert!(label.contains("fixtures/quality-eval/open-v1") || label == "open-v1");
    }

    #[test]
    fn evidence_labels_are_honest() {
        let e = EvalEvidenceLabels::default();
        assert_eq!(e.compatibility_readiness, "not_evaluated");
        assert_eq!(e.live_usefulness, "not_evaluated");
        assert!(e.scoring_limitation.contains("lexical"));
        assert!(!e.scoring_limitation.contains("usefulness proved"));
    }
}
