---
id: investigation-reports
title: Investigation reports
summary: Assemble a versioned report from accepted investigation material, review agent-proposed sections explicitly, and export deterministic Markdown through the host-owned native save dialog.
section: log-analysis
tags:
  - logs
  - investigation
  - reports
  - evidence
  - process
  - troubleshooting
order: 25
related:
  - log-explorer
  - log-analysis-pipeline
---

# Investigation reports

An investigation report is a **versioned projection** of the durable
investigation record: accepted evidence identities, findings, notes, and
human-controlled report sections. It is assembled fresh from that accepted
state each time — it is not an editable blob, and assembling or previewing it
never changes the investigation, the Explorer view, or the corpus.

![Accepted investigation material is assembled into a versioned projection, rendered as deterministic Markdown with verified, stale, and missing markers, and exported only through a host-confirmed native save panel; agent-proposed sections pass explicit human review first](../assets/investigation-report-flow.svg)

## What a report is

- **Accepted state only.** The report selects durable findings, cited notes,
  and explicitly authored or accepted report sections. Open and dismissed
  proposals never appear anywhere in it.
- **Versioned.** Every report records its own report schema version, the
  investigation revision it was assembled from, and the assembly time, so a
  hand-off can be traced back to exact durable state.
- **Payload-free.** The report carries exact event identities — sequence,
  relative source, and time-quality hints — plus redacted human text. It never
  copies log message payloads into prose.
- **Deterministic.** Rendering is a pure function of the accepted state, the
  current noise policy, and the assembly time. The bytes you preview are the
  bytes Export writes — the host retains the exact rendered artifact when it
  assembles the preview, and saving writes that retained copy.

## Report sections

Sections render in a fixed order. Derived sections are computed from durable
items; authored sections are human-controlled text with citations.

| Section                  | Origin   | Notes                                                                                                    |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------- |
| Incident scope & window  | Derived  | Corpora, item counts, and an honest evidence time window; mixed time quality is labeled, never hidden     |
| Executive summary        | Authored | At most one; bounded redacted body with citations to saved evidence, findings, and notes                  |
| Accepted findings        | Derived  | Observations and inferences with lifecycle, noise-policy binding status, saved-view flag, and citations   |
| Evidence-backed timeline | Derived  | Identity-only entries in deterministic order, bounded with an explicit omitted count                      |
| Hypotheses & alternatives| Derived  | Hypothesis-kind findings, kept separate from accepted observations and inferences                         |
| Unresolved questions     | Authored | At most one; same bounds and citation rules as the executive summary                                      |
| Next actions             | Authored | At most one; same bounds and citation rules as the executive summary                                      |

A section you have not written renders an explicit *Not authored.* marker
instead of being silently omitted, so a hand-off never hides that a summary
was skipped.

## Open the report

Use the **Report** mode of the Investigation rail in Log Explorer, or the
**Investigations** pane in the main window, to see the host-assembled preview
next to the durable evidence, findings, and notes. The preview is explicitly
non-mutating: generating it changes nothing in the Explorer or the
investigation record.

Authored sections (executive summary, unresolved questions, next actions) are
edited through a normal dialog. Text is redacted and bounded before it
persists, and citations must reference evidence, findings, or notes already
saved in the same investigation — a report section cannot invent evidence.
Saving checks the expected investigation revision; if another window changed
the investigation first, the save fails visibly instead of overwriting.

## Proposed sections and review

In a linked, tools-enabled chat the agent can propose a report section with
the SoftWrite `propose_report_section` tool. A proposal:

- enters a durable review queue as **proposed** — it never becomes report
  content by itself and never appears in the assembled report;
- records host-authored provenance (source, provider, model) that the model
  cannot spoof;
- may cite only already-saved evidence, findings, and notes from the same
  investigation; wrong-corpus and unknown citations fail closed; and
- is retry-safe: repeating an identical proposal returns the existing item
  instead of creating duplicates.

Review each proposal explicitly: **Accept**, **Edit and accept** (whether the
acceptance counts as an edit is derived from the accepted text actually
differing — never self-declared), or **Dismiss** with a required reason.
Accepting a newer proposal for the same section kind, or manually rewriting
the section, marks the earlier accepted proposal **superseded** with its
history intact — a proposal can never keep claiming authorship of content it
no longer wrote. Accepting creates
or replaces the authored section for that kind while keeping the proposal —
including its original body and provenance — as inspectable history. Every
review action is pinned to the expected investigation revision and fails
closed if the record moved underneath it.

An accepted section stays human-controlled, but its agent origin is not
erased: the report surface and standalone Markdown name the accepted proposal,
its privacy-safe source/provider/model or detector provenance, whether the
human edited it during acceptance, and the acceptance time.

> Note: profiles without tool support, and read-only linked contexts, do not
> offer the propose tool. The unavailable capability is named rather than
> silently hidden.

## Evidence honesty

Assembly re-resolves every cited evidence reference against the authoritative
corpus and marks each one `[verified]`, `[stale]`, or `[missing]` in the
rendered report. Stale and missing references stay visible instead of being
dropped, so a reader knows exactly which citations no longer resolve. The
scope section labels a mixed-quality time window honestly rather than
presenting order-only hints as calendar time, a timeline that mixes
wall-clock and order-only references says its cross-quality order comes from
stored hints rather than established time, and each finding shows the
noise-policy binding it was made under. The report's current-policy header is
the exact snapshot **and active-or-suspended noise lens** the finding statuses
were resolved against — one read, never two that could disagree. A core caller
that did not select a lens is labeled `unknown`; desktop report assembly always
selects and displays the actual lens.

## Export

Export produces Markdown only, and the trusted host owns the whole path:

1. The host retains the exact bytes it rendered when it assembled the
   preview — there is no second render that could drift from what you
   reviewed, and the retained copy has already passed through secret
   scrubbing.
2. Saving goes through the host-owned native save panel. The renderer cannot
   author export text, choose a destination, or claim overwrite approval.
3. Publication is atomic and never clobbers an existing file; a bounded report
   size is enforced, and a final scrub re-check fails closed rather than
   writing questionable bytes. A render that cannot pass that boundary still
   previews — Export is simply off, with the exact reason shown.

Review the preview before sharing. The export contains exact source
identities and redacted human text; treat it under the same data policy as
any other artifact that leaves the machine.

## Limits

Report support is a deliberate first slice. Not shipped: the fuller section
vocabulary from the report design (impact, causal timeline, primary cause,
contributing factors, remediation, and similar kinds), reviewable report
patches with an undo trail, unsupported-claim detection, HTML/PDF export, an
evidence appendix with payload excerpts, and multi-corpus report UI. The
durable investigation workflow itself is described in
[Log Explorer investigation workspace](help://log-explorer#investigation-evidence).
