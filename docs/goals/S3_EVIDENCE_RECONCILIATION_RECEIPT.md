# Goal 05 — S3 evidence reconciliation receipt

Status: locally qualified implementation; final publication is approval-blocked. Existing recovery draft PR [#1184](https://github.com/chriscase/ContextDesk/pull/1184).
This receipt does not claim a merge, GitHub approval, live AWS fault proof, or
completion of an external gate. Final exact-revision local results are recorded in
`S3_QUALIFICATION_EVIDENCE.md` and `S3_GATE_EVIDENCE.json`. Draft #1184 currently
contains only the recovery checkpoint; the final candidate/evidence are local.

## Recovery and identity

Repository `chriscase/ContextDesk`, owned branch
`integrate/s3-evidence-reconciliation-v2`. Base/merge base/observed main:
`c5de75d1e40a3de8ddfceda2ce3d216a5e19644d`, tree
`fc9d4a9cd46172cb6ed36ad3abcfa080e0d50d59`.
Exact frozen goal: `docs/goals/05-S3-EVIDENCE-RECONCILIATION.md`, SHA-256
`e9594c2b95774834c280130126c207fb2cfff14de923cf29744368de823a87f2`.
The original freeze commit `5152655c480a524130d1a280056ca9a74ecb9e7a`
preceded inherited production edits; history was preserved. See
[S3_EVIDENCE_RECONCILIATION_TAKEOVER.md](S3_EVIDENCE_RECONCILIATION_TAKEOVER.md)
for the private verified recovery backup, rescue ref, original dirty inventory
and deliberately partial recovery checkpoint. No synced project source changed.

Pinned main workflows were rechecked once: CI `36180382683`, collab
`36180382859`, collab-qualify `36180382576`: success, attempt 1, exact base.
The final branch and any generated test-merge identity belong in PR metadata;
this file need not contain its own future commit ID.

## Historical source disposition

All five GitHub heads were reverified against the immutable references. No
historical PR/branch was closed, rewritten, retargeted or marked superseded.
They are source references, not asserted ancestors of this branch/main.

| Source/head | Disposition |
|---|---|
| #1159 `db5f489bf4ddd8e96464c22e54912ee1fa34fa0d` | Adapted inherited sanitized canonical-commit classification and JSON/multipart mapping in `s3-store.ts`, `cases/routes.ts`, `evidence-stream.http.test.ts`. Rejected message-word/attempt-count inference as sufficient proof of dispatch. |
| #1166 `7bb4092d19ce4ee107150265eacc3b4c64d62345` | Applied-copy/response-loss concepts already overlap current store/provider tests. Adapted stronger actual-SDK and durable reopened SQLite/object proof and operator guidance. Its parent #1159 was not repeatedly imported. |
| #1168 `2e9d6856a8a5fb79f8cebcfb92d66ecc2e01af04` | Adapted target-presentation reconciliation via one shared primitive. Rejected editable live-control retry and resource-object/row-count readiness inference. Current discovery controls, privacy and canonical navigation preserved. |
| #1170 `2bfa811204440006710bf6d073206d5efe39f3be` | Selectively adapted multipart decoding, canonical retry comparison and target browser helpers into unused prefix 39. Added causal barriers, repeated uncertainty, direct handlers, scope/access, accessibility and joined SDK fault journey. No public idempotency key invented. |
| #1173 `53c614e4abcddccb56b2dfa24d765c50cc1d6f1a` | Reused only eventual empty-scratch assertion with existing transfer enforcement: `vi.waitFor` timeout 500 ms within the preserved 750 ms transfer bound. Local execution is macOS; fresh Windows evidence remains external. |

## Classification and retry boundary

Locked packages: S3 client/lib-storage 3.1121.0; Smithy core 3.33.3.
`sendSingleCanonicalCopy` witnesses handler invocation below SDK middleware,
uses a scoped one-attempt client, bounds CopyObject response consumption at
64 KiB and an idle deadline, and lets the installed SDK parse the complete
response. The normal read client is unchanged. The production opaque provider
exposes only the narrow canonical-copy capability. `AWS_MAX_ATTEMPTS=9` and
adaptive retry mode are exercised against explicit scoped configuration.

| Execution stage/event | Public result if verification cannot settle | Ownership/journal |
|---|---|---|
| Validation/configuration/credential failure confirmed before handler dispatch | Ordinary sanitized unavailable/input refusal | No dispatch inferred; ordinary existing cleanup |
| Complete parsed provider Error envelope, including embedded HTTP 200 Error | Ordinary `storage_unavailable` | No blanket absence claim; failed/unknown verification retains ownership conservatively |
| Ordinary provider double with statusless/unclassified error, dispatch unproven | Ordinary unavailable | Conservative retention distinct from public classification |
| Actual handler invoked, statusless error/transport response loss | `commit_outcome_unknown` | Retain pending and possible canonical bytes; a missing HEAD does not erase dispatch uncertainty |
| Truncated/empty/malformed successful-status response | `commit_outcome_unknown` | Retain; HTTP 200 is insufficient |
| Successful/uncertain copy followed by failed canonical verification | Unknown, or ordinary retained failure if only public dispatch proof is absent | Retain; never manufacture proven absence |
| Verified matching canonical bytes | Continue normal database transaction | Byte verification is not database commit; authoritative success envelope still required |
| Existing unknown database COMMIT | Existing exact unknown marker preserved | Existing transaction recovery ownership remains authoritative |
| Other S3 operation (stage/read/ping/cleanup) | Ordinary sanitized failure | Cannot gain canonical unknown marker from a stray flag/message |

AWS [CopyObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html)
and [retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)
explain the need to consume the body and pin retries; executable tests establish
this repository's supported boundary, not every S3-compatible provider.

## Acceptance ledger

The paths below are repository-relative. Final candidate execution results,
counts, repetitions, failures, skips and external limits are in
[S3_QUALIFICATION_EVIDENCE.md](S3_QUALIFICATION_EVIDENCE.md).

| Criterion | Implemented evidence and proof boundary |
|---|---|
| SER-01 | Exact freeze, owned recovered branch and pinned base preserved. Current presentations are adapted rather than replaced from old branches. `dependency-boundary.test.ts`, strategy/discovery/Activity Center and E2E 03/37/38 qualify compatibility. |
| SER-02 | `s3-store.ts`, `provider.ts`, `cases/routes.ts`; sanitized parity test “maps JSON and multipart promote ambiguity separately from ordinary S3 failure”; stage table above; provider/store and actual SDK fault suites. |
| SER-03 | `s3-copy-retry.test.ts`: actual installed serialization/retry stack through opaque production assembly; one counted CopyObject handler attempt for lost/truncated/empty/malformed/statusless/parsed retryable failures, bounded probes, pre-dispatch credentials zero copies, reads retain three attempts, no hidden replay. Not live AWS. |
| SER-04 | `s3-store.test.ts` plus file-backed SDK fixture: pending journal/bytes retained after unresolved applied copy and rollback; fresh provider objects and reopened SQLite recover with/without committed adoption. Cleanup-retry reloads reference sources under reacquired lease. Existing fail-closed health/reference and transaction tests retained. |
| SER-05 | Shared `evidence-upload-reconciliation.ts` freezes a metadata snapshot and one File before asynchronous work. Canonical preparation remains Runtime-owned. Hook test includes source ID/client time, original File and caller mutation; form handlers/browser compare original decoded multipart metadata and bytes despite disabled-control edits. No exactly-once metadata claim. |
| SER-06 | `use-active-investigation.ts`, Runtime provider, upload controller publish causal read generations. Refresh synchronously invalidates old read tokens. Stale/failure/unchanged/empty/immediate and repeated unknown cases are tested; retained rows do not satisfy a new barrier. |
| SER-07 | Synchronous busy guard, blocked unresolved form handler, explicit retry and local finish; handler/hook/browser tests exercise rapid double calls, direct submit, repeated unknown and no compensating DELETE. Inventory refresh never schedules another upload. |
| SER-08 | Complete presentation scope key and render-time epoch fencing conceal/drop intent before passive effects. Tests cover A-B-A, old captured callbacks/results, private authority, read-only, archived scope, unmount and initially denied zero reads/writes. Owner-only intent is never automatically broadened. |
| SER-09 | Provider/store, actual SDK-handler, real HTTP, Runtime/consumer, both HTTP-injected browser presentations, and one joined built-web/source-server/Runtime/service/store/SDK journey execute. Durable recovery pairing: SQLite plus on-disk synthetic object records. Joined domain metadata is disposable in-memory fixture. Garage/live AWS remain separate external qualifications. |
| SER-10 | New spec 39, one worker/no retries; delayed/failed reads, original draft, explicit refresh/retry, repeated unknown, ordinary 503, success, local finish/scope/privacy; keyboard/focus/status, 320px, forced colors and reduced motion. Existing 37/38 unchanged. Strategy policy restored; personal preference independently asserted unchanged. |
| SER-11 | Seven named mutations actually fail, source restored byte-for-byte, each named test passes. Reproducer `scripts/check_s3_reconciliation_mutations.py`; sanitized evidence `S3_MUTATION_EVIDENCE.json`. Final gates and timing repetition results are separately revision-bound. Missing Windows/Garage/root-hosted outcomes must remain explicit. |
| SER-12 | Operator Help, evidence review, handbook row/chapter, backlog and this receipt distinguish draft from shipped discovery/Activity Center. Committed final qualification evidence and independent review are locally reviewable; final remote publication is blocked pending explicit public-transfer approval. No successor launched. |

## Joined journey and narrow test-harness expansion

Necessary expansion recorded here: existing `e2e/src/serve-fixture.ts` exports
its application factory with optional private evidence-store injection and
reference-source notification. Default fixture behavior is unchanged. A private
public-method facade prevents the memory portable-apply test coordinator from
reflectively intercepting S3 private helper methods. No production fault
endpoint, provider setting or new authority path was introduced. The separate
MJS executable uses the same source server module graph as the existing fixture
(to preserve error class identity); the web assets are the production build.
The added Playwright config is included in E2E typechecking.

From `collab/` in a disposable checkout:

```sh
npm run build
S3_JOINED_CONTROL=$(mktemp -d)
COLLAB_S3_REPORT_DIR="$S3_JOINED_CONTROL" npm exec -w @cd-collab/e2e -- playwright test --config s3-joined.playwright.config.ts specs/39-s3-evidence-reconciliation.spec.ts --workers=1 --retries=0
```

Fault layer: the injected SDK request handler applies canonical CopyObject to
on-disk synthetic objects, loses its response and fails the bounded first
verification probes. Playwright observes/continues the real upload request;
it does not fulfill its 503. The real route returns the exact unknown marker;
no metadata row exists despite canonical bytes. Runtime refresh completes,
refresh causes zero additional upload, explicit retry has identical decoded
intent and reuses verified canonical bytes (still one copy). The real service
commits one authorized artifact/summary, existing reference-based recovery drops
the original pending journal without deleting adopted bytes, and authorized
artifact download matches the original file. A private filesystem control
request triggers recovery; no production HTTP control exists.

Ordinary browser qualification: `npm exec -w @cd-collab/e2e -- playwright test
specs/39-s3-evidence-reconciliation.spec.ts --workers=1 --retries=0` launches the
normal disposable fixture. The six presentation tests fulfill HTTP failures
and hold/fail inventory reads; they are UI/Runtime contract proof, not S3 proof.
The joined test is explicitly skipped outside its separate configuration.

## Limits and stop boundary

No production/private corpus, production bucket/database or paid model call was
used. Synthetic credentials never authorize a real endpoint. No live AWS fault
proof, Garage certification, global exactly-once artifact/summary writes,
cross-reload durable browser intent, new retention/migration scheduler, merge,
ready marking, historical closure or successor implementation is claimed.
The branch remains one draft for independent oversight. External pending or
missing gates are reported in the evidence record and handoff, not replaced
with inferred success or repeated unrelated work.


## Final ledger state

SER-01 through SER-08 and SER-10 are implemented and proven locally at functional
C `0959e1e3eab8a933ba80d9cc2c8a8b2af022267a` / tree
`07e03204db9702683708f8f5ce3b279faef4e050`, using the exact source/evidence paths
in the ledger above. SER-09 has the joined real-route/installed-SDK proof and
durable reopen proof; external live Garage/provider qualification is missing.
SER-11 has complete exact-C local gates, mutations and repetitions; fresh
final-head hosted/root/Windows evidence is missing. SER-12 documentation and
review are complete locally; final remote accessibility is blocked by automatic
approval review pending explicit publication approval. The current overall
handoff is PARTIAL solely as to that publication requirement and the named
external gates. Historical PRs and the frozen goal remain unchanged.


## Bounded client review closure after published bc423f92

This 2026-09-27 continuation supersedes the earlier local/publication-blocked ledger state for this correction without rewriting its historical evidence. Starting head `bc423f92a9a4fa95bc67bc0d6da6fd4276ac0e28` was published with explicit owner approval; the historical incidental temporary paths and that approval remain intact.

S3-IR-01 and S3-IR-02 are closed at functional C `54d5dba03fd6d1483f4dd85514b170c0b52af174` / tree `79c0ac98d8e79372408d0e44360c56185ee95a3a`. Actual keyed-form replacement now revokes old actions during layout cleanup. A single phase-aware notice retains ordinary failure through pending, failed and successful inventory reads without duplicate IDs, altered frozen intent or automatic writes. See [S3_CLIENT_REVIEW_CLOSURE.md](S3_CLIENT_REVIEW_CLOSURE.md) and [revision-bound command/result/review evidence](S3_CLIENT_REVIEW_EVIDENCE.json).

Exact-C local proof: twelve passing gates; 3865 unit tests passed with 115 existing environment skips; full Chromium 153 passed/9 configuration skips; twenty timing cycles 3260 passed; five normal Spec 39 runs 40 passed/5 joined-config skips; five joined runs passed. All eight named mutation families produce 38 intended failures with exact source restoration and passing selected positives. A separate same-model read-only review closes both findings; it ran no tests and submitted no GitHub approval.

SER-05/06/07/08/10/11 receive this additional client regression proof. Existing server/SDK/durable recovery proof remains tied to its original revisions and unchanged file hashes; the complete suites and joined journeys also run at C. Starting published-head CI/collab/collab-qualify are successful at logged generated merge `42580bb3e9cfc0bb21e9b29c6eb30b2148b2bd59`; starting Windows evidence-stream 18 tests passed. Fresh final-head hosted state belongs in PR metadata, not another receipt-only CI commit. Garage/live AWS remain external nonclaims.

One evidence-only follow-up publishes exactly this receipt append, closure Markdown and JSON. Final E identity is recorded in the existing draft PR and handoff. Frozen Goal 05 hash remains `e9594c2b95774834c280130126c207fb2cfff14de923cf29744368de823a87f2`. Private backups remain local; no merge, ready marking, closure or successor is authorized.
