# Quality evaluation harness

**Status:** Accepted design. Compatibility qualification is implemented on the
current integration branch; the quality harness described here is planned and
must not be presented as shipped behavior.

## Purpose

ContextDesk needs to answer two different questions without conflating them:

1. Can an exact gateway/model combination satisfy the wire and behavior
   contracts for a role?
2. Does a model and product pipeline produce useful, grounded answers on a
   frozen task suite?

Capability qualification answers the first question. This harness will answer
the second. Quality evidence never changes a compatibility result and never
creates a universal model badge.

## Evidence classes

| Class | Proves | Does not prove |
| --- | --- | --- |
| Compatibility | Synthetic contracts for an exact profile, endpoint, model, role, and probe schema | Answer quality, cost value, attachments, or unrelated modes |
| Retrieval quality | Whether a frozen query ranks and includes the correct evidence identities | Whether a chat model can synthesize a useful answer |
| Answer quality | Whether a model is grounded, useful, honest, and actionable given a frozen packet or product path | General quality outside the frozen task unit |
| Live optional | The same named measures against a real provider after explicit consent | A default-test or permanent guarantee |

## Role and mode boundaries

Quality is scoped at least to these separate modes:

- `chat.triage_investigation`
- `chat.ordinary`
- `chat.with_text_attachments`
- `embedding`
- `reranking`
- future multimodal modes, unavailable until their own contracts exist

The current chat compatibility suite measures triage/investigation contracts:
basic generation, native tool calling, tool-result continuation, and structured
output. It does not qualify ordinary chat or attachments.

## Quality unit identity

A result belongs to an immutable quality unit. The unit includes:

- build or commit identity;
- provider profile kind and endpoint fingerprint;
- exact model id;
- sampling parameters or provider snapshot when available;
- prompt-set hash and answer-schema version;
- corpus-suite id and digest;
- retrieval mode;
- orchestration-policy identity; and
- quality-evaluation schema version.

### Multiple gateways

Each saved gateway remains a separate provider profile. Model names do not join
evidence across endpoints. Protocol and authentication differences belong
behind adapters, including Vercel v4, OpenAI-compatible, Ollama, Anthropic, and
Grok session authentication.

Cross-gateway routing or comparison must make privacy, egress, retention, cost,
and credential behavior explicit. ContextDesk must not silently fall back from
one gateway to another.

### Multiple models in one role

The default orchestration policy is one gateway/model pair. Future policies may
use:

- an ordered fallback list;
- parallel peer candidates in the same role;
- candidate plus reviewer;
- candidate, reviewer, and synthesizer; or
- a bounded ensemble with a typed aggregation contract.

Every member retains its own compatibility evidence. The orchestration policy
gets separate quality evidence keyed by the exact ordered members, their stage
assignments, prompts, strategy, and gateway identities. One verified member
cannot verify a group, and a group result cannot transfer to a different
membership or ordering.

The daily GUI should remain single-model by default. Advanced review or
ensemble policies should be named configurations rather than a visible matrix
of every gateway, model, role, and stage.

## Frozen evaluation lanes

Retrieval and generation must be independently diagnosable.

| Lane | Input | Measures |
| --- | --- | --- |
| No retrieval | Question only | Prior knowledge and hallucination baseline |
| Lexical | Frozen query through keyword retrieval | Retrieval metrics only |
| Embedding | Same documents and query through an embedding backend | Semantic recall and leakage |
| Embedding then rerank | Bounded shortlist, then reranker | Upstream versus final recall and shortlist loss |
| Product hybrid | Production retrieval path | End-to-end retrieval plus honest degradation |
| Fixed packet | Identical evidence packet for every model | Generation quality independent of retrieval |
| Oracle packet | Host-curated decisive rows | Whether the model can solve the task when evidence is present |
| Product end-to-end | Production triage or review pipeline | Product handoff plus model behavior |

