//! Command grammar. This module only describes shape (clap derive structs)
//! — no I/O, no `cd_core`/`cd_workflow` calls. `main.rs` maps each variant
//! to a handler in `commands/`.

use crate::config::{ColorMode, OutputFormat};
use clap::{Parser, Subcommand};
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "contextdesk",
    version = env!("CARGO_PKG_VERSION"),
    // build.rs embeds git SHA / describe / channel (CD_GIT_* / CD_CHANNEL).
    long_version = env!("CD_CLI_LONG_VERSION"),
    about = "ContextDesk CLI — import evidence, then ask questions grounded in it",
    long_about = "After configuration and import, ask directly:\n\n  contextdesk \"What caused the outage?\"\n\nThis is a safe shorthand for the production chat workflow using the active\ncorpus and provider. Explicit `contextdesk chat` and `contextdesk ask` remain\navailable for corpus/session overrides and automation.",
    override_usage = "contextdesk [OPTIONS] <COMMAND>\n       contextdesk [OPTIONS] <QUESTION...>",
    after_help = "Examples:\n  contextdesk config init\n  contextdesk import ./logs\n  contextdesk \"What caused the outage?\"\n  contextdesk ask \"Compare the first symptom with the likely trigger\" --trace summary\n  contextdesk chat \"Show the evidence\" --jsonl\n\nQuote multi-word questions in your shell. Use an explicit `chat` or `ask` when\na question starts with a command name such as `import`."
)]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalArgs,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Clone, clap::Args)]
pub struct GlobalArgs {
    /// Output shape: human-readable text, one JSON envelope, or (for
    /// streaming commands) one JSON object per line.
    #[arg(long, global = true, env = "CONTEXTDESK_FORMAT")]
    pub format: Option<OutputFormat>,
    /// Shorthand for `--format json`.
    #[arg(long, global = true, conflicts_with = "format")]
    pub json: bool,
    /// Shorthand for `--format jsonl`.
    #[arg(long, global = true, conflicts_with = "format")]
    pub jsonl: bool,
    #[arg(long, global = true, env = "CONTEXTDESK_COLOR")]
    pub color: Option<ColorMode>,
    /// Disable ANSI color for this invocation (equivalent to `--color never`).
    /// This explicit flag wins over ambient terminal detection and is useful
    /// for CI/log capture without requiring an environment variable.
    #[arg(long, global = true, conflicts_with = "color")]
    pub no_color: bool,
    /// Project config path — takes the place of the auto-discovered
    /// `.contextdesk.toml` in the current directory (see `docs/CLI.md`
    /// precedence). Does not affect the shared `AppConfig` path; use
    /// `--app-config` for that.
    #[arg(long, global = true, env = "CONTEXTDESK_CONFIG")]
    pub config: Option<PathBuf>,
    /// Override the shared `AppConfig` file (provider profiles, configured
    /// default timezone) instead of the default
    /// `~/.contextdesk/config.json` both hosts otherwise share (or, when
    /// `--data-dir` is also given, `<data-dir>/config.json`) — used as an
    /// exact path, not joined with `--data-dir`.
    #[arg(long, global = true, env = "CONTEXTDESK_APP_CONFIG")]
    pub app_config: Option<PathBuf>,
    /// Isolate every piece of state this process touches — the shared
    /// `AppConfig`, this CLI's own `cli.toml`, the corpus cache, durable
    /// sessions, and CLI state — under this directory instead of the
    /// default `~/.contextdesk` the desktop app otherwise shares. Setting
    /// this skips the `$HOME` lookup entirely, so an isolated profile is
    /// deterministic and testable without overriding `HOME`. Omit to keep
    /// the default: state shared with the desktop app.
    #[arg(
        long,
        global = true,
        alias = "profile-dir",
        env = "CONTEXTDESK_DATA_DIR"
    )]
    pub data_dir: Option<PathBuf>,
    #[arg(long, global = true, env = "CONTEXTDESK_PROVIDER_PROFILE")]
    pub profile: Option<String>,
    #[arg(long, global = true, env = "CONTEXTDESK_CHAT_MODEL")]
    pub model: Option<String>,
    /// Non-persistent whole-turn deadline for this chat turn only
    /// (`90s`, `3m`, `10m`, `500ms`). Never writes AppConfig. Global so
    /// direct-question form (`contextdesk --deadline 10m "…"`) works.
    /// Precedence: this override > saved explicit policy > adaptive policy.
    #[arg(long, global = true, value_name = "DURATION")]
    pub deadline: Option<String>,
    /// Non-persistent reasoning-effort for this chat turn only
    /// (`none`/`low`/`medium`/`high`/`xhigh`/`max`). Never writes AppConfig.
    /// Omit the flag for the saved policy (or provider default when unset).
    /// Affects cost/latency; **not** a readiness badge.
    #[arg(long, global = true, value_name = "LEVEL", alias = "effort")]
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Import an archive or directory of logs into a new corpus — no
    /// per-file selection required for a normal import.
    Import(ImportArgs),
    /// Offline normalize selected sources to `contextdesk.normalized_log_events.v1`
    /// JSONL (zero provider / keychain). Does not persist a durable corpus.
    Normalize(NormalizeArgs),
    /// Validate or summarize normalized JSONL files without importing them.
    /// Entirely offline: no provider, keychain, or durable corpus.
    Normalized {
        #[command(subcommand)]
        action: NormalizedAction,
    },
    /// Manage imported corpora.
    Corpus {
        #[command(subcommand)]
        action: CorpusAction,
    },
    /// Review and declare source timezones for ambiguous local timestamps.
    Timezone {
        #[command(subcommand)]
        action: TimezoneAction,
    },
    /// Search an imported corpus.
    #[command(visible_alias = "search")]
    Explore(ExploreArgs),
    /// Assemble grounded evidence + citations for a question without
    /// running a model turn.
    Context(ContextArgs),
    /// Durable chat sessions.
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },
    /// Ask a question, grounded in the current (or given) corpus.
    #[command(visible_alias = "ask")]
    Chat(ChatArgs),
    /// CLI configuration.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Optional Confluence connector (status / search / get-page).
    ///
    /// Uses the shared AppConfig + keychain ref only — same contract as the
    /// desktop host. Disabled / keyless profiles perform zero secret-store
    /// reads and offer no tools.
    Confluence {
        #[command(subcommand)]
        action: ConfluenceAction,
    },
    /// Machine-readable description of this build: supported commands,
    /// envelope schema version, exit-code categories.
    Capabilities,
    /// Readiness check: is everything ready for a demonstration right now?
    /// Checks configuration, provider connectivity, native tool calling,
    /// grounding, writable isolated state, tracing, and session
    /// continuity — the last four by actually running one real, disposable
    /// two-turn chat exercise against the configured provider, over a
    /// synthetic corpus created and destroyed for this check alone. Exit
    /// code reflects the verdict, not just whether the command itself ran.
    Doctor(DoctorArgs),
    /// Deterministic logging-quality assessment with fixed finding-code
    /// improvement hints for an imported corpus (no provider / LLM).
    #[command(visible_alias = "assess")]
    LoggingAssessment(LoggingAssessmentArgs),
    /// Deterministic exception episode / duplicate-rendering correlation
    /// for an imported corpus (no provider / LLM). Does not rewrite events.
    #[command(visible_alias = "episodes")]
    ExceptionEpisodes(ExceptionEpisodesArgs),
    /// Optional retrieval-role diagnostics (embedding / reranking):
    /// configured state, optional live health probe, and the retrieval mode
    /// configuration would select (no provider / LLM).
    RetrievalStatus(RetrievalStatusArgs),
    /// Compare executable retrieval lanes over one imported corpus under fixed
    /// budgets, using the production search path. Dry run by default; measures
    /// retrieval only and never claims answer usefulness or readiness.
    #[command(visible_alias = "retrieval-diagnostic")]
    RetrievalDiagnose(RetrievalDiagnoseArgs),
    /// Rebuild an existing corpus's template vectors under the configured
    /// embedding space. Dry run by default; states where the work runs and
    /// whether log content leaves this machine before anything happens.
    #[command(visible_alias = "reanalyze")]
    RetrievalReanalyze(RetrievalReanalyzeArgs),
    /// Discover gateway models and show or verify role-specific compatibility.
    /// Bare `models` is entirely offline and never reads credentials.
    Models(ModelsArgs),
    /// Hermetic quality-evaluation fixtures (offline, no credentials, no network).
    /// Does not measure live model usefulness or compatibility readiness.
    Eval {
        #[command(subcommand)]
        action: EvalAction,
    },
    /// Validate/compile an explicit Triage Policy V2 offline, or qualify one
    /// exact role against the configured gateway.
    TriagePolicy {
        #[command(subcommand)]
        action: TriagePolicyAction,
    },
    /// Run one versioned Triage SDK request.
    ///
    /// Standard, Enhanced, and Advanced requests execute through the same
    /// trusted production host and return the shared replay contract.
    Triage {
        #[command(subcommand)]
        action: TriageAction,
    },
    /// Run bounded live candidates against one exact benchmark snapshot.
    ///
    /// This is a host-only command. It loads the explicit benchmark library,
    /// the shared policy and qualification stores, and the desktop-shared
    /// credential adapter before calling the live comparison bridge. It does
    /// not rank candidates or expose the offline bench crate to providers.
    BenchCompare(BenchCompareArgs),
    /// Provider-neutral gateway/model diagnostics for one explicitly selected model.
    Gateway {
        #[command(subcommand)]
        action: GatewayAction,
    },
}

