//! Host-neutral optional retrieval roles: config resolution, status
//! diagnostics, and the shared hybrid search entry.
//!
//! Consumed by CLI diagnostics and the desktop ToolHost wiring. The module
//! still only constructs/qualifies role adapters; hosts decide when explicit
//! user configuration may attach them. Distinguishes,
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

use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;

use cd_core::capability_qualification::QualificationKey;
use cd_core::config::{AppConfig, EmbedWireKind, RetrievalRoleModel};
use cd_core::embed::{
    EmbedBackend, OllamaEmbedBackend, OpenAiCompatibleEmbedBackend, VercelV4EmbedBackend,
};
use cd_core::error::CoreResult;
use cd_core::keychain_store::SecretStore;
use cd_core::log_analysis::{
    hybrid_search_events, HybridDegradation, HybridOptions, HybridOutcome, LogCorpus,
};
use cd_core::memory::embed_blocking;
use cd_core::process_progress::CancelFlag;
use cd_core::rerank::{
    rerank_blocking, resolve_rerank_dialect, validate_rerank_scores, HttpRerankBackend,
    RerankBackend, RerankDialect, RERANK_DIALECT_TEI_V1, RERANK_DIALECT_VERCEL_V4,
    SUPPORTED_RERANK_DIALECTS,
};

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
    /// Enabled for a non-loopback endpoint without explicit egress consent.
    EgressNotAcknowledged,
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
            Self::EgressNotAcknowledged => "egress_not_acknowledged",
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

/// Retrieval sends a query to the embedding service and may send query plus
/// corpus candidates to the reranker. Treat every non-loopback endpoint as
/// remote, including private/corporate hosts: a private address can still be
/// another machine. This check is deliberately lexical and conservative; the
/// SSRF policy remains responsible for validating and pinning the actual URL.
///
/// Public because every surface that *describes* egress — a re-analysis plan,
/// a diagnostic plan, a consent prompt — must agree with the factory that
/// *enforces* it. A second implementation would eventually promise a locality
/// this one refuses.
///
/// Known conservative case: `Url::host_str` keeps the brackets on an IPv6
/// literal, so `http://[::1]` does not parse as an address and is classified
/// remote. That errs toward asking for consent, which is the safe direction.
pub fn retrieval_endpoint_is_remote(role: &RetrievalRoleModel) -> bool {
    let Ok(url) = url::Url::parse(&role.base_url) else {
        // Let backend construction report the malformed URL, but never treat
        // an unparseable endpoint as local and silently allow egress.
        return true;
    };
    let Some(host) = url.host_str() else {
        return true;
    };
    let host = host.to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return false;
    }
    !host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

fn assert_retrieval_egress_allowed(role: &RetrievalRoleModel) -> CoreResult<()> {
    if retrieval_endpoint_is_remote(role) && !role.allow_remote {
        return Err(cd_core::error::CoreError::Policy(
            "remote retrieval is not acknowledged; enable allow_remote only after confirming that query and candidate text may leave this machine".into(),
        ));
    }
    Ok(())
}

/// Resolve the one embedding wire selector used by factories, diagnostics,
/// re-analysis planning, and space identity.
///
/// `dialect` predates the typed `embed_wire` field and remains the canonical
/// selector when it is present. This is intentional: serde cannot distinguish
/// an omitted typed field from its OpenAI-compatible default, so rejecting a
/// legacy Ollama dialect as a conflict would break existing configurations.
/// When the legacy selector is absent, the typed field supplies the selector.
/// No URL or model-name inference is performed.
pub fn resolved_embedding_dialect(role: &RetrievalRoleModel) -> CoreResult<String> {
    if let Some(dialect) = role.dialect.as_deref() {
        let dialect = dialect.trim();
        return match dialect {
            "ollama_embeddings" | "openai_embeddings" | "vercel_v4_embeddings" => {
                Ok(dialect.to_string())
            }
            unsupported => Err(cd_core::error::CoreError::Config(format!(
                "unsupported embedding dialect '{unsupported}'; use ollama_embeddings, openai_embeddings, or vercel_v4_embeddings"
            ))),
        };
    }
    Ok(match role.embed_wire {
        EmbedWireKind::OpenAiCompatible => "openai_embeddings",
        EmbedWireKind::Ollama => "ollama_embeddings",
    }
    .into())
}

