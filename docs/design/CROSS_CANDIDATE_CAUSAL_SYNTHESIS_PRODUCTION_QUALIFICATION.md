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

The hardened production boundary also proves:

- reviewer contradiction citations are intersected with each named claim's
  own validated evidence ids; naming a claim without citing its evidence does
  not mint a disconfirmation slot;
- downstream `propagation` and `following_same_source` evidence cannot initiate
  a causal chain, and production v1 does not infer recovery from chronology;
- the optional causal call receives only the whole-turn character budget left
  after reserving one mandatory final-answer prompt; and
- missing/invalid topology, causal deadline, and causal cancellation all emit
  explicit typed causal-stage progress without leaking model content.

## What this lab does not do

- It does not re-implement validators or copy the isolated-contract fixture
  lab.
- It does not alter `agent.rs`, the public causal contract, provider/profile
  defaults, credentials, or UI.
- It does not close #868. Rendered-answer establishment in live provider
  paths, desktop, collab, and CLI remain out of this child.

## Remaining limits

Production v1 intentionally has no host-owned recovery classifier, so it admits
no recovery slot rather than guessing from chronology. Packet-id binding and
held-out/live-provider usefulness remain later defense-in-depth and quality
work. Neither limit grants causal authority.

## Reviewer-collusion fail-closed gate

`reviewer_collusion` is a required fail-closed axis. An otherwise-valid causal
proposal plus a reviewer contradiction on observation claims now records a
`contested_review` causal-stage skip and keeps `root_cause_established = false`.
The final synthesizer may still return a useful bounded answer. This policy is
structural: any validated cross-candidate contradiction is unresolved and
cannot be converted from model prose into host-owned disproof authority.
Empty-review causal qualification and pair-keyed claim reuse remain valid.

Handbook impact: bounded pipeline semantics and qualification only; no provider,
profile, credential, UI, or default-mode change.