/// Subcommands under `contextdesk gateway`.
#[derive(Debug, Subcommand)]
pub enum GatewayAction {
    /// Bounded direct-provider vs product-path differential for one exact
    /// model: reuses capability qualification, the real chat workflow, and
    /// existing triage scoring — never a second HTTP client or simulated
    /// pipeline. Shows planned checks and request/time bounds and requires
    /// confirmation (or `--yes`) before any network call.
    Diagnose(GatewayDiagnoseArgs),
    /// Offline cost/reliability ledger comparison over share-safe diagnostic
    /// bundles and documented historical benchmark rows. Never makes live
    /// gateway calls and never emits readiness claims from aggregates.
    Ledger(GatewayLedgerArgs),
}

/// Options for `contextdesk gateway ledger`.
#[derive(Debug, Clone, clap::Args)]
pub struct GatewayLedgerArgs {
    /// Share-safe diagnostic bundle directory (`report.json` + verified
    /// `manifest.json`), a report JSON file, or a documented historical row
    /// JSON file. Repeatable.
    #[arg(long = "input", required = true)]
    pub inputs: Vec<PathBuf>,
    /// Optional path to write the share-safe comparison JSON report.
    #[arg(long)]
    pub out: Option<PathBuf>,
}

/// Diagnostic depth. `Basic` is the only default; `Extended` must be chosen
/// explicitly — this command never implicitly probes an entire catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum DiagnoseLevel {
    #[default]
    Basic,
    Extended,
}

#[derive(Debug, Clone, clap::Args)]
pub struct GatewayDiagnoseArgs {
    /// Diagnostic depth. `basic` (default) runs one bounded case set.
    /// `extended` additionally re-runs each product-path case once more to
    /// observe retry/correction stability. Never implicitly expands to the
    /// full model catalog.
    #[arg(long, value_enum, default_value_t = DiagnoseLevel::Basic)]
    pub level: DiagnoseLevel,
    /// Skip the interactive consent prompt (required in non-interactive use,
    /// e.g. CI). The planned checks, request bound, and deadline are always
    /// shown first regardless of this flag.
    #[arg(long)]
    pub yes: bool,
    /// Bound the whole operation's wall-clock time, in seconds. Default 180.
    #[arg(long)]
    pub timeout: Option<u64>,
    /// Also write an owner-only, local-only private capture containing
    /// bounded synthetic request/response bodies and sanitized wire events
    /// (never credentials). Requires explicit acknowledgement via
    /// `--raw-i-understand`. Never included in the default share-safe
    /// bundle.
    #[arg(long, requires = "raw_i_understand")]
    pub raw: bool,
    /// Explicit acknowledgement required together with `--raw`.
    #[arg(long)]
    pub raw_i_understand: bool,
    /// Directory to write the versioned diagnostic bundle into (default:
    /// isolated cache dir under `gateway-diagnostics/<run-id>/`).
    #[arg(long)]
    pub out: Option<PathBuf>,
}

/// Subcommands under `contextdesk eval`.
#[derive(Debug, Subcommand)]
pub enum EvalAction {
    /// List bundled OPEN quality-evaluation suites (paths relative only).
    Suites,
    /// Validate suite isolation and compute the content digest.
    Validate(EvalValidateArgs),
    /// Run the hermetic suite and print a report (optionally write JSON/JSONL).
    Run(EvalRunArgs),
}

/// Provider-free Triage Policy V2 actions.
#[derive(Debug, Subcommand)]
pub enum TriagePolicyAction {
    /// Validate one inline policy against explicit host preflight facts.
    Validate(TriagePolicyFileArgs),
    /// Compile one inline policy into its deterministic sequential plan.
    Compile(TriagePolicyFileArgs),
    /// Print a safe Standard-policy example with placeholder identities.
    Example,
    /// Manage an explicit, non-secret saved-policy store without loading app
    /// configuration or credentials.
    Store {
        #[command(subcommand)]
        action: TriagePolicyStoreAction,
    },
    /// Run one synthetic exact-role qualification against the configured
    /// gateway and save the host-authored result to the local role store.
    Qualify(TriageRoleQualificationArgs),
}

/// Explicit selection for one Triage Policy V2 role qualification probe.
#[derive(Debug, Clone, clap::Args)]
pub struct TriageRoleQualificationArgs {
    /// Exact configured provider profile id.
    #[arg(long, required = true)]
    pub profile: String,
    /// Exact catalog model id; no name shortening or inference is performed.
    #[arg(long, required = true)]
    pub model: String,
    /// Exact V2 role contract to probe.
    #[arg(long, value_enum)]
    pub role: TriageRoleQualificationRole,
    /// Whole synthetic probe deadline in milliseconds.
    #[arg(long, default_value_t = 300_000)]
    pub deadline_ms: u64,
    /// Confirm that this command will make one bounded provider request (when
    /// the selected role is implemented) and update local evidence.
    #[arg(long)]
    pub yes: bool,
}

/// CLI spelling of the exact V2 role kinds.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum TriageRoleQualificationRole {
    ObservationExtractor,
    TimelineAnalyst,
    CausalProposer,
    ContradictionChecker,
    EvidenceGapFinder,
    Finalizer,
    Reviewer,
}

impl TriageRoleQualificationRole {
    /// Convert the user selection to the provider-neutral policy kind.
    pub fn kind(self) -> cd_core::multi_model::triage_policy::TriageSlotKindV2 {
        use cd_core::multi_model::triage_policy::{
            TriageContributorRole as C, TriageSlotKindV2 as K,
        };
        match self {
            Self::ObservationExtractor => K::Contributor(C::ObservationExtractor),
            Self::TimelineAnalyst => K::Contributor(C::TimelineAnalyst),
            Self::CausalProposer => K::Contributor(C::CausalProposer),
            Self::ContradictionChecker => K::Contributor(C::ContradictionChecker),
            Self::EvidenceGapFinder => K::Contributor(C::EvidenceGapFinder),
            Self::Finalizer => K::Finalizer,
            Self::Reviewer => K::Reviewer,
        }
    }
}

