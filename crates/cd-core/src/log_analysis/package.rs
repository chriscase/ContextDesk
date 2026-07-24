//! Portable log-corpus package export/import (`contextdesk.log_corpus.v1`).
//!
//! ## Versioning (compat contract)
//!
//! - `format_version`: exact schema id (`contextdesk.log_corpus.vN`).
//! - `min_reader_version`: integer this binary must support (`PACKAGE_READER_VERSION`).
//! - Additive changes within a major: optional JSON fields / optional files only.
//! - Breaking changes require a new major and dual-path importers for N and N−1.
//! - Readers **ignore unknown JSON fields**; missing optionals use defaults.
//! - Too-new packages refuse **before** writing under `log_corpora/`.
//!
//! Zip layout:
//! ```text
//! manifest.json
//! meta.json
//! events.duckdb
//! templates.json
//! README.txt
//! ```

use super::store::{
    dir_size, write_meta_file, CorpusMeta, CorpusStats, LogCorpus, EVENT_ENGINE, META_VERSION,
};
use crate::error::{CoreError, CoreResult};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::Path;
use uuid::Uuid;

/// Package format id for packages written by this build.
pub const PACKAGE_FORMAT_VERSION: &str = "contextdesk.log_corpus.v1";
/// Package kind.
pub const PACKAGE_KIND: &str = "log_corpus";
/// Reader capability version for this binary (bump when import rules change incompatibly).
pub const PACKAGE_READER_VERSION: u32 = 1;
/// Max compressed package size on import (2 GiB).
pub const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Max entries in package zip.
pub const MAX_PACKAGE_ENTRIES: usize = 32;

/// One file entry in the package manifest.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFileEntry {
    /// Relative path inside the package.
    pub path: String,
    /// Hex SHA-256 of file bytes.
    pub sha256: String,
    /// Uncompressed size in bytes.
    pub bytes: u64,
}

/// Package manifest (shipped inside the zip).
///
/// Unknown JSON fields are ignored (`deny_unknown_fields` is **not** set).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    /// Package format version string.
    pub format_version: String,
    /// Oldest reader version that can import this package.
    #[serde(default = "default_min_reader_version")]
    pub min_reader_version: u32,
    /// Package kind (`log_corpus`).
    pub package_kind: String,
    /// Export time (unix secs).
    pub created_at: i64,
    /// Origin corpus id at export.
    pub corpus_id: String,
    /// Display name.
    pub name: String,
    /// Event engine id.
    pub engine: String,
    /// Optional feature tags (additive; unknown tags ignored by readers).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub features: Vec<String>,
    /// Optional writer diagnostics (never required for import).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer_app_version: Option<String>,
    /// Payload file entries with hashes.
    pub files: Vec<PackageFileEntry>,
    /// Stats snapshot when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<CorpusStats>,
}

fn default_min_reader_version() -> u32 {
    1
}

/// Result of importing a package.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageImportReport {
    /// New local corpus id after import.
    pub corpus_id: String,
    /// Display name.
    pub name: String,
    /// Corpus id from the package origin.
    pub origin_corpus_id: String,
    /// Stats snapshot when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<CorpusStats>,
}

/// Validate format_version + min_reader_version before any cache writes.
pub fn validate_package_versions(format_version: &str, min_reader_version: u32) -> CoreResult<()> {
    // Supported majors: v1 only for now (dual-path window starts when v2 lands).
    if !format_version.starts_with("contextdesk.log_corpus.v") {
        return Err(CoreError::Message(format!(
            "unsupported package format_version: {format_version} \
             (this build supports {PACKAGE_FORMAT_VERSION})"
        )));
    }
    // Parse trailing major digit(s) after `.v`
    let major = format_version
        .rsplit(".v")
        .next()
        .and_then(|s| s.parse::<u32>().ok());
    match major {
        Some(1) => {}
        Some(n) if n > 1 => {
            return Err(CoreError::Message(format!(
                "This package requires ContextDesk package reader for format {format_version} \
                 (this build supports {PACKAGE_FORMAT_VERSION} / reader {PACKAGE_READER_VERSION}). \
                 Re-export from a matching app or upgrade ContextDesk."
            )));
        }
        _ => {
            return Err(CoreError::Message(format!(
                "unsupported package format_version: {format_version}"
            )));
        }
    }
    if min_reader_version > PACKAGE_READER_VERSION {
        return Err(CoreError::Message(format!(
            "This package requires ContextDesk package reader ≥ {min_reader_version} \
             (this build supports {PACKAGE_READER_VERSION}). \
             Upgrade ContextDesk or ask the sender for an older package."
        )));
    }
    Ok(())
}

