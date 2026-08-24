# Investigation Team known-answer provider boundary V1

Status: provider-neutral adapter plus trusted desktop-host execution and
durable redacted reporting for the checked-in OPEN quality suite. The host can
now resolve configured Investigation Team roles, contact each exact provider,
score responses, preserve lifecycle/latency/byte/provider-usage evidence, and
surface history in Settings. An operator-triggered run can also retain strict
canonical responses for private regression analysis. It does **not** recommend
a universal best model.

## Why this boundary exists

The Investigation Team readiness flow already has a small measured wiring
probe. That probe proves that an exact profile/model/deployment can answer a
strict opaque request; it does not prove that the model can perform bounded
triage well. This adapter supplies the next evidence layer: the same 14
checked-in known-answer scenarios used by the deterministic quality harness can
be sent to a configured provider without exposing evaluator truth.

The provider must solve the evidence packet. It cannot learn the expected
answer from fixture names, candidate labels, scoring tokens, or diagnostic
telemetry.

## Authority split

| Provider-visible | Trusted host only |
| --- | --- |
| Opaque `scenario-001`…`scenario-014` id | Fixture case and directory id |
| One neutral question | Task and packet identity |
| Frozen `fixed` evidence rows | Scripted candidates and expectations |
| Opaque evidence/source/time tuple | Answer truth and evaluator-only tokens |
| Closed response schema and vocabulary | Diagnostic attempts, tools, roles, and outcomes |

`PreparedLiveKnownAnswerCase` intentionally does not implement `Serialize`.
Only `serialize_live_known_answer_prompt` produces provider bytes. Every visible
string is checked for credential/path shapes and evaluator-truth tokens before
serialization.

## Exact execution identity

Two independent digests and one host-minted run identity are needed:

1. `LoadedSuite::digest` binds the complete checked-in runtime **and host-only
   truth** used for scoring.
2. `live_known_answer_prompt_set_hash` binds the exact ordered bytes visible to
   the provider.
3. `LiveKnownAnswerRunId` identifies one host execution independently of its
   timestamp, role, or model. It is an opaque correlation key, not a signature,
   authorization token, semantic digest, or proof of authenticity.

A trusted runner must put both values into the run's `QualityUnit`, along with
the exact build, profile, endpoint fingerprint, model id, task mode, response
schema version, sampling configuration, and orchestration-policy fingerprint.
The prompt hash is not a substitute for the suite digest, and neither is a
provider-readiness badge.

## Provider contract

Each prompt uses schema
`contextdesk.quality_eval.live_known_answer_prompt.v1`. The response must be one
JSON object using
`contextdesk.quality_eval.live_known_answer_response.v1` and the matching opaque
scenario id.

Each claim carries:

- non-authoritative prose;
- zero or one closed-vocabulary causal role; and
- one or more exact `(evidence_id, source_id, time_anchor)` citations.

Allowed roles are `trigger`, `symptom`, `recovery`, `independent`,
`observation`, and `other`. Confidence is `high`, `medium`, or `low`. Unknown
fields and vocabulary, crossed scenario ids, credential/path-shaped values,
oversized JSON, and oversized claim structures fail before scoring.

After parsing, `score_live_known_answer_response` drives the shipped
deterministic `score_answer` implementation and adds three live-boundary
dimensions:

- every claim has citation fields;
- every citation matches one exact frozen evidence/source/time tuple; and
- citation tuples are unique within a claim.

`LaneStatus::Executed` means a structurally valid response reached the scorer.
It does **not** mean the answer passed. Parser/transport failures are host
execution failures, while `AnswerScore::passed` is the deterministic quality
verdict.

## Diagnostic scenarios

Some checked-in scenarios score attempts, tools, role withdrawal, or budget
behavior. A model response cannot self-certify those facts. Provider JSON has
no diagnostic field and rejects an injected one. The trusted host must record
the attempt telemetry and pass a separate `ScriptedDiagnostic` to the scorer.
A diagnostic scenario without those host-owned observations fails closed.

## Trusted-host sequence

```text
load and validate checked-in suite
        │
        ├── retain suite digest + host-only truth
        ▼
prepare_live_known_answer_suite
        │
        ├── compute provider-visible prompt-set hash
        ▼
serialize one opaque prompt → configured provider
        │
        ├── host records status, timing, usage, and diagnostic facts
        ▼
parse_live_known_answer_response
        │
        ▼
score_live_known_answer_response + host diagnostic
        │
        ▼
qualification report with exact QualityUnit identity
```

