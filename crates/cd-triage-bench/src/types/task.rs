//! Evaluation tasks: fixed question/protocol over exactly one snapshot.

use super::common::{
    require_schema, sha256_hex, validate_bounded_string, validate_id, validate_rfc3339,
    PrivacyClass, MAX_STRING_BYTES, TASK_SCHEMA_V1,
};
use crate::canonical::to_canonical_json;
use crate::error::{BenchError, BenchResult};
use serde::{Deserialize, Serialize};

/// What a strategy may see. Resolution is excluded by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VisibilityPolicy {
    pub visible_item_ids: Vec<String>,
    #[serde(default)]
    pub include_summaries: bool,
    #[serde(default = "default_true")]
    pub include_raw_bytes: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeConstraint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_after: Option<String>,
}

impl TimeConstraint {
    pub fn validate(&self) -> BenchResult<()> {
        if let Some(t) = &self.not_before {
            validate_rfc3339("time_constraint.not_before", t)?;
        }
        if let Some(t) = &self.not_after {
            validate_rfc3339("time_constraint.not_after", t)?;
        }
        Ok(())
    }
}

/// A question posed over exactly one evidence snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationTask {
    pub schema_id: String,
    pub task_id: String,
    #[serde(default)]
    pub privacy: PrivacyClass,
    pub case_id: String,
    pub snapshot_id: String,
    pub question: String,
    pub protocol: String,
    pub protocol_version: String,
    pub visibility: VisibilityPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_constraint: Option<TimeConstraint>,
    pub created_at: String,
}

#[derive(Serialize)]
struct TaskDigestBody<'a> {
    schema_id: &'a str,
    privacy: PrivacyClass,
    case_id: &'a str,
    snapshot_id: &'a str,
    question: &'a str,
    protocol: &'a str,
    protocol_version: &'a str,
    visibility: &'a VisibilityPolicy,
    time_constraint: &'a Option<TimeConstraint>,
}

impl EvaluationTask {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        privacy: PrivacyClass,
        case_id: String,
        snapshot_id: String,
        question: String,
        protocol: String,
        protocol_version: String,
        visibility: VisibilityPolicy,
        time_constraint: Option<TimeConstraint>,
        created_at: String,
    ) -> BenchResult<Self> {
        let mut visibility = visibility;
        visibility.visible_item_ids.sort();
        visibility.visible_item_ids.dedup();
        let task_id = compute_task_id(
            TASK_SCHEMA_V1,
            privacy,
            &case_id,
            &snapshot_id,
            &question,
            &protocol,
            &protocol_version,
            &visibility,
            &time_constraint,
        )?;
        let task = Self {
            schema_id: TASK_SCHEMA_V1.into(),
            task_id,
            privacy,
            case_id,
            snapshot_id,
            question,
            protocol,
            protocol_version,
            visibility,
            time_constraint,
            created_at,
        };
        task.validate()?;
        Ok(task)
    }

    pub fn validate(&self) -> BenchResult<()> {
        require_schema(&self.schema_id, TASK_SCHEMA_V1)?;
        validate_id("task_id", &self.task_id)?;
        validate_id("case_id", &self.case_id)?;
        validate_id("snapshot_id", &self.snapshot_id)?;
        validate_bounded_string("question", &self.question, MAX_STRING_BYTES)?;
        validate_bounded_string("protocol", &self.protocol, MAX_STRING_BYTES)?;
        validate_bounded_string("protocol_version", &self.protocol_version, 128)?;
        validate_rfc3339("created_at", &self.created_at)?;
        if self.question.trim().is_empty() {
            return Err(BenchError::Schema("question must not be empty".into()));
        }
        if self.visibility.visible_item_ids.is_empty() {
            return Err(BenchError::Schema(
                "visibility.visible_item_ids must not be empty".into(),
            ));
        }
        let mut last: Option<&str> = None;
        for id in &self.visibility.visible_item_ids {
            validate_id("visible_item_id", id)?;
            if let Some(prev) = last {
                if id.as_str() < prev {
                    return Err(BenchError::Schema("visible_item_ids must be sorted".into()));
                }
                if id.as_str() == prev {
                    return Err(BenchError::Schema("duplicate visible_item_id".into()));
                }
            }
            last = Some(id);
        }
        if let Some(constraint) = &self.time_constraint {
            constraint.validate()?;
        }
        let expected = compute_task_id(
            &self.schema_id,
            self.privacy,
            &self.case_id,
            &self.snapshot_id,
            &self.question,
            &self.protocol,
            &self.protocol_version,
            &self.visibility,
            &self.time_constraint,
        )?;
        if self.task_id != expected {
            return Err(BenchError::Integrity(format!(
                "task_id does not match content digest (expected {expected})"
            )));
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
fn compute_task_id(
    schema_id: &str,
    privacy: PrivacyClass,
    case_id: &str,
    snapshot_id: &str,
    question: &str,
    protocol: &str,
    protocol_version: &str,
    visibility: &VisibilityPolicy,
    time_constraint: &Option<TimeConstraint>,
) -> BenchResult<String> {
    let body = TaskDigestBody {
        schema_id,
        privacy,
        case_id,
        snapshot_id,
        question,
        protocol,
        protocol_version,
        visibility,
        time_constraint,
    };
    let canonical = to_canonical_json(&body)?;
    Ok(format!("task-{}", sha256_hex(canonical.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_id_changes_when_snapshot_changes() {
        let vis = VisibilityPolicy {
            visible_item_ids: vec!["ev-log-1".into()],
            include_summaries: true,
            include_raw_bytes: true,
        };
        let a = EvaluationTask::from_parts(
            PrivacyClass::OwnerOnly,
            "case-1".into(),
            "snap-aaa".into(),
            "What failed?".into(),
            "answer from visible evidence only".into(),
            "v1".into(),
            vis.clone(),
            None,
            "2026-01-15T07:00:00Z".into(),
        )
        .unwrap();
        let b = EvaluationTask::from_parts(
            PrivacyClass::OwnerOnly,
            "case-1".into(),
            "snap-bbb".into(),
            "What failed?".into(),
            "answer from visible evidence only".into(),
            "v1".into(),
            vis,
            None,
            "2026-01-15T07:00:00Z".into(),
        )
        .unwrap();
        assert_ne!(a.task_id, b.task_id);
        assert_ne!(a.snapshot_id, b.snapshot_id);
    }
}
