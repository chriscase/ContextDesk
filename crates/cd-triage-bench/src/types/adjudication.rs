//! Expert adjudication and derived score/review records.

use super::common::{
    require_schema, sha256_hex, validate_bounded_string, validate_id, validate_rfc3339,
    PrivacyClass, ADJUDICATION_SCHEMA_V1, ADJUDICATION_SCHEMA_V2, MAX_RATIONALE_BYTES, RUBRIC_V1,
    SCORE_SCHEMA_V1,
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

/// Phase of a two-phase review. Support packets exclude case resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPhase {
    /// Evidence-support review. Case resolution is excluded.
    Support,
    /// Diagnosis review after a support-phase record exists. Resolution may be revealed.
    Diagnosis,
}

impl ReviewPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Support => "support",
            Self::Diagnosis => "diagnosis",
        }
    }
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<ReviewPhase>,
    /// The generated packet from which this adjudication was made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_packet_id: Option<String>,
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
    phase: ReviewPhase,
    review_packet_id: &'a str,
    blinding: &'a BlindingState,
    outcomes: &'a [DimensionOutcome],
    created_at: &'a str,
}

#[derive(Serialize)]
struct CurrentV1AdjudicationDigestBody<'a> {
    case_id: &'a str,
    task_id: &'a str,
    snapshot_id: &'a str,
    run_id: &'a str,
    reviewer: &'a str,
    rubric_version: &'a str,
    phase: ReviewPhase,
    blinding: &'a BlindingState,
    outcomes: &'a [DimensionOutcome],
    created_at: &'a str,
}

