# Log Investigation Workspace (Log Explorer)

**Status:** product/architecture contract (owner decisions locked 2026-07-25)  
**Related:** [`LOG_ANALYSIS.md`](LOG_ANALYSIS.md) (DuckDB corpora, Drain, tools) · Logs library tab · session/chat model · portable packages  

## 0. Problem and shipped foundation

Engineers troubleshooting large multi-service systems need to **see**, **align**,
**search**, and **reason with AI** over post-mortem dumps. ContextDesk now ships
a bounded multi-source Log Explorer with virtualized bidirectional rows, one to
four composed lanes, exact-time alignment, a shared investigation timeline,
durable bookmarks and Investigation records, and corpus-linked governed chat.
Remaining work is explicitly tracked under the partial and planned sections
below.

## 1. North star

A **Log Investigation Workspace**: multi-window, responsively dense, AI-assisted, built for heavy engineering work.

| Job | Workspace support |
|-----|-------------------|
| What broke when? | Full-width bounded investigation timeline with volume, severity, sparse-error signals, gaps, resident range, and seek |
| Multi-component causality | 1–4 source-group lanes, optional timestamp-linked scroll + gap visualization |
| Find similar failures | Keyword + template-semantic → events |
| AI help without paste floods | Inline chat rail on corpus; tools use corpus + view + selection |
| Hand off | Existing corpus package; later: view/bookmarks export |

## 2. Locked owner decisions (2026-07-25)

1. **Chat column in v1** of the explorer window (inline). Chat uses **optimized, governed evidence contexts**: a linked turn must obtain bounded corpus-tool evidence and may cross-check normal configured read-only workspace, memory, Help, or connector sources. ContextDesk owns eligibility, caps, provenance, and permissions; the model synthesizes results rather than receiving raw multi‑MB pastes. Retrieval is staged for self-hosted-model reliability: `search_logs` grounds the linked corpus first; an explicit workspace/runbook request then stages `search_kb`; once those requested sources succeed and no broader source was requested, the provider receives a tool-closed, bounded synthesis context. Ungrounded or fabricated call-shaped prose is withheld rather than presented as evidence.
2. **Agent awareness of viewport:** the model should know what the engineer is looking at (active filters, time range, visible/selected events, lane source groups) and may emit **navigation links** that open or focus interesting sources/ranges in the viewer (user chooses to follow).
3. **Bookmarks:** new saves preserve an exact bounded event set, including
   noncontiguous selections, and reject duplicate exact sets. Legacy
   single/range bookmarks remain readable.
4. **Lanes:** one to four evidence lanes are available according to usable
   width; hidden memberships survive visible lane-count changes.
5. **Chat binding:** the owner contract allows **any chat** to persist a corpus
   link (`linkedCorpusId`), not only chats created from Explorer. The shipped
   governed corpus-turn path remains the Explorer linked-chat rail; an ordinary
   main-screen chat never gains ambient corpus access.
6. **Slow-provider lifecycle:** one monotonic whole-turn ceiling governs
   separately bounded choosing, retrieving, and synthesizing phases. Adaptive
   defaults are patient for local/private profiles; a custom user ceiling is
   authoritative. Stop races every provider/tool await. When bounded evidence
   succeeds but synthesis times out, the trusted host retains only that
   redacted evidence for a same-chat, same-corpus, same-model tool-closed retry.

## 3. Surface split

### Logs tab (main app) — library

- Import folder / file / zip → analysis corpus (no chat-pack 200-file limit).
- Stats, import/export package, Debug, open **Explorer window**, **Chat about this corpus**.
- Not a million-row browser.

### Log Explorer — multi-window investigation

- Own Tauri window (resizable, maximizable, dual-monitor).
- Bound to one `corpusId` at open.
- Responsive breakpoints (narrow / normal / ultrawide) + **user-resizable splitters** + density (comfortable / compact).
- No artificial max content width that wastes ultrawide glass.

## 4. Layout

### Ultrawide default

