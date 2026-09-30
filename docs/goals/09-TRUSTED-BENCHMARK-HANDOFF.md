# ContextDesk Goal 09 — Trusted Benchmark Promotion and Offline Handoff

/goal Turn an explicitly accepted Experiment Lab decision into a reviewable, versioned human benchmark and a clearly owner-only handoff that the existing offline triage bench can consume. Selectively adapt historical #1175, protect selection and uncertain-result recovery, qualify an actual saved-file-to-CLI journey, and publish one draft PR. Do not merge.

## Outcome and product boundaries

The operator opens an existing comparison, reviews an accepted decision, inspects its initially selected evidence, deliberately promotes a benchmark, and can reopen its recorded version. A separate authorized action downloads an identity-preserving, owner-only benchmark envelope. The existing headless bench imports that file and produces its existing alignment report for matching task/snapshot identities.

A gold reference is a human-selected benchmark, not infallible ground truth. Its anchor/role alignment is not a measure of answer correctness, verified root cause, provider readiness, or consensus quality. Goal 07 human assessments, legacy corroboration, experiment decisions, benchmark versions, and bench adjudication remain distinct. No assessment is automatically converted to a decision or gold reference. This goal does not measure whether human review improves incident outcomes.

The existing alias-only share-safe Experiment Lab export and the new owner-only identity-preserving handoff are different products. Do not recover private identities from share-safe aliases or pretend those aliases can join an original bench task. This task deliberately permits a small additive owner-only export envelope and a narrowly authorized server export operation; it does not permit a new evaluation domain, scoring algorithm, durable gold schema, provider integration, or portable-archive format.

## Pinned observations and work ownership

- Repository: `chriscase/ContextDesk`.
- Observed main: `5650f0666a42e0adfaecedd1b4d9286002dde3ba`.
- Observed tree: `16fea5e5f43844daba7da7d09ad6ed651cd6eab8`.
- Goal 08 merged through #1187. Goals 01 and 04–08 are not unfinished prerequisites.
- New owned branch: `integrate/trusted-benchmark-handoff-v1`.
- Exact owner artifact: `docs/goals/09-TRUSTED-BENCHMARK-HANDOFF.md`.
- Historical source #1175: `c6b7a4fae7fea4ecb441d6396bf61812af602368`, branch `grok/contextdesk-accepted-evidence-prefill-v1`.
- Post-merge main `collab` run `36590968606` and `collab-qualify` run `36590968667` succeeded, attempt 1. Root `CI` run `36590968440` was still in progress when the goal was prepared. Reverify rather than treating the observation as a final result.

Inspect registered worktrees, current branch ownership, main, and the relevant open PRs once. Preserve staged, unstaged, untracked, and unpushed work. Do not reuse the completed Goal 08 branch or overwrite another agent's work. If main advanced compatibly, inspect that delta and record the actual base separately without changing this supplied objective. An overlapping active implementation requires coordination, not a competing branch.

Commit these exact supplied bytes before production changes. Record the computed SHA-256 in the handoff/receipt, not inside this file. Missing input bytes are `BLOCKED_GOAL_INPUT`; do not reconstruct the objective from the startup summary. Do not add provenance commentary to the owner artifact.

Pending baseline CI permits isolated development and draft publication. It does not establish a green baseline or authorize promotion. Check baseline status at startup and final handoff, not repeatedly while waiting. A new failure must be diagnosed and reported separately; this goal does not authorize workflow changes, indiscriminate reruns, or unrelated repairs.

## Read only the relevant implementation first

Read `AGENTS.md`, relevant nested instructions, the workflow/claims/handbook requirements, and:

