# Vercel gateway diagnostic — exact integrated head

**Run date:** 2026-08-11  
**Source/build:** `integrate/release-quality-v2` at
`aeaf5a7e7f686a6e4113f46ffaf24279d5073d89`  
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
| Wall time | 69.7 seconds |
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
  badge. The direct native tool-continuation probe still fails the expected
  response contract.
- **Product workflow compatibility:** **pass** for the exercised ordinary,
  structured, tool, attachment, and triage paths.
- **Answer usefulness:** **pass for this synthetic known-truth case**. The
  typed answer retained one downstream symptom and one initiating cause, and
  the host scorer accepted every dimension.
- **Diagnostic integrity:** **pass**. Credentials stayed local, no timeout or
  cancellation occurred, and temporary state was fully removed.

## What this proves

The host packet fix is effective on the known-truth corpus: candidate stages
now receive both the stable mined template and a bounded observed event line,
so event-kind/mechanism context survives template generalization. This is a
provider-neutral improvement and a strong DeepSeek result for this case, not a
universal model-quality claim.

The direct native-tool failure and the product-route success remain separate
facts. ContextDesk must not grant a native-tools readiness badge until the
response-contract dialect is explicitly qualified or the direct probe is
revised to the provider’s documented contract.

## Reproduction

Run the existing `gateway diagnose` command with the protected-file profile,
the exact catalog ID above, `--level basic`, `--timeout 600`, and share-safe
output. Keep the owner-only `private/` capture directory local.
