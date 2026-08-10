# Gateway Wire Conformance Lab

A hermetic test suite that drives ContextDesk's real provider clients — the
same code the CLI and desktop hosts call — against scripted loopback HTTP
servers instead of a live AI gateway. It exists to catch defects that only
show up at the actual wire boundary: framing bugs, premature-close handling,
fabricated success on partial data, timeout/cancellation races, credential
plumbing, and CLI/desktop parity — the kind of thing unit tests against
pre-parsed fixtures cannot see.

No test in this lab makes a live call to Vercel, an employer gateway, Grok,
OpenAI, Anthropic, Voyage, Ollama, or any other real network endpoint. Every
scenario runs against `cd_test_gateway::MockGateway`, a loopback TCP server
this lab owns, or (for a handful of pre-existing CLI tests this lab builds
next to) `wiremock`. Secrets used anywhere in this lab are synthetic strings
held in `tempfile::TempDir`s; the real OS keychain is never touched.

## Why this exists

Before this lab, ContextDesk's provider-client tests mostly called parsing
helper functions directly with hand-built fixture strings. That proves the
*parser* is correct but not that the *client* — connection handling, header
timing, chunked/fragmented framing, cancellation races, retry/backoff,
credential attachment — behaves correctly when it actually has to read
bytes off a socket. This lab closes that gap: every scenario goes through
the real `OpenAiCompatibleClient` / `AnthropicClient` / `OllamaClient` /
`EmbedBackend` / `RerankBackend` / discovery / qualification code, reading
real (if scripted) TCP responses.

## Architecture

### The mock gateway (`crates/cd-test-gateway`)

A small, dependency-light crate providing one reusable scripted HTTP/1.1
server, used by every phase in this lab instead of one-off hand-rolled
servers per test file. Two constructors:

- **`MockGateway::start_ordered(steps: Vec<Step>)`** — accepts connections
  strictly one at a time; the Nth connection gets `steps[N]`; once the
  script is exhausted, every further connection repeats the last step. Use
  this whenever call *order* is part of the assertion (retry/backoff
  sequences, multi-round tool continuations, "exactly N requests" checks).
  It is **path-unaware**: it answers whatever request arrives next
  regardless of URL, which matters for discovery tests — see the pitfall
  below.
- **`MockGateway::start_routed(routes)`** — serves connections
  **concurrently**, dispatching each to a step chosen by a closure over the
  request's path. Use this whenever a scenario needs path-specific
  responses (e.g. a discovery probe that must 404 on every route except the
  canonical one) or genuine concurrency.

A `Step` is either `Step::respond(Response)`, `Step::close_before_headers()`,
or `Step::stall()`. A `Response` carries a status, headers, and a `Body`:
`Empty`, `Fixed { data, delay }`, `FixedFragments` (pre-split byte chunks),
`FixedThenDrop` (send N bytes then reset the connection), `Chunked` /
`ChunkedThenDrop` (HTTP chunked-transfer framing), `Stream(Vec<Frame>)`
(arbitrary byte fragments with per-fragment delays — the tool for SSE
framing/timing tests), and `NeverEnds` (headers sent, body never arrives —
for permanent-stall scenarios). `split_at`/`split_evenly` help build
`Frame` sequences that split a payload at exact byte offsets, including
mid-UTF-8-sequence and mid-JSON-token splits.

Every accepted request is recorded (`gateway.requests()` /
`gateway.request_count()`) with method, path, headers, and body, so tests
can assert on exactly what the real client sent — not just what it
received.

`crates/cd-test-gateway/src/redact.rs` provides a small `redact(text,
secrets) -> String` helper (SHA-256-derived 8-hex-char markers) used to
build assertion/panic messages that are safe to print even when they
reference a synthetic secret.

### Injection seams per capability

Every phase drives the real client at the smallest seam that reaches actual
HTTP:

