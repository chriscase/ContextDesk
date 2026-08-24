//! Trusted-host execution and durable projection for Investigation Team
//! known-answer quality evidence.

use crate::investigation_team_qualification_host::LiveQualificationTarget;
use cd_core::capability_qualification::{
    QualificationTransport, SyntheticChatRequest, SyntheticChatResponse, SyntheticMessage,
};
use cd_core::error::{CoreError, CoreResult};
use cd_core::investigation_team_qualification::{InvestigationTeamRole, MemberBinding};
use cd_core::openai_chat_contract::OpenAiChatRequestMode;
use cd_core::provider_telemetry::{ModelIdentityStatus, ProviderTransportTelemetry};
use cd_core::quality_eval::live_known_answer::{
    host_attempt_from_chat, host_diagnostic_for_observed_attempts, HostAttemptObservation,
};
#[cfg(unix)]
use cd_core::quality_eval::LiveKnownAnswerOwnerDirectory;
use cd_core::quality_eval::{
    build_live_known_answer_capture_v2, build_live_known_answer_run_v2,
    live_known_answer_answer_score_sha256, live_known_answer_capture_sha256,
    live_known_answer_prompt_set_hash, live_known_answer_quality_unit, load_embedded_open_v1_suite,
    parse_live_known_answer_capture_json, parse_live_known_answer_json,
    parse_live_known_answer_response_classified, prepare_live_known_answer_suite,
    render_live_known_answer_capture_json, render_live_known_answer_json,
    render_live_known_answer_markdown, score_live_known_answer_response,
    serialize_live_known_answer_prompt, validate_live_known_answer_run, LaneStatus,
    LiveKnownAnswerCanonicalCapture, LiveKnownAnswerCanonicalScenarioInput, LiveKnownAnswerRunId,
    LiveKnownAnswerRunMetrics, LiveKnownAnswerRunReport, LiveKnownAnswerRunStatus,
    LiveKnownAnswerScenarioObservation, ModelSubject, LIVE_KNOWN_ANSWER_JS_SAFE_MAX,
};
use cd_workflow::capability_qualification::LiveQualificationTransport;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use uuid::Uuid;

pub const INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V1: &str =
    "contextdesk.investigation_team_known_answer_store.v1";
pub const INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V2: &str =
    "contextdesk.investigation_team_known_answer_store.v2";
pub const INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V3: &str =
    "contextdesk.investigation_team_known_answer_store.v3";
pub const MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS: usize = 128;
pub const MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_BYTES: usize = 8 * 1024 * 1024;
pub const LIVE_KNOWN_ANSWER_CANCEL_KEY: &str = "investigation_team_known_answer_live";
#[cfg(unix)]
const KNOWN_ANSWER_DURABILITY_WARNING: &str =
    "known-answer evidence committed, but parent-directory durability could not be confirmed";
#[cfg(not(unix))]
const KNOWN_ANSWER_PLATFORM_UNAVAILABLE: &str = "known-answer evidence persistence is unavailable on this host because stable no-follow file identity, owner-only capture retention, and atomic replacement cannot all be guaranteed";

#[derive(Debug)]
pub struct KnownAnswerSaveOutcome {
    pub revision: String,
    pub durability_warning: Option<String>,
    _lock: KnownAnswerWriteLock,
    #[cfg(unix)]
    _directory: LiveKnownAnswerOwnerDirectory,
}

#[cfg(unix)]
#[derive(Debug)]
struct KnownAnswerWriteLock {
    _file: File,
}

#[cfg(not(unix))]
#[derive(Debug)]
struct KnownAnswerWriteLock;

