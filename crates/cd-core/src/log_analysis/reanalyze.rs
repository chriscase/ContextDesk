//! Atomic local template re-analysis for existing log corpora (#518).

use super::store::{CorpusEmbeddingStatus, EmbeddingState, LogCorpus, TemplateRow};
use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use crate::memory::embed_blocking;
use crate::process_progress::{
    CancelFlag, NoopProcessProgress, ProcessProgress, ProcessProgressKind, ProcessProgressObserver,
    ProcessProgressPhase,
};
use std::path::{Path, PathBuf};

/// Maximum templates embedded by one trusted re-analysis action.
pub const LOCAL_REANALYZE_TEMPLATE_CAP: usize = 2_048;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReanalysisCheckpoint {
    CandidateReady,
    TemplatesPublished,
    MetadataPublished,
}

type ReanalysisFaultHook<'a> = Option<&'a dyn Fn(ReanalysisCheckpoint) -> CoreResult<()>>;

fn check_fault(fault: ReanalysisFaultHook<'_>, checkpoint: ReanalysisCheckpoint) -> CoreResult<()> {
    if let Some(hook) = fault {
        hook(checkpoint)?;
    }
    Ok(())
}

fn cancelled(cancel: Option<&CancelFlag>) -> bool {
    cancel.is_some_and(CancelFlag::is_cancelled)
}

fn emit(progress: &dyn ProcessProgressObserver, update: ProcessProgress) {
    progress.progress(update);
}

struct CandidateCleanup {
    paths: Vec<PathBuf>,
}

impl Drop for CandidateCleanup {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn rollback_pair(
    templates_path: &Path,
    templates_backup: &Path,
    meta_path: &Path,
    meta_backup: &Path,
) {
    if templates_backup.exists() {
        let _ = std::fs::remove_file(templates_path);
        let _ = std::fs::rename(templates_backup, templates_path);
    }
    if meta_backup.exists() {
        let _ = std::fs::remove_file(meta_path);
        let _ = std::fs::rename(meta_backup, meta_path);
    }
}

/// Rebuild local template vectors without reparsing or rewriting events.
pub fn reanalyze_corpus_embeddings(
    cache_root: &Path,
    corpus_id: &str,
    backend: &dyn EmbedBackend,
    model_id: &str,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
) -> CoreResult<CorpusEmbeddingStatus> {
    let result = reanalyze_corpus_embeddings_inner(
        cache_root, corpus_id, backend, model_id, progress, cancel, None,
    );
    if result.is_err() && !cancelled(cancel) {
        emit(
            progress,
            ProcessProgress::phase(
                ProcessProgressKind::LogIngest,
                ProcessProgressPhase::Failed,
                "local template re-analysis failed; previous index preserved",
                false,
            ),
        );
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn reanalyze_corpus_embeddings_inner(
    cache_root: &Path,
    corpus_id: &str,
    backend: &dyn EmbedBackend,
    model_id: &str,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    fault: ReanalysisFaultHook<'_>,
) -> CoreResult<CorpusEmbeddingStatus> {
    let kind = ProcessProgressKind::LogIngest;
    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Embed,
            "preparing local template re-analysis",
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
                "template re-analysis cancelled before embedding",
                false,
            ),
        );
        return Err(CoreError::Message("template re-analysis cancelled".into()));
    }

    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    let event_count_before = corpus.event_count();
    let root = corpus.root().to_path_buf();
    let mut meta = corpus.meta()?;
    let mut rows = corpus.list_templates();
    drop(corpus);

