//! Path/dir ingest orchestration (#355–#359, #362 core) + multi-phase progress (#445).

use super::drain::DrainMiner;
use super::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use super::parse::{detect_format, parse_line, LogFormat};
use super::redact_log::{prepare_original_record, redact_message, redact_params};
use super::store::{
    template_content_hash, CorpusEmbeddingStatus, EmbeddingState, IngestedLogEvent, LogCorpus,
    LogEvent, TemplateRow, TopTemplateSnapshot,
};
use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use crate::memory::embed_blocking;
use crate::process_progress::{
    progress_basename, CancelFlag, NoopProcessProgress, ProcessProgress, ProcessProgressKind,
    ProcessProgressObserver, ProcessProgressPhase,
};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

/// Stats from one ingest run.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestStats {
    /// Files successfully read through EOF and imported.
    pub files: usize,
    /// File entries discovered before policy/read decisions.
    #[serde(default)]
    pub discovered_files: u64,
    /// Files excluded by an explicit policy guard.
    #[serde(default)]
    pub excluded_files: u64,
    /// Files that could not be opened or completely read.
    #[serde(default)]
    pub failed_files: u64,
    /// Entries intentionally ignored (for example hidden files/directories).
    #[serde(default)]
    pub ignored_files: u64,
    /// Counts by stable exclusion/failure reason.
    #[serde(default)]
    pub exclusion_counts: std::collections::BTreeMap<String, u64>,
    /// Bounded basename-only examples (`reason: basename`).
    #[serde(default)]
    pub exclusion_examples: Vec<String>,
    /// True when any discovered content was not fully imported.
    #[serde(default)]
    pub partial: bool,
    /// Lines parsed.
    pub lines: u64,
    /// Distinct templates.
    pub templates: usize,
    /// Template reduction ratio (lines / templates).
    pub reduction_ratio: f64,
    /// Templates newly embedded.
    pub embedded: usize,
    /// Bytes read from source files.
    pub source_bytes: u64,
    /// On-disk corpus footprint after flush.
    pub corpus_bytes: u64,
    /// Counts by normalized level.
    #[serde(default)]
    pub level_counts: std::collections::BTreeMap<String, u64>,
    /// Earliest event ts.
    pub ts_min: Option<i64>,
    /// Latest event ts.
    pub ts_max: Option<i64>,
    /// Counts by parse format.
    #[serde(default)]
    pub format_counts: std::collections::BTreeMap<String, u64>,
}

impl IngestStats {
    /// Convert to persisted [`super::store::CorpusStats`].
    pub fn to_corpus_stats(&self) -> super::store::CorpusStats {
        super::store::CorpusStats {
            files: self.files as u64,
            discovered_files: self.discovered_files,
            excluded_files: self.excluded_files,
            failed_files: self.failed_files,
            ignored_files: self.ignored_files,
            exclusion_counts: self.exclusion_counts.clone(),
            exclusion_examples: self.exclusion_examples.clone(),
            partial: self.partial,
            lines: self.lines,
            templates: self.templates as u64,
            reduction_ratio: self.reduction_ratio,
            embedded: self.embedded as u64,
            source_bytes: self.source_bytes,
            corpus_bytes: self.corpus_bytes,
            level_counts: self.level_counts.clone(),
            ts_min: self.ts_min,
            ts_max: self.ts_max,
            format_counts: self.format_counts.clone(),
        }
    }

    fn discover(&mut self) {
        self.discovered_files = self.discovered_files.saturating_add(1);
    }

    fn imported(&mut self) {
        self.files = self.files.saturating_add(1);
    }

    fn excluded(&mut self, reason: &'static str, source: &Path) {
        self.excluded_files = self.excluded_files.saturating_add(1);
        self.record_omission(reason, source);
    }

    fn failed(&mut self, reason: &'static str, source: &Path) {
        self.failed_files = self.failed_files.saturating_add(1);
        self.record_omission(reason, source);
    }

    fn ignored(&mut self, reason: &'static str, source: &Path) {
        self.ignored_files = self.ignored_files.saturating_add(1);
        self.record_omission(reason, source);
    }

    fn record_omission(&mut self, reason: &'static str, source: &Path) {
        *self.exclusion_counts.entry(reason.into()).or_insert(0) += 1;
        if self.exclusion_examples.len() < MAX_EXCLUSION_EXAMPLES {
            let safe_basename = redact_message(&progress_basename(source));
            self.exclusion_examples
                .push(format!("{reason}: {safe_basename}"));
        }
        self.partial = true;
    }
}

/// Full ingest report.
#[derive(Debug, Clone)]
pub struct IngestReport {
    /// Corpus id.
    pub corpus_id: String,
    /// Stats.
    pub stats: IngestStats,
    /// Top templates by count (for summary UI).
    pub top_templates: Vec<(u64, String, u64, u8)>,
    /// Persisted semantic-vector availability.
    pub embedding: CorpusEmbeddingStatus,
}

/// Ingest a file or directory into a new corpus under `cache_root`.
///
/// Streams line-by-line (bounded memory). `embed` is optional — when present,
/// templates are embedded (content-hash cached). Uses realistic embed budget.
pub fn ingest_path(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
) -> CoreResult<IngestReport> {
    ingest_path_with_observer(
        cache_root,
        path,
        name,
        embed,
        embed_model,
        &NoopProcessProgress,
        None,
    )
}

/// Ingest with multi-phase progress and optional cancel (#445).
pub fn ingest_path_with_observer(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
) -> CoreResult<IngestReport> {
    ingest_path_inner(
        cache_root,
        path,
        name,
        embed,
        embed_model,
        if embed.is_some() {
            LogEmbedMode::Local
        } else {
            LogEmbedMode::None
        },
        None,
        progress,
        cancel,
    )
}

/// Ingest with an explicit [`LogEmbedPolicy`] (#359).
///
/// - **Local:** uses `embed` when provided (host/Ollama/Concept/fastembed).
/// - **Cloud:** requires confirm flag; caller must pass a cloud `EmbedBackend`
///   (secrets stay keychain-side — never in policy).
/// - **None:** skip template embedding.
pub fn ingest_path_with_policy(
    cache_root: &Path,
    path: &Path,
    name: &str,
    policy: &LogEmbedPolicy,
    embed: Option<Arc<dyn EmbedBackend>>,
) -> CoreResult<IngestReport> {
    ingest_path_with_policy_and_observer(
        cache_root,
        path,
        name,
        policy,
        embed,
        &NoopProcessProgress,
        None,
    )
}

/// Policy ingest with progress observer (#445).
pub fn ingest_path_with_policy_and_observer(
    cache_root: &Path,
    path: &Path,
    name: &str,
    policy: &LogEmbedPolicy,
    embed: Option<Arc<dyn EmbedBackend>>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
) -> CoreResult<IngestReport> {
    policy.assert_embed_allowed()?;
    let backend = match policy.mode {
        LogEmbedMode::None => None,
        LogEmbedMode::Local | LogEmbedMode::Cloud => embed,
    };
    if policy.mode == LogEmbedMode::Cloud && backend.is_none() {
        return Err(CoreError::Config(
            "cloud embed mode requires an EmbedBackend (key from keychain)".into(),
        ));
    }
    ingest_path_inner(
        cache_root,
        path,
        name,
        backend.as_deref(),
        policy.model_id.as_str(),
        policy.mode,
        policy.defer_above_source_bytes,
        progress,
        cancel,
    )
}

fn cancelled(cancel: Option<&CancelFlag>) -> bool {
    cancel.map(|c| c.is_cancelled()).unwrap_or(false)
}

fn emit(progress: &dyn ProcessProgressObserver, update: ProcessProgress) {
    progress.progress(update);
}

/// Soft max size per log member before skip (bytes). Overridable via env later.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// Emit parse progress every N lines so one huge file still advances UI.
pub const PROGRESS_EVERY_LINES: u64 = 2_000;

/// Max templates to embed on bulk SoftWrite when embed is enabled (cap).
pub const BULK_EMBED_TEMPLATE_CAP: usize = 256;

/// Maximum basename-only omission examples persisted or sent to the webview.
pub const MAX_EXCLUSION_EXAMPLES: usize = 20;

/// Maximum number of filesystem or archive entries inspected by one raw ingest.
pub const MAX_RAW_LOG_ENTRIES: u64 = 50_000;

/// Maximum aggregate expanded bytes inspected by one raw ingest (4 GiB).
pub const MAX_RAW_LOG_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Maximum bytes in one logical log line, including its line ending (1 MiB).
pub const MAX_RAW_LOG_LINE_BYTES: usize = 1024 * 1024;

/// Compression-ratio checks ignore small members, then reject ratios above 250:1.
pub const MAX_RAW_LOG_COMPRESSION_RATIO: u64 = 250;
const MIN_COMPRESSION_RATIO_CHECK_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy)]
struct RawIngestLimits {
    max_entries: u64,
    max_file_bytes: u64,
    max_expanded_bytes: u64,
    max_line_bytes: usize,
    max_compression_ratio: u64,
    min_compression_ratio_check_bytes: u64,
}

impl Default for RawIngestLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_RAW_LOG_ENTRIES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_expanded_bytes: MAX_RAW_LOG_EXPANDED_BYTES,
            max_line_bytes: MAX_RAW_LOG_LINE_BYTES,
            max_compression_ratio: MAX_RAW_LOG_COMPRESSION_RATIO,
            min_compression_ratio_check_bytes: MIN_COMPRESSION_RATIO_CHECK_BYTES,
        }
    }
}

#[derive(Debug, Default)]
struct RawIngestBudget {
    entries: u64,
    declared_expanded_bytes: u64,
    actual_bytes: u64,
}

impl RawIngestBudget {
    fn add_entries(&mut self, count: u64, limits: RawIngestLimits) -> CoreResult<()> {
        self.entries = self
            .entries
            .checked_add(count)
            .ok_or_else(|| CoreError::Policy("raw log entry count overflow".into()))?;
        if self.entries > limits.max_entries {
            return Err(CoreError::Policy(format!(
                "raw log entry limit exceeded ({} > {})",
                self.entries, limits.max_entries
            )));
        }
        Ok(())
    }

    fn add_declared_bytes(&mut self, count: u64, limits: RawIngestLimits) -> CoreResult<()> {
        self.declared_expanded_bytes = self
            .declared_expanded_bytes
            .checked_add(count)
            .ok_or_else(|| CoreError::Policy("raw log expanded-byte count overflow".into()))?;
        if self.declared_expanded_bytes > limits.max_expanded_bytes {
            return Err(CoreError::Policy(format!(
                "raw log aggregate expanded-byte limit exceeded ({} > {})",
                self.declared_expanded_bytes, limits.max_expanded_bytes
            )));
        }
        Ok(())
    }
}

struct BoundedSourceReader<'a, R> {
    inner: R,
    budget: &'a mut RawIngestBudget,
    member_bytes: u64,
    member_limit: u64,
    aggregate_limit: u64,
    cancel: Option<&'a CancelFlag>,
}

impl<'a, R> BoundedSourceReader<'a, R> {
    fn new(
        inner: R,
        budget: &'a mut RawIngestBudget,
        limits: RawIngestLimits,
        cancel: Option<&'a CancelFlag>,
    ) -> Self {
        Self {
            inner,
            budget,
            member_bytes: 0,
            member_limit: limits.max_file_bytes,
            aggregate_limit: limits.max_expanded_bytes,
            cancel,
        }
    }
}

