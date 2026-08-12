# Exact-runtime Vercel diagnostic — `fcfdd30d`

**Run date:** 2026-08-12
**Source/build SHA:** `fcfdd30d1e52ee0fa379cce4682a79c51ce252c6`
**Release branch:** `integrate/triage-policy-sdk-v2-vercel-evidence-v1`
**Gateway:** Vercel AI Gateway
**Exact discovered model ID:** `deepseek/deepseek-v4-flash`
**Diagnostic run ID:** `gwdx-1786563263869-12955`
**Diagnostic depth:** basic; 600-second whole-operation bound; protected-file credentials

This is an owner-local live observation, not a readiness badge. The command ran
the production `contextdesk gateway diagnose` path from the exact detached
source build. The share-safe report, manifest, JSONL trace, discovery result,
and qualification state are retained outside the repository under the local
goal artifact for this run. No credential, header, endpoint, private path, or
raw provider body is committed here.

## Result

| Dimension | Result |
| --- | --- |
| Catalog discovery | pass; 324 exact catalog entries observed |
| Ordinary generation | pass |
| Structured JSON response | pass |
| Direct native tool-call contract | fail, typed `response_contract` |
| Product search-tool continuation | pass; grounded result |
| Selected-context path | pass; current fact cited and superseded decoy avoided |
| Known-truth linked-log triage | pass; typed host scorer passed |
| Product workflow verdict | pass |
| Answers-useful verdict | pass |
| Gateway/model compatibility verdict | fail (native tool contract remains unqualified) |
| Requests | 19 of 23 planned maximum |
| Elapsed | 76,070 ms |
| Deadline exceeded | no |
| Cleanup | 2 temporary corpora and 3 sessions removed; no failures |
| Cost/tokens | unknown; gateway report did not include usage |

The diagnostic process exits with the typed non-ready category because the
gateway-model compatibility verdict is `fail`; that is expected and honest for
this mixed-capability result, not a transport crash.

## Interpretation

DeepSeek V4 Flash is usable for the tested ContextDesk product workflow on
Vercel: ordinary generation, structured output, the real search-tool path,
selected context, and linked-log triage all completed and passed host-side
grounding/usefulness checks. The direct native tool-call continuation dialect
does not satisfy the observed response contract, so it must remain
unqualified. ContextDesk must not convert that one failure into a model-wide
failure or grant a native-tools badge.

This result is scoped to Vercel and this exact model ID. It does not establish
compatibility, latency, usefulness, embeddings, or reranking behavior for an
employer gateway. Those require the same diagnostic/qualification path against
that gateway.
