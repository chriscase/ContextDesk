//! Host-owned publication/readout for Investigation Team qualification.
//!
//! The renderer can read bounded redacted history, but it cannot submit
//! evaluator truth or manufacture a qualification. Trusted execution code
//! publishes only after calling the `cd_workflow` seam with a host-built input.

use cd_core::capability_qualification::{
    QualificationTransport, SyntheticChatRequest, SyntheticChatResponse, SyntheticMessage,
};
use cd_core::config::AppConfig;
use cd_core::error::{CoreError, CoreResult};
use cd_core::investigation_answer::EvidenceRole;
use cd_core::investigation_team_qualification::{
    policy_budget_identity, AttemptClaim, AttemptRecord, AttemptStatus, AxisScore, CitationRecord,
    EvaluatorTruth, FingerprintedMember, InvestigationTeamRole, MemberBinding,
    ProviderFacingDocument, ProviderFacingInput, QualificationInput, ToolCallRecord, SCHEMA_ID,
    SUITE_VERSION,
};
use cd_core::openai_chat_contract::OpenAiChatRequestMode;
#[cfg(unix)]
use cd_core::quality_eval::LiveKnownAnswerOwnerDirectory;
use cd_workflow::capability_qualification::{LiveBackendKind, LiveQualificationTransport};
use cd_workflow::investigation_team_qualification::{
    QualificationExecutionResult, QualificationStatus,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(unix)]
use std::fs::{File, Metadata, OpenOptions};
#[cfg(unix)]
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
#[cfg(unix)]
use uuid::Uuid;

pub const INVESTIGATION_TEAM_QUALIFICATION_STORE_SCHEMA_V1: &str =
    "contextdesk.investigation_team_qualification_store.v1";
pub const MAX_INVESTIGATION_TEAM_QUALIFICATION_RECORDS: usize = 128;
pub const MAX_INVESTIGATION_TEAM_QUALIFICATION_STORE_BYTES: usize = 8 * 1024 * 1024;
#[cfg(not(unix))]
const QUALIFICATION_STORE_PLATFORM_UNAVAILABLE: &str = "redacted investigation team qualification history persistence is unavailable on this host because this build has no supported atomic-replacement and compare-and-swap backend";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
enum QualificationStoreRevision {
    #[default]
    Missing,
    Present([u8; 32]),
}

impl QualificationStoreRevision {
    fn for_validated_bytes(bytes: &[u8]) -> Self {
        Self::Present(Sha256::digest(bytes).into())
    }
}