/// Resolve the one reranker wire selector used by factories and diagnostics.
///
/// As with [`resolved_embedding_dialect`], a present legacy string is
/// canonical for backwards compatibility; otherwise the typed field supplies
/// the registered TEI/Cohere contract. The returned label is the wire label,
/// not the internal `RerankDialect` enum name.
pub fn resolved_rerank_dialect_label(role: &RetrievalRoleModel) -> CoreResult<String> {
    if let Some(dialect) = role.dialect.as_deref() {
        let dialect = dialect.trim();
        return if SUPPORTED_RERANK_DIALECTS.contains(&dialect) {
            Ok(dialect.to_string())
        } else {
            Err(cd_core::error::CoreError::Config(format!(
                "unsupported reranker dialect '{dialect}'; use {}",
                SUPPORTED_RERANK_DIALECTS.join(" or ")
            )))
        };
    }
    Ok(match role.rerank_dialect {
        RerankDialect::TeiCohere => RERANK_DIALECT_TEI_V1,
    }
    .into())
}

/// Build the configured embedding backend through the resolved explicit wire
/// dialect. Model names and URL shapes never select behavior.
pub fn build_embedding_backend(
    role: &RetrievalRoleModel,
    secrets: Option<&dyn SecretStore>,
) -> CoreResult<Arc<dyn EmbedBackend>> {
    assert_retrieval_egress_allowed(role)?;
    let dialect = resolved_embedding_dialect(role)?;
    match dialect.as_str() {
        "ollama_embeddings" => {
            let client = cd_core::chat::OllamaClient::new(&role.base_url, &role.model)?;
            Ok(Arc::new(OllamaEmbedBackend::new(client)))
        }
        "openai_embeddings" => Ok(Arc::new(OpenAiCompatibleEmbedBackend::new(
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
            "unsupported resolved embedding dialect '{unsupported}'"
        ))),
    }
}

/// Build the configured rerank backend through an **explicit** wire dialect.
///
/// The dialect is mandatory. A URL shape, a port, or a model name never
/// selects the parser: two providers can share a hostname pattern and a model
/// label while speaking different envelopes, so inferring the dialect either
/// mis-parses a valid response or — worse — accepts a mis-parsed permutation
/// as if it were valid. An omitted dialect fails closed with the supported
/// list, before any credential is read or any endpoint is contacted.
pub fn build_rerank_backend(
    role: &RetrievalRoleModel,
    secrets: Option<&dyn SecretStore>,
) -> CoreResult<Arc<dyn RerankBackend>> {
    assert_retrieval_egress_allowed(role)?;
    let dialect = resolved_rerank_dialect_label(role)?;
    let bearer = bearer_for(role, secrets);
    if dialect == RERANK_DIALECT_VERCEL_V4 {
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
        Ok(Arc::new(HttpRerankBackend::with_dialect(
            &role.base_url,
            role.model.clone(),
            bearer,
            RerankDialect::TeiCohere,
        )?))
    }
}

/// Dialect the production and qualification adapters share for a role.
/// Explicit typed configuration is authoritative; the URL and model name are
/// never used to infer a parser.
pub fn registered_rerank_dialect(role: &RetrievalRoleModel) -> RerankDialect {
    resolve_rerank_dialect(Some(role.rerank_dialect))
}

// ---------------------------------------------------------------------------
// Share-safe retrieval report (ablation / diagnostics)
// ---------------------------------------------------------------------------

/// Wire schema for share-safe retrieval ablation / mode comparison reports.
pub const RETRIEVAL_ABLATION_SCHEMA_ID: &str = "contextdesk.retrieval_ablation.v1";
/// Schema version for [`ShareSafeRetrievalReport`].
pub const RETRIEVAL_ABLATION_SCHEMA_VERSION: u32 = 1;

/// One mode's ranking aggregates — never raw vectors, URLs, or secrets.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShareSafeModeAggregate {
    pub mode: String,
    pub candidate_count: u64,
    pub latency_ms: Option<u64>,
    pub embedding_calls: Option<u64>,
    pub rerank_calls: Option<u64>,
    pub failure_categories: Vec<String>,
    pub pinned_evidence_hits: u64,
}

/// Share-safe retrieval report: pseudonyms + fingerprints + aggregates only.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShareSafeRetrievalReport {
    pub schema_id: String,
    pub schema_version: u32,
    pub profile_pseudonym: String,
    pub model_pseudonym: String,
    pub endpoint_fingerprint: Option<String>,
    pub embedding_dimensions: Option<u32>,
    pub rerank_dialect: Option<String>,
    pub modes: Vec<ShareSafeModeAggregate>,
    pub total_latency_ms: Option<u64>,
}

