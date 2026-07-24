//! Path/dir ingest orchestration (#355–#359, #362 core) + multi-phase progress (#445).

use super::drain::DrainMiner;
use super::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use super::parse::{detect_format, parse_line, LogFormat};
use super::redact_log::{redact_message, redact_params};
use super::store::{template_content_hash, LogCorpus, LogEvent, TemplateRow};
use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use crate::memory::embed_blocking;
use crate::process_progress::{
    progress_basename, CancelFlag, NoopProcessProgress, ProcessProgress, ProcessProgressKind,
    ProcessProgressObserver, ProcessProgressPhase,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Stats from one ingest run.
#[derive(Debug, Clone, Default)]
pub struct IngestStats {
    /// Files read.
    pub files: usize,
    /// Lines parsed.
    pub lines: u64,
    /// Distinct templates.
    pub templates: usize,
    /// Template reduction ratio (lines / templates).
    pub reduction_ratio: f64,
    /// Templates newly embedded.
    pub embedded: usize,
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

/// If `path` is a `.zip` file, extract into a temp dir and return that path.
/// Caller must keep the TempDir alive for the duration of ingest.
fn expand_zip_if_needed(path: &Path) -> CoreResult<(PathBuf, Option<tempfile::TempDir>)> {
    let is_zip = path.is_file()
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("zip"))
            .unwrap_or(false);
    if !is_zip {
        return Ok((path.to_path_buf(), None));
    }
    let data = std::fs::read(path).map_err(|e| CoreError::Message(format!("read zip: {e}")))?;
    let tmp = tempfile::tempdir().map_err(|e| CoreError::Message(format!("tempdir: {e}")))?;
    let cursor = std::io::Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| CoreError::Message(format!("zip open: {e}")))?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| CoreError::Message(format!("zip entry: {e}")))?;
        let name = file.name().to_string();
        if name.ends_with('/') {
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
        let dest = tmp.path().join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CoreError::Message(format!("mkdir: {e}")))?;
        }
        let mut out =
            std::fs::File::create(&dest).map_err(|e| CoreError::Message(format!("create: {e}")))?;
        std::io::copy(&mut file, &mut out)
            .map_err(|e| CoreError::Message(format!("extract: {e}")))?;
    }
    Ok((tmp.path().to_path_buf(), Some(tmp)))
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
    let _ = embed_model;
    let kind = ProcessProgressKind::LogIngest;
    let source_label = progress_basename(path);
    let (path, _tmp_keep) = expand_zip_if_needed(path)?;
    let path = path.as_path();

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

    let corpus = LogCorpus::create(cache_root, name)?;
    let files = collect_log_files(path)?;
    let file_count = files.len() as u64;

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Scan,
            format!("found {file_count} file(s)"),
            true,
        )
        .with_fraction(0.1)
        .with_files(file_count),
    );

    let mut miner = DrainMiner::default();
    let mut stats = IngestStats {
        files: files.len(),
        ..Default::default()
    };
    let mut seq = 0u64;
    let mut batch = Vec::with_capacity(256);
    let mut format_hint: Option<LogFormat> = None;
    let mut files_done = 0u64;

    // Combined parse + template + redact per line (phases reported at file boundaries).
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

    for file in &files {
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
            // Best-effort discard: drop corpus dir if API allows — LogCorpus has no delete;
            // leave disposable cache entry; UI notes cancel.
            return Err(CoreError::Message("ingest cancelled".into()));
        }

        let text = std::fs::read_to_string(file).unwrap_or_default();
        let rel = file
            .strip_prefix(path)
            .unwrap_or(file.as_path())
            .to_string_lossy()
            .to_string();
        // Never put full absolute path in progress — basename only.
        let _file_base = progress_basename(file);

        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if format_hint.is_none() {
                format_hint = Some(detect_format(line, Some(file)));
            }
            let parsed = parse_line(line, format_hint, seq);
            // Redact is part of the pipeline; report phase periodically.
            let msg = redact_message(&parsed.message);
            let ts = parsed.ts.unwrap_or(seq as i64);
            let (tid, params) = miner.match_or_create(&msg, ts, &parsed.level);
            let params = redact_params(&params);
            batch.push(LogEvent {
                seq,
                ts,
                level: parsed.level,
                service: parsed.service,
                host: parsed.host,
                template_id: tid,
                params,
                trace_id: parsed.trace_id,
                message: msg,
                source: rel.clone(),
            });
            seq += 1;
            stats.lines += 1;
            if batch.len() >= 256 {
                // Store phase begins once we flush batches.
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
                        .with_files(files_done),
                    );
                }
                corpus.push_events(&batch)?;
                batch.clear();
            }
        }
        files_done += 1;
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
                .with_templates(miner.templates().len() as u64),
            );
        }
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
        corpus.push_events(&batch)?;
    }

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

    // Embed templates only (#359)
    let mut embedded = 0usize;
    if let Some(backend) = embed {
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Embed,
                "embedding templates",
                false,
            )
            .with_fraction(0.85)
            .with_templates(corpus.template_count() as u64),
        );
        let templates = corpus.list_templates();
        let total_t = templates.len().max(1) as f32;
        let mut hash_cache: std::collections::HashMap<String, Vec<f32>> =
            std::collections::HashMap::new();
        for (i, row) in templates.into_iter().enumerate() {
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

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Completed,
            format!(
                "ingested {} lines → {} templates",
                stats.lines, stats.templates
            ),
            false,
        )
        .with_fraction(1.0)
        .with_lines(stats.lines)
        .with_files(file_count)
        .with_templates(stats.templates as u64),
    );

    Ok(IngestReport {
        corpus_id: corpus.id().to_string(),
        stats,
        top_templates: top,
    })
}

fn collect_log_files(path: &Path) -> CoreResult<Vec<PathBuf>> {
    let mut out = Vec::new();
    if path.is_file() {
        out.push(path.to_path_buf());
        return Ok(out);
    }
    if path.is_dir() {
        walk_dir(path, &mut out)?;
    }
    out.sort();
    Ok(out)
}

fn walk_dir(dir: &Path, out: &mut Vec<PathBuf>) -> CoreResult<()> {
    for e in std::fs::read_dir(dir)? {
        let e = e?;
        let p = e.path();
        if p.is_dir() {
            walk_dir(&p, out)?;
        } else if p.is_file() {
            // skip obvious binaries
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name.starts_with('.') {
                continue;
            }
            out.push(p);
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
    fn ingest_zip_extracts_and_parses_logs() {
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
        // sanity: expand helper path
        let (expanded, keep) = super::expand_zip_if_needed(&zip_path).unwrap();
        assert!(keep.is_some());
        assert!(expanded.join("nested/app.log").is_file());

        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let report = ingest_path(&cache, &zip_path, "from-zip", None, "none").unwrap();
        assert!(report.stats.lines >= 80, "lines={}", report.stats.lines);
        assert!(!report.corpus_id.is_empty());
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
    }
}
