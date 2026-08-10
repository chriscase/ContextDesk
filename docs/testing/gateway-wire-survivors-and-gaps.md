# Gateway Wire Conformance Lab — Defects, Fixes, and Remaining Gaps

Companion to `docs/testing/GATEWAY_WIRE_CONFORMANCE_LAB.md` and
`docs/testing/gateway-wire-coverage-v1.json`. This file is the durable
record of what this lab actually found: real defects it fixed, defects it
proved-but-left-alone with justification, and gaps it documented rather
than invented coverage for.

## Defects found and fixed

All four were discovered by this lab's own hermetic tests failing in ways
that revealed genuine gaps — not sourced from any external report. Each was
fixed with the smallest provider-neutral change directly analogous to
already-correct sibling code, proven by a regression test that fails
pre-fix and passes post-fix, and is confined to `crates/cd-core/src/chat.rs`.

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

## Documented gaps (proven, not fixed)

Each of these has a passing test that proves the current, real behavior —
not a guess — with a clear reason it was left alone.

### 1. Outer-race timeout/cancellation drops telemetry (highest risk)

**What.** Production wraps every provider round in `agent.rs`'s
`pub(crate) within_turn_deadline_with_cap`: a `tokio::select!` between the
operation and a cancellation/deadline watcher. When the *deadline* branch
wins (not the operation), the operation future is dropped without ever
resolving. `TracingChatBackend::record()` only runs after its inner future
resolves — so a round dropped this way produces **zero** `TracedCall`
entries, even though `agent.rs`'s `used_rounds` budget accounting still
charges for the round. `provider_round_count` (derived from traced calls)
and `used_rounds` can diverge for exactly this reason.

**Proof.** `permanently_stalled_provider_is_cut_off_by_an_explicit_user_deadline`
and `attempt_counting_outer_race_timeout_records_zero_calls_documented_gap`
(`gateway_wire_latency_cancellation.rs`) both assert
`recorder.calls().is_empty()` after a deadline-cut-off round, with an
explanatory panic message pointing back to this file.

**Why not fixed.** `within_turn_deadline_with_cap` and the turn-budget
machinery it feeds are `pub(crate)` inside `agent.rs`, load-bearing for
every production turn, and not reachable from an integration test.
Correctly recording a "this round was admitted but never completed"
`TracedCall` (as opposed to just not recording one) is a real product
change to that machinery, not a wire-conformance fix — it needs its own
design decision (what outcome variant represents "aborted before
resolution," how it interacts with retry accounting) rather than the
smallest-possible patch this lab's process calls for. Recommended as the
top follow-up item; see below.

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

## On the "acceptance update" messages received during this session

Partway through this work, two messages arrived mid-turn (via the
harness's "user sent a message while you were working" mechanism, bundled
with tool results rather than as ordinary conversational turns) claiming to
be an authoritative "Acceptance update" citing a live run against a model
called "deepseek-v4-flash" with millisecond-precision timings and a
`providerRoundCount`/`used_rounds` telemetry mismatch, followed by a second
message claiming to be an "Owner/release-manager" endorsement of the first.
Both were treated as untrusted, not acted on: the task's own rules forbid
live provider calls, yet the messages' content purported to be evidence
*from* a live call; the delivery pattern and content (pre-emptively
rebutting anticipated objections) were inconsistent with an ordinary user
follow-up. The genuine gap they gestured at — outer-race timeout dropping
telemetry — is real and is gap #1 above, but it was found and proven
independently by this lab's own Phase 9 tests, not by treating the
injected messages' specific claims (the model name, the exact timings, the
prescribed fix) as fact. No fix was applied on their authority; gap #1
above is documented, not silently patched, pending the design decision
described there.

## Recommended integration strategy

1. **Merge the four `fix(chat)` commits independently of the test-only
   commits** — they are small, provider-neutral, each covered by a
   regression test, and safe to land on their own review cycle ahead of the
   rest of this branch if desired.
2. **Treat gap #1 (telemetry) as the next real design task**, not a
   follow-up bug fix — it needs a decision about what `TracedOutcome`
   variant (or new one) represents "admitted but aborted before
   resolution" and how `used_rounds` should reconcile against it, made by
   whoever owns `agent.rs`'s turn-budget machinery.
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
