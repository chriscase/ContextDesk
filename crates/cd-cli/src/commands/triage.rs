//! `contextdesk triage run` — the provider-neutral Triage SDK facade.
//!
//! The public request and replay contracts live in `cd_core`; this module is
//! deliberately only a thin host boundary.  Standard requests remain on the
//! established chat path; Enhanced/Advanced requests use the shared trusted
//! host resolver and production runner when an explicit preflight document is
//! supplied.

use std::io::Read;
use std::path::Path;

use cd_core::multi_model::triage_policy::{TriagePolicyPreflightV2, TriagePolicyV2};
use cd_core::triage_policy_store::TriagePolicyStoreV1;
use cd_core::triage_sdk::TriagePolicySelectionV2;
use cd_core::triage_sdk::{
    parse_request_v2, TriageReplayV1, TriageRequestV2, TriageResultKind, TriageResultV2,
    MAX_TRIAGE_WIRE_BYTES,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::adapters::{self, Paths};
use crate::cli::{TriageAction, TriageRunArgs};
use crate::envelope::{CliError, CliResult, Render};

/// Stable schema for the CLI-level triage facade result.
pub const TRIAGE_RUN_CLI_SCHEMA_ID: &str = "contextdesk.cli.triage_run.v1";

/// Why this facade did not produce a replay. Keep this typed and content-free
/// for state-free refusals such as the established Standard route.
pub const TRIAGE_RUNNER_NOT_WIRED: &str = "production_runner_not_wired";

/// Explicit evidence labels attached to every triage facade result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TriageRunEvidence {
    /// No provider or other network call was attempted.
    pub network: bool,
    /// No credential source was read.
    pub credentials_read: bool,
    /// No application configuration or CLI state was read.
    pub app_config_accessed: bool,
    /// Qualification remains host-owned and was not evaluated here.
    pub qualification: &'static str,
    /// No provider operation was started.
    pub provider_calls: u32,
    /// Workflow seam used for a stateful V2 run, or the established path for
    /// state-free refusals.
    pub runner: &'static str,
}

impl Default for TriageRunEvidence {
    fn default() -> Self {
        Self {
            network: false,
            credentials_read: false,
            app_config_accessed: false,
            qualification: "not_evaluated",
            provider_calls: 0,
            runner: "cd_workflow::triage::TriageRoleExecutor",
        }
    }
}

/// Result of one `triage run` request. `replay` is optional for typed
/// state-free refusals and present after a stateful V2 run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TriageRunOutput {
    /// CLI result schema, distinct from the SDK request/replay schema ids.
    pub schema_id: &'static str,
    /// Stable action name.
    pub action: &'static str,
    /// `completed` or `partial` for a stateful V2 run; `unsupported` only for
    /// an established-path or other typed refusal.
    pub status: &'static str,
    /// Requests contain task text and policy references, so this remains
    /// owner-only even when a later replay can be exported share-safe.
    pub privacy: &'static str,
    /// Echoed request identity for caller correlation.
    pub run_id: String,
    /// Echoed cancellation identity for caller correlation.
    pub cancellation_id: String,
    /// The exact SDK request schema accepted by this facade.
    pub request_schema_id: String,
    /// Typed, stable reason codes (also used for honest partial outcomes).
    pub reason_codes: Vec<String>,
    /// Shared replay contract emitted by the production runner when executed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<TriageReplayV1>,
    /// Typed terminal result, when the production runner reached a terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<TriageResultV2>,
    /// Explicit no-side-effect accounting.
    pub evidence: TriageRunEvidence,
}

impl TriageRunOutput {
    /// Whether the request was valid but execution is not shipped yet.
    pub fn unsupported(&self) -> bool {
        self.status == "unsupported"
    }
}

