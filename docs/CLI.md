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

### Streaming lines (`--jsonl`)

One JSON object per line, tagged by `type`.

- `chat`: `text_delta`, `tool`, `permission_required`, `turn_completed`,
  `error`, `done`. `done` is always last.
- `import`: `progress` (schema version 1 — the same
  `cd_core::process_progress::ProcessProgress` struct desktop broadcasts
  over Tauri IPC, flattened onto the line) and `ingest_evidence` (one typed,
  bounded, privacy-safe omission/failure observation per excluded or failed
  source — `cd_core::process_progress::LogIngestEvidence`), followed by the
  ordinary one-shot `import` envelope as the final line.

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
| 130 | `cancelled` | Interrupted by Ctrl-C before it finished. Matches the conventional Unix SIGINT exit code so an existing `$? == 130` script check keeps working. Nothing was published; safe to retry the same command. |
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
contextdesk timezone apply-all <iana-timezone> [--corpus <id>] --yes
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
- Reviewed-format auto-apply during import requires an UNAMBIGUOUS content
  match (`select_format` returns `Selected`, not `Conflict`/`NoMatch`) — a
  tie between two saved formats, or a saved format that no longer matches
  a source's content, means no binding is applied for that source, not a
  guess. This is intentional, not a bug: see `reviewed_formats_applied` in
  the import summary for exactly what was (and wasn't) bound.
- Ctrl-C cancellation is handled once per `import` invocation (a single
  `tokio::signal::ctrl_c()` listener) — a second Ctrl-C sent while cleanup
  is still in progress falls through to the OS default (immediate
  termination) rather than a second graceful stage. Cleanup is still safe
  in that case (ingest's staging directory is removed via `Drop`, and any
  orphan is swept on the next import), just less graceful.

## Architecture

```
React → thin Tauri adapter ─┐
                             ├─► cd_workflow (shared, host-neutral) → cd_core
CLI  → thin CLI adapter   ──┘
```

`cd-cli` calls `cd_workflow::{import, timezone, chat, provider, turn,
tools}` for every behavior those modules already own. The Tauri desktop
host's provider-selection helpers (`provider_profile_for_turn`,
`model_tools_disabled_reason`, `model_tools_enabled` in
`desktop/src-tauri/src/lib.rs`) delegate to `cd_workflow::provider` for the
same reason — both hosts share one implementation, not two that merely
look equivalent; `crates/cd-workflow/tests/architecture_tauri_delegates_to_shared_provider_logic.rs`
guards against that regressing. `crates/cd-cli/tests/cli_workflow_parity.rs`
and `crates/cd-cli/tests/import_production_cli.rs` exercise the CLI binary
end to end (including a real Ctrl-C signal) to prove the adapter stays
thin; `crates/cd-workflow/tests/import_production.rs` exercises the shared
import/timezone logic directly against synthetic ZIP fixtures (nested
archives, duplicate basenames, selection drift, reviewed bindings, mixed
partial imports, cancellation + retry).
