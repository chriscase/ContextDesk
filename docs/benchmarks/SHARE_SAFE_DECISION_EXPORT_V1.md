# Share-safe accepted-human-decision experiment export v1

Status: hermetic qualification lab for the shipped Experiment Lab v2 export
projector and parsers. Not a live-provider, HTTP, UI, or cryptographic claim.

This record is the design and qualification note for
`projectExperimentLabExport` → `parseLabExportV2` (and the nested parsers that
function already calls). It does not introduce a second validator, JSON schema,
or parallel projector.

## What the lab proved

Held-out opaque `ReviewExportSource` fixtures (not the demo checkout / three-model
vocabulary) plus a typed mutation matrix drive the real projector and the real
final parser.

On that path the lab showed:

- Only an **accepted** human decision is exported. Proposed-only sources emit
  `decision: null`. Mixed proposed + accepted sources emit the accepted row and
  withhold the unused proposed identity.
- Decision **revision / predecessor** pairs are honest (`revision 1` has no
  predecessor; later revisions name `revision - 1`). Gold **version /
  predecessor** pairs follow the same rule and cannot name the current gold.
- Gold **must name the exported accepted decision and that decision's
  revision**. A gold that points at a proposed identity, a different decision,
  or a stale revision fails closed.
- **Package / task / snapshot / experiment** identities on decisions, gold
  history, and the comparison envelope must match the source experiment. The
  share-safe aliases stay `package-1` / `task-1` / `snapshot-1`; crossing raw
  identities between experiments is rejected before those constants are
  applied.
- Equivalent **bag reorders** of nested candidate lists, evidence refs,
  decisions, golds, traces/events, and comparison rows produce identical
  aliases and identical JSON. Candidate aliases still follow the stored
  candidate-matrix order (the experiment's package order).
- The same raw token used as a candidate id and as an evidence ref (and other
  namespaces) receives **distinct prefixed aliases** and never appears in the
  assembled JSON. Two experiments that reuse the same raw ids still export only
  aliases.
- Stale, contradictory, duplicate, missing, or dangling references fail closed.
- Unknown fields and tampered assembled exports (schema, omissions, caveats,
  gold revision/alias, planted leak strings / forbidden keys) fail
  `parseLabExportV2`.
- Model labels, usernames, free text, raw evidence ids / fingerprints,
  endpoints, tokens, filesystem paths, request ids, private content, and
  correlatable metadata (`createdAt`, `rawHash`, `milliseconds`, …) do not
  appear in `JSON.stringify` of a successful export.
- Required caveats and omission declarations remain exact
  (`EXPERIMENT_SHARE_SAFE_CAVEATS`, `TRACE_SHARE_SAFE_CAVEATS`,
  `LAB_SHARE_SAFE_CAVEATS`; every omission flag `false`).

## Mutation matrix

Projection rows call `projectExperimentLabExport`. Tamper rows clone a real
assembled export and call `parseLabExportV2`.

| Row | Drive | Expected |
| --- | --- | --- |
| happy path + round-trip `parseLabExportV2` | projector + parser | accepted decision, matching gold revision, exact caveats/omissions, no leak tokens |
| `proposed_only_omits_decision_and_gold` | projector | `decision`/`gold` null |
| `mixed_proposed_and_accepted_exports_only_accepted` | projector | accepted only; unused proposed id withheld |
| `equivalent_reorder_candidates_evidence_decisions_traces` | projector | identical JSON vs baseline |
| `identical_raw_ids_across_namespaces_do_not_collide` | projector | distinct prefixes; raw token withheld |
| two experiments, same raw ids | projector | aliases only; fingerprints/package ids withheld |
| `dishonest_predecessor_revision` | projector | `ContractViolation` |
| `gold_points_at_wrong_decision` | projector | `ContractViolation` |
| `gold_points_at_wrong_revision` | projector | `ContractViolation` |
| `crossed_package_identity` | projector | `ContractViolation` |
| `crossed_task_fingerprint` | projector | `ContractViolation` |
| `crossed_snapshot_fingerprint` | projector | `ContractViolation` |
| `crossed_experiment_identity` | projector | `ContractViolation` |
| `stale_gold_predecessor` | projector | `ContractViolation` |
| `contradictory_comparison_gold` | projector | `ContractViolation` |
| `duplicate_candidate_ids` | projector | `ContractViolation` |
| `missing_accepted_decision_for_gold` | projector | `ContractViolation` |
| `dangling_gold_evidence` | projector | `ContractViolation` |
| `dangling_trace_candidate` | projector | `ContractViolation` |
| `unknown_top_level_field` / `unknown_review_field` | parser | `ContractViolation` |
| `tampered_schema_id` | parser | `ContractViolation` |
| `tampered_omissions` | parser | `ContractViolation` |
| `tampered_caveats_missing` / `tampered_caveats_duplicate` | parser | `ContractViolation` |
| `tampered_gold_revision` / `tampered_gold_decision_alias` | parser | `ContractViolation` |
| `planted_leak_string` / `planted_forbidden_key` | parser | `ContractViolation` |

## Production repair

The matrix exposed real fail-open gaps on the named tip. Smallest corrections,
all inside the allowlist:

- `collab/contracts/src/trace.ts` — `parseLabExportV2` now requires
  `gold.acceptedDecisionRevision === decision.revision`.
- `collab/contracts/src/experiment.ts` — share-safe review parsing now requires
  honest decision predecessor chains, honest gold version/predecessor pairs,
  and unique alias arrays.
- `collab/server/src/modules/experiments/project.ts` — the projector now
  fail-closes on crossed package/task/snapshot/experiment identities, dangling
  or missing gold/decision/evidence/candidate refs, multiple accepted
  identities, and dishonest source revision chains; non-candidate aliases are
  seeded from sorted unique ids; bag output is canonicalized by alias.

## Non-claims

This lab does **not** prove:

- Signatures, checksums, or cryptographic provenance of an export
- Correctness of the human decision or of gold-as-truth
- Same-snapshot fairness across candidates or live runs
- That HTTP, UI, or store paths cannot assemble a dishonest source (those
  surfaces are out of scope here)

## Remaining operator-journey limitations

- The case-lead **Export** button, Fastify routes, and experiment store are not
  exercised by this lab. Service tests and e2e remain the operator-journey
  coverage.
- Candidate-matrix **row order** is the alias seed for `approach-*` (locked by
  existing package-order exports). Nested candidate lists and other bags are
  reorder-stable; reversing the stored matrix itself is a different
  presentation of the same ids.
- No live provider, no network, no Keychain, and no UI confirmation flow.

## Commands

From `collab/`:

```bash
npm test -w @cd-collab/server -- src/modules/experiments/share-safe-export.adversarial.test.ts
npm test -w @cd-collab/contracts
npm test -w @cd-collab/server
```
