# CI required checks and rulesets

This document is **configuration guidance for GitHub branch protection / rulesets**.
It does not change workflow behavior. The workflow in `.github/workflows/ci.yml`
already fail-closes on a missing test shard; a ruleset is what makes a check a
merge blocker.

The active `main: require Ubuntu aggregate` ruleset (id `20890073`) on
`chriscase/ContextDesk` requires exactly `rust tests (ubuntu aggregate)`.
That aggregate is the merge-blocking Ubuntu test gate; the warmup job
`rust (ubuntu-latest)` performs fmt, clippy, examples, smoke, and cache
population, but is not the Ubuntu suite or suite gate. The macOS/Windows
aggregates remain coverage signals and do not change that active requirement.

## What to require

The active ruleset currently enforces the Ubuntu aggregate named above. The
remaining rows are the project’s candidate checks and lane signals. This
document does not modify the ruleset or add the desktop aggregates to it.

These are the stable **check names** (the `name:` fields in
`.github/workflows/ci.yml`), not job ids. The active ruleset currently requires
only the Ubuntu aggregate named above.

| Check name | Why |
| --- | --- |
| `gitleaks` | Secret scan |
| `claim↔code guard` | Shipped-claim honesty |
| `close-proof discipline (#254)` | Close-comment SHA + proof |
| `GUI integration contracts (no WebDriver)` | GUI contract suite |
| `rust (ubuntu-latest)` | Ubuntu fmt, clippy, examples, smoke, **cache warmup** (not the suite) |
| `rust (macos-latest)` | macOS restore-only preflight: fmt, clippy, examples, smoke; not the suite gate. A separate conditional cache-writer runs `--no-run` only on a miss |
| `rust (windows-latest)` | Windows restore-only preflight: fmt, clippy, examples, smoke; not the suite gate. A separate conditional cache-writer runs `--no-run` only on a miss |
| `rust tests (ubuntu aggregate)` | Fail-closed Ubuntu workspace test gate |
| `rust tests (macos-latest aggregate)` | Fail-closed macOS workspace test gate (coverage signal, not in the ruleset) |
| `rust tests (windows-latest aggregate)` | Fail-closed Windows workspace test gate (coverage signal, not in the ruleset) |
| `tauri host (ubuntu-latest)` | Desktop host compile |
| `tauri host (macos-latest)` | Desktop host compile |
| `desktop ui (typecheck, lint, test, build)` | Desktop UI gate |

## What not to require (or require only as optional)

- **`rust tests (ubuntu shard 1)` … `shard N`** — useful signal, but the names
  encode the shard index. Raising `CD_SHARD_COUNT` would rename them. The
  aggregate job is the coverage gate: it fails if any shard is missing, failed,
  incomplete, or if any unit was not run.
- Do **not** keep requiring a check that used to mean “Ubuntu ran
  `cargo test --workspace` inside `rust (ubuntu-latest)`”. That job no longer
  executes the suite; requiring only `rust (ubuntu-latest)` would treat a
  skipped/failed shard matrix as irrelevant as long as fmt/clippy passed.
- `rust (ubuntu-latest)` is warmup and diagnostics only. It is intentionally
  absent from the Ubuntu suite-gate list above; require exactly
  `rust tests (ubuntu aggregate)` for that gate.
- **`rust (macos-latest)`** and **`rust (windows-latest)`** are restore-only
  preflights, not complete workspace-suite gates. Requiring one of them alone
  would not protect the corresponding shard aggregate.
- The macOS/Windows shard indexes are likewise signals. The per-OS aggregate
  is the stable coverage check; the active ruleset still requires only
  `rust tests (ubuntu aggregate)`.

## Shard matrix and cache boundaries

Workspace tests are sharded, then fail-closed:

