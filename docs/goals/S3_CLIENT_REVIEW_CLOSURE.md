# S3 client review closure — S3-IR-01 and S3-IR-02

Final tested functional C: `54d5dba03fd6d1483f4dd85514b170c0b52af174`, tree `79c0ac98d8e79372408d0e44360c56185ee95a3a`.
Starting published head: `bc423f92a9a4fa95bc67bc0d6da6fd4276ac0e28`, tree `5e2feaaf8350ba21e197d094c79c6f05a6687856`.
Base / merge base: `c5de75d1e40a3de8ddfceda2ce3d216a5e19644d`. Frozen Goal 05 SHA-256 remains `e9594c2b95774834c280130126c207fb2cfff14de923cf29744368de823a87f2`.

This is a bounded functional correction on existing draft PR #1184. It changes two shared client production files, their actual-composition regressions, Spec 39 and a reversible mutation reproducer. Server, installed SDK, production Runtime, dependencies, workflows, joined fixture, discovery and Activity Center implementation remain unchanged. Exact commands, results, versions, skip reasons, source hashes and separate-review record are in [S3_CLIENT_REVIEW_EVIDENCE.json](S3_CLIENT_REVIEW_EVIDENCE.json).

## S3-IR-01: actual keyed form lifecycle

The wrapper keys `ScopedEvidenceUploadForm`, which owns the recovery hook. On replacement, the old hook does not receive the new scope; passive unmount cleanup allowed captured actions during replacement layout. The first actual-wrapper/notice regressions produced 22 intended failures. The later real Runtime causal run produced ten stale-action failures and two passing already-dispatched-result cases.

A test-only observation seam wraps the real hook, returning its real state/actions unchanged. The persistent host invokes captured actions only during replacement layout, with a witness proving passive cleanup has not run. Both consumers cover case B, upload/private/read authority loss, removal, retry/refresh actions and A-B-A. No action is invoked from render or through detached-node dispatch, and no fake recovery state machine is used.

The real Runtime/controller/HTTP gateway tests separate action invocation, command invocation, fetch-boundary request and eventual publication. Before repair, every stale action reached the upload command. Runtime independently refused requests for read/upload revocation. B/private revocation reached one additional fetch request but suppressed the eventual result; removal with the provider retained reached one request and one eventual publication. These are synthetic fetch-stub observations, **not proof of a live unauthorized server/storage write**.

The smallest repair moves unmount revocation from passive cleanup to layout cleanup. It marks the old epoch dead and clears the held intent/File before replacement layout actions. The keying and same-scope draft behavior stay intact. After repair, all ten stale-action Runtime cases invoke the captured action once and reach zero additional commands, requests or publications. Already-dispatched legitimate requests still suppress obsolete results.

At exact C, temporarily replacing layout cleanup with passive cleanup causes all 30 selected lifecycle/Runtime assertions to fail. Restoring exact source bytes passes all 30; six other tests are unselected. The seven original mutations produce eight intended failures and restored passes. No mutant is committed.

## S3-IR-02: one notice across recovery phases

Unknown upload → qualifying inventory read → explicit original retry → ordinary storage-unavailable failure rendered two paragraphs with one ID/ref. The initial notice regressions reproduced this in both consumers. A separate review of first candidate `1e6554f9ee1a9b094d4f3d3ebbfe3e3740fdbacd` then found a remaining path: retained ordinary failure followed by inventory refresh reintroduced the duplicate. Four extended explicit/external-refresh regressions failed against that candidate before the final repair.

One phase-aware paragraph now owns the recovery ID/ref. It combines retained ordinary failure with the current pending/failed/review/success description and uses an alert for the relevant failure. Unit and both browser journeys check unique IDs, focused notice, file/summary descriptions, frozen File/metadata/privacy and explicit same-intent retry through pending → failed → pending → successful reads. Refresh issues no automatic upload or compensating DELETE. No recovery state is erased and owner-only intent is not broadened.

## Exact-C qualification

- Twelve local gates: all exit 0. Contract 872, server 1302, web 1691: **3865 passed**, **115 existing environment-dependent server skips**.
- Full Chromium: **153 passed, 9 explicit configuration skips, 0 failed/flaky**; one worker, retries disabled. Includes existing specs 03/27/37/38 and extended Spec 39. Skip reasons are retained in JSON.
- Twenty consecutive timing cycles: 31 server + 132 web each, **3260 passed**, zero failed/skipped.
- Five consecutive normal Spec 39 runs: **40 passed**, five joined-configuration skips. Five separate joined installed-SDK fault journeys: **5 passed**. One worker, no retries.
- Thirty new lifecycle mutation failures plus eight existing mutation failures are deliberate negative proof; all named restored positives pass. Final new file contains 36 passing regressions.
- Separate fresh same-model source review inspected exact C/tree read-only, ran no tests and submitted no GitHub approval. Both findings closed; no new blocking findings within this scope.

The JSON lists actual commands with repository-relative working directories. Temporary output destination arguments alone are replaced with `<temporary-json>` / `<temporary-browser-results>`; raw local logs and stacks stay local. Earlier setup failures and the first candidate's interrupted qualification are retained with their limits. Final C, not that first candidate, owns the completed qualification.

## Preserved server and hosted evidence

The original Goal 05 evidence retains its original tested functional SHA/tree; it is not relabeled as this correction. A git-blob/SHA-256 manifest verifies unchanged server/store/SDK/Runtime/joined-fixture source between starting published head and C. Final C also reexecutes the full collaboration suites, existing mutations, timing tests and joined journeys.

Starting-head hosted runs are now all successful, attempt 1: [CI 36270084912](https://github.com/chriscase/ContextDesk/actions/runs/36270084912), [collab 36270084894](https://github.com/chriscase/ContextDesk/actions/runs/36270084894), [collab-qualify 36270084944](https://github.com/chriscase/ContextDesk/actions/runs/36270084944). Completed checkout logs prove generated merge `42580bb3e9cfc0bb21e9b29c6eb30b2148b2bd59`, tree `5e2feaaf8350ba21e197d094c79c6f05a6687856`, parents main plus starting head. Starting Windows job `108482251201` passed 18 evidence-stream HTTP tests at that checkout. Those source/test bytes are unchanged. This is reused starting-head proof for untouched code, **not final-head hosted success**. Fresh workflow IDs/actual checkouts are reported in PR metadata after publication.

## Publication and limits

One evidence-only E follows C solely to publish this closure, its JSON and a narrow receipt append. C-to-E changes exactly those three Markdown/JSON files. No fixture/test/configuration/dependency/production change is described as evidence-only. E's own future SHA/tree and fresh hosted results are recorded externally in the PR/handoff; no recursive evidence commit is needed.

Handbook impact: none — these client corrections enforce existing documented scope fencing, frozen retry intent and notice accessibility guarantees. The frozen owner goal and historical publication approvals, including the approved incidental temporary paths, are unchanged. Private recovery archives remain local.

No live AWS fault proof, live Garage certification, global exactly-once metadata guarantee, durable cross-reload intent, private/production data use, merge, ready transition, historical closure, release or successor goal is claimed. The draft remains open for independent review.
