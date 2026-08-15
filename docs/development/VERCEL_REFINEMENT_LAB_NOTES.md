# Vercel refinement lab notes

The durable next-stage quality-evaluation design, including multiple gateways
and multiple models per role, is captured in
[`QUALITY_EVAL_HARNESS.md`](../benchmarks/QUALITY_EVAL_HARNESS.md).
Public model research, source authority, and the ingestion checklist for the
in-flight external research report are captured in
[`MODEL_GATEWAY_RESEARCH_DOSSIER.md`](./MODEL_GATEWAY_RESEARCH_DOSSIER.md).

Status: active experiment journal; not a release claim
Last updated: 2026-08-09
Experiment branch: `fix/vercel-basics-refinement-v1`
Branch base: exact RC `37905a3788f02b5069767a2bf70b946e0f33f945`
Committed model-readiness head entering this update:
`b2cb84c2150e18714030612e2c426e2751044378`

This file preserves live-gateway findings across task compaction. It records
observations, not qualification claims. No API key, authorization header, raw
credential, or Keychain value belongs in this file.

## Safety and execution constraints

- Keep the main worktree and exact RC worktree untouched.
- Do not merge, publish a release, or create final release artifacts without
  owner approval.
- Use ContextDesk's Rust provider path for live gateway requests. The approved
  test loop may provide the credential to one child process from a protected
  local file through its environment, without printing it, placing it in an
  argument, or persisting it in the evidence store. This bypasses Keychain for
  the experiment without changing product secret architecture.
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

## Model-readiness integration lessons

- “Verified” must be scoped to exact profile + endpoint fingerprint + model id
  + role contract + probe schema. It is not a global badge on a model name and
  is not an answer-quality claim.
- A completed chat verification requires basic generation, native tool calls,
  tool-result continuation, and structured output. Basic text generation with
  a failed investigation contract is “limited,” not verified.
- Embedding and reranking passes remain labeled for those roles and never make
  a specialty model preferred in an ordinary chat picker.
- Explicit pins and defaults remain ahead of recommendations. Verified current
  chat evidence only orders otherwise ordinary choices; it never silently
  rewrites the selected/default model.
- Qualification evidence contains endpoint fingerprints and secret-free probe
  reasons, not raw endpoints or credentials. Persist it under the shared data
  directory so GUI and CLI can report the same result across restarts.
- Cached status, clear, GUI labels, and `contextdesk models` must not resolve a
  credential or contact a provider. Credential lookup belongs only to the
  explicit user-triggered live qualification action.
- The product flow is one shared `Discover → Verify → Choose` model in GUI and
  CLI. Discovery is a catalog request; verification is a separately confirmed,
  token-spending action; re-verification is the same Verify action again.
- Multiple saved gateways are first-class provider profiles. Catalogs and
  evidence stay scoped to exact profile + endpoint fingerprint + model, so one
  employer, Vercel, Ollama, or Grok result cannot leak into another. Protocol
  and authentication differences belong behind adapters; Grok's session-file
  authentication is not a reason for a separate model-readiness architecture.
- Future per-mode routing may bind triage, ordinary chat, embeddings,
  reranking, and attachments to different gateway/model pairs. Keep one simple
  default with optional overrides, and never silently fail over across
  gateways because privacy, egress, retention, and cost policy can change.
- Catalog snapshots retain local model ids plus profile/endpoint fingerprints.
  Added siblings appear unverified, removed exact models become stale, and
  unchanged exact-model evidence survives startup/pre-flight drift checks.
- Large gateways require subset-first UX. Exact ids, role filters, id-text
  filters, and interactive narrowing are the normal CLI path; `--all` is
  sequential, confirmed, paced, cancellable, stops on rate limiting, and is not
  the default. Empty catalog responses are non-observations and must never
  replace the last good snapshot or stale all evidence.
- The current chat-role probe is a triage/investigation compatibility suite.
  It must not claim ordinary-chat quality, attachment/multimodal support,
  answer quality, context length, or value/cost verification.
- Vercel catalog discovery and specialty probes must use the authenticated v4
  `/config`, `/embedding-model`, and `/reranking-model` contracts. A successful
  OpenAI-compatible chat catalog does not prove those specialty wire shapes.

## Integrated readiness and product-triage results

These runs used the feature lineage at `b2cb84c2` for model discovery and
qualification. Full product-triage comparisons identify the tested agent code
separately. All credentials were supplied through the protected local-file
override described above; these runs made no Keychain request.

### Live role-contract qualification

| Exact model | Role | Result | Observed detail |
| --- | --- | --- | --- |
| `deepseek/deepseek-v4-flash` | chat | verified twice | generation, native tool call, tool-result continuation, structured output, streaming, and cancellation passed; approximately 17 s then 9 s |
| `openai/gpt-oss-120b` | chat | verified | the same chat contract passed in approximately 16 s |
| `voyage/voyage-4` | embedding | verified | v4 document request succeeded in approximately 591 ms and returned one 1,024-dimensional vector |
| `voyage/rerank-2.5` | reranking | verified | v4 document envelope succeeded in approximately 988 ms and returned a valid complete permutation |

The Voyage results prove the live v4 request and response contracts for those
exact models. They do not prove product retrieval activation, retrieval
quality, answer quality, or equivalence to the employer's embedding/reranking
models.

### Full product-triage comparison

