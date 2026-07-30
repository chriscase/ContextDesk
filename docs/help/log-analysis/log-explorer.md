---
id: log-explorer
title: Log Explorer investigation workspace
summary: Open a multi-window (or in-app) explorer on a DuckDB corpus for filters, lanes, durable evidence, bookmarks, and corpus-linked chat.
section: log-analysis
tags:
  - logs
  - explorer
  - bookmarks
  - troubleshooting
order: 20
related:
  - demo-log-datasets
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

| Feature                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find vs Filter         | **Find** pages chronological result identities and loads hit-centered context without removing surrounding rows. **Filter** reduces the table and intersects levels/sources/time. **Advanced** exposes literal vs bounded linear-time regex, case sensitivity, and optional template-semantic search when vectors exist                                                                                                                                              |
| Noise policy           | A partial corpus-scoped exact-template lens under open issue #671. Preview exact impact before confirming; the candidate implementation routes enabled rules through rows, counts, facets, Timeline, Find, analysis, and linked log tools without deleting source evidence. Do not treat Slice 1 as fully accepted or unconditionally reversible yet                                                                                                                                 |
| Counts                 | The filter rail labels **corpus total**, **matched** (global query/facets), and **resident** (currently loaded) separately — not a max-per-lane figure as a global total                                                                                                                                                                                                                                                                                             |
| Bookmarks              | New saves preserve the exact selected event set, including noncontiguous selections, and reject duplicate exact sets. Activation loads a bounded neighborhood; filters may be temporarily cleared with an explicit restore                                                                                                                                                                                                                                           |
| Investigation evidence | Selecting rows reveals **Ask about selection** and **Save evidence**. Saved exact identities live outside disposable corpus caches, survive chat deletion, and can be previewed without changing the Explorer before an explicit reveal                                                                                                                                                                                                                              |
| Bidirectional paging   | Scroll near the top or bottom to load older/newer backend pages with a bounded resident window; a local **Retry** appears only after a page failure                                                                                                                                                                                                                                                                                                                  |
| Timestamps             | Adaptive UTC display prioritizes time of day for a single-day corpus and adds date/year when needed; the complete timestamp is keyboard-readable in the row and inspector; order-only never fabricates calendar time                                                                                                                                                                                                                                                 |
| Rows / columns         | New profiles default to Compact tokens and Payload focus with payload-first widths. Switch among Full labels/Compact tokens and Payload/Balanced/Metadata without changing evidence. Complete labels and provenance remain keyboard-focusable. Drag or keyboard-resize Time / Level / Source / Message; Reset restores payload-first defaults                                                                                                                        |
| Long lines / fidelity  | **1 line**, **Preview**, and **Deep** use a user-selected bounded depth. The inspector shows complete formatted content and, when stored, the separately bounded **Original (redacted)** representation with normalization/truncation disclosures                                                                                                                                                                                                                    |
| Narrow layout          | Logs remain primary and single-lane. Filters and Investigation (Evidence/Chat) open intentionally as keyboard-safe drawers with state summaries and focus restoration                                                                                                                                                                                                                                                                                                |
| Evidence lanes         | 1–4 user-composed source groups. The same source may appear in more than one lane                                                                                                                                                                                                                                                                                                                                                                                    |
| Time-link modes        | **Independent** scrolls lanes separately. **Follow** seeks approximate timestamp peers. **Align** uses shared exact wall-clock rows and explicit blank cells; it is unavailable for mixed, order-only, empty, failed, or unloaded lane sets                                                                                                                                                                                                                          |
| Investigation timeline | Visible by default on desktop and quietly collapsible. A hard-capped backend summary shows volume, canonical severity, honest gaps, preview/committed position, and the resident range; releasing the broad chart scrubber loads one bounded event neighborhood. While collapsed, filter changes perform no timeline work                                                                                                                                            |
| Time quality           | Wall clock vs **order only** (seq is not unlabeled calendar time)                                                                                                                                                                                                                                                                                                                                                                                                    |
| Linked chat            | Compact rail with chat switcher; **New** creates a corpus-linked session. Switching chats is race-safe (a slow load cannot overwrite the active chat). Long threads use a bounded virtualized window; history stays persisted. The agent receives a privacy-safe viewport snapshot, must get a successful result from a **bounded log tool**, and may consult other configured read-only sources before producing an evidence-based answer — not planning-only prose |
| Follow latest          | While you stay near the bottom, new messages/tools stream into view; scroll up to read history without jumps. **Jump to latest** restores follow                                                                                                                                                                                                                                                                                                                     |
| Agent context          | **Context shared with agent** discloses filters/lanes/selection counts; the nearby `?` explains the immutable turn snapshot, bounded tools, and privacy boundary. Full dumps stay out of chat context                                                                                                                                                                                                                                                                |
| Nav chips              | Valid agent navigation proposals appear as opt-in chips; wrong-corpus proposals fail closed. Raw JSON paste is developer-only                                                                                                                                                                                                                                                                                                                                        |
| Support diagnostics    | **Export diagnostics…** previews a bounded redacted Markdown/JSON report. Explorer reports include payload-free active view settings; a failed import exposes one memory-only diagnostic without publishing a corpus                                                                                                                                                                                                                                                  |

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

