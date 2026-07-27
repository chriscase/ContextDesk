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
| Find vs Filter | **Find** pages chronological result identities and loads hit-centered context without removing surrounding rows. **Filter** reduces the table and intersects levels/sources/time. **Advanced** exposes literal vs bounded linear-time regex, case sensitivity, and optional template-semantic search when vectors exist |
| Counts | The filter rail labels **corpus total**, **matched** (global query/facets), and **resident** (currently loaded) separately — not a max-per-lane figure as a global total |
| Bookmarks | Activation resolves the stable target directly and loads a bounded neighborhood; filters may be temporarily cleared with an explicit restore |
| Bidirectional paging | Scroll near the top or bottom to load older/newer backend pages with a bounded resident window; manual **Load older/newer** remains as fallback |
| Timestamps | Adaptive UTC display prioritizes time of day for a single-day corpus and adds date/year when needed; the complete timestamp is keyboard-readable in the row and inspector; order-only never fabricates calendar time |
| Columns | Drag or keyboard-resize Time / Level / Source / Message; auto-fit samples at most 200 resident redacted events; reset restores defaults; widths persist locally |
| Long lines | **1 line**, **Preview**, and **Deep** use a user-selected bounded depth. Expand one row or use the resizable inspector to read and copy the complete redacted event |
| Narrow layout | Logs remain primary and single-lane. Filters and Chat open intentionally as keyboard-safe drawers with state summaries and focus restoration |
| Evidence lanes | 1–4 user-composed source groups. The same source may appear in more than one lane |
| Time-link modes | **Independent** scrolls lanes separately. **Follow** seeks approximate timestamp peers. **Align** uses shared exact wall-clock rows and explicit blank cells; it is unavailable for mixed, order-only, empty, failed, or unloaded lane sets |
| Timeline navigator | Closed by default and does no work until opened. A hard-capped backend summary shows the full filtered span; click a bar or release the position slider to load one bounded event neighborhood |
| Time quality | Wall clock vs **order only** (seq is not unlabeled calendar time) |
| Linked chat | Compact rail with chat switcher; **New** creates a corpus-linked session. Switching chats is race-safe (a slow load cannot overwrite the active chat). Long threads use a bounded virtualized window; history stays persisted. The agent receives a privacy-safe viewport snapshot and runs **bounded log tools** (search, cluster, timeline, …) until it produces an evidence-based answer — not planning-only prose |
| Follow latest | While you stay near the bottom, new messages/tools stream into view; scroll up to read history without jumps. **Jump to latest** restores follow |
| Agent context | **Context shared with agent** discloses filters/lanes/selection counts; the nearby `?` explains the immutable turn snapshot, bounded tools, and privacy boundary. Full dumps stay out of chat context |
| Nav chips | Valid agent navigation proposals appear as opt-in chips; wrong-corpus proposals fail closed. Raw JSON paste is developer-only |

## Find vs Filter

Use **Find** like contextual Find in an editor: the event table remains intact,
the active hit is loaded into a bounded neighborhood, and Previous/Next cross
chronological cursor pages. Only one bounded page of identities is retained.
Literal totals are exact; a bounded regex result may explicitly report a
partial/continuation state. While a Find is running, **Cancel** signals that
specific backend request. The UI waits for terminal cancellation, preserves
the previous visible result identities, and does not let the cancelled request
overwrite a newer Find.

Use **Filter** to reduce all evidence lanes. Keyword, level, source, service,
host, exact trace, template ID, UTC-time, and stable sequence scopes intersect.
Multiple choices inside one level/source/service/host facet combine with OR;
the facet groups and exact fields combine with AND. Changing any scope while
Find is active reruns Find against that view rather than silently dropping the
Find term.

Advanced scope uses explicit fields rather than a hidden query language:

- UTC start is inclusive and UTC end is exclusive. Enter ISO timestamps with
  `Z` or an explicit offset. Exact UTC filtering is disabled when the current
  evidence is mixed-time or order-only.
