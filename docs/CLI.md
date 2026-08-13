# ContextDesk CLI

For ephemeral automation or CI, set `CONTEXTDESK_PROVIDER_API_KEY` for the
current process. It overrides provider credential lookup only; ContextDesk does
not persist or print the value, and connector credentials remain isolated.
Provider profiles may also select a protected `file:` reference. Keychain
remains available for profiles that explicitly use a Keychain reference.

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
contextdesk [OPTIONS] <QUESTION...>
```

A top-level question is normalized to the same production `chat` workflow;
it is not a second agent loop. Quote multi-word questions to keep shell
metacharacters literal. If a question begins with a command name such as
`import`, use explicit `contextdesk ask "import ..."` to disambiguate it.

### Global options

| Flag | Env | Purpose |
| ---- | --- | ------- |
| `--format text\|json\|jsonl` | `CONTEXTDESK_FORMAT` | Output shape |
| `--json` | | Shorthand for `--format json` |
| `--jsonl` | | Shorthand for `--format jsonl` |
| `--color auto\|always\|never` | `CONTEXTDESK_COLOR` | Color on stderr progress |
| `--no-color` | | Explicit shorthand for `--color never` |
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
| `models [discover\|verify]` | Offline model readiness by default; explicit catalog discovery and selected/all role verification when requested |
| `logging-assessment [corpus-id]` (alias `assess`) | Deterministic logging-quality assessment with fixed finding-code improvement hints (no provider); defaults to the current corpus. |
| `exception-episodes [corpus-id]` | Deterministic exception episode correlation (occurrence vs raw records; no provider). |
| `eval suites\|validate\|run` | Offline hermetic quality-evaluation fixtures (no config, Keychain, network, or readiness store). Does **not** measure live model usefulness or compatibility. File export uses `--report-format json\|jsonl` + `--output` (no clobber without `--force`). See [QUALITY_EVAL_HARNESS.md](benchmarks/QUALITY_EVAL_HARNESS.md). |
| `gateway diagnose` | Bounded direct-provider vs product-path differential for one explicitly selected model, plus a versioned checksummed diagnostic bundle. See [Gateway diagnostics](#gateway-diagnostics-contextdesk-gateway-diagnose) below. |

Drift check: `python3 scripts/cli-release/check_cli_docs.py` compares this list
to a live binary when `CONTEXTDESK_BIN` is set.

## Happy path

```bash
contextdesk import <archive>
contextdesk "<question>"
```

The direct form requires an active, existing corpus and an unambiguous
provider/model selection. A successful import makes its corpus current;
otherwise use `contextdesk corpus use <id>`. With multiple configured provider
profiles and no active profile, pass `--profile <id>` or choose a default in
configuration. Missing or stale selections fail before contacting a provider
and print the exact recovery command. The built-in local Ollama profile remains
the simple default when no provider profiles are configured.

The original `chat`, `explore`, and `logging-assessment` names remain stable.
The shorter `ask`, `search`, and `assess` aliases are equivalent conveniences:

```bash
contextdesk search "timeout"
contextdesk assess
contextdesk ask "What caused the outage?" --trace summary
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

## Gateway diagnostics (`contextdesk gateway diagnose`)

A bounded, provider-neutral diagnostic and synthetic-workflow suite for
**one explicitly selected model** (the existing global `--profile`/`--model`
selection — this command never implicitly probes a whole catalog). It
answers a narrower, more structural question than `doctor`: not "is
everything ready for a demo," but "for this exact model, does a gap sit at
the gateway/model layer, ContextDesk's own product-path integration, or
answer usefulness?"

```bash
contextdesk --profile work --model my-model gateway diagnose
contextdesk --profile work --model my-model gateway diagnose --yes --jsonl
contextdesk --profile work --model my-model gateway diagnose --yes --raw --raw-i-understand
```

Every check reuses an existing production path — never a second HTTP
client, a second agent loop, or a diagnostic-only imitation of triage:

| Lane | Reuses |
| --- | --- |
| Direct (smallest known-valid request through the raw provider backend) | `cd_workflow::capability_qualification::LiveQualificationTransport` + `cd_core::capability_qualification::run_qualification` — the same machinery `models verify` uses |
| Product (the equivalent case through the real ContextDesk workflow) | `cd_workflow::chat::run_chat_workflow`, `cd_core::turn_trace::RecordingTurnTrace`, the same disposable-corpus pattern `doctor` uses |
| Triage scoring | `cd_core::triage_quality::score_validated_investigation_answer` at the typed `investigation_answer.v1` authority boundary; legacy Markdown parsing remains only as a compatibility fallback |