    rows.sort_by_key(|row| std::cmp::Reverse(row.info.count));
    for row in &mut rows {
        row.vector = None;
    }
    let selected = LOCAL_REANALYZE_TEMPLATE_CAP.min(rows.len());
    let total = rows.len();
    let mut embedded = 0usize;
    let mut expected_dims = None;
    for (index, row) in rows.iter_mut().take(selected).enumerate() {
        if cancelled(cancel) {
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Cancelled,
                    "template re-analysis cancelled; previous index preserved",
                    false,
                )
                .with_templates(embedded as u64),
            );
            return Err(CoreError::Message("template re-analysis cancelled".into()));
        }
        let vector = embed_blocking(backend, &row.info.pattern, 5_000).ok_or_else(|| {
            CoreError::Message("local template embedding failed; previous index preserved".into())
        })?;
        if vector.is_empty() || expected_dims.is_some_and(|dims| dims != vector.len()) {
            return Err(CoreError::Message(
                "local template embedding returned inconsistent dimensions; previous index preserved"
                    .into(),
            ));
        }
        expected_dims.get_or_insert(vector.len());
        row.vector = Some(vector);
        embedded += 1;
        if index == 0 || (index + 1).is_multiple_of(8) || index + 1 == selected {
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Embed,
                    "embedding local templates",
                    true,
                )
                .with_fraction(if selected == 0 {
                    0.9
                } else {
                    0.9 * ((index + 1) as f32 / selected as f32)
                })
                .with_templates(embedded as u64),
            );
        }
    }

    let status = CorpusEmbeddingStatus {
        state: if total > 0 && embedded == total {
            EmbeddingState::Complete
        } else if embedded > 0 {
            EmbeddingState::Partial
        } else {
            EmbeddingState::KeywordOnly
        },
        model_id: (embedded > 0).then(|| model_id.trim().to_string()),
        embedded_templates: embedded as u64,
        total_templates: total as u64,
        reason: Some(
            if embedded < total {
                "trusted_reanalysis_cap"
            } else if total == 0 {
                "no_templates"
            } else {
                "trusted_local_reanalysis"
            }
            .into(),
        ),
        updated_at: crate::embed::now_unix_secs(),
    };
    meta.embedding = status.clone();
    if let Some(stats) = meta.stats.as_mut() {
        stats.embedded = embedded as u64;
    }

    let nonce = uuid::Uuid::now_v7();
    let templates_path = root.join("templates.json");
    let meta_path = root.join("meta.json");
    let templates_candidate = root.join(format!(".templates.{nonce}.candidate"));
    let meta_candidate = root.join(format!(".meta.{nonce}.candidate"));
    let templates_backup = root.join(format!(".templates.{nonce}.backup"));
    let meta_backup = root.join(format!(".meta.{nonce}.backup"));
    let _cleanup = CandidateCleanup {
        paths: vec![
            templates_candidate.clone(),
            meta_candidate.clone(),
            templates_backup.clone(),
            meta_backup.clone(),
        ],
    };

    std::fs::write(&templates_candidate, serde_json::to_vec_pretty(&rows)?)?;
    std::fs::write(&meta_candidate, serde_json::to_vec_pretty(&meta)?)?;
    let _: Vec<TemplateRow> = serde_json::from_slice(&std::fs::read(&templates_candidate)?)?;
    let _: super::store::CorpusMeta = serde_json::from_slice(&std::fs::read(&meta_candidate)?)?;
    check_fault(fault, ReanalysisCheckpoint::CandidateReady)?;
    if cancelled(cancel) {
        return Err(CoreError::Message(
            "template re-analysis cancelled; previous index preserved".into(),
        ));
    }

    std::fs::rename(&templates_path, &templates_backup)?;
    if let Err(error) = std::fs::rename(&templates_candidate, &templates_path) {
        let _ = std::fs::rename(&templates_backup, &templates_path);
        return Err(error.into());
    }
    if let Err(error) = check_fault(fault, ReanalysisCheckpoint::TemplatesPublished) {
        rollback_pair(&templates_path, &templates_backup, &meta_path, &meta_backup);
        return Err(error);
    }

    if let Err(error) = std::fs::rename(&meta_path, &meta_backup) {
        rollback_pair(&templates_path, &templates_backup, &meta_path, &meta_backup);
        return Err(error.into());
    }
    if let Err(error) = std::fs::rename(&meta_candidate, &meta_path) {
        rollback_pair(&templates_path, &templates_backup, &meta_path, &meta_backup);
        return Err(error.into());
    }
    if let Err(error) = check_fault(fault, ReanalysisCheckpoint::MetadataPublished) {
        rollback_pair(&templates_path, &templates_backup, &meta_path, &meta_backup);
        return Err(error);
    }

    let reopened = LogCorpus::open(cache_root, corpus_id)?;
    if reopened.event_count() != event_count_before || reopened.embedding_status() != status {
        drop(reopened);
        rollback_pair(&templates_path, &templates_backup, &meta_path, &meta_backup);
        return Err(CoreError::Message(
            "re-analysis validation failed; previous index restored".into(),
        ));
    }
    drop(reopened);
    let _ = std::fs::remove_file(&templates_backup);
    let _ = std::fs::remove_file(&meta_backup);

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Completed,
            format!("local template re-analysis complete: {embedded}/{total} templates"),
            false,
        )
        .with_fraction(1.0)
        .with_templates(embedded as u64),
    );
    Ok(status)
}

