//! Command grammar. This module only describes shape (clap derive structs)
//! — no I/O, no `cd_core`/`cd_workflow` calls. `main.rs` maps each variant
//! to a handler in `commands/`.

use crate::config::{ColorMode, OutputFormat};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "contextdesk",
    version,
    about = "ContextDesk CLI — import evidence, then ask questions grounded in it",
    long_about = "The configured happy path is two commands:\n\n  contextdesk import <archive>\n  contextdesk chat \"<question>\"\n\nEverything else (corpus management, timezone review, exploration) is an\nescape hatch for when the defaults aren't enough — never required for the\nhappy path."
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
    /// `~/.contextdesk/config.json` both hosts otherwise share.
    #[arg(long, global = true, env = "CONTEXTDESK_APP_CONFIG")]
    pub app_config: Option<PathBuf>,
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
    Chat(ChatArgs),
    /// CLI configuration.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Machine-readable description of this build: supported commands,
    /// envelope schema version, exit-code categories.
    Capabilities,
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

#[derive(Debug, clap::Args)]
pub struct ChatArgs {
    pub question: String,
    /// Ground this turn in a corpus (default: the corpus set by
    /// `corpus use`, if any; otherwise an ordinary, unlinked turn).
    #[arg(long)]
    pub corpus: Option<String>,
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
}

#[derive(Debug, Subcommand)]
pub enum ConfigAction {
    /// Create or update a config file.
    Init(ConfigInitArgs),
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
}
