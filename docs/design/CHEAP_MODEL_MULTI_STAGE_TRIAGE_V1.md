# Cheap-model multi-stage triage — architecture review v1

Status: **architecture review**. This document changes no production behavior.
It records what exists on `main` at `fe5cc5fb8cde630a1aee3e3957b03a21266173e9`,
names the exact gaps between that code and a usable cheap-model triage path,
and specifies the additive contracts that close them.

Method: read the repository deep-research documents
([`CONTEXTDESK_SYNTHESIS.md`](../research/deep-research/2026-08-09-ai-integration/CONTEXTDESK_SYNTHESIS.md),
[`RETRIEVAL_IMPLEMENTATION_NOTES.md`](../research/deep-research/2026-08-09-ai-integration/RETRIEVAL_IMPLEMENTATION_NOTES.md)),
then read the executable contracts they constrain. Every claim about current
behavior below carries a source anchor. Claims about *proposed* behavior are
marked **Proposed** and have no anchor by construction.

## 1. The product question

Can several small models do useful triage work that one expensive model would
otherwise do, without any model becoming an authority?

The deep-research synthesis already answers the *retrieval* half: stronger
models solved a fixed decisive packet while the staged product path withheld
evidence, so "retrieval cannot repair a broken evidence handoff"
(`CONTEXTDESK_SYNTHESIS.md` § "Retrieval cannot repair a broken evidence
handoff"). The corollary for this review is the one that matters: **a cheap
model fails differently from a strong model, and the host boundary — not the
model — decides whether that failure is visible or silent.**

So the design goal is not "make cheap models smarter." It is: give each cheap
model a task small enough that its output is *checkable*, and make every
unchecked outcome an explicit host-recorded state.

## 2. What already exists on `main`

This is the surprising part of the review: **the role vocabulary, the
validation, the reconciliation, and both product surfaces are already built.**
All five bounded tasks named in the goal map onto shipped roles.

| Requested bounded task | Existing role | Anchor |
| --- | --- | --- |
| Timeline summary | `TimelineAnalyst` | `crates/cd-core/src/multi_model/contributions.rs:35` |
| Symptom grouping | `CausalProposer` (`Symptom` kind) | `contributions.rs:37`, `:68` |
| Candidate-cause proposal | `CausalProposer` (`CausalCandidate`) | `contributions.rs:70` |
| Contradiction detection | `ContradictionChecker` | `contributions.rs:39` |
| Missing-evidence analysis | `EvidenceGap` | `contributions.rs:41` |

Host authority is genuinely enforced, not merely documented:

| Invariant | Where it is enforced |
| --- | --- |
| `initiating_cause` absent from the proposal schema | `contributions.rs:371-391` (`ModelContributionProposalV1`) |
| Foreign evidence / candidate ids rejected | `contributions.rs:602-615` |
| Cross-candidate and independent-scope citation rejected | `contributions.rs:616-620` |
| Host-labelled symptom may not be cited as a cause | `contributions.rs:621-629` |
| Stale packet, wrong role, unsafe label rejected | `contributions.rs:583-598` |
| Agreement ignores model prose and ordering | `contributions.rs:964-970` (normalized tuple key) |
| `root_cause_established` pinned false | `contributions.rs:1057` |
| Deterministic floor when every model is gone | `contributions.rs:859` (`deterministic_baseline`) |
| Per-slot degradation reason, never a silent drop | `contributions.rs:129-201` |
| Cancellation/deadline stops admission for all later slots | `contribution_pipeline.rs:654-668` |

Surfaces are wired on both hosts: CLI `triage run --request`
(`crates/cd-cli/src/commands/triage.rs:262-277`) and Tauri `triage_run_v2`
(`desktop/src-tauri/src/lib.rs:10392-10422`) both execute the same
`cd_workflow::triage_host::run_v2_host` graph. The TypeScript engine client
(`desktop/src/lib/engine/tauriEngineClient.ts:120-190`) already has the
`preflight` / `qualify` / `run` / `replay` shape a future SDK needs.

**Conclusion: this is not a greenfield build.** It is a set of bounded
additions to a working contract. The rest of this document is those additions.

## 3. Gaps between `main` and usable cheap-model triage

Nine gaps, ordered by how much they block the stated goal.

| # | Gap | Evidence | Blocks |
| --- | --- | --- | --- |
| **G1** | Every role receives the **full** evidence body. `messages_for` builds one prompt from `packet.manifest_json()` + `packet.evidence_body()` regardless of role. | `contribution_pipeline.rs:189-221` | Cost. A contradiction checker pays for excerpts it cannot use. |
| **G2** | No per-stage latency, token, or cost accounting. `ContributionStageTelemetry` carries only `provider_rounds` + `context_chars_sent`. The `gateway_cost_ledger` is an offline ingest lane, not fed by live runs. | `contribution_pipeline.rs:107-125`; `crates/cd-core/src/gateway_cost_ledger/ingest.rs:86` | The cheapness claim is unmeasurable on the product's own runs. |
| **G3** | `evidence_gaps` are validated, then **dropped**. `reconcile_contributions` never reads `contribution.evidence_gaps`, and `ReconciliationReportV1` has no gaps field. | `contributions.rs:836-857`, `:919-1050` | Missing-evidence analysis, one of the five requested tasks, produces nothing user-visible. |
| **G4** | The reviewer sees the packet only — **not** the disagreement. `messages_for(user_text, packet, role)` takes no reconciliation input. | `contribution_pipeline.rs:189` | Escalation cannot address the conflict that triggered it; it just re-runs the work. |
| **G5** | Escalation has no tier and no distinctness requirement. The reviewer is an ordinary configured slot; `escalation_recommended` also fires on **dropout**. | `contributions.rs:1032`; `contribution_pipeline.rs:679-690` | A flaky cheap provider triggers a paid escalation. Cost inverts. |
| **G6** | Agreement counts `(role, profile, model)` tuples, so **one model in two roles reads as two witnesses**. `ModelIndependenceGroupV2` exists at policy-compile time but reconciliation never consults it. | `contributions.rs:964-970`; `triage_policy.rs:531-554` | Inflated confidence — exactly the hazard `TRIAGE_POLICY_V2.md` § "Model independence" warns about. |
| **G7** | Runtime is sequential only. `ContributionRoutingPolicy::max_parallel` is validated and then unused; the executor is a `for` loop. | `contributions.rs:211`; `contribution_pipeline.rs:601` | Latency. Four cheap parallel calls should beat one expensive call; today they serialize. |
| **G8** | `RetrievalSnapshotV1` is named in `TRIAGE_POLICY_V2.md` but **does not exist in code** (zero hits across `crates/`). Packet assembly is embedding-free. | `TRIAGE_POLICY_V2.md:78`; absent from `crates/` | Not currently a defect — see § 4.7. It is an undeclared boundary that will become one. |
| **G9** | Doc drift: `TRIAGE_SDK_CONTRACT_V2.md` states "CLI/Tauri do not execute this V2 graph yet." Both do. | `TRIAGE_SDK_CONTRACT_V2.md:74-75` vs `triage.rs:262`, `lib.rs:10407` | An implementer reading the contract doc will mis-scope the work. |

A tenth sharp edge worth recording, though it is arguably correct-as-designed:
`missing_role_coverage = !has_observation_claim || !has_causal_claim`
(`contributions.rs:1031`), while `ContradictionChecker` and `EvidenceGap`
cannot emit claims at all (`contributions.rs:552`). A policy configured with
only checker roles therefore *always* reports `insufficient_evidence` and
recommends escalation. Whatever the resolution, it should be explicit rather
than emergent.

## 4. Design

### 4.1 The one principle

The host already owns evidence, roles, chronology, citations, and the final
answer. The addition this review proposes is a second, narrower ownership
claim:

> **The host owns what each role can see, not only what each role may cite.**

Today those are the same set — every role sees everything and may cite
anything in the packet. Splitting them is what makes cheap models affordable
*and* safer, because a projection can only narrow, never widen.

### 4.2 Role packet projection (closes G1) — **Proposed**

One immutable packet, many deterministic host-computed views.

```
RolePacketProjectionV1 {
  packet_id            // unchanged; the projection never forks the packet
  role
  projection_version   // bumped when the projection rule changes
  projection_id        // H(packet_id || role || projection_version || included ids)
  included_evidence_ids
  withheld_counts { out_of_role, over_budget }
}
```

Rules:

1. `included_evidence_ids ⊆ packet.rows()`. A projection is a subset. It never
   adds, rewrites, or re-labels a row.
2. **Validation tightens, never loosens.** For a projected role,
   `validate_contribution` additionally requires
   `claim.evidence_ids ⊆ included_evidence_ids`. Every existing check still
   runs against the full packet. Citing a real-but-unseen row fails closed as
   the new `OutOfProjection` error (§ 4.4) — a strictly stronger posture than
   today, where any packet id is citable by any role.
3. **Withholding is disclosed.** `withheld_counts` is rendered into the role's
   prompt, so an under-served role abstains honestly instead of guessing. This
   mirrors the existing neighborhood accounting
   (`neighborhood.rs:196-200`), which already reports
   `withheld_clock_incompatible`, `withheld_out_of_radius`, and
   `withheld_over_budget`.
4. Reconciliation and final assembly always run against the **full** packet.
   Projections shape prompts; they never shape authority.

Suggested initial projections — deliberately boring, and tunable without a
schema change because the projection rule is versioned:

| Role | Sees | Rationale |
| --- | --- | --- |
| `TimelineAnalyst` | Manifest + ordinals + source labels + locators; **no excerpt bodies** | Chronology needs position, not prose. The largest single cost saving. |
| `ObservationExtractor` | Focus rows with bodies; context categories without bodies | Observations must quote; context need only be locatable. |
| `CausalProposer` | Focus + `PrecedingSameSource` + `FollowingSameSource` + `TraceLinked` bodies | The causal-relevant neighborhood, per § 4.3. |
| `ContradictionChecker` | Bodies for candidates only, plus `IndependentNoise` markers | Contradiction is cross-candidate; noise scope must stay visible so it is not merged in. |
| `EvidenceGap` | Manifest + category counts; **no bodies** | Absence is a structural question. Bodies add cost and invite invention. |
| `Reviewer` | Full packet + reconciliation brief (§ 4.5) | The escalation tier is the one role that should see everything. |

The `EvidenceGap` projection is the clearest illustration of the principle: the
role whose job is to name what is *missing* is also the role that needs the
least content, and giving it excerpt bodies is both the most expensive and the
most hallucination-prone option.

### 4.3 Evidence neighborhoods around events

Already shipped and already correct — this section records the boundary rather
than proposing a change. `classify_neighborhood`
(`neighborhood.rs:231`) is a pure function of host facts producing seven
positional categories (`neighborhood.rs:83-106`), each carrying a
host-authored sentence stating exactly what it proves
(`neighborhood.rs:125-149`). Three properties matter for cheap models:

- **Positional, never semantic.** `PrecedingSameSource` is "position only, not
  a cause." A cheap model that over-reads adjacency is contradicted by the
  contract text in its own prompt.
- **Fail-closed clock gate.** Cross-source temporal context is admitted only
  where the host resolved comparable clocks; withheld rows are counted, not
  dropped (`neighborhood.rs:196-200`).
- **`IndependentNoise` may never enter a chain** (`neighborhood.rs:103-105`),
  and validation enforces it (`contributions.rs:616-620`).

**Proposed, one addition:** projections must preserve category *markers* even
when they withhold bodies. A role that cannot see an `IndependentNoise` row at
all may propose a chain that silently ignores it; a role that sees the marker
without the body knows the row exists and is out of scope. Withholding content
is safe; withholding structure is not.

### 4.4 Typed role proposals and fail-closed validation

Shipped (§ 2 table). The proposal schema is
`contextdesk.multi_model.contribution.v1` with `deny_unknown_fields`
(`contributions.rs:371`), and `initiating_cause` is absent by construction, not
by filtering — a model cannot express the forbidden claim in valid JSON.

**Proposed additions**, both additive to the validator:

1. Projection confinement (§ 4.2 rule 2).
2. A `ContributionValidationError::OutOfProjection` variant distinct from
   `ForeignEvidence`. Both fail closed identically; separating them tells an
   operator whether the model invented an id or reached for a real one it was
   not shown. That distinction is the difference between "this model
   hallucinates" and "this projection is too tight," and the evaluation matrix
   in § 9 depends on being able to tell them apart.

### 4.5 Disagreement, abstention, and the reconciliation brief (closes G3, G4)

Reconciliation is deterministic and permutation-invariant today
(`contributions.rs:919`). Seven states exist
(`contributions.rs:720-735`), including explicit `Abstained` and
`InsufficientEvidence`. Abstention is a first-class model output
(`abstained: bool`, `contributions.rs:381`), not an inferred empty result —
this is right and should not change.

**Proposed — surface the gaps (G3).** Add to `ReconciliationReportV1`:

```
reported_gaps: Vec<ValidatedEvidenceGapV1>   // deduplicated by (candidate_id, normalized text hash)
```

Deduplication must use a host-computed hash, never prose similarity — the same
rule that already keeps model wording out of agreement
(`contributions.rs:964`). Gaps then render in the baseline projection
(`contribution_pipeline.rs:222`) beside conflicts.

**Proposed — brief the reviewer (G4).** A host-authored, prose-free summary:

```
ReconciliationBriefV1 {
  packet_id
  state
  conflicts: [{ candidate_id, evidence_ids, kinds }]      // from ReconciliationConflict
  reported_contradictions: [{ candidate_a, candidate_b, evidence_ids }]
  uncovered_roles: [role]
  gap_candidates: [candidate_id]
}
```

**It carries no contributor text and no model identity.** That is the whole
point: `multi_model/mod.rs:20` states "One model's prose is never another
model's authority," and a brief containing contributor prose would violate it
precisely at the moment the system is most vulnerable — when a stronger model
is being asked to adjudicate. The brief carries only host-normalized tuples,
which is exactly what the host already computes.

### 4.6 Escalation to a stronger model (closes G5, G6)

Today: `escalation_recommended = has_conflict || has_dropout ||
missing_role_coverage` (`contributions.rs:1032`), and any configured reviewer
slot runs when it is true (`contribution_pipeline.rs:679`).

Two problems. Dropout-triggered escalation means an unreliable cheap provider
*causes* the expensive call — the cost model inverts under exactly the
conditions cheap models are chosen for. And nothing requires the reviewer to be
a different, stronger model.

**Proposed — refine the existing condition, do not add a parallel enum.**
`ReviewerConditionV2` (`triage_policy.rs:118-123`) already has
`ContestedOrIncomplete` and `ExplicitRequest`. The defect is that
`ContestedOrIncomplete` *conflates* two states the reconciler reports
separately (`Contested` vs `InsufficientEvidence`), and neither condition
covers dropout — yet `escalation_recommended` fires on all three. Split the
condition to match the states that already exist:

```
ReviewerConditionV2 =
    Contested             // reconciler reported a conflict or contradiction
  | InsufficientCoverage  // a required role produced no claim
  | Dropout               // a contributor failed, timed out, or was malformed
  | ExplicitRequest       // user asked for review this turn
  | ContestedOrIncomplete // retained: Contested + InsufficientCoverage

EscalationPolicyV1 {
  conditions: [ReviewerConditionV2]   // default: [ContestedOrIncomplete, ExplicitRequest]
  require_distinct_model: bool        // default true
  tier: ModelRef                      // must not equal any contributor ModelRef
}
```

- `ContestedOrIncomplete` is retained verbatim so existing policies keep their
  exact meaning; the split variants are additive.
- `Dropout` is a condition a user may opt into, and is **absent from the
  default**. A dropped contributor degrades to the deterministic floor with its
  existing typed reason; it does not spend money. This is the single change
  that stops an unreliable cheap provider from causing a paid call.
- `require_distinct_model` is host-checked at compile time against the
  independence groups that `triage_policy.rs:531-554` already computes. This
  is reuse, not new machinery.
- If the tier is unavailable, unqualified, or not distinct, escalation is
  **not admitted** — a typed `NotAdmitted` with a new
  `EscalationTierUnavailable` reason. It never silently falls back to a
  contributor, because a contributor reviewing its own claim is the
  single-witness failure the whole design exists to prevent.

Implementation note: the runtime gate is
`if !report.escalation_recommended { NotAdmitted }`
(`contribution_pipeline.rs:679`) — a single boolean. Closing G5 means that gate
consults the policy's `conditions` against the reconciler's already-typed
state, rather than the collapsed bool. `escalation_recommended` can remain as a
reported summary; it just stops being the admission decision.

**Proposed — report independence (G6).** Add to `ReconciledClaim`:

```
distinct_models: usize      // distinct (profile_id, model) pairs
distinct_gateways: usize    // distinct profile_id
```

`contributor_count` stays for compatibility but is no longer the headline
number. `TRIAGE_POLICY_V2.md` § "Model independence and reconciliation"
already requires exactly these fields; this makes the runtime report satisfy
its own accepted contract.

### 4.7 Embeddings and reranking boundary (G8)

**Current state, stated plainly: triage packet assembly is embedding-free.**
The packet comes from the deterministic broad brief via
`build_fast_triage_packet`; embeddings and reranking live in the linked-log
search `ToolHost` path. `RetrievalSnapshotV1` does not exist in code.

This is the *correct* default and matches the research conclusion that
reranking "must not silently remove mandatory exact evidence, chronology
anchors, contradictions, rollback/recovery records, or distinct events that
merely look semantically repetitive" (`CONTEXTDESK_SYNTHESIS.md` § "Hybrid
retrieval"). The gap is that the boundary is undeclared, so a future change
could cross it without anyone noticing.

**Proposed — declare it, do not implement it yet:**

1. **Packet identity absorbs retrieval.** `packet_identity`
   (`packet.rs:461`) already hashes ledger, rows, scope, clock, and budget. If
   a retrieval snapshot ever influences row selection, it joins that hash. A
   reranked packet is a *different packet*, so no contribution validated
   against one can be replayed against the other. This falls out of the
   existing stale-packet check (`contributions.rs:583`) at zero cost.
2. **Rerank may reorder, never remove.** Mandatory anchors — focus rows,
   first/last occurrence, contradictions, rollback/recovery, and every
   `IndependentNoise` scope marker — are pinned before any reordering, per
   `RETRIEVAL_IMPLEMENTATION_NOTES.md` § "Do not produce one homogeneous
   relevance ranking."
3. **Failure preserves order.** Already the shipped rule for the rerank
   adapters (`RETRIEVAL_IMPLEMENTATION_NOTES.md:14-15`); the triage path
   inherits it rather than restating it.
4. **Corpus vectors stay identity-bound.** Existing model/dimension binding
   fails closed on mismatch; triage adds no exception.

Sequencing note: the ablation the research calls for is **already built** —
[`MULTI_MODEL_RETRIEVAL_BENCHMARK.md`](../benchmarks/MULTI_MODEL_RETRIEVAL_BENCHMARK.md)
(hidden-truth lanes, with unimplemented lanes displaying
`FUTURE_CAPABILITY_UNAVAILABLE` rather than being substituted or scored) and
[`FIXED_CORPUS_RETRIEVAL_ABLATION_V1.md`](../benchmarks/FIXED_CORPUS_RETRIEVAL_ABLATION_V1.md)
(six lanes through the production import/fusion seams), driven by
`scripts/retrieval-ablation-benchmark.sh`. So this is not new work; it is a
gating decision. Run it **before** dense retrieval enters the triage packet,
and run it against both a cheap and a strong answer model — the research warns
that better retrieval can help evidence location while leaving reasoning gaps
intact. For cheap-model triage that caveat is the whole risk, and the existing
lab already separates retrieval facts from answer usefulness, which is exactly
the separation needed to see it.

### 4.8 Bounded parallelism (closes G7)

`max_parallel` is validated and unused (`contributions.rs:211`). The
reconciler is already permutation-invariant, so parallel fan-out cannot change
the answer — which is what makes this safe to add.

One real hazard, and it is an accounting hazard rather than a concurrency one.
`execute_slot` consumes `&mut rounds` and `&mut used_chars` immediately before
sending (`contribution_pipeline.rs:611-621`). Check-then-send is correct
sequentially and racy in parallel: N slots could each observe budget and
collectively exceed it, and `MultiModelBudget` documents that the ceiling is
never crossed (`mod.rs:260-280`).

**Proposed:** reserve before the wave, refund after.

1. Compute the wave's worst-case rounds and chars from the projections
   (projections make this exact rather than estimated — § 4.2 and § 4.8
   compose).
2. Reserve the whole wave against the turn budget atomically. If it does not
   fit, admit a smaller wave; never a partial slot.
3. Run the wave; refund unspent budget on completion.
4. Collect into a **slot-indexed array**, then reconcile in slot order.
   Wall-clock ordering never reaches the reconciler.

Phase structure is unchanged: contributors fan out within a phase, the
reviewer remains a strictly later conditional phase
(`contribution_pipeline.rs:670-676`). Cancellation already shares an
`Arc<AtomicBool>` and needs no change.

Parallelism is a latency optimization, and `TRIAGE_POLICY_V2.md:104-106` is
explicit that it "is not a timeout workaround." Deadline semantics stay
exactly as they are.

### 4.9 Cost and latency accounting (closes G2)

The most important gap for the stated goal, because without it "cheap" is an
assumption rather than a measurement.

**Proposed — `ContributionStageAccountingV1`**, additive to
`ContributionStageTelemetry`:

```
elapsed_ms: u64                  // host-measured; always known
context_chars_sent: u64          // existing
prompt_tokens: MetricU64         // Known(n) | Unknown — provider-reported only
completion_tokens: MetricU64     // Known(n) | Unknown
projection_id: String            // which view this stage actually paid for
```

Three deliberate constraints:

1. **Reuse `MetricU64`** (`gateway_cost_ledger/schema.rs:49`). It already
   models `Unknown` as a distinct state from zero. Inventing a second
   tri-state, or defaulting an absent token count to `0`, would let a
   non-reporting gateway look free.
2. **No currency at the stage level.** `MultiModelBudget` states "no currency
   is invented — an honest deterministic usage budget, not dollars"
   (`mod.rs:245`). Cost stays a ledger-side join against an explicit,
   user-supplied price table. A gateway's own cost field, when present,
   remains a provider observation and never a host fact.
3. **`projection_id` is what makes the number actionable.** Without it, a
   latency or token figure cannot be attributed to a prompt shape, and
   projection tuning becomes guesswork.

Then feed the existing ledger — see
[`GATEWAY_COST_RELIABILITY_LEDGER_V1.md`](../benchmarks/GATEWAY_COST_RELIABILITY_LEDGER_V1.md).
`ingest_json_value`
(`gateway_cost_ledger/ingest.rs:151`) already accepts run records, and
`assert_share_safe_ledger_json` (`redact.rs:224`) already enforces the
share-safe boundary. Live triage runs become ledger input rather than a
parallel telemetry lane. The ledger's own rule holds: cost and quality ledgers
inform a user or an explicit policy; they never write readiness or
automatically select a winner (`TRIAGE_POLICY_V2.md:132-135`).

## 5. Wire examples

All examples use placeholder identities. Copying them literally is a bug.

The two **shipped** examples below were verified against the real type by
deserializing them into `ModelContributionProposalV1` at
`fe5cc5fb8cde630a1aee3e3957b03a21266173e9`: both parse, substituting
`initiating_cause` for the claim kind fails to parse, and adding any extra
field fails to parse. The check was run as a scratch test and deliberately not
committed — no production file changed. Proposed examples are contract
sketches and have no type behind them yet.

**Contributor proposal (unchanged, shipped).** A `causal_proposer` that found
one hypothesis and declined the rest:

```json
{
  "schema": "contextdesk.multi_model.contribution.v1",
  "packet_id": "<exact-host-packet-id>",
  "role": "causal_proposer",
  "abstained": false,
  "claims": [
    {
      "claim_id": "c1",
      "candidate_id": "<host-candidate-id>",
      "kind": "causal_candidate",
      "text": "Model prose, retained for the owner-local view only.",
      "evidence_ids": ["<host-evidence-id-a>", "<host-evidence-id-b>"]
    }
  ],
  "evidence_gaps": [],
  "contradictions": []
}
```

Note what is *not* expressible: there is no `initiating_cause` kind, and
`deny_unknown_fields` rejects an invented one.

**Abstention (shipped).** The honest cheap-model outcome, and the one the
evaluation matrix in § 9 rewards:

```json
{
  "schema": "contextdesk.multi_model.contribution.v1",
  "packet_id": "<exact-host-packet-id>",
  "role": "causal_proposer",
  "abstained": true,
  "claims": [],
  "evidence_gaps": [],
  "contradictions": []
}
```

**Role projection (Proposed).** Host → model, prepended to the role prompt:

```json
{
  "schema": "contextdesk.multi_model.role_projection.v1",
  "packet_id": "<exact-host-packet-id>",
  "projection_id": "<h(packet_id|role|version|ids)>",
  "role": "evidence_gap",
  "projection_version": 1,
  "included_evidence_ids": ["<id-1>", "<id-2>"],
  "withheld_counts": { "out_of_role": 34, "over_budget": 0 }
}
```

`withheld_counts.out_of_role: 34` is the field that lets a model abstain for a
stated reason instead of inventing coverage it does not have.

**Reconciliation brief (Proposed).** Host → reviewer. Prose-free by design:

```json
{
  "schema": "contextdesk.multi_model.reconciliation_brief.v1",
  "packet_id": "<exact-host-packet-id>",
  "state": "contested",
  "conflicts": [
    {
      "candidate_id": "<host-candidate-id>",
      "evidence_ids": ["<id-1>", "<id-2>"],
      "kinds": ["causal_candidate", "competing_explanation"]
    }
  ],
  "reported_contradictions": [],
  "uncovered_roles": [],
  "gap_candidates": ["<host-candidate-id-2>"]
}
```

**Stage accounting (Proposed).** Share-safe; no endpoint, credential, or body:

```json
{
  "role": "timeline_analyst",
  "profile_id": "<profile>",
  "model": "<exact-model-id>",
  "projection_id": "<projection-id>",
  "qualification": "qualified",
  "provider_rounds": 1,
  "context_chars_sent": 18422,
  "elapsed_ms": 2140,
  "prompt_tokens": { "known": 4611 },
  "completion_tokens": { "unknown": true },
  "outcome": "completed",
  "degradation": null
}
```

`completion_tokens: unknown` is a first-class value. A gateway that does not
report usage produces an honest unknown, never an implied zero.

## 6. Surfaces

**CLI — mostly shipped.** `triage run --request` executes the V2 graph
(`triage.rs:262-277`); `triage-policy validate|compile|example|store|qualify`
is provider-free (`cli.rs:291-307`). Additive work: render per-stage accounting
in the human view, emit it in JSONL, and add `gateway ledger` ingestion of live
triage runs.

**GUI — Tauri complete, React absent.** `triage_run_v2`, `triage_preflight_v2`,
`triage_cancel_v2`, `triage_replay`, and `triage_qualify_role_v2` all exist
(`lib.rs:10239-10483`) and the engine client consumes them
(`tauriEngineClient.ts:120-190`), but no React component calls the V2 client —
only `MultiModelReviewToggle.tsx` (single/review/contributions) is user-facing.
Per AGENTS.md § "Settings-first," the Enhanced/Advanced policy UI is the real
remaining GUI work: role assignment, preflight display, per-stage accounting,
and escalation-tier selection with visible cost consequence.

**SDK — DTOs shipped, facade absent.** `cd-core/src/triage_sdk.rs` is a
complete, bounded, validating contract layer (4 MiB wire cap, 64 KiB task,
contiguous replay with exactly one terminal). What
`TRIAGE_POLICY_V2.md:155-157` calls for and does not exist is the facade:
`triage(...)` for Standard, `triage_with_policy(...)` for Enhanced/Advanced,
plus compile/preflight/cancel/replay/evaluate seams. The TypeScript engine
client is effectively a reference implementation of that shape; the Rust facade
should match it rather than invent a third vocabulary.

## 7. Migration from the single/sequential reviewer flow

There are three configured modes today — `Single` (default), `Review`, and
`Contributions` (`multi_model/mod.rs:54-64`) — and they sit on **two different
runtimes**. `Review` runs the sequential investigator → reviewer → synthesizer
pipeline (`pipeline.rs:780`, `run_review_pipeline`) with its own role
vocabulary (`InvestigationRole`, `mod.rs:83`). `Contributions` runs the
role-decomposition pipeline with `ContributionRole`. The V2 policy graph wraps
the latter and explicitly refuses Standard.

So "migration" is really two questions, and they have different answers.

**`Single` never migrates.** It is the permanent default
(`TRIAGE_POLICY_V2.md:23`), the fallback for every degradation
(`DegradationReason::*` all end "answered with the single-model path",
`mod.rs:209-239`), and the floor that makes every opt-in route safe to try.
Nothing in this review touches it.

**`Review` is subsumed, not deleted.** A `Review` turn is expressible as a
contributions policy: one `CausalProposer` contributor plus a reviewer slot.
The mechanical mapping already exists —
`migrate_resolved_legacy_policy_v1` (`triage_policy.rs:1068`) converts resolved
legacy settings into a `TriagePolicyV2`, mapping all five contribution roles,
promoting any reviewer into a `ReviewerSlotV2` with
`ContestedOrIncomplete`, and translating `MultiModelBudget` into
`TriageBudgetV2`. It defaults a migrated reviewer to `allow_remote: false`,
which is the correct fail-closed posture: migration must never silently grant
egress the legacy config did not state.

That helper is the migration seam, and it is already written. What is missing is
only the decision to *use* it as the default path. Recommended sequencing:

1. **Coexist.** Keep `run_review_pipeline` as-is. It has live evidence behind
   it; contributions does not (§ 10, open issue 7). Removing a proven path for
   an unproven one is the wrong trade regardless of how much nicer the new
   contract is.
2. **Report both.** `ExecutedMode` already distinguishes `Review`,
   `ReviewDegraded`, and `Contributions` (`mod.rs:136-147`). Keep reporting the
   executed mode honestly so a migrated turn is never mistaken for a legacy one.
3. **Offer the mapping, do not apply it.** Surface
   `migrate_resolved_legacy_policy_v1`'s output as a *previewable* policy in
   Settings. A user sees exactly what their `Review` config becomes before
   anything changes. This is the Settings-first rule in AGENTS.md, and it also
   means the migration is reviewable rather than silent.
4. **Converge only on evidence.** `Review` is a candidate for deprecation when
   contributions demonstrates equal-or-better results on the § 9 matrix *and*
   has live evidence. Until then, two runtimes is the honest cost of not having
   measured yet.

The one thing to avoid: a third reviewer vocabulary. `InvestigationRole` and
`ContributionRole` already overlap (both have a `Reviewer`) with different
semantics — the first synthesizes, the second proposes bounded claims and
cannot establish a cause. Any new work should extend `ContributionRole`, which
is the one with the fail-closed validator behind it.

## 8. Rollout stages

Each stage is independently shippable, default-off, and leaves Standard
byte-identical. No stage depends on a later one.

| Stage | Content | Gate |
| --- | --- | --- |
| **R0** | Fix G9 doc drift; record this review in the handbook status matrix. | Docs only. |
| **R1** | Stage accounting (§ 4.9) + ledger ingestion of live runs. | Existing ledger redaction gate; share-safe assertion passes. |
| **R2** | Surface evidence gaps in the report (§ 4.5, G3). | Hermetic: gap survives reconciliation and renders. |
| **R3** | Role projections (§ 4.2) with `OutOfProjection` validation, one role at a time, starting with `TimelineAnalyst`. | Benchmark Path B verdicts unchanged; measured char reduction. |
| **R4** | Reconciliation brief to the reviewer (§ 4.5, G4). | Brief contains zero contributor prose (asserted, not reviewed). |
| **R5** | Escalation policy + tier distinctness (§ 4.6, G5/G6). | Dropout alone does not escalate; non-distinct tier is not admitted. |
| **R6** | Bounded parallelism with wave reservation (§ 4.8, G7). | Budget ceiling never crossed under fan-out; permutation invariance holds. |
| **R7** | Run the existing ablation lab against a cheap **and** a strong answer model, then decide on dense retrieval in packet assembly (§ 4.7, G8). | Ablation results, not a readiness badge. |

R1 first is deliberate: until stage accounting exists, every later stage's
benefit is an assertion. R3 before R6 is also deliberate — projections make the
worst-case reservation exact, which is what R6's atomic wave reservation needs.

## 9. Evaluation matrix

The hermetic harness already exists
(`crates/cd-core/src/cheap_model_fast_triage_benchmark/`, documented in
[`CHEAP_MODEL_FAST_TRIAGE_BENCHMARK_V1.md`](../benchmarks/CHEAP_MODEL_FAST_TRIAGE_BENCHMARK_V1.md))
with Path A (one full answer) and Path B (role decomposition → host assembly →
validate) (`mod.rs:19-22`), golden expectations, and the honest note that
latency/token fields are labels only, never readiness (`matrix.rs:1-4`).
Extend rather than replace — the rows below are new axes on that matrix, not a
second harness.

| Axis | Cells | Measures |
| --- | --- | --- |
| Path | A (single) · B (decomposed) · B+escalation | Does decomposition beat one call at equal budget? |
| Projection | full packet · per-role projection | Cost reduction **and** verdict stability. A projection that saves chars but changes verdicts is a regression. |
| Failure class | invented id · out-of-projection id · symptom-as-cause · cross-scope · independent-noise-in-chain · stale packet | Fail-closed coverage; `OutOfProjection` vs `ForeignEvidence` separated (§ 4.4). |
| Disagreement | agreeing · contested · one abstains · all abstain · dropout | Correct state, and correct *non*-escalation on dropout alone. |
| Independence | distinct models · one model in N roles | `distinct_models` must not inflate (§ 4.6). |
| Accounting | per stage | `elapsed_ms`, chars, tokens-or-`Unknown`, attributed to `projection_id`. |

Four scoring rules, all of which follow from the research documents:

1. **Abstention is not failure.** A cheap model that declines scores above one
   that asserts an unsupported cause. Only the host answer validator may
   establish a root cause (`contributions.rs:1057`).
2. **Prose never earns credit** without host validation
   (`cheap_model_fast_triage_benchmark/mod.rs:14`).
3. **Retrieval and answer quality stay separate** — the research is explicit
   that aggregating them hides exact-lookup, chronology, causal, and citation
   failures (`RETRIEVAL_IMPLEMENTATION_NOTES.md` § "Fixed product-path
   ablation").
4. **Cost comparisons hold the packet fixed.** Comparing cheap and strong
   models on different packets measures the packet, not the model — the exact
   confound the deep research identified when a stronger model succeeded on a
   fixed decisive packet that the staged product path had degraded.

## 10. Open issues

1. **Should projection membership be part of packet identity?** It is not a
   different packet — same rows, same ledger, same authority. But two runs with
   different projection rules are not comparable for cost evaluation.
   *Leaning:* keep `packet_id` stable, make `projection_id` a required
   accounting dimension. Revisit if replay comparison proves ambiguous.
2. **Checker-only policies always report `insufficient_evidence`** (§ 3, tenth
   edge). Options: treat validated contradictions/gaps as coverage; require at
   least one claim-capable role at compile time; or leave it and document it.
   *Leaning:* compile-time requirement — it fails earlier and more visibly.
3. **Does `TimelineAnalyst` without excerpt bodies still produce a useful
   timeline summary?** The projection table asserts it does. This is the single
   most load-bearing untested assumption in § 4.2 and R3 must measure it before
   the pattern is extended to other roles.
4. **Reviewer sees the full packet — should the tier get a projection too?**
   Arguing against: the escalation tier is the expensive, capable model, and
   narrowing it wastes the reason it was called. Arguing for: consistency.
   *Leaning:* no projection for the tier; record the asymmetry deliberately.
5. **Dropout escalation default.** § 4.6 turns it off. A user who values
   completeness over cost may want it on. It is a policy field either way; the
   question is only the default, and this review chooses cost.
6. **Provider token reporting is uneven.** `MetricU64::Unknown` handles it
   honestly, but if a majority of gateways report nothing, cost comparison
   falls back to `context_chars_sent` — a host fact, but not a price. Worth
   measuring before building price-table joins on top of it.
7. **No live cheap-model evidence for any of this.** The benchmark is hermetic
   (`mod.rs:5-7`). Live usefulness of role decomposition on cheap models
   remains unproven, and the handbook already labels the fast-triage route
   "hermetic only, so live fast-model usefulness remains unproven." Nothing in
   this review changes that; R1–R6 are contract work, and only R7 plus live
   diagnostics can change the claim.

## 11. Non-claims

This review runs no provider, qualifies no model, measures no live cost, and
makes no readiness claim. It proposes additive contracts against a working
implementation. Every proposed field is optional-on-the-wire and default-off in
behavior; Standard mode and the existing single/reviewer routes remain
unchanged until a host explicitly opts in.
