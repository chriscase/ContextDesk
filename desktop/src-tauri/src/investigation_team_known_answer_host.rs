//! Trusted-host execution and durable projection for Investigation Team
//! known-answer quality evidence.

use crate::investigation_team_qualification_host::LiveQualificationTarget;
use cd_core::capability_qualification::{
    QualificationTransport, SyntheticChatRequest, SyntheticChatResponse, SyntheticMessage,
};
use cd_core::error::{CoreError, CoreResult};
use cd_core::investigation_team_qualification::{InvestigationTeamRole, MemberBinding};
use cd_core::openai_chat_contract::OpenAiChatRequestMode;
use cd_core::quality_eval::{
    build_live_known_answer_run, live_known_answer_prompt_set_hash, live_known_answer_quality_unit,
    load_embedded_open_v1_suite, parse_live_known_answer_json, parse_live_known_answer_response,
    prepare_live_known_answer_suite, render_live_known_answer_json,
    render_live_known_answer_markdown, score_live_known_answer_response,
    serialize_live_known_answer_prompt, LaneStatus, LiveKnownAnswerRunMetrics,
    LiveKnownAnswerRunReport, LiveKnownAnswerRunStatus, LiveKnownAnswerScenarioObservation,
    ModelSubject,
};
use cd_workflow::capability_qualification::LiveQualificationTransport;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

pub const INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V1: &str =
    "contextdesk.investigation_team_known_answer_store.v1";
