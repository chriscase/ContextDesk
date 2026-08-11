# Multi-model live validation and capture v1

Status: the provider-neutral contribution runtime is implemented on the exact
release evidence pin `c09357153e0c8953f2862c3cf3d8377ec9bc6bc7` from
`feat/multimodel-contribution-reconcile-v1`. The older production-code
integration tip `59df68fadc0d51a9d8cc245959c5f9f410a06eaa` is historical
evidence included in that pin, not a separate release identity. The live
validation procedure is
ready, but this worktree's configured protected-file reference is currently
missing, so no new gateway request was made in this phase.

## Purpose

Live traffic is used to learn wire and workflow behavior, not to grant a model
authority. Each run is one explicitly selected, exact catalog model through the
existing `gateway diagnose` command. The command reuses catalog discovery,
qualification, provider construction, the real chat/triage workflow, scoring,
deadline handling, and cleanup.

The recommended sequence is:

1. Discover the catalog without verification.
2. Select one exact returned model id; never shorten or infer it.
3. Run the basic diagnostic first. Use an explicit longer deadline for a known
   slow model rather than relying on a hidden safety cap.
4. Run `extended` only when the basic run exposes a meaningful stability
   question.
5. Compare deterministic-only, bounded contributions, and the ordinary
   single/reviewer path on the same host packet; do not compare unlike corpora
   or silently switch providers.

The live command is intentionally bounded and requires explicit consent. An
owner may opt into the separate local capture with `--raw
--raw-i-understand`. This does not change the share-safe report.

## Minimal reproducible invocation

Use an isolated data directory and an existing app-config file that already
contains the protected-file credential reference. The discovery response is
the authority for every model id used afterward:

```text
contextdesk --data-dir <isolated-data> --app-config <app-config> \
  --profile <profile> --format json models discover
```

After choosing one exact returned id, run one targeted qualification/diagnostic
at a time. Do not use `--verify-all` or `models verify --all` for a first pass:

```text
contextdesk --data-dir <isolated-data> --app-config <app-config> \
  --profile <profile> --model <exact-returned-id> --format jsonl \
  gateway diagnose --yes --level basic --timeout 600 \
  --raw --raw-i-understand --out <diagnostic-output>
```

The output directory contains the share-safe bundle and, only when explicitly
requested, a separate owner-only capture index plus bounded exchange files.
Keep those owner-only files local; upload only the share-safe report and
manifest when requesting help.

To exercise the multi-model path after qualification, configure
`AppConfig.contributions` with explicit role/profile/model assignments, set its
`enabled` flag, or pass `--mode contributions` for one CLI turn. The resolver
still requires current `validated_structured_proposal` evidence for every
role and applies the existing remote-egress acknowledgment. Missing or stale
evidence produces a deterministic-floor result rather than a provider call.

Optional reviewer, contribution, and fast-triage backends inherit the resolved
turn's transport timeout. An explicit `--deadline`/router deadline of 600
seconds therefore reaches the HTTP client instead of being cut off by the
standalone 120-second backend default. The shared helper is covered by the
workflow provider tests; the host deadline and cancellation races remain the
authoritative stop conditions.

## Capture contract

The default artifact contains pseudonymous identity, endpoint fingerprints,
case outcomes, request counts, timing, failure categories, cleanup status, and
typed usefulness verdicts. It must not contain credentials, authorization
headers, endpoint URLs, private paths, or provider bodies.

The explicit owner-only capture contains files with schema
`contextdesk.gateway_diagnostic_provider_exchange.v1`. Each file is produced
from the existing `RecordingTurnTrace`/`TracingChatBackend` seam and contains
bounded, redacted provider-exchange events from the real product path:

- request messages after the existing redaction/bounds boundary;
- offered tool names;
- response content/tool calls after the same boundary;
- finish/status and provider telemetry;
- model/profile labels and the synthetic diagnostic question;
- an explicit count when the developer-detail cap dropped events.

Cancellation and timeout paths deliberately omit request/response bodies. The
capture directory is owner-permissioned and is never referenced by the
share-safe report or manifest. Raw captures must not be committed.

## Promoting a live observation into tests

Only stable, provider-neutral facts may become committed fixtures:

1. Remove credentials, headers, endpoint text, private paths, timestamps that
   are not part of the contract, and model prose that is not needed to test a
   parser or scorer.
2. Keep the exact route shape, status classification, content/stream framing,
   tool-call continuation shape, structured-output behavior, usage-field
   presence, and bounded failure category.
3. Convert the observation into a fixture under
   `fixtures/gateway-contracts/v1/` or the appropriate quality-evaluation
   suite, with a hermetic test that proves the expected behavior.
4. Record provenance in the test documentation as an observed wire fact for a
   specific gateway/model/run, never as a universal model capability claim.

Existing fixture suites already cover the earlier Vercel observations for
chat, streaming, tool continuation, embeddings, and reranking. The current
model comparison documents are historical evidence and remain scoped to their
exact route/model/release.

## Current live blocker and safety boundary

The active local profile names a protected credential file that is not present
in this worktree. No key was reconstructed from conversation history and no
Keychain fallback was attempted. Restoring the protected file is sufficient to
resume the exact procedure; no code change or credential architecture change
is required.

Employer gateways remain a separate acceptance step. They require an explicit
owner-authorized profile and endpoint, use only synthetic or owner-approved
data, and must not inherit Vercel model or usefulness evidence.

## Integrated wire-contract evidence

The production-code integration head for this validation record is the exact
release evidence pin `c09357153e0c8953f2862c3cf3d8377ec9bc6bc7`; the release
manager should still verify the checked-out branch tip independently.
It includes the dialect-honest OpenAI-compatible chat qualification ladder,
the production OpenAI-compatible embedding adapter, and explicit TEI/Cohere
reranking with shared fail-closed parsers. The hermetic evidence at this head
includes:

- chat contract v4: 18 focused contract tests plus 5 qualification-wire tests;
- production embedding: 7 adapter tests;
- production reranking: 4 dialect tests and 12 real-wire tests;
- production retrieval path: 5 factory/ablation/share-safe tests;
- production retrieval diagnostic path: 20 production-factory and identity
  reconciliation tests;
- OpenAI-compatible embedding spaces publish the measured endpoint/model/dialect
  identity used by the diagnostic, so stored vectors cannot be mislabeled as
  `unclassified`;
- existing gateway diagnostic contract: 18 CLI tests;
- historical exact-head release gate record: `FULL_GATE_PASS` with
  embedded-SHA identity, cancellation, activity/trace parity, grounded
  two-turn flow, and recovery. It is not a current full-gate verdict. The
  current exact-pin native desktop sub-gate passes 189 tests after adding
  explicit default fields to two test-only `RetrievalRoleModel` fixtures;
  the complete exact-head gate remains to be rerun.

The full workspace matrix, desktop native check, frontend typecheck/lint/
Vitest/build, and the exact-head gate all pass at this head. Frontend lint
retains nine pre-existing React-hook warnings but no errors; they are not
introduced by the retrieval identity fix.

These tests are derived from observed gateway shapes but remain provider-neutral:
they prove request/response contracts and host behavior, not that a model is
universally compatible or useful. Any future live observation should be
promoted through the capture rules above and added to the smallest relevant
hermetic wire or quality suite.