**Basic-level cases** (default; `--level extended` re-attempts each
product-path case once more to observe retry/correction stability, never
expanding to more of the catalog): for a chat-role model,
`ordinary_generation`, `structured_response`, `tool_call_continuation`,
`attachment_selected_context`, and `linked_log_triage`. For a model whose
name hints at an embedding or reranker role, only
`embedding_or_rerank_contract` runs — chat-shaped requests are never sent
to a model not qualified for that role, and specialty requests are never
sent to a model not selected for that role.

`linked_log_triage` seeds a disposable corpus containing an initiating
trigger, a louder downstream symptom, an independent ERROR decoy, WARN noise,
and a recovery event — the known-truth key (trigger/symptom/decoy tokens,
whether root cause is establishable) lives only in the host-side scorer, never
in model-visible input — then scores the host-validated typed answer for
citation identity, trigger-vs-symptom separation, decoy separation, and
honest abstention rather than exact wording. The diagnostic prompt itself must
remain free of evaluator IDs so it exercises the same broad-triage classifier
as a real user request.

**Classification** (evidence, not infallible proof of a single cause) per
case: both lanes failed (`gateway_or_model_likely`), the direct lane passed
but the product lane failed (`product_integration_likely`), both executed
but a typed scorer failed (`usefulness_gap`), a correction/retry was needed
(`retry_required`), a host projection was internally inconsistent
(`diagnostic_fault`), or `compatible`. Three verdicts stay separate in the
final report — `gateway_model_compatible`, `product_workflow_compatible`,
`answers_useful` — and each has an explicit `*_status` of `pass`, `fail`, or
`inconclusive`. A diagnostic fault is not provider or usefulness evidence; the
affected dimensions remain inconclusive. The legacy Boolean fields are true
only for `pass`; a timeout or all-skipped run is therefore never reported as a
compatibility success. In extended mode every planned attempt must pass: a
mixed fail/pass sequence is explicitly fail-closed and remains
`retry_required`, never a usefulness pass. A quality gap never downgrades or
upgrades either compatibility verdict.

**Consent gate.** Before any network call, the planned case list, the
maximum request bound, the active deadline (`--timeout`, default 180s), and
the artifact classes this run will produce are shown; the operation then
requires an interactive `y` or `--yes` (required for any non-interactive
use, including `--json`/`--jsonl`).

**Deadline policy.** The deadline always bounds the whole diagnostic run.
When `--timeout` is omitted, each case also has a 45-second safety ceiling so
one accidentally stalled case cannot consume the default 180-second run. An
explicit `--timeout N` is treated as an intentional allowance for slow
gateways: each case may use the operation's remaining time, but can never run
past the explicit whole-run deadline. For example, `--timeout 600` no longer
silently imposes a 45-second case timeout. Request counts, attempt counts,
cooperative cancellation, cleanup, and activity tracing remain bounded and
unchanged.

**Credentials.** The selected profile's credential is resolved once for
the direct lane via the existing `SecretStore`/`ReferencedSecretStore`
path (works with a protected-file reference — no Keychain required); the
product lane resolves its own credential internally via
`cd_workflow::provider`'s existing per-turn cache, the same reused
mechanism every other live-turn command already uses, never a second
implementation. A credential value is never printed, logged, or written to
either artifact.

**Cleanup** of every disposable corpus/session this run created is
attempted on every exit path — success, a case failure, the overall
deadline, or Ctrl-C — and its own outcome (`cleanup.failures`) is reported,
not only a stderr warning. This command never mutates a pre-existing
corpus, session, or provider default.

