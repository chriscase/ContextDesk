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
| Hand off | Existing corpus package; versioned accepted-state investigation report with confirmation-gated Markdown export; later: view/bookmarks export |

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

### In-app embed — same Explorer, pane-truthful (#851)

- **Open in app** (and the multi-window failure fallback, #503) runs the SAME
  Explorer inside the Logs pane under a slim chrome row (identity ·
  **Open in window…** · **Close Explorer** — in flow, keyboard reachable,
  never floated over the Explorer's toolbar).
- The embedded root sizes to the **pane**, not the window
  (`.log-pane--explorer-embed .log-explorer` in `log-explorer.css`), so the
  container breakpoints classify the true pane width and the §4 narrow drawer
  workspace activates in-app exactly when the pane is narrow.
- Tight-normal posture: below the width where fully-open rails cannot leave
  one minimum-width evidence lane (220 + 6 + 420 + 6 + 300 px), both rails
  START as their 42px strips; the first measured width decides once, and the
  user's toggles own the state afterwards. Never simultaneous compression of
  every rail.

## 4. Layout

### Ultrawide default

The identity area is corpus-first (#641): the contained-spark family mark,
a small "{branding.name} · LOG EXPLORER" eyebrow, and the corpus name as
the title — a real button whose grapheme-safe middle truncation keeps the
distinctive suffix, with the full name on hover, on keyboard focus, and in
an identity popover (selectable name plus source/engine/created/count/
time-basis). Status is one bounded vitals group (time-basis pill,
plain-text counts, noise disclosure); warning states never collapse. At
≥1600px the grouped pickers (Time · Lanes · Rows · Display · Noise) share
the identity row; below 1600px they form a second non-wrapping row.

```text
┌─ ▣ corpus-name (eyebrow: product · LOG EXPLORER) · vitals ──────────┐
│ Time · Lanes · Rows · Display · Noise · Bookmark · Export…         │
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
| `log_propose_noise_candidates` | Read-only bounded exact-template proposals with pinned revisions, exact facts, stable reasons, redacted representatives, and no policy mutation |
| Noise policy preview/activation/lifecycle | Preview and human-confirm corpus-scoped exact-template rules, then inspect, disable, re-enable, or tombstone them; rule editing and complete creator identity are not implemented |
| Bookmarks CRUD | Exact bounded event sets on one corpus, with duplicate prevention and legacy line/range reads |
| Chat link | List/create sessions with `linkedCorpusId` |
| View context snapshot | Serialize filters/lanes/selection for agent |

**Semantic search remains template-first** (see `LOG_ANALYSIS.md`). Do not embed every raw line in v1.

### Noise suppression — #671 Slice 1

Slice 1 adds a durable, corpus-scoped **exact-template** suppression lens. A
person selects an event, names the rule, supplies a rationale, and requests a
trusted-core preview. The preview derives the exact affected-event count,
incremental hidden count, level distribution, source count, time span, and a
bounded set of redacted representatives from the corpus. Only an explicit
human confirmation can enable the rule; detector/model origins remain proposals
and cannot self-activate.

The implementation exposes enable, disable, re-enable, and
remove-to-tombstone lifecycle operations with optimistic document revisions and
audit entries. Cross-process publication locking, no-follow sidecar reads,
enabled/re-enabled fingerprint revalidation, and reserved terminal-operation
audit capacity make this exact-template lifecycle fail closed and reversible.
Enabled template identities are routed through one bounded lens for event rows,
exact counts, facets, timeline summaries, Find, analysis, and linked log tools.
A linked turn pins one policy revision and discloses that revision and the
number of hidden events. Adapter-level tests prove every tool excludes the same
identities and restores them after the rule is disabled.

**The host owns the lens.** The webview is outside the trusted computing base
(`docs/THREAT_MODEL.md`), so exclusions arriving over IPC are a *request*. Each
Explorer read re-derives the trusted set and intersects the request with it, so
a stale or compromised renderer can hide at most what the durable policy
authorizes — never a template it was never granted. Intersection is also what
preserves **Suspend all** and temporary reveal: both request fewer identities,
and reducing a set can only reveal more. When the policy cannot be resolved the
effective set is empty with a typed reason, so nothing is hidden on the strength
of an unverifiable policy; the Explorer then withholds evidence and offers a
retry rather than painting a view it cannot describe. The renderer asks the host
which identities it will honour instead of deriving them, so the disclosed count
and the enforced set cannot drift apart.

The raw corpus, source catalog, bounded **Original (redacted)** record, and
direct exact-evidence resolution remain authoritative. If a bookmark or other
exact identity points to suppressed evidence, Explorer offers a clearly marked
temporary reveal and restoration of the suppression lens. Suppression never
rewrites the stored event or makes the source disappear.

This is deliberately Slice 1, not full #671, and #671 remains open. Remaining
acceptance work includes:

- source/service/host, level-plus-template, and explicitly reviewed-text
  predicates;
- rule editing and complete durable creator identity;
- Investigation and saved-view rule references with honest stale handling;
- package import/export lifecycle;
- baseline-driven proposals;
- one global temporary **include suppressed** action;
- an explicit visible, auditable tool option to include suppressed evidence;
- suppression-specific measurements on 25k and 100k corpora, plus an opt-in 1M
  proof when practical;
- optimization beyond the bounded active exact-template rule set.

### Explainable noise suggestions — #818

**Noise → Review suggestions** presents the #815 detector's ranked facts
without changing its ranking and without selecting or suppressing anything.
Each bounded candidate shows exact count/share, source breadth, severity
distribution, honest wall/order time coverage, coarse shape, reason codes,
core explanation, and redacted examples. The summary states **Showing N of M**
and distinguishes response/candidate caps from a bounded template scan.

High-severity, bursty, rare, and novel evidence is treated conservatively:
severity and burstiness are visible, risky proposals are marked, and the UI
never labels a candidate confirmed noise. **Not noise…** records a reviewed
reason for only the pinned corpus/template/policy revisions. **Suppress…**
reuses the separate trusted Preview → Confirm workflow; the proposal detector
cannot call preview or activation. Revision drift marks the review stale and
blocks action until refresh.

### Stale rules and policy-bound findings — #819

**Status: implemented.** Trusted rule resolution ships in
[`suppression.rs`](../../crates/cd-core/src/log_analysis/suppression.rs)
(`SuppressionRuleResolutionKind`), policy binding in
[`investigations.rs`](../../crates/cd-core/src/investigations/mod.rs)
(`InvestigationPolicyBindingStatus`, schema version 4), and the display and
Apply-gating contract in
[`policyBinding.ts`](../../desktop/src/lib/logExplorer/policyBinding.ts).
**Ordinary use cannot create these historical states.** Re-analysis does not
reparse events, so template identity never moves; and activation rejects a
duplicate predicate outright. A stale, conflicting, or unbound record is
therefore something a corpus *arrives* carrying, not something the product can
be driven into. Four such states — target missing, fingerprint changed,
conflicting predicates, and a legacy unbound finding — are exercised through
deterministic, bounded, `TEST-FIXTURE`-identified acceptance artifacts built
from typed production structures and consumed by the ordinary release importer
and loader, which re-derive resolution rather than trusting fixture metadata.
No production UI, command, capability, or release backdoor exists for creating
them. Invalid predicates remain automated-only because production validation
rejects importing them.

The first three are single importable packages. The legacy unbound finding is a
**pair**: a corpus package plus an investigation directory. The investigation
cites events inside that corpus, so it proves nothing on its own — and because
`import_corpus_zip` always mints a new corpus id and records the packaged one as
`origin_corpus_id`, the investigation must be rebound to the id the local import
assigned before its evidence resolves. The generated fixture set therefore ships
both artifacts, records the relationship and setup order in its manifest, and
carries a README describing a reversible install that runs only while the app is
closed and removes exactly one `TEST-FIXTURE` directory afterwards.

A corpus revision can change template identity — re-analysis, a timezone
declaration, package import. Two durable records must survive that without
changing meaning: a suppression rule and a finding.

**Rule resolution.** Every enabled rule resolves against the currently open
corpus into exactly one state. Only a state where the saved target *and* its
content fingerprint both still agree may exclude events; every other state
excludes nothing and carries a payload-free explanation:

| Condition | Excludes | User-visible label |
| --------- | -------- | ------------------ |
| Target and fingerprint agree | yes | *(no label)* |
| Target no longer exists | no | stale — matches nothing |
| Target exists, fingerprint differs | no | stale — template changed |
| Saved predicate not structurally valid | no | invalid — cannot be applied |
| Two enabled rules claim one target | no | conflicts with another rule |
| Disabled or removed | no | disabled / removed |

A numeric target is never re-bound by coincidence, a stale rule is never removed
automatically, and lifecycle actions plus audit history remain available on
every state. Resolution is computed against the open corpus and is not part of
the durable sidecar, so a stale judgment can never be persisted and later
believed.

**Policy binding.** A finding or saved view records the effective suppression
policy revision, the resolved template revision, and whether the noise lens was
active or suspended. Reopening compares that binding to the present state:
identical is current; a differing policy revision or lens is **Made under a
different noise policy**; a record predating binding is **legacy — policy not
recorded** and is never assumed current. Any non-current state previews rather
than applies, and blocks silent mutation.

`current_lens_unknown` is not a durable property of the finding: it means the
host could not read the current lens, so the comparison itself did not
complete. Apply stays blocked, but the remedy is to retry the read — never to
recompute or rewrite the record.

**Recompute.** **Recompute from current view** is an explicit durable mutation.
It replaces exactly two things on the stored finding — the saved view recipe and
its policy binding — and preserves prose, citations, lifecycle state, and
provenance unchanged. It runs only on direct user action; nothing recomputes in
the background, on open, or on policy change. A recompute that cannot reproduce
the current view exactly fails closed and changes nothing.

**Revision drift.** A resolved snapshot belongs to one template revision. A
response that no longer matches the current revision is discarded and re-derived
rather than rendered, so two revisions never mix on one surface.

**Restart, re-analysis, timezone apply/undo, and package round-trip** all
re-derive resolution from scratch; none of them may silently repair, re-bind, or
drop a rule, and undoing a timezone declaration must restore the prior
resolution rather than leave rules stale. An imported package keeps an unbound
finding unbound instead of adopting the importing profile's current policy.

**Diagnostics.** A diagnostic export must carry enough to review a suppression
decision on another machine and nothing more. It **may** include rule name,
recorded rationale, lifecycle state, resolution state and its explanation,
bounded matching counts, policy and template revisions, finding binding state,
and payload-free audit metadata. It **must not** include representative rows,
raw or redacted event payloads, hidden event content, template text, preview
tokens, absolute paths, or any other private data. The reviewer learns what was
hidden and why it was hidden — never what the hidden events said.

### Startup and paging critical path

Opening Explorer prioritizes bounded evidence rows over aggregate metadata:

1. read the corpus summary and a count-free first page;
2. paint the rows and clear the evidence-loading state;
3. request exact filtered counts, facets, bookmarks, and Investigation metadata
   independently after that paint; and
4. load the source catalog only when the lane composer needs it.

Pagination also uses the count-free row API and retains the last known exact
count. Event-revision changes invalidate a bounded per-open-corpus count cache.
Concurrent identical count requests recheck and publish that cache while
holding the corpus connection lock, so lanes sharing one filter snapshot
perform one exact scan. Every asynchronous result is guarded by the current
corpus/view lifecycle so a stale response cannot reactivate or overwrite a
newer Explorer. If a mounted Explorer is reused for another corpus, prior rows,
selection, highlights, and the inspector are cleared before the new corpus can
paint.

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

Model/detector proposals now ship as a durable SoftWrite review queue
(findings and report sections; explicit Accept / Edit-and-accept /
Dismiss-with-reason), and report assembly ships as a versioned accepted-state
projection with deterministic, confirmation-gated Markdown export. This
foundation still does not claim the remaining Investigation workflow: ranked
review, supersede/resolve lifecycle surfacing, finding walkthroughs, report
patches, or the fuller #532 report vocabulary and export formats.

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
- #671 remains open/partial: additional predicates; rule editing and creator
  identity; Investigation/saved-view and package lifecycle; baseline proposals;
  global temporary and auditable tool include-suppressed controls;
  suppression-specific 25k/100k/optional-1M measurements; larger-rule-set
  optimization; and the Slice 1 hardening listed in its design section;
- #690 versioned cross-corpus application baselines;
- #646 proposal ranking, walkthroughs, and supersede/resolve lifecycle
  surfacing (the durable propose/accept/dismiss queue ships);
- #532 fuller report workflow (richer section vocabulary, report patches with
  an undo trail, unsupported-claim detection, HTML/PDF export, evidence
  appendix, multi-corpus report UI) — the versioned accepted-state projection
  and Markdown export ship; and
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
