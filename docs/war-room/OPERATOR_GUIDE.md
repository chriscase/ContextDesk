# War Room operator guide

This guide explains how to operate ContextDesk War Room as an evidence review
and collaboration system, not as a model-answer generator. Keep the problem
bounded, preserve recognizable source material, compare independent attempts
fairly, and record the human action that follows.

> Every example and screenshot referenced here is fully synthetic.

## What you can do in War Room

War Room keeps one investigation's context, evidence, analysis attempts, review,
and human decision together. Use the feature that matches the question you are
trying to answer:

| If you want to… | Start here | What it gives you |
| --- | --- | --- |
| Understand a new problem | **Situation** | A bounded problem statement, affected people or systems, impact, and open questions |
| Add logs, files, notes, email, or chat | **Capture** | Investigation-owned evidence with provenance and an intake preview |
| Read several logs together | **Analyze → Log workbench** | Side-by-side files, bounded search, match navigation, saved views, bookmarks, and chronology tools |
| Ask one focused question | **Analyze → Run history and launcher** | One recorded triage against one frozen evidence snapshot; one gateway lane is enough |
| Compare approaches | **Compare** | Evidence-backed agreement, disagreement, unsupported claims, and unknowns across two or more lanes or runs |
| Talk through uncertainty | **Discussion** | Durable review notes and questions, refreshed by polling |
| Record what happens next | **Decide** | A human-owned action, rationale, owner, and revision history |
| Find related cases | **Investigations** and **Entities** | Searchable investigations and reusable labels for customers, organizations, services, systems, or people |
| Preserve or share work | **Decide → Export** | A readable brief, a deliberately selected evidence package, or a portable archive |

The shortest useful path is: **Situation → Capture → Analyze → Decide**. Add
**Compare** when you need independent approaches side by side. Return to
Capture or Analyze whenever the evidence shows that the question is still too
uncertain. “Gather more evidence” is a valid outcome.

## Start with the workspace, not a giant case page

After sign-in, the primary navigation separates the major jobs:

- **Overview** surfaces recent recorded activity and active investigations.
- **Investigations** is the searchable and filterable case inventory.
- **Operations** is the read-only, server-ordered coordination queue. Its All
  visible, Mine, and Unassigned counts are recorded server projections, not
  priority or workload measures; changes still happen inside an investigation.
- **Entities** stores reusable labels for who or what an investigation concerns.
- **Attribution** maintains source labels reused during intake.
- **Administration** is visible only to administrators and manages destination
  workspace access mappings.
- **Help** provides searchable operating guidance.

Select an activity link when you know what changed. Open **Investigations**
when you need to search or resume any visible case. The URL preserves the
investigation and stage, and more specific links can preserve a comparison,
focused lane, section, or evidence target. A recipient must still sign in and
have permission to read that investigation.

![Synthetic investigation list with War Room entries](../assets/war-room/war-room-investigations.png)

## Identity and attribution

The account menu shows the signed-in display name, username, and current
ContextDesk access role. In a configured LDAP deployment, the display name can
come from the directory identity. In the synthetic demo it comes from the
fixture account.

Display identity supports understandable attribution; it does not replace the
durable internal identity used for authorization and audit. Never infer a
person's role from their name or from historical data imported from another
installation.

## The investigation workflow

### 1. Situation: define the problem boundary

Start with a question that can be improved by evidence. “Something failed” is
too broad, while a presumed cause narrows the investigation prematurely.
Record:

- a concise title;
- a problem statement describing the observed symptom without assuming a
  cause;
- affected people, customers, services, or systems, when known;
- the current recorded impact;
- a bounded scope, including relevant time and system boundaries; and
- explicit open questions.

Authorized investigation members can edit these durable fields later. A blank
field appears as **Not recorded**; ContextDesk does not infer or backfill it
from model output.

![Synthetic Situation view with bounded problem context](../assets/war-room/war-room-situation.png)

Separate observations from hypotheses. “The synthetic request returned a
timeout” is an observation only if captured evidence shows it. “A downstream
service caused the timeout” remains a hypothesis until evidence supports it.

### 2. Capture: distinguish people from imported output

