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
    #[arg(long, conflicts_with_all = ["api_key_file", "api_key_stdin"])]
    pub api_key_env: Option<String>,
    /// Read the API key from this file's contents (trimmed) — read once,
    /// stored as an OS keychain reference, never written to disk or echoed.
    #[arg(long, conflicts_with = "api_key_stdin")]
    pub api_key_file: Option<PathBuf>,
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
