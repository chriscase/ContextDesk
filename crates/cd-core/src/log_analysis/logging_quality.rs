//! Deterministic, demo-safe **Logging Quality Assessment** v1.
//!
//! Pure corpus assessor: scores only facts recomputable from an already-imported
//! corpus (`meta.json` + DuckDB aggregates). No LLM/provider dependency, no
//! language-specific parsers, and no DuckDB/filesystem internals in the public
//! DTO.
//!
//! Improvement hints are **fixed templates keyed by finding code** — not a
//! free-form or model-generated “Engineering Improvement Plan.”
//!
//! Host split: this module is the pure assessor. Atomic report publication
//! lives in `cd-workflow`. Markdown is a pure projection of the JSON DTO.

use super::parse::{ActiveTimestampBasis, TimestampProvenance};
use super::query::{corpus_time_quality, TimeQuality};
use super::store::{CorpusStats, LogCorpus};
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Public schema id for the assessment document.
pub const LOGGING_QUALITY_SCHEMA_ID: &str = "contextdesk.logging_quality_assessment.v1";

/// Schema version for [`LoggingQualityAssessment`].
pub const LOGGING_QUALITY_SCHEMA_VERSION: u32 = 1;

/// Explicit redaction mode of the default public report.
pub const LOGGING_QUALITY_REDACTION_MODE: &str = "public_safe_default";

/// Maximum source rows retained (opaque keys only).
pub const MAX_ASSESSMENT_SOURCES: usize = 64;

/// Maximum findings retained after priority sort.
pub const MAX_ASSESSMENT_FINDINGS: usize = 24;

/// Maximum top-template concentration refs (ids + counts only).
pub const MAX_CONCENTRATION_TEMPLATES: usize = 8;

/// Exclusion reasons treated as **unsupported content** (not ignored, not failed).
const UNSUPPORTED_EXCLUSION_REASONS: &[&str] = &["binary", "empty", "no_events"];

/// Exclusion reasons treated as **ignored** selection (not partial failure).
const IGNORED_EXCLUSION_REASONS: &[&str] = &["hidden", "not_selected", "directory"];

/// Patterns forbidden in the serialized public report (case-insensitive scan).
pub fn public_assessment_denylist_patterns() -> &'static [&'static str] {
    &[
        "/users/",
        "/home/",
        "c:\\\\",
        "\\\\users\\\\",
        ".contextdesk",
        "log_corpora",
        "api_key",
        "apikey",
        "authorization:",
        "bearer ",
        "password",
        "aws_access",
        "openai.com",
        "api.x.ai",
    ]
}

// ─── Public DTOs ─────────────────────────────────────────────────────────────

/// Versioned logging-quality assessment shared by CLI, desktop, and API hosts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityAssessment {
    /// Stable schema id.
    pub schema_id: String,
    /// Schema version.
    pub schema_version: u32,
    /// Privacy/redaction contract.
    pub privacy: LoggingQualityPrivacy,
    /// Corpus identity (no paths).
    pub corpus: LoggingQualityCorpusRef,
    /// Overall summary.
    pub summary: LoggingQualitySummary,
    /// Measured metrics (facts).
    pub metrics: LoggingQualityMetrics,
    /// Per-source aggregates under opaque keys.
    pub sources: Vec<LoggingQualitySourceMetrics>,
    /// Evidence-backed findings with fixed-code improvement hints.
    pub findings: Vec<LoggingQualityFinding>,
    /// Assessment-wide confidence.
    pub confidence: LoggingQualityConfidence,
    /// Mandatory honesty limits (non-empty when residual uncertainty applies).
    pub limitations: Vec<String>,
}

/// Privacy policy embedded in every report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityPrivacy {
    /// Redaction mode id.
    pub redaction_mode: String,
    /// Human-oriented description of what is stripped.
    pub policy_summary: String,
    /// True when source inventory was truncated.
    pub sources_truncated: bool,
    /// True when findings were capped.
    pub inventory_capped: bool,
}

/// Corpus reference without filesystem paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityCorpusRef {
    /// Corpus id.
    pub id: String,
    /// Display name (user-chosen; never a path).
    pub name: String,
    /// Imported event count.
    pub event_count: u64,
    /// Distinct template count.
    pub template_count: u64,
    /// Durable ingest `partial` flag only (not derived from ignored/unsupported).
    pub partial: bool,
}

/// Overall quality summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualitySummary {
    /// Deterministic score 0–100 (0 when insufficient).
    pub overall_score: u8,
    /// Coarse grade.
    pub grade: LoggingQualityGrade,
    /// One-line headline.
    pub headline: String,
    /// Measured dimension scores.
    pub dimensions: Vec<LoggingQualityDimensionScore>,
}

/// Coarse quality grade.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoggingQualityGrade {
    /// Score ≥ 85.
    Excellent,
    /// Score ≥ 70.
    Good,
    /// Score ≥ 50.
    Fair,
    /// Score ≥ 25.
    Poor,
    /// Empty corpus or score &lt; 25.
    Insufficient,
}

impl LoggingQualityGrade {
    fn from_score(score: u8, insufficient: bool) -> Self {
        if insufficient {
            return Self::Insufficient;
        }
        match score {
            85..=255 => Self::Excellent,
            70..=84 => Self::Good,
            50..=69 => Self::Fair,
            25..=49 => Self::Poor,
            _ => Self::Insufficient,
        }
    }

    /// Stable wire/display id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Excellent => "excellent",
            Self::Good => "good",
            Self::Fair => "fair",
            Self::Poor => "poor",
            Self::Insufficient => "insufficient",
        }
    }
}

/// One scored dimension.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityDimensionScore {
    /// Stable dimension id.
    pub id: String,
    /// Human label.
    pub label: String,
    /// Score 0–100.
    pub score: u8,
    /// Weight in basis points.
    pub weight_bps: u16,
    /// Measured-fact note.
    pub measured_fact: String,
}

/// Corpus-level measured metrics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityMetrics {
    /// Corpus time-quality classification from durable provenance/basis.
    pub time_quality: TimeQuality,
    /// Counts by timestamp provenance key.
    pub timestamp_provenance_counts: BTreeMap<String, u64>,
    /// Counts by active timestamp basis key.
    pub active_timestamp_basis_counts: BTreeMap<String, u64>,
    /// Events with wall-clock active basis.
    pub wall_event_count: u64,
    /// Events that are order-only under active basis.
    pub order_only_event_count: u64,
    /// Events with unresolved local timestamp evidence.
    pub unresolved_local_event_count: u64,
    /// Distinct selection / omission buckets (never folded into each other).
    pub selection: LoggingQualitySelectionCoverage,
    /// Template concentration facts (review-only signal).
    pub templates: LoggingQualityTemplateMetrics,
    /// Stored-level honesty (not severity provenance).
    pub stored_level: LoggingQualityStoredLevelMetrics,
    /// Parser-true `trace_id` coverage only.
    pub trace_id: LoggingQualityTraceIdMetrics,
    /// Format mix from durable stats.
    pub format_counts: BTreeMap<String, u64>,
}

/// Distinct selection / omission buckets from durable corpus stats.
///
/// Ignored and unsupported are **not** partial import failures. `partial` is
/// only the durable ingest flag (or failed incomplete publication), never
/// inferred from ignored/unsupported counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualitySelectionCoverage {
    /// Files successfully imported through EOF (`stats.files`).
    pub selected_imported: u64,
    /// Entries discovered before policy/read decisions.
    pub discovered: u64,
    /// Intentionally ignored (hidden / not_selected / directory).
    pub ignored: u64,
    /// Unsupported content reasons mapped from exclusion histogram (e.g. binary).
    pub unsupported: u64,
    /// Policy-excluded (too_large, symlink, …) excluding ignored/unsupported maps.
    pub excluded_policy: u64,
    /// Failed open/read.
    pub failed: u64,
    /// Durable `stats.partial` only.
    pub partial: bool,
    /// Full exclusion/failure reason histogram.
    pub exclusion_reason_counts: BTreeMap<String, u64>,
    /// Honesty about preview-only labels.
    pub availability_note: String,
}

