# War-room dream-stack qualification v1 (refreshed)

**Status:** disposable integration branch. Draft-only. Do not merge.

**Purpose:** prove whether ContextDesk’s current manual intake, provenance,
model comparison, decision cockpit, privacy export, workflow shell,
authentication, retired-source enforcement, snapshot contract, and browser
compatibility work together when the pinned war-room draft PRs are applied as
**exact deltas** onto `merge/war-room-pilot`, then turn that proof into an
**exact promotion train** of small landing waves. This PR is not a merge
vehicle.

**Handbook impact:** none — this branch only assembles already-authored draft
deltas plus this report. Integration edits are conflict resolutions and
combined-stack lint/locator repairs on allowlisted files. No new architecture,
trust-boundary, or evidence-flow chapter is introduced here.

This is not a live-provider, employer-profile, or production-readiness claim.
No credentials, employer data, or generated qualification artifacts are
committed.

**Do not merge #961.** Do not collapse the stack into a single 108-file
consolidation merge.

## Start gate (refresh)

| Item | Value | Result |
| --- | --- | --- |
| Repo | `chriscase/ContextDesk` | used |
| Lander | `merge/war-room-pilot` @ `b93dc17ba2e13225d54f0193ecdf3872998082e6` | exact match (also current `main`) |
| Qualification branch | `cursor/war-room-dream-stack-qualification-v1` | owned disposable branch only |
| Qualification PR | #961 | `draft`, `OPEN`, unmerged, title `DO NOT MERGE` |
| Work boundary | this branch + this report | source PRs #942–#960 not commented on, pushed, retargeted, rebased, or merged |

Pinned source heads verified via GitHub PR `head.sha` **before** the #960
refresh and **again after** local qualification. #942–#959 were unchanged.
Only #960 was expected to differ from the assembly pin.

| PR | Pinned head | Base | Role | GitHub `mergeable_state` |
| --- | --- | --- | --- | --- |
| #942 | `0c82327987dcd457abec9a6a7f23ecbe1d82d938` | lander | bench-run → strategy_package converter | clean |
| #944 | `b9e0e2938ab5c53679c55db90514d95ddb6a0ddb` | lander | GUI honesty, lane picker, one-step freeze | clean |
| #945 | `9b1d76d5f4e4f7b31aca8e7c56c32197bf9b665c` | lander | fail-closed import outcome | clean |
| #946 | `80d7ec2acf7a2e9c2d9f2d0667c31820bd84174d` | lander | 3-lane proof attempt note | unstable |
| #947 | `9baea25c9c1fb6619aeb8c57d6b7bc595aef2e99` | lander | guided Capture→Analyze→Compare→Decide workspace | unstable |
| #948 | `bfb76e5a2aff09ec7720309b79ef64ea069c411e` | #947 | browser import helper for guided capture | clean |
| #949 | `a31494c16e6a8f8da064ff4105a7f73939e9d244` | #947 | source & provenance library | unstable |
| #950 | `60d5e5b2586eb152feb4d516c9508008e9ddbf0a` | #949 | source-aware imported-run honesty | unstable |
| #951 | `aab0fce2309eba96b668f48dbdc9a266ec3bff22` | #944 | Experiment Lab scan strip | clean |
| #952 | `6a56f47b81f33e4acbde2d2fdee99acb8edd7f16` | #951 | workbench mobile containment | clean |
| #953 | `edc2265ef937e98455952c5df9edf3ac23806feb` | lander | server retired-source import rejection | clean |
| #954 | `ef764714a546845b6d8f3f2734cac39ba7dd895a` | #950 | retired-source-safe intake chooser | unstable |
| #955 | `6b93f84a9a0f69afbe5ea71b7942fae5204e5282` | #954 | browser helper on retired-source intake stack | clean |
| #956 | `fca0e256936827d057ed1352789cf2abe31f4222` | lander | export panel states / a11y | clean |
| #957 | `b11ac12a5e754a6c60ef67c09ae6acce39b5e4fc` | lander | workflow stage navigator | clean |
| #958 | `08d7ca1dfa5157083489c44246b6574f39aca882` | #957 | honest sign-in states | clean |
| #959 | `84f95cd0fcc252f1abb9795e5f5bfe7f7d780c78` | lander | `cd-collab.snapshot.v1` contract | clean |
| #960 | `1049947ea0d5efd9aa1ebbc40b070fa6ef7e9295` | #952 | decision-readiness cockpit (**current green head**) | clean |

