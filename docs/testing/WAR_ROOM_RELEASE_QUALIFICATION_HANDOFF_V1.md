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
browser bridge vertical, selectively ported operator-readiness
contracts/configuration tools, and the opt-in live qualification runner
described below. It is not published because the
workstation could not resolve `github.com` during the last push attempt. A later
read-only fetch of PR #939 succeeded, but this branch remains unpublished.

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

- contracts: 49 tests;
- server: 137 passed, 10 environment-gated skips;
- web: 37 tests;
- typecheck, lint, and static synthetic demo build.

The exact-branch browser attempt was also checked:

- `npm run typecheck -w @cd-collab/e2e` passed;
- `npm run test -w @cd-collab/e2e` could not start its fixture because this
  environment denies the loopback listener (`listen EPERM 127.0.0.1:8788`).
  No browser result is claimed from that failed start.

The operator-readiness slice is now local and validated as well:

- `npm run doctor` reports the versioned share-safe
  `cd-collab.doctor_report.v1` contract without contacting PostgreSQL, LDAP,
  Vercel, or a model provider;
- `npm run config:init -- --profile demo|postgres|ldap --output PATH` creates
  a mode-600 profile-specific template and required `.data/evidence` directory,
  and refuses accidental overwrite;
- the versioned profile catalog contract rejects unknown fields, endpoints,
  and duplicate aliases; the operator suite has 20 passing tests, including
  plaintext-LDAP rejection, external insecure-cookie rejection, artifact and
  port checks, safe catalog parsing, secret-safe output, and initializer
  overwrite protection; the bridge runtime configuration has 4 additional
  focused tests;
- the generated `COLLAB_BRIDGE_BIN` name is wired through the production
  entrypoint, while legacy `COLLAB_TRIAGE_RUNNER` deployments remain supported;
- the full server gate is now 137 passed / 10 environment-gated skips.

The hosted release-qualification slice from Grok Build PR #939 was reviewed
against the current branch and selectively integrated locally in commit
`805d9357`:

- `.github/workflows/collab-qualify.yml` runs Node 22, memory qualification,
  PostgreSQL 16 qualification, configuration initialization, and doctor;
- `qualification-cli` and `doctor-cli` can persist their typed JSON reports;
- the CI artifact sanitizer accepts only typed share-safe doctor,
  provider-free qualification, and provider-free live-qualification reports;
- live provider lanes are rejected before artifact upload, and raw reports are
  never uploaded; and
- the sanitizer has focused tests for valid reports, live-run rejection, and
  secret/privacy failures.

The local memory qualification and artifact round-trip passed. The hosted
workflow itself has not run for this unpublished branch, and PostgreSQL remains
environment-gated locally.

The local follow-up hardening after reviewing Grok Build PR #939 is also green:

- PostgreSQL qualification migrates with the disposable admin connection but
  exercises the catalog, case, audit, and experiment stores through the
  least-privilege `collab_app` connection;
- hosted qualification uses the compiled CLIs once the build is complete,
  initializes the explicit `postgres` profile, and requires the memory,
  PostgreSQL, and doctor reports before upload; empty or partial report sets
  are rejected;
- generated environment files are mode 600 even when an existing file is
  force-overwritten, and an explicitly requested live run that cannot form a
  two-lane gateway comparison exits nonzero instead of silently succeeding;
- case navigation invalidates stale timeline, snapshot-board, and Experiment
  Lab responses; owner-only imported chat output is hidden from other case
  members; failed imports preserve their form; and visible export findings
  mask credential- and endpoint-shaped excerpts; and
- timeline payloads are presented as readable fields rather than a raw JSON
  block. Raw JSON remains available through the existing export/projection
  paths where appropriate.

The full post-hardening demo gate passed: 49 contract tests, 138 server tests
with 10 environment-gated skips, 37 web tests, typecheck, lint, and static
synthetic demo build. A local qualification/doctor/sanitizer round-trip also
passed with the required `qualify-memory.json` and `doctor.json` outputs.

The opt-in live qualification runner is now local and validated:

- `npm run qualify:live -- --json` creates synthetic frozen evidence and
  reports all four lanes as skipped with `live_disabled`; it never invokes a
  bridge;
