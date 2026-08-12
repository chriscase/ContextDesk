//! `contextdesk gateway ledger` — offline cost/reliability comparison.
//!
//! Ingests share-safe gateway diagnostic bundles and documented historical
//! benchmark rows, then emits a deterministic comparison report. Never makes
//! live gateway calls, never invents observations, and never emits readiness
//! claims from aggregates.

use cd_core::gateway_cost_ledger::{
    build_comparison_report, emit_comparison_json, ingest_path, render_comparison_text,
    ComparisonReport, LedgerRunRecord, MAX_LEDGER_RUNS,
};
use serde::Serialize;
use std::io::Write;

use crate::cli::GatewayLedgerArgs;
use crate::envelope::{CliError, CliResult, Render};

/// Stable schema id for the CLI payload.
pub const GATEWAY_LEDGER_CLI_SCHEMA_ID: &str = "contextdesk.cli.gateway_ledger.v1";

/// CLI result payload.
#[derive(Debug, Serialize)]
pub struct GatewayLedgerOutput {
    /// Schema id.
    pub schema_id: &'static str,
    /// Number of runs ingested.
    pub run_count: u64,
    /// Comparison report.
    pub comparison: ComparisonReport,
    /// Human text projection.
    pub text: String,
}

impl Render for GatewayLedgerOutput {
    fn render_text(&self) -> String {
        self.text.clone()
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// Execute `contextdesk gateway ledger`.
pub fn run(args: &GatewayLedgerArgs) -> CliResult<GatewayLedgerOutput> {
    if args.inputs.is_empty() {
        return Err(CliError::user(
            "gateway ledger requires at least one --input path (share-safe report+manifest directory, report JSON, or historical row JSON)",
        ));
    }

    let mut runs: Vec<LedgerRunRecord> = Vec::new();
    for (index, input) in args.inputs.iter().enumerate() {
        let ingested = ingest_path(input)
            .map_err(|e| CliError::user(format!("failed to ingest input #{}: {e}", index + 1)))?;
        runs.extend(ingested);
        if runs.len() > MAX_LEDGER_RUNS {
            return Err(CliError::user(format!(
                "ledger input exceeds the {MAX_LEDGER_RUNS}-run limit"
            )));
        }
    }

    if runs.is_empty() {
        return Err(CliError::user(
            "no ledger runs ingested from the provided inputs",
        ));
    }

    let comparison = build_comparison_report(&runs);
    let text = render_comparison_text(&comparison);
    // Enforce share-safe emission even when the operator only asked for text.
    let json = emit_comparison_json(&comparison).map_err(CliError::user)?;

    if let Some(out) = &args.out {
        let parent = out
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        std::fs::create_dir_all(parent)
            .map_err(|e| CliError::user(format!("could not create output directory: {e}")))?;
        let mut staged = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| CliError::user(format!("could not stage ledger output: {e}")))?;
        staged
            .write_all(json.as_bytes())
            .and_then(|_| staged.as_file().sync_all())
            .map_err(|e| CliError::user(format!("could not write ledger output: {e}")))?;
        staged
            .persist(out)
            .map_err(|e| CliError::user(format!("could not publish ledger output: {}", e.error)))?;
    }

    Ok(GatewayLedgerOutput {
        schema_id: GATEWAY_LEDGER_CLI_SCHEMA_ID,
        run_count: comparison.run_count,
        comparison,
        text,
    })
}

/// Resolve default fixture inputs for hermetic demos/tests.
#[cfg(test)]
pub fn demo_fixture_inputs() -> Vec<std::path::PathBuf> {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/gateway-cost-ledger/v1");
    vec![
        root.join("deepseek"),
        root.join("gpt-oss"),
        root.join("mixed-role"),
        root.join("historical/row-01.json"),
        root.join("historical/row-02.json"),
        root.join("historical/row-03.json"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::GatewayLedgerArgs;

    #[test]
    fn ledger_cli_compares_hermetic_fixtures() {
        let args = GatewayLedgerArgs {
            inputs: demo_fixture_inputs(),
            out: None,
        };
        let output = run(&args).expect("ledger run");
        assert!(output.run_count >= 6);
        assert!(!output.text.is_empty());
        assert!(output
            .comparison
            .confidence_caveats
            .iter()
            .any(|c| c.code == "unknown_cost_is_not_zero"));
    }

    #[test]
    fn ledger_cli_requires_input() {
        let args = GatewayLedgerArgs {
            inputs: vec![],
            out: None,
        };
        let err = run(&args).expect_err("empty inputs");
        assert!(err.to_string().contains("at least one --input"));
    }
}
