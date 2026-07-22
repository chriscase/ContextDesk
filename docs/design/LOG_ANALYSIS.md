# Log & large-corpus analysis — design

**Status:** design (2026-07-18) · **Scope:** a new cd-core subsystem for analyzing large log corpora to find *what* is going wrong and *why* · **Related:** shares the vector layer with memory ([`MEMORY.md`](MEMORY.md) + recall issue #346); log sources tie to the S3 (#292) and connector work.

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
   │  parse (format detect: json / logfmt / syslog / plain)
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

**Format detection + parse** per line/record → `{ ts, level, service?, host?, trace_id?, message, raw }`. Support JSON logs, logfmt, common syslog, and plain text with a configurable timestamp/level regex; unknown formats fall back to `message = whole line`, `ts = ingest order`.

**Templating (Drain-style):** collapse `"GET /users/8123 200 14ms"` and `"GET /users/9971 200 9ms"` into template `"GET /users/<*> <*> <*>ms"` + extracted params. Maintain a template table: `template_id, pattern, token_count, count, first_seen, last_seen, severity`. This is a 100–1000× reduction in what must be embedded and is itself the "what problems exist" clustering. Use an incremental parse tree (Drain3 algorithm, reimplemented in Rust — small) so ingest is single‑pass and streaming‑ready.

**Redaction on ingest** (reuse `cd_core::redact` from the memory work): logs are full of secrets/PII/tokens — scrub params before persist and before embed. Params can be kept structurally (typed placeholders) without keeping raw secret values.

## 4. Storage — the columnar decision

Two stores (event-store engine **decided 2026-07-18: DuckDB**):

- **Event store (10–100M rows):** the analytical scans this whole feature exists for — "frequency of template T over this hour", "templates co-occurring within 5s of the incident", "count by service where level≥ERROR" — are columnar‑aggregate queries. **DuckDB (decided)** (embedded, columnar, no server, purpose‑built for exactly these scans over 100M rows, with native list/array types and a `vss` HNSW extension). The tradeoff is a second embedded engine in a codebase that is otherwise SQLite‑first. Bundle it via the `duckdb` Rust crate (embedded, no external process); verify the MIT license is compatible. (SQLite was the alternative considered and rejected — analytical scans over 100M rows are markedly slower.)
- **Vector index (templates):** a `VectorIndex` trait (see §5) — exact for small sets, **HNSW** for large. Because we index templates, not lines, the vector count is modest even at 100M lines.

Corpora are **per‑analysis, disposable** (an incident dump), stored under the app cache dir keyed by a corpus id — not mixed into durable memory. A corpus can be pinned/kept or discarded.

## 5. The shared `VectorIndex` abstraction (unifies memory + logs)

Memory recall (#346) currently cosines over SQLite BLOBs — fine for thousands, wrong for logs. Introduce one abstraction both use:

```rust
pub trait VectorIndex: Send + Sync {
    fn upsert(&self, id: u64, vector: &[f32]) -> CoreResult<()>;
    fn search(&self, query: &[f32], k: usize, filter: Option<&IdSet>) -> CoreResult<Vec<(u64, f32)>>;
    fn len(&self) -> usize;
}
```
- **`ExactIndex`** (brute-force cosine) — memory, and log corpora under ~50k templates.
- **`HnswIndex`** — large corpora; backed by DuckDB's `vss` extension (DuckDB is the event store, so template vectors live alongside events — one fewer dependency).
Selection is automatic by size. **#346's recall fix should build `VectorIndex` (starting with `ExactIndex`) rather than a bespoke cosine loop**, so logs get ANN for free by adding `HnswIndex` behind the same trait. This is the key reuse: fix recall once, scale both.

## 6. Embedding — throughput matters

- **Default: local in‑process ONNX** via `fastembed-rs` (batched, fast on CPU, no HTTP round‑trip, fully offline) — a better fit for bulk work than the per‑batch Ollama HTTP path. Same `EmbedBackend` trait as memory.
- **Opt‑in per corpus: a cloud embedding API** for throughput on huge corpora — an explicit toggle, with a clear "log content will leave this machine" confirmation (logs may be sensitive). Off by default.
- **Embed templates only**, content‑hash cached — turns "embed 100M lines" into "embed a few thousand templates." This is what makes local embedding viable at this scale.

## 7. Retrieval + the analysis engine

Retrieval is a **three‑way hybrid**: structured filter (time range, level, service, host, trace_id) ∩ semantic (template vector similarity) ∪ full‑text (raw message FTS). The structured filter runs first (columnar, cheap) and bounds the semantic/FTS work.

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
| `ingest_logs` | SoftWrite | ingest a path/dir/bucket into a named corpus (parse+template+embed); returns corpus id + template summary |
| `search_logs` | Read | hybrid: `{query?, corpus, time_range?, level?, service?, trace_id?, semantic?, k?}` |
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

1. **Event‑store engine: DuckDB — DECIDED 2026-07-18.** DuckDB is the event-store engine for the log subsystem (memory/KB stay SQLite). Chosen for the 100M-row analytical scans this feature is *for* (columnar, native array, `vss` HNSW); accepted cost is a second embedded engine, confined to logs.
2. **HNSW library:** `usearch` (fast, C++ bindings, battle‑tested) vs `hnsw_rs`/`instant-distance` (pure Rust, simpler build) vs DuckDB `vss` (if DuckDB is chosen, one fewer dependency). DECIDED: DuckDB `vss` (DuckDB is the event store, so this is one fewer dependency).
3. **Local ONNX embedder:** `fastembed-rs` (recommended) vs staying on Ollama HTTP for consistency. fastembed is much faster for bulk and fully in‑process.
4. **Corpus retention:** keep‑until‑discarded (recommended) vs auto‑expire after N days.

## 11. Phasing

- **Phase 1 — post‑mortem batch (v1):** the `VectorIndex` trait (shared with #346) + `ExactIndex` then `HnswIndex`; ingest from local files/dir (format detect + Drain templating + redaction); the event store (engine per §10) + template table; local ONNX embedding of templates; `ingest_logs` + `search_logs` + `timeline` + `cluster_problems`.
- **Phase 2 — the "why" engine:** `correlate` (temporal + co‑occurrence + sequence), `anomalies` (baseline vs incident), `trace` across services; cloud‑embed opt‑in.
- **Phase 3 — sources & scale:** S3 (#292) + connectors (journald, Loki, Elastic, k8s) as corpus sources; sharding beyond 100M if needed.
- **Phase 4 — live streaming:** incremental tail + continuous templating + threshold alerts via the watchers/triggers engine (#290).

## 12. Relationship to the rest of the backlog

- **#346 (memory recall)** builds the `VectorIndex` trait — logs add `HnswIndex` behind it. Fix recall once, scale both. **This is the dependency to sequence first.**
- **#292 (S3 spike)** — a log source in Phase 3.
- **#290 (watchers)** — the streaming/alerting path in Phase 4.
- **Memory** — an analysis conclusion ("root cause was connection‑pool exhaustion in service X on 2026‑07‑12") is a natural `decision`/`fact` to save into memory. Logs feed memory; they don't live in it.
