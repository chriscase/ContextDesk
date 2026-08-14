# Vercel DeepSeek V4 Flash diagnostic evidence — TimelineAnalyst release

**Run date:** 2026-08-12  
**ContextDesk build:** `601964deee2f3bffc675ed398514e0a7d24a197c`
**Gateway/model:** exact discovered catalog id `deepseek/deepseek-v4-flash`
**Diagnostic:** basic, 600-second whole-operation bound, protected-file credential reference
**Run id:** `gwdx-1786531919778-86198` (owner-local artifact)

This is an operator-selected live observation, not a readiness badge. The
share-safe report, manifest, JSONL trace, and private provider exchange files
remain owner-local; no provider body, endpoint, credential, or private path is
committed here.

## Observed result

| Dimension | Result |
| --- | --- |
| Ordinary generation | pass; direct 1,407 ms, product 1,525 ms |
| Structured JSON response | pass; direct 1,576 ms, product 1,305 ms |
| Direct native tool-call probe | fail, `response_contract` (3,911 ms) |
| Product tool + continuation path | pass; real search tool and grounded result (4,809 ms) |
| Selected-context attachment path | pass; current fact cited and superseded decoy avoided (1,973 ms) |
| Product linked-log triage | pass; known-truth scorer passed |
| Product workflow verdict | pass |
| Answers-useful verdict | pass |
| Gateway-model compatibility verdict | fail |
| Requests | 19 of 23 planned maximum |
| Elapsed | 64,390 ms |
| Cleanup | 2 temporary corpora and 3 sessions removed; no failures |
| Cost/tokens | unknown; the gateway report did not include usage |

## Engineering interpretation

This exact-build run reproduces the stable separation already seen on the
earlier Vercel run: the direct native tool-call continuation contract is not
compatible with this gateway/model combination, while the real ContextDesk
product workflow can execute its search tool and produce a grounded answer.
The linked-log triage completed through the product path and passed the typed
known-truth scorer. The host therefore keeps native-tool qualification,
product-workflow compatibility, and answer usefulness as separate verdicts.

The TimelineAnalyst code change did not alter the diagnostic protocol or its
selected model; this run verifies the final release binary identity and the
same production diagnostic path after that runtime change. It does not claim
employer-gateway compatibility, universal model capability, or a verified
native-tool badge.

The persisted share-safe report recorded `private_capture_written=true`; the
artifact-ordering invariant remains covered by the hermetic diagnostic tests.