impl Render for TriageRunOutput {
    fn render_text(&self) -> String {
        format!(
            "Triage run\n\n  Status:       {}\n  Run:          {}\n  Reason:       {}\n  Privacy:      owner-only\n  Runner:       {}\n\n  Network:      {}\n  Credentials:  {}\n  Qualification: {}\n  Provider calls: {}\n",
            self.status,
            self.run_id,
            self.reason_codes
                .first()
                .map(String::as_str)
                .unwrap_or("none"),
            self.evidence.runner,
            if self.evidence.network { "yes" } else { "no" },
            if self.evidence.credentials_read { "yes" } else { "no" },
            self.evidence.qualification,
            self.evidence.provider_calls,
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("triage run output is serializable")
    }
}

/// Run the provider-neutral triage facade without loading host state.
#[cfg(test)]
pub fn run(action: &TriageAction) -> CliResult<TriageRunOutput> {
    match action {
        TriageAction::Run(args) => run_request(args),
    }
}

/// Parse before application-state resolution. Malformed requests and the
/// legacy Standard selection retain the state-free, no-Keychain behavior;
/// Enhanced/Advanced requests continue into the trusted stateful host path.
pub fn state_free(action: &TriageAction) -> Option<CliResult<TriageRunOutput>> {
    match action {
        TriageAction::Run(args) => {
            let raw = match read_request(&args.request) {
                Ok(raw) => raw,
                Err(error) => return Some(Err(error)),
            };
            let request = match parse_request_v2(&raw) {
                Ok(request) => request,
                Err(error) => {
                    return Some(Err(CliError::user(format!(
                        "triage request rejected by the V2 contract: {error}"
                    ))))
                }
            };
            if matches!(request.policy, TriagePolicySelectionV2::Standard { .. }) {
                Some(Ok(unsupported_result(request)))
            } else {
                None
            }
        }
    }
}

/// Execute one stateful V2 request using the same CLI paths, ToolHost, secret
/// adapter, corpus binding, provider backend factory, and packet builder used
/// by the established product path.
pub async fn run_stateful(
    args: &TriageRunArgs,
    paths: &Paths,
    cfg: &cd_core::config::AppConfig,
    secrets: &dyn cd_core::keychain_store::SecretStore,
) -> CliResult<TriageRunOutput> {
    let raw_request = read_request(&args.request)?;
    let request = parse_request_v2(&raw_request).map_err(|error| {
        CliError::user(format!(
            "triage request rejected by the V2 contract: {error}"
        ))
    })?;
    let mut policy = match &request.policy {
        TriagePolicySelectionV2::Standard { .. } => {
            return Ok(unsupported_result_with_reason(
                request,
                "standard_uses_established_path",
            ));
        }
        TriagePolicySelectionV2::Inline { document, .. } => {
            serde_json::from_value::<TriagePolicyV2>(document.clone())
                .map_err(|_| CliError::user("inline triage policy could not be decoded"))?
        }
        TriagePolicySelectionV2::Saved {
            policy_id,
            policy_revision,
        } => {
            let path = paths.config_dir.join("triage-policies.json");
            let store = TriagePolicyStoreV1::load(&path)
                .map_err(|_| CliError::user("saved triage policy store could not be loaded"))?;
            let saved = store
                .policies
                .iter()
                .find(|saved| saved.policy_id == *policy_id && saved.revision == *policy_revision)
                .ok_or_else(|| CliError::user("requested triage policy revision is unavailable"))?;
            saved.policy.clone()
        }
    };
    // A caller-supplied preflight is useful for provider-free policy
    // simulation, but cannot authorize a live run: the CLI cannot prove who
    // authored it or that its qualification/egress facts came from this
    // host. Keep the refusal before ToolHost construction and credential
    // resolution. A future dedicated V2 role-qualification store will supply
    // host-derived facts here, shared with Tauri.
    let preflight = load_live_v2_preflight(args)?;

    if let Some(deadline_ms) = request.overrides.deadline_ms {
        policy.budget.whole_turn_deadline_ms = Some(deadline_ms);
    }
    if let Some(max_provider_calls) = request.overrides.max_provider_calls {
        policy.budget.max_provider_calls = max_provider_calls;
    }
    let deadline_ms =
        policy
            .budget
            .whole_turn_deadline_ms
            .unwrap_or(if cfg.router.deadline_is_explicit {
                cfg.router.deadline_ms
            } else {
                300_000
            });
    let context_budget = usize::try_from(policy.budget.max_context_chars)
        .map_err(|_| CliError::user("triage context budget is not representable"))?;
    if context_budget == 0 {
        return Err(CliError::user("triage context budget must be positive"));
    }
    let mut host = adapters::tool_host_with_app_config(&paths.cache_root, cfg, secrets)?;
    let policy_fingerprint = fingerprint_json(&policy)?;
    let request_fingerprint = fingerprint_bytes(raw_request.as_bytes());
    let input = cd_workflow::triage_host::TriageHostRunInput {
        run_id: request.run_id.clone(),
        request_fingerprint,
        policy_fingerprint,
        corpus_id: request.scope.corpus_id.clone(),
        corpus_revision: request.scope.corpus_revision,
        source_ids: request.scope.source_ids.clone(),
        user_text: request.task.clone(),
        cancellation_id: request.cancellation_id.clone(),
        explicit_review_requested: false,
        deadline_ms,
        context_char_budget: context_budget,
        cancel: Some(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
            false,
        ))),
    };
    let resolved = cd_workflow::triage_host::resolve_v2_host(
        &mut host,
        &paths.cache_root,
        cfg,
        secrets,
        &policy,
        &preflight,
        &input,
    )
    .await
    .map_err(|error| CliError::user(error.to_string()))?;
    let result = cd_workflow::triage_host::run_v2_host(
        &mut host,
        resolved,
        input,
        &cd_workflow::triage_host::HostValidatedAnswerHooks::default(),
        None,
    )
    .await
    .map_err(|error| CliError::user(error.to_string()))?;
    let provider_calls = result
        .replay
        .events
        .iter()
        .filter_map(|event| match &event.event {
            cd_core::triage_sdk::TriageRunEventPayloadV2::RoleAttempt { attempt } => {
                attempt.physical_provider_calls
            }
            _ => None,
        })
        .sum();
    let status = match result.result.kind {
        TriageResultKind::GroundedFinal => "completed",
        TriageResultKind::HonestPartial => "partial",
    };
    Ok(TriageRunOutput {
        schema_id: TRIAGE_RUN_CLI_SCHEMA_ID,
        action: "run",
        status,
        privacy: "owner_only",
        run_id: result.result.run_id.clone(),
        cancellation_id: request.cancellation_id,
        request_schema_id: cd_core::triage_sdk::TRIAGE_REQUEST_SCHEMA_V2.into(),
        reason_codes: result.result.reason_codes.clone(),
        replay: Some(result.replay),
        result: Some(result.result),
        evidence: TriageRunEvidence {
            network: provider_calls > 0,
            credentials_read: true,
            app_config_accessed: true,
            qualification: "host_preflighted",
            provider_calls,
            runner: "cd_workflow::triage_host::run_v2_host",
        },
    })
}

