# S3 qualification evidence

The functional candidate is being published to draft #1184. This file records
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
