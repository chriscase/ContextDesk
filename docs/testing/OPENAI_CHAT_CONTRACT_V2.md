# OpenAI-compatible chat contract v3

Status: hermetic product path. **Does not claim live model compatibility.**

## Problem (v2 residual)

v2 recorded `json_object` for structured probes even when Ollama/Anthropic
ignored `chat_mode` and sent ordinary chat. Production reviewer paths still
use plain/prompted JSON, so a native json_object pass incorrectly authorized
plain request contracts.

## Contract (v3)

| Piece | Location |
| --- | --- |
| Typed modes + pure body builder | `cd_core::openai_chat_contract` |
| Dialect honesty | `ChatBackendDialect` + `dialect_supports_mode` |
| Production client | `OpenAiCompatibleClient::complete_with_mode` / stream variants |
| Live transport | OpenAI transmits modes; Ollama/Anthropic **refuse** OpenAI-native modes |
| Evidence schema | `contextdesk.capability_qualification.v3` |
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

v1 and v2 keys/reports are storage-id / schema mismatches under v3. Verdicts
treat non-v3 `schema_version` as **Inconclusive** even if checks look green.
Do not silently reinterpret old files as v3 evidence.

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
