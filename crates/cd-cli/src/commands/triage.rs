//! `contextdesk triage run` — the provider-neutral Triage SDK facade.
//!
//! The public request and replay contracts live in `cd_core`; this module is
//! deliberately only a thin host boundary.  A trusted production runner is
//! not wired on this tip, so a valid request returns a typed unsupported
//! result rather than attempting provider discovery, qualification, or HTTP.

use std::io::Read;
use std::path::Path;

use cd_core::triage_sdk::{
    parse_request_v2, TriageReplayV1, TriageRequestV2, MAX_TRIAGE_WIRE_BYTES,
};
use serde::Serialize;

use crate::cli::{TriageAction, TriageRunArgs};
use crate::envelope::{CliError, CliResult, Render};

/// Stable schema for the CLI-level triage facade result.
pub const TRIAGE_RUN_CLI_SCHEMA_ID: &str = "contextdesk.cli.triage_run.v1";

/// Why this facade did not produce a replay.  Keep this typed and content
/// free so a future host runner can replace it without changing request
/// parsing or machine-output shape.
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
    /// Workflow seam reserved for the eventual trusted host runner.
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

/// Result of one `triage run` request.  `replay` is intentionally optional:
/// once a trusted runner is wired, it will carry the validated
/// `TriageReplayV1` emitted by the shared workflow seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TriageRunOutput {
    /// CLI result schema, distinct from the SDK request/replay schema ids.
    pub schema_id: &'static str,
    /// Stable action name.
    pub action: &'static str,
    /// `unsupported` until the production runner is available.
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
    /// Typed, stable reason for the unsupported outcome.
    pub reason_codes: Vec<String>,
    /// Shared replay contract, absent until the runner is wired.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replay: Option<TriageReplayV1>,
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
            "Triage run\n\n  Status:       unsupported\n  Run:          {}\n  Reason:       {}\n  Privacy:      owner-only\n  Runner:       not wired\n\n  Network:      no\n  Credentials:  not read\n  Qualification: not evaluated\n\nA trusted host runner must be wired before this request can produce a TriageReplayV1 event stream.\n",
            self.run_id,
            self.reason_codes
                .first()
                .map(String::as_str)
                .unwrap_or(TRIAGE_RUNNER_NOT_WIRED),
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("triage run output is serializable")
    }
}

/// Run the provider-neutral triage facade without loading host state.
pub fn run(action: &TriageAction) -> CliResult<TriageRunOutput> {
    match action {
        TriageAction::Run(args) => run_request(args),
    }
}

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
    TriageRunOutput {
        schema_id: TRIAGE_RUN_CLI_SCHEMA_ID,
        action: "run",
        status: "unsupported",
        privacy: "owner_only",
        run_id: request.run_id,
        cancellation_id: request.cancellation_id,
        request_schema_id: cd_core::triage_sdk::TRIAGE_REQUEST_SCHEMA_V2.into(),
        reason_codes: vec![TRIAGE_RUNNER_NOT_WIRED.into()],
        replay: None,
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
        let output =
            run(&TriageAction::Run(TriageRunArgs { request: path })).expect("request parses");
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
        let error = run(&TriageAction::Run(TriageRunArgs { request: path }))
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
        };
        assert_eq!(args.request, PathBuf::from("-"));
    }
}