/// Re-analyze with no progress observer.
pub fn reanalyze_corpus_embeddings_quiet(
    cache_root: &Path,
    corpus_id: &str,
    backend: &dyn EmbedBackend,
    model_id: &str,
) -> CoreResult<CorpusEmbeddingStatus> {
    reanalyze_corpus_embeddings(
        cache_root,
        corpus_id,
        backend,
        model_id,
        &NoopProcessProgress,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::{ConceptEmbedBackend, EmbedBackend};
    use crate::log_analysis::ingest_path;
    use async_trait::async_trait;
    use std::sync::Arc;

    struct FailingBackend;

    #[async_trait]
    impl EmbedBackend for FailingBackend {
        async fn embed(&self, _texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
            Err(CoreError::Message("injected embed failure".into()))
        }
    }

    struct CancellingBackend {
        cancel: CancelFlag,
        inner: ConceptEmbedBackend,
    }

    #[async_trait]
    impl EmbedBackend for CancellingBackend {
        async fn embed(&self, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
            let vectors = self.inner.embed(texts).await?;
            self.cancel.cancel();
            Ok(vectors)
        }
    }

    fn keyword_corpus() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("app.log");
        std::fs::write(
            &logs,
            "ts=1700000000 level=error msg=connection refused\n\
             ts=1700000001 level=info msg=worker recovered\n",
        )
        .unwrap();
        let report = ingest_path(dir.path(), &logs, "fixture", None, "none").unwrap();
        (dir, report.corpus_id)
    }

    #[test]
    fn trusted_reanalysis_populates_vectors_without_reparsing_events() {
        let (dir, id) = keyword_corpus();
        let before = LogCorpus::open(dir.path(), &id).unwrap();
        let event_count = before.event_count();
        assert_eq!(before.embedding_status().state, EmbeddingState::KeywordOnly);
        drop(before);

        let status = reanalyze_corpus_embeddings_quiet(
            dir.path(),
            &id,
            &ConceptEmbedBackend::new(32),
            "concept-local",
        )
        .unwrap();
        assert_eq!(status.state, EmbeddingState::Complete);
        assert_eq!(status.model_id.as_deref(), Some("concept-local"));

        let reopened = LogCorpus::open(dir.path(), &id).unwrap();
        assert_eq!(reopened.event_count(), event_count);
        assert!(reopened
            .list_templates()
            .iter()
            .all(|row| row.vector.is_some()));
        assert_eq!(reopened.embedding_status(), status);
    }

    #[test]
    fn cancellation_and_failures_preserve_previous_files_and_index() {
        let (dir, id) = keyword_corpus();
        let root = dir.path().join("log_corpora").join(&id);
        let before_templates = std::fs::read(root.join("templates.json")).unwrap();
        let before_meta = std::fs::read(root.join("meta.json")).unwrap();

        let failed = reanalyze_corpus_embeddings_quiet(dir.path(), &id, &FailingBackend, "failing");
        assert!(failed.is_err());
        assert_eq!(
            std::fs::read(root.join("templates.json")).unwrap(),
            before_templates
        );
        assert_eq!(std::fs::read(root.join("meta.json")).unwrap(), before_meta);

        let mid_cancel = CancelFlag::new();
        let cancelling = CancellingBackend {
            cancel: mid_cancel.clone(),
            inner: ConceptEmbedBackend::new(32),
        };
        let cancelled_midway = reanalyze_corpus_embeddings(
            dir.path(),
            &id,
            &cancelling,
            "concept-local",
            &NoopProcessProgress,
            Some(&mid_cancel),
        );
        assert!(cancelled_midway.is_err());
        assert_eq!(
            std::fs::read(root.join("templates.json")).unwrap(),
            before_templates
        );
        assert_eq!(std::fs::read(root.join("meta.json")).unwrap(), before_meta);

        let cancel = CancelFlag::new();
        cancel.cancel();
        let cancelled = reanalyze_corpus_embeddings(
            dir.path(),
            &id,
            &ConceptEmbedBackend::new(32),
            "concept-local",
            &NoopProcessProgress,
            Some(&cancel),
        );
        assert!(cancelled.is_err());
        assert_eq!(
            std::fs::read(root.join("templates.json")).unwrap(),
            before_templates
        );
        assert_eq!(std::fs::read(root.join("meta.json")).unwrap(), before_meta);
    }

    #[test]
    fn publication_faults_roll_back_both_sidecars() {
        let (dir, id) = keyword_corpus();
        let root = dir.path().join("log_corpora").join(&id);
        let before_templates = std::fs::read(root.join("templates.json")).unwrap();
        let before_meta = std::fs::read(root.join("meta.json")).unwrap();
        let backend: Arc<dyn EmbedBackend> = Arc::new(ConceptEmbedBackend::new(32));

        for checkpoint in [
            ReanalysisCheckpoint::CandidateReady,
            ReanalysisCheckpoint::TemplatesPublished,
            ReanalysisCheckpoint::MetadataPublished,
        ] {
            let hook = |actual| {
                if actual == checkpoint {
                    Err(CoreError::Message("injected publication failure".into()))
                } else {
                    Ok(())
                }
            };
            let result = reanalyze_corpus_embeddings_inner(
                dir.path(),
                &id,
                backend.as_ref(),
                "concept-local",
                &NoopProcessProgress,
                None,
                Some(&hook),
            );
            assert!(result.is_err(), "{checkpoint:?}");
            assert_eq!(
                std::fs::read(root.join("templates.json")).unwrap(),
                before_templates,
                "{checkpoint:?}"
            );
            assert_eq!(
                std::fs::read(root.join("meta.json")).unwrap(),
                before_meta,
                "{checkpoint:?}"
            );
            assert_eq!(
                LogCorpus::open(dir.path(), &id)
                    .unwrap()
                    .embedding_status()
                    .state,
                EmbeddingState::KeywordOnly
            );
        }
    }
}
