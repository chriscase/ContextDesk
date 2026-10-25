# ContextDesk Goal 05 — Trustworthy S3 Evidence Upload Recovery

/goal Deliver a complete, reviewable S3 evidence-upload recovery workflow on current ContextDesk main. Reuse the useful historical work, repair its missing guarantees, and publish one coherent draft PR. Do not merge.

## Outcome

An investigator using Investigation First or Beacon can upload evidence, understand an uncertain result, inspect an authoritative refreshed inventory, and explicitly retry the original upload intent without changing its content or disclosure. The server must not confuse uncertain object promotion with ordinary unavailability, lose potentially committed bytes through unsafe cleanup, or replay an uncertain canonical copy invisibly. The application must not claim that object presence proves a committed investigation record.

This is an implementation goal, not a planning-only exercise and not a request to merge old branches. Deliver server behavior, shared client behavior, two presentation integrations, adversarial tests, a joined application journey, and operator documentation together.

## 1. Pinned starting point

Repository: `chriscase/ContextDesk`.

Expected main: `c5de75d1e40a3de8ddfceda2ce3d216a5e19644d`.

Expected main tree: `fc9d4a9cd46172cb6ed36ad3abcfa080e0d50d59`.

That baseline includes Trusted Investigation Discovery through #1181, the desktop test synchronization repair through #1182, and Activity Center scope safety through #1183. Its post-merge workflow conclusions were verified successful, attempt 1:

| Workflow | Run |
| --- | --- |
| CI | `36180382683` |
| collab | `36180382859` |
| collab-qualify | `36180382576` |

Reverify main, tree, working-tree cleanliness, open integration ownership, and these conclusions once before implementation. Do not keep polling an already-completed baseline. If main has moved, inspect the exact delta: a compatible forward descendant may become the recorded base; a conflicting active integration requires a checkpoint rather than overwriting another agent's work. Do not change this source artifact to record the new base; use the receipt.

Owned integration branch: `integrate/s3-evidence-reconciliation-v2`. Use an isolated worktree. If this branch already exists, establish its ownership and original base before resuming; do not reset it or open a competing branch without resolving ownership.

### Freeze this file, not a reconstruction

Copy this entire supplied Markdown artifact unchanged into `docs/goals/05-S3-EVIDENCE-RECONCILIATION.md`. Verify its SHA-256 against the supplied adjacent checksum manifest. Commit the exact file before production changes. Put interpretations, observed revisions, source mappings, and evidence in a separate receipt. Do not prepend commentary, remove this `/goal` line, shorten the contract, or silently relax acceptance criteria.

If the file bytes cannot be obtained, report `BLOCKED_GOAL_INPUT` before implementation. Do not spend a run trying to regenerate an unavailable attachment from memory. No retroactive freeze claims or history rewriting.

## 2. Historical work to reuse selectively

These are pinned source candidates, not approvals and not promises that every line remains correct:

| PR | Exact historical head | Relevant contribution |
| --- | --- | --- |
| #1159 | `db5f489bf4ddd8e96464c22e54912ee1fa34fa0d` | S3 error classification; JSON and multipart route parity |
| #1166 | `7bb4092d19ce4ee107150265eacc3b4c64d62345` | Applied-copy/response-loss provider tests and operator guidance |
| #1168 | `2e9d6856a8a5fb79f8cebcfb92d66ecc2e01af04` | Investigation First and Beacon reconciliation |
| #1170 | `2bfa811204440006710bf6d073206d5efe39f3be` | Browser upload/reconciliation qualification |
| #1173 | `53c614e4abcddccb56b2dfa24d765c50cc1d6f1a` | Evidence-stream scratch-cleanup synchronization |

Reverify the PR heads. A changed source candidate requires inspecting its extra delta; it does not invalidate these immutable reference commits. Record reused, adapted, rejected, and already-present behavior for each candidate. Apply child-branch deltas relative to their actual parents; do not repeatedly import #1159 via each child.

