# ContextDesk Goal 06 — Trusted Export and External-Response Handoff

/goal Complete a trustworthy, usable export-to-external-response journey on current ContextDesk main. Select evidence, prepare and validate a brief or prompt package, deliberately download JSON and Markdown, and record a synthetic returned analysis with the original package snapshot identity through the existing import workflow. Reuse the historical export candidates, close their missing guarantees, and publish one coherent draft PR. Do not merge.

## Outcome and limits

An authorized investigator can prepare an understandable handoff, know its case, export kind, privacy classification, selected evidence and snapshot basis, save the actual checked files, and record an external response without pretending that a reported snapshot binding proves what an external model actually saw or that its answer is correct.

This is a product increment, not a general export framework, storage migration, new model integration, or another S3 qualification cycle. The default delivery target is the existing collaboration application's Export support surface. Preserve how other presentations reach their existing support workflow; do not create four competing implementations or add export UI to presentations that do not currently own it merely for symmetry.

The JSON export envelope, readable Markdown, and portable investigation archive are different artifacts. Do not confuse a prompt package with a restorable archive. Keep their existing meanings and permissions separate.

## 1. Starting point and baseline disposition

Repository: `chriscase/ContextDesk`.
Observed main: `10b4c4f54f7d849124ec16a70ea7435cdc76dc00`.
Observed tree: `bde6ee328ce2dca7fbff7fa452ddb9011fc27806`.
This is the merge of Goal 05 through PR #1184. Goals 01, 04 and 05, and the desktop synchronization repair, are already integrated; do not reimplement them or rewrite their evidence.

Proposed owned branch: `integrate/trusted-export-handoff-v1`.
Goal destination: `docs/goals/06-TRUSTED-EXPORT-HANDOFF.md`.
Receipt destination: `docs/goals/TRUSTED_EXPORT_HANDOFF_RECEIPT.md`.

Reverify current main, repository instructions, local worktrees and any overlapping active branch. Inspect compatible main changes and record the actual base separately rather than editing this original supplied objective. If the proposed branch already contains legitimate work, preserve and inspect it before creating anything. Never reset or clean an unexplained dirty worktree. Do not import another agent's unreviewed overlapping edits.

### Known baseline CI exception — a bounded separate check

At this objective's preparation:

- Post-merge `collab` run `36332785811`: success, attempt 1, observed main above.
- Post-merge `collab-qualify` run `36332785825`: success, attempt 1, same main.
- Root CI run `36332785814`: cancelled, attempt 1, same main.
- Ubuntu Rust shard 5, job `108659737494`: cancelled, with no completed result artifact. Its log fetch returned BlobNotFound.
- Ubuntu aggregate job `108671029887`: failed because shard 5's result was missing. Its log reports 144/165 test units accounted for; the other seven Ubuntu shard reports show zero failed tests. This is missing execution evidence, not proof that the missing tests passed or that a product defect caused cancellation.
- macOS and Windows Rust aggregates passed. The two cache warmups were skipped cache jobs.

Recheck the current run/attempt once before action. When this prompt is submitted by the owner, it authorizes one narrowly targeted rerun of the cancelled shard and required dependent aggregation, if still needed and supported by current GitHub permissions. Preserve the original cancellation and failed aggregate. Do not rerun only the aggregate against the same missing artifact, restart every successful platform gratuitously, or change CI policy to manufacture green.

If the original cancellation has a known owner stop/cost instruction, respect that instead of restarting it. If permission is missing, report the exact requested action; do not bypass approval. A repeated failure/hang needs logs and separate diagnosis, not repeated reruns. No Rust, desktop, workflow-YAML or shard-topology changes belong to this export branch.

The cancelled run does not by itself bar isolated export implementation or a draft PR. Carry the baseline exception explicitly until resolved. Do not describe main as fully green or recommend promotion while a required baseline result or an actual blocking defect remains undisposed. Do not spend the product run polling; inspect again at a natural checkpoint/end and report what exists.

Also preserve the reported duplicate-push Software Impact recording-order caption failure (run `36297302383`, job `108558422118`) as an unresolved historical reliability observation. A passing identical-tree job does not erase it. Do not assume that an open catalog-suggestion PR fixes it. Only make a separately scoped repair if a concrete reproduction requires one; do not sweep unrelated timing repairs into this goal.

