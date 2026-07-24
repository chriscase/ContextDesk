//! Human-confirmed, bounded workspace backup planning and execution (#292 / #419).
//!
//! This module is transport-neutral. The trusted host supplies an [`ObjectStore`],
//! a confirmation gate, and a progress observer. Planning never follows symlinks,
//! hashes files in fixed-size chunks, and records every default exclusion.

use crate::object_store::{
    ObjectCancellation, ObjectKey, ObjectOperation, ObjectStore, ObjectStoreError,
    PutObjectOptions, OBJECT_IO_CHUNK_BYTES,
};
use crate::probe::looks_like_secret_filename;
use crate::workspace::Workspace;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};
use thiserror::Error;
use tokio::io::AsyncReadExt;

/// Manifest format written by Phase A.
pub const BACKUP_MANIFEST_VERSION: u32 = 1;

/// Maximum number of files represented by one plan.
pub const MAX_BACKUP_FILES: usize = 100_000;

/// Maximum serialized completed manifest size.
pub const MAX_BACKUP_MANIFEST_BYTES: usize = 32 * 1024 * 1024;

/// Default per-object deadline used by the product executor.
pub const BACKUP_OBJECT_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Non-secret destination identity shown to the user before upload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupDestination {
    /// Endpoint hostname only; never credentials or a URL query.
    pub endpoint_host: String,
    /// Destination bucket.
    pub bucket: String,
    /// Signing region.
    pub region: String,
    /// Optional object namespace prefix.
    pub prefix: String,
}

/// One exclusion category surfaced by planning.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupExclusionReason {
    /// Source-control internals.
    GitInternal,
    /// Build or dependency output.
    BuildOutput,
    /// ContextDesk internal workspace data.
    ContextDeskInternal,
    /// Secret- or credential-shaped filename.
    SecretOrCredential,
    /// Database or log file excluded conservatively.
    InternalStoreOrLog,
    /// Symlinks are never followed by Phase A.
    Symlink,
    /// Symlink resolves outside the authorized root.
    SymlinkEscape,
    /// Filesystem entry could not be read or hashed.
    Unreadable,
    /// Plan reached its explicit file-count bound.
    FileLimit,
}

impl fmt::Display for BackupExclusionReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::GitInternal => "Git internals",
            Self::BuildOutput => "build or dependency output",
            Self::ContextDeskInternal => "ContextDesk internal data",
            Self::SecretOrCredential => "secret or credential-shaped file",
            Self::InternalStoreOrLog => "database or log file",
            Self::Symlink => "symlink (not followed)",
            Self::SymlinkEscape => "symlink escape (rejected)",
            Self::Unreadable => "unreadable entry",
            Self::FileLimit => "backup file limit reached",
        })
    }
}

/// One honestly reported exclusion. Paths are normalized relative display paths.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupExclusion {
    /// Root-qualified relative path; never file contents.
    pub relative_path: String,
    /// Why the entry was excluded.
    pub reason: BackupExclusionReason,
    /// Known excluded bytes, or zero when unavailable/a directory.
    pub bytes: u64,
}

/// Public plan summary used by trusted confirmation and the webview.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupPlanSummary {
    /// Workspace display name.
    pub workspace_name: String,
    /// Exact authorized roots.
    pub roots: Vec<PathBuf>,
    /// Non-secret destination identity.
    pub destination: BackupDestination,
    /// True for a no-write rehearsal.
    pub dry_run: bool,
    /// Included regular files.
    pub file_count: u64,
    /// Included bytes.
    pub bytes: u64,
    /// Excluded/unreadable entries.
    pub excluded_count: u64,
    /// Known excluded bytes.
    pub excluded_bytes: u64,
    /// Exclusions and their reasons.
    pub exclusions: Vec<BackupExclusion>,
}

/// Internal planned file plus manifest-safe metadata.
#[derive(Clone, Debug)]
struct PlannedFile {
    local_path: PathBuf,
    root_index: u32,
    relative_path: String,
    content_sha256: String,
    bytes: u64,
    modified_unix_seconds: Option<i64>,
    object_key: ObjectKey,
}

/// Fully hashed, bounded backup plan.
#[derive(Clone, Debug)]
pub struct WorkspaceBackupPlan {
    summary: BackupPlanSummary,
    workspace_identity: String,
    manifest_key: ObjectKey,
    files: Vec<PlannedFile>,
}

impl WorkspaceBackupPlan {
    /// Public, non-secret summary for confirmation.
    pub fn summary(&self) -> &BackupPlanSummary {
        &self.summary
    }

    /// Stable completed-manifest key.
    pub fn manifest_key(&self) -> &ObjectKey {
        &self.manifest_key
    }
}

/// One entry in a completed Phase A manifest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupManifestEntry {
    /// Zero-based authorized root index.
    pub root_index: u32,
    /// Slash-normalized path relative to that root.
    pub relative_path: String,
    /// SHA-256 of file content.
    pub content_sha256: String,
    /// File byte length.
    pub bytes: u64,
    /// Last-modified Unix seconds captured during planning, when available.
    pub modified_unix_seconds: Option<i64>,
    /// Stable content-addressed remote object key.
    pub object_key: String,
}

