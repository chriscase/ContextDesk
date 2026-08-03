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

One JSON object per line, tagged by `type`: `text_delta`, `tool`,
`permission_required`, `turn_completed`, `error`, `trace_summary`,
`trace_context`, `trace_tool`, `done`. Every line parses independently; a
reader must not assume line count or ordering beyond "the line tagged `done`
is last, and appears exactly once" — that holds on a successful turn and on a
failed one alike. On failure, the last two lines are always `error` (the
failure, `code`/`message`) then `done` with `ok:false`; nothing else on
stdout is ever a bare, untagged JSON object under `--jsonl`.

`trace_summary`/`trace_context`/`trace_tool` only appear when `chat` was run
with `--dry-run` and/or `--trace` — see below.

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
                  [--dry-run] [--trace summary|context|full] [--trace-ack]
contextdesk config init|validate|show|path
contextdesk capabilities
```

Global flags (available on every subcommand): `--format`, `--json`,
`--jsonl`, `--color`, `--config <path>`, `--app-config <path>`, `--profile
<id>`, `--model <id>`.

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
  sent, distinct tool names offered or called, elapsed time, and a grounding
  status — `not_applicable` for an ordinary (unlinked) turn, `ungrounded` if
  the turn ended with one of the `linked_*` evidence-validation error codes,
  `grounded` otherwise.
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
{"type":"trace_summary","provider_profile_id":"ollama-local","chat_model":"mistral","corpus_id":null,"corpus_revision":null,"dry_run":true,"history_messages":3,"retrieved_evidence":0,"evidence_ids":[],"context_budget_chars":120000,"context_used_chars":828,"tool_names":["search_kb"],"elapsed_ms":2,"grounding":"not_applicable"}
```

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
- `chat --dry-run` forces ambient-memory recall off even when the profile
  would otherwise use it — durable-memory injection embeds the query, and an
  `EmbedBackend` (e.g. `OllamaEmbedBackend`) can itself be a remote provider,
  which the "no provider request occurs" guarantee cannot assume is safe to
  call. A dry run's traced context can therefore omit ambient-memory content
  a real turn with the same profile would include.
- `chat --trace full` does not capture raw JSON tool-call *arguments* — only
  the same id/name/ok/summary/detail a UI's tool lifecycle display already
  has. Adding argument capture would mean growing the `StreamEvent` protocol
  itself (`docs/PROTOCOL.md`), which this trace feature deliberately did not
  do.
- `chat --trace`'s round/call model is per backend call, not a labeled
  "round vs. retry" distinction — a capability-driven retry (e.g. a
  tools-unsupported fallback) and a genuine next round both appear as their
  own `trace_context` line, in call order, without a field claiming to know
  which is which.

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