/// Provider-neutral Triage SDK actions.
#[derive(Debug, Subcommand)]
pub enum TriageAction {
    /// Run one explicit TriageRequestV2 JSON document.
    Run(TriageRunArgs),
}

/// Explicit request input for `contextdesk triage run`.
#[derive(Debug, Clone, clap::Args)]
pub struct TriageRunArgs {
    /// JSON file containing one `contextdesk.triage.request.v2` request.
    /// Use `-` to read the bounded request body from stdin.
    #[arg(long, visible_alias = "input", value_name = "FILE")]
    pub request: PathBuf,
    /// Deprecated execution input. A caller-supplied preflight is accepted
    /// only by provider-free `triage-policy validate/compile`; `triage run`
    /// rejects it because the CLI cannot prove its authorship.
    #[arg(long, value_name = "FILE")]
    pub preflight: Option<PathBuf>,
    /// Host-neutral request parsed before any application state is resolved.
    /// This also makes bounded stdin requests single-read while preserving the
    /// state-free malformed-input boundary.
    #[arg(skip)]
    pub(crate) parsed_request: Option<cd_core::triage_sdk::TriageRequestV2>,
}

/// Explicit inputs for `contextdesk bench-compare`.
#[derive(Debug, Clone, clap::Args)]
pub struct BenchCompareArgs {
    /// Existing benchmark library directory containing the task, case,
    /// snapshot, and verified content-addressed blobs.
    #[arg(long, value_name = "DIR", required = true)]
    pub library: PathBuf,
    /// Exact evaluation task identity stored in `--library`.
    #[arg(long, value_name = "TASK", required = true)]
    pub task: String,
    /// Bounded JSON candidate specification. Repeat for each candidate; two
    /// or more are required for a comparison.
    #[arg(long = "candidate", value_name = "FILE", required = true)]
    pub candidates: Vec<PathBuf>,
    /// Isolated cache root for the run-exclusive ContextDesk corpus. Defaults
    /// to the normal CLI cache root.
    #[arg(long, value_name = "DIR")]
    pub cache_root: Option<PathBuf>,
    /// Maximum bytes copied from one visible benchmark blob.
    #[arg(long, default_value_t = cd_triage_bench_live::DEFAULT_LIVE_MAX_BLOB_BYTES)]
    pub max_blob_bytes: u64,
    /// Maximum aggregate visible bytes copied for this comparison.
    #[arg(
        long,
        default_value_t = cd_triage_bench_live::DEFAULT_LIVE_MAX_AGGREGATE_BYTES
    )]
    pub max_aggregate_bytes: u64,
}

/// Explicit-file operations for the revisioned Triage Policy V2 store.
#[derive(Debug, Subcommand)]
pub enum TriagePolicyStoreAction {
    /// List saved policy identities and the current explicit selection.
    List(TriagePolicyStoreFileArgs),
    /// Save a policy JSON document and select it, incrementing its revision.
    Save(TriagePolicyStoreSaveArgs),
    /// Select an existing policy without changing its body.
    Select(TriagePolicyStoreSelectArgs),
    /// Clear the opt-in selection; Standard remains the safe default.
    Clear(TriagePolicyStoreFileArgs),
}

/// Explicit path to one non-secret policy store.
#[derive(Debug, Clone, clap::Args)]
pub struct TriagePolicyStoreFileArgs {
    /// Store JSON path. The file is not inferred from app configuration.
    #[arg(long, value_name = "FILE")]
    pub store: PathBuf,
}

/// Save one policy JSON document into an explicit store path.
#[derive(Debug, Clone, clap::Args)]
pub struct TriagePolicyStoreSaveArgs {
    /// Store JSON path. The file is not inferred from app configuration.
    #[arg(long, value_name = "FILE")]
    pub store: PathBuf,
    /// Policy JSON path.
    #[arg(long, value_name = "FILE")]
    pub policy: PathBuf,
    /// Stable policy identity.
    #[arg(long, value_name = "ID")]
    pub policy_id: String,
}

/// Select one saved policy in an explicit store path.
#[derive(Debug, Clone, clap::Args)]
pub struct TriagePolicyStoreSelectArgs {
    /// Store JSON path. The file is not inferred from app configuration.
    #[arg(long, value_name = "FILE")]
    pub store: PathBuf,
    /// Existing policy identity.
    #[arg(long, value_name = "ID")]
    pub policy_id: String,
}

/// Explicit files for provider-free policy validation and compilation.
#[derive(Debug, Clone, clap::Args)]
pub struct TriagePolicyFileArgs {
    /// JSON file containing one `contextdesk.triage_policy.v2` policy.
    #[arg(long, value_name = "FILE")]
    pub policy: PathBuf,
    /// JSON file containing host-authored `TriagePolicyPreflightV2` facts.
    #[arg(long, value_name = "FILE")]
    pub preflight: PathBuf,
}

/// Options for `contextdesk eval validate`.
#[derive(Debug, clap::Args)]
pub struct EvalValidateArgs {
    /// Suite directory containing suite.json (default: bundled OPEN v1).
    #[arg(long)]
    pub suite: Option<PathBuf>,
}

/// Options for `contextdesk eval run`.
#[derive(Debug, clap::Args)]
pub struct EvalRunArgs {
    /// Suite directory containing suite.json (default: bundled OPEN v1).
    #[arg(long)]
    pub suite: Option<PathBuf>,
    /// File export shape when `--output` is set: `json` or `jsonl`.
    /// Global `--json` / `--jsonl` / `--format` still control the process
    /// envelope only and do not write files.
    #[arg(long = "report-format", value_name = "json|jsonl")]
    pub report_format: Option<String>,
    /// Write a machine report to this path (basename only appears in text).
    /// Refuses to overwrite unless `--force` is set.
    #[arg(long)]
    pub output: Option<PathBuf>,
    /// Replace an existing `--output` file.
    #[arg(long)]
    pub force: bool,
}

/// Model discovery and compatibility actions.
#[derive(Debug, clap::Args)]
pub struct ModelsArgs {
    #[command(subcommand)]
    pub action: Option<ModelsAction>,
}

/// Explicit live operations under `contextdesk models`.
#[derive(Debug, Subcommand)]
pub enum ModelsAction {
    /// Refresh the gateway catalog and save its secret-free inventory.
    Discover(ModelsDiscoverArgs),
    /// Run synthetic compatibility probes for selected or all catalog models.
    Verify(ModelsVerifyArgs),
}

/// Options for live catalog discovery.
#[derive(Debug, clap::Args)]
pub struct ModelsDiscoverArgs {
    /// After discovery, verify every returned model. Confirmation is still
    /// required unless `--yes` is also supplied.
    #[arg(long)]
    pub verify_all: bool,
    /// Confirm the token-spending `--verify-all` operation non-interactively.
    #[arg(long, requires = "verify_all")]
    pub yes: bool,
}

