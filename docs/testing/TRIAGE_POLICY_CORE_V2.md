# Triage Policy V2 pure-core foundation

Status: **partial implementation for issue #872; no runtime provider path is
wired by this change.**

## What this slice proves

`cd_core::multi_model::triage_policy` adds an I/O-free, provider-neutral policy
contract and compiler:

- Standard remains the one-model default; Enhanced and Advanced are explicit.
- Every role uses an exact gateway-scoped `ModelRef`.
- Contributors, finalizer, and conditional reviewer are separate phases.
- Required role failure rejects preflight; optional role failure remains a
  visible degraded slot.
- Whole-turn, provider-call, contributor, semantic-correction, finalizer, and
  reviewer budgets have distinct names and validation.
- V2 execution is sequential only.
- Public policy input is capped at 32 configured/preflight slots, 64 total
  provider calls, 4 million model-facing characters, and a one-hour deadline;
  terminal phases remain one call each.
- Same-model/multi-role assignments collapse into one independence group while
  role, exact-model, catalog-model, and gateway counts remain separate.
- Compiler failures carry only stable categories and slot ids. Contracts do not
  contain credentials, endpoints, prompts, raw provider bodies, or reasoning.
- A pure legacy migration helper maps already-resolved V1 identities without
  modifying `AppConfig` or selecting a new runtime path. Legacy qualification
  flags do not bypass V2's exact workflow/role qualification requirement.

## Focused verification

```text
cargo test -p cd-core --lib triage_policy
cargo test -p cd-core --lib model_ref
cargo fmt --all -- --check
cargo clippy -p cd-core --lib -- -D warnings
git diff --check
```

The adversarial tests cover missing/stale/failed qualification, egress denial,
required and optional dropout, duplicate and path-shaped slot ids, duplicate
preflight facts, unknown fields, unsupported parallel execution, overcommitted
budgets, terminal reserve exhaustion, exact namespaced model ids, and
same-model false-consensus accounting, plus oversized policy/budget refusal.

## What this slice does not prove

- No provider, gateway, credential, filesystem, CLI, GUI, Tauri, or server path
  calls this compiler yet.
- It does not execute finalization or conditional review.
- It does not change legacy single/review/contribution behavior or persisted
  configuration.
- It does not prove cancellation, replay, event parity, TypeScript parity, or
  live model usefulness.
- It does not implement retrieval policy, parallelism, adaptive routing, or
  automatic model selection.

Those remain follow-up acceptance criteria on issue #872. The extension-contract
lane is not a dependency of this slice: its combined synthesizer/reviewer role
and privacy semantics must be reconciled before selective integration.