/// Completed manifest. A partial run never publishes this object.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupManifest {
    /// Manifest schema version.
    pub format_version: u32,
    /// Stable hash of workspace id (the raw id is not required remotely).
    pub workspace_identity: String,
    /// Included file records in deterministic order.
    pub files: Vec<BackupManifestEntry>,
    /// Timestamp set only when the complete manifest is ready to publish.
    pub completed_at: DateTime<Utc>,
}

/// Progress phase emitted by the tested executor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupProgressPhase {
    /// Planning/hashing has completed and confirmation is next.
    AwaitingConfirmation,
    /// A content body was uploaded.
    Uploaded,
    /// Existing content was reused.
    Skipped,
    /// Completed manifest was published.
    ManifestPublished,
}

/// Redacted progress update. It intentionally contains no local file path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupProgress {
    /// Current phase.
    pub phase: BackupProgressPhase,
    /// Completed file bodies.
    pub completed_files: u64,
    /// Total planned file bodies.
    pub total_files: u64,
    /// Completed file bytes.
    pub completed_bytes: u64,
    /// Total planned file bytes.
    pub total_bytes: u64,
}

/// Final run status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupRunStatus {
    /// User declined the trusted confirmation.
    Declined,
    /// Confirmed dry run completed without writes.
    DryRun,
    /// All bodies and the completed manifest were published.
    Completed,
    /// An operation failed; no new completed manifest was published.
    Failed,
    /// Cancellation completed; no later upload was started.
    Cancelled,
}

/// Redacted failure category suitable for UI and audit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupFailureKind {
    /// Credential failure.
    Authorization,
    /// Endpoint policy rejection.
    EndpointPolicy,
    /// Timeout.
    Timeout,
    /// Transport failure.
    Transport,
    /// Local file became unreadable or changed.
    LocalIo,
    /// Invalid bounded input.
    InvalidInput,
}

/// Uploaded/skipped/excluded/failed byte-and-file totals.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupRunSummary {
    /// Terminal state.
    pub status: BackupRunStatus,
    /// Uploaded file bodies (manifest excluded).
    pub uploaded_files: u64,
    /// Uploaded file bytes.
    pub uploaded_bytes: u64,
    /// Reused file bodies.
    pub skipped_files: u64,
    /// Reused file bytes.
    pub skipped_bytes: u64,
    /// Excluded/unreadable entries.
    pub excluded_files: u64,
    /// Known excluded bytes.
    pub excluded_bytes: u64,
    /// Files that failed in this run.
    pub failed_files: u64,
    /// Bytes associated with failed files.
    pub failed_bytes: u64,
    /// Redacted failure class.
    pub failure: Option<BackupFailureKind>,
}

impl BackupRunSummary {
    fn from_plan(plan: &WorkspaceBackupPlan, status: BackupRunStatus) -> Self {
        Self {
            status,
            uploaded_files: 0,
            uploaded_bytes: 0,
            skipped_files: 0,
            skipped_bytes: 0,
            excluded_files: plan.summary.excluded_count,
            excluded_bytes: plan.summary.excluded_bytes,
            failed_files: 0,
            failed_bytes: 0,
            failure: None,
        }
    }
}

/// Trusted confirmation boundary. Implementations must render a native/trusted prompt.
#[async_trait]
pub trait BackupConfirmationGate: Send + Sync {
    /// Return true only after the user affirmatively approves this exact plan.
    async fn confirm(&self, summary: &BackupPlanSummary) -> bool;
}

/// Observer for redacted progress.
pub trait BackupProgressObserver: Send + Sync {
    /// Receive one progress update.
    fn progress(&self, update: BackupProgress);
}

/// No-op observer for callers that do not need live updates.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopBackupProgress;

impl BackupProgressObserver for NoopBackupProgress {
    fn progress(&self, _update: BackupProgress) {}
}

