# Vercel gateway diagnostic — observed-message packet fix

**Run date:** 2026-08-11  
**Source/build:** `integrate/release-quality-v2` at
`96997ac4bba8f05af3e3e6d718b0f20adaa3c675`  
**Gateway:** Vercel AI Gateway (endpoint intentionally omitted)  
**Catalog model:** `deepseek/deepseek-v4-flash`  
**Diagnostic level:** `basic`  
**Turn deadline:** 600 seconds  
**Credential source:** protected local file reference; no Keychain access

This is a share-safe owner summary. Raw provider exchanges remain outside Git
in the owner-only capture directory. No credential, header, endpoint, private
path, or provider-body data is included here.

## Safe run summary

| Measure | Result |
|---|---:|
| Wall time | 60.6 seconds |
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
| Linked-log triage product workflow | pass |
| Linked-log typed usefulness score | pass |

## Verdict

- **Gateway/model wire compatibility:** **not ready** for a verified-model
  badge. The direct native tool-continuation probe still failed the expected
  response contract.
- **Product workflow compatibility:** **pass** for the exercised ordinary,
  structured, tool, attachment, and triage paths.
- **Answer usefulness:** **pass for this synthetic known-truth case**. The
  typed answer retained a downstream symptom and one initiating cause, and the
  host scorer accepted all dimensions.
- **Diagnostic integrity:** **pass**. Credentials stayed local, no timeout or
  cancellation occurred, and temporary state was fully removed.

## What changed from the prior run

The host candidate packet now carries both the stable mined template and a
bounded observed event line. The prior run exposed only `LeaseWindowExpired`
for the repeated symptom group, which allowed the model to promote it to a
cause. This run preserved the event-kind/mechanism context and the typed
usefulness score passed. This is evidence for the packet fix on this corpus,
not a universal model-quality claim.

## Reproduction and next step

The exact same `gateway diagnose` command, protected-file profile, exact model
ID, synthetic corpus, and 600-second deadline produced this result. Keep the
private capture local. The next qualification improvement is to isolate and
explain the direct native tool response-contract mismatch; do not silently
promote the model to a verified native-tools badge based only on the product
route.