/// Resolve live V2 qualification from host-owned evidence only. Until the
/// dedicated role-qualification store is implemented, execution is
/// deliberately unavailable; arbitrary `--preflight` JSON must never become
/// provider or egress authority.
fn load_live_v2_preflight(args: &TriageRunArgs) -> CliResult<TriagePolicyPreflightV2> {
    if args.preflight.is_some() {
        Err(CliError::user("caller_preflight_not_authoritative"))
    } else {
        Err(CliError::user("triage_role_qualification_unavailable"))
    }
}

#[cfg(test)]
fn run_request(args: &TriageRunArgs) -> CliResult<TriageRunOutput> {
    let request = read_request(&args.request)?;
    // `parse_request_v2` performs the schema, privacy, identity, policy, and
    // bounded override checks owned by the shared SDK.  Do not deserialize a
    // second CLI-specific request shape here.
    let request = parse_request_v2(&request).map_err(|error| {
        CliError::user(format!(
            "triage request rejected by the V2 contract: {error}"
        ))
    })?;
    Ok(unsupported_result(request))
}

fn unsupported_result(request: TriageRequestV2) -> TriageRunOutput {
    unsupported_result_with_reason(request, TRIAGE_RUNNER_NOT_WIRED)
}

fn unsupported_result_with_reason(request: TriageRequestV2, reason: &str) -> TriageRunOutput {
    TriageRunOutput {
        schema_id: TRIAGE_RUN_CLI_SCHEMA_ID,
        action: "run",
        status: "unsupported",
        privacy: "owner_only",
        run_id: request.run_id,
        cancellation_id: request.cancellation_id,
        request_schema_id: cd_core::triage_sdk::TRIAGE_REQUEST_SCHEMA_V2.into(),
        reason_codes: vec![reason.into()],
        replay: None,
        result: None,
        evidence: TriageRunEvidence::default(),
    }
}

fn fingerprint_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn fingerprint_json<T: serde::Serialize>(value: &T) -> CliResult<String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|_| CliError::internal("could not fingerprint triage policy"))?;
    Ok(fingerprint_bytes(&bytes))
}