/// Planning failure. Messages contain no file contents, credentials, or remote bodies.
#[derive(Debug, Error)]
pub enum WorkspaceBackupError {
    /// Workspace/destination/plan policy failed.
    #[error("{0}")]
    Policy(&'static str),
    /// Planning was cancelled.
    #[error("workspace backup cancelled")]
    Cancelled,
}

/// Options used to build one plan.
#[derive(Clone, Debug)]
pub struct BackupPlanOptions {
    /// Non-secret destination identity.
    pub destination: BackupDestination,
    /// Object prefix already validated by the backend configuration.
    pub object_prefix: String,
    /// Product-specific internal workspace directory name, e.g. `.contextdesk`.
    pub workspace_data_dir_name: String,
    /// True for traversal/hash-only mode.
    pub dry_run: bool,
}

/// Traverse and hash a workspace without performing remote I/O.
pub async fn plan_workspace_backup(
    workspace: &Workspace,
    options: BackupPlanOptions,
    cancellation: ObjectCancellation,
) -> Result<WorkspaceBackupPlan, WorkspaceBackupError> {
    if workspace.roots.is_empty() {
        return Err(WorkspaceBackupError::Policy("workspace has no roots"));
    }
    let workspace_identity = sha256_hex(workspace.id.as_bytes());
    let base = backup_base_key(&options.object_prefix, &workspace_identity)?;
    let manifest_key = ObjectKey::parse(format!("{base}/manifests/latest.json"))
        .map_err(|_| WorkspaceBackupError::Policy("invalid backup manifest key"))?;
    let operation = ObjectOperation::new(cancellation);
    let mut files = Vec::new();
    let mut exclusions = Vec::new();

    for (root_index, root) in workspace.roots.iter().enumerate() {
        operation
            .check()
            .map_err(|_| WorkspaceBackupError::Cancelled)?;
        let canonical_root = match root.canonicalize() {
            Ok(root) if root.is_dir() => root,
            _ => {
                exclusions.push(BackupExclusion {
                    relative_path: format!("root-{}", root_index + 1),
                    reason: BackupExclusionReason::Unreadable,
                    bytes: 0,
                });
                continue;
            }
        };
        let mut candidates = Vec::new();
        collect_candidates(
            &canonical_root,
            &canonical_root,
            root_index,
            &options.workspace_data_dir_name,
            &mut candidates,
            &mut exclusions,
            &operation,
        )?;
        candidates.sort();
        for path in candidates {
            if files.len() >= MAX_BACKUP_FILES {
                exclusions.push(BackupExclusion {
                    relative_path: format!("root-{}", root_index + 1),
                    reason: BackupExclusionReason::FileLimit,
                    bytes: 0,
                });
                break;
            }
            operation
                .check()
                .map_err(|_| WorkspaceBackupError::Cancelled)?;
            let relative = match path.strip_prefix(&canonical_root) {
                Ok(relative) => normalize_relative_path(relative),
                Err(_) => None,
            };
            let Some(relative_path) = relative else {
                exclusions.push(BackupExclusion {
                    relative_path: format!("root-{}", root_index + 1),
                    reason: BackupExclusionReason::Unreadable,
                    bytes: 0,
                });
                continue;
            };
            let display_path = format!("root-{}/{}", root_index + 1, relative_path);
            let before = match tokio::fs::metadata(&path).await {
                Ok(metadata) if metadata.is_file() => metadata,
                _ => {
                    exclusions.push(BackupExclusion {
                        relative_path: display_path,
                        reason: BackupExclusionReason::Unreadable,
                        bytes: 0,
                    });
                    continue;
                }
            };
            let (content_sha256, bytes) = match hash_file(&path, &operation).await {
                Ok(value) => value,
                Err(ObjectStoreError::Cancelled | ObjectStoreError::Timeout) => {
                    return Err(WorkspaceBackupError::Cancelled);
                }
                Err(_) => {
                    exclusions.push(BackupExclusion {
                        relative_path: display_path,
                        reason: BackupExclusionReason::Unreadable,
                        bytes: before.len(),
                    });
                    continue;
                }
            };
            let after = match tokio::fs::metadata(&path).await {
                Ok(metadata) => metadata,
                Err(_) => {
                    exclusions.push(BackupExclusion {
                        relative_path: display_path,
                        reason: BackupExclusionReason::Unreadable,
                        bytes,
                    });
                    continue;
                }
            };
            if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
                exclusions.push(BackupExclusion {
                    relative_path: display_path,
                    reason: BackupExclusionReason::Unreadable,
                    bytes,
                });
                continue;
            }
            let object_key = ObjectKey::parse(format!("{base}/objects/{content_sha256}"))
                .map_err(|_| WorkspaceBackupError::Policy("invalid backup object key"))?;
            files.push(PlannedFile {
                local_path: path,
                root_index: root_index as u32,
                relative_path,
                content_sha256,
                bytes,
                modified_unix_seconds: modified_seconds(&after),
                object_key,
            });
        }
    }

    files.sort_by(|a, b| {
        (a.root_index, a.relative_path.as_str()).cmp(&(b.root_index, b.relative_path.as_str()))
    });
    exclusions.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    let bytes = files.iter().map(|file| file.bytes).sum();
    let excluded_bytes = exclusions.iter().map(|item| item.bytes).sum();
    let summary = BackupPlanSummary {
        workspace_name: workspace.name.clone(),
        roots: workspace.roots.clone(),
        destination: options.destination,
        dry_run: options.dry_run,
        file_count: files.len() as u64,
        bytes,
        excluded_count: exclusions.len() as u64,
        excluded_bytes,
        exclusions,
    };
    Ok(WorkspaceBackupPlan {
        summary,
        workspace_identity,
        manifest_key,
        files,
    })
}

