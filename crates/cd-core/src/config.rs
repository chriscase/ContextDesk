//! Persist non-secret app config under the user config dir.

use crate::branding::Branding;
use crate::error::{CoreError, CoreResult};
use crate::providers::ProviderConfig;
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Stable keychain ref for Confluence personal access token (never the token itself).
pub const CONFLUENCE_PAT_REF: &str = "confluence/default/pat";

/// Stable keychain ref for X (Twitter) API bearer token (never the token itself).
pub const X_API_KEY_REF: &str = "x/default/api_key";

/// Confluence connector settings (token lives in keychain under [`CONFLUENCE_PAT_REF`]).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ConfluenceSettings {
    /// When false, connector is ignored.
    #[serde(default)]
    pub enabled: bool,
    /// Wiki base URL, e.g. `https://wiki.example.com` (no trailing path required).
    #[serde(default)]
    pub base_url: String,
    /// Space keys allowlist (empty = all spaces the token can see — prefer setting these).
    #[serde(default)]
    pub spaces: Vec<String>,
    /// Keychain reference id when a PAT has been saved (never the secret).
    #[serde(default)]
    pub pat_ref: Option<String>,
    /// When true, register write tools (still HardWrite-gated). Default false. (#326)
    #[serde(default)]
    pub write_enabled: bool,
    /// Max pages per harvest Accept batch. Default 25. (#326)
    #[serde(default = "default_harvest_batch_max")]
    pub harvest_batch_max: u32,
    /// REST path layout. Default Standard (Server/DC). (#326)
    #[serde(default)]
    pub rest_path_mode: crate::confluence_ro::ConfluenceRestPathMode,
    /// Auth header mode. Default Bearer. (#326)
    #[serde(default)]
    pub auth_mode: ConfluenceAuthMode,
    /// Email for Basic auth (not secret); token still in keychain.
    #[serde(default)]
    pub basic_email: Option<String>,
    /// Web UI URL style when `_links.webui` missing. (#326)
    #[serde(default)]
    pub url_style: crate::confluence_ro::ConfluenceUrlStyle,
}

/// Confluence HTTP auth mode (credentials still in keychain for tokens).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfluenceAuthMode {
    /// `Authorization: Bearer {pat}` (Server/DC default).
    #[default]
    Bearer,
    /// `Authorization: Basic base64(email:token)` (typical Cloud).
    Basic,
}

fn default_harvest_batch_max() -> u32 {
    25
}

/// X (Twitter) search connector (bearer token in keychain under [`X_API_KEY_REF`]).
///
/// Not free RSS: search requires a paid/usable X API plan. When disabled or
/// missing a key, `x_search` is not registered for the agent.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct XSettings {
    /// When false, connector is ignored even if a key exists.
    #[serde(default)]
    pub enabled: bool,
    /// Keychain reference id when a bearer has been saved (never the secret).
    #[serde(default)]
    pub api_key_ref: Option<String>,
}

impl XSettings {
    /// True when enabled and a keychain ref is recorded (host still checks key presence).
    pub fn is_configured(&self) -> bool {
        self.enabled && self.api_key_ref.is_some()
    }
}

impl ConfluenceSettings {
    /// True when base URL is non-empty and looks configured.
    pub fn is_configured(&self) -> bool {
        self.enabled && !self.base_url.trim().is_empty()
    }

    /// Convert to runtime RO client config.
    pub fn to_ro_config(&self) -> crate::confluence_ro::ConfluenceRoConfig {
        crate::confluence_ro::ConfluenceRoConfig {
            base_url: self.base_url.trim().trim_end_matches('/').to_string(),
            spaces: self.spaces.clone(),
            rest_path_mode: self.rest_path_mode,
            url_style: self.url_style,
        }
    }

    /// Build HTTP auth from this settings profile + a host-resolved PAT/token.
    ///
    /// Shared by desktop Test/List Spaces, ToolHost, and CLI so Cloud Basic and
    /// Server/DC Bearer cannot diverge. Never logs `pat`.
    pub fn auth_from_pat(
        &self,
        pat: impl Into<String>,
    ) -> crate::error::CoreResult<crate::confluence_ro::ConfluenceAuth> {
        let pat = pat.into();
        if pat.trim().is_empty() {
            return Err(crate::error::CoreError::Policy(
                "Confluence PAT/token is empty".into(),
            ));
        }
        match self.auth_mode {
            ConfluenceAuthMode::Bearer => Ok(crate::confluence_ro::ConfluenceAuth::bearer(pat)),
            ConfluenceAuthMode::Basic => {
                let email = self
                    .basic_email
                    .as_deref()
                    .map(str::trim)
                    .filter(|e| !e.is_empty())
                    .ok_or_else(|| {
                        crate::error::CoreError::Policy(
                            "Confluence Basic auth requires account email (Settings → Connectors)"
                                .into(),
                        )
                    })?
                    .to_string();
                Ok(crate::confluence_ro::ConfluenceAuth::Basic { email, token: pat })
            }
        }
    }
}