**Artifacts.** A versioned, checksummed diagnostic directory
(`report.json` + `manifest.json` with a SHA-256 per file) is always
written, share-safe by default: no credentials, Authorization headers, raw
environment values, absolute paths, raw endpoint URLs, or exact private
profile/model ids — the profile and model identity are stable, run-local
pseudonyms, and the endpoint is a fingerprint
(`cd_core::capability_qualification::fingerprint_endpoint`), the same hash
`models verify`'s own reports already use. All lane/cleanup detail crosses one
provider-neutral `ShareSafeRedactionPolicy` boundary before text/JSONL output
and again before artifact serialization. Failed lanes retain a stable category
(`authentication`, `rate_limited`, `timeout`, `transport`, `invalid_response`,
`upstream`, `response_contract`, or a coarse fallback) but omit the raw
provider body. The persisted share-safe report omits the absolute host path;
local text/JSONL output may include the absolute artifact location so the
operator can open it, and should not be shared as an artifact. `--raw --raw-i-understand`
additionally writes an owner-only (`0600`/`0700` on Unix), local-only
`private/capture.json` with bounded synthetic case detail — never
credentials — that the share-safe bundle never references by content.

**Remaining privacy limits.** This policy is a diagnostic-artifact boundary,
not a general PII or proprietary-text classifier. It removes credential/header
shapes, arbitrary HTTP(S) endpoints, absolute POSIX/Windows paths, and the exact
selected profile/model identifiers; it intentionally does not attempt to find
names, email addresses, ticket numbers, relative paths, or other tenant data in
otherwise safe host-authored prose. Raw failure bodies are omitted rather than
trying to make arbitrary bodies safe. Endpoint fingerprints are deterministic,
so someone who already has a small candidate endpoint list can compare hashes.
Review artifacts before external sharing when those residual correlation risks
matter.

**Output.** Text prints a `[PASS]`/`[WARN]`/`[FAIL]`/`[FAULT]`/`[SKIP]` line per case
as it completes (colored when the terminal supports it and `NO_COLOR` is
unset; the bracketed label is always present regardless of color, and
`--color never`/redirected output/`TERM=dumb` fall back to plain ASCII).
`--jsonl` streams a `{"type":"plan",...}` line first, one
`{"type":"case",...}` line per completed case, then exactly one terminal
`{"type":"verdict",...}` line (or `{"type":"cancelled",...}` on Ctrl-C) —
never any ANSI bytes. `--json` prints one envelope with the full report.
Exit code: `0` when both compatibility verdicts hold and no measured
usefulness failure exists, `8` (`not_ready`) when either compatibility verdict
does not hold or `answers_useful_status=fail`, and `130` (`cancelled`) on
Ctrl-C. An `answers_useful_status=inconclusive` result is allowed for roles
without an answer scorer; it is not a pass claim.

**Known limitations.** The embedding/reranker product lane has explicit
Ollama, OpenAI-compatible, and Vercel v4 embedding dialects plus explicit
TEI and Vercel v4 reranker dialects. Remote retrieval is default-deny: a
configured role must carry an explicit `allow_remote` acknowledgment before
query or candidate text can leave the machine; loopback Ollama does not need
that acknowledgment. A role that lacks it is reported as
`egress_not_acknowledged` and the keyword/structured baseline remains usable.
These are compatibility and safety contracts, not claims of semantic quality;
live employer-model quality still requires a consented diagnostic run.

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

