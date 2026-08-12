# Triage Policy V2 exact-role qualification — adversarial audit v1

**Branch:** `test/triage-policy-v2-qualification-adversarial-audit-v1`
**Base SHA:** `a05d5dcba0b9b772d7ad8d0d29140fd40dac16bc` (`integrate/triage-policy-sdk-v2`)
**Tests content commit:** `3042c6a3a081c07d9be956d15cddf35ac98e80ec` (exact-role probe suite + cancel fix)
**Branch tip:** `4000e0ba8f0fa72aeb96c582b67dee415a27f4c2`
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

Method: each critical production guard was inverted in-tree, the matching hermetic
test was run (expect fail), the guard was restored, and the test re-run (expect
pass). Full transcripts: audit evidence `mutations.log`.

| ID | Guard class | Invert | Kill test | Under mutation | Restore |
| --- | --- | --- | --- | --- | --- |
| M1 | Pre-cancel short-circuit | `if false && cancel` | `q5_pre_cancel_*` | **FAILED** | **PASS** |
| M2 | TimelineAnalyst refuse | `if false && matches!(Timeline…)` | `q4_*` | **FAILED** | **PASS** |
| M3 | Reviewer refuse | `if false && matches!(Reviewer)` | `q4_*` | **FAILED** | **PASS** |
| M4 | Contributor Qualified credit | `if false && completed` | `q1_*` | **FAILED** | **PASS** |
| M5 | Store exact-key `get` | match profile+model only | `exact_identity_*` | **FAILED** | **PASS** |
| M6 | Finalizer cancel + short-circuit | `complete_once(..., None)` and disable short-circuit | `q5_pre_cancel_*` | **FAILED** (got Qualified) | **PASS** |
| Q1–Q8 | Objective suite (non-inverted) | n/a | adversarial suite | n/a | **15 PASS** |

All six inverted critical guards **killed**. No surviving Qualified-credit bypass.

## Residual gaps

1. **`qualify_configured_role_v2` live credential path** is not executed hermetically (would require Keychain/profile secrets). Identity refuse for Timeline/Reviewer before backend construction is covered; full backend construction remains residual.
2. **Mid-flight cancel after provider has already started** may still report `physical_provider_calls = 1` on finalizer timeout path — honest upper bound, not a free success.
3. **Desktop Enhanced UX** not exercised end-to-end; only shared Tauri helper wiring is structural.
4. **Generic capability store** is proven unused by empty exact-role store → Unverified; there is no separate "inject capability report into preflight" API on this SHA to invert.

## Tests run

```bash
cargo test -p cd-workflow --test triage_role_qualification_adversarial_audit -- --nocapture
# 15 passed

cargo test -p cd-workflow --lib triage_role -- --nocapture
# 4 passed (incl. pre_cancel_blocks_finalizer_*)

cargo test -p cd-core --lib triage_role -- --nocapture
# 3 passed (store isolation / bounds / save-load)

cargo test -p cd-workflow --lib shared_preflight -- --nocapture
# 1 passed
```

| Suite | Count |
| --- | --- |
| `triage_role_qualification_adversarial_audit` | **15** |
| workflow `triage_role*` lib units | **4** |
| core store units | **3** |
| host shared preflight unit | **1** |
| **Total focused** | **23** |

## Gates (evidence in gates.log)

- `cargo fmt --all -- --check` → exit 0
- `cargo clippy -p cd-core -p cd-workflow --all-targets -- -D warnings` → exit 0
- `git diff --check` (working tree) → exit 0
- `git diff --check a05d5dcb..HEAD` → exit 0

## Files

- `crates/cd-workflow/src/triage_role_qualification.rs` — cancel short-circuit + finalizer cancel honor
- `crates/cd-workflow/tests/triage_role_qualification_adversarial_audit.rs` — audit suite
- `docs/testing/TRIAGE_ROLE_QUALIFICATION_ADVERSARIAL_AUDIT_V1.md` — this note

## Non-claims

- Not release-ready; no PR/merge.
- No live gateway runs.