| Agent code | Model | Result | Usefulness finding |
| --- | --- | --- | --- |
| exact RC `37905a37` | `deepseek/deepseek-v4-flash` | failed twice at the 120 s whole-turn ceiling | deterministic retrieval completed in about 0.4 s, but four candidate rounds consumed about 105 s and left no final-synthesis budget; terminal result was `linked_synthesis_timeout` |
| exact RC `37905a37` | `openai/gpt-oss-120b` | completed in about 25.1 s, about $0.00268 | grounded and partially useful: found the r17 configuration regression, propagated failures, rollback, and recovery, but withheld the initiating-cause claim, left `root_cause_established=false`, and did not cleanly isolate the telemetry decoy |
| feature lineage `b2cb84c2` | `openai/gpt-oss-120b` | completed in about 23.6 s, about $0.00265 | improved symptom and unrelated-error classification, but still withheld the correct initiating-cause claim and left `root_cause_established=false` |
| source build `73143222-dirty` with causal-agreement change later committed as `42ac0ce7` | `deepseek/deepseek-v4-flash` | completed in 74.0 s across five provider rounds, about $0.00346 | passed: established the invalid 250 ms lease window as the initiating cause, classified aborted requests as symptoms, separated telemetry as unrelated, cited rollback and recovery, and returned `root_cause_established=true` |

