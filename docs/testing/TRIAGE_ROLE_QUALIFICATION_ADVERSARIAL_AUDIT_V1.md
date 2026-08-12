# Triage Policy V2 exact-role qualification — adversarial audit v1

**Branch:** `test/triage-policy-v2-qualification-adversarial-audit-v1`  
**Base SHA:** `a05d5dcba0b9b772d7ad8d0d29140fd40dac16bc` (`integrate/triage-policy-sdk-v2`)  
**Audit HEAD (branch tip):**  (verify: 5bf258492553b09c3ea79f0e3657beb643f7e939 on this branch).
**Attestation:** hermetic only — no network, credentials, Keychain, live corpus, or provider HTTP.

## Scope

Ship-path entry points under audit:

| Seam | Entry point |
| --- | --- |
| Exact-role probe | `cd_workflow::triage_role_qualification::qualify_role_v2_with_backend` |
| Configured wrapper | `qualify_configured_role_v2` (identity + backend construction; not live-called here) |
| Shared preflight | `cd_workflow::triage_host::preflight_for_policy` |
| Persist boundary | `cd_core::triage_role_qualification::TriageRoleQualificationStoreV1` |
| CLI refuse | `cd-cli` `load_live_v2_preflight` → `caller_preflight_not_authoritative` |
| Tauri shared path | `triage_preflight_for_policy` → `preflight_for_policy` |

## Production fix proven by this audit

**Finalizer cancel was ignored.** `qualify_with_backend` passed `None` into
`complete_once` for finalizers, so a pre-set cancel flag could still yield
`Qualified` if the ScriptedBackend returned a valid body. Fix:

1. Short-circuit any kind when cancel is already true (0 calls, `Unqualified`).
2. Pass the real cancel flag into finalizer `complete_once`; cancelled → 0 call credit.

## Mutation table (invert → fail → restore)

Method: for each guard, the adversarial test encodes the inverted behavior as the
failing assertion (e.g. “must be Unqualified”). Temporarily inverting production
guards during development killed the tests; restored guards pass. No surviving
critical guard in the table.

| ID | Guard class | Entry | Kill test | Result |
| --- | --- | --- | --- | --- |
| Q1 | Contributor qualifies only via contribution pipeline | `qualify_role_v2_with_backend` | `q1_valid_contributor_*` | **Killed** |
| Q2 | Finalizer qualifies only via host packet validator | same | `q2_valid_finalizer_*` | **Killed** |
| Q3a | Wrong schema | pipeline validate | `q3_wrong_schema_*` | **Killed** |
| Q3b | Wrong role | pipeline validate | `q3_wrong_role_*` | **Killed** |
| Q3c | Stale packet | pipeline validate | `q3_stale_packet_*` | **Killed** |
| Q3d | Foreign candidate/evidence | pipeline + finalizer hook | `q3_foreign_*` | **Killed** |
| Q3e | Malformed JSON / reasoning wrapper | pipeline | `q3_malformed_*` | **Killed** |
| Q4 | TimelineAnalyst / Reviewer zero provider calls | early refuse | `q4_timeline_and_reviewer_*` | **Killed** |
| Q5a | Pre-cancel never qualifies; 0 calls | cancel short-circuit | `q5_pre_cancel_*` + unit | **Killed** (after fix) |
| Q5b | Deadline never qualifies | finalizer timeout | `q5_deadline_*` | **Killed** |
| Q6 | Exact profile/model/endpoint/protocol/role isolation | store + preflight | `q6_exact_identity_*` | **Killed** |
| Q7 | Persisted record privacy/bounds | store save/validate | `q7_persisted_*` | **Killed** |
| Q8a | No generic capability credit | `preflight_for_policy` | `q8_preflight_ignores_*` | **Killed** |
| Q8b | CLI refuses caller preflight | source + path | `q8_cli_source_*` | **Killed** (structural) |
| Q8c | Tauri uses shared preflight | source | `q8_tauri_host_*` | **Killed** (structural) |
| FIX | Finalizer cancel flag honored | production | unit `pre_cancel_blocks_finalizer_*` | **Killed** |

## Residual gaps

1. **`qualify_configured_role_v2` live credential path** is not executed hermetically (would require Keychain/profile secrets). Identity refuse for Timeline/Reviewer before backend construction is covered; full backend construction remains residual.
2. **Mid-flight cancel after provider has already started** may still report `physical_provider_calls = 1` on finalizer timeout path — honest upper bound, not a free success.
3. **Desktop Enhanced UX** not exercised end-to-end; only shared Tauri helper wiring is structural.
4. **Generic capability store** is proven unused by empty exact-role store → Unverified; there is no separate “inject capability report into preflight” API on this SHA to invert.

## Tests run

```bash
cargo test -p cd-workflow --test triage_role_qualification_adversarial_audit -- --nocapture
# 15 passed

cargo test -p cd-workflow --lib triage_role -- --nocapture
# includes finalizer cancel unit

cargo test -p cd-core --lib triage_role -- --nocapture
# 3 passed (store isolation / bounds / save-load)
```

| Suite | Count |
| --- | --- |
| `triage_role_qualification_adversarial_audit` | **15** |
| workflow `triage_role*` lib units | **≥4** (incl. cancel) |
| core store units | **3** |

## Files

- `crates/cd-workflow/src/triage_role_qualification.rs` — cancel short-circuit + finalizer cancel honor
- `crates/cd-workflow/tests/triage_role_qualification_adversarial_audit.rs` — audit suite
- `docs/testing/TRIAGE_ROLE_QUALIFICATION_ADVERSARIAL_AUDIT_V1.md` — this note

## Non-claims

- Not release-ready; no PR/merge.
- No live gateway runs.
