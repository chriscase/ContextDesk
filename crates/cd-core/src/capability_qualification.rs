//! Explicit synthetic model capability qualification (#724).
//!
//! User-triggered only. Results are keyed by profile + normalized endpoint +
//! exact model id + probe schema version. Name hints from
//! [`crate::model_role_hints`] may select which probes to **offer**, but can
//! never produce a measured `pass`.
//!
//! All probe content is synthetic and data-free. Outbound messages are scrubbed
//! for company/log/workspace/evaluator sentinels. Probe tools are inert.

use crate::config::AppConfig;
use crate::error::{CoreError, CoreResult};
use crate::model_role_hints::{classify_model_role, ModelRoleHint};
use crate::probe::normalize_gateway_input;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Probe / result schema version (bump when probe contracts change).
pub const QUALIFICATION_SCHEMA_VERSION: &str = "contextdesk.capability_qualification.v1";

/// On-disk wrapper schema for the secret-free qualification evidence store.
pub const QUALIFICATION_STORE_SCHEMA_VERSION: u32 = 1;

/// Shared desktop/CLI filename under the ContextDesk configuration directory.
pub const QUALIFICATION_STORE_FILENAME: &str = "model-qualifications.json";

/// Synthetic generation prompt — never includes user data.
pub const SYNTH_GENERATION_PROMPT: &str =
    "ContextDesk synthetic qualification probe. Reply with exactly: QUALIFY_OK_V1";

/// Expected generation marker.
pub const SYNTH_GENERATION_MARKER: &str = "QUALIFY_OK_V1";

/// Inert tool name registered only for qualification.
pub const INERT_PROBE_TOOL_NAME: &str = "cd_qualify_echo";

/// Forbidden outbound substrings (company / evaluator / workspace sentinels).
pub const FORBIDDEN_OUTBOUND_SENTINELS: &[&str] = &[
    "company-data",
    "evaluator_truth",
    "EVALUATOR",
    "/Users/",
    "C:\\Users",
    "workspace root",
    "confluence",
    "secret",
    "sk-",
    "Bearer ",
    "password",
];

/// Measured capability identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    /// Basic chat completion with synthetic prompt.
    BasicGeneration,
    /// Model emits a native tool-call shape for the inert probe tool.
    NativeToolCall,
    /// Model continues after a bounded inert tool result.
    ToolResultContinuation,
    /// Structured JSON object where ContextDesk consumes it.
    StructuredOutput,
    /// Streaming yields at least one delta then completes.
    Streaming,
    /// Cancellation stops further tokens after cancel signal.
    Cancellation,
    /// Embedding endpoint returns a finite non-empty vector.
    EmbeddingContract,
    /// Reranker-style ranking response contract.
    RerankerContract,
}

impl CapabilityKind {
    /// Stable wire id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BasicGeneration => "basic_generation",
            Self::NativeToolCall => "native_tool_call",
            Self::ToolResultContinuation => "tool_result_continuation",
            Self::StructuredOutput => "structured_output",
            Self::Streaming => "streaming",
            Self::Cancellation => "cancellation",
            Self::EmbeddingContract => "embedding_contract",
            Self::RerankerContract => "reranker_contract",
        }
    }
}

/// Product execution contracts derived from measured capability checks. These
/// are intentionally narrower than the aggregate model-readiness label: a
/// model can support structured proposals while failing native tools, or the
/// reverse, and those cases need different routing decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityContract {
    /// Host-grounded model-generated text. Qualification proves only the
    /// generation envelope; grounding remains host-owned at execution time.
    #[serde(rename = "host_grounded_generation")]
    Generation,
    /// A host-validated JSON proposal, used by typed triage/review stages.
    #[serde(rename = "validated_structured_proposal")]
    JsonProposal,
    /// A complete native tool call followed by tool-result continuation.
    NativeToolLoop,
}

/// Whether an execution contract is currently supported by measured evidence.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContractVerdict {
    /// Every required probe is current and passed.
    Qualified,
    /// Current evidence measured a required probe that did not pass.
    Unqualified,
    /// Evidence is absent, stale, cancelled, or incomplete (including a
    /// report in which every required probe is `Untested`).
    #[default]
    Inconclusive,
}

impl ContractVerdict {
    /// Source-compatibility alias for callers compiled against the initial
    /// projection API. It serializes and compares exactly as `Inconclusive`;
    /// it is not a fourth runtime state.
    #[deprecated(note = "use ContractVerdict::Inconclusive")]
    #[allow(non_upper_case_globals)]
    pub const Unverified: Self = Self::Inconclusive;
}

impl CapabilityContract {
    /// Stable wire/display id for the execution mode.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Generation => "host_grounded_generation",
            Self::JsonProposal => "validated_structured_proposal",
            Self::NativeToolLoop => "native_tool_loop",
        }
    }

    fn required(self) -> &'static [CapabilityKind] {
        match self {
            Self::Generation => &[CapabilityKind::BasicGeneration],
            Self::JsonProposal => &[
                CapabilityKind::BasicGeneration,
                CapabilityKind::StructuredOutput,
            ],
            Self::NativeToolLoop => &[
                CapabilityKind::BasicGeneration,
                CapabilityKind::NativeToolCall,
                CapabilityKind::ToolResultContinuation,
            ],
        }
    }
}

/// Project one exact report into a routing-safe capability contract verdict.
///
/// This function deliberately returns `Inconclusive` for missing, stale,
/// cancelled, or untested evidence. It never uses a model name hint, an
/// aggregate readiness state, or a profile's tool setting as proof that the
/// remote model supports a contract.
pub fn capability_contract_verdict(
    report: Option<&QualificationReport>,
    contract: CapabilityContract,
) -> ContractVerdict {
    let Some(report) = report else {
        return ContractVerdict::Inconclusive;
    };
    if report.stale || report.cancelled {
        return ContractVerdict::Inconclusive;
    }
    let mut saw_untested = false;
    for kind in contract.required() {
        match report.status_of(*kind) {
            CapabilityStatus::Pass => {}
            CapabilityStatus::Untested => saw_untested = true,
            CapabilityStatus::Degraded | CapabilityStatus::Fail => {
                return ContractVerdict::Unqualified;
            }
        }
    }
    if saw_untested {
        ContractVerdict::Inconclusive
    } else {
        ContractVerdict::Qualified
    }
}

/// Shared, role-scoped execution projection consumed by CLI and desktop.
///
/// The projection is deliberately separate from [`ModelReadiness`]. A model
/// can be qualified for validated structured proposals while remaining
/// unqualified for native tools, and callers must not infer one contract from
/// another. `Inconclusive` is returned whenever evidence is absent, stale,
/// cancelled, or all required probes were skipped.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityContractProjection {
    /// Host-grounded generation contract.
    pub host_grounded_generation: ContractVerdict,
    /// Host-validated structured proposal contract.
    pub validated_structured_proposal: ContractVerdict,
    /// Native tool call + tool-result continuation contract.
    pub native_tool_loop: ContractVerdict,
}

impl CapabilityContractProjection {
    /// Read one contract from the projection by its shared enum identity.
    pub fn verdict(self, contract: CapabilityContract) -> ContractVerdict {
        match contract {
            CapabilityContract::Generation => self.host_grounded_generation,
            CapabilityContract::JsonProposal => self.validated_structured_proposal,
            CapabilityContract::NativeToolLoop => self.native_tool_loop,
        }
    }
}

/// Project all execution contracts for one exact qualification report.
///
/// An explicit tools-off gate never becomes a tool-capable claim. If tools are
/// disabled by profile configuration, the native-tool projection is
/// `Inconclusive` even when an old report happened to contain tool passes.
pub fn capability_contract_projection(
    report: Option<&QualificationReport>,
    gate: Option<&ProfileCapabilityGate>,
) -> CapabilityContractProjection {
    let mut projection = CapabilityContractProjection {
        host_grounded_generation: capability_contract_verdict(
            report,
            CapabilityContract::Generation,
        ),
        validated_structured_proposal: capability_contract_verdict(
            report,
            CapabilityContract::JsonProposal,
        ),
        native_tool_loop: capability_contract_verdict(report, CapabilityContract::NativeToolLoop),
    };
    if gate.is_some_and(|gate| !gate.tools_enabled) {
        projection.native_tool_loop = ContractVerdict::Inconclusive;
    }
    projection
}

/// Outcome of one capability check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    /// Probe observed the expected contract.
    Pass,
    /// Partial / weak contract (e.g. stream incomplete but usable).
    Degraded,
    /// Probe failed the expected contract.
    Fail,
    /// Not run (cancelled, gated, or not offered for this role).
    Untested,
}

/// One capability measurement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityCheckResult {
    /// Capability under test.
    pub kind: CapabilityKind,
    /// Measured outcome (never derived from a name hint alone).
    pub status: CapabilityStatus,
    /// Wall time for this probe in milliseconds.
    pub elapsed_ms: u64,
    /// Unix seconds when this check finished.
    pub tested_at: i64,
    /// Secret-free human reason.
    pub reason: String,
}

/// Cache / report identity (no raw secrets; endpoint is fingerprinted).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct QualificationKey {
    /// Provider profile id (local identity, not a secret).
    pub profile_id: String,
    /// SHA-256 hex of normalized endpoint (not the raw private URL).
    pub endpoint_fingerprint: String,
    /// Exact model id selected for qualification.
    pub model_id: String,
    /// Probe schema version that produced the report.
    pub schema_version: String,
}

impl QualificationKey {
    /// Build a key from profile identity fields.
    pub fn new(profile_id: &str, base_url: &str, model_id: &str) -> Self {
        Self {
            profile_id: profile_id.trim().to_string(),
            endpoint_fingerprint: fingerprint_endpoint(base_url),
            model_id: model_id.trim().to_string(),
            schema_version: QUALIFICATION_SCHEMA_VERSION.to_string(),
        }
    }

    /// Compact storage id.
    pub fn storage_id(&self) -> String {
        format!(
            "{}::{}::{}::{}",
            self.profile_id, self.endpoint_fingerprint, self.model_id, self.schema_version
        )
    }
}

/// Full qualification report for one exact profile/endpoint/model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QualificationReport {
    /// Exact profile/endpoint/model/schema identity for this report.
    pub key: QualificationKey,
    /// Per-capability measurements from this run.
    pub checks: Vec<CapabilityCheckResult>,
    /// #723 role hint used only to select which probes ran (never a pass source).
    pub role_hint: String,
    /// True when the user cancelled mid-run.
    pub cancelled: bool,
    /// True when cache is stale relative to current profile/endpoint/model/version.
    pub stale: bool,
    /// Unix seconds when the run finished (or was cancelled).
    pub finished_at: i64,
}

