//! Local file-backed library. Offline; no network or keychain.

use crate::canonical::to_pretty_json;
use crate::error::{BenchError, BenchResult};
use crate::packet::{materialize_task_packet, TaskPacket};
use crate::review::{
    materialize_review_packet, merge_citation_assists, run_has_support_adjudication, ReviewPacket,
    ReviewPhase,
};
use crate::types::citation_assist_flags;
use crate::types::{
    sha256_hex, Adjudication, Case, ContentDigest, EvaluationTask, EvidenceSnapshot, ScoreReview,
    TriageRun, LIBRARY_SCHEMA_V1,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Library metadata stored at `<root>/library.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryMeta {
    pub schema_id: String,
    pub created_at: String,
}

/// Durable offline store. Records are immutable after first write.
#[derive(Debug, Clone)]
pub struct BenchStore {
    root: PathBuf,
}

impl BenchStore {
    pub fn init(root: impl Into<PathBuf>, created_at: &str) -> BenchResult<Self> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|e| BenchError::io(&root, e))?;
        for dir in [
            "cases",
            "snapshots",
            "tasks",
            "runs",
            "adjudications",
            "scores",
            "packets",
            "review-packets",
            "blobs/sha256",
        ] {
            let path = root.join(dir);
            fs::create_dir_all(&path).map_err(|e| BenchError::io(&path, e))?;
        }
        let meta = LibraryMeta {
            schema_id: LIBRARY_SCHEMA_V1.into(),
            created_at: created_at.to_string(),
        };
        crate::types::validate_rfc3339("created_at", created_at)?;
        atomic_write_json(&root.join("library.json"), &meta)?;
        Ok(Self { root })
    }

    pub fn open(root: impl Into<PathBuf>) -> BenchResult<Self> {
        let root = root.into();
        let meta_path = root.join("library.json");
        let text = fs::read_to_string(&meta_path).map_err(|e| BenchError::io(&meta_path, e))?;
        let meta: LibraryMeta = serde_json::from_str(&text).map_err(BenchError::from_serde)?;
        if meta.schema_id != LIBRARY_SCHEMA_V1 {
            return Err(BenchError::Schema(format!(
                "unsupported library schema {}",
                meta.schema_id
            )));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn put_blob(&self, bytes: &[u8]) -> BenchResult<ContentDigest> {
        let digest = ContentDigest::of_bytes(bytes);
        let path = self.blob_path(&digest.hex);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| BenchError::io(parent, e))?;
        }
        if path.exists() {
            let existing = fs::read(&path).map_err(|e| BenchError::io(&path, e))?;
            if existing.as_slice() != bytes {
                return Err(BenchError::Integrity(format!(
                    "blob {} already exists with different bytes",
                    digest.hex
                )));
            }
            return Ok(digest);
        }
        atomic_write_bytes(&path, bytes)?;
        Ok(digest)
    }

    pub fn get_blob(&self, hex: &str) -> BenchResult<Vec<u8>> {
        crate::types::validate_sha256_hex(hex)?;
        let path = self.blob_path(hex);
        let bytes = fs::read(&path).map_err(|e| BenchError::io(&path, e))?;
        let actual = sha256_hex(&bytes);
        if actual != hex {
            return Err(BenchError::Integrity(format!(
                "blob {hex} failed digest verification (got {actual})"
            )));
        }
        Ok(bytes)
    }

    pub fn verify_snapshot_blobs(&self, snapshot: &EvidenceSnapshot) -> BenchResult<()> {
        for item in &snapshot.items {
            if let Some(content) = item.held_content() {
                let bytes = self.get_blob(&content.digest.hex)?;
                if bytes.len() as u64 != content.byte_length {
                    return Err(BenchError::Integrity(format!(
                        "blob {} length {} does not match manifest {}",
                        content.digest.hex,
                        bytes.len(),
                        content.byte_length
                    )));
                }
            }
        }
        Ok(())
    }

    pub fn put_case(&self, case: &Case) -> BenchResult<()> {
        case.validate()?;
        atomic_write_json(&self.entity_path("cases", &case.case_id), case)
    }

    pub fn get_case(&self, case_id: &str) -> BenchResult<Case> {
        Case::parse_json(&self.read_entity("cases", case_id)?)
    }

    pub fn list_cases(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("cases"))
    }

    pub fn load_cases(&self) -> BenchResult<Vec<Case>> {
        let mut cases = Vec::new();
        for id in self.list_cases()? {
            cases.push(self.get_case(&id)?);
        }
        Ok(cases)
    }

    pub fn put_snapshot(&self, snapshot: &EvidenceSnapshot) -> BenchResult<()> {
        snapshot.validate()?;
        self.verify_snapshot_blobs(snapshot)?;
        atomic_write_json(
            &self.entity_path("snapshots", &snapshot.snapshot_id),
            snapshot,
        )
    }

    pub fn get_snapshot(&self, snapshot_id: &str) -> BenchResult<EvidenceSnapshot> {
        let snapshot = EvidenceSnapshot::parse_json(&self.read_entity("snapshots", snapshot_id)?)?;
        self.verify_snapshot_blobs(&snapshot)?;
        Ok(snapshot)
    }

    pub fn list_snapshots(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("snapshots"))
    }

    pub fn put_task(&self, task: &EvaluationTask) -> BenchResult<()> {
        task.validate()?;
        let snapshot = self.get_snapshot(&task.snapshot_id)?;
        if snapshot.case_id != task.case_id {
            return Err(BenchError::CrossSnapshot(
                "task case_id does not match snapshot.case_id".into(),
            ));
        }
        for item_id in &task.visibility.visible_item_ids {
            if snapshot.item(item_id).is_none() {
                return Err(BenchError::Schema(format!(
                    "task visible item {item_id} is not in snapshot {}",
                    snapshot.snapshot_id
                )));
            }
        }
        let _ = self.get_case(&task.case_id)?;
        atomic_write_json(&self.entity_path("tasks", &task.task_id), task)
    }

    pub fn get_task(&self, task_id: &str) -> BenchResult<EvaluationTask> {
        EvaluationTask::parse_json(&self.read_entity("tasks", task_id)?)
    }

    pub fn list_tasks(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("tasks"))
    }

    pub fn materialize_packet(&self, task_id: &str) -> BenchResult<TaskPacket> {
        let task = self.get_task(task_id)?;
        let case = self.get_case(&task.case_id)?;
        let snapshot = self.get_snapshot(&task.snapshot_id)?;
        let packet = materialize_task_packet(&case, &snapshot, &task)?;
        atomic_write_json(&self.entity_path("packets", &packet.packet_id), &packet)?;
        Ok(packet)
    }

    pub fn put_run(&self, run: &TriageRun) -> BenchResult<PutRunOutcome> {
        run.validate()?;
        let task = self.get_task(&run.task_id)?;
        if run.snapshot_id != task.snapshot_id {
            return Err(BenchError::CrossSnapshot(format!(
                "run snapshot {} does not match task snapshot {}",
                run.snapshot_id, task.snapshot_id
            )));
        }
        if run.case_id != task.case_id {
            return Err(BenchError::Schema(
                "run.case_id does not match task.case_id".into(),
            ));
        }
        let _ = self.get_blob(&run.raw_output.digest.hex)?;
        let path = self.entity_path("runs", &run.run_id);
        if path.exists() {
            let existing = TriageRun::parse_json(&self.read_entity("runs", &run.run_id)?)?;
            // Same fingerprint/id: first write wins. Never overwrite.
            return Ok(PutRunOutcome::Duplicate {
                run_id: existing.run_id,
            });
        }
        atomic_write_json(&path, run)?;
        Ok(PutRunOutcome::Created {
            run_id: run.run_id.clone(),
        })
    }

    pub fn get_run(&self, run_id: &str) -> BenchResult<TriageRun> {
        TriageRun::parse_json(&self.read_entity("runs", run_id)?)
    }

    pub fn list_runs(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("runs"))
    }

    pub fn load_runs(&self) -> BenchResult<Vec<TriageRun>> {
        let mut runs = Vec::new();
        for id in self.list_runs()? {
            runs.push(self.get_run(&id)?);
        }
        Ok(runs)
    }

    pub fn materialize_review_packet(
        &self,
        run_id: &str,
        phase: ReviewPhase,
    ) -> BenchResult<ReviewPacket> {
        let run = self.get_run(run_id)?;
        let task = self.get_task(&run.task_id)?;
        let case = self.get_case(&run.case_id)?;
        let snapshot = self.get_snapshot(&run.snapshot_id)?;
        let raw = self.get_blob(&run.raw_output.digest.hex)?;
        let support_recorded = run_has_support_adjudication(&self.load_adjudications()?, run_id);
        let packet = materialize_review_packet(
            &case,
            &snapshot,
            &task,
            &run,
            &raw,
            phase,
            support_recorded,
        )?;
        atomic_write_json(
            &self.entity_path("review-packets", &packet.packet_id),
            &packet,
        )?;
        Ok(packet)
    }

    pub fn import_adjudication(&self, adj: Adjudication) -> BenchResult<ScoreReview> {
        let run = self.get_run(&adj.run_id)?;
        let snapshot = self.get_snapshot(&run.snapshot_id)?;
        let item_ids = snapshot
            .items
            .iter()
            .map(|item| item.item_id().to_string())
            .collect();
        let flags = citation_assist_flags(&item_ids, &run.claims);
        let adj = merge_citation_assists(adj, flags)?;
        self.put_adjudication(&adj)
    }

    pub fn put_adjudication(&self, adj: &Adjudication) -> BenchResult<ScoreReview> {
        adj.validate()?;
        let run = self.get_run(&adj.run_id)?;
        if run.task_id != adj.task_id
            || run.snapshot_id != adj.snapshot_id
            || run.case_id != adj.case_id
        {
            return Err(BenchError::CrossSnapshot(
                "adjudication identities do not match the run".into(),
            ));
        }
        let case = self.get_case(&adj.case_id)?;
        if !case.diagnosis_is_applicable() {
            match adj.outcome(crate::types::RubricDimension::DiagnosisCorrectness) {
                Some(outcome)
                    if matches!(
                        outcome.verdict,
                        crate::types::DimensionVerdict::NotApplicable
                            | crate::types::DimensionVerdict::Unscorable { .. }
                    ) => {}
                _ => {
                    return Err(BenchError::Schema(
                        "diagnosis_correctness must be n/a or unscorable when the case has no adjudicated root cause".into(),
                    ));
                }
            }
        }
        atomic_write_json(
            &self.entity_path("adjudications", &adj.adjudication_id),
            adj,
        )?;
        let score = adj.to_score_review()?;
        atomic_write_json(&self.entity_path("scores", &score.score_id), &score)?;
        Ok(score)
    }

    pub fn get_adjudication(&self, id: &str) -> BenchResult<Adjudication> {
        Adjudication::parse_json(&self.read_entity("adjudications", id)?)
    }

    pub fn list_adjudications(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("adjudications"))
    }

    pub fn load_adjudications(&self) -> BenchResult<Vec<Adjudication>> {
        let mut items = Vec::new();
        for id in self.list_adjudications()? {
            items.push(self.get_adjudication(&id)?);
        }
        Ok(items)
    }

    pub fn get_score(&self, id: &str) -> BenchResult<ScoreReview> {
        ScoreReview::parse_json(&self.read_entity("scores", id)?)
    }

    pub fn list_scores(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("scores"))
    }

    pub fn load_scores(&self) -> BenchResult<Vec<ScoreReview>> {
        let mut items = Vec::new();
        for id in self.list_scores()? {
            items.push(self.get_score(&id)?);
        }
        Ok(items)
    }

    fn entity_path(&self, kind: &str, id: &str) -> PathBuf {
        self.root.join(kind).join(format!("{id}.json"))
    }

    fn blob_path(&self, hex: &str) -> PathBuf {
        self.root.join("blobs/sha256").join(&hex[..2]).join(hex)
    }

    fn read_entity(&self, kind: &str, id: &str) -> BenchResult<String> {
        crate::types::validate_id(kind, id)?;
        let path = self.entity_path(kind, id);
        fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                BenchError::NotFound(format!("{kind}/{id}"))
            } else {
                BenchError::io(&path, e)
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutRunOutcome {
    Created { run_id: String },
    Duplicate { run_id: String },
}

fn list_ids(dir: &Path) -> BenchResult<Vec<String>> {
    let mut ids = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
        Err(err) => return Err(BenchError::io(dir, err)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| BenchError::io(dir, e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(id) = name.strip_suffix(".json") {
            ids.push(id.to_string());
        }
    }
    ids.sort();
    Ok(ids)
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> BenchResult<()> {
    let bytes = to_pretty_json(value)?.into_bytes();
    atomic_write_bytes(path, &bytes)
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> BenchResult<()> {
    if path.exists() {
        let existing = fs::read(path).map_err(|e| BenchError::io(path, e))?;
        if existing.as_slice() == bytes {
            return Ok(());
        }
        return Err(BenchError::Immutable(format!(
            "{} already exists with different content",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("record")
        )));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| BenchError::io(parent, e))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| BenchError::io(&tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| BenchError::io(path, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        CaseLifecycle, ContentDigest, EvidenceItem, EvidenceSource, HeldContent, PrivacyClass,
        ReportedProblem, VisibilityPolicy,
    };

    fn temp_store() -> (tempfile::TempDir, BenchStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BenchStore::init(dir.path(), "2026-01-15T00:00:00Z").unwrap();
        (dir, store)
    }

    #[test]
    fn mutated_blob_fails_closed() {
        let (_dir, store) = temp_store();
        let digest = store.put_blob(b"hello").unwrap();
        let path = store.blob_path(&digest.hex);
        fs::write(&path, b"mutated").unwrap();
        let err = store.get_blob(&digest.hex).unwrap_err();
        assert!(err.to_string().contains("digest verification"));
    }

    #[test]
    fn case_overwrite_with_different_bytes_is_rejected() {
        let (_dir, store) = temp_store();
        let mut case = Case {
            schema_id: crate::types::CASE_SCHEMA_V1.into(),
            case_id: "case-1".into(),
            privacy: PrivacyClass::OwnerOnly,
            title: "one".into(),
            reported_problem: ReportedProblem {
                summary: "s".into(),
                reported_at: None,
                reporter: None,
                symptoms: vec![],
            },
            lifecycle: CaseLifecycle::Unresolved,
            timeline_notes: vec![],
            created_at: "2026-01-15T00:00:00Z".into(),
            resolution: None,
        };
        store.put_case(&case).unwrap();
        case.title = "two".into();
        let err = store.put_case(&case).unwrap_err();
        assert!(matches!(err, BenchError::Immutable(_)));
    }

    #[test]
    fn snapshot_put_requires_matching_blob() {
        let (_dir, store) = temp_store();
        store
            .put_case(&Case {
                schema_id: crate::types::CASE_SCHEMA_V1.into(),
                case_id: "case-1".into(),
                privacy: PrivacyClass::OwnerOnly,
                title: "one".into(),
                reported_problem: ReportedProblem {
                    summary: "s".into(),
                    reported_at: None,
                    reporter: None,
                    symptoms: vec![],
                },
                lifecycle: CaseLifecycle::Unresolved,
                timeline_notes: vec![],
                created_at: "2026-01-15T00:00:00Z".into(),
                resolution: None,
            })
            .unwrap();
        let bytes = b"log-bytes";
        let snapshot = EvidenceSnapshot::from_parts(
            PrivacyClass::OwnerOnly,
            "case-1".into(),
            "2026-01-15T06:00:00Z".into(),
            "op".into(),
            vec![EvidenceItem::Log {
                item_id: "ev-log-1".into(),
                privacy: PrivacyClass::OwnerOnly,
                capture_time: "2026-01-15T04:12:00Z".into(),
                source: EvidenceSource {
                    reference: "app.log".into(),
                    captured_from: "fixture".into(),
                },
                media_type: "text/plain".into(),
                format: "raw".into(),
                content: HeldContent {
                    digest: ContentDigest::of_bytes(bytes),
                    byte_length: bytes.len() as u64,
                },
                summaries: vec![],
                visible_to_strategies: true,
            }],
            None,
        )
        .unwrap();
        let err = store.put_snapshot(&snapshot).unwrap_err();
        assert!(
            matches!(err, BenchError::Io { .. } | BenchError::NotFound(_))
                || err.to_string().contains("blobs")
                || err.to_string().contains("io")
        );
        store.put_blob(bytes).unwrap();
        store.put_snapshot(&snapshot).unwrap();
        let task = EvaluationTask::from_parts(
            PrivacyClass::OwnerOnly,
            "case-1".into(),
            snapshot.snapshot_id.clone(),
            "What failed?".into(),
            "visible evidence only".into(),
            "v1".into(),
            VisibilityPolicy {
                visible_item_ids: vec!["ev-log-1".into()],
                include_summaries: false,
                include_raw_bytes: true,
            },
            None,
            "2026-01-15T07:00:00Z".into(),
        )
        .unwrap();
        store.put_task(&task).unwrap();
        let packet = store.materialize_packet(&task.task_id).unwrap();
        assert!(!serde_json::to_string(&packet)
            .unwrap()
            .contains("resolution"));
    }
}