```text
┌─ Log Explorer / corpus · time quality · counts ─────────────────────┐
│ Time · Lanes · Rows · Density · Columns · Bookmark                 │
├─────────┬─────────────────────────────────────────┬─────────────────┤
│ Filters │ Full-width investigation timeline       │ Investigation / │
│         ├─────────────────────────────────────────┤ Chat rail       │
│         │ 1–4 virtualized evidence lanes          │                 │
│         │ payload-first rows + event inspector    │                 │
└─────────┴─────────────────────────────────────────┴─────────────────┘
```

### Narrow

- Logs remain the primary surface with one evidence lane. The 2–4 lane controls
  are omitted because stacking wide lanes would make a misleading, unusable
  narrow view.
- Filters and linked chat are mutually exclusive drawers opened from explicit
  **Filters** and **Chat** controls. Their closed controls report active-filter,
  linked-chat, and working state without consuming the event viewport.
- Escape or the drawer's close control returns keyboard focus to the invoking
  control. Opening or closing a drawer preserves event selection, filters, lane
  paging, and linked-chat state.
- Filters include one **Clear all filters** action. The chat drawer keeps New
  linked chat, the active thread, composer, Send, and newest-message following
  reachable; technical context remains collapsed and developer-only detail is
  hidden by default.
- The event surface retains a practical minimum height of 240 CSS pixels before
  the outer window itself must scroll. The complete-event inspector remains
  independently closable and restores focus to the selected event.

### Event rows and complete reading

- Visible time is deterministic UTC. Single-day windows prioritize time of day;
  cross-day/year windows add the needed date, mixed quality is visibly marked,
  and order-only data never fabricates calendar time.
- Time, level, source, and message tracks have keyboard/pointer resize handles.
  Auto-fit samples at most 200 resident redacted events; reset restores defaults.
  Preferences are local to this desktop profile, not synchronized or exported.
- **1 line** is the dense scan mode. **Preview** and **Deep** use a user-selected
  bounded 2/4/8/12-line depth, and an individual row can be expanded.
- Selecting a row opens the resizable complete-event inspector. The inspector is
  the durable full-text path; bounded row previews do not claim to contain every
  character.

### Lane model

- A **lane** = virtualized event stream under a **source-group filter** (plus global filters).
- Global: level, time range, keyword/semantic, service/host when present.
- Per-lane: which `source` values (files) are included.
- **Independent:** every lane scrolls and pages independently.
- **Follow cursor:** selecting an event seeks each peer lane to its nearest
  resident timestamp. This is approximate and does not claim row alignment.
- **Align time:** reliable wall-clock lanes share an exact-timestamp slot model,
  identical row heights, and one synchronized virtual scroll coordinate. Empty
  cells are visually explicit gaps, never placeholder log events. Repeated
  same-time events use stable occurrence rows rather than being dropped.
- Align is intentionally an event-time axis, not proportional elapsed-time
  spacing. The integrated full-width Timeline uses fixed-size SQL summaries
  and a chart-wide scrubber to move the resident window across the full
  filtered span.
- Mixed, order-only, empty, failed, or unloaded lanes fail closed for Align;
  they cannot be upgraded by a more reliable lane.

## 5. Data plane (already mostly shipped)

Per corpus under app cache:

- DuckDB `events`: `seq, ts, level, service, host, template_id, params, trace_id, message, source`
- Templates + optional vectors (semantic at **template** scale, not every line)
- Meta/stats / debug transcript / portable package

### New / extended APIs (core + host)

| API | Purpose |
|-----|---------|
| `log_query_events` | Paged/keyset events with filter + sort |
| `log_query_event_rows` | Count-free paged/keyset rows for the first-evidence and pagination critical path |
| `log_count_events` | Exact filtered count, requested independently after bounded rows paint |
| `log_facets` | Sources, levels, services, hosts under filter |
| `log_timeline_summary` | Hard-capped filtered count buckets (+ by level) for the integrated full-width Timeline; no event bodies |
| `log_search_events` | Keyword/regex + template-semantic → bounded event-hit page; literal/regex Find continues with a composite time/sequence cursor and supports request-scoped cooperative cancellation |
| Bookmarks CRUD | Exact bounded event sets on one corpus, with duplicate prevention and legacy line/range reads |
| Chat link | List/create sessions with `linkedCorpusId` |
| View context snapshot | Serialize filters/lanes/selection for agent |