Capture human-authored notes, hypotheses, and actions as human contributions.
Record pasted output from an external model, tool, report, or service as
imported and unverified. Do not place copied model output in a human note simply
because a person pasted it.

Discussion is for questions and review context. It does not replace a formal
finding or decision.

### 3. Analyze: select evidence, freeze a snapshot, run attempts

Use **Capture → Logs and files** for bulk files, ZIP archives, and directories.
Use the **Analyze → Evidence** board for a single-file upload or for selecting
already captured evidence. Inspect the material before freezing it. A frozen snapshot
binds a run to an exact evidence selection and fingerprint so later comparisons
can report whether lanes saw equivalent material.

Give each lane a distinct purpose rather than only changing wording:

| Strategy | Question | Useful output | Failure to watch for |
| --- | --- | --- | --- |
| Timeline | What happened in what order? | Ordered events with direct citations | Invented ordering where timestamps are missing |
| Boundary | Where does observed success become failure? | Last supported success and first supported failure | Naming a cause that the boundary does not prove |
| Skeptic | Which leading claim is weakest? | Contradicting evidence and missing tests | Unsupported disagreement for its own sake |

Synthetic mode runs offline. When the host has a configured gateway, switch to
**Configured gateway**, select the frozen snapshot and question, and choose a
**Gateway model** for each lane. A focused question can use one lane. Choose
two or more lanes when you want a comparison. The integrated catalog can
expose Qwen 3.6 27B, GPT-OSS 120B, and Ministral 3 14B; a deployment may expose
a different bounded catalog. Endpoint and credential details remain on the
host.

Record failed, partial, and superseded attempts. Before rerunning, note what
changed: evidence, Situation, strategy, model, or configuration. If nothing
changed, variation between answers is itself relevant evidence.

#### Use the Log Workbench for large or messy logs

The Log workbench is the investigation's power-user reading surface. It is for
logs that have already been accepted on **Capture**; it is not a second global
Attribution catalog and it does not replace the evidence snapshot. Up to four
panes sit side by side when space permits and stack vertically at narrow widths.

1. On **Analyze**, filter the file list by name or path when the investigation
   contains many files.
2. Select up to four files to read side by side. Clear one selection before
   choosing another file.
3. Search with **Find**. Use match mode, include/exclude terms, severity, and a
   full UTC time range only when needed. **Previous match**, **Next match**, F3,
   and Ctrl/Cmd+G move through the currently loaded matches; navigation wraps,
   and the result counter shows your position.
4. Read the result as two separate facts: how many matches were found, and how
   much of the selected corpus has actually been searched. If the page is
   incomplete, continue from the supplied position; a zero-match page can
   still have more corpus to search.
5. Save a view when the same files, filters, sort, grouping, or panes will be
   useful again. Bookmark a line when it matters to the investigation. These
   are navigation aids, not access tokens or evidence copies.
6. For files with local timestamps and no offset, open **Timezone review** and
   explicitly choose the correct IANA timezone. Then open **Normalized log
   chronology** to read one merged order. War Room never guesses a timezone,
   year, daylight-saving choice, or clock correction.

Large corpora are processed in bounded windows. Search can return a continuation
cursor instead of pretending that a partial page is a complete answer. If the
selected files or their timezone revision changes, restart the search so it is
not resumed against different bytes or timestamps. The current local server
materializes one selected evidence file in memory before building line windows;
paging is not constant-memory proof for one extremely large file.

![Synthetic Analyze surface showing completed Workstreams and the beginning of the Log workbench](../media/gallery/war-room-analyze.png)

### 4. Compare: inspect findings, not votes

Compare organizes recorded output into:

- **Agreement** — compatible claims with inspectable support;
- **Disagreement** — competing interpretations or boundaries;
- **Unknowns** — questions the current evidence cannot answer; and
- **Unsupported claims** — assertions with missing, broken, or irrelevant
  evidence connections.

![Synthetic Compare view showing agreement, disagreement, and unknowns](../assets/war-room/war-room-compare.png)

