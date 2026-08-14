# Vercel DeepSeek V4 Flash diagnostic evidence — final Policy V2 runtime

**Run date:** 2026-08-12  
**ContextDesk build:** `01ba43feed9d2e218aa2f23734f9021e6de85022`  
**Gateway/model:** exact selected catalog id `deepseek/deepseek-v4-flash`  
**Diagnostic:** basic, 600-second whole-operation bound, protected-file credential reference  
**Run id:** `gwdx-1786534432753-18657` (owner-local artifact)

This is an operator-selected live observation, not a readiness badge. The
share-safe report, manifest, JSONL trace, and private provider exchange files
remain owner-local; no provider body, endpoint, credential, or private path is
committed here.

## Observed result

| Dimension | Result |
| --- | --- |
| Ordinary generation | pass; direct 1,698 ms, product 1,742 ms |
| Structured JSON response | pass; direct 1,945 ms, product 1,365 ms |
| Direct native tool-call probe | fail, `response_contract` (4,525 ms) |
| Product tool + continuation path | pass; real search tool and grounded result (7,941 ms) |
| Selected-context attachment path | pass; current fact cited and superseded decoy avoided (2,753 ms) |
| Product linked-log triage | pass; known-truth scorer passed (45,990 ms) |
| Product workflow verdict | pass |
| Answers-useful verdict | pass |
| Gateway-model compatibility verdict | fail |
| Requests | 19 of 23 planned maximum |
| Elapsed | 78,634 ms |
| Cleanup | 2 temporary corpora and 3 sessions removed; no failures |
| Cost/tokens | unknown; the gateway report did not include usage |

## Engineering interpretation

The final runtime reproduces the useful split seen in earlier bounded Vercel
runs: this gateway/model does not satisfy the direct native tool-call response
contract, but the real ContextDesk product path can execute its search tool and
produce a grounded answer. The host therefore keeps native-tool qualification,
product-workflow compatibility, and answer usefulness as separate verdicts.

The linked-log triage completed through the production workflow and passed the
typed known-truth scorer. This is evidence that the final Policy V2 runtime can
produce a useful synthetic triage answer on this gateway; it is not evidence of
employer-gateway compatibility, universal model capability, or a native-tool
verified badge.

The persisted share-safe report recorded `private_capture_written=true`. The
artifact-ordering and cleanup invariants remain covered by hermetic tests.
