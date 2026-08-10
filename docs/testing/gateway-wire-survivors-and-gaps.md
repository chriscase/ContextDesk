# Gateway Wire Conformance Lab — Defects, Fixes, and Remaining Gaps

Companion to `docs/testing/GATEWAY_WIRE_CONFORMANCE_LAB.md` and
`docs/testing/gateway-wire-coverage-v1.json`. This file is the durable
record of what this lab actually found: real defects it fixed, defects it
proved-but-left-alone with justification, and gaps it documented rather
than invented coverage for.

## Defects found and fixed

The first four were discovered by the original hermetic lab. The final two
were isolated from a live acceptance trace, then reproduced and pinned with
the same scripted gateway before promotion. Each fix is provider-neutral and
has a regression test that fails against its pre-fix behavior.

### Defect A — premature stream close fabricated a completed answer

**Symptom.** If an SSE stream's connection closed after delivering partial
content but before a `finish_reason`/`[DONE]`, both the OpenAI-compatible
and Anthropic stream accumulators returned `Ok(ChatCompletion { .. })` —
a fabricated success built from whatever partial content had arrived,
indistinguishable from a genuinely complete answer.

**Root cause.** `StreamAccumulator::into_completion` had no way to know
whether the stream had actually reached a completion signal versus simply
running out of bytes; it built a `ChatCompletion` from whatever state it
held regardless.

**Fix.** Added a `saw_done: bool` field to `StreamAccumulator`, set when a
`StreamDelta::Done` is observed. `into_completion` now returns
`CoreResult<ChatCompletion>` and fails closed (`if
self.finish_reason.is_none() && !self.saw_done { return Err(..) }`) before
building the completion. Both call sites (`accumulate_openai_sse`,
`complete_stream_cb`) updated to propagate the `Result`.

**Proving tests.**
`premature_close_after_partial_content_is_reported_as_an_error_not_a_completion`,
`anthropic_premature_close_after_partial_content_is_also_an_error`
(`gateway_wire_streaming.rs`).

**Behavior change.** A stream that closes mid-answer now returns an error
instead of a truncated-looking success. No existing passing test depended
on the old fabricated-success behavior (confirmed by the full pre-existing
`cd-core`/`cd-workflow` regression suite — see Verification below).

### Defect B — Anthropic mid-stream error events were silently dropped

