# Vercel model comparison — release `d39688c7`

This comparison uses the same production diagnostic, synthetic corpus, exact
release build, and protected-file credential plumbing for two exact discovered
Vercel catalog entries. It is evidence for routing decisions, not a universal
model ranking.

| Dimension | `deepseek/deepseek-v4-flash` | `openai/gpt-oss-120b` |
| --- | --- | --- |
| Basic generation | Pass | Pass |
| Prompted structured output | Pass | Pass |
| JSON Schema / strict schema | Pass | Pass |
| Native `json_object` | Fail: HTTP 400 `response_format` | Fail: HTTP 400 `response_format` |
| Tool-call initiation | Pass | Pass |
| Tool-result continuation | Failed qualification marker | Failed qualification marker |
| Real product tool workflow | Grounded answer passed | Grounded answer passed |
| Selected-context answer | Passed scorer | Passed scorer |
| Linked-log product path | Completed; typed scorer passed | Completed; typed scorer rejected symptom separation |
| Diagnostic usefulness verdict | Pass | Fail |
| Diagnostic product-workflow verdict | Pass | Pass |
| Basic diagnostic requests | 19 / 23 maximum | 19 / 23 maximum |

## What this demonstrates

The gateway exposes a shared transport surface, but transport similarity does
not imply equal triage quality. Both models can participate in the real
ContextDesk workflow despite native continuation and JSON-object limitations.
DeepSeek produced a host-validated useful answer on this synthetic linked-log
case. GPT-OSS produced a completed product turn, but the host scorer rejected
it because it assigned two initiating causes and omitted the known downstream
symptom role.

This is the concrete case for bounded multi-model routing:

1. Let a fast model such as GPT-OSS perform structured extraction or a causal
   proposal against the complete host packet.
2. Run a separate role/contradiction checker, locally or remotely, against the
   same immutable ids.
3. Let the host reject symptom promotion, independent-noise promotion,
   chronology errors, and unsupported causes before rendering.
4. Escalate the unchanged packet to a stronger reviewer only when the typed
   scorer reports a real disagreement or missing role.

The models are therefore complementary rather than interchangeable: GPT-OSS
is attractive as a fast bounded contributor, while DeepSeek is currently the
stronger final triage candidate on this fixture. Neither result transfers to
the employer gateway without its own exact discovery and diagnostic run.

## Limits

These are one basic diagnostic run per model on one synthetic truth-known
fixture. They do not establish broad semantic quality, production-corpus
accuracy, embeddings/reranking usefulness, or stability across repeated runs.
