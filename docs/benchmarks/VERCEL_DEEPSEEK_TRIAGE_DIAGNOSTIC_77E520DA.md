# Vercel DeepSeek V4 Flash diagnostic — exact release source

Date: 2026-08-10  
Source/build identity: `77e520da063bf872a011d3418c983660e5b47cd0`  
Gateway: configured Vercel profile, protected-file credential reference  
Model: exact discovered ID `deepseek/deepseek-v4-flash`  
Diagnostic: basic, 600-second whole-run ceiling, 15 requests used of 23

Two independent runs were made from the exact source identity. Both completed
cleanup successfully (2 temporary corpora and 3 temporary sessions removed per
run) and both produced the same triage-scoring failure.

## Stable protocol/product results

- Ordinary generation: product pass
- Strict structured response: product pass
- Native inert tool call and continuation: direct pass; product grounded pass
  (diagnostic classification remains `retry_required` by policy)
- Selected-context attachment: product and scorer pass
- Linked-log product workflow: completed within the 600-second ceiling on both
  runs (86.9 s and 73.4 s; four requests each)

## Stable triage usefulness result

The linked-log typed `investigation_answer.v1` scorer failed on both runs:

```text
typed_trigger_identification
typed_symptom_separation
```

Terminal verdict on both runs:

```text
gateway_model_status: pass
product_workflow_status: pass
answers_useful_status: fail
classification: usefulness_gap
```

This means the gateway wire contract and ContextDesk product plumbing work, but
this exact DeepSeek deployment is not yet reliable enough to mark as a verified
triage model. The failure is semantic/role-quality, not a timeout or credential
problem. Do not promote this model to a triage-ready badge; keep ordinary and
structured compatibility separate from triage usefulness.

## Share-safe artifact hashes

Run 1 (`/private/tmp/contextdesk-vercel-deepseek-77e520da-exact-out/`):

- `report.json`: `cd59c43933ff54f1ae791649c779e5137e8d874b38d2eee4b1ae466264ad77e6`
- `manifest.json`: `24b7399d4462baafab8091ee4c6b78bb16ba90806623b94284e4115c485a5177`

Run 2 (`/private/tmp/contextdesk-vercel-deepseek-77e520da-replay-out/`):

- `report.json`: `0476a248a8425fa88eaefe921b4fc9becffa87ba376867c88a4fe0cdce57d77d`
- `manifest.json`: `24c82c622d736bf387400b5dd538e4e1ec403ebed217419f4123fa7352ccf0fa`

No provider bodies, endpoint URLs, headers, credentials, or private paths are
included in the share-safe bundles.

## Follow-up

The host-side seam this run exposed — a grounded final comparison filing
evidence against the roles its own candidate stage established — is addressed
by ledger-derived role reconciliation in
[`DEEPSEEK_TRIAGE_ROLE_RESTORATION_V1.md`](DEEPSEEK_TRIAGE_ROLE_RESTORATION_V1.md).
That change is proven hermetically only; this model's live triage usefulness
result stands until the rerun recorded there is performed.
