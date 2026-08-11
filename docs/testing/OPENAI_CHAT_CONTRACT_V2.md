# OpenAI-compatible chat contract v2

Status: hermetic product path. **Does not claim live model compatibility.**

## Problem

Capability qualification set `expect_json_object: true` on structured probes,
but `LiveQualificationTransport` discarded the flag (`let _ = req.expect_json_object`)
and `OpenAiCompatibleClient` never emitted `response_format` or forced
`tool_choice`. Structured "passes" could therefore be prose coincidences.

## Contract

| Piece | Location |
| --- | --- |
| Typed modes + pure body builder | `cd_core::openai_chat_contract` |
| Production client | `OpenAiCompatibleClient::complete_with_mode` / `complete_stream*_with_mode` |
| Qualification request | `SyntheticChatRequest.chat_mode` |
| Live transport | `LiveQualificationTransport` → `complete_with_mode` (no discard) |
| Evidence schema | `QUALIFICATION_SCHEMA_VERSION = contextdesk.capability_qualification.v2` |
| Per-check mode | `CapabilityCheckResult.request_mode` |

### Modes

- `plain` — default; tools use `tool_choice: "auto"`
- `json_object` — `response_format: { "type": "json_object" }`
- `json_schema` — `response_format.json_schema` with name/schema/strict
- `forced_tool` — `tool_choice: { type: function, function: { name } }`

### Ladder / evidence rules

1. Measured only — model name never alone produces a structured pass.
2. Structured probe uses **json_object** mode; failures keep `mode=json_object`
   in the reason and **do not** silently retry as plain mid-turn.
3. Evidence keys: profile + endpoint fingerprint + model + schema version;
   mode is recorded on the check for audit.
4. Schema bump to v2 makes prior v1 reports a storage-id / selection near-miss
   (stale), not silently current.

### Channel integrity

- `parse_openai_completion` uses content only.
- `reasoning_content` / `reasoning` never merge into success text.
- Reasoning-only JSON is not structured success
  (`reasoning_channel_only_not_success`).

## Hermetic evidence

```bash
cargo test -p cd-core --lib openai_chat_contract
cargo test -p cd-core --lib capability_qualification
cargo test -p cd-core --test openai_chat_contract_v2
cargo test -p cd-workflow --test gateway_wire_qualification
```

Mutation guards: body builder must emit `response_format` for JsonObject;
gateway 400 on json_object yields exactly one request (no plain retry).

## Explicit non-claims

- No claim that any live employer gateway supports `response_format`.
- No change to provider retry/fallback policy, multi-stage budget allocation,
  credential resolution, retrieval, embeddings, or prompts.
- Adaptive latency learning remains future work.