- a catalog-backed preflight preserves configured alias/model/provider
  provenance while remaining skipped;
- an explicit `--live --yes` invocation with no bridge reports
  `bridge_not_configured` rather than claiming a run;
- fake-bridge tests cover same-snapshot execution, concurrency propagation,
  observed overlap, lane failures/unknowns, insufficient profiles, and the
  absence of raw summaries or durable host run ids in the report;
- the report is the strict, share-safe
  `cd-collab.live_qualification_report.v1` contract. It contains no raw
  output, prompts, credentials, endpoints, request ids, or host run ids.

The direct bridge and server integration checks passed:

- Rust `collab_triage_run` unit boundary: 10 passed;
- Rust `collab_triage_run_cli`: 3 passed;
- Collab triage-run/Experiment Lab integration: 38 passed;
- Rust bridge executor tests: result ordering, bounded progress, timeout, and
  output overflow covered.

The War-Room UI also bounds and redacts provider-shaped error responses before
they reach the visible alert surface; the focused regression test covers
authorization-shaped text, gateway endpoints, and token-like content.

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
the fixture's loopback listener before Playwright can start. The fixture now
uses Node's ESM loader rather than the `tsx` CLI, so hosted runs do not depend
on the CLI's IPC pipe. It is intended for the hosted browser job once this
branch can be published.

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
- [PR #939](https://github.com/chriscase/ContextDesk/pull/939), Grok hosted
  release qualification, remains draft/open at head `52f651ba`. Its remote
  workflow run `32440407855` passed the complete job, including memory and
  PostgreSQL qualification, doctor, sanitization, and artifact upload. The
  sanitized artifact was retained by GitHub as artifact `9432232253`. This is
  hosted evidence for the workflow on its older base; the workflow was
  selectively ported to this local branch and has not run here remotely.

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
No additional provider attempt was made after the DNS failure.

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

The live qualification CLI is intentionally separate from the GUI's existing
gateway launcher: it is an operator qualification path for validating the
bridge/profile configuration and producing a portable report. The GUI remains
the collaborative surface for reviewing and adjudicating the resulting runs.

## Exact remaining risks

1. **Real employer-provider execution is not yet evidenced in this
   environment.** The employer aliases (`gpt-oss-120b`, `qwen-3.6-27b`, and
   `ministral-3-14b-instruct-2512`) are not configured here. Vercel credentials
   were available through the protected-file reference, but DNS blocked the
   current attempt before a provider result was obtained.
2. **The next required rehearsal is hosted and vertical.** PR #936’s hosted
   browser job passed on its older base, and the local `collab.yml` workflow
   contains the same browser lane. It still needs a hosted browser run on this
   exact branch, followed by explicitly enabled employer/Vercel runs when
   credentials and host profile ids are supplied.
3. **Local browser execution is sandbox-limited.** The hosted Cursor browser
   job is green; this workstation blocks the fixture listener on `127.0.0.1`,
   so local Playwright/browser execution is not claimed.
4. **PostgreSQL is hosted-proven, not locally configured.** The local report
   uses memory plus filesystem evidence; hosted qualification covers the
   PostgreSQL path.
5. **The local merge branch is unpublished.** A future push or PR publication
   requires restored DNS/network access; the last DNS-only check for
   `github.com` failed, and this handoff does not imply that remote state
   contains the latest local handoff updates.
6. **Provider quality is not certified.** The harness proves lifecycle,
   provenance, privacy, and comparison mechanics; it does not establish that
   any model reached the correct diagnosis.
7. **Claude hardening remains unverified.** The current local component tests
   cover the War-Room surfaces. The delegated audit findings were addressed
   locally, but a separate Claude-authored patch/review has not been obtained
   because the Claude session was unavailable.

## Next delegated milestone

The hosted release-qualification slice and its local hardening are now
implemented. The next delegated milestone is a hosted browser qualification
run against this exact branch, followed by explicit employer/Vercel rehearsals
when credentials and host profile ids are supplied. Real provider quality
validation remains pending; neither it nor a Claude-authored review is implied
by a green hosted qualification run.
