# War-Room release-qualification handoff v1

**Status:** isolated local integration; `main` and all source PRs remain untouched.

**As-of:** 2026-08-20

This is the current handoff for the collaborative War-Room demo and its
comparison path. It records what is proven, what is only opt-in, and what still
needs an environment-dependent rehearsal.

## Current integration state

The local branch is:

```text
codex/merge-consolidation-demo @ 58afcd79
```

The local qualification additions are in `e3e40a2e`; the portable compiled
qualification launcher is in `8854b26e`; the latest qualification evidence and
handoff corrections are in `58afcd79`, and the provider-free browser bridge
vertical is in `61f97868`. The branch is not published because
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
- server: 109 passed, 10 environment-gated skips;
- web: 36 tests;
- typecheck, lint, and static synthetic demo build.

The operator-readiness slice is now local and validated as well:

- `npm run doctor` reports a versioned, machine-readable status without
  contacting PostgreSQL, LDAP, Vercel, or a model provider;
- `npm run config:init -- --output PATH` creates a mode-600 private-demo
  template and required `.data/evidence` directory, and refuses accidental
  overwrite;
- doctor/config tests: 8 passed, including plaintext-LDAP rejection,
  external insecure-cookie rejection, malformed profile detection, secret-safe
  output, and initializer overwrite protection;
- the full server gate is now 109 passed / 10 environment-gated skips.

The direct bridge and server integration checks passed:

- Rust `collab_triage_run` unit boundary: 10 passed;
- Rust `collab_triage_run_cli`: 3 passed;
- Collab triage-run/Experiment Lab integration: 38 passed;
- Rust bridge executor tests: result ordering, bounded progress, timeout, and
  output overflow covered.

The new provider-free browser bridge vertical is also prepared:

- `COLLAB_E2E_BRIDGE=1` switches the Playwright fixture from the synthetic
  executor to the real `RustBridgeTriageExecutor`;
- the checked-in bridge command self-check passed with two candidates and
  persisted-lane progress events;
- e2e and server typechecks passed, and the focused triage-run suite remained
  green at 19 tests;
- the browser flow covers gateway-mode profile selection, bounded concurrency,
  same-snapshot completion, and pasted-chat handoff to Experiment Lab.

The full browser flow is not claimed locally because this workstation blocks
the fixture's `tsx` IPC pipe before Playwright can start. It is intended for
the hosted browser job once this branch can be published.

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
  jobs passed. Its base is the older remote `codex/merge-consolidation-v2`,
  so this is evidence for the earlier shipped collab shell, not for every
  launcher surface currently present only on the local merge branch.
- [PR #937](https://github.com/chriscase/ContextDesk/pull/937), Grok current-
  architecture qualification, head `bddc5afb`: hosted typecheck, lint, test,
  migration dry-run, PostgreSQL, and OpenLDAP-backed Collab job passed after
  the UUID storage-boundary regression fix.

Neither PR is merged, closed, or retargeted.

## Current Vercel live attempt

An owner-authorized, isolated `gateway diagnose --level basic` attempt was made
from this branch on 2026-08-20 using the protected-file credential reference
and the exact Vercel catalog model `openai/gpt-oss-120b`. The command used the
share-safe default (no private capture), attempted 15 of 23 bounded diagnostic
requests, removed 2 temporary corpora and 3 temporary sessions, and reported
no cleanup failures.

This is **not** a Vercel/model result. An independent catalog-discovery call
failed before HTTP with:

```text
DNS resolve failed for `ai-gateway.vercel.sh`
```

The diagnostic’s transport/response-contract failures are therefore treated as
local network-environment failures, not as evidence about GPT-OSS or Vercel.
The share-safe report contained no credential, endpoint, provider body, or
private capture. A rerun is appropriate after DNS/network access is restored.

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

1. **Real employer-provider execution is not yet evidenced in this
   environment.** The employer aliases (`gpt-oss-120b`, `qwen-3.6-27b`, and
   `ministral-3-14b-instruct-2512`) are not configured here. Vercel credentials
   were available through the protected-file reference, but DNS blocked the
   current attempt before a provider result was obtained.
2. **The next required rehearsal is hosted and vertical.** The provider-free
   fixture now drives the real `RustBridgeTriageExecutor` through the current
   GUI/server path. It still needs a hosted browser run on this exact branch,
   followed by explicitly enabled employer/Vercel runs when credentials and
   host profile ids are supplied.
3. **Local browser execution is sandbox-limited.** The hosted Cursor browser
   job is green; this workstation blocks both the `tsx` fixture IPC pipe and a
   compiled demo listener on `127.0.0.1`, so local Playwright/browser execution
   is not claimed.
4. **PostgreSQL is hosted-proven, not locally configured.** The local report
   uses memory plus filesystem evidence; hosted qualification covers the
   PostgreSQL path.
5. **The local merge branch is unpublished.** A future push or PR publication
   requires restored DNS/network access; this handoff does not imply that
   remote state contains `cac7ead6`.
6. **Provider quality is not certified.** The harness proves lifecycle,
   provenance, privacy, and comparison mechanics; it does not establish that
   any model reached the correct diagnosis.

## Next delegated milestone

The operator-ready initializer and `npm run doctor` slice is implemented and
locally validated at `cac7ead6`; the current-architecture demo/install prompt
has been handed to Grok Build as the next isolated slice. The next delegated
validation remains a hosted Cursor browser run against this exact branch,
followed by explicitly opt-in live rehearsals for the employer profiles and
Vercel after network access is restored. Those runs must retain the existing
redaction boundary: no credentials, prompts, endpoints, request ids, or raw
captures in Collab.
