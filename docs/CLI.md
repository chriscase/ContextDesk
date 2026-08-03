# ContextDesk CLI

`cd-cli` (binary: `contextdesk`) is a thin adapter over `cd_workflow` — the
same host-neutral orchestration layer the desktop app uses for import,
timezone handling, corpus persistence, retrieval, and grounded chat. It
never re-derives that logic; see `crates/cd-workflow/src/lib.rs` for the
architectural invariant.

## Happy path

```bash
contextdesk import <archive>
contextdesk chat "<question>"
```

A normal import needs no per-file selection — the CLI accepts the same
default preselection `cd_core::log_analysis::import_preview` computes for
every host. `--explain-selection` prints exactly what was included/excluded
and why. Corpus management, timezone review, and exploration are escape
hatches for when the defaults aren't enough, never required for the happy
path.

State shared with the desktop app (provider profiles, the configured
default timezone, imported corpora, chat sessions) lives in the same files
both hosts read: `~/.contextdesk/config.json`, `~/.contextdesk/cache/`,
`~/.contextdesk/sessions/`. A corpus imported from one host is immediately
visible from the other. This is the default; pass `--data-dir` to opt out
of it entirely (see below).

## Isolated profiles (`--data-dir` / `--profile-dir`)

```bash
contextdesk --data-dir ~/ci-profile import ./archive.zip
contextdesk --data-dir ~/ci-profile chat "what broke?"
```

`--data-dir <path>` (alias `--profile-dir`, env `CONTEXTDESK_DATA_DIR`)
isolates **every** piece of state this process touches — the shared
`AppConfig`, this CLI's own `cli.toml`, the corpus cache, durable sessions,
and CLI state (`<data-dir>/{config.json,cli.toml,cache,sessions,cli}`) —
under exactly the directory given, created if absent. Omit it to keep the
default: state shared with the desktop app under `~/.contextdesk`.

