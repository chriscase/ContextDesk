//! Hermetic projection from share-safe adapter runs into Experiment Lab
//! `cd-collab.strategy_package.v1` documents.
//!
//! This mirrors the collab contracts converter. It never invents gold, cost,
//! usage, prompts, or provider calls. DeepSeek lane labels are refused.

use cd_triage_bench::sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AdapterError, AdapterResult};
use crate::share_safe::ShareSafeAdapterRun;

/// Schema id for the hermetic multi-lane import wrapper.
pub const BENCH_RUN_ARTIFACT_SCHEMA_V1: &str = "cd-collab.bench_run_artifact.v1";
/// Experiment Lab strategy package schema.
pub const STRATEGY_PACKAGE_SCHEMA_V1: &str = "cd-collab.strategy_package.v1";
/// Interaction trace schema shared with collab.
pub const INTERACTION_TRACE_SCHEMA_V1: &str = "cd-collab.interaction_trace.v1";
const EXPERIMENT_PACKAGE_SCHEMA_V1: &str = "cd-collab.experiment_package.v1";
const TRACE_UNKNOWN_STAYS_UNKNOWN: &str = "Ambiguous transcript structure stays unknown.";
const AGREEMENT_NOT_CORRECTNESS: &str = "Agreement is not proof of correctness.";
const NO_GOLD: &str = "Hermetic bench-artifact import never invents a gold reference.";
const NO_PROVIDER: &str = "Hermetic bench-artifact import performs no provider calls.";
const UNKNOWN_COST_USAGE: &str = "Cost and usage stay unknown unless the share-safe projection already proved them; this converter never invents either.";
const MAX_EXCERPT: usize = 240;

/// One labeled share-safe lane for Experiment Lab import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StrategyLaneSpec {
    /// Stable candidate identity in the Lab package.
    pub candidate_id: String,
    /// Synthetic or operator-supplied model label. DeepSeek is rejected.
    pub model_label: String,
    /// Experiment candidate role. Defaults to `single` when omitted in helpers.
    #[serde(default = "default_role")]
    pub role: String,
    /// Share-safe adapter projection for this lane.
    pub share_safe: ShareSafeAdapterRun,
}

fn default_role() -> String {
    "single".into()
}

/// Options for projecting several share-safe lanes into one strategy package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StrategyPackageOptions {
    /// Package identity.
    pub package_id: String,
    /// RFC3339 created-at for traces.
    pub created_at: String,
    /// Optional operator notes preserved on the agreement.
    #[serde(default)]
    pub notes: Vec<String>,
}

fn bound_excerpt(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= MAX_EXCERPT {
        Some(trimmed.to_string())
    } else {
        Some(trimmed.chars().take(MAX_EXCERPT).collect())
    }
}

fn reject_deepseek(label: &str) -> AdapterResult<()> {
    if label.to_ascii_lowercase().contains("deepseek") {
        return Err(AdapterError::Schema(
            "DeepSeek model labels are rejected for this import path".into(),
        ));
    }
    Ok(())
}

fn map_run_status(status: &str) -> &'static str {
    match status {
        "completed" => "completed",
        "failed" => "failed",
        "partial" => "partial",
        "timed_out" | "timeout" => "timeout",
        _ => "partial",
    }
}

fn accepted_evidence(run: &ShareSafeAdapterRun) -> Vec<String> {
    let mut ids = run
        .sdk_result
        .as_ref()
        .map(|result| result.accepted_evidence_ids.clone())
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    ids
}