- `docs/benchmarks/GOLD_BACKTEST_LOOP_V1.md`;
- `docs/benchmarks/SHARE_SAFE_DECISION_EXPORT_V1.md`;
- `collab/web/src/ExperimentLab.tsx`, its tests, and its actual Cases/App mount;
- `collab/contracts/src/gold.ts`, relevant experiment/trace parsers, and package exports;
- `collab/server/src/modules/experiments/{routes,service,store,project}.ts` and focused tests;
- `crates/cd-triage-bench/src/gold.rs`, the existing `import-gold` CLI/store and report tests;
- the current export download/lifecycle helpers and applicable synthetic server/bench harnesses;
- #1175's exact two-file patch, its actual ancestry, and reviews;
- the living delivery backlog and current E2E filename inventory.

#1175 supplies one-time accepted-evidence seeding, late-source behavior, reset tests, and explicit promotion. It does not supply complete current-main acceptance. Reuse the useful delta, not old copies of large files. Keep its branch and PR unchanged. Ignore obsolete prerequisite ordering in old PR descriptions unless current code demonstrates an actual dependency.

## Acceptance contract

### TBH-01 — One existing workflow, separate human authorities

Own the existing Experiment Lab benchmark surface in War Room's current comparison/decision workflow. Preserve existing comparison browsing, decision proposal/acceptance, helpfulness, evidence navigation, and source provenance. Do not implement a new assessment workflow or add the feature to all four presentations merely for symmetry.

Display the selected experiment, accepted decision/revision, current gold version or absence, and the distinction between a human benchmark and correctness. Proposed-only or absent decisions cannot be promoted. Preserve older benchmark versions and their recorded attribution; latest and explicitly recovered historical versions must not be confused.

Do not reimplement alignment or scoring in React. Use existing authoritative projections and the headless bench for evaluation. No compatibility/readiness/routing state may be written by this workflow.

### TBH-02 — Evidence selection is helpful, bounded, and operator-owned

Seed only unique references from the accepted decision that are eligible in the current experiment or its correctly bound, authorized loaded snapshot. Do not fabricate choices from stale IDs, path-like strings, another experiment's snapshot, labels, or model claims. Preserve the distinction between a recorded reference, available bytes, and verified exposure.

Seed late-arriving accepted references at most once per editing epoch; never reselect a manually removed item, overwrite an explicit reset, steal focus, or change assigned roles because a resource object was recreated or reordered. A changed accepted decision/revision starts a visibly new editing context. Mere refresh does not.

Before any POST, revalidate selected references and expected relationships against the latest admissible source. If an earlier selection is no longer eligible, name the condition without leaking hidden content and require operator correction; do not silently submit a smaller benchmark. Keep manual choice and clearing possible. Empty selection produces a local error and zero POSTs.

Expected roles and helpfulness dimensions remain optional explicit operator choices. Never infer them from candidate agreement. Respect existing size limits; do not create an unbounded document chooser or whole-collection crawler.

### TBH-03 — Explicit promotion, frozen intent, and bound success

The promotion action presents the accepted decision/revision, selected anchors, optional roles/dimensions, and expected gold version. Its explicit submit is the write confirmation; do not add redundant confirmation rituals.

Freeze the semantic request at submission: case/experiment, accepted decision/revision, anchors, roles, and dimensions. Preserve exact user selections through failure. A retained handler or duplicate click cannot issue another POST while that operation is pending. Do not reread mutable form fields during replay.

Use the existing gold-promotion fingerprint/idempotence mechanism. Do not introduce a second token store, new exactly-once API, or custom notes editor that falls outside the existing fingerprint semantics. A later explicit changed benchmark is a new versioned intent, not a silent alteration of an earlier version.

Parse success with the authoritative gold parser and verify response identity and semantic request binding before clearing the draft or offering a file. Reject mismatched case/experiment/package/task/snapshot, accepted decision/revision, anchors, roles, or dimensions. A valid historical replay may retain its original promoter/time and version: do not require the responder to fabricate the current actor or latest version.

A validated success is recorded success even if the following list refresh fails. Show refresh failure separately. Malformed or lost acknowledgment is not proof of rollback. Retain source-level notes explaining which existing HTTP failures are known rejection and which leave outcome unconfirmed.

### TBH-04 — Repeated uncertainty and conflict cannot reuse old permission

