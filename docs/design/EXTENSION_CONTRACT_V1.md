# Extension contract v1 — multi-model triage & retrieval

**Status:** durable contract + pure validators + hermetic fixtures.
**Does not redesign** production chat, turn_trace, retry, or budget allocation.
**Does not claim** any provider or model is universally compatible.
**No readiness badges.**

Branch surface: `docs/extension-contract-v1`
Code: `cd_core::extension_contract`
Fixtures: `fixtures/extension-contract/v1/`

## Why this exists

Future multi-model triage and retrieval need a **versioned, provider-neutral**
envelope that future CLI/GUI and benchmark-ledger work can share. Existing
production schemas already own critical pieces:

| Existing schema | Role |
| --- | --- |
| `contextdesk.investigation_answer.v1` | Host-validated typed answer |
| `contextdesk.fast_triage.packet.v1` | Complete host packet projection |
| `contextdesk.capability_qualification.v4` | Measured dialect/mode evidence |
| `contextdesk.embedding_space.v1` | Vector-space identity |
| `contextdesk.multi_model.contribution.v1` | Bounded contribution proposals |
| `contextdesk.quality_eval.*` | Hermetic quality cage |

This extension contract **maps and version-extends** those concepts. It must
not silently replace them.

## 1. Evidence packet / envelope

**Schema id:** `contextdesk.extension.evidence_packet.v1`

### Host-owned fields (mandatory)

| Field | Meaning |
| --- | --- |
| `packet_id` | Host packet identity (echoed by all roles) |
| `packet_digest` | Host digest over permitted rows + binding |
| `binding` | session/turn/corpus + ledger digest (+ optional revisions) |
| `time_quality` | `wall` \| `mixed` \| `order_only` \| `unknown` |
| `timezone` | Optional IANA id when host declared one |
| `privacy` | `share_safe` \| `owner_only` |
| `evidence[]` | Opaque host-minted `evidence_id` + `candidate_id` (+ role/scope/ordinal) |
| `retrieval` | Mode + optional embedding-space schema, endpoint **fingerprint**, dialect, dimensions |
| `truncation` | Whether host truncated neighborhood/hit set |
| `maps_to_schemas` | Production schemas this envelope extends |

### Privacy boundaries

Share-safe packets must not contain secrets, absolute private paths, raw URLs,
or provider bodies. Validators scan forbidden substrings and reject opaque ids
that look like paths/URLs.

### Truncation & digest

Truncation is host-recorded and content-free. Digests are host-computed; models
cannot mint or rewrite them.

### Relationship to production packets

| Extension field | Production analogue |
| --- | --- |
| `packet_id` / digest | `FastTriagePacketV1::packet_id` / identity hash |
| evidence rows | `HostEvidenceEntry` / packet rows |
| binding | `AnswerBindingV1` |
| retrieval | retrieval role factories + `EmbeddingSpaceIdentity` |

## 2. Role-capability contract

**Schema id:** `contextdesk.extension.role_capability.v1`

| Role | May propose | Must not |
| --- | --- | --- |
| `observation_extractor` | observations | initiating cause, mint evidence |
| `timeline_analyst` | observations, timeline notes | promote independent → chain |
| `evidence_gap_finder` | missing_evidence | cite absent ids |
| `contradiction_checker` | contradictions, competing explanations | merge candidates |
| `finalizer` | draft from accepted reconciliation | review itself; override host validation |
| `reviewer` | contradictions and gaps when conditionally admitted | silently switch provider; override host validation |
| `embedding` | vector scores | cross-space compare; model-name compatibility |
| `reranker` | permutations | drop evidence; model-name compatibility |

**Model names never imply compatibility.** Required capabilities are dialect/
mode tokens (`plain_chat`, `embeddings`, …), never product strings such as
`gpt-4` or `deepseek-*` as capability ids.

Every role that touches a packet should set `requires_measured_qualification:
true` so future hosts refuse name-hint passes.

## 3. Typed multi-role outcome metadata

**Schema id:** `contextdesk.extension.role_outcome.v1`

| State | Meaning |
| --- | --- |
| `supported` | Host support for bounded proposal (not automatic root) |
| `contested` | Overlap-tolerant disagreement remains open |
| `abstained` | Role explicitly abstained |
| `escalation_recommended` | Host may escalate; never auto-switch provider |
| `partial_role_dropout` | Required role did not complete |
| `budget_exhausted` | Deadline/token budget exhausted |
| `deterministic_fallback` | Host baseline without model completion |
| `unavailable` | Role never started |
| `insufficient_evidence` | Partial completion, no establishable root |

Also records: `corroboration_count`, `open_readings`,
`root_cause_established` (must stay false unless reason
`host_cause_role_validated`), optional latency/token **labels** only.

Aligns with multi-model `ReconciliationReportV1` states without replacing them.

## 4. Capability negotiation

**Schema id:** `contextdesk.extension.negotiation.v1`

Capabilities: plain chat, prompted JSON, json_object, json_schema(+strict),
forced tool, tool continuation, streaming, cancellation, embeddings, reranking,
reasoning effort, deadline.

| Request | Behavior |
| --- | --- |
| `omit` | Provider default; no dialect field invented |
| `prefer` | Use when dialect supports; else omit (no foreign field) |
| `require` | Fail closed when dialect/surface does not support |

OpenAI-native modes and OpenAI effort fields are **not** honest on
Ollama/Anthropic dialects. Chat Completions vs Responses effort fields remain
distinct (see reasoning-effort / OpenAI chat contracts).

## 5. Fixtures & validators

| Fixture | Expected |
| --- | --- |
| `evidence_packet.good.json` | accept |
| `evidence_packet.unknown_fields.json` | parse fail (deny_unknown_fields) |
| `evidence_packet.malformed_ids.json` | malformed identity |
| `evidence_packet.dimension_mismatch.json` | dimension without dialect |
| `role_capability.good.json` | accept |
| `role_capability.model_name.json` | model-name-as-compatibility |
| `outcome.supported.json` / `outcome.budget_exhausted.json` | accept |
| `negotiation.omit_default.json` | accept |
| `negotiation.unsupported_dialect.json` | refuse json_object on ollama |
| `privacy.forbidden_leak.json` | privacy leak |

Entry points: `validate_evidence_packet_json`, `validate_role_capability_json`,
`validate_role_outcome_json`, `validate_negotiation_json`.

## 6. Non-claims

- No universal model/gateway compatibility.
- No readiness or qualification-store promotion from these fixtures.
- Effort/deadline negotiation affects cost/latency only when later productized.
- Live provider evidence remains a separate, credentialed lane.