pub fn ensure_known_answer_persistence_supported() -> CoreResult<()> {
    #[cfg(unix)]
    {
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(store_error(KNOWN_ANSWER_PLATFORM_UNAVAILABLE))
    }
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnownAnswerRunIdProvenance {
    HostMinted,
    LegacyUnidentified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KnownAnswerScenarioDto {
    pub scenario_id: String,
    pub status: LaneStatus,
    pub passed: bool,
    pub failed_dimensions: Vec<String>,
    pub latency_ms: u64,
    pub message_content_bytes: u64,
    pub provider_content_bytes: u64,
    pub reported_model_id: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub cost_microusd: Option<u64>,
    pub failure_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InvestigationTeamKnownAnswerDto {
    pub run_id: Option<String>,
    pub run_id_provenance: KnownAnswerRunIdProvenance,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    captures: Vec<LiveKnownAnswerCanonicalCapture>,
}

impl Default for InvestigationTeamKnownAnswerStore {
    fn default() -> Self {
        Self {
            schema_id: INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V3.into(),
            records: Vec::new(),
            captures: Vec::new(),
        }
    }
}

/// Host lifecycle for durable known-answer evidence. A malformed existing
/// store is never replaced by an empty default. Each operation retries one
/// secure load under the host mutex so an operator repair or removal can
/// recover in-process without weakening fail-closed behavior.
#[derive(Debug)]
pub enum InvestigationTeamKnownAnswerStoreState {
    Available(InvestigationTeamKnownAnswerStore),
    Unavailable,
}

impl InvestigationTeamKnownAnswerStoreState {
    pub fn from_load_result(result: CoreResult<InvestigationTeamKnownAnswerStore>) -> Self {
        match result {
            Ok(store) => Self::Available(store),
            Err(_) => Self::Unavailable,
        }
    }

    pub fn store(&self) -> CoreResult<&InvestigationTeamKnownAnswerStore> {
        match self {
            Self::Available(store) => Ok(store),
            Self::Unavailable => Err(store_unavailable_error()),
        }
    }

    pub fn reload_for_operation(
        &mut self,
        path: &Path,
    ) -> CoreResult<&InvestigationTeamKnownAnswerStore> {
        match InvestigationTeamKnownAnswerStore::load(path) {
            Ok(store) => {
                *self = Self::Available(store);
                self.store()
            }
            Err(error) => {
                *self = Self::Unavailable;
                Err(error)
            }
        }
    }

    pub fn replace_with_committed(&mut self, store: InvestigationTeamKnownAnswerStore) {
        *self = Self::Available(store);
    }
}

impl InvestigationTeamKnownAnswerStore {
    fn validate(&self) -> CoreResult<()> {
        if self.schema_id != INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V3 {
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
            let identity = report_identity(report)?;
            if !identities.insert(identity) {
                return Err(store_error("store has a duplicate report"));
            }
        }
        let mut capture_identities = BTreeSet::new();
        for capture in &self.captures {
            let canonical = render_live_known_answer_capture_json(capture)?;
            if parse_live_known_answer_capture_json(&canonical)? != *capture {
                return Err(store_error("capture failed canonical validation"));
            }
            let identity = capture_identity(capture)?;
            if !capture_identities.insert(identity.clone()) {
                return Err(store_error("store has a duplicate capture"));
            }
            let mut matching_report = None;
            for report in &self.records {
                if report_identity(report)? == identity {
                    matching_report = Some(report);
                    break;
                }
            }
            let Some(report) = matching_report else {
                return Err(store_error("capture has no matching score report"));
            };
            validate_report_capture_correspondence(report, capture)?;
        }
        for report in &self.records {
            let report_identity = report_identity(report)?;
            let mut matching = Vec::new();
            for capture in &self.captures {
                if capture_identity(capture)? == report_identity {
                    matching.push(capture);
                }
            }
            match (
                report.canonical_capture_sha256.as_ref(),
                matching.as_slice(),
            ) {
                (None, []) => {}
                (Some(_), [capture]) => validate_report_capture_correspondence(report, capture)?,
                (None, _) => return Err(store_error("capture is not declared by its report")),
                (Some(_), []) => return Err(store_error("report capture is unavailable")),
                (Some(_), _) => return Err(store_error("report has multiple captures")),
            }
        }
        let bytes = serde_json::to_vec(self)?;
        if bytes.len() > MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_BYTES {
            return Err(store_error("store is too large"));
        }
        Ok(())
    }

    #[cfg(unix)]
    pub fn load(path: &Path) -> CoreResult<Self> {
        ensure_known_answer_persistence_supported()?;
        Self::load_after_open(path, |_| {})
    }

    #[cfg(not(unix))]
    pub fn load(_path: &Path) -> CoreResult<Self> {
        Err(store_error(KNOWN_ANSWER_PLATFORM_UNAVAILABLE))
    }

    #[cfg(unix)]
    fn load_after_open(path: &Path, after_open: impl FnOnce(&Path)) -> CoreResult<Self> {
        let (parent, name) = store_parent_and_name(path)?;
        let directory = LiveKnownAnswerOwnerDirectory::open(parent)?;
        let loaded = Self::load_from_directory(&directory, path, name, after_open)?;
        directory.revalidate_path(parent)?;
        Ok(loaded)
    }

    #[cfg(unix)]
    fn load_from_directory(
        directory: &LiveKnownAnswerOwnerDirectory,
        path: &Path,
        name: &str,
        after_open: impl FnOnce(&Path),
    ) -> CoreResult<Self> {
        let Some(mut opened) = directory.open_owner_regular(
            name,
            MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_BYTES as u64,
            false,
        )?
        else {
            return Ok(Self::default());
        };
        let before = opened.file.metadata()?;
        after_open(path);
        let bytes = read_exact_open_file(&mut opened.file, opened.size)?;
        let after = opened.file.metadata()?;
        validate_stable_open_metadata(&before, &after, opened.size)?;
        Self::decode(&bytes)
    }

    fn decode(bytes: &[u8]) -> CoreResult<Self> {
        let mut store: Self = serde_json::from_slice(bytes)
            .map_err(|error| store_error(&format!("store is malformed: {error}")))?;
        match store.schema_id.as_str() {
            INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V1 if store.captures.is_empty() => {
                store.schema_id = INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V3.into();
            }
            INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V2 => {
                store.schema_id = INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V3.into();
            }
            _ => {}
        }
        store.validate()?;
        Ok(store)
    }

    pub fn revision(&self) -> CoreResult<String> {
        self.validate()?;
        Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(self)?)))
    }

    #[cfg(unix)]
    pub fn save(&self, path: &Path, expected_revision: &str) -> CoreResult<KnownAnswerSaveOutcome> {
        self.save_with_seams(
            path,
            expected_revision,
            |_| Ok(()),
            sync_parent_directory_after_replace,
        )
    }

    #[cfg(not(unix))]
    pub fn save(
        &self,
        _path: &Path,
        _expected_revision: &str,
    ) -> CoreResult<KnownAnswerSaveOutcome> {
        Err(store_error(KNOWN_ANSWER_PLATFORM_UNAVAILABLE))
    }

    #[cfg(unix)]
    fn save_with_seams<BeforeCas, SyncParent>(
        &self,
        path: &Path,
        expected_revision: &str,
        before_cas: BeforeCas,
        sync_parent: SyncParent,
    ) -> CoreResult<KnownAnswerSaveOutcome>
    where
        BeforeCas: FnOnce(&Path) -> CoreResult<()>,
        SyncParent: FnOnce(&LiveKnownAnswerOwnerDirectory) -> CoreResult<()>,
    {
        self.validate()?;
        let revision = self.revision()?;
        let body = serde_json::to_vec_pretty(self)?;
        if body.len() > MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_BYTES {
            return Err(store_error("store is too large"));
        }
        let (parent, name) = store_parent_and_name(path)?;
        let directory = LiveKnownAnswerOwnerDirectory::open(parent)?;
        directory.revalidate_path(parent)?;
        let lock_name = format!(".{name}.lock");
        let lock = acquire_known_answer_write_lock(&directory, &lock_name)?;
        let tmp_name = format!(".{name}.{}.tmp", Uuid::new_v4());
        let result = (|| -> CoreResult<()> {
            let mut file = directory.create_owner_regular(&tmp_name)?;
            file.write_all(&body)?;
            file.flush()?;
            file.sync_all()?;
            file.seek(SeekFrom::Start(0))?;
            let before = file.metadata()?;
            let written = read_exact_open_file(&mut file, body.len() as u64)?;
            let after = file.metadata()?;
            validate_stable_open_metadata(&before, &after, body.len() as u64)?;
            if written != body {
                return Err(store_error("temporary store bytes changed before replace"));
            }
            let validated = Self::decode(&written)?;
            if validated != *self {
                return Err(store_error("temporary store verification failed"));
            }
            let named = directory
                .open_owner_regular(&tmp_name, body.len() as u64, false)?
                .ok_or_else(|| store_error("temporary store pathname disappeared"))?;
            validate_stable_open_metadata(&after, &named.file.metadata()?, body.len() as u64)?;
            before_cas(path)?;
            directory.revalidate_path(parent)?;
            let current = Self::load_from_directory(&directory, path, name, |_| {})?;
            if current.revision()? != expected_revision {
                return Err(store_error(
                    "durable known-answer evidence changed; reload is required",
                ));
            }
            directory.revalidate_path(parent)?;
            directory.rename_replace(&tmp_name, name)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = directory.remove_file(&tmp_name);
        }
        result?;
        let durability_warning = sync_parent(&directory)
            .err()
            .map(|_| KNOWN_ANSWER_DURABILITY_WARNING.to_string());
        Ok(KnownAnswerSaveOutcome {
            revision,
            durability_warning,
            _lock: lock,
            _directory: directory,
        })
    }

    pub fn publish_execution(
        &mut self,
        evidence: LiveKnownAnswerExecutionEvidence,
    ) -> CoreResult<()> {
        self.validate()?;
        let report = evidence.report;
        let canonical = render_live_known_answer_json(&report)?;
        let report = parse_live_known_answer_json(&canonical)?;
        let identity = report_identity(&report)?;
        if !matches!(&identity, KnownAnswerEvidenceIdentity::HostMinted(_)) {
            return Err(store_error(
                "new known-answer evidence requires a host-minted run identity",
            ));
        }
        let capture = evidence
            .capture
            .map(|capture| {
                let canonical = render_live_known_answer_capture_json(&capture)?;
                parse_live_known_answer_capture_json(&canonical)
            })
            .transpose()?;
        match &capture {
            Some(capture) => validate_report_capture_correspondence(&report, capture)?,
            None if report.canonical_capture_sha256.is_none() => {}
            None => return Err(store_error("report capture is unavailable")),
        }
        if let Some(index) = report_index_for_identity(&self.records, &identity)? {
            let existing_capture = capture_index_for_identity(&self.captures, &identity)?
                .map(|capture_index| &self.captures[capture_index]);
            if self.records[index] == report && existing_capture == capture.as_ref() {
                return Ok(());
            }
            return Err(store_error(
                "host-minted run identity was reused for different evidence",
            ));
        }

        let mut staged = self.clone();
        staged.records.push(report);
        if let Some(capture) = capture {
            staged.captures.push(capture);
        }
        staged.records.sort_by(|left, right| {
            left.observed_at
                .cmp(&right.observed_at)
                .then(left.role.cmp(&right.role))
                .then(
                    left.quality_run
                        .quality_unit
                        .storage_id()
                        .cmp(&right.quality_run.quality_unit.storage_id()),
                )
                .then(left.run_id.cmp(&right.run_id))
        });
        if staged.records.len() > MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS {
            let remove = staged.records.len() - MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS;
            for report in staged.records.drain(0..remove) {
                let removed = report_identity(&report)?;
                if let Some(index) = capture_index_for_identity(&staged.captures, &removed)? {
                    staged.captures.remove(index);
                }
            }
        }
        while serde_json::to_vec(&staged)?.len() > MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_BYTES
            && staged.records.len() > 1
        {
            let removed = report_identity(&staged.records.remove(0))?;
            if let Some(index) = capture_index_for_identity(&staged.captures, &removed)? {
                staged.captures.remove(index);
            }
        }
        staged.validate()?;
        *self = staged;
        Ok(())
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
        if self.records.is_empty() && self.captures.is_empty() {
            false
        } else {
            self.records.clear();
            self.captures.clear();
            true
        }
    }
}

#[derive(Debug, Clone)]
pub struct LiveKnownAnswerExecutionEvidence {
    pub report: LiveKnownAnswerRunReport,
    pub capture: Option<LiveKnownAnswerCanonicalCapture>,
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
) -> CoreResult<Vec<LiveKnownAnswerExecutionEvidence>> {
    ensure_known_answer_persistence_supported()?;
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
) -> CoreResult<LiveKnownAnswerExecutionEvidence> {
    let run_id = LiveKnownAnswerRunId::parse(format!("lkar_{}", Uuid::new_v4().simple()))?;
    let mut observations = Vec::with_capacity(prepared.len());
    let mut captures = Vec::new();
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
                KnownAnswerProviderTelemetry::default(),
            ));
            continue;
        }
        if case.blocks_diagnostic_before_dispatch() {
            observations.push(failed_observation(
                scenario_id,
                LaneStatus::Blocked,
                "host_diagnostic_pipeline_unavailable",
                0,
                0,
                0,
                KnownAnswerProviderTelemetry::default(),
            ));
            continue;
        }
        if !case.requires_host_diagnostic() {
            let dispatched = dispatch_known_answer_chat(target, case, cancel, transport)?;
            record_answer_only_observation(
                case,
                scenario_id,
                dispatched,
                &mut observations,
                &mut captures,
            );
            continue;
        }
        let (observation, capture) = execute_diagnostic_case(target, case, cancel, transport)?;
        if let Some(capture) = capture {
            captures.push(capture);
        }
        observations.push(observation);
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
    let mut report = build_live_known_answer_run_v2(
        run_id.clone(),
        observed_at,
        target.member.role,
        quality_unit.clone(),
        observations,
    )?;
    for input in &mut captures {
        let case = report
            .quality_run
            .cases
            .iter()
            .find(|case| case.case_id == input.scenario_id)
            .ok_or_else(|| store_error("captured scenario is absent from its score report"))?;
        let telemetry = report
            .telemetry
            .iter()
            .find(|row| row.scenario_id == input.scenario_id)
            .ok_or_else(|| store_error("captured scenario is absent from report telemetry"))?;
        if telemetry.status == LaneStatus::Executed {
            input.answer_score = Some(
                case.answers
                    .first()
                    .cloned()
                    .ok_or_else(|| store_error("executed capture has no score report answer"))?,
            );
        } else if telemetry.failure_code.as_deref() != Some("host_score_failed") {
            return Err(store_error(
                "unscored capture is not classified as a host scoring failure",
            ));
        } else {
            input.host_score_failed = true;
        }
    }
    let capture = if captures.is_empty() {
        None
    } else {
        Some(build_live_known_answer_capture_v2(
            run_id,
            observed_at,
            target.member.role,
            quality_unit,
            captures,
        )?)
    };
    if let Some(capture) = &capture {
        report.canonical_capture_sha256 = Some(live_known_answer_capture_sha256(capture)?);
        validate_live_known_answer_run(&report)?;
    }
    Ok(LiveKnownAnswerExecutionEvidence { report, capture })
}

struct DispatchedChat {
    response: SyntheticChatResponse,
    telemetry: KnownAnswerProviderTelemetry,
    latency_ms: u64,
    message_content_bytes: u64,
}

