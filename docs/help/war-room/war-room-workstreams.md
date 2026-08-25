---
id: war-room-workstreams
title: Read and share a War Room workstream
summary: Open one investigative workstream, read its purpose, owner, evidence, history, and unknowns, and share the exact address with another engineer.
section: war-room
tags:
  - war-room
  - workstream
  - investigation
  - evidence
  - collaboration
order: 15
related:
  - war-room-workflow
  - war-room-evidence-review
  - war-room-deployment
---

# Read and share a War Room workstream

A **workstream** is one line of investigation against a frozen set of evidence.
It records what it was asked, who requested it, how it was performed, what it
reported, which evidence it cited, what it left unknown, and what happened in
what order. The Analyze stage lists the workstreams recorded on an
investigation; opening one shows that workstream's own record.

A workstream is a unit of investigative work, not a model button. The recorded
shape can describe a person working a question directly, a scripted
investigation path, work performed elsewhere and imported, or a host-run
diagnostic, as well as the AI-assisted lanes the shipped runner executes.

## Open a workstream

In **Analyze**, each recorded workstream is listed under the strategy and
question it belongs to, with the frozen evidence set it was given and who
requested it. Selecting one opens its record; the evidence board and the run
launcher step aside so the workstream is the page.

The address bar always holds the exact workstream, so reload, browser Back and
Forward, and a copied link all return to the same record. A link that names a
workstream this investigation does not have says so and offers the list —
it never opens something else instead.

## What the record shows

| Section | What it answers |
| --- | --- |
| Asked to find out | The exact question the workstream was given |
| Performed by | Whether the work was AI-assisted, human, programmatic, imported, or host-run |
| Requested by | The authenticated person who started the run |
| Evidence it was given | The frozen evidence set, its item count, and when it was frozen |
| Same-evidence proof | Whether the host proved this ran against that exact frozen set |
| What it reported | The recorded finding, or an explicit statement that none was recorded |
| Evidence it cited | Each cited item by filename, with its recorded summary and an excerpt |
| What it left unknown | Recorded unknowns, phrased as words rather than field names |
| What happened, in order | Timestamped steps with the person or host that performed them |
| Reruns | Whether this reran an earlier workstream, with a link when it is in view |

An empty unknown list does not mean nothing is unknown; it means nothing was
recorded as unknown. Agreement between workstreams is not proof of correctness,
and AI-assisted output is analysis, never a human finding.

## Read the cited evidence

Cited evidence is shown by filename with its recorded summary, whether it is
inside the frozen evidence set, and its recorded integrity state. A long log or
stack trace shows a bounded preview with the complete text one keyboard-
reachable disclosure away, labelled with its real line and character count so a
truncated view is never mistaken for the whole record. A copy control puts the
complete text on the clipboard; if the browser blocks the clipboard, the page
says so rather than reporting a copy that did not happen.

A citation that no longer resolves to registered evidence is marked as such.
ContextDesk does not reconstruct a record from an identifier.

## Identifiers

Run, lane, snapshot, request, and task identifiers, fingerprints, hashes,
gateway connection identity, and privacy class live under **Technical details**
on the workstream record. They are collapsed so the record stays readable, not
withheld — machine exports carry them unchanged.

For the surrounding stages, open help://war-room-workflow. For provenance and
comparison checks, open help://war-room-evidence-review.