**Semantic search remains template-first** (see `LOG_ANALYSIS.md`). Do not embed every raw line in v1.

### Startup and paging critical path

Opening Explorer prioritizes bounded evidence rows over aggregate metadata:

1. read the corpus summary and a count-free first page;
2. paint the rows and clear the evidence-loading state;
3. request exact filtered counts, facets, bookmarks, and Investigation metadata
   independently after that paint; and
4. load the source catalog only when the lane composer needs it.

Pagination also uses the count-free row API and retains the last known exact
count. Event-revision changes invalidate a bounded per-open-corpus count cache.
Every asynchronous result is guarded by the current corpus/view lifecycle so a
stale response cannot reactivate or overwrite a newer Explorer.

The integrated Timeline is visible by default per the later owner design
decision. It is not part of the first-evidence request and starts its bounded
summary only after the initial rows paint. Collapsing it stops it from consuming
viewport space; it never needs event bodies.

A deterministic one-machine 250,000-event proof on 2026-07-29 observed: cold
open 21 ms, first count-free page 51 ms, exact count 1 ms, facets 20 ms, source
catalog 7 ms, shared timeline 74 ms, agent timeline 22 ms, and clustering
130 ms. The one-time import was 548.361 seconds and is a separate optimization
concern. These are measurements from one machine, not product-wide latency
guarantees.

## 6. Chat + agent integration

### Optimized context (not the dump)

Each turn / tool path may include:

- Explicit persisted `linkedCorpusId`; Explorer focus never gives an ordinary
  chat ambient corpus access
- Filter + time window summary
- Visible/selected seq ranges (ids, not full bodies beyond a small cap)
- Bookmark list summaries
- Template hits from semantic/keyword search

### Navigation links (agent → UI)

Agent may propose structured actions, e.g.:

```json
{ "type": "log_nav", "corpusId": "…", "sources": ["api.log"], "tsFrom": …, "tsTo": …, "highlightSeq": […], "label": "Auth failures after 14:02" }
```

UI renders as clickable chips; user opt-in applies filters / opens lane / scrolls to range.

### Bookmarks

- New evidence saves persist an exact bounded event set. Each payload-free
  reference contains corpus id, seq, relative source, and timestamp/time-quality
  hints; the trusted core revalidates those hints against DuckDB before save and
  on reopen. Noncontiguous selections are never widened to `min(seq)..max(seq)`.
- Legacy bookmarks remain readable as **single seq** or **range
  [seqFrom, seqTo]** entries. Their optional time bounds are display hints, not
  authoritative identity, and merely opening a legacy sidecar does not rewrite it.
- Current bookmarks use a generated label, exact payload-free identities,
  duplicate prevention, keyboard shortcut **B**, and an Explorer list with
  reveal, restore, and delete actions. Rich titles, rationale, findings, and
  notes belong to the durable Investigation workflow.
- Persist under corpus (e.g. `bookmarks.json` sidecar, package-export later).
- Keyboard: `b` bookmark selection; list panel in explorer.

### Durable Investigation evidence

The first Investigation vertical slice complements bookmarks without silently
rewriting them:

- Row selection reveals contextual **Ask about selection** and **Save evidence**
  actions. Ask prepares a bounded identity-only chat prompt; it never pastes
  selected messages into the chat context.
- Evidence persists in an append-only, versioned store under the durable
  application configuration root, never under the disposable corpus cache.
- One evidence item contains a human-authored redacted title, human provenance,
  and the same exact noncontiguous event identities validated for bookmarks.
  Messages, parameters, excerpts, and payload snapshots are not serialized.
- Writes require the expected revision. A competing Explorer window wins
  cleanly and a stale writer receives a visible conflict instead of overwriting
  the newer revision.
