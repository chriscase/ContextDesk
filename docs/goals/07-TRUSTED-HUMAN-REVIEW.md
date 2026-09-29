# ContextDesk Goal 07 — Trusted Human Review of Imported Responses

/goal Complete the imported-response review loop on current ContextDesk main: inspect honestly attributed provenance, record cited append-only human assessments, recover an uncertain submission without duplicating or changing its intent, and reopen the same history after a server restart. Selectively adapt the historical stack, preserve the existing legacy review and Goal 06 export workflow, and publish one coherent draft PR for independent review. Do not merge.

## Outcome and limits

An authorized investigator can open a synthetic response imported through Goal 06, distinguish recorded facts from importer claims and missing information, append a corroborates/contradicts/insufficient-evidence assessment with appropriate citations, inspect disagreement as history, and recover from an interrupted response with a deliberate same-intent retry. A human assessment is not verified model execution, an automatic correctness verdict, a benchmark label, a resolution, or a replacement for the existing legacy corroboration state.

This is a substantial cross-layer feature, not a provenance-only cosmetic change and not permission to rebuild the investigation framework. Ship one usable War Room Capture workflow. The other presentations retain their existing behavior; they can reach the existing explicit War Room technical-tools route without changing a saved presentation preference. Do not build three more assessment UIs in this goal.

**Explicit bounded portability decision:** assessment rows will not be added to the portable archive schema in this goal. Affected portable operations must fail closed when they cannot represent the history. The UI must disclose this consequence before the first assessment is submitted, and explain it again where an affected archive operation is offered. Unaffected cases and old supported archives remain usable. Do not delete or silently omit history, make a lossy archive appear exact, or describe ordinary brief/package exports as containing assessment history. This restriction is a product tradeoff, not an unreported defect to hide behind a green test run.

## Observed baseline and historical sources

Observed main: `0d6d592c5b9cca6b041a7f5eb7f5ef86442e5d11`.
Observed main tree: `92ee16477790bfd45f9729153c4a2c4bec2fe66a`.
Goal 06 merged through #1185. Discovery, Activity Center safety, S3 recovery, and trusted export delivery are shipped foundations; do not reopen their accepted goals.

Post-merge collaboration runs `36447899076` and `36447899348` were verified successful, attempt 1. Root CI `36447899024` was still running when this goal was prepared. Recheck once at intake and once at the final handoff when useful. Pending root CI permits isolated implementation and draft publication, but is not a pass or merge authorization. Diagnose any observed failure separately; do not bundle unrelated Rust/desktop/CI repairs. There is no instruction to rerun successful checks or poll indefinitely.

Proposed owned branch: `integrate/trusted-human-review-v1`.
Destination for this exact supplied file: `docs/goals/07-TRUSTED-HUMAN-REVIEW.md`.

| Historical source | Exact observed head | Relevant contribution |
| --- | --- | --- |
| #1160 | `7630ed776c3da84687ceb33402750c431900e917` | Strict browser-safe judgment contracts and JSON Schemas |
| #1161 | `d0363d8bf7cddc41c003a212919e6f1880a54c40` | Server authorization, sequencing, atomic persistence/replay, portable refusal |
| #1162 | `aba5a6e9852a9ef5515ce14f635606307a04faa2` | Public Runtime/gateway/controller seam |
| #1163 | `768271c294b75fbec072a6ab413cb3664e800d4c` | Focused War Room Human Assessments UI and adapter |
| #1164 | `789d18562963b9d8898ffb745c841bffbdf8a9ba` | Historical browser journey and fault coverage |
| #1169 | `a5a0288bfbe1c1c42861916b2e5968d81f086f15` | View-first imported-run provenance inspector |

These are historical design/test sources, not approved replacements for current files. Inspect actual parents and merge bases before extracting child deltas. Some children originated before their parent's final follow-up; do not assume the PR base label proves linear ancestry or copy a parent twice. Keep the historical branches and PRs unchanged. Do not rebase them, merge them separately, or close them in this task.

## Intake, ownership, and source map

