//! Thin host adapters for deterministic Logging Quality Assessment.
//!
//! Scoring and fixed hint templates live in `cd-core` / `cd-workflow` only.
//! This module opens a corpus by id, returns the shared DTO, and optionally
//! publishes a no-clobber report via the workflow. It never re-scores and never
//! returns absolute filesystem paths to the webview.

use cd_core::log_analysis::{
    assess_logging_quality, LogCorpus, LoggingQualityAssessment,
};
use cd_workflow::logging_quality::{
    publish_assessment_report, LoggingQualityReportFormat,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

/// Host-only enrichment: assessment DTO + opaque key → portable source map.
///
/// Portable identities are relative source strings stored on events (never
/// absolute paths). The map is for Explorer bridge only and is not part of the
/// public export schema.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggingQualityAssessmentHostDto {
    pub assessment: LoggingQualityAssessment,
    /// `src_0001` → portable relative source identity.
    pub source_key_map: BTreeMap<String, String>,
}

/// Terminal export status returned to the renderer (no destination path).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LoggingQualityExportStatus {
    /// User dismissed the native Save panel.
    Cancelled,
    /// Atomic no-clobber publish succeeded.
    Written {
        format: String,
        /// Safe display basename only (never a directory path).
        display_name: String,
    },
    /// Publish failed (including no-clobber conflict).
    Failed { reason: String },
}

/// Assess one corpus under `cache_root`. Pure over durable corpus state.
pub fn assess_at_cache(
    cache_root: &Path,
    corpus_id: &str,
) -> Result<LoggingQualityAssessmentHostDto, String> {
    let corpus = LogCorpus::open(cache_root, corpus_id)
        .map_err(|e| format!("corpus not found or unreadable: {e}"))?;
    let assessment =
        assess_logging_quality(&corpus).map_err(|e| format!("logging quality assessment: {e}"))?;
    let source_key_map = build_source_key_map(&corpus)?;
    Ok(LoggingQualityAssessmentHostDto {
        assessment,
        source_key_map,
    })
}

/// Deterministic opaque-key map matching `cd-core` assessor ordering
/// (`GROUP BY source ORDER BY source ASC`, first 64).
pub fn build_source_key_map(corpus: &LogCorpus) -> Result<BTreeMap<String, String>, String> {
    corpus
        .with_connection(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT source, COUNT(*) AS c
                     FROM events
                     GROUP BY source
                     ORDER BY source ASC
                     LIMIT 64",
                )
                .map_err(|e| cd_core::error::CoreError::Message(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(|e| cd_core::error::CoreError::Message(e.to_string()))?;
            let mut map = BTreeMap::new();
            for (idx, row) in rows.enumerate() {
                let (source, _) =
                    row.map_err(|e| cd_core::error::CoreError::Message(e.to_string()))?;
                // Never expose absolute paths if a malicious store smuggled one.
                if looks_like_absolute_path(&source) {
                    continue;
                }
                map.insert(format!("src_{:04}", idx + 1), source);
            }
            Ok(map)
        })
        .map_err(|e| e.to_string())
}

fn looks_like_absolute_path(s: &str) -> bool {
    let t = s.trim();
    t.starts_with('/')
        || t.starts_with('\\')
        || (t.len() > 2 && t.as_bytes()[1] == b':' && t.as_bytes()[0].is_ascii_alphabetic())
}

/// Publish assessment report with workflow no-clobber semantics.
pub fn export_at_path(
    cache_root: &Path,
    corpus_id: &str,
    path: &Path,
    format: LoggingQualityReportFormat,
) -> Result<LoggingQualityExportStatus, String> {
    let dto = assess_at_cache(cache_root, corpus_id)?;
    publish_assessment_report(&dto.assessment, path, format).map_err(|e| e.to_string())?;
    let display_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("report")
        .to_string();
    // Refuse to echo anything path-like as display_name.
    if looks_like_absolute_path(&display_name) || display_name.contains('/') || display_name.contains('\\') {
        return Ok(LoggingQualityExportStatus::Written {
            format: format.as_str().into(),
            display_name: "report".into(),
        });
    }
    Ok(LoggingQualityExportStatus::Written {
        format: format.as_str().into(),
        display_name,
    })
}

