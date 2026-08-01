# Log & large-corpus analysis — design

**Status:** Phase 1 **shipped** on `main` (DuckDB events + tools + Logs pane); Phase 2 **why** tools (`correlate_logs` / `anomalies_logs` / `trace_logs`) shipped · **Scope:** cd-core subsystem for analyzing large log corpora to find *what* is going wrong and *why* · **Related:** shares the vector layer with memory ([`MEMORY.md`](MEMORY.md) + #346); log sources tie to the S3 (#292) and connector work.

## 0. Locked scope (owner decisions, 2026-07-18)

| Decision | Choice | Consequence |
|---|---|---|
| Scale (largest corpus at once) | **~10–100M lines** | Templating is mandatory; ANN (HNSW) vector index; a columnar analytical store — all still embedded/local, no external service. |
| Embedding locality | **Both, user-selectable** | Local in-process ONNX (fastembed) by default; a cloud embedding API as an explicit per-corpus opt-in. |
| Primary workflow | **Post-mortem batch first** | v1 = point at a dump/dir/bucket and analyze after the fact. Live streaming is a later phase (ties to watchers #290). |

## 1. The reframe — logs are not memory

Curated memory ([`MEMORY.md`](MEMORY.md)) is small (thousands), human‑authored, durable, and the task is *recall the right fact*. Logs are the opposite on every axis, and the design must respect that:

| | Memory | Logs |
|---|---|---|
| Volume | thousands | **10–100M lines** |
| Authorship | human‑curated | machine‑generated |
| Redundancy | low (dedup on save) | **~99% repetition** (same template, different params) |
| Lifetime | durable | ephemeral / per‑incident |
| Task | recall a fact | **cluster problems, correlate events, find root cause** |
| Retrieval | kNN over a few vectors | structured filter + ANN + full‑text, then *analysis* |

The single most important consequence: **you never embed raw lines. You template them first.**

## 2. Architecture

```text
sources (files / dir / S3 / journald…)   ── post-mortem batch ──►
   │  fingerprint + parse (versioned grammar identity; plain fallback)
   ▼
line events  ──►  columnar event store  (timestamp, level, service, template_id, params, trace_id, host)
   │  Drain-style templating
   ▼
templates (hundreds–thousands)  ──►  embed TEMPLATES only (local ONNX default / cloud opt-in)
   │                                    │  content-hash cache; dedup
   ▼                                    ▼
template table (text, count, first/last_seen, severity)   vector index (ANN / HNSW over template vectors)
                                   │
                                   ▼
        ANALYSIS ENGINE:  cluster · correlate(time) · co-occurrence · trace-link · anomaly/new-template
                                   │
                                   ▼
        AGENT TOOLS:  ingest_logs · search_logs · cluster_problems · correlate · timeline · trace · anomalies
```

The heavy row count (10–100M) lives in the **columnar event store**; the vector work happens over the **few thousand templates**, so ANN is trivially fast and embedding is cheap.

## 3. Ingest & templating (the core of it)

**Format fingerprint + parse** per bounded physical record → `{ ts, level,
service?, host?, trace_id?, message, raw }` plus immutable parser timestamp
provenance, the active timestamp basis, and bounded unresolved local timestamp.
Logical-record framing joins multi-line exception and PostgreSQL continuation
bodies before this parse step (#788); correlation keeps span/request ids out of
`trace_id` (#789); severity preserves TRACE/CRITICAL/LOG and numeric Pino bands
(#790); YYYYMMDD integers are never accepted as epoch seconds; PostgreSQL and
jsonlog `YYYY-MM-DD HH:MM:SS[.mmm] ZONE` stamps resolve only for
UTC-equivalent zones and otherwise retain the calendar text as unresolved local
evidence, as do `ctime` calendar strings (#751); a bounded envelope payload
(Docker `json-file` `log`, RFC5424-borne CEF) contributes severity only when the
envelope declared none and never overwrites transport provenance (#791)
text when the parser can defend that evidence. An immutable versioned built-in
registry identifies the record grammar from strict content clues and reports
matched, unknown, or ambiguous without declaration-order tie-breaking. A
possible producer is only a non-authoritative hint. Filename extensions do not
decide the result, and a file's first non-empty line does not lock later
records to one parser. Unknown, ambiguous, and failed parses fall back to
`message = whole line`, `ts = ingest order`.

### Import confidence contract

Raw-log ingest produces a bounded per-source confidence report in the same
streaming pass that publishes the corpus. Format detection and time
interpretation remain separate:

- **Format confidence** reports the versioned grammar identity, matched /
  ambiguous / unknown outcome, runner-up margin, and an optional producer
  family hint. A family hint is always labelled **not verified** and never
  establishes a timezone or product identity.
- **Time quality** reports exact wall clock, mixed, or order-only. An
  offsetless local timestamp is distinguished from a present-but-unresolved
  zone abbreviation. Neither is guessed. Parser timestamp provenance and
  recognized unresolved local timestamp text persist with the event so a later
  review does not have to reinterpret the message.
- A source review may include at most three redacted timestamp-prefix samples.
  It contains a portable source identity, never the selected absolute import
  path or a message payload.

The Logs pane shows the report after a successful direct import. The collapsed
summary states how many sources have an exact wall clock and how many need
review; an accessible, internally bounded disclosure lists only the sources
that are not both wall-clock and grammar-matched. Unresolved records remain
searchable, while exact alignment and metric correlation fail closed until
every participating source has defensible wall time.

For parser-recognized offsetless local calendar timestamps, the user can review
one portable source and explicitly declare an IANA timezone. Preview is bound
to the exact corpus event revision and reports affected, already-explicit, and
unchanged order-only counts; the resulting inclusive UTC range; and records
rejected because of DST gaps, DST folds, unsupported precision, or the event
store range. Explicit offsets remain authoritative and are never rewritten by
the declaration.

Confirmation recomputes the preview and publishes timestamp replacements,
active timestamp bases, declaration metadata, event counts, wall-event counts,
and min/max time in one atomic event revision. The declaration and source
status survive reopen. Clearing it publishes another revision that restores
the affected records to ingest order while retaining their parser provenance
and unresolved local text. The revision layer retains one validated prior
event set for one-step undo and refuses stale or tampered state. Source and
corpus `wall` / `mixed` / `order_only` quality are recomputed from the active
event bases rather than numeric timestamp magnitude.

This is the shipped #779/#780 slice, not a complete arbitrary timestamp system.
Storage remains whole-second. ContextDesk does not infer years for yearless
records, guess abbreviations, persist subsecond precision, correct clock skew,
or accept arbitrary custom format profiles. Those residuals keep #670 open.

**Templating (Drain-style):** collapse `"GET /users/8123 200 14ms"` and `"GET /users/9971 200 9ms"` into template `"GET /users/<*> <*> <*>ms"` + extracted params. Maintain a template table: `template_id, pattern, token_count, count, first_seen, last_seen, severity`. This is a 100–1000× reduction in what must be embedded and is itself the "what problems exist" clustering. Use an incremental parse tree (Drain3 algorithm, reimplemented in Rust — small) so ingest is single‑pass and streaming‑ready.

**Redaction on ingest** (reuse `cd_core::redact` from the memory work): logs are full of secrets/PII/tokens — scrub params before persist and before embed. Params can be kept structurally (typed placeholders) without keeping raw secret values.

## 4. Storage — the columnar decision

Two stores (event-store engine **decided 2026-07-18: DuckDB**):

- **Event store (10–100M rows):** the analytical scans this whole feature exists for — "frequency of template T over this hour", "templates co-occurring within 5s of the incident", "count by service where level≥ERROR" — are columnar‑aggregate queries. **DuckDB (shipped, #358)** (embedded via the MIT `duckdb` crate + `bundled`, no server). The tradeoff is a second embedded engine in a codebase that is otherwise SQLite‑first. (SQLite was considered and rejected for 100M-row analytical scans.)
- **Vector index (templates):** a `VectorIndex` trait (see §5) — exact for small sets, **HNSW** for large. Because we index templates, not lines, the vector count is modest even at 100M lines. **Shipped as pure-Rust Exact/Hnsw** (`crates/cd-core/src/vector_index.rs`) — not DuckDB `vss` (events and ANN stay decoupled so memory and logs share one ANN implementation).

Corpora are **per‑analysis, disposable** (an incident dump), stored under the app cache dir keyed by a corpus id — not mixed into durable memory. A corpus can be pinned/kept or discarded.

### Logs-library activation contract

Listing corpora and selecting one must not eagerly run template listing or
problem clustering. Selection updates the visible Overview immediately and
serializes the trusted host activation so rapid A → B choices leave both the UI
and host on B. Optional Analysis and Templates work begins only after the user
chooses **Load analysis**; one in-flight request per corpus is coalesced and its
result is cached until corpus-analysis metadata changes, local re-analysis
succeeds, or the corpus is discarded.

Corpus-list refreshes and analysis requests carry lifecycle generations. An
older list response cannot replace a newer import refresh, a stale analysis
response cannot populate another corpus, and a late discard cannot clear a
newer selection. Partial cluster/template failures settle together and remain
visible with a retry action; the corpus list, privacy-safe diagnostics, and
selection controls remain available.

Component timing uses deferred host mocks only to prove these ordering
boundaries; it is not a DuckDB or packaged-app latency claim. Literal
250,000-event timing is captured separately with the deterministic
`triage-stress` dataset and labeled as one-machine evidence.

## 5. The shared `VectorIndex` abstraction (unifies memory + logs)

Memory recall (#346) currently cosines over SQLite BLOBs — fine for thousands, wrong for logs. Introduce one abstraction both use:

```rust
pub trait VectorIndex: Send + Sync {
    fn upsert(&self, id: u64, vector: &[f32]) -> CoreResult<()>;
    fn search(&self, query: &[f32], k: usize, filter: Option<&IdSet>) -> CoreResult<Vec<(u64, f32)>>;
    fn len(&self) -> usize;
}
```
- **`ExactIndex`** (brute-force cosine) — memory, and log corpora under ~50k templates. **Shipped.**
- **`HnswIndex`** — pure-Rust navigable small-world ANN for large template corpora. **Shipped** (`vector_index.rs`). *Earlier draft said DuckDB `vss`; that was superseded so the ANN layer stays one pure-Rust implementation shared with memory, while DuckDB remains events-only.*
Selection is automatic by size. Memory hybrid recall (#346) builds cosine-on-read on `ExactIndex`; logs reuse the same trait.

## 6. Embedding — throughput matters

- **Default: local in‑process ONNX** via `fastembed-rs` (fast on CPU; inference makes no HTTP request after the model is installed). The desktop may install the small model once; if it is unavailable the corpus is labeled keyword-only rather than pretending semantic search is active.
- **Deterministic bulk policy:** ordinary imports embed up to the top 256 templates during ingest. After more than **60 MiB of actual streamed source bytes**, ingest records `deferred` and publishes the still-usable keyword/structured corpus without vectors.
- **Trusted re-analysis:** Logs offers a human-confirmed local action for keyword-only/deferred corpora. It embeds up to 2,048 templates without reparsing events, reports progress/cancellation, and atomically publishes sidecars only after validation. Failure preserves the previous corpus/index.
- **Import responsiveness (#824):** progress chrome is monotonic: Discover/read → **Streaming read, parse, template, and persist** → optional embedding → validate → atomic publication. Diagnostic `IngestPhaseTimings` accumulate wall time via scoped operation timers (read/parse/template/persist/embed/validate/publish), not the last UI enum while work interleaves. Non-overlapping working subtotals are bounded by wall time. Desktop host runs ingest on `spawn_blocking`. Optional embedding defers after **60 MiB** streamed source so the authoritative triage-stress 250k corpus (~63.9 MiB / 250k events / 648 templates) is keyword-ready at first use. DrainMiner fails closed on total-template and per-length-bucket caps with cancel polls inside same-length scans.
- **Opt‑in per corpus: a cloud embedding API** for throughput on huge corpora — an explicit toggle, with a clear "log content will leave this machine" confirmation (logs may be sensitive). Off by default.
- **Embed templates only**, content‑hash cached — turns "embed 100M lines" into "embed a few thousand templates." This is what makes local embedding viable at this scale.

## 7. Retrieval + the analysis engine

Retrieval is a **three‑way hybrid when template vectors exist**: structured filter (time range, level, service, host, trace_id) ∩ semantic (template vector similarity) ∪ full‑text/keyword matching. Keyword/structured retrieval remains available when embedding is keyword-only or deferred; product paths must not label those results semantic.

The value is the **analysis layer** on top — this is "find relationships / why problems happen":
- **cluster_problems** — group templates into root‑cause clusters (semantic similarity + co‑occurrence), ranked by severity × frequency × anomaly. Answers "what is going wrong."
- **correlate(around incident_time | around template)** — templates whose frequency spikes or that co‑occur within a time window of the incident; sequence hints (template A consistently precedes B). Answers "why / what led to it."
- **timeline(filter)** — frequency‑over‑time of templates/levels for an incident window (the columnar scan).
- **trace(id)** — follow a trace_id/request_id/session across services and time.
- **anomalies(baseline_window vs incident_window)** — new or rare templates present in the incident but not the baseline. Often *the* signal.

## 8. Agent tool surface

Registered like the memory/web tools (static specs behind a `log_analysis_enabled` flag):

| tool | tier | purpose |
|---|---|---|
| `ingest_logs` | SoftWrite | ingest a path/dir/bucket into a named corpus (parse+template+local embed when below policy threshold); returns corpus id + template/embedding summary |
| `search_logs` | Read | hybrid when vectors exist, otherwise keyword/structured: `{query?, corpus, time_range?, level?, service?, trace_id?, semantic?, k?}` |
| `cluster_problems` | Read | root‑cause clusters ranked by severity×frequency×anomaly |
| `correlate` | Read | temporal correlation / co‑occurrence / sequence around a time or template |
| `timeline` | Read | frequency‑over‑time for a filter |
| `trace` | Read | follow an id across services |
| `anomalies` | Read | new/rare templates: incident vs baseline |

Ingest is the only write (it materializes a corpus). Everything else is Read — the agent explores, correlates, and explains, citing template ids + line exemplars so its conclusions are checkable (the same citation/provenance discipline as memory recall).

## 9. Security & privacy

- **Local by default** (§0); cloud embed is an explicit, per‑corpus, off‑by‑default opt‑in with a content‑leaves‑machine confirmation.
- **Redaction on ingest** (reuse `cd_core::redact`): scrub secrets/PII from params before persist and before embed.
- Corpora live under the app cache dir, per‑corpus, disposable; never mixed into durable memory or committed to a repo.
- Ingesting from S3/remote sources routes through the SSRF policy (`ssrf.rs`) and keychain‑only credentials (ties to the S3 spike #292).

## 10. Owner decisions

1. **Event‑store engine: DuckDB — SHIPPED (#358).** DuckDB is the event-store engine for the log subsystem (memory/KB stay SQLite). MIT `duckdb` crate + `bundled`. Confined to log corpora under app cache.
2. **HNSW library — SHIPPED pure-Rust** (`crates/cd-core/src/vector_index.rs:HnswIndex`). *Not* DuckDB `vss` (reconsidered so memory and logs share one ANN crate; events stay DuckDB-only).
3. **Local ONNX embedder — product default:** `fastembed-rs` (`AllMiniLML6V2`) via feature `log-fastembed`, **enabled on the desktop host**. It may download the small model once. Offline default core tests (feature off) use injected deterministic `ConceptEmbedBackend`. Desktop ingest uses only the dedicated local log backend—not a provider fallback—and persists `keyword_only`, `deferred`, `partial`, or `complete` plus the non-secret model id. Cloud opt-in and its content-leaves-machine confirmation remain tracked separately in #359.
4. **Corpus retention: keep-until-discarded** under app cache (`log_corpora/{id}`).

## 11. Phasing

- **Phase 1 — post‑mortem batch (v1): SHIPPED** — `VectorIndex` + Exact/Hnsw; ingest (format detect + Drain + redact); DuckDB event store + template table; template embed (hash-cached); tools `ingest_logs` / `search_logs` / `timeline` / `cluster_problems`; desktop **Logs** pane.
- **Phase 2 — the "why" engine: SHIPPED (core)** — `correlate_logs`, `anomalies_logs`, `trace_logs` (+ seeded corpus tests). Cloud-embed UI polish may continue.
- **Phase 3 — sources & scale:** S3 (#292) + connectors (journald, Loki, Elastic, k8s) as corpus sources; sharding beyond 100M if needed. **Not started.**
- **Phase 4 — live streaming:** incremental tail + continuous templating + threshold alerts via the watchers/triggers engine (#290). **Not started** (#363 tracker).

## 12. Relationship to the rest of the backlog

- **#346 / #354** shipped the shared `VectorIndex` — logs reuse Exact/Hnsw for template vectors; DuckDB holds events only.
- **#292 (S3 spike)** — a log source in Phase 3.
- **#290 (watchers)** — the streaming/alerting path in Phase 4.
- **Memory** — an analysis conclusion ("root cause was connection‑pool exhaustion in service X on 2026‑07‑12") is a natural `decision`/`fact` to save into memory. Logs feed memory; they don't live in it.

## 13. Portable package + meta versioning (#467–#470)

### On-disk `meta.json`

- `meta_version` **2** when stats are present; **1**/missing = legacy (id, name, created_at, engine).
- Readers **must open** older meta; missing stats → derive event/template counts from DuckDB/templates.
- Basename-only `source_label`; optional `origin_corpus_id` after package import.

### Package format `contextdesk.log_corpus.v1`

Zip (flat entries):

| File | Role |
|------|------|
| `manifest.json` | `format_version`, `min_reader_version`, `package_kind`, `engine`, SHA-256 per payload, optional `features` / `stats` |
| `meta.json` | Corpus meta (rewritten with new id on import) |
| `events.duckdb` | Event store |
| `templates.json` | Templates + vectors when present |
| `README.txt` | Human import notes |

**Compat rules**

1. Additive optional JSON within a major; unknown fields ignored.
2. `format_version` dispatch is exact. Today the registry contains only
   `contextdesk.log_corpus.v1`; lookalikes such as `.v1.extra` are not v1.
3. Only v1 has shipped. A breaking change introduces a real new major; when v2
   is introduced, its PR must keep both v2 and v1 readers for the N/N−1 window.
   Later removal of an older reader requires an explicit deprecation decision,
   documentation, and fixture change.
4. ZIP/path/cap/declared-byte/hash validation is shared outside version
   readers. Version readers own only their payload contract and optional feature
   semantics. In v1, all feature tags are advisory: hashed payload entries and
   the optional `stats` field are authoritative, and unknown tags are ignored.
5. `min_reader_version` is a capability gate within the selected major.
   `min_reader_version` > this build’s `PACKAGE_READER_VERSION` produces a clear
   error and no cache write.
6. Package `format_version` and on-disk `meta_version` are independent:
   importing a v1 package may upgrade legacy/missing meta version to the current
   local metadata representation.
7. Import always assigns a **new** corpus id; store `origin_corpus_id`.
8. SoftWrite import; export is user-chosen path only.

**Import safety contract**

- Stat filesystem packages before opening them; reject the compressed-byte cap
  before any whole-file read.
- Preflight the bounded central directory and reject duplicate, absolute,
  traversing, backslash, drive-prefix, hierarchical, and directory entries.
- Cap `manifest.json` explicitly, then validate version, kind, engine, required
  payloads, hashes, and declared bytes before creating cache staging.
- Stream every expanded entry through a fixed-size buffer. Recognized payloads
  go to staging while SHA-256 is calculated; unknown additive entries are
  drained without retention but still count toward per-entry and aggregate
  expanded-byte limits.
- Open metadata, templates, and DuckDB while the corpus is still hidden under a
  staging name. Rename is the final publication step; any prior failure removes
  staging and cannot change the existing corpus set.

**Contributor checklist: changing package format?**

1. Classify the change as additive within the current major or breaking.
2. For an additive v1 change, keep existing fields/payloads readable, use only
   optional fields/files, and add a frozen-v1 unknown-field regression.
3. For the first breaking change, add an exact v2 reader and writer, retain the
   exact v1 reader in `PACKAGE_READERS`, and add frozen v2 plus existing frozen
   v1 import/search proof. Do not relax shared ZIP/path/cap/hash validation in a
   version branch.
4. Bump `min_reader_version` only for a reader-capability requirement within a
   major, with a focused too-new-reader test.
5. Never regenerate historical compatibility assertions through the current
   exporter. Frozen v1 tests use fixed v1-era SQL and JSON literals so writer or
   schema evolution cannot silently rewrite the expected artifact.
6. Update this section, user-facing unsupported-version copy, and the close
   proof with exact fixtures and supported registry entries.

## Offline import diagnostic (privacy-safe)

For support and bug reports, ContextDesk ships an **offline** trusted-core
diagnostic that re-runs the real import path without publishing into the user's
library or contacting providers:

```bash
cargo run --locked -p cd-core --bin cd-diagnose-log-import -- \
  --input PATH --output REPORT.json
```

### Contract

| Property | Behavior |
|---|---|
| Pipeline | `preview_import_plan` → `verify_import_plan` → `ingest_path` with `LogEmbedMode::None` |
| Corpus location | Automatic temp cache root; verified cleanup before return. Cleanup failure is fail-closed, never a false deletion claim |
| Network | None (no embed backend, no providers) |
| Input | Read-only; never mutated |
| Output | Atomically published only when the requested path does not exist; inputs and prior reports are never overwritten |
| Report schema | `contextdesk.import_diagnostic.v1` (versioned, aggregate-only) |

### Public-safe report contents

- Build identity: version, protocol, channel (no git fingerprint required)
- Input shape: directory / zip / file classification + entry/byte totals
- Preview aggregates: status/role/reason/format counts, plan block, selection count
- Ingest aggregates: file/line/template/byte counters, provenance histograms, exclusion **reason** counts (never basenames)
- Confidence aggregates: wall/order-only/matched counts + unresolved-time **reason** counts (never samples or source identities)
- Phase timings / progress terminal state / atomic publication outcome
- Typed discrepancy codes and an explicit redaction policy summary

The default serialized report **must not** contain log payloads, representative
or template text, paths, basenames, archive member identities, credentials,
environment values, hashes/fingerprints, provider data, or raw timestamps.
Enforcement is automated (`import_diagnose` denylist tests), not review-only.

### Transport-neutral API

Hosts that want a future “Export import diagnostic” button should call
`cd_core::log_analysis::diagnose_log_import` and
`write_import_diagnostic_report` — no renderer UI is required by this module.
The writer refuses an existing output path; choose a new path or remove a
previously reviewed report before rerunning it.

Synthetic fixtures live under `fixtures/import-diagnose/`.