After a potentially committed failure, preserve frozen intent and require an explicit authoritative same-scope history read initiated after that particular outcome before enabling another deliberate replay. Resource-object identity, a pre-failure read, stale retained rows, and another attempt's completion are not proof.

Associate review permission with the current attempt and scope. Starting a new POST and receiving a new unknown/conflict invalidate old permission. A history read begun during a pending retry must not later authorize a subsequent retry after that POST becomes uncertain. Test this ordering and a captured earlier retry handler with controlled promises.

If a read finds the exact promoted intent, present the recovered recorded version and allow finishing without another write. If no match exists, do not infer rollback; a deliberately repeated identical semantic request is safe only under the existing server idempotence contract. If current gold version changed, require explicit review before updating the CAS precondition. The concurrency field may advance; the frozen semantic intent must not silently change.

Preserve existing server replay-before-version-conflict behavior, atomicity and append-only records. No duplicate gold version or promotion timeline event may arise from identical replay. Existing explicit idempotent-attempt audit events are allowed and must be distinguished from another promotion. Do not promise globally exactly-once execution.

### TBH-05 — Real mounted lifecycle and download protection

Bind drafts, in-flight responses, prepared exports, retry/read qualification, and captured handlers to the actual identity/authority/case/experiment/decision context. Pass only necessary current host scope data; do not retrofit all of Experiment Lab into a new framework.

Actual keyed replacement, read/private/export/lead authority loss, record removal, and A→B→A must conceal old content and prevent obsolete local action, command/request, result publication, and download before passive cleanup. Use a replacement-layout probe and independent passive-cleanup witness through the actual mount. Direct-hook tests alone are insufficient. Do not invoke side effects from render as the proof.

Same-scope refresh/reordering must preserve a manual draft. Prepared download data belongs to an exact authorized version, never whichever version happens to be current when an old callback runs. Release Blob URLs and timers on replacement, failure, expiry, and unmount. Do not claim client revocation can recall bytes already downloaded or prevent a server write already committed before scope loss.

### TBH-06 — Explicit owner-only benchmark export, not an alias reversal

Provide a small server-authorized operation that exports an exact stored gold ID/version from the named case and experiment. Reuse an equivalent existing operation if inspection finds one; otherwise add one narrowly scoped operation in the existing experiments module. Authorization must apply current session, case membership, private-read and export policy as appropriate to owner-only material, not a client `canLead` flag alone. Use existing audit machinery and no new durable table.

Return a strict versioned envelope with the proposed shape:

```ts
interface GoldReferenceExportV1 {
  schemaId: "cd-collab.gold_reference_export.v1";
  privacyClass: "owner_only";
  gold: GoldReferenceV1;
}
```

The nested object is the existing gold schema, validated by `parseGoldReference`. Use shared contract exports and a browser-safe entry point for that same parser. Reject unknown fields and invalid nested/cross-field data. Request only the exact stored record; do not trust a client-supplied gold body to export itself.

Keep the original gold/task/snapshot/evidence identities and recorded attribution intact. The browser must validate the envelope and its requested version/context before saving. Label the action, file and in-band envelope as owner-only; warn that it contains internal identifiers/attribution and is not suitable for public sharing by default. Use a safe bounded filename, correct JSON content type and no-store response handling.

The existing alias-only share-safe lab export remains unchanged in meaning and continues to pass its privacy tests. It must not leak raw IDs to make this new handoff work. Never label the owner-only envelope share-safe, never guess the private IDs behind `task-1`/`snapshot-1`, and never forge known exposure from a fingerprint string. This file is not an exact investigation archive and does not transfer Goal 07 assessment history.

For a given stored version, repeated downloads preserve the canonical envelope bytes; put export-action wall time in audit rather than modifying the frozen gold. A denied, malformed, stale, wrong-version or failed export creates no downloadable file. A successful authorized export may append an export audit event, but cannot mutate the benchmark.

### TBH-07 — Backward-compatible headless consumption

