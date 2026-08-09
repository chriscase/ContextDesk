# Vercel refinement lab notes

Status: active experiment journal; not a release claim
Last updated: 2026-08-09
Experiment branch: `fix/vercel-basics-refinement-v1`
Branch base: exact RC `37905a3788f02b5069767a2bf70b946e0f33f945`
Current branch head before this journal: `7e10ba95cc4bc0baf26d3718bceee22908dc9c41`

This file preserves live-gateway findings across task compaction. It records
observations, not qualification claims. No API key, authorization header, raw
credential, or Keychain value belongs in this file.

## Safety and execution constraints

- Keep the main worktree and exact RC worktree untouched.
- Do not merge, publish a release, or create final release artifacts without
  owner approval.
- Use ContextDesk's Rust provider path for live gateway requests so the Vercel
  credential remains in macOS Keychain. Do not export it to a shell, command
  argument, log, or ad hoc HTTP client.
- `keyring` 3.6.3 makes one `find_generic_password` call per macOS
  `get_password`. The cancelled single-model run performed one Rust credential
  lookup, not one lookup per investigation stage. Do not diagnose multiple
  dialogs as stage-by-stage credential reloads.
- Ad-hoc development binaries have changing code-signature identities across
  rebuilds. Investigate macOS access control or overlapping external processes
  before redesigning secret storage.
- Run direct model experiments as ordinary, unlinked single-turn chats: one
  provider round, no broad-triage orchestration. Use a separate temporary data
  directory per concurrent process to avoid DuckDB/session-state lock
  collisions while pointing each process at the same safe AppConfig.

## Synthetic incident truth used so far

The numbered 31-record corpus lives outside the repository at:

`/tmp/contextdesk-vercel-live.o3oaRs/input/opaque-incident.log`

Hidden truth:

1. Revision r17 starts deploying.
2. r17 carries `lease_window_ms=250`, below the supported minimum of 1000.
3. r17 is marked active despite the preceding validator rejection.
4. The 250 ms window expires during worker lease acquisition, producing
   repeated `LeaseEpochMismatch` and `LeaseWindowExpired` records.
5. Worker unavailability propagates to `RequestAborted` for `amber-sync`.
6. `TelemetrySinkTimeout` is a separate failure with no logged causal link; it
   recurs after the worker and API recover.
7. Rollback restores r16 with `lease_window_ms=4000`; worker lease acquisition
   and the API operation recover.

Decisive records: invalid configuration 2; active contradiction 5; lease
mechanism 6-9, 14-17, 20-23; API impact 10-11, 18-19, 24-25; independent
telemetry 12-13 and 30-31; rollback/recovery 26-29.

## Direct-request result: model capability is not the main current bottleneck

A one-round ordinary chat supplied the complete numbered corpus directly to
GPT-OSS-120B. It correctly identified the invalid r17 configuration, the lease
failure and API propagation, rollback/recovery, and independent telemetry.
Therefore the model can solve this incident. The current product's weaker
multi-stage answers are primarily limited by evidence handoff: final comparison
receives candidate-owned error evidence, not the complete deterministic
timeline and global change/recovery evidence.

Embeddings or reranking cannot repair evidence that the final synthesis stage
is structurally forbidden to receive.

## Prompt experiments and current winning request shape

Four initial GPT-OSS prompt strategies were compared:

1. concise open-ended triage;
2. evidence-first chronology plus reversal test;
3. scored competing hypotheses;
4. fixed incident-decision memo sections.

Lessons:

- Evidence-first chronology and the reversal test are consistently useful.
- Explicitly require a logged mechanism for every causal link.
- Frequency and temporal proximity are not causation.
- A failure that persists after the main service recovers is counter-evidence
  against joining it to the main causal chain.
- Contradictory state records must remain an unresolved contradiction. Models
  otherwise invent implementation behavior such as a validation bypass.
- Never describe an independent finding as a downstream side effect.
- Require plain record-number citations; some models otherwise produce
  malformed Unicode/circled-number citations.
- A short fixed answer shape improves usefulness, but rigid JSON is a separate
  transport/validation concern and should not replace evidence-quality tests.

Current refined request shape:

> Act as an evidence-first production incident analyst. Use the reversal test:
> change, failure onset, correction or rollback, then recovery. Require an
> explicit logged mechanism and exact record citations for every causal link.
> Separate initiating cause, propagated symptoms, and independent or unresolved
> findings. Timing and frequency alone do not establish causality. Persistence
> after recovery is evidence against joining an error to the main chain. Do not
> invent enforcement or implementation behavior from contradictory state
> messages. Do not add plausible intermediate mechanisms absent from the
> records. Return concise sections for verdict, decisive timeline, causal chain,
> propagated symptoms, independent/unresolved findings, and what the logs do
> not establish.