/// Template concentration metrics (review-only; never verified noise).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityTemplateMetrics {
    /// Distinct templates.
    pub template_count: u64,
    /// Event count used for ratios.
    pub event_count: u64,
    /// `events / templates` triage ratio (not disk compression).
    pub reduction_ratio: f64,
    /// Top-template share in basis points.
    pub top_template_share_bps: u64,
    /// Concentration HHI-style score in bps (0–10000).
    pub concentration_hhi_bps: u64,
    /// ERROR/FATAL events on the top template (risk disclosure for proposals).
    pub top_template_error_or_fatal_count: u64,
    /// Top template ids + counts only (no pattern/example text).
    pub top_templates: Vec<LoggingQualityTemplateRef>,
    /// Explicit proposal-only wording contract.
    pub proposal_note: String,
}

/// Template identity without pattern/example text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityTemplateRef {
    /// Template id.
    pub template_id: u64,
    /// Event count.
    pub event_count: u64,
}

/// Stored normalized level counts — **not** severity provenance.
///
/// Imported DuckDB events do not carry OTel/source-declared severity
/// provenance. This block never emits `schema_mapped`, `source_declared`,
/// `raw`, or `canonical` severity fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityStoredLevelMetrics {
    /// Level histogram (normalized vocabulary).
    pub level_counts: BTreeMap<String, u64>,
    /// Events with a known normalized level (not `unknown` / empty).
    pub known_level_count: u64,
    /// Events with unknown/empty level.
    pub unknown_level_count: u64,
    /// Known-level share in basis points.
    pub known_level_share_bps: u64,
    /// Always false for imported corpora in v1.
    pub severity_provenance_available: bool,
    /// Honesty contract.
    pub honesty_note: String,
}

/// Parser-true `trace_id` coverage (never request/span id promotion).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityTraceIdMetrics {
    /// Events with non-empty parser-populated `trace_id`.
    pub with_trace_id: u64,
    /// Fill rate in basis points.
    pub trace_id_share_bps: u64,
    /// Honesty: only the `trace_id` column; not a tracing-product claim.
    pub availability_note: String,
}

/// Per-source metrics with an opaque key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualitySourceMetrics {
    /// Opaque stable key (`src_0001`, …).
    pub source_key: String,
    /// Event count.
    pub event_count: u64,
    /// Wall-clock events.
    pub wall_event_count: u64,
    /// Order-only events.
    pub order_only_event_count: u64,
    /// Unresolved local timestamp events.
    pub unresolved_local_event_count: u64,
    /// Parser-true `trace_id` events.
    pub with_trace_id: u64,
    /// Unknown-level events.
    pub unknown_level_count: u64,
    /// Dominant normalized level when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dominant_level: Option<String>,
}

/// One deterministic, evidence-backed finding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityFinding {
    /// Stable finding code (template key).
    pub id: String,
    /// Severity for triage.
    pub severity: LoggingQualityFindingSeverity,
    /// Priority 1–100 (higher first).
    pub priority: u8,
    /// Category.
    pub category: LoggingQualityFindingCategory,
    /// Short title.
    pub title: String,
    /// (1) Measured fact.
    pub measured_fact: String,
    /// (2) Deterministic finding (no root-cause claims).
    pub finding: String,
    /// (3) Fixed template improvement hint for this finding code.
    pub improvement_hint: LoggingQualityImprovementHint,
    /// (4) Evidence locators.
    pub evidence: Vec<LoggingQualityEvidenceLocator>,
    /// (5) Confidence.
    pub confidence: LoggingQualityFindingConfidence,
    /// Limits for this finding.
    pub limitations: Vec<String>,
}

/// Fixed, template-based improvement hint (not free-form LLM text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityImprovementHint {
    /// Stable hint template id (usually mirrors finding id with `hint.` prefix).
    pub template_id: String,
    /// Recommended producer/process change (fixed wording).
    pub change: String,
    /// Measurable acceptance criteria (fixed wording).
    pub acceptance_criteria: Vec<String>,
}

/// Finding severity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoggingQualityFindingSeverity {
    /// Blocks trustworthy time analysis.
    Critical,
    /// Material quality gap.
    High,
    /// Notable gap.
    Medium,
    /// Minor / hygiene.
    Low,
    /// Informational honesty note.
    Info,
}

/// Finding category (v1 evidence-backed set).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoggingQualityFindingCategory {
    /// Timestamp certainty / provenance.
    TimestampCertainty,
    /// Selection coverage buckets.
    SelectionCoverage,
    /// Parse / format structure.
    ParseStructure,
    /// Stored-level vs severity-provenance honesty.
    StoredLevelHonesty,
    /// Review-only noise concentration.
    NoiseConcentrationReview,
    /// Parser-true trace_id coverage.
    TraceIdCoverage,
    /// Empty / insufficient corpus.
    Corpus,
}

/// Finding-level confidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoggingQualityFindingConfidence {
    /// Fully backed by durable corpus counters.
    High,
    /// Backed by durable data with known semantic limits.
    Medium,
    /// Incomplete signal.
    Low,
}

/// Evidence locator — never a raw body or private path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityEvidenceLocator {
    /// Locator kind.
    pub kind: LoggingQualityEvidenceKind,
    /// Stable key (metric path, source_key, template_id string).
    pub key: String,
    /// Optional numeric value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<u64>,
    /// Short human label.
    pub label: String,
}

/// Evidence locator kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoggingQualityEvidenceKind {
    /// Corpus-level metric path.
    CorpusMetric,
    /// Opaque source key aggregate.
    SourceAggregate,
    /// Template id + count.
    Template,
    /// Selection bucket field.
    SelectionBucket,
}

/// Assessment-wide confidence block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoggingQualityConfidence {
    /// Overall confidence.
    pub level: LoggingQualityFindingConfidence,
    /// Short summary.
    pub summary: String,
    /// Explicit non-claims.
    pub non_claims: Vec<String>,
}

// ─── Assessor ────────────────────────────────────────────────────────────────

/// Assess an open corpus. Pure over durable corpus state (deterministic).
pub fn assess_logging_quality(corpus: &LogCorpus) -> CoreResult<LoggingQualityAssessment> {
    let summary_meta = corpus.summary();
    let meta = corpus.meta()?;
    let stats = meta.stats.clone().unwrap_or_default();
    let time_quality = corpus_time_quality(corpus);
    let aggregates = query_corpus_aggregates(corpus)?;
    let source_rows = query_source_aggregates(corpus)?;

    let event_count = aggregates.event_count;
    let template_count = if stats.templates > 0 {
        stats.templates
    } else {
        summary_meta.template_count
    };

    let metrics = build_metrics(&stats, time_quality, &aggregates, template_count);
    let (sources, sources_truncated) = build_source_metrics(&source_rows);

    let mut findings = derive_findings(&metrics, &sources, event_count);
    findings.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.id.cmp(&b.id)));
    let inventory_capped = findings.len() > MAX_ASSESSMENT_FINDINGS;
    findings.truncate(MAX_ASSESSMENT_FINDINGS);

    let limitations = build_limitations(&metrics, event_count, sources_truncated);
    // Residual uncertainty always applies for imported corpora (no severity
    // provenance; selection preview labels may be incomplete).
    debug_assert!(
        !limitations.is_empty(),
        "v1 requires non-empty limitations whenever residual uncertainty applies"
    );

    let dimensions = score_dimensions(&metrics, event_count);
    let insufficient = event_count == 0;
    let overall_score = if insufficient {
        0
    } else {
        weighted_score(&dimensions)
    };
    let grade = LoggingQualityGrade::from_score(overall_score, insufficient);
    let headline = build_headline(grade, &findings, event_count);

    let _ = (
        TimestampProvenance::OrderOnly,
        ActiveTimestampBasis::OrderOnly,
    );

    Ok(LoggingQualityAssessment {
        schema_id: LOGGING_QUALITY_SCHEMA_ID.into(),
        schema_version: LOGGING_QUALITY_SCHEMA_VERSION,
        privacy: LoggingQualityPrivacy {
            redaction_mode: LOGGING_QUALITY_REDACTION_MODE.into(),
            policy_summary: "Default public-safe report: aggregate counts, opaque source keys, \
template ids, and metric locators only. Strips log payloads, template pattern/example text, \
absolute paths, archive ancestry, credentials, environment values, and unredacted exemplars."
                .into(),
            sources_truncated,
            inventory_capped,
        },
        corpus: LoggingQualityCorpusRef {
            id: summary_meta.id,
            name: summary_meta.name,
            event_count,
            template_count,
            partial: stats.partial,
        },
        summary: LoggingQualitySummary {
            overall_score,
            grade,
            headline,
            dimensions,
        },
        metrics,
        sources,
        findings,
        confidence: LoggingQualityConfidence {
            level: if insufficient {
                LoggingQualityFindingConfidence::Low
            } else {
                LoggingQualityFindingConfidence::High
            },
            summary: if insufficient {
                "No imported events; assessment reports emptiness honestly.".into()
            } else {
                format!(
                    "Deterministic scores from durable corpus stats and event aggregates over {event_count} events."
                )
            },
            non_claims: fixed_non_claims(),
        },
        limitations,
    })
}