impl<R: Read> Read for BoundedSourceReader<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if cancelled(self.cancel) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "ingest cancelled during source read",
            ));
        }
        if output.is_empty() {
            return Ok(0);
        }
        let member_remaining = self.member_limit.saturating_sub(self.member_bytes);
        let aggregate_remaining = self
            .aggregate_limit
            .saturating_sub(self.budget.actual_bytes);
        let allowed = output
            .len()
            .min(usize::try_from(member_remaining.saturating_add(1)).unwrap_or(usize::MAX))
            .min(usize::try_from(aggregate_remaining.saturating_add(1)).unwrap_or(usize::MAX));
        let read = self.inner.read(&mut output[..allowed])?;
        if read == 0 {
            return Ok(0);
        }
        let read = read as u64;
        let member_total = self.member_bytes.saturating_add(read);
        let aggregate_total = self.budget.actual_bytes.saturating_add(read);
        if member_total > self.member_limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "raw log member actual-byte limit exceeded",
            ));
        }
        if aggregate_total > self.aggregate_limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "raw log aggregate actual-byte limit exceeded",
            ));
        }
        self.member_bytes = member_total;
        self.budget.actual_bytes = aggregate_total;
        Ok(read as usize)
    }
}

/// Hidden, same-filesystem cache used until a new corpus is fully validated.
///
/// The final `log_corpora/{id}` path does not exist until [`Self::publish`].
/// Dropping this guard after any error or cancellation removes the complete
/// per-run staging tree.
struct IngestStaging {
    parent: PathBuf,
    root: PathBuf,
}

impl IngestStaging {
    fn new(cache_root: &Path) -> CoreResult<Self> {
        let parent = cache_root.join(".log_ingest_staging");
        std::fs::create_dir_all(&parent)?;
        let root = parent.join(Uuid::now_v7().to_string());
        std::fs::create_dir(&root)?;
        Ok(Self { parent, root })
    }

    fn cache_root(&self) -> &Path {
        &self.root
    }

    fn publish(&mut self, cache_root: &Path, corpus_id: &str) -> CoreResult<()> {
        let source = self.root.join("log_corpora").join(corpus_id);
        let corpora_root = cache_root.join("log_corpora");
        let destination = corpora_root.join(corpus_id);
        if destination.exists() {
            return Err(CoreError::Message(format!(
                "refusing to replace existing log corpus {corpus_id}"
            )));
        }
        std::fs::create_dir_all(&corpora_root)?;
        std::fs::rename(&source, &destination)
            .map_err(|e| CoreError::Message(format!("publish log corpus: {e}")))?;
        self.cleanup();
        Ok(())
    }

    fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.root);
        // Concurrent ingests may still own sibling directories.
        let _ = std::fs::remove_dir(&self.parent);
    }
}

impl Drop for IngestStaging {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IngestCheckpoint {
    CorpusCreated,
    EventsStored,
    BeforeTemplates,
    DuringEmbedding,
    BeforeSummary,
    BeforeValidation,
    BeforePublish,
}

type IngestFaultHook<'a> = Option<&'a dyn Fn(IngestCheckpoint) -> CoreResult<()>>;

fn check_ingest_fault(hook: IngestFaultHook<'_>, checkpoint: IngestCheckpoint) -> CoreResult<()> {
    match hook {
        Some(hook) => hook(checkpoint),
        None => Ok(()),
    }
}

fn is_zip_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("zip"))
            .unwrap_or(false)
}

fn open_selected_regular_file(path: &Path) -> CoreResult<std::fs::File> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|e| CoreError::Message(format!("read source metadata: {e}")))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(CoreError::Policy(
            "selected log source is a symlink or non-regular file".into(),
        ));
    }
    let file =
        std::fs::File::open(path).map_err(|e| CoreError::Message(format!("open source: {e}")))?;
    let opened = file
        .metadata()
        .map_err(|e| CoreError::Message(format!("read opened source metadata: {e}")))?;
    if !opened.is_file() {
        return Err(CoreError::Policy(
            "opened log source is not a regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(CoreError::Policy(
                "selected log source changed during secure open".into(),
            ));
        }
    }
    Ok(file)
}

fn has_zip_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

fn has_zip_signature(bytes: &[u8]) -> bool {
    matches!(
        bytes.get(..4),
        Some(b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x07\x08")
    )
}

fn is_hidden_archive_identity(identity: &str) -> bool {
    identity
        .split('/')
        .any(|component| component.starts_with('.'))
}

fn validate_raw_log_zip_entry(name: &str) -> CoreResult<(String, bool)> {
    let directory = name.ends_with('/');
    if name.is_empty()
        || name.starts_with(['/', '\\'])
        || name.contains('\\')
        || name.contains("//")
        || name.contains('\0')
    {
        return Err(CoreError::Policy(
            "raw log zip entry path rejected by policy".into(),
        ));
    }
    let normalized = if directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    if normalized.is_empty()
        || normalized
            .as_bytes()
            .get(1)
            .is_some_and(|byte| *byte == b':')
            && normalized
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
        || normalized
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(CoreError::Policy(
            "raw log zip entry path rejected by policy".into(),
        ));
    }
    Ok((normalized.to_string(), directory))
}

fn portable_source_identity(path: &Path) -> CoreResult<String> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => {
                components.push(value.to_string_lossy().into_owned())
            }
            std::path::Component::CurDir => {}
            _ => {
                return Err(CoreError::Policy(
                    "log source identity escaped its import root".into(),
                ))
            }
        }
    }
    if components.is_empty() {
        return Err(CoreError::Policy(
            "log source identity is empty after normalization".into(),
        ));
    }
    Ok(components.join("/"))
}

fn read_zip_u16(bytes: &[u8], offset: usize) -> CoreResult<u16> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| CoreError::Message("raw log zip metadata is truncated".into()))?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_zip_u32(bytes: &[u8], offset: usize) -> CoreResult<u32> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| CoreError::Message("raw log zip metadata is truncated".into()))?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

/// Validate every central-directory entry before `zip` reads any payload.
///
/// Some ZIP readers collapse duplicate names during open, so checking only the
/// entries returned by `ZipArchive` cannot detect an ambiguous input.
fn preflight_raw_log_zip(
    file: &mut std::fs::File,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
    cancel: Option<&CancelFlag>,
) -> CoreResult<u64> {
    const EOCD_MIN_BYTES: usize = 22;
    const MAX_ZIP_COMMENT_BYTES: usize = u16::MAX as usize;
    const CENTRAL_HEADER_BYTES: usize = 46;
    const MAX_RAW_LOG_ENTRY_NAME_BYTES: usize = 4 * 1024;
    const EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
    const CENTRAL_SIGNATURE: &[u8; 4] = b"PK\x01\x02";

    let compressed_len = file
        .metadata()
        .map_err(|e| CoreError::Message(format!("read zip metadata: {e}")))?
        .len();
    if compressed_len < EOCD_MIN_BYTES as u64 {
        return Err(CoreError::Message("zip open: missing end record".into()));
    }
    let tail_len = usize::try_from(compressed_len)
        .unwrap_or(usize::MAX)
        .min(EOCD_MIN_BYTES + MAX_ZIP_COMMENT_BYTES);
    file.seek(SeekFrom::End(-(tail_len as i64)))
        .map_err(|e| CoreError::Message(format!("seek zip tail: {e}")))?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)
        .map_err(|e| CoreError::Message(format!("read zip tail: {e}")))?;
    let eocd_in_tail = (0..=tail.len().saturating_sub(EOCD_SIGNATURE.len()))
        .rev()
        .find(|position| {
            let position = *position;
            if tail.get(position..position + 4) != Some(EOCD_SIGNATURE) {
                return false;
            }
            let Some(comment) = tail.get(position + 20..position + 22) else {
                return false;
            };
            let comment_len = u16::from_le_bytes([comment[0], comment[1]]) as usize;
            position + EOCD_MIN_BYTES + comment_len == tail.len()
        })
        .ok_or_else(|| CoreError::Message("zip open: missing end record".into()))?;
    let eocd = &tail[eocd_in_tail..];
    let disk = read_zip_u16(eocd, 4)?;
    let central_disk = read_zip_u16(eocd, 6)?;
    let entries_on_disk = read_zip_u16(eocd, 8)?;
    let entries_total = read_zip_u16(eocd, 10)?;
    let central_size = read_zip_u32(eocd, 12)?;
    let central_offset = read_zip_u32(eocd, 16)?;
    if disk != 0 || central_disk != 0 || entries_on_disk != entries_total {
        return Err(CoreError::Policy(
            "multi-disk raw log archives are not supported".into(),
        ));
    }
    if entries_total == u16::MAX || central_size == u32::MAX || central_offset == u32::MAX {
        return Err(CoreError::Policy(
            "Zip64 raw log archive metadata is not supported".into(),
        ));
    }
    budget.add_entries(entries_total as u64, limits)?;
    let central_end = (central_offset as u64)
        .checked_add(central_size as u64)
        .ok_or_else(|| CoreError::Policy("raw log zip central directory overflow".into()))?;
    let absolute_eocd = compressed_len - tail_len as u64 + eocd_in_tail as u64;
    if central_end != absolute_eocd {
        return Err(CoreError::Policy(
            "raw log zip central directory is inconsistent".into(),
        ));
    }

    file.seek(SeekFrom::Start(central_offset as u64))
        .map_err(|e| CoreError::Message(format!("seek zip central directory: {e}")))?;
    let mut names = std::collections::HashSet::with_capacity(entries_total as usize);
    for _ in 0..entries_total {
        if cancelled(cancel) {
            return Err(CoreError::Message(
                "ingest cancelled during zip preflight".into(),
            ));
        }
        let mut header = [0u8; CENTRAL_HEADER_BYTES];
        file.read_exact(&mut header)
            .map_err(|e| CoreError::Message(format!("read zip central directory: {e}")))?;
        if &header[..4] != CENTRAL_SIGNATURE {
            return Err(CoreError::Policy(
                "raw log zip central directory entry is invalid".into(),
            ));
        }
        let name_len = read_zip_u16(&header, 28)? as usize;
        let extra_len = read_zip_u16(&header, 30)? as u64;
        let comment_len = read_zip_u16(&header, 32)? as u64;
        let flags = read_zip_u16(&header, 8)?;
        let compressed_size = read_zip_u32(&header, 20)? as u64;
        let expanded_size = read_zip_u32(&header, 24)? as u64;
        let disk_start = read_zip_u16(&header, 34)?;
        let external_attributes = read_zip_u32(&header, 38)?;
        let local_header_offset = read_zip_u32(&header, 42)?;
        if flags & 1 != 0 || flags & (1 << 6) != 0 {
            return Err(CoreError::Policy(
                "encrypted raw log zip entries are not supported".into(),
            ));
        }
        if compressed_size == u32::MAX as u64
            || expanded_size == u32::MAX as u64
            || local_header_offset == u32::MAX
        {
            return Err(CoreError::Policy(
                "Zip64 raw log archive entries are not supported".into(),
            ));
        }
        if disk_start != 0 {
            return Err(CoreError::Policy(
                "multi-disk raw log archive entries are not supported".into(),
            ));
        }
        let unix_kind = (external_attributes >> 16) & 0o170000;
        if unix_kind == 0o120000 {
            return Err(CoreError::Policy(
                "symlink raw log zip entry rejected by policy".into(),
            ));
        }
        if !matches!(unix_kind, 0 | 0o040000 | 0o100000) {
            return Err(CoreError::Policy(
                "non-regular raw log zip entry rejected by policy".into(),
            ));
        }
        if expanded_size >= limits.min_compression_ratio_check_bytes
            && (compressed_size == 0
                || expanded_size > compressed_size.saturating_mul(limits.max_compression_ratio))
        {
            return Err(CoreError::Policy(format!(
                "raw log zip compression-ratio limit exceeded (>{}:1)",
                limits.max_compression_ratio
            )));
        }
        budget.add_declared_bytes(expanded_size, limits)?;
        if name_len == 0 || name_len > MAX_RAW_LOG_ENTRY_NAME_BYTES {
            return Err(CoreError::Policy(
                "raw log zip entry name exceeds policy limit".into(),
            ));
        }
        let mut name_bytes = vec![0u8; name_len];
        file.read_exact(&mut name_bytes)
            .map_err(|e| CoreError::Message(format!("read zip entry name: {e}")))?;
        let name = std::str::from_utf8(&name_bytes)
            .map_err(|_| CoreError::Policy("raw log zip entry name is not UTF-8".into()))?;
        let (normalized, _) = validate_raw_log_zip_entry(name)?;
        if !names.insert(normalized) {
            return Err(CoreError::Policy(
                "duplicate raw log zip entry rejected by policy".into(),
            ));
        }
        let skip = extra_len
            .checked_add(comment_len)
            .ok_or_else(|| CoreError::Policy("raw log zip metadata overflow".into()))?;
        file.seek(SeekFrom::Current(i64::try_from(skip).map_err(|_| {
            CoreError::Policy("raw log zip metadata exceeds seek range".into())
        })?))
        .map_err(|e| CoreError::Message(format!("seek zip entry metadata: {e}")))?;
    }
    if file
        .stream_position()
        .map_err(|e| CoreError::Message(format!("read zip position: {e}")))?
        != central_end
    {
        return Err(CoreError::Policy(
            "raw log zip central directory lengths are inconsistent".into(),
        ));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|e| CoreError::Message(format!("rewind zip: {e}")))?;
    Ok(entries_total as u64)
}