## Chat-model comparison on the same refined request

All costs and latency below are observed live values from this lab, not catalog
guarantees.

| Model | Employer-list relationship | Evidence-discipline result | Mean observed latency | Mean observed cost | Current interpretation |
| --- | --- | --- | ---: | ---: | --- |
| `deepseek/deepseek-v4-flash` | Exact name match | 3/3 refined repeats correct, telemetry independent, contradiction unresolved, no invented bypass | 14.4 s | $0.000351 | Current primary synthesis leader |
| `mistral/ministral-14b` | Same Ministral 3 14B family/date; exact employer instruct variant not proven | Main chain 3/3; 2/3 evidence-disciplined; one run falsely said validation blocked activation | 5.0 s | $0.000418 | Fast first pass, not trusted final verdict without verification |
| `openai/gpt-oss-120b` | Exact match | Main cause usually correct; refined run violated explicit telemetry-separation guardrails and contradicted itself | about 5.6 s in matched baseline | about $0.00063 | Candidate extraction/classification or baseline, not current primary synthesizer |
| `alibaba/qwen3.6-27b` | Exact name match | One strong run; correct chain and independent telemetry | 27.8 s | $0.005471 | Correct but poor cost/latency fit for this text-only task; needs more evidence before quality claims |

The employer's `Mistral-Small-24B-Instruct-2501-FP8-dynamic` has no exact
Vercel match found. Vercel's generic `mistral/mistral-small` is an older 22B
model and must not be represented as the employer build.

## Current ContextDesk retrieval implementation truth

- The broad-log triage brief intentionally performs no semantic/embedding or
  network retrieval.
- `retrieval-status` and a host-neutral `hybrid_search` entry exist, but desktop
  activation is not wired.
- The cloud embedding role currently constructs an Ollama-specific backend and
  speaks one request per text to `{base_url}/api/embeddings`, expecting an
  Ollama `embedding` array. It has no bearer-key path. This is incompatible with
  Vercel's OpenAI-compatible `/v1/embeddings` contract.
- The reranker backend speaks `POST {base_url}/rerank` with
  `{model, query, documents}` and expects
  `{results:[{index,relevance_score}]}`. It supports an optional Keychain bearer
  reference, caps documents at 100 and each document at 512 characters, and
  degrades to the pre-rerank order on failure or timeout.
- The benchmark's real BGE-M3/Qwen reranker lanes remain honestly marked
  `FUTURE_CAPABILITY_UNAVAILABLE`. Synthetic synonym and reranker adapters are
  test fixtures, not proof of real semantic capability.
- Imported corpus `019fe55d-f3ce-7f62-b802-bc99d1c8d071` currently has zero
  embedded templates and selects `structured_keyword` mode.

## Vercel retrieval capability findings

- Vercel AI Gateway now advertises embeddings and reranking.
- Vercel exposes OpenAI-compatible embeddings through its `/v1` API.
- The employer's `bge-m3` exact model was not yet confirmed in Vercel's catalog.
- Vercel does expose `alibaba/qwen3-embedding-0.6b`: 1024 dimensions, roughly
  32.8K context, multilingual, instruction-prefix support, and very low input
  cost. It is an experimental substitute, not an employer-model equivalence.
- The employer's exact `qwen3-reranker-0.6b` was not yet confirmed in Vercel's
  catalog. Vercel exposes other rerankers such as Cohere and Voyage. Do not use
  them as employer-equivalence claims.
- The current official `@ai-sdk/gateway` package (`4.0.46`, inspected
  2026-08-09) uses a gateway-native v4 retrieval contract rooted at
  `https://ai-gateway.vercel.sh/v4/ai`. This is distinct from both the
  OpenAI-compatible `/v1/embeddings` surface and ContextDesk's current
  Ollama/TEI adapters.
- Every v4 request carries `Authorization: Bearer <key>`,
  `ai-gateway-protocol-version: 0.0.1`, and
  `ai-gateway-auth-method: api-key`. The credential must still come from
  Keychain once per lab process and must never enter shell arguments or logs.