/// On-disk application configuration (no raw API keys / PATs).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    /// Provider profiles (credential references only; never inline secrets).
    pub providers: ProviderConfig,
    /// Last workspace metadata (roots as strings).
    pub workspace: Option<WorkspaceConfig>,
    /// Confluence read-only connector.
    #[serde(default)]
    pub confluence: ConfluenceSettings,
    /// X (Twitter) search connector (optional paid API key).
    #[serde(default)]
    pub x: XSettings,
    /// Theme id.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Skip first-run banner.
    #[serde(default)]
    pub setup_completed: bool,
    /// Default chat model for new sessions (falls back to active profile model).
    #[serde(default)]
    pub default_chat_model: Option<String>,
    /// When true, agent may call `web_search` / `web_fetch` (open web; SSRF-gated).
    /// Default false — opt-in; no secrets required.
    #[serde(default)]
    pub web_research_enabled: bool,
    /// Per-publisher RSS enable flags (source id → enabled).
    /// Missing keys use each source's registry default (typically true).
    #[serde(default)]
    pub web_research_sources: std::collections::HashMap<String, bool>,
    /// Retrieval / agent router budgets (enforced on the live turn path).
    #[serde(default)]
    pub router: crate::router::RouterBudget,
    /// Soft max files for indexing (default 100_000). Truncation is recorded, not silent.
    #[serde(default = "default_index_max_files")]
    pub index_max_files: usize,
    /// In-RAM working-set byte budget for the keyword index (default 256 MiB).
    /// The persistent store still holds every chunk on disk; this bounds resident
    /// memory by keeping the most-recently-modified files searchable. Capping is
    /// recorded (`KeywordIndex::is_bytes_capped`), never silent. `0` → default.
    #[serde(default = "default_index_max_bytes")]
    pub index_max_bytes: usize,
    /// Workspace connector registry entries (#127). No secrets — keychain refs only.
    #[serde(default)]
    pub connectors: Vec<crate::connectors::ConnectorConfig>,
    /// Opt-in hybrid retrieval for `search_kb` (#119). Default false — keyword-only path
    /// unchanged. When true, `search_kb` uses `KeywordIndex::search_hybrid` (keyword +
    /// recency + optional semantic when an embed backend is attached on the host).
    #[serde(default)]
    pub hybrid_retrieval: bool,
    /// Enabled external module ids (#136). Install is local-only (NON_GOALS #7).
    #[serde(default)]
    pub enabled_modules: Vec<String>,
    /// Opt-in module registry browse (#139). Default **false** — no fetch until enabled.
    ///
    /// Browse is metadata-only (NON_GOALS #7); never auto-installs.
    #[serde(default)]
    pub module_registry_enabled: bool,
    /// Registry index URL (http/https). **Empty by default** — no hardcoded company URL
    /// (AGENTS.md #2). Fetch is SSRF-gated when non-empty and enabled.
    #[serde(default)]
    pub module_registry_url: String,
    /// Durable memory + ambient recall settings (MEMORY.md §10 defaults).
    #[serde(default)]
    pub memory: crate::memory::MemoryConfig,
    /// Optional S3-compatible backup destination. Secrets remain keychain-only.
    #[cfg(feature = "s3-object-store")]
    #[serde(default)]
    pub s3_backup: Option<crate::s3_object_store::S3ObjectStoreConfig>,
    /// Per-model context char budgets (declared from catalogs + learned from errors).
    #[serde(default)]
    pub model_context_budgets: crate::model_context::ModelContextBudgets,
    /// Learned native-tool capability overrides keyed by `provider_id::model_id`.
    ///
    /// Provider-level capability remains authoritative. These entries only let
    /// one model behind a multi-model gateway fail closed without disabling
    /// proven sibling models.
    #[serde(default)]
    pub model_tools_enabled: std::collections::HashMap<String, bool>,
    /// Which providers/models ordinary pickers offer, and in what order (#678).
    ///
    /// Display curation only: it never deletes a profile, a credential
    /// reference, a locally installed model, or a remote resource, and it is
    /// never a security or redaction boundary.
    #[serde(default)]
    pub model_curation: crate::model_curation::ModelCuration,
    /// Configured default timezone for source-local timestamps with no
    /// resolvable zone evidence of their own (IANA identifier, e.g.
    /// `"America/Chicago"`). Applied with clear provenance during import
    /// aggregation; never guessed.
    #[serde(default)]
    pub default_timezone: Option<String>,
    /// Activity Inspector capture settings.
    ///
    /// Absent in files written before this existed, so it takes
    /// [`ActivitySettings::default`] — inspector on, summary only, no prompt
    /// bodies retained.
    #[serde(default)]
    pub activity: ActivitySettings,
    /// Optional retrieval roles (semantic embedding, reranking).
    ///
    /// Absent in files written before this existed, so it takes
    /// [`RetrievalSettings::default`] — both roles unconfigured, meaning the
    /// structured/keyword baseline runs alone.
    #[serde(default)]
    pub retrieval: RetrievalSettings,
    /// Optional multi-model investigation settings (reviewer-first V1).
    ///
    /// Absent in files written before this existed, so it takes
    /// [`MultiModelSettings::default`] — mode `single`, no reviewer, meaning
    /// the established single-model path runs unchanged.
    #[serde(default)]
    pub multi_model: MultiModelSettings,
    /// Optional host-grounded contribution roles. Disabled by default; when
    /// enabled, every role still requires exact qualification and explicit
    /// egress policy before it can receive a host packet.
    #[serde(default)]
    pub contributions: ContributionSettings,
    /// Optional host-grounded fast-triage route settings.
    ///
    /// Absent in files written before this existed, so it takes
    /// [`FastTriageSettings::default`] — disabled, with no route evidence and
    /// no fallback, meaning every established path runs unchanged.
    #[serde(default)]
    pub fast_triage: FastTriageSettings,
}

