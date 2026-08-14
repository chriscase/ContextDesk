# CI required checks and rulesets

This document is **configuration guidance for GitHub branch protection / rulesets**.
It does not change workflow behavior. The workflow in `.github/workflows/ci.yml`
already fail-closes on a missing Ubuntu test shard; a ruleset is what makes that
job a merge blocker.

As of the #874 sharding work, **no branch protection ruleset is configured** on
`chriscase/ContextDesk`. Until one is, a red `rust tests (ubuntu aggregate)`
does not by itself prevent a merge.

## What to require

When a ruleset is added, require these **check names** (the `name:` fields in
`.github/workflows/ci.yml`), not job ids:

| Check name | Why |
| --- | --- |
| `gitleaks` | Secret scan |
| `claim↔code guard` | Shipped-claim honesty |
| `close-proof discipline (#254)` | Close-comment SHA + proof |
| `GUI integration contracts (no WebDriver)` | GUI contract suite |
| `rust (ubuntu-latest)` | Ubuntu fmt, clippy, examples, smoke, **cache warmup** (not the suite) |
| `rust (macos-latest)` | macOS fmt, clippy, `cargo test --workspace`, examples, smoke |
| `rust (windows-latest)` | Windows fmt, clippy, `cargo test --workspace`, examples, smoke |
| `rust tests (ubuntu aggregate)` | Fail-closed Ubuntu workspace test gate |
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

## How to verify a ruleset

After saving the ruleset, open a draft PR and confirm the “Required” list on
the PR checks panel matches the table above. A deliberately missing shard
artifact must keep `rust tests (ubuntu aggregate)` red, and that red check
must block merge.

## Related

- Workflow: `.github/workflows/ci.yml`
- Operator notes: `docs/DEV.md` (CI Ubuntu workspace test shards)
- Platform matrix: `docs/PLATFORMS.md`
