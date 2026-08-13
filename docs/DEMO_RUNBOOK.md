# Demo runbook (public fixtures only)

Repeatable **10–15 minute** rehearsal for ContextDesk on the tip you built.
Public / synthetic fixtures only — never private or company corpora, and never
import a Log Lab `truth/` directory.

| Path | Kind | Provider needed? |
| ---- | ---- | ---------------- |
| [GUI path](#1-gui-path-manual-10–15-min) | **Manual** (native desktop) | Yes for grounded chat |
| [CLI path](#2-cli-path-automated-proof-10–15-min) | **Automated** (copy/paste) | Optional (`chat --dry-run` needs a configured profile shape; live chat needs a working provider) |

**Tip identity:** confirm the built binary matches the commit you intend to demo:

```bash
git rev-parse HEAD
./target/debug/contextdesk --json capabilities
# Expect data.git_sha prefix matching HEAD; commands must include import,
# normalize, corpus, timezone, explore, context, chat, doctor, and
# logging-assessment, and exception-episodes.
```

Related: [DEMO_ACCEPTANCE.md](DEMO_ACCEPTANCE.md) (longer GUI checklist +
exact-head consolidator), [CLI.md](CLI.md), [NORMALIZATION.md](NORMALIZATION.md),
Help [demo datasets](help/log-analysis/demo-datasets.md).

---

## Deterministic host vs LLM

| Work | Who does it | Notes |
| ---- | ----------- | ----- |
| Import, source selection, redaction, templates, corpus publish | **Host (deterministic)** | Same inputs → same corpus counters; no model |
| Timezone status / apply / apply-all | **Host (deterministic)** | Explicit operator declaration; no silent guessing |
| `explore`, `context`, Log Explorer search/filter/lanes | **Host (deterministic)** | Retrieval and evidence assembly on the host |
| `normalize` → JSONL + manifest + report | **Host (deterministic)** | Offline; zero provider / keychain |
| `exception-episodes` | **Host (deterministic)** | Separates raw exception records, physical renderings, retained correlation groups, certified derived episodes, and families; preserves raw citations |
| Activity Inspector / `chat --activity` | **Host capture** of a turn | Process-lifetime; not durable after quit |
| Grounded answer text in `chat` / desktop chat | **LLM** (when not `--dry-run`) | Model synthesizes; citations must still resolve to **host** evidence ids |
| `chat --dry-run` | **Host only** | Builds bounded context; guarantees no provider request |

Do not present model prose as proof that ingest or retrieval worked. Use corpus
counters, explore/context hits, Evidence chips, and Activity counts for that.

---

## Fixtures (safe roots only)

| Fixture | Use for |
| ------- | ------- |
| `fixtures/cli-release-demo/` | Tiny smoke (6 events, explicit UTC wall times) |
| `fixtures/log-lab/scenarios/company-timestamp-diversity/import/` | Timezone review (ambiguous local timestamps) |
| `fixtures/log-lab/scenarios/mixed-time-quality/import/` | Mixed wall + order-only time quality (no TZ apply needed) |
| Packaged first-run demo corpus (desktop) | GUI-only convenience install — see Help demo datasets |

**Never** import `…/truth/` or a scenario parent that contains `truth/`.

---

## 1. GUI path (manual, 10–15 min)

Label: **[MANUAL GUI]** — not claimed by CLI scripts.

### Prerequisites

1. Build / launch desktop from this tip (see [README → Install](../README.md#install)
   and [DEV.md](DEV.md)).
2. **[MANUAL GUI]** Settings → AI: configure a provider with tool capability
   (Ollama, OpenAI-compatible, Anthropic, or Grok Build opt-in). Save key via
   host keychain prompts — never paste secrets into docs or chat.
3. Optional readiness: from a checkout, `contextdesk doctor` (CLI) against the
   same machine’s config.

### Steps

1. **Import (~2 min) — [MANUAL GUI]**
   - Logs → import folder
     `fixtures/log-lab/scenarios/company-timestamp-diversity/import`
     (or Install demo log corpus on first-run Ready).
   - **Expect:** corpus appears in Logs library; import summary shows selected
     sources; `timezone_ambiguous` / review UI for zone-less locals when present.

2. **Timezone review when needed (~2 min) — [MANUAL GUI]**
   - If the UI offers timezone review, apply one IANA zone (or Settings default)
     / apply-all equivalent so ambiguous sources are declared — not guessed.
   - **Expect:** unresolved local counts drop for resolvable sources; yearless /
     unusable timestamps may remain unresolved (honest).
   - Skip if the corpus has no ambiguous locals (e.g. `cli-release-demo`).

3. **Explorer (~3 min) — [MANUAL GUI]**
   - Open Explorer on the corpus; scan timeline / lanes; Find `timeout` or a
     known `event_id` from the fixture.
   - **Expect:** host event rows with provenance labels; no truth-file content.

4. **Grounded chat (~3 min) — [MANUAL GUI]**
   - Attach/link the corpus; ask e.g. “What timed out?” or a fixture-local
     question.
   - **Expect:** streaming answer with **host** citations / evidence ids; context
     chips show the linked corpus before or as the turn starts.

5. **Evidence (~2 min) — [MANUAL GUI]**
   - From chat citations or Explorer selection: open Evidence; optionally
     **Show in Explorer** (1–4 lanes).
   - **Expect:** durable evidence identities; lanes keep source ids (no reimport).

6. **Activity visibility (~1 min) — [MANUAL GUI]**
   - Open Activity Inspector for the turn.
   - **Expect:** phases / tool names / timings for this process. Quit/relaunch →
     Activity from the previous process is **gone** (corpus/session remain).

7. **Logging-quality assessment (~2–3 min) — [MANUAL GUI]**
   - With a corpus open in Log Explorer, select **Assess quality**.
   - Review the score, distinct selection buckets, fixed improvement hints,
     and limitations. Use **Show in Explorer** where available (at most four
     lanes); aggregate-only findings never fabricate event citations.
   - Export JSON or Markdown through the native Save panel; an existing file
     is refused rather than overwritten.
   - **Expect:** deterministic, provider-free results. The Activity rail shows
     start, facts, export, cancellation, or failure without paths or secrets.

---

## 2. CLI path (automated proof, 10–15 min)

Label: **[CLI]** — copy/paste; isolate state with `--data-dir`.

Build once:

```bash
cargo build -p cd-cli
BIN=./target/debug/contextdesk
DATA=$(mktemp -d)
echo "DATA=$DATA"
```

### A. Import → corpus list

```bash
$BIN --data-dir "$DATA" --json import ./fixtures/cli-release-demo
```

**Expect:** JSON envelope `ok: true`, `command: "import"`,
`data.events_imported: 6`, `data.sources_selected: 1`,
`data.timezone_ambiguous_sources: []`.

```bash
$BIN --data-dir "$DATA" --json corpus list
CORPUS=$($BIN --data-dir "$DATA" --json corpus list | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["data"]["corpora"][0]["id"])')
echo "CORPUS=$CORPUS"
```

**Expect:** one corpus; id matches `data.corpus_id` from import.

### B. Explore / context (deterministic query — no LLM)

```bash
$BIN --data-dir "$DATA" --json explore "timeout" --corpus "$CORPUS"
$BIN --data-dir "$DATA" --json context "timeout" --corpus "$CORPUS"
```

**Expect:** `explore` → `ok: true`, `data.hits` non-empty (timeout line).
`context` → `ok: true`, `data.evidence` present (host-assembled; no model call).

### C. Chat + Activity (where available)

Dry-run (no provider network) — still projects Activity when requested:

```bash
$BIN --data-dir "$DATA" --json chat --dry-run --activity summary \
  --corpus "$CORPUS" "what timed out?"
```

**Expect:** `ok: true`, `data.activity` present; no live completion.
Live chat (optional): omit `--dry-run` after `contextdesk config init` /
provider setup; **Expect:** grounded final text + citations when tools work.

### C1. Multi-corpus demonstration (serial, production CLI path)

For a short demonstration covering several inputs, use the checked-in
`scripts/demo-corpus-batch.ps1` harness on Windows. It is intentionally a
thin orchestrator around the binary above: it does not implement HTTP, model
parsing, retrieval, or a second agent loop.

First run the provider-free preflight. It normalizes each selected source into
a fresh output directory and verifies any existing corpus ids, but it does not
import, read credentials, or contact a gateway:

```powershell
.\scripts\demo-corpus-batch.ps1 `
  -Cli .\contextdesk.exe `
  -DataDir "$env:LOCALAPPDATA\ContextDesk\demo-batch" `
  -Source .\case-a.zip, .\case-b `
  -OutputRoot .\demo-batch-preflight
```

After reviewing the preflight report, run the selected cases serially. The
example below uses the exact catalog id returned by model discovery; substitute
the model actually selected on the user's gateway. `-AllowImport` is required
because source imports change the specified data directory:

```powershell
.\scripts\demo-corpus-batch.ps1 `
  -Cli .\contextdesk.exe `
  -DataDir "$env:LOCALAPPDATA\ContextDesk\demo-batch" `
  -Source .\case-a.zip, .\case-b `
  -OutputRoot .\demo-batch-run `
  -Execute -AllowImport `
  -Model "qwen-3.6-27b" -Deadline 10m
```

To use already imported corpora without mutating them, pass explicit ids and
omit `-AllowImport` (the script still requires `-Execute` for provider calls):

```powershell
.\scripts\demo-corpus-batch.ps1 `
  -Cli .\contextdesk.exe `
  -DataDir "$env:LOCALAPPDATA\ContextDesk\acceptance-rc2" `
  -CorpusId "<exact-corpus-id-1>", "<exact-corpus-id-2>" `
  -OutputRoot .\demo-batch-run `
  -Execute -Model "qwen-3.6-27b" -Deadline 10m
```

Each case receives exactly one `--mode single` turn with `--trace summary`
and `--activity summary`; there is no retry or concurrent execution. Raw
JSONL/stdout and stderr are retained under `raw-local-only/` for local
debugging and test fixture extraction. Share only `report.json` or
`report.md` after inspecting them: `grounding=grounded` certifies host citation
identity, not the model's causal interpretation or completeness.

### D. Timezone review fixture (when demonstrating ambiguity)

```bash
DATA_TZ=$(mktemp -d)
$BIN --data-dir "$DATA_TZ" --json import \
  ./fixtures/log-lab/scenarios/company-timestamp-diversity/import
CID=$($BIN --data-dir "$DATA_TZ" --json corpus list | python3 -c \
  'import json,sys; print(json.load(sys.stdin)["data"]["corpora"][0]["id"])')
$BIN --data-dir "$DATA_TZ" --json timezone status --corpus "$CID"
$BIN --data-dir "$DATA_TZ" --json timezone apply-all America/Chicago \
  --corpus "$CID" --yes
$BIN --data-dir "$DATA_TZ" --json timezone status --corpus "$CID"
```

**Expect after import:** `timezone_ambiguous_sources` includes
`01-shared-encodings.jsonl` and `04-ambiguous-or-unusable.log`.
**Expect after apply-all:** `applied_sources` lists those files;
`event_revision` bumps; some unusable/yearless locals may still show
`unresolved_local_records > 0`.

### E. Normalize (offline export)

```bash
OUT=$(mktemp -d)/norm
$BIN normalize ./fixtures/cli-release-demo --output "$OUT" --json
ls "$OUT/manifest.json" "$OUT/normalization-report.json" "$OUT/sources"
```

**Expect:** `ok: true`; exactly those three output shapes under `$OUT`.
Re-run the same command against the same `$OUT`:

```bash
$BIN normalize ./fixtures/cli-release-demo --output "$OUT" --json
```

**Expect:** `ok: false`, error kind `user_error`, message refuses overwrite of a
non-empty output directory (no-clobber).

### F. Logging-quality assessment JSON/Markdown export

```bash
$BIN --data-dir "$DATA" --json logging-assessment "$CORPUS"
REPORT_JSON=$(mktemp).json
REPORT_MD=$(mktemp).md
$BIN --data-dir "$DATA" logging-assessment "$CORPUS" \
  --output "$REPORT_JSON" --report-format json
$BIN --data-dir "$DATA" logging-assessment "$CORPUS" \
  --output "$REPORT_MD" --report-format markdown
```

**Expect:** schema id `contextdesk.logging_quality_assessment.v1`, deterministic
findings with fixed improvement hints, mandatory limitations, and a Markdown
projection of the JSON report. Re-run either export against the same path:
ContextDesk refuses to overwrite it.

### G. Exception amplification versus independent occurrences

```bash
$BIN --data-dir "$DATA" exception-episodes "$CORPUS"
$BIN --data-dir "$DATA" --json episodes "$CORPUS"
```

**Expect:** the text report clearly separates raw exception records, physical
renderings, retained correlation groups, certified derived episodes, and
families. The JSON report uses schema
`contextdesk.exception_episode_report.v2`, retains `seq` + `source` citations,
and exposes `counts_complete`, `partial`, `uncertain`,
`matching_ambiguous`, and `semantic_counts_certified`. Compatibility fields
`occurrenceCount` and `semanticOccurrences` count retained groups, including
standalone unresolved renderings; they are not incident totals when semantic
counts are uncertified. The public CLI fixture may contain no dual-rendered
exception; zero/low amplification is honest. Use the dedicated synthetic
exception lab for the exact 56×265 oracle—never substitute private logs.

---

## 3. Troubleshooting

| Symptom | What to check |
| ------- | ------------- |
| Provider / key setup | Desktop: Settings → AI + preflight. CLI: `contextdesk config init`, `config show`, `doctor`. Keys stay in OS keychain; webview/CLI docs never print raw secrets. |
| Wrong / shared local data | Prefer `--data-dir <scratch>` for demos. Default shared root is `~/.contextdesk` (desktop + CLI). |
| Stale build identity | `capabilities` `git_sha` / `git_describe` must match `git rev-parse HEAD`. Rebuild: `cargo build -p cd-cli`. Exact-head gate: `scripts/exact_head_cli_acceptance.sh` / [DEMO_ACCEPTANCE.md](DEMO_ACCEPTANCE.md). |
| Timezone uncertainty | Zone-less locals need explicit `timezone apply` / `apply-all` or Settings default **before** treating wall time as certain. Unusable/yearless stamps can remain unresolved after apply. |
| Unsupported inputs | Import summary `sources_unsupported` / ignored ≠ “partial success” of those files. Binary noise may be excluded; see import-diagnose fixtures. Never import `truth/`. |
| Export no-clobber | `normalize --output` must be empty/absent. LQA `--output` also refuses an existing file. Pick a fresh path. |
| Activity empty after relaunch | Expected — process-lifetime only. Corpus and sessions persist. |
| `chat` fails offline | Use `explore` / `context` / `chat --dry-run` for network-free proof. |

---

## 4. Logging-quality assessment scope

`logging-assessment` is a deterministic capability: it uses the imported
corpus only, never a provider or keychain. Markdown is a projection of its
versioned JSON report and the improvement hints are fixed templates, not a
free-form LLM plan. CLI and desktop share the same `cd-core` DTO via
`cd-workflow`: use CLI for headless automation and Log Explorer → **Assess
quality** for interactive evidence/lane review.

## 5. Exception-episode scope

`exception-episodes` is also deterministic and offline. Correlation requires
multiple host signals and never changes stored events. Retained correlation
groups are structural accounting, not estimates of independent failures. Only
a `semantic_counts_certified=true` result authorizes the separately labeled
strongly supported derived-episode total; even that is not proof of business
root cause or an independent-incident count. Any incomplete cap, ambiguous
matching geometry, cancellation, or revision change is disclosed or fails closed; see
[CLI.md](CLI.md#exception-episodes-and-duplicate-renderings).

---

## Handbook impact

none — documentation and navigation only; no product behavior change on this
tip.
