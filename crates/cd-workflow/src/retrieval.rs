//! Host-neutral optional retrieval roles: config resolution, status
//! diagnostics, and the shared hybrid search entry.
//!
//! Consumed identically by the CLI and the desktop host. Distinguishes, per
//! optional role (semantic embedding, reranking):
//!
//! * capability — an adapter for the role exists in this build;
//! * configuration — the user enabled it and named a model (names are
//!   configuration, never behavior);
//! * current health — the endpoint answered a probe just now;
//! * measured quality — retrieval-ablation benchmark numbers (reported by
//!   the benchmark, never inferred here).
//!
//! Absence or failure of every optional role leaves the structured/keyword
//! baseline usable.

use std::path::Path;
use std::sync::Arc;

use cd_core::capability_qualification::QualificationKey;
use cd_core::config::{AppConfig, RetrievalRoleModel};
use cd_core::embed::{EmbedBackend, OllamaEmbedBackend};
use cd_core::error::CoreResult;
use cd_core::keychain_store::SecretStore;
use cd_core::log_analysis::{
    hybrid_search_events, HybridDegradation, HybridOptions, HybridOutcome, LogCorpus,
};
use cd_core::memory::embed_blocking;
use cd_core::process_progress::CancelFlag;
use cd_core::rerank::{rerank_blocking, HttpRerankBackend, RerankBackend};

/// Wire schema identity for [`RetrievalStatusReport`].
pub const RETRIEVAL_STATUS_SCHEMA_ID: &str = "contextdesk.retrieval_status.v1";
/// Wire schema version for [`RetrievalStatusReport`].
pub const RETRIEVAL_STATUS_SCHEMA_VERSION: u32 = 1;

/// Probe budget per role when `--probe` is requested.
const PROBE_TIMEOUT_MS: u64 = 5_000;

/// Lifecycle state of one optional retrieval role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetrievalRoleState {
    /// No configuration present; the baseline runs alone.
    Unconfigured,
    /// Configured but explicitly disabled.
    Disabled,
    /// Enabled in configuration; no probe has verified it in this report.
    ConfiguredUnverified,
    /// Enabled and the endpoint answered this report's probe correctly.
    Healthy,
    /// Enabled but the endpoint did not answer the probe (absent/failed).
    Unavailable,
    /// Enabled and reachable, but the response violated the role contract.
    Incompatible,
}

impl RetrievalRoleState {
    /// Stable snake_case wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unconfigured => "unconfigured",
            Self::Disabled => "disabled",
            Self::ConfiguredUnverified => "configured_unverified",
            Self::Healthy => "healthy",
            Self::Unavailable => "unavailable",
            Self::Incompatible => "incompatible",
        }
    }
}

/// Status of one optional role for diagnostics surfaces.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RetrievalRoleStatus {
    /// `"embedding"` or `"reranker"`.
    pub role: String,
    /// Lifecycle state (see [`RetrievalRoleState`]).
    pub state: RetrievalRoleState,
    /// Configured model identity, when configured.
    pub model: Option<String>,
    /// SHA-256 fingerprint of the normalized endpoint (never the URL itself).
    pub endpoint_fingerprint: Option<String>,
    /// Human-readable explanation (probe result, degradation reason, ...).
    pub detail: String,
}

/// Corpus-side facts relevant to retrieval mode selection.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RetrievalCorpusStatus {
    /// Corpus id inspected.
    pub corpus_id: String,
    /// Templates carrying vectors; zero keeps semantic ranking off (the
    /// production honesty gate).
    pub embedded_templates: u64,
    /// Current event revision of the corpus.
    pub event_revision: u64,
}

