# War-room dream-stack qualification v1

**Status:** disposable integration branch. Draft-only. Do not merge.

**Purpose:** prove whether ContextDesk’s current manual intake, provenance,
model comparison, decision cockpit, privacy export, workflow shell,
authentication, retired-source enforcement, snapshot contract, and browser
compatibility work together when the pinned war-room draft PRs are applied as
**exact deltas** onto `merge/war-room-pilot`.

**Handbook impact:** none — this branch only assembles already-authored draft
deltas plus this report. Integration edits are conflict resolutions and
combined-stack lint/locator repairs on allowlisted files. No new architecture,
trust-boundary, or evidence-flow chapter is introduced here.

This is not a live-provider, employer-profile, or production-readiness claim.
No credentials, employer data, or generated qualification artifacts are
committed.

**Integration-ready (collab war-room surfaces): yes**, with the residuals
listed at the end. Title stays `DO NOT MERGE`.

## Start gate

| Item | Value | Result |
| --- | --- | --- |
| Repo | `chriscase/ContextDesk` | used |
| Lander | `merge/war-room-pilot` @ `b93dc17ba2e13225d54f0193ecdf3872998082e6` | exact match (also current `main` at assembly) |
| Qualification branch | `cursor/war-room-dream-stack-qualification-v1` | created from the lander; was absent on `origin` |
| Source PRs | #942–#960 | all `draft` + `open` at the pinned heads **before** work began |

Pinned source heads (verified via GitHub PR `head.sha` before assembly; none
were commented on, pushed, retargeted, rebased, or merged by this work):

| PR | Pinned head | Base | Role |
| --- | --- | --- | --- |
| #942 | `0c82327987dcd457abec9a6a7f23ecbe1d82d938` | lander | bench-run → strategy_package converter |
| #944 | `b9e0e2938ab5c53679c55db90514d95ddb6a0ddb` | lander | GUI honesty, lane picker, one-step freeze |
| #945 | `9b1d76d5f4e4f7b31aca8e7c56c32197bf9b665c` | lander | fail-closed import outcome |
| #946 | `80d7ec2acf7a2e9c2d9f2d0667c31820bd84174d` | lander | 3-lane proof attempt note |
| #947 | `9baea25c9c1fb6619aeb8c57d6b7bc595aef2e99` | lander | guided Capture→Analyze→Compare→Decide workspace |
| #948 | `bfb76e5a2aff09ec7720309b79ef64ea069c411e` | #947 | browser import helper for guided capture |
| #949 | `a31494c16e6a8f8da064ff4105a7f73939e9d244` | #947 | source & provenance library |
| #950 | `60d5e5b2586eb152feb4d516c9508008e9ddbf0a` | #949 | source-aware imported-run honesty |
| #951 | `aab0fce2309eba96b668f48dbdc9a266ec3bff22` | #944 | Experiment Lab scan strip |
| #952 | `6a56f47b81f33e4acbde2d2fdee99acb8edd7f16` | #951 | workbench mobile containment |
| #953 | `edc2265ef937e98455952c5df9edf3ac23806feb` | lander | server retired-source import rejection |
| #954 | `ef764714a546845b6d8f3f2734cac39ba7dd895a` | #950 | retired-source-safe intake chooser |
| #955 | `6b93f84a9a0f69afbe5ea71b7942fae5204e5282` | #954 | browser helper on retired-source intake stack |
| #956 | `fca0e256936827d057ed1352789cf2abe31f4222` | lander | export panel states / a11y |
| #957 | `b11ac12a5e754a6c60ef67c09ae6acce39b5e4fc` | lander | workflow stage navigator |
| #958 | `08d7ca1dfa5157083489c44246b6574f39aca882` | #957 | honest sign-in states |
| #959 | `84f95cd0fcc252f1abb9795e5f5bfe7f7d780c78` | lander | `cd-collab.snapshot.v1` contract |
| #960 | `21c5470587b56ae26119a147ea2f7467bec2ec1a` | #952 | decision-readiness cockpit |

### Source-PR staleness after assembly (not mutated)

Re-checked after qualification commands. #942–#959 still match the pins above
(`draft` + `OPEN`).

**#960 moved after assembly.** Current GitHub head is
`1049947ea0d5efd9aa1ebbc40b070fa6ef7e9295` on
`claude/decision-readiness-cockpit-fable`. The pin
`21c5470587b56ae26119a147ea2f7467bec2ec1a` is **not** an ancestor of that
rewrite (`git merge-base --is-ancestor` exited 1). Diff vs pin:

