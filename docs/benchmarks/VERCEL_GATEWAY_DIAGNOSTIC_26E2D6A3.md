# Vercel gateway diagnostic — integrated release-quality v2

**Run date:** 2026-08-11  
**Source/build:** `integrate/release-quality-v2` at
`26e2d6a307ea26078933e849987233ca5e0343b6`  
**Gateway:** Vercel AI Gateway (endpoint intentionally omitted)  
**Catalog model:** `deepseek/deepseek-v4-flash`  
**Diagnostic level:** `basic`  
**Turn deadline:** 600 seconds  
**Credential source:** protected local file reference; no Keychain access

This is a local owner-only diagnostic summary. Raw provider exchanges remain
outside Git under the diagnostic capture directory. This document contains no
credential, header, endpoint, private path, or provider-body data.

## Safe run summary

| Measure | Result |
|---|---:|
| Wall time | 87 seconds |
| Planned request ceiling | 23 |
| Requests made | 19 |
| Temporary corpora created / removed | 2 / 2 |
| Temporary sessions created / removed | 3 / 3 |
| Cleanup failures | 0 |
| Timeout or cancellation | none |
| Private capture written | yes |
| Ordinary generation | pass |
| Structured response | pass |
| Tool-call continuation (direct route) | failed: response-contract mismatch |
| Tool-call continuation (product route) | pass; real search tool exercised |
| Attachment / selected context | pass |
| Linked-log triage product workflow | completed |
| Linked-log typed usefulness score | fail: symptom separation |

## Verdict

- **Gateway/model wire compatibility:** **not ready** for a verified-model badge.
  The direct tool-continuation probe did not satisfy the expected response
  contract, even though the existing product route completed its tool call and
  continuation.
- **Product workflow compatibility:** **pass** for the exercised ordinary,
  structured, tool, attachment, and triage paths.
- **Answer usefulness:** **not yet proven**. The typed triage answer promoted a
  downstream symptom to an initiating cause and omitted the symptom role.
- **Diagnostic integrity:** **pass**. Credentials stayed local, no timeout or
  cancellation occurred, and temporary state was fully removed.

## Interpretation and follow-up

The triage usefulness failure is not evidence that this model is generally
incapable. The candidate-stage packet supplied only a lossy mined template for
one repeated group (`LeaseWindowExpired`) and omitted the bounded observed
event line containing its event kind and mechanism. The host packet now retains
both values in the current worktree, with a hermetic regression test. A fresh
600-second diagnostic should be run after that change and scored against the
same synthetic known-truth case.

The direct tool-contract failure and the product-route success are retained as
separate observations. They must not be collapsed into a blanket “tools work”
claim; qualification and product routing need their own evidence.

## Reproduction

Use the existing `gateway diagnose` command with the protected-file profile,
the exact discovered catalog ID above, `--level basic`, `--timeout 600`, and
share-safe output. Do not commit the owner-only `private/` capture directory.