**Symptom.** An Anthropic SSE stream that emitted an in-band `error` event
partway through (matching the real Anthropic API's own error-event shape)
was silently ignored; the accumulator kept whatever content had arrived
before the error and returned it as a normal success.

**Root cause.** `accumulate_anthropic_sse`'s event-type match arm for
`"message_stop" | "content_block_stop" => {}` had no arm for `"error"` at
all, so it fell through to the wildcard no-op arm.

**Fix.** Split the combined arm apart; added a dedicated `"error" => { ..
return Err(..) }` arm before the wildcard, and a `saw_finish_signal: bool`
tracked separately from message content so a stream that never reaches
`message_stop` (with or without an explicit error event) also fails closed.

**Proving tests.**
`anthropic_error_event_midstream_aborts_and_does_not_fabricate_success`,
`anthropic_error_event_without_an_explicit_event_line_is_still_caught`
(`gateway_wire_streaming.rs`).

**Behavior change.** An in-band Anthropic stream error now surfaces as
`Err(..)` with the provider's error message, instead of a silent partial
success.

### Defect C — non-unique tool-call ID fallbacks could collide

**Symptom.** When a provider omitted `id` on more than one tool call in the
same response (OpenAI-compatible non-streaming and streaming, and
Anthropic non-streaming), every missing ID fell back to the same literal
placeholder (`"call"` / `"toolu_unknown"`), so two distinct tool calls in
one response became indistinguishable by ID.

**Root cause.** `parse_openai_completion` and `parse_anthropic_completion`
used `.unwrap_or("call")` / `.unwrap_or("toolu_unknown")` — a constant, not
a function of position.

**Fix.** Iterate with `.enumerate()` and fall back to
`format!("call_{idx}")` / `format!("toolu_{idx}")` — same shape, now unique
per position within the response.

**Proving tests.**
`missing_ids_do_not_collide_into_the_same_placeholder_non_streaming`,
`missing_ids_do_not_collide_across_stream_deltas` (`gateway_wire_tools.rs`).

**Behavior change.** Multiple tool calls with omitted IDs in the same
response now get distinct synthesized IDs instead of colliding on one
shared placeholder. Any downstream code keying state by tool-call ID (e.g.
matching a tool result back to its call) is the direct beneficiary; no
existing test asserted the old colliding behavior.

### Defect D — Anthropic error envelope accepted as an empty success

**Symptom.** A non-streaming Anthropic response with HTTP 200 and a
`{"type": "error", "error": {...}}` body — matching Anthropic's real error
envelope shape — parsed as `Ok(ChatCompletion { content: "", finish_reason:
"end_turn", .. })`: a complete, silent, empty success, not merely a
degraded message.

**Root cause.** `parse_anthropic_completion` had no check for the error
envelope shape at all before proceeding to read `content`/`stop_reason`
fields that simply don't exist on an error body, defaulting everything to
empty/absent.

**Fix.** Added an explicit check at the top of `parse_anthropic_completion`:
`if v.get("type").and_then(Value::as_str) == Some("error") { return
Err(..) }`, using the error body's own message text.

**Proving test.**
`anthropic_error_envelope_is_rejected_not_silently_accepted_as_an_empty_success`
(`gateway_wire_chat.rs`; renamed from its original, pre-fix-accurate name
`..._is_silently_accepted_as_an_empty_success` once the fix made the old
name describe behavior that no longer occurs).

**Behavior change.** An Anthropic error envelope now surfaces as `Err(..)`
with the real error message, instead of a silent empty success that a
caller could easily mistake for "the model answered with nothing."

### Defect E — provider transport timeout ignored the host turn budget

**Symptom.** A user-authorized patient turn could still lose an otherwise
valid provider operation at 120 seconds. The router accepted and preserved a
larger explicit whole-turn deadline, but the OpenAI-compatible and Anthropic
HTTP clients were always constructed with an unrelated fixed 120-second
request timeout.

**Root cause.** `backend_for` had no timeout input, so
`OpenAiCompatibleClient::new` / `AnthropicClient::new` could not inherit the
sanitized `TurnDeadlinePlan` already owned by `research_turn`.

**Fix.** Added timeout-aware client constructors and
`backend_for_with_timeout`. The production turn path passes its sanitized
whole-turn ceiling into provider construction. Per-phase and per-operation
host races remain authoritative and normally expire first; the HTTP layer no
longer imposes a shorter, hidden ceiling on an explicitly patient turn.
Standalone discovery and probe callers retain the bounded 120-second default.

**Proving tests.**
`turn_owned_transport_timeout_allows_a_patient_non_stream_operation` and
`configured_transport_timeout_still_bounds_an_unresponsive_operation`
(`gateway_wire_latency_cancellation.rs`).

### Defect F — one failed operation could replay the full prompt

**Symptom.** `OpenAiBackend::complete` first issued a streaming request even
though its contract was non-streaming, then replayed the same prompt with
`stream=false` after nearly any error. `complete_streaming` performed the same
automatic replay. A slow operation could therefore spend roughly one full
transport timeout twice, conceal the original failure, and charge the gateway
for two requests.

**Root cause.** Streaming capability fallback was implemented as catch-all
error recovery inside the backend instead of being an explicit, verified
profile capability decision.

**Fix.** `complete` now makes exactly one non-streaming request.
`complete_streaming` makes exactly one streaming request and surfaces any
failure. A profile verified with `capabilities.stream=false` continues to use
the existing `CapabilityAwareBackend` non-stream path directly; no runtime
transport error launches a second protocol attempt.

**Proving tests.**
`non_stream_completion_failure_is_not_replayed_through_streaming` and
`streaming_transport_failure_does_not_launch_a_non_stream_replay`
(`gateway_wire_latency_cancellation.rs`).

## Documented gaps (proven, not fixed)

Each of these has a passing test that proves the current, real behavior —
not a guess — with a clear reason it was left alone.

### 1. Outer-race timeout/cancellation drops telemetry — **FIXED**

**What (historical).** Production wraps every provider round in `agent.rs`'s
`pub(crate) within_turn_deadline_with_cap`: a `tokio::select!` between the
operation and a cancellation/deadline watcher. When the *deadline* branch
won (not the operation), the operation future was dropped without ever
resolving. `TracingChatBackend` only recorded after its inner future
resolved — so a round dropped this way produced **zero** `TracedCall`
entries, even though `agent.rs`'s `used_rounds` budget accounting still
charged for the round. `provider_round_count` (derived from traced calls)
and `used_rounds` could diverge for exactly this reason.

**Fix (branch `fix/provider-attempt-telemetry-v1`).** `TracingChatBackend`
now opens an explicit RAII `ProviderAttemptGuard` when a provider operation
is actually started. Exactly one terminal `TracedCall` is retained:

- inner resolves → `Completed` / `Failed` / cooperative `Cancelled`
- host outer deadline drop → `TimedOut`
- host cancel drop (shared cancel flag, same as production) → `Cancelled`
- cancel already set at entry → **zero** attempts (never crossed the boundary)

Double counting is impossible: a `SeqCst` `finalized` flag is swapped
exactly once; the loser of finish-vs-Drop is a no-op. Interrupt paths are
metadata-only (no request bodies, prompts, secrets, URLs, or provider text).

**Proving tests.** `permanently_stalled_provider_is_cut_off_by_an_explicit_user_deadline`,
`attempt_counting_outer_race_timeout_records_one_timed_out_call`,
`cancellation_while_waiting_on_headers_via_the_outer_race`,
`candidate_operation_cap_is_shorter_than_the_whole_turn_budget_and_wins`,
plus unit lifecycle tests in `turn_trace.rs`.

### 2. HTTP 2xx with an error-shaped body (OpenAI-compatible dialect)

**What.** If an OpenAI-compatible-dialect provider returns HTTP 200 with an
`{"error": {...}}`-shaped body (some proxies/gateways do this), the client
has no special detection for it and the actual error reason is not
surfaced the way a non-2xx error is.

**Proof.** `error_envelope_returned_with_2xx_status_loses_the_actual_reason`
(`gateway_wire_chat.rs`).

**Why not fixed.** There is no universal OpenAI-compatible convention for
this; guessing at vendor-specific 2xx-error shapes risks false positives
(treating a legitimately-named `error` field in a normal completion as a
failure). Flagged as a real, provider-caused ambiguity rather than a
ContextDesk defect with an obvious fix.

### 3. Embedding batching is N sequential calls, not one batch request

**What.** The only implemented `EmbedBackend` (Ollama) has no real
multi-input batch endpoint; "batched inputs" in this lab means N sequential
single-input requests. True batch-request/response-index semantics
(duplicate/missing/out-of-order indexes in one response) are untested
because no implemented backend has them to test.

**Proof.**
`batched_inputs_issue_one_sequential_request_per_input_in_order`
(`gateway_wire_embeddings.rs`) documents the real sequential shape.

**Why not fixed.** Not a defect — there is nothing to fix in ContextDesk;
the gap is in what exists to test.

### 4. No cross-call embedding-dimension consistency check

**What.** Two embedding calls returning vectors of different dimensions are
both accepted; nothing in `embed.rs` checks that a corpus's vectors stay
dimensionally consistent across calls (e.g. if a provider's model/config
changed mid-run).

**Proof.**
`heterogeneous_dimensions_across_calls_are_not_rejected_documents_the_gap`
(`gateway_wire_embeddings.rs`).

**Why not fixed.** Adding this check is a new product behavior (a new
failure mode for existing corpora), not a wire-conformance fix, and out of
this lab's scope of "prove and fix what the wire already contracts for."

### 5. Vercel v4 rerank dialect has no production backend

**What.** Vercel's v4 rerank response dialect is exercised only by a
capability probe / dev tool; it is never wired into the production
`RerankBackend` trait.

**Why not tested.** There is no production code path to test against — a
scenario here would be testing a dev tool, not ContextDesk's product
surface. Documented as a gap in `gateway-wire-coverage-v1.json`
(`status: "not_applicable"`), not silently omitted.

### 6. `probe_vercel_catalog` is architecturally unreachable by a loopback mock

**What.** `cd_core::ai_probe::probe_vercel_catalog` is hardcoded to the real
`ai-gateway.vercel.sh` hostname.

**Why not tested.** Reaching it hermetically would require either a live
call (forbidden) or DNS/hosts-file manipulation (out of scope, and its own
source of flakiness/environment coupling). Not covered; documented here
rather than silently skipped.

## Live acceptance evidence that motivated the integration follow-up

A source-built acceptance candidate preserved an explicit 600-second router
deadline, completed deterministic retrieval and two slow candidate calls, then
failed final comparison after approximately 240 seconds. Source/trace
correlation showed a fixed 120-second provider transport timeout followed by
the generic streaming-to-non-stream replay path. This evidence motivated
Defects E and F above. The hermetic tests use millisecond-scale scripted
gateways, but exercise the same production constructors and backend methods.

The same acceptance trace also showed `providerRoundCount` diverging from the
host's charged round count when an outer cap dropped an in-flight operation.
That independently agreed with historical gap #1. The integrated provider
attempt lifecycle guard now retains those cancelled/timed-out operations as
metadata-only terminal records without changing request or deadline policy.

## Recommended integration strategy

1. **Keep the six provider-neutral fixes together in the acceptance-wire
   integration candidate** so the same conformance suite proves parsing,
   completion integrity, host-governed timeouts, and one-request semantics.
2. **Keep provider-attempt telemetry in the same candidate**: the lifecycle
   guard records started operations dropped by host timeout/cancellation and
   cannot double-count, while leaving request/deadline behavior unchanged.
   Remaining product work is surface polish for distinct timeout wording.
3. **Adopt `cd-test-gateway` as the default for new provider-boundary
   tests** going forward rather than hand-rolled TCP servers; it is a real
   workspace crate, already wired into `cd-core`/`cd-workflow`/`cd-cli`,
   and covers the byte-level fault classes `wiremock` cannot.
4. **Keep `gateway-wire-coverage-v1.json` current** as new scenarios are
   added — it is meant to be a living index, not a one-time snapshot; a
   future contributor adding a scenario should add its record in the same
   change.
5. **Do not merge this branch's tests as a substitute for** the separate,
   concurrent "Grok Build" cross-worktree mutation-testing effort or the
   static JSON parser fixture lane (`fixtures/gateway-contracts/v1/` +
   `crates/cd-core/tests/gateway_contract_fixtures.rs`) — this lab is
   deliberately complementary to both (real wire behavior vs. mutation
   coverage of internal contracts vs. static fixture replay), not a
   replacement for either.
