# Transport-Retry vs Semantic-Attempt Oracle

Audit branch: `audit/transport-semantic-attempt-oracle` · base commit
`106ffeeec44a86c94e7f4affdcb732f7caa2696a`.

This document is the acceptance contract, the verified state machine, and the
partitioned test inventory for one invariant of ContextDesk's shared
`cd-core`/`cd-workflow` provider pipeline:

> **Transport retries and semantic LLM-analysis attempts are separate
> concepts. A semantic attempt is consumed only after a provider response
> reaches the stage where ContextDesk can evaluate an analysis. Nothing that
> happens before that point — HTTP 429, connection reset, connect/read
> timeout, retriable gateway failure — may consume a candidate-analysis
> attempt, reject a candidate, or be described as an evidence/analysis
> failure.**

The oracle is hermetic and adversarial: every scenario drives the REAL
production stack (`research::backend_for` → `OpenAiCompatibleClient` with its
SSRF-pinned reqwest client → `TracingChatBackend` → agent loop →
`cd_workflow::turn::run_turn`) against deterministic fault-injecting local
mocks (wiremock plus a raw `TcpListener` for RST / never-respond / byte-exact
chunk splits). No new retry implementation was written; no product code was
changed. RED tests pin real product gaps and stay RED on the base commit,
each paired with a green positive control so a degenerate "never retry /
never classify" implementation cannot pass the pair.

## 1. Vocabulary (bound to code, not aspiration)

| Concept | Where it lives at base | Counter |
|---|---|---|
| **Transport attempt** | one HTTP POST inside `OpenAiCompatibleClient::post_completion_with_429_retry` (`crates/cd-core/src/chat.rs:633`) | `retry` local; surfaced ONLY as `tracing` fields `attempt`/`max_attempts` (target `cd_core::chat`) |
| **Transport retry budget** | `OPENAI_COMPATIBLE_MAX_429_RETRIES = 2` (`chat.rs:15`): 1 initial + 2 retries, 429-only | — |
| **Backoff delay** | `bounded_openai_retry_after` (`chat.rs:20`): `Retry-After` delta-seconds or RFC-2822 HTTP-date, clamped to ≤ 60s; else `30s << retry` clamped to ≤ 60s | `tracing` fields `delay_ms`, `delay_source ∈ {retry_after, fallback}` |
| **Semantic attempt** | one `ChatBackend::complete/complete_streaming` invocation observed by `TracingChatBackend` (`crates/cd-core/src/turn_trace.rs:2178`) | one `TracedCall` per invocation; `TracedOutcome::Completed` = evaluable analysis arrived |
| **Application model round** | one iteration of the agent loop that reached the backend (`crates/cd-core/src/agent.rs:3771`) | `ProviderTurnTelemetry.provider_round_count`; Activity `provider-round-{n}` events |
| **Application retry** | host decision to re-enter the provider with a stable reason (`tools_unsupported`, `context_compacted`) via `TurnTraceObserver::note_application_retry` | `ProviderTurnTelemetry.application_retry_reasons` (typed `{round, reason}`) |
| **Candidate-analysis attempt** | one provider call per candidate inside `run_multi_stage_broad_triage` (`agent.rs:1098`); cap `MULTI_STAGE_CANDIDATE_ATTEMPT_CAP = 2` (initial + one correction) | `used_rounds` increments ONLY after `Ok(completion)` (`agent.rs:1162`) |
| **Comparison attempt** | one provider call in the final-comparison stage; cap `MULTI_STAGE_COMPARISON_ATTEMPT_CAP = 2` | same `used_rounds`; surfaced as `provider_rounds` in the `contextdesk.multi_stage_triage.v1` tool detail |

## 2. Verified retry/attempt state machine

### 2.1 Transport layer (per ChatBackend call — i.e. per semantic attempt)