The desktop host preserves cancelled, failed, and partial attempts rather than
silently dropping them. It never copies fixture truth into a prompt, uses a
model name as evidence of quality, or promotes a score into a universal “best
model” recommendation.

## Packaged desktop execution

`load_embedded_open_v1_suite` compiles the exact committed OPEN-v1 suite bytes
into trusted Rust code. It uses the same parser, fixture validation, and digest
framing as the filesystem loader. The suite is intentionally **not** added to
Tauri's browseable resource map, so evaluator truth is not exposed as an
installed JSON directory or renderer IPC payload.

For every configured V1 role, the trusted host:

1. resolves credentials, exact profile/model/deployment, remote-egress policy,
   and backend dialect using the existing qualification host path;
2. records the current app build identity, suite digest, provider-visible
   prompt-set hash, endpoint fingerprint, and orchestration-policy digest;
3. sends scenarios serially with prompted-JSON mode and cooperative
   cancellation;
4. records the configured model in the quality unit and the provider-reported
   model separately on each attempted scenario; a mismatch stays visible and
   never rewrites configuration;
5. retains deterministic failed-dimension ids plus host-observed latency and
   synthetic message-content and returned provider-content byte counts;
6. carries prompt, completion, reasoning, and cached token counts plus gateway
   cost only when the provider reports them; missing values remain `null`, and
   aggregate values remain unknown if any attempted scenario omits that metric;
7. validates model identities with a separate bounded grammar that preserves
   legitimate namespaced IDs, while response prose and all provider-controlled
   identifiers reject rather than rewrite prompt echoes, secrets, credentials,
   absolute paths, endpoint/address/route forms, headers, evaluator markers,
   rejected response text, and raw transport errors; and
8. retains only strict parsed canonical responses in the private, owner-only
   capture portion of the bounded store. A capture is not a share-safe artifact
   and is never projected into renderer exports.

The durable file is
`investigation-team-known-answer-qualifications.json` in the ContextDesk config
directory. Store schema V3 reads and migrates only valid legacy V1 report-only
and V2 report/capture stores. Migration never invents a run id for legacy
evidence, discards a capture, or relaxes validation. Every newly published V2
report/capture pair carries one exact host-minted run id. Identical retries for
that id are idempotent; changed evidence, a missing capture, or a mismatched
report/capture id fails closed instead of overwriting history. Distinct runs
recorded during the same second remain separate. A malformed,
unsafe-permissioned, or otherwise invalid existing file places this feature in
an explicit unavailable state. Listing, clearing, and running retry one secure
load under the host mutex, so repair or deliberate removal can recover
in-process without substituting an empty store for malformed bytes. A run does
not resolve or call a provider until that reload succeeds. On Unix, every
ancestor is opened no-follow and the retained final parent must be owned by the
effective user with no group/other mode bits. Store, lock, and temporary files
must have that same UID and owner-only mode. Reads, lock acquisition, temporary
creation, replacement, cleanup, and directory fsync are all relative to the
retained parent descriptor; its configured pathname identity is revalidated
before replacement. Size, exact EOF, and stable file-handle metadata are checked
on the same descriptor. A SHA-256 revision of the fully validated durable
mapping is compared immediately before replacement while a per-store writer
lock is held, so malformed, stale, or concurrently changed evidence cannot be
overwritten. The owner-only lock sidecar uses an OS file lock: the sidecar may
persist across restart, but a crash releases its lock rather than leaving the
feature falsely busy. Writes use a unique owner-only temporary file, validate
its bytes and directory-relative entry identity against the same open handle,
fsync the file, and atomically replace the destination. Unix hosts then fsync
the retained directory. If that post-commit directory sync fails, the save
remains a committed success, live state is published to match disk, and a
bounded durability warning is logged instead of reporting a false failure. On
non-Unix hosts the entire persisted known-answer feature fails closed before
provider resolution or calls until equivalent no-follow identity, owner-only
capture retention, and atomic replace support exists. Clearing
history removes both redacted reports and their private captures. The store
remains bounded to 128 reports and 8 MiB and reparses each report and capture
through canonical validation. Renderer IPC has no publish
command.

### Canonical response evidence

