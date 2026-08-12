# Vercel DeepSeek V4 Flash diagnostic evidence

**Run date:** 2026-08-12  
**ContextDesk build:** `062d64e6c023010a20cd9865d4b641be7f368fd5`  
**Gateway/model:** the exact selected catalog model `deepseek/deepseek-v4-flash`  
**Diagnostic:** basic, 600-second whole-operation bound, protected-file credential reference  
**Run id:** `gwdx-1786523694157-63290` (owner-local artifact)

This is an operator-selected live observation, not a readiness badge. The
share-safe report and private raw capture remain under the owner-local
diagnostic archive; no provider body, endpoint, credential, or private path is
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
| Elapsed | 76,722 ms |
| Cleanup | 2 temporary corpora and 3 sessions removed; no failures |
| Cost/tokens | unknown; the gateway report did not include usage |

## Engineering interpretation

The direct native tool-call dialect is not currently compatible with this
gateway/model combination. The existing product workflow can still obtain a
grounded answer because its real search-tool path and host validation are
working. Therefore the honest routing decision is **product workflow usable,
direct native tool capability unqualified**. This evidence supports keeping
tool capability qualification separate from ordinary generation, structured
output, and product-path usefulness.

The run also supplies a regression target: a future diagnostic or qualification
change must not turn the direct `response_contract` failure into a model-wide
pass, and must preserve the independent product-workflow and usefulness
dimensions.

## Reproduction artifact locations

The owner-local share-safe `report.json`, `manifest.json`, JSONL trace, and
optional private capture are under the diagnostic archive selected for this
run, in a directory named `gwdx-1786523694157-63290`. The exact location is
intentionally not committed because it is machine-specific.

The cost/reliability ledger import for this bundle reports one run with
`gateway_model=fail`, `product_workflow=pass`, `answers_useful=pass`,
`requests=19`, median elapsed `76722 ms`, and unknown cost/tokens.