/// Confirm and execute a previously built plan.
///
/// The store is never called before an affirmative confirmation. Dry runs never
/// call the store at all. Execution is sequential, which intentionally bounds
/// transfer concurrency to one and buffer memory to the transport chunk size.
pub async fn run_confirmed_workspace_backup(
    store: Arc<dyn ObjectStore>,
    plan: WorkspaceBackupPlan,
    confirmation: &dyn BackupConfirmationGate,
    progress: &dyn BackupProgressObserver,
    cancellation: ObjectCancellation,
) -> BackupRunSummary {
    progress.progress(progress_update(
        &plan,
        BackupProgressPhase::AwaitingConfirmation,
        0,
        0,
    ));
    if !confirmation.confirm(&plan.summary).await {
        return BackupRunSummary::from_plan(&plan, BackupRunStatus::Declined);
    }
    if plan.summary.dry_run {
        return BackupRunSummary::from_plan(&plan, BackupRunStatus::DryRun);
    }

    let mut summary = BackupRunSummary::from_plan(&plan, BackupRunStatus::Completed);
    let operation = ObjectOperation::with_timeout(cancellation.clone(), BACKUP_OBJECT_TIMEOUT);
    let mut completed_files = 0_u64;
    let mut completed_bytes = 0_u64;

    for file in &plan.files {
        if cancellation.is_cancelled() {
            summary.status = BackupRunStatus::Cancelled;
            return summary;
        }
        match store.head(&file.object_key, &operation).await {
            Ok(metadata)
                if metadata.content_length == file.bytes
                    && metadata
                        .content_sha256
                        .as_deref()
                        .is_some_and(|hash| hash.eq_ignore_ascii_case(&file.content_sha256)) =>
            {
                summary.skipped_files += 1;
                summary.skipped_bytes += file.bytes;
                completed_files += 1;
                completed_bytes += file.bytes;
                progress.progress(progress_update(
                    &plan,
                    BackupProgressPhase::Skipped,
                    completed_files,
                    completed_bytes,
                ));
                continue;
            }
            Ok(_) | Err(ObjectStoreError::NotFound) => {}
            Err(error) => {
                mark_failure(&mut summary, &error, file.bytes);
                return summary;
            }
        }
        let mut body = match tokio::fs::File::open(&file.local_path).await {
            Ok(body) => body,
            Err(_) => {
                summary.status = BackupRunStatus::Failed;
                summary.failed_files += 1;
                summary.failed_bytes += file.bytes;
                summary.failure = Some(BackupFailureKind::LocalIo);
                return summary;
            }
        };
        let options = PutObjectOptions {
            content_length: Some(file.bytes),
            content_sha256: Some(file.content_sha256.clone()),
            content_type: Some("application/octet-stream".into()),
        };
        if let Err(error) = store
            .put(&file.object_key, &mut body, &options, &operation)
            .await
        {
            mark_failure(&mut summary, &error, file.bytes);
            return summary;
        }
        summary.uploaded_files += 1;
        summary.uploaded_bytes += file.bytes;
        completed_files += 1;
        completed_bytes += file.bytes;
        progress.progress(progress_update(
            &plan,
            BackupProgressPhase::Uploaded,
            completed_files,
            completed_bytes,
        ));
    }

    if cancellation.is_cancelled() {
        summary.status = BackupRunStatus::Cancelled;
        return summary;
    }
    let manifest = BackupManifest {
        format_version: BACKUP_MANIFEST_VERSION,
        workspace_identity: plan.workspace_identity.clone(),
        files: plan
            .files
            .iter()
            .map(|file| BackupManifestEntry {
                root_index: file.root_index,
                relative_path: file.relative_path.clone(),
                content_sha256: file.content_sha256.clone(),
                bytes: file.bytes,
                modified_unix_seconds: file.modified_unix_seconds,
                object_key: file.object_key.as_str().to_string(),
            })
            .collect(),
        completed_at: Utc::now(),
    };
    let manifest_bytes = match serde_json::to_vec(&manifest) {
        Ok(bytes) if bytes.len() <= MAX_BACKUP_MANIFEST_BYTES => bytes,
        _ => {
            summary.status = BackupRunStatus::Failed;
            summary.failure = Some(BackupFailureKind::InvalidInput);
            return summary;
        }
    };
    let manifest_hash = sha256_hex(&manifest_bytes);
    let mut manifest_body = std::io::Cursor::new(manifest_bytes);
    let manifest_options = PutObjectOptions {
        content_length: Some(manifest_body.get_ref().len() as u64),
        content_sha256: Some(manifest_hash),
        content_type: Some("application/json".into()),
    };
    if let Err(error) = store
        .put(
            &plan.manifest_key,
            &mut manifest_body,
            &manifest_options,
            &operation,
        )
        .await
    {
        mark_failure(&mut summary, &error, 0);
        summary.failed_files = 0;
        return summary;
    }
    progress.progress(progress_update(
        &plan,
        BackupProgressPhase::ManifestPublished,
        completed_files,
        completed_bytes,
    ));
    summary
}

fn progress_update(
    plan: &WorkspaceBackupPlan,
    phase: BackupProgressPhase,
    completed_files: u64,
    completed_bytes: u64,
) -> BackupProgress {
    BackupProgress {
        phase,
        completed_files,
        total_files: plan.summary.file_count,
        completed_bytes,
        total_bytes: plan.summary.bytes,
    }
}

fn mark_failure(summary: &mut BackupRunSummary, error: &ObjectStoreError, bytes: u64) {
    summary.status = match error {
        ObjectStoreError::Cancelled => BackupRunStatus::Cancelled,
        _ => BackupRunStatus::Failed,
    };
    if summary.status == BackupRunStatus::Failed {
        summary.failed_files += 1;
        summary.failed_bytes += bytes;
        summary.failure = Some(match error {
            ObjectStoreError::Authorization => BackupFailureKind::Authorization,
            ObjectStoreError::EndpointPolicy => BackupFailureKind::EndpointPolicy,
            ObjectStoreError::Timeout => BackupFailureKind::Timeout,
            ObjectStoreError::Transport { .. } => BackupFailureKind::Transport,
            ObjectStoreError::LocalIo => BackupFailureKind::LocalIo,
            ObjectStoreError::NotFound
            | ObjectStoreError::Cancelled
            | ObjectStoreError::InvalidInput { .. } => BackupFailureKind::InvalidInput,
        });
    }
}