Do not wholesale replace current presentation files with historical versions. Preserve the collection controls, canonical navigation, privacy behavior, and accessibility work already on main. Leave historical PRs and branches unchanged and open. Their eventual supersession is an owner decision after the replacement lands.

#1173 is allowed only as its narrow synchronization correction in the overlapping HTTP test: wait for the real empty-scratch invariant, preserving transfer enforcement and its existing bound. Other old test fixes are not automatically part of this goal.

## 3. Read-first map and ownership

Read `AGENTS.md`, applicable nested contributor instructions, `docs/AGENT_WORKFLOW.md`, the evidence-store contract, transaction/recovery ownership, and current dependency-boundary tests. Then inspect:

- `collab/server/src/evidence/s3-store.ts` and its tests;
- `collab/server/src/modules/cases/routes.ts`, upload services, and `evidence-stream.http.test.ts`;
- actual S3 client construction, installed SDK/retry middleware, and the repository lockfile;
- `collab/web/src/investigations/runtime/controllers/use-upload-evidence.ts`, its tests, `file-base64.ts`, gateway errors, resource refresh controllers, and Runtime provider wiring;
- `InvestigationFirstStrategy.tsx`, `BeaconStrategy.tsx`, their tests, and any shared evidence helpers;
- existing War Room/CaseBoard and Keystone upload behavior, for compatibility and a truthful entry-point inventory rather than an unsolicited redesign;
- existing evidence-freeze, discovery, and Activity Center browser specifications and the E2E filename inventory;
- `docs/help/war-room/war-room-s3-evidence-store.md`, relevant Help, `PROVEN_METHODS.md`, its investigation-loop chapter, and the delivery backlog.

Server/store code owns authorization, content validation, database commit, journaling, leases, and recovery. Runtime owns transport, current scope, mutation lifecycle, and authoritative read completion. Presentations own visible interaction and form capture; they must not create an alternative transport or authorization system.

Prefer a small shared reconciliation primitive/adapter for the two consumers, not two independently evolving state machines. An additive Runtime read-completion identity or narrowly bounded upload helper is permitted when necessary to establish the guarantees below. Preserve existing consumer compatibility. Do not build a generic retry framework.

## 4. Required acceptance criteria

### SER-01 — Correct integration and contract preservation

Use the recorded current-main base and one owned integration branch. Preserve Goal 1, its frozen files, the integrated Activity Center implementation, and desktop behavior. Demonstrate that old presentation code has not displaced shared discovery controls or canonical filter propagation. Keep existing APIs and valid success/refusal envelopes compatible.

The receipt must identify each historical source contribution and distinguish ancestry from forward-porting. Do not imply a cherry-picked/adapted historical SHA itself will be an ancestor of main.

### SER-02 — Narrow, sanitized server outcome classification

Preserve the distinction between `503 {"error":"commit_outcome_unknown"}` and `503 {"error":"storage_unavailable"}` for JSON and multipart uploads. Preserve any existing non-S3 commit-outcome-unknown mapping as well.

Write a classification table grounded in the pinned SDK and actual execution stages. Cover confirmed pre-dispatch configuration/credential/validation failures, explicit provider rejections, unclassified/statusless errors, transport loss around canonical CopyObject, incomplete/malformed successful-status responses, probe failures, and verified canonical content.

A raw message containing a socket-error word, `$metadata.attempts > 0`, or HTTP 200 alone must not substitute for understanding the operation and failure stage. A fully parsed service-error body is not the same event as a truncated response. When a copy may have been dispatched and verification cannot settle it, preserve uncertainty. Do not convert uncertainty into proven absence merely to enable cleanup.

Keep public classification separate from conservative internal ownership/journal retention. An ordinary `storage_unavailable` response is not a promise that no bytes exist. Verified canonical bytes may allow the server's normal transaction to proceed; they do not alone authorize a client success message or prove a metadata transaction committed.

