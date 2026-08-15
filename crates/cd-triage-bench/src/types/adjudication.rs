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

/// Import document for an adjudication. `adjudication_id` may be omitted;
/// unknown fields are rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AdjudicationImport {
    schema_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    adjudication_id: Option<String>,
    #[serde(default)]
    privacy: PrivacyClass,
    case_id: String,
    task_id: String,
    snapshot_id: String,
    run_id: String,
    reviewer: String,
    conflict_of_interest: ConflictOfInterest,
    rubric_version: String,
    blinding: BlindingState,
    outcomes: Vec<DimensionOutcome>,
    created_at: String,
}

impl Adjudication {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    /// Parse a stored record or an import document that omits `adjudication_id`.
    pub fn parse_import_json(text: &str) -> BenchResult<Self> {
        let import: AdjudicationImport =
            serde_json::from_str(text).map_err(BenchError::from_serde)?;
        require_schema(&import.schema_id, ADJUDICATION_SCHEMA_V1)?;
        match import.adjudication_id {
            Some(adjudication_id) => {
                let adj = Self {
                    schema_id: import.schema_id,
                    adjudication_id,
                    privacy: import.privacy,
                    case_id: import.case_id,
                    task_id: import.task_id,
                    snapshot_id: import.snapshot_id,
                    run_id: import.run_id,
                    reviewer: import.reviewer,
                    conflict_of_interest: import.conflict_of_interest,
                    rubric_version: import.rubric_version,
                    blinding: import.blinding,
                    outcomes: import.outcomes,
                    created_at: import.created_at,
                };
                adj.validate()?;
                Ok(adj)
            }
            None => Self::from_parts(
                import.privacy,
                import.case_id,
                import.task_id,
                import.snapshot_id,
                import.run_id,
                import.reviewer,
                import.conflict_of_interest,
                import.rubric_version,
                import.blinding,
                import.outcomes,
                import.created_at,
            ),
        }
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

/// Body hashed for score identity. Matches the historical `from_adjudication`
/// digest keys so existing score ids remain stable.
#[derive(Serialize)]
struct ScoreDigestBody<'a> {
    adjudication_id: &'a str,
    rubric_version: &'a str,
    run_id: &'a str,
    task_id: &'a str,
    snapshot_id: &'a str,
    dimensions: &'a [DimensionScore],
}

/// Import document for a score/review. `score_id` may be omitted; unknown
/// fields are rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScoreImport {
    schema_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    score_id: Option<String>,
    #[serde(default)]
    privacy: PrivacyClass,
    rubric_version: String,
    case_id: String,
    task_id: String,
    snapshot_id: String,
    run_id: String,
    adjudication_id: String,
    dimensions: Vec<DimensionScore>,
    created_at: String,
}

impl ScoreReview {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    /// Parse a stored record or an import document that omits `score_id`.
    pub fn parse_import_json(text: &str) -> BenchResult<Self> {
        let import: ScoreImport = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        require_schema(&import.schema_id, SCORE_SCHEMA_V1)?;
        let score_id = match import.score_id {
            Some(id) => id,
            None => compute_score_id(
                &import.adjudication_id,
                &import.rubric_version,
                &import.run_id,
                &import.task_id,
                &import.snapshot_id,
                &import.dimensions,
            )?,
        };
        let score = Self {
            schema_id: import.schema_id,
            score_id,
            privacy: import.privacy,
            rubric_version: import.rubric_version,
            case_id: import.case_id,
            task_id: import.task_id,
            snapshot_id: import.snapshot_id,
            run_id: import.run_id,
            adjudication_id: import.adjudication_id,
            dimensions: import.dimensions,
            created_at: import.created_at,
        };
        score.validate()?;
        Ok(score)
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
        let score_id = compute_score_id(
            &adj.adjudication_id,
            &adj.rubric_version,
            &adj.run_id,
            &adj.task_id,
            &adj.snapshot_id,
            &dimensions,
        )?;
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
        let expected = compute_score_id(
            &self.adjudication_id,
            &self.rubric_version,
            &self.run_id,
            &self.task_id,
            &self.snapshot_id,
            &self.dimensions,
        )?;
        if self.score_id != expected {
            return Err(BenchError::Integrity(format!(
                "score_id does not match content digest (expected {expected})"
            )));
        }
        Ok(())
    }
}

