# Adversarial triage-runtime hardening — P0 fix

**Code SHA:** `87af3e8e72aa99630a734711965e867b746e22ca`
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
- `cargo test -p cd-workflow --lib triage_production_runner` — 9 passed
- `cargo test -p cd-workflow --lib triage_role_qualification` — 4 passed
- `cargo test -p cd-workflow --test triage_policy_production_adapter` — 5 passed
- `cargo test -p cd-cli --test gateway_diagnose` — 17 passed

The full workspace and a new exact-SHA live Vercel diagnostic remain required
before acceptance. The earlier Vercel report is historical for the preceding
code SHA.

## Follow-up status

The first five lifecycle/authority follow-ups are now implemented and covered
by focused tests: qualification cancellation is joined before cleanup, stalled
non-stream requests observe the cooperative token, generic hooks are checked
again after return, finalizer envelopes are independently bound to the host
ledger, and share-safe artifact references are relative rather than absolute.

Still open before a broad release claim: the provider-factory audit must cover
every optional transport (notably Ollama and embedding/rerank adapters) with
the same host-owned timeout, and a fresh exact-runtime live gateway diagnostic
must be run. These are bounded residuals, not evidence that the primary
OpenAI-compatible path is unusable.