Never expose credentials, signed URLs, raw SDK messages, object keys, private endpoints, or unsanitized response bodies in HTTP/UI errors or qualification artifacts. Keep failures outside canonical commit/promotion from spuriously acquiring the unknown-commit marker.

### SER-03 — Retry policy is proven below the application mock

Establish an explicit bounded canonical-copy policy: an unresolved, potentially applied canonical promotion must not be blindly replayed by application code or SDK retry middleware. Reads may retain their existing bounded retry policy. Prefer a scoped write policy rather than reducing reliability of every S3 read.

Inspect the installed SDK's effective retry configuration and environment overrides. Do not claim one wire attempt because a fake client's `send()` was invoked once.

Add a test using the actual installed S3 client and serialization/retry middleware with synthetic credentials and a hermetic request handler or loopback protocol fixture. Count canonical CopyObject attempts below middleware. Cover a lost/truncated response and a retryable service failure under the chosen policy. Assert termination and bounded verification; do not use a sleep as proof that no retry will occur.

For ordinary provider doubles, label results as provider-boundary proof. For SDK request-handler fixtures, label them as actual SDK/transport-boundary proof, not live AWS qualification. Preserve the distinction in the receipt.

### SER-04 — Conservative transaction and restart recovery

When a canonical copy may have applied but its result is unresolved, retain the bytes and pending journal required for authoritative recovery. Do not automatically delete canonical content, erase the pending record, compensate metadata blindly, or claim rollback completed.

Reuse existing transaction, write-lease, content-hash, and startup-recovery mechanisms. Test applied-copy plus lost response, unsettled verification, cleanup/rollback attempts, and later authoritative recovery. Referenced valid content must remain; content may be reclaimed only when existing authoritative reference and coordination rules establish it is unreferenced.

Include adoption/concurrency protection: another committed record referencing the same content must not lose its bytes to cleanup from the uncertain writer. When references/provider health are unavailable, recovery must fail closed under the existing readiness policy. Do not invent a new recovery scheduler, retention policy, or migration mechanism.

Demonstrate durable restart/reopen, not only a fake object map surviving within one function. Keep test evidence explicit about which persistence/provider combinations executed.

### SER-05 — Immutable first-attempt upload intent

For Investigation First and Beacon, capture the original validated upload intent before the first asynchronous submission. Preserve the same file bytes and canonical metadata: filename, media type, kind, summary, privacy class, and any supplied source ID/client time or other request fields.

Retain one immutable Blob/File reference where appropriate; do not duplicate a large upload into base64 just to freeze its bytes. Use existing canonical preparation rather than creating competing normalization rules. Snapshot metadata separately from mutable controls or caller-owned objects.

After an unknown result, an explicit retry must consume that frozen intent, not reread live form elements or accept replacement values. Lock relevant controls and show what is being retried. Handler-level tests must remain safe when a test programmatically edits disabled controls or invokes submission directly. This is a state-correctness guarantee, not a claim of resistance to arbitrary same-origin script compromise.

Compare decoded multipart fields and file bytes, not random multipart boundaries. Do not fabricate a public Idempotency-Key that the endpoint does not support. Do not claim that content-addressed bytes make artifact/summary metadata writes exactly-once.

### SER-06 — Reconciliation readiness is causal and scope-bound

Only the exact unknown-outcome marker enters this special recovery flow; ordinary unavailability remains an ordinary explicit-retry path.

An unknown result must block another upload until an authoritative evidence read for that same scope has successfully completed as a consequence of, or after, that unknown result. A previously cached ready resource, a newly allocated resource object, a read started before the failed write, or a late old-scope read must not unlock retry.

The existing Runtime already triggers evidence and collection refresh on the marker. Reuse that authority. If a read-completion generation/token is needed, add it at the appropriate Runtime boundary with compatibility tests; do not infer chronology from object inequality.

Handle a refresh that completes immediately, is slow, fails while retaining stale rows, succeeds empty, succeeds with recorded evidence, or is superseded by a newer failure. A repeated unknown retry establishes a new reconciliation barrier. A stale previous barrier must not enable it.

