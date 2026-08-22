# Cross-candidate causal synthesis v1

Status: provider-neutral **host-bounded contract**, wired into the bounded
multi-model review pipeline behind host-derived topology. This is not a claim
that issue #868 is fully closed or that model output is correct. A final answer
may set `root_cause_established` only when both the causal proposal and the
ordinary investigation answer pass their separate host validators.

Code: `cd_core::multi_model::causal_synthesis`
Tests: `crates/cd-core/tests/cross_candidate_causal_synthesis.rs`

## Why this exists

Candidate-local validation can support a correct local claim and still withhold
root-cause establishment when the initiating trigger, propagated symptom,
unrelated evidence, and recovery span more than one candidate ledger. V1 had
no bounded surface for that connection. This slice defines the host-controlled
boundary required for production wiring to remain fail closed.

## Contract

Schema id: `contextdesk.multi_model.causal_synthesis.v1`

The model emits a strict proposal (`deny_unknown_fields`). The host supplies
the exact admissible topology — admitted candidate, claim, and evidence
identities plus allowed relationship slots — and validates the proposal into a
typed value. The model cannot union arbitrary candidates. Claim uniqueness is
the pair `(candidate_id, claim_id)`, matching `KnownClaims`: two candidates
may reuse the same raw `claim_id`.

Relationship kinds remain distinct:

| Kind | Meaning |
| --- | --- |
| `initiating_trigger` | Host-admitted initiating change or trigger |
| `propagated_symptom` | Host-admitted propagated effect |
| `unrelated_competing` | Host-admitted unrelated or competing evidence; stays separate |
| `recovery` | Host-admitted recovery. Recovery cannot become cause |
| `disconfirmation` | Host-admitted required disproof |

Host validation fails closed for:

- unknown fields (including chronology/frequency keys)
- foreign, duplicate, unsafe, or cross-scope identities
- cross-corpus or wrong-revision evidence
- false candidate union
- decoy promotion of unrelated evidence into trigger/symptom
- recovery used as initiating trigger
- omitted required trigger, symptom, or disproof
- empty evidence on a relation
- slots the host did not admit

Chronology or frequency alone never establishes causality: those fields are not
part of the proposal, and an earlier/more-frequent decoy is not an admitted
trigger slot. `following_same_source` and `propagation` evidence are downstream
by host construction and cannot initiate the chain. Production v1 does not
infer recovery from chronology; until an explicit host-owned recovery class is
available, no production recovery slot is admitted.

Reviewer contradiction evidence is advisory input, not new authority. For each
named claim, topology derivation intersects contradiction citations with that
claim's already validated evidence ids. A reviewer therefore cannot enlarge a
claim's evidence identity set by citing evidence from another claim or
candidate.

Model `note` text is stored as untrusted display only. It is never host truth.
The validated value has **no** `root_cause_established` field.

## Production pipeline gate

The review pipeline derives admissible topology from the exact turn binding,
host evidence ledger, validated candidate findings, validated review, and the
host-created fast-triage packet. Missing host proof is recorded as a typed
`skipped` causal stage; stale or malformed bindings are recorded as
`semantic_invalid`. Either outcome leaves the final ledger causal-neutral.

The causal model call is optional authority. The host first reserves the exact
whole-turn character budget required for the mandatory final-answer prompt. If
the causal prompt cannot fit in the remainder, it is skipped with zero provider
calls and the ordinary final answer may still complete. Deadline and
cancellation during the causal call emit the same terminal progress accounting
as every other stage.

After a causal proposal validates, the host clears pre-existing cause/symptom
roles and grants only the exact admitted relation identities. The final answer
still runs through `validate_model_answer`; causal validation alone cannot make
the rendered answer establish a root cause.

## What this slice does not do

- It does not weaken or replace `validate_model_answer`.
- It does not claim issue #868 is complete: held-out/live-quality usefulness,
  explicit recovery classification, packet-id binding, and broader operator
  qualification remain separate work.
- It does not make reviewer prose, model notes, chronology, frequency, or model
  confidence into host truth.
- It adds no provider/profile default, credential handling, filesystem write,
  UI surface, or network protocol. Production execution uses the already
  selected bounded pipeline backends.

Handbook impact: pipeline semantics only. No provider, profile, credential, UI,
or default-mode change.
