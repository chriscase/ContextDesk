# ContextDesk War Room

War Room is ContextDesk's shared, evidence-first workspace for difficult
technical investigations. People use it to define the situation, capture what
was observed, run independent analysis strategies, compare their evidence,
discuss what remains uncertain, and record a human decision. The product keeps
the original logs, stack traces, observations, and provenance close to every
claim so a fluent explanation never has to stand in for inspectable support.

> Every screenshot, diagram, identifier, person, system, and log excerpt in
> these pages is fully synthetic.

![War Room workflow: Situation, Capture, Analyze, Compare, and Decide](../assets/war-room/war-room-flow.svg)

## What War Room is

War Room is one workspace that can contain many investigations owned by
different people. It is not one giant case page and it is not a model demo.
The signed-in workspace provides separate destinations for different jobs:

| Destination | What it is for |
| --- | --- |
| **Overview** | See recent recorded activity and active investigations, then follow a link to the relevant stage or item |
| **Investigations** | Search, filter, create, and resume investigations visible to the signed-in person |
| **Entities** | Keep reusable labels for the customer, organization, person, service, system, product, version, build, or environment an investigation concerns |
| **Sources** | Manage reusable attribution labels for people, tools, systems, and imported material; a source is not a credential or a global evidence store |
| **Administration** | For administrators, search a bounded view of configured directory identities and groups and maintain explicit group-to-role mappings |
| **Help** | Search operating guidance while working in War Room |

Opening an investigation reveals five stage routes—**Situation**, **Capture**,
**Analyze**, **Compare**, and **Decide**—with breadcrumbs and shareable URLs.
The stage route can be sent to another authorized user. More specific links
can preserve the selected comparison, lane, section, or evidence item so the
recipient lands near the recorded context rather than at the investigation
inventory.

![Synthetic War Room investigation list](../assets/war-room/war-room-investigations.png)

## The evidence-first mental model

War Room moves a problem through a reviewable chain:

**Situation** → **investigation evidence** → **independent attempts** →
**agreement, disagreement, and unknowns** → **human next action** →
**review or transfer artifact**

A useful finding answers four questions:

1. What does the lane claim?
2. Which recognizable log line, stack frame, file, or observation supports it?
3. What remains observed, inferred, contradicted, or unknown?
4. What should a person do next?

Internal identifiers still exist for integrity and audit. The normal view uses
readable labels and excerpts; exact identifiers and lower-level metadata live
under **Technical details** when a reviewer needs them.

## Overview is the command center

**Overview** answers “what changed, and where should I look next?” It shows
bounded status counts, recent activity visible to the signed-in identity, and
active investigations. Activity rows include the actor's display identity,
recorded action, investigation, and server time. Their links open the relevant
investigation stage and recorded item.

The feed is an orientation aid, not a complete audit log, urgency score, or
inferred priority ranking. **Investigations** remains the full searchable
inventory.

![Synthetic War Room Overview with recent activity](../media/gallery/war-room-overview.png)

## The five investigation stages

| Stage | Operator question | Durable output |
| --- | --- | --- |
| **Situation** | What problem are we trying to understand? | Title, problem statement, affected people or systems, impact, bounded scope, and explicit open questions; blank fields remain **Not recorded** |
| **Capture** | What did people observe, and what outside analysis was brought in? | Human-authored notes, hypotheses, actions, and clearly labeled imported output |
| **Analyze** | What evidence is available, and what did each strategy try? | Investigation-scoped logs, stack traces, files, frozen evidence snapshots, lane runs, and run history |
| **Compare** | Where do the attempts align or diverge? | Readable findings, cited evidence, agreement, disagreement, unsupported claims, unknowns, and lane traces |
| **Decide** | What happens next, and is a responsible person assigned? | A human-selected action, optional owner, rationale, discussion context, and export tools |

The path is deliberately iterative. A comparison may reveal a missing log
interval and send the team back to Capture or Analyze. A rerun produces a new
recorded attempt rather than replacing the earlier result. “Gather more
evidence” can be the correct human decision.

## Choose the path that matches your work

You do not need to run every stage for every question:

| Your goal | Recommended path |
| --- | --- |
| Record and resolve one straightforward issue | Situation → Capture → Analyze → Decide |
| Ask one focused question about known evidence | Analyze → freeze a snapshot → launch one lane → read the workstream → Decide |
| Compare independent approaches | Analyze → freeze a snapshot → launch two or more lanes → Compare → Decide |
| Understand a large or messy log bundle | Capture → Analyze → Log workbench → Timezone review (if needed) → Normalized log chronology → Decide |
| Revisit earlier work | Investigations → open the case → Historical artifacts, activity, or a saved view |
| Hand work to another authorized person | Compare or Decide → follow a deep link or export the appropriate artifact |

One focused gateway triage needs only one lane. Two or more lanes are for a
comparison; lane count is not a correctness score.

## Log Workbench: the power-user reading path

The **Log workbench** lives on an investigation's **Analyze** stage. It lets an
operator work directly with investigation-owned logs without putting those
logs into the reusable **Sources** catalog.