By default, imported credentials stay in the OS keychain (see
[Configuration](#configuration)), so those entries are scoped by *profile id*,
not by `--data-dir`. A profile configured with `--api-key-file-ref` instead
holds only an absolute reference to the selected owner-only file; no Keychain
entry is read or written for that profile. For Keychain-backed profiles,
`config init` accounts for isolation: an isolated profile's
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
never holds credentials or provider secrets. The shared `config.json` stores
only an explicit reference: either a Keychain id such as
`provider/<profile-id>/api_key` or an absolute protected-file reference such as
`file:/Users/you/.contextdesk/credentials/vercel.key`
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
contextdesk config deadline show       # whole-turn deadline policy (read-only)
contextdesk config deadline auto       # adaptive by provider class
contextdesk config deadline set 10m    # explicit whole-turn ceiling (90s, 3m, 10m, …)
```

### Whole-turn deadline

The whole-turn deadline is the **maximum** time one chat turn may run. ContextDesk
may finish sooner. Choosing, retrieval, and synthesis stay separately bounded
inside that ceiling (see the Proven Methods handbook).

**Precedence (effective ceiling for one turn):**

1. Per-turn CLI override (`chat --deadline` / direct-question `--deadline`)
2. Saved explicit policy (`config deadline set …`)
3. Adaptive policy (`config deadline auto`) — 3 minutes for managed providers,
   5 minutes for local/private-network profiles

Adaptive *latency learning* is **not** implemented; these commands only set
policy. Duration grammar: a positive whole number plus unit `ms`, `s`, or `m`
(examples: `500ms`, `90s`, `3m`, `10m`). Decimals, negatives, mixed units, and
values outside **500ms–10m** are rejected without clamping. `set` and `auto`
change only `router.deadline_ms` / `router.deadline_is_explicit` in the shared
`AppConfig`; they never rewrite credentials, profiles, or corpus settings.

```bash
contextdesk config deadline show
contextdesk config deadline set 10m
contextdesk chat --deadline 3m --dry-run "what happened?"
contextdesk --deadline 90s "what happened?"   # direct-question shorthand
```

`--deadline` applies **only to that turn** and never writes config. Invalid
durations fail before credential resolution or provider contact.

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
  `--api-key-file <path>` (read once and import into Keychain),
  `--api-key-file-ref <path>` (validate and use that owner-only mode-600 file
  directly without Keychain), or
  `--api-key-stdin` (read and trim one line from stdin) — read once, held
  in memory. Imported sources are committed to the OS keychain only as the single last
  fallible step of the whole command, strictly after both config files
  (`cli.toml` and the shared `AppConfig`) have already been written
  successfully. Omit all four to leave the profile without a credential
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

Direct-question text output buffers only the final answer projection, while
progress remains on stderr. It renders Markdown headings, lists, quotes,
tables, code blocks, and links/citations as readable terminal text, wrapping at
`COLUMNS` (bounded to sensible narrow/wide limits). Redirected output,
`--color never`, and `NO_COLOR` contain no ANSI sequences. UTF-8 content is
preserved; on legacy Windows consoles only problematic typography is reduced to
ASCII, while meaningful non-Latin text remains intact. Explicit `chat`/`ask`
keeps its existing streaming presentation. JSON and JSONL bypass the human
renderer entirely and are byte-for-byte governed by the existing contracts.

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

When a linked investigation completes, JSON output includes `investigation_answer` and JSONL
emits an `investigation_answer` line containing the same host-validated `AnswerEnvelopeV1`.
`final_text` is the host's deterministic Markdown projection of that envelope — readable
output, not authority. Scripts must read `investigation_answer`; they must not parse
`final_text`, or feed it (or a displayed envelope) back into a later chat turn as evidence
authority. Every new turn creates a fresh ledger.

Every streaming command's own `type`-tagged vocabulary is closed and
command-specific — a reader must not assume one shared line grammar across
commands, only that every line always parses independently and the last
line is always the terminal one.

`chat`: `progress`, `text_delta`, `tool`, `permission_required`,
`turn_completed`, `error`, `investigation_answer`, `multi_model_stage`,
`trace_summary`, `trace_context`, `trace_tool`, `activity`, `context_used`,
`done`. A `progress` line is the shared human-progress projection of the same
engine event sent to normal text and desktop hosts. It carries `category`
(`turn`, `phase`, `tool`, or `multi_model`), stable `stage` / `phase`, a concise
host label, `elapsed_ms`, and optional bounded diagnostics. Tool `started`
activity therefore arrives before its legacy terminal `tool` result, and
investigator/reviewer/synthesizer activity is visible while those stages run.
The line
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

Codes 8, 9, and 10 are completed verdicts: machine output retains an
`ok:true` report envelope even though the process exit is nonzero. Clients must
not rewrite these into `internal`; see [CLI_CLIENT_PROTOCOL.md](CLI_CLIENT_PROTOCOL.md).

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
                        [--api-key-env <var>|--api-key-file <path>|--api-key-file-ref <path>|--api-key-stdin]
                        [--check-connection]
contextdesk config validate|show|path
contextdesk capabilities
contextdesk doctor [--timeout <seconds>] [--skip-live-turn]
contextdesk models
contextdesk models discover
contextdesk models verify <model-id> [<model-id> ...]
contextdesk models verify --all [--role chat|embedding|reranker|unknown] [--match <text>] --yes
contextdesk logging-assessment [corpus-id] [--report-format json|markdown] [--output <file>]
contextdesk exception-episodes [corpus-id]
# Friendly aliases: ask=chat, search=explore, assess=logging-assessment,
#                   episodes=exception-episodes
```

Global flags (available on every subcommand): `--format`, `--json`,
`--jsonl`, `--color`, `--config <path>`, `--app-config <path>`,
`--data-dir <path>` (alias `--profile-dir`), `--profile <id>`, `--model
<id>`.

## Model readiness

`contextdesk models` is an offline view of the same role-specific readiness
shown in GUI model pickers. It reads AppConfig and the secret-free local
qualification evidence file; it does not contact a provider, enumerate a live
catalog, or read Keychain. JSON output reports `offline: true` and
`credentials_read: false` explicitly.

`contextdesk models discover` explicitly resolves the selected profile's
credential once, fetches its live catalog, classifies each id as a **name hint**
for chat, embedding, reranking, or unknown, and saves the secret-free inventory
for both the CLI and desktop app. Interactive `config init` offers this catalog
request immediately after gateway and credential entry, then lets the user
choose a chat candidate instead of requiring a memorized model id.

`contextdesk models verify` runs only synthetic compatibility requests. Exact
ids are the simplest way to test a handful on a large gateway. `--all` applies
after optional `--role` and `--match` filters, is sequential and cancellable,
and requires confirmation (`--yes` in non-interactive use). Bare interactive
selection narrows catalogs over 30 entries before showing numbered choices.
Completed results are saved after each model, so cancellation preserves useful
partial evidence. Multi-model runs are paced between models and stop if a
gateway reports rate limiting; an empty discovery response never replaces the
last good catalog or stales its evidence.

Startup/pre-flight reuses the catalog request it already performs as a drift
check. Added models appear unverified; removed models' prior evidence becomes
stale; unchanged exact-model evidence remains current. A changed catalog gets
its own preflight warning with an **Open AI settings** action. Catalog change
never silently starts token-spending verification.

`verified` means the current exact profile, endpoint fingerprint, model id,
role contract, and probe schema passed synthetic compatibility checks. The
current chat-role suite is specifically a **triage/investigation compatibility**
suite. It is not a claim about answer quality, ordinary-chat quality, text or
multimodal attachments, context length, or cost. Use CLI Verify or GUI
**Qualify selected model…** to create or refresh evidence. Pins and defaults
remain user-controlled even when another model is verified.

## Exception episodes and duplicate renderings

`exception-episodes` is a deterministic, offline analysis of an imported
corpus. It uses no provider and never rewrites, suppresses, or deletes raw
events:

```bash
contextdesk exception-episodes              # current corpus
contextdesk episodes <corpus-id>            # friendly alias + explicit corpus
contextdesk --json exception-episodes <corpus-id>
```

It reports v2 layers with typed completeness:

1. **Raw records** — durable exception-looking events and exact citations.
2. **Physical renderings** — full application stacks versus separately
   wrapped stderr/line records (including WildFly `[stderr] (thread)` lanes).
3. **Application propagation chains** — multi-app wraps/rethrows under typed
   execution evidence (trace/request/thread) with fail-closed boundaries.
4. **Strongly supported derived episodes** — chain↔stderr unique matches
   (forced/reciprocal only); never bare “N incidents”.
5. **Families** — bounded signature buckets of retained correlation groups.

For schema compatibility, JSON fields named `occurrenceCount` and
`semanticOccurrences` count **retained correlation groups**. Those groups
include uncorrelated standalone renderings when matching fails closed; they are
not semantic-episode or independent-incident totals unless
`semantic_counts_certified=true`. Human and model-facing text labels them as
retained groups and withholds the certified semantic total otherwise.

Completeness fields separate `scan_complete`, `renderings_complete`,
`correlation_complete`, `citations_complete`, `structural_coverage_complete`,
and `semantic_counts_certified`. The deprecated v1 `counts_complete` alias
means scan+render completeness only and does **not** alone authorize exact
semantic totals. Broad triage exposes an exact derived episode count only when
`semantic_counts_certified=true`.

A certified success line looks like:
`56 strongly supported derived episodes · 448 renderings · 15,232 underlying records`.

Treat the result as incomplete whenever `counts_complete=false` or
`partial=true`. `uncertain=true` and `matching_ambiguous=true` disclose weaker
correlation geometry rather than silently forcing a single explanation. A
family is a correlated signature group, not proof of business root cause;
chat synthesis can use these host facts but still labels interpretation as
unverified.

This distinction matters for application servers that emit one exception as
both a normal multiline log entry and hundreds of individually wrapped stderr
frames. ContextDesk preserves all those records while reporting strongly
supported derived episodes separately. It never presents retained groups or
record amplification as independent outages.

## Ingest-pipeline provenance (stale corpora)

New corpora persist `ingestPipelineIdentity` (e.g.
`contextdesk.ingest_pipeline.v1`) in `meta.json`; CLI JSON projects it as
`ingest_pipeline_identity`. This is a **semantic** stamp for
parse/frame/normalize/template/storage behavior — **not** the Git SHA from
`capabilities.git_sha`.

| `ingest_pipeline_compatibility` | Meaning |
| ------------------------------- | ------- |
| `current` | Matches this binary’s pipeline identity |
| `legacy_unknown` | Field missing/empty (pre-provenance corpora) — still fully usable |
| `different_version` | Present but ≠ current (or soft-failed malformed) — still usable |

`corpus list` / `corpus show` expose both fields in JSON. Human text adds a
PIPELINE column and an optional reimport note; `--json` / `--jsonl` never mix
that prose into the envelope. `capabilities` reports this binary’s
`ingest_pipeline_identity` + `ingest_pipeline_semantics`.

**Decide whether to reimport:** if Explorer/chat results look wrong after a
framing/parser fix, reimport the same public sources into a **new** corpus.
ContextDesk never auto-reimports, deletes, or mutates the old one. Keep the
legacy corpus if you need historical evidence as-imported.

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

# Exception volume versus independent occurrences (offline, deterministic)
# contextdesk --data-dir "$DATA" exception-episodes <corpus-id>
# contextdesk --data-dir "$DATA" --json episodes <corpus-id>

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

In **text** mode the CLI prints a nested human hierarchy (Turn → Context →
Model round → Tools offered / Tool call → Arguments / Result → Outcome /
Final status) using ASCII tree characters by default on Windows and whenever
stdout is redirected, `TERM=dumb`, or `NO_COLOR` applies under `--color auto`.
Capable TTYs may use sparse semantic color and, when
`CONTEXTDESK_ASCII=0`, Unicode box-drawing. JSON and JSONL keep the same
byte-compatible `trace_summary` / `trace_context` / `trace_tool` schemas —
human rendering never changes those shapes. Tool-call JSON *arguments* are
not retained by the contract; the human renderer says so explicitly rather
than inventing them.

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
  Linked-log turns also include a typed `context_budget_telemetry` snapshot:
  hard and packing budgets, reserved/free generation space, evidence and
  history retained/omitted counts, capacity source, useful-headroom verdict,
  and model-round identity. Text mode nests these facts under **Context**;
  JSON/JSONL expose the same additive object without parsing display text.
  When a provider-backed turn runs, an additive `provider_telemetry` object
  carries the same host-neutral `ProviderTurnTelemetry` DTO Tauri receives as
  EventDto kind `provider_telemetry` (configured profile/model scrubbed and
  length-bounded, response model, safe request id, observed route or explicit
  `unknown`, per-round transport preserved, turn-level token/cost sums only
  when every round reports that metric, context budget fold-in, application
  round count, and retry reasons only for causal application retries — never
  ordinary tool continuations). Missing usage or cost stays omitted (unknown),
  never zero-filled or inferred from the configured model.
- **`context`** (adds `trace_context`, one line per provider call — one for a
  dry run, one per round for a real multi-round turn): the exact bounded,
  redacted messages and tool names that call sent. Reading consecutive
  `trace_context` lines shows context added between rounds — round *N+1*'s
  messages include round *N*'s tool results, already folded into history the
  same way a real turn folds them. Each line may also carry additive
  `provider_round_telemetry` for that round.

Trace summary timing keeps two scopes explicit: `turn_elapsed_ms` is the
whole CLI turn wall time, while `provider_call_elapsed_ms_sum` adds the
durations of all recorded provider calls. The latter is accumulated call
time, not a turn-relative timestamp, and may exceed turn wall time if provider
calls execute concurrently. The older `elapsed_ms` field remains as a v1
compatibility alias for its historical provider-call-total behavior; new
consumers should use the explicitly named fields.

- **`full`** (adds `trace_tool`, one line per tool call the turn actually
  made): id/name/ok/summary/detail — the same bounded data a UI's tool
  lifecycle display already has, correlated by round rather than dropped.
  Requires `--trace-ack`: refused otherwise with a `user_error` naming what
  full trace exposes. Raw JSON tool-call *arguments* are not part of any
  trace level — only the outcome (summary/detail) already surfaced to a UI.

  When bounded multi-stage comparison exhausts its one semantic correction,
  the finished `broad_log_triage_multi_stage` tool detail is a JSON object with
  schema `contextdesk.multi_stage_triage.v1`, stage `final_comparison`, outcome
  `validation_failed`, ordered content-free `validation_errors`, and the
  host-counted `semantic_attempts` and `provider_rounds`. These categories
  identify failures such as `parse`, `wrong_scope`, or `unknown_evidence`
  without retaining the rejected model proposal, evidence text, paths,
  headers, credentials, or provider error bodies.

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
{"type":"trace_summary","provider_profile_id":"ollama-local","chat_model":"mistral","corpus_id":null,"corpus_revision":null,"dry_run":true,"history_messages":3,"retrieved_evidence":0,"evidence_ids":[],"context_budget_chars":120000,"context_used_chars":828,"tool_names":["search_kb"],"tools_executed":[],"tools_offered":["search_kb"],"elapsed_ms":2,"turn_elapsed_ms":7,"provider_call_elapsed_ms_sum":2,"grounding":"not_applicable","grounding_scope":"not_applicable","interpretation_validated":false}
```

## `chat --activity` / `--context-selection`

`--activity {summary,full}` projects the **shared** Activity Inspector
contract (`cd_core::activity`) for this turn — the same model the desktop
inspector uses, not a CLI-only reimplementation. Summary retains counts,
phases, origins, tool names, and timings (never message bodies). Full
adds opt-in redacted, hard-bounded provider message bodies already
scrubbed by `cd_core::turn_trace` and requires `--activity-ack`.

In **text** mode Activity prints on stderr as a nested causal hierarchy
(Turn → Phase → Model round → Tool call lifecycle → Final status), after
the status `done`/`failed`/`cancelled` line, so progress never interleaves
with the hierarchy. When Activity is requested without Trace, the latest
typed context-budget snapshot is nested under **Context** in the same tree;
requesting both avoids printing that snapshot twice. Pipe/`TERM=dumb`/
`NO_COLOR` stay ANSI-free ASCII.
JSON and JSONL expose the same typed activity data unchanged.

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

### Human trace / activity smoke (Bash, PowerShell, redirected)

```bash
# Bash — capable TTY (nested ASCII/Unicode hierarchy on stdout/stderr)
contextdesk chat "ping" --new --dry-run --trace summary --activity summary

# Redirected — stable plain lines, no ANSI / no cursor movement
contextdesk chat "ping" --new --dry-run --trace context --activity summary \
  > /tmp/trace.txt 2> /tmp/activity.txt
# JSON/JSONL schemas unchanged:
contextdesk chat "ping" --new --dry-run --trace summary --format jsonl | head
```

```powershell
# PowerShell — UTF-8 console first; ASCII tree is the Windows default
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
contextdesk chat "ping" --new --dry-run --trace summary --activity summary
# Force ASCII even on a Unicode-capable console:
$env:CONTEXTDESK_ASCII = "1"
contextdesk chat "ping" --new --dry-run --trace summary
# Redirected file capture stays plain:
contextdesk chat "ping" --new --dry-run --trace summary *> trace-activity.txt
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

For a corpus-linked text turn, the CLI buffers the finished answer and emits
a compact investigation report: the question, analyst model, elapsed time,
grounding state, validation tier, and the model's formatted observations,
candidate causes, symptoms, competing explanations, recovery signals, and
missing evidence. A typed host envelope is labeled `HOST-VALIDATED`; a
nonempty narrative without that envelope is still shown as
`PROVISIONAL — human review recommended` rather than discarded. This report
is presentation-only: `--json` and `--jsonl` retain their stable envelope
and streaming contracts.

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
- `chat` is a one-shot host and does not retain the desktop app's private,
  memory-only synthesis checkpoint. If synthesis times out or the provider
  fails after retrieval, the CLI terminal reports that no synthesis-only
  retry is available and that rerunning the investigation repeats bounded
  retrieval. A durable CLI synthesis retry remains tracked under #759;
  `--session` persists conversation history, not this ephemeral checkpoint.
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
- `--data-dir` isolates ContextDesk-managed filesystem state. Provider
  credentials use the profile's explicit Keychain or protected-file reference.
  The generated Keychain profile id is scoped by data dir, but an explicit
  `--profile-id` opts out by design; `xai-grok-build` uses a
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