fn read_bounded_line(
    reader: &mut dyn BufRead,
    output: &mut Vec<u8>,
    max_line_bytes: usize,
    cancel: Option<&CancelFlag>,
) -> CoreResult<usize> {
    let mut total = 0usize;
    loop {
        if cancelled(cancel) {
            return Err(CoreError::Message(
                "ingest cancelled during line read".into(),
            ));
        }
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                return Err(CoreError::Policy(error.to_string()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                return Err(CoreError::Message(error.to_string()))
            }
            Err(error) => {
                return Err(CoreError::Message(format!(
                    "raw log source read failed: {error}"
                )))
            }
        };
        if available.is_empty() {
            return Ok(total);
        }
        let through_newline = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if output.len().saturating_add(through_newline) > max_line_bytes {
            return Err(CoreError::Policy(format!(
                "raw log line-length limit exceeded (>{max_line_bytes} bytes)"
            )));
        }
        let ended = available.get(through_newline.saturating_sub(1)) == Some(&b'\n');
        output.extend_from_slice(&available[..through_newline]);
        reader.consume(through_newline);
        total = total.saturating_add(through_newline);
        if ended {
            return Ok(total);
        }
    }
}

/// Parse lines from a streaming reader into the corpus batch (shared by dir + zip).
#[allow(clippy::too_many_arguments)]
fn ingest_lines_from_reader(
    reader: &mut dyn BufRead,
    source_label: &str,
    file_hint: Option<&Path>,
    corpus: &LogCorpus,
    miner: &mut DrainMiner,
    stats: &mut IngestStats,
    seq: &mut u64,
    batch: &mut Vec<IngestedLogEvent>,
    format_hint: &mut Option<LogFormat>,
    files_done: u64,
    file_count: u64,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    kind: ProcessProgressKind,
    limits: RawIngestLimits,
) -> CoreResult<bool> {
    let mut raw_line = Vec::new();
    let mut source_bytes_read = 0u64;
    loop {
        if cancelled(cancel) {
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Cancelled,
                    "ingest cancelled during parse",
                    false,
                )
                .with_lines(stats.lines)
                .with_files(files_done)
                .with_bytes(stats.source_bytes),
            );
            return Err(CoreError::Message("ingest cancelled".into()));
        }
        raw_line.clear();
        let bytes = read_bounded_line(reader, &mut raw_line, limits.max_line_bytes, cancel)?;
        if bytes == 0 {
            break;
        }
        source_bytes_read = source_bytes_read.saturating_add(bytes as u64);
        if source_bytes_read > limits.max_file_bytes {
            return Err(CoreError::Policy(format!(
                "raw log member actual-byte limit exceeded ({} > {})",
                source_bytes_read, limits.max_file_bytes
            )));
        }
        stats.source_bytes = stats.source_bytes.saturating_add(bytes as u64);
        let prepared_original = prepare_original_record(&raw_line);
        let line = prepared_original.parser_text.as_str();
        if line.trim().is_empty() {
            continue;
        }
        if format_hint.is_none() {
            *format_hint = Some(detect_format(line, file_hint));
        }
        let parsed = parse_line(line, *format_hint, *seq);
        let fmt_key = match parsed.format {
            LogFormat::Json => "json",
            LogFormat::Logfmt => "logfmt",
            LogFormat::Syslog => "syslog",
            LogFormat::Plain => "plain",
        };
        *stats.format_counts.entry(fmt_key.into()).or_insert(0) += 1;
        let msg = redact_message(&parsed.message);
        let ts = parsed.ts.unwrap_or(*seq as i64);
        stats.ts_min = Some(stats.ts_min.map_or(ts, |m| m.min(ts)));
        stats.ts_max = Some(stats.ts_max.map_or(ts, |m| m.max(ts)));
        let level_key = parsed.level.to_ascii_lowercase();
        *stats.level_counts.entry(level_key).or_insert(0) += 1;
        let (tid, params) = miner.match_or_create(&msg, ts, &parsed.level);
        let params = redact_params(&params);
        batch.push(IngestedLogEvent {
            event: LogEvent {
                seq: *seq,
                ts,
                level: parsed.level,
                service: parsed.service,
                host: parsed.host,
                template_id: tid,
                params,
                trace_id: parsed.trace_id,
                message: msg,
                source: source_label.to_string(),
            },
            original: prepared_original.stored,
        });
        *seq += 1;
        stats.lines += 1;
        if batch.len() >= 256 {
            if files_done == 0 && stats.lines <= 256 {
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Store,
                        "writing event batches",
                        true,
                    )
                    .with_fraction(0.45)
                    .with_lines(stats.lines)
                    .with_files(files_done)
                    .with_bytes(stats.source_bytes),
                );
            }
            corpus.push_ingested_events(batch)?;
            batch.clear();
        }
        if stats.lines.is_multiple_of(PROGRESS_EVERY_LINES) {
            let frac =
                0.15 + 0.45 * ((files_done as f32 + 0.5) / file_count.max(1) as f32).min(1.0);
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Parse,
                    format!("parsing {source_label} ({} lines so far)", stats.lines),
                    true,
                )
                .with_fraction(frac)
                .with_lines(stats.lines)
                .with_files(files_done)
                .with_bytes(stats.source_bytes)
                .with_templates(miner.templates().len() as u64),
            );
        }
    }
    Ok(true)
}

/// Stream zip members in-place (no full extract to temp). Cancel checked **per entry**.
#[allow(clippy::too_many_arguments)]
fn ingest_from_zip(
    zip_path: &Path,
    corpus: &LogCorpus,
    miner: &mut DrainMiner,
    stats: &mut IngestStats,
    seq: &mut u64,
    batch: &mut Vec<IngestedLogEvent>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    kind: ProcessProgressKind,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
) -> CoreResult<u64> {
    if cancelled(cancel) {
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Cancelled,
                "ingest cancelled before zip open",
                false,
            ),
        );
        return Err(CoreError::Message("ingest cancelled".into()));
    }

    let mut file = open_selected_regular_file(zip_path)?;
    let entry_count = preflight_raw_log_zip(&mut file, budget, limits, cancel)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| CoreError::Message(format!("zip open: {e}")))?;
    if archive.len() as u64 != entry_count {
        return Err(CoreError::Policy(
            "raw log zip entry index is ambiguous".into(),
        ));
    }

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Scan,
            format!("zip has {entry_count} entr(y/ies); streaming members"),
            true,
        )
        .with_fraction(0.1)
        .with_files(entry_count),
    );

    let mut files_done = 0u64;
    let mut seen_names = std::collections::HashSet::new();
    for i in 0..archive.len() {
        if cancelled(cancel) {
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Cancelled,
                    "ingest cancelled during zip stream",
                    false,
                )
                .with_lines(stats.lines)
                .with_files(files_done)
                .with_bytes(stats.source_bytes),
            );
            return Err(CoreError::Message("ingest cancelled".into()));
        }

        let entry = archive
            .by_index(i)
            .map_err(|e| CoreError::Message(format!("zip entry: {e}")))?;
        let name = entry.name().to_string();
        stats.discover();
        let (rel, directory) = validate_raw_log_zip_entry(&name)?;
        if !seen_names.insert(rel.clone()) {
            return Err(CoreError::Policy(
                "duplicate raw log zip entry rejected by policy".into(),
            ));
        }
        if entry.encrypted() {
            return Err(CoreError::Policy(
                "encrypted raw log zip entry rejected by policy".into(),
            ));
        }
        if entry.is_symlink() {
            return Err(CoreError::Policy(
                "symlink raw log zip entry rejected by policy".into(),
            ));
        }
        if !directory && !entry.is_file() {
            return Err(CoreError::Policy(
                "non-regular raw log zip entry rejected by policy".into(),
            ));
        }
        if directory {
            stats.ignored("directory", Path::new(&rel));
            files_done += 1;
            continue;
        }
        if is_hidden_archive_identity(&rel) {
            stats.ignored("hidden", Path::new(&rel));
            files_done += 1;
            continue;
        }
        if has_zip_extension(Path::new(&rel)) {
            stats.excluded("nested_archive_unsupported", Path::new(&rel));
            files_done += 1;
            continue;
        }

        let size = entry.size();
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Scan,
                format!(
                    "zip member {}/{}: {}",
                    i + 1,
                    entry_count,
                    progress_basename(std::path::Path::new(&rel))
                ),
                true,
            )
            .with_fraction(0.1 + 0.05 * ((i as f32 + 1.0) / entry_count.max(1) as f32))
            .with_files(files_done)
            .with_lines(stats.lines)
            .with_bytes(stats.source_bytes),
        );

        if size > limits.max_file_bytes {
            stats.excluded("too_large", Path::new(&rel));
            files_done += 1;
            continue;
        }

        let bounded = BoundedSourceReader::new(entry, budget, limits, cancel);
        let mut reader = BufReader::with_capacity(64 * 1024, bounded);
        let head = match reader.fill_buf() {
            Ok(bytes) => &bytes[..bytes.len().min(8192)],
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                return Err(CoreError::Policy(error.to_string()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                return Err(CoreError::Message(error.to_string()))
            }
            Err(error) => {
                return Err(CoreError::Message(format!(
                    "raw log zip member read failed: {error}"
                )))
            }
        };
        if has_zip_signature(head) {
            stats.excluded("nested_archive_unsupported", Path::new(&rel));
            files_done += 1;
            continue;
        }
        if head.contains(&0) {
            stats.excluded("binary", Path::new(&rel));
            files_done += 1;
            continue;
        }

        let mut format_hint = None;

        let completely_read = ingest_lines_from_reader(
            &mut reader,
            &rel,
            Some(Path::new(&rel)),
            corpus,
            miner,
            stats,
            seq,
            batch,
            &mut format_hint,
            files_done,
            entry_count,
            progress,
            cancel,
            kind,
            limits,
        )?;
        let bounded = reader.into_inner();
        if bounded.member_bytes != size {
            return Err(CoreError::Policy(format!(
                "raw log zip member size mismatch (declared {size}, read {})",
                bounded.member_bytes
            )));
        }

        files_done += 1;
        if completely_read {
            stats.imported();
        } else {
            stats.failed("read_failed", Path::new(&rel));
        }
        let frac = 0.15 + 0.45 * (files_done as f32 / entry_count.max(1) as f32);
        if files_done == 1 || files_done == entry_count || files_done.is_multiple_of(5) {
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Template,
                    "Drain templating + redaction (zip stream)",
                    true,
                )
                .with_fraction(frac)
                .with_lines(stats.lines)
                .with_files(files_done)
                .with_bytes(stats.source_bytes)
                .with_templates(miner.templates().len() as u64),
            );
        }
    }

    Ok(files_done)
}

