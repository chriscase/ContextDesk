# GPT-OSS fast triage integration

**Status:** implementation plan grounded in preserved live evidence  
**Scope:** exact configured GPT-OSS model and gateway profile; never a model-name assumption

## What the evidence says

The preserved Vercel runs qualified `openai/gpt-oss-120b` for ordinary generation,
prompted JSON, native tool calls, tool-result continuation, streaming, and
cancellation. It is therefore not a transport failure. Its product answers were
fast and partly useful, but it sometimes withheld the true initiating cause,
promoted a downstream failure into a cause, or promoted an independent telemetry
finding into the main chain.

The same research also recorded a direct, complete-timeline request that GPT-OSS
could solve correctly. The important distinction is evidence handoff: a complete
host-prepared timeline gave the model enough context, while candidate-local final
synthesis did not. Embeddings and reranking cannot repair evidence that the final
stage never receives.

## Recommended product role

Treat GPT-OSS as a **fast, evidence-producing stage** first, and as a final answer
model only after a quality qualification for the exact workflow succeeds.

1. The host performs deterministic retrieval, chronology, deduplication, and
   candidate grouping.
2. GPT-OSS receives either a candidate-scoped packet or the complete host-owned
   linked timeline, depending on the workflow. It may reason in its native
   channel, but reasoning is never copied into visible answer text.
3. The host extracts only claims that cite host-minted evidence IDs and records a
   typed role: initiating cause, symptom, supporting evidence, competing/noise,
   or unknown.
4. Local validation rejects foreign IDs, cross-candidate evidence, unsupported
   root claims, symptom promotion, missing role coverage, malformed terminal
   output, and stale/cancelled evidence.
5. GPT-OSS gets one bounded semantic correction with a category-specific,
   host-authored instruction. The rejected proposal is never replayed.
6. If the corrected proposal passes the workflow scorer, it can be shown as a
   verified fast answer. Otherwise the host either escalates the unchanged,
   host-owned evidence packet to DeepSeek/Grok or returns an honest partial /
   inconclusive result.

This makes GPT-OSS useful without granting a broad “verified” badge based on a
single successful chat call.

## Protocol adapter requirements

For a profile that serves GPT-OSS directly, the adapter must preserve the native
Harmony/channel contract (or the gateway's documented translation) and keep these
streams distinct:

- visible final content;
- reasoning content and its accounting;
- tool-call name, id, and fragmented arguments;
- tool results and continuation messages;
- terminal reason, cancellation, and mid-stream errors.

Known complete wrappers may be normalized once. Arbitrary prose or malformed JSON
must not be guessed into a typed answer. The structured-output ladder remains
separate: prompt-followed JSON, JSON-object mode, schema request, strict schema,
and repeated local validation are different observations.

## Routing policy

Persist evidence per exact gateway/profile/model/dialect and workflow contract:

| Workflow contract | GPT-OSS policy until live quality passes |
| --- | --- |
| Ordinary generation | Eligible when current basic-generation evidence is qualified |
| Host-grounded synthesis with a complete packet | Candidate for fast default; require fixture scorer |
| Candidate assessment / role extraction | Preferred fast lane after role-coverage qualification |
| Native tool loop | Eligible only when tool-call and continuation evidence is current |
| Final typed multi-stage comparison | Escalate on failed role/quality scorer; do not badge globally |
| Embedding / reranking | Independent role evidence; chat qualification does not transfer |

The fallback decision must be visible in activity/diagnostic output and must not
silently switch gateways or expose prompts, endpoints, headers, or credentials.

## Minimum implementation and proof

- Add an exact-profile GPT-OSS dialect/qualification record if the employer
  gateway does not preserve the already-proven Vercel wire shape.
- Keep native reasoning and Harmony/tool parsing in the shared provider backend.
- Use the existing host evidence ledger, global timeline handoff, role-coverage
  validator, bounded correction, and share-safe diagnostic suite.
- Add fixed-corpus GPT-OSS fixtures for: correct roles, symptom promoted to cause,
  independent finding promoted to symptom, omitted trigger, malformed terminal,
  reasoning-only terminal, fragmented tool arguments, and cancellation.
- Run the exact selected model through the diagnostic suite with the employer
  gateway, then repeat the linked-triage scorer at least three times before
  changing its final-answer policy.
- Record separate verdicts for protocol compatibility, product workflow
  compatibility, and answer usefulness. “Inconclusive” is not “pass.”

## Expected outcome

The likely near-term win is a fast GPT-OSS candidate/first-pass lane that reduces
DeepSeek latency and cost while preserving DeepSeek or Grok as an escalation/final
judge when the role scorer rejects the fast draft. A GPT-OSS-only final mode is a
separate option and should remain disabled until the exact employer workflow
passes the fixed-corpus usefulness gates.