/// Host-neutral retrieval status DTO.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RetrievalStatusReport {
    /// Always [`RETRIEVAL_STATUS_SCHEMA_ID`].
    pub schema_id: String,
    /// Always [`RETRIEVAL_STATUS_SCHEMA_VERSION`].
    pub schema_version: u32,
    /// Per-role lifecycle states.
    pub roles: Vec<RetrievalRoleStatus>,
    /// Mode configuration ALONE would select (health may still degrade it at
    /// query time; the hybrid outcome reports the mode actually used).
    pub mode_configured: String,
    /// Whether probes ran for this report.
    pub probed: bool,
    /// Corpus facts when a corpus id was supplied.
    pub corpus: Option<RetrievalCorpusStatus>,
}

/// Options for [`retrieval_status`].
#[derive(Debug, Clone, Default)]
pub struct RetrievalStatusOptions {
    /// Actively probe enabled roles (network to the configured endpoints).
    pub probe: bool,
    /// Inspect this imported corpus for embedded-template state.
    pub corpus_id: Option<String>,
}

fn role_fingerprint(role: &RetrievalRoleModel) -> String {
    QualificationKey::new("retrieval", &role.base_url, &role.model).endpoint_fingerprint
}

fn bearer_for(role: &RetrievalRoleModel, secrets: Option<&dyn SecretStore>) -> Option<String> {
    let reference = role.api_key_ref.as_deref()?;
    secrets.and_then(|store| store.get(reference).ok().flatten())
}

/// Build the configured embedding backend (Ollama `/api/embeddings` wire —
/// the embedding contract this repository speaks today). The model id comes
/// from configuration; nothing is hard-coded.
pub fn build_embedding_backend(role: &RetrievalRoleModel) -> CoreResult<Arc<dyn EmbedBackend>> {
    let client = cd_core::chat::OllamaClient::new(&role.base_url, &role.model)?;
    Ok(Arc::new(OllamaEmbedBackend::new(client)))
}

/// Build the configured rerank backend (TEI/Cohere-compatible `/rerank`).
pub fn build_rerank_backend(
    role: &RetrievalRoleModel,
    secrets: Option<&dyn SecretStore>,
) -> CoreResult<Arc<dyn RerankBackend>> {
    let bearer = bearer_for(role, secrets);
    Ok(Arc::new(HttpRerankBackend::new(
        &role.base_url,
        role.model.clone(),
        bearer,
    )?))
}

fn embedding_role_status(role: Option<&RetrievalRoleModel>, probe: bool) -> RetrievalRoleStatus {
    match role {
        None => RetrievalRoleStatus {
            role: "embedding".into(),
            state: RetrievalRoleState::Unconfigured,
            model: None,
            endpoint_fingerprint: None,
            detail: "no embedding role configured; structured/keyword baseline only".into(),
        },
        Some(role) if !role.enabled => RetrievalRoleStatus {
            role: "embedding".into(),
            state: RetrievalRoleState::Disabled,
            model: Some(role.model.clone()),
            endpoint_fingerprint: Some(role_fingerprint(role)),
            detail: "configured but disabled".into(),
        },
        Some(role) => {
            if !probe {
                return RetrievalRoleStatus {
                    role: "embedding".into(),
                    state: RetrievalRoleState::ConfiguredUnverified,
                    model: Some(role.model.clone()),
                    endpoint_fingerprint: Some(role_fingerprint(role)),
                    detail: "enabled; not probed in this report (pass --probe)".into(),
                };
            }
            let (state, detail) = match build_embedding_backend(role) {
                Err(_) => (
                    RetrievalRoleState::Unavailable,
                    "backend construction failed; check the configured endpoint".into(),
                ),
                Ok(backend) => {
                    match embed_blocking(
                        backend.as_ref(),
                        "contextdesk retrieval health probe",
                        PROBE_TIMEOUT_MS,
                    ) {
                        None => (
                            RetrievalRoleState::Unavailable,
                            "probe failed or timed out; baseline remains usable".into(),
                        ),
                        Some(vector) if vector.is_empty() => (
                            RetrievalRoleState::Incompatible,
                            "endpoint answered but returned an empty vector".into(),
                        ),
                        Some(vector) => (
                            RetrievalRoleState::Healthy,
                            format!("probe ok ({} dimensions)", vector.len()),
                        ),
                    }
                }
            };
            RetrievalRoleStatus {
                role: "embedding".into(),
                state,
                model: Some(role.model.clone()),
                endpoint_fingerprint: Some(role_fingerprint(role)),
                detail,
            }
        }
    }
}

