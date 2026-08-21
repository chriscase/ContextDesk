# War-Room release-qualification handoff v1

**Status:** isolated published integration; `main` and all source PRs remain untouched.

**As-of:** 2026-08-21

This is the current handoff for the collaborative War-Room demo and its
comparison path. It records what is proven, what is only opt-in, and what still
needs an environment-dependent rehearsal.

## Current integration state

The published branch is:

```text
codex/merge-consolidation-demo (release-qualified implementation @
224ac8c4fcd0b8003000b45ae7665a595f182399)
```

The branch contains the qualification harness, portable launcher, provider-free
browser bridge vertical, selectively ported operator-readiness
contracts/configuration tools, and the opt-in live qualification runner
described below. GitHub DNS/network access is restored, and the exact branch
tip has been pushed; no PR write was performed.

The branch is published at `origin/codex/merge-consolidation-demo`; no PR was
opened for it. No merge, close, retarget, or rewrite was performed on any
external PR.

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

The current full local demo gate passes:

- contracts: 49 tests;
- server: 145 passed, 10 environment-gated skips;
- web: 41 tests;
- typecheck, lint, and static synthetic demo build.

The latest operator qualification pass at the current local HEAD also passes
honestly:

- `npm run qualify` completed all 9 memory-backed steps; PostgreSQL was skipped
  only because `COLLAB_TEST_ADMIN_URL` is not configured;
- `npm run qualify:live -- --json` reported all four requested aliases as
  `live_disabled`, with no provider invocation; and
- `npm run qualify:live -- --live --yes --json` exited 1 with
  `--live requires --profiles or COLLAB_LIVE_PROFILES`, while
  `npm run doctor -- --json` reported `ok: true`, zero errors, and two
  configuration warnings.

The exact-branch browser qualification now passes locally on a clean port:

- `COLLAB_E2E_BRIDGE=1 COLLAB_E2E_PORT=8900 npm run e2e` passed;
- 23 browser tests passed and 2 were intentionally skipped: process-restart
  persistence requires a durable server, and live-provider execution requires
  explicit credentials;
- the bridge scenario exercised three configured lanes, bounded concurrency,
  same-snapshot completion, and pasted-chat handoff to Experiment Lab.

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
- the full server gate is now 145 passed / 10 environment-gated skips.

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