Read repository instructions and inspect current worktrees before creating or reusing the proposed branch. A dirty worktree is recovery input, not permission to discard work. Preserve unrelated changes and stop only for a genuine unresolved ownership/access conflict. If main moved compatibly, record the inspected new base separately without editing this supplied objective. If an active overlapping feature exists, report the collision instead of overwriting it.

Copy this complete file unchanged, verify its supplied SHA-256, and commit it before production changes. Do not replace it with a criteria summary. If the supplied bytes are missing, report `BLOCKED_GOAL_INPUT`; do not reconstruct them. Keep later provenance commentary in the receipt.

Read at least:

- `AGENTS.md`, `docs/AGENT_WORKFLOW.md`, and applicable component instructions.
- `docs/design/WAR_ROOM_CONTINUOUS_DELIVERY_BACKLOG.md`, `PROVEN_METHODS.md`, and its investigation-loop chapter.
- Current `ImportedRun.tsx`, `TriageWorkspace.tsx`, `Cases.tsx`, `App.tsx`, their tests, and the Runtime public/gateway/controller boundaries.
- Current import contracts, routes/service/store, SQLite persistence, PostgreSQL migrations and transaction plumbing, activity projection, and portable-investigation service/persist paths.
- Goal 06's export/browser-safe parser and provenance wording. Preserve the browser-safe vocabulary extraction; do not reintroduce Node imports through old `run.ts` changes.
- The six pinned historical diffs, tests, and relevant review corrections.
- Current E2E inventory. Use the next unused prefix, expected `41-*`; do not overwrite specs 37–40.

Authority remains server-owned: authenticated actor, capabilities, case/run visibility, link privacy, lifecycle policy, timestamps, sequence, compare-and-swap (CAS), idempotent replay, audit, persistence, and canonical navigation. Presentation uses public Runtime commands/resources, not direct judgment fetches or new shadow stores.

## Acceptance contract

### THR-01 — Current-base integration and contract ownership

Deliver one bounded feature branch from the verified base. Preserve source provenance for each historical contribution as reused, adapted, rejected, or already shipped. Use one authoritative browser-safe judgment parser/DTO entry and its strict JSON Schemas; maintain parser/schema parity with explicitly documented semantic checks. Unknown fields, hostile identities, invalid timestamps, oversized fields, and incoherent success/list envelopes fail closed.

Protect Goal 06 root/browser parser identity, imported-run wording, actual file delivery, and existing discovery/S3/Activity Center tests. Choose the next available migration identifier after inspecting current migrations; never overwrite an existing migration or replace a current barrel/package file with its historical version.

### THR-02 — Readable provenance and separate review meanings

Adapt the #1169 inspector to current imported records. Display recorded source/importer/operator, prompt and completeness, output, workflow/evidence visibility, reported snapshot/counts, timing/cost/privacy/redaction fields only where the actual record supports them. Missing is not zero, complete, safe, or verified. A claimed trace or package hash is not proof of model exposure, execution, independence, or correctness. Resolve recognizable source labels only from authorized current catalog data; retain recorded IDs in details and do not fabricate missing metadata.

Keep append-only Human assessments visibly separate from the existing Save review control, legacy `/corroborate` path/banner, and investigation resolution. New assessments must not mutate those fields, import text, provenance, evidence identities, or benchmark truth. Show disagreement as distinct attributed records in server sequence, not a voting score or automatic final verdict. The legacy path remains tested and honestly labeled.

### THR-03 — Append-only, bounded history

Support the three existing judgment values and the existing citation vocabulary. Require at least one eligible recorded citation for corroborates or contradicts; insufficient evidence may have no citation, visibly stated. The composer may expose artifact/contribution choices as the historical UI does; an existing snapshot citation in history must still be rendered honestly and resolved safely.

Record immutable actor attribution, server recording time, sequence, original link identities, and optional bounded rationale. Revisions are later assessments, not overwrites/deletes. Keep history complete, ordered, contiguous, and bounded: retain the historical 1,024-per-run server capacity unless current source requires a justified correction. At the cap refuse another append explicitly; never silently truncate a supposedly complete list or convert a corrupt list into empty history. Replays must not consume another slot.

