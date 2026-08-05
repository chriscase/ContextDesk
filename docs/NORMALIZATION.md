# Log normalization guide

Human-facing guide: turn **raw** authorized log files, folders, or ZIPs into
portable **`contextdesk.normalized_log_events.v1`** JSONL with an honest
timestamp model (no invented instants).

| Document | Role |
| -------- | ---- |
| **This page** | Operator / integrator walkthrough |
| [`docs/specs/NORMALIZED_LOG_EVENTS_V1.md`](specs/NORMALIZED_LOG_EVENTS_V1.md) | **Normative** event contract |
| [`docs/specs/normalized-log-events/schemas/normalized-log-events.v1.json`](specs/normalized-log-events/schemas/normalized-log-events.v1.json) | JSON Schema |
| [`docs/specs/normalized-log-events/SDK.md`](specs/normalized-log-events/SDK.md) | Producer SDK (emit without the CLI) |
| [`fixtures/cli-docs/normalize-examples/`](../fixtures/cli-docs/normalize-examples/) | Representative valid samples (synthetic) |

## Status

| Piece | Status |
| ----- | ------ |
| Normative JSONL event contract + schema + producer examples | **Shipped** |
| Ordinary import of raw logs (including JSONL that happens to conform) | **Shipped** — no special “fast path” claim |
| Offline CLI `contextdesk normalize` | **Planned / integrating** — document grammar and outputs here; run `contextdesk normalize --help` to see if your binary has it |
| Parquet output | **Not shipped** (`--output-format` defaults to `jsonl` only) |

Commands marked **(requires normalize subcommand)** are not executable on builds
that omit `normalize`. Everything else uses synthetic public fixtures only.

## What normalize is (and is not)

- **Is:** Offline host parse of raw bytes using the same selection/ingest
  foundations as import; emit versioned JSONL + `manifest.json` +
  `normalization-report.json`. Zero provider transport. Zero keychain reads.
- **Is not:** A durable corpus store (use `import` for that). Not a second
  parser for language SDKs to reimplement. Not a database server.

## DuckDB’s role — no database server

ContextDesk’s log engine may use **embedded DuckDB** for corpus analytics
inside the process. You do **not** install, configure, or run a database
server for normalization or CLI import. Normalize publishes plain files under
the `--output` directory; consumers read those files with any JSONL tool.

## Command grammar (candidate; verify with `--help`)

```text
contextdesk normalize [OPTIONS] --output <OUTPUT> <SOURCE>
```

| Flag / env | Meaning |
| ---------- | ------- |
| `<SOURCE>` | File, folder, or ZIP of logs |
| `--output` / `CONTEXTDESK_NORMALIZE_OUTPUT` | Destination directory (**must be absent or empty**) |
| `--output-format` / `CONTEXTDESK_NORMALIZE_FORMAT` | Data format (default `jsonl`) |
| `--source-timezone` / `CONTEXTDESK_SOURCE_TIMEZONE` | IANA zone for zone-less local timestamps without a map entry |
| `--timezone-map` / `CONTEXTDESK_TIMEZONE_MAP` | JSON object: portable source id → IANA zone |
| `--strict-time` / `CONTEXTDESK_STRICT_TIME` | Fail closed if unresolved local time lacks a zone |
| Global `--json` / `--jsonl` / `--format` | **Command rendering** (envelope), not the data format |
| `CONTEXTDESK_WORKING_DIR` | When set to a directory, relative `<SOURCE>` paths resolve under it |

**(requires normalize subcommand)** Example:

```bash
contextdesk normalize ./fixtures/cli-release-demo \
  --output ./out-normalize \
  --json
```

## Exact output files

After a successful run, `--output` contains **exactly** these roles:

| Path | Role |
| ---- | ---- |
| `manifest.json` | `contextdesk.normalization_manifest.v1` — inventory of sources and event counts |
| `normalization-report.json` | `contextdesk.normalization_report.v1` — selection tallies, time tallies, warnings |
| `sources/<source-id>.jsonl` | One JSONL file per selected source: **header line** + event lines |