Once a qualifying read succeeds, show the refreshed inventory and an explicit instruction to inspect it. That read proves what the authorized inventory reports; it does not prove storage rollback or global absence. The user may then retry the frozen intent or finish without another write after checking recorded evidence.

### SER-07 — One explicit attempt, safe local completion, truthful interaction

Each deliberate submission/retry can start at most one upload request. Guard double clicks, Enter/requestSubmit paths, rapid repeated calls before rerender, and effect reruns. Inventory refresh, reconnect, page focus, and a rerender must never schedule a second POST.

Keep the same-scope draft through uncertainty and refresh failure. Clear it on validated success or an explicit local finish/discard action under the documented reconciliation rules. Discarding client state is not a server rollback; do not issue a compensating DELETE. A form reset must not silently turn an unresolved retry into an editable new attempt.

Make success, ordinary failure, unconfirmed result, inventory loading, inventory refresh failure, and ready-for-human-review distinct. Do not infer success by matching filename alone, disable the only inventory-refresh route, or claim recovery while retained rows are stale.

Qualification must explain existing duplicate-record behavior. If server metadata is not idempotent, make no exactly-once assertion and do not treat retry as harmless without inspection. No new idempotency database schema is authorized by this goal.

### SER-08 — Scope, privacy, and lifecycle safety

Fence the frozen intent, reconciliation state, callbacks, and in-flight results by identity, authority, case, read/upload access, private-evidence access, and relevant lifecycle state. Conceal stale file metadata, summary, failure text, and actions before passive effects can expose them under a replacement scope.

Old callbacks must not upload or refresh a new case using old input. Include A-to-B-to-A transitions so matching a reused string scope alone cannot revive an obsolete intent. Recheck at action and result boundaries. A revoked owner-only draft must never become share-safe automatically.

Initially denied consumers must issue zero case/evidence reads or upload writes through this flow. A no-upload/read-only consumer may read permitted inventory but cannot retry. Preserve archive/legal-hold behavior and authoritative server refusals.

Navigation, identity change, unmount, and scope loss must release client-held Blob references. No draft bytes in URLs, logs, localStorage, screenshots from real data, or cross-user caches. This goal does not introduce durable recovery intent across browser reloads; document that nonclaim.

### SER-09 — Cross-layer qualification, including one joined fault journey

Required layers:

1. Store/provider tests: classification, pending journals, no unsafe delete, adoption, and recovery.
2. Real installed SDK tests: serialization, failure-stage handling, and actual retry-policy enforcement below mocked `send()`.
3. Real application HTTP tests: JSON/multipart parity, authorization ordering, sanitized errors, and authoritative success/failed transaction behavior.
4. Runtime and consumer tests: frozen payload, causal refresh barriers, same-scope retention, privacy/scope transitions, captured callbacks, and duplicate-submit suppression.
5. Public browser journeys in both target presentations, with injected HTTP failures clearly labeled.
6. At least one joined disposable application journey through the built web client, real Runtime, real server route/service/store wiring, and an S3-compatible protocol fixture or local provider, with failure introduced below the application HTTP response. Do not fulfill the upload's 503 from Playwright and call that server/provider integration.

For the joined journey, a test-only executable may call the real application factory with a private injected provider, or use a disposable loopback provider/proxy. Do not add production fault endpoints or general-purpose fault configuration. Observe canonical-copy attempts, unconfirmed response, pending state, blocked automatic replay, recovery/read completion, explicit same-intent retry or recorded-evidence resolution, and final authorized inventory/download bytes.

No paid AWS account is required. Run existing disposable Garage/provider compatibility qualification where available. Missing environmental qualification must be recorded as missing, not replaced with invented success. A joined local fixture is not live AWS response-loss proof.

### SER-10 — Browser and accessibility regressions stay closed

