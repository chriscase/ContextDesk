//! Durable store for reviewed format grammars (`contextdesk.reviewed_format.v1`).
//!
//! Documents are content-addressed by `(format_id, version, digest)` and published
//! under a monotonic store revision. Publication is atomic (temp file + rename).
//! Unknown future `min_reader_version` values fail closed on load.

use super::reviewed_format::{
    validate_reviewed_format, ReviewedFormat, REVIEWED_FORMAT_READER_VERSION,
    REVIEWED_FORMAT_SCHEMA_ID,
};
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Schema id for the on-disk store index.
pub const REVIEWED_FORMAT_STORE_SCHEMA_ID: &str = "contextdesk.reviewed_format_store.v1";
/// Current store index reader version.
pub const REVIEWED_FORMAT_STORE_READER_VERSION: u32 = 1;
/// Maximum documents the store will retain.
pub const MAX_REVIEWED_FORMAT_STORE_ENTRIES: usize = 256;
/// Maximum bytes for one document envelope on disk.
pub const MAX_REVIEWED_FORMAT_DOCUMENT_BYTES: u64 = 256 * 1024;

const INDEX_FILE: &str = "index.v1.json";
const DOC_DIR: &str = "documents";

/// Content-addressed identity of one exact reviewed-format document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedFormatIdentity {
    /// Stable grammar id.
    pub format_id: String,
    /// Document version.
    pub version: u16,
    /// Hex SHA-256 of the canonical serialization.
    pub digest: String,
}

/// One index entry for a published document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedFormatStoreEntry {
    /// Stable grammar id.
    pub format_id: String,
    /// Document version.
    pub version: u16,
    /// Content digest at publication.
    pub digest: String,
    /// Human-readable name.
    pub name: String,
    /// Relative file name under `documents/`.
    pub file_name: String,
}

/// Durable store index (revision + entry list).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedFormatStoreIndex {
    /// Must equal [`REVIEWED_FORMAT_STORE_SCHEMA_ID`].
    pub schema_id: String,
    /// Lowest reader that can interpret this index.
    pub min_reader_version: u32,
    /// Monotonic publication counter.
    pub revision: u64,
    /// Published documents, sorted by (format_id, version).
    pub entries: Vec<ReviewedFormatStoreEntry>,
}

impl Default for ReviewedFormatStoreIndex {
    fn default() -> Self {
        Self {
            schema_id: REVIEWED_FORMAT_STORE_SCHEMA_ID.into(),
            min_reader_version: REVIEWED_FORMAT_STORE_READER_VERSION,
            revision: 0,
            entries: Vec::new(),
        }
    }
}

/// Durable reviewed-format store rooted at a directory.
#[derive(Debug, Clone)]
pub struct ReviewedFormatStore {
    root: PathBuf,
}

impl ReviewedFormat {
    /// Hex SHA-256 of the canonical serialization (not stored inside the document).
    pub fn digest(&self) -> String {
        let encoded = serde_json::to_vec(self).unwrap_or_default();
        let mut hasher = Sha256::new();
        hasher.update(&encoded);
        format!("{:x}", hasher.finalize())
    }

    /// Content-addressed identity of this exact document.
    pub fn identity(&self) -> ReviewedFormatIdentity {
        ReviewedFormatIdentity {
            format_id: self.format_id.clone(),
            version: self.version,
            digest: self.digest(),
        }
    }
}

impl ReviewedFormatStore {
    /// Open (or create) a store under `root`.
    pub fn open(root: impl Into<PathBuf>) -> CoreResult<Self> {
        let root = root.into();
        fs::create_dir_all(root.join(DOC_DIR))
            .map_err(|e| CoreError::Message(format!("create reviewed format store: {e}")))?;
        let store = Self { root };
        if !store.index_path().exists() {
            store.publish_index(&ReviewedFormatStoreIndex::default())?;
        }
        // Fail closed on unreadable / future index immediately.
        let _ = store.load_index()?;
        Ok(store)
    }

    /// Store root directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Current store revision.
    pub fn revision(&self) -> CoreResult<u64> {
        Ok(self.load_index()?.revision)
    }