pub const MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS: usize = 128;
pub const MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_BYTES: usize = 8 * 1024 * 1024;
pub const LIVE_KNOWN_ANSWER_CANCEL_KEY: &str = "investigation_team_known_answer_live";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnownAnswerDisplayStatus {
    Qualified,
    Failed,
    Partial,
    Cancelled,
    Blocked,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownAnswerScenarioDto {
    pub scenario_id: String,
    pub status: LaneStatus,
    pub passed: bool,
    pub failed_dimensions: Vec<String>,
    pub latency_ms: u64,
    pub input_bytes: u64,
    pub output_bytes: u64,
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InvestigationTeamKnownAnswerDto {
    pub status: KnownAnswerDisplayStatus,
    pub reported_status: LiveKnownAnswerRunStatus,
    pub stale: bool,
    pub stale_reasons: Vec<String>,
    pub observed_at: i64,
    pub role: InvestigationTeamRole,
    pub build_identity: String,
    pub subject_storage_id: String,
    pub profile_id: String,
    pub model_id: String,
    pub endpoint_fingerprint: String,
    pub suite_id: String,
    pub suite_digest: String,
    pub prompt_set_hash: String,
    pub orchestration_policy_fingerprint: String,
    pub metrics: LiveKnownAnswerRunMetrics,
    pub scenarios: Vec<KnownAnswerScenarioDto>,
    pub redacted_json: String,
    pub redacted_markdown: String,
}

#[derive(Debug, Clone)]
pub struct KnownAnswerProjectionContext {
    pub build_identity: String,
    pub suite_digest: String,
    pub prompt_set_hash: String,
    pub members: Vec<MemberBinding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvestigationTeamKnownAnswerStore {
    schema_id: String,
    #[serde(default)]
    records: Vec<LiveKnownAnswerRunReport>,
}

impl Default for InvestigationTeamKnownAnswerStore {
    fn default() -> Self {
        Self {
            schema_id: INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V1.into(),
            records: Vec::new(),
        }
    }
}

impl InvestigationTeamKnownAnswerStore {
    fn validate(&self) -> CoreResult<()> {
        if self.schema_id != INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V1 {
            return Err(store_error("store schema is unsupported"));
        }
        if self.records.len() > MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS {
            return Err(store_error("store has too many records"));
        }
        let mut identities = BTreeSet::new();
        for report in &self.records {
            let canonical = render_live_known_answer_json(report)?;
            if parse_live_known_answer_json(&canonical)? != *report {
                return Err(store_error("record failed canonical validation"));
            }
            let identity = (
                report.observed_at,
                report.role,
                report.quality_run.quality_unit.storage_id(),
            );
            if !identities.insert(identity) {
                return Err(store_error("store has a duplicate report"));
            }
        }
        let bytes = serde_json::to_vec(self)?;
        if bytes.len() > MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_BYTES {
            return Err(store_error("store is too large"));
        }
        Ok(())
    }

    pub fn load(path: &Path) -> CoreResult<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let metadata = std::fs::metadata(path)?;
        if !metadata.is_file()
            || metadata.len() as usize > MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_BYTES
        {
            return Err(store_error("store is not a bounded regular file"));
        }
        let store: Self = serde_json::from_slice(&std::fs::read(path)?)
            .map_err(|error| store_error(&format!("store is malformed: {error}")))?;
        store.validate()?;
        Ok(store)
    }

    pub fn save(&self, path: &Path) -> CoreResult<()> {
        self.validate()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    pub fn publish(&mut self, report: LiveKnownAnswerRunReport) -> CoreResult<()> {
        let canonical = render_live_known_answer_json(&report)?;
        let report = parse_live_known_answer_json(&canonical)?;
        let identity = (
            report.observed_at,
            report.role,
            report.quality_run.quality_unit.storage_id(),
        );
        if let Some(existing) = self.records.iter_mut().find(|existing| {
            (
                existing.observed_at,
                existing.role,
                existing.quality_run.quality_unit.storage_id(),
            ) == identity
        }) {
            *existing = report;
        } else {
            self.records.push(report);
        }
        self.records.sort_by(|left, right| {
            left.observed_at
                .cmp(&right.observed_at)
                .then(left.role.cmp(&right.role))
                .then(
                    left.quality_run
                        .quality_unit
                        .storage_id()
                        .cmp(&right.quality_run.quality_unit.storage_id()),
                )
        });
        if self.records.len() > MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS {
            let remove = self.records.len() - MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS;
            self.records.drain(0..remove);
        }
        self.validate()
    }

    pub fn history(
        &self,
        context: &KnownAnswerProjectionContext,
    ) -> CoreResult<Vec<InvestigationTeamKnownAnswerDto>> {
        self.records
            .iter()
            .rev()
            .map(|report| project(report, context))
            .collect()
    }

    pub fn clear(&mut self) -> bool {
        if self.records.is_empty() {
            false
        } else {
            self.records.clear();
            true
        }
    }
}

pub fn investigation_team_known_answer_store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("investigation-team-known-answer-qualifications.json")
}

pub fn current_projection_context(
    build_identity: String,
    members: Vec<MemberBinding>,
) -> CoreResult<KnownAnswerProjectionContext> {
    let suite = load_embedded_open_v1_suite()?;
    let prepared = prepare_live_known_answer_suite(&suite)?;
    Ok(KnownAnswerProjectionContext {
        build_identity,
        suite_digest: suite.digest,
        prompt_set_hash: live_known_answer_prompt_set_hash(&prepared)?,
        members,
    })
}

pub fn execute_live_known_answer(
    targets: Vec<LiveQualificationTarget>,
    observed_at: i64,
    build_identity: String,
    cancel: &AtomicBool,
) -> CoreResult<Vec<LiveKnownAnswerRunReport>> {
    if targets.is_empty() {
        return Err(CoreError::Config(
            "known-answer qualification requires at least one host-owned target".into(),
        ));
    }
    let suite = load_embedded_open_v1_suite()?;
    let prepared = prepare_live_known_answer_suite(&suite)?;
    let prompt_set_hash = live_known_answer_prompt_set_hash(&prepared)?;
    let mut reports = Vec::with_capacity(targets.len());

    for target in targets {
        let mut transport = LiveQualificationTransport::new(
            target.backend,
            target.base_url.clone(),
            target.api_key.clone(),
            target.local_only,
        )
        .with_extra_headers(target.extra_headers.clone());
        reports.push(execute_target(
            &target,
            &prepared,
            &suite.manifest.suite_id,
            &suite.digest,
            &prompt_set_hash,
            observed_at,
            &build_identity,
            cancel,
            &mut transport,
        )?);
    }
    Ok(reports)
}

#[allow(clippy::too_many_arguments)]
fn execute_target(
    target: &LiveQualificationTarget,
    prepared: &[cd_core::quality_eval::PreparedLiveKnownAnswerCase],
    suite_id: &str,
    suite_digest: &str,
    prompt_set_hash: &str,
    observed_at: i64,
    build_identity: &str,
    cancel: &AtomicBool,
    transport: &mut dyn QualificationTransport,
) -> CoreResult<LiveKnownAnswerRunReport> {
    let mut observations = Vec::with_capacity(prepared.len());
    for case in prepared {
        let scenario_id = case.prompt().scenario_id.clone();
        if cancel.load(Ordering::SeqCst) {
            observations.push(failed_observation(
                scenario_id,
                LaneStatus::Cancelled,
                "cancelled_before_dispatch",
                0,
                0,
                0,
            ));
            continue;
        }
        if case.requires_host_diagnostic() {
            observations.push(failed_observation(
                scenario_id,
                LaneStatus::Blocked,
                "host_diagnostic_pipeline_unavailable",
                0,
                0,
                0,
            ));
            continue;
        }
        let prompt = serialize_live_known_answer_prompt(case)?;
        let request = live_known_answer_request(&target.member.model_id, &prompt);
        let input_bytes = request
            .messages
            .iter()
            .map(|message| message.role.len() + message.content.len())
            .sum::<usize>() as u64;
        let started = Instant::now();
        let response = match transport.chat_complete(&request, cancel) {
            Ok(response) => response,
            Err(error) => SyntheticChatResponse {
                raw_error: Some(error.reason),
                ..SyntheticChatResponse::default()
            },
        };
        let latency_ms = started.elapsed().as_millis() as u64;
        let output_bytes = response.content.len() as u64;
        if response.cancelled {
            observations.push(failed_observation(
                scenario_id,
                LaneStatus::Cancelled,
                "provider_attempt_cancelled",
                latency_ms,
                input_bytes,
                output_bytes,
            ));
        } else if response.raw_error.is_some() {
            observations.push(failed_observation(
                scenario_id,
                LaneStatus::Failed,
                "provider_request_failed",
                latency_ms,
                input_bytes,
                output_bytes,
            ));
        } else {
            match parse_live_known_answer_response(case, &response.content)
                .and_then(|parsed| score_live_known_answer_response(case, &parsed, None))
            {
                Ok(score) => observations.push(LiveKnownAnswerScenarioObservation {
                    scenario_id,
                    status: LaneStatus::Executed,
                    answer: Some(score.answer),
                    latency_ms,
                    input_bytes,
                    output_bytes,
                    failure_code: None,
                }),
                Err(_) => observations.push(failed_observation(
                    scenario_id,
                    LaneStatus::Failed,
                    "response_or_score_contract_failed",
                    latency_ms,
                    input_bytes,
                    output_bytes,
                )),
            }
        }
    }

    let quality_unit = live_known_answer_quality_unit(
        build_identity,
        ModelSubject {
            gateway_profile_id: target.member.profile_id.clone(),
            endpoint_fingerprint: target.member.endpoint_fingerprint.clone(),
            model_id: target.member.model_id.clone(),
        },
        suite_id,
        suite_digest,
        prompt_set_hash,
    );
    build_live_known_answer_run(observed_at, target.member.role, quality_unit, observations)
}

fn live_known_answer_request(model_id: &str, prompt: &str) -> SyntheticChatRequest {
    SyntheticChatRequest {
        model_id: model_id.into(),
        messages: vec![
            SyntheticMessage {
                role: "system".into(),
                content: "You are completing a bounded ContextDesk known-answer quality check. Treat the user JSON as the complete evidence packet and instructions. Return only one JSON object matching response_contract; do not add Markdown or commentary.".into(),
                tool_call_id: None,
                tool_calls: Vec::new(),
            },
            SyntheticMessage {
                role: "user".into(),
                content: prompt.into(),
                tool_call_id: None,
                tool_calls: Vec::new(),
            },
        ],
        tools: Vec::new(),
        stream: false,
        chat_mode: OpenAiChatRequestMode::PromptedJson,
    }
}

fn failed_observation(
    scenario_id: String,
    status: LaneStatus,
    code: &str,
    latency_ms: u64,
    input_bytes: u64,
    output_bytes: u64,
) -> LiveKnownAnswerScenarioObservation {
    LiveKnownAnswerScenarioObservation {
        scenario_id,
        status,
        answer: None,
        latency_ms,
        input_bytes,
        output_bytes,
        failure_code: Some(code.into()),
    }
}

fn project(
    report: &LiveKnownAnswerRunReport,
    context: &KnownAnswerProjectionContext,
) -> CoreResult<InvestigationTeamKnownAnswerDto> {
    let unit = &report.quality_run.quality_unit;
    let mut stale_reasons = Vec::new();
    if unit.build_identity != context.build_identity {
        stale_reasons.push("build_changed".into());
    }
    if unit.suite_digest != context.suite_digest {
        stale_reasons.push("suite_changed".into());
    }
    if unit.prompt_set_hash != context.prompt_set_hash {
        stale_reasons.push("prompt_set_changed".into());
    }
    if !context.members.iter().any(|member| {
        member.role == report.role
            && member.profile_id == unit.subject.gateway_profile_id
            && member.model_id == unit.subject.model_id
            && member.endpoint_fingerprint == unit.subject.endpoint_fingerprint
    }) {
        stale_reasons.push("pipeline_changed".into());
    }
    let stale = !stale_reasons.is_empty();
    let status = if stale {
        KnownAnswerDisplayStatus::Stale
    } else {
        match report.status {
            LiveKnownAnswerRunStatus::Qualified => KnownAnswerDisplayStatus::Qualified,
            LiveKnownAnswerRunStatus::Failed => KnownAnswerDisplayStatus::Failed,
            LiveKnownAnswerRunStatus::Partial => KnownAnswerDisplayStatus::Partial,
            LiveKnownAnswerRunStatus::Cancelled => KnownAnswerDisplayStatus::Cancelled,
            LiveKnownAnswerRunStatus::Blocked => KnownAnswerDisplayStatus::Blocked,
        }
    };
    let scenarios = report
        .quality_run
        .cases
        .iter()
        .zip(&report.telemetry)
        .map(|(case, telemetry)| KnownAnswerScenarioDto {
            scenario_id: case.case_id.clone(),
            status: case.status,
            passed: case.answers.first().is_some_and(|answer| answer.passed),
            failed_dimensions: case
                .answers
                .first()
                .map(|answer| {
                    answer
                        .failed_ids()
                        .into_iter()
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            latency_ms: telemetry.latency_ms,
            input_bytes: telemetry.input_bytes,
            output_bytes: telemetry.output_bytes,
            failure_code: telemetry.failure_code.clone(),
        })
        .collect();
    Ok(InvestigationTeamKnownAnswerDto {
        status,
        reported_status: report.status,
        stale,
        stale_reasons,
        observed_at: report.observed_at,
        role: report.role,
        build_identity: unit.build_identity.clone(),
        subject_storage_id: unit.subject.storage_id(),
        profile_id: unit.subject.gateway_profile_id.clone(),
        model_id: unit.subject.model_id.clone(),
        endpoint_fingerprint: unit.subject.endpoint_fingerprint.clone(),
        suite_id: unit.suite_id.clone(),
        suite_digest: unit.suite_digest.clone(),
        prompt_set_hash: unit.prompt_set_hash.clone(),
        orchestration_policy_fingerprint: unit.orchestration_policy_fingerprint.clone(),
        metrics: report.metrics.clone(),
        scenarios,
        redacted_json: render_live_known_answer_json(report)?,
        redacted_markdown: render_live_known_answer_markdown(report)?,
    })
}

fn store_error(detail: &str) -> CoreError {
    CoreError::Config(format!("investigation team known-answer history: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::capability_qualification::TransportError;
    use cd_core::investigation_team_qualification::MemberBinding;
    use cd_workflow::capability_qualification::LiveBackendKind;
    use tempfile::tempdir;

    #[derive(Default)]
    struct FailedTransport {
        calls: usize,
    }

    impl QualificationTransport for FailedTransport {
        fn chat_complete(
            &mut self,
            _req: &SyntheticChatRequest,
            _cancel: &AtomicBool,
        ) -> Result<SyntheticChatResponse, TransportError> {
            self.calls += 1;
            Err(TransportError {
                reason: "secret-bearing transport detail must not persist".into(),
            })
        }

        fn embed(
            &mut self,
            _model_id: &str,
            _input: &str,
            _cancel: &AtomicBool,
        ) -> Result<cd_core::capability_qualification::SyntheticEmbeddingResponse, TransportError>
        {
            unreachable!()
        }

        fn rerank(
            &mut self,
            _model_id: &str,
            _query: &str,
            _documents: &[&str],
            _cancel: &AtomicBool,
        ) -> Result<cd_core::capability_qualification::SyntheticRerankResponse, TransportError>
        {
            unreachable!()
        }
    }

    fn target() -> LiveQualificationTarget {
        LiveQualificationTarget {
            member: MemberBinding::from_deployment(
                InvestigationTeamRole::Single,
                "profile-a",
                "model-a",
                "https://gateway.example.test/v1",
            )
            .expect("member"),
            backend: LiveBackendKind::OpenAiCompatible,
            base_url: "https://gateway.example.test/v1".into(),
            api_key: Some("secret".into()),
            extra_headers: vec![("x-secret".into(), "secret".into())],
            local_only: false,
        }
    }

    #[test]
    fn failed_transport_is_complete_redacted_evidence_not_a_pass() {
        let suite = load_embedded_open_v1_suite().expect("suite");
        let prepared = prepare_live_known_answer_suite(&suite).expect("prepared");
        let prompt_hash = live_known_answer_prompt_set_hash(&prepared).expect("hash");
        let mut transport = FailedTransport::default();
        let report = execute_target(
            &target(),
            &prepared,
            &suite.manifest.suite_id,
            &suite.digest,
            &prompt_hash,
            1_777_000_000,
            "build-a",
            &AtomicBool::new(false),
            &mut transport,
        )
        .expect("report");
        assert_eq!(transport.calls, 10);
        assert_eq!(report.status, LiveKnownAnswerRunStatus::Partial);
        assert_eq!(report.metrics.failed_scenarios, 10);
        assert_eq!(report.metrics.blocked_scenarios, 4);
        assert!(report.telemetry[8..12].iter().all(|row| {
            row.status == LaneStatus::Blocked
                && row.failure_code.as_deref() == Some("host_diagnostic_pipeline_unavailable")
                && row.latency_ms == 0
                && row.input_bytes == 0
                && row.output_bytes == 0
        }));
        let json = render_live_known_answer_json(&report).expect("json");
        assert!(!json.contains("secret-bearing"));
        assert!(!json.contains("x-secret"));
        assert!(!json.contains("https://gateway"));
    }

    #[test]
    fn store_is_atomic_bounded_and_projects_pipeline_drift_as_stale() {
        let suite = load_embedded_open_v1_suite().expect("suite");
        let prepared = prepare_live_known_answer_suite(&suite).expect("prepared");
        let prompt_hash = live_known_answer_prompt_set_hash(&prepared).expect("hash");
        let mut transport = FailedTransport::default();
        let report = execute_target(
            &target(),
            &prepared,
            &suite.manifest.suite_id,
            &suite.digest,
            &prompt_hash,
            1_777_000_000,
            "build-a",
            &AtomicBool::new(false),
            &mut transport,
        )
        .expect("report");
        let mut store = InvestigationTeamKnownAnswerStore::default();
        store.publish(report).expect("publish");
        let dir = tempdir().expect("tempdir");
        let path = dir.path().join("known.json");
        store.save(&path).expect("save");
        let loaded = InvestigationTeamKnownAnswerStore::load(&path).expect("load");
        let matching = current_projection_context("build-a".into(), vec![target().member])
            .expect("matching context");
        let current_dto = loaded
            .history(&matching)
            .expect("current history")
            .remove(0);
        assert!(!current_dto.stale);
        assert_eq!(current_dto.status, KnownAnswerDisplayStatus::Partial);
        assert!(current_dto.stale_reasons.is_empty());

        let current =
            current_projection_context("build-b".into(), vec![target().member]).expect("context");
        let dto = loaded.history(&current).expect("history").remove(0);
        assert!(dto.stale);
        assert_eq!(dto.status, KnownAnswerDisplayStatus::Stale);
        assert!(dto.stale_reasons.contains(&"build_changed".into()));
    }
}