`mergeable_state` is GitHub’s conflict/required-check snapshot, **not**
approval to merge. See [CI green vs mergeable vs approved](#ci-green-vs-mergeable-vs-approved-to-merge).

## #960 tree refresh

Assembly originally pinned superseded #960
`21c5470587b56ae26119a147ea2f7467bec2ec1a` (tree
`23924ef45ad73424e99895e80e773de3f64df64c`). Current GitHub head is
`1049947ea0d5efd9aa1ebbc40b070fa6ef7e9295` (tree
`24d83568c2cc6166128f1a309708c89e9463410d`).

The two commits are **not** ancestors of each other (`git merge-base --is-ancestor`
exits 1 both ways). Same subject, amended rewrite, same three files vs #952:

```text
old vs parent #952: 3 files, 1771 insertions, 6 deletions
new vs parent #952: 3 files, 1840 insertions, 7 deletions
old vs new trees:   3 files, 77 insertions, 9 deletions
```

Semantic difference (applied **once**; both versions were not stacked):

- Cross-examination table is `table.experiment-lab__crossexam` in
  `.experiment-lab__crossexam-wrap`.
- It no longer shares `experiment-lab__matrix` / `__matrix-wrap`.
- Shared table chrome is reproduced on the crossexam selectors.
- Unit test: `keeps exactly one candidate matrix and one separately named
  cross-examination table`.

On the combined stack those three files also carry #942/#944/#951 edits, so
the rewrite was applied as that semantic delta rather than a wholesale
checkout of #960.

### Dual-table locator workaround — removed

Assembly repaired #952’s `08-responsive-a11y.spec.ts` because pinned #960 used
`class="experiment-lab__matrix experiment-lab__crossexam"`, so
`table.experiment-lab__matrix` matched two nodes.

Current #960 owns the unique class identity. The #961 spec workaround is
**gone**: `collab/e2e/specs/08-responsive-a11y.spec.ts` is byte-identical to
#952 `6a56f47b`. Combined-stack Playwright
`workbench contains the real comparison matrix at a phone width` **passed**
on the restored locators.

## Assembly (unchanged order)

Exact PR deltas (`git cherry-pick` of unique commits vs each PR’s declared
base), not stacked heads:

1. Independent lander children: #942 (4 commits), #944, #945, #946, #947,
   #953, #956, #957, #959.
2. #944 stack: #951 → #952 → #960 (now current green `1049947e`).
3. #947 provenance stack: #949 → #950 → #954.
4. Browser compatibility deltas: #948 then #955.
5. #957 child: #958.

Write allowlist = union of those unique diffs + this report.

- unique-file union + report = **108 paths**
- `git diff --name-only` lander…HEAD = **108 paths**
- extras = none; missing = none
- `git diff --shortstat` lander…HEAD after this refresh:
  **108 files changed, 15604 insertions(+), 883 deletions(-)**
- `git diff --check` lander…HEAD = **pass**

### Remaining combined-stack repairs (allowlisted files only)

| Repair | File | Still required? | Rightful owner |
| --- | --- | --- | --- |
| #944 × #942 keep both state groups | `collab/web/src/TriageRunPanel.tsx` | **yes** — `benchArtifactText` and `lanePickerError` | later of #942 / #944-stack (see child D) |
| #951 × #942 keep both tests | `collab/web/src/ExperimentLab.test.tsx` | **yes** — extra test `exposes a readable bench-artifact import path without making raw JSON primary` | later of #942 / #960 (child D) |
| #948 / #955 identical helper | `collab/e2e/src/helpers.ts` | apply **once** | #948 (skip #955 if #948 already landed) |
| Dual-table #952 locators | `collab/e2e/specs/08-responsive-a11y.spec.ts` | **no** — removed; current #960 owns class identity | — |
| #956 selection count vs bridge `getByRole("status")` | `collab/web/src/ExportPanel.tsx` | **yes** — count is `aria-live="polite"` without `role="status"` | #956 (child B) |
| #945 `ImportCommandErrorDto` vs `clippy::result_large_err` | `desktop/src-tauri/src/lib.rs` | **yes** — `outcome` is `Option<Box<ImportOutcomeReport>>` | #945 (child A) |
| rustfmt on bench-adapter export tests | `crates/cd-triage-bench-adapter/src/collab_export.rs` | **yes** vs #942 source tip | #942 (child C) |

Cherry-pick SHAs still differ from source tips where conflicts were resolved
(#944 → `8e46cca8`, #951 → `9cb1d8b3`). #960 on this branch is commit
`e8457544` plus refresh `50e0cadf`.

### Unique-file overlaps (why some stacks cannot land independently)

Unique deltas vs declared bases overlap on:

| Path | Unique deltas |
| --- | --- |
| `collab/e2e/src/helpers.ts` | #948, #955 (byte-identical) |
| `collab/web/src/Catalog.tsx` | #949, #950 |
| `collab/web/src/TriageWorkspace.tsx` / `.test.tsx` | #947, #950, #954 |
| `collab/web/src/TriageRunPanel.tsx` | #942, #944 |
| `collab/web/src/ExperimentLab.tsx` / `.test.tsx` / `experiment-lab.css` | #942, #944, #951, #960 |
| `collab/web/src/styles/cases.css` | #942, #944, #952 |

**Stack-level file overlap exists only between #942 and the #944→#960 stack
(5 files).** Every other stack pair is file-disjoint.

### Stack dependencies

```text
lander b93dc17b
├── #942 converter                         ← overlaps #944-stack (5 files)
├── #944 GUI honesty
│     └── #951 scan strip
│           └── #952 mobile containment
│                 └── #960 cockpit (current 1049947e)
├── #945 import outcome                    ← needs child A before host clippy
├── #946 3-lane attempt note               ← not merge-approved (no profiles)
├── #947 guided workspace                  ← browser CI needs #948
│     ├── #948 browser helper (canonical; skip #955)
│     └── #949 provenance library
│           └── #950 source-aware honesty
│                 └── #954 retired-source intake UI
├── #953 retired-source server enforcement
├── #956 export panel                      ← needs child B before combining with #947/#960
├── #957 workflow navigator
│     └── #958 login honesty
└── #959 snapshot contract
```

## Qualification commands (refreshed combined stack)

Host notes for Rust: default `c++` is clang 18 (duckdb-sys fails `#include <memory>`).
Commands used `CC=gcc CXX=g++`,
`LIBRARY_PATH=/usr/lib/gcc/x86_64-linux-gnu/13`,
`RUSTFLAGS=-C link-arg=-L/usr/lib/gcc/x86_64-linux-gnu/13`, and
`eval "$(scripts/local-build-cache.sh activate)"`.

### Product / whitespace / pins

| Command | Result |
| --- | --- |
| `git diff --check b93dc17ba2e13225d54f0193ecdf3872998082e6 HEAD` | **pass** (exit 0) |
| Unique PR-delta union vs `git diff --name-only` lander…HEAD | **108 = 108**, extras none |
| Source PR `head.sha` vs pin table before refresh | **pass** (#960 expected stale pin) |
| Source PR `head.sha` after qualification | #942–#959 **match**; #960 **matches current green** `1049947e` |
| Generated output / secrets in git | **none** (e2e `test-results/`, `web/dist`, Tauri `gen/schemas` untracked/gitignored) |

### Collab install / typecheck / lint / tests / build

From `collab/` after `npm ci`:

| Command | Result |
| --- | --- |
| `npm run typecheck` | **pass** (`typecheck_exit=0`) |
| `npm run lint` | **pass** (`lint_exit=0`; eslint boundaries deprecation warnings only) |
| `npm test` | **pass** — contracts **63**; server **149 passed / 10 skipped**; web **124** (was 123; +1 dual-table identity test) |
| `npm run build` | **pass** (`build_exit=0`) |
| `npm run migrate:dry-run` (default postgres, no `COLLAB_DATABASE_URL`) | **fail** (`missing required environment variable: COLLAB_DATABASE_URL`) — expected on this host |
| `COLLAB_STORAGE=sqlite COLLAB_SQLITE_PATH=/tmp/cd-collab-qualify.sqlite npm run migrate:dry-run` | **pass** — `SQLite schema ready: /tmp/cd-collab-qualify.sqlite` |

### Synthetic Capture→Analyze→Compare→Decide (offline)

`npm run qualify -- --backend memory` in `collab/`:

- **9/9 steps passed** (`qualify_memory_exit=0`)
- comparison: shared=1 unique=2 disagreements=1 unknowns=0 questions=2
- decision accepted=true, gold=true
- lineage `pkg-synth-three-model-checkout-v1` → `v2`
- live aliases skipped with `credentials_not_configured` (honest; no live calls)

Postgres qualify was **not** run locally (no `COLLAB_DATABASE_URL`). GitHub
`collab hosted release qualification` is the hosted postgres+memory proof;
re-run it on this refreshed head (see GitHub CI).

### Browser / bridge / responsive / a11y / login / intake / export

Playwright serves `collab/web/dist`. After the #960 class-identity refresh
and restoring #952 locators:

| Command | Result |
| --- | --- |
| `npm run test -w @cd-collab/e2e` | **22 passed, 3 skipped** (`e2e_full_exit=0`) |
| Skips | durable process restart (no durable server); live profile; bridge without `COLLAB_E2E_BRIDGE` |
| `COLLAB_E2E_BRIDGE=1 npm run test -w @cd-collab/e2e -- specs/10-bridge-comparison.spec.ts` | **1 passed** (`bridge_exit=0`) |
| `specs/06-lanes-and-states.spec.ts` | **3 passed** |
| Login (`01-local-auth-login`) | **4 passed** |
| Import chat (`04-import-chat`) | **1 passed** |
| Export (`05-export-share-safe`) | **3 passed** |
| Responsive/a11y (`08-responsive-a11y`) | **2 passed** (login landmarks; 375px comparison matrix via `table.experiment-lab__matrix`) |

Unit coverage on the same surfaces (web vitest): `LoginForm` 13, `TriageWorkspace`
24 (includes `retired-source-safe manual intake`), `Catalog` 13, `ExperimentLab`
31, `ExportPanel` 9, `App` 8, `CaseBoardPanel` 5.

### Desktop UI

From `desktop/` after `npm ci`:

| Command | Result |
| --- | --- |
| `npm run typecheck` | **pass** |
| `npm run lint` | **pass** with **9 warnings / 0 errors** (pre-existing; files not in this allowlist except import-flow which did not add those warnings) |
| `npm test` | **198 files / 1931 tests passed** |
| `npm run build` (vite) | **pass** |

### Rust workspace

| Command | Result |
| --- | --- |
| `cargo fmt --all -- --check` | **pass** |
| `cd desktop/src-tauri && cargo fmt -- --check` | **pass** |
| `cargo clippy --workspace --all-targets -- -D warnings` | **fail** (`clippy_deny_exit=101`): lander-preexisting `clippy::chunks_exact_to_as_chunks` at `crates/cd-core/src/memory/sqlite_store.rs:1108`. File **not** in the allowlist; `git diff` vs lander is empty. Not fixed here. |
| `cargo clippy --workspace --all-targets -- -D warnings -A clippy::chunks_exact_to_as_chunks` | **pass** (`clippy_allow_exit=0`) |
| Relevant crate tests | `import_outcome` lib **21** (workspace log); `import_outcome_contract` **10**; ingest `--lib ingest` **100**; `import_outcome_cli` **4**; `import_production` **6**; bench-adapter `collab_export` **2** — all pass |
| `cargo test --workspace` | **pass** (`test_workspace_exit=0`): **4026 passed**, **0 failed**, **21 ignored** across 159 result lines |
| `cargo run -p cd-server -- --print-branding` | **pass** — `ContextDesk (contextdesk) — Developer knowledge workbench — find, synthesize, remember.` |
| `cd desktop/src-tauri && cargo clippy -- -D warnings` | **pass** (`tauri_clippy_deny_exit=0`) with boxed #945 DTO |
| `cd desktop/src-tauri && cargo check` | **pass** (`tauri_check_exit=0`) |

WebKit/GTK packages from the CI `tauri-host` job were installed so `gdk-3.0` /
`webkit2gtk-4.1` pkg-config succeeded. `apt-get` exited 100 on unrelated
`fuse3` / `xdg-desktop-portal` configure errors; the required GTK/WebKit
dev packages were present (`ii`).

### GitHub CI on PR #961

`.github/workflows/ci.yml` rust/desktop jobs only fire for PRs targeting
`main`. This PR targets `merge/war-room-pilot`, so collab workflows are the
hosted CI.

The #960 refresh head `50e0cadfe1f8f3ca5b7f09c46ca88367ba0ca508` re-ran the
collab path filters (the PR still touches `collab/**`). All four hosted collab
jobs on that head concluded **success**:

| Check | Result |
| --- | --- |
| collab (typecheck, lint, test, migrate dry-run) | **success** |
| collab war-room browser qualification | **success** |
| collab war-room browser bridge qualification | **success** |
| collab hosted release qualification (memory + postgres) | **success** |

A follow-up docs-only report commit may not re-trigger `collab.yml` (path
filter is `collab/**`). Treat `50e0cadf` as the code-qualification CI head.
CI green on #961 is **not** approval to merge.

## Surface verification (what was proven)

| Surface | Evidence |
| --- | --- |
| Login / authentication | e2e `01-local-auth-login` 4/4; `LoginForm.test.tsx` 13; #958 on the stack |
| Manual intake | e2e `04-import-chat`; `TriageWorkspace` tests; qualify capture steps |
| Source provenance | `Catalog.test.tsx`; imported-run honesty tests; #949/#950 |
| Retired-source history | `retired-source-safe manual intake` describe; server `import.test.ts` via #953; catalog still lists retired sources |
| Comparison | e2e `06-lanes-and-states`; Experiment Lab 31 tests; qualify comparison object |
| Decision cockpit | qualify `compare_and_decide` passed; current #960 class identity on the stack |
| Privacy export | e2e `05-export-share-safe` 3/3; `ExportPanel` 9 tests |
| Workflow navigation | `App.test.tsx`; #957 navigator on the stack |
| Snapshot contract | contracts snapshot tests in the 63; #959 fixtures/schema |
| Browser compatibility | full e2e 22/3; responsive 375px matrix with #952 locators; #948/#955 helper once |
| Bridge | local `COLLAB_E2E_BRIDGE=1` 1/1 |
| Hosted | local memory qualify 9/9; GitHub hosted job is the postgres proof |

## CI green vs mergeable vs approved to merge

These are three different claims. Mixing them is how a draft stack gets
merged by accident.

| Term | Meaning here | What it does **not** mean |
| --- | --- | --- |
| **CI green** | The GitHub checks that actually ran on that PR/head concluded success. Collab PRs targeting `merge/war-room-pilot` run collab workflows only. Rust/desktop `ci.yml` jobs do **not** run unless the PR targets `main`. | The change is safe to land; sibling stacks combine; host clippy is clean; browser helpers match parents. |
| **Mergeable** | GitHub `mergeable_state` is `clean` (no merge conflicts with the **current base**). `unstable` means required checks are failing or incomplete, not necessarily a git conflict. | Human approval; parent drafts have landed; combined-stack repairs exist; landing order is respected. |
| **Approved to merge** | A human decides to land **this PR onto its declared base after its parents**, with the required child repairs from this train, after the wave gate below is green. Source drafts stay draft until that decision. | #961 may be merged. A 108-file consolidation is acceptable. CI green on a child stacked on another draft is enough. |

**#961 is never approved to merge.** It is disposable qualification evidence.

Examples from this pin table:

- #956 is CI green **and** mergeable onto the lander, and its own bridge job
  passed. Combined with #947/#960 it still needs child B (`role="status"`
  uniqueness). CI green ≠ combined-stack approved.
- #945 is mergeable onto the lander and has **no collab check runs** (no
  `collab/**` paths). Host `clippy -D warnings` fails without child A. No CI
  ≠ host-approved.
- #947 is `unstable` because browser jobs still use the lander import helper.
  It is not browser-approved until #948 lands immediately after it.
- #946 is a docs note that explicitly must not merge until owner-local
  profiles exist. Unstable + not approved, regardless of conflicts.

## Promotion train — smallest safe landing waves

Do **not** merge #961. Do **not** land the 108-file union. Land source drafts
in these waves onto `merge/war-room-pilot`. After each wave, the lander is the
new base for later waves.

Sibling stacks that are file-disjoint **may be prepared in parallel** but
should still land as the waves below so browser/helper/status repairs stay
ordered.

### Wave 0 — host import clippy (blocker for any later `main` promotion of #945)

| Land | Notes |
| --- | --- |
| Child A, then #945 | See [proposed child PRs](#proposed-child-prs-do-not-create-in-this-goal). |

**Independently landable this wave:** only #945+A (file-disjoint from every
collab stack).

