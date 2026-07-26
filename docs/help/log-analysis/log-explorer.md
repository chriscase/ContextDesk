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
| Find vs Filter | **Find** highlights matches and steps next/prev without removing surrounding rows. **Filter** reduces the table and intersects levels/sources/time (e.g. `job-7f3a` ∩ ERROR). Active facets show as removable chips |
| Bidirectional paging | Scroll near the top or bottom to load older/newer backend pages with a bounded resident window; manual **Load older/newer** remains as fallback |
| Timestamps | Adaptive UTC display (time-of-day on single-day corpora); full timestamp in the row tooltip; order-only never fabricates calendar time |
| Long lines | **compact** / **wrap** / **full** line modes; Expand on truncated rows; resizable event inspector with Copy |
| Narrow layout | Filters and Chat open as drawers/tabs; single lane; event viewport keeps most of the height |
| Evidence lanes | 1–4 source groups; optional timestamp link + gap bands |
| Time quality | Wall clock vs **order only** (seq is not unlabeled calendar time) |
| Bookmarks | Line or range on the corpus (`bookmarks.json` sidecar) |
| Linked chat | Compact rail with chat switcher; **New** creates a corpus-linked session. Switching chats is race-safe (a slow load cannot overwrite the active chat). Long threads use a bounded virtualized window; history stays persisted. The agent receives a privacy-safe viewport snapshot and runs **bounded log tools** (search, cluster, timeline, …) until it produces an evidence-based answer — not planning-only prose |
| Follow latest | While you stay near the bottom, new messages/tools stream into view; scroll up to read history without jumps. **Jump to latest** restores follow |
| Agent context | **Context shared with agent** discloses filters/lanes/selection counts; full dumps stay out of chat context |
| Nav chips | Valid agent navigation proposals appear as opt-in chips; wrong-corpus proposals fail closed. Raw JSON paste is developer-only |

## Log Lab scale profiles (synthetic)

For offline/local scale testing, generate synthetic corpora with the Log Lab
example (never commit large output):

```sh
cargo run -p cd-core --example generate_log_lab -- --profile ui-medium --estimate-only
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-ui-medium --profile ui-medium --record-perf
```

| Profile | Use |
| --- | --- |
| `small` | Checked-in mystery scenarios |
| `medium` | Legacy regular 100k smoke |
| `ui-medium` | 100k, 8 sources, multi-day, Find/bookmark sentinels |
| `seven-day` | Sparse/burst over seven days (event count independent of span) |
| `paging-stress` | Boundary sentinels for paging/eviction |
| `large` | Opt-in million-event stress (local only) |

Import `scenarios/behavior-scale/import/` (or a compact scenario's `import/`),
never the scenario parent. Performance numbers from `--record-perf` are
one-machine observations, not universal claims. Full generator docs:
`fixtures/log-lab/README.md`.

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