/// Host-grounded fast-triage route configuration.
///
/// The route is off by default and, even when enabled, runs only when a
/// persisted record in [`FastTriageSettings::routes`] matches the turn's exact
/// profile, model, workflow contract, and host contract fingerprint. There is
/// deliberately no "enable for fast models" switch, no model-name pattern, and
/// no gateway field: those are exactly the shortcuts this route must not take.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastTriageSettings {
    /// Master switch. `false` (the default) means the route never runs, whatever
    /// evidence is persisted.
    #[serde(default)]
    pub enabled: bool,
    /// Persisted per-(profile, model, workflow) route evidence. An empty list
    /// means no route is authorized, which is the honest default.
    #[serde(default)]
    pub routes: Vec<crate::fast_triage::FastTriageRouteRecord>,
    /// Optional fallback role for the one visible escalation. `None` means a
    /// failed fast answer is reported as an escalation request rather than
    /// silently retried somewhere else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<FastTriageFallbackConfig>,
}

/// Fallback role assignment for the one visible fast-triage escalation.
///
/// Provider-neutral: it names an existing provider profile id, never a provider
/// kind and never a raw secret, so credentials stay behind that profile's own
/// explicit `api_key_ref`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastTriageFallbackConfig {
    /// Existing provider profile id to fill the fallback role.
    pub profile_id: String,
    /// Model id override; `None` uses the profile's chat model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Explicit authorization to send this turn's evidence packet to the
    /// fallback. Default false: a configured-but-unauthorized fallback is
    /// reported as such and never called.
    #[serde(default)]
    pub authorized: bool,
    /// Explicit acknowledgment that this fallback may egress to a remote
    /// provider. Default false; ignored for local-only providers.
    #[serde(default)]
    pub allow_remote: bool,
}

/// Multi-model investigation configuration. Additive; the default is the
/// single-model floor. A reviewer references an existing provider **profile
/// id** — never a provider kind and never a raw secret — so credentials stay
/// behind the profile's own explicit `api_key_ref`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultiModelSettings {
    /// Default mode for new investigation turns. `single` unless the user
    /// opts in. A per-turn override may still request review.
    #[serde(default)]
    pub mode: crate::multi_model::MultiModelMode,
    /// Reviewer role assignment. `None` means no reviewer is configured, so
    /// review mode degrades to single with `reviewer_unconfigured`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<ReviewerRoleConfig>,
    /// Per-turn ceilings for the multi-model path.
    #[serde(default)]
    pub budget: MultiModelBudgetConfig,
}

/// Persisted configuration for the provider-neutral contribution route.
///
/// This is deliberately separate from reviewer-first `multi_model`: users can
/// opt into several bounded cheap contributors without changing the existing
/// single/reviewer default. Profiles are references only; credentials remain
/// behind each profile's configured secret source.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContributionSettings {
    /// Master switch. `false` preserves the established path byte-for-byte.
    #[serde(default)]
    pub enabled: bool,
    /// Explicit role assignments. Empty means the route cannot run.
    #[serde(default)]
    pub roles: Vec<ContributionRoleConfig>,
    /// Hard routing policy for contributor count, rounds, context, and review.
    #[serde(default)]
    pub policy: crate::multi_model::ContributionRoutingPolicy,
    /// Per-turn model/context budget.
    #[serde(default)]
    pub budget: MultiModelBudgetConfig,
    /// Bounded host neighborhood packet expansion.
    #[serde(default)]
    pub neighborhood: crate::fast_triage::FastTriageNeighborhoodBudget,
}

