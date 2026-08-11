//! `contextdesk retrieval-diagnose` — one bounded retrieval-quality workflow.
//!
//! Compares executable retrieval lanes over one imported corpus under fixed
//! budgets, using the production ToolHost search path and the production
//! retrieval factories. It measures **retrieval**, and says so: answer
//! usefulness and provider readiness are separate measurements this command
//! does not make and never claims.
//!
//! # Safety posture
//!
//! * **Dry run is the default.** A bare invocation prints the plan — lanes,
//!   budgets, egress requirement, and any re-analysis the corpus would need —
//!   without constructing a backend, reading a credential, or touching the
//!   network. `--confirm` is required to execute.
//! * **Egress is explicit.** A remote role needs `--acknowledge-egress`; the
//!   plan states this before anything runs.
//! * **Artifacts are share-safe by default.** The report carries identities,
//!   revisions, budgets, metrics, and fingerprints — never endpoints,
//!   credentials, headers, bodies, corpus text, usernames, or absolute paths.
//!   Including raw local material requires **two** separate flags, because one
//!   flag is too easy to pass by habit when pasting a report into a ticket.
//! * **Nothing is written back.** No configuration, default, or readiness
//!   store is modified. A failed lane is degraded or inconclusive; it is never
//!   a reason to change what the product does.

use std::path::Path;

use cd_core::config::AppConfig;
use cd_core::process_progress::CancelFlag;
use cd_workflow::retrieval_diagnostic::{
    plan_diagnostic, run_diagnostic, DiagnosticBudgets, DiagnosticLane, DiagnosticPlan,
    DiagnosticQuery, DiagnosticRequest, DiagnosticVerdict, LaneStatus, RetrievalDiagnosticReport,
    RETRIEVAL_DIAGNOSTIC_SCHEMA_VERSION,
};
use serde::Serialize;

use crate::adapters;
use crate::cli::RetrievalDiagnoseArgs;
use crate::envelope::{CliError, CliResult, Render};

/// Stable schema id for this command's envelope.
pub const RETRIEVAL_DIAGNOSE_SCHEMA_ID: &str = "contextdesk.cli.retrieval_diagnose.v1";

/// The second of the two flags required to include raw local material.
const RAW_CONSENT_FLAG: &str = "--raw-output-is-not-share-safe";

/// Honest labels present in every output of this command.
#[derive(Debug, Clone, Serialize)]
pub struct DiagnoseEvidenceLabels {
    /// What the retrieval section measured.
    pub retrieval_quality: &'static str,
    /// Answer usefulness is a separate measurement and was not made.
    pub answer_usefulness: &'static str,
    /// Provider compatibility/readiness was not evaluated.
    pub compatibility_readiness: &'static str,
    /// Nothing was written back to configuration or readiness stores.
    pub effect_on_product: &'static str,
}

impl Default for DiagnoseEvidenceLabels {
    fn default() -> Self {
        Self {
            retrieval_quality:
                "measured on this corpus against host-owned truth, under fixed budgets",
            answer_usefulness: "not_evaluated",
            compatibility_readiness: "not_evaluated",
            effect_on_product:
                "measurement only; no default, configuration, or readiness store was written",
        }
    }
}

/// `--dry-run` (default) output: what a run would do.
#[derive(Debug, Serialize)]
pub struct DiagnosePlanOutput {
    pub schema_id: &'static str,
    pub schema_version: u32,
    /// True when this invocation performed no provider work at all.
    pub dry_run: bool,
    pub credentials_read: bool,
    pub network: bool,
    pub evidence: DiagnoseEvidenceLabels,
    pub plan: DiagnosticPlan,
}

