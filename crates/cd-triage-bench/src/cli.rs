//! Offline CLI for the triage evaluation bench.

use crate::agreement::{
    build_agreement_views, project_all_share_safe, render_agreement_json,
    render_agreement_markdown, render_agreement_share_safe_json,
    render_agreement_share_safe_markdown,
};
use crate::canonical::to_pretty_json;
use crate::error::{BenchError, BenchResult};
use crate::import::{import_run, parse_import_json, parse_import_markdown, ImportOutcome};
use crate::report::{
    build_report_with_attribution, extract_owner_model_attribution, render_report_json,
    render_report_jsonl, render_report_markdown,
};
use crate::review::{blinded_run_view_from_raw, ReviewPhase};
use crate::store::BenchStore;
use crate::types::{
    Adjudication, Case, EvaluationTask, EvidenceSnapshot, PrivacyClass, SourceKind,
    MAX_RAW_INLINE_BYTES,
};
use clap::{Parser, Subcommand, ValueEnum};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "cd-triage-bench",
    about = "Headless incident-triage evaluation bench (offline, no GUI, no engine adapter)",
    long_about = "Create, import, and compare source-neutral triage evaluation records.\n\
This tool never contacts a network, reads a keychain, or writes ContextDesk\n\
qualification/readiness/routing state. ContextDesk SDK execution is out of scope."
)]
pub struct Cli {
    /// Library directory (file-backed store).
    #[arg(long, env = "CD_TRIAGE_BENCH_LIBRARY", global = true)]
    pub library: Option<PathBuf>,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Create a new empty library directory.
    Init,
    /// Import a case JSON record.
    ImportCase { file: PathBuf },
    /// Import an evidence snapshot JSON; hash and store --blob files first.
    ImportSnapshot {
        file: PathBuf,
        #[arg(long = "blob", value_name = "FILE")]
        blobs: Vec<PathBuf>,
    },
    /// Import an evaluation task JSON record.
    ImportTask { file: PathBuf },
    /// Import a human/web/other-product run (JSON or markdown template).
    ImportRun {
        file: PathBuf,
        #[arg(long)]
        raw: Option<PathBuf>,
    },
    /// Import an expert adjudication JSON record and derive score/review.
    ImportAdjudication { file: PathBuf },
    /// List stored record ids.
    List {
        #[arg(value_enum)]
        kind: ListKind,
    },
    /// Show one stored record as JSON.
    Show {
        #[arg(value_enum)]
        kind: ListKind,
        id: String,
    },
    /// Materialize a strategy-visible task packet (excludes case resolution).
    Packet { task_id: String },
    /// Show a blinded review view of a run (strategy identity masked when possible).
    BlindedRun { run_id: String },
    /// Materialize a blinded expert-review packet (support phase excludes resolution).
    ReviewPacket {
        run_id: String,
        #[arg(long, value_enum, default_value = "support")]
        phase: ReviewPhaseArg,
    },
    /// Reproducible comparison report over stored runs and adjudications.
    Report {
        #[arg(long, value_enum, default_value = "json")]
        format: ReportFormat,
        #[arg(long, value_enum, default_value = "owner-only")]
        privacy: ReportPrivacy,
        #[arg(long)]
        task: Option<String>,
    },
    /// Deterministic evidence-agreement projection over stored runs.
    ///
    /// Reports which strategies anchored a claim to the same snapshot evidence
    /// under the same causal role. Never compares claim text, never scores,
    /// ranks, or names a winner.
    Agreement {
        #[arg(long, value_enum, default_value = "json")]
        format: AgreementFormat,
        #[arg(long, value_enum, default_value = "owner-only")]
        privacy: ReportPrivacy,
        #[arg(long)]
        task: Option<String>,
    },
}

