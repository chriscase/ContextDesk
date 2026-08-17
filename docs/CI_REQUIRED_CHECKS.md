# CI required checks and rulesets

This document is **configuration guidance for GitHub branch protection / rulesets**.
It does not change workflow behavior. The workflow in `.github/workflows/ci.yml`
already fail-closes on a missing Ubuntu test shard; a ruleset is what makes that
job a merge blocker.

The active `main: require Ubuntu aggregate` ruleset (id `20890073`) on
`chriscase/ContextDesk` requires exactly `rust tests (ubuntu aggregate)`.
That aggregate is the merge-blocking Ubuntu test gate; the warmup job
`rust (ubuntu-latest)` is not the suite gate.

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

## Triage fast lane (advisory, not a gate)

The optional `.github/workflows/triage-fast.yml` workflow publishes
`triage fast (SDK)`, `triage fast (bench)`, and `triage fast (aggregate)`.
These are advisory acceleration for the dependency-light `cd-triage-sdk` /
`cd-triage-bench` path. They do not replace or rename
`rust tests (ubuntu aggregate)`, and they must not be used as the full
workspace Ubuntu gate — the fast lane compiles two crates and never exercises
`cd-core`, `cd-workflow`, DuckDB, SQLite, keyring, or any network-capable
engine code.

Two limits matter before you require them anywhere:

- **The draft head has an explicit push trigger for hosted validation.** This
  revision runs on pushes to `main`, `integrate/rc`, and
  `codex/triage-fast-lane`; pull-request events still target only `main` and
  `integrate/rc`. The self-head push entry exists so this draft can validate
  before its stack is integrated. A pull request targeting another stacked
  branch still gets no PR-triggered fast-lane checks, so these advisory checks
  must never be required for such branches.
- **They assume the sharded Ubuntu CI.** The `rust tests (ubuntu aggregate)`
  gate and the `rust (ubuntu-latest)` warmup described above arrive with the
  #874 shard work. Until that lands, `rust (ubuntu-latest)` still runs
  `cargo test --workspace` itself and there is no aggregate check to defer to.

## How to verify a ruleset

After saving the ruleset, open a draft PR and confirm the “Required” list on
the PR checks panel matches the table above. A deliberately missing shard
artifact must keep `rust tests (ubuntu aggregate)` red, and that red check
must block merge.

The stacked adapter workflow publishes `triage fast (adapter)` as an
additional advisory check once `cd-triage-bench-adapter` is present. It uses
its own cache namespace and the same locked-fetch plus full dependency-boundary
guard as the SDK/bench fast lanes. It does not replace or rename
`rust tests (ubuntu aggregate)` and must not be added as the Ubuntu workspace
gate.

## Related

- Workflow: `.github/workflows/ci.yml`
- Operator notes: `docs/DEV.md` (CI Ubuntu workspace test shards)
- Platform matrix: `docs/PLATFORMS.md`