/// Options for explicit compatibility verification.
#[derive(Debug, clap::Args)]
pub struct ModelsVerifyArgs {
    /// Exact model ids to verify. Omit in an interactive terminal to choose
    /// from the discovered catalog.
    pub model_ids: Vec<String>,
    /// Verify every model in the discovered catalog.
    #[arg(long, conflicts_with = "model_ids")]
    pub all: bool,
    /// Restrict catalog selection to one suggested role. The suggestion
    /// narrows candidates; verification still determines actual support.
    #[arg(long, value_enum, conflicts_with = "model_ids")]
    pub role: Option<ModelRoleArg>,
    /// Restrict catalog selection to model ids containing this text
    /// (case-insensitive). Useful with large gateways such as Vercel.
    #[arg(long = "match", conflicts_with = "model_ids")]
    pub id_match: Option<String>,
    /// Skip the confirmation prompt. Required for `--all` without a terminal.
    #[arg(long)]
    pub yes: bool,
    /// Refresh the live gateway catalog before choosing models.
    #[arg(long)]
    pub refresh: bool,
}

/// CLI-only role filter; conversion stays in the command adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum ModelRoleArg {
    Chat,
    Embedding,
    Reranker,
    Unknown,
}

#[derive(Debug, clap::Args)]
pub struct DoctorArgs {
    /// Bound every network-touching check (provider connectivity, the live
    /// synthetic turn) to this many seconds. Default 30.
    #[arg(long)]
    pub timeout: Option<u64>,
    /// Skip the live synthetic chat turn — only run the network-free/local
    /// checks (config, provider connectivity, writable state). The overall
    /// verdict is never "ready" when checks were skipped this way: native
    /// tool calling, grounding, tracing, and session continuity are
    /// reported as unverified, not assumed working. Use this for a fast
    /// sanity pass, never to certify demo-readiness.
    #[arg(long)]
    pub skip_live_turn: bool,
}

#[derive(Debug, clap::Args)]
pub struct LoggingAssessmentArgs {
    /// Corpus id to assess. Defaults to the current corpus selected by the
    /// most recent import or `contextdesk corpus use`.
    pub corpus_id: Option<String>,
    /// Atomic report export path. When set, writes the versioned assessment
    /// (`--report-format json`) or Markdown projection of that JSON
    /// (`--report-format markdown`) and refuses to overwrite an existing file.
    #[arg(long, short = 'o')]
    pub output: Option<PathBuf>,
    /// On-disk report shape when `--output` is set (not the CLI envelope —
    /// use global `--json` / `--format` for that). Defaults to `json`.
    #[arg(long, default_value = "json")]
    pub report_format: String,
}

#[derive(Debug, clap::Args)]
pub struct ExceptionEpisodesArgs {
    /// Corpus id to correlate. Defaults to the current corpus selected by the
    /// most recent import or `contextdesk corpus use`.
    pub corpus_id: Option<String>,
}

#[derive(Debug, clap::Args)]
pub struct RetrievalStatusArgs {
    /// Actively probe enabled role endpoints (network to those endpoints
    /// only). Without this flag the report is offline and states are
    /// configuration-derived.
    #[arg(long)]
    pub probe: bool,
    /// Inspect this corpus id for embedded-template state.
    #[arg(long)]
    pub corpus_id: Option<String>,
    /// Inspect the current corpus (from the most recent import or
    /// `contextdesk corpus use`).
    #[arg(long)]
    pub corpus: bool,
}

/// Arguments for corpus template re-analysis (CLI parity with the desktop
/// flow, for corpora that already exist).
#[derive(Debug, clap::Args)]
pub struct RetrievalReanalyzeArgs {
    /// Corpus id to re-analyze. Defaults to the corpus selected by the most
    /// recent import or `contextdesk corpus use`.
    #[arg(long)]
    pub corpus_id: Option<String>,
    /// Execute the plan. Without this the command prints where the work would
    /// run and whether log content would leave this machine, and stops without
    /// constructing a backend, reading a credential, or using network.
    #[arg(long)]
    pub confirm: bool,
    /// Acknowledge that the configured embedding endpoint is remote, so log
    /// template text leaves this machine. Required before a remote run.
    #[arg(long)]
    pub acknowledge_egress: bool,
}

/// Arguments for the bounded retrieval-quality diagnostic.
#[derive(Debug, clap::Args)]
pub struct RetrievalDiagnoseArgs {
    /// Host-owned query file (JSON) with questions and the truth used to score
    /// them. Truth never leaves this machine and is never sent to a provider.
    #[arg(long)]
    pub queries: PathBuf,
    /// Corpus id to measure. Defaults to the corpus selected by the most
    /// recent import or `contextdesk corpus use`.
    #[arg(long)]
    pub corpus_id: Option<String>,
    /// Lane to run; repeatable. Defaults to all six.
    #[arg(long, value_name = "LANE")]
    pub lane: Vec<String>,
    /// Final candidate budget every lane returns (held identical across lanes).
    #[arg(long, default_value_t = 10)]
    pub k: u32,
    /// Rerank candidate pool depth, clamped to at least `--k`. A pool wider
    /// than K is what lets the rerank stage promote a near miss.
    #[arg(long, default_value_t = 40)]
    pub rerank_candidate_depth: u32,
    /// Packed-context character budget, measured per lane and held identical.
    #[arg(long, default_value_t = 8_000)]
    pub packed_context_chars: u32,
    /// Wall-clock budget for one rerank request.
    #[arg(long, default_value_t = 8_000)]
    pub rerank_timeout_ms: u64,
    /// Execute the lanes. Without this the command prints the plan and stops
    /// without constructing a backend, reading a credential, or using network.
    #[arg(long)]
    pub confirm: bool,
    /// Acknowledge that a configured remote role means query and candidate
    /// text leave this machine. Required before any remote lane runs.
    #[arg(long)]
    pub acknowledge_egress: bool,
    /// Include raw local material in the report. Requires
    /// `--raw-output-is-not-share-safe` as a second, explicit consent.
    #[arg(long)]
    pub include_raw: bool,
    /// Second consent for `--include-raw`. Raw output is local-only.
    #[arg(long)]
    pub raw_output_is_not_share_safe: bool,
    /// Write a machine report to this path (only the basename is printed).
    #[arg(long)]
    pub output: Option<PathBuf>,
    /// File export shape when `--output` is set: `json` or `jsonl`.
    #[arg(long = "report-format", value_name = "json|jsonl")]
    pub report_format: Option<String>,
    /// Replace an existing `--output` file.
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, clap::Args)]
pub struct ImportArgs {
    /// Archive file or directory to import.
    pub source: PathBuf,
    /// Corpus name (default: derived from the source path, de-duplicated).
    #[arg(long)]
    pub name: Option<String>,
    /// Generate embeddings during import (default: off — the fastest,
    /// most deterministic default; embed later with a dedicated command
    /// once one exists).
    #[arg(long)]
    pub embed: bool,
    /// After a successful import, print exactly which items the guided
    /// preview considered and why each was selected or excluded.
    #[arg(long)]
    pub explain_selection: bool,
}

#[derive(Debug, clap::Args)]
pub struct NormalizeArgs {
    /// File, folder, or zip of logs to normalize.
    pub source: PathBuf,
    /// Destination directory for JSONL + manifest + report (must be empty/absent).
    #[arg(long, env = "CONTEXTDESK_NORMALIZE_OUTPUT")]
    pub output: PathBuf,
    /// Normalized data format (not command rendering — use global --format for that).
    #[arg(
        long = "output-format",
        env = "CONTEXTDESK_NORMALIZE_FORMAT",
        default_value = "jsonl"
    )]
    pub output_format: String,
    /// IANA timezone applied to zone-less local timestamps for every source
    /// without a map entry.
    #[arg(long, env = "CONTEXTDESK_SOURCE_TIMEZONE")]
    pub source_timezone: Option<String>,
    /// JSON object mapping portable source identity → IANA zone
    /// (e.g. `{"api/app.log":"America/Chicago"}`).
    #[arg(long, env = "CONTEXTDESK_TIMEZONE_MAP")]
    pub timezone_map: Option<String>,
    /// Fail closed when any unresolved local timestamp lacks a resolvable zone.
    #[arg(long, env = "CONTEXTDESK_STRICT_TIME")]
    pub strict_time: bool,
    /// Publish valid output normally, but exit with the stable `partial` code
    /// when any selected source failed or was excluded.
    #[arg(long)]
    pub fail_on_partial: bool,
}

