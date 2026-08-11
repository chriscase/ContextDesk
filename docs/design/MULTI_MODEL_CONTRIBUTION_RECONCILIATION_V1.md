# Multi-model contribution and reconciliation v1

Status: contract, persistent opt-in configuration, workflow/CLI/desktop
injection, evaluation, and redacted diagnostics are implemented on this
feature branch. New live gateway validation remains an external-evidence step.

This design is the next phase after the single-model and reviewer-first release
work. It makes several inexpensive models useful without making any model a
hard dependency and without moving evidence authority out of ContextDesk.

## Product rule

Models contribute bounded interpretations. The host owns the corpus, packet,
candidate identities, evidence identities, chronology, roles, citations, scope,
budgets, and final answer. A model cannot mint evidence, establish an
initiating cause, promote a symptom, pull independent chronology into a chain,
or silently switch providers.

The minimum answer remains useful when every model is unavailable: a host-built
timeline, candidate groups, structural relationships, canonical evidence ids,
known symptoms, and `root_cause_established=false`.

## Contract

`cd_core::multi_model::contributions` defines the provider-neutral schema
`contextdesk.multi_model.contribution.v1`.

The host assigns one of these roles to each bounded call:

| Role | May propose | May not do |
| --- | --- | --- |
| `observation_extractor` | host-grounded observations | propose causal roles |
| `causal_proposer` | symptoms, causal candidates, competing explanations | establish an initiating cause |
| `contradiction_checker` | contradictions between distinct host candidates | change evidence or merge candidates |
| `evidence_gap` | missing-evidence reports | cite evidence that is not present |
| `reviewer` | the union of the above bounded proposals | override host validation |

Every proposal must echo the exact host `packet_id`. The host rejects unknown
or cross-candidate ids, independent-timeline evidence in causal proposals,
host-labelled symptoms used as causes, stale packets, wrong-role sections,
duplicate/unsafe model labels, and malformed JSON. `initiating_cause` is absent
from the contribution schema by construction.

Agreement is calculated from normalized tuples of
`(candidate_id, claim_kind, sorted_evidence_ids)`. Model prose and model claim
labels do not affect agreement. This prevents vocabulary differences or output
ordering from changing the result.

## Deterministic reconciliation

`reconcile_contributions` records every attempt's availability state and then
produces a `ReconciliationReportV1`:

- `supported`: non-root proposals have complete observation/causal coverage
  and no deterministic conflict;
- `contested`: competing causal readings or an explicit contradiction report;
- `insufficient_evidence`: some bounded contributions completed but a required
  role was missing or abstained;
- `abstained`: all usable contributors explicitly abstained;
- `escalation_recommended`: a bounded reviewer/escalation may help, never an
  automatic retry or provider switch;
- `unavailable`: attempts existed but none completed;
- `deterministic_baseline`: no model was attempted, so the host floor is used.

The report always includes `root_cause_established=false`. Only the existing
host answer validator can establish a root cause from host `Cause` provenance.

## Bounded routing policy and runtime seam

`ContributionRoutingPolicy` and `ContributionRoutingPlan` are the host guard
for workflow execution. They cap contributors, parallelism, rounds, and
context, while allowing duplicate role slots for independent models.

`cd_core::multi_model::contribution_pipeline::run_contribution_pipeline` is the
production-neutral execution seam. The workflow host supplies already-built,
already-authorized `ContributionBackendSlot` values, each carrying an exact
role identity and measured `ContributionQualification`. An unverified or
unqualified slot becomes an explicit `unavailable` attempt and is never sent a
packet. The agent receives the runtime through
`AgentOptions::contribution_runtime` / `ChatWorkflowRequest` only when a host
explicitly opts in; no model-name lookup, credential read, provider switch, or
second HTTP client exists in this layer.

1. Build exactly one immutable `FastTriagePacketV1` and record its identity.
2. Run a small, explicitly selected set of qualified roles sequentially in v1
   (the plan retains a parallelism bound for a later scheduler).
3. Give each role one bounded call, with the existing whole-turn deadline,
   context budget, cancellation flag, and no hidden retry loop. Runtime
   enforcement takes the smaller of the per-turn budget and the routing plan's
   `max_rounds`/`max_context_chars` ceilings; validated policy fields are never
   advisory.
4. Validate each response locally. A failed response becomes an explicit
   `Malformed`, `TimedOut`, `Cancelled`, `Failed`, or `Unavailable` attempt.