## Noise policy — exact-template Slice 1

Use **Noise** for a repeated template you have reviewed and intentionally want
out of the active investigation. This is different from Filter: filters are
temporary view criteria, while a noise rule is durable policy for this corpus.

1. Select and inspect a representative event.
2. Choose **Suppress exact template…**.
3. Enter a short name and a reason. Frequency alone is not a reason to suppress
   evidence.
4. Choose **Preview impact**. Review the exact match and newly hidden counts,
   level breakdown, number of sources, time span, and redacted examples.
5. Choose **Confirm suppression** only when every event represented by that
   template is known noise for this incident.

The **Noise** control reports enabled rules and hidden events. Its current
lifecycle surface can disable, re-enable, or remove a rule and inspect the
audit. Remove creates an inactive tombstone; it does not erase the rule's
history. This is not full CRUD: rule editing and complete durable creator
identity are not implemented. Competing processes serialize publication through
a corpus lock; stale revisions and changed enabled/re-enabled template
fingerprints fail closed instead of suppressing a rebound template ID. Audit
capacity is reserved so every live rule can still be disabled and removed.

One enabled policy lens applies to event rows, matched counts, facets, Timeline,
Find, clustering/search/correlation/anomaly/trace analysis, and linked log
tools. A linked turn uses one pinned policy revision and reports that revision
and hidden-event count, so different tool calls cannot silently analyze
different evidence sets.

Suppression does not delete or edit events. The complete source catalog,
authoritative event identity, and **Original (redacted)** remain available. If
a bookmark or exact evidence reference is hidden only by the noise policy,
Explorer offers a targeted temporary reveal and restoration. That is not the
global temporary **include suppressed** action required by #671.

This is a partial exact-template Slice 1 and #671 remains open. Still required:

- source, service, host, level-plus-template, and explicitly reviewed-text
  rules;
- rule editing and complete durable creator identity;
- Investigation/saved-view rule references and package lifecycle;
- baseline-generated proposals and larger-rule-set optimization;
- one global temporary **include suppressed** action;
- one visible, auditable tool option to include suppressed evidence;
- suppression-specific 25k and 100k measurements, plus opt-in 1M proof when
  practical.

ContextDesk does not automatically learn or activate noise rules. Exact-template
Slice 1 is reversible and evidence-preserving, but it is only one predicate
family and is not a substitute for retaining the authoritative source bundle.

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

## Investigation timeline

The desktop timeline stays visible as a first-class overview so you can move
across the entire filtered corpus without loading intervening event bodies. The
backend performs fixed-size SQL aggregation and returns at most 96 count
buckets. Empty spans remain visibly empty. Stacked, patterned severity segments
distinguish Error, Warning, Info, Debug, and Other without relying on color
alone. The highlighted range marks buckets represented in the current bounded
resident window.