/// Export an existing corpus directory into a portable zip at `out_path`.
pub fn export_corpus_zip(
    cache_root: &Path,
    corpus_id: &str,
    out_path: &Path,
) -> CoreResult<PackageManifest> {
    // Open, flush, snapshot meta, then **drop** the handle before reading
    // `events.duckdb` — Windows exclusive-locks the DuckDB file while open.
    let (root, meta) = {
        let corpus = LogCorpus::open(cache_root, corpus_id)?;
        corpus.flush()?;
        let root = corpus.root().to_path_buf();
        let meta = corpus.meta()?;
        (root, meta)
    };

    let payloads = ["meta.json", "events.duckdb", "templates.json"];
    let mut files = Vec::new();
    let mut file_bytes: Vec<(String, Vec<u8>)> = Vec::new();
    let mut features = vec!["events_duckdb".into(), "templates_json".into()];
    for name in payloads {
        let p = root.join(name);
        if !p.exists() {
            if name == "templates.json" {
                let empty = b"[]".to_vec();
                files.push(PackageFileEntry {
                    path: name.into(),
                    sha256: hex_sha256(&empty),
                    bytes: empty.len() as u64,
                });
                file_bytes.push((name.into(), empty));
                continue;
            }
            return Err(CoreError::Message(format!(
                "corpus package missing required file: {name}"
            )));
        }
        let data =
            std::fs::read(&p).map_err(|e| CoreError::Message(format!("read {name}: {e}")))?;
        if name == "templates.json" {
            if let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&data) {
                if rows.iter().any(|r| r.get("vector").is_some()) {
                    features.push("template_vectors".into());
                }
            }
        }
        files.push(PackageFileEntry {
            path: name.into(),
            sha256: hex_sha256(&data),
            bytes: data.len() as u64,
        });
        file_bytes.push((name.into(), data));
    }
    if meta.stats.is_some() {
        features.push("corpus_stats".into());
    }

    let manifest = PackageManifest {
        format_version: PACKAGE_FORMAT_VERSION.into(),
        min_reader_version: PACKAGE_READER_VERSION,
        package_kind: PACKAGE_KIND.into(),
        created_at: crate::embed::now_unix_secs(),
        corpus_id: meta.id.clone(),
        name: meta.name.clone(),
        engine: meta.engine.clone(),
        features,
        writer_app_version: None,
        files,
        stats: meta.stats.clone(),
    };

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    let readme = format!(
        "ContextDesk log corpus package ({PACKAGE_FORMAT_VERSION})\n\
         min_reader_version: {}\n\
         \n\
         Name: {}\n\
         Corpus id: {}\n\
         Engine: {}\n\
         \n\
         Import via Logs → Import package… (SoftWrite).\n\
         Contains redacted analysis artifacts — share only with trusted peers.\n",
        manifest.min_reader_version, manifest.name, manifest.corpus_id, manifest.engine
    );

    let file = std::fs::File::create(out_path)
        .map_err(|e| CoreError::Message(format!("create package: {e}")))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("manifest.json", opts)
        .map_err(|e| CoreError::Message(format!("zip: {e}")))?;
    zip.write_all(&manifest_bytes)
        .map_err(|e| CoreError::Message(format!("zip write: {e}")))?;

    zip.start_file("README.txt", opts)
        .map_err(|e| CoreError::Message(format!("zip: {e}")))?;
    zip.write_all(readme.as_bytes())
        .map_err(|e| CoreError::Message(format!("zip write: {e}")))?;

    for (name, data) in file_bytes {
        zip.start_file(&name, opts)
            .map_err(|e| CoreError::Message(format!("zip: {e}")))?;
        zip.write_all(&data)
            .map_err(|e| CoreError::Message(format!("zip write: {e}")))?;
    }

    zip.finish()
        .map_err(|e| CoreError::Message(format!("zip finish: {e}")))?;
    let _ = root;
    Ok(manifest)
}