impl Render for DiagnosePlanOutput {
    fn render_text(&self) -> String {
        let mut out = String::from("Retrieval diagnostic — plan (dry run)\n\n");
        out.push_str(&format!("  Corpus:              {}\n", self.plan.corpus_id));
        out.push_str(&format!(
            "  Candidate K:         {}\n  Rerank pool depth:   {}\n  Packed context:      {} chars\n  Rerank budget:       {} ms\n",
            self.plan.budgets.candidate_k,
            self.plan.budgets.rerank_candidate_depth,
            self.plan.budgets.packed_context_chars,
            self.plan.budgets.rerank_timeout_ms
        ));
        out.push_str(&format!(
            "  Embedder:            {}\n",
            describe_role(
                self.plan.embedder_model.as_deref(),
                self.plan.embedder_dialect.as_deref()
            )
        ));
        out.push_str(&format!(
            "  Reranker:            {}\n",
            describe_role(
                self.plan.reranker_model.as_deref(),
                self.plan.reranker_dialect.as_deref()
            )
        ));
        out.push_str(&format!(
            "  Queries:             {}\n  Lanes:               {}\n",
            self.plan.query_ids.len(),
            self.plan.lanes.join(", ")
        ));

        out.push_str("\nEgress\n");
        if self.plan.requires_egress_consent {
            out.push_str(
                "  A configured role is remote: query and candidate text would leave this machine.\n",
            );
            out.push_str(if self.plan.egress_acknowledged {
                "  Acknowledged (--acknowledge-egress).\n"
            } else {
                "  NOT acknowledged — pass --acknowledge-egress to allow it.\n"
            });
        } else {
            out.push_str("  Every configured role is loopback: nothing leaves this machine.\n");
        }

        if let Some(reanalysis) = &self.plan.reanalysis {
            out.push_str("\nRe-analysis\n");
            out.push_str(&format!("  Needed:   {}\n", reanalysis.reason.code()));
            out.push_str(&format!("  Locality: {}\n", reanalysis.locality.as_str()));
            out.push_str(&format!("  {}\n", reanalysis.locality_copy()));
            out.push_str(&format!(
                "  Templates: {} of {}\n",
                reanalysis.templates_to_embed, reanalysis.total_templates
            ));
        }

        if !self.plan.blocked_lanes.is_empty() {
            out.push_str("\nLanes that cannot run as configured\n");
            for blocked in &self.plan.blocked_lanes {
                out.push_str(&format!(
                    "  [{}] {} — {}\n",
                    blocked.code, blocked.lane, blocked.detail
                ));
            }
        }

        out.push_str("\nEvidence classes\n");
        out.push_str("  Retrieval quality:       measured under fixed budgets\n");
        out.push_str("  Answer usefulness:       not evaluated\n");
        out.push_str("  Compatibility/readiness: not evaluated\n");
        out.push_str("\nNothing ran. Re-run with --confirm to execute these lanes.\n");
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// `--confirm` output: measured lane comparison.
#[derive(Debug, Serialize)]
pub struct DiagnoseRunOutput {
    pub schema_id: &'static str,
    pub schema_version: u32,
    pub dry_run: bool,
    pub evidence: DiagnoseEvidenceLabels,
    /// Basename only when a report file was written; never an absolute path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrote: Option<String>,
    pub report: Box<RetrievalDiagnosticReport>,
}

fn describe_role(model: Option<&str>, dialect: Option<&str>) -> String {
    match (model, dialect) {
        (None, _) => "not configured".into(),
        (Some(model), Some(dialect)) => format!("{model} ({dialect})"),
        (Some(model), None) => format!("{model} (NO EXPLICIT DIALECT — lane blocked)"),
    }
}

fn fmt_metric(value: Option<f64>) -> String {
    value
        .map(|value| format!("{value:>6.3}"))
        .unwrap_or_else(|| "     —".into())
}

impl Render for DiagnoseRunOutput {
    fn render_text(&self) -> String {
        let report = &self.report;
        let mut out = String::from("Retrieval diagnostic — measured lane comparison\n\n");
        out.push_str(&format!("  Verdict:   {}\n", report.verdict.as_str()));
        out.push_str(&format!("  Corpus:    {}\n", report.corpus.corpus_id));
        out.push_str(&format!(
            "  Revisions: events {} / templates {}\n",
            report.corpus.event_revision, report.corpus.template_analysis_revision
        ));
        out.push_str(&format!(
            "  Corpus:    {} events, {} templates, {} embedded\n",
            report.corpus.event_count,
            report.corpus.template_count,
            report.corpus.embedded_templates
        ));
        out.push_str(&format!(
            "  Space:     {}\n",
            report
                .corpus
                .stored_space_label
                .as_deref()
                .unwrap_or("unbound (legacy or not embedded)")
        ));
        out.push_str(&format!(
            "  Budgets:   K={} pool={} context={} chars\n",
            report.budgets.candidate_k,
            report.budgets.rerank_candidate_depth,
            report.budgets.packed_context_chars
        ));
        if let Some(name) = &self.wrote {
            out.push_str(&format!("  Wrote:     {name}\n"));
        }

        // ASCII table: readable with or without color, and stable in a diff.
        out.push_str("\nRetrieval (higher is better except decoys)\n");
        out.push_str(
            "  lane                      status     recall   nDCG    MRR  anchors  decoys   ms\n",
        );
        out.push_str(
            "  ------------------------- --------- ------ ------ ------ -------- ------- ----\n",
        );
        for lane in &report.lanes {
            out.push_str(&format!(
                "  {:<25} {:<9} {} {} {} {} {} {:>4}\n",
                lane.lane,
                lane.status.as_str(),
                fmt_metric(lane.mean_recall_at_k),
                fmt_metric(lane.mean_ndcg_at_k),
                fmt_metric(lane.mean_mrr),
                fmt_metric(lane.mean_mandatory_anchor_retention),
                fmt_metric(lane.mean_decoy_contamination),
                lane.execution.latency_ms
            ));
        }

        out.push_str("\nLane detail\n");
        for lane in &report.lanes {
            out.push_str(&format!("  {} [{}]\n", lane.lane, lane.status.as_str()));
            out.push_str(&format!("    engine:  {}\n", lane.engine));
            if let Some(reason) = &lane.blocked_reason {
                out.push_str(&format!(
                    "    blocked: {} — {}\n",
                    reason.code, reason.detail
                ));
                continue;
            }
            if let Some(model) = &lane.embedding_model {
                out.push_str(&format!(
                    "    embed:   {model} ({}) space={}\n",
                    lane.embedding_dialect.as_deref().unwrap_or("unclassified"),
                    lane.embedding_space_fingerprint
                        .as_deref()
                        .and_then(|fingerprint| fingerprint.get(..12))
                        .unwrap_or("unknown")
                ));
            }
            if let Some(model) = &lane.rerank_model {
                out.push_str(&format!(
                    "    rerank:  {model} ({})\n",
                    lane.rerank_dialect.as_deref().unwrap_or("unclassified")
                ));
            }
            if let Some(mode) = &lane.execution.mode_used {
                out.push_str(&format!("    mode:    {mode}\n"));
            }
            out.push_str(&format!(
                "    calls:   embed={} rerank={} pool={} rerank_pool={} anchors_promoted={}\n",
                opt(lane.execution.embedding_calls),
                opt(lane.execution.rerank_calls),
                opt(lane.execution.candidate_pool_size),
                opt(lane.execution.rerank_pool_size),
                opt(lane.execution.anchors_promoted),
            ));
            out.push_str(&format!(
                "    context: {} chars{}\n",
                lane.execution.packed_context_chars,
                if lane.execution.packed_context_exceeded {
                    " (OVER BUDGET)"
                } else {
                    ""
                }
            ));
            if !lane.execution.fallback_codes.is_empty() {
                out.push_str(&format!(
                    "    fallback: {}\n",
                    lane.execution.fallback_codes.join(", ")
                ));
            }
            for raw in &lane.raw_rankings {
                out.push_str(&format!(
                    "    raw[{}]: {:?}   (local only — not share-safe)\n",
                    raw.query_id, raw.ranked_seqs
                ));
            }
            for query in &lane.queries {
                if !query.missing_mandatory_anchors.is_empty() {
                    out.push_str(&format!(
                        "    {}: MISSING mandatory anchors {:?}\n",
                        query.query_id, query.missing_mandatory_anchors
                    ));
                }
                if query.invalid_ranking {
                    out.push_str(&format!("    {}: INVALID ranking\n", query.query_id));
                }
            }
        }

        if let Some(probe) = &report.vector_stability {
            out.push_str("\nEmbedder contract probe\n");
            out.push_str(&format!("  space:      {}\n", probe.space_label));
            out.push_str(&format!(
                "  dimensions: {}   norms: {}..{}\n",
                probe
                    .dimensions
                    .map(|dims| dims.to_string())
                    .unwrap_or_else(|| "unmeasured".into()),
                probe
                    .l2_norm_min
                    .map(|value| format!("{value:.3}"))
                    .unwrap_or_else(|| "—".into()),
                probe
                    .l2_norm_max
                    .map(|value| format!("{value:.3}"))
                    .unwrap_or_else(|| "—".into()),
            ));
            out.push_str(&format!(
                "  stable:     duplicates={} cross-call={} dims-across-calls={}\n",
                tri(probe.duplicate_inputs_stable),
                tri(probe.cross_call_stable),
                tri(probe.cross_call_dimensions_stable)
            ));
            for finding in &probe.findings {
                out.push_str(&format!("  ! {finding}\n"));
            }
        }
        if let Some(probe) = &report.rerank_semantics {
            out.push_str("\nReranker contract probe\n");
            out.push_str(&format!(
                "  model:      {} ({})\n",
                probe.model, probe.dialect
            ));
            out.push_str(&format!(
                "  permutation={} scores-follow-documents={} promotes-beyond-k={}\n",
                tri(probe.complete_permutation),
                tri(probe.scores_follow_documents),
                tri(probe.promotes_beyond_k)
            ));
            for finding in &probe.findings {
                out.push_str(&format!("  ! {finding}\n"));
            }
        }

        out.push_str("\nEvidence classes\n");
        out.push_str("  Retrieval quality:       measured under fixed budgets\n");
        out.push_str("  Answer usefulness:       not evaluated\n");
        out.push_str("  Compatibility/readiness: not evaluated\n");
        out.push_str(
            "\nThis report measures retrieval on this corpus only. It does not prove live model\n\
             usefulness or provider compatibility, and it changed no default or readiness store.\n",
        );
        if !report.comparable() {
            out.push_str(
                "\nFewer than two lanes produced a result: this run is INCONCLUSIVE, not a winner.\n",
            );
        }
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

fn opt(value: Option<u64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "unknown".into())
}

fn tri(value: Option<bool>) -> &'static str {
    match value {
        Some(true) => "yes",
        Some(false) => "NO",
        None => "unmeasured",
    }
}

/// Tagged output so `main` can render either shape uniformly.
#[derive(Debug)]
pub enum RetrievalDiagnoseOutput {
    /// Dry run: the plan only.
    Plan(Box<DiagnosePlanOutput>),
    /// Executed: the measured comparison.
    Run(Box<DiagnoseRunOutput>),
}

impl Render for RetrievalDiagnoseOutput {
    fn render_text(&self) -> String {
        match self {
            Self::Plan(output) => output.render_text(),
            Self::Run(output) => output.render_text(),
        }
    }

    fn render_json(&self) -> serde_json::Value {
        match self {
            Self::Plan(output) => output.render_json(),
            Self::Run(output) => output.render_json(),
        }
    }
}

impl RetrievalDiagnoseOutput {
    /// Nonzero exit when the run could not compare lanes.
    ///
    /// A *degraded* run still exits zero: it produced a real comparison and
    /// said what degraded. Only an inconclusive run is a failed verdict, and a
    /// dry run is never one.
    pub fn failed_verdict(&self) -> bool {
        match self {
            Self::Plan(_) => false,
            Self::Run(output) => output.report.verdict == DiagnosticVerdict::Inconclusive,
        }
    }
}

/// Host-owned query file: questions plus the truth used to score them.
#[derive(Debug, serde::Deserialize)]
struct QueryFile {
    queries: Vec<DiagnosticQuery>,
}

fn load_queries(path: &Path) -> CliResult<Vec<DiagnosticQuery>> {
    let bytes = std::fs::read(path).map_err(|error| {
        CliError::user(format!(
            "cannot read the query file `{}`: {error}",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("queries.json")
        ))
    })?;
    let parsed: QueryFile = serde_json::from_slice(&bytes)
        .map_err(|error| CliError::user(format!("query file is not valid: {error}")))?;
    if parsed.queries.is_empty() {
        return Err(CliError::user(
            "the query file declares no queries; there is nothing to measure",
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    for query in &parsed.queries {
        if !seen.insert(query.query_id.clone()) {
            return Err(CliError::user(format!(
                "duplicate query id `{}`; ids must be unique so report rows stay attributable",
                query.query_id
            )));
        }
    }
    Ok(parsed.queries)
}

fn parse_lanes(values: &[String]) -> CliResult<Vec<DiagnosticLane>> {
    if values.is_empty() {
        return Ok(DiagnosticLane::ALL.to_vec());
    }
    let mut lanes = Vec::new();
    for value in values {
        let lane = DiagnosticLane::ALL
            .into_iter()
            .find(|lane| lane.as_str() == value.trim())
            .ok_or_else(|| {
                CliError::user(format!(
                    "unknown lane `{value}`; use one of {}",
                    DiagnosticLane::ALL
                        .iter()
                        .map(|lane| lane.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            })?;
        if !lanes.contains(&lane) {
            lanes.push(lane);
        }
    }
    Ok(lanes)
}

/// Resolve the corpus this run targets.
fn resolve_corpus(args: &RetrievalDiagnoseArgs, current: &Option<String>) -> CliResult<String> {
    if let Some(id) = args.corpus_id.as_ref() {
        return Ok(id.clone());
    }
    current.clone().ok_or_else(|| {
        CliError::user(
            "no corpus selected; pass --corpus-id or select one with `contextdesk corpus use`",
        )
    })
}

/// Run the command.
pub async fn run(
    args: &RetrievalDiagnoseArgs,
    cache_root: &Path,
    app_cfg: &AppConfig,
    current_corpus_id: &Option<String>,
    secrets: &dyn cd_core::keychain_store::SecretStore,
) -> CliResult<RetrievalDiagnoseOutput> {
    // Raw local output needs BOTH flags. One flag is too easy to pass by
    // habit, and the whole point of the default is that a report can be
    // pasted into a ticket without re-reading it first.
    if args.include_raw && !args.raw_output_is_not_share_safe {
        return Err(CliError::user(format!(
            "--include-raw also requires {RAW_CONSENT_FLAG}: raw output is local-only and is not \
             safe to share"
        )));
    }

    let corpus_id = resolve_corpus(args, current_corpus_id)?;
    let queries = load_queries(&args.queries)?;
    let lanes = parse_lanes(&args.lane)?;
    let budgets = DiagnosticBudgets {
        candidate_k: args.k,
        rerank_candidate_depth: args.rerank_candidate_depth,
        packed_context_chars: args.packed_context_chars,
        rerank_timeout_ms: args.rerank_timeout_ms,
    }
    .normalized();

    let request = DiagnosticRequest {
        corpus_id,
        queries,
        budgets,
        lanes,
        egress_acknowledged: args.acknowledge_egress,
        // Both consents were checked above; raw rankings are local-only.
        include_raw: args.include_raw,
    };

    let plan = plan_diagnostic(cache_root, &request, app_cfg)
        .map_err(|error| CliError::user(error.to_string()))?;

    if !args.confirm {
        return Ok(RetrievalDiagnoseOutput::Plan(Box::new(
            DiagnosePlanOutput {
                schema_id: RETRIEVAL_DIAGNOSE_SCHEMA_ID,
                schema_version: RETRIEVAL_DIAGNOSTIC_SCHEMA_VERSION,
                dry_run: true,
                credentials_read: false,
                network: false,
                evidence: DiagnoseEvidenceLabels::default(),
                plan,
            },
        )));
    }

    if plan.requires_egress_consent && !request.egress_acknowledged {
        return Err(CliError::user(
            "a configured retrieval role is remote and egress was not acknowledged; query and \
             candidate text would leave this machine. Re-run with --acknowledge-egress, or \
             configure a loopback role.",
        ));
    }

    let cancel = CancelFlag::new();
    let cancel_for_signal = cancel.clone();
    let signal = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            cancel_for_signal.cancel();
        }
    });

    let cache_root_owned = cache_root.to_path_buf();
    let report = run_diagnostic(
        &cache_root_owned,
        &request,
        app_cfg,
        Some(secrets),
        |_lane| {
            // A fresh production host per lane, so one lane's attached roles
            // can never leak into the next one's measurement.
            adapters::tool_host(&cache_root_owned)
                .map_err(|error| cd_core::error::CoreError::Message(error.to_string()))
        },
        Some(&cancel),
    )
    .await
    .map_err(|error| {
        if matches!(error, cd_core::error::CoreError::Cancelled) {
            CliError::cancelled("retrieval diagnostic cancelled; nothing was written")
        } else {
            CliError::user(error.to_string())
        }
    })?;
    signal.abort();

    if report
        .lanes
        .iter()
        .any(|lane| lane.status == LaneStatus::Cancelled)
    {
        return Err(CliError::cancelled(
            "retrieval diagnostic cancelled; nothing was written",
        ));
    }

    let wrote = write_report(args, &report)?;
    Ok(RetrievalDiagnoseOutput::Run(Box::new(DiagnoseRunOutput {
        schema_id: RETRIEVAL_DIAGNOSE_SCHEMA_ID,
        schema_version: RETRIEVAL_DIAGNOSTIC_SCHEMA_VERSION,
        dry_run: false,
        evidence: DiagnoseEvidenceLabels::default(),
        wrote,
        report: Box::new(report),
    })))
}

/// Write the machine report when `--output` is set. Returns the basename only.
fn write_report(
    args: &RetrievalDiagnoseArgs,
    report: &RetrievalDiagnosticReport,
) -> CliResult<Option<String>> {
    let Some(path) = args.output.as_ref() else {
        return Ok(None);
    };
    let body = match args.report_format.as_deref() {
        None | Some("json") => serde_json::to_string_pretty(report)
            .map_err(|error| CliError::internal(error.to_string()))?,
        Some("jsonl") => {
            // One line per lane, plus a header line carrying the shared
            // identity, so a lane row is never read without its corpus.
            let mut lines = Vec::new();
            lines.push(
                serde_json::json!({
                    "schema_id": report.schema_id,
                    "schema_version": report.schema_version,
                    "record": "header",
                    "corpus": report.corpus,
                    "budgets": report.budgets,
                    "verdict": report.verdict,
                    "evidence": report.evidence,
                    "vector_stability": report.vector_stability,
                    "rerank_semantics": report.rerank_semantics,
                })
                .to_string(),
            );
            for lane in &report.lanes {
                lines.push(
                    serde_json::json!({
                        "schema_id": report.schema_id,
                        "record": "lane",
                        "corpus_id": report.corpus.corpus_id,
                        "lane": lane,
                    })
                    .to_string(),
                );
            }
            lines.join("\n")
        }
        Some(other) => {
            return Err(CliError::user(format!(
                "unknown --report-format {other}; use json or jsonl"
            )));
        }
    };
    if path.exists() && !args.force {
        return Err(CliError::user(format!(
            "{} already exists; pass --force to replace it",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("the report file")
        )));
    }
    std::fs::write(path, body).map_err(|error| {
        CliError::internal(format!(
            "cannot write the report to `{}`: {error}",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("output")
        ))
    })?;
    Ok(Some(
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("output")
            .to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lanes_default_to_the_full_comparison_and_reject_unknown_names() {
        assert_eq!(parse_lanes(&[]).unwrap(), DiagnosticLane::ALL.to_vec());
        let selected = parse_lanes(&["dense".into(), "dense".into(), "hybrid_rrf".into()]).unwrap();
        assert_eq!(
            selected,
            vec![DiagnosticLane::Dense, DiagnosticLane::HybridRrf],
            "repeats collapse; order follows the flags"
        );
        let error = parse_lanes(&["semantic".into()]).unwrap_err();
        assert!(error.to_string().contains("unknown lane"));
        assert!(error.to_string().contains("hybrid_rrf"));
    }

    #[test]
    fn a_query_file_must_declare_unique_ids_and_at_least_one_query() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queries.json");

        std::fs::write(&path, r#"{"queries": []}"#).unwrap();
        assert!(load_queries(&path)
            .unwrap_err()
            .to_string()
            .contains("no queries"));

        std::fs::write(
            &path,
            r#"{"queries":[
                {"query_id":"a","question":"q","keyword_terms":["x"],"truth":{}},
                {"query_id":"a","question":"q2","keyword_terms":["y"],"truth":{}}
            ]}"#,
        )
        .unwrap();
        assert!(load_queries(&path)
            .unwrap_err()
            .to_string()
            .contains("duplicate query id"));

        std::fs::write(
            &path,
            r#"{"queries":[{"query_id":"a","question":"q","keyword_terms":["x"],"truth":{
                "relevant_seqs":[1,2],"mandatory_anchor_seqs":[1],"decoy_seqs":[9]
            }}]}"#,
        )
        .unwrap();
        let queries = load_queries(&path).unwrap();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].truth.mandatory_anchor_seqs.len(), 1);
    }

    #[test]
    fn a_missing_query_file_names_only_its_basename() {
        let error = load_queries(Path::new("/Users/someone/secret/queries.json")).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("queries.json"));
        assert!(
            !message.contains("/Users/"),
            "an error must not echo an absolute path: {message}"
        );
    }

    #[test]
    fn evidence_labels_never_claim_answer_usefulness() {
        let labels = DiagnoseEvidenceLabels::default();
        assert_eq!(labels.answer_usefulness, "not_evaluated");
        assert_eq!(labels.compatibility_readiness, "not_evaluated");
        assert!(labels.effect_on_product.contains("measurement only"));
    }

    #[test]
    fn a_role_without_an_explicit_dialect_is_labelled_as_blocking() {
        assert_eq!(describe_role(None, None), "not configured");
        assert_eq!(
            describe_role(Some("bge-m3"), Some("openai_embeddings")),
            "bge-m3 (openai_embeddings)"
        );
        let implicit = describe_role(Some("bge-m3"), None);
        assert!(implicit.contains("NO EXPLICIT DIALECT"));
        assert!(implicit.contains("blocked"));
    }

    #[test]
    fn metric_formatting_shows_unknown_as_a_dash_not_a_zero() {
        assert_eq!(fmt_metric(None).trim(), "—");
        assert_eq!(fmt_metric(Some(0.0)).trim(), "0.000");
        assert_eq!(opt(None), "unknown");
        assert_eq!(opt(Some(0)), "0");
        assert_eq!(tri(None), "unmeasured");
        assert_eq!(tri(Some(false)), "NO");
    }
}