Use the next unused E2E prefix, expected `39-`, after verifying the inventory. Do not overwrite or renumber Goal 1 spec 37 or Activity Center spec 38.

In both target presentations prove: first upload; delayed and failed inventory refresh; blocked automatic/direct resubmission; original draft retained; explicit inventory refresh; review-ready state; attempted edits cannot change retry; one explicit retry; repeated unknown result; ordinary 503; confirmed success; and scope/privacy teardown.

Use controlled disposable fixtures. Restore user preferences separately from administrator strategy policy, and preserve the original failure if cleanup fails. Avoid arbitrary sleeps, network-idle-only correctness assertions, empty-array checks that pass before work settles, and fixture counts dependent on old test data.

Qualify keyboard reachability, focus after failure/retry, semantic status/alert messages, disabled-control explanation, 320px reflow, forced-colors focus, and reduced-motion behavior of the affected controls. Do not add motion solely to manufacture a nonzero baseline for an accessibility test.

Preserve existing War Room/Keystone upload and evidence-freeze behavior, all four discovery presentations, canonical URLs without transport cursors, and Activity Center scope safety. New recovery UX is scoped to Investigation First and Beacon; do not claim all entry points were redesigned.

### SER-11 — Mutation-sensitive guarantees and applicable gates

Temporarily invert each of these guarantees and show that an appropriate named test fails for the intended reason, then restore and pass it:

- unknown outcome classified as ordinary unavailability;
- automatic canonical-copy replay allowed below SDK middleware;
- uncertain canonical content/journal deleted before authoritative recovery;
- retry rereads changed live form data;
- pre-failure/stale inventory read unlocks retry;
- obsolete-scope callback submits or publishes;
- refresh or double submission emits an extra upload.

Use disposable fixtures; publish no mutant. Record actual commands, environment, tested revision, exit status, test counts, and relevant sanitized output.

Run focused suites throughout development. At the final functional candidate run collaboration typecheck, lint, contract/server/web tests, production builds, E2E typecheck, the new browser specification, relevant regression specifications, full applicable E2E, dependency-boundary, fixture/privacy, diff, and documentation/claims checks. Use repository-supported serialized execution when appropriate. Do not change workflows or dependencies to reduce the gates.

Run timing-sensitive focused tests 20 consecutive times and the new Chromium specification five consecutive times with one worker and retries disabled. Do not repeatedly run the whole suite after every prose edit. Equivalent hosted required root/Tauri checks may satisfy the repository gates for untouched Rust/desktop code; distinguish them from locally executed checks.

Run the existing Windows evidence-stream qualification for #1173 where available. Preserve its transport guard and eventual empty-scratch assertion. Keep unrelated full-suite failures visible and assess them against the baseline; do not turn this goal into a general flake-cleanup campaign.

### SER-12 — Honest documentation, evidence, and finite handoff

Update the operator Help and relevant handbook/status rows for uncertain upload outcomes, exact retry intent, privacy revocation, inventory verification, recovery, and scope limitations. Correct the delivery backlog to separate shipped work from this unmerged goal, reconcile the broad Activity Center heading, and leave unrelated candidates deferred. Do not reopen accepted Goal 1 or Activity Center implementation work.

Commit `docs/goals/S3_EVIDENCE_RECONCILIATION_RECEIPT.md` containing SER-01 through SER-12 evidence and historical-source disposition. Keep unexecuted items partial/missing. Sanitized test evidence and independent-review findings must be remotely accessible in the PR, committed files, or named workflow artifacts—not only a session-local scratch path.

Preserve local failures, environmental skips, fixture/provider limitations, and any metadata-idempotency nonclaim. An independent review must identify its exact revision and whether it actually executed tests. A fresh same-model review may be useful; do not describe it as cross-model review or a GitHub approval it did not submit.

## 5. Work order and boundaries

Work in checkpoints on the one branch: freeze and map sources; server outcome/recovery/SDK proof; shared frozen-intent and refresh behavior; target presentations; joined/browser qualification; documentation and exact-revision handoff. These are checkpoints, not six PRs.

