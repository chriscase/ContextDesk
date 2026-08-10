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
    /// Discover gateway models and show or verify role-specific compatibility.
    /// Bare `models` is entirely offline and never reads credentials.
    Models(ModelsArgs),
    /// Hermetic quality-evaluation fixtures (offline, no credentials, no network).
    /// Does not measure live model usefulness or compatibility readiness.
    Eval {
        #[command(subcommand)]
        action: EvalAction,
    },
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
}

impl ChatMode {
    /// Convert to the core mode.
    pub fn to_core(self) -> cd_core::multi_model::MultiModelMode {
        match self {
            Self::Single => cd_core::multi_model::MultiModelMode::Single,
            Self::Review => cd_core::multi_model::MultiModelMode::Review,
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
    /// Multi-model mode. `single` (default) or `review` to opt in to the
    /// reviewer pipeline. Review needs a configured, qualified (or
    /// `require_qualified=false`) reviewer and a corpus-linked turn; otherwise
    /// it degrades to single-model and reports the reason.
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
pub fn normalize_invocation_args<I, T>(args: I) -> (Vec<OsString>, InvocationMode)
where
    I: IntoIterator<Item = T>,
    T: Into<OsString>,
{
    let mut args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let commands = [
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
        "models",
        "eval",
    ];
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
}