Expose one explicit focused-run read, not a new list request per card in a large investigation. An unavailable optional Runtime seam is an unavailable feature, not an empty history.

### THR-04 — Authorization and atomic durable writes

Implement the historical additive GET/POST judgment routes under existing import authority. Authenticate/authorize before returning existence-sensitive details; bind path, request, stored run, case, and authenticated actor. Reject cross-case/missing/inaccessible citation targets without revealing their private contents. A share-safe run cannot cite owner-only records. Rationale follows the established judgment/run visibility policy and must never leak through broad activity, error messages, logs, or exports. Current lifecycle/legal-hold semantics remain authoritative; do not invent a new legal-hold rule.

Use current transactional mechanisms, not ad-hoc compensation. Judgment row, ordered timeline event, successful audit, and durable success-intent record must commit or roll back together. Preserve existing records on SQLite upgrade/reopen and use actual PostgreSQL transactional execution for its backend. Exercise concurrent same-key same-intent requests, distinct competing keys at the same expected sequence, and failures between persistence steps. One successful intent produces one logical assessment/event/audit, and a retry of a committed intent returns the original applied record without a second side effect.

Fresh success is 201 and exact replay 200; bind each returned success to the request and stored immutable run provenance. Sequence conflicts and refusal reasons remain distinct. Exact 503 `commit_outcome_unknown` is not ordinary known failure. Do not call an interrupted response proof of rollback. Keep raw idempotency keys out of user-facing logs, activity and diagnostics; persist replay identity only as required by the existing private storage contract.

### THR-05 — Immutable intent, causal refresh, and deliberate reconciliation

Freeze normalized judgment, case/run, actor scope, ordered link identities, rationale, and idempotency key for an uncertain attempt. Neither ordinary form edits nor retained callbacks may change that intent during reconciliation. Lock or clearly separate the frozen draft. No automatic POST, compensating DELETE, silent new key, or inferred rollback is allowed.

Do not copy #1163's `resource !== refreshStartResource` freshness heuristic as acceptance proof. Retry readiness requires a completed successful authoritative history read initiated after that specific conflict/unknown result, for the same run and current identity/authority scope. Use a narrow Runtime completion token/generation or equivalent causal evidence. An old ready object, shallow wrapper replacement, pre-failure read, unrelated read, or earlier attempt's completion must not unlock retry. Failed refresh remains failed, not empty or reviewed. A successful unchanged-content read can be fresh; content change is not a freshness requirement.

The historical contract excludes `expectedSequence` from semantic intent. After an explicit fresh-history review, the next deliberate submission may use its current sequence while preserving the key and all intent fields. Report this as same-intent replay, not byte-identical full HTTP-body replay when the CAS field changes. A known conflict is not an unknown commit; explain each separately. An already-committed retry must replay even when the history has advanced. Changed intent with a reused key must refuse.

A confirmed success is shown from its validated applied record. Reconciliation must recognize that record/sequence when it is already visible; do not wait forever for an arbitrary history fingerprint change, and do not mistake another person's append for proof that this request succeeded. For an unresolved outcome let the user inspect and finish without another write; do not silently transform it into a new assessment on reopen.

### THR-06 — Actual mounted scope and lifecycle protection

Cover the actual App/Cases/TriageWorkspace -> adapter -> Runtime -> panel composition, including any keyed replacement. Identity, authority, case, run, readable/writable status, and archive/lifecycle changes conceal stale history, rationale, citations, errors, and actions at the required committed-frame boundary. Captured submit, retry, refresh and citation-open callbacks fail closed before passive cleanup; late successes/failures cannot publish into a replacement scope. Release held private drafts on actual scope loss/unmount. Same-scope resource refresh must not discard the frozen draft or successful-result evidence.

