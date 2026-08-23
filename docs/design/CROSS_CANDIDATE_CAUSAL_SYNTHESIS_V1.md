# Cross-candidate causal synthesis v1

Status: isolated, provider-neutral **host-bounded contract**. Not production
execution. Not a close of issue #868. Does not change
`root_cause_established` or candidate-local claim/citation confinement.

Code: `cd_core::multi_model::causal_synthesis`
Tests: `crates/cd-core/tests/cross_candidate_causal_synthesis.rs`

## Why this exists

Candidate-local validation can support a correct local claim and still withhold
root-cause establishment when the initiating trigger, propagated symptom,
unrelated evidence, and recovery span more than one candidate ledger. V1 had
no bounded surface for that connection. This slice defines the host-controlled
boundary required **before** any production wiring is safe.

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
trigger slot.

Model `note` text is stored as untrusted display only. It is never host truth.
The validated value has **no** `root_cause_established` field.

## What this slice does not do

- It does not call `validate_causal_synthesis` from `pipeline.rs`, `agent.rs`,
  CLI, desktop, collab, or any production path.
- It does not alter `validate_model_answer` or `root_cause_established`.
- It does not close issue #868. Rendered-answer establishment remains a later
  slice: the host would supply this topology into synthesis **without**
  weakening candidate-local confinement, and only then could a rendered answer
  state a root cause when this validation succeeds.
- No provider, credential, filesystem, UI, workflow, or network dependency.

Handbook impact: none — isolated contract only; no production evidence-flow
wiring.