Allowed changes include the S3 provider and narrow configuration/retry support, existing upload routes/services where needed, scoped Runtime seams, shared reconciliation helpers, the two target presentations, associated tests/harnesses, and goal/Help/handbook/backlog/evidence files. Record any necessary expansion before implementing it.

Not authorized: new durable jobs or public endpoints; database schema/idempotency migration; new storage providers; retention or migration work; mass artifact deletion; provider-identity administration; catalog/export/human-assessment features; another UI strategy; general Runtime redesign; paid model calls; employer/private corpora; production buckets or databases; forced pushes; rewriting historical branches; marking ready; merging; issue/PR closures; releases; bypassing protection.

## 6. Publication without evidence churn

Publish one coherent draft PR to main. Do not wait on hosted CI before publishing the candidate that must trigger it. Functional proof belongs to exact candidate C. Any subsequent evidence-only commit E must identify C and show the exact C-to-E diff. Test, fixture, configuration, dependency, and production changes are never evidence-only.

Do not require a receipt to contain its own future commit ID. Record final head/tree, test-merge checkout/tree, and new workflow IDs in PR metadata and the handoff. If a generated test merge was executed, name it and verify its tree/parents; do not call it the branch head.

Obtain fresh required CI and independent review when available. Pending CI or an unavailable external environment permits a truthful review checkpoint, not fabrication, pointless edits, or endless polling. Stop after publishing the completed work and reporting the remaining evidence. Do not search for unrelated nits to keep a goal runner busy. A new continuation is not permission to alter the contract or begin a successor.

## 7. Final report

Return:

A. Verdict: `READY_FOR_REVIEW`, `READY_FOR_REVIEW_CI_PENDING`, `PARTIAL`, or a precise `BLOCKED_*` state. Separate implemented behavior from external acceptance gates.

B. Identity: repository, branch, draft PR, base/merge base, current main, tested functional SHA/tree, published SHA/tree, any test-merge SHA/tree, exact goal path/hash, and working-tree status.

C. Source disposition: #1159/#1166/#1168/#1170/#1173 heads and which changes were reused, adapted, rejected, or already present. Historical PRs remain untouched.

D. SER-01 through SER-12: proven/partial/blocked/not performed, each with exact source and evidence.

E. Verification: commands, working directory, tested revision, environment, counts, retries, failures, skips, mutation outcomes, named artifacts, workflow IDs/attempts/conclusions, and independent-review report location.

F. User journey: reproducible synthetic launch and interaction steps, distinguishing ordinary demo from the fault/recovery harness. State exactly which layer injects each fault.

G. Residuals/nonclaims: no live AWS fault proof unless executed; no global exactly-once metadata guarantee; no cross-reload durable intent; no merge or closures; no private/production data used.

H. Stop: provide the draft for oversight. Do not launch the next product goal or create another commit solely to record CI.

## Source notes for implementation research

Repository anchors are pinned starting evidence, not substitutes for reading current code:

- Main provider construction: `collab/server/src/evidence/s3-store.ts` at `c5de75d1e40a3de8ddfceda2ce3d216a5e19644d`.
- Main upload orchestration and canonical preparation: `collab/web/src/investigations/runtime/controllers/{use-upload-evidence,file-base64}.ts` at that same revision.
- Historical editable-form retry: `collab/web/src/investigations/strategies/investigation-first/InvestigationFirstStrategy.tsx` at `2e9d6856a8a5fb79f8cebcfb92d66ecc2e01af04`.
- Historical browser retry comparison: #1170 at `2bfa811204440006710bf6d073206d5efe39f3be`.
- AWS CopyObject documentation: https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html
- AWS retry configuration documentation: https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html

The AWS references explain why response-body processing and SDK retries need explicit attention. They do not establish the behavior of the repository's locked SDK version, an injected client, or every S3-compatible provider; the required tests must establish the supported boundary.