Comparing the oracle/fixed-packet lanes with product end-to-end is mandatory
before concluding that a cheap model is inadequate. A model may be capable
while the product omits decisive chronology or evidence.

## Host-authoritative measures

Retrieval records should include:

- recall at bounded `k` values;
- must-include and must-exclude identities;
- foreign-incident leakage;
- rare-trigger and recovery recall;
- upstream and final recall for reranking;
- invalid-score degradation behavior;
- latency, calls, and available usage; and
- vector model, dimension, corpus, and query-shape identity.

Answer records should include:

- typed schema validity;
- cause versus symptom separation;
- correct abstention when evidence is insufficient;
- recovery versus trigger separation;
- independent-error isolation;
- citation identity validity;
- injection resistance;
- actionability and readability; and
- latency and available usage.

Do not embed evaluator roles such as `initiating_evidence` in model-visible
document text. Structural labels remain neutral; truth roles remain host-side.

## Strong reference models

Grok or another strong model may be a secondary judge, never the authority.
The authority order is:

1. host truth keys and identity checks;
2. deterministic structural scores;
3. typed validation;
4. calibrated human review; and
5. optional blinded model judgment.

Pairwise judging must hide provider/model names and arm labels, swap answer
positions, and discard inconsistent judgments. A judge cannot override a
must-include, must-exclude, schema, citation, or security failure. Judge-derived
dimensions should not set release thresholds until calibrated against human
review.

## Product surface

The simple flow remains:

`Discover → Verify → Choose`

An optional advanced step may later add:

`Evaluate`

Evaluate must show its synthetic suite, role, models or orchestration policy,
retrieval mode, expected spend, progress, cancellation, and exact evidence
identity. It must not silently change defaults or compatibility status.

The CLI should keep compatibility under `contextdesk models`. A future
`contextdesk eval` command family may list suites, evaluate retrieval, compare
answers on a fixed packet, run an optional judge, and render a report. Offline
status must remain credential-free; live work requires explicit confirmation,
single-operation credential reuse, pacing, cancellation, and incremental saves.

## Implementation sequence

1. Add a small OPEN synthetic suite with runtime/truth isolation scanners.
2. Add immutable quality-unit and run-record schemas in `cd-core`.
3. Add a fixed-packet answer runner and deterministic structural scoring.
4. Join existing retrieval-ablation metrics into the run record.
5. Add hermetic no-retrieval, lexical, embedding, and shortlist-rerank lanes.
6. Add a thin CLI over shared `cd-workflow` orchestration.
7. Add optional live multi-model comparison with cost/latency recording.
8. Add blinded strong-reference judging only after deterministic scoring.
9. Add product end-to-end single/review lanes with evidence-handoff metrics.
10. Add a collapsed Advanced GUI only after the CLI and schemas stabilize.

Default tests remain network-free. Live lanes are opt-in, synthetic-only, and
honestly report `not_scheduled`, `blocked`, `cancelled`, or `executed` rather
than treating an unrun cell as green.

## Non-negotiable safeguards

- Remote embedding and reranking need query-time content-egress consent.
- Private logs and company data are not quality-suite inputs.
- Full-corpus reranking is diagnostic, not the product activation path.
- Invalid score vectors receive no credit and preserve the pre-rerank order.
- Query-shape prefixes are part of vector-space identity and are compared, not
  silently selected by best result.
- Evaluator truth never enters runtime input, model prompts, searchable text,
  or exported chat transcripts.
- Prompt injection, secret echo, false citation, and judge override of host
  truth are hard failures.
- Numeric quality thresholds come from measured baselines, not preference.
- Compatibility, retrieval, answer, and orchestration evidence expire
  independently when any identity component changes.

## First implementation milestone

The smallest valuable increment is entirely hermetic: schemas, six to eight
OPEN cases, fixed-packet structural scoring, and combined retrieval metrics.
Live gateway spend should resume only after that cage can distinguish model
quality from retrieval and product-handoff defects.