| OS | Warmup check | Test shards | Aggregate check | Required on `main`? |
| --- | --- | --- | --- | --- |
| Ubuntu | `rust (ubuntu-latest)` (`--no-run` only) | 8 | `rust tests (ubuntu aggregate)` | **yes** — this is the only ruleset gate |
| macOS | `rust (macos-latest)` restore-only preflight | 4 | `rust tests (macos-latest aggregate)` | no |
| Windows | `rust (windows-latest)` restore-only preflight | 4 | `rust tests (windows-latest aggregate)` | no |

The planner (`scripts/ci_shard_plan.sh`) enumerates every `cargo test --workspace`
unit from `cargo metadata`. The aggregate recomputes that list and fails if any
unit is missing, duplicated, or left on a cancelled/timed-out shard.

Cache stores are per OS. rust-cache hashes `Cargo.lock`, rustc, and its
default env prefixes (`CARGO`, `CC`, `CFLAGS`, `CXX`, `CMAKE`, `RUST`).
`RUST` already matches `RUSTFLAGS`; the workflow does not override `env-vars`.
A restore is warm only when `target/` has compiled deps **and** a non-empty
DuckDB library artifact. See
[`docs/testing/MACOS_WINDOWS_CI_LANES.md`](testing/MACOS_WINDOWS_CI_LANES.md).

## Path-aware routing

For a Rust-touching PR, `rust tests (ubuntu aggregate)` runs the complete
fail-closed eight-shard workspace gate. A PR that changes only
`crates/cd-triage-bench/**` (or benchmark documentation) skips the eight
shards but keeps the same required check name and runs the complete
`cd-triage-bench` test suite in the aggregate job. A collaboration-only path
is routed only when no collaboration implementation is present; if source
appears before its dedicated validator exists, the aggregate fails closed.

## Triage fast lane (advisory, not a gate)

The optional `.github/workflows/triage-fast.yml` workflow publishes
`triage fast (SDK)`, `triage fast (bench)`, and `triage fast (aggregate)`.
These are advisory acceleration for the dependency-light `cd-triage-sdk` /
`cd-triage-runtime` and `cd-triage-bench` paths. The existing SDK job checks
both leaf SDK crates in one runner/cache rather than adding another job. These
checks do not replace or rename
`rust tests (ubuntu aggregate)`, and they must not be used as the full
workspace Ubuntu gate — the fast lane compiles three crates and never exercises
`cd-core`, `cd-workflow`, DuckDB, SQLite, keyring, or any network-capable
engine code.

One limit matters before you require them anywhere:

- **The draft head has an explicit push trigger for hosted validation.** This
  revision runs on pushes to `main`, `integrate/rc`,
  `codex/triage-fast-lane`, `codex/triage-runtime-facade-v1`, and
  `codex/triage-runtime-replay-integration-v1`. Pull-request events still
  target only `main` and `integrate/rc`. The self-head push entries exist so
  stacked drafts can validate before their stack is integrated. A pull request
  targeting another stacked branch still gets no PR-triggered fast-lane
  checks, so these advisory checks must never be required for such branches.
## How to verify a ruleset

After changing a ruleset, open a draft PR and confirm the “Required” list on the
PR checks panel contains the intended aggregate names. A deliberately missing
Ubuntu shard artifact must keep `rust tests (ubuntu aggregate)` red, and that
red check must block merge.

The stacked adapter workflow publishes `triage fast (adapter)` as an
additional advisory check once `cd-triage-bench-adapter` is present. It uses
its own cache namespace and the same locked-fetch plus full dependency-boundary
guard as the SDK/bench fast lanes. It does not replace or rename
`rust tests (ubuntu aggregate)` and must not be added as the Ubuntu workspace
gate. The adapter and adapter-CLI workflows include the runtime/replay
integration head as an explicit push target for stacked validation.

## Related

- Workflow: `.github/workflows/ci.yml`
- Operator notes: `docs/DEV.md` (CI Ubuntu workspace test shards)
- macOS/Windows wall-clock study and staged lane implementation: [`docs/testing/MACOS_WINDOWS_CI_LANES.md`](testing/MACOS_WINDOWS_CI_LANES.md)
- Platform matrix: `docs/PLATFORMS.md`
