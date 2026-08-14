# High-risk mutation report — 2026-07-24

> **Historical non-claim.** This report is retained as mutation-testing
> provenance only. It does not qualify the release evidence pin
> `c09357153e0c8953f2862c3cf3d8377ec9bc6bc7`. The recorded base commit is a
> verifiable ancestor, but the recorded mutation-tested feature commit
> `981d9f0a6d19ff3bb5d7196b6d8696c807836d36` is not present in this checkout's
> git object database, so the run cannot be reproduced or treated as exact
> release evidence here.

## Run identity

- Repository: `chriscase/ContextDesk`
- Base: `748264981c0ae01a9fcd177b61aefab6623c62c9`
- Mutation-tested feature-code commit:
  `981d9f0a6d19ff3bb5d7196b6d8696c807836d36`
- Tool: `cargo-mutants 27.1.0` installed with
  `cargo install cargo-mutants --locked`
- Rust: `rustc 1.92.0 (ded5c06cf 2025-12-08)`
- Default tests used no network, real credential, model, or cloud service.
- Raw outcome lists and the manual JSON result are under
  [`docs/mutation/2026-07-24`](mutation/2026-07-24).

The PR head contains this report-only follow-up commit in addition to the
feature-code commit above. The PR description and hosted CI identify that exact
final head.

## Scope

The run mutated the requested high-risk production paths:

- `git_source.rs`: canonical ContextDesk remote identity, canonical selection,
  proven-source gating, timeout deadline, termination, reaping, and status
  handling;
- `sessions.rs`: `estimate_context_chars`,
  `fit_model_context_to_budget`, and `prepare_model_context`;
- `agent.rs`: the shared hard-budget enforcement helper plus hand mutations at
  ambient recall, tools-disabled prefetch, and the final provider gate;
- `memory/sqlite_store.rs`: tag credential blocking, mixed redaction, and the
  `replace_tags` sanitizer call;
- `memory/facade.rs`: legacy candidate deletion failure and error-path
  redaction.

S3 Phase A was optional stretch work and was not mutated. The required Git,
context-budget, and memory surfaces were completed first; expanding into S3
would have diluted the classification and full-gate work for the mandatory
targets.

The final agent campaign was rerun after current main added per-model
`context_char_budget` handling in #429. Its six generated helper mutants and
the three call-site omissions therefore exercise the current `char_budget`
production path rather than the superseded fixed-default helper signature.

## Final results

Cargo-mutants generated 120 unique mutants in the selected functions on the
exact rebased feature-code commit.

| Surface | Total | Killed | Equivalent / uninteresting | Unviable | Timeout | Unexplained survivor |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Git identity and timeout | 18 | 17 | 0 | 1 | 0 | 0 |
| Session context preparation | 75 | 35 | 38 | 2 | 0 | 0 |
| Agent hard-budget helper | 6 | 6 | 0 | 0 | 0 | 0 |
| Memory privacy | 21 | 2 | 1 | 18 | 0 | 0 |
| **Cargo-mutants total** | **120** | **60** | **39** | **21** | **0** | **0** |

The conservative raw cargo-mutants kill rate is 60 of 99 compile-viable
mutants. All 39 survivors were inspected and classified below; no unexplained
test gap or timeout remains.

The pre-rebase discovery artifacts contain 121 outcome lines. A clean rebased
enumeration emitted 120 unique candidates: 75, rather than 76, in the context
batch. The extra discovery line was a second record of the same
`prepare_model_context` `||`-to-`&&` operator. The authoritative final context
lists are the `rebased-*` files; the earlier lists are retained to show the
discovery and classification process rather than silently rewriting it.

An interim rebased run used `--baseline skip` while a newly added
`prepare_model_context_summary_sets_compacted_flag` fixture contradicted the
existing product contract (summary presence alone must not set the UI
compaction flag). That run's apparent kills were invalid. The fixture was
removed, the focused baseline passed, and the entire context campaign was
rerun without `--baseline skip`; only that baseline-verified rerun is counted.

Cargo-mutants could not express the most important call-deletion and
`CoreResult` replacements on the agent and memory paths. The checked-in manual
harness therefore ran ten compile-valid mutations:

