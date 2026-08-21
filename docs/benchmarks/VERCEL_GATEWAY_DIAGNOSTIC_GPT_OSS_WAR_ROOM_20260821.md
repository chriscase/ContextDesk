# Vercel gateway diagnostic — GPT-OSS 120B — War-Room branch

**Run date:** 2026-08-21  
**Source build:** `583a9822bfe3` (`codex/merge-consolidation-demo`)  
**Gateway:** Vercel AI Gateway, protected-file credential reference  
**Selected model:** exact discovered ID `openai/gpt-oss-120b`  
**Diagnostic level:** `basic`  
**Whole-run ceiling:** 600 seconds  
**Requests:** 19 used of 23 planned maximum

This was an owner-authorized, synthetic-only diagnostic through the production
`gateway diagnose` workflow. The profile was isolated in a temporary AppConfig;
the shared desktop configuration and repository were not modified. The key was
used only through its protected `file:` reference. No credentials, headers,
endpoints, request identifiers, or raw provider bodies are included here.

Vercel catalog discovery succeeded before the diagnostic and returned the exact
model id above. The diagnostic created and removed two temporary corpora and
three temporary sessions with no cleanup failures. No private capture was
written.

## Results

| Case | Result | Classification |
| --- | --- | --- |
| Ordinary generation | Direct and product paths passed | Compatible |
| Structured response | Direct and product paths passed | Compatible |
| Tool call + continuation | Direct and product paths passed; product search was grounded | Retry required |
| Selected context | Product path and scorer passed | Compatible |
| Linked-log multi-stage triage | Product path completed; typed scorer rejected symptom separation | Usefulness gap |

Terminal verdicts:

```text
gateway_model_status: pass
product_workflow_status: pass
answers_useful_status: fail
```

The typed scorer rejected the known-truth linked-log result for
`typed_symptom_separation`: the result retained no typed symptom claim while
retaining initiating-cause claims. This is a useful negative result, not a
provider outage. ContextDesk completed the workflow and withheld a usefulness
claim instead of presenting the output as a definitive diagnosis.

## Interpretation

This exact Vercel/model combination is currently wire-compatible with the
ContextDesk gateway and product workflow on the synthetic diagnostic. It is not
yet acceptable as an unreviewed final linked-triage model for this benchmark.
It remains a plausible fast contributor or candidate extractor when followed by
typed symptom-separation and causal-role validation.

The result is scoped to this exact model, gateway route, source build, and
synthetic corpus. It does not establish behavior on the employer gateway,
other Vercel models, embeddings, reranking, or arbitrary production incidents.
