# Adversarial triage-runtime hardening — P0 fix

**Code SHA:** `dfa47be793d5eadec48b62f78a2ef6e6ccc73b24`
**Branch:** `integrate/triage-policy-sdk-v2`  
**Scope:** provider-free production-path hardening; no live compatibility claim

## Finding

The V2 production resolver previously converted typed-contribution runtime
preparation errors to `None` with `.ok()`. A rejected TimelineAnalyst runtime
could therefore fall through to the generic role path instead of failing closed.
That violated the typed-role contract and could present a non-typed result as a
successful V2 triage path.

## Fix

- propagate policy and unsupported-adapter errors from
  `prepare_v2_contribution_runtime`;
- align host-owned remaining whole-turn budget with phase operation caps before
  preparing the typed runtime;
- preserve the typed contribution runtime for long explicit deadlines;
- add regression tests for rejection and successful host-aligned preparation.

## Verification

- `cargo fmt --all -- --check` — pass
- `cargo clippy -p cd-workflow --all-targets -- -D warnings` — pass
- `cargo test -p cd-workflow --lib triage_production_runner` — 11 passed
- `cargo test -p cd-workflow --lib triage_role_qualification` — 4 passed
- `cargo test -p cd-workflow --test triage_policy_production_adapter` — 5 passed
- `cargo test -p cd-cli --test gateway_diagnose` — 17 passed

The full workspace and a new exact-SHA live Vercel diagnostic remain required
before acceptance. The earlier Vercel report is historical for the preceding
code SHA.

## Follow-up status

The lifecycle/authority follow-ups are implemented and covered by focused
tests: qualification cancellation is joined before cleanup, stalled non-stream
requests observe the cooperative token, generic hooks are checked again after
return, finalizer envelopes are independently bound to the host ledger,
late interruption is rechecked before and after terminal construction, and
share-safe artifact references are relative rather than absolute. CLI
turn-owned retrieval now preserves adaptive defaults while using the explicit
whole-turn deadline for configured embedding/rerank roles.

Provider setup/authentication is now arbitrated by the remaining whole-turn
budget and the final runner budget is recomputed after setup. A backend
factory's synchronous DNS/client construction cannot be forcibly interrupted
until the factory exposes an async cancellation contract; it now fails closed
before and after setup rather than handing a stale budget to the runner. A
fresh exact-runtime live gateway diagnostic must still be run. These setup and
live-provider checks are not evidence that the primary OpenAI-compatible path
is unusable. CLI and desktop configured retrieval roles now share the same
explicit-vs-adaptive timeout selection. Exact-role qualification setup and its
synthetic probe share one turn-owned deadline; contributor qualification
rechecks cancellation before publishing. Exact-role finalizer probes credit a
dispatched-or-raced operation conservatively and recheck cancellation before
publishing qualification. Generic provider attempts use a fresh correction
timeout bounded by remaining turn time and the correction phase cap, compare
correction calls against a correction-local counter, and credit failed/timeout
operations on every post-call interruption path.