/// Import a portable package zip into a new corpus under `cache_root`.
/// Always assigns a **new** corpus id; stores `origin_corpus_id` in meta.
///
/// On validation failure, no new directory is left under `log_corpora/`.
pub fn import_corpus_zip(cache_root: &Path, zip_bytes: &[u8]) -> CoreResult<PackageImportReport> {
    if zip_bytes.len() as u64 > MAX_PACKAGE_BYTES {
        return Err(CoreError::Policy(format!(
            "package exceeds max size ({} bytes)",
            MAX_PACKAGE_BYTES
        )));
    }
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| CoreError::Message(format!("zip open: {e}")))?;
    if archive.len() > MAX_PACKAGE_ENTRIES {
        return Err(CoreError::Policy("package has too many entries".into()));
    }

    let mut entries: std::collections::HashMap<String, Vec<u8>> = std::collections::HashMap::new();
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
            || rel.contains("..")
        {
            return Err(CoreError::Policy(format!("zip-slip rejected: `{name}`")));
        }
        if rel.contains('/') || rel.contains('\\') {
            return Err(CoreError::Policy(format!(
                "package paths must be flat files: `{rel}`"
            )));
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .map_err(|e| CoreError::Message(format!("zip read: {e}")))?;
        entries.insert(rel.to_string(), data);
    }

    let manifest_bytes = entries
        .get("manifest.json")
        .ok_or_else(|| CoreError::Message("package missing manifest.json".into()))?;
    // Ignore unknown fields via default serde.
    let manifest: PackageManifest = serde_json::from_slice(manifest_bytes)
        .map_err(|e| CoreError::Message(format!("manifest parse: {e}")))?;

    // Version gate BEFORE any cache write.
    validate_package_versions(&manifest.format_version, manifest.min_reader_version)?;

    if manifest.package_kind != PACKAGE_KIND {
        return Err(CoreError::Message(format!(
            "unsupported package_kind: {}",
            manifest.package_kind
        )));
    }
    if manifest.engine != EVENT_ENGINE {
        return Err(CoreError::Message(format!(
            "unsupported package engine: {} (want {EVENT_ENGINE})",
            manifest.engine
        )));
    }

    for required in ["meta.json", "events.duckdb"] {
        if !entries.contains_key(required) {
            return Err(CoreError::Message(format!(
                "package missing required file: {required}"
            )));
        }
    }
    for fe in &manifest.files {
        if let Some(data) = entries.get(&fe.path) {
            let h = hex_sha256(data);
            if h != fe.sha256 {
                return Err(CoreError::Message(format!(
                    "package hash mismatch for {}",
                    fe.path
                )));
            }
        }
    }

    let origin_id = manifest.corpus_id.clone();
    let new_id = Uuid::now_v7().to_string();
    let dest = cache_root.join("log_corpora").join(&new_id);

    // Write under a temp sibling, then rename — on failure remove partial.
    let staging = cache_root
        .join("log_corpora")
        .join(format!(".import-{new_id}"));
    if let Err(e) = materialize_package(&staging, &entries, &manifest, &new_id, &origin_id) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    std::fs::create_dir_all(cache_root.join("log_corpora"))
        .map_err(|e| CoreError::Message(format!("mkdir log_corpora: {e}")))?;
    if let Err(e) = std::fs::rename(&staging, &dest) {
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::remove_dir_all(&dest);
        return Err(CoreError::Message(format!("finalize import: {e}")));
    }

    let opened = match LogCorpus::open(cache_root, &new_id) {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(e);
        }
    };
    Ok(PackageImportReport {
        corpus_id: new_id,
        name: opened.name().to_string(),
        origin_corpus_id: origin_id,
        stats: opened.meta()?.stats,
    })
}

fn materialize_package(
    dest: &Path,
    entries: &std::collections::HashMap<String, Vec<u8>>,
    manifest: &PackageManifest,
    new_id: &str,
    origin_id: &str,
) -> CoreResult<()> {
    std::fs::create_dir_all(dest).map_err(|e| CoreError::Message(format!("mkdir: {e}")))?;

    for name in ["events.duckdb", "templates.json"] {
        if let Some(data) = entries.get(name) {
            std::fs::write(dest.join(name), data)
                .map_err(|e| CoreError::Message(format!("write {name}: {e}")))?;
        }
    }
    if !entries.contains_key("templates.json") {
        std::fs::write(dest.join("templates.json"), b"[]")
            .map_err(|e| CoreError::Message(format!("write templates: {e}")))?;
    }

    let meta_raw = entries
        .get("meta.json")
        .ok_or_else(|| CoreError::Message("package missing meta.json".into()))?;
    let mut meta: CorpusMeta = match serde_json::from_slice(meta_raw) {
        Ok(m) => m,
        Err(_) => CorpusMeta {
            meta_version: META_VERSION,
            id: new_id.to_string(),
            name: manifest.name.clone(),
            created_at: crate::embed::now_unix_secs(),
            engine: EVENT_ENGINE.into(),
            license: "MIT (duckdb-rs + DuckDB)".into(),
            vector_index: "pure-rust VectorIndex (Exact/Hnsw)".into(),
            source_label: Some(format!("import:{origin_id}")),
            origin_corpus_id: Some(origin_id.to_string()),
            stats: manifest.stats.clone(),
            top_templates: Vec::new(),
        },
    };
    meta.meta_version = META_VERSION;
    meta.id = new_id.to_string();
    meta.origin_corpus_id = Some(origin_id.to_string());
    if meta.name.trim().is_empty() {
        meta.name = manifest.name.clone();
    }
    meta.engine = EVENT_ENGINE.into();
    if meta.stats.is_none() {
        meta.stats = manifest.stats.clone();
    }
    let stats_bytes = dir_size(dest);
    if let Some(ref mut s) = meta.stats {
        s.corpus_bytes = stats_bytes;
    }
    write_meta_file(dest, &meta)?;
    Ok(())
}

