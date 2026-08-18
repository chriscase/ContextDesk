//! Thin file-backed integration for the pure public-SDK adapter.
//!
//! The adapter crate itself remains free of filesystem and store concerns.
//! This binary is the explicit bench-owned integration boundary: it loads a
//! case/task/snapshot from `BenchStore`, runs the default deterministic mock,
//! writes only a bench `TriageRun` plus its owner-only raw blob, and never
//! writes ContextDesk case, adjudication, score, qualification, readiness,
//! routing, or private-store state.

use cd_triage_bench::store::PutRunOutcome;
use cd_triage_bench::BenchStore;
use cd_triage_bench_adapter::{
    decode_replay_json, materialize_bounded_packet, record_public_replay, run_offline,
    MockEnginePlan, MockSlotOutcome, MockSlotPlan, MockTerminalPlan, MockValidation,
    RecordingContext,
};
use cd_triage_sdk::{ModelRef, TriagePolicySelectionV2, TriageSlotKindV2, MAX_TRIAGE_WIRE_BYTES};
use clap::{Parser, Subcommand, ValueEnum};
use std::fs;
use std::path::{Path, PathBuf};

const MOCK_PROFILE: &str = "profile:mock-gateway";
const MOCK_MODEL: &str = "mock-finalizer-v1";

#[derive(Debug, Parser)]
#[command(
    name = "cd-triage-bench-adapter",
    about = "Run the ContextDesk public-SDK mock against a bench task (offline)"
)]
struct Cli {
    /// File-backed bench library created by `cd-triage-bench`.
    #[arg(long, env = "CD_TRIAGE_BENCH_LIBRARY")]
    library: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Execute a stored task and persist its owner-only bench run.
    Run {
        /// Stored evaluation task id.
        task_id: String,
        /// Deterministic terminal to record.
        #[arg(long, value_enum, default_value = "completed")]
        script: Script,
        /// Explicit operator label; no environment or identity is inferred.
        #[arg(long, default_value = "adapter-cli")]
        operator: String,
        /// Explicit RFC3339 creation time; durable identity never reads a clock.
        #[arg(long, default_value = "2026-01-15T08:00:00Z")]
        created_at: String,
    },
    /// Ingest an owner-only public-SDK replay JSON. This is not live execution.
    RecordReplay {
        /// Stored evaluation task id.
        task_id: String,
        /// Bounded regular file holding a `TriageReplayV1` JSON object.
        #[arg(long)]
        replay: PathBuf,
        /// Explicit operator label; no environment or identity is inferred.
        #[arg(long, default_value = "adapter-cli")]
        operator: String,
        /// Explicit RFC3339 creation time; durable identity never reads a clock.
        #[arg(long, default_value = "2026-01-15T08:00:00Z")]
        created_at: String,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum Script {
    Completed,
    Partial,
    Failed,
    TimedOut,
    Cancelled,
    PreflightRejected,
}

impl Script {
    fn plan(self) -> (MockSlotOutcome, MockTerminalPlan, Option<MockValidation>) {
        match self {
            Self::Completed => (
                MockSlotOutcome::completed(),
                MockTerminalPlan::Completed,
                Some(MockValidation {
                    passed: true,
                    reason_codes: Vec::new(),
                }),
            ),
            Self::Partial => (
                MockSlotOutcome::Abstained,
                MockTerminalPlan::CompletedPartial,
                Some(MockValidation {
                    passed: false,
                    reason_codes: vec!["mock_partial".into()],
                }),
            ),
            Self::Failed => (
                MockSlotOutcome::Failed,
                MockTerminalPlan::Failed {
                    category: "mock_failed".into(),
                    partial_result: true,
                },
                Some(MockValidation {
                    passed: false,
                    reason_codes: vec!["mock_failed".into()],
                }),
            ),
            Self::TimedOut => (
                MockSlotOutcome::TimedOut,
                MockTerminalPlan::TimedOut {
                    category: "mock_timed_out".into(),
                    partial_result: true,
                },
                Some(MockValidation {
                    passed: false,
                    reason_codes: vec!["mock_timed_out".into()],
                }),
            ),
            Self::Cancelled => (
                MockSlotOutcome::Cancelled,
                MockTerminalPlan::Cancelled {
                    partial_result: true,
                },
                None,
            ),
            Self::PreflightRejected => (
                MockSlotOutcome::NotAdmitted,
                MockTerminalPlan::Failed {
                    category: "preflight_rejected".into(),
                    partial_result: false,
                },
                Some(MockValidation {
                    passed: false,
                    reason_codes: vec!["preflight_rejected".into()],
                }),
            ),
        }
    }
}

fn main() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command {
        Command::Run {
            task_id,
            script,
            operator,
            created_at,
        } => run(cli.library, task_id, script, operator, created_at),
        Command::RecordReplay {
            task_id,
            replay,
            operator,
            created_at,
        } => record_replay(cli.library, task_id, replay, operator, created_at),
    }
}

fn run(
    library: PathBuf,
    task_id: String,
    script: Script,
    operator: String,
    created_at: String,
) -> Result<(), String> {
    let store = BenchStore::open(library).map_err(|error| error.to_string())?;
    let task = store
        .get_task(&task_id)
        .map_err(|error| error.to_string())?;
    let case = store
        .get_case(&task.case_id)
        .map_err(|error| error.to_string())?;
    let snapshot = store
        .get_snapshot(&task.snapshot_id)
        .map_err(|error| error.to_string())?;
    let (slot_outcome, terminal, validation) = script.plan();
    let model = ModelRef {
        profile_id: MOCK_PROFILE.into(),
        model_id: MOCK_MODEL.into(),
    };
    let plan = MockEnginePlan {
        slots: vec![MockSlotPlan {
            role_slot_id: "standard-finalizer".into(),
            role: TriageSlotKindV2::Finalizer,
            model,
            outcome: slot_outcome,
        }],
        validation,
        correction: None,
        terminal,
    };
    let context = RecordingContext {
        strategy: cd_triage_bench::StrategyIdentity {
            name: "contextdesk-sdk".into(),
            version: cd_triage_bench::Observed::Known("public-contract-v2".into()),
            build: cd_triage_bench::Observed::Known("mock".into()),
        },
        operator,
        created_at,
    };
    let run = run_offline(
        &case,
        &snapshot,
        &task,
        cli_policy(),
        Default::default(),
        &cli_cancellation(&task.task_id),
        &plan,
        &context,
    )
    .map_err(|error| error.to_string())?;
    persist_recorded(&store, &run.recorded)
}

fn record_replay(
    library: PathBuf,
    task_id: String,
    replay_path: PathBuf,
    operator: String,
    created_at: String,
) -> Result<(), String> {
    let store = BenchStore::open(library).map_err(|error| error.to_string())?;
    let task = store
        .get_task(&task_id)
        .map_err(|error| error.to_string())?;
    let case = store
        .get_case(&task.case_id)
        .map_err(|error| error.to_string())?;
    let snapshot = store
        .get_snapshot(&task.snapshot_id)
        .map_err(|error| error.to_string())?;
    let bytes = read_bounded_regular_file(&replay_path)?;
    let replay = decode_replay_json(&bytes).map_err(|error| error.to_string())?;
    let bounded =
        materialize_bounded_packet(&case, &snapshot, &task).map_err(|error| error.to_string())?;
    let bound = cd_triage_bench_adapter::build_request(
        &snapshot,
        &task,
        &bounded,
        cli_policy(),
        Default::default(),
        &cli_cancellation(&task.task_id),
    )
    .map_err(|error| error.to_string())?;
    let recorded = record_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        replay,
        &RecordingContext {
            strategy: cd_triage_bench::StrategyIdentity {
                name: "contextdesk-sdk".into(),
                version: cd_triage_bench::Observed::Known("public-contract-v2".into()),
                build: cd_triage_bench::Observed::Known("replay-ingest".into()),
            },
            operator,
            created_at,
        },
    )
    .map_err(|error| error.to_string())?;
    persist_recorded(&store, &recorded)
}