#[allow(clippy::too_many_arguments)]
fn ingest_path_inner(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    embed_mode: LogEmbedMode,
    defer_above_source_bytes: Option<u64>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
) -> CoreResult<IngestReport> {
    ingest_path_inner_with_fault(
        cache_root,
        path,
        name,
        embed,
        embed_model,
        embed_mode,
        defer_above_source_bytes,
        progress,
        cancel,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn ingest_path_inner_with_fault(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    embed_mode: LogEmbedMode,
    defer_above_source_bytes: Option<u64>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    fault: IngestFaultHook<'_>,
) -> CoreResult<IngestReport> {
    ingest_path_inner_with_limits_and_fault(
        cache_root,
        path,
        name,
        embed,
        embed_model,
        embed_mode,
        defer_above_source_bytes,
        progress,
        cancel,
        RawIngestLimits::default(),
        fault,
    )
}

#[allow(clippy::too_many_arguments)]
fn ingest_path_inner_with_limits_and_fault(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    embed_mode: LogEmbedMode,
    defer_above_source_bytes: Option<u64>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    limits: RawIngestLimits,
    fault: IngestFaultHook<'_>,
) -> CoreResult<IngestReport> {
    let kind = ProcessProgressKind::LogIngest;
    let source_label = progress_basename(path);

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Starting,
            format!("starting ingest of {source_label}"),
            true,
        )
        .with_fraction(0.0),
    );

    if cancelled(cancel) {
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Cancelled,
                "ingest cancelled before scan",
                false,
            ),
        );
        return Err(CoreError::Message("ingest cancelled".into()));
    }

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Scan,
            format!("scanning {source_label}"),
            true,
        )
        .with_fraction(0.05),
    );

    let mut staging = IngestStaging::new(cache_root)?;
    let report = ingest_path_into_cache(
        staging.cache_root(),
        path,
        name,
        embed,
        embed_model,
        embed_mode,
        defer_above_source_bytes,
        progress,
        cancel,
        limits,
        fault,
    )?;

    check_ingest_fault(fault, IngestCheckpoint::BeforeValidation)?;
    validate_staged_ingest(staging.cache_root(), &report)?;
    check_ingest_fault(fault, IngestCheckpoint::BeforePublish)?;
    staging.publish(cache_root, &report.corpus_id)?;

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Completed,
            format!(
                "ingested {} events → {} learned templates ({:.1} avg. events/template)",
                report.stats.lines, report.stats.templates, report.stats.reduction_ratio
            ),
            false,
        )
        .with_fraction(1.0)
        .with_lines(report.stats.lines)
        .with_files(report.stats.files as u64)
        .with_bytes(report.stats.source_bytes)
        .with_templates(report.stats.templates as u64),
    );

    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn ingest_path_into_cache(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    embed_mode: LogEmbedMode,
    defer_above_source_bytes: Option<u64>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    limits: RawIngestLimits,
    fault: IngestFaultHook<'_>,
) -> CoreResult<IngestReport> {
    let kind = ProcessProgressKind::LogIngest;
    let source_label = progress_basename(path);

    let corpus = LogCorpus::create(cache_root, name)?;
    check_ingest_fault(fault, IngestCheckpoint::CorpusCreated)?;
    let mut miner = DrainMiner::default();
    let mut stats = IngestStats::default();
    let mut seq = 0u64;
    let mut batch = Vec::with_capacity(256);
    let mut budget = RawIngestBudget::default();
    let files_done = if is_zip_file(path) {
        // Stream members without full extract-to-temp (#499 skeptic fix).
        ingest_from_zip(
            path,
            &corpus,
            &mut miner,
            &mut stats,
            &mut seq,
            &mut batch,
            progress,
            cancel,
            kind,
            &mut budget,
            limits,
        )?
    } else {
        let inventory = collect_log_files(path, &mut budget, limits, cancel)?;
        for ignored in &inventory.ignored {
            stats.discover();
            stats.ignored("hidden", ignored);
        }
        for _ in &inventory.files {
            stats.discover();
        }
        if stats.discovered_files == 0 {
            return Err(CoreError::Message(
                "no importable log file entries discovered".into(),
            ));
        }
        let file_count = stats.discovered_files;
        let mut files_done = inventory.ignored.len() as u64;

        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Scan,
                format!("found {file_count} file entr(y/ies)"),
                true,
            )
            .with_fraction(0.1)
            .with_files(file_count),
        );

        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Parse,
                "parsing and templating lines",
                true,
            )
            .with_fraction(0.15)
            .with_files(file_count),
        );

        for file in &inventory.files {
            if cancelled(cancel) {
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Cancelled,
                        "ingest cancelled during parse",
                        false,
                    )
                    .with_lines(stats.lines)
                    .with_files(files_done),
                );
                return Err(CoreError::Message("ingest cancelled".into()));
            }

            if has_zip_extension(file) {
                stats.excluded("nested_archive_unsupported", file);
                files_done += 1;
                continue;
            }

            let file_bytes = match std::fs::symlink_metadata(file) {
                Ok(metadata) => metadata.len(),
                Err(_) => {
                    stats.failed("metadata_failed", file);
                    files_done += 1;
                    continue;
                }
            };
            if file_bytes > limits.max_file_bytes {
                stats.excluded("too_large", file);
                files_done += 1;
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Parse,
                        format!(
                            "skipped oversized {} ({} bytes > {} cap)",
                            progress_basename(file),
                            file_bytes,
                            limits.max_file_bytes
                        ),
                        true,
                    )
                    .with_fraction(0.15 + 0.45 * (files_done as f32 / file_count.max(1) as f32))
                    .with_lines(stats.lines)
                    .with_files(files_done),
                );
                continue;
            }

            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Parse,
                    format!("opening {}", progress_basename(file)),
                    true,
                )
                .with_lines(stats.lines)
                .with_files(files_done)
                .with_bytes(stats.source_bytes),
            );
            let fh = match open_inventory_file(&inventory, file) {
                Ok(file) => file,
                Err(CoreError::Policy(reason)) => return Err(CoreError::Policy(reason)),
                Err(_) => {
                    stats.failed("open_failed", file);
                    files_done += 1;
                    continue;
                }
            };
            let bounded = BoundedSourceReader::new(fh, &mut budget, limits, cancel);
            let mut reader = BufReader::with_capacity(64 * 1024, bounded);
            let head = match reader.fill_buf() {
                Ok(bytes) => &bytes[..bytes.len().min(8192)],
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    return Err(CoreError::Policy(error.to_string()))
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                    return Err(CoreError::Message(error.to_string()))
                }
                Err(_) => {
                    stats.failed("read_failed", file);
                    files_done += 1;
                    continue;
                }
            };
            if has_zip_signature(head) {
                stats.excluded("nested_archive_unsupported", file);
                files_done += 1;
                continue;
            }
            if head.contains(&0) {
                stats.excluded("binary", file);
                files_done += 1;
                continue;
            }

            let rel_path = if path.is_dir() {
                file.strip_prefix(path).unwrap_or(file.as_path())
            } else {
                Path::new(
                    file.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("log"),
                )
            };
            let rel = portable_source_identity(rel_path)?;

            let mut format_hint = None;
            let completely_read = ingest_lines_from_reader(
                &mut reader,
                &rel,
                Some(file.as_path()),
                &corpus,
                &mut miner,
                &mut stats,
                &mut seq,
                &mut batch,
                &mut format_hint,
                files_done,
                file_count,
                progress,
                cancel,
                kind,
                limits,
            )?;
            files_done += 1;
            if completely_read {
                stats.imported();
            } else {
                stats.failed("read_failed", file);
            }
            let frac = 0.15 + 0.45 * (files_done as f32 / file_count.max(1) as f32);
            if files_done == 1 || files_done == file_count || files_done.is_multiple_of(5) {
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Template,
                        "Drain templating + redaction",
                        true,
                    )
                    .with_fraction(frac)
                    .with_lines(stats.lines)
                    .with_files(files_done)
                    .with_bytes(stats.source_bytes)
                    .with_templates(miner.templates().len() as u64),
                );
            }
        }
        files_done
    };

    if stats.lines == 0 {
        return Err(CoreError::Message(
            "no safe/importable log events were found".into(),
        ));
    }

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Redact,
            "redaction complete for parsed messages",
            true,
        )
        .with_fraction(0.62)
        .with_lines(stats.lines)
        .with_files(files_done),
    );

    if !batch.is_empty() {
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Store,
                "flushing remaining events",
                // After first store, cancel is less clean; still allow between template persist.
                true,
            )
            .with_fraction(0.7)
            .with_lines(stats.lines),
        );
        corpus.push_ingested_events(&batch)?;
    }
    check_ingest_fault(fault, IngestCheckpoint::EventsStored)?;

    if cancelled(cancel) {
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Cancelled,
                "ingest cancelled before template persist",
                false,
            )
            .with_lines(stats.lines),
        );
        return Err(CoreError::Message("ingest cancelled".into()));
    }

    // Persist templates
    check_ingest_fault(fault, IngestCheckpoint::BeforeTemplates)?;
    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Store,
            "persisting template table",
            false, // flush in progress — not cleanly cancellable mid-upsert
        )
        .with_fraction(0.78)
        .with_lines(stats.lines),
    );

    let mut rows = Vec::new();
    for t in miner.templates() {
        rows.push(TemplateRow {
            content_hash: template_content_hash(&t.pattern),
            info: t,
            vector: None,
        });
    }
    corpus.upsert_templates(rows)?;

    // Embed templates only (#359). Cap bulk SoftWrite so import is not forced
    // through a full multi-k embed pass (semantic can be filled later).
    let deferred = embed_mode == LogEmbedMode::Local
        && defer_above_source_bytes.is_some_and(|limit| stats.source_bytes > limit);
    let mut embedded = 0usize;
    if let Some(backend) = embed.filter(|_| !deferred) {
        check_ingest_fault(fault, IngestCheckpoint::DuringEmbedding)?;
        let mut templates = corpus.list_templates();
        templates.sort_by_key(|r| std::cmp::Reverse(r.info.count));
        let cap = BULK_EMBED_TEMPLATE_CAP.min(templates.len());
        let to_embed: Vec<_> = templates.into_iter().take(cap).collect();
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Embed,
                format!("embedding up to {cap} top templates (bulk SoftWrite cap)"),
                false,
            )
            .with_fraction(0.85)
            .with_templates(corpus.template_count() as u64),
        );
        let total_t = to_embed.len().max(1) as f32;
        let mut hash_cache: std::collections::HashMap<String, Vec<f32>> =
            std::collections::HashMap::new();
        for (i, row) in to_embed.into_iter().enumerate() {
            if cancelled(cancel) {
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Cancelled,
                        "ingest cancelled during template embedding",
                        false,
                    )
                    .with_lines(stats.lines)
                    .with_templates(embedded as u64),
                );
                return Err(CoreError::Message("ingest cancelled".into()));
            }
            if let Some(v) = hash_cache.get(&row.content_hash) {
                corpus.set_template_vector(row.info.template_id, v.clone())?;
                embedded += 1;
                continue;
            }
            if let Some(v) = embed_blocking(backend, &row.info.pattern, 5_000) {
                hash_cache.insert(row.content_hash.clone(), v.clone());
                corpus.set_template_vector(row.info.template_id, v)?;
                embedded += 1;
            }
            if i % 8 == 0 {
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Embed,
                        "embedding templates",
                        false,
                    )
                    .with_fraction(0.85 + 0.12 * (i as f32 / total_t))
                    .with_templates(embedded as u64),
                );
            }
        }
    }

    stats.templates = corpus.template_count();
    stats.reduction_ratio = if stats.templates > 0 {
        stats.lines as f64 / stats.templates as f64
    } else {
        0.0
    };
    stats.embedded = embedded;
    let embedding = CorpusEmbeddingStatus {
        state: if deferred {
            EmbeddingState::Deferred
        } else if stats.templates > 0 && embedded == stats.templates {
            EmbeddingState::Complete
        } else if embedded > 0 {
            EmbeddingState::Partial
        } else {
            EmbeddingState::KeywordOnly
        },
        model_id: (embedded > 0 || deferred).then(|| embed_model.to_string()),
        embedded_templates: embedded as u64,
        total_templates: stats.templates as u64,
        reason: Some(
            if deferred {
                "bulk_source_bytes_threshold"
            } else if embed.is_none() && embed_mode == LogEmbedMode::Local {
                "local_model_unavailable"
            } else if embed_mode == LogEmbedMode::None {
                "embedding_not_requested"
            } else if embedded < stats.templates {
                "template_cap_or_backend_failure"
            } else {
                "local_embedding_complete"
            }
            .into(),
        ),
        updated_at: crate::embed::now_unix_secs(),
    };

    let mut top: Vec<_> = corpus
        .list_templates()
        .into_iter()
        .map(|r| {
            (
                r.info.template_id,
                r.info.pattern,
                r.info.count,
                r.info.severity,
            )
        })
        .collect();
    top.sort_by_key(|b| std::cmp::Reverse(b.2));
    top.truncate(10);

    corpus.flush()?;
    stats.corpus_bytes = corpus.corpus_bytes_on_disk();
    check_ingest_fault(fault, IngestCheckpoint::BeforeSummary)?;

    let top_snap: Vec<TopTemplateSnapshot> = top
        .iter()
        .map(|(id, pattern, count, severity)| TopTemplateSnapshot {
            id: *id,
            pattern: pattern.clone(),
            count: *count,
            severity: *severity,
        })
        .collect();
    corpus.write_ingest_summary(
        Some(source_label.clone()),
        stats.to_corpus_stats(),
        top_snap,
        embedding.clone(),
    )?;

    Ok(IngestReport {
        corpus_id: corpus.id().to_string(),
        stats,
        top_templates: top,
        embedding,
    })
}

