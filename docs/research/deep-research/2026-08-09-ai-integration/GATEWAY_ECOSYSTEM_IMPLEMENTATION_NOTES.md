# Gateway ecosystem implementation notes

Status: recovered bounded research detail; not a protocol-conformance claim

Source conversation: owner-local (id withheld from the public repository)

The thread reader retained only the first 20,000 characters of the oversized
research answer. This file records the high-value deltas visible in that preview
and the subsequent local synthesis. Citation handles in the preview did not
include their source URLs, so they are not reproduced as fake repository
citations.

## Protocol-family boundary

- OpenAI Chat Completions remains the broadest de facto compatibility language
  for ordinary generation, but it is not a formal cross-provider semantic
  standard.
- OpenResponses is an emerging shared Responses-family specification with a
  schema, acceptance tests, governance, and an extension area. It is worth
  designing for, but the captured research did not consider adoption broad
  enough to replace Chat Completions as ContextDesk's only gateway interface.
- Anthropic Messages and Google Gemini Interactions are important native
  protocols with their own state, block, event, tool, and reasoning semantics.
  They should be separate adapters when product demand justifies them, not
  lossy translations hidden behind one universal request type.
- MCP is a host-to-tools/resources/prompts protocol with negotiation,
  cancellation, progress, and errors. It is not a model-inference protocol.
  MCP tools should enter through an MCP client and be normalized to
  ContextDesk's internal tool descriptor.
- `/v1/models` is a discovery hint, `/v1/embeddings` is a useful dense-vector
  envelope, and Cohere-like reranking is only a repeated convention.

The portable product boundary remains three small operations: `Generate`,
`Embed`, and `Rerank`. Authentication, discovery, request translation,
streaming, native blocks/events, provider extensions, and failure parsing
belong to registered protocol dialects.

## Compatibility dimensions that must not collapse into one Boolean

An OpenAI-shaped chat success says nothing conclusive about:

- strict JSON Schema enforcement versus prompt-only JSON;
- ignored, stripped, or rejected unsupported fields;
- system/developer instruction semantics;
- reasoning controls, continuation state, or accounting;
- fragmented and parallel tool calls or tool-result continuation;
- provider-managed conversation state;
- file, PDF, image, audio, video, and attachment carriers;
- prompt caching and usage/cost accounting;
- cancellation, midstream errors, and terminal completion;
- provider routing/fallback attribution; or
- data retention and storage behavior.

The captured report used Anthropic's documented OpenAI-compatibility behavior
as a concrete warning: unsupported fields may be silently ignored; strict tool
semantics and media support may not carry across; and instruction roles may be
rewritten. The general product lesson is to probe observable behavior rather
than assuming SDK or envelope compatibility implies semantic compatibility.

## Separate structured-output levels

Record at least these distinct outcomes:

1. the model can be prompted to emit JSON;
2. the route accepts JSON-object mode;
3. the route accepts a JSON Schema request;
4. the route claims or enforces strictness;
5. the returned document passes ContextDesk's local schema validation across
   repeated attempts.

Provider-side enforcement can reduce retries but never replaces local parsing
and validation. A route that silently falls back from strict to non-strict must
not be reported as strict success.

## Streaming and tool lifecycle requirements

ContextDesk's normalized stream must preserve, when present:

- native event type and sequence/order evidence;
- visible content, reasoning, tool-call, and error channels separately;
- fragmented tool name and argument deltas until a complete validated call
  exists;
- finish reason and terminal event;
- usage/cost data, while allowing it to be absent on interrupted streams;
- partial-output and cancellation state; and
- the native call id and unrecognized provider fields needed for diagnostics.

HTTP `200` and an open SSE connection do not prove successful completion. Some
providers report midstream failures as error-bearing stream events after
partial output has already been delivered. ContextDesk must not silently turn
that state into a completed answer or retry it through another provider after
the user has received partial output.

## Remaining ecosystem experiments

Run these against each exact configured protocol profile, not each model name:

| Experiment | Why it remains necessary |
| --- | --- |
| Unsupported-field negative probe | Distinguishes rejection from silent ignore/strip behavior. |
| Role-semantics probe | Detects system/developer rewriting and provider-specific instruction precedence. |
| Prompt JSON, JSON-object, schema, and strict-schema ladder | Prevents one structured-output Boolean from overstating behavior. |
| Forced tool, fragmented arguments, parallel calls, tool-result continuation | Proves the complete tool loop rather than initial call emission. |
| Clean stream, provider error after partial output, local cancel, and terminal usage | Proves lifecycle and accounting behavior. |
| Attachment matrix by media type and carrier | Prevents text chat success from becoming an attachment claim. |
| Discovery-to-operation mismatch | Proves that catalog metadata cannot grant capabilities. |
| Temporary outage after a prior pass | Proves availability degradation does not erase compatibility evidence. |
| Same-gateway fallback and optional cross-gateway review | Proves route attribution and visible privacy, retention, egress, and cost consent. |
| Redacted diagnostic capture | Proves useful error evidence without retaining prompts, attachments, private endpoints, or credentials. |

Promote Responses/OpenResponses or a native Messages/Interactions adapter only
for a concrete product need and after a conformance corpus proves that its
native lifecycle survives normalization. Do not delay the current release for
protocol families that no active ContextDesk workflow requires.

## Source-link recovery status

The bounded preview retained citation titles and internal research citation
handles, but not the actual URL metadata. Exact source URLs for the OpenAI,
embedding, TEI, vLLM, and reranking claims that overlapped the exact-model
report are preserved in
[`EMPLOYER_CATALOG_IMPLEMENTATION_NOTES.md`](./EMPLOYER_CATALOG_IMPLEMENTATION_NOTES.md).
The source conversation remains authoritative for the missing OpenResponses,
Anthropic Messages, Gemini Interactions, and MCP citation URLs.
