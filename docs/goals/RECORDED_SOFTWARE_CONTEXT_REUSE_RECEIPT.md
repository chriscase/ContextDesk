# Goal 08 — Recorded Software Context Reuse receipt

Status: functional candidate qualified locally for one draft PR and independent review. Hosted checks for the published evidence commit are separate evidence; this document does not call queued work a pass or authorize a merge.

## Provenance and exact revision

- Supplied objective: `docs/goals/08-RECORDED-SOFTWARE-CONTEXT-REUSE.md`, SHA-256 `609abaa88d085513590302db69342518d2717e10959316fe9f396b41c4f5ba20`. Commit `b39f12347373e6ff89abd15228f4292d4c16b6aa` froze its exact bytes before production edits.
- Original and reverified `origin/main`, and merge base: `7ed71e9930ae5f56345e81e321ef02766ad1efb9`, tree `7efbff74580d8f9b7ed31d61d9b3bff5d530b92f`. The remote main check before publication returned this same head.
- Tested functional candidate: `aad89aab3cc016bf6bb268232fdf0769bbdb8a6d`, tree `568e492769251b3e87abde15c0af88e2bd637aa6`. The later receipt commit changes only this document. Its exact remote head/tree and hosted run identities belong in the PR handoff, without a recursive evidence commit.
- Owned branch: `integrate/recorded-software-context-reuse-v1`. Historical PR #1174 at `9a2b2d29c007cd11512ebd2928ea2b7160b42e23` was inspected as source only. Its native input and pure-helper approach was selectively adapted; its cross-product fallback and global “new value” wording were rejected. No historical branch or PR was edited, rebased, merged, or used as today's qualification.
- No server, contract, storage, schema, endpoint, migration, or software-impact identity changed. The new UI consumes the existing public Runtime investigation list and the existing create/Situation commands.

## Editor and source inventory

| Existing path | Suggestion source and save path | Existing normalization |
| --- | --- | --- |
| War Room create and Situation edit, `Cases.tsx` | Shell-provided public Runtime investigation list; existing create and Situation save | Nonblank context fields retained as entered; all-blank context becomes null |
| Investigation First create, `InvestigationFirstStrategy.tsx` | Public Runtime investigation list; existing create command | Outer whitespace trimmed on all six fields |
| Beacon create, `BeaconStrategy.tsx` | Public Runtime investigation list; existing create command | Nonblank context fields retained as entered |
| Keystone Situation edit, `KeystoneStrategy.tsx` and `KeystoneSituationEditor.tsx` | Public Runtime investigation list; existing version-checked Situation command | Nonblank text retained; whitespace-only fields become empty |

The shared helper `recorded-context-options.ts` keeps exact, first-observed strings, exact parent constraints, real three-field tuples, and a 100-option display cap. `RecordedContextFields.tsx` provides native datalists, a separately applied tuple chooser, manual input, scope fencing, and truthful source states. A tuple changes only product, version, and build in the local draft. The list can be partial; it is neither a complete software catalog nor a software-impact verdict. Keystone still has no create action.

## SCR acceptance ledger

| Criterion | Qualification evidence and limit |
| --- | --- |
| SCR-01 | `App.tsx`, the three Runtime-backed strategies, `Cases.tsx`, and the adapter use already loaded authorized investigation DTOs without a new request. Denied read returns no options. Partial/refresh/unavailable copy avoids a global claim. |
| SCR-02 | Helper tests cover exact duplicate strings, case/whitespace/Unicode variants, missing fields, different products, no cross-parent fallback, stable order, collision-free tuple keys, and a valid value beyond the 100-option cap. Manual and incomplete context stay legal. |
| SCR-03 | Shared control tests and E2E 42 show explicit preview then Apply with zero writes; only the three named fields change. Removal from the latest eligible source disables application. War Room/Keystone Cancel and later explicit saves retain their original semantics. |
| SCR-04 | Hints say “loaded investigation records,” expose partial scope and normalization, and never call a manual value globally new. Investigation First's existing trim is asserted at submitted command level; other editor commands retain entered nonblank literals. |
| SCR-05 | War Room create/edit, Investigation First create, Beacon create, and Keystone edit use the shared control. E2E 42 creates, saves, reloads, and switches through all four displays. Read-only paths and Keystone's lack of creation remain unchanged. |
| SCR-06 | Control tests cover stable tuple keys across reorder, removed candidates, draft preservation, and captured A→B→A callbacks. The mounted `KeystoneStrategy.test.tsx` Runtime/editor probe invokes the retained callback before an independent passive-cleanup witness, then again in B and returned A; it separately asserts three invocations, zero observed draft changes, zero Situation commands, and zero additional gateway requests from stable-scope callback calls. Browser navigation is not claimed as same-tree proof. |
| SCR-07 | Helper/control tests distinguish idle, loading, available, empty, unavailable, refreshing previous snapshot, failed-refresh stale, denied read, cap, no parent match, and manual out-of-window value. Dynamic `useId` links simultaneous mounts; native inputs and explicit select retain keyboard access. E2E checks 320px, forced colors, and reduced motion. No real assistive-technology or non-Chromium audit was performed. |
| SCR-08 | `42-recorded-software-context-reuse.spec.ts` seeds two synthetic products through the existing API, creates through three presentations, deliberately edits/cancels/saves in Keystone and War Room, checks POST/PATCH payloads and reloaded canonical DTOs, and verifies all four views. A separate injected read failure and second-identity denial are labeled as such; the successful create/edit proof uses the real disposable server. Existing discovery/collection journeys passed. |
| SCR-09 | Full local gates and bounded repetitions below; four temporary mutations each failed its named detector and were restored byte-for-byte. One separate read-only adversarial source review found two issues, corrected with focused regressions. |
| SCR-10 | Help, Proven Methods, Investigation Loop, and living backlog distinguish shipped Goal 07 from the unmerged Goal 08 slice, loaded-only suggestions, manual values, tuple action, and normalization. This receipt and one draft PR are the publication artifacts. |

