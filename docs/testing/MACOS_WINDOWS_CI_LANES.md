# macOS / Windows rust CI lanes

**Status:** study plus staged implementation draft. The follow-up keeps the
existing Ubuntu gate and ruleset untouched, and adds two restore-only shards per
desktop OS after an OS-specific cache warmup. It remains draft-only pending
hosted proof of warm cache, exact coverage, and useful wall-clock improvement.

Tip measured: `ffe57ff754fefc017f44c925cbc2dd0054e29374`
(`ci: raise the Ubuntu test shard count 4 → 8`).

## What is slow

Ubuntu already shards `cargo test --workspace`. The draft now gives macOS and
Windows the same complete planner/runner/aggregate shape instead of keeping
the suite as one step inside `rust (${{ matrix.os }})`.

Hosted run [`31904068651`](https://github.com/chriscase/ContextDesk/actions/runs/31904068651)
(push to `main`, all 19 checks green):

| Job | Wall | Dominant step | Cache restore | Clippy |
| --- | --- | --- | --- | --- |
| `rust (windows-latest)` | **42.7 min** | `cargo test --workspace` **34.8 min** (2085s) | 74s | 130s |
| `rust (macos-latest)` | 28.2 min | `cargo test --workspace` 23.6 min (1415s) | 46s | 99s |
| `rust (ubuntu-latest)` warmup | 10.2 min | `cargo test --workspace --no-run` 4.7 min | 49s | 73s |
| Ubuntu worst shard | 24.4 min | `run shard` 22.0 min | ~50s | — |

Replicate run [`31887796502`](https://github.com/chriscase/ContextDesk/actions/runs/31887796502)
(previous `main` tip): Windows `cargo test --workspace` **2082s**. Same shape.

Those cache restores (37–74s) plus clippy in 1–2 minutes mean **both measured
main runs were warm**. The 35-minute Windows step is therefore **link +
execute the whole workspace on one VM**, not a cold bundled-DuckDB compile.

Cold DuckDB is still the other cost class. Ubuntu shards on
`31828397526` / `31835229724` each compiled DuckDB **36–55 minutes** when
the shared cache was missing. A warm Ubuntu shard still reported
`build time: 710s` of `total time: 1203s` — more than half the shard is
linking, which is why adding shards shrinks only the test half.

The **CI wall clock on `main` is the Windows job**. Ubuntu warmup + worst
shard ≈ 10 + 24 = 34 minutes, still under Windows.

## Inventory

Same planner Ubuntu uses (`scripts/ci_shard_plan.sh`), 114 shard units /
113 cargo test targets, exact cover at every width:

| Width | Units per shard |
| --- | --- |
| 2 | 57 + 57 |
| 3 | 38 + 38 + 38 |
| 4 | 29 + 29 + 28 + 28 |
| 8 (Ubuntu today) | 15 + 15 + 14×6 |

`cd-core/lib` is already two complementary filters (`log_analysis::` and
`--skip log_analysis::`). Reproduce:

```bash
sh scripts/ci_macos_windows_lane_study.sh
sh scripts/ci_macos_windows_lane_study.sh --json
sh scripts/tests/ci_macos_windows_lane_study_test.sh
```

## Two options, one recommendation

### A. Fast preflight + later complete coverage — reject as the *required* gate

A parallel job of fmt / clippy / `cargo test -p cd-triage-bench` gives
earlier signal. It does **not** cut wall clock if `cargo test --workspace`
remains required on the same runner or a sibling that still takes 35 minutes.
Making the preflight the required check would **skip tests**. Forbidden.

Preflight is allowed later only as a *non-required* early-fail, never as a
substitute for the aggregate.

### B. Safe 2-way partition with complete coverage — staged draft

Reuse the existing planner, portable `ci_run_platform_shard.sh`,
`ci_record_cache.sh`, and `ci_aggregate_shards.sh`. Do **not** copy Ubuntu's 8-way leftover-heavy
split onto Windows: issue #898 is exactly leftover `cd-core/lib/*` slices
timing out as isolates.

**Next workflow patch** (separate PR; do not land in this one):

1. `rust (macos-latest)` and `rust (windows-latest)` are **warmup only**:
   fmt, clippy, `cargo test --workspace --no-run`, examples, smoke. Each
   **saves** a shared rust-cache (`macos-workspace-tests` /
   `windows-workspace-tests`). `cache_state=warm` only on an exact
   Swatinem hit **and** a non-empty `target/` (same honesty as Ubuntu).
2. `rust-platform-shard` uses `[1, 2]` per OS and restores that cache with
   `save-if: false`. Never `lookup-only: true` (hosted run `31845262696`
   recorded warm while compiling 11–12 minutes). The portable entry point is
   `sh scripts/ci_run_platform_shard.sh --os macos|windows --shard K`.
3. `rust-platform-tests` publishes fail-closed aggregates named
   `rust tests (macos-latest aggregate)` and
   `rust tests (windows-latest aggregate)`. They are complete-coverage
   signals in this draft; the active ruleset still requires only
   `rust tests (ubuntu aggregate)`.
4. Timeouts stay at or below today's implicit GitHub job budget. Do not
   raise them. Do not skip units. Do not treat a cache miss as success.

Expected shape if warmup is warm (linear interpolation is **not** a
promise; hosted proof is): Windows 35-minute test step split across two
shards that still each pay a large link. Ubuntu's warm shard was 59%
build. A 2-way Windows split should land in the **low-to-mid 20 minute**
range per shard if the cache is actually warm — better than 43 minutes
wall clock, worse than a fantasy “half of 35.” Cold without warmup is
**2 × 36–55 minutes of DuckDB** and is a regression.

## Risks

- **Cold cache without warmup** is the failure that made Ubuntu 4-way
  unusable. Any desktop-lane PR that shards but forgets the writer job
  must be rejected.
- **Leftover-heavy `cd-core/lib` isolates** (#898, #893, #907) are an
  Ubuntu problem this 2-way plan must not import. Do not raise
  `--shards` past 2 on Windows/macOS without hosted leftover-slice proof.
- **Runner minutes** roughly double if 2 shards + warmup all compile on
  a miss. Warmth is the whole bet. Measure `cache_state` on the first
  hosted tip.
- **Required-check names** change. Document them before anyone wires a
  ruleset (`docs/CI_REQUIRED_CHECKS.md`).
- **#899 path filters** are a different lever (skip Ubuntu shards for
  collab/bench-only PRs). They do not speed a rust-touching Windows job.

## What this branch is not

- Not a merge, ready-for-review declaration, or ruleset change.
- Not a timeout raise.
- Not a skipped test.
- Not a claim that a cache miss is green.
- Not a readiness or release claim.

Pinned numbers live in
`scripts/fixtures/ci_macos_windows_lane_evidence.json`.
