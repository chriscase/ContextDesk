# Goal 07 — Trusted Human Review qualification receipt

Status: draft for independent review in PR #1186; no merge authorization. This receipt describes the tested functional candidate and its bounded review correction, not a production deployment or a verified external model run.

## Identity and provenance

- Frozen objective: `docs/goals/07-TRUSTED-HUMAN-REVIEW.md`, SHA-256 `c089d1b3760eb20d377df8df22cc26527de657e17e0d8be65392d0fe482ec92e`; committed unchanged in `66430b3f` before implementation.
- Current-main base and merge base: `0d6d592c5b9cca6b041a7f5eb7f5ef86442e5d11`, tree `92ee16477790bfd45f9729153c4a2c4bec2fe66a`. Main was rechecked at that SHA before draft publication.
- Tested functional candidate C: `19deca5ebd2b18f716c6c6fd59d96de9277bd67c`, tree `06f6f48fe25534730beb0c2be5fb43a48cd265ad`. PR #1186 was created draft on this branch and the branch was subsequently fast-forwarded to C. This later receipt-only commit E does not change product or test files; its exact published head/tree are reported in the PR handoff rather than recursively embedded here.
- Historical #1160 `7630ed77`: **adapted** strict browser-safe judgment parser, schemas, and adversarial contract tests. #1161 `d0363d8b`: **adapted** additive routes, server-owned authority, immutable rows, transaction/replay, migration 032, and fail-closed portable guard. #1162 `aba5a6e9`: **adapted** the optional public Runtime/gateway/controller seam, with current scope and causal-generation corrections. #1163 `768271c2`: **adapted** one War Room Capture composer/history; rejected its resource-object inequality freshness heuristic. #1164 `789d1856`: **adapted** browser cases into new `41-*` without replacing current specs. #1169 `a5a0288b`: **adapted** view-first provenance inspector and its missing-versus-claimed wording. Historical branch heads/PRs were not changed. Current Goal 06 delivery and browser-safe import parser remain the foundation, rather than copied historical parent files.
- Source integration commits: `ee7cecba` (adapted contracts/storage/Runtime/UI), `eb456fed` (causal reconciliation and portable disclosure), `3cbe78f5` (joined and portable tests), `c307a5f1` (review fixes), `19deca5e` (existing browser assertion updates). The objective commit precedes them.

## Bounded independent-review closure after published E

This section supplements the earlier C/E qualification at the exact checkout that produced it; it does not relabel those earlier hosted runs as results for this correction. The frozen objective and backend, contract, migration, and portable-export implementation bytes remain unchanged.