fn compute_score_id(
    adjudication_id: &str,
    rubric_version: &str,
    run_id: &str,
    task_id: &str,
    snapshot_id: &str,
    dimensions: &[DimensionScore],
) -> BenchResult<String> {
    let body = ScoreDigestBody {
        adjudication_id,
        rubric_version,
        run_id,
        task_id,
        snapshot_id,
        dimensions,
    };
    Ok(format!(
        "score-{}",
        sha256_hex(to_canonical_json(&body)?.as_bytes())
    ))
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

    fn sample_dimensions() -> Vec<DimensionScore> {
        vec![
            DimensionScore {
                dimension: RubricDimension::DiagnosisCorrectness,
                verdict: DimensionVerdict::Score { value: 3 },
            },
            DimensionScore {
                dimension: RubricDimension::EvidenceSupport,
                verdict: DimensionVerdict::Score { value: 2 },
            },
            DimensionScore {
                dimension: RubricDimension::Actionability,
                verdict: DimensionVerdict::Score { value: 2 },
            },
            DimensionScore {
                dimension: RubricDimension::UncertaintyCalibration,
                verdict: DimensionVerdict::Score { value: 1 },
            },
            DimensionScore {
                dimension: RubricDimension::UnsafeUnsupportedClaims,
                verdict: DimensionVerdict::Score { value: 3 },
            },
        ]
    }

    #[test]
    fn score_id_mismatch_is_rejected() {
        let dimensions = sample_dimensions();
        let expected = compute_score_id(
            "adj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            RUBRIC_V1,
            "run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "task-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "snap-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            &dimensions,
        )
        .unwrap();
        let mut score = ScoreReview {
            schema_id: SCORE_SCHEMA_V1.into(),
            score_id: expected,
            privacy: PrivacyClass::ShareSafe,
            rubric_version: RUBRIC_V1.into(),
            case_id: "case-fixture-1".into(),
            task_id: "task-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            snapshot_id: "snap-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                .into(),
            run_id: "run-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            adjudication_id: "adj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .into(),
            dimensions,
            created_at: "2026-01-15T10:00:00Z".into(),
        };
        score.validate().unwrap();
        score.score_id =
            "score-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into();
        let err = score.validate().unwrap_err();
        assert!(err.to_string().contains("score_id does not match"));
    }

    #[test]
    fn import_without_adjudication_or_score_id_rejects_unknown_fields() {
        let adj_err = Adjudication::parse_import_json(
            r#"{
                "schema_id": "contextdesk.triage_bench.adjudication.v1",
                "case_id": "case-1",
                "task_id": "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "snapshot_id": "snap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "run_id": "run-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "reviewer": "reviewer-a",
                "conflict_of_interest": {"declared": false},
                "rubric_version": "contextdesk.triage_bench.rubric.v1",
                "blinding": {"kind": "blinded"},
                "outcomes": [],
                "created_at": "2026-01-15T10:00:00Z",
                "unexpected": true
            }"#,
        )
        .unwrap_err();
        assert!(adj_err.to_string().contains("unknown field"));
        let score_err = ScoreReview::parse_import_json(
            r#"{
                "schema_id": "contextdesk.triage_bench.score_review.v1",
                "rubric_version": "contextdesk.triage_bench.rubric.v1",
                "case_id": "case-1",
                "task_id": "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "snapshot_id": "snap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "run_id": "run-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                "adjudication_id": "adj-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                "dimensions": [],
                "created_at": "2026-01-15T10:00:00Z",
                "unexpected": true
            }"#,
        )
        .unwrap_err();
        assert!(score_err.to_string().contains("unknown field"));
    }
}