    /// List published entries (stable order).
    pub fn list(&self) -> CoreResult<Vec<ReviewedFormatStoreEntry>> {
        Ok(self.load_index()?.entries)
    }

    /// Load one document by id + version. Fail-closed on missing / future version / digest mismatch.
    pub fn load(&self, format_id: &str, version: u16) -> CoreResult<ReviewedFormat> {
        let index = self.load_index()?;
        let entry = index
            .entries
            .iter()
            .find(|e| e.format_id == format_id && e.version == version)
            .ok_or_else(|| {
                CoreError::Message(format!("reviewed format not found: {format_id}@{version}"))
            })?;
        self.load_entry(entry)
    }

    /// Load by identity (id + version + digest). Digest mismatch fails closed.
    pub fn load_identity(&self, identity: &ReviewedFormatIdentity) -> CoreResult<ReviewedFormat> {
        let format = self.load(&identity.format_id, identity.version)?;
        let digest = format.digest();
        if digest != identity.digest {
            return Err(CoreError::Message(format!(
                "reviewed format digest mismatch for {}@{}: expected {}, have {digest}",
                identity.format_id, identity.version, identity.digest
            )));
        }
        Ok(format)
    }

    /// Validate + save a new document. Fails if (format_id, version) already exists.
    pub fn save(&self, format: &ReviewedFormat) -> CoreResult<ReviewedFormatStoreEntry> {
        self.publish(format, false)
    }

    /// Validate + replace an existing (format_id, version), or insert if absent when `allow_create`.
    pub fn update(&self, format: &ReviewedFormat) -> CoreResult<ReviewedFormatStoreEntry> {
        self.publish(format, true)
    }

    /// Delete one document by id + version. Returns true when something was removed.
    pub fn delete(&self, format_id: &str, version: u16) -> CoreResult<bool> {
        let mut index = self.load_index()?;
        let Some(pos) = index
            .entries
            .iter()
            .position(|e| e.format_id == format_id && e.version == version)
        else {
            return Ok(false);
        };
        let entry = index.entries.remove(pos);
        let path = self.root.join(DOC_DIR).join(&entry.file_name);
        let _ = fs::remove_file(&path);
        index.revision = index.revision.saturating_add(1);
        self.publish_index(&index)?;
        Ok(true)
    }

    /// Load every published format (for matching / selection catalogs).
    pub fn load_all(&self) -> CoreResult<Vec<ReviewedFormat>> {
        let index = self.load_index()?;
        let mut out = Vec::with_capacity(index.entries.len());
        for entry in &index.entries {
            out.push(self.load_entry(entry)?);
        }
        Ok(out)
    }

    fn publish(
        &self,
        format: &ReviewedFormat,
        update_existing: bool,
    ) -> CoreResult<ReviewedFormatStoreEntry> {
        let validation = validate_reviewed_format(format);
        if !validation.valid {
            return Err(CoreError::Message(format!(
                "reviewed format invalid: {:?}",
                validation.diagnostics
            )));
        }
        if format.schema_id != REVIEWED_FORMAT_SCHEMA_ID {
            return Err(CoreError::Message(
                "reviewed format schema_id invalid".into(),
            ));
        }
        if format.min_reader_version > REVIEWED_FORMAT_READER_VERSION {
            return Err(CoreError::Message(format!(
                "reviewed format requires reader {} (have {REVIEWED_FORMAT_READER_VERSION})",
                format.min_reader_version
            )));
        }

        let mut index = self.load_index()?;
        let existing = index
            .entries
            .iter()
            .position(|e| e.format_id == format.format_id && e.version == format.version);
        if existing.is_some() && !update_existing {
            return Err(CoreError::Message(format!(
                "reviewed format already exists: {}@{}",
                format.format_id, format.version
            )));
        }
        if existing.is_none() && update_existing {
            // update may create — still ok; call sites that want pure update check first
        }
        if index.entries.len() >= MAX_REVIEWED_FORMAT_STORE_ENTRIES && existing.is_none() {
            return Err(CoreError::Message(format!(
                "reviewed format store full (limit {MAX_REVIEWED_FORMAT_STORE_ENTRIES})"
            )));
        }

        let digest = format.digest();
        let file_name = document_file_name(&format.format_id, format.version);
        let entry = ReviewedFormatStoreEntry {
            format_id: format.format_id.clone(),
            version: format.version,
            digest: digest.clone(),
            name: format.name.clone(),
            file_name: file_name.clone(),
        };

        self.write_document_atomic(&file_name, format)?;

        if let Some(pos) = existing {
            index.entries[pos] = entry.clone();
        } else {
            index.entries.push(entry.clone());
        }
        index.entries.sort_by(|a, b| {
            a.format_id
                .cmp(&b.format_id)
                .then(a.version.cmp(&b.version))
        });
        index.revision = index.revision.saturating_add(1);
        self.publish_index(&index)?;
        Ok(entry)
    }