- Model discovery is `GET /v4/ai/config`. Entries include `id`, `name`,
  `modelType`, a v4 `specification`, and optional pricing. Use this authenticated
  response to distinguish actual account/gateway availability from static SDK
  type declarations.
- Embedding is `POST /v4/ai/embedding-model` with headers
  `ai-embedding-model-specification-version: 4` and `ai-model-id: <model>`.
  The body is `{"values":[...]}` and the response contains
  `{"embeddings":[[...]],"usage":{"tokens":...}}` plus optional warnings and
  provider metadata. The SDK declares a 2,048-value call bound and parallel
  call support.
- Reranking is `POST /v4/ai/reranking-model` with headers
  `ai-reranking-model-specification-version: 4` and
  `ai-model-id: <model>`. The body is
  `{"documents":[...],"query":"...","topN":...}` and the response contains
  `{"ranking":[{"index":...,"relevanceScore":...}]}` plus optional warnings
  and provider metadata.
- The current SDK model types list Qwen3 embedding models (including
  `alibaba/qwen3-embedding-0.6b`) but not BGE-M3. Its reranker type lists Cohere
  and Voyage families but not the employer's Qwen3 reranker. Static types do
  not prove live availability; the authenticated catalog and real calls are
  the next gates.
- Current official model pages independently confirm the economical first
  retrieval matrix: `alibaba/qwen3-embedding-0.6b` is 1,024-dimensional,
  multilingual (100-plus languages), roughly 33K context, and listed at
  $0.01/M input tokens; `voyage/rerank-2.5-lite` is multilingual,
  instruction-capable, 32K context, and listed at $0.02/M input. Cohere
  `rerank-v4-fast` is also multilingual and attractive for a quality/latency
  comparison, but is billed at $2 per 1,000 search queries, so seven-query
  repeats cost materially more than the Qwen/Voyage first pass. Start with
  Qwen 0.6B plus Voyage Lite; add Cohere only after the harness is trustworthy.
- The official Vercel pages currently say Zero Data Retention is not supported
  for Voyage Rerank 2.5 Lite or Cohere Rerank 4 Fast. Direct experiments must
  remain synthetic. This strengthens the requirement for explicit
  content-leaves-machine consent before any production remote rerank wiring.

Official model-page evidence:

- <https://vercel.com/ai-gateway/models/qwen3-embedding-0.6b/providers>
- <https://vercel.com/ai-gateway/models/rerank-2.5-lite/providers>
- <https://vercel.com/ai-gateway/models/rerank-v4-fast/providers>
- Before production retrieval activation, ContextDesk needs a secure adapter
  for the selected Vercel contract. Do not route the Keychain secret through
  shell utilities to discover or test it.

## Independent heavy audit

A read-only Claude Code audit is in flight at Fable 5 / Extra effort. It was
asked to inspect the journal, production retrieval path, configuration,
benchmarks, and fixtures; challenge the adapter assumptions, privacy and
Keychain boundary, data/query shapes, must-include merge, ablation design, and
false capability risks; and recommend the smallest safe production sequence.
Claude was explicitly prohibited from editing files, making live credentialed
requests, committing, or pushing.

The following high-priority findings were subsequently checked directly in the
worktree and confirmed:

- **Stored/query vector compatibility is not enforced.** Corpus status stores a
  `model_id`, but query-time retrieval does not compare it with the configured
  embedding backend, and `EmbedBackend` has no identity method. A dimension
  mismatch becomes zero cosine scores while a successful query call still sets
  `semantic_ran`; same-dimension vectors from different models are an even more
  silent mismatch. Production measurement needs an exact model-identity and
  dimension binding plus an honest `embedding_model_mismatch` degradation
  before a Vercel semantic lane can be trusted.
- **Semantic score order is lost before RRF.** Template search ranks by semantic
  score, but the selected templates are expanded back into events in `(ts,
  seq)` order. `hybrid_retrieval` then assigns semantic lane ranks by that event
  order. RRF therefore fuses a chronological keyword lane with an effectively
  chronological semantic lane, structurally suppressing late rollback/recovery
  evidence and hiding real embedding benefit. The harness manifest currently
  overstates this as semantic-score-descending merge behavior.
- **The current TEI reranker has a base-path join bug.** Joining `"rerank"` to a
  base such as `/v1` without first normalizing a trailing slash drops `/v1`.
  This is separate from the Vercel v4 adapter, but must be fixed for generic
  path-prefixed gateways.