impl QualificationReport {
    /// Status for a kind, or `Untested` if absent.
    pub fn status_of(&self, kind: CapabilityKind) -> CapabilityStatus {
        self.checks
            .iter()
            .find(|c| c.kind == kind)
            .map(|c| c.status)
            .unwrap_or(CapabilityStatus::Untested)
    }
}

/// Profile-level capability flags that remain authoritative over probes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProfileCapabilityGate {
    /// Profile allows tool-calling probes.
    pub tools_enabled: bool,
    /// Profile allows streaming probes.
    pub stream_enabled: bool,
    /// Profile allows embedding probes.
    pub embeddings_enabled: bool,
}

/// In-memory store keyed by [`QualificationKey::storage_id`] (#650 isolation).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct QualificationStore {
    /// Reports keyed by [`QualificationKey::storage_id`].
    #[serde(default)]
    pub by_key: HashMap<String, QualificationReport>,
    /// Last successfully discovered catalog for each exact profile/endpoint.
    #[serde(default)]
    pub catalogs: HashMap<String, CatalogSnapshot>,
}

/// Secret-free snapshot of one gateway's last successful model catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogSnapshot {
    /// Stable local provider profile id.
    pub profile_id: String,
    /// Endpoint fingerprint; the raw private URL is never persisted here.
    pub endpoint_fingerprint: String,
    /// Sorted, de-duplicated model ids returned by the gateway.
    pub model_ids: Vec<String>,
    /// Stable digest of `model_ids` for cheap startup/pre-flight comparison.
    pub catalog_fingerprint: String,
    /// Unix seconds when the catalog was observed.
    pub observed_at: i64,
}

/// Difference between a newly discovered catalog and the persisted snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogChange {
    /// True for the first successful observation of this profile/endpoint.
    pub first_observation: bool,
    /// Models newly returned by the gateway.
    pub added: Vec<String>,
    /// Previously returned models absent from the new catalog.
    pub removed: Vec<String>,
    /// Number of model ids present in both snapshots.
    pub unchanged: usize,
    /// Digest of the new sorted model-id inventory.
    pub catalog_fingerprint: String,
}

impl CatalogChange {
    /// Whether the provider inventory changed after a prior observation.
    pub fn changed(&self) -> bool {
        !self.first_observation && (!self.added.is_empty() || !self.removed.is_empty())
    }
}

impl QualificationStore {
    /// Insert/replace one report without touching siblings.
    pub fn put(&mut self, report: QualificationReport) {
        self.by_key.insert(report.key.storage_id(), report);
    }

    /// Lookup by exact key.
    pub fn get(&self, key: &QualificationKey) -> Option<&QualificationReport> {
        self.by_key.get(&key.storage_id())
    }

    /// Mark stale when key parts diverge from current profile/endpoint/model/version.
    pub fn mark_stale_if_mismatch(
        &mut self,
        key: &QualificationKey,
        current: &QualificationKey,
    ) -> bool {
        let Some(report) = self.by_key.get_mut(&key.storage_id()) else {
            return false;
        };
        if report.key != *current {
            report.stale = true;
            return true;
        }
        // Same storage id implies same key fields.
        false
    }

    /// Mark prior reports for the **same profile + same model** as stale when
    /// endpoint fingerprint or schema version diverges from the current selection.
    ///
    /// Sibling models on the same profile are never touched (#650 isolation).
    /// Returns how many reports were newly marked stale.
    pub fn mark_stale_for_selection(&mut self, current: &QualificationKey) -> usize {
        let mut n = 0;
        for report in self.by_key.values_mut() {
            // Same exact model identity only — never sibling model_ids.
            if report.key.profile_id != current.profile_id
                || report.key.model_id != current.model_id
            {
                continue;
            }
            // Exact match (including schema) stays fresh.
            if report.key == *current {
                continue;
            }
            // Endpoint and/or schema diverged for this exact model.
            if !report.stale {
                report.stale = true;
                n += 1;
            }
        }
        n
    }

    /// Best cached report for the current selection: exact hit, else a near-miss
    /// (same profile + **same model**, different endpoint/schema) returned as stale.
    ///
    /// Never returns or mutates a sibling model_id (#650).
    pub fn get_for_selection(
        &mut self,
        current: &QualificationKey,
    ) -> Option<&QualificationReport> {
        self.mark_stale_for_selection(current);
        if self.by_key.contains_key(&current.storage_id()) {
            return self.by_key.get(&current.storage_id());
        }
        // Near miss: same profile + model under a previous endpoint/schema only.
        let near_id = self
            .by_key
            .values()
            .find(|r| {
                r.key.profile_id == current.profile_id
                    && r.key.model_id == current.model_id
                    && r.key != *current
            })
            .map(|r| r.key.storage_id());
        near_id.and_then(|id| self.by_key.get(&id))
    }

    /// Drop one exact model result only.
    pub fn remove(&mut self, key: &QualificationKey) -> bool {
        self.by_key.remove(&key.storage_id()).is_some()
    }

    /// Record a successful gateway catalog and stale only reports for models
    /// that disappeared. New siblings never invalidate unchanged evidence.
    pub fn note_catalog(
        &mut self,
        profile_id: &str,
        base_url: &str,
        model_ids: impl IntoIterator<Item = String>,
    ) -> CatalogChange {
        let endpoint_fingerprint = fingerprint_endpoint(base_url);
        let storage_id = catalog_storage_id(profile_id, &endpoint_fingerprint);
        let current: BTreeSet<String> = model_ids
            .into_iter()
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect();
        let prior: BTreeSet<String> = self
            .catalogs
            .get(&storage_id)
            .map(|snapshot| snapshot.model_ids.iter().cloned().collect())
            .unwrap_or_default();
        let first_observation = !self.catalogs.contains_key(&storage_id);
        let added = current.difference(&prior).cloned().collect::<Vec<_>>();
        let removed = prior.difference(&current).cloned().collect::<Vec<_>>();
        let unchanged = current.intersection(&prior).count();
        let model_ids = current.into_iter().collect::<Vec<_>>();
        let catalog_fingerprint = fingerprint_model_catalog(&model_ids);

        if !first_observation && !removed.is_empty() {
            for report in self.by_key.values_mut() {
                if report.key.profile_id == profile_id
                    && report.key.endpoint_fingerprint == endpoint_fingerprint
                    && removed.iter().any(|id| id == &report.key.model_id)
                {
                    report.stale = true;
                }
            }
        }
        self.catalogs.insert(
            storage_id,
            CatalogSnapshot {
                profile_id: profile_id.trim().to_string(),
                endpoint_fingerprint,
                model_ids,
                catalog_fingerprint: catalog_fingerprint.clone(),
                observed_at: now_secs(),
            },
        );
        CatalogChange {
            first_observation,
            added,
            removed,
            unchanged,
            catalog_fingerprint,
        }
    }

    /// Last successful catalog for the current profile/endpoint.
    pub fn catalog_for(&self, profile_id: &str, base_url: &str) -> Option<&CatalogSnapshot> {
        let endpoint_fingerprint = fingerprint_endpoint(base_url);
        self.catalogs
            .get(&catalog_storage_id(profile_id, &endpoint_fingerprint))
    }
}

fn catalog_storage_id(profile_id: &str, endpoint_fingerprint: &str) -> String {
    format!("{}::{endpoint_fingerprint}", profile_id.trim())
}

/// Stable SHA-256 digest of a sorted, de-duplicated model inventory.
pub fn fingerprint_model_catalog(model_ids: &[String]) -> String {
    let ids = model_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .collect::<BTreeSet<_>>();
    let mut hasher = Sha256::new();
    for id in ids {
        hasher.update(id.as_bytes());
        hasher.update([0]);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Functional role whose measured contract the readiness label describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelReadinessRole {
    /// ContextDesk tool-using triage/investigation turns.
    Chat,
    /// Embedding-vector retrieval.
    Embedding,
    /// Result reranking.
    Reranker,
    /// No role has been established beyond an ambiguous name hint.
    Unknown,
}

impl ModelReadinessRole {
    /// Stable wire id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Embedding => "embedding",
            Self::Reranker => "reranker",
            Self::Unknown => "unknown",
        }
    }
}

/// Evidence-backed readiness state for one exact profile/endpoint/model/role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelReadinessState {
    /// All core contracts required for the role passed synthetic probes.
    Verified,
    /// The model is usable for a narrower path, but a core contract was weak or failed.
    Limited,
    /// The role's entry contract failed.
    Failed,
    /// Measured evidence belongs to an older endpoint or probe schema.
    Stale,
    /// No current completed measurement establishes compatibility.
    Unverified,
}

impl ModelReadinessState {
    /// Stable wire/display id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Limited => "limited",
            Self::Failed => "failed",
            Self::Stale => "stale",
            Self::Unverified => "unverified",
        }
    }
}

/// Basis for a readiness projection. A name hint can suggest a role but never verify it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelReadinessBasis {
    /// Synthetic probes measured the configured endpoint.
    Measured,
    /// Only the model id supplied a suggested role.
    NameHint,
}

/// Compact readiness projection shared by GUI pickers and the CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelReadiness {
    /// Role this status describes.
    pub role: ModelReadinessRole,
    /// Current readiness verdict.
    pub state: ModelReadinessState,
    /// Whether the role came from measurement or only a name hint.
    pub basis: ModelReadinessBasis,
    /// Unix seconds of the completed measurement, when one exists.
    pub tested_at: Option<i64>,
    /// Secret-free explanation suitable for GUI and CLI display.
    pub detail: String,
}

impl ModelReadiness {
    /// Safe fallback for older hosts/fixtures or models with no evidence.
    pub fn unverified(model_id: &str) -> Self {
        let hint = classify_model_role(model_id);
        let role = match hint.role {
            ModelRoleHint::Investigator => ModelReadinessRole::Chat,
            ModelRoleHint::Embedding => ModelReadinessRole::Embedding,
            ModelRoleHint::Reranker => ModelReadinessRole::Reranker,
            ModelRoleHint::Unknown => ModelReadinessRole::Unknown,
        };
        let detail = match role {
            ModelReadinessRole::Chat => {
                "Not verified for ContextDesk triage; the role is a name hint only."
            }
            ModelReadinessRole::Embedding => {
                "Looks like an embedding model by name, but its embedding contract is not verified."
            }
            ModelReadinessRole::Reranker => {
                "Looks like a reranker by name, but its reranking contract is not verified."
            }
            ModelReadinessRole::Unknown => {
                "Role and ContextDesk compatibility have not been verified."
            }
        };
        Self {
            role,
            state: ModelReadinessState::Unverified,
            basis: ModelReadinessBasis::NameHint,
            tested_at: None,
            detail: detail.to_string(),
        }
    }

