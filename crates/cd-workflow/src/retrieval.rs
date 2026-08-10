//! Host-neutral optional retrieval roles: config resolution, status
//! diagnostics, and the shared hybrid search entry.
//!
//! Currently consumed by CLI diagnostics and reusable by future hosts.
//! Desktop retrieval activation is not wired by this module. Distinguishes,
//! per optional role (semantic embedding, reranking):
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
use cd_core::embed::{EmbedBackend, HttpEmbedBackend, OllamaEmbedBackend, VercelV4EmbedBackend};
use cd_core::error::CoreResult;
use cd_core::keychain_store::SecretStore;
use cd_core::log_analysis::{
    hybrid_search_events, HybridDegradation, HybridOptions, HybridOutcome, LogCorpus,
};
use cd_core::memory::embed_blocking;
use cd_core::process_progress::CancelFlag;
use cd_core::rerank::{rerank_blocking, validate_rerank_scores, HttpRerankBackend, RerankBackend};

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
    /// Backend-known identity bound to the stored vectors, when valid.
    pub embedding_model: Option<String>,
    /// Single measured dimension count across all stored vectors, when valid.
    pub embedding_dimensions: Option<u32>,
    /// Whether the corpus has a complete model+dimension binding suitable for
    /// query-time compatibility checks.
    pub semantic_binding_usable: bool,
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

/// Build the configured embedding backend through an explicit wire dialect.
/// Legacy roles without a dialect retain the local Ollama default only for
/// the conventional Ollama port; every other endpoint uses the generic
/// OpenAI `/v1/embeddings` contract. Model names never select behavior.
pub fn build_embedding_backend(
    role: &RetrievalRoleModel,
    secrets: Option<&dyn SecretStore>,
) -> CoreResult<Arc<dyn EmbedBackend>> {
    let dialect = role.dialect.as_deref().unwrap_or_else(|| {
        if role.base_url.contains(":11434") {
            "ollama_embeddings"
        } else {
            "openai_embeddings"
        }
    });
    match dialect {
        "ollama_embeddings" => {
            let client = cd_core::chat::OllamaClient::new(&role.base_url, &role.model)?;
            Ok(Arc::new(OllamaEmbedBackend::new(client)))
        }
        "openai_embeddings" => Ok(Arc::new(HttpEmbedBackend::new(
            &role.base_url,
            role.model.clone(),
            bearer_for(role, secrets),
        )?)),
        "vercel_v4_embeddings" => {
            if !cd_core::discovery::is_vercel_ai_gateway(&role.base_url) {
                return Err(cd_core::error::CoreError::Config(
                    "vercel_v4_embeddings requires the ai-gateway.vercel.sh host".into(),
                ));
            }
            Ok(Arc::new(VercelV4EmbedBackend::new_with_policy(
                &role.base_url,
                role.model.clone(),
                bearer_for(role, secrets),
                &cd_core::ssrf::SsrfPolicy::default(),
            )?))
        }
        unsupported => Err(cd_core::error::CoreError::Config(format!(
            "unsupported embedding dialect '{unsupported}'; use ollama_embeddings, openai_embeddings, or vercel_v4_embeddings"
        ))),
    }
}

/// Build the configured rerank backend through an explicit wire dialect. A
/// URL or model name never changes the parser.
pub fn build_rerank_backend(
    role: &RetrievalRoleModel,
    secrets: Option<&dyn SecretStore>,
) -> CoreResult<Arc<dyn RerankBackend>> {
    if let Some(dialect) = role.dialect.as_deref() {
        if dialect != "tei_rerank_v1" && dialect != "vercel_v4_rerank_v1" {
            return Err(cd_core::error::CoreError::Config(format!(
                "unsupported reranker dialect '{dialect}'; use tei_rerank_v1 or vercel_v4_rerank_v1"
            )));
        }
    }
    let bearer = bearer_for(role, secrets);
    if role.dialect.as_deref() == Some("vercel_v4_rerank_v1") {
        if !cd_core::discovery::is_vercel_ai_gateway(&role.base_url) {
            return Err(cd_core::error::CoreError::Config(
                "vercel_v4_rerank_v1 requires the ai-gateway.vercel.sh host".into(),
            ));
        }
        Ok(Arc::new(
            cd_core::rerank::VercelV4RerankBackend::new_with_policy(
                &role.base_url,
                role.model.clone(),
                bearer,
                &cd_core::ssrf::SsrfPolicy::default(),
            )?,
        ))
    } else {
        Ok(Arc::new(HttpRerankBackend::new(
            &role.base_url,
            role.model.clone(),
            bearer,
        )?))
    }
}