    fn load_entry(&self, entry: &ReviewedFormatStoreEntry) -> CoreResult<ReviewedFormat> {
        let path = self.root.join(DOC_DIR).join(&entry.file_name);
        let bytes = fs::read(&path).map_err(|e| {
            CoreError::Message(format!("read reviewed format {}: {e}", entry.file_name))
        })?;
        if bytes.len() as u64 > MAX_REVIEWED_FORMAT_DOCUMENT_BYTES {
            return Err(CoreError::Message(
                "reviewed format document exceeds size bound".into(),
            ));
        }
        let format: ReviewedFormat = serde_json::from_slice(&bytes).map_err(|e| {
            CoreError::Message(format!("parse reviewed format {}: {e}", entry.file_name))
        })?;
        if format.min_reader_version > REVIEWED_FORMAT_READER_VERSION {
            return Err(CoreError::Message(format!(
                "reviewed format {}@{} requires reader {} (have {REVIEWED_FORMAT_READER_VERSION})",
                format.format_id, format.version, format.min_reader_version
            )));
        }
        let validation = validate_reviewed_format(&format);
        if !validation.valid {
            return Err(CoreError::Message(format!(
                "stored reviewed format {}@{} failed validation: {:?}",
                format.format_id, format.version, validation.diagnostics
            )));
        }
        let digest = format.digest();
        if digest != entry.digest {
            return Err(CoreError::Message(format!(
                "reviewed format index digest mismatch for {}@{}",
                entry.format_id, entry.version
            )));
        }
        Ok(format)
    }

    fn load_index(&self) -> CoreResult<ReviewedFormatStoreIndex> {
        let path = self.index_path();
        if !path.exists() {
            return Ok(ReviewedFormatStoreIndex::default());
        }
        let bytes =
            fs::read(&path).map_err(|e| CoreError::Message(format!("read store index: {e}")))?;
        let index: ReviewedFormatStoreIndex = serde_json::from_slice(&bytes)
            .map_err(|e| CoreError::Message(format!("parse store index: {e}")))?;
        if index.schema_id != REVIEWED_FORMAT_STORE_SCHEMA_ID {
            return Err(CoreError::Message(format!(
                "reviewed format store schema_id invalid: {}",
                index.schema_id
            )));
        }
        if index.min_reader_version > REVIEWED_FORMAT_STORE_READER_VERSION {
            return Err(CoreError::Message(format!(
                "reviewed format store requires reader {} (have {REVIEWED_FORMAT_STORE_READER_VERSION})",
                index.min_reader_version
            )));
        }
        Ok(index)
    }

    fn publish_index(&self, index: &ReviewedFormatStoreIndex) -> CoreResult<()> {
        write_json_atomic(&self.index_path(), index)
    }

    fn write_document_atomic(&self, file_name: &str, format: &ReviewedFormat) -> CoreResult<()> {
        let path = self.root.join(DOC_DIR).join(file_name);
        write_json_atomic(&path, format)
    }

    fn index_path(&self) -> PathBuf {
        self.root.join(INDEX_FILE)
    }
}