Sparse errors receive a separate red patterned signal scaled against the
largest visible error count. This keeps rare errors discoverable without
falsifying a bucket's total-volume height or severity proportions. Exact counts
remain available in **Timeline data** and accessible labels.

Drag or click anywhere on the broad chart scrubber. Movement changes the
preview marker without querying; releasing requests one event from that bucket
and loads its bounded neighborhood, leaving a separate committed marker.
Keyboard arrows, Home, and End use the same commit behavior. Compact UTC labels
replace a long machine timestamp. Hover or focus shows a compact synchronized
time, event-count, and severity callout. Right-click a bucket, or focus it and
press **Shift+F10**, to open the richer exact bounds, lane counts, resident
state, and severity breakdown. Click elsewhere or press Escape to dismiss it.
The complete textual bucket list remains available through **Timeline data**.

When session metric tracks are open, hovering the log histogram or any metric
track moves one shared preview line. A concise value and sample-time callout
appears at that same horizontal position on every metric track and on the log
histogram, while each metric header also updates to its nearest real sample.
The small right-edge labels are explicitly the visible **Max** and **Min**, not
the hovered value. Hovering only inspects—the logs move only after a deliberate
click, pointer release, or keyboard commit.
If **Detailed** tracks exceed the bounded Timeline height, scroll inside the
Timeline panel; the log viewport remains available below it.

With two to four lanes, compact coverage rows summarize each lane and retain
its own wall/mixed/order-only label; one lane cannot make another clock more
trustworthy. Wall-clock data uses UTC, order-only data is described as order,
and mixed data is labeled honestly. Use the integrated **Timeline** disclosure
or Escape to collapse it. While collapsed, filter changes perform no timeline
summary work until it is reopened.

## Long lines

**1 line** is the dense scan mode. **Preview** and **Deep** show a configurable
2/4/8/12-line bounded maximum (Deep doubles the chosen depth up to its cap).
Row height follows the displayed content, so a short one-line event remains
compact instead of reserving the entire preview maximum.
Press **X** on a focused row or use **Expand** for one event. Select a row for
the complete formatted content and metadata in the resizable inspector. When
stored, **Original (redacted)** provides a separately bounded representation
with normalization and truncation disclosures; it is not claimed to be
byte-identical raw input. Row preview truncation never claims to be the
complete record.

## Bookmarks

New bookmarks preserve the exact selected event set, including noncontiguous
selections. Saving the same exact set again reports **Already bookmarked**
instead of creating a duplicate. Legacy single/range bookmarks remain
readable. Activating a bookmark resolves its target directly. If current
filters or lane membership hide it, Explorer clearly offers a temporary reveal
and a way to restore the prior view.

## Investigation evidence

Selecting one or more resident rows opens a small contextual action strip.
**Ask about selection** prepares a tool-grounded chat prompt containing only
stable event identities (sequence and relative source), not copied messages or
raw payloads. You can edit the prompt before sending it.

**Save evidence** creates or updates the corpus-linked Investigation. Give the
selection a concise human title. The durable record stores exact payload-free
event references and human provenance outside the disposable corpus cache.
It does not depend on a chat and is not removed when chats are switched,
archived, or deleted.

Use the **Investigation** selector in the right rail to move between the durable
record and **Chat**. The record keeps findings, exact evidence, cited notes, and
bookmarks together. Filtering that record never discards items, and switching
to Chat preserves the Investigation browsing position. Evidence cards report
event/source counts and current identity health:

- **Verified** means corpus, sequence, relative source, timestamp, and time
  quality still match.
- **Changed** means the sequence exists but its identity hints differ.
- **Missing** means that sequence is no longer present.

**Preview** reloads a bounded set of authoritative rows and does not change
filters, lanes, selection, highlights, or scroll position. **Reveal in
Explorer** is a separate explicit action and is blocked for changed or missing
evidence. A reveal reuses the bookmark navigation contract, including
**Restore prior view** when filters or lane composition must be temporarily
broadened.