/// Distinguishes provider-free wiring evidence from measured provider runs.
/// A synthetic result can validate the host seam, but must never be displayed
/// as evidence that a configured model or pipeline was measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvestigationTeamQualificationRunKind {
    Synthetic,
    Measured,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QualificationAxisDto {
    pub contract_met: bool,
    pub metrics: std::collections::BTreeMap<String, u64>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationTeamQualificationDto {
    pub run_kind: InvestigationTeamQualificationRunKind,
    pub status: QualificationStatus,
    pub schema_id: String,
    pub suite_version: String,
    pub observed_at: i64,
    pub stale: bool,
    pub incomplete_attempts: bool,
    pub fingerprint_digest: String,
    pub scoring_digest: String,
    pub capability: QualificationAxisDto,
    pub quality: QualificationAxisDto,
    pub speed: QualificationAxisDto,
    pub resource: QualificationAxisDto,
    /// Exact non-secret role/profile/model identities used for this report.
    /// This is copied from the host-validated fingerprint, not current settings.
    pub members: Vec<InvestigationTeamMemberDto>,
    pub failures: Vec<InvestigationTeamAttemptFailureDto>,
    pub redacted_json: String,
    pub redacted_markdown: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationTeamMemberDto {
    pub role: InvestigationTeamRole,
    pub subject_storage_id: String,
    pub profile_id: String,
    pub model_id: String,
    pub endpoint_fingerprint: String,
}

impl From<FingerprintedMember> for InvestigationTeamMemberDto {
    fn from(member: FingerprintedMember) -> Self {
        Self {
            role: member.role,
            subject_storage_id: member.subject_storage_id,
            profile_id: member.profile_id,
            model_id: member.model_id,
            endpoint_fingerprint: member.endpoint_fingerprint,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationTeamAttemptFailureDto {
    pub attempt_id: String,
    pub role: InvestigationTeamRole,
    pub reason: String,
}

impl From<AxisScore> for QualificationAxisDto {
    fn from(axis: AxisScore) -> Self {
        Self {
            contract_met: axis.contract_met,
            metrics: axis.metrics,
            notes: axis.notes,
        }
    }
}

impl InvestigationTeamQualificationDto {
    fn from_execution(
        result: QualificationExecutionResult,
        run_kind: InvestigationTeamQualificationRunKind,
    ) -> Self {
        let incomplete_attempts = result.has_incomplete_attempt();
        let report = result.report;
        Self {
            run_kind,
            status: result.status,
            schema_id: report.schema_id,
            suite_version: report.fingerprint.suite_version.clone(),
            observed_at: report.fingerprint.observed_at,
            stale: report.fingerprint.stale,
            incomplete_attempts,
            fingerprint_digest: report.fingerprint.digest,
            scoring_digest: report.scoring_digest,
            capability: report.axes.capability.into(),
            quality: report.axes.quality.into(),
            speed: report.axes.speed.into(),
            resource: report.axes.resource.into(),
            members: report
                .fingerprint
                .members
                .into_iter()
                .map(Into::into)
                .collect(),
            failures: Vec::new(),
            redacted_json: result.redacted_json,
            redacted_markdown: result.redacted_markdown,
        }
    }
}

impl From<QualificationExecutionResult> for InvestigationTeamQualificationDto {
    fn from(result: QualificationExecutionResult) -> Self {
        Self::from_execution(result, InvestigationTeamQualificationRunKind::Measured)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredInvestigationTeamQualification {
    run_kind: InvestigationTeamQualificationRunKind,
    result: QualificationExecutionResult,
    #[serde(default)]
    failures: Vec<InvestigationTeamAttemptFailureDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvestigationTeamQualificationStore {
    schema_id: String,
    #[serde(default)]
    records: Vec<StoredInvestigationTeamQualification>,
    /// Exact validated bytes observed by this process. This is host-only CAS
    /// state and is never serialized into the redacted history document.
    #[serde(skip)]
    expected_revision: QualificationStoreRevision,
}

impl Default for InvestigationTeamQualificationStore {
    fn default() -> Self {
        Self {
            schema_id: INVESTIGATION_TEAM_QUALIFICATION_STORE_SCHEMA_V1.into(),
            records: Vec::new(),
            expected_revision: QualificationStoreRevision::Missing,
        }
    }
}

/// Host lifecycle for durable aggregate qualification evidence. A malformed
/// existing store is never replaced by an empty default. Every operation
/// retries the secure load while holding the host mutex so an operator can
/// repair or remove the file and recover without restarting ContextDesk.
#[derive(Debug)]
pub enum InvestigationTeamQualificationStoreState {
    Available(InvestigationTeamQualificationStore),
    Unavailable,
}

impl InvestigationTeamQualificationStoreState {
    pub fn from_load_result(result: CoreResult<InvestigationTeamQualificationStore>) -> Self {
        match result {
            Ok(store) => Self::Available(store),
            Err(_) => Self::Unavailable,
        }
    }

    pub fn store(&self) -> CoreResult<&InvestigationTeamQualificationStore> {
        match self {
            Self::Available(store) => Ok(store),
            Self::Unavailable => Err(store_unavailable_error()),
        }
    }

    pub fn reload_for_operation(
        &mut self,
        path: &Path,
    ) -> CoreResult<&InvestigationTeamQualificationStore> {
        match InvestigationTeamQualificationStore::load(path) {
            Ok(store) => {
                *self = Self::Available(store);
                self.store()
            }
            Err(error) => {
                *self = Self::Unavailable;
                Err(error)
            }
        }
    }

    pub fn replace_with_committed(&mut self, store: InvestigationTeamQualificationStore) {
        *self = Self::Available(store);
    }
}

impl InvestigationTeamQualificationStore {
    fn validate(&self) -> CoreResult<()> {
        if self.schema_id != INVESTIGATION_TEAM_QUALIFICATION_STORE_SCHEMA_V1 {
            return Err(CoreError::Config(
                "investigation team qualification store schema is unsupported".into(),
            ));
        }
        if self.records.len() > MAX_INVESTIGATION_TEAM_QUALIFICATION_RECORDS {
            return Err(CoreError::Config(
                "investigation team qualification store has too many records".into(),
            ));
        }
        let mut ids = BTreeSet::new();
        for record in &self.records {
            validate_stored_record(record)?;
            let id = (
                record.result.report.fingerprint.digest.as_str(),
                record.result.report.scoring_digest.as_str(),
                record.run_kind,
            );
            if !ids.insert(id) {
                return Err(CoreError::Config(
                    "investigation team qualification store has a duplicate record".into(),
                ));
            }
        }
        let bytes = serde_json::to_vec(self)
            .map_err(|error| CoreError::Config(format!("qualification store encoding: {error}")))?;
        if bytes.len() > MAX_INVESTIGATION_TEAM_QUALIFICATION_STORE_BYTES {
            return Err(CoreError::Config(
                "investigation team qualification store is too large".into(),
            ));
        }
        Ok(())
    }

    /// Load bounded, redacted history. Missing is a safe empty store; malformed
    /// data is rejected instead of being presented as qualification evidence.
    pub fn load(path: &Path) -> CoreResult<Self> {
        #[cfg(unix)]
        {
            Self::load_unix(path, |_| {})
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Err(store_error(QUALIFICATION_STORE_PLATFORM_UNAVAILABLE))
        }
    }

    /// Atomically persist the validated, redacted store. Unix additionally
    /// applies owner-only permissions as defense in depth; this redacted store
    /// is not represented as a private canonical-capture boundary.
    pub fn save(&mut self, path: &Path) -> CoreResult<()> {
        #[cfg(unix)]
        {
            self.save_unix(path, |_| Ok(()), sync_parent_directory)
        }
        #[cfg(not(unix))]
        {
            let _ = path;
            Err(store_error(QUALIFICATION_STORE_PLATFORM_UNAVAILABLE))
        }
    }

    #[cfg(unix)]
    fn load_unix(path: &Path, after_open: impl FnOnce(&Path)) -> CoreResult<Self> {
        let (parent, name) = store_parent_and_name(path)?;
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                reject_missing_path_symlink_parent(parent)?;
                return Ok(Self::default());
            }
            Err(error) => return Err(error.into()),
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(store_error("store path is a symlink"));
                }
                if !metadata.is_file() {
                    return Err(store_error("store path is not a regular file"));
                }
                if metadata.len() as usize > MAX_INVESTIGATION_TEAM_QUALIFICATION_STORE_BYTES {
                    return Err(store_error("store is not bounded"));
                }
                if metadata.uid() != effective_uid() {
                    return Err(store_error("store is not owned by the effective user"));
                }
                if metadata.mode() & 0o077 != 0 {
                    return Err(store_error("store is not owner-only"));
                }
            }
        }
        verify_existing_parent(parent, false)?;
        let directory = LiveKnownAnswerOwnerDirectory::open(parent).map_err(|error| {
            store_error(&format!(
                "store parent is not a verified owner-only directory: {error}"
            ))
        })?;
        directory
            .revalidate_path(parent)
            .map_err(|_| store_error("store parent identity changed"))?;
        let Some(mut opened) = directory
            .open_owner_regular(
                name,
                MAX_INVESTIGATION_TEAM_QUALIFICATION_STORE_BYTES as u64,
                false,
            )
            .map_err(|_| store_error("cannot securely open the qualification store"))?
        else {
            return Ok(Self::default());
        };
        let before = opened.file.metadata()?;
        after_open(path);
        let bytes = read_exact_open_file(&mut opened.file, opened.size)?;
        let after = opened.file.metadata()?;
        validate_stable_open_metadata(&before, &after, opened.size)?;
        directory
            .revalidate_path(parent)
            .map_err(|_| store_error("store parent identity changed while reading"))?;
        Self::decode(&bytes)
    }

    #[cfg(unix)]
    fn save_unix(
        &mut self,
        path: &Path,
        before_replace: impl FnOnce(&Path) -> CoreResult<()>,
        mut sync_parent: impl FnMut(&LiveKnownAnswerOwnerDirectory) -> CoreResult<()>,
    ) -> CoreResult<()> {
        self.validate()?;
        let body = serde_json::to_vec_pretty(self)
            .map_err(|error| CoreError::Config(format!("qualification store encoding: {error}")))?;
        if body.len() > MAX_INVESTIGATION_TEAM_QUALIFICATION_STORE_BYTES {
            return Err(store_error("store is too large"));
        }
        let decoded = Self::decode(&body)?;
        if decoded.schema_id != self.schema_id || decoded.records != self.records {
            return Err(store_error("store encoding is not canonical"));
        }
        let next_revision = decoded.expected_revision;
        let (parent, name) = store_parent_and_name(path)?;
        verify_existing_parent(parent, true)?;
        let directory = LiveKnownAnswerOwnerDirectory::open(parent).map_err(|error| {
            store_error(&format!(
                "store parent is not a verified owner-only directory: {error}"
            ))
        })?;
        directory
            .revalidate_path(parent)
            .map_err(|_| store_error("store parent identity changed"))?;
        let lock_name = format!(".{name}.lock");
        tighten_owned_regular_file(&parent.join(&lock_name), "lock")?;
        let lock = acquire_qualification_write_lock(&directory, &lock_name)?;
        tighten_owned_regular_file(path, "store")?;
        let tmp_name = format!(".{name}.{}.tmp", Uuid::new_v4());
        let current = read_validated_current_store(&directory, name)?;
        let current_revision = current
            .as_ref()
            .map(|store| store.revision.clone())
            .unwrap_or_default();
        if current_revision != self.expected_revision {
            return Err(store_error(
                "store revision changed since it was loaded; reload before saving",
            ));
        }
        let rollback_name = current
            .as_ref()
            .map(|_| format!(".{name}.{}.rollback", Uuid::new_v4()));
        let prepared = (|| -> CoreResult<Metadata> {
            if let (Some(current), Some(rollback_name)) = (&current, &rollback_name) {
                let rollback_metadata =
                    write_verified_owner_file(&directory, rollback_name, &current.bytes)?;
                let rollback = read_validated_current_store(&directory, rollback_name)?
                    .ok_or_else(|| store_error("rollback store disappeared"))?;
                validate_stable_open_metadata(
                    &rollback_metadata,
                    &rollback.metadata,
                    current.bytes.len() as u64,
                )?;
                if rollback.bytes != current.bytes || rollback.revision != current.revision {
                    return Err(store_error("rollback store verification failed"));
                }
            }
            let tmp_metadata = write_verified_owner_file(&directory, &tmp_name, &body)?;
            let verified = Self::decode(&body)?;
            if verified.schema_id != self.schema_id || verified.records != self.records {
                return Err(store_error("temporary store verification failed"));
            }
            Ok(tmp_metadata)
        })();
        let tmp_metadata = match prepared {
            Ok(metadata) => metadata,
            Err(error) => {
                let _ = directory.remove_file(&tmp_name);
                if let Some(rollback_name) = &rollback_name {
                    let _ = directory.remove_file(rollback_name);
                }
                return Err(error);
            }
        };

        let before_publication = (|| -> CoreResult<()> {
            before_replace(path)?;
            directory
                .revalidate_path(parent)
                .map_err(|_| store_error("store path identity changed"))?;
            lock.revalidate(&directory, &lock_name)?;
            let named_tmp = directory
                .open_owner_regular(&tmp_name, body.len() as u64, false)?
                .ok_or_else(|| store_error("temporary store pathname disappeared"))?;
            validate_stable_open_metadata(
                &tmp_metadata,
                &named_tmp.file.metadata()?,
                body.len() as u64,
            )?;
            // This destination read is intentionally the final operation
            // before atomic replacement. It binds CAS to both the exact
            // validated bytes and the inode observed under the retained lock.
            let destination = read_validated_current_store(&directory, name)?;
            match (&current, &destination) {
                (None, None) => {}
                (Some(expected), Some(actual)) => {
                    validate_stable_open_metadata(
                        &expected.metadata,
                        &actual.metadata,
                        expected.bytes.len() as u64,
                    )
                    .map_err(|_| {
                        store_error(
                            "store destination inode changed immediately before replacement",
                        )
                    })?;
                    if actual.revision != expected.revision || actual.bytes != expected.bytes {
                        return Err(store_error(
                            "store destination changed immediately before replacement",
                        ));
                    }
                }
                _ => {
                    return Err(store_error(
                        "store destination changed immediately before replacement",
                    ));
                }
            }
            lock.revalidate(&directory, &lock_name)?;
            let destination = read_validated_current_store(&directory, name)?;
            match (&current, &destination) {
                (None, None) => {}
                (Some(expected), Some(actual)) => {
                    validate_stable_open_metadata(
                        &expected.metadata,
                        &actual.metadata,
                        expected.bytes.len() as u64,
                    )
                    .map_err(|_| {
                        store_error("store destination inode changed at atomic replacement")
                    })?;
                    if actual.revision != expected.revision || actual.bytes != expected.bytes {
                        return Err(store_error(
                            "store destination changed at atomic replacement",
                        ));
                    }
                }
                _ => {
                    return Err(store_error(
                        "store destination changed at atomic replacement",
                    ));
                }
            }
            directory
                .rename_replace(&tmp_name, name)
                .map_err(|_| store_error("cannot atomically replace the qualification store"))?;
            Ok(())
        })();
        if let Err(error) = before_publication {
            let _ = directory.remove_file(&tmp_name);
            if let Some(rollback_name) = &rollback_name {
                let _ = directory.remove_file(rollback_name);
            }
            return Err(error);
        }

        if let Err(publication_sync_error) = sync_parent(&directory) {
            let rollback = (|| -> CoreResult<()> {
                let verified_rollback = if let (Some(expected), Some(rollback_name)) =
                    (&current, &rollback_name)
                {
                    let rollback = read_validated_current_store(&directory, rollback_name)?
                        .ok_or_else(|| store_error("rollback store disappeared"))?;
                    if rollback.bytes != expected.bytes || rollback.revision != expected.revision {
                        return Err(store_error("rollback store changed before restoration"));
                    }
                    Some(rollback_name)
                } else {
                    None
                };
                lock.revalidate(&directory, &lock_name)?;
                let published = read_validated_current_store(&directory, name)?
                    .ok_or_else(|| store_error("published store disappeared before rollback"))?;
                validate_renamed_file_identity(
                    &tmp_metadata,
                    &published.metadata,
                    body.len() as u64,
                )?;
                if published.bytes != body || published.revision != next_revision {
                    return Err(store_error(
                        "published store changed before rollback; refusing to overwrite it",
                    ));
                }
                if let Some(rollback_name) = verified_rollback {
                    directory
                        .rename_replace(rollback_name, name)
                        .map_err(|_| store_error("cannot atomically restore the prior store"))?;
                } else {
                    directory
                        .remove_file(name)
                        .map_err(|_| store_error("cannot remove uncommitted new store"))?;
                }
                sync_parent(&directory)?;
                directory
                    .revalidate_path(parent)
                    .map_err(|_| store_error("store path identity changed during rollback"))?;
                lock.revalidate(&directory, &lock_name)?;
                let restored = read_validated_current_store(&directory, name)?;
                match (&current, restored) {
                    (None, None) => Ok(()),
                    (Some(expected), Some(actual))
                        if actual.bytes == expected.bytes
                            && actual.revision == expected.revision =>
                    {
                        Ok(())
                    }
                    _ => Err(store_error(
                        "prior store could not be proven after publication rollback",
                    )),
                }
            })();
            if let Err(rollback_error) = rollback {
                return Err(store_error(&format!(
                    "publication sync failed and rollback durability is indeterminate: {publication_sync_error}; {rollback_error}"
                )));
            }
            return Err(publication_sync_error);
        }

        directory
            .revalidate_path(parent)
            .map_err(|_| store_error("store path identity changed after publication"))?;
        lock.revalidate(&directory, &lock_name)?;
        let committed = read_validated_current_store(&directory, name)?
            .ok_or_else(|| store_error("committed store disappeared"))?;
        validate_renamed_file_identity(&tmp_metadata, &committed.metadata, body.len() as u64)?;
        if committed.bytes != body || committed.revision != next_revision {
            return Err(store_error(
                "committed store changed before the writer revision could advance",
            ));
        }
        lock.revalidate(&directory, &lock_name)?;
        self.expected_revision = next_revision;
        if let Some(rollback_name) = &rollback_name {
            if let Err(error) = directory.remove_file(rollback_name) {
                tracing::warn!(%error, "committed qualification history left a recoverable rollback sibling");
            } else if let Err(error) = sync_parent_directory(&directory) {
                tracing::warn!(%error, "qualification history rollback-sibling cleanup was not durably synced");
            }
        }
        Ok(())
    }

    fn decode(bytes: &[u8]) -> CoreResult<Self> {
        let mut deserializer = serde_json::Deserializer::from_slice(bytes);
        let mut store = Self::deserialize(&mut deserializer)
            .map_err(|error| store_error(&format!("store is malformed: {error}")))?;
        deserializer
            .end()
            .map_err(|_| store_error("store has trailing bytes"))?;
        store.validate()?;
        store.expected_revision = QualificationStoreRevision::for_validated_bytes(bytes);
        Ok(store)
    }

    /// Publish only from trusted host execution code; renderer IPC has no
    /// setter for this store. Exact duplicate replays replace, while distinct
    /// observations remain in bounded history.
    pub fn publish(
        &mut self,
        result: QualificationExecutionResult,
        run_kind: InvestigationTeamQualificationRunKind,
        failures: Vec<InvestigationTeamAttemptFailureDto>,
    ) -> CoreResult<InvestigationTeamQualificationDto> {
        let record = StoredInvestigationTeamQualification {
            run_kind,
            result,
            failures,
        };
        validate_stored_record(&record)?;
        let published = project_record(&record);
        let fingerprint = record.result.report.fingerprint.digest.clone();
        let scoring = record.result.report.scoring_digest.clone();
        if let Some(existing) = self.records.iter_mut().find(|existing| {
            existing.run_kind == record.run_kind
                && existing.result.report.fingerprint.digest == fingerprint
                && existing.result.report.scoring_digest == scoring
        }) {
            *existing = record;
        } else {
            self.records.push(record);
        }
        self.records.sort_by(|left, right| {
            left.result
                .report
                .fingerprint
                .observed_at
                .cmp(&right.result.report.fingerprint.observed_at)
                .then(
                    left.result
                        .report
                        .fingerprint
                        .digest
                        .cmp(&right.result.report.fingerprint.digest),
                )
        });
        if self.records.len() > MAX_INVESTIGATION_TEAM_QUALIFICATION_RECORDS {
            let remove = self.records.len() - MAX_INVESTIGATION_TEAM_QUALIFICATION_RECORDS;
            self.records.drain(0..remove);
        }
        self.validate()?;
        Ok(published)
    }

    pub fn latest(&self) -> Option<InvestigationTeamQualificationDto> {
        // Prefer actual measured evidence over a newer provider-free wiring
        // check. Synthetic history remains available but never displaces the
        // latest measured pipeline on startup.
        self.records
            .iter()
            .rev()
            .find(|record| record.run_kind == InvestigationTeamQualificationRunKind::Measured)
            .or_else(|| self.records.last())
            .map(project_record)
    }

    pub fn history(&self) -> Vec<InvestigationTeamQualificationDto> {
        self.records.iter().rev().map(project_record).collect()
    }

    pub fn clear(&mut self) -> bool {
        if self.records.is_empty() {
            false
        } else {
            self.records.clear();
            true
        }
    }
}

pub fn investigation_team_qualification_store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("investigation-team-qualifications.json")
}

fn store_error(detail: &str) -> CoreError {
    CoreError::Config(format!("investigation team qualification store: {detail}"))
}

fn store_unavailable_error() -> CoreError {
    if let Err(error) = ensure_live_history_persistence_supported() {
        return error;
    }
    store_error(
        "existing evidence is unavailable; repair or remove the invalid owner store before listing, clearing, running, or saving",
    )
}

fn ensure_live_history_persistence_supported() -> CoreResult<()> {
    #[cfg(unix)]
    {
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(store_error(QUALIFICATION_STORE_PLATFORM_UNAVAILABLE))
    }
}

fn store_parent_and_name(path: &Path) -> CoreResult<(&Path, &str)> {
    if !path.is_absolute() {
        return Err(store_error("store path must be absolute"));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| store_error("store path has no parent directory"))?;
    if parent == Path::new("/") {
        return Err(store_error("filesystem root cannot be the store parent"));
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| store_error("store filename is invalid"))?;
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(store_error("store filename is not a single path segment"));
    }
    Ok((parent, name))
}

#[cfg(unix)]
fn effective_uid() -> u32 {
    extern "C" {
        fn geteuid() -> u32;
    }
    // SAFETY: geteuid has no preconditions and retains no pointer.
    unsafe { geteuid() }
}

#[cfg(unix)]
fn is_home_path(path: &Path) -> bool {
    if let Some(home) = std::env::var_os("HOME") {
        if Path::new(&home) == path {
            return true;
        }
    }
    dirs::home_dir().is_some_and(|home| home == path)
}

#[cfg(unix)]
fn reject_missing_path_symlink_parent(parent: &Path) -> CoreResult<()> {
    match std::fs::symlink_metadata(parent) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(store_error("store parent is a symlink"))
        }
        Ok(_) => Ok(()),
    }
}