/// One explicit contributor assignment. The role and profile/model identity
/// are host configuration; the model never selects or changes them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContributionRoleConfig {
    /// Functional contribution role.
    pub role: crate::multi_model::ContributionRole,
    /// Existing provider profile id.
    pub profile_id: String,
    /// Optional exact model id override; absent uses the profile model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Require the exact prompted-JSON contribution contract to be measured.
    #[serde(default = "default_true")]
    pub require_qualified: bool,
    /// Explicit acknowledgment for remote evidence-packet egress.
    #[serde(default)]
    pub allow_remote: bool,
}

/// Reviewer role assignment. Provider-neutral: it names a profile id, not a
/// provider kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewerRoleConfig {
    /// Existing provider profile id to fill the reviewer role. May equal the
    /// investigator's profile (same model, reviewer prompt) or differ.
    pub profile_id: String,
    /// Model id override; `None` uses the profile's chat model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Require a measured capability qualification before using this model as
    /// a reviewer. Default true: an unverified reviewer degrades honestly
    /// rather than being trusted on a name.
    #[serde(default = "default_true")]
    pub require_qualified: bool,
    /// Explicit acknowledgment that this reviewer may send stage data to a
    /// remote provider. Default false: a remote reviewer without this degrades
    /// with `reviewer_egress_not_acknowledged`. Ignored for local providers.
    #[serde(default)]
    pub allow_remote: bool,
}

/// Persisted per-turn budget for the multi-model path. Deterministic units the
/// host always has (model rounds and model-facing characters). No currency.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultiModelBudgetConfig {
    /// Hard ceiling on model calls across all stages.
    #[serde(default = "default_multi_model_rounds")]
    pub max_total_provider_rounds: u32,
    /// Per-stage semantic-correction cap (independent of transport retries).
    #[serde(default = "default_multi_model_corrections")]
    pub max_semantic_corrections_per_stage: u8,
    /// Optional deterministic usage ceiling: total model-facing characters sent
    /// across all stages. `None` = no usage gate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_context_chars_total: Option<u64>,
}

impl Default for MultiModelBudgetConfig {
    fn default() -> Self {
        Self {
            max_total_provider_rounds: default_multi_model_rounds(),
            max_semantic_corrections_per_stage: default_multi_model_corrections(),
            max_context_chars_total: None,
        }
    }
}

const fn default_multi_model_rounds() -> u32 {
    12
}

const fn default_multi_model_corrections() -> u8 {
    1
}

/// Optional retrieval-role configuration.
///
/// Model names here are CONFIGURATION, never behavior: `bge-m3` and
/// `qwen3-reranker-0.6b` are documentation examples, not defaults. An absent,
/// disabled, or failing role always leaves the structured/keyword baseline
/// usable. Whether a configured role is *verified* (capability), *healthy*
/// (answered a probe just now), or *measurably better* (benchmark) are three
/// separate facts reported by the retrieval status surface — configuration
/// alone never claims any of them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrievalSettings {
    /// Optional semantic-embedding role (e.g. model `bge-m3`).
    #[serde(default)]
    pub embedding: Option<RetrievalRoleModel>,
    /// Optional reranking role (e.g. model `qwen3-reranker-0.6b`).
    #[serde(default)]
    pub reranker: Option<RetrievalRoleModel>,
}

/// Wire protocol for a retrieval embedding role.
///
/// Explicit configuration — never inferred from the URL host alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EmbedWireKind {
    /// OpenAI-compatible `POST …/embeddings` with batched `input` (production
    /// default for remote employer gateways).
    #[default]
    OpenAiCompatible,
    /// Local Ollama `POST /api/embeddings` (single prompt per call).
    Ollama,
}

/// One configured optional retrieval role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrievalRoleModel {
    /// Explicit opt-in; a configured-but-disabled role is reported as
    /// `disabled`, distinct from unconfigured or unverified.
    #[serde(default)]
    pub enabled: bool,
    /// Endpoint base URL (scheme+host+port). Never carries credentials.
    pub base_url: String,
    /// Model identity requested from the endpoint.
    pub model: String,
    /// Explicit wire dialect for this role. Supported values are
    /// `ollama_embeddings`, `openai_embeddings`, `vercel_v4_embeddings`, and
    /// `tei_rerank_v1`/`vercel_v4_rerank_v1`; an omitted value preserves
    /// legacy endpoint defaults.
    /// The value is a parser selector only — it never makes a model verified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialect: Option<String>,
    /// Explicit acknowledgment that query-time retrieval inputs may leave this
    /// machine for a non-loopback endpoint. Defaults to false so adding a
    /// remote role cannot silently create cloud egress. Loopback endpoints
    /// remain usable without this acknowledgment.
    #[serde(default)]
    pub allow_remote: bool,
    /// Optional credential REFERENCE for a bearer credential — either an
    /// explicit Keychain id or a protected `file:` path, never the secret
    /// itself (`refuse_raw_secret_refs` enforces this on load/save).
    #[serde(default)]
    pub api_key_ref: Option<String>,
    /// Explicit embed wire for the embedding role. Default
    /// [`EmbedWireKind::OpenAiCompatible`]. Ignored for the reranker role.
    #[serde(default)]
    pub embed_wire: EmbedWireKind,
    /// Explicit rerank response dialect for the reranker role. Default
    /// [`crate::rerank::RerankDialect::TeiCohere`]. Never inferred from URL.
    /// Ignored for the embedding role.
    #[serde(default)]
    pub rerank_dialect: crate::rerank::RerankDialect,
}

