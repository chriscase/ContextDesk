# War Room end-to-end walkthrough

This five-minute walkthrough uses only the shipped synthetic demo. It does not
require a live provider, external service, or imported source material. The
goal is to learn the War Room decision flow—not to benchmark a model or prove
production readiness.

## 0:00 — Start the synthetic demo

From the repository root:

```bash
cd collab
npm run demo
```

Leave that process running. Open the local address it prints, then sign in:

```text
Username: demo
Password: demo
```

If the command cannot start or the local address does not load, stop here and
record the environment failure. Do not substitute a live system or external
data for this walkthrough.

## 0:30 — Orient in Overview, then open a synthetic investigation

On **Overview**, read the recorded status counts and latest activity. Select an
activity to see its exact-stage route, then return to **Investigations** and
select the prepared synthetic War Room item. Overview answers “what changed?”;
Investigations is the searchable, resumable inventory.

![Fully synthetic War Room Overview](../assets/war-room/war-room-overview.png)

![Fully synthetic War Room investigations screen](../assets/war-room/war-room-investigations.png)

Expected result: the investigation opens with its existing Situation and
workflow state. Nothing on this screen implies that the example came from a
live environment.

## 1:00 — Read Situation before choosing a cause

In **Situation**, identify four things:

1. the observable synthetic problem;
2. who or what is recorded as affected;
3. its impact and bounded scope; and
4. the questions that are still unknown.

If you have write access, choose **Edit situation** to update those durable
fields. Leave a field blank when it is not known; the UI will show **Not
recorded** rather than manufacture context.

![Fully synthetic Situation screen](../assets/war-room/war-room-situation.png)

Expected result: you can repeat the problem without naming an unproven cause.
Situation orients the investigation; it is not the conclusion.

## 1:40 — Capture and inspect recognizable evidence

Move to **Capture** and confirm that the case contains recognizable synthetic
logs or stack traces. Then open **Compare**, find an investigative finding,
and choose **Inspect supporting artifact**. Confirm that the destination shows
recognizable context, not just an isolated phrase.

![Fully synthetic evidence deep-link destination](../assets/war-room/war-room-evidence-deep-link.png)

Open **Technical details** and inspect the available source, time, identity,
or diagnostic metadata. Note the provenance label:

- **Synthetic** means generated for this demonstration.
- **Live** would mean produced through a current connected run, not verified.
- **Imported** would mean brought in from outside the run, not native or
  necessarily human-authored.

Expected result: you can explain where the item came from and what is still
unknown. If the evidence link does not resolve to the claimed context, the
finding is not verified by its prose.

## 2:30 — Analyze, then inspect one lane in depth

Move to **Analyze** and confirm which bounded lanes ran against the frozen
evidence. Return to **Compare**, scroll to Decision readiness, and use
**Inspect a lane**. The compact digest shows its question, recognizable
evidence, latest conclusion, and unknowns without changing the aggregate
comparison. Open **View full chronological lane history** only when you need
every recorded step.

![Fully synthetic focused analysis lane and history](../assets/war-room/war-room-lane-focus.png)

Read the lane as an attempt. A polished explanation can still be incomplete.
A partial or failed attempt remains useful when its status and limits are
honest.

Expected result: selecting a lane does not jump the page; the URL becomes
shareable, and you can identify what strategy the lane used, which evidence it
cited, and whether anything changed between attempts.

## 3:15 — Compare small-model strategies

Open **Compare**. The synthetic lanes use different bounded strategies, such
as reconstructing a timeline, locating the failure boundary, and challenging
the leading claim. Compare their evidence use rather than their writing style.

![Fully synthetic comparison of lane strategies](../assets/war-room/war-room-compare.png)

Review each category:

- **Agreement:** compatible claims with inspectable support.
- **Disagreement:** competing interpretations or boundaries.
- **Unknowns:** questions the captured material cannot answer.
- **Unsupported:** claims whose evidence is absent, irrelevant, or broken.

Expected result: agreement is visible but is not presented as proof. At least
one open question can remain unknown without being silently completed by a
model.

## 4:00 — Discuss the next action

Add or read a short synthetic discussion note that connects the comparison to
the next action. Discussion is durable across refresh and updates through
polling. It is not WebSocket chat or live presence, so allow for refresh
latency and do not expect typing indicators or a viewer roster.

Expected result: discussion preserves review context, while the formal action
and owner are recorded in Decide.

## 4:30 — Decide and export

In **Decide**, select the next action justified by the evidence. Confirm its
owner, rationale, unresolved disagreement, and unknowns. The human operator
makes the decision; a lane may propose an action but cannot approve it.

Create or inspect the export. Verify that it carries:

- the Situation;
- the evidence-backed findings and provenance;
- material agreement, disagreement, and unknowns;
- the chosen next action and owner; and
- the human decision context.

Expected result: the exported record is reviewable without pretending the
synthetic investigation is live or that consensus guarantees correctness.

## What this walkthrough demonstrates

The walkthrough demonstrates the shipped War Room path:

**Situation** → **Capture** → **Analyze** → **Compare** → **Decide** →
**human export**

It also demonstrates evidence-first findings, deep links, Technical details,
lane focus and history, durable discussion, small-model strategy comparison,
provenance labels, and honest unknowns.

## What this walkthrough does not demonstrate

The synthetic demo does not claim:

- production LDAP readiness without deployment-specific configuration and
  testing;
- WebSocket chat, presence, typing indicators, or instant discussion updates;
- shipped portable full import apply or persistence;
- web ZIP or directory upload;
- a complete admin or capability-management UI;
- live-provider quality, production performance, or correctness on
  non-synthetic material.

For operating guidance and review criteria, continue to the
[operator guide](OPERATOR_GUIDE.md). Return to the [War Room overview](README.md).