`contextdesk.investigation_team_known_answer_capture.v2` is intentionally
separate from the redacted score report. It contains the same host-minted run
id as its V2 report, the exact `QualityUnit`, role/timestamp, and an ordered list
of only those responses that passed the
strict JSON parser plus privacy and closed-vocabulary gates. Each response is
stored as the typed canonical object with a SHA-256 digest of compact canonical
JSON. Every executed response also carries a SHA-256 digest of its exact
canonical redacted `AnswerScore`; only parsed responses carrying the closed
`host_score_failed` eligibility marker may omit that score digest. The matching
score report records a SHA-256 digest of the **complete capture**, including
those per-response score bindings. Store validation requires exact timestamp,
role, full `QualityUnit`, scenario set/order, provider-reported model, closed
status-to-failure-code mapping, dispatch-byte/provider-telemetry eligibility,
host-minted run id, and executed-score correspondence before accepting the
pair. Cancelled, blocked, not-scheduled, and contradictory rows cannot retain a
canonical response. Therefore changing a response and merely
recomputing its inline hash, or changing a report score while preserving its
captured response, fails closed. These digests prove internal content
consistency, not origin or authenticity: they are not signatures, and an
attacker able to rewrite the report, capture, and every digest is outside this
local integrity claim. This makes behavioral fixture derivation possible
without snapshotting provider prose blindly.

Legacy V1 reports and captures remain readable without a synthesized run id and
are labeled `legacy_unidentified` in the renderer. Newly produced evidence is
labeled `host_minted`. New legacy-shaped evidence cannot be published.

The capture schema has no field for prompts, URLs, headers, credentials,
evaluator truth, raw errors, or rejected provider text. Shared secret scrubbing,
absolute/UNC-path detection, endpoint-scheme and bare host-port detection,
secret-assignment detection, prompt-fragment matching across conclusions,
claims, and every citation field, and evaluator-marker checks are all
reject-only: no accepted response is silently rewritten into something that
looks safe. Configured and provider-reported model identities use a separate
bounded grammar that rejects addresses, host-port values, routes, and internal
DNS shapes while retaining legitimate slash-delimited model ids. A rejected
response is represented only in the redacted report by one
bounded category and its byte count:

- `provider_response_parse_failed`;
- `provider_response_privacy_rejected`;
- `provider_response_vocabulary_rejected`; or
- `host_score_failed` after a strict response parsed but the host scorer could
  not complete.

Capture is not a background recorder. It is produced only as part of the
operator-triggered known-answer action. Before promoting any captured response
into a checked-in regression fixture, review it and assert behavioral invariants
rather than exact prose.

## Readiness UI interpretation

Settings → Investigation Team now keeps three different claims visibly
separate:

- **Local contract check:** provider-free host wiring/redaction evidence.
- **Measured provider check:** one small request per role proving the configured
  transport and response envelope.
- **Known-answer quality evidence:** the OPEN-v1 scenario run for an exact
  build/profile/model/endpoint/suite/prompt identity.

Model ids are opaque provider catalog identities, including namespaced values
such as `alibaba/qwen3.6-27b`, `openai/gpt-oss-120b`, and
`mistral/ministral-14b`; they are never rewritten into display aliases. The
configured id and provider-reported id remain separate. Capability evidence is
also separate from quality evidence: a measured limitation such as
`structured_output` remains visible in the exact capability-qualification
report and is not converted into either a known-answer pass or a generic model
failure.

A historical quality report becomes `stale` when the running app build, suite,
prompt set, or configured role/deployment no longer matches. The underlying
reported result remains visible. Scenario failures, cancellations, blocked
rows, deterministic failed dimensions, redacted JSON, and redacted Markdown are
inspectable rather than collapsed into a green badge.

