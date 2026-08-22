# Production qualification of host-bounded causal synthesis

Status: **production-wiring qualification lab**. Child of the pipeline
wiring slice. Not a close of issue #868. Does not duplicate the isolated
contract laboratory (direct `validate_causal_synthesis` fixtures without the
live pipeline).

Code under test: `cd_core::multi_model::run_review_pipeline` with
`ReviewPipelineInputs.causal_packet`, scripted `ChatBackend`s, and the public
host packet seam `build_fast_triage_packet`.

## What this lab qualifies

The production reviewer pipeline may grant `Cause` / `Symptom` roles only after
a model proposal passes the host-derived topology (`validate_causal_synthesis`).
`root_cause_established` may become true only after that grant **and**
`validate_model_answer` both succeed on the same run.

A missing topology/packet, or a packet bound to the wrong session, turn,
corpus, revision, a stale/foreign/rejected-candidate/structurally-altered/
identity-drifted packet, cannot supply that grant. Pair-keyed reuse of a raw
`claim_id` across different candidates remains valid when the rest of the
host packet is honest.

When causal validation is withheld (malformed proposal, correction
exhaustion, provider failure, skipped for budget, deadline, cancel), the
pipeline may still emit a useful non-empty answer. That answer stays
causal-neutral: model prose, chronology, frequency, and ordering never become
host truth.

## What this lab does not do

- It does not re-implement validators or copy the isolated-contract fixture
  lab.
- It does not production-edit `pipeline.rs`, `agent.rs`, or the contract
  modules.
- It does not close #868. Rendered-answer establishment in live provider
  paths, desktop, collab, and CLI remain out of this child.

## Residual (not a production-authority defect)

A causal-stage `CallResult::Deadline` / `Cancelled` returns the turn-level
`MultiModelOutcome::Deadline` / `Cancelled` without the `deadline_outcome`
stage tag used by investigator, reviewer, and synthesizer. The turn still
fails closed, does not establish a root cause, and does not start synthesis.
Stage-level deadline tagging for the causal synthesizer is future telemetry
polish, not a grant of authority.

Reviewer collusion prose is not an independent fail-closed axis on this
production path. An otherwise-valid causal proposal (trigger, symptom, and
required disconfirmation) plus a colluding review still establishes after
both validators pass. Collusion neither grants nor vetoes host authority.

Handbook impact: none — qualification of already-wired production seams;
no new evidence-flow change.
