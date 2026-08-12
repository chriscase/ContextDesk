# Adversarial quality-eval lane v1 (log-causality + diagnostic honesty)

Status: hermetic fixtures and deterministic scores only.  
**Does not prove** live-provider usefulness, readiness, or release fitness.

## What this lane is

An expansion of the existing OPEN quality-eval cage
(`fixtures/quality-eval/open-v1`, `cd_core::quality_eval`). It reuses:

- scripted candidates + host-only truth
- answer scorer dimensions and typed failure reasons
- retrieval metrics on frozen rankings
- production diagnostic category labels (`LinkedTriageDiagnosticCategory`)
- privacy / isolation scanners and share-safe export gates

It does **not** introduce a second HTTP client, agent loop, or parallel scorer.

## Case map (proves / does not prove)

| Case | Proves | Does not prove |
| --- | --- | --- |
| qe01–qe08 (prior) | Core citation, role, abstention, retrieval contracts | Live model quality |
| qe04 `mut_live_role_confusion` | Valid cause cannot mask symptom-as-trigger or independent demotion | Production triage rubric parity for independent demotion |
| **qe09-attempt-usefulness** | Mixed pass/fail attempt rows cannot claim universal success; all-failed cannot claim useful | Empirical attempt rates on a gateway |
| **qe10-grounding-vs-transport** | Timeout/auth/transport must not be reported as host-grounding refusal | That every product surface uses these labels |
| **qe11-tool-progress** | Progress requires citeable hits; repeated non-progress requires withdrawal | That every tool kind is enumerated |
| **qe12-multimodel-budget** | Required roles cannot be silently dropped; budget exhaustion cannot claim useful | Live multi-model scheduling quality |
| **qe13-chronology-contradiction** | Recovery-as-trigger fails; asserting cause while stating abstention fails | Full temporal graph reasoning |
| **qe14-retrieval-ablation** | Keyword/dense/hybrid/rerank lane labels + foreign-identity decoy rejection on frozen lists | Real embedder/reranker rankings or employer model IDs |

## Diagnostic envelope

Candidates may attach an optional `diagnostic` object (attempts, tool steps,
roles, budget flag, reported category, usefulness policy, export sample).
Host truth may attach matching `diagnostic` expectations. When truth is absent,
diagnostic dimensions are not scored (existing answer-only cases unchanged).

## Matrix summary

`matrix_summary_lines(record)` emits a deterministic TSV:

```text
case_id  candidate_id  expected  actual_passed  expectation_met  failed_dimensions  reasons
```

The matrix is pure: it cannot invent a pass the scorer did not emit.

## Mutations killed (typed reasons)

| Mutation | Dimension | Reason |
| --- | --- | --- |
| `mut_claims_all_succeeded` | `attempt_usefulness` | `dishonest_attempt_usefulness` |
| `mut_useful_when_all_failed` | `attempt_usefulness` / establishable recall | fail-closed |
| `mut_timeout_as_grounding` | `transport_versus_grounding` | `transport_mislabeled_as_grounding` |
| `mut_zero_cite_progress` | `tool_citeable_evidence` | `tool_zero_citeable_evidence` |
| `mut_non_progress_no_withdraw` | `tool_non_progress_withdrawal` | `tool_non_progress_without_withdrawal` |
| `mut_role_dropped_silent` | `multi_model_role_coverage` | `role_dropout_without_budget` |
| `mut_budget_claimed_useful` | `host_budget_honesty` | `budget_exhaustion_claimed_useful` |
| `mut_contradictory_abstention` | `cause_abstention_consistency` | `contradictory_cause_abstention` |
| `mut_live_role_confusion` | `cause_versus_symptom` + independent separation | `symptom_promoted_to_trigger` / demotion |
| `mut_foreign_identity` (qe14) | forbidden/decoy dimensions | fail-closed |
| Prior open-v1 mutations | (unchanged) | existing typed reasons |

## Privacy / share-safety

- Runtime/truth fixtures reject credential and home-path shapes at load.
- Diagnostic `export_text` is scored for share-safety when host truth requires it
  (no `sk-`/`bearer`/`/users/`, no `raw_body` / `authorization:` markers).
- Run-record export still gates through `gate_export_text`.

## Commands

```bash
export CARGO_TARGET_DIR=/path/to/ContextDesk/target   # shared target if worktree
cargo test -p cd-core --test quality_eval_lab
cargo test -p cd-core --lib quality_eval
cargo test -p cd-cli --test eval_cli
cargo fmt -p cd-core -- --check
cargo clippy -p cd-core --all-targets -- -D warnings
```

## Gaps / residuals

- Production `triage_quality` independent-incident demotion still lacks a host-truth
  equivalent of quality-eval's independent separation (tracked separately).
- Diagnostic honesty is fixture-scripted, not a live gateway diagnosis.
- Retrieval ablation lane labels are informational; ranking fail-closed rules
  remain the authority for retrieval metrics.
- No live provider, Keychain, or readiness-store writes.