- Filter a long file list by name or path and select up to four files for
  side-by-side reading.
- Search selected files with match mode, include/exclude terms, severity, and
  explicit UTC bounds. Previous/Next, F3, and Ctrl/Cmd+G navigate matches.
- Continue a search page from its opaque position when the selected corpus is
  larger than one bounded request. A partial page identifies itself rather than
  presenting a partial count as complete.
- Save a view and bookmark a line for later work. These records stay tied to
  the investigation and are not permission tokens.
- Use **Timezone review** to choose an IANA timezone for local timestamps that
  have no offset, then use **Normalized log chronology** for one merged order.
  The workbench never guesses a timezone, year, daylight-saving choice, or
  clock correction.

The workbench is additive to the normal evidence board: Capture owns intake,
the snapshot owns the exact material a triage may read, and the workbench helps
people inspect that material before they decide what to ask.

These synthetic captures show the same investigation at the most useful
handoffs:

![Synthetic Capture stage with human notes, imported output, and investigation-scoped file intake](../media/gallery/war-room-capture-analyze.png)

![Synthetic Analyze stage with evidence board, frozen snapshot lineage, and model lanes](../media/gallery/war-room-analyze.png)

![Synthetic Compare stage with historical artifacts, deep links, and lane focus](../media/gallery/war-room-compare-decide.png)

![Synthetic Decide stage with an accepted human decision and export boundary](../media/gallery/war-room-export.png)

## Entities and Sources answer different questions

**Entities** answer “who or what is this investigation about?” Use them for
customers, organizations, products, versions, builds, components, services,
systems, people, or environments so related investigations can be found again.

**Sources** answer “who or what supplied this information?” They contain
reusable attribution labels for a person, monitoring system, external tool,
another ContextDesk record, or unknown origin.

Neither area stores logs, email, chat, notes, or uploaded files. Evidence stays
owned by the investigation that captured it. A customer or vendor may be both
an Entity and a Source, but the two labels should not be substituted for one
another.

## Sources are labels; evidence belongs to an investigation

The **Sources** library answers “who or what produced this item?” It contains
reusable attribution records such as a named person, monitoring system,
external tool, or unknown source. Registering a source does not connect to the
system, store its credentials, prove its correctness, or make its content
available to every investigation.

The actual note, upload, log excerpt, stack trace, imported answer, or frozen
snapshot belongs to an investigation. Retiring a source removes it from new
intake choices while preserving historical attribution.

## Read evidence before conclusions

Findings show a readable source label and the available log, stack trace, or
observation excerpt. Long technical material can remain compact until a person
opens the surrounding context. Evidence deep links retain the investigation,
stage, and target item. **Technical details** reveal exact identities, hashes,
timestamps, provenance, and lane configuration without forcing those fields
into the primary narrative.

Use the evidence link before accepting the prose:

1. Read the cited line or frame in its recorded context.
2. Confirm whether the item is synthetic, live, or imported.
3. Check whether the lane observed a fact or inferred an explanation.
4. Compare contradicting evidence and other lane interpretations.
5. Leave unsupported gaps as unknowns.

## Lanes are attempts, not votes

A lane is one candidate attempt within a job's bounded strategy and question,
applied to one frozen evidence snapshot. A separate strategy or question—such
as timeline reconstruction, failure-boundary testing, or challenge review—uses
a separate job. The Compare stage can focus one lane while keeping every lane
visible in the aggregate decision basis. Its compact digest shows that
attempt's question, evidence, conclusion, unknowns, and recorded trace.
Historical runs and comparisons remain separate artifacts.

On a configured gateway, each selected lane chooses its own **Gateway model**.
The current integrated catalog can expose Qwen 3.6 27B, GPT-OSS 120B, and
Ministral 3 14B when those models are configured on the host. Provider
credentials and endpoints remain on the host; the browser receives a bounded
catalog identity. Model availability depends on deployment configuration.

Agreement is not proof of correctness. A majority is not a decision. The
human reviewer judges the evidence and records the decision; assignment may
remain explicitly unassigned when no responsible person is known.

## Collaboration and identity

Discussion and activity are durable server records attributed to the signed-in
identity. The account menu uses the configured directory display name when
available and keeps the username and current ContextDesk access role visible.
LDAP-backed display identity requires a configured and qualified LDAP
deployment; the synthetic demo uses a fixture account.

Discussion refreshes through bounded HTTP polling. It is not a WebSocket chat
channel and does not claim instant delivery, typing indicators, live cursors,
or an authoritative viewer roster. Important decisions still belong in
**Decide**, not only in discussion.

## Administration

The admin-only **Administration** destination provides:

- a bounded, audited search of directory group and identity references;
- persistent mappings from an exact directory group to one ContextDesk role;
- Viewer, Contributor, Case lead, and Administrator role descriptions; and
- explicit update and revoke controls, including confirmation for sensitive
  changes.

Search does not create or modify directory users or groups. A search result
does not grant access. Only an explicit destination group-to-role mapping can
grant a workspace role, and source-system roles from an imported archive are
never trusted.