The four diagnostic-focused OPEN-v1 scenarios still require honest host-owned
attempt/tool/role telemetry. The serial answer runner no longer treats them as
an undifferentiated diagnostic block. Production `QualificationTransport` is
exclusive: `Ok` has a body and `raw_error = None`; `Err` is mapped to empty
content plus a reason. The host therefore executes qe09 only when mixed attempts
are observed as a real two-call sequence (failed first chat, then a parsed
follow-up). Timeout/auth/transport classifiers exist and never emit
`host_grounding`, and those `Err` outcomes still have no parsed body to score —
a single bodyless attempt (or, since qe10 never allows a follow-up, the only
attempt it ever dispatches) stays an honest `provider_request_failed` outcome,
never invented into a dual-state (`Ok` body + `raw_error`) the production
transport never returns. What changed: qe10 now dispatches one real attempt. A
genuinely fluent, well-formed response that asserts **zero claims** is a
host-observed grounding refusal (`response.claims.is_empty()` — never a
provider-declared field, the schema has none): the host records that attempt's
row as `failure_class = "host_grounding"` / `succeeded = false` — a transport
success that produced nothing evaluable, not a "successful evaluable analysis"
— and joins `host_grounding_refusal`, which qe10 allows. This is only ever
claimed when the whole observed lineage has no earlier unsucceeded
transport/auth/timeout attempt; the scorer's `transport_versus_grounding`
dimension would otherwise flag it as a transport failure mislabeled as
grounding, and qe10's fixed `all_failed` usefulness policy requires every
attempt row to honestly report non-success. A fluent response *with* real
claims (each contractually cited) emits `compatible_success`, which qe10 does
not allow either — so a fluent response without host-observed grounding refusal
is never joined into a scored envelope, and neither is a fluent response that
is genuinely grounded (qe10 has no "successful grounded" category at all; both
cases stay an honest `host_score_failed` gap, never a `diagnostic_category`
model failure). qe11/qe12 stay blocked.

| Scenario | Host seam | Decision |
| --- | --- | --- |
| `qe09-attempt-usefulness` | chat `Err` then one follow-up `Ok` (production exclusive states) | **Execute** when mixed attempts are observed and joined; fluent-only `compatible_success` is not joined |
| `qe10-grounding-vs-transport` | one real attempt; host-observed zero-claims refusal (`failure_class = "host_grounding"`) vs. bodyless `Err` classification | **Execute** on a single clean parsed attempt asserting zero claims (`host_grounding_refusal`); **Failed** `host_score_failed` on a genuinely grounded fluent answer or any lineage tainted by an earlier transport/auth/timeout attempt; **Failed** `provider_request_failed` (never Executed) when every attempt stays bodyless |
| `qe11-tool-progress` | host-executed tool loop (not provider `tool_calls`) | **Blocked** `host_diagnostic_pipeline_unavailable`, zero dispatch bytes |
| `qe12-multimodel-budget` | investigator/reviewer/synthesizer budget pipeline | **Blocked** `host_diagnostic_pipeline_unavailable`, zero dispatch bytes |

Unsupported host capabilities stay blocked and are never blamed on the model.
A fluent parsed answer cannot drop host-recorded failed/partial diagnostic rows.
A clean 14/14 result is not claimed.

### Why qe11/qe12 stay blocked, and what would unblock them

Both were re-audited against the shipped production seams outside this
scenario's write scope, not just re-asserted as blocked:

- **qe11 (host-executed tool loop).** A real host-executed tool loop already
  exists in production — `cd_core::tool_host::ToolHost::execute` /
  `resolve_execute_name`, driven by the round loop in `cd_core::agent`. It is
  not reachable from this runner: `LiveQualificationTransport::chat_complete`
  (`crates/cd-workflow/src/capability_qualification.rs`) rejects any tool
  definition that is not the single inert probe tool
  (`non_inert_probe_tool_rejected`) before a request ever reaches the
  provider. Unblocking qe11 honestly needs a bounded, host-validated tool
  contract accepted by that transport
  (`crates/cd-workflow/src/capability_qualification.rs` and
  `crates/cd-core/src/capability_qualification.rs`) plus a bridge from the
  known-answer dispatch path into `cd_core::tool_host::ToolHost` — none of
  which are in this change's write allowlist. It stays honestly blocked rather
  than faking a tool loop against the existing inert-probe-only transport.
- **qe12 (investigator/reviewer/synthesizer budget pipeline).** A real
  reviewer-first multi-model pipeline already exists in production
  (`cd_core::multi_model`: `MultiModelBudget`, `StageTelemetry`,
  `run_review_pipeline`), wired into the live agent turn loop. It has no
  three-role, live-qualification-compatible mode today (`MultiModelMode` is
  `Single` / `Review` / `Contributions`; `Review` resolves at most an
  Investigator and a Reviewer target, and `Contributions` explicitly fails
  closed for qualification). This known-answer runner also has no per-stage or
  total budget ceiling at all: `ScriptedDiagnostic.host_budget_exhausted` is a
  report-only honesty flag, never computed by a real budget check. Unblocking
  qe12 honestly needs a three-role live-qualification mode and a real budget
  ceiling in `crates/cd-core/src/multi_model/mod.rs` (or a sibling) — outside
  this change's write allowlist. It stays honestly blocked rather than
  dispatching a synthesizer role with invented budget accounting.

