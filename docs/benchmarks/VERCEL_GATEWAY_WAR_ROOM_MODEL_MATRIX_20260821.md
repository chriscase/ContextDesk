# Vercel War-Room model matrix — 2026-08-21

**Source build:** `583a9822bfe3` (`codex/merge-consolidation-demo`)  
**Diagnostic:** synthetic `gateway diagnose --level basic`  
**Credential boundary:** one isolated protected-file Vercel profile; no key or
endpoint is stored here  
**Scope:** three exact Vercel catalog model IDs, not employer-gateway aliases

Each model received the same bounded diagnostic corpus and product workflow.
The runs used the share-safe default, wrote no private capture, and cleaned up
all temporary corpora and sessions without failure. These are scoped gateway
and workflow observations, not universal model-quality claims.

## Matrix

| Vercel model ID | Gateway compatibility | Product workflow | Known-truth usefulness | Linked-log triage latency | Main observation |
| --- | --- | --- | --- | ---: | --- |
| `openai/gpt-oss-120b` | Pass | Pass | Fail | 10.4 s | Typed scorer rejected `typed_symptom_separation`; no typed symptom claim was retained. |
| `alibaba/qwen3.6-27b` | Pass | Pass | Pass | 158.5 s | Typed symptom separation and causal-role checks passed; latency is the tradeoff. |
| `mistral/ministral-14b` | Fail | Fail | Fail | 4.3 s | Direct structured response had a response-contract failure; product triage had no visible terminal answer and no completed candidate. |

## Shared observations

- Ordinary generation, selected-context handling, and the product search/tool
  path were exercised for all three models.
- The direct tool-call probe was classified `retry_required` for all three;
  the product path still exercised the real search tool and grounding logic
  where a terminal answer was available.
- Usage and cost were not normalized, and no ranking or readiness badge was
  emitted.
- The host preserved failures and withheld a usefulness claim rather than
  turning agreement or partial output into a diagnosis.

## Interpretation

For this synthetic triage, Qwen is the strongest quality result but is too slow
to treat as an unbounded interactive default. GPT-OSS is a plausible fast
contributor/candidate extractor behind the typed validator, but the scorer
correctly rejected this run as insufficiently separated. Ministral is fast but
needs response-contract and terminal-answer investigation before it can be
used as a reliable triage lane.

These conclusions apply only to the exact Vercel routes, model IDs, source
build, and synthetic corpus above. They do not establish employer-gateway
behavior, nor do they replace a same-snapshot War-Room run with employer
profiles. Full per-model evidence is retained only in the owner-local
diagnostic bundles.
