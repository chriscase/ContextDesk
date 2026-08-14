# Vercel DeepSeek V4 Flash diagnostic evidence — cancellation-hardened runtime

**Run date:** 2026-08-12  
**ContextDesk build:** `a3a5263e408c8c1cd3030f470be690e334f1adad`  
**Gateway/model:** exact selected catalog id `deepseek/deepseek-v4-flash`  
**Diagnostic:** basic, 600-second whole-operation bound, protected-file credential reference  
**Run id:** `gwdx-1786548077356-84867` (owner-local artifact)

This is an operator-selected live observation, not a readiness badge. The
share-safe report, manifest, JSONL trace, and private provider exchange files
remain owner-local; no provider body, endpoint, credential, or private path is
committed here.

## Observed result

| Dimension | Result |
| --- | --- |
| Ordinary generation | pass; direct 2,218 ms, product 2,542 ms |
| Structured JSON response | pass; direct 2,078 ms, product 1,540 ms |
| Direct native tool-call probe | fail, `response_contract` (6,425 ms) |
| Product tool + continuation path | pass; real search tool and grounded result (7,695 ms) |
| Selected-context attachment path | pass; current fact cited and superseded decoy avoided (2,360 ms) |
| Product linked-log triage | pass; known-truth scorer passed (44,174 ms) |
| Product workflow verdict | pass |
| Answers-useful verdict | pass |
| Gateway-model compatibility verdict | fail |
| Requests | 19 of 23 planned maximum |
| Elapsed | 84,623 ms |
| Cleanup | 2 temporary corpora and 3 sessions removed; no failures |
| Cost/tokens | unknown; the gateway report did not include usage |

## Engineering interpretation

The cancellation-hardened runtime preserves the established split: this
gateway/model does not satisfy the direct native tool-call response contract,
but the real ContextDesk product path executes its search tool and produces a
grounded answer. Native-tool qualification, product-workflow compatibility,
and answer usefulness remain separate verdicts.

The linked-log triage completed through the production workflow and passed the
typed known-truth scorer. This supports a useful synthetic triage result on
Vercel for this exact runtime; it does not establish employer-gateway
compatibility, universal model capability, or a native-tool verified badge.

The persisted share-safe report recorded `private_capture_written=true`; all
temporary corpora and sessions were removed without cleanup failures.
