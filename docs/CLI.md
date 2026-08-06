# ContextDesk CLI

`cd-cli` (binary: `contextdesk`) is a thin adapter over `cd_workflow`, which
packages host-neutral operations around the production `cd_core` engine. The
CLI and desktop share that lower-level engine for source selection, ingest,
timezone handling, corpus persistence, retrieval, and the grounded agent
loop. The desktop currently delegates provider selection to `cd_workflow`,
while its import and `agent_turn` commands retain Tauri-specific orchestration
and call `cd_core` directly. See [Architecture](#architecture) for the exact
boundary; the hosts share the behavior kernel, but not yet every workflow
wrapper.

**Related guides:** [Normalization](NORMALIZATION.md) ·
[Language integration](LANGUAGE_INTEGRATION.md) ·
[CLI packaging](CLI_PACKAGING.md) ·
[Normative normalized events](specs/NORMALIZED_LOG_EVENTS_V1.md) ·
[README: CLI and log normalization](../README.md#cli-and-log-normalization)

## Command grammar (verified against `--help`)

Top-level shape (regenerate any time with `contextdesk --help`):

```text
contextdesk [OPTIONS] <COMMAND>
```

### Global options

| Flag | Env | Purpose |
| ---- | --- | ------- |
| `--format text\|json\|jsonl` | `CONTEXTDESK_FORMAT` | Output shape |
| `--json` | | Shorthand for `--format json` |
| `--jsonl` | | Shorthand for `--format jsonl` |
| `--color auto\|always\|never` | `CONTEXTDESK_COLOR` | Color on stderr progress |
| `--config <path>` | `CONTEXTDESK_CONFIG` | Project CLI TOML (`.contextdesk.toml`) |
| `--app-config <path>` | `CONTEXTDESK_APP_CONFIG` | Shared `AppConfig` JSON path |
| `--data-dir <path>` | `CONTEXTDESK_DATA_DIR` | Isolate all process state (alias `--profile-dir`) |
| `--profile <id>` | `CONTEXTDESK_PROVIDER_PROFILE` | Provider profile |
| `--model <id>` | `CONTEXTDESK_CHAT_MODEL` | Chat model override |
| `-h` / `--help` | | Help |
| `-V` / `--version` | | Version (long form embeds git/channel when built with identity) |

### Subcommands on shipped tips

| Command | Role |
| ------- | ---- |
| `import <source>` | Import archive/dir into a durable corpus |
| `normalize <source> --output <dir>` | Offline raw → `normalized_log_events.v1` JSONL, manifest, and report (no durable corpus). See [NORMALIZATION.md](NORMALIZATION.md). |
| `normalized validate <file-or-dir>` | Read-only offline conformance gate over normalized JSONL; exit 9 when content is invalid. |
| `normalized summarize <file-or-dir>` | Aggregate-only offline conformance summary over normalized JSONL. |
| `corpus list\|show\|rename\|delete\|use` | Corpus management |
| `timezone status\|apply\|clear\|apply-all` | Ambiguous local time declarations |
| `explore <query>` (alias `search`) | Template-level search |
| `context` | Grounded evidence assembly without a model turn |
| `session list\|show` | Durable chat sessions |
| `chat <question>` (alias `ask`) | Grounded model turn |
| `config init\|validate\|show\|path` | CLI + shared config |
| `confluence …` | Optional Confluence connector |
| `capabilities` | Machine-readable build surface |
| `doctor` | Demo readiness |
| `logging-assessment [corpus-id]` (alias `assess`) | Deterministic logging-quality assessment with fixed finding-code improvement hints (no provider); defaults to the current corpus. |

Drift check: `python3 scripts/cli-release/check_cli_docs.py` compares this list
to a live binary when `CONTEXTDESK_BIN` is set.

## Happy path

```bash
contextdesk import <archive>
contextdesk ask "<question>"
```

The original `chat`, `explore`, and `logging-assessment` names remain stable.
The shorter `ask`, `search`, and `assess` aliases are equivalent conveniences:

```bash
contextdesk search "timeout"
contextdesk assess
```

A normal import needs no per-file selection — the CLI accepts the same
default preselection `cd_core::log_analysis::import_preview` computes for
every host, and routes ingest through the SAME production reviewed-format
bindings-aware entry point desktop uses
(`ingest_path_with_policy_bindings_and_observer`): if a durable reviewed
grammar you saved earlier confidently matches a source's content (checked
with `cd_core::log_analysis::reviewed_format::select_format`, the same
matcher the review UI uses — never a path-only guess), it is applied
automatically and named in the summary; otherwise the source imports
through ordinary format detection. `--explain-selection` prints exactly
what was included/excluded and why. Corpus management, timezone review, and
exploration are escape hatches for when the defaults aren't enough, never
required for the happy path.

`import` shows bounded, throttled progress on stderr (one live-updating
line on a real terminal; one line per phase transition when redirected),
and honors Ctrl-C: cancelling publishes nothing (ingest's private staging
directory is cleaned up via `Drop` regardless of where cancellation lands)
and the same import can be retried immediately. The final summary reports
exactly what happened — entries examined, sources selected vs.
ignored/unsupported/excluded/failed, events imported, templates, detected
formats, timestamp provenance, whether the import was partial, any
reviewed formats that were applied, and any sources still needing a
timezone declaration.

State shared with the desktop app (provider profiles, the configured
default timezone, imported corpora, chat sessions) lives in the same files
both hosts read: `~/.contextdesk/config.json`, `~/.contextdesk/cache/`,
`~/.contextdesk/sessions/`. A corpus imported from one host is immediately
visible from the other.

## Repeatable provider rehearsal

`scripts/cli-live-provider-rehearsal.sh` is a public, data-free acceptance
rehearsal for the full CLI story. Its generated ZIP contains two synthetic
JSON log events plus one binary attachment, so the run proves automatic
selection as well as import, exploration, context assembly, and trace
rendering. It never reads an existing corpus or log source.

The default offline mode makes no provider request:

```bash
scripts/cli-live-provider-rehearsal.sh
```

Live mode copies only `config.json` from an already configured ContextDesk
data directory into a disposable profile. Credentials remain in the OS
keychain; corpus and session state from the source profile are neither read
nor changed. It then performs two corpus-linked questions in one durable
session and fails unless both turns execute a successful native
`search_logs` call, finish grounded, emit valid full-trace JSONL, and retain
the same session id:

```bash
CONTEXTDESK_REHEARSAL_MODE=live \
CONTEXTDESK_REHEARSAL_DATA_DIR="$HOME/.contextdesk" \
scripts/cli-live-provider-rehearsal.sh
```

Set `CONTEXTDESK_REHEARSAL_BIN` to test a particular built binary and
`CONTEXTDESK_REHEARSAL_KEEP=1` to retain the disposable reports. The
deterministic companion test
`cargo test -p cd-cli --test live_provider_rehearsal` uses a local mock
gateway and additionally covers two GPT-OSS/OpenAI-compatible variations:
decoded object-shaped tool arguments and a gateway that returns ordinary
JSON despite `stream=true`.

## Readiness (`contextdesk doctor`)

One command's answer to "is everything ready for a demonstration right
now?":

```bash
contextdesk doctor
contextdesk --jsonl doctor --timeout 20
contextdesk doctor --skip-live-turn   # config/writable-state/connectivity only, never "ready"
```

Eight checks, run in the order below, each reusing existing production
code rather than re-implementing it. The order is deliberate:
`provider_connectivity` runs *last* — after the live-turn exercise, not
before it — so its own displayed result can be reconciled against that
exercise's outcome rather than potentially contradicting it (see the
reconciliation note below the table).