#[cfg(unix)]
fn verify_existing_parent(parent: &Path, tighten_if_owned: bool) -> CoreResult<()> {
    if is_home_path(parent) {
        return Err(store_error(
            "refusing to use HOME as the qualification store parent",
        ));
    }
    let metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            store_error("store parent is missing")
        } else {
            error.into()
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(store_error("store parent is a symlink"));
    }
    if !metadata.is_dir() {
        return Err(store_error("store parent is not a directory"));
    }
    if metadata.uid() != effective_uid() {
        return Err(store_error(
            "store parent is not owned by the effective user",
        ));
    }
    if metadata.mode() & 0o1000 != 0 {
        return Err(store_error("store parent has the sticky bit set"));
    }
    if metadata.mode() & 0o077 != 0 {
        if !tighten_if_owned {
            return Err(store_error("store parent is not owner-only"));
        }
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(parent, permissions)?;
        let tightened = std::fs::symlink_metadata(parent)?;
        if tightened.file_type().is_symlink()
            || !tightened.is_dir()
            || tightened.uid() != effective_uid()
            || tightened.mode() & 0o077 != 0
            || is_home_path(parent)
        {
            return Err(store_error(
                "store parent could not be tightened to owner-only",
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn unix_o_nofollow() -> CoreResult<i32> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return Ok(0x20000);
    }
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "dragonfly",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        return Ok(0x0100);
    }
    #[allow(unreachable_code)]
    Err(store_error(
        "no-follow open cannot be guaranteed with existing dependencies on this unix host",
    ))
}

#[cfg(unix)]
fn tighten_owned_regular_file(path: &Path, kind: &str) -> CoreResult<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(metadata) => metadata,
    };
    if metadata.file_type().is_symlink() {
        return Err(store_error(&format!("{kind} path is a symlink")));
    }
    if !metadata.is_file() {
        return Err(store_error(&format!("{kind} path is not a regular file")));
    }
    if metadata.uid() != effective_uid() {
        return Err(store_error(&format!(
            "{kind} is not owned by the effective user"
        )));
    }
    if metadata.mode() & 0o077 == 0 {
        return Ok(());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(unix_o_nofollow()?)
        .open(path)
        .map_err(|_| {
            store_error(&format!(
                "cannot no-follow open {kind} to tighten permissions"
            ))
        })?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.uid() != effective_uid() {
        return Err(store_error(&format!(
            "{kind} identity changed while tightening permissions"
        )));
    }
    let mut permissions = opened.permissions();
    permissions.set_mode(0o600);
    file.set_permissions(permissions)?;
    let after = file.metadata()?;
    if !after.is_file() || after.uid() != effective_uid() || after.mode() & 0o077 != 0 {
        return Err(store_error(&format!(
            "{kind} could not be tightened to owner-only"
        )));
    }
    Ok(())
}

#[cfg(unix)]
struct QualificationWriteLock {
    file: File,
    identity: Metadata,
}

#[cfg(unix)]
impl QualificationWriteLock {
    fn revalidate(&self, directory: &LiveKnownAnswerOwnerDirectory, name: &str) -> CoreResult<()> {
        let held = self.file.metadata()?;
        validate_stable_open_metadata(&self.identity, &held, 0)
            .map_err(|_| store_error("qualification write lock retained inode metadata changed"))?;
        if held.nlink() != 1 {
            return Err(store_error(
                "qualification write lock pathname is no longer uniquely bound",
            ));
        }
        let named = directory
            .open_owner_regular(name, 0, false)
            .map_err(|_| store_error("qualification write lock is unsafe to revalidate"))?
            .ok_or_else(|| store_error("qualification write lock pathname disappeared"))?;
        let named_metadata = named.file.metadata()?;
        validate_stable_open_metadata(&held, &named_metadata, 0)
            .map_err(|_| store_error("qualification write lock pathname identity changed"))?;
        if named_metadata.nlink() != 1 {
            return Err(store_error(
                "qualification write lock pathname is no longer uniquely bound",
            ));
        }
        Ok(())
    }
}

