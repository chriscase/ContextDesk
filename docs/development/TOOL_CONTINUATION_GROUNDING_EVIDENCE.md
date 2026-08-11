# Tool-continuation lane: host grounding refusal vs. provider fault

Status: evidence record for a diagnostic-classification fix; not a release or
capability claim.
Last updated: 2026-08-11
Branch: `fix/luna-tool-continuation-trace`
Branch base: exact `c09357153e0c8953f2862c3cf3d8377ec9bc6bc7`

This file records what two owner-local `gateway diagnose` runs against the chat
model `openai/gpt-5.6-luna` (default gateway effort) actually prove about the
`tool_call_continuation` case, and — just as importantly — what they do not.
The captures themselves stay owner-local. No request or response body, model
prose, tool argument, corpus/session/run identifier, endpoint, header,
credential, or private path is reproduced here or in any fixture.

A sanitized, normalized version of the round shape lives in
[`fixtures/gateway-contracts/v1/tool-continuation-grounding-shape.json`](../../fixtures/gateway-contracts/v1/tool-continuation-grounding-shape.json)
and is exercised by `crates/cd-core/tests/gateway_contract_fixtures.rs`.

## The reported symptom

For the same model, twice, with a comparison run against
`deepseek/deepseek-v4-flash` on the same case:

| Case | Direct lane | Product lane | Case classification |
| --- | --- | --- | --- |
| `ordinary_generation` | pass | pass | compatible |
| `structured_response` | pass | pass | compatible |
| `linked_log_triage` | not applicable | pass (typed scorer passed) | compatible |
| `tool_call_continuation` | fail — `response_contract` | fail — `provider_error` | `gateway_or_model_likely` |

The captured exchanges contain valid native `tool_calls` followed by terminal
responses. `provider_error` on a lane whose provider rounds all completed is
what prompted this investigation.

## What the live evidence proves

1. **Native tool calling worked on the wire.** In the product lane, rounds 1
   and 2 both finished on `tool_calls` and carried one well-formed function
   call each. There is no transport error, HTTP error, or `raw_error` anywhere
   in the captured product exchange.
2. **The host executed the tool successfully.** The bounded log tool returned
   `ok`, `source_kind: log_templates`, and `result_count: 1`.
3. **That result carried zero citeable evidence.** The rendered result contained
   the template hit line but no `e.g.` exemplar event line. The comparison run
   on the same synthetic corpus and the same query *did* contain one.
4. **The difference is a structured filter, not the provider's competence.**
   The failing run's call supplied every optional parameter, including an
   epoch-relative time window; the passing run's call supplied only the query.
   Every event of the matching template fell outside that window.
5. **The host's evidence gate then refused the result, correctly.**
   `crates/cd-core/src/agent.rs` admits a search result only when
   `log_result_count > 0 && !log_evidence.is_empty()`. With no surviving event
   there is no identity, so the result was recorded as
   `linked_search_logs_zero_results` and never entered the evidence buffer.
6. **A refused result never reaches the model.** Linked turns rebuild model
   context from the evidence buffer, never from protocol history. With the
   buffer empty, round 2 re-sent a byte-identical prompt with tools still
   offered — visible in the capture as an unchanged message set and an
   unchanged prompt-token count — so the model repeated the identical call.
   Rounds 3 and 4 were then sent with **no tools offered** while still carrying
   the pre-grounding instruction to call the tool, which the model could no
   longer satisfy.
7. **The report then blamed the provider for a host-side refusal.** The lane
   detail is the host-authored string `tool_called=<bool> grounding=<enum>`.
   In `crates/cd-core/src/redact.rs`, `failure_summary` matched no bucket for
   that string and fell through to the `provider_error` fallback.

## The exact testable boundary

`crates/cd-core/src/log_analysis/search.rs`, in
`search_logs_with_excluded_templates_and_rerank`:

- the structured filter (`time_from` / `time_to` / `level` / `service` /
  `trace_id`) is applied per **event**, and only surviving events populate
  `representative_exemplars` and `matching_exemplars`;
- the subsequent template-pattern keyword loop admits a template into `allowed`
  on **pattern text alone**, without re-checking that filter;
- so a hit can be emitted whose `count` is the corpus-wide template total while
  its `exemplars` and `evidence` are both empty.