- Sequence start and end are inclusive stable event identities and remain
  available when calendar time is unavailable.
- Trace ID and template ID are exact matches.

## Counts

**Corpus events** is the persisted corpus size. **Matched** belongs to the
current query; when lanes overlap, each lane reports its own matched value
because summing them would double-count events. **Resident** is the bounded
in-memory/browser window, not the result total.

## Lanes

Choose 1–4 visible lanes when the window is wide enough, then use **Lanes…** to
assign zero or more sources to each. Empty membership means all globally
filtered sources. Lane composition persists locally per corpus. Narrow windows
use one lane rather than stacking unusable columns.

## Time link

- **Independent:** every lane scrolls and pages on its own.
- **Follow:** choosing an event seeks each peer lane near that timestamp. It is
  approximate and does not claim that rows line up.
- **Align:** reliable wall-clock lanes share one bounded, virtualized sequence
  of exact timestamp rows and synchronized scroll. A blank striped cell means
  that lane has no event at that timestamp; it is not a fabricated log line.

Align is an event-time axis, not a proportional-duration chart. Mixed and
order-only data cannot enter Align, and an empty/failed/unloaded lane cannot
make the aggregate more trustworthy.

## Timeline navigator

Open **Navigator** to move across the entire filtered corpus without loading
the intervening event bodies. The backend performs fixed-size SQL aggregation
and returns at most 96 count buckets; empty spans stay empty. The shaded portion
marks buckets represented in the current bounded resident window. With two to
four lanes, compact coverage rows summarize each lane independently and retain
its own wall/mixed/order-only label; one lane cannot make another's clock more
trustworthy.

Click a bar or move and release the position slider. Explorer requests one
event in that bucket and then loads its bounded neighborhood. Slider movement
alone performs no request. Wall-clock data uses UTC labels; order-only data is
described as order and mixed data is labeled honestly. Closing Navigator
returns it to zero background timeline work.

## Long lines

**1 line** is the dense scan mode. **Preview** and **Deep** show a configurable
2/4/8/12-line bounded maximum (Deep doubles the chosen depth up to its cap).
Row height follows the displayed content, so a short one-line event remains
compact instead of reserving the entire preview maximum.
Press **X** on a focused row or use **Expand** for one event. Select a row for
the complete redacted message and metadata in the resizable inspector; row
preview truncation never claims to be the complete record.

## Bookmarks

A bookmark points to a stable event or range. Activating it resolves the target
directly. If current filters or lane membership hide it, Explorer clearly
offers a temporary reveal and a way to restore the prior view.

## Agent context

Each linked-chat turn captures a small, immutable snapshot when the turn starts:
the corpus identity, visible lane/source groups, active search and filters,
selected and bookmarked counts, time quality, and link/alignment mode. Changing
the Explorer after send does not rewrite the context of an already-running
turn, and switching chats does not transfer its pending state.

The snapshot is orientation, not a corpus dump. The agent uses bounded log
tools to search, inspect neighborhoods, correlate sources, and retrieve
evidence. Raw corpus contents, evaluator truth, credentials, and absolute
source paths are not inserted wholesale. Agent navigation remains a proposal:
ContextDesk validates it against the linked corpus and applies it only after
the user activates the suggested action.

## Log Lab scale profiles (synthetic)

For offline/local scale testing, generate synthetic corpora with the Log Lab
example (never commit large output):

```sh
cargo run -p cd-core --example generate_log_lab -- --profile ui-medium --estimate-only
cargo run -p cd-core --example generate_log_lab -- \
  --output /tmp/contextdesk-log-lab-ui-medium --profile ui-medium --record-perf

: # Explicit 100k production-core proof (ignored by the routine suite):
cargo test -p cd-core --test log_lab \
  log_lab_ui_medium_100k_product_path_is_bounded_and_bidirectional -- \
  --ignored --exact --nocapture
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