## 2. Historical sources — inspect, do not blindly merge

1. PR #1177, `grok/contextdesk-export-delivery-v1`:
   `5f10750ecd3016c69fcab5a8931d5eaa4f135b5a`.
   Four-file presentation/test/style candidate based on older main. Useful: retained envelope, JSON/Markdown downloads, download URL leases, and a real package-to-import browser journey. It explicitly uses a shallow delivery guard; do not preserve that guard as the final validation boundary.
2. Browser-safe parser successor, `grok/contextdesk-export-parser-browser-v1`:
   `5b1258fdab12dfcf3c679da9857d1167e50888f2`.
   Its direct parent is #1177's head above. It exposes the existing authoritative export parsers via a browser-safe subpath by separating shared vocabularies from Node-only imports.

Fetch the exact commits, verify their parent/delta, and selectively adapt onto current main. Do not apply the parent twice. Current #1177 is not directly mergeable; do not replace current files with old-main copies. Leave both historical sources and their PR state untouched during implementation. Their old local reviews/tests are leads, not qualification of the new branch.

The historic parser graph test constructs slash-delimited paths. Check platform-neutral path handling when adapting it; prove Windows compatibility instead of copying assumptions from a POSIX machine.

## 3. Freeze and read first

Read this complete supplied file and its external SHA256SUMS; commit its bytes unchanged before production edits. Do not replace it with a shorter acceptance summary. Put provenance, repinning, discoveries and any later scope disposition in the receipt, not inside the immutable owner artifact. If actual supplied bytes are inaccessible, report BLOCKED_GOAL_INPUT rather than reconstructing the goal.

Read current `AGENTS.md`, `docs/AGENT_WORKFLOW.md`, applicable claims/handbook rules, and at least:

- `collab/web/src/ExportPanel.tsx` and `ExportPanel.test.tsx`;
- all production mount sites of ExportPanel, including identity/authority and case lifecycle ownership;
- `collab/web/src/protected-api.ts` and existing auth-loss behavior;
- `collab/web/src/styles/export.css`;
- `collab/contracts/src/export.ts`, `brief.ts`, `package.ts`, package exports, fixtures and tests;
- current server `modules/export/{routes,service,project,markdown,canonical,scan,redact}` implementations and tests;
- the current import form, its authoritative provenance/snapshot parser, routes, and imported-run presentation;
- existing portable-archive behavior within ExportPanel; preserve its typed confirmation, authorization and uncertain-restore rules;
- `collab/e2e/specs/05-export-share-safe.spec.ts`, import and complete operator journeys, relevant responsive/authorization specs and fixture helpers;
- `docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md`, `docs/design/PROVEN_METHODS.md`, relevant investigation-loop and Help material;
- the exact historical source deltas above.

Publish a brief source/disposition and acceptance map, then implement. Do not stop after producing only a plan.

## 4. Acceptance contract

### TEH-01 — Owned integration and compatibility

Start from verified main; preserve inherited versus new changes explicitly. Maintain one integration owner and one draft PR. Preserve discovery, Activity Center, S3 upload recovery, current source/catalog identity, and existing import/portable behavior. Do not change dependency versions, server permissions, S3 behavior or durable schemas to accomplish this goal. A narrow, additive identity/authority prop or shared protected controller is allowed where required by the actual mount path.

### TEH-02 — One browser-safe authoritative contract

Use the real `parseExportEnvelope` and `parseExportInventory`, through an intentionally browser-safe package entry. Browser and server must share implementation, not copies that drift. Preserve supported root/legacy exports while separating only genuinely shared vocabulary/dependencies.

Validate nested brief/package data, not only top-level schema/kind/case fields. Additionally bind the parsed result to the frozen requested case, kind and privacy. Check the relevant payload/manifest cross-field identity and privacy consistency. If a genuinely shared invariant is missing, implement it in the authoritative contract and test its compatibility, rather than inventing a second private browser parser or silently coercing a malformed response.

Handle empty/non-JSON bodies, wrong schema/kind, nested malformed fields, wrong case, wrong privacy, invalid snapshot tokens and inconsistent inventories as unavailable/invalid results. Nothing unvalidated becomes a preview, Blob, download or transferable snapshot token.