#[derive(Serialize)]
struct LegacyAdjudicationDigestBody<'a> {
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
    #[serde(default)]
    phase: Option<ReviewPhase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    review_packet_id: Option<String>,
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
        if import.schema_id != ADJUDICATION_SCHEMA_V1
            && import.schema_id != ADJUDICATION_SCHEMA_V2
        {
            return Err(BenchError::Schema(format!(
                "adjudication schema must be {ADJUDICATION_SCHEMA_V1} or {ADJUDICATION_SCHEMA_V2}, got {}",
                import.schema_id
            )));
        }
        match import.adjudication_id {
            Some(adjudication_id) => {
                let adj = Self {
                    schema_id: if import.review_packet_id.is_some() {
                        ADJUDICATION_SCHEMA_V2.into()
                    } else {
                        import.schema_id
                    },
                    adjudication_id,
                    privacy: import.privacy,
                    case_id: import.case_id,
                    task_id: import.task_id,
                    snapshot_id: import.snapshot_id,
                    run_id: import.run_id,
                    reviewer: import.reviewer,
                    conflict_of_interest: import.conflict_of_interest,
                    rubric_version: import.rubric_version,
                    phase: import.phase,
                    review_packet_id: import.review_packet_id,
                    blinding: import.blinding,
                    outcomes: import.outcomes,
                    created_at: import.created_at,
                };
                adj.validate()?;
                Ok(adj)
            }
            None => {
                let phase = import.phase.ok_or_else(|| {
                    BenchError::Schema("new adjudication imports must declare phase".into())
                })?;
                if import.schema_id == ADJUDICATION_SCHEMA_V2
                    && import.review_packet_id.is_none()
                {
                    return Err(BenchError::Schema(
                        "adjudication.v2 requires review_packet_id".into(),
                    ));
                }
                Self::build(
                    if import.review_packet_id.is_some() {
                        ADJUDICATION_SCHEMA_V2
                    } else {
                        ADJUDICATION_SCHEMA_V1
                    },
                    import.privacy,
                    import.case_id,
                    import.task_id,
                    import.snapshot_id,
                    import.run_id,
                    import.reviewer,
                    import.conflict_of_interest,
                    import.rubric_version,
                    phase,
                    import.review_packet_id,
                    import.blinding,
                    import.outcomes,
                    import.created_at,
                )
            }
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
        phase: ReviewPhase,
        blinding: BlindingState,
        outcomes: Vec<DimensionOutcome>,
        created_at: String,
    ) -> BenchResult<Self> {
        Self::build(
            ADJUDICATION_SCHEMA_V1,
            privacy,
            case_id,
            task_id,
            snapshot_id,
            run_id,
            reviewer,
            conflict_of_interest,
            rubric_version,
            phase,
            None,
            blinding,
            outcomes,
            created_at,
        )
    }

    /// Construct a new adjudication bound to a generated review packet.
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts_with_packet(
        privacy: PrivacyClass,
        case_id: String,
        task_id: String,
        snapshot_id: String,
        run_id: String,
        reviewer: String,
        conflict_of_interest: ConflictOfInterest,
        rubric_version: String,
        phase: ReviewPhase,
        review_packet_id: String,
        blinding: BlindingState,
        outcomes: Vec<DimensionOutcome>,
        created_at: String,
    ) -> BenchResult<Self> {
        Self::build(
            ADJUDICATION_SCHEMA_V2,
            privacy,
            case_id,
            task_id,
            snapshot_id,
            run_id,
            reviewer,
            conflict_of_interest,
            rubric_version,
            phase,
            Some(review_packet_id),
            blinding,
            outcomes,
            created_at,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        schema_id: &str,
        privacy: PrivacyClass,
        case_id: String,
        task_id: String,
        snapshot_id: String,
        run_id: String,
        reviewer: String,
        conflict_of_interest: ConflictOfInterest,
        rubric_version: String,
        phase: ReviewPhase,
        review_packet_id: Option<String>,
        blinding: BlindingState,
        mut outcomes: Vec<DimensionOutcome>,
        created_at: String,
    ) -> BenchResult<Self> {
        outcomes.sort_by_key(|o| o.dimension);
        let adj = Self {
            schema_id: schema_id.into(),
            adjudication_id: String::new(),
            privacy,
            case_id,
            task_id,
            snapshot_id,
            run_id,
            reviewer,
            conflict_of_interest,
            rubric_version,
            phase: Some(phase),
            review_packet_id,
            blinding,
            outcomes,
            created_at,
        };
        let mut adj = adj;
        adj.adjudication_id = adj.compute_id()?;
        adj.validate()?;
        Ok(adj)
    }

    pub fn validate(&self) -> BenchResult<()> {
        if self.schema_id != ADJUDICATION_SCHEMA_V1 && self.schema_id != ADJUDICATION_SCHEMA_V2 {
            return Err(BenchError::Schema(format!(
                "adjudication schema must be {ADJUDICATION_SCHEMA_V1} or {ADJUDICATION_SCHEMA_V2}, got {}",
                self.schema_id
            )));
        }
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
        if self.schema_id == ADJUDICATION_SCHEMA_V2
            && (self.phase.is_none() || self.review_packet_id.is_none())
        {
            return Err(BenchError::Schema(
                "adjudication.v2 requires phase and review_packet_id".into(),
            ));
        }
        if self.phase == Some(ReviewPhase::Support) {
            match self.outcome(RubricDimension::DiagnosisCorrectness) {
                Some(outcome)
                    if matches!(
                        outcome.verdict,
                        DimensionVerdict::NotApplicable | DimensionVerdict::Unscorable { .. }
                    ) => {}
                _ => {
                    return Err(BenchError::Schema(
                        "support-phase adjudication cannot score diagnosis_correctness; resolution is not revealed".into(),
                    ));
                }
            }
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
        if let Some(packet_id) = &self.review_packet_id {
            validate_id("review_packet_id", packet_id)?;
        }
        let expected = self.compute_id()?;
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

    pub fn bind_review_packet(&self, review_packet_id: String) -> BenchResult<Self> {
        let phase = self.phase.ok_or_else(|| {
            BenchError::Schema("legacy adjudication cannot be bound to a review packet".into())
        })?;
        Self::from_parts_with_packet(
            self.privacy,
            self.case_id.clone(),
            self.task_id.clone(),
            self.snapshot_id.clone(),
            self.run_id.clone(),
            self.reviewer.clone(),
            self.conflict_of_interest.clone(),
            self.rubric_version.clone(),
            phase,
            review_packet_id,
            self.blinding.clone(),
            self.outcomes.clone(),
            self.created_at.clone(),
        )
    }

    pub fn with_outcomes(
        &self,
        mut outcomes: Vec<DimensionOutcome>,
    ) -> BenchResult<Self> {
        outcomes.sort_by_key(|o| o.dimension);
        let mut updated = self.clone();
        updated.outcomes = outcomes;
        updated.adjudication_id = updated.compute_id()?;
        updated.validate()?;
        Ok(updated)
    }

    fn compute_id(&self) -> BenchResult<String> {
        match (self.schema_id.as_str(), self.phase, &self.review_packet_id) {
            (ADJUDICATION_SCHEMA_V2, Some(phase), Some(packet_id)) => {
                compute_adjudication_id(
                    &self.case_id,
                    &self.task_id,
                    &self.snapshot_id,
                    &self.run_id,
                    &self.reviewer,
                    &self.rubric_version,
                    phase,
                    packet_id,
                    &self.blinding,
                    &self.outcomes,
                    &self.created_at,
                )
            }
            (ADJUDICATION_SCHEMA_V1, Some(phase), None) => {
                compute_current_v1_adjudication_id(
                    &self.case_id,
                    &self.task_id,
                    &self.snapshot_id,
                    &self.run_id,
                    &self.reviewer,
                    &self.rubric_version,
                    phase,
                    &self.blinding,
                    &self.outcomes,
                    &self.created_at,
                )
            }
            (ADJUDICATION_SCHEMA_V1, None, None) => compute_legacy_adjudication_id(
                &self.case_id,
                &self.task_id,
                &self.snapshot_id,
                &self.run_id,
                &self.reviewer,
                &self.rubric_version,
                &self.blinding,
                &self.outcomes,
                &self.created_at,
            ),
            _ => Err(BenchError::Schema(
                "adjudication schema and phase/packet fields are incompatible".into(),
            )),
        }
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
    phase: ReviewPhase,
    review_packet_id: &str,
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
        phase,
        review_packet_id,
        blinding,
        outcomes,
        created_at,
    };
    Ok(format!(
        "adj-{}",
        sha256_hex(to_canonical_json(&body)?.as_bytes())
    ))
}

fn compute_current_v1_adjudication_id(
    case_id: &str,
    task_id: &str,
    snapshot_id: &str,
    run_id: &str,
    reviewer: &str,
    rubric_version: &str,
    phase: ReviewPhase,
    blinding: &BlindingState,
    outcomes: &[DimensionOutcome],
    created_at: &str,
) -> BenchResult<String> {
    let body = CurrentV1AdjudicationDigestBody {
        case_id,
        task_id,
        snapshot_id,
        run_id,
        reviewer,
        rubric_version,
        phase,
        blinding,
        outcomes,
        created_at,
    };
    Ok(format!(
        "adj-{}",
        sha256_hex(to_canonical_json(&body)?.as_bytes())
    ))
}

fn compute_legacy_adjudication_id(
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
    let body = LegacyAdjudicationDigestBody {
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

    fn five_outcomes(diagnosis: DimensionVerdict) -> Vec<DimensionOutcome> {
        vec![
            DimensionOutcome {
                dimension: RubricDimension::DiagnosisCorrectness,
                verdict: diagnosis,
                rationale: "r".into(),
                assist_flags: vec![],
            },
            DimensionOutcome {
                dimension: RubricDimension::EvidenceSupport,
                verdict: DimensionVerdict::Score { value: 2 },
                rationale: "r".into(),
                assist_flags: vec![],
            },
            DimensionOutcome {
                dimension: RubricDimension::Actionability,
                verdict: DimensionVerdict::Score { value: 2 },
                rationale: "r".into(),
                assist_flags: vec![],
            },
            DimensionOutcome {
                dimension: RubricDimension::UncertaintyCalibration,
                verdict: DimensionVerdict::Score { value: 2 },
                rationale: "r".into(),
                assist_flags: vec![],
            },
            DimensionOutcome {
                dimension: RubricDimension::UnsafeUnsupportedClaims,
                verdict: DimensionVerdict::Score { value: 2 },
                rationale: "r".into(),
                assist_flags: vec![],
            },
        ]
    }

    #[test]
    fn support_phase_cannot_score_diagnosis_correctness() {
        let err = Adjudication::from_parts(
            PrivacyClass::ShareSafe,
            "case-1".into(),
            "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            "snap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            "run-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            "reviewer-a".into(),
            ConflictOfInterest {
                declared: false,
                notes: None,
            },
            RUBRIC_V1.into(),
            ReviewPhase::Support,
            BlindingState::Blinded,
            five_outcomes(DimensionVerdict::Score { value: 3 }),
            "2026-01-15T10:00:00Z".into(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("support-phase"));
        assert!(err.to_string().contains("diagnosis_correctness"));
        Adjudication::from_parts(
            PrivacyClass::ShareSafe,
            "case-1".into(),
            "task-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            "snap-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            "run-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
            "reviewer-a".into(),
            ConflictOfInterest {
                declared: false,
                notes: None,
            },
            RUBRIC_V1.into(),
            ReviewPhase::Support,
            BlindingState::Blinded,
            five_outcomes(DimensionVerdict::NotApplicable),
            "2026-01-15T10:00:00Z".into(),
        )
        .unwrap();
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
                "phase": "support",
                "blinding": {"kind": "blinded"},
                "outcomes": [],
                "created_at": "2026-01-15T10:00:00Z",
                "unexpected": true}
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
