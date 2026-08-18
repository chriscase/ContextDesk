//! Manual import of human, web-only, and other-product strategy results.

use crate::error::{BenchError, BenchResult};
use crate::store::{BenchStore, PutRunOutcome};
use crate::types::{
    Completeness, Observed, PromptWorkflow, RawOutput, RunImport, StrategyIdentity, TriageRun,
    RUN_SCHEMA_V2,
};

/// Result of attempting to import a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportOutcome {
    Created {
        run_id: String,
        near_duplicate_of: Option<String>,
    },
    Duplicate {
        run_id: String,
    },
}

pub fn import_run(
    store: &BenchStore,
    document: &RunImport,
    raw_bytes: &[u8],
) -> BenchResult<ImportOutcome> {
    document.validate_metadata()?;
    if raw_bytes.is_empty() {
        return Err(BenchError::Schema("raw output must not be empty".into()));
    }
    let task = store.get_task(&document.task_id)?;
    let digest = store.put_blob(raw_bytes)?;
    let run_id = String::new();
    let near_duplicate_of = find_near_duplicate(store, &digest.hex, &run_id)?;
    let encoding = if std::str::from_utf8(raw_bytes).is_ok() {
        "utf-8"
    } else {
        "binary"
    };

    let mut run = TriageRun {
        schema_id: RUN_SCHEMA_V2.into(),
        run_id,
        privacy: document.privacy,
        case_id: task.case_id.clone(),
        task_id: task.task_id.clone(),
        snapshot_id: task.snapshot_id.clone(),
        strategy: document.strategy.clone(),
        source_kind: document.source_kind,
        prompt_workflow: document.prompt_workflow.clone(),
        raw_output: RawOutput {
            digest,
            byte_length: raw_bytes.len() as u64,
            encoding: encoding.into(),
        },
        claims: document.claims.clone(),
        timing: document.timing.clone(),
        cost: document.cost.clone(),
        uncertainty: document.uncertainty.clone(),
        fairness: document.fairness.clone(),
        status: document.status,
        operator: document.operator.clone(),
        importer: document.importer.clone(),
        created_at: document.created_at.clone(),
        near_duplicate_of: near_duplicate_of.clone(),
    };
    run.run_id = format!("run-{}", run.fingerprint()?);

    match store.put_run(&run)? {
        PutRunOutcome::Duplicate { run_id } => Ok(ImportOutcome::Duplicate { run_id }),
        PutRunOutcome::Created { run_id } => Ok(ImportOutcome::Created {
            run_id,
            near_duplicate_of,
        }),
    }
}

fn find_near_duplicate(
    store: &BenchStore,
    raw_hex: &str,
    new_run_id: &str,
) -> BenchResult<Option<String>> {
    let mut matches = Vec::new();
    for id in store.list_runs()? {
        if id == new_run_id {
            continue;
        }
        let existing = store.get_run(&id)?;
        if existing.raw_output.digest.hex == raw_hex {
            matches.push(id);
        }
    }
    matches.sort();
    Ok(matches.into_iter().next())
}

/// Parse a JSON import document.
pub fn parse_import_json(text: &str) -> BenchResult<RunImport> {
    RunImport::parse_json(text)
}

/// Parse the documented markdown submission template.
///
/// The first fenced `json` block is metadata ([`RUN_IMPORT_SCHEMA_V1`]). The
/// remainder of the file after that fence is the raw write-up unless
/// `raw_output_utf8` is already present.
///
/// Raw capture is byte-exact: only a single leading `\n` or `\r\n` after the
/// closing fence is skipped. Trailing whitespace is preserved. The importer
/// never trims, reconstructs, or invents the write-up.
pub fn parse_import_markdown(text: &str) -> BenchResult<(RunImport, Option<String>)> {
    let (json, rest) = extract_first_json_fence(text)?;
    let mut import = RunImport::parse_json(&json)?;
    let rest = strip_one_leading_newline(&rest);
    if import.raw_output_utf8.is_none() && !rest.is_empty() {
        import.raw_output_utf8 = Some(rest.to_string());
    }
    let raw = import.raw_output_utf8.clone();
    Ok((import, raw))
}