- **Query-time cloud egress consent is missing.** Ingest cloud embedding has an
  explicit content-leaves-machine gate. Query embedding and reranking do not;
  they can send the question and redacted messages once a host wires the
  backend. Production remote retrieval must fail closed to keyword mode unless
  an equivalent explicit consent is present.
- Additional honesty gaps confirmed: configured embedding/reranker ids are
  reported as if measured; `retrieval-status` health does not check corpus
  vector compatibility; and one search path invokes semantics for any present
  query even when its `semantic` flag is false.

Claude's wire-contract proposal was based on the journal version it read before
the official v4 SDK inspection. Its OpenAI-compatible `/embeddings` proposal is
therefore an alternate adapter hypothesis, not the selected Vercel contract.
The gateway-native v4 routes above are the current direct-lab target.

The direct probe/quality lab is intentionally independent of stored product
vectors and the product fusion engine, so it can measure raw embedding and
reranking behavior now. Production four-mode ablation must not proceed until
the vector-binding and semantic-order defects are fixed and covered
hermetically; otherwise a rigorous-looking null result or success claim could
be false.

## Data-shaping contract to test

Embeddings should operate over redacted templates, not every raw event. Preserve
stable host metadata outside the vector text and map each vector back to a
stable template/evidence identity.

Candidate embedding document shape to evaluate:

```text
kind=<structural kind>
level=<normalized severity>
service=<normalized service or unset>
pattern=<redacted Drain template>
cause=<attached cause template when structurally present>
```

Do not include frequency as prose that can dominate semantic similarity;
frequency remains a separate deterministic feature. Do not embed raw secrets,
authorization data, or unredacted parameter values.

Query shape must be asymmetric and retrieval-oriented, not a full synthesis
prompt. Compare a plain user question against an instruction-prefixed form such
as:

```text
Retrieve log templates that contain direct initiating evidence, explicit
failure mechanisms, downstream impact, rollback, or recovery relevant to this
incident question. Do not prefer repetition alone.
Question: <user question>
```

Reranking input must carry evidence IDs outside the text payload. Send a
bounded shortlist (initial target: 20-50 template candidates), score relevance
only, map returned indices back to the original stable IDs, reject missing,
duplicate, out-of-range, or non-finite scores, and retain deterministic
must-include evidence independently of the reranker.

## Required ablation plan

For identical committed queries and truth, compare:

1. structured/keyword baseline;
2. keyword plus embeddings;
3. keyword plus reranking;
4. keyword plus embeddings plus reranking.

Measure recall at the final evidence budget, initiating-cause recall,
rollback/recovery recall, independent-error separation, rare-singleton
retention, latency, provider calls, cost, and degradation behavior. Include
incident shapes with synonym-only matches, loud decoys, insufficient evidence,
and concurrent unrelated failures.

The semantic lane must prove improvement over baseline on the committed
benchmark. A healthy endpoint or plausible-looking ranking is not a quality
claim. No retrieval mode may evict deterministic safety/rare evidence solely
because a semantic score is low.

## Secure direct retrieval probe

An isolated development binary now exists at
`crates/cd-core/src/bin/cd-vercel-retrieval-lab.rs`. It is deliberately not
wired into desktop or production retrieval. Its contract is:

- accept only a ContextDesk config path and an optional profile id; never an
  API key, authorization value, or raw secret argument;
- require the exact public HTTPS Vercel AI Gateway host;
- validate the configured Keychain reference and call `get` exactly once per
  process, retaining that value only in memory for every request in the run;
- use the shared DNS-vetted, redirect-disabled pinned HTTP client;
- support authenticated catalog discovery, arbitrary model embedding and
  reranking probes, and a multi-model benchmark in one process;
- bound input counts, text sizes, response sizes, timeouts, model-list size,
  documents, and queries;
- never print provider error bodies, request text, credentials, headers, or
  embedding vectors; emit only safe model metadata, dimensions, vector norms,
  stable document ids, scores, usage, warnings count, and latency;
- reject incomplete, duplicate, out-of-range, non-finite, inconsistent, or
  dimensionally invalid responses.

The committed public-safe direct dataset is
`fixtures/log-lab/scenarios/vercel-retrieval-direct/v1.json`. It currently has
40-plus redacted template-shaped documents and seven truth-bound queries over:
the opaque lease incident and its persistent independent telemetry failure, a
database/managed-connection semantic vocabulary gap, a four-language causal
chain, two concurrent incidents that must not be mixed, loud/routine decoys,
rollback and recovery, and an isolated fatal event with insufficient causal
evidence. Stable ids remain outside model text. Unit tests parse and validate
the committed dataset before any live run.