fn validate_staged_ingest(staging_cache_root: &Path, report: &IngestReport) -> CoreResult<()> {
    // Open only after the writer handle from `ingest_path_into_cache` has been
    // dropped. This catches malformed metadata/templates/DuckDB while the
    // corpus is still hidden and keeps rename compatible with Windows.
    let opened = LogCorpus::open(staging_cache_root, &report.corpus_id)?;
    let meta = opened.meta()?;
    if meta.id != report.corpus_id {
        return Err(CoreError::Message(
            "staged corpus metadata id mismatch".into(),
        ));
    }
    let Some(persisted) = meta.stats else {
        return Err(CoreError::Message(
            "staged corpus missing completed ingest stats".into(),
        ));
    };
    if persisted.lines != report.stats.lines
        || persisted.templates != report.stats.templates as u64
        || opened.event_count() as u64 != report.stats.lines
        || opened.template_count() != report.stats.templates
    {
        return Err(CoreError::Message(
            "staged corpus validation counts do not match ingest report".into(),
        ));
    }
    Ok(())
}

#[derive(Default)]
struct FileInventory {
    files: Vec<PathBuf>,
    ignored: Vec<PathBuf>,
    canonical_root: PathBuf,
}

fn collect_log_files(
    path: &Path,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
    cancel: Option<&CancelFlag>,
) -> CoreResult<FileInventory> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| CoreError::Message("log source does not exist".into()))?;
    if metadata.file_type().is_symlink() {
        return Err(CoreError::Policy(
            "symlink log source rejected by policy".into(),
        ));
    }
    let canonical_root = std::fs::canonicalize(path)
        .map_err(|e| CoreError::Message(format!("resolve log source: {e}")))?;
    let mut out = FileInventory {
        canonical_root: canonical_root.clone(),
        ..FileInventory::default()
    };
    if metadata.is_file() {
        budget.add_entries(1, limits)?;
        if !has_zip_extension(path) && metadata.len() <= limits.max_file_bytes {
            budget.add_declared_bytes(metadata.len(), limits)?;
        }
        out.files.push(path.to_path_buf());
        return Ok(out);
    }
    if metadata.is_dir() {
        let mut visited = std::collections::HashSet::new();
        visited.insert(canonical_root);
        let root_for_walk = out.canonical_root.clone();
        walk_dir(
            path,
            &root_for_walk,
            &mut out,
            &mut visited,
            budget,
            limits,
            cancel,
        )?;
    } else {
        return Err(CoreError::Policy(
            "non-regular log source rejected by policy".into(),
        ));
    }
    out.files.sort();
    out.ignored.sort();
    Ok(out)
}

fn walk_dir(
    dir: &Path,
    canonical_root: &Path,
    out: &mut FileInventory,
    visited: &mut std::collections::HashSet<PathBuf>,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
    cancel: Option<&CancelFlag>,
) -> CoreResult<()> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        if cancelled(cancel) {
            return Err(CoreError::Message(
                "ingest cancelled during directory scan".into(),
            ));
        }
        budget.add_entries(1, limits)?;
        entries.push(entry?);
    }
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        if cancelled(cancel) {
            return Err(CoreError::Message(
                "ingest cancelled during directory scan".into(),
            ));
        }
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            out.ignored.push(path);
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            return Err(CoreError::Policy(
                "symlink log source rejected by policy".into(),
            ));
        }
        if file_type.is_dir() {
            let canonical = std::fs::canonicalize(&path)
                .map_err(|e| CoreError::Message(format!("resolve log directory: {e}")))?;
            if !canonical.starts_with(canonical_root) {
                return Err(CoreError::Policy(
                    "log directory escaped selected root".into(),
                ));
            }
            if !visited.insert(canonical) {
                return Err(CoreError::Policy(
                    "log directory cycle rejected by policy".into(),
                ));
            }
            walk_dir(&path, canonical_root, out, visited, budget, limits, cancel)?;
        } else if file_type.is_file() {
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(CoreError::Policy(
                    "log source changed during directory scan".into(),
                ));
            }
            if !has_zip_extension(&path) && metadata.len() <= limits.max_file_bytes {
                budget.add_declared_bytes(metadata.len(), limits)?;
            }
            out.files.push(path);
        } else {
            return Err(CoreError::Policy(
                "non-regular log source rejected by policy".into(),
            ));
        }
    }
    Ok(())
}

