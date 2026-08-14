# Vercel DeepSeek V4 Flash diagnostic evidence — release candidate

**Run date:** 2026-08-12  
**ContextDesk build:** `188e20a9ff35` (`integrate/triage-policy-sdk-v2`)  
**Gateway/model:** exact discovered catalog id `deepseek/deepseek-v4-flash`  
**Diagnostic:** basic, 600-second whole-operation bound, protected-file credential reference  
**Run id:** `gwdx-1786529766573-55317` (owner-local artifact)

This is an operator-selected live observation, not a readiness badge. The
share-safe report, manifest, JSONL trace, and private provider exchange files
remain owner-local; no provider body, endpoint, credential, or private path is
committed here.

## Observed result

| Dimension | Result |
| --- | --- |
| Ordinary generation | pass |
| Structured JSON response | pass |
| Direct native tool-call probe | fail, `response_contract` |
| Product tool + continuation path | pass; grounded search result |
| Selected-context attachment path | pass; current fact cited and superseded decoy avoided |
| Product linked-log triage | pass; known-truth scorer passed |
| Product workflow verdict | pass |
| Answers-useful verdict | pass |
| Gateway-model compatibility verdict | fail |
| Requests | 19 of 23 planned maximum |
| Elapsed | 63,012 ms |
| Cleanup | 2 temporary corpora and 3 sessions removed; no failures |
| Cost/tokens | unknown; the gateway report did not include usage |

## Engineering interpretation

This run repeats the earlier observation on the final candidate: the direct
native tool-call continuation contract is not currently compatible with this
gateway/model combination, but the production workflow can still execute its
real search tool and produce a grounded result. The host therefore keeps tool
qualification separate from product-path usefulness. A routing decision may
use the product path only when its exact workflow evidence is current; it must
not promote the direct tool failure to a model-wide failure or claim native
tool readiness.

The linked-log triage used the real production packet, multi-stage turn, typed
host scorer, and cleanup seams. The stable provider-neutral behavior is already
covered by the hermetic gateway diagnostic and triage-policy tests; the live
run supplies provenance for the separation above rather than a new universal
model claim.

The persisted share-safe report records `private_capture_written=true`, matching
the terminal result. That artifact-ordering invariant is covered by
`crates/cd-cli/tests/gateway_diagnose.rs`.

