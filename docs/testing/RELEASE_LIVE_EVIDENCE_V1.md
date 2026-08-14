# Release live-evidence ledger v1

This document records share-safe observations only. It is evidence for the
named build, gateway, model, and workflow; it is not a readiness badge for
other gateways or models. Provider bodies, credentials, endpoints, private
paths, and raw corpus text remain owner-local.

## Vercel — DeepSeek V4 Flash

- Build: `a3a5263e408c8c1cd3030f470be690e334f1adad`
- Gateway/model: Vercel, exact catalog id `deepseek/deepseek-v4-flash`
- Run: `gwdx-1786548077356-84867`
- Product workflow: pass
- Known-truth linked-log usefulness: pass
- Ordinary generation and structured output: pass
- Product search-tool path: pass
- Direct native tool continuation: fail, `response_contract`
- Host conclusion: product workflow usable; native-tool readiness unqualified

This supports the routing rule that native tool compatibility, product
workflow usefulness, and ordinary generation are separate capabilities.

## Employer gateway — DeepSeek V4 Flash

- Build: `fcfdd30d1e52ee0fa379cce4682a79c51ce252c6`
- Binary SHA-256: `b73003d17d66de1db816f6a7bb1013567ee6e19351aa513f8686d0e9550c7ec1`
- Exact discovered model id: `deepseek-v4-flash`
- Corpus shape: 15,655 events / 32 templates
- Persisted timezone: `Asia/Tokyo`
- Explicit turn deadline: 600,000 ms
- Product turn: pass; 280,470 ms elapsed; 5 provider rounds
- Typed answer: `contextdesk.investigation_answer.v1`
- Grounding: host-validated and grounded
- Root cause: not established; the answer retained observations and missing evidence
- Provider errors: none; malformed JSONL lines: 0

This is a focused employer acceptance observation for that exact build and
model. It demonstrates a useful conservative answer, not universal DeepSeek
compatibility or a claim that every employer model is suitable.