## Security and mutation coverage

The focused suite proves:

- all 14 scenarios are prepared in manifest order with opaque ids;
- provider bytes omit case, task, packet, candidate, expectation, truth, and
  fixture-path identities;
- prompt hashing is deterministic;
- an expected-good causal answer passes while symptom-as-cause fails;
- wrong source/time tuples, fabricated evidence, duplicate citations, and
  uncited claims fail;
- crossed scenario ids and unknown fields/vocabulary fail;
- escaped credential-shaped response values fail after JSON decoding; and
- diagnostic truth succeeds only when joined from a host-built envelope (not fixture candidate diagnostics);
- timeout/auth/transport is not classified as host-grounding;
- zero-cite tool progress and non-progress without withdrawal fail;
- silent role dropout and budget-exhausted+useful fail;
- qe09 dispatches and joins mixed-attempt host envelopes on a real `Err` then
  `Ok` sequence; fluent `compatible_success` is not joined;
- qe10 dispatches one real attempt and joins a host-observed zero-claims
  grounding refusal (`failure_class = "host_grounding"`, never reusing the raw
  transport-success classification); a genuinely grounded fluent answer, and a
  zero-claims refusal preceded anywhere in the lineage by a real transport/
  auth/timeout attempt, both stay an honest `host_score_failed` gap instead of
  a joined pass; an all-bodyless attempt sequence never reaches `Executed`;
  qe11–qe12 stay pre-dispatch blocked;
- configured and provider-reported model ids remain distinct and mismatches
  stay visible;
- complete provider usage aggregates exactly while one missing value keeps the
  aggregate unknown;
- every telemetry value and checked aggregate fits JavaScript's exact integer
  range, with invalid/overflowing provider values rejected instead of wrapped;
- malformed existing stores block read, clear, run, and save instead of being
  replaced by an empty history;
- pre-replacement SHA-256 CAS rejects a store that becomes malformed or changes
  after startup, while a post-rename directory-sync failure remains committed
  success with a bounded durability warning;
- unsupported hosts reject load, save, and execution before provider dispatch;
  and
- canonical response captures are deterministic, report-bound, owner-only,
  bind each executed response to its exact score, reject
  secret/path/endpoint/prompt/truth material, and never retain rejected raw
  text; and
- path-swap, symlink, exact-EOF, same-handle temporary validation, and
  platform-specific persistence behavior fail closed within the documented
  storage boundary.

## Non-claims and remaining work

This path does not claim semantic entailment: lexical overlap is a bounded
structural signal, not proof that prose follows from a citation. Provider usage
is present only when reported by the gateway; it is not independently audited
against billing. Cost is rounded to the nearest micro-US-dollar for the durable
integer report, and all exported integers stay within the exact JavaScript
range. Canonical captures are private local regression evidence, not share-safe
exports or cryptographically authenticated attestations. This path still does
not execute qe11 tool-progress or qe12 three-role budget scenarios through a
host tool loop / multi-stage budget pipeline (see "Why qe11/qe12 stay blocked"
above for the exact seams and files that would be needed), derive measured
recommendations, or prove a packaged configured-provider acceptance run. qe09
executes only when the host actually observed mixed attempts; a fluent 1-shot
answer is not treated as a diagnostic pass. qe10 executes only on a single
clean parsed attempt honestly asserting zero claims; it does not claim semantic
grounding verification beyond "the model asserted at least one claim" — a
claim that parses with a citation but whose citation is wrong or fabricated is
caught by the separate `live_exact_source_time_citations` dimension, not by
`transport_versus_grounding`. Those remaining gaps are follow-up work for issue
#726. It does not manufacture a green 14/14.

## Verification

All Rust commands must use the repository's shared cache policy. With the
appropriate `RUSTC_WRAPPER`, `SCCACHE_DIR`, and compatibility-keyed
`CARGO_TARGET_DIR` set:

```bash
cargo test -p cd-core --test quality_eval_live_known_answer
cargo test -p cd-core --test quality_eval_live_known_answer_run
cargo test -p cd-core --test quality_eval_live_known_answer_capture
cargo test -p cd-workflow --test gateway_wire_qualification live_transport_exposes_authoritative_model_usage_and_cost_once
cargo test -p cd-core --test quality_eval_lab
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib investigation_team_known_answer_host
cargo clippy -p cd-core --all-targets -- -D warnings
cargo fmt --all -- --check
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check
git diff --check
```