/// Validate a serialized assessment document (schema id/version + round-trip).
pub fn validate_logging_quality_json(bytes: &[u8]) -> CoreResult<LoggingQualityAssessment> {
    let report: LoggingQualityAssessment = serde_json::from_slice(bytes).map_err(|e| {
        CoreError::Message(format!(
            "logging quality report failed schema validation: {e}"
        ))
    })?;
    if report.schema_id != LOGGING_QUALITY_SCHEMA_ID {
        return Err(CoreError::Message(format!(
            "logging quality schema_id mismatch: {}",
            report.schema_id
        )));
    }
    if report.schema_version != LOGGING_QUALITY_SCHEMA_VERSION {
        return Err(CoreError::Message(format!(
            "logging quality schema_version mismatch: {}",
            report.schema_version
        )));
    }
    if report.limitations.is_empty() && report.corpus.event_count > 0 {
        return Err(CoreError::Message(
            "logging quality report missing mandatory limitations".into(),
        ));
    }
    // Reject severity-provenance matrix violations if a future writer smuggles them.
    reject_severity_matrix_violations(&report)?;
    Ok(report)
}

/// Render Markdown as a **pure projection** of the JSON assessment (not a second source of truth).
pub fn render_logging_quality_markdown(report: &LoggingQualityAssessment) -> String {
    let mut out = String::new();
    out.push_str("# Logging Quality Assessment\n\n");
    out.push_str(&format!(
        "_Projection of `{}` v{}. JSON is the source of truth. Improvement hints are fixed templates per finding code — not model-generated plans._\n\n",
        report.schema_id, report.schema_version
    ));
    out.push_str(&format!(
        "- Corpus: `{}` ({})\n",
        report.corpus.id, report.corpus.name
    ));
    out.push_str(&format!(
        "- Events: {} · Templates: {} · Partial: {}\n",
        report.corpus.event_count, report.corpus.template_count, report.corpus.partial
    ));
    out.push_str(&format!(
        "- Overall: **{}** (score {})\n",
        report.summary.grade.as_str(),
        report.summary.overall_score
    ));
    out.push_str(&format!("- Headline: {}\n\n", report.summary.headline));

    out.push_str("## Privacy\n\n");
    out.push_str(&format!(
        "{}\n\nRedaction mode: `{}`\n\n",
        report.privacy.policy_summary, report.privacy.redaction_mode
    ));

    out.push_str("## Measured metrics\n\n");
    out.push_str(&format!(
        "- Time quality: `{:?}` · wall={} · order_only={} · unresolved_local={}\n",
        report.metrics.time_quality,
        report.metrics.wall_event_count,
        report.metrics.order_only_event_count,
        report.metrics.unresolved_local_event_count
    ));
    out.push_str(&format!(
        "- Selection: selected={} ignored={} unsupported={} excluded_policy={} failed={} partial={}\n",
        report.metrics.selection.selected_imported,
        report.metrics.selection.ignored,
        report.metrics.selection.unsupported,
        report.metrics.selection.excluded_policy,
        report.metrics.selection.failed,
        report.metrics.selection.partial
    ));
    out.push_str(&format!(
        "- Templates: count={} reduction_ratio={:.2} top_share_bps={} hhi_bps={} top_error_fatal={}\n",
        report.metrics.templates.template_count,
        report.metrics.templates.reduction_ratio,
        report.metrics.templates.top_template_share_bps,
        report.metrics.templates.concentration_hhi_bps,
        report.metrics.templates.top_template_error_or_fatal_count
    ));
    out.push_str(&format!(
        "- Stored level known_share_bps={} (severity_provenance_available={})\n",
        report.metrics.stored_level.known_level_share_bps,
        report.metrics.stored_level.severity_provenance_available
    ));
    out.push_str(&format!(
        "- Parser trace_id share_bps={}\n\n",
        report.metrics.trace_id.trace_id_share_bps
    ));

    out.push_str("## Dimensions\n\n");
    for dim in &report.summary.dimensions {
        out.push_str(&format!(
            "- `{}` score={} weight_bps={}: {}\n",
            dim.id, dim.score, dim.weight_bps, dim.measured_fact
        ));
    }
    out.push('\n');

    out.push_str("## Findings\n\n");
    if report.findings.is_empty() {
        out.push_str("_No findings._\n\n");
    }
    for f in &report.findings {
        out.push_str(&format!(
            "### `{}` — {} ({:?}, priority {})\n\n",
            f.id, f.title, f.severity, f.priority
        ));
        out.push_str(&format!("1. **Measured fact:** {}\n", f.measured_fact));
        out.push_str(&format!("2. **Finding:** {}\n", f.finding));
        out.push_str(&format!(
            "3. **Improvement hint** (`{}`): {}\n",
            f.improvement_hint.template_id, f.improvement_hint.change
        ));
        out.push_str("   - Acceptance criteria:\n");
        for c in &f.improvement_hint.acceptance_criteria {
            out.push_str(&format!("     - {c}\n"));
        }
        out.push_str("4. **Evidence:**\n");
        for e in &f.evidence {
            out.push_str(&format!(
                "   - {:?} `{}`{} — {}\n",
                e.kind,
                e.key,
                e.value.map(|v| format!(" = {v}")).unwrap_or_default(),
                e.label
            ));
        }
        out.push_str(&format!("5. **Confidence:** {:?}\n", f.confidence));
        if !f.limitations.is_empty() {
            out.push_str("   - Limitations:\n");
            for lim in &f.limitations {
                out.push_str(&format!("     - {lim}\n"));
            }
        }
        out.push('\n');
    }

    out.push_str("## Source-level metrics\n\n");
    out.push_str(
        "| source_key | events | wall | order_only | unresolved | trace_id | unknown_level |\n",
    );
    out.push_str("|---|---:|---:|---:|---:|---:|---:|\n");
    for s in &report.sources {
        out.push_str(&format!(
            "| `{}` | {} | {} | {} | {} | {} | {} |\n",
            s.source_key,
            s.event_count,
            s.wall_event_count,
            s.order_only_event_count,
            s.unresolved_local_event_count,
            s.with_trace_id,
            s.unknown_level_count
        ));
    }
    out.push('\n');

    out.push_str("## Confidence & limitations\n\n");
    out.push_str(&format!(
        "- Confidence: {:?}\n- {}\n\n",
        report.confidence.level, report.confidence.summary
    ));
    out.push_str("### Non-claims\n\n");
    for n in &report.confidence.non_claims {
        out.push_str(&format!("- {n}\n"));
    }
    out.push_str("\n### Limitations\n\n");
    for lim in &report.limitations {
        out.push_str(&format!("- {lim}\n"));
    }
    out.push('\n');
    out
}