## Local qualification and original failures

- `npm run typecheck`, `npm run lint`, and `npm run build` in `collab/web`; `npm run typecheck` in `collab/e2e`; dependency boundary, `git diff --check`, claims, design-handbook, and War Room fixture-privacy guards all passed. The full web suite passed **1,825/1,825 in 110 files** with one worker. A preceding full run was **1,821 passed / 1 dependency-boundary failure** because the new strategy imports had bypassed `shared/index.ts`; exports/imports were corrected before the passing run.
- The two selected scope regressions passed **2/2 in five name-filtered runs**. Each run reported 16 unrelated tests filtered by the name selector, not environment skips. The new browser spec passed **2/2 in three independent no-retry runs**, then 2/2 again in the full suite.
- The first affected existing browser selection reported **37 passed / 2 failed**. Both failures were an older Investigation First accessibility locator matching both the “Build” field and the new product/version/build chooser. Its exact-name locator was corrected; that spec then passed **5/5**. The complete final ordinary Chromium suite, with retries disabled, passed **161 with 9 existing environment skips** out of 170. Earlier new-spec development failures involved an ambiguous locator, an account-menu overlay, and forced-colors focus; the last exposed a real focus-style issue that was fixed before the passing qualification.
- The browser fixture uses synthetic local auth and disposable server state. These results do not prove production persistence, a real external provider call, all-browser accessibility, or a complete catalog. No unchanged live PostgreSQL/SDK/storage campaign or cold Rust/Tauri build was rerun for this presentation-only change.

Four temporary mutations were local only, each detected by a named failing test and restored exactly before final qualification:

| Mutant | Named detector |
| --- | --- |
| Reintroduce cross-product fallback | Helper “never borrows a version or build” |
| Reintroduce global absence wording | Control “describes an empty loaded set locally” |
| Remove retained A→B→A callback fence | Control “conceals obsolete options before passive cleanup” |
| Bind tuple build to the wrong field | Control “applies only an exact recorded tuple” |

The separate read-only reviewer inspected source but ran **no tests** and submitted **no GitHub approval**. It found that a previous snapshot during an active refresh was labeled available (and idle was called loading), and that the first A→B→A control test did not mount a real Runtime/editor or count draft/save/request effects. The adapter now distinguishes idle, refreshing, and failed refresh; refreshing displays a notice and cannot apply a tuple. Focused adapter/control tests and the mounted Keystone transition test close those findings. This was one bounded review, not a repeated whole-repository audit.

## Baseline CI and hosted boundary

At the pinned main revision, `collab` [run 36520523693](https://github.com/chriscase/ContextDesk/actions/runs/36520523693) and `collab-qualify` [run 36520523683](https://github.com/chriscase/ContextDesk/actions/runs/36520523683) succeeded on attempt 1. Root [CI run 36520523800](https://github.com/chriscase/ContextDesk/actions/runs/36520523800) initially failed when the macOS cache download hit DNS `ENOTFOUND` at warm-cache preflight; later Rust steps did not run on that attempt. The authorized targeted retry produced **attempt 2 success** on the same main head: warm-cache preflight, fmt, clippy, example build, and server smoke completed in macOS job `109269127092`. These are baseline results, not exact Goal 08-head checks. New hosted jobs must be read at their actual pushed head or generated merge checkout; pending is pending.

## Published file manifest and nonclaims

Functional commit `aad89aab` changes exactly these 23 paths; objective commit `b39f1234` adds the frozen objective, and the following evidence-only commit adds this receipt:

```text
collab/e2e/specs/27-investigation-first-accessibility.spec.ts
collab/e2e/specs/42-recorded-software-context-reuse.spec.ts
collab/web/src/App.tsx
collab/web/src/Cases.test.tsx
collab/web/src/Cases.tsx
collab/web/src/HelpCenter.tsx
collab/web/src/InvestigationFirst.test.tsx
collab/web/src/investigations/strategies/beacon/BeaconStrategy.test.tsx
collab/web/src/investigations/strategies/beacon/BeaconStrategy.tsx
collab/web/src/investigations/strategies/investigation-first/InvestigationFirstStrategy.tsx
collab/web/src/investigations/strategies/keystone/KeystoneSituationEditor.test.tsx
collab/web/src/investigations/strategies/keystone/KeystoneSituationEditor.tsx
collab/web/src/investigations/strategies/keystone/KeystoneStrategy.test.tsx
collab/web/src/investigations/strategies/keystone/KeystoneStrategy.tsx
collab/web/src/investigations/strategies/shared/RecordedContextFields.test.tsx
collab/web/src/investigations/strategies/shared/RecordedContextFields.tsx
collab/web/src/investigations/strategies/shared/index.ts
collab/web/src/investigations/strategies/shared/recorded-context-options.test.ts
collab/web/src/investigations/strategies/shared/recorded-context-options.ts
collab/web/src/styles/investigation-strategy-shared.css
docs/design/PROVEN_METHODS.md
docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md
docs/design/proven-methods/INVESTIGATION_LOOP.md
```

Only this sanitized receipt, objective, source, tests, and handbook changes are intended for the remote branch. Local browser reports, videos, mutation logs, caches, and private recovery material are not review artifacts and remain local. A draft PR is a review checkpoint, not a deployment, merge, verified software identity, privacy grant, or measured reduction in entry error.