    /// Rank for an ordinary chat picker. Lower values are preferred.
    ///
    /// Specialty models stay below chat candidates even when their own role is
    /// verified: an embedding pass must never recommend that model for chat.
    pub fn chat_preference_rank(&self) -> u8 {
        match self.role {
            ModelReadinessRole::Chat => match self.state {
                ModelReadinessState::Verified => 0,
                ModelReadinessState::Limited => 1,
                ModelReadinessState::Unverified => 2,
                ModelReadinessState::Stale => 4,
                ModelReadinessState::Failed => 5,
            },
            // A private alias with no role hint remains worth trying before a
            // model that was measured and failed the triage entry contract.
            ModelReadinessRole::Unknown => 3,
            ModelReadinessRole::Embedding | ModelReadinessRole::Reranker => {
                let specialty_state_rank = match self.state {
                    ModelReadinessState::Verified => 0,
                    ModelReadinessState::Limited => 1,
                    ModelReadinessState::Unverified => 2,
                    ModelReadinessState::Stale => 3,
                    ModelReadinessState::Failed => 4,
                };
                20_u8.saturating_add(specialty_state_rank)
            }
        }
    }
}

impl Default for ModelReadiness {
    fn default() -> Self {
        Self::unverified("")
    }
}

/// One offline CLI row projected from configured models and persisted evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfiguredModelReadiness {
    /// Stable provider profile id.
    pub profile_id: String,
    /// Human provider label.
    pub profile_label: String,
    /// Exact model id sent to the provider.
    pub model_id: String,
    /// Whether this is the profile's configured chat model.
    pub configured_for_profile: bool,
    /// Whether current CLI/app defaults select this exact profile and model.
    pub is_default: bool,
    /// Role-specific readiness evidence.
    pub readiness: ModelReadiness,
}

#[derive(Debug, Serialize, Deserialize)]
struct QualificationStoreFile {
    schema_version: u32,
    store: QualificationStore,
}

/// Resolve the shared secret-free evidence path under a ContextDesk data directory.
pub fn qualification_store_path(config_dir: &Path) -> PathBuf {
    config_dir.join(QUALIFICATION_STORE_FILENAME)
}

/// Load persisted qualification evidence. An absent file is an empty store.
pub fn load_qualification_store(path: &Path) -> CoreResult<QualificationStore> {
    if !path.exists() {
        return Ok(QualificationStore::default());
    }
    let raw = fs::read_to_string(path)?;
    let file: QualificationStoreFile = serde_json::from_str(&raw)?;
    if file.schema_version != QUALIFICATION_STORE_SCHEMA_VERSION {
        return Err(CoreError::Config(format!(
            "unsupported qualification store schema {}",
            file.schema_version
        )));
    }
    Ok(file.store)
}

/// Atomically replace the shared secret-free qualification evidence file.
pub fn save_qualification_store(path: &Path, store: &QualificationStore) -> CoreResult<()> {
    if path.exists() {
        load_qualification_store(path).map_err(|error| {
            CoreError::Config(format!(
                "refusing to overwrite unreadable qualification evidence at {}: {error}",
                path.display()
            ))
        })?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = QualificationStoreFile {
        schema_version: QUALIFICATION_STORE_SCHEMA_VERSION,
        store: store.clone(),
    };
    let raw = serde_json::to_string_pretty(&file)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw)?;
    fs::rename(tmp, path)?;
    Ok(())
}

/// Project current readiness for one exact selection, including stale near-misses.
pub fn model_readiness_for_selection(
    store: &mut QualificationStore,
    current: &QualificationKey,
) -> ModelReadiness {
    let Some(report) = store.get_for_selection(current) else {
        return ModelReadiness::unverified(&current.model_id);
    };
    model_readiness_for_report(report)
}

/// Build the CLI's entirely offline inventory from config plus persisted evidence.
///
/// Previously qualified siblings on the current endpoint are included even if
/// they are not the profile's current chat model. Historical endpoints are not
/// surfaced as candidates; a matching current model still receives a stale
/// verdict through [`QualificationStore::get_for_selection`].
pub fn configured_model_readiness(
    cfg: &AppConfig,
    store: &mut QualificationStore,
    preferred_profile_id: Option<&str>,
    preferred_model_id: Option<&str>,
) -> Vec<ConfiguredModelReadiness> {
    let selected_profile = preferred_profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(cfg.providers.active_id.as_deref());
    let selected_model = preferred_model_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(cfg.default_chat_model.as_deref().map(str::trim));
    let mut rows = Vec::new();

    for profile in &cfg.providers.profiles {
        let current_endpoint = fingerprint_endpoint(&profile.base_url);
        let mut models = BTreeSet::new();
        if !profile.chat_model.trim().is_empty() {
            models.insert(profile.chat_model.trim().to_string());
        }
        if let Some(snapshot) = store.catalog_for(&profile.id, &profile.base_url) {
            models.extend(snapshot.model_ids.iter().cloned());
        }
        if selected_profile == Some(profile.id.as_str()) {
            if let Some(model) = selected_model {
                if !model.is_empty() {
                    models.insert(model.to_string());
                }
            }
        }
        for report in store.by_key.values() {
            if report.key.profile_id == profile.id
                && report.key.endpoint_fingerprint == current_endpoint
            {
                models.insert(report.key.model_id.clone());
            }
        }
        for model_id in models {
            let key = QualificationKey::new(&profile.id, &profile.base_url, &model_id);
            rows.push(ConfiguredModelReadiness {
                profile_id: profile.id.clone(),
                profile_label: profile.label.clone(),
                configured_for_profile: model_id == profile.chat_model.trim(),
                is_default: selected_profile == Some(profile.id.as_str())
                    && selected_model.unwrap_or(profile.chat_model.trim()) == model_id,
                readiness: model_readiness_for_selection(store, &key),
                model_id,
            });
        }
    }

    rows.sort_by(|a, b| {
        b.is_default
            .cmp(&a.is_default)
            .then_with(|| {
                a.readiness
                    .chat_preference_rank()
                    .cmp(&b.readiness.chat_preference_rank())
            })
            .then_with(|| a.profile_label.cmp(&b.profile_label))
            .then_with(|| a.model_id.cmp(&b.model_id))
    });
    rows
}

/// Project a role-specific verdict from one measured report.
pub fn model_readiness_for_report(report: &QualificationReport) -> ModelReadiness {
    let role = match report.role_hint.as_str() {
        "embedding" => ModelReadinessRole::Embedding,
        "reranker" => ModelReadinessRole::Reranker,
        // Unknown ids receive the same chat-contract probes as investigator ids.
        "chat" | "unknown" => ModelReadinessRole::Chat,
        _ => ModelReadinessRole::Unknown,
    };
    if report.stale {
        return ModelReadiness {
            role,
            state: ModelReadinessState::Stale,
            basis: ModelReadinessBasis::Measured,
            tested_at: Some(report.finished_at),
            detail: "Prior measured result is stale for the current endpoint or probe schema."
                .into(),
        };
    }
    if report.cancelled {
        return ModelReadiness {
            role,
            state: ModelReadinessState::Unverified,
            basis: ModelReadinessBasis::Measured,
            tested_at: Some(report.finished_at),
            detail: "Qualification was cancelled; compatibility remains unverified.".into(),
        };
    }

    let (state, detail) = match role {
        ModelReadinessRole::Chat | ModelReadinessRole::Unknown => project_chat_readiness(report),
        ModelReadinessRole::Embedding => project_single_contract(
            report.status_of(CapabilityKind::EmbeddingContract),
            "embedding",
        ),
        ModelReadinessRole::Reranker => project_single_contract(
            report.status_of(CapabilityKind::RerankerContract),
            "reranking",
        ),
    };
    ModelReadiness {
        role,
        state,
        basis: ModelReadinessBasis::Measured,
        tested_at: Some(report.finished_at),
        detail,
    }
}

fn project_chat_readiness(report: &QualificationReport) -> (ModelReadinessState, String) {
    let basic = report.status_of(CapabilityKind::BasicGeneration);
    if basic == CapabilityStatus::Fail {
        return (
            ModelReadinessState::Failed,
            "Basic generation for the ContextDesk triage path failed verification.".into(),
        );
    }
    if basic == CapabilityStatus::Untested {
        return (
            ModelReadinessState::Unverified,
            "Basic generation for the ContextDesk triage path was not tested.".into(),
        );
    }
    if basic == CapabilityStatus::Degraded {
        return (
            ModelReadinessState::Limited,
            "The model generated text, but the basic response contract was degraded.".into(),
        );
    }

    let core = [
        CapabilityKind::NativeToolCall,
        CapabilityKind::ToolResultContinuation,
        CapabilityKind::StructuredOutput,
    ];
    if core
        .iter()
        .all(|kind| report.status_of(*kind) == CapabilityStatus::Pass)
    {
        let supporting = [CapabilityKind::Streaming, CapabilityKind::Cancellation];
        let detail = if supporting
            .iter()
            .all(|kind| report.status_of(*kind) == CapabilityStatus::Pass)
        {
            "Verified for ContextDesk triage generation, tools, structured output, streaming, and cancellation."
        } else {
            "Verified for core ContextDesk triage and investigation contracts; review streaming and cancellation details."
        };
        return (ModelReadinessState::Verified, detail.into());
    }

    (
        ModelReadinessState::Limited,
        "Basic generation works, but one or more triage tool-use or structured-output contracts did not pass."
            .into(),
    )
}

fn project_single_contract(status: CapabilityStatus, role: &str) -> (ModelReadinessState, String) {
    match status {
        CapabilityStatus::Pass => (
            ModelReadinessState::Verified,
            format!("Verified for the ContextDesk {role} contract."),
        ),
        CapabilityStatus::Degraded => (
            ModelReadinessState::Limited,
            format!("The ContextDesk {role} contract is usable but degraded."),
        ),
        CapabilityStatus::Fail => (
            ModelReadinessState::Failed,
            format!("The ContextDesk {role} contract failed verification."),
        ),
        CapabilityStatus::Untested => (
            ModelReadinessState::Unverified,
            format!("The ContextDesk {role} contract was not tested."),
        ),
    }
}

/// Synthetic chat request (data-free).
#[derive(Debug, Clone)]
pub struct SyntheticChatRequest {
    /// Exact model id for this request.
    pub model_id: String,
    /// Synthetic messages only (no user/workspace content).
    pub messages: Vec<SyntheticMessage>,
    /// Inert tools offered for this probe (if any).
    pub tools: Vec<InertToolSpec>,
    /// Whether the transport should stream tokens.
    pub stream: bool,
    /// Whether the transport should request JSON-object structured output.
    pub expect_json_object: bool,
}

/// Chat message for probes.
#[derive(Debug, Clone)]
pub struct SyntheticMessage {
    /// OpenAI-style role (`user`, `assistant`, `tool`, …).
    pub role: String,
    /// Message body (synthetic only).
    pub content: String,
    /// Tool-call id when role is `tool`.
    pub tool_call_id: Option<String>,
    /// Native tool calls when role is `assistant`.
    pub tool_calls: Vec<SyntheticToolCall>,
}

