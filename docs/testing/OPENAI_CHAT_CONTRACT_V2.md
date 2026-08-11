# OpenAI-compatible chat contract v4

Status: hermetic product path. **Does not claim live model compatibility.**

## Problem (v3 residual)

v3 fixed mode honesty per request but evidence identity still keyed only by
profile/endpoint/model/schema. Changing provider kind while keeping the same
profile/base/model could reuse evidence. Aggregate readiness could still treat
mode/dialect-less Pass rows as Verified. Tool probes accepted any token shape;
strict schema did not reject extra properties.

## Contract (v4)

| Piece | Location |
| --- | --- |
| Typed modes + pure body builder | `cd_core::openai_chat_contract` |
| Dialect honesty | `ChatBackendDialect` + `dialect_supports_mode` |
| Evidence identity | profile + endpoint fingerprint + model + **transport_protocol** + schema |
| Production client | `complete_with_mode` pre-transmit + response validation (native modes) |
| Live transport | OpenAI transmits modes; Ollama/Anthropic **refuse** OpenAI-native modes |
| Evidence schema | `contextdesk.capability_qualification.v4` |
| Per-check fields | `request_mode`, `dialect`, `schema_strict`, `schema_probe_id` |

### Measured ladder (investigator)

| Capability kind | Request mode | Wire |
| --- | --- | --- |
| `basic_generation` | `plain` | ordinary chat |
| `native_tool_call` | `auto_tools` | tools + tool_choice auto |
| `tool_result_continuation` | `auto_tools` | tools + prior tool result |
| `forced_tool_call` | `forced_tool` | forced tool_choice + continuation |
| `structured_output` | `prompted_json` | plain body + JSON instruction |
| `structured_json_object` | `json_object` | `response_format` |
| `structured_json_schema` | `json_schema` | json_schema strict=false |
| `structured_json_schema_strict` | `json_schema_strict` | json_schema strict=true |

### Exact-mode authorization

| Runtime contract | Requires |
| --- | --- |
| `validated_structured_proposal` (JsonProposal) | `basic_generation`+`plain` **and** `structured_output`+`prompted_json` |
| `native_json_object` | `structured_json_object`+`json_object` |
| `native_json_schema` / `_strict` | matching schema kinds + mode |
| `native_tool_loop` | auto tools + continuation |
| `forced_tool_loop` | forced tool + continuation |

**Never:** JsonObject evidence authorize prompted JSON (or vice versa).

### Migration

v1–v3 keys/reports are storage-id / schema mismatches under v4 (and lack
`transport_protocol`). Verdicts and readiness treat non-v4 schema or empty
protocol as **Inconclusive** / not **Verified**. Do not silently reinterpret
old files as v4 evidence.

### Channel integrity

- Content channel only for structured success.
- Reasoning-only JSON is not success.
- Schema bodies are never exported on DTOs (name/strict only).

## Hermetic evidence

```bash
cargo test -p cd-core --lib openai_chat_contract
cargo test -p cd-core --lib capability_qualification
cargo test -p cd-core --test openai_chat_contract_v2
cargo test -p cd-workflow --test gateway_wire_qualification
```

## Explicit non-claims

- No live employer gateway compatibility claim.
- Ordinary production chat remains plain unless a host explicitly selects a
  qualified exact mode (not implemented as auto-upgrade here).
- No retrieval/embed/rerank/fast-triage product-path rewrites.
