//! Case identity, reported problem, lifecycle, and evaluation-only resolution.

use super::common::{
    require_schema, validate_bounded_string, validate_id, validate_rfc3339, PrivacyClass,
    CASE_SCHEMA_V1, MAX_STRING_BYTES, MAX_TIMELINE_NOTES,
};
use crate::error::{BenchError, BenchResult};
use serde::{Deserialize, Serialize};

/// Lifecycle of a historical incident case in the bench.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaseLifecycle {
    Open,
    Resolved,
    Unresolved,
    Unscorable,
}

impl CaseLifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Resolved => "resolved",
            Self::Unresolved => "unresolved",
            Self::Unscorable => "unscorable",
        }
    }
}

/// One incident. Resolution is evaluation-only and never enters a task packet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub schema_id: String,
    pub case_id: String,
    #[serde(default)]
    pub privacy: PrivacyClass,
    pub title: String,
    pub reported_problem: ReportedProblem,
    pub lifecycle: CaseLifecycle,
    #[serde(default)]
    pub timeline_notes: Vec<TimelineNote>,
    pub created_at: String,
    /// Evaluation-only. Task materialization cannot include this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<CaseResolution>,
}

/// Symptom and reporter metadata visible when creating a case. Not a resolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportedProblem {
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reporter: Option<String>,
    #[serde(default)]
    pub symptoms: Vec<String>,
}

/// Expert resolution stored apart from strategy-visible evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CaseResolution {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adjudicated_root_cause: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_expertise: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

impl CaseResolution {
    pub fn has_root_cause(&self) -> bool {
        self.adjudicated_root_cause
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimelineNote {
    pub at: String,
    pub author: String,
    pub text: String,
}

impl Case {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> BenchResult<()> {
        require_schema(&self.schema_id, CASE_SCHEMA_V1)?;
        validate_id("case_id", &self.case_id)?;
        validate_bounded_string("title", &self.title, MAX_STRING_BYTES)?;
        validate_rfc3339("created_at", &self.created_at)?;
        validate_bounded_string(
            "reported_problem.summary",
            &self.reported_problem.summary,
            MAX_STRING_BYTES,
        )?;
        if let Some(at) = &self.reported_problem.reported_at {
            validate_rfc3339("reported_problem.reported_at", at)?;
        }
        if let Some(reporter) = &self.reported_problem.reporter {
            validate_bounded_string("reported_problem.reporter", reporter, 512)?;
        }
        if self.timeline_notes.len() > MAX_TIMELINE_NOTES {
            return Err(BenchError::Schema("too many timeline_notes".into()));
        }
        for (i, note) in self.timeline_notes.iter().enumerate() {
            validate_rfc3339(&format!("timeline_notes[{i}].at"), &note.at)?;
            validate_bounded_string(&format!("timeline_notes[{i}].author"), &note.author, 512)?;
            validate_bounded_string(
                &format!("timeline_notes[{i}].text"),
                &note.text,
                MAX_STRING_BYTES,
            )?;
        }
        match self.lifecycle {
            CaseLifecycle::Unresolved | CaseLifecycle::Unscorable => {
                if self
                    .resolution
                    .as_ref()
                    .is_some_and(CaseResolution::has_root_cause)
                {
                    return Err(BenchError::Schema(
                        "unresolved/unscorable cases must not populate adjudicated_root_cause"
                            .into(),
                    ));
                }
            }
            CaseLifecycle::Resolved | CaseLifecycle::Open => {}
        }
        if let Some(resolution) = &self.resolution {
            for (field, value) in [
                (
                    "resolution.adjudicated_root_cause",
                    resolution.adjudicated_root_cause.as_deref(),
                ),
                ("resolution.fix", resolution.fix.as_deref()),
                (
                    "resolution.domain_expertise",
                    resolution.domain_expertise.as_deref(),
                ),
                ("resolution.notes", resolution.notes.as_deref()),
            ] {
                if let Some(text) = value {
                    validate_bounded_string(field, text, MAX_STRING_BYTES)?;
                }
            }
        }
        Ok(())
    }

    /// Whether diagnosis correctness may be scored against this case.
    pub fn diagnosis_is_applicable(&self) -> bool {
        matches!(self.lifecycle, CaseLifecycle::Resolved)
            && self
                .resolution
                .as_ref()
                .is_some_and(CaseResolution::has_root_cause)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unresolved_json() -> String {
        r#"{
            "schema_id": "contextdesk.triage_bench.case.v1",
            "case_id": "case-open-question",
            "privacy": "owner_only",
            "title": "Intermittent 500s",
            "reported_problem": {"summary": "Checkout 500s; cause unknown"},
            "lifecycle": "unresolved",
            "timeline_notes": [],
            "created_at": "2026-01-15T00:00:00Z"
        }"#
        .into()
    }

    #[test]
    fn unresolved_case_round_trips_without_root_cause() {
        let case = Case::parse_json(&unresolved_json()).unwrap();
        assert_eq!(case.lifecycle, CaseLifecycle::Unresolved);
        assert!(case.resolution.is_none());
        let text = serde_json::to_string(&case).unwrap();
        assert!(!text.contains("adjudicated_root_cause"));
        let again = Case::parse_json(&text).unwrap();
        assert_eq!(case, again);
    }

    #[test]
    fn unresolved_with_root_cause_is_rejected() {
        let mut case = Case::parse_json(&unresolved_json()).unwrap();
        case.resolution = Some(CaseResolution {
            adjudicated_root_cause: Some("invented cause".into()),
            fix: None,
            domain_expertise: None,
            notes: None,
        });
        assert!(case.validate().is_err());
    }

    #[test]
    fn unknown_case_fields_are_rejected() {
        let err = Case::parse_json(
            r#"{
                "schema_id": "contextdesk.triage_bench.case.v1",
                "case_id": "case-x",
                "title": "t",
                "reported_problem": {"summary": "s"},
                "lifecycle": "open",
                "created_at": "2026-01-15T00:00:00Z",
                "secret_note": "nope"
            }"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown field"));
    }
}