A schema parser is not cryptographic authentication or proof of external evidence exposure. Preserve server snapshot construction and hashing authority. Do not introduce a new fingerprint scheme or relabel ordinary pretty JSON as a cryptographic canonical encoding.

Prove the runtime import graph is free of Node-only/server/storage dependencies in actual built browser code and platform-neutral tests. Do not add browser polyfills to conceal an incorrect import boundary.

### TEH-03 — Deliberate selection and a frozen prepared result

Inventory state distinguishes initial loading, failure, genuinely empty, unavailable, and ready. Preserve selections across recoverable same-scope failures; never equate a failed read with an empty inventory. Keep server exclusions and permission-filtered data authoritative. Do not auto-select excluded evidence or broaden a selection after a refresh.

At export submission, freeze the current case, kind, privacy, allowed selection, and scaffold. Capture an attempt identity and synchronously prevent duplicate submissions. Disable conflicting controls while the request is running; handlers must also reject programmatic duplicate/unauthorized invocations.

A successful prepared result displays its own recorded case, export type, privacy, generated time, and package snapshot basis, rather than borrowing labels from mutable controls. Changing privacy/selection/scaffold after preparation must invalidate download availability or explicitly keep a separately labeled frozen result; choose the simpler clear behavior and test it. Never let an owner-only file appear under a newly chosen share-safe label.

Briefs need not invent a package snapshot identity. Omitted/truncated-by-policy content, excluded items and sparse records must be described using actual server facts. Do not manufacture completeness, live model use, independent verification, correctness or private-file inclusion.

### TEH-04 — Actual checked JSON and Markdown delivery

Retain the complete validated versioned envelope. Provide deliberate Download JSON and Download Markdown actions. JSON must round-trip to that checked envelope; Markdown bytes must equal its `markdown` field. Do not regenerate a second narrative in the UI, omit envelope fields, splice fresh mutable case data into an old result, or escape/sanitize the file into a different semantic result.

Use bounded, deterministic safe filenames derived from non-secret recorded identity/kind/privacy; no server-supplied arbitrary paths or confidential titles in filenames. Use correct media types and downloadable file extensions. Repeated downloads of one retained envelope should have stable bytes. Separately generated exports may differ in `exportedAt`; stable manifest identity does not imply byte-identical timestamped envelopes.

Preview as inert text (or an already-approved safe renderer with no active remote content). Explain prepared versus browser download initiated; do not claim the browser/user saved a file to disk merely because `anchor.click()` ran. No upload to external providers, clipboard transfer, email, remote share link or automatic download on response completion is required or authorized.

### TEH-05 — Scope, authority, lifecycle and retained actions

Use the actual authenticated mount context, not caseId alone. Across case, identity, authority/export capability, private access, lifecycle unavailability, navigation and unmount:

- conceal previous result, preview, inventory-derived sensitive text, selection, errors and actions at the appropriate synchronous boundary;
- revoke obsolete export and download callbacks before replacement layout can operate them;
- reject late success/failure and A-to-B-to-A resurrection;
- make unauthorized initial renders issue zero protected export/inventory reads or writes under the component's action contract;
- preserve authorized same-scope refresh state without erasing the draft unnecessarily;
- do not downgrade owner-only material into share-safe output on capability loss.

Test actual wrapper/mount composition, including keyed unmounts and stored callbacks invoked before passive cleanup, not just an isolated controller with friendlier semantics. Distinguish obsolete handler invocation, reaching a command, making a network request, creating a Blob URL, initiating a browser download, and publishing a result. A downstream server refusal is not proof that no stale browser action occurred.

Already completed external file downloads cannot be recalled by revoking a Blob URL; describe that limit honestly.

### TEH-06 — Download-resource lifetime

Track the URL itself as well as its cleanup timer. Every created object URL must be released after its bounded lifetime and on result replacement, applicable scope/authority invalidation and unmount. Cancelling a timer without revoking its URL is insufficient.

Clean up on errors during Blob/URL/anchor creation or dispatch; remove temporary anchors and avoid double revocation or revival by late timers. Do not revoke so early that a real download fails. Test rapid repeat downloads, replacement while a lease exists, unmount, retained download callbacks, and simulated download-API errors.