fn dispatch_known_answer_chat(
    target: &LiveQualificationTarget,
    case: &cd_core::quality_eval::PreparedLiveKnownAnswerCase,
    cancel: &AtomicBool,
    transport: &mut dyn QualificationTransport,
) -> CoreResult<DispatchedChat> {
    let prompt = serialize_live_known_answer_prompt(case)?;
    let request = live_known_answer_request(&target.member.model_id, &prompt);
    let message_content_bytes = request
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
    let telemetry = project_provider_telemetry(
        transport
            .take_last_chat_provider_telemetry()
            .unwrap_or_default(),
    )?;
    Ok(DispatchedChat {
        response,
        telemetry,
        latency_ms: started.elapsed().as_millis() as u64,
        message_content_bytes,
    })
}

fn record_answer_only_observation(
    case: &cd_core::quality_eval::PreparedLiveKnownAnswerCase,
    scenario_id: String,
    dispatched: DispatchedChat,
    observations: &mut Vec<LiveKnownAnswerScenarioObservation>,
    captures: &mut Vec<LiveKnownAnswerCanonicalScenarioInput>,
) {
    let provider_content_bytes = dispatched.response.content.len() as u64;
    let DispatchedChat {
        response,
        telemetry,
        latency_ms,
        message_content_bytes,
    } = dispatched;
    if telemetry.model_identity_rejected {
        observations.push(failed_observation(
            scenario_id,
            LaneStatus::Failed,
            "provider_response_privacy_rejected",
            latency_ms,
            message_content_bytes,
            provider_content_bytes,
            telemetry,
        ));
        return;
    }
    if response.cancelled {
        observations.push(failed_observation(
            scenario_id,
            LaneStatus::Cancelled,
            "provider_attempt_cancelled",
            latency_ms,
            message_content_bytes,
            provider_content_bytes,
            telemetry,
        ));
        return;
    }
    if response.raw_error.is_some() {
        observations.push(failed_observation(
            scenario_id,
            LaneStatus::Failed,
            "provider_request_failed",
            latency_ms,
            message_content_bytes,
            provider_content_bytes,
            telemetry,
        ));
        return;
    }
    match parse_live_known_answer_response_classified(case, &response.content) {
        Ok(parsed) => {
            captures.push(LiveKnownAnswerCanonicalScenarioInput {
                scenario_id: scenario_id.clone(),
                reported_model_id: telemetry.reported_model_id.clone(),
                response: parsed.clone(),
                answer_score: None,
                host_score_failed: false,
            });
            match score_live_known_answer_response(case, &parsed, None) {
                Ok(score) => observations.push(LiveKnownAnswerScenarioObservation {
                    scenario_id,
                    status: LaneStatus::Executed,
                    answer: Some(score.answer),
                    latency_ms,
                    message_content_bytes,
                    provider_content_bytes,
                    reported_model_id: telemetry.reported_model_id,
                    input_tokens: telemetry.input_tokens,
                    output_tokens: telemetry.output_tokens,
                    reasoning_tokens: telemetry.reasoning_tokens,
                    cached_tokens: telemetry.cached_tokens,
                    cost_microusd: telemetry.cost_microusd,
                    failure_code: None,
                }),
                Err(_) => observations.push(failed_observation(
                    scenario_id,
                    LaneStatus::Failed,
                    "host_score_failed",
                    latency_ms,
                    message_content_bytes,
                    provider_content_bytes,
                    telemetry,
                )),
            }
        }
        Err(failure) => observations.push(failed_observation(
            scenario_id,
            LaneStatus::Failed,
            failure.as_code(),
            latency_ms,
            message_content_bytes,
            provider_content_bytes,
            telemetry,
        )),
    }
}

fn execute_diagnostic_case(
    target: &LiveQualificationTarget,
    case: &cd_core::quality_eval::PreparedLiveKnownAnswerCase,
    cancel: &AtomicBool,
    transport: &mut dyn QualificationTransport,
) -> CoreResult<(
    LiveKnownAnswerScenarioObservation,
    Option<LiveKnownAnswerCanonicalScenarioInput>,
)> {
    let scenario_id = case.prompt().scenario_id.clone();
    let mut attempts: Vec<HostAttemptObservation> = Vec::new();
    let mut last_parsed = None;
    let mut last_parse_failure = None;
    let mut last_dispatched;
    let mut total_latency = 0;
    let mut total_message_bytes = 0;
    let mut total_provider_bytes = 0;
    let mut any_model_identity_rejected = false;

    loop {
        let dispatched = dispatch_known_answer_chat(target, case, cancel, transport)?;
        total_latency += dispatched.latency_ms;
        total_message_bytes += dispatched.message_content_bytes;
        total_provider_bytes += dispatched.response.content.len() as u64;
        any_model_identity_rejected |= dispatched.telemetry.model_identity_rejected;
        let parsed = if dispatched.response.content.is_empty() {
            None
        } else {
            match parse_live_known_answer_response_classified(case, &dispatched.response.content) {
                Ok(parsed) => {
                    last_parse_failure = None;
                    Some(parsed)
                }
                Err(failure) => {
                    last_parse_failure = Some(failure);
                    None
                }
            }
        };
        attempts.push(host_attempt_from_chat(
            format!("host-{}", attempts.len() + 1),
            dispatched.response.cancelled,
            dispatched.response.raw_error.as_deref(),
            parsed.as_ref(),
            dispatched.response.content.is_empty(),
        ));
        if let Some(parsed) = parsed {
            last_parsed = Some(parsed);
        }
        let cancelled = dispatched.response.cancelled;
        last_dispatched = dispatched;
        if cancelled {
            break;
        }
        let should_follow_up = case.host_may_record_follow_up_attempt()
            && attempts.len() == 1
            && !attempts[0].class.succeeded()
            && !cancel.load(Ordering::SeqCst);
        if !should_follow_up {
            break;
        }
    }

    let dispatched = last_dispatched;
    let telemetry = dispatched.telemetry;
    if any_model_identity_rejected {
        return Ok((
            failed_observation(
                scenario_id,
                LaneStatus::Failed,
                "provider_response_privacy_rejected",
                total_latency,
                total_message_bytes,
                total_provider_bytes,
                telemetry,
            ),
            None,
        ));
    }
    if dispatched.response.cancelled {
        return Ok((
            failed_observation(
                scenario_id,
                LaneStatus::Cancelled,
                "provider_attempt_cancelled",
                total_latency,
                total_message_bytes,
                total_provider_bytes,
                telemetry,
            ),
            None,
        ));
    }

    let host_diagnostic =
        host_diagnostic_for_observed_attempts(case, target.member.role, &attempts);
    if let Some(parsed) = last_parsed {
        let capture = LiveKnownAnswerCanonicalScenarioInput {
            scenario_id: scenario_id.clone(),
            reported_model_id: telemetry.reported_model_id.clone(),
            response: parsed.clone(),
            answer_score: None,
            host_score_failed: false,
        };
        if host_diagnostic.is_none() {
            return Ok((
                failed_observation(
                    scenario_id,
                    LaneStatus::Failed,
                    "host_score_failed",
                    total_latency,
                    total_message_bytes,
                    total_provider_bytes,
                    telemetry,
                ),
                Some(capture),
            ));
        }
        return match score_live_known_answer_response(case, &parsed, host_diagnostic) {
            Ok(score) => Ok((
                LiveKnownAnswerScenarioObservation {
                    scenario_id,
                    status: LaneStatus::Executed,
                    answer: Some(score.answer),
                    latency_ms: total_latency,
                    message_content_bytes: total_message_bytes,
                    provider_content_bytes: total_provider_bytes,
                    reported_model_id: telemetry.reported_model_id,
                    input_tokens: telemetry.input_tokens,
                    output_tokens: telemetry.output_tokens,
                    reasoning_tokens: telemetry.reasoning_tokens,
                    cached_tokens: telemetry.cached_tokens,
                    cost_microusd: telemetry.cost_microusd,
                    failure_code: None,
                },
                Some(capture),
            )),
            Err(_) => Ok((
                failed_observation(
                    scenario_id,
                    LaneStatus::Failed,
                    "host_score_failed",
                    total_latency,
                    total_message_bytes,
                    total_provider_bytes,
                    telemetry,
                ),
                Some(capture),
            )),
        };
    }

    let code = if dispatched.response.raw_error.is_some() {
        "provider_request_failed"
    } else if let Some(failure) = last_parse_failure {
        failure.as_code()
    } else {
        "provider_request_failed"
    };
    Ok((
        failed_observation(
            scenario_id,
            LaneStatus::Failed,
            code,
            total_latency,
            total_message_bytes,
            total_provider_bytes,
            telemetry,
        ),
        None,
    ))
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
    message_content_bytes: u64,
    provider_content_bytes: u64,
    provider_telemetry: KnownAnswerProviderTelemetry,
) -> LiveKnownAnswerScenarioObservation {
    LiveKnownAnswerScenarioObservation {
        scenario_id,
        status,
        answer: None,
        latency_ms,
        message_content_bytes,
        provider_content_bytes,
        reported_model_id: provider_telemetry.reported_model_id,
        input_tokens: provider_telemetry.input_tokens,
        output_tokens: provider_telemetry.output_tokens,
        reasoning_tokens: provider_telemetry.reasoning_tokens,
        cached_tokens: provider_telemetry.cached_tokens,
        cost_microusd: provider_telemetry.cost_microusd,
        failure_code: Some(code.into()),
    }
}