fn project_trace(lane: &StrategyLaneSpec, created_at: &str) -> AdapterResult<Value> {
    reject_deepseek(&lane.model_label)?;
    if lane.share_safe.usage != "unknown" || lane.share_safe.cost != "unknown" {
        return Err(AdapterError::Schema(
            "converter refuses share-safe rows that invent observed cost or usage".into(),
        ));
    }
    if lane.share_safe.answer_included || lane.share_safe.raw_output_included {
        return Err(AdapterError::Schema(
            "share-safe answer or raw output content is refused".into(),
        ));
    }

    let evidence = accepted_evidence(&lane.share_safe);
    let question_id = format!("evt-{}-question", lane.candidate_id);
    let mut events = vec![json!({
        "eventId": question_id,
        "sequence": 1,
        "kind": "question",
        "actor": "human",
        "role": null,
        "parentEventId": null,
        "evidenceRefs": [],
        "observedAt": { "status": "unknown" },
        "excerpt": null,
        "excerptHash": null,
        "unknowns": ["text", "timestamp"]
    })];

    let mut parent = question_id;
    let mut sequence = 2u64;
    for (index, evidence_ref) in evidence.iter().enumerate() {
        let event_id = format!("evt-{}-evidence-{}", lane.candidate_id, index + 1);
        let excerpt = bound_excerpt(&format!("Accepted evidence {evidence_ref}"));
        let excerpt_hash = excerpt.as_ref().map(|text| sha256_hex(text.as_bytes()));
        events.push(json!({
            "eventId": event_id.clone(),
            "sequence": sequence,
            "kind": "evidence_anchor",
            "actor": "assistant",
            "role": "evidence",
            "parentEventId": parent,
            "evidenceRefs": [evidence_ref],
            "observedAt": { "status": "unknown" },
            "excerpt": excerpt,
            "excerptHash": excerpt_hash,
            "unknowns": ["timestamp"]
        }));
        parent = event_id;
        sequence += 1;
    }

    if lane.share_safe.root_cause_established {
        let excerpt = bound_excerpt("Share-safe projection reported root_cause_established=true.");
        let excerpt_hash = excerpt.as_ref().map(|text| sha256_hex(text.as_bytes()));
        let event_id = format!("evt-{}-hypothesis", lane.candidate_id);
        events.push(json!({
            "eventId": event_id.clone(),
            "sequence": sequence,
            "kind": "hypothesis",
            "actor": "assistant",
            "role": "cause",
            "parentEventId": parent,
            "evidenceRefs": evidence,
            "observedAt": { "status": "unknown" },
            "excerpt": excerpt,
            "excerptHash": excerpt_hash,
            "unknowns": ["timestamp", "raw answer"]
        }));
        parent = event_id;
        sequence += 1;
    }

    let reason = if lane.share_safe.reason_codes.is_empty() {
        format!("Terminal status: {}", lane.share_safe.status)
    } else {
        format!("Reason codes: {}", lane.share_safe.reason_codes.join(", "))
    };
    let excerpt = bound_excerpt(&reason);
    let excerpt_hash = excerpt
        .as_ref()
        .map(|text| sha256_hex(text.as_bytes()))
        .unwrap_or_else(|| sha256_hex(lane.share_safe.status.as_bytes()));
    events.push(json!({
        "eventId": format!("evt-{}-status", lane.candidate_id),
        "sequence": sequence,
        "kind": "recommendation",
        "actor": "assistant",
        "role": null,
        "parentEventId": parent,
        "evidenceRefs": evidence,
        "observedAt": { "status": "unknown" },
        "excerpt": excerpt,
        "excerptHash": excerpt_hash,
        "unknowns": ["timestamp", "raw answer"]
    }));

    let evidence_steps = evidence.len() as u64;
    Ok(json!({
        "schemaId": INTERACTION_TRACE_SCHEMA_V1,
        "traceId": format!(
            "trace-{}-{}",
            lane.candidate_id,
            &sha256_hex(lane.share_safe.bench_run_id.as_bytes())[..12]
        ),
        "candidateId": lane.candidate_id,
        "sourceKind": "programmatic",
        "completeness": "partial",
        "privacyClass": "share_safe",
        "rawHash": sha256_hex(lane.share_safe.sdk_run_id.as_bytes()),
        "events": events,
        "efficiency": {
            "turnCount": { "status": "unknown" },
            "evidenceAcquisitionSteps": if evidence_steps > 0 {
                json!({ "status": "observed", "count": evidence_steps })
            } else {
                json!({ "status": "unknown" })
            },
            "latency": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "providerCalls": {
                "status": "observed",
                "count": lane.share_safe.completed_role_slots
            }
        },
        "unknowns": ["question", "raw answer", "tools", "usage", "cost", "timestamp"],
        "notes": [
            TRACE_UNKNOWN_STAYS_UNKNOWN,
            NO_PROVIDER,
            UNKNOWN_COST_USAGE,
            "Projected from a share-safe bench run; task text and raw answers remain host-owned."
        ],
        "createdAt": created_at
    }))
}

fn lab_fingerprint(value: &str, prefix: &str) -> AdapterResult<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let digest = normalized
        .strip_prefix("task-")
        .or_else(|| normalized.strip_prefix("snap-"))
        .or_else(|| normalized.strip_prefix("tkf-"))
        .or_else(|| normalized.strip_prefix("snf-"))
        .unwrap_or(normalized.as_str());
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AdapterError::Schema(format!(
            "{prefix} fingerprint must contain a SHA-256 digest"
        )));
    }
    Ok(format!("{prefix}-{digest}"))
}