The existing portable archive may reuse a corrected download helper, but preserve its separate validation, identity mapping, confirmation, unknown-result and replay behavior. Do not redesign portable apply or claim JSON prompt packages can restore a case.

### TEH-07 — Privacy and truthful failure

Keep server role/case/private-evidence checks and share-safe scanning authoritative. Test case lead, allowed writer, read-only and denied states according to the actual current contract. A malformed or denied response must not be downloadable. An old successful export must not remain deceptively active after a failed replacement or privacy change.

Map failure statuses/codes to bounded safe messages. Do not display arbitrary raw error strings, provider responses, stack traces or unbounded privacy-scan excerpts. Preserve useful structured findings through existing safe redaction rules. Do not weaken the server scan to make tests green.

Network interruption means a valid downloadable response was not obtained; it does not prove the server did no projection/audit work. Download failure does not justify generating a new export automatically. Retry export and retry delivering an already prepared file are distinct human actions.

### TEH-08 — Complete package-to-response user journey

Through the real mounted browser support surface and real disposable server:

1. Create synthetic authorized case/evidence, including deliberately different public/private and selected/excluded inputs.
2. Select a share-safe subset and prepare a package through the actual control.
3. Save the real browser JSON and Markdown downloads to a temporary directory; read their bytes, parse with the authoritative contract and compare selected manifest/excerpt identities, privacy, snapshot and exact Markdown.
4. Record a synthetic returned response through the existing import form, explicitly choosing its source and required redaction confirmation, and entering the package snapshot identity through its actual supported field.
5. Reopen/navigate/reload the imported record and verify exact binding plus honest unverified/importer-described provenance. It must not automatically become corroborated, verified, judged correct or proof that the external model consumed that evidence.
6. Qualify a brief separately, and preserve the existing portable archive round trip as a regression.

Use synthetic text only; no live paid model or private corpus is needed. Do not implement automatic response import, new human-assessment tables, provenance-inspector stack, or a new package-upload API. A manual existing snapshot-binding field is acceptable when clearly explained and correctly tested.

The journey must traverse real browser -> protected transport -> current export/import service. HTTP-injected faults are additional evidence, not substitutes for the successful real path. State whether the fixture is in-memory or durable; no restart-persistence claim without actual persistent backing and a process restart.

### TEH-09 — Operability and adversarial proof

Qualify keyboard-only selection, prepare, download, failure/retry and import handoff; meaningful focus/status/alert behavior; unique IDs and correct descriptions; 320px and normal-width layout; forced-colors focus/boundaries; reduced-motion behavior without adding animation solely to disable it in tests. Do not claim a real screen-reader audit or cross-browser matrix unless run.

Add non-vacuous regressions for malformed nested envelopes/inventory, mismatched case/kind/privacy, stale pre-effect actions, late success/error, A-B-A, no-read/no-export requests, draft privacy switch, lease cleanup, and download errors.

Demonstrate at least four temporary mutations: bypass nested parser validation; remove a case/privacy binding guard; remove obsolete-action/result revocation; omit URL revocation. Each must fail a meaningful named assertion, restore exact source bytes and pass. Keep mutants and raw private traces out of publication.

### TEH-10 — Qualification, documentation and reviewable delivery

Use existing fixture conventions and next unused numbering if a new spec is needed (expected 40); extending current spec 05 is also appropriate. Leave discovery spec 37, Activity Center spec 38 and S3 spec 39 intact unless an explicitly necessary compatibility change is proven and narrowly documented.

Run focused contracts/export/import/controller/form tests; repeat new timing-sensitive cases at least ten times without retry masking; then contracts/server/web typecheck, lint, full relevant test suites, production build, E2E typecheck, targeted export/import/portable/operator journeys, and the full applicable Chromium suite with retries disabled. Repeat the new main journey five times with one worker and isolated state. Preserve user presentation preferences separately from instance policy during test setup/teardown. Record failures before any rerun, and do not call skipped tests passed.