| Manual outcome | Count |
| --- | ---: |
| Killed | 9 |
| Equivalent | 1 |
| Survived — test gap | 0 |
| Timeout | 0 |
| Unviable | 0 |

## Survivors found and regressions added

### Legacy cleanup path disclosure

Three mutations to the `path length > 96` boundary initially survived. The
existing cleanup test proved fail-loud behavior but did not prove that a long
parent path was redacted from the returned policy error.

Added:

- `legacy_cleanup_failure_redacts_long_parent_path`

The two disclosure-widening boundary mutants then died. The `> 96` to `>= 96`
mutation redacts one additional boundary-length path; it is recorded as an
uninteresting, privacy-strengthening survivor rather than pinned to an
arbitrary display cutoff.

### Newest tool-group fitting

The existing `prepare_model_context_pairing_safe_tool_group_truncation`
fixture used an 80,000-character body under a 120,000-character budget. It
therefore never exercised the fitter. Mutations in the newest tool-parent walk,
including invalid index movement, survived or hung.

Changed/added:

- the original fixture now exceeds the production budget;
- `fit_model_context_protects_newest_tool_group_under_pressure` drives two
  consecutive tool results, crosses the tool group to its assistant parent,
  and asserts older content is shortened first;
- the test uses a bounded receive so non-terminating parent-walk mutants fail
  promptly.

The safety-relevant parent-walk mutants then died. Two valid-transcript
equivalents remain: `j > 0` to `j >= 0` still breaks at the found assistant,
and `assistant && tool_calls` to `assistant || tool_calls` selects the same
valid assistant parent.

### Proportional hard clamp

No original fixture exhausted the fitter's 64 selective truncation passes, so
mutations that skipped or corrupted the all-message hard clamp survived.

Added:

- `fit_model_context_many_messages_reaches_hard_clamp`

The regression creates 200 oversized messages, proves more than 64 receive
model-only truncation markers, preserves message structure, and requires the
result to fit the explicit budget.

### Keep-floor termination and exact boundaries

The broad context runs exposed four non-termination mutations:

- `protected_start -= 1` to `protected_start /= 1`;
- `over_budget && keep > 2` to `over_budget || keep > 2`;
- `keep > 2` to `keep == 2`;
- `keep > 2` to `keep >= 2`.

Added:

- `prepare_model_context_terminates_at_keep_floor`;
- `prepare_model_context_exact_budget_preserves_state`;
- `prepare_model_context_over_budget_reduces_keep`;
- `enforce_hard_budget_accepts_exact_budget`.

All four non-termination mutations were retried through the bounded regressions
and died. Exact-budget `==`/`>=` mutations and false compaction-state mutations
also died.

### Ambient recall and tools-disabled prefetch

The original ambient test allowed either a bounded provider call or a terminal
budget error and treated evidence that ambient recall ran as a soft check.
Deleting the post-ambient re-fit therefore survived. No product-path regression
exercised post-prefetch re-fit at all.

Changed/added:

- `agent_ambient_near_ceiling_stays_under_hard_budget` now requires real ambient
  retrieval, requires the provider call to complete, and proves the injected
  body exceeds available headroom;
- `agent_tools_disabled_prefetch_stays_under_hard_budget` drives the real
  ToolHost search, a gateway tools-rejection, a tools-disabled retry, and a
  prefetch that would exceed the hard budget without re-fit.

Manual deletion of either post-injection re-fit now dies.

### Tag policy and sanitizer

Compile-valid manual mutations proved that the shipped store tests kill:

- skipped credential-dominance rejection;
- skipped mixed-content redaction;
- bypassing `sanitize_memory_tags` in `replace_tags`;
- ignoring a legacy candidate removal failure.

The first manual draft accidentally mutated an earlier unrelated
`if r.blocked` site; the final checked harness targets occurrence 2, which is
the branch inside `sanitize_memory_tags`.

## Equivalent and uninteresting mutants

The authoritative context list is
[`rebased-equivalent-or-uninteresting.txt`](mutation/2026-07-24/context/rebased-equivalent-or-uninteresting.txt).
Its 38 entries fall into three classes:

1. **Equivalent boundaries.** Examples include checking `>=` at a boundary
   where the next statement immediately exits, or changing a valid
   assistant-with-tools parent predicate from `&&` to `||`.
2. **Alternative bounded truncation strategies.** Tie-breaking and arithmetic
   mutations may shorten a different eligible old message, skip directly to
   the proportional clamp, or shorten content more aggressively. The hard
   bound, system/newest protection, tool structure, and stored transcript
   remain intact; the contract does not promise byte-identical model-only
   truncation.
3. **Redundant detection gates.** Some final comparisons are already implied
   by an earlier return or by the truncation marker whenever length decreases.

The one memory survivor changes the display-only redaction threshold from
`> 96` to `>= 96`; it redacts one additional boundary-length path and does not
weaken the privacy policy.

The manual final-provider-gate deletion is behaviorally equivalent while all
current entries are bounded by preparation, reactive re-preparation, or
post-injection fitting. The independent ambient and prefetch omission mutants
prove those upstream gates rather than using the final gate to hide a missing
re-fit.

The original
[`context/equivalent-or-uninteresting.txt`](mutation/2026-07-24/context/equivalent-or-uninteresting.txt)
is retained as the pre-rebase review record. The `rebased-*` files supersede it.

## Unviable mutations

- Git: `Instant::now() + timeout` to multiplication does not type-check.
- Sessions: cargo-mutants generated invalid constructors for
  `Result<Vec<ChatMessage>, ContextBudgetError>` and
  `Result<PreparedModelContext, ContextBudgetError>`.
- Memory: 18 generated replacements used invalid `CoreResult::new`,
  `CoreResult::from_iter`, or mismatched `Result` values.

The memory unviables are why the compile-valid manual harness is required.
They are not counted as killed.

## Reproduction

The checked manual batch is:

```text
scripts/mutation/manual_high_risk.py \
  --output /tmp/contextdesk-manual-high-risk.json \
  --timeout 120 \
  --tested-sha 981d9f0a6d19ff3bb5d7196b6d8696c807836d36
```

The cargo-mutants batches were:

```text
cargo mutants -p cd-core \
  -f crates/cd-core/src/git_source.rs \
  -F 'is_canonical_contextdesk_remote|select_canonical_remote|is_proven_contextdesk_source|run_git_timeout|terminate_git_child' \
  -j 1 --timeout 120 --minimum-test-timeout 30 --colors never -- git_source

cargo mutants --in-place --baseline skip -p cd-core \
  -f crates/cd-core/src/memory/sqlite_store.rs \
  -f crates/cd-core/src/memory/facade.rs \
  -F 'sanitize_memory_tags|replace_tags|cleanup_legacy_candidate_files' \
  --timeout 90 --minimum-test-timeout 20 --colors never -- memory

cargo mutants --in-place -p cd-core \
  -f crates/cd-core/src/sessions.rs \
  -F 'estimate_context_chars|fit_model_context_to_budget|prepare_model_context' \
  --timeout 90 --minimum-test-timeout 20 --colors never -- prepare_model_context

cargo mutants --in-place -p cd-core \
  -f crates/cd-core/src/agent.rs \
  -F 'estimate_context_chars|enforce_hard_context_budget' \
  --timeout 90 --minimum-test-timeout 20 --colors never -- hard_budget
```

The focused outcome lists preserve the exact killed, timeout, unviable, and
classified names. For context, `rebased-broad-caught.txt`,
`rebased-parent-rerun-caught.txt`, `rebased-hard-clamp-rerun-caught.txt`,
`rebased-broad-timeout.txt`, `rebased-timeout-rerun-caught.txt`,
`rebased-equivalent-or-uninteresting.txt`, and `rebased-unviable.txt` are the
authoritative final evidence. Git, context, and agent included passing
unmutated baselines in the cargo-mutants run. The memory rerun used its passing
focused baseline immediately before the explicitly skipped baseline phase.
`--in-place` runs were single-threaded; the worktree was checked after every
run to confirm production source was restored.

## Issue disposition

Mutation testing found test gaps, but no surviving mutation demonstrated a
literal shipped acceptance-criterion failure in #33 or #340. Those issues were
not reopened. #385 and #275 remain open for their already-documented broader
product residuals; this work does not close them.