**Add…** creates a human-authored Observation, Inference, Hypothesis, or cited
note from the selected exact identities. Findings also save the complete
logical Explorer view: active filters, all lane memberships, visible lane
count, time-link mode, Find definition and exact highlights, selection, focus,
and per-lane position anchors. **Preview saved view** describes the proposed
changes without moving the Explorer. **Apply saved view** performs a fresh
trusted-host identity check, fails closed for missing or changed references,
and exposes **Restore prior view** for one-step return.

Richer proposal review, ranking, revision history, and report assembly remain
distinct follow-on investigation features.

## Agent context

Each linked-chat turn captures a small, immutable snapshot when the turn starts:
the corpus identity, visible lane/source groups, active search and filters,
selected and bookmarked counts, time quality, and link/alignment mode. Changing
the Explorer after send does not rewrite the context of an already-running
turn, and switching chats does not transfer its pending state.

When exact-template suppression is enabled, that snapshot also pins the policy
revision and hidden-event count. Every bounded log tool in the turn uses that
same exclusion lens and discloses that excluded events were not analyzed.

The snapshot is orientation, not a corpus dump. Every linked investigation must
first obtain a successful result from a bounded log tool. When relevant, the
same turn can use the normal configured read-only surface: bounded
workspace/Markdown search, durable-memory recall, bundled Help, and read-only
database or connector tools. Linking a corpus does not configure a source,
approve first-use access, or expose a write tool. An MCP read that still needs
first-use approval is omitted from the linked turn until it has been separately
authorized through the normal permission flow.

This is an evidence plane followed by a synthesis plane. ContextDesk owns source
eligibility, retrieval, caps, provenance, and permission checks; the model
connects the returned evidence and must distinguish observation from inference.
Skills can guide the process, but their instructions are not observed incident
evidence and cannot raise permissions. Consulted tools and source citations
remain with the originating chat. Failed, capped, unavailable, stale, or
permission-blocked sources remain visible rather than becoming silent success.
Raw corpora, workspaces, databases, evaluator truth, credentials, and absolute
source paths are not inserted wholesale.

During a linked turn, the chat reports whether it is choosing evidence,
retrieving bounded evidence, or synthesizing an evidence-cited answer. **Stop**
interrupts the active provider or tool wait. If retrieval succeeded but
synthesis reached its bounded deadline, the evidence remains visible and
**Retry synthesis** answers from that preserved evidence without another log
search. The retry is accepted only for the same chat, corpus, provider profile,
and model. Switching either provider or model clears the checkpoint. The
control appears only after the host confirms a still-valid checkpoint; a
timeout or provider-error message alone cannot enable it. A checkpoint is
published only after every explicitly requested source succeeds and synthesis
then times out, fails provider-side, or is rejected as ungrounded. Checkpoints
are memory-only, age/count/payload-byte bounded, and cleared when a chat is
trashed, deleted, archived, relinked, or superseded by a new linked turn.

The complete cross-source and provider-boundary explanation is available at
help://context-selection-model-boundary.

Agent navigation remains a proposal: ContextDesk validates it against the
linked corpus and applies it only after the user activates the suggested action.

Linked investigation requires a tools-enabled provider profile. If the selected
profile advertises `capabilities.tools=false`, ContextDesk stops before
contacting the provider and saves visible guidance that names the profile and
unavailable capability. Ordinary chats keep `linked_corpus_id=null` and do not
inherit an Explorer corpus or its active-corpus default.

## Cross-computer diagnostic feedback

Use **Export diagnostics…** in an active Explorer when you need to reproduce a
view or product defect on another machine. Review the exact preview, add a
short reproduction note, then copy the Markdown or save Markdown/JSON through
the native file dialog.

