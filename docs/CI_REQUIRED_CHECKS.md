# CI required checks and rulesets

This document is **configuration guidance for GitHub branch protection / rulesets**.
It does not change workflow behavior. The workflow in `.github/workflows/ci.yml`
already fail-closes on a missing test shard; a ruleset is what makes a check a
merge blocker.

The active `main` ruleset is `20890073` (`main: require Ubuntu aggregate`). Its
Ubuntu test requirement is exactly `rust tests (ubuntu aggregate)`.

Draft #910 is the hosted-validation follow-up for the new macOS/Windows
aggregates; it does not change that active requirement.

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
| `rust (macos-latest)` | macOS fmt, clippy, **cache warmup** (`cargo test --workspace --no-run`), examples, smoke; not the suite gate |
| `rust (windows-latest)` | Windows fmt, clippy, **cache warmup** (`cargo test --workspace --no-run`), examples, smoke; not the suite gate |
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
- **`rust (ubuntu-latest)`**, **`rust (macos-latest)`**, and
  **`rust (windows-latest)`** — these are warmup/quality jobs, not complete
  workspace-suite gates. Requiring one of them alone would not protect the
  corresponding shard aggregate.
- The macOS/Windows shard indexes are likewise signals. The per-OS aggregate
  is the stable coverage check; the active ruleset will be revisited only after
  hosted proof confirms the new lanes are warm and complete.

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
