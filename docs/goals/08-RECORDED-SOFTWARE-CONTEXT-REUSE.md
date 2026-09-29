# ContextDesk Goal 08 — Recorded Software Context Reuse

/goal Make existing software-context entry easier and more consistent across the four investigation presentations. Reuse exact values and product/version/build combinations from already loaded, currently authorized records; preserve free entry, existing save semantics, privacy, and draft safety. Selectively adapt historical PR #1174 on current main, qualify the real create/edit/reopen journey, and publish one draft PR. Do not merge.

## Outcome and explicit boundaries

An investigator can reuse a recorded product, version, and build without retyping them or accidentally borrowing another product's values. The interface explains where suggestions came from, distinguishes an exact loaded match from an unobserved value, and never pretends a partial list is an authoritative software catalog. A deliberate complete-tuple choice changes only the local product/version/build draft. The existing create or Situation save remains the only persistence action.

This is a presentation and existing-Runtime integration goal. It does not introduce a catalog database, new software identity, aliases, global completeness, tags, semantic-version interpretation, automatic deduplication, cross-case mutation, or a bulk metadata API. It does not promise that suggestions reduce real-world entry errors until measured separately.

Creation in War Room, Investigation First, and Beacon, plus the existing War Room and Keystone Situation editors, are the concrete editing targets. Inspect current main for any other existing context editor and use the same shared behavior where applicable. Keystone intentionally has no create workflow; preserve that product distinction. Do not add one simply to make the presentations symmetrical. All four presentations must correctly display the saved canonical context and retain their existing navigation and discovery behavior.

## Pinned starting evidence

- Repository: `chriscase/ContextDesk`.
- Observed main: `7ed71e9930ae5f56345e81e321ef02766ad1efb9`.
- Observed main tree: `7efbff74580d8f9b7ed31d61d9b3bff5d530b92f`.
- Goal 07 landed through merged PR #1186. It is completed work, not an unfinished prerequisite.
- New branch: `integrate/recorded-software-context-reuse-v1`.
- This supplied file's destination: `docs/goals/08-RECORDED-SOFTWARE-CONTEXT-REUSE.md`.
- Historical source: PR #1174, `grok/contextdesk-product-build-catalog-v1`, head `9a2b2d29c007cd11512ebd2928ea2b7160b42e23`.
- Historical source base reported by that PR: `10073524218496926f7e06df654b33fb1c4609fa`. Its old merge relationship is not today's qualification.

Verify actual state before editing. Inspect owned worktrees and preserve any dirty/unpushed work. If this goal already has local work, recover it rather than overwriting it. If main advanced compatibly, inspect the delta and record the new exact base separately; do not edit this supplied objective to erase its original observations. Stop only for a genuine overlapping ownership conflict, unsafe operation, missing input, or unresolved architectural incompatibility.

Commit the actual supplied objective bytes unchanged before production changes. Verify against the supplied SHA256SUMS. Put execution metadata and provenance in the receipt, not as a preamble to this file. Never replace the objective with a shorter acceptance extract.

## Bounded baseline-CI disposition

On observed main, `collab` run `36520523693` and `collab-qualify` run `36520523683` succeeded, attempt 1. Root `CI` run `36520523800` failed, attempt 1, at macOS preflight job `109252213844`, step `require warm cache`.

That job's log shows a cache hit followed by a DNS `getaddrinfo ENOTFOUND` while downloading the cache. The restore was then classified cold, and the prerequisite refused to proceed. Its fmt/clippy/example/server checks did not execute. This is an observed cache-download failure, not evidence of a failed Rust assertion. Do not label those skipped checks as passed.

Recheck the current attempt once. This goal permits one targeted rerun of that failed job and only required dependents if it is still unresolved, subject to normal tool approval. Do not rerun successful collaboration jobs, purge caches, raise timeouts, disable the warm-cache guard, or change workflows/Rust in this feature branch. If it repeats, preserve the exact failure and report a separate infrastructure blocker. Isolated implementation and draft publication may proceed; integration remains gated by normal required results and an explicit baseline disposition. Do not create successive polling-only goal turns.

## Read-first source map

Read repository agent/workflow/cache instructions, this full goal, and relevant sections of the living backlog and Proven Methods handbook. Then inspect only the affected paths and their callers:

- `collab/web/src/App.tsx`, `Cases.tsx`, and focused tests.
- `collab/web/src/investigations/war-room/useWarRoomCollectionQuery.ts`.
- `collab/web/src/investigations/strategies/collection-query.ts` and current collection DTO/selectors.
- Current Investigation First and Beacon strategy create forms.
- `collab/web/src/investigations/strategies/keystone/KeystoneStrategy.tsx` and `KeystoneSituationEditor.tsx`, including its draft/conflict tests.
- Current public Runtime resource, scope, capability, create, and Situation command contracts.
- Existing context normalization and server request validation, read-only inspection only.
- Historical #1174's `RecordedContextCombo.tsx`, `recorded-context-options.ts`, consumers, tests, and final child delta.
- `collab/e2e/specs/37-trusted-investigation-discovery.spec.ts`, the relevant existing strategy journeys, and current filename inventory.