- **THR-IR-01 — second-attempt read race:** Two controlled-promise panel cases first reproduced a history read launched while retry B was pending: after B became unconfirmed or conflicted, the older read could enable retry C. A captured earlier retry callback could likewise issue C. The panel now ties read permission to the current submission attempt and revokes it on every new attempt and uncertain/conflicted result. Panel and public Runtime-adapter regressions exercise the real read-generation seam. Removing the uncertain/conflict revocation temporarily made both named race tests fail; restoration made them pass. No automatic retry was introduced.
- **THR-IR-02 — exercised acknowledgment loss:** The previous SQLite restart script parsed a real HTTP 201 but asserted an unused synthetic 503. Its disposable fetch seam now lets the built server commit and return 201, then drops that response before the production browser gateway can observe it. The gateway reports a network/unconfirmed result; a later authoritative gateway read, process restart and reauthentication recover the single judgment, timeline event, and successful audit. Deliberate same-intent replay with the original idempotency key returns 200 without another row. This is SQLite restart evidence; the separate PostgreSQL interrupted-COMMIT test remains the earlier C evidence and was not rerun because its sources were untouched.
- **THR-IR-03 — historical scanner false positives:** Root [CI #36500051656](https://github.com/chriscase/ContextDesk/actions/runs/36500051656), Gitleaks job `109194912040`, found seven `generic-api-key` matches in historical `ee7cecba` under `collab/server/src/modules/import/judgment.test.ts`. Inspection confirms six literal synthetic request idempotency identifiers, one used twice, with no credential authority. `.gitleaks.toml` now allows only those exact literals, the `generic-api-key` rule, and that test path. Gitleaks 8.24.3 over the actual seven-commit first-parent PR range found the seven with the prior config and zero with the correction. A different synthetic key at the same path still produced a finding. This local scan does not assert that the subsequent hosted run has passed.

Correction qualification: full collaboration typecheck, lint, and build passed; E2E typecheck passed. The affected panel/Runtime/controller/gateway selection passed **207/207**. The full web suite passed **1,812/1,812** with one worker; two earlier parallel full runs each had one different timing-sensitive failure in untouched `Cases.test.tsx` and `Catalog.test.tsx`, and each named case passed alone. The selected phase-sensitive client set passed **7/7 in five independent runs**, with 133 unrelated tests filtered per run. The rebuilt SQLite gateway/restart proof passed with committed status 201 withheld, production caller outcome `network/unconfirmed`, zero automatic retry POSTs, an authoritative read, and status 200 replay after restart. The affected Goal 07 Chromium journey passed **4/4 without retries**; the final ordinary full Chromium suite passed **159 with 9 existing skips**, without retries. This correction's browser result is separate from the earlier C run.

## THR acceptance ledger

| Criterion | Evidence on C | Boundary |
| --- | --- | --- |
| THR-01 | `collab/contracts/src/external-run-judgment.ts`, six strict JSON schemas, parser/schema parity and adversarial tests; additive migration `032`; full typecheck, dependency guard and current-base merge base. | Schema shape is checked by contract tests; eligibility and authority remain semantic server checks. |
| THR-02 | `ImportedRun.tsx` and tests render actual import provenance and unknown/claimed fields; `Cases.tsx` and E2E 41 keep Human assessments distinct from Save review and legacy unverified banner. | Claimed traces and package hashes are not proof of model execution or correctness. |
| THR-03 | Import service/store and SQLite/PostgreSQL migration append immutable attributed rows in sequence, with 1,024 cap, strict complete list and explicit focused-run read; judgment tests cover replays, cap and corruption. | No aggregate score, overwrite, or inferred verdict. |
| THR-04 | Judgment routes/service, atomic store and audit/timeline tests; disposable real PostgreSQL grants/migration/atomicity/concurrency tests. Fresh write 201, replay 200, same actor ID and intent bound; a username rename preserves original attribution. | Current case/run/citation visibility and lifecycle policies remain server-owned. |
| THR-05 | `use-external-run-judgments.ts`, panel, and gateway reject mismatched success envelopes, freeze uncertain intent/key, require post-failure successful read generation, permit refreshed CAS, and prevent duplicate effects. A network-lost POST acknowledgment is unconfirmed; changed intent with retained key refuses. | A failed read never proves rollback; retry is deliberate, not automatic. |
| THR-06 | App keyed replacement probe captures an old submit before passive cleanup and counts attempted handler, Runtime calls and gateway POST; controller/adapter tests cover scope, authority, A→B→A, run removal, late completions and citation reauthorization. | Navigation to an inaccessible current target is suppressed while its historical citation remains visible. |
| THR-07 | Panel and E2E 41 cover empty/loading/stale/failed/denied/read-only/busy/success/conflict/refusal/unknown states, keyboard and focus, 320px/390px reflow, computed forced-color boundaries/focus and reduced-motion. | No real assistive-technology or non-Chromium audit is claimed. |
| THR-08 | First-write local acknowledgment, ExportPanel and Help copy, authoritative `caseHasStoredJudgments` over all stored runs, portable export/preflight/apply guards and tests for hidden runs/older archive replay. | Assessment rows are not in portable archives or ordinary brief/package exports; affected exact portable actions refuse. |
| THR-09 | Synthetic E2E 41 joined package → manual import → provenance → cited disagreement → reload → canonical return; built server/SQLite stop-and-restart reauthenticates, finds one row/event/audit and deliberately replays 200 without duplicates. The later review correction exercises acknowledgment loss through the production gateway. Real PostgreSQL qualification and four earlier restored mutations below. | Browser-only injected 503, SQLite transport fault, and real PostgreSQL interrupted COMMIT are distinct evidence. |
| THR-10 | Full collaboration gates and guards below; separate read-only adversarial review, findings repaired and regressions added; one draft PR. | Hosted checks and owner integration remain separate decisions. |

## Local qualification on C

From `collab/`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run typecheck -w @cd-collab/e2e` all passed. The full unit run recorded contracts **944 passed**, server **1,323 passed / 118 skipped in the default environment**, and web **1,808 passed**. The default server run's PostgreSQL skips are not presented as backend proof.

With a disposable real local PostgreSQL cluster supplied through `COLLAB_TEST_ADMIN_URL`, `npm test -w @cd-collab/server -- --run src/modules/import/judgment-atomicity.pg.test.ts src/db/grants.test.ts --reporter=dot` passed **5/5** (no PostgreSQL skips); `npm test -w @cd-collab/server -- --run src/db/migrate.test.ts -t judgment --reporter=dot` passed **3/3 selected**, with 13 unrelated tests filtered by the name selector. This covers SQL migration/grants, concurrent same-key and competing-key behavior, rollback between persistence steps and post-commit interrupted response.

After `npm run build`, the C version of `node --import tsx/esm e2e/src/judgment-sqlite-restart.ts` passed against the built server, using one temporary SQLite database across process restart: a parsed HTTP 201, fresh GET after reauthentication, HTTP 200 same-intent replay, and exactly one judgment/timeline event/successful audit. Its unused synthetic `callerObserved` 503 did **not** prove caller-level acknowledgment loss; the later THR-IR-02 correction above supplies that exercised proof. The temporary database and logs stayed local.

`sh scripts/check_claims_test.sh`, `sh scripts/check_claims.sh` (including the design handbook guard), `node scripts/check_war_room_fixtures.mjs`, `npm run scenarios:check -w @cd-collab/e2e`, and `git diff --check` passed. The scenario catalog has 13 current scenarios; the fixture privacy scan reported 32 clean files. Dependency boundary tests are included in the passing full web suite. Migration/grant guards were exercised on real PostgreSQL as above.

The first full no-retry Chromium run on predecessor `c307a5f1` recorded **157 passed / 9 skipped / 2 failed**. Both failures were stale browser assertions for the intentionally revised provenance wording: spec 11 expected the former details summary, and spec 40 matched lowercase-only “described by the importer.” Their assertions were updated in `19deca5e`; the two affected journeys then passed **3/3** without retries. The complete final-candidate Chromium run, `npm test -w @cd-collab/e2e -- --project=chromium --retries=0`, passed **159 / 9 skipped**; all four Goal 07 tests passed. The nine skips are pre-existing optional browser cases, not Goal 07 failures. Chromium used the local Google Chrome binary, the built current web client, and the standard synthetic in-memory server fixture.

Four selected phase-sensitive tests (captured submit before passive cleanup, post-failure causal read, network-lost acknowledgment intent, and currently authorized citation navigation) passed in **five independent runs**, 4/4 each time. Each selection reported 132 unrelated tests skipped by the name filter; those are not suite skips.

After the full suite, `specs/41-trusted-human-review.spec.ts` passed **4/4 in three independent no-retry runs** (27.7s, 33.8s, 30.3s). A separate **4/4 no-retry run** (40.8s) used the built web client and a temporary fixture whose server imports pointed to compiled `collab/server/dist` modules. That fixture passed `/health`, ran on a disposable local port, and was removed immediately afterward; no variant was committed. The standard full suite instead uses the repository's in-memory server-source fixture, so its result is not labeled built-server durability proof. The independent SQLite process-restart proof above covers durability.

At candidate C, hosted pull-request runs for exact head `19deca5e` were: [collab #36499002094](https://github.com/chriscase/ContextDesk/actions/runs/36499002094) and [collab-qualify #36499001866](https://github.com/chriscase/ContextDesk/actions/runs/36499001866) **success**; [CI #36499001973](https://github.com/chriscase/ContextDesk/actions/runs/36499001973) **pending** at this read; three triage fast lanes #36499001869, #36499001861 and #36499001877 **success**. The exact-head push collab #36498998961 and collab-qualify #36498998946 also succeeded. Earlier draft-branch collab failures on predecessor heads were superseded by the C runs; the initial C predecessor full browser failure is described above. The current-main baseline [CI #36447899024](https://github.com/chriscase/ContextDesk/actions/runs/36447899024) completed successfully on `0d6d592c`, attempt 1. The receipt-only E commit will start its own hosted checkout; do not read these C identities as E results.

## Temporary restored mutation proofs

Each mutation was made only in the local worktree, failed its named test, was restored byte-for-byte, and then the same test passed. No mutation edit or private local log was committed.

| Guarantee | Temporary mutation and named detector | Result |
| --- | --- | --- |
| Scope cleanup timing | Disable the first committed-scope guard in `runtime-external-run-judgments.tsx`; `App.test.tsx -t 'captured assessment submit'`. | Mutant failed: one Runtime create instead of zero; restored passed. |
| Causal history read | Weaken `readCompletion >= awaitedReadGeneration` in `HumanAssessmentsPanel.tsx`; panel test `-t 'rejects a pre-failure read'`. | Mutant failed: old read unlocked retry; restored passed. |
| Changed-intent replay | Bypass the digest check in `ImportService.replayRunJudgment`; `judgment.test.ts -t 'binds replay to the actor and intent'`. | Mutant failed: changed intent no longer returned required 409; restored passed. |
| Stored portable refusal | Make `caseHasStoredJudgments` return false; portable test `-t 'refuses export when a hidden stored run has judgments'`. | Mutant failed: unsupported export was allowed; restored passed. |

## Independent read-only review

The separate `/root/goal07_adversarial_review` agent inspected C's predecessor without editing, committing, pushing or running broad tests. It found three concrete issues, all corrected in C: a network-lost POST acknowledgment was treated as definitive; durable same-key replay failed after an actor username change despite stable actor ID; and the client accepted a successful response with different judgment, links or rationale. New controller/adapter, server and gateway regressions passed. The reviewer found no further concrete defect in the inspected transaction/privacy, causal-read, committed scope, or portable apply/export paths. This review is not GitHub approval.

## Synthetic replay and nonclaims

Run the built collaboration demo with synthetic local auth, then execute `npm test -w @cd-collab/e2e -- --project=chromium specs/41-trusted-human-review.spec.ts --retries=0` from `collab/`. The spec creates its own synthetic case and checked package. For durable replay, build the server and run `node --import tsx/esm e2e/src/judgment-sqlite-restart.ts`; it owns and removes its temporary fixture. No external model call, production data, private recovery archive, or external service is needed. These tests demonstrate imported-response review and persistence, not genuine model exposure, correctness, benchmark truth, or complete portable backup.

## Changed-file manifest

The exact relative-path manifest for C follows; it is generated from `git diff --name-only 0d6d592c5b9cca6b041a7f5eb7f5ef86442e5d11..19deca5ebd2b18f716c6c6fd59d96de9277bd67c`. The later receipt-only E changes this file alone.

```text
collab/contracts/package.json
collab/contracts/schemas/external-run-judgment-conflict.v1.json
collab/contracts/schemas/external-run-judgment-list.v1.json
collab/contracts/schemas/external-run-judgment-refused.v1.json
collab/contracts/schemas/external-run-judgment-request.v1.json
collab/contracts/schemas/external-run-judgment-success.v1.json
collab/contracts/schemas/external-run-judgment.v1.json
collab/contracts/src/external-run-judgment.adversarial.test.ts
collab/contracts/src/external-run-judgment.test.ts
collab/contracts/src/external-run-judgment.ts
collab/contracts/src/index.ts
collab/e2e/specs/11-operator-journey.spec.ts
collab/e2e/specs/40-trusted-export-handoff.spec.ts
collab/e2e/specs/41-trusted-human-review.spec.ts
collab/e2e/src/judgment-sqlite-restart.ts
collab/server/src/db/grants.test.ts
collab/server/src/db/migrate.test.ts
collab/server/src/db/migrations/032_external_run_judgments.down.sql
collab/server/src/db/migrations/032_external_run_judgments.up.sql
collab/server/src/db/sqlite.test.ts
collab/server/src/db/sqlite.ts
collab/server/src/modules/activity/external-run-judgment-projection.test.ts
collab/server/src/modules/activity/project.ts
collab/server/src/modules/import/judgment-atomicity.pg.test.ts
collab/server/src/modules/import/judgment.test.ts
collab/server/src/modules/import/routes.ts
collab/server/src/modules/import/service.ts
collab/server/src/modules/import/store.ts
collab/server/src/modules/portable-investigations/persist.ts
collab/server/src/modules/portable-investigations/portable-investigations.test.ts
collab/server/src/modules/portable-investigations/service.ts
collab/web/src/App.test.tsx
collab/web/src/App.tsx
collab/web/src/Cases.test.tsx
collab/web/src/Cases.tsx
collab/web/src/ExportPanel.test.tsx
collab/web/src/ExportPanel.tsx
collab/web/src/HelpCenter.test.tsx
collab/web/src/HelpCenter.tsx
collab/web/src/ImportedRun.test.tsx
collab/web/src/ImportedRun.tsx
collab/web/src/TriageWorkspace.test.tsx
collab/web/src/TriageWorkspace.tsx
collab/web/src/investigations/dependency-boundary.test.ts
collab/web/src/investigations/runtime/InvestigationRuntimeProvider.test.tsx
collab/web/src/investigations/runtime/InvestigationRuntimeProvider.tsx
collab/web/src/investigations/runtime/capabilities.test.ts
collab/web/src/investigations/runtime/capabilities.ts
collab/web/src/investigations/runtime/controllers/index.ts
collab/web/src/investigations/runtime/controllers/use-external-run-judgments.test.tsx
collab/web/src/investigations/runtime/controllers/use-external-run-judgments.ts
collab/web/src/investigations/runtime/errors.test.ts
collab/web/src/investigations/runtime/errors.ts
collab/web/src/investigations/runtime/gateway.test.ts
collab/web/src/investigations/runtime/gateway.ts
collab/web/src/investigations/runtime/public.test.ts
collab/web/src/investigations/runtime/public.ts
collab/web/src/investigations/runtime/testkit/fixtures.ts
collab/web/src/investigations/runtime/testkit/gateway-double.ts
collab/web/src/investigations/strategies/keystone/KeystoneHypothesisComposer.tsx
collab/web/src/investigations/strategies/runtime-coordination.tsx
collab/web/src/investigations/strategies/runtime-external-run-judgments.test.tsx
collab/web/src/investigations/strategies/runtime-external-run-judgments.tsx
collab/web/src/investigations/strategies/shared/HumanAssessmentsPanel.test.tsx
collab/web/src/investigations/strategies/shared/HumanAssessmentsPanel.tsx
collab/web/src/investigations/strategies/shared/index.ts
collab/web/src/styles/catalog.css
collab/web/src/styles/investigation-strategy-shared.css
docs/design/PROVEN_METHODS.md
docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md
docs/design/proven-methods/INVESTIGATION_LOOP.md
docs/goals/07-TRUSTED-HUMAN-REVIEW.md
```