#[derive(Debug, Clone, Default)]
struct KnownAnswerProviderTelemetry {
    reported_model_id: Option<String>,
    model_identity_rejected: bool,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    reasoning_tokens: Option<u64>,
    cached_tokens: Option<u64>,
    cost_microusd: Option<u64>,
}

fn project_provider_telemetry(
    telemetry: ProviderTransportTelemetry,
) -> CoreResult<KnownAnswerProviderTelemetry> {
    let numeric = [
        telemetry.prompt_tokens,
        telemetry.completion_tokens,
        telemetry.reasoning_tokens,
        telemetry.cached_tokens,
    ];
    if numeric
        .into_iter()
        .flatten()
        .any(|value| value > LIVE_KNOWN_ANSWER_JS_SAFE_MAX)
    {
        return Err(store_error(
            "provider telemetry exceeds the JavaScript-safe integer bound",
        ));
    }
    let cost_microusd = telemetry
        .cost
        .map(|value| {
            cost_to_microusd(value).ok_or_else(|| {
                store_error("provider cost is invalid or exceeds the JavaScript-safe bound")
            })
        })
        .transpose()?;
    let (reported_model_id, model_identity_rejected) =
        match (telemetry.model_identity_status, telemetry.response_model) {
            (ModelIdentityStatus::Absent, None) => (None, false),
            (ModelIdentityStatus::Reported, Some(model)) => (Some(model), false),
            (ModelIdentityStatus::Rejected, None) => (None, true),
            _ => {
                return Err(store_error(
                    "provider model identity telemetry is internally inconsistent",
                ));
            }
        };
    Ok(KnownAnswerProviderTelemetry {
        reported_model_id,
        model_identity_rejected,
        input_tokens: telemetry.prompt_tokens,
        output_tokens: telemetry.completion_tokens,
        reasoning_tokens: telemetry.reasoning_tokens,
        cached_tokens: telemetry.cached_tokens,
        cost_microusd,
    })
}

fn cost_to_microusd(cost: f64) -> Option<u64> {
    let micros = cost * 1_000_000.0;
    if !micros.is_finite() || micros < 0.0 || micros > LIVE_KNOWN_ANSWER_JS_SAFE_MAX as f64 {
        None
    } else {
        Some(micros.round() as u64)
    }
}