Do not read every unrelated file or replay all earlier goal transcripts. Search before guessing paths. Produce a small initial map of editor -> source resource -> normalizer -> existing save command -> qualification test, then implement.

## Historical source disposition

Selectively forward-port #1174; do not rebase or merge its branch blindly. Keep its branch and PR unchanged.

Preserve useful pure selection helpers and native input semantics. Improve two specific limitations:

1. Its `matchingRecords` falls back to all records when a selected product or product/version has no match. The new behavior must not silently present another product's version/build as a related suggestion.
2. Its copy can call a value "new" or say "no recorded values yet" without identifying the loaded scope. The new behavior must describe the observed set, not global absence.

Complete Keystone's existing editor integration without adding Keystone creation. Maintain per-mount unique helper identities rather than copying fixed IDs. Historical tests and CI remain attributed to their historical source; they do not qualify this integrated candidate.

## Acceptance contract

### SCR-01 — Existing authority and honest suggestion scope

Use only current, authorized DTOs already exposed by the existing Runtime/collection boundary. A small pure adapter may combine the current canonical case with an already loaded authorized investigation list. Do not create new fetches, enumerate every page, widen a query, or read browser storage/private corpora merely to fill suggestions.

Record which source the adapter uses. The interface must say suggestions are drawn from loaded authorized investigations (and the current record if included). If a source is query-filtered, partial, truncated, stale, unavailable, or unrequested, do not imply all installations or all investigations were searched.

Do not misrepresent primary `investigationContext` as the complete canonical software-impact collection. Do not change software-impact identity, membership, facet counts, or query semantics. Reusing context is a user-entered description, not a server verdict about the affected product.

### SCR-02 — Exact dependent values, no invented relationships

One shared helper covers the existing six fields: productName, version, build, component, environment, organization. Preserve nonblank literals as recorded, exact-string deduplication, and stable first-observed order. No case folding, Unicode normalization, semver ordering, alias expansion, or popularity ranking.

For version suggestions, a nonblank product draft constrains candidates to that exact product. For build suggestions, constrain by every nonblank product/version parent that is present. If no record satisfies those constraints, return no related suggestions; do not fall back to other products. Blank parents may show broader observed values only with honest non-specific guidance.

Do not infer that arbitrary independently selected values form a previously recorded combination. Changes to one field must not silently clear, select, or rewrite other fields. Free entry and incomplete context remain valid under the existing command contract.

Bound each displayed option set and tuple list to a documented small constant (100 is the proposed maximum), with a truthful omitted/truncated indicator. Do not call that count the complete domain. Test values beyond the cap without fetching more data. The cap limits suggestion display, not legal input or saving.

### SCR-03 — Deliberate complete-tuple reuse

Provide one accessible way to choose a recorded product/version/build combination as a unit, using only a combination that actually occurs in an eligible record. It may be a small native select plus an explicit action; do not build an elaborate combobox framework.

Show product, version, and build, including missing values, before application. Reuse only those three fields. Do not implicitly copy customer/organization, environment, component, case membership, title, problem statement, evidence, or another case's identifiers.

Applying a tuple is an explicit local draft operation, not a save. Explain that populated software fields will be replaced and do not apply while merely opening/highlighting an option. Key selection by the actual exact tuple rather than an unstable array position or ambiguous string concatenation. The chosen candidate must still be eligible when applied.

Keep manual edits possible afterward. On existing editors, Cancel restores existing cancellation semantics; applying a suggestion must not create a server write, silently accept a conflict, or replace the editor's original CAS baseline.

### SCR-04 — Accurate match and save messaging

Use bounded statements such as "matches a value in the loaded records" and "not found among the loaded suggestions; manual entry is still available." Never claim a global new value, global uniqueness, catalog registration, or canonical reuse authority.

Inspect and preserve the existing normalization for every editing path. Some paths trim outer whitespace while others retain nonblank strings; do not silently unify them in this goal. When a chosen literal will be transformed by the existing save path, make that consequence visible and test the actual submitted value. Do not claim byte-exact storage when the established normalizer changes it.

A match is a statement about source strings or explicitly described submitted strings, not an identity merge. Null, missing, empty, whitespace-only, Unicode, punctuation, long strings, case variants, and delimiter characters must not crash or invent facts.

### SCR-05 — Integrate the existing editors, not new product modes