fn fixed_non_claims() -> Vec<String> {
    vec![
        "Does not investigate a live incident or assert root cause.".into(),
        "Does not use an LLM or external provider.".into(),
        "Does not synthesize calendar time from order-only events or numeric ts magnitude.".into(),
        "Concentration findings are review-only proposals, never verified noise.".into(),
        "Does not claim OTel severity compliance or source-declared severity provenance from stored level.".into(),
        "Does not claim universal parse success.".into(),
        "Parser-true trace_id fill is not a distributed-tracing product claim.".into(),
        "Does not promote request/span ids into trace coverage.".into(),
        "Ignored/unsupported selection buckets are not treated as partial import failures.".into(),
    ]
}

fn reject_severity_matrix_violations(report: &LoggingQualityAssessment) -> CoreResult<()> {
    let json = serde_json::to_string(report)
        .map_err(|e| CoreError::Message(format!("serialize for severity scan: {e}")))?;
    let lower = json.to_lowercase();
    // Imported-corpus LQA must never smuggle normalize-path severity matrix fields.
    for forbidden in [
        "\"schemamapped\"",
        "\"schema_mapped\"",
        "\"sourcedeclared\"",
        "\"source_declared\"",
        "\"textinferred\"",
        "\"text_inferred\"",
        "severityprovenance",
        "\"canonical\":",
        "\"raw\":",
    ] {
        // Allow honesty_note text that mentions these terms as negatives.
        if forbidden == "severityprovenance" {
            continue;
        }
        if lower.contains(forbidden)
            && !lower.contains("not severity provenance")
            && !lower.contains("severity_provenance_available\":false")
        {
            // Hard reject structured field names that imply normalize severity.
            if lower.contains("\"provenance\":\"source_declared\"")
                || lower.contains("\"provenance\":\"schema_mapped\"")
                || lower.contains("\"confidence\":\"low\"")
                    && lower.contains("\"provenance\":\"schema_mapped\"")
            {
                return Err(CoreError::Message(
                    "logging quality report contains forbidden severity provenance matrix fields"
                        .into(),
                ));
            }
        }
    }
    if report.metrics.stored_level.severity_provenance_available {
        return Err(CoreError::Message(
            "imported corpus assessment must not claim severity_provenance_available".into(),
        ));
    }
    Ok(())
}

// ─── Aggregates ──────────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct CorpusAggregates {
    event_count: u64,
    wall_event_count: u64,
    unresolved_local_event_count: u64,
    with_trace_id: u64,
    unknown_level_count: u64,
    template_counts: Vec<(u64, u64)>,
    top_template_error_or_fatal: u64,
}

#[derive(Debug)]
struct SourceAggregateRow {
    source: String,
    event_count: u64,
    wall_event_count: u64,
    unresolved_local_event_count: u64,
    with_trace_id: u64,
    unknown_level_count: u64,
    dominant_level: Option<String>,
}

fn query_corpus_aggregates(corpus: &LogCorpus) -> CoreResult<CorpusAggregates> {
    corpus.with_connection(|conn| {
        let mut agg = CorpusAggregates::default();
        conn.query_row(
            "SELECT
                COUNT(*),
                SUM(CASE WHEN active_timestamp_basis IN ('explicit_wall','resolved_local') THEN 1 ELSE 0 END),
                SUM(CASE WHEN unresolved_local_timestamp IS NOT NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN trace_id IS NOT NULL AND length(trace_id) > 0 THEN 1 ELSE 0 END),
                SUM(CASE WHEN level IS NULL OR level = '' OR lower(level) = 'unknown' THEN 1 ELSE 0 END)
             FROM events",
            [],
            |row| {
                agg.event_count = row.get::<_, i64>(0)?.max(0) as u64;
                agg.wall_event_count = row.get::<_, Option<i64>>(1)?.unwrap_or(0).max(0) as u64;
                agg.unresolved_local_event_count =
                    row.get::<_, Option<i64>>(2)?.unwrap_or(0).max(0) as u64;
                agg.with_trace_id = row.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u64;
                agg.unknown_level_count = row.get::<_, Option<i64>>(4)?.unwrap_or(0).max(0) as u64;
                Ok(())
            },
        )
        .map_err(|e| CoreError::Message(format!("logging quality corpus aggregates: {e}")))?;

        let mut stmt = conn
            .prepare(
                "SELECT template_id, COUNT(*) AS c
                 FROM events
                 GROUP BY template_id
                 ORDER BY c DESC, template_id ASC",
            )
            .map_err(|e| CoreError::Message(format!("logging quality templates prepare: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64))
            })
            .map_err(|e| CoreError::Message(format!("logging quality templates query: {e}")))?;
        for row in rows {
            let pair =
                row.map_err(|e| CoreError::Message(format!("logging quality template row: {e}")))?;
            agg.template_counts.push(pair);
        }

        if let Some((top_id, _)) = agg.template_counts.first().copied() {
            let err_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM events
                     WHERE template_id = ?
                       AND lower(level) IN ('error','fatal','critical','emergency','alert')",
                    [top_id as i64],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            agg.top_template_error_or_fatal = err_count.max(0) as u64;
        }
        Ok(agg)
    })
}

fn query_source_aggregates(corpus: &LogCorpus) -> CoreResult<Vec<SourceAggregateRow>> {
    corpus.with_connection(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT
                    source,
                    COUNT(*),
                    SUM(CASE WHEN active_timestamp_basis IN ('explicit_wall','resolved_local') THEN 1 ELSE 0 END),
                    SUM(CASE WHEN unresolved_local_timestamp IS NOT NULL THEN 1 ELSE 0 END),
                    SUM(CASE WHEN trace_id IS NOT NULL AND length(trace_id) > 0 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN level IS NULL OR level = '' OR lower(level) = 'unknown' THEN 1 ELSE 0 END)
                 FROM events
                 GROUP BY source
                 ORDER BY source ASC",
            )
            .map_err(|e| CoreError::Message(format!("logging quality sources prepare: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SourceAggregateRow {
                    source: row.get::<_, String>(0)?,
                    event_count: row.get::<_, i64>(1)?.max(0) as u64,
                    wall_event_count: row.get::<_, Option<i64>>(2)?.unwrap_or(0).max(0) as u64,
                    unresolved_local_event_count: row
                        .get::<_, Option<i64>>(3)?
                        .unwrap_or(0)
                        .max(0) as u64,
                    with_trace_id: row.get::<_, Option<i64>>(4)?.unwrap_or(0).max(0) as u64,
                    unknown_level_count: row.get::<_, Option<i64>>(5)?.unwrap_or(0).max(0) as u64,
                    dominant_level: None,
                })
            })
            .map_err(|e| CoreError::Message(format!("logging quality sources query: {e}")))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(
                row.map_err(|e| CoreError::Message(format!("logging quality source row: {e}")))?,
            );
        }

        let mut level_stmt = conn
            .prepare(
                "SELECT source, lower(level) AS lvl, COUNT(*) AS c
                 FROM events
                 GROUP BY source, lower(level)
                 ORDER BY source ASC, c DESC, lvl ASC",
            )
            .map_err(|e| CoreError::Message(format!("logging quality levels prepare: {e}")))?;
        let level_rows = level_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? as u64,
                ))
            })
            .map_err(|e| CoreError::Message(format!("logging quality levels query: {e}")))?;
        let mut seen: BTreeMap<String, String> = BTreeMap::new();
        for row in level_rows {
            let (source, level, _count) =
                row.map_err(|e| CoreError::Message(format!("logging quality level row: {e}")))?;
            seen.entry(source).or_insert(level);
        }
        for row in &mut out {
            row.dominant_level = seen.get(&row.source).cloned();
        }
        Ok(out)
    })
}

