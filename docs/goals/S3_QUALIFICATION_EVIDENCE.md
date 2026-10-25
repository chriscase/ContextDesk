# S3 qualification evidence

The original recovery checkpoint is published in draft #1184. The final functional
candidate is locally complete; its public transfer remains approval-blocked. This file records
prior failures honestly; an evidence-only follow-up records final C SHA/tree,
commands/counts, repetitions, review and CI identities. No pre-candidate dirty
test run is presented as an exact-C acceptance run.

Development environment: macOS arm64, Node 25.2.1, npm 11.6.2, Vitest 3.2.7,
installed Playwright Chromium. Synthetic fixtures only. Local tests use zero
retries unless explicitly stated. Hosted CI is separate.

## Preserved development failures and repairs

- Inherited focused server/SDK/HTTP checkpoint: 3 files, 132 tests passed.
- First broad candidate check: contracts 872 passed; server 1299 passed,
  115 environmentally skipped; web 9 failures/1638 passed. The dependency guard
  caught forbidden direct shared Runtime imports; the form now receives typed
  presentation props through the public shared index, with the guard unchanged.
  Existing upload-label/placeholder compatibility and keyed-private-draft tests
  were reconciled with the new workflow; scope tests query replacement controls,
  retaining their assertions instead of examining detached nodes.
- Initial new browser debugging failed on an exact label locator and then on an
  unsupported attempt to restore a null preference. Fixed locators use roles;
  tests do not change personal preference, assert it remains unchanged, and
  independently restore administrator policy. Six UI/Runtime journeys then
  passed; joined test intentionally skipped in normal configuration.
- Initial joined fixture failed because the generic memory portable-apply
  fixture reflected private S3 methods. The private test facade limits wrapping
  to the public EvidenceStore methods. A second iteration returned ordinary
  unavailable because built/source server modules had distinct error-class
  identity. The executable now uses one source server graph with production
  built web assets. The joined test then passed (1 test, no retries).
- Early SDK assertion compared Uint8Array and Buffer by identity; corrected to
  byte equality. New final focused store/SDK proof: 2 files, 126 tests passed;
  13 actual-SDK cases. Shared handler/hook proof: 2 files, 18 tests passed.
- Docker engine availability probe stalled and was stopped only after verifying
  its task-owned PID. Disposable Garage qualification was not executed; no
  live/provider compatibility success is inferred. Local Postgres/LDAP and
  other environment-dependent tests retain their explicit skips.
- Seven development mutations produced 8 intended assertion failures (durable
  reopen has two cases), each named restored test passed; the reproducer
  restores exact original source bytes. Final C rerun is recorded separately.

No raw recovery archive, private database, credentials, signed URL or production
endpoint is published. Failure summaries above are sanitized. The initial
review is in [S3_INDEPENDENT_REVIEW.md](S3_INDEPENDENT_REVIEW.md).

## First committed candidate review checkpoint

Candidate `b38e5973b74ae5a884a6957d801c184bbd050440` / tree
`69940c298b113b7b4c531da7bbd62bf81ad64bb0` passed collaboration typecheck,
lint, contract/server/web tests (web 1651), production build, E2E typecheck,
dependency boundary, fixture privacy, Help drift, claims regression tests,
scenario matrix and diff. `check_claims.sh` failed because new Help prose used
ordinary Markdown links that HelpMarkdown renders literally; corrected to
supported Help locators/plain repository references. The independent review
found three client issues recorded in `S3_INDEPENDENT_REVIEW.md`; all required
functional repairs and additional regressions are committed before the final
qualification candidate. Final exact-revision gates are rerun on that candidate.

Publication was automatically rejected: reviewer considered the visible user
request authorization to read the objective, not public transfer of code/docs.
Read-only checks confirmed public `chriscase/ContextDesk`, signed-in ADMIN access,
and owner-authored draft #1184 on the exact branch. A proof-backed retry was
still rejected. Explicit publication approval was requested while local work
continued. No alternate transfer route or indirect bypass was used.

## Final exact-revision local qualification

Functional C: `0959e1e3eab8a933ba80d9cc2c8a8b2af022267a`; tree
`07e03204db9702683708f8f5ce3b279faef4e050`. All final runs below executed
at clean C, before this evidence-only follow-up. Exact commands, working
directories, exit statuses, environment, browser skip annotations and repeated
run counts are committed in [S3_GATE_EVIDENCE.json](S3_GATE_EVIDENCE.json).
Temporary output destinations are labeled `<temporary-json>` or
`<temporary-browser-results>`; no private scratch paths/raw logs are uploaded.

