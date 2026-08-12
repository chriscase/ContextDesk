# Triage Policy V2 adversarial audit v1

**Branch:** `test/triage-policy-v2-adversarial-audit-v1`  
**Base SHA:** `2ba4a08dcca0feaaefe65eb89614103fb06ad294`  
**Audit HEAD:** *(fill at commit time via `git rev-parse HEAD`)*  
**Attestation:** hermetic only — no live gateways, credentials, Keychain, or network provider I/O.

## Scope

Prove semantic-bypass classes fail closed on **shipped** seams:

| Seam | Entry point |
| --- | --- |
| Pure compiler | `compile_triage_policy_v2` |
| Contribution runtime | `run_contribution_pipeline` |
| Production adapter subset | `prepare_v2_contribution_runtime` |
| SDK replay / share-safe | `TriageReplayV1` / `ShareSafeTriageResultV2` / `TriageRunEventV2` |
| Workflow mock graph | `MockTriageRunner` |

No second protocol, fake multi-model stack, or private `CARGO_TARGET_DIR`.

## Canonical graph vs shipped path

Design order:

> host packet → contributors → preliminary reconciliation → conditional reviewer → final reconciliation → optional finalizer → host validation → ≤1 correction → terminal

| Stage | Shipped coverage | Residual |
| --- | --- | --- |
| Host packet | Host-authored packet / MockPacket | — |
| Contributors | compile + contribution pipeline + mock roles | — |
| Preliminary recon | `reconcile_contributions` after contributor phase; mock emits `Reconciliation` | — |
| Conditional reviewer | **pipeline** second phase after escalation; routing requires reviewer final | Production adapter **rejects** reviewer |
| Final recon after reviewer | pipeline re-reconciles when reviewer runs | Mock emits **one** recon after all slots |
| Optional finalizer | compile admits; mock runs as sequential slot | Production adapter **rejects**; no dual-recon finalizer orchestration on production path |
| Host validation + one correction | multi-model V1 pipeline exists separately | **Not** wired as full V2 terminal graph in production adapter |
| Terminal | pipeline outcome / replay terminal | — |

## Mutation table

| ID | Bypass class | Entry point | Expected | Result |
| --- | --- | --- | --- | --- |
| M1 | Same ModelRef as false independent consensus | `compile_triage_policy_v2` | `distinct_model_refs == 1` for identical refs | **Pass** (`m1_*`) |
| M2 | Stale/mismatched qualification; hidden model sub | compiler preflight binding | `PreflightBindingMismatch` / `QualificationUnavailable` | **Pass** (`m2_*`) |
| M3 | Required-role failure → silent success | compiler | compile Err + `RequiredRejected` | **Pass** (`m3_*`) |
| M4 | Optional dropout erased | compiler | `OptionalDegraded` retained | **Pass** (`m4_*`) |
| M5 | Phase/call/reserve oversubscription | compiler budget | `ProviderCallBudgetInsufficient` / `InvalidBudget` | **Pass** (`m5_*`) |
| M6 | Reviewer before recon / without escalation | `run_contribution_pipeline` | `NotAdmitted` + `ReviewerNotRequired`; no provider start | **Pass** (`m6_*`) |
| M7 | Reviewer not final plan slot | `ContributionRoutingPlan::new` | `ReviewerNotFinal` | **Pass** (`m7_*`) |
| M8 | Unqualified slot → success | pipeline qualification gate | `Unavailable` + 0 provider rounds | **Pass** (`m8_*`) |
| M9 | Cancel race leaves later slots successful | pipeline cancel | all `Cancelled`, 0 rounds | **Pass** (`m9_*`) |
| M10 | Reordered slots | pipeline `validate_slots` | `slot_order_mismatch` before calls | **Pass** (`m10_*`) |
| M11 | Reordered / post-terminal events | `TriageReplayV1::validate` | `NonContiguousSequence` / `EventAfterTerminal` | **Pass** (`m11_*`) |
| M12 | Missing / multi terminal | replay | `TerminalCount(0)` | **Pass** (`m12_*`) |
| M13 | Owner-only leak into share-safe | event validate | `PrivacyLeak` for Completed + model under ShareSafe | **Pass** (`m13_*`) |
| M14 | Reason-code duplicates / overflow | result / share-safe validate | reject duplicates | **Pass** (`m14_*`) |
| M15 | Malformed path-shaped attempt ids | `TriageRoleAttemptV1::validate` | reject | **Pass** (`m15_*`) |
| Graph | Ordered contributors → host answer | pipeline | starts + attempts; no fabricated root cause | **Pass** (`ordered_contributor_graph_*`) |
| M-A1 | Finalizer approximated in production | `prepare_v2_contribution_runtime` | `FinalizerUnsupported` | **Pass** (`ma1_*`) |
| M-A2 | Reviewer approximated in production | adapter | `ReviewerUnsupported` | **Pass** (`ma2_*`) |
| M-A3 | Backend ModelRef substitution | adapter | `BackendBindingMismatch` | **Pass** (`ma3_*`) |
| M-A4 | Degraded optional omitted as success | adapter | `DegradedSlotUnsupported` | **Pass** (`ma4_*`) |
| M-A5 | Ordered mock graph before terminal | `MockTriageRunner` | started→packet→…→recon→validation→one terminal | **Pass** (`ma5_*`) |

### Fail-then-restore

No production bypass was proven that required a code fix on this base. Each mutation is an **invert-style fail-closed assertion** against the real entry point (adversarial input → typed refusal). Existing unit/integration tests already cover many of the same guards; this suite labels them as an audit matrix.

## Residual gaps (honest)

1. **Full design graph (finalizer after dual recon + host validation + one correction)** is **not** executed by `prepare_v2_contribution_runtime` (finalizer/reviewer unsupported). Mutations for “finalizer before recon” on the production adapter therefore refuse at admission rather than exercising a mis-ordered executor.
2. **`MockTriageRunner`** schedules finalizer/reviewer as sequential `RoleAttempt` slots **before** a single reconciliation event — it is a contract/stream seam, not a full multi-phase production orchestrator.
3. **Parallel V2 execution / adaptive routing** out of scope.
4. **Live provider** timeout races beyond cooperative cancel flags not claimed.

## Tests run

```bash
cargo test -p cd-core --test triage_policy_v2_adversarial_audit -- --nocapture
# 16 passed

cargo test -p cd-workflow --test triage_policy_v2_adversarial_audit -- --nocapture
# 5 passed

# Related pre-existing (optional regression)
cargo test -p cd-core --lib multi_model::triage_policy -- --nocapture
cargo test -p cd-core --test triage_sdk_contract_v2 -- --nocapture
cargo test -p cd-workflow --test triage_policy_production_adapter -- --nocapture
```

| Suite | Count |
| --- | --- |
| `triage_policy_v2_adversarial_audit` (cd-core) | **16** |
| `triage_policy_v2_adversarial_audit` (cd-workflow) | **5** |
| **New audit total** | **21** |

## Files

- `crates/cd-core/tests/triage_policy_v2_adversarial_audit.rs`
- `crates/cd-workflow/tests/triage_policy_v2_adversarial_audit.rs`
- `docs/testing/TRIAGE_POLICY_V2_ADVERSARIAL_AUDIT_V1.md` (this note)

## Non-claims

- Not release-ready; no PR/merge.
- No production behavior change unless a future mutation proves a real bypass.
- Adaptive latency learning / Enhanced UI wiring out of scope.
