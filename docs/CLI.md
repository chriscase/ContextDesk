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
visible from the other.

## Configuration

The CLI has its own, separate, versioned TOML configuration for CLI-only
preferences (output format, color, a preferred provider profile/model) —
**never credentials or provider secrets**, which stay exclusively in the OS
keychain and the shared `config.json`. See `crates/cd-cli/src/config.rs` for
the full schema.

Precedence, lowest to highest:

1. compiled-in defaults
2. global config (`~/.contextdesk/cli.toml`)
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
contextdesk config init|validate|show|path
contextdesk capabilities
```

Global flags (available on every subcommand): `--format`, `--json`,
`--jsonl`, `--color`, `--config <path>`, `--app-config <path>`, `--profile
<id>`, `--model <id>`.

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
