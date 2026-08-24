# War Room

War Room is ContextDesk's evidence-first workspace for turning an unclear
technical problem into a reviewable human decision. It keeps the original
logs, stack traces, and observations close to every claim; lets human and
model lanes attempt the problem independently; and makes agreement,
disagreement, and uncertainty visible before anyone chooses a next action.

> All screenshots and examples in this documentation are fully synthetic.
> They contain only generated demonstration material and do not represent a
> live investigation.

![War Room workflow: Situation, Capture, Analyze, Compare, and Decide](../assets/war-room/war-room-flow.svg)

## The mental model

War Room is not a chat window with evidence attached afterward. Its working
unit is a problem moving through a traceable chain:

**Problem** → **recognizable evidence** → **human and model lane attempts** →
**agreement, disagreement, and unknowns** → **next action and owner** →
**human decision and export**

That chain matters because fluent analysis is not the same as demonstrated
analysis. A useful finding tells a reviewer what it claims, which evidence
supports it, what remains unknown, and who is responsible for the next move.

![Synthetic War Room investigation list](../assets/war-room/war-room-investigations.png)

## Overview is the command center

**Overview** answers “what changed, and where should I look next?” It shows
recorded status counts, the latest activity visible to the signed-in person,
and active high-impact investigations. Activity rows identify the actor, the
recorded action, the investigation, and the server time. Selecting a row opens
the relevant investigation stage and recorded item; internal identifiers stay
out of the default presentation.

The feed is intentionally bounded. It is a recent-work orientation surface,
not a complete audit log or an inferred priority ranking. **Investigations** is
the separate inventory for search, status filtering, creation, and resuming any
case visible to the user.

![Synthetic War Room Overview with recent activity](../assets/war-room/war-room-overview.png)

## The five stages

| Stage | Operator question | Durable output |
| --- | --- | --- |
| **Situation** | What problem are we trying to understand? | An editable, durable problem statement, affected parties, impact, bounded scope, and explicit open questions; missing fields remain not recorded |
| **Capture** | What did people observe, and what outside analysis was brought in? | Human-authored notes, hypotheses, actions, and clearly labeled imported output |
| **Analyze** | What evidence is available, and what did each lane try? | Uploaded logs and stack traces, frozen evidence snapshots, independent attempts, and run history |
| **Compare** | Where do the attempts align or diverge? | Agreement, disagreement, unsupported claims, and unresolved questions |
| **Decide** | What happens next, and who owns it? | A human-selected action, owner, rationale, and exportable record |

The stages form a deliberate path, but investigation is iterative. A
comparison can expose a missing log line, sending the operator back to
Capture. A failed lane can be retried in Analyze without erasing its earlier
attempt. A decision can record that the correct next action is to gather more
evidence.

## Evidence before conclusions

War Room findings should be read from the evidence outward:

1. Open the cited log line, stack frame, or captured observation.
2. Confirm its source and whether it is synthetic, live, or imported.
3. Read the finding and the lane attempt that produced it.
4. Compare it with other attempts and inspect contradictions.
5. Preserve missing information as an unknown rather than filling the gap.

Evidence deep links take the reviewer back to the relevant context instead of
leaving a bare citation in prose. **Technical details** expose the identifiers,
timestamps, source metadata, lane configuration, and other diagnostic fields
needed to audit an item without overwhelming the default view.

## Lanes are attempts, not authorities

A lane represents one human or model strategy applied to the captured
material. Multiple lanes are useful when they create genuine independence:
for example, one small-model lane can reconstruct a timeline, another can
look for a failure boundary, and a third can challenge unsupported causal
claims. Their outputs are candidates for review, not votes.

The focused-lane digest shows the currently selected comparison lane and its
recorded trace; it is not a universal cross-run history browser. Earlier runs
remain separate **Historical artifacts** in Compare. Opening a historical
comparison preserves the exact candidates and trace that informed an earlier
discussion or decision. A rerun must create a new recorded run/comparison
rather than quietly replacing the prior result.

Agreement increases confidence that several attempts noticed the same thing;
it does not prove the thing is correct. Disagreement is useful when the
conflicting claims can be traced back to evidence. Unknowns are useful when
the available evidence cannot distinguish between plausible explanations.

## Provenance is always part of the result

War Room distinguishes three origins:

- **Synthetic** — generated demonstration material. It is safe for the
  walkthrough and proves product flow, not real-world model quality.
- **Live** — produced during a currently connected run. “Live” describes how
  the result arrived; it does not make the result verified.
- **Imported** — brought in from outside the current run. Imported material
  retains that label and should not be presented as native or human-authored.

If origin, timing, model identity, or evidence coverage cannot be established,
the honest value is **unknown**. War Room should not infer provenance from the
quality or style of the text.

## Five-minute synthetic start

From the repository's `collab` directory, start the fully synthetic demo:

```bash
cd collab
npm run demo
```

Open the local address printed by the command and sign in with the synthetic
demo credentials:

```text
Username: demo
Password: demo
```

No live provider or external data is required for this walkthrough. Follow
the [five-minute end-to-end walkthrough](END_TO_END.md) to move from the
investigation list through Situation, evidence, lane comparison, a human-owned
next action, and export.

## What is shipped, and what is not claimed

The following boundary is part of the documentation contract. “Shipped” does
not mean every deployment is automatically configured.

| Area | Current behavior | Residual or non-claim |
| --- | --- | --- |
| War Room workflow | Command-center Overview; searchable Investigations inventory; Situation, Capture, Analyze, Compare, Decide; evidence-first findings; lane attempts and history; deep links; Technical details; discussion; and human decision/export | Recent activity is not a priority ranking, agreement is not proof, and model output is not a human decision |
| Provenance | Synthetic, live, and imported origins remain distinguishable; missing facts can remain unknown | A live or imported label does not imply verification |
| Discussion | Durable discussion that survives refresh and is updated through polling | Not WebSocket chat, live presence, typing indicators, or instantaneous collaboration |
| LDAP | The LDAP adapter is production-ready only when it has been configured and tested for the deployment | No claim that LDAP works without deployment-specific configuration and qualification |
| Portable full import | Draft work exists for full import apply and persistence | Portable full import apply/persistence is not shipped |
| Web intake | Existing documented capture paths only | Web ZIP upload and web directory upload are not claimed |
| Administration | Available configuration and status surfaces only | A complete admin UI or complete capability-management UI is not claimed |

## Continue reading

- [Operator guide](OPERATOR_GUIDE.md) — how to run and review an
  investigation without losing provenance or uncertainty.
- [End-to-end walkthrough](END_TO_END.md) — a five-minute, fully synthetic
  tour using the supplied screenshots.
