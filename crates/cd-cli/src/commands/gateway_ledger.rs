//! `contextdesk gateway ledger` — offline cost/reliability comparison.
//!
//! Ingests share-safe gateway diagnostic bundles and documented historical
//! benchmark rows, then emits a deterministic comparison report. Never makes
//! live gateway calls, never invents observations, and never emits readiness
//! claims from aggregates.

use cd_core::gateway_cost_ledger::{
    build_comparison_report, emit_comparison_json, ingest_path, render_comparison_text,
    ComparisonReport, LedgerRunRecord,
};
use serde::Serialize;

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
            "gateway ledger requires at least one --input path (share-safe report dir, report JSON, or historical row JSON)",
        ));
    }

    let mut runs: Vec<LedgerRunRecord> = Vec::new();
    for input in &args.inputs {
        let ingested = ingest_path(input)
            .map_err(|e| CliError::user(format!("failed to ingest {}: {e}", input.display())))?;
        runs.extend(ingested);
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
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CliError::user(format!("could not create output directory: {e}")))?;
        }
        std::fs::write(out, json)
            .map_err(|e| CliError::user(format!("could not write {}: {e}", out.display())))?;
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