fn open_inventory_file(inventory: &FileInventory, path: &Path) -> CoreResult<std::fs::File> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|e| CoreError::Message(format!("read log metadata: {e}")))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(CoreError::Policy(
            "log source changed to a symlink or non-regular file".into(),
        ));
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|e| CoreError::Message(format!("resolve log: {e}")))?;
    if !canonical.starts_with(&inventory.canonical_root) {
        return Err(CoreError::Policy("log source escaped selected root".into()));
    }
    let file =
        std::fs::File::open(path).map_err(|e| CoreError::Message(format!("open log: {e}")))?;
    let opened = file
        .metadata()
        .map_err(|e| CoreError::Message(format!("read opened log metadata: {e}")))?;
    if !opened.is_file() {
        return Err(CoreError::Policy(
            "opened log source is not a regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(CoreError::Policy(
                "log source changed during secure open".into(),
            ));
        }
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::ConceptEmbedBackend;
    use crate::process_progress::{CancelFlag, ProcessProgressPhase, RecordingProcessProgress};
    use std::io::Write;

    fn cache_tree_paths(root: &Path) -> Vec<PathBuf> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(rel.to_path_buf());
                }
                if path.is_dir() {
                    walk(root, &path, out);
                }
            }
        }

        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.sort();
        out
    }

    fn assert_no_ingest_staging(cache_root: &Path) {
        assert!(
            !cache_root.join(".log_ingest_staging").exists(),
            "ingest staging survived: {:?}",
            cache_tree_paths(cache_root)
        );
    }

    fn ingest_with_limits(
        cache_root: &Path,
        path: &Path,
        name: &str,
        limits: RawIngestLimits,
        progress: &dyn ProcessProgressObserver,
        cancel: Option<&CancelFlag>,
    ) -> CoreResult<IngestReport> {
        ingest_path_inner_with_limits_and_fault(
            cache_root,
            path,
            name,
            None,
            "none",
            LogEmbedMode::None,
            None,
            progress,
            cancel,
            limits,
            None,
        )
    }

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn assert_atomic_failure(cache: &Path, error: &CoreError, expected: &str) {
        assert!(
            error.to_string().contains(expected),
            "expected {expected:?}, got {error}"
        );
        assert!(LogCorpus::list_ids(cache).unwrap().is_empty());
        assert_no_ingest_staging(cache);
    }

    #[test]
    fn nested_archives_are_explicitly_unsupported_in_directories_and_zip_members() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("visible.log"), "level=info msg=visible\n").unwrap();
        let inner = zip_bytes(&[("deep/app.log", b"level=error msg=must-not-parse\n")]);
        std::fs::write(logs.join("host-a.zip"), &inner).unwrap();
        std::fs::write(logs.join("host-a.bundle"), &inner).unwrap();

        let directory_report =
            ingest_path(&cache, &logs, "directory-nested", None, "none").unwrap();
        assert_eq!(directory_report.stats.lines, 1);
        assert_eq!(
            directory_report.stats.exclusion_counts["nested_archive_unsupported"],
            2
        );

        let outer = dir.path().join("outer.zip");
        std::fs::write(
            &outer,
            zip_bytes(&[
                ("visible.log", b"level=info msg=outer-visible\n"),
                ("host-b.zip", &inner),
                ("host-b.bundle", &inner),
            ]),
        )
        .unwrap();
        let archive_report = ingest_path(&cache, &outer, "zip-nested", None, "none").unwrap();
        assert_eq!(archive_report.stats.lines, 1);
        assert_eq!(
            archive_report.stats.exclusion_counts["nested_archive_unsupported"],
            2
        );

        let malformed = dir.path().join("malformed-container.zip");
        std::fs::write(
            &malformed,
            zip_bytes(&[
                ("visible.log", b"level=info msg=still-visible\n"),
                ("broken.zip", b"PK\x03\x04malformed nested bytes"),
            ]),
        )
        .unwrap();
        let malformed_report =
            ingest_path(&cache, &malformed, "malformed-nested", None, "none").unwrap();
        assert_eq!(malformed_report.stats.lines, 1);
        assert_eq!(
            malformed_report.stats.exclusion_counts["nested_archive_unsupported"],
            1
        );
    }

    #[test]
    fn nested_archive_only_input_fails_atomically_instead_of_parsing_zip_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let inner = zip_bytes(&[("app.log", b"level=error msg=hidden-in-archive\n")]);
        std::fs::write(logs.join("host.zip"), inner).unwrap();

        let error = ingest_path(&cache, &logs, "nested-only", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "no safe/importable log events");
    }

    #[test]
    fn hidden_directory_and_archive_subtrees_have_policy_parity() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(logs.join(".private/deep")).unwrap();
        std::fs::write(
            logs.join(".private/deep/secret.log"),
            "level=error msg=must-not-import\n",
        )
        .unwrap();
        std::fs::write(logs.join("visible.log"), "level=info msg=visible\n").unwrap();
        let directory_report =
            ingest_path(&cache, &logs, "hidden-directory", None, "none").unwrap();
        assert_eq!(directory_report.stats.lines, 1);
        assert_eq!(directory_report.stats.ignored_files, 1);
        assert_eq!(directory_report.stats.exclusion_counts["hidden"], 1);

        let zip_path = dir.path().join("hidden.zip");
        std::fs::write(
            &zip_path,
            zip_bytes(&[
                (
                    ".private/deep/secret.log",
                    b"level=error msg=must-not-import\n",
                ),
                ("visible.log", b"level=info msg=visible\n"),
            ]),
        )
        .unwrap();
        let archive_report =
            ingest_path(&cache, &zip_path, "hidden-archive", None, "none").unwrap();
        assert_eq!(archive_report.stats.lines, 1);
        assert_eq!(archive_report.stats.ignored_files, 1);
        assert_eq!(archive_report.stats.exclusion_counts["hidden"], 1);
    }

    #[test]
    fn directory_same_basenames_keep_distinct_relative_source_identities() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(logs.join("host-a")).unwrap();
        std::fs::create_dir_all(logs.join("host-b")).unwrap();
        std::fs::write(
            logs.join("host-a/app.log"),
            "level=info msg=host-a-visible\n",
        )
        .unwrap();
        std::fs::write(
            logs.join("host-b/app.log"),
            "level=error msg=host-b-visible\n",
        )
        .unwrap();

        let report = ingest_path(&cache, &logs, "same-basename", None, "none").unwrap();
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let mut sources = corpus.with_events(|events| {
            events
                .iter()
                .map(|event| event.source.clone())
                .collect::<Vec<_>>()
        });
        sources.sort();
        assert_eq!(sources, ["host-a/app.log", "host-b/app.log"]);
    }

    #[cfg(unix)]
    #[test]
    fn directory_walk_rejects_outside_symlinks_cycles_and_non_regular_entries() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;

        for case in ["outside", "cycle", "socket"] {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let logs = dir.path().join("logs");
            let outside = dir.path().join("outside");
            std::fs::create_dir_all(&logs).unwrap();
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(logs.join("safe.log"), "level=info msg=safe\n").unwrap();
            std::fs::write(outside.join("secret.log"), "level=error msg=outside\n").unwrap();
            let _socket = match case {
                "outside" => {
                    symlink(outside.join("secret.log"), logs.join("escape.log")).unwrap();
                    None
                }
                "cycle" => {
                    symlink(&logs, logs.join("cycle")).unwrap();
                    None
                }
                "socket" => Some(UnixListener::bind(logs.join("events.sock")).unwrap()),
                _ => unreachable!(),
            };

            let error = ingest_path(&cache, &logs, case, None, "none").unwrap_err();
            let expected = if case == "socket" {
                "non-regular"
            } else {
                "symlink"
            };
            assert_atomic_failure(&cache, &error, expected);
        }
    }

    #[cfg(unix)]
    #[test]
    fn directly_selected_symlink_is_rejected_atomically() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let target = dir.path().join("target.log");
        let selected = dir.path().join("selected.log");
        std::fs::write(&target, "level=error msg=outside\n").unwrap();
        symlink(&target, &selected).unwrap();

        let error = ingest_path(&cache, &selected, "symlink", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "symlink");
    }

    #[test]
    fn zip_preflight_rejects_duplicate_traversal_symlink_and_non_regular_entries() {
        let mut duplicate = zip_bytes(&[
            ("one.log", b"level=info msg=one\n"),
            ("two.log", b"level=info msg=two\n"),
        ]);
        let central_positions: Vec<_> = duplicate
            .windows(4)
            .enumerate()
            .filter_map(|(position, window)| (window == b"PK\x01\x02").then_some(position))
            .collect();
        assert_eq!(central_positions.len(), 2);
        let second_name = central_positions[1] + 46;
        duplicate[second_name..second_name + 7].copy_from_slice(b"one.log");
        let cases = [
            ("duplicate", duplicate, "duplicate"),
            (
                "traversal",
                zip_bytes(&[("../escape.log", b"level=error msg=escape\n")]),
                "path rejected",
            ),
        ];
        for (case, bytes, expected) in cases {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let archive = dir.path().join(format!("{case}.zip"));
            std::fs::write(&archive, bytes).unwrap();
            let error = ingest_path(&cache, &archive, case, None, "none").unwrap_err();
            assert_atomic_failure(&cache, &error, expected);
        }

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let symlink_zip = dir.path().join("symlink.zip");
        {
            let file = std::fs::File::create(&symlink_zip).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.add_symlink(
                "link.log",
                "../outside.log",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.finish().unwrap();
        }
        let error = ingest_path(&cache, &symlink_zip, "symlink", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "symlink");

        let non_regular_zip = dir.path().join("non-regular.zip");
        std::fs::write(
            &non_regular_zip,
            zip_bytes(&[("socket.log", b"level=info msg=not-regular\n")]),
        )
        .unwrap();
        let mut bytes = std::fs::read(&non_regular_zip).unwrap();
        let central = bytes
            .windows(4)
            .position(|window| window == b"PK\x01\x02")
            .unwrap();
        let socket_mode = (0o140777u32) << 16;
        bytes[central + 38..central + 42].copy_from_slice(&socket_mode.to_le_bytes());
        std::fs::write(&non_regular_zip, bytes).unwrap();
        let error = ingest_path(&cache, &non_regular_zip, "non-regular", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "non-regular");
    }

    #[test]
    fn zip_preflight_rejects_encrypted_zip64_and_multi_disk_metadata() {
        for (case, expected, patch) in [
            ("encrypted", "encrypted", "flags"),
            ("zip64", "Zip64", "size"),
            ("multi-disk", "multi-disk", "disk"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let archive = dir.path().join(format!("{case}.zip"));
            let mut bytes = zip_bytes(&[("app.log", b"level=info msg=safe\n")]);
            let central = bytes
                .windows(4)
                .position(|window| window == b"PK\x01\x02")
                .unwrap();
            let eocd = bytes
                .windows(4)
                .position(|window| window == b"PK\x05\x06")
                .unwrap();
            match patch {
                "flags" => {
                    let flags = u16::from_le_bytes([bytes[central + 8], bytes[central + 9]]) | 1;
                    bytes[central + 8..central + 10].copy_from_slice(&flags.to_le_bytes());
                }
                "size" => {
                    bytes[central + 24..central + 28].copy_from_slice(&u32::MAX.to_le_bytes());
                }
                "disk" => {
                    bytes[eocd + 4..eocd + 6].copy_from_slice(&1u16.to_le_bytes());
                }
                _ => unreachable!(),
            }
            std::fs::write(&archive, bytes).unwrap();
            let error = ingest_path(&cache, &archive, case, None, "none").unwrap_err();
            assert_atomic_failure(&cache, &error, expected);
        }
    }

    #[test]
    fn zip_per_member_cap_is_an_honest_exclusion() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let archive = dir.path().join("member-cap.zip");
        std::fs::write(
            &archive,
            zip_bytes(&[
                ("safe.log", b"level=info msg=safe\n"),
                (
                    "large.log",
                    b"level=error msg=this-member-is-over-the-test-cap\n",
                ),
            ]),
        )
        .unwrap();
        let limits = RawIngestLimits {
            max_file_bytes: 32,
            ..RawIngestLimits::default()
        };
        let report = ingest_with_limits(
            &cache,
            &archive,
            "member-cap",
            limits,
            &NoopProcessProgress,
            None,
        )
        .unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.excluded_files, 1);
        assert_eq!(report.stats.exclusion_counts["too_large"], 1);
        assert!(report.stats.partial);
    }

    #[test]
    fn zip_entry_aggregate_and_compression_budgets_fail_atomically() {
        let cases = [
            (
                "entries",
                zip_bytes(&[
                    ("one.log", b"level=info msg=one\n"),
                    ("two.log", b"level=info msg=two\n"),
                ]),
                RawIngestLimits {
                    max_entries: 1,
                    ..RawIngestLimits::default()
                },
                "entry limit",
            ),
            (
                "expanded",
                zip_bytes(&[
                    ("one.log", b"level=info msg=one\n"),
                    ("two.log", b"level=info msg=two\n"),
                ]),
                RawIngestLimits {
                    max_expanded_bytes: 24,
                    ..RawIngestLimits::default()
                },
                "aggregate expanded-byte limit",
            ),
        ];
        for (case, bytes, limits, expected) in cases {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let archive = dir.path().join(format!("{case}.zip"));
            std::fs::write(&archive, bytes).unwrap();
            let error =
                ingest_with_limits(&cache, &archive, case, limits, &NoopProcessProgress, None)
                    .unwrap_err();
            assert_atomic_failure(&cache, &error, expected);
        }

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let archive = dir.path().join("ratio.zip");
        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("repeated.log", options).unwrap();
            zip.write_all(&vec![b'a'; 4096]).unwrap();
            zip.finish().unwrap();
        }
        let limits = RawIngestLimits {
            min_compression_ratio_check_bytes: 1,
            max_compression_ratio: 2,
            ..RawIngestLimits::default()
        };
        let error = ingest_with_limits(
            &cache,
            &archive,
            "ratio",
            limits,
            &NoopProcessProgress,
            None,
        )
        .unwrap_err();
        assert_atomic_failure(&cache, &error, "compression-ratio limit");
    }

    #[test]
    fn actual_byte_growth_and_line_length_limits_fail_atomically() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let growing = logs.join("growing.log");
        std::fs::write(&growing, "level=info msg=ok\n").unwrap();

        struct GrowAfterScan {
            path: PathBuf,
            grown: AtomicBool,
        }
        impl ProcessProgressObserver for GrowAfterScan {
            fn progress(&self, update: ProcessProgress) {
                if update.message == "opening growing.log"
                    && !self.grown.swap(true, Ordering::SeqCst)
                {
                    let mut file = std::fs::OpenOptions::new()
                        .append(true)
                        .open(&self.path)
                        .unwrap();
                    file.write_all(&vec![b'x'; 256]).unwrap();
                    file.write_all(b"\n").unwrap();
                }
            }
        }
        let observer = GrowAfterScan {
            path: growing,
            grown: AtomicBool::new(false),
        };
        let limits = RawIngestLimits {
            max_file_bytes: 64,
            ..RawIngestLimits::default()
        };
        let error =
            ingest_with_limits(&cache, &logs, "growth", limits, &observer, None).unwrap_err();
        assert_atomic_failure(&cache, &error, "actual-byte limit");

        let cache = dir.path().join("line-cache");
        let long_line = dir.path().join("long.log");
        std::fs::write(&long_line, format!("{}\n", "x".repeat(80))).unwrap();
        let limits = RawIngestLimits {
            max_line_bytes: 32,
            ..RawIngestLimits::default()
        };
        let error = ingest_with_limits(
            &cache,
            &long_line,
            "long-line",
            limits,
            &NoopProcessProgress,
            None,
        )
        .unwrap_err();
        assert_atomic_failure(&cache, &error, "line-length limit");
    }

    #[test]
    fn ingest_fixture_multi_format_with_reduction() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("app.log")).unwrap();
        // multi-k lines with heavy repetition
        for i in 0..3000 {
            writeln!(
                f,
                r#"{{"ts":{},"level":"error","service":"api","message":"connection refused to upstream {}"}}"#,
                1_700_000_000 + i,
                i % 50
            )
            .unwrap();
            writeln!(
                f,
                "ts={} level=info service=api msg=GET /users/{} 200 {}ms",
                1_700_000_000 + i,
                8000 + (i % 100),
                10 + (i % 20)
            )
            .unwrap();
        }
        let backend = ConceptEmbedBackend::new(64);
        let report = ingest_path(dir.path(), &logs, "fixture", Some(&backend), "concept").unwrap();
        assert!(report.stats.lines >= 6000);
        assert!(report.stats.templates < report.stats.lines as usize / 10);
        assert!(report.stats.reduction_ratio > 10.0);
        assert!(report.stats.embedded > 0);
        // #359: unconfirmed cloud must not run (no backend required if policy fails first).
        let blocked = ingest_path_with_policy(
            dir.path(),
            &logs,
            "cloud-blocked",
            &crate::log_analysis::LogEmbedPolicy::cloud_opt_in("https://api.example.com", false),
            None,
        );
        assert!(blocked.is_err(), "unconfirmed cloud must fail before embed");

        eprintln!(
            "ingest_fixture lines={} templates={} ratio={:.1} embedded={}",
            report.stats.lines,
            report.stats.templates,
            report.stats.reduction_ratio,
            report.stats.embedded
        );
    }

    #[test]
    fn cloud_policy_refuses_without_confirm() {
        use crate::log_analysis::LogEmbedPolicy;
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("l");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("a.log"), "error connection refused\n").unwrap();
        let policy = LogEmbedPolicy::cloud_opt_in("https://example.invalid", false);
        let backend: Arc<dyn EmbedBackend> = Arc::new(ConceptEmbedBackend::new(64));
        let err =
            ingest_path_with_policy(dir.path(), &logs, "c", &policy, Some(backend)).unwrap_err();
        assert!(format!("{err}").contains("leaves this machine"), "{err}");
    }

    #[test]
    fn ingest_zip_streams_members_without_full_extract() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("bundle.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("nested/app.log", opts).unwrap();
            let mut body = String::new();
            for i in 0..80 {
                body.push_str(&format!(
                    "ts={} level=error service=api msg=connection refused {}\n",
                    1_700_000_000 + i,
                    i % 7
                ));
            }
            zip.write_all(body.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let report = ingest_path(&cache, &zip_path, "from-zip", None, "none").unwrap();
        assert!(report.stats.lines >= 80, "lines={}", report.stats.lines);
        assert!(!report.corpus_id.is_empty());
        // No full extract-to-temp: production uses ingest_from_zip
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/log_analysis/ingest.rs");
        let prod = std::fs::read_to_string(&path)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .to_string();
        assert!(prod.contains("fn ingest_from_zip"));
        assert!(
            !prod.contains("tempfile::tempdir"),
            "must not full-extract zip to temp"
        );
    }

    #[test]
    fn ingest_zip_cancel_mid_member_stream() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("many.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            // Several members so cancel can fire between entries / during lines.
            for m in 0..8 {
                zip.start_file(format!("part{m}.log"), opts).unwrap();
                let mut body = String::new();
                for i in 0..8_000 {
                    body.push_str(&format!("info line {m}-{i}\n"));
                }
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        let flag = CancelFlag::new();
        let flag2 = flag.clone();
        struct CancelAfterN {
            n: u64,
            flag: CancelFlag,
            rec: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for CancelAfterN {
            fn progress(&self, update: ProcessProgress) {
                if update.lines_processed.unwrap_or(0) >= self.n
                    || update.files_processed.unwrap_or(0) >= 2
                {
                    self.flag.cancel();
                }
                self.rec.progress(update);
            }
        }
        let observer = CancelAfterN {
            n: 3_000,
            flag: flag2,
            rec: RecordingProcessProgress::default(),
        };
        let err = ingest_path_with_observer(
            dir.path(),
            &zip_path,
            "zip-cancel",
            None,
            "none",
            &observer,
            Some(&flag),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("cancelled"), "{err}");
        let phases = observer.rec.phases();
        assert!(
            phases.contains(&ProcessProgressPhase::Cancelled),
            "phases={phases:?}"
        );
        let updates = observer.rec.updates.lock().unwrap();
        assert!(
            updates.iter().any(|u| u.message.contains("zip member")
                || u.message.contains("streaming")
                || u.files_processed.unwrap_or(0) > 0),
            "expected zip stream progress: {:?}",
            updates.iter().map(|u| &u.message).collect::<Vec<_>>()
        );
        drop(updates);
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
        assert_no_ingest_staging(dir.path());
    }

    #[test]
    fn ingest_failure_checkpoints_preserve_existing_corpus_set_and_tree() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("app.log"),
            "ts=1700000000 level=error msg=connection refused\n",
        )
        .unwrap();

        let baseline = ingest_path(&cache, &logs, "baseline", None, "none").unwrap();
        let baseline_ids = LogCorpus::list_ids(&cache).unwrap();
        assert_eq!(baseline_ids, vec![baseline.corpus_id]);
        let baseline_tree = cache_tree_paths(&cache);
        let backend = ConceptEmbedBackend::new(16);

        for checkpoint in [
            IngestCheckpoint::CorpusCreated,
            IngestCheckpoint::EventsStored,
            IngestCheckpoint::BeforeTemplates,
            IngestCheckpoint::DuringEmbedding,
            IngestCheckpoint::BeforeSummary,
            IngestCheckpoint::BeforeValidation,
            IngestCheckpoint::BeforePublish,
        ] {
            let hook = |actual| {
                if actual == checkpoint {
                    Err(CoreError::Message(format!(
                        "injected ingest failure at {checkpoint:?}"
                    )))
                } else {
                    Ok(())
                }
            };
            let err = ingest_path_inner_with_fault(
                &cache,
                &logs,
                "must-not-publish",
                Some(&backend),
                "concept",
                LogEmbedMode::Local,
                None,
                &NoopProcessProgress,
                None,
                Some(&hook),
            )
            .unwrap_err();
            assert!(
                format!("{err}").contains("injected ingest failure"),
                "{checkpoint:?}: {err}"
            );
            assert_eq!(
                LogCorpus::list_ids(&cache).unwrap(),
                baseline_ids,
                "published a failed corpus at {checkpoint:?}"
            );
            assert_no_ingest_staging(&cache);
            assert_eq!(
                cache_tree_paths(&cache),
                baseline_tree,
                "cache tree changed at {checkpoint:?}"
            );
        }
    }

    #[test]
    fn malformed_zip_failure_leaves_no_partial_corpus_or_staging() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let zip_path = dir.path().join("broken.zip");
        std::fs::write(&zip_path, b"not a zip archive").unwrap();

        let err = ingest_path(&cache, &zip_path, "broken", None, "none").unwrap_err();
        assert!(format!("{err}").contains("zip open"), "{err}");
        assert!(LogCorpus::list_ids(&cache).unwrap().is_empty());
        assert_no_ingest_staging(&cache);
    }

    #[test]
    fn successful_ingest_publishes_one_validated_corpus_and_no_staging() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("app.log"), "error connection refused\n").unwrap();

        let report = ingest_path(&cache, &logs, "published", None, "none").unwrap();
        assert_eq!(
            LogCorpus::list_ids(&cache).unwrap(),
            vec![report.corpus_id.clone()]
        );
        let reopened = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(reopened.event_count() as u64, report.stats.lines);
        assert_eq!(reopened.template_count(), report.stats.templates);
        assert_no_ingest_staging(&cache);
    }

    #[test]
    fn content_hash_cache_skips_reembed_of_same_pattern() {
        // Two identical patterns in miner collapse to one template → one embed call path.
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("x.log")).unwrap();
        for i in 0..20 {
            writeln!(f, "connection refused to upstream host-{i}").unwrap();
        }
        let backend = ConceptEmbedBackend::new(64);
        let report = ingest_path(dir.path(), &logs, "h", Some(&backend), "concept").unwrap();
        assert_eq!(
            report.stats.embedded, report.stats.templates,
            "one embed per distinct template (content-hash keyed)"
        );
        assert!(report.stats.templates < 5);
    }

    #[test]
    fn ingest_emits_multi_phase_progress_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("app.log")).unwrap();
        for i in 0..80 {
            writeln!(f, "error connection refused host-{i}").unwrap();
        }
        let backend = ConceptEmbedBackend::new(32);
        let recorder = RecordingProcessProgress::default();
        let report = ingest_path_with_observer(
            dir.path(),
            &logs,
            "progress-fixture",
            Some(&backend),
            "concept",
            &recorder,
            None,
        )
        .unwrap();
        assert!(report.stats.lines >= 80);
        let phases = recorder.phases();
        assert!(
            phases.contains(&ProcessProgressPhase::Starting),
            "phases={phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Scan),
            "phases={phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Parse)
                || phases.contains(&ProcessProgressPhase::Template),
            "phases={phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Store)
                || phases.contains(&ProcessProgressPhase::Redact),
            "phases={phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Embed),
            "phases={phases:?}"
        );
        assert_eq!(
            phases.last().copied(),
            Some(ProcessProgressPhase::Completed)
        );
        let updates = recorder.updates.lock().unwrap();
        let completed = updates.last().expect("completed progress update");
        assert!(
            completed.message.contains("avg. events/template"),
            "{}",
            completed.message
        );
        assert!(
            !completed.message.contains("reduction"),
            "{}",
            completed.message
        );
        // No home-style absolute paths in messages
        for u in updates.iter() {
            assert!(
                !u.message.contains("/Users/"),
                "leaked path in message: {}",
                u.message
            );
            assert!(
                !u.message.contains("secret"),
                "unexpected secret token: {}",
                u.message
            );
        }
    }

    #[test]
    fn ingest_cancel_before_work_reports_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("a.log"), "error x\n").unwrap();
        let recorder = RecordingProcessProgress::default();
        let flag = CancelFlag::new();
        flag.cancel();
        let err = ingest_path_with_observer(
            dir.path(),
            &logs,
            "cancel-me",
            None,
            "concept",
            &recorder,
            Some(&flag),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("cancelled"), "{err}");
        assert!(recorder.phases().contains(&ProcessProgressPhase::Cancelled));
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
        assert_no_ingest_staging(dir.path());
    }

    #[test]
    fn zip_path_streams_members_not_full_extract() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/log_analysis/ingest.rs");
        let full = std::fs::read_to_string(&path).expect("read ingest.rs");
        let prod = full.split("#[cfg(test)]").next().expect("prod section");
        assert!(
            prod.contains("fn ingest_from_zip"),
            "zip stream path required"
        );
        assert!(
            !prod.contains("tempfile::tempdir"),
            "must not full-extract zip to temp before parse"
        );
        assert!(
            !prod.contains("read_to_string(file)"),
            "ingest must not read_to_string whole log members"
        );
        assert!(
            prod.contains("BufReader") || prod.contains("BufRead"),
            "must use line streaming"
        );
    }

    #[test]
    fn ingest_cancel_mid_stream_stops() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("big.log")).unwrap();
        for i in 0..50_000 {
            writeln!(f, "ts={} level=info msg=line {i}", 1_700_000_000 + i).unwrap();
        }
        let flag = CancelFlag::new();
        let flag2 = flag.clone();
        // Cancel after a short delay from another "thread" simulation: cancel
        // before call after first check would need async — cancel at start of
        // second file by pre-cancelling after scanning? Use a custom approach:
        // cancel immediately after Starting by racing — simplest: cancel mid-way
        // via a second observer that cancels when lines exceed a threshold.
        struct CancelAfterN {
            n: u64,
            flag: CancelFlag,
            rec: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for CancelAfterN {
            fn progress(&self, update: ProcessProgress) {
                if update.lines_processed.unwrap_or(0) >= self.n {
                    self.flag.cancel();
                }
                self.rec.progress(update);
            }
        }
        let rec = RecordingProcessProgress::default();
        let observer = CancelAfterN {
            n: 4_000,
            flag: flag2,
            rec,
        };
        let err = ingest_path_with_observer(
            dir.path(),
            &logs,
            "mid-cancel",
            None,
            "none",
            &observer,
            Some(&flag),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("cancelled"), "{err}");
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
        assert_no_ingest_staging(dir.path());
    }

    #[test]
    fn bulk_softwrite_no_embed_when_backend_none() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("a.log")).unwrap();
        for i in 0..100 {
            writeln!(f, "error connection refused {i}").unwrap();
        }
        let report = ingest_path(dir.path(), &logs, "no-embed", None, "none").unwrap();
        assert_eq!(report.stats.embedded, 0);
        assert!(report.stats.lines >= 100);
    }

    #[test]
    fn local_policy_embeds_ordinary_input_and_defers_above_exact_byte_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("app.log");
        std::fs::write(&logs, "ts=1700000000 level=error msg=connection refused\n").unwrap();
        let backend: Arc<dyn EmbedBackend> = Arc::new(ConceptEmbedBackend::new(32));

        let mut ordinary = LogEmbedPolicy::local_default();
        ordinary.model_id = "concept-local".into();
        ordinary.defer_above_source_bytes = Some(u64::MAX);
        let embedded = ingest_path_with_policy(
            dir.path(),
            &logs,
            "ordinary",
            &ordinary,
            Some(backend.clone()),
        )
        .unwrap();
        assert!(embedded.stats.embedded > 0);
        assert_eq!(embedded.embedding.state, EmbeddingState::Complete);
        assert_eq!(
            embedded.embedding.model_id.as_deref(),
            Some("concept-local")
        );

        let mut bulk = ordinary;
        bulk.defer_above_source_bytes = Some(1);
        let deferred =
            ingest_path_with_policy(dir.path(), &logs, "bulk", &bulk, Some(backend)).unwrap();
        assert_eq!(deferred.stats.embedded, 0);
        assert_eq!(deferred.embedding.state, EmbeddingState::Deferred);
        assert_eq!(
            LogCorpus::open(dir.path(), &deferred.corpus_id)
                .unwrap()
                .embedding_status(),
            deferred.embedding
        );
    }

    #[test]
    fn progress_includes_line_byte_advances_on_large_file() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("huge.log")).unwrap();
        // > PROGRESS_EVERY_LINES so we get mid-file parse updates
        for i in 0..(PROGRESS_EVERY_LINES as usize * 3 + 10) {
            writeln!(f, "info line number {i} padding padding").unwrap();
        }
        let recorder = RecordingProcessProgress::default();
        let report = ingest_path_with_observer(
            dir.path(),
            &logs,
            "prog-lines",
            None,
            "none",
            &recorder,
            None,
        )
        .unwrap();
        assert!(report.stats.lines > PROGRESS_EVERY_LINES);
        let updates = recorder.updates.lock().unwrap();
        let with_lines: Vec<_> = updates
            .iter()
            .filter(|u| u.lines_processed.unwrap_or(0) >= PROGRESS_EVERY_LINES)
            .collect();
        assert!(
            with_lines.len() >= 2,
            "expected multiple line-progress updates, got {}",
            with_lines.len()
        );
        assert!(
            updates.iter().any(|u| u.bytes_processed.unwrap_or(0) > 0),
            "expected bytes_processed on some updates"
        );
    }

    #[test]
    fn directory_reporting_separates_imported_excluded_failed_and_ignored() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let safe = b"level=info msg=started\nlevel=error msg=Bearer test-secret-token\n";
        std::fs::write(logs.join("safe.log"), safe).unwrap();
        std::fs::write(logs.join("binary.log"), b"prefix\0binary").unwrap();
        std::fs::write(logs.join(".hidden.log"), b"must be ignored\n").unwrap();
        std::fs::write(logs.join("vanish.log"), b"unreadable after scan\n").unwrap();
        let oversized = std::fs::File::create(logs.join("oversized.log")).unwrap();
        oversized.set_len(DEFAULT_MAX_FILE_BYTES + 1).unwrap();

        struct RemoveAfterScan {
            path: PathBuf,
            removed: AtomicBool,
            recorder: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for RemoveAfterScan {
            fn progress(&self, update: ProcessProgress) {
                if update.message.starts_with("found ")
                    && !self.removed.swap(true, Ordering::SeqCst)
                {
                    std::fs::remove_file(&self.path).unwrap();
                }
                self.recorder.progress(update);
            }
        }

        let observer = RemoveAfterScan {
            path: logs.join("vanish.log"),
            removed: AtomicBool::new(false),
            recorder: RecordingProcessProgress::default(),
        };
        let report = ingest_path_with_observer(
            &cache,
            &logs,
            "honest-directory",
            None,
            "none",
            &observer,
            None,
        )
        .unwrap();

        assert_eq!(report.stats.discovered_files, 5);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.excluded_files, 2);
        assert_eq!(report.stats.failed_files, 1);
        assert_eq!(report.stats.ignored_files, 1);
        assert_eq!(report.stats.source_bytes, safe.len() as u64);
        assert!(report.stats.partial);
        assert_eq!(report.stats.exclusion_counts["binary"], 1);
        assert_eq!(report.stats.exclusion_counts["too_large"], 1);
        assert_eq!(report.stats.exclusion_counts["metadata_failed"], 1);
        assert_eq!(report.stats.exclusion_counts["hidden"], 1);
        assert!(report.stats.exclusion_examples.len() <= MAX_EXCLUSION_EXAMPLES);
        assert!(report
            .stats
            .exclusion_examples
            .iter()
            .all(|example| !example.contains(dir.path().to_string_lossy().as_ref())));

        let updates = observer.recorder.updates.lock().unwrap();
        let byte_updates: Vec<u64> = updates
            .iter()
            .filter_map(|update| update.bytes_processed)
            .collect();
        assert!(
            byte_updates.windows(2).all(|pair| pair[0] <= pair[1]),
            "progress bytes regressed: {byte_updates:?}"
        );
        assert_eq!(
            byte_updates.last().copied().unwrap_or_default(),
            report.stats.source_bytes,
            "completed progress reports source bytes actually streamed"
        );
        let diagnostics = format!("{:?} {:?}", report.stats, *updates);
        assert!(!diagnostics.contains("test-secret-token"), "{diagnostics}");
        assert!(!diagnostics.contains("/Users/"), "{diagnostics}");

        let reopened = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let persisted = reopened.meta().unwrap().stats.unwrap();
        assert_eq!(persisted.discovered_files, 5);
        assert_eq!(persisted.files, 1);
        assert!(persisted.partial);
    }

    #[test]
    fn zip_reporting_uses_the_same_counter_semantics() {
        use std::io::Write as _;

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let zip_path = dir.path().join("mixed.zip");
        let safe = b"level=info msg=safe zip line\n";
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.add_directory("ignored/", opts).unwrap();
            zip.start_file("safe.log", opts).unwrap();
            zip.write_all(safe).unwrap();
            zip.start_file("binary.log", opts).unwrap();
            zip.write_all(b"prefix\0binary").unwrap();
            zip.finish().unwrap();
        }

        let report = ingest_path(&cache, &zip_path, "honest-zip", None, "none").unwrap();
        assert_eq!(report.stats.discovered_files, 3);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.excluded_files, 1);
        assert_eq!(report.stats.failed_files, 0);
        assert_eq!(report.stats.ignored_files, 1);
        assert_eq!(report.stats.source_bytes, safe.len() as u64);
        assert_eq!(report.stats.exclusion_counts["binary"], 1);
        assert_eq!(report.stats.exclusion_counts["directory"], 1);
        assert!(report.stats.partial);
    }

    #[test]
    fn empty_directory_fails_without_publishing_a_corpus() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("empty");
        std::fs::create_dir_all(&logs).unwrap();

        let err = ingest_path(&cache, &logs, "empty", None, "none").unwrap_err();
        assert!(
            format!("{err}").contains("no importable log file entries"),
            "{err}"
        );
        assert!(LogCorpus::list_ids(&cache).unwrap().is_empty());
        assert_no_ingest_staging(&cache);
    }
}
