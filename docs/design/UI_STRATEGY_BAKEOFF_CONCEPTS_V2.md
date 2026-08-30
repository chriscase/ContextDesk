# ContextDesk UI-strategy bakeoff — five candidate concepts (v2)

Pinned to commit `02e66ddf755165be45092fabafd96b3153a5628f`.
Design artifact only. No implementation. PR #1108 was deliberately not read.

## 0. Binding, scope, and the boundaries treated as immutable

Bound to `02e66ddf755165be45092fabafd96b3153a5628f`; working tree clean at
survey time. Surfaces inspected were limited to what the brief required:
investigation creation and browse (`Cases.tsx`, `investigation-search.ts`),
view-first detail (`InvestigationRecord.tsx`, `ImportedRun.tsx`), evidence and
workbench primitives (`artifact.ts`, `snapshot.ts`, `investigation-workbench.ts`,
`investigation-corpus-intake.ts`, `EvidenceSnapshotCockpit.tsx`,
`LogWorkbench.tsx`), permissions (`capability.ts`), lifecycle
(`investigation-lifecycle.ts`, `LifecyclePanel.tsx`), routing
(`app-location.ts`), and the War Room docs.

These are inputs, not design space. Every concept below is constrained by them:

**Data boundaries.** Entities answer *who or what the work is about*; Sources
(Attribution) answer *where information came from*; neither stores content.
Evidence belongs to the investigation that captured it. Investigation context
is one descriptive `productName / version / build / component / environment /
organization` blob (single-line, ≤200 chars, display text preserved).
Software-impact rows are many concurrent epistemic judgments
(`observed | suspected | confirmed | ruled_out`) over named identities, with
**no invented build ordering** and `ruled_out` a first-class row.

**Capability boundaries.** Ten capabilities (`investigation:read`,
`investigation:write`, `evidence:private:read`, `run:strategies`,
`decision:accept`, `export:create`, `portable:restore`, `admin:users`,
`admin:system_config`, `audit:view`) over four roles; local grants are additive
only. **UI visibility is never authorization.** Viewers do not see write
controls — hiding is a courtesy, the server check is the boundary.

**Audit boundaries.** Activity is durable, server-recorded, attributed to the
signed-in identity, and carries a provenance class (restored history is not new
work). The activity feed is an orientation aid — explicitly **not** a complete
audit log, an urgency score, or an inferred priority ranking.

**Integrity boundaries.** Content hashes with `verified | unverified |
unreachable`; snapshot fingerprints with `same_snapshot | unknown` fairness;
contributions are revisioned (`predecessorRevision`) and tombstoned, never
erased; `owner_only | share_safe` privacy; legal hold refuses both tombstone and
archive; imported runs read "Unverified" until a human corroborates or
contradicts; agreement is not proof.

**Lifecycle boundary.** `open | monitoring | resolved | archived`. There is no
delete verb anywhere. Archive is reversible and restore reads recorded status
history (falling back to `open`, never `resolved`). Archived investigations are
hidden from the working list by default and the hidden count is always reported.

**Sparse-safe rule.** A blank field renders the words **Not recorded**. Absence
is a recorded fact, never an error and never a blank.

**Canonical URL grammar (unchanged by every concept).**
`/`, `/investigations`, `/investigations/{caseId}/{stage}`, `/entities`,
`/sources`, `/help`, `/profile`, `/admin/people`, `/admin/ldap`,
`/admin/model-policy`, `/administration`, `/signin`, `/not-found`; five stages
`situation | capture | analyze | compare | decide`; focus encoded as
`?section=&item=&kind=&lane=&experiment=#section` over fifteen route item
kinds. `navigation: "preserve"` is in-memory intent and deliberately not
encoded — the precedent every concept below follows for transient working state.

**Assumption stated once (see Open decisions).** "Shared strategy registry" is
read here as a registry of *selectable UI strategies*, each keyed by a stable id
and rendering over the same `WorkLocation` model, with URL round-trip
equivalence as the conformance test: a link produced by one strategy must open
the equivalent place in any other. It is read as distinct from the analysis
strategy host catalog in `investigation-strategy-connector.ts`.

---

## Concept 1 — Ledger Desk

**Promise.** Every investigation shows its own unfinished business as a short
list of named gaps you can close in place, so "what is left" is never a
judgment call.

**Core interaction model: gap-closing over a coverage ledger.** The primary
navigational primitive is a *gap row*, not a stage tab. The record is the
residue of closing rows.

### Primary workflows

*Novice (data entry).* Create on one page — title required, everything else
optional — and land on the record showing a ledger of named rows: Problem
statement, Affected people or systems, Impact, Scope, Open questions, Product /
version / build, When it happened, Evidence, Software impact, Decision,
Lifecycle. Click a row; it expands in place into the smallest editor that field
needs; save; the row moves from **Not recorded** to **Recorded** and shows its
value as the row summary. Progress reads "9 of 14 recorded" — a count of
recorded facts, never a score.