/// Output shapes for `agreement`. There is no JSONL form: the projection has
/// no per-record streaming semantics to define one against.
#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum AgreementFormat {
    Json,
    Markdown,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ListKind {
    Cases,
    Snapshots,
    Tasks,
    Runs,
    Adjudications,
    Scores,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ReportFormat {
    Json,
    Jsonl,
    Markdown,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ReportPrivacy {
    OwnerOnly,
    ShareSafe,
}

impl ReportPrivacy {
    fn class(self) -> PrivacyClass {
        match self {
            Self::OwnerOnly => PrivacyClass::OwnerOnly,
            Self::ShareSafe => PrivacyClass::ShareSafe,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ReviewPhaseArg {
    Support,
    Diagnosis,
}

impl From<ReviewPhaseArg> for ReviewPhase {
    fn from(value: ReviewPhaseArg) -> Self {
        match value {
            ReviewPhaseArg::Support => ReviewPhase::Support,
            ReviewPhaseArg::Diagnosis => ReviewPhase::Diagnosis,
        }
    }
}

pub fn run_cli<I, T>(args: I) -> BenchResult<String>
where
    I: IntoIterator<Item = T>,
    T: Into<std::ffi::OsString> + Clone,
{
    let cli = Cli::try_parse_from(args).map_err(|e| BenchError::Message(e.to_string()))?;
    dispatch(cli)
}

fn dispatch(cli: Cli) -> BenchResult<String> {
    match cli.command {
        Command::Init => {
            let root = require_library(cli.library)?;
            let created_at = "1970-01-01T00:00:00Z";
            // Wall-clock is not part of durable record identity. Init uses a
            // fixed timestamp so repeated init of an empty path stays stable
            // when the metadata file is identical; a populated path fails closed.
            BenchStore::init(&root, created_at)?;
            Ok(format!("initialized library at {}\n", root.display()))
        }
        Command::ImportCase { file } => {
            let store = open_store(cli.library)?;
            let case =
                parse_case(&fs::read_to_string(&file).map_err(|e| BenchError::io(&file, e))?)?;
            store.put_case(&case)?;
            Ok(format!("{}\n", case.case_id))
        }
        Command::ImportSnapshot { file, blobs } => {
            let store = open_store(cli.library)?;
            for blob in &blobs {
                let bytes = fs::read(blob).map_err(|e| BenchError::io(blob, e))?;
                store.put_blob(&bytes)?;
            }
            let snapshot =
                parse_snapshot(&fs::read_to_string(&file).map_err(|e| BenchError::io(&file, e))?)?;
            store.put_snapshot(&snapshot)?;
            Ok(format!("{}\n", snapshot.snapshot_id))
        }
        Command::ImportTask { file } => {
            let store = open_store(cli.library)?;
            let task =
                parse_task(&fs::read_to_string(&file).map_err(|e| BenchError::io(&file, e))?)?;
            store.put_task(&task)?;
            Ok(format!("{}\n", task.task_id))
        }
        Command::ImportRun { file, raw } => {
            let store = open_store(cli.library)?;
            let text = fs::read_to_string(&file).map_err(|e| BenchError::io(&file, e))?;
            let import = if file.extension().and_then(|e| e.to_str()) == Some("md")
                || text.contains("```json")
            {
                parse_import_markdown(&text)?.0
            } else {
                parse_import_json(&text)?
            };
            let raw_bytes = if let Some(path) = raw {
                read_bounded_regular_file(&path, MAX_RAW_INLINE_BYTES as u64)?
            } else if let Some(inline) = &import.raw_output_utf8 {
                inline.as_bytes().to_vec()
            } else {
                return Err(BenchError::Schema(
                    "import-run requires --raw or raw_output_utf8 / markdown body".into(),
                ));
            };
            match import_run(&store, &import, &raw_bytes)? {
                ImportOutcome::Created {
                    run_id,
                    near_duplicate_of,
                } => {
                    let extra = near_duplicate_of
                        .map(|id| format!(" near_duplicate_of={id}"))
                        .unwrap_or_default();
                    Ok(format!("created {run_id}{extra}\n"))
                }
                ImportOutcome::Duplicate { run_id } => Ok(format!("duplicate {run_id}\n")),
            }
        }
        Command::ImportAdjudication { file } => {
            let store = open_store(cli.library)?;
            let adj = parse_adjudication(
                &fs::read_to_string(&file).map_err(|e| BenchError::io(&file, e))?,
            )?;
            let score = store.import_adjudication(adj)?;
            Ok(format!("{} {}\n", score.adjudication_id, score.score_id))
        }
        Command::List { kind } => {
            let store = open_store(cli.library)?;
            let ids = match kind {
                ListKind::Cases => store.list_cases()?,
                ListKind::Snapshots => store.list_snapshots()?,
                ListKind::Tasks => store.list_tasks()?,
                ListKind::Runs => store.list_runs()?,
                ListKind::Adjudications => store.list_adjudications()?,
                ListKind::Scores => store.list_scores()?,
            };
            Ok(ids.join("\n") + if ids.is_empty() { "" } else { "\n" })
        }
        Command::Show { kind, id } => {
            let store = open_store(cli.library)?;
            match kind {
                ListKind::Cases => to_pretty_json(&store.get_case(&id)?),
                ListKind::Snapshots => to_pretty_json(&store.get_snapshot(&id)?),
                ListKind::Tasks => to_pretty_json(&store.get_task(&id)?),
                ListKind::Runs => to_pretty_json(&store.get_run(&id)?),
                ListKind::Adjudications => to_pretty_json(&store.get_adjudication(&id)?),
                ListKind::Scores => to_pretty_json(&store.get_score(&id)?),
            }
        }
        Command::Packet { task_id } => {
            let store = open_store(cli.library)?;
            to_pretty_json(&store.materialize_packet(&task_id)?)
        }
        Command::BlindedRun { run_id } => {
            let store = open_store(cli.library)?;
            let run = store.get_run(&run_id)?;
            let raw =
                store.get_blob_bounded(&run.raw_output.digest.hex, MAX_RAW_INLINE_BYTES as u64)?;
            to_pretty_json(&blinded_run_view_from_raw(&run, Some(raw.as_slice())))
        }
        Command::ReviewPacket { run_id, phase } => {
            let store = open_store(cli.library)?;
            to_pretty_json(&store.materialize_review_packet(&run_id, phase.into())?)
        }
        Command::Report {
            format,
            privacy,
            task,
        } => {
            let store = open_store(cli.library)?;
            let mut runs = store.load_runs()?;
            if let Some(task_id) = task {
                runs.retain(|r| r.task_id == task_id);
            }
            // Attribution is a proof-bound fact, not a rendering convenience:
            // only a ContextDesk SDK row can carry the adapter's owner-only
            // envelope, so an imported human/web/other-product row never
            // contributes a model identity to the report.
            let attribution = runs
                .iter()
                .filter(|run| run.source_kind == SourceKind::ContextdeskSdk)
                .filter_map(|run| {
                    let raw = store
                        .get_blob_bounded(&run.raw_output.digest.hex, MAX_RAW_INLINE_BYTES as u64)
                        .ok()?;
                    Some((run.run_id.clone(), extract_owner_model_attribution(&raw)?))
                })
                .collect::<BTreeMap<_, _>>();
            let report = build_report_with_attribution(
                &runs,
                &store.load_adjudications()?,
                &store.load_scores()?,
                &store.load_cases()?,
                &attribution,
                privacy.class(),
            )?;
            match format {
                ReportFormat::Json => render_report_json(&report),
                ReportFormat::Jsonl => render_report_jsonl(&report),
                ReportFormat::Markdown => render_report_markdown(&report),
            }
        }
        Command::Agreement {
            format,
            privacy,
            task,
        } => {
            let store = open_store(cli.library)?;
            let mut runs = store.load_runs()?;
            if let Some(task_id) = &task {
                runs.retain(|run| &run.task_id == task_id);
            }
            let tasks = store
                .list_tasks()?
                .iter()
                .map(|task_id| store.get_task(task_id))
                .collect::<BenchResult<Vec<_>>>()?;
            // Only ContextDesk SDK rows carry the owner-only replay envelope.
            // A blob that cannot be read is deliberately left absent: the
            // projection then names that row excluded rather than crediting it
            // with an empty claim set.
            let mut raw_outputs = BTreeMap::new();
            for run in &runs {
                if run.source_kind != SourceKind::ContextdeskSdk {
                    continue;
                }
                if let Ok(bytes) =
                    store.get_blob_bounded(&run.raw_output.digest.hex, MAX_RAW_INLINE_BYTES as u64)
                {
                    raw_outputs.insert(run.run_id.clone(), bytes);
                }
            }
            let views = build_agreement_views(&runs, &tasks, &raw_outputs)?;
            match (format, privacy) {
                (AgreementFormat::Json, ReportPrivacy::OwnerOnly) => render_agreement_json(&views),
                (AgreementFormat::Markdown, ReportPrivacy::OwnerOnly) => {
                    render_agreement_markdown(&views)
                }
                (AgreementFormat::Json, ReportPrivacy::ShareSafe) => {
                    render_agreement_share_safe_json(&project_all_share_safe(&views)?)
                }
                (AgreementFormat::Markdown, ReportPrivacy::ShareSafe) => {
                    render_agreement_share_safe_markdown(&project_all_share_safe(&views)?)
                }
            }
        }
    }
}

fn read_bounded_regular_file(path: &PathBuf, max_bytes: u64) -> BenchResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|e| BenchError::io(path, e))?;
    if !metadata.file_type().is_file() {
        return Err(BenchError::Schema(
            "raw output must be a regular file".into(),
        ));
    }
    if metadata.len() > max_bytes {
        return Err(BenchError::BlobTooLarge {
            digest: "raw-output".into(),
            declared_bytes: metadata.len(),
            max_bytes,
        });
    }
    let mut file = fs::File::open(path).map_err(|e| BenchError::io(path, e))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| BenchError::io(path, e))?;
    if bytes.len() as u64 > max_bytes {
        return Err(BenchError::BlobTooLarge {
            digest: "raw-output".into(),
            declared_bytes: bytes.len() as u64,
            max_bytes,
        });
    }
    Ok(bytes)
}

fn require_library(library: Option<PathBuf>) -> BenchResult<PathBuf> {
    library.ok_or_else(|| BenchError::Message("--library is required".into()))
}

fn open_store(library: Option<PathBuf>) -> BenchResult<BenchStore> {
    BenchStore::open(require_library(library)?)
}

fn parse_case(text: &str) -> BenchResult<Case> {
    Case::parse_json(text)
}

fn parse_snapshot(text: &str) -> BenchResult<EvidenceSnapshot> {
    EvidenceSnapshot::parse_import_json(text)
}

fn parse_task(text: &str) -> BenchResult<EvaluationTask> {
    EvaluationTask::parse_import_json(text)
}

fn parse_adjudication(text: &str) -> BenchResult<Adjudication> {
    Adjudication::parse_import_json(text)
}

pub fn main_from_env() -> i32 {
    match run_cli(std::env::args_os()) {
        Ok(out) => {
            print!("{out}");
            0
        }
        Err(err) => {
            eprintln!("{err}");
            err.exit_code()
        }
    }
}