/// Build a share-safe report. Labels are hashed into pseudonyms and never
/// echoed; callers must not pass secrets or vectors.
pub fn share_safe_retrieval_report(
    profile_label: &str,
    model_label: &str,
    endpoint_base_url: Option<&str>,
    embedding_dimensions: Option<u32>,
    rerank_dialect: Option<RerankDialect>,
    modes: Vec<ShareSafeModeAggregate>,
    total_latency_ms: Option<u64>,
) -> ShareSafeRetrievalReport {
    let profile_fp =
        QualificationKey::new("retrieval-profile", profile_label, model_label).endpoint_fingerprint;
    let model_fp =
        QualificationKey::new("retrieval-model", model_label, model_label).endpoint_fingerprint;
    ShareSafeRetrievalReport {
        schema_id: RETRIEVAL_ABLATION_SCHEMA_ID.into(),
        schema_version: RETRIEVAL_ABLATION_SCHEMA_VERSION,
        profile_pseudonym: format!("p-{}", &profile_fp[..12.min(profile_fp.len())]),
        model_pseudonym: format!("p-{}", &model_fp[..12.min(model_fp.len())]),
        endpoint_fingerprint: endpoint_base_url.map(|url| {
            QualificationKey::new("retrieval-ep", url, model_label).endpoint_fingerprint
        }),
        embedding_dimensions,
        rerank_dialect: rerank_dialect.map(|d| d.as_str().to_string()),
        modes,
        total_latency_ms,
    }
}