```
post_completion_with_429_retry(body, operation, cancel):
  retry = 0
  loop:
    [cancel set?] ──────────────► Err("cancelled")            (no request sent)
    POST /v1/chat/completions
    ├─ send error (reset / refused / timeout / TLS) ─► Err("{operation}: {reqwest error}")
    │                                                  (IMMEDIATE — resets/timeouts are
    │                                                   NOT retried at this layer)
    ├─ status != 429 ─► Ok(response)                   (success OR non-429 HTTP error;
    │                    if retry > 0: tracing INFO "provider rate limit recovered")
    └─ status == 429:
         ├─ retry == 2 ─► tracing WARN "provider rate limit exhausted"
         │               ─► Ok(the 429 response)  → caller converts to
         │                   Err("chat|stream HTTP 429 Too Many Requests: {body≤300}")
         └─ retry < 2:
              delay, source = bounded_openai_retry_after(headers, retry)
                 Retry-After: <secs>          → min(secs, 60s), source=retry_after
                 Retry-After: <HTTP-date>     → min(date−now, 60s), source=retry_after
                 Retry-After malformed/past/absent → min(30s<<retry, 60s), source=fallback
              retry += 1
              tracing WARN "waiting due to provider rate limit before retry"
                 {attempt, max_attempts, delay_ms, delay_source, provider_request_id, cancellable}
              cancel-aware sleep (20ms poll) ── cancel ─► Err("cancelled")
              loop
```

### 2.2 Backend adapter (`OpenAiBackend`, `research.rs:383`) — same semantic attempt

```
complete_streaming:
  complete_stream_cb (streaming, full 429 budget)
  ├─ Ok ───────────────────────────────► Ok            (semantic attempt completes)
  ├─ Err contains "cancelled" ─────────► Err           (terminal, no fallback)
  ├─ Err contains "HTTP 429" ──────────► Err           (exhaustion terminal — the
  │                                                     non-stream fallback must NOT
  │                                                     spend a second 429 budget)
  └─ any other Err (reset, timeout, malformed SSE, non-429 status)
       └─► ONE non-stream `complete` (fresh transport budget) — still the SAME
           semantic attempt; its result decides the attempt's outcome.
```

`CapabilityAwareBackend` (`research.rs:505`) wraps this; see gap G2 — its
stream-rejection needle (`msg.contains("stream")`) also matches the transport
operation label `"stream HTTP 429 …"`.

### 2.3 Turn wrapper (every provider await)

```
within_turn_deadline(clock, cancel, provider_future)      (agent.rs:2723)
  cancel pre-set          ─► TurnAwaitError::Cancelled    (future never polled)
  tokio::timeout(remaining(min(total, phase)), future)
      deadline fires      ─► TurnAwaitError::Deadline     (future DROPPED mid-backoff:
                                                           no further request possible;
                                                           no TracedCall is recorded)
  select wait_for_cancel (10ms poll)
      cancel mid-flight   ─► TurnAwaitError::Cancelled    (future DROPPED)
```

The whole-turn deadline is therefore authoritative over any backoff by
construction — verified end-to-end (400 ms deadline beats a 60 s
Retry-After; wire sees exactly one request).

### 2.4 Classification of a provider `Err(e)` that reaches the loops

Single-stage loop (`agent.rs:4421–4608`), in match order:

1. `e` contains `"cancelled"` → `TurnCompleted{reason:"cancel"}` (clean).
2. tools-unsupported needles → `Error{code:"tools_unsupported"}` +
   `note_application_retry("tools_unsupported")` + retry without tools
   (no round consumed).
3. context-length error, first time → compaction +
   `note_application_retry("context_compacted")` + retry (no round consumed).
4. context-length error again → typed `context_too_long` terminal.
5. anything else:
   * linked turn → `terminal_linked_provider_failure` (`agent.rs:2833`):
     `linked_synthesis_provider_error` when a synthesis-retry checkpoint
     exists (evidence preserved, unassessed), else
     `linked_retrieval_provider_error` naming the missing sources.
   * **ordinary turn → `return Err(e)` — raw escape (gap G1).**

Multi-stage candidate/comparison loops (`agent.rs:1158`, `:1243`):
`Ok(result) => result?` — **every** provider `Err`, including exhausted 429
and transport-observed cancellation, escapes the entire turn as a raw `Err`
via the `.await?` call site (`agent.rs:3632`) (gaps G3, G4). Cancellation and
deadline observed by the turn wrapper ARE typed (`Cancelled` / `Deadline`).

### 2.5 Provider-output categories (scenario 8) — verified, not collapsed