**Requires another draft first:** child A before treating #945 as host-clippy
approved.

**Tests after the wave:**

- `cd desktop/src-tauri && cargo fmt -- --check && cargo clippy -- -D warnings && cargo check`
- `cargo test -p cd-core --test import_outcome_contract`
- `cargo test -p cd-core --lib ingest`
- `cargo test -p cd-cli --test import_outcome_cli`
- `cargo test -p cd-workflow --test import_production`
- `cd desktop && npm run typecheck && npm test`

**Rollback boundary:** revert the lander merge commit(s) for child A / #945.
Does not touch collab war-room UI stacks.

### Wave 1 — file-disjoint lander children with no parent draft

| Land | Independent of other stacks? | Requires another draft first? |
| --- | --- | --- |
| #959 snapshot contract | yes | no |
| #953 retired-source server | yes | no (pairs with #954 later; file-disjoint) |
| #957 then #958 | #957 yes; #958 requires #957 | #958 requires #957 |
| #946 3-lane note | file-disjoint | **not approved** until owner-local profiles exist — leave draft |

**Tests after the wave:**

- `cd collab && npm run typecheck && npm run lint && npm test && npm run build`
- `COLLAB_STORAGE=sqlite COLLAB_SQLITE_PATH=/tmp/cd-collab-wave1.sqlite npm run migrate:dry-run`
- `npm run test -w @cd-collab/e2e`
- `COLLAB_E2E_BRIDGE=1 npm run test -w @cd-collab/e2e -- specs/10-bridge-comparison.spec.ts`
- focused: `npm test -w @cd-collab/contracts -- src/snapshot.test.ts`; `npm test -w @cd-collab/server -- src/modules/import/import.test.ts`; `npm test -w @cd-collab/web -- src/App.test.tsx src/LoginForm.test.tsx`

