---
id: war-room-evidence-review
title: Review War Room evidence and model lanes
summary: Check manual intake provenance, frozen snapshots, lane claims, and human decision boundaries before relying on a result.
section: war-room
tags:
  - war-room
  - evidence
  - provenance
  - models
  - decisions
  - process
order: 20
related:
  - war-room-workflow
  - war-room-deployment
---

# Review War Room evidence and model lanes

A polished explanation is not evidence. Review the source material, its
provenance, the snapshot used by each lane, and the limits of the recorded run
before accepting a claim.

![Evidence remains visible through Capture, snapshot-bound analysis, comparison, and a human-owned decision](../assets/war-room-stage-flow.svg)

## Manual intake checklist

| Check | Acceptable record | Stop and review when |
| --- | --- | --- |
| Authorship | Human contribution and imported output use separate labels | Pasted model or tool output is presented as a person's finding |
| Source | A reusable source label identifies the producer as far as known | Registration is treated as a live connection or proof of correctness |
| Original material | Imported output remains separate from summaries | A paraphrase is the only retained record |
| Missing metadata | Unknown model, version, prompt, visibility, or operator stays unknown | The record invents a value because it seems likely |
| Corroboration | A person links relevant investigation material before marking corroborated or contradicted | The state changes automatically or has no supporting link |

Manual intake begins unverified. The importer and the described operator are
different provenance fields. A package snapshot identity is useful only when
it is actually recorded; its absence does not license an inferred binding.

## Snapshot and lane checks

Each selected lane should identify the frozen evidence snapshot it received.
Matching labels or fingerprints alone are insufficient when the run record
does not contain complete same-snapshot proof. War Room reports incomplete,
mismatched, or unknown comparison state instead of silently calling it fair.

For every lane, check:

1. What job or strategy was the lane given?
2. Which snapshot and evidence identities are recorded?
3. Did the lane complete, fail, cancel, or return partial material?
4. Which claims cite which evidence?
5. What unknowns and trace gaps remain?

Configured model lanes use an optional host-owned bridge. The browser receives
bounded catalog and run information, not provider credentials or endpoints.
Model availability and quality depend on the deployment.

## Compare evidence, not votes

| Signal | Review action |
| --- | --- |
| Several lanes cite one item | Inspect whether they make the same claim and whether the item supports it |
| Lanes interpret one item differently | Record the conflict and inspect surrounding context |
| Only one lane cites an item | Corroborate it or keep it as a single-lane lead |
| Claim has no citation | Keep it unsupported; do not promote it to a finding |
| Trace is partial or missing | Do not claim to know what happened in unrecorded steps |
| Evidence is missing | Return to Capture or Analyze |

Agreement does not prove correctness. Lane count is not a ranking. A focused
lane remains only one part of the full comparison.

## Human decision boundary

Models may propose explanations or actions. Only an authorized person records
the accepted next action, rationale, and remaining uncertainty in Decide, plus
an owner when one is assigned. Discussion is context, not the decision record.

War Room does not claim automatic winner selection, model approval authority,
or certainty from consensus. If the evidence is insufficient, gather more
evidence.

For the complete stage sequence, open help://war-room-workflow. For deployment
and ContextDesk handoff boundaries, open help://war-room-deployment.
