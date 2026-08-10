# Gateway diagnostic product-skeptic coverage on the release line

**Release line:** `integrate/acceptance-release-v1`
**Code candidate:** `64edb0a25161a5d493f067ff9f5f197de24f6c7e`
**Coverage commit:** `a43bb37a` (17 binary hermetic tests)

This audit ports the adversarial product-skeptic coverage to the current
release line. It exercises the shipped `contextdesk gateway diagnose`
orchestrator through the production discovery, qualification, chat, triage,
credential, cleanup, and redaction seams. It does not use a live gateway,
Keychain, private corpus, or cloud credential.

## Covered contracts

- exact selected profile/model binding in both direct and product lanes;
- no provider request before explicit profile selection and consent;
- protected-file credentials reach the wire but never share-safe output;
- embedding-role plans do not masquerade as chat compatibility;
- model-name hints never create a compatibility pass;
- stalled and hard-failure terminals expose deadline/error truth and balance cleanup;
- `--no-color` output contains no ANSI escapes;
- JSONL plan/terminal framing and share-safe report redaction;
- pre-existing user corpora remain untouched;
- raw capture remains owner-only and separated from the share-safe bundle.

## Results

```text
cargo test -p cd-cli --test gateway_diagnose -- --nocapture
17 passed; 0 failed
```

The release-line unit implementation already treats a run with no executed
direct/product/scorer evidence as `inconclusive`; the legacy Boolean fields
remain false in that state. Therefore a deadline or cancellation cannot be
reported as an all-green compatibility/usefulness result.

## Remaining limits

- This is hermetic coverage, not a live provider or desktop test.
- Provider behavior still requires one bounded live diagnostic per selected
  model/role before a readiness claim.
- Native structured-output transport semantics remain distinct from the
  host-validated JSON proposal contract.
- The live Vercel rerun on the current release line now passes DeepSeek V4 Flash
  triage usefulness; see
  [`VERCEL_GATEWAY_DIAGNOSTIC_AB14EC49.md`](../benchmarks/VERCEL_GATEWAY_DIAGNOSTIC_AB14EC49.md).
- Employer-gateway behavior remains unverified and requires the source-based
  acceptance procedure on the company machine.

No release readiness claim is made by this audit alone.
