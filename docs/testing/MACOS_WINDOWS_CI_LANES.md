# macOS / Windows rust CI lanes

**Status:** staged draft implementation with hosted proof. This lane preserves
macOS/Windows workspace coverage and reduced the desktop critical path in run
[`32008278389`](https://github.com/chriscase/ContextDesk/actions/runs/32008278389).
It does not change the Ubuntu ruleset, merge anything, or make a release claim.

The active branch is [`codex/ci-macos-windows-2way`](https://github.com/chriscase/ContextDesk/pull/910),
which remains draft-only.

## What the hosted evidence says

The baseline hosted run [`31904068651`](https://github.com/chriscase/ContextDesk/actions/runs/31904068651)
was warm: cache restores took 46s on macOS and 74s on Windows. Its monolithic
workspace test steps were:

| OS | Monolithic job | Workspace test step |
| --- | ---: | ---: |
| macOS | 1691s | 1415s |
| Windows | 2560s | 2085s |

The first complete-coverage 2-way implementation was hosted in run
[`32002319037`](https://github.com/chriscase/ContextDesk/actions/runs/32002319037).
All four desktop shards were warm, complete, and green (57/57 plan units per
OS), but the serialized warmup made the critical path worse:

| OS | Restore-only preflight | Slowest shard | Critical path | Baseline | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| macOS | 712s | 1419s | 2131s | 1691s | regression |
| Windows | 1045s | 2878s | 3923s | 2560s | regression |

That run proves the split is coverage-safe and cache-honest. It does not prove
that 2-way sharding is faster. The current follow-up removes the serialized
cache writer on warm hits and increases the parallel width.

The four-way follow-up is hosted in run
[`32008278389`](https://github.com/chriscase/ContextDesk/actions/runs/32008278389)
and completed with all gates green. Both exact-key probes hit, both conditional
writers were skipped, both preflights restored real files, and every desktop
shard reported `cache: warm`, `in_flight: <none>`, and complete coverage:

| OS | Probe / writer | Preflight | Slowest shard | Critical path from workflow start | Coverage / result |
| --- | --- | ---: | ---: | ---: | --- |
| macOS | hit / skipped | 232s | 1293s status (1349s job) | 1488s | 114/114, 3670 passed, 0 failed, 21 ignored |
| Windows | hit / skipped | 402s | 2016s status (2133s job) | 2163s | 114/114, 3636 passed, 0 failed, 21 ignored |

Against the monolithic baselines, the desktop critical paths improved from
1691s to 1488s on macOS and from 2560s to 2163s on Windows. The unchanged
Ubuntu gate also passed 114/114 units (3670 passed, 0 failed, 21 ignored), and
the complete workflow finished in 2237s. This is hosted lane evidence; it is
not a ruleset promotion or a release certification.

## Current inventory

The same deterministic planner used by Ubuntu enumerates 114 test units from
113 Cargo test targets. The `cd-core/lib` target remains two complementary
units (`log_analysis::` and `--skip log_analysis::`) so no tests are dropped.

Round-robin partition sizes are:

| Width | Units per shard |
| --- | --- |
| 2 | 57 + 57 |
| 3 | 38 + 38 + 38 |
| 4 | 29 + 29 + 28 + 28 |
| 8 | 15 + 15 + 14 × 6 |

The local study and exact-cover checks are:

```bash
sh scripts/ci_macos_windows_lane_study.sh
sh scripts/ci_macos_windows_lane_study.sh --json
sh scripts/tests/ci_macos_windows_lane_study_test.sh
```

## Fast-hit and safe-miss design

Each desktop OS follows this sequence:

1. An exact-key `lookup-only` cache probe runs first. It does not pretend to
   restore files; it only decides whether the shared cache key exists.
2. On a miss, exactly one OS-specific cache-writer job runs
   `cargo test --workspace --no-run` and saves the complete target tree. On a
   hit, that writer is skipped, so the test shards do not wait for a redundant
   build.
3. The existing `rust (macos-latest)` and `rust (windows-latest)` checks become
   restore-only preflight signals. They require an actual non-empty `target/`
   restore, then run fmt, clippy, examples, and server smoke tests. They do not
   replace the complete workspace suite.
4. Four restore-only platform shards run the full deterministic plan with
   `save-if: false`. Every shard fails closed unless its downloaded target is
   actually warm, and every shard uploads status and in-flight evidence.
5. Per-OS aggregates require all four shard results and the exact 114-unit
   cover. They remain non-required platform signals until separately promoted.

The cache status helper recognizes `warmup`, `preflight`, and `shard` roles.
Only a warmup may save; preflight and shards restore and verify. A cache key hit
without restored files is recorded as cold, never as a successful test basis.

## Why four shards

The hosted 2-way run showed that parallelizing only the execution half was not
enough. Local weighted timing predicted that width four would reduce the
largest test-only bucket, and run `32008278389` confirmed a desktop critical-
path improvement while preserving coverage. The hosted evidence records:

- exact-key probe hits and conditional writer skips on the warm path;
- cache state and restored-file evidence for every shard;
- exact 114/114 unit coverage, pass/fail/ignored counts, and no in-flight
  unit at completion;
- comparison with the 1691s macOS and 2560s Windows baselines.

Eight desktop shards are deliberately not used yet. They increase fixed build
and link overhead and risk isolating leftover-heavy `cd-core/lib` slices, the
same timeout class that required Ubuntu's separate tuning.

## DuckDB and cache ownership

Bundled DuckDB is the largest cold-build offender. A desktop cache miss must
therefore have one writer, not four independent cold builds. On a warm hit,
all four shards download the shared target tree in parallel and never race to
save partial state. On a cold miss, shards wait for the one writer and then
restore the completed cache; if the writer fails, the shard/aggregate path
fails closed rather than silently running an untracked cold build.

## Gates and boundaries

- The required main-branch check remains exactly `rust tests (ubuntu aggregate)`.
- `rust (ubuntu-latest)` remains Ubuntu warmup, not the Ubuntu suite gate.
- Existing security, GUI, desktop, Tauri, and Ubuntu shard/aggregate jobs remain
  present.
- Platform aggregate names are `rust tests (macos-latest aggregate)` and
  `rust tests (windows-latest aggregate)`; they are not added to the ruleset in
  this draft.
- No timeout is raised to hide a slow shard, and no test unit is skipped.
- The four-way desktop speed improvement is proven by hosted run `32008278389`;
  no release or required-check promotion is implied.

Pinned baseline, two-way regression, and four-way evidence lives in
[`ci_macos_windows_lane_evidence.json`](../../scripts/fixtures/ci_macos_windows_lane_evidence.json).