This is a filesystem-only boundary — credentials never live on disk at all,
they stay in the OS keychain (see [Configuration](#configuration)) — so a
provider credential is always a keychain entry scoped by *profile id*, not
by `--data-dir`. `config init` accounts for that: an isolated profile's
*default* id (no explicit `--profile-id`) is itself derived from the data
dir, so the single most common invocation (no `--profile-id`) can never
silently read or overwrite the desktop-shared profile's keychain entry for
the same provider kind, and two isolated profiles at two different
`--data-dir` values never collide with each other either — same `--data-dir`
always yields the same default id, so a repeat `config init --force`
targets the same entry it created before. Passing an explicit
`--profile-id` opts back out of that scoping (a deliberate escape hatch,
e.g. to intentionally share one credential across profiles); two profiles
that are given the same explicit id share that keychain entry the same way
two desktop installs would.

One provider kind cannot be isolated at all: a `xai-grok-build` profile's
session lives in `~/.grok/auth.json`, a real, single, machine-wide login —
not a per-profile credential — so `--check-connection` refuses to probe it
under an isolated `--data-dir` rather than silently reading and
transmitting the real session from outside the isolated directory. Every
other provider kind's connectivity check only ever uses the profile's own
resolved key.

Setting `--data-dir` skips the `$HOME` lookup entirely (no `dirs::home_dir()`
call happens at all), which is what makes an isolated profile deterministic,
cross-platform, and testable **without overriding `HOME`**: two processes
given two different `--data-dir` values cannot observe or mutate each
other's state regardless of what `$HOME` resolves to in the environment —
including a broken or absent `$HOME`, which fails the default
(desktop-shared) path but never an isolated one. `--app-config` still overrides the
`AppConfig` path on top of either default, isolated or not, and is used as
an exact path (never joined with `--data-dir`).

`contextdesk config init`'s output always reports the resolved data
location and whether it is isolated:

```json
{ "data_dir": "/Users/you/ci-profile", "isolated": true, "...": "..." }
```

## Configuration

The CLI has its own, separate, versioned TOML configuration for CLI-only
preferences (output format, color, a preferred provider profile/model). It
never holds credentials or provider secrets: those live exclusively in the
OS keychain, referenced (never embedded) from the shared `config.json` by a
path-like id such as `provider/<profile-id>/api_key`
(`cd_core::keychain_store::looks_like_raw_secret` refuses to save a config
that embeds anything else). See `crates/cd-cli/src/config.rs` for the CLI's
own TOML schema.

Precedence, lowest to highest — unaffected by `--data-dir`, which only
relocates *where* the global layer and the shared `AppConfig` live, never
the merge order:

1. compiled-in defaults
2. global config (`<data-dir-or-~/.contextdesk>/cli.toml`)
3. explicitly selected project config (`./.contextdesk.toml` in the current
   directory, or a path passed via `--config`)
4. environment variables (`CONTEXTDESK_*`)
5. CLI flags

```bash
contextdesk config init                # interactive wizard (tty) or defaults (non-tty)
contextdesk config init --non-interactive --format json
contextdesk config init --project      # writes ./.contextdesk.toml instead
contextdesk config validate [path]
contextdesk config show                # effective config + which layer won each field
contextdesk config path
```

### The `config init` wizard

Beyond CLI behavior preferences, `config init` also configures the *shared*
`AppConfig` — a provider profile and the default timezone — in one pass.
Interactively it prompts for each step; every step also has a flag for
scripted/CI use. Every prompt (and any human-readable error) goes to
**stderr**, never stdout — stdout stays reserved for the final
`--json`/`--jsonl` envelope even when the interactive wizard runs under
`--json` (auto-detected purely from whether stdin is a tty, independent of
`--format`).

```bash
contextdesk config init --non-interactive \
  --provider-kind openai-compatible \
  --base-url https://api.example.com/v1 \
  --chat-model gpt-4o-mini \
  --default-timezone America/Chicago \
  --api-key-env MY_PROVIDER_KEY \
  --check-connection
```

- **Data location** is report-only — it just states the already-resolved
  `--data-dir` (or the default), since there is nothing to read a saved
  choice from until a config file exists there.
- **Provider kind**: `--provider-kind ollama|openai-compatible|anthropic|
  xai-grok-build`. Base URL, capabilities, and locality defaults come from
  `cd_core::providers::descriptor_for` for the chosen kind — override the
  base URL with `--base-url` (required non-interactively for kinds with no
  built-in default, e.g. `openai-compatible`). `--profile-id` /
  `--profile-label` override the generated id/label.
- **Chat model**: `--chat-model` (defaults to `mistral` for `ollama`;
  required non-interactively for every other kind).
- **Default timezone**: `--default-timezone <iana-id>`, validated as a real
  IANA zone before anything is written; omit to leave any existing
  configured value untouched.
- **Credential**: never accepted as a literal flag value (that would leak
  via shell history / `ps`). Pick exactly one of `--api-key-env <VAR>`
  (read the named environment variable's current value, trimmed),
  `--api-key-file <path>` (read and trim the file's contents), or
  `--api-key-stdin` (read and trim one line from stdin) — read once, held
  in memory, then committed to the OS keychain only as the single last
  fallible step of the whole command, strictly after both config files
  (`cli.toml` and the shared `AppConfig`) have already been written
  successfully. Omit all three to leave the profile without a credential
  (configurable later). This ordering means a rejected value anywhere in
  the run (a bad URL, an invalid timezone, a mistyped interactive y/n)
  never orphans a stored secret that nothing references; the only residual
  gap is the keychain write itself failing *after* both files already
  landed, which self-heals on a repeat `config init --force` with the same
  (or an explicit `--profile-id`).
- **Connectivity check**: `--check-connection` (or, interactively, an
  explicit yes) runs a reachability probe against the base URL and, if
  configured, the key already resolved in memory (never a second keychain
  read) — the same safe probe `cd_core::discovery::probe_provider` already
  uses elsewhere. It never sends corpus content (there is none in scope at
  `config init` time) and is off by default everywhere, including
  interactively. Refused outright for `xai-grok-build` on an isolated
  profile — see [Isolated profiles](#isolated-profiles---data-dir---profile-dir).
- Pass `--skip-provider` to write only CLI behavior preferences, matching
  the pre-existing behavior exactly.

## Output

Every command supports `--format text|json|jsonl` (or the `--json`/
`--jsonl` shorthands). Text is for humans; JSON/JSONL are the stable,
documented machine contract below. `contextdesk capabilities` emits this
same contract as data — probe it once rather than parsing `--help`.

### One-shot envelope (`--json`, non-streaming commands)

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "corpus",
  "data": { "...": "..." },
  "error": null
}
```

On failure, `ok` is `false`, `data` is `null`, and `error` is
`{ "kind": "<exit-code kind>", "message": "..." }`.

### Streaming lines (`--jsonl`, currently `chat`)

One JSON object per line, tagged by `type`: `session`, `text_delta`,
`tool`, `permission_required`, `turn_completed`, `error`, `done`. `done` is
always last.

### Exit codes

| Code | Category | Meaning |
| ---- | -------- | ------- |
| 0 | `success` | Completed. |
| 1 | `user_error` | Invalid input, independent of stored state. |
| 3 | `not_found` | Named corpus/source/session/config file does not exist. |
| 4 | `conflict` | Stored state moved since it was last observed (stale timezone preview token, revision mismatch) — re-read and retry. |
| 5 | `permission_denied` | A tool call requiring permission was denied. |
| 6 | `provider_error` | The configured provider could not be reached or errored. |
| 7 | `not_implemented` | Grammar accepted, behavior intentionally not implemented yet. Never conflated with success. |
| 70 | `internal` | Unexpected failure — a bug, not an expected branch. |

Clap's own usage errors (bad flags, missing required args) use clap's
default exit code (2) and are not part of this table.

## Command grammar

```
contextdesk import <source> [--name NAME] [--embed] [--explain-selection]
contextdesk corpus list
contextdesk corpus show <id>
contextdesk corpus rename <id> <name>
contextdesk corpus delete <id> --yes
contextdesk corpus use <id>
contextdesk timezone status [--corpus <id>]
contextdesk timezone apply <source> <iana-timezone> [--corpus <id>] --yes
contextdesk timezone clear <source> [--corpus <id>]
contextdesk explore <query> [--corpus <id>] [--k N]
contextdesk context <query> [--corpus <id>] [--k N]
contextdesk session list
contextdesk session show <id>
contextdesk chat <question> [--corpus <id>] [--session <id>] [--new] [--auto-approve]
contextdesk config init [--project] [--interactive|--non-interactive] [--force]
                        [--format <fmt>] [--color <mode>] [--default-provider-profile <id>]
                        [--skip-provider] [--provider-kind <kind>] [--base-url <url>]
                        [--chat-model <id>] [--default-timezone <iana-id>]
                        [--profile-id <id>] [--profile-label <label>]
                        [--api-key-env <var>|--api-key-file <path>|--api-key-stdin]
                        [--check-connection]
contextdesk config validate|show|path
contextdesk capabilities
```

Global flags (available on every subcommand): `--format`, `--json`,
`--jsonl`, `--color`, `--config <path>`, `--app-config <path>`,
`--data-dir <path>` (alias `--profile-dir`), `--profile <id>`, `--model
<id>`.

## Permission prompts (`chat`)

A grounded turn's tool calls can require permission (writes, remote
fetches). In an interactive terminal, `chat` prompts synchronously and
grants exactly one call at a time (`AllowOnce` — never a standing grant
from a single answer). In a non-interactive process (no tty, e.g. CI), the
default is to **deny and say so on stderr** — never silently proceed as if
granted. `--auto-approve` is the explicit scripting/CI escape hatch that
grants every request; it is never the interactive default.

## Known limitations (tracked, not silent)

- `import --embed` is accepted by the grammar but returns `not_implemented`
  — `cd_workflow::import::default_import` always ingests with no embedding.
  Import without `--embed`, then embed via the desktop app.
- `corpus rename` only changes the cosmetic display name
  (`cd_core::log_analysis::LogCorpus::rename`, added for this slice) — never
  identity, ingest data, or citations.
- No cross-corpus search — `explore`/`context` operate on one corpus at a
  time, matching every `cd_core::log_analysis` search API's shape.
- `chat` runs an ordinary or corpus-linked turn through
  `cd_workflow::chat::run_chat_workflow`; it does not yet expose the
  desktop app's fuller tool surface (clustering, timeline, anomalies) as
  CLI subcommands of their own.
- `config init`'s credential storage (OS keychain) and its `AppConfig` /
  `cli.toml` writes (filesystem, atomic temp-file-then-rename) are two
  separate systems with no shared transaction. The wizard orders the
  keychain write LAST — strictly after both config files are written
  successfully — so a *rejected* run (bad URL, invalid timezone, a
  mistyped interactive answer) never stores an orphaned credential that
  nothing references. It cannot protect against the keychain write itself
  failing *after* both files already landed; that leaves a saved profile
  whose `api_key_ref` points at a keychain entry that doesn't exist yet, a
  narrower and self-healing failure mode (re-run `config init --force`
  with the same profile id) than the reverse ordering would produce.
- `--data-dir` isolates filesystem state only. Provider credentials always
  live in the same OS keychain regardless of `--data-dir` (see
  [Isolated profiles](#isolated-profiles---data-dir---profile-dir)) —
  `config init`'s *default* profile id is scoped by the data dir to avoid
  colliding with the desktop-shared entry, but an explicit `--profile-id`
  opts back out of that scoping by design, and `xai-grok-build`'s session
  credential cannot be scoped by `--data-dir` at all (it is refused under
  `--check-connection` rather than silently probed).

## Architecture

```
React → thin Tauri adapter ─┐
                             ├─► cd_workflow (shared, host-neutral) → cd_core
CLI  → thin CLI adapter   ──┘
```

`cd-cli` calls `cd_workflow::{import, chat, provider, turn, tools}` for
every behavior those modules already own. The Tauri desktop host's
provider-selection helpers (`provider_profile_for_turn`,
`model_tools_disabled_reason`, `model_tools_enabled` in
`desktop/src-tauri/src/lib.rs`) delegate to `cd_workflow::provider` for the
same reason — both hosts share one implementation, not two that merely
look equivalent. `crates/cd-cli/tests/cli_workflow_parity.rs` exercises the
CLI binary end to end against a mock provider to prove the adapter stays
thin.
