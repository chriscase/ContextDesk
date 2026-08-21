# War-Room release-qualification handoff v1

**Status:** isolated local integration; `main` and all source PRs remain untouched.

**As-of:** 2026-08-20

This is the current handoff for the collaborative War-Room demo and its
comparison path. It records what is proven, what is only opt-in, and what still
needs an environment-dependent rehearsal.

## Current integration state

The local branch is:

```text
codex/merge-consolidation-demo @ 8854b26e
```

The local qualification additions are in `e3e40a2e`; the portable compiled
qualification launcher is in `8854b26e`. The branch is not published because
the workstation could not resolve `github.com` during the last push attempt.

No merge, close, retarget, or rewrite was performed on any external PR.

## Proven locally

From `collab/`:

```text
npm run qualify
```

The current report proves:

- 9/9 qualification steps passed;
- content-addressed evidence was frozen and verified;
- bounded lane concurrency was 2/2 with same-snapshot identity;
- durable lane records were retained through cancellation, deadline, and
  partial-failure cases;
- an external strategy/chat trace was imported with a different question path;
- shared evidence, unique evidence, disagreement, helpfulness, gold alignment,
  and an accepted decision were recorded;
- share-safe export rejected secret-shaped fields and preserved lineage across
  a newer profile package;
- all live aliases were reported as not run rather than being fabricated.

The full local demo gate also passed:

- contracts: 41 tests;
- server: 106 passed, 10 environment-gated skips;
- web: 36 tests;
- typecheck, lint, and static synthetic demo build.

The direct bridge and server integration checks passed:

- Rust `collab_triage_run` unit boundary: 10 passed;
- Rust `collab_triage_run_cli`: 3 passed;
- Collab triage-run/Experiment Lab integration: 38 passed;
- Rust bridge executor tests: result ordering, bounded progress, timeout, and
  output overflow covered.

The standalone headless comparison package also passed:

```text
scripts/triage-comparison-demo.sh self-check
initialized a temporary library
imported the synthetic checkout case, snapshot, and three tasks
created four deterministic recorded/replay runs
self-check passed (4 runs; no provider calls)
```

This validates the offline fallback and report inputs separately from the
browser surface.

## Hosted delegated evidence

These remain draft and open:

- [PR #936](https://github.com/chriscase/ContextDesk/pull/936), Cursor browser
  qualification, head `760dae2a`: hosted Collab unit and Playwright browser
  jobs passed.
- [PR #937](https://github.com/chriscase/ContextDesk/pull/937), Grok current-
  architecture qualification, head `bddc5afb`: hosted typecheck, lint, test,
  migration dry-run, PostgreSQL, and OpenLDAP-backed Collab job passed after
  the UUID storage-boundary regression fix.

Neither PR is merged, closed, or retargeted.

## What the current GUI can demonstrate

The current War-Room surface can:

1. create/open a case and select a frozen snapshot;
2. launch deterministic synthetic comparisons;
3. launch configured gateway comparisons through the host-owned Rust bridge;
4. select a profile per lane and choose bounded concurrency;
5. show run/lane lifecycle, partial results, evidence references, and unknown
   usage/cost;
6. compare completed runs for same-snapshot/shared-evidence signals;
7. import a pasted chat and hand it off with a connected run to Experiment Lab;
8. review similarities, differences, question paths, helpfulness, gold, and
   accepted decisions;
9. export a share-safe review projection.

Agreement is explicitly not correctness. Unknown values remain unknown.

## Exact remaining risks

1. **Real provider execution is not yet evidenced in this environment.** The
   employer aliases (`gpt-oss-120b`, `qwen-3.6-27b`, and
   `ministral-3-14b-instruct-2512`) and the Vercel-compatible alias are not
   configured here, so no live result is claimed.
2. **The next required rehearsal is vertical.** A hermetic fixture must drive
   the real `RustBridgeTriageExecutor` through the GUI/server path, followed by
   an explicitly enabled employer/Vercel run when credentials and host profile
   ids are supplied.
3. **Local browser execution is sandbox-limited.** The hosted Cursor browser
   job is green; this workstation's `tsx` fixture launcher cannot open its IPC
   pipe under the current sandbox, so local Playwright execution is not claimed.
4. **PostgreSQL is hosted-proven, not locally configured.** The local report
   uses memory plus filesystem evidence; hosted qualification covers the
   PostgreSQL path.
5. **The local merge branch is unpublished.** A future push or PR publication
   requires restored DNS/network access; this handoff does not imply that
   remote state contains `8854b26e`.
6. **Provider quality is not certified.** The harness proves lifecycle,
   provenance, privacy, and comparison mechanics; it does not establish that
   any model reached the correct diagnosis.

## Next delegated milestone

Use the prepared Grok Build prompt for an end-to-end live rehearsal. It should
add a hermetic fixture for the real bridge, browser coverage for launch → run →
comparison-with-pasted-chat, and explicit opt-in instructions for employer and
Vercel profiles without placing credentials, prompts, endpoints, request ids,
or raw captures in Collab.