| Capability | Seam | Module |
|---|---|---|
| Discovery | `cd_core::discovery::probe_provider_catalog` | `crates/cd-core/src/discovery.rs` |
| Chat / structured output | `OpenAiCompatibleClient::complete` / `AnthropicClient::complete` / `OllamaClient` | `crates/cd-core/src/chat.rs` |
| Streaming | `complete_streaming` / `complete_streaming_cb` (same clients) | `crates/cd-core/src/chat.rs` |
| Tool calls | Same chat clients, `tools`/`tool_choice` request fields + `tool_calls` response fields | `crates/cd-core/src/chat.rs` |
| Qualification | `cd_core::capability_qualification::run_qualification` via `LiveQualificationTransport` | `crates/cd-core/src/capability_qualification.rs`, `crates/cd-workflow/src/capability_qualification.rs` |
| Embeddings | `EmbedBackend` implementations | `crates/cd-core/src/embed.rs` |
| Reranking | `RerankBackend` implementations | `crates/cd-core/src/rerank.rs` |
| Latency/cancellation | The clients above, raced under `race_with_cancel` (a test-local replica of `agent.rs`'s `pub(crate) within_turn_deadline_with_cap` shape) | `crates/cd-core/src/chat.rs`, `crates/cd-core/src/multi_stage_budget.rs` |
| Credentials | `ReferencedSecretStore`, `TurnProviderCredentialCache`, `resolve_turn_inputs[_with_credential_cache]` | `crates/cd-core/src/keychain_store.rs`, `crates/cd-workflow/src/provider.rs` |
| CLI parity | The compiled `contextdesk` binary via `assert_cmd` | `crates/cd-cli/src/commands/models.rs`, `.../doctor.rs` |
| Desktop parity | Source-text delegation guards (see below) | `desktop/src-tauri/src/lib.rs` |

Nothing in this lab reimplements provider wire logic — every scenario
exercises the actual production function.

### Desktop-host parity is architectural, not a live Tauri run

`desktop/src-tauri` is a **nested Cargo workspace** (see the repo root
`AGENTS.md`); no crate in the main workspace can call into it directly, and
there is no headless/display-free way to drive an actual Tauri window in
this environment. Parity is instead proven by reading
`desktop/src-tauri/src/lib.rs`'s own source text and asserting that its
Tauri commands **delegate** to the exact functions this lab exercises
hermetically, rather than carrying a parallel reimplementation:

- `probe_ai_gateway_cmd` → `cd_core::ai_probe::probe_ai_gateway`
- `start_capability_qualification` → `cd_core::capability_qualification::run_qualification`
- `desktop/src-tauri/src/capability_qualification_host.rs` is exactly `pub
  use cd_workflow::capability_qualification::*;` — a re-export, not a
  second module with its own types
- (pre-existing, not added by this lab) `agent_turn`,
  `provider_profile_for_turn`, `model_tools_enabled`/`disabled_reason` all
  delegate to `cd_workflow`

See `crates/cd-workflow/tests/architecture_tauri_delegates_to_shared_provider_logic.rs`.
Because `cd-cli`'s own `models verify` command uses the *identical*
`cd_workflow::capability_qualification::LiveQualificationTransport` +
`cd_core::capability_qualification::run_qualification` pair, CLI and
desktop qualification share one real implementation — this lab's
hermetic qualification tests are simultaneously correctness evidence for
both hosts.

## Test files

| File | Phase | Scenarios | Crate |
|---|---|---|---|
| `crates/cd-test-gateway/src/*.rs` (doctests + unit tests) | 2 | 9 | `cd-test-gateway` |
| `gateway_wire_discovery.rs` | 3 | 31 | `cd-core` |
| `gateway_wire_chat.rs` | 4 | 30 | `cd-core` |
| `gateway_wire_streaming.rs` | 5 | 21 | `cd-core` |
| `gateway_wire_tools.rs` | 6 | 15 | `cd-core` |
| `gateway_wire_qualification.rs` | 6 | 2 | `cd-workflow` |
| `gateway_wire_embeddings.rs` | 7 | 10 | `cd-core` |
| `gateway_wire_rerank.rs` | 8 | 12 | `cd-core` |
| `gateway_wire_latency_cancellation.rs` | 9 | 19 | `cd-core` |
| `gateway_wire_credentials.rs` | 10 | 9 | `cd-workflow` |
| `gateway_wire_cli_parity.rs` | 11 | 3 | `cd-cli` |
| `architecture_tauri_delegates_to_shared_provider_logic.rs` (extended) | 11 | 3 new (+5 pre-existing) | `cd-workflow` |

`docs/testing/gateway-wire-coverage-v1.json` has one machine-readable record
per scenario (167 total, including 2 documentation-only records — see that
file's own note). `docs/testing/gateway-wire-survivors-and-gaps.md` covers
defects found and fixed, and the highest-value remaining gaps.

## How to add a new fixture or scenario without a live provider call

1. **Pick the file matching your capability** (table above). Each file has
   its own small set of local helper functions near the top (a `profile()`
   builder, a `traced_backend()`/client constructor, and shape helpers like
   `sse_ok()`/`text_event()`) — reuse those rather than inventing new ones.
2. **Script the wire behavior with `MockGateway`:**
   ```rust
   let gateway = MockGateway::start_ordered(vec![Step::respond(
       Response::json_ok(&json!({ /* your fixture */ }))
   )])
   .await;
   ```
   For a fault (malformed body, wrong content-type, mid-body drop, a stall),
   reach for the matching `Body`/`Step` variant instead of hand-rolling a
   TCP server — see `crates/cd-test-gateway/src/script.rs`'s doc comments
   for the full menu.
3. **Point a real client/profile at `gateway.base_url()`** using the file's
   existing profile-builder helper, then call the real production function
   (never a re-implementation).
4. **Assert on the parsed result AND the wire**, where useful:
   `gateway.requests()[0]` gives you the exact method/path/headers/body the
   client actually sent.
5. **Timing scenarios**: prefer real short delays (`Duration::from_millis`)
   over `#[tokio::test(start_paused = true)]` + `tokio::time::advance()`
   whenever the assertion depends on one delay beating another (e.g. "the
   response arrives before the deadline"). Mixing real loopback TCP I/O
   with tokio's paused-clock auto-advance is a documented tokio hazard:
   the mock's own delay timer only registers once real I/O has actually
   progressed (accept → read request → compute response), which can race
   against — and lose to — a `tokio::time::advance()` call that jumps the
   clock before that registration happens. `start_paused` is still fine
   (and used extensively in this lab) for scenarios where the *expected*
   outcome is a timeout/deadline regardless of exact registration timing —
   see `gateway_wire_latency_cancellation.rs`'s own comment on exactly this
   distinction, and the two tests it links as the concrete example of the
   race actually causing a spurious failure.
6. **Never introduce a real multi-second sleep.** If a scenario needs to
   look "slow," a few milliseconds of real delay (for direct-await tests)
   or a virtual delay under `start_paused` (for timeout-expected tests) is
   enough — the pinned clients' own real ceilings (e.g. ~120s) should never
   actually be waited out in a test.
7. **CLI-level scenarios**: if your test spawns the compiled `contextdesk`
   binary via `assert_cmd::Command` *and* uses `MockGateway`, run the
   blocking `.output()` call through `tokio::task::spawn_blocking` (see
   `gateway_wire_cli_parity.rs`'s `run_blocking` helper). `MockGateway`'s
   accept loop is `tokio::spawn`-ed onto the calling test's own runtime (by
   design — see point 5); a synchronous `.output()` call on a
   single-threaded test runtime would starve that task and make the mock
   unreachable from the spawned child process for the whole child lifetime.
8. **Run just your new test** (`cargo test -p <crate> --test <file>
   <test_name>`) before running the full file — the fastest way to catch
   fixture-shape mistakes.
9. **If your scenario reveals a real product defect** (not a test-authoring
   mistake), follow the process in
   `docs/testing/gateway-wire-survivors-and-gaps.md`: failing test first,
   smallest provider-neutral fix, fix in its own commit, re-run, document.

## Design choices worth knowing

- **One reusable mock framework, not per-file servers.** `cd-test-gateway`
  is a real workspace crate (`Cargo.toml` member, `publish = false`) wired
  as a dev-dependency into `cd-core`, `cd-workflow`, and `cd-cli`.
  `wiremock` remains in use for the pre-existing CLI test files this lab
  did not rewrite (`doctor_readiness.rs`, `cli_workflow_parity.rs`,
  `cli_activity_parity.rs`) — both are legitimate; `cd-test-gateway` exists
  specifically for byte-level fault injection wiremock cannot express
  (raw connection resets, arbitrary chunk-boundary control, true infinite
  stalls).
- **The `"127.1"` loopback alias.** `cd_core::ai_probe.rs` has a literal
  substring special-case for `"127.0.0.1"`/`"localhost"` (routes to "the
  well-known local Ollama" regardless of what's actually listening — see
  `doctor_readiness.rs`'s own doc comment on the same behavior). WHATWG's
  URL "implied IPv4 octets" parsing accepts `"127.1"` as a fully valid
  alias for `127.0.0.1` that does **not** match that literal substring
  check, letting discovery tests reach a loopback mock through
  `ai_probe`'s real candidate-resolution logic instead of being
  short-circuited by it. See `gateway_wire_discovery.rs`'s
  `loopback_alias()` helper and module doc for the verified detail.
- **`start_ordered` is path-unaware.** A test using it to prove something
  about *one specific route* (e.g. "the OpenAI-compatible `/v1/models`
  Bearer-authed path is reached") must use `start_routed` instead whenever
  another candidate path (e.g. Ollama's `/api/tags`, tried first in the
  real candidate fanout) could otherwise "succeed" on the wrong route and
  mask the intended assertion. Three discovery tests in this lab exist
  specifically to prove this distinction.
- **`block_in_place` and single-threaded runtimes.** Qualification's
  `LiveQualificationTransport` uses `tokio::task::block_in_place`, which
  panics outside a multi-threaded ambient runtime. `#[tokio::test]`'s
  default is single-threaded. `gateway_wire_qualification.rs` uses plain
  `#[test]` functions with a manually constructed `tokio::runtime::Runtime`
  (multi-threaded by default) instead — the same pattern already
  established in `crates/cd-core/src/rerank.rs`'s
  `rerank_blocking_times_out_to_none` test.
