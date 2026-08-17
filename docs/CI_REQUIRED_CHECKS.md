# CI required checks and rulesets

This document is **configuration guidance for GitHub branch protection / rulesets**.
It does not change workflow behavior. The workflow in `.github/workflows/ci.yml`
already fail-closes on a missing test shard; a ruleset is what makes a check a
merge blocker.

The active `main` ruleset is `20890073` (`main: require Ubuntu aggregate`). Its
Ubuntu suite gate is exactly `rust tests (ubuntu aggregate)`. The
`rust (ubuntu-latest)` job is warmup (fmt, clippy, examples, smoke, and cache
population), not the Ubuntu test suite and not the Ubuntu suite gate.
The macOS/Windows aggregates are coverage signals and do not change that
active requirement.

## What to require

The active ruleset currently enforces the Ubuntu aggregate named above. The
remaining rows are the project’s candidate checks and lane signals; this draft
does not modify the ruleset or add the new desktop aggregates to it.

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
| `rust tests (macos-latest aggregate)` | Fail-closed macOS workspace test gate; draft follow-up check |
| `rust tests (windows-latest aggregate)` | Fail-closed Windows workspace test gate; draft follow-up check |
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

## Path-aware routing

For a Rust-touching PR, `rust tests (ubuntu aggregate)` runs the complete
fail-closed eight-shard workspace gate. A PR that changes only
`crates/cd-triage-bench/**` (or benchmark documentation) skips the eight
shards but keeps the same required check name and runs the complete
`cd-triage-bench` test suite in the aggregate job. A collaboration-only path
is routed only when no collaboration implementation is present; if source
appears before its dedicated validator exists, the aggregate fails closed.

## How to verify a ruleset

After changing a ruleset, open a draft PR and confirm the “Required” list on the
PR checks panel contains the intended aggregate names. A deliberately missing
Ubuntu shard artifact must keep `rust tests (ubuntu aggregate)` red, and that
red check must block merge.

## Related

- Workflow: `.github/workflows/ci.yml`
- Operator notes: `docs/DEV.md` (CI Ubuntu workspace test shards)
- macOS/Windows wall-clock study and staged lane implementation: [`docs/testing/MACOS_WINDOWS_CI_LANES.md`](testing/MACOS_WINDOWS_CI_LANES.md)
- Platform matrix: `docs/PLATFORMS.md`