Atomic publish: work is staged then renamed into place. Cancellation or
failure leaves the destination **unchanged** (no half-written publish).
Re-using a non-empty `--output` fails closed (no-clobber).

### Representative `manifest.json` (synthetic)

See [`fixtures/cli-docs/normalize-examples/manifest.json`](../fixtures/cli-docs/normalize-examples/manifest.json).

```json
{
  "schemaId": "contextdesk.normalization_manifest.v1",
  "generatedAt": 1717250000,
  "input": "fixtures/cli-release-demo",
  "outputFormat": "jsonl",
  "producer": {"name": "contextdesk-normalize", "version": "0.1.0"},
  "sources": [
    {
      "sourceId": "demo-api",
      "relativePath": "sources/demo-api.jsonl",
      "events": 6,
      "timeSourceExplicit": 6,
      "timeProducerResolved": 0,
      "timeUnresolved": 0,
      "timeOrderOnly": 0,
      "redactions": 0,
      "truncations": 0
    }
  ]
}
```

### Representative `normalization-report.json` (synthetic)

See [`fixtures/cli-docs/normalize-examples/normalization-report.json`](../fixtures/cli-docs/normalize-examples/normalization-report.json).

Key fields: `sourcesExamined` / `sourcesSelected` / `sourcesIgnored` /
`sourcesUnsupported` / `sourcesExcluded` / `sourcesFailed`, time tallies,
`partial`, `warnings` (bounded; never full payloads).

### Per-source JSONL layout

Line 1 is the **header**; subsequent lines are events (`sourceSeq` starts at 0,
strictly increasing). Full rules: [NORMALIZED_LOG_EVENTS_V1.md](specs/NORMALIZED_LOG_EVENTS_V1.md).

```json
{"schemaId":"contextdesk.normalized_log_events.v1","minReaderVersion":1,"sourceId":"demo-api","producer":{"name":"contextdesk-normalize","version":"0.1.0"}}
{"sourceSeq":0,"time":{"resolution":"source_explicit","instant":"2024-06-01T12:00:08.300Z","basis":"wall"},"severity":{"raw":"ERROR","canonical":17,"confidence":"high","provenance":"source_explicit"},"message":"…","canonical":"…"}
```

## UTC `Z` output behavior

- When an event has an **instant**, it is RFC3339 with an **explicit** offset.
  Normalized instants produced for wall-clock resolution are emitted in **UTC
  (`Z`)** so consumers do not re-apply local zones by accident.
- Zone-less local text alone never becomes a guessed `instant` — that encoding
  is **unrepresentable** (`unresolved` / `order_only`).

## Time resolution examples (synthetic fixtures)

| Resolution | Fixture | Instant? |
| ---------- | ------- | -------- |
| `source_explicit` | [`source-explicit.jsonl`](../fixtures/cli-docs/normalize-examples/source-explicit.jsonl) | Yes (`…Z`) |
| `producer_resolved` | [`producer-resolved.jsonl`](../fixtures/cli-docs/normalize-examples/producer-resolved.jsonl) | Yes + `localText` + `resolvedTimezone` |
| `unresolved` | [`unresolved.jsonl`](../fixtures/cli-docs/normalize-examples/unresolved.jsonl) | No — `localText` only |
| `order_only` | [`order-only.jsonl`](../fixtures/cli-docs/normalize-examples/order-only.jsonl) | No — sequence only |

## Multiline / continuation handling

Multiline records (stack traces, continued syslog) are framed by the **same**
production log parsers import uses. Continuations attach to the owning logical
record; they are not re-split into false “events” solely because of newlines.
If framing fails, the source is reported via selection reasons
(unsupported/failed), not silently re-written.

## Rotated sources

Rotated files (`app.log`, `app.log.1`, dated suffixes) are treated as
**distinct sources** under portable identities. Selection and noise policy
match import preview. Normalize does not invent a single merged stream across
rotations unless the engine’s existing framing already defines that behavior
for the format.

## Unsupported / XML / binary treatment

