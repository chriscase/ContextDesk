# Vercel gateway diagnostic — DeepSeek V4 Flash — `749e8339`

**Run date:** 2026-08-10  
**Source build:** `749e83391d8e`  
**Gateway:** Vercel AI Gateway, protected file credential reference  
**Selected model:** exact discovered ID `deepseek/deepseek-v4-flash`  
**Diagnostic level:** `basic`  
**Whole-run ceiling:** 600 seconds  
**Requests:** 15 used of 23 planned maximum

This run used the existing `gateway diagnose` production workflow. It did not
use Keychain, did not write a private raw capture, did not print credentials,
and did not touch a pre-existing corpus. Cleanup removed both temporary
corpora and all three temporary sessions with no failures.

Share-safe artifact:

```text
/private/tmp/contextdesk-gateway-diagnostic-749e8339-live10-out/gwdx-1786391727498-71663/report.json
```

## Results

| Case | Product/scorer result | Classification |
| --- | --- | --- |
| Ordinary generation | Passed; 1,601 ms; 1 request | Compatible |
| Structured response | Passed; 1,367 ms; 1 request | Compatible |
| Tool call + continuation | Product passed; 10,499 ms; 2 requests | Retry required by policy |
| Selected context | Passed scorer; 1,829 ms; 1 request | Compatible |
| Typed linked-log multi-stage triage | Product and typed scorer passed; 47,092 ms; 4 requests | Compatible |

Terminal verdict:

```text
gateway_model_status: pass
product_workflow_status: pass
answers_useful_status: pass
```

The linked triage scorer evaluated the host-validated
`investigation_answer.v1` envelope directly. It did not reparse the rendered
Markdown transcript. The known-truth fixture retained two independent ERROR
candidate groups, a WARN noise record, a downstream `LeaseWindowExpired`
symptom, and a recovery event; the truth key remained host-only.

## Lessons retained

1. The diagnostic question must exercise the real broad-triage classifier. A
   prompt that says “investigate” but omits “triage” can take the legacy path.
2. The evaluator contract must not be appended to the user prompt. Example
   sequence numbers and IDs make the classifier see a focused anchor and
   bypass broad triage.
3. A completed linked turn may expose a typed answer event while its rendered
   `final_text` is only a presentation projection. Scoring the projection
   creates false response-contract failures.
4. The diagnostic preserves only host-authored authority-path labels and typed
   rubric dimensions in share-safe output. Provider bodies, reasoning text,
   endpoint URLs, credentials, private paths, and exact private model/profile
   identifiers remain excluded.

## Limits

This proves the exact Vercel/DeepSeek combination and the current product path;
it does not prove the employer gateway, embeddings/reranking quality, GUI
packaging, or a different DeepSeek serving dialect. The employer acceptance
run must use its exact discovered model id, protected local credential file,
preserved corpus/configuration, and the same bounded diagnostic before a
release-wide readiness claim.