/// Import package from a filesystem path.
pub fn import_corpus_zip_path(
    cache_root: &Path,
    zip_path: &Path,
) -> CoreResult<PackageImportReport> {
    let data =
        std::fs::read(zip_path).map_err(|e| CoreError::Message(format!("read package: {e}")))?;
    import_corpus_zip(cache_root, &data)
}

fn hex_sha256(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

/// Build a zip from raw entries (tests / fixtures).
#[cfg(test)]
fn zip_from_entries(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Cursor;
    let mut buf = Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }
    buf.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn seed_corpus(dir: &Path) -> (std::path::PathBuf, String) {
        let logs = dir.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("a.log")).unwrap();
        for i in 0..50 {
            writeln!(
                f,
                r#"{{"ts":{},"level":"error","service":"api","message":"connection refused {}"}}"#,
                1_700_000_000 + i,
                i % 5
            )
            .unwrap();
        }
        let cache = dir.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let report =
            crate::log_analysis::ingest_path(&cache, &logs, "round", None, "none").unwrap();
        (cache, report.corpus_id)
    }

    #[test]
    fn export_import_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, corpus_id) = seed_corpus(dir.path());
        let out = dir.path().join("pack.cdlog.zip");
        let man = export_corpus_zip(&cache, &corpus_id, &out).unwrap();
        assert_eq!(man.format_version, PACKAGE_FORMAT_VERSION);
        assert_eq!(man.min_reader_version, PACKAGE_READER_VERSION);
        assert!(out.is_file());

        let cache2 = dir.path().join("cache2");
        std::fs::create_dir_all(&cache2).unwrap();
        let imp = import_corpus_zip_path(&cache2, &out).unwrap();
        assert_ne!(imp.corpus_id, corpus_id);
        assert_eq!(imp.origin_corpus_id, corpus_id);
        let c = LogCorpus::open(&cache2, &imp.corpus_id).unwrap();
        assert!(c.event_count() >= 50);
        assert!(c.template_count() > 0);
        let meta = c.meta().unwrap();
        assert_eq!(meta.origin_corpus_id.as_deref(), Some(corpus_id.as_str()));
        assert!(meta.stats.is_some());
        assert!(meta.stats.as_ref().unwrap().reduction_ratio > 1.0);
    }

    #[test]
    fn unknown_manifest_fields_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, corpus_id) = seed_corpus(dir.path());
        let out = dir.path().join("pack.zip");
        export_corpus_zip(&cache, &corpus_id, &out).unwrap();
        // Re-pack with extra JSON field in manifest.
        let data = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut entries = std::collections::HashMap::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).unwrap();
            entries.insert(name, buf);
        }
        let mut man: serde_json::Value =
            serde_json::from_slice(entries.get("manifest.json").unwrap()).unwrap();
        man.as_object_mut()
            .unwrap()
            .insert("futureOptionalField".into(), serde_json::json!(42));
        man.as_object_mut()
            .unwrap()
            .insert("features".into(), serde_json::json!(["x", "y"]));
        entries.insert(
            "manifest.json".into(),
            serde_json::to_vec_pretty(&man).unwrap(),
        );
        let pairs: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_slice()))
            .collect();
        let zipped = zip_from_entries(&pairs);
        let cache2 = dir.path().join("c2");
        std::fs::create_dir_all(&cache2).unwrap();
        let imp = import_corpus_zip(&cache2, &zipped).unwrap();
        assert!(LogCorpus::open(&cache2, &imp.corpus_id).is_ok());
    }

    #[test]
    fn too_new_format_refused_without_orphan() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(cache.join("log_corpora")).unwrap();
        let man = serde_json::json!({
            "formatVersion": "contextdesk.log_corpus.v99",
            "minReaderVersion": 1,
            "packageKind": "log_corpus",
            "createdAt": 1,
            "corpusId": "x",
            "name": "n",
            "engine": "duckdb",
            "files": []
        });
        let zipped = zip_from_entries(&[
            (
                "manifest.json",
                serde_json::to_vec(&man).unwrap().as_slice(),
            ),
            ("meta.json", b"{}"),
            ("events.duckdb", b"not-a-real-db"),
        ]);
        let err = import_corpus_zip(&cache, &zipped).unwrap_err();
        let s = format!("{err}");
        assert!(
            s.contains("v99") || s.contains("requires") || s.contains("unsupported"),
            "{s}"
        );
        // No orphan corpus dirs (only empty log_corpora ok).
        let entries: Vec<_> = std::fs::read_dir(cache.join("log_corpora"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(entries.is_empty(), "orphans: {entries:?}");
    }

    #[test]
    fn too_new_min_reader_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let man = serde_json::json!({
            "formatVersion": "contextdesk.log_corpus.v1",
            "minReaderVersion": 9999,
            "packageKind": "log_corpus",
            "createdAt": 1,
            "corpusId": "x",
            "name": "n",
            "engine": "duckdb",
            "files": []
        });
        let zipped = zip_from_entries(&[
            (
                "manifest.json",
                serde_json::to_vec(&man).unwrap().as_slice(),
            ),
            ("meta.json", b"{}"),
            ("events.duckdb", b"x"),
        ]);
        let err = import_corpus_zip(&cache, &zipped).unwrap_err();
        assert!(
            format!("{err}").contains("9999") || format!("{err}").contains("reader"),
            "{err}"
        );
    }

    #[test]
    fn corrupt_hash_refused() {
        let dir = tempfile::tempdir().unwrap();
        let (cache, corpus_id) = seed_corpus(dir.path());
        let out = dir.path().join("pack.zip");
        export_corpus_zip(&cache, &corpus_id, &out).unwrap();
        let data = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut entries = std::collections::HashMap::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).unwrap();
            entries.insert(name, buf);
        }
        let mut man: serde_json::Value =
            serde_json::from_slice(entries.get("manifest.json").unwrap()).unwrap();
        if let Some(files) = man.get_mut("files").and_then(|f| f.as_array_mut()) {
            if let Some(first) = files.first_mut() {
                first
                    .as_object_mut()
                    .unwrap()
                    .insert("sha256".into(), serde_json::json!("deadbeef"));
            }
        }
        entries.insert(
            "manifest.json".into(),
            serde_json::to_vec_pretty(&man).unwrap(),
        );
        let pairs: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_slice()))
            .collect();
        let zipped = zip_from_entries(&pairs);
        let cache2 = dir.path().join("c2");
        std::fs::create_dir_all(cache2.join("log_corpora")).unwrap();
        let err = import_corpus_zip(&cache2, &zipped).unwrap_err();
        assert!(format!("{err}").contains("hash"), "{err}");
        let orphans: Vec<_> = std::fs::read_dir(cache2.join("log_corpora"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(orphans.is_empty());
    }

    #[test]
    fn zip_slip_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("c");
        std::fs::create_dir_all(&cache).unwrap();
        let zipped = zip_from_entries(&[("../evil.txt", b"nope")]);
        let err = import_corpus_zip(&cache, &zipped).unwrap_err();
        let s = format!("{err}").to_lowercase();
        assert!(
            s.contains("slip") || s.contains("flat") || s.contains("manifest"),
            "{err}"
        );
    }

    #[test]
    fn stripped_optional_min_reader_defaults_and_imports() {
        // Manifest without minReaderVersion must default and import.
        let dir = tempfile::tempdir().unwrap();
        let (cache, corpus_id) = seed_corpus(dir.path());
        let out = dir.path().join("pack.zip");
        export_corpus_zip(&cache, &corpus_id, &out).unwrap();
        let data = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(data);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut entries = std::collections::HashMap::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).unwrap();
            entries.insert(name, buf);
        }
        let mut man: serde_json::Value =
            serde_json::from_slice(entries.get("manifest.json").unwrap()).unwrap();
        man.as_object_mut().unwrap().remove("minReaderVersion");
        man.as_object_mut().unwrap().remove("features");
        man.as_object_mut().unwrap().remove("stats");
        entries.insert(
            "manifest.json".into(),
            serde_json::to_vec_pretty(&man).unwrap(),
        );
        let pairs: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_slice()))
            .collect();
        let zipped = zip_from_entries(&pairs);
        let cache2 = dir.path().join("c2");
        std::fs::create_dir_all(&cache2).unwrap();
        let imp = import_corpus_zip(&cache2, &zipped).unwrap();
        assert!(LogCorpus::open(&cache2, &imp.corpus_id).is_ok());
    }
}
