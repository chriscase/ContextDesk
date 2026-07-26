---
id: log-explorer
title: Log Explorer investigation workspace
summary: Open a multi-window (or in-app) explorer on a DuckDB corpus for filters, lanes, bookmarks, and corpus-linked chat.
section: log-analysis
tags:
  - logs
  - explorer
  - bookmarks
  - troubleshooting
order: 20
related:
  - log-analysis-pipeline
  - log-portable-package
---
# Log Explorer investigation workspace

The **Logs** tab is a **library** only: import folder/file/zip, stats, package
import/export, and open investigation. It is not a million-row browser.

**Log Explorer** is the deep investigation surface on one analysis corpus.

## Open Explorer

1. Ingest or select a corpus in Logs.
2. Choose **Open Explorer…** (new window) or **Open in app** (full Logs pane).
3. If the multi-window path fails, ContextDesk falls back to the in-app explorer.

## What you can do

| Feature | Notes |
| --- | --- |
| Filters | Levels, sources, and keyword search; template-first semantic search only when the corpus reports vectors |
| Evidence lanes | 1–4 source groups; optional timestamp link + gap bands |
| Time quality | Wall clock vs **order only** (seq is not unlabeled calendar time) |
| Bookmarks | Line or range on the corpus (`bookmarks.json` sidecar) |
| Linked chat | Compact rail with chat switcher; **New** creates a corpus-linked session. The agent receives a privacy-safe viewport snapshot and runs **bounded log tools** (search, cluster, timeline, …) until it produces an evidence-based answer — not planning-only prose |
| Follow latest | While you stay near the bottom, new messages/tools stream into view; scroll up to read history without jumps. **Jump to latest** restores follow |
| Agent context | **Context shared with agent** discloses filters/lanes/selection counts; full dumps stay out of chat context |
| Nav chips | Valid agent navigation proposals appear as opt-in chips; wrong-corpus proposals fail closed. Raw JSON paste is developer-only |

## SoftWrite import vs session pack

| Path | Limit | Use |
| --- | --- | --- |
| Logs SoftWrite ingest | Large dumps; streaming zip/lines | Analysis corpus for Explorer + tools |
| Session context pack | max 200 files / 50 MiB | Chat attachments only — not huge dumps |

Cancel an in-progress SoftWrite with **Cancel ingest** on the progress panel.
Keyword-only and deferred corpora remain searchable. Use **Re-analyze locally…**
from the Logs overview to build template vectors with progress and cancellation;
the Explorer then labels semantic search available.

## Bookmarks and packages

Bookmarks live under the corpus cache as `bookmarks.json`. Portable package v1
does **not** export bookmarks (by design). Export packages for events/templates
only; re-create bookmarks after import if needed.

## Limits

Live tail, multi-corpus merge in one window, and SIEM alerting are not shipped.
See [How log analysis works](log-analysis-pipeline.md).
