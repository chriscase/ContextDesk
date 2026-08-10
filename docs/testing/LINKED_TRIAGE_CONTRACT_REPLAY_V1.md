# Linked multi-stage contract / replay suite v1

**Branch:** `test/deepseek-linked-contract-replay-v1`  
**Base:** `7105dbef6907296c09c115d57aabf513a7288a7a`  
**Suite tip:** (feature commit containing `linked_triage_contract` + hermetic tests)  
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
| `cd_core::linked_triage_contract::normalize_known_json_wrapper` | Shared unwrap of complete `<think>`/`<analysis>`/`<reasoning>` + Markdown fences (used by multi-stage candidate + final comparison) |
| `preparation_for_host_validation` / `is_empty_visible_terminal` | Empty visible after reasoning strip → empty terminal (never success) |
| `LinkedTriageDiagnosticCategory` + classify_* helpers | Distinct categories for diagnostics |
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
cargo test -p cd-core --test linked_triage_contract_replay   # 21
cargo test -p cd-core --lib linked_triage_contract             # 4
cargo test -p cd-core --lib known_reasoning_and_fence          # 1
cargo test -p cd-core --lib candidate_assessment_accepts       # 1
cargo fmt --all -- --check
cargo clippy -p cd-core --all-targets -- -D warnings
```

## Mutations (6/6 invert-fail → restore-green)

| Contract | Result |
| --- | --- |
| Accept malformed JSON as Schema | fail → green |
| Leak reasoning into visible answer | fail → green |
| Merge candidate vs final categories | fail → green |
| Treat empty+reasoning as CompatibleSuccess | fail → green |
| Skip WrongScope fail-closed | fail → green |
| Treat tool-call channel as final answer | fail → green |

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
