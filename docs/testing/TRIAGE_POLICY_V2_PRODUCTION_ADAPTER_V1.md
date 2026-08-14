# Triage Policy V2 production adapter — contributor subset V1

Status: **provider-free production-path adapter; typed contributors (including
`timeline_analyst`) and the shared host resolver are implemented, while live
execution remains qualification-gated**

This slice bridges the exact, pure `TriagePolicyV2` compiler output to the
existing linked-log `ContributionRuntime`. It intentionally prepares only the
semantic overlap that the established runtime can execute without pretending
to support a richer V2 contract.

## Supported subset

- policy mode is `enhanced` or `advanced`;
- at least one contributor is configured and every configured slot is admitted;
- contributor roles are `observation_extractor`, `timeline_analyst`,
  `causal_proposer`, `contradiction_checker`, or `evidence_gap_finder`;
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
The resolver seam is shared by CLI and Tauri, but live Enhanced/Advanced
execution is currently fail-closed until a dedicated host-owned exact V2 role
qualification record exists. Provider-free policy validation may still use an
explicit preflight document; that document is never live execution authority.

## Typed pre-provider refusals

The adapter returns a content-free category and inert slot ids before it can
return any runnable backend when it sees:

- Standard mode (the established single-model path remains authoritative);
- a finalizer or reviewer (timeline analysis is now a typed contributor);
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
4. Standard, finalizer, reviewer, optional-dropout, identity, and deadline
   mismatches refuse before a runtime is returned; a qualified timeline role
   is admitted and remains typed throughout the runtime binding.

## Not proven / residual product blocker

- Tauri selects the shared resolver and emits validated events progressively;
  CLI live execution remains fail-closed until host-owned role qualification is
  available.
- Generic capability reports cannot authorize an exact V2 role. The next
  production step is a dedicated qualification record bound to profile,
  endpoint fingerprint, exact catalog model, protocol, and role kind.
- The host enforces governed corpus revision and rejects unsupported source
  restrictions instead of silently broadening the packet.
- A smaller per-contributor operation timeout, finalizer reserve, reviewer
  reserve/condition/requirement, and visible optional dropout still require
  additional host/runtime coverage.
- No provider, gateway, credential store, live corpus, or network was used.
- This does not establish live compatibility, usefulness, cost, release
  readiness, or full Triage Policy V2 execution.

Handbook impact: the Triage Policy V2 row remains **Partial** and now records
the exact contributor-only production overlap and its typed refusals.
