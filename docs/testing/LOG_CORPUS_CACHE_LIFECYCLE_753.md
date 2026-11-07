# Log corpus cache lifecycle — #753 verification record

Issue: [#753](https://github.com/chriscase/ContextDesk/issues/753) — make log-corpus
discard atomic and corpus opens single-flight.

Base: `b54844cb9e5a6e80bcde806e10ddcaf0d79fc2b6` (tree
`9ecc54e25c7facf610f9e6ce445245f64c5d048c`). Candidate: four commits on
`claude/contextdesk-753-corpus-cache-lifecycle` — the implementation commit
(`c1d3bea`), the first independent-review fixes (`7f3c2c7`), the second-review
fixes (`674634e`, the frozen candidate whose custody packet is preserved
unchanged), and the custodian-admitted four-path successor that updates this
file with the final-review corrections (§8).

Handbook: [Log evidence pipeline §6.9](../design/proven-methods/LOG_EVIDENCE_PIPELINE.md#69-corpus-handle-lifecycle-753).

Status: **source slice + partial verification.** The cargo workspace gates,
the desktop host gates, and packaged synthetic two-window qualification were
**not run** in the authoring environment (see §4). Nothing here claims they
passed.

## 1. Defect at base

| Defect | Base behaviour |
| --- | --- |
| Discard not atomic | `discard_log_corpus` removed the desktop cache entry, then separately ran `remove_dir_all`. A cold open between the two re-inserted a handle to a corpus that was then deleted; an in-place `remove_dir_all` failure could leave a partially deleted corpus under its real id. |
| Retained handles unfenced | `ToolHost` returned its turn-local handle without any discard check; on POSIX the shared DuckDB connection kept serving the unlinked database, so a linked turn kept returning evidence after discard. |
| Global cold-open lock | The desktop cache held one global mutex across `LogCorpus::open` (DuckDB open, schema, templates, vectors): unrelated corpora serialized and cache hits waited behind any cold open. |
| Re-analysis invalidation | Removal happened only after success and relied on the global lock to order a concurrent cold open; an open overlapping sidecar publication could read a half-published template set. |

## 2. Design summary

- `crates/cd-core/src/log_analysis/corpus_lifecycle.rs`: per-directory cell with
  a fence epoch (discard), a content generation (re-analysis publication),
  phase, and admitted-section counts. Discard = fence (notifies waiters) →
  `on_fenced` → drain → `release_files` (store tries to close the shared DuckDB
  connection) → atomic rename into `log_corpora/.discarding/` → `Discarded`
  tombstone (bounded, `MAX_RETAINED_TOMBSTONES = 256`) → best-effort reclaim.
  Rollback to the prior phase on pre-rename failure (fenced handles then
  report an *interrupted* discard, not "discarded"); idempotent re-discard;
  ids validated inside the crate-private discard entry point. Also hosts
  `SharedPerCorpus<T>`, the per-key single-flight registry now backing the
  store's one-connection-per-database map.
- `store.rs`: every `LogCorpus` carries a `CorpusLifecycleTicket`; `open`,
  `create`, staging and publication-validation opens are admitted;
  `with_connection` and fallible DuckDB accessors are fenced before (and
  `with_connection`/`load_all_events` after) the query; `discard_with` hook;
  the shared-connection registry no longer holds a process-wide lock across
  `Connection::open` + schema init; discard releases the corpus's shared
  connection after the drain and before the rename.
- `search.rs`, `why.rs`: explicit pre/post fences (`with_events` degrades load
  errors to empty, so a stale handle must not look like "no results").
- `reanalyze.rs`: sidecar replacement runs inside a lifecycle publication;
  stops once discarded; a fenced validation reopen rolls both sidecars back.
- `tool_host.rs`: stale slot hits and stale seeded preflight handles are
  rejected and the stale handle stays in the slot (sticky, never silently
  reopened); cold opens run without the slot lock; evidence tools re-check
  after computing; broad-triage phase checkpoints include the fence;
  `ensure_linked_log_corpus_live`.
- `agent.rs`: fence immediately before every linked-answer release (main
  loop, budget synthesis, synthesis retry, fast-triage, contribution,
  multi-model, multi-stage); stale-snapshot errors caused by a discard route
  to the dedicated terminal: error code `linked_log_corpus_discarded`, turn
  reason `linked_log_snapshot_stale` (already in `WITHHELD_TURN_REASONS`).
- `desktop/src-tauri/src/log_corpus_cache.rs`: generic per-corpus single-flight
  engine + `LogCorpusHandleCache` glue (`open`, `invalidate`, `discard`).
  `lib.rs`: old global-lock cache removed; `discard_log_corpus` is now an async
  command running the fenced discard on a blocking worker (same IPC name and
  arguments); re-analysis invalidates the cache after any finished run.

Lock ordering (documented in both modules and handbook §6.9): lifecycle
registry → nothing; lifecycle cell → nothing; desktop cache state → nothing
(reads lifecycle atomics only); flight outcome slot → nothing. No lock is held
across DuckDB open/query, filesystem moves, callbacks, or flight waits.

## 3. Verification actually run

Environment constraint: no crate registry, vendored sources, or build cache
existed in the authoring container, and dependency acquisition was not
permitted, so `cargo` could not build `cd-core` (DuckDB is a bundled native
build). Verification therefore used the **exact installed toolchain binaries**
directly, with no cargo, no registry and no network:

- `rustc 1.97.0 (2d8144b78 2026-07-07)`, `clippy 0.1.97`, `rustfmt 1.9.0-stable`
  from `/root/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/` (called by
  absolute path, bypassing the rustup proxy).
- Serial, bounded runs: `ulimit -v 4194304` (4 GiB), `ulimit -f 1048576`,
  `timeout 300` per build, `timeout 120` per test run; disposable synthetic
  directories only (no user corpus/operator data); scratch outside the repo.

### 3.1 Standalone harnesses (real source files, std-only shims)

| Harness | What is real | What is shimmed |
| --- | --- | --- |
| Lifecycle | `corpus_lifecycle.rs` (all code + 21 tests) | `crate::error` (same `Message`/`Policy`/`Io` variants and `Display`), `tempfile::tempdir` |
| Desktop cache | `log_corpus_cache.rs` (all code + 11 tests) **and** the real `corpus_lifecycle.rs` | `cd_core::log_analysis::LogCorpus` replaced by a fake store with the same admit → read → finish(retry) structure, no DuckDB |

Results (each suite run three times, `--test-threads=8`):

```text
lifecycle_tests  : test result: ok. 21 passed; 0 failed (x3, final sources)
desktop_cache    : test result: ok. 11 passed; 0 failed (x3, final sources)
rustc -D warnings (test targets)                   : clean
clippy-driver -D warnings (lifecycle test, cache test): clean
clippy-driver -D warnings -A dead_code (lifecycle lib, cache lib): clean
  (dead_code allowed only where the real callers — store.rs / lib.rs — are
   absent from the harness; the shim cd_core rlib likewise)
rustfmt --check: every touched .rs file, plus recursive checks rooted at
  crates/cd-core/src/log_analysis/mod.rs and desktop/src-tauri/src/lib.rs: clean
```

A probe file (`v.len() == 0`) confirmed `clippy-driver` was linting
(`clippy::len_zero` raised under `-D warnings`).

### 3.2 Mutation checks (scratch copies; repository files untouched)

| # | Injected defect | Detected by |
| --- | --- | --- |
| M1 | Admission completion ignores the discard epoch | `open_admitted_before_the_fence_blocks_unpublish_and_cannot_publish_a_handle` |
| M2 | Discard never advances the fence epoch | 5 lifecycle tests + `open_racing_discard_cannot_reinsert_a_handle`, `discard_through_the_cache_leaves_no_live_handle_and_no_entry` |
| M3 | Discard skips draining admitted opens/publications | `open_admitted_before_the_fence…`, `failed_open_releases_its_admission…`, `discard_fences_publication_and_waits_for_it_to_end` |
| M4 | Old behaviour: cache mutex held across the cold open | 7 cache tests incl. `different_ids_initialize_independently_and_hits_are_not_blocked`, `same_id_cold_opens_coalesce_into_one_initialization` |
| M5 | Detached (invalidated/discarded) leader still inserts | `invalidate_detaches_an_inflight_open_so_it_is_never_inserted` |
| M6 | Cache hits skip the lifecycle staleness check | `stale_entries_are_reopened_never_served`, `republication_and_explicit_invalidation_force_a_reopen` |
| M7 | Panicking leader publishes no outcome | `panicking_initialization_releases_waiters_and_allows_retry` |
| M8 | Hits do not refresh LRU order | `four_entry_lru_bound_is_preserved` |
| M9 | Publication start does not advance the content generation | `open_overlapping_a_publication_start_must_reopen`, `publication_is_drained_and_opens_wait…` |
| M10 | Shared-connection registry lock held across the open | `shared_registry_coalesces_same_key_and_keeps_keys_independent` |
| M11 | Discard skips the file-release step | `files_are_released_after_the_drain_and_before_unpublish` |
| M12 | Discard entry point skips id validation | `discard_rejects_ids_that_could_escape_log_corpora` |
| M13 | Rolled-back fence reports "discarded" | `unpublish_failure_rolls_back_to_live_and_retry_succeeds` |
| M14 | Fence does not notify condvar waiters | `fence_wakes_phase_observers_without_waiting_for_their_timeout` |
| M15 | Registry `detach` retires a value other than the one it locked | `shared_registry_detach_retires_only_the_expected_value` |

M3 initially survived (the drain assertion raced the rename); the drain tests
were strengthened with a bounded observation window that a correct discard can
never violate, after which M3 was detected. M1–M6, M9 and M10–M14 were re-run
on the final sources and all were detected; M7/M8 touch code unchanged since
their run.

## 4. Not run (honest gate status)

| Gate | Status | Reason |
| --- | --- | --- |
| `cargo fmt --all -- --check` | NOT_RUN as cargo | Equivalent per-file `rustfmt --check` (§3.1) passed |
| `cargo clippy --workspace --all-targets -- -D warnings` | NOT_RUN | No registry/cache; bundled DuckDB native build not permitted |
| `cargo test --workspace` | NOT_RUN | Same; the DuckDB-backed tests below are written but unexecuted |
| Desktop host `cargo fmt/clippy/check` | NOT_RUN | Same, plus WebKit/keyring system deps |
| Desktop UI `npm ci/typecheck/lint/test/build` | NOT_RUN | No TS/React changes; package acquisition not permitted |
| Packaged synthetic two-window lifecycle validation | NOT_RUN | Later qualification gate; not provable by unit tests or review |

Written but **not executed** (require real `cd-core` with DuckDB):

- `store.rs`: `concurrent_open_and_discard_never_publishes_a_surviving_handle`
  (barrier via per-corpus test open hook),
  `query_result_that_overlapped_a_discard_start_is_rejected` (cross-thread),
  `discard_closes_the_shared_connection_before_unpublishing` (asserts the
  stale handle's underlying connection no longer reaches the corpus schema),
  `direct_scan_waiting_for_the_connection_during_a_discard_fails_as_discarded`
  (deterministic since the successor, §8),
  `failed_discard_changes_nothing_on_disk_and_can_be_retried`,
  `publication_makes_open_handles_non_current_and_new_opens_wait`.
- `reanalyze.rs`: `successful_reanalysis_makes_retained_handles_non_current_but_live`,
  `discard_before_publication_rejects_reanalysis_without_recreating_files`,
  `discard_waits_for_an_inflight_publication_then_wins_with_rollback`.
- `search.rs`: `search_on_a_discarded_handle_fails_closed_instead_of_returning_evidence`.
- `why.rs`: `why_analysis_on_a_discarded_handle_fails_visibly_instead_of_returning_empty`.
- `tool_host.rs`: `discarded_turn_corpus_stops_returning_evidence_and_fails_visibly`,
  `evidence_computed_while_a_discard_begins_is_returned_as_a_failure`
  (test hook between tool computation and the post-tool fence),
  `discard_racing_a_turn_preflight_handle_fails_the_seed_and_the_pin`.
- `agent.rs`: `linked_answer_is_withheld_when_corpus_is_discarded_during_final_synthesis`,
  `linked_tool_round_after_discard_fails_visibly_and_withholds_answer`.
- `log_corpus_cache.rs` real-`LogCorpus` tests (3) executed only against the
  fake store in §3.1.

Existing linked-search/cluster/timeline reuse tests
(`sequential_log_tools_reuse_one_turn_scoped_corpus_handle`,
`validated_log_corpus_handle_can_seed_one_turn_without_reopening`, and the
desktop cache call sites) must be re-run under cargo; they were not executed.

## 5. Acceptance mapping (#753)

| Acceptance criterion | Source | Proof status |
| --- | --- | --- |
| Per-corpus lifecycle gate/tombstone covering invalidation and deletion as one transition | `corpus_lifecycle::discard_corpus_root`, `LogCorpus::discard_with`, `LogCorpusHandleCache::discard` | Lifecycle + cache harness tests PASS; store tests NOT_RUN |
| Discard rejects/cancels new operations; racing open cannot reinsert | admission epoch check, phase gate, flight detach + leader liveness check | `open_admitted_before_the_fence…`, `open_racing_discard_cannot_reinsert_a_handle` PASS; store barrier test NOT_RUN |
| Active linked turns stop returning evidence; failure visible | ToolHost slot/seed/post-tool fences; agent pre-release fence; `linked_log_corpus_discarded` | ToolHost/agent tests written, NOT_RUN |
| Barrier-controlled concurrent open/discard: no handle survives discard success | lifecycle + store + cache barrier tests | Lifecycle/cache PASS; store NOT_RUN |
| Per-corpus single-flight: same-id coalesce, cross-id independent, hits unblocked | `SingleFlightCorpusCache::get_or_open`; core `SharedPerCorpus` connection registry | PASS (+ M4, M10 detected); real DuckDB opens NOT_RUN |
| Preserve four-entry bound and deterministic reanalysis invalidation | `LOG_CORPUS_HANDLE_CACHE_CAP = 4`; content generation + `invalidate` after any finished re-analysis | `four_entry_lru_bound_is_preserved`, `republication_and_explicit_invalidation_force_a_reopen` PASS; reanalysis store tests NOT_RUN |
| Concurrency tests: coalescing, independence, failure/retry, reanalysis, discard, poisoned/cancelled init | cache + lifecycle suites | PASS in harness |
| Locks out of DuckDB open/query; lock ordering documented | module docs, handbook §6.9 | Review + M4/M10; residual: release step waits for one in-flight query |
| Retest linked search/cluster/timeline reuse and packaged multi-window lifecycle | — | NOT_RUN (cargo + packaged gates pending) |

Handbook impact: `LOG_EVIDENCE_PIPELINE.md` status row, invariant 14, §6.9,
failure rows, test recipe, anchors, matrix row, and residuals updated.

## 6. Residuals

- Process-local fence: another process opening the same cache directory is not
  fenced (same scope as the existing shared DuckDB connection registry).
- Sidecar writers outside `store.rs`/`reanalyze.rs` are fenced only through
  handle DuckDB access and are not drained; a write racing the unpublish rename
  lands first (and moves to `.discarding/`) or fails.
- Direct core discards that bypass the desktop cache (managed demo reconcile)
  rely on lazy eviction: stale entries are never served but are dropped on the
  next cache access rather than inside the fence.
- An in-flight DuckDB query on a stale handle is not interrupted; its result is
  rejected when it completes, and the discard's release step waits for it,
  bounded at 120 s. If that wait times out (or the inert connection cannot be
  created), nothing is swapped or retired: the old **real** connection stays
  registered and open until the **last** retained stale handle holding it
  drops (for example a linked turn's sticky slot or a broad-triage job), not
  merely until the query ends. POSIX directory renames still succeed with
  files open. On hosts where open files block directory renames (Windows) the
  unpublish may then fail and the discard rolls back. Neither path has been
  observed on such a host or in a packaged/native build.
- The inert-connection guarantee covers **fenced** access only: every fenced
  DuckDB access re-checks the fence after taking the connection lock and never
  queries the inert connection. The infallible, unfenced `event_count()` may
  query it and then returns 0.
- Each discard that still has retained stale handles allocates one inert
  in-memory DuckDB instance that lives until the last stale handle drops
  (for a linked turn, the end of the turn).
- ToolHost keeps a stale turn handle until its scope setter runs; a host that
  never calls the scope setters keeps reporting "reopen it and retry" after a
  rolled-back discard. Desktop and cd-workflow reset the scope every turn.
- Windows: the release step is meant to let the unpublish rename succeed with
  handles still retained; this has not been observed on a Windows host (the
  Windows CI shards will run the new tests).
- A dedicated withheld turn reason (`linked_log_corpus_discarded`) would need a
  one-entry change to `WITHHELD_TURN_REASONS` in `crates/cd-core/src/events.rs`,
  outside this slice; the existing withheld reason is used instead.

## 7. Independent review and dispositions

A distinct Claude reviewer inspected `c1d3bea` read-only (no build). Findings
and dispositions:

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | `lib.rs` test `blocking_helpers_preserve_startup_read_results` still called the removed `handles.remove` (test-target compile error) | Fixed: `invalidate`; every cache method call in `lib.rs` re-audited (only `open`/`invalidate`/`discard`) |
| 2 | Directory rename with open DuckDB files may fail on Windows | Mitigated: discard closes the shared connection after the drain, before the rename, when its bounded (120 s) wait succeeds; after a timeout the real connection stays open until the last retained stale handle drops (§6); Windows still unobserved |
| 3 | Fence did not `notify_all` condvar waiters | Fixed; regression `fence_wakes_phase_observers…` (M14) |
| 4 | A rolled-back discard made handles claim "discarded" | Fixed: phase-aware stale error ("interrupted discard; still exists"), not classified as a discard (M13). Before a provider round it routes to the stale-snapshot terminal; if the fence and its rollback both land during final synthesis, the answer is released — its evidence predates the fence and the corpus is unchanged |
| 5 | New terminal reason not classified as withheld | Fixed within scope: reason `linked_log_snapshot_stale`, distinct error code kept; dedicated reason noted as an `events.rs` follow-up |
| 6 | Core connection registry held a process-wide lock across `Connection::open`; ToolHost slot held across cold open | Fixed: per-key `SharedPerCorpus` registry (M10); ToolHost opens without the slot lock |
| 7 | Public discard entry point skipped id validation | Fixed: crate-private and validating (M12) |
| 8 | Prune test could not detect pruning; post-tool fence unexercised; answer fence non-sticky | Fixed: `Weak`-based prune assertion; ToolHost hook test; sticky stale slot |

Second independent review (fix delta `c1d3bea..7f3c2c7`, read-only; one
`rustfmt --check`): no compile, clippy, deadlock or evidence-leak blocker.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | Direct `live_db` callers that passed the pre-check before the fence could query the swapped-in inert connection (catalog error, not a discard error); `event_count` returns 0 for stale handles | Fixed: `live_db` re-checks the fence after taking the connection lock (regression `direct_scan_waiting_for_the_connection_during_a_discard_fails_as_discarded`); `event_count` documented as infallible/0 |
| 2 | Release waited on the connection mutex without a bound | Fixed: bounded, poison-tolerant wait (120 s). The timeout consequence ("files stay open until the query ends") was stated wrongly here; corrected in §8 |
| 3 | Registry entry removed before the inert connection existed (two file connections possible on failure + rollback) | Fixed: inert connection created first; entry retired only while that exact connection is locked (`detach`, M15) |
| 4 | Doc overstated the rolled-back-discard terminal | Corrected (row 4 above) |
| 5 | `ensure_live` takes the cell lock under host locks, contradicting the module's lock list; stale `ensure_live` doc in store | Docs corrected (cell lock is a leaf on the stale path) |
| 6 | One in-memory DuckDB instance per discard with retained stale handles; sticky slot never reopens after a rollback | Residual (§6) |
| 7 | Rollback test used `event_count`; release test proved only registry removal | Strengthened: real-schema query after rollback; inert-connection assertion |

## 8. Final review (review 3) and custodian-admitted successor

Review 3: the same reviewer agent `ad68937cd62855578`, resumed for a read-only
exact-source check of `674634e`. Verdict **NO BLOCKER**, with three LOW
findings. The custodian then admitted a successor by the same author, limited
to `store.rs` (regression test and accurate residual comments, no new
behavior), `corpus_lifecycle.rs` (documentation), this file, and
`LOG_EVIDENCE_PIPELINE.md`.

| # | Review-3 finding | Successor change |
| --- | --- | --- |
| 1 | `direct_scan_waiting_for_the_connection_during_a_discard_fails_as_discarded` ordered the fence before releasing the held connection lock only with a 150 ms sleep; a late fence could let the scan return rows, and a late scan could pass only through the pre-check | Deterministic rewrite. A `cfg(test)`-only observation point in `live_db`, after the pre-check and before the lock wait (`set_live_db_hook_for_tests` / `run_live_db_hook`, keyed by corpus id and compiled out of non-test builds), proves the scan passed the pre-check while live. `discard_with`'s fence callback proves the fence is up before the test releases the held connection. With the pre-check proven passed, a discard error can only come from the post-lock re-check, whichever of the scan and the release takes the lock first. Every wait is `recv_timeout` on a bounded `sync_channel`, threads are joined only after they report, and a drop guard removes the hook on every exit path. No sleep remains in this test |
| 2 | The timeout residual was understated: on a release timeout the old real connection stays open until the last retained stale handle drops, and two statements claimed unconditionally that no file stays open | Corrected in `release_shared_connection` and `discard_with` docs, the module's transition step 4, handbook §6.9 and §16, and §6–§7 here |
| 3 | The handbook said no stale handle ever queries the inert connection, but the unfenced `event_count()` does (and returns 0) | Corrected to "no *fenced* access" plus the explicit `event_count()` caveat (handbook §6.9, §6 here, `release_shared_connection` docs) |

Successor verification, actually run: `rustfmt --edition 2021 --check` on
`store.rs` and `corpus_lifecycle.rs` (the first run failed on one assertion
layout, which was then fixed by rustfmt and rechecked clean); the recursive
check rooted at `log_analysis/mod.rs` (clean); and
`scripts/check_design_handbook.mjs` (OK). No added line exceeds 100
characters.

Known remaining wording outside the admitted successor paths: the comment at
`crates/cd-core/src/tool_host.rs:4000` ("the discard already closed its
database files") holds only when the release step succeeds. It is part of the
original 13-path reservation but not of this four-path successor, so it is
left unchanged pending admission.

**Not run:** the rewritten regression test and the seam have not been
compiled or executed. They need cd-core with DuckDB, a route that is not
admitted in this environment. The standalone lifecycle and cache batches were
not rerun, since only documentation and this DuckDB test changed. Code review
of the successor is not compilation, and every gate in §4 is still
outstanding.
