# Adversarial triage-runtime hardening — P0 fix

**Code SHA:** `c6cad48347cf8d85bbf358b2dfb7da45cf5cdfba`  
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

## Remaining adversarial follow-ups

- propagate cancellation into diagnostic qualification work and prove cleanup
  does not race an abandoned blocking task;
- add post-hook deadline/cancellation checks at the generic runner boundary;
- ensure role qualification and call-credit telemetry remain consistent on late
  cancellation and correction timeout;
- make Ollama's production factory use its timeout-aware constructor;
- preserve share-safe output when reporting artifact paths;
- update/verify role telemetry dialect fields if they are part of the public
  contract.