Use the lane control to inspect one attempt without filtering other lanes out
of the aggregate decision basis. The focused digest shows its question,
recognizable evidence, latest conclusion, unknowns, and chronological trace.
The URL records that focus without sending the reader to an unrelated page.

![Synthetic focused lane with evidence-backed attempt history](../assets/war-room/war-room-lane-focus.png)

Use **Historical artifacts** to open earlier runs and comparisons. A historical
artifact is a recorded analysis object, not a recommendation or a replacement
for the current comparison.

Agreement can be useful, but it is not proof. Count of lanes is not a ranking.
Judge whether the claims are supported, whether the cited evidence is the same,
and whether an apparent contradiction changes the recommended action.

### 5. Decide: assign action and ownership

A complete decision records:

- the selected action;
- a named owner or explicitly unassigned status;
- evidence-backed rationale;
- remaining disagreement and unknowns;
- any completion or review condition; and
- the human actor who approved the decision.

“Capture the missing synthetic dependency interval” is a valid decision when
that evidence would distinguish the leading explanations. “Accept the majority
answer” is not a sufficient rationale.

## Evidence, sources, and deep links

### Entities describe what the investigation concerns

Use **Entities** for reusable labels such as a customer, organization, person,
service, system, product, version, build, component, or environment. An
entity helps people find related investigations; it does not contain the
investigation's logs and it is not a source of truth about a customer's system.

Use **Attribution** for a different question: who or what supplied a note, file,
log, imported answer, or other information. A vendor may appear in both areas,
but the two records have different meanings. Evidence, email, chat, and notes
remain inside the investigation that captured them.

### Source attribution is not evidence storage

The **Attribution** catalog stores reusable labels for who or what produced an
item: a person, an internal system, an external tool, another ContextDesk
record, or an unknown origin. The source record is not a connector, credential,
global corpus, or correctness claim.

Evidence is investigation-scoped. The actual note, imported response, upload,
log, stack trace, or frozen snapshot belongs to the investigation that records
it. A retired source remains attached to historical items but cannot be chosen
for new intake.

### Readable evidence first

The default finding view should let an operator recognize the evidence:

- a human-readable filename or source label;
- the relevant log line, stack frame, or observation excerpt;
- what the lane claims about it;
- why the distinction matters; and
- the recommended next review step.

Large logs and stack traces can remain collapsed until the operator needs their
surrounding context. Exact IDs, hashes, timestamps, provenance fields, lane
configuration, and diagnostic payloads belong under **Technical details**.
Those fields make an item auditable without forcing opaque values into every
summary.

### Follow deep links before trusting prose

A finding's evidence link opens the cited item in its investigation context.
Share the resulting URL when another authorized reviewer needs the same stage,
comparison, lane, section, or evidence item.

The synthetic image below shows the Analyze workstreams context reached during
this flow, not the cited evidence target itself. Verify the target in the live
workspace before treating the citation as resolved.

![Synthetic Analyze workstreams context reached from the evidence-review flow](../assets/war-room/war-room-evidence-deep-link.png)

If a deep link resolves to the wrong item, has insufficient context, or no
longer resolves, treat the citation as unverified. Do not rely on its prose.

### Evidence-first finding checklist

Before promoting a lane observation into a finding, answer:

1. What exactly is being claimed?
2. Which evidence supports or contradicts it?
3. Does the deep link resolve to recognizable context?
4. What is observed, and what is inferred?
5. Which attempt produced it?
6. What remains unknown?

If a claim is promising but unsupported, keep it as a hypothesis or next
action.

## Discussion and activity

Discussion records questions, review notes, and decision context. Activity
records important investigation changes and lets authorized users return to
the relevant stage or item. Both are durable server records attributed to the
signed-in identity.

Discussion refreshes through bounded HTTP polling. It is not WebSocket chat or
a presence system. Do not assume instant delivery, typing indicators, live
cursors, or an authoritative list of viewers. Write important comments so they
stand alone, verify that the durable update appears, and place the formal
action and owner in Decide.

## Administration, identity, and access

Only administrators can open **Administration**. The console has two distinct
responsibilities:

1. Search a bounded view of configured directory identities and groups.
2. Map an exact directory group to one ContextDesk workspace role.