/// Assert a serialized share-safe report contains none of the forbidden
/// classes. Returns an error with the first hit for tests.
pub fn assert_share_safe_json(report_json: &str, forbidden: &[&str]) -> Result<(), String> {
    for forbidden_value in forbidden {
        if !forbidden_value.is_empty() && report_json.contains(forbidden_value) {
            return Err(format!(
                "share-safe report must not contain {forbidden_value:?}"
            ));
        }
    }
    for needle in ["\"embedding\":[", "Bearer ", "sk-", "Authorization"] {
        if report_json.contains(needle) {
            return Err(format!("share-safe report must not contain {needle:?}"));
        }
    }
    Ok(())
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
            if let Err(error) = assert_retrieval_egress_allowed(role) {
                return (
                    RetrievalRoleStatus {
                        role: "embedding".into(),
                        state: RetrievalRoleState::EgressNotAcknowledged,
                        model: Some(role.model.clone()),
                        endpoint_fingerprint: Some(role_fingerprint(role)),
                        detail: error.to_string(),
                    },
                    None,
                );
            }
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
            if let Err(error) = assert_retrieval_egress_allowed(role) {
                return RetrievalRoleStatus {
                    role: "reranker".into(),
                    state: RetrievalRoleState::EgressNotAcknowledged,
                    model: Some(role.model.clone()),
                    endpoint_fingerprint: Some(role_fingerprint(role)),
                    detail: error.to_string(),
                };
            }
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

/// Run the production hybrid search with backends the caller already built.
///
/// [`hybrid_search`] is this function plus role construction. A caller that
/// builds the roles once and runs many searches — a benchmark comparing lanes,
/// for example — uses this directly so a six-lane sweep stays one credential
/// read per role instead of one per lane. There is deliberately no second
/// engine here: this is the same [`hybrid_search_events`] the product runs.
pub fn hybrid_search_with_backends(
    cache_root: &Path,
    corpus_id: &str,
    options: &HybridOptions,
    embed: Option<&dyn EmbedBackend>,
    rerank: Option<&dyn RerankBackend>,
    cancel: Option<&CancelFlag>,
) -> CoreResult<HybridOutcome> {
    let corpus = LogCorpus::open(cache_root, corpus_id)?;
    hybrid_search_events(&corpus, options, embed, rerank, cancel)
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
    let mut outcome = hybrid_search_with_backends(
        cache_root,
        corpus_id,
        options,
        embed.as_deref(),
        rerank.as_deref(),
        cancel,
    )?;
    if embedding_build_failed {
        outcome.degradations.push(HybridDegradation {
            code: if config
                .retrieval
                .embedding
                .as_ref()
                .is_some_and(|role| retrieval_endpoint_is_remote(role) && !role.allow_remote)
            {
                "retrieval_egress_not_acknowledged"
            } else {
                "embedding_backend_construction_failed"
            }
            .into(),
            detail: if config
                .retrieval
                .embedding
                .as_ref()
                .is_some_and(|role| retrieval_endpoint_is_remote(role) && !role.allow_remote)
            {
                "remote embedding was blocked because retrieval egress was not acknowledged; structured/keyword baseline remains usable"
            } else {
                "embedding backend construction failed; structured/keyword baseline remains usable"
            }
            .into(),
        });
    }
    if reranker_build_failed {
        outcome.degradations.push(HybridDegradation {
            code: if config
                .retrieval
                .reranker
                .as_ref()
                .is_some_and(|role| retrieval_endpoint_is_remote(role) && !role.allow_remote)
            {
                "retrieval_egress_not_acknowledged"
            } else {
                "reranker_backend_construction_failed"
            }
            .into(),
            detail: if config
                .retrieval
                .reranker
                .as_ref()
                .is_some_and(|role| retrieval_endpoint_is_remote(role) && !role.allow_remote)
            {
                "remote reranking was blocked because retrieval egress was not acknowledged; pre-rerank order remains usable"
            } else {
                "reranker backend construction failed; pre-rerank order remains usable"
            }
            .into(),
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
            allow_remote: false,
            api_key_ref: api_key_ref.map(str::to_string),
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
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
    fn typed_only_role_selectors_are_shared_with_diagnostic_space_identity() {
        let embedding = RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:9/gateway/v1/foo".into(),
            model: "bge-m3".into(),
            dialect: None,
            allow_remote: false,
            api_key_ref: None,
            embed_wire: EmbedWireKind::OpenAiCompatible,
            rerank_dialect: RerankDialect::TeiCohere,
        };
        assert_eq!(
            resolved_embedding_dialect(&embedding).unwrap(),
            "openai_embeddings"
        );
        let configured = crate::retrieval_diagnostic::configured_embedding_space(&embedding);
        assert_eq!(configured.dialect, "openai_embeddings");
        assert_eq!(
            configured.endpoint_fingerprint,
            cd_core::capability_qualification::fingerprint_endpoint(
                "http://127.0.0.1:9/gateway/v1/foo/embeddings"
            )
        );

        let reranker = RetrievalRoleModel {
            model: "qwen3-reranker-0.6b".into(),
            ..embedding.clone()
        };
        assert_eq!(
            resolved_rerank_dialect_label(&reranker).unwrap(),
            cd_core::rerank::RERANK_DIALECT_TEI_V1
        );
    }

    #[test]
    fn legacy_string_selector_is_the_single_canonical_selector_when_present() {
        let role = RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:9".into(),
            model: "bge-m3".into(),
            dialect: Some("ollama_embeddings".into()),
            allow_remote: false,
            api_key_ref: None,
            // The typed default is OpenAI, but the explicit legacy selector
            // remains authoritative for old saved configurations.
            embed_wire: EmbedWireKind::OpenAiCompatible,
            rerank_dialect: RerankDialect::TeiCohere,
        };
        assert_eq!(
            resolved_embedding_dialect(&role).unwrap(),
            "ollama_embeddings"
        );
        assert_eq!(
            crate::retrieval_diagnostic::configured_embedding_space(&role).dialect,
            "ollama_embeddings"
        );
    }

    #[test]
    fn openai_path_prefix_is_normalized_once_for_production_backend() {
        let backend =
            OpenAiCompatibleEmbedBackend::new("http://127.0.0.1:9/gateway/v1/foo", "bge-m3", None)
                .unwrap();
        assert_eq!(
            backend.endpoint_url(),
            "http://127.0.0.1:9/gateway/v1/foo/embeddings"
        );
        assert_eq!(
            cd_core::embed::embedding_endpoint_for_dialect(
                "http://127.0.0.1:9/gateway/v1/foo",
                "openai_embeddings"
            )
            .as_deref(),
            Some("http://127.0.0.1:9/gateway/v1/foo/embeddings")
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
            allow_remote: false,
            api_key_ref: Some("retrieval/embed/api_key".into()),
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
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
            allow_remote: false,
            api_key_ref: None,
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
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
            allow_remote: false,
            api_key_ref: None,
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
        };
        let error = build_rerank_backend(&reranker, None)
            .err()
            .expect("unsupported reranker dialect must fail");
        assert!(error.to_string().contains("unsupported reranker dialect"));
    }

    #[test]
    fn a_reranker_uses_typed_default_but_rejects_blank_legacy_dialects() {
        // The typed field has a documented TEI/Cohere default. Legacy string
        // fields remain fail-closed when present but blank; neither URL nor
        // model name is used to infer a parser.
        let secrets = MemorySecretStore::new();
        secrets
            .set("retrieval/test/api_key", "must-not-be-read")
            .unwrap();
        let default_role = reranker_role(Some("retrieval/test/api_key"));
        let backend = build_rerank_backend(&default_role, Some(&secrets))
            .expect("typed default should construct without reading the key");
        assert_eq!(backend.dialect(), cd_core::rerank::RERANK_DIALECT_TEI_V1);

        for dialect in [String::new(), "   ".into()] {
            let role = RetrievalRoleModel {
                dialect: Some(dialect),
                ..default_role.clone()
            };
            let error = build_rerank_backend(&role, Some(&secrets))
                .err()
                .expect("blank legacy dialect must fail closed");
            assert!(error.to_string().contains("unsupported reranker dialect"));
        }
    }

    #[test]
    fn every_supported_rerank_dialect_reports_the_parser_that_ran() {
        let role = reranker_role(None);
        let backend = build_rerank_backend(&role, None).expect("tei adapter");
        assert_eq!(
            backend.dialect(),
            cd_core::rerank::RERANK_DIALECT_TEI_V1,
            "the adapter reports its own parser; nothing infers it from the URL"
        );
        assert_eq!(
            SUPPORTED_RERANK_DIALECTS,
            [
                cd_core::rerank::RERANK_DIALECT_TEI_V1,
                cd_core::rerank::RERANK_DIALECT_VERCEL_V4
            ]
        );

        // A URL that looks like a Vercel gateway does NOT select the Vercel
        // parser: only the configured dialect does.
        let vercel_shaped = RetrievalRoleModel {
            base_url: "https://ai-gateway.vercel.sh".into(),
            allow_remote: true,
            dialect: Some(cd_core::rerank::RERANK_DIALECT_TEI_V1.into()),
            ..reranker_role(None)
        };
        let backend =
            build_rerank_backend(&vercel_shaped, None).expect("explicit tei on that host");
        assert_eq!(backend.dialect(), cd_core::rerank::RERANK_DIALECT_TEI_V1);
    }

    #[test]
    fn remote_retrieval_is_blocked_before_backend_or_credential_access() {
        let role = RetrievalRoleModel {
            enabled: true,
            base_url: "https://ai-gateway.vercel.sh".into(),
            model: "deepseek-v4-flash".into(),
            dialect: Some("vercel_v4_embeddings".into()),
            allow_remote: false,
            api_key_ref: Some("retrieval/vercel/api_key".into()),
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
        };
        let error = build_embedding_backend(&role, None)
            .err()
            .expect("unacknowledged remote retrieval must fail closed");
        assert!(error
            .to_string()
            .contains("remote retrieval is not acknowledged"));

        let reranker = RetrievalRoleModel {
            dialect: Some("vercel_v4_rerank_v1".into()),
            ..role
        };
        let error = build_rerank_backend(&reranker, None)
            .err()
            .expect("unacknowledged remote reranking must fail closed");
        assert!(error
            .to_string()
            .contains("remote retrieval is not acknowledged"));
    }

    #[test]
    fn retrieval_status_exposes_egress_policy_without_probing() {
        let cache = tempfile::tempdir().unwrap();
        let mut config = AppConfig::default();
        config.retrieval.embedding = Some(RetrievalRoleModel {
            enabled: true,
            base_url: "https://gateway.example.invalid".into(),
            model: "bge-m3".into(),
            dialect: Some("openai_embeddings".into()),
            allow_remote: false,
            api_key_ref: None,
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
        });
        let report = retrieval_status(
            cache.path(),
            &config,
            &RetrievalStatusOptions::default(),
            None,
        )
        .unwrap();
        let embedding = report
            .roles
            .iter()
            .find(|role| role.role == "embedding")
            .unwrap();
        assert_eq!(embedding.state, RetrievalRoleState::EgressNotAcknowledged);
        assert!(embedding.detail.contains("remote retrieval"));
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
            allow_remote: false,
            api_key_ref: None,
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
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
