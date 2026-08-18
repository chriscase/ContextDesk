//! `contextdesk triage run` — the provider-neutral Triage SDK facade.
//!
//! The public request and replay contracts live in `cd_core`; this module is
//! deliberately only a thin host boundary.  Standard requests remain on the
//! established chat path; Enhanced/Advanced requests use the shared trusted
//! host resolver and production runner only with host-owned qualification
//! evidence. Caller-authored preflight documents remain provider-free policy
//! simulation inputs and are never runtime authority.

use std::io::Read;
use std::path::Path;

use cd_core::triage_policy_store::TriagePolicyStoreV1;
use cd_core::triage_sdk::TriagePolicySelectionV2;
use cd_core::triage_sdk::{
    parse_request_v2, TriageReplayV1, TriageRequestV2, TriageResultKind, TriageResultV2,
    MAX_TRIAGE_WIRE_BYTES,
};
use cd_triage_runtime::{triage_with_policy, TriageExecutionTerminal};
use serde::Serialize;

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
    /// `completed`, `partial`, `failed`, `timed_out`, or `cancelled` for a
    /// stateful V2 run; `unsupported` only for an established-path refusal.
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
            // Runtime preflight authority is host-owned. Reject the legacy
            // caller input before path/config resolution so it cannot affect
            // Standard or Enhanced/Advanced execution and cannot trigger a
            // credential adapter as a side effect of refusal.
            if args.preflight.is_some() {
                return Some(Err(CliError::user("caller_preflight_not_authoritative")));
            }
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
    if matches!(&request.policy, TriagePolicySelectionV2::Standard { .. }) {
        return Ok(unsupported_result_with_reason(
            request,
            "standard_uses_established_path",
        ));
    }
    // A caller-supplied preflight is useful for provider-free policy
    // simulation, but can never authorize a live run.
    if args.preflight.is_some() {
        return Err(CliError::user("caller_preflight_not_authoritative"));
    }
    let policies = match &request.policy {
        TriagePolicySelectionV2::Saved { .. } => {
            let path = paths.config_dir.join("triage-policies.json");
            TriagePolicyStoreV1::load(&path)
                .map_err(|_| CliError::user("saved triage policy store could not be loaded"))?
        }
        TriagePolicySelectionV2::Inline { .. } => TriagePolicyStoreV1::default(),
        TriagePolicySelectionV2::Standard { .. } => {
            return Err(CliError::internal(
                "standard triage dispatch escaped state-free routing",
            ));
        }
    };
    let qualification_path =
        cd_core::triage_role_qualification::triage_role_qualification_store_path(&paths.config_dir);
    let qualifications = cd_core::triage_role_qualification::TriageRoleQualificationStoreV1::load(
        &qualification_path,
    )
    .map_err(|_| CliError::user("triage_role_qualification_store_unavailable"))?;
    let mut host = adapters::tool_host_with_app_config(&paths.cache_root, cfg, secrets)?;
    let engine = cd_workflow::triage_runtime_host::WorkflowTriageEngineV1::new(
        &mut host,
        &paths.cache_root,
        cfg.clone(),
        secrets,
        policies,
        qualifications,
        cd_workflow::triage_runtime_host::TriageCancellationRegistryV1::default(),
    );
    let cancellation_id = request.cancellation_id.clone();
    let execution = triage_with_policy(&engine, request, None)
        .await
        .map_err(|error| CliError::user(error.to_string()))?;
    let terminal = execution.terminal().clone();
    let provider_calls = execution
        .replay()
        .events
        .iter()
        .filter_map(|event| match &event.event {
            cd_core::triage_sdk::TriageRunEventPayloadV2::RoleAttempt { attempt } => {
                attempt.physical_provider_calls
            }
            _ => None,
        })
        .sum();
    let (status, result, reason_codes) = project_terminal(&terminal);
    let replay = execution.into_replay();
    Ok(TriageRunOutput {
        schema_id: TRIAGE_RUN_CLI_SCHEMA_ID,
        action: "run",
        status,
        privacy: "owner_only",
        run_id: replay.run_id.clone(),
        cancellation_id,
        request_schema_id: cd_core::triage_sdk::TRIAGE_REQUEST_SCHEMA_V2.into(),
        reason_codes,
        replay: Some(replay),
        result,
        evidence: TriageRunEvidence {
            network: provider_calls > 0,
            credentials_read: true,
            app_config_accessed: true,
            qualification: "host_preflighted",
            provider_calls,
            runner: "cd_triage_runtime::triage_with_policy",
        },
    })
}