```text
collab/web/src/ExperimentLab.test.tsx    | 33 +
collab/web/src/ExperimentLab.tsx         |  7 +-
collab/web/src/styles/experiment-lab.css | 46 +-
3 files changed, 77 insertions(+), 9 deletions(-)
```

The rewrite adds a unit test that keeps a single `table.experiment-lab__matrix`
and a separately classed cross-examination table. This qualification **stayed
pinned** to `21c54705` and repaired the #952 browser locator instead (see
conflicts). Source branch was not retargeted, rebased, or force-pushed by this
work.

## Assembly

Exact PR deltas (`git cherry-pick` of unique commits vs each PR’s declared
base), not stacked heads, in the requested dependency order:

1. Independent lander children: #942 (4 commits), #944, #945, #946, #947,
   #953, #956, #957, #959.
2. #944 stack: #951 → #952 → #960 (pinned `21c54705`).
3. #947 provenance stack: #949 → #950 → #954.
4. Browser compatibility deltas: #948 then #955.
5. #957 child: #958.

Write allowlist = union of those unique diffs + this report. Verified after
assembly:

- unique-file union + report = **108 paths**
- `git diff --name-only` lander…HEAD = **108 paths**
- extras = none; missing = none

`git diff --shortstat b93dc17ba2e13225d54f0193ecdf3872998082e6 HEAD` after the
Tauri boxing commit and this report: **108 files**, insertions/deletions
recorded in the handoff section (report expansion changes the insertion count
relative to the first assembly push).

### Conflict resolutions (allowlisted files only)

| When | File | Resolution |
| --- | --- | --- |
| #944 onto #942 | `collab/web/src/TriageRunPanel.tsx` | Keep both state groups: #942 bench-artifact import (`benchArtifactText` / busy / experiment id) **and** #944 `lanePickerError`. One conflict hunk; both UIs remain. `ExperimentLab.*` and CSS auto-merged. |
| #951 onto #942+#944 | `collab/web/src/ExperimentLab.test.tsx` | Keep #951’s scan-strip tests **and** #942’s bench-artifact import test. Implementation/CSS auto-merged. |
| #955 onto #948 | `collab/e2e/src/helpers.ts` | Empty cherry-pick. #948 and #955 produce **byte-identical** helper files (same unique path, same bytes). #948 applied once after #954. #955 skipped rather than duplicating the delta. |
| Combined browser | `collab/e2e/specs/08-responsive-a11y.spec.ts` | #960 (pinned) adds a second table with classes `experiment-lab__matrix experiment-lab__crossexam`. #952’s `table.experiment-lab__matrix` / `.experiment-lab__matrix-wrap` locators then match two nodes in Playwright strict mode. Spec now uses `getByRole("table", { name: /Candidate comparison/ })` and wraps with `.filter({ has: comparisonTable })`. |
| Combined browser | `collab/web/src/ExportPanel.tsx` | #956 persistent selection count used `role="status"`, colliding with triage handoff `getByRole("status")` in uneditable `10-bridge-comparison.spec.ts`. Count is now `aria-live="polite"` without `role="status"`. Playwright serves `collab/web/dist` — web package rebuilt before re-run. |
| Combined host lint | `desktop/src-tauri/src/lib.rs` | #945’s `ImportCommandErrorDto` embeds `ImportOutcomeReport`, so `ingest_log_path` / `log_run_import` fail `clippy::result_large_err` under `-D warnings` (≥264 byte `Err`). Outcome field boxed; serde JSON for the webview is unchanged (`Box<T>` serializes as `T`). |

