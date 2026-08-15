//! Source-neutral triage runs, including imported human and external results.

use super::common::{
    require_schema, sha256_hex, validate_bounded_string, validate_id, validate_rfc3339,
    Completeness, ContentDigest, Observed, PrivacyClass, MAX_CLAIMS, MAX_RAW_INLINE_BYTES,
    MAX_STRING_BYTES, RUN_IMPORT_SCHEMA_V1, RUN_SCHEMA_V1,
};
use crate::canonical::to_canonical_json;
use crate::error::{BenchError, BenchResult};
use serde::{Deserialize, Serialize};

/// Where a strategy result came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    ContextdeskSdk,
    Human,
    WebOnly,
    OtherProduct,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ContextdeskSdk => "contextdesk_sdk",
            Self::Human => "human",
            Self::WebOnly => "web_only",
            Self::OtherProduct => "other_product",
        }
    }
}

/// Terminal status. Failed and partial runs are recorded, not discarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Completed,
    Failed,
    Partial,
    Cancelled,
    TimedOut,
    Unscorable,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Partial => "partial",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
            Self::Unscorable => "unscorable",
        }
    }
}

/// Declared evidence visibility for fairness grouping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FairnessClass {
    SameSnapshot,
    ExtraEvidence { description: String },
    UnknownVisibility,
}