fn project(
    report: &LiveKnownAnswerRunReport,
    context: &KnownAnswerProjectionContext,
) -> CoreResult<InvestigationTeamKnownAnswerDto> {
    let unit = &report.quality_run.quality_unit;
    let (run_id, run_id_provenance) = match &report.run_id {
        Some(run_id) => (
            Some(run_id.as_str().to_string()),
            KnownAnswerRunIdProvenance::HostMinted,
        ),
        None => (None, KnownAnswerRunIdProvenance::LegacyUnidentified),
    };
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
            message_content_bytes: telemetry.message_content_bytes,
            provider_content_bytes: telemetry.provider_content_bytes,
            reported_model_id: telemetry.reported_model_id.clone(),
            input_tokens: telemetry.input_tokens,
            output_tokens: telemetry.output_tokens,
            reasoning_tokens: telemetry.reasoning_tokens,
            cached_tokens: telemetry.cached_tokens,
            cost_microusd: telemetry.cost_microusd,
            failure_code: telemetry.failure_code.clone(),
        })
        .collect();
    Ok(InvestigationTeamKnownAnswerDto {
        run_id,
        run_id_provenance,
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

#[cfg(unix)]
fn read_exact_open_file(file: &mut File, expected_size: u64) -> CoreResult<Vec<u8>> {
    if expected_size > MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_BYTES as u64 {
        return Err(store_error("store exceeds the byte limit"));
    }
    let expected = usize::try_from(expected_size)
        .map_err(|_| store_error("store size cannot be represented"))?;
    let mut bytes = vec![0; expected];
    file.read_exact(&mut bytes)?;
    let mut sentinel = [0u8; 1];
    if file.read(&mut sentinel)? != 0 {
        return Err(store_error("store grew while it was being read"));
    }
    Ok(bytes)
}

#[cfg(unix)]
fn validate_stable_open_metadata(
    before: &std::fs::Metadata,
    after: &std::fs::Metadata,
    expected_size: u64,
) -> CoreResult<()> {
    if !before.is_file()
        || !after.is_file()
        || before.len() != expected_size
        || after.len() != expected_size
    {
        return Err(store_error(
            "open store identity or size changed while reading",
        ));
    }
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.mode() != after.mode()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(store_error("open store metadata changed while reading"));
    }
    Ok(())
}

#[cfg(unix)]
fn acquire_known_answer_write_lock(
    directory: &LiveKnownAnswerOwnerDirectory,
    name: &str,
) -> CoreResult<KnownAnswerWriteLock> {
    let file = match directory.open_owner_regular(name, 0, true)? {
        Some(opened) => opened.file,
        None => directory.create_owner_regular(name)?,
    };
    let opened_metadata = file.metadata()?;
    let named = directory
        .open_owner_regular(name, 0, false)?
        .ok_or_else(|| store_error("known-answer write lock disappeared"))?;
    validate_stable_open_metadata(&opened_metadata, &named.file.metadata()?, 0)?;
    file.try_lock().map_err(|_| {
        store_error("known-answer evidence is locked by another persistence operation")
    })?;
    let locked_metadata = file.metadata()?;
    let locked_named = directory
        .open_owner_regular(name, 0, false)?
        .ok_or_else(|| store_error("known-answer write lock disappeared"))?;
    validate_stable_open_metadata(&locked_metadata, &locked_named.file.metadata()?, 0)?;
    Ok(KnownAnswerWriteLock { _file: file })
}

#[cfg(unix)]
fn sync_parent_directory_after_replace(
    directory: &LiveKnownAnswerOwnerDirectory,
) -> CoreResult<()> {
    directory.sync()
}

fn store_parent_and_name(path: &Path) -> CoreResult<(&Path, &str)> {
    let parent = path
        .parent()
        .ok_or_else(|| store_error("store path has no parent directory"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| store_error("store path filename is invalid"))?;
    Ok((parent, name))
}

fn store_unavailable_error() -> CoreError {
    if let Err(error) = ensure_known_answer_persistence_supported() {
        return error;
    }
    store_error(
        "existing evidence is unavailable; repair or remove the invalid owner store before listing, clearing, running, or saving",
    )
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum KnownAnswerEvidenceIdentity {
    HostMinted(LiveKnownAnswerRunId),
    Legacy {
        observed_at: i64,
        role: InvestigationTeamRole,
        subject_storage_id: String,
        suite_id: String,
    },
}

fn report_identity(report: &LiveKnownAnswerRunReport) -> CoreResult<KnownAnswerEvidenceIdentity> {
    Ok(match &report.run_id {
        Some(run_id) => KnownAnswerEvidenceIdentity::HostMinted(run_id.clone()),
        None => KnownAnswerEvidenceIdentity::Legacy {
            observed_at: report.observed_at,
            role: report.role,
            subject_storage_id: report.quality_run.quality_unit.storage_id(),
            suite_id: report.quality_run.quality_unit.suite_id.clone(),
        },
    })
}

fn capture_identity(
    capture: &LiveKnownAnswerCanonicalCapture,
) -> CoreResult<KnownAnswerEvidenceIdentity> {
    Ok(match &capture.run_id {
        Some(run_id) => KnownAnswerEvidenceIdentity::HostMinted(run_id.clone()),
        None => KnownAnswerEvidenceIdentity::Legacy {
            observed_at: capture.observed_at,
            role: capture.role,
            subject_storage_id: capture.quality_unit.storage_id(),
            suite_id: capture.quality_unit.suite_id.clone(),
        },
    })
}

fn report_index_for_identity(
    records: &[LiveKnownAnswerRunReport],
    identity: &KnownAnswerEvidenceIdentity,
) -> CoreResult<Option<usize>> {
    for (index, report) in records.iter().enumerate() {
        if &report_identity(report)? == identity {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

fn capture_index_for_identity(
    captures: &[LiveKnownAnswerCanonicalCapture],
    identity: &KnownAnswerEvidenceIdentity,
) -> CoreResult<Option<usize>> {
    for (index, capture) in captures.iter().enumerate() {
        if &capture_identity(capture)? == identity {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

fn validate_report_capture_correspondence(
    report: &LiveKnownAnswerRunReport,
    capture: &LiveKnownAnswerCanonicalCapture,
) -> CoreResult<()> {
    if report_identity(report)? != capture_identity(capture)?
        || report.observed_at != capture.observed_at
        || report.role != capture.role
        || report.quality_run.quality_unit != capture.quality_unit
    {
        return Err(store_error(
            "capture does not match the report's exact quality identity",
        ));
    }
    let expected_digest = live_known_answer_capture_sha256(capture)?;
    if report.canonical_capture_sha256.as_deref() != Some(expected_digest.as_str()) {
        return Err(store_error(
            "capture digest does not match its score report",
        ));
    }
    let expected = report
        .telemetry
        .iter()
        .filter(|row| {
            row.status == LaneStatus::Executed
                || (row.status == LaneStatus::Failed
                    && row.failure_code.as_deref() == Some("host_score_failed"))
        })
        .collect::<Vec<_>>();
    if expected.len() != capture.scenarios.len() {
        return Err(store_error(
            "capture scenarios do not match the report execution outcomes",
        ));
    }
    for (telemetry, scenario) in expected.into_iter().zip(&capture.scenarios) {
        if telemetry.scenario_id != scenario.scenario_id
            || telemetry.reported_model_id != scenario.reported_model_id
        {
            return Err(store_error(
                "capture scenario or reported model does not match the score report",
            ));
        }
        let case = report
            .quality_run
            .cases
            .iter()
            .find(|case| case.case_id == telemetry.scenario_id)
            .ok_or_else(|| store_error("capture scenario has no score report case"))?;
        if telemetry.status == LaneStatus::Executed {
            if scenario.host_score_failed {
                return Err(store_error(
                    "executed capture is marked as a host scoring failure",
                ));
            }
            let answer = case
                .answers
                .first()
                .ok_or_else(|| store_error("executed capture has no score report answer"))?;
            let expected_score_digest = live_known_answer_answer_score_sha256(answer)?;
            if scenario.answer_score_sha256.as_deref() != Some(expected_score_digest.as_str()) {
                return Err(store_error(
                    "capture response is not bound to its exact answer score",
                ));
            }
        } else if telemetry.status == LaneStatus::Failed
            && telemetry.failure_code.as_deref() == Some("host_score_failed")
        {
            if scenario.answer_score_sha256.is_some() || !scenario.host_score_failed {
                return Err(store_error(
                    "host scoring failure capture has contradictory score eligibility",
                ));
            }
        } else {
            return Err(store_error(
                "unscored capture has an invalid failure classification",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::capability_qualification::TransportError;
    use cd_core::investigation_team_qualification::MemberBinding;
    use cd_workflow::capability_qualification::LiveBackendKind;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::{Builder, TempDir};

    fn owner_tempdir() -> TempDir {
        #[cfg(unix)]
        {
            let root = std::env::temp_dir()
                .canonicalize()
                .expect("canonical temporary root");
            let directory = Builder::new()
                .prefix("contextdesk-known-answer-")
                .tempdir_in(root)
                .expect("owner temporary directory");
            std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
                .expect("owner-only temporary directory");
            directory
        }
        #[cfg(not(unix))]
        {
            Builder::new()
                .prefix("contextdesk-known-answer-")
                .tempdir()
                .expect("temporary directory")
        }
    }

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

    #[derive(Default)]
    struct AnsweringTransport {
        calls: usize,
        last: Option<ProviderTransportTelemetry>,
        scenario_ids: Vec<String>,
    }

    impl QualificationTransport for AnsweringTransport {
        fn chat_complete(
            &mut self,
            req: &SyntheticChatRequest,
            _cancel: &AtomicBool,
        ) -> Result<SyntheticChatResponse, TransportError> {
            let prompt: cd_core::quality_eval::LiveKnownAnswerPrompt =
                serde_json::from_str(&req.messages[1].content).expect("prompt");
            self.scenario_ids.push(prompt.scenario_id.clone());
            let content = match self.calls {
                0 => "not json".into(),
                1 => serde_json::json!({
                    "schema_id": cd_core::quality_eval::LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID,
                    "scenario_id": prompt.scenario_id,
                    "claims": [{"text": "sk-private", "citations": [], "role": "other"}],
                    "conclusion": "rejected",
                    "confidence": "low"
                })
                .to_string(),
                2 => serde_json::json!({
                    "schema_id": cd_core::quality_eval::LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID,
                    "scenario_id": prompt.scenario_id,
                    "claims": [{"text": "bounded", "citations": [], "role": "guess"}],
                    "conclusion": "rejected",
                    "confidence": "low"
                })
                .to_string(),
                _ => serde_json::to_string(&cd_core::quality_eval::LiveKnownAnswerResponse {
                    schema_id: cd_core::quality_eval::LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID.into(),
                    scenario_id: prompt.scenario_id,
                    asserts_root_cause_established: false,
                    claims: Vec::new(),
                    conclusion: "Insufficient evidence in the supplied packet.".into(),
                    confidence: "low".into(),
                })
                .expect("response"),
            };
            self.calls += 1;
            self.last = Some(ProviderTransportTelemetry {
                response_model: Some("reported/model-b".into()),
                model_identity_status: ModelIdentityStatus::Reported,
                prompt_tokens: Some(100),
                completion_tokens: Some(20),
                reasoning_tokens: Some(5),
                cached_tokens: Some(7),
                cost: Some(0.000_123),
                ..ProviderTransportTelemetry::default()
            });
            Ok(SyntheticChatResponse {
                content,
                mode_transmitted: true,
                ..SyntheticChatResponse::default()
            })
        }

        fn take_last_chat_provider_telemetry(&mut self) -> Option<ProviderTransportTelemetry> {
            self.last.take()
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

    fn empty_store_revision() -> String {
        InvestigationTeamKnownAnswerStore::default()
            .revision()
            .expect("empty revision")
    }

    #[test]
    fn failed_transport_is_complete_redacted_evidence_not_a_pass() {
        let suite = load_embedded_open_v1_suite().expect("suite");
        let prepared = prepare_live_known_answer_suite(&suite).expect("prepared");
        let prompt_hash = live_known_answer_prompt_set_hash(&prepared).expect("hash");
        let mut transport = FailedTransport::default();
        let evidence = execute_target(
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
        let report = evidence.report;
        assert_eq!(transport.calls, 12);
        assert_eq!(report.status, LiveKnownAnswerRunStatus::Partial);
        assert_eq!(report.metrics.failed_scenarios, 11);
        assert_eq!(report.metrics.blocked_scenarios, 3);
        assert_eq!(report.telemetry[8].status, LaneStatus::Failed);
        assert_eq!(
            report.telemetry[8].failure_code.as_deref(),
            Some("provider_request_failed")
        );
        assert!(report.telemetry[8].message_content_bytes > 0);
        assert!(report.telemetry[9..12].iter().all(|row| {
            row.status == LaneStatus::Blocked
                && row.failure_code.as_deref() == Some("host_diagnostic_pipeline_unavailable")
                && row.latency_ms == 0
                && row.message_content_bytes == 0
                && row.provider_content_bytes == 0
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
        let evidence = execute_target(
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
        store.publish_execution(evidence).expect("publish");
        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        store.save(&path, &empty_store_revision()).expect("save");
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

    #[test]
    fn canonical_capture_and_provider_telemetry_are_honest_and_private() {
        let suite = load_embedded_open_v1_suite().expect("suite");
        let prepared = prepare_live_known_answer_suite(&suite).expect("prepared");
        let prompt_hash = live_known_answer_prompt_set_hash(&prepared).expect("hash");
        let mut transport = AnsweringTransport::default();
        let evidence = execute_target(
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
        .expect("evidence");

        assert_eq!(transport.calls, 11);
        assert_eq!(
            evidence.report.telemetry[0].failure_code.as_deref(),
            Some("provider_response_parse_failed")
        );
        assert_eq!(
            evidence.report.telemetry[1].failure_code.as_deref(),
            Some("provider_response_privacy_rejected")
        );
        assert_eq!(
            evidence.report.telemetry[2].failure_code.as_deref(),
            Some("provider_response_vocabulary_rejected")
        );
        assert_eq!(evidence.report.telemetry[3].input_tokens, Some(100));
        assert_eq!(evidence.report.telemetry[3].reasoning_tokens, Some(5));
        assert_eq!(evidence.report.telemetry[3].cost_microusd, Some(123));
        assert_eq!(
            evidence.report.telemetry[3].reported_model_id.as_deref(),
            Some("reported/model-b")
        );
        assert_eq!(
            evidence.report.quality_run.quality_unit.subject.model_id,
            "model-a"
        );
        assert_eq!(evidence.report.metrics.input_tokens, Some(1_100));
        assert_eq!(evidence.report.metrics.output_tokens, Some(220));
        assert_eq!(evidence.report.metrics.reasoning_tokens, Some(55));
        assert_eq!(evidence.report.metrics.cached_tokens, Some(77));
        assert_eq!(evidence.report.metrics.cost_microusd, Some(1_353));

        let capture = evidence.capture.as_ref().expect("capture");
        assert_eq!(capture.scenarios.len(), 8);
        assert_eq!(capture.quality_unit.subject.model_id, "model-a");
        assert!(capture
            .scenarios
            .iter()
            .all(|row| row.reported_model_id.as_deref() == Some("reported/model-b")));
        assert!(capture.scenarios.iter().all(|row| {
            if row.host_score_failed {
                row.answer_score_sha256.is_none()
            } else {
                row.answer_score_sha256
                    .as_deref()
                    .is_some_and(|hash| hash.len() == 64)
            }
        }));
        assert_eq!(
            capture
                .scenarios
                .iter()
                .filter(|row| row.host_score_failed)
                .count(),
            1
        );
        let capture_json = render_live_known_answer_capture_json(capture).expect("capture json");
        assert!(!capture_json.contains("not json"));
        assert!(!capture_json.contains("sk-private"));
        assert!(!capture_json.contains("https://gateway"));
        assert!(!capture_json.contains("x-secret"));

        let report_json = render_live_known_answer_json(&evidence.report).expect("report json");
        assert!(!report_json.contains("not json"));
        assert!(!report_json.contains("sk-private"));
        assert!(!report_json.contains("Insufficient evidence"));
        let markdown = render_live_known_answer_markdown(&evidence.report).expect("markdown");
        assert!(markdown.contains("differs from configured model"));

        let mut store = InvestigationTeamKnownAnswerStore::default();
        store.publish_execution(evidence).expect("publish");
        let serialized = serde_json::to_string(&store).expect("store json");
        assert!(!serialized.contains("not json"));
        assert!(!serialized.contains("sk-private"));
        assert!(!serialized.contains("https://gateway"));
    }

    fn bounded_live_response(scenario_id: String) -> String {
        serde_json::to_string(&cd_core::quality_eval::LiveKnownAnswerResponse {
            schema_id: cd_core::quality_eval::LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID.into(),
            scenario_id,
            asserts_root_cause_established: false,
            claims: Vec::new(),
            conclusion: "Insufficient evidence in the supplied packet.".into(),
            confidence: "low".into(),
        })
        .expect("response")
    }

    #[derive(Default)]
    struct DiagnosticSeamTransport {
        calls: usize,
        qe09_calls: usize,
        last: Option<ProviderTransportTelemetry>,
        scenario_ids: Vec<String>,
    }

    impl QualificationTransport for DiagnosticSeamTransport {
        fn chat_complete(
            &mut self,
            req: &SyntheticChatRequest,
            _cancel: &AtomicBool,
        ) -> Result<SyntheticChatResponse, TransportError> {
            let prompt: cd_core::quality_eval::LiveKnownAnswerPrompt =
                serde_json::from_str(&req.messages[1].content).expect("prompt");
            self.scenario_ids.push(prompt.scenario_id.clone());
            self.calls += 1;
            self.last = Some(ProviderTransportTelemetry {
                response_model: Some("reported/model-b".into()),
                model_identity_status: ModelIdentityStatus::Reported,
                prompt_tokens: Some(100),
                completion_tokens: Some(20),
                reasoning_tokens: Some(5),
                cached_tokens: Some(7),
                cost: Some(0.000_123),
                ..ProviderTransportTelemetry::default()
            });
            match prompt.scenario_id.as_str() {
                "scenario-010" | "scenario-011" | "scenario-012" => {
                    panic!("qe10–qe12 must stay pre-dispatch blocked")
                }
                "scenario-009" => {
                    self.qe09_calls += 1;
                    if self.qe09_calls == 1 {
                        return Err(TransportError {
                            reason: "connection reset".into(),
                        });
                    }
                    Ok(SyntheticChatResponse {
                        content: bounded_live_response(prompt.scenario_id),
                        mode_transmitted: true,
                        ..SyntheticChatResponse::default()
                    })
                }
                _ => Ok(SyntheticChatResponse {
                    content: bounded_live_response(prompt.scenario_id),
                    mode_transmitted: true,
                    ..SyntheticChatResponse::default()
                }),
            }
        }

        fn take_last_chat_provider_telemetry(&mut self) -> Option<ProviderTransportTelemetry> {
            self.last.take()
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

    #[test]
    fn execute_target_fluent_qe09_qe10_are_host_gaps_not_category_failures() {
        let suite = load_embedded_open_v1_suite().expect("suite");
        let prepared = prepare_live_known_answer_suite(&suite).expect("prepared");
        let prompt_hash = live_known_answer_prompt_set_hash(&prepared).expect("hash");
        assert!(!prepared[8].blocks_diagnostic_before_dispatch());
        assert!(prepared[9].blocks_diagnostic_before_dispatch());
        let mut transport = AnsweringTransport::default();
        let evidence = execute_target(
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
        .expect("evidence");

        assert_eq!(transport.calls, 11);
        assert!(transport.scenario_ids.iter().any(|id| id == "scenario-009"));
        assert!(
            !transport.scenario_ids.iter().any(|id| {
                matches!(
                    id.as_str(),
                    "scenario-010" | "scenario-011" | "scenario-012"
                )
            }),
            "qe10–qe12 must not be dispatched: {:?}",
            transport.scenario_ids
        );
        let qe09 = &evidence.report.quality_run.cases[8];
        assert!(
            qe09.answers.is_empty(),
            "fluent qe09 must not carry a diagnostic_category model failure"
        );
        assert_eq!(evidence.report.telemetry[8].status, LaneStatus::Failed);
        assert_eq!(
            evidence.report.telemetry[8].failure_code.as_deref(),
            Some("host_score_failed")
        );
        assert!(evidence.report.telemetry[8].message_content_bytes > 0);
        assert!(evidence.report.telemetry[9..12].iter().all(|row| {
            row.status == LaneStatus::Blocked
                && row.failure_code.as_deref() == Some("host_diagnostic_pipeline_unavailable")
                && row.message_content_bytes == 0
        }));
    }

    #[test]
    fn execute_target_joins_mixed_host_diagnostics() {
        let suite = load_embedded_open_v1_suite().expect("suite");
        let prepared = prepare_live_known_answer_suite(&suite).expect("prepared");
        let prompt_hash = live_known_answer_prompt_set_hash(&prepared).expect("hash");
        let mut transport = DiagnosticSeamTransport::default();
        let evidence = execute_target(
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
        .expect("evidence");

        assert_eq!(transport.qe09_calls, 2);
        assert!(
            !transport.scenario_ids.iter().any(|id| {
                matches!(
                    id.as_str(),
                    "scenario-010" | "scenario-011" | "scenario-012"
                )
            }),
            "qe10–qe12 must stay blocked: {:?}",
            transport.scenario_ids
        );
        assert_eq!(
            evidence.report.telemetry[8].status,
            LaneStatus::Executed,
            "qe09 mixed attempts must reach the scorer"
        );
        assert!(evidence.report.telemetry[9..12].iter().all(|row| {
            row.status == LaneStatus::Blocked
                && row.failure_code.as_deref() == Some("host_diagnostic_pipeline_unavailable")
                && row.message_content_bytes == 0
        }));

        let qe09 = evidence.report.quality_run.cases[8]
            .answers
            .first()
            .expect("qe09 host-built score");
        let qe09_failed = qe09.failed_ids();
        assert!(qe09
            .dimensions
            .iter()
            .any(|dimension| dimension.id == "diagnostic_envelope_present" && dimension.passed));
        assert!(qe09
            .dimensions
            .iter()
            .any(|dimension| dimension.id == "attempt_usefulness" && dimension.passed));
        assert!(
            !qe09_failed.contains(&"diagnostic_category"),
            "qe09 must join mixed attempts, not compatible_success: {qe09_failed:?}"
        );
        assert!(!qe09_failed.contains(&"attempt_usefulness"));
        assert!(
            qe09.dimensions
                .iter()
                .any(|dimension| { dimension.id == "attempt_usefulness" && dimension.passed }),
            "failed first attempt must remain on the scored envelope"
        );
        assert!(evidence.report.quality_run.cases[9].answers.is_empty());
    }

    fn captured_evidence() -> LiveKnownAnswerExecutionEvidence {
        let suite = load_embedded_open_v1_suite().expect("suite");
        let prepared = prepare_live_known_answer_suite(&suite).expect("prepared");
        let prompt_hash = live_known_answer_prompt_set_hash(&prepared).expect("hash");
        execute_target(
            &target(),
            &prepared,
            &suite.manifest.suite_id,
            &suite.digest,
            &prompt_hash,
            1_777_000_000,
            "build-a",
            &AtomicBool::new(false),
            &mut AnsweringTransport::default(),
        )
        .expect("evidence")
    }

    fn evidence_with_run_id(
        mut evidence: LiveKnownAnswerExecutionEvidence,
        run_id: &str,
        observed_at: i64,
    ) -> LiveKnownAnswerExecutionEvidence {
        let run_id = LiveKnownAnswerRunId::parse(run_id).expect("run id");
        evidence.report.run_id = Some(run_id.clone());
        evidence.report.observed_at = observed_at;
        if let Some(capture) = &mut evidence.capture {
            capture.run_id = Some(run_id);
            capture.observed_at = observed_at;
            evidence.report.canonical_capture_sha256 =
                Some(live_known_answer_capture_sha256(capture).expect("capture digest"));
        }
        evidence
    }

    fn legacy_evidence(
        mut evidence: LiveKnownAnswerExecutionEvidence,
        include_capture: bool,
    ) -> LiveKnownAnswerExecutionEvidence {
        evidence.report.schema_id =
            cd_core::quality_eval::LIVE_KNOWN_ANSWER_RUN_SCHEMA_ID_V1.into();
        evidence.report.run_id = None;
        if include_capture {
            let capture = evidence.capture.as_mut().expect("capture");
            capture.schema_id =
                cd_core::quality_eval::LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID_V1.into();
            capture.run_id = None;
            evidence.report.canonical_capture_sha256 =
                Some(live_known_answer_capture_sha256(capture).expect("capture digest"));
        } else {
            evidence.capture = None;
            evidence.report.canonical_capture_sha256 = None;
        }
        evidence
    }

    fn encoded_store(schema_id: &str, evidence: LiveKnownAnswerExecutionEvidence) -> Vec<u8> {
        serde_json::to_vec(&InvestigationTeamKnownAnswerStore {
            schema_id: schema_id.into(),
            records: vec![evidence.report],
            captures: evidence.capture.into_iter().collect(),
        })
        .expect("store json")
    }

    #[test]
    fn legacy_v1_and_v2_stores_migrate_without_synthesizing_run_ids() {
        let base = captured_evidence();
        let v1 = legacy_evidence(base.clone(), false);
        let migrated_v1 = InvestigationTeamKnownAnswerStore::decode(&encoded_store(
            INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V1,
            v1,
        ))
        .expect("migrate V1");
        assert_eq!(
            migrated_v1.schema_id,
            INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V3
        );
        assert_eq!(migrated_v1.records[0].run_id, None);
        assert!(migrated_v1.captures.is_empty());

        let v2 = legacy_evidence(base, true);
        let migrated_v2 = InvestigationTeamKnownAnswerStore::decode(&encoded_store(
            INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V2,
            v2,
        ))
        .expect("migrate V2");
        assert_eq!(
            migrated_v2.schema_id,
            INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V3
        );
        assert_eq!(migrated_v2.records[0].run_id, None);
        assert_eq!(migrated_v2.captures[0].run_id, None);
    }

    #[test]
    fn legacy_and_host_minted_history_coexist_across_save_reload() {
        let legacy = legacy_evidence(captured_evidence(), true);
        let mut store = InvestigationTeamKnownAnswerStore::decode(&encoded_store(
            INVESTIGATION_TEAM_KNOWN_ANSWER_STORE_SCHEMA_V2,
            legacy,
        ))
        .expect("migrate legacy store");
        let host = evidence_with_run_id(
            captured_evidence(),
            "lkar_00000000000040008000000000000001",
            1_777_000_000,
        );
        store.publish_execution(host).expect("publish host run");

        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        store.save(&path, &empty_store_revision()).expect("save");
        let loaded = InvestigationTeamKnownAnswerStore::load(&path).expect("reload");
        assert_eq!(loaded.records.len(), 2);
        assert_eq!(loaded.captures.len(), 2);
        let context =
            current_projection_context("build-a".into(), vec![target().member]).expect("context");
        let history = loaded.history(&context).expect("history");
        assert!(history.iter().any(|row| {
            row.run_id.is_none()
                && row.run_id_provenance == KnownAnswerRunIdProvenance::LegacyUnidentified
        }));
        assert!(history.iter().any(|row| {
            row.run_id.as_deref() == Some("lkar_00000000000040008000000000000001")
                && row.run_id_provenance == KnownAnswerRunIdProvenance::HostMinted
        }));
    }

    #[test]
    fn same_second_runs_remain_distinct_and_round_trip_by_host_id() {
        let base = captured_evidence();
        let mut store = InvestigationTeamKnownAnswerStore::default();
        for run_id in [
            "lkar_00000000000040008000000000000001",
            "lkar_00000000000040008000000000000002",
        ] {
            store
                .publish_execution(evidence_with_run_id(base.clone(), run_id, 1_777_000_000))
                .expect("publish distinct run");
        }
        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        store.save(&path, &empty_store_revision()).expect("save");
        let loaded = InvestigationTeamKnownAnswerStore::load(&path).expect("reload");
        assert_eq!(loaded.records.len(), 2);
        assert_eq!(loaded.captures.len(), 2);
        assert_ne!(loaded.records[0].run_id, loaded.records[1].run_id);
    }

    #[test]
    fn report_capture_run_mismatch_fails_closed() {
        let mut evidence = evidence_with_run_id(
            captured_evidence(),
            "lkar_00000000000040008000000000000001",
            1_777_000_000,
        );
        let capture = evidence.capture.as_mut().expect("capture");
        capture.run_id = Some(
            LiveKnownAnswerRunId::parse("lkar_00000000000040008000000000000002")
                .expect("second run id"),
        );
        evidence.report.canonical_capture_sha256 =
            Some(live_known_answer_capture_sha256(capture).expect("capture digest"));
        let error = InvestigationTeamKnownAnswerStore::default()
            .publish_execution(evidence)
            .expect_err("run mismatch");
        assert!(error.to_string().contains("exact quality identity"));
    }

    #[test]
    fn host_run_id_is_idempotent_but_never_overwrites_changed_evidence() {
        let evidence = evidence_with_run_id(
            captured_evidence(),
            "lkar_00000000000040008000000000000001",
            1_777_000_000,
        );
        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(evidence.clone())
            .expect("first publish");
        let committed = store.clone();
        store
            .publish_execution(evidence.clone())
            .expect("identical retry");
        assert_eq!(store, committed);

        let changed = evidence_with_run_id(
            evidence.clone(),
            "lkar_00000000000040008000000000000001",
            1_777_000_001,
        );
        assert!(store
            .publish_execution(changed)
            .expect_err("changed same-id evidence")
            .to_string()
            .contains("reused for different evidence"));
        assert_eq!(store, committed);

        let mut missing_capture = evidence;
        missing_capture.capture = None;
        missing_capture.report.canonical_capture_sha256 = None;
        assert!(store
            .publish_execution(missing_capture)
            .expect_err("same id cannot remove capture")
            .to_string()
            .contains("reused for different evidence"));
        assert_eq!(store, committed);
    }

    #[test]
    fn new_legacy_evidence_is_rejected_without_mutating_history() {
        let mut store = InvestigationTeamKnownAnswerStore::default();
        let before = store.clone();
        assert!(store
            .publish_execution(legacy_evidence(captured_evidence(), true))
            .expect_err("legacy publish")
            .to_string()
            .contains("host-minted run identity"));
        assert_eq!(store, before);
    }

    #[test]
    fn bounded_pruning_removes_only_the_evicted_run_capture() {
        let base = captured_evidence();
        let mut store = InvestigationTeamKnownAnswerStore::default();
        for index in 1..=MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS {
            let run_id = format!("lkar_00000000000040008000{index:012x}");
            let evidence =
                evidence_with_run_id(base.clone(), &run_id, 1_777_000_000 + index as i64);
            store.records.push(evidence.report);
            store.captures.push(evidence.capture.expect("capture"));
        }
        store.validate().expect("seeded bounded store");
        let newest = MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS + 1;
        let newest_id = format!("lkar_00000000000040008000{newest:012x}");
        store
            .publish_execution(evidence_with_run_id(
                base,
                &newest_id,
                1_777_000_000 + newest as i64,
            ))
            .expect("publish evicting run");
        assert_eq!(
            store.records.len(),
            MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS
        );
        assert_eq!(
            store.captures.len(),
            MAX_INVESTIGATION_TEAM_KNOWN_ANSWER_RECORDS
        );
        let evicted = LiveKnownAnswerRunId::parse("lkar_00000000000040008000000000000001")
            .expect("evicted id");
        assert!(store
            .records
            .iter()
            .all(|row| row.run_id.as_ref() != Some(&evicted)));
        assert!(store
            .captures
            .iter()
            .all(|row| row.run_id.as_ref() != Some(&evicted)));
        store.validate().expect("pruned store remains valid");
    }

    #[test]
    fn recomputed_inline_capture_hash_cannot_detach_capture_from_score_report() {
        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(captured_evidence())
            .expect("publish");
        let scenario = &mut store.captures[0].scenarios[0];
        scenario.canonical_response.conclusion = "A different private response.".into();
        scenario.canonical_response_sha256 = cd_core::quality_eval::hex_sha256(
            serde_json::to_string(&scenario.canonical_response)
                .expect("canonical response")
                .as_bytes(),
        );
        let error = store.validate().expect_err("detached capture must fail");
        assert!(error.to_string().contains("digest does not match"));
    }

    #[test]
    fn capture_must_match_exact_reported_model_and_full_quality_unit() {
        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(captured_evidence())
            .expect("publish");
        store.captures[0].scenarios[0].reported_model_id = Some("different/model".into());
        store.records[0].canonical_capture_sha256 =
            Some(live_known_answer_capture_sha256(&store.captures[0]).expect("capture digest"));
        assert!(store
            .validate()
            .expect_err("reported model mismatch")
            .to_string()
            .contains("reported model"));

        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(captured_evidence())
            .expect("publish");
        store.captures[0].quality_unit.build_identity = "different-build".into();
        assert!(
            validate_report_capture_correspondence(&store.records[0], &store.captures[0])
                .expect_err("quality unit mismatch")
                .to_string()
                .contains("exact quality identity")
        );
    }

    #[test]
    fn captured_response_must_match_the_exact_report_answer_score() {
        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(captured_evidence())
            .expect("publish");
        let case = store.records[0]
            .quality_run
            .cases
            .iter_mut()
            .find(|case| !case.answers.is_empty())
            .expect("executed case");
        case.answers[0].dimensions[0].reason = "self-consistent but altered reason".into();
        render_live_known_answer_json(&store.records[0])
            .expect("the altered report remains internally canonical");
        let error = store
            .validate()
            .expect_err("detached report score must fail capture correspondence");
        assert!(error.to_string().contains("exact answer score"));

        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(captured_evidence())
            .expect("publish");
        store.captures[0].scenarios[0].answer_score_sha256 = None;
        store.captures[0].scenarios[0].host_score_failed = true;
        store.records[0].canonical_capture_sha256 =
            Some(live_known_answer_capture_sha256(&store.captures[0]).expect("capture digest"));
        assert!(store
            .validate()
            .expect_err("executed response without score binding")
            .to_string()
            .contains("host scoring failure"));
    }

    #[test]
    fn private_store_save_is_owner_only_verified_and_does_not_use_predictable_temp() {
        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(captured_evidence())
            .expect("publish");
        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        let predictable = dir.path().join("known.json.tmp");
        std::fs::write(&predictable, b"do not touch").expect("predictable sentinel");
        store.save(&path, &empty_store_revision()).expect("save");
        assert_eq!(
            std::fs::read(&predictable).expect("sentinel"),
            b"do not touch"
        );
        assert_eq!(
            InvestigationTeamKnownAnswerStore::load(&path).expect("load"),
            store
        );
        #[cfg(unix)]
        assert_eq!(
            std::fs::symlink_metadata(&path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .all(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                !(name.starts_with(".known.json.") && name.ends_with(".tmp"))
            }));
    }

    #[cfg(unix)]
    #[test]
    fn writer_lock_serializes_and_is_released_by_the_open_handle() {
        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(captured_evidence())
            .expect("publish");
        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        let first = store
            .save(&path, &empty_store_revision())
            .expect("first save");
        let lock_path = dir.path().join(".known.json.lock");
        let lock_metadata = std::fs::symlink_metadata(&lock_path).expect("persistent lock");
        assert!(lock_metadata.is_file());
        assert_eq!(lock_metadata.permissions().mode() & 0o777, 0o600);
        assert!(store
            .save(&path, &first.revision)
            .expect_err("held kernel lock must serialize writers")
            .to_string()
            .contains("locked"));

        drop(first);
        store
            .save(&path, &store.revision().expect("revision"))
            .expect("an unlocked persistent sidecar is restart-safe");
    }

    #[test]
    fn clear_removes_redacted_reports_and_private_captures_together() {
        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(captured_evidence())
            .expect("publish");
        assert!(!store.records.is_empty());
        assert!(!store.captures.is_empty());
        assert!(store.clear());
        assert!(store.records.is_empty());
        assert!(store.captures.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn store_load_and_save_never_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = owner_tempdir();
        let target = dir.path().join("target.json");
        std::fs::write(&target, b"sentinel").expect("target");
        let link = dir.path().join("known.json");
        symlink(&target, &link).expect("symlink");
        assert!(InvestigationTeamKnownAnswerStore::load(&link).is_err());
        assert!(InvestigationTeamKnownAnswerStore::default()
            .save(&link, &empty_store_revision())
            .is_err());
        assert_eq!(
            std::fs::read(&target).expect("target unchanged"),
            b"sentinel"
        );
    }

    #[cfg(unix)]
    #[test]
    fn store_requires_owner_only_parent_file_and_nofollow_ancestors() {
        use std::os::unix::fs::symlink;

        let root = owner_tempdir();
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).expect("parent");
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
            .expect("safe parent mode");
        let path = parent.join("known.json");
        InvestigationTeamKnownAnswerStore::default()
            .save(&path, &empty_store_revision())
            .expect("safe save");

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640))
            .expect("unsafe file mode");
        assert!(InvestigationTeamKnownAnswerStore::load(&path).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("restore file mode");
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o750))
            .expect("unsafe parent mode");
        assert!(InvestigationTeamKnownAnswerStore::load(&path).is_err());
        assert!(InvestigationTeamKnownAnswerStore::default()
            .save(&path, &empty_store_revision())
            .is_err());
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
            .expect("restore parent mode");

        let alias = root.path().join("parent-alias");
        symlink(&parent, &alias).expect("ancestor symlink");
        let alias_path = alias.join("known.json");
        assert!(InvestigationTeamKnownAnswerStore::load(&alias_path).is_err());
        assert!(InvestigationTeamKnownAnswerStore::default()
            .save(&alias_path, &empty_store_revision())
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn parent_replacement_before_cas_fails_without_committing_to_either_path() {
        let root = owner_tempdir();
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).expect("parent");
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))
            .expect("parent mode");
        let path = parent.join("known.json");
        let original = InvestigationTeamKnownAnswerStore::default();
        original
            .save(&path, &empty_store_revision())
            .expect("original save");
        let expected_revision = original.revision().expect("revision");
        let mut next = original.clone();
        next.publish_execution(captured_evidence())
            .expect("next evidence");
        let moved = root.path().join("moved-parent");

        let error = next
            .save_with_seams(
                &path,
                &expected_revision,
                |_| {
                    std::fs::rename(&parent, &moved)?;
                    std::fs::create_dir(&parent)?;
                    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700))?;
                    Ok(())
                },
                sync_parent_directory_after_replace,
            )
            .expect_err("parent replacement must fail before rename");
        assert!(error.to_string().contains("identity changed"));
        assert!(!path.exists(), "replacement parent must receive no store");
        assert_eq!(
            InvestigationTeamKnownAnswerStore::load(&moved.join("known.json"))
                .expect("original retained store"),
            original
        );
    }

    #[cfg(unix)]
    #[test]
    fn store_load_reads_the_open_inode_when_the_path_is_swapped() {
        use std::os::unix::fs::symlink;

        let mut expected = InvestigationTeamKnownAnswerStore::default();
        expected
            .publish_execution(captured_evidence())
            .expect("publish");
        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        expected
            .save(&path, &empty_store_revision())
            .expect("save original");
        let moved = dir.path().join("opened-original.json");
        let attacker = dir.path().join("attacker.json");
        std::fs::write(
            &attacker,
            serde_json::to_vec_pretty(&InvestigationTeamKnownAnswerStore::default())
                .expect("attacker store"),
        )
        .expect("write attacker store");

        let loaded = InvestigationTeamKnownAnswerStore::load_after_open(&path, |opened_path| {
            std::fs::rename(opened_path, &moved).expect("move opened inode");
            symlink(&attacker, opened_path).expect("swap pathname to symlink");
        });
        match loaded {
            Ok(loaded) => assert_eq!(loaded, expected, "must read the opened inode"),
            Err(error) => assert!(
                error.to_string().contains("metadata changed"),
                "path swap may fail closed only on stable-metadata validation: {error}",
            ),
        }
        assert!(InvestigationTeamKnownAnswerStore::load(&path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn post_replace_directory_sync_failure_is_committed_success_with_warning() {
        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        let mut committed = InvestigationTeamKnownAnswerStore::default();
        committed
            .publish_execution(captured_evidence())
            .expect("publish");
        let outcome = committed
            .save_with_seams(
                &path,
                &empty_store_revision(),
                |_| Ok(()),
                |_| Err(store_error("injected directory sync failure")),
            )
            .expect("rename is already committed");
        assert_eq!(
            outcome.durability_warning.as_deref(),
            Some(KNOWN_ANSWER_DURABILITY_WARNING)
        );
        assert_eq!(
            InvestigationTeamKnownAnswerStore::load(&path).expect("committed store"),
            committed
        );

        let mut live = InvestigationTeamKnownAnswerStoreState::Available(
            InvestigationTeamKnownAnswerStore::default(),
        );
        live.replace_with_committed(committed.clone());
        assert_eq!(live.store().expect("live committed state"), &committed);
    }

    #[cfg(not(unix))]
    #[test]
    fn entire_persistence_feature_fails_closed_before_any_file_use() {
        let mut store = InvestigationTeamKnownAnswerStore::default();
        store
            .publish_execution(captured_evidence())
            .expect("publish");
        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        assert!(ensure_known_answer_persistence_supported().is_err());
        assert!(InvestigationTeamKnownAnswerStore::load(&path).is_err());
        assert!(store.save(&path, &empty_store_revision()).is_err());
        assert!(execute_live_known_answer(
            vec![target()],
            1_777_000_000,
            "build-a".into(),
            &AtomicBool::new(false),
        )
        .is_err());
        assert!(
            !path.exists(),
            "fail-closed preflight must not touch storage"
        );
    }

    #[cfg(unix)]
    #[test]
    fn pre_replace_cas_blocks_malformed_and_changed_durable_store() {
        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        let mut original = InvestigationTeamKnownAnswerStore::default();
        original
            .publish_execution(captured_evidence())
            .expect("publish original");
        original
            .save(&path, &empty_store_revision())
            .expect("save original");
        let expected_revision = original.revision().expect("original revision");
        let mut next = original.clone();
        assert!(next.clear());

        let malformed = br#"{"schema_id":"invalid"}"#.to_vec();
        let error = next
            .save_with_seams(
                &path,
                &expected_revision,
                |durable_path| {
                    std::fs::write(durable_path, &malformed)?;
                    Ok(())
                },
                sync_parent_directory_after_replace,
            )
            .expect_err("malformed current store must block replacement");
        assert!(error.to_string().contains("malformed") || error.to_string().contains("schema"));
        assert_eq!(std::fs::read(&path).expect("malformed remains"), malformed);

        let changed = InvestigationTeamKnownAnswerStore::default();
        let changed_bytes = serde_json::to_vec_pretty(&changed).expect("changed store");
        let error = next
            .save_with_seams(
                &path,
                &expected_revision,
                |durable_path| {
                    std::fs::write(durable_path, &changed_bytes)?;
                    Ok(())
                },
                sync_parent_directory_after_replace,
            )
            .expect_err("changed current store must fail CAS");
        assert!(error.to_string().contains("changed"));
        assert_eq!(std::fs::read(&path).expect("winner remains"), changed_bytes);
    }

    #[cfg(unix)]
    #[test]
    fn malformed_existing_store_becomes_unavailable_and_blocks_all_access() {
        let dir = owner_tempdir();
        let path = dir.path().join("known.json");
        std::fs::write(&path, br#"{"schema_id":"invalid"}"#).expect("malformed store");
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .expect("owner-only malformed store");
        let mut state = InvestigationTeamKnownAnswerStoreState::from_load_result(
            InvestigationTeamKnownAnswerStore::load(&path),
        );
        let read_error = state.store().expect_err("read must remain blocked");
        assert!(read_error
            .to_string()
            .contains("existing evidence is unavailable"));
        assert_eq!(
            std::fs::read(&path).expect("invalid store remains untouched"),
            br#"{"schema_id":"invalid"}"#
        );

        assert!(state.reload_for_operation(&path).is_err());
        assert_eq!(
            std::fs::read(&path).expect("failed retry preserves invalid store"),
            br#"{"schema_id":"invalid"}"#
        );

        let repaired = serde_json::to_vec_pretty(&InvestigationTeamKnownAnswerStore::default())
            .expect("repaired store");
        std::fs::write(&path, &repaired).expect("operator repair");
        assert_eq!(
            state.reload_for_operation(&path).expect("repair reload"),
            &InvestigationTeamKnownAnswerStore::default()
        );

        std::fs::write(&path, br#"{"schema_id":"invalid-again"}"#).expect("second malformed store");
        assert!(state.reload_for_operation(&path).is_err());
        std::fs::remove_file(&path).expect("operator removal");
        assert_eq!(
            state.reload_for_operation(&path).expect("removal reload"),
            &InvestigationTeamKnownAnswerStore::default()
        );
    }
}
