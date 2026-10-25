# Goal 09 — Trusted Benchmark Promotion and Offline Handoff receipt

Status: locally qualified functional candidate for one **draft**, unmerged PR.
The receipt records local evidence; hosted checks on its later publication head
must be read separately and cannot be declared green here.

## Provenance and revision

- Exact supplied objective: `docs/goals/09-TRUSTED-BENCHMARK-HANDOFF.md`, SHA-256
  `8227beff2e666b02413f9520948462baf77043f51a27084cc63ee64897d3e2c5`.
  Commit `09ba925117e52c13cd18d51fe146544471149b15` froze those bytes
  before production edits.
- Pinned and reverified `origin/main` / merge base:
  `5650f0666a42e0adfaecedd1b4d9286002dde3ba`, tree
  `16fea5e5f43844daba7da7d09ad6ed651cd6eab8`.
- Locally tested functional commit: `9e9cb51c460ccc47d9fb5f8d0752d2573963531b`,
  tree `0339f5269fad522babf7fbcb83cc66909d2c6510`. The later receipt
  commit changes only this document. Its exact published head/tree and hosted
  checkout identities belong in the PR handoff, without recursive CI evidence
  commits.
- Owned branch: `integrate/trusted-benchmark-handoff-v1`. Historical #1175 at
  `c6b7a4fae7fea4ecb441d6396bf61812af602368` supplied the one-time
  accepted-evidence picker seed and reset idea. That small behavior was
  selectively adapted to current `ExperimentLab.tsx`; its old large files,
  branch, and PR were not copied, rebased, or changed.
- Goal 08 shipped through merged #1187 on this base. Goal 09 remains unmerged.
  No new data table, migration, scoring algorithm, provider adapter, or
  readiness/routing state was added.

## TBH acceptance ledger

| Criterion | Evidence and boundary |
| --- | --- |
| TBH-01 | The existing War Room Decide comparison mounts an accepted decision and latest/history benchmark, with human-benchmark language. Proposed-only promotion remains server-denied. Goal 07 assessments and share-safe review stay separate. |
| TBH-02 | The picker seeds the accepted decision's unique eligible experiment or proven host-frozen snapshot references once per editing epoch. A foreign/unproven snapshot cannot supply choices; manual deselection and empty selection remain operator-owned. Fresh preflight refuses a removed selected anchor with zero POSTs. |
| TBH-03 | Explicit form submit freezes case/experiment, decision revision, anchors, optional roles/dimensions, and current gold version. Retained or rapid duplicate handlers cannot post while pending. Parsed success must match the frozen semantic fingerprint and scope; refresh failure is reported after recorded success. |
| TBH-04 | Conflict/unknown outcomes invalidate prior permission. A new same-scope history read is required after each attempt. A matching historical version recovers without another write; otherwise deliberate replay retains semantic intent and rechecks current evidence. Tests reject a captured earlier retry/form handler after a second unknown outcome. Server replay-before-CAS and append-only atomicity remain the existing mechanism, not a new exactly-once claim. |
| TBH-05 | Actual `Cases` mount keys benchmark controls to case, identity, authority, read/private/export/lead context. A replacement-layout probe invokes retained submit/download handlers before an independent passive-cleanup witness on identity, private, export, lead, and missing-record changes; A→B→A does not revive old handlers. An in-flight export response after authority replacement cannot prepare a Blob. Blob URLs are released on version change, replacement, failure, expiry, and unmount. Already-saved bytes cannot be recalled. |
| TBH-06 | Existing experiments module has a current-session, case-membership, `decision:accept`, `evidence:private:read`, `export:create` exact-ID/version POST export with success audit and no-store JSON. Shared strict owner-only envelope parser rejects invalid privacy, nested identities, and unknown fields. Repeated stored-version bytes match; denied, malformed and wrong-version requests produce no file. Alias-only share-safe export privacy tests remain green. |
| TBH-07 | Rust `import-gold` accepts the strict owner-only envelope and legacy bare gold through the existing store. Shared valid/invalid fixtures test cross-language wire behavior. The actual browser-saved file is imported twice without overwrite and reported with its original task/snapshot IDs; a different task **and** snapshot get no applicable gold. Repeated unchanged report JSON matches. Bare input has unknown handling provenance, not implied share-safe status. |
| TBH-08 | `43-trusted-benchmark-handoff.spec.ts` uses a built server, disposable SQLite, actual Chromium download, and compiled offline CLI. `route.fetch()` commits a promotion before `route.abort()` withholds its 200 response from the browser. The UI shows unconfirmed, reads fresh history, recovers with no extra gold/event, and reopens after the server restarts on the same database. The transport loss is injected; server, storage, browser, saved file and CLI are real local paths. |
| TBH-09 | Native controls have labeled selection, version and download actions; Enter triggered the actual file download. The final 320px forced-colors/reduced-motion screenshot was visually inspected and the document had no horizontal overflow. Tests cover proposed/missing decisions, delayed/foreign snapshot, reset/deselection, removed anchor, stale/failed reads, repeated unknown, wrong success, denied and malformed export. No real assistive-technology or non-Chromium certification is claimed. Four temporary behavioral mutations failed their detectors and were restored. |
| TBH-10 | Full local collaboration, browser, bench, claims, Help and handbook checks below passed. One separate read-only adversarial source review found two behavior defects and two proof gaps, all corrected with tests. Help, benchmark loop, Proven Methods chapter/index and living backlog distinguish shipped Goal 08 from unmerged Goal 09. This sanitized receipt and the draft PR are the review handoff. |