Cherry-pick SHAs differ from source tips where conflicts were resolved
(#944 → `8e46cca8`, #951 → `9cb1d8b3`).

### Superseded helper behavior

The lander’s `Prompt (optional)` / always-select-visibility helper is
superseded once. The combined helper:

- fills `External run output` and optional `External run prompt (optional)`
  through form-scoped accessible names;
- opens `Provenance details (visibility, snapshot)` only when visibility is
  supplied;
- leaves the closed disclosure and `unknown` default when visibility is
  omitted.

That single helper serves both #947 guided intake and #954 retired-source
intake (active-source options still render as `{name} ({kind})`). Both locators
are present in `collab/e2e/src/helpers.ts` on this branch.

### Stack dependencies (as assembled)

```text
lander b93dc17b
├── #942 converter
├── #944 GUI honesty
│     └── #951 scan strip
│           └── #952 mobile containment
│                 └── #960 decision-readiness cockpit (pinned 21c54705)
├── #945 import outcome
├── #946 3-lane attempt note
├── #947 guided workspace
│     ├── #948/#955 identical browser helper (applied once)
│     └── #949 provenance library
│           └── #950 source-aware honesty
│                 └── #954 retired-source intake UI
├── #953 retired-source server enforcement
├── #956 export panel
├── #957 workflow navigator
│     └── #958 login honesty
└── #959 snapshot contract
```

#942 and the #944→#960 stack both edit Experiment Lab / run panel / cases
CSS. Combined stack keeps converter paste-import **and** the cockpit.

## Qualification commands

Host notes for Rust: default `c++` is clang 18 (duckdb-sys fails `#include <memory>`).
Commands below used `CC=gcc CXX=g++`,
`LIBRARY_PATH=/usr/lib/gcc/x86_64-linux-gnu/13`,
`RUSTFLAGS=-C link-arg=-L/usr/lib/gcc/x86_64-linux-gnu/13`, and
`eval "$(scripts/local-build-cache.sh activate)"`.

### Product / whitespace / pins

| Command | Result |
| --- | --- |
| `git diff --check b93dc17ba2e13225d54f0193ecdf3872998082e6 HEAD` | **pass** (exit 0) |
| Unique PR-delta union vs `git diff --name-only` lander…HEAD | **108 = 108**, extras none |
| Source PR `head.sha` vs pin table before assembly | **pass** |
| Source PR `head.sha` after qualification | #942–#959 **match**; #960 **stale** (see above) |
| Generated output / secrets in git | **none** (e2e `test-results/`, `web/dist`, Tauri `gen/schemas` untracked/gitignored) |

### Collab install / typecheck / lint / tests / build

From `collab/` after `npm ci` (`/tmp/dream-stack-qualify/collab-gate.log`):

| Command | Result |
| --- | --- |
| `npm run typecheck` | **pass** (`typecheck_exit=0`) |
| `npm run lint` | **pass** (`lint_exit=0`; eslint boundaries deprecation warnings only) |
| `npm test` | **pass** — contracts **63**; server **149 passed / 10 skipped**; web **123** |
| `npm run build` | **pass** (`build_exit=0`) |
| `npm run migrate:dry-run` (default postgres, no `COLLAB_DATABASE_URL`) | **fail** (`missing required environment variable: COLLAB_DATABASE_URL`) — expected on this host |
| `COLLAB_STORAGE=sqlite COLLAB_SQLITE_PATH=/tmp/cd-collab-qualify.sqlite npm run migrate:dry-run` | **pass** — `SQLite schema ready: /tmp/cd-collab-qualify.sqlite` |

### Synthetic Capture→Analyze→Compare→Decide (offline)

`npm run qualify -- --backend memory` in `collab/`
(`/tmp/dream-stack-qualify/collab-qualify.log`):

- **9/9 steps passed** (`qualify_memory_exit=0`)
- comparison: shared=1 unique=2 disagreements=1 unknowns=0 questions=2
- decision accepted=true, gold=true
- lineage `pkg-synth-three-model-checkout-v1` → `v2`
- live aliases skipped with `credentials_not_configured` (honest; no live calls)

Postgres qualify was **not** run locally (no `COLLAB_DATABASE_URL`). GitHub
`collab hosted release qualification` on this PR ran memory **and** postgres
qualify and **passed**.

### Browser / bridge / responsive / a11y / login / intake / export

Playwright serves `collab/web/dist`. After the combined-stack UI locator
repairs and a web rebuild:

| Command | Result |
| --- | --- |
| `npm run test -w @cd-collab/e2e` | **22 passed, 3 skipped** (`e2e_full_exit=0`) |
| Skips | durable process restart (no durable server); live profile; bridge without `COLLAB_E2E_BRIDGE` |
| `COLLAB_E2E_BRIDGE=1 npm run test -w @cd-collab/e2e -- specs/10-bridge-comparison.spec.ts` | **1 passed** (`bridge_after_fix_exit=0`) |
| `specs/06-lanes-and-states.spec.ts` | **3 passed** |
| Login (`01-local-auth-login`) | **4 passed** |
| Import chat (`04-import-chat`) | **1 passed** |
| Export (`05-export-share-safe`) | **3 passed** |
| Responsive/a11y (`08-responsive-a11y`) | **2 passed** (login landmarks; 375px comparison matrix) |

Unit coverage on the same surfaces (web vitest): `LoginForm` 13, `TriageWorkspace`
24 (includes `retired-source-safe manual intake`), `Catalog` 13, `ExperimentLab`
30, `ExportPanel` 9, `App` 8, `CaseBoardPanel` 5.

### Desktop UI

From `desktop/` after `npm ci` (`/tmp/dream-stack-qualify/desktop-gate.log`,
`desktop-test-build.log`):

| Command | Result |
| --- | --- |
| `npm run typecheck` | **pass** |
| `npm run lint` | **pass** with **9 warnings / 0 errors** (pre-existing hooks/eslint-disable; files not in this allowlist except import-flow which did not add those warnings) |
| `npm test` | **198 files / 1931 tests passed** |
| `npm run build` (vite) | **pass** |

### Rust workspace

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | **pass** after rustfmt on `crates/cd-triage-bench-adapter/src/collab_export.rs` (commit `0fb2e6bf`) |
| `cd desktop/src-tauri && cargo fmt -- --check` | **pass** |
| `cargo clippy --workspace --all-targets -- -D warnings` | **fail** (`clippy_deny_exit=101`): lander-preexisting `clippy::chunks_exact_to_as_chunks` at `crates/cd-core/src/memory/sqlite_store.rs:1108`. File **not** in the allowlist; `git diff` vs lander is empty. Not fixed here. |
| `cargo clippy --workspace --all-targets -- -D warnings -A clippy::chunks_exact_to_as_chunks` | **pass** (`clippy_allow_exit=0`) |
| Allowlisted crate clippy (`cd-triage-bench-adapter`; `cd-core`/`cd-cli`/`cd-workflow` with the lander allow) | **pass** |
| Relevant crate tests | `import_outcome` lib **21**; `import_outcome_contract` **10**; ingest `--lib ingest` **100**; `import_outcome_cli` **4**; `import_production` **6**; bench-adapter `collab_export` **2** — all pass |
| `cargo test --workspace` | **pass** (`test_workspace_exit=0`): **4026 passed**, **0 failed**, **21 ignored** across 159 result lines |
| `cargo run -p cd-server -- --print-branding` | **pass** — `ContextDesk (contextdesk) — Developer knowledge workbench — find, synthesize, remember.` |
| `cd desktop/src-tauri && cargo clippy -- -D warnings` (CI tauri-host command) | **fail** on #945 unboxed DTO; **pass** after boxing (`tauri_clippy_deny_exit=0`) |
| `cd desktop/src-tauri && cargo check` | **pass** (`tauri_check_exit=0`) |

WebKit/GTK packages from the CI `tauri-host` job were installed so `gdk-3.0` /
`webkit2gtk-4.1` pkg-config succeeded. `apt-get` exited 100 on unrelated
`fuse3` / `xdg-desktop-portal` configure errors; the required GTK/WebKit
dev packages were present (`ii`).

### GitHub CI on PR #961 (head `939942d5` at that run)

`.github/workflows/ci.yml` rust/desktop jobs only fire for PRs targeting
`main`. This PR targets `merge/war-room-pilot`, so collab workflows are the
hosted CI that ran:

| Check | Conclusion |
| --- | --- |
| collab (typecheck, lint, test, migrate dry-run) | **success** (duplicate runs from two pushes) |
| collab war-room browser qualification | **success** |
| collab war-room browser bridge qualification | **success** |
| collab hosted release qualification (memory + postgres) | **success** |

Later commits (Tauri boxing + this report) do not touch `collab/**`, so those
collab jobs are not expected to re-run.

## Surface verification (what was proven)

| Surface | Evidence |
| --- | --- |
| Login / authentication | e2e `01-local-auth-login` 4/4; `LoginForm.test.tsx` 13; #958 on the stack |
| Manual intake | e2e `04-import-chat`; `TriageWorkspace` tests; qualify capture steps |
| Source provenance | `Catalog.test.tsx`; imported-run honesty tests; #949/#950 |
| Retired-source history | `retired-source-safe manual intake` describe; server `import.test.ts` via #953; catalog still lists retired sources |
| Comparison | e2e `06-lanes-and-states`; Experiment Lab 30 tests; qualify comparison object |
| Decision cockpit | qualify `compare_and_decide` passed; #960 pinned cockpit on the stack |
| Privacy export | e2e `05-export-share-safe` 3/3; `ExportPanel` 9 tests |
| Workflow navigation | `App.test.tsx`; #957 navigator on the stack |
| Snapshot contract | contracts snapshot tests in the 63; #959 fixtures/schema |
| Browser compatibility | full e2e 22/3; responsive 375px matrix; #948/#955 helper once |
| Bridge | local `COLLAB_E2E_BRIDGE=1` 1/1; GitHub bridge job success |
| Hosted | GitHub hosted qualify success (postgres + memory) |

## Commits on this branch (`lander..HEAD` at report time)

```text
0d6831e3 fix(tauri): box import-command error outcome for host clippy
939942d5 fix(collab): resolve combined-stack browser strict-mode collisions
0fb2e6bf style: rustfmt bench-adapter export tests for combined-stack gate
0afaa716 docs: record war-room dream-stack assembly and start-gate pins
e68cbbaf collab web: honest sign-in states, retry, and assistive-tech wiring
7451874a test(e2e): keep import helper compatible with guided capture
b599e0ea web: retired-source-safe manual intake with preserved attribution
bf407190 web: source-aware provenance honesty for imported runs
44c5ee9e web: source & provenance library with guided registration and honest readiness
e8457544 Experiment Lab: decision-readiness cockpit with evidence cross-examination
697917ba Contain Experiment Lab matrix overflow on phone-width screens
9cb1d8b3 Experiment Lab: guided Compare → Decide scan strip with honest signal separation
64178b21 feat(collab): add isolated cd-collab.snapshot.v1 contract
8e3a9572 collab web: add workflow stage navigator to the shell
a2e4dc7e Strengthen ExportPanel UX: explicit states, a11y, and safe failure handling
2c09a2b7 Reject new imports from retired sources, keep them listed for attribution
0932fb5c web: guided triage workspace with first-class capture and AI-lane paths
07b82c31 docs: log 3-lane war-room proof attempt — no employer profiles configured
78c70535 harden(import): port fail-closed import outcome + member-path seal onto war-room lander
8e46cca8 war-room GUI: surface accepted decisions, honest unknowns, lane picker, one-step sanitized-log freeze
aa8990c3 docs: note bench converter honesty for unobserved efficiency
f6d2c4ed fix(collab): stop inventing efficiency and question paths from share-safe metadata
da9063fe fix(collab): restore single evidence upload file input
a0e84b16 feat(collab): hermetic bench-run → strategy_package converter
```

Plus this report commit on top of `0d6831e3`.

Every intended PR delta is present **exactly once**: 20 source cherry-picks
(#942 four commits + 16 other PRs with unique commits; #955 empty duplicate
skipped). Integration commits are rustfmt, browser collision repairs, Tauri
DTO boxing, and this report.

## Residuals / not claimed

1. **Live providers** were not configured. Qualify recorded
   `credentials_not_configured` rather than fabricating runs.
2. **Workspace clippy `-D warnings`** is blocked by lander
   `sqlite_store.rs:1108` (`chunks_exact(4)`), outside the write allowlist.
   With `-A clippy::chunks_exact_to_as_chunks` the workspace is clean.
3. **#960 later rewrite** (`1049947e`) is **not** on this branch. Pin
   `21c54705` plus the #952 spec locator repair is the qualified stack.
4. **Bare `npm run migrate:dry-run`** without sqlite/postgres env fails closed
   locally. SQLite dry-run passed; CI postgres dry-run passed.
5. **Desktop eslint** reports 9 pre-existing warnings (0 errors).
6. **Not a merge recommendation.** Draft PR targeting `merge/war-room-pilot`
   only. Source PRs remain draft/open at their pins (except #960’s later
   independent movement).

## Integration-ready?

**Yes for the combined collab war-room surfaces** (intake, provenance,
retired-source, comparison, decision, export, workflow shell, login, snapshot
contract, browser/bridge/hosted suites) on this disposable branch.

**No** as a claim that `cargo clippy --workspace --all-targets -- -D warnings`
matches `main` CI without the lander sqlite_store lint, and **no** live-model
proof.

**DO NOT MERGE.**