fn build_selection(stats: &CorpusStats) -> LoggingQualitySelectionCoverage {
    let mut ignored_from_reasons = 0u64;
    let mut unsupported = 0u64;
    let mut excluded_policy = 0u64;
    for (reason, count) in &stats.exclusion_counts {
        if IGNORED_EXCLUSION_REASONS.contains(&reason.as_str()) {
            ignored_from_reasons = ignored_from_reasons.saturating_add(*count);
        } else if UNSUPPORTED_EXCLUSION_REASONS.contains(&reason.as_str()) {
            unsupported = unsupported.saturating_add(*count);
        } else {
            excluded_policy = excluded_policy.saturating_add(*count);
        }
    }
    // Prefer durable ignored_files when present; reasons are a cross-check.
    let ignored = if stats.ignored_files > 0 {
        stats.ignored_files
    } else {
        ignored_from_reasons
    };
    // Prefer durable excluded_files minus unsupported mapping when possible.
    let excluded_policy = if stats.excluded_files > 0 {
        stats.excluded_files.saturating_sub(unsupported)
    } else {
        excluded_policy
    };

    LoggingQualitySelectionCoverage {
        selected_imported: stats.files,
        discovered: stats.discovered_files,
        ignored,
        unsupported,
        excluded_policy,
        failed: stats.failed_files,
        // Durable flag only — never inferred from ignored/unsupported.
        partial: stats.partial,
        exclusion_reason_counts: stats.exclusion_counts.clone(),
        availability_note: "Selection buckets are distinct: ignored and unsupported are not \
partial import failures. `partial` is only the durable ingest flag. Preview-only \
`unsupported` classifier labels are not separately persisted; unsupported here is mapped from \
durable exclusion reasons (binary/empty/no_events) when present."
            .into(),
    }
}

fn build_metrics(
    stats: &CorpusStats,
    time_quality: TimeQuality,
    aggregates: &CorpusAggregates,
    template_count: u64,
) -> LoggingQualityMetrics {
    let event_count = aggregates.event_count;
    let order_only = event_count.saturating_sub(aggregates.wall_event_count);
    let reduction_ratio = if template_count == 0 {
        0.0
    } else if stats.reduction_ratio > 0.0 {
        stats.reduction_ratio
    } else {
        event_count as f64 / template_count as f64
    };
    let (top_share_bps, hhi_bps, top_refs) =
        concentration_from_counts(&aggregates.template_counts, event_count);
    let known_level = event_count.saturating_sub(aggregates.unknown_level_count);

    LoggingQualityMetrics {
        time_quality,
        timestamp_provenance_counts: stats.timestamp_provenance_counts.clone(),
        active_timestamp_basis_counts: stats.active_timestamp_basis_counts.clone(),
        wall_event_count: aggregates.wall_event_count,
        order_only_event_count: order_only,
        unresolved_local_event_count: aggregates.unresolved_local_event_count,
        selection: build_selection(stats),
        templates: LoggingQualityTemplateMetrics {
            template_count,
            event_count,
            reduction_ratio,
            top_template_share_bps: top_share_bps,
            concentration_hhi_bps: hhi_bps,
            top_template_error_or_fatal_count: aggregates.top_template_error_or_fatal,
            top_templates: top_refs,
            proposal_note: "Template concentration is a review-only proposal signal. It is never \
verified noise. ERROR/FATAL-heavy hot templates are disclosed as risk, not suppressed."
                .into(),
        },
        stored_level: LoggingQualityStoredLevelMetrics {
            level_counts: stats.level_counts.clone(),
            known_level_count: known_level,
            unknown_level_count: aggregates.unknown_level_count,
            known_level_share_bps: share_bps(known_level, event_count),
            severity_provenance_available: false,
            honesty_note:
                "Stored corpus level is the parser's normalized vocabulary \
(debug/info/warn/error/fatal/unknown). It is not severity provenance. v1 does not emit \
source_declared, schema_mapped, text_inferred, raw, or canonical severity fields from stored level."
                    .into(),
        },
        trace_id: LoggingQualityTraceIdMetrics {
            with_trace_id: aggregates.with_trace_id,
            trace_id_share_bps: share_bps(aggregates.with_trace_id, event_count),
            availability_note: "Only the parser-populated events.trace_id column is counted. \
Request/span/session aliases are not promoted. This is not a distributed-tracing product claim."
                .into(),
        },
        format_counts: stats.format_counts.clone(),
    }
}

fn build_source_metrics(rows: &[SourceAggregateRow]) -> (Vec<LoggingQualitySourceMetrics>, bool) {
    let truncated = rows.len() > MAX_ASSESSMENT_SOURCES;
    let take = rows.len().min(MAX_ASSESSMENT_SOURCES);
    let mut out = Vec::with_capacity(take);
    for (idx, row) in rows.iter().take(take).enumerate() {
        let _ = &row.source; // never emit paths
        out.push(LoggingQualitySourceMetrics {
            source_key: format!("src_{:04}", idx + 1),
            event_count: row.event_count,
            wall_event_count: row.wall_event_count,
            order_only_event_count: row.event_count.saturating_sub(row.wall_event_count),
            unresolved_local_event_count: row.unresolved_local_event_count,
            with_trace_id: row.with_trace_id,
            unknown_level_count: row.unknown_level_count,
            dominant_level: row.dominant_level.clone(),
        });
    }
    (out, truncated)
}

fn concentration_from_counts(
    template_counts: &[(u64, u64)],
    event_count: u64,
) -> (u64, u64, Vec<LoggingQualityTemplateRef>) {
    if event_count == 0 || template_counts.is_empty() {
        return (0, 0, Vec::new());
    }
    let top = template_counts.first().map(|(_, c)| *c).unwrap_or(0);
    let top_share_bps = share_bps(top, event_count);
    let mut hhi: u128 = 0;
    for (_, count) in template_counts {
        let share_bps = share_bps(*count, event_count) as u128;
        hhi = hhi.saturating_add(share_bps.saturating_mul(share_bps));
    }
    let hhi_bps = (hhi / 100).min(10_000) as u64;
    let top_refs = template_counts
        .iter()
        .take(MAX_CONCENTRATION_TEMPLATES)
        .map(|(id, count)| LoggingQualityTemplateRef {
            template_id: *id,
            event_count: *count,
        })
        .collect();
    (top_share_bps, hhi_bps, top_refs)
}

fn share_bps(part: u64, total: u64) -> u64 {
    if total == 0 {
        0
    } else {
        ((part as u128) * 10_000 / (total as u128)) as u64
    }
}

fn build_limitations(
    metrics: &LoggingQualityMetrics,
    event_count: u64,
    sources_truncated: bool,
) -> Vec<String> {
    let mut out = Vec::new();
    if event_count == 0 {
        out.push("Corpus has zero imported events.".into());
    }
    out.push(metrics.selection.availability_note.clone());
    out.push(metrics.stored_level.honesty_note.clone());
    out.push(metrics.trace_id.availability_note.clone());
    out.push(metrics.templates.proposal_note.clone());
    out.push(
        "Multiline/continuation quality is omitted in v1: ingest does not persist quantified \
multiline counters on the durable event store."
            .into(),
    );
    if metrics.timestamp_provenance_counts.is_empty() && event_count > 0 {
        out.push(
            "timestamp_provenance_counts absent from corpus meta; active-basis event aggregates still used."
                .into(),
        );
    }
    if sources_truncated {
        out.push(format!(
            "Source inventory truncated at {MAX_ASSESSMENT_SOURCES} sources (lexical order)."
        ));
    }
    out
}