The local memory qualification and artifact round-trip passed. The exact
published branch was then qualified remotely on commit
`224ac8c4fcd0b8003000b45ae7665a595f182399` by
[collab-qualify run 32452248915](https://github.com/chriscase/ContextDesk/actions/runs/32452248915).
Its hosted release qualification passed typecheck, lint, tests, build, memory
qualification, PostgreSQL qualification, configuration initialization, doctor,
sanitization, and share-safe artifact upload.

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
  block, with target identifiers and the current non-tombstoned contribution
  body visible for attribution. Tombstones and non-contribution events retain
  the event-payload fallback. Raw JSON remains available through the existing
  export/projection paths where appropriate; denied case writes now surface
  bounded generic permission alerts instead of being silently ignored; and the
  case composer exposes accessible names, keyboard-visible focus, and an
  explicit private/share-safe contribution choice.

The post-hardening qualification and demo gates remain green at the current
HEAD: 49 contract tests, 145 server tests with 10 environment-gated skips, 41
web tests, typecheck, lint, and static synthetic demo build. A local
qualification/doctor/sanitizer round-trip also passed with the required
`qualify-memory.json` and `doctor.json` outputs.

The final hosted run exposed one asynchronous web-test teardown race: a case
load could continue into the next test after the component had unmounted. The
case loader now aborts on unmount or case change and treats cancellation as
normal. Focused and full local web/Collab tests pass after this fix.

The opt-in live qualification runner is now local and validated:

- `npm run qualify:live -- --json` creates synthetic frozen evidence and
  reports all four lanes as skipped with `live_disabled`; it never invokes a
  bridge;
- a catalog-backed preflight preserves configured alias/model/provider
  provenance while remaining skipped;
- an explicit `--live --yes` invocation with no bridge reports
  `bridge_not_configured` rather than claiming a run and exits nonzero;
- any explicit live matrix that is partial, inconclusive, failed, or skipped
  exits nonzero; only a completed, same-snapshot matrix is a successful live
  qualification;
- fake-bridge tests cover same-snapshot execution, concurrency propagation,
  observed overlap, lane failures/unknowns, insufficient profiles, and the
  absence of raw summaries or durable host run ids in the report;
- the report is the strict, share-safe
  `cd-collab.live_qualification_report.v1` contract. It contains no raw
  output, prompts, credentials, endpoints, request ids, or host run ids.

The direct bridge and server integration checks passed:

- Rust `collab_triage_run` unit boundary: 11 passed;
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
  same-snapshot completion, and pasted-chat handoff to Experiment Lab;
- the provider-free bridge fixture emits valid SHA-256 output identities,
  matching the production host contract used by the Experiment Lab handoff.
- `.github/workflows/collab.yml` now has a separate `collab-browser-bridge` job,
  enables the bridge explicitly, uploads a distinct Playwright artifact, and
  supports `workflow_dispatch`; the default browser job remains provider-free.
- `.github/workflows/collab-qualify.yml` also supports `workflow_dispatch` for
  the memory/PostgreSQL/doctor qualification without any provider calls.

An earlier attempt was blocked by the workstation's loopback policy and then
exposed stale assertions and two fixture-contract defects. Those were corrected
locally: support panels are opened before their assertions, snapshot freezing
refreshes the run panel, the bridge request checks the actual `modelId` field,
and deterministic output hashes are valid SHA-256 digests. The fixture now uses
Node's ESM loader rather than the `tsx` CLI, so hosted runs do not depend on the
CLI's IPC pipe. The exact-branch hosted browser jobs are now authoritative:
[collab run 32452248880](https://github.com/chriscase/ContextDesk/actions/runs/32452248880)
passed the standard browser qualification, the provider-free Rust bridge
comparison browser qualification, and the full Collab typecheck/lint/test/
migration/build job. All jobs used the exact published commit above.

The final local CLI safety pass adds two fail-closed protections:

- a process-wide `CONTEXTDESK_PROVIDER_API_KEY` override is rejected when the
  selected comparison policies resolve to more than one provider profile;
  mixed employer/Vercel runs must use each profile's own Keychain or protected
  file reference; and
- progress claim text is rejected when it contains URLs, absolute/private
  paths, request/trace identifiers, or credential-shaped material. The
  owner-only benchmark record remains the source for full details.

Grok Build PR #940 added the stronger credential boundary and was selectively
integrated into this local branch after review. The CLI now binds the process
override to at most one selected Keychain-style provider reference; protected
`file:` references remain distinct, and mixed employer/Vercel profiles,
reviewer profiles, and retrieval-role credentials fail before library or
provider access. The integration passed `cargo test -p cd-cli --all-targets
--offline` (198 unit tests plus all CLI integration targets), including the
new mixed-provider isolation cases. A strict clippy run still encounters the
repository's existing `canonicalize` policy findings in `cd-core`; clippy with
that baseline lint waived is clean for the integrated tree.

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

### Exact published merge-branch evidence

The isolated merge branch is published, and both workflows passed on the exact
same SHA `224ac8c4fcd0b8003000b45ae7665a595f182399`:

- [collab-qualify run 32452248915](https://github.com/chriscase/ContextDesk/actions/runs/32452248915): hosted release qualification, including PostgreSQL and sanitized artifact upload;
- [collab run 32452248880](https://github.com/chriscase/ContextDesk/actions/runs/32452248880): full Collab checks, standard Playwright browser qualification, and the real provider-free Rust bridge browser qualification.

These runs validate the published isolated branch. They do not merge it and do
not change any source PR.

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
  hosted evidence for the workflow on its older base; the selectively ported
  workflow also passed on the exact published branch in run `32452248915`.
- [PR #940](https://github.com/chriscase/ContextDesk/pull/940), Grok mixed-
  provider credential isolation, remains draft/open at head `8202f248`. Its
  security slice was selectively integrated and revalidated on this local
  branch; the PR itself was not modified. Its current remote CI is not a
  substitute for this local validation and still has failing/in-progress Rust
  checks on that separate PR head.

None of these PRs is merged, closed, or retargeted.

The planned Claude Code adversarial UI/accessibility/security lane has no
active result to integrate. The available Claude control channel is archived,
and read-only Computer Use access to the Claude application was denied in this
session. No Claude-authored hardening change is therefore claimed.

## Current Vercel live evidence

An owner-authorized, isolated `gateway diagnose --level basic` run completed on
2026-08-21 from source build `583a9822bfe3`, using the protected-file
credential reference and the exact model `openai/gpt-oss-120b` discovered from
the current Vercel catalog. It used the share-safe default, made 19 of 23
bounded requests, removed 2 temporary corpora and 3 temporary sessions, and
reported no cleanup failures.

The scoped result is recorded in
`docs/benchmarks/VERCEL_GATEWAY_DIAGNOSTIC_GPT_OSS_WAR_ROOM_20260821.md`:

- gateway/model compatibility: **pass**;
- ContextDesk product workflow compatibility: **pass**;
- known-truth answer usefulness: **fail**, because the typed scorer rejected
  `typed_symptom_separation` for the linked-log triage case.

This is valid evidence about the exact Vercel/model/build combination, not a
universal GPT-OSS quality claim and not employer-gateway evidence. The failure
is retained as a useful product signal: the host completed the workflow and
withheld a usefulness claim rather than presenting an overconfident diagnosis.

Two additional exact Vercel catalog models were run against the same
diagnostic. The matrix is recorded in
`docs/benchmarks/VERCEL_GATEWAY_WAR_ROOM_MODEL_MATRIX_20260821.md`:

- `alibaba/qwen3.6-27b`: gateway compatibility, product workflow, and
  known-truth usefulness all **passed**; linked-log triage took about 158.5
  seconds;
- `mistral/ministral-14b`: gateway compatibility, product workflow, and
  usefulness all **failed**; the direct structured response had a contract
  failure and the product triage produced no visible terminal answer.

These are Vercel model IDs, not proof that the employer aliases with similar
names behave identically.

## What the current GUI can demonstrate

The current War-Room surface can:

1. create/open a case and select a frozen snapshot;
2. upload bounded evidence with an explicit privacy class and freeze a snapshot;
3. launch deterministic synthetic comparisons;
4. launch configured gateway comparisons through the host-owned Rust bridge;
5. select a profile per lane and choose bounded concurrency;
6. show run/lane lifecycle, partial results, evidence references, and unknown
   usage/cost;
7. compare completed runs for same-snapshot/shared-evidence signals;
8. import a pasted chat and hand it off with a connected run to Experiment Lab;
9. review similarities, differences, question paths, helpfulness, gold, and
   accepted decisions;
10. export a share-safe review projection.

Agreement is explicitly not correctness. Unknown values remain unknown.

The live qualification CLI is intentionally separate from the GUI's existing
gateway launcher: it is an operator qualification path for validating the
bridge/profile configuration and producing a portable report. The GUI remains
the collaborative surface for reviewing and adjudicating the resulting runs.

## Exact remaining risks

1. **Real employer-provider execution is not yet evidenced in this
   environment.** The employer aliases (`gpt-oss-120b`, `qwen-3.6-27b`, and
   `ministral-3-14b-instruct-2512`) are not configured here. Vercel now has a
   current, scoped GPT-OSS diagnostic result, but its known-truth usefulness
   scorer failed on typed symptom separation; it is not a clean quality pass.
2. **The next required rehearsal is provider-backed and vertical.** The exact
   branch now passes hosted browser, bridge, PostgreSQL, and full Collab
   qualification. The remaining live rehearsal is to supply private per-profile
   credentials for the employer gateway and/or Vercel and run the explicitly
   enabled lanes through the same GUI/bridge path.
3. **PostgreSQL is hosted-proven, not locally configured.** The local report
   uses memory plus filesystem evidence; hosted qualification covers the
   PostgreSQL path.
4. **The isolated merge branch is not merged.** It is intentionally published
   as `origin/codex/merge-consolidation-demo` for review, but no PR was opened
   and no source PR or `main` was changed.
5. **Provider quality is not certified.** The harness proves lifecycle,
   provenance, privacy, and comparison mechanics; it does not establish that
   any model reached the correct diagnosis.
6. **Claude-authored review remains unavailable.** The local component and
   adversarial tests cover the War-Room surfaces and the delegated audit
   findings were addressed locally, but no separate Claude Code patch/review
   has been obtained because that session was unavailable.
7. **Delegated-agent transport is unavailable in this environment.** Claude
   and Cursor Computer Use are not approved, while the direct Grok Build CLI
   could not create a session after DNS failure to its proxy and a local
   filesystem permission error. No delegated-agent result is claimed for the
   current branch.

## Next delegated milestone

The isolated release-qualification milestone is complete. The next milestone
is an authorized provider-backed rehearsal: configure private per-profile
credentials for the employer gateway and/or Vercel, run a small same-snapshot
matrix through the GUI bridge, inspect latency, terminal-answer, unknown, and
error semantics, and import the resulting share-safe comparison into
Experiment Lab. Real provider quality validation remains pending; neither it
nor a Claude-authored review is implied by the green hosted qualification runs.