fn backup_base_key(
    configured_prefix: &str,
    workspace_identity: &str,
) -> Result<String, WorkspaceBackupError> {
    let prefix = configured_prefix.trim().trim_end_matches('/');
    if !prefix.is_empty() {
        crate::object_store::ObjectPrefix::parse(prefix.to_string())
            .map_err(|_| WorkspaceBackupError::Policy("invalid backup prefix"))?;
    }
    let suffix = format!("contextdesk-backup/v1/workspaces/{workspace_identity}");
    Ok(if prefix.is_empty() {
        suffix
    } else {
        format!("{prefix}/{suffix}")
    })
}

#[allow(clippy::too_many_arguments)]
fn collect_candidates(
    root: &Path,
    dir: &Path,
    root_index: usize,
    workspace_data_dir_name: &str,
    candidates: &mut Vec<PathBuf>,
    exclusions: &mut Vec<BackupExclusion>,
    operation: &ObjectOperation,
) -> Result<(), WorkspaceBackupError> {
    operation
        .check()
        .map_err(|_| WorkspaceBackupError::Cancelled)?;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => {
            exclusions.push(BackupExclusion {
                relative_path: display_relative(root, dir, root_index),
                reason: BackupExclusionReason::Unreadable,
                bytes: 0,
            });
            return Ok(());
        }
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        operation
            .check()
            .map_err(|_| WorkspaceBackupError::Cancelled)?;
        let path = entry.path();
        let display = display_relative(root, &path, root_index);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(_) => {
                exclusions.push(BackupExclusion {
                    relative_path: display,
                    reason: BackupExclusionReason::Unreadable,
                    bytes: 0,
                });
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            let reason = match path.canonicalize() {
                Ok(target) if !target.starts_with(root) => BackupExclusionReason::SymlinkEscape,
                _ => BackupExclusionReason::Symlink,
            };
            exclusions.push(BackupExclusion {
                relative_path: display,
                reason,
                bytes: 0,
            });
            continue;
        }
        if metadata.is_dir() {
            if let Some(reason) = excluded_directory_reason(
                &entry.file_name().to_string_lossy(),
                workspace_data_dir_name,
            ) {
                exclusions.push(BackupExclusion {
                    relative_path: display,
                    reason,
                    bytes: 0,
                });
            } else {
                collect_candidates(
                    root,
                    &path,
                    root_index,
                    workspace_data_dir_name,
                    candidates,
                    exclusions,
                    operation,
                )?;
            }
            continue;
        }
        if !metadata.is_file() {
            exclusions.push(BackupExclusion {
                relative_path: display,
                reason: BackupExclusionReason::Unreadable,
                bytes: 0,
            });
            continue;
        }
        if let Some(reason) = excluded_file_reason(&entry.file_name().to_string_lossy()) {
            exclusions.push(BackupExclusion {
                relative_path: display,
                reason,
                bytes: metadata.len(),
            });
        } else {
            candidates.push(path);
        }
    }
    Ok(())
}

fn excluded_directory_reason(
    name: &str,
    workspace_data_dir_name: &str,
) -> Option<BackupExclusionReason> {
    let lower = name.to_ascii_lowercase();
    if lower == ".git" {
        return Some(BackupExclusionReason::GitInternal);
    }
    if name == workspace_data_dir_name
        || matches!(
            lower.as_str(),
            ".contextdesk" | ".codex" | ".aws" | ".azure" | ".kube" | ".ssh"
        )
    {
        return Some(
            if name == workspace_data_dir_name || lower == ".contextdesk" {
                BackupExclusionReason::ContextDeskInternal
            } else {
                BackupExclusionReason::SecretOrCredential
            },
        );
    }
    if matches!(
        lower.as_str(),
        "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".turbo"
            | "coverage"
            | "__pycache__"
            | ".venv"
            | "venv"
    ) {
        return Some(BackupExclusionReason::BuildOutput);
    }
    None
}

fn excluded_file_reason(name: &str) -> Option<BackupExclusionReason> {
    let lower = name.to_ascii_lowercase();
    if looks_like_secret_filename(name)
        || matches!(
            lower.as_str(),
            ".npmrc"
                | ".pypirc"
                | ".netrc"
                | ".dockerconfigjson"
                | "known_hosts"
                | "authorized_keys"
                | "keychain"
                | "keychain.db"
        )
        || lower.contains("access_token")
        || lower.contains("refresh_token")
        || lower.contains("api_key")
        || lower.contains("secret_key")
    {
        return Some(BackupExclusionReason::SecretOrCredential);
    }
    if lower.ends_with(".sqlite")
        || lower.ends_with(".sqlite3")
        || lower.ends_with(".db")
        || lower.ends_with(".db-wal")
        || lower.ends_with(".db-shm")
        || lower.ends_with(".log")
        || lower.ends_with(".jsonl")
    {
        return Some(BackupExclusionReason::InternalStoreOrLog);
    }
    None
}