fn reranker_role_status(
    role: Option<&RetrievalRoleModel>,
    probe: bool,
    secrets: Option<&dyn SecretStore>,
) -> RetrievalRoleStatus {
    match role {
        None => RetrievalRoleStatus {
            role: "reranker".into(),
            state: RetrievalRoleState::Unconfigured,
            model: None,
            endpoint_fingerprint: None,
            detail: "no reranker configured; merged order is final".into(),
        },
        Some(role) if !role.enabled => RetrievalRoleStatus {
            role: "reranker".into(),
            state: RetrievalRoleState::Disabled,
            model: Some(role.model.clone()),
            endpoint_fingerprint: Some(role_fingerprint(role)),
            detail: "configured but disabled".into(),
        },
        Some(role) => {
            if !probe {
                return RetrievalRoleStatus {
                    role: "reranker".into(),
                    state: RetrievalRoleState::ConfiguredUnverified,
                    model: Some(role.model.clone()),
                    endpoint_fingerprint: Some(role_fingerprint(role)),
                    detail: "enabled; not probed in this report (pass --probe)".into(),
                };
            }
            let documents = vec![
                "synthetic probe document alpha".to_string(),
                "synthetic probe document beta".to_string(),
            ];
            let (state, detail) = match build_rerank_backend(role, secrets) {
                Err(_) => (
                    RetrievalRoleState::Unavailable,
                    "backend construction failed; check the configured endpoint".into(),
                ),
                Ok(backend) => match rerank_blocking(
                    backend.as_ref(),
                    "contextdesk retrieval health probe",
                    &documents,
                    PROBE_TIMEOUT_MS,
                ) {
                    None => (
                        RetrievalRoleState::Unavailable,
                        "probe failed or timed out; pre-rerank order would be kept".into(),
                    ),
                    Some(scores) if scores.len() != documents.len() => (
                        RetrievalRoleState::Incompatible,
                        "endpoint answered but violated the one-score-per-document contract".into(),
                    ),
                    Some(_) => (RetrievalRoleState::Healthy, "probe ok".into()),
                },
            };
            RetrievalRoleStatus {
                role: "reranker".into(),
                state,
                model: Some(role.model.clone()),
                endpoint_fingerprint: Some(role_fingerprint(role)),
                detail,
            }
        }
    }
}

fn enabled(role: &Option<RetrievalRoleModel>) -> bool {
    role.as_ref().is_some_and(|r| r.enabled)
}

/// Compute the host-neutral retrieval status report.
pub fn retrieval_status(
    cache_root: &Path,
    config: &AppConfig,
    options: &RetrievalStatusOptions,
    secrets: Option<&dyn SecretStore>,
) -> CoreResult<RetrievalStatusReport> {
    let roles = vec![
        embedding_role_status(config.retrieval.embedding.as_ref(), options.probe),
        reranker_role_status(config.retrieval.reranker.as_ref(), options.probe, secrets),
    ];
    let mode_configured = match (
        enabled(&config.retrieval.embedding),
        enabled(&config.retrieval.reranker),
    ) {
        (true, true) => "hybrid_embedding_reranked",
        (true, false) => "hybrid_embedding",
        // A reranker without a semantic lane reorders keyword evidence only;
        // configuration intent is still the baseline mode.
        (false, _) => "structured_keyword",
    };
    let corpus = match &options.corpus_id {
        None => None,
        Some(corpus_id) => {
            let corpus = LogCorpus::open(cache_root, corpus_id)?;
            Some(RetrievalCorpusStatus {
                corpus_id: corpus_id.clone(),
                embedded_templates: corpus.embedding_status().embedded_templates,
                event_revision: corpus.revision(),
            })
        }
    };
    Ok(RetrievalStatusReport {
        schema_id: RETRIEVAL_STATUS_SCHEMA_ID.into(),
        schema_version: RETRIEVAL_STATUS_SCHEMA_VERSION,
        roles,
        mode_configured: mode_configured.into(),
        probed: options.probe,
        corpus,
    })
}