#[cfg(unix)]
fn acquire_qualification_write_lock(
    directory: &LiveKnownAnswerOwnerDirectory,
    name: &str,
) -> CoreResult<QualificationWriteLock> {
    let file = match directory
        .open_owner_regular(name, 0, true)
        .map_err(|_| store_error("qualification write lock is unsafe to open"))?
    {
        Some(opened) => opened.file,
        None => directory
            .create_owner_regular(name)
            .map_err(|_| store_error("cannot create an owner-only qualification write lock"))?,
    };
    let opened_metadata = file.metadata()?;
    let named = directory
        .open_owner_regular(name, 0, false)
        .map_err(|_| store_error("qualification write lock is unsafe to reopen"))?
        .ok_or_else(|| store_error("qualification write lock disappeared"))?;
    validate_stable_open_metadata(&opened_metadata, &named.file.metadata()?, 0)?;
    file.try_lock()
        .map_err(|_| store_error("qualification store is locked by another writer"))?;
    let locked_metadata = file.metadata()?;
    let locked_named = directory
        .open_owner_regular(name, 0, false)
        .map_err(|_| store_error("qualification write lock is unsafe after lock"))?
        .ok_or_else(|| store_error("qualification write lock disappeared after lock"))?;
    validate_stable_open_metadata(&locked_metadata, &locked_named.file.metadata()?, 0)?;
    if locked_metadata.nlink() != 1 {
        return Err(store_error(
            "qualification write lock pathname is not uniquely bound",
        ));
    }
    Ok(QualificationWriteLock {
        file,
        identity: locked_metadata,
    })
}

#[cfg(unix)]
struct ValidatedCurrentStore {
    bytes: Vec<u8>,
    metadata: Metadata,
    revision: QualificationStoreRevision,
}

#[cfg(unix)]
fn read_validated_current_store(
    directory: &LiveKnownAnswerOwnerDirectory,
    name: &str,
) -> CoreResult<Option<ValidatedCurrentStore>> {
    let Some(mut opened) = directory
        .open_owner_regular(
            name,
            MAX_INVESTIGATION_TEAM_QUALIFICATION_STORE_BYTES as u64,
            false,
        )
        .map_err(|_| store_error("existing store path is unsafe to read"))?
    else {
        return Ok(None);
    };
    let before = opened.file.metadata()?;
    let bytes = read_exact_open_file(&mut opened.file, opened.size)?;
    let after = opened.file.metadata()?;
    validate_stable_open_metadata(&before, &after, opened.size)?;
    let revision = InvestigationTeamQualificationStore::decode(&bytes)?.expected_revision;
    Ok(Some(ValidatedCurrentStore {
        bytes,
        metadata: after,
        revision,
    }))
}

#[cfg(unix)]
fn write_verified_owner_file(
    directory: &LiveKnownAnswerOwnerDirectory,
    name: &str,
    bytes: &[u8],
) -> CoreResult<Metadata> {
    let mut file = directory
        .create_owner_regular(name)
        .map_err(|_| store_error("cannot create a unique owner-only store sibling"))?;
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()?;
    file.seek(SeekFrom::Start(0))?;
    let before = file.metadata()?;
    let written = read_exact_open_file(&mut file, bytes.len() as u64)?;
    let after = file.metadata()?;
    validate_stable_open_metadata(&before, &after, bytes.len() as u64)?;
    if written != bytes {
        return Err(store_error(
            "store sibling bytes changed before publication",
        ));
    }
    let named = directory
        .open_owner_regular(name, bytes.len() as u64, false)?
        .ok_or_else(|| store_error("store sibling pathname disappeared"))?;
    validate_stable_open_metadata(&after, &named.file.metadata()?, bytes.len() as u64)?;
    Ok(after)
}