/// Map a UI format string to the workflow enum.
pub fn parse_report_format(raw: &str) -> Result<LoggingQualityReportFormat, String> {
    LoggingQualityReportFormat::parse(raw).map_err(|e| e.to_string())
}

/// Safe basename for native Save dialog default file name.
pub fn default_export_file_name(format: LoggingQualityReportFormat) -> &'static str {
    match format {
        LoggingQualityReportFormat::Json => "contextdesk-logging-quality.json",
        LoggingQualityReportFormat::Markdown => "contextdesk-logging-quality.md",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::log_analysis::embed_policy::{LogEmbedMode, LogEmbedPolicy};
    use cd_core::log_analysis::ingest::ingest_path_with_policy;
    use std::fs;
    use tempfile::TempDir;

    fn ingest_fixture(cache: &Path, src: &Path) -> String {
        let policy = LogEmbedPolicy {
            mode: LogEmbedMode::None,
            cloud_content_leaves_machine: false,
            cloud_base_url: None,
            model_id: "test-none".into(),
            defer_above_source_bytes: None,
        };
        ingest_path_with_policy(cache, src, "lqa-host", &policy, None)
            .unwrap()
            .corpus_id
    }

    #[test]
    fn assess_returns_dto_and_opaque_source_map_without_absolute_paths() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(src.join("api")).unwrap();
        fs::write(
            src.join("api/app.jsonl"),
            concat!(
                r#"{"ts":"2026-01-01T12:00:00Z","level":"INFO","msg":"hello"}"#,
                "\n",
            ),
        )
        .unwrap();
        let cache = tmp.path().join("cache");
        fs::create_dir_all(&cache).unwrap();
        let corpus_id = ingest_fixture(&cache, &src);

        let dto = assess_at_cache(&cache, &corpus_id).expect("assess");
        assert_eq!(
            dto.assessment.schema_id,
            "contextdesk.logging_quality_assessment.v1"
        );
        assert!(!dto.assessment.limitations.is_empty());
        assert!(!dto.source_key_map.is_empty());
        for (key, portable) in &dto.source_key_map {
            assert!(key.starts_with("src_"));
            assert!(!looks_like_absolute_path(portable), "portable={portable}");
            assert!(!portable.contains("/Users/"), "portable={portable}");
        }
    }

    #[test]
    fn export_json_no_clobber_and_missing_corpus_fail_closed() {
        let tmp = TempDir::new().unwrap();
        let src = tmp.path().join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(
            src.join("a.jsonl"),
            concat!(
                r#"{"ts":"2026-01-01T12:00:00Z","level":"ERROR","msg":"x"}"#,
                "\n",
            ),
        )
        .unwrap();
        let cache = tmp.path().join("cache");
        fs::create_dir_all(&cache).unwrap();
        let corpus_id = ingest_fixture(&cache, &src);

        let out = tmp.path().join("out.json");
        let first = export_at_path(
            &cache,
            &corpus_id,
            &out,
            LoggingQualityReportFormat::Json,
        )
        .expect("first export");
        assert!(matches!(
            first,
            LoggingQualityExportStatus::Written { .. }
        ));
        assert!(out.is_file());
        let body = fs::read_to_string(&out).unwrap();
        assert!(body.contains("contextdesk.logging_quality_assessment.v1"));
        assert!(!body.to_ascii_lowercase().contains("/users/"));

        let second = export_at_path(
            &cache,
            &corpus_id,
            &out,
            LoggingQualityReportFormat::Json,
        );
        assert!(second.is_err(), "no-clobber must fail: {second:?}");

        let missing = assess_at_cache(&cache, "does-not-exist");
        assert!(missing.is_err());
    }

    #[test]
    fn absolute_path_heuristic() {
        assert!(looks_like_absolute_path("/Users/me/logs"));
        assert!(looks_like_absolute_path("C:\\Users\\me"));
        assert!(!looks_like_absolute_path("api/app.jsonl"));
        assert!(!looks_like_absolute_path("src_0001"));
    }

    /// Live-shaped public-fixture path: ingest → assess → export JSON+MD → no-clobber.
    #[test]
    fn live_shaped_public_fixture_assess_export_roundtrip() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/cli-release-demo");
        assert!(
            fixture.is_dir(),
            "public fixture missing: {}",
            fixture.display()
        );
        let tmp = TempDir::new().unwrap();
        let cache = tmp.path().join("cache");
        fs::create_dir_all(&cache).unwrap();
        let corpus_id = ingest_fixture(&cache, &fixture);

        let dto = assess_at_cache(&cache, &corpus_id).expect("assess public fixture");
        assert_eq!(
            dto.assessment.schema_id,
            "contextdesk.logging_quality_assessment.v1"
        );
        assert!(!dto.assessment.limitations.is_empty());
        assert!(dto.assessment.corpus.event_count > 0);
        // Privacy: serialized assessment must not carry absolute user paths.
        let json = serde_json::to_string(&dto.assessment).unwrap();
        assert!(!json.to_ascii_lowercase().contains("/users/"));
        assert!(!json.to_ascii_lowercase().contains("api_key"));

        // Evidence map: portable only.
        for portable in dto.source_key_map.values() {
            assert!(!looks_like_absolute_path(portable));
        }
        // Show-in-Explorer bound: map size can exceed 4, but applying >4 sources
        // is a frontend fail-closed concern; host supplies the map only.
        assert!(dto.source_key_map.len() <= 64);

        let export_dir = tmp.path().join("export");
        fs::create_dir_all(&export_dir).unwrap();
        let json_path = export_dir.join("assessment.json");
        let md_path = export_dir.join("assessment.md");
        let j = export_at_path(
            &cache,
            &corpus_id,
            &json_path,
            LoggingQualityReportFormat::Json,
        )
        .expect("json export");
        assert!(matches!(j, LoggingQualityExportStatus::Written { .. }));
        let m = export_at_path(
            &cache,
            &corpus_id,
            &md_path,
            LoggingQualityReportFormat::Markdown,
        )
        .expect("md export");
        assert!(matches!(m, LoggingQualityExportStatus::Written { .. }));
        assert!(json_path.is_file() && md_path.is_file());
        let md = fs::read_to_string(&md_path).unwrap();
        assert!(md.contains("Logging Quality Assessment"));
        assert!(md.to_ascii_lowercase().contains("deterministic") || md.contains("fixed template"));

        let reclobber = export_at_path(
            &cache,
            &corpus_id,
            &json_path,
            LoggingQualityReportFormat::Json,
        );
        assert!(reclobber.is_err(), "no-clobber must reject second write");
    }

    /// When `LQA_EXPORT_DIR` is set, write validated public-fixture reports there
    /// for implementer/verifier evidence capture (JSON + Markdown).
    #[test]
    fn live_shaped_export_into_lqa_export_dir_env() {
        let Ok(dir) = std::env::var("LQA_EXPORT_DIR") else {
            // Optional evidence path — skip when not requested.
            return;
        };
        let export_root = Path::new(&dir);
        fs::create_dir_all(export_root).expect("create LQA_EXPORT_DIR");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/cli-release-demo");
        assert!(fixture.is_dir());
        let tmp = TempDir::new().unwrap();
        let cache = tmp.path().join("cache");
        fs::create_dir_all(&cache).unwrap();
        let corpus_id = ingest_fixture(&cache, &fixture);
        let json_path = export_root.join("assessment.json");
        let md_path = export_root.join("assessment.md");
        let _ = fs::remove_file(&json_path);
        let _ = fs::remove_file(&md_path);
        export_at_path(
            &cache,
            &corpus_id,
            &json_path,
            LoggingQualityReportFormat::Json,
        )
        .expect("json to LQA_EXPORT_DIR");
        export_at_path(
            &cache,
            &corpus_id,
            &md_path,
            LoggingQualityReportFormat::Markdown,
        )
        .expect("md to LQA_EXPORT_DIR");
        assert!(json_path.is_file() && md_path.is_file());
        let body = fs::read_to_string(&json_path).unwrap();
        assert!(body.contains("contextdesk.logging_quality_assessment.v1"));
        eprintln!("LQA_EXPORT_JSON={}", json_path.display());
        eprintln!("LQA_EXPORT_MD={}", md_path.display());
    }
}