Use a replacement-layout probe with an independent passive-cleanup witness, as established in Goals 05/06. Count attempted handler invocation, Runtime command calls, gateway requests, and eventual publication separately. Include A-to-B-to-A, run switching, authority revocation and removal without multiplying equivalent cases unnecessarily. Initially denied scope emits zero judgment/case-data reads or writes. Read-only authorized users may read permitted history but cannot submit. Preserve canonical reauthorization for citation navigation; an inaccessible/deleted target does not authorize client-constructed navigation or removal of its historical citation.

### THR-07 — Usable states and accessible interaction

Provide distinct idle/loading, true empty, same-scope stale refresh, first-load failure, unavailable feature, denied/concealed target, read-only, busy, validated success/replay, conflict, refusal, capacity reached, and unconfirmed outcome states. Preserve drafts on ordinary recoverable failure; never say saved before confirmation or show empty after a failed read. A retry failure remains visible through later inventory/history refresh.

Qualify keyboard access to provenance, history, citation selection, submit, refresh and deliberate retry; meaningful labels/groups/status announcements; distinct IDs/descriptions; and predictable focus without stealing it after scope removal. Verify 320px and normal-width reflow with long rationale/source labels. Inspect computed forced-color focus/boundaries and reduced-motion behavior rather than merely enabling emulation and checking visibility. Do not add animation just to prove it can be disabled. No real assistive-technology audit or cross-browser claim unless executed.

### THR-08 — Explicit export/portable boundary without silent data loss

Before a first assessment write, show a clear local acknowledgment that new assessment history is not yet representable in the portable archive and can make affected exact export/restore unavailable. This is a UX disclosure, not a new authorization source or proof that bypassing clients are safe. Server-side refusal independently protects data.

Apply the bounded portability decision stated above. Use authoritative stored state, not a caller-supplied count/flag, to refuse unsupported exact export/preflight/apply. Include imported/forged archives and attempts to apply an older archive over a destination carrying judgments; existing history must not be erased or silently excluded. Refusal details must not reveal inaccessible rows. Old supported archives/cases with no new assessments retain their existing behavior.

Goal 06 JSON/Markdown brief/package preparation and manual external-response import remain functional. They are not assessment-history transfer or a complete backup: state that limitation beside affected export actions and in Help, without claiming assessment rows are represented by timeline metadata alone. Do not expand archive schemas, migrate legacy corroboration, or invent a second assessment export format in this goal.

### THR-09 — Joined real workflow and failure proof

Provide a reusable synthetic browser journey against built current client/server: Goal 06 package -> manual imported response -> provenance -> first cited assessment -> second disagreement/insufficiency -> reload -> canonical navigation back to the exact run, with the legacy review state unchanged. An in-memory fixture may prove ordinary browser behavior but does not prove restart durability.

Also execute a disposable built-server/SQLite journey that stops and restarts on the same temporary database, reauthenticates, and recovers identical assessment history and durable idempotent replay. Demonstrate a successful server commit followed by lost/interrupted acknowledgment, a fresh authoritative history read, and deliberate same-intent replay yielding no duplicate event/audit/row. Introduce this fault after real persistence, not solely by changing a browser response to 503; label other HTTP-injected faults separately. No production data or external model call.

Execute the focused PostgreSQL migration/grants/atomicity/concurrency path at least once against a disposable real PostgreSQL backend, locally or in existing hosted qualification. Collected-but-skipped tests do not satisfy backend proof; report missing environment evidence as pending rather than rewriting the feature around it. Reuse repository fixtures/transactions rather than a new harness framework.

Demonstrate temporary, restored mutations for four load-bearing guarantees: scope cleanup timing; causal history-read gating; changed-intent idempotency refusal or duplicate prevention; and authoritative portable refusal. Each must fail a named meaningful test, then pass restored. Mutation edits/logs containing private paths stay local; publish the sanitized recipe/result and replayable test. No arbitrary sleep or retry inflation as a substitute for synchronization.

### THR-10 — Qualification, publication, and finite handoff