#[derive(Debug, Subcommand)]
pub enum NormalizedAction {
    /// Validate one normalized JSONL file or every `.jsonl` file under a directory.
    Validate(NormalizedPathArgs),
    /// Print aggregate conformance counts for one file or directory.
    Summarize(NormalizedPathArgs),
}

#[derive(Debug, clap::Args)]
pub struct NormalizedPathArgs {
    /// Normalized JSONL file, or directory recursively containing `.jsonl` files.
    pub input: PathBuf,
}

#[derive(Debug, Subcommand)]
pub enum CorpusAction {
    /// List every imported corpus.
    List,
    /// Show one corpus's metadata.
    Show { id: String },
    /// Rename a corpus (cosmetic only — never changes its id).
    Rename { id: String, name: String },
    /// Permanently delete a corpus and all its imported data.
    Delete {
        id: String,
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Set the corpus a bare `contextdesk chat` / `explore` / `context`
    /// grounds against.
    Use { id: String },
}

#[derive(Debug, Subcommand)]
pub enum TimezoneAction {
    /// Show every source's timezone resolution state for a corpus.
    Status {
        #[arg(long)]
        corpus: Option<String>,
    },
    /// Preview and apply an IANA timezone to one ambiguous source.
    Apply {
        source: String,
        /// IANA zone id, e.g. `America/Chicago`.
        iana_timezone: String,
        #[arg(long)]
        corpus: Option<String>,
        /// Skip the preview confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Clear a previously applied declaration, restoring ingest order.
    Clear {
        source: String,
        #[arg(long)]
        corpus: Option<String>,
    },
    /// Resolve EVERY source in a corpus that still has ambiguous local
    /// timestamps with one IANA zone, in a single atomic revision bump —
    /// the grouped escape hatch for when a configured default timezone
    /// wasn't set before import, so ambiguity doesn't need one `apply` per
    /// file.
    ApplyAll {
        /// IANA zone id, e.g. `America/Chicago`.
        iana_timezone: String,
        #[arg(long)]
        corpus: Option<String>,
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, clap::Args)]
pub struct ExploreArgs {
    pub query: String,
    #[arg(long)]
    pub corpus: Option<String>,
    /// Max results (1-100).
    #[arg(long, default_value_t = 20)]
    pub k: usize,
}

#[derive(Debug, clap::Args)]
pub struct ContextArgs {
    pub query: String,
    #[arg(long)]
    pub corpus: Option<String>,
    #[arg(long, default_value_t = 20)]
    pub k: usize,
}

#[derive(Debug, Subcommand)]
pub enum SessionAction {
    /// List durable chat sessions.
    List,
    /// Show one session's messages.
    Show { id: String },
}

/// Multi-model investigation mode for one `chat` turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, clap::ValueEnum)]
#[value(rename_all = "snake_case")]
pub enum ChatMode {
    /// The established single-model path (default).
    #[default]
    Single,
    /// Opt in to the reviewer pipeline. Degrades to single-model when the
    /// reviewer is unconfigured, unqualified, remote-without-ack, over budget,
    /// or the turn is not eligible; the exact reason is reported.
    Review,
    /// Opt in to configured, host-grounded contribution roles. Every role
    /// must have current structured-proposal qualification evidence.
    Contributions,
}

impl ChatMode {
    /// Convert to the core mode.
    pub fn to_core(self) -> cd_core::multi_model::MultiModelMode {
        match self {
            Self::Single => cd_core::multi_model::MultiModelMode::Single,
            Self::Review => cd_core::multi_model::MultiModelMode::Review,
            Self::Contributions => cd_core::multi_model::MultiModelMode::Contributions,
        }
    }
}

/// How much of a turn's actual provider traffic `chat --trace` reveals.
/// Each level includes everything the level below it shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
#[value(rename_all = "snake_case")]
pub enum TraceLevel {
    /// Provider/model identity, corpus + revision, history/retrieval
    /// counts, evidence ids, context budget, tool names, timings, and
    /// final grounding status. No message content.
    Summary,
    /// `summary`, plus the exact bounded, redacted messages and evidence
    /// this turn actually supplied to the provider, one line per round.
    Context,
    /// `context`, plus a bounded, redacted record of every tool call this
    /// turn made. Requires `--trace-ack`.
    Full,
}

/// How much of the shared Activity Inspector record `chat --activity`
/// projects. This is the same contract Tauri's Activity Inspector uses
/// (`cd_core::activity`), not a CLI-only reimplementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
#[value(rename_all = "snake_case")]
pub enum ActivityLevel {
    /// Counts, phases, origins, tool names, timings — never message bodies.
    Summary,
    /// Summary plus opt-in redacted, hard-bounded provider message bodies
    /// already scrubbed by `cd_core::turn_trace`.
    Full,
}

#[derive(Debug, clap::Args)]
pub struct ChatArgs {
    /// Question to ask. Multiple shell words are joined with spaces, though
    /// quoting is recommended so punctuation and shell metacharacters remain
    /// literal on macOS, Linux, and Windows shells.
    #[arg(required = true, num_args = 1.., value_name = "QUESTION")]
    pub question: Vec<String>,
    /// Explicit text to include as one-turn client evidence in ordinary chat.
    /// It is not saved as transcript text and is never inferred from ambient
    /// or corpus state. Linked-log turns must use host-resolved corpus evidence.
    #[arg(long = "context-selection")]
    pub user_selection: Option<String>,
    /// Ground this turn in a corpus (default: the corpus set by
    /// `corpus use`, if any; otherwise an ordinary, unlinked turn).
    #[arg(long)]
    pub corpus: Option<String>,
    /// Multi-model mode. `single` (default), `review`, or `contributions`.
    /// Contributions use persisted role assignments and fail closed to the
    /// deterministic floor when they are absent or unqualified.
    #[arg(long, value_enum, default_value_t = ChatMode::Single)]
    pub mode: ChatMode,
    /// Continue a specific durable session instead of the CLI's current one.
    #[arg(long)]
    pub session: Option<String>,
    /// Start a fresh session rather than continuing the current one.
    #[arg(long)]
    pub new: bool,
    /// Automatically grant every tool permission this turn requests
    /// instead of prompting (or, in a non-interactive process, denying).
    /// Scripting/CI escape hatch — never the interactive default.
    #[arg(long)]
    pub auto_approve: bool,
    /// Construct the same bounded, redacted conversation and grounded log
    /// context a real turn would, but guarantee no provider request
    /// occurs — no chat completion, no health probe, no credential
    /// refresh. Implies `--trace summary` if `--trace` is not also given.
    #[arg(long)]
    pub dry_run: bool,
    /// Emit a trace of what this turn actually sent a provider, at the
    /// named level of detail.
    #[arg(long, value_enum)]
    pub trace: Option<TraceLevel>,
    /// Required with `--trace full`: acknowledges that full-trace output
    /// includes bounded, redacted conversation and tool-call content
    /// (never credentials, authorization headers, or pre-redaction
    /// content — those are never captured in the first place).
    #[arg(long)]
    pub trace_ack: bool,
    /// Project the shared `cd_core::activity` turn record (the same
    /// Activity Inspector contract Tauri uses) at the named detail level.
    /// Requires the shared capture path (`TurnTraceSink` + stream events);
    /// does not invent a second agent loop.
    #[arg(long, value_enum)]
    pub activity: Option<ActivityLevel>,
    /// Required with `--activity full`: acknowledges that full activity
    /// retains bounded, redacted message bodies (never credentials).
    #[arg(long)]
    pub activity_ack: bool,
}

/// How the user selected the production chat path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvocationMode {
    Explicit,
    ImplicitChat,
}

/// Insert the real `chat` subcommand before a top-level natural-language
/// positional. Global options may precede the question. Recognized commands
/// and their aliases are never rewritten, preserving every existing grammar
/// and machine-output contract.
/// Every explicit subcommand name and visible alias.
///
/// [`normalize_invocation_args`] inserts an implicit `chat` in front of any
/// invocation whose first token is not one of these, so a subcommand missing
/// from this list is not rejected — it is silently reinterpreted as a chat
/// question, which fails with a baffling "unexpected argument" error. The
/// `every_clap_subcommand_is_registered_for_implicit_chat` test derives the
/// truth from clap itself so the two can never drift again.
pub const KNOWN_SUBCOMMANDS: &[&str] = &[
    "import",
    "normalize",
    "normalized",
    "corpus",
    "timezone",
    "explore",
    "search",
    "context",
    "session",
    "chat",
    "ask",
    "config",
    "confluence",
    "capabilities",
    "doctor",
    "logging-assessment",
    "assess",
    "exception-episodes",
    "episodes",
    "retrieval-status",
    "retrieval-diagnose",
    "retrieval-diagnostic",
    "retrieval-reanalyze",
    "reanalyze",
    "models",
    "eval",
    "triage-policy",
    "triage",
    "bench-compare",
    "gateway",
];

pub fn normalize_invocation_args<I, T>(args: I) -> (Vec<OsString>, InvocationMode)
where
    I: IntoIterator<Item = T>,
    T: Into<OsString>,
{
    let mut args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let commands = KNOWN_SUBCOMMANDS;
    let value_options = [
        "--format",
        "--color",
        "--config",
        "--app-config",
        "--data-dir",
        "--profile-dir",
        "--profile",
        "--model",
        "--mode",
        "--deadline",
        "--trace",
        "--activity",
        "--corpus",
        "--session",
        "--context-selection",
    ];
    let mut index = 1usize;
    while index < args.len() {
        let Some(token) = args[index].to_str() else {
            return (args, InvocationMode::Explicit);
        };
        if token == "--" {
            if args.get(index + 1).is_none() {
                return (args, InvocationMode::Explicit);
            }
            args.insert(index, OsString::from("chat"));
            return (args, InvocationMode::ImplicitChat);
        }
        if value_options.contains(&token) {
            index = index.saturating_add(2);
            continue;
        }
        if token.starts_with("--") && token.contains('=') {
            index += 1;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        if commands.contains(&token) {
            return (args, InvocationMode::Explicit);
        }
        args.insert(index, OsString::from("chat"));
        return (args, InvocationMode::ImplicitChat);
    }
    (args, InvocationMode::Explicit)
}

#[derive(Debug, Subcommand)]
pub enum ConfluenceAction {
    /// Report connector configuration status (no secrets, no network).
    Status,
    /// CQL / free-text search via the real ToolHost path (network to configured base URL).
    Search {
        /// Free-text query (or CQL when it contains `space` / `=`).
        query: String,
        /// Max hits (1–25).
        #[arg(long, default_value_t = 10)]
        limit: u64,
    },
    /// Fetch one page by id via the real ToolHost path.
    GetPage {
        /// Confluence content id.
        page_id: String,
        /// `plain` | `meta` | `storage` | `all`.
        #[arg(long, default_value = "plain")]
        format: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum ConfigAction {
    /// Create or update a config file.
    Init(Box<ConfigInitArgs>),
    /// Parse and validate a config file without applying it.
    Validate {
        /// Defaults to the project config path (`--config` / discovered
        /// `.contextdesk.toml`); pass an explicit path to validate any file.
        path: Option<PathBuf>,
    },
    /// Print the fully resolved effective configuration, with the source
    /// layer that won for each field.
    Show,
    /// Print the config file paths this build resolves, in precedence
    /// order.
    Path,
    /// Whole-turn deadline policy (adaptive vs custom ceiling).
    #[command(subcommand)]
    Deadline(DeadlineAction),
    /// Reasoning-effort policy (omit = provider default; not a readiness badge).
    #[command(subcommand)]
    Effort(EffortAction),
}

/// `contextdesk config deadline` subcommands.
#[derive(Debug, Subcommand)]
pub enum DeadlineAction {
    /// Show the saved whole-turn deadline policy (read-only).
    Show,
    /// Use adaptive deadlines (keeps the stored numeric value as fallback).
    Auto,
    /// Set an explicit whole-turn ceiling (`90s`, `3m`, `10m`, `500ms`).
    Set {
        /// Friendly duration: integer + unit `ms`, `s`, or `m`.
        duration: String,
    },
}

/// `contextdesk config effort` subcommands.
#[derive(Debug, Subcommand)]
pub enum EffortAction {
    /// Show the saved reasoning-effort policy (read-only).
    Show,
    /// Use the provider default (omit effort on the wire).
    Auto,
    /// Persist an explicit level (`none`/`low`/`medium`/`high`/`xhigh`/`max`).
    Set {
        /// Effort level token.
        level: String,
    },
}

#[derive(Debug, clap::Args)]
pub struct ConfigInitArgs {
    /// Write the project config (`./.contextdesk.toml`) instead of the
    /// global config.
    #[arg(long)]
    pub project: bool,
    /// Prompt interactively (default when stdin is a terminal).
    #[arg(long, conflicts_with = "non_interactive")]
    pub interactive: bool,
    /// Never prompt; write compiled-in defaults plus any flags given
    /// below. Default when stdin is not a terminal.
    #[arg(long)]
    pub non_interactive: bool,
    #[arg(long)]
    pub force: bool,
    #[arg(long)]
    pub format: Option<OutputFormat>,
    #[arg(long)]
    pub color: Option<ColorMode>,
    #[arg(long)]
    pub default_provider_profile: Option<String>,

    /// Skip provider configuration entirely — write only CLI behavior
    /// preferences (format/color/profile pointer). Default in
    /// `--non-interactive` mode unless `--provider-kind` is also given.
    #[arg(long)]
    pub skip_provider: bool,
    /// Provider protocol kind for the profile this wizard writes into the
    /// shared `AppConfig`.
    #[arg(long, value_enum)]
    pub provider_kind: Option<ProviderKindArg>,
    /// Base URL for the provider (default depends on `--provider-kind`;
    /// required for kinds with no built-in default, e.g.
    /// `openai-compatible`).
    #[arg(long)]
    pub base_url: Option<String>,
    /// Chat model id (default `mistral` for `ollama`; required for other
    /// kinds in `--non-interactive` mode).
    #[arg(long)]
    pub chat_model: Option<String>,
    /// Default IANA timezone applied to source-local timestamps with no
    /// resolvable zone evidence of their own, e.g. `America/Chicago`.
    /// Leaves any existing configured value untouched when omitted.
    #[arg(long)]
    pub default_timezone: Option<String>,
    /// Stable id for the provider profile (default: derived from
    /// `--provider-kind`).
    #[arg(long)]
    pub profile_id: Option<String>,
    /// Human label for the provider profile (default: derived from
    /// `--provider-kind`).
    #[arg(long)]
    pub profile_label: Option<String>,
    /// Read the API key from this environment variable's current value —
    /// read once, stored as an OS keychain reference, never written to disk
    /// or echoed. Mutually exclusive with `--api-key-file` /
    /// `--api-key-stdin`.
    #[arg(
        long,
        conflicts_with_all = ["api_key_file", "api_key_file_ref", "api_key_stdin"]
    )]
    pub api_key_env: Option<String>,
    /// Read the API key from this file's contents (trimmed) — read once,
    /// stored as an OS keychain reference, never written to disk or echoed.
    #[arg(
        long,
        conflicts_with_all = ["api_key_file_ref", "api_key_stdin"]
    )]
    pub api_key_file: Option<PathBuf>,
    /// Use this protected file directly on every provider operation. Saves
    /// only an absolute `file:` reference; never imports the key into the OS
    /// keychain. The file must be owned by the current user and mode 600 on
    /// Unix/macOS.
    #[arg(
        long,
        conflicts_with_all = ["api_key_env", "api_key_file", "api_key_stdin"]
    )]
    pub api_key_file_ref: Option<PathBuf>,
    /// Read the API key as one line from stdin — read once, stored as an OS
    /// keychain reference, never written to disk or echoed.
    #[arg(long)]
    pub api_key_stdin: bool,
    /// After configuring a provider, run a safe reachability probe (base
    /// URL and, if configured, the key — no corpus content is ever sent).
    #[arg(long)]
    pub check_connection: bool,
}