5. Reconcile normalized claims and host contradictions. If contested or
   incomplete, optionally run one qualified reviewer against the *same packet*.
6. The opt-in contribution route returns a host-rendered reconciliation answer
   and typed envelope directly. If no valid proposal exists, the same envelope
   remains root-cause-false and the explicit unavailable/abstention state is
   shown; the established Single/Review routes are unchanged when the runtime
   is absent.

This is additive: `MultiModelMode::Single` and the existing reviewer-first path
remain the default and are not changed unless a host explicitly injects the
contribution runtime.

Persistent configuration now lives under `AppConfig.contributions`:
`enabled`, explicit role assignments, a routing policy, per-turn budgets, and a
bounded neighborhood budget. `--mode contributions` is available in the CLI;
the desktop host accepts the same per-turn mode and persisted default. The
workflow resolver reads the shared qualification store and uses the existing
credential cache/provider builder, so unqualified or unauthorized roles are
never contacted.

A minimal configuration is explicit and intentionally boring; profile ids and
model ids are copied from the local catalog/qualification output rather than
guessed from names:

```json
{
  "contributions": {
    "enabled": true,
    "roles": [
      {
        "role": "observation_extractor",
        "profile_id": "vercel-live",
        "model": "<exact-qualified-model-id>",
        "require_qualified": true,
        "allow_remote": true
      },
      {
        "role": "causal_proposer",
        "profile_id": "vercel-live",
        "model": "<exact-qualified-model-id>",
        "require_qualified": true,
        "allow_remote": true
      }
    ]
  }
}
```

The placeholders are documentation only and must not be copied literally.
Qualification evidence is keyed by the exact profile, endpoint fingerprint,
provider kind, and model id. The desktop selector can enable or disable the
route, while role assignments remain host configuration; selecting the route
without assignments or current qualification visibly falls back to the
deterministic floor.

## Privacy and telemetry

Activity output should expose role, stage, bounded counts, availability,
deadline, and reconciliation state. Share-safe reports may include packet and
model fingerprints, evidence counts, dimensions, and failure categories. They
must not include credentials, authorization headers, endpoints, private paths,
or raw provider bodies. Owner-local detail views can render model text through
the existing literal presentation boundary.

## Evidence and testing

The module contains hermetic tests for:

- exact packet binding and stale packet rejection;
- root-cause, symptom-promotion, independent-noise, foreign-id, cross-scope,
  and unsafe-label rejection;
- explicit unavailable, timeout, cancellation, and abstention states;
- partial role dropout and escalation recommendation;
- agreement independent of model wording, labels, and output order;
- contradiction-checker reports and contested outcomes;
- deterministic baseline contents and root-cause ceiling;
- deterministic permutation invariance.

The existing `multi_model_pipeline` and
`cheap_model_fast_triage_benchmark` suites remain the regression gates for the
reviewer-first runtime and role-decomposition benchmark. Mutation targets for
the next integration step are: accepting an initiating-cause kind, accepting a
foreign id, treating a completed abstainer as role coverage, dropping an
unavailable contributor, and making model text part of agreement. Each must
fail closed when inverted.

`replay_reconciliation` provides a provider-free comparison artifact for the
same packet in deterministic-only, single-contributor, and bounded
multi-contributor modes. It records states and normalized claim/conflict counts
only, so a quality lab can compare routing strategies without storing model
prose or contacting a gateway.

The runtime seam additionally proves successful role progress, malformed
output, pre-cancellation, qualification dropout, share-safe telemetry, and an
end-to-end linked-log turn that calls only the explicitly selected contribution
slots.

## Current model evidence

The current Vercel observations are evidence for routing policy, not universal
compatibility claims:

- DeepSeek V4 Flash completed the product linked-log triage path and produced a
  useful result, but direct capability checks remained limited.
- GPT-OSS 120B completed the product path quickly, but its typed scorer found
  symptom-separation failure (initiating causes were asserted without a
  downstream symptom section).

Those observations support a bounded role decomposition and deterministic
reconciliation. They do not justify a readiness badge or a hard-coded model
preference. See `docs/benchmarks/VERCEL_MODEL_COMPARISON_D39688C7.md` and the
two model-specific diagnostic reports for the exact synthetic-run evidence.

## Follow-up acceptance plan

Next, run the provider-neutral gateway diagnostic against one selected catalog
model at a time with the configured role assignments. Acceptance should compare
deterministic-only, bounded multi-model, and single/reviewer outputs on the same
host packet, with no employer gateway call until the owner explicitly authorizes
it.