Extend only the existing bench import boundary as needed to accept the owner-only envelope and extract its unchanged nested `GoldReferenceV1`. Preserve the existing bare-gold input path and stored gold schema. Use strict Rust validation and shared valid/invalid JSON fixtures to qualify wire parity; no runtime Node/collab/server dependency may be introduced into the bench.

Consume the actual saved file, not a reconstructed equivalent fixture. Record envelope privacy in the import result or existing provenance/handling output as appropriate; never imply that the absence of privacy in a legacy bare-gold file makes it share-safe. Repeated import retains the existing explicit dedupe/refusal behavior, never silently overwriting records.

Produce the existing offline report using supported CLI commands. Matching applies only to the recorded task/snapshot identities under the current contract. Unrelated task/snapshot controls must not acquire an applicable benchmark. Preserve unknown cost, timing, exposure and unscored states. Reports must remain evidence-alignment observations, not provider rankings or truth verdicts.

Derive CLI syntax from the current help/tests; do not invent flags. Seed a coherent public-safe fixture through supported tooling so the comparison and bench share real recorded identities. Do not edit the downloaded IDs or relabel an unrelated task just to make alignment pass. Repeated report generation from unchanged stored inputs must retain existing deterministic normalized output. Do not change scoring weights, fairness rules, winner selection or report ordering for this goal.

### TBH-08 — Joined browser/server/file/CLI proof

Use the next unused E2E prefix, expected `43-*`; preserve specs 37–42. A synthetic journey must drive the actual UI to inspect an accepted decision, remove a preselected anchor, deliberately promote, read the recorded version, and save the real owner-only JSON file. Prove zero promotion POSTs during seeding, snapshot arrival, selection or download-only actions.

Continue that same artifact through the existing compiled/offline bench importer and report entry point. Keep the file hash and original identities in sanitized evidence. A fixtures-only alias document or direct server-store call is not a substitute for the saved-file journey. Keep normal tests provider-free; qualification must not read keychains or call paid/live models.

Include one real committed-promotion acknowledgment-loss case: a disposable fault layer withholds a successful server response before the production browser gateway/controller observes it. Assert actual unconfirmed caller state, explicit fresh read, recovery/replay, and no duplicate version or promotion event. Restart a disposable SQLite server on its same test database and verify the recorded version/export remains available. Reuse existing harnesses; an unused synthetic status constant is not fault proof.

Use local temporary data only. Distinguish real application/server/persistence/CLI execution from injected transport faults, synthetic identities and report fixtures. Actual provider quality and production-service durability remain unclaimed. A harness configuration skip is not a pass; run the joined configuration separately before marking this criterion proven.

### TBH-09 — Adversarial tests and usable interface

Qualify keyboard selection/promotion/download, meaningful headings/labels/statuses, visible focus, 320px reflow, forced colors and reduced motion. Keep the ordinary screen compact, with exact machine identities available in details rather than a wall of IDs. Native controls are preferable to a custom selection widget. No real assistive-technology or non-Chromium certification is implied.

Cover missing/proposed decisions, delayed snapshot evidence, manual deselection/reset, removed selection, foreign snapshot, duplicate rapid submission, wrong success body, fresh/failed/stale reads, repeated unknown/conflict, retained callbacks, valid replay, denied export and malformed nested envelope. Inspect cross-language strictness rather than trusting TypeScript typing.

Run four targeted temporary negative controls, then restore exact bytes: (1) remove eligible-reference intersection; (2) retain earlier retry permission across a new unknown outcome; (3) downgrade the actual load-bearing pre-passive revocation; (4) bypass owner-only envelope identity/privacy validation. Each must fail a relevant behavioral assertion, not setup/import/syntax. Never publish mutants or simulated secrets. If another existing defense makes a proposed mutation harmless, explain and mutate the actual protection instead of weakening the design to obtain a failure.

### TBH-10 — Qualification, documentation and review handoff