The diagnostic DeepSeek run reported four provider rounds in about 105.4 s,
10,867 completion tokens, 11,487 reported reasoning tokens, and approximately
$0.00310 total cost. Compatibility is therefore green while operational
readiness for the current multi-stage policy is not. This measured gap is
tracked in [issue #869](https://github.com/chriscase/ContextDesk/issues/869).

Both GPT-OSS product runs expose a separate host-contract limitation. The
known trigger, propagation, unrelated error, and recovery span the global
timeline and several candidate ledgers, while V1 only admits candidate-local
claims. The safe cross-candidate causal synthesis work is tracked in
[issue #868](https://github.com/chriscase/ContextDesk/issues/868); existing
candidate scoping must not be weakened to make this fixture pass.

### 2026-08-09 causal-conclusion acceptance

The first post-budget DeepSeek product run exposed a narrower blocker than
cross-candidate retrieval: every candidate-stage ledger row was assigned
`Neutral`, so the final validator was structurally unable to support an
initiating-cause claim even when both model stages identified the correct
configuration violation. The answer correctly named the cause but rendered it
as `[withheld]` and set `root_cause_established=false`.

Commit `42ac0ce7` replaces the free-form candidate draft with a strict
`contextdesk.candidate_assessment.v1` proposal. It binds one typed
classification and one or more exact supplied sequence numbers to the
candidate's immutable evidence scope. Unknown fields, wrong candidate ids,
empty analysis, missing/duplicate/foreign sequence numbers, fabricated
code-like identifiers, and malformed JSON fail closed. Only an
`initiating_cause` candidate assessment grants `Cause` role to the exact
selected host evidence rows; the final comparison must separately place a
claim in `initiating_causes` against those same rows before the existing answer
validator establishes the root. Candidate/final disagreement still produces a
withheld claim and `root_cause_established=false`.

The same 31-record corpus and same question were rerun through the normal CLI
product path with `deepseek/deepseek-v4-flash`. The source binary identified
itself as `73143222-dirty`; the dirty set contained this causal change plus the
separate protected-file credential work, and the causal file was committed
immediately afterward as `42ac0ce7`. The run completed all four candidate
assessments and the final comparison in 74,012 ms, reported approximately
$0.003455 total cost, and returned:

- supported initiating cause: `lease_window_ms=250` violates the supported
  minimum of 1000 ms, citing `e:template:2:1`;
- observed repeated lease expiry and epoch mismatch;
- supported symptom: `RequestAborted` because the worker was unavailable;
- competing/unrelated error: `TelemetrySinkTimeout`;
- rollback to r16 with 4000 ms and worker/API recovery;
- `root_cause_established=true`, with no `[withheld]` marker.

The complete local JSON result is
`/tmp/contextdesk-vercel-live.o3oaRs/deepseek-causal-consensus-73143222-dirty.json`.
It contains no credential or authorization header. This path is temporary and
is evidence for the refinement session, not a committed golden response. The
repository's durable tests assert causal facts, evidence binding, stage
agreement/disagreement, and fail-closed mutations rather than DeepSeek's exact
wording. The key was read into the child process environment from the protected
owner-only file; this acceptance run did not access Keychain.

### 2026-08-09 exact clean integration acceptance (`c9097cf0`)

The integrated protected-file, model-readiness, causal-agreement, retrieval-lab,
and quality-evaluation lineage was rebuilt and tested from exact clean commit
`c9097cf01434b1c8738a76681fdc59bbf08e85b9`. A fresh isolated profile referenced
the existing owner-only mode-600 Vercel key file directly. ContextDesk saved
only the `file:` reference, made no Keychain import, and the initial safe
connection check returned the authenticated Vercel v4 catalog with 321 models.
The test corpus and every direct retrieval request were synthetic.

#### Exact-model qualification

The normal CLI qualification path retained the complete catalog but returned
only the selected rows. Each run resolved the protected-file credential once
for the process.

| Exact Vercel model | Observed readiness | Important detail |
| --- | --- | --- |
| `deepseek/deepseek-v4-flash` | verified chat | generation, native tool call, tool-result continuation, structured JSON, streaming, and cancellation all passed |
| `openai/gpt-oss-120b` | verified chat | all six chat checks passed, including structured JSON and native tool continuation |
| `alibaba/qwen3.6-27b` | verified chat | all six checks passed; tool-result continuation took about 39.4 seconds, making operational latency a separate concern |
| `mistral/ministral-14b` | limited chat | generation, tools, continuation, streaming, and cancellation passed; structured output returned a non-object and failed |
| `alibaba/qwen3-embedding-0.6b` | verified embedding | v4 contract returned one valid 1,024-dimensional vector in about 753 ms |
| `voyage/rerank-2.5-lite` | verified reranker | v4 contract returned a complete permutation of the synthetic documents in about 687 ms |

These are compatibility results for Vercel's exact routes, not claims about an
employer deployment with the same or similar catalog names.

#### Ordinary and selected-context chat

DeepSeek answered an ordinary diagnostic question in one provider round and
about 4.1 seconds for approximately `$0.000272`. It separated a leading
connection-pool hypothesis, supporting evidence, an alternative, and the next
measurement without claiming CPU was evidence against waiting.

A selected-context-only synthetic incident completed in two rounds and about
12.7 seconds for approximately `$0.000853`. The answer preserved the exact
`5000 -> 300`, supported-minimum `1000`, rollback `5000`, and recovery times;
correctly separated the persistent metrics warning; and disclosed uncertainty.
It also unnecessarily called the empty `search_kb` tool before finishing. This
is a usefulness/efficiency observation, not a protocol failure.

#### Repeated full product triage

The same 31-record opaque incident and identical causal question were run
through the normal corpus-linked multi-stage product path.

| Model / attempt | Result | Latency / cost | Quality observation |
| --- | --- | --- | --- |
| DeepSeek attempt A | no validated answer persisted | observer did not retain the typed terminal | session contains only system and user messages; later retries prove the profile, credential, and corpus were sound, but this attempt's terminal cause is not recoverable and must not be guessed |
| DeepSeek attempt B | `root_cause_established=true` | 103.9 s, 17,662 tokens, about `$0.005883` | correct 250 ms versus 1,000 ms initiating cause, exact citations, rollback and recovery; downstream worker and telemetry findings remained neutral observations rather than explicit symptom/independent roles |
| DeepSeek attempt C | `root_cause_established=true` | 89.0 s, 15,389 tokens, about `$0.004988` | correct cause, exact citations, worker abort explicitly classified as symptom, rollback and recovery retained; telemetry remained a neutral observation rather than explicitly independent |
| GPT-OSS 120B | `root_cause_established=true` | 20.6 s, 9,291 tokens, about `$0.002302` | correct configuration cause was present, but epoch mismatch and worker-unavailable abort were incorrectly promoted to additional initiating causes and the persistent telemetry timeout was incorrectly called a symptom |

The current verdict is therefore more precise than a single verified badge:
DeepSeek is the preferred Vercel triage model and repeatedly establishes the
correct root, but it remains slow and its secondary-role labeling varies.
GPT-OSS is protocol-compatible and much faster, but this live answer is not
acceptable as an evidence-disciplined incident explanation.

The GPT-OSS response shape was translated into a hermetic evaluator mutation:
one correct initiating cause plus a symptom promoted to cause plus an
independent incident demoted to symptom. The current scorer falsely passed that
combined answer even though its existing isolated mutations catch the two
mistake classes separately. The temporary red test was removed from the clean
integration worktree and handed to an isolated Grok implementation lane with
an exact reproducer. Until that general scorer fix is reviewed, compatibility
qualification must not be presented as answer-quality verification.

#### Live embedding and reranking quality

The corrected v4 document envelope completed the public-safe seven-query
benchmark twice with no warnings. Aggregate values were stable across the two
runs; the retained aggregate-only run observed:

| Lane | Shape | Relevant recall at K | Must-include recall at K | Must-exclude share at K | Latency |
| --- | --- | ---: | ---: | ---: | ---: |
| Qwen embedding | plain | 0.5881 | 0.5595 | 0.0408 | 1.72 s total |
| Qwen embedding | evidence terms | 0.5988 | 0.5238 | 0.0571 | same batch |
| Qwen embedding | structural | 0.5881 | 0.5595 | 0.0000 | same batch |
| Voyage reranker over the full candidate set | plain | 0.7286 | 0.5952 | 0.0490 | 1.96 s total |
| Qwen shortlist plus Voyage rerank | plain | 0.6988 | 0.5595 | 0.0408 | 1.72 s embed + 6.09 s rerank |
| Qwen shortlist plus Voyage rerank | evidence terms | 0.6988 | 0.6667 | 0.0490 | same run |
| Qwen shortlist plus Voyage rerank | structural | **0.7464** | **0.6667** | 0.0490 | same run |

Qwen returned 1,024-dimensional vectors with 1,896 usage tokens. The neutral
structural prefix outperformed the answer-adjacent evidence-terms prefix, which
is useful evidence against relying on fixture-shaped instruction leakage.
However, at least one opaque independent-error query had zero relevant and
must-include recall in the plain combined path, and concurrent-incident cases
admitted must-exclude items. The result supports further hybrid experiments;
it does not justify unconditionally enabling remote semantic retrieval or
allowing it to evict deterministic safety evidence.

#### Failure and credential boundaries

- A symlink passed as `--api-key-file-ref` failed before provider contact with
  `protected credential file must not be a symbolic link`; no provider config
  was written.
- An intentionally nonexistent model failed with typed CLI exit 6 and a
  scrubbed provider error. No provider response body, authorization data, or
  credential appeared.
- `doctor --skip-live-turn` passed configuration, writable-state, and live
  Vercel catalog connectivity. Its overall `ready=false` verdict is expected
  because the turn/grounding/tracing/continuity checks were explicitly skipped.
- The first full live doctor run passed native tools, grounding, tracing, and
  connectivity but exposed a contradictory continuation prompt: it asked the
  linked second turn to use only prior results even though every linked turn
  must perform a fresh bounded log read. The next run proved the continuity
  fix but DeepSeek then used mismatched citation identities in turn one, which
  the host correctly withheld. Commit
  `8009e0dc5284cdabb4b4962b57cd5b3bf9963e4f` now explicitly requests a fresh
  second-turn log search and the exact `seq=N` plus `source="..."` citation
  form. Seven focused prompt/continuity unit tests, all 16 doctor acceptance
  tests, and strict CLI Clippy pass. The source-built live rerun then passed
  all eight doctor checks in 17.4 seconds: configuration, writable state,
  native tool use, grounded evidence, tracing, persisted session continuity,
  cleanup, and Vercel connectivity.
- Passive `models` status reported `offline=true` and
  `credentials_read=false`; explicit discovery and verification reported the
  credential read honestly.

The durable record deliberately retains exact synthetic prompts, safe semantic
claims, role outcomes, model identifiers, dimensions, ranking aggregates,
latency, token, cost, and typed failures. It excludes the key, authorization
headers, vectors, provider error bodies, and temporary raw response dumps.

### 2026-08-09 sanitized real-corpus acceptance

The old development-log archive supplied for acceptance remained untouched in
Downloads. A temporary extraction was scanned before egress. Two exported
event files contained repeated password-shaped content, so only the temporary
copy was replaced with `<REDACTED>` and rescanned; the original archive was not
modified. No raw corpus, provider body, credential, hostname inventory, or
event dump was committed.

The isolated import completed in about 7.4 seconds:

- 33,723 events from 154 selected files (294 discovered files);
- 354 mined templates;
- 33,553 syslog records and 170 plain-text records;
- no source failures and no partial-import flag.

Declaring `America/Chicago` for 133 sources changed the active timestamp basis
from 99 explicit-wall plus 33,454 unresolved-local and 170 order-only records
to 99 explicit-wall, 25,694 resolved-local, 7,930 order-only, and 7,760 still
unresolved-local records. The deterministic logging-assessment score rose from
51 to 67. The exception analyzer found 700 exception-shaped records and 256
rendering occurrences, but 235 conflicting groups and no strong derived groups;
it correctly refused to publish certified duplicate-incident totals. Running
two corpus commands concurrently also exposed the existing DuckDB single-writer
lock boundary; the same commands pass sequentially.

Live DeepSeek refinement used the normal CLI product path, the isolated
profile, the protected `file:` credential reference, and no Keychain access.
The important sequence was:

| Runtime policy / refinement | Result | Evidence learned |
| --- | --- | --- |
| former 120-second adaptive ceiling | one diffuse 116.6-second answer before timezone resolution, followed by two typed synthesis deadlines | candidate work could consume the final-comparison budget; compatibility was not the failure |
| temporary explicit 240-second proof ceiling | grounded success in 130.5 seconds, five provider rounds, 24,899 tokens, about `$0.007128` | repeated persistence/JDBC connection failures were recoverable as a strong candidate, but two canonical candidate citations were content-free |
| 180-second adaptive ceiling before partial-candidate handling | candidate-contract failure at 75.4 seconds, four rounds, about `$0.003342` | one malformed candidate response unnecessarily withheld otherwise valid drafts |
| 180-second ceiling with v2 reserve and partial-candidate handling | grounded success in 159.5 seconds, five rounds, 21,208 tokens, about `$0.006233` | the reserve protected comparison, but high-volume placeholder-only templates crowded the stronger database candidate out of the admitted drafts |
| final literal-signal candidate selection | grounded success in 115.9 seconds, five rounds, 23,057 tokens, about `$0.006832` | all four substantive candidates validated; comparison passed on its first attempt with 105.6 seconds remaining at comparison start |

The final answer used canonical excerpts for every admitted candidate. It
identified repeated `ERROR CODE=2000` login/decryption failure as an initiating
cause, kept repeated persistence/JDBC connection failures as a separate
unresolved causal candidate, classified remote disconnects as symptoms, and
treated scheduled suspension as a competing/non-error explanation. It stated
that the partial global timeline did not establish a complete causal chain.
This is a useful, host-grounded answer on a 33,723-event corpus; it is not a
claim that every initiating cause in the archive was proven, nor a substitute
for employer-gateway acceptance.

The live-derived product changes are intentionally provider-agnostic:

- the managed-provider adaptive default is 180 seconds while explicit user
  ceilings remain authoritative;
- budget policy `contextdesk.multi_stage_budget.v2` reserves half the bounded
  turn for final comparison and caps each candidate against that reserve;
- an invalid candidate is excluded from the immutable ledger and reported by a
  content-free validation category; comparison may continue only with at least
  two independently validated drafts;
- placeholder-only mined templates remain deterministic/global evidence but do
  not consume one of the four candidate calls;
- candidate ledger entries retain redacted bounded excerpts, falling back to
  the selected event message when template metadata is absent or content-free.

A manually cancelled JSONL run piped through `jq` exited with status 130 as
requested but also printed a Rust broken-pipe panic while stdout was closing.
This is a separate CLI pipe/cancellation robustness follow-up, not a provider,
grounding, or Keychain failure.

### Discovery and CLI output lesson

Vercel discovery returned the full account catalog successfully. An exact
one-model verification initially repeated that entire inventory in its final
output, producing an unnecessarily huge response even though only one model
was selected. The pending CLI refinement keeps the complete catalog persisted
for status and discovery, but returns only selected rows for targeted
verification and caps the ordinary human-readable inventory at 30 rows with
explicit narrowing guidance. JSON status/discovery continues to expose the
complete saved inventory.

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

## Direct Grok Build capability and evaluator results

ContextDesk's direct `xai_grok_build` provider is operational independently of
Vercel and ContextDesk Keychain items. It reuses the user's opted-in Grok Build
session, keeps the API host pinned, and was exercised through the shared Rust
provider/agent path. A direct provider doctor on configured alias `grok-4`
passed model listing, native tool call, grounded cited answer, tracing, session
continuity, and cleanup in 23.9 seconds. Live responses identified themselves
as `grok-4.3`.

Grok was also used as a blind qualitative judge for eight anonymized preserved
Vercel answers. Mapping was revealed only after scoring:

- DeepSeek V4 Flash runs A/E/G: 22/22 each, no penalty;
- Qwen 3.6 27B run D: 22/22, no penalty;
- Ministral runs B/F: 19/22, H: 18/22, chiefly weaker citations and activation
  contradiction handling;
- GPT-OSS run C: 15/22 before a five-point unsupported-inference penalty and
  failed because it invented a telemetry backlog explanation and contradicted
  its own telemetry classification.

This judgment is not truth authority; the committed event key remains the
oracle. It supports the existing interpretation that DeepSeek is the current
economical Vercel synthesis leader, Ministral is a useful faster pass, and
GPT-OSS should not be the default final synthesizer for this incident shape.

## Matched direct-Grok app diagnosis and refinement

The complete 31-record incident was imported into the normal ContextDesk data
store as corpus `[owner-local corpus id]`. Before the handoff fix,
the app's five-call Grok multi-stage run retrieved 17 evidence identities but
produced `root_cause_established=false`, omitted rollback/recovery, and treated
the boundary violation as only a competing explanation. A one-call Grok control
given 15 compact decisive rows correctly returned the invalid r17 250 ms lease
window, lease expiry, worker/API propagation, r16 4000 ms restoration and
recovery, persistent independent telemetry, and the unresolved invalid-r17
activation. Model capability was therefore not the bottleneck.

Source audit found the exact loss: `run_multi_stage_broad_triage` created final
drafts and `HostEvidenceLedger` solely from admitted ERROR/correlation
candidates. The final manifest had no identity path for ordinary configuration,
rollback, or observed-recovery rows. Every ledger row was also `Neutral`, so an
established root-cause boolean was impossible by design.

Commit `ca05ea92` adds a separately scoped
`global_timeline_context` without an extra provider request:

- at most 32 unsuppressed, non-candidate redacted rows;
- complete for small corpora, including the 31-record incident;
- for larger corpora, honest partial selection using stable sequence endpoints
  plus fairly interleaved neighbors around candidate anchors;
- exact corpus/revision/digest binding, canonical source/seq/content citations,
  active suppression, a reserved scope id, and candidate-disjoint evidence;
- a nonce-bound untrusted-data wrapper minted once and replayed byte-for-byte on
  semantic correction;
- all new evidence remains `Neutral`; order, adjacency, repair, and recovery
  wording grant no host causal authority;
- the same context enters single-model and optional review-mode ledgers, while
  consuming no investigator/reviewer/synthesizer round.

One source test caught and fixed a real cursor defect during refinement:
`u64::MAX` wrapped to `-1` when bound to DuckDB's signed sequence column and
would omit the true tail. The sampler now uses the signed maximum and a large
fixture asserts both sequence endpoints.

Live post-fix acceptance through direct Grok completed in the same five
provider calls (43.1 seconds, about 13K context characters). The typed answer
now cited r17 start/activation, the boundary violation, rollback request, r16
4000 ms restoration, worker recovery, API recovery, and telemetry persistence
as a competing explanation. It honestly retained `Root cause established: no`.
The qualitative Grok judge scored configuration/mechanism 3/4, propagated chain
2/4, rollback/recovery 4/4, telemetry separation 4/4, contradiction 3/4,
citations 3/4, and readability/actionability 2/4.

The remaining weakness is not missing retrieval: the permitted global ledger
contained all three `LeaseWindowExpired` rows, but final synthesis did not cite
them or render a compact cross-scope chain. Three raw one-call prompt variants
showed that stronger narrative pressure is unsafe under V1. Grok transferred a
`LeaseWindowExpired` fact into a template-5 claim whose cited rows contained
only `LeaseEpochMismatch`, and another variant described the boundary violation
while citing a stack-frame row. The current validator correctly confines ids to
candidate scopes but does not prove semantic entailment between claim text and
excerpt. Do not solve this with a more aggressive prompt. A later typed
cross-candidate comparison contract or semantic claim-evidence validator is
required.

## Grok-assisted embedding/reranking refinement loop

Use Grok as a cheap qualitative judge after deterministic retrieval scoring,
not as the retrieval oracle. For each frozen query and answer key:

1. produce evidence packets with structured/keyword baseline, local embedding,
   Vercel embedding, reranking, and combined modes when their security gates are
   satisfied;
2. enforce host-side must-include and must-exclude IDs, stable ID mapping,
   shortlist caps, dimension/model binding, and deterministic degradation;
3. score recall, initiating/repair/recovery coverage, foreign-incident leakage,
   shortlist precision, latency, calls, and cost before any model judgment;
4. give anonymized packets to direct Grok to explain what answer each packet
   supports and what decisive evidence is missing;
5. optionally synthesize from each packet with the same fixed model, then have a
   separate Grok session grade correctness against the host truth key;
6. convert every discovered omission, foreign-ID admission, or response-shape
   defect into a hermetic regression fixture.

Grok judgment never overrides must-include/must-exclude truth or turns a
plausible answer into a retrieval pass. This loop is specifically intended to
prevent lexical-overlap and full-corpus rerank false greens.

The first hermetic hardening pass now implements the deterministic half of
that loop:

- every query in the direct retrieval fixture declares a bounded
  `shortlistK` and explicit `mustExcludeIds`, including the telemetry-versus-
  amber-sync and cache-versus-payments incident boundaries;
- standalone embedding and full-corpus reranker results remain diagnostic
  controls, while a new combined run sends only the embedding shortlist to the
  reranker and reports upstream recall, final recall, must-include recall, and
  foreign-incident leakage separately. Dataset validation requires the
  shortlist to be smaller than the corpus, and a local mock-gateway test checks
  the exact two-document request and shortlist-relative index mapping;
- stable host document ids remain the only identity used to map provider
  ranking indices back into truth scoring;
- the hybrid engine now validates exactly one finite score per submitted row
  at its consumer boundary, independent of adapter behavior. Too few, too many,
  NaN, or infinite scores produce `rerank_invalid_response`, receive no model
  credit, and preserve the exact pre-rerank order. The HTTP adapter also
  rejects duplicate indices, and an empty candidate set makes no call and
  grants no reranker credit;
- retrieval status applies the same score-vector contract when classifying a
  probe response.

Direct Grok ranked response-shape enforcement, shortlist loss, and explicit
foreign-incident leakage as the leading risks and proposed these same hermetic
checks. Its suggested numeric recall delta was not adopted as a release
threshold: thresholds require measured baseline evidence, not evaluator
preference. A first diff audit then caught an overstated test name and a
dataset-validation path that still allowed `shortlistK == document_count`;
both were corrected, and the missing exact-request test was added. Separate
final Grok audits of the engine and lab diffs reported no actionable findings.

Final hermetic verification for this pass: direct lab 10/10, rerank-focused
core tests 13/13, full core library 1,827 passed with 0 failed and 5 intentional
ignores, full workflow library 62/62, strict all-target core/workflow clippy,
format, and diff checks all pass. No Vercel credential or live retrieval
endpoint was used. Live combined measurements remain pending a stable
non-Keychain credential path or an explicitly approved interactive run.
Query-time cloud embedding/reranking remains inactive; this work does not grant
content-egress consent.

### Live local embedding observation

The already-running local Ollama service exposed a real embedding-capable
`nomic-embed-text:latest` model. No process or model download was started. On
the seven-query direct fixture, the exact single-prompt `/api/embeddings` wire
used by ContextDesk completed 62 calls in 1,738 ms, returned consistently
finite 768-dimensional vectors, and produced these deterministic host scores:

| Query shape | Mean relevant recall@K | Mean must-include recall@K | Explicit must-exclude hits |
|---|---:|---:|---:|
| plain | 0.592 | 0.524 | 0 |
| generic evidence prefix | 0.481 | 0.417 | 1 |
| generic structural prefix | 0.535 | 0.452 | 1 |

The generic prefixes are therefore harmful for this model and dataset. A
second 192-call / 3,615-ms request-shape comparison tested `search_query:` and
`search_document:` markers without changing truth:

| Marker shape | Mean relevant recall@K | Mean must-include recall@K | Explicit must-exclude hits |
|---|---:|---:|---:|
| none | 0.592 | 0.524 | 0 |
| query only | 0.592 | 0.524 | 0 |
| document only | 0.610 | 0.560 | 0 |
| matched document/query | 0.610 | 0.560 | 0 |

The small gain came from better opaque rollback/configuration coverage. It did
not recover either telemetry record for the independent-failure query or the
decisive multilingual trigger/recovery rows. Do not hard-code model-name
behavior from this result. If configurable asymmetric shaping is later added,
the shaping contract must be part of the stored vector-space identity so an
old document index cannot appear compatible with differently shaped query
vectors merely because the configured model name matches.

Direct Grok reviewed the actual top-K text packets after host scoring. It found
the database packet useful; the cache packet lacked the explicit cache-thrash
row; the payments packet lacked the expired-certificate initiating record; the
fatal-only packet correctly left mechanism/correction/recovery unknown; and the
root-chain, independent-telemetry, and multilingual packets were materially
incomplete. Grok also mislabeled the downstream catalog-latency record as an
initiating mechanism before acknowledging that the cache-thrash record was
missing. That internal category error is retained as evaluator evidence: Grok
is valuable for packet critique, but cannot replace typed roles or the host
truth key.

No local reranker model is installed, and completion model `mistral:latest` was
not relabeled or used as one. This local embedding result is not good enough to
activate a semantic-only path. The next meaningful quality comparison is the
same combined-shortlist experiment with a genuinely multilingual embedding
model such as the employer-provided BGE-M3 and a proven reranker, while keeping
the structured/timeline lane and explicit foreign-incident scoring.

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
| `deepseek/deepseek-v4-flash` | Exact name match | 3/3 refined repeats correct, telemetry independent, contradiction unresolved, no invented bypass | 14.4 s | $0.000351 | Direct one-round synthesis leader; not operationally ready for the current multi-stage policy |
| `mistral/ministral-14b` | Same Ministral 3 14B family/date; exact employer instruct variant not proven | Main chain 3/3; 2/3 evidence-disciplined; one run falsely said validation blocked activation | 5.0 s | $0.000418 | Fast first pass, not trusted final verdict without verification |
| `openai/gpt-oss-120b` | Exact match | Main cause usually correct; refined run violated explicit telemetry-separation guardrails and contradicted itself | about 5.6 s in matched baseline | about $0.00063 | Fast product-triage baseline; current host contract still withholds the cross-candidate cause |
| `alibaba/qwen3.6-27b` | Exact name match | One strong run; correct chain and independent telemetry | 27.8 s | $0.005471 | Correct but poor cost/latency fit for this text-only task; needs more evidence before quality claims |

The employer's `Mistral-Small-24B-Instruct-2501-FP8-dynamic` has no exact
Vercel match found. Vercel's generic `mistral/mistral-small` is an older 22B
model and must not be represented as the employer build.

## Current ContextDesk retrieval implementation truth

- The broad-log triage brief intentionally performs no semantic/embedding or
  network retrieval.
- `retrieval-status` and a host-neutral `hybrid_search` entry exist, but desktop
  activation is not wired.
- The production embedding role now has explicit `openai_embeddings` and
  `vercel_v4_embeddings` dialects backed by shared adapters. Both support
  protected bearer-file references, bounded batches, finite-vector checks,
  homogeneous dimensions, and fail-closed response validation. Vercel's v4
  route is selected only by its explicit dialect and exact gateway host; it is
  never inferred from a model name.
- Legacy roles without a dialect retain Ollama behavior only for the
  conventional local Ollama port; other endpoints must opt into the
  OpenAI-compatible dialect.
- The production reranker backend speaks explicit `tei_rerank_v1` and
  `vercel_v4_rerank_v1` dialects. The latter uses Vercel's nested document
  envelope, `topN`, selection headers, and complete ranked-row permutation,
  converting scores back to input order without losing score semantics. Both
  support protected credentials, bounded documents, malformed-response
  rejection, and pre-rerank fallback on failure or timeout.
- The benchmark's real BGE-M3/Qwen reranker lanes remain honestly marked
  `FUTURE_CAPABILITY_UNAVAILABLE`. Synthetic synonym and reranker adapters are
  test fixtures, not proof of real semantic capability.
- Imported corpus `[owner-local corpus id]` currently has zero
  embedded templates and selects `structured_keyword` mode.

## Vercel retrieval capability findings

- Vercel AI Gateway now advertises embeddings and reranking.
- Vercel exposes OpenAI-compatible embeddings through its `/v1` API.
- The authenticated live catalog (2026-08-09, 561 ms) returned 31 retrieval
  models. The employer's exact `bge-m3` model is not present in that catalog.
- Vercel does expose `alibaba/qwen3-embedding-0.6b`: 1024 dimensions, roughly
  32.8K context, multilingual, instruction-prefix support, and very low input
  cost. It is an experimental substitute, not an employer-model equivalence.
- The employer's exact `qwen3-reranker-0.6b` is also absent from the live
  catalog. Vercel exposes Cohere and Voyage rerankers instead. Do not use them
  as employer-equivalence claims.
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
  `ai-model-id: <model>`. The body uses the v4 document envelope
  `{"documents":{"type":"text","values":[...]},"query":"...","topN":...}`
  and the response contains
  `{"ranking":[{"index":...,"relevanceScore":...}]}` plus optional warnings
  and provider metadata.
- Live embedding choices include Qwen3 0.6B/4B/8B, Amazon Titan, Cohere Embed,
  Gemini/Google text embeddings, Mistral, OpenAI, Perplexity, and Voyage.
  Live reranking choices are Cohere Rerank 3.5, Rerank 4 Fast, Rerank 4 Pro,
  Voyage Rerank 2.5, and Voyage Rerank 2.5 Lite. This confirms the static SDK
  families for this gateway account while also confirming that the employer's
  exact BGE-M3/Qwen pair cannot be evaluated through Vercel.
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

### First live retrieval contract result

- A live synthetic benchmark using `alibaba/qwen3-embedding-0.6b` and
  `voyage/rerank-2.5-lite` passed catalog discovery and the complete embedding
  response validator, then reached the reranking call. This is evidence that
  the selected v4 embedding transport and response shape work; the process
  aborted before emitting quality aggregates, so it is not yet an embedding
  quality result.
- The first Voyage Lite reranking request returned HTTP 400. The lab correctly
  withheld the provider body. A follow-up inspection of the official SDK's
  request-body test found the cause without another live request: v4 requires
  `documents: {"type":"text","values":[...]}`, while the first lab version
  sent a bare string array in `documents`. The endpoint, model id, version
  header, query, and camel-case `topN` were otherwise correct. This was a lab
  request-contract failure, not a reranker-quality failure.
- The isolated source now emits the official nested document envelope. Its
  eight focused tests cover the live catalog shape, embedding response and
  usage parsing, the exact rerank request envelope, rerank response validation,
  and stable host-id mapping; all pass, and strict binary-target clippy remains
  clean. These checks did not launch the lab, read Keychain, contact Vercel, or
  change the preserved stable launch executable. At that point, a stable
  direct-request authentication path remained a prerequisite; the later
  successful live role-contract probes are recorded above.
- A two-document isolation probe was prepared, but repeated macOS Keychain
  dialogs made further executable launches a worse diagnostic path than the
  contract question warranted. The orphaned lab and SecurityAgent processes
  were stopped, and no further Keychain-driven probe is authorized in this
  refinement loop.

### Authentication and macOS execution lesson

- Keyring 3.6.3 makes one `find_generic_password` call, and the ContextDesk
  backend makes one credential lookup per single-model run. Multiple visible
  dialogs must not be attributed to the investigation's six stages.
- The repeated prompts correlate with separately built/changed unsigned
  development executables and overlapping external attempts. macOS can treat
  those as different requesting identities even when the source command has
  the same name. This explains why constant rebuild-and-run iteration is a poor
  retrieval experiment loop; it does not justify redesigning the secret
  architecture around a false per-stage reload diagnosis.
- Direct provider experiments remain the preferred learning loop. A protected
  local credential file is now available for the owner-approved synthetic
  experiments and can be injected into one child process without exposing the
  value. This avoids new-binary Keychain prompts; it must not be copied into
  repository files, command arguments, captured output, or evidence records.
- Vercel supports short-lived OIDC authentication for local development via a
  linked project and `vercel env pull`/`vercel dev`. That is the clean candidate
  for frequent direct experiments because it avoids repeatedly asking a newly
  built binary to access a long-lived Keychain item. Linking a project or
  installing/configuring the CLI is an explicit owner setup decision, not an
  automatic side effect of this branch.

## Independent heavy audit

A read-only Claude Code audit completed at Fable 5 / Extra effort. It was
asked to inspect the journal, production retrieval path, configuration,
benchmarks, and fixtures; challenge the adapter assumptions, privacy and
Keychain boundary, data/query shapes, must-include merge, ablation design, and
false capability risks; and recommend the smallest safe production sequence.
Claude was explicitly prohibited from editing files, making live credentialed
requests, committing, or pushing.

The following high-priority findings were subsequently checked directly in the
worktree and confirmed:

- **Stored/query vector compatibility is now fail-closed.** `EmbedBackend`
  carries a backend identity, corpus status binds identity and dimensions, and
  a mismatch withholds semantic results and model credit. This is covered by
  hermetic identity/dimension regressions and applies to the shared Vercel
  adapter as well as OpenAI-compatible and local backends.
- **Semantic score order is now preserved before RRF.** Template hits are
  expanded under one total budget in semantic-score order, and the hybrid
  engine retains per-lane ranks before fusion. The old chronological-expansion
  confounder is covered by a regression test.
- **The generic TEI reranker path-prefix bug is fixed.** `/v1` is preserved
  with or without a trailing slash, and Vercel v4 now has its own explicit
  score-preserving adapter rather than being parsed as TEI.
- **Query-time cloud egress is now default-deny.** Each configured retrieval
  role has an explicit `allow_remote` acknowledgment. A non-loopback endpoint
  without it is reported as `egress_not_acknowledged`, is blocked before
  backend construction or credential lookup, and leaves the structured/keyword
  baseline usable. Loopback Ollama remains local without an acknowledgment.
  This is a consent boundary, not evidence that a remote model is useful.
- Remaining honesty boundary: configured role identity, endpoint health, and
  protocol compatibility are still not live quality evidence.

The gateway-native v4 routes are now represented by shared production adapters
and remain separately selectable from the OpenAI-compatible dialect. The
standalone lab remains useful for direct wire/quality experiments, but its
results must not be confused with product-path quality evidence.

The direct probe/quality lab is intentionally independent of stored product
vectors and the product fusion engine, so it can measure raw embedding and
reranking behavior. The six-lane hermetic ablation now executes through the
corrected product seams with synthetic adapters; real BGE-M3/Qwen/Vercel
quality remains pending live, consented runs and separate answer scoring.

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

The probe's unit tests (8/8) and strict binary-target clippy pass. The live
catalog completed and a Qwen3 0.6B embedding response passed validation. The
first Voyage Lite reranking request returned HTTP 400 as recorded above. No
additional Keychain-reading lab executable should be launched during this
refinement loop; continue only after establishing a stable direct-request
authentication path.

## Isolated production-integrity refinement

The Claude audit was followed by direct source review and a bounded
implementation in this experiment branch. Claude's partial implementation was
not accepted on trust: it was completed and tested locally. The isolated
implementation is committed locally, not pushed, merged, or released, and now
does the following:

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
- Vercel v4 embedding and reranking specialty-envelope adapters, including
  malformed-response rejection: pass.
- fixed-corpus six-lane synthetic ablation (20 cases / 142 queries): pass.
- strict `cd-core` + `cd-workflow` library clippy with warnings denied: pass;
- full `cd-core` library suite: 1,824 passed, 0 failed, 5 intentionally
  ignored.

This removes known structural confounders before production ablation. It does
not constitute a live Vercel embedding/reranking quality result, a desktop
activation, or consent for production cloud egress.

## Next actions

1. Keep the committed global timeline-context refinement and the retrieval
   hardening pass isolated for owner review. Preserve the live acceptance
   output and do not merge, push, or release automatically.
2. Complete full source gates for the combined-shortlist benchmark and strict
   reranker response validation, then commit the pass locally.
3. Produce anonymized evidence packets from hermetic/local runs and use direct
   Grok only as the qualitative packet and answer judge after deterministic
   host scoring.
4. Keep using the protected file-backed child-process override for authorized
   synthetic live work so development rebuilds do not reopen Keychain dialogs.
   A future short-lived Vercel OIDC path remains preferable for repeatable
   shared development.
5. Treat the successful live Voyage embedding and reranking probes as wire
   contract evidence only. Do not claim retrieval quality until the hermetic
   harness can attribute retrieval, reranking, and generation separately.
6. Run the direct seven-query synthetic benchmark with
   `alibaba/qwen3-embedding-0.6b` plus the first proven economical reranker.
   Record model identity, vector dimensions, response indices, scores,
   latency, calls, usage, and bounded quality aggregates without recording
   vectors, request text, credentials, or provider error bodies.
7. Use those results to select query/document shape and shortlist size, then
   run the identical four-mode product ablation on the corrected engine.
8. Add an explicit query-time content-leaves-machine gate before any remote
   embedding or reranking adapter can be activated outside the isolated lab.
9. Evaluate the slow-model budget/reserve policy from issue #869 and the
   cross-candidate causal contract from issue #868 independently; neither
   should weaken the existing whole-turn ceiling or candidate evidence rules.
10. Run focused and full repository gates and hand off the isolated branch for
    owner review; do not merge or release automatically.
