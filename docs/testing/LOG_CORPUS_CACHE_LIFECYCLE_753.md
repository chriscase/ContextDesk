# Log corpus cache lifecycle — #753 verification record

Issue: [#753](https://github.com/chriscase/ContextDesk/issues/753) — make log-corpus
discard atomic and corpus opens single-flight.

Base: `b54844cb9e5a6e80bcde806e10ddcaf0d79fc2b6` (tree
`9ecc54e25c7facf610f9e6ce445245f64c5d048c`). Candidate: the commit on
`claude/contextdesk-753-corpus-cache-lifecycle` that adds this file.

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
  phase, and admitted-section counts. Discard = fence → `on_fenced` →
  drain → atomic rename into `log_corpora/.discarding/` → `Discarded`
  tombstone (bounded, `MAX_RETAINED_TOMBSTONES = 256`) → best-effort reclaim.
  Rollback on pre-rename failure; idempotent re-discard.
- `store.rs`: every `LogCorpus` carries a `CorpusLifecycleTicket`; `open`,
  `create`, staging and publication-validation opens are admitted;
  `with_connection` and fallible DuckDB accessors are fenced before (and
  `with_connection`/`load_all_events` after) the query; `discard_with` hook.
- `search.rs`, `why.rs`: explicit pre/post fences (`with_events` degrades load
  errors to empty, so a stale handle must not look like "no results").
- `reanalyze.rs`: sidecar replacement runs inside a lifecycle publication;
  stops once discarded; a fenced validation reopen rolls both sidecars back.
- `tool_host.rs`: stale slot hits and stale seeded preflight handles are
  rejected (slot released, never silently reopened); evidence tools re-check
  after computing; broad-triage phase checkpoints include the fence;
  `ensure_linked_log_corpus_live`.
- `agent.rs`: fence immediately before every linked-answer release (main
  loop, budget synthesis, synthesis retry, fast-triage, contribution,
  multi-model, multi-stage); stale-snapshot errors caused by a discard route
  to the dedicated `linked_log_corpus_discarded` terminal.
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
| Lifecycle | `corpus_lifecycle.rs` (all code + 15 tests) | `crate::error` (same `Message`/`Policy`/`Io` variants and `Display`), `tempfile::tempdir` |
| Desktop cache | `log_corpus_cache.rs` (all code + 11 tests) **and** the real `corpus_lifecycle.rs` | `cd_core::log_analysis::LogCorpus` replaced by a fake store with the same admit → read → finish(retry) structure, no DuckDB |

Results (each suite run three times, `--test-threads=8`):

```text
lifecycle_tests  : test result: ok. 15 passed; 0 failed (x3)
desktop_cache    : test result: ok. 11 passed; 0 failed (x3)
rustc -D warnings (lib + test targets)            : clean
clippy-driver -D warnings (lifecycle lib + test)  : clean
clippy-driver -D warnings (cache test target)     : clean
clippy-driver -D warnings -A dead_code (cache lib, harness has no lib.rs callers): clean
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

M3 initially survived (the drain assertion raced the rename); the drain tests
were strengthened with a bounded observation window that a correct discard can
never violate, after which M3 was detected.

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
  `query_result_that_overlapped_a_discard_start_is_rejected`,
  `failed_discard_changes_nothing_on_disk_and_can_be_retried`,
  `publication_makes_open_handles_non_current_and_new_opens_wait`.
- `reanalyze.rs`: `successful_reanalysis_makes_retained_handles_non_current_but_live`,
  `discard_before_publication_rejects_reanalysis_without_recreating_files`,
  `discard_waits_for_an_inflight_publication_then_wins_with_rollback`.
- `search.rs`: `search_on_a_discarded_handle_fails_closed_instead_of_returning_evidence`.
- `why.rs`: `why_analysis_on_a_discarded_handle_fails_visibly_instead_of_returning_empty`.
- `tool_host.rs`: `discarded_turn_corpus_stops_returning_evidence_and_fails_visibly`,
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
| Per-corpus single-flight: same-id coalesce, cross-id independent, hits unblocked | `SingleFlightCorpusCache::get_or_open` | PASS (+ M4 detected) |
| Preserve four-entry bound and deterministic reanalysis invalidation | `LOG_CORPUS_HANDLE_CACHE_CAP = 4`; content generation + `invalidate` after any finished re-analysis | `four_entry_lru_bound_is_preserved`, `republication_and_explicit_invalidation_force_a_reopen` PASS; reanalysis store tests NOT_RUN |
| Concurrency tests: coalescing, independence, failure/retry, reanalysis, discard, poisoned/cancelled init | cache + lifecycle suites | PASS in harness |
| Locks out of DuckDB open/query; lock ordering documented | module docs, handbook §6.9 | Review + M4 |
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
  rejected when it completes.