An early draft incorrectly used evaluator-role values such as
`initiating_evidence` and `propagated_symptom` inside the model-visible `kind`
field. That would have leaked the answer and produced a false green. The draft
was corrected before any live run: `kind` is now restricted by test to neutral
structural values such as `config_error`, `exception_header`, `cause_record`,
`deployment_event`, `application_error`, and `status_event`. Chronology,
relevance truth, must-include roles, and stable ids remain host-side only.

The embedding benchmark evaluates three query shapes in one batched call per
model: the plain question, the original evidence-oriented prefix, and a
vocabulary-neutral structural prefix. This directly tests whether gains come
from retrieval instruction or merely from seeding fixture-adjacent operations
terms. Reports include per-shape mean relevant recall, must-include recall,
non-relevant share, bounded top rankings, dimensions, usage, warnings, and
latency.

The probe's unit tests (4/4) and strict binary-target clippy pass. The first
catalog request reached the expected one-time macOS Keychain access boundary
for this newly built development executable; no live catalog result is yet
recorded while that system approval is pending.

## Isolated production-integrity refinement

The Claude audit was followed by direct source review and a bounded
implementation in this experiment branch. Claude's partial implementation was
not accepted on trust: it was completed and tested locally. The current dirty
worktree (not committed, merged, or released) now does the following:

- `EmbedBackend` exposes a backend-known identity, and ingest/re-analysis bind
  stored vectors to that identity plus their measured dimension count. The
  legacy caller display label can no longer overwrite the producing backend.
- Ingest rejects empty or inconsistent vector dimensions. Runtime corpus
  status measures every stored vector, marks heterogeneous/unbound legacy
  vectors unusable, and retains their counts for repair diagnostics.
- Both direct template search and the shared hybrid engine require exact model
  identity and dimension compatibility. A mismatch executes no mergeable
  semantic lane, gives the model no telemetry credit, and leaves the
  structured/keyword result usable with an explicit degradation in the hybrid
  path.
- A query string no longer activates embedding work when `semantic=false`.
  This is both a correctness and cloud-egress boundary fix.
- Semantic template hits are expanded to events in template-score order under
  one total `k` budget. The previous collective chronological query could
  truncate away a later high-relevance template before the final score sort.
- The generic reranker preserves path prefixes such as `/v1` with or without a
  trailing slash.
- Retrieval status reports the corpus model/dim binding and marks an enabled
  embedding role incompatible when its configured model does not match the
  corpus; it no longer presents endpoint health alone as corpus compatibility.
- The hermetic retrieval-ablation manifest records the backend's actual
  identity rather than a separate configured label.

Focused validation after regenerating the one DuckDB native cache that an
aborted external-agent build had removed:

- semantic-disabled call-count regression: pass;
- late high-score semantic evidence regression: pass;
- model and dimension mismatch fail-closed regression: pass;
- all six hybrid retrieval unit tests: pass;
- `/v1/rerank` prefix contract (with and without trailing slash): pass;
- local ingest identity/dimension binding: pass;
- trusted vector re-analysis without reparsing: pass;
- retrieval-status corpus incompatibility: pass;
- retrieval-ablation semantic adapter contract with measured backend identity:
  pass.
- strict `cd-core` + `cd-workflow` library clippy with warnings denied: pass;
- full `cd-core` library suite: 1,824 passed, 0 failed, 5 intentionally
  ignored.

This removes known structural confounders before production ablation. It does
not constitute a live Vercel embedding/reranking quality result, a desktop
activation, or consent for production cloud egress.

## Next actions

1. Complete the already-pending authenticated Vercel v4 catalog request after
   the one-time macOS Keychain approval; do not start duplicate requests.
2. Run the direct seven-query synthetic benchmark first with
   `alibaba/qwen3-embedding-0.6b` plus `voyage/rerank-2.5-lite`, then compare a
   second economical available pair only if the catalog/first contract passes.
3. Record model identity, vector dimensions, response indices, scores,
   latency, calls, usage, and bounded quality aggregates without recording
   vectors, request text, credentials, or provider error bodies.
4. Use those results to select query/document shape and shortlist size, then
   run the identical four-mode product ablation on the corrected engine.
5. Add an explicit query-time content-leaves-machine gate before any remote
   embedding or reranking adapter can be activated outside the isolated lab.
6. Run focused and full repository gates and hand off the isolated branch for
   owner review; do not merge or release automatically.