fn score_dimensions(
    metrics: &LoggingQualityMetrics,
    event_count: u64,
) -> Vec<LoggingQualityDimensionScore> {
    if event_count == 0 {
        return Vec::new();
    }
    let wall_bps = share_bps(metrics.wall_event_count, event_count);
    let unresolved_bps = share_bps(metrics.unresolved_local_event_count, event_count);
    let time_score = {
        let base = (wall_bps / 100) as u8;
        let penalty = (unresolved_bps / 200).min(40) as u8;
        base.saturating_sub(penalty)
    };
    let selection_score = {
        let mut score: u8 = 100;
        // Failed / durable partial only — not ignored/unsupported.
        if metrics.selection.partial {
            score = score.saturating_sub(25);
        }
        if metrics.selection.failed > 0 {
            score =
                score.saturating_sub((metrics.selection.failed.saturating_mul(10)).min(40) as u8);
        }
        score
    };
    let template_score = {
        let mut score: u8 = 80;
        if metrics.templates.top_template_share_bps >= 5000 {
            score = score.saturating_sub(35);
        } else if metrics.templates.top_template_share_bps >= 2500 {
            score = score.saturating_sub(15);
        }
        if metrics.templates.concentration_hhi_bps >= 4000 {
            score = score.saturating_sub(20);
        }
        score
    };
    let level_score = (metrics.stored_level.known_level_share_bps / 100) as u8;
    let trace_score = (metrics.trace_id.trace_id_share_bps / 100) as u8;
    let format_score = {
        let structured = metrics
            .format_counts
            .iter()
            .filter(|(k, _)| matches!(k.as_str(), "json" | "logfmt" | "syslog" | "rfc5424" | "cri"))
            .map(|(_, v)| *v)
            .sum::<u64>();
        let total: u64 = metrics.format_counts.values().copied().sum();
        if total == 0 {
            50
        } else {
            (share_bps(structured, total) / 100) as u8
        }
    };

    vec![
        LoggingQualityDimensionScore {
            id: "timestamp_certainty".into(),
            label: "Timestamp certainty".into(),
            score: time_score,
            weight_bps: 2500,
            measured_fact: format!(
                "time_quality={:?}; wall_share_bps={wall_bps}; unresolved_share_bps={unresolved_bps}",
                metrics.time_quality
            ),
        },
        LoggingQualityDimensionScore {
            id: "selection_coverage".into(),
            label: "Selection coverage".into(),
            score: selection_score,
            weight_bps: 1500,
            measured_fact: format!(
                "selected={}; ignored={}; unsupported={}; excluded_policy={}; failed={}; partial={}",
                metrics.selection.selected_imported,
                metrics.selection.ignored,
                metrics.selection.unsupported,
                metrics.selection.excluded_policy,
                metrics.selection.failed,
                metrics.selection.partial
            ),
        },
        LoggingQualityDimensionScore {
            id: "parse_structure".into(),
            label: "Parse structure".into(),
            score: format_score,
            weight_bps: 1500,
            measured_fact: format!("format_counts={:?}", metrics.format_counts),
        },
        LoggingQualityDimensionScore {
            id: "stored_level_usefulness".into(),
            label: "Stored level usefulness".into(),
            score: level_score,
            weight_bps: 1500,
            measured_fact: format!(
                "known_level_share_bps={}; severity_provenance_available=false",
                metrics.stored_level.known_level_share_bps
            ),
        },
        LoggingQualityDimensionScore {
            id: "noise_concentration_review".into(),
            label: "Noise concentration (review-only)".into(),
            score: template_score,
            weight_bps: 1500,
            measured_fact: format!(
                "top_share_bps={}; hhi_bps={}; top_error_fatal={}",
                metrics.templates.top_template_share_bps,
                metrics.templates.concentration_hhi_bps,
                metrics.templates.top_template_error_or_fatal_count
            ),
        },
        LoggingQualityDimensionScore {
            id: "trace_id_coverage".into(),
            label: "Parser trace_id coverage".into(),
            score: trace_score,
            weight_bps: 1500,
            measured_fact: format!(
                "trace_id_share_bps={}",
                metrics.trace_id.trace_id_share_bps
            ),
        },
    ]
}

fn weighted_score(dimensions: &[LoggingQualityDimensionScore]) -> u8 {
    if dimensions.is_empty() {
        return 0;
    }
    let mut weighted: u32 = 0;
    let mut weight_sum: u32 = 0;
    for d in dimensions {
        weighted += u32::from(d.score) * u32::from(d.weight_bps);
        weight_sum += u32::from(d.weight_bps);
    }
    weighted.checked_div(weight_sum).unwrap_or(0).min(100) as u8
}

fn build_headline(
    grade: LoggingQualityGrade,
    findings: &[LoggingQualityFinding],
    event_count: u64,
) -> String {
    if event_count == 0 {
        return "Insufficient evidence: corpus has no imported events.".into();
    }
    let top = findings
        .iter()
        .filter(|f| {
            matches!(
                f.severity,
                LoggingQualityFindingSeverity::Critical
                    | LoggingQualityFindingSeverity::High
                    | LoggingQualityFindingSeverity::Medium
            )
        })
        .map(|f| f.title.as_str())
        .take(2)
        .collect::<Vec<_>>();
    if top.is_empty() {
        format!(
            "Logging quality grade {} with no high-priority structural gaps detected.",
            grade.as_str()
        )
    } else {
        format!(
            "Logging quality grade {}; priority gaps: {}.",
            grade.as_str(),
            top.join("; ")
        )
    }
}

fn hint(template_id: &str, change: &str, criteria: &[&str]) -> LoggingQualityImprovementHint {
    LoggingQualityImprovementHint {
        template_id: template_id.into(),
        change: change.into(),
        acceptance_criteria: criteria.iter().map(|s| (*s).to_string()).collect(),
    }
}

fn locator(
    kind: LoggingQualityEvidenceKind,
    key: &str,
    value: Option<u64>,
    label: &str,
) -> LoggingQualityEvidenceLocator {
    LoggingQualityEvidenceLocator {
        kind,
        key: key.into(),
        value,
        label: label.into(),
    }
}