fn document_file_name(format_id: &str, version: u16) -> String {
    let safe: String = format_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{safe}__v{version}.json")
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> CoreResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            CoreError::Message(format!("create parent for {}: {e}", path.display()))
        })?;
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .map_err(|e| CoreError::Message(format!("open temp {}: {e}", tmp.display())))?;
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|e| CoreError::Message(format!("serialize reviewed format: {e}")))?;
        if bytes.len() as u64 > MAX_REVIEWED_FORMAT_DOCUMENT_BYTES {
            let _ = fs::remove_file(&tmp);
            return Err(CoreError::Message(
                "reviewed format document exceeds size bound".into(),
            ));
        }
        file.write_all(&bytes)
            .map_err(|e| CoreError::Message(format!("write temp {}: {e}", tmp.display())))?;
        file.sync_all()
            .map_err(|e| CoreError::Message(format!("fsync temp {}: {e}", tmp.display())))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        CoreError::Message(format!(
            "atomic publish {} -> {}: {e}",
            tmp.display(),
            path.display()
        ))
    })?;
    // Best-effort fsync of parent for durability on crash.
    if let Some(parent) = path.parent() {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

/// Resolve a [`super::import_profile::ProfileRef`] against a store + content sample.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewedFormatResolveOutcome {
    /// Unique content match for the referenced id@version.
    Match {
        /// Identity of the matched document.
        identity: ReviewedFormatIdentity,
    },
    /// Referenced document is missing from the store.
    Missing,
    /// Document present but content no longer describes the source.
    ContentStale {
        /// Identity that failed content coverage.
        identity: ReviewedFormatIdentity,
    },
    /// Store has the id but a different version than referenced.
    VersionDrift {
        /// Referenced version.
        expected_version: u16,
        /// Versions present for this id.
        available_versions: Vec<u16>,
    },
    /// Multiple reviewed formats at equal priority match the sample.
    Ambiguous {
        /// Competing format ids.
        format_ids: Vec<String>,
    },
}

/// Resolve one ProfileRef against the durable store and a content sample.
///
/// Path patterns only nominate candidates; content decides. Never invents a match.
pub fn resolve_profile_ref(
    store: &ReviewedFormatStore,
    format_id: &str,
    version: u16,
    source_identity: &str,
    sample: &str,
) -> CoreResult<ReviewedFormatResolveOutcome> {
    let index = store.load_index()?;
    let versions_for_id: Vec<u16> = index
        .entries
        .iter()
        .filter(|e| e.format_id == format_id)
        .map(|e| e.version)
        .collect();
    if versions_for_id.is_empty() {
        return Ok(ReviewedFormatResolveOutcome::Missing);
    }
    if !versions_for_id.contains(&version) {
        return Ok(ReviewedFormatResolveOutcome::VersionDrift {
            expected_version: version,
            available_versions: versions_for_id,
        });
    }
    let format = store.load(format_id, version)?;
    let identity = format.identity();
    // Content selection among the single referenced document.
    match super::reviewed_format::select_format(
        std::slice::from_ref(&format),
        source_identity,
        sample,
    ) {
        super::reviewed_format::FormatSelection::Selected { .. } => {
            Ok(ReviewedFormatResolveOutcome::Match { identity })
        }
        super::reviewed_format::FormatSelection::NoMatch => {
            Ok(ReviewedFormatResolveOutcome::ContentStale { identity })
        }
        super::reviewed_format::FormatSelection::Conflict { format_ids } => {
            Ok(ReviewedFormatResolveOutcome::Ambiguous { format_ids })
        }
    }
}

/// Build an ingest binding map: exact source identity → format, after re-validating digests.
#[derive(Debug, Clone, Default)]
pub struct ReviewedFormatIngestBindings {
    by_source: std::collections::BTreeMap<String, ReviewedFormat>,
}

impl ReviewedFormatIngestBindings {
    /// Empty catalog.
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind one exact source identity to a format (must already be validated).
    pub fn insert(&mut self, source_identity: String, format: ReviewedFormat) {
        self.by_source.insert(source_identity, format);
    }

    /// Lookup by exact identity, then full-path suffix with archive boundary.
    pub fn get(&self, source_identity: &str) -> Option<&ReviewedFormat> {
        if let Some(f) = self.by_source.get(source_identity) {
            return Some(f);
        }
        self.by_source.iter().find_map(|(key, format)| {
            if source_path_eq(source_identity, key) {
                Some(format)
            } else {
                None
            }
        })
    }

    /// Number of bindings.
    pub fn len(&self) -> usize {
        self.by_source.len()
    }

