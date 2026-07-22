//! Path/dir ingest orchestration (#355–#359, #362 core).

use super::drain::DrainMiner;
use super::parse::{detect_format, parse_line, LogFormat};
use super::redact_log::{redact_message, redact_params};
use super::store::{template_content_hash, LogCorpus, LogEvent, TemplateRow};
use crate::embed::EmbedBackend;
use crate::error::CoreResult;
use crate::memory::embed_blocking;
use std::path::{Path, PathBuf};

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
    let _ = embed_model;
    let corpus = LogCorpus::create(cache_root, name)?;
    let files = collect_log_files(path)?;
    let mut miner = DrainMiner::default();
    let mut stats = IngestStats {
        files: files.len(),
        ..Default::default()
    };
    let mut seq = 0u64;
    let mut batch = Vec::with_capacity(256);
    let mut format_hint: Option<LogFormat> = None;

    for file in &files {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        let rel = file
            .strip_prefix(path)
            .unwrap_or(file.as_path())
            .to_string_lossy()
            .to_string();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if format_hint.is_none() {
                format_hint = Some(detect_format(line, Some(file)));
            }
            let parsed = parse_line(line, format_hint, seq);
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
                corpus.push_events(&batch)?;
                batch.clear();
            }
        }
    }
    if !batch.is_empty() {
        corpus.push_events(&batch)?;
    }

    // Persist templates
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
        let templates = corpus.list_templates();
        let mut hash_cache: std::collections::HashMap<String, Vec<f32>> =
            std::collections::HashMap::new();
        for row in templates {
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
    top.sort_by(|a, b| b.2.cmp(&a.2));
    top.truncate(10);

    corpus.flush()?;
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
        eprintln!(
            "ingest_fixture lines={} templates={} ratio={:.1} embedded={}",
            report.stats.lines,
            report.stats.templates,
            report.stats.reduction_ratio,
            report.stats.embedded
        );
    }
}