- All 12 gates exited zero: production build; collaboration typecheck/lint/tests;
  E2E typecheck; dependency boundary; fixture privacy; Help drift; claims regression
  tests and claims; scenario matrix; base-to-C diff. Contract tests: 65 files/872
  passed. Server: 139 files/1302 passed, 11 files/115 environment-dependent skips.
  Web: 104 files/1655 passed. Total: 3829 passed, 115 skipped.
- Full Chromium E2E: 151 passed, 9 explicitly skipped, 0 failed/flaky; one worker,
  zero retries. Existing specs 03/27/37/38 and other applicable regressions are
  preserved and pass. Skip names/reasons are recorded in the JSON; they include
  unconfigured live profiles/bridge/persistence and joined configuration.
- Twenty consecutive timing runs: each server set 31 passed and web set 96
  passed, all exits zero: 2540 passes, zero failures/skips.
- Five consecutive normal spec-39 runs: 6 passed each, the joined case explicitly
  skipped outside its configuration. Five consecutive joined SDK-fault runs:
  1 passed each. One worker, zero retries; 35 total passes, 5 configuration skips.
- All seven mutations failed their intended named assertions (8 negative tests),
  with exact source restored and all named positive tests passing afterward.
  [S3_MUTATION_EVIDENCE.json](S3_MUTATION_EVIDENCE.json) records exact C, source
  hashes, commands, statuses/counts and sanitized assertion output. No mutant
  remains in C or this evidence commit.
- Existing offline `qualify-s3-evidence.mjs --self-check`: exit 0, 14 passed,
  15 intentionally unselected/skipped. This validates compose/toml/gates and
  is explicitly not live Garage certification.

## Candidate repair chronology

The post-review candidate `95c28dde31660fe882232f189aa9763c4ae28082` initially
failed build on two DOM type annotations in the new strategy test. Corrected in
`09656fb7f8f04a34e6e06451318badbab057d70a`. That candidate passed all 12 gates,
mutations, 20 focused repetitions and five normal/joined repetitions, but its
completed full browser run had 149 passed, 2 failed, 9 skipped. Both failures
were in unchanged spec 27: the original Investigation First Annotation label
and upload-grid responsive class had been lost in the shared form integration.
The run completed (it was not aborted). Final C restores those contracts and
Beacon's original labels/grid field classes; test selectors follow the restored
labels without weakening assertions. Final C repeated the entire required local
qualification above; the previous failure remains visible here.

## Published revision and external gates

Draft #1184 currently publishes only recovery checkpoint
`c70bb9e3f6c2ed583e79528ba347ae8d402dd89f`, tree
`765eaf20b173a770fbb9b433d9ad4c2bc7e62155`. Final C and the documentation-only
follow-up are local while explicit public-transfer approval remains pending.
This is `PARTIAL` publication, not a remotely reviewable final candidate.

Old checkpoint CI `36259719056` passed, attempt 1. Its actual generated merge
checkout was `583544f0a8accbbf10c54ced72dedc775157f80b`, tree
`765eaf20b173a770fbb9b433d9ad4c2bc7e62155`, parents base
`c5de75d1e40a3de8ddfceda2ce3d216a5e19644d` and checkpoint
`c70bb9e3f6c2ed583e79528ba347ae8d402dd89f`. This is neither final C nor branch
head. Root/Rust/Tauri jobs passed on that older checkpoint; root code is unchanged,
but fresh final-head hosted checks remain missing. Old collab `36259719211` and
collab-qualify `36259719144` failed (attempt 1), as did push runs `36259630872`
and `36259630906`. Their inherited dangling `setPrivacyClass` and inferred
mock-type errors are repaired; new local exact-C typechecks/build pass.
Windows stopped before evidence-stream execution, so no final Windows transport
qualification is claimed. Docker/Garage unavailable; no live AWS was invoked.
No final-C hosted/test-merge workflow is claimed before publication.

The only C-to-follow-up delta is five `docs/goals/` receipt/evidence/review files,
listed in the JSON. Product, tests, fixtures, configurations and dependencies
remain byte-identical to tested C. Future head/tree and workflow IDs belong in
PR metadata/handoff, without a further receipt commit solely for CI IDs.