- **Unsupported** formats are counted in `sourcesUnsupported` / report
  warnings — not force-parsed into fake events.
- **Binary** / non-text content is excluded or failed closed (same honesty as
  import), never base64-dumped into JSONL as if it were log text.
- **XML** without a supported grammar remains unsupported unless a reviewed
  format binds it — no generic XML-to-event guesswork.

## Redaction and privacy

- Secrets matching the host redaction policy are **redacted in published
  originals** where applicable; tallies appear as `redactions` on the report.
- Truncation of oversized canonical text is tallied as `truncations`.
- Warnings and progress messages must not echo secret payloads.
- Do not feed private customer logs into public docs or CI fixtures — use
  [`fixtures/cli-release-demo/`](../fixtures/cli-release-demo/) only.

## Atomic output, cancellation, no-clobber, partial / fail-closed

| Behavior | Contract |
| -------- | -------- |
| Atomic publish | Stage then rename; readers never see partial trees |
| Ctrl-C | Exit **130** (`cancelled`); destination unchanged |
| Non-empty `--output` | User error — refuse overwrite |
| `--strict-time` | Fail closed if local times cannot be resolved |
| `partial: true` | Report honesty flag when selection incomplete; do not treat as full success for automation gates |

## Disk space and staging

Budget roughly **≥ 2×** the selected raw input size for staging + final
JSONL (headers, escaping, reports). Prefer a local filesystem (not a
network share with weak rename atomicity). Clean failed staging directories
are process-local; a stuck disk-full run fails closed without publishing.

## Walkthrough: raw → normalized (macOS / Linux)

```bash
# 1) Build CLI
cargo build -p cd-cli --release
BIN=./target/release/contextdesk

# 2) Confirm normalize exists (skip section if "unrecognized subcommand")
$BIN normalize --help

# 3) Normalize synthetic demo (requires normalize)
rm -rf ./out-normalize
$BIN normalize ./fixtures/cli-release-demo --output ./out-normalize --json

# 4) Inspect exact files
ls -la ./out-normalize
ls -la ./out-normalize/sources
python3 -c 'import json;print(json.load(open("out-normalize/normalization-report.json"))["events"])'
```

## Walkthrough: PowerShell (Windows)

```powershell
# Executable when normalize is present on contextdesk.exe
cargo build -p cd-cli --release
$bin = ".\target\release\contextdesk.exe"
& $bin normalize --help
Remove-Item -Recurse -Force .\out-normalize -ErrorAction SilentlyContinue
& $bin normalize .\fixtures\cli-release-demo --output .\out-normalize --json
Get-ChildItem .\out-normalize
Get-ChildItem .\out-normalize\sources
```

## Producer path (always available without `normalize`)

Applications that already understand their logs can **emit** conforming JSONL
directly (no ContextDesk process required for emission):

```bash
# Illustrative — see examples/normalized-log-producers/ and the SDK guide.
python3 examples/normalized-log-producers/python/emit_sample.py > events.jsonl
```

Validate against the schema offline; import still uses the ordinary raw path
until a dedicated normalized fast-import ships.

## Troubleshooting

| Symptom | Interpretation |
| ------- | -------------- |
| `unrecognized subcommand 'normalize'` | Build/tip without normalize CLI — use producer path or integrate normalize lane |
| `overwrite` / `non-empty` | Pick empty `--output` or remove prior tree |
| High `timeUnresolved` | Supply `--source-timezone` or `--timezone-map`, or accept unresolved honesty |
| `--strict-time` fails | Some local timestamps still lack zones — fix map or drop strict |
| `sourcesUnsupported` | Content not bound to a supported grammar — leave raw or add reviewed format |
| Cancel mid-run | Destination empty/unchanged; safe to retry |
| Empty events | Selection chose nothing normalizable — check noise/binary/empty inputs |

## Related

- [CLI guide](CLI.md) — envelopes, exit codes, import vs normalize
- [Language integration](LANGUAGE_INTEGRATION.md) — spawn the binary; never re-parse
- [CLI packaging](CLI_PACKAGING.md) — release archives