## Real saved-file transfer and test results

The final independent joined run saved its actual browser download in a
disposable local directory before passing that same path to the compiled
`cd-triage-bench --library DIR import-gold FILE` command. Its SHA-256 was
`fe382cc69072f158eea67380b4bc682089b2ffa8ec413c6ba1116589059e9888`.
The synthetic gold ID was `de1d2422-f0b0-426c-be78-95e50bbc0816`, task
`task-e6be79e1a903d53d474bf36128811b60337b3cd925cf35a6c37bc60a836267eb`,
and snapshot
`snap-3f6ac6c6e8f49291ec45d03d6560f78ad11e2db2e0b0054cec0cc577587cffe3`.
The package was seeded with those task/snapshot IDs **before** promotion; no
downloaded identity was edited to make the report join. The bench's supported
`report --format json --privacy owner-only --task TASK_ID` returned that gold
for the matching run and no gold for an unrelated task/snapshot control.

- `collab`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`
  passed. The full server suite had **1,323 passed / 118 existing skips**;
  the full web suite had **1,837 passed**. The full contracts suite passed.
  After a test-only export-denial addition, focused experiments passed 18/18.
- `collab/e2e`: typecheck passed. Ordinary Chromium with explicit `--retries=0`
  passed **161/171**, with **10 existing environment or joined-lane skips**;
  those skips are not passes. The separate joined config passed **1/1 in three
  independent no-retry runs**, with the other spec names excluded by its
  explicit grep. All three runs imported their own actual browser download.
- The two selected timing regressions — repeated-uncertainty retained retry,
  and in-flight export across mounted authority change — each passed in **five
  independent name-filtered runs** (2 passed per run; 169 other names filtered,
  not environment skips).
- `cargo build -p cd-triage-bench` and full `cargo test -p cd-triage-bench`
  passed using an isolated shared compiler cache; the JSON fixture and
  existing gold-backtest tests are included. The joined spec exercised the
  compiled CLI, real file-backed store, import and report commands.
- `check_design_handbook`, `check_claims`, Help corpus/drift, and
  `git diff --check` passed. The outgoing added lines and new files were
  inspected for secrets, private paths, credentials, signed URLs and private
  recovery material; only existing synthetic privacy-test strings matched a
  broad path search. No local `gitleaks` executable was present; the hosted
  PR security job is separate evidence and must be read at its own head.

Development runs initially exposed a fixture display-name locator, an
attempt to revise an immutable accepted decision, a heading hidden in the
wrong stage, a test mock TypeScript tuple, and an optional Playwright config
typing issue. Each was corrected before the passing gates. A source-review
finding that the browser borrowed snapshot refs by fingerprint alone was
closed by requiring `host_frozen_snapshot` proof in both selection and
preflight. Another finding that retained handlers could bypass a second
unknown outcome was closed with live attempt/uncertainty guards. The reviewer
ran **no tests** and submitted **no GitHub approval**; the mounted-lifecycle
and unrelated offline control proof gaps were closed in our tests.

Four local, restored negative controls failed their intended behavioral
assertions: bypassing the selected-anchor eligibility preflight; retaining an
earlier retry permission; removing `Cases` identity/authority remount keys;
and bypassing the browser's owner-only envelope parser. An initial passive
cleanup downgrade was harmless under the mount key and was replaced by the
actual key mutation; an initial parser-source mutation did not affect the
previously built package, so the browser's load-bearing parser call was
mutated instead. No mutant or simulated secret is included in the commit.

## Exact functional changed-file manifest

Functional commit `9e9cb51c` changes exactly these 24 paths. The earlier
objective commit adds only the frozen goal; the following receipt commit adds
only this document.

```text
collab/contracts/fixtures/gold-reference-export.invalid-nested.json
collab/contracts/fixtures/gold-reference-export.valid.json
collab/contracts/package.json
collab/contracts/src/gold-browser.ts
collab/contracts/src/gold.test.ts
collab/contracts/src/gold.ts
collab/contracts/src/index.ts
collab/e2e/gold-joined.playwright.config.ts
collab/e2e/specs/43-trusted-benchmark-handoff.spec.ts
collab/e2e/tsconfig.json
collab/server/src/modules/experiments/experiments.test.ts
collab/server/src/modules/experiments/routes.ts
collab/server/src/modules/experiments/service.ts
collab/web/src/Cases.test.tsx
collab/web/src/Cases.tsx
collab/web/src/ExperimentLab.test.tsx
collab/web/src/ExperimentLab.tsx
collab/web/src/HelpCenter.tsx
crates/cd-triage-bench/src/cli.rs
crates/cd-triage-bench/src/gold.rs
docs/benchmarks/GOLD_BACKTEST_LOOP_V1.md
docs/design/PROVEN_METHODS.md
docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md
docs/design/proven-methods/INVESTIGATION_LOOP.md
```

Only this receipt, the frozen objective, changed source, synthetic fixtures,
tests, and handbook/Help text are intended for GitHub. Raw browser downloads,
screenshots/videos, temporary SQLite libraries, compiler caches and private
recovery backups stay local. This is a reviewable human-benchmark handoff, not
a truth verdict, provider-quality ranking, proof of production durability,
public sharing clearance, deployment, or merge authorization.

## TBH-IR-01 bounded review correction — 2026-09-30

Starting published head `73ddb56502a8d6b309218cec1feaf3b447fd6de4`, tree
`a8ae352cadf6564ec67337b145ea651b852a3eeb`, was clean. One fetch confirmed
the branch, main and merge base remained as recorded above. The frozen goal
still hashes to `8227beff2e666b02413f9520948462baf77043f51a27084cc63ee64897d3e2c5`.
This is the existing draft #1188 continuation, not another product goal.

The actual-component controlled-response reproduction demonstrated the review
finding. After submitting anchor A with role `cause` and two dimensions, user
edits changed the visible pending fields; a late accepted snapshot reference
was seeded into that form. The unconfirmed form then showed A plus the late
anchor, role `symptom`, and `uncertain edit`. Nevertheless, the first and replay
POST assertions both retained the original A/role/dimensions; only the explicitly
reviewed `expectedGoldVersion` advanced from 0 to 1. The new behavioral regression
failed on those visible-intent assertions before the correction (1 failed;
76 name-filter exclusions), rather than on setup or payload identity.

The small presentation correction locks native evidence/role/dimension controls
and their initial seeding during pending or unresolved intent. The editor keeps
the original visible evidence choices, labels, accepted context and values;
late resources and ordinary refresh cannot replace that context. A reviewed CAS
version is shown without changing semantic replay. Explicit **Edit a new
benchmark intent** unlocks the existing values, makes late sources available for
one-time review, and sends nothing. A later explicit submit is a new intent.
Known preflight rejection remains editable; confirmed recording releases and
resets the editor before the later display refresh, whose failure does not turn
success into uncertainty. Replay still uses its frozen request, and the existing
attempt/retained-handler guards are unchanged.

The correction changes exactly four paths relative to the starting head:

```text
collab/web/src/ExperimentLab.tsx
collab/web/src/ExperimentLab.test.tsx
collab/e2e/specs/43-trusted-benchmark-handoff.spec.ts
docs/goals/TRUSTED_BENCHMARK_HANDOFF_RECEIPT.md
```

No endpoint, transaction, schema, fingerprint/scoring semantics, owner-only
envelope, importer, checker or workflow changed. Git tree identities remain:
server `40a483518fa515f37551570dc38f70a8d5a90988`, contracts
`5dd426a3b413b8d9faa9bd795c313b960e9b2ad0`, and bench
`1811c7756269e0bf32fecdee7757610b31b54b27`, attributable to their qualification
at `73ddb565`. The checker blob remains
`940b6a5c33c368a2aaefa2ea2256968ea95b6537`. Handbook impact: none — this
correction makes the already-documented frozen-intent workflow visible faithfully.

Qualification commands and results:

- `npx vitest run src/ExperimentLab.test.tsx src/Cases.test.tsx`: **173 passed**.
  The final full web pass includes these affected suites and both new regressions.
- The visible pending/uncertain regression passed **five independent final runs**:
  1 passed / 77 other test names excluded per run. These are name filters, not
  environment skips. A temporary `intentLocked = false` mutation failed the
  visible anchors, role and dimensions assertions while replay payload assertions
  still passed. Exact source bytes were restored (SHA-256
  `c4f5af80d88468aa4430f175913fdd9b1d54187229ab26404167463e6530e577`),
  then the final full suite passed. No mutant is published.
- Web `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` passed;
  final `npm test`: **110 files / 1,839 tests passed**, zero environment skips.
  E2E `npm run typecheck` passed.
- Explicit joined config with `CD_GOAL09_JOINED=1`, the existing compiled bench,
  and `--retries=0`: **1/1 passed** against the corrected production build.
  Real browser assertions covered disabled pending controls, unchanged values
  after acknowledgment loss, and unlocking after matching-history recovery.
  The pending editor's 320px forced-colors/reduced-motion screenshot was visually
  inspected and its document had no horizontal overflow. The real saved file's
  SHA-256 was `a34cc0a1457a56a17c56f7411ab3eaf25fbb38e4c653c9e168055fd4cfaa4f86`;
  original gold `2d7c18da-f999-4275-a27c-fb07fe15eed0`, task
  `task-c5db6b76920a8c19348a5cc77979dddf2d14ad17fa5f8e908537ee062a76ad69`,
  snapshot `snap-8198576802e793eb33fc447e8e9871dd8be80a89ed584d8cb721ee972e9ba8fc`.
  The existing import/report, unrelated control and SQLite restart assertions passed.
- The first joined correction attempt failed recovery because its newly added
  `clarity` dimension was unsupported and filtered by the unchanged route.
  The fixture was corrected to supported `actionability`; the final joined run
  passed without changing product contracts. An initial sandbox-limited Vitest
  launch could not write its cache; the authorized normal test launch ran afterward.
- One separate bounded adversarial source review found **no actionable findings**.
  It ran no tests, accessed no GitHub state, edited nothing and gave no approval.
  Raw test/diagnostic logs and browser recordings remain local.

### Separate historical close-proof observation

On starting head `73ddb565`, collab `36667083988`, collab-qualify `36667084163`
and all three triage workflows succeeded on attempt 1. Root CI `36667084114`
failed only job `109743309102`, close-proof discipline (#254). Its actual checkout
was generated merge `e3f3336b90aa75d820621e3902e5cd8d0562318a`; the log reported
both missing SHA and missing pasted proof for #537 among 120 sampled issues.
The earlier formatting failure in fast lane `36666888693` at `00906b9a` remains
historical; the formatting amendment `73ddb565` was preserved unchanged.

The unmodified `closing_comment_body` selection rule chooses the last marked
closing comment, else the last comment. Running that exact `gh issue view`
selection now exited **0**, returned **1,527 bytes including its output newline**,
and had **empty stderr**. A separate REST read exited 0 and confirmed the selected
body equals comment **5098054687**, SHA-256
`3b48f1713f444cec720226011cdbfc4baddb019c497f923444c57fc515eab6b6` (body without
the output newline). It contains full commit SHAs and the fenced **66 passed**
block. The unchanged checker's `--fixture` mode accepted that selected body
(exit 0). This tests the selected proof; it does not claim a fresh whole-history
live sample passed.

The script suppresses per-issue read stderr/status and substitutes empty content
on read failure. The old log therefore cannot distinguish a failed read from
other missing-body causes. A transient retrieval failure is plausible, **not
confirmed**. #537, its comments/labels and cutoff, the checker and workflow were
not altered. The corrected head's normal hosted run must be assessed separately;
its final identities/conclusions belong in the PR handoff, without recursive
receipt commits. Private archives, credentials and raw recordings remain local.