Apply the shared behavior to War Room, Investigation First, and Beacon creation, War Room Situation editing, and Keystone Situation editing. Inventory other existing context editors and make their common fields consistent where they already exist; do not add new edit capabilities to a read-only presentation.

Do not change transport, mutation ownership, privacy defaults, timestamp interpretation, field requirements, idempotency or situation-version semantics. Existing server validation remains authoritative. Loading or failing suggestions must not block otherwise permitted manual creation/editing. Read-only/no-write users keep the same existing action restrictions.

Preserve each strategy's layout and workflow. Keystone remains an evidence-focused presentation without record creation. All four must display the same saved server context after reload and strategy switching.

### SCR-06 — Draft lifetime and scope protection

Suggestion arrival, pagination, same-scope refresh, and a changed suggestion ordering must not overwrite typed drafts, reset a dirty editor, move focus unnecessarily, or change a selected candidate by index. A stale same-scope source may remain visible only with a stale notice; it cannot prove a current global match.

On identity, authorization-generation, case/editor lifetime, or source-query replacement, conceal obsolete options and candidate previews before the replacement paint. Captured old tuple-apply/retry callbacks must not modify a new scope's draft or cause any request. If a saved draft is intentionally cleared on authority loss, preserve the existing fail-closed behavior rather than widening authority to retain it.

Test the real wrapper/mount composition, not only a standalone selector. Use a replacement-layout probe and an independent passive-cleanup witness for the load-bearing transition; retain A-to-B-to-A coverage. Count actual callback invocation, draft change, save-command invocation, and gateway requests separately. No browser remount is to be mislabeled same-tree first-render proof.

A selected candidate removed from the latest eligible source cannot still be applied as an authorized recorded suggestion. Already user-entered same-scope text remains editable/manual under existing policy; do not erase it just because an optional suggestion disappeared.

### SCR-07 — Truthful states and accessible operation

Qualify initial idle/loading, available, empty loaded set, unavailable, stale same-scope refresh, truncated suggestions, no parent match, denied read, denied write, and a retained manually entered value outside the option window.

Use unique label/input/list/hint/notice IDs for simultaneous create and edit mounts, repeated shared components, and strategy replacement. Test semantic descriptions and focus, not just absence of console errors.

Native input[list] is acceptable as progressive enhancement. Do not declare scripted expanded/selection semantics the native popup does not expose. The explicit tuple chooser must be fully keyboard-operable without relying on programmatically controlling a native datalist popup. Typing or choosing a suggestion must not submit a surrounding form accidentally.

At 320px and ordinary desktop width, long values and help text must not cause horizontal overflow. Preserve forced-colors focus/boundaries and reduced-motion support; do not add animation merely to have something to disable. State clearly that automated checks are not a real assistive-technology or non-Chromium audit.

### SCR-08 — Joined user workflow and byte/identity assertions

Use the next unused browser-spec prefix, expected 42, without overwriting specs 37-41. Drive a built web client with a real disposable collaboration server and a controlled public-safe corpus. Seed through supported APIs/fixtures, not a parallel browser-only software catalog.

Include at least two products with different version/build sets, exact duplicate strings, case/whitespace variants, missing components, a second identity with different access, and a valid value outside the displayed option cap in focused tests.

Prove:

- Existing creation flows can select a complete recorded tuple, inspect its three fields, save deliberately, reload, and display the resulting canonical record.
- A product with no matching loaded record never borrows another product's dependent suggestions.
- Manual novel/incomplete context still saves through the same existing command.
- Existing War Room and Keystone editors can reuse, edit, cancel, and save without corrupting unrelated situation fields or their original CAS behavior.
- Switching through all four presentations preserves the saved record; Keystone does not acquire an accidental create action.
- A failed suggestion refresh preserves a manual draft and produces truthful wording.
- Denied/read-scope replacement removes obsolete values and cannot issue suggestion-driven writes.
- Actual submitted body and returned/reloaded DTO agree according to the pre-existing normalizer; counts of writes prove local tuple selection does not persist by itself.
- Existing collection search/facets/URL/back navigation continue to work. Do not infer a new software-impact mapping from simple context fields.

Route interception may inject a deterministic read failure, but keep it separate from successful server-backed create/edit/reload proof. Browser keyboard entry must assert the final field value before asserting saved content. Do not claim the previously reported zero-delay typing race was fixed unless separately reproduced and actually repaired.

### SCR-09 — Adversarial qualification proportional to this slice

Use focused helper/control/editor tests during implementation. Include meaningful temporary mutations for cross-product fallback, global-absence wording or scope classification, lost stale-callback protection, and tuple field misbinding/unintended overwrite. Each detector must fail for the claimed guarantee and pass after exact restoration. Publish no mutant.

