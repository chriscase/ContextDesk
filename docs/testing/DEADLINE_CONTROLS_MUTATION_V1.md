# Deadline controls mutation / adversarial lab v1

Hermetic, provider-free audit of `feat/deadline-controls-v1` @
`d52cecff6a25ee6c5ed9190069bf4010f82f015c`, recorded on branch
`test/deadline-controls-mutation-v1`.

## Scope

- Duration parse/format and policy helpers (`cd_core::deadline_controls`,
  desktop `deadlineControls.ts`)
- Saved-policy precedence and per-turn CLI override (never persists)
- Legacy `deadline_is_explicit` migration
- `config deadline` show/auto/set atomicity and safe output
- Host budget propagation
- GUI Auto/Standard/Patient/Custom + invalid draft non-write

**Out of scope:** live gateways, credentials, provider transport, diagnostic
suite, multi-stage budget math.

## Production fix proven by this lane

Rust previously accepted **internal whitespace** between magnitude and unit
(e.g. `"90 s"`) by trimming the unit slice, while TypeScript required
adjacency (`/^(\d+)(ms|s|m)$/i`). That parity gap is closed: Rust now requires
the unit immediately after digits (outer whitespace still allowed).

## Commands run

```bash
# Isolation
git rev-parse HEAD   # d52cecff… at start
git checkout -B test/deadline-controls-mutation-v1 d52cecff6a25ee6c5ed9190069bf4010f82f015c

# Focused Rust
cargo test -p cd-core --lib deadline_controls -- --nocapture
cargo test -p cd-cli --bins deadline -- --nocapture
cargo test -p cd-cli --bins turn_override -- --nocapture
cargo test -p cd-cli --test deadline_controls -- --nocapture

# Desktop
(cd desktop && npx vitest run src/lib/deadlineControls.test.ts \
  src/components/settings/DeadlineControls.test.tsx)
(cd desktop && npm run typecheck)

# Gates
cargo fmt --all -- --check
cargo clippy -p cd-core -p cd-cli --all-targets -- -D warnings
```

## Test counts (green)

| Suite | Count |
| --- | --- |
| `cd-core` `deadline_controls` unit | **11** passed |
| `cd-cli` bins (deadline-related filter) | **5** + **1** host override = **6** passed |
| `cd-cli` `--test deadline_controls` | **11** passed |
| Desktop Vitest (deadline lib + controls) | **18** passed |
| Desktop typecheck | pass |
| fmt / clippy (cd-core, cd-cli) | pass |

## Invariant coverage map

| Invariant | Proof |
| --- | --- |
| Accept units/bounds/outer whitespace/case | Rust `adversarial_accept_matrix_*`; TS ACCEPT matrix |
| Reject signs, decimals, zero, internal space, mixed units, Unicode junk, overflow, OOR | Rust `adversarial_reject_matrix_*`; TS REJECT matrix |
| No silent clamp of OOR | Rust `never_silently_clamps_*`; TS same |
| Per-turn override > explicit > adaptive; override not persisted | Rust `saved_policy_precedence_*`; adapters host tests |
| Legacy missing `deadline_is_explicit` → explicit | Rust serde test; CLI process test |
| `set`/`auto` only deadline fields; invalid leaves bytes identical | CLI integration tests |
| `show` JSON has no secrets/paths/endpoints/profile ids | CLI leak test with decoy profile in AppConfig |
| GUI invalid draft keeps last valid; Auto preserves ms | DeadlineControls + deadlineControls tests |
| Host override does not leak to next host | `turn_override_beats_saved_explicit_*` |

## Bounded mutation check

Temporarily inverted production invariants, re-ran the matching test, restored.

| Mutation | Expected | Result |
| --- | --- | --- |
| `parse_deadline_duration` accepts OOR (`Ok(ms)` instead of `Err`) | `never_silently_clamps_*` fails | failed then restore green |
| `apply_auto_policy` zeros `deadline_ms` | `auto_preserves_numeric_value` fails | failed then restore green |
| `apply_explicit_deadline_ms` writes before OOR reject | `explicit_custom_and_turn_override` fails | failed then restore green |
| GUI `applyPreset` uses OOR `customMs` without range guard | `out-of-range customMs keeps last valid` fails | failed then restore green |

## Changed-file summary (vs base)

```
crates/cd-core/src/deadline_controls.rs   # parity fix + adversarial unit tests
crates/cd-cli/src/adapters.rs             # host precedence test
crates/cd-cli/tests/deadline_controls.rs  # process-level atomicity/leak/migration
desktop/src/lib/deadlineControls.test.ts  # TS adversarial matrices + OOR keep-last
desktop/src/components/settings/DeadlineControls.test.tsx
docs/testing/DEADLINE_CONTROLS_MUTATION_V1.md
```

## Remaining gaps

- Full workspace `cargo clippy --workspace` / full desktop `npm test` matrix not
  re-run here (focused gates only).
- Process-level proof that invalid `--deadline` performs zero Keychain syscalls
  is structural (early parse before `secret_store()`); not ptrace-instrumented.
- Adaptive *latency learning* remains future work (product non-goal).
- Internal multi-stage phase allocation is intentionally not re-audited.

## No secrets / endpoints in artifacts

New tests and this document contain only synthetic decoy hostnames used to
assert **absence** from deadline show output. No credentials, private paths, or
live endpoints are exercised or required.
