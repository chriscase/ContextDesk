# Log Investigation Workspace (Log Explorer)

**Status:** product/architecture contract (owner decisions locked 2026-07-25)  
**Related:** [`LOG_ANALYSIS.md`](LOG_ANALYSIS.md) (DuckDB corpora, Drain, tools) · Logs library tab · session/chat model · portable packages  

## 0. Problem

Engineers troubleshooting large multi-service systems need to **see**, **align**, **search**, and **reason with AI** over post-mortem dumps. Today ContextDesk:

- Ingests dumps into **DuckDB event stores** + templates + vectors (analysis corpus).
- Offers a thin **Logs** tab (stats, crude volume strip, basic search) and **agent tools**.
- Does **not** offer a deep, multi-source log browser, time-linked parallel views, corpus-bound chat in-context, or bookmarks.

The existing “timeline” is event **volume** only — not a log browser.

## 1. North star

A **Log Investigation Workspace**: multi-window, responsively dense, AI-assisted, built for heavy engineering work.

| Job | Workspace support |
|-----|-------------------|
| What broke when? | Lanes + volume strip + level filters |
| Multi-component causality | 2–4 source-group lanes, optional timestamp-linked scroll + gap visualization |
| Find similar failures | Keyword + template-semantic → events |
| AI help without paste floods | Inline chat rail on corpus; tools use corpus + view + selection |
| Hand off | Existing corpus package; later: view/bookmarks export |

## 2. Locked owner decisions (2026-07-25)

1. **Chat column in v1** of the explorer window (inline). Chat uses **optimized log contexts** (corpus tools / templates / filters / selection — not raw multi‑MB pastes).
2. **Agent awareness of viewport:** the model should know what the engineer is looking at (active filters, time range, visible/selected events, lane source groups) and may emit **navigation links** that open or focus interesting sources/ranges in the viewer (user chooses to follow).
3. **Bookmarks:** engineer can bookmark interesting **lines or ranges** easily (persistent on corpus).
4. **Lanes:** **2–4** evidence lanes; responsive layout uses full real estate when available.
5. **Chat binding:** **any chat** may link to a corpus (`linkedCorpusId`), not only chats created from the explorer. Explorer lists all chats for that corpus and can create/append.

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
┌─ Explorer · corpus name · time quality · link ON/OFF · density ─────┐
│ Filters │ Evidence lanes (1–4)              │ Chats for corpus      │
│ sources │  lane A | lane B | …              │ list · new · open     │
│ levels  │  optional ts-link + gap bands     │ active thread         │
│ time    │  virtualized rows                 │ selection → ask       │
│ search  │  detail / bookmarks               │ agent nav links → UI  │
└─────────┴───────────────────────────────────┴───────────────────────┘
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
  spacing. The scalable range navigator remains separate work.
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
| `log_facets` | Sources, levels, services, hosts under filter |
| `log_timeline` | Filtered volume buckets (+ by_level) — already partial |
| `log_search_events` | Keyword/regex + template-semantic → bounded event-hit page; literal/regex Find continues with a composite time/sequence cursor |
| Bookmarks CRUD | Line or range anchors on corpus |
| Chat link | List/create sessions with `linkedCorpusId` |
| View context snapshot | Serialize filters/lanes/selection for agent |

**Semantic search remains template-first** (see `LOG_ANALYSIS.md`). Do not embed every raw line in v1.

## 6. Chat + agent integration

### Optimized context (not the dump)

Each turn / tool path may include:

- Corpus id (host active default when explorer focused)
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

- Bookmark **single seq** or **range [seqFrom, seqTo]** (and optional time bounds).
- Named label, color optional, notes.
- Persist under corpus (e.g. `bookmarks.json` sidecar, package-export later).
- Keyboard: `b` bookmark selection; list panel in explorer.

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
- Optional later: per-source timezone offset for multi-box dumps.

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

## 11. Phasing

| Phase | Deliverable |
|-------|-------------|
| 0 | This design + wireframes (narrow/normal/ultrawide) |
| 1 | Query API: events page, facets, filtered timeline |
| 2 | Multi-window shell: filters, single-lane grid, detail, density, splitters |
| 3 | Chat column: list/create/append any linked chats; view context to model; nav links |
| 4 | Bookmarks (line + range) |
| 5 | Multi-lane (2–4) + timestamp link + gaps |
| 6 | Search depth (keyword + semantic → events) polish |
| 7 | Help / CLAIMS / package note for bookmarks |

**Milestone “usable”:** phases 1–3.  
**Milestone “flagship multi-source”:** +5.  
**Milestone “bookmark + search depth”:** +4, +6.

## 12. Security

- Redacted messages only in UI and agent context.
- SoftWrite only for ingest/import; explorer is read-only on corpus + SoftWrite for bookmarks/session link metadata if needed.
- No home paths in IPC; basenames in debug/source labels.

## 13. Success criteria

- Engineer opens multi-window explorer on a multi-file corpus, filters sources/levels, scrolls a virtualized aggregate list with honest times.
- Ultrawide shows chat column + ≥2 lanes; link mode aligns scroll by time with visible gaps.
- Chat answers using corpus tools without requesting full dump paste; can propose nav links user can click.
- Bookmarks survive restart for that corpus.
- Logs tab remains the library entry point.
