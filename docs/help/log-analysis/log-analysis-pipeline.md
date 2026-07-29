---
id: log-analysis-pipeline
title: How log analysis works
summary: Follow a post-mortem log dump through parsing, redaction, Drain templates, DuckDB, embeddings, and why tools.
section: log-analysis
tags:
  - logs
  - duckdb
  - drain
  - troubleshooting
  - process
order: 10
related:
  - demo-log-datasets
  - skills-context-packs
  - permission-tiers
  - memory-overview
  - log-portable-package
  - log-explorer
---
# How log analysis works

ContextDesk's shipped log path analyzes a bounded, post-mortem corpus. It turns
repetitive events into stable templates, keeps structured events in DuckDB,
embeds templates rather than every line, and exposes search, timeline,
clustering, and “why” tools.

![Log analysis pipeline from ingest through parsing, redaction, Drain templates, DuckDB and template embeddings to analysis tools](../assets/log-analysis-pipeline.svg)

## Pipeline

| Stage | What happens | Evidence or boundary |
| --- | --- | --- |
| Ingest | A file or directory is read into a named disposable corpus | `ingest_logs` is SoftWrite because it materializes local analysis data |
| Parse | Supported structured formats are parsed defensibly; malformed or unsupported structure falls back to retained redacted plain/order-only evidence rather than being dropped | No claim of perfect parsing or exhaustive per-line parse-error reporting |
| Redact | Secret-like values and sensitive parameters are scrubbed | Redaction happens before persistence and embedding |
| Template | Drain groups variable messages into stable templates | Parameters remain separate from the template pattern |
| Store | Events and templates are persisted under the app cache | DuckDB serves time/filter/aggregate scans; logs are not durable memory |
| Embed | Unique templates receive vectors | Local fastembed is the desktop default; tests use a deterministic offline backend |
| Analyze | Search, clusters, timelines, and why tools query the corpus | Results cite template/corpus evidence and should be checked against exemplars |

The event store and vector index have different jobs. DuckDB is optimized for
time windows, counts, filters, and co-occurrence across many event rows.
`VectorIndex` searches the much smaller set of template vectors. ContextDesk
does not embed every raw line.

## Events per template

The Logs overview describes pattern grouping as **average events per template**:

```text
100,000 events ÷ 10 learned templates = 10,000 avg. events/template
```

This is a triage-work ratio, not disk compression. Drain templates replace
changing tokens with placeholders, so structurally similar events can share a
pattern even when their request ids, hosts, durations, or other parameters
differ. Every original redacted event remains in DuckDB for search, filters,
provenance, and inspection.

A higher ratio usually means fewer recurring patterns to review and fewer
template records to embed. It does not mean events were deleted or that source
bytes shrank. Use the separate **Source** and **Corpus** sizes for storage, the
embedding state for actual vector coverage, and top-template counts to see
whether a few patterns dominate or a long tail remains.

## Tool guide

| Tool | Tier | Use it for |
| --- | --- | --- |
| `ingest_logs` | SoftWrite | Create a disposable analysis corpus from an allowed local path |
| `search_logs` | Read | Combine text/semantic query with time, level, service, or trace filters |
| `cluster_problems` | Read | Rank groups of related templates by severity, frequency, and anomaly |
| `timeline` | Read | Count events over time for a filter |
| `correlate_logs` | Read | Find templates that spike or co-occur around an incident |
| `anomalies_logs` | Read | Compare an incident window with an explicitly supplied baseline window inside the same current corpus. This is not a learned or cross-corpus application baseline |
| `trace_logs` | Read | Follow a trace or request identifier across services and time |

## A practical triage loop

1. In the Logs pane, ingest a copied incident dump into a named corpus.
2. Inspect detected services, levels, time range, and parse/redaction counts.
3. Open problem clusters and a timeline to identify the incident window.
4. Search a symptom or template—for example, a `connection refused`
   incident—then run correlation or anomaly analysis.
5. Follow a trace id when one exists.
6. Cite the concrete templates and exemplars in the explanation.
7. If a conclusion should become durable knowledge, propose a memory through
   the normal confirmation path.

The `log-triage` skill can provide this method to a chat; see
help://skills-context-packs. A skill does not bypass corpus ingest confirmation
or any later write.

## Investigation workspace

After SoftWrite ingest, open **Log Explorer** from the Logs library for
filters, multi-lane evidence, bookmarks, and corpus-linked chat. See
help://log-explorer. SoftWrite bulk import streams zip/lines and can be
cancelled; template embedding is deferred/capped so large dumps finish SoftWrite
without a mandatory full embed pass. Ordinary imports use the local ONNX model
when it is installed. Inputs over 64 MiB of actual streamed log bytes are marked
**deferred**; smaller imports embed at most the 256 most frequent templates.
The corpus Overview always shows its actual semantic state and model.

For a keyword-only or deferred corpus, choose **Re-analyze locally…** in Logs.
After confirmation, ContextDesk embeds up to 2,048 templates without reparsing
or duplicating events. Cancellation or failure keeps the previous keyword
corpus and index. Semantic search is labeled available only after vectors exist.

## Current limits

This is batch, post-mortem analysis. Live tailing, continuous alerts, and
remote S3/Loki/Elastic/Kubernetes log-source connectors are not shipped in this
pipeline. A cloud embedding option, when used, requires an explicit
content-leaves-this-machine decision and remains separate from local re-analysis.
Bookmarks are not included in portable package v1. Durable noise/squelch rules
are not shipped (#671). Per-source timezone/year/DST policy, subsecond
provenance, and clock-skew correction remain incomplete (#670). Corpora are
analyzed independently; versioned learned application baselines are not
shipped (#690).

> Important:
> Redaction reduces risk but cannot prove that arbitrary logs contain no
> sensitive information. Review the corpus and any egress choice before using
> a remote model or embedding provider.

## Share a corpus package

See [Share a log analysis package](portable-package.md) for versioned export/import.