**Rollback boundary:** revert the wave’s lander merges (#959, #953, #957,
#958, and #946 only if it was landed). No overlap with #942/#944/#947 files.

### Wave 2 — guided workspace + canonical browser helper

| Land | Requires another draft first? |
| --- | --- |
| #947 | no (lander child) but **browser CI is red until #948** |
| #948 immediately after #947 | yes — #947 |

**Skip #955** if #948 is on the lander before #954. #955 is a duplicate helper
delta for qualifying #954 without restacking parents.

**Tests after the wave:**

- `npm test -w @cd-collab/web -- src/TriageWorkspace.test.tsx src/Cases.test.tsx`
- full `cd collab && npm test && npm run typecheck && npm run lint`
- `npm run test -w @cd-collab/e2e` (must include `04-import-chat`)
- `COLLAB_E2E_BRIDGE=1 npm run test -w @cd-collab/e2e -- specs/10-bridge-comparison.spec.ts`

**Rollback boundary:** revert #948 then #947 (helper first). Provenance stack
#949–#954 must not be on the lander yet, or revert them first.

### Wave 3 — provenance library through retired-source intake

| Land | Requires another draft first? |
| --- | --- |
| #949 | #947 |
| #950 | #949 |
| #954 | #950 |
| #953 (if deferred from wave 1) | no file overlap; land before or with #954 for the full retired-source story |

**Tests after the wave:**

- `npm test -w @cd-collab/web -- src/Catalog.test.tsx src/TriageWorkspace.test.tsx src/ImportedRun.test.tsx`
- `npm test -w @cd-collab/server -- src/modules/import/import.test.ts src/modules/catalog/catalog.test.ts`
- `npm run test -w @cd-collab/e2e -- specs/04-import-chat.spec.ts`

**Rollback boundary:** revert #954 → #950 → #949 (and #953 if landed here).
#947/#948 stay.

### Wave 4 — export panel with combined-stack status uniqueness

| Land | Requires another draft first? |
| --- | --- |
| Child B, then #956 | Child B should land with or immediately before #956 **before combining with wave 2/5**. #956 alone was CI-green on the lander; the collision is combined-stack (`getByRole("status")` vs a persistent selection count once the workspace/cockpit also expose statuses). |

**Tests after the wave:**

- `npm test -w @cd-collab/web -- src/ExportPanel.test.tsx`
- `npm run test -w @cd-collab/e2e -- specs/05-export-share-safe.spec.ts`
- `COLLAB_E2E_BRIDGE=1 npm run test -w @cd-collab/e2e -- specs/10-bridge-comparison.spec.ts` (strict unique `status`)

**Rollback boundary:** revert child B / #956 only. No overlap with #942/#944
files.

### Wave 5 — Experiment Lab stack, then converter restack

Land the **longer** overlapping stack first so only **one** restack is
required (#942 onto #960), not four.

| Land | Requires another draft first? |
| --- | --- |
| Child C on #942 (rustfmt) — can be prepared in parallel | no |
| #944 | no (lander child; file-overlaps #942 — do not land #942 yet) |
| #951 | #944 |
| #952 | #951 |
| #960 current green `1049947e` | #952 |
| Child D: #942 unique files + 5-file merge onto #960, including child C rustfmt | #960 and child C |

**Do not land #942 onto the lander before the #944→#960 stack.** The opposite
order requires restacking #944, #951, #952, and #960.

**Tests after #944→#960 (before #942):**

- `npm test -w @cd-collab/web -- src/ExperimentLab.test.tsx src/TriageRunPanel.test.tsx src/CaseBoardPanel.test.tsx`
- `npm run test -w @cd-collab/e2e -- specs/06-lanes-and-states.spec.ts specs/08-responsive-a11y.spec.ts`
- `COLLAB_E2E_BRIDGE=1 npm run test -w @cd-collab/e2e -- specs/10-bridge-comparison.spec.ts`

**Tests after child D / #942 restack:**

- the tests above **plus** `exposes a readable bench-artifact import path without making raw JSON primary`
- `npm test -w @cd-collab/contracts -- src/bench-artifact.test.ts`
- `npm test -w @cd-collab/server -- src/modules/experiments/experiments.test.ts`
- `cargo test -p cd-triage-bench-adapter --lib collab_export`
- `cargo fmt --all -- --check` (covers child C)
- `npm run test -w @cd-collab/e2e -- specs/03-evidence-freeze.spec.ts` (`input[type=file]` count stays 1)

**Rollback boundary:**

- After #944→#960 only: revert #960 → #952 → #951 → #944.
- After child D: revert child D first. #944-stack remains.
- Never roll back by merging #961.

### Final lander qualification gate (after all approved waves)

Run on `merge/war-room-pilot` (not on #961):

1. Unique-file union of **landed** PRs equals `git diff --name-only` vs the
   pre-train lander SHA; extras none.
2. `git diff --check`
3. `cd collab && npm ci && npm run typecheck && npm run lint && npm test && npm run build`
4. sqlite migrate dry-run; GitHub collab migrate dry-run (postgres)
5. `npm run qualify -- --backend memory` and hosted postgres qualify
6. Playwright full suite + `COLLAB_E2E_BRIDGE=1` bridge spec
7. `cargo fmt --all -- --check`
8. `cargo clippy --workspace --all-targets -- -D warnings` with the known
   lander sqlite_store residual **or** that residual landed separately
9. `cargo test --workspace`
10. `cd desktop/src-tauri && cargo clippy -- -D warnings && cargo check`
11. `cd desktop && npm run typecheck && npm test`
12. No secrets, employer data, generated output, or live provider calls

**#961 is still not merged.** Delete or close it as disposable after the
lander gate, or keep it as historical evidence only.

## Proposed child PRs (do not create in this goal)

All of these are **draft-only handoffs**. Do not open them from this work.
Do not push to #942–#960.

### Child A — box import-command error outcome

| Field | Value |
| --- | --- |
| Proposed branch | `cursor/945-box-import-command-error-outcome` |
| Parent SHA | `9b1d76d5f4e4f7b31aca8e7c56c32197bf9b665c` (#945 head) |
| Base / PR | `claude/import-outcome-fail-closed-5abce7` / #945 |
| Minimal allowlist | `desktop/src-tauri/src/lib.rs` |
| Change | `ImportCommandErrorDto.outcome: Option<Box<ImportOutcomeReport>>`; serde JSON unchanged |
| Tests | `cd desktop/src-tauri && cargo clippy -- -D warnings && cargo check`; Tauri lib import-command projection tests; `cd desktop && npm run typecheck` |
| Handoff | Draft child of #945. Land before promoting #945 through a host clippy `-D warnings` gate. Do not retarget #945. |

### Child B — export selection count is not `role="status"`

| Field | Value |
| --- | --- |
| Proposed branch | `cursor/956-export-selection-count-aria-live` |
| Parent SHA | `fca0e256936827d057ed1352789cf2abe31f4222` (#956 head) |
| Base / PR | `claude/export-privacy-ui-fable` / #956 |
| Minimal allowlist | `collab/web/src/ExportPanel.tsx` |
| Change | persistent selected-count `<p>` uses `aria-live="polite"` and must **not** set `role="status"` (keep in-flight/success statuses) |
| Tests | `npm test -w @cd-collab/web -- src/ExportPanel.test.tsx`; `npm run test -w @cd-collab/e2e -- specs/05-export-share-safe.spec.ts`; `COLLAB_E2E_BRIDGE=1 npm run test -w @cd-collab/e2e -- specs/10-bridge-comparison.spec.ts` |
| Handoff | Draft child of #956. Required before combining #956 with #947/#960. Do not edit `10-bridge-comparison.spec.ts` on a source PR. |

### Child C — rustfmt bench-adapter export tests

| Field | Value |
| --- | --- |
| Proposed branch | `cursor/942-rustfmt-collab-export-tests` |
| Parent SHA | `0c82327987dcd457abec9a6a7f23ecbe1d82d938` (#942 head) |
| Base / PR | `cursor/bench-run-strategy-converter-2ee4` / #942 |
| Minimal allowlist | `crates/cd-triage-bench-adapter/src/collab_export.rs` |
| Change | rustfmt only on the two long `assert_eq!(package["traces"][0]["efficiency"]…)` lines in tests |
| Tests | `cargo fmt --all -- --check`; `cargo test -p cd-triage-bench-adapter --lib collab_export` |
| Handoff | Draft child of #942. Fold into child D if #942 is restacked onto #960 in one commit instead. |

### Child D — #942 onto current #960 (5-file merge + unique converter files)

| Field | Value |
| --- | --- |
| Proposed branch | `cursor/942-onto-960-combined-lab-merge` |
| Parent SHA | `1049947ea0d5efd9aa1ebbc40b070fa6ef7e9295` (current #960 head) **after** #944→#951→#952→#960 have landed, or stacked on #960 while those parents remain drafts |
| Minimal allowlist | overlap (must keep both sides): `collab/web/src/TriageRunPanel.tsx`, `collab/web/src/ExperimentLab.tsx`, `collab/web/src/ExperimentLab.test.tsx`, `collab/web/src/styles/experiment-lab.css`, `collab/web/src/styles/cases.css`. Unique #942 files: `collab/contracts/src/bench-artifact.ts`, `collab/contracts/src/bench-artifact.test.ts`, `collab/contracts/src/lab-import.ts`, `collab/contracts/src/index.ts`, `collab/contracts/src/trace.test.ts`, `collab/contracts/fixtures/bench-run-artifact.deepseek-rejected.json`, `collab/contracts/fixtures/bench-run-artifact.multi-strategy.json`, `collab/server/src/modules/experiments/experiments.test.ts`, `crates/cd-triage-bench-adapter/src/collab_export.rs`, `crates/cd-triage-bench-adapter/src/error.rs`, `crates/cd-triage-bench-adapter/src/lib.rs`, `docs/benchmarks/CONTEXTDESK_DEMO_RUNBOOK.md`, `docs/benchmarks/INTERACTION_TRACE_STRATEGY_COMPARISON_V1.md`, `docs/design/PROVEN_METHODS.md`, `docs/design/TRIAGE_RUNTIME_BENCH_BRIDGE_V1.md` |
| Change | Keep #944 `lanePickerError` **and** #942 `benchArtifactText` import UI. Keep #951/#960 cockpit tests **and** the #942 bench-artifact import test. Keep #952 `min-width: 0` on `.case-list, .case-view`. Keep current #960 crossexam class identity (no dual `experiment-lab__matrix`). Include child C rustfmt on `collab_export.rs`. |
| Tests | Wave 5 “after child D” list above |
| Handoff | Draft only. Do not force-push #942. Do not retarget #960. If the #944-stack has already landed on the lander, parent SHA becomes that lander commit instead of `1049947e`, but the allowlist stays the same. |

No other integration-only repairs remain on #961 after this refresh.

## Commits on this branch (`lander..HEAD` at report time)

```text
50e0cadf fix(collab): refresh #960 cockpit class identity on dream-stack
69a4883b docs: note superseded browser CI failure versus green PR head
a834f982 docs: record war-room dream-stack qualification evidence
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

Plus this refreshed report commit on top of `50e0cadf`.

`939942d5` still contains the #956 `aria-live` repair; its dual-table spec
hunk was reverted by `50e0cadf`.

## Residuals / not claimed

1. **Live providers** were not configured. Qualify recorded
   `credentials_not_configured` rather than fabricating runs.
2. **Workspace clippy `-D warnings`** is blocked by lander
   `sqlite_store.rs:1108` (`chunks_exact(4)`), outside the write allowlist.
   With `-A clippy::chunks_exact_to_as_chunks` the workspace is clean.
3. **Bare `npm run migrate:dry-run`** without sqlite/postgres env fails closed
   locally. SQLite dry-run passed; CI postgres dry-run is the hosted proof.
4. **Desktop eslint** reports 9 pre-existing warnings (0 errors).
5. **#946** remains a missing-profile note, not a 3-lane proof.
6. **Child PRs A–D were not created** (explicit non-goal).
7. **Not a merge recommendation for #961 or for a 108-file landing.**

## Integration-ready?

**Yes for the combined collab war-room surfaces** on this disposable branch
with current #960 class identity and the remaining repairs listed above.

**No** as a claim that `cargo clippy --workspace --all-targets -- -D warnings`
matches `main` CI without the lander sqlite_store lint, **no** live-model
proof, and **no** approval to merge #961.

**DO NOT MERGE.**