fn extract_first_json_fence(text: &str) -> BenchResult<(String, String)> {
    let start_tag = "```json";
    let start = text.find(start_tag).ok_or_else(|| {
        BenchError::Schema("markdown import requires a fenced ```json metadata block".into())
    })?;
    let after = start + start_tag.len();
    let body_start = if text[after..].starts_with('\n') {
        after + 1
    } else {
        after
    };
    let end_rel = text[body_start..]
        .find("```")
        .ok_or_else(|| BenchError::Schema("markdown import json fence is unclosed".into()))?;
    let json = text[body_start..body_start + end_rel].trim().to_string();
    let rest = text[body_start + end_rel + 3..].to_string();
    Ok((json, rest))
}

fn strip_one_leading_newline(text: &str) -> &str {
    if let Some(rest) = text.strip_prefix("\r\n") {
        rest
    } else if let Some(rest) = text.strip_prefix('\n') {
        rest
    } else {
        text
    }
}

pub fn default_unknown_prompt_workflow() -> PromptWorkflow {
    PromptWorkflow {
        completeness: Completeness::Unknown,
        prompt: Observed::Unknown,
        workflow: Observed::Unknown,
    }
}

pub fn unknown_strategy(name: &str) -> StrategyIdentity {
    StrategyIdentity {
        name: name.to_string(),
        version: Observed::Unknown,
        build: Observed::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{SourceKind, RUN_IMPORT_SCHEMA_V1};

    #[test]
    fn markdown_template_splits_metadata_and_body() {
        let text = "<!-- submission -->\n```json\n{\"schema_id\":\"contextdesk.triage_bench.run_import.v1\",\"task_id\":\"task-x\",\"strategy\":{\"name\":\"human\",\"version\":{\"status\":\"unknown\"},\"build\":{\"status\":\"unknown\"}},\"source_kind\":\"human\",\"prompt_workflow\":{\"completeness\":\"unknown\",\"prompt\":{\"status\":\"unknown\"},\"workflow\":{\"status\":\"unknown\"}},\"timing\":{\"status\":\"unknown\"},\"cost\":{\"status\":\"unknown\"},\"uncertainty\":{\"status\":\"unknown\"},\"fairness\":{\"kind\":\"same_snapshot\"},\"status\":\"completed\",\"operator\":\"alice\",\"created_at\":\"2026-01-15T08:00:00Z\"}\n```\n\nRoot cause looks like a timeout.\n";
        let (import, raw) = parse_import_markdown(text).unwrap();
        assert_eq!(import.source_kind, SourceKind::Human);
        assert_eq!(raw.as_deref(), Some("\nRoot cause looks like a timeout.\n"));
        assert_eq!(import.schema_id, RUN_IMPORT_SCHEMA_V1);
    }

    #[test]
    fn markdown_body_preserves_trailing_whitespace_byte_exact() {
        let text = "```json\n{\"schema_id\":\"contextdesk.triage_bench.run_import.v1\",\"task_id\":\"task-x\",\"strategy\":{\"name\":\"human\",\"version\":{\"status\":\"unknown\"},\"build\":{\"status\":\"unknown\"}},\"source_kind\":\"human\",\"prompt_workflow\":{\"completeness\":\"unknown\",\"prompt\":{\"status\":\"unknown\"},\"workflow\":{\"status\":\"unknown\"}},\"timing\":{\"status\":\"unknown\"},\"cost\":{\"status\":\"unknown\"},\"uncertainty\":{\"status\":\"unknown\"},\"fairness\":{\"kind\":\"same_snapshot\"},\"status\":\"completed\",\"operator\":\"alice\",\"created_at\":\"2026-01-15T08:00:00Z\"}\n```\nkeep trailing spaces   \n";
        let (_import, raw) = parse_import_markdown(text).unwrap();
        assert_eq!(raw.as_deref(), Some("keep trailing spaces   \n"));
    }
}
