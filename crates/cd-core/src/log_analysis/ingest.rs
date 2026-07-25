//! Path/dir ingest orchestration (#355–#359, #362 core) + multi-phase progress (#445).

use super::drain::DrainMiner;
use super::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use super::parse::{detect_format, parse_line, LogFormat};
use super::redact_log::{redact_message, redact_params};
use super::store::{template_content_hash, LogCorpus, LogEvent, TemplateRow, TopTemplateSnapshot};
use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use crate::memory::embed_blocking;
use crate::process_progress::{
    progress_basename, CancelFlag, NoopProcessProgress, ProcessProgress, ProcessProgressKind,
    ProcessProgressObserver, ProcessProgressPhase,
};
use std::io::{BufRead, BufReader, Read};
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
    ingest_path_inner(cache_root, path, name, embed, embed_model, progress, cancel)
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
    path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("zip"))
            .unwrap_or(false)
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
    batch: &mut Vec<LogEvent>,
    format_hint: &mut Option<LogFormat>,
    files_done: u64,
    file_count: u64,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    kind: ProcessProgressKind,
) -> CoreResult<bool> {
    let mut raw_line = Vec::new();
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
        let bytes = match reader.read_until(b'\n', &mut raw_line) {
            Ok(0) => break,
            Ok(bytes) => bytes,
            Err(_) => return Ok(false),
        };
        stats.source_bytes = stats.source_bytes.saturating_add(bytes as u64);
        let line = String::from_utf8_lossy(&raw_line);
        let line = line.trim_end_matches(['\r', '\n']);
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
        batch.push(LogEvent {
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
            corpus.push_events(batch)?;
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
    batch: &mut Vec<LogEvent>,
    format_hint: &mut Option<LogFormat>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    kind: ProcessProgressKind,
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

    let file =
        std::fs::File::open(zip_path).map_err(|e| CoreError::Message(format!("open zip: {e}")))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| CoreError::Message(format!("zip open: {e}")))?;
    let entry_count = archive.len() as u64;

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

        let mut entry = archive
            .by_index(i)
            .map_err(|e| CoreError::Message(format!("zip entry: {e}")))?;
        let name = entry.name().to_string();
        stats.discover();
        if name.ends_with('/') {
            stats.ignored("directory", Path::new(&name));
            files_done += 1;
            continue;
        }
        let rel = name.trim_start_matches('/');
        if rel.is_empty()
            || std::path::Path::new(rel)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(CoreError::Policy(format!("zip-slip rejected: `{name}`")));
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
                    progress_basename(std::path::Path::new(rel))
                ),
                true,
            )
            .with_fraction(0.1 + 0.05 * ((i as f32 + 1.0) / entry_count.max(1) as f32))
            .with_files(files_done)
            .with_lines(stats.lines)
            .with_bytes(stats.source_bytes),
        );

        if size > DEFAULT_MAX_FILE_BYTES {
            stats.excluded("too_large", Path::new(rel));
            files_done += 1;
            continue;
        }

        // Sample first bytes for binary without loading whole entry.
        let mut head = [0u8; 8192];
        let n = match entry.read(&mut head) {
            Ok(n) => n,
            Err(_) => {
                stats.failed("read_failed", Path::new(rel));
                files_done += 1;
                continue;
            }
        };
        if head[..n].contains(&0) {
            stats.excluded("binary", Path::new(rel));
            files_done += 1;
            // Drain remaining entry to keep archive state consistent
            let mut sink = std::io::sink();
            let _ = std::io::copy(&mut entry, &mut sink);
            continue;
        }

        // Chain head + rest of entry for line parsing.
        let rest = BufReader::with_capacity(64 * 1024, entry);
        let mut chained = std::io::Cursor::new(head[..n].to_vec()).chain(rest);
        let mut reader = BufReader::with_capacity(64 * 1024, &mut chained);

        let completely_read = ingest_lines_from_reader(
            &mut reader,
            rel,
            None,
            corpus,
            miner,
            stats,
            seq,
            batch,
            format_hint,
            files_done,
            entry_count,
            progress,
            cancel,
            kind,
        )?;

        files_done += 1;
        if completely_read {
            stats.imported();
        } else {
            stats.failed("read_failed", Path::new(rel));
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

fn ingest_path_inner(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
) -> CoreResult<IngestReport> {
    ingest_path_inner_with_fault(
        cache_root,
        path,
        name,
        embed,
        embed_model,
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
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
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
        progress,
        cancel,
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
                "ingested {} lines → {} templates ({:.1}× reduction)",
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
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    fault: IngestFaultHook<'_>,
) -> CoreResult<IngestReport> {
    let _ = embed_model;
    let kind = ProcessProgressKind::LogIngest;
    let source_label = progress_basename(path);

    let corpus = LogCorpus::create(cache_root, name)?;
    check_ingest_fault(fault, IngestCheckpoint::CorpusCreated)?;
    let mut miner = DrainMiner::default();
    let mut stats = IngestStats::default();
    let mut seq = 0u64;
    let mut batch = Vec::with_capacity(256);
    let mut format_hint: Option<LogFormat> = None;
    let files_done = if is_zip_file(path) {
        // Stream members without full extract-to-temp (#499 skeptic fix).
        ingest_from_zip(
            path,
            &corpus,
            &mut miner,
            &mut stats,
            &mut seq,
            &mut batch,
            &mut format_hint,
            progress,
            cancel,
            kind,
        )?
    } else {
        let inventory = collect_log_files(path)?;
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

            let file_bytes = match std::fs::metadata(file) {
                Ok(metadata) => metadata.len(),
                Err(_) => {
                    stats.failed("metadata_failed", file);
                    files_done += 1;
                    continue;
                }
            };
            if file_bytes > DEFAULT_MAX_FILE_BYTES {
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
                            DEFAULT_MAX_FILE_BYTES
                        ),
                        true,
                    )
                    .with_fraction(0.15 + 0.45 * (files_done as f32 / file_count.max(1) as f32))
                    .with_lines(stats.lines)
                    .with_files(files_done),
                );
                continue;
            }

            let mut fh = match std::fs::File::open(file) {
                Ok(file) => file,
                Err(_) => {
                    stats.failed("open_failed", file);
                    files_done += 1;
                    continue;
                }
            };
            let mut head = [0u8; 8192];
            let n = match fh.read(&mut head) {
                Ok(n) => n,
                Err(_) => {
                    stats.failed("read_failed", file);
                    files_done += 1;
                    continue;
                }
            };
            if head[..n].contains(&0) {
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
            let rel = rel_path.to_string_lossy().to_string();

            let rest = BufReader::with_capacity(64 * 1024, fh);
            let mut chained = std::io::Cursor::new(head[..n].to_vec()).chain(rest);
            let mut reader = BufReader::with_capacity(64 * 1024, &mut chained);
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
        corpus.push_events(&batch)?;
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
    let mut embedded = 0usize;
    if let Some(backend) = embed {
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
    )?;

    Ok(IngestReport {
        corpus_id: corpus.id().to_string(),
        stats,
        top_templates: top,
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
}

fn collect_log_files(path: &Path) -> CoreResult<FileInventory> {
    let mut out = FileInventory::default();
    if path.is_file() {
        out.files.push(path.to_path_buf());
        return Ok(out);
    }
    if path.is_dir() {
        walk_dir(path, &mut out)?;
    } else {
        return Err(CoreError::Message("log source does not exist".into()));
    }
    out.files.sort();
    out.ignored.sort();
    Ok(out)
}

fn walk_dir(dir: &Path, out: &mut FileInventory) -> CoreResult<()> {
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        let p = e.path();
        if p.is_dir() {
            walk_dir(&p, out)?;
        } else if p.is_file() {
            // skip obvious binaries
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.starts_with('.') {
                out.ignored.push(p);
                continue;
            }
            out.files.push(p);
        }
    }
    Ok(())
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
        // No home-style absolute paths in messages
        for u in recorder.updates.lock().unwrap().iter() {
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