fn embedding_role_status(
    role: Option<&RetrievalRoleModel>,
    probe: bool,
    secrets: Option<&dyn SecretStore>,
) -> (RetrievalRoleStatus, Option<u32>) {
    let status = match role {
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
                return (
                    RetrievalRoleStatus {
                        role: "embedding".into(),
                        state: RetrievalRoleState::ConfiguredUnverified,
                        model: Some(role.model.clone()),
                        endpoint_fingerprint: Some(role_fingerprint(role)),
                        detail: "enabled; not probed in this report (pass --probe)".into(),
                    },
                    None,
                );
            }
            let (state, detail, probed_dims) = match build_embedding_backend(role, secrets) {
                Err(_) => (
                    RetrievalRoleState::Unavailable,
                    "backend construction failed; check the configured endpoint".into(),
                    None,
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
                            None,
                        ),
                        Some(vector) if vector.is_empty() => (
                            RetrievalRoleState::Incompatible,
                            "endpoint answered but returned an empty vector".into(),
                            Some(0),
                        ),
                        Some(vector) => (
                            RetrievalRoleState::Healthy,
                            format!("probe ok ({} dimensions)", vector.len()),
                            u32::try_from(vector.len()).ok(),
                        ),
                    }
                }
            };
            return (
                RetrievalRoleStatus {
                    role: "embedding".into(),
                    state,
                    model: Some(role.model.clone()),
                    endpoint_fingerprint: Some(role_fingerprint(role)),
                    detail,
                },
                probed_dims,
            );
        }
    };
    (status, None)
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
                    Some(scores) if validate_rerank_scores(&scores, documents.len()).is_err() => (
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
    let corpus_embedding = match &options.corpus_id {
        None => None,
        Some(corpus_id) => {
            let corpus = LogCorpus::open(cache_root, corpus_id)?;
            Some((corpus, corpus_id.clone()))
        }
    };
    let (mut embedding_role, probed_embedding_dims) =
        embedding_role_status(config.retrieval.embedding.as_ref(), options.probe, secrets);
    if let (Some(role), Some((corpus, _))) = (
        config
            .retrieval
            .embedding
            .as_ref()
            .filter(|role| role.enabled),
        corpus_embedding.as_ref(),
    ) {
        let binding = corpus.embedding_status();
        if binding.embedded_templates > 0 {
            let incompatibility = if binding.model_id.as_deref() != Some(role.model.as_str()) {
                Some("configured embedding model does not match the corpus vector model")
            } else if binding.embedded_dims.is_none_or(|dims| dims == 0) {
                Some("corpus vectors have no single valid dimension binding")
            } else if probed_embedding_dims.is_some()
                && probed_embedding_dims != binding.embedded_dims
            {
                Some("the probed embedding dimensions do not match the corpus vectors")
            } else {
                None
            };
            if let Some(detail) = incompatibility {
                embedding_role.state = RetrievalRoleState::Incompatible;
                embedding_role.detail = format!(
                    "{detail}; semantic retrieval will stay off until the corpus is re-analyzed"
                );
            }
        }
    }
    let roles = vec![
        embedding_role,
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
    let corpus = corpus_embedding.map(|(corpus, corpus_id)| {
        let binding = corpus.embedding_status();
        RetrievalCorpusStatus {
            corpus_id,
            embedded_templates: binding.embedded_templates,
            embedding_model: binding.model_id.clone(),
            embedding_dimensions: binding.embedded_dims,
            semantic_binding_usable: binding.embedded_templates > 0
                && binding.model_id.is_some()
                && binding.embedded_dims.is_some_and(|dims| dims > 0),
            event_revision: corpus.revision(),
        }
    });
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
        Some(role) => match build_embedding_backend(role, secrets) {
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
    // `telemetry.embedding_model` is set by the engine from the identity of
    // the backend that actually executed the semantic lane. Backfilling it
    // here from configuration would claim a model for lanes that degraded
    // before contributing, so no backfill happens.
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::keychain_store::{MemorySecretStore, SecretStore};
    use cd_test_gateway::{MockGateway, Response, Step};
    use serde_json::json;

    fn reranker_role(api_key_ref: Option<&str>) -> RetrievalRoleModel {
        RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:8080".into(),
            model: "test-reranker".into(),
            dialect: Some("tei_rerank_v1".into()),
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

    #[tokio::test]
    async fn openai_embedding_role_uses_shared_backend_and_protected_credential() {
        let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
            "data": [{"index": 0, "embedding": [0.25, 0.75]}]
        })))])
        .await;
        let secrets = MemorySecretStore::new();
        secrets
            .set("retrieval/embed/api_key", "secret-value")
            .unwrap();
        let role = RetrievalRoleModel {
            enabled: true,
            base_url: gateway.base_url().to_string(),
            model: "bge-m3".into(),
            dialect: Some("openai_embeddings".into()),
            api_key_ref: Some("retrieval/embed/api_key".into()),
        };
        let backend = build_embedding_backend(&role, Some(&secrets)).unwrap();
        let vectors = backend.embed(&["synthetic query".into()]).await.unwrap();
        assert_eq!(vectors, vec![vec![0.25, 0.75]]);
        let request = gateway.requests().pop().expect("embedding request");
        assert_eq!(request.path, "/v1/embeddings");
        assert_eq!(request.header("authorization"), Some("Bearer secret-value"));
    }

    #[test]
    fn unsupported_retrieval_dialects_fail_before_provider_access() {
        let role = RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:8080".into(),
            model: "bge-m3".into(),
            dialect: Some("invented".into()),
            api_key_ref: None,
        };
        let error = build_embedding_backend(&role, None)
            .err()
            .expect("unknown dialect must fail");
        assert!(error.to_string().contains("unsupported embedding dialect"));

        let reranker = RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:8080".into(),
            model: "qwen3-reranker-0.6b".into(),
            dialect: Some("vercel_v4".into()),
            api_key_ref: None,
        };
        let error = build_rerank_backend(&reranker, None)
            .err()
            .expect("unsupported reranker dialect must fail");
        assert!(error.to_string().contains("unsupported reranker dialect"));
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

    #[test]
    fn status_marks_a_configured_model_incompatible_with_corpus_vectors() {
        let cache = tempfile::tempdir().unwrap();
        let logs = cache.path().join("events.log");
        std::fs::write(&logs, "level=error msg=connection refused\n").unwrap();
        let backend: Arc<dyn EmbedBackend> = Arc::new(cd_core::embed::ConceptEmbedBackend::new(32));
        let policy = cd_core::log_analysis::LogEmbedPolicy {
            mode: cd_core::log_analysis::LogEmbedMode::Local,
            cloud_content_leaves_machine: false,
            cloud_base_url: None,
            model_id: "legacy-display-label".into(),
            defer_above_source_bytes: None,
        };
        let ingest = cd_core::log_analysis::ingest_path_with_policy(
            cache.path(),
            &logs,
            "binding-status",
            &policy,
            Some(backend),
        )
        .unwrap();

        let mut config = AppConfig::default();
        config.retrieval.embedding = Some(RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:11434".into(),
            model: "different-vector-space".into(),
            dialect: Some("ollama_embeddings".into()),
            api_key_ref: None,
        });
        let report = retrieval_status(
            cache.path(),
            &config,
            &RetrievalStatusOptions {
                probe: false,
                corpus_id: Some(ingest.corpus_id),
            },
            None,
        )
        .unwrap();

        let embedding = report
            .roles
            .iter()
            .find(|role| role.role == "embedding")
            .unwrap();
        assert_eq!(embedding.state, RetrievalRoleState::Incompatible);
        assert!(embedding.detail.contains("does not match"));
        let corpus = report.corpus.unwrap();
        assert_eq!(corpus.embedding_dimensions, Some(32));
        assert!(corpus.semantic_binding_usable);
    }
}