/// Tool call emitted by the model (or injected in scripted transport).
#[derive(Debug, Clone)]
pub struct SyntheticToolCall {
    /// Provider tool-call id.
    pub id: String,
    /// Tool function name.
    pub name: String,
    /// JSON arguments string.
    pub arguments_json: String,
}

/// Inert tool offered to the model during qualification.
#[derive(Debug, Clone)]
pub struct InertToolSpec {
    /// Tool name (must be the host-validated inert name).
    pub name: String,
    /// Short description shown to the model.
    pub description: String,
    /// JSON Schema parameters object as a string.
    pub parameters_json: String,
}

/// Response from a non-stream or completed stream probe.
#[derive(Debug, Clone, Default)]
pub struct SyntheticChatResponse {
    /// Assistant text content.
    pub content: String,
    /// Native tool calls (empty when prose-only).
    pub tool_calls: Vec<SyntheticToolCall>,
    /// True when at least one stream delta was observed.
    pub streamed: bool,
    /// True when cancel stopped further tokens.
    pub cancelled: bool,
    /// Transport-level error text (secret-scrubbed before reporting).
    pub raw_error: Option<String>,
}

/// Embedding probe response.
#[derive(Debug, Clone, Default)]
pub struct SyntheticEmbeddingResponse {
    /// Finite non-empty embedding vector on success.
    pub vector: Vec<f32>,
    /// Transport-level error text when the call failed.
    pub raw_error: Option<String>,
}

/// Reranker probe response (ordered document indices).
#[derive(Debug, Clone, Default)]
pub struct SyntheticRerankResponse {
    /// Ordered document ids from best to worst.
    pub ranked_ids: Vec<String>,
    /// Transport-level error text when the call failed.
    pub raw_error: Option<String>,
}

/// Transport errors (secret-free reasons for reports).
#[derive(Debug, Clone)]
pub struct TransportError {
    /// Secret-free failure reason.
    pub reason: String,
}

