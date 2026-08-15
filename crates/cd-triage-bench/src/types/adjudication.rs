//! Expert adjudication and derived score/review records.

use super::common::{
    require_schema, sha256_hex, validate_bounded_string, validate_id, validate_rfc3339,
    PrivacyClass, ADJUDICATION_SCHEMA_V1, MAX_RATIONALE_BYTES, RUBRIC_V1, SCORE_SCHEMA_V1,
};
use crate::canonical::to_canonical_json;
use crate::error::{BenchError, BenchResult};
use serde::{Deserialize, Serialize};

/// Rubric v1 dimensions. Composite indices are out of scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RubricDimension {
    DiagnosisCorrectness,
    EvidenceSupport,
    Actionability,
    UncertaintyCalibration,
    UnsafeUnsupportedClaims,
}

impl RubricDimension {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DiagnosisCorrectness => "diagnosis_correctness",
            Self::EvidenceSupport => "evidence_support",
            Self::Actionability => "actionability",
            Self::UncertaintyCalibration => "uncertainty_calibration",
            Self::UnsafeUnsupportedClaims => "unsafe_unsupported_claims",
        }
    }

    pub fn all() -> [Self; 5] {
        [
            Self::DiagnosisCorrectness,
            Self::EvidenceSupport,
            Self::Actionability,
            Self::UncertaintyCalibration,
            Self::UnsafeUnsupportedClaims,
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DimensionVerdict {
    Score { value: u8 },
    NotApplicable,
    Unscorable { reason: String },
}

impl DimensionVerdict {
    pub fn validate(&self, dimension: RubricDimension) -> BenchResult<()> {
        match self {
            Self::Score { value } => {
                if *value > 3 {
                    return Err(BenchError::Schema(format!(
                        "{} score must be 0..=3",
                        dimension.as_str()
                    )));
                }
                Ok(())
            }
            Self::NotApplicable => Ok(()),
            Self::Unscorable { reason } => {
                validate_bounded_string("unscorable.reason", reason, 1024)
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BlindingState {
    Blinded,
    Unblinded { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConflictOfInterest {
    pub declared: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DimensionOutcome {
    pub dimension: RubricDimension,
    pub verdict: DimensionVerdict,
    pub rationale: String,
    /// Deterministic assist flags (never scores).
    #[serde(default)]
    pub assist_flags: Vec<String>,
}

/// Expert judgment of a run. Disagreement is preserved as separate records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Adjudication {
    pub schema_id: String,
    pub adjudication_id: String,
    #[serde(default)]
    pub privacy: PrivacyClass,
    pub case_id: String,
    pub task_id: String,
    pub snapshot_id: String,
    pub run_id: String,
    pub reviewer: String,
    pub conflict_of_interest: ConflictOfInterest,
    pub rubric_version: String,
    pub blinding: BlindingState,
    pub outcomes: Vec<DimensionOutcome>,
    pub created_at: String,
}

#[derive(Serialize)]
struct AdjudicationDigestBody<'a> {
    case_id: &'a str,
    task_id: &'a str,
    snapshot_id: &'a str,
    run_id: &'a str,
    reviewer: &'a str,
    rubric_version: &'a str,
    blinding: &'a BlindingState,
    outcomes: &'a [DimensionOutcome],
    created_at: &'a str,
}

impl Adjudication {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        privacy: PrivacyClass,
        case_id: String,
        task_id: String,
        snapshot_id: String,
        run_id: String,
        reviewer: String,
        conflict_of_interest: ConflictOfInterest,
        rubric_version: String,
        blinding: BlindingState,
        mut outcomes: Vec<DimensionOutcome>,
        created_at: String,
    ) -> BenchResult<Self> {
        outcomes.sort_by_key(|o| o.dimension);
        let adjudication_id = compute_adjudication_id(
            &case_id,
            &task_id,
            &snapshot_id,
            &run_id,
            &reviewer,
            &rubric_version,
            &blinding,
            &outcomes,
            &created_at,
        )?;
        let adj = Self {
            schema_id: ADJUDICATION_SCHEMA_V1.into(),
            adjudication_id,
            privacy,
            case_id,
            task_id,
            snapshot_id,
            run_id,
            reviewer,
            conflict_of_interest,
            rubric_version,
            blinding,
            outcomes,
            created_at,
        };
        adj.validate()?;
        Ok(adj)
    }

    pub fn validate(&self) -> BenchResult<()> {
        require_schema(&self.schema_id, ADJUDICATION_SCHEMA_V1)?;
        validate_id("adjudication_id", &self.adjudication_id)?;
        validate_id("case_id", &self.case_id)?;
        validate_id("task_id", &self.task_id)?;
        validate_id("snapshot_id", &self.snapshot_id)?;
        validate_id("run_id", &self.run_id)?;
        validate_bounded_string("reviewer", &self.reviewer, 512)?;
        validate_bounded_string("rubric_version", &self.rubric_version, 128)?;
        if self.rubric_version != RUBRIC_V1
            && !self
                .rubric_version
                .starts_with("contextdesk.triage_bench.rubric.")
        {
            return Err(BenchError::Schema(
                "rubric_version must be a contextdesk.triage_bench.rubric.* id".into(),
            ));
        }
        validate_rfc3339("created_at", &self.created_at)?;
        if let Some(notes) = &self.conflict_of_interest.notes {
            validate_bounded_string("conflict_of_interest.notes", notes, 1024)?;
        }
        if let BlindingState::Unblinded { reason } = &self.blinding {
            validate_bounded_string("blinding.reason", reason, 1024)?;
        }
        if self.outcomes.len() != 5 {
            return Err(BenchError::Schema(
                "adjudication must include all five rubric dimensions".into(),
            ));
        }
        let mut seen = std::collections::BTreeSet::new();
        for outcome in &self.outcomes {
            if !seen.insert(outcome.dimension) {
                return Err(BenchError::Schema("duplicate rubric dimension".into()));
            }
            outcome.verdict.validate(outcome.dimension)?;
            validate_bounded_string("rationale", &outcome.rationale, MAX_RATIONALE_BYTES)?;
            for flag in &outcome.assist_flags {
                validate_bounded_string("assist_flag", flag, 128)?;
            }
        }
        for required in RubricDimension::all() {
            if !seen.contains(&required) {
                return Err(BenchError::Schema(format!(
                    "missing rubric dimension {}",
                    required.as_str()
                )));
            }
        }
        let expected = compute_adjudication_id(
            &self.case_id,
            &self.task_id,
            &self.snapshot_id,
            &self.run_id,
            &self.reviewer,
            &self.rubric_version,
            &self.blinding,
            &self.outcomes,
            &self.created_at,
        )?;
        if self.adjudication_id != expected {
            return Err(BenchError::Integrity(format!(
                "adjudication_id does not match content digest (expected {expected})"
            )));
        }
        Ok(())
    }

    pub fn outcome(&self, dimension: RubricDimension) -> Option<&DimensionOutcome> {
        self.outcomes.iter().find(|o| o.dimension == dimension)
    }

    pub fn to_score_review(&self) -> BenchResult<ScoreReview> {
        ScoreReview::from_adjudication(self)
    }
}

#[allow(clippy::too_many_arguments)]
fn compute_adjudication_id(
    case_id: &str,
    task_id: &str,
    snapshot_id: &str,
    run_id: &str,
    reviewer: &str,
    rubric_version: &str,
    blinding: &BlindingState,
    outcomes: &[DimensionOutcome],
    created_at: &str,
) -> BenchResult<String> {
    let body = AdjudicationDigestBody {
        case_id,
        task_id,
        snapshot_id,
        run_id,
        reviewer,
        rubric_version,
        blinding,
        outcomes,
        created_at,
    };
    Ok(format!(
        "adj-{}",
        sha256_hex(to_canonical_json(&body)?.as_bytes())
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DimensionScore {
    pub dimension: RubricDimension,
    pub verdict: DimensionVerdict,
}

/// Per-dimension score bound to rubric version + run + task + snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScoreReview {
    pub schema_id: String,
    pub score_id: String,
    #[serde(default)]
    pub privacy: PrivacyClass,
    pub rubric_version: String,
    pub case_id: String,
    pub task_id: String,
    pub snapshot_id: String,
    pub run_id: String,
    pub adjudication_id: String,
    pub dimensions: Vec<DimensionScore>,
    pub created_at: String,
}

impl ScoreReview {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn from_adjudication(adj: &Adjudication) -> BenchResult<Self> {
        let dimensions: Vec<DimensionScore> = adj
            .outcomes
            .iter()
            .map(|o| DimensionScore {
                dimension: o.dimension,
                verdict: o.verdict.clone(),
            })
            .collect();
        let score_id = format!(
            "score-{}",
            sha256_hex(
                to_canonical_json(&serde_json::json!({
                    "adjudication_id": adj.adjudication_id,
                    "rubric_version": adj.rubric_version,
                    "run_id": adj.run_id,
                    "task_id": adj.task_id,
                    "snapshot_id": adj.snapshot_id,
                    "dimensions": dimensions,
                }))?
                .as_bytes()
            )
        );
        let score = Self {
            schema_id: SCORE_SCHEMA_V1.into(),
            score_id,
            privacy: adj.privacy,
            rubric_version: adj.rubric_version.clone(),
            case_id: adj.case_id.clone(),
            task_id: adj.task_id.clone(),
            snapshot_id: adj.snapshot_id.clone(),
            run_id: adj.run_id.clone(),
            adjudication_id: adj.adjudication_id.clone(),
            dimensions,
            created_at: adj.created_at.clone(),
        };
        score.validate()?;
        Ok(score)
    }

    pub fn validate(&self) -> BenchResult<()> {
        require_schema(&self.schema_id, SCORE_SCHEMA_V1)?;
        validate_id("score_id", &self.score_id)?;
        validate_id("case_id", &self.case_id)?;
        validate_id("task_id", &self.task_id)?;
        validate_id("snapshot_id", &self.snapshot_id)?;
        validate_id("run_id", &self.run_id)?;
        validate_id("adjudication_id", &self.adjudication_id)?;
        validate_bounded_string("rubric_version", &self.rubric_version, 128)?;
        validate_rfc3339("created_at", &self.created_at)?;
        if self.dimensions.len() != 5 {
            return Err(BenchError::Schema(
                "score review must include all five dimensions".into(),
            ));
        }
        Ok(())
    }
}

/// Deterministic citation-existence assist. Never produces a score.
pub fn citation_assist_flags(
    snapshot_item_ids: &std::collections::BTreeSet<String>,
    claims: &[super::ClaimedCitation],
) -> Vec<String> {
    let mut flags = Vec::new();
    for claim in claims {
        if let Some(id) = &claim.evidence_item_id {
            if !snapshot_item_ids.contains(id) {
                flags.push(format!("citation_not_in_snapshot:{id}"));
            }
        }
    }
    flags.sort();
    flags.dedup();
    flags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn score_above_three_is_rejected() {
        let err = DimensionVerdict::Score { value: 4 }
            .validate(RubricDimension::Actionability)
            .unwrap_err();
        assert!(err.to_string().contains("0..=3"));
    }
}
