# Reasoning-effort contract v1

**Status:** hermetic product path.  
**Does not claim** any live model, gateway, or readiness badge.

## What it is

Provider-neutral **reasoning effort** is an opt-in request policy:

| Level | Token |
| --- | --- |
| none | `none` |
| low | `low` |
| medium | `medium` |
| high | `high` |
| xhigh | `xhigh` |
| max | `max` |

**Default is omission** — no effort field on the wire (provider default).  
Selecting effort can change **cost and latency**. It is **not** a capability or readiness badge and never writes qualification stores.

## Wire honesty (Chat Completions ≠ Responses)

| Dialect | Surface | Field when explicit | Unsupported |
| --- | --- | --- | --- |
| OpenAI-compatible | Chat Completions | top-level `reasoning_effort` | exact token is transmitted; exact model/gateway may refuse it |
| OpenAI-compatible | Responses | nested `reasoning.effort` | exact token is transmitted; exact model/gateway may refuse it |
| Ollama / Anthropic | any | — | explicit effort **fails closed**; omit is fine |

The product **never** assumes Completions and Responses share one field name.
The six tokens are a product request vocabulary, not a dialect-wide capability
claim. Support varies by exact model, gateway, and API surface. ContextDesk does
not infer support from model names or URLs, does not silently downgrade a value,
and does not turn successful transport into a readiness badge. Exact support is
owned by qualification/live evidence; this hermetic lane makes no such claim.

The model-specific distinction is intentional and evidence-based: OpenAI's
published model pages list different accepted sets for
[GPT-5](https://developers.openai.com/api/docs/models/gpt-5),
[GPT-5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro), and
the current [GPT-5.6 guidance](https://developers.openai.com/api/docs/guides/latest-model).
The runtime does not encode those model names; documentation and qualification
can change without weakening the transport contract.

## Precedence

1. Per-turn CLI override (`--reasoning-effort` / `--effort`) — never persisted  
2. Saved `AppConfig.reasoning_effort`  
3. Omit (provider default)

## CLI

```text
contextdesk config effort show
contextdesk config effort auto
contextdesk config effort set medium

contextdesk --reasoning-effort high "question"
contextdesk chat --reasoning-effort low "question"
```

Invalid levels fail before credential resolution, Keychain access, corpus mutation, or provider contact.

## GUI

Settings exposes the same omit / level vocabulary with host-owned save through AppConfig. Labels state cost/latency impact and non-readiness.

## Telemetry

Share-safe labels only: `reasoning_effort_requested`, `reasoning_effort_effective` (and schema-tagged apply records). Here “effective” means the exact request value placed on the wire, not proof that a remote model honored it. No prompts, bodies, headers, URLs, or secrets.

## Hermetic proof

```bash
cargo test -p cd-core --lib reasoning_effort
cargo test -p cd-core --test reasoning_effort_contract
cargo test -p cd-cli --test reasoning_effort_cli
```

Focused integration counts at the audited branch tip:

- core unit filter: 10 passed
- core wire/config/refusal contract: 19 passed
- workflow resolve-to-wire path: 4 passed
- CLI process/config path: 3 passed
- desktop helper/component path: 4 passed

Counts are an audit record, not a brittle gate: Cargo/Vitest fail on behavior
assertions, compilation errors, or warnings, not merely because a later change
adds another valid test. The semantic mutation assertions cover omission,
foreign-field leakage, silent value downgrade, refusal retry, malformed host
state, and non-persistent overrides.

## Integration audit corrections

- Replaced the original dialect-wide level assumption with transport-shape
  vocabulary and explicit exact-target uncertainty.
- `max`/`xhigh` are transmitted unchanged on OpenAI-compatible surfaces; a
  provider refusal remains a structured HTTP failure and never triggers a
  lower-effort retry.
- Desktop persistence mutates a cloned config and swaps in-memory state only
  after the atomic file save succeeds; a failed save restores the last visible
  selection.
- The shared Cargo target is not used as proof when divergent worktrees build
  concurrently. Focused proof used a private worktree target seeded with APFS
  clone-on-write copies of dependency artifacts, then invalidated every
  `cd-core` artifact before running the gates.

## Non-goals

- Live model verification or readiness promotion based on effort  
- Automatic “best effort” learning  
- Inventing a unified wire field across Completions and Responses  
- Routing production turns through Responses (the current production path is
  Chat Completions; Responses mapping is a pure contract seam only)