/// CLI-shape mirror of `cd_core::providers::ProviderKind` — this module is
/// clap grammar only and must not depend on `cd_core`; the conversion lives
/// in `commands::config_cmd`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
#[value(rename_all = "kebab-case")]
pub enum ProviderKindArg {
    Ollama,
    /// Matches `cd_core::providers::descriptor_for`'s `openai-compatible`
    /// slug and the wizard's interactive prompt text exactly — plain
    /// kebab-case would otherwise render this `open-ai-compatible`.
    #[value(name = "openai-compatible")]
    OpenAiCompatible,
    Anthropic,
    XaiGrokBuild,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn config_init_credential_flags_are_mutually_exclusive() {
        // Import-into-Keychain paths must not combine with each other or with
        // a protected-file reference. Clap enforces this before any secret I/O.
        let conflicting = [
            vec![
                "contextdesk",
                "config",
                "init",
                "--non-interactive",
                "--api-key-env",
                "X",
                "--api-key-file",
                "/tmp/a",
            ],
            vec![
                "contextdesk",
                "config",
                "init",
                "--non-interactive",
                "--api-key-env",
                "X",
                "--api-key-file-ref",
                "/tmp/a",
            ],
            vec![
                "contextdesk",
                "config",
                "init",
                "--non-interactive",
                "--api-key-file",
                "/tmp/a",
                "--api-key-file-ref",
                "/tmp/b",
            ],
            vec![
                "contextdesk",
                "config",
                "init",
                "--non-interactive",
                "--api-key-stdin",
                "--api-key-file-ref",
                "/tmp/a",
            ],
            vec![
                "contextdesk",
                "config",
                "init",
                "--non-interactive",
                "--api-key-env",
                "X",
                "--api-key-stdin",
            ],
        ];
        for argv in conflicting {
            let err = Cli::try_parse_from(&argv).unwrap_err();
            let rendered = err.to_string();
            assert!(
                rendered.contains("cannot be used with")
                    || rendered.contains("conflict")
                    || rendered.contains("Cannot be used with"),
                "expected mutual exclusion for {argv:?}, got: {rendered}"
            );
        }

        // Each exclusive source parses alone.
        for argv in [
            vec![
                "contextdesk",
                "config",
                "init",
                "--non-interactive",
                "--api-key-env",
                "CONTEXTDESK_TEST_KEY",
            ],
            vec![
                "contextdesk",
                "config",
                "init",
                "--non-interactive",
                "--api-key-file",
                "/tmp/import.key",
            ],
            vec![
                "contextdesk",
                "config",
                "init",
                "--non-interactive",
                "--api-key-file-ref",
                "/tmp/protected.key",
            ],
            vec![
                "contextdesk",
                "config",
                "init",
                "--non-interactive",
                "--api-key-stdin",
            ],
        ] {
            Cli::try_parse_from(&argv).unwrap_or_else(|e| {
                panic!("solo credential flag must parse for {argv:?}: {e}");
            });
        }
    }