    /// Whether empty.
    pub fn is_empty(&self) -> bool {
        self.by_source.is_empty()
    }
}

fn source_path_eq(observed: &str, need: &str) -> bool {
    if observed == need {
        return true;
    }
    if let Some(prefix) = observed.strip_suffix(need) {
        return prefix.is_empty()
            || prefix.ends_with('/')
            || prefix.ends_with("!/")
            || prefix.ends_with('!');
    }
    observed.contains(&format!("!/{need}"))
}

/// Apply request: revision-bound load of bindings for production ingest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedFormatApplyBinding {
    /// Exact portable source identity (never basename-only when parents differ).
    pub source_identity: String,
    /// Reviewed format id.
    pub format_id: String,
    /// Reviewed format version.
    pub version: u16,
    /// Content digest expected at apply time.
    pub digest: String,
}

/// Revision-bound apply of reviewed formats to named sources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewedFormatApplyRequest {
    /// Store revision the caller observed; mismatch fails closed.
    pub expected_store_revision: u64,
    /// Per-source bindings.
    pub bindings: Vec<ReviewedFormatApplyBinding>,
}

/// Materialize ingest bindings after re-checking store revision and digests.
pub fn apply_reviewed_format_bindings(
    store: &ReviewedFormatStore,
    request: &ReviewedFormatApplyRequest,
) -> CoreResult<ReviewedFormatIngestBindings> {
    let current = store.revision()?;
    if current != request.expected_store_revision {
        return Err(CoreError::Message(format!(
            "reviewed format store revision stale: expected {}, current {current}",
            request.expected_store_revision
        )));
    }
    let mut out = ReviewedFormatIngestBindings::new();
    let mut seen = std::collections::BTreeSet::new();
    for binding in &request.bindings {
        if !seen.insert(binding.source_identity.clone()) {
            return Err(CoreError::Message(format!(
                "duplicate reviewed format binding for source {}",
                binding.source_identity
            )));
        }
        let identity = ReviewedFormatIdentity {
            format_id: binding.format_id.clone(),
            version: binding.version,
            digest: binding.digest.clone(),
        };
        let format = store.load_identity(&identity)?;
        out.insert(binding.source_identity.clone(), format);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_analysis::reviewed_format::{
        FieldSlot, MultilineRule, TimeToken, TimestampGrammar,
    };

    fn sample_format(id: &str, version: u16) -> ReviewedFormat {
        ReviewedFormat {
            schema_id: REVIEWED_FORMAT_SCHEMA_ID.into(),
            min_reader_version: 1,
            format_id: id.into(),
            version,
            name: format!("Sample {id}"),
            path_patterns: vec![super::super::import_profile::SafePattern::new(
                "**/app.log*",
            )],
            timestamp: TimestampGrammar {
                tokens: vec![
                    TimeToken::Year4,
                    TimeToken::Literal('-'),
                    TimeToken::Month2,
                    TimeToken::Literal('-'),
                    TimeToken::Day2,
                    TimeToken::Literal(' '),
                    TimeToken::Hour24,
                    TimeToken::Literal(':'),
                    TimeToken::Minute2,
                    TimeToken::Literal(':'),
                    TimeToken::Second2,
                    TimeToken::Literal(','),
                    TimeToken::Millis3,
                ],
            },
            layout: vec![
                FieldSlot::Whitespace,
                FieldSlot::Level,
                FieldSlot::Whitespace,
                FieldSlot::Literal("-".into()),
                FieldSlot::Whitespace,
                FieldSlot::Message,
            ],
            multiline: MultilineRule::ContinuationUntilNextTimestamp,
            priority: 10,
            suggested_timezone: None,
        }
    }

    #[test]
    fn save_reopen_update_delete_and_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = ReviewedFormatStore::open(dir.path()).unwrap();
        assert_eq!(store.revision().unwrap(), 0);

        let f1 = sample_format("example.app-log", 1);
        let entry = store.save(&f1).unwrap();
        assert_eq!(entry.digest, f1.digest());
        assert_eq!(store.revision().unwrap(), 1);

        let loaded = store.load("example.app-log", 1).unwrap();
        assert_eq!(loaded, f1);

        // Restart: reopen store on same root.
        let store2 = ReviewedFormatStore::open(dir.path()).unwrap();
        assert_eq!(store2.revision().unwrap(), 1);
        assert_eq!(store2.load("example.app-log", 1).unwrap(), f1);

        // Update same version with new name (new digest).
        let mut f1b = f1.clone();
        f1b.name = "Renamed".into();
        store2.update(&f1b).unwrap();
        assert_eq!(store2.revision().unwrap(), 2);
        assert_eq!(store2.load("example.app-log", 1).unwrap().name, "Renamed");

        assert!(store2.delete("example.app-log", 1).unwrap());
        assert_eq!(store2.revision().unwrap(), 3);
        assert!(store2.load("example.app-log", 1).is_err());
    }

    #[test]
    fn future_reader_version_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let store = ReviewedFormatStore::open(dir.path()).unwrap();
        let mut future = sample_format("future.fmt", 1);
        future.min_reader_version = REVIEWED_FORMAT_READER_VERSION + 99;
        assert!(store.save(&future).is_err());
    }

    #[test]
    fn apply_bindings_require_matching_revision_and_digest() {
        let dir = tempfile::tempdir().unwrap();
        let store = ReviewedFormatStore::open(dir.path()).unwrap();
        let f = sample_format("example.app-log", 1);
        store.save(&f).unwrap();
        let rev = store.revision().unwrap();
        let dig = f.digest();
        let ok = apply_reviewed_format_bindings(
            &store,
            &ReviewedFormatApplyRequest {
                expected_store_revision: rev,
                bindings: vec![ReviewedFormatApplyBinding {
                    source_identity: "logs/app.log".into(),
                    format_id: "example.app-log".into(),
                    version: 1,
                    digest: dig.clone(),
                }],
            },
        )
        .unwrap();
        assert_eq!(ok.len(), 1);

        // Stale revision.
        assert!(apply_reviewed_format_bindings(
            &store,
            &ReviewedFormatApplyRequest {
                expected_store_revision: rev + 1,
                bindings: vec![ReviewedFormatApplyBinding {
                    source_identity: "logs/app.log".into(),
                    format_id: "example.app-log".into(),
                    version: 1,
                    digest: dig,
                }],
            },
        )
        .is_err());
    }

    #[test]
    fn resolve_ref_content_stale_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let store = ReviewedFormatStore::open(dir.path()).unwrap();
        let f = sample_format("example.app-log", 1);
        store.save(&f).unwrap();
        let sample = "2024-05-03 12:24:22,729 INFO - hello\n";
        match resolve_profile_ref(&store, "example.app-log", 1, "logs/app.log", sample).unwrap() {
            ReviewedFormatResolveOutcome::Match { .. } => {}
            other => panic!("expected match, got {other:?}"),
        }
        match resolve_profile_ref(&store, "example.app-log", 1, "logs/app.log", "{\"a\":1}\n")
            .unwrap()
        {
            ReviewedFormatResolveOutcome::ContentStale { .. } => {}
            other => panic!("expected content stale, got {other:?}"),
        }
        match resolve_profile_ref(&store, "nope", 1, "logs/app.log", sample).unwrap() {
            ReviewedFormatResolveOutcome::Missing => {}
            other => panic!("expected missing, got {other:?}"),
        }
        match resolve_profile_ref(&store, "example.app-log", 9, "logs/app.log", sample).unwrap() {
            ReviewedFormatResolveOutcome::VersionDrift {
                expected_version: 9,
                ..
            } => {}
            other => panic!("expected version drift, got {other:?}"),
        }
    }

    #[test]
    fn duplicate_basename_bindings_do_not_collapse() {
        let mut bindings = ReviewedFormatIngestBindings::new();
        let f = sample_format("example.app-log", 1);
        bindings.insert("region-a/app.log".into(), f.clone());
        bindings.insert("region-b/app.log".into(), f);
        assert!(bindings.get("region-a/app.log").is_some());
        assert!(bindings.get("region-b/app.log").is_some());
        assert!(bindings.get("archive.zip!/region-a/app.log").is_some());
        // Must not return region-a binding for region-b path via basename alone.
        let got = bindings.get("other/app.log");
        assert!(got.is_none());
    }
}
