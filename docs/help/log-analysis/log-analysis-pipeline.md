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
| Parse | The detector handles supported structured and text formats | Malformed lines are reported; the run does not claim perfect parsing |
| Redact | Secret-like values and sensitive parameters are scrubbed | Redaction happens before persistence and embedding |
| Template | Drain groups variable messages into stable templates | Parameters remain separate from the template pattern |
| Store | Events and templates are persisted under the app cache | DuckDB serves time/filter/aggregate scans; logs are not durable memory |
| Embed | Unique templates receive vectors | Local fastembed is the desktop default; tests use a deterministic offline backend |
| Analyze | Search, clusters, timelines, and why tools query the corpus | Results cite template/corpus evidence and should be checked against exemplars |

The event store and vector index have different jobs. DuckDB is optimized for
time windows, counts, filters, and co-occurrence across many event rows.
`VectorIndex` searches the much smaller set of template vectors. ContextDesk
does not embed every raw line.

## Tool guide

| Tool | Tier | Use it for |
| --- | --- | --- |
| `ingest_logs` | SoftWrite | Create a disposable analysis corpus from an allowed local path |
| `search_logs` | Read | Combine text/semantic query with time, level, service, or trace filters |
| `cluster_problems` | Read | Rank groups of related templates by severity, frequency, and anomaly |
| `timeline` | Read | Count events over time for a filter |
| `correlate_logs` | Read | Find templates that spike or co-occur around an incident |
| `anomalies_logs` | Read | Compare an incident window with a baseline for new or rare templates |
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
without a mandatory full embed pass.

## Current limits

This is batch, post-mortem analysis. Live tailing, continuous alerts, and
remote S3/Loki/Elastic/Kubernetes log-source connectors are not shipped in this
pipeline. A cloud embedding option, when used, requires an explicit
content-leaves-this-machine decision; bulk SoftWrite defaults to no embed.
Bookmarks are not included in portable package v1.

> Important:
> Redaction reduces risk but cannot prove that arbitrary logs contain no
> sensitive information. Review the corpus and any egress choice before using
> a remote model or embedding provider.

## Share a corpus package

See [Share a log analysis package](portable-package.md) for versioned export/import.