| Check | What it proves | Reuses |
| --- | --- | --- |
| `config` | A provider profile resolves (explicit `--profile`, the shared `AppConfig`'s active profile, or the built-in Ollama default) | `cd_workflow::provider::resolve_provider_profile` |
| `writable_state` | The resolved data directory (isolated or shared) can actually be written to, not just that it exists | a real write + read-back + delete of a marker file |
| `native_tool_calling` | The provider actually invokes the offered `search_logs` tool, not just that a request succeeds | `cd_workflow::chat::run_chat_workflow` |
| `grounding` | The resulting answer validates against real retrieved evidence | the same `linked_*` evidence-validation classification `chat --trace` already surfaces |
| `tracing` | `cd_core::turn_trace` actually captures a real provider call for the first turn | `cd_core::turn_trace::RecordingTurnTrace`, attached to the live turn |
| `session_continuity` | A second, genuinely contextual turn continuing the same session is persisted alongside the first (see below) | `cd_core::sessions::SessionStore`, a second `RecordingTurnTrace` |
| `cleanup` | The disposable corpus and session this run created were both actually removed | `cd_core::log_analysis::LogCorpus::discard`, `cd_core::sessions::SessionStore::delete` |
| `provider_connectivity` | The resolved profile's endpoint answers, reconciled against the live turn above | `cd_core::discovery::probe_provider` (via the same wrapper `config init --check-connection` uses — see caveat below) |

`native_tool_calling`, `grounding`, `tracing`, `session_continuity`, and
`cleanup` all come from one disposable exercise: a synthetic,
generated-only corpus (two clearly-marked `SYNTH_DOCTOR_READINESS_CHECK`
events, never real or private content) is created under the resolved data
directory and asked two real corpus-linked questions **against the
actually configured provider — never a mock** ("do not report success
without exercising the production path" is the whole point of this
command). Removing the corpus and any session it created is then its own
gating check (`cleanup`), attempted — and its result folded into
structured output, not only a stderr warning — on every path out of that
exercise: success, a provider failure, a timeout, and a Ctrl-C
interruption alike.

**`session_continuity` proves a genuinely contextual second turn, not
merely a second request that didn't error.** It requires all of: the
second turn continued the same session id; no error event and a clean
`stop` terminal outcome; a non-empty final answer; the session's persisted
message history grew by at least a user/assistant pair; and — captured via
the second turn's own, separate trace sink — the second request actually
carried the first turn's own synthetic correlation marker as context,
proof (provider-agnostic, since it checks for text this command itself
wrote rather than anything a model said) that real prior-turn context, not
just a bare follow-up question, reached the provider.

**`provider_connectivity` is reconciled against the live turn, not
emitted eagerly.** `cd_core::ai_probe::probe_ai_gateway` treats *any*
loopback base URL as "the well-known local Ollama" and reports it
unreachable if that specific daemon isn't listening there — which
misfires for a real local non-Ollama OpenAI-compatible gateway (LM
Studio, vLLM, a custom server) on `127.0.0.1`, and for every mock-backed
test. When `native_tool_calling`, `grounding`, `tracing`, and
`session_continuity` all pass — direct, authoritative proof the
configured provider actually works — a `provider_connectivity` failure
from the quick probe alone is reconciled to a `pass` (its message says so
explicitly: "confirmed reachable by the live turn's own successful
exchange...") rather than left standing as a check that would otherwise
contradict a `ready` verdict. A genuine live-path failure (any of those
four did not pass) leaves the probe's own verdict standing, still gating
readiness as before. This check never gates whether the live-turn
exercise itself runs — only its own final displayed status depends on
that exercise's outcome.

Each network-touching step (`provider_connectivity`, the live turn) is
bounded by `--timeout <seconds>` (default 30) via `tokio::time::timeout`;
a provider that never responds fails that check with an explicit
`"timed out after Ns"` message rather than hanging the command. Ctrl-C
aborts the whole run — reported the same way `import`'s interruption
already is (exit 130, `cancelled`), not folded into the ordinary
`pass`/`fail`/`skip` vocabulary, since the operator chose to abort rather
than the run finding something broken — cleanup is still attempted, and
its own outcome (whether it succeeded) is folded into the interrupted
report itself (the `--jsonl` `interrupted` line's `cleanup_status`/
`cleanup_detail` fields, an extra line in text mode, and the cancellation
message in every format), never silently only a stderr warning.

`--skip-live-turn` runs only `config` and `writable_state` (fast, no live
turn), reports `native_tool_calling`/`grounding`/`tracing`/
`session_continuity`/`cleanup` `skip`, and still runs the quick
`provider_connectivity` probe on its own (unreconciled, since there is no
live-turn evidence to reconcile it against) — a verdict is never `ready`
while a check went unverified.

Output: text mode prints one `[PASS]`/`[FAIL]`/`[SKIP]` line per check as
it completes, then a summary line. `--jsonl` streams one
`{"type":"check","id":...,"status":...,"message":...}` line per check as it
completes, then exactly one terminal line — `{"type":"verdict","ready":...,
"checks_passed":...,"checks_failed":...,"checks_skipped":...,"elapsed_ms":...}`
on completion, or `{"type":"interrupted","elapsed_ms":...,"cleanup_status":...,
"cleanup_detail":...}` if Ctrl-C aborted the run — never a bare untagged
object. `--json` prints one envelope with the full checks array and
verdict together at the end. Process exit code reflects the verdict, not
merely whether the command ran: `0` when `ready`, `8` (`not_ready`)
otherwise, `130` (`cancelled`) on Ctrl-C — a script can gate a demo on
`contextdesk doctor && start_demo.sh` directly. A `ready` result never
contains a check reported `fail` — that coherence is exactly what the
`provider_connectivity` reconciliation and the `cleanup` gating check both
exist to guarantee. Credentials are never displayed: the config check
never touches the keychain (it only needs `resolve_provider_profile`, not
`resolve_turn_inputs`), and the one short-lived key value the connectivity
probe and live turn each read is handed straight to the existing safe
functions that already never log it — nothing in this command ever writes
to `cli.toml` or the shared `AppConfig` either.

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

The same root also holds the durable **reviewed-format** store when used by import (`<data-dir>/cache/reviewed_formats` or the app-config-relative path the host opens for profiles under that data root).
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

### Streaming lines (`--jsonl`)

Every streaming command's own `type`-tagged vocabulary is closed and
command-specific — a reader must not assume one shared line grammar across
commands, only that every line always parses independently and the last
line is always the terminal one.

`chat`: `text_delta`, `tool`, `permission_required`, `turn_completed`,
`error`, `trace_summary`, `trace_context`, `trace_tool`, `activity`,
`context_used`, `done`. The line
tagged `done` is always last and appears exactly once — that holds on a
successful turn and on a failed one alike. On failure, the last two lines
are always `error` (the failure, `code`/`message`) then `done` with
`ok:false`; nothing else on stdout is ever a bare, untagged JSON object
under `--jsonl`. `trace_summary`/`trace_context`/`trace_tool` only appear
when `chat` was run with `--dry-run` and/or `--trace`; `activity` appears
when Activity projection is requested; and `context_used` is the bounded
host-computed context-plan summary when one was emitted — see below.

`doctor`: `check` (one per completed check), then exactly one terminal
line — `verdict` on completion, `interrupted` on Ctrl-C. See
[Readiness](#readiness-contextdesk-doctor).

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
| 8 | `not_ready` | `contextdesk doctor` completed its full check but the verdict was "not ready" — this is not a bug, the command did exactly what it promised. |
| 9 | `non_conforming` | `normalized validate` or `normalized summarize` completed and found invalid normalized content; inspect the emitted report. |
| 10 | `partial` | `normalize --fail-on-partial` published valid output but its report is partial; output is preserved. |
| 70 | `internal` | Unexpected failure — a bug, not an expected branch. |
| 130 | `cancelled` | The operation was interrupted by Ctrl-C before it finished (`import`, `normalize`, `doctor`, `chat`). |

Clap's own usage errors (bad flags, missing required args) use clap's
default exit code (2) and are not part of this table.

### Import progress stream (`--jsonl` on `import`)

See also the import command: phase transitions and a final result object form the documented JSONL stream contract.

## Command grammar (compact reference)

Verified by comparing to `contextdesk --help` / subcommand `--help` (see
`scripts/cli-release/check_cli_docs.py`).

```
contextdesk import <source> [--name NAME] [--embed] [--explain-selection]
contextdesk normalize <source> --output <dir> [--output-format jsonl]
            [--source-timezone <iana>] [--timezone-map '<json>'] [--strict-time]
            [--fail-on-partial]
            # Shipped; use `normalize --help` for the exact installed contract
contextdesk normalized validate <file-or-dir>
contextdesk normalized summarize <file-or-dir>
contextdesk corpus list
contextdesk corpus show <id>
contextdesk corpus rename <id> <name>
contextdesk corpus delete <id> --yes
contextdesk corpus use <id>
contextdesk timezone status [--corpus <id>]
contextdesk timezone apply <source> <iana-timezone> [--corpus <id>] --yes
contextdesk timezone apply-all <iana-timezone> [--corpus <id>] --yes
contextdesk timezone clear <source> [--corpus <id>]
contextdesk explore <query> [--corpus <id>] [--k N]
contextdesk context <query> [--corpus <id>] [--k N]
contextdesk session list
contextdesk session show <id>
contextdesk chat <question> [--corpus <id>] [--session <id>] [--new] [--auto-approve]
            [--context-selection <text>] [--dry-run]
            [--trace summary|context|full] [--trace-ack]
            [--activity summary|full] [--activity-ack]
contextdesk config init [--project] [--interactive|--non-interactive] [--force]
                        [--format <fmt>] [--color <mode>] [--default-provider-profile <id>]
                        [--skip-provider] [--provider-kind <kind>] [--base-url <url>]
                        [--chat-model <id>] [--default-timezone <iana-id>]
                        [--profile-id <id>] [--profile-label <label>]
                        [--api-key-env <var>|--api-key-file <path>|--api-key-stdin]
                        [--check-connection]
contextdesk config validate|show|path
contextdesk capabilities
contextdesk doctor [--timeout <seconds>] [--skip-live-turn]
contextdesk logging-assessment [corpus-id] [--report-format json|markdown] [--output <file>]
# Friendly aliases: ask=chat, search=explore, assess=logging-assessment
```

Global flags (available on every subcommand): `--format`, `--json`,
`--jsonl`, `--color`, `--config <path>`, `--app-config <path>`,
`--data-dir <path>` (alias `--profile-dir`), `--profile <id>`, `--model
<id>`.

## Quick examples (synthetic data only)

```bash
# Executable offline path
DATA=$(mktemp -d)
contextdesk --data-dir "$DATA" --json import ./fixtures/cli-release-demo
contextdesk --data-dir "$DATA" --json corpus list
contextdesk --data-dir "$DATA" --json corpus use <corpus-id-from-list>
contextdesk --data-dir "$DATA" --json explore "timeout" --k 10
contextdesk --data-dir "$DATA" --json context "what failed?" --k 10
contextdesk --data-dir "$DATA" --json capabilities
contextdesk --data-dir "$DATA" doctor --skip-live-turn   # exit 8 expected without live checks

# Logging quality assessment (synthetic import first)
# contextdesk --data-dir "$DATA" logging-assessment <corpus-id> --json
# contextdesk --data-dir "$DATA" logging-assessment <corpus-id> --report-format markdown --output plan.md

# Timezone (after import of ambiguous local logs)
contextdesk --data-dir "$DATA" timezone status --corpus <id>
contextdesk --data-dir "$DATA" timezone apply-all America/Chicago --corpus <id> --yes

# Chat (requires provider — not offline)
contextdesk --data-dir "$DATA" chat "summarize timeouts" --corpus <id>

# Normalize (requires normalize subcommand on binary)
# contextdesk normalize ./fixtures/cli-release-demo --output ./out-norm --json
# contextdesk normalized validate ./out-norm
# contextdesk --json normalized summarize ./out-norm
# Exact files: out-norm/manifest.json, normalization-report.json, sources/*.jsonl
# Full guide: docs/NORMALIZATION.md
```

## `chat --dry-run` / `--trace` (inspecting a turn without sending it, or alongside sending it)

`--dry-run` constructs the exact same bounded, redacted conversation and
grounded log context a real turn would — the same profile resolution, session
load, corpus binding, system prompt, and tool-schema assembly — but
guarantees no provider request occurs: no chat completion, no Ollama health
probe, and no credential refresh (`ProviderKind::XaiGrokBuild` would otherwise
refresh an OIDC token over the network before a client even exists). This is
a property of the backend used under the hood
(`cd_core::turn_trace::DryRunBackend`, which holds no HTTP client, base URL,
or credential), not a flag checked at the last moment. A dry run never writes
anything: it never creates a session, and if `--session` names an existing
one, that session's saved file is left byte-for-byte untouched.

`--dry-run` implies `--trace summary` when `--trace` is not also given —
otherwise it would produce no output at all, since the dry-run backend never
produces real text.

`--trace {summary,context,full}` captures what a turn actually sent a
provider and renders it at the named level; each level includes everything
the level below it shows. Works with or without `--dry-run` — on a real turn
it captures the real request(s) alongside sending them.

- **`summary`** (`trace_summary`, one line): provider/model identity, corpus
  id + revision, history/retrieval message counts, evidence ids (deduped
  citation source ids), this model's context budget vs. characters actually
  sent, tools actually executed separately from tools merely offered, elapsed
  time, and a grounding
  status — `not_applicable` for an ordinary (unlinked) turn, `ungrounded` if
  the turn ended with one of the `linked_*` evidence-validation error codes,
  `grounded` otherwise. `tool_names` remains the backward-compatible union;
  new readers should use `tools_executed` and `tools_offered`. Evidence
  identities produced by the deterministic `broad_log_triage` host stage are
  emitted through the same governed citation stream as ordinary log-tool
  evidence, so `retrieved_evidence` no longer misleadingly reports zero for
  such a turn.
  `grounding_scope="citation_identity_only"` and
  `interpretation_validated=false` make the epistemic boundary explicit:
  a cited event was verified to exist, but ContextDesk does not claim that a
  model's interpretation, completeness, or root-cause diagnosis was proven.
- **`context`** (adds `trace_context`, one line per provider call — one for a
  dry run, one per round for a real multi-round turn): the exact bounded,
  redacted messages and tool names that call sent. Reading consecutive
  `trace_context` lines shows context added between rounds — round *N+1*'s
  messages include round *N*'s tool results, already folded into history the
  same way a real turn folds them.
- **`full`** (adds `trace_tool`, one line per tool call the turn actually
  made): id/name/ok/summary/detail — the same bounded data a UI's tool
  lifecycle display already has, correlated by round rather than dropped.
  Requires `--trace-ack`: refused otherwise with a `user_error` naming what
  full trace exposes. Raw JSON tool-call *arguments* are not part of any
  trace level — only the outcome (summary/detail) already surfaced to a UI.

No trace level, at any depth, ever includes a credential, an HTTP
authorization header, or pre-redaction content. Every captured message is
passed through the same secret-scrubbing pass memory writes use
(`crate::redact::scrub_secrets`) and length-bounded (4,000 characters per
message, 50 messages, 64 tool names per call) before it is captured at all —
structurally true regardless of trace level, not something a renderer has to
remember to apply. Provider API keys and HTTP headers cannot reach this
capture point in the first place: the traced boundary
(`ChatBackend::complete`) takes only `(&[ChatMessage], &[ToolSpec])`, never a
credential.

```json
{"type":"trace_summary","provider_profile_id":"ollama-local","chat_model":"mistral","corpus_id":null,"corpus_revision":null,"dry_run":true,"history_messages":3,"retrieved_evidence":0,"evidence_ids":[],"context_budget_chars":120000,"context_used_chars":828,"tool_names":["search_kb"],"tools_executed":[],"tools_offered":["search_kb"],"elapsed_ms":2,"grounding":"not_applicable","grounding_scope":"not_applicable","interpretation_validated":false}
```

## `chat --activity` / `--context-selection`

`--activity {summary,full}` projects the **shared** Activity Inspector
contract (`cd_core::activity`) for this turn — the same model the desktop
inspector uses, not a CLI-only reimplementation. Summary retains counts,
phases, origins, tool names, and timings (never message bodies). Full
adds opt-in redacted, hard-bounded provider message bodies already
scrubbed by `cd_core::turn_trace` and requires `--activity-ack`.

Activity capture is **process-lifetime** for the turn: it is not a durable
session transcript. Durable state after quit is corpus/session/investigation
only (see [`DEMO_ACCEPTANCE.md`](DEMO_ACCEPTANCE.md)).

`--context-selection <text>` attaches explicit one-turn client evidence for
an **ordinary** (unlinked) chat. It is not saved as transcript text and is
never inferred from ambient or corpus state. Linked-log turns must use
host-resolved corpus evidence instead.

```bash
contextdesk chat "summarize selection" --new \
  --context-selection "host-pasted evidence for this turn only" \
  --activity summary --trace summary
```

## Permission prompts (`chat`)

A grounded turn's tool calls can require permission (writes, remote
fetches). In an interactive terminal, `chat` prompts synchronously and
grants exactly one call at a time (`AllowOnce` — never a standing grant
from a single answer). In a non-interactive process (no tty, e.g. CI), the
default is to **deny and say so on stderr** — never silently proceed as if
granted. `--auto-approve` is the explicit scripting/CI escape hatch that
grants every request; it is never the interactive default.

## Interactive-terminal rendering (`chat`)

Presentation only — nothing here changes a turn's behavior, a tool call's
meaning, or any byte of `--json`/`--jsonl` stdout (see [Output](#output)
above); it only decides what a human watching a real terminal sees on
**stderr** while `--format text` (the default) is in effect.

A bounded stderr status line tracks the shared lifecycle events the turn
already emits (the same ones `--jsonl` serializes and `--trace` inspects):
connecting to the provider, assembling context, waiting on the model,
running tools (with a live done/started count), validating grounded
evidence after a synthesis retry, and saving the session — each with
elapsed time. Once the reply itself starts streaming to stdout, this status
line stops printing entirely — the streaming reply is now the visible
activity, and any further phase change (a tool call, a synthesis retry,
saving the session) only updates its counters internally, silently, since
even a plain appended stderr line could land mid-word on the same shared
terminal cursor the streaming reply owns. The turn ends with one concise
result line: `done`/`cancelled`/`failed`, the session id, a precise human
label (`citations checked; interpretation unverified`, `citation check
failed`, or `no corpus evidence check`), and the tool count — printed
on its own fresh line even after a streamed reply that never ended in a
newline itself (a leading line break precedes `cancelled`/`failed`
specifically for this; `done` reuses the newline the reply's own text
already ends with).

The renderer degrades to bounded, ANSI-free, one-line-per-transition
output — never an overwriting redraw — whenever stderr is redirected to a
file or pipe, `TERM=dumb`, or there is no controlling terminal at all (the
same rule `import`'s existing progress line already follows). Color
follows `--color auto|always|never` (default `auto`). `--color never`
disables every ANSI cursor/color sequence, while `NO_COLOR`
(<https://no-color.org>) does the same under `auto`; an explicit
`--color always` still wins for terminals that support ANSI. Human output is
also scrubbed of model-supplied terminal control sequences, including escape
sequences split across streaming chunks. On Windows, human terminal text
uses ASCII-safe punctuation by default so legacy PowerShell code pages cannot
turn smart punctuation or citation brackets into mojibake. Set
`CONTEXTDESK_ASCII=0` to retain Unicode typography, or
`CONTEXTDESK_ASCII=1` to request ASCII on any platform. Structured JSON and
JSONL remain unmodified UTF-8 data; when inspecting them directly in Windows
PowerShell, set its output encoding first:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
```

Ctrl-C during `chat` sets the same
cooperative cancel flag `run_chat_workflow` already accepts (the same
mechanism `contextdesk doctor`'s own live-turn checks use, see
[Readiness](#readiness-contextdesk-doctor) above), gives the turn a
bounded grace period to notice it and wind down, and then reports
`cancelled` (exit code 130) unconditionally — never re-derived from
whatever the in-flight turn happened to settle to internally, so an
interrupted turn is never mistaken for, or rendered as, a completed one. A
second Ctrl-C while that wind-down is in progress is not handled again —
the same documented limitation `import` already has, below.

## Timezone handling

Local timestamps with no resolvable zone are never guessed. Two honest
paths resolve them, both recorded with accurate provenance
(`cd_core::log_analysis::timezone_resolution::TimezoneDeclarationBasis`):

- **Configured default** — set `default_timezone` in the shared
  `AppConfig` (`~/.contextdesk/config.json`, the same file the desktop
  Settings UI writes) and every source left ambiguous after an import is
  resolved automatically, in one atomic revision bump, recorded as
  `ConfiguredDefault` — honestly distinct from an in-the-moment human
  choice, never presented as one.
- **Explicit, grouped** — `contextdesk timezone apply-all <iana-timezone>
  --corpus <id> --yes` resolves EVERY currently-ambiguous source in a
  corpus with one command and one atomic revision bump (recorded as
  `UserDeclared`), instead of requiring `timezone apply` once per file.
  `timezone apply` (singular) remains for correcting one specific source.

Both the import-time auto-apply and `timezone apply-all` share one
implementation (`cd_workflow::timezone::apply_timezone_to_all_unresolved`)
— re-previewing every source fresh immediately before applying, so a
concurrent mutation between "decide" and "apply" fails the whole group
closed as a `conflict` rather than partially applying.

## Known limitations (tracked, not silent)

- `import --embed` is accepted by the grammar but returns `not_implemented`
  — `cd_workflow::import::default_import_with_observer` always ingests with
  no embedding. Import without `--embed`, then embed via the desktop app.
- `corpus rename` only changes the cosmetic display name
  (`cd_core::log_analysis::LogCorpus::rename`) — never identity, ingest data,
  or citations.
- No cross-corpus search — `explore`/`context` operate on one corpus at a
  time, matching every `cd_core::log_analysis` search API's shape.
- `chat` runs an ordinary or corpus-linked turn through
  `cd_workflow::chat::run_chat_workflow`; it does not yet expose the desktop
  app's fuller tool surface (clustering, timeline, anomalies) as CLI
  subcommands of their own.
- `chat --dry-run` forces ambient-memory recall off even when the profile
  would otherwise use it. Durable-memory injection embeds the query, and an
  `EmbedBackend` can itself be remote, which would violate the guarantee that
  no provider request occurs. A dry-run trace can therefore omit ambient-memory
  content that a real turn with the same profile would include.
- `chat --trace full` does not capture raw JSON tool-call *arguments* — only
  the same id/name/ok/summary/detail a UI's tool lifecycle display already
  has. Adding argument capture would require growing the `StreamEvent`
  protocol itself.
- `chat --trace` records backend calls in order but does not label a call as
  a genuine next round versus a capability-driven retry; both appear as
  `trace_context` lines.
- Reviewed-format auto-apply during import requires an unambiguous content
  match (`select_format` returns `Selected`, not `Conflict` or `NoMatch`). A
  tie or stale saved format leaves that source unbound rather than guessing;
  `reviewed_formats_applied` and `reviewed_format_warnings` report the result.
- Ctrl-C cancellation is handled once per `import` invocation. A second
  Ctrl-C while cleanup is still running falls through to the OS default
  instead of starting another graceful stage. Staging cleanup remains safe
  through `Drop`, and any orphan is swept by the next import.
- `chat`'s Ctrl-C handling has the same single-press limitation: a second
  Ctrl-C while the turn is still winding down falls through to the OS
  default rather than starting another graceful stage.
- `config init` writes the filesystem config and OS keychain through two
  systems without a shared transaction. It deliberately writes the keychain
  last, so rejected configuration never stores an orphaned credential. If
  the keychain write itself fails after both config files land, re-run
  `config init --force` with the same profile id to repair the reference.
- `--data-dir` isolates filesystem state only. Provider credentials always
  live in the OS keychain. The generated profile id is scoped by data dir,
  but an explicit `--profile-id` opts out by design; `xai-grok-build` uses a
  machine-wide session that cannot be isolated and is therefore refused by
  `--check-connection` under an isolated data directory.
- The desktop Tauri `agent_turn` command does not yet call
  `cd_workflow::chat::run_chat_workflow`, and the desktop does not consume
  CLI trace output. Both hosts use the same `cd_core` research/agent kernel;
  converging the remaining host orchestration is separate follow-up work.
- `doctor`'s `provider_connectivity` check inherits `cd_core::ai_probe`'s
  loopback-URL heuristic (see [Readiness](#readiness-contextdesk-doctor)):
  it always reports a loopback base URL unreachable unless the real local
  Ollama daemon answers there, even when a different, perfectly healthy
  local gateway is actually listening. The check never gates whether the
  live-turn checks run, and — since a later commit — its own final
  displayed status is reconciled to `pass` when those checks prove the
  provider actually works, so this heuristic's false negative can no
  longer stand as a check that contradicts a `ready` verdict; only when
  the live turn also did not fully succeed does this heuristic's own
  verdict still gate readiness.
- `doctor`'s `session_continuity` check verifies session id continuity, an
  error-free clean `stop` outcome, a non-empty answer, growth in the
  persisted history, and — via the second turn's own trace capture — that
  the second request actually carried the first turn's synthetic
  correlation marker as context. It does not evaluate whether the second
  answer's *content* is topically correct given the first — a model that
  produces a well-formed, contextually-threaded, evidence-free-of-errors
  reply that happens to be a non-sequitur still passes every one of these
  criteria. Fully verifying topical correctness would mean judging free-
  text answer quality, which is outside what a structural readiness check
  can do without becoming its own separate, fuzzy classification problem.
- `doctor`'s keychain write (when a resolved profile carries a credential
  it needs to read for the connectivity probe or live turn) is read-only —
  it never stores anything — so the two-system-transaction caveat that
  applies to `config init` does not apply here.
- `doctor`'s stated per-check timeout budget is not airtight against a
  genuinely hung credential backend. `SecretStore::get` is a synchronous
  trait method with no `.await` yield point, so a keychain read that never
  returns (an interactive-unlock prompt with no session to answer it,
  headless CI, a wedged secret-service daemon) cannot be preempted by
  `tokio::time::timeout` or Ctrl-C once it has started — the read is inside
  the timed region for `provider_connectivity`, so a slow-but-finite
  keychain still counts against the budget, but a truly hung one still
  blocks past it. This is a pre-existing characteristic of every command
  that resolves a credential (`chat`, `config init --check-connection`),
  not something specific to `doctor`; fixing it fully would mean making
  `SecretStore` async or wrapping every call site in `spawn_blocking`, a
  larger change than this tool's own scope.

## Architecture

```
React → Tauri host ───────────────► cd_core production engine
           └─ provider helpers ──► cd_workflow::provider ──► cd_core

CLI ──► cd_workflow (host-neutral workflows) ─────────────► cd_core
```

`cd-cli` calls `cd_workflow::{import, timezone, chat, provider, turn, tools}`
for every behavior those modules own. The Tauri desktop host's
provider-selection helpers (`provider_profile_for_turn`,
`model_tools_disabled_reason`, `model_tools_enabled` in
`desktop/src-tauri/src/lib.rs`) also delegate to `cd_workflow::provider`, and
an architecture test guards that boundary. Desktop import and chat still
wrap `cd_core` directly because they own Tauri-specific admission, streaming,
skills, window state, and review UI lifecycle.

`crates/cd-cli/tests/cli_workflow_parity.rs` and
`crates/cd-cli/tests/import_production_cli.rs` exercise the CLI adapter end to
end, while `crates/cd-workflow/tests/import_production.rs` exercises shared
import/timezone behavior against synthetic ZIP fixtures. The claim is shared
production logic, not identical host orchestration.

`doctor` (`crates/cd-cli/src/commands/doctor.rs`) is the same pattern
applied to preflight: it calls `cd_workflow::provider::resolve_provider_profile`,
`cd_core::discovery::probe_provider` (via `crate::provider_probe`, shared
with `config init --check-connection`), and
`cd_workflow::chat::run_chat_workflow` — the identical entry points `chat`
itself uses — rather than any readiness-specific reimplementation of
provider resolution, tool calling, or grounding classification.
`crates/cd-cli/tests/doctor_readiness.rs` proves each failure mode against
a local mock provider; `live_provider_rehearsal.rs` above is what proves
the same underlying two-turn, tool-calling, grounded, traced path works
end to end.