fn cli_policy() -> TriagePolicySelectionV2 {
    TriagePolicySelectionV2::Standard {
        model: ModelRef {
            profile_id: MOCK_PROFILE.into(),
            model_id: MOCK_MODEL.into(),
        },
    }
}

fn cli_cancellation(task_id: &str) -> String {
    format!("cancel-{task_id}")
}

fn read_bounded_regular_file(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.len() > MAX_TRIAGE_WIRE_BYTES as u64 {
        return Err(format!(
            "{} exceeds the public SDK wire bound of {MAX_TRIAGE_WIRE_BYTES} bytes",
            path.display()
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if bytes.len() > MAX_TRIAGE_WIRE_BYTES {
        return Err(format!(
            "{} exceeds the public SDK wire bound of {MAX_TRIAGE_WIRE_BYTES} bytes",
            path.display()
        ));
    }
    Ok(bytes)
}

fn persist_recorded(
    store: &BenchStore,
    recorded: &cd_triage_bench_adapter::RecordedContextDeskRun,
) -> Result<(), String> {
    let raw_digest = store
        .put_blob(&recorded.raw_output)
        .map_err(|error| error.to_string())?;
    let outcome = store
        .put_run(&recorded.bench_run)
        .map_err(|error| error.to_string())?;
    let status = recorded.bench_run.status.as_str();
    match outcome {
        PutRunOutcome::Created { run_id } => {
            println!("created {run_id} status={status} raw={}", raw_digest.wire())
        }
        PutRunOutcome::Duplicate { run_id } => {
            println!(
                "duplicate {run_id} status={status} raw={}",
                raw_digest.wire()
            )
        }
    }
    Ok(())
}