At one stable functional candidate, run the applicable repository gates: web typecheck/lint/full tests/build; E2E typecheck; new browser journey; existing discovery and directly affected strategy/editor journeys; the full ordinary Chromium suite once with retries disabled; boundary/diff/privacy/claims/handbook guards where applicable. Follow AGENTS.md if additional gates are required. Use documented build caches.

Run selected timing-sensitive new regressions five times and the new browser workflow three times, not entire suites repeatedly. Keep previous failures recorded and distinguish name-filtered tests from environment skips. If unchanged timing tests fail, first compare exact failure evidence with #1172/#1176; do not silently batch their fixes, label a failed run passed, or make parallel-run instability disappear by assertion weakening. Report a genuinely unrelated qualification blocker separately.

No server/contracts/storage migration is intended. Preserve applicable prior backend results at their original revisions; do not repeat live PostgreSQL/SDK/storage campaigns or cold-build unchanged Rust/Tauri locally solely to refresh counts. New exact-head hosted checks still run normally.

Obtain one bounded separate adversarial source review after the implementation stabilizes, with findings tied to exact source. Address real defects; do not commission repeated whole-repository audits. Independent review must disclose whether it executed tests and whether it submitted a GitHub approval.

### SCR-10 — Documentation, publication, and stopping

Update the living backlog to mark Goal 07 and its historical supersessions as shipped, Goal 08 as the current unmerged slice, and the remaining successors as proposals. Do not copy #1179's old baseline or revive already-shipped discovery/bulk annotation functionality. Update relevant Help/handbook guidance for loaded-suggestion limits, manual values, tuple application, and normalization differences.

Create `docs/goals/RECORDED_SOFTWARE_CONTEXT_REUSE_RECEIPT.md` with SCR-01..10 mapping, source disposition, normalizer/editor inventory, exact base/head/tree/merge base, functional versus evidence-only revisions, actual commands/results/skips, mutation evidence, baseline-CI disposition, and remotely accessible sanitized review evidence.

This goal authorizes normal development commits and fast-forward publication of the described source, tests, documentation, and sanitized synthetic evidence to the owned public repository branch and one draft PR, subject to actual tool controls. Do not publish raw local logs/recordings, secrets, private recovery archives, employer/customer data, or sensitive endpoints. Push useful reviewed checkpoints so a quota interruption does not strand work locally. Never bypass a transfer approval mechanism.

Do not wait for CI before publishing the candidate needed to trigger it. Record actual job checkouts, including generated merge commits and tree equivalence. Do not make recursive receipt commits solely to record the previous receipt commit's CI result. A queued run is not a pass, but pending external evidence is a finite checkpoint, not new implementation work.

Keep the new PR draft/open/unmerged. Do not mark ready, merge, close #1174/#1179/#1158 or other historical PRs/issues, delete branches, rewrite published history, release, deploy, use production resources, or start another goal.

## Scope exclusions and successor decision

No catalog CRUD, server-side all-investigation suggestion endpoint, field migration, source renaming, taxonomy, tags, bulk metadata editing, storage/provider identity changes, benchmark promotion, or changes to assessment history/portable archives. No new Runtime framework, no parallel authority model, no automated provider calls. This is not authorization to implement or close #731/#861/#899.

After this slice, reassess observed daily-use gaps rather than inventing more catalog services. The next planning candidates are canonical structured annotation semantics or evidence-to-hypothesis reuse, subject to actual current source and owner demand. #1158 and historical test-sync candidates remain useful, separately scoped work; they are not hidden dependencies or automatic merge candidates.

## Final handoff

Return a compact report, with detailed evidence linked rather than pasted repeatedly:

1. Verdict: READY_FOR_REVIEW, READY_FOR_REVIEW_CI_PENDING, PARTIAL_CHECKPOINT, or precise blocker. An incomplete SCR criterion remains partial even when CI is green.
2. Repository, owned branch, draft PR, original/reverified base, merge base, tested and published commit/tree, current main, and local-work status.
3. Exact objective path/hash and #1174 source disposition; no historical branch mutation.
4. SCR-01..10 ledger with precise source/test/artifact references and honest unperformed items.
5. Exact changed-file manifest; editor/normalizer inventory; dependency direction preserved; new network/schema/storage surface, expected none.
6. Commands, environment, counts, original failures, skips, bounded repetitions, mutation outcomes and independent-review boundary.
7. Baseline rerun disposition and new hosted run/attempt/head/actual checkout identities. Distinguish workflow conclusions from individual-job or historical passes.
8. Synthetic demonstration and limits: loaded-only suggestions, not a canonical catalog, no new software identity, existing normalization, no privacy grants, no new Keystone creation.

Then stop for independent review. Do not turn a pending-CI report into another automated development loop.
