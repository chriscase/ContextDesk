# Triage Policy V2 production adapter — contributor subset V1

Status: **provider-free production-path adapter; partial, not product wired**

This slice bridges the exact, pure `TriagePolicyV2` compiler output to the
existing linked-log `ContributionRuntime`. It intentionally prepares only the
semantic overlap that the established runtime can execute without pretending
to support a richer V2 contract.

## Supported subset

- policy mode is `enhanced` or `advanced`;
- at least one contributor is configured and every configured slot is admitted;
- contributor roles are `observation_extractor`, `causal_proposer`,
  `contradiction_checker`, or `evidence_gap_finder`;
- the trusted Rust host supplies one already-authorized production backend for
  every exact `(slot_id, profile_id, model_id)` binding;
- V2 and the host resolve the same finite whole-turn deadline;
- the V2 contributor operation cap is not smaller than that whole-turn deadline;
- the existing sequential contribution route can represent every call and
  context ceiling without widening it.

For that subset, the adapter returns the existing `ContributionRuntime`. The
linked triage path therefore continues to own:

- deterministic broad-triage brief and immutable packet assembly;
- neighborhood classification and exact evidence/candidate identities;
- production `ChatBackend` calls (no second HTTP client);
- shared cancellation and whole-turn deadline;
- contribution-schema validation and deterministic reconciliation;
- normal `MultiModelStage`, tool, answer, and terminal events;
- the established host renderer, history behavior, unbind, and cleanup.

The adapter does not read `AppConfig`, credentials, Keychain, protected files,
endpoints, qualification storage, corpora, or retrieval state. A trusted Rust
host resolves those facts first and supplies exact `RolePreflightV2` records
plus opaque authorized backends. The compiler remains the only policy compiler.

## Typed pre-provider refusals

The adapter returns a content-free category and inert slot ids before it can
return any runnable backend when it sees:

- Standard mode (the established single-model path remains authoritative);
- a timeline analyst, finalizer, or reviewer;
- an optional role dropout the current production event stream could omit;
- a missing, duplicate, extra, or exact-identity-mismatched backend;
- a host/V2 whole-turn deadline mismatch;
- a smaller per-contributor operation timeout the current runtime cannot honor;
- an unrepresentable or invalid routing/context bound.

This is deliberate. The existing contribution reviewer is not equivalent to
the V2 conditional reviewer: V2 also has requirement, reserve, and terminal
accounting semantics. The existing deterministic answer floor is not a model
finalizer. `timeline_analyst` is not aliased to another role.

## Hermetic proof

Run with compiler caching but an isolated target. The private target is
important: divergent worktrees must never share linked test binaries.

```bash
eval "$(scripts/local-build-cache.sh activate)"
export CARGO_TARGET_DIR=/private/tmp/contextdesk-triage-policy-production-adapter-target
cargo test -p cd-workflow --lib triage::tests
cargo test -p cd-workflow --test triage_policy_production_adapter
cargo test -p cd-core --lib multi_model
cargo fmt --all -- --check
cargo clippy -p cd-workflow --lib --tests -- -D warnings
```

The adapter test proves:

1. namespaced exact model ids survive compilation, adapter binding, production
   stage events, and validated attempts;
2. actual `run_contribution_pipeline` proposal validation and deterministic
   non-root answer rendering are reused;
3. the existing cooperative cancellation signal prevents every provider call
   and accounts every remaining role as cancelled;
4. Standard, timeline, finalizer, reviewer, optional-dropout, identity, and
   deadline mismatches refuse before a runtime is returned.

## Not proven / residual product blocker

- No CLI, Tauri, server, or SDK command selects this adapter yet.
- No host resolver yet constructs exact-role V2 preflight plus backend bindings
  from saved policy, qualification evidence, credentials, and provider config.
- The owner-only V2 request/event/result stream is not projected from the
  existing production contribution events.
- A smaller per-contributor operation timeout, finalizer reserve, reviewer
  reserve/condition/requirement, timeline role, and visible optional dropout
  still require production runtime/event work.
- No provider, gateway, credential store, live corpus, or network was used.
- This does not establish live compatibility, usefulness, cost, release
  readiness, or full Triage Policy V2 execution.

Handbook impact: the Triage Policy V2 row remains **Partial** and now records
the exact contributor-only production overlap and its typed refusals.