    #[test]
    fn friendly_command_aliases_parse_to_the_same_production_commands() {
        let ask = Cli::try_parse_from(["contextdesk", "ask", "what failed?"]).unwrap();
        assert!(matches!(ask.command, Command::Chat(_)));

        let search = Cli::try_parse_from(["contextdesk", "search", "pool exhausted"]).unwrap();
        assert!(matches!(search.command, Command::Explore(_)));

        let assess = Cli::try_parse_from(["contextdesk", "assess"]).unwrap();
        assert!(matches!(
            assess.command,
            Command::LoggingAssessment(LoggingAssessmentArgs {
                corpus_id: None,
                ..
            })
        ));
    }

    #[test]
    fn explicit_no_color_flag_parses_and_conflicts_with_color_mode() {
        let parsed = Cli::try_parse_from(["contextdesk", "--no-color", "gateway", "diagnose"])
            .expect("--no-color should be accepted globally");
        assert!(parsed.global.no_color);

        let err = Cli::try_parse_from([
            "contextdesk",
            "--no-color",
            "--color",
            "always",
            "gateway",
            "diagnose",
        ])
        .expect_err("--no-color and --color must not be ambiguous");
        assert!(err.to_string().contains("cannot be used with"));
    }

    #[test]
    fn direct_question_normalizes_to_production_chat_across_shell_shapes() {
        for argv in [
            vec!["contextdesk", "What caused the outage?"],
            vec!["contextdesk", "What", "caused", "the", "outage?"],
            vec!["contextdesk", "--color", "never", "What caused it?"],
            vec!["contextdesk", "--model=gpt-x", "What caused it?"],
        ] {
            let (normalized, mode) = normalize_invocation_args(argv);
            assert_eq!(mode, InvocationMode::ImplicitChat);
            let parsed = Cli::try_parse_from(normalized).unwrap();
            let Command::Chat(chat) = parsed.command else {
                panic!("implicit question did not select chat");
            };
            assert!(chat.question.join(" ").contains("caused"));
        }
    }

    #[test]
    fn direct_question_with_deadline_normalizes_and_parses() {
        // Global --deadline + free-text question (chat-only flags like
        // --dry-run belong after `chat` or after the question).
        let argv = vec!["contextdesk", "--deadline", "10m", "What", "caused", "it?"];
        let (normalized, mode) = normalize_invocation_args(argv);
        assert_eq!(mode, InvocationMode::ImplicitChat);
        assert!(normalized.iter().any(|a| a == "chat"));
        let parsed = Cli::try_parse_from(normalized).unwrap();
        assert_eq!(parsed.global.deadline.as_deref(), Some("10m"));
        let Command::Chat(chat) = parsed.command else {
            panic!("expected chat");
        };
        assert!(chat.question.join(" ").contains("caused"));
    }

    #[test]
    fn explicit_chat_accepts_deadline_flag() {
        let parsed = Cli::try_parse_from([
            "contextdesk",
            "chat",
            "--deadline",
            "90s",
            "--dry-run",
            "what happened?",
        ])
        .unwrap();
        assert_eq!(parsed.global.deadline.as_deref(), Some("90s"));
        let Command::Chat(chat) = parsed.command else {
            panic!("expected chat");
        };
        assert!(chat.dry_run);
    }