/// Project labeled share-safe lanes into a collab strategy package JSON value.
pub fn project_strategy_package(
    lanes: &[StrategyLaneSpec],
    options: &StrategyPackageOptions,
) -> AdapterResult<Value> {
    if lanes.is_empty() {
        return Err(AdapterError::Schema("at least one lane is required".into()));
    }
    let task_fp = lab_fingerprint(&lanes[0].share_safe.task_fingerprint, "task")?;
    let snap_fp = lab_fingerprint(&lanes[0].share_safe.snapshot_fingerprint, "snap")?;
    let mut candidate_ids = std::collections::BTreeSet::new();
    let mut candidates = Vec::new();
    let mut traces = Vec::new();
    let mut evidence_owners: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();

    for lane in lanes {
        reject_deepseek(&lane.model_label)?;
        if !candidate_ids.insert(lane.candidate_id.clone()) {
            return Err(AdapterError::Schema(format!(
                "duplicate candidateId {}",
                lane.candidate_id
            )));
        }
        if lab_fingerprint(&lane.share_safe.task_fingerprint, "task")? != task_fp
            || lab_fingerprint(&lane.share_safe.snapshot_fingerprint, "snap")? != snap_fp
        {
            return Err(AdapterError::Schema(
                "all lanes must share one task and snapshot fingerprint".into(),
            ));
        }
        for evidence in accepted_evidence(&lane.share_safe) {
            evidence_owners
                .entry(evidence)
                .or_default()
                .push(lane.candidate_id.clone());
        }
        candidates.push(json!({
            "candidateId": lane.candidate_id,
            "modelLabel": lane.model_label,
            "role": lane.role,
            "runStatus": map_run_status(&lane.share_safe.status),
            "observedLatency": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "usage": { "status": "unknown" },
            "helpfulnessState": "unreviewed",
            "goldState": "unknown"
        }));
        traces.push(project_trace(lane, &options.created_at)?);
    }

    let mut shared_anchors = Vec::new();
    let mut candidate_specific = candidates
        .iter()
        .map(|candidate| {
            json!({
                "candidateId": candidate["candidateId"],
                "evidenceRefs": []
            })
        })
        .collect::<Vec<_>>();

    for (evidence_ref, owners) in &evidence_owners {
        let mut sorted = owners.clone();
        sorted.sort();
        sorted.dedup();
        if sorted.len() > 1 {
            shared_anchors.push(json!({
                "evidenceRef": evidence_ref,
                "role": "evidence",
                "candidateIds": sorted
            }));
        } else if let Some(only) = sorted.first() {
            if let Some(row) = candidate_specific
                .iter_mut()
                .find(|row| row["candidateId"] == *only)
            {
                row["evidenceRefs"]
                    .as_array_mut()
                    .expect("evidenceRefs array")
                    .push(json!(evidence_ref));
            }
        }
    }

    let mut notes = vec![
        AGREEMENT_NOT_CORRECTNESS.to_string(),
        NO_GOLD.to_string(),
        NO_PROVIDER.to_string(),
        UNKNOWN_COST_USAGE.to_string(),
    ];
    notes.extend(options.notes.iter().cloned());

    Ok(json!({
        "schemaId": STRATEGY_PACKAGE_SCHEMA_V1,
        "privacyClass": "share_safe",
        "experiment": {
            "schemaId": EXPERIMENT_PACKAGE_SCHEMA_V1,
            "packageId": options.package_id,
            "privacyClass": "share_safe",
            "taskFingerprint": task_fp,
            "snapshotFingerprint": snap_fp,
            "candidates": candidates,
            "agreement": {
                "sharedAnchors": shared_anchors,
                "candidateSpecific": candidate_specific,
                "roleConflicts": [],
                "notes": notes
            }
        },
        "traces": traces
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_run() -> ShareSafeAdapterRun {
        serde_json::from_str(include_str!("../fixtures/share-safe.complete.json"))
            .expect("share-safe fixture")
    }

    #[test]
    fn projects_share_safe_lane_without_inventing_gold_or_cost() {
        let package = project_strategy_package(
            &[StrategyLaneSpec {
                candidate_id: "cand-qwen-3.6-27b".into(),
                model_label: "qwen-3.6-27b".into(),
                role: "single".into(),
                share_safe: fixture_run(),
            }],
            &StrategyPackageOptions {
                package_id: "pkg-rust-bench-export-v1".into(),
                created_at: "2026-08-21T00:00:00.000Z".into(),
                notes: vec!["Hermetic adapter projection".into()],
            },
        )
        .expect("package");
        assert_eq!(package["schemaId"], STRATEGY_PACKAGE_SCHEMA_V1);
        assert_eq!(
            package["experiment"]["candidates"][0]["goldState"],
            "unknown"
        );
        assert_eq!(
            package["experiment"]["candidates"][0]["cost"]["status"],
            "unknown"
        );
        assert_eq!(package["traces"][0]["completeness"], "partial");
        assert!(package["experiment"]["taskFingerprint"]
            .as_str()
            .unwrap()
            .starts_with("task-"));
        assert!(package["experiment"]["snapshotFingerprint"]
            .as_str()
            .unwrap()
            .starts_with("snap-"));
        assert!(package["experiment"]["agreement"]["notes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note == NO_GOLD));
        assert!(package["traces"][0]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "evidence_anchor"));
    }

    #[test]
    fn rejects_deepseek_labels() {
        let err = project_strategy_package(
            &[StrategyLaneSpec {
                candidate_id: "cand-deepseek".into(),
                model_label: "DeepSeek-V3".into(),
                role: "single".into(),
                share_safe: fixture_run(),
            }],
            &StrategyPackageOptions {
                package_id: "pkg-reject".into(),
                created_at: "2026-08-21T00:00:00.000Z".into(),
                notes: vec![],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("DeepSeek"));
    }
}