impl FairnessClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SameSnapshot => "same_snapshot",
            Self::ExtraEvidence { .. } => "extra_evidence",
            Self::UnknownVisibility => "unknown_visibility",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StrategyIdentity {
    pub name: String,
    pub version: Observed<String>,
    pub build: Observed<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromptWorkflow {
    pub completeness: Completeness,
    pub prompt: Observed<String>,
    pub workflow: Observed<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawOutput {
    pub digest: ContentDigest,
    pub byte_length: u64,
    pub encoding: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Timing {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

impl Timing {
    pub fn validate(&self) -> BenchResult<()> {
        if let Some(t) = &self.started_at {
            validate_rfc3339("timing.started_at", t)?;
        }
        if let Some(t) = &self.ended_at {
            validate_rfc3339("timing.ended_at", t)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cost {
    pub currency: String,
    /// Decimal amount as a canonical string (no exponent). Zero is valid and
    /// distinct from [`Observed::Unknown`].
    pub amount: String,
}

impl Cost {
    pub fn validate(&self) -> BenchResult<()> {
        validate_bounded_string("cost.currency", &self.currency, 16)?;
        if self.currency.trim().is_empty() {
            return Err(BenchError::Schema("cost.currency is empty".into()));
        }
        if !is_canonical_decimal(&self.amount) {
            return Err(BenchError::Schema(
                "cost.amount must be a canonical decimal string".into(),
            ));
        }
        Ok(())
    }
}

fn is_canonical_decimal(amount: &str) -> bool {
    if amount.is_empty() || amount.len() > 32 {
        return false;
    }
    let mut parts = amount.split('.');
    let whole = parts.next().unwrap_or("");
    let frac = parts.next();
    if parts.next().is_some() {
        return false;
    }
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if whole.len() > 1 && whole.starts_with('0') {
        return false;
    }
    if let Some(frac) = frac {
        if frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimedCitation {
    pub claim: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locator: Option<String>,
}

/// One strategy attempt at one evaluation task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageRun {
    pub schema_id: String,
    pub run_id: String,
    #[serde(default)]
    pub privacy: PrivacyClass,
    pub case_id: String,
    pub task_id: String,
    pub snapshot_id: String,
    pub strategy: StrategyIdentity,
    pub source_kind: SourceKind,
    pub prompt_workflow: PromptWorkflow,
    pub raw_output: RawOutput,
    #[serde(default)]
    pub claims: Vec<ClaimedCitation>,
    pub timing: Observed<Timing>,
    pub cost: Observed<Cost>,
    pub uncertainty: Observed<String>,
    pub fairness: FairnessClass,
    pub status: RunStatus,
    pub operator: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importer: Option<String>,
    pub created_at: String,
    /// Near-duplicate pointer when the same raw bytes were imported with
    /// different metadata. Never a silent overwrite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub near_duplicate_of: Option<String>,
}

#[derive(Serialize)]
struct RunFingerprintBody<'a> {
    task_id: &'a str,
    snapshot_id: &'a str,
    source_kind: SourceKind,
    strategy_name: &'a str,
    strategy_version: &'a Observed<String>,
    raw_digest: &'a str,
    fairness: &'a FairnessClass,
}

impl TriageRun {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn fingerprint(&self) -> BenchResult<String> {
        run_fingerprint(
            &self.task_id,
            &self.snapshot_id,
            self.source_kind,
            &self.strategy.name,
            &self.strategy.version,
            &self.raw_output.digest.hex,
            &self.fairness,
        )
    }

    pub fn validate(&self) -> BenchResult<()> {
        require_schema(&self.schema_id, RUN_SCHEMA_V1)?;
        validate_id("run_id", &self.run_id)?;
        validate_id("case_id", &self.case_id)?;
        validate_id("task_id", &self.task_id)?;
        validate_id("snapshot_id", &self.snapshot_id)?;
        validate_strategy_identity(&self.strategy)?;
        validate_prompt_workflow(&self.prompt_workflow)?;
        if self.raw_output.digest.algorithm != "sha256" {
            return Err(BenchError::Schema(
                "raw_output digest algorithm must be sha256".into(),
            ));
        }
        crate::types::validate_sha256_hex(&self.raw_output.digest.hex)?;
        validate_bounded_string("raw_output.encoding", &self.raw_output.encoding, 32)?;
        validate_claims(&self.claims)?;
        validate_observed_timing_cost_uncertainty(&self.timing, &self.cost, &self.uncertainty)?;
        validate_fairness(&self.fairness)?;
        validate_attribution(&self.operator, self.importer.as_deref())?;
        validate_rfc3339("created_at", &self.created_at)?;
        if let Some(other) = &self.near_duplicate_of {
            validate_id("near_duplicate_of", other)?;
        }
        let expected = format!("run-{}", self.fingerprint()?);
        if self.run_id != expected {
            return Err(BenchError::Integrity(format!(
                "run_id does not match import fingerprint (expected {expected})"
            )));
        }
        Ok(())
    }
}

fn validate_observed_string(field: &str, value: &Observed<String>, max: usize) -> BenchResult<()> {
    if let Observed::Known(text) = value {
        validate_bounded_string(field, text, max)?;
    }
    Ok(())
}

pub fn run_fingerprint(
    task_id: &str,
    snapshot_id: &str,
    source_kind: SourceKind,
    strategy_name: &str,
    strategy_version: &Observed<String>,
    raw_digest_hex: &str,
    fairness: &FairnessClass,
) -> BenchResult<String> {
    let body = RunFingerprintBody {
        task_id,
        snapshot_id,
        source_kind,
        strategy_name,
        strategy_version,
        raw_digest: raw_digest_hex,
        fairness,
    };
    let canonical = to_canonical_json(&body)?;
    Ok(sha256_hex(canonical.as_bytes()))
}

/// Manual import document. Raw bytes may be inline or supplied separately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunImport {
    pub schema_id: String,
    pub task_id: String,
    pub strategy: StrategyIdentity,
    pub source_kind: SourceKind,
    pub prompt_workflow: PromptWorkflow,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_output_utf8: Option<String>,
    #[serde(default)]
    pub claims: Vec<ClaimedCitation>,
    pub timing: Observed<Timing>,
    pub cost: Observed<Cost>,
    pub uncertainty: Observed<String>,
    pub fairness: FairnessClass,
    pub status: RunStatus,
    pub operator: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub importer: Option<String>,
    #[serde(default)]
    pub privacy: PrivacyClass,
    pub created_at: String,
}

impl RunImport {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate_metadata()?;
        Ok(parsed)
    }

    pub fn validate_metadata(&self) -> BenchResult<()> {
        require_schema(&self.schema_id, RUN_IMPORT_SCHEMA_V1)?;
        validate_id("task_id", &self.task_id)?;
        validate_strategy_identity(&self.strategy)?;
        validate_prompt_workflow(&self.prompt_workflow)?;
        validate_claims(&self.claims)?;
        validate_observed_timing_cost_uncertainty(&self.timing, &self.cost, &self.uncertainty)?;
        validate_fairness(&self.fairness)?;
        validate_attribution(&self.operator, self.importer.as_deref())?;
        validate_rfc3339("created_at", &self.created_at)?;
        if let Some(raw) = &self.raw_output_utf8 {
            if raw.len() > MAX_RAW_INLINE_BYTES {
                return Err(BenchError::Schema("raw_output_utf8 exceeds 8 MiB".into()));
            }
        }
        Ok(())
    }
}

pub(crate) fn validate_strategy_identity(strategy: &StrategyIdentity) -> BenchResult<()> {
    validate_bounded_string("strategy.name", &strategy.name, 256)?;
    if strategy.name.trim().is_empty() {
        return Err(BenchError::Schema("strategy.name is empty".into()));
    }
    validate_observed_string("strategy.version", &strategy.version, 128)?;
    validate_observed_string("strategy.build", &strategy.build, 256)?;
    Ok(())
}

pub(crate) fn validate_prompt_workflow(prompt_workflow: &PromptWorkflow) -> BenchResult<()> {
    match prompt_workflow.completeness {
        Completeness::Unknown => {
            if !prompt_workflow.prompt.is_unknown() || !prompt_workflow.workflow.is_unknown() {
                return Err(BenchError::Schema(
                    "prompt_workflow completeness unknown requires unknown prompt and workflow"
                        .into(),
                ));
            }
        }
        Completeness::Exact | Completeness::Partial => {}
    }
    validate_observed_string("prompt", &prompt_workflow.prompt, MAX_STRING_BYTES)?;
    validate_observed_string("workflow", &prompt_workflow.workflow, MAX_STRING_BYTES)?;
    Ok(())
}

pub(crate) fn validate_fairness(fairness: &FairnessClass) -> BenchResult<()> {
    if let FairnessClass::ExtraEvidence { description } = fairness {
        validate_bounded_string("fairness.description", description, MAX_STRING_BYTES)?;
        if description.trim().is_empty() {
            return Err(BenchError::Schema(
                "extra_evidence fairness requires a description".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn validate_claims(claims: &[ClaimedCitation]) -> BenchResult<()> {
    if claims.len() > MAX_CLAIMS {
        return Err(BenchError::Schema("too many claims".into()));
    }
    for (i, claim) in claims.iter().enumerate() {
        validate_bounded_string(
            &format!("claims[{i}].claim"),
            &claim.claim,
            MAX_STRING_BYTES,
        )?;
        if let Some(id) = &claim.evidence_item_id {
            validate_id(&format!("claims[{i}].evidence_item_id"), id)?;
        }
        if let Some(locator) = &claim.locator {
            validate_bounded_string(&format!("claims[{i}].locator"), locator, 1024)?;
        }
    }
    Ok(())
}

pub(crate) fn validate_observed_timing_cost_uncertainty(
    timing: &Observed<Timing>,
    cost: &Observed<Cost>,
    uncertainty: &Observed<String>,
) -> BenchResult<()> {
    if let Observed::Known(timing) = timing {
        timing.validate()?;
    }
    if let Observed::Known(cost) = cost {
        cost.validate()?;
    }
    validate_observed_string("uncertainty", uncertainty, MAX_STRING_BYTES)
}

pub(crate) fn validate_attribution(operator: &str, importer: Option<&str>) -> BenchResult<()> {
    validate_bounded_string("operator", operator, 512)?;
    if operator.trim().is_empty() {
        return Err(BenchError::Schema("operator is empty".into()));
    }
    if let Some(importer) = importer {
        validate_bounded_string("importer", importer, 512)?;
        if importer.trim().is_empty() {
            return Err(BenchError::Schema("importer is empty".into()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_cost_is_not_zero() {
        let unknown = Observed::<Cost>::Unknown;
        let zero = Observed::Known(Cost {
            currency: "USD".into(),
            amount: "0".into(),
        });
        assert_ne!(
            serde_json::to_string(&unknown).unwrap(),
            serde_json::to_string(&zero).unwrap()
        );
        assert!(unknown.is_unknown());
    }

    #[test]
    fn zero_cost_is_canonical() {
        Cost {
            currency: "USD".into(),
            amount: "0".into(),
        }
        .validate()
        .unwrap();
        assert!(Cost {
            currency: "USD".into(),
            amount: "00".into(),
        }
        .validate()
        .is_err());
    }

    #[test]
    fn omitted_fairness_is_rejected() {
        let err = RunImport::parse_json(
            r#"{
                "schema_id": "contextdesk.triage_bench.run_import.v1",
                "task_id": "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "strategy": {"name": "human-expert", "version": {"status": "unknown"}, "build": {"status": "unknown"}},
                "source_kind": "human",
                "prompt_workflow": {"completeness": "unknown", "prompt": {"status": "unknown"}, "workflow": {"status": "unknown"}},
                "timing": {"status": "unknown"},
                "cost": {"status": "unknown"},
                "uncertainty": {"status": "unknown"},
                "status": "completed",
                "operator": "alice",
                "created_at": "2026-01-15T08:00:00Z"
            }"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("fairness"), "{err}");
    }

    #[test]
    fn extra_evidence_requires_a_description() {
        let err = RunImport::parse_json(
            r#"{
                "schema_id": "contextdesk.triage_bench.run_import.v1",
                "task_id": "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "strategy": {"name": "human-expert", "version": {"status": "unknown"}, "build": {"status": "unknown"}},
                "source_kind": "human",
                "prompt_workflow": {"completeness": "unknown", "prompt": {"status": "unknown"}, "workflow": {"status": "unknown"}},
                "timing": {"status": "unknown"},
                "cost": {"status": "unknown"},
                "uncertainty": {"status": "unknown"},
                "fairness": {"kind": "extra_evidence", "description": "   "},
                "status": "completed",
                "operator": "alice",
                "created_at": "2026-01-15T08:00:00Z"
            }"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("description"), "{err}");
    }

    #[test]
    fn missing_strategy_version_stays_a_required_unknown_object() {
        let err = RunImport::parse_json(
            r#"{
                "schema_id": "contextdesk.triage_bench.run_import.v1",
                "task_id": "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "strategy": {"name": "human-expert", "build": {"status": "unknown"}},
                "source_kind": "human",
                "prompt_workflow": {"completeness": "unknown", "prompt": {"status": "unknown"}, "workflow": {"status": "unknown"}},
                "timing": {"status": "unknown"},
                "cost": {"status": "unknown"},
                "uncertainty": {"status": "unknown"},
                "fairness": {"kind": "same_snapshot"},
                "status": "completed",
                "operator": "alice",
                "created_at": "2026-01-15T08:00:00Z"
            }"#,
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("missing field") && err.to_string().contains("version"),
            "{err}"
        );
    }

    #[test]
    fn run_import_rejects_unknown_fields() {
        let err = RunImport::parse_json(
            r#"{
                "schema_id": "contextdesk.triage_bench.run_import.v1",
                "task_id": "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "strategy": {"name": "human-expert", "version": {"status": "unknown"}, "build": {"status": "unknown"}},
                "source_kind": "human",
                "prompt_workflow": {"completeness": "unknown", "prompt": {"status": "unknown"}, "workflow": {"status": "unknown"}},
                "timing": {"status": "unknown"},
                "cost": {"status": "unknown"},
                "uncertainty": {"status": "unknown"},
                "fairness": {"kind": "same_snapshot"},
                "status": "completed",
                "operator": "alice",
                "created_at": "2026-01-15T08:00:00Z",
                "unexpected": true
            }"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown field"));
    }
}
