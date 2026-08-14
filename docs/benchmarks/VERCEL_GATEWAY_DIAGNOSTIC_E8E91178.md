# Vercel gateway diagnostic — DeepSeek V4 Flash — `e8e91178`

> Historical baseline. The corrected release-line rerun is documented in
> [`VERCEL_GATEWAY_DIAGNOSTIC_749E8339.md`](./VERCEL_GATEWAY_DIAGNOSTIC_749E8339.md)
> and passes typed linked-log triage. The failure below remains valuable as a
> record of the pre-fix behavior, but is not the current Vercel verdict.

**Run date:** 2026-08-10  
**Source build:** `e8e91178`  
**Selected model:** exact discovered ID `deepseek/deepseek-v4-flash`  
**Diagnostic level:** `basic`  
**Whole-run ceiling:** 600 seconds  
**Requests:** 15 used of 23 planned maximum

The run used the existing `gateway diagnose` production workflow and the
owner-only protected-file credential reference. It did not use Keychain, did
not write a private raw capture, and did not touch an existing corpus. Cleanup
removed all two temporary corpora and all three temporary sessions; cleanup
reported no failures.

The share-safe bundle is retained locally at:

```text
/private/tmp/contextdesk-gateway-diagnostic-e8-live-out/gwdx-1786384201439-70741/
```

| Artifact | SHA-256 |
| --- | --- |
| `report.json` | `dc1a7da097e8f42b89706df4efd671670ec871fcd91943298392c0efc0a3d307` |
| `manifest.json` | `c235a06291287d019254bc74d0b4399dd97433f851049f7caaf49265683fbbf0` |
| JSONL activity stream | `a61aa23e6ff2f429ca492a84e4f293ed673b022f7760e4626d7208bac3bedfe7` |

## Case results

| Case | Product-path result | Classification |
| --- | --- | --- |
| Ordinary generation | Passed; 1,655 ms; 1 request | Compatible |
| Structured response | Passed; 1,846 ms; 1 request | Compatible |
| Tool call + continuation | Passed grounded tool execution; 4,784 ms; 2 requests | Retry required by diagnostic policy |
| Selected context | Passed scorer; 1,477 ms; 1 request | Compatible |
| Linked-log multi-stage triage | Failed closed as `response_contract`; 23,615 ms; 4 requests | Product-integration likely |

The direct gateway probes passed ordinary generation, strict structured JSON,
and native tool-call/continuation handling. The terminal verdict was:

```text
gateway_model_status: pass
product_workflow_status: fail
answers_useful_status: fail
```

## Interpretation

DeepSeek V4 Flash is protocol-compatible with the Vercel gateway and works for
ordinary, structured, selected-context, and direct inert-tool probes. This run
does **not** establish successful multi-stage triage: the linked-log path
returned a provider-neutral response-contract failure before a validated answer
could be scored. It therefore must not receive a “useful triage” or “ready” badge
yet.

The failure is actionable rather than a generic timeout. The next investigation
should inspect the local share-safe trace and the host’s response-contract
handling for the linked multi-stage path, while preserving the exact model ID,
600-second allowance, and one-request-per-round accounting. Do not rerun a live
matrix until that contract failure is understood; hermetic reproduction should
come first.

### Follow-up observability refinement

The original share-safe report intentionally reduced this shape to the broad
`response_contract` category. A host-only sanitizer refinement now recognizes
the observed `no visible terminal answer` shape as
`empty_terminal_answer`; it still strips provider bodies and transcript text.
This improves the next diagnostic's explanation without changing the recorded
run, its verdict, or the conclusion that linked triage remains unproven.

The current release line also records only the bounded character count of
known reasoning/analysis channels (`reasoning_content_chars`) in transport
telemetry. Reasoning text is never retained, rendered as the answer, or
included in share-safe artifacts. This makes a DeepSeek-style separated
reasoning channel diagnosable while keeping the visible-answer contract strict.