If an import fails, return to **Logs**. A **Failed import diagnostic available**
card appears without creating or publishing a partial corpus. Preview, copy, or
save it before clearing it. The preview includes typed counters for binary,
empty, hidden, oversized, read-failed, and parse-failed sources and a bounded
reason/basename transcript. At most 20 examples are retained; the report states
how many additional observations were omitted. ContextDesk retains only one
such diagnostic in memory: **Clear diagnostic**, the next ingest attempt, or an
app restart removes it. Raw and package imports both clear the prior diagnostic
before setup. A later attempt never silently inherits the previous failure, and
a later success leaves no failed-import diagnostic.

These reports exclude log/event payloads, absolute paths, source/service/host
labels from the active view, filter and trace text, private hosts/IPs, chats,
provider/model inventories, credentials, and evaluator truth. The preview can
be focused with the keyboard and scrolled independently. Markdown and JSON
buttons announce which format is selected.

The native host creates the exact visible preview from a strict, payload-free
metadata manifest and retains it under a short-lived report ID. Saving sends
only that ID and the selected format: the renderer cannot author report text,
choose the destination, or claim overwrite approval. The host-owned native
Save panel alone selects the destination and confirms replacement. Accepted
reports use a restricted same-folder temporary file and native atomic
publication without replacement for new files. Cancelling the panel is a
normal no-write outcome. If publication succeeds but a later cleanup or
directory-sync step fails, ContextDesk says the report was saved and shows a
durability warning. You must still review the preview before sharing.

At short window heights, scroll **Diagnostic details and exact preview**; the
dialog title, Close action, and Copy/Save actions remain available outside that
scrolling region. Note edits prepare only the latest host-rendered generation,
so rapid typing cannot leave the visible preview with an expired save ID.

Do not confuse diagnostics with **Export package…**. A diagnostic is a small
metadata and reproduction report. A `.cdlog.zip` is an explicit data-sharing
workflow that contains the analyzed corpus and should be handled according to
your organization’s data policy.

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

| Profile         | Use                                                            |
| --------------- | -------------------------------------------------------------- |
| `small`         | Checked-in mystery scenarios                                   |
| `medium`        | Legacy regular 100k smoke                                      |
| `ui-medium`     | 100k, 8 sources, multi-day, Find/bookmark sentinels            |
| `seven-day`     | Sparse/burst over seven days (event count independent of span) |
| `paging-stress` | Boundary sentinels for paging/eviction                         |
| `large`         | Opt-in million-event stress (local only)                       |

Import `scenarios/behavior-scale/import/` (or a compact scenario's `import/`),
never the scenario parent. Performance numbers from `--record-perf` are
one-machine observations, not universal claims. Full generator docs:
`fixtures/log-lab/README.md`.

## SoftWrite import vs session pack

| Path                  | Limit                            | Use                                    |
| --------------------- | -------------------------------- | -------------------------------------- |
| Logs SoftWrite ingest | Large dumps; streaming zip/lines | Analysis corpus for Explorer + tools   |
| Session context pack  | max 200 files / 50 MiB           | Chat attachments only — not huge dumps |

Cancel an in-progress SoftWrite with **Cancel ingest** on the progress panel.
Keyword-only and deferred corpora remain searchable. Use **Re-analyze locally…**
from the Logs overview to build template vectors with progress and cancellation;
the Explorer then labels semantic search available.

## Bookmarks and packages

Bookmarks live under the corpus cache as `bookmarks.json`. Durable
Investigation evidence lives under the application configuration root in a
versioned `investigations` store; it is independent of bookmarks and chats.
Portable package v1 does **not** export either artifact (by design). New
selections retain exact event
membership using payload-free corpus, sequence, source, and time-quality hints.
ContextDesk revalidates those references when the corpus reopens and visibly
marks missing or stale evidence instead of opening an unrelated row. Older range
bookmarks remain readable; their saved timestamps are hints rather than
authoritative event identity. Export packages contain events/templates only;
re-create bookmarks and noise policy after import if needed.

## Limits

Live tail, multi-corpus merge in one window, and SIEM alerting are not shipped.
See [How log analysis works](log-analysis-pipeline.md).
