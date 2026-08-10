# Linked multi-stage contract / replay suite v1

**Branch:** `test/deepseek-linked-contract-replay-v1`  
**Base:** `7105dbef6907296c09c115d57aabf513a7288a7a`  
**Suite tip:** `dc49a9187d12e1c21149b7f796164ea8122e4eef`  
**Production code changed:** **yes** (shared normalizer + diagnostic categories; agent uses them)

## Purpose

Close the remaining DeepSeek-class **linked-triage** blocker hermetically: prove
OpenAI-compatible response variants (reasoning wrappers, fences, empty
visible+telemetry, malformed JSON, scope/duplicate fail-closed, correction,
tool vs final channels) through the **production** multi-stage parse/validate
path — no second HTTP client, no live gateway, no model-id special-casing.

## Production surface

| Symbol | Role |
| --- | --- |
| `cd_core::linked_triage_contract::normalize_known_json_wrapper` | Shared unwrap of complete `<think>`/`<analysis>`/`<reasoning>` + Markdown fences |
| `preparation_for_host_validation` / `is_empty_visible_terminal` | **Wired into multi-stage comparison** before `validate_model_answer`; empty → `EmptyTerminalAnswer` (not `Parse`) |
| Candidate stage empty check | Sets `validation_category=empty_terminal_answer` on host events when reasoning-only |
| `MultiStageTriageOutcome::{FailedClosed,Completed}.diagnostic_category` | Host-authoritative category on the production terminal |
| `investigation_answer::validate_model_answer` | Host-owned evidence/role/revision/citation authority |

## Variant coverage (hermetic)

| Variant | Proof |
| --- | --- |
| Bare candidate/final JSON | `bare_candidate_json_validates_on_production_path` |
| Fenced JSON | `fenced_json_unwraps_then_validates` |
| `<think>` / `<analysis>` / `<reasoning>` + JSON | `think_*`, `analysis_*`, `reasoning_tag_*` |
| Empty visible + reasoning telemetry | `empty_visible_with_reasoning_telemetry_is_empty_terminal` |
| Malformed JSON | `malformed_json_fails_closed_*` |
| Duplicate claim IDs | `duplicate_claim_ids_fail_closed` |
| Wrong candidate/evidence scope | `wrong_candidate_evidence_scope_fails_closed` |
| Valid candidate then invalid final | `valid_then_invalid_final_comparison_classified_distinctly` |
| Bounded correction success/failure | `successful_bounded_correction_*`, `correction_exhausted_*` |
| Tool-call vs final-answer channels | `tool_call_shaped_payload_*`, `final_answer_channel_*` |

## Commands / counts

```text
cargo test -p cd-core --test linked_triage_contract_replay              # 21
cargo test -p cd-core --lib linked_triage_contract                        # 4
cargo test -p cd-core --lib multi_stage_empty_reasoning_only_comparison  # 1 (production loop)
cargo test -p cd-core --lib multi_stage_candidate_empty_terminal         # 1 (production loop)
cargo test -p cd-core --lib multi_stage_uses_one_semantic_correction     # 1 (SuccessfulBoundedCorrection)
cargo test -p cd-core --lib multi_stage_outcome_classifier               # 1 (timeout/transport)
cargo test -p cd-workflow --lib                                           # 80
cargo test -p cd-cli                                                      # full package exit 0
cargo fmt --all -- --check
cargo clippy -p cd-core --all-targets -- -D warnings
```

## Mutations (6/6 production-guard invert-fail → restore-green)

| Production guard inverted | Result |
| --- | --- |
| Candidate empty-terminal `continue` | fail → green |
| Comparison empty → invent Parse instead | fail → green |
| `validate_model_answer` WrongScope check | fail → green |
| Ledger `WrongRevision` construction check | fail → green |
| Collapse empty diagnostic to FinalComparisonFailure | fail → green |
| `preparation_for_host_validation` empty reject | fail → green |

## Readiness for one later bounded live Vercel rerun

**Hermetically ready as a pre-flight contract suite:** wrappers, empty terminals,
and fail-closed ledger validation are proven on the production path without live
calls. A subsequent live Vercel/DeepSeek-class rerun can rely on these categories
but is **out of scope** of this branch (no network/Keychain here).

**Not release-complete** from this suite alone.

## Residuals

- Full multi-stage loop (`run_multi_stage_broad_triage`) remains private; this
  suite drives the public production normalizer + ledger validator the loop
  already calls. End-to-end private-loop orchestration is covered by existing
  agent unit tests with scripted backends.
- Transport/timeout categories are classified from host facts (no live stall
  fixtures in this lane beyond existing agent/deadline tests).
- No live Vercel, employer gateway, Keychain, or DeepSeek model-id branching.

## Non-goals confirmed

- No PR; no live calls; no desktop UI redesign; no provider hard-coding.