During implementation run focused suites, not repeated whole-repository campaigns. After a stable candidate run one applicable complete pass: collaboration typecheck/lint/contracts/server/web tests/build, E2E typecheck, ordinary Chromium with retries disabled, the new joined configuration, targeted bench tests/build/import/report, and applicable dependency/claims/handbook/privacy/diff/Gitleaks gates. Use the documented shared compiler cache. Unchanged desktop/Tauri/core need equivalent hosted qualification, not repeated local cold builds.

Run the new browser journey three independent times and two selected timing tests five times, without retry masking. Record meaningful failures and reruns, environment skips and name-filter exclusions separately. Use existing backend atomicity tests; if transactional production bytes changed, rerun the affected real backend proof rather than claiming unchanged evidence. Do not introduce migrations or duplicate transaction layers without a demonstrated in-scope need.

Obtain one separate adversarial source review of the functional candidate, and inspect real UI screenshots for layout issues. Identify whether the reviewer ran tests; a source review is not a GitHub approval. Correct demonstrated in-scope findings and rerun affected gates. Do not restart every completed campaign after a documentation-only change.

Update appropriate Help, benchmark-loop/handling docs, the relevant Proven Methods chapter/status, and the living backlog. Mark Goal 08 shipped through #1187 and this goal unmerged; remove stale active-slice headings without rewriting historical receipts. Explain internal versus alias-only exports, manual promotion, and headless ownership. Do not broadly close old backlog issues.

Create `docs/goals/TRUSTED_BENCHMARK_HANDOFF_RECEIPT.md` with TBH-01..10, exact changed-file manifest, preserved/changed historical source, test commands/results, actual revision/tree/checkouts, file-transfer proof and nonclaims. Preserve the full goal hash. One final evidence commit is acceptable; do not create recursive commits solely to record CI of the previous receipt.

## Allowed implementation ownership and non-goals

Expected ownership: the existing Experiment Lab benchmark UI and small shared lifecycle/download support; a narrowly necessary Cases/App scope prop; browser-safe contract exports plus the additive owner-only envelope; the existing experiments export route/service and their tests; the bench's gold import adapter/contract fixtures; one joined harness/browser spec and relevant documentation.

Any necessary narrow production correction in those paths is allowed when backed by a failing acceptance test. No whole-Experiment-Lab rewrite, automatic decision acceptance, new evaluation database, scoring redesign, model judge, benchmark-optimized routing, provider calls, catalog work, storage migration, portable assessment schema, fifth strategy, general reconciliation framework, dependency-version sweep or CI workflow changes. Leave #1158, #1172, #1176, #1179 and other historical PRs alone. #1175 is source material and stays open until separately accepted supersession after merge.

## Publication authorization, cost control and stopping

This task authorizes normal development commits and normal fast-forward publication of this described source/tests and sanitized synthetic evidence to the owned public branch and one draft PR, subject to actual tool approvals. Push useful checked checkpoints so an interruption cannot strand local work. Never force-push, overwrite other work, publish private recovery archives, credentials, employer/customer data, raw provider traffic or private local recordings. Do not bypass an approval control; request only the specific missing transfer permission if needed.

Keep raw logs in artifacts and return concise summaries/failure excerpts, not repeated full logs. Do not repeatedly rediscover unchanged repository state or run whole-repository subagent audits. Prefer a replayable focused test over tens of thousands of narrative tokens. Integration status checks are finite reads, not development goals.

Stop with `READY_FOR_REVIEW`, `READY_FOR_REVIEW_CI_PENDING`, or an accurately named partial/blocker. Hosted checks on a final receipt head must be read on their own identity; a generated merge can be content-equivalent without being the same commit. Do not poll indefinitely, mark ready, merge, close historical PRs/issues, delete branches, release, deploy, or start a successor.

Return: base/merge base/current main; functional tested head/tree and published head/tree; branch/draft PR; computed owner-goal hash; TBH ledger; source/endpoint/parser ownership; exact manifest; commands, counts, skips/failures/mutations; saved-file hash and actual bench invocation/report; sanitized evidence/reviewer location; actual hosted checkout identities and baseline status; synthetic demo; remaining privacy/fairness/portability limits. Then stop for independent oversight.