*Engineer.* The ledger doubles as a precondition list. "Freeze a snapshot" and
"Run a strategy" are rows that state their own preconditions ("No evidence
recorded yet", "No question stated"). Narrative rows collapse; Evidence /
Snapshot / Lane / Decision stay open. `g` + letter jumps to a row. Advanced log
tooling is one row labelled **Log workbench — optional**, never auto-opened.

### Information hierarchy

1. Identity strip — title, status word, severity word, occurred-at *and*
   recorded-at shown as two separate clocks.
2. The coverage ledger (the spine).
3. The expanded row — the only editing surface on the page.
4. Technical details, per row, behind a disclosure.
5. Activity / Lifecycle / Export — right rail on desktop, an "About this record"
   accordion on mobile.

### Wireframe — desktop (≥1080px)

```
┌──────────────────────────────────────────────────────────────────────┐
│ ContextDesk   Overview  Investigations  Entities  Attribution  Help  │
├──────────────────────────────────────────────────────────────────────┤
│ Investigations › Storefront checkout failures                        │
│ OPEN · HIGH · Happened 2026-03-04 (date only, zone not recorded)     │
│ Recorded 2026-03-06 14:02 · 9 of 14 recorded                         │
├───────────────────────────────────────────────┬──────────────────────┤
│ RECORD LEDGER                                 │ ABOUT THIS RECORD    │
│ ┌───────────────────────────────────────────┐ │ ─────────────────    │
│ │▎RECORDED   Problem statement            ▸ │ │ Activity (last 5)    │
│ │  Checkout returns 502 for EU cardholders  │ │ · j.ortiz recorded   │
│ ├───────────────────────────────────────────┤ │   impact  2h ago     │
│ │▎NOT RECORDED  Scope                     ▾ │ │ · import committed   │
│ │  What is in and out of this investigation?│ │   14 files  1d ago   │
│ │  ┌───────────────────────────────────────┐│ │                      │
│ │  │                                       ││ │ Lifecycle            │
│ │  └───────────────────────────────────────┘│ │ Archive keeps every  │
│ │  [ Record scope ]  [ Cancel ]             │ │ contribution, file,  │
│ ├───────────────────────────────────────────┤ │ and audit entry.     │
│ │▎RECORDED   Product / version / build    ▸ │ │ [ Archive… ]         │
│ │  Fixture Desk · 4.2 · build-007           │ │                      │
│ ├───────────────────────────────────────────┤ │ Export               │
│ │▎NEEDS A PERSON  Imported run            ▸ │ │ 3 artifact kinds     │
│ │  Unverified — nobody has corroborated it  │ │                      │
│ ├───────────────────────────────────────────┤ │                      │
│ │▎RECORDED   Evidence            14 items ▸ │ │                      │
│ ├───────────────────────────────────────────┤ │                      │
│ │▎NOT RECORDED  Decision                  ▸ │ │                      │
│ ├───────────────────────────────────────────┤ │                      │
│ │  Log workbench — optional               ▸ │ │                      │
│ └───────────────────────────────────────────┘ │                      │
└───────────────────────────────────────────────┴──────────────────────┘
```

### Wireframe — mobile (≤680px)

```
┌────────────────────────────┐
│ ‹ Investigations      ⋮    │
│ Storefront checkout        │
│ failures                   │
│ OPEN · HIGH                │
│ 9 of 14 recorded           │
├────────────────────────────┤
│ [ Not recorded (5) ] [All] │   ← filter chips, not tabs
├────────────────────────────┤
│▎NOT RECORDED               │
│ Scope                    ▾ │
│ ┌────────────────────────┐ │
│ │                        │ │
│ └────────────────────────┘ │
│ [ Record scope ]           │
├────────────────────────────┤
│▎NEEDS A PERSON             │
│ Imported run             ▸ │
├────────────────────────────┤
│▎RECORDED                   │
│ Problem statement        ▸ │
├────────────────────────────┤
│ About this record        ▸ │
└────────────────────────────┘
```

### Interaction and state model

Each row is a small machine: `not-recorded → editing → saving → recorded`, plus
`refused` (capability or legal hold, with the reason attached *before* the
click) and `stale` (a newer `situationVersion` landed). A conflict never merges
silently: the row reloads to server truth and keeps the operator's text below it
under "Your unsaved text". Row expansion is addressable as `?section={rowId}`.

### Empty, loading, error, read-only, sparse

- **Empty** — the ledger *is* the empty state: every row reads Not recorded with
  a one-line "why this matters". `role="status"`.
- **Loading** — labelled skeletons. Labels are static, so the page never
  reflows when data lands.
- **Error** — per-row `role="alert"` inline; the rest of the ledger stays
  usable. A page-level banner is reserved for lost authentication.
- **Read-only** — rows render as read rows and the expander becomes a view
  disclosure. No greyed-out write buttons at all.
- **Sparse imported** — header reads "Imported · 3 of 14 recorded" with an
  Imported, unverified banner. Rows the import could not populate say **Not
  recorded by the import**, which is deliberately distinct from Not recorded.

### Accessibility

Ledger is a list of `<section>`s with an `<h3>` each; expansion via
`<button aria-expanded aria-controls>`; state is a visible word with colour
redundant to it; saves announce through a `role="status"` region ("Scope
recorded. 10 of 14 recorded."); combo-boxes keep `role="combobox"`,
`aria-autocomplete="list"`, a named label, and a `<datalist>`; one column at
680px; `prefers-reduced-motion: reduce` makes expansion instantaneous;
forced-colors safe because state never depends on fill.

### Visual design direction

Clerk-modern. Row list on `--surface` over `--bg`, hairline `--border`
separators, no cards, no shadows. State word in small caps with a 3px left rule:
`--muted` (not recorded), `--success` (recorded), `--warning` (needs a person).
IBM Plex Sans throughout; mono only inside Technical details. Must hold in all
six themes.

### Strengths, risks, where not to use

*Strengths.* The strongest possible answer to "what is done / what needs
attention". Sparseness is the model, so imported records look correct rather
than broken. It teaches the domain by naming every field. Cheapest of the five
to build over today's components.

*Risks.* Reads as a compliance checklist and can pressure people to fill fields
with noise — a genuine data-quality risk, and the count makes it worse. The
count can be misread as a quality or priority score, which collides with the
product's refusal to infer priority. Weak for long narrative work.

*Do not use for.* Exploratory long-running investigations whose shape is unknown
up front; incident-bridge use where narrative speed beats completeness.

### Registry and canonical-URL compatibility

Pure re-presentation of the same `WorkLocation`. Requires only a stable
`rowId → (stage, section)` table in the strategy's registry entry so
`?section=evidence` under `/investigations/{id}/analyze` opens the Evidence row.
No new URL grammar, no new route item kinds, no new areas.

### Demoable prototype slice

Situation-stage ledger over one synthetic investigation with 3 recorded and 4
not-recorded rows; one legal-hold refusal rendered on the Lifecycle row before
any click; one viewer render. Proves gap-closing, refusal-before-attempt, and
read-only in a single screen.

---

## Concept 2 — Shift Queue

**Promise.** One keyboard-driven work queue across every investigation you can
see, so the next thing to do is the top row and nothing sits unowned.

**Core interaction model: dispatch.** The unit of interaction is a *work item*,
not an investigation. Items are derived only from recorded facts — an
uncorroborated imported run, an evidence item that is `unreachable`, an `open`
investigation with no recorded decision, a `stale` workbench bookmark, an
unresolved ambiguous timestamp. Ordering is user-chosen, the active ordering
rule is printed on screen, and nothing is ranked by inferred urgency.

### Primary workflows

*Novice.* The queue is home. Scope chips: Mine / Unassigned / All I can see. The
top row has focus. Enter opens it in a right-hand work pane containing only the
fields that item needs. Save removes the row with an undo affordance and focuses
the next. Creating an investigation is itself a queue action: the single-page
create form opens in the pane, and on save the new case enters the queue as
"Situation not recorded".

*Engineer.* `j`/`k` move, `Enter` opens, `o` opens the full investigation at its
canonical stage URL, `e` jumps to the Log workbench for that item. Shift-range
multi-select over rows of one kind gives one bulk action (mark 12 intake files
reviewed). Engineers work in All I can see filtered by kind.

### Information hierarchy

1. Queue controls — scope, kind, and the ordering rule stated in words.
2. Queue rows — kind word, investigation title, what is missing, recorded-at,
   owner or **Unassigned**.
3. The work pane.
4. The investigation itself, one keystroke away, always at a canonical URL.

### Wireframe — desktop

```
┌──────────────────────────────────────────────────────────────────────┐
│ ContextDesk   Queue  Investigations  Entities  Attribution  Help     │
├──────────────────────────────────────────────────────────────────────┤
│ [Mine] [Unassigned] [All I can see]   Kind: all ▾                    │
│ Ordered by: oldest recorded first (your choice) ▾   18 items         │
├───────────────────────────────────┬──────────────────────────────────┤
│ ▸ IMPORTED RUN                    │ Imported run — not corroborated  │
│   Storefront checkout failures    │ ──────────────────────────────── │
│   Not corroborated · 3d · Unassign│ Source: Vendor triage export     │
│ ──────────────────────────────────│ Snapshot binding: none recorded  │
│   EVIDENCE                        │ Prompt: Not recorded             │
│   Nightly batch stall             │                                  │
│   File server ref unreachable · 2d│ Output (excerpt)                 │
│ ──────────────────────────────────│ ┌──────────────────────────────┐ │
│   DECISION                        │ │ "The 502s begin after the    │ │
│   EU card declines                │ │  cert rotation at 03:11…"    │ │
│   Open, no decision recorded · 6d │ └──────────────────────────────┘ │
│ ──────────────────────────────────│                                  │
│   BOOKMARK                        │ A human must judge this.         │
│   Nightly batch stall             │ Link to: [ evidence item ▾ ]     │
│   Bookmark stale · 1d             │ [ Corroborated ] [ Contradicted ]│
│ ──────────────────────────────────│ [ Take this ]   [ Open case (o) ]│
│   … 14 more                       │                                  │
└───────────────────────────────────┴──────────────────────────────────┘
```

### Wireframe — mobile

```
┌────────────────────────────┐
│ Queue            Mine ▾    │
│ Oldest recorded first      │
│ 18 items                   │
├────────────────────────────┤
│ IMPORTED RUN               │
│ Storefront checkout        │
│ Not corroborated · 3d      │
│ Unassigned              ›  │
├────────────────────────────┤
│ EVIDENCE                   │
│ Nightly batch stall        │
│ Reference unreachable · 2d │
│ You                     ›  │
└────────────────────────────┘
  (tap → full-screen work pane,
   ‹ Back returns focus to row)
```

### Interaction and state model

Item lifecycle: `listed → focused → open → saving → done (undo window) →
removed`. Claiming writes an explicit owner — there is no silent lock and no
lease. If someone else records it first, the row flips in place to "Recorded by
{name}" rather than vanishing under the cursor. Undo persists until the next
action rather than expiring on a timer.

### Empty, loading, error, read-only, sparse

- **Empty** — "Nothing in this queue", the ordering rule restated, and a link to
  the full inventory. An empty queue is a success state and must look like one.
- **Loading** — previous rows stay, marked stale behind a thin progress bar. No
  blank-and-spin.
- **Error** — a failed save keeps the row and its draft; `role="alert"` in the
  pane.
- **Read-only** — viewers get a Watching queue: same rows, no take, no save.
- **Sparse** — sparse imported records generate honest items, which is precisely
  what a queue is for.

### Accessibility

Single-select listbox with roving tabindex; a live region announces "Row 3 of
18, imported run, Storefront checkout failures"; every shortcut has a visible
menu equivalent; focus returns to the originating row on pane close; undo is
keyboard-reachable and not time-limited.

### Visual design direction

Operations console. 32px rows, tabular-lining numerals, kind as an uppercase
text tag rather than a coloured pill, accent reserved exclusively for focus.
Dark-first but must pass all six themes and forced-colors.

### Strengths, risks, where not to use

*Strengths.* Highest throughput for data-entry staff. Makes unowned work
impossible to hide. The best answer in the set to "what needs attention".

*Risks.* The highest-risk concept here: a queue *implies* priority, and
ContextDesk explicitly refuses inferred priority. If the ordering rule is not
visible and user-chosen, the UI starts asserting urgency it cannot defend. A
queue also fragments the narrative — operators stop reading the investigation —
and can reduce investigation work to piecework. It is the only concept needing
a new canonical area.

*Do not use for.* Single-investigation deep work; small teams with two or three
open cases, where an empty queue delivers nothing; deployments that want the
case narrative to stay primary.

### Registry and canonical-URL compatibility

Needs one new canonical area (`/queue`, or reuse `/` as the strategy's home to
avoid grammar change). Every row action must resolve to an existing canonical
investigation URL — the queue is an index, never a destination holding state a
URL cannot express. Item kinds map one-to-one onto the fifteen existing
`ROUTE_ITEM_KINDS`; anything that will not map is out of scope.

### Demoable prototype slice

Eighteen synthetic rows across four investigations and three item kinds;
`j`/`k`/`Enter`; one save with undo; one "recorded by someone else" in-place
flip; a viewer render.

---

## Concept 3 — Casebook

**Promise.** Write the investigation as a dated logbook on the left while the
current, citable record assembles itself on the right.

**Core interaction model: append and promote.** Left column is an append-only
entry stream whose kinds are exactly the contribution kinds
(`message | note | hypothesis | action | upload | external_run`). Right column is
the standing record — Situation fields, software impact, decision — each field
showing its current value *and the entry it came from*. The signature gesture is
**promote**: take an entry (or a selection within it) and set a record field
from it, with a citation. Corrections are new entries and new revisions; nothing
is erased, matching `revision` / `predecessorRevision` / `tombstoned`.

### Primary workflows

*Novice.* Type into the always-present composer — "What did you observe?" — pick
a kind chip, post. Nothing else is required to start. When an entry answers a
record field, a quiet inline prompt appears beneath it: "Use as Impact?" One
click promotes it. The novice never opens a form.

*Engineer.* Entries are the unit. `⌘/Ctrl+Enter` posts. A pasted log excerpt
becomes an upload with a content hash. Hypothesis entries carry
`proposed | supported | contradicted | superseded` and link to artifacts or other
contributions. The right column is what they hand to a reviewer.

### Information hierarchy

1. Record header — title, status, both clocks.
2. Two columns: entry stream | standing record.
3. Each record field: value, "from entry #7", or **Not recorded**.
4. Technical details per entry.

### Wireframe — desktop

```
┌──────────────────────────────────────────────────────────────────────┐
│ Investigations › Storefront checkout failures    OPEN · HIGH         │
│ Happened 2026-03-04 (date only) · Recorded 2026-03-06                │
├────────────────────────────────────────────┬─────────────────────────┤
│ CASEBOOK                                   │ STANDING RECORD         │
│                                            │ ───────────────────     │
│ ── Mon 4 Mar ─────────────────────────     │ Problem statement       │
│ 09:12  j.ortiz   NOTE                      │ 502 at checkout for EU  │
│ Support reports 502 at checkout,           │ cardholders.  from #1   │
│ EU cards only.                             │                         │
│        [ Use as Problem statement? ]       │ Affected                │
│                                            │ Not recorded            │
│ 09:40  j.ortiz   UPLOAD                    │                         │
│ edge-gateway.log · 1.2 MB · verified       │ Impact                  │
│                                            │ Not recorded            │
│ 11:02  m.chan    HYPOTHESIS  proposed      │                         │
│ Cert rotation at 03:11 broke the           │ Scope                   │
│ upstream handshake.  cites #2              │ Not recorded            │
│                                            │                         │
│ ── Tue 5 Mar ─────────────────────────     │ Open questions          │
│ 08:15  (imported)  EXTERNAL RUN            │ Not recorded            │
│ ▲ Unverified imported run                  │                         │
│ Vendor triage export                       │ Product / version /     │
│ [ Corroborate ] [ Contradict ]             │ build                   │
│                                            │ Fixture Desk · 4.2 ·    │
├────────────────────────────────────────────┤ build-007   from #4     │
│ ( note ) (hypothesis) (action) (upload)    │                         │
│ ┌────────────────────────────────────────┐ │ Decision                │
│ │ What did you observe?                  │ │ Not recorded            │
│ └────────────────────────────────────────┘ │                         │
│                             [ Post entry ] │ [ Software impact ▸ ]   │
└────────────────────────────────────────────┴─────────────────────────┘
```

### Wireframe — mobile

```
┌────────────────────────────┐
│ ‹  Storefront checkout     │
│ OPEN · HIGH                │
├────────────────────────────┤
│ RECORD (current)         ▾ │   ← record first, so current
│ Problem  502 at checkout…  │      state precedes history
│ Impact   Not recorded      │
│ Decision Not recorded      │
├────────────────────────────┤
│ CASEBOOK                   │
│ ── Mon 4 Mar ───────────   │
│ 09:12 j.ortiz NOTE         │
│ Support reports 502…       │
│ [ Use as Problem? ]        │
│                            │
│ 09:40 j.ortiz UPLOAD       │
│ edge-gateway.log verified  │
├────────────────────────────┤
│ ┌────────────────────────┐ │
│ │ What did you observe?  │ │
│ └────────────────────────┘ │
│ (note)(hyp)(action)  Post  │
└────────────────────────────┘
```

### Interaction and state model

Entry: `composing → posting → posted (revisable)`. Record field: `not recorded →
recorded (cited) → superseded (cited, prior still visible)`. Promotion never
rewrites the source entry. Time is explicit throughout: entries carry
recorded-at; the header carries occurred-at with precision and zone stated
rather than inferred.

### Empty, loading, error, read-only, sparse

- **Empty** — composer with a first-run prompt beside a right column of Not
  recorded fields. The best empty state of the five: it reads as an invitation.
- **Loading** — stream loads newest-first with "Load earlier"; the right column
  renders immediately from the case record and never waits on the stream.
- **Error** — a failed post keeps the draft in the composer with `role="alert"`
  and a retry. Typing is never lost.
- **Read-only** — the stream reads as a document; the composer is replaced by
  one line: "You can read this investigation."
- **Sparse** — an imported case with three entries and two fields looks
  *correct*: the book is simply short. Imported entries carry a provenance chip
  and the unverified banner.

### Accessibility

Stream is an ordered list of `<article>`s with headings and day separators as
real headings. The composer is a labelled textarea plus a radiogroup of kind
chips. **Promote is a real button opening a `<dialog>` with a field select — not
a drag gesture.** A live region announces "Entry posted" and "Impact recorded
from entry 7". Reading order is stream-then-record on desktop and
record-then-stream on mobile.

### Visual design direction

Editorial. ~68ch measure on the stream, 16/25 body, hairline day rules,
timestamps in `--muted` in a left gutter. The right column is deliberately
quieter — a summary, not a competing surface.

### Strengths, risks, where not to use

*Strengths.* Lowest friction for people who do not know the schema. Produces the
best narrative for handoff. Naturally sparse-safe. Maps exactly onto the
contribution/revision model already shipped.

*Risks.* Current state can hide inside a long stream if the record column ever
leaves the viewport — mobile is where this fails. Promotion is a new concept
that needs teaching. Two write paths (post-then-promote versus direct field
edit) will diverge unless one is made canonical.

*Do not use for.* High-volume structured data entry; queue-style triage; teams
that must compare many investigations quickly.

### Registry and canonical-URL compatibility

Fully compatible with no new kinds. Stream items are
`?section=capture&item={contributionId}&kind=contribution`; promotion targets
live under `?section=situation`. One requirement: on mobile,
`?section=situation` must open the record column and must not be captured by the
stream.

### Demoable prototype slice

One synthetic investigation with six entries across four kinds, one unverified
imported run with corroborate/contradict, one promotion that fills Impact and
shows the citation, and the mobile record-first ordering.

---

## Concept 4 — Evidence Table

**Promise.** The evidence inventory is the workspace: a sortable, filterable
table with real metadata, an explicit selection tray, and a freeze you can read
before you commit to it.

**Core interaction model: tabular selection.** The default surface for an open
investigation is the evidence grid — one row per artifact, corpus item, imported
run, or snapshot member. Columns: name, kind, source label, recorded-at, byte
length, verification word, privacy class, annotation count. Selection is
explicit and persists in a **tray** that names exactly what it holds, and the
tray is the *only* path to Freeze. Snapshots, lanes, and comparisons are derived
views of a frozen selection.

**Why a table and not a canvas.** An evidence-led *canvas* was considered and
rejected. A spatial canvas has no reading order, no sort, no keyboard model and
no honest empty state, and ContextDesk's evidence is a list with metadata rather
than a graph. The table keeps the evidence-led thesis, is far better for
data-entry staff, and gives annotations a first-class column.

### Primary workflows

*Novice.* Open the investigation and see the files just uploaded, each with a
verification word. Click a row for a drawer with the excerpt, metadata, and
"Add a note about this item". Tick four rows; the tray says "4 selected · 1
unverified"; press Freeze; a confirmation panel restates the exact list; freeze
completes and shows a fingerprint.

*Engineer.* Column sort and filter, saved column layouts, keyboard multi-select
(shift-range, `x` to toggle), the tray as a working set carried between Log
workbench panes, and Freeze → Run with the same-snapshot fairness statement
shown before launch rather than after.

### Information hierarchy

1. Investigation strip.
2. Filter bar, with the active filter stated in words.
3. The grid.
4. The sticky selection tray.
5. The detail drawer.
6. Derived views — Snapshots, Lanes, Comparison — as tabs *above* the grid,
   because they are readings of it.

### Wireframe — desktop

```
┌──────────────────────────────────────────────────────────────────────┐
│ Storefront checkout failures   OPEN · HIGH        [ Log workbench ▸ ] │
│ [ Evidence ] [ Snapshots 2 ] [ Lanes 3 ] [ Comparison ] [ Decide ]   │
├──────────────────────────────────────────────────────────────────────┤
│ Showing: all 14 items · kind: any · verification: any    [ Filter ▾ ] │
├──┬───────────────────────┬────────┬───────────┬────────┬─────────────┤
│☐ │ Name                  │ Kind   │ Recorded  │ Size   │ Verification│
├──┼───────────────────────┼────────┼───────────┼────────┼─────────────┤
│☑ │ edge-gateway.log      │ log    │ 4 Mar 09:4│ 1.2 MB │ Verified    │
│☑ │ checkout-trace.txt    │ log    │ 4 Mar 10:1│ 88 KB  │ Verified    │
│☐ │ vendor-report.eml     │ email  │ 5 Mar 08:1│ 12 KB  │ Unverified  │
│☑ │ //fs01/nightly/*.log  │ ref    │ 5 Mar 08:2│ —      │ Unreachable │
│☑ │ cert-rotation.json    │ attach │ 5 Mar 11:0│ 4 KB   │ Verified    │
│☐ │ batch-stall.log       │ log    │ 6 Mar 07:3│ 640 KB │ Verified    │
│  │ … 8 more                                                          │
├──┴───────────────────────┴────────┴───────────┴────────┴─────────────┤
│ TRAY  4 selected · 1 unreachable · 0 not shown by this filter        │
│       [ Review and freeze ]  [ Clear ]                               │
└──────────────────────────────────────────────────────────────────────┘

  Review and freeze →
  ┌────────────────────────────────────────────┐
  │ Freeze these 4 items                       │
  │ · edge-gateway.log          verified       │
  │ · checkout-trace.txt        verified       │
  │ · //fs01/nightly/*.log      UNREACHABLE    │
  │ · cert-rotation.json        verified       │
  │                                            │
  │ A frozen snapshot cannot be changed. A     │
  │ different selection is a new snapshot.     │
  │            [ Cancel ]  [ Freeze 4 items ]  │
  └────────────────────────────────────────────┘
```

### Wireframe — mobile

```
┌────────────────────────────┐
│ ‹ Storefront checkout      │
│ Evidence ▾   14 items      │
├────────────────────────────┤
│ ☑ edge-gateway.log         │
│   log · 1.2 MB · Verified  │
├────────────────────────────┤
│ ☐ vendor-report.eml        │
│   email · 12 KB ·          │
│   Unverified               │
├────────────────────────────┤
│ ☑ //fs01/nightly/*.log     │
│   ref · Unreachable        │
├────────────────────────────┤
│ 2 selected · 1 unreachable │
│ [ Review and freeze ]      │   ← sticky tray
└────────────────────────────┘
```

### Interaction and state model

Row: `listed → selected → in a frozen snapshot`. Tray: `empty / holding N /
freezing / frozen (fingerprint)`. Two safety rules are load-bearing: **a filter
change never changes the selection**, and the tray always states how many
selected items the current filter is hiding. Unfreezing does not exist; a
different selection is a new snapshot with a parent link.

### Empty, loading, error, read-only, sparse

- **Empty** — "No evidence recorded yet" with the three intake paths (files,
  ZIP, directory) and the allowed media types and extensions stated up front,
  so limits are learned before rejection rather than through it.
- **Loading** — table skeleton with real column headers; row count announced
  when settled. Corpus intake keeps preview → commit with rejected files listed
  and each reason named.
- **Error** — an unreachable file-server reference is a first-class row state
  with its reason attached, not a toast. The row stays and says what is wrong.
- **Read-only** — full grid, no checkboxes, no tray; Snapshots still readable.
- **Sparse** — one row with **Not recorded** in the metadata columns. Columns do
  not collapse, so the gaps stay visible.

### Accessibility

A real `<table>` with `<caption>` and `<th scope>`; sortable headers as buttons
carrying `aria-sort`; a "select all shown" control that says *shown*; the tray
is `role="region"` with `aria-live="polite"` announcing count changes;
horizontal scroll in its own keyboard-scrollable container; forced-colors
explicitly tested, since verification must never be colour-only.

### Visual design direction

Instrument panel. 36px rows, tabular-lining numerals, a single hairline grid,
verification as a word with a small redundant glyph, and the tray as a solid
`--surface-deep` bar that cannot be missed. Accent used only for selection and
focus.

### Strengths, risks, where not to use

*Strengths.* The most honest surface for evidence integrity. Makes safe
selection *structurally* safe rather than procedurally safe — the confirmation
restates the list, the tray never lies about hidden items. Best fit for corpus
intake at volume. Gives annotations a real home.

*Risks.* An evidence-first default buries the Situation narrative; a novice may
never write a problem statement. Tables are hostile on phones. It is the
heaviest build: virtualization, selection, and full table accessibility
together.

*Do not use for.* Investigations that are mostly prose; mobile-primary
deployments; teams whose cases carry one or two evidence items.

### Registry and canonical-URL compatibility

All addresses already exist: `?section=evidence&item={artifactId}&kind=evidence`,
plus `kind=snapshot` and `kind=lane`. **The tray is client state and must not be
encoded in the URL**, following the existing precedent that `navigation:
"preserve"` is deliberately not encoded. A shared link therefore opens the same
evidence with an empty tray — the safe behaviour — and the UI must say so.

### Demoable prototype slice

Forty synthetic evidence rows across three verification states; filter plus
shift-select; the tray showing "2 selected not shown by this filter"; the freeze
confirmation restating the exact list; one resulting frozen snapshot with its
fingerprint and fairness class.

---

## Concept 5 — Two Desks

**Promise.** One record, two purpose-built desks — a Clerk desk for recording
and an Analyst desk for examining — with an explicit switch that changes the
tools, never the truth and never the permissions.

**Core interaction model: role-adaptive shell with a user-controlled switch.**
The switch is a persisted preference, plainly labelled and always reversible. It
is emphatically **not** an authorization boundary: the Clerk desk hides the Log
workbench because it is noise, not because the person may not use it. Server
capability checks are unchanged and both desks render identical refusals.

*Clerk desk.* Single column, large targets, form-first: create, record
Situation, intake files, add software-impact rows, record involvement,
archive/restore. Every technical identifier stays behind Technical details. No
lane launching.

*Analyst desk.* Three panes, dense: evidence and workbench panes, the
snapshot/fairness cockpit, lanes, comparison, traces, export.

### Primary workflows

*Novice.* Lands on Clerk. Never meets a strategy id, a fingerprint, or a pane
splitter unless they choose to switch.
*Engineer.* Lands on Analyst; one control returns to Clerk when the record needs
writing properly.

### Information hierarchy

1. The desk switch, beside the investigation title, naming the current desk.
2. Desk-specific hierarchy below it.
3. A **shared record-state bar**, identical on both desks: status word, coverage
   count, decision recorded yes/no. This is what stops the two desks disagreeing
   about state.

### Wireframe — desktop, Clerk desk

```
┌──────────────────────────────────────────────────────────────────────┐
│ Storefront checkout failures     Desk: ( Clerk ) ( Analyst )         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Problem statement                                                  │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │ Checkout returns 502 for EU cardholders.                     │   │
│   └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   Affected people or systems                                         │
│   ┌──────────────────────────────────────────────────────────────┐   │
│   │                                                              │   │
│   └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   Product name        Version         Build                          │
│   [ Fixture Desk ▾ ]  [ 4.2      ▾ ]  [ build-007  ▾ ]               │
│   Suggestions come from investigations you can already see.          │
│                                                                      │
│   Files                              [ Add files ] [ Add a ZIP ]     │
│   14 recorded · 13 verified · 1 unreachable                          │
│                                              [ Save this record ]    │
├──────────────────────────────────────────────────────────────────────┤
│ OPEN · 9 of 14 recorded · No decision recorded        (shared bar)   │
└──────────────────────────────────────────────────────────────────────┘
```

### Wireframe — desktop, Analyst desk

```
┌──────────────────────────────────────────────────────────────────────┐
│ Storefront checkout failures     Desk: ( Clerk ) ( ANALYST )         │
├───────────────┬──────────────────────────────┬───────────────────────┤
│ EVIDENCE   14 │ edge-gateway.log      pane 1 │ SNAPSHOT              │
│ ☑ edge-gatew… │ 03:11:02 handshake failed …  │ fp 9c41…7e  frozen    │
│ ☑ checkout-t… │ 03:11:02 upstream 502 …      │ 4 items · same_snapsh │
│ ☐ vendor-rep… │ 03:11:03 retry exhausted …   │                       │
│ ☑ //fs01/nig… │ ─────────────── pane 2 ───── │ LANES                 │
│ ☑ cert-rotat… │ 03:10:58 cert reload begin   │ · standard   complete │
│               │ 03:11:01 cert reload done    │ · challenge  running  │
│ [ Find ]      │                              │ · timeline   queued   │
│ [ Saved views]│ [ + pane ]  panes 2/4        │ Agreement is not proof│
├───────────────┴──────────────────────────────┴───────────────────────┤
│ OPEN · 9 of 14 recorded · No decision recorded        (shared bar)   │
└──────────────────────────────────────────────────────────────────────┘
```

### Wireframe — mobile

```
┌────────────────────────────┐
│ ‹ Storefront checkout      │
│ Desk: Clerk ▾              │   ← Analyst offers a reduced,
├────────────────────────────┤      read-mostly form on mobile
│ Problem statement          │
│ ┌────────────────────────┐ │
│ │ 502 for EU cardholders │ │
│ └────────────────────────┘ │
│ Affected                   │
│ ┌────────────────────────┐ │
│ └────────────────────────┘ │
│ [ Save this record ]       │
├────────────────────────────┤
│ OPEN · 9 of 14 · no        │
│ decision recorded          │
└────────────────────────────┘
```

### Interaction and state model

Desk is a persisted preference with an optional non-canonical URL override. The
switch must guarantee no work is lost: unsaved drafts are carried across, or the
switch is refused with a named reason. Focus moves to the main heading on
switch and the change is announced.

### Empty, loading, error, read-only, sparse

Each desk carries its own, but the shared record-state bar renders identically
in both — which is what keeps them honest. Read-only renders both desks, with
Clerk becoming a printed-form-like read view. Sparse: Clerk shows gaps as empty
fields with Not recorded; Analyst states preconditions in words ("This
investigation has no frozen snapshot") instead of offering a disabled button
with no explanation.

### Accessibility

The switch is a labelled radiogroup, announced on change with the new desk named
and the focus destination stated. Reduced motion means no cross-fade. Both desks
must independently satisfy the 680px single-column rule and forced-colors — this
is a doubling of the accessibility surface and must be budgeted as such.

### Visual design direction

Two skins over one token set. Clerk: light-leaning, 17/27 type, generous
padding, few borders. Analyst: dark-leaning, 14/20, dense borders. Identical
accent, identical status words, identical iconography. The difference should
read as magnification, never as two products.

### Strengths, risks, where not to use

*Strengths.* Serves both audiences honestly instead of averaging them into a
compromise. The safest place to put advanced log tooling. The shared bar
directly answers "what is done".

*Risks.* The highest cost in the set — two surfaces to build, test, document and
keep in sync, and the most likely to drift. Users get lost ("there was a button
here"). Most seriously, a visible desk switch invites people to read it as a
permission level, which is exactly the confusion the capability model exists to
prevent.

*Do not use for.* Small teams where everyone does both jobs; deployments that
cannot fund two accessibility-complete surfaces; as a substitute for actual
capability design.

### Registry and canonical-URL compatibility

Desk is presentation, so it must **not** be canonical — otherwise one
investigation has two canonical addresses and link equivalence breaks. An
optional `?desk=` override that `pathFor` never emits is acceptable. This is the
only concept that puts real pressure on the URL contract and it needs an
explicit registry ruling before prototyping.

### Demoable prototype slice

One investigation rendered in both desks; a switch that preserves an unsaved
draft; the shared state bar byte-identical in both; a viewer render on each.

---

## Comparison matrix

| Dimension | 1 Ledger Desk | 2 Shift Queue | 3 Casebook | 4 Evidence Table | 5 Two Desks |
| --- | --- | --- | --- | --- | --- |
| Unit of interaction | Gap row | Work item | Dated entry | Evidence row | The desk |
| Navigational primitive | Coverage ledger | Queue cursor | Append stream | Sorted grid + tray | Mode switch |
| "What is done" | **Excellent** — counted | Weak per-case | Good (record column) | Weak | Good (shared bar) |
| "What needs attention" | Good (per case) | **Excellent** (cross-case) | Weak | Good (verification) | Fair |
| "What value do I get" | Fair | Good (throughput) | **Excellent** (narrative) | **Excellent** (integrity) | Good |
| Fast single-page create | **Excellent** | Good (in pane) | **Excellent** (just type) | Poor | Good |
| Basic / advanced organization | **Excellent** (row-level) | Fair | Good (kind chips) | Good (columns) | **Excellent** (by desk) |
| Controlled product/build reuse | Excellent (combo in row) | Fair | Good (promote) | Fair | Excellent |
| Compact browse / search | Fair | **Excellent** | Fair | Good (in-case only) | Fair |
| Sparse imported records | **Excellent** | Good | **Excellent** | Good | Good |
| View-first polished detail | **Excellent** | Poor | **Excellent** | Fair | Good |
| Evidence metadata + annotations | Fair | Fair | Good | **Excellent** | Good |
| Safe selection / freeze | Fair | Poor | Fair | **Excellent** | Good |
| Recoverable lifecycle language | **Excellent** | Fair | Good | Fair | Good |
| Optional advanced log tools | Excellent (one row) | Good (`e`) | Fair | **Excellent** (tab) | **Excellent** (desk) |
| Novice fit (data entry) | **Excellent** | **Excellent** | **Excellent** | Fair | **Excellent** |
| Engineer fit | Good | **Excellent** | Good | **Excellent** | **Excellent** |
| Mobile viability | Good | **Excellent** | Good | Poor | Fair |
| Accessibility difficulty | Low | Medium | Low | **High** | **High** (×2) |
| Build cost | **Low** | Medium | Low–Medium | High | **Highest** |
| Canonical-URL pressure | None | New area needed | None | Tray must stay unencoded | Desk must stay non-canonical |
| Risk of asserting priority the product refuses | Medium (the count) | **High** (queue order) | Low | Low | Low |
| Distinctness of interaction model | High | High | High | High | Medium (it is packaging) |

---

## Recommendation — prototype these three

**Ledger Desk, Casebook, Evidence Table.**

They are recommended together because they disagree about the most important
thing — what the unit of interaction is. Ledger Desk says it is the *absent
field*, Casebook says it is the *dated entry*, Evidence Table says it is the
*evidence row*. That makes a real bakeoff rather than three skins. Between them
they also cover the full requirement set: Ledger Desk owns done/attention,
creation and lifecycle; Casebook owns novice onboarding, sparse records and
view-first detail; Evidence Table owns metadata, annotations and safe selection.

**Shift Queue is not recommended as a whole strategy, and this is deliberate.**
Its core premise — an ordered list of what to do next — sits directly against a
stated product boundary: ContextDesk refuses inferred urgency and priority
ranking. It is defensible only with a user-chosen, on-screen ordering rule, and
even then a queue teaches operators that the top row matters most. It is also
the only concept requiring a new canonical area. Its genuinely good idea — the
cross-investigation attention lane derived strictly from recorded facts — should
be harvested as a *component* inside whichever strategy wins, not prototyped as
a competing shell.

**Two Desks is not recommended for this round either**, for a different reason:
it is packaging, not a core interaction model. It can wrap any of the other
three, so testing it now would confound the variable the bakeoff is meant to
isolate. Revisit it as a follow-on question once a core model wins — at which
point it becomes a well-formed question ("does this model need two densities?")
rather than a fourth contender.

### How the three differ from War Room (the shipped UI)

War Room's primitive is the **stage**. An investigation is five routes —
Situation, Capture, Analyze, Compare, Decide — with an Overview feed for
orientation. Its answer to "what is done" is distributed prose plus **Not
recorded**: you must visit up to five routes to assemble the answer, and nothing
on any single screen tells you how much of the record exists.

All three recommended concepts **demote the stage from interaction model to
addressing scheme**. The five stage routes remain canonical and every deep link
keeps working, but the thing a person actually manipulates becomes smaller and
enumerable — a gap row, an entry, an evidence row — so completeness is visible
on one screen instead of inferred across five. Secondary differences follow from
that: Overview stops being the only place that summarises, evidence stops being
a section inside Analyze (Evidence Table), and the Situation form stops being
the only way to write the record (Casebook).

### How the three differ from Investigation First

PR #1108 was not read, per instruction. The differentiation below is stated
against the position implied by the name — that the **investigation record
object** is the entry point and primary surface, with work flowing record →
sections → fields. Flagged as an open decision to re-verify at review time.

- **Ledger Desk inverts the object.** The primary object is the *absence*, not
  the record. The screen is a list of what has not been recorded; the record is
  the residue of closing those rows. A record-first design shows you what
  exists; this shows you what does not.
- **Casebook makes the record an output, not an input.** Nobody edits the record
  directly — they append dated entries and promote them, so every field carries
  a citation to the entry that produced it. A record-first design treats the
  record as the thing you fill in; this treats it as a derived, cited summary of
  work already written down.
- **Evidence Table displaces the record entirely from the default view.** The
  landing surface for an open investigation is the evidence inventory;
  conclusions, snapshots and lanes are readings of a selection over it. A
  record-first design puts prose first and evidence in a section; this reverses
  the containment.

Each of the three therefore differs from a record-first proposal on a *different
axis* — absence-first, derivation-first, corpus-first — which is what makes them
worth running against it rather than against each other.

---

## Fable-ready visual-design briefs (recommended three)

### Brief A — Ledger Desk

- **Frames.** Desktop 1440×1024 and mobile 390×844. One investigation, mid-flow:
  9 of 14 recorded, one row expanded for editing, one row in a `Needs a person`
  state, one Not recorded row collapsed.
- **Type.** IBM Plex Sans. Row label 15/20 semibold; row value 14/22 regular;
  state word 11/14 uppercase, 0.06em tracking; page title 22/28.
- **Colour.** Tokens only: `--bg`, `--surface`, `--fg`, `--muted`, `--border`,
  `--accent`, `--success`, `--warning`. Colour is always redundant to a word.
  Render the frame in the `light` and `dark` themes side by side.
- **Space.** 8px base. Row padding 14/16. Ledger max-width 780px. Right rail
  300px, dropping below content at 680px.
- **Components.** Identity strip; ledger row in four states (recorded, not
  recorded, needs a person, editing); inline editor with combo-box + datalist;
  Technical details disclosure; right-rail activity list; lifecycle card
  carrying archive-is-not-deletion copy.
- **Motion.** Row expansion 120ms height ease-out; nothing under reduced motion.
- **Do not.** No cards, no shadows, no progress bar or ring for the count (it is
  a count, not a score), no colour-only state, no icon without a label.

### Brief B — Casebook

- **Frames.** Desktop 1440×1024 (two columns) and mobile 390×844
  (record-then-stream). Six entries across four kinds spanning two days,
  including one unverified imported run, and a right column with two recorded
  fields and four Not recorded.
- **Type.** IBM Plex Sans. Entry body 16/25 at ~68ch; entry meta line 12/16 in
  `--muted`; day separator 12/16 uppercase; record field label 12/16 uppercase,
  value 15/22.
- **Colour.** Tokens only. The right column sits one step quieter than the
  stream (`--surface` on `--bg`, no border emphasis). The unverified banner uses
  `--warning` behind the word "Unverified", never as the only signal.
- **Space.** 8px base. Stream column 62%, record column 38%, gutter 32px.
  Timestamps in a 72px left gutter. Single column below 900px.
- **Components.** Composer with kind radiogroup; entry article in five kinds;
  imported-run entry with corroborate/contradict; the inline "Use as {field}?"
  promote affordance; promote dialog with a field select; record field showing
  value plus "from entry #n"; a superseded field showing the prior value.
- **Motion.** New entry fades in over 100ms only; no reorder animation.
- **Do not.** No chat bubbles, no avatars, no unread badges, no infinite-scroll
  jump — this is a logbook, not a messaging app. Promote is never a drag.

### Brief C — Evidence Table

- **Frames.** Desktop 1440×1024 and mobile 390×844. Fourteen rows visible,
  four selected, one `Unreachable`, one `Unverified`, the tray holding "4
  selected · 1 unreachable · 2 not shown by this filter", plus the freeze
  confirmation panel as a second frame.
- **Type.** IBM Plex Sans for labels; IBM Plex Mono for filenames, sizes,
  hashes and fingerprints. Header 12/16 uppercase; row 13/18; tray 14/20
  semibold.
- **Colour.** Tokens only. Verification words carry a redundant 8px glyph:
  Verified `--success`, Unverified `--muted`, Unreachable `--danger`. Selected
  rows use `--accent-soft` fill *plus* a 2px `--accent` left rule. Render a
  forced-colors variant as a third frame.
- **Space.** 8px base. Row height 36px, header 32px, tray 56px pinned to the
  bottom over `--surface-deep`. Columns: checkbox 40, name flex, kind 96,
  recorded 132, size 88, verification 120.
- **Components.** Filter bar stating the active filter in words; sortable header
  button with sort indicator; row in default / hover / selected / unreachable;
  detail drawer with excerpt, metadata list and annotation field; the tray with
  its hidden-selection warning; the freeze confirmation restating the full list
  and the immutability sentence; a frozen snapshot chip with fingerprint and
  fairness class.
- **Motion.** None on rows. Tray slides up 120ms on first selection only.
- **Do not.** No zebra striping (it fights selection), no colour-only
  verification, no truncated filename without a title, no bulk action that is
  not restated before it commits.

---

## Verdict

**READY.**

Five concepts are specified to prototyping depth, all constrained by the data,
capability, audit and integrity boundaries as they exist at
`02e66ddf755165be45092fabafd96b3153a5628f`. Three are recommended with an
explicit rationale for excluding the other two, and each recommended concept has
a Fable-ready brief. The items below are decisions, not blockers; none of them
prevents building the three prototype slices.

### Open decisions

1. **Investigation First differentiation is unverified.** PR #1108 was not read,
   per instruction. The differentiation above is stated against the position
   implied by the name and must be re-checked against the actual proposal before
   the bakeoff is scored.
2. **"Shared strategy registry" semantics.** Read here as a registry of
   selectable UI strategies with URL round-trip equivalence as the conformance
   rule. If it instead means the analysis strategy host catalog, every
   compatibility section needs rewriting.
3. **Does a coverage count assert priority?** "9 of 14 recorded" is enumerable
   fact, not inference, but it sits close to a boundary the product deliberately
   refuses. Needs an explicit ruling; it gates Ledger Desk's central affordance.
4. **Casebook write paths.** Entry-promotion only, or direct field editing as
   well? Two write paths into one field will diverge. Recommend promotion-only
   for the prototype so the question gets answered by use.
5. **May a working set be URL-encoded?** Recommend no for the Evidence Table
   tray, following the `navigation: "preserve"` precedent — but it sets a
   registry-wide precedent for every strategy's transient state.
6. **Mobile intent.** Is there a real mobile writing use, or is mobile a
   read-only courtesy? Evidence Table's viability turns entirely on this answer.
7. **Where do evidence annotations live?** Today the nearest durable primitives
   are a `note` contribution and a workbench bookmark `note`. Does an annotation
   get its own contract, or is it a note contribution linked to an artifact?
   This affects all three recommended concepts and should be settled before the
   Evidence Table slice.
8. **Bakeoff scoring.** No rubric or novice-tester roster is defined. Three
   prototypes with no agreed scoring will be judged on polish.