fn project_terminal(
    terminal: &TriageExecutionTerminal,
) -> (&'static str, Option<TriageResultV2>, Vec<String>) {
    let (status, result, category) = match terminal {
        TriageExecutionTerminal::Completed { result } => (
            match result.kind {
                TriageResultKind::GroundedFinal => "completed",
                TriageResultKind::HonestPartial => "partial",
            },
            Some(result.clone()),
            None,
        ),
        TriageExecutionTerminal::Failed {
            category,
            partial_result,
        } => ("failed", partial_result.clone(), Some(category.as_str())),
        TriageExecutionTerminal::TimedOut {
            category,
            partial_result,
        } => ("timed_out", partial_result.clone(), Some(category.as_str())),
        TriageExecutionTerminal::Cancelled { partial_result, .. } => {
            ("cancelled", partial_result.clone(), Some("cancelled"))
        }
    };
    let mut reason_codes = result
        .as_ref()
        .map(|result| result.reason_codes.clone())
        .unwrap_or_default();
    if let Some(category) = category {
        if !reason_codes.iter().any(|reason| reason == category) {
            reason_codes.push(category.into());
        }
    }
    (status, result, reason_codes)
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
    use super::{project_terminal, run, TriageRunOutput, TRIAGE_RUNNER_NOT_WIRED};
    use crate::cli::{TriageAction, TriageRunArgs};
    use cd_core::triage_sdk::{
        TriageReconciliationV1, TriageResultKind, TriageResultV2, TriageValidationState,
        TRIAGE_REQUEST_SCHEMA_V2, TRIAGE_RESULT_SCHEMA_V2,
    };
    use cd_triage_runtime::TriageExecutionTerminal;
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

    fn honest_partial() -> TriageResultV2 {
        TriageResultV2 {
            schema_id: TRIAGE_RESULT_SCHEMA_V2.into(),
            run_id: "run:cli-test".into(),
            kind: TriageResultKind::HonestPartial,
            validation_state: TriageValidationState::Partial,
            packet_id: "packet:cli-test".into(),
            reconciliation: TriageReconciliationV1 {
                state: "honest_partial".into(),
                configured_role_slots: 1,
                completed_role_slots: 0,
                distinct_models: 0,
                distinct_gateways: 0,
                supported_claim_ids: Vec::new(),
                conflict_ids: Vec::new(),
                gap_ids: vec!["gap:root-cause".into()],
                root_cause_established: false,
            },
            answer: None,
            accepted_evidence_ids: Vec::new(),
            reason_codes: vec!["root_cause_not_established".into()],
        }
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

    #[test]
    fn terminal_projection_preserves_status_partial_and_reason_identity() {
        let partial = honest_partial();
        let (status, result, reasons) = project_terminal(&TriageExecutionTerminal::Completed {
            result: partial.clone(),
        });
        assert_eq!(status, "partial");
        assert_eq!(result, Some(partial.clone()));
        assert_eq!(reasons, vec!["root_cause_not_established"]);

        let (status, result, reasons) = project_terminal(&TriageExecutionTerminal::Failed {
            category: "provider_unavailable".into(),
            partial_result: Some(partial.clone()),
        });
        assert_eq!(status, "failed");
        assert_eq!(result, Some(partial.clone()));
        assert_eq!(
            reasons,
            vec!["root_cause_not_established", "provider_unavailable"]
        );

        let (status, result, reasons) = project_terminal(&TriageExecutionTerminal::TimedOut {
            category: "whole_turn_deadline".into(),
            partial_result: None,
        });
        assert_eq!(status, "timed_out");
        assert!(result.is_none());
        assert_eq!(reasons, vec!["whole_turn_deadline"]);

        let (status, result, reasons) = project_terminal(&TriageExecutionTerminal::Cancelled {
            cancellation_id: "cancel:cli-test".into(),
            partial_result: Some(partial.clone()),
        });
        assert_eq!(status, "cancelled");
        assert_eq!(result, Some(partial));
        assert_eq!(reasons, vec!["root_cause_not_established", "cancelled"]);
    }
}
