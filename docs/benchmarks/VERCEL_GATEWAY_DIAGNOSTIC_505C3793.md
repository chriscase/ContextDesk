# Vercel gateway diagnostic — DeepSeek V4 Flash — release `505c3793`

**Run date:** 2026-08-11
**Source build:** `505c37933440eff305ebb32b99347c42965ff957`
**Gateway:** Vercel AI Gateway, protected-file credential reference
**Selected model:** exact discovered ID `deepseek/deepseek-v4-flash`
**Diagnostic level:** `basic`
**Whole-run ceiling:** 600 seconds
**Requests:** 19 used of 23 planned maximum

This run used the production `gateway diagnose` workflow from the release
branch. The credential was read only through the configured protected-file
reference. Keychain was not used, credentials and headers were not printed,
raw provider bodies were not captured, and no pre-existing corpus was touched.
Cleanup removed two temporary corpora and three temporary sessions with no
failures.

The local share-safe bundle is retained outside the repository under the
diagnostic output directory. It contains only `report.json` and
`manifest.json`; its run id is `gwdx-1786463126666-5571`.

## Product-path results

| Case | Result | Requests | Elapsed | Classification |
| --- | --- | ---: | ---: | --- |
| Ordinary generation | Passed | 1 | 1,864 ms | Compatible |
| Structured response | Passed | 1 | 1,612 ms | Compatible |
| Tool call + continuation | Real search tool and grounded answer passed | 2 | 11,387 ms | Retry required by direct-probe policy |
| Selected context | Passed scorer; current fact cited and decoy avoided | 1 | 3,107 ms | Compatible |
| Linked-log multi-stage triage | Product path and typed scorer passed | 4 | 39,748 ms | Compatible |

Terminal verdicts:

```text
gateway_model_status: fail
product_workflow_status: pass
answers_useful_status: pass
```

The `gateway_model_status` failure is intentional and fail-closed: the direct
native tool-continuation probe returned a response-contract failure. The real
product path recovered by using its bounded tool workflow, executed search,
and produced a host-validated grounded answer. The linked-log triage scorer
passed with four typed candidates and five typed claims, including one
initiating-cause claim; semantic scoring was not needed for this fixture.

## Targeted qualification observations

The exact discovered model was classified `limited`, not ready:

- Passed: basic generation, native tool-call initiation, prompted structured
  output, JSON Schema, strict JSON Schema, streaming, and cancellation.
- Failed: tool-result continuation and forced-tool continuation because the
  required marker was absent from the continuation.
- Failed: native `json_object`; the gateway rejected `response_format` with
  HTTP 400 `invalid_request_error`.

These observations agree with existing hermetic coverage: native JSON mode is
never silently downgraded, malformed/empty terminal answers fail closed, and
the product workflow remains independently testable. No new provider-specific
code is justified by this run.

## Limits

This is evidence for the exact Vercel route, exact discovered model id, and
exact release build only. It does not establish employer-gateway behavior,
embedding/reranking usefulness, GUI packaging readiness, or universal model
compatibility. The source-based employer acceptance procedure must repeat the
same focused discovery, targeted verification, and one bounded diagnostic with
its own exact gateway/model evidence.