/// What the Activity Inspector captures.
///
/// Separate from whether the inspector *panel* is open: capture is a host
/// concern with a retention consequence, and a UI toggle must never be able
/// to change what a turn actually does. See
/// [`crate::activity`] for the contract itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivitySettings {
    /// Capture a per-turn activity record at all. Default `true`: the
    /// summary is metadata-only and is what makes a turn auditable.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Retain the redacted, capped prompt bodies the turn trace produced.
    ///
    /// Default `false`, and deliberately a separate switch from `enabled`:
    /// the summary answers "what happened" without keeping conversation
    /// text anywhere but the transcript. Turning this on is the only way
    /// bodies are retained, and even then they are already redacted and
    /// already length-bounded.
    #[serde(default)]
    pub retain_context_bodies: bool,
}

impl Default for ActivitySettings {
    fn default() -> Self {
        Self {
            enabled: true,
            retain_context_bodies: false,
        }
    }
}

impl ActivitySettings {
    /// Detail level implied by these settings.
    pub fn detail_level(&self) -> crate::activity::ActivityDetailLevel {
        if self.retain_context_bodies {
            crate::activity::ActivityDetailLevel::Full
        } else {
            crate::activity::ActivityDetailLevel::Summary
        }
    }
}

const fn default_true() -> bool {
    true
}

fn default_index_max_files() -> usize {
    100_000
}

fn default_index_max_bytes() -> usize {
    256 * 1024 * 1024
}

fn default_theme() -> String {
    "dark".into()
}

/// Serializable workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Allowlisted roots.
    pub roots: Vec<PathBuf>,
}

impl From<&Workspace> for WorkspaceConfig {
    fn from(w: &Workspace) -> Self {
        Self {
            id: w.id.clone(),
            name: w.name.clone(),
            roots: w.roots.clone(),
        }
    }
}

impl WorkspaceConfig {
    /// Convert to runtime workspace.
    pub fn into_workspace(self) -> Workspace {
        Workspace {
            id: self.id,
            name: self.name,
            roots: self.roots,
        }
    }
}

/// Resolve `~/<config_dir_name>/config.json`.
pub fn config_path(branding: &Branding) -> CoreResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| CoreError::Config("no home dir".into()))?;
    Ok(home.join(&branding.config_dir_name).join("config.json"))
}

/// Ensure config directory exists.
pub fn ensure_config_dir(branding: &Branding) -> CoreResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| CoreError::Config("no home dir".into()))?;
    let dir = home.join(&branding.config_dir_name);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn refuse_raw_secret_refs(cfg: &AppConfig) -> CoreResult<()> {
    use crate::keychain_store::looks_like_raw_secret;
    for role in [&cfg.retrieval.embedding, &cfg.retrieval.reranker]
        .into_iter()
        .flatten()
    {
        if let Some(reference) = &role.api_key_ref {
            if looks_like_raw_secret(reference) {
                return Err(CoreError::Config(
                    "refusing config that embeds raw secrets in retrieval api_key_ref".into(),
                ));
            }
        }
    }
    for p in &cfg.providers.profiles {
        if let Some(r) = &p.api_key_ref {
            if looks_like_raw_secret(r) {
                return Err(CoreError::Config(
                    "refusing config that embeds raw secrets in api_key_ref".into(),
                ));
            }
        }
    }
    if let Some(r) = &cfg.confluence.pat_ref {
        if looks_like_raw_secret(r) || r.contains("ATATT") {
            return Err(CoreError::Config(
                "refusing config that embeds raw Confluence secrets in pat_ref".into(),
            ));
        }
    }
    if let Some(r) = &cfg.x.api_key_ref {
        if looks_like_raw_secret(r) {
            return Err(CoreError::Config(
                "refusing config that embeds raw X secrets in api_key_ref".into(),
            ));
        }
    }
    #[cfg(feature = "s3-object-store")]
    if let Some(s3) = &cfg.s3_backup {
        for reference in [
            Some(&s3.access_key_ref),
            Some(&s3.secret_key_ref),
            s3.session_token_ref.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            if looks_like_raw_secret(reference.as_str()) {
                return Err(CoreError::Config(
                    "refusing config that embeds raw S3 credentials".into(),
                ));
            }
        }
    }
    Ok(())
}