/// Shared hybrid-search entry: builds the configured optional backends and
/// runs [`cd_core::log_analysis::hybrid_search_events`] over an imported
/// corpus. Backend construction failures degrade to the baseline with a
/// recorded degradation rather than failing the search.
pub fn hybrid_search(
    cache_root: &Path,
    corpus_id: &str,
    options: &HybridOptions,
    config: &AppConfig,
    secrets: Option<&dyn SecretStore>,
    cancel: Option<&CancelFlag>,
) -> CoreResult<HybridOutcome> {
    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    let (embed, embedding_build_failed) = match config
        .retrieval
        .embedding
        .as_ref()
        .filter(|role| role.enabled)
    {
        None => (None, false),
        Some(role) => match build_embedding_backend(role) {
            Ok(backend) => (Some(backend), false),
            Err(_) => (None, true),
        },
    };
    let (rerank, reranker_build_failed) = match config
        .retrieval
        .reranker
        .as_ref()
        .filter(|role| role.enabled)
    {
        None => (None, false),
        Some(role) => match build_rerank_backend(role, secrets) {
            Ok(backend) => (Some(backend), false),
            Err(_) => (None, true),
        },
    };
    let mut outcome = hybrid_search_events(
        &corpus,
        options,
        embed.as_deref(),
        rerank.as_deref(),
        cancel,
    )?;
    if embedding_build_failed {
        outcome.degradations.push(HybridDegradation {
            code: "embedding_backend_construction_failed".into(),
            detail:
                "embedding backend construction failed; structured/keyword baseline remains usable"
                    .into(),
        });
    }
    if reranker_build_failed {
        outcome.degradations.push(HybridDegradation {
            code: "reranker_backend_construction_failed".into(),
            detail: "reranker backend construction failed; pre-rerank order remains usable".into(),
        });
    }
    if let (Some(role), Some(_)) = (
        config.retrieval.embedding.as_ref().filter(|r| r.enabled),
        embed.as_ref(),
    ) {
        if outcome.telemetry.embedding_model.is_none()
            && outcome.telemetry.embedding_calls.unwrap_or(0) > 0
        {
            outcome.telemetry.embedding_model = Some(role.model.clone());
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::keychain_store::{MemorySecretStore, SecretStore};

    fn reranker_role(api_key_ref: Option<&str>) -> RetrievalRoleModel {
        RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:8080".into(),
            model: "test-reranker".into(),
            api_key_ref: api_key_ref.map(str::to_string),
        }
    }

    #[test]
    fn reranker_uses_the_configured_secret_reference() {
        let secrets = MemorySecretStore::new();
        secrets
            .set("retrieval/test/api_key", "not-printed")
            .unwrap();
        let role = reranker_role(Some("retrieval/test/api_key"));
        assert_eq!(
            bearer_for(&role, Some(&secrets)).as_deref(),
            Some("not-printed")
        );
    }

    #[test]
    fn status_keeps_optional_roles_unconfigured_by_default() {
        let cache = tempfile::tempdir().unwrap();
        let report = retrieval_status(
            cache.path(),
            &AppConfig::default(),
            &RetrievalStatusOptions::default(),
            None,
        )
        .unwrap();
        assert_eq!(report.mode_configured, "structured_keyword");
        assert!(report
            .roles
            .iter()
            .all(|role| role.state == RetrievalRoleState::Unconfigured));
    }
}