- The right-side **Investigation** rail switches compactly between Investigation and
  Chat while the hidden chat remains mounted with its draft, model, transcript,
  and scroll state intact.
- Evidence Preview re-resolves a bounded set of rows from DuckDB without
  mutating the active Explorer. Reveal is explicit, requires every identity to
  remain verified, and reuses bookmark reveal/restore navigation.
- Missing and changed identities remain listed honestly. Future document
  schemas fail closed.
- Human-authored Observation, Inference, and Hypothesis records and cited notes
  persist with exact evidence and optimistic revision checks.
- A finding may carry a payload-free Explorer view recipe covering filters, all
  lane memberships, visible lane count, time linking, Find/highlights,
  selection, focus, and per-lane logical viewport anchors. Preview is
  non-mutating; Apply revalidates every exact reference at the trusted host and
  offers one-step restoration of the prior logical view.

This foundation intentionally does not claim the remaining Investigation
workflow: model or detector proposals, ranked review, full proposal lifecycle
history, finding walkthroughs, or report assembly.

## 7. Search / filter matrix

| Mode | Mechanism | v1 |
|------|-----------|----|
| Structured | DuckDB WHERE | Required |
| Keyword | message match under filter | Required (ILIKE/prefix; FTS if needed later) |
| Regex | Advanced toggle | Optional v1 |
| Semantic | Template vectors → template_ids → events | Required |
| Trace | exact trace_id | If column populated |

## 8. Time quality

- Prefer parsed wall-clock `ts`.
- If missing: store order via `seq`; UI must **not** present synthetic seq as calendar time without label (existing pain).
- Track quality: wall / mixed / order_only (corpus + per-source).
- **Planned under #670:** explicit per-source timezone/year rules, DST
  ambiguity handling, original timestamp provenance, subsecond precision,
  clock-skew proposals, and reversible correction overlays. Current code does
  not guess these values.

## 9. UX / visual bar

- Design for **three breakpoints** + density; ultrawide uses multi-lane + chat rail.
- Engineer-grade information hierarchy: time + severity first; message primary; source secondary.
- Explicit **ux-expert** acceptance: dual-monitor + ultrawide screenshots, a11y contrast for levels, keyboard navigation.
- Explorer styling may extend app tokens but needs table/lane/gap/chat-rail thought — not a raw dump of panes.css.

## 10. Non-goals (v1–v1.5)

- Live tail / streaming (#290)
- Multi-corpus merge in one window
- Embedding every line
- Unredacted secret display
- Full SIEM / alerting
- Raising session-context 200-file chat-pack as the path for large dumps (corpus remains correct)

## 11. Delivery history and current residuals

Phases 1–7—the bounded query APIs, multi-window Explorer, governed linked-chat
rail, exact-set bookmarks, one-to-four composed lanes, search depth, and
Help/package disclosures—are implemented.

Current residuals are tracked explicitly:

- #670 timestamp provenance and per-source timezone/year/DST/skew rules;
- #671 durable, auditable noise policy;
- #690 versioned cross-corpus application baselines;
- #646 model finding proposals and review lifecycle;
- #532 fuller report assembly; and
- remaining packaged owner acceptance.

## 12. Security

- Redacted messages only in UI and agent context.
- SoftWrite only for ingest/import; explorer is read-only on corpus + SoftWrite for bookmarks/session link metadata if needed.
- No home paths in IPC; basenames in debug/source labels.

## 13. Success criteria

- Engineer opens multi-window explorer on a multi-file corpus, filters sources/levels, scrolls a virtualized aggregate list with honest times.
- Ultrawide shows chat column + ≥2 lanes; link mode aligns scroll by time with visible gaps.
- Chat obtains successful corpus-tool evidence without requesting a full dump,
  may cross-check other configured read-only sources, visibly distinguishes
  retrieved evidence from model inference, and can propose nav links the user
  can click.
- Bookmarks survive restart for that corpus.
- Logs tab remains the library entry point.
