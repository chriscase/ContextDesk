# Extension contract roadmap v1

Maps `contextdesk.extension.*` schemas to future product and benchmark work.
This is a planning note, not a release claim.

## Near term (contract-only — this lane)

- Keep pure validators + fixtures green on CI.
- Reference schemas from multi-model contribution and fast-triage docs.
- Do **not** rewrite production turn/chat paths in this lane.

## Mid term — CLI / GUI

| Surface | Adoption |
| --- | --- |
| CLI chat / diagnose | Optional JSONL events that cite `packet_id` + role outcome states |
| GUI Settings | Role enablement only after measured qualification; never model-name badges |
| Activity / trace | Share-safe role outcome labels (no prompts/bodies) |
| Gateway diagnose | Negotiation profile snapshots in share-safe reports |

## Mid term — benchmark ledger

| Artifact | Use |
| --- | --- |
| Evidence packet fixtures | Cheap-model / multi-role hermetic matrices |
| Role outcome states | Score partial dropout vs deterministic fallback honestly |
| Embedding space + retrieval provenance | Dimension/space mismatch fail-closed cases |
| Negotiation profiles | Dialect refuse matrices without live providers |

## Integration risks

1. **Schema overlap** — investigation_answer / fast_triage / multi_model already
   ship. Extension envelopes must set `maps_to_schemas` and never dual-write
   conflicting digests.
2. **Qualification v4** — role enablement must require measured
   transport_protocol + mode evidence; name hints remain non-authority.
3. **Embedding space** — retrieval provenance must carry endpoint fingerprint +
   dialect + dimensions; model id alone is insufficient.
4. **Privacy** — share_safe is the default export boundary; owner_only artifacts
   must not leak into CLI JSONL by default.
5. **Budgets** — budget_exhausted outcomes must not be scored as “model quality
   fail” in benchmarks; they are host scheduling facts.

## Unresolved design questions

1. Should extension packets be durable per session turn, or ephemeral per stage?
2. How do multi-corpus turns (#693 residual) bind a single `corpus_id` in binding?
3. Do Responses-API effort fields need a separate negotiation surface enum in GUI?
4. Should corroboration_count weight roles differently (extractor vs reviewer)?
5. Is owner_only packet export ever allowed in desktop diagnostics without an
   explicit ack flag?

## Explicit non-goals of this roadmap

- Automatic provider switching or adaptive “best model” learning.
- Readiness badges derived from role participation.
- Live Vercel/employer verification in the contract lane.