Use repository shared build-cache policy and actual scripts from current package.json/AGENTS. Do not cold-build untouched desktop/Rust repeatedly. Hosted Windows qualification matters for the adapted contracts graph tests; verify it rather than assuming POSIX path tests are portable. Normal root/collab/collab-qualify checks remain review gates; report missing or cancelled runs honestly.

Update relevant user Help explaining artifact differences, explicit privacy, download handling, external-response provenance, and the actual demo steps. Reconcile the living backlog in the same goal: Goal 05 is merged via #1184; #1159/#1166/#1168/#1170/#1173 are closed superseded sources, not open prerequisites; this export goal is unmerged until promotion. Move already shipped items out of the active queue. Reuse accurate facts from old backlog PR #1179 without merging or closing it here. Evaluate handbook/claims impact against the actual export trust guarantees.

Publish a compact acceptance ledger and sanitized reproducible commands/results tied to exact revisions. Keep a complete machine-readable result artifact when useful, not thousands of duplicate console lines in the receipt. Provide a fresh separate adversarial review of the final functional candidate, accurately stating model, checkout, what it inspected/executed, findings and residuals. Do not invent a GitHub approval.

## 5. Work organization, permissions and finite handoff

Work end-to-end on this one product goal. Use small commits and a single coherent draft PR. Plan, implement, verify and publish rather than stopping after inventory. Checkpoint legitimate progress so a quota interruption does not strand valuable work locally. Preserve work and ownership rather than starting over when resuming.

When Chris submits this objective/start prompt, it authorizes local development and normal fast-forward publication of this task's source, synthetic fixtures and sanitized review evidence to the owned feature branch and a new draft PR in the public repository. This does not authorize secrets, employer/customer data, raw recovery archives, private endpoints, or unrelated history to leave the machine. Inspect outgoing changes; respect any platform approval requirement and request a specific missing approval rather than bypassing it. Historical Goal 05 temporary-path approvals are not a blanket authorization for new private content.

You may forward-port useful candidates, add narrow browser-safe contracts and scope plumbing, and update relevant Help/backlog. Do not merge, mark ready, close historical PRs/issues, release, deploy, alter production data, weaken tests/protection, force-push or implement another backlog item. Do not add a new dependency, public schema/API or durable storage design merely to make this bounded goal convenient.

Freeze functional candidate C after implementation/tests. Evidence-only E is optional. Changes to tests, fixtures, configuration, dependencies, Help behavior or product code are not automatically evidence-only; revalidate affected gates after such changes. Distinguish branch head from GitHub's actual generated merge checkout and compare trees. Record latest workflow IDs/results in PR metadata or the handoff, not recursive commits that perpetually move the reviewed head.

If all local criteria are satisfied but CI or an environmental gate is pending, publish the draft and return READY_FOR_REVIEW_CI_PENDING. A baseline cancellation still needs its explicit disposition before promotion; do not conceal it by relabeling identical content as new proof. If a real blocking defect is demonstrated, report it and isolate repairs instead of padding this goal. Stop after a finite checkpoint, not indefinite polling, repeated unchanged test cycles or unrelated cleanup.

## 6. Final report

Return:

- Verdict: READY_FOR_REVIEW, READY_FOR_REVIEW_CI_PENDING, PARTIAL, or a precise blocker.
- Repository, actual branch/PR, base/merge base/current main, full tested/published head and tree, goal hash, and clean/dirty worktree state.
- Historical-source disposition and what was inherited versus changed.
- TEH-01 through TEH-10, each proven/partial/blocked with exact evidence references and nonclaims.
- Real user journey and resulting file bytes/provenance checks; separate route-injected faults, fixture limits and any durable evidence.
- Exact commands, checkout revisions, environments, counts, repeated runs, failures/skips, mutation failures/restored passes, and separate reviewer result.
- Changed-file manifest and narrow boundary explanation.
- Hosted workflow head/actual checkout/tree/attempt/conclusion; baseline cancelled-shard follow-up and historical caption failure retained honestly.
- Remote evidence paths plus clear synthetic manual demo steps.
- Confirmation: no merge, release, historical closure, private-data publication or successor implementation.

Preferred later direction, to re-evaluate after this lands: imported-run provenance and human assessments with an explicit portable-history boundary, followed by measurable investigation-quality work using the existing bench. Do not implement that successor here.