The available roles are:

| Role | Workspace meaning |
| --- | --- |
| **Viewer** | Read investigations available to the identity |
| **Contributor** | Add notes, evidence, imports, and discussion |
| **Case lead** | Lead runs and decisions, export, and manage source labels |
| **Administrator** | Manage workspace group-to-role mappings in addition to case-lead capabilities |

Directory search is bounded, audited, and fail-closed. It does not display or
accept directory credentials, create users or groups, modify the directory, or
grant access by itself. Updates and revocations target the destination
ContextDesk mapping and require explicit action; sensitive changes use a
confirmation dialog.

LDAP support is deployment-specific. The adapter requires encrypted transport,
configuration, and qualification against the actual directory. The account
menu can show the LDAP display name and username after authentication, but the
War Room admin console is not a general LDAP administration tool. If a service
bind is configured, group membership is refreshed live for active sessions. If
the directory does not provide a service bind, the groups proven during login
are retained for that session and take effect again at the next login; the
application never stores or reuses the user’s password for this purpose.

![Synthetic Administration overview with navigation and component health](../assets/war-room/war-room-administration.png)

## Three different exports

Choose the artifact that matches the job. These are not interchangeable.

### Triage brief

Use the triage brief for a readable operational handoff. It can include case
header data, timeline, hypotheses, actions, evidence inventory, attribution,
and imported responses according to the selected owner-only or share-safe
variant. It is a projection, not a complete backup.

### Selected-evidence prompt package

Use this package to send a deliberate subset of evidence to another analysis
tool. Select at least one eligible item and optionally add a prompt scaffold.
The package includes a manifest, hashes, provenance labels, and only the
selected excerpts that pass its privacy rules. Default-excluded and unselected
items remain out.

This is not a complete investigation archive. It is intentionally narrower so
an operator can control what another analysis tool receives.

### Portable investigation archive

A case lead or administrator can download the portable JSON archive from
Decide. It represents the durable Situation and the investigation objects and
included evidence supported by the current archive version. It also carries
integrity data, privacy classifications, content inclusion state, historical
attribution, and explicit reconstruction limitations.

For investigation-scoped file, ZIP, and directory intake, an exact archive
preserves the accepted batch record, relative paths, source attribution, and
included evidence bytes. Restore remaps destination identities while keeping
those relationships intact, so the reconstructed evidence can be inspected or
processed again without pretending that historical users are local users.

On another War Room, select the archive and run **Run dry-run check**. The
preflight:

- validates the archive, hashes, and represented object references;
- inventories included, omitted, private, and redacted content;
- compares object identities with the destination catalog;
- computes deterministic remaps for collisions;
- treats source roles as untrusted; and
- keeps historical identities as attribution instead of creating destination
  users, members, leads, administrators, or capability holders.

The same archive and destination state produce the same remap plan. The dry
run changes nothing. It does not create an investigation, user, membership,
role, permission, or capability.

Source memberships, audit references, discussions, alignments, and opaque
imported-run details are not exported by the current server. If an incoming
archive represents unsupported apply state, the dry run blocks exact apply.

If the dry-run reports an **exact reconstruction**, a case lead or
administrator can type **RESTORE** to apply it. The server recomputes parse,
integrity, hashes, identity mapping, and the destination catalog and does not
trust the client preflight report. Apply uses a short-lived confirmation token
bound to the actor, archive transport hash, catalog digest, identity map, and
collision policy. Metadata and staged evidence bytes commit or roll back
together. Replay is scoped to the applying actor. Historical people remain
attribution only.

PostgreSQL coordinates apply transactionally across replicas and takes a
database-backed lease around filesystem evidence writes; apply fails closed if
that lease is unavailable. An interrupted database commit whose outcome cannot
be verified is reported as unconfirmed and should be retried for replay
resolution. Memory and SQLite modes support only one server instance; the
readiness screen reports that boundary and whether confirmation survives
restart.

Metadata-only, blocked, omitted, private, or redacted required content cannot
be applied. Archive signature metadata is recorded, not verified.

![Synthetic portable investigation archive workspace](../assets/war-room/war-room-portable-archive.png)

