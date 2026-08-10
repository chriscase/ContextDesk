# DeepSeek V4 Flash triage usefulness gap — host role restoration

Investigation branch: `claude/deepseek-triage-usefulness-zv168u`  
Branched from: `integrate/acceptance-release-v1` at `6579a98e884d95c80bde8dd47fbb1f7881449c4d`
(acceptance-procedure pin) whose code identity is
`626bd2f67955586fa1584b0bb2bb4e5dcc4fc8c3`  
Exact code SHA of this change: see
[§ Exact SHA](#exact-sha)

No live provider call, credential read, or Keychain access was made while
producing this change. Every result below is either quoted from the existing
recorded run or produced by hermetic tests.

## 1. What the live runs actually showed

From [`VERCEL_DEEPSEEK_TRIAGE_DIAGNOSTIC_77E520DA.md`](VERCEL_DEEPSEEK_TRIAGE_DIAGNOSTIC_77E520DA.md)
and the replays on `77e520da` and `e6d5a1bc`, using
`deepseek/deepseek-v4-flash` with a 600-second whole-run ceiling and 15 of 23
requests:

- ordinary generation, strict JSON, native tool call plus continuation,
  selected-context attachment, and the linked-log product workflow all passed;
- the only failure was the typed `investigation_answer.v1` scorer, on exactly
  two dimensions:

```text
typed_trigger_identification
typed_symptom_separation
```

- terminal verdicts: `gateway_model_status: pass`,
  `product_workflow_status: pass`, `answers_useful_status: fail`,
  `classification: usefulness_gap`;
- an owner-only debug capture showed the final typed answer omitted symptoms
  and filed `causal_candidate` claims for the `LeaseWindowExpired` rows at
  seq 3–5, with `root_cause_established=false`.

There was no timeout, credential, or transport failure. The prompt-only
role-consistency contract clause and the opaque candidate-stage role hints
added in `626bd2f6` did not change the live outcome.

## 2. Where the gap actually sits

Reading the four seams named in the report:

- **Candidate assessment** (`agent.rs::parse_candidate_assessment`) already
  produces a per-group `classification` plus the exact `evidence_seqs` that
  support it, both candidate-scoped and host-validated.
- **Ledger** (`agent.rs::multi_stage_ledger`) already converts that into
  per-row `EvidenceRole` — `Cause`, `Symptom`, `Supporting`, `Neutral` — for
  precisely the identities the candidate stage selected.
- **Final comparison** sees only the content-free identifier manifest. Its
  section choice (`observations` / `symptoms` / `causal_candidates` /
  `initiating_causes` / …) is entirely model-owned.
- **Validator** (`investigation_answer.rs::validate_model_answer`) used
  `EvidenceRole` for one thing only: an `initiating_causes` claim citing a
  `Cause` row establishes root, otherwise the claim is `Withheld`. Nothing
  required a `Symptom` row to stay out of a causal section, and nothing
  noticed when a `Cause` row never reached one.

So the host already held the role information the answer contradicted. The
failure is that the roles were never reconciled after the whole-answer stage
re-filed the same evidence. That reproduces both failing dimensions exactly:
the symptom rows are never cited by a `Symptom`-kind claim
(`typed_symptom_separation`), and the trigger row is never cited by a
`CausalCandidate`/`InitiatingCause` claim (`typed_trigger_identification`).

## 3. What changed

Provider-neutral; no model-specific capability path was added.

| File | Change |
| --- | --- |
| `crates/cd-core/src/investigation_answer.rs` | `RoleCorrectionBasis`, `HostRoleCorrectionV1`, `AnswerEnvelopeV1::host_role_corrections` (serde-defaulted), `ValidationError::RolePlacement`, `plan_role_restorations` / `has_role_placement_gap` / `restore_claim_roles`, and a visible `**[host-refiled from <section>]**` marker in `render_answer_markdown` |
| `crates/cd-core/src/agent.rs` | `role_placement` correction guidance; the comparison loop now retains a validated proposal, spends its one bounded semantic correction on role placement, then applies deterministic restoration; `multi_stage_role_correction_telemetry` (`contextdesk.host_role_corrections.v1`) and a `host_role_corrections` count on the multi-stage tool detail |
| `crates/cd-cli/src/commands/gateway.rs` | linked-triage scorer lane reports `host_role_corrections=<n> semantic_attempts=<n>`; a pass that needed host restoration classifies as `retry_required`, never `compatible` |
| `crates/cd-workflow/src/chat.rs` | envelope literal updated for the new field |
| `crates/cd-core/src/triage_quality.rs` | adversarial rubric test (below); test envelope literal updated |
| `crates/cd-core/tests/triage_root_cause_lab.rs` | end-to-end scripted role-inversion lab case |
| `docs/design/proven-methods/BOUNDED_MULTI_STAGE_BROAD_TRIAGE.md` | new “Role placement is reconciled against the ledger, not re-argued” chapter section; corrected a stale claim that every production ledger row is `Neutral` (untrue since `42ac0ce`) |
| `docs/design/PROVEN_METHODS.md` | status-matrix row updated, including that the live usefulness gap remains open |

The correction is deliberately narrow:

- **demote** a `causal_candidates` claim citing *only* symptom-role evidence
  into `symptoms`;
- **promote** an `observations` claim citing *only* cause-role evidence into
  `causal_candidates`, and only when no causal claim anywhere in the answer
  cites cause-role evidence.

Nothing is ever moved *into* `initiating_causes`, so `root_cause_established`,
every `ClaimStatus`, and abstention are exactly what `validate_model_answer`
computed. An initiating-cause claim on symptom evidence is left alone — it is
already `Withheld` and visible, and repairing it would launder a real defect.
Mixed-role claims, `competing_explanations`, and `missing_evidence` are never
touched. Opaque evidence ids, candidate scope, claim ids, claim text, canonical
citations, and chronology are never modified; only the section moves, and only
in the direction the ledger already supports.

Two guards keep this from hiding model quality: every re-filed claim is marked
in the visible answer and recorded on the envelope, and `gateway diagnose`
downgrades a restored pass to `retry_required` while printing the count.

Budget impact is one provider round, and only when a gap is detected: the
recorded run spent 4 requests on the triage turn (15 of 23 overall, 86.9 s of
600 s), so a `role_placement` correction makes that 5. `role_placement` shares
the existing single-correction cap rather than adding one, and if `max_rounds`
or the turn deadline leaves no room, the loop issues no correction and the
deterministic restoration still runs — repair never depends on spare budget.
The reported `semantic_attempts` now counts comparison requests actually
issued, so a correction the budget never allowed is not reported as one that
ran.

## 4. Tests

Hermetic; no network, credentials, or provider bodies.

| Test | What it pins |
| --- | --- |
| `cd_core::triage_quality::tests::host_role_restoration_repairs_the_two_typed_usefulness_dimensions_only_when_honest` | The live shape fails exactly `typed_trigger_identification` and `typed_symptom_separation`; restoration flips both; a symptom promoted to an established initiating cause is **not** repaired and still fails |
| `cd_core::investigation_answer::tests::inverted_roles_are_restored_from_the_ledger_without_touching_authority` | Ids, scope, text, citations, statuses, and `root_cause_established` unchanged; idempotent |
| `…::restoration_never_moves_a_claim_into_an_initiating_cause` | Abstention and the `Withheld` marking survive |
| `…::mixed_evidence_and_explicit_non_causal_sections_are_left_to_the_model` | Mixed-role, competing-explanation, and missing-evidence claims untouched |
| `…::promotion_only_fires_when_the_causal_role_is_wholly_absent` | Promotion is bounded, including under a same-pass demotion |
| `…::a_refiled_claim_says_so_in_the_visible_projection` | The host marker is visible and the root line still reads the validated boolean |
| `cd_core::agent::tests::a_role_inverted_comparison_gets_exactly_one_bounded_model_repair` | Exactly one extra provider round; a self-repairing model needs zero host corrections |
| `…::a_persistent_role_inversion_is_restored_by_the_host_with_honest_telemetry` | Restoration plus `contextdesk.host_role_corrections.v1` telemetry that names the disagreeing stage and leaks no model-authored text |
| `…::a_validated_answer_is_not_lost_when_the_bounded_correction_fails` | Weak-model safety: an unparseable correction never downgrades a grounded turn to failed-closed |
| `cd_core` lab `scripted_role_inverted_comparison_is_restored_from_the_host_ledger` | The whole shipped `run_agent_turn` path: candidate roles → ledger → inverted comparison → correction → restoration → typed event, projection, and tool detail |

Also run: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets
-- -D warnings`, and the workspace test suite (run in batches on this machine
because a single link of every test binary exceeds the session disk allowance).

## 5. Remaining live blocker

This change cannot be claimed as a live fix. It is proven hermetically only.

The recorded failure is consistent with two different underlying stories, and
the share-safe bundle does not distinguish them:

1. the candidate stage classified the groups correctly and the final comparison
   inverted them — this change repairs that case; or
2. the candidate stage itself classified the repeated `LeaseWindowExpired`
   group as the initiating cause — the ledger then carries that role, the host
   must not overrule it from chronology or wording, and the typed scorer will
   still fail honestly.

The new `contextdesk.host_role_corrections.v1` telemetry plus the
`candidate_stage_classification` it carries is exactly what separates those two
on the next live run. Until that run exists, `deepseek/deepseek-v4-flash`
remains **not** triage-ready: keep ordinary/structured compatibility separate
from triage usefulness, and do not promote a triage-ready badge.

## 6. Minimal next Vercel rerun

One bounded run, exact model, 600-second ceiling, share-safe bundle:

```text
contextdesk --profile <profile> --model deepseek/deepseek-v4-flash --no-color --jsonl \
  gateway diagnose --level basic --yes --timeout 600
```

Read the `linked_log_triage` case row:

- `classification: compatible` with `host_role_corrections=0` — the model now
  places roles itself;
- `classification: retry_required` with `host_role_corrections>0` — the host
  repaired story (1) above; usable answer, model still fragile;
- `classification: usefulness_gap` — story (2); check the
  `candidate_stage_classification` values in the comparison stage detail before
  changing anything else.

Do not merge this branch into `integrate/acceptance-release-v1` before that
run.

## Exact SHA

Code commit: `e4d449e6880f732d6082227cbac9b81ae836ca52`