/// Load config or default.
pub fn load_config(path: &Path) -> CoreResult<AppConfig> {
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(path)?;
    let mut cfg: AppConfig = serde_json::from_str(&raw)?;
    // Stamp the curation schema version and drop blank/duplicate keys. Entries
    // written by a newer build are preserved verbatim (#678).
    cfg.model_curation
        .migrate_for_profiles(&cfg.providers.profiles);
    refuse_raw_secret_refs(&cfg)?;
    Ok(cfg)
}

/// Atomic-ish write of config.
pub fn save_config(path: &Path, cfg: &AppConfig) -> CoreResult<()> {
    refuse_raw_secret_refs(cfg)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(cfg)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// The one check applied to `default_timezone` before it is persisted — an
/// IANA identifier accepted by `chrono_tz`.
pub fn is_valid_iana_timezone(value: &str) -> bool {
    value.parse::<chrono_tz::Tz>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderConfig;
    use tempfile::tempdir;

    /// #678: curation is only useful if it is still there next launch.
    #[test]
    fn curation_survives_a_real_save_and_reload() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        let profile = cfg.providers.active().expect("profile").clone();
        cfg.model_curation
            .set_model_hidden(&profile, "llama3", true);
        cfg.model_curation
            .set_model_pinned(&profile, "mistral", true);

        save_config(&path, &cfg).expect("save");
        let loaded = load_config(&path).expect("load");

        assert_eq!(
            loaded.model_curation.hidden_by(&profile, "llama3"),
            Some(crate::model_curation::HiddenBy::Model),
            "a hidden model must still be hidden after restart"
        );
        assert_eq!(
            loaded.model_curation.pinned_rank(&profile, "mistral"),
            Some(0),
            "pin order must survive restart"
        );
        assert_eq!(
            loaded.model_curation.version,
            crate::model_curation::CURATION_VERSION
        );

        // Provider configuration itself is untouched by curation.
        assert_eq!(loaded.providers.profiles, cfg.providers.profiles);
    }

    /// A config written before #678 must load, not fail or lose settings.
    #[test]
    fn a_config_without_the_curation_field_still_loads() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            // A realistic pre-#678 config: every field this build added is
            // absent, `providers` is present as it always has been.
            serde_json::json!({
                "providers": ProviderConfig::with_local_ollama(),
                "workspace": null,
                "theme": "dark",
                "default_chat_model": "mistral"
            })
            .to_string(),
        )
        .expect("write legacy config");

        let loaded = load_config(&path).expect("legacy config must load");
        assert_eq!(loaded.default_chat_model.as_deref(), Some("mistral"));
        assert!(loaded.model_curation.hidden_models.is_empty());
        assert_eq!(
            loaded.model_curation.version,
            crate::model_curation::CURATION_VERSION,
            "load should stamp the schema version"
        );
    }

    /// Deleting a profile must not delete the user's curation for it: re-adding
    /// the same endpoint restores their choices.
    #[test]
    fn removing_and_re_adding_a_profile_restores_its_curation() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        let profile = cfg.providers.active().expect("profile").clone();
        cfg.model_curation
            .set_model_hidden(&profile, "llama3", true);

        // User deletes the profile entirely.
        cfg.providers.profiles.clear();
        cfg.providers.active_id = None;
        save_config(&path, &cfg).expect("save");
        let loaded = load_config(&path).expect("load");

        // Re-adding the same kind + endpoint brings the curation back.
        assert_eq!(
            loaded.model_curation.hidden_by(&profile, "llama3"),
            Some(crate::model_curation::HiddenBy::Model)
        );
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            theme: "dark".into(),
            model_tools_enabled: std::collections::HashMap::from([(
                "ollama-local::chat-only".into(),
                false,
            )]),
            confluence: ConfluenceSettings {
                enabled: true,
                base_url: "https://wiki.example.com".into(),
                spaces: vec!["ENG".into()],
                pat_ref: Some(CONFLUENCE_PAT_REF.into()),
                ..ConfluenceSettings::default()
            },
            web_research_enabled: true,
            x: XSettings {
                enabled: true,
                api_key_ref: Some(X_API_KEY_REF.into()),
            },
            connectors: vec![crate::connectors::ConnectorConfig {
                id: "files-main".into(),
                kind: "files".into(),
                enabled: true,
                settings: serde_json::json!({}),
            }],
            ..AppConfig::default()
        };
        save_config(&path, &cfg).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.providers.active().unwrap().id, "ollama-local");
        assert!(loaded.confluence.is_configured());
        assert_eq!(loaded.confluence.spaces, vec!["ENG"]);
        assert!(loaded.web_research_enabled);
        assert!(loaded.x.is_configured());
        assert_eq!(loaded.connectors.len(), 1);
        assert_eq!(loaded.connectors[0].kind, "files");
        assert_eq!(
            loaded.model_tools_enabled.get("ollama-local::chat-only"),
            Some(&false)
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sk-"));
        assert!(!text.contains("ATATT"));
        assert!(text.contains("wiki.example.com"));
        assert!(text.contains(CONFLUENCE_PAT_REF));
        assert!(text.contains(X_API_KEY_REF));
        assert!(text.contains("web_research_enabled"));
        assert!(text.contains("files-main"));
    }

    #[test]
    fn x_defaults_off() {
        let cfg = AppConfig::default();
        assert!(!cfg.x.enabled);
        assert!(!cfg.x.is_configured());
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"providers":{"profiles":[],"active_id":null}}"#).unwrap();
        let loaded = load_config(&path).unwrap();
        assert!(!loaded.x.enabled);
    }

    #[test]
    fn web_research_defaults_off() {
        let cfg = AppConfig::default();
        assert!(!cfg.web_research_enabled);
        // Missing field on disk → false
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"providers":{"profiles":[],"active_id":null}}"#).unwrap();
        let loaded = load_config(&path).unwrap();
        assert!(!loaded.web_research_enabled);
    }

    #[test]
    fn confluence_not_configured_when_disabled() {
        let c = ConfluenceSettings {
            enabled: false,
            base_url: "https://wiki.example.com".into(),
            spaces: vec![],
            pat_ref: None,
            ..ConfluenceSettings::default()
        };
        assert!(!c.is_configured());
    }

    #[test]
    fn confluence_auth_from_pat_honors_basic_and_bearer() {
        let bearer = ConfluenceSettings {
            auth_mode: ConfluenceAuthMode::Bearer,
            ..ConfluenceSettings::default()
        };
        let h = bearer
            .auth_from_pat("server-pat")
            .unwrap()
            .authorization_header();
        assert_eq!(h, "Bearer server-pat");

        let basic_missing = ConfluenceSettings {
            auth_mode: ConfluenceAuthMode::Basic,
            basic_email: None,
            ..ConfluenceSettings::default()
        };
        assert!(basic_missing.auth_from_pat("tok").is_err());

        let basic = ConfluenceSettings {
            auth_mode: ConfluenceAuthMode::Basic,
            basic_email: Some("user@example.test".into()),
            ..ConfluenceSettings::default()
        };
        let h = basic
            .auth_from_pat("cloud-token")
            .unwrap()
            .authorization_header();
        assert!(h.starts_with("Basic "), "{h}");
        assert!(!h.contains("cloud-token"));
        // Round-trip: decode would be email:token — header must not print token in Debug either.
        let auth = basic.auth_from_pat("cloud-token").unwrap();
        assert!(!format!("{auth:?}").contains("cloud-token"));
    }

    #[test]
    #[allow(clippy::string_slice)] // ASCII-only include_str of host source; find offsets are char boundaries
    fn desktop_test_and_list_spaces_use_auth_from_pat() {
        // Structural proof: GUI host paths must not hardcode Bearer after Settings Basic.
        let host = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../desktop/src-tauri/src/lib.rs"
        ));
        let test_fn = host
            .find("fn test_confluence_config")
            .expect("test_confluence_config");
        let list_fn = host
            .find("fn list_confluence_spaces")
            .expect("list_confluence_spaces");
        let save_fn = host
            .find("struct SaveConfluenceReq")
            .expect("SaveConfluenceReq");
        let end = |start: usize, n: usize| (start + n).min(host.len());
        // These host fns are ~40–60 lines; take a wide ASCII window past the auth build.
        let test_body = &host[test_fn..end(test_fn, 2_800)];
        let list_body = &host[list_fn..end(list_fn, 2_400)];
        let save_body = &host[save_fn..end(save_fn, 1_200)];
        assert!(
            test_body.contains("auth_from_pat") && !test_body.contains("ConfluenceAuth::bearer"),
            "test_confluence_config must use auth_from_pat, not hardcode Bearer"
        );
        assert!(
            list_body.contains("auth_from_pat") && !list_body.contains("ConfluenceAuth::bearer"),
            "list_confluence_spaces must use auth_from_pat, not hardcode Bearer"
        );
        assert!(
            save_body.contains("auth_mode") && save_body.contains("basic_email"),
            "SaveConfluenceReq must persist auth_mode and basic_email"
        );
    }

    #[test]
    fn refuses_raw_secret_in_api_key_ref() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut providers = ProviderConfig::with_local_ollama();
        providers.profiles[0].api_key_ref = Some("sk-proj-totally-a-secret".into());
        let mut cfg = AppConfig {
            providers,
            ..AppConfig::default()
        };
        assert!(save_config(&path, &cfg).is_err());
        // Path-shaped refs are OK
        cfg.providers.profiles[0].api_key_ref = Some("provider/openai-compatible/api_key".into());
        assert!(save_config(&path, &cfg).is_ok());
    }

    #[test]
    fn a_config_without_the_retrieval_section_still_loads() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        save_config(&path, &cfg).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        value.as_object_mut().unwrap().remove("retrieval");
        std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.retrieval, RetrievalSettings::default());
        assert!(loaded.retrieval.embedding.is_none());
        assert!(loaded.retrieval.reranker.is_none());

        // Round-trips once configured (model names are configuration only).
        cfg.retrieval.reranker = Some(RetrievalRoleModel {
            enabled: false,
            base_url: "http://127.0.0.1:8080".into(),
            model: "qwen3-reranker-0.6b".into(),
            dialect: None,
            allow_remote: false,
            api_key_ref: None,
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
        });
        save_config(&path, &cfg).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(
            loaded.retrieval.reranker.as_ref().map(|r| r.model.as_str()),
            Some("qwen3-reranker-0.6b")
        );
    }

    #[test]
    fn a_config_without_the_multi_model_section_still_loads_as_single() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        save_config(&path, &cfg).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        value.as_object_mut().unwrap().remove("multi_model");
        std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.contributions, ContributionSettings::default());
        assert_eq!(loaded.multi_model, MultiModelSettings::default());
        assert_eq!(
            loaded.multi_model.mode,
            crate::multi_model::MultiModelMode::Single
        );
        assert!(loaded.multi_model.reviewer.is_none());
        assert_eq!(
            loaded.multi_model.budget.max_semantic_corrections_per_stage,
            1
        );

        // A reviewer references a profile id and never carries a raw secret.
        cfg.multi_model.mode = crate::multi_model::MultiModelMode::Review;
        cfg.multi_model.reviewer = Some(ReviewerRoleConfig {
            profile_id: "ollama-local".into(),
            model: None,
            require_qualified: true,
            allow_remote: false,
        });
        save_config(&path, &cfg).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(
            loaded.multi_model.mode,
            crate::multi_model::MultiModelMode::Review
        );
        assert_eq!(
            loaded
                .multi_model
                .reviewer
                .as_ref()
                .map(|r| r.profile_id.as_str()),
            Some("ollama-local")
        );
        assert!(
            loaded
                .multi_model
                .reviewer
                .as_ref()
                .unwrap()
                .require_qualified
        );
    }

    #[test]
    fn a_config_without_the_fast_triage_section_still_loads_as_disabled() {
        use crate::fast_triage::{
            FastTriageRouteRecord, FastTriageRouteVerdict, FastTriageWorkflowContract,
        };

        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        save_config(&path, &cfg).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        value.as_object_mut().unwrap().remove("fast_triage");
        std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.fast_triage, FastTriageSettings::default());
        assert!(!loaded.fast_triage.enabled);
        assert!(loaded.fast_triage.routes.is_empty());
        assert!(loaded.fast_triage.fallback.is_none());

        // Route evidence and a fallback round-trip, and both reference profile
        // and model ids only — never a gateway or a secret.
        cfg.fast_triage.enabled = true;
        cfg.fast_triage.routes = vec![FastTriageRouteRecord {
            profile_id: "ollama-local".into(),
            model_id: "some-configured-model".into(),
            workflow_contract: FastTriageWorkflowContract::HostGroundedSynthesisCompletePacket,
            verdict: FastTriageRouteVerdict::Qualified,
            contract_fingerprint: "a".repeat(64),
        }];
        cfg.fast_triage.fallback = Some(FastTriageFallbackConfig {
            profile_id: "ollama-local".into(),
            model: None,
            authorized: false,
            allow_remote: false,
        });
        save_config(&path, &cfg).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.fast_triage, cfg.fast_triage);
        // A configured fallback is not an authorized one.
        assert!(!loaded.fast_triage.fallback.as_ref().unwrap().authorized);
    }

    #[test]
    fn refuses_raw_secret_in_retrieval_api_key_ref() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        cfg.retrieval.embedding = Some(RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:11434".into(),
            model: "bge-m3".into(),
            dialect: None,
            allow_remote: false,
            api_key_ref: Some("sk-proj-not-a-reference".into()),
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
        });
        assert!(save_config(&path, &cfg).is_err());
        cfg.retrieval.embedding.as_mut().unwrap().api_key_ref =
            Some("provider/embedding/api_key".into());
        assert!(save_config(&path, &cfg).is_ok());
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            !written.contains("sk-proj"),
            "raw secret never reaches disk"
        );
    }
}