fn derive_findings(
    metrics: &LoggingQualityMetrics,
    sources: &[LoggingQualitySourceMetrics],
    event_count: u64,
) -> Vec<LoggingQualityFinding> {
    let mut findings = Vec::new();

    if event_count == 0 {
        findings.push(LoggingQualityFinding {
            id: "lq.corpus.empty".into(),
            severity: LoggingQualityFindingSeverity::Critical,
            priority: 100,
            category: LoggingQualityFindingCategory::Corpus,
            title: "Empty corpus".into(),
            measured_fact: "event_count=0".into(),
            finding: "No events were imported; quality scoring stops at emptiness.".into(),
            improvement_hint: hint(
                "hint.lq.corpus.empty",
                "Re-import a non-empty log corpus with at least one event-importable source selected.",
                &[
                    "Re-run assessment: corpus.event_count > 0.",
                    "selection.selected_imported >= 1.",
                ],
            ),
            evidence: vec![locator(
                LoggingQualityEvidenceKind::CorpusMetric,
                "corpus.event_count",
                Some(0),
                "Imported event count",
            )],
            confidence: LoggingQualityFindingConfidence::High,
            limitations: vec!["No further metric families are meaningful on an empty corpus.".into()],
        });
        return findings;
    }

    let order_bps = share_bps(metrics.order_only_event_count, event_count);
    let unresolved_bps = share_bps(metrics.unresolved_local_event_count, event_count);

    if matches!(metrics.time_quality, TimeQuality::OrderOnly) || order_bps >= 8000 {
        findings.push(LoggingQualityFinding {
            id: "lq.timestamp.order_only_dominant".into(),
            severity: LoggingQualityFindingSeverity::Critical,
            priority: 95,
            category: LoggingQualityFindingCategory::TimestampCertainty,
            title: "Order-only timestamps dominate".into(),
            measured_fact: format!(
                "time_quality={:?}; order_only_share_bps={order_bps}; wall_events={}",
                metrics.time_quality, metrics.wall_event_count
            ),
            finding: "Most events lack durable wall-clock active basis. This reports timestamp \
certainty from provenance/basis counters only — it does not synthesize calendar instants."
                .into(),
            improvement_hint: hint(
                "hint.lq.timestamp.order_only_dominant",
                "Emit RFC3339 timestamps with explicit offsets (or Z) at each producer.",
                &[
                    "Re-import sample: wall_event_count / events >= 0.95.",
                    "order_only_event_count / events <= 0.05.",
                ],
            ),
            evidence: vec![
                locator(
                    LoggingQualityEvidenceKind::CorpusMetric,
                    "metrics.order_only_event_count",
                    Some(metrics.order_only_event_count),
                    "Order-only event count",
                ),
                locator(
                    LoggingQualityEvidenceKind::CorpusMetric,
                    "metrics.wall_event_count",
                    Some(metrics.wall_event_count),
                    "Wall-clock event count",
                ),
            ],
            confidence: LoggingQualityFindingConfidence::High,
            limitations: vec![
                "Does not infer wall-clock time from numeric ts magnitude alone.".into(),
            ],
        });
    } else if matches!(metrics.time_quality, TimeQuality::Mixed) || order_bps >= 2000 {
        findings.push(LoggingQualityFinding {
            id: "lq.timestamp.mixed_certainty".into(),
            severity: LoggingQualityFindingSeverity::High,
            priority: 85,
            category: LoggingQualityFindingCategory::TimestampCertainty,
            title: "Mixed timestamp certainty".into(),
            measured_fact: format!(
                "time_quality={:?}; order_only_share_bps={order_bps}",
                metrics.time_quality
            ),
            finding: "A material share of events is order-only while others have wall-clock \
active basis. Treat timelines as mixed; improve weak producers."
                .into(),
            improvement_hint: hint(
                "hint.lq.timestamp.mixed_certainty",
                "Harmonize producers so each major source emits offset-aware timestamps.",
                &[
                    "Each major source_key wall share >= 0.90.",
                    "Corpus time_quality becomes wall.",
                ],
            ),
            evidence: vec![
                locator(
                    LoggingQualityEvidenceKind::CorpusMetric,
                    "metrics.wall_event_count",
                    Some(metrics.wall_event_count),
                    "Wall-clock events",
                ),
                locator(
                    LoggingQualityEvidenceKind::CorpusMetric,
                    "metrics.order_only_event_count",
                    Some(metrics.order_only_event_count),
                    "Order-only events",
                ),
            ],
            confidence: LoggingQualityFindingConfidence::High,
            limitations: vec![
                "Does not synthesize a single shared calendar timeline across mixed sources."
                    .into(),
            ],
        });
    }

    if unresolved_bps >= 500 {
        findings.push(LoggingQualityFinding {
            id: "lq.timestamp.unresolved_local_share".into(),
            severity: if unresolved_bps >= 2500 {
                LoggingQualityFindingSeverity::High
            } else {
                LoggingQualityFindingSeverity::Medium
            },
            priority: 80,
            category: LoggingQualityFindingCategory::TimestampCertainty,
            title: "Unresolved local timestamp share".into(),
            measured_fact: format!(
                "unresolved_local_event_count={}; share_bps={unresolved_bps}",
                metrics.unresolved_local_event_count
            ),
            finding: "Parser-recognized local calendar timestamps lack timezone evidence and \
remain non-wall until producers include offsets or operators declare IANA zones.".into(),
            improvement_hint: hint(
                "hint.lq.timestamp.unresolved_local_share",
                "Prefer offset-aware timestamps at the source; document one IANA zone per source only when locals are unavoidable.",
                &["unresolved_local_event_count / events <= 0.05 on a fresh import."],
            ),
            evidence: vec![locator(
                LoggingQualityEvidenceKind::CorpusMetric,
                "metrics.unresolved_local_event_count",
                Some(metrics.unresolved_local_event_count),
                "Unresolved local events",
            )],
            confidence: LoggingQualityFindingConfidence::High,
            limitations: vec![
                "Does not convert unresolved locals into UTC without explicit policy.".into(),
            ],
        });
    }

    // Selection: failed / durable partial only as failure findings.
    if metrics.selection.failed > 0 {
        findings.push(LoggingQualityFinding {
            id: "lq.selection.failed_sources".into(),
            severity: LoggingQualityFindingSeverity::High,
            priority: 78,
            category: LoggingQualityFindingCategory::SelectionCoverage,
            title: "Failed source reads".into(),
            measured_fact: format!(
                "failed={}; partial={}",
                metrics.selection.failed, metrics.selection.partial
            ),
            finding: "One or more sources failed open/read during ingest. This is distinct from \
ignored or unsupported selection."
                .into(),
            improvement_hint: hint(
                "hint.lq.selection.failed_sources",
                "Fix unreadable members (permissions, truncation, corrupt archives) and re-import.",
                &["selection.failed == 0 on a representative re-import."],
            ),
            evidence: vec![locator(
                LoggingQualityEvidenceKind::SelectionBucket,
                "selection.failed",
                Some(metrics.selection.failed),
                "Failed files",
            )],
            confidence: LoggingQualityFindingConfidence::High,
            limitations: vec![metrics.selection.availability_note.clone()],
        });
    }
    if metrics.selection.partial {
        findings.push(LoggingQualityFinding {
            id: "lq.selection.partial_import".into(),
            severity: LoggingQualityFindingSeverity::High,
            priority: 76,
            category: LoggingQualityFindingCategory::SelectionCoverage,
            title: "Durable partial import flag".into(),
            measured_fact: format!(
                "partial=true; failed={}; selected={}",
                metrics.selection.failed, metrics.selection.selected_imported
            ),
            finding: "Ingest marked this corpus partial. Ignored/unsupported counts are reported \
separately and are not used to set this flag.".into(),
            improvement_hint: hint(
                "hint.lq.selection.partial_import",
                "Resolve failed/truncated inputs so a complete import publishes with partial=false.",
                &["selection.partial == false after re-import."],
            ),
            evidence: vec![locator(
                LoggingQualityEvidenceKind::SelectionBucket,
                "selection.partial",
                Some(1),
                "Durable partial flag",
            )],
            confidence: LoggingQualityFindingConfidence::High,
            limitations: vec![
                "Ignored and unsupported buckets remain distinct from partial.".into(),
            ],
        });
    }
    if metrics.selection.ignored > 0 || metrics.selection.unsupported > 0 {
        findings.push(LoggingQualityFinding {
            id: "lq.selection.coverage_buckets".into(),
            severity: LoggingQualityFindingSeverity::Info,
            priority: 40,
            category: LoggingQualityFindingCategory::SelectionCoverage,
            title: "Ignored/unsupported selection present".into(),
            measured_fact: format!(
                "ignored={}; unsupported={}; excluded_policy={}; reasons={:?}",
                metrics.selection.ignored,
                metrics.selection.unsupported,
                metrics.selection.excluded_policy,
                metrics.selection.exclusion_reason_counts
            ),
            finding: "Selection coverage includes ignored and/or unsupported buckets. These are \
not classified as partial import failures.".into(),
            improvement_hint: hint(
                "hint.lq.selection.coverage_buckets",
                "Keep intentional ignores documented; convert unsupported binaries/empties out of event bundles when they are not useful.",
                &[
                    "Operators can explain each ignored/unsupported reason without treating them as failed imports.",
                ],
            ),
            evidence: vec![
                locator(
                    LoggingQualityEvidenceKind::SelectionBucket,
                    "selection.ignored",
                    Some(metrics.selection.ignored),
                    "Ignored",
                ),
                locator(
                    LoggingQualityEvidenceKind::SelectionBucket,
                    "selection.unsupported",
                    Some(metrics.selection.unsupported),
                    "Unsupported",
                ),
            ],
            confidence: LoggingQualityFindingConfidence::High,
            limitations: vec![metrics.selection.availability_note.clone()],
        });
    }

    // Parse structure
    let plain = metrics.format_counts.get("plain").copied().unwrap_or(0);
    let format_total: u64 = metrics.format_counts.values().copied().sum();
    if format_total > 0 && share_bps(plain, format_total) >= 6000 {
        findings.push(LoggingQualityFinding {
            id: "lq.parse.mostly_plain".into(),
            severity: LoggingQualityFindingSeverity::Medium,
            priority: 55,
            category: LoggingQualityFindingCategory::ParseStructure,
            title: "Mostly plain parse outcomes".into(),
            measured_fact: format!("format_counts={:?}", metrics.format_counts),
            finding: "A majority of durable format_counts are plain. This does not claim \
universal parse success or failure for every byte.".into(),
            improvement_hint: hint(
                "hint.lq.parse.mostly_plain",
                "Prefer JSON or logfmt for application logs; reserve plain text for documented legacy journals.",
                &["Structured formats (json+logfmt+syslog) share_bps >= 8000 on new services."],
            ),
            evidence: vec![locator(
                LoggingQualityEvidenceKind::CorpusMetric,
                "metrics.format_counts.plain",
                Some(plain),
                "Plain format count",
            )],
            confidence: LoggingQualityFindingConfidence::Medium,
            limitations: vec![
                "format_counts reflect ingest parse outcomes, not an SDK or OTel compliance inventory.".into(),
            ],
        });
    }

    // Always emit stored-level honesty when there are events (mandatory residual).
    findings.push(LoggingQualityFinding {
        id: "lq.severity.stored_level_not_provenance".into(),
        severity: if metrics.stored_level.known_level_share_bps < 7000 {
            LoggingQualityFindingSeverity::High
        } else {
            LoggingQualityFindingSeverity::Info
        },
        priority: if metrics.stored_level.known_level_share_bps < 7000 {
            72
        } else {
            35
        },
        category: LoggingQualityFindingCategory::StoredLevelHonesty,
        title: "Stored level is not severity provenance".into(),
        measured_fact: format!(
            "known_level_share_bps={}; unknown_level_count={}; severity_provenance_available=false; level_counts={:?}",
            metrics.stored_level.known_level_share_bps,
            metrics.stored_level.unknown_level_count,
            metrics.stored_level.level_counts
        ),
        finding: "Imported events expose normalized stored levels only. This assessment does not \
derive source_declared or schema_mapped severity provenance from those levels.".into(),
        improvement_hint: hint(
            "hint.lq.severity.stored_level_not_provenance",
            "Emit an explicit severity/level field on every record using a consistent key, and use normalize-path tooling when OTel provenance is required.",
            &[
                "known_level_share_bps >= 9500 on a fresh import sample.",
                "Do not treat stored level alone as OTel severity provenance.",
            ],
        ),
        evidence: vec![locator(
            LoggingQualityEvidenceKind::CorpusMetric,
            "metrics.stored_level.known_level_share_bps",
            Some(metrics.stored_level.known_level_share_bps),
            "Known stored-level share (bps)",
        )],
        confidence: LoggingQualityFindingConfidence::High,
        limitations: vec![metrics.stored_level.honesty_note.clone()],
    });

    // Review-only noise concentration
    if metrics.templates.top_template_share_bps >= 2500 && metrics.templates.event_count >= 20 {
        let top_id = metrics
            .templates
            .top_templates
            .first()
            .map(|t| t.template_id);
        let risk = metrics.templates.top_template_error_or_fatal_count > 0;
        findings.push(LoggingQualityFinding {
            id: "lq.noise.review_only_concentration".into(),
            severity: if metrics.templates.top_template_share_bps >= 5000 {
                LoggingQualityFindingSeverity::High
            } else {
                LoggingQualityFindingSeverity::Medium
            },
            priority: 70,
            category: LoggingQualityFindingCategory::NoiseConcentrationReview,
            title: "High template concentration (review-only proposal)".into(),
            measured_fact: format!(
                "top_template_share_bps={}; concentration_hhi_bps={}; top_error_or_fatal={}; risk_disclosed={risk}",
                metrics.templates.top_template_share_bps,
                metrics.templates.concentration_hhi_bps,
                metrics.templates.top_template_error_or_fatal_count
            ),
            finding: "A small number of templates account for a large event share. This is a \
review-only proposal signal — never verified noise. ERROR/FATAL volume on hot templates is \
disclosed as risk.".into(),
            improvement_hint: hint(
                "hint.lq.noise.review_only_concentration",
                "Human-review hot templates (product noise-candidate flow). Rate-limit info/debug heartbeats only after review; never auto-confirm noise.",
                &[
                    "top_template_share_bps <= 2000 after intentional producer changes.",
                    "ERROR/FATAL paths remain fully logged (not sampled away).",
                ],
            ),
            evidence: {
                let mut ev = vec![
                    locator(
                        LoggingQualityEvidenceKind::CorpusMetric,
                        "metrics.templates.top_template_share_bps",
                        Some(metrics.templates.top_template_share_bps),
                        "Top template share (bps)",
                    ),
                    locator(
                        LoggingQualityEvidenceKind::CorpusMetric,
                        "metrics.templates.top_template_error_or_fatal_count",
                        Some(metrics.templates.top_template_error_or_fatal_count),
                        "Top template ERROR/FATAL count",
                    ),
                ];
                if let Some(tid) = top_id {
                    ev.push(locator(
                        LoggingQualityEvidenceKind::Template,
                        &format!("template_id:{tid}"),
                        metrics.templates.top_templates.first().map(|t| t.event_count),
                        "Top template by count",
                    ));
                }
                ev
            },
            confidence: LoggingQualityFindingConfidence::High,
            limitations: vec![metrics.templates.proposal_note.clone()],
        });
    }

    // Trace coverage — only parser-true trace_id
    if metrics.trace_id.trace_id_share_bps < 2000 && event_count >= 10 {
        findings.push(LoggingQualityFinding {
            id: "lq.trace.low_parser_trace_id_coverage".into(),
            severity: LoggingQualityFindingSeverity::Medium,
            priority: 60,
            category: LoggingQualityFindingCategory::TraceIdCoverage,
            title: "Low parser-true trace_id coverage".into(),
            measured_fact: format!(
                "trace_id_share_bps={}; with_trace_id={}",
                metrics.trace_id.trace_id_share_bps, metrics.trace_id.with_trace_id
            ),
            finding: "Few events carry a non-empty parser-populated trace_id. This is not a \
claim about request/span ids or tracing-system readiness.".into(),
            improvement_hint: hint(
                "hint.lq.trace.low_parser_trace_id_coverage",
                "Propagate a W3C trace id into a field the parser maps to trace_id on request-path services.",
                &["trace_id_share_bps >= 8000 on request-path services after re-import."],
            ),
            evidence: vec![locator(
                LoggingQualityEvidenceKind::CorpusMetric,
                "metrics.trace_id.trace_id_share_bps",
                Some(metrics.trace_id.trace_id_share_bps),
                "Parser trace_id fill rate (bps)",
            )],
            confidence: LoggingQualityFindingConfidence::Medium,
            limitations: vec![metrics.trace_id.availability_note.clone()],
        });
    }

    // Source-specific timestamp gap (opaque key only)
    if let Some(weak) = sources
        .iter()
        .filter(|s| s.event_count >= 2)
        .filter(|s| share_bps(s.wall_event_count, s.event_count) < 5000)
        .max_by_key(|s| s.event_count)
    {
        findings.push(LoggingQualityFinding {
            id: "lq.timestamp.source_weak_certainty".into(),
            severity: LoggingQualityFindingSeverity::Medium,
            priority: 65,
            category: LoggingQualityFindingCategory::TimestampCertainty,
            title: "Source-specific timestamp certainty gap".into(),
            measured_fact: format!(
                "{}: events={} wall={} order_only={}",
                weak.source_key,
                weak.event_count,
                weak.wall_event_count,
                weak.order_only_event_count
            ),
            finding: format!(
                "Opaque source `{}` has weak wall-clock coverage among its events.",
                weak.source_key
            ),
            improvement_hint: hint(
                "hint.lq.timestamp.source_weak_certainty",
                "Upgrade the weak-timestamp producer identified by source-level metrics to emit offset-aware timestamps.",
                &["Every source_key with >= 2% of events has wall share >= 90%."],
            ),
            evidence: vec![locator(
                LoggingQualityEvidenceKind::SourceAggregate,
                &weak.source_key,
                Some(weak.event_count),
                "Weak timestamp source (opaque key)",
            )],
            confidence: LoggingQualityFindingConfidence::High,
            limitations: vec![
                "Source paths are omitted from the public report; map opaque keys via in-product source catalog when needed.".into(),
            ],
        });
    }

    findings
}

#[cfg(test)]
#[path = "logging_quality_tests.rs"]
mod tests;