Run focused contracts/server/Runtime/presentation tests during development; run full applicable collaboration typecheck, lint, tests, builds and E2E typecheck once on the final stable candidate. Run full ordinary Chromium without retries, the new real journey three independent times, and the new phase-sensitive tests five times. Repeat only affected proof if subsequent functional/test changes invalidate it. Use the documented build caches; do not cold-build unchanged Rust/desktop or re-execute every historical stress campaign.

Check dependency boundaries, schema/migration/grant guards, privacy fixtures, and applicable handbook/claims/diff checks. Obtain one separate read-only adversarial review of the final behavior, concentrating on transactions/privacy, causal replay, the actual mount boundary, and portable refusal. Review is not test execution or a GitHub approval. Correct concrete findings; do not broaden the goal for style preferences or new evidence wishes unrelated to this contract.

Update Help and relevant Proven Methods text, and reconcile the living backlog: Goal 06 shipped through #1185; this human-review slice is the new active goal; archival judgment representation and later measured triage quality remain future decisions. Do not silently claim other unmerged PRs shipped. Preserve #1158, #1172, #1174, #1175, #1176, #1179, #1012 and unrelated work unless a narrowly necessary dependency is demonstrated and separately dispositioned.

Maintain `docs/goals/TRUSTED_HUMAN_REVIEW_RECEIPT.md` with THR-01..10 evidence, exact commands/environments, failures/skips, source provenance, actual tested/published/check-out identities, review findings, and limitations. Prefer a committed functional candidate C before final verification. A later documentation-only E may cite C; identify its exact delta. Do not retroactively call a functional/test change evidence-only, and do not fabricate a pre-test commit if a test ran on a recorded tree instead.

## Execution economy and publication authorization

Work in dependency order internally, not six owner approval loops: contracts/storage -> Runtime -> provenance/panel -> joined acceptance. Produce a short early checkpoint, then continue the full goal unless genuinely blocked. Reuse valid historical work and current test helpers. Use one integration owner; parallel readers or nonoverlapping bounded tasks are allowed, but avoid duplicate whole-repository audits.

Read targeted source and job summaries; keep full logs as artifacts rather than repeatedly feeding them into every model pass. During validation, summarize errors before expanding only the failing context. Required evidence is an invariant, not a reason to generate huge transcripts. No timestamp-only commits, repeated no-change handoffs, or arbitrary test-count targets beyond the defined proof.

This task permits development commits, normal fast-forward publication of its implementation/tests and sanitized synthetic evidence to the public `chriscase/ContextDesk` owned branch, and one draft PR. Follow actual tool approval controls; do not bypass them. Explicitly exclude credentials, employer/customer data, internal URLs, private corpora, private recovery archives and raw local recordings. Preserve dirty work before changing it. Push useful sanitized checkpoints so another quota interruption does not strand progress locally.

Do not modify completed integration branches, force-push, mark ready, merge, close historical PRs/issues, release, deploy, access production, invoke Grok after its quota exhaustion, or make paid model/provider calls for qualification. Use available Codex review resources, not an external-provider dependency.

Start normal hosted checks by publishing the draft candidate; do not wait for nonexistent checks before pushing. At the end inspect check state once. Pending checks or missing disposable backend evidence may be reported honestly without indefinite polling or unrelated cleanup. A failed relevant gate is not a pass; diagnose or leave a precise partial criterion. Current-main failure outside the slice remains a separate baseline disposition and prevents a merge recommendation until resolved, not an excuse to erase correct local implementation.

## Final report and stop

Return `READY_FOR_REVIEW`, `READY_FOR_REVIEW_CI_PENDING`, `PARTIAL`, or a precise blocker. Include: draft PR; current main/base/merge-base; tested C/tree and published head/tree; exact goal hash; THR ledger with remote evidence; historical-source dispositions; changed-file manifest; commands/results with failures/skips; actual hosted checkout identities and baseline CI status; separate review provenance; synthetic demo instructions; and portability/model-exposure/restart/backend nonclaims.

Keep the conversational handoff approximately 700–1,000 words with details in the receipt, not giant raw logs. Do not create another commit solely to record the successful CI result of the last receipt commit. Stop for independent review and owner integration decision. Do not begin a successor.