/// Injectable transport for qualification (mock in tests; live in host).
pub trait QualificationTransport {
    /// Non-stream chat completion (or stream collected to a final message).
    fn chat_complete(
        &mut self,
        req: &SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, TransportError>;

    /// Embedding vector for a synthetic text.
    fn embed(
        &mut self,
        model_id: &str,
        text: &str,
        cancel: &AtomicBool,
    ) -> Result<SyntheticEmbeddingResponse, TransportError>;

    /// Rerank synthetic document ids for a synthetic query.
    fn rerank(
        &mut self,
        model_id: &str,
        query: &str,
        document_ids: &[&str],
        cancel: &AtomicBool,
    ) -> Result<SyntheticRerankResponse, TransportError>;
}

/// Fingerprint a base URL without retaining the private host string in exports.
pub fn fingerprint_endpoint(base_url: &str) -> String {
    let normalized = normalize_gateway_input(base_url);
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Which capability probes to offer based on #723 role hint (never a pass).
pub fn probes_for_role_hint(role: ModelRoleHint) -> Vec<CapabilityKind> {
    match role {
        ModelRoleHint::Investigator | ModelRoleHint::Unknown => vec![
            CapabilityKind::BasicGeneration,
            CapabilityKind::NativeToolCall,
            CapabilityKind::ToolResultContinuation,
            CapabilityKind::StructuredOutput,
            CapabilityKind::Streaming,
            CapabilityKind::Cancellation,
        ],
        ModelRoleHint::Embedding => vec![CapabilityKind::EmbeddingContract],
        ModelRoleHint::Reranker => vec![CapabilityKind::RerankerContract],
    }
}

/// Inert tool definitions (host must validate — no filesystem/network).
pub fn inert_probe_tools() -> Vec<InertToolSpec> {
    vec![InertToolSpec {
        name: INERT_PROBE_TOOL_NAME.into(),
        description:
            "ContextDesk synthetic qualification echo. Returns the provided token. No side effects."
                .into(),
        parameters_json:
            r#"{"type":"object","properties":{"token":{"type":"string"}},"required":["token"]}"#
                .into(),
    }]
}

/// Host-side execution of the inert tool (pure, no I/O).
pub fn execute_inert_probe_tool(name: &str, arguments_json: &str) -> Result<String, String> {
    if name != INERT_PROBE_TOOL_NAME {
        return Err("unknown_probe_tool".into());
    }
    let v: serde_json::Value =
        serde_json::from_str(arguments_json).map_err(|_| "invalid_tool_arguments".to_string())?;
    let token = v
        .get("token")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "missing_token".to_string())?;
    if token.len() > 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("token_rejected".into());
    }
    Ok(format!(r#"{{"echo":"{token}"}}"#))
}

/// Assert outbound text has no forbidden sentinels (for tests and host scrub).
pub fn assert_outbound_clean(text: &str) -> Result<(), String> {
    let lower = text.to_ascii_lowercase();
    for s in FORBIDDEN_OUTBOUND_SENTINELS {
        if lower.contains(&s.to_ascii_lowercase()) {
            return Err(format!("forbidden_sentinel:{s}"));
        }
    }
    Ok(())
}

/// Scrub free-text reasons for accidental secret shapes.
pub fn redact_reason(raw: &str) -> String {
    crate::redact::ShareSafeRedactionPolicy::default().redact_text(raw)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn elapsed_ms(start: std::time::Instant) -> u64 {
    start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn check(
    kind: CapabilityKind,
    status: CapabilityStatus,
    start: std::time::Instant,
    reason: impl Into<String>,
) -> CapabilityCheckResult {
    CapabilityCheckResult {
        kind,
        status,
        elapsed_ms: elapsed_ms(start),
        tested_at: now_secs(),
        reason: redact_reason(&reason.into()),
    }
}

/// Run a qualification suite against an injectable transport.
///
/// `cancel` is the **user** cancel flag only. The cancellation *capability*
/// probe uses a probe-local signal and must never set this flag.
pub fn run_qualification(
    key: QualificationKey,
    gate: ProfileCapabilityGate,
    transport: &mut dyn QualificationTransport,
    cancel: &Arc<AtomicBool>,
) -> QualificationReport {
    let role = classify_model_role(&key.model_id);
    let offered = probes_for_role_hint(role.role);
    let mut checks = Vec::new();

    for kind in offered {
        // User cancel (or residual flag): fill remaining as untested — never skip rows.
        if cancel.load(Ordering::SeqCst) {
            checks.push(check(
                kind,
                CapabilityStatus::Untested,
                std::time::Instant::now(),
                "cancelled before probe",
            ));
            continue;
        }
        let start = std::time::Instant::now();
        let result = match kind {
            CapabilityKind::BasicGeneration => probe_basic_generation(transport, &key, cancel),
            CapabilityKind::NativeToolCall => {
                if !gate.tools_enabled {
                    check(
                        kind,
                        CapabilityStatus::Fail,
                        start,
                        "profile tools disabled (authoritative)",
                    )
                } else {
                    probe_native_tool_call(transport, &key, cancel)
                }
            }
            CapabilityKind::ToolResultContinuation => {
                if !gate.tools_enabled {
                    check(
                        kind,
                        CapabilityStatus::Fail,
                        start,
                        "profile tools disabled (authoritative)",
                    )
                } else {
                    probe_tool_result_continuation(transport, &key, cancel)
                }
            }
            CapabilityKind::StructuredOutput => probe_structured_output(transport, &key, cancel),
            CapabilityKind::Streaming => {
                if !gate.stream_enabled {
                    check(
                        kind,
                        CapabilityStatus::Fail,
                        start,
                        "profile stream disabled (authoritative)",
                    )
                } else {
                    probe_streaming(transport, &key, cancel)
                }
            }
            CapabilityKind::Cancellation => probe_cancellation(transport, &key, cancel),
            CapabilityKind::EmbeddingContract => {
                if !gate.embeddings_enabled {
                    check(
                        kind,
                        CapabilityStatus::Fail,
                        start,
                        "profile embeddings disabled (authoritative)",
                    )
                } else {
                    probe_embedding(transport, &key, cancel)
                }
            }
            CapabilityKind::RerankerContract => probe_reranker(transport, &key, cancel),
        };
        checks.push(result);
        // Do not break: remaining kinds are filled as untested on the next iterations.
    }

    // Name hint must never appear as a measured pass source — only role_hint field.
    // report.cancelled means the *user* cancel flag only (not the cancellation probe).
    QualificationReport {
        key,
        checks,
        role_hint: role.role.as_kind_str().to_string(),
        cancelled: cancel.load(Ordering::SeqCst),
        stale: false,
        finished_at: now_secs(),
    }
}

fn probe_basic_generation(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: SYNTH_GENERATION_PROMPT.into(),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: vec![],
        stream: false,
        expect_json_object: false,
    };
    if let Err(e) = assert_outbound_clean(&req.messages[0].content) {
        return check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Fail,
            start,
            e,
        );
    }
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if cancel.load(Ordering::SeqCst) || resp.cancelled => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Untested,
            start,
            "cancelled during generation",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_else(|| "provider_error".into()),
        ),
        Ok(resp) if resp.content.contains(SYNTH_GENERATION_MARKER) => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Pass,
            start,
            "synthetic marker present in completion",
        ),
        Ok(resp) if !resp.content.trim().is_empty() => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Degraded,
            start,
            "completion non-empty but missing synthetic marker",
        ),
        Ok(_) => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Fail,
            start,
            "empty completion",
        ),
        Err(e) => check(
            CapabilityKind::BasicGeneration,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_native_tool_call(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: format!(
                "ContextDesk synthetic tool probe. Call tool {INERT_PROBE_TOOL_NAME} with token QUALIFY_TOOL_V1."
            ),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: inert_probe_tools(),
        stream: false,
        expect_json_object: false,
    };
    let _ = assert_outbound_clean(&req.messages[0].content);
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if resp.cancelled || cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::NativeToolCall,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => {
            let reason = resp.raw_error.unwrap_or_default();
            if reason.contains("tools_unsupported") {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Fail,
                    start,
                    "tools_unsupported",
                )
            } else {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Fail,
                    start,
                    reason,
                )
            }
        }
        Ok(resp) => {
            let hit = resp
                .tool_calls
                .iter()
                .any(|t| t.name == INERT_PROBE_TOOL_NAME);
            // Fabricated prose that only *mentions* tools must not pass.
            let prose_fake =
                resp.content.contains(INERT_PROBE_TOOL_NAME) && resp.tool_calls.is_empty();
            if hit {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Pass,
                    start,
                    "native tool_call for inert probe tool",
                )
            } else if prose_fake {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Fail,
                    start,
                    "tool-shaped prose without native tool_call",
                )
            } else {
                check(
                    CapabilityKind::NativeToolCall,
                    CapabilityStatus::Fail,
                    start,
                    "no native tool_call observed",
                )
            }
        }
        Err(e) => check(
            CapabilityKind::NativeToolCall,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_tool_result_continuation(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let tool_result =
        match execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"QUALIFY_TOOL_V1"}"#) {
            Ok(s) => s,
            Err(e) => {
                return check(
                    CapabilityKind::ToolResultContinuation,
                    CapabilityStatus::Fail,
                    start,
                    e,
                );
            }
        };
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![
            SyntheticMessage {
                role: "user".into(),
                content: "ContextDesk synthetic continuation probe.".into(),
                tool_call_id: None,
                tool_calls: vec![],
            },
            SyntheticMessage {
                role: "assistant".into(),
                content: String::new(),
                tool_call_id: None,
                tool_calls: vec![SyntheticToolCall {
                    id: "call_qualify_1".into(),
                    name: INERT_PROBE_TOOL_NAME.into(),
                    arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                }],
            },
            SyntheticMessage {
                role: "tool".into(),
                content: tool_result,
                tool_call_id: Some("call_qualify_1".into()),
                tool_calls: vec![],
            },
        ],
        tools: inert_probe_tools(),
        stream: false,
        expect_json_object: false,
    };
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if resp.cancelled || cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_default(),
        ),
        Ok(resp) if !resp.content.trim().is_empty() => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Pass,
            start,
            "non-empty continuation after inert tool result",
        ),
        Ok(_) => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Fail,
            start,
            "empty continuation",
        ),
        Err(e) => check(
            CapabilityKind::ToolResultContinuation,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_structured_output(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: r#"ContextDesk synthetic structured probe. Reply with JSON only: {"qualify":"ok","v":1}"#.into(),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: vec![],
        stream: false,
        expect_json_object: true,
    };
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if resp.cancelled || cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::StructuredOutput,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::StructuredOutput,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_default(),
        ),
        Ok(resp) => {
            let parsed = serde_json::from_str::<serde_json::Value>(resp.content.trim());
            match parsed {
                Ok(v) if v.get("qualify").and_then(|x| x.as_str()) == Some("ok") => check(
                    CapabilityKind::StructuredOutput,
                    CapabilityStatus::Pass,
                    start,
                    "valid synthetic JSON object",
                ),
                Ok(_) => check(
                    CapabilityKind::StructuredOutput,
                    CapabilityStatus::Degraded,
                    start,
                    "JSON object missing expected fields",
                ),
                Err(_) => check(
                    CapabilityKind::StructuredOutput,
                    CapabilityStatus::Fail,
                    start,
                    "response is not a JSON object",
                ),
            }
        }
        Err(e) => check(
            CapabilityKind::StructuredOutput,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_streaming(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: SYNTH_GENERATION_PROMPT.into(),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: vec![],
        stream: true,
        expect_json_object: false,
    };
    match transport.chat_complete(&req, cancel) {
        Ok(resp) if resp.cancelled || cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.streamed && !resp.content.is_empty() => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Pass,
            start,
            "stream deltas observed",
        ),
        Ok(resp) if !resp.content.is_empty() => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Degraded,
            start,
            "completion without stream flag",
        ),
        Ok(_) => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Fail,
            start,
            "no stream content",
        ),
        Err(e) => check(
            CapabilityKind::Streaming,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_cancellation(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    user_cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    // User cancel before this probe: leave untested (do not measure).
    if user_cancel.load(Ordering::SeqCst) {
        return check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Untested,
            start,
            "cancelled before probe",
        );
    }
    // Probe-local cancel signal only — never store into the user-cancel flag.
    // report.cancelled must mean the user cancelled the qualification run.
    let probe_cancel = AtomicBool::new(true);
    let req = SyntheticChatRequest {
        model_id: key.model_id.clone(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: SYNTH_GENERATION_PROMPT.into(),
            tool_call_id: None,
            tool_calls: vec![],
        }],
        tools: vec![],
        stream: true,
        expect_json_object: false,
    };
    match transport.chat_complete(&req, &probe_cancel) {
        Ok(resp) if resp.cancelled => check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Pass,
            start,
            "transport reported cancelled",
        ),
        Err(e) if e.reason.to_ascii_lowercase().contains("cancel") => check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Pass,
            start,
            "cancelled via transport error",
        ),
        Ok(_) => check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Fail,
            start,
            "completion ignored cancel signal",
        ),
        Err(e) => check(
            CapabilityKind::Cancellation,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_embedding(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let text = "ContextDesk synthetic embed token QUALIFY_EMBED_V1";
    let _ = assert_outbound_clean(text);
    match transport.embed(&key.model_id, text, cancel) {
        Ok(_resp) if cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_default(),
        ),
        Ok(resp) if !resp.vector.is_empty() && resp.vector.iter().all(|f| f.is_finite()) => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Pass,
            start,
            format!("vector_len={}", resp.vector.len()),
        ),
        Ok(_) => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Fail,
            start,
            "empty or non-finite embedding",
        ),
        Err(e) => check(
            CapabilityKind::EmbeddingContract,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

fn probe_reranker(
    transport: &mut dyn QualificationTransport,
    key: &QualificationKey,
    cancel: &AtomicBool,
) -> CapabilityCheckResult {
    let start = std::time::Instant::now();
    let docs = ["doc_a", "doc_b", "doc_c"];
    let query = "ContextDesk synthetic rerank query QUALIFY_RERANK_V1";
    let _ = assert_outbound_clean(query);
    match transport.rerank(&key.model_id, query, &docs, cancel) {
        Ok(_resp) if cancel.load(Ordering::SeqCst) => check(
            CapabilityKind::RerankerContract,
            CapabilityStatus::Untested,
            start,
            "cancelled",
        ),
        Ok(resp) if resp.raw_error.is_some() => check(
            CapabilityKind::RerankerContract,
            CapabilityStatus::Fail,
            start,
            resp.raw_error.unwrap_or_default(),
        ),
        Ok(resp)
            if !resp.ranked_ids.is_empty()
                && resp.ranked_ids.iter().all(|id| docs.contains(&id.as_str())) =>
        {
            check(
                CapabilityKind::RerankerContract,
                CapabilityStatus::Pass,
                start,
                "ranked ids are a permutation of synthetic docs",
            )
        }
        Ok(_) => check(
            CapabilityKind::RerankerContract,
            CapabilityStatus::Fail,
            start,
            "malformed rerank ranking",
        ),
        Err(e) => check(
            CapabilityKind::RerankerContract,
            CapabilityStatus::Fail,
            start,
            e.reason,
        ),
    }
}

// ---------------------------------------------------------------------------
// Scripted mock transport for deterministic tests
// ---------------------------------------------------------------------------

/// Scripted responses for unit tests (no network).
#[derive(Debug, Default)]
pub struct ScriptedQualificationTransport {
    /// FIFO of chat responses (popped from the end).
    pub chat_queue: Vec<Result<SyntheticChatResponse, TransportError>>,
    /// FIFO of embedding responses (popped from the end).
    pub embed_queue: Vec<Result<SyntheticEmbeddingResponse, TransportError>>,
    /// FIFO of rerank responses (popped from the end).
    pub rerank_queue: Vec<Result<SyntheticRerankResponse, TransportError>>,
    /// Last chat request observed (for outbound scrub assertions).
    pub last_chat: Option<SyntheticChatRequest>,
    /// Last embedding text observed.
    pub last_embed_text: Option<String>,
    /// Last rerank query observed.
    pub last_rerank_query: Option<String>,
    /// When true, cancelled flags short-circuit before consuming queues.
    pub honor_cancel: bool,
}

impl QualificationTransport for ScriptedQualificationTransport {
    fn chat_complete(
        &mut self,
        req: &SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, TransportError> {
        self.last_chat = Some(req.clone());
        if self.honor_cancel && cancel.load(Ordering::SeqCst) {
            return Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            });
        }
        self.chat_queue
            .pop()
            .unwrap_or_else(|| {
                Err(TransportError {
                    reason: "scripted_chat_exhausted".into(),
                })
            })
            .map(|mut r| {
                if req.stream {
                    r.streamed = true;
                }
                r
            })
    }

    fn embed(
        &mut self,
        _model_id: &str,
        text: &str,
        cancel: &AtomicBool,
    ) -> Result<SyntheticEmbeddingResponse, TransportError> {
        self.last_embed_text = Some(text.to_string());
        if self.honor_cancel && cancel.load(Ordering::SeqCst) {
            return Err(TransportError {
                reason: "cancelled".into(),
            });
        }
        self.embed_queue.pop().unwrap_or_else(|| {
            Err(TransportError {
                reason: "scripted_embed_exhausted".into(),
            })
        })
    }

    fn rerank(
        &mut self,
        _model_id: &str,
        query: &str,
        _document_ids: &[&str],
        cancel: &AtomicBool,
    ) -> Result<SyntheticRerankResponse, TransportError> {
        self.last_rerank_query = Some(query.to_string());
        if self.honor_cancel && cancel.load(Ordering::SeqCst) {
            return Err(TransportError {
                reason: "cancelled".into(),
            });
        }
        self.rerank_queue.pop().unwrap_or_else(|| {
            Err(TransportError {
                reason: "scripted_rerank_exhausted".into(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(model: &str) -> QualificationKey {
        QualificationKey::new("profile-a", "https://gateway.example.com/v1", model)
    }

    fn gate_full() -> ProfileCapabilityGate {
        ProfileCapabilityGate {
            tools_enabled: true,
            stream_enabled: true,
            embeddings_enabled: true,
        }
    }

    fn readiness_report(
        key: QualificationKey,
        role_hint: &str,
        checks: &[(CapabilityKind, CapabilityStatus)],
    ) -> QualificationReport {
        QualificationReport {
            key,
            checks: checks
                .iter()
                .map(|(kind, status)| CapabilityCheckResult {
                    kind: *kind,
                    status: *status,
                    elapsed_ms: 1,
                    tested_at: 100,
                    reason: "synthetic test result".into(),
                })
                .collect(),
            role_hint: role_hint.into(),
            cancelled: false,
            stale: false,
            finished_at: 100,
        }
    }

    #[test]
    fn capability_contracts_distinguish_structured_output_from_native_tools() {
        let report = readiness_report(
            key("deepseek-v4-flash"),
            "chat",
            &[
                (CapabilityKind::BasicGeneration, CapabilityStatus::Pass),
                (CapabilityKind::StructuredOutput, CapabilityStatus::Pass),
                (CapabilityKind::NativeToolCall, CapabilityStatus::Fail),
                (
                    CapabilityKind::ToolResultContinuation,
                    CapabilityStatus::Fail,
                ),
            ],
        );
        assert_eq!(
            capability_contract_verdict(Some(&report), CapabilityContract::Generation),
            ContractVerdict::Qualified
        );
        assert_eq!(
            capability_contract_verdict(Some(&report), CapabilityContract::JsonProposal),
            ContractVerdict::Qualified
        );
        assert_eq!(
            capability_contract_verdict(Some(&report), CapabilityContract::NativeToolLoop),
            ContractVerdict::Unqualified
        );
    }

    #[test]
    fn capability_contracts_treat_absent_stale_cancelled_and_untested_as_inconclusive() {
        let key = key("deepseek-v4-flash");
        assert_eq!(
            capability_contract_verdict(None, CapabilityContract::Generation),
            ContractVerdict::Inconclusive
        );

        let mut stale = readiness_report(
            key.clone(),
            "chat",
            &[(CapabilityKind::BasicGeneration, CapabilityStatus::Pass)],
        );
        stale.stale = true;
        assert_eq!(
            capability_contract_verdict(Some(&stale), CapabilityContract::Generation),
            ContractVerdict::Inconclusive
        );

        let mut cancelled = stale.clone();
        cancelled.stale = false;
        cancelled.cancelled = true;
        assert_eq!(
            capability_contract_verdict(Some(&cancelled), CapabilityContract::Generation),
            ContractVerdict::Inconclusive
        );

        let incomplete = readiness_report(
            key,
            "chat",
            &[(CapabilityKind::BasicGeneration, CapabilityStatus::Pass)],
        );
        assert_eq!(
            capability_contract_verdict(Some(&incomplete), CapabilityContract::JsonProposal),
            ContractVerdict::Inconclusive
        );
    }

    #[test]
    fn capability_projection_is_scoped_and_respects_tools_off() {
        let report = readiness_report(
            key("deepseek-v4-flash"),
            "chat",
            &[
                (CapabilityKind::BasicGeneration, CapabilityStatus::Pass),
                (CapabilityKind::StructuredOutput, CapabilityStatus::Pass),
                (CapabilityKind::NativeToolCall, CapabilityStatus::Pass),
                (
                    CapabilityKind::ToolResultContinuation,
                    CapabilityStatus::Pass,
                ),
            ],
        );
        let tools_on = ProfileCapabilityGate {
            tools_enabled: true,
            ..ProfileCapabilityGate::default()
        };
        let tools_off = ProfileCapabilityGate::default();
        let on = capability_contract_projection(Some(&report), Some(&tools_on));
        assert_eq!(
            on.verdict(CapabilityContract::Generation),
            ContractVerdict::Qualified
        );
        assert_eq!(
            on.verdict(CapabilityContract::JsonProposal),
            ContractVerdict::Qualified
        );
        assert_eq!(
            on.verdict(CapabilityContract::NativeToolLoop),
            ContractVerdict::Qualified
        );

        let off = capability_contract_projection(Some(&report), Some(&tools_off));
        assert_eq!(
            off.verdict(CapabilityContract::Generation),
            ContractVerdict::Qualified
        );
        assert_eq!(
            off.verdict(CapabilityContract::JsonProposal),
            ContractVerdict::Qualified
        );
        assert_eq!(
            off.verdict(CapabilityContract::NativeToolLoop),
            ContractVerdict::Inconclusive
        );
    }

    #[test]
    fn capability_projection_all_not_run_is_inconclusive_for_every_contract() {
        let report = readiness_report(key("deepseek-v4-flash"), "chat", &[]);
        let projection = capability_contract_projection(Some(&report), None);
        assert_eq!(
            projection.host_grounded_generation,
            ContractVerdict::Inconclusive
        );
        assert_eq!(
            projection.validated_structured_proposal,
            ContractVerdict::Inconclusive
        );
        assert_eq!(projection.native_tool_loop, ContractVerdict::Inconclusive);

        let mut stale = report.clone();
        stale.stale = true;
        assert_eq!(
            capability_contract_projection(Some(&stale), None),
            CapabilityContractProjection::default()
        );
        let mut cancelled = report;
        cancelled.cancelled = true;
        assert_eq!(
            capability_contract_projection(Some(&cancelled), None),
            CapabilityContractProjection::default()
        );
    }

    #[test]
    fn readiness_requires_measured_role_contracts() {
        let no_evidence = ModelReadiness::unverified("bge-m3");
        assert_eq!(no_evidence.role, ModelReadinessRole::Embedding);
        assert_eq!(no_evidence.state, ModelReadinessState::Unverified);
        assert_eq!(no_evidence.basis, ModelReadinessBasis::NameHint);

        let chat_key = key("deepseek-v4-flash");
        let mut store = QualificationStore::default();
        store.put(readiness_report(
            chat_key.clone(),
            "chat",
            &[
                (CapabilityKind::BasicGeneration, CapabilityStatus::Pass),
                (CapabilityKind::NativeToolCall, CapabilityStatus::Pass),
                (
                    CapabilityKind::ToolResultContinuation,
                    CapabilityStatus::Pass,
                ),
                (CapabilityKind::StructuredOutput, CapabilityStatus::Pass),
                (CapabilityKind::Streaming, CapabilityStatus::Pass),
                (CapabilityKind::Cancellation, CapabilityStatus::Pass),
            ],
        ));
        let readiness = model_readiness_for_selection(&mut store, &chat_key);
        assert_eq!(readiness.role, ModelReadinessRole::Chat);
        assert_eq!(readiness.state, ModelReadinessState::Verified);
        assert_eq!(readiness.basis, ModelReadinessBasis::Measured);
    }

    #[test]
    fn basic_chat_pass_with_failed_tools_is_limited_not_verified() {
        let chat_key = key("chat-only");
        let mut store = QualificationStore::default();
        store.put(readiness_report(
            chat_key.clone(),
            "chat",
            &[
                (CapabilityKind::BasicGeneration, CapabilityStatus::Pass),
                (CapabilityKind::NativeToolCall, CapabilityStatus::Fail),
                (
                    CapabilityKind::ToolResultContinuation,
                    CapabilityStatus::Fail,
                ),
                (CapabilityKind::StructuredOutput, CapabilityStatus::Pass),
            ],
        ));
        let readiness = model_readiness_for_selection(&mut store, &chat_key);
        assert_eq!(readiness.state, ModelReadinessState::Limited);
        assert!(readiness.detail.contains("Basic generation works"));
    }

    #[test]
    fn persisted_store_round_trips_without_raw_endpoint_or_secret() {
        let dir = tempfile::tempdir().unwrap();
        let path = qualification_store_path(dir.path());
        let exact = QualificationKey::new(
            "employer-gateway",
            "https://private-gateway.example/v1",
            "deepseek-v4-flash",
        );
        let mut store = QualificationStore::default();
        store.put(readiness_report(
            exact.clone(),
            "chat",
            &[(CapabilityKind::BasicGeneration, CapabilityStatus::Pass)],
        ));

        save_qualification_store(&path, &store).unwrap();
        let bytes = std::fs::read_to_string(&path).unwrap();
        assert!(!bytes.contains("private-gateway.example"));
        assert!(!bytes.contains("Bearer "));
        assert_eq!(load_qualification_store(&path).unwrap(), store);
        assert_eq!(
            model_readiness_for_selection(&mut load_qualification_store(&path).unwrap(), &exact)
                .state,
            ModelReadinessState::Limited,
            "a basic-only report must not become a full chat verification"
        );
    }

    #[test]
    fn save_refuses_to_overwrite_unreadable_existing_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let path = qualification_store_path(dir.path());
        let invalid = b"{ definitely not valid qualification evidence";
        std::fs::write(&path, invalid).unwrap();

        let error = save_qualification_store(&path, &QualificationStore::default()).unwrap_err();

        assert!(error
            .to_string()
            .contains("refusing to overwrite unreadable"));
        assert_eq!(std::fs::read(&path).unwrap(), invalid);
    }

    #[test]
    fn stale_evidence_is_never_preferred_as_current_verification() {
        let old = QualificationKey::new("p", "https://old.example/v1", "model-a");
        let current = QualificationKey::new("p", "https://new.example/v1", "model-a");
        let mut store = QualificationStore::default();
        store.put(readiness_report(
            old,
            "chat",
            &[
                (CapabilityKind::BasicGeneration, CapabilityStatus::Pass),
                (CapabilityKind::NativeToolCall, CapabilityStatus::Pass),
                (
                    CapabilityKind::ToolResultContinuation,
                    CapabilityStatus::Pass,
                ),
                (CapabilityKind::StructuredOutput, CapabilityStatus::Pass),
            ],
        ));
        let readiness = model_readiness_for_selection(&mut store, &current);
        assert_eq!(readiness.state, ModelReadinessState::Stale);
        assert!(
            readiness.chat_preference_rank()
                > ModelReadiness::unverified("gpt-5").chat_preference_rank()
        );
    }

    #[test]
    fn unknown_private_alias_ranks_before_a_measured_failed_chat_model() {
        let unknown = ModelReadiness::unverified("private-alias");
        let failed = ModelReadiness {
            role: ModelReadinessRole::Chat,
            state: ModelReadinessState::Failed,
            basis: ModelReadinessBasis::Measured,
            tested_at: Some(100),
            detail: "Basic generation failed.".into(),
        };

        assert!(unknown.chat_preference_rank() < failed.chat_preference_rank());
    }

    #[test]
    fn configured_inventory_keeps_explicit_default_ahead_of_verified_recommendation() {
        use crate::providers::{
            ProviderCapabilities, ProviderConfig, ProviderDeadlinePreference, ProviderKind,
            ProviderProfile,
        };

        let profile = ProviderProfile {
            id: "gateway".into(),
            kind: ProviderKind::OpenAiCompatible,
            label: "Employer Gateway".into(),
            base_url: "https://gateway.example/v1".into(),
            chat_model: "chosen-model".into(),
            api_key_ref: Some("contextdesk.provider.gateway.api_key".into()),
            embedding_model: None,
            embedding_base_url: None,
            local_only: false,
            capabilities: ProviderCapabilities {
                tools: true,
                stream: true,
                embeddings: true,
            },
            deadline_preference: ProviderDeadlinePreference::Auto,
        };
        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some(profile.id.clone()),
                profiles: vec![profile.clone()],
            },
            default_chat_model: Some("chosen-model".into()),
            ..AppConfig::default()
        };
        let verified_key =
            QualificationKey::new(&profile.id, &profile.base_url, "deepseek-v4-flash");
        let mut store = QualificationStore::default();
        store.put(readiness_report(
            verified_key,
            "chat",
            &[
                (CapabilityKind::BasicGeneration, CapabilityStatus::Pass),
                (CapabilityKind::NativeToolCall, CapabilityStatus::Pass),
                (
                    CapabilityKind::ToolResultContinuation,
                    CapabilityStatus::Pass,
                ),
                (CapabilityKind::StructuredOutput, CapabilityStatus::Pass),
            ],
        ));

        let rows = configured_model_readiness(&cfg, &mut store, None, None);
        assert_eq!(rows[0].model_id, "chosen-model");
        assert!(rows[0].is_default);
        assert_eq!(rows[1].model_id, "deepseek-v4-flash");
        assert_eq!(rows[1].readiness.state, ModelReadinessState::Verified);
    }

    #[test]
    fn name_hint_cannot_produce_measured_pass() {
        // Even with a strong investigator name, empty scripted responses fail.
        let mut t = ScriptedQualificationTransport::default();
        // Exhaust queues → fails, not pass from name.
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert!(
            report
                .checks
                .iter()
                .all(|c| c.status != CapabilityStatus::Pass),
            "name alone must not pass: {:?}",
            report.checks
        );
        assert_eq!(report.role_hint, "chat");
    }

    #[test]
    fn success_path_basic_generation_and_tools() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            ..Default::default()
        };
        // probes order for investigator: gen, tool, continuation, structured, stream, cancel
        // cancel probe sets cancel=true first; honor_cancel returns cancelled → pass for cancel
        // Queue is LIFO via insert(0) — push in reverse run order.
        // Run order: gen, tool, cont, struct, stream, cancel
        // pop order: last pushed first. Push cancel first ... then gen last with insert(0) means
        // insert(0) puts at front; pop takes from end. Use push to end:
        t.chat_queue.clear();
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: SYNTH_GENERATION_MARKER.into(),
            ..Default::default()
        })); // gen
        t.chat_queue.push(Ok(SyntheticChatResponse {
            tool_calls: vec![SyntheticToolCall {
                id: "c1".into(),
                name: INERT_PROBE_TOOL_NAME.into(),
                arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
            }],
            ..Default::default()
        })); // tool
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: "continued".into(),
            ..Default::default()
        })); // cont
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: r#"{"qualify":"ok","v":1}"#.into(),
            ..Default::default()
        })); // struct
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: SYNTH_GENERATION_MARKER.into(),
            streamed: true,
            ..Default::default()
        })); // stream
             // cancel uses honor_cancel after cancel flag set
        t.chat_queue.push(Ok(SyntheticChatResponse {
            cancelled: true,
            ..Default::default()
        }));

        // pop takes from end — so reverse the queue
        t.chat_queue.reverse();

        let report = run_qualification(
            key("gpt-4o-mini"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::NativeToolCall),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::ToolResultContinuation),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::StructuredOutput),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::Streaming),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::Cancellation),
            CapabilityStatus::Pass
        );
        // Cancellation *probe* must not set report.cancelled (user-cancel only).
        assert!(
            !report.cancelled,
            "cancellation probe must not mark the run as user-cancelled"
        );
    }

    #[test]
    fn fabricated_tool_prose_fails_native_tool_call() {
        let mut t = ScriptedQualificationTransport::default();
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: format!("I would call {INERT_PROBE_TOOL_NAME} now"),
            tool_calls: vec![],
            ..Default::default()
        }));
        // Only run tool probe: use embedding model role to limit? Better call probe directly
        // via run with role that only has tools — use investigator and only check tool after gen fails
        t.chat_queue.push(Ok(SyntheticChatResponse {
            content: SYNTH_GENERATION_MARKER.into(),
            ..Default::default()
        }));
        t.chat_queue.reverse();
        // Actually fill enough stubs
        for _ in 0..6 {
            if t.chat_queue.len() < 6 {
                t.chat_queue.insert(
                    0,
                    Ok(SyntheticChatResponse {
                        content: "x".into(),
                        ..Default::default()
                    }),
                );
            }
        }
        let mut t = ScriptedQualificationTransport::default();
        // reverse-pop: push gen first then tool
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: format!("please use {INERT_PROBE_TOOL_NAME}"),
                tool_calls: vec![],
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "c".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "{}".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "s".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        t.honor_cancel = true;
        let report = run_qualification(
            key("claude-sonnet"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::NativeToolCall),
            CapabilityStatus::Fail
        );
        assert!(report
            .checks
            .iter()
            .find(|c| c.kind == CapabilityKind::NativeToolCall)
            .unwrap()
            .reason
            .contains("prose"));
    }

    #[test]
    fn profile_tools_disabled_is_authoritative() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            ..Default::default()
        };
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            // tools probes should not even need responses
            Ok(SyntheticChatResponse {
                content: "s".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: r#"{"qualify":"ok","v":1}"#.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        // Need enough for gen, stream, structured, cancel — tools short-circuit
        // order: gen, tool(fail gate), cont(fail gate), struct, stream, cancel
        responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: r#"{"qualify":"ok","v":1}"#.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "stream".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        let gate = ProfileCapabilityGate {
            tools_enabled: false,
            stream_enabled: true,
            embeddings_enabled: true,
        };
        let report = run_qualification(
            key("mistral"),
            gate,
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::NativeToolCall),
            CapabilityStatus::Fail
        );
        assert!(report
            .checks
            .iter()
            .find(|c| c.kind == CapabilityKind::NativeToolCall)
            .unwrap()
            .reason
            .contains("profile tools disabled"));
    }

    #[test]
    fn sibling_model_isolation_in_store() {
        let mut store = QualificationStore::default();
        let k1 = key("model-a");
        let k2 = QualificationKey::new("profile-a", "https://gateway.example.com/v1", "model-b");
        store.put(QualificationReport {
            key: k1.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Pass,
                std::time::Instant::now(),
                "ok",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        store.put(QualificationReport {
            key: k2.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Fail,
                std::time::Instant::now(),
                "fail",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert_eq!(
            store
                .get(&k1)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Pass
        );
        assert_eq!(
            store
                .get(&k2)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Fail
        );
        store.remove(&k1);
        assert!(store.get(&k1).is_none());
        assert!(store.get(&k2).is_some());
    }

    #[test]
    fn endpoint_or_model_change_changes_cache_key() {
        let a = QualificationKey::new("p", "https://a.example.com/v1", "m");
        let b = QualificationKey::new("p", "https://b.example.com/v1", "m");
        let c = QualificationKey::new("p", "https://a.example.com/v1", "m2");
        assert_ne!(a.storage_id(), b.storage_id());
        assert_ne!(a.storage_id(), c.storage_id());
        assert_ne!(a.endpoint_fingerprint, b.endpoint_fingerprint);
    }

    #[test]
    fn outbound_sentinels_rejected() {
        assert!(assert_outbound_clean(SYNTH_GENERATION_PROMPT).is_ok());
        assert!(assert_outbound_clean("please read company-data dump").is_err());
        assert!(assert_outbound_clean("path /Users/me/secret").is_err());
    }

    #[test]
    fn inert_tool_has_no_side_effects_and_rejects_unknown() {
        let ok = execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"ABC_1"}"#).unwrap();
        assert!(ok.contains("ABC_1"));
        assert!(execute_inert_probe_tool("write_file", r#"{}"#).is_err());
        assert!(
            execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"../etc/passwd"}"#)
                .is_err()
        );
    }

    #[test]
    fn embedding_and_reranker_roles_offer_specialty_probes_only() {
        assert_eq!(
            probes_for_role_hint(ModelRoleHint::Embedding),
            vec![CapabilityKind::EmbeddingContract]
        );
        assert_eq!(
            probes_for_role_hint(ModelRoleHint::Reranker),
            vec![CapabilityKind::RerankerContract]
        );
        let mut t = ScriptedQualificationTransport::default();
        t.embed_queue.push(Ok(SyntheticEmbeddingResponse {
            vector: vec![0.1, 0.2, 0.3],
            raw_error: None,
        }));
        let report = run_qualification(
            key("bge-m3"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(report.checks.len(), 1);
        assert_eq!(
            report.status_of(CapabilityKind::EmbeddingContract),
            CapabilityStatus::Pass
        );
        assert_eq!(
            report.status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Untested
        );
    }

    #[test]
    fn malformed_embedding_and_rerank_fail() {
        let mut t = ScriptedQualificationTransport::default();
        t.embed_queue.push(Ok(SyntheticEmbeddingResponse {
            vector: vec![f32::NAN],
            raw_error: None,
        }));
        let report = run_qualification(
            key("nomic-embed-text"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::EmbeddingContract),
            CapabilityStatus::Fail
        );

        let mut t2 = ScriptedQualificationTransport::default();
        t2.rerank_queue.push(Ok(SyntheticRerankResponse {
            ranked_ids: vec!["not_a_doc".into()],
            raw_error: None,
        }));
        let report2 = run_qualification(
            key("qwen3-reranker-0.6b"),
            gate_full(),
            &mut t2,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report2.status_of(CapabilityKind::RerankerContract),
            CapabilityStatus::Fail
        );
    }

    #[test]
    fn cancel_before_run_marks_remaining_untested() {
        let mut t = ScriptedQualificationTransport::default();
        let cancel = Arc::new(AtomicBool::new(true));
        let report = run_qualification(key("gpt-4"), gate_full(), &mut t, &cancel);
        assert!(report.cancelled);
        let offered = probes_for_role_hint(ModelRoleHint::Investigator);
        assert_eq!(report.checks.len(), offered.len());
        assert!(report
            .checks
            .iter()
            .all(|c| c.status == CapabilityStatus::Untested));
    }

    #[test]
    fn user_cancel_mid_run_fills_remaining_as_untested() {
        /// Transport that cancels the *user* flag after the first chat call.
        struct CancelAfterFirst {
            cancel: Arc<AtomicBool>,
            inner: ScriptedQualificationTransport,
            calls: usize,
        }
        impl QualificationTransport for CancelAfterFirst {
            fn chat_complete(
                &mut self,
                req: &SyntheticChatRequest,
                cancel: &AtomicBool,
            ) -> Result<SyntheticChatResponse, TransportError> {
                // Raise user-cancel only *after* the first probe has fully returned,
                // so the first measured check is not reclassified as untested.
                if self.calls >= 1 {
                    self.cancel.store(true, Ordering::SeqCst);
                }
                self.calls += 1;
                self.inner.chat_complete(req, cancel)
            }
            fn embed(
                &mut self,
                model_id: &str,
                text: &str,
                cancel: &AtomicBool,
            ) -> Result<SyntheticEmbeddingResponse, TransportError> {
                self.inner.embed(model_id, text, cancel)
            }
            fn rerank(
                &mut self,
                model_id: &str,
                query: &str,
                document_ids: &[&str],
                cancel: &AtomicBool,
            ) -> Result<SyntheticRerankResponse, TransportError> {
                self.inner.rerank(model_id, query, document_ids, cancel)
            }
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let mut t = CancelAfterFirst {
            cancel: cancel.clone(),
            inner: ScriptedQualificationTransport {
                chat_queue: vec![Ok(SyntheticChatResponse {
                    content: SYNTH_GENERATION_MARKER.into(),
                    ..Default::default()
                })],
                honor_cancel: true,
                ..Default::default()
            },
            calls: 0,
        };
        let report = run_qualification(key("gpt-4o"), gate_full(), &mut t, &cancel);
        assert!(report.cancelled);
        let offered = probes_for_role_hint(ModelRoleHint::Investigator);
        assert_eq!(report.checks.len(), offered.len());
        assert_eq!(
            report.status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Pass
        );
        // All remaining after first must be untested (not omitted).
        let untested = report
            .checks
            .iter()
            .filter(|c| c.status == CapabilityStatus::Untested)
            .count();
        assert!(
            untested >= offered.len() - 1,
            "expected remaining untested after user cancel, got {:?}",
            report.checks
        );
    }

    #[test]
    fn cancellation_probe_does_not_set_user_cancelled_flag() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            chat_queue: {
                let mut q = vec![
                    Ok(SyntheticChatResponse {
                        content: SYNTH_GENERATION_MARKER.into(),
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        tool_calls: vec![SyntheticToolCall {
                            id: "c1".into(),
                            name: INERT_PROBE_TOOL_NAME.into(),
                            arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                        }],
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        content: "continued".into(),
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        content: r#"{"qualify":"ok","v":1}"#.into(),
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        content: "s".into(),
                        streamed: true,
                        ..Default::default()
                    }),
                    Ok(SyntheticChatResponse {
                        cancelled: true,
                        ..Default::default()
                    }),
                ];
                q.reverse();
                q
            },
            ..Default::default()
        };
        let user_cancel = Arc::new(AtomicBool::new(false));
        let report = run_qualification(key("gpt-4o"), gate_full(), &mut t, &user_cancel);
        assert!(
            !user_cancel.load(Ordering::SeqCst),
            "cancellation probe must not store into the user-cancel flag"
        );
        assert!(!report.cancelled);
        assert_eq!(
            report.status_of(CapabilityKind::Cancellation),
            CapabilityStatus::Pass
        );
    }

    #[test]
    fn timeout_fails_basic_generation() {
        let mut t = ScriptedQualificationTransport::default();
        t.chat_queue.push(Err(TransportError {
            reason: "timeout after 30s".into(),
        }));
        // fill remaining with fails
        for _ in 0..5 {
            t.chat_queue.insert(
                0,
                Ok(SyntheticChatResponse {
                    content: String::new(),
                    ..Default::default()
                }),
            );
        }
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Fail
        );
        assert!(report
            .checks
            .iter()
            .find(|c| c.kind == CapabilityKind::BasicGeneration)
            .unwrap()
            .reason
            .contains("timeout"));
        assert!(!report.cancelled);
    }

    #[test]
    fn streaming_interruption_marks_stream_untested() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            ..Default::default()
        };
        // gen, tool, cont, struct, stream(cancelled), cancel-probe
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                tool_calls: vec![SyntheticToolCall {
                    id: "c1".into(),
                    name: INERT_PROBE_TOOL_NAME.into(),
                    arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                }],
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "continued".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: r#"{"qualify":"ok","v":1}"#.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "partial".into(),
                streamed: true,
                cancelled: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::Streaming),
            CapabilityStatus::Untested
        );
        assert!(!report.cancelled);
    }

    #[test]
    fn malformed_structured_output_fails() {
        let mut t = ScriptedQualificationTransport {
            honor_cancel: true,
            ..Default::default()
        };
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                tool_calls: vec![SyntheticToolCall {
                    id: "c1".into(),
                    name: INERT_PROBE_TOOL_NAME.into(),
                    arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                }],
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "continued".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "this is not json at all".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "s".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::StructuredOutput),
            CapabilityStatus::Fail
        );
        assert!(report
            .checks
            .iter()
            .find(|c| c.kind == CapabilityKind::StructuredOutput)
            .unwrap()
            .reason
            .contains("not a JSON"));
    }

    #[test]
    fn store_retry_overwrites_previous_result() {
        let mut store = QualificationStore::default();
        let k = key("model-retry");
        store.put(QualificationReport {
            key: k.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Fail,
                std::time::Instant::now(),
                "first fail",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert_eq!(
            store
                .get(&k)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Fail
        );
        // Retry: replace with pass (clear+put or put overwrite).
        store.remove(&k);
        store.put(QualificationReport {
            key: k.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Pass,
                std::time::Instant::now(),
                "retry pass",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert_eq!(
            store
                .get(&k)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Pass
        );
        assert_eq!(store.by_key.len(), 1);
    }

    #[test]
    fn endpoint_change_marks_prior_report_stale_for_selection() {
        let mut store = QualificationStore::default();
        let old = QualificationKey::new("profile-a", "https://a.example.com/v1", "model-x");
        let current = QualificationKey::new("profile-a", "https://b.example.com/v1", "model-x");
        store.put(QualificationReport {
            key: old.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Pass,
                std::time::Instant::now(),
                "old endpoint",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert!(store.get(&current).is_none());
        let n = store.mark_stale_for_selection(&current);
        assert_eq!(n, 1);
        assert!(store.get(&old).unwrap().stale);
        let near = store.get_for_selection(&current).unwrap();
        assert!(near.stale);
        assert_eq!(near.key.model_id, "model-x");
    }

    #[test]
    fn sibling_model_not_marked_stale_when_selecting_other_model() {
        // #650: selecting model-A (new endpoint) must never mutate model-B's report.
        let mut store = QualificationStore::default();
        let model_a_old = QualificationKey::new("profile-a", "https://a.example.com/v1", "model-a");
        let model_a_new = QualificationKey::new("profile-a", "https://b.example.com/v1", "model-a");
        let model_b = QualificationKey::new("profile-a", "https://a.example.com/v1", "model-b");
        store.put(QualificationReport {
            key: model_a_old.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Pass,
                std::time::Instant::now(),
                "a",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        store.put(QualificationReport {
            key: model_b.clone(),
            checks: vec![check(
                CapabilityKind::BasicGeneration,
                CapabilityStatus::Fail,
                std::time::Instant::now(),
                "b",
            )],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });

        let n = store.mark_stale_for_selection(&model_a_new);
        assert_eq!(n, 1, "only model-a's prior endpoint should go stale");
        assert!(store.get(&model_a_old).unwrap().stale);
        assert!(
            !store.get(&model_b).unwrap().stale,
            "sibling model-b must remain non-stale under #650"
        );
        assert_eq!(
            store
                .get(&model_b)
                .unwrap()
                .status_of(CapabilityKind::BasicGeneration),
            CapabilityStatus::Fail,
            "sibling measured result must be unchanged"
        );

        // get_for_selection for model-a must not return or touch model-b.
        let near = store.get_for_selection(&model_a_new).unwrap();
        assert_eq!(near.key.model_id, "model-a");
        assert!(near.stale);
        assert!(!store.get(&model_b).unwrap().stale);

        // Selecting model-b exactly still hits its non-stale report.
        let b_hit = store.get_for_selection(&model_b).unwrap();
        assert!(!b_hit.stale);
        assert_eq!(b_hit.key.model_id, "model-b");
    }

    #[test]
    fn mark_stale_if_mismatch_requires_key_lookup() {
        let mut store = QualificationStore::default();
        let old = key("m1");
        let current = QualificationKey::new("profile-a", "https://other.example.com/v1", "m1");
        store.put(QualificationReport {
            key: old.clone(),
            checks: vec![],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: now_secs(),
        });
        assert!(store.mark_stale_if_mismatch(&old, &current));
        assert!(store.get(&old).unwrap().stale);
        assert!(!store.mark_stale_if_mismatch(&current, &current)); // miss
    }

    #[test]
    fn redact_reason_strips_secret_shapes() {
        let r = redact_reason("failed with Bearer sk-abc123 from /Users/me");
        assert!(!r.contains("sk-"));
        assert!(!r.contains("/Users/"));
    }

    #[test]
    fn tools_unsupported_error_fails_tool_probe() {
        let mut t = ScriptedQualificationTransport::default();
        let mut responses = vec![
            Ok(SyntheticChatResponse {
                content: SYNTH_GENERATION_MARKER.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                raw_error: Some("tools_unsupported".into()),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "c".into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: r#"{"qualify":"ok","v":1}"#.into(),
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                content: "s".into(),
                streamed: true,
                ..Default::default()
            }),
            Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            }),
        ];
        responses.reverse();
        t.chat_queue = responses;
        t.honor_cancel = true;
        let report = run_qualification(
            key("gpt-4o"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::NativeToolCall),
            CapabilityStatus::Fail
        );
    }

    #[test]
    fn catalog_drift_preserves_unchanged_evidence_and_stales_only_removed_models() {
        let mut store = QualificationStore::default();
        let endpoint = "https://gateway.example.com/v1";
        let keep = QualificationKey::new("work", endpoint, "deepseek-v4-flash");
        let removed = QualificationKey::new("work", endpoint, "old-chat-model");
        let passing = [
            (CapabilityKind::BasicGeneration, CapabilityStatus::Pass),
            (CapabilityKind::NativeToolCall, CapabilityStatus::Pass),
            (
                CapabilityKind::ToolResultContinuation,
                CapabilityStatus::Pass,
            ),
            (CapabilityKind::StructuredOutput, CapabilityStatus::Pass),
        ];
        store.put(readiness_report(keep.clone(), "chat", &passing));
        store.put(readiness_report(removed.clone(), "chat", &passing));

        let first = store.note_catalog(
            "work",
            endpoint,
            vec![keep.model_id.clone(), removed.model_id.clone()],
        );
        assert!(first.first_observation);
        assert!(!first.changed());

        let changed = store.note_catalog(
            "work",
            endpoint,
            vec![keep.model_id.clone(), "new-embedding-model".into()],
        );
        assert!(changed.changed());
        assert_eq!(changed.added, vec!["new-embedding-model"]);
        assert_eq!(changed.removed, vec![removed.model_id.clone()]);
        assert_eq!(changed.unchanged, 1);
        assert!(!store.get(&keep).expect("unchanged report").stale);
        assert!(store.get(&removed).expect("removed report").stale);
    }

    #[test]
    fn configured_inventory_includes_last_discovered_specialty_models() {
        let mut cfg = AppConfig::default();
        let mut profile = crate::providers::ProviderProfile::ollama_local();
        profile.id = "gateway".into();
        profile.label = "Gateway".into();
        profile.base_url = "https://gateway.example.com/v1".into();
        profile.chat_model = "deepseek-v4-flash".into();
        cfg.providers.active_id = Some(profile.id.clone());
        cfg.providers.profiles = vec![profile.clone()];
        let mut store = QualificationStore::default();
        store.note_catalog(
            &profile.id,
            &profile.base_url,
            vec![
                profile.chat_model.clone(),
                "bge-m3".into(),
                "qwen3-reranker-0.6b".into(),
            ],
        );

        let rows = configured_model_readiness(&cfg, &mut store, None, None);
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().any(|row| {
            row.model_id == "bge-m3" && row.readiness.role == ModelReadinessRole::Embedding
        }));
        assert!(rows.iter().any(|row| {
            row.model_id == "qwen3-reranker-0.6b"
                && row.readiness.role == ModelReadinessRole::Reranker
        }));
    }
}