`crates/cd-core/src/tool_host.rs` then derives `result_count` from `hits.len()`
and `evidence` from the flattened per-hit identities, which is how a result can
read `result_count: 1` to the model while supplying the host nothing to cite.

Pinned hermetically by
`log_analysis::search::tests::a_pattern_matched_template_can_outlive_its_time_filtered_events_with_no_evidence`.

### Why the tools then disappeared

Derived from source, not directly captured — the capture records only that
rounds 3 and 4 were sent with an empty tool offer. In
`crates/cd-core/src/log_analysis/linked_search_bound.rs`, `observe_search_logs`
allows the first attempt even with zero new citeable events, and stops an exact
repeat that again yields none. `crates/cd-core/src/agent.rs` then selects
`required_without_search_logs` for the round's tool argument; because
`search_logs` was the turn's only required read, that list is empty. Removing
the required tool while the required-source system hint is still in force is
the only branch that produces the observed empty offer, which is why rounds 3
and 4 were instructed to call a tool they were not given.

## What the live evidence does **not** prove

- **It does not clear the model.** The direct lane failure is separate and real.
  It comes from the shared qualification pass, whose continuation probe sends a
  synthetic `assistant` tool-call plus a `tool` message and requires a marker in
  the reply. That probe is not part of the captured product exchange, so these
  captures neither confirm nor refute it.
- **It does not tell us which direct probe failed.** The direct lane is
  `combine_lanes(NativeToolCall, ToolResultContinuation)`, whose two details are
  concatenated and then collapsed by redaction into one category. The product
  capture makes it *likely* that native tool calling passed and only the
  continuation probe failed, but that is an inference from a different lane, not
  evidence. Splitting that lane is deliberately **not** done here.
- **It does not prove the time window is model-specific.** Two runs of one model
  chose an epoch-relative window; one run of the comparison model omitted the
  optional parameters. That is a two-vs-one observation, not a characterization
  of either model.
- **It does not prove any latency, cost, or token figure.** No wall-clock or
  usage number from these runs is used as a threshold anywhere.
- **It does not make the case pass.** After this change the lane still fails;
  only its attribution changes.

## What changed

One production classification arm, in `crates/cd-core/src/redact.rs`:

- A new `host_grounding_refused` failure category matches the host-authored
  `tool_called=` **and** `grounding=` conjunction.
- It is ordered **after** every provider-signal bucket (cancelled, timeout,
  authentication, route, rate limit, invalid response, transport, upstream,
  local I/O), so a genuine gateway fault still wins even when the host tokens
  are also present.
- It is still a failure. It never converts a declined lane into a pass, and
  unknown details still fall back to `provider_error`.

Deliberately unchanged: model routing, timeout policy, case acceptance
branches, `classify()`, the grounding gate's fail-closed rule, and the search
behaviour described under *the exact testable boundary* — that is a production
retrieval change, and this branch does not carry the evidence to justify one.

## Mutation coverage for the new invariant

In `crates/cd-core/src/redact.rs` tests, each mutation was applied and confirmed
to fail:

| Mutation | Killed by |
| --- | --- |
| Delete the `host_grounding_refused` arm (fall back to `provider_error`) | `share_safe_failure_summary_attributes_a_declined_grounding_lane_to_the_host`, `share_safe_failure_summary_covers_every_grounding_lane_detail_the_host_can_emit` |
| Hoist the arm above the provider-signal buckets (mask a real outage) | `a_real_provider_signal_still_outranks_the_host_grounding_tokens` |
| Relax the token conjunction to a disjunction (over-claim a host refusal) | `one_grounding_token_alone_is_not_enough_to_claim_a_host_refusal` |

`host_grounding_category_is_still_a_failure_and_retains_no_raw_detail` and
`unknown_failures_still_fall_back_to_provider_error` guard the failure shape,
idempotency, redaction, and the surviving fallback.

## Follow-ups not taken here

1. **Tell the model why a result was refused.** A result the host discards is
   currently indistinguishable, from the model's seat, from one it never sent.
   Surfacing the refusal reason would let a model correct its own filter instead
   of repeating the call until the round budget drains.
2. **Do not render `result_count` / `n=` for a hit that supplied no identity**,
   or render the filtered count alongside the corpus-wide one.
3. **Report the two direct tool probes separately** so an operator can tell
   "native tool calls work, continuation does not" from "neither works".
