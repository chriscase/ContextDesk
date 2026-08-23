# Investigation Team known-answer provider boundary V1

Status: provider-neutral adapter plus trusted desktop-host execution and
durable redacted reporting for the checked-in OPEN quality suite. The host can
now resolve configured Investigation Team roles, contact each exact provider,
score responses, preserve lifecycle/latency/byte evidence, and surface history
in Settings. It does **not** recommend a universal best model.

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

Two independent digests are needed:

1. `LoadedSuite::digest` binds the complete checked-in runtime **and host-only
   truth** used for scoring.
2. `live_known_answer_prompt_set_hash` binds the exact ordered bytes visible to
   the provider.

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
4. stores no raw prompt, provider response, endpoint, credential, or evaluator
   truth;
5. retains deterministic failed-dimension ids plus host-observed latency and
   input/output byte counts; and
6. leaves token counts and cost explicitly unknown because the current
   qualification transport does not return usage accounting.

The durable file is
`investigation-team-known-answer-qualifications.json` in the ContextDesk config
directory. It is fail-closed, atomically replaced, bounded to 128 records and 8
MiB, and reparses each report through canonical validation. Renderer IPC has no
publish command.

## Readiness UI interpretation

Settings → Investigation Team now keeps three different claims visibly
separate:

- **Local contract check:** provider-free host wiring/redaction evidence.
- **Measured provider check:** one small request per role proving the configured
  transport and response envelope.
- **Known-answer quality evidence:** the OPEN-v1 scenario run for an exact
  build/profile/model/endpoint/suite/prompt identity.

A historical quality report becomes `stale` when the running app build, suite,
prompt set, or configured role/deployment no longer matches. The underlying
reported result remains visible. Scenario failures, cancellations, blocked
rows, deterministic failed dimensions, redacted JSON, and redacted Markdown are
inspectable rather than collapsed into a green badge.

The four diagnostic-focused OPEN-v1 scenarios still require honest host-owned
attempt/tool/role telemetry. The current serial answer runner supplies no
invented diagnostic envelope; those dimensions therefore fail closed when the
executed path does not produce the required telemetry. A clean 14/14 result is
not claimed merely because model prose was returned.

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
- diagnostic truth succeeds only when joined from the host-owned envelope.

## Non-claims and remaining work

This path does not claim semantic entailment: lexical overlap is a bounded
structural signal, not proof that prose follows from a citation. It also does
not yet capture provider token/cost usage, execute the four diagnostic scenarios
through a full attempt/tool/role pipeline, derive measured recommendations, or
prove a packaged configured-provider acceptance run. Those remain follow-up
work for issue #726.

## Verification

All Rust commands must use the repository's shared cache policy. With the
appropriate `RUSTC_WRAPPER`, `SCCACHE_DIR`, and compatibility-keyed
`CARGO_TARGET_DIR` set:

```bash
cargo test -p cd-core --test quality_eval_live_known_answer
cargo test -p cd-core --test quality_eval_live_known_answer_run
cargo test -p cd-core --test quality_eval_lab
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib investigation_team_known_answer_host
cargo clippy -p cd-core --all-targets -- -D warnings
cargo fmt --all -- --check
git diff --check
```