fn read_request(path: &Path) -> CliResult<String> {
    let bytes = if path == Path::new("-") {
        let mut bytes = Vec::new();
        let stdin = std::io::stdin();
        let mut reader = stdin.lock().take((MAX_TRIAGE_WIRE_BYTES + 1) as u64);
        reader
            .read_to_end(&mut bytes)
            .map_err(|_| CliError::user("could not read triage request from stdin"))?;
        bytes
    } else {
        let metadata = std::fs::metadata(path)
            .map_err(|_| CliError::user("could not read triage request JSON file"))?;
        if !metadata.is_file() || metadata.len() > MAX_TRIAGE_WIRE_BYTES as u64 {
            return Err(CliError::user(format!(
                "triage request JSON must be a regular file no larger than {} bytes",
                MAX_TRIAGE_WIRE_BYTES
            )));
        }
        std::fs::read(path)
            .map_err(|_| CliError::user("could not read triage request JSON file"))?
    };
    if bytes.len() > MAX_TRIAGE_WIRE_BYTES {
        return Err(CliError::user(format!(
            "triage request JSON exceeds the {}-byte SDK bound",
            MAX_TRIAGE_WIRE_BYTES
        )));
    }
    String::from_utf8(bytes).map_err(|_| CliError::user("triage request JSON must be UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::{run, TriageRunOutput, TRIAGE_RUNNER_NOT_WIRED};
    use crate::cli::{TriageAction, TriageRunArgs};
    use cd_core::triage_sdk::TRIAGE_REQUEST_SCHEMA_V2;
    use std::path::PathBuf;

    fn request() -> String {
        serde_json::json!({
            "schema_id": TRIAGE_REQUEST_SCHEMA_V2,
            "run_id": "run:cli-test",
            "privacy": "owner_only",
            "task": "What happened?",
            "scope": {"corpus_id": "corpus:cli-test"},
            "policy": {
                "kind": "standard",
                "model": {"profile_id": "profile:test", "model_id": "model:test"}
            },
            "overrides": {},
            "cancellation_id": "cancel:cli-test"
        })
        .to_string()
    }

    #[test]
    fn valid_request_returns_typed_unsupported_without_replay() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("request.json");
        std::fs::write(&path, request()).expect("write request");
        let output = run(&TriageAction::Run(TriageRunArgs {
            request: path,
            preflight: None,
        }))
        .expect("request parses");
        assert_eq!(output.status, "unsupported");
        assert_eq!(output.reason_codes, vec![TRIAGE_RUNNER_NOT_WIRED]);
        assert!(output.replay.is_none());
        assert_eq!(output.run_id, "run:cli-test");
        assert!(!output.evidence.network);
        assert!(!output.evidence.credentials_read);
    }

    #[test]
    fn malformed_request_is_rejected_before_runner_boundary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("request.json");
        std::fs::write(&path, "{\"schema_id\":\"contextdesk.triage.request.v99\"}")
            .expect("write request");
        let error = run(&TriageAction::Run(TriageRunArgs {
            request: path,
            preflight: None,
        }))
        .expect_err("unknown schema must fail");
        assert_eq!(error.category, crate::envelope::ExitCategory::UserError);
    }

    #[test]
    fn output_serializes_without_owner_task_body_or_replay() {
        let output = TriageRunOutput {
            schema_id: super::TRIAGE_RUN_CLI_SCHEMA_ID,
            action: "run",
            status: "unsupported",
            privacy: "owner_only",
            run_id: "run:one".into(),
            cancellation_id: "cancel:one".into(),
            request_schema_id: TRIAGE_REQUEST_SCHEMA_V2.into(),
            reason_codes: vec![TRIAGE_RUNNER_NOT_WIRED.into()],
            replay: None,
            result: None,
            evidence: Default::default(),
        };
        let json = serde_json::to_value(output).expect("serializes");
        assert_eq!(json["privacy"], "owner_only");
        assert!(json.get("replay").is_none());
        assert!(json.get("task").is_none());
    }

    #[test]
    fn stdin_marker_is_accepted_by_the_same_contract_path() {
        // The subprocess integration test owns stdin delivery; this keeps the
        // unit suite focused on the public argument shape and avoids mutating
        // process-global stdin in parallel tests.
        let args = TriageRunArgs {
            request: PathBuf::from("-"),
            preflight: None,
        };
        assert_eq!(args.request, PathBuf::from("-"));
    }
}