fn display_relative(root: &Path, path: &Path, root_index: usize) -> String {
    let relative = path
        .strip_prefix(root)
        .ok()
        .and_then(normalize_relative_path)
        .unwrap_or_else(|| "[unavailable]".into());
    if relative.is_empty() {
        format!("root-{}", root_index + 1)
    } else {
        format!("root-{}/{}", root_index + 1, relative)
    }
}

fn normalize_relative_path(path: &Path) -> Option<String> {
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment.to_str()?;
                if segment.is_empty()
                    || segment == "."
                    || segment == ".."
                    || segment.contains('\\')
                    || segment.chars().any(char::is_control)
                {
                    return None;
                }
                segments.push(segment);
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(segments.join("/"))
}

async fn hash_file(
    path: &Path,
    operation: &ObjectOperation,
) -> Result<(String, u64), ObjectStoreError> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| ObjectStoreError::LocalIo)?;
    let mut hasher = Sha256::new();
    let mut bytes = 0_u64;
    let mut buffer = vec![0_u8; OBJECT_IO_CHUNK_BYTES];
    loop {
        operation.check()?;
        let read = tokio::select! {
            _ = operation.cancellation.cancelled() => return Err(ObjectStoreError::Cancelled),
            read = file.read(&mut buffer) => read.map_err(|_| ObjectStoreError::LocalIo)?,
        };
        if read == 0 {
            break;
        }
        bytes += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((hex_digest(hasher.finalize().as_slice()), bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes).as_slice())
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn modified_seconds(metadata: &std::fs::Metadata) -> Option<i64> {
    let duration = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_secs()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object_store::{InMemoryObjectStore, ObjectMetadata};
    use std::io::Cursor;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncRead, AsyncWrite};

    struct FixedConfirmation {
        decision: bool,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl BackupConfirmationGate for FixedConfirmation {
        async fn confirm(&self, _summary: &BackupPlanSummary) -> bool {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.decision
        }
    }

    #[derive(Default)]
    struct RecordingProgress(std::sync::Mutex<Vec<BackupProgress>>);

    impl BackupProgressObserver for RecordingProgress {
        fn progress(&self, update: BackupProgress) {
            self.0.lock().unwrap().push(update);
        }
    }

    fn destination() -> BackupDestination {
        BackupDestination {
            endpoint_host: "storage.example.com".into(),
            bucket: "backup".into(),
            region: "us-east-1".into(),
            prefix: "team".into(),
        }
    }

    async fn plan(root: &Path, dry_run: bool) -> WorkspaceBackupPlan {
        let workspace = Workspace {
            id: "workspace-1".into(),
            name: "Project".into(),
            roots: vec![root.to_path_buf()],
        };
        plan_workspace_backup(
            &workspace,
            BackupPlanOptions {
                destination: destination(),
                object_prefix: "team".into(),
                workspace_data_dir_name: ".contextdesk".into(),
                dry_run,
            },
            ObjectCancellation::default(),
        )
        .await
        .unwrap()
    }

    async fn get_manifest(store: &dyn ObjectStore, key: &ObjectKey) -> (Vec<u8>, BackupManifest) {
        let mut bytes = Vec::new();
        store
            .get(
                key,
                &mut bytes,
                &ObjectOperation::new(ObjectCancellation::default()),
            )
            .await
            .unwrap();
        let manifest = serde_json::from_slice(&bytes).unwrap();
        (bytes, manifest)
    }

    fn body_keys(store: &InMemoryObjectStore, manifest_key: &ObjectKey) -> Vec<ObjectKey> {
        store
            .keys()
            .into_iter()
            .filter(|key| key != manifest_key)
            .collect()
    }

    #[tokio::test]
    async fn trusted_confirmation_is_required_before_any_upload() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("safe.txt"), "safe").unwrap();
        let plan = plan(dir.path(), false).await;
        let store = Arc::new(InMemoryObjectStore::default());
        let confirmation = FixedConfirmation {
            decision: false,
            calls: AtomicUsize::new(0),
        };
        let summary = run_confirmed_workspace_backup(
            store.clone(),
            plan,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        assert_eq!(summary.status, BackupRunStatus::Declined);
        assert_eq!(confirmation.calls.load(Ordering::SeqCst), 1);
        assert!(store.keys().is_empty());
    }

    #[tokio::test]
    async fn dry_run_traverses_and_hashes_but_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("safe.txt"), "safe").unwrap();
        let plan = plan(dir.path(), true).await;
        assert_eq!(plan.summary.file_count, 1);
        let store = Arc::new(InMemoryObjectStore::default());
        let confirmation = FixedConfirmation {
            decision: true,
            calls: AtomicUsize::new(0),
        };
        let summary = run_confirmed_workspace_backup(
            store.clone(),
            plan,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        assert_eq!(summary.status, BackupRunStatus::DryRun);
        assert!(store.keys().is_empty());
    }

    #[tokio::test]
    async fn first_backup_uploads_safe_files_and_completed_manifest() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha").unwrap();
        std::fs::write(dir.path().join("docs/b.md"), "bravo").unwrap();
        let plan = plan(dir.path(), false).await;
        let manifest_key = plan.manifest_key.clone();
        let store = Arc::new(InMemoryObjectStore::default());
        let confirmation = FixedConfirmation {
            decision: true,
            calls: AtomicUsize::new(0),
        };
        let summary = run_confirmed_workspace_backup(
            store.clone(),
            plan,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        assert_eq!(summary.status, BackupRunStatus::Completed);
        assert_eq!(summary.uploaded_files, 2);
        let (_, manifest) = get_manifest(store.as_ref(), &manifest_key).await;
        assert_eq!(manifest.format_version, BACKUP_MANIFEST_VERSION);
        assert_eq!(manifest.files.len(), 2);
        assert!(manifest
            .files
            .iter()
            .all(|entry| !entry.object_key.is_empty()));
    }

    #[tokio::test]
    async fn unchanged_second_backup_uploads_zero_file_bodies() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha").unwrap();
        let store = Arc::new(InMemoryObjectStore::default());
        let confirmation = FixedConfirmation {
            decision: true,
            calls: AtomicUsize::new(0),
        };
        let first_plan = plan(dir.path(), false).await;
        let manifest_key = first_plan.manifest_key.clone();
        let first = run_confirmed_workspace_backup(
            store.clone(),
            first_plan,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        assert_eq!(first.uploaded_files, 1);
        let body_key = body_keys(&store, &manifest_key).pop().unwrap();
        assert_eq!(store.upload_count(&body_key), 1);

        let second = run_confirmed_workspace_backup(
            store.clone(),
            plan(dir.path(), false).await,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        assert_eq!(second.status, BackupRunStatus::Completed);
        assert_eq!(second.uploaded_files, 0);
        assert_eq!(second.skipped_files, 1);
        assert_eq!(store.upload_count(&body_key), 1);
    }

    #[tokio::test]
    async fn changed_and_new_files_upload_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha").unwrap();
        let store = Arc::new(InMemoryObjectStore::default());
        let confirmation = FixedConfirmation {
            decision: true,
            calls: AtomicUsize::new(0),
        };
        let first_plan = plan(dir.path(), false).await;
        let manifest_key = first_plan.manifest_key.clone();
        let _ = run_confirmed_workspace_backup(
            store.clone(),
            first_plan,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        std::fs::write(dir.path().join("a.txt"), "alpha changed").unwrap();
        std::fs::write(dir.path().join("b.txt"), "bravo").unwrap();
        let second = run_confirmed_workspace_backup(
            store.clone(),
            plan(dir.path(), false).await,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        assert_eq!(second.uploaded_files, 2);
        for key in body_keys(&store, &manifest_key) {
            assert_eq!(store.upload_count(&key), 1);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_escape_is_rejected_and_not_followed() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("escape"),
        )
        .unwrap();
        let plan = plan(root.path(), true).await;
        assert_eq!(plan.summary.file_count, 0);
        assert!(plan.summary.exclusions.iter().any(|item| {
            item.reason == BackupExclusionReason::SymlinkEscape
                && item.relative_path.ends_with("escape")
        }));
    }

    #[tokio::test]
    async fn secret_internal_git_and_build_artifacts_are_excluded() {
        let dir = tempfile::tempdir().unwrap();
        for directory in [".git", "target", "node_modules", ".contextdesk"] {
            std::fs::create_dir_all(dir.path().join(directory)).unwrap();
            std::fs::write(dir.path().join(directory).join("data"), "private").unwrap();
        }
        for file in [".env", "credentials", "memory.sqlite", "app.log"] {
            std::fs::write(dir.path().join(file), "private").unwrap();
        }
        std::fs::write(dir.path().join("safe.txt"), "safe").unwrap();
        let plan = plan(dir.path(), true).await;
        assert_eq!(plan.summary.file_count, 1);
        assert!(plan.summary.excluded_count >= 8);
        let reasons = plan
            .summary
            .exclusions
            .iter()
            .map(|item| item.reason)
            .collect::<Vec<_>>();
        assert!(reasons.contains(&BackupExclusionReason::GitInternal));
        assert!(reasons.contains(&BackupExclusionReason::BuildOutput));
        assert!(reasons.contains(&BackupExclusionReason::ContextDeskInternal));
        assert!(reasons.contains(&BackupExclusionReason::SecretOrCredential));
        assert!(reasons.contains(&BackupExclusionReason::InternalStoreOrLog));
    }

    struct CancelAfterFirstUpload {
        cancellation: ObjectCancellation,
        inner: RecordingProgress,
    }

    impl BackupProgressObserver for CancelAfterFirstUpload {
        fn progress(&self, update: BackupProgress) {
            if update.phase == BackupProgressPhase::Uploaded {
                self.cancellation.cancel();
            }
            self.inner.progress(update);
        }
    }

    #[tokio::test]
    async fn cancellation_stops_future_uploads_before_return() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha").unwrap();
        std::fs::write(dir.path().join("b.txt"), "bravo").unwrap();
        let plan = plan(dir.path(), false).await;
        let manifest_key = plan.manifest_key.clone();
        let store = Arc::new(InMemoryObjectStore::default());
        let confirmation = FixedConfirmation {
            decision: true,
            calls: AtomicUsize::new(0),
        };
        let cancellation = ObjectCancellation::default();
        let progress = CancelAfterFirstUpload {
            cancellation: cancellation.clone(),
            inner: RecordingProgress::default(),
        };
        let summary = run_confirmed_workspace_backup(
            store.clone(),
            plan,
            &confirmation,
            &progress,
            cancellation,
        )
        .await;
        assert_eq!(summary.status, BackupRunStatus::Cancelled);
        assert_eq!(summary.uploaded_files, 1);
        assert_eq!(body_keys(&store, &manifest_key).len(), 1);
        assert!(!store.keys().contains(&manifest_key));
    }

    struct FailOnePut {
        inner: InMemoryObjectStore,
        target: ObjectKey,
        failed: std::sync::atomic::AtomicBool,
    }

    #[async_trait]
    impl ObjectStore for FailOnePut {
        async fn put(
            &self,
            key: &ObjectKey,
            body: &mut (dyn AsyncRead + Unpin + Send),
            options: &PutObjectOptions,
            operation: &ObjectOperation,
        ) -> Result<ObjectMetadata, ObjectStoreError> {
            if key == &self.target && !self.failed.swap(true, Ordering::SeqCst) {
                return Err(ObjectStoreError::transport(Some(503)));
            }
            self.inner.put(key, body, options, operation).await
        }

        async fn get(
            &self,
            key: &ObjectKey,
            sink: &mut (dyn AsyncWrite + Unpin + Send),
            operation: &ObjectOperation,
        ) -> Result<ObjectMetadata, ObjectStoreError> {
            self.inner.get(key, sink, operation).await
        }

        async fn head(
            &self,
            key: &ObjectKey,
            operation: &ObjectOperation,
        ) -> Result<ObjectMetadata, ObjectStoreError> {
            self.inner.head(key, operation).await
        }

        async fn list(
            &self,
            request: &crate::object_store::ListObjectsRequest,
            operation: &ObjectOperation,
        ) -> Result<crate::object_store::ListObjectsPage, ObjectStoreError> {
            self.inner.list(request, operation).await
        }
    }

    #[tokio::test]
    async fn mid_run_failure_preserves_manifest_and_retry_reuses_uploaded_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "alpha").unwrap();
        let base_store = InMemoryObjectStore::default();
        let confirmation = FixedConfirmation {
            decision: true,
            calls: AtomicUsize::new(0),
        };
        let initial_plan = plan(dir.path(), false).await;
        let manifest_key = initial_plan.manifest_key.clone();
        let initial = run_confirmed_workspace_backup(
            Arc::new(base_store.clone()),
            initial_plan,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        assert_eq!(initial.status, BackupRunStatus::Completed);
        let (old_manifest_bytes, _) = get_manifest(&base_store, &manifest_key).await;

        std::fs::write(dir.path().join("a.txt"), "alpha changed").unwrap();
        std::fs::write(dir.path().join("b.txt"), "bravo").unwrap();
        let changed_plan = plan(dir.path(), false).await;
        let fail_target = changed_plan.files[1].object_key.clone();
        let failing = Arc::new(FailOnePut {
            inner: base_store.clone(),
            target: fail_target,
            failed: std::sync::atomic::AtomicBool::new(false),
        });
        let failed = run_confirmed_workspace_backup(
            failing.clone(),
            changed_plan,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        assert_eq!(failed.status, BackupRunStatus::Failed);
        let (still_old, _) = get_manifest(&base_store, &manifest_key).await;
        assert_eq!(still_old, old_manifest_bytes);

        let retry = run_confirmed_workspace_backup(
            failing,
            plan(dir.path(), false).await,
            &confirmation,
            &NoopBackupProgress,
            ObjectCancellation::default(),
        )
        .await;
        assert_eq!(retry.status, BackupRunStatus::Completed);
        assert_eq!(retry.uploaded_files, 1);
        assert_eq!(retry.skipped_files, 1);
        let (_, completed) = get_manifest(&base_store, &manifest_key).await;
        assert_eq!(completed.files.len(), 2);
        for key in body_keys(&base_store, &manifest_key) {
            assert_eq!(base_store.upload_count(&key), 1);
        }
    }

    #[test]
    fn manifest_contains_no_runtime_credentials_or_contents() {
        let manifest = BackupManifest {
            format_version: BACKUP_MANIFEST_VERSION,
            workspace_identity: "identity".into(),
            files: vec![BackupManifestEntry {
                root_index: 0,
                relative_path: "safe.txt".into(),
                content_sha256: "00".repeat(32),
                bytes: 4,
                modified_unix_seconds: None,
                object_key: "objects/hash".into(),
            }],
            completed_at: Utc::now(),
        };
        let text = serde_json::to_string(&manifest).unwrap();
        assert!(!text.contains("access_key"));
        assert!(!text.contains("secret_key"));
        assert!(!text.contains("session_token"));
        assert!(!text.contains("file contents"));
        let _: BackupManifest = serde_json::from_reader(Cursor::new(text)).unwrap();
    }
}