![Portable investigation archive trust boundary](../assets/war-room/war-room-portable-archive.svg)

## Provenance and honest unknowns

| Label | Meaning | Does not mean |
| --- | --- | --- |
| **Synthetic** | Generated material created for demonstration or testing | Proven on production data |
| **Live** | Produced through a connected run in the current workflow | Correct, complete, or human-verified |
| **Imported** | Added from outside the current run | Native, current, or human-authored |

Never infer missing provenance, time, model identity, cost, usage, or result
from wording. Preserve it as unknown and assign an action when resolving it
matters.

## Current deployment boundaries

- LDAP display identity and directory search require deployment-specific
  encrypted configuration and qualification.
- Discussion and activity use polling; realtime sockets, instant delivery,
  typing indicators, and authoritative presence are not shipped claims.
- Complete archive export, dry-run preflight, and exact-reconstruction restore
  are available. Archive signatures are not verified. Metadata-only archives
  cannot be applied.
- The selected-evidence prompt package is not a full investigation backup.
- Investigation-scoped files, ZIPs, and browser directories can be previewed
  and committed under the documented intake limits; accepted files become
  ordinary evidence on that investigation.
- The first-run web setup wizard is a bounded preparation surface: it can
  claim the installation, stage SQLite/local or PostgreSQL/LDAP settings,
  exchange protected values for host-owned handles, and run structural checks.
  It does not commit configuration, prove external connectivity, restart the
  service, or claim installation completion.
- Configured gateway model availability, quality, cost, and usage reporting
  depend on the host and provider. Missing measurements remain unknown.

![Synthetic bounded first-run setup checklist](../assets/war-room/war-room-first-run-setup.png)

## When something is unclear or does not work

| What you see | What it usually means | What to do |
| --- | --- | --- |
| You cannot see Gateway mode | This host has not exposed a configured runner to this session | Continue with Synthetic / offline, or ask an administrator to configure and qualify the host |
| A gateway run is waiting | The host has not finished the request; selection is not proof that a provider was reached | Read the queued/running counts, wait for the host deadline, or cancel; do not start the identical run again while it is in flight |
| A search says it is incomplete | Only a bounded page of the selected corpus has been searched | Continue from the supplied position; do not treat the current count as the corpus total |
| A timestamp has no timezone | Its wall-clock meaning is unresolved | Use Timezone review and choose an explicit IANA zone; never infer one from a filename or nearby line |
| A citation or bookmark no longer opens | The evidence bytes or investigation revision changed, or access is no longer available | Treat it as unresolved, reopen the current investigation, and verify the evidence again |
| A ZIP import is rejected | A safety, privacy, format, size, or nesting limit was reached | Read the intake preview/error, remove the unsafe or unsupported member, or split the bundle; rejected content is not silently dropped |
| A discussion note is not immediately visible to another person | Discussion uses bounded polling rather than a live chat socket | Wait for refresh and put the formal action in Decide |
| LDAP login succeeds but access is missing | Authentication and ContextDesk authorization are separate | Have an administrator check the mapped destination group and role; do not expose directory credentials in the browser |

If a result looks polished but its evidence link, provenance, timing, or
authorization is unclear, keep it as unknown and record the next verification
step. A fluent model answer is never a substitute for inspectable support.

## Operator closeout checklist

- [ ] Situation describes the observed problem without embedding an unproven
      cause.
- [ ] Important logs, stack traces, and observations have recognizable context
      and provenance.
- [ ] Each retained finding has a working evidence deep link.
- [ ] Lane history preserves the attempts that informed the comparison.
- [ ] Agreement, disagreement, unsupported claims, and unknowns remain
      distinguishable.
- [ ] The next action has an owner or is explicitly unassigned.
- [ ] The decision is attributed to a human.
- [ ] Discussion contains context, but the formal decision is in Decide.
- [ ] The chosen export matches the intended audience and transfer need.
- [ ] A portable-archive dry run is not described as a completed restore
      unless typed confirmation succeeded and the new investigation opened.

Next: run the [fully synthetic end-to-end walkthrough](END_TO_END.md).