#[cfg(unix)]
fn read_exact_open_file(file: &mut File, expected_size: u64) -> CoreResult<Vec<u8>> {
    if expected_size > MAX_INVESTIGATION_TEAM_QUALIFICATION_STORE_BYTES as u64 {
        return Err(store_error("store exceeds the byte limit"));
    }
    file.seek(SeekFrom::Start(0))?;
    let expected = usize::try_from(expected_size)
        .map_err(|_| store_error("store size cannot be represented"))?;
    let mut bytes = vec![0; expected];
    file.read_exact(&mut bytes)?;
    let mut sentinel = [0u8; 1];
    if file.read(&mut sentinel)? != 0 {
        return Err(store_error("store grew while it was being read"));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn validate_stable_open_metadata(
    before: &std::fs::Metadata,
    after: &std::fs::Metadata,
    expected_size: u64,
) -> CoreResult<()> {
    if !before.is_file()
        || !after.is_file()
        || before.len() != expected_size
        || after.len() != expected_size
    {
        return Err(store_error(
            "open store identity or size changed while reading",
        ));
    }
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mode() != after.mode()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(store_error("open store metadata changed while reading"));
    }
    Ok(())
}

#[cfg(unix)]
fn validate_renamed_file_identity(
    before: &std::fs::Metadata,
    after: &std::fs::Metadata,
    expected_size: u64,
) -> CoreResult<()> {
    if !before.is_file()
        || !after.is_file()
        || before.len() != expected_size
        || after.len() != expected_size
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.uid() != after.uid()
        || before.mode() != after.mode()
    {
        return Err(store_error(
            "published store inode identity changed across atomic rename",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(directory: &LiveKnownAnswerOwnerDirectory) -> CoreResult<()> {
    directory
        .sync()
        .map_err(|_| store_error("cannot sync the qualification store parent directory"))
}

fn project_record(
    record: &StoredInvestigationTeamQualification,
) -> InvestigationTeamQualificationDto {
    let mut dto =
        InvestigationTeamQualificationDto::from_execution(record.result.clone(), record.run_kind);
    dto.failures = record.failures.clone();
    if dto.suite_version != SUITE_VERSION {
        dto.status = QualificationStatus::Stale;
        dto.stale = true;
    }
    dto
}

fn validate_stored_record(record: &StoredInvestigationTeamQualification) -> CoreResult<()> {
    let parsed =
        cd_core::investigation_team_qualification::parse_report(&record.result.redacted_json)?;
    if parsed != record.result.report
        || cd_core::investigation_team_qualification::render_json(&parsed)?
            != record.result.redacted_json
        || cd_core::investigation_team_qualification::render_markdown(&parsed)?
            != record.result.redacted_markdown
        || cd_workflow::investigation_team_qualification::status_for(&parsed)
            != record.result.status
    {
        return Err(CoreError::Config(
            "investigation team qualification history failed canonical validation".into(),
        ));
    }
    for failure in &record.failures {
        if failure.attempt_id.trim().is_empty()
            || failure.attempt_id.len() > 128
            || !is_safe_attempt_failure_reason(&failure.reason)
            || !parsed.attempts.iter().any(|attempt| {
                attempt.attempt_id == failure.attempt_id && attempt.role == failure.role
            })
        {
            return Err(CoreError::Config(
                "investigation team qualification failure summary is invalid".into(),
            ));
        }
    }
    Ok(())
}

/// A trusted provider-backed member target. Credentials and raw deployment
/// details stay inside the host and never enter the DTO or redacted report.
pub struct LiveQualificationTarget {
    pub member: MemberBinding,
    pub backend: LiveBackendKind,
    pub base_url: String,
    pub api_key: Option<String>,
    pub extra_headers: Vec<(String, String)>,
    pub local_only: bool,
}

#[derive(Debug, Clone)]
pub struct LiveQualificationExecutionResult {
    pub result: QualificationExecutionResult,
    pub failures: Vec<InvestigationTeamAttemptFailureDto>,
}

pub const LIVE_QUALIFICATION_CANCEL_KEY: &str = "investigation_team_qualification_live";

fn is_safe_attempt_failure_reason(reason: &str) -> bool {
    matches!(
        reason,
        "provider_attempt_cancelled"
            | "provider_request_failed"
            | "unknown_evidence_citation"
            | "response_contract_failed"
            | "cancelled_before_dispatch"
    )
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderQualificationAnswer {
    claims: Vec<ProviderQualificationClaim>,
    citations: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderQualificationClaim {
    text: String,
    evidence_ids: Vec<String>,
}

/// A host-controlled outcome used by tests and the explicit local synthetic
/// check. It is never accepted from renderer input.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyntheticQualificationMode {
    /// Every deterministic fixture attempt completes.
    Completed,
    /// One deterministic fixture attempt remains incomplete.
    Partial,
    /// The fixture claims an older suite and must be treated as stale.
    Stale,
}

/// Build the small opaque packet used by the local synthetic qualification
/// check. This function does not contact a provider and does not persist data.
pub fn synthetic_input(
    members: Vec<MemberBinding>,
    observed_at: i64,
    mode: SyntheticQualificationMode,
) -> CoreResult<QualificationInput> {
    if observed_at <= 0 {
        return Err(CoreError::Config(
            "synthetic qualification requires a positive observation timestamp".into(),
        ));
    }
    if members.is_empty() {
        return Err(CoreError::Config(
            "synthetic qualification requires at least one host-owned team member".into(),
        ));
    }

    let evidence_id = "synthetic-evidence-1".to_string();
    let source_id = "synthetic-source-1".to_string();
    let time_anchor = "synthetic-time-1".to_string();
    let max_tool_calls = 4;
    let resource_budget = 100;
    let attempt_status = match mode {
        SyntheticQualificationMode::Completed | SyntheticQualificationMode::Stale => {
            AttemptStatus::Completed
        }
        SyntheticQualificationMode::Partial => AttemptStatus::Partial,
    };
    let suite_version = match mode {
        SyntheticQualificationMode::Stale => {
            "contextdesk.investigation_team_qualification.suite.v0"
        }
        SyntheticQualificationMode::Completed | SyntheticQualificationMode::Partial => {
            SUITE_VERSION
        }
    };

    let attempts = members
        .iter()
        .enumerate()
        .map(|(index, member)| AttemptRecord {
            attempt_id: format!("synthetic-attempt-{}", index + 1),
            role: member.role,
            model_id: member.model_id.clone(),
            profile_id: member.profile_id.clone(),
            endpoint_fingerprint: member.endpoint_fingerprint.clone(),
            status: attempt_status,
            completion_claimed: attempt_status.may_claim_completion(),
            claims: vec![AttemptClaim {
                text: "synthetic contract witness".into(),
                evidence_ids: vec![evidence_id.clone()],
            }],
            tool_calls: vec![ToolCallRecord {
                name: "cd_qualify_lookup".into(),
                evidence_ids: vec![evidence_id.clone()],
            }],
            citations: vec![CitationRecord {
                evidence_id: evidence_id.clone(),
                source_id: source_id.clone(),
                time_anchor: time_anchor.clone(),
                role: EvidenceRole::Supporting,
            }],
            latency_ms: 20,
            resource_units: 8,
        })
        .collect();

    Ok(QualificationInput {
        schema_id: SCHEMA_ID.into(),
        current_suite_version: SUITE_VERSION.into(),
        suite_version: suite_version.into(),
        observed_at,
        stale: matches!(mode, SyntheticQualificationMode::Stale),
        policy_budget_identity: policy_budget_identity(max_tool_calls, resource_budget),
        max_tool_calls,
        resource_budget,
        members,
        provider_facing: ProviderFacingInput {
            question: "Which opaque evidence item is bound to this local contract check?".into(),
            evidence_packet: vec![ProviderFacingDocument {
                id: evidence_id,
                text: "Opaque synthetic evidence for local contract verification.".into(),
            }],
        },
        truth: EvaluatorTruth {
            required_evidence_ids: BTreeSet::from(["synthetic-evidence-1".into()]),
            required_sources: BTreeMap::from([("synthetic-evidence-1".into(), source_id)]),
            required_times: BTreeMap::from([("synthetic-evidence-1".into(), time_anchor)]),
            forbidden_provider_tokens: BTreeSet::new(),
        },
        attempts,
    })
}

/// Execute the explicit local synthetic check through the same host workflow
/// seam used by future real execution. The returned result remains redacted.
pub fn execute_synthetic(
    members: Vec<MemberBinding>,
    observed_at: i64,
) -> CoreResult<QualificationExecutionResult> {
    cd_workflow::investigation_team_qualification::execute(synthetic_input(
        members,
        observed_at,
        SyntheticQualificationMode::Completed,
    )?)
}

const LIVE_EVIDENCE_ID: &str = "live-qualification-evidence-1";
const LIVE_SOURCE_ID: &str = "live-qualification-source-1";
const LIVE_TIME_ANCHOR: &str = "live-qualification-time-1";
const LIVE_MAX_TOOL_CALLS: u32 = 4;
const LIVE_RESOURCE_BUDGET: u64 = 32_768;

fn live_input_shell(
    members: Vec<MemberBinding>,
    observed_at: i64,
) -> CoreResult<QualificationInput> {
    let mut input = synthetic_input(members, observed_at, SyntheticQualificationMode::Completed)?;
    input.attempts.clear();
    input.max_tool_calls = LIVE_MAX_TOOL_CALLS;
    input.resource_budget = LIVE_RESOURCE_BUDGET;
    input.policy_budget_identity =
        policy_budget_identity(input.max_tool_calls, input.resource_budget);
    input.provider_facing.question =
        "Return a JSON qualification answer using only the opaque evidence ids provided.".into();
    input.provider_facing.evidence_packet = vec![ProviderFacingDocument {
        id: LIVE_EVIDENCE_ID.into(),
        text: "An opaque host-owned evidence item for a bounded qualification check.".into(),
    }];
    input.truth = EvaluatorTruth {
        required_evidence_ids: BTreeSet::from([LIVE_EVIDENCE_ID.into()]),
        required_sources: BTreeMap::from([(LIVE_EVIDENCE_ID.into(), LIVE_SOURCE_ID.into())]),
        required_times: BTreeMap::from([(LIVE_EVIDENCE_ID.into(), LIVE_TIME_ANCHOR.into())]),
        forbidden_provider_tokens: BTreeSet::new(),
    };
    Ok(input)
}

fn live_request(model_id: &str, input: &QualificationInput) -> CoreResult<SyntheticChatRequest> {
    let packet = serde_json::to_string(&input.provider_facing)
        .map_err(|error| CoreError::Config(format!("qualification packet: {error}")))?;
    Ok(SyntheticChatRequest {
        model_id: model_id.into(),
        messages: vec![
            SyntheticMessage {
                role: "system".into(),
                content: "You are completing a bounded ContextDesk response-format check. Return only one JSON object with exactly these keys: claims and citations. claims is an array of objects with text and evidence_ids. citations is an array of evidence id strings. Cite only ids present in the packet.".into(),
                tool_call_id: None,
                tool_calls: Vec::new(),
            },
            SyntheticMessage {
                role: "user".into(),
                content: format!("Qualification packet:\n{packet}"),
                tool_call_id: None,
                tool_calls: Vec::new(),
            },
        ],
        tools: Vec::new(),
        stream: false,
        chat_mode: OpenAiChatRequestMode::PromptedJson,
    })
}

fn live_failure(
    attempt_id: &str,
    role: InvestigationTeamRole,
    reason: impl Into<String>,
) -> InvestigationTeamAttemptFailureDto {
    InvestigationTeamAttemptFailureDto {
        attempt_id: attempt_id.into(),
        role,
        reason: reason.into(),
    }
}

fn attempt_from_response(
    target: &LiveQualificationTarget,
    attempt_id: &str,
    input: &QualificationInput,
    response: SyntheticChatResponse,
    elapsed_ms: u64,
) -> (AttemptRecord, Option<InvestigationTeamAttemptFailureDto>) {
    let resource_units = input.provider_facing.question.len() as u64
        + input
            .provider_facing
            .evidence_packet
            .iter()
            .map(|document| document.id.len() + document.text.len())
            .sum::<usize>() as u64
        + response.content.len() as u64;
    let role = target.member.role;
    let mut failure = None;

    let (status, completion_claimed, claims, citations) = if response.cancelled {
        failure = Some(live_failure(attempt_id, role, "provider_attempt_cancelled"));
        (AttemptStatus::Cancelled, false, Vec::new(), Vec::new())
    } else if response.raw_error.is_some() {
        // Provider diagnostics can contain endpoint or credential-adjacent
        // bytes. Preserve the honest failure class, never the raw transport
        // string, in renderer-visible or durable qualification history.
        failure = Some(live_failure(attempt_id, role, "provider_request_failed"));
        (AttemptStatus::Failed, false, Vec::new(), Vec::new())
    } else {
        match serde_json::from_str::<ProviderQualificationAnswer>(&response.content) {
            Ok(answer) => {
                let invalid_citation = answer
                    .citations
                    .iter()
                    .any(|evidence_id| evidence_id != LIVE_EVIDENCE_ID);
                if invalid_citation {
                    failure = Some(live_failure(attempt_id, role, "unknown_evidence_citation"));
                    (AttemptStatus::Failed, false, Vec::new(), Vec::new())
                } else {
                    let claims = answer
                        .claims
                        .into_iter()
                        .map(|claim| AttemptClaim {
                            text: claim.text,
                            evidence_ids: claim.evidence_ids,
                        })
                        .collect();
                    let citations = answer
                        .citations
                        .into_iter()
                        .map(|evidence_id| CitationRecord {
                            evidence_id,
                            source_id: LIVE_SOURCE_ID.into(),
                            time_anchor: LIVE_TIME_ANCHOR.into(),
                            role: EvidenceRole::Supporting,
                        })
                        .collect();
                    (AttemptStatus::Completed, true, claims, citations)
                }
            }
            Err(_) => {
                failure = Some(live_failure(attempt_id, role, "response_contract_failed"));
                (AttemptStatus::Failed, false, Vec::new(), Vec::new())
            }
        }
    };

    let tool_calls = response
        .tool_calls
        .into_iter()
        .map(|call| ToolCallRecord {
            name: call.name,
            evidence_ids: Vec::new(),
        })
        .collect();
    (
        AttemptRecord {
            attempt_id: attempt_id.into(),
            role,
            model_id: target.member.model_id.clone(),
            profile_id: target.member.profile_id.clone(),
            endpoint_fingerprint: target.member.endpoint_fingerprint.clone(),
            status,
            completion_claimed,
            claims,
            tool_calls,
            citations,
            latency_ms: elapsed_ms,
            resource_units,
        },
        failure,
    )
}

/// Run one bounded provider-backed qualification attempt per host-owned role.
/// Provider bytes contain only opaque evidence; evaluator truth is attached
/// after the response returns and never crosses the provider boundary.
pub fn execute_live(
    targets: Vec<LiveQualificationTarget>,
    observed_at: i64,
    cancel: &AtomicBool,
) -> CoreResult<LiveQualificationExecutionResult> {
    // Unsupported platforms fail before provider dispatch because this build
    // has no persistence backend with the required atomic-replace and CAS seam.
    // Unix destination availability is still validated when the result saves.
    ensure_live_history_persistence_supported()?;
    if targets.is_empty() {
        return Err(CoreError::Config(
            "live qualification requires at least one host-owned target".into(),
        ));
    }
    let members = targets.iter().map(|target| target.member.clone()).collect();
    let mut input = live_input_shell(members, observed_at)?;
    let mut failures = Vec::new();

    for (index, target) in targets.iter().enumerate() {
        let attempt_id = format!("live-qualification-attempt-{}", index + 1);
        if cancel.load(Ordering::SeqCst) {
            failures.push(live_failure(
                &attempt_id,
                target.member.role,
                "cancelled_before_dispatch",
            ));
            input.attempts.push(AttemptRecord {
                attempt_id: attempt_id.clone(),
                role: target.member.role,
                model_id: target.member.model_id.clone(),
                profile_id: target.member.profile_id.clone(),
                endpoint_fingerprint: target.member.endpoint_fingerprint.clone(),
                status: AttemptStatus::Cancelled,
                completion_claimed: false,
                claims: Vec::new(),
                tool_calls: Vec::new(),
                citations: Vec::new(),
                latency_ms: 0,
                resource_units: 0,
            });
            continue;
        }
        let request = live_request(&target.member.model_id, &input)?;
        let mut transport = LiveQualificationTransport::new(
            target.backend,
            target.base_url.clone(),
            target.api_key.clone(),
            target.local_only,
        )
        .with_extra_headers(target.extra_headers.clone());
        let started = Instant::now();
        let response = match transport.chat_complete(&request, cancel) {
            Ok(response) => response,
            Err(error) => SyntheticChatResponse {
                raw_error: Some(error.reason),
                ..SyntheticChatResponse::default()
            },
        };
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let (attempt, failure) =
            attempt_from_response(target, &attempt_id, &input, response, elapsed_ms);
        if let Some(failure) = failure {
            failures.push(failure);
        }
        input.attempts.push(attempt);
    }

    Ok(LiveQualificationExecutionResult {
        result: cd_workflow::investigation_team_qualification::execute(input)?,
        failures,
    })
}

fn member_for_profile(
    profile: &cd_core::providers::ProviderProfile,
    role: InvestigationTeamRole,
    model_override: Option<&str>,
) -> CoreResult<MemberBinding> {
    let model = model_override.unwrap_or(&profile.chat_model);
    MemberBinding::from_deployment(role, &profile.id, model, &profile.base_url)
        .map_err(|error| CoreError::Config(format!("invalid team member: {error}")))
}

/// Derive the representable V1 role set from trusted persisted settings.
/// Contribution roles beyond the V1 role vocabulary fail closed instead of
/// being relabeled as a different role.
pub fn members_from_config(cfg: &AppConfig) -> CoreResult<Vec<MemberBinding>> {
    let mode = if cfg.contributions.enabled {
        cd_core::multi_model::MultiModelMode::Contributions
    } else {
        cfg.multi_model.mode
    };
    let active = cfg
        .providers
        .active()
        .ok_or_else(|| CoreError::Config("no active provider profile is configured".into()))?;
    let investigator_role = if matches!(mode, cd_core::multi_model::MultiModelMode::Single) {
        InvestigationTeamRole::Single
    } else {
        InvestigationTeamRole::Investigator
    };
    let mut members = vec![member_for_profile(active, investigator_role, None)?];

    match mode {
        cd_core::multi_model::MultiModelMode::Single => {}
        cd_core::multi_model::MultiModelMode::Review => {
            let reviewer = cfg.multi_model.reviewer.as_ref().ok_or_else(|| {
                CoreError::Config("review mode has no configured reviewer profile".into())
            })?;
            let profile = cfg
                .providers
                .profiles
                .iter()
                .find(|candidate| candidate.id == reviewer.profile_id)
                .ok_or_else(|| {
                    CoreError::Config(format!(
                        "reviewer profile is not present: {}",
                        reviewer.profile_id
                    ))
                })?;
            members.push(member_for_profile(
                profile,
                InvestigationTeamRole::Reviewer,
                reviewer.model.as_deref(),
            )?);
        }
        cd_core::multi_model::MultiModelMode::Contributions => {
            return Err(CoreError::Config(
                "synthetic qualification V1 does not yet represent contribution-role topology; use the host qualification report after a real bounded run".into(),
            ));
        }
    }
    Ok(members)
}

#[cfg(test)]
mod synthetic_tests {
    use super::*;

    fn member(role: InvestigationTeamRole, profile: &str, model: &str) -> MemberBinding {
        MemberBinding::from_deployment(role, profile, model, "https://synthetic.example.test/v1")
            .expect("member")
    }

    fn live_target(role: InvestigationTeamRole) -> LiveQualificationTarget {
        LiveQualificationTarget {
            member: member(role, "p-a", "m-a"),
            backend: LiveBackendKind::OpenAiCompatible,
            base_url: "https://synthetic.example.test/v1".into(),
            api_key: None,
            extra_headers: Vec::new(),
            local_only: false,
        }
    }

    #[test]
    fn completed_fixture_is_qualified_and_redacted() {
        let result = execute_synthetic(
            vec![
                member(InvestigationTeamRole::Investigator, "p-a", "m-a"),
                member(InvestigationTeamRole::Reviewer, "p-a", "m-a"),
            ],
            1_777_000_000,
        )
        .expect("synthetic qualification");
        assert_eq!(result.status, QualificationStatus::Qualified);
        assert!(!result.redacted_json.contains("synthetic.example"));
        assert!(!result.redacted_json.contains("contract witness"));
        assert_eq!(result.report.fingerprint.members.len(), 2);
        let dto = InvestigationTeamQualificationDto::from(result);
        assert_eq!(dto.members.len(), 2);
        assert_eq!(dto.members[0].profile_id, "p-a");
        assert_eq!(dto.members[1].model_id, "m-a");
    }

    #[test]
    fn partial_and_stale_modes_are_not_presented_as_qualified() {
        let partial = cd_workflow::investigation_team_qualification::execute(
            synthetic_input(
                vec![member(InvestigationTeamRole::Single, "p-a", "m-a")],
                1_777_000_000,
                SyntheticQualificationMode::Partial,
            )
            .expect("partial input"),
        )
        .expect("partial result");
        assert_eq!(partial.status, QualificationStatus::Partial);

        let stale = cd_workflow::investigation_team_qualification::execute(
            synthetic_input(
                vec![member(InvestigationTeamRole::Single, "p-a", "m-a")],
                1_777_000_000,
                SyntheticQualificationMode::Stale,
            )
            .expect("stale input"),
        )
        .expect("stale result");
        assert_eq!(stale.status, QualificationStatus::Stale);
    }

    #[test]
    fn empty_members_and_non_positive_time_fail_closed() {
        assert!(synthetic_input(
            Vec::new(),
            1_777_000_000,
            SyntheticQualificationMode::Completed
        )
        .is_err());
        assert!(synthetic_input(
            vec![member(InvestigationTeamRole::Single, "p-a", "m-a")],
            0,
            SyntheticQualificationMode::Completed
        )
        .is_err());
    }

    #[test]
    fn duplicate_roles_are_rejected_by_the_shipped_core() {
        let result = cd_workflow::investigation_team_qualification::execute(
            synthetic_input(
                vec![
                    member(InvestigationTeamRole::Single, "p-a", "m-a"),
                    member(InvestigationTeamRole::Single, "p-b", "m-b"),
                ],
                1_777_000_000,
                SyntheticQualificationMode::Completed,
            )
            .expect("input construction"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn live_response_maps_to_exact_host_citation_without_exposing_truth() {
        let mut target = live_target(InvestigationTeamRole::Single);
        target.api_key = Some("provider-secret".into());
        target.extra_headers = vec![("x-private-header".into(), "private-value".into())];
        let input =
            live_input_shell(vec![target.member.clone()], 1_777_000_000).expect("live input");
        let (attempt, failure) = attempt_from_response(
            &target,
            "live-qualification-attempt-1",
            &input,
            SyntheticChatResponse {
                content: r#"{"claims":[{"text":"opaque answer","evidence_ids":["live-qualification-evidence-1"]}],"citations":["live-qualification-evidence-1"]}"#.into(),
                ..SyntheticChatResponse::default()
            },
            42,
        );
        assert!(failure.is_none());
        assert_eq!(attempt.status, AttemptStatus::Completed);
        assert_eq!(attempt.citations[0].source_id, LIVE_SOURCE_ID);
        assert_eq!(attempt.citations[0].time_anchor, LIVE_TIME_ANCHOR);
        let mut qualified_input = input;
        qualified_input.attempts.push(attempt);
        let result = cd_workflow::investigation_team_qualification::execute(qualified_input)
            .expect("live-shaped input");
        assert_eq!(result.status, QualificationStatus::Qualified);
        assert!(!result.redacted_json.contains(LIVE_SOURCE_ID));
        assert!(!result.redacted_json.contains("opaque answer"));
        let dto = InvestigationTeamQualificationDto::from(result);
        let renderer_wire = serde_json::to_string(&dto).expect("renderer DTO");
        assert!(!renderer_wire.contains("synthetic.example.test"));
        assert!(!renderer_wire.contains("provider-secret"));
        assert!(!renderer_wire.contains("x-private-header"));
        assert_eq!(dto.members.len(), 1);
        assert!(dto.members[0].endpoint_fingerprint.len() >= 64);
    }

    #[test]
    fn live_request_contains_only_opaque_packet_and_strict_wire_mode() {
        let target = live_target(InvestigationTeamRole::Single);
        let input = live_input_shell(vec![target.member], 1_777_000_000).expect("live input");
        let request = live_request("m-a", &input).expect("live request");
        let wire = request
            .messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(request.chat_mode, OpenAiChatRequestMode::PromptedJson);
        assert!(wire.contains(LIVE_EVIDENCE_ID));
        assert!(!wire.contains(LIVE_SOURCE_ID));
        assert!(!wire.contains(LIVE_TIME_ANCHOR));
        assert!(!wire.contains("required_evidence_ids"));
    }

    #[test]
    fn live_transport_failure_and_cancellation_keep_measured_incomplete_attempts() {
        let target = live_target(InvestigationTeamRole::Single);
        let input =
            live_input_shell(vec![target.member.clone()], 1_777_000_000).expect("live input");
        let (failed, failure) = attempt_from_response(
            &target,
            "live-qualification-attempt-1",
            &input,
            SyntheticChatResponse {
                raw_error: Some("provider unavailable".into()),
                ..SyntheticChatResponse::default()
            },
            17,
        );
        assert_eq!(failed.status, AttemptStatus::Failed);
        assert_eq!(failed.latency_ms, 17);
        assert!(failed.resource_units > 0);
        assert_eq!(failure.expect("failure").reason, "provider_request_failed");

        let (cancelled, failure) = attempt_from_response(
            &target,
            "live-qualification-attempt-2",
            &input,
            SyntheticChatResponse {
                cancelled: true,
                ..SyntheticChatResponse::default()
            },
            3,
        );
        assert_eq!(cancelled.status, AttemptStatus::Cancelled);
        assert!(!cancelled.completion_claimed);
        assert_eq!(
            failure.expect("cancellation").role,
            InvestigationTeamRole::Single
        );
    }

    #[test]
    fn live_unknown_citation_is_failed_and_visible() {
        let target = live_target(InvestigationTeamRole::Single);
        let input =
            live_input_shell(vec![target.member.clone()], 1_777_000_000).expect("live input");
        let (attempt, failure) = attempt_from_response(
            &target,
            "live-qualification-attempt-1",
            &input,
            SyntheticChatResponse {
                content: r#"{"claims":[],"citations":["not-in-packet"]}"#.into(),
                ..SyntheticChatResponse::default()
            },
            42,
        );
        assert_eq!(attempt.status, AttemptStatus::Failed);
        assert_eq!(
            failure.expect("failure").reason,
            "unknown_evidence_citation"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn measured_result(observed_at: i64) -> QualificationExecutionResult {
        execute_synthetic(
            vec![MemberBinding::from_deployment(
                InvestigationTeamRole::Single,
                "profile-a",
                "model-a",
                "https://qualification.example.test/v1",
            )
            .expect("member")],
            observed_at,
        )
        .expect("result")
    }

    #[test]
    fn store_is_empty_until_trusted_code_publishes() {
        let store = InvestigationTeamQualificationStore::default();
        assert!(store.latest().is_none());
    }

    #[test]
    fn clear_is_idempotent() {
        let mut store = InvestigationTeamQualificationStore::default();
        assert!(!store.clear());
        assert!(!store.clear());
    }

    #[cfg(unix)]
    fn owner_tempdir() -> tempfile::TempDir {
        let root = std::env::temp_dir()
            .canonicalize()
            .expect("canonical temp root");
        let directory = tempfile::Builder::new()
            .prefix("contextdesk-qualification-store-")
            .tempdir_in(root)
            .expect("tempdir");
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .expect("owner-only tempdir");
        directory
    }

    #[cfg(unix)]
    fn populated_store() -> InvestigationTeamQualificationStore {
        let mut store = InvestigationTeamQualificationStore::default();
        store
            .publish(
                measured_result(1_777_000_000),
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .expect("publish");
        store
    }

    #[cfg(unix)]
    #[test]
    fn measured_history_survives_save_and_load_and_is_preferred_over_synthetic() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut store = InvestigationTeamQualificationStore::default();
        let measured = store
            .publish(
                measured_result(1_777_000_000),
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .expect("measured");
        assert_eq!(
            measured.run_kind,
            InvestigationTeamQualificationRunKind::Measured
        );
        store
            .publish(
                measured_result(1_777_000_100),
                InvestigationTeamQualificationRunKind::Synthetic,
                Vec::new(),
            )
            .expect("synthetic");
        store.save(&path).expect("save");

        let reopened = InvestigationTeamQualificationStore::load(&path).expect("load");
        assert_eq!(reopened.history().len(), 2);
        assert_eq!(
            reopened.latest().expect("latest").run_kind,
            InvestigationTeamQualificationRunKind::Measured,
            "provider-free wiring evidence must not replace measured evidence",
        );
    }

    #[test]
    fn tampered_status_and_unsafe_failure_summary_fail_closed() {
        let mut result = measured_result(1_777_000_000);
        result.status = QualificationStatus::Failed;
        let mut store = InvestigationTeamQualificationStore::default();
        assert!(store
            .publish(
                result,
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .is_err());

        for unsafe_reason in [
            "https://private-gateway.invalid/failure",
            "api_key=private-value",
            "provider request failed with private host details",
        ] {
            let result = measured_result(1_777_000_000);
            let role = result.report.attempts[0].role;
            let attempt_id = result.report.attempts[0].attempt_id.clone();
            assert!(store
                .publish(
                    result,
                    InvestigationTeamQualificationRunKind::Measured,
                    vec![InvestigationTeamAttemptFailureDto {
                        attempt_id,
                        role,
                        reason: unsafe_reason.into(),
                    }],
                )
                .is_err());
        }

        let result = measured_result(1_777_000_001);
        let role = result.report.attempts[0].role;
        let attempt_id = result.report.attempts[0].attempt_id.clone();
        store
            .publish(
                result,
                InvestigationTeamQualificationRunKind::Measured,
                vec![InvestigationTeamAttemptFailureDto {
                    attempt_id,
                    role,
                    reason: "provider_request_failed".into(),
                }],
            )
            .expect("known safe failure code");
    }

    #[cfg(unix)]
    #[test]
    fn missing_store_is_empty_history() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let loaded = InvestigationTeamQualificationStore::load(&path).expect("missing load");
        assert!(loaded.latest().is_none());
        assert!(loaded.history().is_empty());
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn state_preserves_unavailable_history_until_the_owner_store_is_repaired() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        std::fs::write(&path, b"{malformed")
            .expect("write malformed synthetic store");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("secure malformed synthetic store");

        let mut state = InvestigationTeamQualificationStoreState::from_load_result(
            InvestigationTeamQualificationStore::load(&path),
        );
        assert!(state.store().is_err());
        assert!(state.reload_for_operation(&path).is_err());
        assert_eq!(std::fs::read(&path).expect("preserved bytes"), b"{malformed");

        std::fs::remove_file(&path).expect("operator removes invalid synthetic store");
        let recovered = state
            .reload_for_operation(&path)
            .expect("missing store recovers to empty history");
        assert!(recovered.history().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn exact_save_reload_and_clear_reload_round_trip() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut store = populated_store();
        store.save(&path).expect("save");
        let reopened = InvestigationTeamQualificationStore::load(&path).expect("load");
        assert_eq!(reopened, store);
        assert_eq!(
            std::fs::symlink_metadata(&path)
                .expect("store metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::symlink_metadata(directory.path())
                .expect("parent metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        let mut cleared = reopened;
        assert!(cleared.clear());
        cleared.save(&path).expect("clear save");
        let after_clear = InvestigationTeamQualificationStore::load(&path).expect("clear load");
        assert!(after_clear.latest().is_none());
        assert!(after_clear.history().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn save_does_not_use_predictable_shared_temp() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let predictable = directory
            .path()
            .join("investigation-team-qualifications.json.tmp");
        std::fs::write(&predictable, b"do not touch").expect("predictable sentinel");
        populated_store().save(&path).expect("save");
        assert_eq!(
            std::fs::read(&predictable).expect("sentinel"),
            b"do not touch"
        );
        let leftovers: Vec<_> = std::fs::read_dir(directory.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.ends_with(".tmp") && name != "investigation-team-qualifications.json.tmp"
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "unique temps must be renamed away: {leftovers:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn load_and_save_reject_symlink_store_and_parent() {
        use std::os::unix::fs::symlink;

        let directory = owner_tempdir();
        let target = directory.path().join("target.json");
        std::fs::write(&target, b"sentinel").expect("target");
        let store_link = directory
            .path()
            .join("investigation-team-qualifications.json");
        symlink(&target, &store_link).expect("store symlink");
        assert!(InvestigationTeamQualificationStore::load(&store_link).is_err());
        assert!(populated_store().save(&store_link).is_err());
        assert_eq!(std::fs::read(&target).expect("unchanged"), b"sentinel");

        let parent_link = directory.path().join("parent-link");
        symlink(directory.path(), &parent_link).expect("parent symlink");
        let aliased = parent_link.join("investigation-team-qualifications.json");
        assert!(InvestigationTeamQualificationStore::load(&aliased).is_err());
        assert!(populated_store().save(&aliased).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn load_and_save_reject_directory_store_path() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        std::fs::create_dir(&path).expect("directory store");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).expect("0700");
        assert!(InvestigationTeamQualificationStore::load(&path).is_err());
        assert!(populated_store().save(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_permissions_are_rejected_and_home_is_never_chmodded() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut store = populated_store();
        store.save(&path).expect("save");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).expect("0640");
        assert!(InvestigationTeamQualificationStore::load(&path).is_err());
        store.save(&path).expect("save tightens owned store file");
        assert_eq!(
            std::fs::symlink_metadata(&path)
                .expect("tightened store")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        InvestigationTeamQualificationStore::load(&path).expect("load after store tighten");

        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o750))
            .expect("0750 parent");
        assert!(InvestigationTeamQualificationStore::load(&path).is_err());
        store.save(&path).expect("save tightens owned parent");
        assert_eq!(
            std::fs::symlink_metadata(directory.path())
                .expect("tightened parent")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );

        if let Some(home) = dirs::home_dir() {
            let before = std::fs::symlink_metadata(&home)
                .ok()
                .map(|metadata| metadata.permissions().mode());
            let home_store = home.join("investigation-team-qualifications.json");
            assert!(populated_store().save(&home_store).is_err());
            let after = std::fs::symlink_metadata(&home)
                .ok()
                .map(|metadata| metadata.permissions().mode());
            assert_eq!(before, after, "HOME mode must remain unchanged");
            assert!(!home_store.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn malformed_and_trailing_bytes_fail_closed() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        populated_store().save(&path).expect("save");
        let mut bytes = std::fs::read(&path).expect("read");
        bytes.extend_from_slice(b"\n{\"trailing\":true}");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("writable");
        std::fs::write(&path, &bytes).expect("trailing");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("0600");
        let trailing =
            InvestigationTeamQualificationStore::load(&path).expect_err("trailing bytes");
        assert!(trailing.to_string().contains("trailing"), "{trailing}");

        std::fs::write(&path, b"{not-json").expect("malformed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("0600");
        assert!(InvestigationTeamQualificationStore::load(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replacement_identity_change_fails_without_committing() {
        let root = owner_tempdir();
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).expect("parent");
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).expect("0700");
        let path = parent.join("investigation-team-qualifications.json");
        let mut original = populated_store();
        original.save(&path).expect("original");
        let moved = root.path().join("moved-parent");
        let error = original
            .save_unix(
                &path,
                |_| {
                    std::fs::rename(&parent, &moved)?;
                    std::fs::create_dir(&parent)?;
                    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))?;
                    Ok(())
                },
                sync_parent_directory,
            )
            .expect_err("identity change");
        assert!(error.to_string().contains("identity changed"), "{error}");
        assert!(!path.exists(), "replacement parent must receive no store");
        assert_eq!(
            InvestigationTeamQualificationStore::load(
                &moved.join("investigation-team-qualifications.json")
            )
            .expect("original retained"),
            original
        );
    }

    #[cfg(unix)]
    #[test]
    fn load_after_path_swap_reads_opened_inode_or_fails_closed() {
        use std::os::unix::fs::symlink;

        let mut expected = populated_store();
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        expected.save(&path).expect("save");
        let moved = directory.path().join("opened-original.json");
        let attacker = directory.path().join("attacker.json");
        std::fs::write(&attacker, b"{\"schema\":\"attacker\"}").expect("attacker");
        std::fs::set_permissions(&attacker, std::fs::Permissions::from_mode(0o600)).expect("0600");

        let loaded = InvestigationTeamQualificationStore::load_unix(&path, |opened_path| {
            std::fs::rename(opened_path, &moved).expect("move opened inode");
            symlink(&attacker, opened_path).expect("swap to symlink");
        });
        match loaded {
            Ok(loaded) => assert_eq!(loaded, expected),
            Err(error) => assert!(
                error.to_string().contains("changed") || error.to_string().contains("symlink"),
                "path swap must fail closed or read the opened inode: {error}"
            ),
        }
        assert!(InvestigationTeamQualificationStore::load(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_writer_lock_fails_closed_and_is_restart_safe() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut store = populated_store();
        store.save(&path).expect("first save");
        let lock_path = directory
            .path()
            .join(".investigation-team-qualifications.json.lock");
        let lock = std::fs::File::open(&lock_path).expect("open lock");
        lock.try_lock().expect("hold lock");
        let error = store.save(&path).expect_err("locked writer");
        assert!(error.to_string().contains("locked"), "{error}");
        drop(lock);
        store.save(&path).expect("lock released");
    }

    #[cfg(unix)]
    #[test]
    fn stale_sequential_writer_fails_cas_without_losing_newer_history() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut initial = populated_store();
        initial.save(&path).expect("initial save");

        let mut first = InvestigationTeamQualificationStore::load(&path).expect("first load");
        let mut stale = InvestigationTeamQualificationStore::load(&path).expect("stale load");
        first
            .publish(
                measured_result(1_777_000_100),
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .expect("first publish");
        first.save(&path).expect("first writer");

        stale
            .publish(
                measured_result(1_777_000_200),
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .expect("stale publish");
        let error = stale.save(&path).expect_err("stale writer");
        assert!(error.to_string().contains("revision changed"), "{error}");
        assert_eq!(
            InvestigationTeamQualificationStore::load(&path).expect("preserved newer history"),
            first
        );
    }

    #[cfg(unix)]
    #[test]
    fn malformed_current_store_fails_cas_without_replacement() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut loaded = populated_store();
        loaded.save(&path).expect("initial save");
        let malformed = b"{synthetic-malformed-history";
        std::fs::write(&path, malformed).expect("inject malformed history");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("0600");

        loaded
            .publish(
                measured_result(1_777_000_100),
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .expect("publish in memory");
        let error = loaded.save(&path).expect_err("malformed current store");
        assert!(error.to_string().contains("malformed"), "{error}");
        assert_eq!(std::fs::read(&path).expect("unchanged bytes"), malformed);
    }

    #[cfg(unix)]
    #[test]
    fn post_publication_sync_failure_restores_exact_prior_revision_and_bytes() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut original = populated_store();
        original.save(&path).expect("initial save");
        let prior_bytes = std::fs::read(&path).expect("prior bytes");

        let mut candidate =
            InvestigationTeamQualificationStore::load(&path).expect("candidate load");
        let prior_revision = candidate.expected_revision.clone();
        candidate
            .publish(
                measured_result(1_777_000_300),
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .expect("candidate publish");

        let sync_attempts = std::cell::Cell::new(0usize);
        let error = candidate
            .save_unix(
                &path,
                |_| Ok(()),
                |owner_directory| {
                    let attempt = sync_attempts.get();
                    sync_attempts.set(attempt + 1);
                    if attempt == 0 {
                        Err(store_error("injected post-publication sync failure"))
                    } else {
                        sync_parent_directory(owner_directory)
                    }
                },
            )
            .expect_err("publication sync failure");
        assert!(
            error
                .to_string()
                .contains("injected post-publication sync failure"),
            "{error}"
        );
        assert_eq!(sync_attempts.get(), 2, "rollback must be durably synced");
        assert_eq!(std::fs::read(&path).expect("restored bytes"), prior_bytes);
        assert_eq!(candidate.expected_revision, prior_revision);
        let restored = InvestigationTeamQualificationStore::load(&path).expect("restored store");
        assert_eq!(restored.expected_revision, prior_revision);
        assert_eq!(restored, original);
    }

    #[cfg(unix)]
    #[test]
    fn destination_swap_before_atomic_replace_fails_without_overwriting_newer_store() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut original = populated_store();
        original.save(&path).expect("initial save");

        let mut candidate =
            InvestigationTeamQualificationStore::load(&path).expect("candidate load");
        candidate
            .publish(
                measured_result(1_777_000_300),
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .expect("candidate publish");

        let mut newer = InvestigationTeamQualificationStore::load(&path).expect("newer load");
        newer
            .publish(
                measured_result(1_777_000_400),
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .expect("newer publish");
        let newer_bytes = serde_json::to_vec_pretty(&newer).expect("newer bytes");
        let replacement = directory.path().join("synthetic-newer-store.json");
        std::fs::write(&replacement, &newer_bytes).expect("write newer store");
        std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o600))
            .expect("newer 0600");
        let displaced = directory.path().join("synthetic-displaced-store.json");

        let error = candidate
            .save_unix(
                &path,
                |destination| {
                    std::fs::rename(destination, &displaced)?;
                    std::fs::rename(&replacement, destination)?;
                    Ok(())
                },
                sync_parent_directory,
            )
            .expect_err("destination swap");
        assert!(error.to_string().contains("destination"), "{error}");
        assert_eq!(
            std::fs::read(&path).expect("newer bytes retained"),
            newer_bytes
        );
        assert_eq!(
            InvestigationTeamQualificationStore::load(&path).expect("newer store retained"),
            InvestigationTeamQualificationStore::decode(&newer_bytes).expect("decode newer")
        );
    }

    #[cfg(unix)]
    #[test]
    fn lock_path_swap_fails_before_destination_replacement() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut original = populated_store();
        original.save(&path).expect("initial save");
        let prior_bytes = std::fs::read(&path).expect("prior bytes");

        let mut candidate =
            InvestigationTeamQualificationStore::load(&path).expect("candidate load");
        candidate
            .publish(
                measured_result(1_777_000_300),
                InvestigationTeamQualificationRunKind::Measured,
                Vec::new(),
            )
            .expect("candidate publish");
        let lock_path = directory
            .path()
            .join(".investigation-team-qualifications.json.lock");
        let displaced_lock = directory.path().join("synthetic-displaced.lock");
        let replacement_domain = std::cell::RefCell::new(None);

        let error = candidate
            .save_unix(
                &path,
                |_| {
                    std::fs::rename(&lock_path, &displaced_lock)?;
                    let replacement = std::fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&lock_path)?;
                    replacement.set_permissions(std::fs::Permissions::from_mode(0o600))?;
                    replacement.try_lock().map_err(|_| {
                        store_error("synthetic replacement lock domain could not be acquired")
                    })?;
                    replacement_domain.replace(Some(replacement));
                    Ok(())
                },
                sync_parent_directory,
            )
            .expect_err("lock path swap");
        assert!(error.to_string().contains("write lock"), "{error}");
        assert!(
            replacement_domain.borrow().is_some(),
            "the replacement pathname formed a second cooperating lock domain"
        );
        assert_eq!(
            std::fs::read(&path).expect("prior bytes retained"),
            prior_bytes
        );
        assert_eq!(
            InvestigationTeamQualificationStore::load(&path).expect("original retained"),
            original
        );
    }

    #[cfg(unix)]
    #[test]
    fn interrupted_write_preserves_the_original_store() {
        let directory = owner_tempdir();
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        let mut original = populated_store();
        original.save(&path).expect("original");
        let mut next = InvestigationTeamQualificationStore::load(&path).expect("next load");
        assert!(next.clear());
        next.publish(
            measured_result(1_777_000_200),
            InvestigationTeamQualificationRunKind::Synthetic,
            Vec::new(),
        )
        .expect("next");
        next.save_unix(
            &path,
            |_| Err(store_error("injected interrupt")),
            sync_parent_directory,
        )
        .expect_err("interrupted");
        assert_eq!(
            InvestigationTeamQualificationStore::load(&path).expect("original preserved"),
            original
        );
        let leftovers: Vec<_> = std::fs::read_dir(directory.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "failed save must remove unique temps");
    }

    #[cfg(not(unix))]
    #[test]
    fn persistence_fails_closed_before_any_file_use() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory
            .path()
            .join("investigation-team-qualifications.json");
        assert!(InvestigationTeamQualificationStore::load(&path).is_err());
        let mut store = populated_store_unavailable();
        assert!(store.save(&path).is_err());
        assert!(!path.exists());
    }

    #[cfg(not(unix))]
    #[test]
    fn live_provider_work_is_capability_gated_before_dispatch() {
        let target = LiveQualificationTarget {
            member: MemberBinding::from_deployment(
                InvestigationTeamRole::Single,
                "synthetic-profile",
                "synthetic-model",
                "https://qualification.example.test/v1",
            )
            .expect("synthetic member"),
            backend: LiveBackendKind::OpenAiCompatible,
            base_url: "https://qualification.example.test/v1".into(),
            api_key: None,
            extra_headers: Vec::new(),
            local_only: false,
        };
        let error = execute_live(vec![target], 1_777_000_000, &AtomicBool::new(false))
            .expect_err("unsupported persistence must gate before transport");
        assert!(
            error
                .to_string()
                .contains("no supported atomic-replacement and compare-and-swap backend"),
            "{error}"
        );
    }

    #[cfg(not(unix))]
    fn populated_store_unavailable() -> InvestigationTeamQualificationStore {
        InvestigationTeamQualificationStore::default()
    }
}
