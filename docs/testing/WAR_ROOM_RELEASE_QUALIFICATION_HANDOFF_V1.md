# War-Room release-qualification handoff v1

**Status:** isolated local integration; `main` and all source PRs remain untouched.

**As-of:** 2026-08-20

This is the current handoff for the collaborative War-Room demo and its
comparison path. It records what is proven, what is only opt-in, and what still
needs an environment-dependent rehearsal.

## Current integration state

The local branch is:

```text
codex/merge-consolidation-demo (unpublished local branch; current HEAD)
```

The branch contains the qualification harness, portable launcher, provider-free
browser bridge vertical, and the selectively ported operator-readiness
contracts/configuration tools described below. It is not published because the
workstation could not resolve `github.com` during the last push attempt.

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

- contracts: 47 tests;
- server: 129 passed, 10 environment-gated skips;
- web: 36 tests;
- typecheck, lint, and static synthetic demo build.

The operator-readiness slice is now local and validated as well:

- `npm run doctor` reports the versioned share-safe
  `cd-collab.doctor_report.v1` contract without contacting PostgreSQL, LDAP,
  Vercel, or a model provider;
- `npm run config:init -- --profile demo|postgres|ldap --output PATH` creates
  a mode-600 profile-specific template and required `.data/evidence` directory,
  and refuses accidental overwrite;
- the versioned profile catalog contract rejects unknown fields, endpoints,
  and duplicate aliases; the operator suite has 19 passing tests, including
  plaintext-LDAP rejection, external insecure-cookie rejection, artifact and
  port checks, safe catalog parsing, secret-safe output, and initializer
  overwrite protection; the bridge runtime configuration has 4 additional
  focused tests;
- the generated `COLLAB_BRIDGE_BIN` name is wired through the production
  entrypoint, while legacy `COLLAB_TRIAGE_RUNNER` deployments remain supported;
- the full server gate is now 129 passed / 10 environment-gated skips.

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
- [PR #938](https://github.com/chriscase/ContextDesk/pull/938), Grok operator
  readiness, remains draft/open at head `eed1ffb5`. Its operator contract and
  configuration-shape improvements were selectively ported and revalidated on
  this local branch; the PR itself was not modified.

Neither PR is merged, closed, or retargeted.

The planned Claude Code adversarial UI/accessibility/security lane has no
active result to integrate. The available Claude control channel is archived,
and read-only Computer Use access to the Claude application was denied in this
session. No Claude-authored hardening change is therefore claimed.

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
On 2026-08-21, a DNS-only retry still could not resolve `ai-gateway.vercel.sh`,
so no second provider attempt was made.

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
   requires restored DNS/network access; a DNS-only check for `github.com` on
   2026-08-21 still failed, and this handoff does not imply that remote state
   contains the latest local handoff updates.
6. **Provider quality is not certified.** The harness proves lifecycle,
   provenance, privacy, and comparison mechanics; it does not establish that
   any model reached the correct diagnosis.
7. **Claude hardening remains unverified.** The current local component tests
   cover the War-Room surfaces, but a separate adversarial Claude review has
   not been obtained because the Claude session was unavailable.

## Next delegated milestone

The next Grok Build slice is an opt-in live-qualification runner layered on
the existing `RustBridgeTriageExecutor` and triage-job service. It should
exercise explicitly selected employer/Vercel profiles, preserve exact model
and snapshot provenance, and emit a versioned share-safe report without
credentials, prompts, endpoints, request ids, or raw captures. Its default
path must remain provider-free and hermetic. A hosted Cursor browser run
against the exact current branch and real provider rehearsals remain pending
until the branch can be published and the relevant network/profile access is
available.