| Wire condition | Category | Verified behavior |
|---|---|---|
| Valid HTTP + SSE, empty content, `finish_reason=stop` | **completed semantic attempt** | `TracedCall::Completed`, `empty_visible_answer=true`, `ProviderTurnTelemetry.empty_visible_answer=true`; zero retries of any kind |
| `finish_reason=length` with text | **completed semantic attempt** | `Completed{finish_reason:"length"}`, `truncated_by_length=true` in turn telemetry; zero retries |
| Malformed SSE `data:` line | **provider-output failure** | stream parse fails closed (`"sse json: …"`) → ONE non-stream fallback inside the SAME semantic attempt; fallback success ⇒ attempt completes (2 wire requests, 1 `TracedCall`); fallback also malformed ⇒ attempt `Failed` with parse language, never analysis vocabulary |
| Partial UTF-8 / SSE fragments split across real TCP chunks | **no failure at all** | `SseLineDecoder` reassembles byte-exactly; 1 wire request, 1 completed attempt |
| Connection reset / refused / read-timeout before headers | **transport failure** | `Err("chat|stream request: …")`, never an `HTTP {status}` string; recovered inside the same semantic attempt by the non-stream fallback when the next request succeeds |
| Analytically invalid completed answer | **completed semantic attempt** | consumes exactly one attempt; bounded correction attempt may begin; only here does `linked_invalid_grounded_answer` vocabulary appear |

Caveat pinned by test: reqwest 0.12's top-level `Display` is
`"error sending request for url (…)"` — the timeout/reset CAUSE lives in the
source chain only, so the product string cannot distinguish timeout from
other send failures. Both stay inside the transport class (which the oracle
requires); naming the cause is a follow-up improvement.

## 3. Telemetry / activity mapping (scenario 11)

| Required observable | Typed surface at base | Oracle assertion |
|---|---|---|
| application model round | `ProviderTurnTelemetry.provider_round_count`, `rounds[].round`, Activity `provider-round-{n}` | asserted in every workflow test |
| semantic attempt | `TracedCall` per backend call; `contexts.len()`/`provider_rounds` in multi-stage detail | asserted at all three seams |
| transport attempt | **tracing only**: `attempt`/`max_attempts` on target `cd_core::chat` | asserted via in-test subscriber |
| rate-limit count | **tracing only**: count of `"waiting due to provider rate limit before retry"` + `"provider rate limit exhausted"` records | waits == wire retries, exactly |
| delay duration | **tracing only**: `delay_ms` | asserted for 0s / bounded-date / 30s fallback |
| retry reason | typed `application_retry_reasons` (application layer); tracing `delay_source` (transport layer) | both asserted |
| exhausted / cancelled / deadline status | `TurnCompleted` reasons (`cancel`, `budget_time`, `linked_synthesis_timeout`, `linked_*_provider_error`); typed `MultiStageTriageOutcome::{Cancelled,Deadline}`; **no typed status exists for ordinary-turn exhaustion (G1)** | green where typed, RED where missing |

Structural notes pinned during the audit (not themselves RED):

* No rate-limit/attempt/delay field exists in `ProviderTransportTelemetry`,
  `ProviderRoundTelemetry`, `ProviderTurnTelemetry`, or Activity; a
  rate-limited round is indistinguishable from a slow one in typed telemetry
  (`TracedCall.elapsed_ms` silently absorbs backoff).
* `ActivityTrigger::Retry { of_operation_id }` exists in the type system but
  has zero producers.
* `SAFE_RESPONSE_HEADER_ALLOWLIST` captures no `x-ratelimit-*` headers.

## 4. Test inventory and partition

Three files, 35 tests, ~2s total runtime, no product sleeps.

### PASS_ON_BASE (31)

`crates/cd-core/tests/transport_semantic_attempt_oracle.rs` (15):