    #[test]
    fn config_deadline_grammar_parses() {
        let show = Cli::try_parse_from(["contextdesk", "config", "deadline", "show"]).unwrap();
        assert!(matches!(
            show.command,
            Command::Config {
                action: ConfigAction::Deadline(DeadlineAction::Show)
            }
        ));
        let auto = Cli::try_parse_from(["contextdesk", "config", "deadline", "auto"]).unwrap();
        assert!(matches!(
            auto.command,
            Command::Config {
                action: ConfigAction::Deadline(DeadlineAction::Auto)
            }
        ));
        let set = Cli::try_parse_from(["contextdesk", "config", "deadline", "set", "90s"]).unwrap();
        match set.command {
            Command::Config {
                action: ConfigAction::Deadline(DeadlineAction::Set { duration }),
            } => assert_eq!(duration, "90s"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn explicit_commands_aliases_and_unknown_options_are_never_rewritten() {
        for argv in [
            vec!["contextdesk", "chat", "question"],
            vec!["contextdesk", "ask", "question"],
            vec!["contextdesk", "import", "logs"],
            vec!["contextdesk", "--definitely-unknown"],
        ] {
            let (normalized, mode) = normalize_invocation_args(argv.clone());
            assert_eq!(mode, InvocationMode::Explicit, "argv={argv:?}");
            assert_eq!(normalized.len(), argv.len());
        }
    }

    #[test]
    fn end_of_options_keeps_literal_questions_and_explicit_precedence() {
        for argv in [
            vec!["contextdesk", "--", "-why"],
            vec!["contextdesk", "--", "question"],
            vec!["contextdesk", "--", "chat", "question"],
        ] {
            let (normalized, mode) = normalize_invocation_args(argv);
            assert_eq!(mode, InvocationMode::ImplicitChat);
            assert_eq!(normalized[1], "chat");
            assert_eq!(normalized[2], "--");
            let parsed = Cli::try_parse_from(normalized).unwrap();
            let Command::Chat(chat) = parsed.command else {
                panic!("literal question did not select chat");
            };
            if chat.question[0] == "chat" {
                assert_eq!(chat.question, ["chat", "question"]);
            } else {
                assert_eq!(chat.question.len(), 1);
            }
        }

        for argv in [
            vec!["contextdesk", "chat", "--", "-why"],
            vec!["contextdesk", "--jsonl", "ask", "question"],
        ] {
            let (normalized, mode) = normalize_invocation_args(argv.clone());
            assert_eq!(mode, InvocationMode::Explicit, "argv={argv:?}");
            assert_eq!(normalized.len(), argv.len());
        }

        let (normalized, mode) = normalize_invocation_args([
            "contextdesk",
            "question",
            "--dry-run",
            "--trace",
            "summary",
        ]);
        assert_eq!(mode, InvocationMode::ImplicitChat);
        let parsed = Cli::try_parse_from(normalized).unwrap();
        let Command::Chat(chat) = parsed.command else {
            panic!("question did not select chat");
        };
        assert_eq!(chat.question, vec!["question"]);
        assert!(chat.dry_run);
        assert_eq!(chat.trace, Some(TraceLevel::Summary));
    }

    #[test]
    fn models_supports_offline_status_and_filtered_or_exact_verification() {
        let status = Cli::try_parse_from(["contextdesk", "models"]).unwrap();
        assert!(matches!(
            status.command,
            Command::Models(ModelsArgs { action: None })
        ));

        let filtered = Cli::try_parse_from([
            "contextdesk",
            "models",
            "verify",
            "--all",
            "--role",
            "chat",
            "--match",
            "deepseek",
            "--yes",
        ])
        .unwrap();
        let Command::Models(ModelsArgs {
            action: Some(ModelsAction::Verify(args)),
        }) = filtered.command
        else {
            panic!("filtered verification did not parse")
        };
        assert!(args.all);
        assert_eq!(args.role, Some(ModelRoleArg::Chat));
        assert_eq!(args.id_match.as_deref(), Some("deepseek"));

        let exact = Cli::try_parse_from([
            "contextdesk",
            "models",
            "verify",
            "deepseek-v4-flash",
            "bge-m3",
        ])
        .unwrap();
        let Command::Models(ModelsArgs {
            action: Some(ModelsAction::Verify(args)),
        }) = exact.command
        else {
            panic!("exact verification did not parse")
        };
        assert_eq!(args.model_ids, ["deepseek-v4-flash", "bge-m3"]);
    }

    #[test]
    fn chat_accepts_the_opt_in_contribution_mode() {
        let parsed = Cli::try_parse_from([
            "contextdesk",
            "chat",
            "--mode",
            "contributions",
            "why did the service fail?",
        ])
        .unwrap();
        let Command::Chat(args) = parsed.command else {
            panic!("chat command did not parse");
        };
        assert_eq!(args.mode, ChatMode::Contributions);
        assert_eq!(
            args.mode.to_core(),
            cd_core::multi_model::MultiModelMode::Contributions
        );
    }

    /// The implicit-chat normalizer routes any first token it does not
    /// recognize into `chat`, so a subcommand missing from
    /// [`KNOWN_SUBCOMMANDS`] is not rejected — it becomes a chat question and
    /// fails with an "unexpected argument" error that points nowhere near the
    /// real cause. Derive the truth from clap so the two lists cannot drift.
    #[test]
    fn every_clap_subcommand_is_registered_for_implicit_chat() {
        use clap::CommandFactory;
        let command = Cli::command();
        let mut missing = Vec::new();
        for subcommand in command.get_subcommands() {
            let name = subcommand.get_name().to_string();
            if !KNOWN_SUBCOMMANDS.contains(&name.as_str()) {
                missing.push(name);
            }
            for alias in subcommand.get_visible_aliases() {
                if !KNOWN_SUBCOMMANDS.contains(&alias) {
                    missing.push(alias.to_string());
                }
            }
        }
        assert!(
            missing.is_empty(),
            "these subcommands/aliases would be swallowed by implicit chat: {missing:?}"
        );
    }

    #[test]
    fn the_retrieval_diagnostic_is_reachable_by_name_and_alias() {
        for name in ["retrieval-diagnose", "retrieval-diagnostic"] {
            let (normalized, mode) = normalize_invocation_args([
                OsString::from("contextdesk"),
                OsString::from(name),
                OsString::from("--queries"),
                OsString::from("q.json"),
            ]);
            assert_eq!(
                mode,
                InvocationMode::Explicit,
                "`{name}` must not be reinterpreted as a chat question"
            );
            assert_eq!(normalized[1], OsString::from(name));
        }
    }
}

#[cfg(test)]
mod effort_flag_tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn config_effort_grammar_parses() {
        let show = Cli::try_parse_from(["contextdesk", "config", "effort", "show"]).unwrap();
        assert!(matches!(
            show.command,
            Command::Config {
                action: ConfigAction::Effort(EffortAction::Show)
            }
        ));
        let set =
            Cli::try_parse_from(["contextdesk", "config", "effort", "set", "medium"]).unwrap();
        match set.command {
            Command::Config {
                action: ConfigAction::Effort(EffortAction::Set { level }),
            } => assert_eq!(level, "medium"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn chat_accepts_reasoning_effort_flag() {
        let parsed =
            Cli::try_parse_from(["contextdesk", "--reasoning-effort", "high", "chat", "hello"])
                .unwrap();
        assert_eq!(parsed.global.reasoning_effort.as_deref(), Some("high"));
    }
}