![Synthetic Administration console with explicit group-to-role mappings](../assets/war-room/war-room-administration.png)

## Three different exports

War Room exposes three artifacts with deliberately different scope:

| Artifact | Purpose | Important boundary |
| --- | --- | --- |
| **Triage brief** | Readable case handoff with timeline, hypotheses, actions, and an evidence inventory | A projection of the current record, not a restorable backup |
| **Selected-evidence prompt package** | Send only explicitly selected evidence and an optional prompt scaffold to another analysis tool | Not a full investigation; unselected and default-excluded items stay out |
| **Portable investigation archive** | Preserve or transfer the supported investigation record and included evidence in a portable JSON archive | Export, dry-run preflight, and supported-field exact restore are available; signatures are not verified |

The portable archive includes the durable Situation and supported represented
investigation objects, content inventory, provenance, integrity information,
and historical attribution needed for a destination preflight. A case lead or
administrator can download it, select an archive on a destination War Room,
and run a dry-run check. The preflight validates integrity and references,
summarizes privacy and omitted content, plans deterministic identifier remaps,
and keeps historical people as attribution only.

The dry run creates no investigation, user, membership, role, or capability.
An exact reconstruction can then be restored after typing RESTORE. Historical
people remain attribution only. Archive signatures are recorded, not verified.

![Synthetic portable investigation archive export and restore workspace](../media/gallery/war-room-export.png)

![Portable investigation archive trust boundary](../assets/war-room/war-room-portable-archive.svg)

## Bounded first-run setup

An unconfigured host can expose a pre-authentication setup checklist for
claiming the installation, describing storage and sign-in, and optionally
describing a model gateway. Protected values are exchanged for host-owned
references and are not returned by setup APIs. The current wizard prepares and
checks a bounded draft; it does not claim atomic installation, external
connectivity proof, restart, or completion.

![Synthetic bounded first-run setup checklist](../assets/war-room/war-room-first-run-setup.png)

## Five-minute synthetic start

From the repository's `collab` directory, start the fully synthetic demo:

```bash
cd collab
npm run demo
```

Open the local address printed by the command and sign in with:

```text
Username: demo
Password: demo
```

No live provider or external material is required. Continue with the
[five-minute end-to-end walkthrough](END_TO_END.md).

## Shipped boundaries and honest limits

“Integrated” does not mean every deployment is automatically configured.

| Area | Current integrated behavior | Residual or non-claim |
| --- | --- | --- |
| Navigation | Multi-page Overview, Investigations, Sources, Administration, and Help; five routed investigation stages; breadcrumbs and deep links | Authorization still applies when another person follows a link |
| Evidence | Investigation-scoped notes, imports, uploads, ZIP/directory intake, snapshots, readable excerpts, context links, and Technical details | A citation or polished summary is not proof; intake limits and privacy classification still apply |
| Analysis | Synthetic/offline and configured-gateway runs, one-lane focused triage, multi-lane comparison, run history, gateway model selection, and the Log workbench | Model availability and quality depend on the deployment; unknown cost or usage remains unknown |
| Comparison and decision | Lane focus, evidence-backed differences, unknowns, discussion, human action, and optional owner | Agreement is not proof and a model cannot approve the human decision |
| Discussion | Durable records refreshed through polling | No WebSocket chat, typing indicators, instant delivery, or authoritative presence |
| Identity and administration | LDAP-capable sign-in adapter, directory display identity, bounded directory visibility, persistent group-to-role mappings | LDAP must be configured and qualified per deployment; the console does not administer the directory itself |
| Portable archive | Supported-record download, fail-closed dry-run preflight, staged evidence, actor-scoped replay, and exact restore with deterministic ID remapping and historical identity isolation | No Ed25519 verification; metadata-only archives cannot be applied; source membership, audit references, discussions, alignments, and opaque imported-run state are not portable; memory/SQLite require one server instance |
| Setup | A first-run wizard appears before sign-in when the host exposes an unconfigured setup service; it claims one owner, stages SQLite/local or PostgreSQL/LDAP configuration and optional gateway references, and runs bounded checks | It does not yet atomically commit configuration, prove external connectivity, restart the service, or complete installation |

## Continue reading

- [Operator guide](OPERATOR_GUIDE.md) — run an investigation, administer
  access, and choose the correct export without losing provenance.
- [End-to-end walkthrough](END_TO_END.md) — a five-minute, fully synthetic
  tour of the integrated workflow.
- [War Room workflow Help](../help/war-room/war-room-workflow.md) — searchable
  Capture, Analyze, Compare, and Decide guidance.
- [Evidence and model-lane Help](../help/war-room/war-room-evidence-review.md) —
  manual intake, provenance, comparison, and human decision boundaries.
- [Deployment and handoff Help](../help/war-room/war-room-deployment.md) — local
  and shared browser-service shapes plus desktop and CLI roles.
- [Final-source product gallery](../media/gallery/) — existing reviewed product
  captures and the destination for manager-captured War Room evidence after
  exact-build provenance and publication review.
