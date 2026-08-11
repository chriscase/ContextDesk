# Vercel gateway diagnostic — GPT-OSS 120B — release `d39688c7`

**Run date:** 2026-08-11
**Source build:** `d39688c79c7a365b3c96cfe50d3cf255d37de66f`
**Gateway:** Vercel AI Gateway, protected-file credential reference
**Selected model:** exact discovered ID `openai/gpt-oss-120b`
**Diagnostic level:** `basic`
**Whole-run ceiling:** 600 seconds
**Requests:** 19 used of 23 planned maximum

This was a synthetic-only run through the production `gateway diagnose`
workflow. It used the protected-file credential reference, did not use
Keychain, did not print credentials or headers, did not capture raw provider
bodies, and removed two temporary corpora and three temporary sessions without
cleanup failures.

The local share-safe bundle is archived outside the repository. Its run id is
`gwdx-1786464986093-23225`.

## Results

| Case | Result | Elapsed | Classification |
| --- | --- | ---: | --- |
| Ordinary generation | Direct and product paths passed | 1,167 ms product | Compatible |
| Structured response | Direct and product paths passed | 1,444 ms product | Compatible |
| Tool call + continuation | Direct probe failed; real product search and grounding passed | 3,050 ms product | Retry required |
| Selected context | Product path and scorer passed | 1,380 ms | Compatible |
| Linked-log multi-stage triage | Product path completed; typed scorer rejected symptom separation | 18,364 ms | Usefulness gap |

Terminal verdicts:

```text
gateway_model_status: fail
product_workflow_status: pass
answers_useful_status: fail
```

The typed scorer observed four candidates and five claims, with two claims
typed as initiating causes and no symptom claim. The host therefore rejected
the answer for `typed_symptom_separation`. This is a useful product result:
the workflow ran and the host prevented an overconfident causal answer from
being presented as useful triage.

## Qualification observations

GPT-OSS passed basic generation, native tool-call initiation, prompted JSON,
JSON Schema, strict JSON Schema, streaming, and cancellation. It failed tool
result continuation and forced-tool continuation because the required marker
was absent, and it rejected native `json_object` mode with HTTP 400
`invalid_request_error` for `response_format`.

## Routing implication

This run supports GPT-OSS as a fast, bounded contributor or candidate extractor
behind the host validator. It does **not** support GPT-OSS as an unreviewed
final linked-triage model. A future multi-model route should let it propose
typed observations/roles, run an independent contradiction or role-separation
check, and escalate the unchanged host packet when the scorer rejects the
proposal.

## Limits

This evidence is specific to this exact Vercel route, model id, and release
build. It does not establish behavior on the employer gateway, embeddings or
reranking usefulness, or universal GPT-OSS compatibility.