* `two_429s_then_success_is_three_transport_attempts_inside_one_semantic_attempt` (scenario 1; mutants 1+3)
* `exhausted_429_is_an_explicit_rate_limit_failure_with_no_semantic_consumption` (scenario 2; mutant 2 vocabulary ban; no second fallback budget)
* `retry_after_http_date_is_honored_and_bounded`, `malformed_retry_after_falls_back_to_the_bounded_default`, `past_http_date_retry_after_falls_back_to_the_bounded_default`, `absent_retry_after_falls_back_to_the_bounded_default` (scenario 3; delta-seconds form covered by scenario 1's `Retry-After: 0`; pure bound arithmetic already unit-tested in `cd_core::chat`)
* `cancellation_during_backoff_exits_promptly_without_further_requests` (scenario 5; mutants 3+4)
* `connection_reset_before_headers_recovers_within_the_same_semantic_attempt` (scenario 4; RST via SO_LINGER(0))
* `connection_refused_classifies_as_transport_failure_not_provider_status`, `read_timeout_before_headers_classifies_as_transport_failure` (scenario 4b; the latter under `start_paused` against a never-responding socket)
* `empty_visible_answer_…`, `length_truncation_…`, `malformed_sse_stream_…`, `persistently_malformed_provider_output_…`, `partial_utf8_sse_fragments_…` (scenario 8 categories)

`crates/cd-core/src/agent_transport_semantic_oracle_tests.rs` (6 of 8):

* `candidate_stage_transport_retries_stay_within_one_candidate_attempt` (scenarios 1+9; mutant 1 at candidate layer)
* `comparison_stage_transport_retry_stays_within_the_first_comparison_attempt` (scenario 9)
* `candidate_stage_429_exhaustion_never_rejects_the_candidate` (scenario 2 green half: not `FailedClosed`, no analysis vocabulary, budget spent once)
* `candidate_stage_pre_set_cancellation_is_a_typed_cancelled_outcome` (control for G4; zero wire contact)
* `deadline_expiring_during_backoff_is_a_typed_deadline_outcome` (scenario 6, candidate stage)
* `single_stage_deadline_during_backoff_terminates_as_budget_time` (scenarios 6+10)

`crates/cd-workflow/tests/transport_semantic_attempt_oracle.rs` (10 of 12):

* `ordinary_turn_with_two_429s_consumes_three_transport_attempts_and_one_model_round` (scenario 1/11)
* `linked_retrieval_429_exhaustion_is_provider_error_not_evidence_or_analysis_failure` (scenario 2; mutant 2)
* `linked_synthesis_429_exhaustion_preserves_unassessed_evidence_for_retry` (scenarios 2+9: unassessed ≠ rejected)
* `cancellation_during_retry_backoff_stops_promptly_without_another_request` (scenario 5; mutant 4)
* `transport_retries_never_replay_a_completed_tool_effect` (mutant 5)
* `empty_visible_answer_…`, `length_truncated_answer_…` (scenario 8 at the turn seam)
* `completed_but_invalid_analysis_consumes_one_attempt_then_bounded_correction` (scenario 7; positive control for analysis vocabulary)
* `genuine_application_retry_is_counted_once_by_both_projections` (control for G5)
* `provider_telemetry_wire_dto_is_the_same_typed_value_for_both_hosts` (host DTO parity control; mutant 6 pair)

### RED_REQUIRED_FIX (4) — each fails deterministically on base

| Test | Gap |
|---|---|
| `cd-workflow::…::ordinary_turn_429_exhaustion_projects_a_typed_rate_limit_terminal` | **G1 + G2** |
| `cd-core agent::…::candidate_stage_429_exhaustion_is_a_typed_provider_outcome_not_an_escaped_err` | **G3** |
| `cd-core agent::…::candidate_stage_mid_flight_cancellation_is_cancelled_not_an_escaped_err` | **G4** |
| `cd-workflow::…::qualification_retries_and_typed_retry_reasons_agree_on_attempt_counts` | **G5** |

**G1 — ordinary-turn exhaustion has no typed terminal.** The single-stage
loop's `Err` catch-all returns the raw error for non-linked turns
(`agent.rs:4607`); `run_turn` `?`s it before the `ProviderTelemetry`
aggregate is appended, so both hosts lose the typed status AND the turn's
telemetry.

**G2 — exhausted 429 is re-labeled a streaming-capability failure.**
`CapabilityAwareBackend::complete_streaming` (`research.rs:556–565`) matches
the literal `"stream"` in the transport operation label `"stream HTTP 429 …"`
and rewraps the error as `"Streaming rejected by provider
(capabilities.stream=true but request failed): …"` — a rate limit
misattributed to stream capability. (Observed in G1's failure output.)

**G3 — candidate-stage exhaustion escapes as a raw `Err`.**
`run_multi_stage_broad_triage` `?`-propagates provider errors
(`agent.rs:1158/1243`) and the call site `.await?`s (`agent.rs:3632`): no
typed outcome, no `terminal_linked_provider_failure`, no event stream — the
only provider-failure path in the file with no classification.

**G4 — candidate-stage cancellation is racy.** Cancellation observed by the
transport's 20 ms poll returns `Err("cancelled")`, which the candidate loop
`?`-escapes, while the turn wrapper's 10 ms poll yields typed `Cancelled`:
the same user action produces two different outcome shapes depending on a
poll race. The single-stage loop already classifies the string
(`agent.rs:4423`); the multi-stage loops must too (or the fix for G3 covers
both).

**G5 — host projections disagree on attempt counts.**
`LiveTurnObservation.retries` (`cd-workflow/src/qualification.rs:63–74`,
consumed by CLI provider-qualify and Tauri's `activity_settled.live_turn`)
is a window heuristic counting any call after a failed OR zero-tool-call
completed round; typed `application_retry_reasons` counts host retry
decisions. A linked grounding-nudge turn (prose → nudge → tool → synthesis →
bounded correction) yields `retries == 2` vs typed `0` on the same capture.

### Suggested fix shape (for the implementer; not applied here)

1. Add `MultiStageTriageOutcome::ProviderFailure(CoreError)` (or classify at
   the `3632` call site): map to `terminal_linked_provider_failure`
   (fixes G3), and classify `contains("cancelled")` to `Cancelled` first
   (fixes G4).
2. Give ordinary turns the same treatment as linked ones in the `Err`
   catch-all: emit a typed `provider_rate_limited`/`provider_error` +
   `TurnCompleted` instead of returning `Err` (fixes G1), and append the
   telemetry aggregate on that path.
3. In `CapabilityAwareBackend`, exempt errors matching `"HTTP 429"` (or any
   `chat|stream HTTP <status>` shape) from the stream-rejection rewrap
   (fixes G2).
4. Derive `LiveTurnObservation.retries` from
   `TracedCall::application_retry_reason` (fixes G5) — the heuristic's other
   consumers are asserted by
   `genuine_application_retry_is_counted_once_by_both_projections`.

None of the four fixes may change any green test in this oracle: that is the
non-conflation guarantee.

## 5. Reproduction commands

```bash
git -C /Users/chriscase/Documents/GitHub/ContextDesk worktree list | grep transport-semantic
cd <worktree>

# Wire seam (15 green)
cargo test -p cd-core --test transport_semantic_attempt_oracle

# Candidate/comparison stage (6 green, 2 RED: G3, G4)
cargo test -p cd-core --lib transport_semantic_oracle_tests

# Workflow seam (10 green, 2 RED: G1+G2, G5)
cargo test -p cd-workflow --test transport_semantic_attempt_oracle

# Adjacent regression guard (pre-existing suites, unchanged)
cargo test -p cd-core --test openai_compatible_provider_matrix
cargo test -p cd-workflow --lib
```

## 6. Why the counters cannot be conflated (evidence summary)

* 3 wire attempts / 1 `TracedCall` / `provider_round_count == 1` on the same
  turn (three independent ledgers asserted against each other).
* Candidate stage: 5 wire attempts / `provider_rounds == 3` / `contexts.len()
  == 3`, with `rejected_groups` empty under injected 429s.
* Every backoff wait is traced with `attempt`, `delay_ms`, `delay_source`;
  the count of wait records equals wire retries exactly, so an untraced sleep
  or an untraced retry breaks an equality, not a threshold.
* A cancelled backoff leaves wire count frozen at 1 with a `Failed{cancelled}`
  attempt; a deadline'd backoff leaves wire count 1 with typed
  `Deadline`/`budget_time`.
* Tool effects: `search_logs` Started/Finished exactly once while the
  following completion needed 2 transport retries and 1 semantic correction.
* The one place the counters DO leak into each other today is G5 — pinned
  RED, with the agreeing case pinned green.
